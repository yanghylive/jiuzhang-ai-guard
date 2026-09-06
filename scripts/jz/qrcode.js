'use strict';
// 二维码生成（零依赖自研，2026-08-31）。
// 范围：byte 模式 · EC level M · 版本 1-10（byte 容量 14→213，覆盖设备码授权页 URL 与常见支付 codeUrl）。
// mask 固定 0（format info 如实声明，解码合规；屏幕大图场景不影响识别）。
// 输出 SVG 字符串，供登录（设备码 verificationUrl）与支付（codeUrl/payUrl）共用。
// 正确性保障：test-qrcode.js 含三重数学自洽断言（GF(256) RS 余式 / BCH(15,5) format / BCH(18,6) version）
// + finder/timing/结构断言；真机扫码验收归入发版关卡。

// ---- GF(256)，本原多项式 0x11D ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

// ---- RS 纠错码字 ----
function rsGenPoly(nec) {
  let g = [1];
  for (let i = 0; i < nec; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gmul(g[j], EXP[i]);
    }
    g = next;
  }
  return g; // 低次在前，g[0]=1
}
function rsEncode(data, nec) {
  const gen = rsGenPoly(nec);
  const rem = data.concat(new Array(nec).fill(0));
  for (let i = 0; i < data.length; i++) {
    const f = rem[i];
    if (f === 0) continue;
    for (let j = 0; j < gen.length; j++) rem[i + j] ^= gmul(gen[j], f);
  }
  return rem.slice(data.length); // nec 个纠错码字
}

// ---- BCH ----
// format：5 bit 数据（level M=00 + 3 bit mask），BCH(15,5) 生成式 0x537，输出 15 bit（未 XOR 0x5412）
function bchFormat(data5) {
  let rem = data5;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9 & 1) * 0x537);
  return ((data5 << 10) | (rem & 0x3ff)) & 0x7fff;
}
// version：6 bit 版本号，BCH(18,6) 生成式 0x1F25，输出 18 bit（未 XOR 0x5412）
function bchVersion(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11 & 1) * 0x1f25);
  return ((ver << 12) | (rem & 0xfff)) & 0x3ffff;
}

