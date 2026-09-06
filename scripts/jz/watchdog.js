'use strict';
// watchdog：值守中心本地核心（V0.2 收官模块，能力提炼开发文档 §3.2 watchdog / 值守中心）。
// 范围：设备在线 / 操作任务监控 / 自动备份状态与暂停恢复 / 异常告警扫描 / 重启请求标记。
// 远程通道（把值守快照推到云侧/手机）留 hook：watchdogStatus() 输出即通道 payload，
// 通道方案定后只接一段推送代码即可——本地值守不依赖任何外部通道。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { dataRoot, uuid, readJSON, atomicWriteJSON } = require('./lib');
const { loadSettings, saveSettings } = require('./storage');
const { listOperations } = require('./operation-store');
const { diskFreeBytes } = require('./auto-backup');

const HEALTH_DIR = 'runtime/health';
const RESTART_FILE = 'runtime/restart-request.json';
const ALERT_MIN_FREE_BYTES = 500 * 1024 * 1024; // 500MB
const BACKUP_STALE_HOURS = 26;

// 最近体检（runtime/health 最新一份）
function latestHealth(root) {
  const dir = path.join(root || dataRoot(), HEALTH_DIR);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  if (!files.length) return null;
  let best = null;
  for (const f of files) {
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) {
      const rec = readJSON(p);
      best = { file: f, mtimeMs: st.mtimeMs, rec };
    }
  }
  return best && best.rec ? { checkId: best.rec.checkId, score: best.rec.score, status: best.rec.status, findings: best.rec.findings || [], at: best.rec.at || new Date(best.mtimeMs).toISOString() } : null;
}

// 最近一次备份时间（backups/manifests 最新 mtime）
function latestBackupAt(root) {
  const dir = path.join(root || dataRoot(), 'backups', 'manifests');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  let newest = 0;
  for (const f of files) {
    try { newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* ignore */ }
  }
  return newest ? new Date(newest).toISOString() : null;
}

// 异常告警扫描（本地数据源，纯读）
function alertScan({ root } = {}) {
  const r = root || dataRoot();
  const alerts = [];
  const now = Date.now();

  // 1. 操作失败（近 24h）
  const ops = listOperations({ root: r, limit: 50 });
  const dayAgo = now - 24 * 3600 * 1000;
  for (const o of ops.operations || []) {
    if (o.status === 'failed' && o.finishedAt && new Date(o.finishedAt).getTime() > dayAgo) {
      alerts.push({ severity: 'high', code: 'OP_FAILED', message: `操作失败：${o.type}（${o.errorCode || 'UNKNOWN'}）`, at: o.finishedAt });
    }
  }

  // 2. 备份 stale（autoBackup enabled 但 >26h 无新备份）
  const settings = loadSettings(r);
  const ab = (settings && settings.autoBackup) || {};
  const lastBk = latestBackupAt(r);
  if (ab.enabled && !ab.paused) {
    if (!lastBk || now - new Date(lastBk).getTime() > BACKUP_STALE_HOURS * 3600 * 1000) {
      alerts.push({ severity: 'medium', code: 'BACKUP_STALE', message: `自动备份已启用但 ${lastBk ? '超过 ' + Math.round((now - new Date(lastBk).getTime()) / 3600000) + ' 小时' : '从未'}无新备份`, at: new Date().toISOString() });
    }
  }

  // 3. 磁盘剩余不足
  const free = diskFreeBytes(r);
  if (free !== null && free < ALERT_MIN_FREE_BYTES) {
    alerts.push({ severity: 'high', code: 'LOW_DISK', message: `磁盘剩余 ${Math.round(free / 1048576)}MB < ${Math.round(ALERT_MIN_FREE_BYTES / 1048576)}MB`, at: new Date().toISOString() });
  }

  // 4. 安全模式激活
  if (settings && settings.safeMode && settings.safeMode.active) {
    alerts.push({ severity: 'high', code: 'SAFE_MODE', message: '安全模式激活中（写操作被拒绝）', at: new Date().toISOString() });
  }

  // 5. 最近体检 critical 项
  const h = latestHealth(r);
  if (h) {
    const crits = h.findings.filter((f) => f.severity === 'high' && !f.ok);
    for (const c of crits.slice(0, 5)) {
      alerts.push({ severity: 'high', code: `HEALTH:${c.code}`, message: c.message || c.code, at: h.at });
    }
  }

  return { ok: true, alerts };
}

