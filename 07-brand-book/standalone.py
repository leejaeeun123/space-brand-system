# -*- coding: utf-8 -*-
"""빌드된 브랜드북 페이지 → 단일 자립 HTML (에셋·폰트 전부 내장).

build_book.py 가 site/ 를 만든 뒤 호출한다. 단독 실행도 가능:

    python 07-brand-book/standalone.py

- SVG → base64 data URI, 사진 PNG/JPG → JPEG 압축 후 data URI
- Paperlogy 400/600 → 실제 사용 글자만 subset 한 woff base64 @font-face
- 외부 CDN·상대경로 의존 0 (Figma·메신저 첨부용)

네 페이지를 한 문서에 담아 standalone/index.html 하나만 만든다 — 탭 전환은 .shell 교체로 한다.
"""
import os, re, io, json, base64, sys

BOOK = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(BOOK, "site")
OUT = os.path.join(SITE, "standalone")
# 단일 파일은 외부를 타지 않는다 — 자산·zip 을 전부 내장한다.
# (typelounge.vercel.app/brand 는 배포돼 있지 않아 절대 URL 로 돌리면 404 다)

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
    mime = {".svg": "image/svg+xml", ".ico": "image/x-icon",
            ".zip": "application/zip"}.get(ext, "application/octet-stream")
    return "data:%s;base64,%s" % (mime, base64.b64encode(data).decode())


def build():
    os.makedirs(OUT, exist_ok=True)
    srcs = {p: open(os.path.join(SITE, p), encoding="utf-8").read() for p in PAGES}
    # site 페이지에는 배포 경로 <base> 가 박혀 있다. 단일 파일은 어디서 열려도 자립해야 하므로 뺀다.
    srcs = {k: re.sub(r'<base [^>]*>\s*', "", v) for k, v in srcs.items()}

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

    cache, inlined = {}, {}
    for page, html in srcs.items():
        # 0) 내장 SVG 페이로드 제거 — 단일 파일은 아래에서 전부 data URI 로 바뀌므로 중복이다
        html = re.sub(r'<script id="tl-files".*?</script>\s*', "", html, flags=re.S)

        # 1) 이미지·아이콘 → data URI
        # 따옴표 안의 경로만 — MD view <pre> 안의 원본 마크다운은 건드리지 않는다
        refs = set(re.findall(r'"(assets/[^"\s]+\.(?:svg|png|jpe?g))"', html))
        for rel in sorted(refs, key=len, reverse=True):
            if rel not in cache:
                cache[rel] = data_uri(rel)
            html = html.replace('"%s"' % rel, '"%s"' % cache[rel])

        # 2) 폰트 인라인 + CDN 링크 제거
        if faces:
            html = re.sub(r'\s*<link[^>]*Paperlogy\.css[^>]*>\s*', "\n", html)
            html = html.replace("<style>", "<style>\n" + "\n".join(faces) + "\n", 1)

        inlined[page] = html

    write_combined(inlined)


def split_shell(html):
    """(헤더까지, .shell 블록, <script> 이후) — 탭을 갈아끼우는 단위가 .shell 이다."""
    i = html.index('<div class="shell">')
    j = html.index("<script>", i)
    return html[:i], html[i:j], html[j:]


def write_combined(inlined):
    """네 페이지를 한 문서에 담은 standalone/index.html.

    탭을 누르면 .shell 안만 갈아끼우고 TLpage() 를 다시 부른다 — id 가 겹치지 않게
    보이는 페이지 하나만 DOM 에 두는 방식이다. 오프라인(file://)에서도 자산이 전부
    data URI 라 SVG·MD 다운로드가 그대로 동작한다.
    """
    head, shell0, tail = split_shell(inlined["index.html"])

    def to_tabs(html):
        """페이지 링크 → 탭 전환 트리거. 헤더 탭뿐 아니라 사이드바의 'Brand book' 목록도 같다."""
        for page, slug in SLUG.items():
            html = html.replace('href="%s"' % page, 'href="#%s" data-pg="%s"' % (slug, slug))
        return html

    head = to_tabs(head)
    shell0 = to_tabs(shell0)
    # 자기 자신을 받는 항목은 단일 파일 안에서 의미가 없다
    head = re.sub(r'\s*<a href="standalone/index.html"[^>]*>.*?</a>', "", head, flags=re.S)

    tpl = []
    for page, slug in SLUG.items():
        if page == "index.html":
            continue
        _, shell, _ = split_shell(inlined[page])
        tpl.append('<script type="text/template" data-pg="%s">%s</script>' % (slug, to_tabs(shell)))

    switcher = """
<script>
(function(){
  var host=document.getElementById('pghost'), cur='brand', tpl={};
  [].forEach.call(document.querySelectorAll('script[type="text/template"][data-pg]'),
                  function(s){tpl[s.getAttribute('data-pg')]=s.textContent});
  var md=document.getElementById('dl-md');
  function show(pg){
    if(pg===cur||!tpl[pg])return;
    tpl[cur]=host.innerHTML;                       // 돌아왔을 때 그대로 다시 쓴다
    host.innerHTML=tpl[pg]; cur=pg;
    [].forEach.call(document.querySelectorAll('.tabs a[data-pg]'),function(a){
      a.classList.toggle('on',a.getAttribute('data-pg')===pg)});
    if(md){md.setAttribute('href','md/'+pg+'.md'); md.setAttribute('download',pg+'.md');
           md.querySelector('small').textContent=pg+'.md'}
    window.scrollTo({top:0,behavior:'instant'});
    TLpage();                                      // 갈아끼운 DOM 에 다시 건다
  }
  document.addEventListener('click',function(e){
    var a=e.target.closest && e.target.closest('[data-pg]');
    if(!a||a.tagName!=='A')return;
    e.preventDefault(); show(a.getAttribute('data-pg'));
  });
})();
</script>
"""

    html = head + '<div id="pghost">' + shell0 + "</div>\n" + "\n".join(tpl)

    # zip 은 링크마다 base64 를 박으면 같은 파일이 페이지 수만큼 중복된다(3.3MB 짜리 파일이 됐었다).
    # 페이로드에 한 번만 싣고, 다운로드 핸들러가 파일명으로 찾아 쓴다. 링크는 상대 경로 그대로 둔다.
    # md 링크도 상대 그대로 — 핸들러가 페이지 안의 원본(#mdsrc)에서 저장한다.
    # (절대 URL 로 돌리면 /brand 가 배포돼 있지 않아 오류 페이지가 뜬다)
    zips = {rel: data_uri(rel) for rel in sorted(set(re.findall(r'"([\w.-]+\.zip)"', html)))}
    if zips:
        payload = json.dumps(zips, ensure_ascii=False).replace("</", "<\\/")
        html += '\n<script id="tl-files" type="application/json">%s</script>' % payload

    html = (html + tail).replace("</body>", switcher + "</body>", 1)

    dst = os.path.join(OUT, "index.html")
    open(dst, "w", encoding="utf-8").write(html)
    print("   standalone/index.html  %5d KB  (4개 탭 한 파일)" % (len(html.encode("utf-8")) // 1024))


if __name__ == "__main__":
    if not os.path.isdir(SITE):
        sys.exit("site/ 가 없다 — 먼저 build_book.py 를 실행한다")
    build()
