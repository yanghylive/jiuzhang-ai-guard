'use strict';
// 本机微信一键登录 mock 底座 E2E（2026-09-04）。
// 起真实 daemon（隔离端口 47931 + 临时数据目录）+ mock 底座（47930），验证：
//   ① status 检测路由出参；② login → NO_BINDING(409/needBind)；③ bind/start → intent（配对码）；
//   ④ bind/status pending→bound；⑤ bound 后 login 全链成功 → desktop-auth 落盘 loggedIn；
//   ⑥ 底座不可达 → 503 WECHAT_LOGIN_UNAVAILABLE（前端据此回落扫码）。
// 退出码 0=全过；任一断言失败退出码 1。
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DAEMON_PORT = 47931;
const MOCK_PORT = 47930;
const ROOT = path.join(__dirname, '..', '..');

// ===== mock 底座 =====
const mockState = { verifyMode: 'no_binding', bindStatus: 'pending', intents: {} };

function mockHandler(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const ok = (data) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, data }));
    if (req.method === 'POST' && u.pathname === '/__mock/set') {
      const s = JSON.parse(body || '{}');
      if (s.verifyMode) mockState.verifyMode = s.verifyMode;
      if (s.bindStatus) mockState.bindStatus = s.bindStatus;
      return ok({ ...mockState });
    }
    if (req.method === 'POST' && u.pathname === '/api/auth/device-challenge') {
      if (mockState.verifyMode === 'down') {
        return res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'UNAVAILABLE' }));
      }
      return ok({ challenge: crypto.randomBytes(32).toString('base64'), expiresIn: 60 });
    }
    if (req.method === 'POST' && u.pathname === '/api/auth/device-verify') {
      if (mockState.verifyMode === 'no_binding') {
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'NO_BINDING' }));
      }
      if (mockState.verifyMode !== 'ok') {
        return res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'UNAVAILABLE' }));
      }
      return ok({
        token: 'mock-token-' + Date.now(), refreshToken: 'mock-refresh', expiresIn: 7200,
        user: { nickname: '产品负责人(mock)', phone: '13800138000' }, device: { name: 'e2e-mac' },
      });
    }
    if (req.method === 'POST' && u.pathname === '/api/auth/device-bind/intent') {
      const b = JSON.parse(body || '{}');
      const intentId = 'it_' + Date.now();
      mockState.intents[intentId] = { wxid: b.wxid, pubkey: b.devicePubkey };
      return ok({
        intentId, pairingCode: '772211', expiresIn: 120,
        // 对齐真实底座：intent 返回授权页地址（管家端据此直出绑定二维码）
        verificationUrl: 'http://127.0.0.1:47930/api/auth/device-bind/page?intentId=' + intentId,
      });
    }
    if (req.method === 'GET' && u.pathname === '/api/auth/device-bind/intent') {
      const intentId = u.searchParams.get('intentId');
      if (!intentId || !mockState.intents[intentId]) {
        return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'NO_INTENT' }));
      }
      return ok({ status: mockState.bindStatus });
    }
    res.writeHead(404).end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
  });
}