// 值守快照（= 远程通道 payload 雏形）
function watchdogStatus({ root } = {}) {
  const r = root || dataRoot();
  const settings = loadSettings(r);
  const ab = (settings && settings.autoBackup) || {};
  const ops = listOperations({ root: r, limit: 20 });
  const running = (ops.operations || []).filter((o) => o.status === 'running' || o.status === 'queued');
  const failed24h = (ops.operations || []).filter((o) => o.status === 'failed' && o.finishedAt && new Date(o.finishedAt).getTime() > Date.now() - 24 * 3600 * 1000);
  const h = latestHealth(r);
  const scan = alertScan({ root: r });

  const status = {
    device: {
      online: true,
      pid: process.pid,
      hostname: os.hostname(),
      platform: process.platform,
      startedAt: process.env.JZ_STARTED_AT || null,
      version: process.env.JZ_WB_VERSION || process.env.JZ_VERSION || null,
    },
    autoBackup: {
      enabled: !!ab.enabled,
      paused: !!ab.paused,
      frequency: ab.frequency || 'daily',
      retention: Number(ab.retention) > 0 ? Number(ab.retention) : 3,
      lastBackupAt: latestBackupAt(r),
    },
    operations: {
      running: running.map((o) => ({ operationId: o.operationId, type: o.type, startedAt: o.startedAt, cancelRequested: !!o.cancelRequested })),
      failed24h: failed24h.map((o) => ({ operationId: o.operationId, type: o.type, errorCode: o.errorCode })),
    },
    health: h,
    safeMode: !!(settings && settings.safeMode && settings.safeMode.active),
    alerts: scan.alerts,
    summary: {
      ok: scan.alerts.filter((a) => a.severity !== 'high' && a.severity !== 'medium').length,
      warnings: scan.alerts.filter((a) => a.severity === 'medium').length,
      criticals: scan.alerts.filter((a) => a.severity === 'high').length,
    },
    sampledAt: new Date().toISOString(),
  };
  return { ok: true, status };
}

// 自动备份暂停/恢复（改 settings.autoBackup.paused；调度器每次执行前重读设置，无需 reload）
function setAutoBackupPaused({ paused, root } = {}) {
  const r = root || dataRoot();
  const settings = loadSettings(r);
  settings.autoBackup = Object.assign({}, settings.autoBackup, { paused: !!paused });
  try {
    saveSettings(r, settings);
  } catch (e) {
    return { ok: false, error: 'SETTINGS_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
  return { ok: true, paused: !!paused };
}

// 重启请求标记（HIGH_RISK confirmToken 保护）：daemon 检测到文件后优雅退出，宿主/launchd 拉回
function requestRestart({ reason = '', root } = {}) {
  const r = root || dataRoot();
  const rec = { requestId: uuid(), reason: String(reason || ''), requestedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.join(r, 'runtime'), { recursive: true });
    atomicWriteJSON(path.join(r, RESTART_FILE), rec);
  } catch (e) {
    return { ok: false, error: 'RESTART_REQUEST_FAILED', detail: String((e && e.message) || e) };
  }
  return { ok: true, ...rec };
}

function peekRestartRequest({ root } = {}) {
  const p = path.join(root || dataRoot(), RESTART_FILE);
  return readJSON(p) || null;
}

function clearRestartRequest({ root } = {}) {
  const p = path.join(root || dataRoot(), RESTART_FILE);
  try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
}

module.exports = { watchdogStatus, alertScan, setAutoBackupPaused, requestRestart, peekRestartRequest, clearRestartRequest, latestHealth, latestBackupAt };
