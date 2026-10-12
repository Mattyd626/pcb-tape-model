// Build the copper-tape PCB jig from parsed DXF geometry using manifold-3d.
import { chainLoops, circlePoints } from "./dxf.js";

const SIMPLIFY = 0.002; // mm

/**
 * @param wasm      initialised manifold-3d module (after setup())
 * @param dxf       result of parseDxf()
 * @param opts      { traceHeight, baseThickness, margin, cutHoles, flip, plateShape, holeDiameter, padDiameter, widen,
 *                    removePads, output, stampClearance, stampThickness }
 *                  plateShape: "rectangle" (default) or "outline" (plate follows the traces)
 *                  holeDiameter / padDiameter: mm, or null to keep the sizes from the DXF
 *                  widen: mm added to the width of every trace and pad (half on each side)
 *                  removePads: strip pads so traces run straight into the holes
 *                  output: "jig" (default) or "stamp" (the negative pressed onto the jig to cut tape)
 * @returns { mesh: {positions: Float32Array, indices: Uint32Array}, stats }
 */
export function buildModel(wasm, dxf, opts) {
  const { CrossSection } = wasm;
  const { traceHeight, baseThickness, margin, cutHoles, flip, plateShape = "rectangle", holeDiameter = null, padDiameter = null, widen = 0,
    removePads = false, output = "jig", stampClearance = 0.2, stampThickness = 2 } = opts;
  const trash = [];
  const keep = (obj) => (trash.push(obj), obj);

  try {
    const { loops, openChains } = chainLoops(dxf.paths);
    if (!loops.length) throw new Error("No closed outlines found in the DXF. Plot the copper layer with outlines (not filled) and try again.");

    // Even-odd fill: outlines nested inside outlines become cut-outs.
    let copper = keep(new CrossSection(loops, "EvenOdd"));
    // Mirror so the layout reads correctly from the plate (component) side.
    if (flip) copper = keep(copper.mirror([1, 0]));

    // Drill positions in the (possibly mirrored) frame, with the chosen hole size.
    const drills = dxf.circles.map((c) => ({
      x: flip ? -c.x : c.x,
      y: c.y,
      r: holeDiameter ? holeDiameter / 2 : c.r,
      touchesCopper: false,
    }));
    const disk = (x, y, r) => keep(keep(CrossSection.circle(r, 48)).translate([x, y]));
    for (const [i, d] of drills.entries()) {
      d.touchesCopper = keep(disk(d.x, d.y, dxf.circles[i].r).intersect(copper)).area() > 1e-6;
    }

    let padsRemoved = 0;
    if (removePads) {
      const r = stripPads(CrossSection, copper, drills, dxf.circles, keep);
      copper = r.copper;
      padsRemoved = r.count;
    }
    // Counted after pad removal: a pad with no traces disappears entirely, which
    // must not look like a short.
    const piecesBefore = countPieces(copper);

    // Optional widening: grow every trace and pad outward by half the amount on each side.
    // The tiny extra keeps grid-aligned gaps from closing to an exact point, which
    // would pinch the copper into a non-manifold shape.
    if (widen > 0) copper = keep(copper.offset(widen / 2 + 0.0013, "Round", 2, 48));

    // Optional round pads around every hole that is already part of the copper.
    if (padDiameter && !removePads) {
      const padded = drills.filter((d) => d.touchesCopper);
      if (padded.length) {
        const pads = keep(new CrossSection(padded.map((d) => circlePoints(d.x, d.y, padDiameter / 2)), "NonZero"));
        copper = keep(copper.add(pads));
      }
    }
    // Fewer separate copper areas than before means widening or pads bridged two nets.
    const shorts = Math.max(0, piecesBefore - countPieces(copper));

    // The plate is either the bounding rectangle or the copper grown by the margin.
    let base;
    if (plateShape === "outline") {
      let grown = margin > 0 ? keep(copper.offset(margin, "Round", 2, 48)) : copper;
      base = keep(keep(fillGaps(CrossSection, grown)).simplify(SIMPLIFY));
    } else {
      const b = copper.bounds();
      base = keep(keep(CrossSection.square([b.max[0] - b.min[0] + 2 * margin, b.max[1] - b.min[1] + 2 * margin]))
        .translate([b.min[0] - margin, b.min[1] - margin]));
    }
    const platePieces = countPieces(base);

    let cutDrills = cutHoles ? drills : [];
    if (plateShape === "outline") {
      // Only cut holes that sit fully inside the plate. One that straddles the
      // plate edge (a pin with no copper) would just be a notch, and an exactly
      // tangent one would pinch the plate.
      cutDrills = cutDrills.filter((d) => keep(disk(d.x, d.y, d.r + 0.05).subtract(base)).area() < 1e-6);
    }
    const holeCount = cutDrills.length;
    const holesOf = (extra) => keep(new CrossSection(cutDrills.map((d) => circlePoints(d.x, d.y, d.r + extra)), "NonZero"));
    let outline = base; // plate shape before holes, for the stamp's ribs
    if (cutDrills.length) {
      // The copper's holes are a hair larger than the plate's, so a narrow trace
      // crossing a hole never shares part of the plate's hole wall (which would
      // leave the merged solid non-manifold).
      copper = keep(copper.subtract(holesOf(0.02)));
      base = keep(base.subtract(holesOf(0)));
    }
    // Drop vertices closer together than float32 STL precision can separate.
    copper = keep(copper.simplify(SIMPLIFY));
    base = keep(base.simplify(SIMPLIFY));
    outline = keep(outline.simplify(SIMPLIFY));

    // Move to the origin so it drops straight onto a print bed.
    const pb = base.bounds();
    const shift = [-pb.min[0], -pb.min[1]];
    copper = keep(copper.translate(shift));
    base = keep(base.translate(shift));
    outline = keep(outline.translate(shift));
    const width = pb.max[0] - pb.min[0];
    const depth = pb.max[1] - pb.min[1];

    const copperArea = copper.area();
    let solid, height;
    if (output === "stamp") {
      // The stamp is the negative: ribs everywhere except over the traces, with
      // pockets a little larger than each trace. It is mirrored so it lines up
      // when flipped face-down onto the jig.
      const pockets = keep(copper.offset(stampClearance, "Round", 2, 48));
      let ribs = keep(outline.subtract(pockets));
      // Same trick as the copper: rib holes a hair larger than the plate's.
      if (cutDrills.length) ribs = keep(ribs.subtract(keep(holesOf(0.02).translate(shift))));
      ribs = keep(ribs.simplify(SIMPLIFY));
      let plate = base;
      const mirror = (cs) => keep(keep(cs.mirror([1, 0])).translate([width, 0]));
      ribs = mirror(ribs);
      plate = mirror(plate);
      const plateSolid = keep(plate.extrude(stampThickness));
      const ribSolid = keep(keep(ribs.extrude(traceHeight + stampThickness / 2)).translate([0, 0, stampThickness / 2]));
      solid = keep(plateSolid.add(ribSolid));
      height = stampThickness + traceHeight;
    } else {
      const baseSolid = keep(base.extrude(baseThickness));
      // Start the copper inside the plate so the union has no coplanar faces.
      const copperSolid = keep(keep(copper.extrude(traceHeight + baseThickness / 2)).translate([0, 0, baseThickness / 2]));
      solid = keep(baseSolid.add(copperSolid));
      height = baseThickness + traceHeight;
    }

    const m = solid.getMesh();
    const positions = new Float32Array(m.numVert * 3);
    for (let i = 0; i < m.numVert; i++) {
      positions[i * 3] = m.vertProperties[i * m.numProp];
      positions[i * 3 + 1] = m.vertProperties[i * m.numProp + 1];
      positions[i * 3 + 2] = m.vertProperties[i * m.numProp + 2];
    }
    const indices = new Uint32Array(m.triVerts);

    return {
      mesh: { positions, indices },
      stats: {
        loops: loops.length,
        openChains,
        holes: holeCount,
        copperArea,
        platePieces,
        shorts,
        padsRemoved,
        output,
        plateTop: output === "stamp" ? stampThickness : baseThickness,
        size: [width, depth, height],
        triangles: indices.length / 3,
        genus: solid.genus(),
        status: solid.status(),
      },
    };
  } finally {
    for (const obj of trash) obj.delete();
  }
}

