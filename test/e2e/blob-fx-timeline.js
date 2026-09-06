'use strict';
// 球球卡 hover 彩带时间序列定位：celebrate 后 200/500/900/1400ms 各采样一次 fx 计数
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
    if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result ? r.result.result && r.result.result.value : undefined;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 面板应该还开着（上轮 probe 收尾没关）。重新定位到通用分类。
  await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`);
  await sleep(600);
  await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`);
  await sleep(600);
  await ev(`(function(){var b=document.querySelector('.jz-setitem[data-set="general"]');if(b)b.click();return 1;})()`);
  await sleep(600);

  const snap = `(function(){
    var p = document.querySelector('#jz-fab-skin-preview svg');
    if (!p) return '{}';
    var all = p.querySelectorAll('*').length;
    var fx = p.querySelectorAll('circle,rect').length;
    // 直接看实例能力
    return JSON.stringify({ fx: fx, all: all });
  })()`;

  // hover 球球
  await ev(`(function(){var b=document.querySelector('#fab-char-seg [data-fab-char="blob"]');if(b)b.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));return 1;})()`);
  const marks = [300, 600, 900, 1400, 2000];
  let prev = 0;
  for (const ms of marks) {
    await sleep(ms - prev); prev = ms;
    const s = JSON.parse(await ev(snap));
    console.log('t=' + ms + 'ms fx=' + s.fx + ' all=' + s.all);
  }

  // 手动再 celebrate 一次立即采样（绕过 120ms 定时器，排除时序）
  await ev(`(function(){var b=document.querySelector('#fab-char-seg [data-fab-char="blob"]');if(b)b.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));return 1;})()`);
  await sleep(200);
  // 直接对预览实例手动 burst：确认引擎粒子管线本身通不通
  const manual = await ev(`(function(){
    // 预览实例闭包里拿不到，但 celebrate 已由 hover 触发过；这里从 hover 后的 svg 找 fx 层
    var p = document.querySelector('#jz-fab-skin-preview svg');
    if (!p) return 'no-svg';
    var gs = p.querySelectorAll('g');
    var info = [];
    for (var i = 0; i < gs.length; i++) {
      var t = gs[i].getAttribute('transform') || '';
      if (t.indexOf('scale(2.2)') >= 0) info.push('zoomfx:' + gs[i].children.length);
    }
    var fx = p.querySelectorAll('circle,rect').length;
    return JSON.stringify({ fx: fx, zoomGroups: info.join(',') });
  })()`);
  console.log('手动采样(200ms): ' + manual);
  ws.close();
}

main().catch((e) => { console.error('PROBE ERR: ' + (e && e.message)); process.exit(2); });
