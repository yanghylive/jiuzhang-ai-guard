'use strict';
// 浏览器行为回归（第七轮复查 P2）：隐私盾「点击发送 → 拦截 → 扫描 → 确认 → 重放」全链路，
// 用 jsdom + vm 运行注入脚本里的 __wbsPrivacyFactory 真实验证，替代纯结构断言。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let JSDOM = null;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (_) {
  try {
    JSDOM = require(require('node:path').join(process.env.HOME || '', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'jsdom')).JSDOM;
  } catch (_) { /* devDep 未安装：下面统一跳过 */ }
}

const INJECT_SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');

// 从 inject.js 提取 __wbsPrivacyFactory 函数源码（括号配对），在 vm 中实例化。
function extractFactorySrc() {
  const marker = 'function __wbsPrivacyFactory(deps) {';
  const start = INJECT_SRC.indexOf(marker);
  assert.ok(start !== -1, 'inject.js 必须包含 __wbsPrivacyFactory');
  let depth = 0;
  let i = start + marker.indexOf('{');
  for (; i < INJECT_SRC.length; i++) {
    const ch = INJECT_SRC[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return INJECT_SRC.slice(start, i + 1);
}

function makeDom() {
  const html = `<body>
    <div id="composer-wrap">
      <div id="composer" contenteditable="true">我的 token 是 kda_AbCdEf12345678901234</div>
      <button id="send">发送</button>
    </div>
    <div id="other">
      <button id="other-submit">提交</button>
    </div>
  </body>`;
  return new JSDOM(html);
}

function buildGuard(dom, hooks) {
  const ctx = {};
  ctx.KeyboardEvent = dom.window.KeyboardEvent;
  ctx.Set = Set;
  ctx.Promise = Promise;
  vm.runInNewContext('globalThis.__factory = ' + extractFactorySrc() + ';', ctx);
  return ctx.__factory({
    document: dom.window.document,
    getEnabled: hooks.getEnabled || (() => true),
    findComposer: () => dom.window.document.getElementById('composer'),
    findSendButton: () => dom.window.document.getElementById('send'),
    readText: (c) => (c && c.textContent || '').replace(/[\uFEFF\u200B\u00A0]/g, '').trim(),
    fetchScan: hooks.fetchScan,
    confirmDialog: hooks.confirmDialog,
    markHealth: hooks.markHealth || (() => {}),
  });
}

if (JSDOM) {
test('隐私盾：真实点击链路——拦截→扫描→确认→重放一次，无死循环，标记立即清除', async () => {
  const dom = makeDom();
  const doc = dom.window.document;
  const sendBtn = doc.getElementById('send');
  let sendCount = 0;
  let scanCount = 0;
  let dialogCount = 0;
  let healthCount = 0;
  // 模拟应用的发送处理器（在应用自己监听上计数）
  sendBtn.addEventListener('click', () => sendCount++);
  const guard = buildGuard(dom, {
    fetchScan: () => { scanCount++; return Promise.resolve([{ type: 'token', hint: 'API Token', match: 'kda_****34（长度 24）' }]); },
    confirmDialog: () => { dialogCount++; return Promise.resolve(true); },
    markHealth: () => healthCount++,
  });

  // 模拟生产接线：document 捕获监听 → interceptClick
  doc.addEventListener('click', function (e) {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b === sendBtn) guard.interceptClick(b, e);
  }, true);

  const clickEvent = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  sendBtn.dispatchEvent(clickEvent);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(clickEvent.defaultPrevented, true, '首击必须被 preventDefault');
  // 重放后：应用处理器恰好执行一次（无死循环）；扫描/确认/健康各一次
  assert.equal(sendCount, 1, '确认后恰好重放一次（无死循环）');
  assert.equal(scanCount, 1, '扫描恰好一次');
  assert.equal(dialogCount, 1, '确认弹窗一次');
  assert.equal(healthCount, 1, '健康标记一次');
  assert.equal(sendBtn.__wbsPrivacyReplay, false, '重放标记必须立即清除（无绕过窗口）');
  // 立即再点一次（内容未变）：会再次进入扫描链路（标记已清，无绕过窗口）
  const again = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  sendBtn.dispatchEvent(again);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(scanCount, 2, '二次点击必须再次扫描（无 500ms 绕过窗口）');
  assert.equal(sendCount, 2, '二次确认后再次发送');
});

test('隐私盾：确认拒绝 → 不重放；无关区域按钮不拦截', async () => {
  const dom = makeDom();
  const doc = dom.window.document;
  const sendBtn = doc.getElementById('send');
  const otherBtn = doc.getElementById('other-submit');
  let sendCount = 0;
  sendBtn.addEventListener('click', () => sendCount++);
  let confirm = true;
  const guard = buildGuard(dom, {
    fetchScan: () => Promise.resolve([{ type: 'token', hint: 'API Token', match: '***' }]),
    confirmDialog: () => Promise.resolve(confirm),
  });

  // 确认拒绝
  confirm = false;
  const e1 = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  await guard.interceptClick(sendBtn, e1);
  assert.equal(sendCount, 0, '确认拒绝不得发送');
  assert.equal(e1.defaultPrevented, true);

  // 无关区域按钮：不拦截、不 preventDefault
  const e2 = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  const r = await guard.interceptClick(otherBtn, e2);
  assert.equal(r, false, '其他区域提交按钮不应被拦截');
  assert.equal(e2.defaultPrevented, false, '不得影响其他按钮');
  // 同区域判定：send 按钮（公共容器含 composer）为真，other 按钮为假
  assert.equal(guard.sendControl(sendBtn), true);
  assert.equal(guard.sendControl(otherBtn), false);
});

test('隐私盾：Enter 发送拦截 → 确认 → 重放带标记，不二次扫描', async () => {
  const dom = makeDom();
  const doc = dom.window.document;
  const composer = doc.getElementById('composer');
  let enterSend = 0;
  let scanCount = 0;
  composer.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterSend++; });
  const guard = buildGuard(dom, {
    fetchScan: () => { scanCount++; return Promise.resolve([{ type: 'phone', hint: '手机号', match: '1381****78' }]); },
    confirmDialog: () => Promise.resolve(true),
  });

  const e = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  // 生产接线：捕获监听 → interceptEnter（target 由 dispatchEvent 决定，直接派发到 composer）
  const handler = function (ev) { if (ev.target === composer) guard.interceptEnter(ev); };
  doc.addEventListener('keydown', handler, true);
  composer.dispatchEvent(e);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(enterSend, 1, 'Enter 确认后恰好重放一次');
  assert.equal(scanCount, 1, '扫描恰好一次（重放事件带标记不二次扫描）');
});

