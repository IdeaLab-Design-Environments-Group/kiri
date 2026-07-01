/**
 * Bell TOWER piece → public/examples/church-tower.stl: a tall narrow steep-gable tower (belfry walls +
 * a steep spire roof) that folds on its own and stands on the flat platform of church.stl. Unit scale,
 * ASCII STL, z-up. 2-piece companion to gen-church.mjs (a free-standing tower can't be part of a single
 * self-folding sheet, so the steeple is a separate fold-and-stack piece).
 *
 * Run:  node scripts/gen-church-tower.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- dimensions — sits on the nave's ~0.6-wide platform; tall + steep so it reads as a steeple ----
const W = 0.5, D = 0.5;           // tower footprint (square)
const HE = 1.05, HR = 1.85;       // tall belfry walls + steep spire ridge

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

// ---- tower massing: floor + four walls/gable-ends + two roof slopes (steep spire) ----------------
quad([0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]);
quad([0, 0, 0], [0, 0, HE], [0, D, HE], [0, D, 0]);
quad([W, 0, 0], [W, D, 0], [W, D, HE], [W, 0, HE]);
const gable = [[0, 0], [W, 0], [W, HE], [W / 2, HR], [0, HE]];
gXZ(gable, 0);
gXZ(gable, D);
quad([0, 0, HE], [W / 2, 0, HR], [W / 2, D, HR], [0, D, HE]);
quad([W / 2, 0, HR], [W, 0, HE], [W, D, HE], [W / 2, D, HR]);

const oriented = orientOutward(tris);
const out = ["solid church-tower"];
for (const [a, b, c] of oriented) {
  let n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
  out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
    `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`,
    "endloop", "endfacet");
}
out.push("endsolid church-tower");
writeFileSync(resolve(import.meta.dirname, "..", "public/examples/church-tower.stl"), out.join("\n") + "\n");
console.log(`church-tower.stl: ${oriented.length} facets — bell tower (${W}×${D}×${HR}); stands on church.stl's platform`);
