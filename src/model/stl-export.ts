/**
 * STL export — the 3D-printed tiles, matched to the 3D-Sim render (`sim-canvas.ts`
 * `updatePrintedTiles`): one hexagonal prism per face `[A, mAB, B, mBC, C, mCA]`, corners full (the
 * pinpoint pivots where neighbouring tiles meet), every non-boundary edge midpoint pinched inward to
 * open the diamond (interior folds AND "C" cuts), boundary edges straight. The geometry is shared with
 * the house/door generator via `printed-joinery.ts`, so what you see in the sim is what you cut.
 *
 * Coordinates are the flat pattern `vertices_coords` (z = 0 base, extruded +height). The "Gap"
 * (`inset`) is the pinch depth (`gap·inradius·2`), kept in lock-step with the sim's Gap slider.
 */
import type { FoldFile } from "./fold-file.js";
import { buildFoldableJoinery, edgeRole, type EdgeRole, type V3 } from "./printed-joinery.js";
import { TILE_INSET_FRAC } from "./tile-subdiv.js";

export interface StlExport {
  filename: string;
  text: string;
  /** Tile height actually used (model units) — lets the menu prefill its input. */
  height: number;
  /** Model unit label for the menu (`frame_unit` when present, else "units"). */
  unit: string;
  /** Retained for the export menu's API; the connected joinery does not subdivide, so this is 0. */
  maxSubdiv: number;
}

/** Default tile height as a fraction of the flat bbox diagonal (≈ the sim's visual `TILE_THICK_FRAC`). */
const DEFAULT_HEIGHT_FRAC = 0.02;
/** Default printable sheet size (mm, longest flat-pattern dimension) — matches `gen-house-door.ts` FLAT_SIZE. */
export const DEFAULT_PRINT_SIZE = 130;
/** Default rigid tile thickness (mm) once scaled to a print size — matches `gen-house-door.ts` TILE_T. */
const DEFAULT_PRINT_THICKNESS = 1.6;

const edgeKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);

/**
 * Build the ASCII-STL export of the foldable printed-joinery (inset rigid tiles + thin hinge bridges).
 * `heightUnits` is the tile height in model units (null/≤0 → size-relative default); `maxSubdiv` is
 * accepted for API compatibility but unused; `inset` is the tile inset / hinge-gap width (null →
 * `TILE_INSET_FRAC`), kept in lock-step with the sim's Gap slider.
 *
 * `printSize` (mm) is the **opt-in** key to a printable export: the flat pattern from `kirigamize` is
 * at an arbitrary (often unit) scale and the viewer shows it fit-to-view, so the model carries no real
 * size — baking those raw coords yields a sub-millimetre, degenerate sheet. When `printSize` is given,
 * the pattern is scaled so its longest XY dimension is `printSize` and recentred (x/y centred, z based
 * at 0), and the height defaults to an absolute `DEFAULT_PRINT_THICKNESS` — exactly like
 * `scripts/gen-house-door.ts`, so "Tiles (STL)" reproduces the printable joinery sheet. Omitted (tests)
 * → no scaling, model-unit output. Null if there are no faces.
 */
