'use strict';
// 共享基础工具：数据根目录、uuid、结构化文件读写、原子写、统一响应信封。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

function dataRoot() {
  return process.env.JZ_DATA_ROOT || path.join(os.homedir(), '.jz-ai-guard');
}

// WorkBuddy 用户数据目录（账号/会话备份源）。env 可覆盖以支持测试/多机对齐。
// 2026-08-30 第四轮复核 P1（修复）：旧实现固定 ~/.workbuddy —— workbuddy-ai profile
// 的数据目录是 ~/.workbuddy-ai，启用 AI profile 时备份/恢复/交接会读写国内版目录（跨 profile 污染）。
// 现按 ACTIVE_PROFILE.dataRoot 返回；env 覆盖优先级最高（测试/多机对齐）。
function workbuddyDir() {
  if (process.env.JZ_WORKBUDDY_DIR) return process.env.JZ_WORKBUDDY_DIR;
  try {
    const { getProfile } = require('../profiles.js');
    const p = getProfile();
    if (p && p.dataRoot) return p.dataRoot;
  } catch (_) { /* profiles 不可用时退回默认 */ }
  return path.join(os.homedir(), '.workbuddy');
}

// 数据根下的标准子目录（05 §2）。禁止在新模块另造第二个数据根。
const DIRS = [
  'backups/manifests',
  'backups/blobs',
  'runtime/operations',
  'logs',
  'diagnostics',
  'compatibility',
  'license',
  'quarantine',
];

// 2026-08-30 第六轮复核 P0：物理 realpath 根目录校验（单一真源，全模块共用）。
// 受管路径必须真实存在于其配置位置——realpath(p) 必须等于 p 字面值：
//   · p 本身是符号链接 → 拒；
//   · p 的父级链上任一链接（root/parent-link → 外部）→ realpath(p) 落在外部，
//     ≠ p 字面值 → 拒（第五轮只查 base 本身漏掉的场景）。
// p 尚不存在时检查父链（未来 mkdir 的物理落点由父链决定）。
// 注意：macOS 测试环境 os.tmpdir() 返回 /var/...（/var 是系统链接），测试夹具
// 统一用 fs.realpathSync(os.tmpdir()) 作为 base，否则会被本函数正确地拒绝。
// 第八轮复核 P1：读取凭据文件必须拒绝符号链接（外部有效 token 的链接会被旧实现接受，
// 等于把攻击者提供的密钥当本机密钥用）。链接 → 抛 ESYMLINK（调用方区分处理）。
// 2026-08-31 复核第二轮 P2（Codex #1）：旧实现 lstat + readFileSync 两步路径操作存在
// TOCTOU——两步之间目标被替换成符号链接仍会读外部内容（受控替换已复现 EXTERNAL_RACE）。
// 改 fd 级 O_NOFOLLOW：open 阶段直接拒绝符号链接，无竞态窗口。
function readFileNoSymlink(p) {
  const NOFOLLOW = fs.constants && fs.constants.O_NOFOLLOW;
  if (NOFOLLOW) {
    let fd = null;
    try {
      fd = fs.openSync(p, fs.constants.O_RDONLY | NOFOLLOW);
      // open 已拒链接；再确认 regular file（防 FIFO/设备文件阻塞读取）
      if (!fs.fstatSync(fd).isFile()) {
        throw Object.assign(new Error(`拒绝读取非常规文件: ${p}`), { code: 'ESYMLINK' });
      }
      return fs.readFileSync(fd);
    } catch (e) {
      // O_NOFOLLOW 下 open 符号链接抛 ELOOP → 统一转 ESYMLINK（code 与 message 都归一，
      // 调用方与既有测试按"拒绝读取符号链接文件"语义匹配）
      if (e && e.code === 'ELOOP') {
        e.code = 'ESYMLINK';
        e.message = `拒绝读取符号链接文件: ${p}`;
      }
      throw e;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    }
  }
  // 无 O_NOFOLLOW 的平台（Windows）：降级保留 lstat 检查（存在理论竞态窗口；
  // Windows 符号链接默认需管理员权限创建，攻击面显著更小。ESYMLINK 语义保持不变。
  // 已确认为已知平台限制并列入 CHANGELOG [Unreleased]「已知平台限制（Windows）」，
  // 第三轮复核（Codex 2026-09-01）确认 POSIX 下闭环、无新 P0/P1）
  try {
    if (fs.lstatSync(p).isSymbolicLink()) {
      throw Object.assign(new Error(`拒绝读取符号链接文件: ${p}`), { code: 'ESYMLINK' });
    }
  } catch (e) {
    if (e.code === 'ESYMLINK') throw e;
    // ENOENT 等：文件不存在，交调用方按"不存在"处理
    if (e.code !== 'ENOENT' && !/ENOENT/.test(String((e && e.message) || e))) throw e;
  }
  return fs.readFileSync(p);
}

function isPhysicallyRealPath(p) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return false;
    return fs.realpathSync(p) === p;
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // 目录树中间段也可能不存在（如 backups/manifests 首次创建前）→ 递归查父链
      const parent = path.dirname(p);
      if (parent === p) return true; // 到文件系统根
      return isPhysicallyRealPath(parent);
    }
    return false;
  }
}

