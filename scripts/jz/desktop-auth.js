'use strict';
// kaypal desktop-auth 桌面授权（账号密码 → desktopAccessToken）。
// 端点（实测）：POST /api/desktop-auth/password  body { phone, password, device_id, device_name, platform }
//   → { access_token, refresh_token, expires_in:3600, token_type:"Bearer", device, user }
// access_token = desktopAccessToken（kda_ 随机串，sha256 存 kaypal DesktopAccessToken 表），
// 用于调 kaypal 桌面 API（如优惠券）时的 Bearer 鉴权。会话存本地 license/desktop-auth.json（不落明文日志）。
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { dataRoot, uuid, readJSON, atomicWriteJSON, atomicWriteJSONPrivate, ensurePrivateMode, readFileNoSymlink, isTrustedKaypalUrl } = require('./lib');
const { atomicWriteCredFile, readCredFile } = require('./crypto-vault');
const { httpsJson } = require('./kaypal-license');

function authPath(root) {
  return path.join(root || dataRoot(), 'license', 'desktop-auth.json');
}

function deviceIdPath(root) {
  return path.join(root || dataRoot(), 'license', 'device-id');
}

// 设备唯一 ID（每个安装生成一次，持久化）。
function ensureDeviceId(root) {
  root = root || dataRoot();
  const p = deviceIdPath(root);
  const existing = readJSON(p);
  if (existing && existing.deviceId) return existing.deviceId;
  const deviceId = `jz-${uuid()}`;
  atomicWriteJSON(p, { deviceId, createdAt: new Date().toISOString() });
  return deviceId;
}

function loadDesktopAuth(root) {
  root = root || dataRoot();
  // 2026-08-29 复核 P1：读取优先解密 v2 密文；旧明文自动识别并迁移为加密
  return readCredFile(root, authPath(root));
}

// 只读加载（2026-08-31 复核 P2 Codex #7）：不触发旧明文迁移写盘。
// 供 /api/license/trial 等严格只读路径用——试算不得有任何磁盘副作用。
function loadDesktopAuthReadOnly(root) {
  root = root || dataRoot();
  return readCredFile(root, authPath(root), { noMigrate: true });
}

function saveDesktopAuth(root, auth) {
  root = root || dataRoot();
  // 2026-08-29 复核 P1：access/refresh token 不再 0600 明文落盘，改平台密钥加密（Keychain/DPAPI/0600 三级）
  atomicWriteCredFile(root, authPath(root), auth);
  return auth;
}

