'use strict';
// build-release OSS 上传测试：uploadToOss / readOssEnv（transport 注入，不发真实网络）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { uploadToOss, readOssEnv } = require('../scripts/build-release');

function fakeTransport() {
  const calls = [];
  return {
    calls,
    request(opts, cb) {
      calls.push(opts);
      const req = new EventEmitter();
      req.end = () => {
        setTimeout(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          // 先回调让 putObject 挂上 data/end 监听，再异步发事件（顺序反了 Promise 永不 resolve）
          cb(res);
          setImmediate(() => {
            res.emit('data', '');
            res.emit('end');
          });
        }, 0);
      };
      return req;
    },
  };
}

function tmpDmg() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-rel-'));
  const p = path.join(dir, 'JIUZHANG AI 管家-1.0.16.dmg');
  fs.writeFileSync(p, Buffer.from('fake-dmg-bytes'));
  return p;
}

const OSS_ENV = { accessKeyId: 'id', accessKeySecret: 'sec', bucket: 'bkt', region: 'oss-cn-hangzhou' };

test('readOssEnv：有凭据返回配置，缺 SECRET 返回 null', () => {
  const prevId = process.env.OSS_ACCESS_KEY_ID;
  const prevSec = process.env.OSS_ACCESS_KEY_SECRET;
  try {
    process.env.OSS_ACCESS_KEY_ID = 'x';
    delete process.env.OSS_ACCESS_KEY_SECRET;
    assert.equal(readOssEnv(), null, '缺 secret 应为 null');
    process.env.OSS_ACCESS_KEY_SECRET = 'y';
    const env = readOssEnv();
    assert.equal(env.accessKeyId, 'x');
    assert.equal(env.bucket, 'kaypal', '默认 bucket=kaypal');
    assert.equal(env.region, 'oss-cn-hangzhou', '默认 region=杭州');
  } finally {
    if (prevId === undefined) delete process.env.OSS_ACCESS_KEY_ID; else process.env.OSS_ACCESS_KEY_ID = prevId;
    if (prevSec === undefined) delete process.env.OSS_ACCESS_KEY_SECRET; else process.env.OSS_ACCESS_KEY_SECRET = prevSec;
  }
});

test('uploadToOss：缺凭据 fail-closed 跳过，不发网络请求', async () => {
  const t = fakeTransport();
  const dmg = tmpDmg();
  const r = await uploadToOss({ ossEnv: null, version: '1.0.16', dmgPath: dmg, signature: 'sig', digest: 'd', transport: t });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NO_OSS_CREDENTIALS');
  assert.equal(t.calls.length, 0, '不应发任何请求');
});

test('uploadToOss：上传 DMG + manifest（路径 updates/<version>/、manifest 含签名与 SHA256）', async () => {
  const t = fakeTransport();
  const dmg = tmpDmg();
  const r = await uploadToOss({ ossEnv: OSS_ENV, version: '1.0.16', dmgPath: dmg, signature: 'SIG123', digest: 'abc123', transport: t });
  assert.equal(r.ok, true);
  assert.equal(r.uploaded.length, 2);
  assert.equal(t.calls.length, 2);
  // 第一个：DMG 本体
  const dmgReq = t.calls[0];
  // OSS key 用原始文件名（含空格/中文合法）；HTTP 请求 path 自动 URL 编码，故断言编码形式
assert.equal(dmgReq.path, '/updates/1.0.16/JIUZHANG%20AI%20%E7%AE%A1%E5%AE%B6-1.0.16.dmg');
  assert.equal(dmgReq.method, 'PUT');
  assert.equal(dmgReq.headers['Content-Type'], 'application/x-apple-diskimage');
  assert.ok(dmgReq.headers.Authorization.startsWith('OSS id:'), '应带 OSS V1 签名');
  // 第二个：manifest.json
  const mfReq = t.calls[1];
  assert.equal(mfReq.path, '/updates/1.0.16/manifest.json');
  assert.equal(mfReq.headers['Content-Type'], 'application/json');
  // manifest 结构（返回值回传）：schema/version/sha256/ed25519Signature 齐全
  assert.equal(r.manifest.schema, 'release-manifest/v1');
  assert.equal(r.manifest.version, '1.0.16');
  assert.equal(r.manifest.sha256, 'abc123');
  assert.equal(r.manifest.ed25519Signature, 'SIG123');
  assert.equal(r.manifest.file, 'JIUZHANG AI 管家-1.0.16.dmg');
});

test('uploadToOss：无签名时 manifest.ed25519Signature 为 null（不假装有签名）', async () => {
  const t = fakeTransport();
  const dmg = tmpDmg();
  const r = await uploadToOss({ ossEnv: OSS_ENV, version: '1.0.17', dmgPath: dmg, signature: null, digest: 'dd', transport: t });
  assert.equal(r.ok, true);
  assert.equal(r.manifest.ed25519Signature, null);
});

test('uploadToOss：dry-run 只打印不上传', async () => {
  const t = fakeTransport();
  const dmg = tmpDmg();
  const r = await uploadToOss({ ossEnv: OSS_ENV, version: '9.9.9', dmgPath: dmg, signature: 's', digest: 'd', transport: t, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'DRY_RUN');
  assert.equal(t.calls.length, 0, 'dry-run 不发请求');
});
