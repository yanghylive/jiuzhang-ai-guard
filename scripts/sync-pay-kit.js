'use strict';
// pay-kit 分发副本同步脚本（2026-09-01）。
// 真源 = scripts/jz/{kaypal-pay.js, api.js, admin-ui.js}（daemon require + 发版打包的唯一来源），
// kit 副本 = packages/pay-kit/{pay-core,pay-ui}/ 下的分发文件（锚点抽取，字节级一致）。
// 用法：node scripts/sync-pay-kit.js   （改了真源后跑一次；test/test-pay-kit-sync.js 会校验没跑会红）
// 锚点抽取（非行号）：真源中间插删代码时抽取段自动跟着走；锚点字符串本身被删才会挂。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'packages', 'pay-kit');

function hdr(src) {
  return (
    '// [pay-kit 分发副本] 唯一真源: ' + src + '\n' +
    '// 本文件由 scripts 同步生成，请勿直接改这里——改真源后跑 node scripts/sync-pay-kit.js 重新同步。\n'
  );
}

function readLines(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
}

function findIndex(lines, needle, from = 0) {
  const i = lines.findIndex((l, idx) => idx >= from && l.includes(needle));
  if (i < 0) throw new Error(`锚点未找到: ${needle}`);
  return i;
}

function buildKitFiles() {
  const files = {};

  // 1) pay-core/kaypal-pay.js = 真源全文 + 头
  const kp = fs.readFileSync(path.join(ROOT, 'scripts/jz/kaypal-pay.js'), 'utf8');
  files['pay-core/kaypal-pay.js'] = hdr('scripts/jz/kaypal-pay.js') + kp;

  // 2) pay-core/license-routes.reference.js = api.js 锚点段（order/status 起 → diagnostics/preview 前）
  const api = readLines('scripts/jz/api.js');
  const a1 = findIndex(api, "if (method === 'GET' && p === '/api/license/order/status')");
  const a2 = findIndex(api, "if (method === 'POST' && p === '/api/diagnostics/preview')");
  if (a2 <= a1) throw new Error('api.js 锚点顺序异常');
  const segApi = api.slice(a1, a2).join('\n').trimEnd();
  files['pay-core/license-routes.reference.js'] =
    hdr(`scripts/jz/api.js ${a1 + 1}-${a2} 行（锚点抽取）`) +
    '// 幂等购买路由参考实现：POST /api/license/purchase 全幂等语义（同键回放/指纹冲突/PENDING 窗口/并发锁/507 释放锁）。\n' +
    '// GET /api/license/pay/query + /api/license/order/status 为配套查单/激活确认端点。\n' +
    segApi + '\n';

  // 3) pay-ui/payment-flow.js = admin-ui.js 两段（支付流程函数 + 购买按钮接线）
  const ui = readLines('scripts/jz/admin-ui.js');
  const u1 = findIndex(ui, '===== 微信扫码支付');
  const u2 = findIndex(ui, '价目卡动态化');
  const u3 = findIndex(ui, "row.querySelectorAll('[data-buy]')");
  const u4 = findIndex(ui, '离线价目', u3 + 1); // 第二处（catch 内离线兜底）
  if (u2 <= u1 || u4 <= u3) throw new Error('admin-ui.js 锚点顺序异常');
  const segUi1 = ui.slice(u1, u2).join('\n').trimEnd();
  const segUi2 = ui.slice(u3, u4).join('\n').trimEnd();
  files['pay-ui/payment-flow.js'] =
    hdr(`scripts/jz/admin-ui.js ${u1 + 1}-${u2} 行 + ${u3 + 1}-${u4} 行（锚点抽取）`) +
    '// 支付页流程参考实现：三态（出码等待→3s 轮询→激活确认）+ 轮询纪律（进新流程/取消/成功/关闭先停旧轮询）。\n' +
    '// 依赖宿主页面的 api()/escapeHtml()/show()/renderLicense() 等工具函数，接入时按宿主替换。\n' +
    segUi1 + '\n\n  // --- 购买按钮接线（loadPlans 内） ---\n' + segUi2 + '\n';

  return files;
}

function sync() {
  const files = buildKitFiles();
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(KIT, rel), content);
    console.log('[pay-kit] synced', rel);
  }
}

module.exports = { buildKitFiles };

if (require.main === module) sync();
