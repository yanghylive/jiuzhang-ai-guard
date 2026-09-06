'use strict';
// WorkDaddy 发布签名脚本（P1-4 配套）：算 DMG 的 SHA-256 digest + ed25519 私钥签名，
// 输出 `---signature: <base64>---` 串，贴到 GitHub Releases body 供 daemon 验签。
// 用法：node sign-release.js <dmg路径> <私钥pem路径>
// 私钥只由发布者持有，不进仓库；公钥已固化在 daemon.js（WBSWITCH_UPDATE_PUBKEY_PEM 可覆盖）。
const crypto = require('node:crypto');
const fs = require('node:fs');

const dmg = process.argv[2];
const keyPath = process.argv[3];
if (!dmg || !keyPath) {
  console.error('用法: node sign-release.js <dmg路径> <私钥pem路径>');
  process.exit(1);
}

const buf = fs.readFileSync(dmg);
const digest = crypto.createHash('sha256').update(buf).digest('hex');
const privPem = fs.readFileSync(keyPath, 'utf8');
const key = crypto.createPrivateKey(privPem);
const sig = crypto.sign(null, Buffer.from(digest, 'utf8'), key).toString('base64');

console.log('digest(sha256): ' + digest);
console.log('');
console.log('---signature: ' + sig + '---');
console.log('');
console.log('把上面这行 ---signature: xxx--- 贴进 GitHub Releases body（notes），daemon 更新时会验签。');
