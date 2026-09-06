'use strict';
// Windows 真机 E2E 冒烟（架构 T04）：装旧版后，端到端断言「检查 → 下载 → SHA256 → ed25519 验签 → 静默安装 → 重启 → 版本回升」。
// 在 Windows 真机/无影云电脑上运行（node ≥ 18，推荐内嵌 runtime\node.exe）。零 npm 依赖（node:crypto + 全局 fetch）。
//
// 用法：
//   node scripts/verify-live-win.js [--port 47832] [--manifest-url <url>] [--data-dir <dir>]
//                                  [--daemon-src <daemon.js 路径>] [--timeout-ms 240000]
//
// 前置：
//   1. 已安装「假旧版」exe（fake-old-release.js 产出），daemon 正以旧版本运行
//   2. updates/latest/manifest-win.json 已指向新版本（publish-win.js --flip-latest）
//
// 全过 exit 0；任一失败 exit 1。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DEFAULT_BASE = 'https://kaypal.oss-cn-hangzhou.aliyuncs.com';

function parseArgs(argv) {
  const o = { port: 47832, timeoutMs: 240000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = parseInt(argv[++i], 10);
    else if (a === '--manifest-url') o.manifestUrl = argv[++i];
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--data-dir') o.dataDir = argv[++i];
    else if (a === '--daemon-src') o.daemonSrc = argv[++i];
    else if (a === '--profile') o.profile = argv[++i];
    else if (a === '--timeout-ms') o.timeoutMs = parseInt(argv[++i], 10);
  }
  return o;
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let API_TOKEN = null; // 从 dataDir/.api-token 读取（写 API 需要 X-JiuZhangAI-Token）
async function httpGet(url, timeoutMs = 15000, withToken = false) {
  const headers = {};
  if (withToken && API_TOKEN) headers['x-jiuzhangai-token'] = API_TOKEN;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
  return { status: res.status, body: await res.text() };
}

// 独立验签：从 daemon.js 提取固化公钥（信任根），对 sha256 hex digest 验 ed25519。
function extractPublicKeyPem(daemonSrc) {
  const envOverride = process.env.WBSWITCH_UPDATE_PUBKEY_PEM;
  if (envOverride) return envOverride;
  const m = /const UPDATE_PUBLIC_KEY_PEM = process\.env\.WBSWITCH_UPDATE_PUBKEY_PEM \|\| `([\s\S]*?)`;/.exec(daemonSrc);
  if (!m) return null;
  // m[1] 已含完整 PEM（-----BEGIN/END----- 都在反引号内），直接 trim 返回，
  // 不能再包一层 BEGIN/END，否则 crypto.createPublicKey 解析失败（DECODER unsupported）。
  return m[1].trim();
}

function verifySig(digestHex, sigB64, pubPem) {
  try {
    return crypto.verify(null, Buffer.from(digestHex, 'utf8'), crypto.createPublicKey(pubPem), Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function defaultManifestUrl(base) {
  return `${(base || DEFAULT_BASE).replace(/\/+$/, '')}/updates/latest/manifest-win.json`;
}

function resolveDaemonSrc(o) {
  if (o.daemonSrc && fs.existsSync(o.daemonSrc)) return o.daemonSrc;
  const candidates = [
    o.daemonSrc,
    path.join(ROOT, 'scripts', 'daemon.js'),
    // 2026-08-29 复核 P2：NSIS 安装目录已改 ASCII WorkDaddy（中文路径静默失败修复），
    // 候选同时保留旧中文目录（兼容历史装机）。
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'JiuZhangAI', 'daemon.js'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'JIUZHANG AI 管家', 'daemon.js'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function resolveDataDir(o) {
  if (o.dataDir) return o.dataDir;
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'JIUZHANG AI 管家');
}

function updatePrefix(o) {
  return o.profile === 'workbuddy-ai' ? 'JiuZhangAI-AI-' : 'JiuZhangAI-';
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const base = `http://127.0.0.1:${o.port}`;
  const manifestUrl = o.manifestUrl || defaultManifestUrl(o.base);
  const dataDir = resolveDataDir(o);
  // 2026-08-31 修复：写 API（download/apply）需 X-JiuZhangAI-Token（0.3.0 起鉴权），
  // 旧脚本不带 token → 下载被拒（未登录 API 无权限）→ E2E 假失败
  try {
    API_TOKEN = fs.readFileSync(path.join(dataDir, '.api-token'), 'utf8').trim();
    console.log(`[verify-live-win] api-token 已读取（${API_TOKEN ? API_TOKEN.length : 0} 字符）`);
  } catch { console.log('[verify-live-win] 警告：未找到 .api-token（写 API 将被拒）'); }
  const daemonSrc = resolveDaemonSrc(o);
  console.log(`[verify-live-win] port=${o.port} dataDir=${dataDir} manifest=${manifestUrl}\n`);

  // 0. 信任根：固化公钥
  const pubPem = daemonSrc ? extractPublicKeyPem(fs.readFileSync(daemonSrc, 'utf8')) : process.env.WBSWITCH_UPDATE_PUBKEY_PEM || null;
  check('ed25519 公钥可用', !!pubPem, pubPem ? '已从 daemon.js 提取' : '缺失（daemon-src 或 env）');

  // 1. daemon 就绪（旧版本在跑）
  let ready = false;
  let oldVersion = null;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await httpGet(`${base}/api/update-status`, 3000);
      const j = JSON.parse(r.body);
      if (r.status === 200 && j.version) { ready = true; oldVersion = j.version; break; }
    } catch {}
    await sleep(500);
  }
  check('daemon 就绪（旧版本在跑）', ready, ready ? `旧版本=${oldVersion}` : '30 次轮询未就绪');
  if (!ready) {
    console.log('[verify-live-win] 提示：若 daemon 未启动，可先跑安装目录内 launcher.cmd');
    process.exit(1);
  }

  // 2. 独立拉取 manifest-win.json 并校验字段
  let manifest = null;
  try {
    const r = await httpGet(manifestUrl, 15000);
    manifest = r.status === 200 ? JSON.parse(r.body) : null;
  } catch (_) {}
  check('manifest-win.json 拉取成功', !!manifest, manifestUrl);
  if (manifest) {
    check('manifest schema/platform', manifest.schema === 'release-manifest/v1' && manifest.platform === 'win', `platform=${manifest.platform}`);
    check('manifest sha256/签名齐全', /^[a-fA-F0-9]{64}$/.test(manifest.sha256 || '') && !!manifest.ed25519Signature, `size=${manifest.size}`);
  }
  const newVersion = manifest ? String(manifest.version || '').replace(/^v/, '') : null;

  // 3. 触发检查（force）→ 断言 hasUpdate
  let hasUpdate = false;
  try {
    const r = await httpGet(`${base}/api/update-check?force=1`, 20000);
    const j = JSON.parse(r.body);
    hasUpdate = !!(j && j.hasUpdate);
    check('检查更新 hasUpdate=true', hasUpdate, `latest=${j && j.latest}`);
  } catch (e) {
    check('检查更新 hasUpdate=true', false, e.message);
  }

  // 4. 触发下载 → 轮询 downloaded
  let downloaded = false;
  if (hasUpdate || manifest) {
    try { await httpGet(`${base}/api/update-download`, 15000, true); } catch (_) {}
    const dl = path.join(dataDir, 'update', `${updatePrefix(o)}${newVersion || 'x'}.exe`);
    for (let i = 0; i < 240; i++) {
      try {
        const r = await httpGet(`${base}/api/update-status`, 3000);
        const j = JSON.parse(r.body);
        if (j.downloaded) { downloaded = true; break; }
        if (j.status === 'error') break;
      } catch {}
      await sleep(1000);
    }
    check('安装包下载完成', downloaded, `target=${path.basename(dl)}`);
    // 4b. 独立校验：本地 exe SHA256 == manifest.sha256 + ed25519 验签（绕过 daemon 自身逻辑，交叉验证）
    if (downloaded && manifest && pubPem) {
      let local = null;
      const candidates = [
        path.join(dataDir, 'update', `${updatePrefix(o)}${newVersion}.exe`),
      ];
      for (const c of candidates) if (fs.existsSync(c)) { local = c; break; }
      if (local) {
        const localSha = sha256File(local);
        check('本地 exe SHA256 与 manifest 一致', localSha === manifest.sha256, `sha256=${localSha.slice(0, 12)}…`);
        check('本地 exe ed25519 验签通过', verifySig(manifest.sha256, manifest.ed25519Signature, pubPem), 'fail-closed 独立验签');
      } else {
        check('本地 exe 定位', false, '未找到下载产物');
      }
    }
  } else {
    check('安装包下载完成', false, '跳过（无更新）');
  }

  // 5. 触发安装（静默）→ daemon 自我退出 → apply-update.ps1 替换 → 重启
  let applied = false;
  if (downloaded) {
    try {
      const r = await httpGet(`${base}/api/update-apply`, 15000, true);
      applied = true;
      console.log(`  apply 返回: ${r.body.slice(0, 120)}`);
    } catch (_) {
      applied = true; // daemon 可能在响应前已退出
    }
    check('触发静默安装', applied, '已 POST /api/update-apply');
  } else {
    check('触发静默安装', false, '下载未完成，跳过');
  }

  // 6. 版本回升（daemon 重启后 /api/update-status.version 变为新版本）
  let upgraded = false;
  if (applied && newVersion) {
    const deadline = Date.now() + o.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await httpGet(`${base}/api/update-status`, 3000);
        const j = JSON.parse(r.body);
        if (j.version === newVersion) { upgraded = true; break; }
      } catch {}
      await sleep(2000);
    }
    check(`版本回升到 ${newVersion}`, upgraded, `旧=${oldVersion} → 新=${newVersion}`);
  } else if (newVersion) {
    check(`版本回升到 ${newVersion}`, false, '未触发安装');
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[verify-live-win] ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('[verify-live-win] 异常:', e.message);
  process.exit(1);
});
