'use strict';
// kaypal-pay 支付模块（Task#10，2026-09-01）。
// 桌面端微信支付全链路：desktop 会话(kda) → exchange(JWT) → pricing/subscribe(订阅单)
//   → payment/create(微信 native 单) → 轮询 payment/query → 微信官方回调激活订阅。
// 端点契约（2026-09-01 生产 kaypal-app-baota bundle 逐一实锤，勿凭记忆改；
//   2026-09-02 对照 kaypal-ai 源码逐端点复核，修正见各行 ⚠️）：
//   POST /api/desktop-auth/exchange  body {access_token:kda}（auth:none, 20/min）
//     → 200 {access_token:JWT(900s), token_type:"kaypal_auth", user}
//     JWT payload = {userId, email, tenantId(2026-09-01 新增 claim), iss, iat, exp}，无 jti（短路 Redis 白名单）。
//   POST /api/pricing/subscribe   Cookie 会话鉴权（route 内 v.H() 无会话→401；middleware auth:optional）
//     ⚠️ 2026-09-02 补：body 另有可选字段 couponCode（zod string trim 1..64 optional），
//        本模块 subscribe() 在传入 cc 时会带上，原注释漏记。
//     body {type:"individual", planId, paymentMethod:"wechat", couponCode?}（zod enum alipay|wechat）
//     → 200 {success:true, data:{id, userId, type, planId, price(元), status:"pending"}}
//   POST /api/payment/create      ⚠️ 2026-09-02 修正：本行原写「无需会话（route 不读 session）」，**已过时**。
//     现状（Codex 复核 P1 第二轮修复，kaypal create/route.ts:15-24）：**强制会话**，
//     route 首行即 getCurrentUser()，无会话直接 401 'Authentication required'。
//     原因：此前匿名可建单且 userId 由调用方任意声明 → 拿到他人 orderId 即可代付/伪造归属。
//     **userId 一律以会话为准，调用方声明的 userId 被服务端忽略**（防伪造 metadata.userId）。
//     本模块 createWechatPayment() 已按此契约带 `kaypal_auth=<jwt>` cookie（见 :139），
//     勿把该 cookie 当冗余优化掉。
//     body {channel, amount(分,>0), subject, userId?, metadata?}，metadata subscription 用途校验
//     {purpose:"subscription", orderId, tenantId(非空), paymentMethod(wechat|alipay|unionpay)}
//     → 200 {success:true, formOrRedirectUrl:微信native code_url, orderNo:"W..."}
//   GET  /api/payment/query?orderNo=   必须带 Cookie
//     ⚠️ 2026-09-02 修正归因：不是「middleware 无条目 → 默认 401」，而是 **route 层主动强制会话
//        + 订单归属校验**（Codex 复核第八轮 P2，kaypal query/route.ts:8）。结论一致（都要 Cookie），
//        但归因要准，否则会误以为加个 middleware 白名单条目就能放开。
//     → 200 {success, status:"SUCCESS"|"PENDING"|"CLOSED", thirdTradeNo?, payerId?}
//   订阅激活：微信官方回调 POST /api/payment/callback/wechatpay → paymentOrder=SUCCESS
//     → fulfillSubscription → handlePaymentCallback(orderId)（daemon 轮询只读，不落库不触发激活）。
// 设计：fail-closed {ok,error,detail}；JWT 仅内存缓存不落盘（15min 短时效，桌面会话才落盘）；
// _httpsJson 可注入（测试桩）；qrcode 零依赖出 SVG。

const { httpsJson } = require('./kaypal-license');
const { qrSvg } = require('./qrcode');
const {
  loadDesktopAuth,
  refreshAccessToken,
} = require('./desktop-auth');

// JWT 内存缓存：kda → { jwt, payload, expAt }。expires_in 900s，提前 60s 刷新。
let _jwtMemo = { src: null, jwt: null, payload: null, expAt: 0 };

