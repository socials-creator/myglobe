#!/usr/bin/env python3
"""
Converts tools/world.geojson into two compact files the app loads at startup:

  data/world.bin       Int16 lng/lat pairs (x100 = 0.01 deg precision) + 1 byte "level" per vertex
  data/countries.json  names, neighbours, label anchor, area, bbox and ring offsets

The per-vertex level comes from Douglas-Peucker importance, so the app can draw
a coarse, medium or full-detail outline from the SAME data depending on zoom:
  level 0  -> kept in every LOD (coarse, used when fully zoomed out)
  level 1  -> kept in medium + fine
  level 2  -> fine only

Run:  python3 tools/build-data.py
"""
import json, math, struct, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'world.geojson')
OUT = os.path.join(HERE, '..', 'data')
TOL0, TOL1 = 0.20, 0.035      # degrees. level0 >= TOL0, level1 >= TOL1, else level2
PREC = 100                    # 0.01 deg

def dist_pt_seg(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def dp_importance(pts):
    n = len(pts)
    imp = [0.0] * n
    imp[0] = imp[-1] = float('inf')
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        best, bi = -1, -1
        a, b = pts[i], pts[j]
        for k in range(i + 1, j):
            d = dist_pt_seg(pts[k], a, b)
            if d > best:
                best, bi = d, k
        imp[bi] = best
        stack.append((i, bi)); stack.append((bi, j))
    return imp

def ring_area_km2(ring):
    # spherical polygon area (Chamberlain & Duquette), signed
    R = 6371.0088
    s = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        s += math.radians(x2 - x1) * (2 + math.sin(math.radians(y1)) + math.sin(math.radians(y2)))
    return s * R * R / 2

def planar_centroid(ring):
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        c = x1 * y2 - x2 * y1
        a += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c
    if abs(a) < 1e-12:
        return ring[0]
    return (cx / (3 * a), cy / (3 * a))

# Manual corrections applied after reading the GeoJSON neighbour lists.
BORDER_ADD = [('India', 'Afghanistan'), ('Afghanistan', 'China')]
BORDER_REMOVE = [('India', 'Tajikistan'), ('Pakistan', 'Tajikistan')]

def apply_border_fixes(countries):
    by = {c['n']: c for c in countries}
    for a, b in BORDER_ADD:
        for x, y in ((a, b), (b, a)):
            if y not in by[x]['nb']:
                by[x]['nb'].append(y)
    for a, b in BORDER_REMOVE:
        for x, y in ((a, b), (b, a)):
            if y in by[x]['nb']:
                by[x]['nb'].remove(y)
    for c in countries:
        c['nb'].sort()

def main():
    gj = json.load(open(SRC, encoding='utf-8'))
    xy = []        # int16 pairs
    lv = bytearray()
    countries = []
    max_jump = 0
    for f in gj['features']:
        g = f['geometry']
        polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        rings, ring_meta = [], []
        total_area = 0.0
        for poly in polys:
            for ri, ring in enumerate(poly):
                pts = [(round(p[0], 2), round(p[1], 2)) for p in ring]
                if pts[0] != pts[-1]:
                    pts.append(pts[0])
                for a, b in zip(pts, pts[1:]):
                    max_jump = max(max_jump, abs(a[0] - b[0]))
                rings.append((pts, ri == 0))
        # largest outer ring -> label anchor + framing
        outers = [(abs(ring_area_km2(p)), p) for p, outer in rings if outer]
        outers.sort(key=lambda t: -t[0])
        area = sum(ring_area_km2(p) if outer else -ring_area_km2(p) for p, outer in rings)
        # Chamberlain-Duquette sign depends on winding; use absolute of outer minus holes
        outer_sum = sum(abs(ring_area_km2(p)) for p, outer in rings if outer)
        hole_sum = sum(abs(ring_area_km2(p)) for p, outer in rings if not outer)
        area = max(outer_sum - hole_sum, 1.0)
        main = outers[0][1]
        lng, lat = planar_centroid(main)
        # bbox of "main land": outer rings >= 20% of the biggest
        keep = [p for a, p in outers if a >= outers[0][0] * 0.2]
        xs = [q[0] for p in keep for q in p]; ys = [q[1] for p in keep for q in p]
        bbox = [min(xs), min(ys), max(xs), max(ys)]
        entry = {'n': f['properties']['name'], 'nb': f['properties'].get('neighbors') or [],
                 'lat': round(lat, 2), 'lng': round(lng, 2), 'a': round(area),
                 'bb': bbox, 'r': []}
        for pts, outer in rings:
            imp = dp_importance(pts)
            start = len(lv)
            for (x, y), im in zip(pts, imp):
                xy.append(int(round(x * PREC))); xy.append(int(round(y * PREC)))
                lv.append(0 if im >= TOL0 else 1 if im >= TOL1 else 2)
            entry['r'].append([start, len(pts)])
        countries.append(entry)

    apply_border_fixes(countries)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'world.bin'), 'wb') as fh:
        n = len(lv)
        fh.write(struct.pack('<I', n))
        fh.write(struct.pack('<%dh' % (2 * n), *xy))
        fh.write(bytes(lv))
    with open(os.path.join(OUT, 'countries.json'), 'w', encoding='utf-8') as fh:
        json.dump(countries, fh, ensure_ascii=False, separators=(',', ':'))
    c = [lv.count(i) for i in range(3)]
    print('vertices', len(lv), 'by level', c, '-> LOD0', c[0], 'LOD1', c[0] + c[1], 'LOD2', sum(c))
    print('largest lng jump between consecutive vertices:', max_jump)
    print('countries', len(countries))

main()
