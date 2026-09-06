'use strict';
// OIDC 登录单测：PKCE 生成 + authorize URL 构造（token 交换走端到端验证）。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { generatePkce, buildAuthorizeUrl } = require('../scripts/jz/oidc');

test('generatePkce：verifier/challenge 均为 43 字符 base64url，challenge=sha256(verifier)', () => {
  const { verifier, challenge } = generatePkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/, `verifier=${verifier}`);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, `challenge=${challenge}`);
  assert.notEqual(verifier, challenge);
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
});

test('buildAuthorizeUrl：含 OIDC authorization_code + PKCE 参数', () => {
  const url = buildAuthorizeUrl({ challenge: 'ch123', state: 'st456' });
  const u = new URL(url);
  assert.equal(u.pathname, '/api/oidc/authorize');
  assert.equal(u.searchParams.get('client_id'), 'jz-ai-guard');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge'), 'ch123');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), 'st456');
  assert.ok(u.searchParams.get('redirect_uri').includes('/api/oidc/callback'), 'redirect_uri 应指向本地回调');
  assert.ok(u.searchParams.get('scope').includes('openid'));
});