function ensureDataRoot(root) {
  root = root || dataRoot();
  // 2026-08-30 第六轮复核 P0：数据根本身（或其父级链）是符号链接时拒绝创建——
  // 旧实现直接 mkdirSync，会在链接指向的外部目录建出完整数据结构。
  if (!isPhysicallyRealPath(root)) {
    throw new Error(`数据根路径含符号链接，拒绝创建（防逃逸）: ${root}`);
  }
  fs.mkdirSync(root, { recursive: true });
  for (const d of DIRS) {
    const sub = path.join(root, d);
    if (!isPhysicallyRealPath(sub)) {
      throw new Error(`数据子目录是符号链接，拒绝写入（防逃逸）: ${sub}`);
    }
    fs.mkdirSync(sub, { recursive: true });
  }
  return root;
}

function uuid() {
  return randomUUID();
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// 临时文件写入 + fsync + 原子 rename，避免半写文件（05 §5）。
// 2026-08-29 复核 P1：write/fsync 异常时清理 tmp（磁盘满/断电场景不留残留文件）。
function atomicWriteJSON(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${uuid()}.tmp`);
  const data = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.fsyncSync(fd);
  } catch (e) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  try {
    fs.closeSync(fd);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  fs.renameSync(tmp, p);
}

// 敏感凭据专用原子写（2026-08-29 复查 P1）：access/refresh token 等落盘必须 0600，
// 防多用户机器上其他本地用户读取。Windows chmod 只支持只读位（ACL 权限模型），尽力而为。
// 2026-08-29 复核 P1：write/fsync/close 异常时同样清理 tmp。
function atomicWriteJSONPrivate(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${uuid()}.tmp`);
  const data = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.fsyncSync(fd);
  } catch (e) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  try {
    fs.closeSync(fd);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  fs.renameSync(tmp, p);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(p, 0o600); } catch {}
  }
}

// 旧版本可能已生成 0644 凭据文件：读取时顺手收紧权限（幂等迁移）。
function ensurePrivateMode(p) {
  if (process.platform === 'win32') return;
  try {
    if ((fs.statSync(p).mode & 0o777) !== 0o600) fs.chmodSync(p, 0o600);
  } catch {}
}

// 统一响应信封（04 §1）。
function envelope(okFlag, data, error, requestId) {
  return {
    ok: !!okFlag,
    data: data === undefined ? null : data,
    error: error === undefined ? null : error,
    requestId: requestId || uuid(),
  };
}

// 本地 API 的 Origin 策略（单一真源，daemon 与注入面板共用）。
// 2026-09-04 修正（产品负责人真机实锤回归）：Origin: "null" 必须放行——真实 WorkBuddy 面板宿主
// 是 file:// 页面，浏览器规则「同源 GET 不带 Origin、POST 必带」，file:// 的 POST Origin
// 字面量即 "null"。此前 2026-08-30 P1 修复把 null 一刀切拒绝 → 面板 GET 全通、POST 全 403
// （主题切换/支付链/设置开关全挂），E2E 页面跑在 http://127.0.0.1 掩盖了该问题。
// 安全性不降级：origin 放行后 token 校验仍在 authorize 链强制；恶意 http 页面带真实 Origin
// 照拒，无 token 的本地文件照样 401。
function isAllowedApiOrigin(origin) {
  if (!origin) return true; // 本地 CLI/启动器请求没有 Origin
  if (origin === 'null') return true; // file:// 宿主页面的 POST（token 兜底仍在）
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = String(u.hostname || '').toLowerCase();
    // WorkBuddy 的 renderer 可能是官方网页来源，也可能是 loopback DevTools 页面。
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
      host === 'workbuddy.cn' || host.endsWith('.workbuddy.cn') ||
      host === 'workbuddy.ai' || host.endsWith('.workbuddy.ai') ||
      host === 'codebuddy.cn' || host.endsWith('.codebuddy.cn') ||
      host === 'codebuddy.ai' || host.endsWith('.codebuddy.ai');
  } catch (_) {
    return false;
  }
}

// 幂等键格式（指导 §9）：8-128 位字母/数字/_/-。
// 原从 coupons.js 导出；本地券体系已删（2026-08-31），格式校验仍是 purchase/kaypal-coupon 强制项，收归 lib。
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

// 底座授权页 URL 白名单（2026-09-05 Codex 复核 P2）：生产只信任 Kaypal 官方 HTTPS 域
// （kaypal.cn 及子域，实测 /api/desktop-auth/start 返回 https://kaypal.cn/...）。
// http 仅当测试环境显式放行（allowLoopbackHttp=true 且 host 为回环）——mock 底座联调专用，
// 生产环境变量误配永远打不开 http。不可信返回 false，调用方自行降级/失败。
function isTrustedKaypalUrl(raw, { allowLoopbackHttp = false } = {}) {
  try {
    const u = new URL(String(raw));
    const host = String(u.hostname || '').toLowerCase();
    if (u.protocol === 'https:') {
      return host === 'kaypal.cn' || host.endsWith('.kaypal.cn');
    }
    if (u.protocol === 'http:' && allowLoopbackHttp) {
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    }
    return false;
  } catch (_) {
    return false;
  }
}

module.exports = { dataRoot, workbuddyDir, ensureDataRoot, isPhysicallyRealPath, readFileNoSymlink, DIRS, uuid, readJSON, atomicWriteJSON, atomicWriteJSONPrivate, ensurePrivateMode, envelope, isAllowedApiOrigin, IDEMPOTENCY_KEY_RE, isTrustedKaypalUrl };
