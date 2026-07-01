/**
 * Old-West false-front HOTEL → public/examples/hotel.stl, a kirigamizable low-poly solid in the same
 * family as house.stl / barn.stl (unit scale, ASCII STL, z-up). The signatures of a boomtown hotel:
 *   • a tall flat FALSE FRONT (the front wall rises into a parapet above the roofline — the sign board),
 *   • a stepped-back shallow roof behind it,
 *   • a full-width PORCH / BALCONY overhang projecting from the front at mid-height, and
 *   • a central DOOR (a boundary notch) under the porch.
 *
 * The body is the extrusion (across width W, +x) of a SIDE PROFILE that already carries the parapet
 * and the porch tab, so it stays one clean prism (like barn.stl). The profile is ear-clipped for the
 * two end walls; each profile edge sweeps to a wall/roof/porch face; the door is carved into the lower
 * front wall. Open bottom (a shell), exactly like house/barn. Railings/posts are omitted (too thin to
 * kirigamize) — the porch reads as the overhang + balcony slab.
 *
 * Run:  node scripts/gen-hotel.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- dimensions (unit scale) --------------------------------------------------------------------
const W = 1.45;         // width  (x)
const D = 1.5;          // depth  (y)
const HE = 1.3;         // eave / roof height (top of the two-storey box)
const HF = 1.7;         // false-front parapet top
const PT = 0.14;        // parapet (front-wall) thickness behind its top
const HM = 0.62;        // porch / balcony floor height (between the two storeys)
const ST = 0.09;        // porch-slab thickness
const PP = 0.42;        // porch projection forward (−y)
const DOOR = { x0: 0.56, x1: 0.89, z1: 0.5 }; // central door: notch in the lower front wall

// side profile in (y, z); CCW. y = 0 front wall, +y toward the back, −y the porch overhang.
const PROF = [
  [0, 0], [D, 0], [D, HE], [PT, HE], [PT, HF], [0, HF],   // floor → back → roof → parapet
  [0, HM], [-PP, HM], [-PP, HM - ST], [0, HM - ST],        // front wall down to the porch tab + back
];
const EDGE = { BOTTOM: 0, FRONT_LOWER: 9 }; // omit BOTTOM (open shell); carve the door into FRONT_LOWER

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
    // lower front wall (y=0, z 0..HM−ST): carve the central door notch (gap x∈[x0,x1], z∈[0,z1])
    const zt = HM - ST, { x0, x1, z1 } = DOOR;
    const F = (xx, zz) => [xx, 0, zz];
    quad(F(0, 0), F(x0, 0), F(x0, zt), F(0, zt));     // left of door
    quad(F(x1, 0), F(W, 0), F(W, zt), F(x1, zt));     // right of door
    quad(F(x0, z1), F(x1, z1), F(x1, zt), F(x0, zt)); // above the door
    continue;
  }
  quad([0, p[0], p[1]], [0, q[0], q[1]], [W, q[0], q[1]], [W, p[0], p[1]]);
}

// ---- write ASCII STL ----------------------------------------------------------------------------
const out = ["solid hotel"];
for (const [a, b, c] of tris) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid hotel");
const path = resolve(import.meta.dirname, "..", "public/examples/hotel.stl");
writeFileSync(path, out.join("\n") + "\n");
console.log(`hotel.stl: ${tris.length} facets → ${path}`);
console.log(`  false-front hotel ${W}×${D}, eave ${HE}, parapet ${HF}; porch slab @${HM} (proj ${PP}); central door`);
