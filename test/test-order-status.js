'use strict';
// 订单/订阅状态查询回归测试（2026-09-01，Task#11 重构后语义）：
// order/status 改走 kaypal-pay.checkSubscription——exchange JWT（Cookie 会话）查
// GET /api/pricing/subscription/status?type=individual（2026-09-01 生产实测 200；
// 旧 Bearer kda 路径在 subscribe 类路由会卡 route 层会话校验，统一收敛到 Cookie 链）。
// 注入惯例不变：kaypalHttp 替换 httpsJson（kaypal-pay 全链经 _httpsJson: kHttp 透传），不走真实网络。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KAYPAL_BASE_URL = 'http://127.0.0.1:9'; // 保底黑洞：注入式测试不应触网

const { startRouterServer, jzFetch } = require('./_helpers');
const { saveDesktopAuth } = require('../scripts/jz/desktop-auth');

const TOKEN = crypto.randomBytes(32).toString('hex');

function fakeJwt(payload) {
  return 'h.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.s';
}

test('order/status：未登录 → 401 UNAUTHENTICATED（fail-closed，不触上游）', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-os-anon-'));
  let upstreamCalls = 0;
  const s = await startRouterServer({
    root, token: TOKEN,
    kaypalHttp: () => { upstreamCalls += 1; return Promise.resolve({ status: 200, body: { success: true, data: {} } }); },
  });
  try {
    const r = await jzFetch(s.baseUrl, '/api/license/order/status?type=individual', { token: TOKEN });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, 'UNAUTHENTICATED');
    assert.equal(upstreamCalls, 0, '未登录不得触达上游');
  } finally {
    await s.close();
  }
});

test('order/status：exchange 换 JWT 后带 Cookie 转发 subscription/status（Cookie 链锁死）', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-os-ind-'));
  saveDesktopAuth(root, { accessToken: 'kda_fake_status', refreshToken: null, user: { id: 'u-os-1' }, device: null });
  const calls = [];
  const s = await startRouterServer({
    root, token: TOKEN,
    kaypalHttp: async (method, ep, body, headers) => {
      calls.push({ method, ep, cookie: headers && headers.cookie });
      if (method === 'POST' && ep === '/api/desktop-auth/exchange') {
        return { status: 200, body: { access_token: fakeJwt({ userId: 'u-os-1', tenantId: 't-os', exp: Math.floor(Date.now() / 1000) + 900 }), token_type: 'kaypal_auth', expires_in: 900 } };
      }
      return { status: 200, body: { success: true, data: { hasSubscription: true, status: 'active', expiresAt: '2026-09-25T04:55:58.057Z', planId: 'jz_guard_yearly' } } };
    },
  });
  try {
    const r = await jzFetch(s.baseUrl, '/api/license/order/status', { token: TOKEN });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.data.status, 'active');
    assert.equal(j.data.planId, 'jz_guard_yearly');
    assert.equal(calls.length, 2, '必须先 exchange 再查状态');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].ep, '/api/desktop-auth/exchange', '第一步必须 exchange 换 JWT');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].ep, '/api/pricing/subscription/status?type=individual', `必须转发到真实端点，实际 ${calls[1].ep}`);
    assert.ok(String(calls[1].cookie || '').startsWith('kaypal_auth='), '必须以 Cookie kaypal_auth 携带会话（Bearer 在 subscribe 类路由会卡死）');
  } finally {
    await s.close();
  }
});

test('order/status：type= 参数兼容忽略（恒查 individual）；orderId 兼容忽略；注入失败 → 502 ORDER_STATUS_UNAVAILABLE', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-os-ent-'));
  saveDesktopAuth(root, { accessToken: 'kda_fake_status', refreshToken: null, user: { id: 'u-os-2' }, device: null });
  const eps = [];
  let failMode = false;
  const s = await startRouterServer({
    root, token: TOKEN,
    kaypalHttp: async (method, ep) => {
      if (method === 'POST' && ep === '/api/desktop-auth/exchange') {
        return { status: 200, body: { access_token: fakeJwt({ userId: 'u-os-2', tenantId: 't-os', exp: Math.floor(Date.now() / 1000) + 900 }), expires_in: 900 } };
      }
      eps.push(ep);
      if (failMode) throw new Error('mock boom');
      return { status: 200, body: { success: true, data: { hasSubscription: false, status: 'none' } } };
    },
  });
  try {
    const r1 = await jzFetch(s.baseUrl, '/api/license/order/status?type=enterprise', { token: TOKEN });
    assert.equal(r1.status, 200);
    assert.equal(eps[eps.length - 1], '/api/pricing/subscription/status?type=individual', 'type= 遗留参数兼容忽略，恒查 individual');
    const r2 = await jzFetch(s.baseUrl, '/api/license/order/status?orderId=whatever', { token: TOKEN });
    assert.equal(r2.status, 200, '遗留 orderId 参数不得报错（兼容忽略）');
    failMode = true;
    const r3 = await jzFetch(s.baseUrl, '/api/license/order/status', { token: TOKEN });
    assert.equal(r3.status, 502, '上游异常必须 502 fail-closed');
    assert.equal((await r3.json()).error, 'ORDER_STATUS_UNAVAILABLE', '502 错误码必须 ORDER_STATUS_UNAVAILABLE（不得误标 UNAUTHENTICATED）');
  } finally {
    await s.close();
  }
});
