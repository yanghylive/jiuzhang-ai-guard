'use strict';
// 2026-08-30 复核 P1/P0 回归：JZVAULT 导入的健壮性。
//   ① P0：空密码/缺密码必须 fail-closed（旧实现把 undefined 传给 KDF → 字符串 "undefined" 当密码）
//   ② P1：写入阶段失败必须清理 blobs 目录，不留孤立半成品
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createBackup, exportBackup, importBackup, dataRoot, blobsRoot,
} = require('../scripts/jz/backup-vault');

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-imp-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  return root;
}

function makeExport(root) {
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"dark"}');
  const b = createBackup({ scope: ['settings'], reason: 't', root });
  assert.equal(b.ok, true);
  const ex = exportBackup({ backupId: b.backupId, passphrase: 'pw-123456', root });
  assert.equal(ex.ok, true);
  return ex;
}

test('P0 导入空密码 fail-closed：undefined / 空串 / 非字符串一律拒绝', () => {
  const root = tmpRoot();
  const ex = makeExport(root);
  for (const bad of [undefined, '', null, 123]) {
    const r = importBackup({ file: ex.file, sourceKind: 'export', passphrase: bad, root });
    assert.equal(r.ok, false, `passphrase=${String(bad)} 必须拒绝`);
    assert.equal(r.error, 'IMPORT_PASSPHRASE_REQUIRED');
  }
  // 正确密码仍可导入（证明不是无脑拒绝）
  const ok = importBackup({ file: ex.file, sourceKind: 'export', passphrase: 'pw-123456', root });
  assert.equal(ok.ok, true, '正确密码应导入成功');
});

test('P0 KDF 拒绝空密码：deriveKeyFromPassphrase 对非字符串抛错', () => {
  const { deriveKeyFromPassphrase } = require('../scripts/jz/crypto-vault');
  const salt = Buffer.alloc(16, 1);
  assert.throws(() => deriveKeyFromPassphrase(undefined, salt), /非空字符串密码/);
  assert.throws(() => deriveKeyFromPassphrase('', salt), /非空字符串密码/);
  assert.throws(() => deriveKeyFromPassphrase(null, salt), /非空字符串密码/);
  // 合法密码可用
  assert.equal(deriveKeyFromPassphrase('pw', salt).length, 32);
});

test('P1 导入写入失败清理：写入抛错时 blobs 目录不残留', () => {
  const root = tmpRoot();
  const ex = makeExport(root);
  const blobsBase = path.join(root, 'backups', 'blobs');
  const before = fs.existsSync(blobsBase) ? fs.readdirSync(blobsBase).length : 0;

  // 注入失败：把 blobs 根目录变成只读，制造写入异常（磁盘满/权限失败同路径）
  const origWriteFileSync = fs.writeFileSync;
  let restored = false;
  try {
    fs.writeFileSync = function patched(p, ...rest) {
      if (typeof p === 'string' && p.includes(path.join('backups', 'blobs'))) {
        const err = new Error('ENOSPC: no space left on device');
        throw err;
      }
      return origWriteFileSync.call(fs, p, ...rest);
    };
    const r = importBackup({ file: ex.file, sourceKind: 'export', passphrase: 'pw-123456', root });
    assert.equal(r.ok, false, '写入失败应返回失败');
    assert.equal(r.error, 'IMPORT_WRITE_FAILED');
  } finally {
    fs.writeFileSync = origWriteFileSync;
    restored = true;
  }
  assert.equal(restored, true);
  // 关键断言：失败后不得留下孤立 blobs 目录
  const after = fs.existsSync(blobsBase) ? fs.readdirSync(blobsBase).length : 0;
  assert.equal(after, before, `blobs 目录数应恢复（before=${before} after=${after}），不得残留半成品`);
});
