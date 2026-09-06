'use strict';
// 反向验证（sabotage）：证明竞态 E2E 的断言不是空转。
//
// 原理：临时把某个所有权守卫改成恒真（模拟「修复被删掉」），重跑 E2E，
//       目标场景必须 FAIL；还原后再跑一遍，必须全 PASS。
//       只绿不红的竞态断言等于没有断言——A0 连续四轮都在补这类洞，这个脚本就是防倒退的闸门。
//
// 运行：node test/e2e/cdp-pay-sync-sabotage.js
//       JZ_SABOTAGE=all              默认：依次验证全部守卫（当前 4 个），写聚合证据
//       JZ_SABOTAGE=<目标名>         只验证单个守卫，可选值见下方 TARGETS
//                                    （A0 八轮：单目标 / JZ_PHASE2=0 的结果写 *.partial.json，不覆盖权威证据）
//       JZ_PHASE2=0                  跳过「还原后全场景复跑」，只做阶段1
//       JZ_KEEP_SABOTAGE=1           故意不还原，便于人工观察现场（危险，仅供排查）
//       JZ_SIMULATE_FAILURE=1        打桩后立刻抛错，用于验证异常路径确实会还原（自检用）
//       JZ_SIMULATE_BACKUP_LOSS=1    打桩后删掉固定备份，验证「备份丢失」会硬失败而不是照写假证据
//                                    （跑完源码会留破坏桩且无备份，需 git checkout -- scripts/inject.js）
//
// 安全约束（任一不满足即拒绝运行）：
//   1. scripts/inject.js 必须工作区干净（有未提交改动时拒绝，防覆盖你的 WIP）；
//   2. 启动时自检 inject.js 是否残留上一次的破坏桩，有则自动从固定备份还原；
//   3. CDP 9222 与当前 47832 daemon 必须可用，且该 daemon 是项目目录的 dev 实例；
//   4. 任何退出路径（正常 / 异常 / SIGINT / SIGTERM / SIGHUP）都会还原 inject.js。
//
// ⚠️ 清理纪律（A0 五轮 P2-1）：fail() 必须 throw，绝不能 process.exit()——
//    exit 会绕过 try/finally，把 `return true` 破坏桩永久留在 scripts/inject.js 里。
//    需要退出码的地方统一在 main().catch 里收口。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
// A0 九轮 P2：父进程清场用 ws 包（与 lifecycle 同源）。不用全局 WebSocket——
// 它是 EventTarget 实现（只有 addEventListener，没有 .on()），且行为随 node 版本漂移。
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..', '..');
const INJECT = path.join(ROOT, 'scripts', 'inject.js');
const E2E = path.join(__dirname, 'cdp-pay-sync-lifecycle.js');
const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'JiuZhangAI');
const LOCK = path.join(DATA_DIR, '.daemon.lock');
const OUT = path.join(ROOT, 'docs', 'evidence');
const EVIDENCE = path.join(OUT, 'pay-sync-sabotage.json');
// A0 八轮 P2-1：权威证据只由「全目标 + 阶段2 all-pass」的完整闸门运行产生。
// 单目标 / JZ_PHASE2=0 / 失败运行一律写 partial 文件——同样可复核，但绝不覆盖权威结论。
// 之前的洞：`JZ_SABOTAGE=payPurchase JZ_PHASE2=0` 这样的合法命令会把 4 目标全量证据
// 覆盖成「单目标 + phase2:skipped」，权威文件却被降级了，且从内容上不易察觉。
const EVIDENCE_PARTIAL = path.join(OUT, 'pay-sync-sabotage.partial.json');
// 固定路径备份（A0 五轮 P2-1）：原来用 pid 命名，进程被 SIGKILL 后备份名就找不回来了，
// 破坏桩会永久留在源码里。固定路径 + 启动自检才能兜住。
//
// A0 七轮 P2-6：从全局 /tmp 移到项目内 .tmp-probe/（已 gitignore），并加独占锁 + 0600。
// 三条真实风险：
//   ① /tmp 是全局可写目录，别的进程/用户可以预置同名文件（占位或符号链接），
//      备份被写歪、或还原出一个别人塞进来的 inject.js，我们却毫不知情；
//   ② macOS 会定期清理 /tmp 下 3 天未访问的文件，备份会凭空消失
//      （六轮的 JZ_SIMULATE_BACKUP_LOSS 已复现其后果：源码留桩且无法自愈）；
//   ③ 两个 sabotage 并发跑会互相覆盖备份，还原时把对方的破坏桩写回源码。
// 项目内 .tmp-probe/ 归本工程所有、不受系统清理，配合独占锁堵住并发。
const TMP_DIR = path.join(ROOT, '.tmp-probe');
const BACKUP = path.join(TMP_DIR, 'jz-inject.sabotage.backup.js');
// 锁文件路径的唯一真源在 test/e2e/lib/sabotage-lock.js（LOCKFILE），此处不再重复定义
const SABOTAGE_MARK = 'SABOTAGE by cdp-pay-sync-sabotage';

