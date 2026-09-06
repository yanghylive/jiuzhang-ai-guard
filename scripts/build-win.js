'use strict';
// WorkDaddy (JiuZhang AI Guardian) Windows 构建入口。
// 纯 node:crypto + node:child_process + node:https + node:fs，零新增 npm 依赖（与 build-release.js 同风格）。
// 职责（架构 T01）：
//   1. 下载官方 node-v<v>-win-x64.zip → SHASUMS256.txt 校验 → 解包进 runtime/（缓存复用）
//   2. 组装打包目录（scripts 内容 + runtime/ + launcher.cmd + watchdog.ps1 + apply-update.ps1 + apply-update.vbs + uninstall.ps1）
//   3. makensis 打 JIUZHANG AI 管家-Setup-<version>.exe（per-user，内嵌 runtime）
//   4. exe SHA-256 + ed25519 签名（可选 --priv-key）
//   5. 绿色版 zip（仅内网/真机验证，不进 OSS 更新通道；地基决策 #4 NSIS+zip 并存）
//
// 用法：
//   node scripts/build-win.js [--version x.y.z] [--priv-key /path/priv.pem] [--out dist]
//                             [--node-version 22.22.2] [--name JIUZHANG AI 管家] [--dry-run] [--skip-zip] [--verbose]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT_SRC = path.join(ROOT, 'scripts');
const DEFAULT_NODE_VERSION = '22.22.2';
const NODE_DIST_BASE = 'https://nodejs.org/dist';

// 不进入安装目录的构建/发布工具与 macOS 专用脚本（install.ps1 铺目录同理，仅铺运行期文件）。
const EXCLUDE_TOP = new Set([
  'installer.nsi',
  'build-win.js',
  'build-release.js',
  'publish-win.js',
  'verify-release.js',
  'verify-live.js',
  'verify-live-win.js',
  'fake-old-release.js',
  'sign-release.js',
  'security-gate.js',
  'apply-update.sh',
  'install.sh',
  'uninstall.sh',
  'relaunch-with-cdp.sh',
  'sync-workdaddy-app.sh',
]);

function log(...args) { console.log(...args); }
function warn(...args) { console.error('⚠', ...args); }

function parseArgs(argv) {
  const o = { dryRun: false, skipZip: false, verbose: false, name: 'JIUZHANG AI 管家', installDirName: 'JiuZhangAI' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') o.version = argv[++i];
    else if (a === '--priv-key') o.privKey = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--node-version') o.nodeVersion = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--install-dir-name') o.installDirName = argv[++i];
    else if (a === '--scripts-src') o.scriptsSrc = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--skip-zip') o.skipZip = true;
    else if (a === '--verbose') o.verbose = true;
  }
  return o;
}

function daemonVersion(scriptsSrc) {
  const src = scriptsSrc || SCRIPT_SRC;
  const s = fs.readFileSync(path.join(src, 'daemon.js'), 'utf8');
  const m = /const DAEMON_VERSION = '([^']+)'/.exec(s);
  return m ? m[1] : null;
}

function which(cmd) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [cmd], { encoding: 'utf8' })
    : spawnSync('which', [cmd], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  return (probe.stdout || '').trim().split(/\r?\n/)[0] || null;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 对 sha256 hex digest 做 ed25519 签名（与 sign-release.js:16-20 / build-release.js:177-183 同一算法）。
function signDigest(digestHex, privPem) {
  return crypto.sign(null, Buffer.from(digestHex, 'utf8'), crypto.createPrivateKey(privPem)).toString('base64');
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part.' + crypto.randomBytes(6).toString('hex');
    const file = fs.createWriteStream(tmp, { flags: 'w' });
    const req = https.get(url, { headers: { 'User-Agent': 'JiuZhangAI-build/1' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try { file.close(); } catch (_) {}
        try { fs.unlinkSync(tmp); } catch (_) {}
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        try { file.close(); } catch (_) {}
        try { fs.unlinkSync(tmp); } catch (_) {}
        return reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        try { file.close(); } catch (_) {}
        try { fs.renameSync(tmp, dest); } catch (e) { return reject(e); }
        resolve(dest);
      });
      file.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
    });
    req.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
    req.setTimeout(180000, () => req.destroy(new Error('下载超时')));
  });
}

function unpackZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let cmd, args;
  if (process.platform === 'win32') {
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-Command', `Expand-Archive -Path "${zip}" -DestinationPath "${dest}" -Force`];
  } else if (which('unzip')) {
    cmd = 'unzip'; args = ['-q', '-o', zip, '-d', dest];
  } else if (which('ditto')) {
    cmd = 'ditto'; args = ['-x', '-k', zip, dest];
  } else {
    throw new Error('缺少解压工具（unzip/ditto/PowerShell），无法解包 Node zip');
  }
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`解压失败: ${(r.stderr || r.stdout || '').trim()}`);
}

function makeZip(srcDir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  let cmd, args, cwd;
  if (process.platform === 'win32') {
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-Command', `Compress-Archive -Path "${srcDir}\\*" -DestinationPath "${zipPath}" -Force`];
    cwd = undefined;
  } else if (which('zip')) {
    cmd = 'zip'; args = ['-q', '-r', zipPath, '.']; cwd = srcDir;
  } else if (which('ditto')) {
    cmd = 'ditto'; args = ['-c', '-k', srcDir, zipPath]; cwd = undefined;
  } else {
    throw new Error('缺少 zip 工具（zip/ditto/PowerShell），无法生成绿色版 zip');
  }
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd });
  if (r.status !== 0) throw new Error(`zip 失败: ${(r.stderr || r.stdout || '').trim()}`);
}

// 复制 scripts 内容 → stage（排除构建/发布工具、macOS 专用脚本，以及历史构建产物）。
function copyScripts(stage, scriptsSrc) {
  const src = scriptsSrc || SCRIPT_SRC;
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(src, stage, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (EXCLUDE_TOP.has(top)) return false;
      // 历史构建产物（.exe/.dmg/.zip/.pkg）可能残留在 scripts/（如误写入的 Setup.exe），
      // 绝不能打进安装包（会把旧安装包嵌套进新安装包，体积翻倍）。
      if (rel === top && /\.(exe|dmg|zip|pkg)$/i.test(top)) return false;
      return true;
    },
  });
}

// 确保 stage/runtime 内嵌 node 就位：缓存命中直接复用，否则下载 + SHASUMS256 校验 + 解包。
async function ensureRuntime({ stage, nodeVersion, cacheDir, dryRun, verbose }) {
  const runtimeDir = path.join(stage, 'runtime');
  const zipName = `node-v${nodeVersion}-win-x64.zip`;
  const shasumsName = 'SHASUMS256.txt';
  const zipPath = path.join(cacheDir, zipName);
  const shasumsPath = path.join(cacheDir, shasumsName);
  const unpackedDir = path.join(cacheDir, `node-v${nodeVersion}-win-x64`);
  const nodeExe = path.join(unpackedDir, 'node.exe');
  const zipUrl = `${NODE_DIST_BASE}/v${nodeVersion}/${zipName}`;
  const shasumsUrl = `${NODE_DIST_BASE}/v${nodeVersion}/${shasumsName}`;

  if (dryRun) {
    log(`  (dry-run) runtime: node-v${nodeVersion}-win-x64 → 解包进 ${runtimeDir}`);
    if (fs.existsSync(nodeExe)) log('  (dry-run) runtime 缓存已存在，将直接复用');
    else log(`  (dry-run) 将下载 ${zipUrl} → SHASUMS256 校验 → 解包`);
    return;
  }

  // 1. 复用缓存（已解包）
  if (fs.existsSync(nodeExe)) {
    if (verbose) log(`  复用缓存 runtime: ${nodeExe}`);
  } else {
    fs.mkdirSync(cacheDir, { recursive: true });
    // 2. 下载 zip + shasums
    if (!fs.existsSync(zipPath)) {
      log(`  下载 ${zipUrl} …`);
      await downloadFile(zipUrl, zipPath);
    }
    if (!fs.existsSync(shasumsPath)) {
      log(`  下载 ${shasumsUrl} …`);
      await downloadFile(shasumsUrl, shasumsPath);
    }
    // 3. 校验 zip SHA256（对照官方 SHASUMS256.txt，防供应链投毒）
    const shasums = fs.readFileSync(shasumsPath, 'utf8');
    const line = shasums.split(/\r?\n/).find((l) => l.trim().endsWith(`  ${zipName}`));
    const expect = line ? line.trim().split(/\s+/)[0].toLowerCase() : null;
    if (!expect) throw new Error(`SHASUMS256.txt 中未找到 ${zipName}，拒绝使用未校验的 Node zip`);
    const actual = sha256File(zipPath);
    if (actual !== expect) throw new Error(`Node zip SHA256 校验失败（${actual} != ${expect}），已拒绝`);
    log(`  Node zip SHA256 校验通过 (${actual.slice(0, 16)}…)`);
    // 4. 解包
    log(`  解包 ${zipName} → ${unpackedDir} …`);
    unpackZip(zipPath, cacheDir);
    if (!fs.existsSync(nodeExe)) throw new Error('解包后未找到 node.exe，zip 结构异常');
  }

  // 5. 复制到 stage/runtime
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.cpSync(unpackedDir, runtimeDir, { recursive: true });
  log(`  runtime 就位: ${path.join(runtimeDir, 'node.exe')}`);
}

