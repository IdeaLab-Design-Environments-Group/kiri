/**
 * **Model** — fitting a physical part onto a run of copper.
 *
 * ## Why this is its own file
 *
 * A resistor, a switch or any library part is seated by *breaking* a run and letting the part bridge the
 * gap. Whether that is possible is a question about millimetres and datasheets — the part's pitch, its
 * pad size, the keep-out its body needs, whether the remaining copper is still long enough to be a run —
 * and not about routing at all. {@link partFit} is the one place that arithmetic lives, so the housing
 * the canvas draws, the gap the router cuts and the fit the netlist reports cannot drift apart.
 *
 * Kept separate from `pad-landing.ts` on purpose: that file decides where copper *stops*, this one
 * decides where copper is *removed* so a component can stand in the gap.
 */
import type { PlacedPart, Vec2 } from "./electronics.js";
import type { PartFit, PartSpan, ResistorSpan, Trace2D } from "./trace-types.js";
import { RESISTOR, SPDT, acrossPart, inlineTerminals, padAxis } from "./parts.js";
import { type Box, type Footprint, type Pad, padSize } from "./footprint.js";
import { footprintById } from "./library.js";
import { TAPE_MM } from "./tape-width.js";
import {
  add,
  cross,
  distToSeg,
  len,
  scale,
  segsCross,
  sub,
  trimEnd,
  unit,
} from "./trace-geometry.js";

/**
 * The placed parts by component id, each group in the order the parts were dropped.
 *
 * Each entry keeps `at`, its index in `circuit.parts`, because a group is broken on its own and the spans
 * come back numbered within the group — and every caller outside the router counts parts in the one list
 * the author placed them in.
 */
export function byComponent(parts: PlacedPart[]): [string, { part: PlacedPart; at: number }[]][] {
  const by = new Map<string, { part: PlacedPart; at: number }[]>();
  parts.forEach((part, at) => {
    // A free part stands on the sheet and has no rail cut for it, so it is not grouped for breaking. It is
    // skipped HERE rather than filtered out by the caller, and that distinction is the whole point: `at` is
    // the index of the part in the AUTHOR'S list, it escapes as `PartPlacement.source`, and the canvas
    // matches that against its own selection index (`electronics-modal.ts:1503`, `:1616`). Filter the array
    // before this and every `at` after a free part is off by one — no crash and no red test, just the wrong
    // part's span and flip shown when you click one.
    if (part.free) return;
    const group = by.get(part.component);
    if (group) group.push({ part, at });
    else by.set(part.component, [{ part, at }]);
  });
  return [...by];
}

/**
 * The span a FREE part is drawn on: its own `partFit.gap` long, centred on the drop point, along `rot`.
 *
 * Lives here rather than in the editor because it has to obey the same in-line flip rule the seated path
 * obeys three lines below — `!across && flip ? turnRound(span) : span`. An in-line part expresses a flip as
 * its span running the other way; a two-row part expresses it through `acrossRun`, and swapping its ends
 * would move `rowShape`'s anchor instead. Getting that split wrong is what left every flipped in-line part
 * ROUTED flipped and DRAWN unflipped — on a symmetric two-terminal part that exchanges pads 1 and 2, so a
 * net wired to pad 1 had its copper laid where pad 2 was drawn. Measured on 24 of the library's 129 parts,
 * including `R_1206`, `C_1206`, `LED_1206` and `SW_PUSH`.
 *
 * Flat pattern units in and out.
 */
export function freeSpan(
  part: { x: number; y: number; rot?: number; flip?: boolean },
  fp: Footprint,
  tapeW: number,
  tapeMm: number,
): { a: Vec2; b: Vec2 } {
  const half = ((partFit(fp).gap * tapeW) / tapeMm) / 2;
  const th = ((part.rot ?? 0) * Math.PI) / 180;
  const ux = Math.cos(th), uy = Math.sin(th);
  const a = { x: part.x - ux * half, y: part.y - uy * half };
  const b = { x: part.x + ux * half, y: part.y + uy * half };
  return !acrossPart(fp) && part.flip ? { a: b, b: a } : { a, b };
}

