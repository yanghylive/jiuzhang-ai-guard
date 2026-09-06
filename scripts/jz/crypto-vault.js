'use strict';
// 密钥与加解密（06 §3）。AES-256-GCM，每备份唯一 nonce。
// 生产密钥存储：macOS Keychain / Windows DPAPI（CurrentUser）；无平台密钥存储时
// 降级为权限 0600 的本地密钥文件（非固定默认密钥）。不使用外部依赖。
//
// 2026-08-29 复查 P1：补齐 Windows DPAPI 分支 —— 32 字节数据密钥经 CryptProtectData
// （CurrentUser scope）加密后落 .vault-key.dpapi（base64），明文密钥不再落盘；
// 首次运行发现旧明文 .vault-key 时自动迁移（读出 → DPAPI 保护写入 → 删除明文）。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { dataRoot, readJSON, atomicWriteJSONPrivate, ensurePrivateMode, readFileNoSymlink } = require('./lib');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

const KEYCHAIN_SERVICE = 'com.jz-ai-guard.vault-key';
const KEYCHAIN_ACCOUNT = 'data-key';

// DPAPI 进程内缓存：daemon 常驻时避免每次备份/恢复都起一个 powershell（~300ms/次）。
const dpapiCache = new Map(); // root → Buffer(32)

function deriveKeyFromPassphrase(passphrase, salt) {
  // 2026-08-30 复核 P0：非字符串/空密码一律抛错（旧实现 String(undefined) → "undefined"
  // 字面量当密码，等价于公开常量，任何人传空即可解密）。调用方须先校验。
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('KDF 需要非空字符串密码');
  }
  return crypto.scryptSync(passphrase, salt, 32);
}

