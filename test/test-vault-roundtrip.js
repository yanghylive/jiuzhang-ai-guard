'use strict';
// 回归测试（指导 §5/§6/§12）：保险箱备份→导出→下载→导入→恢复完整往返。
// 真实临时目录 + 真实加密/blob 写入，不 mock fs。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createBackup,
  exportBackup,
  importBackup,
  restoreBackup,
  listBackups,
  readExportForDownload,
  resolveBackupId,
  stagingDir,
  exportsDir,
} = require('../scripts/jz/backup-vault');

function mkFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rt-root-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rt-wb-'));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ theme: 'dark', retention: 3 }));
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), '# ID-ORIGINAL\n');
  fs.writeFileSync(path.join(wb, 'USER.md'), '# USER-ORIGINAL\n');
  return { root, wb };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('完整往返：备份 → 导出 → 下载 → （模拟新机）staging 导入 → 恢复内容与原备份一致', async () => {
  const src = mkFixture();
  const r = createBackup({ scope: ['settings', 'accounts'], reason: 'test', root: src.root, wbDir: src.wb });
  assert.ok(r.ok !== false && r.backupId, `备份应成功: ${JSON.stringify(r)}`);

  // 导出（服务端受控目录，无 destination）
  const ex = exportBackup({ backupId: r.backupId, passphrase: 'pw1234', root: src.root });
  assert.equal(ex.ok, true);
  assert.ok(fs.existsSync(path.join(exportsDir(src.root), ex.file)), '导出文件必须在受控 exports/ 目录');

  // 下载（受保护下载接口层）
  const dl = readExportForDownload({ exportId: ex.exportId, root: src.root });
  assert.equal(dl.ok, true);
  const fileBuf = fs.readFileSync(dl.filePath);

  // 模拟新机：新数据根 + 新 WorkBuddy 目录，上传产物进 staging
  const dst = mkFixture();
  fs.mkdirSync(stagingDir(dst.root), { recursive: true });
  fs.writeFileSync(path.join(stagingDir(dst.root), 'imported.jzvault'), fileBuf);
  const im = importBackup({ file: 'imported.jzvault', sourceKind: 'staging', passphrase: 'pw1234', root: dst.root });
  assert.equal(im.ok, true, `导入应成功: ${JSON.stringify(im)}`);
  assert.equal(im.restoreReady, im.imported, '导入条目应全部可安全恢复');
  assert.equal(im.unsafeItems, undefined, '正常备份导入不应有不可恢复条目');

  // 元数据保留：scopeType/sourceRel 必须完整带入新 manifest
  const manifest = JSON.parse(fs.readFileSync(path.join(dst.root, 'backups', 'manifests', `${im.backupId}.json`), 'utf8'));
  for (const item of manifest.items) {
    assert.ok(item.scopeType, `item ${item.itemId} 缺 scopeType`);
    assert.ok(item.sourceRel, `item ${item.itemId} 缺 sourceRel`);
    assert.ok(['accounts', 'settings'].includes(item.scopeType), 'scopeType 必须在白名单内');
  }

  // 恢复到 restored/ 并逐项比对内容 hash
  const rr = await restoreBackup({ backupId: im.backupId, conflictPolicy: 'replace', root: dst.root });
  assert.equal(rr.ok, true);
  assert.equal(rr.restored, r.manifest.items.length, '恢复条目数应与原备份一致');
  for (const item of manifest.items) {
    const restoredPath = path.join(dst.root, 'restored', item.sourceRel);
    assert.ok(fs.existsSync(restoredPath), `恢复后应存在 ${item.sourceRel}`);
    const origPath = item.scopeType === 'settings'
      ? path.join(src.root, item.sourceRel)
      : path.join(src.wb, item.sourceRel);
    assert.equal(sha256(fs.readFileSync(restoredPath)), sha256(fs.readFileSync(origPath)), `${item.sourceRel} 内容 hash 应一致`);
  }
});

test('空 backupId 导出解析为最近一次备份；没有任何备份返回 NO_BACKUP', () => {
  const { root, wb } = mkFixture();
  // 无备份 → NO_BACKUP
  const none = exportBackup({ passphrase: 'pw', root });
  assert.equal(none.ok, false);
  assert.equal(none.error, 'NO_BACKUP');

  const older = createBackup({ scope: ['settings'], reason: 'older', root, wbDir: wb });
  // 保证 createdAt 严格更晚
  const newerManifestPath = path.join(root, 'backups', 'manifests');
  const newer = createBackup({ scope: ['settings'], reason: 'newer', root, wbDir: wb });
  assert.ok(older.backupId && newer.backupId);
  const m = JSON.parse(fs.readFileSync(path.join(newerManifestPath, `${newer.backupId}.json`), 'utf8'));
  m.createdAt = new Date(Date.now() + 60000).toISOString();
  fs.writeFileSync(path.join(newerManifestPath, `${newer.backupId}.json`), JSON.stringify(m));

  assert.equal(resolveBackupId(root), newer.backupId, '空 backupId 应解析为最新备份');
  const ex = exportBackup({ backupId: '', passphrase: 'pw', root });
  assert.equal(ex.ok, true);
  assert.equal(ex.backupId, newer.backupId);
});

