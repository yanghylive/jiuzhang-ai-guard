'use strict';
// ---- A0 九/十轮 P1：并发锁行为级回归（真实锁代码 + 确定性交错）----
//
// 十轮定案：**默认不自动接管陈旧锁**（wx 独占创建 ⇒ 可证明互斥；任何自动 unlink 都有
// 「二次读取通过后、unlink 前」被抢占的残余 TOCTOU）。显式 JZ_TAKEOVER_STALE_LOCK=1
// 才走尽力接管（保留双读比对 + nonce 读回验证）。
//
// 本文件用**真实锁代码**（test/e2e/lib/sabotage-lock.js）验证：
//   1. 默认：陈旧锁 → 拒绝启动 + 锁文件原样保留（绝不 unlink）；
//   2. 显式 flag：陈旧锁 → 接管成功，nonce 归自己；
//   3. 十轮精确交错（接管路径 + await 测试缝）：P2 观察到陈旧锁后、二次读取前，
//      P1（子进程）完整接管 → P2 必须发现内容变化并重新评估 → 被 P1 活锁拒绝，
//      **P1 的锁原封不动**（修复前：P2 无条件 unlink → P1 锁被删 = 双持有）；
//   4. P1 已完整持锁后 P2 再来 → 被存活持有者拒绝；
//   5. 锁被抢走后 ensureLockOurs 必须失败、releaseLock 绝不删别人的锁。

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const process = require('node:process');

const LOCK = require('./e2e/lib/sabotage-lock.js');
const NODE = process.execPath;

// 拿一个确定已死的 pid：起一个立即退出的子进程
function deadPid() {
  return new Promise((resolve, reject) => {
    const p = spawn(NODE, ['-e', '""'], { stdio: 'ignore' });
    p.on('exit', () => resolve(p.pid));
    p.on('error', reject);
  });
}

function writeLockFile(pid, nonce) {
  fs.mkdirSync(LOCK.TMP_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    LOCK.LOCKFILE,
    JSON.stringify({ pid, nonce, at: new Date().toISOString() }),
    { flag: 'w', mode: 0o600 },
  );
}

function readLockFile() {
  try { return JSON.parse(fs.readFileSync(LOCK.LOCKFILE, 'utf8')); } catch (_) { return null; }
}

// 清理测试遗留锁（持有 pid 已死才动手）
async function cleanupStaleLock() {
  const cur = readLockFile();
  if (cur && cur.pid && LOCK.pidAlive(cur.pid) && cur.pid !== process.pid) return false; // 有活持有者
  try { fs.unlinkSync(LOCK.LOCKFILE); } catch (_) { /* 已不在 */ }
  return true;
}

// 子进程持锁者：真实锁代码，接管/创建成功后打印 P1-HELD 并持有一段时间
function spawnHolder(envFlag) {
  const childScript =
    `process.env.JZ_TAKEOVER_STALE_LOCK = ${JSON.stringify(envFlag ? '1' : '')};` +
    `const L = require(${JSON.stringify(require.resolve('./e2e/lib/sabotage-lock.js'))});` +
    `L.acquireLock().then(function(){ console.log('P1-HELD'); });` +
    `setTimeout(function(){ L.releaseLock(); }, 12000);`;
  const p = spawn(NODE, ['-e', childScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  const held = new Promise((resolve, reject) => {
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('P1-HELD')) resolve();
    });
    p.on('exit', (code) => reject(new Error(`P1 提前退出 code=${code}`)));
    setTimeout(() => reject(new Error('P1 接管超时')), 10000);
  });
  return { p, held };
}

test('十轮 P1：默认拒绝接管陈旧锁，锁文件原样保留', async () => {
  if (!(await cleanupStaleLock())) return;
  const dead = await deadPid();
  const staleRaw = JSON.stringify({ pid: dead, nonce: 'stale-nonce', at: new Date().toISOString() });
  writeLockFile(dead, 'stale-nonce');
  const before = fs.readFileSync(LOCK.LOCKFILE, 'utf8');
  let failMsg = null;
  try {
    await LOCK.acquireLock({ fail: (m) => { failMsg = m; throw new Error(m); } });
    assert.ok(false, '默认模式下面对陈旧锁必须拒绝启动');
  } catch (e) {
    assert.match(String(failMsg || e.message), /陈旧.*锁|默认不自动接管/, `应明确报陈旧锁，实际：${e.message}`);
    assert.match(String(failMsg || e.message), /rm |JZ_TAKEOVER_STALE_LOCK/, '应给出人工清理命令或显式 flag 指引');
  }
  assert.equal(fs.readFileSync(LOCK.LOCKFILE, 'utf8'), before,
    '默认路径绝不 unlink 自己没创建的锁——锁文件必须原样保留');
  await cleanupStaleLock();
});

