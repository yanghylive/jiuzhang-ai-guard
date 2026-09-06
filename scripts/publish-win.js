'use strict';
// WorkDaddy Windows 发布：上传 Setup.exe + 生成/上传 manifest-win.json 到 OSS updates/。
// 复用 jz/oss-client.js putObject（零依赖 OSS PUT）+ build-release.js readOssEnv（凭据约定）。
// manifest-win.json schema 沿用 release-manifest/v1 + platform/size 字段（架构 §3.1），
// 验签链路与 mac 完全一致：对 sha256 hex 字符串做 ed25519 签名。
//
// 用法：
//   node scripts/publish-win.js --version x.y.z --exe dist/JIUZHANG AI 管家-Setup-x.y.z.exe --priv-key <key.pem>
//                            [--dry-run] [--flip-latest]
//
// 上传目标：
//   updates/<version>/<exe>               （版本化，永久保留）
//   updates/<version>/manifest-win.json   （版本化）
//   updates/latest/manifest-win.json      （仅 --flip-latest：切流指针，防误发版）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { uploadObject: putObject } = require('./jz/oss-client');
const { readOssEnv, daemonVersion } = require('./build-release');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const o = { dryRun: false, flipLatest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') o.version = argv[++i];
    else if (a === '--exe') o.exe = argv[++i];
    else if (a === '--priv-key') o.privKey = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--flip-latest') o.flipLatest = true;
  }
  return o;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function signDigest(digestHex, privPem) {
  return crypto.sign(null, Buffer.from(digestHex, 'utf8'), crypto.createPrivateKey(privPem)).toString('base64');
}

function httpGetPublic(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    mod.get(url, { headers: { 'User-Agent': 'publish-win' } }, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      if (res.statusCode >= 300 && res.headers.location) { res.resume(); return resolve(httpGetPublic(res.headers.location)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function buildManifest({ version, file, size, sha256, signature }) {
  return {
    schema: 'release-manifest/v1',
    platform: 'win',
    version,
    file,
    size,
    sha256,
    ed25519Signature: signature,
    uploadedAt: new Date().toISOString(),
  };
}

async function uploadToOssWin({ ossEnv, version, exePath, privKey, dryRun, flipLatest, transport }) {
  if (!ossEnv) return { ok: false, uploaded: [], reason: 'NO_OSS_CREDENTIALS' };
  if (!privKey) return { ok: false, uploaded: [], reason: 'NO_PRIV_KEY' };
  const file = path.basename(exePath);
  const buf = fs.readFileSync(exePath);
  const size = buf.length;
  const sha256 = sha256File(exePath);
  const signature = signDigest(sha256, fs.readFileSync(privKey, 'utf8'));
  const manifest = buildManifest({ version, file, size, sha256, signature });
  const prefix = `updates/${version}`;
  const uploaded = [];
  if (dryRun) {
    console.log(`(dry-run) 将上传: ${prefix}/${file} + ${prefix}/manifest-win.json${flipLatest ? ' + updates/latest/manifest-win.json' : ''}`);
    return { ok: true, uploaded, reason: 'DRY_RUN', manifest };
  }
  await putObject({
    ...ossEnv,
    key: `${prefix}/${file}`,
    body: buf,
    contentType: 'application/octet-stream',
    transport,
  });
  uploaded.push(`${prefix}/${file}`);
  console.log(`  [ok] ${prefix}/${file} (${size} bytes)`);
  await putObject({
    ...ossEnv,
    key: `${prefix}/manifest-win.json`,
    body: Buffer.from(JSON.stringify(manifest, null, 2)),
    contentType: 'application/json',
    transport,
  });
  uploaded.push(`${prefix}/manifest-win.json`);
  console.log(`  [ok] ${prefix}/manifest-win.json`);
  if (flipLatest) {
    // 2026-08-31 修复（顺序）：先复制安装包、后翻 manifest——若先翻 manifest，
    // 客户端会立即检查到新版本并下载 updates/latest/<file>，而包还没复制 →
    // 短暂"manifest 已切流、安装包 404"窗口。
    const pkgResp = await httpGetPublic(`${ossEnv.base || 'https://kaypal.oss-cn-hangzhou.aliyuncs.com'}/updates/${version}/${file}`);
    await putObject({
      ...ossEnv,
      key: `updates/latest/${file}`,
      body: pkgResp.body,
      contentType: 'application/octet-stream',
      transport,
    });
    uploaded.push(`updates/latest/${file}`);
    console.log(`  [ok] updates/latest/${file}（安装包副本先行就位）`);
    await putObject({
      ...ossEnv,
      key: 'updates/latest/manifest-win.json',
      body: Buffer.from(JSON.stringify(manifest, null, 2)),
      contentType: 'application/json',
      transport,
    });
    uploaded.push('updates/latest/manifest-win.json');
    console.log('  [ok] updates/latest/manifest-win.json（后切流指针，无 404 窗口）');
  }
  return { ok: true, uploaded, reason: null, manifest };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const version = o.version || daemonVersion();
  if (!version) {
    console.error('无法确定版本号：请 --version 或确保 daemon.js 有 DAEMON_VERSION');
    process.exit(1);
  }
  const exePath = o.exe || path.join(ROOT, 'dist', `JIUZHANG AI 管家-Setup-${version}.exe`);
  if (!fs.existsSync(exePath)) {
    console.error(`未找到安装包: ${exePath}（先跑 node scripts/build-win.js --version ${version} 构建）`);
    process.exit(1);
  }
  if (!o.privKey) {
    console.error('缺少 --priv-key：manifest-win.json 必须携带 ed25519 签名（无签名发布是安全缺口，fail-closed）');
    process.exit(1);
  }
  if (!fs.existsSync(o.privKey)) {
    console.error(`私钥不存在: ${o.privKey}`);
    process.exit(1);
  }
  const ossEnv = readOssEnv();
  if (!ossEnv) {
    console.error('未配置 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（fail-closed，不发布）');
    process.exit(1);
  }
  console.log(`[publish-win] version=${version} exe=${exePath}`);
  console.log(`[publish-win] 上传 OSS updates/${version}/ …`);
  const r = await uploadToOssWin({ ossEnv, version, exePath, privKey: o.privKey, dryRun: o.dryRun, flipLatest: o.flipLatest });
  if (!r.ok && r.reason !== 'DRY_RUN') {
    console.error(`[publish-win] 上传失败 (${r.reason})`);
    process.exit(1);
  }
  if (!o.flipLatest && r.reason !== 'DRY_RUN') {
    console.log('\n注意：未切流 latest。daemon 读 updates/latest/manifest-win.json，验证后执行：');
    console.log(`  node scripts/publish-win.js --version ${version} --exe ${exePath} --priv-key <key.pem> --flip-latest`);
  }
  console.log('\n下一步双通道校验: node scripts/verify-release.js');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[publish-win] 失败:', e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, buildManifest, uploadToOssWin, sha256File, signDigest };
