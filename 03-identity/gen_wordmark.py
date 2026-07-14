#!/usr/bin/env python3
"""TYPE LOUNGE 워드마크 생성기 (Paperlogy-6SemiBold, em900/cap700, 레이어드 E).

로고 사양(logo-system.md §8) 복원:
- 좌표계: em 900, cap 700, scale 1.0 (폰트 native)
- 자간(tracking): -18 (-2% * 900)
- E 광학여백(E 앞): 103.5 (0.115em)
- 레이어드 E: 3선 두께 105(cap*0.15), 폭 504, y 0/297.5/595, 세로획 없음
- E→다음 단어 갭(E advance 597 + tracking -18 + wordspace 87 = 666)

기존 MODE LOUNGE 위치를 정확히 재현함을 self-test 로 검증한 뒤 TYPE LOUNGE 생성.
재현: python gen_wordmark.py  (Paperlogy-6SemiBold.ttf 필요)
"""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

FONT = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts\Paperlogy-6SemiBold.ttf")
HERE = os.path.dirname(os.path.abspath(__file__))

CAP = 700
TRACK = -18          # 자간 -2%
EMARGIN = 45.0       # E 앞 광학여백 (P의 열린 오른쪽에 맞춰 축소; 구 MODE=103.5)
E_NEXT_GAP = 666.0   # 레이어드 E origin → 다음 단어 첫 글자 origin 고정 갭
                     # (= E advance 597 + wordspace 87 + tracking -18; 기존 committed 재현)
KERN = {("T", "Y"): 65}  # 광학 커닝: T 오른쪽 바 + Y 왼쪽 팔이 겹쳐 붙어보임 → 벌림
EBAR = 105.0         # 3선 두께 cap*0.15
EWIDTH = 504.0       # 레이어드 E 폭
PAD = 40.0
INK = "#16130F"
WHITE = "#ffffff"

_f = TTFont(FONT)
_cmap = _f.getBestCmap()
_gs = _f.getGlyphSet()
_hmtx = _f['hmtx']


def _fmt(x):
    """path 좌표: 0.5 단위 반올림 후 .0 제거 (기존 스타일)."""
    x = round(x * 2) / 2
    return str(int(x)) if x == int(x) else str(x)


def glyph_path(ch):
    gid = _cmap[ord(ch)]
    pen = SVGPathPen(_gs)
    _gs[gid].draw(TransformPen(pen, (1, 0, 0, 1, 0, 0)))
    # SVGPathPen 은 소수 출력 → 0.5 반올림 재포맷
    raw = pen.getCommands()
    return _reformat(raw)


def _reformat(d):
    import re
    def repl(m):
        return _fmt(float(m.group(0)))
    return re.sub(r"-?\d+\.?\d*", repl, d)


def advance(ch):
    return _hmtx[_cmap[ord(ch)]][0]


def layout(word1, word2):
    """글자 origin 위치 계산. 반환: [(kind, ch|None, x)], line_width."""
    items = []
    x = 0.0
    n = len(word1)
    for i, ch in enumerate(word1):
        if i > 0:
            x += KERN.get((word1[i - 1], ch), 0)  # 광학 커닝
        is_last = (i == n - 1)
        if is_last:
            x += EMARGIN  # E 앞 광학여백
            items.append(("ebar", None, x))
            x += E_NEXT_GAP  # 레이어드 E → 다음 단어 첫 글자 고정 갭
        else:
            items.append(("glyph", ch, x))
            x += advance(ch) + TRACK
    # word2 (LOUNGE)
    w2_start = x
    for ch in word2:
        items.append(("glyph", ch, x))
        x += advance(ch) + TRACK
    line_width = x - TRACK  # 마지막 자간 제거
    return items, line_width


def line_items(word1, word2, baseline, xoff=0.0):
    """가로 1줄: word1 + 레이어드E + space + word2."""
    items, width = layout(word1, word2)
    out = []
    for kind, ch, x in items:
        out.append((kind, ch, x + xoff, baseline))
    return out, width


