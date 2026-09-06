'use strict';
// CDP 真实通道协议层测试（不依赖真实浏览器）：注入内存 transport 验证连接/命令/错误/超时/降级。
const assert = require('node:assert');
const test = require('node:test');
const { CDPChannel } = require('../scripts/jz/cdp-targets');

// 内存版 WebSocket：模拟浏览器 DevTools 服务端行为，供 CDPChannel 当 WebSocketImpl 使用。
class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._closed = false;
    FakeWS.instances.push(this);
  }
  _open() {
    if (this.onopen) this.onopen();
  }
  _msg(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
  _err(e) {
    if (this.onerror) this.onerror(e || new Error('fake-ws-error'));
  }
  _close() {
    this._closed = true;
    if (this.onclose) this.onclose();
  }
  send(s) {
    this.sent.push(s);
  }
  close() {
    this._close();
  }
}
FakeWS.instances = [];

function lastWs() {
  return FakeWS.instances[FakeWS.instances.length - 1];
}

test('connect 成功 → send 命令按 id 匹配响应', async () => {
  FakeWS.instances = [];
  const ch = new CDPChannel({ wsUrl: 'ws://127.0.0.1:9333/devtools/page/abc', WebSocketImpl: FakeWS });
  const p = ch.connect({});
  lastWs()._open();
  const conn = await p;
  assert.equal(conn.connected, true);

  const r = ch.send('Runtime.evaluate', { expression: '1+1' });
  assert.equal(lastWs().sent.length, 1);
  const frame = JSON.parse(lastWs().sent[0]);
  assert.equal(frame.method, 'Runtime.evaluate');
  assert.equal(typeof frame.id, 'number');
  lastWs()._msg({ id: frame.id, result: { value: 2 } });
  const out = await r;
  assert.equal(out.ok, true);
  assert.deepEqual(out.result, { value: 2 });
  ch.close();
});

test('CDP 返回 error → 拒绝并带 code/message', async () => {
  FakeWS.instances = [];
  const ch = new CDPChannel({ wsUrl: 'ws://127.0.0.1:9333/devtools/page/abc', WebSocketImpl: FakeWS });
  const p = ch.connect({});
  lastWs()._open();
  await p;
  const r = ch.send('Page.navigate', { url: 'x' });
  const frame = JSON.parse(lastWs().sent[0]);
  lastWs()._msg({ id: frame.id, error: { code: -32000, message: 'invalid url' } });
  await assert.rejects(r, (e) => e && e.error === 'CDP_COMMAND_ERROR' && e.code === -32000 && e.message === 'invalid url');
  ch.close();
});

test('send 无响应 → 超时 reject CDP_TIMEOUT', async () => {
  FakeWS.instances = [];
  const ch = new CDPChannel({ wsUrl: 'ws://127.0.0.1:9333/devtools/page/abc', WebSocketImpl: FakeWS, timeoutMs: 30 });
  const p = ch.connect({});
  lastWs()._open();
  await p;
  const r = ch.send('Runtime.evaluate', {});
  await assert.rejects(r, (e) => e && e.error === 'CDP_TIMEOUT');
  ch.close();
});

test('connect 失败（onerror）→ reject CDP_CONNECT_FAILED', async () => {
  FakeWS.instances = [];
  const ch = new CDPChannel({ wsUrl: 'ws://127.0.0.1:9333/devtools/page/abc', WebSocketImpl: FakeWS });
  const p = ch.connect({});
  lastWs()._err(new Error('ECONNREFUSED'));
  await assert.rejects(p, (e) => e && e.error === 'CDP_CONNECT_FAILED');
});

test('WebSocketImpl 不可用 → 优雅降级 CDP_WEBSOCKET_UNAVAILABLE', async () => {
  const ch = new CDPChannel({ wsUrl: 'ws://127.0.0.1:9333/devtools/page/abc', WebSocketImpl: null });
  const conn = await ch.connect({});
  assert.equal(conn.connected, false);
  assert.equal(conn.reason, 'CDP_WEBSOCKET_UNAVAILABLE');
});

test('close 时清理 pending → 已发未回的命令 reject CDP_CHANNEL_CLOSED', async () => {
  FakeWS.instances = [];
  const ch = new CDPChannel({ wsUrl: 'ws://127.0.0.1:9333/devtools/page/abc', WebSocketImpl: FakeWS, timeoutMs: 10000 });
  const p = ch.connect({});
  lastWs()._open();
  await p;
  const r = ch.send('Runtime.evaluate', {});
  ch.close();
  await assert.rejects(r, (e) => e && e.error === 'CDP_CHANNEL_CLOSED');
});

test('连接断开后（onclose）→ 后续 send 返回 CDP_UNAVAILABLE', async () => {
  FakeWS.instances = [];
  const ch = new CDPChannel({ wsUrl: 'ws://127.0.0.1:9333/devtools/page/abc', WebSocketImpl: FakeWS });
  const p = ch.connect({});
  lastWs()._open();
  await p;
  lastWs()._close();
  const r = await ch.send('Runtime.evaluate', {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'CDP_UNAVAILABLE');
});

test('wsUrl 缺失 → connect 返回未连接的降级结果', async () => {
  const ch = new CDPChannel({ WebSocketImpl: FakeWS });
  const conn = await ch.connect({});
  assert.equal(conn.connected, false);
  assert.equal(conn.reason, 'ws_url_required');
});
