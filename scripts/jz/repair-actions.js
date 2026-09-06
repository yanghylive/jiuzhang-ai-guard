'use strict';
// 修复动作白名单（03 §4）。动作注册式，不把请求参数拼成 shell 命令；服务端重校验。
const { uuid } = require('./lib');

const ACTIONS = {
  'restart-daemon': { id: 'restart-daemon', label: '重启守护进程', risk: 'low', requiresConfirmation: true, p0: true },
  'rediscover-cdp': { id: 'rediscover-cdp', label: '重新发现 CDP', risk: 'low', requiresConfirmation: false, p0: true },
  'reinject-ui': { id: 'reinject-ui', label: '重新注入界面', risk: 'low', requiresConfirmation: false, p0: true },
  'enter-safe-mode': { id: 'enter-safe-mode', label: '进入安全模式', risk: 'medium', requiresConfirmation: true, p0: true },
  'repair-workdaddy-directory-permission': { id: 'repair-workdaddy-directory-permission', label: '修复目录权限', risk: 'medium', requiresConfirmation: true, p0: true },
  'restore-latest-config': { id: 'restore-latest-config', label: '恢复最近配置', risk: 'medium', requiresConfirmation: true, p0: true },
  'rollback-component': { id: 'rollback-component', label: '回滚组件', risk: 'high', requiresConfirmation: true, p0: false },
  'restore-account-backup': { id: 'restore-account-backup', label: '恢复账号备份', risk: 'high', requiresConfirmation: true, p0: false },
  'cleanup-stale-runtime': { id: 'cleanup-stale-runtime', label: '清理过期运行时', risk: 'low', requiresConfirmation: false, p0: false },
};

function planFor(findings) {
  const codes = (findings || []).map((f) => (typeof f === 'string' ? f : f.code));
  const picked = [];
  if (codes.includes('CDP_UNAVAILABLE')) picked.push(ACTIONS['rediscover-cdp']);
  if (codes.includes('PROFILE_MISMATCH')) picked.push(ACTIONS['reinject-ui']);
  if (codes.includes('DATA_ERROR')) picked.push(ACTIONS['repair-workdaddy-directory-permission']);
  // 无匹配动作时才兜底重启（不无条件加，避免覆盖可复查的轻量修复）
  if (!picked.length) picked.push(ACTIONS['restart-daemon']);
  return picked.map((a) => ({
    id: a.id,
    label: a.label,
    risk: a.risk,
    requiresConfirmation: a.requiresConfirmation,
    createsBackup: a.risk === 'high',
    estimatedImpact: 'minimal',
    requiresPro: false,
  }));
}

// 执行单步修复：由宿主（WorkDaddy daemon）注入 hooks 提供真实执行能力。
// 无对应 hook 的动作 fail-closed（返回 not_supported，绝不假成功）。
async function runAction(actionId, { hooks = {} } = {}) {
  const action = ACTIONS[actionId];
  if (!action) return { ok: false, error: 'INVALID_REQUEST' };
  const rollbackToken = uuid();
  const hook = hooks[actionId];
  if (typeof hook !== 'function') {
    return { ok: false, actionId, status: 'not_supported', rollbackToken, note: '该动作未注册执行器' };
  }
  try {
    const extra = (await hook({ rollbackToken })) || {};
    return { ok: true, actionId, status: 'success', rollbackToken, ...extra };
  } catch (e) {
    return { ok: false, actionId, status: 'failed', rollbackToken, error: String((e && e.message) || e) };
  }
}

module.exports = { ACTIONS, planFor, runAction };