// 解 JWT payload（base64url，不验签：token 是本进程刚从 exchange Over TLS 拿到的，仅取 claims）。
function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// 桌面会话 → kaypal_auth JWT。失败 fail-closed：
// 未登录 → NOT_LOGGED_IN(needLogin)；kda 失效 → 先 refresh 一次再试 exchange，仍 401/400 → needRelogin。
async function getKaypalAuth({ root, force = false, _httpsJson } = {}) {
  const http = _httpsJson || httpsJson;
  const now = Date.now();
  if (!force && _jwtMemo.jwt && _jwtMemo.src && _jwtMemo.expAt > now) {
    const auth0 = loadDesktopAuth(root);
    if (auth0 && auth0.accessToken === _jwtMemo.src) {
      return { ok: true, jwt: _jwtMemo.jwt, payload: _jwtMemo.payload, cached: true };
    }
    // 本地会话已换人（重登/换账号），缓存作废
    _jwtMemo = { src: null, jwt: null, payload: null, expAt: 0 };
  }
  const auth = loadDesktopAuth(root);
  if (!auth || !auth.accessToken) {
    return { ok: false, error: 'NOT_LOGGED_IN', needLogin: true, detail: '未登录，请先完成桌面端登录' };
  }
  const doExchange = async (kda) => {
    const r = await http('POST', '/api/desktop-auth/exchange', { access_token: kda });
    if (r.status === 200 && r.body && r.body.access_token) {
      const payload = decodeJwtPayload(r.body.access_token) || {};
      const expiresIn = typeof r.body.expires_in === 'number' ? r.body.expires_in : 900;
      const memo = { src: kda, jwt: r.body.access_token, payload, expAt: Date.now() + Math.max(30, expiresIn - 60) * 1000 };
      _jwtMemo = memo;
      return { ok: true, jwt: memo.jwt, payload, expiresIn };
    }
    return { ok: false, status: r.status, body: r.body };
  };
  let out = await doExchange(auth.accessToken);
  if (out.ok) return out;
  // kda 过期/被吊销 → refresh 一次再试（401/400 之外的网络错误不触发 refresh）
  if (out.status === 401 || out.status === 400) {
    const rf = await refreshAccessToken({ root });
    if (rf.ok && rf.accessToken) {
      out = await doExchange(rf.accessToken);
      if (out.ok) return out;
    } else if (rf.needRelogin) {
      return { ok: false, error: 'SESSION_EXPIRED', needLogin: true, detail: '登录已过期，请重新登录' };
    }
    return { ok: false, error: 'EXCHANGE_FAILED', needLogin: true, detail: `exchange ${out.status}` };
  }
  return { ok: false, error: 'PAY_UNAVAILABLE', detail: `exchange ${out.status || 'network'}` };
}

