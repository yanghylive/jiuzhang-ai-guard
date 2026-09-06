'use strict';
// 本地 API 路由（04）。只绑定 loopback（daemon 负责）。
// 安全改造（回应审查）：
//   P1-6 → 每个请求必须通过 auth.authorize（secret + Host/Origin + 高风险 confirmToken）
//   P1-7 → 请求体统一字节上限，超限直接 413 拒绝，不落盘不解析
//   P1-5 → 清理走回收站语义，新增 quarantine 列表 / restore / purge
//   P0-2/P1-3 → 更新链路只暴露"校验后可安装"判定，缺签名/缺 hash 一律拒绝
const { URL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { envelope, uuid, dataRoot, ensureDataRoot, readJSON, atomicWriteJSON, workbuddyDir, IDEMPOTENCY_KEY_RE } = require('./lib');
const { runHealthCheck } = require('./health-check');
const { ACTIONS, planFor, runAction } = require('./repair-actions');
const {
  createBackup,
  listBackups,
  previewRestore,
  restoreBackup,
  exportBackup,
  importBackup,
  normalizeScope,
  manifestSha256,
  resolveImportFile,
  readExportForDownload,
  listExports,
  stagingDir,
  sweepStaging,
  stagingQuotaBytes,
  IMPORT_MAX_BYTES,
} = require('./backup-vault');
const { scan, apply, restore: cleanupRestore, purge: cleanupPurge, listQuarantine } = require('./cleanup');
const { withLock } = require('./op-lock');
const { checkCompatibility } = require('./compatibility');
const { getStatus, refresh, httpsJson, getPlans, loadEntitlementCache } = require('./kaypal-license');
const { preview: diagPreview, upload: diagUpload } = require('./diagnostics');
const { scan: privacyScan } = require('./privacy');
const { loadSettings, saveSettings } = require('./storage');
const { renderAdminUI } = require('./admin-ui');
const { ensureToken, authorize, ConfirmStore, riskOf, SessionStore, parseSessionCookie, sessionCookieHeader, SESSION_CLEAR_HEADER, GUEST_TTL_MS, originAllowed } = require('./auth');
const { reportError } = require('./error-report');
const { qrSvg } = require('./qrcode');
const { passwordLogin: desktopPasswordLogin, loadDesktopAuth, loadDesktopAuthReadOnly, revokeDevice, deviceFlowStart, deviceFlowPoll } = require('./desktop-auth');
const wechatLocal = require('./wechat-local');
const { redeemOnKaypal, listFromKaypal, getShareLink, claimShare, getInviteCount } = require('./kaypal-coupon');
const kaypalPay = require('./kaypal-pay');
const { getTrialState, isUnlocked } = require('./trial');
const { createHandoff, previewHandoff, applyHandoff, listHandoffFiles } = require('./handoff');
const { addMemory, listMemories, getMemory, searchMemories, recallForWork, updateMemoryStatus } = require('./memory-store');
const { addAsset, listAssets, getAsset, searchAssets, recallAssets, updateAssetStatus, updateAssetVersion, rollbackAsset, KIND_WHITELIST, STATUS_WHITELIST } = require('./asset-store');
const { scoreSkill, decide, findOverlap } = require('./skill-policy');
const { mineFlows, confirmFlow } = require('./asset-extractor');
const { recordUsage, summarizeUsage, staleAssets } = require('./usage-store');
const { recommendModels } = require('./model-fit');
const { watchdogStatus, alertScan, setAutoBackupPaused, requestRestart } = require('./watchdog');
const { beginOperation, getOperation, completeOperation, failOperation, cancelOperation, listOperations, sweepOperations } = require('./operation-store');
const { cleanupStaleRuntime, repairDirPermission, restoreLatest, rollbackComponent } = require('./repair-local');
const { getRestoreProgress } = require('./restore-progress');
const oidc = require('./oidc');

// 请求体上限（P1-7）：默认 256KB，env 可调；超限即断连，防磁盘/内存耗尽。
const MAX_BODY_BYTES = Number(process.env.JZ_MAX_BODY_BYTES || 256 * 1024);

// 试用 gate 豁免清单（2026-09-04 产品负责人决策：免费版试用，过期未付费全锁；2026-09-05 起试用 7 天）。
// 豁免 = 登录/开通会员/订阅状态/邀请/基础设施链路，其余管家功能端点一律 gate。
const TRIAL_EXEMPT_PREFIXES = [
  '/api/admin/session',
  '/api/auth/confirm',
  '/api/desktop-auth/',
  '/api/wechat-local/',       // 本机微信一键登录（登录前置链路，与 desktop-auth 同豁免）
  '/api/license/status',
  '/api/license/plans',
  '/api/license/trial',        // 试算 + trial-status（前缀命中两者）
  '/api/license/purchase',
  '/api/license/pay/query',
  '/api/license/order/status',
  '/api/license/refresh',
  '/api/license/coupon/',      // share/claim/invite-count/kaypal/*
  '/api/qrcode',
  '/api/oidc/',
  '/api/settings/ui-state',
];
function isTrialExempt(p) {
  return TRIAL_EXEMPT_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
}

function send(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(html);
}

// 超限后停止缓冲（不再占内存），但保持连接读到 end，以便能把 413 正常回给客户端；
// 超过硬上限（8×）则直接断连，防恶意灌流。
// 2026-08-29 复核 P1：增加 idle timeout（默认 30s 无数据视为慢连接攻击，直接 408 断连）。
const BODY_IDLE_TIMEOUT_MS = Number(process.env.JZ_BODY_IDLE_TIMEOUT_MS) || 30 * 1000;
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    let chunks = [];
    let tooLarge = false;
    let done = false;
    let idleTimer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      resolve(v);
    };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { req.destroy(); } catch {}
        finish({ __idleTimeout: true });
      }, BODY_IDLE_TIMEOUT_MS);
      if (idleTimer.unref) idleTimer.unref(); // 不阻塞进程退出
    };
    resetIdle();
    req.on('data', (c) => {
      resetIdle();
      size += c.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks = [];
        if (size > maxBytes * 8) {
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
          return finish({ __tooLarge: true });
        }
        return;
      }
      chunks.push(c);
    });
    req.on('aborted', () => finish({ __tooLarge: tooLarge }));
    req.on('error', () => finish({ __tooLarge: tooLarge }));
    req.on('end', () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (tooLarge) return finish({ __tooLarge: true });
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        finish(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        finish({ __badJson: true });
      }
    });
  });
}

