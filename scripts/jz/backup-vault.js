'use strict';
// 备份保险箱（06）。AES-256-GCM + 唯一 nonce；manifest 不存 token/明文；导出 JZVAULT 格式；
// 恢复失败不覆盖原数据；错误密码只返回统一失败。本实现以本地数据根作演示源（真实接入 WorkBuddy 用户数据目录）。
//
// 修 Bug 执行指导（2026-08-29）落地要点：
//   - 导出：服务端受控目录 exports/，文件名服务端生成，返回 exportId + 下载接口；拒绝客户端任意路径。
//   - 导入：只接受 exports/ 或 staging/ 下的受控文件；保留 scopeType/sourceRel 元数据；
//     缺关键路径信息的旧备份标记 restoreUnsafe（schema migration），恢复时绝不猜路径。
//   - 恢复：两阶段（预检全部通过才落盘）+ 逐文件快照 + 失败逆序回滚；conflictPolicy 三值严格区分。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dataRoot, workbuddyDir, uuid, atomicWriteJSON, readJSON, isPhysicallyRealPath } = require('./lib');
const { loadOrCreateDataKey, encrypt, decrypt, deriveKeyFromPassphrase, IV_LEN } = require('./crypto-vault');
const { redact } = require('./redact');
const { beginRestoreProgress, finishRestoreProgress, failRestoreProgress } = require('./restore-progress');

// scope → 源条目。**显式白名单**（2026-08-29 复查 P1）：只备份明确允许的配置/身份文件，
// 绝不递归打包会话内容目录 —— blob_storage / shared_proto_db 等可能含 Cookie、OAuth、
// 会话正文等登录态敏感数据，一律排除（原实现整目录递归打包，导出件可能携带登录态）。
// accounts/sessions 映射到 WorkBuddy 用户数据目录；**不含登录 token**（不落明文 token）。
// 返回 [{ path, rel }]：rel 为相对 base 的路径（用于恢复时还原目录结构）。
// 06-D62：备份写入前磁盘空间估算。剩余空间 < 源总大小 + 余量时拒绝（不写半截备份）。
// 平台不支持 statfs（返回 null）时不阻断，遵循「平台允许时」原则。
const BACKUP_DISK_MARGIN = Number(process.env.JZ_BACKUP_DISK_MARGIN) || 16 * 1024 * 1024;
// 敏感目录黑名单：源路径出现这些标记即跳过（防御未来 scopeSources 误加整目录递归）。
const SENSITIVE_DIR_MARKERS = ['blob_storage', 'shared_proto_db', 'session_storage', 'local_storage', 'cookies', 'network'];
// 恢复作用域白名单（06 §2）：manifest.scopeType 只允许这些值，白名单外一律视为不可安全恢复。
const SCOPE_WHITELIST = ['accounts', 'sessions', 'settings', 'theme'];
// 导出产物默认有效期 / 最大下载次数（下载链接策略：过期、超次拒绝）。
const EXPORT_TTL_MS = Number(process.env.JZ_EXPORT_TTL_MS) || 15 * 60 * 1000;
const EXPORT_MAX_DOWNLOADS = Number(process.env.JZ_EXPORT_MAX_DOWNLOADS) || 3;
// 导入文件大小上限（原始 .jzvault 字节数），防内存/磁盘耗尽。
const IMPORT_MAX_BYTES = Number(process.env.JZ_IMPORT_MAX_BYTES) || 256 * 1024 * 1024;

function diskFreeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

function walkDir(dir, base) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // 跳过隐藏文件（.DS_Store 等）
    if (e.isSymbolicLink()) continue; // 复查 P2（第五轮）：符号链接绝不跟随（防把目录外文件打进备份）
    const full = path.join(dir, e.name);
    if (SENSITIVE_DIR_MARKERS.some((m) => e.name.toLowerCase().includes(m))) continue; // 敏感目录绝不进备份
    if (e.isDirectory()) out.push(...walkDir(full, base));
    else out.push({ path: full, rel: toPosixRel(path.relative(base, full)) });
  }
  return out;
}

// 源路径敏感标记防御：任何一层目录命中黑名单 → 跳过该条目。
function isSensitiveSource(p, base) {
  const rel = path.relative(base, p).toLowerCase();
  return SENSITIVE_DIR_MARKERS.some((m) => rel.split(path.sep).some((seg) => seg.includes(m)));
}

function scopeSources(scope, root, wbDir) {
  const wb = wbDir || workbuddyDir();
  // 2026-08-30 第六轮复核 P0：备份源根目录（或其父级链）是符号链接时拒绝备份——
  // 旧实现只对最终文件 lstat，wbDir 挂在链接链下时外部文件会被打进保险箱。
  if (!isPhysicallyRealPath(root) || !isPhysicallyRealPath(wb)) {
    throw Object.assign(new Error('备份源目录含符号链接，拒绝备份（防逃逸）'), { code: 'BACKUP_SOURCE_SYMLINK' });
  }
  const map = {
    settings: [{ path: path.join(root, 'settings.json'), base: root }],
    accounts: [
      { path: path.join(wb, 'IDENTITY.md'), base: wb },
      { path: path.join(wb, 'USER.md'), base: wb },
      { path: path.join(wb, 'SOUL.md'), base: wb },
      { path: path.join(wb, 'device-id'), base: wb },
      { path: path.join(wb, 'app', 'app-config.json'), base: wb },
    ],
    // sessions 只备显式白名单文件（会话索引/配置）；blob_storage、shared_proto_db 等
    // 会话内容目录一律不进备份（复查 P1：导出件不得携带登录态/会话正文）
    sessions: [
      { path: path.join(wb, 'app', 'sessions.json'), base: wb },
    ],
    theme: [],
  };
  const entries = [];
  for (const s of scope || []) {
    for (const item of map[s] || []) {
      let st;
      try {
        st = fs.lstatSync(item.path); // 复查 P2（第五轮）：lstat 不跟随符号链接 —— 白名单文件若是链接，跳过
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // 防把工作目录外的文件读进备份
      // 敏感路径防御：命中黑名单标记的条目一律不进备份（复查 P1）
      if (isSensitiveSource(item.path, item.base)) continue;
      if (st.isDirectory()) entries.push(...walkDir(item.path, item.base).map((e) => ({ ...e, scope: s })));
      else entries.push({ path: item.path, rel: toPosixRel(path.relative(item.base, item.path)), scope: s });
    }
  }
  return entries;
}

function _u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
function _rdU32(buf, off) {
  return buf.readUInt32BE(off);
}

// 相对路径安全校验：非空、非绝对路径、不含 .. 穿越（防御目录备份恢复时越界）。
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  // 第十一轮复核修复（跨平台 bug）：旧实现 path.normalize 在 Windows 上把 `/` 归一化成
  // `\` → 所有 POSIX 相对路径（sourceRel、恢复目标）全被拒 → 嵌套文件恢复 0 项。
  // 现改为统一 POSIX 视图解析，不依赖 path.normalize/sep（跨平台一致）：
  //   拒绝反斜杠转义（已归一）、拒绝 ../、拒绝绝对路径（/ 开头或盘符）、拒绝空段。
  const posix = rel.replace(/\\/g, '/');
  if (posix.startsWith('/')) return false;                    // Unix 绝对路径
  if (/^[A-Za-z]:/.test(posix)) return false;                 // Windows 盘符绝对路径
  if (posix.split('/').some((seg) => seg === '..')) return false; // 路径穿越
  if (posix.split('/').some((seg) => seg === '')) return false;   // 空段（// 或尾斜杠）
  return true;
}