/**
 * Keep only the outer boundaries of a cross-section, filling every enclosed gap.
 * Gaps between traces can shrink to a point at some margins, which would pinch
 * the plate; drill holes are cut afterwards anyway.
 */
function fillGaps(CrossSection, section) {
  const signedArea = (ring) => {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return a / 2;
  };
  const outers = section.toPolygons().filter((ring) => signedArea(ring) > 0);
  return new CrossSection(outers, "Positive");
}

/**
 * Remove the pad around every hole that sits on copper, then run each trace that
 * left the pad straight into the hole centre at the trace's own width.
 *
 * A pad is found by shrinking the copper around the hole until traces vanish and
 * growing it back ("opening"): what survives is the pad's own body, whatever its
 * shape (round, square, oval). Only copper connected to the pad is touched, so
 * nearby traces on other nets are left alone.
 */
function stripPads(CrossSection, copper, drills, circles, keep) {
  const disk = (x, y, r) => keep(keep(CrossSection.circle(r, 48)).translate([x, y]));
  const EDGE = 0.03; // cut just past the pad edge so trace stubs start cleanly
  const BAND = 0.2;  // width of the ring used to find where traces leave a pad
  const pads = [];

  for (const [i, d] of drills.entries()) {
    if (!d.touchesCopper) continue;
    const box = keep(keep(CrossSection.square([12, 12], true)).translate([d.x, d.y]));
    // Fill the drill itself in case the DXF drew the pad as a ring.
    const local = keep(keep(copper.intersect(box)).add(disk(d.x, d.y, circles[i].r)));

    // Largest circle around the hole that is still all copper = the pad's inner size.
    let lo = 0.05, hi = 5;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      if (keep(disk(d.x, d.y, mid).subtract(local)).area() < 1e-4) lo = mid; else hi = mid;
    }
    const inner = lo;
    const shrink = inner * 0.8; // traces narrower than this x2 disappear
    // Miter joins keep the sharp corners of square pads through the shrink/grow.
    const opened = keep(keep(local.offset(-shrink, "Miter", 4)).offset(shrink, "Miter", 4));
    const centre = disk(d.x, d.y, 0.01);
    const body = opened.decompose().map(keep).find((piece) => keep(piece.intersect(centre)).area() > 0);
    if (body) pads.push({ d, inner, cut: keep(body.offset(EDGE, "Miter", 4)) });
  }
  if (!pads.length) return { copper, count: 0 };

  let stripped = copper;
  for (const { cut } of pads) stripped = keep(stripped.subtract(cut));

  // Where each trace left a pad, add a straight run of the same width into the hole.
  const runs = [];
  for (const { d, inner, cut } of pads) {
    const ring = keep(keep(cut.offset(BAND, "Round", 2, 48)).subtract(cut));
    const band = keep(ring.intersect(stripped));
    const reach = keep(cut.offset(0.01, "Round", 2, 48));
    for (const piece of band.decompose().map(keep)) {
      // Only trace stubs that start right at the pad edge; anything else is another net.
      if (keep(piece.intersect(reach)).area() <= 1e-6) continue;
      // The run is the hull of the trace stub and a trace-wide disc at the hole,
      // so its sides line up exactly with the trace's own edges.
      const width = Math.min(Math.max(piece.area() / BAND, 0.3), inner * 2);
      runs.push(keep(CrossSection.hull([piece, disk(d.x, d.y, width / 2)])));
    }
  }
  for (const run of runs) stripped = keep(stripped.add(run));
  return { copper: stripped, count: pads.length };
}

function countPieces(section) {
  const pieces = section.decompose();
  for (const piece of pieces) piece.delete();
  return pieces.length;
}

/** Encode an indexed triangle mesh as a binary STL. */
export function toBinaryStl({ positions, indices }) {
  const triCount = indices.length / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = "PCB copper-tape jig";
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, triCount, true);

  let o = 84;
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [nx, ny, nz]) { view.setFloat32(o, v, true); o += 4; }
    for (const idx of [a, b, c]) {
      view.setFloat32(o, positions[idx], true);
      view.setFloat32(o + 4, positions[idx + 1], true);
      view.setFloat32(o + 8, positions[idx + 2], true);
      o += 12;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return buffer;
}
