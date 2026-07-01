/**
 * Kirigamized house / house-door → printable STLs in the CONNECTED printed joinery (the same
 * structure as `kirigamish_parachuteish_180mm.stl`, and the same `printed-joinery.ts` the app's STL
 * export and 3D-Sim render now use).
 *
 *   public/examples/{house,house-door}.stl  (input solids)
 *     → parseMesh → kirigamize → FKLD (flat crease pattern + foldedForm 3D shape)
 *     → for each: a FLAT printable sheet and a FOLDED gallery body, same topology.
 *
 * The joinery (merge at every fold, recede + wall only at "C" cuts, corners full as pivots) lives in
 * `src/model/printed-joinery.ts`; this script just supplies layout coords + per-edge roles and writes
 * ASCII STL. The FLAT sheet is the print (a watertight 2-manifold apart from cut pivots); the FOLDED
 * body offsets each face along its own normal (a gallery render, not a print).
 *
 * Run:  npx vite-node scripts/gen-house-door.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseMesh } from "../src/pipeline/import.js";
import { kirigamize } from "../src/pipeline/kirigamize.js";
import { buildFoldableJoinery, edgeRole, type EdgeRole, type V3 } from "../src/model/printed-joinery.js";
import { TILE_INSET_FRAC } from "../src/model/tile-subdiv.js";

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---- tunables (mm) ----------------------------------------------------------------------------
const TILE_T = 1.6; // rigid tile thickness (the brick height v_top = v + t·n)
const GAP = TILE_INSET_FRAC; // pinch depth: each non-boundary edge midpoint pulls in by GAP·inradius·2 (sim "Gap")
const FLAT_SIZE = 130; // longest bbox dim of the printable flat sheet
const FOLDED_SIZE = 70; // longest bbox dim of the folded gallery body

const root = resolve(import.meta.dirname, "..");
const ekey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

function emitAssembly(
  fkld: Record<string, unknown>,
  srcCoords: V3[],
  target: number,
  layout: "flat" | "folded",
  outName: string,
): { facets: number; tiles: number; cuts: number; folds: number; boundary: number; nonManifoldEdges: number; volume: number } {
  const faces = (fkld.faces_vertices as number[][]).map((f) => [f[0], f[1], f[2]] as [number, number, number]);
  const edgesV = fkld.edges_vertices as number[][];
  const edgesA = fkld.edges_assignment as string[];
  const assignOf = new Map<string, string>();
  edgesV.forEach((e, i) => assignOf.set(ekey(e[0], e[1]), edgesA[i]));
  const faceCount = new Map<string, number>();
  for (const f of faces) for (let i = 0; i < 3; i++) faceCount.set(ekey(f[i], f[(i + 1) % 3]), (faceCount.get(ekey(f[i], f[(i + 1) % 3])) ?? 0) + 1);
  const roleOf = (a: number, b: number): EdgeRole => edgeRole(assignOf.get(ekey(a, b)), faceCount.get(ekey(a, b)) ?? 1);

  // scale + recentre (x/y centred, z based at 0)
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const c of srcCoords) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], c[d]); hi[d] = Math.max(hi[d], c[d]); }
  const s = target / Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2] || 1);
  const P: V3[] = srcCoords.map((c) => [(c[0] - (lo[0] + hi[0]) / 2) * s, (c[1] - (lo[1] + hi[1]) / 2) * s, (c[2] - lo[2]) * s]);

  const out: string[] = [`solid ${outName}`];
  const edgeInc = new Map<string, number>();
  let vol6 = 0;
  const key3 = (p: V3): string => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`;
  const facet = (a: V3, b: V3, c: V3): void => {
    const n = unit(cross(sub(b, a), sub(c, a)));
    out.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`, "outer loop",
      `vertex ${a[0]} ${a[1]} ${a[2]}`, `vertex ${b[0]} ${b[1]} ${b[2]}`, `vertex ${c[0]} ${c[1]} ${c[2]}`, "endloop", "endfacet");
    vol6 += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    for (const [u, w] of [[key3(a), key3(b)], [key3(b), key3(c)], [key3(c), key3(a)]] as const) {
      const k = u < w ? `${u}|${w}` : `${w}|${u}`;
      edgeInc.set(k, (edgeInc.get(k) ?? 0) + 1);
    }
  };

  let cuts = 0, folds = 0, boundary = 0;
  for (const [a, b, c] of faces) for (const [u, w] of [[a, b], [b, c], [c, a]] as const) {
    const r = roleOf(u, w); (r === "cut" ? cuts++ : r === "merge" ? folds++ : boundary++);
  }
  const vs = buildFoldableJoinery(faces, P, roleOf, { thickness: TILE_T, gap: GAP, layout });
  for (let i = 0; i + 2 < vs.length; i += 3) facet(vs[i], vs[i + 1], vs[i + 2]);
  out.push(`endsolid ${outName}`);
  writeFileSync(resolve(root, "public/examples", `${outName}.stl`), out.join("\n") + "\n");

  let nonManifold = 0;
  for (const inc of edgeInc.values()) if (inc !== 2) nonManifold++;
  const facets = out.filter((l) => l.startsWith("facet")).length;
  return { facets, tiles: faces.length, cuts: cuts / 2 | 0, folds: folds / 2 | 0, boundary, nonManifoldEdges: nonManifold, volume: vol6 / 6 };
}

for (const name of ["house", "house-door", "barn", "hotel", "general-store", "saloon", "church", "corner-saloon"] as const) {
  try {
    const mesh = parseMesh(readFileSync(resolve(root, `public/examples/${name}.stl`), "utf8"), "stl");
    const fkld = kirigamize(mesh, { lambda: name === "corner-saloon" ? 2 : 0 }).fkld as Record<string, unknown>;
    writeFileSync(resolve(root, "public/examples", `${name}.fkld`), JSON.stringify(fkld));
    const flatCoords = (fkld.vertices_coords as number[][]).map((c): V3 => [c[0], c[1], c[2] ?? 0]);
    const foldedCoords = ((fkld.file_frames as Record<string, unknown>[])[0].vertices_coords as number[][]).map((c): V3 => [c[0], c[1], c[2] ?? 0]);

    const flat = emitAssembly(fkld, flatCoords, FLAT_SIZE, "flat", `${name}-kirigami-flat`);
    const folded = emitAssembly(fkld, foldedCoords, FOLDED_SIZE, "folded", `${name}-kirigami`);
    for (const [lbl, r, size] of [["flat  ", flat, FLAT_SIZE], ["folded", folded, FOLDED_SIZE]] as const) {
      console.log(
        `${name} ${lbl}: tiles=${r.tiles} folds(merge)=${r.folds} cut-seams=${r.cuts} boundary=${r.boundary} ` +
        `facets=${r.facets} non-manifold-edges=${r.nonManifoldEdges} vol=${r.volume.toFixed(0)}mm³  (${size}mm)`,
      );
    }
  } catch (e) {
    // A building that is not a developable foldable surface (e.g. a church with a roof-top cupola/spire)
    // can't kirigamize — skip it (it stays a display .stl) rather than crashing the whole town build.
    console.warn(`SKIP ${name}: cannot kirigamize — ${(e as Error).message.split("\n")[0]}`);
  }
}
console.log("wrote house/house-door kirigami flat + folded STLs + .fkld to public/examples/");
