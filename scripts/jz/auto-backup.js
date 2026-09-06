'use strict';
// 自动备份调度器（05 §4.1 autoBackup，08 E2E-008）。
// 读 Settings.autoBackup（enabled/frequency/retention），按频率定时执行备份，
// 超过 retention 的旧成功备份自动清理（保留最近恢复点由 backup-vault 自行保护）。
const fs = require('node:fs');
const path = require('node:path');
const { createBackup, listBackups, assertSafeBackupId } = require('./backup-vault');
const { loadSettings } = require('./storage');
const { withLock } = require('./op-lock');

const DAY_MS = 24 * 3600 * 1000;
// 失败重试：连续失败后按指数退避尽快重试（5min → 15min → 30min → 1h 封顶），成功即复位。
const RETRY_BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];
// 低磁盘阈值：剩余空间低于此值暂停自动备份（避免写半截备份/磁盘耗尽）。
const MIN_FREE_BYTES = Number(process.env.JZ_MIN_FREE_BYTES || 500 * 1024 * 1024);

// 磁盘剩余空间（字节）；无法获取返回 null（不阻断，仅跳过低磁盘判定）。
function diskFreeBytes(root) {
  try {
    const st = fs.statfsSync(root);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

// 保留策略：按 createdAt 降序保留最近 retention 个，多余删除（manifest + blobs）。
function enforceRetention(root, retention, log) {
  try {
    const backups = listBackups(root) || [];
    const sorted = backups.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    // 05-D37：最近恢复点不可被自动清理（restore-progress last.json 记录的 backupId）
    let protectedIds = [];
    try {
      const { getRestoreProgress } = require('./restore-progress');
      const st = getRestoreProgress(root);
      if (st.last && st.last.backupId) protectedIds.push(st.last.backupId);
      if (st.inProgress && st.inProgress.backupId) protectedIds.push(st.inProgress.backupId);
    } catch {
      /* 保护列表读取失败不阻断清理 */
    }
    const excess = sorted.slice(retention);
    for (const b of excess) {
      const bid = b.backupId || b.id;
      if (!bid) continue;
      // 2026-08-30 第五轮复核 P1：bid 直接进 rmSync 路径——恶意/损坏 manifest 可携带
      // 路径穿越 id 删除备份目录外的文件。必须过 assertSafeBackupId 白名单。
      if (!assertSafeBackupId(bid)) {
        if (log) log(`[auto-backup] 跳过非法 backupId: ${String(bid).slice(0, 64)}`);
        continue;
      }
      if (protectedIds.includes(bid)) {
        if (log) log(`[auto-backup] 跳过 ${String(bid).slice(0, 8)}（最近恢复点，05-D37 保护）`);
        continue;
      }
      fs.rmSync(path.join(root, 'backups', 'manifests', `${bid}.json`), { force: true });
      fs.rmSync(path.join(root, 'backups', 'blobs', bid), { recursive: true, force: true });
      if (log) log(`[auto-backup] 保留数 ${retention}，清理旧备份 ${bid}`);
    }
  } catch (e) {
    if (log) log(`[auto-backup] 清理失败: ${e.message}`);
  }
}

// 启动调度器。返回 { stop, reload }（复查 P1：设置修改后调用 reload() 立即生效，
// 无需重启 daemon —— 每次 reload 重新读取 Settings，启用状态/频率/保留数实时生效）。
// frequency=before-update：事件驱动（daemon 更新前已内置备份），不建周期定时器。
function startAutoBackup({ root, log = () => {} } = {}) {
  let failStreak = 0;
  let timer = null;
  let retryTimer = null;
  let first = null;

  const clearTimers = () => {
    if (first) { clearTimeout(first); first = null; }
    if (timer) { clearInterval(timer); timer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  };

  const run = async () => {
    try {
      // 复查 P1：每次执行前重读设置 —— UI 关闭自动备份后本轮立即停止
      const settings = loadSettings(root);
      const ab = (settings && settings.autoBackup) || {};
      if (ab.paused) {
        log('[auto-backup] 值守暂停中（Settings.autoBackup.paused=true），本轮跳过');
        return;
      }
      if (!ab.enabled) {
        log('[auto-backup] 已被设置关闭，本轮跳过');
        return;
      }
      const retention = Number(ab.retention) > 0 ? Number(ab.retention) : 3;
      // 低磁盘防护：剩余 < MIN_FREE_BYTES 暂停本轮并告警（避免写半截备份/磁盘耗尽）
      const free = diskFreeBytes(root);
      if (free !== null && free < MIN_FREE_BYTES) {
        log(`[auto-backup] 磁盘剩余不足（${Math.round(free / 1048576)}MB < ${Math.round(MIN_FREE_BYTES / 1048576)}MB），本轮跳过`);
        return;
      }
      // 互斥：与手动备份/恢复/清理同一把锁，忙时跳过本轮（下次定时再试），绝不并发写数据目录
      const r = await withLock({ root, op: 'auto-backup', fn: async () => {
        const b = createBackup({ scope: ['accounts', 'sessions', 'settings'], reason: 'scheduled', root });
        // createBackup 成功返回 { backupId, manifest }（无 ok 字段），以 backupId 判定
        if (b && b.backupId) {
          log(`[auto-backup] 成功 ${b.backupId}`);
          enforceRetention(root, retention, log);
          return { ok: true };
        }
        log(`[auto-backup] 失败: ${(b && b.error) || 'unknown'}`);
        return { ok: false, error: (b && b.error) || 'unknown' };
      } });
      if (r.error === 'BUSY') {
        log(`[auto-backup] 跳过本轮（${r.by ? r.by.op : 'unknown'} 持有操作锁）`);
        return;
      }
      if (r.ok) {
        if (failStreak > 0) log(`[auto-backup] 连续失败 ${failStreak} 次后恢复成功`);
        failStreak = 0;
      } else {
        // 失败：连续失败计数 + 指数退避尽快重试（不等下一个周期）
        failStreak++;
        const backoff = RETRY_BACKOFF_MS[Math.min(failStreak - 1, RETRY_BACKOFF_MS.length - 1)];
        log(`[auto-backup] 连续失败 ${failStreak} 次，${Math.round(backoff / 60000)}min 后重试`);
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          run();
        }, backoff);
        if (retryTimer.unref) retryTimer.unref();
      }
    } catch (e) {
      failStreak++;
      log(`[auto-backup] 异常: ${e.message}`);
    }
  };

  const schedule = () => {
    const settings = loadSettings(root);
    const ab = (settings && settings.autoBackup) || {};
    if (!ab.enabled) {
      log('[auto-backup] 未启用（Settings.autoBackup.enabled=false）');
      return;
    }
    if (ab.frequency === 'before-update') {
      log('[auto-backup] frequency=before-update（事件驱动：daemon 更新前已内置备份，不建周期定时器）');
      return;
    }
    const freqMs = ab.frequency === 'weekly' ? 7 * DAY_MS : DAY_MS; // daily 默认
    first = setTimeout(run, 30 * 1000);
    timer = setInterval(run, freqMs);
    if (timer.unref) timer.unref();
    if (first.unref) first.unref();
    log(`[auto-backup] 调度器启动（frequency=${ab.frequency}, retention=${Number(ab.retention) || 3}, 首次 30s 后）`);
  };

  schedule();
  return {
    stop: clearTimers,
    // 复查 P1：设置修改后由 api 层调用 —— 停旧定时器 → 重读设置 → 按新配置重排
    reload: () => {
      clearTimers();
      failStreak = 0;
      schedule();
      log('[auto-backup] 已按最新设置重排调度器');
    },
  };
}

module.exports = { startAutoBackup, enforceRetention, diskFreeBytes, RETRY_BACKOFF_MS, MIN_FREE_BYTES };
