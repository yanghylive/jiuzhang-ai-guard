'use strict';
// 本机微信一键登录（2026-09-04 产品负责人拍板「一步到位」，规格见
// docs/kaypal底座-设备密钥登录接口规格-v1-20260904.md）。
//
// 架构原则：**账号逻辑全部挂 kaypal 统一用户体系，本模块不自建任何账号**——
// 只做三件事：①识别本机微信身份（Windows 复用 3010 wechat-db-helper 套件 /
// Mac 目录级探测）；②设备 ed25519 密钥对管理；③底座 5 接口编排
// （bind-intent → 授权页确认 → bound → challenge → 签名 verify → 标准登录产物）。
//
// 安全模型（规格 §0）：底座从不信任明文 wxid（哈希落库，明文用后即弃）；
// 信任锚 = 绑定时刻用户在手机授权页亲手确认 + 之后仅持私钥的设备可验签。
// 私钥落盘 license/wechat-device-key.json（0600，同现有凭据纪律）。

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { dataRoot, atomicWriteJSONPrivate, readFileNoSymlink, isTrustedKaypalUrl } = require('./lib');
const { httpsJson } = require('./kaypal-license');

// ===== 底座端点 =====
// 生产：kaypal 统一域（与 desktop-auth 同源）。P1 联调可用 JZ_WECHAT_LOCAL_MOCK
// 指向 mock 底座（http://127.0.0.1:PORT）验证 daemon→前端全链，mock 需显式开启。
function baseOverride() {
  const mock = String(process.env.JZ_WECHAT_LOCAL_MOCK || '').trim();
  // Mock routing is deliberately test-only and loopback-only. A stray
  // production environment variable must never redirect auth to an arbitrary host.
  if (!mock || process.env.NODE_ENV !== 'test') return '';
  try {
    const u = new URL(mock);
    if (u.protocol !== 'http:') return '';
    if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) return '';
  } catch {
    return '';
  }
  return mock;
}

async function basePost(apiPath, body) {
  const mock = baseOverride();
  if (mock) {
    // mock 底座走 http（本地回环），仅联调用
    const http = require('node:http');
    const u = new URL(mock.replace(/\/$/, '') + apiPath);
    const bodyStr = JSON.stringify(body || {});
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', timeout: 8000,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) } },
        (res) => {
          let d = '';
          res.on('data', (c) => { d += c; });
          res.on('end', () => {
            let j = null;
            try { j = JSON.parse(d); } catch { /* 非 JSON 视为坏响应 */ }
            resolve({ status: res.statusCode, body: j });
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.write(bodyStr);
      req.end();
    });
  }
  return httpsJson('POST', apiPath, body || {});
}

async function baseGet(apiPath) {
  const mock = baseOverride();
  if (mock) {
    const http = require('node:http');
    const u = new URL(mock.replace(/\/$/, '') + apiPath);
    return new Promise((resolve, reject) => {
      http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 8000 }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(d); } catch { /* ignore */ }
          resolve({ status: res.statusCode, body: j });
        });
      }).on('error', reject);
    });
  }
  return httpsJson('GET', apiPath, null);
}

// ===== 设备密钥对（ed25519）=====

function keypairPath(root) {
  return path.join(root || dataRoot(), 'license', 'wechat-device-key.json');
}

function publicKeyBytes(publicKey) {
  const key = publicKey && publicKey.type === 'public'
    ? publicKey
    : crypto.createPublicKey(publicKey);
  const der = key.export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI is a 12-byte algorithm prefix followed by the 32-byte key.
  if (der.length !== 44) throw new Error('invalid-ed25519-public-key');
  return der.subarray(der.length - 32);
}

