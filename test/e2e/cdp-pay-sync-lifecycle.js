'use strict';
// 支付权益同步链生命周期 E2E（A0 二轮 P1/P2）：真机 CDP 驱动，可复现。
//
// 前置：① daemon 在 47832 运行且已注入面板；② WorkBuddy 开启 CDP（9222）。
// 运行：node test/e2e/cdp-pay-sync-lifecycle.js
// 注意：脚本会在页面注入临时 fetch stub（伪造 purchase / pay-query，不真实下单），
//       **并在结束时（含异常路径）自动撤除**，撤除后裸 fetch 探活为 401 即证明已清理。
//
// 覆盖场景：
//   场景1 旧单同步中切换新单 → 旧链作废，新链从「第 1 次」重新计数，不隐藏新支付区
//   场景2(A0 三轮) A 单查单在飞 → 发起 B 单 → 释放 A 的 paid → A 响应必须被丢弃
//   场景3(A0 四轮) A 套餐建单在飞 → B 套餐建单完成 → 释放 A 建单响应 → A 不得覆盖 B 支付区
//   场景4 关闭面板后 → 不再有 /api/license/refresh 请求
//   场景5 停滞态连点重试按钮 3 次 → 只保留一条同步链（刷新节奏仍为单链 3s/轮）
//   场景7 A 链 refresh 在飞 → 切新单 → 释放 → A 的回调必须被丢弃（确定性构造 paySync 竞态）
//   场景6 destroy 后 → 不再有 /api/license/refresh 请求
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const CDP = { host: '127.0.0.1', port: 9222 };
const API = 'http://127.0.0.1:47832';
const OUT = path.join(__dirname, '..', '..', 'docs', 'evidence');

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: CDP.host, port: CDP.port, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('未找到 WorkBuddy 页面 target（CDP 9222 是否开启？）');

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let mid = 0;
  const pending = new Map();
  let refreshCount = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Network.requestWillBeSent' && /\/api\/license\/refresh/.test(m.params.request.url || '')) {
      refreshCount++;
    }
  });
  // A0 八轮 P2-3：CDP 请求必须有超时。页面若挂起（CDP 半开连接、渲染进程卡死），
  // send() 原来会永远 pending，整个 E2E 卡死——在 sabotage 场景下源码会一直保持破坏态。
  // 单请求 60s：本脚本最长的 evaluate 是 stub 挂起/释放这类秒级操作，60s 已是 10 倍余量。
  const SEND_TIMEOUT_MS = 60 * 1000;
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++mid;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`CDP 请求超时（${SEND_TIMEOUT_MS}ms）：${method} —— 页面/CDP 连接疑似挂死`));
    }, SEND_TIMEOUT_MS);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((r) => ws.on('open', r));
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.result && r.result.result.value : undefined;
  };
  // JZ_E2E_ONLY=3 或 JZ_E2E_ONLY=1,3 → 只跑指定场景（反向验证时省掉无关等待）
  //
  // A0 五轮 P2-3：单场景过滤会制造「空跑通过」。场景 4（关面板）与 6（destroy）的断言都是
  // 「之后 refresh 不再增加」——若此前根本没有活动同步链，空闲状态下必然通过，断言毫无意义。
  // 两道防线：① 过滤时自动补齐依赖场景；② 场景内部再断言「确实存在活动链」，否则判 FAIL。
  // 场景号白名单：新增场景必须登记到这里。
  // 血泪：五轮加了场景 7，却漏改下面校验里写死的 `n > 6` 上界 →
  // JZ_E2E_ONLY=7 被判非法、E2E 直接崩溃退出，而崩溃同样是非零退出码，
  // 被 sabotage 误判成「守卫失效导致场景 FAIL」＝闸门假阳性。
  const SCENE_IDS = [1, 2, 3, 4, 5, 6, 7, 8];
  const DEPS = {
    4: [3], // 场景3 末尾会 buy + sleep 建立同步链，供场景4 关面板观测
    6: [7], // 场景7 结束后 B 的链正在跑，供场景6 destroy 观测（场景7 自包含，无需前置）
  };
  const expand = (list) => {
    const out = new Set();
    const walk = (n) => { if (out.has(n)) return; out.add(n); (DEPS[n] || []).forEach(walk); };
    list.forEach(walk);
    return out;
  };
  // A0 七轮 P2-5：原来先 .filter(x => x > 0) 会把 NaN 静默丢掉，
  // `JZ_E2E_ONLY=3,garbage` 会退化成 [3] 合法通过——非法项必须报错，不许静默忽略。
  // 故先把每个 token 当字符串严格校验，再转数字。
  const rawOnly = process.env.JZ_E2E_ONLY
    ? process.env.JZ_E2E_ONLY.split(',').map((x) => x.trim())
    : null;
  let only = null;
  if (rawOnly) {
    if (rawOnly.some((tok) => tok === '')) {
      throw new Error(`JZ_E2E_ONLY 含空项（收到：${process.env.JZ_E2E_ONLY}）`);
    }
    const nums = rawOnly.map((tok) => {
      if (!/^\d+$/.test(tok)) {
        throw new Error(`JZ_E2E_ONLY 含非法项 "${tok}"：每项必须是十进制正整数（收到：${process.env.JZ_E2E_ONLY}）`);
      }
      return Number(tok);
    });
    if (!nums.length || nums.some((n) => !SCENE_IDS.includes(n))) {
      throw new Error(`JZ_E2E_ONLY 取值非法：${process.env.JZ_E2E_ONLY}（应为 ${SCENE_IDS.join('/')} 的逗号分隔列表）`);
    }
    const expanded = [...expand(nums)].sort();
    const added = expanded.filter((n) => !nums.includes(n));
    if (added.length) console.log(`JZ_E2E_ONLY=${nums.join(',')} → 自动补齐依赖场景 ${added.join(',')}（否则会空跑通过）`);
    only = expanded;
  }
  const scene = async (n, fn) => {
    // 反向兜底：任何 scene(N) 的 N 都必须登记在 SCENE_IDS，否则 JZ_E2E_ONLY=N 会走不通
    if (!SCENE_IDS.includes(n)) {
      throw new Error(`场景 ${n} 未登记到 SCENE_IDS（${SCENE_IDS.join('/')}），JZ_E2E_ONLY=${n} 会被判非法`);
    }
    if (only && !only.includes(n)) { console.log(`skip 场景${n}`); return; }
    await fn();
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 观测窗口内 refresh 计数是否还在涨 → 证明此刻确实有活动的同步链
  const hasActiveSyncChain = async (windowMs = 5000) => {
    const a = refreshCount;
    await sleep(windowMs);
    return refreshCount > a;
  };

  const results = [];
  // A0 七轮 P1-2：结果必须是机器可解析的三态，「断言失败」与「场景没构造起来」不能混为一谈。
  // 混在一起的后果是闸门假阳性：场景7 挂起失败时输出 `FAIL — 7 … 本场景无效（不是产品缺陷）`，
  // 而 sabotage 的 judge() 只按 `FAIL — <scene>` 前缀匹配，会把「压根没跑到断言」记成
  // 「守卫失效→场景 FAIL」，并据此写下 caught 证据。故两者必须走不同前缀。
  //   pass=true             → PASS — <scene>
  //   invalid（前置/构造失败）→ INVALID — <scene>  本轮无效，不是产品缺陷
  //   pass=false            → FAIL — <scene>      断言真的判定产品行为有问题
  const failResult = (scene, detail, invalid) => {
    results.push({ scene, pass: false, invalid: !!invalid, detail });
  };
  let orderSeq = 0;
  const installStub = () => ev(`(function(){
    if (window.__e2eBase) return 'already';
    window.__e2eBase = window.fetch;
    window.__e2eSeq = 0;
    window.__e2eDefaultStatus = 'paid';  // 未挂起订单的查单默认响应（paid / pending / closed）
    // A0 七轮 P1-1：按顺序决定每次查单的 status，用于 pending→pending→paid 收敛回归。
    // 没有它就造不出「前两次都没到账」的真实场景，查单链停摆与否看不出来。
    window.__e2eQueryScript = null;
    window.__e2eHoldNext = false;   // 置 true → 下一条 pay/query 挂起（模拟慢响应 / 在飞请求）
    window.__e2eHeldOrder = null;
    window.__e2eHoldResolve = null;
    window.__e2eHoldPurchase = false; // 置 true → 下一条 purchase 挂起（A0 四轮 P2）
    window.__e2eHeldOrderNo = null;
    window.__e2ePurchaseResolve = null;
    window.__e2eHoldRefresh = false;  // 置 true → 下一条 refresh 挂起（A0 五轮：确定性构造「同步链在飞」）
    window.__e2eRefreshResolve = null;
    window.__e2eQueryOrders = [];   // 记录所有 pay/query 的订单号（证 payOrder 未被替换）
    window.__e2eQrTexts = [];       // 记录所有 qrcode 请求的 text（证旧订单二维码回调未执行）
    window.__e2eRefresh = 0;    // 页面内计数：startPaySync 每轮必然打 refresh，独立佐证
    // 不同套餐给不同金额，用于断言「支付区金额未被旧订单覆盖」
    var amountOf = function(plan){ return plan === 'jz_guard_yearly' ? 9900 : 1900; };
    window.fetch = function(u, o){
      u = String(u);
      if (u.indexOf('/api/license/refresh') >= 0) {
        window.__e2eRefresh++;
        // 挂起同步链的刷新请求，把「链正在 HTTP 在飞」变成确定态，
        // 这样切新单/关面板时旧链必然有在飞回调，paySyncAlive 的守卫才有确定性的检验机会。
        if (window.__e2eHoldRefresh) {
          window.__e2eHoldRefresh = false;
          return new Promise(function(res){ window.__e2eRefreshResolve = res; });
        }
      }
      if (u.indexOf('/api/license/purchase') >= 0) {
        var body = {};
        try { body = JSON.parse((o && o.body) || '{}'); } catch (e) {}
        var plan = String(body.planId || '');
        window.__e2eSeq++;
        var on = 'E2E-ORDER-' + window.__e2eSeq;
        var payload = {ok:true,data:{orderNo:on,amountFen:amountOf(plan),codeUrl:'weixin://wxpay/bizpayurl?pr='+on}};
        var mk = function(){ return new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}}); };
        // 挂起模式：构造「A 套餐建单在飞 → B 套餐建单完成 → 再释放 A」竞态
        if (window.__e2eHoldPurchase) {
          window.__e2eHoldPurchase = false;
          window.__e2eHeldOrderNo = on;
          window.__e2eHeldPlan = plan;
          return new Promise(function(res){ window.__e2ePurchaseResolve = res; });
        }
        return Promise.resolve(mk());
      }
      if (u.indexOf('/api/license/pay/query') >= 0) {
        var m = /orderNo=([^&]+)/.exec(u);
        var qon = m ? decodeURIComponent(m[1]) : '';
        window.__e2eQueryOrders.push(qon);
        // 挂起模式：用于构造「A 单查单在飞 → 发起 B 单 → 再释放 A 的 paid」竞态
        if (window.__e2eHoldNext) {
          window.__e2eHoldNext = false;
          window.__e2eHeldOrder = qon;
          return new Promise(function(res){ window.__e2eHoldResolve = res; });
        }
        // 其余订单：有响应脚本就按脚本逐条消费，否则按 __e2eDefaultStatus 响应（各场景自行设置）
        var st = window.__e2eDefaultStatus;
        if (window.__e2eQueryScript && window.__e2eQueryScript.length) st = window.__e2eQueryScript.shift();
        return Promise.resolve(new Response(JSON.stringify({ok:true,data:{orderNo:qon,status:st}}),{status:200,headers:{'Content-Type':'application/json'}}));
      }
      if (u.indexOf('/api/qrcode') >= 0) {
        var mt = /text=([^&]+)/.exec(u);
        window.__e2eQrTexts.push(mt ? decodeURIComponent(mt[1]) : '');
      }
      return window.__e2eBase(u, o);
    };
    return 'installed';
  })()`);
  // 释放被挂起的建单响应（A0 四轮 P2：模拟迟到的 purchase 回调）
  const releasePurchase = () => ev(`(function(){
    if (!window.__e2ePurchaseResolve) return 'no-held';
    var res = window.__e2ePurchaseResolve;
    window.__e2ePurchaseResolve = null;
    var on = window.__e2eHeldOrderNo;
    var plan = window.__e2eHeldPlan || '';
    res(new Response(JSON.stringify({ok:true,data:{
      orderNo:on,
      amountFen:(plan === 'jz_guard_yearly' ? 9900 : 1900),
      codeUrl:'weixin://wxpay/bizpayurl?pr='+on
    }}),{status:200,headers:{'Content-Type':'application/json'}}));
    return 'released';
  })()`);
  // 释放被挂起的查单响应（status: paid / pending / closed）
  const releaseHeld = (status) => ev(`(function(){
    if (!window.__e2eHoldResolve) return 'no-held';
    var res = window.__e2eHoldResolve;
    window.__e2eHoldResolve = null;
    var on = window.__e2eHeldOrder;
    // 响应里带回「被挂起的那个订单号」，确保它是 A 单的响应而非 B 单的
    res(new Response(JSON.stringify({ok:true,data:{orderNo:on,status:'${status}'}}),{status:200,headers:{'Content-Type':'application/json'}}));
    return 'released';
  })()`);
  const releaseRefresh = () => ev(`(function(){
    if (!window.__e2eRefreshResolve) return 'no-held';
    var res = window.__e2eRefreshResolve;
    window.__e2eRefreshResolve = null;
    res(new Response(JSON.stringify({ok:true,data:{refreshed:true}}),{status:200,headers:{'Content-Type':'application/json'}}));
    return 'released';
  })()`);
  const removeStub = () => ev(`(function(){
    if (window.__e2eBase) { window.fetch = window.__e2eBase; delete window.__e2eBase; return 'removed'; }
    return 'none';
  })()`);
  const payStatus = () => ev(`(function(){var el=document.querySelector('#jz-pay-status');return el?el.textContent.trim():null})()`);
  const payAmount = () => ev(`(function(){var el=document.querySelector('#jz-pay-flow .jz-kv b');return el?el.textContent.trim():null})()`);
  const payFlowVisible = () => ev(`(function(){var b=document.querySelector('#jz-pay-flow');return !!b && b.style.display!=='none'})()`);
  const buy = (plan) => ev(`(function(){var b=document.querySelector('.jz-buy-btn[data-plan="${plan}"]');if(!b)return 'no-btn';b.click();return 'clicked'})()`);
  // 真实用户路径：点「我已完成支付」触发首次查单
  const clickPayDone = () => ev(`(function(){var b=document.querySelector('#jz-pay-done');if(!b)return 'no-btn';b.click();return 'clicked'})()`);
  const queryCount = () => ev(`window.__e2eQueryOrders.length`);

  try {
    await send('Network.enable', {});
    // 打开面板并落到「设置 → 会员与支付」
    await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`);
    await sleep(2500);
    await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`);
    await sleep(400);
    await ev(`(function(){var m=document.querySelector('.jz-setitem[data-set="member"]');if(m)m.click();return 1;})()`);
    await sleep(1000);
    // 前置守卫：上一轮 E2E 结尾的 destroy() 会让面板失效且不会自愈，
    // 必须等 dev daemon 重新注入（重启 daemon 或刷新 WorkBuddy）才能继续。
    // 不检查的话会得到一串 null 的「假 FAIL」，非常误导。
    const buyBtnCount = await ev(`document.querySelectorAll('.jz-buy-btn').length`);
    if (!buyBtnCount) {
      throw new Error(
        '会员页没有渲染出购买按钮（.jz-buy-btn）——面板可能已被上一次 E2E 的 destroy() 销毁。' +
        '处理：重启 dev daemon（会自动重新注入），或刷新 WorkBuddy 页面后重跑。'
      );
    }
    console.log('buy buttons:', buyBtnCount);
    console.log('stub:', await installStub());

    await scene(1, async () => {
    // ---- 场景1：旧单同步中切换新单 ----
    await buy('jz_guard_yearly_coupon');
    await sleep(6000); // 让旧链跑 1~2 轮
    const c1 = refreshCount;
    const oldStatus = await payStatus();
    await buy('jz_guard_yearly'); // 发起新单 → 旧链必须作废
    await sleep(7000);
    const c2 = refreshCount;
    const newStatus = await payStatus();
    const newPayFlowVisible = await ev(`(function(){var b=document.querySelector('#jz-pay-flow');return !!b && b.style.display!=='none'})()`);
    // 单链 3s/轮 → 7s 内预期 1~2 次（+首次延迟内可能 1 次）；若旧链仍在则 ≥4 次
    const s1pass = (c2 - c1) <= 3 && /第 [12] 次/.test(String(newStatus)) && newPayFlowVisible;
    results.push({ scene: '1 旧单→新单：旧链作废', pass: s1pass, detail: { refreshedBefore: c1, after: c2, delta: c2 - c1, oldStatus, newStatus, newPayFlowVisible } });

    });

    await scene(2, async () => {
    // ---- 场景2（A0 三轮 P2）：A 单查单在飞 → 发起 B 单 → 释放 A 的 paid ----
    // 断言：A 的在飞响应必须被丢弃——不启动同步链（refresh 不增）、不改写 B 的状态文字、不隐藏 B 支付区。
    await ev(`(function(){window.__e2eDefaultStatus='pending';window.__e2eHoldNext=true;return 1;})()`);
    await buy('jz_guard_yearly_coupon');           // A 单：首条 pay/query 挂起
    await sleep(1200);
    const heldOrder = await ev(`window.__e2eHeldOrder`);
    await buy('jz_guard_yearly');                  // B 单：替换 payOrder 并递增 payPollGen
    await sleep(1500);
    const beforeRelease = refreshCount;
    const bStatusBefore = await payStatus();
    const inPageBefore = await ev(`window.__e2eRefresh`);
    const released = heldOrder ? await releaseHeld('paid') : 'no-held';  // 此刻释放 A 的 paid 响应
    await sleep(7000);                              // 若 A 接管，首次延迟（1.5s）后应出现 refresh
    const afterRelease = refreshCount;
    const inPageAfter = await ev(`window.__e2eRefresh`);
    const bStatusAfter = await payStatus();
    const bPayFlowVisible = await ev(`(function(){var b=document.querySelector('#jz-pay-flow');return !!b && b.style.display!=='none'})()`);
    // 三条断言对应 Codex 要求：① A 响应未调用 startPaySync（refresh 计数不增，网络层 + 页面层双重佐证）
    // ② 未改写 B 的支付 UI（状态文字不变、支付区仍可见） ③ 挂起的确是 A 单（heldOrder 非空）
    const racePass = !!heldOrder && (afterRelease === beforeRelease) && (inPageAfter === inPageBefore)
      && bPayFlowVisible && !/会员已激活|支付成功/.test(String(bStatusAfter));
    results.push({ scene: '2 A 单在飞查单→B 单→释放 A paid：A 响应被丢弃', pass: racePass, detail: { heldOrder, released, refreshedBefore: beforeRelease, after: afterRelease, delta: afterRelease - beforeRelease, inPageBefore, inPageAfter, bStatusBefore, bStatusAfter, bPayFlowVisible } });

    });

    await scene(3, async () => {
    // ---- 场景3（A0 四轮 P2）：A 套餐建单在飞 → B 套餐建单完成 → 释放 A 的建单响应 ----
    // 断言：A 的迟到建单回调不得写 payOrder / 重建支付区 / 请求二维码——
    //       B 的金额、状态、后续查单与二维码均未被改写。
    await ev(`(function(){window.__e2eDefaultStatus='pending';window.__e2eQueryOrders=[];window.__e2eQrTexts=[];window.__e2eHoldPurchase=true;return 1;})()`);
    await buy('jz_guard_yearly_coupon');            // A 套餐：建单挂起（应付 ¥19.00）
    await sleep(1200);
    const heldPurchaseOrder = await ev(`window.__e2eHeldOrderNo`);
    await buy('jz_guard_yearly');                   // B 套餐：建单立即返回（应付 ¥99.00）→ 作废旧建单
    await sleep(6000);                              // 等 B 的二维码请求落定，避免状态文案抖动
    const pAmountBefore = await payAmount();
    const pStatusBefore = await payStatus();
    const releasedPurchase = heldPurchaseOrder ? await releasePurchase() : 'no-held';  // 释放 A 的迟到建单响应
    await sleep(6000);
    const pAmountAfter = await payAmount();
    const pStatusAfter = await payStatus();
    const pFlowVisible = await payFlowVisible();
    const queriedOrders = String(await ev(`window.__e2eQueryOrders.join(',')`));
    const qrTexts = String(await ev(`window.__e2eQrTexts.join('|')`));
    const aMarker = 'pr=' + String(heldPurchaseOrder);
    const queriedA = queriedOrders ? queriedOrders.split(',').includes(String(heldPurchaseOrder)) : false;
    const qrAskedA = qrTexts ? qrTexts.split('|').some((t) => t === aMarker || t.endsWith(aMarker)) : false;
    const purchasePass = !!heldPurchaseOrder
      && pAmountBefore === '¥99.00' && pAmountAfter === '¥99.00'  // 金额未被 A 的 ¥19.00 覆盖
      && pStatusAfter === pStatusBefore                            // 状态文案未被 A 重建
      && pFlowVisible                                              // 支付区未被隐藏
      && !queriedA                                                 // 从未对 A 单发起查单（payOrder 未被替换）
      && !qrAskedA;                                                // 从未为 A 单请求二维码
    results.push({ scene: '3 A 建单在飞→B 建单完成→释放 A：A 响应被丢弃', pass: purchasePass, detail: { heldPurchaseOrder, releasedPurchase, pAmountBefore, pAmountAfter, pStatusBefore, pStatusAfter, pFlowVisible, queriedOrders, qrTexts, queriedA, qrAskedA } });

    // 回到立即 paid 模式，供后续场景使用
    await ev(`(function(){window.__e2eDefaultStatus='paid';window.__e2eHoldPurchase=false;return 1;})()`);
    await buy('jz_guard_yearly_coupon');
    await sleep(6000); // 让同步链跑起来，供关闭面板场景观测

    });

    await scene(4, async () => {
    // ---- 场景4：关闭面板后停止刷新 ----
    // 前置断言（A0 五轮 P2-3）：没有活动链时「刷新数不变」必然成立，属于空跑通过。
    if (!(await hasActiveSyncChain())) {
      failResult('4 关闭面板后不再刷新', { reason: '前置不足：观测 5s 内无 /api/license/refresh，说明没有活动的同步链，此时断言必然通过＝空跑' }, true);
      return;
    }
    await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(c)c.click();return 1;})()`);
    await sleep(800);
    const c3 = refreshCount;
    await sleep(8000);
    const c4 = refreshCount;
    const s3pass = c4 === c3;
    results.push({ scene: '4 关闭面板后不再刷新', pass: s3pass, detail: { before: c3, after: c4, delta: c4 - c3, precondition: '关闭前确认有活动链' } });

    });

    await scene(5, async () => {
    // ---- 场景5：停滞态连点重试按钮 3 次，只保留一条链 ----
    // 重开面板，落到会员页
    await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`);
    await sleep(2000);
    await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`);
    await sleep(400);
    await ev(`(function(){var m=document.querySelector('.jz-setitem[data-set="member"]');if(m)m.click();return 1;})()`);
    await sleep(800);
    await buy('jz_guard_yearly_coupon');
    let stallReady = false;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const btnVisible = await ev(`(function(){var b=document.querySelector('#jz-pay-retry-btn');return !!b && b.offsetHeight>0})()`);
      if (btnVisible) { stallReady = true; break; }
    }
    let stallRes = { pass: false, detail: { stalled: stallReady } };
    if (stallReady) {
      const before = refreshCount;
      await ev(`(function(){var b=document.querySelector('#jz-pay-retry-btn');b.click();b.click();b.click();return 1;})()`);
      await sleep(8000);
      const after = refreshCount;
      const st = await payStatus();
      // 连点 3 次若产生 3 条链，8s 内约 3×(8/3)≈8 次；单链预期 2~3 次
      const pass = (after - before) <= 4 && /第 [123] 次/.test(String(st));
      stallRes = { pass, detail: { refreshedDelta: after - before, statusAfterTripleClick: st } };
    }
    results.push({ scene: '5 重试按钮连点 3 次只保留一条链', pass: stallRes.pass, detail: stallRes.detail });

    });

    await scene(8, async () => {
    // ---- 场景8（A0 七轮 P1-1）：pending→pending→paid 必须多次查单并自动收敛到 paid ----
    // 死因复盘：查单排程原是「先判空再赋值」的守卫式写法（if (!payPollTimer) payPollTimer = setTimeout(...)）。
    //   定时器回调消费了句柄却没把它清零，回调里再次走到那个守卫时条件恒为假 → 排不出下一次。
    //   实际行为：点一次查一次 + 3s 后自动查一次 = 共 2 次就停摆；用户若没在这 ~6s 内到账，
    //   面板再也不会自动识别 paid，只能靠手点「我已完成支付」——而手点也只是再查一次。
    // 响应脚本：前 4 次 pending，第 5 次才 paid。
    // ⚠️ 判据必须有区分度（七轮踩过的坑）：最初我只写 2 次 pending + 第 3 次 paid、
    // 并要求 total>=3，结果**修复前后都 PASS**——反向验证直接判 ineffective。
    // 推演修复前的真实时间线：
    //   建单成功会自动发起查单 #1（pending，排 T1）
    //   → 手动点「我已完成支付」查 #2（pending；此时 T1 尚未触发，句柄为真 → 不排程）
    //   → 3s 后 T1 触发查 #3（pending；句柄仍未清零 → 不排程）→ 链就此停摆。
    // 若脚本第 3 个就是 paid，修复前正好撞上，断言形同虚设。
    // 拉长到 4 次 pending 后，修复前必然停在 3 次且永远等不到 paid；
    // 修复后每次 pending 都会续排，5 次内自动收敛。
    const SCRIPT = ['pending', 'pending', 'pending', 'pending', 'paid'];
    await ev(`(function(){window.__e2eDefaultStatus='pending';window.__e2eQueryScript=${JSON.stringify(SCRIPT)};window.__e2eQueryOrders=[];return 1;})()`);
    const bought = await buy('jz_guard_yearly');
    await sleep(1200);
    const clicked = await clickPayDone();     // 手动触发一次查单（真实用户路径）
    await sleep(1200);
    const q1 = await queryCount();
    // 之后不再做任何操作，纯靠自动轮询收敛到 paid（4 次续排 × 3s ≈ 12s）
    await sleep(16000);
    const qN = await queryCount();
    const status = await payStatus();
    const paid = /支付成功/.test(status || '');
    // 硬判据：必须查满 5 次并自动收敛 paid。修复前恒为 3 次且停在「还未查到支付结果」。
    const MIN_QUERIES = SCRIPT.length;
    const s8pass = bought === 'clicked' && clicked === 'clicked' && qN >= MIN_QUERIES && paid;
    results.push({ scene: '8 pending→pending→paid：查单必须多次并自动收敛', pass: s8pass,
      detail: { bought, clicked, afterManual: q1, total: qN, minExpected: MIN_QUERIES, status,
        script: SCRIPT.join(','),
        note: '修复前停在 3 次且永远等不到 paid（链第二次之后不再排程）' } });
    // 复位，避免响应脚本影响后续场景
    await ev(`(function(){window.__e2eQueryScript=null;window.__e2eDefaultStatus='paid';return 1;})()`);
    });

    await scene(7, async () => {
    // ---- 场景7（A0 五轮）：A 链 refresh 在飞 → 切新单 → 释放 → A 的回调必须被丢弃 ----
    // 为什么需要这个确定性场景：同步链是「setTimeout + HTTP 回调」结构，stopPaySync() 会
    // clearTimeout，只有旧链**恰好处于 HTTP 在飞**时，回调返回后才会继续 scheduleNext()。
    // 这个窗口只有几十毫秒 / 3s 周期 ≈ 1~3%，靠场景1 自然撞上纯属运气（四轮手工那次是巧合，
    // 五轮 all 模式重跑时场景1 就 PASS 了）。这里用 stub 把 A 链的 refresh 挂起，
    // 强制让「旧链在飞」成为确定态，paySyncAlive 的守卫才有确定性检验机会。
    await ev(`(function(){window.__e2eDefaultStatus='paid';window.__e2eHoldRefresh=true;return 1;})()`);
    await buy('jz_guard_yearly_coupon');   // A 单 → paid → 启动同步链
    let heldRefresh = false;
    for (let i = 0; i < 24; i++) {          // 最多等 12s，等 A 链进入 refresh 并被挂起
      await sleep(500);
      if (await ev(`!!window.__e2eRefreshResolve`)) { heldRefresh = true; break; }
    }
    if (!heldRefresh) {
      failResult('7 A 链在飞 refresh→B 单→释放：A 回调被丢弃',
        { reason: '12s 内未能挂起 A 链的 refresh，无法构造确定性竞态——本场景无效（不是产品缺陷）' }, true);
      return;
    }
    // ---- 正向基线（A0 七轮 P2-3 / 八轮 P2-4）----
    // 只有上限判定（delta <= 6）是不够的：若 B 单压根没买起来、或 B 的同步链没启动，
    // 「A 单单链甚至零刷新」也能满足 <= 6，于是「什么都没验证」却被记成 PASS。
    // 因此切 B 单这一步必须留下可观测证据。八轮 P2-4 进一步把断言从「变了」收紧为「等于期望值」：
    // stub 的 amountOf() 把 coupon=1900 / yearly=9900 写死，若价格映射错了但「仍然变化」，
    // 宽松的 !== 断言照样通过——必须钉死具体金额才算真的验证了「支付区显示的是 B 单」。
    const EXPECT_A = '¥19.00'; // jz_guard_yearly_coupon → 1900 分
    const EXPECT_B = '¥99.00'; // jz_guard_yearly → 9900 分
    const amountBeforeB = await payAmount();
    const seqBeforeB = await ev(`window.__e2eSeq`);
    const bBought = await buy('jz_guard_yearly'); // B 单 → stopPaySync 递增 gen，但 A 的 refresh 仍在飞
    await sleep(800);
    const amountAfterB = await payAmount();
    const seqAfterB = await ev(`window.__e2eSeq`);
    // 订单号规则：__e2eSeq 每次 purchase 请求 +1；本场景 A、B 是相邻的两次购买，
    // 故 B 的 seq 必须恰好等于 A 的 seq + 1（出现其他数字说明有别的购买混入，场景已脏）。
    const baselineOk = bBought === 'clicked'
      && amountBeforeB === EXPECT_A && amountAfterB === EXPECT_B
      && seqAfterB === seqBeforeB + 1;
    if (!baselineOk) {
      failResult('7 A 链在飞 refresh→B 单→释放：A 回调被丢弃',
        { reason: `正向基线不足：B 单未真正建立（期望 ${EXPECT_A}→${EXPECT_B}、订单号恰好 +1）——本场景无效（不是产品缺陷）`,
          bBought, amountBeforeB, amountAfterB, expectedA: EXPECT_A, expectedB: EXPECT_B, seqBeforeB, seqAfterB }, true);
      return;
    }
    const rBefore = await ev(`window.__e2eRefresh`);
    const releasedRefresh = await releaseRefresh();
    if (releasedRefresh !== 'released') {
      failResult('7 A 链在飞 refresh→B 单→释放：A 回调被丢弃',
        { reason: `释放 A 的在飞 refresh 失败（${releasedRefresh}），没有构造出「旧链回调迟到」这一竞态——本场景无效（不是产品缺陷）`,
          bBought, amountAfterB, releasedRefresh }, true);
      return;
    }
    // 显式等 B 的同步链真正跑起来（B 的首次 refresh 在 startPaySync 后 1.5s）。
    // 不等待的话，B 链若因时序偶发没启动，delta 会是 0 —— 那既不满足上界也不满足下界，
    // 会被记成产品 FAIL，但真实原因是「本轮没构造出可比较的两条链」（七轮 all 模式实测踩到：
    // 阶段2 里 B 链未启动 → delta=0 → 误报 FAIL，连带场景6 也成了 INVALID）。
    let bChainUp = false;
    for (let i = 0; i < 12; i++) {          // 最多等 6s
      await sleep(500);
      if ((await ev(`window.__e2eRefresh`)) > rBefore) { bChainUp = true; break; }
    }
    if (!bChainUp) {
      failResult('7 A 链在飞 refresh→B 单→释放：A 回调被丢弃',
        { reason: 'B 的同步链未启动（6s 内 refresh 计数未增长），无从比较增量——本场景无效（不是产品缺陷）',
          bBought, amountAfterB, releasedRefresh, rBefore }, true);
      return;
    }
    await sleep(14000);                     // 若 A 链复活，会以 3s/轮继续刷新
    const rAfter = await ev(`window.__e2eRefresh`);
    const delta = rAfter - rBefore;
    // 单链（只剩 B）14s 内约 4~5 次；A 若复活则约 9~10 次。
    // 上界 6：单链留 1~2 次余量，双链超出 3 次以上，避免像 10s/阈值4 那样贴边（实测正好 4）。
    // 下界 3（A0 七轮 P2-3）：delta 太小说明 B 的同步链根本没跑起来，那是空跑不是通过。
    const MAX_DELTA = 6, MIN_DELTA = 3;
    const s7pass = delta <= MAX_DELTA && delta >= MIN_DELTA;
    results.push({ scene: '7 A 链在飞 refresh→B 单→释放：A 回调被丢弃', pass: s7pass,
      detail: { heldRefresh, releasedRefresh, bBought, amountBeforeB, amountAfterB, seqBeforeB, seqAfterB,
        baseline: 'B 单已建立（点击成功+金额变化+订单推进）+ B 同步链已观测到刷新', bChainUp,
        refreshBefore: rBefore, after: rAfter, delta,
        maxDelta: MAX_DELTA, minDelta: MIN_DELTA, note: '单链预期4~5，双链约9~10；下界防零链/空跑' } });
    });

    await scene(6, async () => {
    // ---- 场景6：destroy 后不再刷新 ----
    // 前置断言（A0 五轮 P2-3）：同场景4，空闲状态下「destroy 后不刷新」是必然的，不构成验证。
    if (!(await hasActiveSyncChain())) {
      failResult('6 destroy 后不再刷新', { reason: '前置不足：观测 5s 内无 /api/license/refresh，说明没有活动的同步链，此时断言必然通过＝空跑' }, true);
      return;
    }
    const c5 = refreshCount;
    await ev(`(function(){try{if(window.__wbsWidget&&window.__wbsWidget.destroy)window.__wbsWidget.destroy();return 'destroyed'}catch(e){return 'err:'+e.message}})()`);
    await sleep(8000);
    const c6 = refreshCount;
    const s4pass = c6 === c5;
    results.push({ scene: '6 destroy 后不再刷新', pass: s4pass, detail: { before: c5, after: c6, delta: c6 - c5, precondition: 'destroy 前确认有活动链' } });
    });

  } finally {
    // 无论如何都要撤 stub（A0 二轮之前吃过 stub 残留的亏）
    console.log('stub cleanup:', await removeStub());
    console.log('probe(401 expected):', JSON.stringify(await ev(`fetch('${API}/api/license/trial-status').then(r=>({st:r.status}))`)));
  }

  const allPass = results.every((r) => r.pass);
  // A0 七轮 P1-2：三态前缀。INVALID 与 FAIL 必须分开，sabotage 的 judge() 靠它区分
  // 「断言真拦住了竞态」与「本轮压根没跑到断言」。
  results.forEach((r) => console.log(
    `${r.pass ? 'PASS' : (r.invalid ? 'INVALID' : 'FAIL')} — ${r.scene} :: ${JSON.stringify(r.detail)}`));
  const invalidCount = results.filter((r) => r.invalid).length;
  console.log(`\nE2E ${allPass ? 'ALL PASS' : 'HAS FAILURE'}${invalidCount ? `（其中 ${invalidCount} 个场景无效，非产品缺陷）` : ''}`);
  // A0 六轮（自建闸门自查发现的洞）：过滤模式下绝不能覆盖正经的全场景证据。
  // sabotage 阶段1 会带 JZ_E2E_ONLY=<scene> 单场景跑，若照常写 pay-sync-lifecycle-e2e.json，
  // 仓库里那份「7 场景全 PASS」的证据会被改写成「只有 1 个场景且 FAIL」——
  // 而这恰恰是**故意破坏守卫后**的预期结果。一旦误提交，正经证据就变成了污染证据，且看不出是被污染的。
  // 故：过滤模式一律写到 .filtered.json，正经证据只由完整全场景运行产生。
  const evidenceName = only ? 'pay-sync-lifecycle-e2e.filtered.json' : 'pay-sync-lifecycle-e2e.json';
  // A0 七轮 P2-4：证据落盘必须 fail-closed。
  // 原写法 catch 里只打日志继续走，于是「exit 0 但根本没有可信证据文件」是可能的，
  // 而阶段2 的 all-pass 结论正是靠这个文件被采信的 —— 没有证据的成功比失败更危险。
  let evidenceOk = false;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const evidencePath = path.join(OUT, evidenceName);
    fs.writeFileSync(evidencePath,
      JSON.stringify({ at: new Date().toISOString(), filtered: only ? only : undefined, results, allPass }, null, 2));
    // 写完必须回读校验：能解析、且结果条数与本次运行一致，才算真的落盘成功
    const back = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    if (!back || !Array.isArray(back.results) || back.results.length !== results.length) {
      throw new Error(`回读校验不通过：本次 ${results.length} 条，读回 ${back && back.results ? back.results.length : 'null'}`);
    }
    evidenceOk = true;
    if (only) console.log(`\n（过滤模式：证据写入 ${evidenceName}，未覆盖全场景证据 pay-sync-lifecycle-e2e.json）`);
  } catch (e) {
    console.error(`\n❌ 证据落盘失败（fail-closed）：${e.message}`);
    console.error(`   本次运行的结论不予采信，退出码置为非 0。`);
  }
  ws.close();
  process.exit(allPass && evidenceOk ? 0 : 1);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
