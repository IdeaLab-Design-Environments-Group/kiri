/**
 * Old-West false-front GENERAL STORE → public/examples/general-store.stl, a kirigamizable low-poly
 * solid in the same family as house.stl / barn.stl / hotel.stl (unit scale, ASCII STL, z-up, open
 * bottom shell). The signature of a boomtown general store is the **ARCHED false front**: the front
 * wall rises into a curved parapet (a segmental arch) above the storefront, the "GENERAL STORE" sign
 * board. Behind it sits a lower flat roof; a central DOOR is a boundary notch in the storefront.
 *
 * Build: the parapet top is a broad ROUND segmental arch a(x) — a true circular arc fitted through
 * the two springpoints (SHW,SH)/(W-SHW,SH) and the centre peak (W/2,PK), with small flat shoulders at
 * the corners — so it reads as the rounded hood in the photo, not a faceted bump. The front facade +
 * the parapet's back face + the top ribbon are built on a dense x-grid to carry the curve; the roof,
 * back wall and the two ear-clipped end walls are flat. a(0)=a(W)=SH, so the arch springs cleanly from
 * the end walls. A flood-fill pass gives one consistent (orientable) winding. Open bottom, like the others.
 *
 * Run:  node scripts/gen-general-store.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- dimensions (unit scale) --------------------------------------------------------------------
const W = 1.5;   // width (x)
const D = 1.2;   // depth (y); front wall y=0, back wall y=D
const HE = 0.95; // eave / flat-roof height behind the false front
const SH = 1.12; // parapet shoulder / springline height (the arch springs from here)
const PK = 1.56; // parapet arch peak height (centre)
const PT = 0.12; // parapet thickness (front strip depth that rises above the roof)
const DOOR = { x0: 0.6, x1: 0.92, z: 0.58 }; // central door: notch in the storefront's bottom edge
const SHW = 0.13; // flat shoulder width at each top corner before the arc springs
const NA = 26;    // arc segments (high, so the curve reads as a smooth round arc)

// The signature general-store top is a broad, ROUND segmental arch (a circular arc), not the
// shallow faceted bump of before. Small flat shoulders at the corners, then a true circular arc
// fitted through the two springpoints (SHW, SH)/(W-SHW, SH) and the centre peak (W/2, PK).
const XA0 = SHW, XA1 = W - SHW;          // the arc spans [XA0, XA1]
const C = (XA1 - XA0) / 2;               // arc chord half-width
const S = PK - SH;                       // arc rise (sagitta)
const RAD = (C * C + S * S) / (2 * S);   // radius of the circle through the three points
const XC = W / 2, ZC = PK - RAD;         // circle centre
const arch = (x) => (x <= XA0 || x >= XA1) ? SH : ZC + Math.sqrt(Math.max(0, RAD * RAD - (x - XC) ** 2));

// x-stations carrying the curve: corner, springpoint, the arc samples, springpoint, corner.
const xs = [0, XA0];
for (let i = 1; i < NA; i++) xs.push(XA0 + ((XA1 - XA0) * i) / NA);
xs.push(XA1, W);
const N = xs.length - 1;
const A = xs.map(arch);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const CENTER = [W / 2, D / 2, HE / 2];
const tris = [];
function addTri(a, b, c) {
  const n = cross(sub(b, a), sub(c, a));
  if (Math.hypot(...n) < 1e-12) return;
  const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  tris.push(dot(n, sub(m, CENTER)) >= 0 ? [a, b, c] : [a, c, b]); // wind so the normal points outward
}
const quad = (a, b, c, d) => { addTri(a, b, c); addTri(a, c, d); };

// ---- ear clipping for the two end-wall profiles (re-used from the barn/hotel generators) ---------
function earClip(poly) {
  const n = poly.length, idx = [...Array(n).keys()], out = [];
  const ar = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  let S = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; S += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1]; }
  if (S < 0) idx.reverse();
  const inT = (p, a, b, c) => { const d1 = ar(a, b, p), d2 = ar(b, c, p), d3 = ar(c, a, p); return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0))); };
  let g = 0;
  while (idx.length > 3 && g++ < 4000) {
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

// ---- FRONT FACADE (y = 0): storefront with a door notch, topped by the arch (x-z polygon) --------
const facade = [[0, 0], [DOOR.x0, 0], [DOOR.x0, DOOR.z], [DOOR.x1, DOOR.z], [DOOR.x1, 0], [W, 0]];
for (let i = N; i >= 0; i--) facade.push([xs[i], A[i]]); // right side (W,0)→(W,SH), arch over, down to (0,SH)
for (const [a, b, c] of earClip(facade)) {
  const P = (k) => [facade[k][0], 0, facade[k][1]];
  addTri(P(a), P(b), P(c));
}

// ---- PARAPET BACK (y = PT): the false front's rear face, from the roof up to the arch -----------
const pback = [[0, HE], [W, HE]];
for (let i = N; i >= 0; i--) pback.push([xs[i], A[i]]);
for (const [a, b, c] of earClip(pback)) {
  const P = (k) => [pback[k][0], PT, pback[k][1]];
  addTri(P(a), P(b), P(c));
}

// ---- PARAPET TOP ribbon (z = a(x), y 0..PT): the arched cap connecting facade-top to pback-top ---
for (let i = 0; i < N; i++) {
  quad([xs[i], 0, A[i]], [xs[i + 1], 0, A[i + 1]], [xs[i + 1], PT, A[i + 1]], [xs[i], PT, A[i]]);
}

// ---- ROOF (z = HE, y PT..D), BACK WALL (y = D) --------------------------------------------------
quad([0, PT, HE], [W, PT, HE], [W, D, HE], [0, D, HE]);
quad([0, D, 0], [W, D, 0], [W, D, HE], [0, D, HE]);

// ---- END WALLS (x = 0 and x = W): the side silhouette (open floor) ------------------------------
const sideProfile = [[0, 0], [0, SH], [PT, SH], [PT, HE], [D, HE], [D, 0]]; // (y,z); floor edge open
const sideTris = earClip(sideProfile);
for (const x of [0, W]) for (const [a, b, c] of sideTris) {
  const P = (k) => [x, sideProfile[k][0], sideProfile[k][1]];
  addTri(P(a), P(b), P(c));
}

// ---- consistent winding (flood-fill + majority-outward flip) ------------------------------------
// The per-face CENTER heuristic mis-winds the concave parapet-back / arch faces, leaving the mesh
// non-orientable (the conditioning pass rejects that). Propagate one consistent winding across every
// shared edge, then flip the whole shell if most faces ended up facing inward.
function orientConsistent() {
  const ids = new Map();
  const key = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
  const vid = (p) => { const k = key(p); if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); };
  const T = tris.map((t) => [vid(t[0]), vid(t[1]), vid(t[2])]);
  const ek = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const edge = new Map();
  T.forEach((t, ti) => { for (const [u, v] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) { const k = ek(u, v); if (!edge.has(k)) edge.set(k, []); edge.get(k).push(ti); } });
  const dir = (ti) => { const t = T[ti]; return [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]; };
  const flip = (ti) => { [tris[ti][1], tris[ti][2]] = [tris[ti][2], tris[ti][1]]; [T[ti][1], T[ti][2]] = [T[ti][2], T[ti][1]]; };
  const seen = new Array(T.length).fill(false);
  for (let s = 0; s < T.length; s++) {
    if (seen[s]) continue; seen[s] = true; const q = [s];
    while (q.length) {
      const ti = q.pop();
      for (const [u, v] of dir(ti)) for (const tj of edge.get(ek(u, v))) {
        if (seen[tj]) continue;
        if (dir(tj).some(([a, b]) => a === u && b === v)) flip(tj); // same direction => inconsistent
        seen[tj] = true; q.push(tj);
      }
    }
  }
  let vote = 0;
  for (const [a, b, c] of tris) {
    const n = cross(sub(b, a), sub(c, a));
    const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    vote += dot(n, sub(m, CENTER)) >= 0 ? 1 : -1;
  }
  if (vote < 0) for (let ti = 0; ti < tris.length; ti++) flip(ti);
}
orientConsistent();

// ---- write ASCII STL ---------------------------------------------------------------------------
const out = ["solid general_store"];
for (const [a, b, c] of tris) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid general_store");
const path = resolve(import.meta.dirname, "..", "public/examples/general-store.stl");
writeFileSync(path, out.join("\n") + "\n");
console.log(`general-store.stl: ${tris.length} facets → ${path}`);
console.log(`  round false front ${W}×${D}, eave ${HE}, springline ${SH} → arc peak ${PK} (R=${RAD.toFixed(3)}), shoulders ${SHW}; central door`);
