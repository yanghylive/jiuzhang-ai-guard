'use strict';
// A0 二轮 P2 回归：支付权益同步链（syncEntitlementAfterPay）生命周期契约。
// inject.js 是浏览器 IIFE，闭包函数无法直接 require 调用，故用源码契约断言把「所有权/取消」
// 的关键实现钉死——任何人删掉某个生命周期出口（取消/新单/解锁/关面板/销毁）测试即失败。
// 行为级验证由 test/e2e/cdp-pay-sync-lifecycle.js 真机 CDP 跑（可复现）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');

// 取某个函数（或片段）起点后的窗口文本，窗口内做断言，避免整文件误命中
function windowAfter(marker, size = 1400) {
  const i = SRC.indexOf(marker);
  assert.notEqual(i, -1, `源码中应存在: ${marker}`);
  return SRC.slice(i, i + size);
}

test('同步链状态：必须持有 generation + timer 句柄 + 订单号三个所有权变量', () => {
  assert.ok(/var paySyncGen = 0;/.test(SRC), '应有 generation 计数器 paySyncGen');
  assert.ok(/var paySyncTimer = null;/.test(SRC), '应保存 timer 句柄 paySyncTimer（可取消）');
  assert.ok(/var paySyncOrderNo = null;/.test(SRC), '应绑定订单号 paySyncOrderNo（防旧单串扰）');
});

test('stopPaySync：递增 generation + 清 timer + 清订单号', () => {
  const w = windowAfter('function stopPaySync() {', 400);
  assert.ok(/paySyncGen\+\+/.test(w), 'stopPaySync 必须递增 generation（作废在飞回调）');
  assert.ok(/clearTimeout\(paySyncTimer\)/.test(w), 'stopPaySync 必须清 timer 句柄');
  assert.ok(/paySyncOrderNo = null;/.test(w), 'stopPaySync 必须清订单号');
});

test('paySyncAlive：同时校验 generation 与订单号', () => {
  const w = windowAfter('function paySyncAlive(gen, orderNo) {', 400);
  assert.ok(/gen !== paySyncGen/.test(w), '应校验 generation 是否仍为当前链');
  assert.ok(/orderNo !== paySyncOrderNo/.test(w), '应校验订单号是否仍为当前链');
});

test('每轮回调入口有守卫：同步链入口与网络回调都先校验仍属当前链', () => {
  const w = windowAfter('function syncEntitlementAfterPay(round, orderNo, gen) {', 2000);
  const guardCount = (w.match(/paySyncAlive\(gen, orderNo\)/g) || []).length;
  assert.ok(guardCount >= 3, `同步链内应至少 3 处 paySyncAlive 守卫（入口/成功回调/异常回调/停滞），实际 ${guardCount}`);
});

test('生命周期出口 1：发起新单作废旧同步链', () => {
  const w = windowAfter('function startWechatPay(btn, planId) {', 400);
  assert.ok(/stopPaySync\(\);/.test(w), 'startWechatPay 必须调 stopPaySync（新单作废旧链）');
});

test('生命周期出口 2：取消订单必须同时掐断同步链（不只停查单）', () => {
  const w = windowAfter("var cancelBtn = box.querySelector('#jz-pay-cancel');", 600);
  assert.ok(/stopPayPoll\(\);/.test(w), '取消应停止查单轮询');
  assert.ok(/stopPaySync\(\);/.test(w), '取消必须同时停止同步链（A0 二轮 P1 修复点）');
});

test('生命周期出口 3：解锁成功收尾停止后续轮次', () => {
  const w = windowAfter("payState('会员已激活');", 400);
  assert.ok(/stopPaySync\(\);/.test(w), '解锁成功后应停止同步链，不再继续刷新');
});

