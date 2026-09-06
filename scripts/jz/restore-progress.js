'use strict';
// 恢复进度标记（06-D59）：恢复中断/失败后，下次启动可见「恢复未完成」状态，且绝不自动继续。
// in-progress.json：存在 = 有恢复正在进行（启动时告警）；恢复成功后删除。
// last.json：最近一次恢复摘要（审计/提示回滚入口，保留）。
const fs = require('node:fs');
const path = require('node:path');
const { dataRoot, atomicWriteJSON, readJSON } = require('./lib');

function progressDir(root) {
  return path.join(root || dataRoot(), 'runtime', 'restore-progress');
}

function beginRestoreProgress({ backupId, snapshotId, root }) {
  try {
    fs.mkdirSync(progressDir(root), { recursive: true });
    atomicWriteJSON(path.join(progressDir(root), 'in-progress.json'), {
      backupId: String(backupId || ''),
      snapshotId: String(snapshotId || ''),
      startedAt: new Date().toISOString(),
    });
  } catch {
    /* 标记写入失败不阻断恢复本身 */
  }
}

function finishRestoreProgress({ backupId, snapshotId, restored, skipped, root }) {
  try {
    fs.rmSync(path.join(progressDir(root), 'in-progress.json'), { force: true });
    atomicWriteJSON(path.join(progressDir(root), 'last.json'), {
      backupId: String(backupId || ''),
      snapshotId: String(snapshotId || ''),
      finishedAt: new Date().toISOString(),
      restored,
      skipped,
    });
  } catch {
    /* 失败记录写入失败不阻断 */
  }
}

// 恢复失败落标记（指导 §8）：in-progress.json 改写为 failed 状态保留，供 UI/启动告警显示「恢复未完成」；
// 回滚也失败时 fail reason 带 rollback_failed，快照目录保留供人工恢复。
function failRestoreProgress({ backupId, snapshotId, reason, root }) {
  try {
    fs.mkdirSync(progressDir(root), { recursive: true });
    atomicWriteJSON(path.join(progressDir(root), 'in-progress.json'), {
      backupId: String(backupId || ''),
      snapshotId: String(snapshotId || ''),
      startedAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      status: 'failed',
      reason: String(reason || 'unknown'),
    });
  } catch {
    /* 标记写入失败不抛出 */
  }
}

// 返回当前恢复状态：pending（进行中/中断/失败未处理）| idle（无进行中）。
// failed=true 表示上次恢复失败（含回滚失败），UI 必须显示「恢复未完成」，绝不自动继续。
function getRestoreProgress(root) {
  const dir = progressDir(root);
  const inProgress = readJSON(path.join(dir, 'in-progress.json'));
  const last = readJSON(path.join(dir, 'last.json'));
  if (inProgress) {
    return { pending: true, failed: inProgress.status === 'failed', inProgress, last };
  }
  return { pending: false, failed: false, inProgress: null, last };
}

module.exports = { beginRestoreProgress, finishRestoreProgress, failRestoreProgress, getRestoreProgress };
