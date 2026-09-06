'use strict';
// skill-policy：资产/技能信任评分与权限决策（能力提炼开发文档 §3.3 permissions / PRD 权限五原则）。
// 提炼自外部素材 workbuddy-skill-manager v1.1.2 的「信任+能力」评分模型，只取方法论不搬代码。
//
// 设计原则（素材原文要点）：
//   能力声明 ≠ 安全威胁 —— 含脚本/联网/写文件是技能的正常能力，不因"有能力"扣分，
//   只关注"是否可信"（来源、维护信号、元数据完整性）；评分明细透明，不黑盒。
//
// 本模块是纯计算（输入→决策，无副作用、不落盘），供 daemon 与资产中心在
// 启用/执行资产或外部技能前调用。
const { dataRoot, uuid, readJSON } = require('./lib');

// —— 信任评分（0-100，越高越可信）——
// source: 'skillhub'|'self'|'clawhub'|'project'|'local'|'unknown'
function scoreSkill({ source = 'unknown', version, hasScripts = false, description = '', usage = '', installedAt, fileSizeBytes = 0, hasNetwork = false, hasWrite = false } = {}) {
  let score = 60;
  const breakdown = [{ dimension: '基础分', points: 60, reason: '中性起点，不预设可疑' }];

  // 1. 来源信任度（0~+30）
  const srcMap = {
    skillhub: [30, 'SkillHub 官方审核上架'],
    self: [20, '自建资产（知根知底）'],
    clawhub: [15, 'ClawHub 社区市场上架'],
    project: [10, '项目级资产（项目目录内）'],
    local: [5, '本地手动安装（来源未验证）'],
  };
  const [srcPts, srcReason] = srcMap[source] || [0, '未知来源'];
  score += srcPts;
  breakdown.push({ dimension: '来源信任', points: srcPts, reason: srcReason });

  // 2. 维护信号（0~+13）
  if (version) {
    score += 5;
    breakdown.push({ dimension: '版本号', points: 5, reason: `v${version} 有版本管理` });
  }
  if (hasScripts && version) {
    score += 3;
    breakdown.push({ dimension: '脚本+版本', points: 3, reason: '含脚本且有版本号，维护意识良好' });
  }
  if (installedAt) {
    score += 5;
    breakdown.push({ dimension: '安装记录', points: 5, reason: '有安装时间戳' });
  }

  // 3. 元数据完整性（0~+8）
  if (String(description || '').length > 20) {
    score += 5;
    breakdown.push({ dimension: '描述完整', points: 5, reason: '有详细功能描述' });
  }
  if (String(usage || '').length > 5) {
    score += 3;
    breakdown.push({ dimension: '使用说明', points: 3, reason: '有调用说明' });
  }

  // 4. 体量合理性（-8 ~ 0）
  const fs = Number(fileSizeBytes) || 0;
  if (fs > 1000000) {
    score -= 8;
    breakdown.push({ dimension: '体量异常', points: -8, reason: `${Math.round(fs / 1024)}KB 超过 1MB，可能包含非必要内容` });
  } else if (fs > 500000) {
    score -= 3;
    breakdown.push({ dimension: '体量偏大', points: -3, reason: `${Math.round(fs / 1024)}KB 超过 500KB` });
  }

  // 5. 能力声明（不扣分，仅标注信息）
  const capabilities = [];
  if (hasScripts) capabilities.push('含可执行脚本');
  if (hasNetwork) capabilities.push('声明网络访问');
  if (hasWrite) capabilities.push('声明文件写入');
  if (capabilities.length) {
    breakdown.push({ dimension: '能力声明', points: 0, reason: capabilities.join('、') + '（正常能力，不扣分）' });
  }

  return { ok: true, score: Math.max(0, Math.min(100, score)), breakdown, capabilities };
}

