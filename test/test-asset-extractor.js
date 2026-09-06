'use strict';
// asset-extractor 回归（V1.0，skill-distiller 方法论落地）：
// 签名骨架脱敏/≥3次跨2会话门槛/同构归并 merged_from/固定度/规则化命名/
// confirm 落库 draft + 来源可追溯/HTTP 链路。
// 注：输入为合成任务记录（V0.1 框架验证用），真实数据接入时替换数据源即可。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { mineFlows, confirmFlow, businessSequence, stepSignature } = require('../scripts/jz/asset-extractor');
const { getAsset } = require('../scripts/jz/asset-store');
const { startRouterServer, jzFetch } = require('./_helpers');

// 合成任务记录：3 条同构（读 md → 编辑 md）+ 1 条无关（下载 → 解压）
function synthRecords() {
  const mk = (id, sess) => ({
    recordId: id,
    sessionId: sess,
    at: '2026-08-29T10:00:00Z',
    steps: [
      { tool: 'Read', action: '读取', params: { file_path: `/a/b/c${Math.floor(Math.random() * 100)}.md` } },
      { tool: 'Edit', action: '编辑', params: { file_path: `/a/b/c.md`, content: 'some markdown body' } },
    ],
  });
  return [
    mk('rec-1', 's1'),
    mk('rec-2', 's2'),
    mk('rec-3', 's3'),
    {
      recordId: 'rec-4',
      sessionId: 's1',
      at: '2026-08-29T11:00:00Z',
      steps: [
        { tool: 'Bash', action: '下载', params: { url: 'https://example.com/pkg.tar.gz' } },
        { tool: 'Bash', action: '解压', params: { archive: '/tmp/pkg.tar.gz', dest: '/tmp/out' } },
      ],
    },
  ];
}

test('stepSignature/paramSkeleton：值归一为骨架，不保留原值（脱敏）', () => {
  assert.equal(stepSignature({ tool: 'Read', params: { file_path: '/a/b/secret.md' } }), 'Read(file_path:<path:.md>)');
  assert.equal(stepSignature({ tool: 'Fetch', params: { url: 'https://x.com/1' } }), 'Fetch(url:url)');
  assert.equal(stepSignature({ tool: 'Bash', params: { count: 3, flag: true } }), 'Bash(count:num,flag:bool)');
  // 原值绝不出现在签名里
  const sig = stepSignature({ tool: 'Read', params: { file_path: '/Users/king/api-key.txt' } });
  assert.ok(!sig.includes('king') && !sig.includes('api-key'), '签名必须脱敏');
});

test('businessSequence：基础设施步骤剔除 + 连续相同折叠', () => {
  const seq = businessSequence({
    recordId: 'r', steps: [
      { tool: 'Read', params: { file_path: 'a.md' } },
      { tool: 'Read', params: { file_path: 'b.md' } },
      { tool: 'askUser', params: {} },
      { tool: 'Edit', params: { file_path: 'c.md' } },
    ],
  });
  assert.equal(seq.length, 2, 'askUser 剔除，连续 Read 折叠为 1');
  assert.ok(seq[0].startsWith('Read(') && seq[1].startsWith('Edit('));
});

test('mineFlows：≥3 次且跨 ≥2 会话才候选；同构归并 merged_from；无关流程不进', () => {
  const r = mineFlows({ records: synthRecords() });
  assert.equal(r.ok, true);
  const cands = r.candidates;
  assert.equal(cands.length, 1, '只有读md+编辑md 满足 ≥3 次跨 ≥2 会话（下载解压仅 1 次）');
  const c = cands[0];
  assert.equal(c.frequency, 3);
  assert.equal(c.sessions, 3);
  assert.equal(c.stepCount, 2);
  assert.ok(c.mergedFrom.includes('rec-1') && c.mergedFrom.includes('rec-3'), '合并来源留痕');
  // 命名规则化：含动作与工具链
  assert.match(c.title, /读取/);
  assert.match(c.title, /Read→Edit/);
  assert.ok(c.steps[0].signature.includes('<path:.md>'), 'steps 为脱敏签名');
});

test('confirmFlow：落库 draft workflow 资产，来源可追溯', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-ext-'));
  const records = synthRecords();
  const mine = mineFlows({ records });
  const r = confirmFlow({ flowKey: mine.candidates[0].flowKey, records, root });
  assert.equal(r.ok, true);
  assert.equal(r.asset.kind, 'workflow');
  assert.equal(r.asset.status, 'draft', '默认草稿不启用（§5.3-4）');
  assert.equal(r.asset.tags.includes('extracted'), true);
  assert.ok(r.asset.sourceRefs.length >= 3, '来源记录 ID 全留痕');
  const onDisk = getAsset(r.asset.assetId, { root });
  assert.ok(onDisk.asset.steps.length === 2);
  assert.ok(!JSON.stringify(onDisk.asset).includes('some markdown body'), '正文/原值绝不落库（只存签名骨架）');
});

test('HTTP 链路：mine → confirm → 落库可查', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-ext-http-'));
  const TOKEN = crypto.randomBytes(32).toString('hex');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    const records = synthRecords();
    const mn = await (await jzFetch(s.baseUrl, '/api/extractor/mine', { method: 'POST', token: TOKEN, body: { records } })).json();
    assert.ok(mn.data.candidates.length >= 1, 'mine 返回候选');
    const flowKey = mn.data.candidates[0].flowKey;
    const cf = await jzFetch(s.baseUrl, '/api/extractor/confirm', {
      method: 'POST', token: TOKEN,
      body: { flowKey, records, idempotencyKey: 'ext-key-01' },
    });
    const cfj = await cf.json();
    assert.equal(cf.status, 200);
    assert.equal(cfj.data.kind, 'workflow');
    // 幂等重放
    const rp = await (await jzFetch(s.baseUrl, '/api/extractor/confirm', {
      method: 'POST', token: TOKEN,
      body: { flowKey, records, idempotencyKey: 'ext-key-01' },
    })).json();
    assert.equal(rp.data.assetId, cfj.data.assetId, '同幂等键重放返回同一资产');
  } finally {
    await s.close();
  }
});
