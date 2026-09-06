'use strict';
// 报错自动上报 + 零依赖 OSS 客户端单测（transport 注入，不发真实网络）。
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { ossV1Authorization } = require('../scripts/jz/oss-client');
const { reportError, buildReport } = require('../scripts/jz/error-report');

function fakeTransport() {
  const calls = [];
  return {
    calls,
    request(opts, cb) {
      calls.push(opts);
      const req = new EventEmitter();
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        process.nextTick(() => {
          res.emit('data', '');
          res.emit('end');
          cb(res);
        });
      };
      return req;
    },
  };
}

const OSS_ENV = { accessKeyId: 'id', accessKeySecret: 'sec', bucket: 'b', region: 'r' };

test('ossV1Authorization 生成合法 OSS 签名头', () => {
  const auth = ossV1Authorization({
    accessKeyId: 'testid', accessKeySecret: 'testsec', bucket: 'b', region: 'r',
    key: 'updates/x/manifest.json', contentType: 'application/json', date: 'Mon, 24 Aug 2026 00:00:00 GMT',
  });
  assert.ok(auth.startsWith('OSS testid:'), auth);
  const sig = auth.split(':')[1];
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(sig), '签名应为 base64');
});

test('reportError 对 500 错误触发上传（OSS 头含签名 + error-reports 路径）', () => {
  const t = fakeTransport();
  const r = reportError(
    { requestId: 'req-1', method: 'POST', url: '/api/x', status: 500, message: 'boom', stack: 'at x' },
    { ossEnv: OSS_ENV, transport: t },
  );
  assert.equal(r.ok, true);
  assert.equal(t.calls.length, 1);
  const opts = t.calls[0];
  assert.match(opts.path, /^\/error-reports\/\d{4}-\d{2}-\d{2}\//, '路径应为 error-reports/<date>/');
  assert.ok(opts.headers.Authorization.startsWith('OSS id:'), '应带 OSS 签名头');
  assert.equal(opts.headers['Content-Type'], 'application/json');
});

test('reportError 对 <500 错误跳过', () => {
  const t = fakeTransport();
  const r = reportError({ requestId: 'req-2', method: 'GET', url: '/', status: 404, message: 'nf' }, { ossEnv: OSS_ENV, transport: t });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(t.calls.length, 0);
});

test('reportError 限流：同 requestId 第二次跳过', () => {
  const t = fakeTransport();
  reportError({ requestId: 'req-dup', method: 'POST', url: '/', status: 500 }, { ossEnv: OSS_ENV, transport: t });
  const r2 = reportError({ requestId: 'req-dup', method: 'POST', url: '/', status: 500 }, { ossEnv: OSS_ENV, transport: t });
  assert.equal(r2.skipped, true);
  assert.equal(t.calls.length, 1);
});

test('无 OSS 凭证时跳过（不抛错）', () => {
  const t = fakeTransport();
  const r = reportError({ requestId: 'req-nokey', method: 'POST', url: '/', status: 500 }, { ossEnv: null, transport: t });
  assert.equal(r.ok, false);
  assert.equal(t.calls.length, 0);
});

test('buildReport 对 message/stack 脱敏', () => {
  const rep = buildReport({
    requestId: 'r', method: 'POST', url: '/', status: 500,
    message: 'token=secret123 fail', stack: 'at x token=abc123',
  });
  const json = JSON.stringify(rep);
  assert.ok(!json.includes('secret123'), 'message 明文 token 泄漏');
  assert.ok(!json.includes('abc123'), 'stack 明文 token 泄漏');
  assert.equal(rep.app, 'jz-ai-guard');
});