// —— 权限决策 ——
// action 白名单：普通动作 + 高危动作（高危永远 require-confirm，红线不越）
const HIGH_RISK_ACTIONS = ['publish', 'pay', 'send', 'delete', 'overwrite', 'external-message', 'update-replace'];
const ACTION_WHITELIST = ['read', 'execute-script', 'network', 'write-file', 'backup', 'restore', 'export', 'import', 'install', 'run', ...HIGH_RISK_ACTIONS];
const RISK_WHITELIST = ['low', 'medium', 'high'];

// decide：按信任分 + 风险 + 动作给出 allow / require-confirm / deny（附理由）
function decide({ trustScore, risk = 'medium', action } = {}) {
  const score = Number(trustScore);
  if (!Number.isFinite(score)) return { ok: false, error: 'INVALID_REQUEST', detail: 'trustScore 必填且为数字' };
  if (!ACTION_WHITELIST.includes(action)) {
    return { ok: false, error: 'INVALID_ACTION', detail: `action 必须是 ${ACTION_WHITELIST.join('|')}` };
  }
  const rk = RISK_WHITELIST.includes(risk) ? risk : 'medium';

  // 高危动作：一律人工确认（对齐 workflow-builder 红线：对外发布/付款/删除/覆盖/外发消息不自动化）
  if (HIGH_RISK_ACTIONS.includes(action)) {
    return {
      ok: true,
      decision: 'require-confirm',
      reason: `动作 ${action} 属高危（对外副作用），即使信任分 ${score} 也必须人工确认`,
      threshold: null,
    };
  }

  // 阈值按风险调整：low −10 / high +10（基准 medium：allow≥70，deny<40）
  const delta = rk === 'low' ? -10 : rk === 'high' ? 10 : 0;
  const allowAt = 70 + delta;
  const denyBelow = 40 + delta;
  if (score >= allowAt) {
    return { ok: true, decision: 'allow', reason: `信任分 ${score} ≥ ${allowAt}（risk=${rk}）`, threshold: allowAt };
  }
  if (score >= denyBelow) {
    return { ok: true, decision: 'require-confirm', reason: `信任分 ${score} 在 ${denyBelow}~${allowAt}（risk=${rk}），需人工确认`, threshold: allowAt };
  }
  return { ok: true, decision: 'deny', reason: `信任分 ${score} < ${denyBelow}（risk=${rk}），拒绝`, threshold: denyBelow };
}

// —— 功能重叠检测（Jaccard ≥0.35 预警，skill-manager 提炼）——
// 输入资产列表（asset-store 的 assets），按 title+tags+steps 关键词做 Jaccard；
// 输出相似度 ≥0.35 的资产对（防重复造轮子）。
const OVERLAP_THRESHOLD = 0.35;

function keywordsOf(asset) {
  const s = [asset.title, (asset.tags || []).join(' '), (asset.steps || []).map((st) => `${st.action} ${st.object}`).join(' ')].join(' ').toLowerCase();
  const words = new Set();
  const m = s.match(/[a-z0-9][a-z0-9._-]*|[\u4e00-\u9fa5]{2,}/g);
  if (m) for (const w of m) { const c = w.replace(/[._-]+$/g, ''); if (c.length >= 2) words.add(c); }
  return words;
}

function findOverlap(assets = []) {
  const pairs = [];
  for (let i = 0; i < assets.length; i++) {
    for (let j = i + 1; j < assets.length; j++) {
      const a = keywordsOf(assets[i]);
      const b = keywordsOf(assets[j]);
      let inter = 0;
      for (const w of a) if (b.has(w)) inter++;
      const union = a.size + b.size - inter;
      const jaccard = union ? inter / union : 0;
      if (jaccard >= OVERLAP_THRESHOLD) {
        pairs.push({
          a: assets[i].assetId,
          b: assets[j].assetId,
          aTitle: assets[i].title,
          bTitle: assets[j].title,
          jaccard: Math.round(jaccard * 1000) / 1000,
          suggestion: `功能重叠 ${Math.round(jaccard * 100)}%，建议保留更常用的那个`,
        });
      }
    }
  }
  return { ok: true, pairs };
}

module.exports = { scoreSkill, decide, findOverlap, HIGH_RISK_ACTIONS, ACTION_WHITELIST, OVERLAP_THRESHOLD };
