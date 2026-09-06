'use strict';
// 回归测试（指导 §4/§12）：/jz 管理页与管理会话——长期 API_TOKEN 不得出现在页面；
// 未授权请求拒绝；会话可建立/过期/登出；高风险操作强制一次性确认 token；跨 Origin 拒绝。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderAdminUI } = require('../scripts/jz/admin-ui');
const { SessionStore } = require('../scripts/jz/auth');
const { startRouterServer, jzFetch } = require('./_helpers');

const TOKEN = crypto.randomBytes(32).toString('hex');

test('renderAdminUI：页面不含长期 API_TOKEN（明文/变量/编码均无）', () => {
  const html = renderAdminUI();
  assert.ok(!html.includes(TOKEN), '页面不得包含 token 明文');
  assert.ok(!html.includes('var TOKEN'), '页面不得包含 token 变量赋值');
  assert.ok(!html.includes('x-jz-token'), '页面不得再以 x-jz-token 头携带长期凭据');
  assert.ok(html.includes('/api/admin/session'), '页面应通过会话引导端点建立短时会话');
});

test('GET /（独立模式）：带 token 打开的页面同样不注入 token', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-admin-'));
  const { baseUrl, close } = await startRouterServer({ root, token: TOKEN });
  try {
    const r = await jzFetch(baseUrl, '/', { token: TOKEN });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(!html.includes(TOKEN));
  } finally {
    await close();
  }
});

test('未建立会话且无 token：受保护 API 返回 401', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-admin2-'));
  const { baseUrl, close } = await startRouterServer({ root, token: TOKEN });
  try {
    for (const p of ['/api/vault/backups', '/api/settings/ui-state', '/api/vault/restore-progress']) {
      const r = await jzFetch(baseUrl, p);
      assert.equal(r.status, 401, `${p} 未授权必须 401`);
    }
  } finally {
    await close();
  }
});

test('会话引导：裸调 401；一次性 guest 升级；登出后立即失效', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-admin3-'));
  const { baseUrl, close } = await startRouterServer({ root, token: TOKEN });
  try {
    // P0：无凭据裸调会话引导必须 401（任何本机进程不能空手拿会话）
    const bare = await jzFetch(baseUrl, '/api/admin/session', { method: 'POST' });
    assert.equal(bare.status, 401, '无凭据引导会话必须 401');

    // 从管理页入口获取一次性 guest Cookie（GET / 带 token）
    const page = await jzFetch(baseUrl, '/', { token: TOKEN });
    assert.equal(page.status, 200);
    const guestHeader = page.headers.get('set-cookie') || '';
    assert.match(guestHeader, /jzsid=/, '页面响应必须下发一次性 guest Cookie');
    const guestCookie = guestHeader.split(';')[0];

    // guest → 会话（一次性升级）
    const boot = await jzFetch(baseUrl, '/api/admin/session', { method: 'POST', cookie: guestCookie });
    assert.equal(boot.status, 200);
    const setCookie = boot.headers.get('set-cookie') || '';
    assert.match(setCookie, /jzsid=/, '必须下发 jzsid 会话 Cookie');
    assert.match(setCookie, /HttpOnly/i, '会话 Cookie 必须 HttpOnly（JS 不可读）');
    assert.match(setCookie, /SameSite=Strict/i, '会话 Cookie 必须 SameSite=Strict');
    const cookie = setCookie.split(';')[0];

    // 升级后同一 Cookie 即正式会话：重复引导 = 会话续期（200），但 store 层 guest 只能升级一次
    //（见下方「guest 凭据」单测：二次 upgrade 返回 false）
    const renew = await jzFetch(baseUrl, '/api/admin/session', { method: 'POST', cookie: guestCookie });
    assert.equal(renew.status, 200, '持有效会话重复引导 = 续期');

    const ok = await jzFetch(baseUrl, '/api/vault/backups', { cookie });
    assert.equal(ok.status, 200, '持会话 Cookie 应能访问受保护 API');

    // token 与会话并存（注入面板仍走 token 通道）
    const withToken = await jzFetch(baseUrl, '/api/vault/backups', { token: TOKEN });
    assert.equal(withToken.status, 200);

    // 登出：吊销会话
    const out = await jzFetch(baseUrl, '/api/admin/session', { method: 'DELETE', cookie });
    assert.equal(out.status, 200);
    const after = await jzFetch(baseUrl, '/api/vault/backups', { cookie });
    assert.equal(after.status, 401, '登出后原会话必须立即失效');
  } finally {
    await close();
  }
});

test('guest 凭据：过期不可升级，guest 不能直接访问 API', () => {
  let now = 1_000_000;
  const store = new SessionStore({ now: () => now, guestTtlMs: 10 * 60 * 1000 });
  const { id } = store.issueGuest();
  assert.equal(store.touch(id), false, 'guest 凭据不能直接访问受保护 API');
  now += 11 * 60 * 1000;
  assert.equal(store.upgrade(id), false, 'guest 超时（10 分钟）后不可升级');
  // 有效期内单次升级
  const { id: g2 } = store.issueGuest();
  assert.equal(store.upgrade(g2), true, '有效期内可升级');
  assert.equal(store.upgrade(g2), false, '升级后 guest 形态不复存在');
  assert.equal(store.touch(g2), true, '升级后成为正式会话');
});