// 2026-08-30 第四轮复核 P1（修复）：备份清单里的相对路径统一 POSIX（/）分隔。
// Windows 上 path.relative 产生 `app\sessions.json`，而 safeRel 拒绝反斜杠 →
// 嵌套文件（sessions.json / app-config.json）会被标 unsafe、恢复时静默丢失。
// 生成侧统一转 POSIX；safeRel 继续拒 `\` 作为恶意 manifest 的防线；
// 恢复写入用 path.join（各平台把 / 正确映射为本地分隔符）。
function toPosixRel(rel) {
  // 显式替换 \\ 为 /（不依赖 path.sep）：macOS 上开发/测试也要能归一化 Windows 形式
  return String(rel || '').replace(/\\/g, '/');
}

// 2026-08-30 第四轮复核 P1：从 base 到 target 的已存在路径段逐段 lstat，
// 任一段是符号链接 → true（写入会落到链接指向的外部目录）。
// base 本身不检查（调用方保证），只查中间段与最终目标。
function isSymlinkInChain(target, base) {
  const rel = path.relative(base || path.parse(target).root, target);
  if (!rel || rel.startsWith('..')) return false;
  let cur = base || path.parse(target).root;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      /* 段尚不存在（将由 mkdirSync 创建）→ 继续往下查已存在的段 */
    }
  }
  return false;
}

// 2026-08-30 第五轮复核 P0：目标根目录本身不得是符号链接（fail-closed）。
// restoreBackup 内以 Map 缓存按 base 查询结果，避免每个条目重复 lstat。
function targetBaseOk(base, cache) {
  if (!base) return false;
  if (cache && cache.has(base)) return cache.get(base);
  // 2026-08-30 第六轮复核 P0：升级为物理 realpath 校验——base 本身是链接、或其
  // 父级链上有链接（root/parent-link → 外部）都拒绝。第五轮只查 base 本身，
  // 实测父级链接时 restore ok:true 并写外部。
  const ok = isPhysicallyRealPath(base);
  if (cache) cache.set(base, ok);
  return ok;
}

// backupId 安全校验（2026-08-29 复核 P1）：backupId 直接进 manifest/blob 路径，
// 只接受 uuid 或 [A-Za-z0-9_-] 字符集、长度受限，杜绝路径穿越。
const BACKUP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function assertSafeBackupId(backupId) {
  const s = String(backupId || '');
  if (!s || !BACKUP_ID_RE.test(s)) return null;
  return s;
}

// 2026-08-30 复核 P2：manifest 里的 relativePath 统一过 safeRel 再拼路径。
// 此前只有写入侧校验，读取侧（verify/preview/restore）直接 path.join —— 恶意/损坏
// manifest 可携带 ../ 逃出 blobs 目录读任意文件。返回 null 表示非法。
function safeBlobPath(blobsDir, rel) {
  if (!safeRel(rel)) return null;
  return path.join(blobsDir, rel);
}

// 2026-08-30 第四轮复核 P1（修复）：blob 读取统一入口——safeBlobPath 字符串校验之外，
// 再 lstat 物理校验：blob 被替换为指向外部的符号链接时拒绝读取（verify/export/preview/
// restore 全部走这里，字符串校验挡不住链接本身）。
function readBlobStrict(blobsDir, rel, itemId) {
  const blobPath = safeBlobPath(blobsDir, rel);
  if (!blobPath) return { err: 'unsafe_relative_path' };
  try {
    const st = fs.lstatSync(blobPath);
    if (st.isSymbolicLink()) return { err: 'blob_is_symlink' };
  } catch {
    return { err: 'missing' };
  }
  try {
    return { buf: fs.readFileSync(blobPath) };
  } catch {
    return { err: 'missing' };
  }
}

function manifestPath(root, backupId) {
  const safe = assertSafeBackupId(backupId);
  if (!safe) throw new Error(`非法 backupId: ${String(backupId).slice(0, 64)}`);
  return path.join(root, 'backups', 'manifests', `${safe}.json`);
}

// manifest 文件字节 sha256：预览/恢复之间检测备份是否被改动（06 §6 预览绑定）。
function manifestSha256(root, backupId) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(manifestPath(root, backupId))).digest('hex');
  } catch {
    return null;
  }
}

// backupId 为空 → 解析为最近一次（createdAt 最大）的完整备份；没有任何备份 → null（调用方返回 NO_BACKUP）。
// 非空 backupId 必须通过安全校验，否则返回 null（调用方 400 拒绝）。
function resolveBackupId(root, backupId) {
  if (backupId && String(backupId).trim()) return assertSafeBackupId(backupId);
  const dir = path.join(root, 'backups', 'manifests');
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const m = readJSON(path.join(dir, f));
      if (!m || !m.backupId) continue;
      if (!best || String(m.createdAt || '') > String(best.createdAt || '')) best = m;
    }
  } catch {
    return null;
  }
  return best ? assertSafeBackupId(best.backupId) : null;
}