/** The same part, end for end: its two terminals swap which cut end of the break they land on. */
export function turnRound<T extends PartSpan>(span: T): T {
  return { ...span, a: span.b, b: span.a };
}

/**
 * The copper a 1206 resistor replaces, in millimetres: the bare span between its two pads.
 *
 * Read off the part's own KiCad footprint — see `parts.ts`. It was 6.5 once, a through-hole body I had
 * picked myself, which is exactly the sort of number this pipeline exists to stop us inventing.
 */
export const RESISTOR_MM = RESISTOR.gap;

/**
 * The switch's pad pitch, in millimetres — from the C&K AYZ0102AGRLC footprint, which says 2.5mm exactly.
 * Three pads, so twice this across the lot.
 *
 * The break is one pitch and falls between the second pad and the third, so two sit on one side of it and
 * one on the other.
 */
export const SWITCH_PITCH_MM = SPDT.pitch;

/**
 * The copper a switch takes out, in millimetres.
 *
 * The common is on one edge and the two throws on the other, so the rail runs straight through the part —
 * in at the common on one side, out at a throw on the other. The break is the separation between those
 * rows, plus a neck: the idle throw has to sit in clear pattern, and the outgoing tape is wide enough that
 * ending it level with the pad row left only a quarter of a millimetre between the two. Pulled back by the
 * neck, that becomes a millimetre — the sort of gap an LED's pads get.
 */
export const SWITCH_ROW_MM = SPDT.rowSep;

/**
 * How far the outgoing tape is pulled back beyond the pad row, in millimetres.
 *
 * The idle throw has to sit in clear pattern — that void is what opens the circuit — and "clear" has to
 * mean a keep-out, not merely "no copper exactly under the centre". With the tape ending level with the
 * pad row the two were 0.27mm apart, close enough for solder to bridge.
 *
 * So the pull-back is solved for rather than picked. The idle pad sits a pitch off the centreline, which
 * puts it {@link SWITCH_LATERAL_MM} clear of the tape's edge sideways; pulling the tape back by the neck
 * adds that much along the rail. The nearest copper is the tape's corner, so the two combine as the legs
 * of a right angle, and the neck is whatever makes the hypotenuse reach past the pad by the keep-out.
 *
 * It is derived because the pad is: this switch's terminals are 1.5mm wide against the 0.43mm ones the
 * part was first drawn with, and a hard-coded 1.4mm neck that used to leave a millimetre left 0.40mm.
 */
export const SWITCH_KEEPOUT_MM = 1;

/**
 * The neck for any part the rail steps across, from its pitch and its pad — see {@link SWITCH_NECK_MM}.
 *
 * Written once and used for every part, so the switch's number and a new part's come out of the same
 * arithmetic rather than one being the constant and the other a re-derivation that drifts from it.
 */
export function neckFor(part: { pitch: number; pad: Box }): number {
  const reach = part.pad.h / 2 + SWITCH_KEEPOUT_MM;
  // How far past the tape's edge the idle pad's column sits — sideways clearance we get for free.
  //
  // `TAPE_MM`, not the roll the router actually chose, and knowingly: this feeds module-level constants
  // (`SWITCH_NECK_MM` and friends) that are computed once at load, so it cannot see a per-pattern choice.
  // Under `tapeChoice: "area"` on a large-tiled model the tape is wider than this assumes and the neck
  // comes out slightly generous — the part gets a little more room than it strictly needs, which is the
  // safe direction to be wrong in. Making it exact means making those constants per-pattern.
  const lateral = Math.max(0, part.pitch - TAPE_MM / 2);
  // Sideways alone may already clear it, on a part whose pads are far enough out; then the neck is only
  // what keeps the tape from ending inside the housing.
  const along = reach * reach - lateral * lateral;
  return along > 0 ? Math.sqrt(along) : part.pad.h / 2;
}

export const SWITCH_NECK_MM = neckFor({ pitch: SWITCH_PITCH_MM, pad: SPDT.pad });

export const SWITCH_GAP_MM = SWITCH_ROW_MM + SWITCH_NECK_MM;

