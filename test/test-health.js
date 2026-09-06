'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { runHealthCheck, RULE_ORDER } = require('../scripts/jz/health-check');

test('体检返回规范信封字段', async () => {
  const r = await runHealthCheck({ profile: 'workbuddy-cn' });
  assert.ok(r.checkId);
  assert.ok(['healthy', 'attention', 'error', 'blocked'].includes(r.status));
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(Array.isArray(r.findings) && r.findings.length > 0);
});

test('无 CDP 端口时标记 CDP_UNAVAILABLE 且不误报后续层', async () => {
  process.env.JZ_CDP_PORT = '59991'; // 指向确定不可达端口，保证判定确定性
  const r = await runHealthCheck({ profile: 'workbuddy-cn' });
  const codes = r.findings.map((f) => f.code);
  assert.ok(codes.includes('CDP_UNAVAILABLE'));
  assert.ok(codes.includes('NOT_CHECKED_PROFILE'));
});

test('规则执行顺序存在', () => {
  assert.deepEqual(RULE_ORDER, [
    'process', 'daemon', 'cdp', 'profile', 'inject', 'data', 'backup', 'version',
    'network', 'update', 'disk', 'crash', 'injectver', 'autostart', 'tokenperm', 'portbind', 'logsize',
  ]);
});

test('daemon 心跳：daemon.log 新写入 → DAEMON_OK；陈旧 → DAEMON_STALE；缺失 → DAEMON_LOG_MISSING', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-health-'));
  const oldPort = process.env.JZ_CDP_PORT;
  process.env.JZ_CDP_PORT = '59991'; // 不可达，隔离 daemon 层判定
  try {
    // 场景 1：新日志 → OK
    fs.writeFileSync(path.join(root, 'daemon.log'), '[test] heartbeat\n');
    let r = await runHealthCheck({ root });
    assert.ok(r.findings.some((f) => f.code === 'DAEMON_OK'), '新 daemon.log 应 DAEMON_OK');

    // 场景 2：陈旧日志（mtime 1 小时前）→ STALE
    const p = path.join(root, 'daemon.log');
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(p, old, old);
    r = await runHealthCheck({ root });
    assert.ok(r.findings.some((f) => f.code === 'DAEMON_STALE'), '陈旧日志应 DAEMON_STALE');

    // 场景 3：无日志 → MISSING
    fs.rmSync(p, { force: true });
    r = await runHealthCheck({ root });
    assert.ok(r.findings.some((f) => f.code === 'DAEMON_LOG_MISSING'), '缺失日志应 DAEMON_LOG_MISSING');
  } finally {
    if (oldPort === undefined) delete process.env.JZ_CDP_PORT;
    else process.env.JZ_CDP_PORT = oldPort;
  }
});

test('CDP 不可达时：profile/inject 层 NOT_CHECKED 短路；data/version 层与 CDP 无关仍如实上报', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-health-v-'));
  const oldPort = process.env.JZ_CDP_PORT;
  const oldVer = process.env.JZ_WB_VERSION;
  process.env.JZ_CDP_PORT = '59991';
  try {
    process.env.JZ_WB_VERSION = '1.0.16';
    let r = await runHealthCheck({ root });
    const codes = r.findings.map((f) => f.code);
    // 依赖 CDP 的层必须短路标记
    assert.ok(codes.includes('NOT_CHECKED_PROFILE'), 'CDP 不可达时 profile 层应 NOT_CHECKED 短路');
    assert.ok(codes.includes('NOT_CHECKED_INJECT'), 'CDP 不可达时 inject 层应 NOT_CHECKED 短路');
    // 与 CDP 无关的层不得假报 NOT_CHECKED（2026-08-29 复查：data/version 无条件真实执行）
    assert.ok(!codes.includes('NOT_CHECKED_DATA'), 'data 层与 CDP 无关，不得假报 NOT_CHECKED');
    assert.ok(!codes.includes('NOT_CHECKED_VERSION'), 'version 层与 CDP 无关，不得假报 NOT_CHECKED');
    assert.ok(codes.includes('VERSION_OK'), 'daemon 版本来自 env，无需 CDP 即可如实上报');
    assert.ok(codes.includes('DATA_OK'), '数据目录检查与 CDP 无关，应真实执行');
  } finally {
    if (oldPort === undefined) delete process.env.JZ_CDP_PORT;
    else process.env.JZ_CDP_PORT = oldPort;
    if (oldVer === undefined) delete process.env.JZ_WB_VERSION;
    else process.env.JZ_WB_VERSION = oldVer;
  }
});

