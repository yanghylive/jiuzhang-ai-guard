'use strict';
// 回归测试（V0.2 handoff 交接包）：创建 → 预览（冲突检测）→ 应用（两阶段恢复）→ 回滚留档；
// 密码错误拒绝、文件篡改拒绝、路径穿越拒绝、幂等键重放、confirmToken 门禁。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRouterServer, jzFetch } = require('./_helpers');
const { createHandoff, previewHandoff, applyHandoff } = require('../scripts/jz/handoff');

const TOKEN = crypto.randomBytes(32).toString('hex');
const PASS = 'handoff-e2e-pass';

function mkFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-hf-root-'));
  const wb = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-hf-wb-'));
  fs.writeFileSync(path.join(root, 'settings.json'), '{"theme":"dark","locale":"zh-CN"}');
  fs.mkdirSync(path.join(wb, 'app'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'IDENTITY.md'), '# SOURCE-MACHINE\n');
  fs.writeFileSync(path.join(wb, 'app', 'sessions.json'), '[{"id":"s1","title":"交接测试"}]');
  return { root, wb };
}

test('handoff：创建 → 预览（含冲突检测）→ 应用（恢复+留档），内容 hash 一致', async () => {
  const src = mkFixture();
  // 创建
  const c = createHandoff({ root: src.root, wbDir: src.wb, passphrase: PASS, label: '换机交接', sourceRefs: [{ slug: 'test-source', version: '1.0', distilledAt: new Date().toISOString() }] });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.ok(String(c.file).endsWith('.jzhandoff'), '必须生成 .jzhandoff');
  assert.ok(c.sourceRefs.length === 1, 'sourceRefs 必须保留溯源');
  const handoffPath = path.join(src.root, 'exports', c.file);
  assert.ok(fs.existsSync(handoffPath), '交接包文件存在');

  // 预览（目标机：新 root + 已有冲突文件）；模拟跨设备传输：拷贝交接包到目标机 exports/
  const dst = mkFixture();
  fs.mkdirSync(path.join(dst.root, 'exports'), { recursive: true });
  fs.copyFileSync(handoffPath, path.join(dst.root, 'exports', c.file));
  fs.writeFileSync(path.join(dst.wb, 'IDENTITY.md'), '# TARGET-EXISTING\n'); // 制造冲突
  const pv = previewHandoff({ file: c.file, sourceKind: 'export', passphrase: PASS, root: dst.root, wbDir: dst.wb });
  assert.equal(pv.ok, true, JSON.stringify(pv));
  assert.equal(pv.preview.source.label, '换机交接');
  assert.ok(pv.preview.items.length >= 3, `条目数 ${pv.preview.items.length} >= 3`);
  assert.ok(pv.preview.conflictCount >= 1, 'IDENTITY.md 应命中冲突');
  assert.ok(pv.preview.conflicts.some((x) => x.sourceRel === 'IDENTITY.md'), '冲突列表含 IDENTITY.md');
  assert.ok(pv.preview.items.every((it) => it.sourceRel && it.scopeType && it.sha256), '条目元数据完整');

  // 密码错误 → 拒绝（不泄露原因）
  const bad = previewHandoff({ file: c.file, sourceKind: 'export', passphrase: 'wrong-pass', root: dst.root });
  assert.equal(bad.ok, false);
  assert.ok(['BACKUP_CORRUPTED', 'HANDOFF_CORRUPTED'].includes(bad.error));

  // 应用（skip 冲突策略 → 目标 IDENTITY.md 不被覆盖）
  const ap = await applyHandoff({ file: c.file, sourceKind: 'export', passphrase: PASS, conflictPolicy: 'skip', root: dst.root, wbDir: dst.wb });
  assert.equal(ap.ok, true, JSON.stringify(ap));
  assert.equal(fs.readFileSync(path.join(dst.wb, 'IDENTITY.md'), 'utf8'), '# TARGET-EXISTING\n', 'skip 策略保留目标文件');
  assert.equal(fs.readFileSync(path.join(dst.root, 'settings.json'), 'utf8'), '{"theme":"dark","locale":"zh-CN"}', 'settings 恢复一致');
  assert.equal(fs.readFileSync(path.join(dst.wb, 'app', 'sessions.json'), 'utf8'), '[{"id":"s1","title":"交接测试"}]', 'sessions 恢复一致');
  // 交接留档
  const idx = JSON.parse(fs.readFileSync(path.join(dst.root, 'runtime', 'handoff-index.json'), 'utf8'));
  assert.equal(idx.entries.length, 1);
  assert.equal(idx.entries[0].sourceRefs[0].slug, 'test-source', '留档保留溯源');
});

test('handoff：replace 策略覆盖目标；敏感目录/符号链接/路径穿越拒绝', async () => {
  const src = mkFixture();
  const c = createHandoff({ root: src.root, wbDir: src.wb, passphrase: PASS });
  const dst = mkFixture();
  fs.mkdirSync(path.join(dst.root, 'exports'), { recursive: true });
  fs.copyFileSync(path.join(src.root, 'exports', c.file), path.join(dst.root, 'exports', c.file));
  fs.writeFileSync(path.join(dst.root, 'settings.json'), '{"theme":"old"}');
  const ap = await applyHandoff({ file: c.file, sourceKind: 'export', passphrase: PASS, conflictPolicy: 'replace', root: dst.root, wbDir: dst.wb });
  assert.equal(ap.ok, true, JSON.stringify(ap));
  assert.equal(fs.readFileSync(path.join(dst.root, 'settings.json'), 'utf8'), '{"theme":"dark","locale":"zh-CN"}', 'replace 覆盖目标');

  // 路径穿越文件名 → 拒绝
  const trav = previewHandoff({ file: '..\\..\\etc\\passwd', sourceKind: 'export', passphrase: PASS, root: dst.root });
  assert.equal(trav.ok, false);
  assert.equal(trav.error, 'INVALID_REQUEST');

  // 符号链接文件 → 拒绝
  const evilName = 'evil.jzhandoff';
  if (process.platform !== 'win32') {
    const link = path.join(dst.root, 'exports', evilName);
    try {
      fs.symlinkSync('/etc/hosts', link);
      const sl = previewHandoff({ file: evilName, sourceKind: 'export', passphrase: PASS, root: dst.root });
      assert.equal(sl.ok, false, '符号链接交接包必须拒绝');
      assert.equal(sl.error, 'INVALID_REQUEST');
    } finally {
      try { fs.rmSync(link, { force: true }); } catch {}
    }
  }
});