// 下订阅单：POST /api/pricing/subscribe → {success,data:{id,price(元),status}}。
// couponCode（Task#11 2026-09-01）：非空才携带字段——subscribe 侧核销，折后价反映在返回 data.price，
// buyPlanWechat 据此建微信单（金额以订阅单为准，不能拿目录价兜底，否则券不生效还多收钱）。
async function subscribePlan({ planId, paymentMethod = 'wechat', couponCode, root, _httpsJson } = {}) {
  if (!planId) return { ok: false, error: 'INVALID_REQUEST', detail: 'missing planId' };
  const a = await getKaypalAuth({ root, _httpsJson });
  if (!a.ok) return a;
  const http = _httpsJson || httpsJson;
  const cc = couponCode ? String(couponCode).trim() : '';
  try {
    const r = await http('POST', '/api/pricing/subscribe', { type: 'individual', planId, paymentMethod, ...(cc ? { couponCode: cc } : {}) }, { cookie: `kaypal_auth=${a.jwt}` });
    const b = r.body || {};
    if (r.status === 200 && b.success && b.data && b.data.id) {
      return {
        ok: true,
        orderId: b.data.id,
        planId: b.data.planId || planId,
        priceYuan: typeof b.data.price === 'number' ? b.data.price : null,
        status: b.data.status || 'pending',
        source: 'kaypal',
      };
    }
    if (r.status === 401) return { ok: false, error: 'SESSION_EXPIRED', needLogin: true, detail: '会话失效，请重新登录' };
    return { ok: false, error: 'SUBSCRIBE_FAILED', detail: `${r.status} ${b.error || b.message || ''}`.trim() };
  } catch (e) {
    return { ok: false, error: 'PAY_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 创建微信 native 支付单：POST /api/payment/create → {success, formOrRedirectUrl:code_url, orderNo}。
// amountFen 为整数分；附零依赖二维码 SVG（code_url 过长超出二维码容量时不阻断支付，qrError 上报调用方）。
// Codex 复核 P1 第二轮：kaypal 端已强制会话 + 订单归属校验（order.userId === session.user.id），
// 必须携带 exchange JWT cookie，userId 由服务端会话推导（本地声明仅作展示兜底，服务端忽略）。
async function createWechatPayment({ orderId, amountFen, subject, userId, tenantId, root, _httpsJson, _authJwt } = {}) {
  if (!orderId || !amountFen || !(amountFen > 0) || !tenantId) {
    return { ok: false, error: 'INVALID_REQUEST', detail: 'missing orderId/amountFen/tenantId' };
  }
  let jwt = _authJwt;
  if (!jwt) {
    const a = await getKaypalAuth({ root, _httpsJson });
    if (!a.ok) return a;
    jwt = a.jwt;
  }
  const http = _httpsJson || httpsJson;
  const body = {
    // 2026-09-03 修复：kaypal /api/payment/create 渠道白名单是 ALIPAY|WECHATPAY|UNIONPAY
    //（大写归一比较），发 'wechat' 恒 400 "Unsupported payment channel"（E2E 实锤）。
    // 订阅单 /api/pricing/subscribe 的 paymentMethod 仍是小写 'wechat'，两处值不同勿合并。
    channel: 'wechatpay',
    amount: Math.round(amountFen),
    subject: subject || '九章AI管家会员',
    metadata: { purpose: 'subscription', orderId, tenantId, paymentMethod: 'wechat' },
  };
  try {
    const r = await http('POST', '/api/payment/create', body, { cookie: `kaypal_auth=${jwt}` });
    const b = r.body || {};
    if (r.status === 200 && b.success && b.formOrRedirectUrl && b.orderNo) {
      const codeUrl = b.formOrRedirectUrl;
      const qr = qrSvg(codeUrl, { scale: 4 });
      return {
        ok: true,
        orderNo: b.orderNo,
        codeUrl,
        qrSvg: qr.ok ? qr.svg : null,
        qrError: qr.ok ? null : qr.error,
        amountFen: Math.round(amountFen),
        source: 'kaypal',
      };
    }
    if (r.status === 401) return { ok: false, error: 'SESSION_EXPIRED', needLogin: true, detail: '会话失效，请重新登录' };
    if (r.status === 403) return { ok: false, error: 'CREATE_PAYMENT_FAILED', detail: '订单归属校验失败（非本人订单）' };
    // 复核（微信专项 P1）：kaypal 建单网络超时/5xx = 渠道结果未知——微信那边可能已经建单，
    // 只是响应没回来。此前一律按确定性失败返回，外层会清掉防重复下单的 pending 保护，
    // 用户换幂等键重试就会建出第二张可扫的码（两张都扫 = 重复扣款）。
    // 必须转成 PAY_UNAVAILABLE：外层据此保留 pending 窗口，并用返回的 orderNo 查单确认。
    // R7-1：`unknownOutcome:true` = 外层"持续锁单"的判据——此类结果没有确认期限，
    // 必须锁到渠道明确 CLOSED/FAILED 或收款证实，绝不能靠 10 分钟 TTL 自动放行。
    if (r.status === 409 && b.errorCode === 'PAYMENT_OUTCOME_UNKNOWN') {
      return {
        ok: false,
        error: 'PAY_UNAVAILABLE',
        unknownOutcome: true,
        orderNo: b.orderNo || null,
        amountFen: Math.round(amountFen),
        detail: '支付单结果未确认（网络超时），请勿重复下单，请用该单号查询确认',
      };
    }
    return { ok: false, error: 'CREATE_PAYMENT_FAILED', detail: `${r.status} ${b.errorMsg || b.error || ''}`.trim() };
  } catch (e) {
    // R7-1：本地 throw = 请求可能已送达 kaypal 但响应丢了——同样按结果未知上报。
    // 带 amountFen 供外层锁单：重试时对同一 orderId 重放 create（kaypal 兜底幂等键必
    // 命中旧单做重挂/收敛），绝不换业务单重建。
    return { ok: false, error: 'PAY_UNAVAILABLE', unknownOutcome: true, amountFen: Math.round(amountFen), detail: String((e && e.message) || e) };
  }
}

// R7-1：锁单重放入口——结果未知后，对**同一笔订阅单**重新调 /api/payment/create。
// 绝不重新 subscribe（换 orderId = 换 kaypal 兜底幂等键 = 绕开保护）。
// kaypal 侧同键必命中旧 PaymentOrder：有凭证原样重放；PENDING 无凭证走同单号重挂；
// 终态 FAILED/CLOSED 先让位再重建——任何分支都不会出现两张可扫的码并存。
async function reattachWechatPayment({ orderId, amountFen, subject, root, _httpsJson } = {}) {
  if (!orderId || !(amountFen > 0)) {
    return { ok: false, error: 'INVALID_REQUEST', detail: 'missing orderId/amountFen' };
  }
  const a = await getKaypalAuth({ root, _httpsJson });
  if (!a.ok) return a;
  return createWechatPayment({
    orderId,
    amountFen,
    subject,
    userId: a.payload.userId,
    tenantId: a.payload.tenantId,
    root,
    _httpsJson,
    _authJwt: a.jwt,
  });
}

// 单次查单（UI 驱动轮询用，Task#11）：GET /api/payment/query（必须带 Cookie，实测无 Cookie 401）。
// status: SUCCESS → paid；CLOSED → closed；PENDING/未知 → pending。不循环，节奏由调用方控制。
async function queryWechatPayment({ orderNo, root, _httpsJson } = {}) {
  if (!orderNo) return { ok: false, error: 'INVALID_REQUEST', detail: 'missing orderNo' };
  const a = await getKaypalAuth({ root, _httpsJson }); // JWT 过期自动换新
  if (!a.ok) return a;
  const http = _httpsJson || httpsJson;
  try {
    const r = await http('GET', `/api/payment/query?orderNo=${encodeURIComponent(orderNo)}`, null, { cookie: `kaypal_auth=${a.jwt}` });
    const b = r.body || {};
    if (r.status === 200 && b.success) {
      const st = b.status || 'PENDING';
      return {
        ok: true,
        status: st === 'SUCCESS' ? 'paid' : (st === 'CLOSED' ? 'closed' : 'pending'),
        thirdTradeNo: b.thirdTradeNo || null,
        payerId: b.payerId || null,
      };
    }
    // success:false（订单暂不可见）→ 视同 pending，交给调用方继续轮询
    if (r.status === 200) return { ok: true, status: 'pending' };
    return { ok: false, error: 'QUERY_FAILED', detail: `${r.status}` };
  } catch (e) {
    return { ok: false, error: 'PAY_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 轮询微信支付状态（长轮询形态，CLI/E2E 用；Task#11 UI 改用 queryWechatPayment 自驱节奏）。
async function pollWechatPayment({ orderNo, root, timeoutMs = 120000, intervalMs = 3000, _httpsJson } = {}) {
  if (!orderNo) return { ok: false, error: 'INVALID_REQUEST', detail: 'missing orderNo' };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const q = await queryWechatPayment({ orderNo, root, _httpsJson });
    if (q.ok && q.status === 'paid') return { ok: true, status: 'paid', orderNo, thirdTradeNo: q.thirdTradeNo, payerId: q.payerId };
    if (q.ok && q.status === 'closed') return { ok: false, error: 'PAYMENT_CLOSED', detail: '订单已关闭', orderNo };
    if (!q.ok && q.error !== 'PAY_UNAVAILABLE' && q.error !== 'QUERY_FAILED') return q; // 登录态等问题不空转
    // pending / 网络抖动 → 继续等
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return { ok: false, error: 'POLL_TIMEOUT', detail: `轮询超时(${Math.round(timeoutMs / 1000)}s)`, orderNo };
}

// 查订阅生效状态（支付成功后确认激活）：GET /api/pricing/subscription/status?type=individual。
async function checkSubscription({ root, _httpsJson } = {}) {
  const a = await getKaypalAuth({ root, _httpsJson });
  if (!a.ok) return a;
  const http = _httpsJson || httpsJson;
  try {
    const r = await http('GET', '/api/pricing/subscription/status?type=individual', null, { cookie: `kaypal_auth=${a.jwt}` });
    const b = r.body || {};
    if (r.status === 200 && b.success && b.data) {
      const d = b.data;
      return {
        ok: true,
        hasSubscription: !!d.hasSubscription,
        status: d.status || null,
        planId: d.planId || null,
        expiresAt: d.expiresAt || null,
        source: 'kaypal',
      };
    }
    if (r.status === 401) return { ok: false, error: 'SESSION_EXPIRED', needLogin: true, detail: '会话失效' };
    return { ok: false, error: 'SUBSCRIPTION_STATUS_FAILED', detail: `${r.status}` };
  } catch (e) {
    return { ok: false, error: 'PAY_UNAVAILABLE', detail: String((e && e.message) || e) };
  }
}

// 一站式购买编排：下订阅单 → 建微信单 → 出码。轮询与激活确认由调用方用 pollWechatPayment/checkSubscription 驱动
// （UI 需要"先展示二维码再等待"的节奏，不该在这里一把梭阻塞）。
async function buyPlanWechat({ planId, subject, couponCode, root, _httpsJson } = {}) {
  const sub = await subscribePlan({ planId, couponCode, root, _httpsJson });
  if (!sub.ok) return sub;
  if (!(sub.priceYuan > 0)) {
    return { ok: false, error: 'SUBSCRIBE_FAILED', detail: `plan price invalid: ${sub.priceYuan}`, orderId: sub.orderId };
  }
  const a = await getKaypalAuth({ root, _httpsJson });
  if (!a.ok) return a;
  const pay = await createWechatPayment({
    orderId: sub.orderId,
    amountFen: Math.round(sub.priceYuan * 100),
    subject,
    userId: a.payload.userId,
    tenantId: a.payload.tenantId,
    root,
    _httpsJson,
    _authJwt: a.jwt, // Codex 复核 P1 第二轮：建单必须带会话（归属校验），复用刚换的 JWT
  });
  if (!pay.ok) return Object.assign(pay, { orderId: sub.orderId });
  return Object.assign(pay, { orderId: sub.orderId, priceYuan: sub.priceYuan });
}

// 仅测试用：清空 JWT 内存缓存（注入桩场景下隔离用例）。
function _resetJwtMemo() {
  _jwtMemo = { src: null, jwt: null, payload: null, expAt: 0 };
}

module.exports = {
  decodeJwtPayload,
  getKaypalAuth,
  subscribePlan,
  createWechatPayment,
  reattachWechatPayment,
  queryWechatPayment,
  pollWechatPayment,
  checkSubscription,
  buyPlanWechat,
  _resetJwtMemo,
};
