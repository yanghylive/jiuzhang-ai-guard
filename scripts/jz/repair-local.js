'use strict';
// 本地修复执行器（03 §4）：无需宿主能力的修复动作，在 jz 侧真实执行（不再 not_supported）。
// 原则：只做安全、可回滚、可验证的动作；任何失败如实返回 failed，绝不假成功。
const fs = require('node:fs');
const path = require('node:path');
const { listBackups, previewRestore, restoreBackup, verifyBackup } = require('./backup-vault');
const { workbuddyDir, isPhysicallyRealPath } = require('./lib');

const STALE_RUNTIME_MS = Number(process.env.JZ_STALE_RUNTIME_MS) || 7 * 24 * 3600 * 1000;

// enter-safe-mode：由 api.js 注入（状态在 router 闭包），本模块只提供约束说明。
// cleanup-stale-runtime：递归清理 runtime/ 下超过 7 天的操作记录与残留锁（保留 safe-mode.json）。
function cleanupStaleRuntime(root) {
  const runtimeDir = path.join(root, 'runtime');
  // 2026-08-30 第六轮复核 P0：runtime（或 root 父级链）是符号链接时拒绝清理——
  // 旧实现会删除链接指向的外部旧文件。
  if (!isPhysicallyRealPath(runtimeDir)) {
    return { ok: false, error: 'RUNTIME_SYMLINK', note: 'runtime 目录含符号链接，拒绝清理（防逃逸）', removed: 0 };
  }
  if (!fs.existsSync(runtimeDir)) return { ok: true, note: 'runtime 目录不存在，无需清理', removed: 0 };
  const now = Date.now();
  let removed = 0;
  const kept = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (e.name === 'safe-mode.json') {
        kept.push(e.name);
        continue;
      }
      if (now - st.mtimeMs > STALE_RUNTIME_MS) {
        try {
          fs.rmSync(full, { force: true });
          removed++;
        } catch {
          /* 单项失败继续 */
        }
      } else {
        kept.push(e.name);
      }
    }
  };
  walk(runtimeDir);
  return { ok: true, note: `清理 ${removed} 项过期运行时，保留 ${kept.join(',') || '空'}`, removed };
}

// repair-workdaddy-directory-permission：数据根 + backups 权限收紧 0700（防其他用户读敏感数据）。
function repairDirPermission(root) {
  const targets = [root, path.join(root, 'backups'), path.join(root, 'license'), path.join(root, 'runtime')];
  let fixed = 0;
  const errors = [];
  for (const t of targets) {
    try {
      // 2026-08-30 第五轮复核 P1：lstat 物理校验——目标是符号链接时跳过，
      // 绝不 chmod 到允许根目录之外的外部目录。
      const lst = fs.lstatSync(t);
      if (lst.isSymbolicLink()) {
        errors.push(`${t}: 符号链接，跳过权限修复（防越界）`);
        continue;
      }
      const mode = lst.mode & 0o777;
      if (mode !== 0o700) {
        fs.chmodSync(t, 0o700);
        fixed++;
      }
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      errors.push(`${t}: ${e.message}`);
    }
  }
  if (errors.length) return { ok: false, error: 'PERMISSION_FIX_FAILED', detail: errors.join('; ') };
  return { ok: true, note: `修复 ${fixed} 个目录权限为 0700`, fixed };
}

// restore-latest-config / restore-account-backup：从最近一次成功备份恢复（keep-current 不覆盖冲突）。
// 走真实 preview + applyToReal（原子替换 + 快照），与手工恢复同一路径。
async function restoreLatest(root, scopeType, wbDir) {
  const backups = listBackups(root) || [];
  const candidates = backups
    .filter((b) => b && Array.isArray(b.items) && b.items.some((it) => (it.scopeType || 'settings') === scopeType))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!candidates.length) {
    return { ok: false, error: 'NO_BACKUP', note: `没有 ${scopeType} 作用域的备份可恢复` };
  }
  const backupId = candidates[0].backupId || candidates[0].id;
  const v = verifyBackup({ backupId, root });
  if (!v.ok) return { ok: false, error: 'BACKUP_CORRUPTED', detail: '最近备份校验失败，不恢复' };
  const preview = await previewRestore({ backupId, root, wbDir });
  if (!preview.ok) return preview;
  const r = await restoreBackup({ backupId, root, wbDir, applyToReal: true, conflictPolicy: 'keep-current' });
  if (!r.ok) return r;
  return {
    ok: true,
    backupId,
    scopeType,
    restored: r.restored,
    skipped: r.skipped,
    snapshotId: r.snapshotId,
    summary: preview.summary,
    note: `从备份 ${String(backupId).slice(0, 8)} 恢复 ${scopeType}（keep-current）`,
  };
}