function createBackup({ scope, reason, root, wbDir, _diskFree } = {}) {
  root = root || dataRoot();
  const key = loadOrCreateDataKey(root);
  const backupId = uuid();
  const manifest = {
    schemaVersion: 1,
    backupId,
    createdAt: new Date().toISOString(),
    reason: reason || 'manual',
    source: {
      platform: process.platform,
      arch: process.arch,
      profile: process.env.JZ_PROFILE || 'workbuddy-cn',
      workdaddyVersion: process.env.JZ_VERSION || '0.0.0',
    },
    items: [],
    integrity: 'unknown',
  };
  const blobsDir = path.join(root, 'backups', 'blobs', backupId);
  const sources = scopeSources(scope, root, wbDir);
  // 06-D62：写入前估算磁盘空间（源总大小 + 余量）；不足 → 拒绝，不创建半截备份目录。
  let totalSize = 0;
  for (const src of sources) {
    try {
      totalSize += fs.statSync(src.path).size;
    } catch {
      /* 单文件统计失败不阻断估算 */
    }
  }
  const free = _diskFree !== undefined ? _diskFree : diskFreeBytes(root);
  if (free !== null && totalSize > 0 && free < totalSize + BACKUP_DISK_MARGIN) {
    try { fs.rmSync(blobsDir, { recursive: true, force: true }); } catch {}
    return {
      ok: false,
      error: 'INSUFFICIENT_DISK_SPACE',
      free,
      required: totalSize + BACKUP_DISK_MARGIN,
      detail: `磁盘空间不足（剩余 ${(free / 1048576).toFixed(0)}MB < 需要 ${((totalSize + BACKUP_DISK_MARGIN) / 1048576).toFixed(0)}MB），拒绝备份避免半截备份`,
    };
  }
  try {
    fs.mkdirSync(blobsDir, { recursive: true });
  } catch (e) {
    // 只读目录/低磁盘等在入口处显式失败，绝不包装成 ok:true（P1 修复：备份失败假成功）
    const code = e && (e.code === 'ENOSPC' || e.code === 'EDQUOT') ? 'INSUFFICIENT_DISK_SPACE'
      : e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') ? 'BACKUP_PERMISSION_DENIED'
      : 'BACKUP_WRITE_FAILED';
    return { ok: false, error: code, detail: e.message };
  }
  for (const src of sources) {
    let buf;
    try {
      buf = fs.readFileSync(src.path);
    } catch (e) {
      try { fs.rmSync(blobsDir, { recursive: true, force: true }); } catch {}
      return { ok: false, error: 'BACKUP_SOURCE_UNREADABLE', detail: `${src.rel}: ${e.message}` };
    }
    const { iv, tag, ciphertext } = encrypt(key, buf);
    const itemId = uuid();
    const rel = `${itemId}.bin`;
    try {
      fs.mkdirSync(blobsDir, { recursive: true });
      fs.writeFileSync(path.join(blobsDir, rel), Buffer.concat([iv, tag, ciphertext]));
    } catch (e) {
      try { fs.rmSync(blobsDir, { recursive: true, force: true }); } catch {}
      // 低磁盘/权限不足/目标被锁在此显式失败，绝不包装成 ok:true（P1 修复：备份失败假成功）
      const code = e && (e.code === 'ENOSPC' || e.code === 'EDQUOT') ? 'INSUFFICIENT_DISK_SPACE'
        : e && (e.code === 'EACCES' || e.code === 'EPERM') ? 'BACKUP_PERMISSION_DENIED'
        : 'BACKUP_WRITE_FAILED';
      return { ok: false, error: code, detail: `${src.rel}: ${e.message}` };
    }
    manifest.items.push({
      itemId,
      type: path.extname(src.path).slice(1) || 'file',
      scopeType: src.scope || 'settings',
      relativePath: rel,
      sourceRel: src.rel,
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      encrypted: true,
    });
  }
  // manifest 落盘（复查 P2：两次写入统一守护 —— 失败清理 blobs 半成品，绝不留 orphan blob /
  // integrity:unknown 的半成品 manifest；API 层因此能返回结构化失败而非 500）
  const writeManifest = () => {
    manifest.integrity = 'verified';
    atomicWriteJSON(manifestPath(root, backupId), manifest);
  };
  try {
    atomicWriteJSON(manifestPath(root, backupId), { ...manifest, integrity: 'unknown' });
    writeManifest();
  } catch (e) {
    try { fs.rmSync(blobsDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(manifestPath(root, backupId), { force: true }); } catch {}
    const code = e && (e.code === 'ENOSPC' || e.code === 'EDQUOT') ? 'INSUFFICIENT_DISK_SPACE'
      : e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') ? 'BACKUP_PERMISSION_DENIED'
      : 'BACKUP_WRITE_FAILED';
    return { ok: false, error: code, detail: `manifest 写入失败: ${e.message}` };
  }
  return { ok: true, backupId, manifest: redact(manifest) };
}

function verifyBackup({ backupId, root } = {}) {
  root = root || dataRoot();
  const manifest = readJSON(manifestPath(root, backupId));
  if (!manifest) return { ok: false, error: 'BACKUP_CORRUPTED' };
  // 2026-08-30 第五轮复核 P2：items 缺失/非数组的损坏 manifest 稳定返回
  // BACKUP_CORRUPTED（不抛未包装异常 → 500）
  if (!manifest || !Array.isArray(manifest.items)) {
    return { ok: false, error: 'BACKUP_CORRUPTED', reason: 'manifest_items_missing' };
  }
  const key = loadOrCreateDataKey(root);
  const blobsDir = path.join(root, 'backups', 'blobs', backupId);
  for (const item of manifest.items) {
    // 2026-08-30 第四轮复核 P1：readBlobStrict 统一入口（safeRel 字符串校验 + lstat 物理拒链接）
    const got = readBlobStrict(blobsDir, item.relativePath, item.itemId);
    if (got.err) {
      return { ok: false, error: 'BACKUP_CORRUPTED', reason: got.err, itemId: item.itemId };
    }
    let buf = got.buf;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + 16);
    const ct = buf.subarray(IV_LEN + 16);
    let plain;
    try {
      plain = decrypt(key, iv, tag, ct);
    } catch {
      return { ok: false, error: 'BACKUP_CORRUPTED' };
    }
    if (crypto.createHash('sha256').update(plain).digest('hex') !== item.sha256) {
      return { ok: false, error: 'BACKUP_CORRUPTED' };
    }
  }
  return { ok: true, backupId, integrity: 'verified' };
}

function listBackups(root) {
  root = root || dataRoot();
  const dir = path.join(root, 'backups', 'manifests');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      // 2026-08-30 复核 P2：只读真实文件，符号链接一律跳过（防指向外部的恶意 manifest）
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => redact(readJSON(path.join(dir, e.name))))
      // 2026-08-30 第五轮复核 P2：损坏 manifest（缺 items/非数组）不进列表，
      // 防止下游 enforceRetention/verify 遍历 undefined.items 抛异常；
      // backupId 必须过白名单（防穿越 id 进入 enforceRetention 的 rmSync）
      .filter((m) => m && Array.isArray(m.items) && assertSafeBackupId(m.backupId));
  } catch {
    return [];
  }
}

