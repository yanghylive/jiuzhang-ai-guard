'use strict';
// WorkDaddy 二开版发布构建：把仓库 scripts 同步进 app 骨架 → 打 DMG → ed25519 签名 → 输出发布说明。
// 这是「发 GitHub Release」的前置自动化（发布动作本身走 gh，见末尾指引）。
//
// 用法：
//   node scripts/build-release.js [--version x.y.z] [--priv-key /path/priv.pem] [--app /Applications/JIUZHANG AI 管家.app]
//                                [--out dist] [--repo babygoton/WorkDaddy] [--dry-run]
//                                [--oss]（打完上传 DMG+签名到 OSS updates/；需 OSS_* env，缺则跳过）
//
// 流程：
//   1. 同步 scripts/（含 jz/）到 app 骨架 Contents/Resources/scripts/，保留 app 内 node_modules
//   2. hdiutil create dist/WorkDaddy-<version>.dmg
//   3. ed25519 签名（digest + 私钥），输出 ---signature: xxx--- 串
//   4. 输出 GitHub Release 发布说明（tag、signature、gh release create 命令）
//   5. 可选 --oss：DMG + 签名 JSON 上传 OSS updates/<version>/（零依赖 oss-client，缺凭据 fail-closed 跳过）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { uploadObject: putObject } = require('./jz/oss-client');

const ROOT = path.join(__dirname, '..');
const SCRIPT_SRC = path.join(ROOT, 'scripts');

function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') o.version = argv[++i];
    else if (a === '--priv-key') o.privKey = argv[++i];
    else if (a === '--app') o.app = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--oss') o.oss = true;
  }
  return o;
}

function daemonVersion() {
  const s = fs.readFileSync(path.join(SCRIPT_SRC, 'daemon.js'), 'utf8');
  const m = /const DAEMON_VERSION = '([^']+)'/.exec(s);
  return m ? m[1] : null;
}

function updateRepo() {
  const s = fs.readFileSync(path.join(SCRIPT_SRC, 'daemon.js'), 'utf8');
  const m = /UPDATE_REPO = process\.env\.WBSWITCH_UPDATE_REPO \|\| '([^']+)'/.exec(s);
  return m ? m[1] : 'babygoton/WorkDaddy';
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

// OSS env（与 jz/error-report.js readOssEnv 同约定）：OSS_ACCESS_KEY_ID/SECRET 必需，BUCKET/REGION 可选。
function readOssEnv() {
  const id = process.env.OSS_ACCESS_KEY_ID;
  const secret = process.env.OSS_ACCESS_KEY_SECRET;
  if (!id || !secret) return null;
  return {
    accessKeyId: id,
    accessKeySecret: secret,
    bucket: process.env.OSS_BUCKET || 'kaypal',
    region: process.env.OSS_REGION || 'oss-cn-hangzhou',
  };
}

