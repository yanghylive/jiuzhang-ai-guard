'use strict';
// qrcode.js 自研模块测试（2026-08-31）。
// 无外部解码器依赖，用三重数学自洽断言锁正确性：
//   1) RS：完整码字（data+ecc）经 GF(256) 合成除法后余式必须全 0；
//   2) BCH(15,5) format：码字（XOR 0x5412 前）mod 生成式 0x537 必须余 0；
//   3) BCH(18,6) version：同法 mod 0x1F25 余 0。
// 另加：黄金向量（byte 模式 "AB" @ v1-M 手算值）、结构断言、容量边界。
const test = require('node:test');
const assert = require('node:assert');
const q = require('../scripts/jz/qrcode');

// GF(2) 多项式取模（最高位在前），验证 BCH 码字是生成式的倍式
function gf2mod(polyBits, gen) {
  let rem = polyBits;
  const gl = 31 - Math.clz32(gen);
  while (31 - Math.clz32(rem) >= gl && rem !== 0) {
    rem ^= gen << (31 - Math.clz32(rem) - gl);
  }
  return rem;
}

test('RS 纠错：完整码字余式为 0（多版本多块抽查）', () => {
  for (const [ver, nData] of [[1, 16], [4, 64], [8, 154], [10, 216]]) {
    const data = Array.from({ length: nData }, (_, i) => (i * 37 + 11) & 0xff);
    const ec = q.rsEncode(data, q.VERSIONS[ver - 1].ec);
    assert.equal(ec.length, q.VERSIONS[ver - 1].ec);
    const full = data.concat(ec);
    const nec = q.VERSIONS[ver - 1].ec;
    const rem = full.concat(new Array(nec).fill(0));
    const gen = [];
    // 重建生成多项式（与实现同构，用于合成除法复核）
    let g = [1];
    for (let i = 0; i < nec; i++) {
      const nx = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { nx[j] ^= g[j]; nx[j + 1] ^= q.gmul(g[j], q.EXP[i]); }
      g = nx;
    }
    void gen;
    for (let i = 0; i < full.length; i++) {
      const f = rem[i];
      if (f === 0) continue;
      for (let j = 0; j < g.length; j++) rem[i + j] ^= q.gmul(g[j], f);
    }
    for (let i = full.length; i < rem.length; i++) assert.equal(rem[i], 0, `v${ver} RS 余式非 0 @${i}`);
  }
});

test('BCH format/version：码字为生成式倍式', () => {
  for (let mask = 0; mask < 8; mask++) {
    const cw = q.bchFormat((0b00 << 3) | mask); // M 级
    assert.equal(gf2mod(cw, 0x537), 0, `format M/mask${mask} mod 0x537 != 0`);
  }
  for (const ver of [7, 8, 9, 10]) {
    const cw = q.bchVersion(ver);
    assert.equal(gf2mod(cw, 0x1f25), 0, `version ${ver} mod 0x1f25 != 0`);
    assert.ok(cw > (ver << 12), '高位含版本号');
  }
});

