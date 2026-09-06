'use strict';
// memory-store 回归（V1.0，能力提炼开发文档 §3.3/§5.2）：
// 来源必填/敏感 fail-closed/关键词检索打分/工作前回忆统计/状态机+防篡改/HTTP 全链路。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  addMemory,
  listMemories,
  getMemory,
  searchMemories,
  recallForWork,
  updateMemoryStatus,
} = require('../scripts/jz/memory-store');
const { startRouterServer, jzFetch } = require('./_helpers');

function freshRoot() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-mem-'));
}

test('addMemory：来源必填 + 落盘 + checksum', () => {
  const root = freshRoot();
  const noRef = addMemory({ title: 'x', text: 'y', root });
  assert.equal(noRef.ok, false);
  assert.equal(noRef.error, 'SOURCE_REFS_REQUIRED', 'sourceRefs 必填（来源可追溯是硬要求）');

  const badRef = addMemory({ title: 'x', text: 'y', sourceRefs: ['../../etc/passwd'], root });
  assert.equal(badRef.ok, false, '非法 sourceRef（路径穿越形态）必须拒绝');

  const r = addMemory({ title: 'Excel 合并技巧', text: '合并多表用 concat 函数，注意表头对齐', sourceRefs: ['task-abc123'], tags: ['excel'], importance: 7, root });
  assert.equal(r.ok, true);
  const mem = r.memory;
  assert.match(mem.memoryId, /^ast-/, 'memoryId 前缀 ast-（统一资产模型）');
  assert.equal(mem.status, 'draft', '默认 draft');
  assert.equal(mem.checksum.length, 12, 'checksum 摘要返回');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'assets', `${mem.memoryId}.json`), 'utf8'));
  assert.equal(onDisk.checksum.length, 64, '落盘 checksum 为完整 sha256');
});

test('addMemory：敏感内容 fail-closed（token/手机号/邮箱拒绝入库）', () => {
  const root = freshRoot();
  const t = addMemory({ title: '登录凭据备忘', text: '我的 API token 是 kda_AbCdEf12345678901234，手机 13800138000', sourceRefs: ['task-sec1'], root });
  assert.equal(t.ok, false);
  assert.equal(t.error, 'SENSITIVE_CONTENT');
  const dir = path.join(root, 'runtime', 'assets');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.equal(files.length, 0, '敏感内容绝不落盘');
});

test('searchMemories：关键词打分（title > tags > text）+ importance 加权', () => {
  const root = freshRoot();
  const a1 = addMemory({ title: 'Excel 多表合并', text: '使用 concat 合并销售报表', sourceRefs: ['task-e1'], tags: ['excel'], importance: 8, root });
  const a2 = addMemory({ title: '周报模板', text: '每周一生成周报草稿', sourceRefs: ['task-e2'], tags: ['report'], importance: 3, root });
  const a3 = addMemory({ title: '开会纪要', text: '会议记录格式与归档', sourceRefs: ['task-e3'], tags: ['meeting'], importance: 2, root });
  // 搜索默认只查 enabled（草稿不参与检索）→ 先启用
  for (const a of [a1, a2, a3]) updateMemoryStatus(a.memory.memoryId, 'enabled', { root });

  const r = searchMemories({ query: 'Excel 合并', root });
  assert.equal(r.ok, true);
  assert.equal(r.memories.length, 1, '只命中 Excel 那条');
  assert.equal(r.memories[0].title, 'Excel 多表合并');

  const broad = searchMemories({ query: '周报', root });
  assert.equal(broad.memories.length, 1);
  assert.equal(broad.memories[0].title, '周报模板');
});

test('recallForWork：更新召回统计；只召回 enabled', () => {
  const root = freshRoot();
  const r1 = addMemory({ title: '数据备份经验', text: '备份前检查磁盘空间，先锁目录', sourceRefs: ['task-b1'], importance: 9, root });
  addMemory({ title: '数据备份草稿', text: '备份流程草稿未确认', sourceRefs: ['task-b2'], importance: 5, root });
  // 草稿默认 draft，recall 只查 enabled → 需要先 enable
  updateMemoryStatus(r1.memory.memoryId, 'enabled', { root });

  const rec = recallForWork({ taskText: '我要做一次数据备份', root });
  assert.equal(rec.ok, true);
  assert.equal(rec.memories.length, 1, '只召回 enabled 的记忆（草稿不召回）');
  assert.equal(rec.memories[0].title, '数据备份经验');

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'assets', `${r1.memory.memoryId}.json`), 'utf8'));
  assert.equal(onDisk.recallCount, 1, '召回计数 +1');
  assert.ok(onDisk.lastRecalledAt, '记录最近召回时间');
});

