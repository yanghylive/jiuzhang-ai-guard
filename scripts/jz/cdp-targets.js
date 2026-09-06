'use strict';
// CDP 目标发现与命令通道（02 / 03）+ 回应审查 P1-4「DevTools 代理端口写死 9222」。
//
// 端口一律来自"已确认发现结果"，任何下游（DevTools 代理、注入、体检）都不得再硬编码 9222。
// 另外 targetId 必须属于**同一端口**的目标列表，避免跨端口串号。
const http = require('node:http');

const DEFAULT_CANDIDATE_PORTS = [9222, 9223, 9333];

function candidatePorts({ port, ports } = {}) {
  if (port) return [Number(port)];
  if (Array.isArray(ports) && ports.length) return ports.map(Number);
  const env = process.env.JZ_CDP_PORT;
  if (env) {
    const list = String(env)
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (list.length) return list;
  }
  return DEFAULT_CANDIDATE_PORTS.slice();
}

function fetchTargets({ host = '127.0.0.1', port, timeout = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/json/list', timeout }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(Array.isArray(parsed) ? { ok: true, targets: parsed } : { ok: false, targets: [] });
        } catch {
          resolve({ ok: false, targets: [] });
        }
      });
    });
    req.on('error', () => resolve({ ok: false, targets: [] }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, targets: [] });
    });
  });
}

// 逐个候选端口尝试；命中即返回，并把实际端口一路带下去。
async function discoverTargets(opts = {}) {
  const ports = candidatePorts(opts);
  for (const p of ports) {
    if (!p) continue;
    const r = await fetchTargets({ host: opts.host, port: p, timeout: opts.timeout });
    if (r.ok) return { ok: true, port: p, triedPorts: ports, targets: r.targets };
  }
  return { ok: false, error: 'CDP_UNAVAILABLE', port: null, triedPorts: ports, targets: [] };
}

// DevTools 代理后端地址：端口来自已确认发现结果，且 targetId 必须在该端口的目标列表里。
function buildDevtoolsWsUrl({ port, targetId, targets } = {}) {
  if (!port) return { ok: false, error: 'CDP_UNAVAILABLE', reason: 'no_confirmed_port' };
  if (!targetId) return { ok: false, error: 'INVALID_REQUEST', reason: 'target_required' };
  const list = Array.isArray(targets) ? targets : [];
  const hit = list.find((t) => t && t.id === targetId);
  if (!hit) return { ok: false, error: 'INVALID_REQUEST', reason: 'target_not_on_port' };
  // 优先使用目标自报的 wsUrl，但强制校验其端口与已确认端口一致（防止目标伪报别的端口）。
  if (hit.webSocketDebuggerUrl) {
    try {
      const u = new URL(hit.webSocketDebuggerUrl);
      if (Number(u.port) !== Number(port)) {
        return { ok: false, error: 'CDP_UNAVAILABLE', reason: 'target_port_mismatch' };
      }
      return { ok: true, wsUrl: hit.webSocketDebuggerUrl, port: Number(port) };
    } catch {
      /* 落到下面自行拼装 */
    }
  }
  return { ok: true, wsUrl: `ws://127.0.0.1:${Number(port)}/devtools/page/${targetId}`, port: Number(port) };
}

// 真实 CDP 命令通道：直连浏览器已暴露的 DevTools WebSocket（端口/目标均由上方校验后注入）。
//
// 安全约束（回应上游 P0「无鉴权 DevTools WS 代理 + CORS*`）：
//   本通道仅在本进程内、由已鉴权的 API（POST /api/cdp/command，需 secret + 高风险 confirmToken）
//   调用，**绝不对外暴露裸 ws 代理**，因此不会重现上游的跨源 / 无鉴权攻击面。
//   WebSocketImpl 默认取全局 WebSocket（Node 22+ 稳定），可注入以便单测；不可用时优雅降级。
const DEFAULT_WS_IMPL = (typeof globalThis !== 'undefined' && globalThis.WebSocket) || null;
const CDP_DEFAULT_TIMEOUT_MS = Number(process.env.JZ_CDP_TIMEOUT_MS || 10000);

