/**
 * **View helper** — the drawings a placed part gets on the electronics canvas, and nothing else.
 *
 * Split out of `electronics-modal.ts` for the same reason `electronics-presenters.ts` and
 * `electronics-export.ts` were: the file was over its size budget, and none of this needed to be in it.
 * Every function here is a pure one — the part list in, SVG or geometry out — so what the canvas draws for
 * a part can be tested without standing up an editor or a DOM.
 *
 * The modal's own state arrives as a {@link PartDrawContext} rather than through `this`: `tp`, `scale` and
 * `frameFlipped` are the editor's, and passing them is the whole of what these functions know about it.
 *
 * Units follow the modal's: points arrive in flat-pattern units and are put through {@link
 * PartDrawContext.tp} at the last moment, exactly where they were before the move.
 */
import {
  type GapEdge,
  type Led,
  type Vec2,
  gapForLed,
} from "../model/electronics.js";
import {
  type ResistorShape,
  partShape,
  resistorShape,
  switchShape,
} from "../model/copper-svg-export.js";
import { freeSpan, type RoutedCircuit, type Trace2D } from "../model/electronics-routing.js";
import type { PlacedPart } from "../model/electronics.js";
import { footprintById } from "../model/library.js";
import type { Footprint } from "../model/footprint.js";
import { R_1206, SW_SPDT } from "../model/library.js";
import { PART_BY_ID, ledPart, ledPitch } from "./electronics-palette.js";
import { fmt, isZero } from "./electronics-draw.js";

/**
 * The smallest a selection ring may be drawn, in sheet millimetres.
 *
 * The ring is sized off the copper the part bridges, which is the right size for anything on a rail. It
 * is the wrong size for the smallest parts: an `LED_0603`'s pads are 0.8mm and its legs 1.5mm apart, so
 * a ring proportional to the part alone would be a dot inside the part rather than a mark around it.
 * The floor is what a 1206 LED's ring has always come out at, so nothing already on screen moves.
 */
const SELECT_RING_FLOOR_MM = 1.7;

/**
 * How much of the view a pad must be worth before its own name is written on it.
 *
 * Deliberately well above the point where the text is merely emittable. A pin name is written *inside* the
 * pad it names, so a barely-legible one is worse than none: it covers the copper, which is the thing the
 * drawing exists to show. The designator has no such problem — it sits beside the part in clear space — so
 * the two appear at different zooms, and this is the later of them.
 */
const PAD_LABEL_VIEW_FRACTION = 0.035;

/** The canvas width in pixels to assume when the element cannot say (a headless DOM, mostly). */
const CANVAS_PX = 900;

/**
 * How many screen pixels one "rendered millimetre" is taken to be.
 *
 * {@link partSvg} suppresses text below a floor expressed in rendered millimetres — the size the label
 * comes out at, not the size it is in the sheet — and `scale` is what tells it the two differ. On a screen
 * the honest conversion is about four pixels to the millimetre, but four pixels of text is not a word.
 * Eighteen is where, looking at the rendered canvas, a glyph stops being a smear and starts being a
 * character — at Fit on a whole sheet nothing is written at all, which is right, because there is nothing
 * there big enough to write on.
 */
const PX_PER_RENDERED_MM = 18;

/** A part in series on a rail as the canvas holds one, before its footprint is looked up. */
export interface PlacedSpan {
  component: string;
  a: Vec2;
  b: Vec2;
  flip?: boolean;
  source?: number;
}

/**
 * The editor state these drawings read, gathered once per repaint.
 *
 * Everything on it is something `ElectronicsModal` already had as a field or a method; it is here as data
 * so that none of this file has to know an editor exists — see the note at the top.
 */
export interface PartDrawContext {
  /** The pattern's hinges, for an LED whose pads the router never planned. */
  gaps: GapEdge[];
  /** The plan on the canvas: its LED pads, and the two legacy part lists it seats. */
  routed: RoutedCircuit;
  /** Library parts the router seated on a rail or stood free on a tile. */
  parts: PlacedSpan[];
  /** The circuit's LEDs, in the order they were placed. */
  leds: Led[];
  /** Flat-pattern point to canvas point — the modal's `tp`. */
  tp: (p: Vec2) => Vec2;
  /** Canvas units per flat-pattern unit — the modal's `scale()`. */
  scale: number;
  /** Whether the export frame is mirrored an odd number of times — the modal's `frameFlipped()`. */
  frameFlipped: boolean;
}

/**
 * A ring round the two ends a component bridges, big enough to sit outside it.
 *
 * One helper because it is one mark: the same circle whether it rings a part broken into a rail or an
 * LED sat on a hinge, differing only in the class. Sized off the component's own span, floored at
 * {@link SELECT_RING_FLOOR_MM} so the smallest parts still get a ring rather than a dot inside them.
 */
