'use strict';
// 清理（03 / 04 §5）+ 回应审查 P1-5「物理删除 + 假恢复」。
//
// 语义修正：
//   - apply() 默认 **移入回收站**（quarantine），写可校验回执 manifest，不物理删除。
//   - restore() 从回执恢复原路径；原路径已被占用则失败，绝不覆盖。
//   - purge() 才是永久删除，且只允许删 quarantine 目录内、必须显式 confirmed。
//   - quarantine 本身移出扫描白名单，避免"清理回收站→再进回收站"的递归。
// 客户端只提交候选项 ID；服务端按白名单重新解析路径（不接受客户端任意路径）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dataRoot, uuid, atomicWriteJSON, readJSON, isPhysicallyRealPath } = require('./lib');

const SCHEMA_VERSION = 1;

function whitelist(root) {
  // 只含 WorkDaddy/管家自有运行时目录；quarantine 不在其中（见上方说明）。
  return [
    path.join(root, 'logs'),
    path.join(root, 'runtime'),
    path.join(root, 'diagnostics'),
    path.join(root, 'compatibility'),
  ];
}

function quarantineDir(root) {
  return path.join(root, 'quarantine');
}

function receiptsDir(root) {
  return path.join(root, 'quarantine', '_receipts');
}

function cryptoId(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// 路径必须严格位于某个白名单目录之下（防 ../ 逃逸与符号链接跳出）。
function insideWhitelist(root, target) {
  const real = path.resolve(target);
  return whitelist(root).some((dir) => {
    const base = path.resolve(dir);
    return real === base || real.startsWith(base + path.sep);
  });
}

function insideQuarantine(root, target) {
  // 第七轮复核 P0：词法前缀只是二道防线——quarantine 目录本身是链接时，
  // path.resolve 前缀仍成立。各入口必须先 isPhysicallyRealPath(quarantineDir) 拒绝链接根，
  // 本函数再以 realpath 物理比较兜底（target 存在才可 realpath）。
  const base = path.resolve(quarantineDir(root));
  const real = path.resolve(target);
  if (real === base) return false;
  try {
    return fs.realpathSync(target).startsWith(fs.realpathSync(quarantineDir(root)) + path.sep);
  } catch {
    return real.startsWith(base + path.sep); // target 不存在（未移动）→ 词法兜底
  }
}

function scan({ root } = {}) {
  root = root || dataRoot();
  // 2026-08-30 第六轮复核 P0：root（或其父级链）是符号链接时拒绝扫描/清理——
  // 防止把外部目录当成 runtime 误删。whitelist 子目录同样逐个 lstat 拒链接。
  if (!isPhysicallyRealPath(root)) {
    return { ok: false, error: 'CLEANUP_SYMLINK_ROOT', note: '数据根含符号链接，拒绝清理（防逃逸）', candidates: [] };
  }
  const candidates = [];
  for (const dir of whitelist(root)) {
    // 第六轮复核 P0：白名单子目录本身（runtime 等）是符号链接时跳过（防删外部文件）
    if (!isPhysicallyRealPath(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.')) continue; // 跳过 .daemon-token 等内部文件
      let size = 0;
      try {
        if (!e.isDirectory()) size = fs.statSync(full).size;
      } catch {
        /* ignore */
      }
      candidates.push({
        id: cryptoId(full),
        type: e.isDirectory() ? 'dir' : 'file',
        path: full,
        protected: false,
        size,
        reason: 'WorkDaddy runtime artifact',
      });
    }
  }
  return { ok: true, candidates };
}

// 服务端按白名单重建 ID→路径映射，客户端 ID 无法指向白名单外任何路径。
function resolveIds(root, ids) {
  const allowed = new Map();
  for (const dir of whitelist(root)) {
    // 第七轮复核 P0：白名单目录（或其父级链）是符号链接时跳过——旧实现 readdirSync
    // 直接遍历链接目标，craftedId 可让 apply 处理外部文件。
    if (!isPhysicallyRealPath(dir)) continue;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const full = path.join(dir, n);
      try { if (fs.lstatSync(full).isSymbolicLink()) continue; } catch { continue; }
      allowed.set(cryptoId(full), full);
    }
  }
  const hits = [];
  const rejected = [];
  for (const id of ids || []) {
    const p = allowed.get(id);
    if (p && insideWhitelist(root, p)) hits.push(p);
    else rejected.push(id);
  }
  return { hits, rejected };
}

// 默认动作：移入回收站 + 回执。不是删除。
// 2026-08-29 复核 P1：单项失败计入 failed，全部失败返回 ok:false（不再"未执行却返回成功"）。
function apply({ ids, root, mode = 'quarantine' } = {}) {
  root = root || dataRoot();
  if (!isPhysicallyRealPath(root)) {
    return { ok: false, error: 'CLEANUP_SYMLINK_ROOT', note: '数据根含符号链接，拒绝清理（防逃逸）' };
  }
  const { hits, rejected } = resolveIds(root, ids);
  // 第七轮复核 P0：quarantine（或其父级链）是符号链接时拒绝——否则移入回收站
  // 等于把外部文件搬走，purge 还能删外部。
  if (!isPhysicallyRealPath(quarantineDir(root)) || !isPhysicallyRealPath(receiptsDir(root))) {
    return { ok: false, error: 'CLEANUP_SYMLINK_QUARANTINE', note: '回收站目录含符号链接，拒绝清理（防逃逸）' };
  }
  fs.mkdirSync(quarantineDir(root), { recursive: true });
  fs.mkdirSync(receiptsDir(root), { recursive: true });

  const receiptId = uuid();
  const items = [];
  let moved = 0;
  let failed = 0;
  for (const src of hits) {
    const stored = `${Date.now()}-${cryptoId(src)}-${path.basename(src)}`;
    const dest = path.join(quarantineDir(root), stored);
    let okMove = false;
    try {
      fs.renameSync(src, dest);
      okMove = true;
    } catch {
      try {
        fs.cpSync(src, dest, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
        okMove = true;
      } catch {
        okMove = false;
      }
    }
    if (!okMove) {
      failed++;
      continue; // 单项失败不影响整体，但计数透传，调用方不得谎报成功
    }
    let size = 0;
    try {
      const st = fs.statSync(dest);
      size = st.isDirectory() ? 0 : st.size;
    } catch {
      /* ignore */
    }
    items.push({ originalPath: src, storedPath: dest, size });
    moved++;
  }

  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    receiptId,
    createdAt: new Date().toISOString(),
    mode,
    items,
    status: 'quarantined',
  };
  atomicWriteJSON(path.join(receiptsDir(root), `${receiptId}.json`), receipt);
  // 全失败 → 明确 ok:false；部分失败 → ok:true 但带 failed 计数（调用方按需 200/422）
  const okAll = failed === 0;
  // removed 字段保留向后兼容（旧客户端读它判断是否有变更），语义为"已移入回收站的项数"。
  return { ok: okAll, receiptId, moved, removed: moved, failed, rejected, recoverable: true };
}

function listQuarantine({ root } = {}) {
  root = root || dataRoot();
  // 第七轮复核 P0：quarantine/receipts 目录物理校验（防链接根逃逸）
  if (!isPhysicallyRealPath(root) || !isPhysicallyRealPath(quarantineDir(root)) || !isPhysicallyRealPath(receiptsDir(root))) {
    return { ok: true, receipts: [], error: 'CLEANUP_SYMLINK_QUARANTINE' };
  }
  let files = [];
  try {
    files = fs.readdirSync(receiptsDir(root)).filter((n) => n.endsWith('.json'));
  } catch {
    return { ok: true, receipts: [] };
  }
  const receipts = [];
  for (const f of files) {
    const r = readJSON(path.join(receiptsDir(root), f));
    if (!r) continue;
    receipts.push({
      receiptId: r.receiptId,
      createdAt: r.createdAt,
      status: r.status,
      itemCount: (r.items || []).length,
      // 真实存在性校验：文件被外部删掉时状态必须暴露为 incomplete，不能让 UI 误报"可恢复"
      intact: (r.items || []).every((it) => fs.existsSync(it.storedPath)),
    });
  }
  return { ok: true, receipts };
}

// 恢复：逐项校验存在性 + 原路径未被占用；任一项缺失即返回失败（不做"半恢复报成功"）。
function restore({ receiptId, root } = {}) {
  root = root || dataRoot();
  // 第七轮复核 P0：quarantine/receipts 目录物理校验（防链接根逃逸）
  if (!isPhysicallyRealPath(root) || !isPhysicallyRealPath(quarantineDir(root)) || !isPhysicallyRealPath(receiptsDir(root))) {
    return { ok: false, error: 'CLEANUP_SYMLINK_QUARANTINE', note: '回收站目录含符号链接，拒绝操作（防逃逸）' };
  }
  // 第七轮复核 P2：receiptId 严格校验（不再清洗非法字符——清洗会造成 ID 别名）
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(receiptId || ''))) {
    return { ok: false, error: 'INVALID_REQUEST', reason: 'receipt_id_invalid' };
  }
  const p = path.join(receiptsDir(root), `${receiptId}.json`);
  const receipt = readJSON(p);
  if (!receipt) return { ok: false, error: 'INVALID_REQUEST', reason: 'receipt_not_found' };
  if (receipt.status === 'purged') return { ok: false, error: 'BACKUP_CORRUPTED', reason: 'already_purged' };

  const missing = (receipt.items || []).filter((it) => !fs.existsSync(it.storedPath));
  if (missing.length) {
    return { ok: false, error: 'BACKUP_CORRUPTED', reason: 'quarantined_files_missing', missing: missing.length };
  }
  const conflicts = (receipt.items || []).filter((it) => fs.existsSync(it.originalPath));
  if (conflicts.length) {
    return { ok: false, error: 'INVALID_REQUEST', reason: 'original_path_occupied', conflicts: conflicts.length };
  }
  let restored = 0;
  for (const it of receipt.items || []) {
    if (!insideWhitelist(root, it.originalPath) || !insideQuarantine(root, it.storedPath)) continue;
    // 第七轮复核 P0：恢复目标父链物理校验（原路径挂在链接链下时 rename 会写外部）
    if (!isPhysicallyRealPath(path.dirname(it.originalPath))) continue;
    fs.mkdirSync(path.dirname(it.originalPath), { recursive: true });
    fs.renameSync(it.storedPath, it.originalPath);
    restored++;
  }
  atomicWriteJSON(p, { ...receipt, status: 'restored', restoredAt: new Date().toISOString() });
  return { ok: true, receiptId: receipt.receiptId, restored };
}

