'use strict';
// 本地 API 鉴权与信任边界（回应审查 P1-6：loopback 不是安全边界）。
//
// 威胁模型：同机同用户的任意进程都能连 loopback 端口。因此：
//   1) 每次 daemon 启动生成高熵 secret，落盘权限 0600（只有同用户 + 有文件系统访问才能读，
//      而不是"能连端口就能操作"）。
//   2) 所有 /api/* 与管理页必须带 secret；比较用 timingSafeEqual。
//   3) 校验 Host / Origin，拒绝 DNS rebinding 与跨站页面发起的请求。
//   4) 路由分级：read / write_low / write_high；高风险操作额外要求一次性短时 confirmToken。
//   5) secret 不写日志、不进诊断包、不放进 localStorage。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readFileNoSymlink } = require('./lib');

const TOKEN_FILE = 'runtime/.daemon-token';
const CONFIRM_TTL_MS = 60 * 1000;

// ===== 管理页会话（P0 修复：/jz 页面不再注入长期 API_TOKEN）=====
// 威胁模型（loopback HTTP 方案，见 docs/04 §鉴权）：
//   - 同机同用户进程本就能读 0600 token 文件 → 属既有信任边界内，会话引导不改变该边界；
//   - 浏览器渲染进程/跨站页面：HttpOnly + SameSite=Strict 的短时会话 Cookie 不可被 JS 读取、
//     不随跨站请求发送，配合 Host/Origin loopback 校验阻断 DNS rebinding 与 CSRF；
//   - 会话空闲 30 分钟失效、绝对上限 8 小时，长期 secret 永不出现在 HTML / localStorage / URL。
const SESSION_COOKIE = 'jzsid';
const SESSION_IDLE_MS = Number(process.env.JZ_SESSION_IDLE_MS) || 30 * 60 * 1000;
const SESSION_MAX_MS = Number(process.env.JZ_SESSION_MAX_MS) || 8 * 60 * 60 * 1000;
// 一次性引导凭据（guest）：GET /jz 时下发，10 分钟内、仅可使用一次，用于升级为正式会话。
// 无 guest 凭据的会话引导请求一律 401——裸调 /api/admin/session 拿不到会话（P0 修复）。
const GUEST_TTL_MS = Number(process.env.JZ_GUEST_TTL_MS) || 10 * 60 * 1000;

class SessionStore {
  constructor({ now, idleMs, maxMs, guestTtlMs } = {}) {
    this._map = new Map(); // id → { kind: 'guest'|'session', createdAt, lastSeen }
    this._now = now || (() => Date.now());
    this._idleMs = idleMs || SESSION_IDLE_MS;
    this._maxMs = maxMs || SESSION_MAX_MS;
    this._guestTtlMs = guestTtlMs || GUEST_TTL_MS;
  }

  issueGuest() {
    const id = crypto.randomBytes(24).toString('hex');
    this._map.set(id, { kind: 'guest', createdAt: this._now(), lastSeen: this._now() });
    return { id, expiresAt: new Date(this._now() + this._guestTtlMs).toISOString() };
  }

  // 一次性升级：guest → 正式会话。guest 不存在/已过期/已是会话 → false。
  upgrade(id) {
    const key = String(id || '');
    const rec = this._map.get(key);
    if (!rec || rec.kind !== 'guest') return false;
    if (this._now() - rec.createdAt > this._guestTtlMs) {
      this._map.delete(key);
      return false;
    }
    // 单次使用：升级即转变形态（原 guest 凭据不复存在，无法二次升级）
    rec.kind = 'session';
    rec.createdAt = this._now();
    rec.lastSeen = rec.createdAt;
    return true;
  }

  issue() {
    const id = crypto.randomBytes(24).toString('hex');
    const now = this._now();
    this._map.set(id, { kind: 'session', createdAt: now, lastSeen: now });
    return { id, expiresAt: new Date(now + this._idleMs).toISOString() };
  }

  // 校验正式会话并滑动过期窗口；guest 凭据不能直接访问 API。过期/未知返回 false 并清除。
  touch(id) {
    const key = String(id || '');
    const rec = this._map.get(key);
    if (!rec || rec.kind !== 'session') return false;
    const now = this._now();
    if (now - rec.lastSeen > this._idleMs || now - rec.createdAt > this._maxMs) {
      this._map.delete(key);
      return false;
    }
    rec.lastSeen = now;
    return true;
  }

  revoke(id) {
    return this._map.delete(String(id || ''));
  }

  sweep() {
    const now = this._now();
    for (const [k, rec] of this._map) {
      const ttl = rec.kind === 'guest' ? this._guestTtlMs : this._idleMs;
      const max = rec.kind === 'guest' ? this._guestTtlMs : this._maxMs;
      if (now - rec.lastSeen > ttl || now - rec.createdAt > max) this._map.delete(k);
    }
  }
}

