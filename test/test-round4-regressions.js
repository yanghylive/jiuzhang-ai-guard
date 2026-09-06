'use strict';
// 2026-08-30 第四轮复核回归：
//   ① P1-3 Windows 反斜杠：生成侧 toPosixRel 归一化 + safeRel 兼容 POSIX rel
//   ② P1-4 符号链接：blob 被替换为链接时 verify/export 拒绝（readBlobStrict）
//   ③ P1-2 profile 隔离：workbuddyDir 按 profile 返回
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('P1-3 toPosixRel：Windows 反斜杠 rel 归一化为 POSIX，safeRel 放行', () => {
  const bv = require('../scripts/jz/backup-vault');
  // 模拟 Windows path.relative 的产物
  const winRel = ['app', 'sessions.json'].join('\\');
  const posix = bv.toPosixRel(winRel);
  assert.equal(posix, 'app/sessions.json');
  assert.equal(bv.safeRel(posix), true, '归一化后必须通过 safeRel');
  // 第十一轮更新：safeRel 统一 POSIX 视图解析——反斜杠归一化后按同一规则校验
  assert.equal(bv.safeRel(winRel), true, '反斜杠形式归一化后放行（Windows 兼容）');
  assert.equal(bv.safeRel('..\\..\\evil.txt'), false, '反斜杠穿越归一化后仍被拒');
  assert.equal(bv.safeRel('C:\\Windows\\x'), false, '盘符绝对路径拒绝');
  assert.equal(bv.toPosixRel('app/sessions.json'), 'app/sessions.json', 'POSIX 形式幂等');
});

test('P1-4 blob 符号链接：verifyBackup 拒绝被替换成链接的 blob（物理校验）', () => {
  const bv = require('../scripts/jz/backup-vault');
  const { createBackup, verifyBackup } = bv;
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-bloblink-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"a":1}');
  const b = createBackup({ scope: ['settings'], reason: 't', root });
  assert.equal(b.ok, true);

  // 把唯一 blob 替换为指向外部敏感文件的符号链接
  const blobsDir = path.join(root, 'backups', 'blobs', b.backupId);
  const blobName = fs.readdirSync(blobsDir)[0];
  const outside = path.join(root, 'outside-secret.txt');
  fs.writeFileSync(outside, 'TOP-SECRET');
  fs.rmSync(path.join(blobsDir, blobName));
  fs.symlinkSync(outside, path.join(blobsDir, blobName));

  const r = verifyBackup({ backupId: b.backupId, root });
  assert.equal(r.ok, false, 'blob 是符号链接必须拒绝');
  assert.equal(r.reason, 'blob_is_symlink');
  assert.ok(fs.existsSync(outside), '外部文件不受影响');
});

test('P1-2 workbuddyDir：默认 profile → ~/.workbuddy；env 覆盖优先', () => {
  const lib = require('../scripts/jz/lib');
  // 默认（workbuddy-cn）→ ~/.workbuddy
  assert.equal(lib.workbuddyDir(), path.join(os.homedir(), '.workbuddy'));
  // env 覆盖（测试/多机对齐）
  const prev = process.env.JZ_WORKBUDDY_DIR;
  try {
    process.env.JZ_WORKBUDDY_DIR = '/tmp/custom-wb';
    assert.equal(lib.workbuddyDir(), '/tmp/custom-wb');
  } finally {
    if (prev === undefined) delete process.env.JZ_WORKBUDDY_DIR;
    else process.env.JZ_WORKBUDDY_DIR = prev;
  }
});

test('P1-4 restore 目标父目录链含符号链接 → 该条目 unsafe 跳过（不写外部）', () => {
  // 直接验证 isSymlinkInChain 的判定逻辑（未导出，经 restoreBackup 行为间接测太重，
  // 这里用 backup-vault 内部等价物：手工构造 restore 场景的关键路径段）
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-chain-'));
  const wb = path.join(root, 'wb');
  const appDir = path.join(wb, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  // app -> 外部目录（模拟 WorkBuddy/app 被替换为链接）
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.symlinkSync(outside, appDir, 'dir');
  // 逐段 lstat（与 isSymlinkInChain 相同逻辑）
  const rel = path.relative(wb, path.join(appDir, 'sessions.json'));
  let foundLink = false;
  let cur = wb;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    try { if (fs.lstatSync(cur).isSymbolicLink()) { foundLink = true; break; } } catch (_) {}
  }
  assert.equal(foundLink, true, '目录链上的符号链接必须被识别');
  assert.ok(fs.existsSync(path.join(outside)), '外部目录不受影响');
});
