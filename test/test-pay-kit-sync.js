'use strict';
// pay-kit 分发副本同步守卫（2026-09-01）。
// 铁律来源："直改编译产物必同步源码"教训（subscribe 白名单）——衍生副本必须跟真源锁死，
// scripts/jz 支付真源一旦改动，kit 副本没同步就红，杜绝双源漂移。
// 修复方式：node scripts/sync-pay-kit.js 重新生成，然后 commit 两个位置。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildKitFiles } = require('../scripts/sync-pay-kit');

const KIT = path.join(__dirname, '..', 'packages', 'pay-kit');

test('pay-kit 分发副本与 scripts/jz 真源一致', () => {
  const files = buildKitFiles();
  assert.ok(Object.keys(files).length >= 3, 'kit 文件清单不应为空');
  for (const [rel, expected] of Object.entries(files)) {
    const disk = path.join(KIT, rel);
    assert.ok(fs.existsSync(disk), `缺失分发副本: ${rel}（跑 node scripts/sync-pay-kit.js）`);
    const actual = fs.readFileSync(disk, 'utf8');
    assert.strictEqual(
      actual,
      expected,
      `分发副本过期: packages/pay-kit/${rel}\n  scripts/jz 真源已改，kit 未同步。\n  修复: node scripts/sync-pay-kit.js 后一并 commit。`
    );
  }
});
