'use strict';
// 兼容性探针（03 §2.4）。只读、不调用 WorkBuddy 私有 RPC、不修改渲染状态。
// DoD：版本/profile/平台/探针结果/能力状态；国内版/国际版 profile 矩阵；不凭版本号承诺支持。
//
// 探针设计（每项都有真实证据，不再 [redacted] 恒 pass）：
//   - cdp-reachable    : DevTools 目标发现是否成功（真实端口 + 目标数）
//   - inject-state     : 通过 CDP 读渲染进程 window.__wbsWidget 状态（真实 DOM/脚本证据，非目标存在性推断）
//   - version-probe    : daemon 版本 / 平台 / 架构（env 注入，证据如实返回）
//   - profile-matrix   : 本机已安装 profile 探测（国内版/国际版矩阵）
const { discoverTargets, buildDevtoolsWsUrl, CDPChannel } = require('./cdp-targets');
const { getProfile, detectProfiles, listProfiles } = require('./profiles');

const PROBES = [
  {
    id: 'cdp-reachable',
    check: async ({ targets }) => {
      if (!targets || !targets.ok) return { status: 'fail', evidence: 'CDP_UNAVAILABLE' };
      const pages = (targets.targets || []).filter((t) => t && t.type === 'page');
      return {
        status: pages.length ? 'pass' : 'warn',
        evidence: `port=${targets.port} targets=${(targets.targets || []).length} pages=${pages.length}`,
      };
    },
  },
  {
    id: 'inject-state',
    check: async ({ channel }) => {
      if (!channel || !channel.connected) return { status: 'unknown', evidence: 'CDP not connected' };
      const r = await channel.send('Runtime.evaluate', {
        expression:
          '(function(){try{var w=window.__wbsWidget||null;var root=document.querySelector(".wbs-root");return JSON.stringify({hasWidget:!!w,root:!!(root&&root.isConnected),version:(w&&w.version)||null});}catch(e){return JSON.stringify({error:String(e)})}})()',
        returnByValue: true,
      });
      if (!r.ok) return { status: 'unknown', evidence: 'evaluate failed' };
      let state;
      try {
        state = JSON.parse(r.result && r.result.result && r.result.result.value);
      } catch {
        return { status: 'unknown', evidence: 'unparseable' };
      }
      if (state.error) return { status: 'fail', evidence: state.error };
      return {
        status: state.hasWidget && state.root ? 'pass' : 'warn',
        evidence: `widget=${!!state.hasWidget} root=${!!state.root} version=${state.version || 'n/a'}`,
      };
    },
  },
  {
    id: 'version-probe',
    check: async () => {
      const v = process.env.JZ_VERSION || process.env.JZ_WB_VERSION || 'unknown';
      return {
        status: v !== 'unknown' ? 'pass' : 'warn',
        evidence: `daemon=${v} platform=${process.platform}/${process.arch} node=${process.version}`,
      };
    },
  },
  {
    id: 'profile-matrix',
    check: async ({ profile, detected }) => {
      const want = profile || 'workbuddy-cn';
      const installed = detected && detected.includes(want);
      return {
        status: installed ? 'pass' : 'warn',
        evidence: `target=${want} installed=${installed ? 'yes' : 'no'} matrix=${(detected || []).join(',') || 'none'}`,
      };
    },
  },
];

async function runProbe(probe, ctx) {
  try {
    const r = await probe.check(ctx);
    return { id: probe.id, profile: probe.profile || ctx.profile || null, status: r.status, evidence: r.evidence || '' };
  } catch (e) {
    return { id: probe.id, profile: probe.profile || ctx.profile || null, status: 'unknown', evidence: String((e && e.message) || e) };
  }
}

async function checkCompatibility({ profile, discover, WebSocketImpl } = {}) {
  const p = getProfile(profile) || { id: profile || 'unknown' };
  const detected = detectProfiles();
  // 优先 daemon 已确认端口（JZ_CDP_PORT，注入目标对齐）；失败回退默认候选端口扫描
  const envPort = process.env.JZ_CDP_PORT ? Number(process.env.JZ_CDP_PORT) : null;
  const targets = await (discover || discoverTargets)({
    port: envPort || null,
  });
  const targetsFinal = targets.ok || !envPort ? targets : await (discover || discoverTargets)({});

  // 仅当 CDP 可达时建立真实注入状态探针通道（只读 evaluate，不修改渲染状态）
  let channel = null;
  if (targetsFinal.ok && (targetsFinal.targets || []).length) {
    const t = (targetsFinal.targets || []).find((x) => x && x.type === 'page') || targetsFinal.targets[0];
    const ws = buildDevtoolsWsUrl({ port: targetsFinal.port, targetId: t.id, targets: targetsFinal.targets });
    if (ws.ok) {
      channel = new CDPChannel({ wsUrl: ws.wsUrl, WebSocketImpl });
      try {
        await channel.connect({ wsUrl: ws.wsUrl });
      } catch {
        channel = null;
      }
    }
  }

  const ctx = { targets: targetsFinal, channel, profile: p.id, detected };
  const results = [];
  for (const probe of PROBES) {
    if (probe.profile && probe.profile !== p.id) continue;
    results.push(await runProbe(probe, ctx));
  }
  if (channel) {
    try {
      channel.close();
    } catch {
      /* ignore */
    }
  }

  const capable = results.length > 0 && results.every((r) => r.status === 'pass');
  return {
    schemaVersion: 2,
    workbuddyVersion: process.env.JZ_WB_VERSION || 'unknown',
    profile: p.id,
    platform: process.platform,
    arch: process.arch,
    probes: results,
    capabilities: {
      cdp: targetsFinal.ok,
      inject: results.some((r) => r.id === 'inject-state' && r.status === 'pass'),
      restart: typeof process.env.JZ_HOOKS_RESTART !== 'undefined' ? process.env.JZ_HOOKS_RESTART !== 'off' : true,
      backup: true,
    },
    evidenceVersion: 2,
    supported: capable,
    reason: capable ? 'all probes passed' : results.filter((r) => r.status !== 'pass').map((r) => `${r.id}=${r.status}`).join('; ') || 'unknown',
    detectedProfiles: detected,
    knownProfiles: listProfiles(),
  };
}

module.exports = { PROBES, checkCompatibility };
