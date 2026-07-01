/**
 * BST orchestrator.
 *
 * - `bstUniform`: a uniform flat star tiling (no surface fit) — contracted crease pattern + planar
 *   expanded goal (P1).
 * - `bstSurfaceFit` / `bstFromMesh`: surface programming (P2) — fit the auxetic tiling so its
 *   deployed state drapes onto a target mesh. The flat uniform α-tiling is the crease pattern; the
 *   deployed state is the β0 tiling relaxed onto the surface (rigid tiles → faceted approximation,
 *   voids opening where curvature demands). Emitted as crease pattern + foldedForm so the 3D Sim
 *   deploys it.
 */
import type { FoldFile } from "../../model/fold-file.js";
import { parseMesh } from "../import.js";
import { condition } from "../conditioning.js";
import type { TriMesh, Vec2 } from "../types.js";
import { buildTiling } from "./star-tiling.js";
import { emitBstFkld } from "./emit-bst.js";
import { planarDomain, liftToPlane, makeProjector } from "./mesh-project.js";
import { relax, rigidEdges } from "./relax.js";
import { solveBars, placeEF3D } from "./bistable-bar.js";
import { DEFAULT_BST, type BstParams, type BstResult, type ResultBar } from "./types.js";
import { type Vec3 } from "../../core/vec3.js";

/** Build a uniform BST result: contracted crease pattern + planar-expanded deployment goal (P1). */
export function bstUniform(params: Partial<BstParams> = {}): { fkld: FoldFile; result: BstResult } {
  const p: BstParams = { ...DEFAULT_BST, ...params };
  const contracted = buildTiling(p, p.alpha);
  const expanded = buildTiling(p, p.beta0);
  const expandedCurved: Vec3[] = expanded.vertices.map((v) => ({ x: v.x, y: v.y, z: 0 }));
  const driven = contracted.vertices.map(() => true);
  const result: BstResult = { contracted, expandedCurved, driven, bars: [] };
  return { fkld: emitBstFkld(result, p), result };
}

const bboxOf = (vs: Vec2[]): { min: Vec2; max: Vec2 } => {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of vs) { minx = Math.min(minx, v.x); miny = Math.min(miny, v.y); maxx = Math.max(maxx, v.x); maxy = Math.max(maxy, v.y); }
  return { min: { x: minx, y: miny }, max: { x: maxx, y: maxy } };
};

export interface BstFitDiagnostics {
  residual: number;
  converged: boolean;
  scale: number;
}

/**
 * Surface-program a target mesh (P2 core, testable with a programmatic TriMesh).
 * Returns the FKLD, the BstResult, and relaxation diagnostics.
 */
export function bstSurfaceFit(
  mesh: TriMesh,
  params: Partial<BstParams> = {},
): { fkld: FoldFile; result: BstResult; diag: BstFitDiagnostics } {
  const p: BstParams = { ...DEFAULT_BST, ...params };
  const domain = planarDomain(mesh);
  const domainW = domain.max.x - domain.min.x, domainH = domain.max.y - domain.min.y;
  const domainC: Vec2 = { x: (domain.min.x + domain.max.x) / 2, y: (domain.min.y + domain.max.y) / 2 };

  // Scale the (uniform) tilings so the EXPANDED tiling fills the surface footprint (90% margin).
  const uni = buildTiling(p, p.beta0);
  const ub = bboxOf(uni.vertices);
  const ubW = ub.max.x - ub.min.x || 1, ubH = ub.max.y - ub.min.y || 1;
  const k = 0.9 * Math.min(domainW / ubW, domainH / ubH);
  const ubC: Vec2 = { x: (ub.min.x + ub.max.x) / 2, y: (ub.min.y + ub.max.y) / 2 };
  const fit = (v: Vec2): Vec2 => ({ x: (v.x - ubC.x) * k + domainC.x, y: (v.y - ubC.y) * k + domainC.y });

  // Contracted crease pattern: flat α tiling at the same physical (k) scale, centered on the domain.
  const contractedRaw = buildTiling(p, p.alpha);
  const cb = bboxOf(contractedRaw.vertices);
  const cbC: Vec2 = { x: (cb.min.x + cb.max.x) / 2, y: (cb.min.y + cb.max.y) / 2 };
  const contracted = {
    ...contractedRaw,
    vertices: contractedRaw.vertices.map((v) => ({ x: (v.x - cbC.x) * k, y: (v.y - cbC.y) * k })),
  };

  // Seed the deployed state: expanded tiling fitted to the footprint, lifted to the plane, projected onto the surface.
  const project = makeProjector(mesh);
  const seed: Vec3[] = uni.vertices.map((v) => project(liftToPlane(fit(v), domain.basis)).point);

  // Rigid edges (tile boundaries + diagonal) with rest lengths from the fitted expanded tiling.
  const fittedUni = uni.vertices.map(fit);
  const edges = rigidEdges(uni.tiles, fittedUni);
  const allVerts = uni.vertices.map((_v, i) => i);

  const r = relax(seed, edges, allVerts, project, { iters: p.relaxIters, damp: 0.1, tol: 1e-3 });
  const expandedCurved = r.positions;

  // Bistable bars: per void, local scale = deployed/contracted characteristic size → bar (or skip).
  const charLen2 = (ids: number[]): number => { const c = ids.map((id) => contracted.vertices[id]); const g = { x: c.reduce((s, q) => s + q.x, 0) / c.length, y: c.reduce((s, q) => s + q.y, 0) / c.length }; return c.reduce((m, q) => m + Math.hypot(q.x - g.x, q.y - g.y), 0) / c.length; };
  const charLen3 = (ids: number[]): number => { const c = ids.map((id) => expandedCurved[id]); const g = { x: c.reduce((s, q) => s + q.x, 0) / c.length, y: c.reduce((s, q) => s + q.y, 0) / c.length, z: c.reduce((s, q) => s + q.z, 0) / c.length }; return c.reduce((m, q) => m + Math.hypot(q.x - g.x, q.y - g.y, q.z - g.z), 0) / c.length; };
  const localScale = (i: number): number => { const ids = contracted.voids[i].corners; const cl = charLen2(ids); return cl > 1e-9 ? charLen3(ids) / cl : 1; };
  const placed = solveBars(contracted, localScale, p.alpha, p.gamma, p.epsilon);
  const bars: ResultBar[] = placed
    .filter((b) => !b.skipped)
    .map((b) => {
      const ids = contracted.voids[b.voidIndex].corners;
      const { E, F } = placeEF3D(ids.map((id) => expandedCurved[id]), b.R, b.phi);
      return { corners: [ids[0], ids[1], ids[2], ids[3]] as [number, number, number, number], Ec: b.Ec, Fc: b.Fc, Ee: E, Fe: F };
    });

  const driven = contracted.vertices.map(() => true); // full kinematic morph to the surface
  const result: BstResult = { contracted, expandedCurved, driven, bars };
  return { fkld: emitBstFkld(result, p), result, diag: { residual: r.residual, converged: r.converged, scale: k } };
}

/** P2 entry: surface-program a loaded mesh (OBJ/STL text). */
export function bstFromMesh(text: string, ext: "obj" | "stl", params: Partial<BstParams> = {}): { fkld: FoldFile; result: BstResult; diag: BstFitDiagnostics } {
  const parsed = parseMesh(text, ext);
  const { mesh } = condition(parsed);
  return bstSurfaceFit(mesh, params);
}
