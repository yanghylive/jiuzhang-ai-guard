'use strict';
// 挂件形象切换 + 线稿 CDP 真机验证（2026-09-04，2026-09-05 Codex 打回修正）：
// ① 新 SDK 在位：window.MoodMates.characters 存在（v1 旧版无 characters，好判别面）。
//    注意：注册中心规范归属是 MoodMates.characters（inject-emotion-ball.js「window.MoodMates.characters = MM.characters」显式暴露），
//    window.EmotionBall 只是兼容路由层（create/version/config），没有 characters——首版 probe 查错对象 12/16 假 FAIL 教训。
// ② MM 双角色注册齐：nimbo/twinkle（blob 走 EB v1 引擎路由，不在 MM 注册中心）
// ③ 设置页卡片在位：#fab-char-seg 三钮 + #sw-fab-sketch
// ④ 切云宝：球 SVG 身体 path 变化（云朵剪影）+ 卡片 active 对齐 + daemon ui-state 持久化
// ⑤ 线稿开：svg 含 is-sketch 类（render.js applySketchChrome），关：类消失
// ⑥ 切回球球 + 线稿关：恢复初始；表情/眼神联动不回归（setEmotion 后 setGaze 仍有 transform 变化）
// ⑦ daemon 持久化验证：GET /api/settings/ui-state 返回切换后的 fabCharacter/fabSketch（页面内 fetch 带会话 token）
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

  // 收集页面 console 错误（重建实例若炸会在这暴露）
  await send('Runtime.enable');
  const pageErrors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text);
    }
  });

  // ⓪ daemon health gate（v9 九轮 P2-4：Codex 复核现场 daemon 未监听，主 probe ⑫⑬
  // 假绿——持久化断言在 daemon 不可达时无意义，开工前必须先确认可达且鉴权通过）。
  // window.__JZ_UI_STATE 为 inject.js v9 暴露的只读探测（token 留闭包）。helper 缺失
  // 说明页面还是旧注入 → 先 reload 重注入一次再试；仍缺失 → 立即 FAIL 非零退出。
  async function readServerUiState() {
    const raw = await ev(`(function(){
      if (typeof window.__JZ_UI_STATE !== 'function') return '"(no-helper)"';
      return window.__JZ_UI_STATE().then(function (d) { return JSON.stringify(d); });
    })()`);
    try { return JSON.parse(raw); } catch (e) { return { __err: '解析失败: ' + raw }; }
  }
  let uiHealth = await readServerUiState();
  if (uiHealth && uiHealth.__err === '(no-helper)') {
    console.log('INFO | 页面为旧注入（无 __JZ_UI_STATE），reload 重注入后重试 health gate');
    await send('Page.enable');
    await send('Page.reload');
    await sleep(9000);
    uiHealth = await readServerUiState();
  }
  check('⓪ daemon 可达且鉴权通过（ui-state 只读探测）', !(uiHealth && uiHealth.__err), JSON.stringify(uiHealth).slice(0, 200));
  if (uiHealth && uiHealth.__err) {
    ws.close();
    console.error('[probe] daemon 不可达/鉴权失败：持久化断言（⑦⑪-13）无意义，拒绝继续（防假绿）。err=' + uiHealth.__err);
    process.exit(1);
  }

  // ① SDK 新版在位 + ② MM 角色注册（架构事实：注册中心 = MoodMates.characters 只管 MM 系角色
  // nimbo/twinkle；blob 走 EB v1 引擎路由（blob/ball/空→v1，见材料 D4），不在 MM 注册——
  // 断言 blob 不存在于 MM 反而是架构一致性的好判别面。blob 行为由 ⑤⑥（切云宝剪影）与 ⑩（切回复原）实测覆盖。
  const sdk = await ev(`(function(){
    if (!window.EmotionBall || typeof window.EmotionBall.create !== 'function') return 'sdk-missing';
    if (!window.MoodMates || !window.MoodMates.characters) return 'old-sdk-no-characters';
    var rc = window.MoodMates.characters;
    return JSON.stringify({
      nimbo: !!rc.get('nimbo'),
      twinkle: !!rc.get('twinkle'),
      blobNotInMM: !rc.get('blob'),
      n: rc.list().length
    });
  })()`);
  let s = {};
  try { s = JSON.parse(sdk); } catch (e) { /* sdk-missing 等 */ }
  check('① 新 SDK 在位（EmotionBall.create + MoodMates.characters）', !!s.nimbo, sdk);
  check('② MM 双角色注册齐（nimbo/twinkle）+ blob 走 v1 不在 MM', s.nimbo && s.twinkle && s.blobNotInMM && s.n >= 2, 'n=' + s.n + ' blobNotInMM=' + s.blobNotInMM);

  // ⑩ 用户偏好快照 + 开工归一（v6 P2-3 / v7 P2-1/P2-2）：归一到 blob 只为 snap0
  // 参照有意义，但必须先保存用户原 fabCharacter/fabSketch。**归一动作必须在快照
  // 之后、且纳入外层 try/finally**（v7 P2-1：归一期间 CDP 断连/关面板失败时偏好
  // 已改 blob 却不进还原——归一必须在 finally 保护圈内）。restoreUserSkin 带
  // **按钮存在性检查 + 恢复后回读逐字段比对**，失败计 skinRestoreErr → ⑱ 结果项
  // 非零退出（v7 P2-2：吞错/按钮缺失静默成功=假绿）。
  await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`);
  await sleep(500);
  await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`);
  await sleep(400);
  const readSkinState = `(function(){
    var a=document.querySelector('#fab-char-seg button.active');
    var sw=document.querySelector('#sw-fab-sketch');
    return JSON.stringify({ch:a?a.getAttribute('data-fab-char'):'(none)', sk:!!(sw&&sw.classList.contains('on'))});
  })()`;
  const userSkin = JSON.parse(await ev(readSkinState));
  console.log('INFO | 用户偏好快照：' + userSkin.ch + (userSkin.sk ? ' + 线稿开' : ''));
  let skinRestoreErr = null;
  const restoreUserSkin = async () => {
    try {
      // 异常可能把面板留在开启态：先按关闭钮可见性关一次，保证已知起始态
      const openNow = await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(!c)return false;var r=c.getBoundingClientRect();return r.width>0&&r.height>0;})()`);
      if (openNow) {
        await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(c)c.click();return 1;})()`);
        await sleep(800);
      }
      await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`);
      await sleep(500);
      await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`);
      await sleep(400);
      const seg = await ev(`(function(){return !!document.querySelector('#fab-char-seg');})()`);
      if (!seg) throw new Error('设置页无法构建，偏好状态无法验证（中途若有改动则未被还原）');
      const cur = JSON.parse(await ev(readSkinState));
      if (cur.ch !== userSkin.ch) {
        const okCh = await ev(`(function(){var b=document.querySelector('#fab-char-seg [data-fab-char="${userSkin.ch}"]');if(b){b.click();return 1;}return 0;})()`);
        if (!okCh) throw new Error('形象卡 [' + userSkin.ch + '] 不存在，无法恢复');
        await sleep(900);
      }
      if (cur.sk !== userSkin.sk) {
        const okSk = await ev(`(function(){var sw=document.querySelector('#sw-fab-sketch');if(sw){sw.click();return 1;}return 0;})()`);
        if (!okSk) throw new Error('线稿开关不存在，无法恢复');
        await sleep(700);
      }
      // v7 P2-2：恢复后回读逐字段比对——「点击没抛错」不是证据
      const fin = JSON.parse(await ev(readSkinState));
      if (fin.ch !== userSkin.ch || fin.sk !== userSkin.sk) {
        throw new Error('恢复后回读不一致：当前 ' + fin.ch + (fin.sk ? '+线稿开' : '+线稿关') + ' vs 快照 ' + userSkin.ch + (userSkin.sk ? '+线稿开' : '+线稿关'));
      }
      await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(c)c.click();return 1;})()`);
      await sleep(600);
      console.log('INFO | 用户偏好已还原并验证：' + userSkin.ch + (userSkin.sk ? ' + 线稿开' : ' + 线稿关') + '（还原前：' + cur.ch + (cur.sk ? '+线稿开' : '+线稿关') + '）');
    } catch (e) {
      skinRestoreErr = e; // v7 P2-2：还原失败必须进 results 非零退出，不许吞
      console.error('⚠️ 用户偏好自动还原失败（产品负责人可能需手动改回 ' + userSkin.ch + (userSkin.sk ? ' + 线稿' : '') + '）: ' + e.message);
    }
  };

  // ===== 从归一起全流程包外层 try——finally 还原用户偏好（v7 P2-1：归一也在圈内） =====
  try {
    if (userSkin.ch !== 'blob') {
      await ev(`(function(){var b=document.querySelector('#fab-char-seg [data-fab-char="blob"]');if(b)b.click();return 1;})()`);
      await sleep(3000);
      console.log('INFO | 开工归一：形象从 ' + userSkin.ch + ' 临时归一到 blob（结束后还原）');
    }
    // 测试前置必须固定为“线稿关闭”。否则用户原本开着线稿时，⑧/⑨
    // 的第一次点击会反向切换，导致连续多项结果被错误归因到产品。
    const normalizedSkin = JSON.parse(await ev(readSkinState));
    if (normalizedSkin.sk) {
      const okSk = await ev(`(function(){var sw=document.querySelector('#sw-fab-sketch');if(sw){sw.click();return 1;}return 0;})()`);
      if (!okSk) throw new Error('开工归一失败：线稿开关不存在');
      await sleep(800);
      const afterNormalize = JSON.parse(await ev(readSkinState));
      if (afterNormalize.sk) throw new Error('开工归一失败：线稿仍为开启');
      console.log('INFO | 开工归一：线稿从开启临时归一到关闭（结束后还原）');
    }
    await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(c)c.click();return 1;})()`);
    await sleep(1500);

  // 球在位 + 初始身体 path 快照（v5：bbox 代替精确 d——实锤身体环起点角随
  // 重建/情绪态漂移（起点 Y 134→114，同一闭合环不同起始点），精确相等必 flaky）
  const ballSnap = `(function(){
    function bboxOf(d){var ns=d.match(/-?\\d+(?:\\.\\d+)?/g);if(!ns)return null;var xs=[],ys=[];for(var i=0;i+1<ns.length;i+=2){xs.push(+ns[i]);ys.push(+ns[i+1]);}
      var mnx=Math.min.apply(0,xs),mxx=Math.max.apply(0,xs),mny=Math.min.apply(0,ys),mxy=Math.max.apply(0,ys);
      return {w:+(mxx-mnx).toFixed(1),h:+(mxy-mny).toFixed(1)};}
    var b=document.querySelector('.wbs-fab-ball svg');if(!b)return'{}';
    var ps=b.querySelectorAll('path');var body='';for(var i=0;i<ps.length;i++){var d=ps[i].getAttribute('d')||'';if(d.length>200){body=d;break;}}
    return JSON.stringify({paths:ps.length,head:(body.slice(0,80)),bbox:bboxOf(body)});
  })()`;
  // snap0 稳定轮询：重建后身体 ring 弹簧过渡可 >3s（run4 实锤：1.2s 即采，mid-morph
  // bbox w=146 vs 稳定 228）——连续两次 bbox 一致（±2px）才定稿
  let snap0 = null;
  for (let i = 0; i < 6; i++) {
    const cand = JSON.parse(await ev(ballSnap));
    if (snap0 && snap0.bbox && cand.bbox &&
        Math.abs(cand.bbox.w - snap0.bbox.w) <= 2 && Math.abs(cand.bbox.h - snap0.bbox.h) <= 2) { snap0 = cand; break; }
    snap0 = cand;
    await sleep(1500);
  }
  check('③ 表情球 SVG 在位', snap0.paths > 0, JSON.stringify({ paths: snap0.paths, bbox: snap0.bbox }));

  // 打开面板 → 设置 tab
  await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`);
  await sleep(500);
  await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`);
  await sleep(500);
  const card = await ev(`(function(){
    var seg=document.querySelector('#fab-char-seg');var sw=document.querySelector('#sw-fab-sketch');
    if(!seg||!sw)return 'card-missing';
    return JSON.stringify({btns:seg.querySelectorAll('button').length});
  })()`);
  check('④ 设置页「挂件形象」卡在位（3 钮 + 线稿开关）', card !== 'card-missing' && JSON.parse(card).btns === 3, card);

  // ⑤ 切云宝 → 身体 path 变化 + active 对齐
  await ev(`(function(){var b=document.querySelector('#fab-char-seg [data-fab-char="nimbo"]');if(b)b.click();return 1;})()`);
  await sleep(900);
  const afterNimbo = JSON.parse(await ev(`(function(){
    var seg=document.querySelector('#fab-char-seg');var act=seg?seg.querySelector('button.active'):null;
    var b=document.querySelector('.wbs-fab-ball svg');var ps=b?b.querySelectorAll('path'):[];
    var body='';for(var i=0;i<ps.length;i++){var d=ps[i].getAttribute('d')||'';if(d.length>200){body=d;break;}}
    return JSON.stringify({active:act?act.getAttribute('data-fab-char'):'none',head:body.slice(0,80),paths:ps.length});
  })()`));
  check('⑤ 切云宝：卡片 active 对齐', afterNimbo.active === 'nimbo', JSON.stringify(afterNimbo).slice(0, 120));
  check('⑥ 切云宝：身体剪影变化（path 与球球不同）', afterNimbo.head !== snap0.head && afterNimbo.head.length > 0, 'before=' + snap0.head.slice(0, 40) + ' after=' + afterNimbo.head.slice(0, 40));

  // 球仍存活（raf 没炸、有 SVG）
  const alive = await ev(`(function(){var b=document.querySelector('.wbs-fab-ball svg');return b?'alive':'dead';})()`);
  check('⑦ 重建后球实例存活', alive === 'alive', alive);

  // ⑧ 线稿开 → is-sketch 类
  await ev(`(function(){var sw=document.querySelector('#sw-fab-sketch');if(sw)sw.click();return 1;})()`);
  await sleep(700);
  const sketchOn = await ev(`(function(){
    var b=document.querySelector('.wbs-fab-ball svg');var sw=document.querySelector('#sw-fab-sketch');
    return JSON.stringify({isSketch:b?b.classList.contains('is-sketch'):'no-svg',swOn:sw?sw.classList.contains('on'):'no-sw'});
  })()`);
  let sk = {};
  try { sk = JSON.parse(sketchOn); } catch (e) {}
  check('⑧ 线稿开：svg.is-sketch + 开关 on', sk.isSketch === true && sk.swOn === true, sketchOn);

  // ⑨ 线稿关 → 类消失
  await ev(`(function(){var sw=document.querySelector('#sw-fab-sketch');if(sw)sw.click();return 1;})()`);
  await sleep(700);
  const sketchOff = await ev(`(function(){var b=document.querySelector('.wbs-fab-ball svg');return b?b.classList.contains('is-sketch'):'no-svg';})()`);
  check('⑨ 线稿关：is-sketch 消失', sketchOff === false, String(sketchOff));

  // ⑩ 切回球球
  await ev(`(function(){var b=document.querySelector('#fab-char-seg [data-fab-char="blob"]');if(b)b.click();return 1;})()`);
  await sleep(900);
  const backBlob = JSON.parse(await ev(`(function(){
    function bboxOf(d){var ns=d.match(/-?\\d+(?:\\.\\d+)?/g);if(!ns)return null;var xs=[],ys=[];for(var i=0;i+1<ns.length;i+=2){xs.push(+ns[i]);ys.push(+ns[i+1]);}
      var mnx=Math.min.apply(0,xs),mxx=Math.max.apply(0,xs),mny=Math.min.apply(0,ys),mxy=Math.max.apply(0,ys);
      return {w:+(mxx-mnx).toFixed(1),h:+(mxy-mny).toFixed(1)};}
    var act=document.querySelector('#fab-char-seg button.active');
    var b=document.querySelector('.wbs-fab-ball svg');var ps=b?b.querySelectorAll('path'):[];
    var body='';for(var i=0;i<ps.length;i++){var d=ps[i].getAttribute('d')||'';if(d.length>200){body=d;break;}}
    return JSON.stringify({active:act?act.getAttribute('data-fab-char'):'none',head:body.slice(0,80),bbox:bboxOf(body)});
  })()`));
  // v5：剪影复原改 bbox 相似断言（±10）——身体环起点角随重建漂移，精确 d 相等
  // 撞情绪态/起始相位 flaky（实锤：snap0 起点 Y=134.58 vs 稳定态 114.27，同一闭合环）；
  // bbox 同级 + 剪影 ≠ 云宝 才是「形状恢复」的稳定不变量。
  const bb0 = snap0.bbox || {}, bb1 = backBlob.bbox || {};
  const bboxClose = bb0.w && bb1.w && Math.abs(bb0.w - bb1.w) <= 10 && Math.abs(bb0.h - bb1.h) <= 10;
  check('⑩ 切回球球：active + 剪影复原（bbox 相似±10 且 ≠ 云宝剪影）', backBlob.active === 'blob' && bboxClose && backBlob.head !== afterNimbo.head,
    JSON.stringify(backBlob).slice(0, 100) + ' | snap0.bbox=' + JSON.stringify(snap0.bbox));

  // ⑪ 持久化闭环：切 twinkle + 线稿开 → 刷新页面重注入 → 初始状态应恢复为偏好值
  await ev(`(function(){var b=document.querySelector('#fab-char-seg [data-fab-char="twinkle"]');if(b)b.click();return 1;})()`);
  await sleep(800);
  await ev(`(function(){var sw=document.querySelector('#sw-fab-sketch');if(sw)sw.click();return 1;})()`);
  await sleep(800);
  const preReload = await ev(`(function(){
    var act=document.querySelector('#fab-char-seg button.active');
    var b=document.querySelector('.wbs-fab-ball svg');
    return JSON.stringify({active:act?act.getAttribute('data-fab-char'):'none',isSketch:b?b.classList.contains('is-sketch'):'no-svg'});
  })()`);
  console.log('INFO | 刷新前状态 | ' + preReload);

  // ⑪-2 服务端写入确认（v9 九轮 P2-4）：设置页写入后、reload 前直接读 daemon ui-state
  // ——「页面状态对」≠「服务端已收」；此处不确认，刷新读回失败将无法区分「写丢失」与「重注入失败」。
  const srvState = await readServerUiState();
  const srvOk = srvState && !srvState.__err && srvState.fabCharacter === 'twinkle' && srvState.fabSketch === true;
  check('⑪-2 服务端确认写入（GET ui-state：fabCharacter=twinkle + fabSketch=true）', srvOk, JSON.stringify(srvState).slice(0, 200));

  await send('Page.enable');
  await send('Page.reload');
  await sleep(9000); // 等 daemon 重新注入 + FAB 初始化 + ui-state 异步到货

  // 开面板进设置页（buildSettingsPane 延迟构建，面板关着时 #fab-char-seg 不存在）
  await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`);
  await sleep(500);
  await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`);
  await sleep(500);

  const postReload = await ev(`(function(){
    var act=document.querySelector('#fab-char-seg button.active');
    var b=document.querySelector('.wbs-fab-ball svg');
    var sdk=(window.MoodMates&&window.MoodMates.characters)?'new':'old';
    return JSON.stringify({active:act?act.getAttribute('data-fab-char'):'none',isSketch:b?b.classList.contains('is-sketch'):'no-svg',sdk:sdk});
  })()`);
  let pr = {};
  try { pr = JSON.parse(postReload); } catch (e) {}
  check('⑪ 新 SDK 在位（刷新后 MoodMates.characters）', pr.sdk === 'new', postReload);
  check('⑫ 持久化闭环：刷新后形象恢复 twinkle', pr.active === 'twinkle', postReload);
  check('⑬ 持久化闭环：刷新后线稿仍开（is-sketch）', pr.isSketch === true, postReload);

  // ⑭ 眼神联动不回归：mousemove 后眼环 transform 变化（刷新后新实例上验证）
  // 前置：关面板让挂件显示（面板开着时 .wbs-fab-ball 隐藏，gaze 守卫按设计跳过——不是回归）。
  // 等 1.2s 让关闭动画完成（rect 恢复非 0，否则守卫把 move 全吞了——2026-09-04 实测坑）。
  await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(c)c.click();return 1;})()`);
  await sleep(1200);
  const fabPos = await ev(`(function(){var b=document.querySelector('.wbs-fab-ball');if(!b)return '{}';var r=b.getBoundingClientRect();return JSON.stringify({cx:r.left+r.width/2,cy:r.top+r.height/2,w:r.width});})()`);
  const fp = JSON.parse(fabPos);
  check('⑭-前置 球可见（rect 非 0）', (fp.w || 0) > 10, fabPos);
  // ⑮ 眼神跟随断言 v5（2026-09-05 Codex 五轮打回修正）：
  // ①采样目标 = 真实眼球：渲染层给两引擎真实眼节点挂 data-jz-eye（v1 path 眼 +
  //   MM iris 容器 g + MM bean path，transform 均由 setEye 每帧写入、含 pose.lookX
  //   真实 gaze 路径）。三轮版曾误标在 glasses 镜片装饰层——只能证明镜片跟随，
  //   不证明真实 gaze（已回滚）；四轮补 iris/v1，五轮补 bean（nimbo 缺标识则其
  //   真实 gaze 从未被验证）。
  // ②静止基线 → v7b 环分组差分：会话活跃期健康扫描器把球设为反应态情绪，眼环池
  //   0.9-5s 连续轮换（/tmp/jz-ring-cadence.js 实测 15s 内变化 19-23 次）——任何
  //   「按时间先后配对/窗口首尾指纹」都结构性不可行（v6f 真机 18/20 实锤对内轮换）。
  //   改为环指纹分组：每个采样点单次 evaluate 原子读（环 d + 双眼 translate X）；
  //   ring d 只随情绪池轮换变化（眨眼/呼吸/gaze 均走 transform 不改 d）——同环必同
  //   渲染基线。鼠标 A/B 交替扫描后按环分组，对「A/B 两侧都出现过的环」算 delta
  //   取均值——轮换只决定当前是哪个环，不破坏「同环同基线」，与轮换频率无关。
  // ③viewport 限界：所有 CDP 坐标 clamp 进 [60, innerWidth/Height-60]，实际坐标写入诊断；
  //   增益在距球心 ~112px 处饱和（gain=(dist-0.75r)/1.5r），左右窗口幅度取 200 且校验饱和距离。
  // ④三渲染路径全覆盖：blob→EB v1、nimbo→MM bean、twinkle→MM iris 各跑一轮完整
  //   眼神断言（切换经设置面板，面板关闭后采样）。
  // ⑤恢复语义（五轮 P2-1/P2-2，六轮 P2-2 加固）：fabRestore 在首次拖动前登记、「拖到安全区」一并包进
  //   try/finally——拖动/等待/CDP 读取任一步失败也还原；归位后**回读球心与原位容差比对**
  //   （只看 CDP 调用不抛错不是证据；异常路径 fp 可能陈旧，restoreFab 从 readBall 实时位置发起拖拽）；
  //   归位失败/位置偏差计入 results 非零退出，不许假绿。
  // ⑥用户偏好还原（六轮 P2-3）：开工保存用户原 fabCharacter/fabSketch，归一/切换只是临时态，
  //   覆盖全流程的 finally 恢复原值——异常跳过收尾也不丢偏好，不假设「blob+非线稿=干净默认态」。
  // ⑦基线 idle 守卫（v7b 三次真机迭代定稿）：组内极差（medIdle）只做**诊断**不进
  //   阈值——它量到的是共模慢游走（球的 idle look-around，blob/v1 实测 30s 摆幅
  //   183px），但游走分布与 A/B 侧无关，两侧中位数各自落在同一分布中位上，配对差
  //   自动抵消（run3 实锤：medIdle=183 时 deltas=[46.4,51.9] 仍紧）。判定 =
  //   shift>15 且各组 delta 全>8（方向一致）；中途误杀链：run1 读身体 path（恒
  //   1 组）→ run2 左右眼混桶（眼距 ~100 撑爆 range）→ run3 共模游走进阈值。
  // v7b：采样统一走下方 sampleOnce（原子读）——v6f 的 eyeWindow 窗口均值结构在
  // 反应态秒级轮换下已删除（窗口内跨情绪 = 均值被多基线污染，无有效指纹可用）。
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const vpG = JSON.parse(await ev('(function(){return JSON.stringify({w:window.innerWidth,h:window.innerHeight});})()'));
  // 基线：球正上/下方（同 x，dx≈0 → lookX 只剩 idle 波动），取视口内空间更足的一侧
  // 左/右窗口幅度：200（>112 饱和距离）
  const AMP = 200;
  const satL0 = Math.abs(clampN(fp.cx - AMP, 60, vpG.w - 60) - fp.cx) >= 112;
  const satR0 = Math.abs(clampN(fp.cx + AMP, 60, vpG.w - 60) - fp.cx) >= 112;
  let fabRestore = null;
  let restoreErr = null; // 五轮 P2-2：归位失败不许吞，必须进 results 非零退出
  const dragFab = async (fromX, fromY, toX, toY) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(fromX), y: Math.round(fromY), button: 'left', buttons: 1, clickCount: 1 });
    await sleep(120);
    for (let i = 1; i <= 10; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(fromX + (toX - fromX) * i / 10), y: Math.round(fromY + (toY - fromY) * i / 10), buttons: 1 });
      await sleep(40);
    }
    await sleep(200);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(toX), y: Math.round(toY), button: 'left', buttons: 0, clickCount: 1 });
  };
  const readBall = async () => JSON.parse(await ev(`(function(){var b=document.querySelector('.wbs-fab-ball');if(!b)return'{}';var r=b.getBoundingClientRect();return JSON.stringify({cx:r.left+r.width/2,cy:r.top+r.height/2,w:r.width});})()`));
  const hasBallCenter = (p) => !!p && Number.isFinite(p.cx) && Number.isFinite(p.cy);
  // 眼睛开合度（transform scale 的 sy）——睡觉等闭眼情绪 gaze:false 不响应鼠标（产品设计），
  // 闭眼态采 gaze 纯噪声（v5 实锤：blob Sleeping 态 sy≈0.08，⑮-3 时好时坏根因）
  const eyeOpenness = async () => JSON.parse(await ev(`(function(){
    var svg=document.querySelector('.wbs-fab-ball svg');
    var es=svg.querySelectorAll('[data-jz-eye]');
    if(!es.length) return '[]';
    var out=[];
    for(var j=0;j<es.length;j++){var t=es[j].getAttribute('transform')||'';
      var m=t.match(/scale\\(([-\\d.]+)\\s+([-\\d.]+)\\)/);
      out.push(m?+m[2]:1);}
    return JSON.stringify(out);
  })()`));
  const waitEyesOpen = async (label) => {
    let waited = 0;
    while (waited < 24000) {
      const op = await eyeOpenness();
      if (op.length && Math.min.apply(null, op) >= 0.3) return true;
      await sleep(2000); waited += 2000;
    }
    console.log(`INFO | ⑮ ${label} 等睁眼超时 24s（闭眼情绪未轮换）`);
    return false;
  };
  // v7b：情绪轮换免疫采样。会话活跃时健康扫描器把球设为反应态情绪，眼环池
  // 0.9-5s（实测 15s 内变化 19-23 次）——任何「按时间先后配对」的结构都不可行。
  // 改为**环指纹分组配对**：每个采样点原子读取（环 d + 双眼 translate X）；
  // 同环必同渲染基线，跨环比较无效。鼠标 A/B 位置交替扫描后，按环分组，
  // 对「A/B 两侧都出现过的环」计算 ex 差值，均值=shift——轮换只决定当前
  // 是哪个环，不破坏「同环同基线」，轮换频率无关。
  const restoreFab = async () => {
    if (!fabRestore) return;
    try {
      // v6 P2-2：从球的**实时位置**发起拖拽——异常路径 fp 可能是陈旧坐标，
      // 从旧位置发起的拖拽会静默无效；归位后必须回读球心与原位容差比对，
      // 只看「CDP 调用没抛错」不是有效证据。
      const cur = await readBall();
      if (!hasBallCenter(cur)) throw new Error('归位前球心坐标缺失，拒绝使用陈旧坐标');
      const sx = cur.cx, sy = cur.cy;
      await dragFab(sx, sy, fabRestore.x, fabRestore.y);
      await sleep(800);
      const fin = await readBall();
      const TOL = 40; // grab 点在球心，理论零偏移；40px 容差吸收拖拽动画回弹
      if (!hasBallCenter(fin) || Math.abs(fin.cx - fabRestore.x) > TOL || Math.abs(fin.cy - fabRestore.y) > TOL) {
        throw new Error('归位后球心 ' + JSON.stringify(fin) + ' 与原位 ' + JSON.stringify(fabRestore) + ' 偏差超 ' + TOL + 'px');
      }
      console.log('INFO | ⑮ 球已拖回原位（已验证 ' + Math.round(fin.cx) + ',' + Math.round(fin.cy) + '）');
    } catch (e) {
      restoreErr = e; // 归位失败必须进 results 非零退出，不许吞
      console.error(`⚠️ ⑮ 归位还原失败: ${e.message}`);
    }
  };
  // 切形象：开面板→设置→点卡→关面板（gaze 断言要求面板关闭；关后等关闭动画，
  // 否则 rect=0 被 gaze 守卫吞掉——2026-09-04 实测坑）
  const switchChar = async (ch) => {
    await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`);
    await sleep(500);
    await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`);
    await sleep(400);
    await ev(`(function(){var b=document.querySelector('#fab-char-seg [data-fab-char="${ch}"]');if(b)b.click();return 1;})()`);
    await sleep(900);
    await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(c)c.click();return 1;})()`);
    await sleep(2800); // v5：celebrate 冷却 + 眼 ring 弹簧过渡收敛（实测 v1 重建后 >2s，未收敛则 transform 漂 >100 假噪声）
  };
  // 三渲染路径全覆盖（五轮 P2-3）：twinkle=MM iris、nimbo=MM bean、blob=EB v1
  const gazeTargets = [
    { ch: 'twinkle', eng: 'MM/iris' },
    { ch: 'nimbo', eng: 'MM/bean' },
    { ch: 'blob', eng: 'EB-v1' },
  ];
  // 从潜在首次拖动开始全部包 try——finally 保证中途抛错也拖回原位
  //（五轮 P2-1：fabRestore 登记在首次拖动前，拖动/等待/CDP 读取失败也能还原）
  try {
    if (!(satL0 && satR0)) {
      // 球停靠边缘：单侧 L/R-only 模式对呼吸相位敏感（基线窗口 0.8s 采到呼吸偏侧 →
      // 基线均值漂 ±10，与 gaze 信号同量级，实测假 FAIL）。改为先把球拖到窗口安全区
      // 跑完整 LR 双向，结束后拖回原位（挂件位置本来就是用户可改状态，±10px 无害）。
      fabRestore = { x: fp.cx, y: fp.cy }; // 登记先于首次拖动
      const homeX = Math.round(vpG.w * 0.45), homeY = Math.round(Math.min(fp.cy, vpG.h * 0.55));
      await dragFab(fp.cx, fp.cy, homeX, homeY);
      await sleep(3200); // celebrate 冷却 2.5s + gaze 收敛
      const fp2 = await readBall();
      if (!hasBallCenter(fp2)) throw new Error('⑮ 归位拖拽后球心坐标缺失');
      fp.cx = fp2.cx; fp.cy = fp2.cy;
    }
    for (let gi = 0; gi < gazeTargets.length; gi++) {
      const gt = gazeTargets[gi];
      await switchChar(gt.ch);
      const eyesOpen = await waitEyesOpen(gt.ch);
      const fc = await readBall(); // 切换重建 SVG 后重读球心
      if (hasBallCenter(fc)) { fp.cx = fc.cx; fp.cy = fc.cy; }
      const upRoom = fp.cy - 60, downRoom = vpG.h - 60 - fp.cy;
      const baseY = upRoom >= downRoom ? fp.cy - Math.min(300, upRoom) : fp.cy + Math.min(300, downRoom);
      const baseX = clampN(fp.cx, 60, vpG.w - 60);
      const lx = clampN(fp.cx - AMP, 60, vpG.w - 60);
      const rx = clampN(fp.cx + AMP, 60, vpG.w - 60);
      const ly = clampN(fp.cy, 60, vpG.h - 60);
      const satL = Math.abs(lx - fp.cx) >= 112, satR = Math.abs(rx - fp.cx) >= 112;
      // v7b 环分组采样（七轮真机 18/20 → 反应态轮换 0.9-5s，v6f「对内指纹一致」
      // 在活跃期结构性不可行：15s 内 ring 变化 19-23 次，配不到对）：
      //   · sampleOnce = 单次 evaluate 原子读（**眼环节点自身 d 前 48 字符** + 双眼
      //     translate X），同帧不撕裂；首帧成功即返回（多帧只是重试，绝不跨帧混采）
      //     ⚠️ 指纹必须取眼球 path 的 d——v7b 首版误读 d.length>200 的身体 path
      //     （情绪不变量），9 轮 20s 恒 1 组、共现环永配不齐（run1 实锤 groups=1）；
      //     正确指纹来源以 /tmp/jz-ring-cadence.js 实测为准（15s 内变化 19-23 次）
      //   · ring d 只随情绪池轮换变（眨眼/呼吸/gaze 均走 transform 不改 d）
      //     → 同环必同渲染基线，跨环比较无效、同环跨时刻比较有效
      //   · 鼠标 A/B 位置交替扫描（首侧 settle 950ms 吃满平滑收敛，后续 700ms；
      //     共 18 轮 ≈ 35s，覆盖 6-40 次轮换），按环分两侧独立累计
      //   · 只对「A/B 两侧都出现过的环」算 delta 取均值
      //   · ≥2 个共现环才判定；判定 = shift>15 且各组 delta 全>8（medIdle 仅诊断，
      //     共模游走不该进阈值——run3 教训）
      //   ⚠️ 分组必须按眼分桶（v7b run2 实锤：左右眼基础偏移差 ~100px，混桶后
      //   组内 range 被眼距撑爆 → medIdle=102 误杀真信号 shift=39.9；混桶均值
      //   恰好对称抵消所以 delta 本身是对的——教训：统计量与阈值必须同口径）
      const A = (satL && satR) ? { x: lx, y: ly } : { x: baseX, y: baseY }; // LR:左窗；单侧:基线窗
      const B = satR ? { x: rx, y: ly } : { x: lx, y: ly };                 // LR/R-only:右窗；L-only:左窗
      const mode = (satL && satR) ? 'LR' : (satR ? 'R-only' : 'L-only');
      let gazePass = false, gazeDiag = '';
      if (!eyesOpen) {
        gazeDiag = '闭眼情绪（gaze:false 设计行为）超时未轮换到睁眼态——重跑即可，非产品缺陷';
      } else {
        const sampleOnce = async (x, y, settleMs) => {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), buttons: 0 });
          await sleep(settleMs); // setGaze 指数平滑 k=1-e^{-5.66·dt}，先吃收敛再采
          for (let i = 0; i < 4; i++) {
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), buttons: 0 });
            await sleep(60);
            const raw = await ev(`(function(){
              var svg=document.querySelector('.wbs-fab-ball svg');if(!svg)return'{}';
              var es=svg.querySelectorAll('[data-jz-eye]');var eyes=[];var fp='';
              for(var j=0;j<es.length;j++){
                var el=es[j];
                var p=(el.tagName==='path')?el:el.querySelector('path');
                var d=p?(p.getAttribute('d')||''):'';
                if(j===0)fp=d.slice(0,48);
                var t=el.getAttribute('transform');if(!t)continue;
                var v=parseFloat(t.slice(t.indexOf('(')+1));if(isFinite(v))eyes.push({eye:el.getAttribute('data-jz-eye'),x:v});
              }
              return JSON.stringify({ring:fp,eyes:eyes});
            })()`);
            let s2; try { s2 = JSON.parse(raw); } catch (e) { continue; }
            if (s2.eyes && s2.eyes.length) return s2;
          }
          return null;
        };
        const gA = {}, gB = {}; // ring -> { left: [x], right: [x] }（按眼分桶，见 run2 教训）
        let sawEmpty = false;
        const MAXR = 36;
        for (let k = 0; k < MAXR; k++) {
          const sa = await sampleOnce(A.x, A.y, k === 0 ? 950 : 700);
          if (sa) {
            for (const e of sa.eyes) { const g = gA[sa.ring] || (gA[sa.ring] = { left: [], right: [] }); if (g[e.eye]) g[e.eye].push(e.x); }
          } else { sawEmpty = true; }
          const sb = await sampleOnce(B.x, B.y, 700);
          if (sb) {
            for (const e of sb.eyes) { const g = gB[sb.ring] || (gB[sb.ring] = { left: [], right: [] }); if (g[e.eye]) g[e.eye].push(e.x); }
          } else { sawEmpty = true; }
        }
        const medianOf = (arr) => { const s2 = arr.slice().sort((x, y) => x - y); const m = Math.floor(s2.length / 2); return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2; };
        const rangeOf = (arr) => Math.max.apply(null, arr) - Math.min.apply(null, arr);
        const common = Object.keys(gA).filter((r) => gB[r] && gA[r].left.length >= 2 && gB[r].left.length >= 2);
        gazeDiag = `mode=${mode} rounds=${MAXR} groupsA=${Object.keys(gA).length} groupsB=${Object.keys(gB).length} common=${common.length} viewport=${vpG.w}x${vpG.h}`;
        if (sawEmpty && common.length === 0) {
          gazeDiag = '渲染层缺 [data-jz-eye] 标识（inject-emotion-ball.js 与 probe 版本不一致）| ' + gazeDiag;
        } else if (common.length >= 2) {
          const deltas = [], idles = [];
          for (const r of common) {
            const dL = medianOf(gB[r].left) - medianOf(gA[r].left);
            const dR = medianOf(gB[r].right) - medianOf(gA[r].right);
            deltas.push(mode === 'L-only' ? -(dL + dR) / 2 : (dL + dR) / 2);
            idles.push(Math.max(rangeOf(gA[r].left), rangeOf(gB[r].left), rangeOf(gA[r].right), rangeOf(gB[r].right)));
          }
          idles.sort((x, y) => x - y);
          const medIdle = idles[Math.floor(idles.length / 2)];
          const shift = deltas.reduce((p, c) => p + c, 0) / deltas.length;
          const minDelta = Math.min.apply(null, deltas);
          // 判定：shift>15（真信号实测 34-49；噪声下 shift≈0±个位数）且各组 delta 全>8
          //（方向一致）。medIdle 仅诊断——共模游走幅度不构成 A/B 差的噪声上界。
          gazePass = shift > 15 && minDelta > 8;
          gazeDiag += ` deltas=${JSON.stringify(deltas.map((d) => +d.toFixed(1)))}` +
            ` shift=${shift.toFixed(1)} rule=shift>15&&minDelta>8 ordered=${shift > 0}` +
            ` medIdle=${medIdle.toFixed(1)}(仅诊断,共模游走)`;
        } else {
          gazeDiag = `共现环不足（${common.length}/2，${MAXR} 轮扫描——反应态轮换 0.9-5s 下池内部分情绪未在两侧都露面属已知现象，重跑即可）| ` + gazeDiag;
        }
      }
      check(`⑮-${gi + 1} 眼神跟随（${gt.ch}/${gt.eng}，真实眼球 data-jz-eye，环分组共现中位差 shift>15 且各组 delta 全>8）`, gazePass, gazeDiag);
    }
  } finally {
    await restoreFab();
  }
  // 五轮 P2-2 + 六轮 P2-2：归位失败/位置偏差都必须计为失败——「断言全绿但球未归位」
  // 或「调用没抛错但球没动」都是不可信证据
  check('⑯ 归位还原成功（回读球心 vs 用户原位，容差 ±40px）', !restoreErr, restoreErr ? restoreErr.message : 'ok');

  // ⑰ 页面异常收集
  check('⑰ 全程零页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' || ').slice(0, 300));

  } finally {
    // v6 P2-3：覆盖全流程的偏好还原——正常路径还原用户原值；异常路径先还原再上抛。
    // 取代五轮版「强制 blob+关线稿」的默认干净态收尾（异常跳过收尾即丢偏好）。
    await restoreUserSkin();
  }
  // v7 P2-2：偏好还原是结果项——回读不一致/按钮缺失/无法验证都非零退出
  check('⑱ 用户偏好还原验证（回读 vs 快照，逐字段比对）', !skinRestoreErr,
    skinRestoreErr ? skinRestoreErr.message : 'ok（' + userSkin.ch + (userSkin.sk ? ' + 线稿开' : '') + '）');
  ws.close();
  console.log('\n==== 挂件形象+线稿真机验证: ' + results.filter(Boolean).length + '/' + results.length + ' PASS ====');
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => { console.error('[probe] 致命:', e.message); process.exit(1); });