test('updateMemoryStatus：白名单 + 篡改检测（409 MEMORY_TAMPERED）', () => {
  const root = freshRoot();
  const r = addMemory({ title: 'T', text: '正文', sourceRefs: ['task-s1'], root });
  const id = r.memory.memoryId;

  const bad = updateMemoryStatus(id, 'hacked', { root });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'INVALID_STATUS');

  const ok = updateMemoryStatus(id, 'enabled', { root });
  assert.equal(ok.ok, true);
  assert.equal(ok.memory.status, 'enabled');

  // 外部篡改文件 → checksum 校验失败
  const p = path.join(root, 'runtime', 'assets', `${id}.json`);
  const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
  cur.content = '被人改了';
  fs.writeFileSync(p, JSON.stringify(cur, null, 2));
  const tampered = updateMemoryStatus(id, 'archived', { root });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.error, 'MEMORY_TAMPERED');
});

test('HTTP 全链路：add → list → get → search → recall → status + 幂等 + 敏感拒绝', async () => {
  const root = freshRoot();
  const TOKEN = crypto.randomBytes(32).toString('hex');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    // 幂等键
    const add = await jzFetch(s.baseUrl, '/api/memory/add', {
      method: 'POST', token: TOKEN,
      body: { title: 'HTTP 记忆', text: '通过 HTTP 添加的测试记忆内容', sourceRefs: ['task-http1'], tags: ['http'], importance: 6, idempotencyKey: 'mem-key-01' },
    });
    const aj = await add.json();
    assert.equal(add.status, 200);
    assert.ok(aj.data.memoryId, 'add 返回 memoryId');
    const replay = await (await jzFetch(s.baseUrl, '/api/memory/add', {
      method: 'POST', token: TOKEN,
      body: { title: 'HTTP 记忆', text: '通过 HTTP 添加的测试记忆内容', sourceRefs: ['task-http1'], tags: ['http'], importance: 6, idempotencyKey: 'mem-key-01' },
    })).json();
    assert.equal(replay.data.memoryId, aj.data.memoryId, '同幂等键重放返回同一记忆');

    // 敏感拒绝
    const sec = await jzFetch(s.baseUrl, '/api/memory/add', {
      method: 'POST', token: TOKEN,
      body: { title: 'x', text: 'token kda_AbCdEf12345678901234', sourceRefs: ['task-sec2'], idempotencyKey: 'mem-key-sec' },
    });
    assert.equal(sec.status, 422);
    assert.equal((await sec.json()).error, 'SENSITIVE_CONTENT');

    // 缺来源
    const noRef = await jzFetch(s.baseUrl, '/api/memory/add', {
      method: 'POST', token: TOKEN,
      body: { title: 'x', text: 'y', idempotencyKey: 'mem-key-noref' },
    });
    assert.equal(noRef.status, 400);
    assert.equal((await noRef.json()).error, 'SOURCE_REFS_REQUIRED');

    // 列表 / 单条
    const list = await (await jzFetch(s.baseUrl, '/api/memory/list', { method: 'GET', token: TOKEN })).json();
    assert.equal(list.data.memories.length, 1);
    const one = await (await jzFetch(s.baseUrl, `/api/memory/${aj.data.memoryId}`, { method: 'GET', token: TOKEN })).json();
    assert.equal(one.data.memoryId, aj.data.memoryId);

    // 状态 → enabled 后再检索/回忆（搜索默认只查 enabled）
    const st = await jzFetch(s.baseUrl, `/api/memory/${aj.data.memoryId}/status`, { method: 'POST', token: TOKEN, body: { status: 'enabled' } });
    assert.equal(st.status, 200);
    const search = await (await jzFetch(s.baseUrl, '/api/memory/search', { method: 'POST', token: TOKEN, body: { query: 'HTTP 记忆' } })).json();
    assert.ok(search.data.memories.length >= 1);
    const recall = await (await jzFetch(s.baseUrl, '/api/memory/recall', { method: 'POST', token: TOKEN, body: { taskText: 'HTTP 记忆' } })).json();
    assert.ok(recall.data.memories.length >= 1, 'recall 命中 enabled 记忆');
  } finally {
    await s.close();
  }
});
