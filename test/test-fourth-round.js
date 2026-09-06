'use strict';
// 回归测试（第四轮复查，2026-08-29）：
// 修复失败透传、诊断预览→上传闭环、购买不确定结果 pending 窗口、幂等持久化、auto-backup reload。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// kaypal 请求指向黑洞端口（购买用例需要确定性"网络异常=结果不确定"）
process.env.KAYPAL_BASE_URL = 'http://127.0.0.1:9';

const { startRouterServer, jzFetch } = require('./_helpers');
const { saveDesktopAuth } = require('../scripts/jz/desktop-auth');

const TOKEN = crypto.randomBytes(32).toString('hex');

test('repair/run：动作失败 → 422 REPAIR_PARTIAL_FAILED，绝不顶层成功；同键重放返回首次结果', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r4-repair-'));
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    const ct = (await (await jzFetch(s.baseUrl, '/api/auth/confirm', { method: 'POST', token: TOKEN, body: { scope: 'POST /api/repair/run' } })).json()).data.confirmToken;
    // rediscover-cdp 在独立 router 无执行器 → fail-closed not_supported
    const r = await jzFetch(s.baseUrl, '/api/repair/run', {
      method: 'POST', token: TOKEN,
      body: { confirmed: true, confirmToken: ct, actions: ['rediscover-cdp'], idempotencyKey: 'repair-r4-key-001', findingCodes: ['CDP_UNAVAILABLE'] },
    });
    assert.equal(r.status, 422, `失败动作必须 422，实际 ${r.status}`);
    const j = await r.json();
    assert.equal(j.ok, false, '顶层 ok 必须为 false');
    assert.equal(j.error, 'REPAIR_PARTIAL_FAILED');
    assert.equal(j.data.failedCount, 1);
    assert.equal(j.data.executed[0].ok, false);

    // 同键重放：返回首次结果（仍 422，不再执行）
    const ct2 = (await (await jzFetch(s.baseUrl, '/api/auth/confirm', { method: 'POST', token: TOKEN, body: { scope: 'POST /api/repair/run' } })).json()).data.confirmToken;
    const r2 = await jzFetch(s.baseUrl, '/api/repair/run', {
      method: 'POST', token: TOKEN,
      body: { confirmed: true, confirmToken: ct2, actions: ['rediscover-cdp'], idempotencyKey: 'repair-r4-key-001', findingCodes: ['CDP_UNAVAILABLE'] },
    });
    assert.equal(r2.status, 422, '重放返回首次失败结果');
    assert.equal((await r2.json()).data.planId, j.data.planId, '重放返回同一 planId');
  } finally {
    await s.close();
  }
});

test('repair/run：动作全部成功 → 200 + recheck 复查体检落在同一数据目录', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r4-repair2-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"dark"}');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    const ct = (await (await jzFetch(s.baseUrl, '/api/auth/confirm', { method: 'POST', token: TOKEN, body: { scope: 'POST /api/repair/run' } })).json()).data.confirmToken;
    const r = await jzFetch(s.baseUrl, '/api/repair/run', {
      method: 'POST', token: TOKEN,
      body: { confirmed: true, confirmToken: ct, actions: ['enter-safe-mode'], idempotencyKey: 'repair-r4-key-002', findingCodes: ['X'] },
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(j.data.executed[0].ok, 'enter-safe-mode 应成功');
    assert.ok(j.data.recheck, '成功后必须有 recheck 复查');
    // recheck 体检结果必须落在同一 dataDir（复查 P1 的闭环证据）
    const healthFiles = fs.readdirSync(path.join(root, 'runtime', 'health'));
    assert.ok(healthFiles.length >= 1, `recheck 体检应落 ${root}/runtime/health`);
  } finally {
    await s.close();
  }
});