test('隐私盾：扫描失败 fail-open（不阻断发送）', async () => {
  const dom = makeDom();
  const sendBtn = dom.window.document.getElementById('send');
  let sendCount = 0;
  sendBtn.addEventListener('click', () => sendCount++);
  const guard = buildGuard(dom, {
    fetchScan: () => Promise.reject(new Error('network down')),
    confirmDialog: () => { throw new Error('should not be called'); },
  });
  const e = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  const r = await guard.interceptClick(sendBtn, e);
  assert.equal(r, true, '扫描失败应放行');
});

test('隐私盾：并发点击不绕过（第八轮 P1）——排队串行扫描各自时刻内容', async () => {
  const dom = makeDom();
  const doc = dom.window.document;
  const composer = doc.getElementById('composer');
  const sendBtn = doc.getElementById('send');
  let sendCount = 0;
  let scanCount = 0;
  const scannedTexts = [];
  sendBtn.addEventListener('click', () => sendCount++);
  const guard = buildGuard(dom, {
    fetchScan: (text) => { scanCount++; scannedTexts.push(text); return new Promise((r) => setTimeout(() => r([{ type: 'token', hint: 'API Token', match: '***' }]), 20)); },
    confirmDialog: () => Promise.resolve(true),
  });
  doc.addEventListener('click', function (e) {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b === sendBtn) guard.interceptClick(b, e);
  }, true);

  composer.textContent = '内容A token kda_AAA11111111111111';
  const e1 = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  sendBtn.dispatchEvent(e1); // 第一次扫描进行中
  composer.textContent = '内容B token kda_BBB22222222222222'; // 用户修改内容后立刻再点
  const e2 = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  sendBtn.dispatchEvent(e2);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(e1.defaultPrevented, true);
  assert.equal(e2.defaultPrevented, true, '第二次点击同样被拦截（不得 fail-open 直通）');
  assert.equal(scanCount, 2, '两次点击都必须扫描（busy 时排队，不是 fail-open）');
  assert.equal(scannedTexts.length, 2);
  assert.ok(scannedTexts[0].includes('内容A'), '第一次扫描内容为点击时刻内容 A');
  assert.ok(scannedTexts[1].includes('内容B'), '第二次扫描内容为修改后内容 B（各自时刻的内容）');
  assert.equal(sendCount, 2, '两次确认后都重放发送');
});

