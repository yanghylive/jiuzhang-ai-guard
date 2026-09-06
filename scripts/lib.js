/**
 * WorkBuddy 多账号切换器 - 共享逻辑
 *
 * 原理：WorkBuddy 桌面端的登录信息保存在
 *   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
 * 其中 account.uid 是用户唯一 ID。本插件把该文件按 <uid>.info 分文件备份到稳定目录，
 * 切换登录时把对应备份复制回原文件即可。
 *
 * 环境变量（均可覆盖默认值）：
 *   WBSWITCH_AUTH_FILE  登录信息文件路径
 *   WBSWITCH_DATA_DIR   备份数据目录
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getProfile, profileDataDir, sharedDataDir } = require('./profiles.js');
// 第七轮复核 P0：宿主层路径校验统一引用子系统真源（jz/lib 不反向依赖本模块，无循环）
const { isPhysicallyRealPath } = require('./jz/lib.js');

const IS_WIN = process.platform === 'win32';

const PLATFORM_DATA_DIR = IS_WIN
  ? path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'JIUZHANG AI 管家'
    )
  : path.join(os.homedir(), 'Library', 'Application Support', 'WorkDaddy');
const LEGACY_DATA_DIR = IS_WIN
  ? null
  : path.join(os.homedir(), 'Library', 'Application Support', 'HelloBuddy');

function samePath(a, b) {
  return !!a && !!b && path.resolve(a) === path.resolve(b);
}

function isLegacyDataDir(dataDir) {
  return !IS_WIN && samePath(dataDir, LEGACY_DATA_DIR);
}

// macOS: ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
// Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info（真机已确认）
const ACTIVE_PROFILE = getProfile();
const AUTH_FILE = process.env.WBSWITCH_AUTH_FILE !== undefined
  ? process.env.WBSWITCH_AUTH_FILE
  : (ACTIVE_PROFILE.authFile === null ? null : (ACTIVE_PROFILE.authFile || (IS_WIN
    ? path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'CodeBuddyExtension',
        'Data',
        'Public',
        'auth',
        'workbuddy-desktop.info'
      )
    : path.join(
        os.homedir(),
        'Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'
      ))));

const LOGOUT_MARKER = `${AUTH_FILE}.logged-out`;

function defaultDataDir() {
  // 旧版 launchd 可能把 WBSWITCH_DATA_DIR 设成 HelloBuddy；新版本始终落到 WorkDaddy，
  // 避免旧服务被新 daemon 拉起后继续写入旧目录。
  const configured = process.env.WBSWITCH_DATA_DIR;
  return configured && !isLegacyDataDir(configured) ? configured : profileDataDir(ACTIVE_PROFILE);
}

function accountsDir(dataDir) {
  return path.join(dataDir, 'accounts');
}
function metaFile(dataDir) {
  return path.join(dataDir, 'meta.json');
}

/**
 * UID 校验（P1-1 账号路径穿越防护）。
 * uid 只能是纯文件名：非空、不含路径分隔符 / \ 与 NUL、不含 ".."、不以 . 开头、长度受限。
 * 非法返回 null，合法返回原字符串（供 path.basename 一致的调用方使用）。
 */
function validateUid(uid) {
  if (typeof uid !== 'string' || !uid) return null;
  if (uid.includes('/') || uid.includes('\\') || uid.includes('\0')) return null;
  if (uid === '.' || uid === '..' || uid.startsWith('.')) return null;
  if (uid !== path.basename(uid)) return null;
  if (uid.length > 128) return null;
  return uid;
}

// ===== 账号文件加密（P1-2 明文 token 防护）=====
// 账号备份文件 <uid>.info 原为明文 token/cookie，只靠 0600 权限。现改为 AES-256-GCM 加密：
// 数据密钥优先 macOS Keychain，降级 0600 本地文件；文件格式 = JZENC1 magic + iv(12) + tag(16) + 密文。
// 读取时自动识别 magic：加密则解密，无 magic 则按明文读（兼容旧文件，不破坏已备份账号）。
const ENC_MAGIC = 'JZENC1';
const ENC_IV_LEN = 12;
const ENC_TAG_LEN = 16;
const ENC_KEYCHAIN_SERVICE = 'com.workdaddy.vault-key';
const ENC_KEYCHAIN_ACCOUNT = 'data-key';

function encKeychainGetKey() {
  if (IS_WIN) return null;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', ENC_KEYCHAIN_SERVICE, '-a', ENC_KEYCHAIN_ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const key = Buffer.from(String(out).trim(), 'hex');
    if (key.length === 32) return key;
  } catch (_) {
    /* not found */
  }
  return null;
}

function encKeychainSetKey(key) {
  if (IS_WIN) return false;
  try {
    const { execFileSync } = require('child_process');
    execFileSync(
      '/usr/bin/security',
      ['add-generic-password', '-U', '-s', ENC_KEYCHAIN_SERVICE, '-a', ENC_KEYCHAIN_ACCOUNT, '-w', key.toString('hex')],
      { stdio: 'ignore' },
    );
    return true;
  } catch (_) {
    return false;
  }
}

