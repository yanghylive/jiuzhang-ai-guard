'use strict';
// 本机微信一键登录单测（2026-09-04）：设备密钥对 / 挑战签名 / 绑定编排 / 静默登录链。
// 底座 HTTP 全部走 _basePost/_baseGet/_detect 注入桩，不碰真机微信目录与真实网络。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const wl = require('../scripts/jz/wechat-local');

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-wl-' + tag + '-'));
}

// ---------- 设备密钥对 ----------

test('baseOverride：mock 仅允许 NODE_ENV=test 且必须是 loopback HTTP', () => {
  const oldMock = process.env.JZ_WECHAT_LOCAL_MOCK;
  const oldNodeEnv = process.env.NODE_ENV;
  try {
    process.env.JZ_WECHAT_LOCAL_MOCK = 'http://127.0.0.1:47930';
    delete process.env.NODE_ENV;
    assert.equal(wl.baseOverride(), '', '非测试环境不得切 mock');
    process.env.NODE_ENV = 'test';
    assert.equal(wl.baseOverride(), 'http://127.0.0.1:47930');
    process.env.JZ_WECHAT_LOCAL_MOCK = 'http://example.com';
    assert.equal(wl.baseOverride(), '', 'mock 不得指向外部主机');
  } finally {
    if (oldMock === undefined) delete process.env.JZ_WECHAT_LOCAL_MOCK;
    else process.env.JZ_WECHAT_LOCAL_MOCK = oldMock;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
  }
});

test('ensureDeviceKeypair：生成 → 持久化 0600 → 复用同一密钥', () => {
  const root = tmpRoot('kp');
  const kp1 = wl.ensureDeviceKeypair(root);
  assert.ok(kp1.publicKey.includes('BEGIN PUBLIC KEY'));
  assert.ok(kp1.privateKey.includes('BEGIN PRIVATE KEY'));
  const p = wl.keypairPath(root);
  assert.ok(fs.existsSync(p));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, '私钥落盘必须 0600');
  }
  const kp2 = wl.ensureDeviceKeypair(root);
  assert.equal(kp1.publicKey, kp2.publicKey, '重复调用应复用已持久化密钥');
  // 线上契约 = base64(PEM 文本)：服务端 decodeDevicePubkey 是 base64→utf8→createPublicKey(pem)。
  // 此前误发 base64(裸 32B) 且本行固化错误断言——2026-09-05 生产 smoke 抓出后改为对齐服务端。
  const decodedPem = Buffer.from(wl.devicePublicKeyB64(kp1.publicKey), 'base64').toString('utf8');
  assert.ok(decodedPem.includes('BEGIN PUBLIC KEY'), '线上公钥必须是 base64(PEM 文本)');
  const parsedKey = crypto.createPublicKey(decodedPem);
  assert.equal(parsedKey.asymmetricKeyType, 'ed25519', '解码后必须是可解析的 Ed25519 公钥');
});

test('ensureDeviceKeypair：公私钥不匹配 → 不得接受，自动重生成', () => {
  const root = tmpRoot('kp-mismatch');
  const first = wl.ensureDeviceKeypair(root);
  const other = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(wl.keypairPath(root), JSON.stringify({
    publicKey: first.publicKey,
    privateKey: other.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }));
  const repaired = wl.ensureDeviceKeypair(root);
  assert.notEqual(repaired.publicKey, first.publicKey, '不匹配 pair 不得复用旧公钥');
  const derived = crypto.createPublicKey(crypto.createPrivateKey(repaired.privateKey)).export({ type: 'spki', format: 'pem' });
  assert.equal(wl.devicePublicKeyB64(repaired.publicKey), wl.devicePublicKeyB64(derived), '重生成后的公私钥必须匹配');
});

test('ensureDeviceKeypair：文件损坏 → 自动重生成新密钥（不抛异常）', () => {
  const root = tmpRoot('kp-corrupt');
  const kp1 = wl.ensureDeviceKeypair(root);
  fs.writeFileSync(wl.keypairPath(root), '{not valid json');
  const kp2 = wl.ensureDeviceKeypair(root);
  assert.notEqual(kp1.publicKey, kp2.publicKey, '损坏后应重生成');
  // 同样覆盖「JSON 合法但内容非密钥」分支
  fs.writeFileSync(wl.keypairPath(root), JSON.stringify({ publicKey: 'garbage', privateKey: 'garbage' }));
  const kp3 = wl.ensureDeviceKeypair(root);
  assert.notEqual(kp2.publicKey, kp3.publicKey);
});

test('ensureDeviceKeypair：符号链接凭据必须 fail-closed，不得读取外部目标', (t) => {
  if (process.platform === 'win32') return t.skip('Windows 创建符号链接需要额外权限');
  const root = tmpRoot('kp-symlink');
  const outside = tmpRoot('kp-outside');
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  const target = path.join(outside, 'outside-key.json');
  fs.writeFileSync(target, JSON.stringify({ publicKey: 'outside', privateKey: 'outside' }));
  fs.symlinkSync(target, wl.keypairPath(root));
  assert.throws(() => wl.ensureDeviceKeypair(root), (e) => e && e.code === 'ESYMLINK');
  assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify({ publicKey: 'outside', privateKey: 'outside' }));
});