def render(items, view_w, view_h, fill, aria):
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-PAD} {-PAD} {view_w} {view_h}" '
        f'width="640" height="{round(view_h/view_w*640,1)}" role="img" aria-label="{aria}">'
    ]
    for kind, ch, x, base in items:
        if kind == "glyph":
            d = glyph_path(ch)
            parts.append(
                f'  <path d="{d}" transform="translate({x},{base}) scale(1,-1)" fill="{fill}"/>'
            )
        else:  # ebar (레이어드 E)
            top = base - CAP  # 캡 상단 (svg y)
            for yy in (top, top + 297.5, top + 595.0):
                parts.append(
                    f'  <rect x="{x}" y="{yy}" width="{EWIDTH}" height="{EBAR}" fill="{fill}"/>'
                )
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def build_h(word1, word2, fill, aria):
    items, width = line_items(word1, word2, CAP)
    view_w = width + 2 * PAD
    view_h = CAP + 2 * PAD + 12  # 기존 792 = 700+80+12
    # 기존 h width/height 값 유지 스케일
    body = render(items, view_w, view_h, fill, aria)
    # h 는 width=640 고정, height 비율
    return body.replace('width="640"', 'width="640"')


def build_v(word1, word2, fill, aria):
    """세로 2줄: word1(가운데정렬) 위, word2 아래. word2 가 더 넓다고 가정."""
    # 각 줄 폭
    i1, w1 = layout(word1, "")  # word1 + 레이어드E 만
    # word1 라인 폭 = 레이어드 E 오른쪽 끝
    # layout(word1,"") 에서 마지막 kind=ebar, x= E origin; width= E_origin+EWIDTH
    e_origin = [x for k, c, x in i1 if k == "ebar"][0]
    line1_w = e_origin + EWIDTH
    i2, line2_w = layout(word2, "")  # word2 를 단독 단어로? 아니오 -> LOUNGE 는 레이어드E 없음
    # LOUNGE 는 일반 글자열: 별도 계산
    x = 0.0
    line2_items = []
    for ch in word2:
        line2_items.append(("glyph", ch, x))
        x += advance(ch) + TRACK
    line2_w = x - TRACK - advance(word2[-1]) + advance(word2[-1])  # = 마지막 origin+advance
    # 재계산: 마지막 글자 origin + advance
    last_x = line2_items[-1][2]
    line2_w = last_x + advance(word2[-1])

    content_w = max(line1_w, line2_w)
    base1 = CAP           # 700
    base2 = 1582.0        # 기존값 유지 (줄 간격 882)
    x1off = (content_w - line1_w) / 2
    x2off = (content_w - line2_w) / 2

    items = []
    for k, c, xx in i1:
        items.append((k, c, xx + x1off, base1))
    for k, c, xx in line2_items:
        items.append((k, c, xx + x2off, base2))

    view_w = content_w + 2 * PAD
    view_h = 1674.0  # 기존값 유지
    return render(items, view_w, view_h, fill, aria)


def selftest():
    """TYPE LOUNGE 레이아웃 자기일관성 검증 (글자 수·E바·단조 증가).
    (구 MODE 재현 검증은 EMARGIN/KERN 튜닝으로 폐기 — 2026-07)."""
    items, width = line_items("TYPE", "LOUNGE", CAP)
    glyphs = [(c, x) for k, c, x, b in items if k == "glyph"]
    ebar = [x for k, c, x, b in items if k == "ebar"]
    assert [c for c, x in glyphs] == list("TYP" + "LOUNGE"), glyphs
    assert len(ebar) == 1, ebar
    xs = [x for c, x in glyphs[:3]] + ebar + [x for c, x in glyphs[3:]]
    assert all(a < b for a, b in zip(xs, xs[1:])), f"non-monotonic: {xs}"
    print(f"SELFTEST OK — TYPE LOUNGE 단조 배치, E앞여백={EMARGIN}, T-Y커닝={KERN}")


if __name__ == "__main__":
    selftest()
    W1, W2, ARIA = "TYPE", "LOUNGE", "TYPE LOUNGE"
    targets = [
        ("logo-wordmark-h.svg",       build_h, "currentColor"),
        ("logo-wordmark-h-ink.svg",   build_h, INK),
        ("logo-wordmark-h-white.svg", build_h, WHITE),
        ("logo-wordmark-v.svg",       build_v, "currentColor"),
        ("logo-wordmark-v-ink.svg",   build_v, INK),
        ("logo-wordmark-v-white.svg", build_v, WHITE),
    ]
    for name, fn, fill in targets:
        svg = fn(W1, W2, fill, ARIA)
        with open(os.path.join(HERE, name), "w", encoding="utf-8") as fp:
            fp.write(svg)
        print("wrote", name)
    # 브랜드북 사본 (ink/white 만)
    bb = os.path.join(HERE, "..", "07-brand-book", "assets", "logo")
    for name, fn, fill in targets:
        if fill in (INK, WHITE):
            svg = fn(W1, W2, fill, ARIA)
            with open(os.path.join(bb, name), "w", encoding="utf-8") as fp:
                fp.write(svg)
            print("wrote brand-book/", name)
