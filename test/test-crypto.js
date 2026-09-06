'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encrypt, decrypt, deriveKeyFromPassphrase, loadOrCreateDataKey } = require('../scripts/jz/crypto-vault');
const { createBackup, verifyBackup, exportBackup, importBackup, listBackups } = require('../scripts/jz/backup-vault');
const { saveSettings, defaultSettings } = require('../scripts/jz/storage');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-test-'));
process.env.JZ_DATA_ROOT = root;

test('加密/解密 roundtrip (AES-256-GCM)', () => {
  const key = crypto.randomBytes(32);
  const { iv, tag, ciphertext } = encrypt(key, Buffer.from('hello'));
  assert.equal(decrypt(key, iv, tag, ciphertext).toString(), 'hello');
});

test('备份创建 + 校验通过', () => {
  saveSettings(root, defaultSettings());
  const r = createBackup({ scope: ['settings'], reason: 'manual', root });
  assert.ok(r.backupId);
  const v = verifyBackup({ backupId: r.backupId, root });
  assert.equal(v.ok, true);
});

test('导出（服务端受控目录）+ 正确密码导入', () => {
  saveSettings(root, defaultSettings());
  const r = createBackup({ scope: ['settings'], reason: 'manual', root });
  // 2026-08-29 P1 修复：导出文件名由服务端生成（exports/ 目录），不再接受 destination
  const ex = exportBackup({ backupId: r.backupId, passphrase: 'pw', root });
  assert.equal(ex.ok, true);
  assert.ok(ex.exportId);
  assert.match(ex.file, /\.jzvault$/);
  assert.ok(fs.existsSync(require('../scripts/jz/backup-vault').exportsDir(root)));
  const im = importBackup({ file: ex.file, sourceKind: 'export', passphrase: 'pw', root });
  assert.equal(im.ok, true);
  assert.ok(im.backupId);
  assert.equal(im.restoreReady, im.imported, 'settings 备份导入后应可安全恢复');
});

test('错误密码导入失败且不泄露细节', () => {
  saveSettings(root, defaultSettings());
  const r = createBackup({ scope: ['settings'], reason: 'manual', root });
  const ex = exportBackup({ backupId: r.backupId, passphrase: 'pw', root });
  assert.equal(ex.ok, true);
  const im = importBackup({ file: ex.file, sourceKind: 'export', passphrase: 'wrong', root });
  assert.equal(im.ok, false);
  assert.equal(im.error, 'BACKUP_CORRUPTED');
});

test('客户端传 destination / 任意路径导入 → 一律拒绝', () => {
  saveSettings(root, defaultSettings());
  const r = createBackup({ scope: ['settings'], reason: 'manual', root });
  const ex = exportBackup({ backupId: r.backupId, passphrase: 'pw', root });
  assert.equal(ex.ok, true);
  // 任意路径导入（含穿越/绝对路径/子目录）全部拒绝
  for (const bad of ['/tmp/other.jzvault', '../../outside.jzvault', `sub/${ex.file}`, `../${ex.file}`]) {
    const im = importBackup({ file: bad, sourceKind: 'export', passphrase: 'pw', root });
    assert.equal(im.ok, false, `应拒绝: ${bad}`);
  }
});

test('备份列表不含 token/明文', () => {
  saveSettings(root, defaultSettings());
  createBackup({ scope: ['settings'], reason: 'manual', root });
  const list = listBackups(root);
  assert.ok(Array.isArray(list) && list.length >= 1);
  const json = JSON.stringify(list);
  assert.ok(!json.includes('"token"'));
});

// —— G6 平台密钥存储：macOS Keychain 分支（可注入 deps 单测，不真连 Keychain）——

test('loadOrCreateDataKey：darwin Keychain 命中优先，不落文件', () => {
  const r = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-kc1-'));
  const kcKey = crypto.randomBytes(32);
  const fakeExec = (cmd, args) => {
    if (args[0] === 'find-generic-password') return kcKey.toString('hex') + '\n';
    throw new Error('unexpected call ' + args[0]);
  };
  const got = loadOrCreateDataKey(r, { platform: 'darwin', exec: fakeExec });
  assert.ok(got.equals(kcKey), '应返回 Keychain 密钥');
  assert.ok(!fs.existsSync(path.join(r, 'license', '.vault-key')), 'Keychain 命中时不应落文件');
});

