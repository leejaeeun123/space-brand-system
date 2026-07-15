# -*- coding: utf-8 -*-
"""브랜드북 index.html → 단일 자립 HTML (에셋·폰트 전부 내장).
- SVG/PNG → base64 data URI (이미지 + 다운로드 링크 모두)
- Paperlogy 400/600 → 사용 글자만 subset한 woff base64 @font-face
- 외부 CDN·상대경로 의존 0"""
import os, re, base64, io
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

BOOK = "C:/Users/jaeeu/space-brand-system/07-brand-book"
SCR = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BOOK, "index.html")
OUT = os.path.join(BOOK, "index-standalone.html")

html = open(SRC, encoding="utf-8").read()

# ---------- 1) 다운로드 앵커에 파일명 부여 (bare download → download="basename") ----------
html = re.sub(r'(href="assets/[^"]*/([^"/]+\.svg)")(\s+)download\b(?!=)',
              r'\1\3download="\2"', html)

# ---------- 2) 에셋 → data URI (SVG 원본, PNG 사진은 JPEG 압축) ----------
from PIL import Image
MIME = {".svg": "image/svg+xml", ".png": "image/png"}
asset_paths = sorted(set(re.findall(r'(assets/[^"]+\.(?:svg|png))', html)))
for rel in asset_paths:
    fp = os.path.join(BOOK, rel)
    ext = os.path.splitext(rel)[1].lower()
    if ext == ".png":  # 목업 사진 → JPEG(용량 대폭 축소; 업로드 크기 제한 대응)
        im = Image.open(fp).convert("RGB")
        if im.width > 1400:
            im = im.resize((1400, round(im.height * 1400 / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=82, optimize=True)
        uri = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    else:
        data = open(fp, "rb").read()
        uri = f"data:{MIME[ext]};base64," + base64.b64encode(data).decode()
    html = html.replace(rel, uri)
print(f"에셋 {len(asset_paths)}개 인라인 (PNG→JPEG 압축)")

# ---------- 3) 폰트 subset (사용 글자만) → woff base64 ----------
# 문자셋: 원본 HTML 전체 문자 (data URI 주입 전 텍스트에서 뽑아야 하므로 원본 재로드)
orig = open(SRC, encoding="utf-8").read()
charset = set(orig)
charset |= set(" 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
text = "".join(sorted(charset))

def subset_woff_b64(ttf_path, text):
    opts = Options()
    opts.flavor = "woff"          # zlib 압축(브otli 불필요)
    opts.desubroutinize = True
    opts.layout_features = ["*"]
    opts.notdef_outline = True
    opts.recalc_bounds = True
    font = TTFont(ttf_path)
    sub = Subsetter(options=opts)
    sub.populate(text=text)
    sub.subset(font)
    buf = io.BytesIO()
    font.flavor = "woff"
    font.save(buf)
    return base64.b64encode(buf.getvalue()).decode()

faces = []
for weight, ttf in [(400, "Paperlogy-4Regular.ttf"), (600, "Paperlogy-6SemiBold.ttf")]:
    b64 = subset_woff_b64(os.path.join(SCR, ttf), text)
    faces.append(
        "@font-face{font-family:'Paperlogy';font-style:normal;font-weight:%d;"
        "font-display:swap;src:url(data:font/woff;base64,%s) format('woff');}" % (weight, b64))
    print(f"폰트 {weight} subset woff: {len(b64)//1024} KB(base64)")
fontcss = "\n".join(faces) + "\n"

# ---------- 4) CDN link 제거 + @font-face 주입 ----------
html = re.sub(r'\s*<link[^>]*Paperlogy\.css[^>]*>\s*', "\n", html)
html = html.replace("<style>", "<style>\n" + fontcss, 1)

open(OUT, "w", encoding="utf-8").write(html)
kb = len(html.encode("utf-8")) // 1024
print(f"\n✅ {OUT}\n   최종 크기 {kb} KB ({kb/1024:.1f} MB)")
# 잔여 외부/상대 참조 점검
leftover = re.findall(r'(?:src|href)="(?!data:|#)([^"]+)"', html)
print("   잔여 비-data 참조:", leftover if leftover else "없음 ✓")