test('十轮 P1：显式 JZ_TAKEOVER_STALE_LOCK=1 才允许接管陈旧锁', async () => {
  if (!(await cleanupStaleLock())) return;
  const dead = await deadPid();
  writeLockFile(dead, 'stale-nonce-2');
  process.env.JZ_TAKEOVER_STALE_LOCK = '1';
  try {
    await LOCK.acquireLock();
    const cur = readLockFile();
    assert.ok(cur && cur.nonce && cur.nonce !== 'stale-nonce-2' && cur.pid === process.pid,
      '显式接管后锁内容应为接手者的新 nonce + 自己的 pid');
    LOCK.ensureLockOurs();
  } finally {
    delete process.env.JZ_TAKEOVER_STALE_LOCK;
    LOCK.releaseLock();
  }
  assert.equal(readLockFile(), null, 'release 后锁文件应消失');
});

test('十轮 P1：接管路径的精确交错——P1 在 P2「二次读取前」完成接管，P2 必须被拒且 P1 锁完好', async () => {
  if (!(await cleanupStaleLock())) return;
  const dead = await deadPid();
  writeLockFile(dead, 'stale-nonce');
  let p1 = null;
  let failMsg = null;
  process.env.JZ_TAKEOVER_STALE_LOCK = '1'; // P2 走显式接管路径（残余风险已被人工声明）
  try {
    await LOCK.acquireLock({
      fail: (m) => { failMsg = m; throw new Error(m); },
      // 测试缝：P2 已观察到陈旧锁、尚未二次读取。缝里让 P1（带 flag 的子进程）
      // **完整走完接管**（unlink 旧锁 → wx 创建 → nonce 回读）并持有。
      onBeforeTakeover: () => {
        const h = spawnHolder(true);
        p1 = h.p;
        return h.held;
      },
    });
    assert.ok(false, 'P2 不应成功拿到锁——它面对的是 P1 的新锁');
  } catch (e) {
    assert.ok(
      (failMsg && /另一个 sabotage 实例正在运行/.test(failMsg)) ||
      /另一个 sabotage 实例正在运行/.test(String(e.message)),
      `P2 必须因「看到 P1 存活 pid」被拒，实际：${failMsg || e.message}`,
    );
  } finally {
    delete process.env.JZ_TAKEOVER_STALE_LOCK;
    // 核心断言：P1 的锁没有被 P2 删掉换掉（修复前这里必然失败——无条件 unlink）
    const after = readLockFile();
    assert.ok(after && p1 && after.pid === p1.pid,
      `P1 的锁必须原封不动（修复前会被后到者删除换掉），实际：${JSON.stringify(after)}`);
    if (p1) {
      assert.ok(LOCK.pidAlive(p1.pid), '断言期间 P1 必须仍然存活（锁有效性前提）');
      try { p1.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
      await new Promise((r) => { p1.on('exit', r); setTimeout(r, 5000); });
    }
  }
  await cleanupStaleLock();
});

test('十轮 P1：P1 已完整持锁后 P2 再来必须被拒（存活持有者）', async () => {
  if (!(await cleanupStaleLock())) return;
  let p1 = null;
  try {
    const h = spawnHolder(false); // P1 正常创建锁（无陈旧锁，无需 flag）
    p1 = h.p;
    await h.held;
    let failMsg = null;
    try {
      await LOCK.acquireLock({ fail: (m) => { failMsg = m; throw new Error(m); } });
      assert.ok(false, 'P2 不应拿到 P1 持有的锁');
    } catch (e) {
      assert.ok(failMsg && /另一个 sabotage 实例正在运行/.test(failMsg),
        `P2 应被存活持有者拒绝，实际：${failMsg || e.message}`);
    }
    const after = readLockFile();
    assert.ok(after && after.pid === p1.pid, 'P1 的锁必须原封不动');
  } finally {
    if (p1) { try { p1.kill('SIGKILL'); } catch (_) {} }
    await new Promise((r) => setTimeout(r, 300));
    await cleanupStaleLock();
  }
});

test('十轮 P1：锁被抢走后 ensureLockOurs 必须失败、releaseLock 绝不删别人的锁', async () => {
  if (!(await cleanupStaleLock())) return;
  await LOCK.acquireLock();
  try {
    // 模拟锁被并发实例接管：文件被换成别人的 nonce + 一个「存活」的 pid（用自己当活 pid）
    const stolen = { pid: process.pid, nonce: 'thief-nonce', at: new Date().toISOString() };
    fs.writeFileSync(LOCK.LOCKFILE, JSON.stringify(stolen), { flag: 'w', mode: 0o600 });
    assert.throws(() => LOCK.ensureLockOurs(), /已被其他实例接管|并发锁未持有/,
      '锁被抢走后检查点必须大声失败');
    LOCK.releaseLock(); // nonce 不符 → 只解除持有标记，绝不删
    const cur = readLockFile();
    assert.ok(cur && cur.nonce === 'thief-nonce', 'release 绝不能删别人的锁');
    fs.unlinkSync(LOCK.LOCKFILE); // 测试自清理
  } finally {
    if (fs.existsSync(LOCK.LOCKFILE)) { try { fs.unlinkSync(LOCK.LOCKFILE); } catch (_) {} }
  }
});
