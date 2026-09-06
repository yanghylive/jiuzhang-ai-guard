'use strict';
// 旧目录实体迁移测试：migrateLegacyEntities copy-if-absent 幂等、无旧实体静默跳过。
// 注：不测 migrateLegacyDataDir 的平台默认目录判定（依赖 HOME 环境），只测可注入的实体复制核心。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyEntities } = require('../scripts/lib');

function tmp() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-mig-'));
}

test('migrateLegacyEntities：themes/stash 目录 + 3 个散文件全部迁入', () => {
  const src = tmp();
  const dst = tmp();
  // 造旧目录实体
  fs.mkdirSync(path.join(src, 'themes', 'nebula'), { recursive: true });
  fs.writeFileSync(path.join(src, 'themes', 'nebula', 'theme.json'), '{"id":"nebula"}');
  fs.writeFileSync(path.join(src, 'themes', 'flat.json'), '{}');
  fs.mkdirSync(path.join(src, 'stash'), { recursive: true });
  fs.writeFileSync(path.join(src, 'stash', 'k1'), 'prompt-1');
  fs.writeFileSync(path.join(src, 'stash-index.json'), '[{"key":"k1"}]');
  fs.writeFileSync(path.join(src, 'current-theme.json'), '{"id":"nebula"}');
  fs.writeFileSync(path.join(src, 'mask.json'), '{"opacity":0.5}');

  const counts = migrateLegacyEntities(src, dst);
  assert.equal(counts.themes, 2, '应迁入 2 个主题条目');
  assert.equal(counts.stash, 1, '应迁入 1 条暂存');
  assert.equal(counts.files, 3, '应迁入 3 个散文件');
  // 实体落位校验
  assert.equal(fs.readFileSync(path.join(dst, 'themes', 'nebula', 'theme.json'), 'utf8'), '{"id":"nebula"}');
  assert.equal(fs.readFileSync(path.join(dst, 'stash', 'k1'), 'utf8'), 'prompt-1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dst, 'current-theme.json'), 'utf8')).id, 'nebula');
  // 权限：目录 0700 / 文件 0600（Windows 上 chmod 只支持只读位，mode 恒为 0o666，跳过精确断言）
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dst, 'themes')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dst, 'current-theme.json')).mode & 0o777, 0o600);
  }
});

test('migrateLegacyEntities：幂等——目标已存在绝不覆盖', () => {
  const src = tmp();
  const dst = tmp();
  fs.mkdirSync(path.join(src, 'stash'), { recursive: true });
  fs.writeFileSync(path.join(src, 'stash', 'k1'), 'old-content');
  fs.writeFileSync(path.join(src, 'current-theme.json'), '{"id":"from-legacy"}');
  // 目标先存在且内容不同
  fs.mkdirSync(path.join(dst, 'stash'), { recursive: true });
  fs.writeFileSync(path.join(dst, 'stash', 'k1'), 'new-content');
  fs.writeFileSync(path.join(dst, 'current-theme.json'), '{"id":"keep-current"}');

  const counts = migrateLegacyEntities(src, dst);
  assert.equal(counts.stash, 0, '已存在的 stash 不应计入');
  assert.equal(counts.files, 0, '已存在的散文件不应计入');
  assert.equal(fs.readFileSync(path.join(dst, 'stash', 'k1'), 'utf8'), 'new-content', '目标内容必须保持');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dst, 'current-theme.json'), 'utf8')).id, 'keep-current');
});

test('migrateLegacyEntities：无旧实体 → 零计数零副作用（防御式静默跳过）', () => {
  const src = tmp(); // 空目录
  const dst = tmp();
  const counts = migrateLegacyEntities(src, dst);
  // 2026-08-30：counts 增加 skippedSymlinks 字段（符号链接逃逸防护计数）
  assert.deepEqual(counts, { themes: 0, stash: 0, files: 0, skippedSymlinks: 0 });
  assert.equal(fs.readdirSync(dst).length, 0, '不应在目标创建任何东西');
  // 源根本不存在也不抛
  assert.doesNotThrow(() => migrateLegacyEntities(path.join(src, 'nope'), dst));
});

test('migrateLegacyEntities：sourceRoot 为空/null 安全返回', () => {
  const dst = tmp();
  assert.deepEqual(migrateLegacyEntities(null, dst), { themes: 0, stash: 0, files: 0, skippedSymlinks: 0 });
});
