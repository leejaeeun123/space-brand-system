# -*- coding: utf-8 -*-
"""안내문 생성기 — A5 안내문 SVG + HTML 미리보기 (세로 420×595 / 가로 595×420).

notice-template.md 규격을 그대로 코드화한다. Paperlogy 글리프를 fontTools로
아웃라인 패스로 변환하므로 결과 SVG는 폰트 의존성이 0 — Figma MCP가 로컬
폰트를 못 읽는 환경에서도 인쇄 결과와 100% 동일하게 임포트된다.

재현: python gen_notice.py            (NOTICES 전체 생성)
      python gen_notice.py light      (특정 건만)
출력: out/notice-{key}.svg  +  out/notice-{key}.html (미리보기)
"""
import base64
import os
import re

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")
FONTDIR = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts")

INK = "#16130F"
PICTO_H = 44             # 픽토 높이 기본값 (안내문별 override)
TITLE_TRACK = 0.45
BODY_SIZE, BODY_LEAD, BODY_TRACK = 11, 16, 0.44
LOGO_W = 76

# 판형 2종. 세로가 기본이고, 가로는 벽 직접부착 전용(별도 요청 시).
# 값은 Figma `최종` 페이지 확정 프레임에서 실측한 것 — 추정 없음.
GEO = {
    # MAXW = 본문 한 줄 최대폭. 세로 325 는 재은 확정값(여백 역산 322 아님).
    "portrait":  dict(W=420, H=595, PICTO_CY=72, TITLE_TOP=None, TITLE_GAP=18,
                      TITLE_SIZE=15, TITLE_LEAD=None, BODY_TOP=405, LOGO_Y=539, MAXW=325),
    "landscape": dict(W=595, H=420, PICTO_CY=67, TITLE_TOP=101, TITLE_GAP=None,
                      TITLE_SIZE=14, TITLE_LEAD=12,   BODY_TOP=254, LOGO_Y=367, MAXW=497),
}

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


def picto_svg(name, height, g):
    """picto-{name}.svg 를 가로중앙·세로중심 PICTO_CY 에 맞춰 배치."""
    with open(os.path.join(HERE, f"picto-{name}.svg"), encoding="utf-8") as fp:
        ds = _paths_of(fp.read())
    x0, y0, x1, y1 = _bbox(ds)
    s = height / (y1 - y0)
    w = (x1 - x0) * s
    tx = g["W"] / 2 - w / 2 - x0 * s
    ty = g["PICTO_CY"] - height / 2 - y0 * s
    body = "\n    ".join(f'<path fill="{INK}" fill-rule="evenodd" d="{d}"/>' for d in ds)
    out = (f'<g transform="translate({_fmt(tx)},{_fmt(ty)}) scale({_fmt6(s)})">\n    '
           f'{body}\n  </g>')
    return out, g["PICTO_CY"] + height / 2


def qr_svg(filename, g, y=329, size=60):
    """QR 비트맵을 base64 로 내장(가로중앙). Figma 확정 위치·크기 기준."""
    with open(os.path.join(HERE, filename), "rb") as fp:
        b64 = base64.b64encode(fp.read()).decode()
    return (f'<image x="{_fmt(g["W"] / 2 - size / 2)}" y="{y}" width="{size}" height="{size}" '
            f'href="data:image/png;base64,{b64}"/>')


def logo_svg(g):
    """확정 워드마크(가로형) 를 폭 LOGO_W 로 배치. PAD 40 은 제거."""
    p = os.path.join(ROOT, "03-identity", "logo-wordmark-h-ink.svg")
    with open(p, encoding="utf-8") as fp:
        src = fp.read()
    inner = src[src.index(">", src.index("<svg")) + 1: src.rindex("</svg>")].strip()
    vb = [float(v) for v in re.findall(r"-?\d+\.?\d*", re.search(r'viewBox="([^"]+)"', src).group(1))]
    cw, ch = vb[2] + 2 * vb[0], vb[3] + 2 * vb[1]   # PAD(=-vb[0]) 양쪽 제거
    s = LOGO_W / cw
    x = g["W"] / 2 - LOGO_W / 2
    return (f'<g transform="translate({_fmt(x)},{_fmt(g["LOGO_Y"])}) scale({_fmt6(s)}) '
            f'translate({_fmt(-vb[0])},{_fmt(-vb[1])})">\n    {inner}\n  </g>'), ch * s


