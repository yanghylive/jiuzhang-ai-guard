'use strict';
// 2026-08-29 复核 P1 回归：diagnostics previewId 安全校验（防路径穿越读任意文件）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preview, upload } = require('../scripts/jz/diagnostics');

test('previewId 校验（P1）：穿越 ID 被拒（PREVIEW_NOT_FOUND），不读任意文件', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-diag-safe-'));
  // 先造一个合法 preview
  const pv = preview({ root });
  assert.equal(pv.ok, true);
  // 穿越/非法 previewId → PREVIEW_NOT_FOUND（不会去读对应路径）
  for (const evil of ['../../package.json', '/etc/passwd', '..', 'a/b', 'x'.repeat(200), 'not-a-uuid']) {
    const r = await upload({ previewId: evil, root });
    assert.equal(r.ok, false, `非法 previewId ${evil} 必须拒绝`);
    assert.equal(r.error, 'PREVIEW_NOT_FOUND');
  }
  // 合法 previewId 在未配置端点时 → NOT_CONFIGURED（说明 ID 校验通过后走后续逻辑）
  delete process.env.JZ_DIAGNOSTICS_ENDPOINT;
  const r2 = await upload({ previewId: pv.previewId, root });
  assert.equal(r2.error, 'DIAGNOSTICS_UPLOAD_NOT_CONFIGURED');
});
