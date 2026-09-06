'use strict';
// 设置页角色卡 hover 换装播特效 真机验证（2026-09-05）：
// ① hover 云宝卡 → 72px 预览区换成云宝（MM 引擎 viewBox 0 0 240 240）+ celebrate 粒子出现
// ② mouseleave → 预览恢复当前形象（blob v1 viewBox -15 -15 259 259）
// ③ hover 球球卡 → 预览 v1 彩带爆发（rect/circle 粒子数 > 基线）
// ④ hover 亮亮卡 → 同①
// ⑤ CSS jzCharOptPop 弹跳关键帧在位
// 断言全用字符串/元素计数比对，不用正则数值（多层转义丢 \d 的教训）
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

  // 开面板 → settings → 通用
  await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`);
  await sleep(600);
  await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`);
  await sleep(600);
  await ev(`(function(){var b=document.querySelector('.jz-setitem[data-set="general"]');if(b)b.click();return 1;})()`);
  await sleep(600);

  const ok = await ev(`(function(){return document.querySelector('#fab-char-seg') && document.querySelector('#jz-fab-skin-preview') ? 'ok' : 'missing';})()`);
  check('① 角色卡+预览区在位', ok === 'ok', ok);

  // 预览快照：viewBox + 粒子数（circle+rect 计数，含 fx 粒子）
  const snap = `(function(){
    var p = document.querySelector('#jz-fab-skin-preview svg');
    if (!p) return '{}';
    var n = p.querySelectorAll('circle,rect').length;
    return JSON.stringify({ vb: p.getAttribute('viewBox'), fx: n });
  })()`;
  const hover = (ch) => ev(`(function(){
    var b = document.querySelector('#fab-char-seg [data-fab-char="${ch}"]');
    if (!b) return 'no-btn';
    b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return 'ok';
  })()`);
  const leave = () => ev(`(function(){
    var s = document.querySelector('#fab-char-seg');
    if (!s) return 'no-seg';
    s.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    return 'ok';
  })()`);

  let base = {};
  try { base = JSON.parse(await ev(snap)); } catch (e) { base = {}; }
  const isBlobV1 = base.vb === '-15 -15 259 259';
  console.log('  基线: ' + JSON.stringify(base));

  // ② hover 云宝：换装 MM 引擎 + 特效粒子
  await hover('nimbo'); await sleep(1500); // 120ms 后 celebrate + 粒子飞行中
  let nb = {};
  try { nb = JSON.parse(await ev(snap)); } catch (e) { nb = {}; }
  console.log('  云宝实测: ' + JSON.stringify(nb));
  check('② hover 云宝 → 预览换装 MM 引擎', nb.vb === '0 0 240 240', 'vb=' + nb.vb);
  check('③ 云宝 celebrate 粒子出现', nb.fx > 0, 'fx=' + nb.fx);

  // ④ mouseleave 恢复当前形象（blob v1）
  await leave(); await sleep(1200); // 等粒子消散后 viewBox 判定不受影响，先判 vb
  let rs = {};
  try { rs = JSON.parse(await ev(snap)); } catch (e) { rs = {}; }
  console.log('  移开实测: ' + JSON.stringify(rs));
  check('④ 移开 → 预览恢复球球 v1', rs.vb === '-15 -15 259 259', 'vb=' + rs.vb);

  // ⑤ hover 球球卡：v1 彩带爆发（rect/circle 粒子 > 移开后的静止基线）
  // v1 粒子寿命短（实测 300ms=17 颗、1400ms 消散），必须 400ms 采样，1.5s 会抓空
  const restFx = rs.fx;
  await hover('blob'); await sleep(400);
  let bb = {};
  try { bb = JSON.parse(await ev(snap)); } catch (e) { bb = {}; }
  console.log('  球球实测: ' + JSON.stringify(bb) + ' | 静止基线 fx=' + restFx);
  check('⑤ hover 球球 → v1 彩带粒子爆发', bb.vb === '-15 -15 259 259' && bb.fx > restFx, 'fx=' + bb.fx);

  // ⑥ hover 亮亮：MM 引擎 + 粒子
  await hover('twinkle'); await sleep(1500);
  let tw = {};
  try { tw = JSON.parse(await ev(snap)); } catch (e) { tw = {}; }
  console.log('  亮亮实测: ' + JSON.stringify(tw));
  check('⑥ hover 亮亮 → 换装+粒子', tw.vb === '0 0 240 240' && tw.fx > 0, 'vb=' + tw.vb + ' fx=' + tw.fx);

  // ⑦ 收尾：移开恢复 + CSS 弹跳关键帧在位
  await leave(); await sleep(800);
  const fin = await ev(snap);
  let finO = {}; try { finO = JSON.parse(fin); } catch (e) {}
  check('⑦ 收尾恢复球球', finO.vb === '-15 -15 259 259', 'vb=' + finO.vb);
  const cssOk = await ev(`(function(){
    var ss = document.styleSheets;
    for (var i = 0; i < ss.length; i++) {
      try {
        var rs = ss[i].cssRules;
        for (var j = 0; j < rs.length; j++) {
          if (rs[j].cssText && rs[j].cssText.indexOf('jzCharOptPop') >= 0) return 'ok';
        }
      } catch (e) { /* 跨域样式跳过 */ }
    }
    return 'missing';
  })()`);
  check('⑧ 卡片弹跳关键帧 jzCharOptPop 在位', cssOk === 'ok', cssOk);

  check('页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' || ') || 'clean');

  const pass = results.filter(Boolean).length;
  console.log('== ' + pass + '/' + results.length + ' PASS ==');
  ws.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('PROBE ERR: ' + (e && e.message)); process.exit(2); });
