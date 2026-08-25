/**
 * **View** — what to draw, kept apart from how to draw it.
 *
 * kiri's electronics canvas is painted by one `draw()` that walks the fold, the routes and the parts while
 * concatenating SVG strings as it goes. Geometry and markup are interleaved there, so neither can be
 * tested without the other, and a change to how a strip of tape is written out means editing the code that
 * decides where the tape runs.
 *
 * svg-pcb splits the two: its views build a display list of drawable items and `js/views/drawPath.js`
 * renders each one by its kind. This file is that renderer, as a pure function — a {@link SceneItem} in,
 * a string out, no DOM anywhere. The geometry stays where it is; only the markup moves here.
 *
 * Two conventions are taken from svg-pcb and one is deliberately refused:
 *
 * - Filled geometry is `fill-rule="evenodd"`, so a ring inside a ring reads as a hole. kiri's tape painter
 *   already depends on this: an SPDT's idle throw needs bare pattern under it, and that window rides on
 *   the strip's own path rather than sitting on top of it.
 * - A stroked centreline gets round caps and round joins.
 * - Its per-`<text>` counter-flip (`transform="scale(1, -1)"`) is NOT adopted. svg-pcb works in a
 *   y-up world and flips each label back at draw time; kiri bakes its y-flip into the coordinates it
 *   hands over, and draws labels upright on purpose. Nothing here emits a transform.
 *
 * Colours are not this file's business. Every item names a CSS class and the stylesheet decides what it
 * looks like, which is what lets the palette change without touching the painter.
 *
 * Units are sheet millimetres, as in the cut files and the canvas itself.
 */

/**
 * One drawable thing.
 *
 * `wire` is for the PREVIEW rubber band ONLY — the trace being dragged out, before it is committed.
 * Committed copper is never a stroked centreline: it is drawn as the outline that will actually be cut,
 * via `stripOutline` in `../model/copper-svg-export.js`. The difference is not cosmetic. A stroke at a
 * constant width hides the narrowing that keeps two nets apart under a chip, and its round caps draw
 * copper past the end of the run that the blade will not cut — so the canvas would show a circuit that
 * the cut file does not contain.
 */
export type SceneItem =
  | { kind: "poly"; d: string; cls: string; evenodd?: boolean }
  | { kind: "wire"; d: string; cls: string; width: number }
  | { kind: "text"; x: number; y: number; size: number; cls: string; value: string }
  | { kind: "dot"; x: number; y: number; r: number; cls: string };

/**
 * A whole canvas, keyed by layer and painted in the order the fields are declared — kiri's physical stack.
 *
 * The order is what the drawing means, not a preference: cloth is the fabric everything sits on, the rigid
 * tiles are inset into it, copper tape is laid over the tiles, the parts are fitted onto the tape, and the
 * marks — selection rings, orphan rings — are annotations that must stay legible over all of it.
 */
export interface Scene {
  cloth: SceneItem[];
  tiles: SceneItem[];
  copper: SceneItem[];
  parts: SceneItem[];
  marks: SceneItem[];
}

/** The layers, in paint order. Named once so the order cannot drift from {@link Scene}'s. */
const LAYERS: (keyof Scene)[] = ["cloth", "tiles", "copper", "parts", "marks"];

/**
 * A number as the canvas writes it: three decimals, and never `NaN`.
 *
 * This is `electronics-modal.ts`'s `fmt`, kept in step with it deliberately so a scene can be diffed
 * byte-for-byte against what `draw()` emits today. That one is module-private, so it cannot be imported —
 * and it must not be confused with `part-render.ts`'s `fmt`, which rounds to FOUR decimals because it
 * writes cut files rather than a screen. Two different jobs, two different roundings.
 */
export function fmt(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0";
}

/** A point in a path's `d`, as the canvas writes it. */
export function ptStr(p: { x: number; y: number }): string {
  return `${fmt(p.x)} ${fmt(p.y)}`;
}

/** Text goes into an XML document, so it is escaped — a pad name or a designator is not ours to trust. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** One item as SVG. Attribute order follows the canvas's own, so the output can be compared to it. */
function itemSvg(it: SceneItem): string {
  switch (it.kind) {
    case "poly":
      // `fill-rule` only when it is asked for: a solid face has no holes, and writing the attribute anyway
      // would put a difference in every line of a diff against today's canvas.
      return `<path d="${it.d}" class="${it.cls}"${it.evenodd ? ` fill-rule="evenodd"` : ""} />`;
    case "wire":
      // Preview only — see the note on {@link SceneItem}.
      return (
        `<path d="${it.d}" class="${it.cls}" fill="none" ` +
        `stroke-linecap="round" stroke-linejoin="round" stroke-width="${fmt(it.width)}" />`
      );
    case "text":
      // Upright, with no transform. The y-flip is already in `x`/`y`.
      return (
        `<text x="${fmt(it.x)}" y="${fmt(it.y)}" class="${it.cls}" ` +
        `font-size="${fmt(it.size)}">${esc(it.value)}</text>`
      );
    case "dot":
      return `<circle cx="${fmt(it.x)}" cy="${fmt(it.y)}" r="${fmt(it.r)}" class="${it.cls}" />`;
  }
}

/** A list of items as one SVG fragment, in the order given. */
export function sceneSvg(items: SceneItem[]): string {
  return items.map(itemSvg).join("");
}

/**
 * A whole scene: every layer, in stack order, concatenated.
 *
 * An empty layer contributes nothing at all — not an empty group. The canvas is repainted on every edit
 * and on every wheel tick, and a wrapper that exists only to hold nothing is a node the browser still has
 * to make. It would also show up in a diff against today's output, which emits no per-layer group.
 */
export function sceneLayers(s: Scene): string {
  return LAYERS.map((k) => sceneSvg(s[k])).join("");
}

/** An empty scene, to build into. */
export function emptyScene(): Scene {
  return { cloth: [], tiles: [], copper: [], parts: [], marks: [] };
}