// 线上契约（kaypal decodeDevicePubkey，93e26a49 起未变过）：base64(PEM 文本)。
// 2026-09-05 生产 smoke 实锤：发 base64(裸 32B) 服务端 BAD_PUBKEY，
// intent/challenge 第一步即断——本函数此前发错格式且单测固化了错误断言。
function devicePublicKeyB64(publicKey) {
  const pem = publicKey && publicKey.type === 'public'
    ? publicKey.export({ type: 'spki', format: 'pem' }).toString('utf8')
    : String(publicKey); // keypair 落盘形态本就是 PEM 字符串
  return Buffer.from(pem, 'utf8').toString('base64');
}

function readJSONNoSymlink(p) {
  try {
    return JSON.parse(readFileNoSymlink(p).toString('utf8'));
  } catch (e) {
    if (e && e.code === 'ESYMLINK') throw e;
    return null;
  }
}

function ensureKeypairPrivateMode(p) {
  if (process.platform === 'win32') return;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw Object.assign(new Error(`拒绝使用非常规密钥文件: ${p}`), { code: 'ESYMLINK' });
  }
  if ((st.mode & 0o777) !== 0o600) fs.chmodSync(p, 0o600);
}

// 生成一次、持久化复用。私钥 0600 落盘（atomicWriteJSONPrivate），不进日志。
function ensureDeviceKeypair(root) {
  root = root || dataRoot();
  // readFileNoSymlink 纪律同 device-flow.json：短期认证凭据禁符号链接
  let existing = null;
  try {
    existing = JSON.parse(readFileNoSymlink(keypairPath(root)).toString('utf8'));
  } catch (e) {
    if (e && e.code === 'ESYMLINK') throw e;
    existing = null;
  }
  if (existing && existing.publicKey && existing.privateKey) {
    try {
      const storedPublic = publicKeyBytes(existing.publicKey);
      const derivedPublic = publicKeyBytes(crypto.createPublicKey(crypto.createPrivateKey(existing.privateKey)));
      if (storedPublic.length !== derivedPublic.length || !crypto.timingSafeEqual(storedPublic, derivedPublic)) {
        throw new Error('device-key-mismatch');
      }
    } catch (e) {
      existing = null; // 损坏/不匹配 → 重生成（旧绑定自然返回 NO_BINDING）
    }
    if (existing) {
      // 权限修复是独立的安全前置条件；失败必须向上抛出，不能误判成密钥损坏
      // 并静默重生成，否则会让已有设备绑定失效。
      ensureKeypairPrivateMode(keypairPath(root));
      return existing;
    }
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pair = {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    createdAt: new Date().toISOString(),
  };
  atomicWriteJSONPrivate(keypairPath(root), pair);
  return pair;
}

function signChallenge(challengeB64, keypair) {
  const kp = keypair || ensureDeviceKeypair();
  const sig = crypto.sign(null, Buffer.from(String(challengeB64), 'base64'), crypto.createPrivateKey(kp.privateKey));
  return sig.toString('base64');
}

// ===== 本机微信识别 =====
// 统一产物：{ supported, detected, wxid, nickname, confidence: 'high'|'low', source }
// Windows：复用 3010 wechat-db-helper（kaypal-wechat-db-helper/v1 契约，contacts 命令）。
//   helper 读取 user_info/Contact 表（含当前登录用户 user_info），roots 顶层 wxid 目录交叉验证。
//   helper 缺失（未随包/非 Windows 构建）→ supported:false；调用方可再做目录级低置信兜底。
// Mac：目录级探测（xwechat_files / WeChat 顶层 wxid 目录），confidence:'low'（P2 解密 PoC 前不给昵称）。

const IDENT_CACHE_TTL_MS = 5 * 60 * 1000;
let identCache = { at: 0, result: null };

function helperEntryPath() {
  // 与 3010 打包惯例一致：resources/wechat-db-helper/wechat-db-helper.js；
  // dev 可用 JZ_WECHAT_DB_HELPER 显式指定。
  const env = String(process.env.JZ_WECHAT_DB_HELPER || '').trim();
  if (env) return env;
  return path.join(path.dirname(__dirname), '..', 'resources', 'wechat-db-helper', 'wechat-db-helper.js');
}

// 从候选目录列表收集「顶层 wxid 目录」（目录名 wxid_ 开头，或纯字母数字且非系统名）。
function scanWxidDirs(rootDirs, maxDepth = 1) {
  const found = [];
  for (const dir of rootDirs || []) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (/^wxid_[a-z0-9]+$/i.test(e.name) || /^[a-z][a-z0-9_]{5,}$/i.test(e.name)) {
          if (/^(all_users|appbrand|config|backup|cache|logs|flile|file)$/i.test(e.name)) continue;
          const full = path.join(dir, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
          found.push({ wxid: e.name, mtime, dir: full });
        }
      }
    } catch {
      // 权限/不存在：best-effort
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

// Directory probing is only a safe identity signal when it yields exactly one
// distinct account. Multiple directories are historical accounts, not proof of
// the currently active one.
function dirScanIdentity(dirs, source) {
  const seen = new Set();
  const unique = [];
  for (const entry of dirs || []) {
    const wxid = String(entry && entry.wxid || '');
    const key = wxid.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...entry, wxid });
  }
  if (unique.length === 0) return { supported: true, detected: false, reason: 'no-wxid-dir' };
  if (unique.length !== 1) {
    return { supported: true, detected: false, reason: 'multiple-wxid-dirs', confidence: 'low', source: source || 'dir-scan' };
  }
  return {
    supported: true,
    detected: true,
    wxid: unique[0].wxid,
    nickname: '',
    confidence: 'low',
    source: source || 'dir-scan',
  };
}

