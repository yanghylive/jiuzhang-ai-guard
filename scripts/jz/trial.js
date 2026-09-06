'use strict';
// 试用期（7 天）：首次启动 daemon 记录 trialStartAt，7 天内全功能免费；
// 超过 7 天且未付费（entitlement 非 active）→ 全锁。
// 防篡改：trial.json 附 HMAC（key 派生自平台数据密钥，同 entitlement），MAC 不符视为无记录（fail-closed 重新计时）。
// 2026-09-04 产品负责人决策：免费版试用 24 小时，简单二元——试用期内全功能，过期未付费全锁，付费解锁。
// 2026-09-05 产品负责人决策：试用延长至 7 天（168 小时，v1.1.1）——getTrialState 按实时 trialHours() 计算，
// 存量试用用户（trialStartAt 已写）剩余时长自动按新值延长，无需迁移。
const path = require('node:path');
const crypto = require('node:crypto');
const { dataRoot, readJSON, atomicWriteJSON } = require('./lib');
const { loadOrCreateDataKey } = require('./crypto-vault');

const DEFAULT_TRIAL_HOURS = 168; // 7 天

function trialPath(root) {
  return path.join(root || dataRoot(), 'license', 'trial.json');
}

// 锚点文件（runtime/ 目录，比 license/ 隐蔽）：防「删 license/trial.json 重置试用」。
// 双写 + 交叉恢复：删主文件从锚点恢复，删锚点从主文件恢复，两个都删才会重置。
function anchorPath(root) {
  return path.join(root || dataRoot(), 'runtime', 'trial-anchor.json');
}

// 试用时长（小时）：env WBSWITCH_TRIAL_HOURS 可覆盖（测试/灰度用），默认 168（7 天）。
function trialHours() {
  const env = Number(process.env.WBSWITCH_TRIAL_HOURS);
  if (Number.isFinite(env) && env >= 0) return env;
  return DEFAULT_TRIAL_HOURS;
}

function signTrial(root, t) {
  const key = loadOrCreateDataKey(root);
  const clean = Object.assign({}, t);
  delete clean._mac;
  const mac = crypto.createHmac('sha256', key).update(JSON.stringify(clean)).digest('hex');
  return Object.assign({}, clean, { _mac: mac });
}

function verifyTrial(root, t) {
  if (!t || typeof t !== 'object' || typeof t._mac !== 'string') return false;
  const key = loadOrCreateDataKey(root);
  const clean = Object.assign({}, t);
  delete clean._mac;
  const mac = crypto.createHmac('sha256', key).update(JSON.stringify(clean)).digest('hex');
  return mac === t._mac;
}

// 读一个 trial 文件并校验 MAC（无效/篡改 → null）。
function readValidTrial(root, p) {
  const t = readJSON(p);
  return (t && verifyTrial(root, t) && typeof t.trialStartAt === 'string') ? t : null;
}

// 双写主文件 + 锚点（锚点写失败不阻断主文件，fail-open 保留主文件即可用）。
function writeTrialFiles(root, trial) {
  atomicWriteJSON(trialPath(root), trial);
  try { atomicWriteJSON(anchorPath(root), trial); } catch (_) { /* 锚点失败不阻断 */ }
}

// 首次启动：无记录则写入 trialStartAt = now。
// 防删文件重置（2026-09-04 复核 P0-3）：主文件缺失/篡改 → 从锚点恢复（不重置试用）；
// 仅当主文件 + 锚点都缺失/篡改时才视为首次启动。
function ensureTrialStart(root) {
  root = root || dataRoot();
  const main = readValidTrial(root, trialPath(root));
  if (main) return main;
  const anchor = readValidTrial(root, anchorPath(root));
  if (anchor) {
    writeTrialFiles(root, anchor); // 从锚点恢复主文件，试用不重置
    return anchor;
  }
  const trial = signTrial(root, { trialStartAt: new Date().toISOString(), trialDurationHours: trialHours() });
  writeTrialFiles(root, trial);
  return trial;
}

// 试用状态（now 可注入，测试用）。返回 { trialStartAt, trialDurationHours, remainingMs, expired }。
function getTrialState(root, now) {
  root = root || dataRoot();
  const t = ensureTrialStart(root);
  const nowMs = now || Date.now();
  const hours = trialHours();
  const durationMs = hours * 60 * 60 * 1000;
  const startMs = new Date(t.trialStartAt).getTime();
  const remainingMs = startMs + durationMs - nowMs;
  return {
    trialStartAt: t.trialStartAt,
    trialDurationHours: hours,
    remainingMs,
    expired: remainingMs <= 0,
  };
}

// 是否解锁：entitlement active（终身或未过期）|| 试用期内。
// entitlement 为 null/未付费时，纯靠试用期判断。
function isUnlocked(root, entitlement, now) {
  const nowMs = now || Date.now();
  if (entitlement && entitlement.status === 'active') {
    if (!entitlement.validUntil) return true; // 终身（lifetime）
    if (new Date(entitlement.validUntil).getTime() > nowMs) return true;
  }
  return getTrialState(root, nowMs).remainingMs > 0;
}

module.exports = { ensureTrialStart, getTrialState, isUnlocked, trialPath, DEFAULT_TRIAL_HOURS };
