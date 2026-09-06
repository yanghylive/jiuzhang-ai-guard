'use strict';
// 回归测试（指导 §7/§8/§12）：恢复预览绑定（previewId 单次/过期/篡改拒绝）、scope 真过滤、
// 冲突策略三值行为、恢复失败回滚与 restore-progress 标记。真实临时目录，不 mock fs。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackup, restoreBackup, previewRestore } = require('../scripts/jz/backup-vault');
const { startRouterServer, jzFetch } = require('./_helpers');
const crypto = require('node:crypto');

const TOKEN = crypto.randomBytes(32).toString('hex');

function mkFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rs-root-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rs-wb-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"light"}');
  fs.mkdirSync(path.join(wb, 'app'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), '# ID-A\n');
  fs.writeFileSync(path.join(wb, 'app', 'sessions.json'), '[{"id":1}]');
  return { root, wb };
}

test('restoreBackup：conflictPolicy 三值行为互不相同（replace/keep-current/skip）', async () => {
  // replace：备份覆盖目标
  {
    const f = mkFixture();
    const b = createBackup({ scope: ['settings'], reason: 't', root: f.root, wbDir: f.wb });
    fs.writeFileSync(path.join(f.root, 'settings.json'), '{"theme":"dark"}');
    const rr = await restoreBackup({ backupId: b.backupId, conflictPolicy: 'replace', applyToReal: true, root: f.root, wbDir: f.wb });
    assert.equal(rr.ok, true);
    assert.equal(fs.readFileSync(path.join(f.root, 'settings.json'), 'utf8'), '{"theme":"light"}', 'replace 应覆盖');
  }
  // keep-current：目标存在且不同 → 跳过
  {
    const f = mkFixture();
    const b = createBackup({ scope: ['settings'], reason: 't', root: f.root, wbDir: f.wb });
    fs.writeFileSync(path.join(f.root, 'settings.json'), '{"theme":"dark"}');
    const rr = await restoreBackup({ backupId: b.backupId, conflictPolicy: 'keep-current', applyToReal: true, root: f.root, wbDir: f.wb });
    assert.equal(rr.ok, true);
    assert.equal(rr.skipped, 1);
    assert.equal(fs.readFileSync(path.join(f.root, 'settings.json'), 'utf8'), '{"theme":"dark"}', 'keep-current 不得覆盖');
  }
  // skip：目标存在即跳过（内容相同也一样跳过）
  {
    const f = mkFixture();
    const b = createBackup({ scope: ['settings'], reason: 't', root: f.root, wbDir: f.wb });
    // 内容相同（本来就该 skip），skip 策略下 restored=0
    const rr = await restoreBackup({ backupId: b.backupId, conflictPolicy: 'skip', applyToReal: true, root: f.root, wbDir: f.wb });
    assert.equal(rr.ok, true);
    assert.equal(rr.restored, 0, 'skip 策略下已存在文件一律跳过');
    assert.equal(rr.skipped, 1);
  }
});

test('scope 真过滤：预览/恢复只作用于请求的作用域', async () => {
  const f = mkFixture();
  const b = createBackup({ scope: ['settings', 'accounts'], reason: 't', root: f.root, wbDir: f.wb });
  // 篡改 accounts 目标 + settings 目标
  fs.writeFileSync(path.join(f.wb, 'IDENTITY.md'), '# ID-CHANGED\n');
  fs.writeFileSync(path.join(f.root, 'settings.json'), '{"theme":"dark"}');

  const pv = await previewRestore({ backupId: b.backupId, scope: ['settings'], root: f.root, wbDir: f.wb });
  assert.equal(pv.ok, true);
  assert.ok(pv.items.every((i) => i.scopeType === 'settings'), '预览条目必须全部属于请求作用域');

  const rr = await restoreBackup({ backupId: b.backupId, scope: ['settings'], conflictPolicy: 'replace', applyToReal: true, root: f.root, wbDir: f.wb });
  assert.equal(rr.ok, true);
  assert.equal(fs.readFileSync(path.join(f.root, 'settings.json'), 'utf8'), '{"theme":"light"}', 'settings 应被恢复');
  assert.equal(fs.readFileSync(path.join(f.wb, 'IDENTITY.md'), 'utf8'), '# ID-CHANGED\n', 'accounts 不得被写入（scope 外）');
});