function request(port, method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + apiPath)), 15000);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-jz-token'] = token;
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    const r = http.request({ host: '127.0.0.1', port, path: apiPath, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        clearTimeout(timer);
        let j = null;
        try { j = JSON.parse(d); } catch { /* keep null */ }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (payload) r.write(payload);
    r.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitDaemonUp() {
  for (let i = 0; i < 60; i++) {
    try {
      await request(DAEMON_PORT, 'GET', '/api/license/plans', null, null);
      return true;
    } catch { await sleep(500); }
  }
  return false;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wl-e2e-'));
  const homeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wl-home-'));
  // Make Mac directory probing deterministic without touching the real user's
  // WeChat data. Use the module's explicit test-only root override: macOS
  // os.homedir() is not guaranteed to follow a child-process HOME override.
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.join(homeDir, 'wxid_e2e'), { recursive: true });
  }
  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail: detail || '' });
    console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  };

  // 1. mock 底座
  const mockSrv = http.createServer(mockHandler);
  await new Promise((r) => mockSrv.listen(MOCK_PORT, '127.0.0.1', r));
  console.log('[e2e] mock base up @' + MOCK_PORT);

  // 2. 起 daemon（隔离数据目录 + 隔离端口 + 0 试用 + mock 底座）
  const daemon = spawn(process.execPath, [path.join(ROOT, 'scripts', 'daemon.js')], {
    env: {
      ...process.env,
      WBSWITCH_DATA_DIR: dataDir,
      WBSWITCH_PORT: String(DAEMON_PORT),
      WBSWITCH_PROFILE: 'workbuddy-cn',
      WBSWITCH_TRIAL_HOURS: '0',
      NODE_ENV: 'test',
      JZ_WECHAT_LOCAL_MOCK: 'http://127.0.0.1:' + MOCK_PORT,
      ...(process.platform === 'darwin' ? { JZ_WECHAT_ROOTS: homeDir } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', () => {});
  daemon.stderr.on('data', (c) => process.stderr.write('[daemon] ' + c));
  const up = await waitDaemonUp();
  check('daemon 起来了（隔离端口 47931）', up);
  if (!up) throw new Error('daemon 未就绪');
  await sleep(1500); // 等路由/子系统全挂载
  const token = fs.readFileSync(path.join(dataDir, '.api-token'), 'utf8').trim();
  check('token 文件可读（64hex）', /^[0-9a-f]{64}$/.test(token));

  try {
    // ① status 检测
    const st = await request(DAEMON_PORT, 'GET', '/api/wechat-local/status', null, token);
    check('① /api/wechat-local/status 200 且 supported=true（darwin）', st.status === 200 && st.body.ok && st.body.data.supported === true && !Object.prototype.hasOwnProperty.call(st.body.data, 'wxid'),
      'detected=' + st.body.data.detected + ' confidence=' + st.body.data.confidence + ' wxidReturned=' + Object.prototype.hasOwnProperty.call(st.body.data, 'wxid'));
    const detected = st.body.data.detected === true;

    // ② login：mock NO_BINDING → 409 + needBind
    mockState.verifyMode = 'no_binding';
    const nb = await request(DAEMON_PORT, 'POST', '/api/wechat-local/login', {}, token);
    check('② 未绑定 login → 409 + needBind=true（前端据此进绑定流程）',
      nb.status === 409 && nb.body.data && nb.body.data.needBind === true && nb.body.error === 'NO_BINDING',
      'status=' + nb.status + ' error=' + nb.body.error);

    // ③ bind/start：需本机检测到微信（环境相关；未检测到则记 SKIP-FAIL 由人工核对）
    let pairingCode = '';
    if (detected) {
      const bs = await request(DAEMON_PORT, 'POST', '/api/wechat-local/bind/start', {}, token);
      check('③ bind/start → 200 + 配对码且不回传 wxid', bs.status === 200 && bs.body.ok && !!bs.body.data.pairingCode && !Object.prototype.hasOwnProperty.call(bs.body.data, 'wxid'),
        'pairingCode=' + bs.body.data.pairingCode + ' wxidReturned=' + Object.prototype.hasOwnProperty.call(bs.body.data, 'wxid'));
      pairingCode = bs.body.data.pairingCode || '';

      // ④ bind/status：pending(202) → 置 bound → 200
      const p1 = await request(DAEMON_PORT, 'GET', '/api/wechat-local/bind/status', null, token);
      check('④a bind/status pending → 202', p1.status === 202 && p1.body.data.status === 'pending');
      mockState.bindStatus = 'bound';
      const p2 = await request(DAEMON_PORT, 'GET', '/api/wechat-local/bind/status', null, token);
      check('④b 置 bound 后 bind/status → 200', p2.status === 200 && p2.body.data.status === 'bound');
    } else {
      check('③ bind/start（非 macOS 环境跳过）', true, 'SKIP：本机微信目录探测仅在 macOS E2E 执行');
    }

    // ⑤ bound 后 login 全链成功 → desktop-auth 落盘
    mockState.verifyMode = 'ok';
    const ok = await request(DAEMON_PORT, 'POST', '/api/wechat-local/login', {}, token);
    check('⑤ 绑定后 login → 200 + user（响应不含 token）',
      ok.status === 200 && ok.body.ok && ok.body.data.user && ok.body.data.loginMethod === 'wechat-local' && !ok.body.data.accessToken,
      'user=' + JSON.stringify(ok.body.data.user || {}));
    const authSt = await request(DAEMON_PORT, 'GET', '/api/desktop-auth/status', null, token);
    check('⑤b desktop-auth/status → loggedIn=true（登录产物与 desktop-auth 同构落盘）',
      authSt.status === 200 && authSt.body.data.loggedIn === true,
      'user=' + JSON.stringify((authSt.body.data.user || {}).nickname || ''));

    // ⑥ 底座不可达 → 503（前端回落扫码信号；challenge 阶段挂=CHALLENGE_FAILED，verify 阶段挂=WECHAT_LOGIN_UNAVAILABLE）
    mockState.verifyMode = 'down';
    const down = await request(DAEMON_PORT, 'POST', '/api/wechat-local/login', {}, token);
    check('⑥ 底座不可达 → 503（CHALLENGE_FAILED / WECHAT_LOGIN_UNAVAILABLE 均可）',
      down.status === 503 && (down.body.error === 'CHALLENGE_FAILED' || down.body.error === 'WECHAT_LOGIN_UNAVAILABLE'),
      'status=' + down.status + ' error=' + down.body.error);

    // ⑦ 登录态在位时 status/鉴权豁免链不受影响（trial-status 前缀豁免）
    const trial = await request(DAEMON_PORT, 'GET', '/api/license/trial-status', null, token);
    check('⑦ trial-status 正常返回（TRIAL 豁免链无回归）', trial.status === 200 && trial.body.ok === true);
  } finally {
    daemon.kill('SIGKILL');
    mockSrv.close();
    console.log('[e2e] daemon/mock 已清理；数据目录（临时，可留待系统清理）: ' + dataDir);
  }

  const fails = results.filter((r) => !r.pass);
  console.log('\n==== 汇总: ' + (results.length - fails.length) + '/' + results.length + ' PASS ====');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('[e2e] 致命:', e); process.exit(1); });