test('隐私盾：关闭开关 → 原生事件直通（不 preventDefault、不合成重放）', async () => {
  const dom = makeDom();
  const doc = dom.window.document;
  const sendBtn = doc.getElementById('send');
  let sendCount = 0;
  sendBtn.addEventListener('click', () => sendCount++);
  let scanCalls = 0;
  const guard = buildGuard(dom, {
    getEnabled: () => false, // 开关关闭
    fetchScan: () => { scanCalls++; return Promise.resolve([{ type: 'token', hint: 'x', match: '***' }]); },
    confirmDialog: () => Promise.resolve(true),
  });
  const e = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  const r = await guard.interceptClick(sendBtn, e);
  assert.equal(r, false, '关闭时拦截返回 false');
  assert.equal(e.defaultPrevented, false, '关闭时不得 preventDefault（原生事件直通）');
  assert.equal(scanCalls, 0, '关闭时不得扫描');
  assert.equal(sendCount, 0, '不合成重放（宿主 isTrusted 逻辑不受影响）');
});

test('隐私盾：主线程漂浮的其他提交按钮不拦截（body 不是公共容器）', async () => {
  const dom = makeDom();
  const doc = dom.window.document;
  const otherBtn = doc.getElementById('other-submit');
  // 明确断言 textContent 可读（jsdom 无 innerText，但 textContent 有 —— 保证用例真实验证文本判定）
  assert.ok(String(otherBtn.textContent).includes('提交'), 'jsdom textContent 必须可读，否则用例无效');
  const guard = buildGuard(dom, {
    fetchScan: () => Promise.resolve([]),
    confirmDialog: () => Promise.resolve(true),
  });
  assert.equal(guard.sendControl(otherBtn), false, 'body 级漂浮的提交按钮（与输入框无公共容器）不得被拦截');
  const e = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  await guard.interceptClick(otherBtn, e);
  assert.equal(e.defaultPrevented, false, 'body 级无关按钮不得被 preventDefault');
});

test('隐私盾：队列上限（MAX_QUEUE=3）——超限点击被丢弃（preventDefault 且不重放）', async () => {
  const dom = makeDom();
  const doc = dom.window.document;
  const composer = doc.getElementById('composer');
  const sendBtn = doc.getElementById('send');
  let sendCount = 0;
  let scanCount = 0;
  const SCAN_DELAY = 30; // 每次扫描延迟，制造"队列未完成"窗口
  sendBtn.addEventListener('click', () => sendCount++);
  const guard = buildGuard(dom, {
    fetchScan: () => { scanCount++; return new Promise((r) => setTimeout(() => r([{ type: 'token', hint: 'x', match: '***' }]), SCAN_DELAY)); },
    confirmDialog: () => Promise.resolve(true),
  });
  doc.addEventListener('click', function (e) {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b === sendBtn) guard.interceptClick(b, e);
  }, true);
  composer.textContent = '内容 token kda_AAAAAAAAAAAAAAAAAA';
  const evs = [];
  for (let i = 0; i < 3; i++) { const ev = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }); sendBtn.dispatchEvent(ev); evs.push(ev); }
  const e4 = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  sendBtn.dispatchEvent(e4);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e4.defaultPrevented, true, '超限点击同样被 preventDefault（不得 fail-open 直通）');
  assert.equal(scanCount, 1, '串行队列：首个扫描已执行，其余挂起等待');
  assert.equal(sendCount, 0, '队列未完成前全部不重放');
  // 轮询等待队列全部完成（最长 1s，避免偶发延迟）——以重放落地 sendCount 为准，
  // 而不是仅扫描完成（扫描完成≠确认重放已完成，时序抖动会假 fail）
  for (let i = 0; i < 20 && sendCount < 3; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(scanCount, 3, '队列只入队 3 次扫描（第 4 次被丢弃）');
  assert.equal(sendCount, 3, '队列内 3 次确认后都重放；第 4 次点击已丢弃');
  assert.ok(evs.every((ev) => ev.defaultPrevented), '队列内 3 次点击都被拦截');
});
} else {
  test('隐私盾浏览器行为（需 devDep jsdom）', (t) => { t.skip('jsdom 未安装：npm i -D jsdom 后启用'); });
}
