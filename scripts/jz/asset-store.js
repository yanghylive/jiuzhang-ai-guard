'use strict';
// asset-store：统一资产仓库（能力提炼开发文档 §3.3 DistilledAsset）。
// kind 参数化：workflow | prompt | memory | expert | skill-recipe —— 资产中心统一模型，
// memory-store 收敛为本模块的 kind='memory' 特化封装（API 兼容）。
//
// 硬约束（对齐 §3.3 / §5.2 / §5.3）：
// 1. sourceRefs 必填且只存短 ID（来源可追溯，不存原文）。
// 2. 内容敏感扫描 fail-closed（content/steps/inputs/outputs 联合扫描），命中不入库。
// 3. checksum 防篡改：外部改文件后状态变更/回滚一律拒绝。
// 4. 状态机 draft→review→enabled→blocked→archived（白名单）。
// 5. 版本历史：同 sourceRefs 再次 extract → version+1 且快照归档，支持 rollback。
// 6. 纯本地、零外部依赖；语义检索留 V1.1 model-fit。
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { dataRoot, uuid, readJSON, atomicWriteJSON } = require('./lib');
const { scan: privacyScan } = require('./privacy');
const { scoreSkill } = require('./skill-policy');

const ASSET_DIR = 'runtime/assets';
const KIND_WHITELIST = ['workflow', 'prompt', 'memory', 'expert', 'skill-recipe'];
const STATUS_WHITELIST = ['draft', 'review', 'enabled', 'blocked', 'archived'];
const RISK_WHITELIST = ['low', 'medium', 'high'];
const COVERAGE_WHITELIST = ['none', 'partial', 'automated']; // 覆盖三态（skill-distiller 提炼）
const IMPORTANCE_MAX = 10;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/; // sourceRef 只允许短 ID

function assetDir(root) {
  return path.join(root || dataRoot(), ASSET_DIR);
}

function assetPath(root, assetId) {
  return path.join(assetDir(root), `${assetId}.json`);
}

function historyDir(root, assetId) {
  return path.join(assetDir(root), `${assetId}.history`);
}

function checksumOf(rec) {
  // 2026-08-29 复核 P2：checksum 覆盖权限/风险/覆盖度字段（原仅业务正文，外部改 permission 等不会触发防篡改）
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      kind: rec.kind,
      title: rec.title,
      content: rec.content,
      steps: rec.steps,
      sourceRefs: rec.sourceRefs,
      tags: rec.tags,
      permission: rec.permission || null,
      risk: rec.risk || null,
      coverage: rec.coverage || null,
      importance: rec.importance ?? null,
    }))
    .digest('hex');
}

function validateSourceRefs(refs) {
  const list = Array.isArray(refs) ? refs : [];
  for (const r of list) {
    const s = String(r);
    if (!ID_RE.test(s) || s.length > 80) return false;
  }
  return list.length > 0; // 来源必填（来源可追溯是硬要求）
}

// 资产正文候选（content + 结构化字段），用于敏感扫描与检索
function contentChunks(rec) {
  const parts = [String(rec.content || '')];
  for (const s of Array.isArray(rec.steps) ? rec.steps : []) {
    parts.push(String(s.action || '') + ' ' + String(s.object || '') + ' ' + String(s.params || ''));
  }
  for (const i of Array.isArray(rec.inputs) ? rec.inputs : []) parts.push(String(i));
  for (const o of Array.isArray(rec.outputs) ? rec.outputs : []) parts.push(String(o));
  return parts;
}

// 英文/数字词 token
function tokenize(s) {
  const out = [];
  const m = String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g);
  if (m) {
    for (const t of m) {
      const clean = t.replace(/[._-]+$/g, '');
      if (clean.length >= 2) out.push(clean);
    }
  }
  return [...new Set(out)];
}

// 搜索单元：英文 token + 中文滑动窗口（步长 1、窗口 4 字，子串包含匹配）
function searchUnits(q) {
  const units = tokenize(q);
  const cn = String(q).match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const seg of cn) {
    if (seg.length <= 4) {
      units.push(seg);
    } else {
      for (let i = 0; i + 2 <= seg.length; i++) {
        const w = seg.slice(i, i + 4);
        if (w.length >= 2) units.push(w);
      }
    }
  }
  return [...new Set(units)];
}

