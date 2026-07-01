/**
 * Barn input solid → public/examples/barn.stl, a kirigamizable low-poly solid in the same family as
 * house.stl / house-door.stl (unit scale, ASCII STL, z-up). The barn's signature is the GAMBREL roof
 * (the classic double-pitched barn roof: a steep lower slope + a shallow upper slope on each side),
 * plus a big central front door (a bottom notch in the front gable) and a hayloft opening (a hole in
 * the upper front gable). Load it in the app and Kirigamize, exactly like house-door.stl.
 *
 * The body is the extrusion (depth D, +y) of the gambrel gable profile. The front gable is built by
 * SLAB decomposition between z-breakpoints so the door notch and hayloft hole drop out cleanly; the
 * back gable is solid; the 7 profile edges extrude to the floor, two walls, and four roof panels.
 * Triangle winding is fixed to outward by flipping against the body centroid.
 *
 * Run:  node scripts/gen-barn.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- barn dimensions (unit scale, matching house.stl ~1) -----------------------------------------
const W = 1.3;          // width  (x)
const D = 1.7;          // depth  (y) — barns are deep
const HE = 0.6;         // eave height (top of the vertical walls)
const KX = 0.22, HK = 0.95;   // gambrel knuckle: inset KX, height HK (lower↔upper slope break)
const HR = 1.25;        // ridge height (roof peak, centred at x = W/2)
const DOOR = process.env.BARN_NO_DOOR ? null : { x0: 0.4, x1: 0.9, z1: 0.7 }; // big front door: a bottom NOTCH
// Hayloft opening is OFF by default: an interior hole makes the front gable an annulus, which the
// kirigamize `unfold` stage can't flatten without a cut joining the hole to the boundary (the door is
// fine because it is a boundary-connected notch). Set BARN_HAYLOFT=1 to include it (won't kirigamize).
const HAY = process.env.BARN_HAYLOFT ? { x0: 0.5, x1: 0.8, z0: 0.8, z1: 1.02 } : null;

// gambrel half-profile: left outline x as a function of height z (right edge is the mirror W − xL)
const lerp = (a, b, t) => a + (b - a) * t;
function xL(z) {
  if (z <= HE) return 0;                                 // vertical wall
  if (z <= HK) return lerp(0, KX, (z - HE) / (HK - HE)); // steep lower slope
  return lerp(KX, W / 2, (z - HK) / (HR - HK));          // shallow upper slope → ridge
}
const xR = (z) => W - xL(z);

const CENTER = [W / 2, D / 2, (HR + 0) / 2]; // body centroid (approx) for outward-normal flipping
const tris = [];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function addTri(a, b, c) {
  const n = cross(sub(b, a), sub(c, a));
  if (Math.hypot(...n) < 1e-9) return;               // skip degenerate (e.g. the ridge apex)
  const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  tris.push(dot(n, sub(mid, CENTER)) >= 0 ? [a, b, c] : [a, c, b]); // wind so the normal points outward
}
const quad = (a, b, c, d) => { addTri(a, b, c); addTri(a, c, d); };

// ---- front + back gable faces (slab decomposition) ----------------------------------------------
// Solid x-intervals in band [z0,z1]; each interval boundary is the outline (slanted) or a fixed cut.
function intervals(z0, z1, withOpenings) {
  const L = (z) => xL(z), R = (z) => xR(z);
  if (withOpenings && DOOR && z1 <= DOOR.z1 + 1e-9)                           // door band
    return [[L, () => DOOR.x0], [() => DOOR.x1, R]];
  if (withOpenings && HAY && z0 >= HAY.z0 - 1e-9 && z1 <= HAY.z1 + 1e-9)      // hayloft band
    return [[L, () => HAY.x0], [() => HAY.x1, R]];
  return [[L, R]];
}
const ZCUTS = [0, HE, HK, HR, ...(DOOR ? [DOOR.z1] : []), ...(HAY ? [HAY.z0, HAY.z1] : [])];
function gable(y, withOpenings) {
  const front = y === 0;
  // z breakpoints: ground, eave, knuckle, ridge + door-top + hayloft band edges
  const zs = [...new Set(ZCUTS.filter((z) => z >= 0 && z <= HR))].sort((p, q) => p - q);
  for (let i = 0; i + 1 < zs.length; i++) {
    const z0 = zs[i], z1 = zs[i + 1];
    for (const [Lb, Rb] of intervals(z0, z1, withOpenings)) {
      const a = [Lb(z0), y, z0], b = [Rb(z0), y, z0], c = [Rb(z1), y, z1], d = [Lb(z1), y, z1];
      // front faces look toward −y, back toward +y; addTri fixes the winding either way
      if (front) quad(a, b, c, d); else quad(b, a, d, c);
    }
  }
}
gable(0, true);   // front: door + hayloft openings
gable(D, false);  // back: solid

// ---- extruded profile edges → two walls + four roof panels (open bottom, like house-door.stl) ----
// Each wall/roof edge is SUBDIVIDED at the same z-breakpoints the gable slabs use, so every shared
// edge has matching vertices (no T-junctions); the bottom (floor) edge is omitted — an open shell.
const ZB = [...new Set(ZCUTS)].sort((p, q) => p - q);
const PROFILE = [[W, 0], [W, HE], [W - KX, HK], [W / 2, HR], [KX, HK], [0, HE], [0, 0]]; // right wall→roof→left wall (no floor edge)
for (let i = 0; i + 1 < PROFILE.length; i++) {
  const [x0, z0] = PROFILE[i], [x1, z1] = PROFILE[i + 1];
  const lo = Math.min(z0, z1), hi = Math.max(z0, z1);
  const cuts = [z0, ...ZB.filter((z) => z > lo + 1e-9 && z < hi - 1e-9), z1];
  if (z1 < z0) cuts.reverse(), cuts.sort((p, q) => q - p); // keep them ordered z0→z1
  cuts.sort((p, q) => (z1 >= z0 ? p - q : q - p));
  const pt = (z) => { const t = (z - z0) / (z1 - z0 || 1); return [x0 + (x1 - x0) * t, z]; };
  for (let k = 0; k + 1 < cuts.length; k++) {
    const [ax, az] = pt(cuts[k]), [bx, bz] = pt(cuts[k + 1]);
    quad([ax, 0, az], [bx, 0, bz], [bx, D, bz], [ax, D, az]); // sub-edge extruded along +y
  }
}

// ---- write ASCII STL ----------------------------------------------------------------------------
const out = ["solid barn"];
for (const [a, b, c] of tris) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid barn");
const path = resolve(import.meta.dirname, "..", "public/examples/barn.stl");
writeFileSync(path, out.join("\n") + "\n");
console.log(`barn.stl: ${tris.length} facets → ${path}`);
console.log(`  gambrel barn ${W}×${D}×${HR} (eave ${HE}, knuckle ${KX}/${HK}, ridge ${HR}); ` +
  `${DOOR ? "front door" : "no door"}${HAY ? " + hayloft" : ""}`);
