'use strict';
// 交接包（能力提炼开发文档 §5.2 / PRD §3.2，V0.2）：
// 换机/跨设备资产交接 —— 账号/会话/工作区打包 + 加密 + 路径映射 + 冲突策略 + 来源追溯。
//
// 文件格式 .jzhandoff（明文 JSON 元数据 + 内嵌加密 .jzvault）：
//   { schema:'jz-handoff/v1', source:{hostname,platform,appVersion,createdAt,label},
//     sourceRefs:[{slug,version,distilledAt}], manifest:{items 摘要}, payloadB64 }
//   payloadB64 = base64(加密 .jzvault) —— 复用 backup-vault 的 export/import 加密格式，
//   安全属性继承：AES-256-GCM + passphrase KDF、导入即 hash 校验 fail-closed。
//
// 复用链路：create → createBackup + exportBackup；apply → importBackup + restoreBackup
//（两阶段预检 + 逐文件快照逆序回滚），不重新发明恢复逻辑。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { dataRoot, uuid, readJSON, atomicWriteJSON, workbuddyDir } = require('./lib');
const { safeRel } = require('./backup-vault');
const {
  createBackup,
  exportBackup,
  importBackup,
  restoreBackup,
  resolveImportFile,
  listExports,
  exportsDir,
  stagingDir,
  IMPORT_MAX_BYTES,
} = require('./backup-vault');

const HANDOFF_SCHEMA = 'jz-handoff/v1';
// 交接包内嵌 payload 独立校验：上传/预览/应用都过这道 256MB 上限
const HANDOFF_MAX_BYTES = Number(process.env.JZ_HANDOFF_MAX_BYTES) || IMPORT_MAX_BYTES;

function handoffFileOf(ex) {
  // exportBackup 的 file 字段是 .jzvault 文件名；交接包文件名统一 handoff-<backup8>-<exp8>.jzhandoff
  const m = String(ex.file || '').match(/^jzvault-([A-Za-z0-9]{8})-([A-Za-z0-9]{8})\.jzvault$/);
  return m ? `handoff-${m[1]}-${m[2]}.jzhandoff` : null;
}

// 源信息（脱敏：不含用户名/完整路径）
function sourceInfo(label) {
  let hostname = 'unknown';
  try { hostname = os.hostname() || 'unknown'; } catch {}
  return {
    hostname: String(hostname).slice(0, 60),
    platform: process.platform || 'unknown',
    appVersion: process.env.JZ_VERSION || 'dev',
    createdAt: new Date().toISOString(),
    label: String(label || '').slice(0, 80),
  };
}

// ===== 创建交接包 =====
// 生成 exports/handoff-<id>.jzhandoff 并返回元数据。passphrase 必填（跨设备加密传输）。
function createHandoff({ root, passphrase, label, sourceRefs, scope, wbDir } = {}) {
  root = root || dataRoot();
  if (typeof passphrase !== 'string' || !passphrase.length) {
    return { ok: false, error: 'INVALID_REQUEST', detail: 'passphrase 不能为空' };
  }
  const b = createBackup({ scope: scope || ['accounts', 'sessions', 'settings'], reason: 'handoff', root, wbDir });
  if (!b.ok) return b;
  const ex = exportBackup({ backupId: b.backupId, passphrase, root });
  if (!ex.ok) return ex;
  const fileName = handoffFileOf(ex);
  if (!fileName) return { ok: false, error: 'INTERNAL_REDACTED' };
  const payload = fs.readFileSync(path.join(exportsDir(root), ex.file));
  const manifest = b.manifest || {};
  const envelopeObj = {
    schema: HANDOFF_SCHEMA,
    source: sourceInfo(label),
    sourceRefs: Array.isArray(sourceRefs) ? sourceRefs.map((r) => ({
      slug: String((r && r.slug) || '').slice(0, 120),
      version: String((r && r.version) || '').slice(0, 40),
      distilledAt: (r && r.distilledAt) || null,
    })).filter((r) => r.slug) : [],
    manifest: {
      schemaVersion: manifest.schemaVersion || 1,
      backupId: b.backupId,
      items: (manifest.items || []).map((it) => ({
        scopeType: it.scopeType,
        sourceRel: it.sourceRel,
        size: it.size,
        sha256: it.sha256,
      })),
    },
    payloadB64: payload.toString('base64'),
    checksum: crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16),
  };
  const finalPath = path.join(exportsDir(root), fileName);
  const tmp = `${finalPath}.${uuid().slice(0, 8)}.tmp`;
  try {
    const data = Buffer.from(JSON.stringify(envelopeObj, null, 2));
    const fh = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fh, data, 0, data.length, 0);
      fs.fsyncSync(fh);
    } finally {
      fs.closeSync(fh);
    }
    fs.renameSync(tmp, finalPath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    const code = e && (e.code === 'ENOSPC' || e.code === 'EDQUOT') ? 'INSUFFICIENT_DISK_SPACE'
      : e && (e.code === 'EACCES' || e.code === 'EPERM') ? 'BACKUP_PERMISSION_DENIED'
      : 'HANDOFF_WRITE_FAILED';
    return { ok: false, error: code, detail: e.message };
  }
  return {
    ok: true,
    file: fileName,
    size: fs.statSync(finalPath).size,
    source: envelopeObj.source,
    sourceRefs: envelopeObj.sourceRefs,
    itemCount: (manifest.items || []).length,
    createdAt: envelopeObj.source.createdAt,
    exportId: ex.exportId,
  };
}

