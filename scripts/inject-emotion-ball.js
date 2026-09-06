/* ============================================================
 * inject-emotion-ball.js —— FAB 悬浮球 EmotionBall SDK（Mood Mates 全量引擎）
 * 2026-09-05 产品负责人定版：双引擎同台（照 8765 总馆 index.html 官方加载顺序）——
 *   球球(blob) → EmotionBall v1 引擎（彩带体系：切表情 ribbons/confetti 一次性爆发 + 点击自旋/撒花）
 *   云宝(nimbo)/亮亮(twinkle) → MoodMates 引擎（吹云泡/星星爆闪）
 * 拼包来源与顺序（与总馆 index.html 完全一致）：
 *   [MM] mood-mates/src/core/geometry.js → render.js → features.js → fx.js
 *        → data/emotions.js → core/engine.js → characters/nimbo.js → characters/twinkle.js
 *   [EB] emotion-ball/js/rings.js → emotions.js → ball.js → engine.js
 *   注意：两套 emotions.js 都写 window.EMOTION_SEED，靠加载顺序天然隔离——
 *   MM engine 读走 MM 版 seed 后，EB emotions.js 覆盖 seed，EB engine 再读走 EB 版。
 * 管家定制：MM 引擎 fx 粒子层整体放大 2.2x（render.js fxBack/fxFront，球心锚等比缩放）——
 *   原版粒子按 240px 角色设计，50px 挂件下不可见；形态/轨迹未改动。EB 引擎彩带原生适配 50px，未动。
 * 尾部兼容层：window.EmotionBall.create 按总馆 createInst 模式路由双引擎（inject.js 调用契约不变）。
 * 由 daemon.js 注入时拼接在 inject.js 之前执行。
 * 状态映射（C 档 AI 联动）：见 inject.js FAB_EMOTION
 * ============================================================ */
/* ============================================================
 * geometry.js —— 参数化轮廓生成库（Mood Mates 原创几何基座）
 *
 * 所有身体剪影与眼形轮廓均由本文件的参数化函数实时生成，
 * 仓库中不存在任何手绘 / 描摹的坐标数据。生成参数即设计语言，
 * 记录于 docs/DESIGN-PROVENANCE.md 作为原创证据。
 *
 * 坐标系：viewBox 0 0 240 240，头部中心 C = 120，基准半径 104
 *
 * 两类轮廓：
 *   身体环 BODY：96 点闭合折线，由径向函数 r(θ) 或参数曲线生成
 *   眼环   EYE ：48 点闭合折线，统一 lens（双缘包络）拓扑 ——
 *               中轴线 mid(u) + 厚度包络 halfThick(u) 上下缘各 24 点，
 *               所有眼形槽位共享同一拓扑，逐点插值形变天然连贯
 * ============================================================ */
(function () {
  'use strict';

  var MM = (window.MoodMates = window.MoodMates || {});
  var TAU = Math.PI * 2;

  var C = 120;          /* 头部中心 */
  var R = 104;          /* 身体基准半径 */
  var BODY_N = 96;      /* 身体环点数 */
  var EYE_N = 48;       /* 眼环点数（上下缘各 24） */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function r2(v) { return Math.round(v * 100) / 100; }

  /* ---------------- 身体环：径向函数采样 ----------------
   * radialFn(theta) 返回该方向上的半径（θ = 0 朝右，顺时针，屏幕坐标系）*/
  function sampleRadial(radialFn, opts) {
    opts = opts || {};
    var cx = opts.cx != null ? opts.cx : C;
    var cy = opts.cy != null ? opts.cy : C;
    var rot = opts.rot || 0;
    var ring = [];
    for (var i = 0; i < BODY_N; i++) {
      var th = TAU * i / BODY_N - Math.PI / 2 + rot;   /* 从正上方起步 */
      var r = radialFn(th);
      ring.push([r2(cx + r * Math.cos(th)), r2(cy + r * Math.sin(th))]);
    }
    return ring;
  }

  /* 平滑周期凸起：在 center 角附近宽 width 的钟形隆起（0~1） */
  function bump(th, center, width) {
    var d = Math.atan2(Math.sin(th - center), Math.cos(th - center));
    var x = clamp(1 - Math.abs(d) / width, 0, 1);
    return x * x * (3 - 2 * x);
  }

  var BODY_GEN = {
    /** 云朵：波浪扇贝边（lobes 花瓣数，amp 波幅） */
    cloud: function (p) {
      p = p || {};
      var base = (p.r || 0.98) * R;
      var lobes = p.lobes || 7;
      var amp = p.amp != null ? p.amp : 0.075;
      var flat = p.flat != null ? p.flat : 0.10;
      return sampleRadial(function (th) {
        var scallop = Math.pow(Math.abs(Math.sin(lobes * th / 2)), 1.4);
        /* 底部收平一点，像坐在地上的云 */
        var seat = 1 - flat * Math.pow(Math.max(0, Math.sin(th)), 3);
        return base * seat * (1 + amp * scallop);
      }, p);
    },

    /** 圆角星：points 角数，sharp 尖锐度（0 圆 ~ 1 尖），inner 内径比 */
    star: function (p) {
      p = p || {};
      var outer = (p.r || 1.04) * R;
      var inner = outer * (p.inner != null ? p.inner : 0.72);
      var pts = p.points || 5;
      var k = 1 + 3 * (p.sharp != null ? p.sharp : 0.55);
      return sampleRadial(function (th) {
        var w = Math.pow(0.5 + 0.5 * Math.cos(pts * (th + Math.PI / 2)), k);
        return inner + (outer - inner) * w;
      }, p);
    },

    /** 通用鼓包圆（备用 / 二次开发起点）：谐波扰动圆 */
    puff: function (p) {
      p = p || {};
      var base = (p.r || 1) * R;
      var waves = p.waves || [];
      return sampleRadial(function (th) {
        var v = 1;
        for (var i = 0; i < waves.length; i++) {
          var w = waves[i];
          v += (w.amp || 0) * Math.sin((w.k || 2) * th + (w.phase || 0));
        }
        return base * v;
      }, p);
    }
  };

  /** 生成身体环：desc = { type, ...params } */
  function buildBody(desc) {
    var gen = BODY_GEN[desc.type];
    if (!gen) throw new Error('[MoodMates] 未知身体生成器：' + desc.type);
    return gen(desc);
  }

  /* ---------------- 眼环：lens 双缘包络拓扑 ----------------
   * 参数（均为相对眼睛盒子的比例）：
   *   w, h      眼宽 / 眼高（绝对 px）
   *   bend      中轴弯曲：>0 上拱（笑眼 ∩），<0 下垂
   *   slope     中轴斜率：>0 外高内低（配合 mirror 表达怒 / 哀）
   *   taper     厚度端部收尖指数（0.3 圆角矩形感 ~ 2.5 两端极尖）
   *   shift     厚度重心偏移：>0 下缘更鼓，<0 上缘更鼓
   *   tilt      整体旋转（度）
   * mirror = -1 时水平镜像（右眼），slope / tilt 自动反向 */
  function lens(cx, cy, o, mirror) {
    mirror = mirror || 1;
    var w = o.w, h = o.h;
    var bend = (o.bend || 0) * h;
    var slope = (o.slope || 0) * h * mirror;
    var taper = o.taper != null ? o.taper : 0.55;
    var shift = o.shift || 0;
    var tiltRad = (o.tilt || 0) * Math.PI / 180 * mirror;

    /* 闭合曲线参数化采样：φ 绕行一周，u = (1-cosφ)/2 令采样点自然向两端加密；
     * 上下缘在端点汇合为「单点」——过点样条不经过重复点、不会折出尖角，
     * 端部密采样 + 无重复点 → 端帽圆润，与解析胶囊同级的干净边缘 */
    var ring = [];
    var cs = Math.cos(tiltRad), sn = Math.sin(tiltRad);
    for (var k = 0; k < EYE_N; k++) {
      var phi = TAU * k / EYE_N;
      var u = (1 - Math.cos(phi)) / 2;           /* 0 左端 → 1 右端 → 折回 */
      var x = (u - 0.5) * w * mirror;
      var arch = Math.sin(Math.PI * u);          /* 端点 0，中间 1 */
      var mid = -bend * arch + slope * (u - 0.5);
      var th = (h / 2) * Math.pow(arch, taper);
      /* φ ∈ (0,π) 走上缘，(π,2π) 走下缘 */
      var y = Math.sin(phi) >= 0 ? mid - th * (1 - shift) : mid + th * (1 + shift);
      ring.push([r2(cx + x * cs - y * sn), r2(cy + x * sn + y * cs)]);
    }
    return ring;
  }

  /* ---------------- 眼形语义槽位 ----------------
   * 每个槽位是 style（角色眼型基调）→ lens 参数的映射。
   * style: { w, h, taper, tilt, bend } 角色级默认值 */
  var EYE_SLOTS = {
    /* 平静注视 */
    calm:    function (s) { return { w: s.w, h: s.h, bend: s.bend, taper: s.taper, tilt: s.tilt }; },
    calm2:   function (s) { return { w: s.w * 0.96, h: s.h * 1.05, bend: s.bend + 0.04, taper: s.taper, tilt: s.tilt }; },
    /* 笑眼（∩ 拱） */
    happy:   function (s) { return { w: s.w * 1.05, h: s.h * 0.5, bend: 0.62, taper: 1.15, tilt: s.tilt }; },
    happy2:  function (s) { return { w: s.w * 1.1, h: s.h * 0.42, bend: 0.5, taper: 0.9, tilt: s.tilt + 2 }; },
    /* 圆睁 */
    wide:    function (s) { return { w: s.w * 1.12, h: s.h * 1.3, bend: 0, taper: Math.max(s.taper * 0.8, 0.3), tilt: 0 }; },
    wide2:   function (s) { return { w: s.w * 1.05, h: s.h * 1.42, bend: 0.05, taper: Math.max(s.taper * 0.7, 0.3), tilt: 0 }; },
    /* 闭合 / 困倦 */
    closed:  function (s) { return { w: s.w * 0.95, h: s.h * 0.12, bend: -0.25, taper: 0.9, tilt: s.tilt }; },
    closed2: function (s) { return { w: s.w * 0.9, h: s.h * 0.1, bend: 0.2, taper: 0.9, tilt: s.tilt }; },
    sleepy:  function (s) { return { w: s.w, h: s.h * 0.34, bend: -0.3, taper: 0.7, shift: 0.35, tilt: s.tilt }; },
    /* 斜眼 / 无奈 */
    squint:  function (s) { return { w: s.w * 1.02, h: s.h * 0.5, bend: 0.05, slope: 0.35, taper: 0.7, tilt: s.tilt }; },
    squint2: function (s) { return { w: s.w * 0.96, h: s.h * 0.44, bend: -0.1, slope: 0.3, taper: 0.8, tilt: s.tilt + 3 }; },
    /* 怒目：内低外高 + 上缘压平 */
    angry:   function (s) { return { w: s.w * 1.02, h: s.h * 0.72, bend: 0.1, slope: -0.5, taper: 0.6, shift: 0.3, tilt: s.tilt }; },
    angry2:  function (s) { return { w: s.w * 0.98, h: s.h * 0.62, bend: 0.05, slope: -0.62, taper: 0.65, shift: 0.35, tilt: s.tilt }; },
    /* 扫读：宽扁横条 */
    scan:    function (s) { return { w: s.w * 1.3, h: s.h * 0.46, bend: 0, taper: 0.45, tilt: 0 }; },
    scan2:   function (s) { return { w: s.w * 1.18, h: s.h * 0.56, bend: 0.08, taper: 0.5, tilt: 0 }; },
    scan3:   function (s) { return { w: s.w * 1.36, h: s.h * 0.38, bend: -0.06, taper: 0.42, tilt: 0 }; },
    /* 聆听：窄高竖圆 */
    listen:  function (s) { return { w: s.w * 0.78, h: s.h * 1.18, bend: 0, taper: Math.max(s.taper * 0.85, 0.35), tilt: 0 }; },
    listen2: function (s) { return { w: s.w * 0.72, h: s.h * 1.08, bend: 0.08, taper: Math.max(s.taper * 0.85, 0.35), tilt: s.tilt }; },
    /* 羞怯：下垂微闭，外角向下 */
    shy:     function (s) { return { w: s.w * 0.92, h: s.h * 0.6, bend: -0.18, slope: 0.22, taper: 0.85, tilt: s.tilt + 4 }; },
    /* 哀伤：外低内高 */
    sad:     function (s) { return { w: s.w * 0.95, h: s.h * 0.62, bend: -0.1, slope: 0.45, taper: 0.75, tilt: s.tilt }; }
  };

  /** 生成一对眼环（含左右镜像）
   *  style: { dx, cy, w, h, taper, tilt, bend } —— dx 为眼心到面部中线的距离 */
  function buildEyePair(slotName, style) {
    var slotFn = EYE_SLOTS[slotName];
    if (!slotFn) throw new Error('[MoodMates] 未知眼形槽位：' + slotName);
    var o = slotFn(style);
    var L = lens(C - style.dx, style.cy, o, 1);
    var Rr = lens(C + style.dx, style.cy, o, -1);
    return [L, Rr];
  }

  /** 生成一套完整眼环族：slotName → [左, 右] */
  function buildEyeFamily(style) {
    var fam = {};
    for (var name in EYE_SLOTS) fam[name] = buildEyePair(name, style);
    return fam;
  }

  /* ---------------- 嘴巴：同 lens 拓扑（24 点小环） ----------------
   * 槽位含闭合线形嘴与张开圆嘴，共享拓扑可自由形变 */
  var MOUTH_N = 24;

  function mouthLens(o) {
    var w = o.w, h = o.h;
    var bend = (o.bend || 0) * Math.max(h, 4);
    var taper = o.taper != null ? o.taper : 0.8;
    /* 与 lens 同款闭合参数化：端点单点汇合 + 端部密采样，嘴角圆润 */
    var ring = [];
    for (var k = 0; k < MOUTH_N; k++) {
      var phi = TAU * k / MOUTH_N;
      var u = (1 - Math.cos(phi)) / 2;
      var x = (u - 0.5) * w;
      var arch = Math.sin(Math.PI * u);
      var mid = -bend * arch;
      var th = (h / 2) * Math.pow(arch, taper);
      var y = Math.sin(phi) >= 0 ? mid - th : mid + th;
      ring.push([r2(x), r2(y)]);
    }
    return ring;
  }

  /* base: { w } —— 角色嘴宽基准；槽位内高度 / 弯曲写死为语义 */
  var MOUTH_SLOTS = {
    smile:  function (b) { return mouthLens({ w: b.w, h: 3.2, bend: -0.9, taper: 0.9 }); },
    grin:   function (b) { return mouthLens({ w: b.w * 1.25, h: 11, bend: -0.55, taper: 0.6 }); },
    o:      function (b) { return mouthLens({ w: b.w * 0.5, h: b.w * 0.52, bend: 0, taper: 0.4 }); },
    flat:   function (b) { return mouthLens({ w: b.w * 0.8, h: 2.6, bend: 0, taper: 0.9 }); },
    frown:  function (b) { return mouthLens({ w: b.w * 0.85, h: 3, bend: 0.85, taper: 0.9 }); },
    wavy:   function (b) { return mouthLens({ w: b.w, h: 3, bend: -0.15, taper: 0.5 }); },
    pout:   function (b) { return mouthLens({ w: b.w * 0.42, h: 3.4, bend: 0.5, taper: 0.5 }); },
    open:   function (b) { return mouthLens({ w: b.w * 0.72, h: b.w * 0.5, bend: -0.25, taper: 0.45 }); },
    dot:    function (b) { return mouthLens({ w: b.w * 0.2, h: b.w * 0.18, bend: 0, taper: 0.4 }); }
  };

  function buildMouth(slotName, base) {
    var fn = MOUTH_SLOTS[slotName] || MOUTH_SLOTS.flat;
    return fn(base);
  }

  /* ---------------- 自定义轮廓（每表情专属轮廓组入口） ----------------
   * 角色可在 eyeShapes / mouthShapes 里用原始 lens 参数定义专属轮廓，
   * 表情覆盖的 pool / mouth 即可引用这些自定义名字 */

  /** 自定义眼形对：o 为原始 lens 参数（w/h/bend/slope/taper/shift/tilt），
   *  位置沿用角色 style 的 dx / cy */
  function buildCustomEyePair(o, style) {
    var merged = Object.assign({ w: style.w, h: style.h, taper: style.taper, tilt: style.tilt, bend: style.bend }, o);
    return [lens(C - style.dx, style.cy, merged, 1), lens(C + style.dx, style.cy, merged, -1)];
  }

  /** 自定义嘴形：o 为原始 mouthLens 参数（w/h/bend/taper） */
  function buildCustomMouth(o) {
    return mouthLens(Object.assign({ w: 24, h: 3, bend: 0, taper: 0.8 }, o));
  }

  MM.geo = {
    C: C,
    R: R,
    BODY_N: BODY_N,
    EYE_N: EYE_N,
    MOUTH_N: MOUTH_N,
    buildBody: buildBody,
    buildEyePair: buildEyePair,
    buildEyeFamily: buildEyeFamily,
    buildMouth: buildMouth,
    buildCustomEyePair: buildCustomEyePair,
    buildCustomMouth: buildCustomMouth,
    eyeSlots: Object.keys(EYE_SLOTS),
    mouthSlots: Object.keys(MOUTH_SLOTS),
    bodyTypes: Object.keys(BODY_GEN),
    lens: lens,
    sampleRadial: sampleRadial
  };
})();

/* ============================================================
 * render.js —— 渲染层（纯渲染，不含业务逻辑）
 *
 *   坐标系：viewBox 0 0 240 240，头部中心 C = 120
 *
 *   身体（高端质感）：
 *     4 停靠径向渐变（顶光→本色→边缘收深）+ 釉面高光斑 + 地面软投影，
 *     投影随弹跳升离地面自动收缩变淡
 *
 *   眼睛（两种模式，物理正确）：
 *     bean  豆眼：整个 lens 环即眼睑剪影，闭眼 = 剪影压扁（原有模式）
 *     iris  瞳孔眼：lens 环作为眼睑开口 clipPath，内部依次渲染
 *           眼白 → 虹膜（径向渐变）→ 瞳孔 → 定光源高光。
 *           闭眼 = 眼睑闭合裁掉整个眼球，瞳孔绝不会悬浮在闭眼之外；
 *           小眼（眯/扫读）藏白色高光、瞳孔按比例缩小；注视时瞳孔钳制在眼环 bbox 内。
 *           高光保持光源方位不动 —— 符合真实眼球转动的观感
 *
 *   五官 / 配饰：见 features.js（配饰联动系统）
 *   特效：见 fx.js（发射器 + 签名动作）
 *   球面投影：按眼睛当前高度采样身体轮廓局部半宽，经度换算 + 余弦压缩，
 *            自旋偏航绕到背面自动隐藏（cos <= 0.02 判定）
 *   zzz：睡眠状态右上角循环漂浮的字母粒子
 * ============================================================ */
(function () {
  'use strict';

  var MM = (window.MoodMates = window.MoodMates || {});
  var SVGNS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  var C = 120;   /* 与 geometry.js 保持一致 */

  function el(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function shade(hex, amt) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var target = amt < 0 ? 0 : 255;
    var a = Math.abs(amt);
    r = Math.round(r + (target - r) * a);
    g = Math.round(g + (target - g) * a);
    b = Math.round(b + (target - b) * a);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  /* 轮廓环 → 平滑闭合曲线 path
   * Catmull-Rom → 三次贝塞尔：折线顶点在放大后会露出多边形棱角（锯齿感），
   * 用过点样条把每段换成 C 曲线，任意采样密度下边缘都圆润 */
  function ringPath(ring) {
    var n = ring.length;
    if (n < 3) return 'M0 0Z';
    var s = 'M' + ring[0][0].toFixed(2) + ' ' + ring[0][1].toFixed(2);
    for (var i = 0; i < n; i++) {
      var p0 = ring[(i - 1 + n) % n];
      var p1 = ring[i];
      var p2 = ring[(i + 1) % n];
      var p3 = ring[(i + 2) % n];
      s += 'C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(2) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(2) +
           ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(2) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(2) +
           ' ' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
    }
    return s + 'Z';
  }
  function centroid(ring) {
    var x = 0, y = 0;
    for (var i = 0; i < ring.length; i++) { x += ring[i][0]; y += ring[i][1]; }
    return [x / ring.length, y / ring.length];
  }
  /** 轮廓实际厚度 = 鞋带面积 / 包围盒宽度。
   *  拱形笑眼（∩）包围盒虽高但实际很薄，用厚度才能正确判定闭合感 */
  function ringThickness(ring) {
    var area = 0, minX = 1e9, maxX = -1e9;
    for (var i = 0; i < ring.length; i++) {
      var a = ring[i], b = ring[(i + 1) % ring.length];
      area += a[0] * b[1] - b[0] * a[1];
      if (a[0] < minX) minX = a[0];
      if (a[0] > maxX) maxX = a[0];
    }
    var w = Math.max(maxX - minX, 1);
    return Math.abs(area) / 2 / w;
  }
  function ringBBox(ring) {
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i];
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, w: maxX - minX, h: maxY - minY };
  }
  /* 盒子过窄时取中点，避免 inset 后 lo > hi */
  function clampIn(v, lo, hi) {
    if (lo > hi) return (lo + hi) / 2;
    return clamp(v, lo, hi);
  }
  var BEAN_HL_MIN_H = 10;   /* 豆眼高光：有效可见高度低于此才隐藏（真正闭眼/笑成弧线） */
  var BEAN_HL_FULL_H = 26;  /* 高光点满尺寸的可见高度；更小的眼形按比例缩小高光点 */
  var IRIS_LASH = 0.26;     /* 睫线：effOpen 低于此隐藏虹膜/瞳孔/高光 */
  var IRIS_SMALL = 0.45;    /* 小眼：介于睫线与此之间只留虹膜 */

  /**
   * createBall(container, opts)
   *   opts.character —— 已解析的角色定义（引擎负责解析），包含：
   *     bodyRing / face / palette / eyeStyle / features / fxSkin / defaultEyeRing
   */
  function createBall(container, opts) {
    opts = opts || {};
    var id = 'mm' + (uid++);
    var lite = !!opts.lite;
    var ch = opts.character;
    var face = ch.face;
    var headRing = ch.bodyRing;
    var palette = ch.palette;
    var feats = ch.features || {};
    var pupilCfg = ch.eyeStyle.pupil || null;

    /* ---- 形状轮廓采样：每 2px 一行的 [minX, maxX]，供五官贴合任意剪影 ---- */
    var silMinY = 1e9, silMaxY = -1e9, silMaxW = 0;
    var i;
    for (i = 0; i < headRing.length; i++) {
      if (headRing[i][1] < silMinY) silMinY = headRing[i][1];
      if (headRing[i][1] > silMaxY) silMaxY = headRing[i][1];
    }
    var SIL_STEP = 2;
    var silRows = [];
    (function buildSil() {
      var rows = Math.ceil((silMaxY - silMinY) / SIL_STEP) + 1;
      for (var r = 0; r < rows; r++) {
        var y = silMinY + r * SIL_STEP;
        var lo = 1e9, hi = -1e9;
        for (var e = 0; e < headRing.length; e++) {
          var a = headRing[e], b = headRing[(e + 1) % headRing.length];
          var y0 = a[1], y1 = b[1];
          if ((y0 <= y && y1 >= y) || (y1 <= y && y0 >= y)) {
            var t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
            var x = a[0] + (b[0] - a[0]) * t;
            if (x < lo) lo = x;
            if (x > hi) hi = x;
          }
        }
        if (lo > hi) { lo = C - 4; hi = C + 4; }
        silRows.push([lo, hi]);
        if (hi - lo > silMaxW) silMaxW = hi - lo;
      }
    })();
    function silAt(y) {
      var r = Math.round((clamp(y, silMinY, silMaxY) - silMinY) / SIL_STEP);
      return silRows[clamp(r, 0, silRows.length - 1)];
    }

    /* ---- SVG 骨架 ---- */
    var svg = el('svg', {
      viewBox: '0 0 240 240',
      width: '100%',
      height: '100%',
      class: 'mm-svg',
      role: 'img',
      'aria-label': opts.label || ch.name || 'Mood Mates 角色'
    });
    svg.style.display = 'block';
    svg.style.overflow = 'visible';

    var defs = el('defs', {});
    svg.appendChild(defs);

    /* 身体渐变：顶光 → 提亮 → 本色 → 边缘收深（伪 3D 体积） */
    var grad = el('radialGradient', { id: id + 'g', cx: '36%', cy: '26%', r: '86%' });
    var stops = [
      el('stop', { offset: '0%' }),
      el('stop', { offset: '38%' }),
      el('stop', { offset: '78%' }),
      el('stop', { offset: '100%' })
    ];
    stops.forEach(function (s) { grad.appendChild(s); });
    defs.appendChild(grad);

    /* 釉面高光渐变（白 → 透明） */
    var glossGrad = el('radialGradient', { id: id + 'gl', cx: '50%', cy: '42%', r: '58%' });
    glossGrad.appendChild(el('stop', { offset: '0%', 'stop-color': '#FFFFFF', 'stop-opacity': '0.9' }));
    glossGrad.appendChild(el('stop', { offset: '68%', 'stop-color': '#FFFFFF', 'stop-opacity': '0.22' }));
    glossGrad.appendChild(el('stop', { offset: '100%', 'stop-color': '#FFFFFF', 'stop-opacity': '0' }));
    defs.appendChild(glossGrad);

    /* 地面投影渐变（黑 → 透明） */
    var shGrad = el('radialGradient', { id: id + 'sh', cx: '50%', cy: '50%', r: '50%' });
    shGrad.appendChild(el('stop', { offset: '0%', 'stop-color': '#000000', 'stop-opacity': '0.9' }));
    shGrad.appendChild(el('stop', { offset: '72%', 'stop-color': '#000000', 'stop-opacity': '0.32' }));
    shGrad.appendChild(el('stop', { offset: '100%', 'stop-color': '#000000', 'stop-opacity': '0' }));
    defs.appendChild(shGrad);

    /* 虹膜渐变（瞳孔眼用）：上深下亮，模拟入射光在虹膜下缘的散射 */
    var irisGrad = null;
    if (pupilCfg) {
      var irisColor = pupilCfg.irisColor || palette.eye;
      irisGrad = el('radialGradient', { id: id + 'ir', cx: '50%', cy: '38%', r: '72%' });
      irisGrad.appendChild(el('stop', { offset: '0%', 'stop-color': shade(irisColor, -0.25) }));
      irisGrad.appendChild(el('stop', { offset: '62%', 'stop-color': irisColor }));
      irisGrad.appendChild(el('stop', { offset: '100%', 'stop-color': shade(irisColor, 0.28) }));
      defs.appendChild(irisGrad);
    }

    /* ---- 地面软投影（不随身体旋转，只跟位移 / 起跳收缩） ---- */
    var shadowRy = 7;
    var shadowCy = Math.min(silMaxY + 6, 234);
    var shadow = el('ellipse', {
      cx: C, cy: shadowCy,
      rx: r2(silMaxW * 0.36), ry: shadowRy,
      fill: 'url(#' + id + 'sh)', opacity: '0.16',
      'pointer-events': 'none'
    });
    svg.appendChild(shadow);

    /* 管家定制（2026-09-05）：fx 粒子层整体放大 2.2x——原版 demo 球 ~240px 粒子 4-5px 可见，
     * 管家球 50px 时粒子仅 ~1px 不可见。以球心 120 为锚等比缩放，形态/轨迹保持原汁。 */
    var FX_ZOOM = 2.2;
    var fxZoomTf = 'translate(120 120) scale(' + FX_ZOOM + ') translate(-120 -120)';
    var fxBack = el('g', { 'pointer-events': 'none', transform: fxZoomTf });
    svg.appendChild(fxBack);

    var bodyG = el('g', { class: 'mm-body' });

    /* 背层配饰（帽子 / 提手等从身体后面探出的部分） */
    var featureCtx = {
      el: el, ringPath: ringPath, r2: r2, clamp: clamp, shade: shade,
      C: C, face: face, palette: palette, eyeStyle: ch.eyeStyle, silAt: silAt,
      silMinY: silMinY, silMaxY: silMaxY, defs: defs, uid: id
    };
    var featureLayer = MM.createFeatures
      ? MM.createFeatures(bodyG, feats, featureCtx)
      : null;
    if (featureLayer && featureLayer.back) bodyG.appendChild(featureLayer.back);

    var head = el('path', { d: ringPath(headRing), fill: 'url(#' + id + 'g)', stroke: 'none', 'stroke-width': '2' });
    bodyG.appendChild(head);

    /* 釉面高光斑：贴着剪影左上方，跟随身体一切变换；
     * 用身体剪影 clipPath 裁剪，避免在星形 / 云朵等凹形轮廓上溢出体外 */
    var glossAmt = palette.gloss != null ? palette.gloss : 0.3;
    var gloss = null;
    if (glossAmt > 0) {
      var glossClip = el('clipPath', { id: id + 'bc', clipPathUnits: 'userSpaceOnUse' });
      glossClip.appendChild(el('path', { d: ringPath(headRing) }));
      defs.appendChild(glossClip);
      /* 裁剪组不带 transform，确保 clip 与静态身体环精确对齐 */
      var glossWrap = el('g', { 'clip-path': 'url(#' + id + 'bc)', 'pointer-events': 'none' });
      gloss = el('ellipse', {
        cx: r2(C - silMaxW * 0.17),
        cy: r2(silMinY + (silMaxY - silMinY) * 0.2),
        rx: r2(silMaxW * 0.15),
        ry: r2((silMaxY - silMinY) * 0.1),
        fill: 'url(#' + id + 'gl)',
        opacity: String(glossAmt),
        transform: 'rotate(-24 ' + r2(C - silMaxW * 0.17) + ' ' + r2(silMinY + (silMaxY - silMinY) * 0.2) + ')'
      });
      glossWrap.appendChild(gloss);
      bodyG.appendChild(glossWrap);
    }

    /* 底部环境光遮蔽（AO）：身体下缘轻微压暗，增强体积贴地感 */
    var aoGrad = el('linearGradient', { id: id + 'ao', x1: '0%', y1: '0%', x2: '0%', y2: '100%' });
    aoGrad.appendChild(el('stop', { offset: '58%', 'stop-color': '#000000', 'stop-opacity': '0' }));
    aoGrad.appendChild(el('stop', { offset: '100%', 'stop-color': '#000000', 'stop-opacity': '0.14' }));
    defs.appendChild(aoGrad);
    var ao = el('path', { d: ringPath(headRing), fill: 'url(#' + id + 'ao)', 'pointer-events': 'none' });
    bodyG.appendChild(ao);

    /* 腮红在眼睛之下、身体之上 */
    if (featureLayer && featureLayer.mid) bodyG.appendChild(featureLayer.mid);

    var EYE_HALF = ch.eyeStyle.h / 2;

    /* ============ 眼睛构建 ============
     * bean：单 path（原有模式）
     * iris：g[clip] > 眼白 path + 虹膜 + 瞳孔 + 高光（clipPath 引用眼睑环） */
    function buildEye(k) {
      var ring0 = ch.defaultEyeRing[k];
      var base = centroid(ring0);
      var eye = { ring: ring0, c: base, base: base, k: k,
        defBBox: ringBBox(ring0), bbox: ringBBox(ring0), thick: ringThickness(ring0) };

      if (!pupilCfg) {
        /* ---- bean 豆眼 ---- */
        eye.mode = 'bean';
        /* data-jz-eye：与 iris/v1 同规格的真实眼球标识（0=left 1=right）。
         * setEye 对 eye.node 无条件写 transform（含 pose.lookX，:788），bean path
         * 同样是真实 gaze 渲染路径——nimbo 走 bean 分支，缺标识则 probe 的眼神
         * 跟随断言对 nimbo 采不到样（2026-09-05 Codex 五轮打回）。纯标识属性。 */
        eye.node = el('path', { fill: palette.eye, stroke: 'none', 'stroke-width': '1.6', 'data-jz-eye': k === 0 ? 'left' : 'right', d: ringPath(ring0) });
        if (ch.eyeStyle.highlight) {
          var hls = ch.eyeStyle.highlight;
          eye.hls = (Array.isArray(hls) ? hls : [hls]).map(function (h) {
            return {
              cfg: h,
              node: el('circle', {
                r: h.r || 3, fill: h.color || palette.eyeHighlight || '#FFFFFF',
                opacity: h.opacity != null ? h.opacity : 0.92, 'pointer-events': 'none'
              })
            };
          });
        }
        return eye;
      }

      /* ---- iris 瞳孔眼 ---- */
      eye.mode = 'iris';
      eye.thick = ringThickness(ring0);
      var clipId = id + 'ec' + k;
      var cp = el('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
      eye.lidClip = el('path', { d: ringPath(ring0) });
      cp.appendChild(eye.lidClip);
      defs.appendChild(cp);

      /* data-jz-eye：真实眼球稳定标识（0=left 1=right，iris 模式挂在容器 g 上）。
       * 真机 probe 的眼神跟随断言只认这个节点——transform 由 setEye 每帧写入、
       * 含 pose.lookX（真实 gaze 渲染路径）。眼镜/腮红/眉毛等配饰层不许带此标识
       *（2026-09-05 Codex 四轮打回：标在 glasses 上只能证明镜片跟随，不证明 gaze）。
       * 纯标识属性，不改任何渲染行为。 */
      eye.node = el('g', { 'data-jz-eye': k === 0 ? 'left' : 'right' });
      var inner = el('g', { 'clip-path': 'url(#' + clipId + ')' });
      eye.inner = inner;

      /* 眼白（与眼睑开口同形同步缩放） */
      eye.socket = el('path', {
        d: ringPath(ring0),
        fill: pupilCfg.socket || '#FFFFFF'
      });
      inner.appendChild(eye.socket);

      /* 虹膜 + 瞳孔（正圆，不随眼睑压扁，闭眼时被裁剪） */
      var irisR = pupilCfg.irisR || EYE_HALF * 0.86;
      var pupilR = pupilCfg.pupilR || irisR * 0.52;
      eye.irisR = irisR;
      eye.pupilR = pupilR;
      eye.iris = el('circle', { r: irisR, fill: 'url(#' + id + 'ir)' });
      eye.pupil = el('circle', { r: pupilR, fill: pupilCfg.pupilColor || shade(pupilCfg.irisColor || palette.eye, -0.72) });
      inner.appendChild(eye.iris);
      inner.appendChild(eye.pupil);

      /* 定光源高光：主高光 + 副光点，不随眼球转动（光源方位不变） */
      var hlList = pupilCfg.highlights || [
        { dx: -irisR * 0.34, dy: -irisR * 0.4, r: irisR * 0.3 },
        { dx: irisR * 0.36, dy: irisR * 0.22, r: irisR * 0.13, opacity: 0.6 }
      ];
      eye.hlNodes = hlList.map(function (h) {
        var n = el('circle', {
          r: h.r, fill: h.color || '#FFFFFF',
          opacity: h.opacity != null ? h.opacity : 0.95,
          'pointer-events': 'none'
        });
        inner.appendChild(n);
        return { cfg: h, node: n };
      });

      eye.node.appendChild(inner);
      return eye;
    }

    var eyeL = buildEye(0);
    var eyeR = buildEye(1);
    bodyG.appendChild(eyeL.node);
    bodyG.appendChild(eyeR.node);
    if (eyeL.hls) eyeL.hls.forEach(function (h) { bodyG.appendChild(h.node); });
    if (eyeR.hls) eyeR.hls.forEach(function (h) { bodyG.appendChild(h.node); });

    /* 眉毛 / 嘴巴 / 前层配饰（眼镜领结等）在眼睛之上 */
    if (featureLayer && featureLayer.front) bodyG.appendChild(featureLayer.front);

    svg.appendChild(bodyG);

    var fxFront = el('g', { 'pointer-events': 'none', transform: fxZoomTf });
    svg.appendChild(fxFront);

    var BASE_C = [centroid(ch.defaultEyeRing[0]), centroid(ch.defaultEyeRing[1])];

    /* ---- zzz 睡眠粒子 ---- */
    var zzzNodes = null;
    if (!lite) {
      zzzNodes = [];
      for (var zi = 0; zi < 3; zi++) {
        var zn = el('text', {
          x: 0, y: 0, fill: palette.zzz || '#A8A296', opacity: '0',
          'font-family': "'Space Grotesk', 'Noto Sans SC', sans-serif",
          'font-weight': '700', 'font-style': 'italic', 'text-anchor': 'middle'
        });
        zn.textContent = 'z';
        fxFront.appendChild(zn);
        zzzNodes.push(zn);
      }
    }

    container.appendChild(svg);

    /* ---- 特效实例（fx.js：发射器 + 签名动作） ----
     * anchors：嘴 / 头顶 / 底部锚点与身体半宽，供签名动作发射器定位 */
    var mouthAnchorY = C + face.y + (((feats.mouth && feats.mouth.dy) || 36)) * face.sy;
    var fx = (!lite && MM.createFx)
      ? MM.createFx({
          defs: defs, back: fxBack, front: fxFront, C: C,
          skin: ch.fxSkin, palette: palette, el: el, r2: r2,
          anchors: {
            mouth: { x: C, y: mouthAnchorY },
            top: { x: C, y: silMinY },
            bottom: { x: C, y: silMaxY },
            halfW: silMaxW / 2
          }
        })
      : null;

    /* ---- 状态缓存 ---- */
    var curBodyColor = null;
    var curSketch = -1;
    var prevYaw = 0, prevNow = 0;

    function setBodyColor(color) {
      if (color === curBodyColor) return;
      curBodyColor = color;
      stops[0].setAttribute('stop-color', shade(color, 0.42));
      stops[1].setAttribute('stop-color', shade(color, 0.14));
      stops[2].setAttribute('stop-color', color);
      stops[3].setAttribute('stop-color', shade(color, -0.22));
    }

    function applySketchChrome(on, color) {
      svg.classList.toggle('is-sketch', on);
      if (on) {
        head.setAttribute('fill', 'none');
        head.setAttribute('stroke', 'none');
        head.style.stroke = 'var(--sketch-ink, ' + shade(color, -0.6) + ')';
        head.setAttribute('stroke-opacity', '0.85');
        if (gloss) gloss.style.display = 'none';
        ao.style.display = 'none';
      } else {
        head.setAttribute('fill', 'url(#' + id + 'g)');
        head.setAttribute('stroke', 'none');
        head.style.stroke = '';
        head.removeAttribute('stroke-opacity');
        if (gloss) gloss.style.display = '';
        ao.style.display = '';
      }
    }

    /* ---- 眼睛：轮廓环形变 + 球面投影 + 分层眼球 ---- */
    function setEye(eye, pose, k, sketch, yaw) {
      var ring = pose.ring;
      if (ring && ring !== eye.ring) {
        eye.ring = ring;
        var d = ringPath(ring);
        if (eye.mode === 'bean') {
          eye.node.setAttribute('d', d);
        } else {
          eye.lidClip.setAttribute('d', d);
          eye.socket.setAttribute('d', d);
        }
        eye.c = centroid(ring);
        eye.bbox = ringBBox(ring);
        eye.thick = ringThickness(ring);
      }

      var base = eye.c || BASE_C[k];
      var open = clamp(pose.open, 0.02, 2.4);
      var syEye = clamp(pose.scaleY * face.eye, 0.02, 2.4);
      var sxBase = pose.scaleX * face.eye;

      /* bean 模式垂直缩放包含开合度；iris 模式开合度只压眼睑 */
      var syAll = eye.mode === 'bean' ? clamp(syEye * open, 0.02, 2.4) : syEye;

      var halfH = EYE_HALF * clamp(syEye * open, 0.02, 2.4) + 2;
      var ey0 = C + face.y + (base[1] - C) * face.sy + pose.y + pose.lookY;
      ey0 = clamp(ey0, silMinY + halfH, silMaxY - halfH);

      var sil = silAt(ey0);
      var cx0 = (sil[0] + sil[1]) / 2;
      var hw = Math.max((sil[1] - sil[0]) / 2, 12);

      var ox = face.x + (base[0] - C) * face.sx + pose.x + pose.lookX;
      var theta = clamp(ox / hw, -1.15, 1.15);
      var total = theta + (yaw || 0);
      var cn = Math.cos(total);
      if (cn <= 0.02) {
        eye.node.style.display = 'none';
        if (eye.hls) eye.hls.forEach(function (h) { h.node.style.display = 'none'; });
        return;
      }
      eye.node.style.display = '';
      var ex = cx0 + hw * Math.sin(total) * 0.985;
      var dyN = (ey0 - C) / 130;
      var fy = Math.sqrt(1 - dyN * dyN * 0.22);

      var tf =
        'translate(' + r2(ex) + ' ' + r2(ey0) + ')' +
        (pose.rotate ? ' rotate(' + r2(pose.rotate) + ')' : '') +
        ' scale(' + r2(sxBase * cn) + ' ' + r2(syAll * fy) + ')';
      var tfFull = tf + ' translate(' + r2(-base[0]) + ' ' + r2(-base[1]) + ')';
      eye.node.setAttribute('transform', tfFull);

      if (eye.mode === 'bean') {
        /* ---- bean：高光点贴同一变换；有效高度过低（眯/困/扫读）隐藏 ---- */
        if (eye.hls) {
          var boxH = eye.bbox ? eye.bbox.h : EYE_HALF * 2;
          var thickH = (eye.thick != null ? eye.thick : boxH) * 1.65;
          var visH = Math.min(boxH, thickH) * Math.abs(syAll * fy);
          var hideHl = visH <= BEAN_HL_MIN_H || sketch > 0.5;
          var defB = eye.defBBox || eye.bbox;
          var curB = eye.bbox || defB;
          var sxOff = defB && defB.w > 0.5 ? curB.w / defB.w : 1;
          var syOff = defB && defB.h > 0.5 ? curB.h / defB.h : 1;
          var c0 = eye.c || base;
          for (var hi = 0; hi < eye.hls.length; hi++) {
            var hl = eye.hls[hi];
            if (hideHl) {
              hl.node.style.display = 'none';
            } else {
              hl.node.style.display = '';
              /* 小眼形保留按比例缩小的瞳点，眼神不丢 */
              var hlScale = clamp(visH / BEAN_HL_FULL_H, 0.55, 1);
              var hlR = (hl.cfg.r || 3) * hlScale;
              if (hlR !== hl.lastR) {
                hl.node.setAttribute('r', r2(hlR));
                hl.lastR = hlR;
              }
              var hdx = (hl.cfg.dx || 0) * (k === 0 ? 1 : -1) * sxOff;
              var hdy = (hl.cfg.dy || 0) * syOff;
              /* 按当前眼环比例缩放偏移，并保证点心距 bbox 边缘 ≥ 半径 */
              if (curB) {
                hdx = clampIn(hdx, (curB.minX - c0[0]) + hlR, (curB.maxX - c0[0]) - hlR);
                hdy = clampIn(hdy, (curB.minY - c0[1]) + hlR, (curB.maxY - c0[1]) - hlR);
              }
              hl.node.setAttribute('transform', tf +
                ' translate(' + r2(hdx) + ' ' + r2(hdy) + ')');
            }
          }
        }
        var fill = sketch > 0.5 ? 'none' : pose.color;
        /* 线稿眼描边走主题墨色，深色瞳色在暗色页面上也保持可见 */
        var stroke = sketch > 0.5 ? 'var(--sketch-ink, ' + pose.color + ')' : '';
        if (fill !== eye.lastFill) { eye.node.setAttribute('fill', fill); eye.lastFill = fill; }
        if (stroke !== eye.lastStroke) { eye.node.style.stroke = stroke; eye.lastStroke = stroke; }
        return;
      }

      /* ---- iris：眼睑闭合裁剪 + 眼球滑动 ---- */

      /* 实际闭合判定：轮廓厚度 × 开合度。
       * 睫线模式（effOpen < 0.26）：深色睫线，藏起虹膜/瞳孔/高光；
       * 小眼模式（0.26~0.45）：保留虹膜与「按比例缩小的瞳孔」，只藏白色高光 ——
       * 深色瞳点在眯眼 / 扫读等小眼表情里不再整颗消失，眼神不丢 */
      var thick = eye.thick != null ? eye.thick : EYE_HALF * 2 * 0.7;
      var effOpen = open * thick / (EYE_HALF * 2);
      var lash = effOpen < IRIS_LASH;
      var small = !lash && effOpen < IRIS_SMALL;
      if (lash !== eye.lastLash || small !== eye.lastSmall) {
        eye.lastLash = lash;
        eye.lastSmall = small;
        eye.iris.style.display = lash ? 'none' : '';
        eye.pupil.style.display = lash ? 'none' : '';
        for (var lh = 0; lh < eye.hlNodes.length; lh++) {
          eye.hlNodes[lh].node.style.display = (lash || small) ? 'none' : '';
        }
      }
      /* 小眼档瞳孔按开合度缩放（最小 0.6 倍），全表情瞳点观感一致 */
      var pupilScl = lash ? 1 : clamp(effOpen / IRIS_SMALL, 0.6, 1);
      var pupilRNow = eye.pupilR * pupilScl;
      if (pupilRNow !== eye.lastPupilR) {
        eye.pupil.setAttribute('r', r2(pupilRNow));
        eye.lastPupilR = pupilRNow;
      }
      var socketFill = lash ? pose.color : (pupilCfg.socket || '#FFFFFF');
      if (socketFill !== eye.lastSocketFill) {
        eye.socket.setAttribute('fill', socketFill);
        eye.lastSocketFill = socketFill;
      }

      var lidTf = open >= 0.995 && open <= 1.005
        ? ''
        : 'translate(' + r2(base[0]) + ' ' + r2(base[1]) + ') scale(1 ' + r2(open) + ') translate(' + r2(-base[0]) + ' ' + r2(-base[1]) + ')';
      if (lidTf !== eye.lastLidTf) {
        if (lidTf) {
          eye.lidClip.setAttribute('transform', lidTf);
          eye.socket.setAttribute('transform', lidTf);
        } else {
          eye.lidClip.removeAttribute('transform');
          eye.socket.removeAttribute('transform');
        }
        eye.lastLidTf = lidTf;
      }

      /* 瞳孔额外滑动：比眼睑多走 50%，再按当前眼环 bbox 钳制，避免被眼睑裁成月牙 */
      var travel = eye.irisR * 0.5;
      var px = base[0] + clamp(pose.lookX * 0.5, -travel, travel);
      var py = base[1] + clamp(pose.lookY * 0.55, -travel, travel);
      var bb = eye.bbox;
      if (bb) {
        var pR = eye.pupilR || eye.irisR * 0.5;
        var iPad = (eye.irisR || pR) * 0.32;   /* 虹膜约束更松 */
        var padX = Math.max(pR, iPad);
        var visMinY = base[1] + (bb.minY - base[1]) * open;
        var visMaxY = base[1] + (bb.maxY - base[1]) * open;
        px = clampIn(px, bb.minX + padX, bb.maxX - padX);
        py = clampIn(py, visMinY + pR, visMaxY - pR);
      }
      var ballTf = 'translate(' + r2(px - base[0]) + ' ' + r2(py - base[1]) + ')';
      if (ballTf !== eye.lastBallTf) {
        eye.iris.setAttribute('transform', ballTf);
        eye.pupil.setAttribute('transform', ballTf);
        eye.lastBallTf = ballTf;
      }
      eye.iris.setAttribute('cx', r2(base[0]));
      eye.iris.setAttribute('cy', r2(base[1]));
      eye.pupil.setAttribute('cx', r2(base[0]));
      eye.pupil.setAttribute('cy', r2(base[1]));

      /* 定光源高光：位置相对眼心固定（镜像），不跟随眼球滑动 */
      for (var hj = 0; hj < eye.hlNodes.length; hj++) {
        var hn = eye.hlNodes[hj];
        hn.node.setAttribute('cx', r2(base[0] + (hn.cfg.dx || 0) * (k === 0 ? 1 : -1)));
        hn.node.setAttribute('cy', r2(base[1] + (hn.cfg.dy || 0)));
      }

      /* 眼睑着色：iris 模式下 pose.color 用作眼睑线色（sketch 模式描边） */
      var showInner = sketch <= 0.5;
      if (showInner !== eye.lastShowInner) {
        eye.inner.style.display = showInner ? '' : 'none';
        eye.lastShowInner = showInner;
      }
      if (sketch > 0.5) {
        if (!eye.sketchNode) {
          eye.sketchNode = el('path', { fill: 'none', 'stroke-width': '1.6' });
          eye.node.appendChild(eye.sketchNode);
        }
        eye.sketchNode.style.display = '';
        eye.sketchNode.setAttribute('d', ringPath(eye.ring));
        eye.sketchNode.style.stroke = 'var(--sketch-ink, ' + pose.color + ')';
        if (lidTf) eye.sketchNode.setAttribute('transform', lidTf);
        else eye.sketchNode.removeAttribute('transform');
      } else if (eye.sketchNode) {
        eye.sketchNode.style.display = 'none';
      }
    }

    /* ---- 每帧 ---- */
    function applyPose(pose) {
      var b = pose.body;
      var now = performance.now();
      var sketch = b.sketch || 0;

      /* 自旋表现：角度翻转优于折叠 —— 身体随偏航轻微倾斜 + 横向弹性压缩，
       * 像硬币旋转的透视感；避免只有五官滑动、身体纹丝不动的"纸片折叠"观感 */
      var yaw0 = b.yaw || 0;
      var spinTilt = 0, spinSqX = 1;
      if (yaw0 > 0.001 || yaw0 < -0.001) {
        spinTilt = 5 * Math.sin(yaw0);
        spinSqX = 0.88 + 0.12 * Math.abs(Math.cos(yaw0));
      }

      bodyG.setAttribute('transform',
        'translate(' + r2(C + b.x) + ' ' + r2(C + b.y) + ')' +
        ' rotate(' + r2((b.rotate || 0) + spinTilt) + ')' +
        ' scale(' + r2(b.scale * spinSqX) + ' ' + r2(b.scale) + ')' +
        ' translate(' + r2(-C) + ' ' + r2(-C) + ')');
      setBodyColor(b.color);

      /* 地面投影：跟随水平位移，升离地面（弹跳）时收缩变淡 */
      var lift = clamp(-b.y / 52, 0, 1);
      var shOp = sketch > 0.5 ? 0 : 0.16 * (1 - 0.55 * lift);
      shadow.setAttribute('opacity', shOp.toFixed(3));
      if (shOp > 0.001) {
        shadow.setAttribute('transform',
          'translate(' + r2(C + b.x * 0.7) + ' ' + shadowCy + ')' +
          ' scale(' + r2((1 - 0.3 * lift) * b.scale) + ' ' + r2(1 - 0.35 * lift) + ')' +
          ' translate(' + (-C) + ' ' + (-shadowCy) + ')');
      }

      /* 线稿是展示开关：按阈值切换，离开时清掉属性描边，避免庆祝改色后描边残留在实体上 */
      var sketchOn = sketch > 0.5;
      if (sketchOn !== (curSketch > 0.5)) {
        curSketch = sketchOn ? 1 : 0;
        applySketchChrome(sketchOn, b.color);
      }

      var yaw = b.yaw || 0;
      setEye(eyeL, pose.left, 0, sketch, yaw);
      setEye(eyeR, pose.right, 1, sketch, yaw);

      if (featureLayer) featureLayer.apply(pose, sketch, yaw, now);

      if (lite) return;

      var dt = prevNow ? clamp((now - prevNow) / 1000, 0.001, 0.05) : 1 / 60;
      prevNow = now;

      /* ---- zzz 睡眠粒子 ---- */
      if (zzzNodes) {
        var zOn = (b.zzz || 0) > 0;
        for (var z = 0; z < zzzNodes.length; z++) {
          var znode = zzzNodes[z];
          if (!zOn) {
            if (znode.getAttribute('opacity') !== '0') znode.setAttribute('opacity', '0');
            continue;
          }
          var zp = (now * 0.00033 + z / 3) % 1;
          var zo = (zp < 0.18 ? zp / 0.18 : 1 - (zp - 0.18) / 0.82) * 0.8 * b.zzz;
          znode.setAttribute('opacity', zo.toFixed(3));
          znode.setAttribute('font-size', (12 + zp * 11).toFixed(1));
          znode.setAttribute('transform',
            'translate(' + r2(186 + zp * 34 + 4 * Math.sin(zp * 9)) + ' ' + r2(52 - zp * 42) + ')' +
            ' rotate(' + r2(-10 + zp * 14) + ')');
        }
      }

      /* ---- 自旋角速度（特效触发源） ---- */
      var dYaw = yaw - prevYaw;
      if (!isFinite(dYaw) || Math.abs(dYaw) > 1.2) dYaw = 0;
      prevYaw = yaw;
      var vel = dYaw / dt;

      if (fx) {
        fx.update(dt, now, {
          yaw: yaw, dYaw: dYaw, vel: vel,
          orbitWant: (b.orbit || 0) > 0,
          bodyX: b.x, bodyY: b.y
        });
      }
    }

    function burst(count) {
      if (fx) fx.burst(count);
    }
    /* 签名动作（云泡 / 星星爆闪），返回 false 表示该皮肤无签名 */
    function signature(strength) {
      return fx && fx.signature ? fx.signature(strength) : false;
    }

    function destroy() {
      if (fx) fx.destroy();
      if (svg.parentNode) svg.parentNode.removeChild(svg);
    }

    return { svg: svg, applyPose: applyPose, burst: burst, signature: signature, destroy: destroy,
      signatureMouth: fx && fx.signatureMouth, signatureMouthMs: fx && fx.signatureMouthMs,
      signatureComplete: !!(fx && fx.signatureComplete) };
  }

  MM.createBall = createBall;
  MM.util = { shade: shade, ringPath: ringPath, centroid: centroid };
})();

/* ============================================================
 * features.js —— 五官与配饰联动层
 *
 * 五官：
 *   嘴巴：24 点 lens 环，engine 逐点插值后传入（pose.face.mouthRing），
 *        本层负责贴合剪影的横向经度换算与背面隐藏（与眼睛同一套投影）
 *   腮红：两枚椭圆，透明度由 pose.face.blush（0~1）驱动，害羞时拉满
 *   眉毛：两条 lens 短条，角度 / 抬升由 pose.face.browTilt / browRaise 驱动
 *
 * 配饰联动系统：配饰不是写死的静态 path，而是带绑定的组件 ——
 *   kind: 'glasses'  眼镜：镜框由角色实际眼位 / 眼形自动求出（autoFit），
 *                    追随目光 75%（眼睛在镜片内滑动，有视差层次），
 *                    眨眼时镜框轻微下滑回弹，镜片周期性扫过高光（glint）
 *   kind: 'path'     自定义 path：anchor（'face' 投影贴脸 / 'abs' 身体坐标）
 *                    + micro 微动效（float 漂浮 / swing 摇摆）
 *
 * 由 render.js 调用：
 *   var layer = MM.createFeatures(bodyG, feats, ctx)
 *   layer.back / layer.mid / layer.front —— 三个挂载点（可为 null）
 *   layer.apply(pose, sketch, yaw, now)  —— 每帧更新
 * ============================================================ */
(function () {
  'use strict';

  var MM = (window.MoodMates = window.MoodMates || {});
  var TAU = Math.PI * 2;

  function createFeatures(bodyG, feats, ctx) {
    var el = ctx.el, ringPath = ctx.ringPath, r2 = ctx.r2, clamp = ctx.clamp, shade = ctx.shade;
    var C = ctx.C, face = ctx.face, palette = ctx.palette, eyeStyle = ctx.eyeStyle;

    var back = null, mid = null, front = el('g', { 'pointer-events': 'none' });
    var updaters = [];   /* 每帧回调集合（配饰联动） */

    function ensureBack() {
      if (!back) back = el('g', { 'pointer-events': 'none' });
      return back;
    }

    /* 横向经度换算（与眼睛同一套投影），返回 null 表示已绕到背面 */
    function project(ox, oy, yaw) {
      var sil = ctx.silAt(oy);
      var cx0 = (sil[0] + sil[1]) / 2;
      var hw = Math.max((sil[1] - sil[0]) / 2, 12);
      var theta = clamp(ox / hw, -1.15, 1.15);
      var total = theta + (yaw || 0);
      var cn = Math.cos(total);
      if (cn <= 0.02) return null;
      return { x: cx0 + hw * Math.sin(total) * 0.985, cn: cn };
    }

    /* 眼睛在板面坐标上的静态锚点（配饰 autoFit 的基准） */
    function eyeAnchor(side) {   /* side: -1 左 / 1 右 */
      return {
        ox: face.x + side * eyeStyle.dx * face.sx,             /* 相对中线偏移 */
        y: C + face.y + (eyeStyle.cy - C) * face.sy            /* 板面纵坐标 */
      };
    }

    /* micro 微动效求值：返回 { dy, rot } */
    function microVal(micro, now, seed) {
      if (!micro) return { dy: 0, rot: 0 };
      var ph = TAU * now / (micro.period || 3000) + (seed || 0);
      if (micro.type === 'float') return { dy: (micro.amp != null ? micro.amp : 1.6) * Math.sin(ph), rot: 0 };
      if (micro.type === 'swing') return { dy: 0, rot: (micro.amp != null ? micro.amp : 4) * Math.sin(ph) };
      return { dy: 0, rot: 0 };
    }

    /* ================= 配饰构建器 ================= */

    var ACC_BUILDERS = {

      /* ---- 眼镜：autoFit 双镜框 + 鼻梁 + 外侧短脚 + 扫光 ---- */
      glasses: function (acc) {
        var aL = eyeAnchor(-1), aR = eyeAnchor(1);
        var rr = (Math.max(eyeStyle.w, eyeStyle.h) / 2) * face.eye * (acc.fit != null ? acc.fit : 1.22) + 2;
        var color = acc.color || '#C9A24B';
        var sw = acc.strokeWidth != null ? acc.strokeWidth : 2.6;

        var g = el('g', { 'pointer-events': 'none' });
        var lensG = [null, null];
        var glintNodes = [];

        [aL, aR].forEach(function (a, idx) {
          var lg = el('g', {});
          /* 镜片玻璃感：极淡白填充 */
          lg.appendChild(el('circle', { r: r2(rr), fill: '#FFFFFF', 'fill-opacity': 0.07 }));
          /* 镜框 */
          lg.appendChild(el('circle', {
            r: r2(rr), fill: 'none', stroke: color, 'stroke-width': sw
          }));
          /* 扫光：细亮条，clip 在镜片内 */
          var clipId = ctx.uid + 'gls' + idx;
          var cp = el('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
          cp.appendChild(el('circle', { cx: 0, cy: 0, r: r2(rr - sw / 2) }));
          ctx.defs.appendChild(cp);
          var glintWrap = el('g', { 'clip-path': 'url(#' + clipId + ')' });
          var glint = el('rect', {
            x: r2(-rr * 0.22), y: r2(-rr * 1.6), width: r2(rr * 0.34), height: r2(rr * 3.2),
            fill: '#FFFFFF', opacity: 0.55, transform: 'rotate(24)'
          });
          glintWrap.appendChild(glint);
          lg.appendChild(glintWrap);
          glintNodes.push(glint);
          lensG[idx] = lg;
          g.appendChild(lg);
        });

        /* 鼻梁弧 + 外侧短镜脚（静态形状，随组变换） */
        var bridge = el('path', { fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round' });
        var armL = el('path', { fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round' });
        var armR = el('path', { fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round' });
        g.appendChild(bridge);
        g.appendChild(armL);
        g.appendChild(armR);

        var slide = 0;   /* 眨眼下滑的弹性状态 */

        return {
          node: g,
          layer: 'front',
          update: function (pose, sketch, yaw, now) {
            var f = pose.face || {};
            var openMin = Math.min(pose.left.open != null ? pose.left.open : 1,
                                   pose.right.open != null ? pose.right.open : 1);
            /* 眨眼下滑：闭眼程度驱动目标位移，指数平滑回弹 */
            var slideT = clamp(1 - openMin, 0, 1) * 1.8;
            slide += (slideT - slide) * 0.25;

            /* 追随目光 75% + 微漂浮 */
            var mv = microVal(acc.micro || { type: 'float', amp: 0.7, period: 3400 }, now, 1.3);
            var lookX = (pose.left.lookX || 0) * 0.75;
            var lookY = (pose.left.lookY || 0) * 0.75;
            var byv = (aL.y + aR.y) / 2 + lookY + slide + mv.dy;

            var pL = project(aL.ox + lookX, byv, yaw);
            var pR = project(aR.ox + lookX, byv, yaw);
            if (!pL && !pR) { g.style.display = 'none'; return; }
            g.style.display = '';
            g.setAttribute('opacity', sketch > 0.5 ? '0.55' : '1');

            var scl = face.eye;
            [pL, pR].forEach(function (p, idx) {
              var lg = lensG[idx];
              if (!p) { lg.style.display = 'none'; return; }
              lg.style.display = '';
              lg.setAttribute('transform',
                'translate(' + r2(p.x) + ' ' + r2(byv) + ') scale(' + r2(p.cn * scl) + ' ' + r2(scl) + ')');
            });

            /* 扫光：每 glintPeriod 一次，0.5s 内从左扫到右 */
            var per = acc.glintPeriod || 5200;
            var gp = (now % per) / per;
            var sweep = gp < 0.1 ? gp / 0.1 : -1;
            for (var gi = 0; gi < glintNodes.length; gi++) {
              if (sweep < 0) { glintNodes[gi].setAttribute('opacity', '0'); continue; }
              glintNodes[gi].setAttribute('opacity', (0.5 * Math.sin(Math.PI * sweep)).toFixed(3));
              glintNodes[gi].setAttribute('transform',
                'translate(' + r2((sweep * 2 - 1) * rr * 1.3) + ' 0) rotate(24)');
            }

            /* 鼻梁：两镜片内缘之间的上拱弧；镜脚：外缘向外上方短线 */
            if (pL && pR) {
              var x1 = pL.x + rr * pL.cn * scl, x2 = pR.x - rr * pR.cn * scl;
              bridge.style.display = '';
              bridge.setAttribute('d',
                'M' + r2(x1) + ' ' + r2(byv) +
                ' Q' + r2((x1 + x2) / 2) + ' ' + r2(byv - rr * 0.55) + ' ' + r2(x2) + ' ' + r2(byv));
            } else {
              bridge.style.display = 'none';
            }
            if (pL) {
              var xa = pL.x - rr * pL.cn * scl;
              armL.style.display = '';
              armL.setAttribute('d', 'M' + r2(xa) + ' ' + r2(byv) + ' L' + r2(xa - 7 * pL.cn) + ' ' + r2(byv - 3));
            } else armL.style.display = 'none';
            if (pR) {
              var xb = pR.x + rr * pR.cn * scl;
              armR.style.display = '';
              armR.setAttribute('d', 'M' + r2(xb) + ' ' + r2(byv) + ' L' + r2(xb + 7 * pR.cn) + ' ' + r2(byv - 3));
            } else armR.style.display = 'none';
          }
        };
      },

      /* ---- 自定义 path：anchor 'abs'（身体坐标，默认）/ 'face'（贴脸投影） ---- */
      path: function (acc) {
        var node = el('path', {
          d: acc.d,
          fill: acc.fill || 'none',
          stroke: acc.stroke || 'none',
          'stroke-width': acc.strokeWidth != null ? acc.strokeWidth : 0,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          opacity: acc.opacity != null ? acc.opacity : 1
        });
        var seed = acc.seed != null ? acc.seed : Math.random() * TAU;

        return {
          node: node,
          layer: acc.layer || 'front',
          update: function (pose, sketch, yaw, now) {
            var mv = microVal(acc.micro, now, seed);
            if (acc.anchor === 'face') {
              var byv = C + face.y + (acc.dy || 0) * face.sy + mv.dy;
              var p = project((acc.dx || 0) * face.sx, byv, yaw);
              if (!p) { node.style.display = 'none'; return; }
              node.style.display = '';
              node.setAttribute('transform',
                'translate(' + r2(p.x) + ' ' + r2(byv) + ')' +
                (mv.rot ? ' rotate(' + r2(mv.rot) + ')' : '') +
                ' scale(' + r2(p.cn) + ' 1)');
            } else if (acc.micro) {
              node.setAttribute('transform',
                'translate(' + r2(acc.dx || 0) + ' ' + r2((acc.dy || 0) + mv.dy) + ')' +
                (mv.rot ? ' rotate(' + r2(mv.rot) + ' ' + r2(acc.pivotX || C) + ' ' + r2(acc.pivotY || C) + ')' : ''));
            } else if (acc.transform) {
              node.setAttribute('transform', acc.transform);
            }
          }
        };
      }
    };

    (feats.accessories || []).forEach(function (acc) {
      var kind = acc.kind || 'path';
      var builder = ACC_BUILDERS[kind];
      if (!builder) { console.warn('[MoodMates] 未知配饰类型：' + kind); return; }
      var built = builder(acc);
      var target = (acc.layer || built.layer) === 'back' ? ensureBack() : front;
      target.appendChild(built.node);
      if (built.update) updaters.push(built.update);
    });

    /* ---------------- 腮红 ---------------- */
    var blushL = null, blushR = null, blushCfg = null;
    if (feats.blush !== false) {
      blushCfg = Object.assign(
        { dx: 34, dy: 26, rx: 11, ry: 6.5, color: palette.blush || '#F2A9A0', max: 0.85 },
        feats.blush === true ? {} : (feats.blush || {})
      );
      mid = el('g', { 'pointer-events': 'none' });
      blushL = el('ellipse', { rx: blushCfg.rx, ry: blushCfg.ry, fill: blushCfg.color, opacity: '0' });
      blushR = el('ellipse', { rx: blushCfg.rx, ry: blushCfg.ry, fill: blushCfg.color, opacity: '0' });
      mid.appendChild(blushL);
      mid.appendChild(blushR);
    }

    /* ---------------- 眉毛 ---------------- */
    var browL = null, browR = null, browCfg = null, browRing = null;
    if (feats.brows) {
      browCfg = Object.assign(
        { w: 16, h: 3.4, gap: 10, color: palette.eye, always: false, bend: 0.35 },
        feats.brows === true ? {} : feats.brows
      );
      browRing = MM.geo.lens(0, 0, { w: browCfg.w, h: browCfg.h, bend: browCfg.bend, taper: 0.7 });
      browL = el('path', { d: ringPath(browRing), fill: browCfg.color });
      browR = el('path', { d: ringPath(browRing), fill: browCfg.color });
      front.appendChild(browL);
      front.appendChild(browR);
    }

    /* ---------------- 嘴巴 ---------------- */
    var mouthNode = null, mouthCfg = null, lastMouthRing = null;
    if (feats.mouth) {
      mouthCfg = Object.assign(
        { dy: 36, color: palette.mouth || palette.eye },
        feats.mouth === true ? {} : feats.mouth
      );
      mouthNode = el('path', { fill: mouthCfg.color, stroke: 'none' });
      front.appendChild(mouthNode);
    }

    /* ---------------- 每帧 ---------------- */
    function apply(pose, sketch, yaw, now) {
      var f = pose.face || {};

      /* 腮红：跟随眼位左右对称，透明度 = blush 值 × 上限 */
      if (blushL) {
        var bv = clamp(f.blush || 0, 0, 1) * blushCfg.max * (sketch > 0.5 ? 0.4 : 1);
        if (bv < 0.01) {
          blushL.setAttribute('opacity', '0');
          blushR.setAttribute('opacity', '0');
        } else {
          /* 腮红贴在脸颊上，跟随目光 25%（比眼睛弱，形成层次） */
          var blshX = (pose.left.lookX || 0) * 0.25;
          var by = C + face.y + blushCfg.dy * face.sy + (pose.left.lookY || 0) * 0.25;
          var pL = project(-blushCfg.dx * face.sx + blshX, by, yaw);
          var pR = project(blushCfg.dx * face.sx + blshX, by, yaw);
          blushL.setAttribute('opacity', pL ? bv.toFixed(3) : '0');
          blushR.setAttribute('opacity', pR ? bv.toFixed(3) : '0');
          if (pL) blushL.setAttribute('transform', 'translate(' + r2(pL.x) + ' ' + r2(by) + ') scale(' + r2(pL.cn) + ' 1)');
          if (pR) blushR.setAttribute('transform', 'translate(' + r2(pR.x) + ' ' + r2(by) + ') scale(' + r2(pR.cn) + ' 1)');
        }
      }

      /* 眉毛：位于双眼上方，tilt 内外反向（怒），raise 抬升（惊）；
       * 联动：跟随目光 80%（与眼球同向微移），闭眼时随眼睑放松下垂 */
      if (browL) {
        var vis = clamp(Math.max(f.browVis || 0, browCfg.always ? 1 : 0), 0, 1);
        if (vis < 0.02) {
          browL.setAttribute('opacity', '0');
          browR.setAttribute('opacity', '0');
        } else {
          var bx = browCfg.dx != null ? browCfg.dx : 26;
          var openB = Math.min(pose.left.open != null ? pose.left.open : 1,
                               pose.right.open != null ? pose.right.open : 1);
          var relax = clamp(1 - openB, 0, 1) * 2.6;   /* 闭眼放松下垂 */
          var blkX = (pose.left.lookX || 0) * 0.8;
          var blkY = (pose.left.lookY || 0) * 0.8;
          var byv = C + face.y + ((browCfg.dyTop != null ? browCfg.dyTop : -30) - (f.browRaise || 0)) * face.sy + blkY + relax;
          var tilt = f.browTilt || 0;
          var qL = project(-bx * face.sx + blkX, byv, yaw);
          var qR = project(bx * face.sx + blkX, byv, yaw);
          browL.setAttribute('opacity', qL ? vis.toFixed(3) : '0');
          browR.setAttribute('opacity', qR ? vis.toFixed(3) : '0');
          if (qL) browL.setAttribute('transform',
            'translate(' + r2(qL.x) + ' ' + r2(byv) + ') rotate(' + r2(-tilt) + ') scale(' + r2(qL.cn * face.eye) + ' ' + r2(face.eye) + ')');
          if (qR) browR.setAttribute('transform',
            'translate(' + r2(qR.x) + ' ' + r2(byv) + ') rotate(' + r2(tilt) + ') scale(' + r2(qR.cn * face.eye) + ' ' + r2(face.eye) + ')');
        }
      }

      /* 嘴巴：engine 传入形变后的 mouthRing（局部坐标，中心 0,0）。
       * 线稿模式不画嘴 —— 只留轮廓与眼睑线，画面更接近手绘草稿 */
      if (mouthNode) {
        var ring = f.mouthRing;
        if (ring && ring !== lastMouthRing) {
          lastMouthRing = ring;
          mouthNode.setAttribute('d', ringPath(ring));
        }
        var my = C + face.y + (mouthCfg.dy + (f.mouthY || 0)) * face.sy;
        var pm = project((f.mouthX || 0) * face.sx, my, yaw);
        if (!pm || sketch > 0.5) {
          mouthNode.style.display = 'none';
        } else {
          mouthNode.style.display = '';
          mouthNode.setAttribute('transform',
            'translate(' + r2(pm.x) + ' ' + r2(my) + ')' +
            ' scale(' + r2((f.mouthSX || 1) * pm.cn * face.eye) + ' ' + r2((f.mouthSY || 1) * face.eye) + ')');
        }
      }

      /* 配饰联动更新 */
      for (var ui = 0; ui < updaters.length; ui++) {
        updaters[ui](pose, sketch, yaw, now);
      }
    }

    return { back: back, mid: mid, front: front, apply: apply };
  }

  MM.createFeatures = createFeatures;
})();

/* ============================================================
 * fx.js —— 特效层（发射器 + 签名动作 + 轨道粒子）
 *
 * 三类粒子：
 *   轨道粒子 orbit：低倾角轨道匀速环绕（"思考中"常驻）+ 自旋甩尾
 *   爆发粒子 burst：一次性物理粒子（速度衰减 + 微重力，"撒花"）
 *   发射粒子 emit ：签名动作专属 —— 每种皮肤有自己的发射锚点与行为脚本
 *
 * 签名动作（signature，替代千篇一律的"转圈甩粒子"）：
 *   cloudpuff 云泡：一口一扇区，远近不一；连点换方向。近泡先破、远泡后破
 *   stardust 星星爆闪：环身星芒逐个弹出闪烁；思考轨道混入旋转铅笔
 *
 * 深度处理：轨道粒子按 z 值在 front / back 两层切换，
 * 绕到身体背面自动被身体遮挡，保留 3D 环绕感。
 * ============================================================ */
(function () {
  'use strict';

  var MM = (window.MoodMates = window.MoodMates || {});
  var SVGNS = 'http://www.w3.org/2000/svg';
  var TAU = Math.PI * 2;

  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function r2(v) { return Math.round(v * 100) / 100; }

  function ringD(ring) {
    var s = 'M';
    for (var i = 0; i < ring.length; i++) {
      s += (i ? 'L' : '') + r2(ring[i][0]) + ' ' + r2(ring[i][1]);
    }
    return s + 'Z';
  }

  /* 与主体同生成器的迷你云剪影，原点居中，无高光点 */
  function cloudSilhouette() {
    if (!MM.geo || !MM.geo.buildBody) return 'M-1 0.2 A1 0.7 0 1 1 1 0.2 A1 0.7 0 1 1 -1 0.2Z';
    return ringD(MM.geo.buildBody({ type: 'cloud', r: 0.2, lobes: 7, amp: 0.08, flat: 0.12, cx: 0, cy: 0 }));
  }

  function el(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 一口一个扇区；连点轮换，点得快会铺到左右和头顶 */
  var PUFF_SECTORS = [
    { mid: -0.28, spread: 0.50 },
    { mid: -1.05, spread: 0.48 },
    { mid: -1.85, spread: 0.50 },
    { mid:  0.22, spread: 0.36 },
    { mid: -2.45, spread: 0.40 },
    { mid: -1.45, spread: 0.36 }
  ];
  var puffMem = { lastAt: 0, queue: [] };

  /* ---------------- 通用小形状 ---------------- */

  /* 四芒星 */
  var SPARK_PATH = 'M0 -1 C0.12 -0.22 0.22 -0.12 1 0 C0.22 0.12 0.12 0.22 0 1 C-0.12 0.22 -0.22 0.12 -1 0 C-0.22 -0.12 -0.12 -0.22 0 -1 Z';
  /* 五角星 */
  var STAR_PATH = (function () {
    var pts = [];
    for (var e = 0; e < 10; e++) {
      var a = -Math.PI / 2 + e * Math.PI / 5;
      var r = e % 2 === 0 ? 1 : 0.42;
      pts.push((Math.cos(a) * r).toFixed(3) + ' ' + (Math.sin(a) * r).toFixed(3));
    }
    return 'M' + pts.join('L') + 'Z';
  })();
  /* 铅笔（朝右） */
  var PENCIL_PATH = 'M-1 -0.16 L0.5 -0.16 L1 0 L0.5 0.16 L-1 0.16 Z M-1 -0.16 L-0.78 -0.16 L-0.78 0.16 L-1 0.16 Z';

  /* ---------------- 皮肤定义 ----------------
   * colors        默认配色（palette.fx 可覆盖）
   * makeOrbitNode 轨道粒子节点（单位尺寸，transform 缩放）
   * makeBurstNode 撒花粒子节点
   * orbitSpecial  可选：思考轨道中混入的特殊粒子（如铅笔），几率 chance
   * signature(api, strength)  签名动作：用 api.emit 发射行为粒子 */
  var SKINS = {

    /* ===== 云泡（云宝 · 通用）===== */
    cloudpuff: {
      colors: ['#C3D4F2', '#9FB3D6', '#F5D889', '#9A8AE8'],
      orbitSize: [2.8, 4.4],
      burstSize: [3, 5.4],
      makeOrbitNode: function (c) { return el('circle', { r: 1, fill: c, opacity: 0.9, class: 'mm-spark' }); },
      makeBurstNode: function (c) {
        return Math.random() < 0.3
          ? el('path', { d: SPARK_PATH, fill: c, class: 'mm-spark' })
          : el('circle', { r: 1, fill: c, opacity: 0.9, class: 'mm-spark' });
      },
      /* 签名即完整一幕：点击庆祝不再叠自旋 / 撒花 */
      signatureComplete: true,
      /* 云泡：一口一个扇区。先出口气最远，后出口气更近；近的先破、远的后破。
       * 连点换扇区，点得够快会铺到左右和头顶。 */
      signature: function (api, strength) {
        var full = strength >= 0.78;
        var C = api.C;
        var cloudD = cloudSilhouette();
        var mouth = api.anchors && api.anchors.mouth;
        var x0 = mouth ? mouth.x + 6 : C + 10;
        var y0 = mouth ? mouth.y : C + 32;
        var halfW = (api.anchors && api.anchors.halfW) || 104;
        var topSpan = api.anchors && api.anchors.top ? (C - api.anchors.top.y) : 104;
        var bodyR = Math.max(halfW, topSpan);
        var now = performance.now();

        function easeOut(t) { return 1 - Math.pow(1 - t, 4); }

        function emitPop(delay, x, y) {
          var ang = rand(-2.2, 0.4);
          api.emit(el('circle', { r: 1, class: 'mm-speck' }), {
            delay: delay, x: x, y: y, max: 0.24,
            step: function (p, dt, u) {
              var e = 1 - Math.pow(1 - u, 3);
              var px = x + api.state.bodyX + Math.cos(ang) * 8 * e;
              var py = y + api.state.bodyY + Math.sin(ang) * 8 * e - 6 * u;
              p.node.setAttribute('opacity', ((1 - u) * 0.55).toFixed(3));
              p.node.setAttribute('transform',
                'translate(' + px.toFixed(2) + ' ' + py.toFixed(2) + ') scale(' + (1.6 * (1 - 0.4 * u)).toFixed(2) + ')');
            }
          });
        }

        function emitBubble(opt) {
          var destX = C + Math.cos(opt.ang) * (bodyR + opt.clear);
          var destY = C + Math.sin(opt.ang) * (bodyR + opt.clear);
          var travel = opt.travel;
          var hang = opt.hang;
          var pop = 0.26;
          var life = travel + hang + pop;
          var drift = opt.drift;
          var wx = opt.wx, wy = opt.wy, wp = opt.wp;
          var g = el('g', {});
          g.appendChild(el('path', { d: cloudD, class: 'mm-bubble' }));
          g.appendChild(el('ellipse', {
            cx: -5.2, cy: -7.4, rx: 3.1, ry: 2.1, class: 'mm-sheen'
          }));
          api.emit(g, {
            delay: opt.delay, x: x0, y: y0, max: life,
            step: function (p, dt, u) {
              var t = u * life;
              var x, y, s, op;
              if (t < travel) {
                var k = easeOut(t / travel);
                x = x0 + (destX - x0) * k;
                y = y0 + (destY - y0) * k;
                var grow = Math.min(1, t / 0.1);
                s = 0.18 + 0.82 * grow;
                op = 0.82 * grow;
              } else if (t < travel + hang) {
                var h = (t - travel) / hang;
                x = destX + Math.sin(t * wx + wp) * 2.4;
                y = destY - h * drift + Math.sin(t * wy + wp) * 1.6;
                s = 1 + 0.04 * Math.sin(t * 7 + wp);
                op = 0.82;
              } else {
                var pk = (t - travel - hang) / pop;
                x = destX + Math.sin((travel + hang) * wx + wp) * 2.4;
                y = destY - drift + Math.sin((travel + hang) * wy + wp) * 1.6;
                s = pk < 0.34 ? 1 + 0.4 * (pk / 0.34) : 1.4 * Math.max(0, 1 - (pk - 0.34) / 0.66);
                op = pk < 0.22 ? 0.82 : 0.82 * Math.max(0, 1 - (pk - 0.22) / 0.78);
              }
              x += api.state.bodyX;
              y += api.state.bodyY;
              p.node.setAttribute('opacity', op.toFixed(3));
              p.node.setAttribute('transform',
                'translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') scale(' + (opt.size * s).toFixed(3) + ')');
            }
          });
          emitPop(opt.delay + (travel + hang) * 1000, destX, destY - drift * 0.65);
        }

        /* 一口气息：先出的最远、后出的更近；破泡反过来，近的先破 */
        function emitBreath(sec, n) {
          var slots = n >= 4
            ? ['far', 'mid', 'far', 'near']
            : n === 3 ? ['far', 'mid', 'near'] : ['mid', 'near'];
          var delays = n >= 4
            ? [0, rand(42, 78), rand(105, 160), rand(180, 255)]
            : n === 3 ? [0, rand(50, 90), rand(130, 200)] : [0, rand(60, 110)];
          for (var i = 0; i < n; i++) {
            var kind = slots[i];
            var clear, travel, hang, size;
            if (kind === 'far') {
              clear = rand(52, 72);
              travel = rand(0.48, 0.62);
              hang = rand(0.68, 0.92);
              size = rand(0.42, 0.54);
            } else if (kind === 'mid') {
              clear = rand(32, 46);
              travel = rand(0.30, 0.40);
              hang = rand(0.42, 0.60);
              size = rand(0.50, 0.62);
            } else {
              clear = rand(18, 28);
              travel = rand(0.18, 0.26);
              hang = rand(0.22, 0.36);
              size = rand(0.58, 0.72);
            }
            var bias = (i / Math.max(1, n - 1) - 0.5) * 1.15;
            emitBubble({
              delay: delays[i],
              ang: sec.mid + bias * sec.spread + rand(-0.08, 0.08),
              clear: clear,
              travel: travel,
              hang: hang,
              size: size,
              drift: kind === 'far' ? rand(10, 18) : kind === 'mid' ? rand(6, 11) : rand(3, 7),
              wx: rand(4.2, 7.5),
              wy: rand(3.4, 6.2),
              wp: rand(0, 6.3)
            });
          }
        }

        if (!full) {
          emitBreath(PUFF_SECTORS[(Math.random() * 3) | 0], 2);
          return true;
        }

        if (now - puffMem.lastAt > 1200) puffMem.queue = [];
        puffMem.lastAt = now;
        if (!puffMem.queue.length) {
          puffMem.queue = [PUFF_SECTORS[0]].concat(shuffle(PUFF_SECTORS.slice(1)));
        }
        emitBreath(puffMem.queue.shift(), 4);
        return true;
      }
    },

    /* ===== 星尘（亮亮 · 教育）===== */
    stardust: {
      colors: ['#F5B840', '#F7D07A', '#F09A4E', '#FBE3A8'],
      orbitSize: [3.4, 5.6],
      burstSize: [3, 6.4],
      makeOrbitNode: function (c) { return el('path', { d: SPARK_PATH, fill: c, class: 'mm-spark' }); },
      makeBurstNode: function (c) {
        return Math.random() < 0.4
          ? el('path', { d: STAR_PATH, fill: c, class: 'mm-spark' })
          : el('path', { d: SPARK_PATH, fill: c, class: 'mm-spark' });
      },
      /* 思考轨道里偶尔混入一支旋转铅笔 */
      orbitSpecial: {
        chance: 0.3,
        make: function (c) {
          var g = el('g', {});
          g.appendChild(el('path', { d: PENCIL_PATH, fill: '#E8A64C' }));
          g.appendChild(el('path', { d: 'M0.5 -0.16 L1 0 L0.5 0.16 Z', fill: '#5C4632' }));
          return g;
        },
        size: [5, 6.5]
      },
      signature: function (api, strength) {
        var n = Math.round(10 * strength);
        for (var i = 0; i < n; i++) {
          (function (i) {
            var ang = TAU * i / n + rand(-0.2, 0.2);
            var rr = rand(96, 126);
            var x0 = api.C + api.state.bodyX + Math.cos(ang) * rr;
            var y0 = api.C + api.state.bodyY + Math.sin(ang) * rr * 0.92;
            var size = rand(3.4, 6.2);
            var spin = rand(-140, 140);
            var big = Math.random() < 0.45;
            api.emit(el('path', { d: big ? STAR_PATH : SPARK_PATH, fill: api.pick(), class: 'mm-spark' }), {
              delay: i * 55,
              x: x0, y: y0,
              max: rand(0.75, 1.15),
              step: function (p, dt, u) {
                p.y -= 14 * dt;
                /* 弹入过冲 → 闪烁 → 收缩消失 */
                var s = u < 0.22 ? size * (u / 0.22) * 1.25 : size * (1 - 0.35 * (u - 0.22) / 0.78);
                var tw = 0.75 + 0.25 * Math.sin(u * 26 + i);
                p.node.setAttribute('opacity', ((1 - Math.pow(u, 2.2)) * tw).toFixed(3));
                p.node.setAttribute('transform',
                  'translate(' + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ') rotate(' + (spin * u).toFixed(1) + ') scale(' + s.toFixed(3) + ')');
              }
            });
          })(i);
        }
        return true;
      }
    }
  };


  function createFx(ctx) {
    var C = ctx.C;
    var skin = SKINS[ctx.skin] || SKINS.cloudpuff;
    var colors = (ctx.palette && ctx.palette.fx) || skin.colors;
    var back = ctx.back, front = ctx.front;
    var anchors = ctx.anchors || {
      mouth: { x: C, y: C + 36 }, top: { x: C, y: C - 104 },
      bottom: { x: C, y: C + 104 }, halfW: 104
    };

    var orbiters = [];    /* 环绕 / 自旋粒子 */
    var pieces = [];      /* 撒花粒子 */
    var emits = [];       /* 签名动作发射粒子 */
    var wasFast = false;
    var spawnAt = [];
    var spinPlane = null;
    var orbitNextAt = 0;
    var lastState = { yaw: 0, dYaw: 0, vel: 0, orbitWant: false, bodyX: 0, bodyY: 0 };

    function pick(arr) { return (arr || colors)[(Math.random() * (arr || colors).length) | 0]; }

    function orbitPoint(o, lam) {
      var hx = o.rad * Math.sin(lam);
      var hy = -o.rad * Math.cos(lam) * Math.sin(o.tilt);
      var ca = Math.cos(o.roll), sa = Math.sin(o.roll);
      return {
        x: C + hx * ca - hy * sa,
        y: C + hx * sa + hy * ca,
        z: Math.cos(lam) * Math.cos(o.tilt),
        l: lam
      };
    }

    /** mode: 'spin'（一次性甩出）| 'orbit'（常驻环绕） */
    function spawnOrbiter(mode, cfg) {
      if (orbiters.length > 26) return;
      var special = mode === 'orbit' && skin.orbitSpecial && Math.random() < skin.orbitSpecial.chance;
      var node = special ? skin.orbitSpecial.make(pick()) : skin.makeOrbitNode(pick());
      front.appendChild(node);
      var sz = special ? skin.orbitSpecial.size : skin.orbitSize;
      orbiters.push(Object.assign({
        node: node, inFront: true, mode: mode,
        life: 0, max: mode === 'spin' ? rand(1.1, 2) : Infinity,
        ret: 0,
        size: rand(sz[0], sz[1]),
        rotSpd: special ? rand(40, 80) : rand(-160, 160),
        rot: rand(0, 360)
      }, cfg));
    }

    function spawnSpinGroup(yaw, dir) {
      spinPlane = {
        tilt: rand(0.18, 0.5),
        roll: rand(-0.7, 0.7)
      };
      var n = Math.round(rand(5, 8));
      spawnAt = [];
      for (var q = 0; q < n; q++) spawnAt.push({ at: performance.now() + q * rand(45, 90), dir: dir, yaw: yaw });
    }

    function releaseSpinOne(item, yaw) {
      spawnOrbiter('spin', {
        o: {
          lam: yaw - rand(0, 0.2) * item.dir,
          lamVel: item.dir * rand(2.2, 4.2),
          tilt: spinPlane.tilt + rand(-0.06, 0.06),
          roll: spinPlane.roll + rand(-0.08, 0.08),
          rad: rand(118, 142),
          radVel: rand(14, 40)
        }
      });
    }

    function removeOrbiter(idx) {
      orbiters[idx].node.remove();
      orbiters.splice(idx, 1);
    }

    /* ---- 撒花 ---- */
    function burst(count) {
      count = count || 20;
      for (var i = 0; i < count && pieces.length < 56; i++) {
        var ang = (i / count) * TAU + rand(-0.35, 0.35);
        var spd = rand(170, 360);
        var node = skin.makeBurstNode(pick());
        front.appendChild(node);
        pieces.push({
          x: C + Math.cos(ang) * rand(96, 118),
          y: C + Math.sin(ang) * rand(96, 118),
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - rand(20, 75),
          life: 0, max: rand(0.45, 0.9),
          r: rand(skin.burstSize[0], skin.burstSize[1]),
          rot: rand(0, 360), vr: rand(-260, 260),
          el: node
        });
      }
    }

    /* ---- 签名动作发射 ---- */
    var emitApi = {
      C: C,
      defs: ctx.defs,
      anchors: anchors,
      state: lastState,
      pick: function () { return pick(); },
      orbitPoint: function (o, lam) { return orbitPoint(o, lam); },
      emit: function (node, cfg) {
        if (emits.length > 80) { return; }
        node.setAttribute('opacity', '0');
        front.appendChild(node);
        emits.push({
          node: node,
          x: cfg.x, y: cfg.y,
          born: performance.now() + (cfg.delay || 0),
          life: 0, max: cfg.max || 1,
          step: cfg.step,
          cleanup: cfg.cleanup
        });
      }
    };

    function signature(strength) {
      if (!skin.signature) return false;
      return skin.signature(emitApi, strength || 1) === true;
    }

    /* ---- 每帧 ---- */
    function update(dt, now, state) {
      lastState.yaw = state.yaw;
      lastState.dYaw = state.dYaw;
      lastState.vel = state.vel;
      lastState.orbitWant = state.orbitWant;
      lastState.bodyX = state.bodyX || 0;
      lastState.bodyY = state.bodyY || 0;

      var vel = state.vel;
      var fast = Math.abs(vel) >= 0.9;
      var dir = vel >= 0 ? 1 : -1;

      /* 自旋达速：起一组错峰粒子 */
      if (fast && !wasFast) spawnSpinGroup(state.yaw, dir);
      if (!fast) spawnAt.length = 0;
      wasFast = fast;
      if (Math.abs(vel) >= 5) {
        while (spawnAt.length && now >= spawnAt[0].at) {
          releaseSpinOne(spawnAt.shift(), state.yaw);
        }
      }

      /* 常驻环绕补给：错峰起 5 枚 */
      if (state.orbitWant && now >= orbitNextAt) {
        var orbitCount = 0;
        for (var oc = 0; oc < orbiters.length; oc++) if (orbiters[oc].mode === 'orbit') orbitCount++;
        if (orbitCount < 5) {
          spawnOrbiter('orbit', {
            o: {
              lam: rand(0, TAU),
              lamVel: (Math.random() < 0.5 ? -1 : 1) * rand(1.5, 2.2),
              tilt: rand(0.1, 0.24),
              roll: rand(-0.12, 0.12),
              rad: rand(122, 146),
              radVel: 0
            }
          });
        }
        orbitNextAt = now + 420;
      }

      /* 轨道粒子推进 */
      for (var ti = orbiters.length - 1; ti >= 0; ti--) {
        var ob = orbiters[ti];
        ob.life += dt;
        var retreat = ob.mode === 'orbit' ? !state.orbitWant : ob.life > ob.max;
        ob.ret = clamp(ob.ret + (retreat ? dt / 0.4 : -dt / 0.3), 0, 1);
        if (retreat && ob.ret >= 1) { removeOrbiter(ti); continue; }

        var o = ob.o;
        o.lam += o.lamVel * dt + (ob.mode === 'spin' ? state.dYaw * 0.55 : state.dYaw * 0.2);
        if (ob.mode === 'spin') {
          o.lamVel *= Math.exp(-1.1 * dt);
          o.rad += o.radVel * dt;
          o.radVel *= Math.exp(-1.6 * dt);
        }
        ob.rot += ob.rotSpd * dt;

        var p = orbitPoint(o, o.lam);
        /* 深度换层：z < 0 转入背层被身体遮挡 */
        var wantFront = p.z >= 0;
        if (wantFront !== ob.inFront) {
          (wantFront ? front : back).appendChild(ob.node);
          ob.inFront = wantFront;
        }
        var grow = Math.min(ob.life / 0.3, 1);
        grow = grow * grow * (3 - 2 * grow);
        var depth = 0.68 + 0.32 * clamp(p.z, 0, 1);
        var s = ob.size * depth * grow * (1 - 0.8 * ob.ret * ob.ret);
        if (s < 0.25) { ob.node.setAttribute('opacity', '0'); continue; }
        ob.node.setAttribute('opacity', ((1 - ob.ret) * (0.55 + 0.45 * depth)).toFixed(3));
        ob.node.setAttribute('transform',
          'translate(' + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ')' +
          ' rotate(' + ob.rot.toFixed(1) + ')' +
          ' scale(' + s.toFixed(3) + ')');
      }

      /* 撒花推进：速度衰减 + 微重力 */
      for (var ci = pieces.length - 1; ci >= 0; ci--) {
        var pc = pieces[ci];
        pc.life += dt;
        if (pc.life >= pc.max) {
          pc.el.remove();
          pieces.splice(ci, 1);
          continue;
        }
        pc.x += pc.vx * dt;
        pc.y += pc.vy * dt;
        var drag = Math.pow(0.94, 60 * dt);
        pc.vx *= drag;
        pc.vy = pc.vy * drag + 40 * dt;
        pc.rot += pc.vr * dt;
        var u = pc.life / pc.max;
        var fd = u < 0.1 ? u / 0.1 : Math.pow(1 - (u - 0.1) / 0.9, 1.7);
        var sz = Math.max(pc.r * (1 - 0.4 * u), 0.4);
        pc.el.setAttribute('opacity', fd.toFixed(3));
        pc.el.setAttribute('transform',
          'translate(' + pc.x.toFixed(2) + ' ' + pc.y.toFixed(2) + ') rotate(' + pc.rot.toFixed(1) + ') scale(' + sz.toFixed(3) + ')');
      }

      /* 签名发射粒子推进 */
      for (var ei = emits.length - 1; ei >= 0; ei--) {
        var em = emits[ei];
        if (now < em.born) continue;
        em.life += dt;
        if (em.life >= em.max) {
          em.node.remove();
          if (em.cleanup) em.cleanup();
          emits.splice(ei, 1);
          continue;
        }
        em.step(em, dt, em.life / em.max, em.life);
      }
    }

    function destroy() {
      orbiters.forEach(function (o) { o.node.remove(); });
      pieces.forEach(function (p) { p.el.remove(); });
      emits.forEach(function (e) { e.node.remove(); if (e.cleanup) e.cleanup(); });
      orbiters.length = 0;
      pieces.length = 0;
      emits.length = 0;
    }

    return { update: update, burst: burst, signature: signature, destroy: destroy,
      signatureMouth: skin.signatureMouth || null,
      signatureMouthMs: skin.signatureMouthMs || 0,
      signatureComplete: !!skin.signatureComplete };
  }

  createFx.registerSkin = function (name, def) { SKINS[name] = def; };
  createFx.skins = function () { return Object.keys(SKINS); };

  MM.createFx = createFx;
})();

/* ============================================================
 * emotions.js —— 表情数据基座（纯数据，不含任何 DOM / 逻辑代码）
 *
 * 全角色共享的表情编排。与具体角色解耦的三个语义层：
 *   pool   眼形槽位名（geometry.js EYE_SLOTS），角色用自己的眼环族实现
 *   mouth  嘴形槽位名（smile/grin/o/flat/frown/wavy/pout/open/dot）
 *   颜色   '@token' 查角色色板：@base 常态 @dim 低落 @soft 柔和
 *          @blush 泛红 @angry 涨红 @alert 警示 @off 关机
 *
 * ID 分段规则（十位 = 分组前缀，组间空号为扩展预留，编号即对外契约）：
 *   00-09 生命周期 · 10-29 情绪反应 · 30-49 代理工作状态 · 50+ 自定义
 *
 * 配置字段：
 *   pool / poolMs / poolSpeed   眼形池与轮换节奏
 *   blinkMs                     眨眼间隔（null = 不眨）
 *   openness                    常驻开合度（睡眠 0.08、疲惫 0.55）
 *   antics                      待机随机小动作（自旋 / 弹跳）
 *   mouth                       嘴形槽位
 *   face                        { blush 0~1, browVis, browTilt, browRaise,
 *                                 mouthX/Y/SX/SY } 五官姿态
 *   body.spinFx / confetti      进入表情的一次性事件：自旋甩粒子 / 撒花
 *   body.zzz / orbit            睡眠字母粒子 / 常驻环绕粒子
 *   sequence                    关键帧序列，settle: 'base'|'hold'|{ next }
 *   en                          英文文案 { name, desc }
 * ============================================================ */

window.EMOTION_GROUPS = [
  { key: 'life',    name: '生命周期',     en: 'Lifecycle' },
  { key: 'emotion', name: '情绪反应',     en: 'Emotions' },
  { key: 'agent',   name: '代理工作状态', en: 'Agent States' },
  { key: 'custom',  name: '自定义',       en: 'Custom' }
];

window.EMOTION_SEED = [

  /* ==================== 1）生命周期（8 个） ==================== */

  {
    id: '00', name: '睡眠', group: 'life',
    desc: '闭眼成细线，右上角 zzz 缓缓飘起，头微垂，只剩缓慢呼吸',
    en: { name: 'Sleeping', desc: 'Eyes closed to thin lines, zzz drifting up at the top right, only a slow breath remains' },
    transition: 900,
    gaze: false,
    pool: ['closed', 'closed2', 'sleepy'], poolMs: [6000, 10000], blinkMs: null, openness: 0.08,
    mouth: 'flat',
    body: { y: 4, rotate: -2, breathe: 0.018, color: '@dim', zzz: 1 },
    eyes: { both: { y: 4, lookY: 2 } },
    anims: [
      { target: 'eyes', prop: 'y', type: 'sine', amp: 1.2, period: 3600 }
    ]
  },
  {
    id: '01', name: '唤醒', group: 'life',
    desc: '从闭合眼缓缓睁开，先揉眼似的眨两下，随后进入待机',
    en: { name: 'Waking', desc: 'Eyes slowly crack open with a couple of groggy blinks, then settles into idle' },
    transition: 320,
    pool: ['closed'], poolMs: [800, 800], blinkMs: null,
    mouth: 'o',
    sequence: {
      settle: { next: '02' },
      frames: [
        { at: 0,    eyes: { both: { open: 0.1, y: 4 } } },
        { at: 420,  eyes: { left: { open: 0.55, y: 2 }, right: { open: 0.12, y: 4 } } },
        { at: 820,  eyes: { both: { open: 0.3, y: 3 } } },
        { at: 1400, eyes: { both: { open: 1, scaleX: 1.12, scaleY: 1.12, y: -2 } } },
        { at: 2100, eyes: { both: { open: 1, y: 0 } } }
      ]
    }
  },
  {
    id: '02', name: '待机放空', group: 'life',
    desc: '左看看、右看看，目光在两侧各停留片刻，偶尔自旋甩粒子 / 弹跳',
    en: { name: 'Idle', desc: 'Glances left, glances right, lingering on each side; an occasional spin or bounce' },
    transition: 700,
    pool: ['calm', 'calm2'], poolMs: [9000, 16000], blinkMs: [6000, 14000], antics: true,
    mouth: 'smile',
    body: { breathe: 0.012 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'glance', amp: 10, period: 4800 },
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 2, period: 4100, phase: 1.1 }
    ]
  },
  {
    id: '03', name: '好奇', group: 'life',
    desc: '圆睁 / 平静 / 扫视眼形快速轮换，头微倾，嘴巴张成小 o',
    en: { name: 'Curious', desc: 'Wide, calm and scanning eye shapes rotate quickly, head tilted, mouth a small o' },
    transition: 420,
    pool: ['wide', 'wide2', 'calm', 'scan'], poolMs: [1800, 3200], blinkMs: [2500, 5500],
    mouth: 'o',
    body: { rotate: 4, breathe: 0.01 },
    eyes: { both: { lookY: -1 } },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 2.4, period: 2800 }
    ]
  },
  {
    id: '04', name: '发呆', group: 'life',
    desc: '半闭眼慢轮换，双眼各望各的，嘴巴缩成小点，偶尔弹跳提神',
    en: { name: 'Spacing Out', desc: 'Half-closed eyes rotate slowly, each wandering its own way, mouth a tiny dot; a bounce now and then' },
    transition: 800,
    pool: ['sleepy', 'closed2', 'calm'], poolMs: [3500, 6000], blinkMs: [4000, 8000], antics: true,
    mouth: 'dot',
    body: { rotate: -3, breathe: 0.008 },
    eyes: {
      left:  { lookX: -4, lookY: 2 },
      right: { lookX: 5,  lookY: -1 }
    },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 3, period: 6800 }
    ]
  },
  {
    id: '05', name: '加载苏醒', group: 'life',
    desc: '双眼缓慢交替亮起，像系统正在逐项初始化',
    en: { name: 'Booting', desc: 'Eyes light up in slow alternation, like a system initializing step by step' },
    transition: 480,
    pool: ['calm', 'calm2'], poolMs: [6000, 10000], blinkMs: null,
    mouth: 'flat',
    anims: [
      { target: 'left',  prop: 'open', type: 'blink', interval: 1600, dur: 700 },
      { target: 'right', prop: 'open', type: 'blink', interval: 1600, dur: 700, phaseMs: 800 },
      { target: 'eyes',  prop: 'scale', type: 'pulse', amp: 0.04, period: 1600 }
    ]
  },
  {
    id: '06', name: '休眠', group: 'life',
    desc: '困倦眼形 + 半开合，几乎静止，只剩极弱的呼吸起伏',
    en: { name: 'Dormant', desc: 'Drowsy eyes at half openness, nearly still, only the faintest breathing' },
    transition: 1200,
    gaze: false,
    pool: ['sleepy', 'closed2', 'closed'], poolMs: [4000, 8000], blinkMs: null, openness: 0.4,
    mouth: 'flat',
    body: { y: 6, scale: 0.98, rotate: -1, breathe: 0.005, color: '@dim' },
    eyes: { both: { y: 5 } }
  },
  {
    id: '07', name: '抖动唤醒', group: 'life',
    desc: '整体轻颤，闭合的眼交错睁开，随后进入待机',
    en: { name: 'Shake Awake', desc: 'The whole body trembles as the eyes stagger open, then settles into idle' },
    transition: 220,
    pool: ['closed'], poolMs: [800, 800], blinkMs: null,
    mouth: 'o',
    body: { breathe: 0.004 },
    anims: [
      { target: 'body', prop: 'x', type: 'jitter', amp: 4.5, speed: 10, decay: 1600 },
      { target: 'body', prop: 'rotate', type: 'jitter', amp: 3, speed: 8, decay: 1600 }
    ],
    sequence: {
      settle: { next: '02' },
      frames: [
        { at: 0,    eyes: { both: { open: 0.1 } } },
        { at: 380,  eyes: { left: { open: 0.4 }, right: { open: 0.12 } } },
        { at: 900,  eyes: { both: { open: 0.7, y: 1 } } },
        { at: 1600, eyes: { both: { open: 1, scaleX: 1.08, scaleY: 1.08, y: -1 } } }
      ]
    }
  },

  /* ==================== 2）情绪反应（12 个） ==================== */

  {
    id: '10', name: '开心', group: 'emotion',
    desc: '笑眼轮换 + 咧嘴笑，身体轻快起伏，偶尔自旋甩出一圈闪光粒子',
    en: { name: 'Happy', desc: 'Smiling eyes with a wide grin, body bouncing lightly; an occasional sparkling spin' },
    transition: 380,
    pool: ['happy', 'happy2'], poolMs: [2500, 4500], blinkMs: [2500, 5000], antics: true,
    mouth: 'grin',
    body: { y: -3, breathe: 0.014, color: '@soft' },
    eyes: { both: { y: -3 } },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'glance', amp: 6, period: 3000 },
      { target: 'body', prop: 'y', type: 'sine', amp: 2.2, period: 1400 }
    ]
  },
  {
    id: '11', name: '疑惑', group: 'emotion',
    desc: '斜眼轮换，头微倾，一眼放大一眼收小，嘴角歪成波浪',
    en: { name: 'Puzzled', desc: 'Skeptical eyes, head atilt, one eye enlarged and the other shrunk, mouth a wobbly wave' },
    transition: 420,
    pool: ['squint', 'squint2', 'calm'], poolMs: [2200, 3800], blinkMs: [2800, 5500],
    mouth: 'wavy',
    body: { rotate: -8, breathe: 0.008 },
    eyes: {
      left:  { y: -4, scaleX: 1.1, scaleY: 1.1 },
      right: { y: 3,  scaleX: 0.9, scaleY: 0.9, lookX: 3 }
    },
    anims: [
      { target: 'body', prop: 'rotate', type: 'sine', amp: 1.4, period: 3200 }
    ]
  },
  {
    id: '12', name: '失落', group: 'emotion',
    desc: '困倦眼形慢轮换，眼睛下沉目光低垂，嘴角向下撇',
    en: { name: 'Down', desc: 'Drowsy eyes rotate slowly, sinking with a downcast gaze, mouth turned down' },
    transition: 820,
    pool: ['sad', 'sleepy', 'closed2'], poolMs: [4000, 7000], blinkMs: [4000, 8000],
    mouth: 'frown',
    body: { y: 5, rotate: -4, breathe: 0.007, color: '@dim' },
    eyes: { both: { y: 8, scaleX: 0.88, scaleY: 0.88, lookY: 4 } },
    face: { browVis: 1, browTilt: 10, browRaise: 2 },
    anims: [
      { target: 'eyes', prop: 'y', type: 'sine', amp: 1.6, period: 3600 }
    ]
  },
  {
    id: '13', name: '惊讶', group: 'emotion',
    desc: '双眼瞬间放大再回稳，眉毛高高挑起，嘴巴张成 O 形',
    en: { name: 'Surprised', desc: 'Eyes pop wide in an instant then steady, brows shooting up, mouth an open O' },
    transition: 180,
    pool: ['wide', 'wide2'], poolMs: [2500, 4000], blinkMs: [1800, 3500],
    mouth: 'open',
    body: { y: -4, scale: 1.03, breathe: 0.006 },
    eyes: { both: { scaleX: 1.14, scaleY: 1.14, y: -2, lookY: -2 } },
    face: { browVis: 1, browRaise: 7 },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0,   eyes: { both: { scaleX: 0.92, scaleY: 0.92 } }, face: { browVis: 0 } },
        { at: 150, eyes: { both: { scaleX: 1.45, scaleY: 1.45, y: -4 } }, body: { y: -7, scale: 1.05 }, face: { browVis: 1, browRaise: 10, mouthSY: 1.3 } },
        { at: 420, eyes: { both: { scaleX: 1.22, scaleY: 1.22, y: -3 } }, face: { browVis: 1, browRaise: 7 } }
      ]
    }
  },
  {
    id: '14', name: '害羞', group: 'emotion',
    desc: '目光躲向一侧，腮红在一秒多里慢慢浮现，嘴巴抿成小嘟',
    en: { name: 'Shy', desc: 'Gaze slips off to one side as the cheeks slowly blush over a second, lips in a tiny pout' },
    transition: 560,
    pool: ['shy', 'calm', 'closed2'], poolMs: [3000, 5500], blinkMs: [3000, 6000],
    mouth: 'pout',
    /* base = 序列终态，保证静态缩略图与最终观感一致 */
    body: { rotate: 6, breathe: 0.012, color: '@blush' },
    eyes: { both: { y: 4, lookX: 8, lookY: 3 } },
    face: { blush: 1 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 2, period: 2600 }
    ],
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0,    body: { color: '@base' }, face: { blush: 0 } },
        { at: 1500, body: { color: '@blush' }, face: { blush: 1 } }
      ]
    }
  },
  {
    id: '15', name: '疲惫', group: 'emotion',
    desc: '眼皮沉重半睁（低开合度 + 困倦眼形），目光下沉',
    en: { name: 'Tired', desc: 'Heavy eyelids at half openness with drowsy eyes, gaze sinking low' },
    transition: 900,
    pool: ['sleepy', 'closed2', 'closed'], poolMs: [4000, 8000], blinkMs: null, openness: 0.55,
    mouth: 'flat',
    body: { y: 4, rotate: -3, breathe: 0.016, color: '@dim' },
    eyes: { both: { y: 5, lookY: 3 } },
    anims: [
      { target: 'eyes', prop: 'open', type: 'sine', amp: 0.06, period: 3400 }
    ]
  },
  {
    id: '16', name: '专注', group: 'emotion',
    desc: '专注眼形轮换，双眼微微内聚，身体几乎不动',
    en: { name: 'Focused', desc: 'Focused eye shapes rotate, eyes converge slightly, body almost motionless' },
    transition: 320,
    pool: ['angry2', 'squint', 'listen'], poolMs: [1800, 3200], blinkMs: [2800, 5500],
    mouth: 'flat',
    body: { breathe: 0.004 },
    eyes: {
      left:  { x: 4 },
      right: { x: -4 }
    }
  },
  {
    id: '17', name: '慌张', group: 'emotion',
    desc: '圆睁眼形高频轮换，目光乱晃，嘴巴扭成波浪，整体细颤',
    en: { name: 'Panicked', desc: 'Wide eyes rotate at high frequency, gaze darting about, mouth a wobble, the whole body quivering' },
    transition: 200,
    pool: ['wide', 'wide2'], poolMs: [900, 1800], blinkMs: [1200, 3000],
    mouth: 'wavy',
    body: { breathe: 0.006 },
    face: { browVis: 1, browRaise: 5, browTilt: 8 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'jitter', amp: 6, speed: 11 },
      { target: 'eyes', prop: 'lookY', type: 'jitter', amp: 4, speed: 9 },
      { target: 'body', prop: 'x', type: 'jitter', amp: 1.6, speed: 8 }
    ]
  },
  {
    id: '18', name: '无奈', group: 'emotion',
    desc: '斜眼轮换，头一歪，双眼翻向斜上方，嘴角一条平线',
    en: { name: 'Resigned', desc: 'Sidelong eyes, head cocked, both eyes rolling up and away, mouth a flat line' },
    transition: 560,
    pool: ['squint', 'squint2', 'sad'], poolMs: [2600, 4500], blinkMs: [4500, 8000],
    mouth: 'flat',
    body: { rotate: 10, y: 2, breathe: 0.01 },
    eyes: { both: { lookX: 7, lookY: -8 } },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 1.6, period: 3000 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.2, period: 3000 }
    ]
  },
  {
    id: '19', name: '满意', group: 'emotion',
    desc: '目光正视前方，双眼有节奏地上下点动，如同点头认可',
    en: { name: 'Satisfied', desc: 'Gazing straight ahead while the eyes nod up and down in steady approval' },
    transition: 580,
    pool: ['scan', 'calm', 'happy'], poolMs: [3500, 6000], blinkMs: [3500, 7000], antics: true,
    mouth: 'smile',
    body: { breathe: 0.012, color: '@soft' },
    anims: [
      { target: 'eyes', prop: 'y', type: 'sine', amp: 5, period: 1050 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.6, period: 1050, phase: 0.6 }
    ]
  },
  {
    id: '20', name: '困惑', group: 'emotion',
    desc: '两眼大小不一，斜眼轮换，注视方向对不齐',
    en: { name: 'Confused', desc: 'Mismatched eye sizes and sidelong shapes, the two gazes never quite aligning' },
    transition: 480,
    pool: ['squint', 'squint2', 'calm'], poolMs: [2200, 3800], blinkMs: [2800, 5500],
    mouth: 'wavy',
    body: { rotate: -5, breathe: 0.008 },
    eyes: {
      left:  { scaleX: 1.16, scaleY: 1.16, y: -3, lookX: -3 },
      right: { scaleX: 0.8,  scaleY: 0.8,  y: 4,  lookX: 5 }
    },
    anims: [
      { target: 'left',  prop: 'lookX', type: 'sine', amp: 2.5, period: 3200 },
      { target: 'right', prop: 'lookX', type: 'sine', amp: 2.5, period: 3200, phase: 1.6 }
    ]
  },
  {
    id: '21', name: '生气', group: 'emotion',
    desc: '怒目圆睁眉毛倒竖，脸色在 0.25s 内迅速涨红并保持，身体细微发抖',
    en: { name: 'Angry', desc: 'Glaring eyes under knitted brows; the face flushes within a quarter second and stays, body trembling' },
    transition: 260,
    pool: ['angry', 'angry2'], poolMs: [2200, 3800], blinkMs: [3500, 7000],
    mouth: 'frown',
    /* base = 序列终态红 */
    body: { y: 1, breathe: 0.004, color: '@angry' },
    face: { browVis: 1, browTilt: -14, browRaise: -2 },
    anims: [
      { target: 'body', prop: 'x', type: 'jitter', amp: 1.1, speed: 7 }
    ],
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0,   body: { color: '@base' }, face: { browVis: 0.4, browTilt: -6 } },
        { at: 250, body: { color: '@angry' }, face: { browVis: 1, browTilt: -14 } }
      ]
    }
  },

  /* ==================== 3）代理工作状态（12 个） ==================== */

  {
    id: '30', name: '思考中', group: 'agent',
    desc: '思考眼形轮换，目光在上方巡回，一群光点在头顶缓缓环绕',
    en: { name: 'Thinking', desc: 'Thinking eyes rotate, gaze patrolling upward, a ring of glow motes orbiting the head' },
    transition: 480,
    pool: ['calm2', 'squint', 'listen', 'scan2'], poolMs: [2000, 3600], blinkMs: [3500, 7000],
    mouth: 'dot',
    body: { rotate: -3, breathe: 0.01, orbit: 1 },
    eyes: { both: { lookY: -6, y: -2 } },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 9, period: 2600 }
    ]
  },
  {
    id: '31', name: '接收任务', group: 'agent',
    desc: '轻轻眨一下并放大，像点头确认收到',
    en: { name: 'Receiving', desc: 'A quick blink and slight enlargement, like a nod of acknowledgement' },
    transition: 220,
    pool: ['happy', 'calm', 'calm2'], poolMs: [4000, 8000], blinkMs: null,
    mouth: 'smile',
    body: { breathe: 0.008 },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0 },
        { at: 100, eyes: { both: { open: 0.1 } } },
        { at: 280, eyes: { both: { open: 1, scaleX: 1.12, scaleY: 1.12, y: -2 } }, body: { y: -3 } },
        { at: 700, eyes: { both: { open: 1 } } }
      ]
    }
  },
  {
    id: '32', name: '处理中忙碌', group: 'agent',
    desc: '专注眼形轮换，目光小幅循环往复',
    en: { name: 'Busy', desc: 'Focused eyes rotate while the gaze loops in tight little circuits' },
    transition: 360,
    pool: ['angry2', 'squint', 'listen'], poolMs: [1800, 3200], blinkMs: [2800, 5500],
    mouth: 'flat',
    body: { breathe: 0.008 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 6, period: 1200 },
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 4, period: 900, phase: 0.8 }
    ]
  },
  {
    id: '33', name: '任务完成', group: 'agent',
    desc: '笑眼咧嘴 + 自旋甩出一圈粒子 + 撒花庆祝',
    en: { name: 'Done', desc: 'Smiling eyes and a grin, a celebratory particle spin and a burst of confetti' },
    transition: 240,
    pool: ['happy', 'happy2', 'calm'], poolMs: [1400, 2600], blinkMs: [2200, 4500],
    mouth: 'grin',
    body: { spinFx: 1, confetti: 0.95 },
    eyes: { both: { y: -3 } },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0,   body: { y: 0 } },
        { at: 300, eyes: { both: { scaleX: 1.1, scaleY: 1.1, y: -5 } }, body: { y: -6 } },
        { at: 700, eyes: { both: { scaleX: 1.05, scaleY: 1.05, y: -4 } }, body: { y: -2 } },
        { at: 1100, body: { y: 0 } }
      ]
    }
  },
  {
    id: '34', name: '出错', group: 'agent',
    desc: '圆睁双眼，脸色急促闪动两轮后定格在警示色，眉毛拧紧',
    en: { name: 'Error', desc: 'Wide eyes as the face flashes twice and settles on alarm color, brows knotted' },
    transition: 220,
    pool: ['wide', 'wide2'], poolMs: [2000, 3600], blinkMs: null,
    mouth: 'wavy',
    body: { rotate: -6, color: '@alert' },
    face: { browVis: 1, browTilt: -10 },
    eyes: {
      left:  { y: -3, rotate: -6 },
      right: { y: 4,  rotate: 8 }
    },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'jitter', amp: 1.4, speed: 8, decay: 800 }
    ],
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0,   body: { color: '@alert', rotate: -6 } },
        { at: 170, body: { color: '@base', rotate: -4 } },
        { at: 340, body: { color: '@alert', rotate: -7 } },
        { at: 510, body: { color: '@base', rotate: -5 } },
        { at: 700, body: { color: '@alert', rotate: -6 } }
      ]
    }
  },
  {
    id: '35', name: '等待输入', group: 'agent',
    desc: '聆听眼形轮换，目光轻轻上下扫读',
    en: { name: 'Listening', desc: 'Listening eyes rotate while the gaze sweeps gently up and down' },
    transition: 480,
    pool: ['listen', 'listen2', 'happy'], poolMs: [2800, 5000], blinkMs: [3000, 7000],
    mouth: 'smile',
    body: { breathe: 0.01 },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 6, period: 2200 }
    ]
  },
  {
    id: '36', name: '联网加载', group: 'agent',
    desc: '左右眼轮流眨，像信号在两端来回跳',
    en: { name: 'Loading', desc: 'Eyes blink in alternation, like a signal hopping between two endpoints' },
    transition: 380,
    pool: ['calm', 'calm2'], poolMs: [6000, 10000], blinkMs: null,
    mouth: 'dot',
    anims: [
      { target: 'left',  prop: 'open', type: 'blink', interval: 1200, dur: 380 },
      { target: 'right', prop: 'open', type: 'blink', interval: 1200, dur: 380, phaseMs: 600 },
      { target: 'eyes',  prop: 'lookX', type: 'sine', amp: 2, period: 2400 }
    ]
  },
  {
    id: '37', name: '复述回忆', group: 'agent',
    desc: '聆听眼形慢轮换，目光飘向上方翻检记忆',
    en: { name: 'Recalling', desc: 'Listening eyes rotate slowly as the gaze drifts upward, leafing through memory' },
    transition: 780,
    pool: ['listen', 'listen2', 'calm2'], poolMs: [4000, 8000], blinkMs: null,
    mouth: 'dot',
    body: { rotate: -2, breathe: 0.009 },
    eyes: { both: { lookY: -9, lookX: 3, y: -3 } },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 2.4, period: 4000 }
    ]
  },
  {
    id: '38', name: '拒绝/受限', group: 'agent',
    desc: '斜眼下压嘴角向下，进入时连续摇头，明确表示不行',
    en: { name: 'Refusing', desc: 'A lowered sidelong gaze and a downturned mouth, with a firm head-shake on entry: the answer is no' },
    transition: 380,
    pool: ['squint', 'squint2', 'sad'], poolMs: [2600, 4500], blinkMs: [4500, 8000], openness: 0.6,
    mouth: 'frown',
    body: { y: 2, rotate: -2, color: '@dim' },
    eyes: { both: { lookY: 3, y: 2 } },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0,   body: { x: 0 } },
        { at: 130, body: { x: -9, rotate: -6 } },
        { at: 300, body: { x: 8,  rotate: 2 } },
        { at: 470, body: { x: -6, rotate: -5 } },
        { at: 630, body: { x: 4,  rotate: 0 } },
        { at: 800, body: { x: 0,  rotate: -2 } }
      ]
    }
  },
  {
    id: '39', name: '输出回复', group: 'agent',
    desc: '扫读眼形轮换，嘴巴随输出节奏一张一合',
    en: { name: 'Replying', desc: 'Reading eyes rotate while the mouth opens and closes in time with the output' },
    transition: 360,
    pool: ['scan', 'scan2'], poolMs: [4000, 8000], blinkMs: null,
    mouth: 'open',
    body: { breathe: 0.008 },
    eyes: { both: { y: -2 } },
    anims: [
      { target: 'face', prop: 'mouthSY', type: 'pulse', amp: 0.55, period: 340 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.2, period: 680 }
    ]
  },
  {
    id: '40', name: '检索资料', group: 'agent',
    desc: '扫读眼形高速轮换（弹簧加速），目光左右快扫',
    en: { name: 'Searching', desc: 'Reading eye shapes rotate at high speed while the gaze sweeps rapidly side to side' },
    transition: 320,
    pool: ['scan', 'scan2', 'scan3', 'wide', 'squint'], poolMs: [1000, 1800], poolSpeed: 10, blinkMs: [1600, 4000],
    mouth: 'flat',
    body: { breathe: 0.006 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'scan', amp: 11, period: 700 }
    ]
  },
  {
    id: '41', name: '停止终止', group: 'agent',
    desc: '闭合眼形，慢慢收小半闭后定格',
    en: { name: 'Powering Off', desc: 'Closing eyes shrink to half-closed and quietly freeze' },
    transition: 280,
    gaze: false,
    pool: ['closed', 'closed2'], poolMs: [6000, 9000], blinkMs: null,
    mouth: 'flat',
    body: { y: 3, breathe: 0.004, color: '@off' },
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0 },
        { at: 1500, eyes: { both: { scaleX: 0.6, scaleY: 0.6, open: 0.35, y: 3 } }, body: { y: 4, scale: 0.97 } }
      ]
    }
  },

  /* ==================== 4）自定义 ==================== */
  /* 50+ 留给宿主自行 register，图鉴不预置庆祝条目。
   * 角色点击庆祝走 celebrate()，不是表情 ID。 */
];

/* ============================================================
 * engine.js —— 驱动层（依赖 geometry / render / features / fx；消费 emotions.js 纯数据）
 *
 * 职责：
 *   1. 角色注册中心 MoodMates.characters：角色数据包 → 解析出几何 / 眼环族 / 嘴形族
 *   2. 表情注册中心 MoodMates.config：校验 / 语义槽位 / 导入导出（全角色共享基座）
 *   3. EmotionEngine：rAF 状态机 + 动画原语 + 弹簧插值 + 兜底 + 待机策略
 *   4. 对外 SDK：MoodMates.create(el, opts) → engine 实例
 *
 * 对外 API（宿主只依赖这一层）：
 *   const mate = MoodMates.create(el, { character:'nimbo', emotion:'02', idle:true });
 *   mate.setEmotion('30');
 *   mate.handleAIMessage({ emotionId:'30', tips:'正在思考' });   // 或 JSON 字符串
 *   mate.on('change'|'tips'|'error', cb);
 *   mate.startTour(ids, interval) / mate.stopTour();
 *   mate.registerEmotion(config); mate.destroy();
 *   MoodMates.characters.register(def) / list();
 *   MoodMates.config.exportConfig() / importConfig(json);
 *
 * 表情配置中的语义化设计（与具体角色解耦）：
 *   pool  用眼形槽位名（'calm'/'happy'/…），每个角色用自己的眼环族实现
 *   mouth 用嘴形槽位名（'smile'/'o'/…），随表情切换弹性形变
 *   颜色  用 '@token'（'@base'/'@blush'/'@angry'/…）查角色色板 states 表
 * ============================================================ */
(function () {
  'use strict';

  var MM = (window.MoodMates = window.MoodMates || {});
  var GEO = MM.geo;
  var TAU = Math.PI * 2;
  var FALLBACK_ID = '02';

  /* ---------------- 基础工具 ---------------- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /* 临界阻尼弹簧步进，子步 1/120 保证数值稳定 */
  function spring(v0) { return { x: v0, v: 0, t: v0 }; }
  function springStep(s, w, z, dt) {
    s.v += (-2 * z * w * s.v - w * w * (s.x - s.t)) * dt;
    s.x += s.v * dt;
    if (!isFinite(s.x) || !isFinite(s.v)) { s.x = s.t; s.v = 0; }
  }

  /* 两组轮廓环逐点插值 */
  function lerpRing(a, b, t) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) {
      out[i] = [a[i][0] + (b[i][0] - a[i][0]) * t, a[i][1] + (b[i][1] - a[i][1]) * t];
    }
    return out;
  }

  /* 弹跳：4 段递减抛物线 */
  var BOUNCE_SEGS = [{ h: 48, d: 0.5 }, { h: 28, d: 0.382 }, { h: 14, d: 0.27 }, { h: 6, d: 0.177 }];
  var BOUNCE_TOTAL = BOUNCE_SEGS.reduce(function (s, q) { return s + q.d; }, 0);

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      return clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    }).join('');
  }
  function lerpColor(a, b, t) {
    if (a === b) return b;
    var A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
  }

  /* ---------------- 角色注册中心 ---------------- */

  var characters = new Map();
  var charOrder = [];

  /** 角色色板 states 缺省表：未提供的语义色一律回退主体色 */
  var STATE_KEYS = ['base', 'dim', 'soft', 'blush', 'angry', 'alert', 'off'];

  function resolveCharacter(raw) {
    if (raw._resolved) return raw._resolved;
    var eyeStyle = Object.assign(
      { dx: 30, cy: 96, w: 26, h: 34, taper: 0.5, tilt: 0, bend: 0, highlight: null, pupil: null },
      raw.eyeStyle || {}
    );
    var family = GEO.buildEyeFamily(eyeStyle);
    /* 角色自定义眼形轮廓（每表情专属轮廓组）：raw.eyeShapes = { 名字: lens 参数 } */
    if (raw.eyeShapes) {
      for (var esk in raw.eyeShapes) {
        family[esk] = GEO.buildCustomEyePair(raw.eyeShapes[esk], eyeStyle);
      }
    }
    var mouthBase = { w: (raw.features && raw.features.mouth && raw.features.mouth.w) || 26 };
    var mouthShapes = {};
    GEO.mouthSlots.forEach(function (slot) {
      mouthShapes[slot] = GEO.buildMouth(slot, mouthBase);
    });
    /* 角色自定义嘴形轮廓：raw.mouthShapes = { 名字: mouthLens 参数 } */
    if (raw.mouthShapes) {
      for (var msk in raw.mouthShapes) {
        mouthShapes[msk] = GEO.buildCustomMouth(Object.assign({ w: mouthBase.w }, raw.mouthShapes[msk]));
      }
    }
    var palette = Object.assign({ eye: '#233038', eyeHighlight: '#FFFFFF' }, raw.palette || {});
    palette.states = Object.assign({}, raw.palette && raw.palette.states);
    STATE_KEYS.forEach(function (k) {
      if (!palette.states[k]) palette.states[k] = palette.body;
    });

    var resolved = {
      id: raw.id,
      name: raw.name,
      en: raw.en || null,
      industry: raw.industry || 'general',
      desc: raw.desc || '',
      bodyRing: GEO.buildBody(raw.body),
      face: Object.assign({ x: 0, y: 0, sx: 1, sy: 1, eye: 1 }, raw.face || {}),
      palette: palette,
      eyeStyle: eyeStyle,
      eyeFamily: family,
      mouthShapes: mouthShapes,
      defaultEyeRing: family.calm,
      features: raw.features || {},
      fxSkin: raw.fxSkin || 'cloudpuff',
      celebrateBeat: raw.celebrateBeat || null,
      emotions: raw.emotions || null,
      raw: raw
    };
    raw._resolved = resolved;
    return resolved;
  }

  /* 身体轮廓变体：raw.variants = { 变体id: { name, en, body } }。
   * 变体只替换 bodyRing（剪影），眼形 / 色板 / 表情编排全部共享 */
  function resolveVariant(raw, vid) {
    var base = resolveCharacter(raw);
    if (!vid || !raw.variants || !raw.variants[vid]) return base;
    raw._variantCache = raw._variantCache || {};
    if (!raw._variantCache[vid]) {
      var v = raw.variants[vid];
      raw._variantCache[vid] = Object.assign({}, base, {
        variant: vid,
        bodyRing: v.body ? GEO.buildBody(v.body) : base.bodyRing
      });
    }
    return raw._variantCache[vid];
  }

  MM.characters = {
    register: function (raw) {
      if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) {
        return { ok: false, errors: ['角色缺少合法 id'] };
      }
      if (!raw.body || !raw.body.type) {
        return { ok: false, id: raw.id, errors: ['角色缺少 body.type（身体生成器）'] };
      }
      try {
        resolveCharacter(raw);
        if (raw.variants) {
          for (var vk in raw.variants) resolveVariant(raw, vk);
        }
      } catch (e) {
        return { ok: false, id: raw.id, errors: [e.message] };
      }
      if (!characters.has(raw.id)) charOrder.push(raw.id);
      characters.set(raw.id, raw);
      return { ok: true, id: raw.id };
    },
    get: function (id, variant) {
      var raw = characters.get(id);
      return raw ? resolveVariant(raw, variant) : null;
    },
    /** 列出角色的身体轮廓变体（不含默认轮廓） */
    variants: function (id) {
      var raw = characters.get(id);
      if (!raw || !raw.variants) return [];
      return Object.keys(raw.variants).map(function (k) {
        var v = raw.variants[k];
        return { id: k, name: v.name || k, en: v.en || null };
      });
    },
    list: function () {
      return charOrder.map(function (id) { return resolveCharacter(characters.get(id)); });
    },
    defaultId: function () { return charOrder[0] || null; }
  };

  /* ---------------- Pose：默认值 / 合并 / 插值 ---------------- */

  var DEFAULT_BODY = {
    x: 0, y: 0, scale: 1, rotate: 0, color: '@base', breathe: 0.01,
    spinFx: 0, confetti: 0, sketch: 0,
    zzz: 0,      /* 睡眠字母粒子（0~1） */
    orbit: 0     /* 常驻环绕粒子（0~1） */
  };
  var DEFAULT_EYE = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, open: 1, color: '@eye', lookX: 0, lookY: 0 };
  var DEFAULT_FACE = {
    blush: 0, browVis: 0, browTilt: 0, browRaise: 0,
    mouthX: 0, mouthY: 0, mouthSX: 1, mouthSY: 1
  };

  function defaultPose() {
    return {
      body: Object.assign({}, DEFAULT_BODY),
      left: Object.assign({}, DEFAULT_EYE),
      right: Object.assign({}, DEFAULT_EYE),
      face: Object.assign({}, DEFAULT_FACE)
    };
  }
  function clonePose(p) {
    return {
      body: Object.assign({}, p.body),
      left: Object.assign({}, p.left),
      right: Object.assign({}, p.right),
      face: Object.assign({}, p.face)
    };
  }

  /** 把配置片段（body / eyes.both|left|right / face）合并到 pose 上（原地修改） */
  function applySpec(pose, spec) {
    if (!spec) return pose;
    if (spec.body) Object.assign(pose.body, spec.body);
    if (spec.face) Object.assign(pose.face, spec.face);
    var e = spec.eyes;
    if (e) {
      if (e.both) { Object.assign(pose.left, e.both); Object.assign(pose.right, e.both); }
      if (e.left) Object.assign(pose.left, e.left);
      if (e.right) Object.assign(pose.right, e.right);
    }
    return pose;
  }

  var POSE_PARTS = ['body', 'left', 'right', 'face'];

  function lerpPose(a, b, t) {
    var out = defaultPose();
    POSE_PARTS.forEach(function (part) {
      var pa = a[part], pb = b[part], po = out[part];
      for (var k in pb) {
        var vb = pb[k];
        if (typeof vb === 'number') po[k] = lerp(pa[k] != null ? pa[k] : vb, vb, t);
        else if (k === 'color') po[k] = lerpColor(pa[k] || vb, vb, t);
        else po[k] = vb;
      }
    });
    return out;
  }

  function sampleFrameList(frames, t) {
    if (!frames.length) return null;
    if (t <= frames[0].at) return clonePose(frames[0].pose);
    var last = frames[frames.length - 1];
    if (t >= last.at) return clonePose(last.pose);
    for (var i = 0; i < frames.length - 1; i++) {
      var a = frames[i], b = frames[i + 1];
      if (t >= a.at && t < b.at) {
        return lerpPose(a.pose, b.pose, easeInOutCubic((t - a.at) / (b.at - a.at)));
      }
    }
    return clonePose(last.pose);
  }

  /* ---------------- 动画原语 ---------------- */

  var ANIM_TYPES = {
    /** 正弦漂移 / 呼吸 / 扫视 */
    sine: function (a, t) {
      return a.amp * Math.sin(TAU * t / (a.period || 2000) + (a.phase || 0));
    },
    /** 节奏缩放：0 → amp 平滑往复 */
    pulse: function (a, t) {
      return a.amp * 0.5 * (1 - Math.cos(TAU * t / (a.period || 1000) + (a.phase || 0)));
    },
    /** 随机小抖动（多正弦伪噪声），decay 毫秒内衰减到 0 */
    jitter: function (a, t, eng) {
      var s = t / 1000 * (a.speed || 8);
      var v = (Math.sin(s * 3.1 + eng._seed) +
               Math.sin(s * 5.7 + eng._seed * 2.3) +
               Math.sin(s * 9.3 + eng._seed * 4.1)) / 3 * a.amp;
      if (a.decay) v *= clamp(1 - t / a.decay, 0, 1);
      return v;
    },
    /** 三角波快速来回扫动 */
    scan: function (a, t) {
      var per = a.period || 800;
      var p = ((t + (a.phaseMs || 0)) % per) / per;
      var tri = p < 0.5 ? p * 4 - 1 : 3 - p * 4;
      return a.amp * tri;
    },
    /** 张望：平滑方波，两端各停留片刻再换边 */
    glance: function (a, t) {
      var per = a.period || 3600;
      var ph = TAU * (((t + (a.phaseMs || 0)) % per) / per) + (a.phase || 0);
      return a.amp * Math.tanh(2.8 * Math.sin(ph));
    },
    /** 周期眨眼；相位叠加实例随机种子，多实例不同步 */
    blink: function (a, t, eng) {
      var interval = a.interval || 3800, dur = a.dur || 200;
      var p = (t + (a.phaseMs || 0) + (eng ? eng._seed * 97 : 0)) % interval;
      if (p >= dur) return 0;
      return -(a.depth == null ? 1 : a.depth) * Math.sin(Math.PI * (p / dur));
    }
  };

  function applyAnim(pose, a, t, eng) {
    var fn = ANIM_TYPES[a.type];
    if (!fn) return;
    var v = fn(a, t, eng);
    var targets =
      a.target === 'eyes' ? [pose.left, pose.right] :
      a.target === 'body' ? [pose.body] :
      a.target === 'face' ? [pose.face] :
      a.target === 'left' ? [pose.left] :
      a.target === 'right' ? [pose.right] : [];
    for (var i = 0; i < targets.length; i++) {
      var tg = targets[i];
      if (a.prop === 'scale') {
        if (tg === pose.body) tg.scale += v;
        else { tg.scaleX += v; tg.scaleY += v; }
      } else if (a.prop in tg) {
        tg[a.prop] += v;
      }
    }
  }

  /* ---------------- 表情注册中心（全角色共享的原始配置） ---------------- */

  var GROUPS = (window.EMOTION_GROUPS || [
    { key: 'life', name: '生命周期' },
    { key: 'emotion', name: '情绪反应' },
    { key: 'agent', name: '代理工作状态' },
    { key: 'custom', name: '自定义' }
  ]).slice();

  var registry = new Map();   /* id → raw */
  var order = [];
  var configVersion = 0;

  function knownGroup(g) {
    return GROUPS.some(function (x) { return x.key === g; });
  }

  function validate(raw) {
    var errs = [];
    if (!raw || typeof raw !== 'object') { errs.push('配置必须是对象'); return errs; }
    if (typeof raw.id !== 'string' || !raw.id.trim()) errs.push('缺少合法的字符串 id');
    if (typeof raw.name !== 'string' || !raw.name.trim()) errs.push('缺少 name');
    if (!knownGroup(raw.group)) errs.push('group 不合法：' + raw.group);
    if (raw.pool != null) {
      /* 槽位名允许角色自定义轮廓（eyeShapes），此处只做类型校验，
       * 未知名字在 normalizeFor 按角色眼环族过滤兜底 */
      if (!Array.isArray(raw.pool)) errs.push('pool 必须是眼形槽位名数组');
      else raw.pool.forEach(function (s, i) {
        if (typeof s !== 'string') errs.push('pool[' + i + '] 必须是眼形槽位名字符串');
      });
    }
    if (raw.mouth != null && typeof raw.mouth !== 'string') {
      errs.push('mouth 必须是嘴形槽位名字符串');
    }
    if (raw.anims != null) {
      if (!Array.isArray(raw.anims)) errs.push('anims 必须是数组');
      else raw.anims.forEach(function (a, i) {
        if (!a || !ANIM_TYPES[a.type]) errs.push('anims[' + i + '] 未知动画类型：' + (a && a.type));
      });
    }
    if (raw.sequence != null && !Array.isArray(raw.sequence.frames)) {
      errs.push('sequence.frames 必须是数组');
    }
    return errs;
  }

  function register(raw) {
    var errs = validate(raw);
    if (errs.length) return { ok: false, id: raw && raw.id, errors: errs };
    if (!registry.has(raw.id)) order.push(raw.id);
    registry.set(raw.id, raw);
    configVersion++;
    return { ok: true, id: raw.id };
  }

  /* ---- 角色覆盖合并：角色数据里的 emotions[id] 片段浅合并进原始配置 ---- */
  function mergeRaw(base, over) {
    if (!over) return base;
    var out = Object.assign({}, base, over);
    if (base.body || over.body) out.body = Object.assign({}, base.body, over.body);
    if (base.face || over.face) out.face = Object.assign({}, base.face, over.face);
    if (base.eyes || over.eyes) {
      out.eyes = {};
      ['both', 'left', 'right'].forEach(function (k) {
        if ((base.eyes && base.eyes[k]) || (over.eyes && over.eyes[k])) {
          out.eyes[k] = Object.assign({}, base.eyes && base.eyes[k], over.eyes && over.eyes[k]);
        }
      });
    }
    return out;
  }

  /* ---- 语义色解析：'@token' → 角色色板 states / 特殊键 ---- */
  function resolveColor(v, ch) {
    if (typeof v !== 'string' || v.charAt(0) !== '@') return v;
    var key = v.slice(1);
    if (key === 'eye') return ch.palette.eye;
    return ch.palette.states[key] || ch.palette.body;
  }
  function resolvePoseColors(pose, ch) {
    pose.body.color = resolveColor(pose.body.color, ch);
    pose.left.color = resolveColor(pose.left.color, ch);
    pose.right.color = resolveColor(pose.right.color, ch);
    return pose;
  }

  /** 按角色归一化一条表情配置：深合并默认姿态，预生成 sequence 每帧完整 pose */
  function normalizeFor(raw, ch) {
    raw = mergeRaw(raw, ch.emotions && ch.emotions[raw.id]);
    var base = resolvePoseColors(applySpec(defaultPose(), raw), ch);
    var pool = (raw.pool || ['calm', 'calm2']).filter(function (s) { return ch.eyeFamily[s]; });
    if (!pool.length) pool = ['calm'];
    var def = {
      id: raw.id, name: raw.name, group: raw.group,
      desc: raw.desc || '',
      en: raw.en || null,
      gaze: raw.gaze !== false,
      transition: raw.transition != null ? raw.transition : 500,
      pool: pool,
      poolMs: raw.poolMs || [9000, 16000],
      poolSpeed: raw.poolSpeed || 6,
      blinkMs: raw.blinkMs !== undefined ? raw.blinkMs : [6000, 14000],
      openness: raw.openness != null ? raw.openness : 1,
      antics: !!raw.antics,
      mouth: raw.mouth && ch.mouthShapes[raw.mouth] ? raw.mouth : 'flat',
      base: base,
      anims: (raw.anims || []).map(function (a) { return Object.assign({}, a); }),
      sequence: null,
      raw: raw
    };
    if (raw.sequence) {
      var frames = raw.sequence.frames.map(function (f) {
        return { at: f.at || 0, pose: resolvePoseColors(applySpec(clonePose(base), f), ch) };
      }).sort(function (x, y) { return x.at - y.at; });
      def.sequence = { frames: frames, settle: raw.sequence.settle || 'base' };
    }
    return def;
  }

  MM.config = {
    register: register,
    getRaw: function (id) { return registry.get(id) || null; },
    list: function (group) {
      return order.map(function (id) { return registry.get(id); })
        .filter(function (d) { return !group || d.group === group; });
    },
    groups: function () {
      return GROUPS.map(function (g) { return { key: g.key, name: g.name, en: g.en || g.name }; });
    },
    version: function () { return configVersion; },
    exportConfig: function () {
      return JSON.stringify(order.map(function (id) { return registry.get(id); }), null, 2);
    },
    importConfig: function (json) {
      var data;
      try {
        data = typeof json === 'string' ? JSON.parse(json) : json;
      } catch (e) {
        return { ok: false, added: 0, errors: ['JSON 解析失败：' + e.message] };
      }
      var arr = Array.isArray(data) ? data : [data];
      var added = 0, errors = [];
      arr.forEach(function (raw) {
        var r = register(raw);
        if (r.ok) added++;
        else errors.push('[' + ((raw && raw.id) || '?') + '] ' + r.errors.join('；'));
      });
      return { ok: errors.length === 0, added: added, errors: errors };
    }
  };

  /* ---------------- 全局共享 rAF 时钟（多实例单循环） ---------------- */

  var ticker = {
    set: new Set(),
    raf: 0,
    add: function (e) {
      this.set.add(e);
      if (!this.raf) this.raf = requestAnimationFrame(ticker.loop);
    },
    remove: function (e) { this.set.delete(e); },
    loop: function (now) {
      ticker.raf = 0;
      ticker.set.forEach(function (e) { e._tick(now); });
      if (ticker.set.size) ticker.raf = requestAnimationFrame(ticker.loop);
    }
  };

  /* ---------------- EmotionEngine ---------------- */

  function Engine(target, opts) {
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('MoodMates.create：找不到容器元素');

    var chId = opts.character || MM.characters.defaultId();
    var ch = MM.characters.get(chId, opts.variant);
    if (!ch) throw new Error('MoodMates.create：未注册任何角色（先加载 src/characters/*.js）');
    this.character = ch;

    this.ball = MM.createBall(el, Object.assign({}, opts, {
      character: ch,
      lite: opts.lite != null ? opts.lite : opts.autostart === false
    }));
    this._seed = Math.random() * 100;
    this._events = {};
    this._gaze = { x: 0, y: 0, tx: 0, ty: 0 };
    this._style = { sketch: 0 };
    this._theme = opts.color
      ? { body: opts.color, eyes: opts.eyeColor || '#FFFFFF' }
      : null;
    this._eyeScale = opts.eyeScale || 1;
    this._lastTick = 0;
    this._spin = null;

    /* ---- 按角色归一化的表情缓存 ---- */
    this._defs = new Map();
    this._defsVersion = -1;

    /* ---- 眼环形变系统（槽位驱动） ---- */
    var calm = ch.eyeFamily.calm;
    this._ringSrc = [calm[0], calm[1]];
    this._ringDst = [calm[0], calm[1]];
    this._ringCur = this._ringDst;
    this._ringSpring = spring(1);
    this._ringSpeed = 7;
    this._exprSlot = 'calm';
    this._poolPos = 0;
    this._poolNext = 0;

    /* ---- 嘴形形变系统 ---- */
    var flat = ch.mouthShapes.flat;
    this._mouthSrc = flat;
    this._mouthDst = flat;
    this._mouthCur = flat;
    this._mouthSpring = spring(1);
    this._mouthSlot = 'flat';
    this._mouthHoldUntil = 0;

    /* ---- 眨眼系统 ---- */
    this._open = spring(1);
    this._blinkQ = [];
    this._blinkNext = Infinity;
    /* ---- 待机小动作 ---- */
    this._anticNext = 0;
    this._bounceAt = -1;

    this._def = null;
    this._lastPose = null;
    this._prevPose = null;
    this._transStart = 0;
    this._transDur = 0;
    this._emoStart = 0;
    this._seq = null;
    this._clickSeq = null;
    this._active = false;
    this._touring = false;
    this._tourTimer = 0;
    this._fallbackId = opts.fallbackId || FALLBACK_ID;
    this._lastActivity = performance.now();

    if (opts.idle) {
      this._idle = Object.assign(
        { standbyAfter: 60000, sleepAfter: 180000, standbyId: '02', sleepId: '00' },
        opts.idle === true ? {} : opts.idle
      );
    } else {
      this._idle = null;
    }

    this.setEmotion(opts.emotion || this._fallbackId, { auto: true });
    if (opts.autostart !== false) this.setActive(true);
    else this.renderStatic();
  }

  Engine.prototype = {

    /* ---------- 事件 ---------- */
    on: function (evt, cb) {
      (this._events[evt] = this._events[evt] || []).push(cb);
      return this;
    },
    off: function (evt, cb) {
      var list = this._events[evt];
      if (list) {
        var i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      }
      return this;
    },
    _emit: function (evt, payload) {
      (this._events[evt] || []).slice().forEach(function (cb) {
        try { cb(payload); } catch (e) { console.error(e); }
      });
    },

    get emotionId() { return this._def ? this._def.id : null; },
    get touring() { return this._touring; },

    /** 取按本角色归一化的表情定义（带版本失效缓存） */
    _getDef: function (id) {
      if (this._defsVersion !== MM.config.version()) {
        this._defs.clear();
        this._defsVersion = MM.config.version();
      }
      if (this._defs.has(id)) return this._defs.get(id);
      var raw = MM.config.getRaw(id);
      if (!raw) return null;
      var def = normalizeFor(raw, this.character);
      this._defs.set(id, def);
      return def;
    },

    /* ---------- 核心：切换表情（含兜底） ---------- */
    setEmotion: function (id, o) {
      o = o || {};
      var def = this._getDef(id);
      if (!def) {
        console.warn('[MoodMates] 未知表情 ID "' + id + '"，回退到待机 (' + this._fallbackId + ')');
        this._emit('error', { message: '未知表情 ID "' + id + '"，已回退待机', id: id });
        def = this._getDef(this._fallbackId);
        if (!def) return false;
      }
      var now = performance.now();
      this._clickSeq = null;
      var prevId = this._def ? this._def.id : null;
      this._prevPose = this._lastPose ? clonePose(this._lastPose) : null;
      this._def = def;
      this._emoStart = now;
      this._transStart = now;
      this._transDur = this._prevPose ? def.transition : 0;
      this._seq = def.sequence
        ? { frames: def.sequence.frames, settle: def.sequence.settle, done: false }
        : null;
      if (!o.auto) this._lastActivity = now;

      this._poolPos = 0;
      this._mouthHoldUntil = 0;
      this._setExpr(def.pool[0], def.poolSpeed >= 10 ? 10 : 8);
      this._setMouth(def.mouth, 8);
      this._poolNext = now + rand(def.poolMs[0], def.poolMs[1]);
      if (prevId !== null && prevId !== def.id && def.blinkMs) this._blinkNow(now);
      this._blinkNext = def.blinkMs ? now + rand(def.blinkMs[0], def.blinkMs[1]) : Infinity;
      this._anticNext = now + rand(2500, 5000);

      this._emit('change', { id: def.id, def: def, auto: !!o.auto });
      /* spinFx / confetti 是进入表情时的一次性事件。
       * 完整签名（云宝云泡）本身就是一幕，不再叠撒花；
       * 亮亮等仍走签名 + 撒花，无签名才回退自旋 */
      if (this._active) {
        var fx = def.base.body;
        var signed = false;
        if (fx.spinFx > 0) {
          signed = this.signature(fx.spinFx >= 1 ? 1 : 0.7);
          if (!signed) this.spin(fx.spinFx >= 1 ? 2 : 1);
        }
        if (fx.confetti > 0 && !(signed && this.ball.signatureComplete)) this.burst(20);
      }
      if (!this._active) this.renderStatic();
      return true;
    },

    /** AI 对接入口：接受对象或 JSON 字符串 { emotionId, tips } */
    handleAIMessage: function (msg) {
      var obj = msg;
      if (typeof msg === 'string') {
        try { obj = JSON.parse(msg); }
        catch (e) {
          this._emit('error', { message: 'AI 消息 JSON 解析失败，已回退待机', raw: msg });
          this.setEmotion(this._fallbackId);
          return false;
        }
      }
      if (!obj || typeof obj !== 'object' || typeof obj.emotionId !== 'string') {
        this._emit('error', { message: 'AI 消息缺少 emotionId 字段，已回退待机', raw: msg });
        this.setEmotion(this._fallbackId);
        return false;
      }
      var ok = this.setEmotion(obj.emotionId);
      if (obj.tips) this._emit('tips', { text: String(obj.tips) });
      return ok;
    },

    /* ---------- 自动巡演 ---------- */
    startTour: function (ids, interval) {
      this.stopTour();
      if (!ids || !ids.length) return;
      interval = interval || 2500;
      this._touring = true;
      var self = this, i = 0;
      this.setEmotion(ids[0], { auto: true });
      this._tourTimer = setInterval(function () {
        i = (i + 1) % ids.length;
        self.setEmotion(ids[i], { auto: true });
      }, interval);
    },
    stopTour: function () {
      if (this._tourTimer) { clearInterval(this._tourTimer); this._tourTimer = 0; }
      this._touring = false;
      this._lastActivity = performance.now();
    },

    resetIdle: function () { this._lastActivity = performance.now(); },

    /* 注视目标：横向 ±24、纵向 ±15（viewBox 坐标） */
    setGaze: function (nx, ny) {
      this._gaze.tx = clamp(nx, -1, 1) * 24;
      this._gaze.ty = clamp(ny, -1, 1) * 15;
      return this;
    },
    clearGaze: function () {
      this._gaze.tx = 0;
      this._gaze.ty = 0;
      return this;
    },
    setStyle: function (style) {
      Object.assign(this._style, style || {});
      if (!this._active) this.renderStatic();
      return this;
    },

    /* 自旋（点击交互）：弹簧追整数圈，达速后由特效层甩出粒子 */
    spin: function (turns, dir) {
      if (this._spin) return this;
      var d = dir || (Math.random() < 0.5 ? -1 : 1);
      this._spin = { x: 0, v: 0, t: Math.max(1, Math.round(turns || 1)) * TAU * d };
      return this;
    },
    /* 撒花：一次性物理粒子爆发 */
    burst: function (count) {
      if (this.ball.burst) this.ball.burst(count);
      return this;
    },
    /* 签名动作：角色专属交互（云泡 / 星星爆闪）
     * 返回 false 表示该角色皮肤没有签名动作 */
    signature: function (strength) {
      var ok = this.ball.signature ? !!this.ball.signature(strength) : false;
      /* 皮肤可声明 signatureMouth：触发签名时嘴形临时覆盖，到期弹回当前表情嘴形 */
      if (ok && this.ball.signatureMouth) {
        this._mouthHoldUntil = performance.now() + (this.ball.signatureMouthMs || 1400);
        this._setMouth(this.ball.signatureMouth, 10);
      }
      return ok;
    },
    /* 点击庆祝：不切换图鉴表情。有 celebrateBeat 的角色叠一小节脸；
     * 完整签名不再叠自旋 / 撒花，其余仍为签名 + 随机肢体 + 撒花 */
    celebrate: function (strength) {
      var s = strength == null ? 1 : strength;
      this._playCelebrateBeat();
      var signed = this.signature(s);
      if (signed && this.ball.signatureComplete) return this;
      var r = Math.random();
      if (r < 0.5) this.spin(1);
      else if (r < 0.85) this.bounce();
      this.burst(Math.round(10 + 8 * s));
      return this;
    },
    /* 点击庆祝脸：临时姿态，播完弹回当前表情，不改 emotionId */
    _playCelebrateBeat: function () {
      var beat = this.character && this.character.celebrateBeat;
      if (!beat || !beat.frames || !beat.frames.length) return;
      var ch = this.character;
      var frames = beat.frames.map(function (f) {
        return { at: f.at || 0, pose: resolvePoseColors(applySpec(defaultPose(), f), ch) };
      }).sort(function (x, y) { return x.at - y.at; });
      var now = performance.now();
      this._clickSeq = { start: now, frames: frames, fade: beat.fade != null ? beat.fade : 280 };
      var expr = beat.expr && ch.eyeFamily[beat.expr] ? beat.expr : 'happy';
      var mouth = beat.mouth && ch.mouthShapes[beat.mouth] ? beat.mouth : 'grin';
      this._setExpr(expr, 10);
      this._setMouth(mouth, 10);
      this._mouthHoldUntil = now + frames[frames.length - 1].at + this._clickSeq.fade;
    },
    _applyClickBeat: function (basePose, now) {
      var seq = this._clickSeq;
      if (!seq) return null;
      var t = now - seq.start;
      var frames = seq.frames;
      var last = frames[frames.length - 1];
      var fade = seq.fade;
      if (t >= last.at + fade) {
        this._clickSeq = null;
        if (this._def) {
          this._setMouth(this._def.mouth, 8);
          this._setExpr(this._def.pool[this._poolPos] || this._def.pool[0], 8);
        }
        return null;
      }
      var beat = t >= last.at ? last.pose : sampleFrameList(frames, t);
      var out = t >= last.at
        ? lerpPose(beat, basePose, easeInOutCubic((t - last.at) / fade))
        : beat;
      out.left.ring = basePose.left.ring;
      out.right.ring = basePose.right.ring;
      out.face.mouthRing = basePose.face.mouthRing;
      return out;
    },
    /* 弹跳（4 段递减抛物线） */
    bounce: function () {
      if (this._bounceAt < 0) this._bounceAt = performance.now();
      return this;
    },

    /* 切换眼环槽位：把当前插值冻结为新起点，弹簧从 0 重新弹向 1 */
    _setExpr: function (slot, speed) {
      if (slot === this._exprSlot && this._ringSpring.x >= 0.999) return;
      var pair = this.character.eyeFamily[slot];
      if (!pair) return;
      var s = clamp(this._ringSpring.x, 0, 1);
      this._ringSrc = [
        lerpRing(this._ringSrc[0], this._ringDst[0], s),
        lerpRing(this._ringSrc[1], this._ringDst[1], s)
      ];
      this._ringDst = [pair[0], pair[1]];
      this._ringSpring.x = 0;
      this._ringSpring.v = 0;
      this._ringSpring.t = 1;
      this._ringSpeed = speed || 7;
      this._exprSlot = slot;
    },

    /* 切换嘴形槽位（同眼环逻辑） */
    _setMouth: function (slot, speed) {
      if (slot === this._mouthSlot && this._mouthSpring.x >= 0.999) return;
      var ring = this.character.mouthShapes[slot];
      if (!ring) return;
      var s = clamp(this._mouthSpring.x, 0, 1);
      this._mouthSrc = lerpRing(this._mouthSrc, this._mouthDst, s);
      this._mouthDst = ring;
      this._mouthSpring.x = 0;
      this._mouthSpring.v = 0;
      this._mouthSpring.t = 1;
      this._mouthSlot = slot;
    },

    /* 眨眼关键帧：合上 → 停 70ms → 睁到 1.08 过冲 → 300ms 落回 1 */
    _blinkNow: function (t) {
      this._blinkQ.push(
        { at: t, v: 0.05 }, { at: t + 70, v: 0.05 },
        { at: t + 150, v: 1.08 }, { at: t + 300, v: 1 }
      );
      if (Math.random() < 0.14) {
        this._blinkQ.push({ at: t + 370, v: 0.05 }, { at: t + 480, v: 1 });
      }
    },

    registerEmotion: function (raw) { return MM.config.register(raw); },

    /* ---------- 生命周期 ---------- */
    setActive: function (on) {
      if (on === this._active) return;
      this._active = on;
      if (on) ticker.add(this);
      else ticker.remove(this);
    },
    replay: function () {
      if (this._def) this.setEmotion(this._def.id, { auto: true });
    },
    /** 静态渲染一帧 */
    renderStatic: function () {
      this._transDur = 0;
      this._ringSpring.x = 1;
      this._ringSpring.v = 0;
      this._mouthSpring.x = 1;
      this._mouthSpring.v = 0;
      this._open.x = this._def ? this._def.openness : 1;
      this._open.v = 0;
      var seq = this._seq;
      this._seq = null;
      this._tick(performance.now());
      this._seq = seq;
    },
    destroy: function () {
      this.stopTour();
      this.setActive(false);
      this._events = {};
      this.ball.destroy();
    },

    /* ---------- 每帧 ---------- */
    _tick: function (now) {
      this._dt = this._lastTick ? clamp((now - this._lastTick) / 1000, 0.001, 0.05) : 1 / 60;
      this._lastTick = now;
      if (this._idle && !this._touring) this._checkIdle(now);
      var pose = this._compose(now, 0);
      this.ball.applyPose(pose);
      this._lastPose = pose;
    },

    _checkIdle: function (now) {
      var idle = this._idle;
      var elapsed = now - this._lastActivity;
      var cur = this.emotionId;
      if (elapsed >= idle.sleepAfter) {
        if (cur !== idle.sleepId) this.setEmotion(idle.sleepId, { auto: true });
      } else if (elapsed >= idle.standbyAfter) {
        if (cur !== idle.standbyId && cur !== idle.sleepId) {
          this.setEmotion(idle.standbyId, { auto: true });
        }
      }
    },

    /** 合成当前帧姿态：base → sequence → animators → 过渡插值 */
    _compose: function (now, depth) {
      var def = this._def;
      var t = now - this._emoStart;
      var pose;

      if (this._seq) {
        var res = this._seqPose(t, now);
        if (res === 'switch') {
          return depth < 4 ? this._compose(now, depth + 1) : clonePose(this._def.base);
        }
        pose = res || clonePose(def.base);
      } else {
        pose = clonePose(def.base);
      }

      /* 内置呼吸（相位用绝对时间，切换表情不跳变） */
      var br = pose.body.breathe || 0;
      if (br) {
        var ph = TAU * now / 3600;
        pose.body.scale += br * Math.sin(ph);
        pose.body.y += br * 55 * Math.sin(ph + 0.6);
      }

      for (var i = 0; i < def.anims.length; i++) applyAnim(pose, def.anims[i], t, this);

      var dt = this._dt || 1 / 60;

      /* ---- 表情池轮换 ---- */
      if (this._active && now >= this._poolNext) {
        if (def.pool.length > 1) {
          this._poolPos = (this._poolPos + 1 + Math.floor(rand(0, def.pool.length - 1))) % def.pool.length;
          this._setExpr(def.pool[this._poolPos], def.poolSpeed);
        }
        this._poolNext = now + rand(def.poolMs[0], def.poolMs[1]);
      }

      /* ---- 眨眼调度 ---- */
      if (this._active && def.blinkMs && now >= this._blinkNext) {
        this._blinkNow(now);
        this._blinkNext = now + rand(def.blinkMs[0], def.blinkMs[1]);
      }
      var openKey = null;
      while (this._blinkQ.length && now >= this._blinkQ[0].at) {
        openKey = this._blinkQ[0].v;
        this._blinkQ.shift();
      }
      this._open.t = openKey != null ? openKey : (this._blinkQ.length ? this._open.t : def.openness);

      /* ---- 待机小动作：优先角色签名动作（轻量版），无签名才通用自旋 ---- */
      if (this._active && def.antics && now >= this._anticNext) {
        if (!this._spin && this._bounceAt < 0) {
          var pick = Math.random();
          if (pick < 0.45) {
            if (!this.signature(0.55)) this.spin(1);
          }
          else if (pick < 0.8) this.bounce();
          else this._blinkNow(now);
        }
        this._anticNext = now + rand(9000, 18000);
      }

      /* 签名嘴形覆盖到期：弹回当前表情槽位（表情切换已清 hold，不会串嘴） */
      if (this._mouthHoldUntil && now >= this._mouthHoldUntil) {
        this._mouthHoldUntil = 0;
        this._setMouth(def.mouth, 8);
      }

      /* ---- 弹簧整步（子步 1/120）：眼形变 / 嘴形变 / 开合 / 自旋 ---- */
      var steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      var j = dt / steps;
      for (var si = 0; si < steps; si++) {
        springStep(this._ringSpring, this._ringSpeed, 1, j);
        springStep(this._mouthSpring, 9, 1, j);
        springStep(this._open, 26, 1, j);
        if (this._spin) {
          springStep(this._spin, 6.2, 1, j);
          if (Math.abs(this._spin.t - this._spin.x) < 0.01 && Math.abs(this._spin.v) < 0.05) {
            this._spin = null;
          }
        }
      }
      pose.body.yaw = this._spin ? this._spin.x : 0;

      /* ---- 弹跳位移 ---- */
      if (this._bounceAt >= 0) {
        var be = (now - this._bounceAt) / 1000;
        if (be >= BOUNCE_TOTAL) {
          this._bounceAt = -1;
        } else {
          var acc = 0, bi = 0;
          while (bi < BOUNCE_SEGS.length && be >= acc + BOUNCE_SEGS[bi].d) { acc += BOUNCE_SEGS[bi].d; bi++; }
          var seg = BOUNCE_SEGS[Math.min(bi, BOUNCE_SEGS.length - 1)];
          var bn = (be - acc) / seg.d;
          pose.body.y += -4 * seg.h * bn * (1 - bn);
        }
      }

      /* ---- 当前眼环 / 嘴环：形变中逐点插值，静止后复用目标引用 ---- */
      if (this._ringSpring.x < 0.999 || this._ringSpring.v > 0.001 || this._ringSpring.v < -0.001) {
        var rs = clamp(this._ringSpring.x, 0, 1.35);
        this._ringCur = [
          lerpRing(this._ringSrc[0], this._ringDst[0], rs),
          lerpRing(this._ringSrc[1], this._ringDst[1], rs)
        ];
      } else if (this._ringCur !== this._ringDst) {
        this._ringCur = this._ringDst;
      }
      pose.left.ring = this._ringCur[0];
      pose.right.ring = this._ringCur[1];

      if (this._mouthSpring.x < 0.999 || Math.abs(this._mouthSpring.v) > 0.001) {
        var ms = clamp(this._mouthSpring.x, 0, 1.25);
        this._mouthCur = lerpRing(this._mouthSrc, this._mouthDst, ms);
      } else if (this._mouthCur !== this._mouthDst) {
        this._mouthCur = this._mouthDst;
      }
      pose.face.mouthRing = this._mouthCur;

      /* 鼠标注视：帧率无关的指数平滑 */
      var k = 1 - Math.exp(-5.66 * dt);
      var gx = def.gaze !== false ? this._gaze.tx : 0;
      var gy = def.gaze !== false ? this._gaze.ty : 0;
      this._gaze.x += (gx - this._gaze.x) * k;
      this._gaze.y += (gy - this._gaze.y) * k;
      pose.left.lookX += this._gaze.x;
      pose.right.lookX += this._gaze.x;
      pose.left.lookY += this._gaze.y;
      pose.right.lookY += this._gaze.y;
      pose.face.mouthX += this._gaze.x * 0.35;
      pose.face.mouthY += this._gaze.y * 0.28;

      /* 常驻眼神微漂移 */
      if (def.gaze !== false) {
        var w = now / 1000;
        pose.left.lookX += 1.4 * Math.sin(0.42 * w) + 0.5 * Math.sin(1.0 * w);
        pose.right.lookX += 1.4 * Math.sin(0.42 * w + 1) + 0.5 * Math.sin(1.0 * w + 2);
        pose.left.lookY += 0.9 * Math.sin(0.58 * w);
        pose.right.lookY += 0.9 * Math.sin(0.58 * w + 1);
      }

      /* 小尺寸实例放大眼睛占比 */
      if (this._eyeScale !== 1) {
        pose.left.scaleX *= this._eyeScale;
        pose.left.scaleY *= this._eyeScale;
        pose.right.scaleX *= this._eyeScale;
        pose.right.scaleY *= this._eyeScale;
        pose.face.mouthSX *= this._eyeScale;
        pose.face.mouthSY *= this._eyeScale;
      }

      /* 实例主题色（team mate）：体色恒为主题色，眼睛仅覆盖默认色 */
      if (this._theme) {
        pose.body.color = this._theme.body;
        var chEye = this.character.palette.eye;
        if (pose.left.color === chEye) pose.left.color = this._theme.eyes;
        if (pose.right.color === chEye) pose.right.color = this._theme.eyes;
      }

      /* 开合度 = 配置基础值 × 眨眼弹簧 */
      var openS = clamp(this._open.x, 0.02, 1.5);
      pose.left.open = clamp(pose.left.open, 0, 1.3) * openS;
      pose.right.open = clamp(pose.right.open, 0, 1.3) * openS;
      pose.left.scaleX = Math.max(pose.left.scaleX, 0.05);
      pose.left.scaleY = Math.max(pose.left.scaleY, 0.05);
      pose.right.scaleX = Math.max(pose.right.scaleX, 0.05);
      pose.right.scaleY = Math.max(pose.right.scaleY, 0.05);

      /* 表情切换过渡插值 */
      var tt = now - this._transStart;
      if (this._transDur > 0 && tt < this._transDur && this._prevPose) {
        var mouthRing = pose.face.mouthRing;
        pose = lerpPose(this._prevPose, pose, easeInOutCubic(tt / this._transDur));
        pose.face.mouthRing = mouthRing;   /* 环形变由弹簧负责，不参与姿态插值 */
        pose.left.ring = this._ringCur[0];
        pose.right.ring = this._ringCur[1];
      }
      if (this._clickSeq) {
        var mixed = this._applyClickBeat(pose, now);
        if (mixed) pose = mixed;
      }
      /* 线稿是展示开关，不是表情关键帧。叠脸 / 过渡之后覆盖写入，避免 lerp 残留 */
      pose.body.sketch = this._style.sketch ? 1 : 0;
      return pose;
    },

    /** sequence 采样；播完按 settle 处理（hold / base / next） */
    _seqPose: function (t, now) {
      var seq = this._seq;
      var frames = seq.frames;
      var last = frames[frames.length - 1];

      if (t >= last.at) {
        if (!seq.done) {
          seq.done = true;
          var s = seq.settle;
          if (s === 'base') {
            this._prevPose = this._lastPose ? clonePose(this._lastPose) : clonePose(last.pose);
            this._transStart = now;
            this._transDur = this._def.transition || 500;
            this._seq = null;
            return null;
          }
          if (s && typeof s === 'object' && s.next) {
            this.setEmotion(s.next, { auto: true });
            return 'switch';
          }
        }
        return clonePose(last.pose);
      }

      if (t <= frames[0].at) return clonePose(frames[0].pose);
      for (var i = 0; i < frames.length - 1; i++) {
        var a = frames[i], b = frames[i + 1];
        if (t >= a.at && t < b.at) {
          var k = easeInOutCubic((t - a.at) / (b.at - a.at));
          return lerpPose(a.pose, b.pose, k);
        }
      }
      return clonePose(last.pose);
    }
  };

  /* ---------------- 对外入口 ---------------- */

  MM.create = function (target, opts) { return new Engine(target, opts); };
  MM.version = '1.0.0';

  /* 载入种子配置（emotions.js 在本脚本之前加载） */
  if (Array.isArray(window.EMOTION_SEED)) {
    window.EMOTION_SEED.forEach(function (raw) {
      var r = register(raw);
      if (!r.ok) console.warn('[MoodMates] 种子配置无效：', r.id, r.errors);
    });
  }
})();

/* ============================================================
 * Nimbo 云宝（通用）—— 蓬松云朵
 *   概念定稿：assets/concepts/concept-nimbo.png 方案 A（雾蓝薰衣草）
 *   剪影：七瓣扇贝波浪边，底部收平像坐在地上的云
 *   气质：慢半拍的松弛系伙伴，适合陪伴 / 冥想 / 天气类场景
 *   点击庆祝（不是图鉴表情）：一口吹出远近不一的小云泡；连点换扇区，近的先破、远的后破
 *   设计参数记录：docs/DESIGN-PROVENANCE.md
 * ============================================================ */
window.MoodMates.characters.register({
  id: 'nimbo',
  name: '云宝',
  en: { name: 'Nimbo', desc: 'A puffy scallop-edged cloud that drifts half a beat behind the world and blows cloud bubbles when pleased' },
  industry: 'general',
  desc: '雾蓝薰衣草色的蓬松云朵，波浪扇贝边，点一下会吹出远近不一的小云泡',

  body: { type: 'cloud', r: 0.94, lobes: 7, amp: 0.08, flat: 0.12 },
  face: { x: 0, y: 2, sx: 1, sy: 1, eye: 1 },

  palette: {
    body: '#B4C6EE',
    eye: '#2B3550',
    eyeHighlight: '#FFFFFF',
    blush: '#EFA9B8',
    zzz: '#9FB3D6',
    gloss: 0.2,
    states: {
      base: '#B4C6EE',
      dim: '#95A5CC',
      soft: '#C6D6F5',
      blush: '#E3B8D8',
      angry: '#D96B70',
      alert: '#E25B5B',
      off: '#9AA6C0'
    }
  },

  eyeStyle: {
    dx: 29, cy: 104, w: 26, h: 30,
    taper: 0.55, tilt: -2, bend: 0.1,
    highlight: { dx: 3.5, dy: -6, r: 3.2 }
  },

  features: {
    mouth: { w: 23, dy: 32 },
    blush: { dx: 41, dy: 20, rx: 12, ry: 7, max: 0.8 }
  },

  fxSkin: 'cloudpuff',

  /* 仅点击 celebrate() 使用，不进图鉴 */
  celebrateBeat: {
    expr: 'happy',
    mouth: 'o',
    fade: 240,
    frames: [
      { at: 0,   eyes: { both: { open: 0.95, lookX: 3, lookY: -2 } }, face: { blush: 0.25, mouthSY: 1.08 }, body: { x: 1, y: 1 } },
      { at: 220, eyes: { both: { lookX: 4, lookY: -5 } }, face: { blush: 0.4, mouthSY: 1.1 }, body: { x: 1, y: -1 } },
      { at: 560, eyes: { both: { lookX: 1, lookY: -3, scaleX: 1.06, scaleY: 0.92, y: -2 } }, face: { blush: 0.45, mouthSY: 1 }, body: { x: 0, y: -2, scale: 1.02, color: '@soft' } }
    ]
  },

  /* 云朵的性子更慢：待机轮换与呼吸都放缓 */
  emotions: {
    '02': { poolMs: [12000, 20000], anims: [
      { target: 'eyes', prop: 'lookX', type: 'glance', amp: 8, period: 6400 },
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 2, period: 5200, phase: 1.1 }
    ] },
    '10': { anims: [
      { target: 'eyes', prop: 'lookY', type: 'glance', amp: 5, period: 3800 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.8, period: 2000 }
    ] },
    '33': {
      desc: '笑眼轻轻眯起，腮红浅浅浮上来',
      en: { name: 'Done', desc: 'A quiet smile and a light blush' },
      pool: ['happy', 'happy2'],
      mouth: 'grin',
      body: { y: -2, spinFx: 0, confetti: 0 },
      eyes: { both: { y: -3 } },
      face: { blush: 0.4 }
    }
  }
});

/* ============================================================
 * Twinkle 亮亮（教育）—— 圆角五角星
 *   概念定稿：assets/concepts/concept-twinkle.png 方案 A（蜂蜜金 + 金框眼镜）
 *   剪影：五角圆角星
 *   眼睛：瞳孔眼（白眼底 + 暖棕虹膜），配 autoFit 圆框眼镜 ——
 *        镜框按实际眼位自动求出，追随目光、眨眼下滑、镜片扫光
 *   签名动作：环身星星爆闪；思考轨道里混入一支旋转铅笔
 *   设计参数记录：docs/DESIGN-PROVENANCE.md
 * ============================================================ */
window.MoodMates.characters.register({
  id: 'twinkle',
  name: '亮亮',
  en: { name: 'Twinkle', desc: 'A honey-gold rounded star in tiny auto-fit glasses — the classroom cheerleader' },
  industry: 'general',
  desc: '蜂蜜金的圆角五角星，戴一副会追着眼睛走的小圆框眼镜，教育场景的元气小老师',

  body: { type: 'star', r: 1.02, points: 5, inner: 0.74, sharp: 0.5 },
  face: { x: 0, y: 6, sx: 0.82, sy: 0.82, eye: 0.85 },

  palette: {
    body: '#F5B93F',
    eye: '#4A3316',
    blush: '#F0966E',
    mouth: '#6B4A2E',
    zzz: '#D9A85F',
    gloss: 0.3,
    states: {
      base: '#F5B93F',
      dim: '#D6A139',
      soft: '#F8CC66',
      blush: '#F2AE7E',
      angry: '#E8734F',
      alert: '#E25B5B',
      off: '#C2A265'
    }
  },

  eyeStyle: {
    dx: 27, cy: 102, w: 26, h: 34,
    taper: 0.38, tilt: 0, bend: 0,
    pupil: {
      irisR: 10, pupilR: 4.8,
      irisColor: '#7A4E2A',
      socket: '#FFFFFF',
      highlights: [
        { dx: -3.2, dy: -3.8, r: 3 },
        { dx: 3.8, dy: 2.4, r: 1.3, opacity: 0.6 }
      ]
    }
  },

  features: {
    mouth: { w: 24, dy: 34 },
    blush: { dx: 40, dy: 24, rx: 10, ry: 6, max: 0.85 },
    /* 不配眉毛：瞳孔眼 + 眼镜的信息量已足，情绪由眼睑开合 / 视线 / 嘴形表达 */
    accessories: [
      /* autoFit 圆框眼镜：镜框位置 / 半径由角色眼位眼形自动求出 */
      { kind: 'glasses', color: '#C9973F', fit: 1.3, strokeWidth: 2.6, glintPeriod: 5200 }
    ]
  },

  fxSkin: 'stardust',

  /* 小老师看到你做对了会更兴奋 */
  emotions: {
    '33': { body: { spinFx: 1, confetti: 1 } }
  }
});


/* ============================================================
 * [EB v1 引擎] emotion-ball/js/rings.js —— 球球渲染引擎（彩带体系，root 总馆同款）
 * ============================================================ */
/* ============================================================
 * rings.js —— 几何数据层（纯数据）
 *   EXPRESSIONS：25 组表情眼环（每组 [左眼环, 右眼环]，各 48 点轮廓）
 *   SHAPES：身体形状环（blob 圆胖 / wedge 三角 / gem 菱形）+ 脸部拟合参数
 *   坐标系：viewBox -15 -15 259 259，头部中心 114.2705
 * ============================================================ */
window.EB_RINGS = {
  HEAD_C: 114.2705,
  EYE_HALF: 21,
  STAR_GOLD: '#f4c34e',
  EXPRESSIONS: [[[[130.36,45.98],[132.71,46.19],[134.98,46.81],[137.11,47.83],[138.97,49.28],[140.47,51.09],[141.68,53.12],[142.73,55.23],[143.76,57.36],[144.78,59.49],[145.79,61.62],[146.79,63.76],[147.76,65.91],[148.71,68.07],[149.63,70.25],[150.52,72.43],[151.37,74.63],[151.99,76.91],[152.1,79.26],[151.64,81.57],[150.59,83.68],[149.04,85.45],[147.1,86.78],[144.9,87.62],[142.56,87.93],[140.22,87.71],[137.98,86.99],[135.93,85.82],[134.17,84.24],[132.78,82.34],[131.69,80.25],[130.77,78.08],[129.87,75.89],[128.94,73.72],[128,71.56],[127.03,69.4],[126.05,67.26],[125.05,65.12],[124.03,62.99],[122.93,60.9],[121.87,58.79],[121.03,56.59],[120.72,54.26],[121.1,51.93],[122.15,49.83],[123.75,48.1],[125.76,46.89],[128.01,46.19]],[[176.61,37.08],[178.72,37.59],[180.7,38.48],[182.52,39.65],[184.2,41.03],[185.71,42.59],[187.03,44.31],[188.2,46.14],[189.26,48.03],[190.27,49.96],[191.26,51.89],[192.23,53.84],[193.16,55.8],[194.05,57.78],[194.92,59.77],[195.74,61.78],[196.53,63.8],[197.27,65.84],[197.97,67.9],[198.47,70.01],[198.63,72.18],[198.4,74.33],[197.58,76.33],[195.95,77.72],[193.83,78.08],[191.71,77.65],[189.76,76.69],[188.03,75.38],[186.53,73.82],[185.28,72.05],[184.25,70.13],[183.4,68.14],[182.63,66.11],[181.87,64.07],[181.07,62.05],[180.25,60.04],[179.39,58.05],[178.49,56.07],[177.57,54.1],[176.61,52.15],[175.62,50.22],[174.59,48.31],[173.53,46.41],[172.54,44.48],[171.86,42.42],[171.76,40.26],[172.62,38.3],[174.45,37.19]]],[[[86.14,124.79],[89.16,124.92],[92.06,125.76],[94.68,127.27],[96.86,129.36],[98.48,131.92],[99.51,134.76],[100.12,137.73],[100.56,140.72],[101.01,143.72],[101.52,146.71],[102.06,149.69],[102.62,152.67],[103.2,155.64],[103.81,158.61],[104.44,161.57],[105.11,164.52],[105.81,167.47],[106.49,170.42],[106.72,173.44],[106.01,176.37],[104.37,178.9],[102.03,180.81],[99.26,181.99],[96.27,182.46],[93.25,182.25],[90.34,181.43],[87.65,180.04],[85.32,178.11],[83.51,175.7],[82.37,172.9],[81.66,169.96],[80.98,167],[80.32,164.05],[79.69,161.08],[79.08,158.12],[78.5,155.14],[77.94,152.16],[77.4,149.18],[76.89,146.2],[76.4,143.21],[75.93,140.21],[75.56,137.21],[75.7,134.19],[76.6,131.3],[78.22,128.76],[80.47,126.74],[83.18,125.4]],[[147.23,112.87],[150.24,113.13],[153.07,114.19],[155.53,115.94],[157.46,118.26],[158.73,121.01],[159.53,123.93],[160.21,126.88],[160.88,129.84],[161.52,132.8],[162.15,135.76],[162.74,138.73],[163.32,141.71],[163.87,144.69],[164.39,147.67],[164.9,150.66],[165.39,153.65],[165.8,156.65],[165.76,159.67],[164.98,162.59],[163.56,165.26],[161.61,167.58],[159.23,169.45],[156.52,170.77],[153.57,171.46],[150.55,171.4],[147.67,170.52],[145.19,168.79],[143.45,166.33],[142.57,163.44],[142.08,160.45],[141.61,157.46],[141.11,154.47],[140.59,151.48],[140.04,148.5],[139.47,145.53],[138.87,142.56],[138.25,139.59],[137.6,136.63],[136.94,133.68],[136.25,130.72],[135.59,127.77],[135.47,124.75],[136.07,121.78],[137.34,119.04],[139.19,116.65],[141.53,114.74],[144.26,113.44]]],[[[104.84,104.08],[109.39,104.89],[113.63,106.73],[117.32,109.5],[120.25,113.08],[122.22,117.25],[123.15,121.77],[122.92,126.39],[121.86,130.89],[120.61,135.35],[119.37,139.81],[118.15,144.27],[116.94,148.74],[115.74,153.21],[114.56,157.69],[113.39,162.17],[112.24,166.65],[111.13,171.15],[110.04,175.65],[108.89,180.13],[106.98,184.33],[103.8,187.67],[99.75,189.87],[95.25,190.93],[90.63,190.93],[86.11,189.97],[81.86,188.16],[78.05,185.54],[74.89,182.18],[72.62,178.16],[71.54,173.67],[71.94,169.08],[73.01,164.57],[74.13,160.08],[75.26,155.59],[76.42,151.11],[77.59,146.63],[78.77,142.15],[79.97,137.68],[81.18,133.22],[82.41,128.75],[83.65,124.29],[84.87,119.83],[86.33,115.43],[88.67,111.46],[91.9,108.15],[95.83,105.72],[100.23,104.35]],[[174.26,115.55],[178.59,116.54],[182.37,118.86],[185.31,122.2],[187.23,126.21],[188.12,130.57],[188.06,135.02],[187.52,139.44],[186.86,143.85],[186.11,148.25],[185.25,152.62],[184.3,156.98],[183.24,161.31],[182.07,165.61],[180.79,169.88],[179.39,174.12],[177.89,178.31],[176.27,182.47],[174.47,186.55],[172.17,190.35],[169.21,193.68],[165.73,196.46],[161.84,198.64],[157.66,200.16],[153.27,200.91],[148.83,200.69],[144.65,199.19],[141.47,196.14],[140.18,191.91],[140.82,187.53],[142.46,183.38],[144.16,179.26],[145.73,175.09],[147.18,170.87],[148.51,166.62],[149.73,162.33],[150.84,158.01],[151.84,153.67],[152.74,149.3],[153.54,144.91],[154.24,140.51],[154.85,136.1],[155.58,131.7],[156.93,127.46],[159.15,123.6],[162.12,120.29],[165.73,117.68],[169.84,116]]],[[[44.72,103.35],[47.95,103.93],[51.04,105.05],[53.93,106.62],[56.58,108.57],[58.97,110.83],[61.09,113.35],[62.93,116.07],[64.5,118.97],[65.79,121.99],[66.8,125.13],[67.52,128.34],[67.94,131.6],[68.08,134.89],[67.9,138.17],[67.4,141.42],[66.56,144.6],[65.33,147.66],[63.71,150.52],[61.69,153.11],[59.3,155.36],[56.54,157.16],[53.51,158.42],[50.29,159.07],[47,159.09],[43.76,158.5],[40.67,157.39],[37.78,155.82],[35.13,153.87],[32.75,151.6],[30.63,149.09],[28.78,146.36],[27.21,143.47],[25.92,140.44],[24.92,137.31],[24.2,134.1],[23.77,130.84],[23.64,127.55],[23.81,124.27],[24.31,121.01],[25.16,117.84],[26.38,114.78],[28,111.92],[30.02,109.33],[32.42,107.08],[35.17,105.28],[38.21,104.02],[41.43,103.37]],[[114.62,83.64],[118.31,83.88],[121.94,84.6],[125.44,85.77],[128.77,87.38],[131.86,89.4],[134.67,91.81],[137.13,94.56],[139.2,97.62],[140.85,100.93],[142.05,104.42],[142.79,108.05],[143.05,111.73],[142.83,115.42],[142.13,119.05],[140.95,122.55],[139.34,125.88],[137.3,128.96],[134.88,131.75],[132.11,134.2],[129.05,136.27],[125.75,137.93],[122.25,139.13],[118.63,139.86],[114.94,140.1],[111.25,139.86],[107.63,139.14],[104.12,137.97],[100.8,136.36],[97.7,134.34],[94.9,131.93],[92.44,129.18],[90.36,126.12],[88.72,122.81],[87.51,119.31],[86.78,115.69],[86.52,112.01],[86.74,108.32],[87.44,104.69],[88.61,101.18],[90.23,97.86],[92.27,94.78],[94.69,91.99],[97.45,89.54],[100.51,87.47],[103.82,85.81],[107.31,84.61],[110.94,83.88]]],[[[90.44,99.25],[93.11,99.26],[95.74,99.79],[98.37,100.3],[101,100.82],[103.64,101.33],[106.27,101.85],[108.9,102.37],[111.53,102.89],[114.16,103.41],[116.79,103.94],[119.42,104.47],[122.06,105],[124.69,105.53],[127.32,106.06],[129.94,106.6],[132.57,107.14],[135.2,107.68],[137.65,108.73],[139.5,110.65],[140.44,113.14],[140.36,115.81],[139.35,118.28],[137.48,120.18],[135,121.14],[132.32,121.11],[129.7,120.56],[127.08,120],[124.45,119.46],[121.82,118.93],[119.19,118.4],[116.56,117.87],[113.93,117.35],[111.29,116.83],[108.66,116.32],[106.02,115.82],[103.39,115.31],[100.76,114.79],[98.12,114.28],[95.49,113.75],[92.86,113.22],[90.23,112.68],[87.77,111.66],[85.93,109.74],[85.01,107.24],[85.06,104.57],[86.07,102.1],[87.96,100.22]],[[156.6,112.56],[158.91,112.66],[161.18,113.15],[163.45,113.64],[165.72,114.13],[167.99,114.62],[170.26,115.12],[172.53,115.62],[174.8,116.12],[177.07,116.62],[179.34,117.13],[181.6,117.64],[183.87,118.15],[186.14,118.67],[188.4,119.18],[190.67,119.7],[192.94,120.2],[195.12,120.96],[196.7,122.63],[197.45,124.82],[197.53,127.14],[197.07,129.41],[196.08,131.51],[194.49,133.18],[192.33,133.97],[190.04,133.68],[187.79,133.09],[185.52,132.57],[183.26,132.05],[180.99,131.54],[178.72,131.03],[176.45,130.53],[174.18,130.03],[171.91,129.54],[169.64,129.05],[167.37,128.56],[165.1,128.07],[162.83,127.58],[160.56,127.08],[158.29,126.57],[156.02,126.05],[153.9,125.14],[152.26,123.51],[151.32,121.4],[151.08,119.1],[151.53,116.82],[152.65,114.8],[154.41,113.31]]],[[[79.94,130.44],[83.08,130.57],[86.11,131.41],[88.89,132.89],[91.27,134.94],[93.15,137.46],[94.39,140.35],[95.11,143.42],[95.65,146.52],[96.2,149.62],[96.78,152.72],[97.39,155.81],[98.04,158.89],[98.72,161.97],[99.43,165.04],[100.18,168.1],[100.97,171.15],[101.81,174.18],[102.64,177.22],[103.01,180.34],[102.35,183.4],[100.66,186.04],[98.19,187.98],[95.28,189.16],[92.17,189.6],[89.03,189.37],[85.99,188.56],[83.16,187.2],[80.63,185.33],[78.55,182.97],[77.05,180.21],[76.1,177.21],[75.28,174.17],[74.5,171.11],[73.74,168.06],[73.02,164.99],[72.33,161.92],[71.68,158.83],[71.06,155.75],[70.47,152.65],[69.91,149.55],[69.37,146.45],[68.97,143.32],[69.12,140.18],[70.04,137.18],[71.7,134.51],[74.03,132.41],[76.86,131.04]],[[168.95,136.28],[171.31,136.97],[172.99,138.76],[173.66,141.13],[173.36,143.58],[172.24,145.79],[170.45,147.49],[168.22,148.58],[165.89,149.43],[163.57,150.31],[161.24,151.18],[158.9,152.02],[156.56,152.85],[154.21,153.65],[151.85,154.44],[149.48,155.2],[147.11,155.94],[144.73,156.65],[142.34,157.34],[139.95,158.01],[137.55,158.66],[135.14,159.27],[132.73,159.86],[130.31,160.43],[127.84,160.54],[125.53,159.69],[123.77,157.96],[122.89,155.66],[123.09,153.21],[124.36,151.09],[126.34,149.61],[128.69,148.83],[131.1,148.24],[133.51,147.62],[135.91,146.98],[138.31,146.32],[140.7,145.65],[143.08,144.95],[145.46,144.23],[147.83,143.49],[150.2,142.73],[152.56,141.95],[154.91,141.15],[157.25,140.32],[159.59,139.48],[161.92,138.61],[164.24,137.72],[166.54,136.78]]],[[[119.79,105.35],[121.94,105.42],[124.03,105.87],[126,106.72],[127.77,107.93],[129.27,109.47],[130.45,111.26],[131.29,113.23],[131.73,115.33],[131.79,117.47],[131.53,119.6],[131.11,121.71],[130.66,123.81],[130.27,125.92],[129.88,128.03],[129.49,130.14],[129.07,132.25],[128.62,134.35],[127.96,136.39],[126.96,138.29],[125.62,139.96],[123.99,141.36],[122.13,142.43],[120.11,143.15],[118,143.5],[115.85,143.45],[113.75,143],[111.79,142.15],[110.03,140.93],[108.54,139.38],[107.36,137.59],[106.53,135.61],[106.1,133.51],[106.07,131.37],[106.35,129.24],[106.77,127.14],[107.22,125.04],[107.64,122.93],[108.05,120.82],[108.45,118.71],[108.84,116.6],[109.25,114.49],[109.86,112.44],[110.83,110.52],[112.16,108.84],[113.78,107.44],[115.65,106.38],[117.67,105.68]],[[174.73,114.1],[176.71,114.59],[178.5,115.55],[180.04,116.88],[181.27,118.5],[182.17,120.33],[182.71,122.29],[182.9,124.32],[182.82,126.36],[182.56,128.38],[182.23,130.39],[181.89,132.4],[181.53,134.41],[181.16,136.41],[180.75,138.41],[180.3,140.4],[179.82,142.38],[179.18,144.31],[178.28,146.15],[177.14,147.83],[175.74,149.31],[174.11,150.53],[172.29,151.44],[170.32,151.97],[168.29,152.07],[166.29,151.69],[164.45,150.83],[162.87,149.54],[161.66,147.91],[160.83,146.06],[160.38,144.07],[160.29,142.04],[160.53,140.01],[160.98,138.02],[161.43,136.03],[161.84,134.04],[162.24,132.04],[162.62,130.03],[162.93,128.02],[163.24,126],[163.6,124],[164.11,122.03],[164.91,120.15],[165.99,118.43],[167.35,116.91],[168.94,115.64],[170.74,114.69],[172.7,114.15]]],[[[105.72,72.58],[108.82,72.78],[111.75,73.82],[114.27,75.64],[116.39,77.92],[118.42,80.29],[120.45,82.66],[122.47,85.03],[124.48,87.41],[126.49,89.8],[128.48,92.2],[130.47,94.6],[132.45,97.01],[134.43,99.42],[136.4,101.83],[138.37,104.25],[140.3,106.7],[141.85,109.39],[142.65,112.4],[142.63,115.51],[141.8,118.5],[140.21,121.17],[137.95,123.31],[135.17,124.7],[132.11,125.26],[129.02,124.98],[126.12,123.86],[123.67,121.94],[121.61,119.6],[119.66,117.17],[117.69,114.75],[115.73,112.33],[113.75,109.92],[111.77,107.52],[109.77,105.12],[107.77,102.73],[105.76,100.34],[103.75,97.96],[101.72,95.59],[99.68,93.23],[97.63,90.89],[95.91,88.3],[94.95,85.34],[94.92,82.24],[95.84,79.27],[97.56,76.68],[99.9,74.63],[102.67,73.22]],[[176.73,63.75],[179.52,64.43],[182.02,65.85],[184.15,67.78],[185.85,70.1],[187.08,72.7],[187.76,75.5],[187.76,78.37],[187.23,81.2],[186.58,84.01],[185.89,86.8],[185.16,89.59],[184.39,92.36],[183.59,95.13],[182.76,97.89],[181.88,100.64],[180.98,103.37],[180.02,106.09],[179.03,108.79],[177.99,111.48],[176.9,114.15],[175.5,116.66],[173.51,118.72],[171,120.11],[168.18,120.66],[165.34,120.29],[162.75,119.04],[160.62,117.12],[159.02,114.73],[158,112.04],[157.63,109.19],[157.98,106.34],[158.83,103.59],[159.86,100.9],[160.87,98.2],[161.85,95.49],[162.79,92.76],[163.7,90.03],[164.57,87.29],[165.41,84.53],[166.21,81.76],[166.98,78.99],[167.7,76.2],[168.38,73.4],[169,70.58],[169.79,67.82],[171.41,65.46],[173.88,64.03]]],[[[64.12,83.43],[66.69,84.08],[68.9,85.53],[70.57,87.6],[71.56,90.05],[71.86,92.69],[71.53,95.32],[70.55,97.78],[69.06,99.99],[67.36,102.03],[65.64,104.06],[63.95,106.11],[62.28,108.18],[60.63,110.27],[59,112.38],[57.41,114.5],[55.84,116.65],[54.29,118.82],[52.78,121],[51.31,123.22],[49.86,125.45],[48.42,127.69],[46.67,129.68],[44.36,130.96],[41.73,131.22],[39.22,130.38],[37.16,128.72],[35.64,126.55],[34.65,124.08],[34.2,121.46],[34.29,118.81],[34.94,116.24],[36.12,113.86],[37.54,111.61],[39.04,109.41],[40.54,107.21],[42.06,105.03],[43.61,102.87],[45.18,100.73],[46.79,98.6],[48.41,96.5],[50.07,94.42],[51.74,92.35],[53.45,90.31],[55.17,88.28],[56.94,86.3],[59.04,84.67],[61.48,83.65]],[[104.23,93.09],[106.97,93.77],[109.4,95.24],[111.32,97.31],[112.59,99.85],[113.4,102.57],[114.13,105.32],[114.87,108.06],[115.62,110.8],[116.37,113.54],[117.14,116.28],[117.9,119.02],[118.67,121.75],[119.45,124.49],[120.23,127.22],[121.03,129.95],[121.83,132.68],[122.6,135.41],[122.98,138.22],[122.57,141.02],[121.34,143.57],[119.44,145.67],[117.05,147.19],[114.34,148.04],[111.51,148.14],[108.77,147.45],[106.33,146.01],[104.38,143.96],[103.07,141.44],[102.21,138.73],[101.43,136],[100.65,133.27],[99.87,130.53],[99.09,127.8],[98.32,125.06],[97.55,122.33],[96.79,119.59],[96.04,116.85],[95.28,114.11],[94.53,111.37],[93.79,108.62],[93.05,105.88],[92.73,103.07],[93.18,100.27],[94.42,97.72],[96.32,95.62],[98.7,94.08],[101.4,93.21]]],[[[108.14,135.9],[111.13,136.06],[114.08,136.56],[116.95,137.39],[119.71,138.55],[122.31,140.03],[124.71,141.81],[126.86,143.89],[128.73,146.23],[130.27,148.8],[131.44,151.55],[132.22,154.44],[132.56,157.41],[132.47,160.4],[131.93,163.34],[130.96,166.17],[129.6,168.83],[127.87,171.28],[125.83,173.46],[123.51,175.35],[120.96,176.91],[118.23,178.13],[115.36,179],[112.42,179.52],[109.43,179.7],[106.44,179.54],[103.49,179.04],[100.62,178.21],[97.86,177.06],[95.26,175.58],[92.86,173.79],[90.71,171.71],[88.84,169.37],[87.3,166.81],[86.13,164.06],[85.35,161.17],[85.01,158.2],[85.11,155.21],[85.64,152.26],[86.61,149.43],[87.97,146.77],[89.7,144.33],[91.74,142.14],[94.06,140.25],[96.61,138.69],[99.34,137.47],[102.21,136.6],[105.15,136.08]],[[175.67,128.81],[177.16,128.85],[178.62,129.14],[180.01,129.67],[181.28,130.44],[182.41,131.42],[183.36,132.57],[184.12,133.85],[184.68,135.23],[185.05,136.68],[185.24,138.15],[185.27,139.64],[185.13,141.13],[184.85,142.59],[184.42,144.02],[183.85,145.4],[183.15,146.72],[182.33,147.96],[181.38,149.11],[180.32,150.16],[179.15,151.08],[177.88,151.87],[176.53,152.49],[175.1,152.91],[173.62,153.11],[172.13,153.07],[170.67,152.78],[169.28,152.24],[168.01,151.47],[166.88,150.49],[165.93,149.35],[165.18,148.06],[164.61,146.68],[164.24,145.24],[164.05,143.76],[164.02,142.27],[164.16,140.78],[164.44,139.32],[164.87,137.89],[165.44,136.51],[166.14,135.2],[166.96,133.95],[167.91,132.8],[168.97,131.75],[170.14,130.83],[171.4,130.04],[172.76,129.43],[174.19,129.01]]],[[[103.39,78.25],[106.56,78.38],[109.59,79.28],[112.29,80.94],[114.43,83.28],[115.86,86.1],[116.52,89.2],[116.32,92.37],[115.62,95.46],[114.86,98.55],[114.1,101.63],[113.36,104.72],[112.63,107.81],[111.91,110.91],[111.2,114.01],[110.51,117.1],[109.82,120.21],[109.16,123.31],[108.52,126.42],[107.84,129.53],[106.8,132.52],[105.04,135.16],[102.66,137.25],[99.81,138.63],[96.7,139.2],[93.54,138.96],[90.53,137.95],[87.87,136.24],[85.71,133.92],[84.21,131.13],[83.48,128.05],[83.5,124.88],[84,121.74],[84.7,118.64],[85.4,115.54],[86.08,112.44],[86.77,109.34],[87.48,106.24],[88.19,103.15],[88.92,100.05],[89.66,96.96],[90.41,93.88],[91.18,90.8],[91.95,87.71],[93.1,84.76],[94.95,82.19],[97.4,80.19],[100.28,78.86]],[[161.99,91.57],[165.07,92],[167.9,93.28],[170.32,95.23],[172.22,97.69],[173.49,100.53],[174.05,103.59],[173.93,106.7],[173.45,109.78],[172.9,112.85],[172.33,115.91],[171.71,118.97],[171.06,122.02],[170.38,125.06],[169.66,128.09],[168.91,131.12],[168.13,134.14],[167.33,137.15],[166.5,140.16],[165.58,143.14],[164.33,145.98],[162.5,148.5],[160.15,150.53],[157.38,151.95],[154.34,152.61],[151.24,152.43],[148.32,151.38],[145.83,149.52],[143.99,147.01],[142.95,144.08],[142.73,140.98],[143.25,137.91],[144.09,134.91],[144.94,131.91],[145.76,128.9],[146.54,125.89],[147.29,122.86],[148.01,119.83],[148.69,116.79],[149.34,113.74],[149.95,110.68],[150.54,107.62],[151.09,104.55],[151.6,101.47],[152.44,98.48],[154,95.79],[156.21,93.6],[158.94,92.12]]],[[[47.23,91.05],[51.61,92.47],[55.26,95.29],[57.96,99.03],[59.7,103.31],[60.56,107.85],[61.28,112.42],[62.11,116.97],[63.06,121.51],[64.11,126.01],[65.28,130.49],[66.56,134.94],[67.95,139.35],[69.44,143.73],[71.05,148.07],[72.77,152.37],[74.62,156.61],[76.52,160.83],[78.06,165.19],[78.52,169.78],[77.62,174.3],[75.2,178.22],[71.44,180.86],[66.96,181.91],[62.36,181.55],[57.99,180.06],[54.03,177.68],[50.59,174.58],[47.77,170.92],[45.62,166.83],[43.74,162.6],[41.96,158.33],[40.29,154.01],[38.72,149.66],[37.27,145.26],[35.93,140.83],[34.69,136.37],[33.56,131.88],[32.55,127.37],[31.65,122.83],[30.85,118.27],[30.2,113.69],[30.08,109.07],[30.85,104.51],[32.49,100.19],[35.01,96.32],[38.44,93.24],[42.64,91.35]],[[108.93,73.38],[113.76,73.6],[118.38,75.01],[122.49,77.56],[125.82,81.07],[128.1,85.34],[129.65,89.93],[131.04,94.58],[132.43,99.22],[133.82,103.87],[135.22,108.51],[136.6,113.16],[137.99,117.81],[139.36,122.46],[140.73,127.11],[142.13,131.76],[143.51,136.41],[144.82,141.08],[145.51,145.86],[144.91,150.66],[143.09,155.14],[140.17,158.99],[136.38,162.01],[132,164.05],[127.26,165.03],[122.42,164.86],[117.79,163.48],[113.67,160.95],[110.36,157.43],[108.17,153.11],[106.72,148.49],[105.36,143.83],[103.99,139.18],[102.62,134.53],[101.24,129.88],[99.87,125.23],[98.48,120.58],[97.09,115.93],[95.7,111.29],[94.29,106.64],[92.89,102],[91.49,97.36],[90.81,92.57],[91.38,87.77],[93.14,83.26],[96.02,79.37],[99.79,76.34],[104.18,74.32]]],[[[102.86,129.56],[106.39,129.96],[109.85,130.76],[113.21,131.94],[116.4,133.5],[119.39,135.42],[122.13,137.69],[124.56,140.28],[126.64,143.16],[128.33,146.29],[129.59,149.61],[130.37,153.08],[130.66,156.62],[130.43,160.16],[129.68,163.63],[128.42,166.96],[126.7,170.07],[124.54,172.89],[122.02,175.39],[119.18,177.52],[116.07,179.25],[112.76,180.54],[109.31,181.4],[105.78,181.82],[102.23,181.83],[98.7,181.42],[95.24,180.62],[91.88,179.44],[88.69,177.88],[85.7,175.96],[82.96,173.69],[80.53,171.1],[78.45,168.22],[76.76,165.1],[75.5,161.77],[74.72,158.31],[74.44,154.77],[74.67,151.22],[75.41,147.75],[76.67,144.42],[78.39,141.32],[80.55,138.49],[83.07,135.99],[85.91,133.86],[89.02,132.14],[92.33,130.84],[95.78,129.99],[99.31,129.56]],[[180.44,141.06],[183.61,141.1],[186.72,141.68],[189.66,142.86],[192.28,144.63],[194.43,146.96],[196,149.71],[197,152.72],[197.48,155.86],[197.51,159.03],[197.15,162.18],[196.43,165.27],[195.38,168.26],[194.07,171.15],[192.52,173.92],[190.74,176.55],[188.77,179.03],[186.6,181.35],[184.25,183.48],[181.74,185.41],[179.06,187.12],[176.23,188.56],[173.28,189.71],[170.21,190.52],[167.07,190.95],[163.9,190.91],[160.78,190.33],[157.84,189.15],[155.22,187.37],[153.08,185.04],[151.51,182.29],[150.51,179.28],[150.03,176.15],[150,172.98],[150.36,169.83],[151.07,166.74],[152.12,163.74],[153.43,160.85],[154.99,158.09],[156.76,155.46],[158.74,152.98],[160.91,150.66],[163.25,148.53],[165.77,146.59],[168.45,144.89],[171.27,143.45],[174.23,142.3],[177.29,141.48]]],[[[86.02,131.33],[88.42,131.69],[90.54,132.87],[92.12,134.71],[93.03,136.97],[93.17,139.39],[92.41,141.69],[90.78,143.48],[88.59,144.52],[86.19,144.97],[83.78,145.34],[81.37,145.72],[78.96,146.09],[76.54,146.45],[74.13,146.81],[71.72,147.16],[69.3,147.5],[66.88,147.84],[64.47,148.16],[62.05,148.47],[59.62,148.76],[57.2,149.03],[54.77,149.27],[52.34,149.49],[49.91,149.68],[47.53,149.28],[45.52,147.92],[44.04,145.99],[43.12,143.74],[42.85,141.32],[43.44,138.97],[45.04,137.17],[47.33,136.4],[49.76,136.2],[52.19,135.96],[54.62,135.7],[57.04,135.43],[59.46,135.15],[61.89,134.85],[64.31,134.54],[66.72,134.22],[69.14,133.89],[71.56,133.54],[73.97,133.19],[76.38,132.83],[78.79,132.45],[81.2,132.06],[83.61,131.67]],[[153.42,116.84],[155.92,117.69],[157.78,119.56],[158.72,122.03],[158.73,124.68],[157.84,127.18],[156.08,129.15],[153.71,130.33],[151.13,131],[148.55,131.65],[145.98,132.32],[143.4,132.98],[140.82,133.63],[138.23,134.27],[135.65,134.9],[133.06,135.53],[130.47,136.15],[127.88,136.76],[125.29,137.36],[122.69,137.94],[120.09,138.51],[117.49,139.06],[114.88,139.59],[112.27,140.1],[109.62,140.12],[107.17,139.14],[105.28,137.29],[104.18,134.88],[104.06,132.23],[105.03,129.78],[106.92,127.93],[109.35,126.87],[111.96,126.34],[114.57,125.8],[117.17,125.24],[119.77,124.67],[122.37,124.09],[124.96,123.5],[127.56,122.9],[130.15,122.29],[132.74,121.68],[135.32,121.05],[137.91,120.41],[140.49,119.76],[143.07,119.11],[145.65,118.44],[148.22,117.76],[150.78,117.03]]],[[[83.36,65.84],[86.61,66.42],[89.57,67.88],[92,70.12],[93.67,72.97],[94.46,76.17],[94.31,79.47],[93.61,82.71],[92.8,85.92],[92.02,89.14],[91.27,92.36],[90.56,95.6],[89.88,98.84],[89.23,102.09],[88.62,105.34],[88.03,108.61],[87.51,111.88],[87.01,115.15],[86.5,118.42],[85.65,121.62],[84.11,124.54],[81.9,126.99],[79.13,128.79],[75.98,129.8],[72.68,129.91],[69.47,129.13],[66.6,127.49],[64.24,125.18],[62.49,122.38],[61.42,119.25],[61.08,115.97],[61.36,112.67],[61.87,109.4],[62.45,106.13],[63.01,102.87],[63.61,99.61],[64.24,96.36],[64.9,93.11],[65.6,89.87],[66.33,86.64],[67.09,83.42],[67.89,80.2],[68.73,77],[69.89,73.9],[71.7,71.14],[74.1,68.86],[76.93,67.16],[80.07,66.12]],[[119.49,99.16],[121.99,99.28],[124.44,99.82],[126.9,100.34],[129.36,100.86],[131.81,101.38],[134.27,101.91],[136.72,102.44],[139.17,102.98],[141.62,103.52],[144.08,104.07],[146.52,104.62],[148.97,105.18],[151.42,105.74],[153.86,106.31],[156.31,106.89],[158.75,107.47],[161.2,108.02],[163.49,109.03],[165.16,110.87],[165.95,113.24],[165.87,115.74],[164.94,118.05],[163.17,119.8],[160.79,120.55],[158.31,120.29],[155.88,119.65],[153.44,119.06],[150.99,118.49],[148.55,117.92],[146.1,117.36],[143.65,116.81],[141.2,116.26],[138.75,115.73],[136.29,115.2],[133.84,114.67],[131.38,114.15],[128.93,113.62],[126.47,113.1],[124.02,112.57],[121.56,112.04],[119.11,111.5],[116.81,110.53],[115.08,108.73],[114.22,106.39],[114.29,103.9],[115.28,101.61],[117.12,99.93]]],[[[168.71,85.67],[170.73,86],[172.64,86.75],[174.37,87.85],[175.88,89.24],[177.11,90.88],[178.04,92.71],[178.71,94.65],[179.21,96.64],[179.64,98.65],[180.05,100.66],[180.45,102.67],[180.83,104.69],[181.18,106.71],[181.5,108.74],[181.77,110.78],[181.88,112.82],[181.71,114.87],[181.22,116.86],[180.41,118.74],[179.27,120.45],[177.83,121.91],[176.12,123.03],[174.2,123.74],[172.16,123.99],[170.13,123.75],[168.21,123.04],[166.49,121.93],[165.03,120.48],[163.88,118.79],[163.02,116.93],[162.49,114.95],[162.17,112.92],[161.85,110.89],[161.51,108.87],[161.14,106.84],[160.77,104.83],[160.37,102.81],[159.96,100.8],[159.52,98.79],[159.24,96.76],[159.3,94.71],[159.71,92.7],[160.48,90.8],[161.58,89.08],[163.01,87.61],[164.73,86.49],[166.67,85.83]],[[206.57,78.24],[208.3,78.8],[209.77,79.87],[210.99,81.22],[212.01,82.73],[212.85,84.34],[213.53,86.03],[214.08,87.77],[214.54,89.54],[214.95,91.31],[215.34,93.09],[215.7,94.88],[216.04,96.67],[216.36,98.46],[216.64,100.26],[216.89,102.07],[217.11,103.88],[217.25,105.7],[217.26,107.52],[217.1,109.33],[216.75,111.12],[216.16,112.84],[215.3,114.44],[214.04,115.75],[212.34,116.35],[210.58,115.96],[209.11,114.89],[207.97,113.48],[207.1,111.88],[206.44,110.18],[205.97,108.42],[205.62,106.63],[205.35,104.83],[205.11,103.02],[204.85,101.22],[204.55,99.42],[204.22,97.63],[203.87,95.84],[203.49,94.05],[203.09,92.28],[202.67,90.5],[202.32,88.71],[202.1,86.91],[202.1,85.08],[202.32,83.28],[202.77,81.51],[203.54,79.86],[204.82,78.59]]],[[[39.78,104.3],[42.64,105.01],[45.03,106.74],[46.73,109.15],[47.75,111.93],[48.35,114.83],[48.81,117.76],[49.31,120.68],[49.87,123.6],[50.48,126.5],[51.15,129.39],[51.86,132.27],[52.63,135.13],[53.44,137.98],[54.3,140.82],[55.19,143.65],[56.13,146.46],[57.1,149.26],[58.1,152.05],[58.86,154.92],[58.96,157.87],[58.18,160.72],[56.43,163.09],[53.84,164.48],[50.9,164.62],[48.08,163.75],[45.58,162.16],[43.51,160.05],[41.89,157.57],[40.67,154.87],[39.67,152.08],[38.73,149.26],[37.81,146.44],[36.94,143.61],[36.11,140.76],[35.34,137.9],[34.61,135.03],[33.92,132.14],[33.28,129.24],[32.7,126.34],[32.16,123.42],[31.67,120.5],[31.23,117.57],[31.14,114.61],[31.65,111.69],[32.74,108.94],[34.47,106.54],[36.89,104.86]],[[108.97,125.73],[111.9,126.2],[114.63,127.37],[117,129.16],[118.84,131.49],[119.99,134.23],[120.32,137.18],[119.85,140.11],[118.59,142.8],[116.78,145.16],[114.84,147.42],[112.89,149.67],[110.93,151.92],[108.97,154.16],[107.01,156.39],[105.03,158.62],[103.05,160.85],[101.07,163.06],[99.07,165.28],[97.09,167.5],[95.09,169.71],[93.05,171.88],[90.69,173.67],[87.89,174.66],[84.93,174.81],[82.02,174.22],[79.31,173],[76.92,171.24],[74.99,168.98],[73.7,166.3],[73.26,163.37],[73.74,160.45],[75.2,157.86],[77.17,155.63],[79.18,153.43],[81.18,151.23],[83.17,149.02],[85.16,146.8],[87.14,144.58],[89.11,142.35],[91.08,140.11],[93.04,137.87],[95,135.63],[96.95,133.38],[98.89,131.12],[100.87,128.89],[103.25,127.12],[106.02,126.04]]],[[[115.43,87.59],[118.19,88.24],[120.69,89.59],[122.69,91.59],[124.03,94.09],[124.63,96.87],[124.41,99.7],[123.7,102.45],[122.9,105.18],[122.12,107.92],[121.34,110.65],[120.57,113.39],[119.79,116.13],[119.02,118.87],[118.25,121.61],[117.48,124.35],[116.72,127.09],[115.97,129.83],[115.23,132.58],[114.45,135.32],[113.3,137.91],[111.49,140.09],[109.13,141.65],[106.41,142.48],[103.58,142.56],[100.82,141.91],[98.33,140.54],[96.33,138.53],[94.99,136.03],[94.38,133.26],[94.57,130.43],[95.25,127.67],[96.02,124.93],[96.79,122.19],[97.55,119.45],[98.31,116.7],[99.08,113.96],[99.85,111.22],[100.62,108.49],[101.4,105.75],[102.18,103.01],[102.95,100.27],[103.74,97.54],[104.51,94.8],[105.68,92.21],[107.5,90.04],[109.88,88.5],[112.59,87.67]],[[155.37,78.64],[158.04,79.15],[160.48,80.37],[162.53,82.16],[164.33,84.22],[166.1,86.3],[167.85,88.4],[169.58,90.51],[171.29,92.64],[172.98,94.78],[174.65,96.94],[176.3,99.12],[177.92,101.32],[179.51,103.54],[181.06,105.79],[182.57,108.07],[184.03,110.37],[185.2,112.83],[185.77,115.5],[185.73,118.23],[185.07,120.87],[183.8,123.28],[181.94,125.26],[179.57,126.6],[176.89,127.03],[174.24,126.43],[171.99,124.92],[170.26,122.8],[168.75,120.53],[167.22,118.27],[165.66,116.03],[164.07,113.81],[162.45,111.6],[160.82,109.41],[159.16,107.25],[157.47,105.1],[155.76,102.97],[154.03,100.85],[152.28,98.76],[150.51,96.68],[148.74,94.6],[147.29,92.29],[146.49,89.69],[146.36,86.97],[146.94,84.31],[148.23,81.91],[150.19,80.02],[152.66,78.89]]],[[[92.71,76.24],[95.76,76.59],[98.73,77.35],[101.56,78.53],[104.21,80.08],[106.63,81.96],[108.78,84.16],[110.61,86.62],[112.09,89.31],[113.19,92.17],[113.91,95.15],[114.24,98.2],[114.18,101.27],[113.73,104.31],[112.9,107.26],[111.7,110.09],[110.15,112.73],[108.28,115.17],[106.12,117.35],[103.71,119.24],[101.08,120.83],[98.27,122.07],[95.33,122.95],[92.3,123.44],[89.23,123.51],[86.18,123.17],[83.21,122.41],[80.38,121.23],[77.73,119.69],[75.31,117.8],[73.16,115.61],[71.33,113.14],[69.86,110.45],[68.75,107.59],[68.02,104.61],[67.7,101.56],[67.76,98.49],[68.22,95.46],[69.05,92.5],[70.25,89.68],[71.8,87.03],[73.67,84.59],[75.83,82.41],[78.24,80.52],[80.87,78.93],[83.67,77.69],[86.61,76.81],[89.64,76.32]],[[157.73,102.08],[159.31,102.13],[160.86,102.42],[162.35,102.95],[163.74,103.69],[165.01,104.62],[166.15,105.72],[167.13,106.95],[167.96,108.29],[168.63,109.72],[169.13,111.22],[169.45,112.76],[169.59,114.34],[169.55,115.91],[169.31,117.47],[168.88,118.99],[168.28,120.45],[167.52,121.83],[166.58,123.1],[165.48,124.23],[164.25,125.22],[162.89,126.02],[161.43,126.63],[159.91,127.02],[158.34,127.2],[156.76,127.14],[155.21,126.85],[153.73,126.33],[152.33,125.59],[151.06,124.65],[149.93,123.56],[148.94,122.33],[148.11,120.99],[147.44,119.56],[146.95,118.06],[146.62,116.51],[146.48,114.94],[146.52,113.37],[146.76,111.8],[147.18,110.28],[147.78,108.83],[148.56,107.45],[149.5,106.18],[150.59,105.05],[151.83,104.07],[153.18,103.26],[154.64,102.65],[156.17,102.26]]],[[[57.98,112.03],[61.01,112.26],[63.82,113.41],[66.22,115.27],[68.09,117.67],[69.36,120.44],[70.14,123.39],[70.64,126.39],[71.07,129.41],[71.58,132.42],[72.15,135.41],[72.76,138.4],[73.4,141.38],[74.09,144.35],[74.82,147.31],[75.59,150.26],[76.42,153.2],[77.3,156.12],[78.16,159.04],[78.68,162.04],[78.42,165.07],[77.28,167.88],[75.25,170.13],[72.54,171.49],[69.52,171.87],[66.51,171.44],[63.69,170.32],[61.16,168.61],[59.03,166.44],[57.38,163.89],[56.23,161.06],[55.34,158.15],[54.53,155.21],[53.73,152.27],[52.97,149.31],[52.25,146.35],[51.57,143.38],[50.93,140.4],[50.34,137.41],[49.78,134.41],[49.26,131.4],[48.78,128.39],[48.37,125.37],[48.37,122.33],[49.06,119.36],[50.44,116.65],[52.47,114.39],[55.04,112.78]],[[117.45,101.46],[120.57,101.84],[123.48,103.02],[125.99,104.91],[127.97,107.35],[129.25,110.23],[130.05,113.27],[130.76,116.34],[131.46,119.41],[132.15,122.49],[132.85,125.56],[133.55,128.63],[134.24,131.71],[134.93,134.78],[135.61,137.86],[136.32,140.93],[137.01,144],[137.66,147.09],[137.87,150.22],[137.25,153.3],[135.83,156.1],[133.73,158.45],[131.15,160.23],[128.22,161.38],[125.11,161.83],[121.98,161.5],[119.05,160.37],[116.52,158.51],[114.57,156.05],[113.37,153.14],[112.64,150.08],[111.95,147],[111.27,143.93],[110.58,140.85],[109.89,137.78],[109.2,134.7],[108.51,131.63],[107.81,128.56],[107.12,125.48],[106.42,122.41],[105.71,119.34],[105.02,116.27],[104.83,113.13],[105.42,110.04],[106.79,107.22],[108.84,104.83],[111.41,103.02],[114.33,101.87]]],[[[113.75,120.08],[118.16,120.78],[122.31,122.43],[125.98,124.96],[128.94,128.29],[131.02,132.23],[132.12,136.56],[132.1,141.02],[131.16,145.38],[129.94,149.68],[128.69,153.98],[127.44,158.27],[126.19,162.56],[124.92,166.85],[123.64,171.14],[122.35,175.42],[121.05,179.69],[119.76,183.97],[118.46,188.25],[117.05,192.49],[114.84,196.36],[111.47,199.27],[107.42,201.12],[103.04,201.99],[98.58,201.97],[94.18,201.19],[89.97,199.7],[86.1,197.48],[82.8,194.48],[80.41,190.72],[79.31,186.41],[79.87,182],[81.24,177.74],[82.57,173.47],[83.88,169.2],[85.19,164.92],[86.48,160.64],[87.75,156.36],[89.02,152.07],[90.28,147.78],[91.53,143.49],[92.77,139.19],[93.97,134.88],[95.5,130.69],[97.93,126.95],[101.16,123.87],[105.02,121.64],[109.3,120.36]],[[181.19,127.71],[185.4,128.03],[189.23,129.79],[192.19,132.8],[194.06,136.59],[194.87,140.74],[194.76,144.98],[194.21,149.18],[193.55,153.37],[192.79,157.55],[191.91,161.69],[190.91,165.82],[189.8,169.91],[188.57,173.97],[187.22,177.99],[185.72,181.96],[184.07,185.87],[182.26,189.7],[180.26,193.44],[177.85,196.92],[174.93,199.99],[171.62,202.64],[168,204.85],[164.13,206.59],[160.07,207.78],[155.86,208.24],[151.69,207.6],[148.31,205.16],[147.33,201.11],[148.48,197.06],[150.4,193.28],[152.24,189.46],[153.93,185.56],[155.48,181.61],[156.89,177.62],[158.17,173.57],[159.32,169.49],[160.35,165.38],[161.26,161.23],[162.06,157.07],[162.7,152.87],[163.29,148.67],[164.12,144.52],[165.46,140.5],[167.49,136.78],[170.16,133.49],[173.37,130.73],[177.08,128.7]]],[[[52.43,111.88],[55.76,112.3],[59,113.21],[62.08,114.57],[64.96,116.3],[67.61,118.36],[70.01,120.71],[72.16,123.3],[74.02,126.1],[75.61,129.06],[76.9,132.17],[77.89,135.38],[78.56,138.68],[78.89,142.02],[78.86,145.39],[78.45,148.72],[77.63,151.98],[76.39,155.11],[74.74,158.03],[72.67,160.68],[70.2,162.96],[67.38,164.79],[64.28,166.08],[61,166.78],[57.64,166.91],[54.3,166.49],[51.07,165.57],[47.99,164.22],[45.11,162.49],[42.46,160.42],[40.05,158.07],[37.91,155.48],[36.04,152.68],[34.46,149.72],[33.16,146.62],[32.17,143.4],[31.51,140.11],[31.18,136.76],[31.21,133.4],[31.62,130.06],[32.44,126.8],[33.67,123.68],[35.33,120.75],[37.4,118.1],[39.86,115.82],[42.68,114],[45.79,112.71],[49.07,112.01]],[[126.89,95.19],[130.56,95.44],[134.16,96.17],[137.64,97.36],[140.94,98.99],[143.98,101.06],[146.73,103.5],[149.13,106.29],[151.14,109.37],[152.72,112.69],[153.86,116.19],[154.54,119.8],[154.74,123.47],[154.45,127.14],[153.67,130.74],[152.43,134.2],[150.76,137.48],[148.69,140.51],[146.25,143.27],[143.48,145.69],[140.43,147.75],[137.14,149.39],[133.66,150.59],[130.06,151.32],[126.39,151.56],[122.72,151.31],[119.11,150.59],[115.63,149.4],[112.34,147.76],[109.29,145.7],[106.54,143.26],[104.14,140.47],[102.13,137.39],[100.55,134.07],[99.41,130.57],[98.73,126.96],[98.53,123.28],[98.83,119.62],[99.6,116.02],[100.84,112.56],[102.51,109.28],[104.59,106.25],[107.03,103.49],[109.79,101.07],[112.84,99.01],[116.13,97.36],[119.61,96.16],[123.22,95.43]]],[[[72.34,79.33],[74.93,79.64],[77.52,79.94],[80.12,80.25],[82.71,80.57],[85.3,80.91],[87.88,81.26],[90.47,81.63],[93.05,82],[95.63,82.39],[98.21,82.79],[100.79,83.21],[103.37,83.63],[105.94,84.07],[108.51,84.52],[111.09,84.92],[113.65,85.44],[115.99,86.56],[117.75,88.47],[118.68,90.89],[118.57,93.48],[117.47,95.83],[115.57,97.6],[113.16,98.56],[110.56,98.58],[108,98.1],[105.43,97.64],[102.85,97.19],[100.28,96.76],[97.7,96.33],[95.12,95.93],[92.54,95.53],[89.96,95.14],[87.38,94.77],[84.79,94.4],[82.2,94.06],[79.62,93.72],[77.02,93.41],[74.43,93.11],[71.84,92.81],[69.24,92.5],[66.78,91.69],[64.99,89.83],[64.25,87.35],[64.5,84.76],[65.58,82.39],[67.38,80.53],[69.74,79.45]],[[136.83,90.25],[139.33,90.71],[141.8,91.34],[144.28,91.93],[146.75,92.53],[149.22,93.14],[151.69,93.77],[154.15,94.4],[156.62,95.05],[159.08,95.71],[161.53,96.38],[163.98,97.07],[166.43,97.76],[168.88,98.47],[171.32,99.2],[173.75,99.94],[176.19,100.67],[178.49,101.74],[180.18,103.62],[181.12,105.98],[181.31,108.51],[180.69,110.96],[179.21,113.01],[176.98,114.19],[174.46,114.13],[172.02,113.41],[169.58,112.66],[167.14,111.93],[164.7,111.22],[162.25,110.52],[159.8,109.84],[157.34,109.17],[154.88,108.52],[152.42,107.88],[149.95,107.26],[147.48,106.64],[145.01,106.03],[142.54,105.42],[140.06,104.81],[137.59,104.21],[135.12,103.61],[132.78,102.62],[130.96,100.86],[129.93,98.55],[129.77,96.02],[130.49,93.59],[132.06,91.61],[134.31,90.46]]],[[[107.05,116.19],[110.26,116.71],[113.26,118],[115.85,119.97],[117.92,122.49],[119.29,125.45],[120.04,128.63],[120.54,131.86],[121.04,135.09],[121.54,138.31],[122.06,141.54],[122.59,144.77],[123.12,147.99],[123.67,151.21],[124.22,154.43],[124.8,157.65],[125.4,160.86],[125.95,164.08],[126.04,167.34],[125.2,170.49],[123.53,173.28],[121.14,175.49],[118.26,177.02],[115.11,177.87],[111.85,178.04],[108.63,177.56],[105.58,176.41],[102.87,174.58],[100.72,172.14],[99.35,169.18],[98.61,166],[98.04,162.78],[97.47,159.57],[96.91,156.35],[96.36,153.13],[95.83,149.9],[95.3,146.68],[94.78,143.45],[94.27,140.22],[93.76,137],[93.26,133.77],[92.82,130.53],[92.96,127.27],[93.87,124.15],[95.55,121.35],[97.88,119.07],[100.68,117.41],[103.79,116.44]],[[189.21,121.96],[191.36,122.71],[192.8,124.5],[193.41,126.73],[193.32,129.04],[192.59,131.23],[191.22,133.09],[189.28,134.34],[187.12,135.19],[184.95,136],[182.78,136.83],[180.61,137.63],[178.43,138.43],[176.24,139.2],[174.05,139.95],[171.85,140.69],[169.64,141.4],[167.43,142.09],[165.21,142.76],[162.98,143.42],[160.75,144.05],[158.51,144.66],[156.27,145.25],[154.02,145.81],[151.72,145.98],[149.57,145.18],[148.01,143.49],[147.25,141.31],[147.31,139],[148.16,136.86],[149.7,135.14],[151.74,134.05],[153.97,133.43],[156.21,132.84],[158.45,132.22],[160.68,131.59],[162.91,130.93],[165.13,130.26],[167.34,129.58],[169.55,128.87],[171.76,128.15],[173.95,127.41],[176.15,126.65],[178.33,125.87],[180.51,125.08],[182.68,124.26],[184.84,123.41],[186.98,122.53]]],[[[98.62,121.53],[100.72,121.6],[102.78,122.03],[104.72,122.83],[106.49,123.97],[108.01,125.42],[109.24,127.12],[110.15,129.02],[110.66,131.05],[110.78,133.15],[110.62,135.25],[110.34,137.33],[110.04,139.42],[109.76,141.5],[109.49,143.59],[109.21,145.68],[108.92,147.76],[108.6,149.84],[108.08,151.88],[107.18,153.78],[105.92,155.45],[104.34,156.83],[102.51,157.86],[100.51,158.52],[98.43,158.81],[96.33,158.72],[94.28,158.27],[92.33,157.47],[90.57,156.33],[89.03,154.89],[87.78,153.21],[86.85,151.32],[86.29,149.3],[86.13,147.2],[86.28,145.11],[86.57,143.02],[86.9,140.94],[87.2,138.86],[87.49,136.78],[87.79,134.69],[88.08,132.61],[88.4,130.53],[88.96,128.5],[89.88,126.61],[91.15,124.94],[92.73,123.56],[94.56,122.52],[96.54,121.84]],[[155.31,127.29],[157.36,127.43],[159.33,127.99],[161.14,128.96],[162.7,130.29],[163.95,131.92],[164.84,133.77],[165.35,135.75],[165.49,137.8],[165.35,139.85],[165.07,141.89],[164.79,143.92],[164.53,145.96],[164.26,148],[163.97,150.04],[163.65,152.06],[163.27,154.09],[162.7,156.06],[161.83,157.92],[160.68,159.62],[159.29,161.13],[157.69,162.41],[155.9,163.42],[153.97,164.1],[151.94,164.41],[149.89,164.32],[147.9,163.82],[146.06,162.92],[144.47,161.62],[143.24,159.98],[142.41,158.1],[142,156.09],[142.01,154.04],[142.32,152.01],[142.64,149.98],[142.96,147.95],[143.25,145.92],[143.51,143.88],[143.73,141.83],[143.97,139.79],[144.27,137.76],[144.74,135.76],[145.53,133.87],[146.62,132.13],[147.98,130.59],[149.57,129.28],[151.35,128.27],[153.28,127.58]]]],
  SHAPES: {"blob":{"ring":[[228.54,114.27],[228.29,121.74],[227.55,129.18],[226.32,136.56],[224.62,143.84],[222.45,150.99],[219.82,157.99],[216.73,164.8],[213.2,171.39],[209.25,177.73],[204.89,183.81],[200.15,189.59],[195.04,195.04],[189.59,200.15],[183.81,204.89],[177.73,209.24],[171.38,213.19],[164.78,216.7],[157.97,219.78],[150.98,222.4],[143.82,224.56],[136.54,226.25],[129.17,227.46],[121.74,228.19],[114.27,228.44],[106.8,228.2],[99.37,227.48],[91.99,226.27],[84.71,224.58],[77.56,222.42],[70.56,219.79],[63.75,216.71],[57.16,213.18],[50.81,209.24],[44.74,204.89],[38.96,200.15],[33.5,195.04],[28.39,189.59],[23.65,183.81],[19.29,177.73],[15.35,171.38],[11.82,164.79],[8.73,157.99],[6.09,150.99],[3.92,143.84],[2.21,136.56],[0.99,129.18],[0.25,121.74],[0,114.27],[0.25,106.8],[0.98,99.36],[2.2,91.98],[3.9,84.7],[6.06,77.54],[8.69,70.54],[11.78,63.73],[15.3,57.13],[19.25,50.78],[23.61,44.7],[28.35,38.92],[33.46,33.46],[38.91,28.34],[44.69,23.59],[50.77,19.24],[57.12,15.29],[63.72,11.77],[70.54,8.69],[77.54,6.07],[84.7,3.9],[91.98,2.21],[99.36,1],[106.8,0.26],[114.27,0.01],[121.74,0.25],[129.19,0.98],[136.57,2.19],[143.85,3.88],[151.01,6.04],[158.01,8.68],[164.82,11.76],[171.42,15.29],[177.77,19.24],[183.84,23.6],[189.62,28.35],[195.08,33.46],[200.2,38.92],[204.94,44.7],[209.29,50.78],[213.23,57.13],[216.76,63.73],[219.84,70.54],[222.48,77.54],[224.65,84.7],[226.34,91.98],[227.56,99.36],[228.29,106.8]],"face":{"x":0,"y":0,"sx":1,"sy":1,"eye":1},"tiltScale":1},"wedge":{"ring":[[192.97,114.27],[196.06,119.63],[199.44,125.48],[203.18,131.95],[207.37,139.22],[212.15,147.49],[217.65,157.09],[223,167.89],[227.01,179.36],[228.48,190.58],[226.47,200.37],[221.01,207.88],[213.01,213.01],[203.59,216.12],[193.71,217.79],[183.88,218.45],[174.46,218.53],[165.69,218.53],[157.46,218.53],[149.66,218.53],[142.21,218.53],[135.01,218.53],[128,218.53],[121.1,218.53],[114.27,218.53],[107.44,218.53],[100.54,218.53],[93.53,218.53],[86.33,218.53],[78.88,218.53],[71.08,218.53],[62.86,218.53],[54.08,218.53],[44.66,218.45],[34.83,217.79],[24.95,216.12],[15.53,213.01],[7.53,207.88],[2.07,200.36],[0.06,190.58],[1.54,179.36],[5.54,167.89],[10.9,157.09],[16.39,147.5],[21.17,139.22],[25.36,131.95],[29.1,125.48],[32.48,119.63],[35.57,114.27],[38.44,109.3],[41.13,104.64],[43.68,100.23],[46.12,96.01],[48.47,91.93],[50.76,87.96],[53.01,84.06],[55.25,80.19],[57.48,76.32],[59.73,72.42],[62.02,68.45],[64.38,64.38],[66.81,60.16],[69.36,55.74],[72.05,51.08],[74.92,46.11],[78.02,40.77],[81.5,35.15],[85.47,29.43],[90.02,23.78],[95.22,18.51],[101.08,14.09],[107.51,11.1],[114.27,10.01],[121.03,11.1],[127.46,14.09],[133.32,18.51],[138.52,23.78],[143.07,29.43],[147.04,35.15],[150.52,40.77],[153.62,46.11],[156.49,51.08],[159.18,55.74],[161.73,60.16],[164.16,64.38],[166.52,68.45],[168.81,72.42],[171.06,76.32],[173.29,80.19],[175.53,84.06],[177.78,87.96],[180.07,91.93],[182.42,96.01],[184.86,100.23],[187.41,104.64],[190.1,109.3]],"face":{"x":0,"y":24,"sx":0.7,"sy":0.7,"eye":0.79},"tiltScale":0.22},"gem":{"ring":[[227.48,114.27],[226.24,121.61],[224.05,128.72],[221.32,135.56],[218.2,142.12],[214.8,148.39],[211.15,154.4],[207.33,160.16],[203.34,165.7],[199.19,171.01],[194.92,176.15],[190.48,181.1],[185.91,185.91],[181.16,190.55],[176.26,195.06],[171.17,199.42],[165.87,203.65],[160.36,207.73],[154.61,211.65],[148.6,215.39],[142.31,218.9],[135.72,222.12],[128.84,224.94],[121.67,227.2],[114.27,228.49],[106.87,227.2],[99.7,224.94],[92.82,222.12],[86.24,218.9],[79.95,215.39],[73.94,211.65],[68.18,207.73],[62.67,203.65],[57.37,199.43],[52.28,195.06],[47.38,190.55],[42.64,185.91],[38.06,181.1],[33.62,176.15],[29.35,171.01],[25.2,165.69],[21.22,160.16],[17.39,154.4],[13.74,148.4],[10.34,142.12],[7.23,135.56],[4.49,128.72],[2.3,121.61],[1.06,114.27],[2.3,106.93],[4.49,99.82],[7.23,92.98],[10.34,86.42],[13.74,80.15],[17.39,74.14],[21.22,68.38],[25.2,62.85],[29.35,57.53],[33.63,52.39],[38.06,47.44],[42.64,42.64],[47.38,37.99],[52.28,33.48],[57.37,29.12],[62.67,24.89],[68.18,20.81],[73.94,16.89],[79.94,13.15],[86.24,9.64],[92.82,6.42],[99.7,3.6],[106.87,1.34],[114.27,0.05],[121.67,1.34],[128.84,3.6],[135.72,6.42],[142.31,9.64],[148.6,13.15],[154.61,16.89],[160.36,20.81],[165.87,24.9],[171.17,29.12],[176.26,33.48],[181.16,37.99],[185.91,42.64],[190.48,47.44],[194.91,52.39],[199.19,57.53],[203.34,62.85],[207.33,68.38],[211.15,74.14],[214.8,80.15],[218.2,86.42],[221.32,92.98],[224.05,99.82],[226.24,106.93]],"face":{"x":0,"y":0,"sx":0.89,"sy":0.89,"eye":0.99},"tiltScale":1}}
};


/* ============================================================
 * [EB v1 引擎] emotion-ball/js/emotions.js —— 球球渲染引擎（彩带体系，root 总馆同款）
 * ============================================================ */
/* ============================================================
 * emotions.js —— 数据层（纯数据，不含任何 DOM / 逻辑代码）
 *
 * ID 分段规则（十位 = 分组前缀，组间空号为扩展预留位，编号即对外契约不可重排）：
 *   00-09 生命周期 · 10-29 情绪反应 · 30-49 代理工作状态 · 50+ 自定义
 *
 * 32 套表情的完整定义，配置字段：
 *   pool      眼环索引池（25 组轮廓眼环，逐点弹簧插值切换）
 *   poolMs    池内轮换间隔 [min, max] ms
 *   poolSpeed 形变弹簧频率（检索 / 兴奋类 10，默认 6）
 *   blinkMs   眨眼间隔 [min, max] ms（null = 不眨眼）
 *   openness  常驻开合度（如睡眠 0.08、疲惫 0.55）
 *   antics    待机随机小动作（自旋 / 弹跳，9~18s 一次）
 *   ribbons / confetti  进入表情时的一次性事件：自旋甩彩带 / 撒花
 *   body.zzz   睡眠字母粒子（右上角循环漂浮）
 *   body.orbit 常驻水平环带（头顶彩带持续环绕）
 *   sequence  关键帧序列，settle: 'base' 回落基础姿态 / 'hold' 定格末帧
 *             / { next } 播完切换到下一个表情
 *   en        英文文案 { name, desc }（界面双语用，引擎不消费）
 *
 * 眼环池速查：
 *   0/8 平静 · 2/11/17/19 笑眼 · 3/21 圆睁 · 13/22/4 闭合困倦
 *   14/5/23 斜眼 · 7/16 怒目 · 15/9/20/12/18 扫读 · 10/1 聆听 · 24 羞怯
 * ============================================================ */

window.EMOTION_GROUPS = [
  { key: 'life',    name: '生命周期',     en: 'Lifecycle' },
  { key: 'emotion', name: '情绪反应',     en: 'Emotions' },
  { key: 'agent',   name: '代理工作状态', en: 'Agent States' },
  { key: 'custom',  name: '自定义',       en: 'Custom' }
];

window.EMOTION_SEED = [

  /* ==================== 1）生命周期（8 个） ==================== */

  {
    id: '00', name: '睡眠', group: 'life',
    desc: '闭眼成细线，右上角 zzz 缓缓飘起，头微垂，只剩缓慢呼吸',
    en: { name: 'Sleeping', desc: 'Eyes closed to thin lines, zzz drifting up at the top right, only a slow breath remains' },
    transition: 900,
    gaze: false,
    pool: [13, 22, 4], poolMs: [6000, 10000], blinkMs: null, openness: 0.08,
    body: { y: 4, rotate: -2, breathe: 0.018, color: '#EEEBE4', zzz: 1 },
    eyes: { both: { y: 4, lookY: 2 } },
    anims: [
      { target: 'eyes', prop: 'y', type: 'sine', amp: 1.2, period: 3600 }
    ]
  },
  {
    id: '01', name: '唤醒', group: 'life',
    desc: '从闭合眼环缓缓睁开，先揉眼似的眨两下，随后进入待机',
    en: { name: 'Waking', desc: 'Eyes slowly crack open with a couple of groggy blinks, then settles into idle' },
    transition: 320,
    pool: [13], poolMs: [800, 800], blinkMs: null,
    sequence: {
      settle: { next: '02' },
      frames: [
        { at: 0,    eyes: { both: { open: 0.1, y: 4 } } },
        { at: 420,  eyes: { left: { open: 0.55, y: 2 }, right: { open: 0.12, y: 4 } } },
        { at: 820,  eyes: { both: { open: 0.3, y: 3 } } },
        { at: 1400, eyes: { both: { open: 1, scaleX: 1.12, scaleY: 1.12, y: -2 } } },
        { at: 2100, eyes: { both: { open: 1, y: 0 } } }
      ]
    }
  },
  {
    id: '02', name: '待机放空', group: 'life',
    desc: '左看看、右看看，目光在两侧各停留片刻，偶尔自旋甩彩带 / 弹跳',
    en: { name: 'Idle', desc: 'Glances left, glances right, lingering on each side; an occasional ribbon spin or bounce' },
    transition: 700,
    pool: [0, 8], poolMs: [9000, 16000], blinkMs: [6000, 14000], antics: true,
    body: { breathe: 0.012 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'glance', amp: 10, period: 4800 },
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 2, period: 4100, phase: 1.1 }
    ]
  },
  {
    id: '03', name: '好奇', group: 'life',
    desc: '圆睁 / 平静 / 扫视眼环快速轮换，头微倾，目光轻轻打量',
    en: { name: 'Curious', desc: 'Wide, calm and scanning eye rings rotate quickly, head tilted, sizing things up' },
    transition: 420,
    pool: [3, 21, 0, 15], poolMs: [1800, 3200], blinkMs: [2500, 5500],
    body: { rotate: 4, breathe: 0.01 },
    eyes: { both: { lookY: -1 } },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 2.4, period: 2800 }
    ]
  },
  {
    id: '04', name: '发呆', group: 'life',
    desc: '半闭眼环慢轮换，双眼各望各的，偶尔弹跳提神',
    en: { name: 'Spacing Out', desc: 'Half-closed rings rotate slowly, each eye wandering its own way; a bounce now and then' },
    transition: 800,
    pool: [4, 22, 0], poolMs: [3500, 6000], blinkMs: [4000, 8000], antics: true,
    body: { rotate: -3, breathe: 0.008 },
    eyes: {
      left:  { lookX: -4, lookY: 2 },
      right: { lookX: 5,  lookY: -1 }
    },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 3, period: 6800 }
    ]
  },
  {
    id: '05', name: '加载苏醒', group: 'life',
    desc: '双眼缓慢交替亮起，像系统正在逐项初始化',
    en: { name: 'Booting', desc: 'Eyes light up in slow alternation, like a system initializing step by step' },
    transition: 480,
    pool: [0, 8], poolMs: [6000, 10000], blinkMs: null,
    anims: [
      { target: 'left',  prop: 'open', type: 'blink', interval: 1600, dur: 700 },
      { target: 'right', prop: 'open', type: 'blink', interval: 1600, dur: 700, phaseMs: 800 },
      { target: 'eyes',  prop: 'scale', type: 'pulse', amp: 0.04, period: 1600 }
    ]
  },
  {
    id: '06', name: '休眠', group: 'life',
    desc: '困倦眼环 + 半开合，几乎静止，只剩极弱的呼吸起伏',
    en: { name: 'Dormant', desc: 'Drowsy rings at half openness, nearly still, only the faintest breathing' },
    transition: 1200,
    gaze: false,
    pool: [4, 22, 13], poolMs: [4000, 8000], blinkMs: null, openness: 0.4,
    body: { y: 6, scale: 0.98, rotate: -1, breathe: 0.005, color: '#EBE8E1' },
    eyes: { both: { y: 5 } }
  },
  {
    id: '07', name: '抖动唤醒', group: 'life',
    desc: '整球轻颤，闭合眼环交错睁开，随后进入待机',
    en: { name: 'Shake Awake', desc: 'The whole body trembles as the eyes stagger open, then settles into idle' },
    transition: 220,
    pool: [13], poolMs: [800, 800], blinkMs: null,
    body: { breathe: 0.004 },
    anims: [
      { target: 'body', prop: 'x', type: 'jitter', amp: 4.5, speed: 10, decay: 1600 },
      { target: 'body', prop: 'rotate', type: 'jitter', amp: 3, speed: 8, decay: 1600 }
    ],
    sequence: {
      settle: { next: '02' },
      frames: [
        { at: 0,    eyes: { both: { open: 0.1 } } },
        { at: 380,  eyes: { left: { open: 0.4 }, right: { open: 0.12 } } },
        { at: 900,  eyes: { both: { open: 0.7, y: 1 } } },
        { at: 1600, eyes: { both: { open: 1, scaleX: 1.08, scaleY: 1.08, y: -1 } } }
      ]
    }
  },

  /* ==================== 2）情绪反应（12 个） ==================== */

  {
    id: '10', name: '开心', group: 'emotion',
    desc: '笑眼轮换，目光下看看、上看看，身体轻快起伏，偶尔自旋甩彩带',
    en: { name: 'Happy', desc: 'Smiling rings rotate, gaze bobs down and up, body bounces lightly; occasional ribbon spin' },
    transition: 380,
    pool: [2, 11, 17, 19], poolMs: [2500, 4500], blinkMs: [2500, 5000], antics: true,
    body: { y: -3, breathe: 0.014, color: '#F6EFE4' },
    eyes: { both: { y: -3 } },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'glance', amp: 6, period: 3000 },
      { target: 'body', prop: 'y', type: 'sine', amp: 2.2, period: 1400 }
    ]
  },
  {
    id: '11', name: '疑惑', group: 'emotion',
    desc: '斜眼环轮换，头微倾，一眼放大一眼收小',
    en: { name: 'Puzzled', desc: 'Skeptical rings, head atilt, one eye enlarged and the other shrunk' },
    transition: 420,
    pool: [14, 5, 8], poolMs: [2200, 3800], blinkMs: [2800, 5500],
    body: { rotate: -8, breathe: 0.008 },
    eyes: {
      left:  { y: -4, scaleX: 1.1, scaleY: 1.1 },
      right: { y: 3,  scaleX: 0.9, scaleY: 0.9, lookX: 3 }
    },
    anims: [
      { target: 'body', prop: 'rotate', type: 'sine', amp: 1.4, period: 3200 }
    ]
  },
  {
    id: '12', name: '失落', group: 'emotion',
    desc: '困倦 / 闭合眼环慢轮换，眼睛下沉，目光低垂',
    en: { name: 'Down', desc: 'Drowsy rings rotate slowly, eyes sinking with a downcast gaze' },
    transition: 820,
    pool: [4, 13, 22], poolMs: [4000, 7000], blinkMs: [4000, 8000],
    body: { y: 5, rotate: -4, breathe: 0.007, color: '#EDEAE3' },
    eyes: { both: { y: 8, scaleX: 0.88, scaleY: 0.88, lookY: 4 } },
    anims: [
      { target: 'eyes', prop: 'y', type: 'sine', amp: 1.6, period: 3600 }
    ]
  },
  {
    id: '13', name: '惊讶', group: 'emotion',
    desc: '双眼瞬间放大到 1.45 倍再回稳，身体轻抬定住',
    en: { name: 'Surprised', desc: 'Eyes pop to 1.45x in an instant then steady, the body lifting and freezing' },
    transition: 180,
    pool: [3, 21], poolMs: [2500, 4000], blinkMs: [1800, 3500],
    body: { y: -4, scale: 1.03, breathe: 0.006 },
    eyes: { both: { scaleX: 1.14, scaleY: 1.14, y: -2, lookY: -2 } },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0,   eyes: { both: { scaleX: 0.92, scaleY: 0.92 } } },
        { at: 150, eyes: { both: { scaleX: 1.45, scaleY: 1.45, y: -4 } }, body: { y: -7, scale: 1.05 } },
        { at: 420, eyes: { both: { scaleX: 1.22, scaleY: 1.22, y: -3 } } }
      ]
    }
  },
  {
    id: '14', name: '害羞', group: 'emotion',
    desc: '目光躲向一侧，脸颊在一秒多里渐渐泛起粉色',
    en: { name: 'Shy', desc: 'Gaze slips off to one side as the face slowly blushes pink over a second' },
    transition: 560,
    pool: [0, 24, 13], poolMs: [3000, 5500], blinkMs: [3000, 6000],
    /* base 色 = 序列终态粉，保证静态缩略图与最终观感一致 */
    body: { rotate: 6, breathe: 0.012, color: '#F4D3D0' },
    eyes: { both: { y: 4, lookX: 8, lookY: 3 } },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 2, period: 2600 }
    ],
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0,    body: { color: '#F3F0EA' } },
        { at: 1500, body: { color: '#F4D3D0' } }
      ]
    }
  },
  {
    id: '15', name: '疲惫', group: 'emotion',
    desc: '眼皮沉重半睁（低开合度 + 困倦眼环），目光下沉',
    en: { name: 'Tired', desc: 'Heavy eyelids at half openness with drowsy rings, gaze sinking low' },
    transition: 900,
    pool: [4, 22, 13], poolMs: [4000, 8000], blinkMs: null, openness: 0.55,
    body: { y: 4, rotate: -3, breathe: 0.016, color: '#EFECE5' },
    eyes: { both: { y: 5, lookY: 3 } },
    anims: [
      { target: 'eyes', prop: 'open', type: 'sine', amp: 0.06, period: 3400 }
    ]
  },
  {
    id: '16', name: '专注', group: 'emotion',
    desc: '专注眼环族轮换，双眼微微内聚，身体几乎不动',
    en: { name: 'Focused', desc: 'Focused ring family rotates, eyes converge slightly, body almost motionless' },
    transition: 320,
    pool: [7, 16, 11, 10], poolMs: [1800, 3200], blinkMs: [2800, 5500],
    body: { breathe: 0.004 },
    eyes: {
      left:  { x: 4 },
      right: { x: -4 }
    }
  },
  {
    id: '17', name: '慌张', group: 'emotion',
    desc: '圆睁眼环高频轮换，目光乱晃，整球细颤',
    en: { name: 'Panicked', desc: 'Wide rings rotate at high frequency, gaze darting about, the whole body quivering' },
    transition: 200,
    pool: [3, 21], poolMs: [900, 1800], blinkMs: [1200, 3000],
    body: { breathe: 0.006 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'jitter', amp: 6, speed: 11 },
      { target: 'eyes', prop: 'lookY', type: 'jitter', amp: 4, speed: 9 },
      { target: 'body', prop: 'x', type: 'jitter', amp: 1.6, speed: 8 }
    ]
  },
  {
    id: '18', name: '无奈', group: 'emotion',
    desc: '斜眼环轮换，头一歪，双眼翻向斜上方',
    en: { name: 'Resigned', desc: 'Sidelong rings, head cocked, both eyes rolling up and away' },
    transition: 560,
    pool: [14, 5, 23], poolMs: [2600, 4500], blinkMs: [4500, 8000],
    body: { rotate: 10, y: 2, breathe: 0.01 },
    eyes: { both: { lookX: 7, lookY: -8 } },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 1.6, period: 3000 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.2, period: 3000 }
    ]
  },
  {
    id: '19', name: '满意', group: 'emotion',
    desc: '目光正视前方，双眼有节奏地上下点动，如同点头认可',
    en: { name: 'Satisfied', desc: 'Gazing straight ahead while the eyes nod up and down in steady approval' },
    transition: 580,
    pool: [15, 8, 2], poolMs: [3500, 6000], blinkMs: [3500, 7000], antics: true,
    body: { breathe: 0.012, color: '#F5EFE6' },
    anims: [
      { target: 'eyes', prop: 'y', type: 'sine', amp: 5, period: 1050 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.6, period: 1050, phase: 0.6 }
    ]
  },
  {
    id: '20', name: '困惑', group: 'emotion',
    desc: '两眼大小不一，斜眼环轮换，注视方向对不齐',
    en: { name: 'Confused', desc: 'Mismatched eye sizes and sidelong rings, the two gazes never quite aligning' },
    transition: 480,
    pool: [14, 5, 8], poolMs: [2200, 3800], blinkMs: [2800, 5500],
    body: { rotate: -5, breathe: 0.008 },
    eyes: {
      left:  { scaleX: 1.16, scaleY: 1.16, y: -3, lookX: -3 },
      right: { scaleX: 0.8,  scaleY: 0.8,  y: 4,  lookX: 5 }
    },
    anims: [
      { target: 'left',  prop: 'lookX', type: 'sine', amp: 2.5, period: 3200 },
      { target: 'right', prop: 'lookX', type: 'sine', amp: 2.5, period: 3200, phase: 1.6 }
    ]
  },
  {
    id: '21', name: '生气', group: 'emotion',
    desc: '怒目圆睁，脸色在 0.25s 内迅速涨红并保持，身体细微发抖',
    en: { name: 'Angry', desc: 'Glaring eyes; the face flushes red within a quarter second and stays, body trembling' },
    transition: 260,
    pool: [7, 16], poolMs: [2200, 3800], blinkMs: [3500, 7000],
    /* base 色 = 序列终态红，保证静态缩略图与最终观感一致 */
    body: { y: 1, breathe: 0.004, color: '#E4574A' },
    anims: [
      { target: 'body', prop: 'x', type: 'jitter', amp: 1.1, speed: 7 }
    ],
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0,   body: { color: '#F3F0EA' } },
        { at: 250, body: { color: '#E4574A' } }
      ]
    }
  },

  /* ==================== 3）代理工作状态（12 个） ==================== */

  {
    id: '30', name: '思考中', group: 'agent',
    desc: '思考眼环轮换，目光在上方巡回，一条彩带在头顶水平环绕',
    en: { name: 'Thinking', desc: 'Thinking rings rotate, gaze patrolling upward, a ribbon orbiting the head' },
    transition: 480,
    pool: [8, 16, 14, 17, 5], poolMs: [2000, 3600], blinkMs: [3500, 7000],
    body: { rotate: -3, breathe: 0.01, orbit: 1 },
    eyes: { both: { lookY: -6, y: -2 } },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 9, period: 2600 }
    ]
  },
  {
    id: '31', name: '接收任务', group: 'agent',
    desc: '轻轻眨一下并放大，像点头确认收到',
    en: { name: 'Receiving', desc: 'A quick blink and slight enlargement, like a nod of acknowledgement' },
    transition: 220,
    pool: [19, 0, 8], poolMs: [4000, 8000], blinkMs: null,
    body: { breathe: 0.008 },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0 },
        { at: 100, eyes: { both: { open: 0.1 } } },
        { at: 280, eyes: { both: { open: 1, scaleX: 1.12, scaleY: 1.12, y: -2 } }, body: { y: -3 } },
        { at: 700, eyes: { both: { open: 1 } } }
      ]
    }
  },
  {
    id: '32', name: '处理中忙碌', group: 'agent',
    desc: '专注眼环轮换，目光小幅循环往复',
    en: { name: 'Busy', desc: 'Focused rings rotate while the gaze loops in tight little circuits' },
    transition: 360,
    pool: [7, 16, 11, 10], poolMs: [1800, 3200], blinkMs: [2800, 5500],
    body: { breathe: 0.008 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 6, period: 1200 },
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 4, period: 900, phase: 0.8 }
    ]
  },
  {
    id: '33', name: '任务完成', group: 'agent',
    desc: '笑眼轮换 + 自旋甩彩带 + 撒花庆祝',
    en: { name: 'Done', desc: 'Smiling rings, a celebratory ribbon spin and a burst of confetti' },
    transition: 240,
    pool: [2, 8, 17], poolMs: [1400, 2600], blinkMs: [2200, 4500],
    body: { ribbons: 1, confetti: 0.95 },
    eyes: { both: { y: -3 } },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0,   body: { y: 0 } },
        { at: 300, eyes: { both: { scaleX: 1.1, scaleY: 1.1, y: -5 } }, body: { y: -6 } },
        { at: 700, eyes: { both: { scaleX: 1.05, scaleY: 1.05, y: -4 } }, body: { y: -2 } },
        { at: 1100, body: { y: 0 } }
      ]
    }
  },
  {
    id: '34', name: '出错', group: 'agent',
    desc: '圆睁眼环，脸色红白两色急促闪动，最后定格在警示红',
    en: { name: 'Error', desc: 'Wide rings as the face flashes red and white, settling on alarm red' },
    transition: 220,
    pool: [3, 21], poolMs: [2000, 3600], blinkMs: null,
    body: { rotate: -6, color: '#E25B5B' },
    eyes: {
      left:  { y: -3, rotate: -6 },
      right: { y: 4,  rotate: 8 }
    },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'jitter', amp: 1.4, speed: 8, decay: 800 }
    ],
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0,   body: { color: '#E25B5B', rotate: -6 } },
        { at: 170, body: { color: '#F6F3EC', rotate: -4 } },
        { at: 340, body: { color: '#E25B5B', rotate: -7 } },
        { at: 510, body: { color: '#F6F3EC', rotate: -5 } },
        { at: 700, body: { color: '#DE5555', rotate: -6 } }
      ]
    }
  },
  {
    id: '35', name: '等待输入', group: 'agent',
    desc: '聆听眼环轮换，目光轻轻上下扫读',
    en: { name: 'Listening', desc: 'Listening rings rotate while the gaze sweeps gently up and down' },
    transition: 480,
    pool: [10, 1, 19], poolMs: [2800, 5000], blinkMs: [3000, 7000],
    body: { breathe: 0.01 },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 6, period: 2200 }
    ]
  },
  {
    id: '36', name: '联网加载', group: 'agent',
    desc: '左右眼轮流眨，像信号在两端来回跳',
    en: { name: 'Loading', desc: 'Eyes blink in alternation, like a signal hopping between two endpoints' },
    transition: 380,
    pool: [0, 8], poolMs: [6000, 10000], blinkMs: null,
    anims: [
      { target: 'left',  prop: 'open', type: 'blink', interval: 1200, dur: 380 },
      { target: 'right', prop: 'open', type: 'blink', interval: 1200, dur: 380, phaseMs: 600 },
      { target: 'eyes',  prop: 'lookX', type: 'sine', amp: 2, period: 2400 }
    ]
  },
  {
    id: '37', name: '复述回忆', group: 'agent',
    desc: '聆听眼环慢轮换，目光飘向上方翻检记忆',
    en: { name: 'Recalling', desc: 'Listening rings rotate slowly as the gaze drifts upward, leafing through memory' },
    transition: 780,
    pool: [10, 1, 19], poolMs: [4000, 8000], blinkMs: null,
    body: { rotate: -2, breathe: 0.009 },
    eyes: { both: { lookY: -9, lookX: 3, y: -3 } },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 2.4, period: 4000 }
    ]
  },
  {
    id: '38', name: '拒绝/受限', group: 'agent',
    desc: '斜眼下压，进入时连续摇头，明确表示不行',
    en: { name: 'Refusing', desc: 'A lowered sidelong gaze with a firm head-shake on entry: the answer is no' },
    transition: 380,
    pool: [14, 5, 23], poolMs: [2600, 4500], blinkMs: [4500, 8000], openness: 0.6,
    body: { y: 2, rotate: -2, color: '#EFE8E4' },
    eyes: { both: { lookY: 3, y: 2 } },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0,   body: { x: 0 } },
        { at: 130, body: { x: -9, rotate: -6 } },
        { at: 300, body: { x: 8,  rotate: 2 } },
        { at: 470, body: { x: -6, rotate: -5 } },
        { at: 630, body: { x: 4,  rotate: 0 } },
        { at: 800, body: { x: 0,  rotate: -2 } }
      ]
    }
  },
  {
    id: '39', name: '输出回复', group: 'agent',
    desc: '扫读眼环轮换，随输出节奏轻微缩放',
    en: { name: 'Replying', desc: 'Reading rings rotate with a gentle pulse that keeps time with the output' },
    transition: 360,
    pool: [15, 9], poolMs: [4000, 8000], blinkMs: null,
    body: { breathe: 0.008 },
    eyes: { both: { y: -2 } },
    anims: [
      { target: 'eyes', prop: 'scale', type: 'pulse', amp: 0.1, period: 680 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.2, period: 680 }
    ]
  },
  {
    id: '40', name: '检索资料', group: 'agent',
    desc: '6 组扫读眼环高速轮换（弹簧加速），目光左右快扫',
    en: { name: 'Searching', desc: 'Six reading rings rotate at high speed while the gaze sweeps rapidly side to side' },
    transition: 320,
    pool: [15, 9, 3, 20, 12, 18], poolMs: [1000, 1800], poolSpeed: 10, blinkMs: [1600, 4000],
    body: { breathe: 0.006 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'scan', amp: 11, period: 700 }
    ]
  },
  {
    id: '41', name: '停止终止', group: 'agent',
    desc: '闭合眼环，慢慢收小半闭后定格',
    en: { name: 'Powering Off', desc: 'Closing rings shrink to half-closed and quietly freeze' },
    transition: 280,
    gaze: false,
    pool: [13, 22], poolMs: [6000, 9000], blinkMs: null,
    body: { y: 3, breathe: 0.004, color: '#EBE8E2' },
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0 },
        { at: 1500, eyes: { both: { scaleX: 0.6, scaleY: 0.6, open: 0.35, y: 3 } }, body: { y: 4, scale: 0.97 } }
      ]
    }
  }
];


/* ============================================================
 * [EB v1 引擎] emotion-ball/js/ball.js —— 球球渲染引擎（彩带体系，root 总馆同款）
 * ============================================================ */
/* ============================================================
 * ball.js —— 渲染层（纯渲染，不含业务逻辑）
 *
 *   坐标系：viewBox -15 -15 259 259，头部中心 HEAD_C = 114.2705
 *   身体：形状轮廓环（blob 圆胖 / wedge 三角 / gem 菱形）折线路径
 *   眼睛：25 组表情眼环（48 点轮廓），由 engine 逐点插值后传入，
 *        本层负责球面投影、变换与 path 更新
 *   球面投影：按眼睛当前高度采样身体轮廓的局部半宽，经度换算 + 余弦压缩，
 *            自旋偏航时眼睛绕到背面自动隐藏（cos <= 0.02 判定）
 *   彩带：两种形态 ——
 *        自旋甩带（角速度达阈值时甩出、减速后回缩的 3D 轨道拖尾）
 *        常驻环带（低倾角水平轨道持续环绕，用于"思考中"等状态）
 *        均使用 5-stop 色相漂移渐变 + 头宽尾细轮廓 + 圆头封口
 *   撒花：一次性物理粒子（速度衰减 + 微重力 + 金色五角星混入）
 *   zzz：睡眠状态右上角循环漂浮的字母粒子
 * ============================================================ */
(function () {
  'use strict';

  var EB = (window.EmotionBall = window.EmotionBall || {});
  var RD = window.EB_RINGS;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var uid = 0;
  var TAU = Math.PI * 2;

  var HEAD_C = RD.HEAD_C;          /* 114.2705 */
  var EYE_HALF = RD.EYE_HALF;      /* 21 */
  var EXPR = RD.EXPRESSIONS;
  var STAR_GOLD = RD.STAR_GOLD;
  var CONFETTI_COLORS = ['#f9705c', '#5b95f0', '#3fbe86', '#f5b13f', '#9a72ee', '#35c3bd'];
  /* 五角星 path（内径比 0.42） */
  var STAR_PATH = (function () {
    var pts = [];
    for (var e = 0; e < 10; e++) {
      var a = -Math.PI / 2 + e * Math.PI / 5;
      var r = e % 2 === 0 ? 1 : 0.42;
      pts.push((Math.cos(a) * r).toFixed(3) + ' ' + (Math.sin(a) * r).toFixed(3));
    }
    return 'M' + pts.join('L') + 'Z';
  })();

  function el(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function shade(hex, amt) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var target = amt < 0 ? 0 : 255;
    var a = Math.abs(amt);
    r = Math.round(r + (target - r) * a);
    g = Math.round(g + (target - g) * a);
    b = Math.round(b + (target - b) * a);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  /* 轮廓环 → 闭合折线 path；48 点密度下视觉平滑 */
  function ringPath(ring) {
    var s = 'M';
    for (var i = 0; i < ring.length; i++) {
      s += (i ? 'L' : '') + ring[i][0].toFixed(2) + ' ' + ring[i][1].toFixed(2);
    }
    return s + 'Z';
  }
  function centroid(ring) {
    var x = 0, y = 0;
    for (var i = 0; i < ring.length; i++) { x += ring[i][0]; y += ring[i][1]; }
    return [x / ring.length, y / ring.length];
  }

  function createBall(container, opts) {
    opts = opts || {};
    var id = 'eb' + (uid++);
    var lite = !!opts.lite;
    var shape = RD.SHAPES[opts.shape] || RD.SHAPES.blob;
    var face = shape.face;
    var headRing = shape.ring;

    /* ---- 形状轮廓采样：每 2px 一行的 [minX, maxX]，供眼睛贴合任意身体轮廓 ---- */
    var silMinY = 1e9, silMaxY = -1e9;
    var i, p;
    for (i = 0; i < headRing.length; i++) {
      if (headRing[i][1] < silMinY) silMinY = headRing[i][1];
      if (headRing[i][1] > silMaxY) silMaxY = headRing[i][1];
    }
    var SIL_STEP = 2;
    var silRows = [];
    (function buildSil() {
      var rows = Math.ceil((silMaxY - silMinY) / SIL_STEP) + 1;
      for (var r = 0; r < rows; r++) {
        var y = silMinY + r * SIL_STEP;
        var lo = 1e9, hi = -1e9;
        for (var e = 0; e < headRing.length; e++) {
          var a = headRing[e], b = headRing[(e + 1) % headRing.length];
          var y0 = a[1], y1 = b[1];
          if ((y0 <= y && y1 >= y) || (y1 <= y && y0 >= y)) {
            var t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
            var x = a[0] + (b[0] - a[0]) * t;
            if (x < lo) lo = x;
            if (x > hi) hi = x;
          }
        }
        if (lo > hi) { lo = HEAD_C - 4; hi = HEAD_C + 4; }
        silRows.push([lo, hi]);
      }
    })();
    function silAt(y) {
      var r = Math.round((clamp(y, silMinY, silMaxY) - silMinY) / SIL_STEP);
      return silRows[clamp(r, 0, silRows.length - 1)];
    }

    /* ---- SVG 骨架 ---- */
    var svg = el('svg', {
      viewBox: '-15 -15 259 259',
      width: '100%',
      height: '100%',
      role: 'img',
      'aria-label': opts.label || 'AI 表情小球'
    });
    svg.style.display = 'block';
    svg.style.overflow = 'visible';

    var defs = el('defs', {});
    var grad = el('radialGradient', { id: id + 'g', cx: '38%', cy: '32%', r: '75%' });
    var stopA = el('stop', { offset: '0%' });
    var stopB = el('stop', { offset: '62%' });
    var stopC = el('stop', { offset: '100%' });
    grad.appendChild(stopA); grad.appendChild(stopB); grad.appendChild(stopC);
    defs.appendChild(grad);
    svg.appendChild(defs);

    var fxBack = el('g', { 'pointer-events': 'none' });
    svg.appendChild(fxBack);

    var bodyG = el('g', {});
    var head = el('path', { d: ringPath(headRing), fill: 'url(#' + id + 'g)', stroke: 'none', 'stroke-width': '2' });
    bodyG.appendChild(head);

    function buildEye(k) {
      /* data-jz-eye：真实眼球稳定标识（v1 path 眼，setEye 每帧写 transform 含 pose.lookX）。
       * probe 眼神跟随断言只认该节点；配饰层（眼镜等）不许带此标识
       *（2026-09-05 Codex 四轮打回）。纯标识属性，不改任何渲染行为。 */
      var node = el('path', {
        fill: '#1A1A1A', stroke: 'none', 'stroke-width': '1.6',
        'data-jz-eye': k === 0 ? 'left' : 'right'
      });
      node.setAttribute('d', ringPath(EXPR[0][k]));
      return { node: node, ring: EXPR[0][k], c: centroid(EXPR[0][k]) };
    }
    var eyeL = buildEye(0);
    var eyeR = buildEye(1);
    bodyG.appendChild(eyeL.node);
    bodyG.appendChild(eyeR.node);
    svg.appendChild(bodyG);

    var fxFront = el('g', { 'pointer-events': 'none' });
    svg.appendChild(fxFront);

    /* 眼睛基准中心：默认表情环的质心 */
    var BASE_C = [centroid(EXPR[0][0]), centroid(EXPR[0][1])];

    /* ---- zzz 睡眠粒子：三枚字母沿右上方向循环漂浮 ---- */
    var zzzNodes = null;
    if (!lite) {
      zzzNodes = [];
      for (var zi = 0; zi < 3; zi++) {
        var zn = el('text', {
          x: 0, y: 0, fill: '#A8A296', opacity: '0',
          'font-family': "'Space Grotesk', 'Noto Sans SC', sans-serif",
          'font-weight': '700', 'font-style': 'italic', 'text-anchor': 'middle'
        });
        zn.textContent = 'z';
        fxFront.appendChild(zn);
        zzzNodes.push(zn);
      }
    }

    container.appendChild(svg);

    /* ---- 彩带：3D 轨道拖尾 ---- */
    var trails = [];
    var planes = [];
    var planeG = 4;
    var baseHue = 0;
    var spawnAt = [];
    var spawnIdx = 0;
    var wasFast = false;
    var prevYaw = 0, prevNow = 0;
    var orbitNextAt = 0;
    var confPieces = [];

    function makePlanes() {
      /* 多轨道面交错：2~3 个不同倾角 / 滚转的平面，彩带轮流落在各面上，
       * 甩出的弧线在多个角度方向上交错，而非单一平面里的一组平行弧 */
      planes = [];
      var n = Math.random() < 0.45 ? 2 : 3;
      var roll0 = rand(-0.9, 0.9);
      for (var pi = 0; pi < n; pi++) {
        planes.push({
          tilt: rand(0.16, 0.72),
          roll: roll0 + pi * (Math.PI / n) + rand(-0.15, 0.15)
        });
      }
      planeG = Math.round(rand(4, 6));
      baseHue = rand(0, 360);
      spawnIdx = 0;
    }

    function orbitPoint(o, lam) {
      var hx = o.rad * Math.sin(lam);
      var hy = -o.rad * Math.cos(lam) * Math.sin(o.tilt);
      var ca = Math.cos(o.roll), sa = Math.sin(o.roll);
      return {
        x: HEAD_C + hx * ca - hy * sa,
        y: HEAD_C + hx * sa + hy * ca,
        z: Math.cos(lam) * Math.cos(o.tilt),
        l: lam
      };
    }

    /** 创建一条拖尾：独立 5-stop 渐变 + 前后两段 path */
    function createTrail(cfg) {
      if (trails.length > 8) return;
      var gradEl = el('linearGradient', { id: id + 'tg' + (uid++), gradientUnits: 'userSpaceOnUse' });
      var stops = [];
      for (var s = 0; s < 5; s++) {
        var st = el('stop', { offset: (s / 4).toFixed(3) });
        gradEl.appendChild(st);
        stops.push(st);
      }
      defs.appendChild(gradEl);
      var fill = 'url(#' + gradEl.getAttribute('id') + ')';
      var back = el('path', { stroke: 'none', fill: fill, opacity: '0' });
      var front = el('path', { stroke: 'none', fill: fill, opacity: '0' });
      fxBack.appendChild(back);
      fxFront.appendChild(front);
      trails.push({
        o: cfg.o, r: cfg.r, life: 0, ret: 0, hist: [],
        orbitMode: !!cfg.orbit,
        hue: cfg.hue,
        hueSpan: rand(45, 95) * (Math.random() < 0.5 ? 1 : -1),
        hueVel: rand(18, 42) * (Math.random() < 0.5 ? 1 : -1),
        gradEl: gradEl, stops: stops, back: back, front: front
      });
    }

    /** 自旋甩带：沿本次自旋的多个轨道平面轮流错峰甩出 */
    function spawnTrail(lam0, dir) {
      var pl = planes[spawnIdx % planes.length];
      var tierStep = 38 / Math.max(planeG - 1, 1);
      var rw = planeG <= 3 ? rand(8, 10.5) : planeG === 4 ? rand(6.6, 8.6) : rand(5.6, 7.4);
      createTrail({
        o: {
          lam: lam0, lamVel: dir * rand(0.5, 1.1),
          tilt: pl.tilt + rand(-0.04, 0.04),
          roll: pl.roll + rand(-0.05, 0.05),
          rad: 116 + spawnIdx * tierStep + rand(-1.5, 1.5),
          radVel: rand(0, 2.5),
          follow: rand(0.74, 0.94),
          carry: 0,
          arc: rand(2.2, 3.4)
        },
        r: rw,
        hue: baseHue + 360 * spawnIdx / Math.max(planeG, 1) + rand(-14, 14)
      });
      spawnIdx++;
    }

    /** 常驻环带：低倾角水平轨道匀速环绕（"思考中"等状态的持续效果） */
    function spawnOrbit(idx) {
      createTrail({
        orbit: true,
        o: {
          lam: rand(0, TAU),
          lamVel: (Math.random() < 0.5 ? -1 : 1) * rand(1.7, 2.3),
          tilt: rand(0.1, 0.22),
          roll: rand(-0.12, 0.12),
          rad: 124 + idx * 16,
          radVel: 0,
          follow: 0.8,
          carry: 0,
          arc: rand(2.4, 3.2)
        },
        r: rand(5.5, 7),
        hue: rand(0, 360)
      });
    }

    /* 拖尾轮廓：头宽尾细 + 首尾圆头封口，按 z 正负拆为前 / 后两段 */
    function buildTrail(pts, width) {
      var n = pts.length;
      var nx = [], ny = [], e;
      for (e = 0; e < n; e++) {
        var p0 = pts[e > 0 ? e - 1 : 0], p1 = pts[e < n - 1 ? e + 1 : n - 1];
        var dx = p1.x - p0.x, dy = p1.y - p0.y;
        var h = Math.hypot(dx, dy) || 1;
        dx /= h; dy /= h;
        var d = width * (0.5 + (e / (n - 1)) * 0.5) / 2;
        nx.push(-dy * d); ny.push(dx * d);
      }
      function cap(idx) {
        var hw = Math.max(Math.hypot(nx[idx], ny[idx]), 0.2);
        return 'A' + r2(hw) + ' ' + r2(hw) + ' 0 0 0 ';
      }
      function seg(a, b) {
        var s = '', k;
        for (k = a; k <= b; k++) s += (k === a ? 'M' : 'L') + r2(pts[k].x + nx[k]) + ' ' + r2(pts[k].y + ny[k]);
        s += b === n - 1 ? cap(b) : 'L';
        for (k = b; k >= a; k--) s += (k === b ? '' : 'L') + r2(pts[k].x - nx[k]) + ' ' + r2(pts[k].y - ny[k]);
        if (a === 0) s += cap(0) + r2(pts[0].x + nx[0]) + ' ' + r2(pts[0].y + ny[0]);
        return s + 'Z';
      }
      var front = '', back = '', d0 = 0;
      while (d0 < n) {
        var isF = pts[d0].z >= 0;
        var i2 = d0;
        while (i2 + 1 < n && (pts[i2 + 1].z >= 0) === isF) i2++;
        var a2 = Math.max(d0 - 1, 0), b2 = Math.min(i2 + 1, n - 1);
        if (b2 > a2) {
          var str = seg(a2, b2);
          if (isF) front += str; else back += str;
        }
        d0 = i2 + 1;
      }
      return { front: front, back: back };
    }

    function removeTrail(idx) {
      var rb = trails[idx];
      rb.back.remove(); rb.front.remove(); rb.gradEl.remove();
      trails.splice(idx, 1);
    }

    /* ---- 撒花：一次性物理粒子爆发 ---- */
    function burst(count) {
      if (lite) return;
      count = count || 20;
      for (var i = 0; i < count && confPieces.length < 60; i++) {
        var ang = (i / count) * TAU + rand(-0.35, 0.35);
        var spd = rand(170, 360);
        var star = Math.random() < 0.18;
        var round = !star && Math.random() < 0.3;
        var node;
        if (star) node = el('path', { d: STAR_PATH, fill: STAR_GOLD });
        else if (round) node = el('circle', { r: 1, fill: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0] });
        else node = el('rect', { x: -0.5, y: -0.5, width: 1, height: 1, rx: 0.24, fill: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0] });
        fxFront.appendChild(node);
        confPieces.push({
          x: HEAD_C + Math.cos(ang) * rand(96, 116),
          y: HEAD_C + Math.sin(ang) * rand(96, 116),
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - rand(20, 75),
          life: 0, max: rand(0.45, 0.85),
          r: star ? rand(4, 7) : rand(3.5, 8),
          rot: rand(0, 360), vr: rand(-260, 260),
          stretch: (!star && !round) ? 1.9 : 1,
          el: node
        });
      }
    }

    /* ---- 状态缓存 ---- */
    var curBodyColor = null;
    var curSketch = -1;

    function setBodyColor(color) {
      if (color === curBodyColor) return;
      curBodyColor = color;
      stopA.setAttribute('stop-color', shade(color, 0.22));
      stopB.setAttribute('stop-color', color);
      stopC.setAttribute('stop-color', shade(color, -0.12));
      if (curSketch > 0.5) head.style.stroke = 'var(--sketch-ink, ' + shade(color, -0.6) + ')';
    }

    /* ---- 眼睛：轮廓环形变 + 球面投影 ---- */
    function setEye(eye, pose, k, sketch, yaw) {
      /* d 更新：engine 传入插值后的环（引用不变则跳过）。
       * 缩放锚点用当前环自身质心 —— 眼环位置烘焙在数据里（如检索环偏向一侧），
       * 绕默认质心缩放会把位置偏差放大导致眼睛飞出身体 */
      var ring = pose.ring;
      if (ring && ring !== eye.ring) {
        eye.ring = ring;
        eye.node.setAttribute('d', ringPath(ring));
        eye.c = centroid(ring);
      }

      var base = eye.c || BASE_C[k];
      var open = clamp(pose.open, 0.02, 2.4);
      var sy = clamp(pose.scaleY * open * face.eye, 0.02, 2.4);
      var sxBase = pose.scaleX * face.eye;

      /* 纵向：脸部拟合映射 + 轮廓钳制 */
      var halfH = EYE_HALF * sy + 2;
      var ey0 = HEAD_C + face.y + (base[1] - HEAD_C) * face.sy + pose.y + pose.lookY;
      ey0 = clamp(ey0, silMinY + halfH, silMaxY - halfH);

      var sil = silAt(ey0);
      var cx0 = (sil[0] + sil[1]) / 2;
      var hw = Math.max((sil[1] - sil[0]) / 2, 12);

      /* 横向：经度换算 + 自旋偏航 + 余弦压缩 */
      var ox = face.x + (base[0] - HEAD_C) * face.sx + pose.x + pose.lookX;
      var theta = clamp(ox / hw, -1.15, 1.15);
      var total = theta + (yaw || 0);
      var cn = Math.cos(total);
      if (cn <= 0.02) {
        eye.node.style.display = 'none';
        return;
      }
      eye.node.style.display = '';
      var ex = cx0 + hw * Math.sin(total) * 0.985;
      var dyN = (ey0 - HEAD_C) / 130;
      var fy = Math.sqrt(1 - dyN * dyN * 0.22);

      eye.node.setAttribute('transform',
        'translate(' + r2(ex) + ' ' + r2(ey0) + ')' +
        (pose.rotate ? ' rotate(' + r2(pose.rotate) + ')' : '') +
        ' scale(' + r2(sxBase * cn) + ' ' + r2(sy * fy) + ')' +
        ' translate(' + r2(-base[0]) + ' ' + r2(-base[1]) + ')');

      var fill = sketch > 0.5 ? 'none' : pose.color;
      /* 线稿眼描边同样走主题墨色：暗色页面用浅墨，避免深色瞳色几乎不可见 */
      var stroke = sketch > 0.5 ? 'var(--sketch-ink, ' + pose.color + ')' : '';
      if (fill !== eye.lastFill) { eye.node.setAttribute('fill', fill); eye.lastFill = fill; }
      if (stroke !== eye.lastStroke) { eye.node.style.stroke = stroke; eye.lastStroke = stroke; }
    }

    /* ---- 每帧 ---- */
    function applyPose(pose) {
      var b = pose.body;
      var now = performance.now();
      var sketch = b.sketch || 0;

      bodyG.setAttribute('transform',
        'translate(' + r2(HEAD_C + b.x) + ' ' + r2(HEAD_C + b.y) + ')' +
        ' rotate(' + r2(b.rotate || 0) + ')' +
        ' scale(' + r2(b.scale) + ')' +
        ' translate(' + r2(-HEAD_C) + ' ' + r2(-HEAD_C) + ')');
      setBodyColor(b.color);

      if (sketch !== curSketch) {
        curSketch = sketch;
        if (sketch > 0.5) {
          /* 线稿模式：描边优先取页面主题墨色 --sketch-ink（暗色页浅墨、亮色页深墨），
           * 无主题变量时回退体色加深 */
          head.setAttribute('fill', 'none');
          head.style.stroke = 'var(--sketch-ink, ' + shade(b.color, -0.6) + ')';
          head.setAttribute('stroke-opacity', '0.85');
        } else {
          head.setAttribute('fill', 'url(#' + id + 'g)');
          head.style.stroke = '';
        }
      }

      var yaw = b.yaw || 0;
      setEye(eyeL, pose.left, 0, sketch, yaw);
      setEye(eyeR, pose.right, 1, sketch, yaw);

      if (lite) return;

      var dt = prevNow ? clamp((now - prevNow) / 1000, 0.001, 0.05) : 1 / 60;
      prevNow = now;

      /* ---- zzz 睡眠粒子：三枚字母错峰沿右上方向漂浮，先淡入后淡出 ---- */
      if (zzzNodes) {
        var zOn = (b.zzz || 0) > 0;
        for (var z = 0; z < zzzNodes.length; z++) {
          var znode = zzzNodes[z];
          if (!zOn) {
            if (znode.getAttribute('opacity') !== '0') znode.setAttribute('opacity', '0');
            continue;
          }
          var zp = (now * 0.00033 + z / 3) % 1;
          var zo = (zp < 0.18 ? zp / 0.18 : 1 - (zp - 0.18) / 0.82) * 0.8 * b.zzz;
          znode.setAttribute('opacity', zo.toFixed(3));
          znode.setAttribute('font-size', (12 + zp * 11).toFixed(1));
          znode.setAttribute('transform',
            'translate(' + r2(180 + zp * 34 + 4 * Math.sin(zp * 9)) + ' ' + r2(48 - zp * 42) + ')' +
            ' rotate(' + r2(-10 + zp * 14) + ')');
        }
      }

      /* ---- 自旋角速度（甩带触发源） ---- */
      var dYaw = yaw - prevYaw;
      if (!isFinite(dYaw) || Math.abs(dYaw) > 1.2) dYaw = 0;
      prevYaw = yaw;
      var vel = dYaw / dt;
      var fast = Math.abs(vel) >= 0.9;
      var dir = vel >= 0 ? 1 : -1;

      if (fast && !wasFast) {
        makePlanes();
        spawnAt = [];
        for (var q = 0; q < planeG; q++) spawnAt.push(now + q * rand(55, 105));
      }
      if (!fast) spawnAt.length = 0;
      wasFast = fast;
      if (Math.abs(vel) >= 5) {
        while (spawnAt.length && now >= spawnAt[0]) {
          spawnAt.shift();
          spawnTrail(yaw - rand(0, 0.18) * dir, dir);
        }
      }

      /* ---- 常驻环带补给：状态需要且数量不足时错峰生成 ---- */
      var orbitWant = (b.orbit || 0) > 0;
      if (orbitWant && now >= orbitNextAt) {
        var orbitCount = 0;
        for (var oc = 0; oc < trails.length; oc++) if (trails[oc].orbitMode) orbitCount++;
        if (orbitCount < 2) spawnOrbit(orbitCount);
        orbitNextAt = now + 700;
      }

      /* ---- 彩带逐帧更新 ---- */
      for (var ti = trails.length - 1; ti >= 0; ti--) {
        var rb = trails[ti];
        rb.life += dt;
        var retract = rb.orbitMode ? !orbitWant : (!fast || rb.life > 5);
        rb.ret = clamp(rb.ret + (retract ? dt / 0.5 : -dt / 0.35), 0, 1);
        if (retract && rb.ret >= 1) { removeTrail(ti); continue; }
        var o = rb.o;
        if (rb.orbitMode) {
          /* 环带：匀速环绕，叠加少量自旋跟随 */
          o.lam += o.lamVel * dt + dYaw * o.follow;
        } else if (fast) {
          o.carry = vel * o.follow;
          o.lam += dYaw * o.follow + o.lamVel * dt;
        } else {
          o.lam += (o.carry + o.lamVel) * dt;
          o.carry *= Math.exp(-2.6 * dt);
          o.lamVel *= Math.exp(-2.6 * dt);
        }
        o.rad += o.radVel * dt;

        var hist = rb.hist;
        var lastL = hist.length ? hist[hist.length - 1].l : o.lam - 0.001 * dir;
        var dl = o.lam - lastL;
        var steps = Math.min(Math.ceil(Math.abs(dl) / 0.09), 24);
        for (var st = 1; st <= steps; st++) hist.push(orbitPoint(o, lastL + dl * st / steps));
        if (!hist.length) hist.push(orbitPoint(o, o.lam));

        /* 回缩：smoothstep 弧长收窄 + 首点插值细修 + 上限 48 点 */
        var span = o.arc * (1 - rb.ret * rb.ret * (3 - 2 * rb.ret));
        while (hist.length > 2 && Math.abs(o.lam - hist[0].l) > span) hist.shift();
        var over = Math.abs(o.lam - hist[0].l) - span;
        if (hist.length >= 2 && over > 0) {
          var tl = hist[0].l + (o.lam - hist[0].l >= 0 ? 1 : -1) * over;
          hist[0] = orbitPoint(o, tl);
        }
        if (hist.length > 48) hist.splice(0, hist.length - 48);

        var zHead = Math.cos(o.lam) * Math.cos(o.tilt);
        var pz = 0.72 + 0.28 * clamp(zHead, 0, 1);
        var grow = Math.min(rb.life / 0.34, 1);
        grow = grow * grow * (3 - 2 * grow);
        var width = rb.r * pz * 1.7 * grow * (1 - 0.72 * rb.ret * rb.ret);
        var fade = Math.min(rb.life / 0.26, 1).toFixed(3);

        if (hist.length < 2 || width < 0.5) {
          rb.back.setAttribute('opacity', '0');
          rb.front.setAttribute('opacity', '0');
          continue;
        }
        var dstr = buildTrail(hist, width);
        rb.back.setAttribute('d', dstr.back);
        rb.front.setAttribute('d', dstr.front);
        rb.back.setAttribute('opacity', fade);
        rb.front.setAttribute('opacity', fade);

        /* 5-stop 色相漂移渐变，端点跟随拖尾首尾 */
        var hue = rb.hue + rb.hueVel * rb.life;
        for (var si = 0; si < rb.stops.length; si++) {
          var frac = si / (rb.stops.length - 1);
          var hv = hue + frac * rb.hueSpan;
          rb.stops[si].setAttribute('stop-color',
            'hsl(' + (((hv % 360) + 360) % 360).toFixed(0) + ' 56% ' + (56 + 11 * frac).toFixed(0) + '%)');
        }
        var tail = hist[0], headP = hist[hist.length - 1];
        rb.gradEl.setAttribute('x1', tail.x.toFixed(1));
        rb.gradEl.setAttribute('y1', tail.y.toFixed(1));
        rb.gradEl.setAttribute('x2', headP.x.toFixed(1));
        rb.gradEl.setAttribute('y2', headP.y.toFixed(1));
      }

      /* ---- 撒花更新：速度衰减 0.94^60dt + 微重力 40/s ---- */
      for (var ci = confPieces.length - 1; ci >= 0; ci--) {
        var pc = confPieces[ci];
        pc.life += dt;
        if (pc.life >= pc.max) {
          pc.el.remove();
          confPieces.splice(ci, 1);
          continue;
        }
        pc.x += pc.vx * dt;
        pc.y += pc.vy * dt;
        var drag = Math.pow(0.94, 60 * dt);
        pc.vx *= drag;
        pc.vy = pc.vy * drag + 40 * dt;
        pc.rot += pc.vr * dt;
        var u = pc.life / pc.max;
        var fd = u < 0.1 ? u / 0.1 : Math.pow(1 - (u - 0.1) / 0.9, 1.7);
        var sz = Math.max(pc.r * (1 - 0.4 * u), 0.5);
        pc.el.setAttribute('opacity', fd.toFixed(3));
        pc.el.setAttribute('transform',
          'translate(' + r2(pc.x) + ' ' + r2(pc.y) + ') rotate(' + r2(pc.rot) + ') scale(' + r2(sz) + ' ' + r2(sz * pc.stretch) + ')');
      }
    }

    function destroy() {
      if (svg.parentNode) svg.parentNode.removeChild(svg);
    }

    return { svg: svg, applyPose: applyPose, burst: burst, destroy: destroy };
  }

  EB.createBall = createBall;
})();


/* ============================================================
 * [EB v1 引擎] emotion-ball/js/engine.js —— 球球渲染引擎（彩带体系，root 总馆同款）
 * ============================================================ */
/* ============================================================
 * engine.js —— 驱动层（依赖 ball.js；消费 emotions.js 纯数据）
 *
 * 职责：
 *   1. 配置注册中心 EmotionBall.config：校验 / 深合并默认值 / 导入导出
 *   2. EmotionEngine：rAF 状态机 + 动画原语 + 平滑插值 + 兜底 + 待机策略
 *   3. 对外 SDK：EmotionBall.create(el, opts) → engine 实例
 *
 * 对外 API（宿主工具只依赖这一层）：
 *   const ball = EmotionBall.create(el, { emotion:'02', idle:true });
 *   ball.setEmotion('30');
 *   ball.handleAIMessage({ emotionId:'30', tips:'正在思考' });   // 或 JSON 字符串
 *   ball.on('change'|'tips'|'error', cb);
 *   ball.startTour(ids, interval) / ball.stopTour();
 *   ball.registerEmotion(config); ball.destroy();
 *   EmotionBall.config.exportConfig() / importConfig(json);
 * ============================================================ */
(function () {
  'use strict';

  var EB = (window.EmotionBall = window.EmotionBall || {});
  var RD = window.EB_RINGS;
  var EXPR = RD.EXPRESSIONS;
  var TAU = Math.PI * 2;
  var FALLBACK_ID = '02';

  /* ---------------- 基础工具 ---------------- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /* 临界阻尼弹簧步进：springStep(spring, 频率, 阻尼比, dt)，子步 1/120 保证数值稳定 */
  function spring(v0) { return { x: v0, v: 0, t: v0 }; }
  function springStep(s, w, z, dt) {
    s.v += (-2 * z * w * s.v - w * w * (s.x - s.t)) * dt;
    s.x += s.v * dt;
    if (!isFinite(s.x) || !isFinite(s.v)) { s.x = s.t; s.v = 0; }
  }

  /* 两组眼环逐点插值 */
  function lerpRing(a, b, t) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) {
      out[i] = [a[i][0] + (b[i][0] - a[i][0]) * t, a[i][1] + (b[i][1] - a[i][1]) * t];
    }
    return out;
  }

  /* 弹跳：4 段递减抛物线（高度 48/28/14/6，时长 0.5/0.382/0.27/0.177s） */
  var BOUNCE_SEGS = [{ h: 48, d: 0.5 }, { h: 28, d: 0.382 }, { h: 14, d: 0.27 }, { h: 6, d: 0.177 }];
  var BOUNCE_TOTAL = BOUNCE_SEGS.reduce(function (s, q) { return s + q.d; }, 0);

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      return clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    }).join('');
  }
  function lerpColor(a, b, t) {
    if (a === b) return b;
    var A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
  }

  /* ---------------- Pose：默认值 / 合并 / 插值 ---------------- */

  var DEFAULT_BODY = {
    x: 0, y: 0, scale: 1, rotate: 0, color: '#F3F0EA', breathe: 0.01,
    ribbons: 0, confetti: 0, sketch: 0,
    zzz: 0,      /* 睡眠字母粒子（0~1） */
    orbit: 0     /* 常驻水平环带（0~1） */
  };
  var DEFAULT_EYE = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, open: 1, color: '#1A1A1A', lookX: 0, lookY: 0 };

  /* 眼环数据自带左右不对称，默认姿态不叠加高低差 */
  function defaultPose() {
    return {
      body: Object.assign({}, DEFAULT_BODY),
      left: Object.assign({}, DEFAULT_EYE),
      right: Object.assign({}, DEFAULT_EYE)
    };
  }
  function clonePose(p) {
    return {
      body: Object.assign({}, p.body),
      left: Object.assign({}, p.left),
      right: Object.assign({}, p.right)
    };
  }

  /** 把配置片段（body / eyes.both / eyes.left / eyes.right）合并到 pose 上（原地修改） */
  function applySpec(pose, spec) {
    if (!spec) return pose;
    if (spec.body) Object.assign(pose.body, spec.body);
    var e = spec.eyes;
    if (e) {
      if (e.both) { Object.assign(pose.left, e.both); Object.assign(pose.right, e.both); }
      if (e.left) Object.assign(pose.left, e.left);
      if (e.right) Object.assign(pose.right, e.right);
    }
    return pose;
  }

  function lerpPose(a, b, t) {
    var out = defaultPose();
    ['body', 'left', 'right'].forEach(function (part) {
      var pa = a[part], pb = b[part], po = out[part];
      for (var k in pb) {
        var vb = pb[k];
        if (typeof vb === 'number') po[k] = lerp(pa[k] != null ? pa[k] : vb, vb, t);
        else if (k === 'color') po[k] = lerpColor(pa[k] || vb, vb, t);
        else po[k] = vb;
      }
    });
    return out;
  }

  /* ---------------- 动画原语 ---------------- */

  var ANIM_TYPES = {
    /** 正弦漂移/呼吸/扫视 */
    sine: function (a, t) {
      return a.amp * Math.sin(TAU * t / (a.period || 2000) + (a.phase || 0));
    },
    /** 节奏缩放：0 → amp 平滑往复 */
    pulse: function (a, t) {
      return a.amp * 0.5 * (1 - Math.cos(TAU * t / (a.period || 1000) + (a.phase || 0)));
    },
    /** 随机小抖动（多正弦伪噪声），decay 毫秒内衰减到 0 */
    jitter: function (a, t, eng) {
      var s = t / 1000 * (a.speed || 8);
      var v = (Math.sin(s * 3.1 + eng._seed) +
               Math.sin(s * 5.7 + eng._seed * 2.3) +
               Math.sin(s * 9.3 + eng._seed * 4.1)) / 3 * a.amp;
      if (a.decay) v *= clamp(1 - t / a.decay, 0, 1);
      return v;
    },
    /** 三角波快速来回扫动 */
    scan: function (a, t) {
      var per = a.period || 800;
      var p = ((t + (a.phaseMs || 0)) % per) / per;
      var tri = p < 0.5 ? p * 4 - 1 : 3 - p * 4; /* -1 → 1 → -1 */
      return a.amp * tri;
    },
    /** 张望：平滑方波，在 ±amp 两端各停留片刻再换边（左看看、右看看） */
    glance: function (a, t) {
      var per = a.period || 3600;
      var ph = TAU * (((t + (a.phaseMs || 0)) % per) / per) + (a.phase || 0);
      return a.amp * Math.tanh(2.8 * Math.sin(ph));
    },
    /** 周期眨眼：interval 周期内前 dur 毫秒闭合再睁开（返回负值叠加到 open）
     *  相位叠加实例随机种子，多实例不会同步眨眼 */
    blink: function (a, t, eng) {
      var interval = a.interval || 3800, dur = a.dur || 200;
      var p = (t + (a.phaseMs || 0) + (eng ? eng._seed * 97 : 0)) % interval;
      if (p >= dur) return 0;
      return -(a.depth == null ? 1 : a.depth) * Math.sin(Math.PI * (p / dur));
    }
  };

  function applyAnim(pose, a, t, eng) {
    var fn = ANIM_TYPES[a.type];
    if (!fn) return;
    var v = fn(a, t, eng);
    var targets =
      a.target === 'eyes' ? [pose.left, pose.right] :
      a.target === 'body' ? [pose.body] :
      a.target === 'left' ? [pose.left] :
      a.target === 'right' ? [pose.right] : [];
    for (var i = 0; i < targets.length; i++) {
      var tg = targets[i];
      if (a.prop === 'scale') {
        if (tg === pose.body) tg.scale += v;
        else { tg.scaleX += v; tg.scaleY += v; }
      } else if (a.prop in tg) {
        tg[a.prop] += v;
      }
    }
  }

  /* ---------------- 配置注册中心 ---------------- */

  var GROUPS = (window.EMOTION_GROUPS || [
    { key: 'life', name: '生命周期' },
    { key: 'emotion', name: '情绪反应' },
    { key: 'agent', name: '代理工作状态' },
    { key: 'custom', name: '自定义' }
  ]).slice();

  var registry = new Map();
  var order = [];

  function knownGroup(g) {
    return GROUPS.some(function (x) { return x.key === g; });
  }

  function validate(raw) {
    var errs = [];
    if (!raw || typeof raw !== 'object') { errs.push('配置必须是对象'); return errs; }
    if (typeof raw.id !== 'string' || !raw.id.trim()) errs.push('缺少合法的字符串 id');
    if (typeof raw.name !== 'string' || !raw.name.trim()) errs.push('缺少 name');
    if (!knownGroup(raw.group)) errs.push('group 不合法：' + raw.group);
    if (raw.anims != null) {
      if (!Array.isArray(raw.anims)) errs.push('anims 必须是数组');
      else raw.anims.forEach(function (a, i) {
        if (!a || !ANIM_TYPES[a.type]) errs.push('anims[' + i + '] 未知动画类型：' + (a && a.type));
      });
    }
    if (raw.sequence != null && !Array.isArray(raw.sequence.frames)) {
      errs.push('sequence.frames 必须是数组');
    }
    return errs;
  }

  /** 归一化：深合并默认姿态，预生成 sequence 每帧的完整 pose */
  function normalize(raw) {
    var base = applySpec(defaultPose(), raw);
    var pool = (raw.pool || [0, 8]).filter(function (i) { return i >= 0 && i < EXPR.length; });
    if (!pool.length) pool = [0];
    var def = {
      id: raw.id, name: raw.name, group: raw.group,
      desc: raw.desc || '',
      en: raw.en || null,   /* 可选英文文案 { name, desc } */
      gaze: raw.gaze !== false,
      transition: raw.transition != null ? raw.transition : 500,
      /* 表情池系统：pool = 眼环索引池，poolMs 间隔内随机轮换；
       * blinkMs = 眨眼间隔（null 不眨）；openness = 常驻开合度；
       * antics = 待机随机小动作（自旋 / 弹跳） */
      pool: pool,
      poolMs: raw.poolMs || [9000, 16000],
      poolSpeed: raw.poolSpeed || 6,
      blinkMs: raw.blinkMs !== undefined ? raw.blinkMs : [6000, 14000],
      openness: raw.openness != null ? raw.openness : 1,
      antics: !!raw.antics,
      base: base,
      anims: (raw.anims || []).map(function (a) { return Object.assign({}, a); }),
      sequence: null,
      raw: raw
    };
    if (raw.sequence) {
      var frames = raw.sequence.frames.map(function (f) {
        return { at: f.at || 0, pose: applySpec(clonePose(base), f) };
      }).sort(function (x, y) { return x.at - y.at; });
      def.sequence = { frames: frames, settle: raw.sequence.settle || 'base' };
    }
    return def;
  }

  function register(raw) {
    var errs = validate(raw);
    if (errs.length) return { ok: false, id: raw && raw.id, errors: errs };
    var def = normalize(raw);
    if (!registry.has(def.id)) order.push(def.id);
    registry.set(def.id, def);
    return { ok: true, id: def.id };
  }

  EB.config = {
    register: register,
    get: function (id) { return registry.get(id) || null; },
    list: function (group) {
      return order.map(function (id) { return registry.get(id); })
        .filter(function (d) { return !group || d.group === group; });
    },
    groups: function () {
      return GROUPS.map(function (g) { return { key: g.key, name: g.name, en: g.en || g.name }; });
    },
    exportConfig: function () {
      return JSON.stringify(order.map(function (id) { return registry.get(id).raw; }), null, 2);
    },
    importConfig: function (json) {
      var data;
      try {
        data = typeof json === 'string' ? JSON.parse(json) : json;
      } catch (e) {
        return { ok: false, added: 0, errors: ['JSON 解析失败：' + e.message] };
      }
      var arr = Array.isArray(data) ? data : [data];
      var added = 0, errors = [];
      arr.forEach(function (raw) {
        var r = register(raw);
        if (r.ok) added++;
        else errors.push('[' + ((raw && raw.id) || '?') + '] ' + r.errors.join('；'));
      });
      return { ok: errors.length === 0, added: added, errors: errors };
    }
  };

  /* ---------------- 全局共享 rAF 时钟（多实例单循环） ---------------- */

  var ticker = {
    set: new Set(),
    raf: 0,
    add: function (e) {
      this.set.add(e);
      if (!this.raf) this.raf = requestAnimationFrame(ticker.loop);
    },
    remove: function (e) { this.set.delete(e); },
    loop: function (now) {
      ticker.raf = 0;
      ticker.set.forEach(function (e) { e._tick(now); });
      if (ticker.set.size) ticker.raf = requestAnimationFrame(ticker.loop);
    }
  };

  /* ---------------- EmotionEngine ---------------- */

  function Engine(target, opts) {
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('EmotionBall.create：找不到容器元素');

    this.ball = EB.createBall(el, Object.assign({}, opts, {
      lite: opts.lite != null ? opts.lite : opts.autostart === false
    }));
    this._seed = Math.random() * 100;
    this._events = {};
    this._gaze = { x: 0, y: 0, tx: 0, ty: 0 };
    this._style = { sketch: 0 };
    this._theme = opts.color
      ? { body: opts.color, eyes: opts.eyeColor || '#FFFFFF' }
      : null;
    this._eyeScale = opts.eyeScale || 1;
    this._lastTick = 0;
    this._spin = null;   /* { x, v, t }：弹簧驱动的整圈自旋（彩带触发源） */

    /* ---- 表情形变系统 ---- */
    this._ringSrc = [EXPR[0][0], EXPR[0][1]];   /* 形变起点环对 */
    this._ringDst = [EXPR[0][0], EXPR[0][1]];   /* 形变目标环对 */
    this._ringCur = this._ringDst;              /* 当前展示环对（引用比较驱动 d 更新） */
    this._ringSpring = spring(1);               /* 形变进度 0→1 */
    this._ringSpeed = 7;
    this._exprIdx = 0;
    this._poolPos = 0;
    this._poolNext = 0;
    /* ---- 眨眼系统：开合度弹簧（频率 26）+ 关键帧队列 ---- */
    this._open = spring(1);
    this._blinkQ = [];
    this._blinkNext = Infinity;
    /* ---- 待机小动作 ---- */
    this._anticNext = 0;
    this._bounceAt = -1;

    this._def = null;
    this._lastPose = null;
    this._prevPose = null;
    this._transStart = 0;
    this._transDur = 0;
    this._emoStart = 0;
    this._seq = null;
    this._active = false;
    this._touring = false;
    this._tourTimer = 0;
    this._fallbackId = opts.fallbackId || FALLBACK_ID;
    this._lastActivity = performance.now();

    if (opts.idle) {
      this._idle = Object.assign(
        { standbyAfter: 60000, sleepAfter: 180000, standbyId: '02', sleepId: '00' },
        opts.idle === true ? {} : opts.idle
      );
    } else {
      this._idle = null;
    }

    this.setEmotion(opts.emotion || this._fallbackId, { auto: true });
    if (opts.autostart !== false) this.setActive(true);
    else this.renderStatic();
  }

  Engine.prototype = {

    /* ---------- 事件 ---------- */
    on: function (evt, cb) {
      (this._events[evt] = this._events[evt] || []).push(cb);
      return this;
    },
    off: function (evt, cb) {
      var list = this._events[evt];
      if (list) {
        var i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      }
      return this;
    },
    _emit: function (evt, payload) {
      (this._events[evt] || []).slice().forEach(function (cb) {
        try { cb(payload); } catch (e) { console.error(e); }
      });
    },

    get emotionId() { return this._def ? this._def.id : null; },
    get touring() { return this._touring; },

    /* ---------- 核心：切换表情（含兜底） ---------- */
    setEmotion: function (id, o) {
      o = o || {};
      var def = EB.config.get(id);
      if (!def) {
        console.warn('[EmotionBall] 未知表情 ID "' + id + '"，回退到待机 (' + this._fallbackId + ')');
        this._emit('error', { message: '未知表情 ID "' + id + '"，已回退待机', id: id });
        def = EB.config.get(this._fallbackId);
        if (!def) return false;
      }
      var now = performance.now();
      var prevId = this._def ? this._def.id : null;
      this._prevPose = this._lastPose ? clonePose(this._lastPose) : null;
      this._def = def;
      this._emoStart = now;
      this._transStart = now;
      this._transDur = this._prevPose ? def.transition : 0;
      this._seq = def.sequence
        ? { frames: def.sequence.frames, settle: def.sequence.settle, done: false }
        : null;
      if (!o.auto) this._lastActivity = now;

      /* 状态切换：眼环弹到新池首个表情（兴奋类用更快弹簧），
       * 并且切换瞬间先眨一次眼（睡眠 / 停止类除外） */
      this._poolPos = 0;
      this._setExpr(def.pool[0], def.poolSpeed >= 10 ? 10 : 8);
      this._poolNext = now + rand(def.poolMs[0], def.poolMs[1]);
      if (prevId !== null && prevId !== def.id && def.blinkMs) this._blinkNow(now);
      this._blinkNext = def.blinkMs ? now + rand(def.blinkMs[0], def.blinkMs[1]) : Infinity;
      this._anticNext = now + rand(2500, 5000);

      this._emit('change', { id: def.id, def: def, auto: !!o.auto });
      /* 配置中的 ribbons / confetti 是进入表情时的一次性事件：
       * ribbons → 自旋甩彩带；confetti → 撒花爆发 */
      if (this._active) {
        var fx = def.base.body;
        if (fx.ribbons > 0) this.spin(fx.ribbons >= 1 ? 2 : 1);
        if (fx.confetti > 0) this.burst(20);
      }
      if (!this._active) this.renderStatic();
      return true;
    },

    /** AI 对接入口：接受对象或 JSON 字符串 { emotionId, tips } */
    handleAIMessage: function (msg) {
      var obj = msg;
      if (typeof msg === 'string') {
        try { obj = JSON.parse(msg); }
        catch (e) {
          this._emit('error', { message: 'AI 消息 JSON 解析失败，已回退待机', raw: msg });
          this.setEmotion(this._fallbackId);
          return false;
        }
      }
      if (!obj || typeof obj !== 'object' || typeof obj.emotionId !== 'string') {
        this._emit('error', { message: 'AI 消息缺少 emotionId 字段，已回退待机', raw: msg });
        this.setEmotion(this._fallbackId);
        return false;
      }
      var ok = this.setEmotion(obj.emotionId);
      if (obj.tips) this._emit('tips', { text: String(obj.tips) });
      return ok;
    },

    /* ---------- 自动巡演 ---------- */
    startTour: function (ids, interval) {
      this.stopTour();
      if (!ids || !ids.length) return;
      interval = interval || 2500;
      this._touring = true;
      var self = this, i = 0;
      this.setEmotion(ids[0], { auto: true });
      this._tourTimer = setInterval(function () {
        i = (i + 1) % ids.length;
        self.setEmotion(ids[i], { auto: true });
      }, interval);
    },
    stopTour: function () {
      if (this._tourTimer) { clearInterval(this._tourTimer); this._tourTimer = 0; }
      this._touring = false;
      this._lastActivity = performance.now();
    },

    resetIdle: function () { this._lastActivity = performance.now(); },

    /* 注视目标：横向 ±24、纵向 ±15（viewBox 坐标），幅度克制以保持含蓄 */
    setGaze: function (nx, ny) {
      this._gaze.tx = clamp(nx, -1, 1) * 24;
      this._gaze.ty = clamp(ny, -1, 1) * 15;
      return this;
    },
    clearGaze: function () {
      this._gaze.tx = 0;
      this._gaze.ty = 0;
      return this;
    },
    setStyle: function (style) {
      Object.assign(this._style, style || {});
      if (!this._active) this.renderStatic();
      return this;
    },

    /* 自旋（点击交互）：弹簧追整数圈，达速后由渲染层甩出彩带；
     * 进行中的自旋不可打断，追加请求直接忽略 */
    spin: function (turns, dir) {
      if (this._spin) return this;
      var d = dir || (Math.random() < 0.5 ? -1 : 1);
      this._spin = { x: 0, v: 0, t: Math.max(1, Math.round(turns || 1)) * TAU * d };
      return this;
    },
    /* 撒花：一次性物理粒子爆发 */
    burst: function (count) {
      if (this.ball.burst) this.ball.burst(count);
      return this;
    },
    /* 弹跳（4 段递减抛物线） */
    bounce: function () {
      if (this._bounceAt < 0) this._bounceAt = performance.now();
      return this;
    },

    /* 切换眼环目标：把当前插值冻结为新起点，弹簧从 0 重新弹向 1 */
    _setExpr: function (idx, speed) {
      if (idx === this._exprIdx && this._ringSpring.x >= 0.999) return;
      var s = clamp(this._ringSpring.x, 0, 1);
      this._ringSrc = [
        lerpRing(this._ringSrc[0], this._ringDst[0], s),
        lerpRing(this._ringSrc[1], this._ringDst[1], s)
      ];
      this._ringDst = [EXPR[idx][0], EXPR[idx][1]];
      this._ringSpring.x = 0;
      this._ringSpring.v = 0;
      this._ringSpring.t = 1;
      this._ringSpeed = speed || 7;
      this._exprIdx = idx;
    },

    /* 眨眼关键帧：合上 → 停 70ms → 睁到 1.08 过冲 → 300ms 落回 1，
     * 14% 概率追加第二次连眨 */
    _blinkNow: function (t) {
      this._blinkQ.push(
        { at: t, v: 0.05 }, { at: t + 70, v: 0.05 },
        { at: t + 150, v: 1.08 }, { at: t + 300, v: 1 }
      );
      if (Math.random() < 0.14) {
        this._blinkQ.push({ at: t + 370, v: 0.05 }, { at: t + 480, v: 1 });
      }
    },

    registerEmotion: function (raw) { return EB.config.register(raw); },

    /* ---------- 生命周期 ---------- */
    setActive: function (on) {
      if (on === this._active) return;
      this._active = on;
      if (on) ticker.add(this);
      else ticker.remove(this);
    },
    replay: function () {
      if (this._def) this.setEmotion(this._def.id, { auto: true });
    },
    /** 静态渲染一帧（缩略图用基础姿态，不播 sequence 第 0 帧；弹簧直接置终值） */
    renderStatic: function () {
      this._transDur = 0;
      this._ringSpring.x = 1;
      this._ringSpring.v = 0;
      this._open.x = this._def ? this._def.openness : 1;
      this._open.v = 0;
      var seq = this._seq;
      this._seq = null;
      this._tick(performance.now());
      this._seq = seq;
    },
    destroy: function () {
      this.stopTour();
      this.setActive(false);
      this._events = {};
      this.ball.destroy();
    },

    /* ---------- 每帧 ---------- */
    _tick: function (now) {
      this._dt = this._lastTick ? clamp((now - this._lastTick) / 1000, 0.001, 0.05) : 1 / 60;
      this._lastTick = now;
      if (this._idle && !this._touring) this._checkIdle(now);
      var pose = this._compose(now, 0);
      this.ball.applyPose(pose);
      this._lastPose = pose;
    },

    _checkIdle: function (now) {
      var idle = this._idle;
      var elapsed = now - this._lastActivity;
      var cur = this.emotionId;
      if (elapsed >= idle.sleepAfter) {
        if (cur !== idle.sleepId) this.setEmotion(idle.sleepId, { auto: true });
      } else if (elapsed >= idle.standbyAfter) {
        if (cur !== idle.standbyId && cur !== idle.sleepId) {
          this.setEmotion(idle.standbyId, { auto: true });
        }
      }
    },

    /** 合成当前帧姿态：base → sequence → animators → 过渡插值 */
    _compose: function (now, depth) {
      var def = this._def;
      var t = now - this._emoStart;
      var pose;

      if (this._seq) {
        var res = this._seqPose(t, now);
        if (res === 'switch') {
          /* sequence 播完且 settle.next：已切到新表情，重新合成 */
          return depth < 4 ? this._compose(now, depth + 1) : clonePose(this._def.base);
        }
        pose = res || clonePose(def.base);
      } else {
        pose = clonePose(def.base);
      }

      /* 内置呼吸（相位用绝对时间，切换表情不跳变） */
      var br = pose.body.breathe || 0;
      if (br) {
        var ph = TAU * now / 3600;
        pose.body.scale += br * Math.sin(ph);
        pose.body.y += br * 55 * Math.sin(ph + 0.6);
      }

      for (var i = 0; i < def.anims.length; i++) applyAnim(pose, def.anims[i], t, this);

      pose.body.sketch = Math.max(pose.body.sketch || 0, this._style.sketch || 0);

      var dt = this._dt || 1 / 60;

      /* ---- 表情池轮换：poolMs 间隔内随机跳到池内另一个眼环 ---- */
      if (this._active && now >= this._poolNext) {
        if (def.pool.length > 1) {
          this._poolPos = (this._poolPos + 1 + Math.floor(rand(0, def.pool.length - 1))) % def.pool.length;
          this._setExpr(def.pool[this._poolPos], def.poolSpeed);
        }
        this._poolNext = now + rand(def.poolMs[0], def.poolMs[1]);
      }

      /* ---- 眨眼调度：间隔到点入队关键帧，队列驱动开合度弹簧目标 ---- */
      if (this._active && def.blinkMs && now >= this._blinkNext) {
        this._blinkNow(now);
        this._blinkNext = now + rand(def.blinkMs[0], def.blinkMs[1]);
      }
      var openKey = null;
      while (this._blinkQ.length && now >= this._blinkQ[0].at) {
        openKey = this._blinkQ[0].v;
        this._blinkQ.shift();
      }
      this._open.t = openKey != null ? openKey : (this._blinkQ.length ? this._open.t : def.openness);

      /* ---- 待机小动作：9~18s 随机自旋 / 弹跳 ---- */
      if (this._active && def.antics && now >= this._anticNext) {
        if (!this._spin && this._bounceAt < 0) {
          var pick = Math.random();
          if (pick < 0.45) this.spin(1);
          else if (pick < 0.8) this.bounce();
          else this._blinkNow(now);
        }
        this._anticNext = now + rand(9000, 18000);
      }

      /* ---- 弹簧整步（子步 1/120 保稳定）：形变 / 开合 / 自旋 ---- */
      var steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      var j = dt / steps;
      for (var si = 0; si < steps; si++) {
        springStep(this._ringSpring, this._ringSpeed, 1, j);
        springStep(this._open, 26, 1, j);
        if (this._spin) {
          springStep(this._spin, 6.2, 1, j);
          if (Math.abs(this._spin.t - this._spin.x) < 0.01 && Math.abs(this._spin.v) < 0.05) {
            this._spin = null;
          }
        }
      }
      pose.body.yaw = this._spin ? this._spin.x : 0;

      /* ---- 弹跳位移：-4·h·n(1-n) 抛物线 ---- */
      if (this._bounceAt >= 0) {
        var be = (now - this._bounceAt) / 1000;
        if (be >= BOUNCE_TOTAL) {
          this._bounceAt = -1;
        } else {
          var acc = 0, bi = 0;
          while (bi < BOUNCE_SEGS.length && be >= acc + BOUNCE_SEGS[bi].d) { acc += BOUNCE_SEGS[bi].d; bi++; }
          var seg = BOUNCE_SEGS[Math.min(bi, BOUNCE_SEGS.length - 1)];
          var bn = (be - acc) / seg.d;
          pose.body.y += -4 * seg.h * bn * (1 - bn);
        }
      }

      /* ---- 当前眼环：形变中逐点插值，静止后复用目标引用（跳过 d 重建） ---- */
      if (this._ringSpring.x < 0.999 || this._ringSpring.v > 0.001 || this._ringSpring.v < -0.001) {
        var rs = clamp(this._ringSpring.x, 0, 1.35);
        this._ringCur = [
          lerpRing(this._ringSrc[0], this._ringDst[0], rs),
          lerpRing(this._ringSrc[1], this._ringDst[1], rs)
        ];
      } else if (this._ringCur !== this._ringDst) {
        this._ringCur = this._ringDst;
      }
      pose.left.ring = this._ringCur[0];
      pose.right.ring = this._ringCur[1];

      /* 鼠标注视：帧率无关的指数平滑（60fps 基准下每帧收敛约 9%） */
      var k = 1 - Math.exp(-5.66 * dt);
      var gx = def.gaze !== false ? this._gaze.tx : 0;
      var gy = def.gaze !== false ? this._gaze.ty : 0;
      this._gaze.x += (gx - this._gaze.x) * k;
      this._gaze.y += (gy - this._gaze.y) * k;
      pose.left.lookX += this._gaze.x;
      pose.right.lookX += this._gaze.x;
      pose.left.lookY += this._gaze.y;
      pose.right.lookY += this._gaze.y;

      /* 常驻眼神微漂移：每只眼相位错开，永不完全静止 */
      if (def.gaze !== false) {
        var w = now / 1000;
        pose.left.lookX += 1.4 * Math.sin(0.42 * w) + 0.5 * Math.sin(1.0 * w);
        pose.right.lookX += 1.4 * Math.sin(0.42 * w + 1) + 0.5 * Math.sin(1.0 * w + 2);
        pose.left.lookY += 0.9 * Math.sin(0.58 * w);
        pose.right.lookY += 0.9 * Math.sin(0.58 * w + 1);
      }

      /* 小尺寸实例放大眼睛占比，保证 32~48px 下仍可读 */
      if (this._eyeScale !== 1) {
        pose.left.scaleX *= this._eyeScale;
        pose.left.scaleY *= this._eyeScale;
        pose.right.scaleX *= this._eyeScale;
        pose.right.scaleY *= this._eyeScale;
      }

      /* 实例主题色（baby bot）：体色恒为主题色，眼睛仅覆盖默认黑 */
      if (this._theme) {
        pose.body.color = this._theme.body;
        if (pose.left.color === DEFAULT_EYE.color) pose.left.color = this._theme.eyes;
        if (pose.right.color === DEFAULT_EYE.color) pose.right.color = this._theme.eyes;
      }

      /* 开合度 = 配置基础值 × 眨眼弹簧（弹簧可过冲到 1.08） */
      var openS = clamp(this._open.x, 0.02, 1.5);
      pose.left.open = clamp(pose.left.open, 0, 1.3) * openS;
      pose.right.open = clamp(pose.right.open, 0, 1.3) * openS;
      pose.left.scaleX = Math.max(pose.left.scaleX, 0.05);
      pose.left.scaleY = Math.max(pose.left.scaleY, 0.05);
      pose.right.scaleX = Math.max(pose.right.scaleX, 0.05);
      pose.right.scaleY = Math.max(pose.right.scaleY, 0.05);

      /* 表情切换过渡插值 */
      var tt = now - this._transStart;
      if (this._transDur > 0 && tt < this._transDur && this._prevPose) {
        pose = lerpPose(this._prevPose, pose, easeInOutCubic(tt / this._transDur));
      }
      return pose;
    },

    /** sequence 采样；播完按 settle 处理（hold / base / next） */
    _seqPose: function (t, now) {
      var seq = this._seq;
      var frames = seq.frames;
      var last = frames[frames.length - 1];

      if (t >= last.at) {
        if (!seq.done) {
          seq.done = true;
          var s = seq.settle;
          if (s === 'base') {
            /* 从序列末帧平滑回落到基础姿态 */
            this._prevPose = this._lastPose ? clonePose(this._lastPose) : clonePose(last.pose);
            this._transStart = now;
            this._transDur = this._def.transition || 500;
            this._seq = null;
            return null;
          }
          if (s && typeof s === 'object' && s.next) {
            this.setEmotion(s.next, { auto: true });
            return 'switch';
          }
          /* settle === 'hold'：定格在末帧 */
        }
        return clonePose(last.pose);
      }

      if (t <= frames[0].at) return clonePose(frames[0].pose);
      for (var i = 0; i < frames.length - 1; i++) {
        var a = frames[i], b = frames[i + 1];
        if (t >= a.at && t < b.at) {
          var k = easeInOutCubic((t - a.at) / (b.at - a.at));
          return lerpPose(a.pose, b.pose, k);
        }
      }
      return clonePose(last.pose);
    }
  };

  /* ---------------- 对外入口 ---------------- */

  EB.create = function (target, opts) { return new Engine(target, opts); };
  EB.version = '1.0.0';

  /* 载入种子配置（emotions.js 在本脚本之前加载） */
  if (Array.isArray(window.EMOTION_SEED)) {
    window.EMOTION_SEED.forEach(function (raw) {
      var r = register(raw);
      if (!r.ok) console.warn('[EmotionBall] 种子配置无效：', r.id, r.errors);
    });
  }
})();

/* ============================================================
 * 兼容层（管家定制）—— inject.js 调用契约：window.EmotionBall.create(host, opts)
 * opts: { emotion:'02', idle:true, character:'blob'|'nimbo'|'twinkle', sketch:0|1 }
 * 双引擎路由（照总馆 site/app.js createInst 官方模式）：
 *   blob/ball → EmotionBall v1 引擎（球球彩带体系；blob 为管家历史 id）
 *   nimbo/twinkle → MoodMates 引擎
 * v1 实例补 celebrate 兼容（hover 特效）：原版球球点击行为 = 自旋 + 彩带爆发。
 * ============================================================ */
(function () {
  'use strict';
  var MM = window.MoodMates;
  var EBv1 = window.EmotionBall;
  if (!MM || typeof MM.create !== 'function' || !EBv1 || typeof EBv1.create !== 'function') return;

  /* ⚠️ EBv1 与 EB 是同一个对象（v1 引擎就挂在 window.EmotionBall 上）。
   * 必须先抓 v1 原 create 引用再覆盖，否则 EBv1.create 变成路由自身 → 无限递归
   *（2026-09-05 真机抓出：Maximum call stack size exceeded）。 */
  var EBv1Create = EBv1.create;

  var EB = (window.EmotionBall = window.EmotionBall || {});
  /* 无条件覆盖 create（旧注入残留必须被顶掉，2026-09-04 真机教训）。 */
  EB.create = function (target, opts) {
    opts = Object.assign({}, opts || {});
    var ch = opts.character;
    if (!ch || ch === 'blob' || ch === 'ball') {
      delete opts.character;
      var inst = EBv1Create(target, opts);
      if (opts.sketch) { try { inst.setStyle({ sketch: 1 }); } catch (e) { /* 静默 */ } }
      if (typeof inst.celebrate !== 'function') {
        inst.celebrate = function (strength) {
          var s = strength == null ? 1 : strength;
          try { if (typeof this.spin === 'function') this.spin(1); } catch (e) { /* 静默 */ }
          try { this.burst(Math.round(14 + 6 * s)); } catch (e) { /* 静默 */ }
          return this;
        };
      }
      return inst;
    }
    if (!MM.characters.get(ch)) ch = 'nimbo';
    opts.character = ch;
    var inst2 = MM.create(target, opts);
    if (opts.sketch) { try { inst2.setStyle({ sketch: 1 }); } catch (e) { /* 静默 */ } }
    return inst2;
  };
  EB.version = EBv1.version || MM.version;
  EB.config = EBv1.config; /* 表情枚举走球球侧（v1 config） */
  window.MoodMates.characters = MM.characters; /* 显式暴露（调试/预览枚举用） */
})();
