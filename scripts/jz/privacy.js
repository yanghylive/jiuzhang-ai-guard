'use strict';
// 隐私盾（05 §4.1 privacy.scanOnExplicitSend，07 features.privacyShield）：
// 「发送前扫描敏感信息」——扫描文本中的凭据类敏感内容，命中即提示用户，防误发。
// 纯本地正则扫描，不联网、不落盘原文；结果只返回「类型 + 本地脱敏摘要」。

// 敏感模式：凭据/联系方式类（发送场景最危险的）
const PATTERNS = [
  { type: 'token', re: /(?:sk|pk|kda|kdr|kaypalcred|ghp|github_pat)[-_][A-Za-z0-9]{12,}/i, hint: 'API Token / 密钥' },
  { type: 'password', re: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/i, hint: '密码明文' },
  { type: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, hint: '私钥' },
  { type: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, hint: 'JWT' },
  { type: 'phone', re: /1[3-9]\d{9}/, hint: '手机号' },
  { type: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, hint: '邮箱' },
  { type: 'idcard', re: /\b\d{17}[\dXx]\b/, hint: '身份证号' },
  { type: 'bankcard', re: /\b\d{16,19}\b/, hint: '银行卡号' },
];

// 扫描文本，返回命中的敏感项（本地脱敏摘要，不返回原文）。ok=true 表示扫描完成（无论命中与否）。
// 脱敏规则（2026-08-29 第五轮复查 P1）：保留前 4 后 2 字符 + 类型化掩码，中间全部打码；
// 绝不把原文透传（redact 只处理已知敏感字段，v 这类泛型 key 会被原样返回——不能用它）。
function maskMatch(s) {
  const str = String(s);
  if (str.length <= 6) return '***';
  return `${str.slice(0, 4)}****${str.slice(-2)}（长度 ${str.length}）`;
}

function scan(text) {
  const input = String(text || '');
  if (!input) return { ok: true, sensitive: [] };
  const sensitive = [];
  const seen = new Set();
  for (const p of PATTERNS) {
    const m = p.re.exec(input);
    if (m) {
      const masked = maskMatch(m[0]);
      if (seen.has(masked)) continue; // 同一命中被多个模式捕获时去重
      seen.add(masked);
      sensitive.push({ type: p.type, hint: p.hint, match: masked });
    }
  }
  return { ok: true, sensitive, blocked: sensitive.length > 0 };
}

module.exports = { scan, PATTERNS };
