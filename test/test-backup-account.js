'use strict';
// G2 账号备份/恢复全链路：accounts/sessions 作用域映射真实 WorkBuddy 数据目录（临时 wbDir 单测）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackup, verifyBackup, restoreBackup, importBackup } = require('../scripts/jz/backup-vault');

test('accounts/sessions 映射 WorkBuddy 数据（不含登录 token）+ 加密无明文', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-root-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-dir-'));
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), '# identity');
  fs.writeFileSync(path.join(wb, 'USER.md'), '# user');
  fs.mkdirSync(path.join(wb, 'app'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'app', 'sessions.json'), '[{"id":"s1"}]');
  fs.writeFileSync(path.join(wb, 'app', 'app-config.json'), '{}');
  // 模拟敏感登录态（绝不应入备份）
  fs.mkdirSync(path.join(wb, 'app', 'session'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'app', 'session', 'Cookies'), 'cookie=secret');
  fs.mkdirSync(path.join(wb, 'connector-keys'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'connector-keys', 'x.key'), 'KEY-SECRET');

  const r = createBackup({ scope: ['accounts', 'sessions'], reason: 'test', root, wbDir: wb });
  assert.ok(r.backupId);
  // 只备份 IDENTITY/USER/app-config.json/sessions.json 4 个，不碰 Cookies/connector-keys
  assert.equal(r.manifest.items.length, 4, `应只备份 4 个身份文件，实际 ${r.manifest.items.length}`);

  // blob 全加密，无任何明文（含敏感与身份内容）
  const blobDir = path.join(root, 'backups', 'blobs', r.backupId);
  for (const f of fs.readdirSync(blobDir)) {
    const buf = fs.readFileSync(path.join(blobDir, f));
    assert.ok(!buf.includes(Buffer.from('# identity')), 'blob 不得含明文身份内容');
    assert.ok(!buf.includes(Buffer.from('cookie=secret')), 'blob 不得含明文 cookie');
  }
  assert.equal(verifyBackup({ backupId: r.backupId, root }).ok, true);
});

test('恢复 accounts 数据：解密后内容还原，且不覆盖原文件', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-root2-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-dir2-'));
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), 'ORIGINAL-CONTENT');
  fs.mkdirSync(path.join(wb, 'app'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'app', 'sessions.json'), '[{"id":"s1"}]');

  const r = createBackup({ scope: ['accounts', 'sessions'], reason: 'test', root, wbDir: wb });
  // 模拟数据变化（原文件被改）
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), 'CHANGED');

  const rr = await restoreBackup({ backupId: r.backupId, root });
  assert.equal(rr.ok, true);

  // 恢复到 restored/（不覆盖原文件）
  const restoredDir = path.join(root, 'restored');
  const contents = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else contents.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(restoredDir);
  assert.ok(contents.includes('ORIGINAL-CONTENT'), '恢复数据应含备份时的原始内容');
  assert.equal(fs.readFileSync(path.join(wb, 'IDENTITY.md'), 'utf8'), 'CHANGED', '恢复不覆盖当前文件');
});

test('sessions 备份：只进白名单文件，blob_storage 等敏感内容绝不打包（复查 P1）', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-root3-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-dir3-'));
  // 构造会话内容目录（模拟 blob_storage 含嵌套文件——可能含 Cookie/会话正文）
  const blob = path.join(wb, 'app', 'session', 'blob_storage');
  fs.mkdirSync(path.join(blob, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(blob, 'a.bin'), 'SENSITIVE-BLOB-A');
  fs.writeFileSync(path.join(blob, 'sub', 'b.bin'), 'SENSITIVE-BLOB-B');
  fs.mkdirSync(path.join(wb, 'app', 'session', 'shared_proto_db'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'app', 'session', 'shared_proto_db', 'db.bin'), 'SENSITIVE-PROTO');
  fs.mkdirSync(path.join(wb, 'app'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'app', 'sessions.json'), '[{"id":"s1"}]');

  const r = createBackup({ scope: ['sessions'], reason: 'test', root, wbDir: wb });
  assert.ok(r.backupId);
  // 白名单：只有 app/sessions.json 进备份
  assert.equal(r.manifest.items.length, 1, `应只备份 1 项（sessions.json），实际 ${r.manifest.items.length}`);
  // sourceRel 统一 POSIX 分隔（跨平台一致，Windows 上 path.join 会产出反斜杠故硬编码）
  assert.equal(r.manifest.items[0].sourceRel, 'app/sessions.json');
  const manifestJson = JSON.stringify(r.manifest);
  assert.ok(!manifestJson.includes('blob_storage'), 'manifest 不得出现 blob_storage');
  assert.ok(!manifestJson.includes('shared_proto_db'), 'manifest 不得出现 shared_proto_db');

  const rr = await restoreBackup({ backupId: r.backupId, root });
  assert.equal(rr.ok, true);
  assert.ok(fs.existsSync(path.join(root, 'restored', 'app', 'sessions.json')), '白名单文件应被恢复');
  assert.ok(!fs.existsSync(path.join(root, 'restored', 'app', 'session')), '敏感会话目录不得被恢复');
  const restoredFiles = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const full = path.join(d, f.name); if (f.isDirectory()) walk(full); else restoredFiles.push(full); } })(path.join(root, 'restored'));
  const restoredText = restoredFiles.map((f) => fs.readFileSync(f, 'utf8')).join('');
  assert.ok(!restoredText.includes('SENSITIVE'), '敏感内容不得出现在备份/恢复产物中');
});

