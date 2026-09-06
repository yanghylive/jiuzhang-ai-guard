'use strict';
// 二开版安全门禁：正向断言 6 条 P1 防护在位，防未来改动把防护改掉（回归卡点）。
// 替代原净室版 lint-security.js（负面清单不适用 WorkDaddy 历史代码，会误报其固有
// powershell/osascript 更新逻辑）。
//
// 设计：每条 P1 = 「正向模式必须在」+「负向模式必须不在（可选作用域）」。
// 用法：node scripts/security-gate.js   （有违例 exit 1）；test/test-security-gate.js 纳入 npm test。
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;

function read(name) {
  try {
    return fs.readFileSync(path.join(DIR, name), 'utf8');
  } catch {
    return '';
  }
}

// 提取函数体（从 `function 名` 到下一个顶层 `\n}`）。
function fnBody(src, name) {
  const m = new RegExp('function ' + name + '[\\s\\S]*?\\n\\}').exec(src);
  return m ? m[0] : '';
}

function audit() {
  const lib = read('lib.js');
  const daemon = read('daemon.js');
  const devtoolsOriginFn = fnBody(daemon, 'isAllowedDevtoolsOrigin');
  const publicPathsMatch = /PUBLIC_API_PATHS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(daemon);
  const publicPaths = publicPathsMatch ? publicPathsMatch[1] : '';

  const checks = [
    {
      id: 'P1-1 UID 路径穿越',
      pass:
        /function validateUid/.test(lib) &&
        /includes\('\/'\)/.test(lib) &&
        /includes\('\\\\'\)/.test(lib) &&
        /includes\('\\0'\)/.test(lib),
      detail: 'lib.js validateUid 必须拒绝 / \\ 空字符与 ..（backupPath 父目录约束）',
    },
    {
      id: 'P1-2 明文 token 加密',
      pass:
        /ENC_MAGIC = 'JZENC1'/.test(lib) &&
        /aes-256-gcm/.test(lib) &&
        /function writeAccountFile/.test(lib) &&
        /function readAccountFile/.test(lib),
      detail: '账号文件必须 AES-256-GCM 加密（JZENC1 magic），读写走加密函数',
    },
    {
      id: 'P1-3 请求体上限',
      pass: /MAX_BODY_BYTES\s*=\s*256\s*\*\s*1024/.test(daemon) && /BODY_TIMEOUT_MS/.test(daemon),
      detail: 'readBody 必须 256KB 上限 + 超时，防无限累积/悬挂',
    },
    {
      id: 'P1-4 更新签名',
      pass:
        /function verifyUpdateSignature/.test(daemon) &&
        /UPDATE_PUBLIC_KEY_PEM/.test(daemon) &&
        /ed25519/.test(daemon) &&
        !/-noverify/.test(daemon),
      detail: '更新必须 ed25519 验签，且无 -noverify（镜像校验必须生效）',
    },
    {
      id: 'P1-5 DevTools 空 Origin 不放行',
      pass:
        /if \(!origin\) return false/.test(devtoolsOriginFn) &&
        !/if \(!origin\) return true/.test(devtoolsOriginFn),
      detail: 'DevTools 代理空 Origin 不放行（升级处用 token 单独校验本地客户端）',
    },
    {
      id: 'P1-6 inject 空 Origin 无 token 旁路已移除',
      pass:
        /function isApiRequestAuthorized/.test(daemon) &&
        /PUBLIC_API_PATHS/.test(daemon) &&
        !publicPaths.includes('/api/inject') &&
        !publicPaths.includes('/api/breadcrumb'),
      detail: '/api/inject、/api/breadcrumb 不得在公开白名单（必须 token）',
    },
  ];

  return checks;
}

if (require.main === module) {
  const checks = audit();
  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    process.stderr.write(`[security-gate] ${failed.length}/${checks.length} 条 P1 防护缺失：\n`);
    for (const c of failed) {
      process.stderr.write(`  [${c.id}] ${c.detail}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`[security-gate] PASS：${checks.length}/${checks.length} 条 P1 防护在位\n`);
  process.exit(0);
}

module.exports = { audit };
