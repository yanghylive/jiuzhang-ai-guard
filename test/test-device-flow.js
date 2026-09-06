'use strict';
// 设备码登录（RFC 8628 device flow）单测：start 拿 user_code + PKCE、poll 轮询四态、token 落本地会话。
// 真实端到端（用户浏览器输 user_code）需真机 + kaypal 生产；此处用 fake _httpsJson 覆盖逻辑分支。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  deviceFlowStart,
  deviceFlowPoll,
  generatePkce,
  loadDesktopAuth,
} = require('../scripts/jz/desktop-auth');

function tmpRoot(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function deviceFlowFile(root) {
  return path.join(root, 'license', 'device-flow.json');
}

test('generatePkce：verifier 43 字符，challenge = sha256(verifier) base64url', () => {
  const { verifier, challenge } = generatePkce();
  assert.equal(verifier.length, 43);
  const expected = require('node:crypto').createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
});

test('deviceFlowStart：成功 → 返回 user_code/verification_url，持久化含 code_verifier，且请求带 S256 PKCE', async () => {
  const root = tmpRoot('jz-df-start-');
  let capturedBody = null;
  const fakeHttp = async (method, p, body) => {
    capturedBody = body;
    return {
      status: 201,
      body: {
        device_code: 'dev_abc',
        user_code: 'ABCD-EFGH',
        verification_url: 'https://kaypal.cn/api/desktop-auth/authorize?device_code=dev_abc&user_code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
      },
    };
  };
  const r = await deviceFlowStart({ deviceName: 'JIUZHANG AI 管家', platform: 'desktop', root, _httpsJson: fakeHttp });
  assert.equal(r.ok, true);
  assert.equal(r.userCode, 'ABCD-EFGH');
  assert.equal(r.verificationUrl.includes('/api/desktop-auth/authorize'), true);
  assert.equal(r.interval, 5);
  // PKCE 请求体
  assert.equal(capturedBody.code_challenge_method, 'S256');
  assert.ok(capturedBody.code_challenge && capturedBody.code_challenge.length > 0);
  // 持久化：含 deviceCode + codeVerifier，不落 token
  const flow = JSON.parse(fs.readFileSync(deviceFlowFile(root), 'utf8'));
  assert.equal(flow.deviceCode, 'dev_abc');
  assert.ok(flow.codeVerifier);
  assert.ok(!flow.accessToken);
});

test('deviceFlowStart：kaypal 非 201 → DEVICE_FLOW_START_FAILED（fail-closed）', async () => {
  const root = tmpRoot('jz-df-start-fail-');
  const r = await deviceFlowStart({ root, _httpsJson: async () => ({ status: 500, body: { error: 'boom' } }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'DEVICE_FLOW_START_FAILED');
});

test('deviceFlowStart：网络异常 → DEVICE_FLOW_UNAVAILABLE', async () => {
  const root = tmpRoot('jz-df-start-net-');
  const r = await deviceFlowStart({ root, _httpsJson: async () => { throw new Error('net down'); } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'DEVICE_FLOW_UNAVAILABLE');
});

test('deviceFlowPoll：未 start → NO_DEVICE_FLOW', async () => {
  const root = tmpRoot('jz-df-poll-none-');
  const r = await deviceFlowPoll({ root, _httpsJson: async () => ({ status: 200, body: {} }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_DEVICE_FLOW');
});

test('deviceFlowPoll：pending（202）→ status=pending 且保留状态', async () => {
  const root = tmpRoot('jz-df-poll-pending-');
  await deviceFlowStart({ root, _httpsJson: async () => ({ status: 201, body: { device_code: 'dev_1', user_code: 'AAAA-BBBB', verification_url: 'https://kaypal.cn/api/desktop-auth/authorize?device_code=dev_ok', expires_in: 600, interval: 5 } }) });
  const r = await deviceFlowPoll({ root, _httpsJson: async () => ({ status: 202, body: { status: 'pending', interval: 5 } }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'pending');
  assert.equal(r.interval, 5);
  assert.ok(fs.existsSync(deviceFlowFile(root)), 'pending 不应清除 device-flow 状态');
});

test('deviceFlowPoll：denied（403）→ status=denied 且清除状态', async () => {
  const root = tmpRoot('jz-df-poll-denied-');
  await deviceFlowStart({ root, _httpsJson: async () => ({ status: 201, body: { device_code: 'dev_2', user_code: 'AAAA-BBBB', verification_url: 'https://kaypal.cn/api/desktop-auth/authorize?device_code=dev_ok', expires_in: 600, interval: 5 } }) });
  const r = await deviceFlowPoll({ root, _httpsJson: async () => ({ status: 403, body: { status: 'denied' } }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'denied');
  assert.ok(!fs.existsSync(deviceFlowFile(root)), 'denied 应清除 device-flow 状态');
});

test('deviceFlowPoll：authorized（200）→ ok:true 存 token 并清临时态', async () => {
  const root = tmpRoot('jz-df-poll-auth-');
  await deviceFlowStart({ root, _httpsJson: async () => ({ status: 201, body: { device_code: 'dev_3', user_code: 'AAAA-BBBB', verification_url: 'https://kaypal.cn/api/desktop-auth/authorize?device_code=dev_ok', expires_in: 600, interval: 5 } }) });
  const r = await deviceFlowPoll({
    root,
    _httpsJson: async () => ({
      status: 200,
      body: {
        status: 'authorized',
        access_token: 'kda_deviceflow',
        refresh_token: 'kdr_deviceflow',
        expires_in: 3600,
        token_type: 'Bearer',
        device: { id: 'did', device_id: 'jz-x', name: 'JIUZHANG AI 管家', platform: 'desktop' },
        user: { id: 'u123' },
      },
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'authorized');
  assert.equal(r.user.id, 'u123');
  // token 落本地会话
  const auth = loadDesktopAuth(root);
  assert.equal(auth.accessToken, 'kda_deviceflow');
  assert.equal(auth.refreshToken, 'kdr_deviceflow');
  // 临时态清除
  assert.ok(!fs.existsSync(deviceFlowFile(root)), 'authorized 应清除 device-flow 状态');
});

test('deviceFlowPoll：expired（410）→ status=expired 且清除状态', async () => {
  const root = tmpRoot('jz-df-poll-exp-');
  await deviceFlowStart({ root, _httpsJson: async () => ({ status: 201, body: { device_code: 'dev_4', user_code: 'AAAA-BBBB', verification_url: 'https://kaypal.cn/api/desktop-auth/authorize?device_code=dev_ok', expires_in: 600, interval: 5 } }) });
  const r = await deviceFlowPoll({ root, _httpsJson: async () => ({ status: 410, body: { error: '授权会话已过期' } }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'expired');
  assert.ok(!fs.existsSync(deviceFlowFile(root)), 'expired 应清除 device-flow 状态');
});

// Codex 复核 P2 修复回归（2026-09-05）：verification_url 白名单 fail closed
test('deviceFlowStart：verification_url 非 Kaypal 官方域 → fail closed 不落盘（防钓鱼授权页）', async () => {
  const root = tmpRoot('jz-df-bad-url-');
  const r = await deviceFlowStart({
    root,
    _httpsJson: async () => ({ status: 201, body: { device_code: 'dev_9', user_code: 'AAAA-BBBB', verification_url: 'https://evil.example.com/authorize', expires_in: 600, interval: 5 } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'DEVICE_FLOW_BAD_RESPONSE');
  assert.ok(!fs.existsSync(deviceFlowFile(root)), '不可信 URL 不得落盘 device-flow');
  // http 明文（即便 host 看着合法）同样拒绝
  const r2 = await deviceFlowStart({
    root,
    _httpsJson: async () => ({ status: 201, body: { device_code: 'dev_10', user_code: 'AAAA-BBBB', verification_url: 'http://kaypal.cn/authorize', expires_in: 600, interval: 5 } }),
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'DEVICE_FLOW_BAD_RESPONSE');
});
