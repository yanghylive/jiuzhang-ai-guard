'use strict';
// asset-store 回归（V1.0 统一资产仓库，能力提炼开发文档 §3.3 DistilledAsset / §5.3）：
// kind 白名单/来源必填/敏感 fail-closed/覆盖三态/版本化+回滚/状态流转/HTTP 全链路。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  addAsset,
  listAssets,
  getAsset,
  searchAssets,
  recallAssets,
  updateAssetStatus,
  updateAssetVersion,
  rollbackAsset,
  KIND_WHITELIST,
  STATUS_WHITELIST,
} = require('../scripts/jz/asset-store');
const { startRouterServer, jzFetch } = require('./_helpers');

function freshRoot() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-ast-'));
}

function wfAsset(root, over = {}) {
  return addAsset({
    kind: 'workflow',
    title: '竞品调研周报',
    content: '每周一抓竞品动态生成调研报告',
    steps: [
      { stepId: 's1', action: '搜索', object: '竞品动态', params: '关键词=竞品名', tool: 'web-search' },
      { stepId: 's2', action: '汇总', object: '调研报告', params: '模板=周报模板', tool: 'doc' },
    ],
    inputs: ['竞品名列表'],
    outputs: ['调研报告.md'],
    sourceRefs: ['task-flow1'],
    tags: ['workflow', '竞品'],
    importance: 8,
    permissions: ['self'],
    risk: 'low',
    coverage: 'none',
    root,
    ...over,
  });
}

test('addAsset：kind 白名单 + 来源必填 + 覆盖三态默认 none + 落盘 checksum', () => {
  const root = freshRoot();
  const badKind = addAsset({ kind: 'hack', title: 'x', sourceRefs: ['t1'], root });
  assert.equal(badKind.ok, false);
  assert.equal(badKind.error, 'INVALID_KIND');
  const noRef = addAsset({ kind: 'workflow', title: 'x', root });
  assert.equal(noRef.error, 'SOURCE_REFS_REQUIRED');

  const r = wfAsset(root);
  assert.equal(r.ok, true);
  assert.match(r.asset.assetId, /^ast-/);
  assert.equal(r.asset.status, 'draft', 'extract 默认草稿不启用（§5.3-4）');
  assert.equal(r.asset.coverage, 'none');
  assert.equal(r.asset.version, 1);
  assert.equal(r.asset.steps.length, 2, '结构化 steps 落库');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'assets', `${r.asset.assetId}.json`), 'utf8'));
  assert.equal(onDisk.checksum.length, 64);
});