// 新建资产（来源必填；敏感内容 fail-closed；kind 白名单）
function addAsset({ kind, title, content = '', steps = [], inputs = [], outputs = [], sourceRefs, tags = [], importance = 1, permissions = [], risk = 'low', coverage = 'none', policy, root } = {}) {
  if (!KIND_WHITELIST.includes(kind)) {
    return { ok: false, error: 'INVALID_KIND', detail: `kind 必须是 ${KIND_WHITELIST.join('|')}` };
  }
  const t = String(title || '').trim();
  if (!t) return { ok: false, error: 'INVALID_REQUEST', detail: 'title 必填' };
  if (!validateSourceRefs(sourceRefs)) {
    return { ok: false, error: 'SOURCE_REFS_REQUIRED', detail: 'sourceRefs 必填且仅允许短 ID（最多 80 字符）' };
  }
  const imp = Math.max(1, Math.min(IMPORTANCE_MAX, Number(importance) || 1));
  const rk = RISK_WHITELIST.includes(risk) ? risk : 'low';
  const cv = COVERAGE_WHITELIST.includes(coverage) ? coverage : 'none';
  const rec = {
    assetId: `ast-${uuid()}`,
    kind,
    title: t,
    version: 1,
    content: String(content),
    steps: Array.isArray(steps) ? steps : [],
    inputs: Array.isArray(inputs) ? inputs : [],
    outputs: Array.isArray(outputs) ? outputs : [],
    sourceRefs: [...sourceRefs],
    tags: [...new Set(tags.map((x) => String(x).trim()).filter(Boolean))],
    importance: imp,
    permissions: Array.isArray(permissions) ? permissions : [],
    risk: rk,
    coverage: cv,
    status: 'draft',
    recallCount: 0,
    lastRecalledAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // 敏感内容 fail-closed：正文 + 结构化字段联合扫描（§5.2-3）
  const scan = privacyScan(contentChunks(rec).join('\n'));
  if (scan.sensitive && scan.sensitive.length) {
    return { ok: false, error: 'SENSITIVE_CONTENT', detail: `拒绝入库：检测到敏感内容（${scan.sensitive.map((s) => s.type).join('、')}）` };
  }
  rec.checksum = checksumOf(rec);
  // policy 元数据（可选）：自动信任评分落库（不进 checksum——评分是环境属性非内容）
  if (policy && typeof policy === 'object') {
    const ps = scoreSkill(policy);
    if (ps.ok) {
      rec.trustScore = ps.score;
      rec.policyBreakdown = ps.breakdown;
    }
  }
  try {
    fs.mkdirSync(assetDir(root), { recursive: true });
    atomicWriteJSON(assetPath(root, rec.assetId), rec);
  } catch (e) {
    return { ok: false, error: 'ASSET_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
  return { ok: true, asset: publicView(rec) };
}

function listAssets({ kind, status, tag, root } = {}) {
  const dir = assetDir(root);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return { ok: true, assets: [] };
  }
  const out = [];
  for (const f of files) {
    // 2026-08-29 复核 P2：排除符号链接（防读取保险箱外/任意路径的链接目标）
    const full = path.join(dir, f);
    try {
      if (fs.lstatSync(full).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const rec = readJSON(full);
    if (!rec || !rec.assetId) continue;
    if (kind && rec.kind !== kind) continue;
    if (status && rec.status !== status) continue;
    if (tag && !(rec.tags || []).includes(tag)) continue;
    out.push(publicView(rec));
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { ok: true, assets: out };
}

function getAsset(assetId, { root } = {}) {
  const id = String(assetId || '');
  if (!/^ast-[A-Za-z0-9-]{8,}$/.test(id)) return { ok: false, error: 'INVALID_ID' };
  const rec = readJSON(assetPath(root, id));
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  return { ok: true, asset: publicView(rec) };
}

// 通用检索：title 10 / tags 6 / content+steps 3，importance 加权；默认只搜 enabled
function searchAssets({ query, kind, status = 'enabled', limit = 10, root } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'INVALID_REQUEST', detail: 'query 必填' };
  const units = searchUnits(q);
  if (!units.length) return { ok: true, assets: [] };
  const all = listAssets({ kind, status, root });
  const scored = [];
  for (const m of all.assets) {
    const hayTitle = String(m.title || '').toLowerCase();
    const hayTags = (m.tags || []).join(' ').toLowerCase();
    const hayBody = contentChunks(m).join(' ').toLowerCase();
    let score = 0;
    for (const unit of units) {
      if (hayTitle.includes(unit)) score += 10;
      if (hayTags.includes(unit)) score += 6;
      if (hayBody.includes(unit)) score += 3;
    }
    if (score > 0) {
      score = Math.round(score * (1 + (m.importance || 1) / 10));
      scored.push({ ...m, _score: score });
    }
  }
  scored.sort((a, b) => b._score - a._score || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const out = scored.slice(0, Math.max(1, Math.min(50, Number(limit) || 10))).map(({ _score, ...rest }) => rest);
  return { ok: true, assets: out };
}

// 工作前回忆：按任务文本检索（status=enabled），更新召回统计
function recallAssets({ query, kind, limit = 5, root } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'INVALID_REQUEST', detail: 'query 必填' };
  const r = searchAssets({ query: q, kind, status: 'enabled', limit, root });
  if (!r.ok) return r;
  const now = new Date().toISOString();
  for (const a of r.assets) {
    const rec = readJSON(assetPath(root, a.assetId));
    if (!rec) continue;
    rec.recallCount = Number(rec.recallCount || 0) + 1;
    rec.lastRecalledAt = now;
    try {
      atomicWriteJSON(assetPath(root, a.assetId), rec);
    } catch { /* 统计写失败不阻断召回 */ }
  }
  return { ok: true, assets: r.assets };
}

function updateAssetStatus(assetId, status, { root } = {}) {
  const id = String(assetId || '');
  if (!/^ast-[A-Za-z0-9-]{8,}$/.test(id)) return { ok: false, error: 'INVALID_ID' };
  if (!STATUS_WHITELIST.includes(status)) {
    return { ok: false, error: 'INVALID_STATUS', detail: `status 必须是 ${STATUS_WHITELIST.join('|')}` };
  }
  const p = assetPath(root, id);
  const rec = readJSON(p);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  if (rec.checksum !== checksumOf(rec)) return { ok: false, error: 'ASSET_TAMPERED' };
  // V1.0 门禁：无来源信任信号的资产（trustScore<60=仅基础分，本地手动/未知来源）不得直接启用，
  // 须先 review 人工确认（评分下限 52，<40 的 deny 带对资产库不可达，故用 60 作为"无来源信任"分界）
  if (status === 'enabled' && rec.trustScore !== undefined && Number(rec.trustScore) < 60) {
    return { ok: false, error: 'ENABLE_BLOCKED_BY_POLICY', detail: `信任分 ${rec.trustScore} < 60（无来源信任信号），请先流转 review 并由人工确认` };
  }
  rec.status = status;
  rec.updatedAt = new Date().toISOString();
  try {
    atomicWriteJSON(p, rec);
  } catch (e) {
    return { ok: false, error: 'ASSET_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
  return { ok: true, asset: publicView(rec) };
}

// 版本化更新：同 sourceRefs 再次提交 → version+1 且归档历史快照（支持 rollback）
function updateAssetVersion(assetId, { title, content, steps, inputs, outputs, tags, importance, permissions, risk, coverage, root } = {}) {
  const id = String(assetId || '');
  if (!/^ast-[A-Za-z0-9-]{8,}$/.test(id)) return { ok: false, error: 'INVALID_ID' };
  const p = assetPath(root, id);
  const rec = readJSON(p);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  if (rec.checksum !== checksumOf(rec)) return { ok: false, error: 'ASSET_TAMPERED' };

  const next = { ...rec };
  if (title !== undefined) next.title = String(title);
  if (content !== undefined) next.content = String(content);
  if (steps !== undefined) next.steps = Array.isArray(steps) ? steps : [];
  if (inputs !== undefined) next.inputs = Array.isArray(inputs) ? inputs : [];
  if (outputs !== undefined) next.outputs = Array.isArray(outputs) ? outputs : [];
  if (tags !== undefined) next.tags = [...new Set(tags.map((x) => String(x).trim()).filter(Boolean))];
  if (importance !== undefined) next.importance = Math.max(1, Math.min(IMPORTANCE_MAX, Number(importance) || 1));
  if (permissions !== undefined) next.permissions = Array.isArray(permissions) ? permissions : [];
  if (risk !== undefined && RISK_WHITELIST.includes(risk)) next.risk = risk;
  if (coverage !== undefined && COVERAGE_WHITELIST.includes(coverage)) next.coverage = coverage;
  next.updatedAt = new Date().toISOString();

  // 敏感 fail-closed（改后的新内容同样要过扫描）
  const scan = privacyScan(contentChunks(next).join('\n'));
  if (scan.sensitive && scan.sensitive.length) {
    return { ok: false, error: 'SENSITIVE_CONTENT', detail: `拒绝更新：检测到敏感内容（${scan.sensitive.map((s) => s.type).join('、')}）` };
  }

  // 归档历史（保留最近 10 个版本）
  try {
    fs.mkdirSync(historyDir(root, id), { recursive: true });
    const hist = { ...publicView(rec), archivedAt: new Date().toISOString() };
    atomicWriteJSON(path.join(historyDir(root, id), `v${rec.version}.json`), hist);
  } catch { /* 历史归档失败不阻断更新（版本号仍递增） */ }

  next.version = Number(rec.version || 1) + 1;
  next.checksum = checksumOf(next);
  try {
    atomicWriteJSON(p, next);
  } catch (e) {
    return { ok: false, error: 'ASSET_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
  return { ok: true, asset: publicView(next) };
}

// 回滚：恢复上一版本（读历史快照）；无历史 → 404
function rollbackAsset(assetId, { root } = {}) {
  const id = String(assetId || '');
  if (!/^ast-[A-Za-z0-9-]{8,}$/.test(id)) return { ok: false, error: 'INVALID_ID' };
  const p = assetPath(root, id);
  const rec = readJSON(p);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  if (rec.checksum !== checksumOf(rec)) return { ok: false, error: 'ASSET_TAMPERED' };
  if (Number(rec.version) <= 1) return { ok: false, error: 'NO_HISTORY', detail: '无历史版本可回滚' };
  const prevVersion = Number(rec.version) - 1;
  const hp = path.join(historyDir(root, id), `v${prevVersion}.json`);
  const hist = readJSON(hp);
  if (!hist) return { ok: false, error: 'HISTORY_MISSING' };

  // 当前版本先归档，再恢复上一版本内容
  try {
    const cur = { ...publicView(rec), archivedAt: new Date().toISOString() };
    atomicWriteJSON(path.join(historyDir(root, id), `v${rec.version}.json`), cur);
  } catch { /* 忽略 */ }
  const restored = {
    ...rec,
    title: hist.title,
    content: hist.content,
    steps: hist.steps || [],
    inputs: hist.inputs || [],
    outputs: hist.outputs || [],
    tags: hist.tags || [],
    importance: hist.importance,
    permissions: hist.permissions || [],
    risk: hist.risk || 'low',
    coverage: hist.coverage || 'none',
    version: Number(rec.version) + 1, // 回滚也是新版本（保留回滚痕迹）
    updatedAt: new Date().toISOString(),
  };
  restored.checksum = checksumOf(restored);
  try {
    atomicWriteJSON(p, restored);
  } catch (e) {
    return { ok: false, error: 'ASSET_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
  return { ok: true, asset: publicView(restored), rolledBackFrom: Number(rec.version), restoredTo: prevVersion };
}

// 对外视图：checksum 摘要 + 剥离内部标记
function publicView(rec) {
  const { checksum, ...rest } = rec;
  return { ...rest, checksum: checksum ? checksum.slice(0, 12) : undefined };
}

module.exports = {
  addAsset,
  listAssets,
  getAsset,
  searchAssets,
  recallAssets,
  updateAssetStatus,
  updateAssetVersion,
  rollbackAsset,
  tokenize,
  KIND_WHITELIST,
  STATUS_WHITELIST,
};
