'use strict';
// 零依赖 OSS 客户端（node:crypto + node:https）。实现 V1 签名。
// 2026-08-29 复核 P1：新增 Multipart Upload（10MB 分片 × 并发 3 + 指数退避重试 + 请求超时），
// 供大文件（发版 DMG/exe、blockmap）与报错上报复用；小文件仍走单次 PUT。
// transport 可注入以便单测（不发真实网络请求）。
const crypto = require('node:crypto');
const https = require('node:https');

// 分片默认值：10MB × 并发 3（发版铁律 7），env 可调
const PART_SIZE = Number(process.env.JZ_OSS_PART_SIZE) || 10 * 1024 * 1024;
const PART_CONCURRENCY = Number(process.env.JZ_OSS_PART_CONCURRENCY) || 3;
const REQUEST_TIMEOUT_MS = Number(process.env.JZ_OSS_TIMEOUT_MS) || 60 * 1000;
const MAX_RETRIES = Number(process.env.JZ_OSS_MAX_RETRIES) || 2;

function rfc1123(d = new Date()) {
  return d.toUTCString();
}

// 阿里云 OSS V1 签名。无 Content-MD5、无自定义 OSS header 的简化场景。
// method 默认 PUT（兼容旧调用）；multipart 请求在 path 后带 query：
//   initiate  → ?uploads（无值 subResource，签名与 URL 都不带 '='）
//   uploadPart → ?partNumber=N&uploadId=...（有值参数，签名 resource 用 URL 编码后的值）
//   complete  → ?uploadId=...
// OSS 签名要求 stringToSign 的 CanonicalizedResource 包含 query（按字典序、值 URL 编码）。
function ossV1Authorization({ accessKeyId, accessKeySecret, bucket, key, contentType, date, method = 'PUT', subResource, query }) {
  const keyPath = `/${bucket}/${key}`;
  let resource = keyPath;
  if (subResource) {
    // 无值 subResource（如 uploads）：?uploads（不带 '='）
    resource += `?${subResource}`;
  } else if (query && Object.keys(query).length) {
    // 有值参数（partNumber/uploadId 等），按字典序、值 URL 编码
    const q = Object.keys(query)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(query[k])}`)
      .join('&');
    resource += `?${q}`;
  }
  const stringToSign = `${method}\n\n${contentType}\n${date}\n${resource}`;
  const signature = crypto.createHmac('sha1', accessKeySecret).update(stringToSign).digest('base64');
  return `OSS ${accessKeyId}:${signature}`;
}

function requestOnce({ method, host, path: reqPath, headers, body, timeoutMs = REQUEST_TIMEOUT_MS, transport }) {
  const reqImpl = transport || https;
  return new Promise((resolve, reject) => {
    const req = reqImpl.request(
      { host, path: reqPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers || {} }));
      },
    );
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`OSS request timeout after ${timeoutMs}ms`)));
    }
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 指数退避重试：status 5xx / 网络错误 / 超时 → 重试（最多 MAX_RETRIES 次，退避 500ms×2^n）
async function withRetry(fn, label) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
    try {
      const res = await fn();
      if (res && res.status >= 200 && res.status < 300) return res;
      lastErr = new Error(`${label} failed: ${res && res.status} ${String(res && res.body || '').slice(0, 200)}`);
      if (res && res.status >= 400 && res.status < 500) break; // 4xx 不重试（签名/参数错误，重试无意义）
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

// 单次 PUT 的重试包装：fn 失败即抛（错误里含 "failed: <status>"），
// 4xx 直接放弃（签名/参数错误重试无意义），其余按指数退避重试。
async function withRetryOnce(fn, label) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const m = /failed:\s*(\d{3})/.exec(String((e && e.message) || ''));
      if (m && Number(m[1]) >= 400 && Number(m[1]) < 500) break; // 4xx 不重试
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

// 上传对象（单次 PUT，小文件）。body 为 Buffer。返回 Promise<{ok,status}>。
function putObject({
  accessKeyId,
  accessKeySecret,
  bucket,
  region,
  key,
  body,
  contentType = 'application/octet-stream',
  transport,
} = {}) {
  const reqImpl = transport || https;
  const once = () => new Promise((resolve, reject) => {
    const date = rfc1123();
    const host = `${bucket}.${region}.aliyuncs.com`;
    const auth = ossV1Authorization({ accessKeyId, accessKeySecret, bucket, key, contentType, date });
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');

    const req = reqImpl.request(
      {
        host,
        // OSS 要求 URL 逐段编码（中文文件名等），而 V1 签名的 stringToSign 用原始 key。
        // 只编码 path，签名不变——否则中文 key 会 400 "Request path contains unescaped characters"。
        path: `/${key.split('/').map(encodeURIComponent).join('/')}`,
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          Date: date,
          Authorization: auth,
          'Content-Length': buf.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode });
          } else {
            reject(new Error(`OSS PUT ${key} failed: ${res.statusCode} ${String(data).slice(0, 200)}`));
          }
        });
      },
    );
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('OSS PUT timeout')));
    }
    req.on('error', reject);
    req.end(buf);
  });
  // 2026-08-30 复核 P2：小文件单次 PUT 也应具备网络弹性（5xx/网络错误/超时重试；
  // 4xx 属签名/参数错误，重试无意义）。与 multipart 共用同一退避策略。
  return withRetryOnce(once, `OSS PUT ${key}`);
}

// 阿里云 OSS Multipart Upload（V1 签名）：
//   initiate: POST /<key>?uploads
//   uploadPart: PUT /<key>?partNumber=N&uploadId=<id>  （并发 PART_CONCURRENCY）
//   complete: POST /<key>?uploadId=<id>（XML body 列出 partNumber/ETag）
// 大文件专用（≥2 分片时自动走 multipart；小文件单次 PUT 即可）。
async function putObjectMultipart({
  accessKeyId,
  accessKeySecret,
  bucket,
  region,
  key,
  body,
  contentType = 'application/octet-stream',
  transport,
  onProgress,
} = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  const host = `${bucket}.${region}.aliyuncs.com`;
  const encKey = key.split('/').map(encodeURIComponent).join('/');
  // 每个请求必须复用同一个 date：Date header 与签名串用同一时刻，跨秒即 SignatureDoesNotMatch。
  // contentType 也必须与请求头一致参与签名（POST initiate 同样带 Content-Type，不能置空）。
  const authOf = (method, opts, d, ct) => ossV1Authorization(Object.assign(
    { accessKeyId, accessKeySecret, bucket, key, contentType: ct, date: d, method },
    opts,
  ));
  const reqImpl = transport || https;

  // 1. initiate（无值 subResource：?uploads）
  const initRes = await withRetry(async () => {
    const d = rfc1123();
    return requestOnce({
      method: 'POST',
      host,
      path: `/${encKey}?uploads`,
      headers: { 'Content-Type': contentType, Date: d, Authorization: authOf('POST', { subResource: 'uploads' }, d, contentType) },
      transport: reqImpl,
    });
  }, `OSS initiate ${key}`);
  const initXml = String(initRes.body || '');
  const uploadIdMatch = initXml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!uploadIdMatch) throw new Error(`OSS initiate ${key} failed: no UploadId in response`);
  const uploadId = uploadIdMatch[1];

  // 2. 分片
  const totalParts = Math.max(1, Math.ceil(buf.length / PART_SIZE));
  const results = new Array(totalParts);
  const worker = async (start, index) => {
    const end = Math.min(buf.length, start + PART_SIZE);
    const partBuf = buf.subarray(start, end);
    const partNumber = index + 1;
    const query = { partNumber: String(partNumber), uploadId };
    const qs = `partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
    const res = await withRetry(async () => {
      const d = rfc1123();
      return requestOnce({
        method: 'PUT',
        host,
        path: `/${encKey}?${qs}`,
        headers: {
          'Content-Type': contentType,
          Date: d,
          Authorization: authOf('PUT', { query }, d, contentType),
          'Content-Length': partBuf.length,
        },
        body: partBuf,
        transport: reqImpl,
      });
    }, `OSS part ${partNumber}/${totalParts} ${key}`);
    const etag = (res.headers && res.headers.etag) || '';
    results[index] = { partNumber, etag: etag.replace(/^"|"$/g, '') };
    if (onProgress) onProgress({ part: partNumber, total: totalParts, uploadedBytes: end });
  };
  // 并发池：PART_CONCURRENCY 个 worker 顺序取分片
  let cursor = 0;
  const concurrency = Math.min(PART_CONCURRENCY, totalParts);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < totalParts) {
        const idx = cursor;
        cursor += 1;
        await worker(idx * PART_SIZE, idx);
      }
    }),
  );
  // 3. complete
  const completeParts = [];
  for (const r of results) if (r) completeParts.push(r);
  completeParts.sort((a, b) => a.partNumber - b.partNumber);
  const completeXml =
    '<CompleteMultipartUpload>' +
    completeParts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`).join('') +
    '</CompleteMultipartUpload>';
  const completeRes = await withRetry(async () => {
    const d = rfc1123();
    const ct = 'application/xml';
    return requestOnce({
      method: 'POST',
      host,
      path: `/${encKey}?uploadId=${encodeURIComponent(uploadId)}`,
      headers: {
        'Content-Type': ct,
        Date: d,
        Authorization: authOf('POST', { query: { uploadId } }, d, ct),
        'Content-Length': Buffer.byteLength(completeXml),
      },
      body: completeXml,
      transport: reqImpl,
    });
  }, `OSS complete ${key}`);
  if (completeRes.status >= 200 && completeRes.status < 300) {
    return { ok: true, status: completeRes.status, uploadId, parts: completeParts.length };
  }
  throw new Error(`OSS complete ${key} failed: ${completeRes.status} ${String(completeRes.body || '').slice(0, 200)}`);
}

// 统一上传入口：≥2 分片走 multipart（并发+重试+超时），小文件单次 PUT。
async function uploadObject(opts) {
  const buf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body || ''), 'utf8');
  if (buf.length > PART_SIZE) return putObjectMultipart(opts);
  return putObject(opts);
}

module.exports = { putObject, putObjectMultipart, uploadObject, ossV1Authorization, rfc1123, PART_SIZE, PART_CONCURRENCY, REQUEST_TIMEOUT_MS, MAX_RETRIES };