test('注入版本一致性（CDP mock）：匹配 INJECT_VER_OK / 不匹配 INJECT_VER_MISMATCH', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-health-iv-'));
  fs.writeFileSync(path.join(root, 'daemon.log'), '[test]\n');
  const oldVer = process.env.JZ_WB_VERSION;
  process.env.JZ_WB_VERSION = '0.2.6';
  const makeFakeWS = (ver) => {
    return class FakeWS {
      constructor(url) {
        this.url = url;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        queueMicrotask(() => { if (this.onopen) this.onopen(); });
      }
      send(s) {
        const msg = JSON.parse(s);
        if (msg.method === 'Runtime.evaluate') {
          const value = JSON.stringify({ hasWidget: true, root: true, ver });
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: msg.id, result: { result: { type: 'string', value } } }) });
        }
      }
      close() { if (this.onclose) this.onclose(); }
    };
  };
  const fakeDiscover = async () => ({ ok: true, port: 9223, targets: [{ id: 'T1', type: 'page', title: 'WorkBuddy' }] });
  try {
    // 匹配 → OK
    let r = await runHealthCheck({ root, discover: fakeDiscover, WebSocketImpl: makeFakeWS('0.2.6') });
    assert.ok(r.findings.some((f) => f.code === 'INJECT_VER_OK'), '注入版本匹配应 INJECT_VER_OK');
    // 不匹配 → MISMATCH
    r = await runHealthCheck({ root, discover: fakeDiscover, WebSocketImpl: makeFakeWS('0.1.4') });
    assert.ok(r.findings.some((f) => f.code === 'INJECT_VER_MISMATCH'), '注入版本不匹配应 INJECT_VER_MISMATCH');
    // 无版本（旧注入）→ UNKNOWN 不扣分
    r = await runHealthCheck({ root, discover: fakeDiscover, WebSocketImpl: makeFakeWS(null) });
    assert.ok(r.findings.some((f) => f.code === 'INJECT_VER_UNKNOWN'), '旧注入无版本应 INJECT_VER_UNKNOWN');
  } finally {
    if (oldVer === undefined) delete process.env.JZ_WB_VERSION;
    else process.env.JZ_WB_VERSION = oldVer;
  }
});

test('版本层 + 注入层（CDP mock）：注入版本 VERSION_OK、widget+root 挂载 INJECT_OK，不再 stub', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-health-i-'));
  fs.writeFileSync(path.join(root, 'daemon.log'), '[test]\n');
  const oldVer = process.env.JZ_WB_VERSION;
  process.env.JZ_WB_VERSION = '1.0.16';
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      queueMicrotask(() => { if (this.onopen) this.onopen(); });
    }
    send(s) {
      const msg = JSON.parse(s);
      if (msg.method === 'Runtime.evaluate') {
        const value = '{"hasWidget":true,"root":true}';
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: msg.id, result: { result: { type: 'string', value } } }) });
      }
    }
    close() { if (this.onclose) this.onclose(); }
  }
  const fakeDiscover = async () => ({ ok: true, port: 9223, targets: [{ id: 'T1', type: 'page', title: 'WorkBuddy' }] });
  try {
    const r = await runHealthCheck({ root, discover: fakeDiscover, WebSocketImpl: FakeWS });
    const codes = r.findings.map((f) => f.code);
    const injCodes = codes.filter((c) => c.startsWith('INJECT')).join(',');
    assert.ok(codes.includes('INJECT_OK'), 'inject 应真实判定 INJECT_OK（非 stub），实际: ' + injCodes);
    const inj = r.findings.find((f) => f.code === 'INJECT_OK');
    assert.ok(!inj.evidence.includes('stub'), 'INJECT_OK 证据不得含 stub 字样');
    assert.ok(codes.includes('VERSION_OK'), '注入版本应 VERSION_OK');
  } finally {
    if (oldVer === undefined) delete process.env.JZ_WB_VERSION;
    else process.env.JZ_WB_VERSION = oldVer;
  }
});
