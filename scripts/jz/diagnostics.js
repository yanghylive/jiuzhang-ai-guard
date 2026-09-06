'use strict';
// 诊断包（04 §7 / 08 安全测试）：上传前生成脱敏字段清单与预览，禁止含 token/Cookie/聊天正文。
//
// 2026-08-29 第四轮复查 P1：预览→确认→上传闭环落地 ——
//   preview() 生成 previewId 并把快照持久化到 diagnostics/preview-<id>.json（10 分钟 TTL）；
//   upload() 必须持未过期、未使用的 previewId，上传内容 = 预览时锁定的快照（不再重新生成），
//   成功/失败后消费该 previewId（单次使用）。
const fs = require('node:fs');
const path = require('node:path');
const { dataRoot, uuid, readJSON, atomicWriteJSON } = require('./lib');
const { redact } = require('./redact');

const PREVIEW_TTL_MS = Number(process.env.JZ_DIAGNOSTICS_PREVIEW_TTL_MS) || 10 * 60 * 1000;

// previewId 安全校验（2026-08-29 复核 P1）：previewId 直接拼文件路径，
// 只接受 uuid 格式（内部由 uuid() 生成），杜绝路径穿越读取任意文件。
const PREVIEW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertSafePreviewId(id) {
  const s = String(id || '');
  if (!s || !PREVIEW_ID_RE.test(s)) return null;
  return s;
}

function previewDir(root) {
  return path.join(root || dataRoot(), 'diagnostics', 'previews');
}

// 惰性清理过期预览快照
function sweepPreviews(root, now = Date.now()) {
  const dir = previewDir(root);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const f of names) {
    try {
      const p = path.join(dir, f);
      const rec = readJSON(p);
      if (!rec || new Date(rec.expiresAt).getTime() < now) fs.rmSync(p, { force: true });
    } catch {}
  }
}

function buildPayload({ root } = {}) {
  const opsDir = path.join(root, 'runtime', 'operations');
  let ops = [];
  try {
    ops = fs
      .readdirSync(opsDir)
      .map((f) => readJSON(path.join(opsDir, f)))
      .filter(Boolean);
  } catch {
    /* no ops yet */
  }
  const raw = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    operationCount: ops.length,
    recentOperations: ops.slice(-10).map((o) => ({ type: o.type, status: o.status, errorCode: o.errorCode })),
    fields: ['operationType', 'status', 'errorCode', 'timestamp'],
    containsSensitive: false,
  };
  return redact(raw);
}

// 预览：生成 previewId + 快照持久化（upload 按此快照上传，不再重新生成）
function preview({ root } = {}) {
  root = root || dataRoot();
  sweepPreviews(root);
  const previewId = uuid();
  const snapshot = buildPayload({ root });
  const rec = {
    previewId,
    snapshot,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    used: false,
  };
  try {
    atomicWriteJSON(path.join(previewDir(root), `${previewId}.json`), rec);
  } catch {
    /* 快照落盘失败不阻断预览展示，但上传时将因快照缺失被拒绝（fail-closed） */
  }
  return { ok: true, preview: snapshot, previewId, expiresAt: rec.expiresAt };
}

// 真实上传：必须持有效 previewId（未过期、未使用）；上传内容 = 预览快照。
// 配置 env 端点才发送；未配置 → fail-closed（明确 NOT_CONFIGURED，绝不假成功）。
// 状态机：本地生成(preview) → 已上传(uploaded) / 服务端拒绝(rejected) / 离线待发(pending)。
async function upload({ previewId, root } = {}) {
  root = root || dataRoot();
  // 预览绑定：快照必须存在、未过期、未使用（单次消费）—— 校验优先于 endpoint 检查，
  // 保证非法 previewId 一律 PREVIEW_NOT_FOUND（不因未配置端点而提前返回）
  const pid = assertSafePreviewId(previewId);
  if (!pid) {
    return { ok: false, error: 'PREVIEW_NOT_FOUND', detail: '预览不存在或已失效，请重新生成预览', status: 'rejected' };
  }
  const endpoint = process.env.JZ_DIAGNOSTICS_ENDPOINT;
  const apiKey = process.env.JZ_DIAGNOSTICS_API_KEY;
  if (!endpoint) {
    return { ok: false, error: 'DIAGNOSTICS_UPLOAD_NOT_CONFIGURED', detail: '未配置 JZ_DIAGNOSTICS_ENDPOINT，诊断包仅本地生成，未上传' };
  }
  const rec = readJSON(path.join(previewDir(root), `${pid}.json`));
  if (!rec || rec.previewId !== pid) {
    return { ok: false, error: 'PREVIEW_NOT_FOUND', detail: '预览不存在或已失效，请重新生成预览', status: 'rejected' };
  }
  if (rec.used) {
    return { ok: false, error: 'PREVIEW_ALREADY_USED', detail: '该预览已上传过，请重新生成预览', status: 'rejected' };
  }
  if (new Date(rec.expiresAt).getTime() < Date.now()) {
    try { fs.rmSync(path.join(previewDir(root), `${pid}.json`), { force: true }); } catch {}
    return { ok: false, error: 'PREVIEW_EXPIRED', detail: '预览已过期（10 分钟），请重新生成预览', status: 'rejected' };
  }
  // 上传内容 = 预览时锁定的快照（不重新生成，保证"所见即所传"）
  const payload = {
    previewId: pid,
    schemaVersion: 1,
    ...rec.snapshot,
  };
  // 复查 P2（第五轮）：并发保护 —— 请求发出前先同步标记 used（快照写盘），
  // 两个并发请求只有一个能通过 used 检查；网络失败（结果不确定）回滚 used 供重试。
  try {
    rec.used = true;
    atomicWriteJSON(path.join(previewDir(root), `${pid}.json`), rec);
  } catch (e) {
    return { ok: false, error: 'PREVIEW_PERSIST_FAILED', detail: `预览状态写盘失败：${e.message}`, status: 'rejected' };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(redact(payload)),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status >= 200 && res.status < 300) {
      const body = await res.json().catch(() => ({}));
      return { ok: true, ticketId: body.ticketId || body.id || uuid(), status: 'uploaded' };
    }
    return { ok: false, error: 'DIAGNOSTICS_UPLOAD_REJECTED', detail: `服务端拒绝 ${res.status}`, status: 'rejected' };
  } catch (e) {
    // 网络失败：结果不确定 → 回滚 used，保留预览供短时间重试（与确定性拒绝不同）
    try {
      rec.used = false;
      atomicWriteJSON(path.join(previewDir(root), `${pid}.json`), rec);
    } catch {}
    return { ok: false, error: 'DIAGNOSTICS_UPLOAD_PENDING', detail: String((e && e.message) || e), status: 'pending' };
  }
}

module.exports = { preview, upload };
