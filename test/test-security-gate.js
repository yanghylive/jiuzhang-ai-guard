'use strict';
// 安全门禁测试：6 条 P1 防护必须全部在位（防回归）。
const test = require('node:test');
const assert = require('node:assert');
const { audit } = require('../scripts/security-gate');

test('6 条 P1 防护全部在位（正向断言防回归）', () => {
  const checks = audit();
  assert.equal(checks.length, 6, '应有 6 条 P1 检查');
  const failed = checks.filter((c) => !c.pass);
  assert.deepEqual(
    failed.map((c) => c.id),
    [],
    'P1 防护不得缺失：' + failed.map((c) => c.id + ' (' + c.detail + ')').join('; '),
  );
});
