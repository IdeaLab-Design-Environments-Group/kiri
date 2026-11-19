/**
 * **Model** — turning a flat pattern in its own plane, and the circuit laid on it with it.
 *
 * Angles are degrees, anticlockwise with y up (as the viewer draws it). The pattern turns about the centre
 * of its bounding box. Folded frames (`file_frames`) are left alone: turning the sheet does not change the
 * folded shape.
 */
import { flatPoints, type Circuit, type Vec2 } from "./electronics.js";
import type { FoldFile } from "./fold-file.js";

/** The middle of the flat pattern's bounding box. */
export function patternCentre(fold: FoldFile): Vec2 {
  const pts = flatPoints(fold);
  if (!pts.length) return { x: 0, y: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

/** `p` turned by `deg` about `c`. */
export function rotatePoint(p: Vec2, c: Vec2, deg: number): Vec2 {
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t), sin = Math.sin(t);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + cos * dx - sin * dy, y: c.y + sin * dx + cos * dy };
}

/** A copy of `fold` with its flat coordinates turned by `deg` about `c`. A z coordinate is kept. */
export function rotateFold(fold: FoldFile, deg: number, c: Vec2 = patternCentre(fold)): FoldFile {
  const coords = fold.vertices_coords;
  if (!Array.isArray(coords)) return { ...fold };
  return {
    ...fold,
    vertices_coords: coords.map((v) => {
      const p = rotatePoint({ x: v?.[0] ?? 0, y: v?.[1] ?? 0 }, c, deg);
      return v && v.length > 2 ? [p.x, p.y, ...v.slice(2)] : [p.x, p.y];
    }),
  };
}

/** A copy of `circuit` with every point it stores turned by `deg` about `c`. Face and gap indices need no change. */
export function rotateCircuit(circuit: Circuit, c: Vec2, deg: number): Circuit {
  const at = <T extends { x: number; y: number }>(o: T): T => ({ ...o, ...rotatePoint(o, c, deg) });
  const out: Circuit = { ...circuit };
  if (circuit.parts) {
    out.parts = circuit.parts.map((p) => ({ ...at(p), rot: ((((p.rot ?? 0) + deg) % 360) + 360) % 360 }));
  }
  if (circuit.resistors) out.resistors = circuit.resistors.map(at);
  if (circuit.switches) out.switches = circuit.switches.map(at);
  if (circuit.wires) {
    out.wires = circuit.wires.map((w) => ({ ...w, pts: w.pts.map((v) => (v.kind === "free" ? at(v) : v)) }));
  }
  return out;
}

/**
 * The smallest turn, in (−90, 90], that lays edge `edge` along the x or y axis. Null for an edge that does
 * not exist or has no length.
 */
export function edgeAlignAngle(fold: FoldFile, edge: number, axis: "x" | "y"): number | null {
  const ev = fold.edges_vertices?.[edge];
  if (!ev) return null;
  const pts = flatPoints(fold);
  const a = pts[ev[0]], b = pts[ev[1]];
  if (!a || !b || (a.x === b.x && a.y === b.y)) return null;
  const now = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const turn = (axis === "x" ? 0 : 90) - now;
  // An edge has no direction, so a half turn is the same edge: bring the turn into (−90, 90].
  let d = ((turn % 180) + 180) % 180;
  if (d > 90) d -= 180;
  return d;
}