test('JZVAULT 截断/损坏文件拒绝导入（不越界、不挂死）', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-root4-'));
  const staging = require('../scripts/jz/backup-vault').stagingDir(root);
  fs.mkdirSync(staging, { recursive: true });
  // 场景 1：只有 header + meta 无终止 0x00（截断）——旧代码 `while(buf[i]!==0)` 会越界挂死
  const truncated = Buffer.concat([Buffer.from('JZVAULT\0'), Buffer.from('{"formatVersion":1}')]);
  fs.writeFileSync(path.join(staging, 'truncated.jzvault'), truncated);
  const r1 = importBackup({ file: 'truncated.jzvault', sourceKind: 'staging', passphrase: 'p', root });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'BACKUP_CORRUPTED');

  // 场景 2：header 后直接截断（meta 长度不足）——_rdU32 越界场景
  fs.writeFileSync(path.join(staging, 'short.jzvault'), Buffer.from('JZVAULT\0'));
  const r2 = importBackup({ file: 'short.jzvault', sourceKind: 'staging', passphrase: 'p', root });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'BACKUP_CORRUPTED');

  // 场景 3：错误 magic
  fs.writeFileSync(path.join(staging, 'badmagic.jzvault'), Buffer.from('NOTA-JZVAULT-FILE-DATA'));
  const r3 = importBackup({ file: 'badmagic.jzvault', sourceKind: 'staging', passphrase: 'p', root });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'BACKUP_CORRUPTED');

  // 场景 4（2026-08-29 新增）：任意路径/穿越文件名一律拒绝，不接受 source 任意本机路径
  for (const bad of ['/etc/passwd', '../outside.jzvault', 'sub/dir.jzvault']) {
    const r4 = importBackup({ file: bad, sourceKind: 'staging', passphrase: 'p', root });
    assert.equal(r4.ok, false, `应拒绝: ${bad}`);
  }
});

test('applyToReal 真实落盘：settings→数据根，accounts→WorkBuddy 目录，keep-current 不覆盖', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-root5-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-dir5-'));
  // 备份时内容
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"light"}');
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), '# ORIGINAL');
  fs.mkdirSync(path.join(wb, 'app'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'app', 'sessions.json'), '[{"id":"s1"}]');
  const r = createBackup({ scope: ['settings', 'accounts', 'sessions'], reason: 'test', root, wbDir: wb });
  assert.ok(r.backupId);

  // 恢复前篡改目标（模拟真实使用中的文件）
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), '# CHANGED');

  const rr = await restoreBackup({ backupId: r.backupId, applyToReal: true, root, wbDir: wb, conflictPolicy: 'keep-current' });
  assert.equal(rr.ok, true);
  assert.equal(rr.mode, 'apply');
  assert.ok(rr.snapshotId);

  // keep-current：settings.json 内容不同 → 跳过不覆盖（保护正在使用的文件）
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{"theme":"dark"}', 'keep-current 不得覆盖内容不同的目标');
  // IDENTITY.md 同样被改 → 跳过
  assert.equal(fs.readFileSync(path.join(wb, 'IDENTITY.md'), 'utf8'), '# CHANGED');
  // 未变的目标（sessions.json）→ 恢复（内容相同，写幂等）
  assert.equal(fs.readFileSync(path.join(wb, 'app', 'sessions.json'), 'utf8'), '[{"id":"s1"}]');

  // 快照目录记录恢复前目标内容
  const snapSettings = path.join(rr.snapshotDir, 'settings.json');
  assert.equal(fs.readFileSync(snapSettings, 'utf8'), '{"theme":"dark"}', '快照应含恢复前 settings.json');
  const snapIdentity = path.join(rr.snapshotDir, 'IDENTITY.md');
  assert.equal(fs.readFileSync(snapIdentity, 'utf8'), '# CHANGED', '快照应含恢复前 IDENTITY.md');
});