// scope 归一化：null/undefined → null（全部）；数组 → 去重排序；含非法值 → 抛 INVALID_SCOPE。
function normalizeScope(scope) {
  if (scope === undefined || scope === null) return null;
  if (!Array.isArray(scope)) throw Object.assign(new Error('scope 必须是数组'), { code: 'INVALID_SCOPE' });
  const arr = [...new Set(scope.map((s) => String(s)))].sort();
  for (const s of arr) {
    if (!SCOPE_WHITELIST.includes(s)) throw Object.assign(new Error(`未知作用域: ${s}`), { code: 'INVALID_SCOPE' });
  }
  return arr;
}

// 恢复预览：不落盘、不写真实目录。返回 manifestSha256 供 /api/vault/restore 绑定校验。
async function previewRestore({ backupId, scope, root, wbDir: wbDirArg } = {}) {
  root = root || dataRoot();
  const normScope = normalizeScope(scope);
  const manifest = readJSON(manifestPath(root, backupId));
  if (!manifest) return { ok: false, error: 'BACKUP_CORRUPTED' };
  const wbDir = wbDirArg || workbuddyDir();
  // scopeType → 目标基路径：settings 落本数据根，accounts/sessions 落 WorkBuddy 用户数据目录
  const baseOf = (scopeType) => (scopeType === 'settings' ? root : wbDir);
  const items = [];
  for (const it of manifest.items || []) {
    // scope 过滤：预览只针对请求的作用域（与恢复一致，防止「预览 A 范围、恢复 B 范围」）
    if (normScope && !normScope.includes(it.scopeType || 'settings')) continue;
    const meta = itemMeta(it);
    const targetPath = path.join(baseOf(meta.scopeType), meta.safe ? meta.sourceRel : meta.itemId);
    let action = 'add';
    let conflict = false;
    if (!meta.safe) {
      action = 'unsafe';
    } else {
      try {
        const st = fs.statSync(targetPath);
        if (st.isFile()) {
          const curHash = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
          if (curHash === it.sha256) action = 'skip';
          else { action = 'conflict'; conflict = true; }
        } else { action = 'conflict'; conflict = true; }
      } catch {
        action = 'add'; // 目标不存在 → 新增恢复
      }
    }
    items.push({
      itemId: it.itemId,
      type: it.type,
      scopeType: meta.scopeType,
      sourceRel: meta.safe ? meta.sourceRel : null,
      relativePath: it.relativePath,
      action,
      conflict,
      size: it.size || 0,
      unsafeReason: meta.safe ? null : meta.unsafeReason,
    });
  }
  const summary = { add: 0, conflict: 0, skip: 0, unsafe: 0, restore: 0 };
  for (const i of items) {
    summary[i.action] = (summary[i.action] || 0) + 1;
    if (i.action === 'add' || i.action === 'conflict') summary.restore += 1;
  }
  return {
    ok: true,
    backupId,
    scope: normScope,
    items,
    summary,
    manifestSha256: manifestSha256(root, backupId),
  };
}

// 条目元数据校验：scopeType 白名单 + sourceRel safeRel。不安全条目恢复时必须跳过，绝不猜路径。
function itemMeta(item) {
  const scopeType = SCOPE_WHITELIST.includes(item.scopeType) ? item.scopeType : null;
  // 2026-08-30 第五轮复核 P2（修复）：旧 Windows 备份的 sourceRel 是 `app\sessions.json`
  //（反斜杠），safeRel 直接拒绝 → 恢复静默跳过。先 toPosixRel 归一化再校验：
  // `..\` 归一化后仍含 ../ 会被拒绝（归一化不放宽恶意路径，只兼容旧格式分隔符）。
  const posixRel = item.sourceRel === undefined ? undefined : toPosixRel(item.sourceRel);
  const safe = !!scopeType && safeRel(posixRel);
  return {
    scopeType: scopeType || 'settings',
    sourceRel: safe ? posixRel : String(item.sourceRel || ''),
    safe,
    unsafeReason: !scopeType
      ? `scope_type_invalid:${item.scopeType === undefined ? 'missing' : item.scopeType}`
      : !safe
        ? `source_rel_unsafe:${item.sourceRel === undefined ? 'missing' : 'rejected'}`
        : null,
  };
}

