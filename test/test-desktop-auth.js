'use strict';
// desktop-auth 单测：未配置/缺参 fail-closed + 设备 ID 持久化。
// 成功路径（真实密码登录）需真机（已在本会话用 13800138000 真机验证过）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { passwordLogin, ensureDeviceId, loadDesktopAuth } = require('../scripts/jz/desktop-auth');

test('ensureDeviceId：首次生成并持久化，再次读取一致', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-da-root-'));
  const id1 = ensureDeviceId(root);
  const id2 = ensureDeviceId(root);
  assert.ok(id1.startsWith('jz-'));
  assert.equal(id1, id2, '设备 ID 应持久化稳定');
});

test('passwordLogin：缺 phone/password → INVALID_REQUEST（不发网络）', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-da-root2-'));
  const r = await passwordLogin({ root });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID_REQUEST');
});

test('passwordLogin：仅缺 password → INVALID_REQUEST', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-da-root3-'));
  const r = await passwordLogin({ phone: '13800138000', root });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID_REQUEST');
});

test('loadDesktopAuth：无会话 → null', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-da-root4-'));
  assert.equal(loadDesktopAuth(root), null);
});

test('revokeDevice：kaypal 吊销成功 → 清本地会话与权益缓存', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { revokeDevice, saveDesktopAuth } = require('../scripts/jz/desktop-auth');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-revoke-'));
  saveDesktopAuth(root, { accessToken: 'kda_test-token', refreshToken: 'kdr_t', user: { id: 'u1' }, device: { device_id: 'dev1' } });
  fs.writeFileSync(path.join(root, 'license', 'entitlement.json'), JSON.stringify({ status: 'active' }));

  const fakeHttp = async (method, p, body, headers) => ({ status: 200, body: { status: 'revoked', device_id: 'jz-xxx' } });
  const r = await revokeDevice({ root, _httpsJson: fakeHttp });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'revoked');
  assert.ok(!fs.existsSync(path.join(root, 'license', 'desktop-auth.json')), '会话文件应清除');
  assert.ok(!fs.existsSync(path.join(root, 'license', 'entitlement.json')), '权益缓存应清除');
});

test('revokeDevice：未登录 → NOT_LOGGED_IN；网络失败 → 保留本地态', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { revokeDevice } = require('../scripts/jz/desktop-auth');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-revoke2-'));
  const none = await revokeDevice({ root, _httpsJson: async () => ({ status: 200, body: {} }) });
  assert.equal(none.error, 'NOT_LOGGED_IN');

  // 已登录但网络失败 → 保留
  const { saveDesktopAuth } = require('../scripts/jz/desktop-auth');
  saveDesktopAuth(root, { accessToken: 'kda_t', user: { id: 'u1' } });
  const fail = await revokeDevice({ root, _httpsJson: async () => { throw new Error('network down'); } });
  assert.equal(fail.ok, false);
  assert.equal(fail.error, 'REVOKE_UNAVAILABLE');
  assert.ok(fs.existsSync(path.join(root, 'license', 'desktop-auth.json')), '网络失败应保留本地会话');
});

test('refreshAccessToken（07-D37）：成功更新会话 / refresh 失效提示重登且不删本地数据', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { refreshAccessToken, saveDesktopAuth, loadDesktopAuth } = require('../scripts/jz/desktop-auth');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-refresh-'));

  // 场景 1：无 refreshToken
  let r = await refreshAccessToken({ root });
  assert.equal(r.error, 'NO_REFRESH_TOKEN');

  // 场景 2：刷新成功 → 会话更新
  saveDesktopAuth(root, { accessToken: 'kda_old', refreshToken: 'kdr_valid', user: { id: 'u1' } });
  r = await refreshAccessToken({ root, _httpsJson: async () => ({ status: 200, body: { access_token: 'kda_new', expires_in: 3600 } }) });
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'kda_new');
  const after = loadDesktopAuth(root);
  assert.equal(after.accessToken, 'kda_new');
  assert.equal(after.refreshToken, 'kdr_valid'); // 服务端未发新 refresh → 保留旧的
  assert.ok(after.refreshedAt);

  // 场景 3：refresh token 失效 → needRelogin，本地数据保留
  r = await refreshAccessToken({ root, _httpsJson: async () => ({ status: 401, body: {} }) });
  assert.equal(r.ok, false);
  assert.equal(r.needRelogin, true);
  assert.ok(loadDesktopAuth(root), '失败不应删本地会话文件');

  fs.rmSync(root, { recursive: true, force: true });
});
