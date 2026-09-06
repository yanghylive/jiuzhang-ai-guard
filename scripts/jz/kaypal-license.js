'use strict';
// Kaypal 会员授权接入（07）。真实端点：POST /api/v1/app-entitlements/check（已真机验证）。
// 鉴权（实测通过）：x-kaypal-api-key(app credential) + x-kaypal-context(HS256 JWT 自签)。
// 只保存最小必要字段；离线/超时用本地授权缓存，不阻断核心本地功能。
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { dataRoot, readJSON, atomicWriteJSON } = require('./lib');
const { loadOrCreateDataKey } = require('./crypto-vault');

const BASE = process.env.KAYPAL_BASE_URL || 'https://kaypal.cn';
const API_KEY = process.env.KAYPAL_APP_CREDENTIAL || '';
const JWT_SECRET = process.env.KAYPAL_CONTEXT_JWT_SECRET || '';
const APP_ID = process.env.KAYPAL_APP_ID || 'jz-ai-guard';
const SUB = process.env.KAYPAL_SUB || '';
const TENANT_ID = process.env.KAYPAL_TENANT_ID || '';
const CTX_TTL = parseInt(process.env.KAYPAL_CONTEXT_TTL || '55', 10);

// 授权缓存完整性（2026-08-29 复核 P0）：entitlement.json 是"权益"的本地信任源，
// 必须防本地篡改（改 validUntil/status 伪造 Pro）。写入时附 HMAC（key 派生自平台数据密钥），
// 读取时校验，MAC 不符一律视为无缓存（fail-closed，绝不信任伪造文件）。
function entitlementCachePath(root) {
  return path.join(root, 'license', 'entitlement.json');
}

function signEntitlement(root, ent) {
  const key = loadOrCreateDataKey(root);
  const clean = Object.assign({}, ent);
  delete clean._mac;
  const mac = crypto.createHmac('sha256', key).update(JSON.stringify(clean)).digest('hex');
  return Object.assign({}, clean, { _mac: mac });
}

function verifyEntitlement(root, ent) {
  if (!ent || typeof ent !== 'object' || typeof ent._mac !== 'string') return false;
  const key = loadOrCreateDataKey(root);
  const clean = Object.assign({}, ent);
  delete clean._mac;
  const mac = crypto.createHmac('sha256', key).update(JSON.stringify(clean)).digest('hex');
  return mac === ent._mac;
}

// 写授权缓存（带 MAC）；kaypal 服务端结果驱动权益写入的统一信任入口。
// （本地券体系已删，2026-08-31：不再有本地兑换方写入此缓存。）
function saveEntitlementCache(root, ent) {
  const signed = signEntitlement(root, ent);
  atomicWriteJSON(entitlementCachePath(root), signed);
  return signed;
}

