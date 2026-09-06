'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { ensureTrialStart, getTrialState, isUnlocked } = require('../scripts/jz/trial.js');

function tmpRoot(name) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), name));
  fs.mkdirSync(path.join(root, 'license'), { recursive: true });
  return root;
}

test('试用期：首次启动写入 trialStartAt，试用期内解锁', () => {
  const root = tmpRoot('jz-trial-');
  const t = ensureTrialStart(root);
  assert.equal(typeof t.trialStartAt, 'string');
  const state = getTrialState(root, Date.now());
  assert.equal(state.expired, false);
  assert.equal(isUnlocked(root, null, Date.now()), true);
});

test('试用期：7 天后过期未付费 → 全锁', () => {
  const root = tmpRoot('jz-trial-');
  ensureTrialStart(root);
  const now = Date.now() + 8 * 24 * 60 * 60 * 1000; // 8 天后（> 7 天试用期，v1.1.1）
  assert.equal(isUnlocked(root, null, now), false);
  assert.equal(getTrialState(root, now).expired, true);
});

test('付费：entitlement active 未过期 → 解锁（即使超过试用期）', () => {
  const root = tmpRoot('jz-trial-');
  ensureTrialStart(root);
  const now = Date.now() + 8 * 24 * 60 * 60 * 1000; // 8 天后（> 7 天试用期）
  const ent = { status: 'active', plan: 'PRO', validUntil: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() };
  assert.equal(isUnlocked(root, ent, now), true);
});

test('付费：entitlement active 但已过期 → 锁', () => {
  const root = tmpRoot('jz-trial-');
  ensureTrialStart(root);
  const now = Date.now() + 8 * 24 * 60 * 60 * 1000; // 8 天后（> 7 天试用期）
  const ent = { status: 'active', plan: 'PRO', validUntil: new Date(Date.now() - 1000).toISOString() };
  assert.equal(isUnlocked(root, ent, now), false);
});

test('付费：终身会员（validUntil 空）→ 解锁', () => {
  const root = tmpRoot('jz-trial-');
  ensureTrialStart(root);
  const now = Date.now() + 8 * 24 * 60 * 60 * 1000; // 8 天后（> 7 天试用期）
  const ent = { status: 'active', plan: 'PRO', validUntil: null };
  assert.equal(isUnlocked(root, ent, now), true);
});

test('防篡改：手改 trialStartAt（无合法 MAC）→ 从锚点恢复，不重置', () => {
  const root = tmpRoot('jz-trial-');
  ensureTrialStart(root);
  const p = path.join(root, 'license', 'trial.json');
  // 攻击者把 trialStartAt 改成 10 天前（伪造过期，且无 MAC；trialDurationHours 字段不参与判定——getTrialState 按实时 trialHours() 计算）
  fs.writeFileSync(p, JSON.stringify({ trialStartAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(), trialDurationHours: 168 }));
  // ensureTrialStart 应检测 MAC 不符 → 从锚点恢复原 trialStartAt → 现在应未过期
  const state = getTrialState(root, Date.now());
  assert.equal(state.expired, false);
});

test('防删除重置：删主文件 trial.json → 从锚点恢复，trialStartAt 不变', () => {
  const root = tmpRoot('jz-trial-');
  const first = ensureTrialStart(root);
  const startBefore = first.trialStartAt;
  // 删主文件
  fs.rmSync(path.join(root, 'license', 'trial.json'), { force: true });
  // 从锚点恢复，trialStartAt 应保持原值（不重置）
  const restored = ensureTrialStart(root);
  assert.equal(restored.trialStartAt, startBefore);
});

test('防删除重置：删锚点文件 → 从主文件恢复，trialStartAt 不变', () => {
  const root = tmpRoot('jz-trial-');
  const first = ensureTrialStart(root);
  const startBefore = first.trialStartAt;
  // 删锚点文件
  fs.rmSync(path.join(root, 'runtime', 'trial-anchor.json'), { force: true });
  // 主文件仍在 → trialStartAt 保持原值
  const restored = ensureTrialStart(root);
  assert.equal(restored.trialStartAt, startBefore);
});
