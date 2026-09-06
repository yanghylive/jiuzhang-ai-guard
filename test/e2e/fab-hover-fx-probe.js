'use strict';
// hover 触发庆祝特效 真机验证（2026-09-05）
const http = require('node:http');
const WebSocket = require('ws');

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('未找到 WorkBuddy 页面 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let mid = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++mid;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP 超时: ' + method)); }, 30000);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((r) => ws.on('open', r));
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.result && r.result.result.value : undefined;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (n, c, d) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' | ' + n + (d ? ' | ' + d : '')); };

  await send('Runtime.enable');
  const errs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text);
  });

  const nodeCount = '(function(){var b=document.querySelector(".wbs-fab-ball svg");return b?b.querySelectorAll("*").length:-1;})()';
  const ballC = '(function(){var b=document.querySelector(".wbs-fab-ball");var r=b.getBoundingClientRect();return JSON.stringify({cx:r.left+r.width/2,cy:r.top+r.height/2,w:r.width});})()';

  await send('Page.reload'); await sleep(9000);
  const p0 = JSON.parse(await ev(ballC));
  check('① 球在位', p0.w > 10, JSON.stringify(p0));

  // hover 前粒子基线（等残留粒子消散）
  await sleep(3000);
  const base = await ev(nodeCount);
  // 鼠标从远处移入球心（触发 mouseenter）
  for (let i = 0; i < 8; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(p0.cx - 200 + 25 * i), y: Math.round(p0.cy - 150 + 18 * i), buttons: 0 });
    await sleep(50);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(p0.cx), y: Math.round(p0.cy), buttons: 0 });
  await sleep(250);
  const after = await ev(nodeCount);
  check('② hover 触发特效（粒子节点增加）', after - base > 5, 'base=' + base + ' after=' + after + ' delta=' + (after - base));
  // 面板没被误开（hover ≠ click）
  await sleep(600);
  const notOpen = await ev('(function(){var p=document.querySelector(".wbs-panel");return p&&getComputedStyle(p).display.indexOf("none")<0;})()');
  check('③ hover 不开面板', notOpen === false, 'open=' + notOpen);
  // 冷却：立刻再 hover（先移出再移入）粒子不应二次爆发
  for (let i = 0; i < 5; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(p0.cx - 250 + 50 * i), y: Math.round(p0.cy - 180 + 40 * i), buttons: 0 });
    await sleep(40);
  }
  const cooled = await ev(nodeCount);
  for (let i = 0; i < 8; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(p0.cx + 120 - 15 * i), y: Math.round(p0.cy + 80 - 10 * i), buttons: 0 });
    await sleep(30);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(p0.cx), y: Math.round(p0.cy), buttons: 0 });
  await sleep(250);
  const after2 = await ev(nodeCount);
  check('④ 2.5s 冷却生效（二次 hover 无新爆发）', after2 <= cooled + 5, 'cooled=' + cooled + ' after2=' + after2);
  check('⑤ 全程零页面异常', errs.length === 0, errs.slice(0, 2).join('||'));

  ws.close();
  console.log('\n==== hover 特效验证: ' + results.filter(Boolean).length + '/' + results.length + ' PASS ====');
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => { console.error('[probe] 致命:', e.message); process.exit(1); });