export function partFit(fp: Footprint): PartFit {
  const across = acrossPart(fp);
  if (!across) {
    const row = inlineTerminals(fp);
    // One terminal (or none) bridges nothing; it has no gap to break a rail for.
    if (row.length < 2) return { rows: 1, gap: 0, before: 0, after: 0 };
    const [first, last] = [row[0]!, row[row.length - 1]!];
    // Centre to centre, less half of each outermost pad: the bare pattern the body covers.
    //
    // Measured along the part's OWN axis, not along x. `inlineTerminals` picks the right two pads by that
    // axis, but measuring the distance between them on x reads zero for a footprint whose pads run down y
    // — and a negative gap is refused outright at the call site, so all ten of the library's y-oriented
    // in-line parts were undroppable at any run length. `PinHeader_01x03_P2_54mm_Horizontal_SMD` came out
    // at -2.500mm. The pad's extent has to follow the same axis: `padSize` gives `w` as the x-extent, so
    // along a y axis it is `h` that lies along the rail.
    const ax = padAxis(fp);
    const alongExt = (pad: Pad): number => (ax.alongIsY ? padSize(pad).h : padSize(pad).w);
    const gap = Math.abs(ax.along(last) - ax.along(first)) - (alongExt(first) + alongExt(last)) / 2;
    return { rows: 1, gap, before: gap, after: gap };
  }
  const gap = across.rowSep + neckFor(across);
  // As the switch pass has always reserved it: the part's own half-gap plus a pad, either side.
  //
  // `pad.h`, the ALONG-run extent, because that is the axis a reserve is measured in — `before`/`after` are
  // copper either side of the break's centre, along the rail. It used to read `pad.w`, and that was the bug
  // rather than drift: a two-row part is seated TURNED to the rail, so its along-run extent is the
  // footprint's across-axis one, which `padRunBox` now reports as `h`.
  //
  // Do NOT copy `alongExt` from the one-row branch above. A one-row part is not turned — the rail runs
  // along its terminals — so there the same question has the opposite answer. Same field, two branches,
  // three lines apart, and the working implementation next door is the wrong one to imitate.
  const reach = gap / 2 + across.pad.h;
  return { rows: 2, gap, before: reach, after: reach };
}

/**
 * Break the run each resistor sits on.
 *
 * Both of a resistor's ends land on the same rail, so copper running underneath it shorts it out and the LEDs
 * see the full battery — the run is genuinely cut in two rather than narrowed, which is all an LED needs.
 * Either rail will do: a resistor in series limits the current the same on the way out as on the way back.
 *
 * Each half comes back as an ordinary run, so everything downstream — the strips file, the carrier and its
 * tabs, the canvas, the folded model — handles it without knowing resistors exist. The resistor is snapped to
 * the nearest run: it is stored as a point in the pattern, and the routes under it are re-planned whenever
 * the circuit changes.
 */
export function breakForResistors(
  traces: Trace2D[],
  resistors: { x: number; y: number }[],
  tapeW: number,
  /** The tape in mm — see {@link seatLed}. */
  tapeMm: number = TAPE_MM,
): { traces: Trace2D[]; placed: ResistorSpan[] } {
  // The body in the pattern's own units: the tape is `tapeMm` wide and `tapeW` units, so this follows it.
  return breakRuns(traces, resistors, (RESISTOR_MM * tapeW) / tapeMm);
}

/**
 * Break each run where a part sits, leaving `gap` of bare pattern for it to bridge.
 *
 * Shared by resistors and switches, which differ only in how much copper they take out: a resistor's body,
 * or one pin pitch of a header. Each half comes back as an ordinary run, so nothing downstream needs to know
 * either exists.
 */
