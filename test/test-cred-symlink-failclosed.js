'use strict';
// 回归测试（2026-08-31 Codex 复核 P1#2 / P2#7）：
// 1. 凭据文件符号链接 fail-closed——license/desktop-auth.json 被链到外部 JSON 时，
//    loadDesktopAuth 必须返回 null（视同未登录），绝不读出外部 accessToken。
// 2. loadDesktopAuthReadOnly 严格只读——旧明文凭据不迁移、不写盘（trial 试算路径约束）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadDesktopAuth, loadDesktopAuthReadOnly, saveDesktopAuth } = require('../scripts/jz/desktop-auth');
const { readCredFile } = require('../scripts/jz/crypto-vault');

function tmpRoot(tag) {
  const r = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `jz-cred-${tag}-`));
  fs.mkdirSync(path.join(r, 'license'), { recursive: true });
  return r;
}

test('凭据符号链接 fail-closed：desktop-auth.json 链接外部文件 → loadDesktopAuth 返回 null，不读外部 token（P1 Codex #2）', () => {
  const r = tmpRoot('sym');
  const p = path.join(r, 'license', 'desktop-auth.json');
  const outside = path.join(fs.realpathSync(os.tmpdir()), `jz-cred-outside-${Date.now()}.json`);
  fs.writeFileSync(outside, JSON.stringify({ accessToken: 'kda_EXTERNAL_LEAK', refreshToken: null, user: { id: 'attacker' } }), { mode: 0o600 });
  try {
    fs.symlinkSync(outside, p);
    const auth = loadDesktopAuth(r);
    assert.equal(auth, null, '链接凭据必须 fail-closed 返回 null，绝不读外部 accessToken');
    const ro = loadDesktopAuthReadOnly(r);
    assert.equal(ro, null, '只读路径同样 fail-closed');
    // 外部文件内容原样（未被读取后迁移/改写）
    assert.equal(JSON.parse(fs.readFileSync(outside, 'utf8')).accessToken, 'kda_EXTERNAL_LEAK');
  } finally {
    try { fs.rmSync(outside, { force: true }); } catch (_) {}
  }
});

test('readCredFile 符号链接直接返回 null（不抛错、不迁移、不覆盖链接）', () => {
  const r = tmpRoot('sym2');
  const p = path.join(r, 'license', 'cred.json');
  const outside = path.join(r, 'license', 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ accessToken: 'x' }), { mode: 0o600 });
  fs.symlinkSync(outside, p);
  assert.equal(readCredFile(r, p), null);
  // 链接本体仍在（读取路径不得顺手删/覆盖）
  assert.ok(fs.lstatSync(p).isSymbolicLink(), '读取路径不得动链接本体');
});

test('loadDesktopAuthReadOnly 严格只读：旧明文凭据返回 null 且文件原样（不迁移写盘）（P2 Codex #7）', () => {
  const r = tmpRoot('ro');
  const p = path.join(r, 'license', 'desktop-auth.json');
  const legacy = JSON.stringify({ accessToken: 'kda_legacy_plain', refreshToken: null, user: { id: 'u1' }, loggedInAt: 't' });
  fs.writeFileSync(p, legacy, { mode: 0o600 });
  const before = fs.readFileSync(p, 'utf8');
  const ro = loadDesktopAuthReadOnly(r);
  assert.equal(ro, null, '只读路径对旧明文返回 null（不迁移不使用）');
  assert.equal(fs.readFileSync(p, 'utf8'), before, '只读路径不得改写文件');
  // 对照：迁移版 loadDesktopAuth 会原地升级为密文
  const migrated = loadDesktopAuth(r);
  assert.equal(migrated && migrated.accessToken, 'kda_legacy_plain', '迁移版应迁移成功并返回明文内容');
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(after.v, 2, '迁移后应为 v2 密文信封');
});

test('loadDesktopAuth 正常路径不回归：v2 密文保存/读取一致', () => {
  const r = tmpRoot('v2');
  saveDesktopAuth(r, { accessToken: 'kda_ok', refreshToken: 'r', user: { id: 'u9' }, device: null });
  const a = loadDesktopAuth(r);
  assert.equal(a.accessToken, 'kda_ok');
  assert.equal(a.user.id, 'u9');
});

// ===== 第二轮复核（2026-08-31 Codex 23:17 批次）=====