def build(spec):
    g = dict(GEO[spec.get("orient", "portrait")])
    for k in ("PICTO_CY", "TITLE_TOP", "BODY_TOP"):        # 안내문별 실측 오버라이드
        if k.lower() in spec:
            g[k] = spec[k.lower()]
    W, H = g["W"], g["H"]
    maxw = g["MAXW"]
    warn = []

    picto, picto_bottom = picto_svg(spec["picto"], spec.get("picto_h", PICTO_H), g)
    parts = [picto]

    # 제목 — 세로형은 픽토 하단 기준, 가로형은 고정 top(실측)
    t_size = spec.get("title_size", g["TITLE_SIZE"])
    t_lead = spec.get("title_lead", g["TITLE_LEAD"])
    t_top = g["TITLE_TOP"] if g["TITLE_TOP"] is not None else picto_bottom + g["TITLE_GAP"]
    t_lines = spec["title"].split("\n")
    tw = 0
    for i, line in enumerate(t_lines):
        if t_lead:
            bl = baseline_fixed(t_top, "4Regular", t_size, t_lead, i)
        else:   # leading=normal — 다중행이면 자연 행간
            _, _, _, _, upem, asc, desc = font("4Regular")
            bl = baseline_normal(t_top, "4Regular", t_size) + i * (asc - desc) / upem * t_size
        tg, adv = emit_text(line, "4Regular", t_size, TITLE_TRACK, W / 2, bl)
        parts.append(tg)
        tw = max(tw, adv)

    if spec.get("qr"):
        parts.append(qr_svg(spec["qr"], g))

    lines = spec.get("body") or []
    if len(lines) > 3:
        warn.append(f"본문 {len(lines)}줄 (권장 2줄·최대 3줄)")
    widths = []
    for i, line in enumerate(lines):
        bg_, adv = emit_text(line, "3Light", BODY_SIZE, BODY_TRACK, W / 2,
                             baseline_fixed(g["BODY_TOP"], "3Light", BODY_SIZE, BODY_LEAD, i))
        parts.append(bg_)
        widths.append(adv)
    for l, w in zip(lines, widths):
        if w > maxw:
            warn.append(f"폭 초과 {round(w, 1)}>{maxw}: {l!r}")

    logo, lh = logo_svg(g)
    parts.append(logo)

    label = spec["title"].replace("\n", " ")
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
           f'width="{W}" height="{H}" role="img" aria-label="{label} 안내문">\n'
           f'  <rect width="{W}" height="{H}" fill="#ffffff"/>\n  '
           + "\n  ".join(parts) + "\n</svg>\n")
    return svg, {"orient": spec.get("orient", "portrait"), "titleWidth": round(tw, 1),
                 "bodyWidths": [round(w, 1) for w in widths],
                 "pictoBottom": round(picto_bottom, 1), "logoH": round(lh, 2),
                 "maxw": maxw, "warn": warn}


PREVIEW = """<!doctype html><meta charset="utf-8"><title>{titleLabel} 안내문 — 미리보기</title>
<style>
  body{{margin:0;padding:48px;background:#EFEDE9;font:13px/1.6 system-ui,sans-serif;color:#16130F;
       display:flex;flex-direction:column;align-items:center;gap:24px}}
  .sheet{{background:#fff;box-shadow:0 2px 24px rgba(0,0,0,.12)}}
  .meta{{max-width:600px;font-size:12px;color:#6b665e}}
  .meta b{{color:#16130F}}
  .warn{{color:#E2531E}}
</style>
<div class="sheet">{svg}</div>
<div class="meta">
  <b>{titleLabel} 안내문 · {sizeLabel} · 실제 크기</b><br>
  글자는 Paperlogy 아웃라인(벡터)이라 폰트 설치와 무관하게 동일하게 보입니다.<br>
  제목폭 {titleWidth} · 본문폭 {bodyWidths} (최대 {maxw}) · 픽토 하단 y{pictoBottom} · 로고 높이 {logoH}
  <div class="warn">{warnLabel}</div>
</div>
"""

