'use strict';
// update-artifact 回归（2026-08-29 发布 E2E 抓到 bug 的锁定）：
// 复用/重解包/失败三态决策——残留旧版解包必须触发重新解包，绝不静默复用。
const test = require('node:test');
const assert = require('node:assert');
const { resolveUnpackTarget } = require('../scripts/jz/update-artifact');

test('resolveUnpackTarget：缓存版本一致才复用', () => {
  assert.deepEqual(resolveUnpackTarget({ srcAppExists: true, srcAppVersion: '0.3.0', latest: '0.3.0', dmgExists: true }), {
    action: 'reuse',
    reason: 'cached-unpack-version-match',
  });
});

test('resolveUnpackTarget：缓存版本不一致（残留旧版）→ 必须重新解包（发布 E2E 抓到的 bug）', () => {
  // 8-26 残留 0.1.4，目标 0.3.0 → 不能复用，重解包
  assert.deepEqual(resolveUnpackTarget({ srcAppExists: true, srcAppVersion: '0.1.4', latest: '0.3.0', dmgExists: true }), {
    action: 'unpack',
    reason: 'cached-version-mismatch:0.1.4',
  });
  // 缓存版本未知（读不到）→ 保守重解包
  assert.equal(resolveUnpackTarget({ srcAppExists: true, srcAppVersion: null, latest: '0.3.0', dmgExists: true }).action, 'unpack');
});

test('resolveUnpackTarget：无缓存 → 解包；无 DMG → 失败', () => {
  assert.deepEqual(resolveUnpackTarget({ srcAppExists: false, srcAppVersion: null, latest: '0.3.0', dmgExists: true }), {
    action: 'unpack',
    reason: 'no-cached-unpack',
  });
  assert.deepEqual(resolveUnpackTarget({ srcAppExists: false, srcAppVersion: null, latest: '0.3.0', dmgExists: false }), {
    action: 'fail',
    reason: 'missing-dmg',
  });
});