export function buildStlExport(
  fold: FoldFile,
  baseName = "kirigami",
  heightUnits?: number | null,
  _maxSubdiv?: number | null,
  inset?: number | null,
  printSize?: number | null,
): StlExport | null {
  const faces = fold.faces_vertices;
  if (!Array.isArray(faces) || faces.length === 0) return null;
  const coords = fold.vertices_coords; // flat pattern; vert() reads z = c[2] ?? 0
  if (!Array.isArray(coords) || coords.length === 0) return null;

  const vert = (i: number): V3 => {
    const c = coords[i] ?? [];
    return [Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0];
  };

  // flat-pattern coords; scale to the requested print size (mm) and recentre when asked (else raw units)
  let coordsXYZ: V3[] = coords.map((_c, i) => vert(i));
  const scaled = printSize != null && printSize > 0;
  if (scaled) {
    let xl = Infinity, xh = -Infinity, yl = Infinity, yh = -Infinity;
    for (const c of coordsXYZ) { xl = Math.min(xl, c[0]); xh = Math.max(xh, c[0]); yl = Math.min(yl, c[1]); yh = Math.max(yh, c[1]); }
    const span = Math.max(xh - xl, yh - yl) || 1;
    const s = printSize / span, cx = (xl + xh) / 2, cy = (yl + yh) / 2;
    coordsXYZ = coordsXYZ.map((c): V3 => [(c[0] - cx) * s, (c[1] - cy) * s, c[2] * s]);
  }

  const h = heightUnits != null && heightUnits > 0
    ? heightUnits
    : scaled ? DEFAULT_PRINT_THICKNESS : DEFAULT_HEIGHT_FRAC * bboxDiagonal(coords);
  const unit = scaled ? "mm" : typeof fold.frame_unit === "string" && fold.frame_unit ? fold.frame_unit : "units";
  const gap = inset != null && inset > 0 ? inset : TILE_INSET_FRAC;

  // edge → assignment + how many faces share it (→ role: cut / boundary / merge)
  const assignOf = new Map<string, string>();
  const ev = fold.edges_vertices, ea = fold.edges_assignment;
  if (Array.isArray(ev) && Array.isArray(ea)) ev.forEach((e, i) => assignOf.set(edgeKey(e[0], e[1]), String(ea[i])));
  const faceCount = new Map<string, number>();
  for (const face of faces) {
    if (!Array.isArray(face) || face.length < 3) continue;
    for (let k = 0; k < face.length; k++) faceCount.set(edgeKey(face[k], face[(k + 1) % face.length]), (faceCount.get(edgeKey(face[k], face[(k + 1) % face.length])) ?? 0) + 1);
  }
  const roleOf = (a: number, b: number): EdgeRole => edgeRole(assignOf.get(edgeKey(a, b)), faceCount.get(edgeKey(a, b)) ?? 1);

  // fan n-gons to triangles (inner fan edges are interior → never a real cut/boundary)
  const tris: number[][] = [];
  faces.forEach((face) => {
    if (!Array.isArray(face) || face.length < 3) return;
    for (let k = 1; k + 1 < face.length; k++) tris.push([face[0], face[k], face[k + 1]]);
  });

  const vs = buildFoldableJoinery(tris, coordsXYZ, roleOf, { thickness: h, gap, layout: "flat" });
  const out: string[] = [`solid ${baseName}`];
  for (let i = 0; i + 2 < vs.length; i += 3) writeFacet(out, vs[i], vs[i + 1], vs[i + 2]);
  out.push(`endsolid ${baseName}`);
  return { filename: `${baseName}.stl`, text: out.join("\n") + "\n", height: h, unit, maxSubdiv: 0 };
}

function bboxDiagonal(coords: number[][]): number {
  let xl = Infinity, xh = -Infinity, yl = Infinity, yh = -Infinity;
  for (const c of coords) {
    const x = Number(c[0]) || 0, y = Number(c[1]) || 0;
    xl = Math.min(xl, x); xh = Math.max(xh, x);
    yl = Math.min(yl, y); yh = Math.max(yh, y);
  }
  const d = Math.hypot(xh - xl, yh - yl);
  return Number.isFinite(d) && d > 0 ? d : 1;
}

function writeFacet(out: string[], a: V3, b: V3, c: V3): void {
  const n = normal(a, b, c);
  out.push(`  facet normal ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])}`);
  out.push("    outer loop");
  out.push(`      vertex ${fmt(a[0])} ${fmt(a[1])} ${fmt(a[2])}`);
  out.push(`      vertex ${fmt(b[0])} ${fmt(b[1])} ${fmt(b[2])}`);
  out.push(`      vertex ${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}`);
  out.push("    endloop");
  out.push("  endfacet");
}

function normal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "0");
