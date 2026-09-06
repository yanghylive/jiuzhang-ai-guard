'use strict';
// 假旧版构造器（架构 T04）：读当前版本 → 降一位 patch → 临时改写 daemon.js 版本号 → 构建旧版 exe → 生成假旧版 manifest + 签名。
// 产出 dist/JiuZhangAI-Setup-<old>.exe + dist/manifest-win-<old>.json，供「假旧版升级」E2E 门禁使用。
// 复用 build-win.js 的构建管线（内嵌 runtime + makensis），零新增依赖。
//
// 用法：
//   node scripts/fake-old-release.js [--out dist] [--priv-key <key.pem>] [--node-version 22.22.2] [--dry-run]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { daemonVersion, buildWin, sha256File, signDigest } = require('./build-win');

const SCRIPT_SRC = path.join(__dirname, '..', 'scripts');

function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--priv-key') o.privKey = argv[++i];
    else if (a === '--node-version') o.nodeVersion = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
  }
  return o;
}

// 降一位版本号：patch-1（patch=0 则 minor-1、patch=0）。返回 {old, current} 的 old 字符串。
function decrementVersion(v) {
  const parts = String(v || '').replace(/^v/, '').split('.');
  const major = parseInt(parts[0], 10) || 0;
  const minor = parseInt(parts[1], 10) || 0;
  const patch = parseInt(parts[2], 10) || 0;
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  return `${Math.max(0, major - 1)}.0.0`;
}

// 复制 scripts 到临时目录并把 daemon.js 的 DAEMON_VERSION 改为 oldVersion，返回临时 scripts 根。
function patchScriptsVersion(oldVersion) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-fake-old-'));
  const scriptsTmp = path.join(tmp, 'scripts');
  fs.cpSync(SCRIPT_SRC, scriptsTmp, { recursive: true });
  const daemonPath = path.join(scriptsTmp, 'daemon.js');
  let src = fs.readFileSync(daemonPath, 'utf8');
  const re = /const DAEMON_VERSION = '[^']+'/;
  if (!re.test(src)) throw new Error('daemon.js 缺少 DAEMON_VERSION 常量，无法改写');
  src = src.replace(re, `const DAEMON_VERSION = '${oldVersion}'`);
  fs.writeFileSync(daemonPath, src);
  return scriptsTmp;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const current = daemonVersion();
  if (!current) {
    console.error('无法确定当前版本（daemon.js 无 DAEMON_VERSION）');
    process.exit(1);
  }
  const old = decrementVersion(current);
  console.log(`[fake-old] 当前版本=${current} 假旧版=${old}`);
  const scriptsTmp = patchScriptsVersion(old);
  const r = await buildWin({
    version: old,
    appName: 'JIUZHANG AI 管家',
    scriptsSrc: scriptsTmp,
    outDir: o.out,
    nodeVersion: o.nodeVersion,
    privKey: o.privKey,
    dryRun: o.dryRun,
    skipZip: true, // 假旧版只产 exe（E2E 基准）
  });

  // 生成假旧版 manifest + 签名（E2E 基准：验证验签一致性）
  let manifestPath = null;
  if (!o.dryRun && o.privKey && fs.existsSync(r.exePath)) {
    const sha256 = sha256File(r.exePath);
    const signature = signDigest(sha256, fs.readFileSync(o.privKey, 'utf8'));
    const manifest = {
      schema: 'release-manifest/v1',
      platform: 'win',
      version: old,
      file: path.basename(r.exePath),
      size: fs.statSync(r.exePath).size,
      sha256,
      ed25519Signature: signature,
      uploadedAt: new Date().toISOString(),
    };
    manifestPath = path.join(r.outDir, `manifest-win-${old}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\n[fake-old] 假旧版 manifest → ${manifestPath}`);
  }

  console.log('\n[fake-old] 完成。E2E 用法（Windows 真机/云电脑）：');
  console.log(`  1. 安装假旧版: "${r.exePath}" /S /D=%LOCALAPPDATA%\\Programs\\JiuZhangAI`);
  console.log(`  2. daemon 检查更新（manifest-win.json 指向 ${current}）→ 下载 → SHA256 → 验签 → 静默安装 → 重启`);
  console.log(`  3. node scripts/verify-live-win.js 断言版本回升到 ${current}`);
  if (!o.privKey) console.log('  （提示：未传 --priv-key，未生成签名 manifest；E2E 安装仅需 exe）');

  fs.rmSync(scriptsTmp, { recursive: true, force: true });
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[fake-old] 失败:', e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, decrementVersion, patchScriptsVersion };