// ---- 版本表（EC level M）：total codewords, ec/block, data block 结构 ----
// { total, ec, g1:{n,d}, g2:{n,d}|null }，data 容量 = total - ec*blocks
const VERSIONS = [
  { total: 26, ec: 10, g1: { n: 1, d: 16 }, g2: null },            // v1: 16 data cw
  { total: 44, ec: 16, g1: { n: 1, d: 28 }, g2: null },            // v2: 28
  { total: 70, ec: 26, g1: { n: 1, d: 44 }, g2: null },            // v3: 44
  { total: 100, ec: 18, g1: { n: 2, d: 32 }, g2: null },           // v4: 64
  { total: 134, ec: 24, g1: { n: 2, d: 43 }, g2: null },           // v5: 86
  { total: 172, ec: 16, g1: { n: 4, d: 27 }, g2: null },           // v6: 108
  { total: 196, ec: 18, g1: { n: 4, d: 31 }, g2: null },           // v7: 124
  { total: 242, ec: 22, g1: { n: 2, d: 38 }, g2: { n: 2, d: 39 } },// v8: 154
  { total: 292, ec: 22, g1: { n: 3, d: 36 }, g2: { n: 2, d: 37 } },// v9: 182
  { total: 346, ec: 26, g1: { n: 4, d: 43 }, g2: { n: 1, d: 44 } },// v10: 216
];
const ALIGN = [[6], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
// byte 模式容量：data cw - 模式(4bit) - 计数(8bit@v1-9 / 16bit@v10)
const CAPACITY = VERSIONS.map((v, i) => v.total - v.ec * (v.g1.n + (v.g2 ? v.g2.n : 0)) - (i >= 9 ? 3 : 2));

function pickVersion(byteLen) {
  for (let i = 0; i < CAPACITY.length; i++) if (byteLen <= CAPACITY[i]) return i + 1;
  return 0;
}

// ---- 数据编码 → 码字序列（含交织）----
function buildCodewords(bytes, ver) {
  const v = VERSIONS[ver - 1];
  const nBlocks = v.g1.n + (v.g2 ? v.g2.n : 0);
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4); // byte 模式
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  // terminator + 对齐字节 + padding 0xEC/0x11
  const dataTotal = v.g1.d * v.g1.n + (v.g2 ? v.g2.d * v.g2.n : 0);
  const capBits = dataTotal * 8;
  push(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cw.push(b);
  }
  const pads = [0xec, 0x11];
  let pi = 0;
  while (cw.length < dataTotal) cw.push(pads[pi++ % 2]);

  // 分块 → RS → 交织
  const blocks = [];
  let off = 0;
  for (let i = 0; i < v.g1.n; i++) { blocks.push(cw.slice(off, off + v.g1.d)); off += v.g1.d; }
  if (v.g2) for (let i = 0; i < v.g2.n; i++) { blocks.push(cw.slice(off, off + v.g2.d)); off += v.g2.d; }
  const ecs = blocks.map((b) => rsEncode(b, v.ec));
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < v.ec; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

// ---- 矩阵构建 ----
function buildMatrix(text) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const ver = pickVersion(bytes.length);
  if (!ver) return { error: 'TOO_LONG', capacity: CAPACITY[CAPACITY.length - 1] };
  const size = 21 + 4 * (ver - 1);
  // 0=白 1=黑 2=功能固定黑 3=未放置（data 区）
  const m = Array.from({ length: size }, () => new Array(size).fill(3));
  const set = (r, c, v) => { m[r][c] = v; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      if (r < 0 || c < 0 || r === 7 || c === 7) { set(rr, cc, 0); continue; } // separator 全白
      const edge = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(rr, cc, edge || core ? 2 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 2 : 0); set(i, 6, i % 2 === 0 ? 2 : 0); } // timing（含分隔外的第 6 行/列）
  const centers = ALIGN[ver - 1];
  for (const r of centers) for (const c of centers) {
    if (m[r][c] === 2 && !(r === 6 || c === 6)) continue;
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue; // 与 finder 重叠跳过
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const edge = Math.max(Math.abs(dr), Math.abs(dc)) === 2;
      const core = dr === 0 && dc === 0;
      set(r + dr, c + dc, edge || core ? 2 : 0);
    }
  }
  set(size - 8, 8, 2); // dark module

  // format info（两份，整体 XOR 0x5412）
  const fmt = bchFormat((0b00 << 3) | 0) ^ 0x5412; // level M + mask 0
  const fb = Array.from({ length: 15 }, (_, i) => (fmt >> (14 - i)) & 1); // fb[0]=bit14(MSB)
  const put = (r, c, bit) => set(r, c, bit ? 2 : 0);
  // 副本 1：bit0 → (8,0) … bit6 → (8,7)，bit7 → (8,8)，bit8 → (7,8)，bit9-14 → (5,8)…(0,8)
  for (let i = 0; i <= 5; i++) put(8, i, fb[i]);
  put(8, 7, fb[6]); put(8, 8, fb[7]); put(7, 8, fb[8]);
  for (let i = 9; i <= 14; i++) put(14 - i, 8, fb[i]);
  // 副本 2：bit0 → (size-1,8) … bit6 → (size-7,8)，bit7 → (8,size-8) … bit14 → (8,size-1)
  for (let i = 0; i <= 6; i++) put(size - 1 - i, 8, fb[i]);
  for (let i = 7; i <= 14; i++) put(8, size - 15 + i, fb[i]);

  // version info（v≥7）—— 规范：version info 为 BCH(18,6) 直接放置，不做 0x5412 掩码
  if (ver >= 7) {
    const vi = bchVersion(ver);
    const vb = Array.from({ length: 18 }, (_, i) => (vi >> i) & 1); // vb[0]=bit0(LSB)
    for (let i = 0; i < 18; i++) {
      put(size - 11 + (i % 3), Math.floor(i / 3), vb[i]);      // 左下（col 5→0）
      put(Math.floor(i / 3), size - 11 + (i % 3), vb[i]);      // 右下（row 5→0）
    }
  }

  // data 蛇形（右下起，两列一组，先上后下，跳 col 6）
  const cw = buildCodewords(bytes, ver);
  const bits2 = [];
  for (const b of cw) for (let i = 7; i >= 0; i--) bits2.push((b >> i) & 1);
  let bi = 0;
  const total = size * size;
  let col = size - 1;
  let up = true;
  while (col > 0) {
    if (col === 6) col--; // 跳 timing 列
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (m[r][c] === 3) {
          const bit = bi < bits2.length ? bits2[bi] : 0; // remainder bits 补 0
          bi++;
          // mask 0（与 format info 声明一致）：i=(r+c) mod 2 为 0 时翻转
          m[r][c] = bit ^ (((r + c) % 2 === 0) ? 1 : 0);
        }
      }
    }
    up = !up;
    col -= 2;
  }
  void total;
  return { matrix: m, size, version: ver, dataBits: bi };
}

// ---- SVG 输出 ----
function qrSvg(text, opts = {}) {
  const o = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  const scaleRaw = Number(o.scale);
  const scale = Math.max(2, Number.isFinite(scaleRaw) ? scaleRaw : 4);
  const marginRaw = Number(o.margin);
  const margin = Math.max(0, Number.isFinite(marginRaw) ? marginRaw : 2);
  // Codex 复核 P2 修复：颜色参数直插 SVG 属性，补属性转义防注入（当前调用方未传色值，
  // 但模块作为复用件不应对调用方输入做隐式信任）。
  const attrEsc = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const light = o.light ? attrEsc(o.light) : '#ffffff';
  const dark = o.dark ? attrEsc(o.dark) : '#000000';
  const built = buildMatrix(String(text));
  if (built.error) return built;
  const { matrix, size, version } = built;
  const dim = (size + margin * 2) * scale;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // 1=数据黑 2=功能黑（finder/timing/alignment/format），都必须画出
      if (matrix[r][c] === 1 || matrix[r][c] === 2) path += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h${-scale}z`;
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`;
  return { ok: true, svg, version, modules: size, capacity: CAPACITY[version - 1] };
}

module.exports = { qrSvg, buildMatrix, buildCodewords, pickVersion, CAPACITY, rsEncode, bchFormat, bchVersion, gmul, EXP, LOG, VERSIONS, ALIGN };