test('黄金向量：byte 模式 "AB" @ v1-M 数据码字', () => {
  const cw = q.buildCodewords(Buffer.from('AB', 'utf8'), 1);
  assert.equal(cw.length, 26, 'v1-M 完整码字 = 16 data + 10 ecc');
  assert.deepEqual(cw.slice(0, 16), [0x40, 0x24, 0x14, 0x20, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
});

test('结构：finder/timing/dark module/尺寸', () => {
  const { matrix: m, size, version } = q.buildMatrix('https://kaypal.cn/zh-CN/desktop-auth/authorize?user_code=ABCD-1234');
  assert.equal(version, 5, '69 字符 → v5-M（容量 84）');
  assert.equal(size, 37);
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const v = m[r0 + r][c0 + c];
      if (v === 0 || v === 1) continue; // separator 白也算过
      const edge = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (edge || core) assert.equal(v, 2, `finder(${r0},${c0}) ${r},${c} 应黑`);
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.ok(m[6][i] !== 3, 'timing 行全部放置');
    assert.equal(m[6][i] === 2, i % 2 === 0, `timing 行 ${i} 交替`);
    assert.equal(m[i][6] === 2, i % 2 === 0, `timing 列 ${i} 交替`);
  }
  assert.equal(m[size - 8][8], 2, 'dark module 恒黑');
});

test('容量边界：213 字节通过（v10），214 拒绝 TOO_LONG', () => {
  assert.deepEqual(q.CAPACITY, [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
  const ok = q.qrSvg('x'.repeat(213));
  assert.equal(ok.ok, true);
  assert.equal(ok.version, 10);
  const bad = q.qrSvg('x'.repeat(214));
  assert.equal(bad.error, 'TOO_LONG');
  assert.equal(bad.capacity, 213);
});

test('SVG 输出：尺寸/margin/主题色', () => {
  const r = q.qrSvg('https://example.com', { scale: 4, margin: 2, dark: '#111111' });
  assert.equal(r.ok, true);
  assert.ok(r.svg.includes('width="116"'), '25 模块 + 4 margin = 29 × 4 = 116');
  assert.ok(r.svg.includes('fill="#111111"'));
  assert.ok(r.svg.startsWith('<svg xmlns'));
});

test('UTF-8 中文入码', () => {
  const r = q.qrSvg('九章AI管家·微信扫码登录');
  assert.equal(r.ok, true);
  assert.ok(r.version >= 2);
});

// ---- 2026-09-01 追加：真实解码验收 + NaN 回归（修 separator/mask/version-info 三 bug 后固化）----
// 依赖 jsQR（NODE_PATH 指向 workbuddy node workspace）；不可用时自动 skip。
let jsQR = null;
try { jsQR = require('jsqr'); } catch (_) {}

function matrixToRGBA(matrix, size, scale, margin) {
  const dim = (size + margin * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) {
    const r = Math.floor(y / scale) - margin, c = Math.floor(x / scale) - margin;
    const dark = (r >= 0 && c >= 0 && r < size && c < size) && (matrix[r][c] === 1 || matrix[r][c] === 2);
    const v = dark ? 0 : 255, i = (y * dim + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { data, dim };
}

test('真实解码验收：jsQR 闭环（支付 codeUrl/设备码 URL/长文本）', { skip: !jsQR && 'jsqr 未安装' }, () => {
  const payloads = [
    'weixin://wxpay/bizpayurl?pr=5QQN5hlB1FWSn1wn',
    'https://kaypal.cn/device/verify?code=E2E-TEST-12345678&x=1',
    'A'.repeat(200),
    'https://kaypal.cn/pay/confirm?order=UMTHPUEW65WM6HO&amount=1&ts=1725153600',
  ];
  for (const p of payloads) {
    const { matrix, size } = q.buildMatrix(p);
    const { data, dim } = matrixToRGBA(matrix, size, 8, 2);
    const res = jsQR(data, dim, dim);
    assert.ok(res, '解码失败: ' + String(p).slice(0, 40));
    assert.equal(res.data, p);
  }
});

test('separator 结构：finder 外圈白边必须全白（1:1:3:1:1 检测前提）', () => {
  const { matrix, size } = q.buildMatrix('https://example.com');
  const corners = [[0, 0], [0, size - 7], [size - 7, 0]];
  for (const [r0, c0] of corners) {
    for (let i = -1; i <= 7; i++) {
      const cells = [[r0 + 7, c0 + i], [r0 + i, c0 + 7]];
      for (const [r, c] of cells) {
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        if (r === r0 + 7 && c === c0 + 7) continue; // 外角允许越界跳过
        assert.ok(matrix[r][c] === 0 || matrix[r][c] === 3, 'separator(' + r + ',' + c + ') 非白: ' + matrix[r][c]);
      }
    }
  }
});

test('NaN 回归：opts 缺省/非法值不产 NaN', () => {
  const cases = [{}, { size: 480 }, 'x', undefined, { margin: 0 }, { scale: '8' }, null];
  for (const o of cases) {
    const r = q.qrSvg('weixin://wxpay/bizpayurl?pr=test', o);
    assert.ok(r.svg && !/NaN/.test(r.svg), 'opts 非法时产出 NaN 或空 svg: ' + JSON.stringify(o));
  }
});
