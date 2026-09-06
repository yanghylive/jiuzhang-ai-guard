'use strict';
// A0 复核 P1（F1）回归测试：trial-status 的 paid / membershipExpired 必须校验 validUntil。
// 根因场景：年费用户到期（status=active 但 validUntil 已过期）是正常业务路径，
// 若 paid 只判 status → 前端「显示会员、不锁 UI」，但后端 gate（isUnlocked）照样 402
// → 用户看到「没横幅没置灰，点啥都报试用结束」的精分状态。
// 本测试把四种 entitlement 形态 + 两种试用形态的契约钉死，防回归。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRouter } = require('../scripts/jz/api.js');
const { ensureTrialStart } = require('../scripts/jz/trial.js');
const { saveEntitlementCache } = require('../scripts/jz/kaypal-license.js');

function tmpRoot(name) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), name));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  return root;
}

function withServer(router, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      router.handle(req, res).catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'INTERNAL_REDACTED' }));
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      try {
        const out = await fn(server.address().port);
        server.close();
        resolve(out);
      } catch (e) {
        server.close();
        reject(e);
      }
    });
    server.on('error', reject);
  });
}

function call(port, p, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'GET', headers: { 'x-jz-token': token } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// 用给定 entitlement 起一个隔离 router 并查 trial-status
async function trialStatusWith(ent, { trialHours } = {}) {
  const root = tmpRoot('jz-trialstatus-');
  const TOKEN = 'ab'.repeat(32);
  ensureTrialStart(root);
  if (ent) saveEntitlementCache(root, ent);
  const prevHours = process.env.WBSWITCH_TRIAL_HOURS;
  if (trialHours != null) process.env.WBSWITCH_TRIAL_HOURS = String(trialHours);
  else delete process.env.WBSWITCH_TRIAL_HOURS;
  const router = createRouter({ root, token: TOKEN });
  try {
    return await withServer(router, (port) => call(port, '/api/license/trial-status', TOKEN));
  } finally {
    if (prevHours != null) process.env.WBSWITCH_TRIAL_HOURS = prevHours;
    else delete process.env.WBSWITCH_TRIAL_HOURS;
  }
}

const future = () => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
const past = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();

test('trial-status：试用中（无 entitlement）→ unlocked=true paid=false 未到期', async () => {
  const r = await trialStatusWith(null);
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.unlocked, true, '试用期内应解锁');
  assert.equal(d.paid, false);
  assert.equal(d.membershipExpired, false);
});

test('trial-status：付费有效（active + 未来 validUntil）→ unlocked=true paid=true', async () => {
  const r = await trialStatusWith({ status: 'active', plan: 'pro', validUntil: future() }, { trialHours: 0 });
  const d = r.body.data;
  assert.equal(d.unlocked, true, '付费有效期内即使试用过期也应解锁');
  assert.equal(d.paid, true);
  assert.equal(d.membershipExpired, false);
});

test('trial-status：终身（active 无 validUntil）→ unlocked=true paid=true', async () => {
  const r = await trialStatusWith({ status: 'active', plan: 'lifetime' }, { trialHours: 0 });
  const d = r.body.data;
  assert.equal(d.unlocked, true);
  assert.equal(d.paid, true);
  assert.equal(d.membershipExpired, false);
});

// —— A0 复核 P1 核心回归：年费到期 ——
test('trial-status：会员已到期（active + 过期 validUntil）→ paid=false membershipExpired=true unlocked=false', async () => {
  const r = await trialStatusWith({ status: 'active', plan: 'pro', validUntil: past() }, { trialHours: 0 });
  const d = r.body.data;
  assert.equal(d.unlocked, false, '到期会员后端应判未解锁（gate 会 402）');
  assert.equal(d.paid, false, '【F1 回归】过期 entitlement 不得再报 paid=true，否则前端不锁 UI');
  assert.equal(d.membershipExpired, true, '应显式标记会员已到期，供前端区分话术');
});

test('trial-status：试用过期且无 entitlement → unlocked=false paid=false membershipExpired=false', async () => {
  const r = await trialStatusWith(null, { trialHours: 0 });
  const d = r.body.data;
  assert.equal(d.unlocked, false);
  assert.equal(d.paid, false);
  assert.equal(d.membershipExpired, false, '未付费过不算「会员到期」，应走「试用结束」话术');
});

test('trial-status：expired entitlement 与后端 gate 判据一致（unlocked 为唯一锁定依据）', async () => {
  // 契约：前端 locked = !unlocked。本测试保证 unlocked 与 gate（isUnlocked）同源，
  // 杜绝「paid 与 unlocked 打架」再出现。
  const r = await trialStatusWith({ status: 'active', plan: 'pro', validUntil: past() }, { trialHours: 0 });
  const d = r.body.data;
  assert.equal(d.paid, d.unlocked, 'paid 与 unlocked 不得矛盾（过期态应同时为 false）');
});
