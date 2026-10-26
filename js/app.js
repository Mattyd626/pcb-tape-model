import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import Module from "manifold-3d";
import { parseDxf } from "./dxf.js";
import { buildModel, toBinaryStl } from "./model.js";

const $ = (id) => document.getElementById(id);
const ui = {
  drop: $("drop"), file: $("file"), dropTitle: $("drop-title"), dropHint: $("drop-hint"),
  traceHeight: $("traceHeight"), baseThickness: $("baseThickness"), margin: $("margin"),
  holeDiameter: $("holeDiameter"), padDiameter: $("padDiameter"), widen: $("widen"), border: $("border"),
  cutHoles: $("cutHoles"), flip: $("flip"), removePads: $("removePads"),
  stampClearance: $("stampClearance"), stampThickness: $("stampThickness"),
  stampFields: $("stamp-fields"), outputHint: $("output-hint"),
  download: $("download"), status: $("status"), stats: $("stats"),
  host: $("canvas-host"), empty: $("viewer-empty"), plateHint: $("plate-hint"),
};

let wasm = null;
let dxf = null;
let fileName = "board";
let lastResult = null;

function setStatus(msg, isError = false) {
  ui.status.textContent = msg;
  ui.status.classList.toggle("error", isError);
}

// ---------- 3D preview ----------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
ui.host.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(1, -1.5, 2);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(-1, 1, -0.5);
scene.add(fill);

const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 });
let meshObj = null;

function resize() {
  const { clientWidth: w, clientHeight: h } = ui.host;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(ui.host);

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

const PALETTE = {
  jig: { raised: new THREE.Color(0xd9853b), plate: new THREE.Color(0x8a8f86) },
  stamp: { raised: new THREE.Color(0x6f8fb0), plate: new THREE.Color(0x7d8590) },
};

function showMesh({ positions, indices }, plateTop, refit, output = "jig") {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  indexed.setIndex(new THREE.BufferAttribute(indices, 1));
  const geo = indexed.toNonIndexed();
  indexed.dispose();

  // Colour each triangle: raised (traces or ribs) if above the plate, otherwise plate.
  const pos = geo.attributes.position.array;
  const colors = new Float32Array(pos.length);
  const { raised: copper, plate } = PALETTE[output];
  for (let t = 0; t < pos.length; t += 9) {
    const maxZ = Math.max(pos[t + 2], pos[t + 5], pos[t + 8]);
    const c = maxZ > plateTop + 1e-3 ? copper : plate;
    for (let k = 0; k < 9; k += 3) {
      colors[t + k] = c.r; colors[t + k + 1] = c.g; colors[t + k + 2] = c.b;
    }
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); }
  meshObj = new THREE.Mesh(geo, material);
  scene.add(meshObj);
  ui.empty.hidden = true;

  if (refit) {
    geo.computeBoundingBox();
    const box = geo.boundingBox;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    // Pull back far enough that the board fits the narrower viewer dimension.
    const dist = (size / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.min(1, camera.aspect) * 1.15;
    controls.target.copy(center);
    camera.position.set(center.x, center.y - dist * 0.7, center.z + dist * 0.6);
    camera.near = size / 200;
    camera.far = size * 20;
    camera.updateProjectionMatrix();
  }
}

// ---------- model building ----------
const plateShape = () => document.querySelector('input[name="plateShape"]:checked').value;
const output = () => document.querySelector('input[name="output"]:checked').value;
const OUTPUT_HINTS = {
  jig: "The board you lay copper tape on.",
  stamp: "Lay tape over the whole jig, then press this face-down onto it: the ribs push the tape into the gaps and cut it along every trace edge. Pins through a few holes keep it lined up.",
};
const PLATE_HINTS = {
  rectangle: "A solid rectangle under everything, extending past the copper by the margin.",
  outline: "The plate hugs the traces, extending past them by the margin.",
};

function readOptions() {
  const n = (el, min) => Math.max(min, parseFloat(el.value) || 0);
  // Blank (or invalid) means "use the size from the DXF".
  const optional = (el, min) => {
    const v = parseFloat(el.value);
    return Number.isFinite(v) && v > 0 ? Math.max(min, v) : null;
  };
  return {
    traceHeight: n(ui.traceHeight, 0.05),
    baseThickness: n(ui.baseThickness, 0.05),
    margin: n(ui.margin, 0),
    widen: n(ui.widen, 0),
    border: n(ui.border, 0),
    holeDiameter: optional(ui.holeDiameter, 0.2),
    padDiameter: optional(ui.padDiameter, 0.5),
    cutHoles: ui.cutHoles.checked,
    flip: ui.flip.checked,
    plateShape: plateShape(),
    removePads: ui.removePads.checked,
    output: output(),
    stampClearance: n(ui.stampClearance, 0),
    stampThickness: n(ui.stampThickness, 0.4),
  };
}

function renderStats(s) {
  const rows = [
    ["Size", `${s.size.map((v) => v.toFixed(1)).join(" × ")} mm`],
    ["Outlines", s.loops],
    ["Drill holes", s.holes],
    ["Copper area", `${s.copperArea.toFixed(0)} mm²`],
    ["Triangles", s.triangles.toLocaleString()],
  ];
  ui.stats.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    return [dt, dd];
  }));
  ui.stats.hidden = false;
}

