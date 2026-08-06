# -*- coding: utf-8 -*-
"""안내문 생성기 — 세로 A5(420×595) SVG + HTML 미리보기.

notice-template.md 규격을 그대로 코드화한다. Paperlogy 글리프를 fontTools로
아웃라인 패스로 변환하므로 결과 SVG는 폰트 의존성이 0 — Figma MCP가 로컬
폰트를 못 읽는 환경에서도 인쇄 결과와 100% 동일하게 임포트된다.

재현: python gen_notice.py            (NOTICES 전체 생성)
      python gen_notice.py light      (특정 건만)
출력: out/notice-{key}.svg  +  out/notice-{key}.html (미리보기)
"""
import os
import re

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")
FONTDIR = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts")

INK = "#16130F"
W, H = 420, 595          # 세로 A5 (1mm = 2.834px 기준 148×210mm ≈ 420×595)
PICTO_CY = 72            # 픽토 세로 중심
PICTO_H = 44             # 픽토 높이 기본값 (픽토별 override 가능)
TITLE_GAP = 18           # 픽토 하단 → 제목 박스 상단
TITLE_SIZE, TITLE_TRACK = 15, 0.45
BODY_TOP = 405           # 본문 박스 상단 (고정)
BODY_SIZE, BODY_LEAD, BODY_TRACK = 11, 16, 0.44
BODY_MAXW = 325          # 본문 한 줄 최대폭 (재은 확정, Figma 기준)
LOGO_X, LOGO_Y, LOGO_W = 172, 539, 76

_fonts = {}


def font(weight):
    """weight: '3Light' | '4Regular' ..."""
    if weight not in _fonts:
        f = TTFont(os.path.join(FONTDIR, f"Paperlogy-{weight}.ttf"))
        _fonts[weight] = (f, f.getBestCmap(), f.getGlyphSet(), f["hmtx"],
                          f["head"].unitsPerEm, f["hhea"].ascender, f["hhea"].descender)
    return _fonts[weight]


def _fmt(v):
    v = round(v, 2)
    return str(int(v)) if v == int(v) else str(v)


def _fmt6(v):
    """스케일 계수용 고정밀 포맷 — 2자리로 반올림하면 로고(스케일 0.0117)가
    0.01 로 뭉개져 15% 작게 들어간다."""
    v = round(v, 6)
    return str(int(v)) if v == int(v) else f"{v:.6f}".rstrip("0")


def text_path(s, weight, size, track):
    """문자열 → (path d, 진행폭). baseline y=0, 시작 x=0 기준."""
    f, cmap, gs, hmtx, upem, _, _ = font(weight)
    scale = size / upem
    parts, pen_x = [], 0.0
    for ch in s:
        gid = cmap.get(ord(ch))
        if gid is None:
            raise SystemExit(f"글리프 없음: {ch!r} (Paperlogy-{weight})")
        pen = SVGPathPen(gs)
        gs[gid].draw(pen)
        d = pen.getCommands()
        if d:
            # 글리프 좌표(y-up, em단위) → SVG(y-down, px): scale(s,-s) + translate
            d = re.sub(r"-?\d+\.?\d*", lambda m: _fmt(float(m.group(0)) * scale), d)
            parts.append((d, pen_x))
        pen_x += hmtx[gid][0] * scale + track
    # 각 글자를 개별 translate 로 배치 (transform 중첩 없이 좌표 직접 이동)
    return parts, pen_x


def emit_text(s, weight, size, track, cx, baseline):
    """가운데 정렬 텍스트를 <g> 하나로. CSS letter-spacing 과 동일하게
    마지막 글자 뒤 자간도 폭에 포함해 센터링한다."""
    parts, adv = text_path(s, weight, size, track)
    x0 = cx - adv / 2
    g = [f'<g fill="{INK}">']
    for d, dx in parts:
        g.append(f'<path transform="translate({_fmt(x0 + dx)},{_fmt(baseline)}) scale(1,-1)" d="{d}"/>')
    g.append("</g>")
    return "\n  ".join(g), adv


def baseline_normal(top, weight, size):
    """Figma leading=normal 텍스트박스 상단 → baseline."""
    _, _, _, _, upem, asc, _ = font(weight)
    return top + asc / upem * size


def baseline_fixed(top, weight, size, lead, i):
    """행간 고정(px) 다중행의 i번째 baseline."""
    _, _, _, _, upem, asc, desc = font(weight)
    natural = (asc - desc) / upem * size
    return top + lead * i + (lead - natural) / 2 + asc / upem * size


def _paths_of(svg_text):
    return re.findall(r'<path[^>]*\sd="([^"]+)"', svg_text)


def _bbox(ds):
    xs, ys = [], []
    for d in ds:
        nums = [float(n) for n in re.findall(r"-?\d+\.?\d*", d)]
        xs += nums[0::2]
        ys += nums[1::2]
    return min(xs), min(ys), max(xs), max(ys)


