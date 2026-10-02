// Minimal DXF reader for copper-layer outline plots (e.g. KiCad "Plot > DXF").
// Supports LINE, ARC, CIRCLE, LWPOLYLINE and POLYLINE/VERTEX entities.

const ARC_TOLERANCE = 0.01; // mm, max chord deviation when flattening arcs

/** Split DXF text into [code, value] pairs. */
function readPairs(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  }
  return pairs;
}

/** Group the ENTITIES section into {type, codes: [[code, value], ...]}. */
function readEntities(pairs) {
  const entities = [];
  let inEntities = false;
  let current = null;
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0 && value === "SECTION" && pairs[i + 1]?.[1] === "ENTITIES") {
      inEntities = true;
      i++;
      continue;
    }
    if (!inEntities) continue;
    if (code === 0) {
      if (current) entities.push(current);
      if (value === "ENDSEC") break;
      current = { type: value, codes: [] };
    } else if (current) {
      current.codes.push([code, value]);
    }
  }
  return entities;
}

const num = (codes, code, fallback = 0) => {
  const hit = codes.find(([c]) => c === code);
  return hit ? parseFloat(hit[1]) : fallback;
};

function arcSegments(radius, sweepRad) {
  const step = 2 * Math.acos(Math.max(-1, 1 - ARC_TOLERANCE / Math.max(radius, 1e-9)));
  return Math.max(4, Math.ceil(Math.abs(sweepRad) / step));
}

function arcPoints(cx, cy, r, startDeg, endDeg) {
  let a0 = (startDeg * Math.PI) / 180;
  let a1 = (endDeg * Math.PI) / 180;
  while (a1 <= a0) a1 += 2 * Math.PI; // DXF arcs run counter-clockwise
  const n = arcSegments(r, a1 - a0);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

export function circlePoints(cx, cy, r, n = 48) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Expand polyline vertices with bulges into a point list. */
function bulgePolyline(verts, closed) {
  const pts = [];
  const count = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < count; i++) {
    const [x0, y0, bulge] = verts[i];
    const [x1, y1] = verts[(i + 1) % verts.length];
    pts.push([x0, y0]);
    if (Math.abs(bulge) > 1e-9) {
      // bulge = tan(sweep / 4); positive bulge sweeps counter-clockwise
      const theta = 4 * Math.atan(bulge);
      const dx = x1 - x0, dy = y1 - y0;
      const chord = Math.hypot(dx, dy);
      const r = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
      const n = arcSegments(r, theta);
      const f = (1 - bulge * bulge) / (4 * bulge);
      const cx = (x0 + x1) / 2 - dy * f;
      const cy = (y0 + y1) / 2 + dx * f;
      const a0 = Math.atan2(y0 - cy, x0 - cx);
      for (let k = 1; k < n; k++) {
        const a = a0 + (theta * k) / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
  }
  if (!closed) pts.push(verts[verts.length - 1].slice(0, 2));
  return pts;
}

/**
 * Parse DXF text.
 * Returns { paths: [[x,y]...][] (open or closed point chains), circles: {x,y,r}[], counts }
 */
export function parseDxf(text) {
  const entities = readEntities(readPairs(text));
  const paths = [];
  const circles = [];
  const counts = {};

  for (let i = 0; i < entities.length; i++) {
    const { type, codes } = entities[i];
    counts[type] = (counts[type] || 0) + 1;

    if (type === "LINE") {
      paths.push([[num(codes, 10), num(codes, 20)], [num(codes, 11), num(codes, 21)]]);
    } else if (type === "ARC") {
      paths.push(arcPoints(num(codes, 10), num(codes, 20), num(codes, 40), num(codes, 50), num(codes, 51)));
    } else if (type === "CIRCLE") {
      circles.push({ x: num(codes, 10), y: num(codes, 20), r: num(codes, 40) });
    } else if (type === "LWPOLYLINE") {
      const closed = (num(codes, 70) & 1) === 1;
      const verts = [];
      for (const [c, v] of codes) {
        if (c === 10) verts.push([parseFloat(v), 0, 0]);
        else if (c === 20 && verts.length) verts[verts.length - 1][1] = parseFloat(v);
        else if (c === 42 && verts.length) verts[verts.length - 1][2] = parseFloat(v);
      }
      if (verts.length >= 2) paths.push(closeIf(bulgePolyline(verts, closed), closed));
    } else if (type === "POLYLINE") {
      const closed = (num(codes, 70) & 1) === 1;
      const verts = [];
      while (entities[i + 1]?.type === "VERTEX") {
        const vc = entities[++i].codes;
        counts.VERTEX = (counts.VERTEX || 0) + 1;
        verts.push([num(vc, 10), num(vc, 20), num(vc, 42)]);
      }
      if (entities[i + 1]?.type === "SEQEND") i++;
      if (verts.length >= 2) paths.push(closeIf(bulgePolyline(verts, closed), closed));
    }
  }
  // KiCad draws each drill mark twice; keep one circle per centre/radius.
  const seen = new Set();
  const uniqueCircles = circles.filter((c) => {
    const k = `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.r.toFixed(4)}`;
    return !seen.has(k) && seen.add(k);
  });
  return { paths, circles: uniqueCircles, counts };
}

function closeIf(pts, closed) {
  if (closed) pts.push(pts[0].slice());
  return pts;
}

/**
 * Join loose path pieces into closed loops by matching endpoints.
 * With an even-odd fill the exact pairing at shared vertices doesn't matter,
 * so a simple walk is enough.
 */
export function chainLoops(paths, tolerance = 1e-4) {
  const key = ([x, y]) => `${Math.round(x / tolerance)},${Math.round(y / tolerance)}`;
  const loops = [];
  const pieces = [];

  for (const raw of paths) {
    // Drop repeated points (KiCad writes zero-length LINEs) so outlines never revisit a vertex.
    const p = raw.filter((pt, i) => i === 0 || key(pt) !== key(raw[i - 1]));
    if (p.length < 2) continue;
    if (key(p[0]) === key(p[p.length - 1]) && p.length > 3) loops.push(p.slice(0, -1));
    else pieces.push(p);
  }

  const ends = new Map(); // endpoint key -> [{piece, atStart}]
  const addEnd = (k, ref) => (ends.get(k) || ends.set(k, []).get(k)).push(ref);
  pieces.forEach((p, idx) => {
    addEnd(key(p[0]), { idx, atStart: true });
    addEnd(key(p[p.length - 1]), { idx, atStart: false });
  });

  const used = new Uint8Array(pieces.length);
  let openChains = 0;

  for (let start = 0; start < pieces.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const loop = pieces[start].slice();
    const startKey = key(loop[0]);
    let closed = false;
    for (;;) {
      const tailKey = key(loop[loop.length - 1]);
      if (tailKey === startKey) { closed = true; break; }
      const next = (ends.get(tailKey) || []).find((r) => !used[r.idx]);
      if (!next) break;
      used[next.idx] = 1;
      const piece = pieces[next.idx];
      const pts = next.atStart ? piece : piece.slice().reverse();
      for (let k = 1; k < pts.length; k++) loop.push(pts[k]);
    }
    if (closed && loop.length > 3) loops.push(loop.slice(0, -1));
    else openChains++;
  }
  return { loops, openChains };
}