// 恢复（两阶段，06 §6「恢复失败不覆盖原数据」）。
//   applyToReal=false（默认）：写入 <root>/restored/ 子目录，不触碰真实目标。
//   applyToReal=true：真实落盘。两阶段：
//     ① 预检：全部 blob 读取、解密、hash 校验、目标路径解析、磁盘空间估算——任何一项失败都不写真实目录；
//     ② 应用：逐文件快照 → temp+fsync+rename 原子替换；任一步失败按快照逆序回滚已替换文件。
//   conflictPolicy（调用方已做白名单校验）：replace=备份覆盖目标 / keep-current=目标已存在且不同则跳过 /
//     skip=目标已存在即跳过（无论内容是否相同）。
async function restoreBackup({ backupId, scope, conflictPolicy, applyToReal, root, wbDir: wbDirArg } = {}) {
  const v = verifyBackup({ backupId, root: root || dataRoot() });
  if (!v.ok) return v;
  root = root || dataRoot();
  let normScope;
  try {
    normScope = normalizeScope(scope);
  } catch (e) {
    return { ok: false, error: e.code || 'INVALID_REQUEST' };
  }
  const key = loadOrCreateDataKey(root);
  const manifest = readJSON(manifestPath(root, backupId));
  const blobsDir = path.join(root, 'backups', 'blobs', backupId);
  const policy = conflictPolicy === 'replace' ? 'replace' : conflictPolicy === 'skip' ? 'skip' : 'keep-current';
  const wbDir = wbDirArg || workbuddyDir();
  const baseOf = (scopeType) => (scopeType === 'settings' ? root : wbDir);

  // ===== 阶段①：预检（只读，不写真实目录）=====
  const plan = [];
  let plainTotal = 0;
  for (const item of manifest.items) {
    if (normScope && !normScope.includes(item.scopeType || 'settings')) continue;
    const meta = itemMeta(item);
    // 2026-08-30 第四轮复核 P1：readBlobStrict（safeRel + lstat 物理拒链接）
    const got = readBlobStrict(blobsDir, item.relativePath, item.itemId);
    if (got.err) return { ok: false, error: 'BACKUP_CORRUPTED', reason: got.err, itemId: item.itemId };
    const buf = got.buf;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + 16);
    const ct = buf.subarray(IV_LEN + 16);
    let plain;
    try {
      plain = decrypt(key, iv, tag, ct);
    } catch {
      return { ok: false, error: 'BACKUP_CORRUPTED', itemId: item.itemId };
    }
    if (crypto.createHash('sha256').update(plain).digest('hex') !== item.sha256) {
      return { ok: false, error: 'BACKUP_CORRUPTED', itemId: item.itemId };
    }
    plainTotal += plain.length;
    // 2026-08-30 第四轮复核：sourceRel 统一 POSIX 化（旧 Windows 备份可能含 `\`，
    // 直接 join 在 macOS 会变成文件名里带反斜杠；POSIX 形式各平台 path.join 都正确）
    const relPart = meta.safe ? toPosixRel(meta.sourceRel) : item.itemId; // unsafe 条目仅用于计数展示，实际跳过
    const targetBase = applyToReal ? baseOf(meta.scopeType) : path.join(root, 'restored');
    plan.push({ item, plain, meta, relPart, targetBase, dest: path.join(targetBase, relPart) });
  }
  // 预检：磁盘空间（目标 settings 根 + WorkBuddy 目录所在卷）
  if (applyToReal && plan.length) {
    const free = diskFreeBytes(root);
    if (free !== null && free < plainTotal + BACKUP_DISK_MARGIN) {
      return {
        ok: false,
        error: 'INSUFFICIENT_DISK_SPACE',
        free,
        required: plainTotal + BACKUP_DISK_MARGIN,
      };
    }
  }

  // ===== 阶段②：应用 =====
  // 恢复前快照（独立于待恢复备份）：记录恢复动作前目标文件的当前状态，供回滚/审计
  const snapshotId = uuid();
  const snapshotDir = path.join(root, 'quarantine', `restore-snapshot-${snapshotId}`);
  if (applyToReal) {
    // 第七轮复核 P0：恢复快照目录物理校验——quarantine 是链接时快照会写到外部
    //（外部写入 + 敏感数据泄露双风险）
    if (!isPhysicallyRealPath(path.join(root, 'quarantine'))) {
      return { ok: false, error: 'RESTORE_FAILED', reason: 'quarantine_symlink', note: '回收站目录含符号链接，拒绝快照（防逃逸）' };
    }
    fs.mkdirSync(snapshotDir, { recursive: true });
    // 06-D59：applyToReal 写进行中标记；中断/失败后启动可见「恢复未完成」，绝不自动继续。
    beginRestoreProgress({ backupId, snapshotId, root });
  }
  let restored = 0;
  let skipped = 0;
  let skippedUnsafe = 0;
  const applied = []; // 已替换条目（逆序回滚用）
  const unsafeItems = [];
  const tmpFiles = [];
  const targetBaseCache = new Map(); // 第五轮复核 P0：targetBase 符号链接校验缓存
  const fail = (payload) => {
    // 清理本进程产生的临时文件
    for (const t of tmpFiles) {
      try { fs.rmSync(t, { force: true }); } catch {}
    }
    return payload;
  };
  try {
    for (const p of plan) {
      const { item, plain, meta, dest } = p;
      if (!meta.safe) {
        // 缺 scopeType/sourceRel 的旧备份条目：标记不可安全恢复，绝不猜路径（指导 §6）
        skippedUnsafe++;
        unsafeItems.push({ itemId: item.itemId, reason: meta.unsafeReason });
        continue;
      }
      // 2026-08-30 第五轮复核 P0：目标**根目录本身**是符号链接时（isSymlinkInChain
      // 跳过 base，中间段查不到它），恢复会 ok:true 并写入外部目录。对 targetBase
      // 物理 lstat，链接即该条目 unsafe 跳过（按 base 缓存，同 base 只查一次）。
      if (!targetBaseOk(p.targetBase, targetBaseCache)) {
        skippedUnsafe++;
        unsafeItems.push({ itemId: item.itemId, reason: 'restore_target_root_symlink' });
        continue;
      }
      // 2026-08-30 第四轮复核 P1：目标父目录链物理校验 —— WorkBuddy/app 等中间目录
      // 被替换为指向外部的符号链接时，恢复文件会写到目录之外。逐段 lstat（从目标基
      // 目录开始，绝不从文件系统根扫——/var 等系统段本身是链接会全量误判），
      // 任一为链接即标记 unsafe 跳过（fail-closed，不写）。
      if (isSymlinkInChain(path.dirname(dest), p.targetBase)) {
        skippedUnsafe++;
        unsafeItems.push({ itemId: item.itemId, reason: 'restore_target_symlink' });
        continue;
      }
      const destExists = fs.existsSync(dest);
      // 冲突策略：skip=目标存在即跳过；keep-current=目标存在且内容不同则跳过；replace=覆盖
      if (destExists && policy === 'skip') {
        skipped++;
        continue;
      }
      if (applyToReal && destExists) {
        // 快照目标当前内容（存在才快照；恢复后如需回滚可从此目录取回）
        const snap = path.join(snapshotDir, meta.sourceRel);
        try {
          fs.mkdirSync(path.dirname(snap), { recursive: true });
          fs.cpSync(dest, snap, { recursive: true, force: true });
        } catch (e) {
          return fail({ ok: false, error: 'RESTORE_FAILED', reason: `snapshot_failed: ${e.message}`, rollback: rollbackApplied() });
        }
        if (policy === 'keep-current') {
          let same = false;
          try {
            same = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === item.sha256;
          } catch {
            /* 读取失败按不同处理，走跳过 */
          }
          if (!same) {
            skipped++;
            continue;
          }
        }
      }
      // 原子替换：temp + fsync + rename（同目录内 rename 保证原子性）
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = `${dest}.jzrestore-${uuid().slice(0, 8)}.tmp`;
        tmpFiles.push(tmp);
        const fh = fs.openSync(tmp, 'w');
        try {
          fs.writeSync(fh, plain);
          fs.fsyncSync(fh);
        } finally {
          fs.closeSync(fh);
        }
        fs.renameSync(tmp, dest);
      } catch (e) {
        // 写入失败：先回滚已替换文件，再返回可识别错误（绝不半覆盖返回成功）
        const rb = applyToReal ? rollbackApplied() : null;
        if (applyToReal) {
          failRestoreProgress({ backupId, snapshotId, reason: `${e.code || 'WRITE_FAILED'}: ${e.message}`, root });
        }
        return fail({
          ok: false,
          error: 'RESTORE_FAILED',
          reason: `${e.code || 'WRITE_FAILED'}: ${e.message}`,
          itemId: item.itemId,
          rollback: rb,
        });
      }
      applied.push({ itemId: item.itemId, dest, sourceRel: meta.sourceRel, scopeType: meta.scopeType, hadSnapshot: destExists });
      restored++;
    }
  } finally {
    tmpFiles.length = 0;
  }
  if (applyToReal) finishRestoreProgress({ backupId, snapshotId, restored, skipped, root });
  return {
    ok: true,
    backupId,
    snapshotId,
    snapshotDir: applyToReal ? snapshotDir : undefined,
    restored,
    skipped,
    skippedUnsafe,
    unsafeItems: unsafeItems.length ? unsafeItems : undefined,
    applied: applyToReal ? applied : undefined,
    conflictPolicy: policy,
    mode: applyToReal ? 'apply' : 'preview',
  };

  // 回滚：按快照逆序把已替换文件恢复原状；回滚也失败 → rollback_failed，保留快照供人工恢复。
  function rollbackApplied() {
    const rolledBack = [];
    const failed = [];
    for (let i = applied.length - 1; i >= 0; i--) {
      const a = applied[i];
      try {
        const snap = path.join(snapshotDir, a.sourceRel);
        if (a.hadSnapshot && fs.existsSync(snap)) {
          fs.mkdirSync(path.dirname(a.dest), { recursive: true });
          fs.cpSync(snap, a.dest, { recursive: true, force: true });
        } else {
          fs.rmSync(a.dest, { force: true, recursive: true });
        }
        rolledBack.push({ itemId: a.itemId, dest: a.dest });
      } catch (e) {
        failed.push({ itemId: a.itemId, dest: a.dest, error: e.message });
      }
    }
    if (failed.length) {
      // 回滚失败：保留快照目录供人工恢复，绝不返回普通成功
      return { status: 'rollback_failed', rolledBack, failed, snapshotDir };
    }
    // 回滚全部成功：清理快照（原状态已还原，快照无保留价值）
    try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch {}
    return { status: 'rolled_back', rolledBack };
  }
}

