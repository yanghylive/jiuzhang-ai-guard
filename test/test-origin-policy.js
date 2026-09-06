'use strict';
// 2026-09-04 修正（产品负责人真机实锤回归）：Origin 策略。
// 真实 WorkBuddy 面板宿主是 file:// 页面，浏览器规则「同源 GET 不带 Origin、POST 必带」，
// file:// 的 POST Origin 字面量即 "null"——2026-08-30 把 null 一刀切拒绝导致面板 POST 全 403
// （主题/支付链/设置开关全挂），E2E 页面跑在 http://127.0.0.1 掩盖了问题。
// 修正后 null 放行，token 校验仍在 authorize 链强制；恶意 http 页面带真实 Origin 照拒。
const test = require('node:test');
const assert = require('node:assert');

// daemon.js 是入口脚本（require 会启动服务），故 Origin 策略收敛到 jz/lib.js 单一真源，
// daemon 与注入面板共用同一判定；这里直接测该真源。
const { isAllowedApiOrigin } = require('../scripts/jz/lib');

test('Origin 策略：null Origin 放行（file:// 面板宿主 POST 必带 Origin:"null"，token 兜底仍在）', () => {
  assert.equal(typeof isAllowedApiOrigin, 'function', 'daemon 应导出 isAllowedApiOrigin 供测试');
  assert.equal(isAllowedApiOrigin('null'), true, 'Origin: null 必须放行（file:// 宿主 POST）');
});

test('Origin 策略：空 Origin 放行（本地 CLI/启动器无 Origin）', () => {
  assert.equal(isAllowedApiOrigin(''), true);
  assert.equal(isAllowedApiOrigin(undefined), true);
  assert.equal(isAllowedApiOrigin(null), true);
});

test('Origin 策略：官方域名与 loopback 放行，其它域名拒绝', () => {
  // 官方域名
  assert.equal(isAllowedApiOrigin('https://workbuddy.cn'), true);
  assert.equal(isAllowedApiOrigin('https://app.codebuddy.cn'), true);
  // loopback
  assert.equal(isAllowedApiOrigin('http://127.0.0.1:9222'), true);
  assert.equal(isAllowedApiOrigin('http://localhost:5173'), true);
  // 其它域名 / 非 http 协议
  assert.equal(isAllowedApiOrigin('https://evil.example.com'), false);
  assert.equal(isAllowedApiOrigin('file://'), false);
  assert.equal(isAllowedApiOrigin('not-a-url'), false);
});
