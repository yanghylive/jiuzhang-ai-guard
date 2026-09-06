'use strict';
// 全局长操作注册表（能力提炼开发文档 §3.2 OperationRecord + §7）：
// 长操作（restore / handoff-apply / diagnostics-upload / backup ...）创建 operationId，
// 客户端轮询进度、请求取消、查看证据与回滚标记。
//
// 约束（与文档一致）：
//  - 状态只能由 daemon 写入（本模块即 daemon 侧执行）。
//  - 进程重启后遗留 running/queued 一律降级为 unknown，绝不自动重试。
//  - 持久化 runtime/operations/<id>.json（该目录同时被诊断收集读取：字段 type/status/errorCode 对齐）。
const fs = require('node:fs');
const path = require('node:path');
const { dataRoot, uuid, readJSON, atomicWriteJSON } = require('./lib');

const OP_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天
const OP_MAX_KEEP = 50; // 最多保留 50 条

function opsDir(root) {
  return path.join(root || dataRoot(), 'runtime', 'operations');
}

// 第七轮复核 P2：operationId 严格校验（操作 ID 是内部生成的 uuid；外部传入时必须
// 精确匹配，不再清洗非法字符——清洗会造成 ID 别名与误操作）。
function validOpId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

function opPath(root, id) {
  if (!validOpId(id)) return null;
  return path.join(opsDir(root), `${id}.json`);
}

function loadOp(root, id) {
  const p = opPath(root, id);
  return p ? readJSON(p) : null; // 非法 id → 不存在（与文件缺失同语义）
}

function saveOp(root, rec) {
  atomicWriteJSON(opPath(root, rec.operationId), rec);
}

// 创建：status=running（长操作进入即视为开始）。
function beginOperation({ root, type, label, total = 1 } = {}) {
  root = root || dataRoot();
  const rec = {
    operationId: uuid(),
    type: String(type || 'operation'),
    label: String(label || ''),
    status: 'running',
    requestedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { current: 0, total, label: '' },
    cancelRequested: false,
    evidence: [],
    changed: [],
    rollbackAvailable: false,
    errorCode: null,
  };
  saveOp(root, rec);
  return rec;
}

function getOperation({ root, operationId } = {}) {
  root = root || dataRoot();
  const rec = loadOp(root, operationId);
  if (!rec) return { ok: false, error: 'OPERATION_NOT_FOUND' };
  return { ok: true, operation: rec };
}

function updateOperation({ root, operationId, patch } = {}) {
  root = root || dataRoot();
  const rec = loadOp(root, operationId);
  if (!rec) return { ok: false, error: 'OPERATION_NOT_FOUND' };
  let next = Object.assign({}, rec, patch);
  if (patch && patch.progress) next.progress = Object.assign({}, rec.progress, patch.progress);
  saveOp(root, next);
  return { ok: true, operation: next };
}

function completeOperation({ root, operationId, status, errorCode, evidence, changed, rollbackAvailable, progress, detail } = {}) {
  const patch = {
    status: status || 'succeeded',
    finishedAt: new Date().toISOString(),
    errorCode: errorCode || null,
  };
  if (evidence !== undefined) patch.evidence = evidence;
  if (changed !== undefined) patch.changed = changed;
  if (rollbackAvailable !== undefined) patch.rollbackAvailable = rollbackAvailable;
  if (progress !== undefined) patch.progress = Object.assign({}, progress);
  if (detail !== undefined) patch.errorDetail = String(detail).slice(0, 200);
  return updateOperation({ root, operationId, patch });
}

function failOperation({ root, operationId, errorCode, detail } = {}) {
  return completeOperation({ root, operationId, status: 'failed', errorCode: errorCode || 'FAILED', detail });
}

// 请求取消：仅置标记；实际中断由执行方在进度检查点配合（结果以最终状态为准）。
function cancelOperation({ root, operationId, reason } = {}) {
  return updateOperation({ root, operationId, patch: { cancelRequested: true, cancelReason: String(reason || '').slice(0, 120) } });
}

function isCancelRequested({ root, operationId } = {}) {
  const rec = loadOp(root || dataRoot(), operationId);
  return !!(rec && rec.cancelRequested);
}

function listOperations({ root, limit = 20 } = {}) {
  root = root || dataRoot();
  let names = [];
  try {
    names = fs.readdirSync(opsDir(root)).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return { ok: true, operations: [] };
  }
  const ops = names.slice(0, limit).map((f) => loadOp(root, f.replace(/\.json$/, ''))).filter(Boolean);
  return { ok: true, operations: ops };
}

// 启动降级：遗留 running/queued → unknown（重启后无法恢复观察，绝不自动重试）
function degradeStaleOnStart({ root, log = () => {} } = {}) {
  root = root || dataRoot();
  let names = [];
  try {
    names = fs.readdirSync(opsDir(root)).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const f of names) {
    const rec = loadOp(root, f.replace(/\.json$/, ''));
    if (rec && (rec.status === 'running' || rec.status === 'queued')) {
      saveOp(root, Object.assign({}, rec, {
        status: 'unknown',
        errorCode: rec.errorCode || 'INTERRUPTED',
        finishedAt: new Date().toISOString(),
        note: 'daemon 重启，无法恢复观察（不自动重试）',
      }));
      if (log) log(`[operation] ${String(rec.operationId).slice(0, 8)} ${rec.type} running→unknown（重启降级）`);
    }
  }
}

// TTL 清理：超过保留数/7 天删除
function sweepOperations({ root } = {}) {
  root = root || dataRoot();
  const now = Date.now();
  let names = [];
  try {
    names = fs.readdirSync(opsDir(root)).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  const byMtime = names
    .map((f) => { let m = 0; try { m = fs.statSync(path.join(opsDir(root), f)).mtimeMs; } catch {} return { f, m }; })
    .sort((a, b) => b.m - a.m);
  byMtime.slice(OP_MAX_KEEP).forEach((x) => {
    if (now - x.m > OP_TTL_MS) {
      try { fs.rmSync(path.join(opsDir(root), x.f), { force: true }); } catch {}
    }
  });
}

module.exports = {
  OP_TTL_MS,
  beginOperation,
  getOperation,
  updateOperation,
  completeOperation,
  failOperation,
  cancelOperation,
  isCancelRequested,
  listOperations,
  degradeStaleOnStart,
  sweepOperations,
};
