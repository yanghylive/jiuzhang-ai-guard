'use strict';
// 兼容性探针测试：CDP 不可达降级 / CDP 可达真实 inject-state / 能力矩阵映射。
const test = require('node:test');
const assert = require('node:assert');
const { checkCompatibility, PROBES } = require('../scripts/jz/compatibility');

// 内存版 WebSocket：模拟浏览器 DevTools 服务端，收到 Runtime.evaluate 就回 window.__wbsWidget 状态。
class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.widgetState = '{"hasWidget":true,"root":true,"version":"9.9.9"}';
    // CDPChannel.connect 在 new 之后才赋 onopen，故用微任务触发（同步触发 onopen 还没挂上）
    queueMicrotask(() => {
      if (this.onopen) this.onopen();
    });
  }
  _open() {
    if (this.onopen) this.onopen();
  }
  send(s) {
    this.sent.push(s);
    const msg = JSON.parse(s);
    if (msg.method === 'Runtime.evaluate') {
      const value = msg.params && msg.params.returnByValue ? this.widgetState : undefined;
      if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: msg.id, result: { result: { type: 'string', value } } }) });
    }
  }
  close() {
    if (this.onclose) this.onclose();
  }
}

function fakeDiscover({ targets = [], port = 9223 } = {}) {
  return async () => ({ ok: targets.length > 0, port, targets });
}

test('CDP 不可达：cdp-reachable fail，inject-state unknown，不谎报 pass', async () => {
  const r = await checkCompatibility({ profile: 'workbuddy-cn', discover: fakeDiscover({ targets: [] }) });
  const byId = Object.fromEntries(r.probes.map((x) => [x.id, x]));
  assert.equal(byId['cdp-reachable'].status, 'fail');
  assert.equal(byId['inject-state'].status, 'unknown');
  assert.equal(r.capabilities.cdp, false);
  assert.equal(r.capabilities.inject, false);
  assert.equal(r.supported, false);
  assert.ok(r.reason.includes('cdp-reachable=fail'), `reason 应点名失败探针: ${r.reason}`);
});

test('CDP 可达且注入完成：inject-state 真实读 window.__wbsWidget，全探针 pass', async () => {
  const prevV = process.env.JZ_VERSION;
  process.env.JZ_VERSION = '1.0.0'; // version-probe 依赖 env 注入的真实版本
  try {
    const targets = [{ id: 'T1', type: 'page', title: 'WorkBuddy' }];
    const r = await checkCompatibility({
      profile: 'workbuddy-cn',
      discover: fakeDiscover({ targets }),
      WebSocketImpl: FakeWS,
    });
    const byId = Object.fromEntries(r.probes.map((x) => [x.id, x]));
    assert.equal(byId['cdp-reachable'].status, 'pass');
    assert.equal(byId['inject-state'].status, 'pass');
    assert.ok(byId['inject-state'].evidence.includes('widget=true'), `evidence 应有真实证据: ${byId['inject-state'].evidence}`);
    assert.ok(byId['inject-state'].evidence.includes('root=true'));
    assert.equal(byId['version-probe'].status, 'pass');
    assert.equal(r.capabilities.cdp, true);
    assert.equal(r.capabilities.inject, true);
  } finally {
    if (prevV === undefined) delete process.env.JZ_VERSION;
    else process.env.JZ_VERSION = prevV;
  }
});

test('CDP 可达但注入缺失：inject-state warn 而非 pass，supported=false', async () => {
  const targets = [{ id: 'T1', type: 'page', title: 'WorkBuddy' }];
  const ws = class extends FakeWS {
    constructor(url) {
      super(url);
      this.widgetState = '{"hasWidget":false,"root":false,"version":null}';
    }
  };
  const r = await checkCompatibility({
    profile: 'workbuddy-cn',
    discover: fakeDiscover({ targets }),
    WebSocketImpl: ws,
  });
  const byId = Object.fromEntries(r.probes.map((x) => [x.id, x]));
  assert.equal(byId['inject-state'].status, 'warn');
  assert.equal(r.capabilities.inject, false);
  assert.equal(r.supported, false);
});

test('探针证据不含固定 [redacted] 占位', async () => {
  const r = await checkCompatibility({ profile: 'workbuddy-cn', discover: fakeDiscover({ targets: [] }) });
  for (const p of r.probes) {
    assert.ok(!p.evidence.includes('[redacted]'), `${p.id} 证据不得是固定占位: ${p.evidence}`);
  }
  // 探针定义完整性：4 个探针，id 唯一
  const ids = PROBES.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, '探针 id 必须唯一');
  assert.ok(ids.includes('cdp-reachable') && ids.includes('inject-state') && ids.includes('version-probe') && ids.includes('profile-matrix'));
});