test('诊断：preview 发 previewId → 上传绑定快照 → 单次使用；伪造 previewId 拒绝', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r4-diag-'));
  // 本地"上传端点"接收并记录收到的 body
  let received = null;
  const ep = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { received = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ticketId: 'TK-1' })); });
  });
  await new Promise((r) => ep.listen(0, '127.0.0.1', r));
  const prevEndpoint = process.env.JZ_DIAGNOSTICS_ENDPOINT;
  process.env.JZ_DIAGNOSTICS_ENDPOINT = `http://127.0.0.1:${ep.address().port}`;
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    // 诊断上传是高风险路由：先取一次性确认票据
    const getConfirm = async () => (await (await jzFetch(s.baseUrl, '/api/auth/confirm', { method: 'POST', token: TOKEN, body: { scope: 'POST /api/diagnostics/upload' } })).json()).data.confirmToken;
    // 预览 → 拿 previewId
    const pv = await jzFetch(s.baseUrl, '/api/diagnostics/preview', { method: 'POST', token: TOKEN, body: {} });
    const pj = await pv.json();
    assert.equal(pv.status, 200);
    assert.ok(pj.data.previewId, '预览必须返回 previewId（复查 P1）');
    assert.ok(pj.data.expiresAt, '预览必须返回过期时间');

    // 伪造 previewId → 拒绝
    const bad = await jzFetch(s.baseUrl, '/api/diagnostics/upload', { method: 'POST', token: TOKEN, body: { previewId: 'not-a-real-id', confirmToken: await getConfirm() } });
    assert.equal((await bad.json()).error, 'PREVIEW_NOT_FOUND', '伪造 previewId 必须 PREVIEW_NOT_FOUND');

    // 真实 previewId → 上传成功，且上传内容 = 预览快照
    const up = await jzFetch(s.baseUrl, '/api/diagnostics/upload', { method: 'POST', token: TOKEN, body: { previewId: pj.data.previewId, confirmToken: await getConfirm() } });
    const uj = await up.json();
    assert.equal(up.status, 200);
    assert.equal(uj.data.status, 'uploaded');
    assert.ok(received && received.previewId === pj.data.previewId, '上传内容必须绑定预览');

    // 单次使用：同 previewId 再次上传 → 拒绝
    const again = await jzFetch(s.baseUrl, '/api/diagnostics/upload', { method: 'POST', token: TOKEN, body: { previewId: pj.data.previewId, confirmToken: await getConfirm() } });
    assert.equal((await again.json()).error, 'PREVIEW_ALREADY_USED', 'previewId 只能使用一次');
  } finally {
    if (prevEndpoint === undefined) delete process.env.JZ_DIAGNOSTICS_ENDPOINT; else process.env.JZ_DIAGNOSTICS_ENDPOINT = prevEndpoint;
    ep.close();
    await s.close();
  }
});

test('购买不确定结果：超时后同套餐重试（任何新 key）→ 409 PURCHASE_PENDING 防重复下单', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r4-purchase-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  // 伪造已登录（desktopAccessToken 指向黑洞端点 → 请求必然异常 = 结果不确定）
  saveDesktopAuth(root, { accessToken: 'kda_fake_e2e', refreshToken: null, user: { id: 'u-e2e-1' }, device: null });
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    // Task#11（2026-09-01）：支付通道收敛为微信 native 扫码（alipay 未签约，400 拒绝）
    const body = (key) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key });
    const r1 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('purchase-r4-key-001') });
    assert.equal(r1.status, 502, '黑洞端点 → 结果不确定 502');
    assert.equal((await r1.json()).error, 'SUBSCRIPTION_UNAVAILABLE');

    // 痕迹已落 pending（持久化文件可查）
    const idemStore = JSON.parse(fs.readFileSync(path.join(root, 'license', 'purchase-idempotency.json'), 'utf8'));
    assert.ok(idemStore.records.some((x) => x.result === 'pending'), '不确定结果必须留 pending 痕迹');

    // 换新 key 的重试 → 409 PURCHASE_PENDING（防重复下单核心断言）
    const r2 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('purchase-r4-key-002') });
    assert.equal(r2.status, 409, 'pending 窗口内重试必须 409');
    assert.equal((await r2.json()).error, 'PURCHASE_PENDING');
  } finally {
    await s.close();
  }
});

