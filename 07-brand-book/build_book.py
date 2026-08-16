# -*- coding: utf-8 -*-
"""브랜드북 정적 사이트 빌드 — md 단일 소스 → 사이드바 TOC · MD view · 다운로드.

    python 07-brand-book/build_book.py

입력 : 07-brand-book/{brand,bx,signage,product}.md  (+ shell.html · assets/)
출력 : 07-brand-book/site/  →  public/brand 심링크로 서빙

md 안의 ```tl-*``` 펜스가 시각 컴포넌트로 렌더된다(깃허브에서는 코드블록으로 조용히 표시).
블록 문법은 README 대신 아래 RENDERERS 각 함수의 docstring이 정본이다.
"""
import os, re, sys, glob, html, json, shutil, zipfile, io
from datetime import date

STAMP = date.today().strftime("%y%m%d")

import markdown

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOK = os.path.join(ROOT, "07-brand-book")
SITE = os.path.join(BOOK, "site")

PAGES = [
    # slug,      out,             tab label,  kicker,             desc
    ("brand",    "index.html",    "Brand",    "Design System · 01",
     "타입라운지 비주얼 아이덴티티 — 로고 · 색 · 타이포 · 픽토그램 · 이미지 · 모션."),
    ("bx",       "bx.html",       "BX",       "Design System · 02",
     "브랜드 경험·언어 — 퍼소나 · 보이스 · Use/Avoid · 샘플 카피 · 타겟 · 포지셔닝."),
    ("signage",  "signage.html",  "Signage",  "Design System · 03",
     "공간 사이니지 — 설치 확정 5종 · 6원칙 · 세로 A5 안내문 규격 · 재질 위계."),
    ("product",  "product.html",  "Product",  "Design System · 04",
     "컴포넌트 시스템 — Atom 먼저, Molecule/Organism은 조합으로."),
]
FOOT = ('TYPE LOUNGE Brand Book · No More Work Company · 2026-08 · '
        '<a href="https://github.com/nmwc-ai/space-brand-system">GitHub</a>')

# 브랜드북 assets/ 에 없지만 납품 킷에 필요한 파일 (원본 → 사이트 상대경로)
EXTRA_ASSETS = [
    ("03-identity/logo-wordmark-v.svg", "assets/logo/logo-wordmark-v.svg"),
    ("03-identity/logo-wordmark-h.svg", "assets/logo/logo-wordmark-h.svg"),
    # 파비콘은 쓰지 않는다 (2026-08-16 재은) — 사이트에도 킷에도 넣지 않는다
    # 세트 20종 중 조명만 브랜드북 사본에 빠져 있었다 (04-signage 가 정본)
    ("04-signage/picto-light.svg",         "assets/picto/picto-light.svg"),
    ("04-signage/picto-light-white.svg",   "assets/picto/picto-light-white.svg"),
    ("04-signage/picto-light-current.svg", "assets/picto/picto-light-current.svg"),
]

# 수집된 zip 정의: {zip 파일명: [사이트 상대경로, ...]}
ZIPS = {}


# ─────────────────────────────────────────────────────────── 유틸

def esc(s):
    return html.escape(s, quote=True)


