'use strict';
// 优惠券 kaypal 联动对接层（订单折扣券）。
// kaypal 端已上线（2026-08-25 复查确认）：
//   POST /api/pricing/coupons/apply   body { couponCode, orderId, orderAmount?, planId? }
//   GET  /api/pricing/coupons/mine
// 鉴权：desktopAccessToken（Bearer，desktop-auth 密码登录签发），从本地 desktop-auth 会话读取。
// ⚠️ 依赖 kaypal 端 middleware 白名单放行 /api/pricing/coupons/*（auth:"optional"），否则被中间件 401。
// 端点 env 可覆盖；未登录 / 失败一律 fail-closed（不返回假成功）。
const { httpsJson } = require('./kaypal-license');
const { loadDesktopAuth } = require('./desktop-auth');

// kaypal coupon 端点（真实路径为默认值，env 可覆盖）。
function couponEndpoints() {
  return {
    apply: process.env.KAYPAL_COUPON_APPLY_ENDPOINT || '/api/pricing/coupons/apply',
    mine: process.env.KAYPAL_COUPON_MINE_ENDPOINT || '/api/pricing/coupons/mine',
    // 分享券（邀请好友得券）：查/建我的分享链接 / 凭分享码领券
    // Codex 复核 P1 修复：真实路径为 /api/operation/user/referral/*（routes-config.ts:680-692 实锤），
    // 原默认 /api/pricing/referral/* 不存在；且 coupon 端点是 POST（getOrCreate 语义），不是 GET。
    referralCoupon: process.env.KAYPAL_REFERRAL_COUPON_ENDPOINT || '/api/operation/user/referral/coupon',
    referralClaim: process.env.KAYPAL_REFERRAL_CLAIM_ENDPOINT || '/api/operation/user/referral/claim',
    referralMine: process.env.KAYPAL_REFERRAL_MINE_ENDPOINT || '/api/operation/user/referral/mine',
  };
}

// 读当前 desktop-auth 的 desktopAccessToken（未登录 → null）。
function currentAccessToken(root) {
  const auth = loadDesktopAuth(root);
  return (auth && auth.accessToken) || null;
}

