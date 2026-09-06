'use strict';
// Codex 复核修复回归（2026-09-01）：
// 1) bizKey 含券码：跨幂等键换券不再回放旧券订单（P1）
// 2) PAY_UNAVAILABLE（网络不确定）保留 pending 窗口；确定性失败立即清除（P1）
// 3) 券码规范化 trim：'  X  ' 与 'X' 同指纹（P2）
// mock 方式：createRouter 的 kaypalHttp 注入点替换 httpsJson，全链模拟 exchange/subscribe/create。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startRouterServer, jzFetch } = require('./_helpers');
const { saveDesktopAuth } = require('../scripts/jz/desktop-auth');
const kaypalPay = require('../scripts/jz/kaypal-pay');

const TOKEN = crypto.randomBytes(32).toString('hex');

// 造一个 kaypal-pay 能解的假 JWT（payload 含 userId/tenantId，无需真签名——decodeJwtPayload 不验签）
function fakeJwt(userId, tenantId) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256' })}.${enc({ userId, tenantId })}.${enc({ sig: 1 })}`;
}

/**
 * 构造 mock kaypal http。行为由 handlers 决定：
 *   handlers.subscribe(reqBody)  → { status, body } 或 throw
 *   handlers.create(reqBody)     → { status, body } 或 throw
 * 记录 calls 供断言（含每次请求的路径与 body）。
 */
function makeKaypalMock({ userId, tenantId, subscribe, create } = {}) {
  const calls = [];
  return {
    calls,
    http: async (method, urlPath, body) => {
      calls.push({ method, urlPath, body });
      if (urlPath === '/api/desktop-auth/exchange') {
        return { status: 200, body: { access_token: fakeJwt(userId, tenantId), token_type: 'kaypal_auth', expires_in: 900, user: { id: userId } } };
      }
      if (urlPath === '/api/pricing/subscribe') {
        if (!subscribe) throw new Error('unexpected subscribe');
        return subscribe(body);
      }
      if (urlPath === '/api/payment/create') {
        if (!create) throw new Error('unexpected create');
        return create(body);
      }
      return { status: 404, body: { error: 'not mocked: ' + urlPath } };
    },
  };
}

function successSubscribe(priceYuan) {
  return (reqBody) => ({ status: 200, body: { success: true, data: { id: 'so_' + crypto.randomBytes(6).toString('hex'), planId: reqBody.planId, price: priceYuan, status: 'pending' } } });
}
function okCreate() {
  return (reqBody) => ({ status: 200, body: { success: true, formOrRedirectUrl: 'weixin://wxpay/bitexample_' + crypto.randomBytes(4).toString('hex'), orderNo: 'W' + crypto.randomBytes(8).toString('hex') } });
}
// 探测/重放返回指定 orderNo（模拟 kaypal 同兜底键命中旧单：重放或同单号重挂）
function okCreateWithNo(orderNo) {
  return () => ({ status: 200, body: { success: true, formOrRedirectUrl: 'weixin://wxpay/bitexample_' + crypto.randomBytes(4).toString('hex'), orderNo } });
}

function setupRoot() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-codexfix-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  saveDesktopAuth(root, { accessToken: 'kda_fake_codexfix', refreshToken: null, user: { id: 'u-codexfix' }, device: null });
  return root;
}

function readIdem(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'license', 'purchase-idempotency.json'), 'utf8'));
}

