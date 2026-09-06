'use strict';
// update-artifact：更新解包目标决策（2026-08-29 发布 E2E 抓到的真 bug 修复）。
// 原逻辑：update/JIUZHANG AI 管家.app 存在即复用（幂等），不校验内部版本——
// 残留旧版解包（如 0.1.4）会跳过新 DMG 解包 → 版本校验失败，更新永远装不上。
// 本模块把「复用 or 重解包 or 失败」决策抽成纯函数，三态可测。
function resolveUnpackTarget({ srcAppExists, srcAppVersion, latest, dmgExists } = {}) {
  if (srcAppExists && srcAppVersion === latest) {
    return { action: 'reuse', reason: 'cached-unpack-version-match' };
  }
  if (dmgExists) {
    return {
      action: 'unpack',
      reason: srcAppExists ? `cached-version-mismatch:${srcAppVersion || 'unknown'}` : 'no-cached-unpack',
    };
  }
  return { action: 'fail', reason: 'missing-dmg' };
}

module.exports = { resolveUnpackTarget };
