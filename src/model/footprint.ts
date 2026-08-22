/**
 * **Model** — reading the component library.
 *
 * `footprints.generated.ts` holds parts in the KiCad-derived representation: pads keyed by the name
 * the datasheet uses, each an SVG path about its own origin plus where that origin sits, in inches.
 * That is the right thing to store — it is what the source file says, losslessly — and the wrong thing
 * to compute with. This is the layer between.
 *
 * Two conversions live here and nowhere else. Inches become millimetres, because every other length in
 * the model is millimetres and a stray inch has already cost us a switch pitch. And a pad's outline
 * path becomes a box, because the router only ever asks how wide a pad is and how far apart two of
 * them sit — never what shape the corners are.
 */
import type { Footprint, Pad } from "./footprints.generated.js";

export type { Component, Footprint, Pad } from "./footprints.generated.js";

/** The library's unit. KiCad is millimetres, the representation divides by this, we multiply back. */
export const MM_PER_INCH = 25.4;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Box {
  w: number;
  h: number;
}

/** A pad carries copper only if it is on a copper layer — which is what tells a terminal from a hole. */
export function isTerminal(pad: Pad): boolean {
  return pad.layers.some((l) => l === "F.Cu" || l === "B.Cu");
}

/** The part's terminals, in pad-number order, as `[name, pad]`. */
export function terminals(fp: Footprint): [string, Pad][] {
  return Object.entries(fp)
    .filter(([, p]) => isTerminal(p))
    .sort((a, b) => a[1].index - b[1].index);
}

/** The part's mechanical holes — the pegs it seats on, which we cut but never wire. */
export function holes(fp: Footprint): Pad[] {
  return Object.values(fp)
    .filter((p) => !isTerminal(p) && p.drill !== undefined)
    .sort((a, b) => a.index - b.index);
}

/** A pad by the name its datasheet gives it. Throws rather than returning a silent zero. */
export function padNamed(fp: Footprint, name: string): Pad {
  const pad = fp[name];
  if (!pad) throw new Error(`no pad ${JSON.stringify(name)} — have ${Object.keys(fp).join(", ")}`);
  return pad;
}

/** Where a pad sits in the part, in millimetres. */
export function padAt(pad: Pad): Vec2 {
  return { x: pad.pos[0] * MM_PER_INCH, y: pad.pos[1] * MM_PER_INCH };
}

/**
 * The points of a pad's outline, in millimetres about its own origin.
 *
 * The path is only ever `M`/`L` — {@link ocaml/kicad.ml} emits nothing else, whatever shape the pad
 * started as — so this needs no curve handling. Numbers may be separated by spaces or commas.
 */
export function padPoints(pad: Pad): Vec2[] {
  const out: Vec2[] = [];
  const tokens = pad.shape.trim().split(/[\s,]+/).filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t !== "M" && t !== "L") continue;
    const x = Number(tokens[i + 1]);
    const y = Number(tokens[i + 2]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x: x * MM_PER_INCH, y: y * MM_PER_INCH });
    i += 2;
  }
  return out;
}

/** How big a pad is, in millimetres — the bounding box of its outline. */
export function padSize(pad: Pad): Box {
  const pts = padPoints(pad);
  if (pts.length === 0) return { w: 0, h: 0 };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** The widest any of a part's terminals is — what a rail has to be able to seat. */
export function widestTerminal(fp: Footprint): number {
  return Math.max(0, ...terminals(fp).map(([, p]) => Math.max(padSize(p).w, padSize(p).h)));
}

/** How much of the sheet a whole part covers, terminals and holes together, in millimetres. */
export function footprintSize(fp: Footprint): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pad of Object.values(fp)) {
    const at = padAt(pad);
    for (const p of padPoints(pad)) {
      minX = Math.min(minX, at.x + p.x);
      maxX = Math.max(maxX, at.x + p.x);
      minY = Math.min(minY, at.y + p.y);
      maxY = Math.max(maxY, at.y + p.y);
    }
  }
  if (!Number.isFinite(minX)) return { w: 0, h: 0 };
  return { w: maxX - minX, h: maxY - minY };
}