function macWechatRoots() {
  // E2E may provide an isolated root. Keep this override test-only so a
  // production environment variable cannot redirect identity detection.
  const override = String(process.env.JZ_WECHAT_ROOTS || '').trim();
  if (process.env.NODE_ENV === 'test' && override) {
    return override.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  }
  const home = os.homedir();
  return [
    path.join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files'),
    path.join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'WeChat Files'),
  ];
}

async function detectViaHelper(rootDirs) {
  const entry = helperEntryPath();
  if (!fs.existsSync(entry)) {
    return { supported: false, reason: 'helper-not-packaged' };
  }
  // kaypal-wechat-db-helper/v1 contacts 契约：stdin JSON → stdout 单 JSON 对象
  const stdinPayload = JSON.stringify({
    contractVersion: 'kaypal-wechat-db-helper/v1',
    mode: 'all',
    dbPaths: [],
    roots: rootDirs || [],
    limits: { allLimit: 50 },
  });
  const { spawnSync } = require('node:child_process');
  let r;
  try {
    r = spawnSync(process.execPath, [entry, 'contacts', '--contract', 'kaypal-wechat-db-helper/v1'], {
      input: stdinPayload,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
  } catch (e) {
    return { supported: true, detected: false, reason: String((e && e.message) || e) };
  }
  if (!r || r.status !== 0 || !r.stdout) {
    return { supported: true, detected: false, reason: 'helper-exit-' + (r ? r.status : 'null') };
  }
  let out = null;
  try {
    // helper 契约：stdout 恰好一个 JSON 对象
    out = JSON.parse(String(r.stdout).trim().split('\n').filter(Boolean).pop());
  } catch {
    return { supported: true, detected: false, reason: 'helper-bad-json' };
  }
  if (!out || out.ok !== true || !Array.isArray(out.items) || !out.items.length) {
    return { supported: true, detected: false, reason: (out && out.status) || 'no-items' };
  }
  // 当前登录用户：user_info 表即「本机当前登录用户」——helper 的 items 不带表名，
  // 用 roots 顶层最近活跃 wxid 目录与 items 的 wxid 求交集（命中即高置信）。
  const recent = scanWxidDirs(rootDirs).map((d) => d.wxid.toLowerCase());
  const byWxid = new Map(out.items.map((it) => [String(it.wxid || '').toLowerCase(), it]));
  const matches = [];
  const seenMatches = new Set();
  for (const w of recent) {
    if (!byWxid.has(w) || seenMatches.has(w)) continue;
    seenMatches.add(w);
    matches.push(byWxid.get(w));
  }
  // Never select an arbitrary helper row: without a directory correlation the
  // result could log in a different account. Multiple matches are ambiguous too.
  if (matches.length !== 1) {
    return {
      supported: true,
      detected: false,
      reason: matches.length ? 'multiple-identity-matches' : 'identity-not-correlated',
      confidence: 'low',
      source: 'wechat-db-helper',
    };
  }
  const hit = matches[0];
  return {
    supported: true,
    detected: true,
    wxid: String(hit.wxid || ''),
    nickname: String(hit.nickname || hit.remark || ''),
    confidence: 'high',
    source: 'wechat-db-helper',
  };
}

async function detectLocalWeChat({ refresh } = {}) {
  if (!refresh && identCache.result && Date.now() - identCache.at < IDENT_CACHE_TTL_MS) {
    return identCache.result;
  }
  let result;
  if (process.platform === 'win32') {
    const rootDirs = [
      path.join(process.env.USERPROFILE || '', 'Documents', 'WeChat Files'),
      path.join(process.env.USERPROFILE || '', 'Documents', 'xwechat_files'),
    ];
    try {
      const viaHelper = await detectViaHelper(rootDirs);
      if (viaHelper.supported) {
        result = viaHelper;
      } else {
        // helper 未随包：目录级低置信兜底；多账号目录由 dirScanIdentity 保守拒绝
        result = dirScanIdentity(scanWxidDirs(rootDirs));
      }
    } catch (e) {
      result = { supported: true, detected: false, reason: String((e && e.message) || e) };
    }
  } else if (process.platform === 'darwin') {
    // Mac：P2 解密 PoC 前仅目录级探测（confidence low）；wxid 即目录名
    result = dirScanIdentity(scanWxidDirs(macWechatRoots()));
  } else {
    result = { supported: false, detected: false, reason: 'platform-unsupported' };
  }
  identCache = { at: Date.now(), result };
  return result;
}

// ===== 绑定编排（底座 ①②③）=====

function intentPath(root) {
  return path.join(root || dataRoot(), 'license', 'wechat-bind-intent.json');
}

// 发起绑定：读本机微信 → 底座 intent → 落盘本地（供授权页确认后轮询）。
// verificationUrl 来源校验（2026-09-05 Codex 复核 P2）：生产只信任 Kaypal 官方 HTTPS 域，
// 仅测试回环 mock 放行 http；不可信/未返回一律降级 null，由前端仅展示配对码并提示打开授权页。
// _detect/_basePost：测试注入口（默认 detectLocalWeChat/basePost，单测注入假桩避免碰真机微信目录与真实网络）。
async function bindStart({ root, deviceName, _detect, _basePost } = {}) {
  root = root || dataRoot();
  const detect = _detect || detectLocalWeChat;
  const post = _basePost || basePost;
  const ident = await detect({ refresh: true });
  if (!ident.detected || !ident.wxid) {
    return { ok: false, error: 'WECHAT_NOT_DETECTED', detail: '未检测到本机微信，请使用扫码登录' };
  }
  const kp = ensureDeviceKeypair(root);
  const pubB64 = devicePublicKeyB64(kp.publicKey);
  let r;
  try {
    r = await post('/api/auth/device-bind/intent', {
      wxid: ident.wxid,
      devicePubkey: pubB64,
      deviceName: deviceName || os.hostname() || 'JIUZHANG AI 管家',
      platform: process.platform === 'darwin' ? 'macos' : 'windows',
    });
  } catch (e) {
    return { ok: false, error: 'BIND_INTENT_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
  const rStatus = r && Number(r.status);
  if (rStatus !== 200 && rStatus !== 201) {
    const code = (r && r.body && r.body.error) || '';
    if (code === 'DEVICE_LIMIT') return { ok: false, error: 'DEVICE_LIMIT', detail: '绑定设备数已达上限' };
    return { ok: false, error: 'BIND_INTENT_FAILED', detail: `${rStatus || 'invalid-response'} ${code}` };
  }
  if (!r.body || r.body.ok !== true) {
    return { ok: false, error: 'BIND_INTENT_BAD_RESPONSE', detail: '底座响应信封无效' };
  }
  const data = r.body.data && typeof r.body.data === 'object' ? r.body.data : {};
  const intentId = typeof data.intentId === 'string' ? data.intentId.trim() : '';
  const pairingCode = data.pairingCode === undefined || data.pairingCode === null ? '' : String(data.pairingCode).trim();
  const expiresIn = Number(data.expiresIn);
  if (!intentId || !/^\d{6}$/.test(pairingCode) || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 300) {
    return { ok: false, error: 'BIND_INTENT_BAD_RESPONSE', detail: '底座响应字段不合规' };
  }
  const state = {
    intentId,
    pairingCode,
    // 白名单校验：不可信 URL 降级 null（不硬拒绑定——配对码路径不依赖该 URL，fail-safe 不 fail-dead）
    verificationUrl: isTrustedKaypalUrl(data.verificationUrl, { allowLoopbackHttp: baseOverride() !== '' })
      ? String(data.verificationUrl) : null,
    nickname: ident.nickname,
    startedAt: Date.now(),
    expiresIn,
  };
  try { fs.mkdirSync(path.dirname(intentPath(root)), { recursive: true }); } catch { /* ignore */ }
  // 意图为短期凭据（pairingCode 可换绑定），禁符号链接落盘
  atomicWriteJSONPrivate(intentPath(root), state);
  return { ok: true, ...state };
}

// 轮询绑定结果 → { ok, status: 'pending'|'bound'|'expired'|'error' }
async function bindStatus({ root, _baseGet } = {}) {
  root = root || dataRoot();
  const state = readJSONNoSymlink(intentPath(root));
  if (!state || !state.intentId) return { ok: false, status: 'error', detail: 'NO_INTENT' };
  // 本地 TTL 是硬边界：过期意图不再触碰底座，避免无效请求和状态复活。
  if (Date.now() - (state.startedAt || 0) > (state.expiresIn || 300) * 1000) {
    try { fs.unlinkSync(intentPath(root)); } catch { /* already gone */ }
    return { ok: true, status: 'expired' };
  }
  const get = _baseGet || baseGet;
  let r;
  try {
    r = await get('/api/auth/device-bind/intent?intentId=' + encodeURIComponent(state.intentId));
  } catch (e) {
    return { ok: false, status: 'error', detail: String((e && e.message) || e) };
  }
  const data = r && r.body && r.body.data && typeof r.body.data === 'object' ? r.body.data : {};
  const st = typeof data.status === 'string' ? data.status : '';
  const rStatus = r && Number(r.status);
  if (!(rStatus >= 200 && rStatus < 300) || !r.body || r.body.ok !== true || !['pending', 'bound', 'expired'].includes(st)) {
    return { ok: false, status: 'error', detail: 'BIND_STATUS_BAD_RESPONSE' };
  }
  if (st === 'bound' || st === 'expired') {
    try { fs.unlinkSync(intentPath(root)); } catch { /* already gone */ }
    return { ok: true, status: st };
  }
  return { ok: true, status: st, pairingCode: state.pairingCode, verificationUrl: state.verificationUrl };
}

// ===== 微信扫码直登（2026-09-06 产品负责人定版：桌面二维码 + 手机微信一扫 + 底座建号绑定）=====
// 与配对码链路（bindStart/bindStatus，灰度保留）的区别：身份由微信开放平台 OAuth 背书，
// 免配对码免本机检测——所有设备可用。账号/订阅/积分 100% kaypal 底座（服务端建号）。
// token 交付：poll 检测 ready 后复用 localLogin（绑定已 active → challenge/签名/verify）。

function scanIntentPath(root) {
  return path.join(root || dataRoot(), 'license', 'wechat-scan-intent.json');
}

// qrUrl 白名单：底座返回的是微信开放平台授权页（open.weixin.qq.com），
// 不得复用 isTrustedKaypalUrl（只认 kaypal.cn，会恒拒）——钓鱼防护改为微信官方域白名单，
// 另放行 kaypal.cn（防服务端未来改为 302 中转页）；测试 mock 放行回环 http。
function isTrustedWechatQrUrl(raw, { allowLoopbackHttp = false } = {}) {
  try {
    const u = new URL(String(raw));
    const host = String(u.hostname || '').toLowerCase();
    if (u.protocol === 'https:') {
      return host === 'open.weixin.qq.com' || host === 'kaypal.cn' || host.endsWith('.kaypal.cn');
    }
    if (u.protocol === 'http:' && allowLoopbackHttp) {
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function wechatScanStart({ root, deviceName, _basePost } = {}) {
  root = root || dataRoot();
  const post = _basePost || basePost;
  const kp = ensureDeviceKeypair(root);
  const pubB64 = devicePublicKeyB64(kp.publicKey);
  let r;
  try {
    r = await post('/api/auth/device-wechat-login/start', {
      devicePubkey: pubB64,
      deviceName: deviceName || os.hostname() || 'JIUZHANG AI 管家',
      platform: process.platform === 'darwin' ? 'macos' : 'windows',
    });
  } catch (e) {
    return { ok: false, error: 'WECHAT_SCAN_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
  const rStatus = r && Number(r.status);
  if (rStatus === 429) return { ok: false, error: 'RATE_LIMITED', detail: '发起过于频繁，请稍后再试' };
  if (rStatus !== 200 || !r.body || r.body.ok !== true) {
    return { ok: false, error: 'WECHAT_SCAN_START_FAILED', detail: `${rStatus || 'invalid-response'} ${(r && r.body && r.body.error) || ''}` };
  }
  const data = r.body.data && typeof r.body.data === 'object' ? r.body.data : {};
  const intentId = typeof data.intentId === 'string' ? data.intentId.trim() : '';
  const qrUrl = typeof data.qrUrl === 'string' ? data.qrUrl.trim() : '';
  const expiresIn = Number(data.expiresIn);
  // qrUrl 白名单：微信官方域（详见 isTrustedWechatQrUrl 注释），防二维码钓鱼
  if (!intentId || !qrUrl || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 600
    || !isTrustedWechatQrUrl(qrUrl, { allowLoopbackHttp: baseOverride() !== '' })) {
    return { ok: false, error: 'WECHAT_SCAN_BAD_RESPONSE', detail: '底座响应字段不合规' };
  }
  const state = { intentId, qrUrl, startedAt: Date.now(), expiresIn };
  try { fs.mkdirSync(path.dirname(scanIntentPath(root)), { recursive: true }); } catch { /* ignore */ }
  atomicWriteJSONPrivate(scanIntentPath(root), state);
  return { ok: true, ...state };
}

// 轮询扫码结果 → { ok, status: 'pending'|'ready'|'expired'|'error' }
// ready = 手机已授权绑定 → 清意图 → 复用 localLogin（绑定已 active，challenge/verify 直接出 token）
async function wechatScanPoll({ root, _baseGet, _basePost, _saveDesktopAuth, _loadDesktopAuth } = {}) {
  root = root || dataRoot();
  const state = readJSONNoSymlink(scanIntentPath(root));
  if (!state || !state.intentId) return { ok: false, status: 'error', error: 'NO_INTENT', detail: 'NO_INTENT' };
  if (Date.now() - (state.startedAt || 0) > (state.expiresIn || 300) * 1000) {
    try { fs.unlinkSync(scanIntentPath(root)); } catch { /* already gone */ }
    return { ok: true, status: 'expired' };
  }
  const get = _baseGet || baseGet;
  let r;
  try {
    r = await get('/api/auth/device-wechat-login/poll?intentId=' + encodeURIComponent(state.intentId));
  } catch (e) {
    return { ok: true, status: 'pending', qrUrl: state.qrUrl }; // 网络抖动不断轮询，本地 TTL 是硬边界
  }
  const data = r && r.body && r.body.data && typeof r.body.data === 'object' ? r.body.data : {};
  const st = typeof data.status === 'string' ? data.status : '';
  const rStatus = r && Number(r.status);
  if (!(rStatus >= 200 && rStatus < 300) || !r.body || r.body.ok !== true || !['pending', 'ready', 'invalid'].includes(st)) {
    return { ok: true, status: 'pending', qrUrl: state.qrUrl }; // 坏响应按 pending 处理，等下一轮
  }
  if (st === 'invalid') {
    try { fs.unlinkSync(scanIntentPath(root)); } catch { /* already gone */ }
    return { ok: true, status: 'expired' };
  }
  if (st === 'pending') return { ok: true, status: 'pending', qrUrl: state.qrUrl };
  // 十三轮 P1-4：ready 后 localLogin 短暂失败（如底座 503）不得删 intent——
  // 先删后登会让下一轮 poll 变 NO_INTENT，本地意图永久丢失且前端只重试不重发码。
  // 改为仅在登录成功后焚毁；失败保留 intent，下一轮 poll 对 ready 状态自动重试 localLogin。
  const login = await localLogin({ root, _basePost, _saveDesktopAuth, _loadDesktopAuth });
  if (!login.ok) {
    // 十五轮 P3：区分可重试（5xx/网络抖动/底座暂时异常）与确定性失败
    // （NO_BINDING 未绑定、ACCOUNT_INVALID 账号禁用、验签响应异常）——
    // 确定性失败前端必须停止轮询并给出可操作提示，而不是静默转到超时。
    const retryable = RETRYABLE_LOGIN_ERRORS.has(login.error);
    return { ok: false, status: 'error', error: login.error, detail: login.detail, needBind: !!login.needBind, retryable };
  }
  try { fs.unlinkSync(scanIntentPath(root)); } catch { /* already gone */ }
  return { ok: true, status: 'ready', user: login.user, loginMethod: 'wechat-scan' };
}

// ===== 登录（底座 ④⑤）=====

// 十五轮 P3：可重试错误白名单——仅这些允许前端继续轮询，其余视为确定性失败停止轮询。
// localLogin 可能的 error 码：NO_BINDING / CHALLENGE_FAILED / WECHAT_LOGIN_UNAVAILABLE /
// VERIFY_FAILED / VERIFY_BAD_RESPONSE。其中 WECHAT_LOGIN_UNAVAILABLE=底座 5xx、CHALLENGE_FAILED=底座响应暂时异常。
const RETRYABLE_LOGIN_ERRORS = new Set(['WECHAT_LOGIN_UNAVAILABLE', 'CHALLENGE_FAILED']);

// 本机微信一键登录 → challenge → 签名 → verify → 标准登录产物写 desktop-auth 存储。
// 未绑定（NO_BINDING）返回 needBind:true，前端引导走绑定流程。
async function localLogin({ root, _basePost, _saveDesktopAuth, _loadDesktopAuth } = {}) {
  root = root || dataRoot();
  // 惰性 require 防循环依赖（desktop-auth ← lib；wechat-local 独立）
  const { saveDesktopAuth } = _saveDesktopAuth ? { saveDesktopAuth: _saveDesktopAuth } : require('./desktop-auth');
  const post = _basePost || basePost;
  const kp = ensureDeviceKeypair(root);
  const pubB64 = devicePublicKeyB64(kp.publicKey);
  let cr;
  try {
    cr = await post('/api/auth/device-challenge', { devicePubkey: pubB64 });
  } catch (e) {
    return { ok: false, error: 'WECHAT_LOGIN_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
  const cbody = cr && cr.body;
  const cdata = cbody && cbody.data && typeof cbody.data === 'object' ? cbody.data : null;
  const challenge = cdata && typeof cdata.challenge === 'string' ? cdata.challenge : '';
  const challengeBytes = challenge ? Buffer.from(challenge, 'base64') : Buffer.alloc(0);
  const challengeExpiresIn = cdata && Number(cdata.expiresIn);
  const challengeStatus = cr && Number(cr.status);
  // TTL 契约收紧（2026-09-05 Codex 复核 P2）：规格 §④ challenge expiresIn=60s，
  // 客户端原放宽到 300 与 bind intent（§② expiresIn=300）混用——两回事，各自对齐规格。
  // 十二轮 P1：底座 challenge NO_BINDING 回 409（v11 起状态码按语义映射）——
  // 未绑定设备在这里就要进 needBind 绑定引导，不能落到 CHALLENGE_FAILED
  // （原实现只有 verify 阶段处理 NO_BINDING，首登永远进不了绑定引导）。
  if (challengeStatus === 409 && cbody && cbody.error === 'NO_BINDING') {
    return { ok: false, error: 'NO_BINDING', needBind: true, detail: '本设备尚未绑定，请先完成一次扫码绑定' };
  }
  if (challengeStatus !== 200 || !cbody || cbody.ok !== true || !challenge || challengeBytes.length !== 32
    || !Number.isFinite(challengeExpiresIn) || challengeExpiresIn <= 0 || challengeExpiresIn > 60) {
    return { ok: false, error: 'CHALLENGE_FAILED', detail: `${challengeStatus || 'invalid-response'} ${(cr && cr.body && cr.body.error) || ''}` };
  }
  const signature = signChallenge(challenge, kp);
  let vr;
  try {
    vr = await post('/api/auth/device-verify', { devicePubkey: pubB64, challenge, signature });
  } catch (e) {
    return { ok: false, error: 'WECHAT_LOGIN_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
  const vbody = (vr && vr.body) || {};
  const verifyStatus = vr && Number(vr.status);
  if (verifyStatus !== 200 || vbody.ok !== true) {
    const code = vbody.error || '';
    if (code === 'NO_BINDING') {
      return { ok: false, error: 'NO_BINDING', needBind: true, detail: '本设备尚未绑定，请先完成一次扫码绑定' };
    }
    // 底座 5xx（不可用/过载）→ 统一 503 语义，前端据此回落扫码登录（E2E ⑥ 抓出：裸 5xx 曾被映射成 401）
    if (verifyStatus >= 500) {
      return { ok: false, error: 'WECHAT_LOGIN_UNAVAILABLE', detail: `${verifyStatus || 'invalid-response'} ${code}` };
    }
    return { ok: false, error: code || 'VERIFY_FAILED', detail: `${verifyStatus || 'invalid-response'} ${code}` };
  }
  const d = vbody.data || {};
  const accessToken = d.token || d.access_token;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    return { ok: false, error: 'VERIFY_BAD_RESPONSE', detail: '底座响应缺 token' };
  }
  const auth = {
    accessToken,
    refreshToken: d.refreshToken || d.refresh_token || null,
    expiresIn: d.expiresIn || d.expires_in || 3600,
    user: d.user || null,
    device: d.device || null,
    loggedInAt: new Date().toISOString(),
    loginMethod: 'wechat-local',
  };
  saveDesktopAuth(root, auth);
  return { ok: true, user: auth.user, loginMethod: 'wechat-local', challengeExpiresIn: challengeExpiresIn };
}

module.exports = {
  basePost,
  baseGet,
  baseOverride,
  ensureDeviceKeypair,
  devicePublicKeyB64,
  signChallenge,
  detectLocalWeChat,
  detectViaHelper,
  dirScanIdentity,
  macWechatRoots,
  scanWxidDirs,
  bindStart,
  bindStatus,
  localLogin,
  wechatScanStart,
  wechatScanPoll,
  isTrustedWechatQrUrl,
  keypairPath,
  intentPath,
  scanIntentPath,
};
