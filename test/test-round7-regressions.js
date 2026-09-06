'use strict';
// 2026-08-30 第七轮复核回归：
//   P0-1 cleanup resolveIds/apply 链接逃逸（craftedId 不得处理外部文件）
//   P0-2 purge 链接 quarantine 逃逸（外部 receipt 不得删外部文件）
//   P0-3 旧宿主 ensureDirs 父级链
//   P1-1 stash 唯一后缀（randomUUID，不再毫秒覆盖）
//   P1-2 模型备份符号链接拒绝
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { apply, listQuarantine, restore, purge, resolveIds } = require('../scripts/jz/cleanup');
const { readModelBackup, listModelBackups, ensureDirs } = require('../scripts/lib');
const { modelBackupsDir, accountsDir } = require('../scripts/lib');

const TMP = fs.realpathSync(os.tmpdir());

function mkRoot() {
  const root = fs.mkdtempSync(path.join(TMP, 'jz-r7-'));
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  return root;
}

test('P0-1 cleanup：runtime 是链接时 resolveIds/apply 不处理外部文件（craftedId 逃逸封死）', () => {
  const root = mkRoot();
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-r7-out1-'));
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'VICTIM');
  // root/runtime → 外部（含 victim.txt）
  fs.rmSync(path.join(root, 'runtime'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(root, 'runtime'), 'dir');
  // 用外部 victim 的路径构造 craftedId（与 resolveIds 相同的 hash 算法）
  const crypto = require('node:crypto');
  const crafted = crypto.createHash('sha256').update(path.join(outside, 'victim.txt')).digest('hex').slice(0, 16);
  const hits = resolveIds(root, [crafted]);
  assert.equal(hits.hits.length, 0, '链接目录内的文件不得被识别为候选项');
  const r = apply({ ids: [crafted], root });
  assert.equal(r.moved || 0, 0, 'apply 不得移动外部文件');
  assert.ok(fs.existsSync(path.join(outside, 'victim.txt')), '外部文件必须原样保留');
});

test('P0-2 purge：quarantine 是链接时拒绝操作（外部 receipt 不得删外部文件）', () => {
  const root = mkRoot();
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-r7-out2-'));
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'VICTIM');
  fs.symlinkSync(outside, path.join(root, 'quarantine'), 'dir');
  // 手工构造外部 receipt（正常流程被入口校验拦截，这里模拟恶意/旧数据场景）
  fs.mkdirSync(path.join(outside, '_receipts'), { recursive: true });
  const receipt = {
    receiptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    status: 'quarantined',
    items: [{ storedPath: path.join(outside, 'victim.txt') }],
  };
  fs.writeFileSync(path.join(outside, '_receipts', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json'), JSON.stringify(receipt));
  const r = purge({ receiptId: receipt.receiptId, confirmed: true, root });
  assert.equal(r.ok, false, 'quarantine 链接必须 fail-closed');
  assert.equal(r.error, 'CLEANUP_SYMLINK_QUARANTINE');
  assert.ok(fs.existsSync(path.join(outside, 'victim.txt')), '外部文件不得被删');
});

test('P0-3 旧宿主 ensureDirs：dataDir 父级链有链接 → 抛错，外部不建 accounts', () => {
  const base = fs.mkdtempSync(path.join(TMP, 'jz-r7-p3-'));
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-r7-p3-out-'));
  fs.symlinkSync(outside, path.join(base, 'parent-link'), 'dir');
  const dataDir = path.join(base, 'parent-link', 'data');
  assert.throws(() => ensureDirs(dataDir), /符号链接/, '父级链链接必须 fail-closed');
  assert.ok(!fs.existsSync(path.join(outside, 'data', 'accounts')), '外部不得创建 accounts');
});

test('P1-1 stash 唯一后缀：randomUUID（不再毫秒时间戳覆盖）', () => {
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  const seg = src.slice(src.indexOf("p === '/api/stash'"), src.indexOf("p === '/api/stash'") + 1200);
  assert.ok(!/__'\s*\+\s*now/.test(seg), '不得再用时间戳作后缀');
  assert.ok(/crypto\.randomUUID\(\)/.test(seg), '必须用 randomUUID');
  assert.ok(!seg.includes("__' + now"), '时间戳后缀已移除');
});

test('P1-2 模型备份：符号链接拒绝读取（apiKey 不外泄）', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'jz-r7-p5-'));
  const dir = modelBackupsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const outside = path.join(TMP, 'jz-r7-out5.json');
  fs.writeFileSync(outside, JSON.stringify({ schema: 1, model: { name: 'evil', apiKey: 'SK-EVIL' }, savedAt: new Date().toISOString() }));
  // 备份文件是外部 JSON 的符号链接
  fs.symlinkSync(outside, path.join(dir, 'backup-1.json'));

  assert.throws(() => readModelBackup(root, 'backup-1'), /符号链接/, '读链接必须拒绝');
  const list = listModelBackups(root);
  assert.ok(!JSON.stringify(list).includes('SK-EVIL'), '列表不得泄露外部 apiKey');
  assert.ok(!JSON.stringify(list).includes('backup-1'), '链接备份不得出现在列表');
});
