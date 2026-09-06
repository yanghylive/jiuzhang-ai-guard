'use strict';
// 健康检查器（03 §2.1 / §3）。只读、评分、不自动修改状态。前一层失败则后层 not_checked，不误报。
// 真实化（2026-08-25）：daemon 层验日志心跳、inject 层 CDP 读 .wbs-root 真实 DOM（清 stub）、version 层报告真实版本。
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { uuid, dataRoot, ensureDataRoot } = require('./lib');
const { detectProfiles } = require('./profiles');
const { discoverTargets, buildDevtoolsWsUrl, CDPChannel } = require('./cdp-targets');

// 体检规则执行顺序（03 §3）。2026-08-28 扩展：+network/update/disk/crash/injectver/autostart/tokenperm/portbind/logsize
// （产品负责人拍板「都要」：覆盖 WorkBuddy 使用相关度——网络联机/更新链路/磁盘/崩溃/注入一致性/自启/token 权限/端口暴露/日志体积）
// 2026-08-29：+backup（备份完整性真实化——daemon auto-backup 每日，最新 manifest <24h 视为健康），17 层与前端 checkNames 对齐。
const RULE_ORDER = [
  'process', 'daemon', 'cdp', 'profile', 'inject', 'data', 'backup', 'version',
  'network', 'update', 'disk', 'crash', 'injectver', 'autostart', 'tokenperm', 'portbind', 'logsize',
];

// daemon 心跳判定：daemon.log 最近写入 < HEARTBEAT_MS 视为存活（daemon 持续滚动日志）。
const HEARTBEAT_MS = 5 * 60 * 1000;

// ---- 工具 ----
const IS_WIN = process.platform === 'win32';
const DISK_LOW_BYTES = 2 * 1024 * 1024 * 1024; // < 2GB 告警
const LOG_BLOAT_BYTES = 50 * 1024 * 1024; // 日志 > 50MB 告警
const CRASH_LOOKBACK_DAYS = 7;
const OSS_BASE = 'https://kaypal.oss-cn-hangzhou.aliyuncs.com';
const GATEWAY_BASE = 'https://kaypal.cn';

// 与 daemon.js platformManifestUrl() 同构：env 可整体覆盖（测试/内网），win 读 manifest-win.json。
function manifestUrl() {
  const base = process.env.WBSWITCH_UPDATE_MANIFEST_URL ||
    `${OSS_BASE}/updates/latest/manifest.json`;
  return IS_WIN ? base.replace(/\/manifest\.json$/, '/manifest-win.json') : base;
}

function probeUrl(url, method = 'GET', timeoutMs = 4000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.request(url, { method, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, code: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, code: e.code || e.message }));
    req.end();
  });
}

function fetchJson(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ ok: false, error: 'bad json' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

function diskFreeBytes(rootPath) {
  try {
    const st = fs.statfsSync(rootPath);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

function countRecentFiles(dir, pattern, days) {
  try {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - days * 86400000;
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      if (pattern.test(f)) {
        try {
          if (fs.statSync(path.join(dir, f)).mtimeMs > cutoff) n++;
        } catch {
          /* ignore */
        }
      }
    }
    return n;
  } catch {
    return -1; // 目录不可读 → unknown
  }
}

function dirSizeBytes(p) {
  try {
    let s = 0;
    for (const f of fs.readdirSync(p)) {
      try { s += fs.statSync(path.join(p, f)).size; } catch { /* ignore */ }
    }
    return s;
  } catch {
    return 0;
  }
}

// semver 数值比较：a > b 返回 1，相等 0，a < b 返回 -1（字符串比较在 0.2.10 vs 0.2.6 时误判）
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function logBytes(rootPath) {
  let s = 0;
  try { s += fs.statSync(path.join(rootPath, 'daemon.log')).size; } catch { /* ignore */ }
  s += dirSizeBytes(path.join(rootPath, 'error-reports'));
  return s;
}

function netstatListen(port) {
  return new Promise((resolve) => {
    const args = IS_WIN ? ['-an'] : ['-an', '-p', 'tcp'];
    execFile('netstat', args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const hits = [];
      for (const ln of String(stdout).split('\n')) {
        // macOS/BSD 是点分格式 127.0.0.1.47832，Windows 是冒号格式 127.0.0.1:47832
        if (!ln.includes(':' + port) && !ln.includes('.' + port)) continue;
        if (!/LISTEN/i.test(ln)) continue;
        const parts = ln.trim().split(/\s+/);
        const local = IS_WIN ? parts[1] : parts[3];
        if (local) hits.push(local);
      }
      resolve(hits);
    });
  });
}

function regQueryRunKey() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'],
      { timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        // 安装器/install.ps1 写入的键名为 ASCII "WorkDaddyWatchdog"（GBK 代码页下中文匹配不可靠，故按 ASCII 键名判定）
        resolve(/JiuZhangAIWatchdog|JiuZhangAI|Watchdog|JIUZHANG/i.test(String(stdout)));
      });
  });
}

