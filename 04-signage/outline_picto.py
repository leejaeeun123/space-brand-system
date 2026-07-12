# -*- coding: utf-8 -*-
"""픽토그램 SVG의 stroke를 채운 아웃라인(패스)으로 변환.
원본 사양 재현: stroke-width 3 (중앙정렬 → 버퍼 1.5), cap=square, join=miter."""
import os, re, math, xml.etree.ElementTree as ET
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

SRC = "C:/Users/jaeeu/space-brand-system/04-signage"
NS = "{http://www.w3.org/2000/svg}"
FILES = ["coffee", "extinguisher", "no", "nosmoke", "room", "stairs",
         "toilet", "umbrella", "wifi"]

# ---------- affine ----------
def ident(): return (1, 0, 0, 1, 0, 0)  # a b c d e f  (x'=a x+c y+e, y'=b x+d y+f)
def mul(m, n):
    a, b, c, d, e, f = m; A, B, C, D, E, F = n
    return (a*A+c*B, b*A+d*B, a*C+c*D, b*C+d*D, a*E+c*F+e, b*E+d*F+f)
def apply(m, p):
    a, b, c, d, e, f = m; x, y = p
    return (a*x+c*y+e, b*x+d*y+f)
def parse_transform(s):
    m = ident()
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", s or ""):
        v = [float(t) for t in re.split(r"[,\s]+", args.strip()) if t]
        if name == "translate":
            tx = v[0]; ty = v[1] if len(v) > 1 else 0
            m = mul(m, (1, 0, 0, 1, tx, ty))
        elif name == "scale":
            sx = v[0]; sy = v[1] if len(v) > 1 else v[0]
            m = mul(m, (sx, 0, 0, sy, 0, 0))
        elif name == "rotate":
            a = math.radians(v[0]); ca, sa = math.cos(a), math.sin(a)
            r = (ca, sa, -sa, ca, 0, 0)
            if len(v) == 3:
                cx, cy = v[1], v[2]
                r = mul((1, 0, 0, 1, cx, cy), mul(r, (1, 0, 0, 1, -cx, -cy)))
            m = mul(m, r)
        elif name == "matrix":
            m = mul(m, tuple(v))
    return m

# ---------- path d parser (M/L/Q/Z absolute) ----------
def flatten_q(p0, p1, p2, n=18):
    return [((1-t)**2*p0[0]+2*(1-t)*t*p1[0]+t*t*p2[0],
             (1-t)**2*p0[1]+2*(1-t)*t*p1[1]+t*t*p2[1])
            for t in [i/n for i in range(1, n+1)]]

def parse_d(d):
    toks = re.findall(r"[MLQZ]|-?\d*\.?\d+", d)
    subs = []; pts = []; closed = False; i = 0; cur = None; start = None
    def flush():
        nonlocal pts, closed
        if len(pts) >= 2: subs.append((pts, closed))
    while i < len(toks):
        t = toks[i]
        if t == "M":
            flush(); pts = []; closed = False
            cur = (float(toks[i+1]), float(toks[i+2])); start = cur
            pts.append(cur); i += 3
        elif t == "L":
            cur = (float(toks[i+1]), float(toks[i+2])); pts.append(cur); i += 3
        elif t == "Q":
            p1 = (float(toks[i+1]), float(toks[i+2]))
            p2 = (float(toks[i+3]), float(toks[i+4]))
            pts.extend(flatten_q(cur, p1, p2)); cur = p2; i += 5
        elif t == "Z":
            closed = True
            if start and pts[-1] != start: pts.append(start)
            i += 1
        else:
            i += 1
    flush()
    return subs

# ---------- element -> shapely ----------
W = 3.0; R = W/2.0  # stroke-width 3, 중앙정렬 버퍼 반경
def buf_line(pts, closed):
    ls = LineString(pts)
    if closed:
        return ls.buffer(R, cap_style="square", join_style="mitre", mitre_limit=6)
    return ls.buffer(R, cap_style="square", join_style="mitre", mitre_limit=6)

def collect(el, ctm, geoms):
    tag = el.tag.replace(NS, "")
    m = mul(ctm, parse_transform(el.get("transform")))
    if tag == "g":
        for ch in el:
            collect(ch, m, geoms)
        return
    if tag == "path":
        for pts, closed in parse_d(el.get("d")):
            tp = [apply(m, p) for p in pts]
            geoms.append(buf_line(tp, closed))
    elif tag == "rect":
        x, y = float(el.get("x")), float(el.get("y"))
        w, h = float(el.get("width")), float(el.get("height"))
        ring = [(x, y), (x+w, y), (x+w, y+h), (x, y+h), (x, y)]
        tp = [apply(m, p) for p in ring]
        geoms.append(buf_line(tp, True))
    elif tag == "circle":
        cx, cy, r = float(el.get("cx")), float(el.get("cy")), float(el.get("r"))
        filled = el.get("fill") not in (None, "none") and el.get("stroke") == "none"
        ring = [apply(m, (cx+r*math.cos(2*math.pi*k/96), cy+r*math.sin(2*math.pi*k/96)))
                for k in range(96)]
        ring.append(ring[0])
        if filled:
            geoms.append(Polygon(ring))          # 면(점)
        else:
            geoms.append(buf_line(ring, True))    # 링 stroke
    elif tag == "line":
        p = [(float(el.get("x1")), float(el.get("y1"))),
             (float(el.get("x2")), float(el.get("y2")))]
        geoms.append(buf_line([apply(m, q) for q in p], False))

# ---------- geometry -> svg path ----------
def ring_d(coords):
    out = []
    for j, (x, y) in enumerate(coords):
        out.append(("M" if j == 0 else "L") + f"{x:.2f} {y:.2f}")
    return " ".join(out) + " Z"

def geom_to_path(g):
    polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    parts = []
    for poly in polys:
        parts.append(ring_d(list(poly.exterior.coords)))
        for int in poly.interiors:
            parts.append(ring_d(list(int.coords)))
    return " ".join(parts)

for name in FILES:
    src = os.path.join(SRC, f"picto-{name}.svg")
    tree = ET.parse(src); root = tree.getroot()
    label = root.get("aria-label", name)
    geoms = []
    for ch in root:
        collect(ch, ident(), geoms)
    merged = unary_union(geoms)
    d = geom_to_path(merged)
    out = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
           f'width="100" height="100" role="img" aria-label="{label}">\n'
           f'  <path fill="currentColor" fill-rule="evenodd" d="{d}"/>\n</svg>\n')
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           f"picto-{name}.svg"), "w", encoding="utf-8") as f:
        f.write(out)
    print(f"outlined picto-{name}.svg  ({len(d)} chars)")
