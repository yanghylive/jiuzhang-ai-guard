'use strict';
// 全局操作互斥锁（03 §4 / 05 §7 DoD：清理与备份/恢复/体检互斥）。
//
// 锁文件：<root>/runtime/op.lock（JSON：{ op, pid, acquiredAt, token }）。
// 语义：
//   - 备份 create/restore、清理 apply/restore/purge、自动备份调度执行前必须 acquire；
//   - 已有锁且未过期 → 返回 BUSY（含持有者 op），调用方不得执行；
//   - 锁过期（stale，默认 5 分钟，进程可能崩溃残留）→ 自动抢占，不阻塞恢复；
//   - release 需匹配 token，防止误释放他人锁；
//   - 同一进程内同步语义 + 文件原子写，规避异步交错。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteJSON, readJSON } = require('./lib');

const STALE_MS = Number(process.env.JZ_OP_LOCK_STALE_MS) || 5 * 60 * 1000;

function lockPath(root) {
  return path.join(root, 'runtime', 'op.lock');
}

function token() {
  return crypto.randomBytes(16).toString('hex');
}

function currentLock(root) {
  const p = lockPath(root);
  try {
    if (!fs.existsSync(p)) return null;
    const l = readJSON(p);
    if (!l || !l.token) return null;
    return l;
  } catch {
    return null;
  }
}

function isStale(lock) {
  const age = Date.now() - new Date(lock.acquiredAt).getTime();
  return !Number.isFinite(age) || age > STALE_MS;
}

// 尝试取锁。返回 { ok:true, token, op } 或 { ok:false, error:'BUSY', by }。
function acquire({ root, op = 'unknown' } = {}) {
  root = root || require('./lib').dataRoot();
  const cur = currentLock(root);
  if (cur && !isStale(cur)) {
    return { ok: false, error: 'BUSY', by: { op: cur.op, pid: cur.pid, acquiredAt: cur.acquiredAt } };
  }
  const tk = token();
  atomicWriteJSON(lockPath(root), { op, pid: process.pid, acquiredAt: new Date().toISOString(), token: tk });
  // 写入后再读一次确认（防竞态：两个调用同时写时后写者胜，前写者应识别自己不是持有者）
  const mine = currentLock(root);
  if (mine && mine.token === tk) return { ok: true, token: tk, op };
  // 被并发覆盖 → 视为失败
  return { ok: false, error: 'BUSY', by: mine ? { op: mine.op, pid: mine.pid } : null };
}

function release({ root, token: tk } = {}) {
  root = root || require('./lib').dataRoot();
  const cur = currentLock(root);
  if (!cur) return { ok: true, released: false };
  if (tk && cur.token !== tk) return { ok: false, error: 'NOT_OWNER' };
  try {
    fs.rmSync(lockPath(root), { force: true });
  } catch {
    /* ignore */
  }
  return { ok: true, released: true };
}

// 便捷包装：取锁 → 执行 → 释放。busy 时返回 { ok:false, error:'BUSY' }，不执行 fn。
async function withLock({ root, op, fn }) {
  const got = acquire({ root, op });
  if (!got.ok) return { ok: false, error: 'BUSY', by: got.by };
  try {
    return await fn();
  } finally {
    release({ root, token: got.token });
  }
}

module.exports = { acquire, release, withLock, currentLock, isStale, STALE_MS, lockPath };
