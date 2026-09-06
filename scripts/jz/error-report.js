'use strict';
// 报错自动上报（复用 ai-content「error-reports/<date>/<id>.json」范式，v1.1.89 同类机制）。
// 500 级错误 fire-and-forget 采集 → 上传 OSS error-reports/，失败静默不影响主流程；带限流防错误风暴。
const crypto = require('node:crypto');
const os = require('node:os');
const { uploadObject } = require('./oss-client');
const { redactString } = require('./redact');

const ENABLED = process.env.ERROR_REPORT_ENABLED !== 'false';

function readOssEnv() {
  const id = process.env.OSS_ACCESS_KEY_ID;
  const secret = process.env.OSS_ACCESS_KEY_SECRET;
  if (!id || !secret) return null;
  return {
    accessKeyId: id,
    accessKeySecret: secret,
    bucket: process.env.OSS_BUCKET || 'kaypal',
    region: process.env.OSS_REGION || 'oss-cn-hangzhou',
  };
}

// 限流：同 requestId 只报一次；30s 窗口最多 5 条。
const seen = new Set();
let windowStart = Date.now();
let windowCount = 0;
function rateLimited(key) {
  if (!key) return true;
  const now = Date.now();
  if (now - windowStart > 30_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (seen.has(key)) return true;
  if (windowCount >= 5) return true;
  seen.add(key);
  windowCount += 1;
  if (seen.size > 200) seen.clear();
  return false;
}

function readVersion() {
  try {
    const pkg = require('../package.json');
    if (pkg.version) return pkg.version;
  } catch {
    /* ignore */
  }
  return process.env.JZ_VERSION || 'unknown';
}

function systemInfo() {
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1048576),
  };
}

function buildReport(input) {
  return {
    schema: 'error-report/v1',
    reportId: crypto.randomUUID(),
    app: 'jz-ai-guard',
    version: readVersion(),
    requestId: input.requestId,
    method: input.method,
    url: String(input.url || '').slice(0, 500),
    status: input.status,
    message: redactString(String(input.message || '').slice(0, 2000)),
    stack: redactString(String(input.stack || '').slice(0, 8000)),
    system: systemInfo(),
    occurredAt: new Date().toISOString(),
  };
}

// 上报错误（500 级）。返回 { ok, key } 供调用方/测试观察；网络失败静默返回 ok:false。
function reportError(input, deps = {}) {
  if (!ENABLED || (input && input.status < 500)) return { ok: false, skipped: true };
  if (rateLimited(input.requestId)) return { ok: false, skipped: true };
  const oss = deps.ossEnv || readOssEnv();
  if (!oss) return { ok: false, skipped: true };

  const report = buildReport(input);
  const ymd = new Date().toISOString().slice(0, 10);
  const key = `error-reports/${ymd}/${report.reportId}.json`;

  // 2026-08-30 复核 P2：改用 uploadObject（统一重试 + 大报告自动分片），
  // 旧实现直接 putObject 单次尝试，网络抖动时错误报告会静默丢失。
  const p = uploadObject({
    ...oss,
    key,
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: 'application/json',
    transport: deps.transport,
  });
  p.then(() => {}).catch(() => {});
  return { ok: true, key, promise: p };
}

module.exports = { reportError, buildReport, rateLimited, readOssEnv };
