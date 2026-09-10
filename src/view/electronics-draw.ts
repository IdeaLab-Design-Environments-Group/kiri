/**
 * **View helper** — the electronics canvas's pure layers: the sheet the copper is laid on, the carrier
 * frame, the ratsnest and the battery's terminals.
 *
 * Split out of `electronics-modal.ts` because every one of them is the same shape of thing — data in, SVG
 * paths out, no state read and none written — and because the sheet in particular is the one layer that
 * depends on which BUILD is selected. The modal decides what is on screen; this decides what it looks like.
 *
 * The two builds are different sheets, not two skins on one:
 *
 *  - **3D-printed** — rigid tiles with a bare hinge gap cut between them. The fabric backing shows through
 *    those gaps, and each gap is what a component bridges and what the crease strain is measured across.
 *  - **Vinyl** — one continuous sheet, scored at the creases with nothing cut away. The tiles ARE the
 *    faces, so drawing them would paint the sheet twice; the creases are drawn as score lines instead,
 *    because without a gap to show them a fold would be invisible, and a fold is not decoration here — it
 *    is what the copper is charged for crossing.
 *
 * Also home to the path-string helpers the whole canvas shares, since every one of them exists to turn a
 * point into the `d` of a path.
 */
import type { FlatFace, GapEdge, TilePoly, Vec2 } from "../model/electronics.js";
import type { Jump } from "../model/trace-types.js";
import type { SimMaterial } from "../sim/index.js";
import { sceneSvg, type SceneItem } from "./pcb-scene.js";

/** Three decimals: enough for a millimetre sheet, short enough that the markup stays readable. */
export const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0");
export const ptStr = (p: Vec2): string => `${fmt(p.x)} ${fmt(p.y)}`;
export const isZero = (p: Vec2): boolean => p.x === 0 && p.y === 0;

/** A closed path through `pts`, in whatever space they are already in. */
export function closedPath(pts: Vec2[]): string {
  return "M " + pts.map((p, k) => (k === 0 ? "" : "L ") + ptStr(p)).join(" ") + " Z";
}

/** An axis-aligned rectangle as a closed path — the carrier frame's outer edge and its window. */
export function rectPath(r: { x0: number; y0: number; x1: number; y1: number }): string {
  return closedPath([
    { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 },
  ]);
}

/** The average of a ring's corners — good enough to say which strip a small window sits in. */
export function centreOf(ring: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of ring) { x += p.x; y += p.y; }
  return { x: x / ring.length, y: y / ring.length };
}

/** Winding containment, matching the export's. */
export function inRing(p: Vec2, ring: Vec2[]): boolean {
  let w = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) w = !w;
  }
  return w;
}

/** The sheet under everything else, for the build on screen. `tp` is the modal's flat → canvas transform. */
export function substrateParts(
  material: SimMaterial,
  faces: FlatFace[],
  tiles: TilePoly[],
  gaps: GapEdge[],
  tp: (p: Vec2) => Vec2,
): string[] {
  const printed = material === "printed";
  const out: string[] = [];
  for (const f of faces) {
    if (f.poly.length < 3) continue;
    out.push(`<path d="${closedPath(f.poly.map(tp))}" class="${printed ? "el-cloth" : "el-sheet"}" />`);
  }
  if (printed) {
    for (const t of tiles) {
      if (t.ring.length < 3) continue;
      out.push(`<path d="${closedPath(t.ring.map(tp))}" class="el-tile" />`);
    }
    return out;
  }
  // Mountain and valley are drawn apart because they are priced apart: copper over a mountain is in
  // tension and cracks, over a valley it is in compression and does not.
  for (const g of gaps) {
    const kind = g.assignment === "M" ? "el-crease-m" : g.assignment === "V" ? "el-crease-v" : "el-crease-f";
    const [e0, e1] = g.ends;
    out.push(`<path d="M ${ptStr(tp(e0))} L ${ptStr(tp(e1))}" class="el-crease ${kind}" />`);
  }
  return out;
}

/** The carrier frame and its tabs — one piece of copper with every trace held inside it. */
export function carrierFrameParts(
  frame: { outer: { x0: number; y0: number; x1: number; y1: number }; window: { x0: number; y0: number; x1: number; y1: number } },
  tabPaths: Vec2[][],
  tabWidth: number,
): string[] {
  // Outer edge with the window as a hole, so it reads as a border rather than a filled sheet.
  const out = [
    `<path d="${rectPath(frame.outer)} ${rectPath(frame.window)}" class="el-carrier" fill-rule="evenodd" />`,
  ];
  for (const path of tabPaths) {
    if (path.length < 2) continue;
    const d = "M " + path.map((p, i) => (i === 0 ? "" : "L ") + ptStr(p)).join(" ");
    out.push(`<path d="${d}" class="el-carrier-tab" fill="none" stroke-width="${fmt(tabWidth)}" />`);
  }
  return out;
}

