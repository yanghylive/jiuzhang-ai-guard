'use strict';
// 挂件形象「还原语义」sabotage E2E（2026-09-05 Codex 七轮 P2-3：打回不可复现的口述证据）
// 对 fab-skin-probe.js 动态生成打桩副本（原文件零接触）做两项「撤掉就红」验证：
//   SAB-C 归位位置校验：强制走边缘路径 + 归位拖到错误位置（+150px）
//     → ⑯ 必须抓住「偏差超 40px」FAIL 且进程非零退出（v6 前行为：调用不抛错即 PASS=假绿）
//   SAB-D 偏好还原：强制走边缘路径 + 首拖后致命崩溃
//     → 进程非零退出，且用户偏好必须被 finally 还原为原值（v6 前行为：异常跳过收尾=丢偏好）
// 证据：docs/evidence/fab-skin-restore-sabotage.json；任一断言不满足 exit 1。
// 跑法：node test/e2e/fab-restore-sabotage.js（需真机 CDP 9222 + daemon 注入在跑）
// v8（2026-09-05 八轮打回，2 P2 + 2 P3）：①**清场 fail-closed**——偏好恢复与球位拖回
//   全部收进统一 finally，**善后动作必须回读校验**（偏好 readSkin 逐字段比对、球心
//   ±40px 容差比对），任一失败记 cleanup.* → ok=false 非零退出、证据 cleanup 字段显式
//   标记（v7 行为：拖回不回读直接 ballRestored=true、善后异常「不影响判定」= fail-open，
//   拖回失败仍写 pass:true exit 0 的不可信证据）；②临时打桩目录登记进 tmpDirs，
//   总 finally rmSync 清理（v7 泄漏 mkdtemp 目录）；③证据 head 必须为含修复的 commit
//   （由紧随代码 commit 的 evidence commit 提供，见材料 §2）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');
const http = require('node:http');
const WebSocket = require('ws');

const REPO = path.join(__dirname, '..', '..');
const PROBE = path.join(__dirname, 'fab-skin-probe.js');
const tmpDirs = []; // v8 P3：打桩副本临时目录登记，总 finally 统一清理

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function withCDP(fn) {
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('未找到 WorkBuddy 页面 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let mid = 0; const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params) => new Promise((res) => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await new Promise((r) => ws.on('open', r));
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result && r.result.result && r.result.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try { return await fn({ ev, sleep, send }); } finally { ws.close(); }
}

const readSkinExpr = `(function(){
  var a=document.querySelector('#fab-char-seg button.active');
  var sw=document.querySelector('#sw-fab-sketch');
  return JSON.stringify({ch:a?a.getAttribute('data-fab-char'):'(none)', sk:!!(sw&&sw.classList.contains('on'))});
})()`;

async function openSettings(ev, sleep) {
  const open = await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(!c)return false;var r=c.getBoundingClientRect();return r.width>0&&r.height>0;})()`);
  if (open) { await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(c)c.click();return 1;})()`); await sleep(800); }
  await ev(`(function(){var f=document.querySelector('.wbs-fab');if(f)f.click();return 1;})()`); await sleep(500);
  await ev(`(function(){var t=document.querySelector('.wbs-tab[data-tab="settings"]');if(t)t.click();return 1;})()`); await sleep(400);
}
async function readSkin(ev, sleep) {
  await openSettings(ev, sleep);
  const s = await ev(readSkinExpr);
  await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(c)c.click();return 1;})()`); await sleep(600);
  return JSON.parse(s);
}
async function setSkin(ev, sleep, want) {
  await openSettings(ev, sleep);
  const cur = JSON.parse(await ev(readSkinExpr));
  if (cur.ch !== want.ch) {
    await ev(`(function(){var b=document.querySelector('#fab-char-seg [data-fab-char="${want.ch}"]');if(b)b.click();return 1;})()`);
    await sleep(900);
  }
  if (cur.sk !== want.sk) {
    await ev(`(function(){var sw=document.querySelector('#sw-fab-sketch');if(sw)sw.click();return 1;})()`);
    await sleep(700);
  }
  await ev(`(function(){var c=document.querySelector('.wbs-btn-close');if(c)c.click();return 1;})()`); await sleep(600);
}
async function ballCenter(ev) {
  return JSON.parse(await ev(`(function(){var b=document.querySelector('.wbs-fab-ball');if(!b)return'{}';var r=b.getBoundingClientRect();return JSON.stringify({cx:r.left+r.width/2,cy:r.top+r.height/2});})()`));
}
async function dragBall(send, sleep, from, to) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(from.cx), y: Math.round(from.cy), button: 'left', buttons: 1, clickCount: 1 });
  await sleep(120);
  for (let i = 1; i <= 10; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.cx + (to.cx - from.cx) * i / 10), y: Math.round(from.cy + (to.cy - from.cy) * i / 10), buttons: 1 });
    await sleep(40);
  }
  await sleep(200);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(to.cx), y: Math.round(to.cy), button: 'left', buttons: 0, clickCount: 1 });
  await sleep(800);
}

// 球位善后（v9 统一阈值）：偏差 >40px（唯一阈值，与 probe ⑯ 同口径——v8 的「>60 才
// 归位、40 校验」存在 41-60px 漏检：偏 50px 直接跳过归位仍写 ballRestored:true）。
// 返回 null=已归位（或无需归位），字符串=失败原因。坐标缺失（读不到球）一律失败。
const BALL_TOL = 40;
function hasBallCenter(point) {
  return !!point && Number.isFinite(point.cx) && Number.isFinite(point.cy);
}

async function runBallCleanup(withCDP, ballBefore) {
  if (!hasBallCenter(ballBefore)) return '实验前球位快照缺失（ballBefore 无完整坐标）';
  const cur = await withCDP(async ({ ev }) => ballCenter(ev));
  if (!hasBallCenter(cur)) return '回读当前球心失败（.wbs-fab-ball 不可见或坐标缺失）';
  if (Math.abs(cur.cx - ballBefore.cx) > BALL_TOL || Math.abs(cur.cy - ballBefore.cy) > BALL_TOL) {
    await withCDP(async ({ ev, sleep, send }) => { await dragBall(send, sleep, cur, ballBefore); });
  }
  const fin = await withCDP(async ({ ev }) => ballCenter(ev));
  if (!hasBallCenter(fin)) return '拖回后回读球心失败（.wbs-fab-ball 不可见或坐标缺失）';
  if (Math.abs(fin.cx - ballBefore.cx) > BALL_TOL || Math.abs(fin.cy - ballBefore.cy) > BALL_TOL) {
    return '善后回读球心 ' + JSON.stringify(fin) + ' 与原位 ' + JSON.stringify(ballBefore) + ' 偏差超 ' + BALL_TOL + 'px';
  }
  return null;
}

function makeSabotageCopy(tag, patches) {
  const src = fs.readFileSync(PROBE, 'utf8');
  let out = src;
  for (const p of patches) {
    if (!out.includes(p.anchor)) throw new Error(`SAB-${tag} 桩锚点缺失（probe 版本漂移？）: ${p.anchor.slice(0, 60)}`);
    out = out.replace(p.anchor, p.replacement);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fab-skin-sab-${tag}-`));
  tmpDirs.push(dir); // v8 P3：登记，总 finally rmSync（v7 泄漏）
  const file = path.join(dir, `fab-skin-probe-sab${tag}.js`);
  fs.writeFileSync(file, out);
  return file;
}

