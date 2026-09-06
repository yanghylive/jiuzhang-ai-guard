'use strict';
// usage-store：本地用量埋点与聚合（V1.1 第一部分，能力提炼开发文档 §5.3-6"每次运行写入
// 运行证据" + workbuddy-skill-manager 的热度/趋势/吃灰预警方法论；只取方法论不搬代码）。
//
// 埋点原则：
// 1. 只记录 method/pathname/status/durationMs/at/requestId —— 不记录 query 参数、
//    body、header（不落任何敏感值）。
// 2. 追加写 runtime/usage/YYYY-MM-DD.jsonl（每日文件，惰性轮转），appendFileSync
//    不 fsync（性能优先，极端掉电丢失最近一条可接受——统计语义）。
// 3. 路径保留资产/记忆 ID（ast-xxx/mem-xxx）用于吃灰预警关联，不脱敏——本地运行证据。
// 4. env JZ_USAGE_DISABLED=1 可关。
const path = require('node:path');
const fs = require('node:fs');
const { dataRoot } = require('./lib');

const USAGE_DIR = 'runtime/usage';
const DAY_MS = 24 * 60 * 60 * 1000;

function usageDir(root) {
  return path.join(root || dataRoot(), USAGE_DIR);
}

function dayFile(root, at = new Date()) {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return path.join(usageDir(root), `${y}-${m}-${d}.jsonl`);
}

function enabled() {
  return process.env.JZ_USAGE_DISABLED !== '1';
}

// 记录一次请求（同步追加；失败静默——埋点不阻断业务）
function recordUsage({ method, pathname, status, durationMs, requestId, root } = {}) {
  if (!enabled()) return;
  const rec = {
    at: new Date().toISOString(),
    method: String(method || 'GET'),
    pathname: String(pathname || '/'),
    status: Number(status) || 0,
    durationMs: Math.round(Number(durationMs) || 0),
    requestId: String(requestId || ''),
  };
  try {
    fs.mkdirSync(usageDir(root), { recursive: true });
    fs.appendFileSync(dayFile(root), JSON.stringify(rec) + '\n');
  } catch { /* 埋点失败静默 */ }
}

// 读取 [days] 天的记录（含今天）
function readRange(root, days = 7) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const f = dayFile(root, d);
    let lines = [];
    try {
      lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    } catch { continue; }
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec && rec.at) out.push(rec);
      } catch { /* 坏行跳过 */ }
    }
  }
  return out;
}

function p95(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

// 聚合摘要（skill-manager 热度/趋势方法论）：总数/按日/按路径 Top/平均与 p95 耗时
function summarizeUsage({ days = 7, root } = {}) {
  const recs = readRange(root, Math.max(1, Math.min(90, Number(days) || 7)));
  const byDay = new Map();
  const byPath = new Map();
  const durations = [];
  let total = 0;
  let errors = 0;
  for (const r of recs) {
    total++;
    if (r.status >= 500) errors++;
    const day = String(r.at).slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
    const p = r.pathname.split('?')[0];
    const key = `${r.method} ${p}`;
    if (!byPath.has(key)) byPath.set(key, { method: r.method, path: p, count: 0, totalMs: 0 });
    const e = byPath.get(key);
    e.count++;
    e.totalMs += r.durationMs || 0;
    durations.push(r.durationMs || 0);
  }
  const topPaths = [...byPath.values()]
    .map((e) => ({ ...e, avgMs: Math.round(e.totalMs / e.count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return {
    ok: true,
    summary: {
      days: Number(days),
      total,
      errors,
      avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      p95DurationMs: p95(durations),
      byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count })),
      topPaths,
    },
  };
}

// 吃灰预警（skill-manager 方法论）：资产库中 N 天零调用的资产
// 关联：usage 路径含 /api/assets/ast-xxx（enable/version/rollback 等）→ 资产最近调用时间
function staleAssets({ days = 60, assets = [], root } = {}) {
  const recs = readRange(root, Math.max(1, Math.min(365, Number(days) || 60)));
  const recentAssets = new Set();
  for (const r of recs) {
    const m = String(r.pathname).match(/\/(ast-[A-Za-z0-9-]{8,})/);
    if (m) recentAssets.add(m[1]);
  }
  const stale = [];
  for (const a of assets) {
    if (!a || !a.assetId) continue;
    if (!recentAssets.has(a.assetId)) {
      stale.push({ assetId: a.assetId, title: a.title || '', kind: a.kind || '', status: a.status || '' });
    }
  }
  return { ok: true, stale };
}

module.exports = { recordUsage, summarizeUsage, staleAssets, readRange, usageDir, dayFile };