// 破坏目标 → 预期会 FAIL 的场景号。
// 三种形态：
//   fn                —— 把守卫函数体替换成 `return true`（所有权/守卫类修复，如 payPollAlive）
//   fn + revertTo     —— 把函数体替换成指定的「修复前」实现，精确复现旧 bug
//   line              —— 注释掉某一行（清理/赋值类修复，没有守卫函数可换成恒真）
const TARGETS = {
  payPurchase: { fn: 'payPurchaseAlive', scene: 3, note: '建单层（A 建单迟到会覆盖 B 支付区）' },
  payPoll: { fn: 'payPollAlive', scene: 2, note: '查单层（A 查单迟到会启动 B 的同步链）' },
  paySync: { fn: 'paySyncAlive', scene: 7, note: '同步链（旧链的 refresh 在飞回调会续期并串扰新单）' },
  payPollChain: {
    fn: 'schedulePayPoll',
    // ⚠️ 必须精确复现「修复前」的写法，不能用 `return true` 简单禁用。
    // 七轮第一次我把目标选成「回调里清零句柄」那一行，结果场景 8 照样 PASS（total=3）——
    // 因为 schedulePayPoll() 里的 clearTimeout + 无条件重排已经解决了续期，
    // 清零只是防御性的。真正的病根是下面这个「守卫式排程」：
    //   回调执行时句柄没清零 → 再次走到 `if (!payPollTimer)` 条件恒为假 → 排不出下一次。
    // 只禁用函数（return true）也不对：那会变成「一次都不排」(total=1)，
    // 红是红了，但验证的不是「第二次之后停摆」这个真实故障模式。
    revertTo: [
      'if (!payPollTimer) payPollTimer = setTimeout(function () { payPollOnce(false); }, 3000);',
    ],
    scene: 8,
    note: '查单链续期（修复前是守卫式排程，第二次之后排不出 timer）',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// A0 五轮 P2-1：throw 而非 process.exit —— exit 会跳过 try/finally 的还原逻辑
function fail(msg) { throw new Error(msg); }

// ---- 破坏态追踪 + 信号清理（唯一真源，finally 与信号处理器共用）----
let sabotaged = false;
// A0 六轮 P2-2：还原失败必须被硬记住，任何阶段都不许在「源码仍带破坏桩」的前提下继续生成证据
let restoreFailed = false;

// 返回值语义：true = 安全（无需还原 / 已还原干净 / 按要求保留破坏态）；false = 需要还原但没还原成。
// ⚠️ 调用方必须检查返回值——A0 六轮 P2-2 就是这里只 log 不阻断，导致备份丢失时脚本照跑、
//    还写下一份「all-pass」的假证据，而源码其实还留着 return true 破坏桩。
function restoreInject(reason) {
  if (!sabotaged) return true;
  if (process.env.JZ_KEEP_SABOTAGE) {
    log(`\n⚠️  [${reason}] JZ_KEEP_SABOTAGE=1，按要求保留破坏态：${INJECT}`);
    return true; // 保留是预期行为，不算失败
  }
  if (!fs.existsSync(BACKUP)) {
    log(`\n❌ [${reason}] 还原失败：固定备份不存在 ${BACKUP}`);
    log(`   ${INJECT} 很可能仍带 ${SABOTAGE_MARK} 破坏桩，必须手动修复；本次运行的任何证据一律不可信。`);
    restoreFailed = true;
    return false;
  }
  fs.copyFileSync(BACKUP, INJECT);
  if (fs.readFileSync(INJECT, 'utf8').includes(SABOTAGE_MARK)) {
    log(`\n❌ [${reason}] 还原失败：写回备份后仍检出 ${SABOTAGE_MARK} 标记，必须手动修复 ${INJECT}`);
    restoreFailed = true;
    return false;
  }
  log(`\n[${reason}] 已还原 inject.js（SABOTAGE 残留=false）`);
  sabotaged = false;
  return true;
}
// ---- A0 十一轮 P1：信号退出必须异步收口，绝不绕过父进程清场 ----
// 旧实现：信号 → 还原源码 → 放锁 → 立即 process.exit。若 E2E 正在运行，
// 终端中断（Ctrl+C）会连带终止子进程并跳过其 finally → 页面 window.fetch stub 残留，
// 污染后续验证与手工支付调试。新流程：标记 shutdown → SIGKILL 并等待当前 E2E 子进程
// 退出 → 父进程带 deadline 清场并验证 → 再还原源码 / 释放锁 / 退出；
// 清场失败 = 非零退出 + 「刷新页面」指引。
let shuttingDown = false;
let currentE2EChild = null;   // runE2E 里登记当前子进程，供信号路径定向终止
let e2eEverStarted = false;   // 只要跑过 E2E，信号退出前一律做一次页面清场（防异常死亡残留）
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (shuttingDown) return; // 重复信号忽略（异步收口期间再按 Ctrl+C 不改变流程）
    shuttingDown = true;
    (async () => {
      const child = currentE2EChild;
      if (child && child.exitCode === null && !child.killed) {
        log(`\n[signal:${sig}] E2E 子进程在飞，SIGKILL 并等待退出后清场…`);
        try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
        await new Promise((r) => { child.once('close', r); setTimeout(r, 5000); });
      }
      // 页面清场（带 20s deadline）：只要本轮跑过 E2E 就执行——子进程可能异常死亡
      // 而没走到自己的 finally，不能赌页面是干净的。
      let c = { ok: true, detail: 'skipped（本轮未运行 E2E，页面无 stub 可言）' };
      if (e2eEverStarted) {
        c = await Promise.race([
          forceCleanupPageStub(),
          new Promise((r) => setTimeout(() => r({ ok: false, detail: '清场整体超时（20s deadline）' }), 20000)),
        ]);
        log(`\n[STUB-CLEANUP] ${c.ok ? 'OK' : 'FAILED'}：${c.detail}`);
      }
      restoreInject(`signal:${sig}`);
      releaseLock();
      if (!c.ok) {
        console.error(`\n❌ 信号退出时页面清场失败：WorkBuddy 页面可能残留 fetch stub（环境污染）。` +
            `请刷新 WorkBuddy 页面（Cmd+R）后重跑。`);
      }
      process.exit(restoreFailed || !c.ok ? 1 : 130);
    })().catch((e) => {
      console.error(`[signal:${sig}] 收口异常：${e.message}`);
      try { restoreInject(`signal:${sig}:fallback`); } catch (_) {}
      try { releaseLock(); } catch (_) {}
      process.exit(1);
    });
  });
}
// 兜底：任何逃逸到进程退出的路径都再确认一次（process.exit / 未捕获异常）。
// exit 钩子里不能抛异常，只能尽力而为 + 大声喊。
process.on('exit', () => {
  try {
    if (!sabotaged || process.env.JZ_KEEP_SABOTAGE) return;
    if (!fs.existsSync(BACKUP)) {
      console.error(`\n❌ [exit] 无法紧急还原：固定备份不存在 ${BACKUP}`);
      console.error(`   ${INJECT} 仍带破坏桩，请手动修复（或用 git 还原该文件）`);
      return;
    }
    fs.copyFileSync(BACKUP, INJECT);
    if (fs.readFileSync(INJECT, 'utf8').includes(SABOTAGE_MARK)) {
      console.error(`\n❌ [exit] 紧急还原后仍检出破坏桩，请手动修复 ${INJECT}`);
    } else {
      console.error(`\n[exit] 紧急还原 inject.js（破坏态未在正常路径清理）`);
    }
  } catch (_) { /* 尽力而为 */ } finally {
    releaseLock(); // 锁必须无条件释放，否则后续运行会被陈旧锁永久挡住
  }
});