test('ensureDeviceKeypair：复用旧密钥时收紧历史 0644 权限', (t) => {
  if (process.platform === 'win32') return t.skip('Windows 不以 chmod 表达凭据权限');
  const root = tmpRoot('kp-mode');
  const kp = wl.ensureDeviceKeypair(root);
  fs.chmodSync(wl.keypairPath(root), 0o644);
  const reused = wl.ensureDeviceKeypair(root);
  assert.equal(reused.publicKey, kp.publicKey);
  assert.equal(fs.lstatSync(wl.keypairPath(root)).mode & 0o777, 0o600);
});

test('ensureDeviceKeypair：权限收紧失败必须抛错，不得重生成覆盖既有绑定密钥', (t) => {
  if (process.platform === 'win32') return t.skip('Windows 不以 chmod 表达凭据权限');
  const root = tmpRoot('kp-mode-fail');
  const kp = wl.ensureDeviceKeypair(root);
  fs.chmodSync(wl.keypairPath(root), 0o644);
  const originalChmod = fs.chmodSync;
  try {
    fs.chmodSync = () => { const e = new Error('permission denied'); e.code = 'EPERM'; throw e; };
    assert.throws(() => wl.ensureDeviceKeypair(root), (e) => e && e.code === 'EPERM');
  } finally {
    fs.chmodSync = originalChmod;
  }
  const preserved = JSON.parse(fs.readFileSync(wl.keypairPath(root), 'utf8'));
  assert.equal(preserved.publicKey, kp.publicKey, '权限失败不得换掉已有公钥');
});

// ---------- 挑战签名 ----------

test('signChallenge：ed25519 签名可用对应公钥验证', () => {
  const root = tmpRoot('sign');
  const kp = wl.ensureDeviceKeypair(root);
  const challenge = Buffer.from('challenge-payload-' + Date.now()).toString('base64');
  const sig = wl.signChallenge(challenge, kp);
  const ok = crypto.verify(
    null,
    Buffer.from(challenge, 'base64'),
    crypto.createPublicKey(kp.publicKey),
    Buffer.from(sig, 'base64'),
  );
  assert.equal(ok, true, '公钥应能验证签名');
  const bad = crypto.verify(
    null,
    Buffer.from(challenge, 'base64'),
    crypto.createPublicKey(kp.publicKey),
    Buffer.from(sig.slice(0, -4) + 'AAAA', 'base64'),
  );
  assert.equal(bad, false, '篡改签名必须验证失败');
});

// ---------- 本机 wxid 目录扫描 ----------

test('scanWxidDirs：识别 wxid_ 目录、按 mtime 降序、排除系统目录', () => {
  const base = tmpRoot('scan');
  fs.mkdirSync(path.join(base, 'wxid_abc123'));
  fs.mkdirSync(path.join(base, 'wxid_oldxyz'));
  fs.mkdirSync(path.join(base, 'all_users')); // 系统目录必须排除
  fs.mkdirSync(path.join(base, 'config'));
  const f1 = path.join(base, 'wxid_abc123', 'marker.txt');
  fs.writeFileSync(f1, 'x');
  const past = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(base, 'wxid_oldxyz'), past, past);
  const dirs = wl.scanWxidDirs([base]);
  const names = dirs.map((d) => d.wxid);
  assert.deepEqual(names, ['wxid_abc123', 'wxid_oldxyz'], '按最近活跃排序且排除系统目录');
  assert.equal(dirs[0].dir, path.join(base, 'wxid_abc123'));
  assert.equal(wl.scanWxidDirs([path.join(base, 'nope')]).length, 0, '不存在目录不抛异常');
});

test('dirScanIdentity：多账号目录必须保守失败，重复根目录同一 wxid 可合并', () => {
  const first = { wxid: 'wxid_a', mtime: 2, dir: '/a' };
  const same = { wxid: 'WXID_A', mtime: 1, dir: '/b' };
  const one = wl.dirScanIdentity([first, same]);
  assert.equal(one.detected, true);
  assert.equal(one.wxid, 'wxid_a');
  const many = wl.dirScanIdentity([first, { wxid: 'wxid_b', mtime: 1, dir: '/c' }]);
  assert.equal(many.detected, false);
  assert.equal(many.reason, 'multiple-wxid-dirs');
});

test('macWechatRoots：测试环境显式根目录覆盖可隔离真机探测', () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldRoots = process.env.JZ_WECHAT_ROOTS;
  try {
    process.env.NODE_ENV = 'test';
    process.env.JZ_WECHAT_ROOTS = ['/tmp/jz-wl-a', '/tmp/jz-wl-b'].join(path.delimiter);
    assert.deepEqual(wl.macWechatRoots(), ['/tmp/jz-wl-a', '/tmp/jz-wl-b']);
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldRoots === undefined) delete process.env.JZ_WECHAT_ROOTS;
    else process.env.JZ_WECHAT_ROOTS = oldRoots;
  }
});

