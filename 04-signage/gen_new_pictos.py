# -*- coding: utf-8 -*-
"""신규 픽토그램 stroke → 채운 아웃라인(면) SVG 변환.
outline_picto.py와 동일한 사양(stroke-width 3, cap=square, join=miter, viewBox 100)이되
M/L/H/V/Q/C/A/Z(절대·상대) 전 커맨드와 rect를 지원한다."""
import os, re, math
from shapely.geometry import LineString, Polygon, Point
from shapely.ops import unary_union

OUT = os.path.dirname(os.path.abspath(__file__))
INK = "#16130F"           # 기본 fill(리터럴) — -white/-current 변형을 함께 출력
W = 2.7; R = W / 2.0      # 기존 3.0 → 2.7 (살짝 얇게)

# ---------- flatten helpers ----------
QN = 18; CN = 24          # 곡선 flatten 세그먼트 수 (픽토별 조절 — 낮추면 각짐)
ADAPT = False             # 적응형: 짧은 곡선(코너)=각지게, 긴 곡선(샤프트)=부드럽게
def _adapt_n(p0, p3):
    ch = math.hypot(p3[0]-p0[0], p3[1]-p0[1])
    return 1 if ch < 12 else 3       # 짧은 코너=직선(r 제거) · 그 외=coarse3 수준

def flatten_q(p0, p1, p2, n=None):
    n = _adapt_n(p0, p2) if ADAPT else (n or QN)
    return [((1-t)**2*p0[0]+2*(1-t)*t*p1[0]+t*t*p2[0],
             (1-t)**2*p0[1]+2*(1-t)*t*p1[1]+t*t*p2[1])
            for t in [i/n for i in range(1, n+1)]]

def flatten_c(p0, p1, p2, p3, n=None):
    n = _adapt_n(p0, p3) if ADAPT else (n or CN)
    out = []
    for i in range(1, n+1):
        t = i/n; u = 1-t
        x = u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0]
        y = u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1]
        out.append((x, y))
    return out