// ===== 解析 .jzhandoff（明文元数据 + payload 头校验）=====
function parseHandoffFile(buf) {
  if (buf.length > HANDOFF_MAX_BYTES) return { ok: false, error: 'HANDOFF_TOO_LARGE' };
  let env;
  try {
    env = JSON.parse(buf.toString('utf8'));
  } catch {
    return { ok: false, error: 'HANDOFF_CORRUPTED', detail: '非 JSON' };
  }
  if (!env || env.schema !== HANDOFF_SCHEMA) {
    return { ok: false, error: 'HANDOFF_CORRUPTED', detail: `schema 不匹配（${env && env.schema}）` };
  }
  if (typeof env.payloadB64 !== 'string' || !env.payloadB64) {
    return { ok: false, error: 'HANDOFF_CORRUPTED', detail: '缺 payload' };
  }
  const payload = Buffer.from(env.payloadB64, 'base64');
  if (payload.length === 0) return { ok: false, error: 'HANDOFF_CORRUPTED', detail: 'payload 为空' };
  if (!payload.subarray(0, 8).equals(Buffer.from('JZVAULT\0'))) {
    return { ok: false, error: 'HANDOFF_CORRUPTED', detail: 'payload 不是合法 JZVAULT' };
  }
  return { ok: true, env, payload };
}