// ---- 并发锁（A0 七轮 P2-6 起；九轮抽成独立模块并修复双持有交错）----
// 实现、演进记录与如实交底见 test/e2e/lib/sabotage-lock.js 头注释。
// 九轮抽模块的原因：行为级竞态测试（test/test-sabotage-lock-race.js）必须用**真实锁代码**
// 复现「两进程同时读到陈旧锁」的交错时序——源码正则断言覆盖不了时序。
// 九轮 P1 要点：接管陈旧锁前**二次读取比对**（内容变了绝不 unlink，回到循环重新评估），
// 且每次动 inject.js 前先 ensureLockOurs() 检查点，锁被抢走就大声终止，不再静默双写。
const lock = require('./lib/sabotage-lock.js');
const acquireLock = () => lock.acquireLock({ fail });
const ensureLockOurs = () => lock.ensureLockOurs({ fail });
const releaseLock = () => lock.releaseLock();

function getJson(port, p, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

function daemonPid() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid; } catch (_) { return 0; }
}

function currentDaemonCmd() {
  const pid = daemonPid();
  if (!pid) return '';
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch (_) { return ''; }
}

function startDaemon() {
  const out = fs.openSync('/tmp/jz-daemon-sabotage.log', 'a');
  const child = spawn(process.execPath, ['scripts/daemon.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      WBSWITCH_DATA_DIR: DATA_DIR,
      WBSWITCH_PORT: '47832',
      WBSWITCH_PROFILE: 'workbuddy-cn',
      WBSWITCH_TRIAL_HOURS: '0', // 过期/锁定态，会员页与支付区才可见
    },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
}

async function waitHealthy(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await getJson(47832, '/api/health', 2000);
      return true;
    } catch (_) { await sleep(500); }
  }
  return false;
}

async function restartDaemon(label) {
  const pid = daemonPid();
  log(`\n[${label}] 重启 dev daemon（旧 pid=${pid || 'none'}）以重新注入面板…`);
  if (pid) { try { process.kill(pid); } catch (_) { /* 已退出 */ } }
  await sleep(3000);
  startDaemon();
  if (!await waitHealthy()) fail('daemon 未在 30s 内恢复监听 47832');
  await sleep(8000); // 等注入完成 + 会员页套餐卡渲染（面板是否真的可用由 E2E 自己的守卫判定）
  log(`[${label}] daemon 已就绪（pid=${daemonPid()}）`);
}

// 全量 8 场景约 3 分钟、单场景约 1 分钟，7 分钟是宽裕上限。
// A0 八轮 P2-3：原来只监听 close，E2E 子进程或其 CDP send() 若永不响应，
// 父进程会一直停在 await——源码可能保持破坏态，只能靠人工 SIGINT 救。
// 加整体超时：到点 SIGKILL 子进程并按非零退出返回，让 finally 的还原逻辑照常走。
// A0 九轮 P2：SIGKILL 会连子进程 finally 里的 stub 清理一起跳过——页面残留 window.fetch
// stub 会污染下一轮测试或手工支付调试。所以超时后**父进程必须用独立 CDP 连接清场并验证**，
// 清不掉就标记环境污染并硬失败（只重启 daemon 不够：重新注入不重置页面 JS）。
// JZ_E2E_TIMEOUT_MS 仅用于行为级测试超时路径（如 =5000 强制触发），生产勿设。
const E2E_TIMEOUT_MS = Number(process.env.JZ_E2E_TIMEOUT_MS) || 7 * 60 * 1000;

