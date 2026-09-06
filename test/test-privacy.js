'use strict';
// 回归测试（第五轮复查 P1）：隐私盾扫描结果必须脱敏，绝不能返回敏感原文。
const test = require('node:test');
const assert = require('node:assert');
const { scan } = require('../scripts/jz/privacy');

test('隐私盾：token/手机号/邮箱命中返回脱敏摘要，绝不含原文', () => {
  const raw = '我的 token 是 kda_AbCdEf12345678901234 别泄露，手机 13800138000，邮箱 a.b@example.com';
  const r = scan(raw);
  assert.equal(r.ok, true);
  assert.ok(r.blocked, '应命中敏感项');
  const text = JSON.stringify(r.sensitive);
  assert.ok(!text.includes('kda_AbCdEf12345678901234'), 'token 原文不得返回');
  assert.ok(!text.includes('13800138000'), '手机号原文不得返回');
  assert.ok(!text.includes('a.b@example.com'), '邮箱原文不得返回');
  assert.ok(r.sensitive.some((s) => s.type === 'token'));
  assert.ok(r.sensitive.some((s) => s.type === 'phone'));
  assert.ok(r.sensitive.every((s) => /\*\*/.test(s.match)), '摘要必须带掩码');
});

test('隐私盾：无敏感内容不拦截；空文本安全', () => {
  const clean = scan('今天天气不错，聊点别的。');
  assert.equal(clean.blocked, false);
  assert.equal(scan('').sensitive.length, 0);
});

// —— 浏览器端发送拦截链路结构断言（防回归；第六轮复查 P1：点击重放曾缺失标记导致死循环）——
// 拦截代码内嵌在 inject.js 的注入脚本里，无法在 node 直接执行；用结构断言锁定关键不变量。
const INJECT_SRC = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');

test('隐私盾发送拦截：点击重放必须带 __wbsPrivacyReplay 标记（防死循环）', () => {
  const factoryBlock = INJECT_SRC.slice(INJECT_SRC.indexOf('function __wbsPrivacyFactory'));
  // 拦截判定必须排除重放标记（early-return 放行）
  assert.match(factoryBlock, /if \(button\.__wbsPrivacyReplay\) return Promise\.resolve\(false\)/, '拦截条件必须排除重放标记，否则点击重放死循环');
  // 重放：标记 → click() → finally 立即清除（无 500ms 绕过窗口）
  assert.match(factoryBlock, /button\.__wbsPrivacyReplay = true/, '点击重放前必须设置 __wbsPrivacyReplay');
  assert.match(factoryBlock, /try \{ button\.click\(\); \} finally \{ button\.__wbsPrivacyReplay = false; \}/, '标记必须与 click() 同步生命周期（重放后立即清除）');
  // Enter 路径同样有标记
  assert.match(factoryBlock, /replay\.__wbsPrivacyReplay = true/, 'Enter 重放必须有标记');
});

test('隐私盾：定时器纳入注入生命周期；按钮识别限定同区域', () => {
  assert.match(INJECT_SRC, /privacyRefreshTimer = setBuildInterval\(privacyRefreshSetting, 60000\)/, '必须用 setBuildInterval（随注入生命周期）');
  assert.match(INJECT_SRC, /registerDisposer\(function \(\) \{\s*if \(privacyRefreshTimer\)/, '定时器必须注册 disposer 清理');
  assert.match(INJECT_SRC, /function sameComposerZone/, '按钮识别必须做弹层/主线程同区域校验');
  assert.match(INJECT_SRC, /__wbsPrivacyFactory/, '拦截逻辑必须收敛到可测工厂');
});
