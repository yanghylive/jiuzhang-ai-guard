'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BALL_TOL, hasBallCenter, runBallCleanup } = require('./e2e/fab-restore-sabotage');

test('球心必须同时具备有限的 x/y 坐标，0 是合法坐标', () => {
  assert.equal(hasBallCenter({ cx: 0, cy: 0 }), true);
  assert.equal(hasBallCenter({ cx: 0, cy: undefined }), false);
  assert.equal(hasBallCenter({ cx: NaN, cy: 10 }), false);
  assert.equal(hasBallCenter(null), false);
});

test('球位善后：实验前、当前、拖回后三个读点任一缺坐标都 fail closed', async () => {
  const beforeMissing = await runBallCleanup(async () => {
    throw new Error('快照不完整时不应连接 CDP');
  }, { cx: 100 });
  assert.match(beforeMissing, /无完整坐标/);

  const currentMissing = await runBallCleanup(async (fn) => fn({
    ev: async () => JSON.stringify({ cx: 100 }),
  }), { cx: 100, cy: 100 });
  assert.match(currentMissing, /坐标缺失/);

  let read = 0;
  const finalMissing = await runBallCleanup(async (fn) => fn({
    ev: async () => JSON.stringify(read++ === 0 ? { cx: 100, cy: 100 } : { cx: 100 }),
  }), { cx: 100, cy: 100 });
  assert.match(finalMissing, /坐标缺失/);
});

test('球位善后：屏幕边缘 x/y 为 0 时不应误判为坐标缺失', async () => {
  let reads = 0;
  const result = await runBallCleanup(async (fn) => fn({
    ev: async () => {
      reads += 1;
      return JSON.stringify({ cx: 0, cy: 0 });
    },
  }), { cx: 0, cy: 0 });

  assert.equal(result, null);
  assert.equal(reads, 2);
  assert.equal(BALL_TOL, 40);
});
