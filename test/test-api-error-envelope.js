'use strict';
// 回归测试（指导 §10/§12）：备份/导出失败不得返回假成功。
// 低磁盘（注入 _diskFree）、只读目录（真实 chmod）、错误码稳定；旧备份不受破坏。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackup, verifyBackup, listBackups } = require('../scripts/jz/backup-vault');
const { startRouterServer, jzFetch } = require('./_helpers');

const TOKEN = crypto.randomBytes(32).toString('hex');

function mkFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-env-root-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-env-wb-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"light"}');
  return { root, wb };
}

test('低磁盘：createBackup 直接拒绝（INSUFFICIENT_DISK_SPACE），不产生半截备份', () => {
  const { root, wb } = mkFixture();
  const r = createBackup({ scope: ['settings', 'accounts'], reason: 't', root, wbDir: wb, _diskFree: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INSUFFICIENT_DISK_SPACE');
  assert.ok(r.required > 0);
  // 无半截备份目录残留
  const blobsRoot = path.join(root, 'backups', 'blobs');
  const left = fs.existsSync(blobsRoot) ? fs.readdirSync(blobsRoot) : [];
  assert.equal(left.length, 0, `不应有 blob 目录残留: ${left}`);
  assert.equal(listBackups(root).length, 0, '不应有 manifest 残留');
});

test('只读目录（权限失败）：API 返回 422 + BACKUP_PERMISSION_DENIED，绝不 ok:true', async () => {
  if (process.platform === 'win32') return; // chmod 语义不同，Windows 跳过
  const { root, wb } = mkFixture();
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    // 先成功一次，作为「旧备份不受破坏」的对照组
    const good = await jzFetch(s.baseUrl, '/api/vault/backup', { method: 'POST', token: TOKEN, body: { scope: ['settings'], reason: 'manual', idempotencyKey: 'env-good-key-0001' } });
    assert.equal(good.status, 200);
    const goodBody = await good.json();
    assert.equal(goodBody.ok, true, '正常路径必须真实成功');
    const oldBackupId = goodBody.data.backupId;

    // blobs 根目录只读 → blob 写入失败
    const blobsRoot = path.join(root, 'backups', 'blobs');
    fs.chmodSync(blobsRoot, 0o500);
    try {
      const bad = await jzFetch(s.baseUrl, '/api/vault/backup', { method: 'POST', token: TOKEN, body: { scope: ['settings'], reason: 'manual', idempotencyKey: 'env-fail-key-0001' } });
      assert.equal(bad.status, 422, '失败必须非 200');
      const badBody = await bad.json();
      assert.equal(badBody.ok, false, '响应体 ok 必须为 false（不得假成功）');
      assert.equal(badBody.error, 'BACKUP_PERMISSION_DENIED', '错误码必须稳定可识别');
    } finally {
      fs.chmodSync(blobsRoot, 0o755);
    }

    // 旧备份不受破坏
    const v = verifyBackup({ backupId: oldBackupId, root });
    assert.equal(v.ok, true, '失败后旧备份必须完好');
    assert.equal(listBackups(root).length, 1, '失败的备份不得写入 manifest');
  } finally {
    await s.close();
  }
});

test('只读目录下的导出：失败透传 EXPORT_PERMISSION_DENIED，不产生半截导出文件', async () => {
  if (process.platform === 'win32') return;
  const { root, wb } = mkFixture();
  const b = createBackup({ scope: ['settings'], reason: 't', root, wbDir: wb });
  assert.ok(b.backupId);
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    const confirm = await jzFetch(s.baseUrl, '/api/auth/confirm', { method: 'POST', token: TOKEN, body: { scope: 'POST /api/vault/export' } });
    const confirmToken = (await confirm.json()).data.confirmToken;
    // exports 父目录（数据根）只读前先让 backups 可写——只需让数据根只读，exports mkdir 失败
    fs.chmodSync(root, 0o500);
    try {
      const r = await jzFetch(s.baseUrl, '/api/vault/export', { method: 'POST', token: TOKEN, body: { backupId: b.backupId, passphrase: 'pw', confirmToken } });
      assert.equal(r.status, 422, '导出失败必须非 200');
      const body = await r.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, 'EXPORT_PERMISSION_DENIED');
    } finally {
      fs.chmodSync(root, 0o755);
    }
  } finally {
    await s.close();
  }
});

test('客户端提交 destination（任意路径导出）→ 400 拒绝', async () => {
  const { root, wb } = mkFixture();
  const b = createBackup({ scope: ['settings'], reason: 't', root, wbDir: wb });
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    for (const dest of ['/tmp/evil.jzvault', '../../outside.jzvault']) {
      // 每次请求取新的一次性 confirm token（业务拒绝也会消费 confirm token）
      const c = await jzFetch(s.baseUrl, '/api/auth/confirm', { method: 'POST', token: TOKEN, body: { scope: 'POST /api/vault/export' } });
      const confirmToken = (await c.json()).data.confirmToken;
      const r = await jzFetch(s.baseUrl, '/api/vault/export', { method: 'POST', token: TOKEN, body: { backupId: b.backupId, passphrase: 'pw', confirmToken, destination: dest } });
      assert.equal(r.status, 400, `destination=${dest} 必须拒绝`);
      assert.equal((await r.json()).error, 'INVALID_REQUEST');
      assert.ok(!fs.existsSync(dest), '任意路径不得被写入');
    }
  } finally {
    await s.close();
  }
});
