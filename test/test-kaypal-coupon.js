'use strict';
// kaypal 优惠券联动对接层单测：未登录 fail-closed（OIDC 用户态鉴权）。
// 成功路径需 kaypal OIDC 登录态（改动 1 localhost 回调放行）就绪后端到端验证。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redeemOnKaypal, listFromKaypal, couponEndpoints } = require('../scripts/jz/kaypal-coupon');

test('couponEndpoints：默认对齐 kaypal 真实端点', () => {
  const ep = couponEndpoints();
  assert.equal(ep.apply, '/api/pricing/coupons/apply');
  assert.equal(ep.mine, '/api/pricing/coupons/mine');
});

test('redeemOnKaypal：缺 couponCode → INVALID_REQUEST（不发网络）', async () => {
  const r = await redeemOnKaypal({});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID_REQUEST');
});

test('redeemOnKaypal：未登录 → UNAUTHENTICATED（fail-closed）', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-coupon-root-'));
  const r = await redeemOnKaypal({ couponCode: 'JZ50', orderId: 'o1', orderAmount: 100, planId: 'p1', root });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'UNAUTHENTICATED');
});

test('redeemOnKaypal：兼容旧字段 code → 同 couponCode 处理', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-coupon-root2-'));
  const r = await redeemOnKaypal({ code: 'JZ50', orderId: 'o1', root });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'UNAUTHENTICATED');
});

test('listFromKaypal：未登录 → UNAUTHENTICATED（fail-closed）', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-coupon-root3-'));
  const r = await listFromKaypal({ root });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'UNAUTHENTICATED');
});