test('detectViaHelper：helper 与目录无法关联时不得擅取首条联系人', async () => {
  const root = tmpRoot('helper-correlation');
  const helper = path.join(root, 'helper.js');
  fs.mkdirSync(path.join(root, 'wxid_actual'));
  const oldHelper = process.env.JZ_WECHAT_DB_HELPER;
  try {
    process.env.JZ_WECHAT_DB_HELPER = helper;
    fs.writeFileSync(helper, "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ok:true,items:[{wxid:'wxid_other',nickname:'错误账号'}]})));\n");
    const miss = await wl.detectViaHelper([root]);
    assert.equal(miss.detected, false);
    assert.equal(miss.reason, 'identity-not-correlated');
    fs.writeFileSync(helper, "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ok:true,items:[{wxid:'wxid_actual',nickname:'正确账号'}]})));\n");
    const hit = await wl.detectViaHelper([root]);
    assert.equal(hit.detected, true);
    assert.equal(hit.wxid, 'wxid_actual');
    assert.equal(hit.confidence, 'high');
  } finally {
    if (oldHelper === undefined) delete process.env.JZ_WECHAT_DB_HELPER;
    else process.env.JZ_WECHAT_DB_HELPER = oldHelper;
  }
});

// ---------- 绑定编排（底座 ①②③）----------

test('bindStatus：无本地意图 → NO_INTENT error', async () => {
  const root = tmpRoot('bs-empty');
  const r = await wl.bindStatus({ root, _baseGet: async () => { throw new Error('should-not-be-called'); } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  assert.equal(r.detail, 'NO_INTENT');
});

test('bindStatus：pending/bound 状态映射 + 本地过期优先判 expired', async () => {
  const root = tmpRoot('bs');
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  fs.writeFileSync(wl.intentPath(root), JSON.stringify({
    intentId: 'it_1', pairingCode: '8888', startedAt: Date.now(), expiresIn: 300,
  }));
  const pending = await wl.bindStatus({
    root,
    _baseGet: async () => ({ status: 202, body: { ok: true, data: { status: 'pending' } } }),
  });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.pairingCode, '8888');
  const bound = await wl.bindStatus({
    root,
    _baseGet: async () => ({ status: 200, body: { ok: true, data: { status: 'bound' } } }),
  });
  assert.equal(bound.status, 'bound');
  assert.equal(fs.existsSync(wl.intentPath(root)), false, 'bound 后应清理短期意图文件');
  // 本地 startedAt 已过期 → 不看底座直接 expired（防底座挂掉后死等）
  fs.writeFileSync(wl.intentPath(root), JSON.stringify({
    intentId: 'it_1', pairingCode: '8888', startedAt: Date.now() - 400 * 1000, expiresIn: 300,
  }));
  let expiredNetworkCalls = 0;
  const expired = await wl.bindStatus({
    root,
    _baseGet: async () => { expiredNetworkCalls++; throw new Error('expired intent must not call base'); },
  });
  assert.equal(expired.status, 'expired');
  assert.equal(expiredNetworkCalls, 0, '本地过期判断必须先于底座请求');
});

test('bindStatus：意图文件符号链接必须 fail-closed', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows 创建符号链接需要额外权限');
  const root = tmpRoot('bs-symlink');
  const outside = tmpRoot('bs-outside');
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  const target = path.join(outside, 'intent.json');
  fs.writeFileSync(target, JSON.stringify({ intentId: 'outside', pairingCode: '1111', startedAt: Date.now(), expiresIn: 300 }));
  fs.symlinkSync(target, wl.intentPath(root));
  await assert.rejects(
    () => wl.bindStatus({ root, _baseGet: async () => { throw new Error('symlink intent must not call base'); } }),
    (e) => e && e.code === 'ESYMLINK',
  );
});

test('bindStart：未检测到本机微信 → WECHAT_NOT_DETECTED，不发起底座请求', async () => {
  const root = tmpRoot('bd-nd');
  let called = 0;
  const r = await wl.bindStart({
    root,
    _detect: async () => ({ supported: true, detected: false }),
    _basePost: async () => { called++; return { status: 200, body: {} }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'WECHAT_NOT_DETECTED');
  assert.equal(called, 0, '未检测到微信不得打底座');
});

test('bindStart：检测到微信 → 底座 intent 成功落盘意图（pairingCode/intentId）', async () => {
  const root = tmpRoot('bd-ok');
  const posts = [];
  const r = await wl.bindStart({
    root,
    deviceName: '测试机',
    _detect: async () => ({ supported: true, detected: true, wxid: 'wxid_test', nickname: '产品负责人', confidence: 'high' }),
    _basePost: async (p, b) => {
      posts.push({ p, b });
      return { status: 200, body: { ok: true, data: { intentId: 'it_9', pairingCode: '666666', expiresIn: 120 } } };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.intentId, 'it_9');
  assert.equal(r.pairingCode, '666666');
  assert.equal(r.wxid, undefined, 'bindStart 结果不得回传 wxid');
  assert.equal(r.expiresIn, 120);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].p, '/api/auth/device-bind/intent');
  assert.equal(posts[0].b.wxid, 'wxid_test');
  assert.ok(posts[0].b.devicePubkey, 'intent 必须携带设备公钥');
  // 意图已落盘（bindStatus 可读）
  const state = JSON.parse(fs.readFileSync(wl.intentPath(root), 'utf8'));
  assert.equal(state.intentId, 'it_9');
  assert.equal(state.wxid, undefined, '本地意图文件不得持久化明文 wxid');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(wl.intentPath(root)).mode & 0o777, 0o600, '意图含配对码，必须 0600');
  }
});