// 数据密钥：macOS Keychain（生产）→ Windows DPAPI（CurrentUser 保护）→ 0600 本地文件（降级）。
// 2026-08-30 复核 P1（修复）：旧实现 Windows 上直接落明文 .account-key 原始 32 字节文件
//（仅 chmod 位，NTFS 无 Unix 权限语义）→ 账号认证数据等于无保护。现接入 DPAPI：
// 密钥以 CurrentUser 范围 Protect 后落 .account-key.dpapi；已有明文密钥自动迁移并删除。
function accountDataKey(dataDir) {
  const keyPath = path.join(dataDir, '.account-key');
  const kc = encKeychainGetKey();
  if (kc) {
    // 2026-08-30 第五轮复核 P1：命中 Keychain 后顺手删除残留明文 .account-key
    //（否则明文密钥与平台存储并存，Keychain 优先形同虚设）
    try { fs.rmSync(keyPath, { force: true }); } catch (_) {}
    return kc;
  }
  const dpPath = path.join(dataDir, '.account-key.dpapi');

  // Windows：优先 DPAPI（jz/crypto-vault 的 powershell Protect/Unprotect，CurrentUser 范围）
  if (process.platform === 'win32') {
    const { dpapiProtect, dpapiUnprotect } = require('./jz/crypto-vault.js');
    // 1) 读已有 DPAPI 密钥
    try {
      const b64 = fs.readFileSync(dpPath, 'utf8').trim();
      const hex = dpapiUnprotect(b64);
      const key = Buffer.from(String(hex).trim(), 'hex');
      if (key.length === 32) {
        // 顺手清理可能残留的旧明文密钥
        try { fs.rmSync(keyPath, { force: true }); } catch (_) {}
        return key;
      }
    } catch (_) { /* 无 DPAPI 文件或属主不匹配 */ }
    // 2) 迁移旧明文 .account-key → DPAPI（内容不变，保护升级）
    try {
      const raw = fs.readFileSync(keyPath);
      if (raw.length === 32) {
        const b64 = dpapiProtect(raw.toString('hex'));
        if (b64 && /^[A-Za-z0-9+/=]+$/.test(b64)) {
          fs.writeFileSync(dpPath, b64 + '\n', { mode: 0o600 });
          try { fs.rmSync(keyPath, { force: true }); } catch (_) {}
          return raw;
        }
        // DPAPI 不可用：暂用明文密钥保持账号可用（下次启动重试迁移）
        return raw;
      }
    } catch (_) { /* 无旧明文密钥 */ }
    // 3) 新建密钥：优先 DPAPI
    const key = crypto.randomBytes(32);
    try {
      const b64 = dpapiProtect(key.toString('hex'));
      if (b64 && /^[A-Za-z0-9+/=]+$/.test(b64)) {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(dpPath, b64 + '\n', { mode: 0o600 });
        return key;
      }
    } catch (_) { /* DPAPI 失败 → 走文件降级 */ }
  }

  // 文件降级前：macOS 尝试 Keychain 迁移/新建（第四轮复核 P1 修复：
  // 上轮改造把 encKeychainSetKey 调用弄丢，新密钥直接落 .account-key 明文文件）。
  if (process.platform !== 'win32') {
    // 1) 已有明文 .account-key → 迁移进 Keychain，成功即删明文
    try {
      const raw = fs.readFileSync(keyPath);
      if (raw.length === 32) {
        if (encKeychainSetKey(raw)) {
          try { fs.rmSync(keyPath, { force: true }); } catch (_) {}
          return raw;
        }
        return raw; // Keychain 不可用（如 CI 无钥匙串）→ 暂用明文文件，下次重试
      }
    } catch (_) { /* 无旧文件 */ }
    // 2) 新建：优先 Keychain，成功不落任何文件
    const key = crypto.randomBytes(32);
    if (encKeychainSetKey(key)) return key;
  }

  // 文件降级（macOS 无 Keychain / Windows DPAPI 不可用）
  try {
    const raw = fs.readFileSync(keyPath);
    if (raw.length === 32) return raw;
  } catch (_) {
    /* create below */
  }
  const key = crypto.randomBytes(32);
  if (process.platform !== 'win32' && encKeychainSetKey(key)) return key;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function encEncrypt(key, plainBuf) {
  const iv = crypto.randomBytes(ENC_IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext };
}

function encDecrypt(key, iv, tag, ciphertext) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// 写账号文件（加密）：JZENC1 magic + iv + tag + 密文。
// 2026-08-30 复核 P1（修复）：旧实现直接 writeFileSync 覆盖目标——进程中断/磁盘满会
// 截断凭据备份。改为真原子写（tmp + rename），与 meta.json 同等保护级别。
function writeAccountFile(dataDir, file, obj) {
  const key = accountDataKey(dataDir);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const { iv, tag, ciphertext } = encEncrypt(key, plain);
  const buf = Buffer.concat([Buffer.from(ENC_MAGIC, 'latin1'), iv, tag, ciphertext]);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw e;
  }
}

// 读账号文件（自动识别加密/明文；明文为旧格式，读取后原地迁移为加密）。
// 2026-08-30 复核 P0（修复）：迁移失败必须 fail-closed——旧实现 catch 后仍返回明文对象，
// 明文可被继续当凭据使用且永久残留。现改为迁移失败抛错（调用方按「损坏/需重登」处理）；
// 盘上的明文文件在 IO 恢复后由下次读取的重试迁移闭环消除。
function readAccountFile(dataDir, file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= ENC_MAGIC.length && buf.slice(0, ENC_MAGIC.length).toString('latin1') === ENC_MAGIC) {
    const key = accountDataKey(dataDir);
    const iv = buf.slice(ENC_MAGIC.length, ENC_MAGIC.length + ENC_IV_LEN);
    const tag = buf.slice(ENC_MAGIC.length + ENC_IV_LEN, ENC_MAGIC.length + ENC_IV_LEN + ENC_TAG_LEN);
    const ct = buf.slice(ENC_MAGIC.length + ENC_IV_LEN + ENC_TAG_LEN);
    return JSON.parse(encDecrypt(key, iv, tag, ct).toString('utf8'));
  }
  // 旧明文格式：尝试迁移（原子加密回写）；失败一律抛错，绝不返回明文
  const obj = JSON.parse(buf.toString('utf8'));
  writeAccountFile(dataDir, file, obj); // 失败会抛出（含 IO 错误），由调用方 fail-closed
  return obj;
}

function workbuddyModelsFile() {
  return ACTIVE_PROFILE.modelsFile || path.join(os.homedir(), '.workbuddy', 'models.json');
}

function isManagedProfileDataDir(dataDir) {
  const root = path.resolve(sharedDataDir());
  const current = path.resolve(dataDir || '');
  return current === root || current.startsWith(root + path.sep + 'profiles' + path.sep);
}

function migrateLegacyModelBackups(dataDir) {
  if (!isManagedProfileDataDir(dataDir)) return;
  const root = sharedDataDir();
  const target = path.join(root, 'models');
  const marker = path.join(target, '.legacy-migrated-v1');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  // 迁移只允许发生一次。旧 profile 目录保留作兼容/恢复，但不能在用户删除
  // 共享备份后再次把同一个文件复制回来。
  if (fs.existsSync(marker)) return;
  let profileDirs = [];
  try { profileDirs = fs.readdirSync(path.join(root, 'profiles'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, 'profiles', entry.name, 'models')); } catch (_) {}
  for (const source of profileDirs) {
    let names = [];
    try { names = fs.readdirSync(source).filter((name) => /^[A-Za-z0-9_-]{8,100}\.json$/.test(name)); } catch (_) { continue; }
    for (const name of names) {
      const from = path.join(source, name);
      const to = path.join(target, name);
      if (fs.existsSync(to)) continue;
      try { fs.copyFileSync(from, to); fs.chmodSync(to, 0o600); } catch (_) {}
    }
  }
  try {
    fs.writeFileSync(marker, JSON.stringify({ version: 1, migratedAt: new Date().toISOString(), deleted: [] }) + '\n', { mode: 0o600 });
    fs.chmodSync(marker, 0o600);
  } catch (_) {}
}

function modelBackupsDir(dataDir) {
  if (isManagedProfileDataDir(dataDir)) {
    migrateLegacyModelBackups(dataDir);
    return path.join(sharedDataDir(), 'models');
  }
  return path.join(dataDir, 'models');
}

function maskApiKey(apiKey) {
  const value = String(apiKey || '');
  if (!value) return '';
  if (value.length <= 8) return '••••••';
  const prefix = value.slice(0, Math.min(3, value.length - 4));
  const suffix = value.slice(-4);
  const middleLength = Math.max(1, value.length - prefix.length - suffix.length);
  return `${prefix}${'•'.repeat(middleLength)}${suffix}`;
}

