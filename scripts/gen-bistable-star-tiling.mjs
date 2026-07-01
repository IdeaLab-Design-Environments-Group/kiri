// Generates public/examples/bistable-star-tiling.fkld
//
// A PROPER bistable kirigami metamaterial: the rotating-triangles (kagome)
// auxetic. One continuous sheet is cut into rigid equilateral-triangle panels
// joined ONLY at shared corner points (the hinges). Twisting the panels by ±θ
// is a 1-DOF rigid mechanism — every panel stays rigid, so it is exactly
// isometric — and it opens a tiling of triangular/6-point-star pores. The two
// rigid extremes (compact ⇄ expanded) are the two stable states → bistable,
// and under load the sheet buckles out of plane into a dome (Rafsanjani &
// Bertoldi-style rotating-units kirigami; cf. wiki [[bistability-origami]],
// [[auxetic-metamaterial]]).
//
//   frame 0          = expanded/twisted state (the star-pore tiling preview)
//   file_frames[0]   = compact state (the other stable configuration)
//
// Both frames share one vertex topology; panels are rigid in both, so the
// flat→fold edge-length error is machine-epsilon (asserted below). No fake
// non-isometric morph — the 3D dome is the post-buckling state the 3D Sim
// free-folds from this cut pattern.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RHO = 12;               // triangle circumradius (centroid→corner), mm
const SIDE = Math.sqrt(3) * RHO;
const THETA_OPEN = 24;        // twist of the expanded (preview) state, deg
const THETA_COMPACT = 4;      // twist of the compact stable state, deg
const M = 3, N = 3;           // patch size in honeycomb cells (up/down sites)
const THICK = 0.6;            // sheet thickness, mm

const D2R = Math.PI / 180;
const cos = (d) => Math.cos(d * D2R);
const sin = (d) => Math.sin(d * D2R);

// --- one rigid state: place every up/down triangle at twist `thetaDeg` -------
// Up sites on a triangular lattice; each up connects to a down at +(−30°)·b.
// Up corners at {90,210,330}+θ, down corners at {30,150,270}−θ (radius RHO).
// Derivation: an up corner@(330+θ) coincides with the down corner@(150−θ) of
// the down site offset by RHO·cosθ·(√3,−1) — so b = 2·RHO·cosθ closes the
// hinge exactly. Same indexing for every θ → consistent topology across states.
function stateTriangles(thetaDeg) {
  const b = 2 * RHO * cos(thetaDeg);
  const v1 = [b * Math.sqrt(3), 0];
  const v2 = [b * Math.sqrt(3) / 2, b * 3 / 2];
  const tris = []; // each = {key, corners:[[x,y]×3]}
  const upC = (cx, cy) => [90, 210, 330].map((a) => [cx + RHO * cos(a + thetaDeg), cy + RHO * sin(a + thetaDeg)]);
  const dnC = (cx, cy) => [30, 150, 270].map((a) => [cx + RHO * cos(a - thetaDeg), cy + RHO * sin(a - thetaDeg)]);
  for (let m = 0; m <= M; m++) {
    for (let n = 0; n <= N; n++) {
      const ux = m * v1[0] + n * v2[0], uy = m * v1[1] + n * v2[1];
      const dx = ux + b * Math.sqrt(3) / 2, dy = uy - b / 2; // down = up + b·dir(−30°)
      tris.push({ key: `u:${m}:${n}`, corners: upC(ux, uy) });
      tris.push({ key: `d:${m}:${n}`, corners: dnC(dx, dy) });
    }
  }
  return tris;
}

// --- shared topology: union-find corners that coincide in the COMPACT state --
const ref = stateTriangles(THETA_COMPACT);
const TOL = 1e-6;
const slots = [];                  // {x,y, members:[[triIdx,cornerIdx]]}
function slotFor(p) {
  for (const s of slots) if (Math.hypot(s.x - p[0], s.y - p[1]) < 1e-3) return s;
  const s = { x: p[0], y: p[1], members: [] }; slots.push(s); return s;
}
ref.forEach((t, ti) => t.corners.forEach((c, ci) => slotFor(c).members.push([ti, ci])));

// Vertex id per slot; face = its triangle's 3 slot-ids.
const vid = new Map(slots.map((s, i) => [s, i]));
const cornerSlot = ref.map((t) => t.corners.map((c) => vid.get(slotFor(c))));
const faces = cornerSlot.map((ids) => ids);

