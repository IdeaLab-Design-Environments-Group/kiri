/**
 * Windmill input solid → public/examples/windmill.stl, a kirigamizable low-poly solid in the same
 * family as house.stl / barn.stl (unit scale, ASCII STL, z-up). A classic Dutch tower mill:
 *   • a TAPERED OCTAGONAL TOWER (8 developable trapezoid faces, wider at the base),
 *   • a CONICAL CAP (8-triangle octagonal pyramid) on top,
 *   • a DOOR at the base (a boundary-connected notch in the front face, like barn.stl), and
 *   • the iconic FOUR SAILS — a "+" of flat blades on a hub standing off the front (SAILS=1).
 *
 * Tower + cap + door kirigamize cleanly (developable frustum + cone + notch). The sails are thin
 * appendages joined only at the hub; like the barn hayloft they may not unfold, so they are OFF by
 * default (SAILS=1 to include the solid). Open bottom (a shell), exactly like house/barn.
 *
 * Run:  node scripts/gen-windmill.mjs   (or  SAILS=1 node scripts/gen-windmill.mjs)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const N = 8;            // octagonal tower
const RB = 0.42;        // base radius (slender, like the La Mancha photo — so the big sails clear it)
const RT = 0.34;        // top radius (slight taper)
const HT = 1.2;         // tower height (eave)
const HC = 0.34;        // cap height above the eave (apex)
const DOOR = { s0: 0.34, s1: 0.66, t1: 0.42 }; // door notch on the front face: width [s0,s1], up to height t1
// Output modes:
//   default     → the WHOLE windmill, like the photo, ALL IN ONE file: tower + cap + door + a real 3D
//                 X-sail rotor mounted on the front axle → windmill.stl. (Kirigamizing folds the tower;
//                 the rotor is the rigid spinning part — it can't be one foldable surface with the tower.)
//   SPINNER=1   → just the rotor (hub + 4 pitched X-sails + axle peg) → windmill-spinner.stl (print/spin alone)
//   PLAIN=1     → tower + cap + door only → windmill.stl
//   FLATSAILS=1 → tower with sails fused flat so they fold WITH the kirigami (a cross/V) → windmill.stl
const SPINNER = !!process.env.SPINNER;
const SAILS_FLAT = !!process.env.FLATSAILS;
const MOUNT = !SPINNER && !SAILS_FLAT && !process.env.PLAIN; // default: mount the 3D X rotor (photo look)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const vadd3 = (...vs) => vs.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
const vsc = (v, s) => [v[0] * s, v[1] * s, v[2] * s];

// octagon ring: vertex k at angle so that ONE face is centred on −y (the front, for the door + sails)
const ring = (r, z) => Array.from({ length: N }, (_, k) => {
  const a = (-90 + 180 / N + (k * 360) / N) * Math.PI / 180;
  return [r * Math.cos(a), r * Math.sin(a), z];
});
const base = ring(RB, 0), top = ring(RT, HT), apex = [0, 0, HT + HC];

const tris = [];
const CENTER = [0, 0, HT * 0.5];
function addTri(a, b, c, ref = CENTER) {
  const n = cross(sub(b, a), sub(c, a));
  if (Math.hypot(...n) < 1e-9) return;
  const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  tris.push(dot(n, sub(mid, ref)) >= 0 ? [a, b, c] : [a, c, b]); // wind so the normal points away from ref
}
const quad = (a, b, c, d, ref) => { addTri(a, b, c, ref); addTri(a, c, d, ref); };

// front face index = the side whose outward normal points most in −y
let front = 0, best = Infinity;
for (let i = 0; i < N; i++) {
  const j = (i + 1) % N, m = lerp(base[i], base[j], 0.5);
  if (m[1] < best) { best = m[1]; front = i; }
}

// ---- tower: N tapered trapezoid faces (door carved on the front face) ---------------------------
for (let i = 0; i < N; i++) {
  const j = (i + 1) % N;
  const BL = base[i], BR = base[j], TR = top[j], TL = top[i];
  if (i === front) {
    // bilinear param P(s,t): s across the face (0=BL→1=BR), t up (0=bottom→1=top); extrapolates in-plane
    const P = (s, t) => lerp(lerp(BL, BR, s), lerp(TL, TR, s), t);
    const { s0, s1, t1 } = DOOR;
    // door-carved front: left + right strips with the doorway gap between, plus the strip above it
    quad(P(0, 0), P(s0, 0), P(s0, 1), P(0, 1));
    quad(P(s1, 0), P(1, 0), P(1, 1), P(s1, 1));
    quad(P(s0, t1), P(s1, t1), P(s1, 1), P(s0, 1));
    if (SAILS_FLAT) {
      // BLADES: a bold "X" sail cross (like the La Mancha photo) fused COPLANAR to the front, ALL ONE
      // PIECE so the blades fold up WITH the kirigami. Built as two diagonal bars unioned with the body
      // via a t-scanline (shared band edges → one connected mesh; arms extend past the silhouette).
      const tc = 0.78, mA = 1.7, wA = 0.14, tBot = 0.05, tTop = 1.72; // X centre, bar slope, half-width, span
      const cA = (t) => 0.5 + mA * (t - tc), cB = (t) => 0.5 - mA * (t - tc);
      const active = (t) => {                                   // solid s-intervals at height t
        const ints = [];
        if (t >= -1e-9 && t <= 1 + 1e-9) (t < t1 ? ints.push([0, s0], [s1, 1]) : ints.push([0, 1])); // body (− door)
        if (t >= tBot && t <= tTop) ints.push([cA(t) - wA, cA(t) + wA], [cB(t) - wA, cB(t) + wA]);    // 2 bars
        return ints;
      };
      const unite = (ints) => {
        if (!ints.length) return [];
        ints = ints.map((x) => x.slice()).sort((a, b) => a[0] - b[0]);
        const out = [ints[0]];
        for (let i = 1; i < ints.length; i++) { const L = out[out.length - 1]; if (ints[i][0] <= L[1] + 1e-9) L[1] = Math.max(L[1], ints[i][1]); else out.push(ints[i]); }
        return out;
      };
      const split = (U, pts) => U.flatMap(([lo, hi]) => {       // split intervals at silhouette s=0,1 (neighbour match)
        const cs = [lo, ...pts.filter((p) => p > lo + 1e-9 && p < hi - 1e-9), hi];
        return cs.slice(0, -1).map((s, i) => [s, cs[i + 1]]);
      });
      const E = [() => 0, () => 1, (t) => cA(t) - wA, (t) => cA(t) + wA, (t) => cB(t) - wA, (t) => cB(t) + wA];
      const bps = [0, t1, 1, tBot, tTop, tc];
      for (let p = 0; p < E.length; p++) for (let q = p + 1; q < E.length; q++) { // breakpoints where two boundaries cross
        const f0 = E[p](0), f1 = E[p](1), g0 = E[q](0), g1 = E[q](1), db = (f1 - f0) - (g1 - g0);
        if (Math.abs(db) > 1e-9) { const t = (g0 - f0) / db; if (t > tBot && t < tTop) bps.push(t); }
      }
      const B = [...new Set(bps.filter((t) => t >= -1e-6 && t <= Math.max(tTop, 1) + 1e-6).map((t) => +t.toFixed(6)))].sort((a, b) => a - b);
      for (let k = 0; k + 1 < B.length; k++) {
        const t0 = B[k], tu = B[k + 1], tm = (t0 + tu) / 2, body = tm >= 0 && tm <= 1;
        let U0 = unite(active(t0)), U1 = unite(active(tu));
        if (body) { U0 = split(U0, [0, 1]); U1 = split(U1, [0, 1]); }
        if (U0.length === U1.length) for (let i = 0; i < U0.length; i++) quad(P(U0[i][0], t0), P(U0[i][1], t0), P(U1[i][1], tu), P(U1[i][0], tu));
      }
    }
  } else {
    quad(BL, BR, TR, TL);
  }
}
// ---- conical cap: N triangles to the apex -------------------------------------------------------
for (let i = 0; i < N; i++) addTri(top[i], top[(i + 1) % N], apex, [0, 0, HT]);

// ---- proper spinner: a rigid rotor (hub + 4 pitched X-sails + axle peg) --------------------------
// Built as a union of primitives — a rotor prints rigid (not kirigamized), so overlapping primitives
// are fine for the slicer. Axis points out the front (−y); the back peg seats into the tower so it spins.
function box(C, U, V, W) { // U,V,W = half-extent vectors; normals wound outward (away from centre C)
  const c = (i, j, k) => vadd3(C, vsc(U, i), vsc(V, j), vsc(W, k));
  const F = [
    [c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1)], [c(-1, -1, -1), c(-1, 1, -1), c(-1, 1, 1), c(-1, -1, 1)],
    [c(-1, 1, -1), c(1, 1, -1), c(1, 1, 1), c(-1, 1, 1)], [c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)],
    [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)], [c(-1, -1, -1), c(1, -1, -1), c(1, 1, -1), c(-1, 1, -1)],
  ];
  for (const f of F) quad(f[0], f[1], f[2], f[3], C);
}
function cyl(C, A, r, hl, n = 12) { // octagon-ish prism along unit axis A
  const up = Math.abs(A[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = norm(cross(A, up)), e2 = norm(cross(A, e1));
  const ring = (s) => Array.from({ length: n }, (_, k) => {
    const a = 2 * Math.PI * k / n;
    return vadd3(C, vsc(A, s * hl), vsc(e1, r * Math.cos(a)), vsc(e2, r * Math.sin(a)));
  });
  const r0 = ring(-1), r1 = ring(1), cap0 = vadd3(C, vsc(A, -hl)), cap1 = vadd3(C, vsc(A, hl));
  for (let k = 0; k < n; k++) {
    const m = (k + 1) % n;
    quad(r0[k], r0[m], r1[m], r1[k], C); addTri(cap1, r1[k], r1[m], C); addTri(cap0, r0[m], r0[k], C);
  }
}
function buildSpinner(C, sc) {
  const A = [0, -1, 0], yhat = [0, 1, 0];                 // axis out the front; sails sweep the x-z plane
  cyl(C, A, 0.075 * sc, 0.05 * sc);                       // hub
  cyl(vadd3(C, [0, 0.2 * sc, 0]), yhat, 0.05 * sc, 0.22 * sc); // axle: runs deep into the tower → ONE solid
  const Lb = 0.52 * sc, wB = 0.15 * sc, tB = 0.022 * sc, p = 16 * Math.PI / 180;
  for (let k = 0; k < 4; k++) {                            // 4 sails in an X, each pitched like a fan blade
    const th = (45 + k * 90) * Math.PI / 180, r = [Math.cos(th), 0, Math.sin(th)], g = [-Math.sin(th), 0, Math.cos(th)];
    const gp = vadd3(vsc(g, Math.cos(p)), vsc(yhat, Math.sin(p)));   // pitched width axis
    const yp = vadd3(vsc(g, -Math.sin(p)), vsc(yhat, Math.cos(p)));  // pitched thickness axis
    box(vadd3(C, vsc(r, 0.06 * sc + Lb / 2)), vsc(r, Lb / 2), vsc(gp, wB / 2), vsc(yp, tB / 2));
  }
}
if (SPINNER) tris.length = 0;                              // spinner only — discard the tower
if (SPINNER) buildSpinner([0, 0, 0], 1.0);
else if (MOUNT) buildSpinner([0, -RT - 0.04, HT * 0.78], 1.0); // mount the 3D X rotor on the upper front

// ---- write ASCII STL ----------------------------------------------------------------------------
const out = ["solid windmill"];
for (const [a, b, c] of tris) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid windmill");
const file = SPINNER ? "windmill-spinner.stl" : "windmill.stl";
const path = resolve(import.meta.dirname, "..", "public/examples", file);
writeFileSync(path, out.join("\n") + "\n");
console.log(`${file}: ${tris.length} facets → ${path}`);
console.log(`  ${SPINNER ? "spinner rotor alone (hub + 4 pitched X-sails + axle peg)"
  : MOUNT ? `whole windmill, all in one: tower R ${RB}→${RT} h${HT} + cap + door + MOUNTED 3D X rotor`
  : `tower R ${RB}→${RT} h${HT} + cap ${HC} + door${SAILS_FLAT ? " + flat folding sails" : ""}`}`);