function parseSessionCookie(req) {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw) return '';
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return '';
}

// HttpOnly：JS（含 XSS）读不到；SameSite=Strict：跨站请求不携带；仅限本机页面同源使用。
function sessionCookieHeader(id, { maxAgeSec } = {}) {
  const secs = Number.isFinite(maxAgeSec) ? maxAgeSec : Math.floor(SESSION_IDLE_MS / 1000);
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${secs}`;
}

const SESSION_CLEAR_HEADER = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

// 高风险写操作：破坏性或涉及凭据流转，必须 secret + 一次性 confirmToken。
const HIGH_RISK = new Set([
  'POST /api/repair/run',
  'POST /api/vault/restore',
  'POST /api/vault/export',
  'POST /api/handoff/create',
  'POST /api/handoff/apply',
  'POST /api/watchdog/restart',
  'POST /api/vault/import',
  'POST /api/cleanup/apply',
  'POST /api/cleanup/purge',
  'POST /api/diagnostics/upload',
  'POST /api/desktop-auth/revoke',
  // 2026-08-29 复核 P1：daemon 侧遗留破坏性 API 纳入同一高风险确认体系（票据由 /api/auth/confirm 签发）
  'POST /api/delete',
  'POST /api/sessions/delete',
]);

// 只读路由：仍需 secret，但不需要 confirmToken。
const READ_ONLY = new Set([
  'GET /',
  'GET /api/vault/backups',
  'GET /api/compatibility/report',
  'GET /api/license/status',
  'GET /api/cleanup/quarantine',
]);

function tokenPath(root) {
  return path.join(root, TOKEN_FILE);
}

// 启动时生成/读取 secret。文件权限强制 0600；权限不符则重新生成（防止被他人预置弱 token）。
// Windows 例外：chmod 只支持只读位，mode 恒为 0o666，无法表达 0600（权限模型为 ACL），
// 若强行校验 mode 会导致每次启动都重新生成 token。Windows 上以内容格式为准。
function ensureToken(root) {
  const p = tokenPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const isWin = process.platform === 'win32';
  try {
    // 第八/九轮复核：统一 readFileNoSymlink（外部有效 token 的链接不得被接受）
    const raw = readFileNoSymlink(p).toString('utf8').trim();
    const st = fs.statSync(p);
    const mode = st.mode & 0o777;
    if ((isWin || mode === 0o600) && /^[0-9a-f]{64}$/.test(raw)) return raw;
  } catch (e) {
    // ESYMLINK（凭据被替换为链接）：fail-closed，不读不生成
    if (e && e.code === 'ESYMLINK') throw e;
    /* 不存在 → 生成 */
  }
  const token = crypto.randomBytes(32).toString('hex');
  const tmp = `${p}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, p);
  fs.chmodSync(p, 0o600);
  return token;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Host 必须是 loopback 字面量，阻断 DNS rebinding（攻击者用自己域名解析到 127.0.0.1）。
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const h = String(hostHeader).split(':')[0].toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
}

