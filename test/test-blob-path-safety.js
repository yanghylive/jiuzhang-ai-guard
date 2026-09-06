'use strict';
// 2026-08-30 复核 P2 回归：manifest relativePath 读取侧统一 safeRel 校验。
// 恶意/损坏 manifest 携带 ../ 的 relativePath，读取侧不得逃出 blobs 目录。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeBlobPath, verifyBackup } = require('../scripts/jz/backup-vault');
test('safeBlobPath：../ 与绝对路径一律拒绝，正常相对路径放行', () => {
  const blobsDir = '/data/backups/blobs/bid';
  assert.equal(safeBlobPath(blobsDir, '../../etc/passwd'), null, '.. 逃逸必须拒绝');
  assert.equal(safeBlobPath(blobsDir, '..\\..\\win.ini'), null, '反斜杠逃逸必须拒绝');
  assert.equal(safeBlobPath(blobsDir, '/etc/passwd'), null, '绝对路径必须拒绝');
  assert.equal(safeBlobPath(blobsDir, ''), null, '空路径必须拒绝');
  assert.equal(safeBlobPath(blobsDir, undefined), null, 'undefined 必须拒绝');
  assert.equal(safeBlobPath(blobsDir, 'item-uuid.bin'), path.join(blobsDir, 'item-uuid.bin'), '正常路径放行');
  assert.equal(safeBlobPath(blobsDir, 'sub/dir/item.bin'), path.join(blobsDir, 'sub/dir/item.bin'), '子目录放行');
});

test('verifyBackup：manifest 含 ../ relativePath → BACKUP_CORRUPTED（不读出 blobs 目录）', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rel-'));
  const backupId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const blobsDir = path.join(root, 'backups', 'blobs', backupId);
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'backups', 'manifests'), { recursive: true });
  // 目标外敏感文件
  const secretPath = path.join(root, 'secret.txt');
  fs.writeFileSync(secretPath, 'TOP-SECRET');
  // 恶意 manifest：relativePath 指向 blobs 目录之外
  const manifest = {
    backupId,
    createdAt: new Date().toISOString(),
    schemaVersion: 2,
    integrity: 'verified',
    items: [{ itemId: 'i1', type: 'settings', relativePath: '../../secret.txt', size: 10, sha256: 'x', encrypted: true }],
  };
  fs.writeFileSync(
    path.join(root, 'backups', 'manifests', backupId + '.json'),
    JSON.stringify(manifest),
  );
  const r = verifyBackup({ backupId, root });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BACKUP_CORRUPTED');
  assert.equal(r.reason, 'unsafe_relative_path', '必须因路径非法拒绝，而不是读出 secret');
  // 敏感文件内容确实没被读走（函数返回失败而非数据）
  assert.ok(fs.existsSync(secretPath), 'secret 文件不应被删除或改动');
});