export function selectionRing(a: Vec2, b: Vec2, cls: string): string {
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const r = Math.max(Math.hypot(b.x - a.x, b.y - a.y) * 0.75, SELECT_RING_FLOOR_MM);
  return `<circle cx="${fmt(c.x)}" cy="${fmt(c.y)}" r="${fmt(r)}" class="${cls}" />`;
}

/**
 * Where an LED's two pads sit, in flat-pattern units, or null if its hinge is gone.
 *
 * The router's pads, when it has them, because those are the copper the part has to land on — and
 * polarity with them: `pwr` is whichever leg it put PWR on, which is where the anode goes.
 *
 * With no copper — an LED the router could not reach, or could not seat the part on — the part is drawn
 * at its OWN pitch, straddling the middle of the hinge. Not at the hinge's dents, which is what it used
 * to be: those are 5.8mm apart on `house.fkld` and an `LED_0603`'s legs are 1.5mm, so drawing it there
 * showed a part stretched to four times its length. The point of drawing the footprint at all is that
 * what is on the canvas is the part that gets fitted, and that has to hold when it is not routed too.
 */
export function ledPads(ctx: PartDrawContext, led: Led, i: number): { pwr: Vec2; gnd: Vec2 } | null {
  const gap = gapForLed(ctx.gaps, led);
  if (!gap) return null;
  const planned = ctx.routed.pads[i];
  if (planned && !isZero(planned.pwr) && !isZero(planned.gnd)) {
    return { pwr: planned.pwr, gnd: planned.gnd };
  }
  // Along the hinge's own two legs where they differ, so an unrouted LED lies the way a routed one on
  // that hinge would; across the shared edge where the hinge has pinched to nothing and they do not.
  let ax = gap.legA.x - gap.legB.x, ay = gap.legA.y - gap.legB.y;
  if (Math.hypot(ax, ay) < 1e-6) {
    const [e0, e1] = gap.ends;
    ax = -(e1.y - e0.y); ay = e1.x - e0.x;
  }
  const al = Math.hypot(ax, ay) || 1;
  ax /= al; ay /= al;
  // Flat-pattern units, not millimetres: everything this returns is put through `tp()`, which scales by
  // the print size. The half-pitch is the part's, in sheet millimetres, so it has to come back out of
  // that scale first — the old marker-sized fallback did not, and on `house.fkld`, where a millimetre of
  // sheet is a thirtieth of a pattern unit, it put the two pads 49mm apart on a 1.5mm part.
  const sep = ledPitch(ledPart(led).footprint) / 2 / (ctx.scale || 1);
  const mid = gap.point;
  return {
    pwr: { x: mid.x + ax * sep, y: mid.y + ay * sep },
    gnd: { x: mid.x - ax * sep, y: mid.y - ay * sep },
  };
}

/** A placed library part's drawn shape, in the sheet millimetres the canvas works in. */
export function partShapeOf(ctx: PartDrawContext, p: PlacedSpan): ResistorShape | null {
  const fp = PART_BY_ID.get(p.component)?.footprint;
  return fp ? partShape(fp, ctx.tp(p.a), ctx.tp(p.b), p.flip, ctx.frameFlipped) : null;
}

/**
 * Every part on the canvas, in the order the cut files take them, each with the footprint it is drawn
 * from. One list, because the designators have to be assigned across all of it at once: `R1` on the
 * canvas and `R2` in the file for the same part would be worse than no label at all.
 *
 * `resistors` and `switches` predate the library and carry no component id of their own, so they name
 * the part they have always been — the same two footprints the palette now places generically.
 */
export function drawnParts(
  ctx: PartDrawContext,
): { component: string; footprint: Footprint; shape: ResistorShape }[] {
  const out: { component: string; footprint: Footprint; shape: ResistorShape }[] = [];
  const add = (component: string, footprint: Footprint, shape: ResistorShape | null): void => {
    if (shape) out.push({ component, footprint, shape });
  };
  for (const r of ctx.routed.resistors) {
    // The same shape the cut files draw, so the canvas cannot drift from them.
    add("R_1206", R_1206, resistorShape(ctx.tp(r.a), ctx.tp(r.b), ctx.frameFlipped));
  }
  for (const w of ctx.routed.switches) {
    add("SW_SPDT", SW_SPDT, switchShape(ctx.tp(w.a), ctx.tp(w.b), w.flip, ctx.frameFlipped));
  }
  // And every other library part, drawn from its own footprint by the one generic shape — so a part the
  // library gains appears here with nothing added to this file.
  for (const p of ctx.parts) {
    const fp = PART_BY_ID.get(p.component)?.footprint;
    if (fp) add(p.component, fp, partShapeOf(ctx, p));
  }
  // And the LEDs, last — the same order the cut files take them in, so an LED numbered `LED1` here is
  // `LED1` in the file too. An LED is not a series part, but it is a two-pad part bridging a break like
  // any other, so `partShape`'s in-line form draws it: pad 1 on the PWR end, pad 2 on the GND end.
  //
  // No `flip` is passed, and that is not an omission. `flip` is which way round the part sits on a
  // break; an LED's anode always goes to PWR, and the author's turn has already been spent deciding
  // which of the hinge's two legs PWR is. Passing it again would turn the part a second time.
  ctx.leds.forEach((led, i) => {
    const pads = ledPads(ctx, led, i);
    if (!pads) return;
    const c = ledPart(led);
    add(c.id, c.footprint,
      partShape(c.footprint, ctx.tp(pads.pwr), ctx.tp(pads.gnd), undefined, ctx.frameFlipped));
  });
  return out;
}

