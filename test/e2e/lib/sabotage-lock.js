'use strict';
// ---- sabotage 并发锁（独立模块，供 cdp-pay-sync-sabotage.js 与行为级竞态测试共用）----
//
// A0 七轮 P2-6：项目内 .tmp-probe/ + wx 独占创建 + 持有进程存活判断。
// A0 八轮 P2-2：锁内容带唯一 nonce；接管后读回验证；释放前校验 nonce。
// A0 九轮 P1：接管前二次读取比对 + ensureLockOurs 检查点。
// A0 十轮 P1（当前实现，**可证明互斥**）：九轮的「二次读取比对」仍不是原子的——
// 二次读取通过之后、unlink 之前仍可被抢占（A 在该窗口暂停、B 完成接管、A 恢复后
// 依旧会删掉 B 的新锁）。文件系统没有原子 CAS，**任何自动接管都存在无法归零的双持有窗口**。
// 修法：**默认取消自动接管陈旧锁**。
//   - 默认路径：wx 独占创建（原子）；EEXIST 时若持有者存活 → fail；持有者已死/锁损坏
//     → **同样 fail**（给出人工清理命令），绝不 unlink 自己没创建的锁。
//     → 互斥可证明：A 持锁 ⇔ A 的 wx 创建成功；B 的 wx 必然 EEXIST 且 A 存活 → B 必被拒。
//   - 显式 `JZ_TAKEOVER_STALE_LOCK=1`：人工接受残余竞态风险后的**尽力接管**
//     （保留二次读取比对 + nonce 读回验证 + 测试缝），仅用于明确无并发时的自愈。
//   代价（如实交底）：SIGKILL/断电后锁会残留，下一次运行需人工 `rm` 或显式 flag。
//   对一个会改写 inject.js 的测试闸门而言，「安全但偶尔要多敲一条命令」远优于
//   「方便但可能双持有」。
//
// 测试缝：onBeforeTakeover(sawRaw) 在「显式接管路径中、观察到陈旧锁之后、二次读取比对
// 之前」被 await——行为级竞态测试靠它在两个进程之间制造确定性的交错时序。生产代码不传。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const TMP_DIR = path.join(ROOT, '.tmp-probe');
const LOCKFILE = path.join(TMP_DIR, 'jz-inject.sabotage.lock');

let lockHeld = false;
let lockNonce = null;

