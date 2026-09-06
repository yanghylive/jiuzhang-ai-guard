#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
JIUZHANG AI Installer Prototype -> NSIS bitmap assets generator.
依据 Downloads/JIUZHANG_AI_Installer_Prototype.html 设计令牌绘制：
  - sidebar_step{0..5}.bmp : 左侧步骤导航（每步一张高亮变体）
  - hero_welcome.bmp       : 欢迎页主视觉（logo 图标 + wordmark）
  - icon_complete.bmp      : 完成页大对勾
全部输出 24bit 未压缩 BMP（NSIS Bitmap 控件兼容）。
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), 'installer')
os.makedirs(OUT, exist_ok=True)

# Design tokens（来自原型）
BRAND_800 = '#4C1D95'
BRAND_700 = '#5B21B6'
BRAND_600 = '#6D28D9'
BRAND_500 = '#7C3AED'
BRAND_400 = '#8B5CF6'
BRAND_100 = '#DDD6FE'
BRAND_50 = '#F5F3FF'
NEUTRAL_900 = '#111827'
NEUTRAL_500 = '#6B7280'
NEUTRAL_400 = '#9CA3AF'
NEUTRAL_300 = '#D1D5DB'
NEUTRAL_200 = '#E5E7EB'
SUCCESS = '#059669'

STEPS = ['欢迎', '许可协议', '安装目录', '准备安装', '正在安装', '完成']


def font(size, bold=False):
    candidates = (
        ['/System/Library/Fonts/PingFang.ttf', '/System/Library/Fonts/Hiragino Sans GB.ttf',
         '/Library/Fonts/Arial Unicode.ttf']
    )
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                pass
    name = 'PingFang SC' if not bold else 'PingFang SC Semibold'
    return ImageFont.truetype(name, size)


def hex2rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


def draw_sidebar(active_idx):
    """左侧步骤导航 200x444。active_idx=当前步；之前的步标 done。"""
    W, H = 200, 444
    img = Image.new('RGB', (W, H), hex2rgb(BRAND_50))
    d = ImageDraw.Draw(img)
    f_label = font(13)
    f_num = font(11)
    # 顶部分隔（对应系统标题栏下方视觉起点）
    y = 34
    for i, label in enumerate(STEPS):
        active = (i == active_idx)
        done = i < active_idx
        cy = y + 14
        # row highlight
        if active:
            d.rounded_rectangle([12, cy - 15, W - 10, cy + 15], radius=4,
                                fill=tuple(list(hex2rgb(BRAND_600))[:3]) if False else hex2rgb(BRAND_600))
        num_txt = str(i + 1)
        r = 11
        cx = 12 + r + 4
        if done:
            fill = hex2rgb(SUCCESS); txt_col = (255, 255, 255); sym = '✓'
        elif active:
            fill = (255, 255, 255); txt_col = hex2rgb(BRAND_700); sym = num_txt
        else:
            fill = hex2rgb(NEUTRAL_200); txt_col = hex2rgb(NEUTRAL_500); sym = num_txt
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)
        bb = d.textbbox((0, 0), sym, font=f_num)
        tw, th = bb[2] - bb[0], bb[3] - bb[1]
        d.text((cx - tw / 2 - bb[0], cy - th / 2 - bb[1]), sym, font=f_num, fill=txt_col)
        col = hex2rgb(BRAND_700) if active else (hex2rgb(SUCCESS) if done else hex2rgb(NEUTRAL_400))
        weight = f_label
        tx = cx + r + 8
        bb2 = d.textbbox((0, 0), label, font=weight)
        d.text((tx, cy - (bb2[3] - bb2[1]) / 2 - bb2[1]), label, font=weight, fill=(255, 255, 255) if active else col)
        y += 44
    # brand 区
    d.line([16, H - 78, W - 16, H - 78], fill=hex2rgb(BRAND_100), width=1)
    # mini logo（立方体线框示意）
    cx0, cy0 = W // 2, H - 52
    s = 14
    p_top = [(cx0, cy0 - s), (cx0 + s, cy0 - s // 2), (cx0, cy0), (cx0 - s, cy0 - s // 2)]
    d.polygon(p_top, outline=hex2rgb(BRAND_600))
    d.line([(cx0 - s, cy0 - s // 2), (cx0 - s, cy0 + s // 2), (cx0, cy0 + s), (cx0 + s, cy0 + s // 2), (cx0 + s, cy0 - s // 2)], fill=hex2rgb(BRAND_600))
    d.line([(cx0, cy0), (cx0, cy0 + s)], fill=hex2rgb(BRAND_600))
    small = font(10)
    bb = d.textbbox((0, 0), 'JIUZHANG AI · 九章智能', font=small)
    d.text((W / 2 - (bb[2] - bb[0]) / 2 - bb[0], H - 30), 'JIUZHANG AI · 九章智能',
           font=small, fill=hex2rgb(NEUTRAL_400))
    return img


def draw_hero():
    """欢迎页主视觉 420x150（放右侧内容区上部）。"""
    W, H = 420, 150
    img = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    # 渐变紫方块 icon（48px 圆角）
    ix, iy, isz = 60, 30, 64
    for i in range(isz):
        t = i / isz
        c = tuple(int(a + (b - a) * t) for a, b in zip(hex2rgb(BRAND_500), hex2rgb(BRAND_800)))
        d.line([(ix, iy + i), (ix + isz - 1, iy + i)], fill=c)
    # 立方体描线（白色）
    cx0, cy0 = ix + isz // 2, iy + isz // 2
    s = 16
    w = 2
    d.polygon([(cx0, cy0 - s), (cx0 + s, cy0 - s // 2), (cx0, cy0), (cx0 - s, cy0 - s // 2)],
              outline=(255, 255, 255), width=w)
    d.line([(cx0 - s, cy0 - s // 2), (cx0 - s, cy0 + s // 2), (cx0, cy0 + s), (cx0 + s, cy0 + s // 2), (cx0 + s, cy0 - s // 2)],
           fill=(255, 255, 255), width=w)
    d.line([(cx0, cy0), (cx0, cy0 + s)], fill=(255, 255, 255), width=w)
    # wordmark
    f_big = font(26, bold=True)
    f_small = font(13)
    d.text((ix + isz + 18, iy + 8), 'JIUZHANG AI', font=f_big, fill=hex2rgb(BRAND_800))
    d.text((ix + isz + 20, iy + 46), '九章智能', font=f_small, fill=hex2rgb(NEUTRAL_500))
    return img


def draw_complete():
    """完成图标：绿圈白勾 72px。"""
    S = 72
    img = Image.new('RGB', (S, S), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.ellipse([2, 2, S - 3, S - 3], fill=hex2rgb(SUCCESS))
    d.line([(S * 0.28, S * 0.52), (S * 0.45, S * 0.68), (S * 0.74, S * 0.32)],
           fill=(255, 255, 255), width=6)
    return img


for idx in range(6):
    draw_sidebar(idx).save(os.path.join(OUT, f'sidebar_step{idx}.bmp'))
draw_hero().save(os.path.join(OUT, 'hero_welcome.bmp'))
draw_complete().save(os.path.join(OUT, 'icon_complete.bmp'))

print('ASSETS_OK:', sorted(os.listdir(OUT)))