test('下载策略：过期与超次拒绝，过期产物被清理', async () => {
  const { root, wb } = mkFixture();
  const r = createBackup({ scope: ['settings'], reason: 'test', root, wbDir: wb });
  const ex = exportBackup({ backupId: r.backupId, passphrase: 'pw', root });
  assert.equal(ex.ok, true);

  // 重复下载至超过上限（EXPORT_MAX_DOWNLOADS 默认 3）
  for (let i = 0; i < 3; i++) {
    const d = readExportForDownload({ exportId: ex.exportId, root });
    assert.equal(d.ok, true, `第 ${i + 1} 次下载应成功`);
  }
  const over = readExportForDownload({ exportId: ex.exportId, root });
  assert.equal(over.ok, false);
  assert.equal(over.error, 'EXPORT_DOWNLOADS_EXCEEDED');

  // 过期：手工把 expiresAt 改到过去，再次读取必须 EXPORT_EXPIRED 且产物被清理
  const ex2 = exportBackup({ backupId: r.backupId, passphrase: 'pw', root });
  assert.equal(ex2.ok, true);
  const idxPath = path.join(exportsDir(root), 'index.json');
  const idx2 = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const entry = idx2.entries.find((e) => e.exportId === ex2.exportId);
  entry.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(idxPath, JSON.stringify(idx2));

  const expired = readExportForDownload({ exportId: ex2.exportId, root });
  assert.equal(expired.ok, false);
  assert.equal(expired.error, 'EXPORT_EXPIRED');
  // 惰性清理后：文件已删除、索引已移除
  assert.ok(!fs.existsSync(path.join(exportsDir(root), ex2.file)), '过期文件应被清理');
  const idx3 = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  assert.ok(!idx3.entries.some((e) => e.exportId === ex2.exportId), '过期产物应从索引清除');
});

test('旧格式（缺 scopeType/sourceRel）导入：标记不可恢复，绝不猜路径', () => {
  const { root, wb } = mkFixture();
  const r = createBackup({ scope: ['settings', 'accounts'], reason: 'test', root, wbDir: wb });
  const ex = exportBackup({ backupId: r.backupId, passphrase: 'pw', root });
  assert.equal(ex.ok, true);
  const fileBuf = fs.readFileSync(path.join(exportsDir(root), ex.file));

  const dst = mkFixture();
  fs.mkdirSync(stagingDir(dst.root), { recursive: true });
  fs.writeFileSync(path.join(stagingDir(dst.root), 'legacy.jzvault'), fileBuf);
  const im = importBackup({ file: 'legacy.jzvault', sourceKind: 'staging', passphrase: 'pw', root: dst.root });
  assert.equal(im.ok, true);

  // 人为抹掉元数据（模拟旧 schema 备份）
  const manifestPath = path.join(dst.root, 'backups', 'manifests', `${im.backupId}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const item of manifest.items) {
    delete item.scopeType;
    delete item.sourceRel;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  // 恢复：unsafe 条目全部跳过，绝不写入猜测路径
  return (async () => {
    const rr = await restoreBackup({ backupId: im.backupId, conflictPolicy: 'replace', root: dst.root });
    assert.equal(rr.ok, true);
    assert.equal(rr.restored, 0, '缺元数据条目不得恢复');
    assert.equal(rr.skippedUnsafe, manifest.items.length, '应全部标记为不可安全恢复');
    assert.ok(rr.unsafeItems && rr.unsafeItems.length, '应报告 unsafe 条目');
    // 原数据未被覆盖
    assert.equal(fs.readFileSync(path.join(dst.wb, 'IDENTITY.md'), 'utf8'), '# ID-ORIGINAL\n');
  })();
});

test('导入即校验：payload 内容 hash 与清单不符 → 整体失败（fail-closed）', () => {
  const { root, wb } = mkFixture();
  const r = createBackup({ scope: ['settings'], reason: 'test', root, wbDir: wb });
  const ex = exportBackup({ backupId: r.backupId, passphrase: 'pw', root });
  const fileBuf = fs.readFileSync(path.join(exportsDir(root), ex.file));

  // 篡改 payload 最后 1 字节（GCM 会先在解密层失败；此处主要验证密文被改后导入必须失败）
  const tampered = Buffer.from(fileBuf);
  tampered[tampered.length - 1] ^= 0xff;
  const dst = mkFixture();
  fs.mkdirSync(stagingDir(dst.root), { recursive: true });
  fs.writeFileSync(path.join(stagingDir(dst.root), 'tampered.jzvault'), tampered);
  const im = importBackup({ file: 'tampered.jzvault', sourceKind: 'staging', passphrase: 'pw', root: dst.root });
  assert.equal(im.ok, false);
  assert.equal(im.error, 'BACKUP_CORRUPTED');
});

test('导入成功后 staging 文件清理；listBackups 含导入备份', () => {
  const { root, wb } = mkFixture();
  const r = createBackup({ scope: ['settings'], reason: 'test', root, wbDir: wb });
  const ex = exportBackup({ backupId: r.backupId, passphrase: 'pw', root });
  const fileBuf = fs.readFileSync(path.join(exportsDir(root), ex.file));
  const dst = mkFixture();
  fs.mkdirSync(stagingDir(dst.root), { recursive: true });
  fs.writeFileSync(path.join(stagingDir(dst.root), 'one.jzvault'), fileBuf);
  const im = importBackup({ file: 'one.jzvault', sourceKind: 'staging', passphrase: 'pw', root: dst.root });
  assert.equal(im.ok, true);
  assert.ok(!fs.existsSync(path.join(stagingDir(dst.root), 'one.jzvault')), 'staging 文件导入成功后应清理');
  assert.ok(listBackups(dst.root).some((b) => b.backupId === im.backupId));
});
