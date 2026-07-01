/**
 * Old-West clapboard CHURCH (nave) → public/examples/church.stl: a steep TRUNCATED-gable chapel — the
 * two roof slopes meet a FLAT RIDGE PLATFORM that the bell tower stands on. Sized to sit with the
 * larger Western-town buildings (footprint ≈ hotel/general-store). Unit scale, ASCII STL, z-up.
 *
 * No socket/hole: a recessed well's cut edges splay open in the 3D-Sim free-fold, so the tower just
 * stands on the flat platform. The bell tower is a SEPARATE foldable piece (`church-tower.stl`). This
 * nave is a single convex massing → folds to a CLEAN CLOSED shape (d_H≈0). Winding fixed OUTWARD by
 * flood-fill so the app preview doesn't cull.
 *
 * Run:  node scripts/gen-church.mjs   (then node scripts/gen-church-tower.mjs for the tower)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- dimensions (unit scale, z-up) — bigger footprint, flat platform for the tower --------------
const W = 1.45, D = 1.4;          // nave footprint (x, y)
const HE = 0.78, H1 = 1.4;        // eave + flat ridge platform height (steep gable)
const FT = 0.66;                  // platform width (x) — the flat place the tower stands on
const xL = W / 2 - FT / 2, xR = W / 2 + FT / 2;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const tris = [];
const addTri = (a, b, c) => { if (Math.hypot(...cross(sub(b, a), sub(c, a))) > 1e-9) tris.push([a, b, c]); };
const quad = (a, b, c, d) => { addTri(a, b, c); addTri(a, c, d); };
function earClip(poly) {
  const n = poly.length, idx = [...Array(n).keys()], out = [];
  const ar = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  let A = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1]; }
  if (A < 0) idx.reverse();
  const inT = (p, a, b, c) => { const d1 = ar(a, b, p), d2 = ar(b, c, p), d3 = ar(c, a, p); return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0))); };
  let g = 0;
  while (idx.length > 3 && g++ < 3000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i - 1 + idx.length) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (ar(poly[a], poly[b], poly[c]) <= 1e-12) continue;
      let ok = true;
      for (const k of idx) if (k !== a && k !== b && k !== c && inT(poly[k], poly[a], poly[b], poly[c])) { ok = false; break; }
      if (ok) { out.push([a, b, c]); idx.splice(i, 1); cut = true; break; }
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}
const gXZ = (poly, y) => { for (const [a, b, c] of earClip(poly)) addTri([poly[a][0], y, poly[a][1]], [poly[b][0], y, poly[b][1]], [poly[c][0], y, poly[c][1]]); };

/** Globally consistent OUTWARD winding (per-face heuristics fail; the app preview backface-culls). */
function orientOutward(rawTris) {
  const key = (p) => p.map((v) => Math.round(v * 1e5)).join(",");
  const vm = new Map(), V = [];
  const vid = (p) => { const k = key(p); let i = vm.get(k); if (i === undefined) { i = V.length; vm.set(k, i); V.push(p); } return i; };
  const F = rawTris.map((t) => t.map(vid));
  const adj = new Map();
  F.forEach((f, fi) => { for (let e = 0; e < 3; e++) { const a = f[e], b = f[(e + 1) % 3], k = a < b ? `${a}_${b}` : `${b}_${a}`; (adj.get(k) ?? adj.set(k, []).get(k)).push(fi); } });
  const flip = (fi) => { const f = F[fi]; [f[1], f[2]] = [f[2], f[1]]; };
  const seen = new Array(F.length).fill(false), st = [0]; seen[0] = true;
  while (st.length) {
    const fi = st.pop(), f = F[fi];
    for (let e = 0; e < 3; e++) {
      const a = f[e], b = f[(e + 1) % 3], k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const nb = (adj.get(k) || []).find((g) => g !== fi);
      if (nb === undefined || seen[nb]) continue;
      const g = F[nb]; let sd = false;
      for (let e2 = 0; e2 < 3; e2++) if (g[e2] === a && g[(e2 + 1) % 3] === b) sd = true;
      if (sd) flip(nb); seen[nb] = true; st.push(nb);
    }
  }
  let vol = 0;
  for (const f of F) { const a = V[f[0]], b = V[f[1]], c = V[f[2]]; vol += (a[0] * (b[1] * c[2] - c[1] * b[2]) - a[1] * (b[0] * c[2] - c[0] * b[2]) + a[2] * (b[0] * c[1] - c[0] * b[1])) / 6; }
  if (vol < 0) F.forEach((_, fi) => flip(fi));
  return F.map((f) => [V[f[0]], V[f[1]], V[f[2]]]);
}

// ---- nave: floor + side walls + truncated-gable ends + two roof slopes + flat top platform -------
quad([0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]);                       // floor
quad([0, 0, 0], [0, 0, HE], [0, D, HE], [0, D, 0]);                     // left wall  (x=0)
quad([W, 0, 0], [W, D, 0], [W, D, HE], [W, 0, HE]);                     // right wall (x=W)
const gable = [[0, 0], [W, 0], [W, HE], [xR, H1], [xL, H1], [0, HE]];   // truncated-gable profile
gXZ(gable, 0);                                                         // front gable end (y=0)
gXZ(gable, D);                                                         // back gable end (y=D)
quad([0, 0, HE], [xL, 0, H1], [xL, D, H1], [0, D, HE]);                // left roof slope
quad([xR, 0, H1], [W, 0, HE], [W, D, HE], [xR, D, H1]);                // right roof slope
quad([xL, 0, H1], [xR, 0, H1], [xR, D, H1], [xL, D, H1]);              // FLAT TOP platform (the tower stands here)

// ---- write ASCII STL (globally-consistent outward normals) --------------------------------------
const oriented = orientOutward(tris);
const out = ["solid church"];
for (const [a, b, c] of oriented) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid church");
writeFileSync(resolve(import.meta.dirname, "..", "public/examples/church.stl"), out.join("\n") + "\n");
console.log(`church.stl: ${oriented.length} facets — nave w/ flat platform (no hole), ${W}×${D}×${H1}; folds clean & closed`);
