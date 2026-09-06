'use strict';
// 2026-08-30 复核 P1 回归：旧目录迁移的符号链接逃逸。
// 旧实现 statSync（跟随链接）+ cpSync（保留链接）→ themes 符号链接被复制成指向目录外部的链接。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyEntities } = require('../scripts/lib');

test('迁移防符号链接逃逸：themes 为指向外部目录的链接 → 跳过，不复制为链接', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-mig-symlink-'));
  const src = path.join(base, 'legacy');
  const dst = path.join(base, 'data');
  const outside = path.join(base, 'outside-secret');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
  // themes 是指向数据目录外部的符号链接
  fs.symlinkSync(outside, path.join(src, 'themes'), 'dir');

  const counts = migrateLegacyEntities(src, dst);
  // 不应迁移：目标不存在 or 存在但不是指向外部的链接（绝不能是指向 outside 的链接）
  const themesPath = path.join(dst, 'themes');
  const leaked = fs.existsSync(themesPath) && fs.lstatSync(themesPath).isSymbolicLink();
  assert.equal(leaked, false, 'themes 不得被复制为指向外部的符号链接');
  assert.ok(counts.skippedSymlinks >= 1, `应记录跳过的符号链接数，实际 ${JSON.stringify(counts)}`);
});

test('迁移正常目录：目录内符号链接被跳过，普通文件正常复制', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jz-mig-ok-'));
  const src = path.join(base, 'legacy');
  const dst = path.join(base, 'data');
  const outside = path.join(base, 'outside2');
  fs.mkdirSync(path.join(src, 'stash'), { recursive: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'x.txt'), 'X');
  // stash 内：1 个正常文件 + 1 个指向外部的链接
  fs.writeFileSync(path.join(src, 'stash', 'normal.txt'), 'hello');
  fs.symlinkSync(outside, path.join(src, 'stash', 'evil-link'), 'dir');

  const counts = migrateLegacyEntities(src, dst);
  const normalDst = path.join(dst, 'stash', 'normal.txt');
  assert.ok(fs.existsSync(normalDst), '正常文件应被复制');
  assert.equal(fs.readFileSync(normalDst, 'utf8'), 'hello');
  const linkDst = path.join(dst, 'stash', 'evil-link');
  const leaked = fs.existsSync(linkDst) && fs.lstatSync(linkDst).isSymbolicLink();
  assert.equal(leaked, false, '目录内符号链接不得被复制为链接');
  assert.ok(counts.stash >= 1, '应计入正常迁移的文件数');
});