test('生命周期出口 4：销毁 / 重注入清理同步链（registerDisposer）', () => {
  // inject.js 有多处 registerDisposer，定位「支付生命周期」那处（同时清理查单与同步链）
  const hits = [];
  let from = 0;
  for (;;) {
    const i = SRC.indexOf('registerDisposer(function () {', from);
    if (i === -1) break;
    hits.push(SRC.slice(i, i + 600));
    from = i + 1;
  }
  assert.ok(hits.length > 0, '应存在 registerDisposer 生命周期钩子');
  const pay = hits.filter((w) => /stopPayPoll\(\);/.test(w));
  assert.ok(pay.length > 0, '应有一处 disposer 清理支付查单轮询');
  assert.ok(pay.some((w) => /stopPaySync\(\);/.test(w)), '该 disposer 必须同时停止同步链（防旧闭包继续刷新）');
});

test('生命周期出口 5：关闭面板停止同步链', () => {
  const w = windowAfter('function setOpen(open) {', 900);
  const elseIdx = w.indexOf('stopCheckinPolling();');
  assert.notEqual(elseIdx, -1, 'setOpen 应有关闭分支');
  assert.ok(/stopPaySync\(\);/.test(w.slice(elseIdx)), '关闭面板分支必须停止同步链');
});

test('重试按钮：走 startPaySync（内部先 stopPaySync）而非直调同步链，连点只保留一条链', () => {
  const w = windowAfter("var btn = b.querySelector('#jz-pay-retry-btn');", 900);
  assert.ok(/startPaySync\(/.test(w), '重试应走 startPaySync');
  assert.ok(!/syncEntitlementAfterPay\(0\);/.test(w), '重试不得直调 syncEntitlementAfterPay（否则连点产生多条链）');
  const s = windowAfter('function startPaySync(orderNo) {', 400);
  assert.ok(/stopPaySync\(\);/.test(s), 'startPaySync 必须先 stopPaySync（保证同时只存在一条链）');
});

test('首次延迟也纳入 timer 管理（取消可掐断 1.5s 等待）', () => {
  const s = windowAfter('function startPaySync(orderNo) {', 500);
  assert.ok(/paySyncTimer = setTimeout/.test(s), '首次延迟必须由 paySyncTimer 持有，不能是裸 setTimeout');
});

// ===== A0 三轮 P1：查单层（payPollOnce）在飞响应所有权 =====

test('查单层状态：必须有查单 generation（HTTP 不可取消，只能作废响应）', () => {
  assert.ok(/var payPollGen = 0;/.test(SRC), '应有查单 generation payPollGen');
});

test('stopPayPoll：递增 generation（不只清 timer）', () => {
  const w = windowAfter('function stopPayPoll() {', 300);
  assert.ok(/payPollGen\+\+/.test(w), 'stopPayPoll 必须递增 generation，否则在飞查单响应仍可接管新订单');
  assert.ok(/clearTimeout\(payPollTimer\)/.test(w), 'stopPayPoll 仍需清 timer');
});

test('payPollAlive：同时校验查单 generation 与订单号', () => {
  const w = windowAfter('function payPollAlive(gen, orderNo) {', 400);
  assert.ok(/gen !== payPollGen/.test(w), '应校验查单 generation');
  assert.ok(/payOrder\.orderNo !== orderNo/.test(w), '应校验订单号是否仍为当前订单');
});

test('payPollOnce：请求发出前捕获 orderNo + gen，then/catch 入口均校验', () => {
  const w = windowAfter('function payPollOnce(manual) {', 1800);
  assert.ok(/var capturedOrderNo = payOrder\.orderNo;/.test(w), '应在发请求前捕获订单号（不得在回调里读全局 payOrder）');
  assert.ok(/var gen = payPollGen;/.test(w), '应在发请求前捕获 generation');
  assert.ok(/encodeURIComponent\(capturedOrderNo\)/.test(w), '请求 URL 应使用捕获的订单号');
  const guardCount = (w.match(/payPollAlive\(gen, capturedOrderNo\)/g) || []).length;
  assert.ok(guardCount >= 2, `then 与 catch 入口都必须校验，实际 ${guardCount} 处`);
});

test('查单为 paid 时用捕获订单号启动同步链（A 单响应不得启动 B 单同步）', () => {
  const w = windowAfter('function payPollOnce(manual) {', 1800);
  assert.ok(/startPaySync\(capturedOrderNo\);/.test(w), '必须用捕获的订单号启动同步链');
  assert.ok(!/startPaySync\(payOrder \? payOrder\.orderNo/.test(w), '不得再从全局 payOrder 读订单号（旧响应会接管新单）');
});

test('查单层生命周期出口：关闭面板也作废在飞查单', () => {
  const w = windowAfter('function setOpen(open) {', 900);
  const elseIdx = w.indexOf('stopCheckinPolling();');
  assert.notEqual(elseIdx, -1, 'setOpen 应有关闭分支');
  const tail = w.slice(elseIdx);
  assert.ok(/stopPayPoll\(\);/.test(tail), '关闭面板必须 stopPayPoll（递增 gen，作废在飞响应）');
  assert.ok(/stopPaySync\(\);/.test(tail), '关闭面板必须 stopPaySync');
});

// ===== A0 四轮 P1：建单层（purchase / qrcode）在飞响应所有权 =====

test('建单层状态：必须有建单 generation（支付链最上游）', () => {
  assert.ok(/var payPurchaseGen = 0;/.test(SRC), '应有建单 generation payPurchaseGen');
});

test('stopPayPurchase：递增 generation（作废在飞建单/二维码响应）', () => {
  const w = windowAfter('function stopPayPurchase() {', 300);
  assert.ok(/payPurchaseGen\+\+/.test(w), 'stopPayPurchase 必须递增 generation，否则迟到建单响应会覆盖新订单支付区');
});

test('startWechatPay：发请求前捕获 purchaseGen，并发起新单时作废旧建单', () => {
  const w = windowAfter('function startWechatPay(btn, planId) {', 1400);
  assert.ok(/stopPayPurchase\(\);/.test(w), 'startWechatPay 必须作废在飞建单/二维码响应');
  assert.ok(/var purchaseGen = payPurchaseGen;/.test(w), '应在发 POST 前捕获 generation');
  const capIdx = w.indexOf('var purchaseGen = payPurchaseGen;');
  const postIdx = w.indexOf("apiJz('/api/license/purchase'");
  assert.ok(postIdx > capIdx, '捕获 generation 必须发生在发请求之前');
});

test('建单 POST 的 then 入口先校验 generation：失效只恢复自身按钮，绝不写 payOrder', () => {
  const w = windowAfter("apiJz('/api/license/purchase'", 500);
  const guardIdx = w.indexOf('if (!payPurchaseAlive(purchaseGen)) {');
  const writeIdx = w.indexOf('payOrder = data;');
  assert.notEqual(guardIdx, -1, '建单 then 入口必须有 generation 守卫');
  assert.notEqual(writeIdx, -1, '应存在写 payOrder 的语句');
  assert.ok(guardIdx < writeIdx, '守卫必须出现在写 payOrder 之前（否则迟到响应仍会覆盖 payOrder）');
  const guardBody = w.slice(guardIdx, writeIdx);
  assert.ok(/btn\.disabled = false/.test(guardBody), '失效时仅恢复其自身购买按钮');
  assert.ok(!/box\.innerHTML/.test(guardBody), '失效时不得重建支付区');
  assert.ok(!/toast\(/.test(guardBody), '失效时不得弹 toast');
});

test('建单 POST + 二维码共四处回调入口全部校验 generation', () => {
  // purchase.then / qrcode.then / qrcode.catch / purchase.catch
  const w = windowAfter("apiJz('/api/license/purchase'", 3500);
  const guardCount = (w.match(/payPurchaseAlive\(purchaseGen\)/g) || []).length;
  assert.ok(guardCount >= 4, `建单 POST 与二维码的 then/catch 入口都应校验，实际 ${guardCount} 处`);
  assert.ok(/\/api\/qrcode\?text=/.test(w), '二维码请求应在建单 then 内发起，共用同一 generation');
});

// ===== A0 七轮 P1-1：查单轮询第二次之后静默停止 =====

test('P1-1 查单排程必须走 schedulePayPoll()，且回调入口先清零句柄', () => {
  // 死因复盘：原写法 `if (!payPollTimer) payPollTimer = setTimeout(function(){ payPollOnce(false); }, 3000)`
  // 定时器回调执行时句柄没有清零，回调里再次走到 `if (!payPollTimer)` 恒为假 → 排不出下一次。
  // 实际后果：发起查单 → 3s 后再查一次 → 之后永远停摆；用户支付后若没在 ~6s 内到账，
  // 面板再也不会自动识别 paid，只能靠手点「我已完成支付」。
  assert.ok(/function schedulePayPoll\(\) \{/.test(SRC), '应有统一的查单排程函数 schedulePayPoll()');
  const w = windowAfter('function schedulePayPoll() {', 400);
  assert.ok(/if \(payPollTimer\) clearTimeout\(payPollTimer\);/.test(w),
    '重排前必须先 clearTimeout，保证同一时刻只有一条查单链（幂等）');
  // 关键：回调入口清零句柄，必须发生在 payPollOnce 之前
  const clearIdx = w.indexOf('payPollTimer = null;');
  const callIdx = w.indexOf('payPollOnce(false);');
  assert.notEqual(clearIdx, -1, '回调入口必须把句柄清零');
  assert.notEqual(callIdx, -1, '回调入口必须调 payPollOnce');
  assert.ok(clearIdx < callIdx,
    '句柄清零必须发生在 payPollOnce 之前——否则 payPollOnce 里的排程条件恒为假，查单链第二次之后停摆');
});

test('P1-1 pending 与异常两个分支都走 schedulePayPoll()（都能连续重试）', () => {
  const w = windowAfter('function payPollOnce(manual) {', 2200);
  const hits = (w.match(/schedulePayPoll\(\);/g) || []).length;
  assert.ok(hits >= 2, `pending 分支与 catch 异常分支都必须排下一次，实际 ${hits} 处`);
});

test('P1-1 防回归：不得再出现 `if (!payPollTimer)` 守卫式排程', () => {
  // 这个模式本身就是 bug 温床：句柄由 setTimeout 回调消费但不清零，守卫就从「防重复」
  // 变成了「第二次之后永远不满足」。一律走 schedulePayPoll()。
  assert.ok(!/if \(!payPollTimer\)/.test(SRC),
    'inject.js 中不得再出现 `if (!payPollTimer)` —— 守卫式排程会让查单链静默停止，请改用 schedulePayPoll()');
  // 更宽的兜底：任何一个 *Poll*/*Sync* timer 都不许用「未清零句柄 + if(!x) 守卫」的组合
  const bad = SRC.match(/if \(!(pay\w*Timer|devicePollTimer)\)\s*\1\s*=/g);
  assert.ok(!bad, `不得再出现守卫式 timer 排程：${bad && bad.join(', ')}`);
});

test('建单层生命周期出口：取消 / 关闭面板 / 销毁 三处均作废旧建单', () => {
  // 取消
  const cancel = windowAfter("var cancelBtn = box.querySelector('#jz-pay-cancel');", 700);
  assert.ok(/stopPayPurchase\(\);/.test(cancel), '取消订单必须作废旧建单响应');
  // 关闭面板
  const open = windowAfter('function setOpen(open) {', 900);
  const elseIdx = open.indexOf('stopCheckinPolling();');
  assert.notEqual(elseIdx, -1, 'setOpen 应有关闭分支');
  assert.ok(/stopPayPurchase\(\);/.test(open.slice(elseIdx)), '关闭面板必须作废旧建单响应');
  // 销毁 / 重注入
  const hits = [];
  let from = 0;
  for (;;) {
    const i = SRC.indexOf('registerDisposer(function () {', from);
    if (i === -1) break;
    hits.push(SRC.slice(i, i + 700));
    from = i + 1;
  }
  const pay = hits.filter((x) => /stopPayPoll\(\);/.test(x));
  assert.ok(pay.length > 0, '应有一处 disposer 清理支付链路');
  assert.ok(pay.some((x) => /stopPayPurchase\(\);/.test(x)), '该 disposer 必须同时作废在飞建单响应');
});
