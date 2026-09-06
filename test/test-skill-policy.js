'use strict';
// skill-policy 回归（V1.0，素材 workbuddy-skill-manager 信任评分模型提炼）：
// 评分明细/能力声明不扣分/决策阈值+高危红线/Jaccard 重叠/HTTP 链路。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scoreSkill, decide, findOverlap, HIGH_RISK_ACTIONS, ACTION_WHITELIST } = require('../scripts/jz/skill-policy');
const { addAsset, listAssets } = require('../scripts/jz/asset-store');
const { startRouterServer, jzFetch } = require('./_helpers');

test('scoreSkill：官方高分/未知来源低分 + 明细透明 + 能力声明不扣分', () => {
  const good = scoreSkill({
    source: 'skillhub', version: '2.1.0', hasScripts: true,
    description: '这是一个功能描述很完整的技能说明文本', usage: '直接说：帮我做X',
    installedAt: '2026-08-01', fileSizeBytes: 120000, hasNetwork: true, hasWrite: true,
  });
  assert.equal(good.ok, true);
  assert.ok(good.score >= 85, `官方+完整元数据应高分，实际 ${good.score}`);
  // 能力声明只标注不扣分
  const cap = good.breakdown.find((b) => b.dimension === '能力声明');
  assert.ok(cap && cap.points === 0, '能力声明维度 points 必须为 0（不扣分）');
  assert.ok(good.capabilities.includes('含可执行脚本'));

  const bad = scoreSkill({ source: 'unknown', fileSizeBytes: 1500000 });
  assert.ok(bad.score <= 60, `未知来源+超大体积应低分，实际 ${bad.score}`);
  const tooBig = bad.breakdown.find((b) => b.dimension === '体量异常');
  assert.equal(tooBig.points, -8);

  // 明细完整（基础分/来源/体量都在）
  const dims = good.breakdown.map((b) => b.dimension);
  assert.ok(dims.includes('基础分') && dims.includes('来源信任') && dims.includes('版本号'));
});

test('decide：阈值决策（low 放宽/high 收紧）+ 高危动作永远 require-confirm', () => {
  // medium：75 → allow；50 → require-confirm；30 → deny
  assert.equal(decide({ trustScore: 75, action: 'run' }).decision, 'allow');
  assert.equal(decide({ trustScore: 50, action: 'run' }).decision, 'require-confirm');
  assert.equal(decide({ trustScore: 30, action: 'run' }).decision, 'deny');
  // low 放宽：65 → allow（基准 70−10）
  assert.equal(decide({ trustScore: 65, risk: 'low', action: 'run' }).decision, 'allow');
  // high 收紧：65 → require-confirm（基准 70+10）
  assert.equal(decide({ trustScore: 65, risk: 'high', action: 'run' }).decision, 'require-confirm');
  // 高危红线：高分也 require-confirm
  for (const act of HIGH_RISK_ACTIONS) {
    assert.equal(decide({ trustScore: 95, action: act }).decision, 'require-confirm', `${act} 即使 95 分也必须人工确认`);
  }
  // 非法 action
  assert.equal(decide({ trustScore: 80, action: 'hack' }).error, 'INVALID_ACTION');
});

test('findOverlap：Jaccard ≥0.35 检测重叠对；不相关不误报', () => {
  const assets = [
    { assetId: 'ast-a', title: '竞品调研周报', tags: ['workflow', '竞品'], steps: [{ action: '搜索', object: '竞品' }] },
    { assetId: 'ast-b', title: '竞品监测周报', tags: ['workflow', '竞品'], steps: [{ action: '搜索', object: '竞品' }] },
    { assetId: 'ast-c', title: 'Excel 多表合并', tags: ['excel'], steps: [{ action: '合并', object: '表格' }] },
  ];
  const r = findOverlap(assets);
  assert.equal(r.ok, true);
  const ids = r.pairs.map((p) => [p.a, p.b].sort().join('|'));
  assert.ok(ids.includes('ast-a|ast-b'), '相似工作流应检测为重叠');
  assert.ok(!ids.some((x) => x.includes('ast-c')), '无关资产不误报');
  const pair = r.pairs[0];
  assert.ok(pair.jaccard >= 0.35);
  assert.ok(pair.suggestion.includes('建议保留'));
});

test('HTTP 链路：score → decide（含高危）→ overlap', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-policy-'));
  const TOKEN = crypto.randomBytes(32).toString('hex');
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    const sc = await (await jzFetch(s.baseUrl, '/api/policy/score', {
      method: 'POST', token: TOKEN,
      body: { source: 'self', version: '1.0.0', description: '自建资产，功能描述足够详细', usage: '帮助', installedAt: '2026-08-29T00:00:00Z', fileSizeBytes: 3000 },
    })).json();
    assert.equal(sc.data.score >= 80, true, `自建+完整元数据应高分，实际 ${sc.data.score}`);
    assert.ok(Array.isArray(sc.data.breakdown) && sc.data.breakdown.length >= 3);

    const dc = await (await jzFetch(s.baseUrl, '/api/policy/decide', {
      method: 'POST', token: TOKEN, body: { trustScore: 85, action: 'publish' },
    })).json();
    assert.equal(dc.data.decision, 'require-confirm', 'publish 高危必须确认');

    // overlap：先放两条相似资产再查
    addAsset({ kind: 'workflow', title: '每日早报生成', content: '早报', steps: [{ stepId: 's1', action: '生成', object: '早报' }], sourceRefs: ['task-p1'], root });
    addAsset({ kind: 'workflow', title: '每日早报汇总', content: '早报', steps: [{ stepId: 's1', action: '生成', object: '早报' }], sourceRefs: ['task-p2'], root });
    const ov = await (await jzFetch(s.baseUrl, '/api/policy/overlap?kind=workflow', { method: 'GET', token: TOKEN })).json();
    assert.ok(ov.data.pairs.length >= 1, '相似资产应检测出重叠对');
  } finally {
    await s.close();
  }
});
