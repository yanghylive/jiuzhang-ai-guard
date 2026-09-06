'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scan, apply, restore, purge, listQuarantine, insideWhitelist } = require('../scripts/jz/cleanup');
const { ensureDataRoot } = require('../scripts/jz/lib');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-clean-'));
process.env.JZ_DATA_ROOT = root;
ensureDataRoot(root);

function idOf(p) {
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
}

function makeLog(name) {
  const f = path.join(root, 'logs', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'a');
  return f;
}

test('清理只处理白名单内候选项，且是移入回收站而非物理删除', () => {
  const f = makeLog('x.log');
  const s = scan({ root });
  const cand = s.candidates.find((c) => c.path === f);
  assert.ok(cand);
  const r = apply({ ids: [cand.id], root });
  assert.equal(r.moved, 1);
  assert.equal(r.recoverable, true);
  assert.ok(r.receiptId);
  assert.ok(!fs.existsSync(f), '原路径应已移走');
  const q = listQuarantine({ root });
  const rec = q.receipts.find((x) => x.receiptId === r.receiptId);
  assert.ok(rec && rec.intact === true, '回收站回执应完整');
});

test('回收站可真实恢复（不是只改状态字段）', () => {
  const f = makeLog('restore-me.log');
  const cand = scan({ root }).candidates.find((c) => c.path === f);
  const r = apply({ ids: [cand.id], root });
  assert.equal(r.moved, 1);
  const back = restore({ receiptId: r.receiptId, root });
  assert.equal(back.ok, true);
  assert.equal(back.restored, 1);
  assert.ok(fs.existsSync(f), '文件必须真的回到原路径');
  assert.equal(fs.readFileSync(f, 'utf8'), 'a', '内容必须一致');
});

test('原路径被占用时恢复失败，不覆盖用户现有文件', () => {
  const f = makeLog('conflict.log');
  const cand = scan({ root }).candidates.find((c) => c.path === f);
  const r = apply({ ids: [cand.id], root });
  fs.writeFileSync(f, 'NEW'); // 用户又生成了同名文件
  const back = restore({ receiptId: r.receiptId, root });
  assert.equal(back.ok, false);
  assert.equal(back.reason, 'original_path_occupied');
  assert.equal(fs.readFileSync(f, 'utf8'), 'NEW', '现有文件不得被覆盖');
});

test('永久删除必须显式确认，且删除后不可恢复', () => {
  const f = makeLog('purge-me.log');
  const cand = scan({ root }).candidates.find((c) => c.path === f);
  const r = apply({ ids: [cand.id], root });
  const noConfirm = purge({ receiptId: r.receiptId, root });
  assert.equal(noConfirm.ok, false);
  assert.equal(noConfirm.reason, 'confirmation_required');
  const done = purge({ receiptId: r.receiptId, confirmed: true, root });
  assert.equal(done.ok, true);
  assert.equal(done.recoverable, false);
  const back = restore({ receiptId: r.receiptId, root });
  assert.equal(back.ok, false, '已永久删除必须明确失败，不能返回 ok:true 的假恢复');
});

test('非白名单 ID 与路径逃逸被拒绝', () => {
  const r = apply({ ids: [idOf('/etc/passwd'), 'deadbeefdeadbeef'], root });
  assert.equal(r.moved, 0);
  assert.equal(r.rejected.length, 2);
  assert.equal(insideWhitelist(root, '/etc/passwd'), false);
  assert.equal(insideWhitelist(root, path.join(root, 'logs', '..', '..', 'etc', 'passwd')), false);
});
