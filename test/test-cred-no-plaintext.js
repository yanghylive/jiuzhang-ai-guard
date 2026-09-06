'use strict';
// 2026-08-30 复核 P0 回归：凭据/账号文件迁移不得残留明文副本。
// 清单要求「凭据类操作无明文备份残留」：
//   ① atomicWriteCredFile 迁移后不得存在 .plain-bak-* 明文文件
//   ② 迁移成功返回内容，迁移失败 fail-closed（返回 null，绝不继续以明文形式使用）
//   ③ readAccountFile 读到旧明文后加密回写（文件变 JZENC1 密文，不留明文）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteCredFile, readCredFile, sweepPlainBackups, sweepAllPlainBackups } = require('../scripts/jz/crypto-vault');
const { writeAccountFile, readAccountFile, ENC_MAGIC } = require('../scripts/lib');

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-nop lain-'));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  return root;
}

test('P0 凭据迁移：旧明文迁移后不留 .plain-bak-* 副本，且文件为 v2 密文', () => {
  const root = tmpRoot();
  const p = path.join(root, 'license', 'desktop-auth.json');
  // 旧明文格式（无 v2 标记）
  fs.writeFileSync(p, JSON.stringify({ accessToken: 'kda_secret', refreshToken: 'rft_secret' }), { mode: 0o600 });

  const got = readCredFile(root, p);
  assert.ok(got, '迁移后应能读到凭据内容');
  assert.equal(got.accessToken, 'kda_secret');

  // 不得产生明文备份文件
  const files = fs.readdirSync(path.join(root, 'license'));
  const plainBaks = files.filter((f) => /\.plain-bak-/.test(f));
  assert.equal(plainBaks.length, 0, `不得残留明文备份，实际: ${plainBaks.join(',')}`);

  // 落盘内容必须是加密信封（含密文字段），不得含明文 token
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(!raw.includes('kda_secret'), '文件不得含明文 token');
  assert.ok(/"v":\s*2/.test(raw), '应为 v2 加密信封');
});

test('P0 凭据迁移失败 fail-closed：写入异常时返回 null，不返回明文', () => {
  const root = tmpRoot();
  const p = path.join(root, 'license', 'desktop-auth.json');
  fs.writeFileSync(p, JSON.stringify({ accessToken: 'kda_x', refreshToken: 'rft_x' }), { mode: 0o600 });

  // 注入写入失败（模拟磁盘满/权限问题）
  const origMkdir = fs.mkdirSync;
  try {
    fs.mkdirSync = () => { throw new Error('EACCES'); };
    const got = readCredFile(root, p);
    assert.equal(got, null, '迁移失败必须 fail-closed 返回 null（不得返回明文）');
  } finally {
    fs.mkdirSync = origMkdir;
  }
});

test('P0 sweepPlainBackups 清理历史遗留明文副本', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-sweep-'));
  fs.writeFileSync(path.join(dir, '.plain-bak-111'), '{"accessToken":"old"}', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, '.plain-bak-222'), '{"accessToken":"old2"}', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'keep-me.json'), '{}');
  const n = sweepPlainBackups(dir);
  assert.equal(n, 2, '应清理 2 个历史明文副本');
  const left = fs.readdirSync(dir);
  assert.ok(!left.some((f) => /\.plain-bak-/.test(f)), '不得残留任何 .plain-bak-*');
  assert.ok(left.includes('keep-me.json'), '正常文件不得误删');
});

test('P0 sweepPlainBackups：匹配后缀格式 <file>.plain-bak-<ts>（历史文件名实测）', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-sweep2-'));
  // 旧版本实际产生的文件名格式：desktop-auth.json.plain-bak-1756201234567（后缀，不是前缀）
  fs.writeFileSync(path.join(dir, 'desktop-auth.json.plain-bak-1756201234567'), '{"accessToken":"leak"}', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'oidc.json.plain-bak-1756209999999'), '{"x":1}', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'normal.json'), '{}');
  const n = sweepPlainBackups(dir);
  assert.equal(n, 2, `应清理 2 个后缀格式明文副本，实际 ${n}（旧正则实测为 0）`);
  const left = fs.readdirSync(dir);
  assert.ok(!left.some((f) => /\.plain-bak-/.test(f)), '不得残留');
  assert.ok(left.includes('normal.json'), '正常文件不得误删');
});

test('P0 sweepAllPlainBackups：递归扫 license/accounts/根目录（生产调用路径）', () => {
  const root = tmpRoot();
  const accDir = path.join(root, 'accounts');
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'license', 'desktop-auth.json.plain-bak-111'), 'x', { mode: 0o600 });
  fs.writeFileSync(path.join(accDir, 'u1.info.json.plain-bak-222'), 'x', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'stray.json.plain-bak-333'), 'x', { mode: 0o600 });
  const n = sweepAllPlainBackups(root);
  assert.equal(n, 3, `三个目录各清 1 个，实际 ${n}`);
});

test('P0 账号文件：读到旧明文后加密回写（变 JZENC1，不留明文）', () => {
  const root = tmpRoot();
  const file = path.join(root, 'accounts', 'u1.info.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 旧明文账号文件
  fs.writeFileSync(file, JSON.stringify({ uid: 'u1', token: 'PLAIN-TOKEN-123' }), { mode: 0o600 });

  const obj = readAccountFile(root, file);
  assert.equal(obj.uid, 'u1');

  const buf = fs.readFileSync(file);
  assert.equal(
    buf.slice(0, ENC_MAGIC.length).toString('latin1'),
    ENC_MAGIC,
    '明文账号文件读取后必须加密回写为 JZENC1',
  );
  // 再读一次仍正确（加密路径）
  const again = readAccountFile(root, file);
  assert.equal(again.token, 'PLAIN-TOKEN-123');
});

test('P0 账号明文迁移失败 fail-closed：抛错，绝不返回明文对象（第三轮复核）', () => {
  const root = tmpRoot();
  const file = path.join(root, 'accounts', 'u2.info.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ uid: 'u2', token: 'PLAIN-TOKEN-456' }), { mode: 0o600 });

  // 注入写入失败（模拟磁盘满/权限）：迁移必须抛错，调用方拿不到明文
  const origWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = function patched(p, ...rest) {
      if (typeof p === 'string' && p.includes('.tmp.')) {
        throw new Error('ENOSPC: no space left on device');
      }
      return origWrite.call(fs, p, ...rest);
    };
    assert.throws(() => readAccountFile(root, file), /ENOSPC/, '迁移失败必须抛错');
  } finally {
    fs.writeFileSync = origWrite;
  }
  // 恢复后重读：迁移重试成功，明文被加密回写闭环
  const obj = readAccountFile(root, file);
  assert.equal(obj.token, 'PLAIN-TOKEN-456');
  assert.equal(fs.readFileSync(file).slice(0, ENC_MAGIC.length).toString('latin1'), ENC_MAGIC, '恢复后明文应被加密回写');
});
