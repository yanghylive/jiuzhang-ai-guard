'use strict';
// 本地修复执行器测试：cleanup-stale-runtime / repair-dir-permission / restore-latest。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanupStaleRuntime, repairDirPermission, restoreLatest } = require('../scripts/jz/repair-local');
const { createBackup } = require('../scripts/jz/backup-vault');

test('cleanupStaleRuntime：清过期文件、保留 safe-mode.json 与新文件', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-repair-c-'));
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  // 过期文件（10 天前）
  const stale = path.join(runtime, 'operations');
  fs.mkdirSync(stale, { recursive: true });
  const staleFile = path.join(stale, 'op-old.json');
  fs.writeFileSync(staleFile, '{}');
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  fs.utimesSync(staleFile, old, old);
  // safe-mode.json（必须保留）
  fs.writeFileSync(path.join(runtime, 'safe-mode.json'), '{"on":true}');
  // 新文件（保留）
  fs.writeFileSync(path.join(runtime, 'op-new.json'), '{}');

  const r = cleanupStaleRuntime(root);
  assert.equal(r.ok, true);
  assert.equal(r.removed, 1, '应清理 1 个过期文件');
  assert.ok(fs.existsSync(path.join(runtime, 'safe-mode.json')), 'safe-mode.json 必须保留');
  assert.ok(fs.existsSync(path.join(runtime, 'op-new.json')), '新文件必须保留');
  assert.ok(!fs.existsSync(staleFile), '过期文件应被删除');
});

test('repairDirPermission：非 0700 目录修复为 0700', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-repair-p-'));
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(root, 'license'), { recursive: true, mode: 0o755 });
  const r = repairDirPermission(root);
  assert.equal(r.ok, true);
  assert.ok(r.fixed >= 1, '应修复至少 1 个目录');
  // Windows 上 chmod 只支持只读位，mode 恒为 0o666，无法表达 0700（权限模型为 ACL），跳过精确权限断言
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(root, 'backups')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, 'license')).mode & 0o777, 0o700);
  }
});

test('restoreLatest：无备份 → NO_BACKUP；有备份 → keep-current 恢复', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-repair-r-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-repair-wb-'));
  // 无备份
  const none = await restoreLatest(root, 'settings');
  assert.equal(none.ok, false);
  assert.equal(none.error, 'NO_BACKUP');

  // 造备份
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"light"}');
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), '# ID');
  const b = createBackup({ scope: ['settings', 'accounts'], reason: 'test', root, wbDir: wb });
  assert.ok(b.backupId);

  const r = await restoreLatest(root, 'settings', wb);
  assert.equal(r.ok, true);
  assert.equal(r.scopeType, 'settings');
  assert.equal(typeof r.restored, 'number');
  assert.ok(r.snapshotId, '应生成恢复快照');
  // settings.json 内容与备份一致（keep-current 内容未变 → 幂等写回）
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{"theme":"light"}');
});

test('rollback-component：无快照 → NO_SNAPSHOT；有快照 → 原子回滚 + 当前状态二次备份', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { rollbackComponent } = require('../scripts/jz/repair-local');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rollback-'));
  const wbDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rollback-wb-'));

  // 场景 1：无快照
  let r = await rollbackComponent(root, wbDir);
  assert.equal(r.error, 'NO_SNAPSHOT');

  // 构造快照：settings.json（数据根）+ accounts/a.json（WorkBuddy 目录）
  const snapDir = path.join(root, 'quarantine', 'restore-snapshot-snap1');
  fs.mkdirSync(path.join(snapDir, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(snapDir, 'settings.json'), '{"theme":"dark-snapshot"}');
  fs.writeFileSync(path.join(snapDir, 'accounts', 'a.json'), '{"uid":"snap-uid"}');
  // 当前目标状态（与快照不同，回滚应覆盖）
  fs.mkdirSync(path.join(root), { recursive: true });
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"light-broken"}');
  fs.mkdirSync(path.join(wbDir, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(wbDir, 'accounts', 'a.json'), '{"uid":"broken"}');
  // 时间戳确保是「最近」快照
  const now = Date.now();
  fs.utimesSync(path.join(snapDir, 'settings.json'), new Date(now), new Date(now));
  fs.utimesSync(path.join(snapDir, 'accounts', 'a.json'), new Date(now), new Date(now));

  r = await rollbackComponent(root, wbDir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rolledBack, 2);
  // 回滚后目标恢复快照内容
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).theme, 'dark-snapshot');
  assert.equal(JSON.parse(fs.readFileSync(path.join(wbDir, 'accounts', 'a.json'), 'utf8')).uid, 'snap-uid');
  // 当前状态二次备份存在（rollback-current-*）
  const rcs = fs.readdirSync(path.join(root, 'quarantine')).filter((x) => x.startsWith('rollback-current-'));
  assert.equal(rcs.length, 1);
  const curSettings = JSON.parse(fs.readFileSync(path.join(root, 'quarantine', rcs[0], 'settings.json'), 'utf8'));
  assert.equal(curSettings.theme, 'light-broken', '回滚前的破损状态应被二次备份');
});