test('addAsset：敏感内容 fail-closed（steps/正文联合扫描）', () => {
  const root = freshRoot();
  const r = addAsset({
    kind: 'workflow',
    title: 'x',
    content: '正常内容',
    steps: [{ stepId: 's1', action: '读取', object: '配置', params: 'token=kda_AbCdEf12345678901234' }],
    sourceRefs: ['task-sec3'],
    root,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'SENSITIVE_CONTENT', 'steps 里的凭据同样拒绝');
});

test('版本化 + 回滚：同源再次提交 version+1 归档历史；rollback 恢复上一版本', () => {
  const root = freshRoot();
  const a = wfAsset(root);
  const id = a.asset.assetId;

  // 无历史 → NO_HISTORY
  const rb0 = rollbackAsset(id, { root });
  assert.equal(rb0.ok, false);
  assert.equal(rb0.error, 'NO_HISTORY');

  // v1 → v2（内容更新）
  const v2 = updateAssetVersion(id, { content: '每周一抓竞品动态+行业新闻生成调研报告', steps: a.asset.steps, root });
  assert.equal(v2.ok, true);
  assert.equal(v2.asset.version, 2);
  assert.ok(v2.asset.content.includes('行业新闻'), 'v2 内容已更新');
  assert.ok(fs.existsSync(path.join(root, 'runtime', 'assets', `${id}.history`, 'v1.json')), 'v1 快照已归档');

  // 回滚 → v3（内容 = v1），且保留回滚痕迹
  const rb = rollbackAsset(id, { root });
  assert.equal(rb.ok, true);
  assert.equal(rb.asset.version, 3);
  assert.ok(!rb.asset.content.includes('行业新闻'), '回滚后内容回到 v1');
  assert.equal(rb.rolledBackFrom, 2);

  // 篡改后版本化/回滚一律 409
  const p = path.join(root, 'runtime', 'assets', `${id}.json`);
  const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
  cur.content = '被人改了';
  fs.writeFileSync(p, JSON.stringify(cur, null, 2));
  assert.equal(updateAssetVersion(id, { content: 'x', root }).error, 'ASSET_TAMPERED');
  assert.equal(rollbackAsset(id, { root }).error, 'ASSET_TAMPERED');
  assert.equal(updateAssetStatus(id, 'enabled', { root }).error, 'ASSET_TAMPERED');
});

test('searchAssets：工作流步骤可检索 + 默认只搜 enabled + recall 统计', () => {
  const root = freshRoot();
  const a1 = wfAsset(root);
  const a2 = addAsset({ kind: 'prompt', title: '会议纪要模板', content: '按角色拆分待办', sourceRefs: ['task-p1'], tags: ['prompt'], importance: 4, root });
  // kind 过滤
  // enable 后才参与检索（§5.3-4 草稿默认不启用）
  updateAssetStatus(a1.asset.assetId, 'enabled', { root });
  const wfs = searchAssets({ query: '竞品', kind: 'workflow', root });
  assert.equal(wfs.assets.length, 1);
  assert.equal(wfs.assets[0].kind, 'workflow');
  // 未启用的 prompt 草稿搜不到（kind 无关，状态过滤）
  const all = searchAssets({ query: '会议纪要', root });
  assert.equal(all.assets.length, 0, '草稿默认不参与检索（§5.3-4 默认不启用）');
  const hit = recallAssets({ query: '竞品调研周报', kind: 'workflow', root });
  assert.equal(hit.assets.length, 1);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'assets', `${a1.asset.assetId}.json`), 'utf8'));
  assert.equal(onDisk.recallCount, 1);
});