test('handoff HTTP：create/preview/apply 全链路（confirmToken + 幂等键 + previewId 单次 + 篡改拒绝）', async () => {
  const root = mkFixture().root;
  const wb = mkFixture().wb;
  const s = await startRouterServer({ root, token: TOKEN });
  try {
    const getConfirm = async (scope) => (await (await jzFetch(s.baseUrl, '/api/auth/confirm', { method: 'POST', token: TOKEN, body: { scope } })).json()).data.confirmToken;

    // create：缺 confirmToken → 403；带 token + 幂等键 → 200
    const noConfirm = await jzFetch(s.baseUrl, '/api/handoff/create', { method: 'POST', token: TOKEN, body: { passphrase: PASS, label: 'http-交接' } });
    assert.equal(noConfirm.status, 403, 'HIGH_RISK 缺 confirmToken 必须 403');
    const c1 = await jzFetch(s.baseUrl, '/api/handoff/create', {
      method: 'POST', token: TOKEN,
      body: { passphrase: PASS, label: 'http-交接', idempotencyKey: 'handoff-http-key-01', confirmToken: await getConfirm('POST /api/handoff/create') },
    });
    const cj = await c1.json();
    assert.equal(c1.status, 200, JSON.stringify(cj));
    const hf = cj.data.file;

    // preview（read 风险，无需 confirm）→ previewId
    const pv = await jzFetch(s.baseUrl, '/api/handoff/preview', { method: 'POST', token: TOKEN, body: { file: hf, sourceKind: 'export', passphrase: PASS } });
    const pj = await pv.json();
    assert.equal(pv.status, 200, JSON.stringify(pj));
    const previewId = pj.data.previewId;
    assert.ok(previewId, 'preview 必须返回 previewId');

    // apply：缺 confirm → 403；带 confirm+previewId+幂等键 → 200；恢复内容一致
    const aNoConfirm = await jzFetch(s.baseUrl, '/api/handoff/apply', { method: 'POST', token: TOKEN, body: { file: hf, sourceKind: 'export', passphrase: PASS, previewId } });
    assert.equal(aNoConfirm.status, 403);
    const ap = await jzFetch(s.baseUrl, '/api/handoff/apply', {
      method: 'POST', token: TOKEN,
      body: { file: hf, sourceKind: 'export', passphrase: PASS, previewId, conflictPolicy: 'skip', idempotencyKey: 'handoff-http-key-02', confirmToken: await getConfirm('POST /api/handoff/apply') },
    });
    const aj = await ap.json();
    assert.equal(ap.status, 200, JSON.stringify(aj));
    assert.equal(aj.data.restore.ok, true);
    // apply 后内容与源一致
    assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{"theme":"dark","locale":"zh-CN"}');

    // previewId 单次：复用 → 410
    const again = await jzFetch(s.baseUrl, '/api/handoff/apply', {
      method: 'POST', token: TOKEN,
      body: { file: hf, sourceKind: 'export', passphrase: PASS, previewId, conflictPolicy: 'skip', idempotencyKey: 'handoff-http-key-03', confirmToken: await getConfirm('POST /api/handoff/apply') },
    });
    assert.equal(again.status, 410, 'previewId 只能使用一次');

    // 篡改交接包后 apply（新 preview）→ 409 PREVIEW_STALE。
    // 篡改必须保持 JSON 合法（append 会破坏解析，属另一种拒绝路径）：改内容字段
    const hp = path.join(root, 'exports', hf);
    const tamper = (tag) => {
      const cur = fs.readFileSync(hp, 'utf8').replace(/"label":\s*"[^"]*"/, '"label": "' + tag + '"');
      fs.writeFileSync(hp, cur);
    };
    tamper('TAMPERED');
    const pv2 = await jzFetch(s.baseUrl, '/api/handoff/preview', { method: 'POST', token: TOKEN, body: { file: hf, sourceKind: 'export', passphrase: PASS } });
    const pj2 = await pv2.json();
    assert.equal(pv2.status, 200, '合法 JSON 篡改后预览仍应成功（拿到新 previewId）');
    tamper('TAMPERED-AGAIN'); // preview 后再改 → checksum 不一致
    const tampered = await jzFetch(s.baseUrl, '/api/handoff/apply', {
      method: 'POST', token: TOKEN,
      body: { file: hf, sourceKind: 'export', passphrase: PASS, previewId: pj2.data.previewId, conflictPolicy: 'skip', idempotencyKey: 'handoff-http-key-04', confirmToken: await getConfirm('POST /api/handoff/apply') },
    });
    const tjson = await tampered.json();
    assert.equal(tampered.status, 409, '预览后被篡改必须 409 PREVIEW_STALE（实际 ' + tampered.status + ' ' + JSON.stringify(tjson).slice(0, 160) + '）');
    assert.equal(tjson.error, 'PREVIEW_STALE');
  } finally {
    await s.close();
  }
});