// ===== 导出（服务端受控目录，指导 §5）=====
function exportsDir(root) {
  return path.join(root, 'exports');
}
function exportsIndexPath(root) {
  return path.join(exportsDir(root), 'index.json');
}
function loadExportIndex(root) {
  const idx = readJSON(exportsIndexPath(root));
  return idx && Array.isArray(idx.entries) ? idx : { entries: [] };
}
function saveExportIndex(root, idx) {
  atomicWriteJSON(exportsIndexPath(root), idx);
}
// 过期产物清理：每次导出/列表时顺带执行（惰性清理，无后台定时器）。
function sweepExports(root, now = Date.now()) {
  const idx = loadExportIndex(root);
  let changed = false;
  for (const e of idx.entries) {
    if (new Date(e.expiresAt).getTime() < now) {
      try { fs.rmSync(path.join(exportsDir(root), e.file), { force: true }); } catch {}
      e.expired = true;
      changed = true;
    }
  }
  if (changed) saveExportIndex(root, { entries: idx.entries.filter((e) => !e.expired) });
}

function exportBackup({ backupId, passphrase, root } = {}) {
  root = root || dataRoot();
  const resolved = resolveBackupId(root, backupId);
  if (!resolved) return { ok: false, error: 'NO_BACKUP', detail: '数据目录中没有任何备份可导出' };
  const manifest = readJSON(manifestPath(root, resolved));
  if (!manifest) return { ok: false, error: 'BACKUP_CORRUPTED' };
  if (typeof passphrase !== 'string' || !passphrase.length) {
    return { ok: false, error: 'INVALID_REQUEST', detail: 'passphrase 不能为空' };
  }
  const salt = crypto.randomBytes(16);
  const pkey = deriveKeyFromPassphrase(passphrase, salt);
  const dkey = loadOrCreateDataKey(root);
  const blobsDir = path.join(root, 'backups', 'blobs', resolved);
  const payloadParts = [];
  for (const item of manifest.items) {
    // 2026-08-30 第四轮复核 P1：readBlobStrict（导出同样防 ../ 与符号链接）
    const got = readBlobStrict(blobsDir, item.relativePath, item.itemId);
    if (got.err) return { ok: false, error: 'BACKUP_CORRUPTED', reason: got.err, itemId: item.itemId };
    const b = got.buf;
    const iv = b.subarray(0, IV_LEN);
    const tag = b.subarray(IV_LEN, IV_LEN + 16);
    const ct = b.subarray(IV_LEN + 16);
    payloadParts.push(decrypt(dkey, iv, tag, ct));
  }
  const payload = Buffer.concat(payloadParts.length ? payloadParts : [Buffer.alloc(0)]);
  const pEnc = encrypt(pkey, payload);
  const manifestBuf = Buffer.from(JSON.stringify(redact(manifest)), 'utf8');
  const mEnc = encrypt(pkey, manifestBuf);
  const header = Buffer.from('JZVAULT\0');
  const meta = Buffer.from(JSON.stringify({ formatVersion: 1, algorithm: 'AES-256-GCM', kdf: 'passphrase-kdf' }), 'utf8');
  const out = Buffer.concat([
    header,
    meta,
    Buffer.from([0]),
    salt,
    mEnc.iv,
    mEnc.tag,
    _u32(mEnc.ciphertext.length),
    mEnc.ciphertext,
    pEnc.iv,
    pEnc.tag,
    pEnc.ciphertext,
  ]);
  const exportId = uuid();
  const fileName = `jzvault-${resolved.slice(0, 8)}-${exportId.slice(0, 8)}.jzvault`;
  const dir = exportsDir(root);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    const code = e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') ? 'EXPORT_PERMISSION_DENIED' : 'EXPORT_WRITE_FAILED';
    return { ok: false, error: code, detail: e.message };
  }
  // 原子写出：temp + fsync + rename；失败清理临时文件，不留半截导出
  const finalPath = path.join(dir, fileName);
  const tmp = `${finalPath}.${uuid().slice(0, 8)}.tmp`;
  try {
    const fh = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fh, out, 0, out.length, 0);
      fs.fsyncSync(fh);
    } finally {
      fs.closeSync(fh);
    }
    // 写后校验：字节数一致才 rename
    if (fs.statSync(tmp).size !== out.length) throw new Error('export size mismatch');
    fs.renameSync(tmp, finalPath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    const code = e && (e.code === 'ENOSPC' || e.code === 'EDQUOT') ? 'INSUFFICIENT_DISK_SPACE'
      : e && (e.code === 'EACCES' || e.code === 'EPERM') ? 'EXPORT_PERMISSION_DENIED'
      : 'EXPORT_WRITE_FAILED';
    return { ok: false, error: code, detail: e.message };
  }
  const expiresAt = new Date(Date.now() + EXPORT_TTL_MS).toISOString();
  const idx = loadExportIndex(root);
  idx.entries.push({ exportId, file: fileName, backupId: resolved, createdAt: new Date().toISOString(), expiresAt, downloads: 0 });
  saveExportIndex(root, idx);
  sweepExports(root);
  return { ok: true, exportId, file: fileName, backupId: resolved, size: out.length, expiresAt };
}