export function breakRuns(
  traces: Trace2D[],
  parts: { x: number; y: number }[],
  gap: number,
  /**
   * Copper the part needs either side of the break's centre, beyond the break itself.
   *
   * A resistor straddles its gap evenly and needs no more than it. A switch does not: its terminals run on
   * past the break, so it wants a half-pitch of copper behind the cut and three of them in front. Reserving
   * only the gap seated the part with a terminal hanging off the end of the run, on bare pattern, where it
   * connects to nothing.
   */
  reach: { before: number; after: number } = { before: gap, after: gap },
): { traces: Trace2D[]; placed: PartSpan[] } {
  const placed: PartSpan[] = [];
  if (!parts.length) return { traces, placed };
  const body = gap;
  let out = traces;
  for (const [at, r] of parts.entries()) {
    let bestRun = -1, bestSeg = -1, bestT = 0, bestD = Infinity;
    out.forEach((t, ti) => {
      for (let i = 1; i < t.pts.length; i++) {
        const a = t.pts[i - 1]!, b = t.pts[i]!;
        // The segment's squared length, computed here rather than with `dist2`, which despite its name
        // returns the distance. Divided by the length instead of its square, the projection came out `u`
        // times too large and clamped to 1 on all but the shortest segments: every part landed at the end
        // of a segment rather than where it was put.
        const dx = b.x - a.x, dy = b.y - a.y;
        const l2 = dx * dx + dy * dy;
        if (l2 < 1e-18) continue;
        const u = Math.max(0, Math.min(1, ((r.x - a.x) * dx + (r.y - a.y) * dy) / l2));
        const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        const d = Math.hypot(r.x - p.x, r.y - p.y);
        if (d < bestD) { bestD = d; bestRun = ti; bestSeg = i; bestT = u; }
      }
    });
    if (bestRun < 0) continue; // no copper to sit on — nothing to break
    // Slide the part inboard if it was dropped near an end. A run has to keep a half-body either side or
    // the break takes one of its ends off entirely, and the part was simply not placed -- a click that did
    // nothing at all, with no way to tell why.
    // Facing the way it was dropped if the run allows it, and turned round if only the other way fits: a
    // part in series works the same either way about, and refusing to seat one on a short run helps nobody.
    const forward = fitWithin(out[bestRun]!, bestSeg, bestT, reach.before, reach.after);
    const moved = forward ?? fitWithin(out[bestRun]!, bestSeg, bestT, reach.after, reach.before);
    const split = moved
      ? splitRun(out, bestRun, moved.seg, moved.t, body)
      : { traces: out, span: null };
    out = split.traces;
    // Turned round, the span is reported end-for-end, which is how the part knows which way it faces.
    if (split.span) {
      const span = split.span;
      placed.push(forward ? { ...span, source: at } : { a: span.b, b: span.a, net: span.net, source: at });
    }
  }
  return { traces: out, placed };
}

/**
 * The land copper under a switch: a stub to the common, and a stub across to one throw.
 *
 * The rail steps across the part rather than running under it. It arrives at the common, which sits in the
 * middle of the break; the outgoing run leaves from a throw one pitch to the side. The other throw is a
 * pitch the other way, off the copper entirely — which is what opens the circuit in that position, and it
 * needs no window cut to do it.
 *
 * Both stubs are a pad's width, not the tape's: at `.098in` centres, two full-width stubs would meet
 * between the terminals and short the part to itself.
 */
/** Across the run, towards the side the live throw takes. {@link PartSpan.flip} swaps it. */
export function acrossRun(u: Vec2, flip?: boolean): Vec2 {
  return flip ? { x: u.y, y: -u.x } : { x: -u.y, y: u.x };
}

/**
 * Which way round to seat a three-terminal part, so its idle throw lands on bare pattern.
 *
 * The idle throw is only insulated by where it sits. That is fine in the middle of a long run and not
 * fine near anything else: the terminal reaches a pitch plus half a pad off the centreline, which on
 * this switch is 3.25mm — as far again as the tape is wide — and a neighbouring rail that close is
 * touched. The part is symmetric, so the fix is free: put the live throw on whichever side leaves the
 * idle one further from every other piece of copper.
 *
 * Measured over 84 placements spread along the longest rail of house, church, puffin and akde-hex,
 * sampling the idle pad on a 7x7 grid: 1120 of 4116 samples landed on copper with no choice made, and
 * 27 with. Puffin and akde-hex go to nil. Measuring from the pad's corners to the tape's edge rather
 * than centre to centreline was tried and picked the same side in all 84, so this stays the simpler one.
 *
 * What it cannot do is rescue a spot where both sides are bad — church still has one placement whose
 * idle throw clips a rail whichever way the part faces. Sliding the part along the run would, and does
 * not exist yet.
 *
 * Ties keep the unflipped orientation, so a part with room on both sides sits as it always did.
 */