// 读授权缓存：MAC 不符 → null（fail-closed，不信任）。
function loadEntitlementCache(root) {
  const ent = readJSON(entitlementCachePath(root));
  if (!ent) return null;
  return verifyEntitlement(root, ent) ? ent : null;
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
// 自签 X-Kaypal-Context（HS256 JWT），claims 与 kaypal 网关一致（实测对齐 octop 代理）。
function mintContext() {
  const now = Math.floor(Date.now() / 1000);
  const data = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({
    iss: 'kaypal-ai-platform',
    aud: 'kaypal-api-v1',
    sub: SUB,
    tenant_id: TENANT_ID,
    app_id: APP_ID,
    request_id: 'req_' + crypto.randomBytes(8).toString('hex'),
    jti: crypto.randomBytes(12).toString('hex'),
    iat: now,
    exp: now + CTX_TTL,
  });
  return data + '.' + crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
}

function authHeaders() {
  return {
    'x-kaypal-api-key': API_KEY,
    authorization: `Bearer ${API_KEY}`,
    'x-kaypal-context': mintContext(),
  };
}

function httpsJson(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlPath, BASE);
    } catch (e) {
      return reject(e);
    }
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(
      url,
      {
        method,
        headers: Object.assign(
          { 'content-type': 'application/json', accept: 'application/json' },
          headers || {},
        ),
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 把 kaypal 返回 {allowed, decision, membership, wallet} 归一化成本工程授权态。
function normalizeEntitlement(body) {
  const m = body.membership || {};
  const w = body.wallet || {};
  return {
    status: body.allowed ? 'active' : 'denied',
    allowed: !!body.allowed,
    plan: m.tenant_plan || m.user_plan || 'free',
    validUntil: m.tenant_period_end || m.user_period_end || null,
    balance: typeof w.available_balance === 'number' ? w.available_balance : null,
    appId: body.decision ? body.decision.app_id : APP_ID,
  };
}

// 会员状态机（07 §6）：login/refresh_ok/refresh_fail/expire/revoke。
function nextState(current, event) {
  if (event === 'revoke') return 'revoked';
  if (event === 'expire') return 'expired';
  return current || 'free';
}

// 会员状态审计摘要（07-D47）：状态变更时追加本地审计记录（plan/status/时间，无 token 无敏感正文）。
function auditMembershipChange(root, { from, to, source, detail }) {
  try {
    const p = path.join(root || dataRoot(), 'license', 'membership-audit.json');
    const list = readJSON(p) || [];
    list.push({
      schemaVersion: 1,
      at: new Date().toISOString(),
      from: String(from || ''),
      to: String(to || ''),
      source: String(source || ''),
      detail: String(detail || '').slice(0, 120),
    });
    // 只保留最近 50 条，防无限增长
    atomicWriteJSON(p, list.slice(-50));
  } catch {
    /* 审计失败不阻断授权主流程 */
  }
}

async function getStatus({ force = false, root, _httpsJson } = {}) {
  root = root || dataRoot();
  const http = _httpsJson || httpsJson;
  const cached = loadEntitlementCache(root); // MAC 校验，伪造/篡改文件视为无缓存
  if (cached && !force) {
    if (cached.status === 'active' && cached.validUntil && new Date(cached.validUntil) > new Date()) {
      return { ok: true, source: 'cache', entitlement: cached };
    }
    if (cached.status !== 'active') return { ok: true, source: 'cache', entitlement: cached };
  }
  if (!API_KEY || !JWT_SECRET) {
    if (cached) {
      return { ok: true, source: 'cache', entitlement: cached, degraded: true, degrade: 'not_configured' };
    }
    return { ok: false, error: 'LICENSE_UNAVAILABLE', detail: 'missing kaypal credential/secret', degrade: 'not_configured' };
  }
  try {
    const r = await http('POST', '/api/v1/app-entitlements/check', {}, authHeaders());
    if (r.status === 200 && r.body) {
      const ent = normalizeEntitlement(r.body);
      const prevState = cached ? nextState(cached.status === 'active' ? 'pro' : cached.status, 'keep') : 'free';
      if (!cached || cached.plan !== ent.plan || (cached.status === 'active') !== (ent.status === 'active')) {
        auditMembershipChange(root, {
          from: cached ? `${cached.status}/${cached.plan}` : 'none',
          to: `${ent.status}/${ent.plan}`,
          source: 'kaypal',
          detail: `entitlement check ${r.status}`,
        });
      }
      atomicWriteJSON(entitlementCachePath(root), signEntitlement(root, ent));
      return { ok: true, source: 'kaypal', entitlement: ent };
    }
    if (cached) {
      return {
        ok: true,
        source: 'cache',
        entitlement: cached,
        degraded: true,
        degrade: 'server_rejected',
        detail: `kaypal ${r.status}`,
      };
    }
    return { ok: false, error: 'LICENSE_UNAVAILABLE', degrade: 'server_rejected', detail: `kaypal ${r.status}` };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const degrade = /timeout/i.test(msg) ? 'timeout' : 'network_error';
    if (cached) {
      const expired = cached.validUntil && new Date(cached.validUntil) <= new Date();
      return {
        ok: true,
        source: 'cache',
        entitlement: cached,
        degraded: true,
        degrade: expired ? 'cache_expired' : degrade,
        detail: msg,
      };
    }
    return { ok: false, error: 'LICENSE_UNAVAILABLE', degrade, detail: msg };
  }
}

// 发起设备码授权（RFC 8628 Device Flow 第一步）：返回 device_code/user_code/verification_uri 供 UI 展示。
// 端点/client_id 从 env 读（运行时）；未配置 → fail-closed（不返回假成功）。
async function requestDeviceCode({ platform, arch, clientVersion, _httpsJson } = {}) {
  const http = _httpsJson || httpsJson;
  const deviceEndpoint = process.env.KAYPAL_OAUTH_DEVICE_ENDPOINT || '';
  const clientId = process.env.KAYPAL_OAUTH_CLIENT_ID || '';
  if (!deviceEndpoint || !clientId) {
    return { ok: false, error: 'LICENSE_UNAVAILABLE', detail: 'device-code flow not configured (needs KAYPAL_OAUTH_DEVICE_ENDPOINT + KAYPAL_OAUTH_CLIENT_ID)' };
  }
  try {
    const r = await http('POST', deviceEndpoint, { client_id: clientId, scope: 'app-entitlement' });
    if (r.status === 200 && r.body && r.body.device_code) {
      return {
        ok: true,
        deviceCode: r.body.device_code,
        userCode: r.body.user_code,
        verificationUri: r.body.verification_uri_complete || r.body.verification_uri,
        expiresIn: r.body.expires_in,
        interval: r.body.interval,
      };
    }
    return { ok: false, error: 'LICENSE_UNAVAILABLE', detail: `device endpoint ${r.status}` };
  } catch (e) {
    return { ok: false, error: 'LICENSE_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 轮询 token（设备码授权第二步）：device_code → access_token。authorization_pending=用户尚未授权（继续轮询）。
async function pollDeviceToken({ deviceCode, _httpsJson } = {}) {
  const http = _httpsJson || httpsJson;
  const tokenEndpoint = process.env.KAYPAL_OAUTH_TOKEN_ENDPOINT || '';
  const clientId = process.env.KAYPAL_OAUTH_CLIENT_ID || '';
  if (!tokenEndpoint || !clientId) {
    return { ok: false, error: 'LICENSE_UNAVAILABLE', detail: 'token endpoint not configured' };
  }
  if (!deviceCode) return { ok: false, error: 'LICENSE_UNAVAILABLE', detail: 'missing device_code' };
  try {
    const r = await http('POST', tokenEndpoint, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
    });
    if (r.status === 200 && r.body && r.body.access_token) {
      return { ok: true, accessToken: r.body.access_token, refreshToken: r.body.refresh_token || null };
    }
    const err = (r.body && r.body.error) || '';
    if (err === 'authorization_pending') return { ok: false, error: 'AUTHORIZATION_PENDING', detail: 'user not authorized yet' };
    if (err === 'slow_down') return { ok: false, error: 'SLOW_DOWN', detail: 'polling too fast' };
    if (err === 'expired_token') return { ok: false, error: 'LICENSE_UNAVAILABLE', detail: 'device_code expired' };
    return { ok: false, error: 'LICENSE_UNAVAILABLE', detail: `token endpoint ${r.status}` };
  } catch (e) {
    return { ok: false, error: 'LICENSE_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

async function refresh(root) {
  return getStatus({ force: true, root });
}

// 拉取 kaypal 订阅方案目录（GET /api/pricing/plans，公开端点）。
// 供前端价目卡动态化：返回 jz_guard_* 方案（id/name/price/features），失败 fail-closed 由调用方兜底。
async function getPlans({ _httpsJson } = {}) {
  const http = _httpsJson || httpsJson;
  try {
    const r = await http('GET', '/api/pricing/plans', null, {});
    if (r.status === 200 && r.body && typeof r.body === 'object') {
      const data = r.body.data || r.body;
      const individual = Array.isArray(data.individual) ? data.individual : [];
      const jz = individual
        .filter((p) => p && String(p.id || '').startsWith('jz_guard'))
        .map((p) => ({
          id: p.id,
          name: p.name || p.id,
          price: typeof p.price === 'number' ? p.price : null,
          features: Array.isArray(p.features) ? p.features : [],
          hot: p.id === 'jz_guard_yearly_coupon',
        }));
      return { ok: true, plans: jz, source: 'kaypal' };
    }
    return { ok: false, error: 'PLANS_UNAVAILABLE', detail: `plans endpoint ${r.status}` };
  } catch (e) {
    return { ok: false, error: 'PLANS_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

module.exports = { BASE, httpsJson, mintContext, normalizeEntitlement, nextState, auditMembershipChange, getStatus, requestDeviceCode, pollDeviceToken, refresh, getPlans, entitlementCachePath, saveEntitlementCache, loadEntitlementCache, signEntitlement, verifyEntitlement };
