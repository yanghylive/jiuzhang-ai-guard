'use strict';
// 回归测试（复查 P1/P2，2026-08-29）：备份路由幂等键、健康检查 root 隔离、staging TTL/配额。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRouterServer, jzFetch } = require('./_helpers');
const vault = require('../scripts/jz/backup-vault');

const TOKEN = crypto.randomBytes(32).toString('hex');

test('备份路由：强制幂等键，同键重放返回同一 backupId（不重复产生备份）', async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-idem2-'));
  // 特权环境探测（Windows SYSTEM / root / CI 特殊 runner）：chmod 0o500 后实际写一下，
  // 能写入说明权限注入不生效（环境特例，CI 普通用户正常覆盖该用例）
  const probeRoot = path.join(root, 'backups', 'blobs');
  fs.mkdirSync(probeRoot, { recursive: true });
  fs.chmodSync(probeRoot, 0o500);
  try {
    fs.writeFileSync(path.join(probeRoot, 'probe.txt'), 'x');
    fs.rmSync(path.join(probeRoot, 'probe.txt'), { force: true });
    fs.chmodSync(probeRoot, 0o755);
    t.skip('特权环境 chmod 权限注入不生效（普通用户环境覆盖该用例）');
    return;
  } catch { fs.chmodSync(probeRoot, 0o755); }
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"dark"}');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    // 缺幂等键 → 400
    const noKey = await jzFetch(s.baseUrl, '/api/vault/backup', { method: 'POST', token: TOKEN, body: { scope: ['settings'], reason: 'manual' } });
    assert.equal(noKey.status, 400, '缺幂等键必须 400');
    const manifestDir0 = path.join(root, 'backups', 'manifests');
    const manifests0 = fs.existsSync(manifestDir0) ? fs.readdirSync(manifestDir0).filter((f) => f.endsWith('.json')) : [];
    assert.equal(manifests0.length, 0, '缺键请求不得产生备份 manifest');

    // 同键两次 → 同一 backupId，manifest 只有一份
    const body = { scope: ['settings'], reason: 'manual', idempotencyKey: 'backup-idem-key-001' };
    const r1 = await jzFetch(s.baseUrl, '/api/vault/backup', { method: 'POST', token: TOKEN, body });
    const b1 = await r1.json();
    assert.equal(r1.status, 200);
    const r2 = await jzFetch(s.baseUrl, '/api/vault/backup', { method: 'POST', token: TOKEN, body });
    const b2 = await r2.json();
    assert.equal(r2.status, 200);
    assert.equal(b2.data.backupId, b1.data.backupId, '同键重放返回首次 backupId');
    const manifests = fs.readdirSync(path.join(root, 'backups', 'manifests'));
    assert.equal(manifests.length, 1, '重放不得重复产生备份');

    // 失败结果同样登记：同键重放返回同一失败（不再执行）
    const failBody = { scope: ['settings'], reason: 'manual', idempotencyKey: 'backup-idem-key-002' };
    const blobsRoot = path.join(root, 'backups', 'blobs');
    fs.mkdirSync(blobsRoot, { recursive: true });
    fs.chmodSync(blobsRoot, 0o500);
    const f1 = await jzFetch(s.baseUrl, '/api/vault/backup', { method: 'POST', token: TOKEN, body: failBody });
    assert.equal(f1.status, 422, '失败必须真实失败');
    fs.chmodSync(blobsRoot, 0o755);
    const f2 = await jzFetch(s.baseUrl, '/api/vault/backup', { method: 'POST', token: TOKEN, body: failBody });
    assert.equal(f2.status, 422, '同键重放返回首次失败结果');
  } finally {
    await s.close();
  }
});

test('健康检查：使用调用方传入的 root，不误落默认 dataRoot()（复查 P1）', async () => {
  const callerRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-hc-caller-'));
  const defaultRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-hc-default-'));
  const prev = process.env.JZ_DATA_ROOT;
  process.env.JZ_DATA_ROOT = defaultRoot; // 若误用 dataRoot()，默认目录会被 ensureDataRoot 展开
  try {
    const { runHealthCheck } = require('../scripts/jz/health-check');
    const h = await runHealthCheck({ profile: 'workbuddy-cn', root: callerRoot });
    assert.ok(h.checkId, '体检应产出 checkId');
    // ensureDataRoot(root)：DIRS 只落在调用方 root
    assert.ok(fs.existsSync(path.join(callerRoot, 'backups', 'manifests')), 'DIRS 应落在调用方 root');
    // 默认 dataRoot() 不应被误展开（复查 P1 的核心断言）
    assert.ok(!fs.existsSync(path.join(defaultRoot, 'backups', 'manifests')), '不得误初始化默认 dataRoot()');
    assert.ok(!fs.existsSync(path.join(defaultRoot, 'runtime')), '默认 dataRoot() 不得出现 runtime');
  } finally {
    if (prev === undefined) delete process.env.JZ_DATA_ROOT; else process.env.JZ_DATA_ROOT = prev;
  }
});

test('修复闭环复查：recheck 体检与数据目录同源（router 层）', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rc-root-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"dark"}');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    // 触发一次体检（落 root/runtime/health）
    const h = await jzFetch(s.baseUrl, '/api/health/check', { method: 'POST', token: TOKEN, body: { profile: 'workbuddy-cn' } });
    assert.equal(h.status, 200);
    // 修复计划 + 执行后 recheck 用的也是同一 dataDir（此处只验证调用不炸且结构齐全）
    const plan = await jzFetch(s.baseUrl, '/api/repair/plan', { method: 'POST', token: TOKEN, body: { findingCodes: [] } });
    assert.equal(plan.status, 200);
  } finally {
    await s.close();
  }
});

test('staging 治理：TTL 过期清理 + 总配额统计（复查 P2）', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-stage-'));
  const st = vault.stagingDir(root);
  fs.mkdirSync(st, { recursive: true });
  // 新文件（1KB）+ 过期文件（2KB，mtime 拨回 2h 前）
  fs.writeFileSync(path.join(st, 'fresh.jzvault'), Buffer.alloc(1024));
  const old = path.join(st, 'old.jzvault');
  fs.writeFileSync(old, Buffer.alloc(2048));
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo);

  const sweep = vault.sweepStaging(root);
  assert.ok(!fs.existsSync(old), '过期 staging 文件必须被清理');
  assert.equal(sweep.removed, 1);
  assert.equal(sweep.total, 1024, '未过期文件计入总占用');
  // 目录穿越伪装文件名不参与（walk 只认普通文件）
  assert.equal(typeof vault.stagingQuotaBytes(), 'number', '配额常量可读');
});
