'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { nextState, requestDeviceCode, pollDeviceToken } = require('../scripts/jz/kaypal-license');

test('授权缓存防伪（P0）：手改 entitlement.json（伪造 Pro）→ MAC 校验失败视为无缓存', async () => {
  // 篡改场景：攻击者直接把 validUntil 改成未来 / status 改成 active（无合法 MAC）
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-tamper-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  const fake = {
    status: 'active',
    plan: 'pro_yearly',
    validUntil: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    balance: 999,
  };
  fs.writeFileSync(path.join(root, 'license', 'entitlement.json'), JSON.stringify(fake));
  // 无凭据时：缓存被拒绝 → not_configured 而不是信任伪造缓存
  const savedKey = process.env.KAYPAL_APP_CREDENTIAL;
  const savedSecret = process.env.KAYPAL_CONTEXT_JWT_SECRET;
  delete process.env.KAYPAL_APP_CREDENTIAL;
  delete process.env.KAYPAL_CONTEXT_JWT_SECRET;
  try {
    const modPath = require.resolve('../scripts/jz/kaypal-license');
    delete require.cache[modPath];
    const kl = require('../scripts/jz/kaypal-license');
    const r = await kl.getStatus({ root });
    assert.equal(r.ok, false, '伪造缓存不得被信任');
    assert.equal(r.degrade, 'not_configured');
  } finally {
    if (savedKey === undefined) delete process.env.KAYPAL_APP_CREDENTIAL;
    else process.env.KAYPAL_APP_CREDENTIAL = savedKey;
    if (savedSecret === undefined) delete process.env.KAYPAL_CONTEXT_JWT_SECRET;
  }
});

test('会员状态机：撤销/过期', () => {
  assert.equal(nextState('pro_yearly', 'revoke'), 'revoked');
  assert.equal(nextState('pro_yearly', 'expire'), 'expired');
});

test('会员状态机：未知事件保持原状/默认 free', () => {
  assert.equal(nextState('pro_lifetime', 'login'), 'pro_lifetime');
  assert.equal(nextState(undefined, 'foo'), 'free');
});

// —— 设备码 OAuth（RFC 8628）骨架：未配置 fail-closed + 注入 httpsJson 测流程 ——

test('requestDeviceCode：未配置端点/client_id → fail-closed', async () => {
  delete process.env.KAYPAL_OAUTH_DEVICE_ENDPOINT;
  delete process.env.KAYPAL_OAUTH_CLIENT_ID;
  const r = await requestDeviceCode({});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'LICENSE_UNAVAILABLE');
});

test('requestDeviceCode：已配置 + 端点返回 device_code → ok', async () => {
  process.env.KAYPAL_OAUTH_DEVICE_ENDPOINT = 'https://x/oauth/device';
  process.env.KAYPAL_OAUTH_CLIENT_ID = 'client-1';
  const fake = async (method, url, body) => ({
    status: 200,
    body: { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri_complete: 'https://x/device?code=ABCD-EFGH', expires_in: 600, interval: 5 },
  });
  const r = await requestDeviceCode({ _httpsJson: fake });
  assert.equal(r.ok, true);
  assert.equal(r.deviceCode, 'dev-1');
  assert.equal(r.userCode, 'ABCD-EFGH');
  delete process.env.KAYPAL_OAUTH_DEVICE_ENDPOINT;
  delete process.env.KAYPAL_OAUTH_CLIENT_ID;
});

test('pollDeviceToken：未配置 token 端点 → fail-closed', async () => {
  delete process.env.KAYPAL_OAUTH_TOKEN_ENDPOINT;
  const r = await pollDeviceToken({ deviceCode: 'dev-1' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'LICENSE_UNAVAILABLE');
});

test('pollDeviceToken：authorization_pending → AUTHORIZATION_PENDING', async () => {
  process.env.KAYPAL_OAUTH_TOKEN_ENDPOINT = 'https://x/oauth/token';
  process.env.KAYPAL_OAUTH_CLIENT_ID = 'client-1';
  const fake = async () => ({ status: 400, body: { error: 'authorization_pending' } });
  const r = await pollDeviceToken({ deviceCode: 'dev-1', _httpsJson: fake });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'AUTHORIZATION_PENDING');
  delete process.env.KAYPAL_OAUTH_TOKEN_ENDPOINT;
  delete process.env.KAYPAL_OAUTH_CLIENT_ID;
});