// --- materialise both states on the shared topology, asserting isometry ------
function coordsFor(thetaDeg) {
  const tris = stateTriangles(thetaDeg);
  const pos = new Array(slots.length).fill(null);
  let maxResid = 0;
  tris.forEach((t, ti) => t.corners.forEach((c, ci) => {
    const v = cornerSlot[ti][ci];
    if (pos[v] == null) pos[v] = c;
    else maxResid = Math.max(maxResid, Math.hypot(pos[v][0] - c[0], pos[v][1] - c[1]));
  }));
  return { pos, maxResid };
}
const open = coordsFor(THETA_OPEN);
const compact = coordsFor(THETA_COMPACT);
if (open.maxResid > 1e-6) throw new Error(`open hinges not coincident: ${open.maxResid}`);
if (compact.maxResid > 1e-6) throw new Error(`compact hinges not coincident: ${compact.maxResid}`);

// --- edges (every triangle edge is an auxetic cut slit) ----------------------
const edgeMap = new Map(); // "a,b" -> [a,b]
for (const f of faces) for (let k = 0; k < 3; k++) {
  const a = f[k], c = f[(k + 1) % 3]; const key = a < c ? `${a},${c}` : `${c},${a}`;
  if (!edgeMap.has(key)) edgeMap.set(key, [Math.min(a, c), Math.max(a, c)]);
}
const edges = [...edgeMap.values()];

// --- isometry check across the two frames (rigid panels) ---------------------
let maxLenErr = 0;
for (const [i, j] of edges) {
  const lo = Math.hypot(open.pos[i][0] - open.pos[j][0], open.pos[i][1] - open.pos[j][1]);
  const lc = Math.hypot(compact.pos[i][0] - compact.pos[j][0], compact.pos[i][1] - compact.pos[j][1]);
  maxLenErr = Math.max(maxLenErr, Math.abs(lo - lc));
}
if (maxLenErr > 1e-9) throw new Error(`NOT isometric between states: ${maxLenErr}`);
const NV = slots.length;
for (const f of faces) for (const v of f) if (v < 0 || v >= NV) throw new Error("face index OOR");

// --- emit FKLD ---------------------------------------------------------------
const r = (x) => (Math.abs(x) < 1e-12 ? 0 : Number(x.toFixed(6)));
const fkld = {
  file_spec: 1.2,
  file_creator: "Kirigamizer example — bistable rotating-triangles (kagome) auxetic kirigami",
  file_classes: ["creasePattern"],
  frame_unit: "mm",
  vertices_coords: open.pos.map((p) => [r(p[0]), r(p[1])]),     // expanded star-pore tiling
  edges_vertices: edges,
  edges_assignment: edges.map(() => "C"),                       // corner-hinged panels: every edge is a cut
  faces_vertices: faces,
  "fkld:edges_cutType": edges.map(() => "auxetic"),
  "fkld:meta_architecture": { scaleMeters: 0.001, materialThickness: THICK },
  "fkld:meta_kirigami": {
    motif: "rotating-triangles-kagome", bistable: true, mechanism: "auxetic-rotating-units",
    triangles: faces.length, sideMm: r(SIDE), openDeg: THETA_OPEN, compactDeg: THETA_COMPACT,
  },
  "fkld:vertices_driven": open.pos.map(() => 1),
  file_frames: [{
    frame_classes: ["foldedForm"],
    frame_attributes: ["2D"],
    frame_inherit: true,
    frame_parent: 0,
    vertices_coords: compact.pos.map((p) => [r(p[0]), r(p[1])]), // the other stable state (compact)
  }],
  frame_title: "Bistable rotating-triangles kirigami — kagome auxetic star tiling (expanded ⇄ compact)",
};

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "examples", "bistable-star-tiling.fkld");
writeFileSync(out, JSON.stringify(fkld));
console.log(`wrote ${out}`);
console.log(`  triangles=${faces.length}  vertices=${NV}  edges=${edges.length}`);
console.log(`  hinge coincidence: open=${open.maxResid.toExponential(2)} compact=${compact.maxResid.toExponential(2)} mm`);
console.log(`  rigid-panel isometry expanded↔compact: max edge-length error ${maxLenErr.toExponential(2)} mm`);
console.log(`  triangle side=${SIDE.toFixed(2)}mm  twist ${THETA_COMPACT}°→${THETA_OPEN}°`);
