'use strict';
// 统一脱敏（03 §5 / 06 威胁模型 / 08 安全测试）：禁止 token/Cookie/密码/API Key/私钥/聊天正文/完整账号备份进入日志或诊断包。
const SENSITIVE = new Set([
  'token', 'cookie', 'password', 'passwd', 'apikey', 'api_key', 'secret',
  'privatekey', 'private_key', 'accesstoken', 'refreshtoken', 'authorization',
  'set-cookie', 'sessiontoken', 'credentials', 'chat',
]);

function isSensitiveKey(k) {
  if (!k) return false;
  const lk = String(k).toLowerCase();
  if (SENSITIVE.has(lk)) return true;
  for (const s of SENSITIVE) if (lk.includes(s)) return true;
  return false;
}

function redact(obj) {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      out[k] = isSensitiveKey(k)
        ? (obj[k] == null ? obj[k] : '[redacted]')
        : redact(obj[k]);
    }
    return out;
  }
  return obj;
}

// 对自由文本做粗粒度掩码（如日志行）。
function redactString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, '$1[redacted]')
    .replace(/(token[=:]\s*)[A-Za-z0-9._\-]+/gi, '$1[redacted]')
    .replace(/(cookie[=:]\s*)[A-Za-z0-9._\-=]+/gi, '$1[redacted]');
}

module.exports = { redact, redactString, isSensitiveKey };
