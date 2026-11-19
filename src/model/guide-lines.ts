/**
 * **Model** — guide lines: drawn on the electronics canvas to line parts up against, never cut or scored.
 *
 * Two kinds: edges the author marked as guides in the pattern editor, and the pattern's own centre lines.
 */
import { flatPoints, type Vec2 } from "./electronics.js";
import type { FoldFile } from "./fold-file.js";

/** Per-edge guide flags, parallel to `edges_vertices`. Not `fkld:`, whose keys are registered upstream. */
export const GUIDE_KEY = "kiri:edges_guide";

export type Segment = [Vec2, Vec2];

/** The edges flagged as guides, in the pattern's flat coordinates. */
export function guideSegments(fold: FoldFile): Segment[] {
  const flags = fold[GUIDE_KEY];
  const edges = fold.edges_vertices;
  if (!Array.isArray(flags) || !Array.isArray(edges)) return [];
  const pts = flatPoints(fold);
  const out: Segment[] = [];
  edges.forEach((e, i) => {
    const a = pts[e?.[0]], b = pts[e?.[1]];
    if (flags[i] === true && a && b) out.push([a, b]);
  });
  return out;
}

/** A vertical and a horizontal line through the middle of the polygons' bounding box. */
export function centreLines(polys: Vec2[][]): Segment[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys.flat()) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  if (!(x1 > x0 && y1 > y0)) return [];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return [[{ x: cx, y: y0 }, { x: cx, y: y1 }], [{ x: x0, y: cy }, { x: x1, y: cy }]];
}
