'use strict';
// Windows junction 攻击回归（Windows 真机/CI 专用；macOS/Linux 自动 skip——
// junction 是 Windows 符号链接语义，其他平台无法创建）。
// 验证点与 macOS 符号链接回归一一对应：isPhysicallyRealPath 拒 junction、
// 凭据读/写路径拒 junction、cleanup 拒 junction、DPAPI 真实往返。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const isWin = process.platform === 'win32';
const TMP = fs.realpathSync(os.tmpdir());
function makeJunction(target, link) {
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
}

test('Windows junction：isPhysicallyRealPath 拒绝（本身+父级链）', { skip: !isWin }, () => {
  const { isPhysicallyRealPath } = require('../scripts/jz/lib');
  const base = fs.mkdtempSync(path.join(TMP, 'jz-wjn-'));
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-wjn-out-'));
  makeJunction(outside, path.join(base, 'jlink'));
  assert.equal(isPhysicallyRealPath(path.join(base, 'jlink', 'sub')), false, 'junction 父级链必须拒');
  assert.equal(isPhysicallyRealPath(path.join(base, 'jlink')), false, 'junction 本身必须拒');
  assert.equal(isPhysicallyRealPath(base), true, '真实目录放行');
});

test('Windows junction：.vault-key.dpapi 读写全拒绝（外部不被覆盖）', { skip: !isWin }, () => {
  const { loadOrCreateDataKey } = require('../scripts/jz/crypto-vault');
  const root = fs.mkdtempSync(path.join(TMP, 'jz-wjn-dp-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-wjn-dp-out-'));
  fs.writeFileSync(path.join(outside, 'k'), 'fake');
  makeJunction(outside, path.join(root, 'license', '.vault-key.dpapi'));
  assert.throws(() => loadOrCreateDataKey(root, { platform: 'win32' }), (e) => e.code === 'ESYMLINK', 'junction 凭据必须上抛');
});

test('Windows junction：.vault-key 读写全拒绝（外部 victim 不被覆盖）', { skip: !isWin }, () => {
  const { loadOrCreateDataKey } = require('../scripts/jz/crypto-vault');
  const root = fs.mkdtempSync(path.join(TMP, 'jz-wjn-vk-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-wjn-vk-out-'));
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'ORIGINAL-KEEP');
  makeJunction(outside, path.join(root, 'license', '.vault-key'));
  assert.throws(() => loadOrCreateDataKey(root, { platform: 'win32' }), (e) => e.code === 'ESYMLINK');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL-KEEP', '外部文件不得被覆盖');
});

test('Windows junction：cleanup runtime 拒绝扫描', { skip: !isWin }, () => {
  const { scan } = require('../scripts/jz/cleanup');
  const root = fs.mkdtempSync(path.join(TMP, 'jz-wjn-cu-'));
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  const outside = fs.mkdtempSync(path.join(TMP, 'jz-wjn-cu-out-'));
  fs.writeFileSync(path.join(outside, 'old.log'), 'x');
  fs.rmSync(path.join(root, 'runtime'), { recursive: true, force: true });
  makeJunction(outside, path.join(root, 'runtime'));
  const s = scan({ root });
  assert.ok(!JSON.stringify(s).includes('old.log'), 'junction runtime 下文件不得成为候选项');
});

test('Windows junction：DPAPI 真实 Protect/Unprotect 往返', { skip: !isWin }, () => {
  const crypto = require('node:crypto');
  const { dpapiProtect, dpapiUnprotect } = require('../scripts/jz/crypto-vault');
  const keyHex = crypto.randomBytes(32).toString('hex');
  const b64 = dpapiProtect(keyHex);
  assert.ok(b64 && /^[A-Za-z0-9+/=]+$/.test(b64), 'Protect 应产出 base64');
  const back = dpapiUnprotect(b64);
  assert.equal(String(back).trim().toLowerCase(), keyHex, 'Unprotect 应恢复原密钥');
});
