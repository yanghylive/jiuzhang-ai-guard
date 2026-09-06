'use strict';
// 发版门禁：双通道公开可读校验（win manifest-win.json + mac manifest.json + 安装包 URL 都 200）。
// 零依赖（node:https），等价 curl 校验；字段完整性：schema/version/sha256/ed25519Signature 齐全、win size>0。
//
// 用法：
//   node scripts/verify-release.js [--base https://kaypal.oss-cn-hangzhou.aliyuncs.com]
//                                  [--version x.y.z]（可选：额外校验 updates/<version>/ 版本化对象）
//
// 校验项（全过 exit 0；任一失败 exit 1）：
//   1. updates/latest/manifest.json         （mac 通道，零回归）
//   2. updates/latest/manifest-win.json     （win 通道，新增）
//   3. 两个 manifest 各自指向的安装包 URL 公开可读（Range 探测，200/206）
const https = require('node:https');
const http = require('node:http');

const DEFAULT_BASE = 'https://kaypal.oss-cn-hangzhou.aliyuncs.com';

function parseArgs(argv) {
  const o = { base: DEFAULT_BASE, version: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '--version') o.version = argv[++i];
  }
  return o;
}

function httpGet(url, { ranged = false, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const headers = { 'User-Agent': 'JiuZhangAI-verify/1' };
    if (ranged) headers.Range = 'bytes=0-0';
    const req = mod.get(url, { headers }, (res) => {
      if (ranged) {
        // 只探可读性，不下载完整安装包（几十 MB）
        const status = res.statusCode;
        const length = res.headers['content-length'] || null;
        res.destroy();
        return resolve({ status, body: '', contentLength: length });
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

function isHex64(s) {
  return /^[a-fA-F0-9]{64}$/.test(String(s || '').trim());
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const base = o.base.replace(/\/+$/, '');
  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail: detail || '' });
    console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  const manifests = [
    {
      label: 'mac 通道 manifest.json',
      url: `${base}/updates/latest/manifest.json`,
      expectPlatform: 'mac',
      expectSize: false,
    },
    {
      label: 'win 通道 manifest-win.json',
      url: `${base}/updates/latest/manifest-win.json`,
      expectPlatform: 'win',
      expectSize: true,
    },
  ];

  for (const mf of manifests) {
    let res;
    try {
      res = await httpGet(mf.url);
    } catch (e) {
      check(mf.label, false, `请求失败: ${e.message}`);
      continue;
    }
    check(`${mf.label} 公开可读 200`, res.status === 200, `status=${res.status}`);
    let m = null;
    try { m = JSON.parse(res.body); } catch (_) {}
    check(`${mf.label} JSON 可解析`, !!m, m ? '' : `body=${res.body.slice(0, 80)}`);
    if (!m) continue;
    check(`${mf.label} schema 正确`, m.schema === 'release-manifest/v1', `schema=${m.schema}`);
    check(`${mf.label} 版本号非空`, !!m.version, `version=${m.version}`);
    if (mf.expectPlatform) {
      check(`${mf.label} platform=${mf.expectPlatform}`, m.platform === mf.expectPlatform, `platform=${m.platform}`);
    }
    check(`${mf.label} sha256 为 64hex`, isHex64(m.sha256), `sha256=${(m.sha256 || '').slice(0, 12)}…`);
    check(`${mf.label} ed25519Signature 非空`, !!m.ed25519Signature, `sig=${(m.ed25519Signature || '').slice(0, 12)}…`);
    if (mf.expectSize) {
      check(`${mf.label} size>0`, Number(m.size) > 0, `size=${m.size}`);
    }
    // 安装包公开可读（Range 探测，200/206 均可）
    if (m.version && m.file) {
      const pkgUrl = `${base}/updates/${m.version}/${m.file}`;
      try {
        const p = await httpGet(pkgUrl, { ranged: true });
        check(`${mf.label} 安装包公开可读`, p.status === 200 || p.status === 206, `${m.file} status=${p.status}`);
      } catch (e) {
        check(`${mf.label} 安装包公开可读`, false, `${m.file} 请求失败: ${e.message}`);
      }
      // 2026-08-31 修复：daemon 主通道下载的是 updates/latest/<file>——只查版本化包
      // 会漏掉"latest 缺包 → 客户端升级 404"（0.3.1 真机 E2E 抓出）。latest 包必须也在。
      const latestPkgUrl = `${base}/updates/latest/${m.file}`;
      try {
        const p = await httpGet(latestPkgUrl, { ranged: true });
        check(`${mf.label} latest 安装包公开可读`, p.status === 200 || p.status === 206, `latest/${m.file} status=${p.status}`);
      } catch (e) {
        check(`${mf.label} latest 安装包公开可读`, false, `latest/${m.file} 请求失败: ${e.message}`);
      }
    }
  }

  // 可选：校验版本化 manifest 对象（--version）
  if (o.version) {
    for (const name of ['manifest.json', 'manifest-win.json']) {
      const url = `${base}/updates/${o.version}/${name}`;
      try {
        const res = await httpGet(url);
        check(`版本化 ${name} 公开可读`, res.status === 200, `updates/${o.version}/${name} status=${res.status}`);
      } catch (e) {
        check(`版本化 ${name} 公开可读`, false, e.message);
      }
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[verify-release] ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('[verify-release] 异常:', e.message);
  process.exit(1);
});
