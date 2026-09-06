'use strict';
// watchdog 值守中心回归（V0.2 收官）：
// 值守快照聚合（设备/操作/自动备份/健康）、告警扫描（op 失败/备份 stale/低磁盘/安全模式）、
// 自动备份暂停/恢复（设置持久化）、重启请求标记（HIGH_RISK 门禁）、HTTP 全链路。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { watchdogStatus, alertScan, setAutoBackupPaused, requestRestart, peekRestartRequest, clearRestartRequest, latestHealth } = require('../scripts/jz/watchdog');
const { beginOperation, failOperation } = require('../scripts/jz/operation-store');
const { saveSettings } = require('../scripts/jz/storage');
const { startRouterServer, jzFetch } = require('./_helpers');

function freshRoot() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wd-'));
}

test('watchdogStatus：快照聚合（设备/操作/自动备份/安全模式/告警摘要）', () => {
  const root = freshRoot();
  saveSettings(root, { autoBackup: { enabled: true, frequency: 'daily', retention: 3 }, safeMode: { active: true } });
  const r = watchdogStatus({ root });
  assert.equal(r.ok, true);
  const st = r.status;
  assert.equal(st.device.online, true);
  assert.ok(st.device.pid > 0, '设备 pid');
  assert.equal(st.autoBackup.enabled, true);
  assert.equal(st.autoBackup.paused, false);
  assert.equal(st.safeMode, true, '安全模式激活被捕获');
  assert.ok(Array.isArray(st.alerts) && st.alerts.some((a) => a.code === 'SAFE_MODE'), '安全模式进告警');
  assert.ok(st.summary.criticals >= 1, '告警摘要计数');
  assert.ok(st.sampledAt, '采样时间');
});

test('alertScan：操作失败进告警（近 24h）；备份 stale 检测', () => {
  const root = freshRoot();
  // 构造一个 failed 操作
  const op = beginOperation({ root, type: 'restore', label: 't', total: 1 });
  failOperation({ root, operationId: op.operationId, errorCode: 'RESTORE_FAILED' });
  // 启用自动备份但无备份记录 → stale
  saveSettings(root, { autoBackup: { enabled: true, paused: false } });
  const r = alertScan({ root });
  assert.equal(r.ok, true);
  const codes = r.alerts.map((a) => a.code);
  assert.ok(codes.includes('OP_FAILED'), '操作失败进告警');
  assert.ok(codes.includes('BACKUP_STALE'), '启用但无新备份 → stale 告警');
  // paused 后 stale 消失
  setAutoBackupPaused({ paused: true, root });
  const r2 = alertScan({ root });
  assert.ok(!r2.alerts.some((a) => a.code === 'BACKUP_STALE'), '暂停后不再 stale 告警');
});

test('setAutoBackupPaused：设置持久化 + resume', () => {
  const root = freshRoot();
  saveSettings(root, { autoBackup: { enabled: true } });
  const p = setAutoBackupPaused({ paused: true, root });
  assert.equal(p.ok, true);
  const st = watchdogStatus({ root });
  assert.equal(st.status.autoBackup.paused, true, 'paused 状态持久化');
  setAutoBackupPaused({ paused: false, root });
  assert.equal(watchdogStatus({ root }).status.autoBackup.paused, false);
});

test('requestRestart：标记落盘/读取/清除', () => {
  const root = freshRoot();
  const r = requestRestart({ reason: '测试重启', root });
  assert.equal(r.ok, true);
  assert.ok(r.requestId);
  const peek = peekRestartRequest({ root });
  assert.equal(peek.requestId, r.requestId);
  assert.equal(peek.reason, '测试重启');
  clearRestartRequest({ root });
  assert.equal(peekRestartRequest({ root }), null);
});

test('HTTP 全链路：status/scan/pause/resume + restart 需 confirmToken（403 门禁）', async () => {
  const root = freshRoot();
  const TOKEN = crypto.randomBytes(32).toString('hex');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    // 无 confirmToken → 403
    const denied = await jzFetch(s.baseUrl, '/api/watchdog/restart', { method: 'POST', token: TOKEN, body: { reason: 'x' } });
    assert.equal(denied.status, 403, 'restart 必须 confirmToken');
    // status / scan
    const st = await (await jzFetch(s.baseUrl, '/api/watchdog/status', { method: 'GET', token: TOKEN })).json();
    assert.equal(st.ok, true);
    assert.ok(st.data.device.online, '设备在线');
    const scan = await (await jzFetch(s.baseUrl, '/api/watchdog/scan', { method: 'POST', token: TOKEN, body: {} })).json();
    assert.ok(Array.isArray(scan.data.alerts));
    // pause / resume
    assert.equal((await jzFetch(s.baseUrl, '/api/watchdog/auto-backup/pause', { method: 'POST', token: TOKEN, body: {} })).status, 200);
    assert.equal((await (await jzFetch(s.baseUrl, '/api/watchdog/auto-backup/resume', { method: 'POST', token: TOKEN, body: {} })).json()).data.paused, false);
  } finally {
    await s.close();
  }
});
