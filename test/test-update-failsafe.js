'use strict';
// 更新失败自动恢复（§15 macOS 侧）：验证 daemon.js 的验签/校验函数对所有失败路径 fail-closed。
// 代码逐字节取自 scripts/daemon.js（vm 执行真实函数，不复制逻辑）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const vm = require('node:vm');
const path = require('node:path');

const daemonPath = path.join(__dirname, '..', 'scripts', 'daemon.js');
const daemonSrc = fs.readFileSync(daemonPath, 'utf8');

function extractByBrace(name) {
  const start = daemonSrc.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('not found ' + name);
  let depth = 0;
  let i = start;
  for (; i < daemonSrc.length; i++) {
    if (daemonSrc[i] === '{') depth++;
    else if (daemonSrc[i] === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return daemonSrc.slice(start, i);
}

const pubKeyMatch = /const UPDATE_PUBLIC_KEY_PEM = process\.env\.WBSWITCH_UPDATE_PUBKEY_PEM \|\| `([\s\S]*?)`;/.exec(daemonSrc);
assert.ok(pubKeyMatch, 'daemon.js 应含固化公钥常量');

const sandbox = {
  crypto,
  Buffer,
  require,
  process,
  console,
  spawnSync: require('node:child_process').spawnSync,
  fs,
  path,
  os: require('node:os'),
  IS_WIN: process.platform === 'win32',
  updateState: { dmgSize: 0 },
  UPDATE_PUBLIC_KEY_PEM: pubKeyMatch[1],
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// validateUpdateArtifact 依赖 sha256File / parseUpdateSignature / verifyUpdateSignature，
// 必须一并抽取进沙箱，否则 vm 内 ReferenceError 假失败（"sha256File is not defined"）。
vm.runInContext(
  [
    extractByBrace('verifyUpdateSignature'),
    extractByBrace('parseUpdateSignature'),
    extractByBrace('sha256File'),
    extractByBrace('validateUpdateArtifact'),
  ].join('\n'),
  sandbox,
);

test('更新失败自动恢复：坏 DMG / 空文件 / 缺签名 / 坏签名全拒装，真签名通过', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jz-upd-'));

  // 1. 文本冒充 DMG → 拒装。拒装路径随平台而异但语义一致（fail-closed）：
  //    macOS：hdiutil imageinfo 预检拒；Windows：无 DMG 概念，非 .exe 回退 sha256+验签，缺签名拒。
  const fakeDmg = path.join(tmp, 'fake.dmg');
  fs.writeFileSync(fakeDmg, 'this is not a real dmg, just text for test');
  let r = sandbox.validateUpdateArtifact(fakeDmg, null);
  assert.equal(r.ok, false, '文本冒充 DMG 应拒装');
  if (process.platform !== 'win32') {
    assert.ok(/不是有效 DMG|无法识别映像|imageinfo failed/i.test(r.reason), r.reason);
  }

  // 2. 空文件 + expectSha → 拒装
  const emptyDmg = path.join(tmp, 'empty.dmg');
  fs.writeFileSync(emptyDmg, '');
  r = sandbox.validateUpdateArtifact(emptyDmg, 'a'.repeat(64));
  assert.equal(r.ok, false, '空文件应拒装');
  assert.ok(/为空|不是普通文件/.test(r.reason), r.reason);

  // 3. 缺签名 → 拒装
  r = sandbox.verifyUpdateSignature('deadbeef'.repeat(8), null);
  assert.equal(r.ok, false);
  assert.ok(/签名缺失/.test(r.reason));

  // 4. 坏签名 → 拒装
  r = sandbox.verifyUpdateSignature('deadbeef'.repeat(8), Buffer.from('bad-sig').toString('base64'));
  assert.equal(r.ok, false);
  assert.ok(/签名无效/.test(r.reason));

  // 5. 真签名 → 通过（证明验签不是永远拒绝；用本机发布私钥签真实 digest）
  const privPath = '/tmp/wd-update-priv.pem';
  if (fs.existsSync(privPath)) {
    const digest = crypto.createHash('sha256').update('real-update-content').digest('hex');
    const sig = crypto.sign(null, Buffer.from(digest, 'utf8'), crypto.createPrivateKey(fs.readFileSync(privPath, 'utf8')));
    r = sandbox.verifyUpdateSignature(digest, sig.toString('base64'));
    assert.equal(r.ok, true, '发布私钥签名应通过验签: ' + (r.reason || ''));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});
