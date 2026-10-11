// Build the copper-tape PCB jig from parsed DXF geometry using manifold-3d.
import { chainLoops, circlePoints } from "./dxf.js";

const SIMPLIFY = 0.002; // mm

/**
 * @param wasm      initialised manifold-3d module (after setup())
 * @param dxf       result of parseDxf()
 * @param opts      { traceHeight, baseThickness, margin, cutHoles, flip, plateShape, holeDiameter, padDiameter, widen }
 *                  plateShape: "rectangle" (default) or "outline" (plate follows the traces)
 *                  holeDiameter / padDiameter: mm, or null to keep the sizes from the DXF
 *                  widen: mm added to the width of every trace and pad (half on each side)
 * @returns { mesh: {positions: Float32Array, indices: Uint32Array}, stats }
 */
export function buildModel(wasm, dxf, opts) {
  const { CrossSection } = wasm;
  const { traceHeight, baseThickness, margin, cutHoles, flip, plateShape = "rectangle", holeDiameter = null, padDiameter = null, widen = 0 } = opts;
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

    const piecesBefore = countPieces(copper);

    // Optional widening: grow every trace and pad outward by half the amount on each side.
    // The tiny extra keeps grid-aligned gaps from closing to an exact point, which
    // would pinch the copper into a non-manifold shape.
    if (widen > 0) copper = keep(copper.offset(widen / 2 + 0.0013, "Round", 2, 48));

    // Optional round pads around every hole that is already part of the copper.
    if (padDiameter) {
      const padded = drills.filter((d) => d.touchesCopper);
      if (padded.length) {
        const pads = keep(new CrossSection(padded.map((d) => circlePoints(d.x, d.y, padDiameter / 2)), "NonZero"));
        copper = keep(copper.add(pads));
      }
    }
    // Fewer separate copper areas than before means widening or pads bridged two nets.
    const shorts = Math.max(0, piecesBefore - countPieces(copper));

    let holes = null;
    if (cutHoles && drills.length) {
      holes = keep(new CrossSection(drills.map((d) => circlePoints(d.x, d.y, d.r)), "NonZero"));
    }

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

    let holeCount = holes ? drills.length : 0;
    if (holes && plateShape === "outline") {
      // Only cut holes that sit fully inside the plate. One that straddles the
      // plate edge (a pin with no copper) would just be a notch, and an exactly
      // tangent one would pinch the plate.
      const inside = drills.filter((d) => keep(disk(d.x, d.y, d.r + 0.05).subtract(base)).area() < 1e-6);
      holeCount = inside.length;
      holes = inside.length ? keep(new CrossSection(inside.map((d) => circlePoints(d.x, d.y, d.r)), "NonZero")) : null;
    }
    if (holes) {
      copper = keep(copper.subtract(holes));
      base = keep(base.subtract(holes));
    }
    // Drop vertices closer together than float32 STL precision can separate.
    copper = keep(copper.simplify(SIMPLIFY));
    base = keep(base.simplify(SIMPLIFY));

    // Move to the origin so it drops straight onto a print bed.
    const pb = base.bounds();
    const shift = [-pb.min[0], -pb.min[1]];
    copper = keep(copper.translate(shift));
    base = keep(base.translate(shift));
    const width = pb.max[0] - pb.min[0];
    const depth = pb.max[1] - pb.min[1];

    const copperArea = copper.area();
    const baseSolid = keep(base.extrude(baseThickness));
    // Start the copper inside the plate so the union has no coplanar faces.
    const copperSolid = keep(keep(copper.extrude(traceHeight + baseThickness / 2)).translate([0, 0, baseThickness / 2]));
    const solid = keep(baseSolid.add(copperSolid));

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
        size: [width, depth, baseThickness + traceHeight],
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