// 下载：校验存在/过期/次数；返回文件绝对路径（由调用方流式回给浏览器），拒绝成功后计数+1。
function readExportForDownload({ exportId, root } = {}) {
  root = root || dataRoot();
  const idx = loadExportIndex(root);
  const e = idx.entries.find((x) => x.exportId === String(exportId || ''));
  if (!e) {
    sweepExports(root);
    return { ok: false, error: 'EXPORT_NOT_FOUND' };
  }
  if (new Date(e.expiresAt).getTime() < Date.now()) {
    sweepExports(root);
    return { ok: false, error: 'EXPORT_EXPIRED' };
  }
  if (e.downloads >= EXPORT_MAX_DOWNLOADS) {
    return { ok: false, error: 'EXPORT_DOWNLOADS_EXCEEDED' };
  }
  const p = path.join(exportsDir(root), e.file);
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return { ok: false, error: 'EXPORT_NOT_FOUND' };
  }
  // 符号链接/目录拒绝（防导出索引被篡改后读任意文件）
  if (!st.isFile() || st.isSymbolicLink()) return { ok: false, error: 'EXPORT_NOT_FOUND' };
  e.downloads += 1;
  saveExportIndex(root, idx);
  return { ok: true, filePath: p, fileName: e.file, size: st.size, downloadsLeft: EXPORT_MAX_DOWNLOADS - e.downloads };
}

function listExports(root) {
  root = root || dataRoot();
  sweepExports(root);
  return loadExportIndex(root).entries.map((e) => ({
    exportId: e.exportId,
    file: e.file,
    backupId: e.backupId,
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
    downloads: e.downloads,
  }));
}

// ===== 导入（受控文件，指导 §5/§6）=====
// file 只允许是 exports/（sourceKind='export'）或 staging/（sourceKind='staging'）下的纯文件名；
// 拒绝任何路径分隔符、..、绝对路径与符号链接——不允许 JSON body 传任意本机路径。
function resolveImportFile({ file, sourceKind, root }) {
  root = root || dataRoot();
  const name = String(file || '');
  if (!name || name !== path.basename(name) || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, error: 'INVALID_REQUEST', detail: '导入文件名非法（不允许路径）' };
  }
  const dir = sourceKind === 'staging' ? stagingDir(root) : exportsDir(root);
  const p = path.join(dir, name);
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return { ok: false, error: 'IMPORT_FILE_NOT_FOUND', detail: `受控目录中不存在 ${name}` };
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    return { ok: false, error: 'INVALID_REQUEST', detail: '导入目标不是普通文件（符号链接/目录拒绝）' };
  }
  if (st.size > IMPORT_MAX_BYTES) {
    return { ok: false, error: 'IMPORT_TOO_LARGE', detail: `文件 ${st.size} 字节 > 上限 ${IMPORT_MAX_BYTES} 字节` };
  }
  return { ok: true, path: p };
}

function stagingDir(root) {
  return path.join(root, 'staging');
}

// ===== staging 治理（复查 P2：TTL 过期清理 + 总容量配额）=====
const STAGING_TTL_MS = Number(process.env.JZ_STAGING_TTL_MS) || 60 * 60 * 1000; // 1h 未消费即清
const STAGING_QUOTA_BYTES = Number(process.env.JZ_STAGING_QUOTA_BYTES) || 1024 * 1024 * 1024; // 1GB 总配额

// 惰性清理：删除超时 staging 文件，返回剩余占用（供上传前配额校验）。每次上传/导入时顺带执行。
function sweepStaging(root, now = Date.now()) {
  const dir = stagingDir(root);
  let total = 0;
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  } catch {
    return { total: 0, removed: 0 };
  }
  for (const f of names) {
    const p = path.join(dir, f);
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      if (now - st.mtimeMs > STAGING_TTL_MS) {
        fs.rmSync(p, { force: true });
        removed++;
      } else {
        total += st.size;
      }
    } catch {}
  }
  return { total, removed };
}

function stagingQuotaBytes() {
  return STAGING_QUOTA_BYTES;
}

