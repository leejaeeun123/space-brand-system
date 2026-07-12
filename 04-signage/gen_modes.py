# -*- coding: utf-8 -*-
"""MODE LOUNGE 모드 태그(WORK/CLASS/GATHERING) 아웃라인 SVG 생성.
브랜드 라벨 사양: 대문자 · Paperlogy 600 · 자간 +0.12em · 직각 모서리 · 잉크 테두리+텍스트."""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

TTF = "Paperlogy-4Regular.ttf"         # 400 (Regular)
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..",))  # scratchpad
INK = "#16130F"

font = TTFont(TTF)
upm = font["head"].unitsPerEm            # 900
glyphset = font.getGlyphSet()
cmap = font.getBestCmap()
hmtx = font["hmtx"]
try:
    capH_fu = font["OS/2"].sCapHeight
except Exception:
    capH_fu = None

FONT_PX = 100.0                          # em height in svg units
S = FONT_PX / upm                        # font-unit -> px scale
TRACK = float(os.environ.get("TRACK_EM", "0.05")) * FONT_PX   # 자간(em), 기본 0.05
PAD_X = 46.0
PAD_Y = 30.0
BORDER = 4.0                             # 테두리 두께 (= 4pt, 1unit=1pt)

# cap height in px (없으면 'H' bbox로 측정)
if capH_fu is None:
    g = glyphset["H"]
    from fontTools.pens.boundsPen import BoundsPen
    bp = BoundsPen(glyphset); g.draw(bp); capH_fu = bp.bounds[3]
capH = capH_fu * S


def glyph_path(ch, dx, baseline):
    gname = cmap[ord(ch)]
    pen = SVGPathPen(glyphset)
    glyphset[gname].draw(pen)
    d = pen.getCommands()
    adv = hmtx[gname][0] * S
    # y축 뒤집기 + baseline/좌표 이동
    tf = 'translate({:.3f},{:.3f}) scale({:.5f},{:.5f})'.format(dx, baseline, S, -S)
    return d, adv, tf


def build(word):
    # 텍스트 총 폭 = 어드밴스 합 + 자간*(n-1)
    advs = [hmtx[cmap[ord(c)]][0] * S for c in word]
    text_w = sum(advs) + TRACK * (len(word) - 1)
    box_w = text_w + 2 * PAD_X
    box_h = capH + 2 * PAD_Y
    baseline = PAD_Y + capH
    x = PAD_X
    paths = []
    for c in word:
        d, adv, tf = glyph_path(c, x, baseline)
        if d.strip():
            paths.append('<path transform="{}" d="{}"/>'.format(tf, d))
        x += adv + TRACK
    return box_w, box_h, paths


def frame_path(w, h, t):
    """테두리를 채운 아웃라인(프레임)으로 — 바깥 사각형 - 안쪽 사각형, evenodd 구멍."""
    outer = "M0 0 H{:.3f} V{:.3f} H0 Z".format(w, h)
    inner = "M{t:.3f} {t:.3f} H{:.3f} V{:.3f} H{t:.3f} Z".format(w - t, h - t, t=t)
    return outer + " " + inner


def svg(word, color_mode):
    box_w, box_h, paths = build(word)
    if color_mode == "current":
        col = "currentColor"
    elif color_mode == "white":
        col = "#ffffff"
    else:
        col = INK
    frame = '<path fill-rule="evenodd" d="{}"/>'.format(frame_path(box_w, box_h, BORDER))
    body = '<g fill="{}">{}{}</g>'.format(col, frame, "".join(paths))
    # 물리 크기 pt 명시 (1 unit = 1pt) → 테두리가 실제 4pt
    return ('<svg xmlns="http://www.w3.org/2000/svg" '
            'width="{w:.2f}pt" height="{h:.2f}pt" viewBox="0 0 {w:.2f} {h:.2f}" '
            'role="img" aria-label="{word} 모드">\n  {body}\n</svg>\n').format(
        w=box_w, h=box_h, word=word, body=body)


WORDS = ["WORK", "CLASS", "GATHERING"]
targets = {
    "current": "mode-{}.svg",
    "ink": "mode-{}-ink.svg",
    "white": "mode-{}-white.svg",
}
for w in WORDS:
    for mode, tmpl in targets.items():
        fn = os.path.join(os.path.dirname(os.path.abspath(__file__)), tmpl.format(w.lower()))
        with open(fn, "w", encoding="utf-8") as f:
            f.write(svg(w, mode))
        print("wrote", os.path.basename(fn))
print("capH px=%.1f  box_h px=%.1f" % (capH, capH + 2 * PAD_Y))