test('购买幂等指纹含券码（2026-08-31 Codex P1#1）：同键换券 → 409 IDEMPOTENCY_CONFLICT，禁止静默回放旧券订单', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r5-couponfp-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  saveDesktopAuth(root, { accessToken: 'kda_fake_e2e', refreshToken: null, user: { id: 'u-e2e-2' }, device: null });
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    const body = (key, cc) => ({ planId: 'jz_guard_yearly', paymentMethod: 'wechat', idempotencyKey: key, ...(cc ? { couponCode: cc } : {}) });
    // 黑洞端点 → 首单 502（结果不确定，pending 痕迹保留）
    const r1 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('coupon-fp-key-001', 'COUPON_A') });
    assert.equal(r1.status, 502, '黑洞端点 → 502');
    // 修复前：指纹漏券码 → 同键换券重试会走 pending 分支返回 PURCHASE_PENDING（静默吞掉参数差异）
    // 修复后：指纹含券码 → 同键不同参必须 IDEMPOTENCY_CONFLICT
    const r2 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('coupon-fp-key-001', 'COUPON_B') });
    assert.equal(r2.status, 409, '同键换券必须 409');
    assert.equal((await r2.json()).error, 'IDEMPOTENCY_CONFLICT', '换券重试必须判参数冲突，而非 pending');
    // 同键同券（同参）→ 语义不变：仍走 pending 窗口
    const r3 = await jzFetch(s.baseUrl, '/api/license/purchase', { method: 'POST', token: TOKEN, body: body('coupon-fp-key-001', 'COUPON_A') });
    assert.equal(r3.status, 409);
    assert.equal((await r3.json()).error, 'PURCHASE_PENDING');
  } finally {
    await s.close();
  }
});

test('幂等持久化：daemon 重启（新 router 实例）后同键重放仍命中', async () => {  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r4-persist-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"dark"}');
  const body = { scope: ['settings'], reason: 'manual', idempotencyKey: 'persist-idem-key-001' };
  const s1 = await startRouterServer({ root, token: TOKEN });
  const r1 = await jzFetch(s1.baseUrl, '/api/vault/backup', { method: 'POST', token: TOKEN, body });
  const b1 = await r1.json();
  await s1.close();
  // 新 router 实例 = 模拟 daemon 重启
  const s2 = await startRouterServer({ root, token: TOKEN });
  try {
    const r2 = await jzFetch(s2.baseUrl, '/api/vault/backup', { method: 'POST', token: TOKEN, body });
    const b2 = await r2.json();
    assert.equal(b2.data.backupId, b1.data.backupId, '重启后同键重放必须命中持久化记录');
  } finally {
    await s2.close();
  }
});

test('auto-backup：reload() 按新设置重排；stop() 可停', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r4-ab-'));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ autoBackup: { enabled: true, frequency: 'daily', retention: 3 } }));
  const { startAutoBackup } = require('../scripts/jz/auto-backup');
  const logs = [];
  const handle = startAutoBackup({ root, log: (m) => logs.push(m) });
  assert.ok(handle && typeof handle.reload === 'function', '必须返回 reload 句柄（不再返回 null）');
  handle.reload();
  assert.ok(logs.some((l) => l.includes('已按最新设置重排')), 'reload 应记录重排日志');
  handle.stop();
  // 关闭状态 reload → 日志提示未启用
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ autoBackup: { enabled: false, frequency: 'daily', retention: 3 } }));
  handle.reload();
  assert.ok(logs.some((l) => l.includes('未启用')), '关闭后 reload 应提示未启用');
});
