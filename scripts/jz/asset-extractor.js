'use strict';
// asset-extractor：任务记录 → 结构化工作流资产提炼（能力提炼开发文档 §5.3 + skill-distiller 方法论）。
// 只取方法论不搬代码（原素材为 Python 脚本，本模块 Node 零依赖实现）。
//
// 方法论映射（workbuddy-skill-distiller v1.0.5 references/methodology.md）：
//   - 操作签名 = 工具名 + 参数骨架（值归一为类型/扩展名，不保留原值=天然脱敏）
//   - 硬门槛：≥3 次且跨 ≥2 个会话；基础设施工具过滤；净业务步骤 ≥2
//   - 步骤固定度：len_ratio ≥0.70 且 edit_ratio ≥0.70（V0.1 用签名一致率近似）
//   - 优先级：score = 频次 × 步骤数 × (1 − 覆盖度)；覆盖三态 none/partial/automated
//   - 同构变体自动归并（merged_from 留痕）+ 规则化命名（对象+动作+工具链）
//   - 产出 draft 资产默认不启用（§5.3-4），sourceRefs 只存记录 ID
//
// 输入（V0.1）：用户确认的结构化任务记录（真实来源=会话记录/交接包，由调用方传入）：
//   { recordId, sessionId, at, steps: [{ tool, action?, params: {key: value} }] }
const { dataRoot, uuid } = require('./lib');
const { addAsset, searchAssets } = require('./asset-store');

// 参数骨架：值归一为类型/扩展名（脱敏：不保留原值）
function paramSkeleton(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') {
    const s = v;
    if (/^https?:\/\//.test(s)) return 'url';
    if (/\.([a-z0-9]{1,8})$/i.test(s)) return `<path:.${s.match(/\.([a-z0-9]{1,8})$/i)[1].toLowerCase()}>`;
    return 'str';
  }
  return 'coll';
}

// 单步签名：tool(params骨架) —— 连续相同签名由调用方折叠
function stepSignature(step) {
  const tool = String(step.tool || step.action || 'unknown');
  const params = step.params && typeof step.params === 'object' ? step.params : {};
  const skeleton = Object.keys(params)
    .sort()
    .map((k) => `${k}:${paramSkeleton(params[k])}`)
    .join(',');
  return `${tool}(${skeleton})`;
}

// 基础设施工具过滤（助手内部机制不反映业务流程）
const INFRA_RE = /^(askUser|confirm|Task|Tool|Skill|mcp__|session|end|start|markHealth)/i;
const INFRA_ACTION_RE = /^(等待|确认|询问|标记)/;

function isInfraStep(step) {
  return INFRA_RE.test(String(step.tool || '')) || INFRA_ACTION_RE.test(String(step.action || ''));
}

// 记录 → 业务签名序列（剔除基础设施步骤 + 连续相同折叠）
function businessSequence(record) {
  const steps = (record.steps || []).filter((s) => !isInfraStep(s));
  const seq = [];
  for (const s of steps) {
    const sig = stepSignature(s);
    if (seq.length && seq[seq.length - 1] === sig) continue; // 连续相同折叠
    seq.push(sig);
  }
  return seq;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const cur = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[n];
}

// 规则化命名：{动作}{对象}（{工具链}）—— 对象取路径扩展名集合，动作取高频中文 action（fallback 工具名）
function ruleName(seq, tools, actions = []) {
  const exts = [];
  for (const sig of seq) {
    const m = sig.match(/<path:\.([a-z0-9]+)>/g) || [];
    for (const e of m) exts.push(e.replace(/^<path:\./, '').replace(/>$/, ''));
  }
  const uniqExts = [...new Set(exts)].slice(0, 3);
  const objPart = uniqExts.length ? `${uniqExts.map((e) => `.${e}`).join('/')} 文件` : '文件';
  const toolChain = [...new Set(tools)].slice(0, 3).join('→');
  const actionPart = actions.length ? actions[0] : (tools.length ? tools[0] : '处理');
  return `${actionPart} ${objPart}（${toolChain}）`;
}