const defaultFail = (msg) => { throw new Error(msg); };

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function readRaw() {
  try { return fs.readFileSync(LOCKFILE, 'utf8'); } catch (_) { return null; }
}
function readLock() {
  const raw = readRaw();
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function acquireLock(opts = {}) {
  const fail = opts.fail || defaultFail;
  const onBeforeTakeover = opts.onBeforeTakeover || null;
  // A0 十轮 P1：默认不自动接管陈旧锁（可证明互斥），显式 flag 才走尽力接管。
  const takeoverFlag = process.env.JZ_TAKEOVER_STALE_LOCK === '1';
  fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  // mkdirSync 的 mode 只对「新建」目录生效，已存在时必须显式收紧（A0 八轮 P2-2）
  try { fs.chmodSync(TMP_DIR, 0o700); } catch (_) { /* 尽力而为：目录可能被外部持有 */ }
  lockNonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  const payload = JSON.stringify({ pid: process.pid, nonce: lockNonce, at: new Date().toISOString() });
  for (;;) {
    let sawRaw = null; // wx 失败时看到的锁内容（显式接管路径的比对基准）
    try {
      // wx = 独占创建：文件已存在直接 EEXIST，不会误覆盖别人持有的锁。
      // 这是互斥的硬保证：持锁 ⇔ wx 创建成功，不存在「创建成功但别人也持锁」。
      fs.writeFileSync(LOCKFILE, payload, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      sawRaw = readRaw();
      const holder = sawRaw ? (() => { try { return JSON.parse(sawRaw); } catch (_) { return null; } })() : null;
      if (holder && holder.pid && holder.pid !== process.pid && pidAlive(holder.pid)) {
        fail(`另一个 sabotage 实例正在运行（锁 ${LOCKFILE}，pid=${holder.pid}）——并发跑会互相覆盖固定备份，拒绝启动`);
      }
      // A0 十轮 P1：持有者已死或锁损坏/内容不可解析 → **默认拒绝接管**。
      // 任何自动 unlink 都有「二次读取通过后、unlink 前」被抢占的残余窗口（fs 无原子 CAS），
      // 唯一可证明互斥的做法是：默认路径绝不 unlink 自己没创建的锁。
      if (!takeoverFlag) {
        fail(`发现陈旧/损坏的锁文件 ${LOCKFILE}（持有者 pid=${holder ? holder.pid : '未知'} 已死或内容不可解析）。\n` +
             `   为杜绝并发双持有，默认不自动接管。请确认没有其他 sabotage 在跑后执行：\n` +
             `     rm ${LOCKFILE}\n` +
             `   或显式 JZ_TAKEOVER_STALE_LOCK=1 重跑（人工接受尽力接管的残余竞态风险）。`);
      }
      // ---- 以下为显式接管路径（JZ_TAKEOVER_STALE_LOCK=1，尽力而为）----
      // 测试缝：await 一个完整的「并发接管者接管」过程，制造确定性交错。
      if (typeof onBeforeTakeover === 'function') await onBeforeTakeover(sawRaw);
      // A0 九轮 P1（接管路径的兜底）：**删除前二次读取比对**。sawRaw 是「我看到的旧锁」，
      // 但在我评估期间它可能已被并发接管者删掉并换成了对方的新锁——
      // 此时绝不能 unlink（那会删掉别人的新锁，造成双持有）。
      // 仅当锁内容仍与 sawRaw 完全相等（或锁已消失=null，那直接尝试 wx 抢）才继续。
      const cur = readRaw();
      if (cur !== null && cur !== sawRaw) continue; // 锁被人动过 → 重新评估（重读后大概率看到对方存活 pid）
      if (cur !== null) {
        try { fs.unlinkSync(LOCKFILE); } catch (_) { /* ENOENT = 别人已删 → 直接重试 wx 抢 */ }
      }
      try {
        fs.writeFileSync(LOCKFILE, payload, { flag: 'wx', mode: 0o600 });
      } catch (e2) {
        if (e2.code === 'EEXIST') continue; // 别人抢先接管了 → 重新评估
        throw e2;
      }
    }
    // 双保险：读回验证拿到的锁仍是自己的 nonce（防「刚创建就被并发接管者删掉换掉」）
    const back = readLock();
    if (!back || back.nonce !== lockNonce) continue;
    lockHeld = true;
    return;
  }
}

// 检查点：任何「要动 inject.js / 固定备份」的动作之前调用。
// 锁已被并发接管者抢走时立刻大声失败，杜绝「两个实例同时改写源码还都以为自己在跑」。
function ensureLockOurs(opts = {}) {
  const fail = opts.fail || defaultFail;
  if (!lockHeld) fail('并发锁未持有（内部错误）——拒绝继续任何源码改动');
  const cur = readLock();
  if (!cur || cur.nonce !== lockNonce) {
    fail(`并发锁已被其他实例接管（${LOCKFILE}）——本实例立即终止，` +
         `请检查是否有并发 sabotage 进程（ps aux | grep cdp-pay-sync-sabotage）`);
  }
}

function releaseLock() {
  if (!lockHeld) return;
  // 释放前校验 nonce：只删「自己认领的那把锁」。锁已换手（nonce 不符）时绝不删。
  const cur = readLock();
  if (cur && cur.nonce !== lockNonce) { lockHeld = false; return; }
  try { fs.unlinkSync(LOCKFILE); } catch (_) { /* 已释放 */ }
  lockHeld = false;
}

module.exports = {
  TMP_DIR,
  LOCKFILE,
  pidAlive,
  readLock,
  readRaw,
  acquireLock,
  ensureLockOurs,
  releaseLock,
  isHeld: () => lockHeld,
};
