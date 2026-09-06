'use strict';
// 2026-08-30 复核 P1 回归：更新/导出导入/会话恢复的状态码与「假成功」。
// 这几处路由在 daemon.js（入口脚本，无法直接起 router 单测），故用源码断言锁定不变量：
//   P1-7 update-apply 失败不得 200
//   P1-8 无账号导出 / 导入异常 / 会话恢复行数 不得是 200 + ok:false 或请求数冒充实际数
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DAEMON = path.join(__dirname, '..', 'scripts', 'daemon.js');
const src = fs.readFileSync(DAEMON, 'utf8');

test('P1-7 update-apply 失败返回 422（不得 200）', () => {
  const seg = src.slice(src.indexOf("p === '/api/update-apply'"), src.indexOf("p === '/api/update-apply'") + 900);
  assert.ok(seg.includes('json(res, 422'), 'update-apply 的 catch 分支必须返回 422');
  // catch 分支里不得再有 json(res, 200
  const catchPart = seg.slice(seg.indexOf('.catch('));
  assert.ok(!/json\(res,\s*200/.test(catchPart), 'update-apply 的失败分支不得返回 200');
});

test('P1-8a 无账号导出返回 404（不得 200 + ok:false）', () => {
  assert.ok(
    src.includes("json(res, 404, { ok: false, error: '没有可导出的账号备份' })"),
    '无账号导出必须 404',
  );
});

test('P1-8b 账号导入异常按性质返回 400/500（不得 200）', () => {
  const seg = src.slice(src.indexOf("log(`[import] 导入失败"), src.indexOf("log(`[import] 导入失败") + 400);
  assert.ok(seg.includes('json(res, clientError ? 400 : 500'), '导入失败必须 400/500 分流');
  assert.ok(!/json\(res,\s*200,\s*\{\s*ok:\s*false/.test(seg), '导入失败不得返回 200');
});

test('P1-8c 会话恢复返回实际恢复行数（不得直接用请求数）', () => {
  const seg = src.slice(src.indexOf("p === '/api/sessions/restore'"), src.indexOf("p === '/api/sessions/restore'") + 1400);
  assert.ok(seg.includes('deleted_at IS NULL'), '必须复查实际未删除行数');
  assert.ok(seg.includes('restored: actual'), 'restored 必须是实际行数');
  assert.ok(seg.includes('requested: ids.length'), '应回传请求数供核对');
  assert.ok(!/restored:\s*ids\.length/.test(seg), '不得再用请求数冒充恢复数');
});
