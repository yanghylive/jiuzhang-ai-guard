'use strict';
// memory-store：来源可追溯记忆（V1.0 第一模块）。
// 2026-08-29 收敛：统一资产仓库 asset-store 落地后，本模块退化为 kind='memory'
// 的薄封装（保留导出签名与对外契约完全兼容：memoryId/text 字段、MEMORY_TAMPERED
// 错误码，既有测试与文档不破坏）。全部能力在 asset-store.js 统一实现。
const { addAsset, listAssets, getAsset, searchAssets, recallAssets, updateAssetStatus, tokenize, STATUS_WHITELIST } = require('./asset-store');

// 对外字段映射：assetId→memoryId、content→text（兼容既有记忆契约）
function toMemory(asset) {
  if (!asset) return asset;
  const { assetId, content, ...rest } = asset;
  return { ...rest, memoryId: assetId, text: content };
}

// 新建记忆（来源必填；敏感内容 fail-closed）
function addMemory({ title, text, sourceRefs, tags = [], importance = 1, root } = {}) {
  const r = addAsset({ kind: 'memory', title, content: text, sourceRefs, tags, importance, root });
  return r.ok ? { ok: true, memory: toMemory(r.asset) } : r;
}

function listMemories({ status, tag, root } = {}) {
  const r = listAssets({ kind: 'memory', status, tag, root });
  return { ok: true, memories: r.assets.map(toMemory) };
}

function getMemory(memoryId, { root } = {}) {
  const id = String(memoryId || '').replace(/^mem-/, 'ast-');
  if (!/^ast-[A-Za-z0-9-]{8,}$/.test(id)) return { ok: false, error: 'INVALID_ID' };
  const r = getAsset(id, { root });
  return r.ok ? { ok: true, memory: toMemory(r.asset) } : r;
}

function searchMemories({ query, status = 'enabled', limit = 10, root } = {}) {
  const r = searchAssets({ query, kind: 'memory', status, limit, root });
  return r.ok ? { ok: true, memories: r.assets.map(toMemory) } : r;
}

function recallForWork({ taskText, limit = 5, root } = {}) {
  const r = recallAssets({ query: taskText, kind: 'memory', limit, root });
  return r.ok ? { ok: true, memories: r.assets.map(toMemory) } : r;
}

function updateMemoryStatus(memoryId, status, { root } = {}) {
  const id = String(memoryId || '').replace(/^mem-/, 'ast-');
  if (!/^ast-[A-Za-z0-9-]{8,}$/.test(id)) return { ok: false, error: 'INVALID_ID' };
  const r = updateAssetStatus(id, status, { root });
  if (r.ok) return { ok: true, memory: toMemory(r.asset) };
  if (r.error === 'ASSET_TAMPERED') return { ok: false, error: 'MEMORY_TAMPERED' }; // 兼容既有契约错误码
  return r;
}

module.exports = {
  addMemory,
  listMemories,
  getMemory,
  searchMemories,
  recallForWork,
  updateMemoryStatus,
  tokenize,
  STATUS_WHITELIST,
};