export function idleSide(span: PartSpan, traces: Trace2D[], pitch: number, over: number, rowSep: number): boolean {
  const d = sub(span.b, span.a);
  const L = len(d);
  if (L < 1e-12) return false;
  const u = { x: d.x / L, y: d.y / L };
  const row = { x: span.a.x + u.x * rowSep, y: span.a.y + u.y * rowSep };
  const clearance = (flip: boolean): number => {
    // The idle throw is opposite the live one.
    const p = acrossRun(u, !flip);
    const c = { x: row.x + p.x * (pitch + over), y: row.y + p.y * (pitch + over) };
    let nearest = Infinity;
    for (const t of traces) {
      for (let i = 1; i < t.pts.length; i++) {
        nearest = Math.min(nearest, distToSeg(c, t.pts[i - 1]!, t.pts[i]!));
      }
    }
    return nearest;
  };
  return clearance(true) > clearance(false) + 1e-9;
}

/**
 * Whether a three-terminal part seated here keeps every terminal off the OTHER net's copper.
 *
 * A switch reaches a pitch plus half a pad off the centreline — 3.25mm on the SPDT, wider than the tape
 * it sits on — so on a crowded pattern a throw can come down on the rail of the opposite net. That is
 * not a cosmetic overlap: it bridges power to ground through the part, and it is invisible on screen
 * because the terminal is drawn over the copper it is shorting to. Measured before this check existed,
 * 9 of 44 switch placements across the bundled patterns did exactly that.
 *
 * {@link idleSide} cannot prevent it. It picks the better of two sides, and when both sides are bad the
 * better one is still a short. So this is a veto rather than a preference: a part that cannot be seated
 * without touching the other net is not placed at all, and the caller reports it as not fitting — the
 * same answer a run too short to hold it gets, and an honest one.
 */
export function clearOfOtherNet(
  span: PartSpan, traces: Trace2D[], tapeW: number,
  pitch: number, pad: { w: number; h: number }, rowSep: number,
): boolean {
  const d = sub(span.b, span.a);
  const L = len(d);
  if (L < 1e-12) return false;
  const u = { x: d.x / L, y: d.y / L };
  const p = acrossRun(u, span.flip);
  const row = { x: span.a.x + u.x * rowSep, y: span.a.y + u.y * rowSep };
  const centres = [
    span.a,                                                                        // common
    { x: row.x + p.x * pitch, y: row.y + p.y * pitch },                            // live throw
    { x: row.x - p.x * pitch, y: row.y - p.y * pitch },                            // idle throw
  ];
  const other = traces.filter((t) => t.net !== span.net);
  for (const c of centres) {
    // The pad's four corners, so a terminal that clips a rail with one corner is caught too.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const q = {
          x: c.x + (p.x * sx * pad.w + u.x * sy * pad.h) / 2,
          y: c.y + (p.y * sx * pad.w + u.y * sy * pad.h) / 2,
        };
        for (const t of other) {
          const half = (t.width ?? tapeW) / 2;
          for (let i = 1; i < t.pts.length; i++) {
            if (distToSeg(q, t.pts[i - 1]!, t.pts[i]!) < half) return false;
          }
        }
      }
    }
  }
  return true;
}


/**
 * The two pieces of pad-sized copper an across-the-rail part lands on: the common, and the live throw.
 *
 * `padW` is the pad's extent **across the run** and becomes each land's width; `padL` is its extent
 * **along the run** and is how far past the terminal the land reaches. The part is seated turned to the
 * rail — `acrossPart` is what turns it — so the footprint's own along-axis becomes the run's across-axis,
 * and a caller reading `pad.w`/`pad.h` off the footprint must cross that turn. `pad.w` is the across-run
 * extent as drawn: measured on a seated SPDT, each lead is 1.0mm across the run and 1.2mm along it, and
 * `pad.w` is 1.0. `clearOfOtherNet` takes the box the same way round.
 */
