'use strict';
// 拖拽跟手 + 热区贴合 真机验证（2026-09-05，scale 坐标补偿修复回归）
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

  await send('Page.enable');
  await send('Runtime.enable');
  const errs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text);
  });

  // 清旧位置记忆 + 刷新重注入
  await ev('(function(){try{localStorage.removeItem("wbs-fab-pos")}catch(e){}return 1;})()');
  await send('Page.reload'); await sleep(9000);

  const s0 = JSON.parse(await ev('(function(){var f=document.querySelector(".wbs-fab");var b=document.querySelector(".wbs-fab-ball");var rf=f.getBoundingClientRect();var rb=b.getBoundingClientRect();return JSON.stringify({fab:{l:rf.left,t:rf.top,w:rf.width,h:rf.height},ball:{cx:rb.left+rb.width/2,cy:rb.top+rb.height/2,w:rb.width}});})()'));
  console.log('初始:', JSON.stringify(s0));
  check('① 球初始在位', s0.ball.w > 10, JSON.stringify(s0.ball));

  // 真实拖拽：球心按下 → 平滑拖到目标 → 松开
  // 目标点 viewport 自适应（2026-09-05 Codex 打回：硬编码 (400,320) 在小窗口下球被边缘 clamp，
  // 拖拽偏差 477px 假 FAIL——CDP Input 坐标是 viewport CSS 像素，必须先读 innerWidth/innerHeight）。
  const vp = JSON.parse(await ev('(function(){return JSON.stringify({w:window.innerWidth,h:window.innerHeight});})()'));
  // 安全区：左右各留 100px、顶部留 120px、底部留 160px（躲开停靠边缘/任务类 UI 的 clamp 区）
  const safeX = (x) => Math.max(100, Math.min(x, vp.w - 100));
  const safeY = (y) => Math.max(120, Math.min(y, vp.h - 160));
  let target = { x: safeX(400), y: safeY(320) };
  // 目标与球初始位太近（<160px）拖不出有效位移 → 改拖向窗口象限对角
  const dist0 = Math.sqrt(Math.pow(target.x - s0.ball.cx, 2) + Math.pow(target.y - s0.ball.cy, 2));
  if (dist0 < 160) {
    target = { x: safeX(vp.w / 2 - (s0.ball.cx < vp.w / 2 ? vp.w / 4 : -vp.w / 4)), y: safeY(vp.h / 2) };
  }
  console.log('INFO | viewport=' + vp.w + 'x' + vp.h + ' 拖拽目标=(' + Math.round(target.x) + ',' + Math.round(target.y) + ') 初始球心=(' + Math.round(s0.ball.cx) + ',' + Math.round(s0.ball.cy) + ')');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(s0.ball.cx), y: Math.round(s0.ball.cy), button: 'left', buttons: 1, clickCount: 1 });
  await sleep(120);
  for (let i = 1; i <= 10; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(s0.ball.cx + (target.x - s0.ball.cx) * i / 10),
      y: Math.round(s0.ball.cy + (target.y - s0.ball.cy) * i / 10),
      buttons: 1,
    });
    await sleep(40);
  }
  await sleep(200);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(500);

  const s1 = JSON.parse(await ev('(function(){var b=document.querySelector(".wbs-fab-ball");var r=b.getBoundingClientRect();return JSON.stringify({cx:r.left+r.width/2,cy:r.top+r.height/2});})()'));
  const drift = Math.sqrt(Math.pow(s1.cx - target.x, 2) + Math.pow(s1.cy - target.y, 2));
  check('② 拖后球心贴合鼠标落点（误差<10px）', drift < 10,
    'drift=' + drift.toFixed(1) + 'px ball=(' + s1.cx.toFixed(0) + ',' + s1.cy.toFixed(1) + ') target=(' + Math.round(target.x) + ',' + Math.round(target.y) + ') viewport=' + vp.w + 'x' + vp.h);

  // 热区贴合：球心真实点击 → 面板应打开（拖拽 swallow 只吃拖后第一次 click）
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1 });
    await sleep(80);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1 });
    await sleep(600);
  };
  const isOpen = '!!(function(){var p=document.querySelector(".wbs-panel");return p&&getComputedStyle(p).display.indexOf("none")<0;})()';
  await clickAt(s1.cx, s1.cy);
  let open = await ev(isOpen);
  console.log('INFO | 第一次球心点击 open=' + open + '（拖拽 swallow 吃掉属预期）');
  if (!open) {
    // 二次点击前输出诊断：球还在不在原位、面板 DOM 在不在（视口变化/重建都会在这一眼看出来）
    const diag = await ev('(function(){var b=document.querySelector(".wbs-fab-ball");var p=document.querySelector(".wbs-panel");var rb=b?b.getBoundingClientRect():null;return JSON.stringify({ball:rb?{cx:rb.left+rb.width/2,cy:rb.top+rb.height/2,w:rb.width}:null,panel:!!p,panelDisplay:p?getComputedStyle(p).display:null});})()');
    console.log('INFO | 二次点击前诊断 | ' + diag);
    await clickAt(s1.cx, s1.cy);
    open = await ev(isOpen);
  }
  check('④ 点击热区贴合（球心点击能开面板）', open === true, 'open=' + open);

  // 收尾：关面板 + 清拖拽记忆恢复默认位
  await ev('(function(){var c=document.querySelector(".wbs-btn-close");if(c)c.click();return 1;})()');
  await sleep(400);
  await ev('(function(){try{localStorage.removeItem("wbs-fab-pos")}catch(e){}return 1;})()');
  check('⑤ 全程零页面异常', errs.length === 0, errs.slice(0, 2).join('||'));

  ws.close();
  console.log('\n==== 拖拽跟手+热区贴合: ' + results.filter(Boolean).length + '/' + results.length + ' PASS ====');
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => { console.error('[probe] 致命:', e.message); process.exit(1); });