// 模型列表摘要。默认脱敏 apiKey；UI 需要明文展示（模型页 cell / 编辑弹窗）时传 { revealKey: true }。
function sanitizeModel(model, opts) {
  const value = model && typeof model === 'object' && !Array.isArray(model) ? model : {};
  const revealKey = !!(opts && opts.revealKey);
  return {
    id: String(value.id || value.name || ''),
    name: String(value.name || value.id || ''),
    vendor: String(value.vendor || ''),
    url: String(value.url || '').split('?')[0].split('#')[0],
    apiKey: revealKey ? String(value.apiKey || '') : maskApiKey(value.apiKey),
    supportsToolCall: !!value.supportsToolCall,
    supportsImages: !!value.supportsImages,
    supportsReasoning: !!value.supportsReasoning,
  };
}

function checkinDisplayValue(record, today, pending) {
  if (pending || !record || record.date !== today) return null;
  return { ok: !!record.ok, already: !!record.already, code: record.code, message: record.message };
}

function readModelsFile(file = workbuddyModelsFile()) {
  // 文件不存在视为"还没有模型"，返回空列表而不是抛错——模型页应显示
  // "当前还未添加模型"占位，而不是"当前模型加载失败: 未找到模型配置文件"。
  if (!fs.existsSync(file)) return { file, format: 'array', models: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`模型配置文件不是有效 JSON: ${e.message}`);
  }
  if (Array.isArray(parsed)) return { file, format: 'array', models: parsed };
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.models)) {
    return { file, format: 'object', models: parsed.models, wrapper: parsed };
  }
  throw new Error('模型配置文件格式不受支持：应为数组或包含 models 数组的对象');
}

function writeModelsFile(parsed, models) {
  const output = parsed.format === 'array' ? models : Object.assign({}, parsed.wrapper, { models });
  const file = parsed.file;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch (_) {}
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch (_) {}
}

function modelBackupPath(dataDir, backupId) {
  const id = String(backupId || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw new Error('非法模型备份标识');
  return path.join(modelBackupsDir(dataDir), `${id}.json`);
}

function readModelBackup(dataDir, backupId) {
  const file = modelBackupPath(dataDir, backupId);
  // 第七轮复核 P1：模型备份是敏感配置（含 apiKey）——符号链接一律拒绝读取
  //（旧实现读链接目标，外部 JSON 的 apiKey 会被列表/恢复返回）
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('模型备份是符号链接，拒绝读取');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('模型备份不存在');
    throw e;
  }
  if (!fs.existsSync(file)) throw new Error('模型备份不存在');
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`模型备份损坏: ${e.message}`); }
  if (!record || record.schema !== 1 || !record.model || typeof record.model !== 'object' || Array.isArray(record.model)) {
    throw new Error('模型备份格式不受支持');
  }
  return { file, record };
}

function listModelBackups(dataDir) {
  const dir = modelBackupsDir(dataDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /^[A-Za-z0-9_-]{8,100}\.json$/.test(name)); } catch (_) {}
  const records = [];
  for (const name of names) {
    const backupId = name.slice(0, -5);
    try {
      const { record } = readModelBackup(dataDir, backupId);
      const summary = sanitizeModel(record.model, { revealKey: true });
      records.push({ backupId, createdAt: record.createdAt || null, ...summary });
    } catch (_) {
      // Ignore damaged files in the list; an explicit enable/delete still reports an error.
    }
  }
  records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const groups = {};
  for (const record of records) {
    const key = record.id || '(未命名模型)';
    // 组名用模型名（id）：组内每个备份的自定义 name 可能不同，只有模型名一致
    if (!groups[key]) groups[key] = { id: key, name: key, items: [] };
    groups[key].items.push(record);
  }
  return Object.values(groups);
}

function listOfficialModels(file = workbuddyModelsFile()) {
  const parsed = readModelsFile(file);
  return parsed.models.map((model, index) => Object.assign({ index }, sanitizeModel(model, { revealKey: true })));
}

function readOfficialModel(file = workbuddyModelsFile(), index) {
  const parsed = readModelsFile(file);
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0 || position >= parsed.models.length) throw new Error('模型索引无效');
  const model = parsed.models[position];
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('模型配置无效');
  return model;
}

function deleteOfficialModels(file = workbuddyModelsFile(), indexes) {
  const parsed = readModelsFile(file);
  const positions = Array.isArray(indexes)
    ? Array.from(new Set(indexes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value < parsed.models.length)))
    : [];
  if (!positions.length) throw new Error('未选择当前模型');
  const selected = new Set(positions);
  const next = parsed.models.filter((_, index) => !selected.has(index));
  writeModelsFile(parsed, next);
  return { deleted: positions.length, official: next.map((model, index) => Object.assign({ index }, sanitizeModel(model))) };
}

function backupOfficialModel(dataDir, index, modelsFile = workbuddyModelsFile()) {
  const parsed = readModelsFile(modelsFile);
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0 || position >= parsed.models.length) throw new Error('模型索引无效');
  const model = parsed.models[position];
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('模型配置无效');
  const backupId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  fs.mkdirSync(modelBackupsDir(dataDir), { recursive: true, mode: 0o700 });
  const file = modelBackupPath(dataDir, backupId);
  fs.writeFileSync(file, JSON.stringify({ schema: 1, backupId, createdAt, model }, null, 2) + '\n', { mode: 0o600 });
  return { backupId, createdAt, ...sanitizeModel(model) };
}

function writeModelBackup(dataDir, record) {
  fs.mkdirSync(modelBackupsDir(dataDir), { recursive: true, mode: 0o700 });
  const file = modelBackupPath(dataDir, record.backupId);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function copyModelBackup(dataDir, backupId) {
  const { record } = readModelBackup(dataDir, backupId);
  const copied = Object.assign({}, record, {
    backupId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    model: Object.assign({}, record.model),
  });
  writeModelBackup(dataDir, copied);
  return { backupId: copied.backupId, createdAt: copied.createdAt, ...sanitizeModel(copied.model) };
}

function editModelBackup(dataDir, backupId, patch) {
  const { record } = readModelBackup(dataDir, backupId);
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const model = Object.assign({}, record.model);
  for (const field of ['name', 'url', 'apiKey']) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (typeof input[field] !== 'string' || input[field].length > 20000) throw new Error(`模型${field}格式无效`);
    model[field] = input[field];
  }
  const modelId = String(model.id || model.name || '').trim();
  if (!modelId) throw new Error('模型备份缺少 id/name，无法保存');
  if (!String(model.name || '').trim()) model.name = modelId;
  const updated = Object.assign({}, record, { model });
  writeModelBackup(dataDir, updated);
  return { backupId: updated.backupId, createdAt: updated.createdAt || null, ...sanitizeModel(model) };
}