test('pollDeviceToken：返回 access_token → ok', async () => {
  process.env.KAYPAL_OAUTH_TOKEN_ENDPOINT = 'https://x/oauth/token';
  process.env.KAYPAL_OAUTH_CLIENT_ID = 'client-1';
  const fake = async () => ({ status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1' } });
  const r = await pollDeviceToken({ deviceCode: 'dev-1', _httpsJson: fake });
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'at-1');
  delete process.env.KAYPAL_OAUTH_TOKEN_ENDPOINT;
  delete process.env.KAYPAL_OAUTH_CLIENT_ID;
});

test('getStatus 离线降级分类：not_configured / server_rejected / timeout / network_error / cache_expired', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const modPath = require.resolve('../scripts/jz/kaypal-license');
  // API_KEY/JWT_SECRET 是模块加载时常量 → 每次改 env 后清 require.cache 重载
  const load = () => { delete require.cache[modPath]; return require('../scripts/jz/kaypal-license'); };
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-degrade-'));
  const savedKey = process.env.KAYPAL_APP_CREDENTIAL;
  const savedSecret = process.env.KAYPAL_CONTEXT_JWT_SECRET;

  try {
    // not_configured：无凭据
    delete process.env.KAYPAL_APP_CREDENTIAL;
    delete process.env.KAYPAL_CONTEXT_JWT_SECRET;
    let r = await load().getStatus({ force: true, root });
    assert.equal(r.ok, false);
    assert.equal(r.degrade, 'not_configured');

    // server_rejected：有凭据但服务端 4xx
    process.env.KAYPAL_APP_CREDENTIAL = 'test-key';
    process.env.KAYPAL_CONTEXT_JWT_SECRET = 'test-secret';
    r = await load().getStatus({ force: true, root, _httpsJson: async () => ({ status: 401, body: { error: 'no' } }) });
    assert.equal(r.degrade, 'server_rejected');
    assert.equal(r.ok, false);

    // network_error：网络异常（无缓存）
    r = await load().getStatus({ force: true, root, _httpsJson: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(r.degrade, 'network_error');

    // timeout：超时异常（无缓存）
    r = await load().getStatus({ force: true, root, _httpsJson: async () => { throw new Error('timeout of 5000ms exceeded'); } });
    assert.equal(r.degrade, 'timeout');

    // cache_expired：有缓存但 validUntil 已过 + 网络失败
    // 2026-08-29 复核 P0：entitlement 缓存带 HMAC，测试必须用 saveEntitlementCache 写入合法缓存
    //（直接写明文会被 MAC 校验拒绝 → 视为无缓存，这是防本地伪造权益的新安全行为）。
    const kl = load();
    kl.saveEntitlementCache(root, {
      status: 'active', validUntil: new Date(Date.now() - 3600 * 1000).toISOString(),
    });
    r = await load().getStatus({ force: true, root, _httpsJson: async () => { throw new Error('network down'); } });
    assert.equal(r.ok, true);
    assert.equal(r.degrade, 'cache_expired');
  } finally {
    if (savedKey === undefined) delete process.env.KAYPAL_APP_CREDENTIAL;
    else process.env.KAYPAL_APP_CREDENTIAL = savedKey;
    if (savedSecret === undefined) delete process.env.KAYPAL_CONTEXT_JWT_SECRET;
    else process.env.KAYPAL_CONTEXT_JWT_SECRET = savedSecret;
  }
});

test('会员状态审计（07-D47）：plan/status 变更时写 membership-audit.json（无敏感字段，保留 50 条）', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { auditMembershipChange } = require('../scripts/jz/kaypal-license');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-audit-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });

  auditMembershipChange(root, { from: 'none', to: 'active/pro_yearly', source: 'kaypal', detail: 'first check' });
  auditMembershipChange(root, { from: 'active/pro_yearly', to: 'denied/free', source: 'kaypal', detail: 'expired' });

  const list = JSON.parse(fs.readFileSync(path.join(root, 'license', 'membership-audit.json'), 'utf8'));
  assert.equal(list.length, 2);
  assert.equal(list[0].from, 'none');
  assert.equal(list[1].to, 'denied/free');
  assert.ok(list[0].at, '应有时间戳');
  // 无敏感字段
  const raw = fs.readFileSync(path.join(root, 'license', 'membership-audit.json'), 'utf8');
  assert.ok(!/token|cookie|password/i.test(raw), '审计不得含 token/cookie/password');

  fs.rmSync(root, { recursive: true, force: true });
});