test('previewRestore：非法 scope 拒绝；manifestSha256 指纹返回', async () => {
  const f = mkFixture();
  const b = createBackup({ scope: ['settings'], reason: 't', root: f.root, wbDir: f.wb });
  await assert.rejects(
    previewRestore({ backupId: b.backupId, scope: ['cookies'], root: f.root, wbDir: f.wb }),
    (e) => e.code === 'INVALID_SCOPE',
    '白名单外 scope 必须拒绝',
  );
  const pv = await previewRestore({ backupId: b.backupId, root: f.root, wbDir: f.wb });
  assert.ok(pv.manifestSha256 && /^[0-9a-f]{64}$/.test(pv.manifestSha256));
});

// ===== API 层：previewId 绑定（真实 HTTP）=====

async function mkServer() {
  const f = mkFixture();
  const b = createBackup({ scope: ['settings', 'accounts'], reason: 't', root: f.root, wbDir: f.wb });
  const s = await startRouterServer({ root: f.root, token: TOKEN });
  return { f, b, s };
}

// 恢复是高风险路由：先取一次性确认 token
async function getConfirm(s) {
  const r = await jzFetch(s.baseUrl, '/api/auth/confirm', { method: 'POST', token: TOKEN, body: { scope: 'POST /api/vault/restore' } });
  return (await r.json()).data.confirmToken;
}

test('API：恢复缺 previewId / conflictPolicy 非法 → 拒绝', async () => {
  const { f, b, s } = await mkServer();
  try {
    const ct = await getConfirm(s);
    const r1 = await jzFetch(s.baseUrl, '/api/vault/restore', {
      method: 'POST', token: TOKEN,
      body: { backupId: b.backupId, confirmed: true, conflictPolicy: 'replace', confirmToken: ct },
    });
    assert.equal(r1.status, 410, '缺 previewId 必须 410 PREVIEW_INVALID');

    const pv = await jzFetch(s.baseUrl, '/api/vault/restore/preview', { method: 'POST', token: TOKEN, body: { backupId: b.backupId } });
    const previewId = (await pv.json()).data.previewId;
    const ct2 = await getConfirm(s);
    const r2 = await jzFetch(s.baseUrl, '/api/vault/restore', {
      method: 'POST', token: TOKEN,
      body: { backupId: b.backupId, confirmed: true, conflictPolicy: 'nukem', previewId, confirmToken: ct2 },
    });
    assert.equal(r2.status, 400, '非法 conflictPolicy 必须 400');
  } finally {
    await s.close();
  }
});

test('API：previewId 换备份 / 改 scope / 篡改备份 → 拒绝', async () => {
  const { f, b, s } = await mkServer();
  try {
    const other = createBackup({ scope: ['settings'], reason: 't2', root: f.root, wbDir: f.wb });
    const pv = await jzFetch(s.baseUrl, '/api/vault/restore/preview', { method: 'POST', token: TOKEN, body: { backupId: b.backupId } });
    const previewId = (await pv.json()).data.previewId;

    // 换备份
    const ct1 = await getConfirm(s);
    const r1 = await jzFetch(s.baseUrl, '/api/vault/restore', {
      method: 'POST', token: TOKEN,
      body: { backupId: other.backupId, confirmed: true, conflictPolicy: 'replace', previewId, confirmToken: ct1 },
    });
    assert.equal(r1.status, 409, 'previewId 与 backupId 不一致必须 409');

    // 改 scope
    const ct2 = await getConfirm(s);
    const r2 = await jzFetch(s.baseUrl, '/api/vault/restore', {
      method: 'POST', token: TOKEN,
      body: { backupId: b.backupId, confirmed: true, conflictPolicy: 'replace', previewId, scope: ['accounts'], confirmToken: ct2 },
    });
    assert.equal(r2.status, 409, 'scope 与预览不一致必须 409');

    // 篡改备份（manifest 被改 → hash 不一致）
    const pv2 = await jzFetch(s.baseUrl, '/api/vault/restore/preview', { method: 'POST', token: TOKEN, body: { backupId: b.backupId } });
    const previewId2 = (await pv2.json()).data.previewId;
    const mPath = path.join(f.root, 'backups', 'manifests', `${b.backupId}.json`);
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    m.tampered = true;
    fs.writeFileSync(mPath, JSON.stringify(m));
    const ct3 = await getConfirm(s);
    const r3 = await jzFetch(s.baseUrl, '/api/vault/restore', {
      method: 'POST', token: TOKEN,
      body: { backupId: b.backupId, confirmed: true, conflictPolicy: 'replace', previewId: previewId2, confirmToken: ct3 },
    });
    assert.equal(r3.status, 409, '备份在预览后被修改必须 409 PREVIEW_STALE');
  } finally {
    await s.close();
  }
});

