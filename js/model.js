// Build the copper-tape PCB jig from parsed DXF geometry using manifold-3d.
import { chainLoops, circlePoints } from "./dxf.js";

/**
 * @param wasm      initialised manifold-3d module (after setup())
 * @param dxf       result of parseDxf()
 * @param opts      { traceHeight, baseThickness, margin, cutHoles, flip }
 * @returns { mesh: {positions: Float32Array, indices: Uint32Array}, stats }
 */
export function buildModel(wasm, dxf, opts) {
  const { CrossSection } = wasm;
  const { traceHeight, baseThickness, margin, cutHoles, flip } = opts;
  const trash = [];
  const keep = (obj) => (trash.push(obj), obj);

  try {
    const { loops, openChains } = chainLoops(dxf.paths);
    if (!loops.length) throw new Error("No closed outlines found in the DXF. Plot the copper layer with outlines (not filled) and try again.");

    // Even-odd fill: outlines nested inside outlines become cut-outs.
    let copper = keep(new CrossSection(loops, "EvenOdd"));
    let holes = null;
    if (cutHoles && dxf.circles.length) {
      holes = keep(new CrossSection(dxf.circles.map((c) => circlePoints(c.x, c.y, c.r)), "NonZero"));
    }

    // Mirror so the layout reads correctly from the plate (component) side.
    if (flip) {
      copper = keep(copper.mirror([1, 0]));
      if (holes) holes = keep(holes.mirror([1, 0]));
    }

    // Move to origin with the margin, so it drops straight onto a print bed.
    const b = copper.bounds();
    const shift = [margin - b.min[0], margin - b.min[1]];
    copper = keep(copper.translate(shift));
    if (holes) holes = keep(holes.translate(shift));
    const width = b.max[0] - b.min[0] + 2 * margin;
    const depth = b.max[1] - b.min[1] + 2 * margin;

    let base = keep(CrossSection.square([width, depth]));
    if (holes) {
      copper = keep(copper.subtract(holes));
      base = keep(base.subtract(holes));
    }

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
        holes: holes ? dxf.circles.length : 0,
        copperArea,
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
