'use strict';
// OIDC 登录（kaypal authorization_code + PKCE）。本地应用（public client）用 PKCE 免 client_secret。
// 端点（实测）：{base}/api/oidc/authorize（response_type=code + code_challenge）+ /api/oidc/token（authorization_code+code_verifier）
// + /api/oidc/userinfo。会话（verifier/token/userinfo）存本地数据目录，不落明文日志。
const crypto = require('node:crypto');
const https = require('node:https');
const path = require('node:path');
const { dataRoot, readJSON, atomicWriteJSONPrivate, ensurePrivateMode } = require('./lib');
const { atomicWriteCredFile, readCredFile } = require('./crypto-vault');
const { redactString } = require('./redact');

const OIDC_BASE = process.env.KAYPAL_OIDC_BASE || 'https://kaypal.cn';
const CLIENT_ID = process.env.KAYPAL_OIDC_CLIENT_ID || 'jz-ai-guard';
// kaypal 登录流程会把 loopback 回调 host 归一化成 localhost（实测：authorize 传 127.0.0.1，
// 回调/授权码绑定的是 localhost），故 REDIRECT_URI 必须用 localhost，否则 token 交换 redirect_uri
// 不匹配 → invalid_grant。daemon 绑 127.0.0.1，本机 localhost 同样可达。
const REDIRECT_URI = process.env.KAYPAL_OIDC_REDIRECT_URI || 'http://localhost:18755/api/oidc/callback';

function httpsJson(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlPath, OIDC_BASE);
    } catch (e) {
      return reject(e);
    }
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(
      url,
      {
        method,
        headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, headers || {}),
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null });
          } catch {
            resolve({ status: res.statusCode, body: b || null });
          }
        });
      },
    );
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// PKCE S256：code_verifier（32B base64url）+ code_challenge（sha256(verifier) base64url）。
function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// 构造授权 URL（用户浏览器打开，完成登录后回调 redirect_uri?code=...&state=...）。
function buildAuthorizeUrl({ challenge, state }) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${OIDC_BASE}/api/oidc/authorize?${params.toString()}`;
}

// 用 code + code_verifier 换 token（authorization_code grant）。
async function exchangeToken({ code, verifier }) {
  const r = await httpsJson('POST', '/api/oidc/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  if (r.status === 200 && r.body && r.body.access_token) {
    return { ok: true, accessToken: r.body.access_token, refreshToken: r.body.refresh_token || null, idToken: r.body.id_token || null, expiresIn: r.body.expires_in };
  }
  return { ok: false, error: 'OIDC_TOKEN_FAILED', detail: redactString(`${r.status} ${JSON.stringify(r.body || '')}`) };
}

// 用 access_token 查 userinfo。
async function getUserInfo(accessToken) {
  const r = await httpsJson('GET', '/api/oidc/userinfo', null, { authorization: `Bearer ${accessToken}` });
  if (r.status === 200 && r.body) return { ok: true, user: r.body };
  return { ok: false, error: 'OIDC_USERINFO_FAILED', detail: `${r.status}` };
}

// —— 本地会话（state → verifier 关联；token + userinfo 持久化）——
function authPath(root) {
  return path.join(root, 'license', 'oidc-auth.json');
}

function saveAuth(root, auth) {
  root = root || dataRoot();
  // 2026-08-29 复核 P1：access/refresh token 不再 0600 明文落盘，改平台密钥加密（Keychain/DPAPI/0600 三级）
  atomicWriteCredFile(root, authPath(root), auth);
  return auth;
}

function loadAuth(root) {
  root = root || dataRoot();
  // 读取：优先解密 v2 密文；旧明文自动识别并迁移为加密
  return readCredFile(root, authPath(root));
}

module.exports = { OIDC_BASE, CLIENT_ID, REDIRECT_URI, httpsJson, generatePkce, buildAuthorizeUrl, exchangeToken, getUserInfo, saveAuth, loadAuth };
