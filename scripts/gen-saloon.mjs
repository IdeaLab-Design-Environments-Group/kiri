/**
 * Old-West two-storey SALOON → public/examples/saloon.stl, a kirigamizable low-poly solid in the same
 * false-front family as hotel.stl / barn.stl / house.stl (unit scale, ASCII STL, z-up, open-bottom
 * shell). Saloon signatures:
 *   • a tall flat FALSE FRONT (the front wall rises into a rectangular parapet above the roofline —
 *     the "SALOON" sign board),
 *   • a stepped-back shallow roof behind it,
 *   • a full-width PORCH + BALCONY overhang projecting from the front at second-storey height, and
 *   • a wide central ENTRANCE (the swing-door bay — a boundary notch in the lower front wall).
 *
 * The body is the extrusion (across width W, +x) of a SIDE PROFILE that already carries the parapet
 * and the porch/balcony tab, so it stays one clean prism (like hotel.stl). The profile is ear-clipped
 * for the two end walls; each profile edge sweeps to a wall/roof/porch face; the entrance is carved
 * into the lower front wall. Posts/railings are omitted (too thin to kirigamize) — the porch reads as
 * the overhang + balcony slab.
 *
 * Run:  node scripts/gen-saloon.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- dimensions (unit scale) --------------------------------------------------------------------
const W = 1.7;          // width  (x) — saloons read wide
const D = 1.45;         // depth  (y)
const HE = 1.3;         // eave / roof height (top of the two-storey box)
const HF = 1.62;        // false-front parapet top (the sign board)
const PT = 0.13;        // parapet (front-wall) thickness behind its top
const HM = 0.7;         // porch / balcony floor height (between the two storeys)
const ST = 0.09;        // porch-slab thickness
const PP = 0.46;        // porch projection forward (−y)
// Central swing-door entrance as a DOUBLE-BAY: two door openings in x∈[x0,x1] split by a central
// mullion (width mw), under a shared lintel at z1 — the classic saloon batwing pair.
const DOOR = { x0: 0.55, x1: 1.15, z1: 0.58, mw: 0.1 };

// side profile in (y, z); y = 0 front wall, +y toward the back, −y the porch/balcony overhang.
const PROF = [
  [0, 0], [D, 0], [D, HE], [PT, HE], [PT, HF], [0, HF],   // floor → back → roof → parapet
  [0, HM], [-PP, HM], [-PP, HM - ST], [0, HM - ST],        // front wall down to the balcony tab + back
];
const EDGE = { BOTTOM: 0, FRONT_LOWER: 9 }; // omit BOTTOM (open shell); carve the entrance into FRONT_LOWER

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const CENTER = [W / 2, D / 2, HF / 2];
const tris = [];
function addTri(a, b, c) {
  const n = cross(sub(b, a), sub(c, a));
  if (Math.hypot(...n) < 1e-9) return;
  const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  tris.push(dot(n, sub(m, CENTER)) >= 0 ? [a, b, c] : [a, c, b]); // wind so the normal points outward
}
const quad = (a, b, c, d) => { addTri(a, b, c); addTri(a, c, d); };

// ---- end walls: triangulate the profile (ear clipping) at x = 0 and x = W -----------------------
function earClip(poly) {
  const n = poly.length, idx = [...Array(n).keys()], out = [];
  const ar = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  let A = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1]; }
  if (A < 0) idx.reverse();
  const inT = (p, a, b, c) => { const d1 = ar(a, b, p), d2 = ar(b, c, p), d3 = ar(c, a, p); return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0))); };
  let g = 0;
  while (idx.length > 3 && g++ < 2000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i - 1 + idx.length) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (ar(poly[a], poly[b], poly[c]) <= 1e-12) continue;
      let ear = true;
      for (const k of idx) if (k !== a && k !== b && k !== c && inT(poly[k], poly[a], poly[b], poly[c])) { ear = false; break; }
      if (ear) { out.push([a, b, c]); idx.splice(i, 1); cut = true; break; }
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}
const faceTris = earClip(PROF);
for (const x of [0, W]) for (const [a, b, c] of faceTris) {
  const P = (i) => [x, PROF[i][0], PROF[i][1]];
  addTri(P(a), P(b), P(c));
}

// ---- swept faces: each profile edge → a wall/roof/porch quad across the width -------------------
for (let i = 0; i < PROF.length; i++) {
  if (i === EDGE.BOTTOM) continue; // open bottom (a shell)
  const j = (i + 1) % PROF.length, p = PROF[i], q = PROF[j];
  if (i === EDGE.FRONT_LOWER) {
    // lower front wall (y=0, z 0..HM−ST): carve a DOUBLE-BAY entrance — two openings
    // [x0,xc0] and [xc1,x1] at z∈[0,z1], split by a central mullion [xc0,xc1], under a shared lintel.
    const zt = HM - ST, { x0, x1, z1, mw } = DOOR;
    const xc0 = (x0 + x1) / 2 - mw / 2, xc1 = (x0 + x1) / 2 + mw / 2;
    const F = (xx, zz) => [xx, 0, zz];
    quad(F(0, 0), F(x0, 0), F(x0, zt), F(0, zt));         // left of the entrance
    quad(F(x1, 0), F(W, 0), F(W, zt), F(x1, zt));         // right of the entrance
    quad(F(x0, z1), F(x1, z1), F(x1, zt), F(x0, zt));     // shared lintel above both bays
    quad(F(xc0, 0), F(xc1, 0), F(xc1, z1), F(xc0, z1));   // central mullion between the two bays
    continue;
  }
  quad([0, p[0], p[1]], [0, q[0], q[1]], [W, q[0], q[1]], [W, p[0], p[1]]);
}

// ---- write ASCII STL ----------------------------------------------------------------------------
const out = ["solid saloon"];
for (const [a, b, c] of tris) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid saloon");
const path = resolve(import.meta.dirname, "..", "public/examples/saloon.stl");
writeFileSync(path, out.join("\n") + "\n");
console.log(`saloon.stl: ${tris.length} facets → ${path}`);
console.log(`  two-storey false-front saloon ${W}×${D}, eave ${HE}, parapet ${HF}; balcony slab @${HM} (proj ${PP}); wide entrance`);
