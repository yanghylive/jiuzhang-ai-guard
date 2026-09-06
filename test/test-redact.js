'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { redact, redactString } = require('../scripts/jz/redact');

test('redact 掩码敏感字段，保留普通字段', () => {
  const o = { token: 'abc', user: 'x', nested: { cookie: 'c', ok: 1 } };
  const r = redact(o);
  assert.equal(r.token, '[redacted]');
  assert.equal(r.nested.cookie, '[redacted]');
  assert.equal(r.user, 'x');
  assert.equal(r.nested.ok, 1);
});

test('redactString 掩码 Bearer/ token/ cookie', () => {
  const s = 'Authorization: Bearer secret123 token=abc.def cookie=ghi; Path=/';
  const r = redactString(s);
  assert.ok(!r.includes('secret123'));
  assert.ok(!r.includes('abc.def'));
  assert.ok(!r.includes('ghi'));
});