// Origin 若存在必须同为 loopback；跨站页面（含 WorkBuddy 渲染进程里的第三方脚本）不得驱动本 API。
// 2026-08-29 复核 P2：'null' Origin（file:///跨站 iframe）一律拒绝；
// 空 Origin（本地 CLI/启动器/curl，无浏览器上下文）允许——但所有非公开路由仍强制 token，不构成绕过。
function originAllowed(originHeader) {
  if (!originHeader) return true; // 本地 CLI/启动器不带 Origin
  if (originHeader === 'null') return false; // 跨站/file:// 的 null Origin 拒绝
  try {
    const u = new URL(String(originHeader));
    return hostAllowed(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch {
    return false;
  }
}

function riskOf(method, pathname) {
  const key = `${method} ${pathname}`;
  if (HIGH_RISK.has(key)) return 'write_high';
  if (READ_ONLY.has(key) || method === 'GET') return 'read';
  return 'write_low';
}

// 一次性确认票据：60s TTL、单次使用、绑定具体路由，防止"点了备份实际执行了恢复"。
class ConfirmStore {
  constructor(now = () => Date.now()) {
    this._map = new Map();
    this._now = now;
  }

  issue(scope) {
    const tokenValue = crypto.randomBytes(16).toString('hex');
    this._map.set(tokenValue, { scope: String(scope || ''), expiresAt: this._now() + CONFIRM_TTL_MS });
    return { confirmToken: tokenValue, expiresAt: new Date(this._now() + CONFIRM_TTL_MS).toISOString() };
  }

  consume(tokenValue, scope) {
    const rec = this._map.get(tokenValue);
    if (!rec) return false;
    this._map.delete(tokenValue); // 单次使用：无论成败都失效
    if (rec.expiresAt < this._now()) return false;
    return rec.scope === String(scope || '');
  }

  sweep() {
    const now = this._now();
    for (const [k, v] of this._map) if (v.expiresAt < now) this._map.delete(k);
  }
}

// 从请求提取 secret：优先 header，其次查询串（仅为让浏览器能首次打开管理页）。
function extractToken(req, url) {
  const h = req.headers['x-jz-token'];
  if (h) return Array.isArray(h) ? h[0] : h;
  const auth = req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return String(auth).replace(/^Bearer\s+/i, '');
  if (url && url.searchParams) return url.searchParams.get('k') || '';
  return '';
}

// 返回 { ok:true, risk, via } 或 { ok:false, error, status }
// 公开端点：浏览器直接回调、无法携带 secret 的端点。用 state（随机、单次使用）做 CSRF 防护，
// 仍保留 Host/Origin loopback 校验（防 DNS rebinding），仅豁免 secret 比较。
const PUBLIC_ENDPOINTS = new Set(['GET /api/oidc/callback']);

// 会话引导端点：/jz 页面拿不到长期 secret（P0 修复），由本端点把 GET /jz 下发的一次性 guest
// Cookie 升级为正式会话（裸调无凭据 → 401）。仍强制 Host/Origin loopback 校验。
const SESSION_BOOTSTRAP = 'POST /api/admin/session';

// authorize 可注入宿主策略：
//   originAllowedFn(origin) → 宿主（daemon）的官方来源白名单（WorkBuddy renderer 页面带官方 Origin 调本机 API）；
//   tokenCheckFn(candidate) → 宿主的额外有效 token 集合（如注入面板的短时会话 token）。
// 缺省行为：Origin 仅 loopback、token 必须 === 本 router secret。
function authorize({ req, url, token, body, confirmStore, sessionStore, originAllowedFn, tokenCheckFn }) {
  const method = (req.method || 'GET').toUpperCase();
  const pathname = url.pathname;
  const isPublic = PUBLIC_ENDPOINTS.has(`${method} ${pathname}`);
  const isSessionBootstrap = `${method} ${pathname}` === SESSION_BOOTSTRAP;

  if (!hostAllowed(req.headers.host)) {
    return { ok: false, status: 403, error: 'UNAUTHORIZED_LOCAL_REQUEST', reason: 'host_not_loopback' };
  }
  const originOK = typeof originAllowedFn === 'function' ? originAllowedFn(req.headers.origin) : originAllowed(req.headers.origin);
  if (!originOK) {
    // 宿主白名单（官方页面来源）未通过时，若 Origin 也非 loopback，返回原 reason 兼容旧断言
    return { ok: false, status: 403, error: 'UNAUTHORIZED_LOCAL_REQUEST', reason: 'origin_not_loopback' };
  }
  let via = 'token';
  if (!isPublic && !isSessionBootstrap) {
    const candidate = extractToken(req, url);
    const tokenOK = typeof tokenCheckFn === 'function'
      ? !!candidate && tokenCheckFn(candidate)
      : safeEqual(candidate, token);
    if (!tokenOK) {
      // 长期 token 不匹配 → 尝试管理页会话 Cookie（/jz 页面专用通道）
      if (sessionStore && sessionStore.touch(parseSessionCookie(req))) {
        via = 'session';
        // 会话通道仅限本机管理页：带官方页面 Origin 的请求不允许用会话 Cookie（防跨站会话驱动）
        const o = String(req.headers.origin || '');
        if (o && o !== 'null' && !originAllowed(o)) {
          return { ok: false, status: 403, error: 'UNAUTHORIZED_LOCAL_REQUEST', reason: 'origin_not_loopback' };
        }
      } else {
        return { ok: false, status: 401, error: 'UNAUTHORIZED_LOCAL_REQUEST', reason: 'bad_token', sessionRequired: true };
      }
    }
  }

  const risk = riskOf(method, pathname);
  if (risk === 'write_high') {
    const ct = (body && body.confirmToken) || req.headers['x-jz-confirm'] || '';
    if (!confirmStore || !confirmStore.consume(ct, `${method} ${pathname}`)) {
      return { ok: false, status: 403, error: 'UNAUTHORIZED_LOCAL_REQUEST', reason: 'confirm_required', risk };
    }
  }
  return { ok: true, risk, via };
}

module.exports = {
  ensureToken,
  tokenPath,
  authorize,
  riskOf,
  hostAllowed,
  originAllowed,
  safeEqual,
  ConfirmStore,
  SessionStore,
  parseSessionCookie,
  sessionCookieHeader,
  SESSION_CLEAR_HEADER,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  GUEST_TTL_MS,
  HIGH_RISK,
  READ_ONLY,
  CONFIRM_TTL_MS,
};