// 父进程独立清场（A0 九轮 P2）：连上 E2E 用的同一个页面 target，撤 stub + 释放挂起请求 + 验证。
// 与 lifecycle 的 removeStub 表达式保持同源语义：恢复 window.fetch = __e2eBase 并删标记。
// A0 十轮 P2：清场自身绝不许挂死——建连有 deadline、连接中断会拒绝所有 pending、
// finally 无条件释放 WebSocket。最坏情况下本函数仍会在 ~20s 内返回结果。
async function forceCleanupPageStub() {
  const detail = [];
  let ws = null;
  try {
    const list = JSON.parse(await getJson(9222, '/json/list', 5000));
    const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    if (!page) return { ok: false, detail: '未找到 WorkBuddy 页面 target（CDP 9222）' };
    ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    let mid = 0;
    const pending = new Map(); // id -> { res, rej }
    const dropAll = (why) => {
      for (const { rej } of pending.values()) rej(new Error(`CDP 连接中断：${why}`));
      pending.clear();
    };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { res } = pending.get(m.id);
        pending.delete(m.id);
        res(m);
      }
    });
    ws.on('close', () => dropAll('socket closed'));
    ws.on('error', () => dropAll('socket error'));
    // A0 十轮 P2：建连必须有 deadline（CDP 半开/target 消失时 open 永不来）
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP 建连超时（5s）——半开连接或 target 已消失')), 5000);
      ws.once('open', () => { clearTimeout(t); res(); });
      ws.once('error', (e) => { clearTimeout(t); rej(e); });
      ws.once('close', () => { clearTimeout(t); rej(new Error('CDP 连接在建连阶段被关闭')); });
    });
    const send = (method, params) => new Promise((res, rej) => {
      const id = ++mid;
      const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP 超时：${method}`)); }, 15000);
      pending.set(id, { res: (m) => { clearTimeout(t); res(m); }, rej: (e) => { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const cleanResult = await ev(`(function(){
      var r = { removed: 'none' };
      // 挂起中的请求一并释放，避免页面里留永久 pending 的 promise
      if (window.__e2eRefreshResolve) { var a=window.__e2eRefreshResolve; window.__e2eRefreshResolve=null; window.__e2eHoldRefresh=false; try{a(new Response('{}',{status:200}))}catch(_){ } r.releasedRefresh=true; }
      if (window.__e2eHoldResolve)  { var b=window.__e2eHoldResolve;  window.__e2eHoldResolve=null;  window.__e2eHoldNext=false;   try{b(new Response('{}',{status:200}))}catch(_){ } r.releasedQuery=true; }
      if (window.__e2ePurchaseResolve){ var c=window.__e2ePurchaseResolve; window.__e2ePurchaseResolve=null; window.__e2eHoldPurchase=false; try{c(new Response('{}',{status:200}))}catch(_){ } r.releasedPurchase=true; }
      if (window.__e2eBase) { window.fetch = window.__e2eBase; delete window.__e2eBase; r.removed = 'removed'; }
      r.clean = !window.__e2eBase;
      return r;
    })()`);
    detail.push(`stub=${cleanResult && cleanResult.removed}, clean=${cleanResult && cleanResult.clean}`);
    if (!cleanResult || cleanResult.clean !== true) {
      return { ok: false, detail: detail.join('; ') + '（__e2eBase 仍在，页面未清理干净）' };
    }
    return { ok: true, detail: detail.join('; ') };
  } catch (e) {
    return { ok: false, detail: `清场异常：${e.message}` };
  } finally {
    // A0 十轮 P2：无论成败都释放 WebSocket，不留半开连接
    if (ws) { try { ws.close(); } catch (_) {} try { ws.terminate(); } catch (_) {} }
  }
}

function runE2E(scenes) {
  const env = { ...process.env };
  if (scenes) env.JZ_E2E_ONLY = String(scenes);
  else delete env.JZ_E2E_ONLY;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [E2E], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    currentE2EChild = p;      // A0 十一轮 P1：登记子进程，信号路径定向终止
    e2eEverStarted = true;
    let out = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (currentE2EChild === p) currentE2EChild = null;
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      resolve(r);
    };
    let timedOut = false;       // A0 十轮 P1：超时后 close 不许直接结算
    let exited = false;         // 子进程是否已退出（SIGKILL 时 close 的 code 为 null，不能拿 code 判断！）
    let exitCode = null;
    let cleanupSettled = null;  // 清场结果 { ok, detail }
    const maybeFinish = () => {
      // 超时路径必须等齐「子进程已退出 + 清场已出结果」才结算——
      // 十轮 P1：close 先到时若直接 finish，随后清场失败的 polluted 会被 settled 分支丢弃，
      // 环境污染硬失败分支就永远不会走到。
      if (!exited || cleanupSettled === null) return;
      const note = `\n[STUB-CLEANUP] ${cleanupSettled.ok ? 'OK' : 'FAILED'}：${cleanupSettled.detail}\n`;
      out += note;
      process.stdout.write(note);
      finish({ ok: false, out, polluted: !cleanupSettled.ok });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const t0 = `\n[E2E-TIMEOUT] ${E2E_TIMEOUT_MS}ms 未结束，已 SIGKILL 子进程（本轮无效，不是断言结果）\n`;
      out += t0;
      process.stdout.write(t0); // 标记同步可见，不能只藏在 judge 的 out 里
      try { p.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
      // A0 九轮 P2：SIGKILL 跳过了子进程 finally 的 stub 清理，父进程必须独立清场并验证。
      // 清不掉 → polluted=true，调用方硬失败终止（标记环境污染），绝不带着脏页面继续。
      // A0 十轮 P2：外层 20s deadline 兜底——清场内部任何一层挂死也不能拖死整个 runE2E。
      const cleanupWithDeadline = Promise.race([
        forceCleanupPageStub(),
        new Promise((r) => setTimeout(() => r({ ok: false, detail: '清场整体超时（20s deadline）' }), 20000)),
      ]);
      cleanupWithDeadline
        .then((c) => { cleanupSettled = { ok: !!c.ok, detail: c.detail }; maybeFinish(); })
        .catch((e) => { cleanupSettled = { ok: false, detail: e.message }; maybeFinish(); });
    }, E2E_TIMEOUT_MS);
    // 十轮 P1 兜底：清场理论上必在 ~20s 内出结果，这里再加一道 30s 硬闸
    const deadlineTimer = setTimeout(() => {
      if (cleanupSettled === null) {
        cleanupSettled = { ok: false, detail: '清场 30s 未出结果（内部 deadline 失效，按失败处理）' };
        maybeFinish();
      }
    }, E2E_TIMEOUT_MS + 30000);
    const tee = (d, stream) => { const s = d.toString(); out += s; stream.write(s); };
    p.stdout.on('data', (d) => tee(d, process.stdout));
    p.stderr.on('data', (d) => tee(d, process.stderr));
    // A0 十轮 P1：超时后 close 不得直接结算——统一走 maybeFinish 等清场结果
    p.on('close', (code) => {
      exited = true; // ⚠️ SIGKILL 时 code 为 null，绝不能用 code 判断是否已退出（十轮实测踩坑）
      exitCode = code;
      if (!timedOut) finish({ ok: code === 0, out });
      else maybeFinish();
    });
    p.on('error', (e) => { out += `\n[E2E-SPAWN-ERROR] ${e.message}\n`; exited = true; finish({ ok: false, out }); });
  });
}

// ⚠️ 只看退出码会被严重误导：E2E 脚本自身崩溃（参数非法、前置守卫报错、CDP 断连）
// 同样是非零退出，会被误判成「守卫失效导致场景 FAIL」＝闸门假阳性。
// 五轮就踩了这个坑：新增场景 7 时漏改 JZ_E2E_ONLY 的上界，E2E 直接崩，
// sabotage 却报「paySyncAlive 失效后场景 7 确实 FAIL」。
// A0 七轮 P1-2：只匹配 `FAIL — <scene>` 还不够——场景的前置/构造失败（如场景7 挂不起 refresh）
// 原本也输出 `FAIL — 7 … 本场景无效（不是产品缺陷）`，会被记成 caught，
// 等于「压根没跑到断言也算守卫生效」，据此写下的证据是假阳性。
// 现在 E2E 输出三态前缀，judge 据此分辨：
//   ok                   → ineffective（断言空转）
//   `FAIL — <scene> `    → caught（断言真的判定产品行为有问题）
//   `INVALID — <scene> ` → invalid（本轮无效：前置不足/竞态没构造起来，不是产品缺陷）
//   其余非零退出         → error（脚本崩溃等，本轮无效，绝不记为 caught）
function judge(r, scene) {
  if (r.ok) return 'ineffective';
  const line = (r.out || '').split('\n').find((l) => new RegExp(`(FAIL|INVALID) — ${scene} `).test(l));
  if (!line) return 'error';
  return line.startsWith('INVALID —') ? 'invalid' : 'caught';
}

// 启动时自检：上一次运行若被强杀，破坏桩可能还留在源码里（A0 五轮 P2-1）。
//
// 判定「除破坏桩外是否还有别的改动」不能靠字符串比对——破坏桩是**替换函数体**
// （删掉原 `return gen === ...` 再插入 `return true; // MARK`），剥掉标记行拼不回原文。
// 正确做法：先还原到备份，用 git 当权威判据判定是否干净；不干净就把现场写回去，绝不丢用户改动。
function selfCheckLeftover() {
  const src = fs.readFileSync(INJECT, 'utf8');
  if (!src.includes(SABOTAGE_MARK)) return;
  log(`\n⚠️  检出残留破坏桩：${INJECT}`);
  if (process.env.JZ_KEEP_SABOTAGE) { log('   JZ_KEEP_SABOTAGE=1，按要求保留'); return; }
  if (!fs.existsSync(BACKUP)) {
    fail(`残留破坏桩且固定备份丢失（${BACKUP}）—— 请手动把对应守卫函数体改回原样后再跑`);
  }
  fs.copyFileSync(BACKUP, INJECT);
  const clean = spawnSync('git', ['diff', '--quiet', 'scripts/inject.js'], { cwd: ROOT }).status === 0;
  if (!clean) {
    fs.writeFileSync(INJECT, src); // 回滚现场：不能拿旧备份盖掉用户的新改动
    fail(`inject.js 除了残留破坏桩之外还有别的改动——自动还原会把这些改动一起回滚，故拒绝。\n` +
         `   请手动处理：git diff scripts/inject.js，固定备份在 ${BACKUP}`);
  }
  log(`   已从固定备份自动还原（git 判定已干净）：${BACKUP}`);
}

function assertMarked() {
  if (!fs.readFileSync(INJECT, 'utf8').includes(SABOTAGE_MARK)) {
    fail('打桩失败：未写入 SABOTAGE 标记');
  }
  sabotaged = true;
}

// 形态一：替换守卫函数体。
//   不给 revertTo → 换成 `return true`（守卫永远放行）
//   给了 revertTo → 换成指定的「修复前」实现，精确复现旧故障模式
function sabotageFn(fnName, revertTo) {
  const src = fs.readFileSync(INJECT, 'utf8');
  const marker = `function ${fnName}(`;
  const i = src.indexOf(marker);
  if (i === -1) fail(`inject.js 中找不到守卫函数 ${fnName}`);
  const bodyStart = src.indexOf('{', i);
  const bodyEnd = src.indexOf('\n    }', bodyStart);
  if (bodyStart === -1 || bodyEnd === -1) fail(`无法定位 ${fnName} 的函数体`);
  const injected = revertTo && revertTo.length
    ? '\n      ' + revertTo.join('\n      ') + ` // ${SABOTAGE_MARK}.js`
    : `\n      return true; // ${SABOTAGE_MARK}.js（验证后自动还原）`;
  fs.writeFileSync(INJECT, src.slice(0, bodyStart + 1) + injected + src.slice(bodyEnd));
  assertMarked();
}

// 形态二（A0 七轮）：注释掉某一行。
// 有些修复不是「守卫函数」而是「一行关键的清理/赋值」（如回调里把 timer 句柄清零），
// 没有函数体可换成恒真，只能整行抹掉。必须整行精确匹配，避免误伤同名语句。
function sabotageLine(line) {
  const src = fs.readFileSync(INJECT, 'utf8');
  const hits = src.split(line).length - 1;
  if (hits !== 1) fail(`inject.js 中待破坏的行必须唯一命中 1 次，实际 ${hits} 次：${line}`);
  fs.writeFileSync(INJECT, src.replace(line, `/* SABOTAGED: ${line} */ // ${SABOTAGE_MARK}.js`));
  assertMarked();
}

function sabotage(t) {
  if (t.line) sabotageLine(t.line);
  else sabotageFn(t.fn, t.revertTo);
}

async function main() {
  const key = process.env.JZ_SABOTAGE || 'all';
  const keys = key === 'all' ? Object.keys(TARGETS)
    : (TARGETS[key] ? [key] : fail(`未知的破坏目标 ${key}，可选：all | ${Object.keys(TARGETS).join(' | ')}`));
  const keep = !!process.env.JZ_KEEP_SABOTAGE;

  log('=== 反向验证（sabotage）：证明竞态断言不是空转 ===');
  log(`破坏目标：${keys.join(', ')}（共 ${keys.length} 个守卫）`);

  // A0 六轮 P2-1：KEEP 模式 = 人工观察现场，只允许单目标。
  // ① 三个守卫同时失效，现场变成一个「全守卫失效」的混沌态，没有观察价值；
  // ② 更糟的是阶段2 会在破坏态下重启 daemon 跑全量 E2E，报出一个误导性的 RESTORE-FAILED
  //    （看起来像「还原有问题」，实际是压根没还原）。故这里直接拒绝，逼用户指定单目标。
  if (keep && keys.length > 1) {
    fail(`JZ_KEEP_SABOTAGE=1 时只允许单目标观察（多目标会让 ${keys.length} 个守卫同时失效，现场失去意义）。\n` +
         `   请显式指定一个，例如：JZ_KEEP_SABOTAGE=1 JZ_SABOTAGE=${Object.keys(TARGETS)[0]} node test/e2e/cdp-pay-sync-sabotage.js\n` +
         `   可选目标：${Object.keys(TARGETS).join(' | ')}`);
  }
  if (keep) log('⚠️  JZ_KEEP_SABOTAGE=1：本轮结束会故意保留破坏态，并跳过阶段2、不写证据文件。');

  // A0 七轮 P2-6：并发锁必须在动源码前拿到（两个实例会互相覆盖备份）
  await acquireLock(); // A0 九轮：锁模块改为 async（测试缝需要 await），生产路径行为不变

  // ---- 安全前置 ----
  // 顺序很关键：残留破坏桩本身就会让 git diff 非空，若先做干净检查，
  // 用户只会看到「先 commit 你的改动」而不知道真实问题是破坏桩没清掉。
  selfCheckLeftover();
  const dirty = spawnSync('git', ['diff', '--quiet', 'scripts/inject.js'], { cwd: ROOT });
  if (dirty.status !== 0) {
    fail('scripts/inject.js 有未提交改动，先 commit 或 stash 再跑（防止被备份/还原覆盖你的 WIP）');
  }
  const cmd = currentDaemonCmd();
  if (!cmd) fail('47832 上没有读到 daemon 锁/进程，请先启动 dev daemon');
  if (!/scripts\/daemon\.js/.test(cmd)) fail(`47832 上的进程不是项目 dev daemon：${cmd}`);
  try {
    const la = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
    if (/workdaddy/.test(la)) fail('launchd 里的 workdaddy 看门狗仍在加载，会和 dev daemon 抢锁，先 unload');
  } catch (_) { /* launchctl 不可用则跳过 */ }
  try { await getJson(9222, '/json/list'); } catch (_) { fail('CDP 9222 不可用，无法驱动页面'); }

  // A0 七轮 P2-6：备份落在项目内 .tmp-probe/（0700 目录 + 0600 文件），绝不再放全局 /tmp。
  // 写完立刻自证：备份里若带破坏桩，说明 inject.js 当前就是脏的，必须停下来（不能拿脏备份当还原源）。
  fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  fs.copyFileSync(INJECT, BACKUP);
  fs.chmodSync(BACKUP, 0o600);
  if (fs.readFileSync(BACKUP, 'utf8').includes(SABOTAGE_MARK)) {
    fail(`备份 ${BACKUP} 里检出 ${SABOTAGE_MARK} —— scripts/inject.js 当前就带破坏桩，先手动还原再跑`);
  }
  log(`\n已备份 inject.js → ${path.relative(ROOT, BACKUP)}（0600）`);

  // A0 五轮 P2-2：默认遍历三个守卫并写聚合证据，避免「文档说三个都验过、仓库只有一份默认目标的证据」
  const record = {
    at: new Date().toISOString(),
    mode: key,
    targets: keys.map((k) => ({
      target: k,
      guard: TARGETS[k].fn || `line:${TARGETS[k].line}`,
      scene: TARGETS[k].scene,
      note: TARGETS[k].note,
      phase1: null, // 'caught'（守卫失效→场景 FAIL，符合预期）/ 'ineffective'（断言空转！）
    })),
    phase2: null,   // 'all-pass' / 'failed' / 'skipped'
  };
  // A0 七轮 P2-4：返回值语义 true = 证据可信落盘；false = 没有可信证据，调用方必须据此失败退出。
  // 原写法 catch 里只打日志继续走，「exit 0 但没有可信证据文件」是可能的，
  // 而 phase2 的 all-pass 结论正是靠这个文件被采信 —— 没有证据的成功比失败更危险。
  const writeEvidence = () => {
    // A0 六轮 P2-2：证据只有在「源码确认已还原」的前提下才有意义。
    // 备份丢失/还原不干净时还照写一份 all-pass，是比不写更严重的假证据。
    if (restoreFailed) {
      log(`\n❌ 拒绝写证据：本次运行发生过还原失败，${path.relative(ROOT, INJECT)} 可能仍带破坏桩，证据不可信。`);
      return false;
    }
    if (keep) {
      log(`\n❌ 拒绝写证据：JZ_KEEP_SABOTAGE=1 属于人工观察运行，不是闸门运行。`);
      return false;
    }
    // A0 八轮 P2-1：canonical 只认「全目标 + 阶段2 all-pass」。
    const isFullGate = key === 'all' && record.phase2 === 'all-pass';
    const targetPath = isFullGate ? EVIDENCE : EVIDENCE_PARTIAL;
    try {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(record, null, 2));
      // 回读校验：能解析且目标条目齐全，才算真的落盘成功
      const back = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      if (!back || !Array.isArray(back.targets) || back.targets.length !== record.targets.length) {
        throw new Error(`回读校验不通过：应写 ${record.targets.length} 个目标，读回 ${back && back.targets ? back.targets.length : 'null'}`);
      }
      log(`\n证据已落盘：${path.relative(ROOT, targetPath)}` +
          (isFullGate ? '' : `\n（partial 运行：${key} / phase2=${record.phase2}，未覆盖权威证据 pay-sync-sabotage.json）`));
      return true;
    } catch (e) {
      log(`\n❌ 证据落盘失败（fail-closed）：${e.message}`);
      log(`   本次运行的结论不予采信。`);
      return false;
    }
  };

  let allCaught = true;
  try {
    // ---- 阶段 1：逐个破坏守卫 → 对应场景必须 FAIL ----
    for (const k of keys) {
      const t = TARGETS[k];
      const rec = record.targets.find((r) => r.target === k);
      // A0 九轮 P1：动源码前必须确认锁仍在自己手里——接管竞态残余窗口（二次读取与
      // unlink 之间）万一被并发实例抢走锁，在这里大声终止，绝不静默双写 inject.js。
      ensureLockOurs();
      sabotage(t);
      const how = t.line ? `已注释掉「${t.line}」`
        : (t.revertTo ? `${t.fn} 已还原为修复前实现` : `${t.fn} 已改为恒真`);
      log(`\n--- 阶段1[${k}]：${how}，重跑场景 ${t.scene} ---`);
      // 故障注入（自检用）：模拟「打桩后 daemon 重启失败」，验证 finally 仍会还原
      if (process.env.JZ_SIMULATE_FAILURE) fail('JZ_SIMULATE_FAILURE=1：故意在打桩后抛错，检验清理逻辑');
      // 故障注入（自检用）：模拟固定备份被 /tmp 清理掉（macOS 会清 3 天未访问的文件，真实存在）。
      // 验证的是：还原失败必须硬失败阻断，而不是带着破坏桩继续跑阶段2 并写下一份假证据。
      if (process.env.JZ_SIMULATE_BACKUP_LOSS) {
        try { fs.unlinkSync(BACKUP); } catch (_) { /* 已不存在 */ }
        log(`\n[故障注入] 已删除固定备份 ${BACKUP} —— 后续还原必然失败，用于检验硬失败路径`);
      }
      await restartDaemon(`sabotage:${k}`);
      const r = await runE2E(t.scene);
      // A0 九轮 P2：E2E 超时被 SIGKILL 后父进程清场失败 = 页面残留 fetch stub（环境污染）。
      // 必须硬失败终止——只重启 daemon 不够，重新注入不会重置页面 JS。
      if (r.polluted) {
        fail('E2E 超时后父进程清场失败：WorkBuddy 页面可能残留 fetch stub（环境污染）。' +
             '请刷新 WorkBuddy 页面（Cmd+R）后重跑；本轮结论一律无效、不予采信。');
      }
      rec.phase1 = judge(r, t.scene);
      if (rec.phase1 === 'ineffective') {
        allCaught = false;
        log(`\n⚠️  守卫失效后场景 ${t.scene} 仍然 PASS —— ${t.fn} 的断言是空转的，没有真正拦住这个竞态！`);
      } else if (rec.phase1 === 'invalid') {
        // A0 七轮 P1-2：场景前置/构造失败不等于断言生效。若照旧记成 caught，
        // 就是「压根没跑到断言也算守卫生效」，据此写下的证据是假阳性。
        allCaught = false;
        log(`\n❌ 场景 ${t.scene} 未构造成功（E2E 输出 INVALID），本轮验证无效——` +
            `\n   这可能是环境/时序问题，但绝不等于「${t.fn} 的断言拦住了竞态」。` +
            `\n   请先看上面 E2E 的 INVALID 行定位原因，再重跑。`);
      } else if (rec.phase1 === 'error') {
        allCaught = false;
        log(`\n❌ E2E 未能跑到场景 ${t.scene}（脚本崩溃/前置失败），本轮验证无效——` +
            `\n   这不是「断言生效」，请先看上面 E2E 的输出定位真实原因。`);
      } else {
        log(`\n✅ 阶段1[${k}] 通过：${t.fn} 失效后场景 ${t.scene} 确实 FAIL（断言有效）`);
      }
      // 每个目标跑完立刻还原，避免多目标叠加成一个「全守卫失效」的混沌态。
      // A0 六轮 P2-2：还原失败必须硬失败——备份丢了还继续跑下一个目标，
      // 后面所有结论都建立在「源码可能还留着 return true 破坏桩」之上，一律不可信。
      if (!restoreInject(`restore:${k}`)) {
        fail(`阶段1[${k}] 结束后还原失败：${path.relative(ROOT, INJECT)} 可能仍带 ${SABOTAGE_MARK} 破坏桩，终止后续验证`);
      }
    }
  } finally {
    // ---- 兜底还原：任何异常路径（含 restartDaemon 抛错）都必须走到这里 ----
    restoreInject('finally');
  }

  // 堡垒：finally 兜底还原也失败时，上面的 fail() 可能没机会抛（例如异常本身来自 finally 之外）
  if (restoreFailed) {
    throw new Error('RESTORE-FAILED：还原 inject.js 失败，源码状态不可信 —— 已拒绝写证据并终止（不跑阶段2）');
  }

  if (!allCaught) {
    record.phase2 = 'skipped';
    writeEvidence(); // 结论是失败，证据落不下不影响「已经失败」这一定性，但仍要打印原因
    log('\n❌ 有守卫失效后场景仍 PASS / 场景未构造成功，见证据里的 phase1=ineffective|invalid|error 项');
    if (keep) { log('（JZ_KEEP_SABOTAGE=1：保留破坏态，跳过重启 daemon）'); throw new Error('SABOTAGE-INEFFECTIVE'); }
    await restartDaemon('restore-after-ineffective');
    throw new Error('SABOTAGE-INEFFECTIVE');
  }

  if (keep) {
    log(`\n============================================`);
    log(`⚠️  故意保留破坏态：${keys[0]} / ${TARGETS[keys[0]].fn} 仍为恒真`);
    log(`   · 已跳过阶段2（破坏态下跑全量 E2E 只会得到误导性的 RESTORE-FAILED）`);
    log(`   · 未写任何证据文件（这不是一次闸门运行，结论不具备验收效力）`);
    log(`   · 现场观察完后手动还原：  cp ${BACKUP} ${INJECT}`);
    log(`   · 还原后务必单独跑一次完整验证再采信结论`);
    log(`============================================`);
    return;
  }

  if (process.env.JZ_PHASE2 === '0') {
    record.phase2 = 'skipped';
    // A0 七轮 P2-4：结论要靠证据文件被采信，落盘失败必须 fail-closed
    if (!writeEvidence()) throw new Error('EVIDENCE-FAILED：阶段1 结论未落盘，不予采信');
    log(`\n============================================`);
    log(`阶段1 通过（JZ_PHASE2=0，跳过还原复跑）：${keys.join(', ')} 失效 → 各自场景 FAIL`);
    log(`注意：阶段2 未跑，请单独跑一次完整验证确认还原后全 PASS。`);
    log(`============================================`);
    await restartDaemon('restore-after-phase1-only');
    return;
  }

  // ---- 阶段 2：还原 → 全场景必须 PASS ----
  // A0 九轮 P1：阶段 2 要重启 daemon 并重新信任环境，同样先确认锁仍在自己手里。
  ensureLockOurs();
  log('\n--- 阶段2：已还原，重跑全部场景 ---');
  await restartDaemon('restore');
  const phase2 = await runE2E(null);
  if (phase2.polluted) {
    fail('阶段2 E2E 超时后父进程清场失败：WorkBuddy 页面可能残留 fetch stub（环境污染）。' +
         '请刷新 WorkBuddy 页面（Cmd+R）后重跑；本轮结论一律无效、不予采信。');
  }
  const ok = phase2.ok;
  record.phase2 = ok ? 'all-pass' : 'failed';
  // A0 七轮 P2-4：证据落盘失败 = 本次结论不可采信，即便 E2E 全 PASS 也要失败退出
  if (!writeEvidence()) throw new Error('EVIDENCE-FAILED：阶段2 结论未落盘，不予采信');
  if (!ok) { log('\n❌ 还原后全场景未全 PASS —— 还原或代码有问题'); throw new Error('RESTORE-FAILED'); }

  log(`\n============================================`);
  log(`反向验证通过：${keys.join(', ')} 逐个失效 → 各自场景 FAIL；还原 → 全场景复跑全 PASS`);
  log(`结论：这些竞态断言都是有效拦截，不是空转。`);
  log(`============================================`);
}

main().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