function severityDelta(sev) {
  if (sev === 'critical') return 40;
  if (sev === 'high') return 20;
  if (sev === 'medium') return 10;
  if (sev === 'low') return 3;
  if (sev === 'info') return 0;
  return 0;
}

async function runHealthCheck({ profile, deep = false, root, discover, WebSocketImpl } = {}) {
  const checkId = uuid();
  const startedAt = new Date().toISOString();
  const findings = [];
  let score = 100;
  let cdpPort = null;
  root = root || dataRoot();

  const add = (code, severity, evidence, repairable, requiresPro = false) => {
    findings.push({
      code,
      severity,
      evidence: typeof evidence === 'string' ? evidence : '[redacted]',
      repairable: !!repairable,
      requiresPro,
    });
    score -= severityDelta(severity);
  };

  // 1. 进程/平台环境（真实：platform/arch/node 版本）
  add('ENV_OK', 'info', `platform=${os.platform()} arch=${os.arch()} node=${process.version}`, false);

  // 2. daemon 生命周期（真实：心跳文件 mtime，不凭「daemon running」字符串假 pass）
  try {
    const logPath = path.join(root, 'daemon.log');
    if (fs.existsSync(logPath)) {
      const age = Date.now() - fs.statSync(logPath).mtimeMs;
      if (age < HEARTBEAT_MS) {
        add('DAEMON_OK', 'info', `heartbeat ${Math.round(age / 1000)}s ago`, false);
      } else {
        add('DAEMON_STALE', 'high', `daemon.log idle ${Math.round(age / 1000)}s (>5min)`, true);
      }
    } else {
      add('DAEMON_LOG_MISSING', 'high', `no daemon.log at ${logPath}`, true);
    }
  } catch (e) {
    add('DAEMON_CHECK_FAILED', 'high', `cannot stat daemon.log: ${e.message}`, true);
  }

  // 3. CDP 连接。端口由发现流程确定（候选 9222/9223/9333 或 JZ_CDP_PORT），不硬编码单一端口。
  const targets = await (discover || discoverTargets)();
  let cdpSkip = false;
  if (!targets.ok) {
    add('CDP_UNAVAILABLE', 'high', `no WorkBuddy CDP endpoint on ports ${(targets.triedPorts || []).join('/')}`, true);
    cdpSkip = true;
    // 仅 profile/inject 依赖 CDP；data/version 与 CDP 无关，下方无条件真实执行（不假报 NOT_CHECKED）
    for (const layer of ['profile', 'inject']) {
      add(`NOT_CHECKED_${layer.toUpperCase()}`, 'info', 'blocked by CDP_UNAVAILABLE', false);
    }
  } else {
    cdpPort = targets.port;
    add('CDP_OK', 'info', `port=${targets.port} targets=${targets.targets.length}`, true);
  }

  if (!cdpSkip) {
    // 4. profile 与目标匹配（真实：本机已装 profile 探测）
    const detected = detectProfiles();
    if (profile && !detected.includes(profile)) {
      add('PROFILE_MISMATCH', 'medium', `selected=${profile} detected=${detected.join(',') || 'none'}`, true);
    } else {
      add('PROFILE_OK', 'info', `profile=${profile || 'auto'} detected=${detected.join(',') || 'none'}`, false);
    }

    // 5. 注入根节点 + 注入版本一致性（真实：CDP 只读读 window.__wbsWidget + .wbs-root DOM + __wbsVersion）
    await checkInject(targets, add, WebSocketImpl);
  }

  // 6. 数据目录与备份完整性 —— 与 CDP 无关，无条件执行（复查 P1：用调用方传入的 root，
  //    不得落到默认 dataRoot()；此前放在 !cdpSkip 分支里，CDP 不可用时连数据目录都不查）
  try {
    ensureDataRoot(root);
    add('DATA_OK', 'info', 'data dir ok', false);
  } catch {
    add('DATA_ERROR', 'high', 'cannot init data dir', true);
  }

  // 6.5 备份完整性（真实：backups/manifests 最新备份 <24h；daemon auto-backup 每日执行）
  try {
    const bmDir = path.join(root, 'backups', 'manifests');
    if (fs.existsSync(bmDir)) {
      const files = fs.readdirSync(bmDir).filter((f) => f.endsWith('.json'));
      if (!files.length) {
        add('BACKUP_MISSING', 'medium', 'no backup manifests yet', false);
      } else {
        let newest = 0;
        for (const f of files) {
          try { newest = Math.max(newest, fs.statSync(path.join(bmDir, f)).mtimeMs); } catch { /* ignore */ }
        }
        const ageH = (Date.now() - newest) / 3600000;
        if (ageH < 24) {
          add('BACKUP_OK', 'info', `newest ${Math.max(1, Math.round(ageH))}h ago`, false);
        } else {
          add('BACKUP_STALE', 'medium', `newest backup ${Math.round(ageH)}h ago (>24h)`, false);
        }
      }
    } else {
      add('BACKUP_MISSING', 'medium', 'no backups dir', false);
    }
  } catch (e) {
    add('BACKUP_CHECK_FAILED', 'medium', `backup check error: ${e.message}`, true);
  }

  // 7. 版本兼容性（真实：报告 daemon 版本；未知版本 warn 而非无条件 compatible）
  const ver = process.env.JZ_WB_VERSION || process.env.JZ_VERSION || null;
  if (ver) {
    add('VERSION_OK', 'info', `daemon ${ver}`, false);
  } else {
    add('VERSION_UNKNOWN', 'medium', 'daemon version unknown (env not injected)', true);
  }

  // 8. 网络联机（真实：https 探活更新通道 + 模型网关；与 CDP 无关，CDP 挂了也照查）
  try {
    const [up, gw] = await Promise.all([probeUrl(manifestUrl()), probeUrl(`${GATEWAY_BASE}/`, 'GET', 4000)]);
    if (up.ok && gw.ok) {
      add('NETWORK_OK', 'info', `updates ${up.code} · gateway ${gw.code}`, false);
    } else {
      const bad = [];
      if (!up.ok) bad.push(`updates:${up.code}`);
      if (!gw.ok) bad.push(`gateway:${gw.code}`);
      add('NETWORK_DOWN', 'high', `${bad.join(' ')} unreachable`, false);
    }
  } catch (e) {
    add('NETWORK_CHECK_FAILED', 'medium', `network probe error: ${e.message}`, false);
  }

  // 9. 更新链路健康（真实：拉 latest manifest 解析 version，与当前 daemon 版本比较）
  try {
    const m = await fetchJson(manifestUrl());
    const cur = process.env.JZ_WB_VERSION || process.env.JZ_VERSION || null;
    if (!m.ok) {
      add('UPDATE_CHANNEL_DOWN', 'medium', `manifest fetch failed: ${m.error}`, false);
    } else if (!cur || !m.json || !m.json.version) {
      add('UPDATE_UNKNOWN', 'info', 'current version unknown', false);
    } else {
      const latest = String(m.json.version);
      // semver 数值比较（字符串比较在 0.2.10 vs 0.2.6 时会误判）
      const cmp = compareVersions(latest, cur);
      if (cmp === 0) {
        add('UPDATE_OK', 'info', `v${cur} is latest`, false);
      } else if (cmp > 0) {
        add('UPDATE_STALE', 'medium', `v${cur} < latest v${latest}`, false);
      } else {
        add('UPDATE_AHEAD', 'info', `v${cur} > channel v${latest} (test build)`, false);
      }
    }
  } catch (e) {
    add('UPDATE_CHECK_FAILED', 'medium', `update check error: ${e.message}`, false);
  }

  // 10. 磁盘空间（真实：fs.statfs 数据目录所在盘剩余）
  try {
    const free = diskFreeBytes(root);
    if (free === null) {
      add('DISK_UNKNOWN', 'info', 'statfs unavailable', false);
    } else if (free < DISK_LOW_BYTES) {
      add('DISK_LOW', 'high', `free ${(free / 1024 / 1024 / 1024).toFixed(1)}GB < 2GB`, true);
    } else {
      add('DISK_OK', 'info', `free ${(free / 1024 / 1024 / 1024).toFixed(1)}GB`, false);
    }
  } catch (e) {
    add('DISK_CHECK_FAILED', 'medium', `disk check error: ${e.message}`, true);
  }

  // 11. 崩溃历史（近 7 天 WorkBuddy 崩溃记录；macOS DiagnosticReports / Windows CrashDumps）
  try {
    const crashDir = IS_WIN
      ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'CrashDumps')
      : path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
    const n = countRecentFiles(crashDir, /workbuddy/i, CRASH_LOOKBACK_DAYS);
    if (n < 0) {
      add('CRASH_UNKNOWN', 'info', `cannot read ${crashDir}`, false);
    } else if (n > 0) {
      add('CRASH_HISTORY', 'medium', `${n} crash record(s) in ${CRASH_LOOKBACK_DAYS}d`, false);
    } else {
      add('CRASH_OK', 'info', 'no crash in last 7d', false);
    }
  } catch (e) {
    add('CRASH_CHECK_FAILED', 'medium', `crash check error: ${e.message}`, false);
  }

  // 12. 注入版本一致性 —— 已并入 checkInject（见 INJECT_VER_*）

  // 13. 开机自启（macOS launchd plist / Windows HKCU Run）
  try {
    if (IS_WIN) {
      const ok = await regQueryRunKey();
      if (ok === null) {
        add('AUTOSTART_UNKNOWN', 'info', 'reg query unavailable', false);
      } else if (ok) {
        add('AUTOSTART_OK', 'info', 'HKCU Run entry present', false);
      } else {
        add('AUTOSTART_MISSING', 'medium', 'no HKCU Run entry', true);
      }
    } else {
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.workbuddy.workdaddy.workbuddy-cn.plist');
      if (fs.existsSync(plist)) {
        add('AUTOSTART_OK', 'info', 'launchd plist present', false);
      } else {
        add('AUTOSTART_MISSING', 'medium', 'launchd plist missing', true);
      }
    }
  } catch (e) {
    add('AUTOSTART_CHECK_FAILED', 'medium', `autostart check error: ${e.message}`, false);
  }

  // 14. token 文件权限（非 Windows：要求非 group/other 可读）
  try {
    const tok = path.join(root, '.api-token');
    if (!IS_WIN && fs.existsSync(tok)) {
      const mode = fs.statSync(tok).mode & 0o777;
      if ((mode & 0o077) === 0) {
        add('TOKEN_PERM_OK', 'info', `mode ${mode.toString(8)}`, false);
      } else {
        add('TOKEN_PERM_LOOSE', 'medium', `mode ${mode.toString(8)} (group/other readable)`, true);
      }
    } else if (!IS_WIN) {
      add('TOKEN_PERM_UNKNOWN', 'info', 'no .api-token', false);
    } else {
      add('TOKEN_PERM_OK', 'info', 'n/a on win32', false);
    }
  } catch (e) {
    add('TOKEN_PERM_CHECK_FAILED', 'medium', `token perm check error: ${e.message}`, true);
  }

  // 15. 端口绑定（daemon 端口只监听 127.0.0.1，防局域网暴露）
  try {
    const port = process.env.WBSWITCH_PORT || '47832';
    const locals = await netstatListen(port);
    if (!locals || !locals.length) {
      add('PORT_BIND_UNKNOWN', 'info', `no LISTEN entry for :${port}`, false);
    } else {
      // 暴露判定：0.0.0.0 / :: / [::] / * 均视为非 loopback（IPv6 全接口 [::]:port 也要抓）
      const exposed = locals.filter((l) => /^(0\.0\.0\.0|\[?::\]?|\*)/.test(l.trim()));
      if (exposed.length) {
        add('PORT_EXPOSED', 'high', `:${port} bound on ${exposed.join(',')}`, true);
      } else {
        add('PORT_BIND_OK', 'info', `:${port} loopback only (${locals.join(',')})`, false);
      }
    }
  } catch (e) {
    add('PORT_BIND_CHECK_FAILED', 'medium', `port bind check error: ${e.message}`, false);
  }

  // 16. 日志体积（daemon.log + error-reports 总量 > 50MB 告警，联动清理）
  try {
    const bytes = logBytes(root);
    if (bytes > LOG_BLOAT_BYTES) {
      add('LOG_BLOAT', 'medium', `${(bytes / 1024 / 1024).toFixed(0)}MB logs (daemon.log+error-reports)`, true);
    } else {
      add('LOG_OK', 'info', `${(bytes / 1024 / 1024).toFixed(1)}MB logs`, false);
    }
  } catch (e) {
    add('LOG_CHECK_FAILED', 'medium', `log size check error: ${e.message}`, true);
  }

  function finalize() {
    score = Math.max(0, Math.min(100, score));
    const status = score >= 90 ? 'healthy' : score >= 70 ? 'attention' : score >= 40 ? 'error' : 'blocked';
    return {
      checkId,
      score,
      status,
      findings,
      client: 'WorkBuddy',
      cdpPort, // 已确认端口，供 DevTools 代理等下游复用（禁止下游再硬编码）
      profile: profile || 'auto',
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  return finalize();
}

// CDP 只读检查注入状态：window.__wbsWidget 存在 + .wbs-root 挂载（真实 DOM 证据，不再 stub）。
async function checkInject(targets, add, WebSocketImpl) {
  let channel = null;
  try {
    const t = (targets.targets || []).find((x) => x && x.type === 'page') || (targets.targets || [])[0];
    if (!t) throw new Error('no page target');
    const ws = buildDevtoolsWsUrl({ port: targets.port, targetId: t.id, targets: targets.targets });
    if (!ws.ok) throw new Error(ws.reason || 'ws build failed');
    channel = new CDPChannel({ wsUrl: ws.wsUrl, WebSocketImpl });
    await channel.connect({ wsUrl: ws.wsUrl });
    const r = await channel.send('Runtime.evaluate', {
      expression:
        '(function(){try{var w=window.__wbsWidget||null;var root=document.querySelector(".wbs-root");var v=window.__wbsVersion||null;return JSON.stringify({hasWidget:!!w,root:!!(root&&root.isConnected),ver:v});}catch(e){return JSON.stringify({error:String(e)})}})()',
      returnByValue: true,
    });
    if (!r.ok) throw new Error('evaluate failed');
    let st;
    try {
      st = JSON.parse(r.result && r.result.result && r.result.result.value);
    } catch {
      throw new Error('unparseable inject state');
    }
    if (st.error) throw new Error(st.error);
    if (st.hasWidget && st.root) {
      add('INJECT_OK', 'info', 'widget + .wbs-root mounted', false);
    } else if (st.hasWidget) {
      add('INJECT_PARTIAL', 'medium', 'widget present but .wbs-root not mounted', true);
    } else {
      add('INJECT_MISSING', 'high', 'widget not injected into renderer', true);
    }
    // 注入版本一致性（2026-08-28）：daemon 注入时挂 window.__wbsVersion，与当前 daemon 版本比对。
    // 防「旧脚本快照」事故（Mac 本机曾因 0.1.4 旧快照导致面板功能全旧）。
    const cur = process.env.JZ_WB_VERSION || process.env.JZ_VERSION || null;
    if (st.ver && cur) {
      if (String(st.ver) === String(cur)) {
        add('INJECT_VER_OK', 'info', `inject v${st.ver} = daemon v${cur}`, false);
      } else {
        add('INJECT_VER_MISMATCH', 'medium', `inject v${st.ver} != daemon v${cur}`, true);
      }
    } else if (!st.ver) {
      add('INJECT_VER_UNKNOWN', 'info', 'injected script carries no version (legacy inject)', false);
    }
  } catch (e) {
    add('INJECT_CHECK_FAILED', 'medium', `cannot verify inject: ${e.message}`, true);
  } finally {
    if (channel) {
      try {
        channel.close();
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { runHealthCheck, RULE_ORDER };
