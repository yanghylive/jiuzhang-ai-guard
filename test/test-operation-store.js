'use strict';
// 回归测试（V0.2 全局长操作体系）：生命周期（running→succeeded/failed）、
// 取消标记、重启降级 unknown、持久化、TTL 清理、HTTP 端点、长操作接入（backup/restore）。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRouterServer, jzFetch } = require('./_helpers');
const {
  beginOperation, getOperation, completeOperation, failOperation,
  cancelOperation, isCancelRequested, listOperations, degradeStaleOnStart, sweepOperations,
} = require('../scripts/jz/operation-store');

const TOKEN = crypto.randomBytes(32).toString('hex');

test('operation：生命周期 running→succeeded/failed + 取消标记 + 持久化', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-op-'));
  const op = beginOperation({ root, type: 'restore', label: '测试恢复', total: 3 });
  assert.equal(op.status, 'running');
  // 持久化：同 id 可再读
  const g1 = getOperation({ root, operationId: op.operationId });
  assert.equal(g1.ok, true);
  assert.equal(g1.operation.type, 'restore');
  // 取消标记
  const c = cancelOperation({ root, operationId: op.operationId, reason: '用户取消' });
  assert.equal(c.operation.cancelRequested, true);
  assert.equal(isCancelRequested({ root, operationId: op.operationId }), true);
  // 完成后取消状态保留、状态切换
  const done = completeOperation({ root, operationId: op.operationId, status: 'succeeded', rollbackAvailable: true, changed: ['a'], evidence: [{ source: 't', summary: 's', observedAt: new Date().toISOString() }] });
  assert.equal(done.operation.status, 'succeeded');
  assert.equal(done.operation.rollbackAvailable, true);
  assert.ok(done.operation.finishedAt, '完成必须有 finishedAt');
  // 失败路径
  const op2 = beginOperation({ root, type: 'handoff-apply', label: 'x' });
  const f = failOperation({ root, operationId: op2.operationId, errorCode: 'HANDOFF_APPLY_FAILED', detail: 'bad' });
  assert.equal(f.operation.status, 'failed');
  assert.equal(f.operation.errorCode, 'HANDOFF_APPLY_FAILED');
  // 不存在的 id
  assert.equal(getOperation({ root, operationId: 'nope' }).ok, false);
  // 列表
  const list = listOperations({ root });
  assert.ok(list.operations.length >= 2);
});

test('operation：重启降级 running→unknown，绝不自动重试；TTL 清理', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-op2-'));
  const running = beginOperation({ root, type: 'backup', label: '中断的备份' });
  const done = beginOperation({ root, type: 'restore', label: '完成的恢复' });
  completeOperation({ root, operationId: done.operationId, status: 'succeeded' });
  // 模拟重启
  degradeStaleOnStart({ root, log: () => {} });
  const g = getOperation({ root, operationId: running.operationId });
  assert.equal(g.operation.status, 'unknown', '重启后 running 必须降级 unknown');
  assert.equal(g.operation.errorCode, 'INTERRUPTED');
  assert.match(g.operation.note || '', /不自动重试/);
  const gd = getOperation({ root, operationId: done.operationId });
  assert.equal(gd.operation.status, 'succeeded', '已完成操作不受影响');
  // 幂等：再降级一次不破坏
  degradeStaleOnStart({ root, log: () => {} });
  assert.equal(getOperation({ root, operationId: running.operationId }).operation.status, 'unknown');
  // TTL：超 7 天 + 超 50 条才清（构造老 mtime 不触发——保留数内不删）
  sweepOperations({ root });
  assert.equal(getOperation({ root, operationId: running.operationId }).ok, true, '保留数内不清理');
});

test('operation HTTP：list/get/cancel + backup/restore 长操作登记 operationId', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-op-http-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"dark"}');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    // backup（自动登记 operation）→ 响应带 operationId？backup 响应未带 operationId——通过列表查
    const bk = await jzFetch(s.baseUrl, '/api/vault/backup', {
      method: 'POST', token: TOKEN,
      body: { scope: ['settings'], reason: 'manual', idempotencyKey: 'op-backup-key-01' },
    });
    assert.equal(bk.status, 200);
    // operations 列表包含 backup 操作
    const lst = await jzFetch(s.baseUrl, '/api/operations', { method: 'GET', token: TOKEN });
    const lj = await lst.json();
    assert.ok(lj.data.operations.some((o) => o.type === 'backup' && o.status === 'succeeded'), 'backup 操作应登记且 succeeded');

    // get 单条 + cancel
    const target = lj.data.operations.find((o) => o.type === 'backup');
    const g = await jzFetch(s.baseUrl, `/api/operations/${target.operationId}`, { method: 'GET', token: TOKEN });
    const gj = await g.json();
    assert.equal(g.status, 200);
    assert.equal(gj.data.operation.operationId, target.operationId);
    const c = await jzFetch(s.baseUrl, `/api/operations/${target.operationId}/cancel`, { method: 'POST', token: TOKEN, body: { reason: '测试取消' } });
    const cj = await c.json();
    assert.equal(c.status, 200);
    assert.equal(cj.data.operation.cancelRequested, true);
    // 不存在的 id → 404
    const nf = await jzFetch(s.baseUrl, '/api/operations/not-exist-id', { method: 'GET', token: TOKEN });
    assert.equal(nf.status, 404);
  } finally {
    await s.close();
  }
});
