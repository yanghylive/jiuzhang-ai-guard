'use strict';
// 操作互斥锁测试：BUSY 语义、stale 抢占、NOT_OWNER、withLock 不执行。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquire, release, withLock, currentLock, isStale, lockPath } = require('../scripts/jz/op-lock');

test('acquire → 持有期间再 acquire 返回 BUSY → release 后恢复', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-lock-'));
  const a = acquire({ root, op: 'backup-create' });
  assert.equal(a.ok, true);
  assert.ok(a.token);

  const b = acquire({ root, op: 'cleanup-apply' });
  assert.equal(b.ok, false);
  assert.equal(b.error, 'BUSY');
  assert.equal(b.by.op, 'backup-create');

  const r = release({ root, token: a.token });
  assert.equal(r.ok, true);
  assert.equal(r.released, true);

  const c = acquire({ root, op: 'cleanup-apply' });
  assert.equal(c.ok, true);
  release({ root, token: c.token });
});

test('release 传错 token → NOT_OWNER，锁保留', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-lock2-'));
  const a = acquire({ root, op: 'backup-restore' });
  const r = release({ root, token: 'wrong-token' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NOT_OWNER');
  // 锁还在
  assert.ok(currentLock(root));
  release({ root, token: a.token });
  assert.equal(currentLock(root), null);
});

test('stale 锁（进程崩溃残留）可被抢占', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-lock3-'));
  const a = acquire({ root, op: 'cleanup-purge' });
  // 人为把 acquiredAt 改到 1 小时前 → 视为过期
  const p = lockPath(root);
  const l = JSON.parse(fs.readFileSync(p, 'utf8'));
  l.acquiredAt = new Date(Date.now() - 3600 * 1000).toISOString();
  fs.writeFileSync(p, JSON.stringify(l));
  assert.equal(isStale(currentLock(root)), true);

  const b = acquire({ root, op: 'backup-create' });
  assert.equal(b.ok, true, 'stale 锁应被抢占');
  release({ root, token: b.token });
});

test('withLock：fn 正常执行并自动释放；忙时返回 BUSY 不执行 fn', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-lock4-'));
  let executed = 0;
  const r1 = await withLock({ root, op: 'backup-create', fn: async () => {
    executed++;
    return { ok: true };
  } });
  assert.equal(r1.ok, true);
  assert.equal(executed, 1);
  assert.equal(currentLock(root), null, 'withLock 结束后锁应释放');

  // 持有锁时 withLock 应 BUSY 且不执行 fn
  const a = acquire({ root, op: 'cleanup-apply' });
  const r2 = await withLock({ root, op: 'backup-restore', fn: async () => {
    executed++;
    return { ok: true };
  } });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'BUSY');
  assert.equal(executed, 1, 'BUSY 时 fn 不得执行');
  release({ root, token: a.token });
});

test('并发交错：两个 withLock 同 op 同时进入，只有一个成功', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-lock5-'));
  const results = await Promise.all([
    withLock({ root, op: 'auto-backup', fn: async () => ({ ok: true }) }),
    withLock({ root, op: 'auto-backup', fn: async () => ({ ok: true }) }),
  ]);
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 1, `并发取锁应只有一个成功，实际 ${okCount}`);
  assert.equal(currentLock(root), null, '全部结束后锁应释放');
});