// 核心构建流程（供 CLI 与 fake-old-release.js 复用）。
async function buildWin({
  version, appName = 'JIUZHANG AI 管家', installDirName = 'JiuZhangAI', scriptsSrc, outDir, nodeVersion = DEFAULT_NODE_VERSION,
  privKey = null, dryRun = false, skipZip = false, verbose = false,
} = {}) {
  const out = outDir || path.join(ROOT, 'dist');
  const stage = path.join(out, 'win-staging');
  const cacheDir = path.join(out, 'node-cache');
  const exeName = `${appName}-Setup-${version}.exe`;
  const exePath = path.join(out, exeName);
  const zipName = `${appName}-${version}-win64.zip`;
  const zipPath = path.join(out, zipName);
  const nsiPath = path.join(SCRIPT_SRC, 'installer.nsi');

  log(`\n[build-win] 版本=${version} 安装名=${appName} 输出=${out}`);
  if (dryRun) log('(dry-run 模式：只演示流程，不下载/不编译/不签名)');

  // 0. 预检 makensis（清晰报错，不静默失败）
  const makensis = which('makensis');
  if (!makensis) {
    if (dryRun) {
      warn('未装 makensis（本机 dry-run 跳过编译）；真实构建需先：macOS `brew install nsis` / Linux `apt install nsis` / Windows 装 NSIS');
    } else {
      throw new Error('未装 makensis，请先安装：macOS `brew install nsis` / Linux `apt install nsis` / Windows 装 NSIS');
    }
  }

  // 1. 组装 staging：scripts 内容 + runtime + 辅助脚本
  log(`[1/4] 组装打包目录 → ${stage}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  copyScripts(stage, scriptsSrc);
  // 应用图标：打包进安装目录供安装器/快捷方式引用（$INSTDIR\jiuzhang.ico，installer.nsi Icon/CreateShortcut 依赖）。
  const icoSrc = path.join(ROOT, 'assets', 'jiuzhang.ico');
  if (!fs.existsSync(icoSrc)) throw new Error('缺少应用图标 assets/jiuzhang.ico（安装器/快捷方式图标必需）');
  fs.copyFileSync(icoSrc, path.join(stage, 'jiuzhang.ico'));
  await ensureRuntime({ stage, nodeVersion, cacheDir, dryRun, verbose });

  // 2. makensis 打安装包
  log(`[2/4] makensis 编译 → ${exePath}`);
  if (!dryRun) {
    fs.mkdirSync(out, { recursive: true });
    if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
    // 跨平台 makensis 参数：macOS 版 makensis 用 `-` 前缀（不能传 Windows 式 `/O`，否则被当成脚本路径）。
    //   -NOCD 让脚本内相对路径（OutFile）以 cwd=out 落盘到 dist/，而不是脚本所在 scripts/；
    //   因此 STAGE_DIR 与 nsi 路径必须是绝对路径（path.join 已保证），并统一转正斜杠。
    const stageForNsis = stage.split(path.sep).join('/');
    const nsiForNsis = nsiPath.split(path.sep).join('/');
    const r = spawnSync(makensis, [
      '-V2',
      '-NOCD',
      `-DAPP_VERSION=${version}`,
      `-DAPP_NAME=${appName}`,
      `-DINSTALL_DIR_NAME=${installDirName}`,
      `-DSTAGE_DIR=${stageForNsis}`,
      `-DASSETS_DIR=${path.join(ROOT, 'assets').split(path.sep).join('/')}`,
      nsiForNsis,
    ], { cwd: out, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout || '').trim();
      throw new Error(`makensis 失败: ${detail}`);
    }
    if (verbose) log(r.stdout ? r.stdout.trim() : '(makensis 无输出)');
    if (!fs.existsSync(exePath)) throw new Error(`makensis 结束但未产出 ${exePath}`);
  } else {
    log('  (dry-run) 跳过 makensis 编译');
  }

  // 3. exe SHA256 + 签名
  let digest = null;
  let signature = null;
  if (privKey) {
    if (!fs.existsSync(privKey)) throw new Error(`私钥不存在: ${privKey}`);
    if (!dryRun) {
      digest = sha256File(exePath);
      signature = signDigest(digest, fs.readFileSync(privKey, 'utf8'));
    } else {
      log('  (dry-run) exe 未生成，跳过实际签名（真实构建签名基于实际文件）');
    }
  } else if (!dryRun) {
    digest = sha256File(exePath);
    warn('未提供 --priv-key：安装包未签名（发布前必须 --priv-key 签名，否则 daemon 验签拒装）');
  }

  // 4. 绿色版 zip（内网/真机验证用，不进 OSS 更新通道）
  if (skipZip) {
    log('[4/4] 跳过绿色版 zip（--skip-zip）');
  } else if (dryRun) {
    log(`[4/4] (dry-run) 绿色版 zip → ${zipPath}（内网/真机验证，不进 OSS）`);
  } else {
    log(`[4/4] 绿色版 zip → ${zipPath}`);
    makeZip(stage, zipPath);
  }

  return { version, appName, exePath, zipPath, digest, signature, stage, outDir: out };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const version = o.version || daemonVersion(o.scriptsSrc);
  if (!version) {
    console.error('无法确定版本号：请 --version 或确保 daemon.js 有 DAEMON_VERSION');
    process.exit(1);
  }
  const r = await buildWin({
    version,
    appName: o.name,
    installDirName: o.installDirName,
    scriptsSrc: o.scriptsSrc,
    outDir: o.out,
    nodeVersion: o.nodeVersion || DEFAULT_NODE_VERSION,
    privKey: o.privKey,
    dryRun: o.dryRun,
    skipZip: o.skipZip,
    verbose: o.verbose,
  });

  console.log('\n================ Windows 发布说明 ================');
  console.log(`版本: v${r.version}`);
  console.log(`安装包: ${r.exePath}${o.dryRun ? '（dry-run 未实际产出）' : ''}`);
  if (!o.dryRun && fs.existsSync(r.exePath)) {
    console.log(`大小: ${fs.statSync(r.exePath).size} bytes`);
  }
  if (r.digest) console.log(`SHA-256: ${r.digest}`);
  if (r.signature) console.log(`\n---signature: ${r.signature}---`);
  if (!o.skipZip) console.log(`绿色版 zip: ${r.zipPath}（仅内网/真机验证，不进 OSS 更新通道）`);
  console.log('\n下一步:');
  console.log(`  上传发布: node scripts/publish-win.js --version ${r.version} --exe ${r.exePath} --priv-key <key.pem> [--flip-latest]`);
  console.log('  双通道校验: node scripts/verify-release.js');
  if (o.dryRun && !which('makensis')) {
    console.log('\n（本机未装 makensis，dry-run 已结束；真实构建会在此报错退出。）');
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[build-win] 失败:', e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, daemonVersion, sha256File, signDigest, buildWin, copyScripts, ensureRuntime, unpackZip, makeZip };
