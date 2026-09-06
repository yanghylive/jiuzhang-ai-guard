'use strict';
// 回归测试（2026-09-01 云电脑 GUI 真机点验抓出 P1）：
// admin 页脚本体在模板字面量内，源码里的 `\n` 会被模板先解释成真换行，
// 生成页面的 JS 字符串字面量被折行 → 整页 SyntaxError → 全部交互死掉
// （导航切换/微信扫码/套餐加载全不动，但 DOM 静态结构检查全过——静态检查抓不住）。
// 锁死：renderAdminUI 产出的 <script> 必须能通过语法解析（new Function）。
const test = require('node:test');
const assert = require('node:assert');

const { renderAdminUI } = require('../scripts/jz/admin-ui');

function pageScript() {
  const html = renderAdminUI({});
  const parts = html.split('<script>');
  assert.ok(parts.length >= 2, 'renderAdminUI 输出应包含 <script> 块');
  return parts[1].split('</script>')[0];
}

test('admin 页脚本体必须通过语法解析（模板字面量逃逸回归，云电脑真机 P1）', () => {
  const js = pageScript();
  assert.ok(js.length > 10000, '脚本体不应为空');
  // 不抛即通过；抛出则正是"字符串被模板折行"类缺陷
  new Function(js);
});

test('admin 页结构：nav 6 分类 / panel 7 容器（advanced 两段）', () => {
  const html = renderAdminUI({});
  assert.strictEqual((html.match(/class="navitem[ "]/g) || []).length, 6);
  assert.strictEqual((html.match(/class="panel"/g) || []).length, 7);
  assert.strictEqual((html.match(/data-panel="advanced"/g) || []).length, 2);
});

test('admin 页脚本关键 handler 挂载点在脚本体内（防块级语法错误造成整体失效）', () => {
  const js = pageScript();
  for (const marker of [
    "getElementById('btn-wx-login')",
    "getElementById('cat-nav')",
    'function loadPlans()',
    "getElementById('coupon-plan')",
  ]) {
    assert.ok(js.includes(marker), '脚本体应包含 ' + marker);
  }
});