/**
 * The ratsnest: one line per connection the netlist asked for and the router could not lay.
 *
 * A net that lost a pad otherwise looks on the canvas exactly like one that did not — the only sign was a
 * count in the sidebar and a sentence in the status line, neither of which says WHERE.
 *
 * Drawn as `kind: "wire"`, which `pcb-scene.ts` reserves for previews and forbids for committed copper.
 * That is right here and the distinction matters: this is a connection that does not exist, it reaches no
 * cut file, and it must never read as tape. Hence dashed, and hence a stroked centreline rather than the
 * `stripOutline` every real run is drawn with.
 */
export function ratsnestParts(
  nets: { ratsnest?: [Vec2, Vec2][] }[] | undefined,
  tp: (p: Vec2) => Vec2,
): string[] {
  const rats: SceneItem[] = [];
  for (const n of nets ?? []) {
    for (const [a, b] of n.ratsnest ?? []) {
      rats.push({
        kind: "wire",
        d: `M ${ptStr(tp(a))} L ${ptStr(tp(b))}`,
        cls: "el-ratsnest",
        // One screen pixel, left to `vector-effect` in the stylesheet — a ratsnest is an annotation and
        // should not thin out as the pattern is zoomed away from.
        width: 1,
      });
    }
  }
  return rats.length ? [sceneSvg(rats)] : [];
}

/**
 * How a jump is drawn on the flat canvas, in sheet millimetres — the units {@link ratsnestParts} and
 * {@link batteryParts} already work in, since `tp` maps the pattern into the sheet the export uses.
 *
 * These are fixed rather than derived from the tape width, because none of the three is copper: the land
 * ring is a marker sitting ON the land, not the land itself (that is a {@link Trace2D} laid like any other
 * run), and the label has to stay readable beside a tape that may be a fraction of a millimetre wide. The
 * label size is the designator size `part-render.ts` sets, so `J1` reads as the same class of
 * annotation as `R1`.
 */
const JUMP_LAND_R = 0.9;
const JUMP_LABEL_SIZE = 1.5;
/** How far off the land the label sits: up and to the right, clear of the dashed link at either end. */
const JUMP_LABEL_OFF = 1.2;

// `jumpLabels` lives in `model/manual-jump.ts` so the cut files can label a jump too — the export may not
// import from `view/`. Re-exported here because the canvas is where it is called from.
export { jumpLabels } from "../model/manual-jump.js";

/**
 * A jump: the two solder lands, the link between them, and the label at both ends.
 *
 * Drawn as `kind: "wire"` for exactly the reason {@link ratsnestParts} is — this is a connection that does
 * not exist in the plane, reaches no cut file and must never read as tape. The difference from a ratsnest
 * is that a jump WILL exist once the sheet is folded, so it is drawn in its own colour rather than the
 * ratsnest's, and it is labelled: the author has to find the two ends again with a soldering iron.
 *
 * The lands themselves are copper and are NOT drawn here. They reach the canvas as ordinary
 * {@link Trace2D}s (`jumpLandTraces`), so the strips file, the carrier and the folded overlay need no
 * branch for them. The rings here only mark where they are.
 *
 * `labels` is index-aligned with `jumps` — {@link jumpLabels}'s output, passed in rather than recomputed so
 * the canvas and the export cannot disagree about which seam is `J1`.
 */
export function jumpParts(jumps: Jump[], labels: string[], tp: (p: Vec2) => Vec2): SceneItem[] {
  const out: SceneItem[] = [];
  for (const [i, j] of jumps.entries()) {
    const a = tp(j.a), b = tp(j.b);
    out.push({
      kind: "wire",
      d: `M ${ptStr(a)} L ${ptStr(b)}`,
      cls: "el-jump",
      // One screen pixel, left to `vector-effect` in the stylesheet, as the ratsnest's is.
      width: 1,
    });
    const label = labels[i] ?? "";
    for (const c of [a, b]) out.push({ kind: "dot", x: c.x, y: c.y, r: JUMP_LAND_R, cls: "el-jump-land" });
    for (const c of [a, b]) {
      out.push({
        kind: "text",
        x: c.x + JUMP_LABEL_OFF,
        y: c.y - JUMP_LABEL_OFF,
        size: JUMP_LABEL_SIZE,
        cls: "el-jump-label",
        value: label,
      });
    }
  }
  return out;
}

/**
 * The battery: two terminal squares — PWR (+) red and GND (−) dark — so each net leaves its own pad.
 *
 * `half` is the size the ROUTER settled on, which may be smaller than the wanted one where the tile is
 * tight: the drawn pad and the planned pad have to be the same pad.
 */
export function batteryParts(
  term: { pwr: Vec2; gnd: Vec2 },
  half: number,
  tp: (p: Vec2) => Vec2,
): string[] {
  const out: string[] = [];
  const square = (p: Vec2, cls: string, sign: string): void => {
    const c = tp(p);
    out.push(
      `<rect x="${fmt(c.x - half)}" y="${fmt(c.y - half)}" width="${fmt(2 * half)}" height="${fmt(2 * half)}" rx="${fmt(half * 0.22)}" class="${cls}" />`,
      `<text x="${fmt(c.x)}" y="${fmt(c.y)}" class="el-batt-sign" font-size="${fmt(half * 1.5)}">${sign}</text>`,
    );
  };
  square(term.gnd, "el-batt el-batt-gnd", "−");
  square(term.pwr, "el-batt el-batt-pwr", "+");
  return out;
}
