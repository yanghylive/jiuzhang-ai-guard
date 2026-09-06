'use strict';
// model-fit 回归（V1.1，litellm-router 方法论）：
// 能力硬过滤（vision/tools/reasoning/context）、三维评分排序、偏好加权、内置兜底、HTTP 链路。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadModels, classifyTask, recommendModels, DEFAULT_MODELS } = require('../scripts/jz/model-fit');
const { startRouterServer, jzFetch } = require('./_helpers');

function tmpModels() {
  const p = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-mf-')), 'models.json');
  fs.writeFileSync(p, JSON.stringify([
    { id: 'pro-reason', name: 'Pro Reason', vendor: 'third-party', supportsReasoning: true, supportsToolCall: true, supportsImages: false, maxInputTokens: 131072, qualityHint: 'high' },
    { id: 'fast-lite', name: 'Fast Lite', vendor: 'third-party', supportsReasoning: false, supportsToolCall: true, supportsImages: false, maxInputTokens: 8192, qualityHint: 'medium' },
    { id: 'vision-pro', name: 'Vision Pro', vendor: 'third-party', supportsReasoning: true, supportsToolCall: true, supportsImages: true, maxInputTokens: 200000, qualityHint: 'high' },
    { id: 'local-q', name: 'Local Q', vendor: 'local', supportsReasoning: false, supportsToolCall: false, supportsImages: false, maxInputTokens: 32768, qualityHint: 'medium' },
    { id: 'no-tool', name: 'No Tool', vendor: 'third-party', supportsReasoning: true, supportsToolCall: false, supportsImages: false, maxInputTokens: 131072, qualityHint: 'high' },
  ]), 'utf8');
  return p;
}

test('loadModels：读文件归一化 + 缺省内置兜底', () => {
  const p = tmpModels();
  const r = loadModels({ modelsPath: p });
  assert.equal(r.ok, true);
  assert.equal(r.source, p);
  assert.equal(r.models.length, 5);
  assert.equal(r.models[0].supportsToolCall, true, '布尔归一化');
  const missing = loadModels({ modelsPath: '/nonexistent/models.json' });
  assert.equal(missing.source, 'builtin-default');
  assert.ok(missing.models.length >= 5, '内置默认表兜底');
});

test('classifyTask：关键词 → 需求集合', () => {
  assert.ok(classifyTask('帮我分析这堆数据的深层原因').has('quality'));
  assert.ok(classifyTask('看这张图片里有什么').has('vision'));
  assert.ok(classifyTask('写一段 python 脚本调用 api').has('tools'));
  assert.ok(classifyTask('总结这份 200 页文档').has('context'));
  assert.ok(classifyTask('快点回复').has('speed'));
  assert.ok(classifyTask('要省钱的方案').has('cost'));
  assert.ok(classifyTask('随便聊聊').has('chat'));
});

test('recommendModels：能力硬过滤（vision/tools/reasoning/context 缺能力必过滤）', () => {
  const p = tmpModels();
  // 视觉需求：只有 vision-pro
  const v = recommendModels({ task: '看图片', modelsPath: p });
  assert.equal(v.ok, true);
  assert.ok(v.recommendations.every((m) => m.supportsImages), '视觉需求只推荐 supportsImages=true');
  assert.equal(v.recommendations[0].id, 'vision-pro');
  // 深度推理：pro-reason/no-tool（vision-pro 也 reasoning）——no-tool 因 quality 需要 reasoning 通过
  const q = recommendModels({ task: '深度分析复杂逻辑', modelsPath: p });
  assert.ok(q.recommendations.every((m) => m.supportsReasoning), '推理需求只推荐 reasoning 模型');
  // 工具调用：no-tool 必须被过滤
  const t = recommendModels({ task: '调用工具写代码', modelsPath: p });
  assert.ok(t.recommendations.every((m) => m.supportsToolCall), '工具需求过滤 supportsToolCall=false');
  assert.ok(!t.recommendations.some((m) => m.id === 'no-tool'));
  // 长上下文：fast-lite（8k）被过滤
  const c = recommendModels({ task: '总结长文档', modelsPath: p });
  assert.ok(c.recommendations.every((m) => m.maxInputTokens >= 32768), '长上下文需求 ≥32k');
});

test('recommendModels：preference 影响排序（cost 偏好本地优先）', () => {
  const p = tmpModels();
  const cheap = recommendModels({ task: '要省钱的方案', preference: 'cost', modelsPath: p });
  assert.ok(cheap.recommendations[0].vendor === 'local', 'cost 偏好下本地模型排第一（实际 ' + cheap.recommendations[0].id + '）');
  const quick = recommendModels({ task: '要省钱的方案', preference: 'fast', modelsPath: p });
  const idxF = quick.recommendations.findIndex((m) => m.id === 'fast-lite');
  const idxP = quick.recommendations.findIndex((m) => m.id === 'pro-reason');
  assert.ok(idxF !== -1 && idxP !== -1 && idxF < idxP,
    'fast 偏好下轻量模型排在重推理模型之前（fast-lite@' + idxF + ' pro-reason@' + idxP + '）');
});

test('HTTP 链路：GET /api/models/recommendations 真实返回（本机 models.json 或兜底）', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-mf-http-'));
  const TOKEN = crypto.randomBytes(32).toString('hex');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    const r = await (await jzFetch(s.baseUrl, '/api/models/recommendations?task=' + encodeURIComponent('写代码调用工具') + '&preference=balanced', { method: 'GET', token: TOKEN })).json();
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.data.recommendations) && r.data.recommendations.length >= 1, '推荐非空');
    assert.ok(r.data.recommendations.every((m) => m.supportsToolCall), '工具任务全支持工具调用');
    assert.ok(r.data.recommendations[0].scores && r.data.recommendations[0].scores.total > 0, '带评分');
  } finally {
    await s.close();
  }
});
