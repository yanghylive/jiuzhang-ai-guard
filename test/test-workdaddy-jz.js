'use strict';
// WorkDaddy 二开并入验证：九章管家新能力子系统（workdaddy-baseline/scripts/jz/）。
// 重点：① createRouter 接受宿主统一 API_TOKEN（单进程单 secret）
//       ② 鉴权（无 token/错 token → 401）
//       ③ 纯本地只读路由 + desktop-auth 登录失败路径 + 已删除 update/cdp 路由 → 404
// 不依赖网络/CDP（涉及 kaypal 与 CDP 的路径不在此测，由 jz-ai-guard 原模块测试覆盖）。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRouter } = require('../scripts/jz/api.js');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wd-jz-'));
const TOKEN = 'ab'.repeat(32); // 64 hex，模拟 WorkDaddy API_TOKEN 格式

const router = createRouter({ root, token: TOKEN });
const server = http.createServer((req, res) => {
  router.handle(req, res).catch(() => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'INTERNAL_REDACTED' }));
  });
});

function call(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'content-type': 'application/json', host: `127.0.0.1:${port}` };
    if (token) headers['x-jz-token'] = token;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null });
        } catch {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(fn) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(server.address().port);
  } finally {
    server.close();
  }
}

test('createRouter 接受宿主统一 token（单进程单 secret）', () => {
  assert.equal(router.token, TOKEN, 'token 应与宿主传入一致');
  assert.equal(typeof router.handle, 'function');
  // 统一 token 后，不应在数据目录另生成独立 .daemon-token（走宿主 API_TOKEN）
  assert.ok(!fs.existsSync(path.join(root, 'runtime', '.daemon-token')), '不应自生成独立 token 文件');
});

test('鉴权：无 token / 错 token 一律 401（loopback 非安全边界）', async () => {
  await withServer(async (port) => {
    const noTok = await call(port, 'GET', '/api/vault/backups');
    assert.equal(noTok.status, 401);
    assert.equal(noTok.body.error, 'UNAUTHORIZED_LOCAL_REQUEST');

    const badTok = await call(port, 'GET', '/api/vault/backups', null, 'f'.repeat(64));
    assert.equal(badTok.status, 401);
  });
});

test('带 token：纯本地只读路由返回 200', async () => {
  await withServer(async (port) => {
    const backups = await call(port, 'GET', '/api/vault/backups', null, TOKEN);
    assert.equal(backups.status, 200);
    assert.equal(backups.body.ok, true);
    assert.ok(Array.isArray(backups.body.data.backups), 'backups 应为数组');

    // 本地券体系已删（2026-08-31）：/api/coupon/list 应 404
    const couponsGone = await call(port, 'GET', '/api/coupon/list', null, TOKEN);
    assert.equal(couponsGone.status, 404, '本地券端点应已移除');

    const oidc = await call(port, 'GET', '/api/oidc/status', null, TOKEN);
    assert.equal(oidc.status, 200);
    assert.equal(oidc.body.data.loggedIn, false, '未登录时 loggedIn=false');

    const desktop = await call(port, 'GET', '/api/desktop-auth/status', null, TOKEN);
    assert.equal(desktop.status, 200);
    assert.equal(desktop.body.data.loggedIn, false, '未登录时 loggedIn=false');
  });
});

test('desktop-auth 登录缺参数 → 400 INVALID_REQUEST（不触网）', async () => {
  await withServer(async (port) => {
    const r = await call(port, 'POST', '/api/desktop-auth/login', { phone: '', password: '' }, TOKEN);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'INVALID_REQUEST');
  });
});

test('已删除的 update/cdp 路由 → 404（WorkDaddy 已有自有更新/CDP 流程）', async () => {
  await withServer(async (port) => {
    const upd = await call(port, 'GET', '/api/update/status', null, TOKEN);
    assert.equal(upd.status, 404);

    const cdp = await call(port, 'POST', '/api/cdp/command', { port: 9222, targetId: 'x', method: 'Runtime.evaluate' }, TOKEN);
    assert.equal(cdp.status, 404);
  });
});