def inline(s):
    """블록 안 짧은 텍스트의 인라인 마크다운(**강조** · `코드` · [링크](url))만 해석."""
    s = esc(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`(.+?)`", r"<code>\1</code>", s)
    s = re.sub(r"\[(.+?)\]\((.+?)\)", r'<a href="\2">\1</a>', s)
    return s


def cells(line):
    return [c.strip() for c in line.split("|")]


def parse_args(argstr):
    """'wide zip=picto.zip title=픽토그램' → (flags:set, kv:dict)"""
    flags, kv = set(), {}
    for tok in argstr.split():
        if "=" in tok:
            k, v = tok.split("=", 1)
            kv[k] = v
        else:
            flags.add(tok)
    return flags, kv


def expand(paths):
    """사이트 상대경로 리스트 — 글롭 확장 (site/ 기준)."""
    out = []
    for p in paths:
        if "*" in p:
            hits = sorted(glob.glob(os.path.join(SITE, p).replace("\\", "/")))
            out += [os.path.relpath(h, SITE).replace("\\", "/") for h in hits]
        else:
            out.append(p)
    return out


def group_head(kv, files, flags=()):
    """zip= 이 있으면 그 블록의 파일을 묶는 '전체 받기' 링크 줄을 만든다.

    제목은 마크다운 `###` 헤딩이 담당한다 — 여기서 만들지 않는다.
    """
    if "zip" not in kv:
        return ""
    ZIPS.setdefault(kv["zip"], [])
    ZIPS[kv["zip"]] += files
    if "also" in kv:          # 화면에는 안 띄우고 zip 에만 넣을 파일 (예: currentColor 변형)
        ZIPS[kv["zip"]] += expand(kv["also"].split(","))
    if "quiet" in flags:          # 같은 zip 을 여러 블록이 채울 때 링크는 한 번만 노출
        return ""
    return ('<div class="grouphead"><span></span>'
            '<a href="%s" download>전체 받기 · zip ↓</a></div>' % esc(kv["zip"]))


# ─────────────────────────────────────────────────────────── 블록 렌더러

def r_swatches(lines, flags, kv):
    """이름 | #HEX | 토큰 | 쓰임새"""
    out = []
    for ln in lines:
        c = cells(ln)
        name, hexv = c[0], c[1]
        token = c[2] if len(c) > 2 else ""
        use = c[3] if len(c) > 3 else ""
        ring = ";box-shadow:inset 0 0 0 1px var(--line)" if hexv.lower() in ("#fff", "#ffffff") else ""
        out.append(
            '<div class="sw"><div class="chip" style="background:%s%s"></div><div class="meta">'
            '<div class="nm">%s</div><div class="hex">%s%s</div><div class="use">%s</div>'
            "</div></div>" % (esc(hexv), ring, inline(name), esc(hexv),
                              " · " + esc(token) if token else "", inline(use)))
    return '<div class="swatches">%s</div>' % "".join(out)


def r_logos(lines, flags, kv):
    """경로 | light|dark|orange | 라벨 | (힌트)   — 파일명에 -h- 면 가로 락업"""
    out, files = [], []
    for ln in lines:
        c = cells(ln)
        path, variant, label = c[0], c[1], c[2]
        hint = c[3] if len(c) > 3 else "SVG ↓"
        files.append(path)
        out.append(
            '<a class="lchip %s%s" href="%s" download>'
            '<div class="plabel">%s</div><img src="%s" alt="%s"><div class="dlhint">%s</div></a>'
            % (esc(variant), " h" if "-h-" in path or path.endswith("-h.svg") else "",
               esc(path), inline(label), esc(path), esc(label), esc(hint)))
    return group_head(kv, files, flags) + '<div class="logobox">%s</div>' % "".join(out)


def r_pictos(lines, flags, kv):
    """경로 | 라벨"""
    out, files = [], []
    for ln in lines:
        c = cells(ln)
        path = c[0]
        label = c[1] if len(c) > 1 else os.path.basename(path)
        files.append(path)
        out.append('<a class="picto" href="%s" download><img src="%s" alt="%s">'
                   "<span>%s</span><small>SVG ↓</small></a>"
                   % (esc(path), esc(path), esc(label), inline(label)))
    return group_head(kv, files, flags) + '<div class="pictos">%s</div>' % "".join(out)


def r_modetags(lines, flags, kv):
    """경로 | (alt)"""
    out, files = [], []
    for ln in lines:
        c = cells(ln)
        path = c[0]
        alt = c[1] if len(c) > 1 else os.path.basename(path)
        files.append(path)
        out.append('<a class="mtag" href="%s" download><img src="%s" alt="%s"><small>SVG ↓</small></a>'
                   % (esc(path), esc(path), esc(alt)))
    return group_head(kv, files, flags) + '<div class="modetags">%s</div>' % "".join(out)


def r_dl(lines, flags, kv):
    """라벨 | 텍스트=경로 | 텍스트=경로"""
    out, files = [], []
    for ln in lines:
        c = cells(ln)
        row = ['<span class="dl-label">%s</span>' % inline(c[0])]
        for item in c[1:]:
            if "=" not in item:
                continue
            text, path = item.split("=", 1)
            files.append(path)
            row.append('<a href="%s" download>%s</a>' % (esc(path), inline(text)))
        out.append('<div class="dl">%s</div>' % "".join(row))
    return group_head(kv, files, flags) + "".join(out)


def r_cards(lines, flags, kv):
    """'# 제목 | 부제' 로 카드 시작(제목 앞 ! = 경고색) · '- 불릿' · '✓/✗ 대사'"""
    cards, cur = [], None

    def flush():
        if cur:
            body = ""
            if cur["bullets"]:
                body += "<ul>%s</ul>" % "".join("<li>%s</li>" % inline(b) for b in cur["bullets"])
            body += "".join(cur["says"])
            cards.append('<div class="card"><div class="t%s">%s</div>%s%s</div>'
                         % (" warn" if cur["warn"] else "", inline(cur["title"]),
                            '<div class="anb">%s</div>' % inline(cur["sub"]) if cur["sub"] else "",
                            body))

    for ln in lines:
        if ln.startswith("# "):
            flush()
            c = cells(ln[2:])
            title = c[0]
            warn = title.startswith("!")
            cur = {"title": title.lstrip("!").strip(), "sub": c[1] if len(c) > 1 else "",
                   "warn": warn, "bullets": [], "says": []}
        elif cur is None:
            continue
        elif ln.startswith("- "):
            cur["bullets"].append(ln[2:])
        elif ln[:1] in ("✓", "✗"):
            cur["says"].append('<div class="say%s"><b>%s</b> %s</div>'
                               % ("" if ln[0] == "✓" else " no", ln[0], inline(ln[1:].strip())))
    flush()
    style = ' style="grid-template-columns:1fr 1fr"' if "half" in flags else ""
    return '<div class="cards"%s>%s</div>' % (style, "".join(cards))


def r_shots(lines, flags, kv):
    """경로 | 태그 | 제목 | 설명     (플래그 wide = 큰 그리드)"""
    out = []
    for ln in lines:
        c = cells(ln)
        path, tag, title = c[0], c[1], c[2]
        desc = c[3] if len(c) > 3 else ""
        out.append('<div class="shot"><div class="ph"><img src="%s" alt="%s" loading="lazy"></div>'
                   '<div class="cap"><span class="tag">%s</span><b>%s</b><span>%s</span></div></div>'
                   % (esc(path), esc(title), inline(tag), inline(title), inline(desc)))
    return '<div class="shots%s">%s</div>' % (" wide" if "wide" in flags else "", "".join(out))


def r_sheets(lines, flags, kv):
    """경로 | 라벨      (플래그 land = 가로 판형 그리드)"""
    out, files = [], []
    for ln in lines:
        c = cells(ln)
        path = c[0]
        label = c[1] if len(c) > 1 else os.path.basename(path)
        files.append(path)
        out.append('<a class="sheet" href="%s" download><img src="%s" alt="%s" loading="lazy">'
                   '<div class="cap"><b>%s</b><small>SVG ↓</small></div></a>'
                   % (esc(path), esc(path), esc(label), inline(label)))
    return group_head(kv, files, flags) + ('<div class="sheets%s">%s</div>'
                                    % (" land" if "land" in flags else "", "".join(out)))


def r_spec(lines, flags, kv):
    """샘플 텍스트 | 웨이트 | 크기(px) | 토큰라벨 | (자간em)"""
    out = []
    for ln in lines:
        c = cells(ln)
        text, weight, size, token = c[0], c[1], c[2], c[3]
        ls = c[4] if len(c) > 4 else "0"
        out.append('<div><span class="sv" style="font-weight:%s;font-size:%spx;letter-spacing:%sem;line-height:1.15">%s</span>'
                   '<span class="sm">%s</span></div>'
                   % (esc(weight), esc(size), esc(ls), inline(text), esc(token)))
    return '<div class="spec">%s</div>' % "".join(out)


def r_seq(lines, flags, kv):
    """A > B > C  (한 줄)"""
    parts = [p.strip() for p in " ".join(lines).split(">")]
    return '<div class="seq">%s</div>' % '<span class="ar">→</span>'.join(
        "<b>%s</b>" % inline(p) for p in parts)


def r_pills(lines, flags, kv):
    """WORK | CLASS* | GATHERING     (* = active)"""
    out = []
    for item in cells(" ".join(lines)):
        on = item.endswith("*")
        out.append('<span class="pill%s">%s</span>' % (" on" if on else "", inline(item.rstrip("*").strip())))
    return "<div>%s</div>" % "".join(out)


def r_kit(lines, flags, kv):
    """제목 | 설명 | 버튼텍스트   (zip= 로 대상 지정, 내용은 글롭 허용)"""
    c = cells(lines[0])
    title, desc = c[0], c[1]
    btn = c[2] if len(c) > 2 else "Download all ↓"
    name = kv.get("zip", "type-lounge-brand-kit.zip")
    ZIPS.setdefault(name, [])
    ZIPS[name] += expand(lines[1:])
    return ('<div class="kit"><div><div class="kt">%s</div><div class="ks">%s</div></div>'
            '<a href="%s" download>%s</a></div>'
            % (inline(title), inline(desc), esc(name), inline(btn)))


RENDERERS = {
    "tl-swatches": r_swatches, "tl-logos": r_logos, "tl-pictos": r_pictos,
    "tl-modetags": r_modetags, "tl-dl": r_dl, "tl-cards": r_cards,
    "tl-shots": r_shots, "tl-sheets": r_sheets, "tl-spec": r_spec,
    "tl-seq": r_seq, "tl-pills": r_pills, "tl-kit": r_kit,
}

FENCE = re.compile(r"^```(tl-[a-z]+)([^\n`]*)\n(.*?)\n```$", re.S | re.M)


def extract_blocks(md, store):
    """```tl-*``` 펜스를 HTML 주석 플레이스홀더로 치환하고 렌더 결과를 store에 담는다."""
    def sub(m):
        kind, argstr, body = m.group(1), m.group(2), m.group(3)
        if kind not in RENDERERS:
            sys.exit("[!] 알 수 없는 블록: %s" % kind)
        flags, kv = parse_args(argstr)
        lines = [l.rstrip() for l in body.split("\n") if l.strip()]
        idx = len(store)
        store.append(RENDERERS[kind](lines, flags, kv))
        return "\n<!--TLB:%d-->\n" % idx
    return FENCE.sub(sub, md)


# ─────────────────────────────────────────────────────────── md → 페이지

MD = markdown.Markdown(extensions=["tables", "attr_list", "fenced_code", "sane_lists", "md_in_html"])


def render(md_text, store):
    MD.reset()
    out = MD.convert(extract_blocks(md_text, store))
    for i, blockhtml in enumerate(store):
        out = out.replace("<!--TLB:%d-->" % i, blockhtml)
    # 넓은 표는 가로 스크롤 컨테이너에 담는다
    out = out.replace("<table>", '<div class="tablewrap"><table>').replace("</table>", "</table></div>")
    return out


def slugify(title):
    s = title.lower().strip()
    s = re.sub(r"[^\w\s가-힣-]", "", s)
    return re.sub(r"[\s_]+", "-", s).strip("-") or "section"


def split_sections(md_text):
    """(intro_md, [(번호, 제목, 본문_md), ...]) — '## 01. Logo' 기준."""
    parts = re.split(r"^## +", md_text, flags=re.M)
    intro = parts[0]
    secs = []
    for chunk in parts[1:]:
        head, _, body = chunk.partition("\n")
        m = re.match(r"(\d+)\.\s*(.+)", head.strip())
        num, title = (m.group(1), m.group(2)) if m else ("", head.strip())
        # 섹션 사이 구분선은 <section> 경계가 대신한다
        body = re.sub(r"\n-{3,}\s*$", "\n", body.rstrip()) + "\n"
        secs.append((num, title.strip(), body))
    return intro, secs


def build_page(slug, outname, kicker, desc, shell, tabs_html, others_html, kit_size):
    src = os.path.join(BOOK, slug + ".md")
    md_text = open(src, encoding="utf-8").read()

    intro, secs = split_sections(md_text)

    # hero: '# 제목' + 이어지는 인용 블록. '**목차**:' 줄과 구분선은 TOC가 대체한다.
    h1 = re.search(r"^#\s+(.+)$", intro, re.M)
    h1 = h1.group(1).strip() if h1 else slug
    lede_md = re.sub(r"^#\s+.+$", "", intro, count=1, flags=re.M)
    lede_md = re.sub(r"^\*\*목차\*\*.*$", "", lede_md, flags=re.M)
    lede_md = lede_md.replace("---", "").strip()
    lede_md = re.sub(r"^>\s?", "", lede_md, flags=re.M)  # 히어로에서는 note 박스가 아니라 리드문
    MD.reset()
    lede = MD.convert(lede_md)

    store = []
    body_parts, toc_parts = [], []
    for num, title, body in secs:
        sid = slugify(title)
        toc_parts.append('<li><a href="#%s"><span class="n">%s</span><span>%s</span></a></li>'
                         % (sid, esc(num or "·"), esc(title)))
        body_parts.append(
            '    <section id="%s">\n      <div class="snum">%s — %s</div>\n      <h2>%s</h2>\n%s\n    </section>\n'
            % (sid, esc(num or "·"), esc(title.upper()), esc(title), render(body, store)))

    page = shell
    for k, v in {
        "{{TITLE}}": "TYPE LOUNGE — %s" % h1.split("—")[-1].strip(),
        "{{DESC}}": desc,
        "{{TABS}}": tabs_html,
        "{{OTHER}}": others_html,
        "{{SLUG}}": slug,
        # 단일 파일은 네 탭을 한 문서에 담은 한 개다 — 오프라인에서도 SVG·MD 가 전부 저장된다
        "{{STANDALONE}}": "standalone/index.html",
        "{{KITSIZE}}": kit_size,
        # 받아둔 파일이 언제 것인지 파일명에서 바로 보이게 한다
        "{{HTMLNAME}}": "%s typelounge_brandbook_index.html" % STAMP,

        "{{KICKER}}": kicker,
        "{{H1}}": esc(h1.split("—")[-1].strip()),
        "{{LEDE}}": lede,
        "{{TOC}}": "".join(toc_parts),
        "{{SECTIONS}}": "".join(body_parts),
        "{{MDSRC}}": esc(md_text),
        "{{FOOT}}": FOOT,
    }.items():
        page = page.replace(k, v)

    # 파일명을 링크에 박아둔다 — 단일 파일에서는 href 가 data URI 라 경로에서 이름을 못 얻는다
    page = re.sub(r'(<a[^>]+href="([^"]+\.(?:svg|png|jpe?g|zip|md))"[^>]*?)\bdownload(?!=)',
                  lambda m: '%sdownload="%s"' % (m.group(1), os.path.basename(m.group(2))), page)

    page = page.replace("{{FILES}}", inline_files(page))

    open(os.path.join(SITE, outname), "w", encoding="utf-8").write(page)
    return len(secs)


def inline_files(page):
    """이 페이지가 다운로드로 거는 SVG 를 본문에 실어둔다.

    file:// 로 열면 브라우저가 download 속성을 무시하고(불투명 origin) fetch 도 막는다 —
    zip·png 은 렌더러가 없어 저절로 저장되지만 SVG·MD 는 새 탭에 그려질 뿐이다.
    md 는 이미 MD view 용 원본이 페이지에 있으므로 여기서는 SVG 만 싣는다.
    """
    rels = dict.fromkeys(re.findall(r'<a[^>]+href="(assets/[^"]+\.svg)"[^>]*\bdownload\b', page))
    data = {}
    for rel in rels:
        fp = os.path.join(SITE, rel)
        if os.path.exists(fp):
            data[rel] = open(fp, encoding="utf-8").read()
    if not data:
        return ""
    # </script> 로 스크립트가 조기 종료되지 않게 막는다
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    return '<script id="tl-files" type="application/json">%s</script>' % payload


# ─────────────────────────────────────────────────────────── 실행

def main():
    if os.path.isdir(SITE):
        shutil.rmtree(SITE)
    os.makedirs(SITE)

    # mockup/ 은 폐기된 목업 단계 PNG(8.5MB)라 사이트가 쓰지 않는다 — 커밋에 싣지 않는다
    shutil.copytree(os.path.join(BOOK, "assets"), os.path.join(SITE, "assets"),
                    ignore=shutil.ignore_patterns("mockup"))
    for src, dst in EXTRA_ASSETS:
        s = os.path.join(ROOT, src)
        if os.path.exists(s):
            os.makedirs(os.path.dirname(os.path.join(SITE, dst)), exist_ok=True)
            shutil.copy2(s, os.path.join(SITE, dst))
        else:
            print("   ! 없음(건너뜀):", src)

    os.makedirs(os.path.join(SITE, "md"))
    for slug, *_ in PAGES:
        shutil.copy2(os.path.join(BOOK, slug + ".md"), os.path.join(SITE, "md", slug + ".md"))

    shell = open(os.path.join(BOOK, "shell.html"), encoding="utf-8").read()

    for slug, outname, label, kicker, desc in PAGES:
        tabs_html = "".join('<a href="%s"%s>%s</a>' % (o, ' class="on"' if s == slug else "", l)
                            for s, o, l, _, _ in PAGES)
        others_html = "".join('<a href="%s"%s>%s</a>' % (o, ' class="on"' if s == slug else "", l)
                              for s, o, l, _, _ in PAGES)
        n = build_page(slug, outname, kicker, desc, shell, tabs_html, others_html, "ZIPSIZE")
        print("   %-12s → site/%-14s %d개 섹션" % (slug + ".md", outname, n))

    # ---- zip 생성 ----
    for name, files in ZIPS.items():
        seen, path = [], os.path.join(SITE, name)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for rel in dict.fromkeys(files):
                fp = os.path.join(SITE, rel)
                if not os.path.exists(fp):
                    print("   ! zip 대상 없음:", rel)
                    continue
                z.write(fp, os.path.basename(rel))
                seen.append(rel)
        print("   zip %-28s %2d개  %d KB" % (name, len(seen), os.path.getsize(path) // 1024))

    # 킷 크기를 HTML에 반영
    kit = os.path.join(SITE, "type-lounge-brand-kit.zip")
    size = "%.1f MB" % (os.path.getsize(kit) / 1048576) if os.path.exists(kit) else "zip"
    for _, outname, *_ in PAGES:
        p = os.path.join(SITE, outname)
        t = open(p, encoding="utf-8").read().replace("ZIPSIZE", size)
        open(p, "w", encoding="utf-8").write(t)

    # ---- 단일 파일(Download → HTML page) ----
    try:
        import standalone
        standalone.build()
    except ImportError as e:
        print("   ! standalone 생략 (%s) — pip install fonttools pillow" % e)

    # ---- 검증: 참조된 로컬 파일이 전부 존재하는가 ----
    missing = set()
    for _, outname, *_ in PAGES:
        t = open(os.path.join(SITE, outname), encoding="utf-8").read()
        for ref in re.findall(r'(?:src|href)="(?!https?:|#|mailto:)([^"]+)"', t):
            if not os.path.exists(os.path.join(SITE, ref.split("?")[0])):
                missing.add(ref)
    print("\n[OK] %s" % SITE)
    print("   깨진 로컬 참조:", ", ".join(sorted(missing)) if missing else "없음")
    if missing:
        sys.exit(1)


if __name__ == "__main__":
    main()