function deleteModelBackups(dataDir, backupIds) {
  const ids = Array.isArray(backupIds) ? backupIds : [];
  let deleted = 0;
  const removed = [];
  for (const id of ids) {
    try {
      const file = modelBackupPath(dataDir, id);
      if (fs.existsSync(file)) { fs.unlinkSync(file); deleted++; removed.push(String(id)); }
    } catch (_) {}
  }
  if (removed.length && isManagedProfileDataDir(dataDir)) {
    const marker = path.join(sharedDataDir(), 'models', '.legacy-migrated-v1');
    try {
      const state = JSON.parse(fs.readFileSync(marker, 'utf8'));
      const deletedIds = new Set(Array.isArray(state.deleted) ? state.deleted : []);
      removed.forEach((id) => deletedIds.add(id));
      fs.writeFileSync(marker, JSON.stringify(Object.assign({}, state, { deleted: Array.from(deletedIds) })) + '\n', { mode: 0o600 });
      fs.chmodSync(marker, 0o600);
    } catch (_) {}
  }
  return deleted;
}

function enableModelBackup(dataDir, backupId, file = workbuddyModelsFile()) {
  const { record } = readModelBackup(dataDir, backupId);
  const modelId = String(record.model.id || record.model.name || '').trim();
  if (!modelId) throw new Error('模型备份缺少 id/name，无法启用');
  const parsed = readModelsFile(file);
  const models = parsed.models.slice();
  const first = models.findIndex((model) => String(model && (model.id || model.name) || '') === modelId);
  const next = [];
  let inserted = false;
  for (const model of models) {
    const id = String(model && (model.id || model.name) || '');
    if (id === modelId) {
      if (!inserted) { next.push(record.model); inserted = true; }
    } else next.push(model);
  }
  if (!inserted) next.push(record.model);
  writeModelsFile(parsed, next);
  return { backupId, id: modelId, replaced: first >= 0, ...sanitizeModel(record.model) };
}

function modelImportName(model) {
  return String(model && (model.name || model.id) || '').trim();
}

function importModels(targetFile, sourceFile) {
  const target = readModelsFile(targetFile);
  const source = readModelsFile(sourceFile);
  if (path.resolve(target.file) === path.resolve(source.file)) throw new Error('不能从当前客户端导入模型');
  const existing = new Set(target.models.map(modelImportName).filter(Boolean));
  const imported = [];
  const skipped = [];
  for (const model of source.models) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
    const name = modelImportName(model);
    if (!name || existing.has(name)) { if (name) skipped.push(name); continue; }
    target.models.push(model);
    existing.add(name);
    imported.push(name);
  }
  if (imported.length) writeModelsFile(target, target.models);
  return { imported, skipped, official: target.models.map((model, index) => Object.assign({ index }, sanitizeModel(model, { revealKey: true }))) };
}