export function switchLand(
  span: PartSpan,
  pitch: number,
  padW: number,
  padL: number,
  rowSep: number,
): Trace2D[] {
  const { a, b } = span;
  const d = sub(b, a);
  const L = len(d);
  if (L < 1e-12) return [];
  const u = { x: d.x / L, y: d.y / L };
  const p = acrossRun(u, span.flip);
  // The common is at the near cut end. The throws are a row's separation along from it — not at the far cut
  // end, which is pulled back a neck further so the idle throw sits in clear pattern. The outgoing tape
  // reaches neither throw on its own: one gets a land, the other is left bare, which opens the circuit.
  // Two half-pads, in two different axes, and they are not the same number.
  //
  // `over` is a half-length ALONG the run: how far past the terminal the common land reaches, so the whole
  // pad has copper under it. That is the pad's along-run extent, `padL`.
  //
  // `reach` is a positional offset ACROSS the run: how far past the throw the stub carries, for the same
  // reason in the other axis. That is the pad's across-run extent, `padW`. Sharing one `over` between them
  // read as a simplification and was a transpose — measured on a seated SPDT, the common land runs along
  // the run and the live stub leaves it at 67-89 degrees depending on the seating, so the two ends are in
  // different axes and no single half-pad is right for both.
  const over = padL / 2;
  const reach = padW / 2;
  const row = { x: a.x + u.x * rowSep, y: a.y + u.y * rowSep };
  const live = { x: row.x + p.x * (pitch + reach), y: row.y + p.y * (pitch + reach) };
  // Each land runs half a pad past its terminal, so the whole pad has copper under it. Stopped dead on the
  // centre, half of it sat over bare pattern and the terminal made contact along one edge if at all.
  // Centred on the terminal, not started at it: run from the cut end only forwards, the pad's centre sits on
  // the land's own end cap and half the pad has nothing under it.
  const commonStart = { x: a.x - u.x * over, y: a.y - u.y * over };
  const commonEnd = { x: a.x + u.x * over, y: a.y + u.y * over };
  return [
    { net: span.net, pts: [commonStart, commonEnd], width: padW },
    { net: span.net, pts: [b, live], width: padW },
  ];
}

/**
 * Move a break inboard until a half-body fits either side of it, or report that the run is too short.
 *
 * Measured along the run, so it stays on the copper as the run bends.
 */
export function fitWithin(
  run: Trace2D,
  seg: number,
  t: number,
  before: number,
  after: number,
): { seg: number; t: number } | null {
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < run.pts.length; i++) {
    const l = len(sub(run.pts[i]!, run.pts[i - 1]!));
    segs.push(l);
    total += l;
  }
  // Enough copper either side of the break's centre to seat the part.
  if (total <= before + after) return null;
  let at = 0;
  for (let i = 0; i < seg - 1; i++) at += segs[i]!;
  at += (segs[seg - 1] ?? 0) * t;
  const want = Math.min(Math.max(at, before), total - after);
  // Back to a segment and a fraction along it.
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    if (want <= acc + segs[i]! || i === segs.length - 1) {
      const f = segs[i]! > 0 ? Math.min(Math.max((want - acc) / segs[i]!, 0), 1) : 0;
      return { seg: i + 1, t: f };
    }
    acc += segs[i]!;
  }
  return null;
}

/** Split run `ri` at a point, leaving `body` of bare pattern between the two halves. */
export function splitRun(
  traces: Trace2D[],
  ri: number,
  seg: number,
  t: number,
  body: number,
): { traces: Trace2D[]; span: Omit<ResistorSpan, "source"> | null } {
  const run = traces[ri]!;
  const a = run.pts[seg - 1]!, b = run.pts[seg]!;
  const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  // Walk back and forward along the run by half the body, so the gap is centred on the resistor.
  const head = [...run.pts.slice(0, seg), at];
  const tail = [at, ...run.pts.slice(seg)];
  const first = trimEnd(head, body / 2);
  const second = trimEnd([...tail].reverse(), body / 2).reverse();
  const kept: Trace2D[] = [];
  for (const pts of [first, second]) if (pts.length >= 2) kept.push({ net: run.net, pts });
  // A run too short to break either side keeps its copper rather than vanishing: better a resistor that
  // needs its leads bent than a branch that silently loses its supply.
  if (kept.length < 2) return { traces, span: null };
  const span = { a: first[first.length - 1]!, b: second[0]!, net: run.net };
  return { traces: [...traces.slice(0, ri), ...kept, ...traces.slice(ri + 1)], span };
}