def picto_svg(name, height):
    """picto-{name}.svg 를 가로중앙·세로중심 PICTO_CY 에 맞춰 배치."""
    with open(os.path.join(HERE, f"picto-{name}.svg"), encoding="utf-8") as fp:
        ds = _paths_of(fp.read())
    x0, y0, x1, y1 = _bbox(ds)
    s = height / (y1 - y0)
    w = (x1 - x0) * s
    tx = W / 2 - w / 2 - x0 * s
    ty = PICTO_CY - height / 2 - y0 * s
    body = "\n    ".join(f'<path fill="{INK}" fill-rule="evenodd" d="{d}"/>' for d in ds)
    g = (f'<g transform="translate({_fmt(tx)},{_fmt(ty)}) scale({_fmt6(s)})">\n    '
         f'{body}\n  </g>')
    return g, PICTO_CY + height / 2


def logo_svg():
    """확정 워드마크(가로형) 를 폭 LOGO_W 로 배치. PAD 40 은 제거."""
    p = os.path.join(ROOT, "03-identity", "logo-wordmark-h-ink.svg")
    with open(p, encoding="utf-8") as fp:
        src = fp.read()
    inner = src[src.index(">", src.index("<svg")) + 1: src.rindex("</svg>")].strip()
    vb = [float(v) for v in re.findall(r"-?\d+\.?\d*", re.search(r'viewBox="([^"]+)"', src).group(1))]
    cw, ch = vb[2] + 2 * vb[0], vb[3] + 2 * vb[1]   # PAD(=-vb[0]) 양쪽 제거
    s = LOGO_W / cw
    return (f'<g transform="translate({_fmt(LOGO_X)},{_fmt(LOGO_Y)}) scale({_fmt6(s)}) '
            f'translate({_fmt(-vb[0])},{_fmt(-vb[1])})">\n    {inner}\n  </g>'), ch * s


def build(spec):
    picto, picto_bottom = picto_svg(spec["picto"], spec.get("picto_h", PICTO_H))
    parts = [picto]

    t_top = picto_bottom + TITLE_GAP
    tg, tw = emit_text(spec["title"], "4Regular", TITLE_SIZE, TITLE_TRACK,
                       W / 2, baseline_normal(t_top, "4Regular", TITLE_SIZE))
    parts.append(tg)

    lines = spec["body"]
    warn = []
    if len(lines) > 3:
        warn.append(f"본문 {len(lines)}줄 (권장 2줄·최대 3줄)")
    widths = []
    for i, line in enumerate(lines):
        g, adv = emit_text(line, "3Light", BODY_SIZE, BODY_TRACK, W / 2,
                           baseline_fixed(BODY_TOP, "3Light", BODY_SIZE, BODY_LEAD, i))
        parts.append(g)
        widths.append(adv)
    for l, w in zip(lines, widths):
        if w > BODY_MAXW:
            warn.append(f"폭 초과 {round(w, 1)}>{BODY_MAXW}: {l!r}")

    logo, lh = logo_svg()
    parts.append(logo)

    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
           f'width="{W}" height="{H}" role="img" aria-label="{spec["title"]} 안내문">\n'
           f'  <rect width="{W}" height="{H}" fill="#ffffff"/>\n  '
           + "\n  ".join(parts) + "\n</svg>\n")
    return svg, {"titleWidth": round(tw, 1), "bodyWidths": [round(w, 1) for w in widths],
                 "pictoBottom": round(picto_bottom, 1), "logoH": round(lh, 2), "warn": warn}


PREVIEW = """<!doctype html><meta charset="utf-8"><title>{title} 안내문 — 미리보기</title>
<style>
  body{{margin:0;padding:48px;background:#EFEDE9;font:13px/1.6 system-ui,sans-serif;color:#16130F;
       display:flex;flex-direction:column;align-items:center;gap:24px}}
  .sheet{{background:#fff;box-shadow:0 2px 24px rgba(0,0,0,.12)}}
  .meta{{max-width:420px;font-size:12px;color:#6b665e}}
  .meta b{{color:#16130F}}
</style>
<div class="sheet">{svg}</div>
<div class="meta">
  <b>{title} 안내문 · 세로 A5 (420×595) · 실제 크기</b><br>
  글자는 Paperlogy 아웃라인(벡터)이라 폰트 설치와 무관하게 동일하게 보입니다.<br>
  제목폭 {titleWidth} · 본문폭 {bodyWidths} (최대 {maxw}) · 픽토 하단 y{pictoBottom} · 로고 높이 {logoH}
</div>
"""

NOTICES = {
    "light": {
        "picto": "light",
        "title": "조명",
        "body": ["조명은 저희가 원격으로 끄고 있어요.",
                 "나가실 때는 뒷정리만 편하게 하고 나가주시면 돼요."],
    },
}

if __name__ == "__main__":
    import sys
    keys = sys.argv[1:] or list(NOTICES)
    os.makedirs(OUT, exist_ok=True)
    for k in keys:
        spec = NOTICES[k]
        svg, info = build(spec)
        with open(os.path.join(OUT, f"notice-{k}.svg"), "w", encoding="utf-8") as f:
            f.write(svg)
        with open(os.path.join(OUT, f"notice-{k}.html"), "w", encoding="utf-8") as f:
            f.write(PREVIEW.format(title=spec["title"], svg=svg, maxw=BODY_MAXW, **info))
        print(f"notice-{k}.svg  {info}")