test('跨幂等键换券不再回放旧券订单（Codex P1）：bizKey 含券码，换券=新窗口=重新建单', async () => {
  kaypalPay._resetJwtMemo();
  const root = setupRoot();
  const mock = makeKaypalMock({ userId: 'u-codexfix-a', tenantId: 't-1', subscribe: successSubscribe(99), create: okCreate() });
  const s = await startRouterServer({ root, token: TOKEN, kaypalHttp: mock.http });
  try {
    const body = (key, cc) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key, couponCode: cc });
    // 首单：券 A → 200 成功（success 记录落库，bizKey=...:COUPON_A）
    const r1 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('cf-key-001', 'COUPON_A') });
    assert.equal(r1.status, 200);
    const d1 = (await r1.json()).data;
    assert.ok(d1.orderNo, '首单必须拿到微信支付单');

    // 修复前：bizKey 只到 planId 粒度 → 换券换键重试直接回放券 A 旧订单（200 同 orderNo，新券被静默丢弃）
    // 修复后：bizKey 含券码 → 换券 = 新保护窗口 → 重新走全链建新单（券 B 透传 subscribe）
    const r2 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('cf-key-002', 'COUPON_B') });
    assert.equal(r2.status, 200, '换券换键必须重新建单而非回放');
    const d2 = (await r2.json()).data;
    assert.notEqual(d2.orderNo, d1.orderNo, '新单 orderNo 必须不同（非回放旧券订单）');

    // 券 B 确实透传到了 kaypal subscribe
    const subCalls = mock.calls.filter((c) => c.urlPath === '/api/pricing/subscribe');
    assert.equal(subCalls.length, 2, '换券必须发起第二次 subscribe');
    assert.equal(subCalls[0].body.couponCode, 'COUPON_A');
    assert.equal(subCalls[1].body.couponCode, 'COUPON_B');

    // 同券同套餐（换键）→ 仍被窗口拦截回放（防重复下单语义不变）
    const r3 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('cf-key-003', 'COUPON_A') });
    assert.equal(r3.status, 200, '同券换键在窗口内回放首次成功');
    assert.equal((await r3.json()).data.orderNo, d1.orderNo, '同券回放同一订单');
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PAY_UNAVAILABLE 保留 pending；确定性失败（subscribe 400）立即清除（Codex P1）', async () => {
  kaypalPay._resetJwtMemo();
  const root = setupRoot();
  // (a) 网络不确定：subscribe throw → PAY_UNAVAILABLE → pending 必须保留
  const mockNet = makeKaypalMock({
    userId: 'u-codexfix-b', tenantId: 't-1',
    subscribe: () => { throw new Error('ECONNRESET'); },
  });
  const s1 = await startRouterServer({ root, token: TOKEN, kaypalHttp: mockNet.http });
  try {
    const body = (key) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key });
    const r1 = await jzFetch(s1.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('cfnet-key-001') });
    assert.equal(r1.status, 502);
    assert.ok(readIdem(root).records.some((x) => x.result === 'pending'), '不确定失败必须保留 pending 痕迹');
    // 换 key 重试 → 409 PURCHASE_PENDING（窗口保护）
    const r2 = await jzFetch(s1.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('cfnet-key-002') });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).error, 'PURCHASE_PENDING');
  } finally {
    await s1.close();
  }

  // (b) 确定性失败：subscribe 返回 400 → SUBSCRIBE_FAILED → pending 必须清除，可立即重试
  fs.rmSync(root, { recursive: true, force: true });
  const root2 = setupRoot();
  let subscribeHits = 0;
  const mock400 = makeKaypalMock({
    userId: 'u-codexfix-c', tenantId: 't-1',
    subscribe: () => { subscribeHits++; return { status: 400, body: { success: false, error: 'plan not found' } }; },
  });
  const s2 = await startRouterServer({ root: root2, token: TOKEN, kaypalHttp: mock400.http });
  try {
    const body = (key) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key });
    const r1 = await jzFetch(s2.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('cf400-key-001') });
    assert.equal(r1.status, 502, '确定性失败 502');
    assert.equal((await r1.json()).error, 'SUBSCRIPTION_FAILED');
    assert.ok(!readIdem(root2).records.some((x) => x.result === 'pending'), '确定性失败必须清除 pending 痕迹');
    // 换 key 立即重试 → 不被窗口拦截，重新走链路（第二次 subscribe 被调用）
    const r2 = await jzFetch(s2.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('cf400-key-002') });
    assert.equal(r2.status, 502, '确定性失败可立即重试（非 409）');
    assert.notEqual((await r2.json()).error, 'PURCHASE_PENDING');
    assert.equal(subscribeHits, 2, '重试必须真实到达 kaypal（subscribe 第二次被调）');
  } finally {
    await s2.close();
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test('券码规范化 trim（Codex P2）：同键 \'  X  \' 与 \'X\' 同指纹 → PURCHASE_PENDING 而非 CONFLICT', async () => {
  kaypalPay._resetJwtMemo();
  const root = setupRoot();
  const mock = makeKaypalMock({
    userId: 'u-codexfix-d', tenantId: 't-1',
    subscribe: () => { throw new Error('ECONNRESET'); }, // 不确定失败，留 pending
  });
  const s = await startRouterServer({ root, token: TOKEN, kaypalHttp: mock.http });
  try {
    const r1 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: { planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: 'ctrim-key-001', couponCode: '  COUPON_A  ' } });
    assert.equal(r1.status, 502);
    // 修复前：'  COUPON_A  ' ≠ 'COUPON_A' 指纹不同 → IDEMPOTENCY_CONFLICT
    // 修复后：trim 归一 → 同键同参 → 走 pending 窗口
    const r2 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: { planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: 'ctrim-key-001', couponCode: 'COUPON_A' } });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).error, 'PURCHASE_PENDING', 'trim 后同券必须视为同参，走 pending 而非冲突');
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== 分享券功能接入（Codex 复核第二轮功能缺口闭环）=====