def flatten_a(p0, rx, ry, phi, large, sweep, p1, n=48):
    # endpoint -> center parameterization (SVG spec)
    x1, y1 = p0; x2, y2 = p1
    phi = math.radians(phi)
    cs, sn = math.cos(phi), math.sin(phi)
    dx, dy = (x1-x2)/2, (y1-y2)/2
    x1p =  cs*dx + sn*dy
    y1p = -sn*dx + cs*dy
    rx, ry = abs(rx), abs(ry)
    lam = x1p**2/rx**2 + y1p**2/ry**2
    if lam > 1:
        s = math.sqrt(lam); rx *= s; ry *= s
    num = rx**2*ry**2 - rx**2*y1p**2 - ry**2*x1p**2
    den = rx**2*y1p**2 + ry**2*x1p**2
    co = math.sqrt(max(0, num/den)) if den else 0
    if large == sweep: co = -co
    cxp = co * rx*y1p/ry
    cyp = co * (-ry*x1p/rx)
    cx = cs*cxp - sn*cyp + (x1+x2)/2
    cy = sn*cxp + cs*cyp + (y1+y2)/2
    def ang(ux, uy, vx, vy):
        d = (ux*vx+uy*vy)/(math.hypot(ux,uy)*math.hypot(vx,vy))
        d = max(-1, min(1, d))
        a = math.acos(d)
        return -a if (ux*vy-uy*vx) < 0 else a
    th1 = ang(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry)
    dth = ang((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry)
    if not sweep and dth > 0: dth -= 2*math.pi
    if sweep and dth < 0: dth += 2*math.pi
    out = []
    for i in range(1, n+1):
        th = th1 + dth*i/n
        x = cs*rx*math.cos(th) - sn*ry*math.sin(th) + cx
        y = sn*rx*math.cos(th) + cs*ry*math.sin(th) + cy
        out.append((x, y))
    return out

# ---------- path d parser (absolute + relative, all cmds) ----------
def parse_d(d):
    toks = re.findall(r"[MmLlHhVvQqCcAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?", d)
    subs = []; pts = []; closed = False
    cur = (0.0, 0.0); start = (0.0, 0.0); i = 0; cmd = None
    def num(k): return float(toks[k])
    def flush():
        if len(pts) >= 2: subs.append((list(pts), closed))
    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t; i += 1
        rel = cmd.islower(); C = cmd.upper()
        if C == 'M':
            flush(); pts = []; closed = False
            x, y = num(i), num(i+1); i += 2
            cur = (cur[0]+x, cur[1]+y) if rel else (x, y)
            start = cur; pts.append(cur)
            cmd = 'l' if rel else 'L'
        elif C == 'L':
            x, y = num(i), num(i+1); i += 2
            cur = (cur[0]+x, cur[1]+y) if rel else (x, y)
            pts.append(cur)
        elif C == 'H':
            x = num(i); i += 1
            cur = (cur[0]+x, cur[1]) if rel else (x, cur[1]); pts.append(cur)
        elif C == 'V':
            y = num(i); i += 1
            cur = (cur[0], cur[1]+y) if rel else (cur[0], y); pts.append(cur)
        elif C == 'Q':
            x1, y1, x2, y2 = num(i), num(i+1), num(i+2), num(i+3); i += 4
            p1 = (cur[0]+x1, cur[1]+y1) if rel else (x1, y1)
            p2 = (cur[0]+x2, cur[1]+y2) if rel else (x2, y2)
            pts.extend(flatten_q(cur, p1, p2)); cur = p2
        elif C == 'C':
            v = [num(i+k) for k in range(6)]; i += 6
            if rel:
                p1 = (cur[0]+v[0], cur[1]+v[1]); p2 = (cur[0]+v[2], cur[1]+v[3]); p3 = (cur[0]+v[4], cur[1]+v[5])
            else:
                p1 = (v[0], v[1]); p2 = (v[2], v[3]); p3 = (v[4], v[5])
            pts.extend(flatten_c(cur, p1, p2, p3)); cur = p3
        elif C == 'A':
            rx, ry, phi, la, sw = num(i), num(i+1), num(i+2), int(float(toks[i+3])), int(float(toks[i+4]))
            x, y = num(i+5), num(i+6); i += 7
            p1 = (cur[0]+x, cur[1]+y) if rel else (x, y)
            pts.extend(flatten_a(cur, rx, ry, phi, la, sw, p1)); cur = p1
        elif C == 'Z':
            closed = True
            if pts and pts[-1] != start: pts.append(start)
            cur = start
    flush()
    return subs

def rect_ring(x, y, w, h):
    return [(x, y), (x+w, y), (x+w, y+h), (x, y+h), (x, y)]

# ---------- buffer + emit ----------
def buf(pts, closed):
    return LineString(pts).buffer(R, cap_style="square", join_style="mitre", mitre_limit=6)

def ring_d(coords):
    return " ".join(("M" if j == 0 else "L") + f"{x:.2f} {y:.2f}"
                     for j, (x, y) in enumerate(coords)) + " Z"

def geom_to_path(g):
    polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    parts = []
    for poly in polys:
        parts.append(ring_d(list(poly.exterior.coords)))
        for ring in poly.interiors:
            parts.append(ring_d(list(ring.coords)))
    return " ".join(parts)

# ---------- picto definitions (stroke sources) ----------
PICTOS = {
 "bluetooth": {"label": "블루투스 BLUETOOTH", "els": [
    ("path", "M40,36 L60,64 L50,78 L50,22 L60,36 L40,64")]},
 "tv": {"label": "TV SCREEN", "els": [
    ("rect", 22, 26, 56, 40),
    ("path", "M43,66 L40,76 L60,76 L57,66"),
    ("path", "M32,76 L68,76")]},
 "notouch": {"label": "손대지 마세요 DO NOT TOUCH", "els": [
    ("path", "M33,64 L33,49 Q33,46 36,46 Q39,46 39,49 L39,54 L40,54 L40,33 "
             "Q40,30 43,30 Q46,30 46,33 L46,50 L47,50 L47,30 Q47,27 50,27 "
             "Q53,27 53,30 L53,50 L54,50 L54,32 Q54,29 57,29 Q60,29 60,32 "
             "L60,50 L61,50 L61,37 Q61,34 64,34 Q67,34 67,37 L67,64 "
             "Q67,80 50,80 Q33,80 33,64 Z"),
    ("path", "M22,84 L82,26")]},
 "shoe": {"label": "신발장 SHOE RACK", "els": [
    ("path", "M22,62 L22,58 Q22,55 26,55 L40,55 L49,49 Q59,44 71,50 "
             "Q79,54 79,60 Q79,62 77,62 Z"),
    ("path", "M40,55 Q44,58 50,56"),
    ("path", "M18,68 L82,68")]},
 "phone": {"label": "전화기 TELEPHONE", "adapt": True, "squash": 0.9, "els": [
    # 샤프트=coarse3 수준(부드럽게), 코너=직선(r 제거), 컵은 수직 0.9로 압축(작게)
    ("path", "M39.79 23.79c-0.87 -2.11 -3.17 -3.23 -5.37 -2.63l-9.97 2.72"
             "C22.48 24.42 21.11 26.21 21.11 28.25C21.11 56.28 43.84 79.00 71.86 79.00"
             "c2.04 0.00 3.83 -1.37 4.37 -3.34l2.72 -9.97c0.60 -2.20 -0.52 -4.50 -2.63 -5.37"
             "l-10.88 -4.53c-1.85 -0.77 -3.99 -0.24 -5.24 1.31L55.63 62.69"
             "C47.66 58.92 41.20 52.46 37.43 44.48L43.01 39.92"
             "c1.55 -1.26 2.08 -3.40 1.31 -5.24l-4.53 -10.88Z")]},
 "speaker": {"label": "스피커 SPEAKER", "els": [
    ("rect", 35, 20, 30, 60),           # 스피커 박스
    ("ring", 50, 57, 11),               # 우퍼 외곽
    ("dot", 50, 57, 3.4),               # 우퍼 중심
    ("dot", 50, 33, 3.0)]},             # 트위터
 "trash": {"label": "쓰레기통 TRASH", "els": [
    ("path", "M30,33 L70,33"),
    ("path", "M44,33 L44,28 L56,28 L56,33"),
    ("path", "M34,33 L37,76 Q37,79 40,79 L60,79 Q63,79 63,76 L66,33"),
    ("path", "M44,41 L44,71"),
    ("path", "M50,41 L50,71"),
    ("path", "M56,41 L56,71")]},
 "power": {"label": "전원 POWER", "els": [
    ("path", "M61,34 A24,24 0 1 1 39,34"),
    ("path", "M50,30 L50,52")]},
 "bbq": {"label": "바베큐 BARBECUE", "els": [
    ("path", "M38,36 Q34,30 38,24 Q42,18 38,12"),   # 연기 3줄 (aircon 물결과 동일 어법)
    ("path", "M50,36 Q46,30 50,24 Q54,18 50,12"),
    ("path", "M62,36 Q58,30 62,24 Q66,18 62,12"),
    ("path", "M20,46 L80,46"),                       # 그릴 석쇠(상판)
    ("path", "M27,46 L36,66 L64,66 L73,46"),         # 화로(사다리꼴, 상단은 석쇠선과 공유)
    ("dot", 42, 57, 2.4), ("dot", 50, 57, 2.4),      # 숯 3점 — 없으면 '탁자'로 읽힘
    ("dot", 58, 57, 2.4),
    ("path", "M36,66 L31,80"),                       # 다리
    ("path", "M64,66 L69,80")]},
 "aircon": {"label": "냉난방 AIR CONDITIONER", "els": [
    ("rect", 22, 30, 56, 22),
    ("path", "M27,45 L73,45"),
    ("path", "M36,57 Q32,63 36,69 Q40,75 36,80"),
    ("path", "M50,57 Q46,63 50,69 Q54,75 50,80"),
    ("path", "M64,57 Q60,63 64,69 Q68,75 64,80")]},
}

for name, spec in PICTOS.items():
    c = spec.get('coarse')                      # 저해상도 flatten(각짐) 옵션
    globals()['QN'] = c if c else 18
    globals()['CN'] = c if c else 24
    globals()['ADAPT'] = bool(spec.get('adapt'))  # 적응형(코너만 각짐)
    sq = spec.get('squash')                        # 대각선 수직 압축(컵 축소)
    def _sq(pts):
        if not sq: return pts
        cx, cy, ux, uy = 50, 50, 0.7071, 0.7071
        out = []
        for x, y in pts:
            dx, dy = x-cx, y-cy; du = dx*ux+dy*uy
            vx, vy = dx-du*ux, dy-du*uy
            out.append((cx+du*ux+sq*vx, cy+du*uy+sq*vy))
        return out
    geoms = []
    for el in spec["els"]:
        if el[0] == "path":
            for pts, closed in parse_d(el[1]):
                geoms.append(buf(_sq(pts), closed))
        elif el[0] == "rect":
            geoms.append(buf(rect_ring(*el[1:]), True))
        elif el[0] == "ring":                       # 원 외곽선(스트로크)
            cx, cy, r = el[1:]
            ring = [(cx+r*math.cos(2*math.pi*k/96), cy+r*math.sin(2*math.pi*k/96))
                    for k in range(96)]; ring.append(ring[0])
            geoms.append(buf(ring, True))
        elif el[0] == "dot":                         # 채운 점
            cx, cy, r = el[1:]
            geoms.append(Point(cx, cy).buffer(r))
    merged = unary_union(geoms)
    d = geom_to_path(merged)
    # 색상 3종 — 기본은 리터럴 잉크(디자인 툴이 currentColor를 검정으로 떨구는 문제 회피).
    for suffix, fill in (("", INK), ("-white", "#ffffff"), ("-current", "currentColor")):
        out = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
               f'width="100" height="100" role="img" aria-label="{spec["label"]}">\n'
               f'  <path fill="{fill}" fill-rule="evenodd" d="{d}"/>\n</svg>\n')
        with open(os.path.join(OUT, f"picto-{name}{suffix}.svg"), "w", encoding="utf-8") as f:
            f.write(out)
    print(f"outlined picto-{name}.svg (+white/current)  ({len(d)} chars)")