// 把 payload 落成临时 .jzvault 供 importBackup 消费（临时目录，用完即删）。
function payloadToTempJzvault(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jz-handoff-'));
  const staging = path.join(dir, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  const p = path.join(staging, 'payload.jzvault');
  fs.writeFileSync(p, payload, { mode: 0o600 });
  return { dir, path: p };
}

function loadHandoffIndex(root) {
  const p = path.join(root, 'runtime', 'handoff-index.json');
  return readJSON(p) || { entries: [] };
}
function saveHandoffIndex(root, idx) {
  atomicWriteJSON(path.join(root, 'runtime', 'handoff-index.json'), idx);
}

// ===== 预览：解密校验 + 条目清单 + 目标冲突检测（只读，不写真实目录）=====
// 返回 preview 快照供前端展示；apply 前由 api 层用 previewStore 绑定文件 hash（单次/过期）。
function previewHandoff({ file, sourceKind, passphrase, root, wbDir } = {}) {
  root = root || dataRoot();
  const src = resolveImportFile({ file, sourceKind, root });
  if (!src.ok) return src;
  let buf;
  try {
    buf = fs.readFileSync(src.path);
  } catch (e) {
    return { ok: false, error: 'HANDOFF_FILE_NOT_FOUND', detail: e.message };
  }
  const parsed = parseHandoffFile(buf);
  if (!parsed.ok) return parsed;
  const { env, payload } = parsed;
  const tmp = payloadToTempJzvault(payload);
  try {
    // 临时 root 上解密导入（校验密码 + 拿 manifest 摘要）；不落真实数据目录
    const im = importBackup({ file: 'payload.jzvault', sourceKind: 'staging', passphrase, root: tmp.dir });
    if (!im.ok) return im; // 密码错误 → BACKUP_CORRUPTED（与 vault 一致，不泄露原因）
    const items = (im.items && im.items.length ? im.items : ((im.manifest && im.manifest.items) || []));
    // 目标冲突检测：对比目标机现有文件（存在即冲突项）
    // 2026-08-30 第四轮复核 P1（修复）：旧实现预览默认 `<dataDir>/workbuddy`（不存在的目录
    // → 永远"无冲突"），而 apply 用 workbuddyDir() → 预览与实际应用目标不一致。
    // 现统一都用 workbuddyDir()（profile 感知），预览结果与 apply 行为一致。
    const wb = wbDir || workbuddyDir();
    const targetBaseOf = (scopeType) => (scopeType === 'settings' ? root : wb);
    const conflicts = [];
    for (const it of items) {
      // 2026-08-30 第五轮复核 P2：条目结构校验——scopeType 白名单 + sourceRel safeRel
      //（损坏/恶意交接包不得用 ../ 探测允许根目录之外的路径，也不得炸 TypeError）
      const scopeOk = typeof it.scopeType === 'string' && ['accounts', 'sessions', 'settings'].includes(it.scopeType);
      const relOk = typeof it.sourceRel === 'string' && it.sourceRel && safeRel(it.sourceRel.replace(/\\/g, '/'));
      if (!scopeOk || !relOk) continue;
      const target = path.join(targetBaseOf(it.scopeType), it.sourceRel.replace(/\\/g, '/'));
      let exists = false;
      try { exists = fs.existsSync(target); } catch {}
      if (exists) conflicts.push({ scopeType: it.scopeType, sourceRel: it.sourceRel });
    }
    return {
      ok: true,
      preview: {
        source: env.source,
        sourceRefs: env.sourceRefs || [],
        manifest: env.manifest || {},
        items: items.map((it) => ({ scopeType: it.scopeType, sourceRel: it.sourceRel, size: it.size, sha256: it.sha256 })),
        conflictCount: conflicts.length,
        conflicts: conflicts.slice(0, 50),
        fileChecksum: crypto.createHash('sha256').update(buf).digest('hex'),
      },
    };
  } finally {
    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch {}
  }
}

// ===== 应用交接包：import 到本机 + 两阶段恢复（回滚由 restoreBackup 保障）=====
async function applyHandoff({ file, sourceKind, passphrase, conflictPolicy, root, wbDir } = {}) {
  root = root || dataRoot();
  const src = resolveImportFile({ file, sourceKind, root });
  if (!src.ok) return src;
  let buf;
  try {
    buf = fs.readFileSync(src.path);
  } catch (e) {
    return { ok: false, error: 'HANDOFF_FILE_NOT_FOUND', detail: e.message };
  }
  const parsed = parseHandoffFile(buf);
  if (!parsed.ok) return parsed;
  // 导入内层 payload（.jzvault）为本机备份（hash 校验 fail-closed）→ 交接历史留档。
  // 注意：不能把 .jzhandoff 信封直接喂 importBackup（它不是 JZVAULT 头）；
  // payload 先进真实 root 的 staging（importBackup 只认 root 下的受控目录）。
  const stagedName = `handoff-payload-${uuid()}.jzvault`;
  const stagedPath = path.join(stagingDir(root), stagedName);
  let im;
  try {
    fs.mkdirSync(stagingDir(root), { recursive: true });
    fs.writeFileSync(stagedPath, parsed.payload, { mode: 0o600 });
    im = importBackup({ file: stagedName, sourceKind: 'staging', passphrase, root });
  } catch (e) {
    return { ok: false, error: 'HANDOFF_APPLY_FAILED', detail: String((e && e.message) || e) };
  } finally {
    // importBackup 成功会自行清理 staging 文件；失败时兜底清理
    try { if (fs.existsSync(stagedPath)) fs.rmSync(stagedPath, { force: true }); } catch {}
  }
  if (!im.ok) return im;
  // 两阶段恢复（预检 + 逐文件快照逆序回滚）
  const scope = (parsed.env.manifest && parsed.env.manifest.items || []).map((it) => it.scopeType);
  const rr = await restoreBackup({
    backupId: im.backupId,
    scope: scope.length ? scope : ['accounts', 'sessions', 'settings'],
    conflictPolicy,
    applyToReal: true,
    root,
    wbDir,
  });
  // 留档交接记录（来源可追溯）
  const idx = loadHandoffIndex(root);
  idx.entries.push({
    handoffId: uuid(),
    file: String(file || ''),
    source: parsed.env.source || {},
    sourceRefs: parsed.env.sourceRefs || [],
    backupId: im.backupId,
    appliedAt: new Date().toISOString(),
    restore: { ok: rr.ok, restored: rr.restored || 0, skipped: rr.skipped || 0, rollback: rr.rollback || null },
  });
  if (idx.entries.length > 50) idx.entries = idx.entries.slice(-50);
  saveHandoffIndex(root, idx);
  return rr.ok ? { ok: true, backupId: im.backupId, restore: rr } : rr;
}

function listHandoffFiles(root) {
  root = root || dataRoot();
  return listExports(root).filter((e) => String(e.file || '').endsWith('.jzhandoff'));
}

module.exports = {
  HANDOFF_SCHEMA,
  createHandoff,
  previewHandoff,
  applyHandoff,
  listHandoffFiles,
  parseHandoffFile,
};