# 문구는 Figma `최종` 페이지 확정 프레임에서 그대로 가져왔다(정본 = notice-copy.md).
# picto_h 도 Figma 실측값 — 픽토마다 시각 무게가 달라 일괄 높이를 쓰지 않는다.
NOTICES = {
    # ── 세로 A5 (자석 안내판) ─────────────────────────────
    "wifi": {
        "picto": "wifi", "picto_h": 30.9, "title": "와이파이",
        "qr": "wifi-qr.png",
        "body": ["ID : TYPE LOUNGE", "PW : 075C62183A"],
    },
    "aircon": {
        "picto": "aircon", "picto_h": 41, "title": "냉난방기",
        "body": ["여름과 겨울에는 냉난방기가 자동으로 가동돼요.",
                 "온도를 바꾸려면 거울 선반 위 작은 흰색 리모컨을 쓰시면 돼요."],
    },
    "bluetooth": {
        "picto": "bluetooth", "picto_h": 48, "title": "블루투스 스피커",
        "body": ["TV 아래 스피커 뒤쪽의 전원 버튼을",
                 "3초간 길게 누르면 파란 불이 깜빡이며 페어링 모드가 돼요.",
                 "기기의 블루투스 목록에서 BTR212를 고르시면 연결돼요."],
    },
    "tv": {
        "picto": "tv", "picto_h": 37, "title": "TV",
        "body": ["노트북 화면은 TV 뒤쪽 HDMI 단자에 케이블을 꽂으면 띄울 수 있어요.",
                 "거울 선반 위 검은 TV 리모컨으로 입력을 HDMI로 바꿔주시면 돼요."],
    },
    "light": {
        "picto": "light", "picto_h": 44, "title": "조명",
        "body": ["조명은 저희가 원격으로 끄고 있어요.",
                 "나가실 때는 뒷정리만 편하게 하고 나가주시면 돼요."],
    },
    # ── 가로 A5 (벽 직접부착) ─────────────────────────────
    "shoe": {
        "orient": "landscape", "picto": "shoe", "picto_h": 28, "title": "신발장",
        "body": ["실내에서는 슬리퍼를 신어요.",
                 "검은 슬리퍼는 큰 사이즈, 흰 슬리퍼는 작은 사이즈로 놓여 있어요.",
                 "편한 것으로 신으시면 돼요."],
    },
    "trash": {
        "orient": "landscape", "picto": "trash", "picto_h": 42, "title": "쓰레기 처리 방법",
        "body": ["일반쓰레기와 재활용쓰레기는 각각 표시된 쓰레기통에 나눠 버려주세요.",
                 "이름이나 연락처가 적힌 영수증은 꼭 찢어서 버려주세요.",
                 "음식물은 최대한 남기지 않도록 챙겨주시고, 남은 건 용기에 담아 일반 쓰레기로 버려주세요."],
    },
    "urinal": {   # 본문 없는 경고문 변형 — 제목만 24px 2줄 (Figma 실측 반영)
        "orient": "landscape", "picto": "no", "picto_h": 53,
        "picto_cy": 86.5, "title_top": 133, "title_size": 24, "title_lead": 28,
        "title": "소변기 사용 금지\n(고장)", "body": [],
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
        g = GEO[info["orient"]]
        label = spec["title"].replace("\n", " ")
        size_label = ("세로" if info["orient"] == "portrait" else "가로") + f' A5 ({g["W"]}×{g["H"]})'
        with open(os.path.join(OUT, f"notice-{k}.html"), "w", encoding="utf-8") as f:
            f.write(PREVIEW.format(svg=svg, titleLabel=label, sizeLabel=size_label,
                                   warnLabel=" / ".join(info["warn"]), **info))
        flag = "  ⚠ " + " / ".join(info["warn"]) if info["warn"] else ""
        print(f'notice-{k}.svg  {info["orient"]:9s} 제목폭 {info["titleWidth"]:6} '
              f'본문폭 {info["bodyWidths"]}{flag}')
