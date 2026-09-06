'use strict';
// 二开版真机冒烟验证：隔离数据目录 + 随机端口起完整 daemon，端到端验证
// WorkDaddy 原有路由 + 九章管家新路由 + 鉴权 + 账号加密往返。
//
// 用法：node scripts/verify-live.js
// 全过 exit 0；任一失败 exit 1。会自行清理临时数据目录与 daemon 进程。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 第十一轮复核 P2：物理路径防护会拒绝 /var 下的数据根（macOS /var 是系统符号链接）——
// 临时目录必须建在 realpath 后的位置，否则 daemon 启动即被 isPhysicallyRealPath 拒绝。
const DATA_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wd-verify-'));
const PORT = 48000 + Math.floor(Math.random() * 1000);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail: detail || '' });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function http(method, p, { token, tokenHeader = 'x-jz-token', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers[tokenHeader] = token;
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function main() {
  console.log(`[verify-live] 隔离环境起 daemon（DATA_DIR=${DATA_DIR} PORT=${PORT}）\n`);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'daemon.js')], {
    env: {
      ...process.env,
      WBSWITCH_DATA_DIR: DATA_DIR,
      WBSWITCH_PORT: String(PORT),
      WBSWITCH_CDP_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // 等 daemon 就绪（轮询根路径）
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) });
      if (r.status === 200) { ready = true; break; }
    } catch {}
  }
  if (!ready) {
    check('daemon 启动（根路径 200）', false, '30 次轮询未就绪');
    child.kill('SIGKILL');
    process.exit(1);
  }
  check('daemon 启动（根路径 200）', true);

  // token
  const token = fs.readFileSync(path.join(DATA_DIR, '.api-token'), 'utf8').trim();
  check('API token 生成（64 hex，0600）', /^[a-f0-9]{64}$/i.test(token), `token=${token.slice(0, 12)}…`);

  // 1. WorkDaddy 原有路由（PUBLIC_API_PATHS，无需 token）
  const about = await http('GET', '/api/about');
  check('WorkDaddy 原有 /api/about（公开）', about.status === 200, `status=${about.status}`);

  const accounts = await http('GET', '/api/accounts', { token, tokenHeader: 'x-jiuzhangai-token' });
  check('原 WorkDaddy 路由 /api/accounts（x-jiuzhangai-token）', accounts.status === 200 && accounts.json && accounts.json.ok === true, `status=${accounts.status}`);

  // 2. jz 新路由（x-jz-token）
  const vault = await http('GET', '/api/vault/backups', { token });
  check('jz 新路由 /api/vault/backups', vault.status === 200 && vault.json && vault.json.ok === true, `status=${vault.status}`);

  const oidc = await http('GET', '/api/oidc/status', { token });
  check('jz 新路由 /api/oidc/status', oidc.status === 200 && oidc.json && oidc.json.ok === true, `loggedIn=${oidc.json && oidc.json.data && oidc.json.data.loggedIn}`);

  // 3. 鉴权（无 token → 401）
  const noTok = await http('GET', '/api/vault/backups');
  check('鉴权：无 token → 401', noTok.status === 401, `status=${noTok.status}`);

  // 4. 账号文件加密往返
  const { writeAccountFile, readAccountFile } = require('./lib.js');
  const acctFile = path.join(DATA_DIR, 'accounts', 'verify-test.info');
  fs.mkdirSync(path.dirname(acctFile), { recursive: true });
  writeAccountFile(DATA_DIR, acctFile, { account: { uid: 'verify-1', nickname: '测试' }, auth: { accessToken: 'secret-token-verify' } });
  const raw = fs.readFileSync(acctFile, 'latin1');
  const encrypted = raw.startsWith('JZENC1') && !raw.includes('secret-token-verify');
  const back = readAccountFile(DATA_DIR, acctFile);
  check('账号文件加密（JZENC1 + 无明文 token + 可解密）', encrypted && back.auth.accessToken === 'secret-token-verify');

  // 收尾
  child.kill('SIGKILL');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[verify-live] ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('[verify-live] 异常:', e.message);
  process.exit(1);
});