test('会话过期：空闲超时/绝对上限后必须 401', () => {
  let now = 1_000_000;
  const store = new SessionStore({ now: () => now, idleMs: 30 * 60 * 1000, maxMs: 8 * 60 * 60 * 1000 });
  const { id } = store.issue();
  assert.equal(store.touch(id), true, '新会话有效');
  now += 29 * 60 * 1000;
  assert.equal(store.touch(id), true, '空闲 29 分钟仍有效（滑动窗口）');
  now += 31 * 60 * 1000;
  assert.equal(store.touch(id), false, '空闲超 30 分钟必须失效');
  // 绝对上限：持续活跃也不能超过 8 小时
  const s2 = new SessionStore({ now: () => now, idleMs: 30 * 60 * 1000, maxMs: 8 * 60 * 60 * 1000 });
  const { id: id2 } = s2.issue();
  for (let i = 0; i < 100; i++) {
    now += 10 * 60 * 1000;
    s2.touch(id2);
  }
  assert.equal(s2.touch(id2), false, '持续活跃也不能超过绝对上限');
  // 未知/伪造会话
  assert.equal(store.touch('deadbeef'), false);
  assert.equal(store.touch(''), false);
});

test('高风险操作：无一次性确认 token 必须 403，confirm token 只能用一次', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-admin4-'));
  const { baseUrl, close } = await startRouterServer({ root, token: TOKEN });
  try {
    // 无 confirmToken → 403 confirm_required
    const noConfirm = await jzFetch(baseUrl, '/api/vault/export', { method: 'POST', token: TOKEN, body: { passphrase: 'pw' } });
    assert.equal(noConfirm.status, 403);
    const j = await noConfirm.json();
    assert.equal(j.data.reason, 'confirm_required');

    // 取一次性确认 token
    const issue = await jzFetch(baseUrl, '/api/auth/confirm', { method: 'POST', token: TOKEN, body: { scope: 'POST /api/vault/export' } });
    assert.equal(issue.status, 200);
    const confirmToken = (await issue.json()).data.confirmToken;

    // 第一次使用：通过鉴权（业务层因无备份 422，但不再是 403）
    const first = await jzFetch(baseUrl, '/api/vault/export', { method: 'POST', token: TOKEN, body: { passphrase: 'pw', confirmToken } });
    assert.equal(first.status, 422, '鉴权通过后业务失败为 422（无备份）');

    // 重放同一 confirmToken → 403（一次性）
    const replay = await jzFetch(baseUrl, '/api/vault/export', { method: 'POST', token: TOKEN, body: { passphrase: 'pw', confirmToken } });
    assert.equal(replay.status, 403, 'confirm token 重放必须 403');
  } finally {
    await close();
  }
});

test('跨 Origin / 非法 Host：一律拒绝（防 CSRF + DNS rebinding）', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-admin5-'));
  const { baseUrl, port, close } = await startRouterServer({ root, token: TOKEN });
  try {
    // 跨站 Origin：fetch 显式带 Origin 头
    const evil = await jzFetch(baseUrl, '/api/vault/backups', { token: TOKEN, headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403, '跨站 Origin 必须 403');

    // DNS rebinding：Attacker 域名解析到 127.0.0.1 → Host 头非 loopback → 403。
    // undici fetch 会覆盖 Host 头，故用原生 http.request 显式指定。
    const rebinding = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/vault/backups', method: 'GET', headers: { host: 'attacker.example', 'x-jz-token': TOKEN } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebinding, 403, '非 loopback Host 必须 403');
  } finally {
    await close();
  }
});

test('宿主策略：官方页面 Origin 白名单 + 注入面板短时 token', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-admin6-'));
  const { baseUrl, close } = await startRouterServer({
    root,
    token: TOKEN,
    // 模拟 daemon 注入的宿主策略：官方 renderer 页面来源放行；面板短时 token 有效。
    // 2026-08-30 复核 P1：不再把 'null' 当合法来源（产品策略改为默认拒绝 null Origin）
    allowedOrigin: (o) => !o || o === 'https://app.workbuddy.cn',
    tokenCheck: (c) => c === TOKEN || c === 'wbsshort-lived-inject-token-01',
  });
  try {
    // 官方页面 Origin + token → 放行（Inject UI 真实路径）
    const official = await jzFetch(baseUrl, '/api/vault/backups', { token: 'wbsshort-lived-inject-token-01', headers: { origin: 'https://app.workbuddy.cn' } });
    assert.equal(official.status, 200, '官方页面 Origin + 面板短时 token 必须 200');

    // 引导会话：先 GET / 拿一次性 guest Cookie（引导端点不接受空手调用）
    const page = await jzFetch(baseUrl, '/', { token: TOKEN });
    const guestCookie = (page.headers.get('set-cookie') || '').split(';')[0];
    const boot = await jzFetch(baseUrl, '/api/admin/session', { method: 'POST', cookie: guestCookie });
    assert.equal(boot.status, 200, '持 guest Cookie 引导会话应成功');
    const cookie = (boot.headers.get('set-cookie') || '').split(';')[0];
    const sessOfficial = await jzFetch(baseUrl, '/api/vault/backups', { cookie, headers: { origin: 'https://app.workbuddy.cn' } });
    assert.equal(sessOfficial.status, 403, '官方页面 Origin 不得使用会话 Cookie');

    // 白名单外 Origin + 任意 token → 403
    const outsider = await jzFetch(baseUrl, '/api/vault/backups', { token: TOKEN, headers: { origin: 'https://other.example' } });
    assert.equal(outsider.status, 403);
  } finally {
    await close();
  }
});
