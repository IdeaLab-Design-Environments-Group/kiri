/**
 * Circular desk-lamp canopy — a kirigami target you can drop into Kirigamizer
 * (convert panel → open `lamp-dome.stl` → Kirigamize ▶ → 3D Sim → Circuit to
 * embed LEDs). Run: `node scripts/gen-lamp-dome.mjs`.
 *
 * Shape: a surface of revolution with a CONVEX, MONOTONE meridian (radius only
 * ever grows from the flat circular top down to the open base) — the profile
 * a closed-body kirigami needs to fold cleanly. The skirt is a quarter-ellipse
 * arc; the top is a flat disk (the "top" — a natural spot for a top LED ring or
 * a finial); the bottom stays OPEN so the canopy slips over the lamp.
 *
 * Tiling: rings are ANTIPRISM-stacked (each ring rotated half a step from its
 * neighbour) and triangulated along the shorter diagonal, so the whole dome is
 * a clean DIAMOND lattice of triangles. Each diamond = two coplanar tiles =
 * one tidy cell to seat an SMD LED, with the kirigami hinge gaps between tiles
 * letting the light bleed through. Coarse on purpose (big tiles, few facets).
 *
 * Tweak the PARAMS block to resize / re-facet.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- design parameters (millimetres) ----------------------------------------
const PARAMS = {
  baseRadius: 100, // half the canopy's mouth → 200 mm opening
  topRadius: 22, //  flat circular top → 44 mm cap
  height: 85, //     top-of-cap above the base plane (a low, wide desk-lamp dome)
  segments: 12, //   facets around (12-fold: clean diamond rings, easy 12-LED rings)
  bands: 6, //       latitude rings down the skirt (more = smoother dome)
};

/**
 * Build the lamp canopy mesh.
 * Meridian: a quarter-ellipse from the top edge (topRadius, height) to the base
 * (baseRadius, 0): r(α)=topRadius+(base−top)·sinα, z(α)=height·cosα, α:0→π/2.
 * Rings j=0..bands sample α = (π/2)·(j/bands); ring j is spun by a half-step
 * when j is odd (the antiprism offset that makes the diamonds).
 */
function lampDome({ baseRadius, topRadius, height, segments, bands }) {
  const v = [[0, 0, height]]; // 0 = flat-top centre
  const ring = []; // ring[j][i] = vertex index
  const dθ = (2 * Math.PI) / segments;
  for (let j = 0; j <= bands; j++) {
    ring[j] = [];
    const α = (Math.PI / 2) * (j / bands);
    const r = topRadius + (baseRadius - topRadius) * Math.sin(α);
    const z = height * Math.cos(α);
    const offset = (j % 2) * 0.5; // antiprism half-step on odd rings
    for (let i = 0; i < segments; i++) {
      const θ = (i + offset) * dθ;
      ring[j][i] = v.length;
      v.push([r * Math.cos(θ), r * Math.sin(θ), z]);
    }
  }

  const f = [];
  // flat-top disk: fan the top ring to the centre vertex
  for (let i = 0; i < segments; i++) f.push([0, ring[0][i], ring[0][(i + 1) % segments]]);
  // skirt bands: split each cell along its shorter diagonal → diamond lattice
  for (let j = 0; j < bands; j++) {
    for (let i = 0; i < segments; i++) {
      const a = ring[j][i], b = ring[j][(i + 1) % segments];
      const c = ring[j + 1][(i + 1) % segments], d = ring[j + 1][i];
      const ac = dist(v[a], v[c]), bd = dist(v[b], v[d]);
      if (ac <= bd) f.push([a, b, c], [a, c, d]);
      else f.push([a, b, d], [b, c, d]);
    }
  }
  return { v, f };
}

// --- mesh helpers (mirrors gen-sample-stl.mjs) ------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Outward-orient: flip any face whose normal points back toward the centroid.
const orient = ({ v, f }) => {
  const c = v.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((x) => x / v.length);
  return {
    v,
    f: f.map(([i, j, k]) => {
      const n = cross(sub(v[j], v[i]), sub(v[k], v[i]));
      const fc = [(v[i][0] + v[j][0] + v[k][0]) / 3 - c[0], (v[i][1] + v[j][1] + v[k][1]) / 3 - c[1], (v[i][2] + v[j][2] + v[k][2]) / 3 - c[2]];
      return dot(n, fc) >= 0 ? [i, j, k] : [i, k, j];
    }),
  };
};

function toStl(name, { v, f }) {
  const lines = [`solid ${name}`];
  for (const [i, j, k] of f) {
    const n = norm(cross(sub(v[j], v[i]), sub(v[k], v[i])));
    lines.push(`  facet normal ${n[0].toFixed(6)} ${n[1].toFixed(6)} ${n[2].toFixed(6)}`);
    lines.push("    outer loop");
    for (const idx of [i, j, k]) lines.push(`      vertex ${v[idx][0]} ${v[idx][1]} ${v[idx][2]}`);
    lines.push("    endloop", "  endfacet");
  }
  lines.push(`endsolid ${name}`, "");
  return lines.join("\n");
}

// --- emit -------------------------------------------------------------------
const mesh = orient(lampDome(PARAMS));
const stl = toStl("lampDome", mesh);
const pubPath = fileURLToPath(new URL("../public/examples/lamp-dome.stl", import.meta.url));
const distPath = fileURLToPath(new URL("../dist/examples/lamp-dome.stl", import.meta.url));
writeFileSync(pubPath, stl);
try { writeFileSync(distPath, stl); } catch { /* dist/ may not exist yet */ }
console.log(
  `wrote public/examples/lamp-dome.stl — ${mesh.v.length} verts, ${mesh.f.length} facets ` +
  `(Ø${PARAMS.baseRadius * 2}mm base, Ø${PARAMS.topRadius * 2}mm top, ${PARAMS.height}mm tall, ${PARAMS.segments}×${PARAMS.bands} diamonds)`,
);