// 导入：解密后用本地数据密钥重新加密为新的本机备份（06 §3.3）。
// 元数据保留：scopeType/sourceRel/type/size/sha256 全部带入新 manifest；
//   旧格式缺关键路径信息 → 条目标记 restoreUnsafe（schema migration，schemaVersion 2），恢复时跳过并展示。
function importBackup({ file, sourceKind, passphrase, root } = {}) {
  root = root || dataRoot();
  // 2026-08-30 复核 P0：导入密码必须非空且为字符串。旧实现直接把 undefined 传给 KDF，
  // deriveKeyFromPassphrase 内部 String(undefined) 得到字面量 "undefined" —— 等价于用
  // 公开常量当密码解密，任何人传空密码即可解开交接包。此处 fail-closed。
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    return { ok: false, error: 'IMPORT_PASSPHRASE_REQUIRED', detail: '导入交接包必须提供非空密码' };
  }
  const src = resolveImportFile({ file, sourceKind, root });
  if (!src.ok) return src;
  let buf;
  try {
    buf = fs.readFileSync(src.path);
  } catch (e) {
    return { ok: false, error: 'IMPORT_FILE_NOT_FOUND', detail: e.message };
  }
  if (!buf.subarray(0, 8).equals(Buffer.from('JZVAULT\0'))) return { ok: false, error: 'BACKUP_CORRUPTED' };
  let i = 8;
  // 边界防御：损坏/截断文件若无终止 0x00，直接拒绝，绝不越界读（undefined !== 0 恒真会死循环）。
  while (i < buf.length && buf[i] !== 0) i++;
  if (i >= buf.length) return { ok: false, error: 'BACKUP_CORRUPTED', reason: 'meta_terminator_missing' };
  i++;
  const salt = buf.subarray(i, i + 16);
  i += 16;
  const pkey = deriveKeyFromPassphrase(passphrase, salt);
  if (i + IV_LEN + 16 + 4 > buf.length) return { ok: false, error: 'BACKUP_CORRUPTED', reason: 'truncated' };
  const mIv = buf.subarray(i, i + IV_LEN);
  i += IV_LEN;
  const mTag = buf.subarray(i, i + 16);
  i += 16;
  const mLen = _rdU32(buf, i);
  i += 4;
  if (i + mLen + IV_LEN + 16 > buf.length) return { ok: false, error: 'BACKUP_CORRUPTED', reason: 'truncated' };
  const mCt = buf.subarray(i, i + mLen);
  i += mLen;
  const pIv = buf.subarray(i, i + IV_LEN);
  i += IV_LEN;
  const pTag = buf.subarray(i, i + 16);
  i += 16;
  const pCt = buf.subarray(i);
  let manifest, payload;
  try {
    manifest = JSON.parse(decrypt(pkey, mIv, mTag, mCt).toString('utf8'));
    payload = decrypt(pkey, pIv, pTag, pCt);
  } catch {
    return { ok: false, error: 'BACKUP_CORRUPTED' };
  }
  // 2026-08-30 第四轮复核 P2：缺 items / items 非数组的损坏包必须拒绝——
  // 旧实现 `manifest.items || []` 会把空清单当合法导入，产生空备份。
  if (!manifest || !Array.isArray(manifest.items)) {
    return { ok: false, error: 'BACKUP_CORRUPTED', reason: 'manifest_items_missing' };
  }
  const dkey = loadOrCreateDataKey(root);
  const backupId = uuid();
  const blobsDir = path.join(root, 'backups', 'blobs', backupId);
  fs.mkdirSync(blobsDir, { recursive: true });
  // 2026-08-30 复核 P1：整段写入纳入统一 try/catch——磁盘满、权限失败、序列化异常
  // 一律清理 blobsDir，绝不遗留孤立 blob 目录（旧实现只覆盖了两条 hash 校验分支）。
  try {
    let off = 0;
    const newItems = [];
    const unsafeItems = [];
    for (const item of manifest.items || []) {
      const size = Number(item.size) || 0;
      if (off + size > payload.length) {
        // 2026-08-30 第四轮复核 P2：return 不经过 catch → 必须先清理 blobs 再返回（防孤立目录）
        try { fs.rmSync(blobsDir, { recursive: true, force: true }); } catch (_) {}
        return { ok: false, error: 'BACKUP_CORRUPTED', reason: 'payload_size_mismatch', itemId: item.itemId };
      }
      const plain = payload.subarray(off, off + size);
      off += size;
      // 导入即校验：plain hash 与清单不符 → 整体失败（fail-closed，绝不导入半截数据）
      if (item.sha256 && crypto.createHash('sha256').update(plain).digest('hex') !== item.sha256) {
        try { fs.rmSync(blobsDir, { recursive: true, force: true }); } catch (_) {}
        return { ok: false, error: 'BACKUP_CORRUPTED', reason: 'item_hash_mismatch', itemId: item.itemId };
      }
      const { iv, tag, ciphertext } = encrypt(dkey, plain);
      const itemId = uuid();
      const rel = `${itemId}.bin`;
      fs.writeFileSync(path.join(blobsDir, rel), Buffer.concat([iv, tag, ciphertext]));
      // 元数据保留 + 校验（指导 §6）：scopeType 白名单、sourceRel safeRel；缺/非法 → restoreUnsafe 标记
      const meta = itemMeta(item);
      const rec = {
        itemId,
        type: item.type,
        relativePath: rel,
        size: item.size,
        sha256: item.sha256,
        encrypted: true,
      };
      if (meta.safe) {
        rec.scopeType = meta.scopeType;
        rec.sourceRel = meta.sourceRel;
      } else {
        rec.scopeType = meta.scopeType; // 白名单外的落 settings 基目录仅用于展示，恢复时 unsafe 跳过
        rec.restoreUnsafe = meta.unsafeReason;
        unsafeItems.push({ itemId, reason: meta.unsafeReason, originalItemId: item.itemId });
      }
      newItems.push(rec);
    }
    const newManifest = Object.assign({}, manifest, {
      backupId,
      createdAt: new Date().toISOString(),
      schemaVersion: 2,
      migratedFrom: manifest.schemaVersion || 1,
      items: newItems,
      integrity: 'verified',
    });
    atomicWriteJSON(manifestPath(root, backupId), newManifest);
    // staging 文件一次性使用：导入成功即清理
    if (sourceKind === 'staging') {
      try { fs.rmSync(src.path, { force: true }); } catch {}
    }
    return {
      ok: true,
      backupId,
      imported: newItems.length,
      restoreReady: newItems.length - unsafeItems.length,
      unsafeItems: unsafeItems.length ? unsafeItems : undefined,
      // 导入清单摘要（供预览/交接包展示；字段已 hash 校验）
      items: newItems.map((it) => ({
        itemId: it.itemId,
        type: it.type,
        scopeType: it.scopeType,
        sourceRel: it.sourceRel,
        size: it.size,
        sha256: it.sha256,
        restoreUnsafe: it.restoreUnsafe || false,
      })),
    };
  } catch (e) {
    // 写入阶段任何异常：清理半成品 blobs 目录，避免磁盘满/权限失败留下孤立数据
    try { fs.rmSync(blobsDir, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, error: 'IMPORT_WRITE_FAILED', detail: String((e && e.message) || e) };
  }
}

module.exports = {
  createBackup,
  verifyBackup,
  listBackups,
  previewRestore,
  restoreBackup,
  exportBackup,
  importBackup,
  scopeSources,
  safeRel,
  safeBlobPath,
  toPosixRel,
  normalizeScope,
  SCOPE_WHITELIST,
  SENSITIVE_DIR_MARKERS,
  resolveBackupId,
  manifestSha256,
  resolveImportFile,
  readExportForDownload,
  listExports,
  stagingDir,
  exportsDir,
  sweepStaging,
  stagingQuotaBytes,
  IMPORT_MAX_BYTES,
  EXPORT_TTL_MS,
  EXPORT_MAX_DOWNLOADS,
  manifestPath,
  assertSafeBackupId,
};