test('API：previewId 单次使用 + 幂等重放不产生第二次恢复', async () => {
  const { f, b, s } = await mkServer();
  try {
    const pv = await jzFetch(s.baseUrl, '/api/vault/restore/preview', { method: 'POST', token: TOKEN, body: { backupId: b.backupId } });
    const previewId = (await pv.json()).data.previewId;
    const ct1 = await getConfirm(s);
    const body = { backupId: b.backupId, confirmed: true, conflictPolicy: 'replace', previewId, idempotencyKey: 'restore-idem-0001', confirmToken: ct1 };

    const first = await jzFetch(s.baseUrl, '/api/vault/restore', { method: 'POST', token: TOKEN, body });
    const firstBody = await first.json();
    assert.equal(first.status, 200, `首次恢复应成功: ${JSON.stringify(firstBody)}`);

    // 重放同 idempotencyKey（客户端超时重试）：返回首次结果
    const ct2 = await getConfirm(s);
    const retry = await jzFetch(s.baseUrl, '/api/vault/restore', { method: 'POST', token: TOKEN, body: { ...body, confirmToken: ct2 } });
    const retryBody = await retry.json();
    assert.equal(retry.status, 200);
    assert.equal(retryBody.data.restored, firstBody.data.restored, '重放返回首次结果');

    // 换一个 idempotencyKey 重放同 previewId → 已消费，拒绝
    const ct3 = await getConfirm(s);
    const replay = await jzFetch(s.baseUrl, '/api/vault/restore', {
      method: 'POST', token: TOKEN,
      body: { backupId: b.backupId, confirmed: true, conflictPolicy: 'replace', previewId, idempotencyKey: 'restore-idem-0002', confirmToken: ct3 },
    });
    assert.equal(replay.status, 410, 'previewId 只能使用一次');
  } finally {
    await s.close();
  }
});

test('恢复中途写入失败：逆序回滚，原文件保持原状，progress 标记 failed', async () => {
  if (process.platform === 'win32') return; // chmod 语义不同，Windows 下跳过注入注入
  const f = mkFixture();
  const b = createBackup({ scope: ['settings', 'accounts'], reason: 't', root: f.root, wbDir: f.wb });
  // 恢复前篡改目标（验证回滚保真）
  fs.writeFileSync(path.join(f.root, 'settings.json'), '{"theme":"dark"}');
  // 注入失败：wb 目录只读 → accounts 条目写入失败（settings 先被替换，触发回滚）
  fs.chmodSync(f.wb, 0o500);
  try {
    const rr = await restoreBackup({ backupId: b.backupId, conflictPolicy: 'replace', applyToReal: true, root: f.root, wbDir: f.wb });
    assert.equal(rr.ok, false, '写入失败必须返回失败');
    assert.equal(rr.error, 'RESTORE_FAILED');
    assert.equal(rr.rollback.status, 'rolled_back', '已替换文件应全部回滚');
    assert.equal(fs.readFileSync(path.join(f.root, 'settings.json'), 'utf8'), '{"theme":"dark"}', 'settings.json 应回滚到原内容');
    // progress 标记 failed
    const { getRestoreProgress } = require('../scripts/jz/restore-progress');
    const rp = getRestoreProgress(f.root);
    assert.equal(rp.pending, true, '失败后应存在未完成标记');
    assert.equal(rp.failed, true, '标记必须为 failed');
    assert.ok(rp.inProgress.reason, '应携带失败原因');
  } finally {
    fs.chmodSync(f.wb, 0o755);
  }
});