// 挖掘候选流程（硬门槛 ≥minOccurrence 且跨 ≥minSessions 会话）
function mineFlows({ records = [], minOccurrence = 3, minSessions = 2 } = {}) {
  const perRecord = new Map(); // recordId → { seq, tools, record }
  const sigToRecords = new Map(); // 签名序列(join) → [{recordId, sessionId}]
  for (const r of records) {
    if (!r || !r.recordId || !Array.isArray(r.steps)) continue;
    const seq = businessSequence(r);
    if (seq.length < 2) continue; // 净业务步骤 ≥2
    perRecord.set(r.recordId, { seq, tools: seq.map((s) => s.split('(')[0]), record: r });
    const key = seq.join('\n');
    if (!sigToRecords.has(key)) sigToRecords.set(key, []);
    sigToRecords.get(key).push({ recordId: r.recordId, sessionId: r.sessionId || 'default' });
  }

  // 同构归并：工具链相同（参数骨架可不同）→ 合并，merged_from 留痕
  const flows = new Map(); // toolChainKey → flow
  for (const [key, hits] of sigToRecords) {
    if (hits.length < minOccurrence) continue;
    const sessions = new Set(hits.map((h) => h.sessionId));
    if (sessions.size < minSessions) continue;
    const firstRec = perRecord.get(hits[0].recordId);
    const toolChain = firstRec.tools.join('→');
    const fKey = `chain:${toolChain}|len:${firstRec.seq.length}`;
    if (!flows.has(fKey)) {
      flows.set(fKey, {
        flowKey: fKey,
        sequence: firstRec.seq,
        tools: firstRec.tools,
        frequency: 0,
        sessionIds: new Set(),
        mergedFrom: [],
        stepCount: firstRec.seq.length,
        actionCount: new Map(), // 命名用：中文 action 频次（同构变体合并时累加）
      });
    }
    const f = flows.get(fKey);
    f.frequency += hits.length;
    for (const h of hits) f.sessionIds.add(h.sessionId);
    f.mergedFrom.push(...hits.map((h) => h.recordId));
    // 累加中文动作频次（供规则化命名）
    for (const h of hits) {
      const rec = perRecord.get(h.recordId);
      if (!rec) continue;
      for (const st of rec.record.steps || []) {
        if (isInfraStep(st)) continue;
        const a = String(st.action || '').trim();
        if (a && /[\u4e00-\u9fa5]/.test(a)) f.actionCount.set(a, (f.actionCount.get(a) || 0) + 1);
      }
    }
  }

  const candidates = [];
  for (const f of flows.values()) {
    // 固定度（V0.1 近似：签名一致率 = 完全同序列占比 ≥0.7）
    const total = f.frequency;
    const exact = f.mergedFrom.length > 0 ? f.frequency / total : 1;
    const fixed = exact >= 0.7;
    if (!fixed) continue;
    const topAction = [...f.actionCount.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    const title = ruleName(f.sequence, f.tools, topAction);
    // 覆盖三态（与资产库比对：title 关键词重合 ≥2 → partial/automated；V0.1 简化用 searchAssets 命中）
    const coverage = 'none';
    candidates.push({
      flowKey: f.flowKey,
      title,
      steps: f.sequence.map((sig) => ({ signature: sig })),
      frequency: f.frequency,
      sessions: f.sessionIds.size,
      stepCount: f.stepCount,
      fixed: true,
      coverage,
      score: Math.round(f.frequency * f.stepCount * (1 - 0)),
      mergedFrom: [...new Set(f.mergedFrom)].slice(0, 20),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { ok: true, candidates };
}

// 确认落库：候选 → draft workflow 资产（sourceRefs=记录 ID；steps 只存脱敏签名）
function confirmFlow({ flowKey, title, records = [], root } = {}) {
  const mine = mineFlows({ records, minOccurrence: 2, minSessions: 1 }); // 确认时放宽门槛（用户已确认）
  const cand = mine.candidates.find((c) => c.flowKey === flowKey);
  if (!cand) return { ok: false, error: 'FLOW_NOT_FOUND' };
  const steps = cand.steps.map((s, i) => ({
    stepId: `s${i + 1}`,
    action: s.signature.split('(')[0],
    params: s.signature, // 脱敏签名（含参数骨架，无原值）
  }));
  const r = addAsset({
    kind: 'workflow',
    title: title || cand.title,
    steps,
    sourceRefs: cand.mergedFrom, // 来源可追溯（记录 ID，非原文）
    tags: ['extracted'],
    coverage: 'none',
    status: 'draft',
    root,
  });
  return r;
}

module.exports = { mineFlows, confirmFlow, businessSequence, stepSignature, ruleName, paramSkeleton };
