'use strict';
// 2026-08-30 第六轮复核回归：符号链接父级链（isPhysicallyRealPath 统一物理校验）。
//   P0-1 restore 目标 base 的**父级链**有链接 → 条目 unsafe（第五轮只查 base 本身漏掉）
//   P0-2 备份源 wbDir 父级链有链接 → createBackup 拒绝（外部文件不得进保险箱）
//   P0-3 ensureDataRoot root 父级链有链接 → 拒绝创建
//   P0-4 cleanup/清理 runtime 为链接 → 拒绝（不删外部旧文件）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackup, restoreBackup } = require('../scripts/jz/backup-vault');
const { ensureDataRoot, isPhysicallyRealPath } = require('../scripts/jz/lib');
const { scan } = require('../scripts/jz/cleanup');
const { cleanupStaleRuntime } = require('../scripts/jz/repair-local');

// 夹具 base 必须 realpath 化（macOS /var 是系统链接，字面比较会误判）
const TMP = fs.realpathSync(os.tmpdir());

test('isPhysicallyRealPath：父级链接拒 / 正常路径过 / 不存在但父链真实则过', () => {
  const base = fs.mkdtempSync(path.join(TMP, 'jz-r6fn-'));
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-r6fn-out-'));
  fs.symlinkSync(outside, path.join(base, 'parent-link'), 'dir');
  assert.equal(isPhysicallyRealPath(path.join(base, 'parent-link', 'sub')), false, '父级链有链接必须拒');
  assert.equal(isPhysicallyRealPath(path.join(base, 'real-sub')), true, '不存在但父链真实 → 过');
  assert.equal(isPhysicallyRealPath(base), true, '真实目录 → 过');
});

test('P0-1 restore：目标 base 的父级是链接 → 条目 unsafe，绝不写外部', async () => {
  const root = fs.mkdtempSync(path.join(TMP, 'jz-r6a-'));
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-r6a-out-'));
  // root/parent-link → 外部；wbDir 配置在链接之下（base 本身不是链接，父级链是）
  fs.symlinkSync(outside, path.join(root, 'parent-link'), 'dir');
  const wbViaLink = path.join(root, 'parent-link', 'wb-root');
  fs.mkdirSync(wbViaLink, { recursive: true });
  fs.writeFileSync(path.join(wbViaLink, 'PRE-EXISTING.md'), 'KEEP'); // 预置非恢复内容

  const realWb = fs.mkdtempSync(path.join(TMP, 'jz-r6a-wb-'));
  fs.writeFileSync(path.join(realWb, 'IDENTITY.md'), 'SECRET');
  const b = createBackup({ scope: ['accounts'], reason: 't', root, wbDir: realWb });
  assert.equal(b.ok, true);

  const rr = await restoreBackup({ backupId: b.backupId, root, wbDir: wbViaLink, applyToReal: true });
  assert.equal(rr.restored, 0, `父级链接下条目不得写入，实际 ${rr.restored}`);
  assert.ok((rr.unsafeItems || []).length >= 1, '应记录 unsafe 原因');
  const written = fs.readdirSync(path.join(outside, 'wb-root'));
  assert.ok(!written.includes('IDENTITY.md'), `外部目录不得被写入，实际: ${written.join(',')}`);
  assert.ok(written.includes('PRE-EXISTING.md'), '预置文件不受影响');
});

test('P0-2 备份源：wbDir 父级链有链接 → createBackup 拒绝（外部文件不进保险箱）', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'jz-r6b-'));
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-r6b-out-'));
  fs.writeFileSync(path.join(outside, 'IDENTITY.md'), 'OUTSIDE-DATA');
  fs.symlinkSync(outside, path.join(root, 'parent-link'), 'dir');
  const wbViaLink = path.join(root, 'parent-link', 'wb-root');
  fs.mkdirSync(wbViaLink, { recursive: true });

  assert.throws(
    () => createBackup({ scope: ['accounts'], reason: 't', root, wbDir: wbViaLink }),
    /符号链接/,
    '备份源父级链接必须 fail-closed',
  );
});

test('P0-3 ensureDataRoot：root 父级链有链接 → 拒绝创建', () => {
  const base = fs.mkdtempSync(path.join(TMP, 'jz-r6c-'));
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-r6c-out-'));
  fs.symlinkSync(outside, path.join(base, 'parent-link'), 'dir');
  const fakeRoot = path.join(base, 'parent-link', 'data-root');
  assert.throws(() => ensureDataRoot(fakeRoot), /符号链接/, 'root 父级链接必须拒');
  // 外部不得被建出完整数据结构
  assert.ok(!fs.existsSync(path.join(outside, 'data-root', 'backups', 'manifests')), '外部不得创建 manifests');
});

test('P0-4 清理：runtime 是符号链接 → scan/cleanupStaleRuntime 拒绝，外部文件不删', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'jz-r6d-'));
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-r6d-out-'));
  fs.writeFileSync(path.join(outside, 'old-op.json'), '{}');
  fs.symlinkSync(outside, path.join(root, 'runtime'), 'dir');

  // scan：链接子目录被跳过（candidates 为空），不报整体失败但绝不读链接内容
  const s = scan({ root });
  assert.ok(s.candidates.every((c) => !String(c.path).includes('runtime')), '不得把链接 runtime 下的文件当候选项');
  const sApply = scan({ root: path.join(root, 'runtime') }); // 链接本身当 root → fail-closed
  assert.equal(sApply.ok, false, '链接当 root 必须整体拒绝');
  const c = cleanupStaleRuntime(root);
  assert.equal(c.ok, false, 'cleanupStaleRuntime 必须 fail-closed');
  assert.equal(c.error, 'RUNTIME_SYMLINK');
  assert.ok(fs.existsSync(path.join(outside, 'old-op.json')), '外部旧文件不得被删');
});