/**
 * Whether a part's pads are big enough on screen to carry their own pin names.
 *
 * The canvas fits itself to the whole sheet, and a 1206 pad on an AKDE pattern is well under a percent
 * of it — a "1" written on that pad is a two-pixel smudge that hides the pad instead of naming it. So the
 * names are a zoom-in: they appear once a pad is worth a few percent of the view, by which point the
 * character inside it is comfortably a character. The designator comes back sooner, because it sits
 * beside the part rather than on it and nothing is lost behind it.
 */
export function padLabelsFit(sh: ResistorShape, viewW: number): boolean {
  return padMinOf(sh) >= viewW * PAD_LABEL_VIEW_FRACTION;
}

/**
 * Rendered units per sheet millimetre: how big a millimetre of the sheet actually comes out on screen.
 *
 * {@link partSvg} sizes its text from the pads and drops it when the result would be too small to read,
 * and this is what lets it know how small that is here. The canvas fits the whole sheet, so a millimetre
 * of a 380mm pattern is a couple of pixels and a pin name on a 1206 pad is a two-pixel smudge — the same
 * drawing that is perfectly legible in the cut file, which is printed at its real size. Zooming in raises
 * it, which is exactly when the names become worth showing.
 */
export function renderScale(svg: { clientWidth?: number }, viewW: number): number {
  const px = svg.clientWidth || CANVAS_PX;
  return px / Math.max(viewW, 1e-9) / PX_PER_RENDERED_MM;
}

/**
 * The smallest dimension of any of a part's pads, in the sheet millimetres the view is measured in.
 *
 * A lead is the pad's rectangle: a segment across the run, with a width along it. The smaller of those two
 * is what has to hold a character, so it is what decides whether a name fits on the pad.
 */
function padMinOf(sh: ResistorShape): number {
  let m = Infinity;
  for (const l of sh.leads) {
    m = Math.min(m, l.width, Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y));
  }
  return Number.isFinite(m) ? m : 0;
}

/**
 * The parts standing on the sheet, given the same `a`/`b` a seated part gets from the run it breaks.
 *
 * A seated part takes its segment from the copper: the router cuts a gap and hands back the two cut ends,
 * and every drawing and export downstream works from those. A free part has no run to take one from, so
 * one is made here from the place the author put it and the angle they turned it to — the part's own
 * `partFit.gap` long, centred on the drop point. That is the same length the rail would have removed for
 * it, so a part reads at the same size whether it is standing on the sheet or sitting in a rail.
 *
 * Built here rather than in the router because the router is not asked about these parts at all: it skips
 * them when it cuts rails, which is the whole point of `free`. Without this they would be placed, stored,
 * exported in the netlist — and invisible on the canvas, which is the worst of all the options.
 */
export function freeParts(
parts: PlacedPart[],
tapeW: number,
tapeMm: number,
): { component: string; a: Vec2; b: Vec2; flip?: boolean; source?: number }[] {
  const out: { component: string; a: Vec2; b: Vec2; flip?: boolean; source?: number }[] = [];
  parts.forEach((p, source) => {
    if (!p.free) return;
    const fp = footprintById(p.component);
    if (!fp) return; // a part the library no longer has, left undrawn rather than guessed at
    // The span comes from the router's own `freeSpan`, not from a copy of the arithmetic kept here. It
    // carries the in-line flip rule with it — see its docblock for what a local copy cost.
    const { a, b } = freeSpan(p, fp, tapeW, tapeMm);
    out.push({
      component: p.component,
      a, b,
      ...(p.flip === undefined ? {} : { flip: p.flip }),
      source,
    });
  });
  return out;
}

/** The nearest point on any run to `p` — where a resistor would break the copper. Either rail: a
 *  resistor in series limits the current the same on the way out as on the way back. */
export function nearestOnRail(
traces: Trace2D[],
p: Vec2,
): { point: Vec2; dist: number; rot: number } | null {
  let best: { point: Vec2; dist: number; rot: number } | null = null;
  for (const t of traces) {
    for (let i = 1; i < t.pts.length; i++) {
      const a = t.pts[i - 1]!, b = t.pts[i]!;
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (l2 < 1e-18) continue;
      const u = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
      const q = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      // The run's own direction at the point, so a part dropped here can be STORED at the angle it will
      // be seated at rather than leaving that to be re-derived. See the note at the seat below.
      if (!best || d < best.dist) {
        best = { point: q, dist: d, rot: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
      }
    }
  }
  return best;
}
