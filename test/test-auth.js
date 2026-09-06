'use strict';
// 回应审查 P1-6：本地 API 必须鉴权；loopback 不是安全边界。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureToken, tokenPath, authorize, riskOf, hostAllowed, originAllowed, ConfirmStore } = require('../scripts/jz/auth');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-auth-'));

function fakeReq({ method = 'POST', host = '127.0.0.1:18755', origin, token, confirm } = {}) {
  const headers = { host };
  if (origin) headers.origin = origin;
  if (token) headers['x-jz-token'] = token;
  if (confirm) headers['x-jz-confirm'] = confirm;
  return { method, headers };
}

function fakeUrl(p) {
  return new URL(p, 'http://127.0.0.1');
}

test('token 文件权限为 0600 且内容为 64 位十六进制', () => {
  const t = ensureToken(root);
  assert.match(t, /^[0-9a-f]{64}$/);
  // Windows 上 chmod 只支持只读位，mode 恒为 0o666，无法表达 0600（权限模型为 ACL），跳过精确权限断言
  if (process.platform !== 'win32') {
    const st = fs.statSync(tokenPath(root));
    assert.equal(st.mode & 0o777, 0o600);
  }
  assert.equal(ensureToken(root), t, '重复调用应复用同一 token');
});

test('无 token / 错误 token 一律 401 UNAUTHORIZED_LOCAL_REQUEST', () => {
  const t = ensureToken(root);
  const noTok = authorize({ req: fakeReq({ method: 'GET' }), url: fakeUrl('/api/vault/backups'), token: t });
  assert.equal(noTok.ok, false);
  assert.equal(noTok.status, 401);
  assert.equal(noTok.error, 'UNAUTHORIZED_LOCAL_REQUEST');

  const badTok = authorize({
    req: fakeReq({ method: 'GET', token: 'f'.repeat(64) }),
    url: fakeUrl('/api/vault/backups'),
    token: t,
  });
  assert.equal(badTok.ok, false);
  assert.equal(badTok.reason, 'bad_token');
});

test('拒绝非 loopback Host（DNS rebinding）与跨站 Origin', () => {
  const t = ensureToken(root);
  assert.equal(hostAllowed('evil.example.com'), false);
  assert.equal(hostAllowed('127.0.0.1:18755'), true);
  assert.equal(originAllowed('https://evil.example.com'), false);
  assert.equal(originAllowed('http://localhost:3000'), true);

  const r = authorize({
    req: fakeReq({ method: 'GET', host: 'evil.example.com', token: t }),
    url: fakeUrl('/api/vault/backups'),
    token: t,
  });
  assert.equal(r.reason, 'host_not_loopback');

  const r2 = authorize({
    req: fakeReq({ method: 'GET', origin: 'https://evil.example.com', token: t }),
    url: fakeUrl('/api/vault/backups'),
    token: t,
  });
  assert.equal(r2.reason, 'origin_not_loopback');
});

test('高风险路由必须带一次性 confirmToken，且票据单次使用/绑定路由/会过期', () => {
  const t = ensureToken(root);
  const store = new ConfirmStore();
  assert.equal(riskOf('POST', '/api/vault/restore'), 'write_high');
  assert.equal(riskOf('POST', '/api/vault/backup'), 'write_low');
  assert.equal(riskOf('GET', '/api/vault/backups'), 'read');

  const noConfirm = authorize({
    req: fakeReq({ token: t }),
    url: fakeUrl('/api/vault/restore'),
    token: t,
    body: {},
    confirmStore: store,
  });
  assert.equal(noConfirm.ok, false);
  assert.equal(noConfirm.reason, 'confirm_required');

  const issued = store.issue('POST /api/vault/restore');
  const ok = authorize({
    req: fakeReq({ token: t }),
    url: fakeUrl('/api/vault/restore'),
    token: t,
    body: { confirmToken: issued.confirmToken },
    confirmStore: store,
  });
  assert.equal(ok.ok, true);

  // 单次使用：同一票据不能复用
  const replay = authorize({
    req: fakeReq({ token: t }),
    url: fakeUrl('/api/vault/restore'),
    token: t,
    body: { confirmToken: issued.confirmToken },
    confirmStore: store,
  });
  assert.equal(replay.ok, false);

  // 绑定路由：给 restore 的票据不能拿去 purge
  const cross = store.issue('POST /api/vault/restore');
  const misuse = authorize({
    req: fakeReq({ token: t }),
    url: fakeUrl('/api/cleanup/purge'),
    token: t,
    body: { confirmToken: cross.confirmToken },
    confirmStore: store,
  });
  assert.equal(misuse.ok, false);

  // 过期：时间前移 61s
  let now = Date.now();
  const expiring = new ConfirmStore(() => now);
  const tk = expiring.issue('POST /api/vault/restore');
  now += 61 * 1000;
  assert.equal(expiring.consume(tk.confirmToken, 'POST /api/vault/restore'), false);
});

test('本机微信登录与 license refresh 为低风险写操作，不应触发 confirmToken', () => {
  assert.equal(riskOf('POST', '/api/license/refresh'), 'write_low');
  assert.equal(riskOf('POST', '/api/wechat-local/bind/start'), 'write_low');
  assert.equal(riskOf('GET', '/api/wechat-local/bind/status'), 'read');
  assert.equal(riskOf('POST', '/api/wechat-local/login'), 'write_low');
  assert.equal(riskOf('POST', '/api/wechat-local/wechat-scan/start'), 'write_low');
  assert.equal(riskOf('GET', '/api/wechat-local/wechat-scan/poll'), 'read');
});
