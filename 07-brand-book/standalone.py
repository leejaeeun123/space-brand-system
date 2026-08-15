# -*- coding: utf-8 -*-
"""빌드된 브랜드북 페이지 → 단일 자립 HTML (에셋·폰트 전부 내장).

build_book.py 가 site/ 를 만든 뒤 호출한다. 단독 실행도 가능:

    python 07-brand-book/standalone.py

- SVG → base64 data URI, 사진 PNG/JPG → JPEG 압축 후 data URI
- Paperlogy 400/600 → 실제 사용 글자만 subset 한 woff base64 @font-face
- 외부 CDN·상대경로 의존 0 (Figma·메신저 첨부용)

zip·md 같은 비-이미지 다운로드 링크는 인라인할 수 없으므로 절대 URL(BASE)로 돌린다.
"""
import os, re, io, base64, sys

BOOK = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(BOOK, "site")
OUT = os.path.join(SITE, "standalone")
BASE = "https://typelounge.vercel.app/brand/"

PAGES = ["index.html", "bx.html", "signage.html", "product.html"]
SLUG = {"index.html": "brand", "bx.html": "bx", "signage.html": "signage", "product.html": "product"}

FONTDIR = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts")
FONTS = [(400, "Paperlogy-4Regular.ttf"), (600, "Paperlogy-6SemiBold.ttf")]


def find_font(ttf):
    for d in (BOOK, FONTDIR, os.path.expandvars(r"%WINDIR%\Fonts")):
        p = os.path.join(d, ttf)
        if os.path.exists(p):
            return p
    return None


def subset_woff_b64(ttf_path, text):
    from fontTools.ttLib import TTFont
    from fontTools.subset import Subsetter, Options
    opts = Options()
    opts.flavor = "woff"          # zlib — brotli 불필요
    opts.desubroutinize = True
    opts.layout_features = ["*"]
    opts.notdef_outline = True
    font = TTFont(ttf_path)
    sub = Subsetter(options=opts)
    sub.populate(text=text)
    sub.subset(font)
    buf = io.BytesIO()
    font.flavor = "woff"
    font.save(buf)
    return base64.b64encode(buf.getvalue()).decode()


def data_uri(rel):
    fp = os.path.join(SITE, rel)
    ext = os.path.splitext(rel)[1].lower()
    if ext in (".png", ".jpg", ".jpeg"):
        from PIL import Image
        im = Image.open(fp).convert("RGB")
        # 단일 파일은 첨부·공유용이라 원본 해상도가 필요 없다. 커밋 용량도 여기서 결정된다.
        if im.width > 1000:
            im = im.resize((1000, round(im.height * 1000 / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=76, optimize=True)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    data = open(fp, "rb").read()
    mime = {".svg": "image/svg+xml", ".ico": "image/x-icon"}.get(ext, "application/octet-stream")
    return "data:%s;base64,%s" % (mime, base64.b64encode(data).decode())


def build():
    os.makedirs(OUT, exist_ok=True)
    srcs = {p: open(os.path.join(SITE, p), encoding="utf-8").read() for p in PAGES}

    # ---- 폰트: 네 페이지의 글자 합집합으로 한 번만 subset ----
    charset = set().union(*(set(t) for t in srcs.values()))
    charset |= set(" 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
    text = "".join(sorted(charset))
    faces = []
    for weight, ttf in FONTS:
        path = find_font(ttf)
        if not path:
            print("   ! 폰트 없음:", ttf, "— standalone 은 CDN 폰트를 그대로 쓴다")
            faces = None
            break
        b64 = subset_woff_b64(path, text)
        faces.append("@font-face{font-family:'Paperlogy';font-style:normal;font-weight:%d;"
                     "font-display:swap;src:url(data:font/woff;base64,%s) format('woff');}" % (weight, b64))

    cache = {}
    for page, html in srcs.items():
        # 1) 이미지·아이콘 → data URI
        # 따옴표 안의 경로만 — MD view <pre> 안의 원본 마크다운은 건드리지 않는다
        refs = set(re.findall(r'"(assets/[^"\s]+\.(?:svg|png|jpe?g))"', html))
        for rel in sorted(refs, key=len, reverse=True):
            if rel not in cache:
                cache[rel] = data_uri(rel)
            html = html.replace('"%s"' % rel, '"%s"' % cache[rel])

        # 2) 남은 상대 링크(zip·md·다른 탭) → 절대 URL
        html = re.sub(r'(?:src|href)="(?!https?:|#|data:|mailto:)([^"]+)"',
                      lambda m: m.group(0).replace('"%s"' % m.group(1), '"%s%s"' % (BASE, m.group(1))), html)

        # 3) 폰트 인라인 + CDN 링크 제거
        if faces:
            html = re.sub(r'\s*<link[^>]*Paperlogy\.css[^>]*>\s*', "\n", html)
            html = html.replace("<style>", "<style>\n" + "\n".join(faces) + "\n", 1)

        # 4) 자기 자신을 가리키는 다운로드 항목은 제거(단일 파일 안에서 의미 없음)
        html = html.replace('<a href="%sstandalone/%s.html" download>' % (BASE, SLUG[page]),
                            '<a href="%s%s">' % (BASE, page))

        dst = os.path.join(OUT, SLUG[page] + ".html")
        open(dst, "w", encoding="utf-8").write(html)
        kb = len(html.encode("utf-8")) // 1024
        print("   standalone/%-14s %5d KB" % (SLUG[page] + ".html", kb))


if __name__ == "__main__":
    if not os.path.isdir(SITE):
        sys.exit("site/ 가 없다 — 먼저 build_book.py 를 실행한다")
    build()