test('readFileNoSymlink fd 级 O_NOFOLLOW：链接抛 ESYMLINK（ELOOP 转换）、普通文件读取不变（P2 Codex #1）', () => {
  const { readFileNoSymlink } = require('../scripts/jz/lib');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-nofollow-'));
  const real = path.join(dir, 'real.bin');
  fs.writeFileSync(real, Buffer.from('PLAIN_OK'));
  // 普通文件照常读
  assert.equal(readFileNoSymlink(real).toString('utf8'), 'PLAIN_OK');
  // 链接 → ESYMLINK（fd 路径下 open 抛 ELOOP，统一转换，调用方语义不变）
  const link = path.join(dir, 'link.bin');
  fs.symlinkSync(real, link);
  assert.throws(() => readFileNoSymlink(link), (e) => e.code === 'ESYMLINK');
  // 不存在 → ENOENT（交调用方按不存在处理）
  assert.throws(() => readFileNoSymlink(path.join(dir, 'nope.bin')), (e) => e.code === 'ENOENT');
});

test('noMigrate 对 v2 凭据无副作用：不收紧权限（0644 保持）、返回 token（P2 Codex #2）', () => {
  const r = tmpRoot('v2perm');
  const { loadOrCreateDataKey, encrypt, readCredFile } = require('../scripts/jz/crypto-vault');
  // 注入 platform:'linux' → Keychain/DPAPI 双 null → 密钥走 0600 明文文件（可测、无 Keychain 污染）
  const deps = { platform: 'linux' };
  const key = loadOrCreateDataKey(r, deps);
  assert.ok(Buffer.isBuffer(key) && key.length === 32);
  const p = path.join(r, 'license', 'desktop-auth.json');
  const auth = { accessToken: 'kda_v2_ro', refreshToken: null, user: { id: 'u1' }, device: null };
  // 手工构造 v2 信封并落 0644（模拟旧版本落盘权限）
  const { iv, tag, ciphertext } = encrypt(key, Buffer.from(JSON.stringify(auth), 'utf8'));
  const envelope = { v: 2, kdf: 'data-key', iv: iv.toString('base64'), tag: tag.toString('base64'), data: ciphertext.toString('base64') };
  fs.writeFileSync(p, JSON.stringify(envelope), { mode: 0o644 });
  const ro = readCredFile(r, p, { noMigrate: true, deps });
  assert.equal(ro && ro.accessToken, 'kda_v2_ro', '只读路径应解密返回 token');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(p).mode & 0o777, 0o644, '只读路径不得收紧权限（chmod 也是写盘）');
  }
  // 对照：迁移版读取会幂等收紧到 0600
  const full = readCredFile(r, p);
  assert.equal(full && full.accessToken, 'kda_v2_ro');
  if (process.platform !== 'win32') {
    // Windows 的 chmod 只映射只读位（stat.mode 恒报 0666），权限断言无意义，
    // 与本用例 0644 分支同一立场；收紧逻辑本身由只读路径 + 内容正确性覆盖。
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, '迁移版照常收紧权限');
  }
});

test('noMigrate 密钥不存在时不创建：返回 null 且 .vault-key 不落盘（P2 Codex #2）', () => {
  const r = tmpRoot('nokey');
  const p = path.join(r, 'license', 'desktop-auth.json');
  // v2 信封（密钥文件不存在，必须 fail-closed 且不创建）
  const envelope = { v: 2, kdf: 'data-key', iv: Buffer.alloc(12).toString('base64'), tag: Buffer.alloc(16).toString('base64'), data: Buffer.alloc(8).toString('base64') };
  fs.writeFileSync(p, JSON.stringify(envelope), { mode: 0o600 });
  const { readCredFile } = require('../scripts/jz/crypto-vault');
  const ro = readCredFile(r, p, { noMigrate: true, deps: { platform: 'linux' } });
  assert.equal(ro, null, '密钥缺失 → null（不创建新密钥）');
  assert.ok(!fs.existsSync(path.join(r, 'license', '.vault-key')), '只读路径绝不创建 .vault-key');
});

test('device-flow.json 符号链接 fail-closed：外部 device_code 不发往 poll（P2 Codex #3）', async () => {
  const r = tmpRoot('devflow');
  const p = path.join(r, 'license', 'device-flow.json');
  const outside = path.join(r, 'license', 'outside-flow.json');
  fs.writeFileSync(outside, JSON.stringify({ deviceCode: 'dev_ATTACKER', codeVerifier: 'ver_ATTACKER', interval: 1 }), { mode: 0o600 });
  fs.symlinkSync(outside, p);
  const { deviceFlowPoll } = require('../scripts/jz/desktop-auth');
  let httpCalled = 0;
  const fakeHttp = async () => { httpCalled += 1; return { status: 200, body: {} }; };
  const out = await deviceFlowPoll({ root: r, _httpsJson: fakeHttp });
  assert.equal(out.error, 'NO_DEVICE_FLOW', '链接凭据 → 视同无授权流');
  assert.equal(httpCalled, 0, '绝不携带外部 device_code 发起 poll 请求');
  assert.ok(fs.lstatSync(p).isSymbolicLink(), '读取路径不得动链接本体');
});
