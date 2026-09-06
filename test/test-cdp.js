'use strict';
// 回应审查 P1-4：DevTools 代理必须使用已确认的 CDP 端口，不得硬编码 9222。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { discoverTargets, candidatePorts, buildDevtoolsWsUrl, DEFAULT_CANDIDATE_PORTS } = require('../scripts/jz/cdp-targets');

test('默认候选端口覆盖 9222/9223/9333，env 可覆盖', () => {
  delete process.env.JZ_CDP_PORT;
  assert.deepEqual(candidatePorts(), DEFAULT_CANDIDATE_PORTS);
  process.env.JZ_CDP_PORT = '9333,9444';
  assert.deepEqual(candidatePorts(), [9333, 9444]);
  delete process.env.JZ_CDP_PORT;
  assert.deepEqual(candidatePorts({ port: 9223 }), [9223]);
});

test('CDP 运行在 9223 时仍能发现，且 ws url 用 9223 而非 9222', async () => {
  const targets = [
    { id: 'T1', type: 'page', title: 'WorkBuddy', webSocketDebuggerUrl: '' },
  ];
  const srv = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(targets));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const found = await discoverTargets({ ports: [port] });
    assert.equal(found.ok, true);
    assert.equal(found.port, port);
    const ws = buildDevtoolsWsUrl({ port: found.port, targetId: 'T1', targets: found.targets });
    assert.equal(ws.ok, true);
    assert.ok(ws.wsUrl.includes(`127.0.0.1:${port}`), `ws url 必须用实际端口，实际: ${ws.wsUrl}`);
    assert.ok(!ws.wsUrl.includes(':9222/'), 'ws url 不得回落到硬编码 9222');
  } finally {
    srv.close();
  }
});

test('targetId 不属于该端口目标列表 → 拒绝，不建立代理', () => {
  const r = buildDevtoolsWsUrl({ port: 9223, targetId: 'GHOST', targets: [{ id: 'T1' }] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'target_not_on_port');
});

test('目标自报 ws 端口与已确认端口不一致 → 拒绝', () => {
  const r = buildDevtoolsWsUrl({
    port: 9223,
    targetId: 'T1',
    targets: [{ id: 'T1', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T1' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'target_port_mismatch');
});

test('全部候选端口不可达 → CDP_UNAVAILABLE 且回报尝试过的端口', async () => {
  const r = await discoverTargets({ ports: [59991, 59992], timeout: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'CDP_UNAVAILABLE');
  assert.deepEqual(r.triedPorts, [59991, 59992]);
});