test('HTTP 全链路：extract → list → get → review/enable → version → rollback + 幂等 + 敏感拒绝', async () => {
  const root = freshRoot();
  const TOKEN = crypto.randomBytes(32).toString('hex');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    // extract（幂等）
    const ex = await jzFetch(s.baseUrl, '/api/assets/extract', {
      method: 'POST', token: TOKEN,
      body: {
        kind: 'workflow', title: 'HTTP 流程', content: '从 HTTP 提取的流程资产',
        steps: [{ stepId: 's1', action: '生成', object: '草稿', params: '模板=通用' }],
        sourceRefs: ['task-http2'], tags: ['http'], importance: 5,
        idempotencyKey: 'asset-key-01',
      },
    });
    const ej = await ex.json();
    assert.equal(ex.status, 200);
    assert.ok(ej.data.assetId);
    const replay = await (await jzFetch(s.baseUrl, '/api/assets/extract', {
      method: 'POST', token: TOKEN,
      body: {
        kind: 'workflow', title: 'HTTP 流程', content: '从 HTTP 提取的流程资产',
        steps: [{ stepId: 's1', action: '生成', object: '草稿', params: '模板=通用' }],
        sourceRefs: ['task-http2'], tags: ['http'], importance: 5,
        idempotencyKey: 'asset-key-01',
      },
    })).json();
    assert.equal(replay.data.assetId, ej.data.assetId, '同幂等键重放返回同一资产');

    // 非法 kind / 敏感
    assert.equal((await (await jzFetch(s.baseUrl, '/api/assets/extract', { method: 'POST', token: TOKEN, body: { kind: 'nope', title: 'x', sourceRefs: ['t'], idempotencyKey: 'k2' } })).json()).error, 'INVALID_KIND');
    assert.equal((await (await jzFetch(s.baseUrl, '/api/assets/extract', { method: 'POST', token: TOKEN, body: { kind: 'prompt', title: 'x', content: 'token kda_AbCdEf12345678901234', sourceRefs: ['t'], idempotencyKey: 'k3' } })).json()).error, 'SENSITIVE_CONTENT');

    // list（kind 过滤）+ get
    const list = await (await jzFetch(s.baseUrl, '/api/assets?kind=workflow', { method: 'GET', token: TOKEN })).json();
    assert.equal(list.data.assets.length, 1);
    const one = await (await jzFetch(s.baseUrl, `/api/assets/${ej.data.assetId}`, { method: 'GET', token: TOKEN })).json();
    assert.equal(one.data.assetId, ej.data.assetId);

    // review / enable 别名 + version + rollback
    assert.equal((await jzFetch(s.baseUrl, `/api/assets/${ej.data.assetId}/review`, { method: 'POST', token: TOKEN, body: {} })).status, 200);
    const en = await (await jzFetch(s.baseUrl, `/api/assets/${ej.data.assetId}/enable`, { method: 'POST', token: TOKEN, body: {} })).json();
    assert.equal(en.data.status, 'enabled');
    const ver = await (await jzFetch(s.baseUrl, `/api/assets/${ej.data.assetId}/version`, { method: 'POST', token: TOKEN, body: { content: 'v2 内容', steps: [{ stepId: 's1', action: '生成', object: '草稿', params: '模板=通用' }], idempotencyKey: 'asset-ver-01' } })).json();
    assert.equal(ver.data.version, 2);
    const rb = await (await jzFetch(s.baseUrl, `/api/assets/${ej.data.assetId}/rollback`, { method: 'POST', token: TOKEN, body: { idempotencyKey: 'asset-rb-01' } })).json();
    assert.equal(rb.data.version, 3);
    assert.ok(!rb.data.content.includes('v2'), '回滚后内容回到 v1');
  } finally {
    await s.close();
  }
});

test('policy 门禁：低分资产禁止直接启用；高分放行', () => {
  const root = freshRoot();
  // 低分：未知来源 + 超大体积
  const low = addAsset({ kind: 'prompt', title: '来源不明模板', content: '一段模板', sourceRefs: ['task-pl1'], policy: { source: 'unknown', fileSizeBytes: 1500000 }, root });
  assert.equal(low.ok, true);
  assert.ok(low.asset.trustScore < 60, `低分资产 trustScore=${low.asset.trustScore} < 60（无来源信任）`);
  const blocked = updateAssetStatus(low.asset.assetId, 'enabled', { root });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'ENABLE_BLOCKED_BY_POLICY', '低分资产直接启用必须被拦');
  // 先 review 再 enabled 也拦（门禁挂在 enabled 上）
  updateAssetStatus(low.asset.assetId, 'review', { root });
  assert.equal(updateAssetStatus(low.asset.assetId, 'enabled', { root }).error, 'ENABLE_BLOCKED_BY_POLICY');

  // 高分：skillhub + 完整元数据
  const hi = addAsset({ kind: 'prompt', title: '官方高分模板', content: '功能描述足够详细的模板正文内容', sourceRefs: ['task-ph1'], policy: { source: 'skillhub', version: '1.0.0', description: '详细描述文本超过二十个字符的长度', usage: '使用方法', installedAt: '2026-08-01', fileSizeBytes: 5000 }, root });
  assert.ok(hi.asset.trustScore >= 70, `高分资产 trustScore=${hi.asset.trustScore}`);
  const ok = updateAssetStatus(hi.asset.assetId, 'enabled', { root });
  assert.equal(ok.ok, true, '高分资产可直接启用');
  assert.equal(ok.asset.status, 'enabled');
});
