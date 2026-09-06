'use strict';
// model-fit：模型适配推荐（V1.1，能力提炼开发文档 §3.2 / 素材 workbuddy-litellm-router 方法论）。
// 只取方法论不搬代码。核心（litellm-router 提炼）：
//   模型能力标志位（supportsToolCall/supportsImages/supportsReasoning）决定请求体合法性——
//   推荐必须先按能力硬过滤（任务要视觉，只推荐 supportsImages=true 的），
//   再按 质量/速度/成本 三维评分排序，偏好可调（balanced/quality/fast/cost）。
//
// 数据源：优先读本机 ~/.workbuddy/models.json（WorkBuddy 自定义模型注册表，数组结构），
//         读不到用内置默认表（本机已知模型）。零外部依赖、不联网。
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { dataRoot, readJSON } = require('./lib');

// 内置默认表（本机已知模型；models.json 缺失时兜底）
const DEFAULT_MODELS = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', vendor: 'third-party', supportsReasoning: true, supportsToolCall: true, supportsImages: false, maxInputTokens: 128000, qualityHint: 'high' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', vendor: 'third-party', supportsReasoning: false, supportsToolCall: true, supportsImages: false, maxInputTokens: 128000, qualityHint: 'medium' },
  { id: 'kimi-k3', name: 'Kimi K3', vendor: 'third-party', supportsReasoning: true, supportsToolCall: true, supportsImages: false, maxInputTokens: 200000, qualityHint: 'high' },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', vendor: 'token-plan', supportsReasoning: true, supportsToolCall: true, supportsImages: false, maxInputTokens: 131072, qualityHint: 'high' },
  { id: 'gpt-5.5', name: 'GPT-5.5', vendor: 'third-party', supportsReasoning: true, supportsToolCall: true, supportsImages: true, maxInputTokens: 200000, qualityHint: 'high' },
  { id: 'MiniMax-M3', name: 'MiniMax M3', vendor: 'third-party', supportsReasoning: false, supportsToolCall: true, supportsImages: false, maxInputTokens: 131072, qualityHint: 'medium' },
  { id: 'local-qwen3.8-27b', name: '本地 Qwen3.8-27B（Ollama）', vendor: 'local', supportsReasoning: false, supportsToolCall: true, supportsImages: false, maxInputTokens: 32768, qualityHint: 'medium' },
];

function defaultModelsPath() {
  return process.env.JZ_MODELS_JSON || path.join(os.homedir(), '.workbuddy', 'models.json');
}

// 加载模型注册表（models.json 数组 → 归一化；读不到用内置默认）
function loadModels({ modelsPath } = {}) {
  const p = modelsPath || defaultModelsPath();
  let list = null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) list = parsed;
  } catch { /* 无文件/坏文件 → 兜底 */ }
  const src = list || DEFAULT_MODELS;
  const models = src
    .map((m) => ({
      id: String(m.id || m.model || ''),
      name: String(m.name || m.id || m.model || ''),
      vendor: String(m.vendor || 'third-party'),
      supportsToolCall: !!m.supportsToolCall,
      supportsImages: !!m.supportsImages,
      supportsReasoning: !!m.supportsReasoning,
      maxInputTokens: Number(m.maxInputTokens) || 8192,
    }))
    .filter((m) => m.id);
  return { ok: true, source: list ? p : 'builtin-default', models };
}

// 任务分类：关键词 → 需求集合
function classifyTask(task) {
  const t = String(task || '').toLowerCase();
  const needs = new Set(['chat']);
  if (/(图片|图像|视觉|vision|多模态|screenshot|看(图|屏))/.test(t)) needs.add('vision');
  if (/(代码|编程|code|function|工具|tool|api|脚本)/.test(t)) needs.add('tools');
  if (/(长文|长上下文|文档|小说|报告|论文|context|128k|64k|总结|摘要)/.test(t)) needs.add('context');
  if (/(快|快速|即时|fast|秒回|轻量)/.test(t)) needs.add('speed');
  if (/(省钱|成本|便宜|免费|cost|budget|省|便宜)/.test(t)) needs.add('cost');
  if (/(推理|分析|深度|reason|思考|复杂|规划|math|逻辑)/.test(t)) needs.add('quality');
  return needs;
}

// 单模型三维评分（0-100 各维）
function scoreModel(m, needs, preference) {
  // —— 质量（reasoning + 大上下文 + 商业 vendor 启发）——
  let quality = 10;
  if (m.supportsReasoning) quality += 25;
  if (m.qualityHint === 'high') quality += 20;
  if (m.vendor === 'third-party' || m.vendor === 'token-plan') quality += 10;
  quality += Math.min(15, Math.floor((m.maxInputTokens || 0) / 65536) * 5);
  // —— 速度 ——
  let speed = 20;
  if (/flash|fast|lite|mini|本地|local/i.test(m.name)) speed += 25;
  else if (m.vendor === 'local') speed += 25;
  else speed += 5;
  if (!m.supportsReasoning) speed += 10;
  // —— 成本 ——
  let cost = 10;
  if (m.vendor === 'local') cost += 30;
  else if (m.vendor === 'token-plan') cost += 20;
  else if (m.vendor === 'third-party') cost += 10;
  // —— 上下文分（任务需要长上下文时计入）——
  const ctx = needs.has('context') ? Math.min(16, Math.floor((m.maxInputTokens || 0) / 32768) * 2) : 8;

  const w = preference === 'quality' ? { quality: 2, speed: 0.5, cost: 0.5 }
    : preference === 'fast' ? { quality: 0.5, speed: 2, cost: 0.5 }
    : preference === 'cost' ? { quality: 0.5, speed: 0.5, cost: 2 }
    : { quality: 1, speed: 1, cost: 1 };
  const total = Math.round((quality * w.quality + speed * w.speed + cost * w.cost + ctx) / (w.quality + w.speed + w.cost) * 10) / 10;
  return { quality, speed, cost, total };
}

// 推荐：能力硬过滤 → 三维评分排序 → Top N
function recommendModels({ task = '', preference = 'balanced', limit = 5, modelsPath, root } = {}) {
  const loaded = loadModels({ modelsPath, root });
  const needs = classifyTask(task);
  const scored = [];
  for (const m of loaded.models) {
    // 能力硬过滤（litellm-router 方法论：标志位错 → 400 不 fallback → 必失败）
    if (needs.has('vision') && !m.supportsImages) continue;
    if (needs.has('tools') && !m.supportsToolCall) continue;
    if (needs.has('quality') && !m.supportsReasoning) continue; // 深度推理需求必须 reasoning 模型
    if (needs.has('context') && (m.maxInputTokens || 0) < 32768) continue; // 长上下文需求 ≥32k
    const s = scoreModel(m, needs, preference);
    scored.push({ model: m, ...s });
  }
  scored.sort((a, b) => b.total - a.total);
  const out = scored.slice(0, Math.max(1, Math.min(10, Number(limit) || 5))).map(({ model, ...rest }) => ({
    ...model,
    scores: rest,
  }));
  return { ok: true, task: String(task), needs: [...needs], preference, source: loaded.source, recommendations: out };
}

module.exports = { loadModels, classifyTask, recommendModels, DEFAULT_MODELS };
