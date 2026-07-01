/**
 * Medieval / rustic WOODEN WATER TOWER input solid → public/examples/medieval-water-tower.stl, a
 * kirigamizable low-poly solid in the same family as house.stl / barn.stl / windmill.stl (unit
 * scale, ASCII STL, z-up). The classic Western / medieval timber water tower: a round STAVED BARREL
 * TANK up top, a square TIMBER PLATFORM DECK under it (corners poke past the tank), and a tall
 * SPLAYED TIMBER TRESTLE (legs tapering outward to a wide stance at the ground). Load it in the app
 * and Kirigamize, exactly like house-door.stl.
 *
 * KIRIGAMI CONSTRAINT → it's a SOLID, not an open frame. A single-sheet kirigami body must be a
 * closed, genus-0, orientable 2-manifold; a literal see-through trestle (open gaps between legs and
 * braces) is high genus / multi-component and can't unfold. So the trestle is a SOLID SPLAYED
 * FRUSTUM (the legs' silhouette); the barrel staves + leg bracing are surface detail, not cuts.
 *
 * CONSTRUCTION — a ring LOFT of six N=16-point cross-section rings (square trestle/deck rings + round
 * barrel rings, all sampled at the same 16 angles so the square→round deck-top→tank-base transition
 * lines up). Triangle winding is made globally consistent by FLOOD-FILL orientation (a per-face
 * normal heuristic fails at the deck soffit, a non-convex concave fold), then flipped to outward by
 * the signed-volume sign — so the mesh passes the app's `orientFaces` / `assertGenusZero` conditioning.
 *
 * Companion to the vault build at outputs/town/medieval-water-tower/ (Python generator); this is the
 * unit-scale in-app seed solid. Run:  node scripts/gen-medieval-water-tower.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- dimensions (unit scale, matching house.stl ~1; a tower, so taller than wide) ----------------
const N = 16;
const R_TANK = 0.48, A_TTOP = 0.42, A_DECK = 0.52, A_GROUND = 0.62;   // half-widths/radii
const H_TRESTLE = 1.32, T_DECK = 0.10, H_TANK = 0.68;
const Z_TT = H_TRESTLE, Z_DT = Z_TT + T_DECK, Z_TOP = Z_DT + H_TANK;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normv = (v) => { const L = Math.hypot(...v) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };

// a cross-section ring: N points of a circle or a square outline, sampled at the same 16 angles
function ring(shape, s, z) {
  const pts = [];
  for (let k = 0; k < N; k++) {
    const a = 2 * Math.PI * k / N, c = Math.cos(a), si = Math.sin(a);
    if (shape === "circle") pts.push([s * c, s * si, z]);
    else { const m = Math.max(Math.abs(c), Math.abs(si)) || 1; pts.push([s * c / m, s * si / m, z]); }
  }
  return pts;
}

const G = ring("square", A_GROUND, 0);     // trestle ground (wide)
const TT = ring("square", A_TTOP, Z_TT);   // trestle top (narrow)
const DB = ring("square", A_DECK, Z_TT);   // deck bottom (overhang outer)
const DT = ring("square", A_DECK, Z_DT);   // deck top (outer)
const KB = ring("circle", R_TANK, Z_DT);   // tank base (round inner)
const KT = ring("circle", R_TANK, Z_TOP);  // tank top (round)

// boundary tiles: 5 bands (16 quads each) + 2 caps (one 16-gon polygon each)
const tiles = [];
const band = (A, B) => { for (let k = 0; k < N; k++) { const j = (k + 1) % N; tiles.push([A[k], A[j], B[j], B[k]]); } };
band(G, TT);     // trestle wall
band(DB, TT);    // deck soffit (overhang underside)
band(DB, DT);    // deck wall (platform rim)
band(DT, KB);    // deck top (under the round tank)
band(KB, KT);    // tank wall (barrel)
tiles.push(G.slice());    // ground cap
tiles.push(KT.slice());   // tank-top cap

// fan-triangulate every tile (winding fixed globally below). Caps (>4 pts) fan from the CENTROID:
// fanning a SQUARE cap from a vertex makes collinear edge-midpoint triangles degenerate, which the
// app's loader drops → an orphaned boundary edge → "bowtie vertex". The centroid keeps every tri valid.
let rawTris = [];
for (const poly of tiles) {
  if (poly.length > 4) {
    const c = poly.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / poly.length);
    for (let i = 0; i < poly.length; i++) rawTris.push([c, poly[i], poly[(i + 1) % poly.length]]);
  } else {
    for (let i = 1; i < poly.length - 1; i++) rawTris.push([poly[0], poly[i], poly[i + 1]]);
  }
}

// ---- global outward orientation: flood-fill consistency, then flip by signed volume -------------
function orient(tris) {
  const ids = new Map(), pos = [];
  const vid = (p) => {
    const k = p.map((x) => x.toFixed(5)).join(",");
    if (!ids.has(k)) { ids.set(k, pos.length); pos.push(p); }
    return ids.get(k);
  };
  const T = tris.map((t) => t.map(vid));
  const edgemap = new Map();
  const ekey = (u, v) => (u < v ? u + "_" + v : v + "_" + u);
  T.forEach(([a, b, c], ti) => {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = ekey(u, v); if (!edgemap.has(k)) edgemap.set(k, []); edgemap.get(k).push(ti);
    }
  });
  const flip = new Array(T.length).fill(false), seen = new Array(T.length).fill(false);
  const diredges = (ti) => { let [a, b, c] = T[ti]; if (flip[ti]) [a, c] = [c, a]; return [[a, b], [b, c], [c, a]]; };
  for (let seed = 0; seed < T.length; seed++) {
    if (seen[seed]) continue;
    seen[seed] = true; const q = [seed];
    while (q.length) {
      const ti = q.shift();
      for (const [u, v] of diredges(ti)) {
        for (const tj of edgemap.get(ekey(u, v))) {
          if (tj === ti || seen[tj]) continue;
          if (diredges(tj).some(([x, y]) => x === u && y === v)) flip[tj] = !flip[tj];
          seen[tj] = true; q.push(tj);
        }
      }
    }
  }
  let vol = 0;
  const out = T.map(([a, b, c], ti) => {
    if (flip[ti]) [a, c] = [c, a];
    const A = pos[a], B = pos[b], C = pos[c];
    vol += dot(A, cross(B, C)); return [A, B, C];
  });
  return vol < 0 ? out.map(([A, B, C]) => [A, C, B]) : out;
}
const outTris = orient(rawTris);

// ---- ASCII STL ----------------------------------------------------------------------------------
const e = (x) => x.toExponential(6);
const lines = ["solid medieval_water_tower"];
for (const [a, b, c] of outTris) {
  const n = normv(cross(sub(b, a), sub(c, a)));
  lines.push(` facet normal ${e(n[0])} ${e(n[1])} ${e(n[2])}`);
  lines.push("  outer loop");
  for (const p of [a, b, c]) lines.push(`   vertex ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}`);
  lines.push("  endloop");
  lines.push(" endfacet");
}
lines.push("endsolid medieval_water_tower");

const path = resolve(import.meta.dirname, "..", "public/examples/medieval-water-tower.stl");
writeFileSync(path, lines.join("\n") + "\n");
console.log(`medieval-water-tower.stl: ${outTris.length} facets → ${path}`);
console.log(`  barrel tank ⌀${(2 * R_TANK).toFixed(2)} × ${H_TANK.toFixed(2)}, deck ${(2 * A_DECK).toFixed(2)}, ` +
  `splayed trestle ${(2 * A_GROUND).toFixed(2)}→${(2 * A_TTOP).toFixed(2)} × ${H_TRESTLE.toFixed(2)}, total ${Z_TOP.toFixed(2)} tall`);