function createRouter({ root, token: providedToken, hooks = {}, allowedOrigin, tokenCheck, corsAllowed, kaypalHttp } = {}) {
  // 测试性依赖注入：kaypalHttp 可替换 httpsJson（与 desktop-auth 的 _httpsJson 注入惯例一致）。
  // 缺省用真实实现，生产行为不变。仅 order/status 查单转发消费此注入点。
  const kHttp = typeof kaypalHttp === 'function' ? kaypalHttp : httpsJson;
  const dataDir = ensureDataRoot(root || dataRoot());
  // 二开并入：由宿主（WorkDaddy daemon）传入统一 API_TOKEN，避免同一进程两套 secret。
  // 独立使用时（无外部 token）仍自生成 0600 secret。
  const token = providedToken || ensureToken(dataDir);
  const confirmStore = new ConfirmStore();
  // 宿主策略注入：daemon 传入官方来源白名单（WorkBuddy renderer 页面 Origin）与
  // 额外有效 token 集合（注入面板短时会话 token）；独立使用时保持 loopback + 单 secret。
  const authOriginFn = typeof allowedOrigin === 'function' ? allowedOrigin : undefined;
  const authTokenFn = typeof tokenCheck === 'function' ? tokenCheck : undefined;
  // CORS：实际响应的 Access-Control-Allow-Origin 判定（daemon 预检已前移；独立模式在此兜底）。
  // 缺省仅 loopback Origin 允许 CORS。
  const corsOK = typeof corsAllowed === 'function' ? corsAllowed : (o) => originAllowed(o);
  // 管理页会话（P0 修复）：/jz 页面通过 HttpOnly 会话 Cookie 访问 API，不再注入长期 API_TOKEN
  const sessionStore = new SessionStore();
  // 恢复预览登记（指导 §7）：previewId → { backupId, scope, manifestSha256, expiresAt }；
  // 恢复必须持未过期、未使用的 previewId，且备份/作用域/manifest hash 与预览时一致。
  const previewStore = new Map();
  const PREVIEW_TTL_MS = 10 * 60 * 1000;
  // 幂等存储（复查 P2 第七轮）：内存 Map + 持久化 runtime/idempotency.json ——
  // daemon 重启后同键重放仍命中，满足 04 §"进程退出测试"。
  const idemPersistPath = path.join(dataDir, 'runtime', 'idempotency.json');
  const idemPersist = readJSON(idemPersistPath) || { records: [] };
  const idempotency = new Map((idemPersist.records || []).map((r) => [r.key, r.value]));
  const idemSet = (key, value) => {
    idempotency.set(key, value);
    try {
      const records = [...idempotency.entries()].slice(-500).map(([k, v]) => ({ key: k, value: v }));
      atomicWriteJSON(idemPersistPath, { records });
    } catch (e) {
      // 复查 P2（第五轮）+ P2（第六轮）：持久化失败不静默 —— reportError 是同步函数
      //（返回对象而非 Promise），不能 .catch()；必须带 requestId（否则限流层直接跳过）。
      console.error(`[jz-api] 幂等记录持久化失败（重启后该键将不可重放）: ${e.message}`);
      try {
        reportError({ requestId: 'idempotency-persist-' + uuid(), url: String(key).slice(0, 60), status: 500, message: `idempotency persist failed: ${e.message}` });
      } catch (reportErr) {
        console.error(`[jz-api] 幂等持久化错误上报失败: ${reportErr && reportErr.message}`);
      }
    }
  };
  // 购买并发锁（复查 P1）：按 user+plan+支付方式 在途去重 —— 客户端快速双击生成不同
  // 幂等键也能拦住，绝不允许同一时刻两个订阅请求进 kaypal。
  const purchaseInFlight = new Set();
  // staging 配额预留（复查 P2 第四轮）：并发上传各自登记字节数，防合计超配额
  const stagingReserved = new Map(); // uploadName → bytes
  const oidcStates = new Map(); // state → { verifier, expiresAt }（OIDC 登录回调关联）

  // 导入上传（指导 §5）：raw 二进制流式落 staging/，大小超限即断连。
  // 必须在 readBody（JSON 缓冲）之前分流处理。
  function handleImportUpload(req, res, requestId) {
    const auth0 = authorize({ req, url: new URL(req.url, 'http://127.0.0.1'), token, body: {}, confirmStore, sessionStore, originAllowedFn: authOriginFn, tokenCheckFn: authTokenFn });
    if (!auth0.ok) return send(res, auth0.status, envelope(false, { reason: auth0.reason }, auth0.error, requestId));
    // staging 治理（复查 P2）：惰性清理过期文件 + 总配额校验（含并发预留），防磁盘被废弃上传占满。
    // 复查 P2（第五轮）：预检必须计入"本次即将预留的 IMPORT_MAX_BYTES"，否则并发上传可合计超配额。
    const sweep = sweepStaging(dataDir);
    let reservedTotal = 0;
    for (const v of stagingReserved.values()) reservedTotal += v;
    if (sweep.total + reservedTotal + IMPORT_MAX_BYTES > stagingQuotaBytes()) {
      return send(res, 507, envelope(false, { reason: `staging 已占用 ${sweep.total + reservedTotal} 字节 + 本次预留 ${IMPORT_MAX_BYTES} 字节将超过配额 ${stagingQuotaBytes()}，请稍后重试` }, 'STAGING_QUOTA_EXCEEDED', requestId));
    }
    const uploadName = `upload-${uuid()}.jzvault`;
    // 预留名额（实际上限由流式计数收紧），并发上传互不超卖
    stagingReserved.set(uploadName, IMPORT_MAX_BYTES);
    const releaseReserved = () => stagingReserved.delete(uploadName);
    const dir = stagingDir(dataDir);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      releaseReserved();
      return send(res, 500, envelope(false, null, 'INTERNAL_REDACTED', requestId));
    }
    const p = path.join(dir, uploadName);
    let size = 0;
    let aborted = false;
    let finished = false;
    // 2026-08-29 复核 P1：上传流 idle timeout（30s 无数据 → 断连清理），防慢连接长期占用
    let idleTimer = null;
    const resetUploadIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        aborted = true;
        ws.destroy();
        cleanup();
        try { req.destroy(); } catch {}
      }, BODY_IDLE_TIMEOUT_MS);
      if (idleTimer.unref) idleTimer.unref();
    };
    const clearUploadIdle = () => { if (idleTimer) clearTimeout(idleTimer); };
    const cleanup = () => {
      releaseReserved();
      clearUploadIdle();
      try { fs.rmSync(p, { force: true }); } catch {}
    };
    const ws = fs.createWriteStream(p, { flags: 'w', mode: 0o600 });
    resetUploadIdle();
    req.on('data', (c) => {
      resetUploadIdle();
      size += c.length;
      // 复查 P2（第五轮）：流式检查计入其他上传的预留（本上传的预留不计入自身占用）
      let otherReserved = 0;
      for (const [name, v] of stagingReserved) { if (name !== uploadName) otherReserved += v; }
      if (size > IMPORT_MAX_BYTES || size + sweep.total + otherReserved > stagingQuotaBytes()) {
        aborted = true;
        ws.destroy();
        cleanup();
        // 先尽力回结构化 413 再断连（复查 P2：直接 destroy 客户端只能看到网络错误）
        try {
          send(res, 413, envelope(false, { reason: '上传超过单文件/总配额限制' }, 'IMPORT_TOO_LARGE', requestId));
        } catch {}
        setTimeout(() => { try { req.destroy(); } catch {} }, 100);
        return;
      }
      if (!ws.write(c)) req.pause();
    });
    ws.on('drain', () => {
      try { req.resume(); } catch {}
    });
    req.on('end', () => {
      clearUploadIdle();
      if (aborted) return;
      finished = true;
      ws.end(() => {
        if (aborted) return;
        if (size === 0) {
          cleanup();
          return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
        }
        // 2026-08-30 第五轮复核 P1：上传成功也必须释放内存配额预留——staging 文件
        // 已落盘计入实际占用，预留不删会随成功上传次数累积，最终永久耗尽配额。
        releaseReserved();
        return send(res, 200, envelope(true, { uploadId: uploadName, size }, null, requestId));
      });
    });
    // 客户端中断/异常连接：清掉半截 staging 文件（复查 P2）
    req.on('aborted', () => { if (!finished) { aborted = true; ws.destroy(); cleanup(); } });
    req.on('error', () => {
      ws.destroy();
      cleanup();
    });
    ws.on('error', () => {
      cleanup();
      if (!aborted) send(res, 500, envelope(false, null, 'INTERNAL_REDACTED', requestId));
    });
  }

  // 安全模式（03 §4 enter-safe-mode）：进入后高风险写操作一律拒绝（只读降级），状态持久化。
  const SAFE_MODE_FILE = path.join(dataDir, 'runtime', 'safe-mode.json');
  let safeMode = false;
  try {
    const sm = readJSON(SAFE_MODE_FILE);
    safeMode = !!(sm && sm.on);
  } catch {}
  function persistSafeMode() {
    atomicWriteJSON(SAFE_MODE_FILE, { on: safeMode, updatedAt: new Date().toISOString() });
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const method = (req.method || 'GET').toUpperCase();
    const requestId = uuid();

    // CORS：官方页面来源的响应带 Access-Control-Allow-Origin（2026-08-29 复查 P1：
    // Inject UI 在真实浏览器中跨源 fetch，无 ACAO 会被引擎拦截，即使 200 也读不到响应体）。
    const originHeader = String(req.headers.origin || '');
    if (originHeader && originHeader !== 'null' && corsOK(originHeader)) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }
    // 独立模式预检兜底（daemon 已在 handleApi 最前统一处理 OPTIONS）
    if (method === 'OPTIONS') {
      if (originHeader && !corsOK(originHeader)) {
        return send(res, 403, envelope(false, null, 'UNAUTHORIZED_LOCAL_REQUEST', requestId));
      }
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Jz-Token, X-Jz-Confirm, Idempotency-Key',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    // 导入上传：raw 二进制流，必须在 JSON readBody 之前分流（大小上限独立控制）
    if (method === 'POST' && p === '/api/vault/import/upload') {
      return handleImportUpload(req, res, requestId);
    }

    // 请求体先读（受上限保护），因为高风险鉴权需要 body.confirmToken。
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      body = await readBody(req);
      if (body.__idleTimeout) {
        return send(res, 408, envelope(false, null, 'INVALID_REQUEST', requestId));
      }
      if (body.__tooLarge) {
        return send(res, 413, envelope(false, null, 'INVALID_REQUEST', requestId));
      }
      if (body.__badJson) {
        return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
      }
      // 04-D5：幂等键支持请求头（Idempotency-Key）与 body 两种写法，请求头优先
      if (!body.idempotencyKey && req.headers['idempotency-key']) {
        body.idempotencyKey = String(req.headers['idempotency-key']);
      }
    }

    const auth = authorize({ req, url: u, token, body, confirmStore, sessionStore, originAllowedFn: authOriginFn, tokenCheckFn: authTokenFn });
    if (!auth.ok) {
      if (method === 'GET' && p === '/') {
        return sendHtml(
          res,
          auth.status,
          '<!doctype html><meta charset="utf-8"><title>JIUZHANG AI 管家</title>' +
            '<body style="font:14px system-ui;background:#0f1115;color:#e8e8ea;padding:32px">' +
            '<h3>需要本地访问令牌</h3><p>请使用 daemon 启动时打印的带令牌链接打开本页面。' +
            '令牌文件位于数据目录 <code>runtime/.daemon-token</code>（权限 0600）。</p></body>',
        );
      }
      return send(res, auth.status, envelope(false, { reason: auth.reason }, auth.error, requestId));
    }

    try {
      // 安全模式：所有写操作一律拒绝（只读降级），仅允许退出安全模式
      if (safeMode && auth.risk !== 'read' && !(method === 'POST' && p === '/api/safe-mode/exit')) {
        return send(res, 403, envelope(false, { reason: 'safe_mode_active' }, 'SAFE_MODE_ACTIVE', requestId));
      }

      // 试用 gate（2026-09-04）：免费版试用，过期未付费 → 功能端点全锁（402）；2026-09-05 起试用 7 天。
      // 判断用本地 entitlement 缓存（不触发网络），付费激活或 24h 内放行。
      if (!isTrialExempt(p) && !isUnlocked(dataDir, loadEntitlementCache(dataDir))) {
        return send(res, 402, envelope(false, { reason: 'trial_expired', trial: getTrialState(dataDir) }, 'TRIAL_EXPIRED', requestId));
      }

      // 复查 P2（第四轮）：可选幂等去重 —— 客户端带幂等键的 POST，同键重放返回首次结果；
      // 未带键则照常执行（04 §写操作幂等的渐进落地，不破坏旧客户端）。
      // 复查 P2（第五轮）：存储参数指纹 —— 同键不同参返回 409 IDEMPOTENCY_CONFLICT，绝不静默返回旧结果。
      const requestFingerprint = () => {
        const clone = Object.assign({}, body);
        delete clone.idempotencyKey;
        delete clone.confirmToken;
        return crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex');
      };
      const optIdem = (scope) => {
        const key = body && body.idempotencyKey ? `${scope}:${String(body.idempotencyKey)}` : null;
        if (key && idempotency.has(key)) {
          const s = idempotency.get(key);
          if (s.fp !== undefined && s.fp !== requestFingerprint()) {
            send(res, 409, envelope(false, { reason: '同幂等键但请求参数不同' }, 'IDEMPOTENCY_CONFLICT', requestId));
            return true;
          }
          send(res, s.status, envelope(s.ok, s.data, s.err, requestId));
          return true;
        }
        return key || null;
      };
      const optIdemSave = (key, status, ok, data, err) => {
        if (key) idemSet(key, { status, ok, data, err, fp: requestFingerprint() });
      };

      if (method === 'GET' && p === '/') {
        // P0 修复：页面不再注入长期 API_TOKEN。下发一次性 guest Cookie（10 分钟、单次使用），
        // 页面用它升级为 HttpOnly 短时会话。
        const sid = parseSessionCookie(req);
        if (!(sid && sessionStore.touch(sid))) {
          res.setHeader('Set-Cookie', sessionCookieHeader(sessionStore.issueGuest().id, { maxAgeSec: Math.floor(GUEST_TTL_MS / 1000) }));
        }
        return sendHtml(res, 200, renderAdminUI());
      }

      // ===== 管理页会话（P0 修复）=====
      // POST：一次性 guest Cookie 升级为会话；持有效会话则续期。裸调（无任何凭据）→ 401。
      if (method === 'POST' && p === '/api/admin/session') {
        sessionStore.sweep();
        const sid = parseSessionCookie(req);
        if (sid && sessionStore.touch(sid)) {
          // 已有有效会话：续期（滑动窗口），多标签/刷新共用同一会话
          res.setHeader('Set-Cookie', sessionCookieHeader(sid));
          return send(res, 200, envelope(true, { via: 'session' }, null, requestId));
        }
        if (sid && sessionStore.upgrade(sid)) {
          // guest → session（一次性升级，guest 凭据随之作废）
          res.setHeader('Set-Cookie', sessionCookieHeader(sid));
          return send(res, 200, envelope(true, { via: 'session' }, null, requestId));
        }
        return send(res, 401, envelope(false, { reason: 'pairing_required' }, 'UNAUTHORIZED_LOCAL_REQUEST', requestId));
      }
      // GET：会话状态（authorize 已校验 token 或会话）
      if (method === 'GET' && p === '/api/admin/session') {
        return send(res, 200, envelope(true, { active: true, via: auth.via }, null, requestId));
      }
      // DELETE：登出（吊销当前会话）
      if (method === 'DELETE' && p === '/api/admin/session') {
        sessionStore.revoke(parseSessionCookie(req));
        res.setHeader('Set-Cookie', SESSION_CLEAR_HEADER);
        return send(res, 200, envelope(true, { revoked: true }, null, requestId));
      }

      // 安全模式状态机
      if (method === 'GET' && p === '/api/safe-mode/status') {
        return send(res, 200, envelope(true, { on: safeMode }, null, requestId));
      }
      if (method === 'POST' && p === '/api/safe-mode/enter') {
        safeMode = true;
        persistSafeMode();
        return send(res, 200, envelope(true, { on: true }, null, requestId));
      }
      if (method === 'POST' && p === '/api/safe-mode/exit') {
        safeMode = false;
        persistSafeMode();
        return send(res, 200, envelope(true, { on: false }, null, requestId));
      }

      // 一次性确认票据（高风险操作前置）
      if (method === 'POST' && p === '/api/auth/confirm') {
        const scope = String(body.scope || '');
        if (riskOf('POST', scope.split(' ')[1] || '') !== 'write_high') {
          return send(res, 400, envelope(false, { reason: 'scope_not_high_risk' }, 'INVALID_REQUEST', requestId));
        }
        return send(res, 200, envelope(true, confirmStore.issue(scope), null, requestId));
      }

      // 健康
      if (method === 'POST' && p === '/api/health/check') {
        const r = await runHealthCheck({ profile: body.profile, deep: body.deep, root: dataDir });
        // findings 完整返回（evidence 已脱敏摘要，不含 token/正文），供 UI 逐条展示可修复标记
        const findings = (r.findings || []).map((f) => ({
          code: f.code,
          severity: f.severity,
          evidence: f.evidence,
          repairable: !!f.repairable,
          requiresPro: !!f.requiresPro,
        }));
        const out = { checkId: r.checkId, status: r.status, score: r.score, cdpPort: r.cdpPort, findingCount: findings.length, findings };
        // 落盘完整结果（含版本与时间），GET /api/health/check/:id 可读真实历史（不再 stub）
        try {
          atomicWriteJSON(path.join(dataDir, 'runtime', 'health', `${r.checkId}.json`), {
            ...r,
            findings,
            version: process.env.JZ_WB_VERSION || process.env.JZ_VERSION || 'unknown',
          });
        } catch (e) {
          /* 落盘失败不阻断响应（体检结果已返回） */
        }
        return send(res, 200, envelope(true, out, null, requestId));
      }
      if (method === 'GET' && /^\/api\/health\/check\/.+/.test(p)) {
        const id = String(p.split('/').pop()).replace(/[^a-zA-Z0-9-]/g, '');
        const saved = readJSON(path.join(dataDir, 'runtime', 'health', `${id}.json`));
        if (!saved) {
          return send(res, 404, envelope(false, null, 'CHECK_NOT_FOUND', requestId));
        }
        return send(res, 200, envelope(true, saved, null, requestId));
      }

      // 修复
      if (method === 'POST' && p === '/api/repair/plan') {
        return send(res, 200, envelope(true, { planId: uuid(), actions: planFor(body.findingCodes || []) }, null, requestId));
      }
      if (method === 'POST' && p === '/api/repair/run') {
        if (!body.confirmed) return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
        // 复查 P2（第五轮）：幂等键校验 + 路由前缀，避免与其他路由记录碰撞
        if (body.idempotencyKey && !IDEMPOTENCY_KEY_RE.test(String(body.idempotencyKey))) {
          return send(res, 400, envelope(false, { reason: '幂等键必须为 8-128 位字母/数字/_/- ' }, 'INVALID_REQUEST', requestId));
        }
        const idem = body.idempotencyKey ? `repair:${String(body.idempotencyKey)}` : null;
        if (idem && idempotency.has(idem)) {
          const saved = idempotency.get(idem);
          const out = saved.out !== undefined ? saved.out : saved;
          const topOk = saved.topOk !== undefined ? saved.topOk : true;
          const status = saved.status !== undefined && saved.status !== null ? saved.status : 200;
          return send(res, status, envelope(topOk, out, topOk ? null : 'REPAIR_PARTIAL_FAILED', requestId));
        }
        // 服务端重校验：根据 findingCodes 重新 planFor，逐个执行白名单动作。
        // hooks 合并：本地执行器（jz 侧可直接做的动作，不再 not_supported）+ 宿主注入（daemon 能力）。
        const localHooks = {
          'enter-safe-mode': async () => {
            safeMode = true;
            persistSafeMode();
            return { note: '已进入安全模式（只读降级，高风险写操作拒绝）' };
          },
          'cleanup-stale-runtime': async () => cleanupStaleRuntime(dataDir),
          'repair-workdaddy-directory-permission': async () => repairDirPermission(dataDir),
          'restore-latest-config': async () => restoreLatest(dataDir, 'settings', process.env.JZ_WORKBUDDY_DIR || undefined),
          'restore-account-backup': async () => restoreLatest(dataDir, 'accounts', process.env.JZ_WORKBUDDY_DIR || undefined),
          'rollback-component': async () => rollbackComponent(dataDir, process.env.JZ_WORKBUDDY_DIR || undefined),
        };
        const allHooks = Object.assign({}, localHooks, hooks);
        const beforeCodes = (body.findingCodes || []).map((c) => String(c));
        // 支持显式指定动作（如手动回滚 rollback-component）；服务端白名单校验，非法 id 400
        let actions;
        if (Array.isArray(body.actions) && body.actions.length) {
          const requested = body.actions.map((x) => String(x));
          const unknown = requested.filter((id) => !ACTIONS[id]);
          if (unknown.length) return send(res, 400, envelope(false, null, `INVALID_ACTION:${unknown.join(',')}`, requestId));
          actions = requested.map((id) => ACTIONS[id]);
        } else {
          actions = planFor(beforeCodes);
        }
        const executed = [];
        for (const a of actions) {
          const r = await runAction(a.id, { hooks: allHooks });
          executed.push(r);
        }
        // 复查闭环（08 E2E-001/003）：非重启类动作执行后，自动重跑同规则集体检，
        // 对比修复前 findingCodes 与修复后，标 fixed/remaining/unknown。
        let recheck = null;
        const anyOk = executed.some((r) => r.ok);
        const restarted = executed.some((r) => r.ok && r.actionId === 'restart-daemon');
        if (anyOk && !restarted) {
          // 复查 P1（2026-08-29）：修复闭环复查体检必须与请求同一数据目录（root: dataDir）
          const h = await runHealthCheck({ profile: body.profile || 'workbuddy-cn', root: dataDir });
          const afterCodes = (h.findings || []).map((f) => f.code);
          recheck = {
            fixed: beforeCodes.filter((c) => !afterCodes.includes(c)),
            remaining: beforeCodes.filter((c) => afterCodes.includes(c)),
            unknown: executed.filter((r) => !r.ok).map((r) => r.actionId),
            score: h.score,
            status: h.status,
          };
          // recheck 体检结果同样落盘（与 /api/health/check 同目录），供 GET /api/health/check/:id 审计
          try {
            atomicWriteJSON(path.join(dataDir, 'runtime', 'health', `${h.checkId}.json`), { ...h, findings: h.findings || [] });
          } catch { /* 落盘失败不阻断响应 */ }
        } else if (restarted) {
          recheck = { note: 'daemon 已重启，请重新体检确认', fixed: [], remaining: beforeCodes, unknown: [] };
        }
        const out = { planId: uuid(), executed, recheck };
        // 复查 P1（第四轮）：动作执行失败绝不返回顶层成功 ——
        // 全部成功 → 200 ok:true；部分/全部失败 → 422 ok:false + REPAIR_PARTIAL_FAILED，
        // out.executed 逐项携带真实 ok/error，前端按项展示，不得显示"修复成功"。
        const failedActions = executed.filter((r) => !r.ok);
        if (failedActions.length) {
          const topOk = failedActions.length < executed.length; // 部分成功仍 200 但 ok:true 携带 failedCount
          const status = topOk ? 200 : 422;
          if (idem) idemSet(idem, { status, out: { ...out, failedCount: failedActions.length, failedActionIds: failedActions.map((r) => r.actionId) }, topOk });
          return send(res, status, envelope(topOk, { ...out, failedCount: failedActions.length, failedActionIds: failedActions.map((r) => r.actionId) }, topOk ? null : 'REPAIR_PARTIAL_FAILED', requestId));
        }
        if (idem) idemSet(idem, { status: 200, out, topOk: true });
        return send(res, 200, envelope(true, out, null, requestId));
      }

      // 保险箱
      if (method === 'GET' && p === '/api/vault/backups') {
        return send(res, 200, envelope(true, { backups: listBackups(dataDir) }, null, requestId));
      }
      if (method === 'POST' && p === '/api/vault/backup') {
        // 复查 P2（04 §写操作幂等）：备份强制幂等键 —— 同键重放返回首次结果，不重复产生备份
        if (!IDEMPOTENCY_KEY_RE.test(String(body.idempotencyKey || ''))) {
          return send(res, 400, envelope(false, { reason: '必须提供 8-128 位幂等键（字母/数字/_/-）' }, 'INVALID_REQUEST', requestId));
        }
        const bidem = `backup:${String(body.idempotencyKey)}`;
        if (idempotency.has(bidem)) {
          const saved = idempotency.get(bidem);
          return send(res, saved.status, envelope(saved.r.ok === false ? false : true, saved.r, saved.r.ok === false ? saved.r.error : null, requestId));
        }
        // 互斥：备份/恢复/清理同一时刻只允许一个写操作（03 §4 / 05 §7）
        const lock = await withLock({ root: dataDir, op: 'backup-create', fn: async () => {
          const op = beginOperation({ root: dataDir, type: 'backup', label: '手动备份', total: 1 });
          const r = createBackup({ scope: body.scope || ['settings'], reason: body.reason || 'manual', root: dataDir });
          if (r.ok) completeOperation({ root: dataDir, operationId: op.operationId, status: 'succeeded', changed: [String(r.backupId)] });
          else failOperation({ root: dataDir, operationId: op.operationId, errorCode: r.error || 'BACKUP_FAILED', detail: r.detail });
          return { code: r.ok === false ? 422 : 200, r };
        } });
        if (lock.error === 'BUSY') return send(res, 409, envelope(false, { by: lock.by }, 'OPERATION_RUNNING', requestId));
        // P1 修复（指导 §10）：createBackup 失败绝不包装成 ok:true —— 低磁盘/权限/写入失败透传真实状态
        if (lock.r && lock.r.ok === false) {
          const status = lock.r.error === 'INSUFFICIENT_DISK_SPACE' ? 507 : 422;
          const payload = { reason: lock.r.error, detail: lock.r.detail, ok: false };
          idemSet(bidem, { status, r: payload });
          return send(res, status, envelope(false, payload, lock.r.error || 'BACKUP_FAILED', requestId));
        }
        idemSet(bidem, { status: lock.code, r: lock.r });
        return send(res, lock.code, envelope(true, lock.r, null, requestId));
      }
      // 06-D59：恢复中断状态查询（启动时前端据此提示「恢复未完成」，绝不自动继续）
      if (method === 'GET' && p === '/api/vault/restore-progress') {
        const st = getRestoreProgress(dataDir);
        return send(res, 200, envelope(true, st, null, requestId));
      }
      if (method === 'POST' && p === '/api/vault/restore/preview') {
        let r;
        try {
          r = await previewRestore({ backupId: body.backupId, scope: body.scope, root: dataDir });
        } catch (e) {
          if (e && e.code === 'INVALID_SCOPE') return send(res, 400, envelope(false, { reason: e.message }, 'INVALID_REQUEST', requestId));
          throw e;
        }
        if (!r.ok) return send(res, 422, envelope(false, r, r.error || 'BACKUP_CORRUPTED', requestId));
        // 指导 §7：服务端登记预览，恢复必须持未过期、未使用的 previewId
        const previewId = uuid();
        const now = Date.now();
        for (const [k, v] of previewStore) if (v.expiresAt < now) previewStore.delete(k);
        const expiresAt = now + PREVIEW_TTL_MS;
        previewStore.set(previewId, {
          backupId: r.backupId,
          scope: r.scope,
          manifestSha256: r.manifestSha256,
          createdAt: now,
          expiresAt,
        });
        return send(res, 200, envelope(true, {
          previewId,
          expiresAt: new Date(expiresAt).toISOString(),
          backupId: r.backupId,
          scope: r.scope,
          items: r.items,
          summary: r.summary,
        }, null, requestId));
      }
      if (method === 'POST' && p === '/api/vault/restore') {
        if (!body.confirmed) return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
        // 指导 §7：conflictPolicy 白名单，三值行为可测试且互不相同
        if (!['replace', 'keep-current', 'skip'].includes(body.conflictPolicy)) {
          return send(res, 400, envelope(false, { reason: 'conflictPolicy 必须是 replace/keep-current/skip' }, 'INVALID_REQUEST', requestId));
        }
        // 幂等重放：客户端超时重试/重复点击携带同一 previewId + 同一幂等键 → 直接返回首次结果。
        // 必须先于 previewStore 查找（首次调用已消费 previewId，重放时记录已不在）。
        const ridem = body.idempotencyKey ? String(body.idempotencyKey) : null;
        if (ridem && idempotency.has(`restore:${ridem}`)) {
          const saved = idempotency.get(`restore:${ridem}`);
          return send(res, saved.status, envelope(saved.r.ok, saved.r, saved.r.ok ? null : saved.r.error || 'RESTORE_FAILED', requestId));
        }
        // 预览绑定：previewId 必须存在、未过期、未使用，且与请求的 backupId/scope/manifest hash 一致
        const previewId = String(body.previewId || '');
        const rec = previewStore.get(previewId);
        if (!rec) return send(res, 410, envelope(false, { reason: 'preview_missing_or_used' }, 'PREVIEW_INVALID', requestId));
        if (rec.expiresAt < Date.now()) {
          previewStore.delete(previewId);
          return send(res, 410, envelope(false, { reason: 'preview_expired' }, 'PREVIEW_EXPIRED', requestId));
        }
        if (rec.backupId !== String(body.backupId || '')) {
          return send(res, 409, envelope(false, { reason: 'backupId 与预览不一致' }, 'PREVIEW_MISMATCH', requestId));
        }
        let reqScope;
        try {
          reqScope = normalizeScope(body.scope);
        } catch (e) {
          return send(res, 400, envelope(false, { reason: e.message }, 'INVALID_REQUEST', requestId));
        }
        if (JSON.stringify(reqScope) !== JSON.stringify(rec.scope)) {
          return send(res, 409, envelope(false, { reason: 'scope 与预览不一致' }, 'PREVIEW_MISMATCH', requestId));
        }
        if (manifestSha256(dataDir, rec.backupId) !== rec.manifestSha256) {
          previewStore.delete(previewId);
          return send(res, 409, envelope(false, { reason: '备份在预览后被修改，请重新预览' }, 'PREVIEW_STALE', requestId));
        }
        // previewId 单次使用：**锁成功后**才消费（第四轮复核 P1 修复——旧实现在拿锁前
        // 删除，锁忙返回 OPERATION_RUNNING 后用户重试会得 PREVIEW_INVALID，只能重新预览）
        const lock = await withLock({ root: dataDir, op: 'backup-restore', fn: async () => {
          // 全局长操作：restore 登记 operationId（V0.2）
          const op = beginOperation({ root: dataDir, type: 'restore', label: `恢复备份 ${String(rec.backupId).slice(0, 8)}`, total: 1 });
          const r = await restoreBackup({
            backupId: rec.backupId,
            scope: rec.scope,
            conflictPolicy: body.conflictPolicy,
            applyToReal: body.applyToReal === true,
            root: dataDir,
          });
          if (r.ok) completeOperation({ root: dataDir, operationId: op.operationId, status: 'succeeded', rollbackAvailable: !!r.rollback, changed: (r.changed || []).map((c) => String(c)) });
          else failOperation({ root: dataDir, operationId: op.operationId, errorCode: r.error || 'RESTORE_FAILED', detail: (r.rollback && r.rollback.status === 'rollback_failed') ? '回滚失败' : undefined });
          return { code: r.ok ? 200 : 422, r, operationId: op.operationId };
        } });
        if (lock.error === 'BUSY') {
          // 锁忙：previewId 不消费，用户等操作释放后可直接重试
          return send(res, 409, envelope(false, { by: lock.by }, 'OPERATION_RUNNING', requestId));
        }
        previewStore.delete(previewId); // 锁成功，消费预览（单次使用）
        if (ridem) idemSet(`restore:${ridem}`, { status: lock.code, r: lock.r });
        if (lock.r.ok) {
          return send(res, lock.code, envelope(true, lock.r, null, requestId));
        }
        // 恢复失败（含回滚失败）：返回可识别错误，绝不包装成成功
        const errCode = lock.r.rollback && lock.r.rollback.status === 'rollback_failed' ? 'ROLLBACK_FAILED' : (lock.r.error || 'RESTORE_FAILED');
        return send(res, lock.code, envelope(false, lock.r, errCode, requestId));
      }
      // ===== 导出/下载/导入（指导 §5：服务端受控目录，拒绝任意路径）=====
      if (method === 'POST' && p === '/api/vault/export') {
        // 客户端不再提交 destination：导出文件由服务端生成到受控 exports/ 目录
        if (body.destination !== undefined) {
          return send(res, 400, envelope(false, { reason: 'destination 不允许由客户端指定' }, 'INVALID_REQUEST', requestId));
        }
        // 复查 P2（第四轮）：可选幂等 —— 同键重放返回同一 exportId（TTL 内不重复导出）
        const idem = optIdem('vault:export');
        if (idem === true) return;
        const r = exportBackup({ backupId: body.backupId, passphrase: body.passphrase, root: dataDir });
        const status = r.ok ? 200 : r.error === 'INVALID_REQUEST' ? 400 : 422;
        optIdemSave(idem, status, r.ok, r.ok ? r : null, r.ok ? null : r.error);
        return send(res, status, envelope(r.ok, r.ok ? r : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'GET' && p === '/api/vault/exports') {
        return send(res, 200, envelope(true, { exports: listExports(dataDir) }, null, requestId));
      }
      if (method === 'GET' && /^\/api\/vault\/exports\/[A-Za-z0-9-]+\/download$/.test(p)) {
        const exportId = p.split('/')[4];
        const d = readExportForDownload({ exportId, root: dataDir });
        if (!d.ok) {
          const status = d.error === 'EXPORT_NOT_FOUND' ? 404 : 410;
          return send(res, status, envelope(false, null, d.error, requestId));
        }
        const buf = fs.readFileSync(d.filePath);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': buf.length,
          'content-disposition': `attachment; filename="${d.fileName}"`,
          'cache-control': 'no-store',
        });
        return res.end(buf);
      }
      if (method === 'POST' && p === '/api/vault/import') {
        // 指导 §5：导入只接受受控上传（uploadId → staging/）或本机导出（exportId → exports/），
        // 拒绝 JSON body 传任意本机路径。
        // 复查 P2（第四轮）：可选幂等 —— 同键重放返回首次导入结果（不重复建备份）
        const idem = optIdem('vault:import');
        if (idem === true) return;
        const hasUpload = body.uploadId && String(body.uploadId).trim();
        const hasExport = body.exportId && String(body.exportId).trim();
        if (!hasUpload && !hasExport) {
          return send(res, 400, envelope(false, { reason: '必须提供 uploadId（上传导入）或 exportId（本机导出导入）' }, 'INVALID_REQUEST', requestId));
        }
        // 2026-08-30 复核 P0：导入密码必须在 API 层拦截（旧实现透传 undefined → KDF 用 "undefined"
        // 字面量当密码，空密码即可解开交接包）
        if (typeof body.passphrase !== 'string' || body.passphrase.length === 0) {
          return send(res, 400, envelope(false, { reason: '导入交接包必须提供非空密码' }, 'IMPORT_PASSPHRASE_REQUIRED', requestId));
        }
        const r = importBackup({
          file: hasUpload ? body.uploadId : body.exportId,
          sourceKind: hasUpload ? 'staging' : 'export',
          passphrase: body.passphrase,
          root: dataDir,
        });
        optIdemSave(idem, r.ok ? 200 : 422, r.ok, r.ok ? r : null, r.ok ? null : r.error);
        return send(res, r.ok ? 200 : 422, envelope(r.ok, r.ok ? r : null, r.ok ? null : r.error, requestId));
      }

      // ===== 来源可追溯记忆（V1.0，能力提炼开发文档 §3.3/§5.2）=====
      if (method === 'POST' && p === '/api/memory/add') {
        const idem = optIdem('memory:add');
        if (idem === true) return;
        const r = addMemory({ title: body.title, text: body.text, sourceRefs: body.sourceRefs, tags: body.tags, importance: body.importance, root: dataDir });
        const status = r.ok ? 200 : r.error === 'INVALID_REQUEST' || r.error === 'SOURCE_REFS_REQUIRED' ? 400 : r.error === 'SENSITIVE_CONTENT' ? 422 : 500;
        optIdemSave(idem, status, r.ok, r.ok ? r.memory : null, r.ok ? null : r.error);
        return send(res, status, envelope(r.ok, r.ok ? r.memory : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'GET' && p === '/api/memory/list') {
        const r = listMemories({ status: body.status || u.searchParams.get('status') || undefined, tag: u.searchParams.get('tag') || undefined, root: dataDir });
        return send(res, 200, envelope(true, r, null, requestId));
      }
      if (method === 'GET' && /^\/api\/memory\/ast-[A-Za-z0-9-]{8,}$/.test(p)) {
        const r = getMemory(p.split('/')[3], { root: dataDir });
        return send(res, r.ok ? 200 : 404, envelope(r.ok, r.ok ? r.memory : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'POST' && p === '/api/memory/search') {
        const r = searchMemories({ query: body.query, status: body.status, limit: body.limit, root: dataDir });
        const status = r.ok ? 200 : 400;
        return send(res, status, envelope(r.ok, r.ok ? { memories: r.memories } : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'POST' && p === '/api/memory/recall') {
        // 工作前回忆：检索 + 更新召回统计（读+轻写，不需要 confirmToken）
        const r = recallForWork({ taskText: body.taskText, limit: body.limit, root: dataDir });
        const status = r.ok ? 200 : 400;
        return send(res, status, envelope(r.ok, r.ok ? { memories: r.memories } : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'POST' && /^\/api\/memory\/ast-[A-Za-z0-9-]{8,}\/status$/.test(p)) {
        const r = updateMemoryStatus(p.split('/')[3], body.status, { root: dataDir });
        const status = r.ok ? 200 : r.error === 'NOT_FOUND' ? 404 : r.error === 'MEMORY_TAMPERED' ? 409 : r.error === 'INVALID_STATUS' ? 400 : 422;
        return send(res, status, envelope(r.ok, r.ok ? r.memory : null, r.ok ? null : r.error, requestId));
      }

      // ===== 统一资产仓库（V1.0，能力提炼开发文档 §3.3 DistilledAsset / §4 API 契约）=====
      // GET /api/assets?kind=&status=&tag= —— 资产列表
      if (method === 'GET' && p === '/api/assets') {
        const r = listAssets({ kind: u.searchParams.get('kind') || undefined, status: u.searchParams.get('status') || undefined, tag: u.searchParams.get('tag') || undefined, root: dataDir });
        return send(res, 200, envelope(true, r, null, requestId));
      }
      // POST /api/assets/extract —— 从用户确认的内容提炼资产（草稿，默认不启用；幂等可选）
      if (method === 'POST' && p === '/api/assets/extract') {
        const idem = optIdem('asset:extract');
        if (idem === true) return;
        const r = addAsset({
          kind: body.kind, title: body.title, content: body.content,
          steps: body.steps, inputs: body.inputs, outputs: body.outputs,
          sourceRefs: body.sourceRefs, tags: body.tags, importance: body.importance,
          permissions: body.permissions, risk: body.risk, coverage: body.coverage,
          root: dataDir,
        });
        const status = r.ok ? 200 : r.error === 'INVALID_REQUEST' || r.error === 'SOURCE_REFS_REQUIRED' || r.error === 'INVALID_KIND' ? 400 : r.error === 'SENSITIVE_CONTENT' ? 422 : 500;
        optIdemSave(idem, status, r.ok, r.ok ? r.asset : null, r.ok ? null : r.error);
        return send(res, status, envelope(r.ok, r.ok ? r.asset : null, r.ok ? null : r.error, requestId));
      }
      // POST /api/assets/:id/status —— 任意白名单状态流转（draft/review/enabled/blocked/archived）
      if (method === 'POST' && /^\/api\/assets\/ast-[A-Za-z0-9-]{8,}\/status$/.test(p)) {
        const r = updateAssetStatus(p.split('/')[3], body.status, { root: dataDir });
        const status = r.ok ? 200 : r.error === 'NOT_FOUND' ? 404 : r.error === 'ASSET_TAMPERED' ? 409 : r.error === 'INVALID_STATUS' ? 400 : 422;
        return send(res, status, envelope(r.ok, r.ok ? r.asset : null, r.ok ? null : r.error, requestId));
      }
      // POST /api/assets/:id/review | /enable —— 文档契约的便捷别名
      if (method === 'POST' && /^\/api\/assets\/ast-[A-Za-z0-9-]{8,}\/review$/.test(p)) {
        const r = updateAssetStatus(p.split('/')[3], 'review', { root: dataDir });
        return send(res, r.ok ? 200 : r.error === 'NOT_FOUND' ? 404 : 422, envelope(r.ok, r.ok ? r.asset : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'POST' && /^\/api\/assets\/ast-[A-Za-z0-9-]{8,}\/enable$/.test(p)) {
        const r = updateAssetStatus(p.split('/')[3], 'enabled', { root: dataDir });
        return send(res, r.ok ? 200 : r.error === 'NOT_FOUND' ? 404 : 422, envelope(r.ok, r.ok ? r.asset : null, r.ok ? null : r.error, requestId));
      }
      // POST /api/assets/:id/version —— 版本化更新（同源再次提交，归档历史）
      if (method === 'POST' && /^\/api\/assets\/ast-[A-Za-z0-9-]{8,}\/version$/.test(p)) {
        const idem = optIdem('asset:version');
        if (idem === true) return;
        const r = updateAssetVersion(p.split('/')[3], { title: body.title, content: body.content, steps: body.steps, inputs: body.inputs, outputs: body.outputs, tags: body.tags, importance: body.importance, permissions: body.permissions, risk: body.risk, coverage: body.coverage, root: dataDir });
        const status = r.ok ? 200 : r.error === 'NOT_FOUND' ? 404 : r.error === 'ASSET_TAMPERED' ? 409 : r.error === 'SENSITIVE_CONTENT' ? 422 : 422;
        optIdemSave(idem, status, r.ok, r.ok ? r.asset : null, r.ok ? null : r.error);
        return send(res, status, envelope(r.ok, r.ok ? r.asset : null, r.ok ? null : r.error, requestId));
      }
      // POST /api/assets/:id/rollback —— 版本回滚（无历史 → 404 NO_HISTORY）
      if (method === 'POST' && /^\/api\/assets\/ast-[A-Za-z0-9-]{8,}\/rollback$/.test(p)) {
        const idem = optIdem('asset:rollback');
        if (idem === true) return;
        const r = rollbackAsset(p.split('/')[3], { root: dataDir });
        const status = r.ok ? 200 : r.error === 'NOT_FOUND' ? 404 : r.error === 'NO_HISTORY' ? 404 : r.error === 'ASSET_TAMPERED' ? 409 : 422;
        optIdemSave(idem, status, r.ok, r.ok ? r.asset : null, r.ok ? null : r.error);
        return send(res, status, envelope(r.ok, r.ok ? r.asset : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'GET' && /^\/api\/assets\/ast-[A-Za-z0-9-]{8,}$/.test(p)) {
        const r = getAsset(p.split('/')[3], { root: dataDir });
        return send(res, r.ok ? 200 : 404, envelope(r.ok, r.ok ? r.asset : null, r.ok ? null : r.error, requestId));
      }

      // ===== 信任评分与权限决策（V1.0，能力提炼开发文档 §3.3 permissions / PRD 权限五原则）=====
      // POST /api/policy/score —— 技能/资产信任评分（纯计算，明细透明）
      if (method === 'POST' && p === '/api/policy/score') {
        const r = scoreSkill({
          source: body.source, version: body.version, hasScripts: body.hasScripts,
          description: body.description, usage: body.usage, installedAt: body.installedAt,
          fileSizeBytes: body.fileSizeBytes, hasNetwork: body.hasNetwork, hasWrite: body.hasWrite,
        });
        return send(res, 200, envelope(true, { score: r.score, breakdown: r.breakdown, capabilities: r.capabilities }, null, requestId));
      }
      // POST /api/policy/decide —— 权限决策（高危动作永远 require-confirm）
      if (method === 'POST' && p === '/api/policy/decide') {
        const r = decide({ trustScore: body.trustScore, risk: body.risk, action: body.action });
        const status = r.ok ? 200 : r.error === 'INVALID_ACTION' ? 400 : 400;
        return send(res, status, envelope(r.ok, r.ok ? { decision: r.decision, reason: r.reason, threshold: r.threshold } : null, r.ok ? null : r.error, requestId));
      }
      // GET /api/policy/overlap?kind= —— 资产库功能重叠检测（Jaccard ≥0.35）
      if (method === 'GET' && p === '/api/policy/overlap') {
        const all = listAssets({ kind: u.searchParams.get('kind') || undefined, root: dataDir });
        const r = findOverlap(all.assets);
        return send(res, 200, envelope(true, { pairs: r.pairs, threshold: 0.35 }, null, requestId));
      }

      // ===== 任务记录 → 工作流提炼（V1.0，能力提炼开发文档 §5.3 / skill-distiller 方法论）=====
      // POST /api/extractor/mine —— 提交任务记录，返回候选流程（≥3 次且跨 ≥2 会话，签名骨架脱敏）
      if (method === 'POST' && p === '/api/extractor/mine') {
        const r = mineFlows({ records: body.records, minOccurrence: Number(body.minOccurrence) || 3 });
        return send(res, 200, envelope(true, { candidates: r.candidates }, null, requestId));
      }
      // POST /api/extractor/confirm —— 确认候选 → 落库 draft workflow 资产（来源可追溯）
      if (method === 'POST' && p === '/api/extractor/confirm') {
        const idem = optIdem('extractor:confirm');
        if (idem === true) return;
        const r = confirmFlow({ flowKey: body.flowKey, title: body.title, records: body.records, root: dataDir });
        const status = r.ok ? 200 : r.error === 'FLOW_NOT_FOUND' ? 404 : r.error === 'SENSITIVE_CONTENT' ? 422 : 422;
        optIdemSave(idem, status, r.ok, r.ok ? r.asset : null, r.ok ? null : r.error);
        return send(res, status, envelope(r.ok, r.ok ? r.asset : null, r.ok ? null : r.error, requestId));
      }

      // ===== 用量统计（V1.1，开发文档 §5.3-6 运行证据 / skill-manager 热度趋势方法论）=====
      // GET /api/usage/summary?days=7 —— 聚合（总数/按日/Top 路径/耗时）
      if (method === 'GET' && p === '/api/usage/summary') {
        const r = summarizeUsage({ days: Number(u.searchParams.get('days')) || 7, root: dataDir });
        return send(res, 200, envelope(true, r.summary, null, requestId));
      }
      // GET /api/usage/stale?days=60 —— 吃灰预警（N 天零调用的资产）
      if (method === 'GET' && p === '/api/usage/stale') {
        const all = listAssets({ root: dataDir });
        const r = staleAssets({ days: Number(u.searchParams.get('days')) || 60, assets: all.assets, root: dataDir });
        return send(res, 200, envelope(true, { stale: r.stale }, null, requestId));
      }

      // ===== 模型适配推荐（V1.1，能力提炼开发文档 §3.2 / litellm-router 方法论）=====
      // GET /api/models/recommendations?task=&preference=&limit= —— 能力硬过滤 + 三维评分
      if (method === 'GET' && p === '/api/models/recommendations') {
        const r = recommendModels({
          task: u.searchParams.get('task') || '',
          preference: u.searchParams.get('preference') || 'balanced',
          limit: Number(u.searchParams.get('limit')) || 5,
          root: dataDir,
        });
        return send(res, 200, envelope(true, { source: r.source, needs: r.needs, preference: r.preference, recommendations: r.recommendations }, null, requestId));
      }

      // ===== 值守中心（V0.2 收官，开发文档 §3.2 watchdog）=====
      // GET /api/watchdog/status —— 值守快照（设备/操作/自动备份/健康/告警；远程通道 payload 雏形）
      if (method === 'GET' && p === '/api/watchdog/status') {
        const r = watchdogStatus({ root: dataDir });
        return send(res, 200, envelope(true, r.status, null, requestId));
      }
      // POST /api/watchdog/scan —— 触发异常告警扫描
      if (method === 'POST' && p === '/api/watchdog/scan') {
        const r = alertScan({ root: dataDir });
        return send(res, 200, envelope(true, { alerts: r.alerts }, null, requestId));
      }
      // POST /api/watchdog/auto-backup/pause | resume —— 暂停/恢复自动备份（改设置，执行前重读生效）
      if (method === 'POST' && p === '/api/watchdog/auto-backup/pause') {
        const r = setAutoBackupPaused({ paused: true, root: dataDir });
        return send(res, r.ok ? 200 : 500, envelope(r.ok, r.ok ? { paused: true } : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'POST' && p === '/api/watchdog/auto-backup/resume') {
        const r = setAutoBackupPaused({ paused: false, root: dataDir });
        return send(res, r.ok ? 200 : 500, envelope(r.ok, r.ok ? { paused: false } : null, r.ok ? null : r.error, requestId));
      }
      // POST /api/watchdog/restart —— 重启请求标记（HIGH_RISK confirmToken 由 authorize 校验；daemon 检测后优雅退出，宿主拉回）
      if (method === 'POST' && p === '/api/watchdog/restart') {
        const r = requestRestart({ reason: body.reason, root: dataDir });
        return send(res, r.ok ? 200 : 500, envelope(r.ok, r.ok ? { requestId: r.requestId, reason: r.reason } : null, r.ok ? null : r.error, requestId));
      }

      // ===== 全局长操作（V0.2，能力提炼开发文档 §3.2/§7）=====
      if (method === 'GET' && p === '/api/operations') {
        sweepOperations({ root: dataDir });
        const r = listOperations({ root: dataDir });
        return send(res, 200, envelope(true, r, null, requestId));
      }
      if (method === 'GET' && /^\/api\/operations\/[A-Za-z0-9-]+$/.test(p)) {
        const r = getOperation({ root: dataDir, operationId: p.split('/')[3] });
        return send(res, r.ok ? 200 : 404, envelope(r.ok, r.ok ? { operation: r.operation } : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'POST' && /^\/api\/operations\/[A-Za-z0-9-]+\/cancel$/.test(p)) {
        const r = cancelOperation({ root: dataDir, operationId: p.split('/')[3], reason: body.reason });
        return send(res, r.ok ? 200 : 404, envelope(r.ok, r.ok ? { operation: r.operation } : null, r.ok ? null : r.error, requestId));
      }

      // ===== 交接包（V0.2，能力提炼开发文档 §5.2）=====
      if (method === 'POST' && p === '/api/handoff/create') {
        // 生成 exports/handoff-<id>.jzhandoff（HIGH_RISK：需 confirmToken，与 vault/export 一致）
        const idem = optIdem('handoff:create');
        if (idem === true) return;
        const r = createHandoff({ root: dataDir, passphrase: body.passphrase, label: body.label, sourceRefs: body.sourceRefs, scope: body.scope });
        const status = r.ok ? 200 : r.error === 'INVALID_REQUEST' ? 400 : 422;
        optIdemSave(idem, status, r.ok, r.ok ? r : null, r.ok ? null : r.error);
        return send(res, status, envelope(r.ok, r.ok ? r : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'POST' && p === '/api/handoff/preview') {
        // 预览（read 风险）：解密校验 + 条目清单 + 目标冲突检测；previewId 绑定（单次 + 10min + 文件 checksum）
        const r = previewHandoff({ file: body.file, sourceKind: body.sourceKind, passphrase: body.passphrase, root: dataDir });
        if (!r.ok) {
          const status = r.error === 'INVALID_REQUEST' ? 400 : 422;
          return send(res, status, envelope(false, null, r.error, requestId));
        }
        const previewId = uuid();
        previewStore.set(previewId, { handoff: true, fileChecksum: r.preview.fileChecksum, expiresAt: Date.now() + PREVIEW_TTL_MS });
        return send(res, 200, envelope(true, { preview: r.preview, previewId, expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString() }, null, requestId));
      }
      if (method === 'POST' && p === '/api/handoff/apply') {
        // 应用交接包（HIGH_RISK：confirmToken 已由 authorize 校验）：previewId 绑定 + 幂等 + 互斥锁
        const idem = optIdem('handoff:apply');
        if (idem === true) return;
        const previewId = String(body.previewId || '');
        const rec = previewStore.get(previewId);
        if (!rec || !rec.handoff) return send(res, 410, envelope(false, null, 'PREVIEW_INVALID', requestId));
        if (rec.expiresAt < Date.now()) {
          previewStore.delete(previewId);
          return send(res, 410, envelope(false, null, 'PREVIEW_EXPIRED', requestId));
        }
        // 文件 checksum 与预览时一致（防预览后被换文件）
        const srcR = resolveImportFile({ file: body.file, sourceKind: body.sourceKind, root: dataDir });
        if (!srcR.ok) return send(res, 422, envelope(false, null, 'INVALID_REQUEST', requestId));
        let curHash = '';
        try { curHash = crypto.createHash('sha256').update(fs.readFileSync(srcR.path)).digest('hex'); } catch (e) { return send(res, 422, envelope(false, null, 'HANDOFF_FILE_NOT_FOUND', requestId)); }
        if (curHash !== rec.fileChecksum) {
          previewStore.delete(previewId);
          return send(res, 409, envelope(false, { reason: '交接包在预览后被修改，请重新预览' }, 'PREVIEW_STALE', requestId));
        }
        // previewId 单次使用：**锁成功后**才消费（第四轮复核 P1 修复，与 restore 同因）
        const lock = await withLock({ root: dataDir, op: 'handoff-apply', fn: async () => {
          const op = beginOperation({ root: dataDir, type: 'handoff-apply', label: `应用交接包 ${String(body.file || '').slice(0, 40)}`, total: 1 });
          const r = await applyHandoff({ file: body.file, sourceKind: body.sourceKind, passphrase: body.passphrase, conflictPolicy: body.conflictPolicy, root: dataDir, wbDir: workbuddyDir() });
          if (r.ok) completeOperation({ root: dataDir, operationId: op.operationId, status: 'succeeded', rollbackAvailable: !!(r.restore && r.restore.rollback) });
          else failOperation({ root: dataDir, operationId: op.operationId, errorCode: r.error || 'HANDOFF_APPLY_FAILED' });
          return { code: r.ok ? 200 : 422, r, operationId: op.operationId };
        } });
        if (lock.error === 'BUSY') return send(res, 409, envelope(false, { by: lock.by }, 'OPERATION_RUNNING', requestId));
        previewStore.delete(previewId); // 锁成功，消费预览（单次使用）
        optIdemSave(idem, lock.code, lock.r.ok, lock.r.ok ? lock.r : null, lock.r.ok ? null : lock.r.error);
        return send(res, lock.code, envelope(lock.r.ok, lock.r.ok ? lock.r : null, lock.r.ok ? null : lock.r.error, requestId));
      }
      if (method === 'GET' && p === '/api/handoff/list') {
        return send(res, 200, envelope(true, { handoffs: listHandoffFiles(dataDir) }, null, requestId));
      }

      // 清理（回收站语义）。复查 P2：apply/restore/purge 支持可选幂等键（同键重放返回首次结果）
      if (method === 'POST' && p === '/api/cleanup/scan') {
        return send(res, 200, envelope(true, scan({ root: dataDir }), null, requestId));
      }
      const cleanupIdem = (scope) => {
        const key = body.idempotencyKey ? `${scope}:${String(body.idempotencyKey)}` : null;
        if (key && idempotency.has(key)) {
          const saved = idempotency.get(key);
          // 复查 P2（第五轮）：同键不同参 → 冲突
          if (saved.fp !== undefined && saved.fp !== requestFingerprint()) {
            send(res, 409, envelope(false, { reason: '同幂等键但请求参数不同' }, 'IDEMPOTENCY_CONFLICT', requestId));
            return true;
          }
          send(res, saved.status, envelope(saved.r.ok, saved.r, saved.r.ok ? null : saved.r.error || 'INVALID_REQUEST', requestId));
          return true;
        }
        return key || null;
      };
      if (method === 'POST' && p === '/api/cleanup/apply') {
        const idem = cleanupIdem('cleanup:apply');
        if (idem === true) return;
        const lock = await withLock({ root: dataDir, op: 'cleanup-apply', fn: async () => {
          const r = apply({ ids: body.ids, root: dataDir });
          // 2026-08-29 复核 P1：全部失败 → 422（不再"未执行却返回 200 ok:true"）
          const code = !r.ok && r.moved === 0 && r.failed > 0 ? 422 : 200;
          return { code, r };
        } });
        if (lock.error === 'BUSY') return send(res, 409, envelope(false, { by: lock.by }, 'OPERATION_RUNNING', requestId));
        if (idem) idemSet(idem, { status: lock.code, r: lock.r, fp: requestFingerprint() });
        return send(res, lock.code, envelope(lock.r.ok, lock.r, lock.r.ok ? null : 'CLEANUP_PARTIAL_FAILED', requestId));
      }
      if (method === 'GET' && p === '/api/cleanup/quarantine') {
        return send(res, 200, envelope(true, listQuarantine({ root: dataDir }), null, requestId));
      }
      if (method === 'POST' && p === '/api/cleanup/restore') {
        const idem = cleanupIdem('cleanup:restore');
        if (idem === true) return;
        const lock = await withLock({ root: dataDir, op: 'cleanup-restore', fn: async () => {
          const r = cleanupRestore({ receiptId: body.receiptId, root: dataDir });
          return { code: r.ok ? 200 : 422, r };
        } });
        if (lock.error === 'BUSY') return send(res, 409, envelope(false, { by: lock.by }, 'OPERATION_RUNNING', requestId));
        if (idem) idemSet(idem, { status: lock.code, r: lock.r, fp: requestFingerprint() });
        return send(res, lock.code, envelope(lock.r.ok, lock.r, lock.r.ok ? null : lock.r.error || 'INVALID_REQUEST', requestId));
      }
      if (method === 'POST' && p === '/api/cleanup/purge') {
        const idem = cleanupIdem('cleanup:purge');
        if (idem === true) return;
        const lock = await withLock({ root: dataDir, op: 'cleanup-purge', fn: async () => {
          const r = cleanupPurge({ receiptId: body.receiptId, confirmed: body.confirmed, root: dataDir });
          return { code: r.ok ? 200 : 400, r };
        } });
        if (lock.error === 'BUSY') return send(res, 409, envelope(false, { by: lock.by }, 'OPERATION_RUNNING', requestId));
        if (idem) idemSet(idem, { status: lock.code, r: lock.r, fp: requestFingerprint() });
        return send(res, lock.code, envelope(lock.r.ok, lock.r, lock.r.ok ? null : lock.r.error || 'INVALID_REQUEST', requestId));
      }

      // 兼容性
      if (method === 'GET' && p === '/api/compatibility/report') {
        const r = await checkCompatibility({ profile: loadSettings(dataDir).selectedProfile });
        return send(res, 200, envelope(true, r, null, requestId));
      }
      if (method === 'POST' && p === '/api/compatibility/check') {
        const r = await checkCompatibility({ profile: body.profile });
        return send(res, 200, envelope(true, r, null, requestId));
      }

      // 桌面设备授权登录（kaypal desktop-auth：账号密码 → desktopAccessToken）
      // 二开并入：token 落本地会话，响应只回 user/device（不回 token，防 token 进日志/前端）。
      if (method === 'POST' && p === '/api/desktop-auth/login') {
        const r = await desktopPasswordLogin({
          phone: String(body.phone || ''),
          password: String(body.password || ''),
          deviceName: body.deviceName || 'JIUZHANG AI 管家',
          platform: body.platform || 'desktop',
          root: dataDir,
        });
        if (!r.ok) {
          const st =
            r.error === 'INVALID_REQUEST' ? 400 :
            r.error === 'ACCOUNT_DISABLED' ? 403 :
            r.error === 'DESKTOP_AUTH_UNAVAILABLE' ? 503 :
            401; // INVALID_CREDENTIALS / DESKTOP_AUTH_FAILED
          return send(res, st, envelope(false, null, r.error, requestId));
        }
        return send(res, 200, envelope(true, { user: r.user, device: r.device }, null, requestId));
      }
      if (method === 'GET' && p === '/api/desktop-auth/status') {
        const auth = loadDesktopAuth(dataDir);
        return send(res, 200, envelope(true, { loggedIn: !!(auth && auth.user), user: auth ? auth.user : null }, null, requestId));
      }
      if (method === 'POST' && p === '/api/desktop-auth/revoke') {
        // 设备吊销（07 §4 activate/revoke）：高风险，需一次性 confirmToken；成功后清本地会话+权益缓存
        const r = await revokeDevice({ root: dataDir });
        if (!r.ok) {
          const st = r.error === 'NOT_LOGGED_IN' ? 400 : r.error === 'REVOKE_UNAVAILABLE' ? 503 : 502;
          return send(res, st, envelope(false, null, r.error, requestId));
        }
        return send(res, 200, envelope(true, { status: r.status, deviceId: r.deviceId, source: r.source }, null, requestId));
      }
      // 设备码登录（RFC 8628）：start 拿 user_code + verification_url，poll 轮询授权结果。
      if (method === 'POST' && p === '/api/desktop-auth/device/start') {
        const r = await deviceFlowStart({
          deviceName: body.deviceName || 'JIUZHANG AI 管家',
          platform: body.platform || 'desktop',
          root: dataDir,
        });
        if (!r.ok) {
          const st = r.error === 'DEVICE_FLOW_UNAVAILABLE' ? 503 : 502;
          return send(res, st, envelope(false, null, r.error, requestId));
        }
        // 只回 user_code/verification_url/interval 等展示信息，不回 device_code（内部状态，防日志泄露）
        return send(res, 200, envelope(true, {
          userCode: r.userCode,
          verificationUrl: r.verificationUrl,
          expiresIn: r.expiresIn,
          interval: r.interval,
        }, null, requestId));
      }
      if (method === 'POST' && p === '/api/desktop-auth/device/poll') {
        const r = await deviceFlowPoll({ root: dataDir });
        if (r.ok) {
          return send(res, 200, envelope(true, { status: 'authorized', user: r.user, device: r.device }, null, requestId));
        }
        const st =
          r.status === 'pending' ? 202 :
          r.status === 'denied' ? 403 :
          r.status === 'expired' ? 410 :
          400;
        // data 带 status/interval（前端据此轮询/终止），error 带错误码
        return send(res, st, envelope(false, { status: r.status, interval: r.interval, detail: r.detail }, r.error || r.status, requestId));
      }

      // ===== 本机微信一键登录（2026-09-04 产品负责人拍板「一步到位」，规格见
      // docs/kaypal底座-设备密钥登录接口规格-v1-20260904.md）=====
      // 原则：账号逻辑全挂 kaypal 统一用户体系，本组路由只做识别/编排/签名，
      // 登录产物与 desktop-auth 完全同构。底座未上线时 bind/login 报 503，前端回落扫码兜底。
      if (method === 'GET' && p === '/api/wechat-local/status') {
        const ident = await wechatLocal.detectLocalWeChat({});
        const kp = wechatLocal.ensureDeviceKeypair(dataDir);
        return send(res, 200, envelope(true, {
          supported: ident.supported,
          detected: ident.detected,
          // 昵称仅在 DB 解密成功（high）时给 Mac 目录级探测无昵称，不给假名
          nickname: ident.confidence === 'high' ? (ident.nickname || '') : '',
          confidence: ident.confidence || null,
          keyReady: !!(kp && kp.publicKey),
        }, null, requestId));
      }
      if (method === 'POST' && p === '/api/wechat-local/bind/start') {
        const r = await wechatLocal.bindStart({ root: dataDir, deviceName: body.deviceName });
        if (!r.ok) {
          const st = r.error === 'WECHAT_NOT_DETECTED' ? 404 : r.error === 'DEVICE_LIMIT' ? 409 : 503;
          return send(res, st, envelope(false, null, r.error, requestId));
        }
        // pairingCode 回前端展示（授权页确认用）；verificationUrl 供二维码兜底
        return send(res, 200, envelope(true, {
          intentId: r.intentId, pairingCode: r.pairingCode, verificationUrl: r.verificationUrl,
          expiresIn: r.expiresIn, nickname: r.nickname,
        }, null, requestId));
      }
      if (method === 'GET' && p === '/api/wechat-local/bind/status') {
        const r = await wechatLocal.bindStatus({ root: dataDir });
        if (!r.ok) return send(res, 400, envelope(false, null, r.detail || r.status, requestId));
        const st = r.status === 'bound' ? 200 : r.status === 'pending' ? 202 : r.status === 'expired' ? 410 : 400;
        return send(res, st, envelope(true, { status: r.status, pairingCode: r.pairingCode, verificationUrl: r.verificationUrl }, null, requestId));
      }
      if (method === 'POST' && p === '/api/wechat-local/login') {
        const r = await wechatLocal.localLogin({ root: dataDir });
        if (!r.ok) {
          const st =
            r.error === 'NO_BINDING' ? 409 :
            r.error === 'CHALLENGE_FAILED' || r.error === 'WECHAT_LOGIN_UNAVAILABLE' ? 503 :
            401;
          return send(res, st, envelope(false, { needBind: !!r.needBind, detail: r.detail }, r.error, requestId));
        }
        // 与 desktop-auth/login 同纪律：不回 token，只回 user（防 token 进前端/日志）
        return send(res, 200, envelope(true, { user: r.user, loginMethod: r.loginMethod }, null, requestId));
      }

      // ===== 微信扫码直登（2026-09-06 产品负责人定版：桌面二维码+手机微信一扫+底座建号绑定）=====
      // 与配对码链路灰度并存：身份由微信 OAuth 背书，免配对码免本机检测。
      if (method === 'POST' && p === '/api/wechat-local/wechat-scan/start') {
        const r = await wechatLocal.wechatScanStart({ root: dataDir, deviceName: body.deviceName });
        if (!r.ok) {
          const st = r.error === 'RATE_LIMITED' ? 429 : 503;
          return send(res, st, envelope(false, { detail: r.detail }, r.error, requestId));
        }
        return send(res, 200, envelope(true, { intentId: r.intentId, qrUrl: r.qrUrl, expiresIn: r.expiresIn }, null, requestId));
      }
      if (method === 'GET' && p === '/api/wechat-local/wechat-scan/poll') {
        const r = await wechatLocal.wechatScanPoll({ root: dataDir });
        if (!r.ok) {
          // 十五轮 P3：确定性失败（非 retryable）用 4xx 让前端停止轮询并展示原因；
          // 可重试（5xx/网络）保持 503，前端继续轮询。
          const st = r.retryable === false ? (r.error === 'NO_BINDING' ? 409 : r.error === 'ACCOUNT_INVALID' ? 403 : 400) : 503;
          return send(res, st, envelope(false, { status: r.status, needBind: !!r.needBind, retryable: r.retryable, detail: r.detail }, r.error || r.status, requestId));
        }
        const st = r.status === 'ready' ? 200 : r.status === 'pending' ? 202 : 410;
        // 与 login 同纪律：不回 token，只回 user
        return send(res, st, envelope(true, { status: r.status, qrUrl: r.qrUrl, user: r.user, loginMethod: r.loginMethod }, null, requestId));
      }

      // 二维码生成（自研 qrcode.js，零依赖）：供登录设备码 / 支付码共用。
      // GET /api/qrcode?text=<urlencoded>；text 限 8-256 字符，超限/过短拒绝；SVG 直接内嵌面板。
      if (method === 'GET' && p === '/api/qrcode') {
        const u = new URL(req.url, 'http://localhost');
        const text = String(u.searchParams.get('text') || '');
        if (text.length < 8 || text.length > 256) {
          return send(res, 400, envelope(false, { reason: 'text 须为 8-256 字符' }, 'INVALID_REQUEST', requestId));
        }
        const r = qrSvg(text, { scale: 6, margin: 2 });
        if (!r.ok) return send(res, 400, envelope(false, { reason: r.error, capacity: r.capacity }, r.error || 'QR_FAILED', requestId));
        return send(res, 200, envelope(true, { svg: r.svg, version: r.version, modules: r.modules }, null, requestId));
      }

      // Kaypal 优惠券对接（desktopAccessToken Bearer → kaypal /api/pricing/coupons/*）
      if (method === 'GET' && p === '/api/coupon/kaypal/list') {
        const r = await listFromKaypal({ root: dataDir });
        return send(res, r.ok ? 200 : 503, envelope(r.ok, r.ok ? { coupons: r.coupons || [] } : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'POST' && p === '/api/coupon/kaypal/redeem') {
        // 2026-08-29 复核 P1：kaypal 券兑换强制幂等键（8-128 位），同本地券一致——重试不重复发权益
        if (!IDEMPOTENCY_KEY_RE.test(String(body.idempotencyKey || ''))) {
          return send(res, 400, envelope(false, { reason: '必须提供 8-128 位幂等键（字母/数字/_/-）' }, 'INVALID_REQUEST', requestId));
        }
        const idem = optIdem('kaypal-coupon:redeem');
        if (idem === true) return;
        const r = await redeemOnKaypal({
          couponCode: body.couponCode || body.code,
          orderId: body.orderId,
          orderAmount: body.orderAmount,
          planId: body.planId,
          idempotencyKey: body.idempotencyKey,
          root: dataDir,
        });
        const status = r.ok ? 200 : 400;
        optIdemSave(idem, status, r.ok, r.ok ? r.data : null, r.ok ? null : r.error);
        return send(res, status, envelope(r.ok, r.ok ? r.data : null, r.ok ? null : r.error, requestId));
      }

      // 会员与诊断
      if (method === 'GET' && p === '/api/license/status') {
        const r = await getStatus({ root: dataDir });
        return send(
          res,
          r.ok ? 200 : 503,
          envelope(r.ok, r.ok ? { entitlement: r.entitlement, source: r.source } : null, r.ok ? null : 'LICENSE_UNAVAILABLE', requestId),
        );
      }
      // 试用状态（2026-09-04）：前端会员页展示「试用中/剩余时间」或「试用结束」用。
      // A0 复核 P1 修复（2026-09-04）：paid 必须校验 validUntil——年费到期是正常业务路径，
      // 若只判 status==='active'，到期用户会拿到 paid:true 但 unlocked:false（后端 gate 仍 402），
      // 前端据此「显示会员、不锁 UI、点啥都 402」的精分状态。
      if (method === 'GET' && p === '/api/license/trial-status') {
        const ent = loadEntitlementCache(dataDir);
        const now = Date.now();
        const active = !!(ent && ent.status === 'active');
        const untilMs = ent && ent.validUntil ? new Date(ent.validUntil).getTime() : NaN;
        // 付费有效中：active 且（终身无 validUntil，或 validUntil 未过期）
        const paid = active && (!ent.validUntil || (Number.isFinite(untilMs) && untilMs > now));
        // 会员已到期（曾付费但权益过期）：前端据此区分「会员到期续费」与「试用结束开通」
        const membershipExpired = active && !!ent.validUntil && Number.isFinite(untilMs) && untilMs <= now;
        return send(res, 200, envelope(true, {
          unlocked: isUnlocked(dataDir, ent),
          trial: getTrialState(dataDir),
          paid,
          membershipExpired,
          entitlement: ent || null,
        }, null, requestId));
      }
      if (method === 'POST' && p === '/api/license/refresh') {
        // 复查 P2（第四轮）：可选幂等 —— 同键重放返回首次刷新结果
        const idem = optIdem('license:refresh');
        if (idem === true) return;
        const r = await refresh(dataDir);
        const status = r.ok ? 200 : 503;
        optIdemSave(idem, status, r.ok, r.ok ? { entitlement: r.entitlement } : null, r.ok ? null : 'LICENSE_UNAVAILABLE');
        return send(res, status, envelope(r.ok, r.ok ? { entitlement: r.entitlement } : null, r.ok ? null : 'LICENSE_UNAVAILABLE', requestId));
      }
      if (method === 'GET' && p === '/api/license/plans') {
        // 价目卡动态化：kaypal 方案目录转发（公开端点），失败给本地写死价目（由前端兜底）
        const r = await getPlans();
        return send(res, 200, envelope(true, { plans: r.ok ? r.plans : null, source: r.ok ? r.source : 'local-fallback' }, null, requestId));
      }
      if (method === 'POST' && p === '/api/license/trial') {
        // 下单前试算（2026-08-31 产品负责人决策：下单前展示折后价）。
        // kaypal 公开 calculate（2026-08-31 probe 验证：公开、不收券）拿原价；给券码且已登录时按我的券规则本地预估折后价。
        // 只读、不产生订单、不核销券；estimate=true 标注为预估值，实际以下单页核销为准。
        const planId = String(body.planId || '');
        if (!planId) return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
        let listPrice = null;
        try {
          const r = await httpsJson('POST', '/api/pricing/calculate', { type: 'individual', planId }, {});
          if (r.status === 200 && r.body && r.body.success) {
            const d = r.body.data || {};
            const v = d.amount != null ? d.amount : (d.price != null ? d.price : d.finalPrice);
            if (v != null && Number.isFinite(Number(v))) listPrice = Number(v);
          }
        } catch (e) { /* calculate 不可用 → 回退价目目录 */ }
        if (listPrice == null) {
          const pr = await getPlans().catch(() => ({ ok: false }));
          const plan = ((pr && pr.plans) || []).find((x) => x && x.id === planId);
          if (plan && typeof plan.price === 'number') listPrice = plan.price;
        }
        if (listPrice == null) {
          return send(res, 502, envelope(false, { detail: '无法获取套餐价格（kaypal calculate 与价目均不可用）' }, 'TRIAL_UNAVAILABLE', requestId));
        }
        // 用券预估：从我的券里按券码找券，按规则字段防御式预估折扣（不核销）。
        // 2026-08-31 复核 P2（Codex #7）：D3"无写盘"是硬约束——只读加载凭据（不触发旧明文
        // 迁移写盘），token 显式传给 listFromKaypal 避免其内部再走 loadDesktopAuth 迁移路径。
        const couponCode = String(body.couponCode || '').trim();
        let discount = 0;
        let couponApplied = false;
        let couponNote = '';
        if (couponCode) {
          const authRO = loadDesktopAuthReadOnly(dataDir);
          const mine = authRO && authRO.accessToken
            ? await listFromKaypal({ accessToken: authRO.accessToken, root: dataDir })
            : { ok: false, error: 'UNAUTHENTICATED' };
          const coupons = (mine && mine.ok && mine.coupons) || [];
          const c = coupons.find((x) => x && (x.code === couponCode || x.couponCode === couponCode));
          if (!c) {
            couponNote = '未找到该券（或未登录），以下单页实际核销为准';
          } else {
            const rule = c.rule || c.discount || {};
            const pct = Number(rule.percent != null ? rule.percent : (c.discountPercent != null ? c.discountPercent : rule.percentOff));
            const amt = Number(rule.amount != null ? rule.amount : (c.discountAmount != null ? c.discountAmount : rule.amountOff));
            if (Number.isFinite(pct) && pct > 0 && pct < 100) discount = Math.round(listPrice * (pct / 100) * 100) / 100;
            else if (Number.isFinite(amt) && amt > 0) discount = Math.min(amt, listPrice);
            couponApplied = discount > 0;
            if (!couponApplied) couponNote = '券规则无法识别（按原价试算），以下单页实际核销为准';
          }
        }
        const finalPrice = Math.max(0, Math.round((listPrice - discount) * 100) / 100);
        return send(res, 200, envelope(true, {
          planId, listPrice, discount, finalPrice,
          couponApplied, couponCode: couponCode || null, estimate: true,
          note: couponNote || '试算仅供参考，以下单页实际核销为准',
        }, null, requestId));
      }
      if (method === 'GET' && p === '/api/license/order/status') {
        // 订阅激活状态确认（支付后用）。Task#11（2026-09-01）改走 kaypal-pay.checkSubscription：
        // exchange JWT（Cookie 会话）查 GET /api/pricing/subscription/status?type=individual——
        // 2026-09-01 实测 200（旧 Bearer kda 路径在 subscribe 类路由会卡 route 层会话校验，统一收敛到 Cookie 链）。
        // 返回 { hasSubscription, status: active|none, expiresAt, planId }。type= 参数保留兼容但忽略（桌面端仅 individual）。
        const r = await kaypalPay.checkSubscription({ root: dataDir, _httpsJson: kHttp });
        if (!r.ok) {
          const unauth = r.needLogin || r.error === 'NOT_LOGGED_IN' || r.error === 'SESSION_EXPIRED';
          return send(res, unauth ? 401 : 502, envelope(false, { detail: r.detail || r.error },
            unauth ? 'UNAUTHENTICATED' : 'ORDER_STATUS_UNAVAILABLE', requestId));
        }
        return send(res, 200, envelope(true, {
          hasSubscription: r.hasSubscription,
          status: r.status,
          expiresAt: r.expiresAt,
          planId: r.planId,
        }, null, requestId));
      }
      if (method === 'POST' && p === '/api/license/purchase') {
        // 会员购买（Task#11 2026-09-01）：微信 native 扫码全链（kaypal-pay.buyPlanWechat：
        // exchange JWT Cookie 会话 → subscribe 订阅单 → payment/create 微信单 → codeUrl）。
        // 返回 data = {orderId, orderNo, codeUrl, amountFen, priceYuan, status:'pending'}，
        // 支付状态由 GET /api/license/pay/query?orderNo= 轮询，激活由 /api/license/order/status 确认。
        // 复查 P1（2026-08-29）：强制订单幂等键 + 持久化 —— 支付超时重试/重复点击不重复创建订单。
        if (!IDEMPOTENCY_KEY_RE.test(String(body.idempotencyKey || ''))) {
          return send(res, 400, envelope(false, { reason: '必须提供 8-128 位订单幂等键（字母/数字/_/-）' }, 'INVALID_REQUEST', requestId));
        }
        const planId = String(body.planId || '');
        // Task#11（2026-09-01）：微信 native 扫码支付为唯一在途支付通道
        //（支付宝当面付未签约——收了 alipay 参数也不能静默走微信，直接 400 拒绝）。
        const paymentMethod = 'wechat';
        if (body.paymentMethod && body.paymentMethod !== 'wechat') {
          return send(res, 400, envelope(false, { reason: '当前仅支持微信扫码支付（支付宝当面付签约中）' }, 'PAYMENT_METHOD_UNAVAILABLE', requestId));
        }
        if (!planId) return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
        const auth = loadDesktopAuth(dataDir);
        if (!auth || !auth.accessToken) {
          return send(res, 401, envelope(false, null, 'UNAUTHENTICATED', requestId));
        }
        // 幂等登记（持久化 purchase-idempotency.json）：同键同参 → 返回首次结果；同键不同参 → 冲突
        // Codex 复核 P2 修复：券码规范化补 trim（与 kaypal-pay subscribePlan 的 trim 对齐，指纹才与实际核销一致）。
        const couponCodeNorm = body.couponCode ? String(body.couponCode).trim() : '';
        const userKey = `${(auth.user && (auth.user.id || auth.user.userId)) || 'local'}:${String(body.idempotencyKey)}`;
        // Codex 复核 P1 修复：bizKey 必须含券码——原 bizKey 只到 planId 粒度，"同套餐换券换幂等键重试"
        // 会命中旧券成功记录直接回放旧订单（新券被静默丢弃）。券码进 bizKey 后，换券 = 换保护窗口，
        // 各券独立防重复下单；同键不同参仍被指纹校验拦成 IDEMPOTENCY_CONFLICT。
        const bizKey = `${(auth.user && (auth.user.id || auth.user.userId)) || 'local'}:${planId}:${paymentMethod}:${couponCodeNorm}`;
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ planId, paymentMethod, couponCode: couponCodeNorm })).digest('hex');
        const idemPath = path.join(dataDir, 'license', 'purchase-idempotency.json');
        const idemStore = readJSON(idemPath) || { records: [] };
        const prev = idemStore.records.find((r) => r.storeKey === userKey);
        if (prev) {
          if (prev.fingerprint !== fingerprint) {
            return send(res, 409, envelope(false, { reason: '同幂等键但购买参数不同' }, 'IDEMPOTENCY_CONFLICT', requestId));
          }
          // 复查 P1（第五轮）：pending 记录无 body/status，读 prev.body.ok 会 500 → 单独处理
          if (prev.result === 'pending') {
            return send(res, 409, envelope(false, { reason: '该购买请求结果未确认（在途或超时），请稍后在会员状态页确认' }, 'PURCHASE_PENDING', requestId));
          }
          if (prev.result === 'success') {
            // 回放数据结构与首次成功一致（data = 订单对象，不多嵌一层）
            return send(res, prev.status || 200, envelope(true, prev.body ? prev.body.data : null, null, requestId));
          }
          // 显式失败记录：清除后走新流程（可重试）
          idemStore.records = idemStore.records.filter((x) => x !== prev);
        }
        // 不确定结果窗口（复查 P1 第四轮）：同一 user+plan+支付方式 在窗口内已有未决请求
        //（在途或超时未确认）→ 拒绝新订单，提示查会员状态，杜绝"响应丢失后换 key 重试"重复下单。
        // 确定性失败不留痕（可立即重试）；成功记录窗口内直接回放。
        // R7-1（复核 P1）：10 分钟 TTL **只适用于普通在途**。"渠道结果未知"锁
        //（unknownOutcome，微信侧可能已建单但响应丢失）没有确认期限——TTL 一到换键重试
        // 就会重新 subscribe（新 orderId → kaypal 兜底幂等键也变）建出第二张可扫的码。
        // 正确策略：持续锁定，直到查单/锁单重放证实渠道单 CLOSED/FAILED（放行重建）
        // 或已收款（收敛为成功）——绝不能仅靠 TTL 自动放行。
        const pendingMs = Number(process.env.JZ_PURCHASE_PENDING_MS) || 10 * 60 * 1000;
        const bizPrev = idemStore.records.find(
          (r) => r.bizKey === bizKey && (r.unknownOutcome || Date.now() - new Date(r.at).getTime() < pendingMs)
        );
        if (bizPrev) {
          if (bizPrev.result === 'success') {
            // 复查 P1（第五轮）：回放结构与首次成功一致
            return send(res, bizPrev.status || 200, envelope(true, bizPrev.body ? bizPrev.body.data : null, null, requestId));
          }
          // R7-1：结果未知锁 → 先"锁单重放"探测真实结果。重放对**同一笔订阅单**调
          // payment/create（kaypal 兜底键必命中旧 PaymentOrder）：有凭证原样重放、
          // PENDING 无凭证同单号重挂、渠道确认终结才让位重建——不存在"放行第二张码"。
          if (bizPrev.result === 'pending' && bizPrev.unknownOutcome && bizPrev.orderId && bizPrev.amountFen) {
            // 探测也要过在途锁：并发双击同时探测时，"渠道终结→让位→重建"窗口内
            // 双方可能各拿一个结果互相覆盖（kaypal 兜底幂等是最后防线，本地锁先挡住）。
            if (purchaseInFlight.has(bizKey)) {
              return send(res, 409, envelope(false, { by: 'purchase_in_flight' }, 'OPERATION_RUNNING', requestId));
            }
            purchaseInFlight.add(bizKey);
            let re = null;
            let probeErr = null;
            try {
              re = await kaypalPay.reattachWechatPayment({
                orderId: bizPrev.orderId,
                amountFen: bizPrev.amountFen,
                subject: 'JIUZHANG AI 管家会员',
                root: dataDir,
                _httpsJson: kHttp,
              });
            } catch (e) {
              probeErr = e;
            } finally {
              purchaseInFlight.delete(bizKey);
            }
            if (probeErr || !re) {
              // 探测自身异常 = 依然无法证实，保守锁继续
              return send(res, 409, envelope(false, {
                reason: '上一笔购买结果未确认，自动查单暂不可用；为防重复扣款已持续锁定，请稍后重试本操作',
                since: bizPrev.at,
              }, 'PURCHASE_PENDING', requestId));
            }
            if (re.ok) {
              const data = {
                orderId: bizPrev.orderId,
                orderNo: re.orderNo,
                codeUrl: re.codeUrl,
                amountFen: re.amountFen,
                priceYuan: bizPrev.priceYuan ?? (re.amountFen / 100),
                paymentMethod,
                status: 'pending',
              };
              bizPrev.result = 'success';
              bizPrev.unknownOutcome = false;
              bizPrev.status = 200;
              bizPrev.body = { ok: true, data };
              bizPrev.storeKey = userKey;
              bizPrev.fingerprint = fingerprint;
              try { atomicWriteJSON(idemPath, idemStore); } catch (e) { /* 写盘失败不翻支付结果，仅降级日志 */ }
              return send(res, 200, envelope(true, data, null, requestId));
            }
            if (re.error === 'PAY_UNAVAILABLE') {
              // 仍无法证实（查单/重放又超时，或渠道明确说结果未知）→ 锁继续，明确不承诺自动放行
              return send(res, 409, envelope(false, {
                reason: '上一笔购买结果未确认，已持续锁定至渠道查单证实（不会自动放行以免重复扣款）；可稍后重试本操作自动查单',
                orderNo: re.orderNo || bizPrev.orderNo || null,
                since: bizPrev.at,
              }, 'PURCHASE_PENDING', requestId));
            }
            if (re.error === 'SESSION_EXPIRED' || re.error === 'NOT_LOGGED_IN') {
              return send(res, 401, envelope(false, { detail: '会话失效，请重新登录' }, 'UNAUTHENTICATED', requestId));
            }
            // 确定性失败（渠道单确认不存在/被拒/已终结后重下失败）→ 解除未知锁，放行走正常新购
            idemStore.records = idemStore.records.filter((x) => x !== bizPrev);
            try { atomicWriteJSON(idemPath, idemStore); } catch (e) { /* 清锁写盘失败：下次仍会重试探测，保守可接受 */ }
          } else if (bizPrev.result === 'pending') {
            return send(res, 409, envelope(false, {
              reason: bizPrev.unknownOutcome
                ? '上一笔同套餐购买结果未确认，为防重复下单已拦截；本次未能自动查单（缺少单号），请到会员状态页确认'
                : '上一笔同套餐购买请求结果未确认（在途或超时），为防重复下单已拦截；请稍后在会员状态页确认，10 分钟后可重试',
              since: bizPrev.at,
            }, 'PURCHASE_PENDING', requestId));
          } else {
            return send(res, 409, envelope(false, {
              reason: '上一笔同套餐购买请求结果未确认（在途或超时），为防重复下单已拦截；请稍后在会员状态页确认，10 分钟后可重试',
              since: bizPrev.at,
            }, 'PURCHASE_PENDING', requestId));
          }
        }
        // 在途并发锁：同 user+plan+支付方式 同一时刻最多一个订阅请求进 kaypal
        if (purchaseInFlight.has(bizKey)) {
          return send(res, 409, envelope(false, { by: 'purchase_in_flight' }, 'OPERATION_RUNNING', requestId));
        }
        purchaseInFlight.add(bizKey);
        // 请求发出前先落 pending 痕迹（复查 P1：超时/响应丢失后，同 bizKey 的任何重试都会被窗口拦截）。
        // 复查 P1（第五轮）：写盘失败必须释放并发锁并返回结构化错误，绝不能锁死套餐。
        try {
          idemStore.records.push({
            storeKey: userKey,
            bizKey,
            fingerprint,
            result: 'pending',
            at: new Date().toISOString(),
          });
          if (idemStore.records.length > 200) idemStore.records = idemStore.records.slice(-200);
          atomicWriteJSON(idemPath, idemStore);
        } catch (e) {
          purchaseInFlight.delete(bizKey);
          return send(res, 507, envelope(false, { detail: `幂等记录写盘失败：${e.message}` }, 'IDEMPOTENCY_PERSIST_FAILED', requestId));
        }
        try {
          // Task#11（2026-09-01）：微信 native 全链——subscribe(订阅单) → payment/create(微信单) → codeUrl。
          // 幂等语义升级：业务成功 = 拿到微信支付单（待扫码），不是支付完成；支付状态由 /api/license/pay/query 轮询。
          // buyPlanWechat 内部 fail-closed 全捕获（不抛错），超时/网络失败同样返回 ok:false。
          const r = await kaypalPay.buyPlanWechat({ planId, couponCode: couponCodeNorm || undefined, subject: 'JIUZHANG AI 管家会员', root: dataDir, _httpsJson: kHttp });
          if (r.ok) {
            const data = {
              orderId: r.orderId,
              orderNo: r.orderNo,
              codeUrl: r.codeUrl,
              amountFen: r.amountFen,
              priceYuan: r.priceYuan,
              paymentMethod,
              status: 'pending',
            };
            // pending → success（持久化，窗口内同套餐回放；回放 data 与首次一致 = 同一微信支付单）
            const rec = idemStore.records.find((x) => x.storeKey === userKey && x.bizKey === bizKey && x.result === 'pending');
            if (rec) { rec.result = 'success'; rec.status = 200; rec.body = { ok: true, data }; }
            else { idemStore.records.push({ storeKey: userKey, bizKey, fingerprint, result: 'success', status: 200, body: { ok: true, data }, at: new Date().toISOString() }); }
            if (idemStore.records.length > 200) idemStore.records = idemStore.records.slice(-200);
            // 2026-08-29 复核 P1：reportError 是同步函数（返回对象，无 .catch），必须 try/catch 包裹，
            // 否则"支付已成功但幂等写盘失败"时抛 TypeError 被外层 catch 吞成 502 SUBSCRIPTION_UNAVAILABLE（支付假失败）。
            try {
              atomicWriteJSON(idemPath, idemStore);
            } catch (e) {
              try { reportError({ requestId, url: p, status: 200, message: `purchase success 记录写盘失败: ${e.message}` }); }
              catch (reportErr) { console.error(`[jz-api] purchase 上报失败: ${reportErr && reportErr.message}`); }
            }
            return send(res, 200, envelope(true, data, null, requestId));
          }
          // Codex 复核 P1 修复：PAY_UNAVAILABLE（超时/网络异常）= 结果不确定——远端可能已建单。
          // 原实现把所有 ok:false 都当确定性失败清除 pending 痕迹，"远端已建单 + 本地超时"后
          // 换幂等键重试会重复下单。不确定失败必须保留 pending。
          // R7-1（复核 P1）：r.unknownOutcome（微信建单结果未知）额外持久化 orderId/amountFen
          // 并打上 unknownOutcome 标记——该锁**不过 TTL**，换键重试会触发锁单重放探测
          //（对同一笔订阅单重放 payment/create，绝不换单），直到渠道证实终结或收款。
          if (r.error === 'PAY_UNAVAILABLE') {
            if (r.unknownOutcome) {
              const lock = idemStore.records.find((x) => x.storeKey === userKey && x.bizKey === bizKey && x.result === 'pending');
              if (lock) {
                lock.unknownOutcome = true;
                lock.orderId = r.orderId || null;
                lock.orderNo = r.orderNo || null;
                lock.amountFen = r.amountFen || null;
              }
              try { atomicWriteJSON(idemPath, idemStore); } catch (e) { /* 锁字段写盘失败：内存 pending 仍在，进程内保护不丢 */ }
            }
            // 复核（微信专项 P1）：带上 kaypal 回传的 orderNo——UI 可以拿它直接查单确认真实结果。
            return send(res, 502, envelope(false, {
              detail: r.unknownOutcome
                ? '购买请求结果未确认（微信侧可能已建单），系统已锁定该笔购买直至查单证实，重试将自动查单'
                : '购买请求结果未确认（网络超时），已进入防重复下单保护窗口',
              orderNo: r.orderNo || null,
              orderId: r.orderId || null,
              locked: !!r.unknownOutcome,
            }, 'SUBSCRIPTION_UNAVAILABLE', requestId));
          }
          // 确定性失败：移除 pending 痕迹（可立即重试）
          idemStore.records = idemStore.records.filter((x) => !(x.storeKey === userKey && x.bizKey === bizKey && x.result === 'pending'));
          try {
            atomicWriteJSON(idemPath, idemStore);
          } catch (e) {
            try { reportError({ requestId, url: p, status: 502, message: `purchase 失败记录清理写盘失败: ${e.message}` }); }
            catch (reportErr) { console.error(`[jz-api] purchase 上报失败: ${reportErr && reportErr.message}`); }
          }
          const unauth = r.needLogin || r.error === 'NOT_LOGGED_IN' || r.error === 'SESSION_EXPIRED';
          return send(
            res,
            unauth ? 401 : 502,
            envelope(
              false,
              { detail: r.detail || r.error || '支付单创建失败' },
              unauth ? 'UNAUTHENTICATED' : (r.error === 'SUBSCRIBE_FAILED' || r.error === 'CREATE_PAYMENT_FAILED' ? 'SUBSCRIPTION_FAILED' : 'SUBSCRIPTION_UNAVAILABLE'),
              requestId,
            ),
          );
        } catch (e) {
          // 超时/网络异常 = 结果不确定：保留 pending 痕迹，窗口内同套餐重试一律 409 PURCHASE_PENDING
          return send(res, 502, envelope(false, {
            detail: '购买请求结果未确认（网络超时），已进入防重复下单保护窗口',
          }, 'SUBSCRIPTION_UNAVAILABLE', requestId));
        } finally {
          purchaseInFlight.delete(bizKey);
        }
      }
      if (method === 'GET' && p === '/api/license/pay/query') {
        // 微信支付单状态单次查询（Task#11 2026-09-01，UI 3s 自驱轮询）：
        // 走 kaypal-pay.queryWechatPayment（Cookie 会话，kaypal /api/payment/query 实测必须带 Cookie）。
        // 返回 { status: paid|pending|closed, thirdTradeNo, payerId }；订单不可见视同 pending（继续轮询）。
        const orderNo = String(u.searchParams.get('orderNo') || '').trim();
        if (!orderNo || orderNo.length > 64) return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
        const r = await kaypalPay.queryWechatPayment({ orderNo, root: dataDir, _httpsJson: kHttp });
        if (!r.ok) {
          const status = r.needLogin || r.error === 'NOT_LOGGED_IN' ? 401 : 502;
          return send(res, status, envelope(false, { detail: r.detail || r.error }, r.error || 'PAY_QUERY_FAILED', requestId));
        }
        return send(res, 200, envelope(true, { orderNo, status: r.status, thirdTradeNo: r.thirdTradeNo, payerId: r.payerId }, null, requestId));
      }
      if (method === 'GET' && p === '/api/license/coupon/share') {
        // 分享券（Codex 复核第二轮功能缺口闭环）：查/建我的分享链接 → kaypal referral/coupon（POST，getOrCreate）。
        // 鉴权：desktop-auth kda Bearer（kaypal-coupon 内部 currentAccessToken），未登录 401 fail-closed。
        const r = await getShareLink({ root: dataDir, _httpsJson: kHttp });
        if (!r.ok) {
          const status = r.error === 'UNAUTHENTICATED' ? 401 : 502;
          return send(res, status, envelope(false, { detail: r.detail || r.error }, r.error, requestId));
        }
        return send(res, 200, envelope(true, { share: r.share }, null, requestId));
      }
      if (method === 'GET' && p === '/api/license/coupon/invite-count') {
        // 邀请计数（推荐人奖励·算力券先计数）：转发 kaypal referral/mine。
        // 未登录 401 fail-closed；失败给 502，不放假计数。
        const r = await getInviteCount({ root: dataDir, _httpsJson: kHttp });
        if (!r.ok) {
          const status = r.error === 'UNAUTHENTICATED' ? 401 : 502;
          return send(res, status, envelope(false, { detail: r.detail || r.error }, r.error, requestId));
        }
        return send(res, 200, envelope(true, { count: r.count, referrals: r.referrals }, null, requestId));
      }
      if (method === 'POST' && p === '/api/license/coupon/claim') {
        // 分享券：凭分享码领券。shareCode 必填（1-64 位）；幂等键可选透传（Idempotency-Key 头防重试重复领）。
        const shareCode = String((body && body.shareCode) || '').trim();
        if (!shareCode || shareCode.length > 64) return send(res, 400, envelope(false, null, 'INVALID_REQUEST', requestId));
        const idempotencyKey = body && body.idempotencyKey ? String(body.idempotencyKey).slice(0, 128) : undefined;
        const r = await claimShare({ shareCode, idempotencyKey, root: dataDir, _httpsJson: kHttp });
        if (!r.ok) {
          const status = r.error === 'UNAUTHENTICATED' ? 401 : r.error === 'INVALID_REQUEST' ? 400 : 502;
          return send(res, status, envelope(false, { detail: r.detail || r.error }, r.error, requestId));
        }
        return send(res, 200, envelope(true, r.data || { claimed: true }, null, requestId));
      }
      if (method === 'POST' && p === '/api/diagnostics/preview') {
        const r = diagPreview({ root: dataDir });
        // 复查 P1（第四轮）：preview 返回 previewId + expiresAt，upload 必须绑定
        return send(res, r.ok ? 200 : 422, envelope(r.ok, r.ok ? { preview: r.preview, previewId: r.previewId, expiresAt: r.expiresAt } : null, r.ok ? null : r.error || 'PREVIEW_FAILED', requestId));
      }
      if (method === 'POST' && p === '/api/diagnostics/upload') {
        // 真实状态：已上传/服务端拒绝/离线待发/未配置/预览无效——不假成功（ok 由返回值决定）。
        // 复查 P2（第四轮）：可选幂等 —— 同键重放返回首次上传结果
        const idem = optIdem('diagnostics:upload');
        if (idem === true) return;
        const op = beginOperation({ root: dataDir, type: 'diagnostics-upload', label: '诊断包上传', total: 1 });
        const r = await diagUpload({ previewId: body.previewId, root: dataDir });
        if (r.ok) completeOperation({ root: dataDir, operationId: op.operationId, status: 'succeeded', evidence: [{ source: 'diagnostics', summary: `ticket ${r.ticketId}`, observedAt: new Date().toISOString() }] });
        else failOperation({ root: dataDir, operationId: op.operationId, errorCode: r.error || 'DIAGNOSTICS_UPLOAD_FAILED', detail: r.detail });
        const status = r.ok ? 200 : 422;
        optIdemSave(idem, status, r.ok, r.ok ? { ticketId: r.ticketId, status: r.status, operationId: op.operationId } : null, r.ok ? null : r.error);
        return send(res, status, envelope(r.ok, r.ok ? { ticketId: r.ticketId, status: r.status, operationId: op.operationId } : null, r.ok ? null : r.error, requestId));
      }
      if (method === 'POST' && p === '/api/privacy/scan') {
        // 隐私盾：发送前扫描敏感信息（05 §4.1 scanOnExplicitSend）。纯本地正则，不落盘原文。
        const r = privacyScan(body.text);
        return send(res, r.ok ? 200 : 400, envelope(r.ok, r.ok ? { sensitive: r.sensitive, blocked: r.blocked } : null, r.ok ? null : 'INVALID_REQUEST', requestId));
      }

      // 本地券体系已删除（2026-08-31 产品负责人决策：无历史用户，kaypal 订单折扣券走 /api/coupon/kaypal/*）。
      // 自铸权益防线（P0，2026-08-29 复核）保持：无任何本地铸券/兑券 HTTP 入口。

      // OIDC 登录（kaypal authorization_code + PKCE）
      if (method === 'POST' && p === '/api/oidc/login') {
        const { verifier, challenge } = oidc.generatePkce();
        const state = uuid();
        oidcStates.set(state, { verifier, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 分钟有效
        const authorizeUrl = oidc.buildAuthorizeUrl({ challenge, state });
        return send(res, 200, envelope(true, { authorizeUrl, state }, null, requestId));
      }
      if (method === 'GET' && p === '/api/oidc/callback') {
        const code = String(u.searchParams.get('code') || '');
        const state = String(u.searchParams.get('state') || '');
        const rec = oidcStates.get(state);
        if (!rec || !code) {
          return sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><title>登录失败</title><body style="font:14px system-ui;padding:32px"><h3>登录失败</h3><p>授权状态无效或已过期，请重新发起登录。</p></body>');
        }
        if (rec.expiresAt < Date.now()) {
          oidcStates.delete(state);
          return sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><title>登录失败</title><body style="font:14px system-ui;padding:32px"><h3>登录失败</h3><p>授权已过期，请重新发起登录。</p></body>');
        }
        oidcStates.delete(state); // 单次使用
        const tok = await oidc.exchangeToken({ code, verifier: rec.verifier });
        if (!tok.ok) {
          console.error(`[oidc] exchangeToken failed: ${tok.error} ${tok.detail}`);
          return sendHtml(res, 502, '<!doctype html><meta charset="utf-8"><title>登录失败</title><body style="font:14px system-ui;padding:32px"><h3>登录失败</h3><p>换取令牌失败，请重试。</p></body>');
        }
        const ui = await oidc.getUserInfo(tok.accessToken);
        const auth = {
          accessToken: tok.accessToken,
          refreshToken: tok.refreshToken,
          user: ui.ok ? ui.user : null,
          loggedInAt: new Date().toISOString(),
        };
        oidc.saveAuth(dataDir, auth);
        return sendHtml(res, 200, '<!doctype html><meta charset="utf-8"><title>登录成功</title><body style="font:14px system-ui;padding:32px"><h3>登录成功</h3><p>JIUZHANG AI 管家已登录 Kaypal 账号，可关闭此页面。</p></body>');
      }
      if (method === 'GET' && p === '/api/oidc/status') {
        const auth = oidc.loadAuth(dataDir);
        return send(res, 200, envelope(true, { loggedIn: !!(auth && auth.user), user: auth ? auth.user : null }, null, requestId));
      }

      // 设置（05 §4.1 Settings：UI 状态读写；自动备份调度属后续任务）
      if (method === 'GET' && p === '/api/settings/ui-state') {
        const st = loadSettings(dataDir);
        return send(res, 200, envelope(true, {
          locale: st.locale,
          theme: st.theme,
          selectedProfile: st.selectedProfile,
          autoBackupEnabled: !!(st.autoBackup && st.autoBackup.enabled),
          autoBackupFrequency: (st.autoBackup && st.autoBackup.frequency) || 'daily',
          autoBackupRetention: (st.autoBackup && Number(st.autoBackup.retention)) || 3,
          privacyScan: !!(st.privacy && st.privacy.scanOnExplicitSend),
          telemetry: !!(st.telemetry && st.telemetry.enabled),
          fabCharacter: (st.fab && st.fab.character) || 'blob',
          fabSketch: !!(st.fab && st.fab.sketch),
        }, null, requestId));
      }
      if (method === 'POST' && p === '/api/settings/ui-state') {
        const cur = loadSettings(dataDir);
        let autoBackupChanged = false;
        if (body.autoBackupEnabled !== undefined) {
          cur.autoBackup = Object.assign({}, cur.autoBackup, { enabled: !!body.autoBackupEnabled });
          autoBackupChanged = true;
        }
        // 复查 P2（第五轮/04-D）：frequency 支持 daily|weekly|before-update（05 schema 已声明）
        if (['daily', 'weekly', 'before-update'].includes(body.autoBackupFrequency)) {
          cur.autoBackup = Object.assign({}, cur.autoBackup, { frequency: body.autoBackupFrequency });
          autoBackupChanged = true;
        }
        if (body.autoBackupRetention !== undefined) {
          const n = Number(body.autoBackupRetention);
          if (Number.isInteger(n) && n >= 1 && n <= 20) {
            cur.autoBackup = Object.assign({}, cur.autoBackup, { retention: n });
            autoBackupChanged = true;
          }
        }
        if (body.privacyScan !== undefined) {
          cur.privacy = Object.assign({}, cur.privacy, { scanOnExplicitSend: !!body.privacyScan });
        }
        if (body.telemetry !== undefined) {
          cur.telemetry = { enabled: !!body.telemetry };
        }
        if (body.theme) cur.theme = String(body.theme);
        // 挂件形象（2026-09-04 产品负责人：换形象 + 线稿，设置页切换）：character 白名单校验，非法值静默忽略
        if (body.fabCharacter !== undefined) {
          if (['blob', 'nimbo', 'twinkle'].includes(body.fabCharacter)) {
            cur.fab = Object.assign({}, cur.fab, { character: body.fabCharacter });
          }
        }
        if (body.fabSketch !== undefined) {
          cur.fab = Object.assign({}, cur.fab, { sketch: !!body.fabSketch });
        }
        saveSettings(dataDir, cur);
        // 复查 P1（第四轮）：自动备份设置变更 → 立即重排调度器（无需重启 daemon）
        if (autoBackupChanged && hooks && typeof hooks['reload-auto-backup'] === 'function') {
          try { hooks['reload-auto-backup'](); } catch { /* 重排失败不影响设置保存 */ }
        }
        return send(res, 200, envelope(true, { saved: true }, null, requestId));
      }

      return send(res, 404, envelope(false, null, 'WB_NOT_FOUND', requestId));
    } catch (err) {
      // 500 级错误自动上报 OSS error-reports/（fire-and-forget，失败静默，不影响响应）
      reportError({
        requestId,
        method,
        url: p,
        status: 500,
        message: (err && err.message) || 'internal',
        stack: err && err.stack,
      });
      return send(res, 500, envelope(false, null, 'INTERNAL_REDACTED', requestId));
    }
  }

  // V1.1 usage 埋点：所有 jz 请求记录 method/pathname/status/耗时（本地运行证据，§5.3-6）。
  // 不记录 query/body/header（不落敏感值）；路径保留资产 ID 供吃灰预警关联。
  const origHandle = handle;
  handle = async function (req, res) {
    const t0 = Date.now();
    try {
      return await origHandle(req, res);
    } finally {
      let pathname = '/';
      try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* ignore */ }
      recordUsage({ method: req.method, pathname, status: res.statusCode, durationMs: Date.now() - t0, requestId: res.__jzRequestId, root: dataDir });
    }
  };

  return { handle, token, dataDir, confirmStore, sessionStore, previewStore, MAX_BODY_BYTES };
}

module.exports = { createRouter, MAX_BODY_BYTES };
