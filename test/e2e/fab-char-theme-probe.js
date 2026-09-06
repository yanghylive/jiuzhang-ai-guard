'use strict';
// 角色选择卡暗色/浅色主题文字可见性 真机验证（2026-09-05）
// 断言方式：直接比对 getComputedStyle().color 字符串（不用正则亮度函数——
// 上轮 probe 的 c.match(/\d+/g) 经 shell→node→CDP 多层转义丢 \d 变 /d+/g，全量假 FAIL）
// 预期（来自 inject.js 面板自包含主题变量）：
//   暗色 --jz-text-1=#f2f2f4 → rgb(242, 242, 244)；active #a87ff2 → rgb(168, 127, 242)
//   浅色 --jz-text-1=#1f1f1f → rgb(31, 31, 31)；active var(--jz-accent)=#722ed1 → rgb(114, 46, 209)
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
  const results = [];
  const check = (name, cond, detail) => {
    results.push(!!cond);
    console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  };

  await send('Runtime.enable');
  const pageErrors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text);
    }
  });

  await send('Page.reload'); await sleep(9000);

  // 开面板 → settings → 通用分类（设置 pane 延迟构建，必须先点分类）
  await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`);
  await sleep(600);
  await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`);
  await sleep(600);
  await ev(`(function(){var b=document.querySelector('.jz-setitem[data-set="general"]');if(b)b.click();return 1;})()`);
  await sleep(600);

  const seg = await ev(`(function(){var s=document.querySelector('#fab-char-seg');return s?'ok':'missing';})()`);
  check('① 角色卡 #fab-char-seg 在位', seg === 'ok', seg);

  // 抓色函数：非 active 卡取 computed color/border/background，active 卡取 color
  const grab = `(function(){
    var seg = document.querySelector('#fab-char-seg');
    if (!seg) return '{}';
    var panel = seg.closest('.wbs-panel');
    var idle = seg.querySelector('.jz-char-opt:not(.active)');
    var act = seg.querySelector('.jz-char-opt.active');
    if (!idle || !act) return 'no-cards';
    function gc(el, p) { return getComputedStyle(el)[p]; }
    return JSON.stringify({
      theme: panel ? (panel.getAttribute('data-jz-theme') || 'unset') : 'no-panel',
      idleColor: gc(idle, 'color'),
      idleBorder: gc(idle, 'borderTopColor'),
      idleBg: gc(idle, 'backgroundColor'),
      activeColor: gc(act, 'color')
    });
  })()`;

  // 先强制深色（面板默认深色，防外部残留状态）
  await ev(`(function(){var b=document.querySelector('[data-theme-btn="dark"]');if(b)b.click();return 1;})()`);
  await sleep(600);
  let d = {};
  try { d = JSON.parse(await ev(grab)); } catch (e) { d = { parseErr: String(e) }; }
  console.log('  深色实测: ' + JSON.stringify(d));
  check('② 深色·未选卡文字=rgb(242, 242, 244)', d.idleColor === 'rgb(242, 242, 244)', 'got ' + d.idleColor);
  check('③ 深色·未选卡边框含白(rgba 255,255,255)', /rgba\(255,\s*255,\s*255/.test(String(d.idleBorder)), 'got ' + d.idleBorder);
  check('④ 深色·未选卡底=rgba(255, 255, 255, 0.06)', d.idleBg === 'rgba(255, 255, 255, 0.06)', 'got ' + d.idleBg);
  check('⑤ 深色·选中卡文字=rgb(168, 127, 242) 亮紫', d.activeColor === 'rgb(168, 127, 242)', 'got ' + d.activeColor);

  // 切浅色
  await ev(`(function(){var b=document.querySelector('[data-theme-btn="light"]');if(b)b.click();return 1;})()`);
  await sleep(600);
  let l = {};
  try { l = JSON.parse(await ev(grab)); } catch (e) { l = { parseErr: String(e) }; }
  console.log('  浅色实测: ' + JSON.stringify(l));
  check('⑥ 浅色·未选卡文字=rgb(31, 31, 31)', l.idleColor === 'rgb(31, 31, 31)', 'got ' + l.idleColor);
  check('⑦ 浅色·未选卡边框=rgb(187, 187, 187)', l.idleBorder === 'rgb(187, 187, 187)', 'got ' + l.idleBorder);
  check('⑧ 浅色·未选卡底=rgb(240, 240, 240)', l.idleBg === 'rgb(240, 240, 240)', 'got ' + l.idleBg);
  check('⑨ 浅色·选中卡文字=rgb(114, 46, 209)', l.activeColor === 'rgb(114, 46, 209)', 'got ' + l.activeColor);

  // 恢复深色收尾
  await ev(`(function(){var b=document.querySelector('[data-theme-btn="dark"]');if(b)b.click();return 1;})()`);
  await sleep(400);
  const back = await ev(`(function(){var p=document.querySelector('.wbs-panel');return p?p.getAttribute('data-jz-theme'):'no-panel';})()`);
  check('⑩ 恢复深色', back === 'dark', 'got ' + back);

  check('页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' || ') || 'clean');

  const pass = results.filter(Boolean).length;
  console.log('== ' + pass + '/' + results.length + ' PASS ==');
  ws.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('PROBE ERR: ' + (e && e.message)); process.exit(2); });
