'use strict';
// 2026-08-30 第五轮复核回归：
//   P0-1 restore 目标根目录本身是符号链接 → 条目 unsafe 跳过（不写外部）
//   P0-2 ensureDirs 先查 accounts 链接再迁移（迁移绝不先写外部）
//   P1-5 enforceRetention 恶意 backupId 不得穿越删除
//   P2-9 旧 Windows 备份（sourceRel 含 \）恢复兼容
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackup, restoreBackup, verifyBackup, listBackups } = require('../scripts/jz/backup-vault');
const { ensureDirs } = require('../scripts/lib');

test('P0-1 restore：wbDir 根本身是符号链接 → 条目全部 unsafe，绝不写外部', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r5a-'));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r5-out-'));
  const fakeWb = path.join(root, 'wb-link');
  fs.symlinkSync(outside, fakeWb, 'dir');
  // 构造备份（用真实目录备份再换 wbDir 为链接）
  const realWb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r5-wb-'));
  fs.writeFileSync(path.join(realWb, 'IDENTITY.md'), 'SECRET-ACCOUNT-DATA');
  const b = createBackup({ scope: ['accounts'], reason: 't', root, wbDir: realWb });
  assert.equal(b.ok, true);

  const rr = await restoreBackup({ backupId: b.backupId, root, wbDir: fakeWb, applyToReal: true });
  assert.equal(rr.ok, true, 'restore 本身不失败（fail-closed 到条目级跳过）');
  assert.equal(rr.restored, 0, '条目不得写入');
  assert.ok((rr.unsafeItems || []).every((u) => /symlink/.test(u.reason)), `应记录 symlink 原因: ${JSON.stringify(rr.unsafeItems)}`);
  // 外部目录绝不能被写入备份内容
  const outsideFiles = fs.readdirSync(outside);
  assert.equal(outsideFiles.length, 0, `外部目录必须为空，实际: ${outsideFiles.join(',')}`);
});

test('P0-2 ensureDirs：accounts 是符号链接时抛错且不迁移（迁移不先写外部）', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r5b-'));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r5b-out-'));
  // 旧版遗留数据（会被 migrateLegacyDataDir 迁移）
  const legacyAcc = path.join(root, 'accounts');
  fs.mkdirSync(legacyAcc, { recursive: true });
  fs.writeFileSync(path.join(legacyAcc, 'u1.info'), '{"uid":"u1"}');
  // 把新 accounts 目录做成指向外部的链接
  const accDir = path.join(root, 'accounts');
  fs.rmSync(accDir, { recursive: true, force: true });
  fs.symlinkSync(outside, accDir, 'dir');

  assert.throws(() => ensureDirs(root), /符号链接/, 'ensureDirs 必须 fail-closed 抛错');
  assert.equal(fs.readdirSync(outside).length, 0, '外部目录不得被写入');
});

test('P1-5 enforceRetention：恶意 backupId（路径穿越）被跳过不删除', () => {
  // 直接验证 listBackups 对损坏 manifest 的过滤 + assertSafeBackupId 行为
  const bv = require('../scripts/jz/backup-vault');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r5c-'));
  const manifests = path.join(root, 'backups', 'manifests');
  fs.mkdirSync(manifests, { recursive: true });
  // 恶意 manifest：backupId 带穿越
  fs.writeFileSync(path.join(manifests, 'evil.json'), JSON.stringify({
    backupId: '../../outside-victim',
    items: [{ itemId: 'x', type: 'settings', relativePath: 'a.bin', size: 0, sha256: 'x', encrypted: true, scopeType: 'settings' }],
  }));
  const list = listBackups(root);
  assert.equal(list.length, 0, '恶意 manifest 不得进列表（保护 enforceRetention）');
  assert.equal(bv.assertSafeBackupId('../../outside-victim'), null, '穿越 id 必须被白名单拒绝');
});

test('P2-9 旧 Windows 备份（sourceRel 含反斜杠）恢复兼容', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r5d-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r5d-wb-'));
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), 'OLD');
  fs.mkdirSync(path.join(wb, 'app'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'app', 'sessions.json'), '[{"id":"s1"}]');
  const b = createBackup({ scope: ['accounts', 'sessions'], reason: 't', root, wbDir: wb });
  assert.equal(b.ok, true);
  // 手工把 manifest 改成旧 Windows 格式（sourceRel 反斜杠）
  const mfPath = path.join(root, 'backups', 'manifests', b.backupId + '.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  for (const it of mf.items) it.sourceRel = it.sourceRel.replace(/\//g, '\\');
  fs.writeFileSync(mfPath, JSON.stringify(mf));

  const rr = await restoreBackup({ backupId: b.backupId, root });
  assert.equal(rr.ok, true);
  assert.equal(rr.restored, 2, `旧反斜杠格式条目必须全部恢复（POSIX 归一化兼容），实际 ${rr.restored}`);
  const restored = path.join(root, 'restored');
  assert.ok(fs.existsSync(path.join(restored, 'app', 'sessions.json')), '嵌套文件按 POSIX 结构落盘');
});

test('P2-10 损坏 manifest：verifyBackup 稳定返回 BACKUP_CORRUPTED（不抛 500）', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-r5e-'));
  const manifests = path.join(root, 'backups', 'manifests');
  fs.mkdirSync(manifests, { recursive: true });
  fs.writeFileSync(path.join(manifests, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json'), JSON.stringify({ backupId: 'x', note: 'no items' }));
  const r = verifyBackup({ backupId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', root });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BACKUP_CORRUPTED');
});