function readMeta(dataDir) {
  let meta = { accounts: {} };
  try {
    meta = JSON.parse(fs.readFileSync(metaFile(dataDir), 'utf8'));
  } catch (_) {
    /* 首次运行或旧版本没有 meta.json */
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
  if (!meta.accounts || typeof meta.accounts !== 'object' || Array.isArray(meta.accounts)) meta.accounts = {};
  return meta;
}

function writeMeta(dataDir, meta) {
  ensureDirs(dataDir);
  const mf = metaFile(dataDir);
  const tmp = `${mf}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, mf);
  try { fs.chmodSync(mf, 0o600); } catch (_) {}
}

/** 使用稳定路径键，不要求路径当前存在（空间可能已被移动或卸载）。 */
function canonicalWorkspace(cwd) {
  let value = String(cwd || '').trim();
  if (!value) return '';
  value = value.replace(/\\/g, '/');
  value = path.posix.normalize(value);
  if (value === '.') return '';
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return IS_WIN ? value.toLowerCase() : value;
}

function ensureAutoCopyMeta(meta) {
  const current = meta.autoCopy;
  if (current && current.version === 2 && current.sessions && current.sessionIndex && current.workspaces && current.copies) {
    return current;
  }

  // 1.0.15 stored rules under sourceUid. Convert them once to global session lineages
  // and global workspace paths so a migration/copy keeps the same shared identity.
  const legacy = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const next = { version: 2, sessions: {}, sessionIndex: {}, workspaces: {}, copies: {} };
  const legacySessions = legacy.sessions && typeof legacy.sessions === 'object' ? legacy.sessions : {};
  for (const sourceUid of Object.keys(legacySessions)) {
    const bucket = legacySessions[sourceUid];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    for (const sessionId of Object.keys(bucket)) {
      const legacyRule = bucket[sessionId];
      if (legacyRule === false || (legacyRule && typeof legacyRule === 'object' && legacyRule.enabled === false)) continue;
      const lineageId = crypto.randomUUID();
      next.sessions[lineageId] = { enabled: true, members: [{ uid: sourceUid, id: sessionId }], createdAt: Date.now() };
      if (!next.sessionIndex[sourceUid]) next.sessionIndex[sourceUid] = {};
      next.sessionIndex[sourceUid][sessionId] = lineageId;
    }
  }
  const legacyWorkspaces = legacy.workspaces && typeof legacy.workspaces === 'object' ? legacy.workspaces : {};
  for (const sourceUid of Object.keys(legacyWorkspaces)) {
    const bucket = legacyWorkspaces[sourceUid];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    for (const cwd of Object.keys(bucket)) {
      if (bucket[cwd] === false) continue;
      const canonical = canonicalWorkspace(cwd);
      if (canonical) next.workspaces[canonical] = String(bucket[cwd] || cwd);
    }
  }
  const legacyCopies = legacy.copies && typeof legacy.copies === 'object' ? legacy.copies : {};
  for (const oldKey of Object.keys(legacyCopies)) {
    try {
      const parts = JSON.parse(oldKey);
      if (!Array.isArray(parts) || parts.length !== 3) continue;
      const lineageId = next.sessionIndex[String(parts[0] || '')] && next.sessionIndex[String(parts[0] || '')][String(parts[2] || '')];
      if (lineageId) next.copies[JSON.stringify([lineageId, String(parts[1] || '')])] = legacyCopies[oldKey];
    } catch (_) {}
  }
  meta.autoCopy = next;
  return next;
}

function readAutoCopyConfig(dataDir) {
  const meta = readMeta(dataDir);
  const wasCurrent = !!(meta.autoCopy && meta.autoCopy.version === 2);
  const autoCopy = ensureAutoCopyMeta(meta);
  if (!wasCurrent) writeMeta(dataDir, meta);
  return {
    sessions: autoCopy.sessions,
    sessionIndex: autoCopy.sessionIndex,
    workspaces: autoCopy.workspaces,
    copies: autoCopy.copies,
  };
}

function autoCopyRuleKey(lineageId, targetUid) {
  return JSON.stringify([String(lineageId || ''), String(targetUid || '')]);
}

function getAutoCopyRules(dataDir, uid) {
  const config = readAutoCopyConfig(dataDir);
  const sourceUid = String(uid || '').trim();
  const index = config.sessionIndex[sourceUid] || {};
  const sessionIds = [];
  const lineages = {};
  for (const sessionId of Object.keys(index)) {
    const lineageId = index[sessionId];
    const lineage = config.sessions[lineageId];
    if (lineage && lineage.enabled !== false) {
      sessionIds.push(sessionId);
      lineages[sessionId] = lineageId;
    }
  }
  return {
    sessionIds,
    lineages,
    workspaces: Object.keys(config.workspaces),
  };
}

function setAutoCopyRule(dataDir, { uid, kind, key, enabled }) {
  const sourceUid = String(uid || '').trim();
  if (kind !== 'session' && kind !== 'workspace') throw new Error('无效的自动复制规则类型');
  const value = kind === 'workspace' ? canonicalWorkspace(key) : String(key || '').trim();
  if (!value) throw new Error('缺少自动复制规则标识');
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  if (kind === 'workspace') {
    if (enabled) config.workspaces[value] = String(key || '').trim();
    else delete config.workspaces[value];
    writeMeta(dataDir, meta);
    return getAutoCopyRules(dataDir, sourceUid);
  }
  if (!sourceUid) throw new Error('缺少源账号 uid');
  if (!config.sessionIndex[sourceUid]) config.sessionIndex[sourceUid] = {};
  const lineageId = config.sessionIndex[sourceUid][value];
  if (enabled) {
    const lineage = lineageId && config.sessions[lineageId]
      ? config.sessions[lineageId]
      : { enabled: true, members: [], createdAt: Date.now() };
    if (!lineageId) {
      const createdId = crypto.randomUUID();
      config.sessions[createdId] = lineage;
      config.sessionIndex[sourceUid][value] = createdId;
      addLineageMember(lineage, sourceUid, value);
    } else {
      lineage.enabled = true;
      addLineageMember(lineage, sourceUid, value);
    }
  } else {
    if (lineageId && config.sessions[lineageId]) config.sessions[lineageId].enabled = false;
  }
  writeMeta(dataDir, meta);
  return getAutoCopyRules(dataDir, sourceUid);
}

function addLineageMember(lineage, uid, id) {
  if (!Array.isArray(lineage.members)) lineage.members = [];
  if (!lineage.members.some((member) => member && member.uid === uid && member.id === id)) {
    lineage.members.push({ uid, id });
  }
}

function getAutoCopySession(dataDir, uid, sessionId) {
  const config = readAutoCopyConfig(dataDir);
  const lineageId = config.sessionIndex[String(uid || '').trim()] && config.sessionIndex[String(uid || '').trim()][String(sessionId || '').trim()];
  const lineage = lineageId ? config.sessions[lineageId] : null;
  return { lineageId: lineageId || null, enabled: !!(lineage && lineage.enabled !== false) };
}

function ensureAutoCopySession(dataDir, uid, sessionId) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const sourceUid = String(uid || '').trim();
  const id = String(sessionId || '').trim();
  if (!sourceUid || !id) throw new Error('缺少共享会话标识');
  if (!config.sessionIndex[sourceUid]) config.sessionIndex[sourceUid] = {};
  let lineageId = config.sessionIndex[sourceUid][id];
  if (!lineageId || !config.sessions[lineageId]) {
    lineageId = crypto.randomUUID();
    config.sessions[lineageId] = { enabled: true, members: [], createdAt: Date.now() };
    config.sessionIndex[sourceUid][id] = lineageId;
  }
  addLineageMember(config.sessions[lineageId], sourceUid, id);
  writeMeta(dataDir, meta);
  return lineageId;
}

function addAutoCopySessionMember(dataDir, lineageId, uid, sessionId) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const lineage = config.sessions[String(lineageId || '')];
  if (!lineage) return false;
  const sourceUid = String(uid || '').trim();
  const id = String(sessionId || '').trim();
  if (!sourceUid || !id) return false;
  if (!config.sessionIndex[sourceUid]) config.sessionIndex[sourceUid] = {};
  const previousLineageId = config.sessionIndex[sourceUid][id];
  if (previousLineageId && previousLineageId !== String(lineageId) && config.sessions[previousLineageId]) {
    config.sessions[previousLineageId].members = (config.sessions[previousLineageId].members || [])
      .filter((member) => !(member && member.uid === sourceUid && member.id === id));
  }
  config.sessionIndex[sourceUid][id] = String(lineageId);
  addLineageMember(lineage, sourceUid, id);
  writeMeta(dataDir, meta);
  return true;
}

function moveAutoCopySession(dataDir, fromUid, toUid, sessionId) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const from = String(fromUid || '').trim();
  const to = String(toUid || '').trim();
  const id = String(sessionId || '').trim();
  if (!from || !to || !id || from === to) return false;
  const lineageId = config.sessionIndex[from] && config.sessionIndex[from][id];
  if (!lineageId || !config.sessions[lineageId]) return false;
  if (config.sessionIndex[from]) delete config.sessionIndex[from][id];
  if (!config.sessionIndex[to]) config.sessionIndex[to] = {};
  config.sessionIndex[to][id] = lineageId;
  const lineage = config.sessions[lineageId];
  lineage.members = (lineage.members || []).filter((member) => !(member && member.uid === from && member.id === id));
  addLineageMember(lineage, to, id);
  writeMeta(dataDir, meta);
  return true;
}

function removeAutoCopySession(dataDir, uid, sessionId) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const sourceUid = String(uid || '').trim();
  const id = String(sessionId || '').trim();
  const lineageId = config.sessionIndex[sourceUid] && config.sessionIndex[sourceUid][id];
  if (!lineageId) return false;
  delete config.sessionIndex[sourceUid][id];
  const lineage = config.sessions[lineageId];
  if (lineage) {
    lineage.members = (lineage.members || []).filter((member) => !(member && member.uid === sourceUid && member.id === id));
    if (!lineage.members.length) {
      delete config.sessions[lineageId];
      for (const key of Object.keys(config.copies)) {
        try {
          const parts = JSON.parse(key);
          if (Array.isArray(parts) && parts[0] === lineageId) delete config.copies[key];
        } catch (_) {
          // Ignore malformed legacy mapping keys; they cannot match a valid lineage.
        }
      }
    }
  }
  writeMeta(dataDir, meta);
  return true;
}

function removeAutoCopyAccount(dataDir, uid) {
  const sourceUid = String(uid || '').trim();
  if (!sourceUid) return 0;
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const index = config.sessionIndex[sourceUid] || {};
  const entries = Object.keys(index).map((sessionId) => ({ sessionId, lineageId: index[sessionId] }));
  let removed = 0;
  for (const entry of entries) {
    delete index[entry.sessionId];
    const lineage = config.sessions[entry.lineageId];
    if (!lineage) continue;
    lineage.members = (lineage.members || []).filter((member) => !(member && member.uid === sourceUid && member.id === entry.sessionId));
    if (!lineage.members.length) {
      delete config.sessions[entry.lineageId];
      for (const key of Object.keys(config.copies)) {
        try {
          const parts = JSON.parse(key);
          if (Array.isArray(parts) && parts[0] === entry.lineageId) delete config.copies[key];
        } catch (_) {}
      }
    }
    removed++;
  }
  if (entries.length) {
    delete config.sessionIndex[sourceUid];
    writeMeta(dataDir, meta);
  }
  return removed;
}

function resolveMappingLineage(config, lineageOrUid, maybeSessionId) {
  if (maybeSessionId === undefined) return String(lineageOrUid || '');
  const sourceUid = String(lineageOrUid || '').trim();
  const sessionId = String(maybeSessionId || '').trim();
  return config.sessionIndex[sourceUid] && config.sessionIndex[sourceUid][sessionId]
    ? config.sessionIndex[sourceUid][sessionId]
    : '';
}

// The optional legacy sessionId argument keeps 1.0.15 local callers compatible
// while all persisted keys use lineageId + targetUid.
function getAutoCopyMapping(dataDir, lineageOrUid, targetUid, maybeSessionId) {
  const config = readAutoCopyConfig(dataDir);
  const lineageId = resolveMappingLineage(config, lineageOrUid, maybeSessionId);
  return config.copies[autoCopyRuleKey(lineageId, targetUid)] || null;
}

function setAutoCopyMapping(dataDir, lineageOrUid, targetUid, mappingOrSessionId, maybeMapping) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const legacyCall = arguments.length >= 5;
  const lineageId = resolveMappingLineage(config, lineageOrUid, legacyCall ? mappingOrSessionId : undefined);
  const mapping = legacyCall ? maybeMapping : mappingOrSessionId;
  const key = autoCopyRuleKey(lineageId, targetUid);
  config.copies[key] = Object.assign({}, mapping, { updatedAt: Date.now() });
  writeMeta(dataDir, meta);
  return config.copies[key];
}

function deleteAutoCopyMapping(dataDir, lineageOrUid, targetUid, maybeSessionId) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const lineageId = resolveMappingLineage(config, lineageOrUid, maybeSessionId);
  delete config.copies[autoCopyRuleKey(lineageId, targetUid)];
  writeMeta(dataDir, meta);
}
function logFile(dataDir) {
  return path.join(dataDir, 'daemon.log');
}
function backupPath(dataDir, uid) {
  const safe = validateUid(uid);
  if (!safe) throw new Error(`非法账号 UID: ${String(uid).slice(0, 64)}`);
  const file = path.join(accountsDir(dataDir), `${safe}.info`);
  // 父目录约束：resolve 后必须仍在 accounts 目录内（防拼接逃逸）。
  const root = path.resolve(accountsDir(dataDir)) + path.sep;
  if (!path.resolve(file).startsWith(root)) throw new Error('账号路径越界');
  // 2026-08-30 第四轮复核 P1：accounts 本身若是符号链接，resolve 检查无效 → 物理校验。
  try {
    if (fs.lstatSync(accountsDir(dataDir)).isSymbolicLink()) {
      throw new Error('accounts 目录是符号链接，拒绝写入（防逃逸）');
    }
  } catch (e) {
    if (e.code !== 'ENOENT' && !/ENOENT/.test(String((e && e.message) || e))) throw e;
  }
  return file;
}

/** WorkBuddy ignores auth files while this marker exists; retire it after a switch. */
function retireLogoutMarker(log = () => {}) {
  if (!fs.existsSync(LOGOUT_MARKER)) return false;
  try {
    const retired = `${LOGOUT_MARKER}.retired.${process.pid}.${Date.now()}`;
    fs.renameSync(LOGOUT_MARKER, retired);
    try {
      fs.unlinkSync(retired);
    } catch (_) {
      // A leftover retired marker is harmless and keeps the operation recoverable.
    }
    log('[switch] 已清理 WorkBuddy 登录退出标记');
    return true;
  } catch (e) {
    if (IS_WIN) {
      throw new Error(`清理登录退出标记失败(${e.code || ''}): ${(e.message || e).toString().slice(0, 200)}`);
    }
    // WorkBuddy may launch the daemon in a sandbox that cannot unlink auth files.
    try {
      const { execFileSync } = require('child_process');
      const markerQ = LOGOUT_MARKER.replace(/"/g, '\\"');
      execFileSync('osascript', ['-e', `do shell script "rm -f \\\"${markerQ}\\\""`], {
        timeout: 15000,
        stdio: 'pipe',
      });
      if (fs.existsSync(LOGOUT_MARKER)) throw new Error('标记仍然存在');
      log('[switch] 已通过系统授权清理 WorkBuddy 登录退出标记');
      return true;
    } catch (e2) {
      throw new Error(`清理登录退出标记失败: ${(e2.message || e2).toString().slice(0, 200)}`);
    }
  }
}

/**
 * 兼容旧版数据：把 HelloBuddy 中尚未存在于 WorkDaddy 的数据实体复制过来。
 * 只对平台默认 WorkDaddy 目录执行，显式自定义数据目录不做隐式迁移。
 * 源目录和文件均保留，重复调用幂等。
 *
 * 说明：会话不存在旧目录实体可迁——宿主 App 的会话存自身数据库
 * （如 ~/.workbuddy/workbuddy.db），与新旧品牌数据目录无关，此处如实不假装迁移。
 */
// 可整体复制的旧数据实体清单（[相对路径, 类型]）：主题（含壁纸）/暂存/当前主题/遮罩。
const LEGACY_ENTITY_PLAN = [
  ['themes', 'dir'],
  ['stash', 'dir'],
  ['stash-index.json', 'file'],
  ['current-theme.json', 'file'],
  ['mask.json', 'file'],
];

// 把 sourceRoot 下的实体按计划 copy-if-absent 到 dataDir（存在即跳过，绝不覆盖）。
// 独立导出以便单测（不依赖平台默认目录判定）。
// 2026-08-30 复核 P1：旧实现用 statSync（跟随符号链接）+ cpSync（默认保留链接），
// 旧目录里的 themes 符号链接会被复制成指向目录外部的链接 → 符号链接逃逸（读/写越界）。
// 现改为：lstatSync 判定，符号链接实体一律拒绝迁移并留痕；目录复制显式 dereference
// 且逐项跳过内部符号链接，绝不复制指向外部的链接。
function migrateLegacyEntities(sourceRoot, dataDir, log = () => {}) {
  const counts = { themes: 0, stash: 0, files: 0, skippedSymlinks: 0 };
  if (!sourceRoot) return counts;
  for (const [rel, kind] of LEGACY_ENTITY_PLAN) {
    const src = path.join(sourceRoot, rel);
    const dst = path.join(dataDir, rel);
    let st;
    try {
      st = fs.lstatSync(src); // 不跟随链接：符号链接必须被识别而不是被解引用
    } catch (_) {
      continue; // 旧目录无该实体，静默跳过
    }
    // 符号链接实体：拒绝迁移（防逃逸）
    if (st.isSymbolicLink()) {
      counts.skippedSymlinks += 1;
      log(`[migrate] 跳过符号链接实体（防逃逸）: ${rel}`);
      continue;
    }
    if (fs.existsSync(dst)) continue; // 幂等：目标已存在绝不覆盖
    try {
      if (kind === 'dir' && st.isDirectory()) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, {
          recursive: true,
          dereference: true, // 解引用：复制内容而非链接
          filter: (s) => {
            try {
              // 目录内部任一符号链接一律跳过，避免复制出指向外部的链接
              return !fs.lstatSync(s).isSymbolicLink();
            } catch (_) {
              return false;
            }
          },
        });
        try { fs.chmodSync(dst, 0o700); } catch (_) {}
        let n = 0;
        try { n = fs.readdirSync(src).length; } catch (_) {}
        if (rel === 'stash') counts.stash += n; else counts.themes += n;
      } else if (kind === 'file' && st.isFile()) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        try { fs.chmodSync(dst, 0o600); } catch (_) {}
        counts.files += 1;
      }
      log(`[migration] 已从旧目录迁移 ${rel} → ${dst}`);
    } catch (e) {
      log(`[migration] 迁移 ${rel} 失败: ${(e.message || e).toString().slice(0, 200)}`);
    }
  }
  return counts;
}

function migrateLegacyDataDir(dataDir, log = () => {}) {
  if (IS_WIN || !samePath(dataDir, PLATFORM_DATA_DIR)) {
    return { migrated: 0, skipped: 0, source: null, target: dataDir, extras: null };
  }

  // 数据实体（主题/暂存/当前主题/遮罩）与账号相互独立，先于账号迁移执行：
  // 即使旧目录没有 accounts，这些实体也应迁移。
  const extras = migrateLegacyEntities(LEGACY_DATA_DIR, dataDir, log);

  const sourceAccounts = accountsDir(LEGACY_DATA_DIR);
  if (!fs.existsSync(sourceAccounts)) {
    return { migrated: 0, skipped: 0, source: LEGACY_DATA_DIR, target: dataDir, extras };
  }

  let names;
  try {
    names = fs
      .readdirSync(sourceAccounts)
      .filter((name) => name.endsWith('.info') && !name.endsWith('.tmp'));
  } catch (_) {
    return { migrated: 0, skipped: 0, source: LEGACY_DATA_DIR, target: dataDir, extras };
  }

  const targetAccounts = accountsDir(dataDir);
  fs.mkdirSync(targetAccounts, { recursive: true, mode: 0o700 });
  let migrated = 0;
  let skipped = 0;
  for (const name of names) {
    const source = path.join(sourceAccounts, name);
    const target = path.join(targetAccounts, name);
    if (fs.existsSync(target)) {
      skipped += 1;
      continue;
    }
    try {
      // 迁移即加密：旧明文备份读入后立即以加密形式落盘（P1-2），不保留明文副本。
      const obj = JSON.parse(fs.readFileSync(source, 'utf8'));
      writeAccountFile(dataDir, target, obj);
      migrated += 1;
    } catch (e) {
      log(`[migration] 迁移账号 ${name} 失败: ${e.message}`);
    }
  }
  if (migrated) {
    log(`[migration] 已从 ${LEGACY_DATA_DIR}/accounts 迁移 ${migrated} 个账号到 ${dataDir}/accounts`);
  }
  return { migrated, skipped, source: LEGACY_DATA_DIR, target: dataDir, extras };
}

function ensureDirs(dataDir, log = () => {}) {
  // 第七轮复核 P0（修复）：统一物理校验升级——dataDir **父级链**上的链接也会被
  // realpath 字面比较识破（root/parent-link → 外部时 ensureDirs(dataDir) 会把外部
  // 目录当数据根建 accounts）。检查必须在迁移/建目录之前（fail-closed 零写入）。
  const accDir = accountsDir(dataDir);
  if (!isPhysicallyRealPath(dataDir) || !isPhysicallyRealPath(accDir)) {
    throw new Error(`数据目录含符号链接，拒绝写入（防逃逸）: ${dataDir}`);
  }
  migrateLegacyDataDir(dataDir, log);
  fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch (_) {
    /* 已存在时可能失败，忽略 */
  }
}

/** 读取登录信息文件并抽取账号关键字段（不返回令牌内容） */
function readAuthFile() {
  if (!ACTIVE_PROFILE.authFile && !process.env.WBSWITCH_AUTH_FILE) {
    throw new Error(`${ACTIVE_PROFILE.name} 没有可读取的明文认证文件`);
  }
  const raw = fs.readFileSync(AUTH_FILE, 'utf8');
  const json = JSON.parse(raw);
  if (!json || typeof json !== 'object') {
    throw new Error('auth 文件不是有效的 JSON 对象');
  }
  const acct = json.account || (Array.isArray(json.accounts) && json.accounts[0]) || null;
  if (!acct || !acct.uid) {
    throw new Error('auth 文件中未找到 account.uid');
  }
  return {
    uid: acct.uid,
    nickname: acct.nickname || '',
    uin: acct.uin || '',
    phone: acct.phoneNumber || '',
    type: acct.type || '',
    raw: json,
  };
}

/** 更新 meta.json（uid -> nickname/uin/phone/时间） */
function updateMeta(dataDir, info) {
  const meta = readMeta(dataDir);
  const now = Date.now();
  const prev = meta.accounts[info.uid] || {};
  meta.accounts[info.uid] = {
    uid: info.uid,
    nickname: info.nickname || prev.nickname || '',
    uin: info.uin || prev.uin || '',
    phone: info.phone || prev.phone || '',
    firstSeen: prev.firstSeen || now,
    lastSeen: now,
  };
  writeMeta(dataDir, meta);
  return meta;
}

/** 把当前登录信息备份到 accounts/<uid>.info（原子写入，0600） */
function backupCurrent(dataDir, log = () => {}) {
  if (!ACTIVE_PROFILE.capabilities.accounts) throw new Error(`${ACTIVE_PROFILE.name} 暂不支持账号文件备份`);
  ensureDirs(dataDir, log);
  const info = readAuthFile();
  const dest = backupPath(dataDir, info.uid);
  const tmp = dest + '.tmp';
  writeAccountFile(dataDir, tmp, JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')));
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
  updateMeta(dataDir, info);
  log(
    `[sync] 已备份账号 ${info.nickname || info.uid} (${info.uid}) -> ${dest}`
  );
  return info;
}

/** 列出所有已备份账号（直接读备份文件提取展示字段，按最近刷新时间倒序） */
function listAccounts(dataDir) {
  if (!ACTIVE_PROFILE.capabilities.accounts) return [];
  migrateLegacyDataDir(dataDir);
  const dir = accountsDir(dataDir);
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.info') && !f.endsWith('.tmp'));
  } catch (_) {
    /* 目录不存在 */
  }
  const list = names.map((n) => {
    const uid = n.replace(/\.info$/, '');
    const item = {
      uid,
      nickname: '',
      phone: '',
      uin: '',
      tokenExpiresAt: null,
      refreshExpiresAt: null,
      lastRefreshTime: null,
      lastSeen: null,
    };
    try {
      const j = readAccountFile(dataDir, path.join(dir, n));
      const acct = j.account || (Array.isArray(j.accounts) && j.accounts[0]);
      if (acct) {
        item.nickname = acct.nickname || '';
        item.phone = acct.phoneNumber || '';
        item.uin = acct.uin || '';
      }
      if (j.auth) {
        item.tokenExpiresAt = j.auth.expiresAt || null;
        item.refreshExpiresAt = j.auth.refreshExpiresAt || null;
        item.lastRefreshTime = j.auth.lastRefreshTime || null;
      }
    } catch (_) {
      /* 文件损坏则显示空字段 */
    }
    return item;
  });
  return list.sort(
    (a, b) => (b.lastRefreshTime || 0) - (a.lastRefreshTime || 0)
  );
}

/** 永久删除某个账号的备份文件（不影响当前登录） */
function deleteAccount(dataDir, uid) {
  if (!ACTIVE_PROFILE.capabilities.accounts) throw new Error(`${ACTIVE_PROFILE.name} 暂不支持账号切换`);
  migrateLegacyDataDir(dataDir);
  const file = backupPath(dataDir, uid);
  let deletedFile = false;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    deletedFile = true;
  }
  const mf = metaFile(dataDir);
  try {
    const meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (meta.accounts && meta.accounts[uid]) {
      delete meta.accounts[uid];
      // 2026-08-30 复核 P2：旧实现直接 writeFileSync 覆盖 meta.json，进程中断/磁盘满
      // 会留下半截 JSON（账号索引整体损坏）。复用 writeMeta（tmp+rename 原子写）。
      writeMeta(dataDir, meta);
    }
  } catch (_) {
    /* meta 不存在则忽略 */
  }
  return { deleted: deletedFile, uid };
}

/** 切换登录账号：把备份文件复制回登录信息文件（先校验 uid 匹配） */
function switchTo(dataDir, uid, log = () => {}) {
  if (!ACTIVE_PROFILE.capabilities.accounts) throw new Error(`${ACTIVE_PROFILE.name} 暂不支持账号切换`);
  migrateLegacyDataDir(dataDir, log);
  const src = backupPath(dataDir, uid);
  if (!fs.existsSync(src)) {
    throw new Error(`未找到账号 ${uid} 的备份文件`);
  }
  const json = readAccountFile(dataDir, src);
  const raw = JSON.stringify(json); // 解密后的明文（写回登录文件，WorkBuddy 官方读明文）
  const acct = json.account || (Array.isArray(json.accounts) && json.accounts[0]);
  if (!acct || acct.uid !== uid) {
    throw new Error('备份文件校验失败：uid 不匹配，已中止切换');
  }
  const tmp = AUTH_FILE + '.wbswitch.tmp';
  try {
    fs.writeFileSync(tmp, raw, { mode: 0o600 });
    fs.renameSync(tmp, AUTH_FILE);
    fs.chmodSync(AUTH_FILE, 0o600);
  } catch (e) {
    // 沙箱环境（如从 WorkBuddy 托管后台运行）直接写系统目录会 EPERM。
    // macOS 回退：osascript 委托 GUI 会话复制（不涉及内容转义，只传路径）。
    // Windows：目录在 %LOCALAPPDATA% 用户可写区，直写失败即如实报错。
    if (IS_WIN) {
      throw new Error(
        `写入登录文件失败(${e.code || ''}): ${(e.message || e).toString().slice(0, 200)}`
      );
    }
    log(`[switch] 直写失败(${e.code})，改用 osascript 委托写入`);
    const bridge = path.join(dataDir, '.auth-switch-bridge.tmp');
    const authBridge = AUTH_FILE + '.wbswitch.tmp';
    const bridgeQ = bridge.replace(/"/g, '\\"');
    const authQ = AUTH_FILE.replace(/"/g, '\\"');
    const tmpQ = authBridge.replace(/"/g, '\\"');
    try {
      // 1) 本进程写 bridge（数据目录可写）
      fs.writeFileSync(bridge, raw, { mode: 0o600 });
      // 2) osascript 委托：bridge -> auth 目录
      const script = `do shell script "cp \\"${bridgeQ}\\" \\"${tmpQ}\\" && mv \\"${tmpQ}\\" \\"${authQ}\\" && chmod 600 \\"${authQ}\\" && rm -f \\"${bridgeQ}\\" && echo OK"`;
      const { execFileSync } = require('child_process');
      execFileSync('osascript', ['-e', script], { timeout: 15000, stdio: 'pipe' });
    } catch (e2) {
      try { fs.unlinkSync(bridge); } catch (_) {}
      throw new Error(`写入登录文件失败: ${(e2.message || e2).toString().slice(0, 200)}`);
    }
  }
  retireLogoutMarker(log);
  log(`[switch] 已切换登录账号为 ${acct.nickname || uid} (${uid})`);
  return { uid: acct.uid, nickname: acct.nickname || '', uin: acct.uin || '' };
}

module.exports = {
  AUTH_FILE,
  ACTIVE_PROFILE,
  defaultDataDir,
  migrateLegacyDataDir,
  migrateLegacyEntities,
  accountsDir,
  metaFile,
  workbuddyModelsFile,
  modelBackupsDir,
  maskApiKey,
  sanitizeModel,
  checkinDisplayValue,
  listOfficialModels,
  readOfficialModel,
  readModelBackup,
  deleteOfficialModels,
  listModelBackups,
  backupOfficialModel,
  copyModelBackup,
  editModelBackup,
  deleteModelBackups,
  enableModelBackup,
  importModels,
  logFile,
  backupPath,
  retireLogoutMarker,
  ensureDirs,
  readAuthFile,
  updateMeta,
  canonicalWorkspace,
  getAutoCopyRules,
  setAutoCopyRule,
  getAutoCopySession,
  ensureAutoCopySession,
  addAutoCopySessionMember,
  moveAutoCopySession,
  removeAutoCopySession,
  removeAutoCopyAccount,
  getAutoCopyMapping,
  setAutoCopyMapping,
  deleteAutoCopyMapping,
  backupCurrent,
  listAccounts,
  switchTo,
  deleteAccount,
  validateUid,
  writeAccountFile,
  readAccountFile,
  accountDataKey,
  ENC_MAGIC,
};