function runProbeCopy(file) {
  return spawnSync(process.execPath, [file], {
    cwd: REPO,
    env: { ...process.env, NODE_PATH: path.join(REPO, 'node_modules') },
    encoding: 'utf8', timeout: 600000,
  });
}

async function main() {
  // v9 反向用例（--self-test）：把球人为拖偏 41px——恰落在 v8「>60 才归位」的漏检区间
  // （41-60px），跑同一套善后逻辑后**独立回读**断言 ≤40px。善后阈值若仍是 60，
  // 本用例必红（球不会被归位，独立回读偏差 41 > 40）——「撤掉修复就红」。
  if (process.argv.includes('--self-test')) {
    const ballBefore = await withCDP(async ({ ev }) => ballCenter(ev));
    if (!hasBallCenter(ballBefore)) { console.error('FAIL | 球不可见或坐标不完整，无法做漂移自测'); process.exit(1); }
    await withCDP(async ({ ev, sleep, send }) => {
      await dragBall(send, sleep, ballBefore, { cx: ballBefore.cx + 41, cy: ballBefore.cy });
    });
    const mid = await withCDP(async ({ ev }) => ballCenter(ev));
    console.log('INFO | 已人为拖偏 ' + (hasBallCenter(mid) ? Math.abs(mid.cx - ballBefore.cx).toFixed(1) : '?') + 'px（落在 v8 漏检区间 41-60）');
    const err = await runBallCleanup(withCDP, ballBefore);
    const fin = await withCDP(async ({ ev }) => ballCenter(ev));
    const okDrift = hasBallCenter(fin) && Math.abs(fin.cx - ballBefore.cx) <= BALL_TOL && Math.abs(fin.cy - ballBefore.cy) <= BALL_TOL;
    console.log((!err && okDrift ? 'PASS' : 'FAIL') + ' | 41px 漂移反向用例（善后阈值统一 40px，撤掉即红）' +
      (err ? ' | cleanup: ' + err : ' | fin=' + JSON.stringify(fin)));
    process.exit(!err && okDrift ? 0 : 1);
  }
  const t0 = Date.now();
  const head = execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim();
  const results = {};
  // v8 fail-closed：善后状态统一记录，null=成功、字符串=失败——任一非 null → ok=false
  const cleanup = { pref: null, ball: null, tmp: null };
  let ok = true;
  let orig = null, ballBefore = null;
  try {
    ballBefore = await withCDP(async ({ ev }) => ballCenter(ev)); // 实验前球位（善后拖回 + 回读比对基准）
    orig = await withCDP(async ({ ev, sleep }) => readSkin(ev, sleep)); // 实验前偏好（善后恢复 + 回读比对基准）

    // ---- SAB-C：归位位置校验 ----
    {
      const file = makeSabotageCopy('C', [
        { anchor: '    if (!(satL0 && satR0)) {', replacement: '    if (true) { // SABOTAGE-C: 强制边缘路径' },
        { anchor: '      await dragFab(sx, sy, fabRestore.x, fabRestore.y);', replacement: '      await dragFab(sx, sy, fabRestore.x + 150, fabRestore.y); // SABOTAGE-C: 拖到错误位置' },
      ]);
      const r = runProbeCopy(file);
      const pass = r.status === 1 && /FAIL \| ⑯/.test(r.stdout) && /偏差超 40px/.test(r.stdout);
      results.SAB_C = { status: r.status, pass, expect: 'exit=1 且 ⑯ FAIL 且诊断含「偏差超 40px」', stdoutTail: (r.stdout || '').split('\n').filter((l) => /⑯|====/.test(l)).slice(-3) };
      if (!pass) ok = false;
    }

    // ---- SAB-D：偏好还原（异常路径）----
    {
      await withCDP(async ({ ev, sleep }) => setSkin(ev, sleep, { ch: 'nimbo', sk: false })); // 造非 blob 偏好（orig 已快照，善后统一恢复）
      const file = makeSabotageCopy('D', [
        { anchor: '    if (!(satL0 && satR0)) {', replacement: '    if (true) { // SABOTAGE-D: 强制边缘路径' },
        { anchor: '      await dragFab(fp.cx, fp.cy, homeX, homeY);\n      await sleep(3200); // celebrate 冷却 2.5s + gaze 收敛', replacement: "      await dragFab(fp.cx, fp.cy, homeX, homeY);\n      throw new Error('SABOTAGE-D: 首拖后流程崩溃'); // 拖完立即崩\n      await sleep(3200); // celebrate 冷却 2.5s + gaze 收敛" },
      ]);
      const r = runProbeCopy(file);
      const post = await withCDP(async ({ ev, sleep }) => readSkin(ev, sleep)); // 崩溃后偏好状态
      const pass = r.status === 1 && post.ch === 'nimbo' && post.sk === false;
      results.SAB_D = { status: r.status, pass, expect: 'exit=1 且崩溃后偏好还原 nimbo/线稿关（旧版异常跳过收尾会丢偏好）', post, stdoutTail: (r.stdout || '').split('\n').filter((l) => /用户偏好|致命|====/.test(l)).slice(-4) };
      if (!pass) ok = false;
    }
  } finally {
    // ===== 统一善后（v8 fail-closed：全部回读校验，任一失败 → ok=false 非零退出）=====
    // 善后 1：恢复实验前偏好 + 回读逐字段比对（「点击没抛错」不是证据）
    try {
      const want = { ch: orig && orig.ch !== '(none)' ? orig.ch : 'blob', sk: orig ? orig.sk : false };
      const cur = await withCDP(async ({ ev, sleep }) => readSkin(ev, sleep));
      if (cur.ch !== want.ch || cur.sk !== want.sk) {
        await withCDP(async ({ ev, sleep }) => setSkin(ev, sleep, want));
        const fin = await withCDP(async ({ ev, sleep }) => readSkin(ev, sleep));
        if (fin.ch !== want.ch || fin.sk !== want.sk) {
          throw new Error('恢复后回读不一致：' + JSON.stringify(fin) + ' vs 快照 ' + JSON.stringify(want));
        }
      }
    } catch (e) { cleanup.pref = e.message; console.error('⚠️ 偏好善后失败: ' + e.message); }

    // 善后 2：球位拖回实验前位置 + 回读（v9 统一 40px 唯一阈值 + 坐标缺失必失败，
    // 见 runBallCleanup；v7 直接写 ballRestored=true 不回读 = fail-open）
    try {
      const err = await runBallCleanup(withCDP, ballBefore);
      if (err) throw new Error(err);
    } catch (e) { cleanup.ball = e.message; console.error('⚠️ 球位善后失败: ' + e.message); }

    // 善后 3：临时打桩目录清理（v8 P3：v7 泄漏 mkdtemp 目录）
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { cleanup.tmp = (cleanup.tmp ? cleanup.tmp + '; ' : '') + d + ': ' + e.message; }
    }
  }
  if (cleanup.pref || cleanup.ball || cleanup.tmp) ok = false; // 善后失败不许 pass:true（fail-closed）

  const evidence = {
    kind: 'fab-skin-restore-sabotage',
    head,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    pass: ok,
    cleanup: {
      prefRestored: !cleanup.pref,
      ballRestored: !cleanup.ball,
      tmpCleaned: !cleanup.tmp,
      prefErr: cleanup.pref,
      ballErr: cleanup.ball,
      tmpErr: cleanup.tmp,
    },
    results,
  };
  const evDir = path.join(REPO, 'docs', 'evidence');
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'fab-skin-restore-sabotage.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('\n==== 还原语义 sabotage: ' + (ok ? 'ALL-PASS' : 'FAIL') + ' ====');
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error('[sabotage] 致命:', e.message); process.exit(1); });
}

module.exports = { BALL_TOL, hasBallCenter, runBallCleanup };
