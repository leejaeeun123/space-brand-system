# -*- coding: utf-8 -*-
"""픽토그램·타입 태그 색상 변형 3종 생성 (기하 정보는 건드리지 않음).

배경: 아웃라인 픽토는 `fill="currentColor"` + `<svg color="#16130F">` 조합이었다.
브라우저에서는 잉크로 보이지만 **Illustrator·Figma 등은 `color` 표현 속성을 무시**해
`currentColor`가 기본값(검정 #000)으로 떨어진다. 그래서 디자인 툴에서 열면 전부 검정.

→ 기본 파일은 **리터럴 잉크(#16130F)**로 고정하고, 반전·웹용은 별도 변형으로 뺀다.

| 파일 | fill | 용도 |
|---|---|---|
| `picto-X.svg` | `#16130F` | **기본** — 어떤 툴·환경에서도 잉크. 인쇄·사이니지 발주·`<img>` |
| `picto-X-white.svg` | `#ffffff` | 잉크·오렌지 배경 반전용 |
| `picto-X-current.svg` | `currentColor` | 웹 인라인 — CSS `color`로 제어 |

기하는 기존 패스를 그대로 재사용한다(재생성 아님).
⚠️ `outline_picto.py`는 같은 폴더의 파일을 읽어 **제자리 변환**하는 1회성 스크립트라
재실행하면 이미 아웃라인된 패스를 다시 버퍼링한다. 색만 고칠 때는 이 스크립트를 쓸 것.
"""
import os, re, glob

HERE = os.path.dirname(os.path.abspath(__file__))
INK = "#16130F"
VARIANTS = [("", INK), ("-white", "#ffffff"), ("-current", "currentColor")]


def base_files():
    for p in sorted(glob.glob(os.path.join(HERE, "picto-*.svg"))):
        stem = os.path.basename(p)[:-4]
        if stem.endswith("-white") or stem.endswith("-current"):
            continue
        yield stem, p


count = 0
for stem, path in base_files():
    with open(path, encoding="utf-8") as f:
        src = f.read()

    # 루트의 color 표현 속성 제거 — 이제 fill이 리터럴이라 불필요하고,
    # 툴마다 해석이 갈리는 원인이었다.
    src = re.sub(r'\s+color="[^"]*"', "", src, count=1)

    for suffix, fill in VARIANTS:
        out = re.sub(r'fill="(?:currentColor|#[0-9A-Fa-f]{3,6})"',
                     f'fill="{fill}"', src)
        # fill-rule은 유지, fill만 교체됐는지 확인
        assert f'fill="{fill}"' in out, stem
        with open(os.path.join(HERE, f"{stem}{suffix}.svg"), "w", encoding="utf-8") as f:
            f.write(out)
        count += 1
    print(f"recolored {stem}  → ink · white · current")

print(f"\n{count} files written")


# ---------- 타입 태그(mode-*.svg) ----------
# 기존 mode-X-ink.svg(잉크)를 원본으로 삼아 색만 바꾼다.
# gen_modes.py로 재생성하지 않는 이유: Paperlogy TTF 빌드가 다르면 글리프 좌표가
# 미세하게 달라져 커밋된 아웃라인과 어긋난다. 색만 바꿀 때는 기하를 건드리지 않는다.
MODES = ["work", "class", "gathering"]
for m in MODES:
    src_path = os.path.join(HERE, f"mode-{m}-ink.svg")
    if not os.path.exists(src_path):
        print(f"skip mode-{m} (원본 없음)")
        continue
    with open(src_path, encoding="utf-8") as f:
        src = f.read()
    for suffix, fill in (("", INK), ("-ink", INK), ("-white", "#ffffff"),
                         ("-current", "currentColor")):
        out = src.replace('<g fill="#16130F"', f'<g fill="{fill}"')
        with open(os.path.join(HERE, f"mode-{m}{suffix}.svg"), "w", encoding="utf-8") as f:
            f.write(out)
    print(f"recolored mode-{m}  → ink(기본) · white · current")