test('applyToReal + replace：备份内容原子替换目标（temp+fsync+rename）', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-root6-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wb-dir6-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"light"}');
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), '# ORIGINAL');
  const r = createBackup({ scope: ['settings', 'accounts'], reason: 'test', root, wbDir: wb });
  assert.ok(r.backupId);

  // 篡改目标
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), '# CHANGED');

  const rr = await restoreBackup({ backupId: r.backupId, applyToReal: true, root, wbDir: wb, conflictPolicy: 'replace' });
  assert.equal(rr.ok, true);
  // replace 策略：备份内容覆盖目标
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{"theme":"light"}');
  assert.equal(fs.readFileSync(path.join(wb, 'IDENTITY.md'), 'utf8'), '# ORIGINAL');
  // 无残留 tmp 文件
  const leftovers = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.includes('.jzrestore-') || f.endsWith('.tmp')) leftovers.push(f);
    }
  };
  walk(path.join(wb));
  assert.equal(leftovers.length, 0, '不应残留 tmp 文件: ' + leftovers.join(','));
});

test('createBackup 磁盘空间不足（06-D62）：拒绝写入，不留半截备份', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createBackup } = require('../scripts/jz/backup-vault');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-disk-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-disk-wb-'));
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), 'test-account-data-for-disk-check');
  fs.mkdirSync(path.join(root, 'backups', 'manifests'), { recursive: true });

  // 场景 1：磁盘空间极小（1KB）→ 拒绝
  const r1 = createBackup({ scope: ['accounts'], reason: 'test', root, wbDir: wb, _diskFree: 1024 });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'INSUFFICIENT_DISK_SPACE');
  assert.ok(r1.free <= 1024, 'free 应 ≤ 1024');
  assert.ok(!r1.backupId, '失败时不应返回 backupId');
  // 半截备份目录不应存在（或为空）
  const blobsDir = path.join(root, 'backups', 'blobs');
  const entries = fs.existsSync(blobsDir) ? fs.readdirSync(blobsDir) : [];
  assert.equal(entries.length, 0, '磁盘不足时不应留下备份目录');

  // 场景 2：磁盘空间充足 → 正常备份
  const r2 = createBackup({ scope: ['accounts'], reason: 'test', root, wbDir: wb, _diskFree: 10 * 1024 * 1024 * 1024 });
  assert.ok(r2.backupId, '磁盘充足应成功: ' + JSON.stringify(r2));
  assert.equal(r2.manifest.integrity, 'verified');

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(wb, { recursive: true, force: true });
});

test('恢复进度标记（06-D59）：applyToReal 写进行中标记 → 成功清除并留审计；中断则 pending', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { getRestoreProgress } = require('../scripts/jz/restore-progress');
  const { createBackup, previewRestore, restoreBackup } = require('../scripts/jz/backup-vault');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rp-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rp-wb-'));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ schemaVersion: 1, theme: 'dark' }));
  fs.mkdirSync(path.join(wb), { recursive: true });

  // 初始：无 pending
  assert.equal(getRestoreProgress(root).pending, false);

  // 备份 → 篡改目标 → replace 恢复（走 applyToReal 全链路）
  const b = createBackup({ scope: ['settings'], reason: 'test', root, wbDir: wb });
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ schemaVersion: 1, theme: 'broken' }));
  const pv = await previewRestore({ backupId: b.backupId, root });
  assert.ok(pv.ok, JSON.stringify(pv));
  const r = await restoreBackup({
    backupId: b.backupId, root, applyToReal: true, conflictPolicy: 'replace', previewId: pv.previewId,
    wbDir: wb,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).theme, 'dark');

  // 成功后：in-progress 已清除，last.json 有审计摘要
  const st = getRestoreProgress(root);
  assert.equal(st.pending, false, '成功后不应 pending');
  assert.ok(st.last && st.last.backupId === b.backupId);
  assert.equal(st.last.restored >= 1, true);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(wb, { recursive: true, force: true });
});

test('enforceRetention 保护最近恢复点（05-D37）：被 restore 用过的备份不被自动清理', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createBackup, enforceRetentionSafe } = { createBackup: require('../scripts/jz/backup-vault').createBackup, enforceRetentionSafe: null };
  const { enforceRetention, diskFreeBytes } = require('../scripts/jz/auto-backup');
  const { finishRestoreProgress } = require('../scripts/jz/restore-progress');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-prot-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-prot-wb-'));

  const b = createBackup({ scope: ['settings'], reason: 'test', root, wbDir: wb });
  // 标记它为最近恢复点
  finishRestoreProgress({ backupId: b.backupId, snapshotId: 'snap-x', restored: 1, skipped: 0, root });

  // retention=0：正常应全清，但恢复点受保护
  enforceRetention(root, 0, (m) => console.log('  log:', m));
  const stillThere = fs.existsSync(path.join(root, 'backups', 'manifests', `${b.backupId}.json`));
  assert.ok(stillThere, '最近恢复点应受保护不被清理');

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(wb, { recursive: true, force: true });
});
