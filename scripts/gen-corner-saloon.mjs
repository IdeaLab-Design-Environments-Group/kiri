/**
 * OCTAGONAL SALOON → public/examples/corner-saloon.stl, a kirigamizable low-poly solid in the same
 * family as hotel.stl / saloon.stl (unit scale, ASCII STL, z-up, open-bottom shell). A regular
 * OCTAGON tower: every one of the 8 sides is identical, so the top and bottom are octagons.
 * Signatures:
 *   • a regular OCTAGON footprint (8 identical facades, octagon roof + octagon base),
 *   • the SAME wraparound PROTRUSION on every side — a thin balcony belt that oversails all 8 walls at
 *     mid-height (posts & railings omitted, too thin to fold), and
 *   • a single ENTRANCE (a double-bay swing door) carved into ONE side only.
 *
 * Construction (one clean manifold-with-boundary, open bottom): the body is the octagon extruded
 * 0→HR, but the wall is SPLIT at the balcony band HM..HM+ST, where a thin slab projects outward to
 * the expanded octagon (FULL offset out by PP): bottom ring (down) + top ring (up) + outer fascia.
 * The door is carved into the ground-floor wall of the front-facing edge only. Faces are wound by
 * explicit outward direction (polygon-agnostic: works for any convex footprint).
 *
 * Run:  node scripts/gen-corner-saloon.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- dimensions (unit scale) --------------------------------------------------------------------
const R = 1.05;               // octagon circumradius
const HM = 0.84;              // balcony band bottom (porch-roof / 2nd-storey floor)
const ST = 0.08;              // balcony slab thickness
const PP = +(process.env.PP ?? "0.2"); // balcony projection outward (same on every side); 0 ⇒ no belt
const HR = 1.5;               // roof height
const BELT = PP > 0.01;
const DOOR = { t0: 0.28, t1: 0.72, zd: 0.6, mw: 0.1 }; // double-bay entrance along the door wall (param t)

// regular OCTAGON footprint (CCW), flat top & bottom edges (vertices at 22.5° + 45°·k)
const JIT = +(process.env.JIT ?? "0"); // tiny per-vertex radius jitter to break symmetric unfold degeneracies
const FULL = Array.from({ length: 8 }, (_v, k) => {
  const a = ((22.5 + 45 * k) * Math.PI) / 180;
  const r = R * (1 + JIT * Math.sin(k * 1.7 + 0.5));
  return [r * Math.cos(a), r * Math.sin(a)];
});
// door on the single front-facing edge (the edge whose midpoint is most toward −y)
let DOOR_EDGE = 0, _bestY = Infinity;
for (let i = 0; i < 8; i++) { const my = (FULL[i][1] + FULL[(i + 1) % 8][1]) / 2; if (my < _bestY) { _bestY = my; DOOR_EDGE = i; } }

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// offset a CCW convex polygon by d (d<0 expands outward); offset each edge along its inward normal, re-intersect
function offsetConvex(poly, d) {
  const n = poly.length, lines = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    lines.push({ px: a[0] + (-dy / L) * d, py: a[1] + (dx / L) * d, dx, dy });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i - 1 + n) % n], l2 = lines[i];
    const den = l1.dx * l2.dy - l1.dy * l2.dx || 1e-9;
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
    out.push([l1.px + t * l1.dx, l1.py + t * l1.dy]);
  }
  return out;
}
const EXP = offsetConvex(FULL, -PP); // expanded footprint = balcony outer edge

const edgeOut = (poly, i) => { const a = poly[i], b = poly[(i + 1) % poly.length]; return [b[1] - a[1], -(b[0] - a[0]), 0]; };

const tris = [];
function addTri(a, b, c, outDir) {
  let n = cross(sub(b, a), sub(c, a));
  if (Math.hypot(...n) < 1e-12) return;
  if (dot(n, outDir) < 0) { const t = b; b = c; c = t; }
  tris.push([a, b, c]);
}
const quad = (a, b, c, d, o) => { addTri(a, b, c, o); addTri(a, c, d, o); };
const P = (xy, z) => [xy[0], xy[1], z];

function earClip(poly) {
  const n = poly.length, idx = [...Array(n).keys()], out = [];
  const ar = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  let S = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; S += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1]; }
  if (S < 0) idx.reverse();
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

// ---- ROOF (z = HR, full pentagon, faces up) -----------------------------------------------------
for (const [a, b, c] of earClip(FULL)) addTri(P(FULL[a], HR), P(FULL[b], HR), P(FULL[c], HR), [0, 0, 1]);

// ---- BODY WALLS (full footprint); split around the balcony band when present; one edge has the door
const ZLOW = BELT ? HM : HR; // lower wall top (belt band base, or the roof if no belt)
for (let i = 0; i < FULL.length; i++) {
  const a = FULL[i], b = FULL[(i + 1) % FULL.length], o = edgeOut(FULL, i);
  if (BELT) quad(P(a, HM + ST), P(b, HM + ST), P(b, HR), P(a, HR), o); // upper wall (above the belt)
  if (i === DOOR_EDGE) {
    const { t0, t1, zd, mw } = DOOR, tc0 = (t0 + t1) / 2 - mw / 2, tc1 = (t0 + t1) / 2 + mw / 2;
    const E = (t, z) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z];
    quad(E(0, 0), E(t0, 0), E(t0, ZLOW), E(0, ZLOW), o);       // left of entrance
    quad(E(t1, 0), E(1, 0), E(1, ZLOW), E(t1, ZLOW), o);       // right of entrance
    quad(E(t0, zd), E(t1, zd), E(t1, ZLOW), E(t0, ZLOW), o);   // shared lintel
    quad(E(tc0, 0), E(tc1, 0), E(tc1, zd), E(tc0, zd), o);     // central mullion (double bay)
  } else {
    quad(P(a, 0), P(b, 0), P(b, ZLOW), P(a, ZLOW), o);
  }
}

// ---- WRAPAROUND BALCONY belt: bottom ring (down) + top ring (up) + outer fascia (out) ------------
if (BELT) for (let i = 0; i < FULL.length; i++) {
  const fa = FULL[i], fb = FULL[(i + 1) % FULL.length], ea = EXP[i], eb = EXP[(i + 1) % EXP.length], o = edgeOut(FULL, i);
  quad(P(fa, HM), P(fb, HM), P(eb, HM), P(ea, HM), [0, 0, -1]);                 // balcony underside
  quad(P(fa, HM + ST), P(fb, HM + ST), P(eb, HM + ST), P(ea, HM + ST), [0, 0, 1]); // balcony top
  quad(P(ea, HM), P(eb, HM), P(eb, HM + ST), P(ea, HM + ST), o);               // balcony fascia (outer edge)
}

// ---- write ASCII STL ----------------------------------------------------------------------------
const out = ["solid corner_saloon"];
for (const [a, b, c] of tris) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid corner_saloon");
const path = resolve(import.meta.dirname, "..", "public/examples/corner-saloon.stl");
writeFileSync(path, out.join("\n") + "\n");
console.log(`corner-saloon.stl: ${tris.length} facets → ${path}`);
console.log(`  octagon tower R=${R}; 2-storey to ${HR}, wraparound balcony @${HM} (proj ${PP}) on all 8 sides; double-bay door on edge ${DOOR_EDGE}`);
