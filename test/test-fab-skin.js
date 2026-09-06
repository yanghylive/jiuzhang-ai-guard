'use strict';
// 挂件形象 ui-state 持久化（2026-09-04 产品负责人：换形象+线稿，设置页切换）：
// 1) GET /api/settings/ui-state 默认返回 fabCharacter='blob' / fabSketch=false
// 2) POST fabCharacter 白名单（blob|nimbo|twinkle）通过，非法值静默忽略
// 3) POST fabSketch 布尔持久化；与 theme 等既有字段共存互不破坏
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startRouterServer, jzFetch } = require('./_helpers');

const TOKEN = crypto.randomBytes(32).toString('hex');

function setupRoot() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-fabskin-'));
}

async function getUiState(baseUrl) {
  const r = await jzFetch(baseUrl, '/api/settings/ui-state', { token: TOKEN });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.ok, true);
  return d.data;
}

async function postUiState(baseUrl, body) {
  const r = await jzFetch(baseUrl, '/api/settings/ui-state', { method: 'POST', token: TOKEN, body });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.ok, true);
  return d;
}

test('挂件形象：默认 blob + 不线稿；nimbo 合法值持久化', async () => {
  const root = setupRoot();
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    let st = await getUiState(s.baseUrl);
    assert.equal(st.fabCharacter, 'blob');
    assert.equal(st.fabSketch, false);

    await postUiState(s.baseUrl, { fabCharacter: 'nimbo' });
    st = await getUiState(s.baseUrl);
    assert.equal(st.fabCharacter, 'nimbo');

    await postUiState(s.baseUrl, { fabSketch: true });
    st = await getUiState(s.baseUrl);
    assert.equal(st.fabSketch, true);
    assert.equal(st.fabCharacter, 'nimbo'); // 互不覆盖
  } finally { await s.close(); }
});

test('挂件形象：非法 character 白名单拦截（静默忽略，不落库不炸）', async () => {
  const root = setupRoot();
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    await postUiState(s.baseUrl, { fabCharacter: 'nimbo' });
    for (const evil of ['evil', '', 'NIMBO', null, 123, ['nimbo'], { x: 1 }]) {
      await postUiState(s.baseUrl, { fabCharacter: evil });
    }
    const st = await getUiState(s.baseUrl);
    assert.equal(st.fabCharacter, 'nimbo');
  } finally { await s.close(); }
});

test('挂件形象：与既有 theme 字段共存，持久化文件落盘', async () => {
  const root = setupRoot();
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    await postUiState(s.baseUrl, { theme: 'light', fabCharacter: 'twinkle', fabSketch: true });
    const st = await getUiState(s.baseUrl);
    assert.equal(st.theme, 'light');
    assert.equal(st.fabCharacter, 'twinkle');
    assert.equal(st.fabSketch, true);
    const files = fs.readdirSync(root);
    assert.ok(files.some((f) => f.includes('settings')), 'settings 持久化文件应存在于数据目录');
  } finally { await s.close(); }
});

test('挂件偏好：注入层串行写入，ui-state 读回必须等待写入队列', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(source, /var fabSkinWriteQueue = Promise\.resolve\(\);/);
  assert.match(source, /return fabSkinWriteQueue\.then\(function \(\) \{\s*return apiJz\('\/api\/settings\/ui-state'\);/);
  assert.match(source, /var write = fabSkinWriteQueue\.then\(save, save\);/);
  assert.match(source, /fabSkinWriteQueue = write\.catch\(function \(\) \{\}\);/);
});

test('挂件探针：运行前把线稿归一到关闭，避免用户偏好反转测试语义', () => {
  const source = fs.readFileSync(path.join(__dirname, 'e2e', 'fab-skin-probe.js'), 'utf8');
  assert.match(source, /const normalizedSkin = JSON\.parse\(await ev\(readSkinState\)\);/);
  assert.match(source, /if \(normalizedSkin\.sk\) \{/);
  assert.match(source, /开工归一：线稿从开启临时归一到关闭/);
});

test('挂件探针：眼神采样预算与球心校验保持 fail-closed', () => {
  const source = fs.readFileSync(path.join(__dirname, 'e2e', 'fab-skin-probe.js'), 'utf8');
  assert.match(source, /const MAXR = 36;/);
  assert.match(source, /const hasBallCenter = \(p\) => !!p && Number\.isFinite\(p\.cx\) && Number\.isFinite\(p\.cy\);/);
  assert.match(source, /if \(!hasBallCenter\(cur\)\) throw new Error\('归位前球心坐标缺失/);
  assert.match(source, /if \(!hasBallCenter\(fin\) \|\| Math\.abs\(fin\.cx - fabRestore\.x\)/);
});