function rebuild(refit = false) {
  if (!wasm || !dxf) return;
  const opts = readOptions();
  try {
    const t0 = performance.now();
    lastResult = buildModel(wasm, dxf, opts);
    const ms = Math.round(performance.now() - t0);
    showMesh(lastResult.mesh, lastResult.stats.plateTop, refit, opts.output);
    renderStats(lastResult.stats);
    ui.download.disabled = false;
    let warn = lastResult.stats.openChains
      ? ` ${lastResult.stats.openChains} open path(s) were skipped.`
      : "";
    if (lastResult.stats.shorts > 0) {
      warn += ` Copper now touches neighbouring copper in ${lastResult.stats.shorts} place(s); reduce the trace widening or pad size.`;
    }
    if (opts.padDiameter && opts.holeDiameter && opts.padDiameter <= opts.holeDiameter && !opts.removePads) {
      warn += " The pad is no bigger than the hole, so there's no copper ring.";
    }
    if (lastResult.stats.borderTrimmed) {
      warn += " The border was trimmed where it came within 0.5 mm of a trace; raise the plate margin for a full rim.";
    }
    if (lastResult.stats.platePieces > 1) {
      warn += ` The plate is in ${lastResult.stats.platePieces} separate pieces; raise the margin to join them.`;
    }
    setStatus(`Built in ${ms} ms.${warn}`);
  } catch (err) {
    console.error(err);
    lastResult = null;
    ui.download.disabled = true;
    setStatus(err.message || String(err), true);
  }
}

let rebuildTimer = 0;
const scheduleRebuild = () => {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild(false), 200);
};
for (const el of [ui.traceHeight, ui.baseThickness, ui.margin, ui.widen, ui.border, ui.holeDiameter, ui.padDiameter,
  ui.stampClearance, ui.stampThickness]) {
  el.addEventListener("input", scheduleRebuild);
}
for (const el of [ui.cutHoles, ui.flip]) el.addEventListener("change", () => rebuild(false));
ui.removePads.addEventListener("change", () => {
  // Pad size has no meaning once pads are removed.
  ui.padDiameter.disabled = ui.removePads.checked;
  rebuild(false);
});
for (const el of document.querySelectorAll('input[name="output"]')) {
  el.addEventListener("change", () => {
    const kind = output();
    ui.outputHint.textContent = OUTPUT_HINTS[kind];
    ui.stampFields.hidden = kind !== "stamp";
    ui.download.textContent = `Download ${kind} STL`;
    rebuild(false);
  });
}
for (const el of document.querySelectorAll('input[name="plateShape"]')) {
  el.addEventListener("change", () => {
    ui.plateHint.textContent = PLATE_HINTS[plateShape()];
    rebuild(false);
  });
}

// ---------- file input ----------
async function loadFile(file) {
  if (!file) return;
  fileName = file.name.replace(/\.dxf$/i, "") || "board";
  ui.dropTitle.textContent = file.name;
  ui.dropHint.textContent = "Choose another file";
  try {
    dxf = parseDxf(await file.text());
    if (!dxf.paths.length) throw new Error("No line, arc or polyline outlines found in this DXF.");
  } catch (err) {
    dxf = null;
    ui.download.disabled = true;
    setStatus(err.message || String(err), true);
    return;
  }
  if (!wasm) { setStatus("File loaded; waiting for the geometry engine…"); return; }
  rebuild(true);
}

ui.file.addEventListener("change", () => loadFile(ui.file.files[0]));
for (const ev of ["dragenter", "dragover"]) {
  ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add("over"); });
}
for (const ev of ["dragleave", "drop"]) {
  ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.remove("over"); });
}
// Drops anywhere on the page (including the drop zone) bubble up to here.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => { e.preventDefault(); loadFile(e.dataTransfer.files[0]); });

ui.download.addEventListener("click", () => {
  if (!lastResult) return;
  const blob = new Blob([toBinaryStl(lastResult.mesh)], { type: "model/stl" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = lastResult.stats.output === "stamp" ? `${fileName}-stamp.stl` : `${fileName}.stl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- start ----------
try {
  wasm = await Module();
  wasm.setup();
  setStatus(dxf ? "Building…" : "Ready. Choose a DXF to begin.");
  if (dxf) rebuild(true);
} catch (err) {
  console.error(err);
  setStatus("Couldn't load the geometry engine. Check your connection and reload.", true);
}