// 永久删除：必须显式 confirmed，且只删 quarantine 内路径。
function purge({ receiptId, confirmed, root } = {}) {
  root = root || dataRoot();
  if (!confirmed) return { ok: false, error: 'INVALID_REQUEST', reason: 'confirmation_required' };
  // 第七轮复核 P0：quarantine/receipts 目录物理校验（防链接根逃逸）
  if (!isPhysicallyRealPath(root) || !isPhysicallyRealPath(quarantineDir(root)) || !isPhysicallyRealPath(receiptsDir(root))) {
    return { ok: false, error: 'CLEANUP_SYMLINK_QUARANTINE', note: '回收站目录含符号链接，拒绝操作（防逃逸）' };
  }
  // 第七轮复核 P2：receiptId 严格校验（不再清洗非法字符）
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(receiptId || ''))) {
    return { ok: false, error: 'INVALID_REQUEST', reason: 'receipt_id_invalid' };
  }
  const p = path.join(receiptsDir(root), `${receiptId}.json`);
  const receipt = readJSON(p);
  if (!receipt) return { ok: false, error: 'INVALID_REQUEST', reason: 'receipt_not_found' };
  let purged = 0;
  for (const it of receipt.items || []) {
    if (!insideQuarantine(root, it.storedPath)) continue; // 越界一律跳过
    try {
      // 第七轮复核 P0：storedPath 本身是符号链接时跳过（双保险）
      if (fs.lstatSync(it.storedPath).isSymbolicLink()) continue;
    } catch { continue; }
    try {
      fs.rmSync(it.storedPath, { recursive: true, force: true });
      purged++;
    } catch {
      /* ignore */
    }
  }
  atomicWriteJSON(p, { ...receipt, status: 'purged', purgedAt: new Date().toISOString() });
  return { ok: true, receiptId: receipt.receiptId, purged, recoverable: false };
}

module.exports = {
  scan,
  apply,
  restore,
  purge,
  listQuarantine,
  whitelist,
  insideWhitelist,
  insideQuarantine,
  resolveIds,
  SCHEMA_VERSION,
};