// 应用优惠券到订单（kaypal 端 useCoupon）。返回 { ok, data }；data 含 isValid/errors/orderAmount 等。
// 入参兼容旧字段名 code（= couponCode）。未登录 → UNAUTHENTICATED（fail-closed）。
// 复查 P2（第四轮）：idempotencyKey 透传 kaypal（Idempotency-Key 头），防超时重试重复核销。
async function redeemOnKaypal({ couponCode, code, orderId, orderAmount, planId, idempotencyKey, accessToken, root } = {}) {
  const c = couponCode || code || '';
  if (!c) return { ok: false, error: 'INVALID_REQUEST', detail: 'missing couponCode' };
  const token = accessToken || currentAccessToken(root);
  if (!token) return { ok: false, error: 'UNAUTHENTICATED', detail: 'not logged in (desktop-auth)' };
  try {
    const r = await httpsJson(
      'POST',
      couponEndpoints().apply,
      { couponCode: c, orderId, orderAmount, planId },
      { authorization: `Bearer ${token}`, ...(idempotencyKey ? { 'idempotency-key': String(idempotencyKey) } : {}) },
    );
    if (r.status === 200 && r.body && r.body.success) return { ok: true, data: r.body.data };
    if (r.status === 401) return { ok: false, error: 'UNAUTHENTICATED', detail: 'token rejected' };
    return { ok: false, error: (r.body && r.body.error) || 'KAYPAL_COUPON_REJECTED', detail: `${r.status}` };
  } catch (e) {
    return { ok: false, error: 'KAYPAL_COUPON_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 查询我的券（kaypal 端 getUserCoupons）。返回 { ok, coupons }。
async function listFromKaypal({ accessToken, root } = {}) {
  const token = accessToken || currentAccessToken(root);
  if (!token) return { ok: false, error: 'UNAUTHENTICATED', detail: 'not logged in (desktop-auth)' };
  try {
    const r = await httpsJson('GET', couponEndpoints().mine, null, { authorization: `Bearer ${token}` });
    if (r.status === 200 && r.body && r.body.success) return { ok: true, coupons: r.body.data || [] };
    if (r.status === 401) return { ok: false, error: 'UNAUTHENTICATED', detail: 'token rejected' };
    return { ok: false, error: 'KAYPAL_COUPON_UNAVAILABLE', detail: `${r.status}` };
  } catch (e) {
    return { ok: false, error: 'KAYPAL_COUPON_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 分享券：查/建我的分享链接（POST /api/operation/user/referral/coupon，getOrCreate 语义）。
// Codex 复核 P1 修复：method 由 GET 改 POST（kaypal 端只注册了 POST，GET 会 405）。
// _httpsJson 注入（测试桩，惯例同 desktop-auth）。返回 { ok, share }（shareCode/shareUrl 以 kaypal 返回为准）。
async function getShareLink({ accessToken, root, _httpsJson } = {}) {
  const token = accessToken || currentAccessToken(root);
  if (!token) return { ok: false, error: 'UNAUTHENTICATED', detail: 'not logged in (desktop-auth)' };
  const http = _httpsJson || httpsJson;
  try {
    const r = await http('POST', couponEndpoints().referralCoupon, {}, { authorization: `Bearer ${token}` });
    if (r.status === 200 && r.body && r.body.success) return { ok: true, share: r.body.data || null };
    if (r.status === 401) return { ok: false, error: 'UNAUTHENTICATED', detail: 'token rejected' };
    return { ok: false, error: (r.body && r.body.error) || 'KAYPAL_REFERRAL_UNAVAILABLE', detail: `${r.status}` };
  } catch (e) {
    return { ok: false, error: 'KAYPAL_REFERRAL_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 分享券：凭分享码领券（kaypal referral/claim）。复查 P1 惯例：幂等键透传（Idempotency-Key 头），防重试重复领券。
async function claimShare({ shareCode, idempotencyKey, accessToken, root, _httpsJson } = {}) {
  if (!shareCode) return { ok: false, error: 'INVALID_REQUEST', detail: 'missing shareCode' };
  const token = accessToken || currentAccessToken(root);
  if (!token) return { ok: false, error: 'UNAUTHENTICATED', detail: 'not logged in (desktop-auth)' };
  const http = _httpsJson || httpsJson;
  try {
    const r = await http(
      'POST',
      couponEndpoints().referralClaim,
      { shareCode },
      { authorization: `Bearer ${token}`, ...(idempotencyKey ? { 'idempotency-key': String(idempotencyKey) } : {}) },
    );
    if (r.status === 200 && r.body && r.body.success) return { ok: true, data: r.body.data };
    if (r.status === 401) return { ok: false, error: 'UNAUTHENTICATED', detail: 'token rejected' };
    return { ok: false, error: (r.body && r.body.error) || 'KAYPAL_CLAIM_REJECTED', detail: `${r.status}` };
  } catch (e) {
    return { ok: false, error: 'KAYPAL_REFERRAL_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 分享券：我的推荐计数（GET /api/operation/user/referral/mine）。
// 返回 { ok, count, referrals }，供组件「邀请好友」页展示「已邀请 N 位 · 算力券累计中」。
async function getInviteCount({ accessToken, root, _httpsJson } = {}) {
  const token = accessToken || currentAccessToken(root);
  if (!token) return { ok: false, error: 'UNAUTHENTICATED', detail: 'not logged in (desktop-auth)' };
  const http = _httpsJson || httpsJson;
  try {
    const r = await http('GET', couponEndpoints().referralMine, null, { authorization: `Bearer ${token}` });
    if (r.status === 200 && r.body && r.body.success) {
      const data = r.body.data || {};
      return { ok: true, count: typeof data.count === 'number' ? data.count : 0, referrals: data.referrals || [] };
    }
    if (r.status === 401) return { ok: false, error: 'UNAUTHENTICATED', detail: 'token rejected' };
    return { ok: false, error: (r.body && r.body.error) || 'KAYPAL_REFERRAL_UNAVAILABLE', detail: `${r.status}` };
  } catch (e) {
    return { ok: false, error: 'KAYPAL_REFERRAL_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

module.exports = { redeemOnKaypal, listFromKaypal, getShareLink, claimShare, getInviteCount, couponEndpoints };