test('bindStart：底座 DEVICE_LIMIT → 明确错误码', async () => {
  const root = tmpRoot('bd-limit');
  const r = await wl.bindStart({
    root,
    _detect: async () => ({ supported: true, detected: true, wxid: 'wxid_t' }),
    _basePost: async () => ({ status: 409, body: { ok: false, error: 'DEVICE_LIMIT' } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'DEVICE_LIMIT');
});

test('bindStart：底座 2xx 缺 intentId/pairingCode → 拒绝写入半截意图', async () => {
  const root = tmpRoot('bd-bad-response');
  const r = await wl.bindStart({
    root,
    _detect: async () => ({ supported: true, detected: true, wxid: 'wxid_t' }),
    _basePost: async () => ({ status: 200, body: { ok: true, data: { expiresIn: 120 } } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BIND_INTENT_BAD_RESPONSE');
  assert.equal(fs.existsSync(wl.intentPath(root)), false);
});

test('bindStart：2xx 响应信封或字段不合规 → fail-closed，不写入意图', async () => {
  const cases = [
    { ok: false, data: { intentId: 'it_bad', pairingCode: '123456', expiresIn: 120 } },
    { ok: true, data: { intentId: 'it_bad', pairingCode: '1234', expiresIn: 120 } },
    { ok: true, data: { intentId: 'it_bad', pairingCode: '123456', expiresIn: 301 } },
  ];
  for (const body of cases) {
    const root = tmpRoot('bd-contract');
    const r = await wl.bindStart({
      root,
      _detect: async () => ({ supported: true, detected: true, wxid: 'wxid_t' }),
      _basePost: async () => ({ status: 200, body }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'BIND_INTENT_BAD_RESPONSE');
    assert.equal(fs.existsSync(wl.intentPath(root)), false);
  }
});

test('bindStart：底座不可达 → BIND_INTENT_UNAVAILABLE（不抛异常）', async () => {
  const root = tmpRoot('bd-down');
  const r = await wl.bindStart({
    root,
    _detect: async () => ({ supported: true, detected: true, wxid: 'wxid_t' }),
    _basePost: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BIND_INTENT_UNAVAILABLE');
});

test('bindStart：底座返回空 transport → BIND_INTENT_FAILED，不抛 TypeError', async () => {
  const root = tmpRoot('bd-empty-transport');
  const r = await wl.bindStart({
    root,
    _detect: async () => ({ supported: true, detected: true, wxid: 'wxid_t' }),
    _basePost: async () => undefined,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BIND_INTENT_FAILED');
  assert.equal(fs.existsSync(wl.intentPath(root)), false);
});

test('bindStatus：2xx 响应信封、status 缺失或未知 → fail-closed，不伪装 pending', async () => {
  const root = tmpRoot('bs-bad-response');
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  fs.writeFileSync(wl.intentPath(root), JSON.stringify({
    intentId: 'it_bad', pairingCode: '1234', startedAt: Date.now(), expiresIn: 300,
  }));
  for (const body of [
    { ok: false, data: { status: 'pending' } },
    { ok: true, data: {} },
    { ok: true, data: { status: 'unknown' } },
  ]) {
    const r = await wl.bindStatus({
      root,
      _baseGet: async () => ({ status: 200, body }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'error');
    assert.equal(r.detail, 'BIND_STATUS_BAD_RESPONSE');
    fs.writeFileSync(wl.intentPath(root), JSON.stringify({
      intentId: 'it_bad', pairingCode: '1234', startedAt: Date.now(), expiresIn: 300,
    }));
  }
});

test('bindStatus：底座返回空 transport → 明确 BAD_RESPONSE，不抛 TypeError', async () => {
  const root = tmpRoot('bs-empty-response');
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  fs.writeFileSync(wl.intentPath(root), JSON.stringify({
    intentId: 'it_bad', pairingCode: '123456', startedAt: Date.now(), expiresIn: 300,
  }));
  const r = await wl.bindStatus({ root, _baseGet: async () => undefined });
  assert.deepEqual(r, { ok: false, status: 'error', detail: 'BIND_STATUS_BAD_RESPONSE' });
});

// ---------- 静默登录（底座 ④⑤）----------

test('localLogin：全链成功 → 标准登录产物落盘（loginMethod=wechat-local，不回前端 token）', async () => {
  const root = tmpRoot('ll-ok');
  const posts = [];
  let saveCalled = 0;
  const r = await wl.localLogin({
    root,
    _basePost: async (p, b) => {
      posts.push({ p, b });
      if (p === '/api/auth/device-challenge') {
        return { status: 200, body: { ok: true, data: { challenge: crypto.randomBytes(32).toString('base64'), expiresIn: 60 } } };
      }
      return {
        status: 200,
        body: { ok: true, data: { token: 'tok_abc', refreshToken: 'ref_1', expiresIn: 7200, user: { nickname: '产品负责人' }, device: { name: 'mac' } } },
      };
    },
    _saveDesktopAuth: (r2, auth) => {
      saveCalled++;
      assert.equal(r2, root);
      fs.writeFileSync(path.join(root, 'da.json'), JSON.stringify(auth));
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.loginMethod, 'wechat-local');
  assert.equal(saveCalled, 1);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].p, '/api/auth/device-verify');
  assert.ok(posts[1].b.signature, 'verify 必须携带设备签名');
  // 落盘产物与 desktop-auth 同构（saveDesktopAuth 拿到的字段）
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'da.json'), 'utf8'));
  assert.equal(saved.accessToken, 'tok_abc');
  assert.equal(saved.refreshToken, 'ref_1');
  assert.equal(saved.loginMethod, 'wechat-local');
  assert.ok(saved.user.nickname === '产品负责人');
});

test('localLogin：NO_BINDING → needBind 引导绑定（不落登录态）', async () => {
  const root = tmpRoot('ll-nb');
  let saveCalled = 0;
  const r = await wl.localLogin({
    root,
    _basePost: async (p) => {
      if (p === '/api/auth/device-challenge') {
        return { status: 200, body: { ok: true, data: { challenge: crypto.randomBytes(32).toString('base64'), expiresIn: 60 } } };
      }
      return { status: 200, body: { ok: false, error: 'NO_BINDING' } };
    },
    _saveDesktopAuth: () => { saveCalled++; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_BINDING');
  assert.equal(r.needBind, true);
  assert.equal(saveCalled, 0, '未绑定不得写登录态');
});

test('localLogin：challenge 409 NO_BINDING（十二轮底座状态码映射）→ 直接 needBind 引导，不进 verify', async () => {
  const root = tmpRoot('ll-nb-409');
  let verifyCalled = 0;
  const r = await wl.localLogin({
    root,
    _basePost: async (p) => {
      if (p === '/api/auth/device-challenge') {
        return { status: 409, body: { ok: false, error: 'NO_BINDING', detail: '本设备尚未绑定' } };
      }
      verifyCalled++;
      return { status: 200, body: { ok: true, data: {} } };
    },
    _saveDesktopAuth: () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_BINDING');
  assert.equal(r.needBind, true);
  assert.equal(verifyCalled, 0, 'challenge 409 不得继续调 verify');
});

test('localLogin：challenge 失败/底座不可达 → 503 语义错误码（前端据此回落扫码）', async () => {
  const root = tmpRoot('ll-ch');
  const badChallenge = await wl.localLogin({
    root,
    _basePost: async (p) => (p === '/api/auth/device-challenge'
      ? { status: 500, body: { ok: false, error: 'boom' } }
      : { status: 200, body: {} }),
    _saveDesktopAuth: () => {},
  });
  assert.equal(badChallenge.ok, false);
  assert.equal(badChallenge.error, 'CHALLENGE_FAILED');
  const down = await wl.localLogin({
    root,
    _basePost: async () => { throw new Error('ECONNREFUSED'); },
    _saveDesktopAuth: () => {},
  });
  assert.equal(down.ok, false);
  assert.equal(down.error, 'WECHAT_LOGIN_UNAVAILABLE');
});

test('localLogin：challenge 2xx 但信封/随机串不合规 → CHALLENGE_FAILED，不进入 verify', async () => {
  for (const body of [
    { ok: false, data: { challenge: crypto.randomBytes(32).toString('base64'), expiresIn: 60 } },
    { ok: true, data: { challenge: Buffer.from('short').toString('base64'), expiresIn: 60 } },
  ]) {
    const root = tmpRoot('ll-bad-challenge');
    let verifyCalled = 0;
    const r = await wl.localLogin({
      root,
      _basePost: async (p) => {
        if (p === '/api/auth/device-challenge') return { status: 200, body };
        verifyCalled++;
        return { status: 200, body: { ok: true, data: { token: 'unexpected' } } };
      },
      _saveDesktopAuth: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'CHALLENGE_FAILED');
    assert.equal(verifyCalled, 0);
  }
});

test('localLogin：verify 成功但缺 token → VERIFY_BAD_RESPONSE（不写半截登录态）', async () => {
  const root = tmpRoot('ll-bad');
  let saveCalled = 0;
  const r = await wl.localLogin({
    root,
    _basePost: async (p) => (p === '/api/auth/device-challenge'
      ? { status: 200, body: { ok: true, data: { challenge: crypto.randomBytes(32).toString('base64'), expiresIn: 60 } } }
      : { status: 200, body: { ok: true, data: { user: { nickname: 'x' } } } }),
    _saveDesktopAuth: () => { saveCalled++; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'VERIFY_BAD_RESPONSE');
  assert.equal(saveCalled, 0);
});

test('localLogin：verify 返回空 transport → VERIFY_FAILED，不抛 TypeError', async () => {
  const root = tmpRoot('ll-empty-verify');
  let saveCalled = 0;
  const r = await wl.localLogin({
    root,
    _basePost: async (p) => (p === '/api/auth/device-challenge'
      ? { status: 200, body: { ok: true, data: { challenge: crypto.randomBytes(32).toString('base64'), expiresIn: 60 } } }
      : undefined),
    _saveDesktopAuth: () => { saveCalled++; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'VERIFY_FAILED');
  assert.equal(saveCalled, 0);
});

test('inject.js：本机微信登录请求必须可取消且有代际守卫', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const start = inject.indexOf('function wireWechatLocal()');
  const end = inject.indexOf('    function fmtRemain', start);
  assert.ok(start >= 0 && end > start, 'wireWechatLocal 源码区块应存在');
  const block = inject.slice(start, end);
  for (const token of [
    'AbortController', 'controllers', 'abortRequests', 'registerDisposer',
    'beginRun', 'cancelRun', 'function alive(gen)', 'bindTimer', 'clickTimer',
    "'/api/wechat-local/login'", "'/api/wechat-local/bind/start'",
    "'/api/wechat-local/bind/status'",
  ]) {
    assert.ok(block.includes(token), '生命周期契约缺少 ' + token);
  }
});

// ---------- Codex 复核 P2 修复回归（2026-09-05）：TTL 契约 + verificationUrl 白名单 ----------

test('localLogin：challenge TTL 收紧到规格 60s——61 拒绝，60 放行', async () => {
  const mk = (expiresIn) => async (p) => (p === '/api/auth/device-challenge'
    ? { status: 200, body: { ok: true, data: { challenge: crypto.randomBytes(32).toString('base64'), expiresIn } } }
    : { status: 200, body: { ok: true, data: { token: 'tok_ttl', refreshToken: 'ref', expiresIn: 7200, user: { nickname: '产品负责人' }, device: { name: 'mac' } } } });
  const over = await wl.localLogin({ root: tmpRoot('ttl61'), _basePost: mk(61), _saveDesktopAuth: () => {} });
  assert.equal(over.ok, false);
  assert.equal(over.error, 'CHALLENGE_FAILED');
  const edge = await wl.localLogin({
    root: tmpRoot('ttl60'),
    _basePost: mk(60),
    _saveDesktopAuth: (r2, auth) => fs.writeFileSync(path.join(r2, 'da.json'), JSON.stringify(auth)),
  });
  assert.equal(edge.ok, true, '规格边界 60s 必须放行');
});

test('bindStart：verificationUrl 白名单——Kaypal HTTPS 保留，外域/明文/伪协议降级 null（绑定不中断）', async () => {
  const cases = [
    { url: 'https://kaypal.cn/api/auth/device-bind/page?intentId=x', keep: true },
    { url: 'https://auth.kaypal.cn/page', keep: true },
    { url: 'https://kaypal.cn.evil.com/page', keep: false },
    { url: 'http://kaypal.cn/page', keep: false },
    { url: 'javascript:alert(1)', keep: false },
    { url: 'not a url', keep: false },
  ];
  for (const c of cases) {
    const root = tmpRoot('url' + (c.keep ? 'k' : 'n'));
    const r = await wl.bindStart({
      root,
      _detect: async () => ({ supported: true, detected: true, wxid: 'wxid_t' }),
      _basePost: async () => ({ status: 200, body: { ok: true, data: { intentId: 'it_u', pairingCode: '123456', expiresIn: 120, verificationUrl: c.url } } }),
    });
    assert.equal(r.ok, true, c.url + ' 绑定流程不得因 URL 校验中断');
    assert.equal(r.verificationUrl, c.keep ? c.url : null, c.url);
    const state = JSON.parse(fs.readFileSync(wl.intentPath(root), 'utf8'));
    assert.equal(state.verificationUrl, c.keep ? c.url : null, c.url + ' 落盘态必须同步降级');
  }
});

test('bindStart：回环 HTTP verificationUrl 仅测试 mock 模式放行，生产配置恒降级', async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldMock = process.env.JZ_WECHAT_LOCAL_MOCK;
  try {
    delete process.env.NODE_ENV;
    delete process.env.JZ_WECHAT_LOCAL_MOCK;
    let root = tmpRoot('loop-prod');
    let r = await wl.bindStart({
      root,
      _detect: async () => ({ supported: true, detected: true, wxid: 'wxid_t' }),
      _basePost: async () => ({ status: 200, body: { ok: true, data: { intentId: 'it_l', pairingCode: '123456', expiresIn: 120, verificationUrl: 'http://127.0.0.1:47930/page' } } }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.verificationUrl, null, '生产误配回环 http 必须降级');

    process.env.NODE_ENV = 'test';
    process.env.JZ_WECHAT_LOCAL_MOCK = 'http://127.0.0.1:47930';
    root = tmpRoot('loop-mock');
    r = await wl.bindStart({
      root,
      _detect: async () => ({ supported: true, detected: true, wxid: 'wxid_t' }),
      _basePost: async () => ({ status: 200, body: { ok: true, data: { intentId: 'it_l2', pairingCode: '123456', expiresIn: 120, verificationUrl: 'http://127.0.0.1:47930/page' } } }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.verificationUrl, 'http://127.0.0.1:47930/page', 'mock 联调回环 http 应放行');
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
    if (oldMock === undefined) delete process.env.JZ_WECHAT_LOCAL_MOCK; else process.env.JZ_WECHAT_LOCAL_MOCK = oldMock;
  }
});

// ---------- 微信扫码直登（2026-09-06 产品负责人定版） ----------

const WECHAT_QR_URL = 'https://open.weixin.qq.com/connect/qrconnect?appid=wx1&state=abc';

test('wechatScanStart：合法响应 → 意图落盘 + qrUrl 透传（微信官方域白名单）', async () => {
  const root = tmpRoot('ws-ok');
  const posts = [];
  const r = await wl.wechatScanStart({
    root,
    deviceName: '同事Win机',
    _basePost: async (p, b) => {
      posts.push({ p, b });
      return { status: 200, body: { ok: true, data: { intentId: 'st_1', qrUrl: WECHAT_QR_URL, expiresIn: 300 } } };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.intentId, 'st_1');
  assert.equal(r.qrUrl, WECHAT_QR_URL);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].p, '/api/auth/device-wechat-login/start');
  assert.ok(posts[0].b.devicePubkey, 'start 必须携带设备公钥');
  assert.ok(fs.existsSync(wl.scanIntentPath(root)), '意图必须落盘（daemon 重启存活）');
  // 意图文件必须 0600（短期凭据纪律同 bind intent）
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(wl.scanIntentPath(root)).mode & 0o777, 0o600, '扫码意图必须 0600');
  }
});

test('wechatScanStart：钓鱼域 qrUrl → WECHAT_SCAN_BAD_RESPONSE，意图不落盘', async () => {
  const root = tmpRoot('ws-phish');
  const r = await wl.wechatScanStart({
    root,
    _basePost: async () => ({ status: 200, body: { ok: true, data: { intentId: 'st_2', qrUrl: 'https://evil.example.com/qr', expiresIn: 300 } } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'WECHAT_SCAN_BAD_RESPONSE');
  assert.ok(!fs.existsSync(wl.scanIntentPath(root)), '坏 qrUrl 不得落盘意图');
});

test('wechatScanStart：kaypal 域 qrUrl 也放行（服务端 302 中转页兼容）', async () => {
  const root = tmpRoot('ws-kc');
  const r = await wl.wechatScanStart({
    root,
    _basePost: async () => ({ status: 200, body: { ok: true, data: { intentId: 'st_3', qrUrl: 'https://kaypal.cn/api/auth/wechat/device-callback?x=1', expiresIn: 300 } } }),
  });
  assert.equal(r.ok, true);
});

test('wechatScanStart：底座 429 → RATE_LIMITED', async () => {
  const root = tmpRoot('ws-rl');
  const r = await wl.wechatScanStart({
    root,
    _basePost: async () => ({ status: 429, body: { ok: false, error: 'RATE_LIMITED' } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'RATE_LIMITED');
});

test('wechatScanPoll：pending → 不触发登录；ready → 复用 localLogin 全链出 token', async () => {
  const root = tmpRoot('ws-poll');
  await wl.wechatScanStart({
    root,
    _basePost: async () => ({ status: 200, body: { ok: true, data: { intentId: 'st_4', qrUrl: WECHAT_QR_URL, expiresIn: 300 } } }),
  });
  // 第一轮 pending：不得打底座登录两接口
  const gets1 = [];
  const p1 = await wl.wechatScanPoll({
    root,
    _baseGet: async (p) => { gets1.push(p); return { status: 202, body: { ok: true, data: { status: 'pending' } } }; },
  });
  assert.equal(p1.ok, true);
  assert.equal(p1.status, 'pending');
  assert.equal(gets1.length, 1);
  assert.ok(gets1[0].includes('/api/auth/device-wechat-login/poll'), '必须轮询扫码 poll 接口');

  // 第二轮 ready：清意图 → localLogin（challenge→签名→verify→token 落盘）
  const posts = [];
  let saveCalled = 0;
  const p2 = await wl.wechatScanPoll({
    root,
    _baseGet: async () => ({ status: 200, body: { ok: true, data: { status: 'ready' } } }),
    _basePost: async (p, b) => {
      posts.push({ p, b });
      if (p === '/api/auth/device-challenge') {
        return { status: 200, body: { ok: true, data: { challenge: crypto.randomBytes(32).toString('base64'), expiresIn: 60 } } };
      }
      return { status: 200, body: { ok: true, data: { token: 'tok_scan', refreshToken: 'ref_s', expiresIn: 7200, user: { nickname: '同事' }, device: { name: 'win' } } } };
    },
    _saveDesktopAuth: (r2, auth) => { saveCalled++; fs.writeFileSync(path.join(r2, 'da-scan.json'), JSON.stringify(auth)); },
  });
  assert.equal(p2.ok, true);
  assert.equal(p2.status, 'ready');
  assert.equal(p2.loginMethod, 'wechat-scan');
  assert.ok(p2.user && p2.user.nickname === '同事');
  assert.equal(saveCalled, 1);
  assert.equal(posts.length, 2, 'ready 后必须走 challenge+verify 签名握手');
  assert.ok(!fs.existsSync(wl.scanIntentPath(root)), 'ready 后意图必须焚毁');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'da-scan.json'), 'utf8'));
  assert.equal(saved.accessToken, 'tok_scan');
});

test('wechatScanPoll：invalid（过期/被消费）→ expired；意图清理', async () => {
  const root = tmpRoot('ws-inv');
  await wl.wechatScanStart({
    root,
    _basePost: async () => ({ status: 200, body: { ok: true, data: { intentId: 'st_5', qrUrl: WECHAT_QR_URL, expiresIn: 300 } } }),
  });
  const r = await wl.wechatScanPoll({
    root,
    _baseGet: async () => ({ status: 200, body: { ok: true, data: { status: 'invalid' } } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'expired');
  assert.ok(!fs.existsSync(wl.scanIntentPath(root)));
});

test('wechatScanPoll：无本地意图 → error NO_INTENT（前端据此重新发起）', async () => {
  const root = tmpRoot('ws-noi');
  const r = await wl.wechatScanPoll({ root, _baseGet: async () => { throw new Error('should not reach'); } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
});

test('wechatScanPoll：本地 TTL 硬边界——过期意图不触底座', async () => {
  const root = tmpRoot('ws-ttl');
  await wl.wechatScanStart({
    root,
    _basePost: async () => ({ status: 200, body: { ok: true, data: { intentId: 'st_6', qrUrl: WECHAT_QR_URL, expiresIn: 1 } } }),
  });
  // 篡改 startedAt 使其过期
  const sp = wl.scanIntentPath(root);
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  st.startedAt = Date.now() - 10 * 1000;
  fs.writeFileSync(sp, JSON.stringify(st));
  const r = await wl.wechatScanPoll({ root, _baseGet: async () => { throw new Error('expired 意图不得触底座'); } });
  assert.equal(r.status, 'expired');
  assert.ok(!fs.existsSync(sp));
});

test('wechatScanPoll：ready 但登录失败 → intent 保留可重试（十三轮 P1-4 防回归）', async () => {
  const root = tmpRoot('ws-retain');
  await wl.wechatScanStart({
    root,
    _basePost: async () => ({ status: 200, body: { ok: true, data: { intentId: 'st_7', qrUrl: WECHAT_QR_URL, expiresIn: 300 } } }),
  });
  // 第一次 poll：ready 但底座 challenge 503（短暂故障）→ error + retryable，intent 必须保留
  const r1 = await wl.wechatScanPoll({
    root,
    _baseGet: async () => ({ status: 200, body: { ok: true, data: { status: 'ready' } } }),
    _basePost: async () => ({ status: 503, body: { ok: false, error: 'WECHAT_LOGIN_UNAVAILABLE' } }),
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 'error');
  assert.equal(r1.retryable, true, '失败必须标记可重试');
  assert.ok(fs.existsSync(wl.scanIntentPath(root)), '登录失败不得焚毁 intent（旧实现先删后登 = 意图永久丢失）');
  // 第二次 poll：底座恢复 → 同一 intent 自动重试 localLogin 成功
  const r2 = await wl.wechatScanPoll({
    root,
    _baseGet: async () => ({ status: 200, body: { ok: true, data: { status: 'ready' } } }),
    _basePost: async (p) => {
      if (p === '/api/auth/device-challenge') {
        return { status: 200, body: { ok: true, data: { challenge: crypto.randomBytes(32).toString('base64'), expiresIn: 60 } } };
      }
      return { status: 200, body: { ok: true, data: { token: 'tok_retry', user: { nickname: '恢复后登录' } } } };
    },
    _saveDesktopAuth: () => {},
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.status, 'ready');
  assert.ok(!fs.existsSync(wl.scanIntentPath(root)), '登录成功后才焚毁 intent');
});

test('wechatScanPoll：确定性失败（NO_BINDING/账号禁用）→ retryable=false（十五轮 P3）', async () => {
  const root = tmpRoot('ws-det');
  await wl.wechatScanStart({
    root,
    _basePost: async () => ({ status: 200, body: { ok: true, data: { intentId: 'st_8', qrUrl: WECHAT_QR_URL, expiresIn: 300 } } }),
  });
  // NO_BINDING：扫码 ready 但设备未真正绑定 → 确定性失败
  const r1 = await wl.wechatScanPoll({
    root,
    _baseGet: async () => ({ status: 200, body: { ok: true, data: { status: 'ready' } } }),
    _basePost: async (p) => {
      if (p === '/api/auth/device-challenge') return { status: 409, body: { ok: false, error: 'NO_BINDING' } };
      return { status: 200, body: { ok: true, data: {} } };
    },
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'NO_BINDING');
  assert.equal(r1.retryable, false, 'NO_BINDING 是确定性失败，不得继续轮询');
  assert.ok(fs.existsSync(wl.scanIntentPath(root)), '确定性失败同样不焚毁 intent（可重新扫码）');
});
