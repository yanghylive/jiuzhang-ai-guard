'use strict';
// WorkDaddy 二开基线安全测试（P1-1 UID 穿越 + P1-2 明文 token 加密）。
// 测 workdaddy-baseline/scripts/lib.js 的 validateUid / backupPath / writeAccountFile / readAccountFile。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateUid, backupPath, writeAccountFile, readAccountFile } = require('../scripts/lib.js');

test('validateUid：拒绝路径穿越与非法字符', () => {
  assert.equal(validateUid('../escape'), null);
  assert.equal(validateUid('..'), null);
  assert.equal(validateUid('.'), null);
  assert.equal(validateUid('a/b'), null);
  assert.equal(validateUid('a\\b'), null);
  assert.equal(validateUid(''), null);
  assert.equal(validateUid(null), null);
  assert.equal(validateUid(123), null);
  assert.equal(validateUid('.hidden'), null);
  assert.equal(validateUid('x'.repeat(200)), null);
});

test('validateUid：合法 UUID 通过', () => {
  assert.equal(validateUid('23738ae0-3200-4d5c-ae3f-766d31a5dfc6'), '23738ae0-3200-4d5c-ae3f-766d31a5dfc6');
});

test('backupPath：拒绝路径穿越（抛错而非逃逸）', () => {
  const dataDir = '/tmp/wd';
  assert.throws(() => backupPath(dataDir, '../escape'), /非法账号 UID/);
  const ok = backupPath(dataDir, 'valid-uid');
  assert.ok(ok.endsWith(path.join('accounts', 'valid-uid.info')));
});

test('writeAccountFile/readAccountFile：加密往返', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wd-enc-'));
  const file = path.join(root, 'accounts', 't.info');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const obj = { account: { uid: 'u1', nickname: '大壮' }, auth: { accessToken: 'secret-token' } };
  writeAccountFile(root, file, obj);
  // 密文有 magic 且不含明文 token
  const raw = fs.readFileSync(file);
  assert.equal(raw.slice(0, 6).toString('latin1'), 'JZENC1');
  assert.ok(!raw.toString('latin1').includes('secret-token'), '密文不应含明文 token');
  // 解密往返
  const back = readAccountFile(root, file);
  assert.equal(back.auth.accessToken, 'secret-token');
});

test('readAccountFile：兼容旧明文文件', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wd-plain-'));
  const file = path.join(root, 'accounts', 'old.info');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ account: { uid: 'old' } }), 'utf8');
  const back = readAccountFile(root, file);
  assert.equal(back.account.uid, 'old');
});