class CDPChannel {
  constructor({ wsUrl = null, WebSocketImpl = DEFAULT_WS_IMPL, timeoutMs = CDP_DEFAULT_TIMEOUT_MS } = {}) {
    this.wsUrl = wsUrl;
    this._WS = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    this.connected = false;
    this._sock = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._eventHandler = null;
  }

  connect({ wsUrl } = {}) {
    const url = wsUrl || this.wsUrl;
    this.wsUrl = url;
    if (!url) return Promise.resolve({ connected: false, reason: 'ws_url_required' });
    if (!this._WS) return Promise.resolve({ connected: false, reason: 'CDP_WEBSOCKET_UNAVAILABLE' });
    return new Promise((resolve, reject) => {
      let settled = false;
      let sock;
      try {
        sock = new this._WS(url);
      } catch (e) {
        return reject({ ok: false, error: 'CDP_CONNECT_FAILED', reason: String((e && e.message) || e) });
      }
      this._sock = sock;
      sock.onopen = () => {
        if (settled) return;
        settled = true;
        this.connected = true;
        resolve({ connected: true, wsUrl: url });
      };
      sock.onerror = (err) => {
        if (!settled) {
          settled = true;
          return reject({ ok: false, error: 'CDP_CONNECT_FAILED', reason: String((err && err.message) || err) });
        }
        this._failAllPending('CDP_CHANNEL_ERROR');
      };
      sock.onclose = () => {
        this.connected = false;
        this._failAllPending('CDP_CHANNEL_CLOSED');
      };
      sock.onmessage = (ev) => this._onMessage(ev && ev.data);
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString('utf8'));
    } catch {
      return; // 丢弃非 JSON 帧
    }
    if (msg && typeof msg.id === 'number' && this._pending.has(msg.id)) {
      const rec = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (rec.timer) clearTimeout(rec.timer);
      if (msg.error) rec.reject({ ok: false, error: 'CDP_COMMAND_ERROR', code: msg.error.code, message: msg.error.message });
      else rec.resolve({ ok: true, id: msg.id, result: msg.result });
      return;
    }
    // CDP 事件（带 method、无 id）：交给可选事件处理器（如控制台日志、网络事件）
    if (msg && msg.method && typeof this._eventHandler === 'function') {
      try {
        this._eventHandler(msg);
      } catch {
        /* ignore */
      }
    }
  }

  send(method, params) {
    if (!this.connected || !this._sock) return Promise.resolve({ ok: false, error: 'CDP_UNAVAILABLE' });
    if (!method) return Promise.resolve({ ok: false, error: 'INVALID_REQUEST', reason: 'method_required' });
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject({ ok: false, error: 'CDP_TIMEOUT', method });
        }
      }, this.timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._sock.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (e) {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          clearTimeout(timer);
          reject({ ok: false, error: 'CDP_SEND_FAILED', reason: String((e && e.message) || e) });
        }
      }
    });
  }

  onEvent(handler) {
    this._eventHandler = handler;
  }

  _failAllPending(error) {
    for (const [, rec] of this._pending) {
      if (rec.timer) clearTimeout(rec.timer);
      try {
        rec.reject({ ok: false, error });
      } catch {
        /* ignore */
      }
    }
    this._pending.clear();
  }

  close() {
    this.connected = false;
    this._failAllPending('CDP_CHANNEL_CLOSED');
    if (this._sock) {
      try {
        if (typeof this._sock.close === 'function') this._sock.close();
      } catch {
        /* ignore */
      }
      this._sock = null;
    }
  }
}

module.exports = {
  discoverTargets,
  fetchTargets,
  candidatePorts,
  buildDevtoolsWsUrl,
  CDPChannel,
  DEFAULT_CANDIDATE_PORTS,
};
