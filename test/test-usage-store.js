'use strict';
// usage-store 回归（V1.1，§5.3-6 运行证据 + skill-manager 热度/吃灰方法论）：
// 埋点落盘/轮转、聚合（总数/按日/Top/耗时 p95）、吃灰预警关联、HTTP 全链路（真请求产生真埋点）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { recordUsage, summarizeUsage, staleAssets, readRange, dayFile, usageDir } = require('../scripts/jz/usage-store');
const { addAsset } = require('../scripts/jz/asset-store');
const { startRouterServer, jzFetch } = require('./_helpers');

function freshRoot() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-usage-'));
}

test('recordUsage：落盘 jsonl + 每日轮转 + 敏感值不记录', () => {
  const root = freshRoot();
  recordUsage({ method: 'POST', pathname: '/api/memory/add', status: 200, durationMs: 12, requestId: 'r1', root });
  recordUsage({ method: 'GET', pathname: '/api/assets', status: 200, durationMs: 5, requestId: 'r2', root });
  const f = dayFile(root);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, '两条埋点落盘');
  const first = JSON.parse(lines[0]);
  assert.equal(first.method, 'POST');
  assert.equal(first.pathname, '/api/memory/add');
  assert.equal(first.durationMs, 12);
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(!raw.includes('x-jz-token') && !raw.includes('authorization'), '不记录任何头/凭据');
  // 每日文件轮转：改日期文件内容不变
  const dir = usageDir(root);
  assert.ok(fs.readdirSync(dir).length >= 1);
});

test('summarizeUsage：聚合总数/按日/Top 路径/p95', () => {
  const root = freshRoot();
  for (let i = 0; i < 10; i++) {
    recordUsage({ method: 'GET', pathname: '/api/vault/backups', status: 200, durationMs: 10, root });
  }
  for (let i = 0; i < 3; i++) {
    recordUsage({ method: 'GET', pathname: '/api/assets', status: 200, durationMs: 100, root });
  }
  recordUsage({ method: 'GET', pathname: '/api/broken', status: 502, durationMs: 200, root });
  const r = summarizeUsage({ days: 7, root });
  assert.equal(r.ok, true);
  assert.equal(r.summary.total, 14);
  assert.equal(r.summary.errors, 1, '5xx 计入错误');
  assert.equal(r.summary.topPaths[0].path, '/api/vault/backups');
  assert.equal(r.summary.topPaths[0].count, 10);
  assert.ok(r.summary.byDay.length >= 1, '按日统计存在');
  assert.ok(r.summary.p95DurationMs >= 100, 'p95 反映长耗时');
});

test('staleAssets：N 天零调用预警 + 近期调用豁免', () => {
  const root = freshRoot();
  const a1 = addAsset({ kind: 'prompt', title: '吃灰模板', content: '内容', sourceRefs: ['t1'], root });
  const a2 = addAsset({ kind: 'workflow', title: '活跃流程', content: '内容', sourceRefs: ['t2'], root });
  // a2 有近期调用（enable 路径带 assetId）
  recordUsage({ method: 'POST', pathname: `/api/assets/${a2.asset.assetId}/enable`, status: 200, durationMs: 8, root });
  const r = staleAssets({ days: 60, assets: [a1.asset, a2.asset], root });
  assert.equal(r.ok, true);
  const ids = r.stale.map((x) => x.assetId);
  assert.ok(ids.includes(a1.asset.assetId), '零调用资产进吃灰清单');
  assert.ok(!ids.includes(a2.asset.assetId), '有调用资产豁免');
});

test('HTTP 全链路：真实请求产生真实埋点 → summary 可查', async () => {
  const root = freshRoot();
  const TOKEN = crypto.randomBytes(32).toString('hex');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    // 真实请求（产生埋点）
    await jzFetch(s.baseUrl, '/api/memory/list', { method: 'GET', token: TOKEN });
    await jzFetch(s.baseUrl, '/api/assets', { method: 'GET', token: TOKEN });
    await jzFetch(s.baseUrl, '/api/health/check', { method: 'POST', token: TOKEN, body: { profile: 'workbuddy-cn' } });
    // 埋点已落盘
    const recs = readRange(root, 1);
    assert.ok(recs.length >= 3, `至少 3 条埋点，实际 ${recs.length}`);
    // summary 反映
    const sum = await (await jzFetch(s.baseUrl, '/api/usage/summary?days=1', { method: 'GET', token: TOKEN })).json();
    assert.ok(sum.data.total >= 3, `summary.total=${sum.data.total} ≥3`);
    assert.ok(sum.data.topPaths.some((t) => t.path === '/api/memory/list'), 'Top 路径含 memory/list');
  } finally {
    await s.close();
  }
});