// 上传 DMG + 签名清单到 OSS updates/<version>/。返回 {ok, uploaded, reason}。
// 缺凭据 → fail-closed 跳过（不阻断发布）；上传失败 → 明确报错退出（半截发布比失败更危险）。
// transport 可注入以便单测（不发真实网络请求）。
async function uploadToOss({ ossEnv, version, dmgPath, signature, digest, dryRun, transport }) {
  if (!ossEnv) return { ok: false, uploaded: [], reason: 'NO_OSS_CREDENTIALS' };
  const prefix = `updates/${version}`;
  const uploaded = [];
  if (dryRun) {
    console.log(`[5/5] (dry-run) 将上传: ${prefix}/${path.basename(dmgPath)} + manifest.json`);
    return { ok: true, uploaded, reason: 'DRY_RUN' };
  }
  await putObject({
    ...ossEnv,
    key: `${prefix}/${path.basename(dmgPath)}`,
    body: fs.readFileSync(dmgPath),
    contentType: 'application/x-apple-diskimage',
    transport,
  });
  uploaded.push(`${prefix}/${path.basename(dmgPath)}`);
  console.log(`  [ok] ${prefix}/${path.basename(dmgPath)}`);
  const manifest = {
    schema: 'release-manifest/v1',
    platform: 'mac',
    version,
    file: path.basename(dmgPath),
    size: fs.existsSync(dmgPath) ? fs.statSync(dmgPath).size : 0,
    sha256: digest,
    ed25519Signature: signature || null,
    uploadedAt: new Date().toISOString(),
  };
  await putObject({
    ...ossEnv,
    key: `${prefix}/manifest.json`,
    body: Buffer.from(JSON.stringify(manifest, null, 2)),
    contentType: 'application/json',
    transport,
  });
  uploaded.push(`${prefix}/manifest.json`);
  console.log(`  [ok] ${prefix}/manifest.json`);
  // 回传 manifest 内容供调用方/测试观察
  return { ok: true, uploaded, reason: null, manifest };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const version = o.version || daemonVersion();
  if (!version) {
    console.error('无法确定版本号：请 --version 或确保 daemon.js 有 DAEMON_VERSION');
    process.exit(1);
  }
  const repo = o.repo || updateRepo();
  const appSrc = o.app || '/Applications/JIUZHANG AI 管家.app';
  const outDir = o.out || path.join(ROOT, 'dist');
  const dmgName = `JIUZHANG AI 管家-${version}.dmg`;
  const dmgPath = path.join(outDir, dmgName);

  if (o.oss && !o.privKey) {
    console.error('--oss 需要 --priv-key（manifest 必须携带 ed25519 签名，无签名发布是安全缺口）');
    process.exit(1);
  }

  if (!fs.existsSync(appSrc)) {
    console.error(`未找到 app 骨架: ${appSrc}（可用 --app 指定）`);
    process.exit(1);
  }

  // 1. 临时构建目录：复制 app 骨架，覆盖仓库 scripts（保留 node_modules）
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-build-'));
  const buildApp = path.join(buildDir, 'JIUZHANG AI 管家.app');
  console.log(`[1/4] 复制 app 骨架 → ${buildApp}`);
  run('cp', ['-R', appSrc, buildApp]);

  console.log(`[2/4] 同步仓库 scripts/ → app/Contents/Resources/scripts/（含 jz/）`);
  const destScripts = path.join(buildApp, 'Contents', 'Resources', 'scripts');
  run('cp', ['-R', `${SCRIPT_SRC}/.`, destScripts]);

  // 1.0.2：对齐 app 骨架 Info.plist 版本号（CFBundleShortVersionString + CFBundleVersion），
  // 避免「daemon 1.0.2 / Finder 显示旧版本」的版本漂移（2026-08-31 真机更新 E2E 抓到）。
  // CFBundleVersion 惯例 = 版本号去掉点（1.0.2 → 102）。
  const plistPath = path.join(buildApp, 'Contents', 'Info.plist');
  if (fs.existsSync(plistPath)) {
    const cfVersion = version.split('.').join('');
    run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${version}`, plistPath]);
    run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleVersion ${cfVersion}`, plistPath]);
    console.log(`[2.1/4] Info.plist 版本对齐 → ${version} / ${cfVersion}`);
  } else {
    warn(`未找到 Info.plist（${plistPath}），跳过版本对齐`);
  }

  // 1.0.3：品牌图标覆盖（2026-09-06 产品负责人定版「球球」形象）——仓库 assets/AppIcon.icns
  // 覆盖骨架 Resources/AppIcon.icns。骨架随本机 /Applications 演化，图标入库保证
  // 任何机器构建出的 DMG 都带球球图标（安装后应用图标同源）。
  const brandIconSrc = path.join(ROOT, 'assets', 'AppIcon.icns');
  const brandIconDst = path.join(buildApp, 'Contents', 'Resources', 'AppIcon.icns');
  if (fs.existsSync(brandIconSrc) && fs.existsSync(path.dirname(brandIconDst))) {
    fs.copyFileSync(brandIconSrc, brandIconDst);
    console.log('[2.2/4] 品牌图标覆盖 → AppIcon.icns（球球）');
  }

  // 清理构建产物里的发布工具，保持 app 内 scripts 干净（node_modules 保留）
  for (const junk of ['build-release.js', 'security-gate.js']) {
    const jp = path.join(destScripts, junk);
    if (fs.existsSync(jp)) fs.unlinkSync(jp);
  }

  // 2. 打 DMG
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[3/4] 打 DMG → ${dmgPath}`);
  if (!o.dryRun) {
    // 1.0.2 修复：unlink 旧 DMG 必须在非 dry-run 分支内（否则 dry-run 会把现有 DMG 删掉）
    if (fs.existsSync(dmgPath)) fs.unlinkSync(dmgPath);
    // 2026-09-06 产品负责人定版：DMG 内带 Applications 符号链接——打开 DMG 把 app 拖一下即装好
    // （Mac 版「桌面快捷方式」惯例；此前裸 app 打包，新用户不知道往哪拖）。
    const dmgStage = path.join(buildDir, 'dmg-stage');
    fs.mkdirSync(dmgStage);
    fs.renameSync(buildApp, path.join(dmgStage, path.basename(buildApp)));
    fs.symlinkSync('/Applications', path.join(dmgStage, 'Applications'));
    run('hdiutil', [
      'create', dmgPath,
      '-volname', 'JIUZHANG AI 管家',
      '-srcfolder', dmgStage,
      '-ov', '-format', 'UDZO',
    ]);
  } else {
    console.log('  (dry-run：跳过实际打 DMG)');
  }

  // 3. 签名
  let signature = null;
  let digest = null;
  if (o.privKey) {
    if (!fs.existsSync(o.privKey)) {
      console.error(`私钥不存在: ${o.privKey}`);
      process.exit(1);
    }
    if (fs.existsSync(dmgPath)) {
      const buf = fs.readFileSync(dmgPath);
      digest = crypto.createHash('sha256').update(buf).digest('hex');
      const privPem = fs.readFileSync(o.privKey, 'utf8');
      const key = crypto.createPrivateKey(privPem);
      signature = crypto.sign(null, Buffer.from(digest, 'utf8'), key).toString('base64');
      console.log(`[4/4] 签名完成 (digest=${digest.slice(0, 16)}…)`);
    } else if (o.dryRun) {
      console.log('[4/4] (dry-run：DMG 未生成，跳过实际签名——真实构建时签名基于实际文件)');
    } else {
      console.error(`DMG 不存在: ${dmgPath}（打 DMG 步骤应已产出）`);
      process.exit(1);
    }
  } else {
    console.log('[4/4] 未提供 --priv-key，跳过签名（发布前必须签名）');
  }

  // 4. 发布说明
  console.log('\n================ 发布说明 ================');
  console.log(`版本: v${version}`);
  console.log(`DMG : ${dmgPath}`);
  if (signature) {
    console.log(`\n---signature: ${signature}---\n`);
  }
  console.log('发 GitHub Release（gh 已认证时）：');
  console.log(`  gh release create v${version} ${dmgPath} --repo ${repo} --title "JIUZHANG AI 管家 v${version}" \\`);
  if (signature) {
    console.log(`    --notes "$(printf '%s' '---signature: ${signature}---')"`);
  } else {
    console.log('    --notes "<贴入 signature 串>"');
  }
  console.log('\ndaemon 会自动检测 Releases API → 下载 DMG → SHA256 + ed25519 验签 → apply-update.sh 替换。');
  console.log(`构建临时目录（如需保留检查）: ${buildDir}`);
  if (o.dryRun && !o.privKey) {
    console.log('（dry-run：未实际打 DMG，上述 DMG 路径仅示意）');
  }

  // 5. 可选：上传 OSS updates/<version>/（缺凭据 fail-closed 跳过）
  if (o.oss) {
    const ossEnv = readOssEnv();
    if (!ossEnv) {
      console.log('\n[5/5] OSS 上传跳过：未配置 OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET（fail-closed，不阻断发布）');
      console.log('     凭据配好后重跑: node scripts/build-release.js --oss --priv-key ... 或单独上传 manifest');
    } else {
      console.log('\n[5/5] 上传 OSS updates/' + version + '/ …');
      const r = await uploadToOss({ ossEnv, version, dmgPath, signature, digest, dryRun: o.dryRun });
      if (!r.ok && r.reason !== 'DRY_RUN') {
        throw new Error(`OSS 上传失败 (${r.reason})`);
      }
      if (r.uploaded.length) {
        console.log(`OSS 上传完成 ${r.uploaded.length} 个对象（bucket=${ossEnv.bucket}）`);
        console.log('注意：生产 latest 指针（manifest.json / manifest-win.json）未自动改写——切流仍需人工确认（防误发版）。');
      }
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[build-release] 失败:', e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, daemonVersion, updateRepo, readOssEnv, uploadToOss };
