'use strict';
// 2026-08-30 第八轮复核回归：凭据文件符号链接拒绝（P1 真实安全缺陷）。
//   .daemon-token / .api-token / .vault-key / .vault-key.dpapi 四类：
//   外部有效凭据的符号链接不得被接受/使用。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureToken, tokenPath } = require('../scripts/jz/auth');
const { loadOrCreateDataKey, dpapiFilePath } = require('../scripts/jz/crypto-vault');
const { readFileNoSymlink } = require('../scripts/jz/lib');

const TMP = fs.realpathSync(os.tmpdir());

test('readFileNoSymlink：符号链接文件抛 ESYMLINK，真实文件正常读', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'jz-r8-fn-'));
  const real = path.join(dir, 'real.txt');
  const link = path.join(dir, 'link.txt');
  fs.writeFileSync(real, 'CONTENT');
  fs.symlinkSync(real, link);
  assert.equal(readFileNoSymlink(real).toString(), 'CONTENT');
  assert.throws(() => readFileNoSymlink(link), (e) => e.code === 'ESYMLINK', '链接必须抛 ESYMLINK');
});

test('.daemon-token 符号链接：ensureToken 拒绝（不返回外部 token）', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'jz-r8-tok-'));
  const outside = path.join(TMP, 'jz-r8-out-token.txt');
  fs.writeFileSync(outside, 'a'.repeat(64)); // 外部有效格式 token
  fs.mkdirSync(path.dirname(tokenPath(root)), { recursive: true });
  fs.symlinkSync(outside, tokenPath(root));
  assert.throws(() => ensureToken(root), (e) => e.code === 'ESYMLINK', '链接 token 必须 fail-closed');
});

test('.vault-key.dpapi 符号链接：win32 + mock 解密验证读取路径拒链接（第九轮复核）', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'jz-r8-dp-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  const { dpapiGetKey } = require('../scripts/jz/crypto-vault');
  // 外部文件：内容能"解密"成合法 32 字节密钥（mock exec 返回 hex）
  const outside = path.join(TMP, 'jz-r8-out-dpapi.b64');
  fs.writeFileSync(outside, Buffer.from('fake-b64-content').toString('base64'));
  fs.symlinkSync(outside, dpapiFilePath(root));
  // platform:'win32' 才会走真实读取路径（旧回归没传 → macOS 开头直接 return null，
  // 根本没测到读取）。mock exec 假装 DPAPI 解密成功返回外部密钥 hex——
  // 若 readFileNoSymlink 未拦截，会返回外部 32 字节密钥（攻击成功）。
  const mockExec = () => 'a'.repeat(64);
  // 第十轮更新：ESYMLINK 必须上抛（不再 return null——null 会让后续 dpapiSetKey 覆盖外部）
  assert.throws(
    () => dpapiGetKey(root, { platform: 'win32', exec: mockExec }),
    (e) => e.code === 'ESYMLINK',
    'DPAPI 链接必须上抛（不读外部解密）',
  );
  // 对照：真实文件 + mock 解密 → 正常返回密钥（证明 mock 有效、读取路径确实走到）
  const real = dpapiFilePath(root);
  fs.rmSync(real, { force: true });
  fs.writeFileSync(real, Buffer.from('real-b64').toString('base64'));
  const got = dpapiGetKey(root, { platform: 'win32', exec: mockExec });
  assert.equal(got.length, 32, '真实文件 + mock 解密应返回密钥（对照）');
});

test('.vault-key.dpapi 符号链接：完整 loadOrCreateDataKey 抛错且外部文件不被覆盖（第十轮 P1）', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'jz-r10-dp-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  const { loadOrCreateDataKey } = require('../scripts/jz/crypto-vault');
  // 外部文件：内容能"解密"成合法密钥
  const outside = path.join(TMP, 'jz-r10-out-dpapi.b64');
  const original = Buffer.from('external-original-content').toString('base64');
  fs.writeFileSync(outside, original);
  fs.symlinkSync(outside, dpapiFilePath(root));
  const mockExec = () => 'a'.repeat(64);
  // ESYMLINK 必须上抛阻断后续创建（不得走 dpapiSetKey 覆盖链接外部）
  assert.throws(
    () => loadOrCreateDataKey(root, { platform: 'win32', exec: mockExec }),
    (e) => e.code === 'ESYMLINK',
    'DPAPI 链接必须上抛阻断创建流程',
  );
  // 外部文件内容必须原样保留（旧控制流会经 dpapiSetKey 跟随链接改写它）
  assert.equal(fs.readFileSync(outside, 'utf8'), original, '外部文件不得被覆盖');
});

test('.vault-key.dpapi 写入路径：dpapiSetKey 遇链接拒绝写（外部不被覆盖）', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'jz-r10-wr-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  const { dpapiSetKey, dpapiProtect } = require('../scripts/jz/crypto-vault');
  const outside = path.join(TMP, 'jz-r10-out-wr.b64');
  const original = 'ORIGINAL-KEEP';
  fs.writeFileSync(outside, original);
  fs.symlinkSync(outside, dpapiFilePath(root));
  const mockExec = () => 'a'.repeat(64); // dpapiProtect 用
  const ok = dpapiSetKey(Buffer.alloc(32, 1), root, { platform: 'win32', exec: mockExec });
  assert.equal(ok, false, 'dpapiSetKey 遇链接必须返回 false 不写');
  assert.equal(fs.readFileSync(outside, 'utf8'), original, '外部文件不得被覆盖');
});

test('.vault-key 符号链接：loadOrCreateDataKey fail-closed 抛错（不读外部密钥、不静默换密钥）', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'jz-r8-vk-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  const outside = path.join(TMP, 'jz-r8-out-vaultkey.bin');
  fs.writeFileSync(outside, Buffer.alloc(32, 7)); // 外部"密钥"
  fs.symlinkSync(outside, path.join(root, 'license', '.vault-key'));
  // 无 Keychain/DPAPI 可用时（本机测试环境），.vault-key 是唯一密钥源 → 链接必须抛错
  //（用依赖注入让 Keychain/DPAPI 全不可用，直接走明文文件分支）
  assert.throws(
    () => loadOrCreateDataKey(root, { platform: 'win32', keychain: () => null, dpapi: () => null }),
    /符号链接/,
    '.vault-key 链接必须 fail-closed',
  );
});