// rollback-component：回滚最近一次恢复操作（组件级变更）。
// restoreBackup 恢复前会把目标当前内容快照到 quarantine/restore-snapshot-<id>/（相对路径），
// 本动作把最近快照原子替换回目标位置；回滚前再把当前状态备份到 quarantine/rollback-current-*（可二次回滚）。
function rollbackComponent(root, wbDir) {
  const quarantineDir = path.join(root, 'quarantine');
  if (!fs.existsSync(quarantineDir)) return { ok: false, error: 'NO_SNAPSHOT', note: '没有可回滚的快照（最近未执行过恢复操作）' };
  const snaps = fs
    .readdirSync(quarantineDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('restore-snapshot-'))
    .sort((a, b) => {
      const am = fs.statSync(path.join(quarantineDir, a.name)).mtimeMs;
      const bm = fs.statSync(path.join(quarantineDir, b.name)).mtimeMs;
      return bm - am;
    });
  if (!snaps.length) return { ok: false, error: 'NO_SNAPSHOT', note: '没有可回滚的快照（最近未执行过恢复操作）' };
  const snapId = snaps[0].name;
  const snapDir = path.join(quarantineDir, snapId);
  const wb = wbDir || workbuddyDir();
  // 快照相对路径 → 目标基路径：accounts/* 与 sessions/* 落 WorkBuddy 目录，其余（settings 等）落数据根。
  // 路径统一转正斜杠再判断：Windows 上 path.relative 返回反斜杠（accounts\a.json），
  // 直接 startsWith('accounts/') 会漏判导致账号文件被错误回滚到数据根。
  const baseOf = (rel) => {
    const r = String(rel).split(path.sep).join('/');
    return r.startsWith('accounts/') || r.startsWith('sessions/') ? wb : root;
  };
  const rollbackId = `rollback-current-${Date.now()}`;
  const backupDir = path.join(quarantineDir, rollbackId);
  // 2026-08-30 第五轮复核 P0：目标根目录（wb/root）本身是符号链接时拒绝回滚写入
  //（与 restoreBackup 的 targetBaseOk 同一防线）。
  const baseOk = (base) => isPhysicallyRealPath(base); // 第六轮复核 P0：升级为物理 realpath 校验（父级链同查）
  const basesOk = baseOk(root) && baseOk(wb);
  if (!basesOk) {
    return { ok: false, error: 'RESTORE_FAILED', note: '回滚目标根目录是符号链接，拒绝写入（防逃逸）' };
  }
  fs.mkdirSync(backupDir, { recursive: true });
  let rolledBack = 0;
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      files.push(path.relative(snapDir, full));
    }
  };
  walk(snapDir);
  for (const rel of files) {
    const src = path.join(snapDir, rel);
    const dest = path.join(baseOf(rel), rel);
    try {
      // 当前状态备份（防呆：回滚错了还能再滚回）
      if (fs.existsSync(dest)) {
        const cur = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(cur), { recursive: true });
        fs.cpSync(dest, cur, { recursive: true, force: true });
      }
      // 原子替换回滚
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.jzrollback-${Date.now()}.tmp`;
      fs.copyFileSync(src, tmp);
      const fh = fs.openSync(tmp, 'r+');
      fs.fsyncSync(fh);
      fs.closeSync(fh);
      fs.renameSync(tmp, dest);
      rolledBack++;
    } catch (e) {
      return { ok: false, error: 'ROLLBACK_FAILED', detail: `${rel}: ${e.message}`, rolledBack };
    }
  }
  if (!rolledBack) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    return { ok: true, snapshotId: snapId, rolledBack: 0, note: '快照为空，无可回滚内容' };
  }
  return {
    ok: true,
    snapshotId: snapId,
    rolledBack,
    backupId: rollbackId,
    note: `回滚 ${rolledBack} 个文件（来自快照 ${snapId.slice(-8)}），当前状态已备份到 quarantine/${rollbackId}`,
  };
}

module.exports = { cleanupStaleRuntime, repairDirPermission, restoreLatest, rollbackComponent };
