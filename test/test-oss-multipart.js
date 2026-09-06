'use strict';
// 2026-08-30 复核 E2E 回归：OSS Multipart Upload 签名正确性（真实 OSS 403 抓到的三个 bug）：
//   ① initiate 的 ?uploads 是无值 subResource（签名与 URL 都不带 '='）
//   ② 每个请求 Date header 与签名串必须同一时刻（跨秒 → SignatureDoesNotMatch）
//   ③ POST 请求的 Content-Type 必须参与签名（不能置空）
// 用注入 transport 断言请求头与签名字符串的一致性。
// 注意：PART_SIZE 是模块级常量（require 时读取），必须在 require 之前设置。
process.env.JZ_OSS_PART_SIZE = String(1024 * 1024); // 1MB 分片 → 3MB 体 = 3 段
process.env.JZ_OSS_PART_CONCURRENCY = '1';
process.env.JZ_OSS_MAX_RETRIES = '0';
const test = require('node:test');
const assert = require('node:assert');
const { putObjectMultipart, ossV1Authorization } = require('../scripts/jz/oss-client');

const AK = 'AKTEST';
const SK = 'SKTEST';
const BUCKET = 'test-bucket';
const REGION = 'oss-cn-hangzhou';
const KEY = 'updates/0.3.1/JIUZHANG AI 管家-Setup-test.exe';
const BIG_BODY = Buffer.alloc(3 * 1024 * 1024, 7); // 3MB → 3 段

// 记录所有请求，验证签名；按请求类型返回 OSS 风格响应
function recordingTransport(calls) {
  return {
    request(opts, cb) {
      calls.push({ opts });
      let body = '';
      let statusCode = 200;
      let etag = null;
      const path = opts.path || '';
      if (path.includes('?uploads')) {
        body = '<InitiateMultipartUploadResult><UploadId>UPLOAD-123</UploadId></InitiateMultipartUploadResult>';
      } else if (path.includes('partNumber=')) {
        const m = path.match(/partNumber=(\d+)/) || [];
        etag = '"ETAG-P' + m[1] + '"';
      } else if (path.includes('uploadId=')) {
        body = '<CompleteMultipartUploadResult><ETag>"FINAL"</ETag></CompleteMultipartUploadResult>';
      }
      const res = {
        statusCode,
        headers: etag ? { etag } : {},
        on(ev, fn) {
          if (ev === 'data' && body) fn(Buffer.from(body));
          if (ev === 'end') setTimeout(fn, 1);
          return this;
        },
      };
      const req = {
        headers: opts.headers,
        setTimeout() { return this; },
        on(ev, fn) { if (ev === 'error') { /* noop */ } return this; },
        write() {},
        end() { setTimeout(() => cb(res), 2); },
        destroy() {},
      };
      return req;
    },
  };
}

test('multipart：initiate 的 ?uploads 签名不含 "="（无值 subResource）', () => {
  const calls = [];
  const t = recordingTransport(calls);
  return putObjectMultipart({ accessKeyId: AK, accessKeySecret: SK, bucket: BUCKET, region: REGION, key: KEY, body: BIG_BODY, transport: t })
    .then((r) => {
      assert.equal(r.ok, true);
      assert.equal(r.parts, 3);
      assert.ok(calls.length >= 5, `应有 ≥5 个请求，实际 ${calls.length}`);
      const init = calls[0];
      assert.equal(init.opts.method, 'POST');
      assert.ok(init.opts.path.endsWith('?uploads'), `initiate path 应 ?uploads: ${init.opts.path}`);
      const auth = String(init.opts.headers.Authorization || '');
      assert.ok(auth.startsWith('OSS '), '有 Authorization');
      // 独立重算签名验证（同一 date + contentType）
      const date = String(init.opts.headers.Date || '');
      const expected = ossV1Authorization({
        accessKeyId: AK, accessKeySecret: SK, bucket: BUCKET, key: KEY,
        contentType: 'application/octet-stream', date, method: 'POST', subResource: 'uploads',
      });
      assert.equal(auth, expected, 'initiate 签名必须与请求头一致（uploads 无 =）');
    });
});

test('multipart：每个请求 Date header 为 RFC1123（跨秒 bug 回归：同请求同 date）', () => {
  const calls = [];
  const t = recordingTransport(calls);
  return putObjectMultipart({ accessKeyId: AK, accessKeySecret: SK, bucket: BUCKET, region: REGION, key: KEY, body: BIG_BODY, transport: t })
    .then(() => {
      for (let i = 0; i < calls.length; i++) {
        const date = String(calls[i].opts.headers.Date || '');
        assert.match(date, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/, `请求 ${i} Date 格式: ${date}`);
      }
    });
});

test('multipart：POST initiate 的 Content-Type 参与签名（不能置空）', () => {
  const calls = [];
  const t = recordingTransport(calls);
  return putObjectMultipart({ accessKeyId: AK, accessKeySecret: SK, bucket: BUCKET, region: REGION, key: KEY, body: BIG_BODY, contentType: 'application/x-test', transport: t })
    .then(() => {
      const init = calls[0];
      assert.equal(init.opts.headers['Content-Type'], 'application/x-test', 'initiate 带 Content-Type');
      const date = String(init.opts.headers.Date || '');
      const expected = ossV1Authorization({
        accessKeyId: AK, accessKeySecret: SK, bucket: BUCKET, key: KEY,
        contentType: 'application/x-test', date, method: 'POST', subResource: 'uploads',
      });
      assert.equal(String(init.opts.headers.Authorization), expected, 'POST initiate 签名含 Content-Type');
    });
});
