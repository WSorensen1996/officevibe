#!/usr/bin/env python3
"""Generate the OfficeVibe app icons from a single source of truth.

Writes (next to this script, in build/):
  icon.png   512x512  — Linux target + electron-builder buildResources
  icon.ico   16..256  — Windows target
  icon.icns  16..512 @1x/@2x — macOS target
  logo.png   512x512  — favicon + boot-splash mark (renderer @brand/logo.png)

No external tools required — pure Pillow. Font: Rubik-Bold.ttf (SIL OFL 1.1),
bundled alongside this script so the build is reproducible on any machine.

Re-theme by editing the BRAND block, then run:  python3 build/make-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))

# ── BRAND (edit to re-theme) ─────────────────────────────────────────────────
LETTERS  = "OV"
GRAD_TOP = (0x14, 0xB8, 0xA6)   # #14B8A6  teal primary
GRAD_BOT = (0x0D, 0x94, 0x88)   # #0D9488  deeper teal
BORDER   = (0x11, 0x5E, 0x59)   # #115E59
INK      = (0xF4, 0xF1, 0xEA)   # #F4F1EA  cream "OV"
FONT     = os.path.join(HERE, "Rubik-Bold.ttf")
# ─────────────────────────────────────────────────────────────────────────────

SS      = 4                     # supersample → crisp, anti-aliased edges
BASE    = 1024
S       = BASE * SS
MARGIN  = 112 * SS              # transparent margin (macOS-style rounded square)
RADIUS  = 180 * SS
STROKE  = 8 * SS
TARGET_W = 540 * SS             # width the "OV" should occupy on the 1024 grid


def _fit_font(draw, text, target_w):
    f = ImageFont.truetype(FONT, 100)
    w = draw.textlength(text, font=f) or 1
    return ImageFont.truetype(FONT, max(8, int(100 * target_w / w)))


def _master():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # vertical gradient, clipped to a rounded-square mask
    grad = Image.new("RGB", (1, S))
    for y in range(S):
        t = y / (S - 1)
        grad.putpixel((0, y), tuple(int(GRAD_TOP[i] + (GRAD_BOT[i] - GRAD_TOP[i]) * t) for i in range(3)))
    grad = grad.resize((S, S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([MARGIN, MARGIN, S - MARGIN, S - MARGIN], radius=RADIUS, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([MARGIN, MARGIN, S - MARGIN, S - MARGIN], radius=RADIUS, outline=BORDER, width=STROKE)
    font = _fit_font(d, LETTERS, TARGET_W)
    d.text((S / 2, S / 2 - 0.02 * S), LETTERS, font=font, fill=INK, anchor="mm")
    return img.resize((BASE, BASE), Image.LANCZOS)


def main():
    m = _master()
    m.resize((512, 512), Image.LANCZOS).save(os.path.join(HERE, "icon.png"))
    m.resize((512, 512), Image.LANCZOS).save(os.path.join(HERE, "logo.png"))
    m.save(os.path.join(HERE, "icon.icns"))
    m.save(os.path.join(HERE, "icon.ico"),
           sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote: icon.png logo.png icon.icns icon.ico  (teal OV)")


if __name__ == "__main__":
    main()
