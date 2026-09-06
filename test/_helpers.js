'use strict';
// 测试共享助手：把 jzRouter 挂到真实 HTTP 端口上，用原生 fetch 打请求。
// （真实 HTTP 层验证，不 mock fs、不 mock 响应。）
const http = require('node:http');
const { createRouter } = require('../scripts/jz/api');

async function startRouterServer({ root, token, allowedOrigin, tokenCheck, kaypalHttp } = {}) {
  const router = createRouter({ root, token, allowedOrigin, tokenCheck, kaypalHttp });
  const server = http.createServer((req, res) => {
    Promise.resolve(router.handle(req, res)).catch(() => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'INTERNAL_REDACTED' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    router,
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function jzFetch(baseUrl, p, { method = 'GET', body, token, cookie, headers } = {}) {
  const h = Object.assign({}, headers);
  if (token) h['x-jz-token'] = token;
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(baseUrl + p, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

module.exports = { startRouterServer, jzFetch };