// 账号密码登录 → desktopAccessToken。返回 { ok, accessToken, refreshToken, user, device }。
// 失败 fail-closed：凭证错 401 / 账号停用 403 / 端点不可用。
async function passwordLogin({ phone, password, deviceName, platform, root } = {}) {
  if (!phone || !password) return { ok: false, error: 'INVALID_REQUEST', detail: 'missing phone/password' };
  const deviceId = ensureDeviceId(root);
  try {
    const r = await httpsJson('POST', '/api/desktop-auth/password', {
      phone,
      password,
      device_id: deviceId,
      device_name: deviceName || 'jz-ai-guard',
      platform: platform || 'desktop',
    });
    if (r.status === 200 && r.body && r.body.access_token) {
      const auth = {
        accessToken: r.body.access_token,
        refreshToken: r.body.refresh_token || null,
        expiresIn: r.body.expires_in,
        user: r.body.user || null,
        device: r.body.device || null,
        loggedInAt: new Date().toISOString(),
      };
      saveDesktopAuth(root, auth);
      return { ok: true, ...auth };
    }
    if (r.status === 401) return { ok: false, error: 'INVALID_CREDENTIALS', detail: (r.body && r.body.error) || '账号或密码错误' };
    if (r.status === 403) return { ok: false, error: 'ACCOUNT_DISABLED', detail: (r.body && r.body.error) || '账号已被停用' };
    return { ok: false, error: 'DESKTOP_AUTH_FAILED', detail: `${r.status} ${(r.body && r.body.error) || ''}` };
  } catch (e) {
    return { ok: false, error: 'DESKTOP_AUTH_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 07-D37：access token 过期时用 refreshToken 刷新一次。
// 成功 → 更新本地会话（新 accessToken/expiresIn）；失败（401/400/网络）→ 保留会话文件但返回失败，
// 由调用方决定降级为未登录提示（不删本地数据，07-D38）。
async function refreshAccessToken({ root, _httpsJson } = {}) {
  root = root || dataRoot();
  const http = _httpsJson || httpsJson;
  const auth = loadDesktopAuth(root);
  if (!auth || !auth.refreshToken) return { ok: false, error: 'NO_REFRESH_TOKEN' };
  try {
    const r = await http('POST', '/api/desktop-auth/refresh', { refresh_token: auth.refreshToken });
    if (r.status === 200 && r.body && r.body.access_token) {
      const next = Object.assign({}, auth, {
        accessToken: r.body.access_token,
        refreshToken: r.body.refresh_token || auth.refreshToken,
        expiresIn: r.body.expires_in,
        refreshedAt: new Date().toISOString(),
      });
      saveDesktopAuth(root, next);
      return { ok: true, accessToken: next.accessToken };
    }
    // refresh token 也失效 → 提示重新登录（保留本地数据与用户资料）
    if (r.status === 401 || r.status === 400) {
      return { ok: false, error: 'REFRESH_INVALID', detail: '登录已过期，请重新登录', needRelogin: true };
    }
    return { ok: false, error: 'REFRESH_UNAVAILABLE', detail: `${r.status}` };
  } catch (e) {
    return { ok: false, error: 'REFRESH_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 设备 revoke（07 §4 设备 activate/revoke）：调 kaypal /api/desktop-auth/revoke 吊销本设备
// （服务器撤销 device + accessToken + refreshToken），成功后清本地会话与权益缓存。
// 失败 fail-closed：凭据失效 401 → 本地也清（token 已废）；网络失败 → 本地保留（可重试）。
async function revokeDevice({ root, _httpsJson } = {}) {
  root = root || dataRoot();
  const http = _httpsJson || httpsJson;
  const auth = loadDesktopAuth(root);
  if (!auth || !auth.accessToken) {
    return { ok: false, error: 'NOT_LOGGED_IN', detail: '未登录，无设备可吊销' };
  }
  const deviceId = ensureDeviceId(root);
  try {
    const r = await http(
      'POST',
      '/api/desktop-auth/revoke',
      { device_id: deviceId },
      { authorization: `Bearer ${auth.accessToken}` },
    );
    if (r.status === 200 && r.body && r.body.status === 'revoked') {
      clearLocalAuth(root);
      return { ok: true, status: 'revoked', deviceId, source: 'kaypal' };
    }
    if (r.status === 401 || r.status === 404) {
      // token 已失效/设备已不存在：本地会话本就是死态，清掉
      clearLocalAuth(root);
      return { ok: true, status: 'revoked', deviceId, source: 'local-cleanup', note: `kaypal ${r.status}` };
    }
    return { ok: false, error: 'REVOKE_FAILED', detail: `${r.status} ${(r.body && r.body.error) || ''}` };
  } catch (e) {
    return { ok: false, error: 'REVOKE_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// ===== 设备码登录（OAuth 2.0 Device Authorization Grant, RFC 8628）=====
// kaypal 服务端已实现三端点：POST /api/desktop-auth/start（拿 device_code/user_code）、
// GET /api/desktop-auth/authorize（用户浏览器输 user_code 授权）、POST /api/desktop-auth/poll（轮询）。
// jz 侧职责：start 生成 PKCE → 展示 user_code + verification_url → poll 轮询 → authorized 存 token。

function deviceFlowPath(root) {
  return path.join(root || dataRoot(), 'license', 'device-flow.json');
}

// 生成 PKCE（RFC 7636 S256）：code_verifier 32B base64url，challenge = sha256(verifier) base64url。
function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// 发起设备授权流 → 返回 { ok, deviceCode, userCode, verificationUrl, expiresIn, interval }。
// 本地持久化 device-flow.json（含 code_verifier 供 poll 用），不落明文 token。
async function deviceFlowStart({ deviceName, platform, root, _httpsJson } = {}) {
  root = root || dataRoot();
  const http = _httpsJson || httpsJson;
  const deviceId = ensureDeviceId(root);
  const { verifier, challenge } = generatePkce();
  try {
    const r = await http('POST', '/api/desktop-auth/start', {
      client: 'jz-ai-guard',
      device_id: deviceId,
      device_name: deviceName || 'JIUZHANG AI 管家',
      platform: platform || 'desktop',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (r.status === 201 && r.body && r.body.device_code) {
      // verification_url 来源校验（2026-09-05 Codex 复核 P2）：生产只信任 Kaypal 官方 HTTPS 域
      // （实测 start 返回 https://kaypal.cn/api/desktop-auth/authorize）。设备码流无降级路径
      // （user_code 必须在授权页输入），不可信 URL 直接 fail closed，防钓鱼授权页/错误配置跳转。
      if (!isTrustedKaypalUrl(r.body.verification_url, { allowLoopbackHttp: process.env.NODE_ENV === 'test' })) {
        return { ok: false, error: 'DEVICE_FLOW_BAD_RESPONSE', detail: 'verification_url 来源不可信，已拒绝（防钓鱼跳转）' };
      }
      const flow = {
        deviceCode: r.body.device_code,
        userCode: r.body.user_code,
        verificationUrl: r.body.verification_url,
        expiresIn: r.body.expires_in,
        interval: r.body.interval,
        codeVerifier: verifier,
        startedAt: new Date().toISOString(),
      };
      // 含 code_verifier（PKCE 中间凭据），同样 0600 落盘
      atomicWriteJSONPrivate(deviceFlowPath(root), flow);
      return {
        ok: true,
        deviceCode: flow.deviceCode,
        userCode: flow.userCode,
        verificationUrl: flow.verificationUrl,
        expiresIn: flow.expiresIn,
        interval: flow.interval,
      };
    }
    return { ok: false, error: 'DEVICE_FLOW_START_FAILED', detail: `${r.status} ${(r.body && r.body.error) || ''}` };
  } catch (e) {
    return { ok: false, error: 'DEVICE_FLOW_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 轮询授权结果 → { ok:true, status:'authorized', user, device } 或 { ok:false, status:'pending'|'denied'|'expired'|'error' }。
// authorized 时存本地会话（复用 passwordLogin 的 token 结构）并清除 device-flow 临时状态。
async function deviceFlowPoll({ root, _httpsJson } = {}) {
  root = root || dataRoot();
  const http = _httpsJson || httpsJson;
  // 2026-08-31 复核第二轮 P2（Codex #3）：device-flow.json 含短期认证凭据（device_code /
  // PKCE code_verifier），禁符号链接——链接到外部文件时外部 device_code 会被发往 poll。
  // readFileNoSymlink（fd 级 O_NOFOLLOW）：链接/不存在/坏 JSON 一律 fail-closed 视同无授权流。
  let flow = null;
  try {
    flow = JSON.parse(readFileNoSymlink(deviceFlowPath(root)).toString('utf8'));
  } catch (_) {
    flow = null;
  }
  if (!flow || !flow.deviceCode) {
    return { ok: false, error: 'NO_DEVICE_FLOW', status: 'error', detail: '未发起设备授权，请先 start' };
  }
  const deviceId = ensureDeviceId(root);
  try {
    const r = await http('POST', '/api/desktop-auth/poll', {
      device_code: flow.deviceCode,
      device_id: deviceId,
      code_verifier: flow.codeVerifier || '',
    });
    const body = r.body || {};
    if (r.status === 202 || body.status === 'pending') {
      return { ok: false, status: 'pending', interval: body.interval || flow.interval || 5 };
    }
    if (r.status === 403 || body.status === 'denied') {
      try { fs.rmSync(deviceFlowPath(root), { force: true }); } catch { /* ignore */ }
      return { ok: false, status: 'denied', detail: '用户拒绝授权' };
    }
    if (r.status === 410) {
      try { fs.rmSync(deviceFlowPath(root), { force: true }); } catch { /* ignore */ }
      return { ok: false, status: 'expired', detail: body.error || '授权会话已过期' };
    }
    if (r.status === 200 && body.access_token) {
      const auth = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token || null,
        expiresIn: body.expires_in,
        user: body.user || null,
        device: body.device || null,
        loggedInAt: new Date().toISOString(),
      };
      saveDesktopAuth(root, auth);
      try { fs.rmSync(deviceFlowPath(root), { force: true }); } catch { /* ignore */ }
      return { ok: true, status: 'authorized', user: auth.user, device: auth.device };
    }
    return { ok: false, status: 'error', detail: `${r.status} ${body.error || ''}` };
  } catch (e) {
    return { ok: false, status: 'error', detail: String((e && e.message) || e) };
  }
}

// 清除本地会话（desktop-auth.json）与权益缓存（entitlement.json）——设备吊销后不得残留登录态。
function clearLocalAuth(root) {
  root = root || dataRoot();
  try {
    fs.rmSync(authPath(root), { force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(path.join(root, 'license', 'entitlement.json'), { force: true });
  } catch {
    /* ignore */
  }
}

module.exports = {
  passwordLogin,
  refreshAccessToken,
  loadDesktopAuth,
  loadDesktopAuthReadOnly,
  saveDesktopAuth,
  ensureDeviceId,
  revokeDevice,
  clearLocalAuth,
  deviceFlowStart,
  deviceFlowPoll,
  generatePkce,
};