test('分享券：GET share → kaypal referral/coupon（POST getOrCreate）；POST claim → referral/claim；未登录 401', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-sharefix-'));
  // 未登录（不写 desktop-auth）→ 401 fail-closed
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  const s1 = await startRouterServer({ root, token: TOKEN, kaypalHttp: async () => { throw new Error('should not be called'); } });
  try {
    const unauth = await jzFetch(s1.baseUrl, '/api/license/coupon/share', { token: TOKEN });
    assert.equal(unauth.status, 401, '未登录查分享链接必须 401');
    const unauthClaim = await jzFetch(s1.baseUrl, '/api/license/coupon/claim', { method: 'POST', token: TOKEN, body: { shareCode: 'X' } });
    assert.equal(unauthClaim.status, 401, '未登录领券必须 401');
  } finally {
    await s1.close();
  }

  // 已登录：全链 mock kaypal
  const root2 = setupRoot();
  const calls = [];
  const mockShare = {
    http: async (method, urlPath, body, headers) => {
      calls.push({ method, urlPath, body, auth: headers && headers.authorization });
      if (urlPath === '/api/operation/user/referral/coupon') {
        assert.equal(method, 'POST', 'referral/coupon 必须 POST（getOrCreate 语义，GET 会 405）');
        assert.ok(/^Bearer kda_/.test(headers.authorization), '必须携带 kda Bearer');
        return { status: 200, body: { success: true, data: { shareCode: 'SHARE_ABC', shareUrl: 'https://kaypal.cn/r/SHARE_ABC' } } };
      }
      if (urlPath === '/api/operation/user/referral/claim') {
        assert.equal(method, 'POST');
        assert.equal(body.shareCode, 'SHARE_XYZ');
        return { status: 200, body: { success: true, data: { couponCode: 'REFERRAL_80', discount: 80 } } };
      }
      return { status: 404, body: { error: 'not mocked: ' + urlPath } };
    },
  };
  const s2 = await startRouterServer({ root: root2, token: TOKEN, kaypalHttp: mockShare.http });
  try {
    const share = await jzFetch(s2.baseUrl, '/api/license/coupon/share', { token: TOKEN });
    assert.equal(share.status, 200);
    const sj = await share.json();
    assert.equal(sj.data.share.shareCode, 'SHARE_ABC');

    // 缺 shareCode → 400
    const bad = await jzFetch(s2.baseUrl, '/api/license/coupon/claim', { method: 'POST', token: TOKEN, body: {} });
    assert.equal(bad.status, 400);

    // 正常领券
    const claim = await jzFetch(s2.baseUrl, '/api/license/coupon/claim', { method: 'POST', token: TOKEN, body: { shareCode: 'SHARE_XYZ' } });
    assert.equal(claim.status, 200);
    const cj = await claim.json();
    assert.equal(cj.data.couponCode, 'REFERRAL_80');
    assert.equal(calls.filter((c) => c.urlPath === '/api/operation/user/referral/claim').length, 1);
  } finally {
    await s2.close();
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test('支付建单必须携带会话（Codex P1 第二轮）：createWechatPayment 带 kaypal_auth cookie，不再声明 userId', async () => {
  kaypalPay._resetJwtMemo();
  const root = setupRoot();
  let createCalls = 0;
  const baseHttp = makeKaypalMock({ userId: 'u-codexfix-e', tenantId: 't-1', subscribe: successSubscribe(99), create: okCreate() });
  const wrappedHttp = async (method, urlPath, body, headers) => {
    if (urlPath === '/api/payment/create') {
      createCalls++;
      assert.ok(/kaypal_auth=/.test((headers && headers.cookie) || ''), 'payment/create 必须带 kaypal_auth 会话 cookie');
      assert.ok(!('userId' in body), '本地不得再声明 userId（服务端以会话为准）');
    }
    return baseHttp.http(method, urlPath, body, headers);
  };
  const s = await startRouterServer({ root, token: TOKEN, kaypalHttp: wrappedHttp });
  try {
    const r = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: { planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: 'authz-key-001' } });
    assert.equal(r.status, 200, '带会话建单必须成功');
    assert.equal(createCalls, 1);
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 复核（微信专项，2026-09-02）：kaypal /api/payment/create 在微信下单网络超时时会回
// 409 PAYMENT_OUTCOME_UNKNOWN（渠道结果未知，微信侧可能已建单）。九章侧必须把它当成
// 不确定失败保留 pending 窗口——此前统一按确定性失败处理，会清掉保护放行重建，
// 用户换幂等键重试就会建出第二张可扫的码（两张都扫 = 重复扣款）。
function unknownOutcomeCreate(orderNo = 'W-UNKNOWN-R5') {
  return () => ({
    status: 409,
    body: {
      success: false,
      errorCode: 'PAYMENT_OUTCOME_UNKNOWN',
      errorMsg: 'Payment order outcome unknown, query this orderNo before retrying',
      orderNo,
    },
  });
}
function deterministicFailCreate() {
  return () => ({ status: 400, body: { success: false, errorMsg: 'WechatPay create order failed' } });
}

test('微信建单结果未知（R5-2）：保留 pending 窗口，换幂等键重试不得建第二张单', async () => {
  kaypalPay._resetJwtMemo();
  const root = setupRoot();
  const mock = makeKaypalMock({
    userId: 'u-codexfix-f',
    tenantId: 't-1',
    subscribe: successSubscribe(99),
    create: unknownOutcomeCreate(),
  });
  const s = await startRouterServer({ root, token: TOKEN, kaypalHttp: mock.http });
  try {
    const body = (key) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key });

    const r1 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r5-key-001') });
    assert.equal(r1.status, 502, '结果未知必须回 502，不能把失败坐实成确定性失败');
    const j1 = await r1.json();
    assert.equal(j1.error, 'SUBSCRIPTION_UNAVAILABLE');
    assert.equal(j1.data.orderNo, 'W-UNKNOWN-R5', '必须回传 kaypal 的单号，UI 才能查单确认真实结果');
    assert.equal(j1.data.locked, true, 'R7-1：结果未知必须落持续锁（不受 10 分钟 TTL 约束）');

    // 换幂等键重试：R7-1 后不再是"干等 409"——本地先对**同一笔订阅单**发起锁单重放探测
    //（kaypal 兜底幂等键必命中旧单），探测仍无法证实才回 409 PURCHASE_PENDING。
    const r2 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r5-key-002') });
    assert.equal(r2.status, 409, '结果未确认时换键重试必须被拦截');
    assert.equal((await r2.json()).error, 'PURCHASE_PENDING');

    // 铁律升级（R7-1）：全程只 subscribe 一次（业务单不换）；探测 create 必须指向**同一 orderId**
    //（kaypal 侧同兜底键 → 命中旧单重挂，不会建第二张微信单）。
    const subCalls = mock.calls.filter((c) => c.urlPath === '/api/pricing/subscribe');
    assert.equal(subCalls.length, 1, '换键重试绝不能重新 subscribe（新 orderId 会绕开 kaypal 兜底幂等）');
    const createCalls = mock.calls.filter((c) => c.urlPath === '/api/payment/create');
    assert.ok(createCalls.length >= 2, '重试必须触发锁单重放探测，而不是闷头建新单');
    const orderIds = new Set(createCalls.map((c) => c.body && c.body.metadata && c.body.metadata.orderId));
    assert.equal(orderIds.size, 1, '所有 create 探测必须指向同一笔订阅单');
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('反例守卫（R5-2）：确定性建单失败仍立即清除 pending，允许重试', async () => {
  kaypalPay._resetJwtMemo();
  const root = setupRoot();
  let createCalls = 0;
  const mock = makeKaypalMock({
    userId: 'u-codexfix-g',
    tenantId: 't-1',
    subscribe: successSubscribe(99),
    create: () => {
      createCalls++;
      // 第一次确定性失败，第二次成功：确定性失败不该把套餐锁死
      return createCalls === 1 ? deterministicFailCreate()() : okCreate()();
    },
  });
  const s = await startRouterServer({ root, token: TOKEN, kaypalHttp: mock.http });
  try {
    const body = (key) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key });

    const r1 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r5-det-001') });
    assert.equal(r1.status, 502, '确定性失败仍是失败');

    // 确定性失败不留 pending 窗口 → 换键可立即重试，不得被 PURCHASE_PENDING 误伤
    const r2 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r5-det-002') });
    assert.equal(r2.status, 200, '确定性失败后必须允许立即重试（不能把正常业务错误也锁进窗口）');
    assert.ok((await r2.json()).data.orderNo, '重试必须拿到新的微信支付单');
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * R7-1（复核 P1）：结果未知锁必须持续到渠道证实，**不能 10 分钟 TTL 自动放行**。
 * 放行 = 换键重新 subscribe（新 orderId → kaypal 兜底幂等键也变）→ 第二张可扫的码。
 */
function ageOutLock(root, minutes = 11) {
  // 把锁记录的 at 拨旧到 TTL 之外，模拟"用户 10 分钟后回来重试"
  const p = path.join(root, 'license', 'purchase-idempotency.json');
  const store = JSON.parse(fs.readFileSync(p, 'utf8'));
  store.records.forEach((r) => {
    r.at = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  });
  fs.writeFileSync(p, JSON.stringify(store));
}

test('R7-1：结果未知锁过期（TTL 后）仍不得放行建新单——探测仍未知则继续锁', async () => {
  kaypalPay._resetJwtMemo();
  const root = setupRoot();
  const mock = makeKaypalMock({
    userId: 'u-codexfix-h',
    tenantId: 't-1',
    subscribe: successSubscribe(99),
    create: unknownOutcomeCreate('W-LOCK-71'),
  });
  const s = await startRouterServer({ root, token: TOKEN, kaypalHttp: mock.http });
  try {
    const body = (key) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key });
    const r1 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r71-lock-001') });
    assert.equal(r1.status, 502);
    assert.equal((await r1.json()).data.locked, true);

    ageOutLock(root); // 11 分钟过去了

    // 修复前的行为（回退此测试必红）：TTL 到期 → 换键放行 → 重新 subscribe 建新单。
    // 修复后：锁不过期，换键重试触发同单探测；探测仍未知 → 409，绝不重新 subscribe。
    const r2 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r71-lock-002') });
    assert.equal(r2.status, 409, 'TTL 过后结果未知锁仍不得放行');
    const j2 = await r2.json();
    assert.equal(j2.error, 'PURCHASE_PENDING');
    assert.equal(j2.data.orderNo, 'W-LOCK-71', '409 必须带上锁住的单号供人工查单');
    assert.equal(mock.calls.filter((c) => c.urlPath === '/api/pricing/subscribe').length, 1, 'TTL 后重试绝不能重新 subscribe');
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R7-1：锁单重放探测成功 → 同一订单收敛为 200 出码，不建新业务单', async () => {
  kaypalPay._resetJwtMemo();
  const root = setupRoot();
  let n = 0;
  const mock = makeKaypalMock({
    userId: 'u-codexfix-i',
    tenantId: 't-1',
    subscribe: successSubscribe(99),
    create: () => {
      n++;
      // 首次超时未知；第二次探测 kaypal 同兜底键命中旧单重挂成功（同 orderNo）
      return n === 1 ? unknownOutcomeCreate('W-PROBE-OK')() : okCreateWithNo('W-PROBE-OK')();
    },
  });
  const s = await startRouterServer({ root, token: TOKEN, kaypalHttp: mock.http });
  try {
    const body = (key) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key });
    const r1 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r71-probe-001') });
    assert.equal(r1.status, 502);

    const r2 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r71-probe-002') });
    assert.equal(r2.status, 200, '探测证实渠道单可用（重挂成功）必须直接出码');
    const j2 = await r2.json();
    assert.equal(j2.data.orderNo, 'W-PROBE-OK', '必须复用原单号，不是新单');
    assert.equal(mock.calls.filter((c) => c.urlPath === '/api/pricing/subscribe').length, 1);
    // 锁转 success 后，第三次换键 = 回放同一张单
    const r3 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r71-probe-003') });
    assert.equal(r3.status, 200);
    assert.equal((await r3.json()).data.orderNo, 'W-PROBE-OK');
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R7-1：锁单重放探测确认渠道终结（确定性失败）→ 解除锁放行走新购', async () => {
  kaypalPay._resetJwtMemo();
  const root = setupRoot();
  let n = 0;
  const mock = makeKaypalMock({
    userId: 'u-codexfix-j',
    tenantId: 't-1',
    subscribe: successSubscribe(99),
    create: () => {
      n++;
      // 首次结果未知；探测时 kaypal 查单确认渠道单已 CLOSED → 让位后重建成功（新单号）
      if (n === 1) return unknownOutcomeCreate('W-STALE')();
      return okCreateWithNo('W-REBUILT')();
    },
  });
  const s = await startRouterServer({ root, token: TOKEN, kaypalHttp: mock.http });
  try {
    const body = (key) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key });
    const r1 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r71-closed-001') });
    assert.equal(r1.status, 502);

    const r2 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r71-closed-002') });
    assert.equal(r2.status, 200, '渠道证实终结（旧单让位重建）后必须放行');
    assert.equal((await r2.json()).data.orderNo, 'W-REBUILT');
    // 关键：重放探测不换业务单，subscribe 全程一次
    assert.equal(mock.calls.filter((c) => c.urlPath === '/api/pricing/subscribe').length, 1);
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R7-1 反例守卫：普通在途 pending（非结果未知）TTL 到期照常放行', async () => {
  // 只有 unknownOutcome 锁不过期；普通"请求还在路上/超时但无渠道未知标记"的
  // 10 分钟窗口语义不变——否则 kaypal 长时间故障会把套餐永久锁死。
  kaypalPay._resetJwtMemo();
  const root = setupRoot();
  let n = 0;
  const mock = makeKaypalMock({
    userId: 'u-codexfix-k',
    tenantId: 't-1',
    subscribe: (reqBody) => {
      n++;
      if (n === 1) throw new Error('socket hang up'); // subscribe 阶段超时：无渠道单、非建单未知
      return successSubscribe(99)(reqBody);
    },
    create: okCreate(),
  });
  const s = await startRouterServer({ root, token: TOKEN, kaypalHttp: mock.http });
  try {
    const body = (key) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key });
    const r1 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r71-ttl-001') });
    assert.equal(r1.status, 502);
    assert.notEqual((await r1.json()).data.locked, true, 'subscribe 阶段超时不建渠道单，不打未知锁');

    ageOutLock(root);
    const r2 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('r71-ttl-002') });
    assert.equal(r2.status, 200, '普通 pending TTL 到期必须放行（防误锁死套餐）: ' + JSON.stringify(await r2.json()));
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
