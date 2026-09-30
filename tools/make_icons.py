#!/usr/bin/env python3
"""Draws the Two of Us app icons into web/icons/.

Two overlapping hearts on a warm terracotta background.
- icon-*.png: rounded square, for browsers and desktops ("any").
- maskable-*.png: full-bleed square with the hearts inside the centre safe zone,
  so Android can crop it into a circle or squircle.

Needs Pillow:  pip install Pillow
Run:           python3 tools/make_icons.py
"""
import math
import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'web', 'icons')
BACKGROUND = (179, 95, 82, 255)   # terracotta
FRONT = (251, 246, 240, 255)      # cream
BACK = (244, 199, 187, 255)       # blush
SCALE = 4                         # draw big, then shrink, for smooth edges


def heart_points(cx, cy, size, steps=240):
    """Classic heart curve, `size` wide, centred on (cx, cy)."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((cx + x * size / 32, cy - (y + 2.5) * size / 32))
    return pts


def draw_hearts(draw, canvas, art):
    """Draws both hearts so together they are about `art` pixels wide, centred."""
    size = art * 0.68
    shift = art * 0.16
    c = canvas / 2
    back = heart_points(c + shift, c - art * 0.04, size)
    front = heart_points(c - shift, c + art * 0.04, size)
    draw.polygon(back, fill=BACK)
    # A thin gap in the background colour, so the two hearts read as two.
    gap = heart_points(c - shift, c + art * 0.04, size * 1.12)
    draw.polygon(gap, fill=BACKGROUND)
    draw.polygon(front, fill=FRONT)


def make(px, maskable):
    canvas = px * SCALE
    img = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if maskable:
        draw.rectangle([0, 0, canvas, canvas], fill=BACKGROUND)
        art = canvas * 0.58  # stays inside the 80% safe circle
    else:
        draw.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=canvas * 0.22, fill=BACKGROUND)
        art = canvas * 0.72
    draw_hearts(draw, canvas, art)
    return img.resize((px, px), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for px in (192, 512):
        make(px, False).save(os.path.join(OUT, f'icon-{px}.png'), optimize=True)
        make(px, True).save(os.path.join(OUT, f'maskable-{px}.png'), optimize=True)
    print('Icons written to', os.path.normpath(OUT))


if __name__ == '__main__':
    main()
