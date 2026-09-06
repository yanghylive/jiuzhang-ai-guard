'use strict';
// 回归测试（指导 §5/§12）：路径边界——任意路径读写、目录穿越、符号链接、大小限制。
// 注意：本文件通过 env 收紧 IMPORT_MAX_BYTES（node --test 每文件独立进程，env 隔离有效）。
process.env.JZ_IMPORT_MAX_BYTES = '4096';
process.env.JZ_EXPORT_TTL_MS = String(15 * 60 * 1000);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createBackup,
  exportBackup,
  importBackup,
  resolveImportFile,
  readExportForDownload,
  stagingDir,
  exportsDir,
} = require('../scripts/jz/backup-vault');

function mkRoot() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-path-root-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-path-wb-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"light"}');
  return { root, wb };
}

test('导入文件名穿越/绝对路径/子目录/反斜杠 → 一律拒绝', () => {
  const { root, wb } = mkRoot();
  for (const bad of [
    '/etc/passwd',
    '/tmp/other-file',
    '../../outside.jzvault',
    'sub/dir.jzvault',
    'a\\b.jzvault',
    '..\\..\\win.jzvault',
    './relative.jzvault',
    '',
  ]) {
    const r = importBackup({ file: bad, sourceKind: 'staging', passphrase: 'pw', root });
    assert.equal(r.ok, false, `应拒绝: "${bad}"`);
    if (bad) assert.ok(['INVALID_REQUEST', 'IMPORT_FILE_NOT_FOUND'].includes(r.error), `错误码应明确: ${bad} → ${r.error}`);
  }
  void wb;
});

test('staging/exports 中的符号链接 → 拒绝（防任意文件读取）', () => {
  const { root, wb } = mkRoot();
  const st = stagingDir(root);
  fs.mkdirSync(st, { recursive: true });
  const outsideFile = path.join(fs.realpathSync(os.tmpdir()), `jz-outside-${Date.now()}.txt`);
  fs.writeFileSync(outsideFile, 'secret-outside');
  try {
    fs.symlinkSync(outsideFile, path.join(st, 'link.jzvault'));
    const r = importBackup({ file: 'link.jzvault', sourceKind: 'staging', passphrase: 'pw', root });
    assert.equal(r.ok, false, '符号链接必须拒绝');
    assert.equal(r.error, 'INVALID_REQUEST');

    // 导出产物被替换为符号链接 → 下载拒绝
    const b = createBackup({ scope: ['settings'], reason: 't', root, wbDir: wb });
    const ex = exportBackup({ backupId: b.backupId, passphrase: 'pw', root });
    assert.equal(ex.ok, true);
    const target = path.join(exportsDir(root), ex.file);
    fs.rmSync(target);
    fs.symlinkSync(outsideFile, target);
    const d = readExportForDownload({ exportId: ex.exportId, root });
    assert.equal(d.ok, false, '导出文件为符号链接时下载必须拒绝');
    assert.equal(d.error, 'EXPORT_NOT_FOUND');
  } finally {
    try { fs.rmSync(outsideFile, { force: true }); } catch {}
  }
});

test('导入文件大小超限 → IMPORT_TOO_LARGE（env 收紧到 4096 字节验证）', () => {
  const { root, wb } = mkRoot();
  const st = stagingDir(root);
  fs.mkdirSync(st, { recursive: true });
  // 合法 JZVAULT 头但体积超限
  const big = Buffer.alloc(8192, 0x41);
  big.write('JZVAULT\0', 0, 'latin1');
  fs.writeFileSync(path.join(st, 'big.jzvault'), big);
  const r = importBackup({ file: 'big.jzvault', sourceKind: 'staging', passphrase: 'pw', root });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'IMPORT_TOO_LARGE');

  // 边界内（2048 字节）不触发大小限制（会因内容损坏失败，但错误码不是 IMPORT_TOO_LARGE）
  const small = Buffer.alloc(2048, 0x41);
  small.write('JZVAULT\0', 0, 'latin1');
  fs.writeFileSync(path.join(st, 'small.jzvault'), small);
  const r2 = importBackup({ file: 'small.jzvault', sourceKind: 'staging', passphrase: 'pw', root });
  assert.notEqual(r2.error, 'IMPORT_TOO_LARGE');
});

test('resolveImportFile：受控目录外/目录路径/不存在 → 拒绝', () => {
  const { root, wb } = mkRoot();
  // 目录路径
  fs.mkdirSync(stagingDir(root), { recursive: true });
  const dir = resolveImportFile({ file: stagingDir(root).split('/').pop(), sourceKind: 'staging', root });
  // 传入 staging 目录名本身：basename 相同但不存在于 staging 内 → 拒绝
  assert.equal(dir.ok, false);

  const b = createBackup({ scope: ['settings'], reason: 't', root, wbDir: wb });
  const ex = exportBackup({ backupId: b.backupId, passphrase: 'pw', root });
  assert.equal(ex.ok, true);
  // 用 staging 声明读 exports 里的文件 → 拒绝（受控目录隔离）
  const r = resolveImportFile({ file: ex.file, sourceKind: 'staging', root });
  assert.equal(r.ok, false, 'staging 声明不得读到 exports 产物');
  // 正确声明可解析
  const ok = resolveImportFile({ file: ex.file, sourceKind: 'export', root });
  assert.equal(ok.ok, true);
});

test('下载接口：未知 exportId → EXPORT_NOT_FOUND', () => {
  const { root, wb } = mkRoot();
  const d = readExportForDownload({ exportId: 'not-exist-id', root });
  assert.equal(d.ok, false);
  assert.equal(d.error, 'EXPORT_NOT_FOUND');
  void wb;
});

test('backupId 校验（P1）：路径穿越 ID 被拒绝，不落盘不外读', () => {
  const { root, wb } = mkRoot();
  const b = createBackup({ scope: ['settings'], reason: 't', root, wbDir: wb });
  assert.equal(b.ok, true);
  const bv = require('../scripts/jz/backup-vault');
  // 正常 backupId 可解析
  assert.equal(bv.resolveBackupId(root, b.backupId), b.backupId);
  // 穿越 ID：路径分隔符/.. /绝对路径一律拒绝 → resolveBackupId 返回 null
  assert.equal(bv.resolveBackupId(root, '../../etc/passwd'), null, '穿越 backupId 必须拒绝');
  assert.equal(bv.resolveBackupId(root, '/etc/passwd'), null, '绝对路径 backupId 必须拒绝');
  assert.equal(bv.resolveBackupId(root, '..'), null);
  assert.equal(bv.resolveBackupId(root, 'a/b'), null);
  assert.equal(bv.resolveBackupId(root, ''), b.backupId, '空 backupId → 解析最近备份（合法路径）');
  // 越界 backupId 直接调 manifestPath 应抛错（fail-closed）
  assert.throws(() => bv.manifestPath(root, '../../x'), /非法 backupId/);
});