// macOS Keychain 读/写（生产路径）。deps 可注入 platform/exec 以便单测。
// 密钥以 hex 存储；返回 Buffer(32)，读不到/写失败返回 null/false（调用方降级文件）。
function keychainGetKey(deps = {}) {
  const { platform = process.platform, exec = execFileSync } = deps;
  if (platform !== 'darwin') return null;
  try {
    const out = exec(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const key = Buffer.from(String(out).trim(), 'hex');
    if (key.length === 32) return key;
  } catch {
    /* not found or inaccessible */
  }
  return null;
}

function keychainSetKey(key, deps = {}) {
  const { platform = process.platform, exec = execFileSync } = deps;
  if (platform !== 'darwin') return false;
  try {
    exec(
      '/usr/bin/security',
      ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', key.toString('hex')],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

function keychainDeleteKey(deps = {}) {
  const { platform = process.platform, exec = execFileSync } = deps;
  if (platform !== 'darwin') return false;
  try {
    exec(
      '/usr/bin/security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

// ===== Windows DPAPI（CurrentUser scope）=====
// 用 PowerShell ProtectedData.Protect/Unprotect，经 -EncodedCommand 传输避免引号转义问题。
// deps 可注入 platform/exec 以便单测；真实路径 powershell.exe 一次 ~300ms（进程内有缓存）。
function dpapiCommand(script, deps = {}) {
  const { exec = execFileSync } = deps;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  return String(out).trim();
}

function dpapiProtect(keyHex, deps = {}) {
  const script =
    "Add-Type -AssemblyName System.Security\n" +
    "$b = [byte[]]::new(" + keyHex.length / 2 + ")\n" +
    "for($i=0;$i -lt " + keyHex.length / 2 + ";$i++){ $b[$i] = [Convert]::ToByte('" + keyHex + "'.Substring($i*2,2),16) }\n" +
    "$p = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)\n" +
    "[Convert]::ToBase64String($p)";
  return dpapiCommand(script, deps);
}

function dpapiUnprotect(b64, deps = {}) {
  const script =
    "Add-Type -AssemblyName System.Security\n" +
    "$p = [Convert]::FromBase64String('" + b64 + "')\n" +
    "$b = [System.Security.Cryptography.ProtectedData]::Unprotect($p, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)\n" +
    "(($b | ForEach-Object { $_.ToString('x2') }) -join '')";
  return dpapiCommand(script, deps);
}

function dpapiFilePath(root) {
  return path.join(root || dataRoot(), 'license', '.vault-key.dpapi');
}

// 读：.vault-key.dpapi → Unprotect → hex(64)。失败返回 null。
function dpapiGetKey(root, deps = {}) {
  const { platform = process.platform } = deps;
  if (platform !== 'win32') return null;
  const p = dpapiFilePath(root);
  let b64;
  try {
    // 第九轮复核 P1：统一 readFileNoSymlink——.vault-key.dpapi 是符号链接时
    //（伪造 DPAPI 文件指向外部）旧 fs.readFileSync 会读外部并解密成功。
    b64 = readFileNoSymlink(p).toString('utf8').trim();
  } catch (e) {
    // 第十轮复核 P1：ESYMLINK 必须**上抛**——return null 会让 loadOrCreateDataKey
    // 继续创建新密钥，随后 dpapiSetKey 的 writeFileSync 跟随链接**覆盖外部目标**
    //（产品负责人已完整复现：外部文件内容被改写）。ESYMLINK = 凭据被替换为链接 = 严重攻击。
    if (e && e.code === 'ESYMLINK') throw e;
    return null; // 文件不存在/其他 IO 错误
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  try {
    const hex = dpapiUnprotect(b64, deps);
    const key = Buffer.from(String(hex).trim(), 'hex');
    if (key.length === 32) return key;
  } catch {
    /* DPAPI 属主不匹配（不同用户/机器迁移）→ 按不可用处理 */
  }
  return null;
}

// 写：key hex → Protect → base64 落 .vault-key.dpapi（0600 尽力而为）。成功后删除旧明文 .vault-key。
function dpapiSetKey(key, root, deps = {}) {
  const { platform = process.platform } = deps;
  if (platform !== 'win32') return false;
  try {
    const b64 = dpapiProtect(key.toString('hex'), deps);
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return false;
    const p = dpapiFilePath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 第十一轮复核 P2：原子写入（tmp + rename）消除 lstat→write TOCTOU——
    // tmp 是新随机名（无链接风险），renameSync(tmp, p) 替换的是 p 的目录项本身
    //（p 是符号链接时替换链接、不跟随外部目标）。lstat 预检保留作双保险。
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return false;
    } catch (e) {
      if (e.code !== 'ENOENT' && !/ENOENT/.test(String((e && e.message) || e))) return false;
    }
    const tmp = `${p}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, b64 + '\n', { mode: 0o600 });
      if (process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o600); } catch {} }
      fs.renameSync(tmp, p);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
      throw e;
    }
    // 迁移：删除旧明文密钥文件
    try { fs.rmSync(path.join(root || dataRoot(), 'license', '.vault-key'), { force: true }); } catch {}
    return true;
  } catch {
    return false;
  }
}

// 数据密钥来源优先级：macOS Keychain → Windows DPAPI → 0600 本地文件（降级）。
// 进程内缓存（同 root 只解析一次）；首次创建优先平台密钥存储，不可用才落文件。
function loadOrCreateDataKey(root, deps = {}) {
  root = root || dataRoot();
  if (dpapiCache.has(root)) return dpapiCache.get(root);
  const keyPath = path.join(root, 'license', '.vault-key');

  const kc = keychainGetKey(deps);
  if (kc) {
    // 2026-08-30 第五轮复核 P1：命中 Keychain 后顺手删除残留明文 .vault-key
    //（否则明文密钥与平台存储并存，明文残留违反 Keychain 优先要求）
    try { fs.rmSync(keyPath, { force: true }); } catch (_) {}
    dpapiCache.set(root, kc);
    return kc;
  }
  const dp = dpapiGetKey(root, deps);
  if (dp) {
    // 命中 DPAPI 同样清理残留明文（第五轮复核 P1）
    try { fs.rmSync(keyPath, { force: true }); } catch (_) {}
    dpapiCache.set(root, dp);
    return dp;
  }

  try {
    // 第八/九轮复核：旧明文密钥统一 readFileNoSymlink（链接 → ESYMLINK 上抛，
    // 绝不读外部密钥，也绝不静默 fall through 创建新密钥——那会让旧数据解不开）
    const raw = readFileNoSymlink(keyPath);
    if (raw.length === 32) {
      // 迁移窗口：明文密钥存在时按平台尝试升级（第四轮复核 P1 修复：
      // 旧实现 macOS 只试 DPAPI（必然失败）→ 明文 .vault-key 永久残留，Keychain 优先被违反）。
      if (dpapiSetKey(raw, root, deps)) {
        dpapiCache.set(root, raw);
        return raw;
      }
      if (keychainSetKey(raw, deps)) {
        dpapiCache.set(root, raw);
        try { fs.rmSync(keyPath, { force: true }); } catch (_) {} // 已入 Keychain → 删明文
        return raw;
      }
      dpapiCache.set(root, raw);
      return raw; // 平台密钥存储均不可用 → 暂继续用明文（下次启动再尝试迁移）
    }
  } catch (e) {
    // 第八轮复核 P1：ESYMLINK（.vault-key 被替换为链接）必须上抛 fail-closed——
    // 不读外部密钥，也绝不静默创建新密钥（那会让旧数据解不开、且写链接外部）
    if (e && e.code === 'ESYMLINK') throw e;
    /* 其余 IO 错误 → fall through to create */
  }

  const key = crypto.randomBytes(32);
  if (keychainSetKey(key, deps)) {
    dpapiCache.set(root, key);
    return key; // 已入 Keychain，无需文件
  }
  if (dpapiSetKey(key, root, deps)) {
    dpapiCache.set(root, key);
    return key; // 已入 DPAPI，无需文件
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  // 2026-08-31 复核 P2（Codex #4，TOCTOU）：上面检查与这里写入之间 keyPath 可能被替换成
  // 符号链接，直接 writeFileSync 会穿透链接改写外部文件。改 wx 独占创建临时文件 + rename
  // 原子落位（与 dpapiSetKey 同套路）：目标名被链接占用时 wx 报 EEXIST，绝不穿透写。
  const tmpKey = `${keyPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let fd = null;
  try {
    fd = fs.openSync(tmpKey, 'wx', 0o600);
    fs.writeFileSync(fd, key);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmpKey, keyPath);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.rmSync(tmpKey, { force: true }); } catch (_) {}
    throw e;
  }
  dpapiCache.set(root, key);
  return key;
}

// 2026-08-31 复核第二轮 P2（Codex #2）：只读取数据密钥（严格只读路径用）。
// 与 loadOrCreateDataKey 同源（缓存 → Keychain → DPAPI → 明文文件），但：
// ①密钥不存在 → 返回 null，绝不创建（无写盘副作用）；
// ②不清理 Keychain 命中后的残留明文（那也是写操作）。
function loadDataKeyReadOnly(root, deps = {}) {
  root = root || dataRoot();
  if (dpapiCache.has(root)) return dpapiCache.get(root);
  const keyPath = path.join(root, 'license', '.vault-key');
  const kc = keychainGetKey(deps);
  if (kc) return kc;
  const dp = dpapiGetKey(root, deps);
  if (dp) return dp;
  try {
    const raw = readFileNoSymlink(keyPath);
    if (raw.length === 32) return raw;
  } catch (_) {}
  return null;
}

function encrypt(key, plaintextBuf) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext: enc };
}

function decrypt(key, iv, tag, ciphertext) {
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ===== 凭据文件加密存储（2026-08-29 复核 P1）=====
// OIDC / desktop-auth 的 access/refresh token 不再以 0600 明文 JSON 落盘，
// 改为「数据密钥（Keychain/DPAPI/0600 文件三级）派生 → AES-256-GCM 加密 → base64 落盘」。
// 格式：{ v: 2, kdf: 'data-key', iv, tag, data(base64) }；读取时自动识别旧明文并原地迁移加密。
const CRED_MAGIC_VERSION = 2;
const CRED_FILE_RE = /\.json$/;

function credEncrypt(root, obj) {
  const key = loadOrCreateDataKey(root);
  const { iv, tag, ciphertext } = encrypt(key, Buffer.from(JSON.stringify(obj), 'utf8'));
  return { v: CRED_MAGIC_VERSION, kdf: 'data-key', iv: iv.toString('base64'), tag: tag.toString('base64'), data: ciphertext.toString('base64') };
}

function credDecrypt(root, envelope) {
  return credDecryptWithKey(loadOrCreateDataKey(root), envelope);
}

// 2026-08-31 复核第二轮 P2（Codex #2）：key 由调用方提供的解密（严格只读路径用），
// 密钥缺失由调用方决定 fail-closed，不在本函数内触发新密钥创建。
function credDecryptWithKey(key, envelope) {
  if (!key) return null;
  if (!envelope || envelope.v !== CRED_MAGIC_VERSION || !envelope.iv || !envelope.tag || !envelope.data) return null;
  try {
    const plain = decrypt(
      key,
      Buffer.from(envelope.iv, 'base64'),
      Buffer.from(envelope.tag, 'base64'),
      Buffer.from(envelope.data, 'base64'),
    );
    return JSON.parse(plain.toString('utf8'));
  } catch {
    return null; // 解密失败（密钥轮换/损坏）→ 视为无会话，fail-closed
  }
}

// 写凭据文件（加密）。
// 2026-08-30 复核 P0：绝不留明文备份——旧实现会写 `${p}.plain-bak-<ts>` 永久明文副本，
// 违反清单「凭据类操作无明文备份残留」。改为「先加密后原子覆盖」：
// atomicWriteJSONPrivate 是 tmp+fsync+rename，明文只有被 rename 覆盖后消失，无中间明文落盘。
function atomicWriteCredFile(root, p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const enc = credEncrypt(root, obj);
  atomicWriteJSONPrivate(p, enc);
  ensurePrivateMode(p);
  return enc;
}

// 读凭据文件：优先解密 v2；旧明文（无 v2 标记）→ 原地迁移为加密。
// 2026-08-30 复核 P0：迁移失败一律 fail-closed（不返回明文）。
// 2026-08-31 复核 P1（Codex #2）：凭据文件禁符号链接——旧实现 readJSON 直接读，
// license/desktop-auth.json 被链到外部 JSON 时会读出外部 accessToken（与 .vault-key 的
// fail-closed 策略不一致）。统一 readFileNoSymlink：ESYMLINK → 返回 null（视同无凭据，
// 调用方按未登录处理；保存新登录时 atomicWriteCredFile 的 rename 会替换链接自愈）。
// 2026-08-31 复核 P2（Codex #7）：opts.noMigrate = 严格只读（试算路径），旧明文不迁移不写盘。
function readCredFile(root, p, opts = {}) {
  let raw = null;
  try {
    const buf = readFileNoSymlink(p);
    try { raw = JSON.parse(buf.toString('utf8')); } catch (_) { return null; }
  } catch (e) {
    // ESYMLINK / ENOENT / 其他 IO 错误一律 fail-closed 返回 null（绝不读链接目标内容）
    return null;
  }
  if (!raw) return null;
  if (raw.v === CRED_MAGIC_VERSION) {
    if (opts.noMigrate) {
      // 2026-08-31 复核第二轮 P2（Codex #2）：严格只读路径——①不收紧权限（chmod 也是写盘）；
      // ②密钥不存在时不创建新密钥（loadOrCreateDataKey 的创建分支有写盘副作用），解密失败一律 null。
      // opts.deps 透传平台注入（测试用），与 loadOrCreateDataKey 的 deps 同构。
      const key = loadDataKeyReadOnly(root, opts.deps || {});
      if (!key) return null;
      return credDecryptWithKey(key, raw);
    }
    // 权限幂等收紧（旧版本可能落过 0644，不破坏加密内容）
    ensurePrivateMode(p);
    const dec = credDecrypt(root, raw);
    if (dec) return dec;
    // 解密失败：可能是密钥丢失/轮换 → fail-closed（不信任密文）
    return null;
  }
  // 旧明文格式：noMigrate（严格只读路径）→ 返回 null，绝不写盘
  if (opts.noMigrate) return null;
  // 旧明文格式：迁移为加密存储。成功返回明文内容；失败 fail-closed 返回 null
  //（凭据可重新登录获取，绝不留明文副本 / 绝不因迁移失败继续以明文形式使用）。
  const plain = raw;
  try {
    atomicWriteCredFile(root, p, plain);
    // 迁移成功：确认落盘内容是密文（v2 信封），否则视为迁移失败
    const after = readJSON(p);
    if (!after || after.v !== CRED_MAGIC_VERSION) return null;
    return plain;
  } catch (_) {
    return null;
  }
}

// 清理历史遗留的明文备份文件：旧版本迁移时留下的明文副本。
// 2026-08-30 复核 P0（修复）：旧正则 `/^\.plain-bak-/` 只匹配「以 .plain-bak- 开头」的文件，
// 而实际历史文件名是 `<凭据文件名>.plain-bak-<时间戳>`（后缀形式），导致实测清理数为 0。
// 现改为匹配任意位置的 `.plain-bak-<时间戳>` 后缀。
function sweepPlainBackups(dir) {
  let removed = 0;
  try {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      if (!/\.plain-bak-\d+$/.test(name)) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        removed += 1;
      } catch (_) { /* 单个失败不影响其他 */ }
    }
  } catch (_) { /* 目录不存在 */ }
  return removed;
}

// 递归清理数据目录下的历史明文副本（license / accounts / 根目录），供 daemon 启动时调用。
// 2026-08-30 复核 P0（修复）：sweepPlainBackups 此前没有任何生产调用点。
function sweepAllPlainBackups(dataDir) {
  if (!dataDir) return 0;
  const targets = [path.join(dataDir, 'license'), path.join(dataDir, 'accounts'), dataDir];
  let total = 0;
  for (const d of targets) total += sweepPlainBackups(d);
  return total;
}

module.exports = {
  ALGO, IV_LEN, TAG_LEN,
  deriveKeyFromPassphrase, loadOrCreateDataKey, loadDataKeyReadOnly, encrypt, decrypt,
  credEncrypt, credDecrypt, credDecryptWithKey, atomicWriteCredFile, readCredFile, sweepPlainBackups,
  sweepAllPlainBackups,
  KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT,
  keychainGetKey, keychainSetKey, keychainDeleteKey,
  dpapiGetKey, dpapiSetKey, dpapiFilePath, dpapiProtect, dpapiUnprotect,
};