test('loadOrCreateDataKey：darwin Keychain 不可用降级 0600 文件', () => {
  const r = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-kc2-'));
  const fakeExec = (cmd, args) => {
    if (args[0] === 'find-generic-password') throw new Error('not found');
    if (args[0] === 'add-generic-password') throw new Error('keychain unavailable');
    throw new Error('unexpected call ' + args[0]);
  };
  const got = loadOrCreateDataKey(r, { platform: 'darwin', exec: fakeExec });
  assert.equal(got.length, 32);
  const kp = path.join(r, 'license', '.vault-key');
  assert.ok(fs.existsSync(kp), '降级应落文件');
  // Windows 上 chmod 只支持只读位，mode 恒为 0o666，无法表达 0600（权限模型为 ACL），跳过精确权限断言
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(kp).mode & 0o777, 0o600, '文件权限必须 0600');
  }
});

test('loadOrCreateDataKey：非 darwin 直接文件', () => {
  const r = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-kc3-'));
  const got = loadOrCreateDataKey(r, { platform: 'linux', exec: () => { throw new Error('should not exec'); } });
  assert.equal(got.length, 32);
  assert.ok(fs.existsSync(path.join(r, 'license', '.vault-key')));
});

// —— 2026-08-29 复查 P1：Windows DPAPI 密钥保护（fake exec 模拟 PowerShell Protect/Unprotect）——

function fakeDpapiExec(cmd, args) {
  const script = Buffer.from(String(args[args.indexOf('-EncodedCommand') + 1]), 'base64').toString('utf16le');
  if (script.includes('::Protect(')) {
    const hex = script.match(/'([0-9a-f]{64})'/)[1];
    return Buffer.concat([Buffer.from('PROT'), Buffer.from(hex, 'hex')]).toString('base64');
  }
  if (script.includes('::Unprotect(')) {
    const b64 = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1];
    const raw = Buffer.from(b64, 'base64');
    assert.equal(raw.subarray(0, 4).toString(), 'PROT', 'fake DPAPI blob 前缀');
    return raw.subarray(4).toString('hex');
  }
  throw new Error('unexpected dpapi script');
}

test('DPAPI：win32 下密钥经 CryptProtectData 落 .vault-key.dpapi，明文不落盘', () => {
  const r = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-dpapi-'));
  const k1 = loadOrCreateDataKey(r, { platform: 'win32', exec: fakeDpapiExec });
  assert.equal(k1.length, 32);
  assert.ok(fs.existsSync(path.join(r, 'license', '.vault-key.dpapi')), 'DPAPI blob 应存在');
  assert.ok(!fs.existsSync(path.join(r, 'license', '.vault-key')), '明文密钥不得落盘');
  const { dpapiGetKey } = require('../scripts/jz/crypto-vault');
  const k2 = dpapiGetKey(r, { platform: 'win32', exec: fakeDpapiExec });
  assert.ok(k2.equals(k1), 'Unprotect 应还原同一密钥');
});

test('DPAPI：旧明文 .vault-key 自动迁移（读出 → DPAPI → 删除明文）', () => {
  const r = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-dpapi2-'));
  fs.mkdirSync(path.join(r, 'license'), { recursive: true });
  const legacy = crypto.randomBytes(32);
  fs.writeFileSync(path.join(r, 'license', '.vault-key'), legacy);
  const got = loadOrCreateDataKey(r, { platform: 'win32', exec: fakeDpapiExec });
  assert.ok(got.equals(legacy), '迁移后密钥内容不变');
  assert.ok(fs.existsSync(path.join(r, 'license', '.vault-key.dpapi')), 'DPAPI blob 应存在');
  assert.ok(!fs.existsSync(path.join(r, 'license', '.vault-key')), '明文密钥应被删除');
});

test('凭据 0600：desktop-auth.json 落盘权限（非 Windows）', () => {
  const r = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-priv-'));
  const { saveDesktopAuth, loadDesktopAuth } = require('../scripts/jz/desktop-auth');
  saveDesktopAuth(r, { accessToken: 'kda_test', refreshToken: 'rft_test', user: { id: 'u1' } });
  const p = path.join(r, 'license', 'desktop-auth.json');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, '凭据文件必须 0600');
    // 旧 0644 文件读取时幂等收紧
    fs.chmodSync(p, 0o644);
    loadDesktopAuth(r);
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'loadDesktopAuth 应收紧旧 0644 权限');
  }
  assert.equal(loadDesktopAuth(r).accessToken, 'kda_test');
});
