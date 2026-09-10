/**
 * **Model** — where a placed part's pads, body and holes land on the sheet.
 *
 * The geometry half of drawing a component: given the two cut ends of the copper a part bridges, this works
 * out the rectangle of every terminal, the housing between them, and the mounting holes — at the part's own
 * datasheet dimensions, never scaled to the tape. `part-render.ts` then paints what this places; the two are
 * deliberately apart, so a paint change cannot move a pad and a placement change cannot repaint one.
 *
 * It lives here rather than in `copper-svg-export.ts` because it is not about cutting. The strips file, the
 * carrier, the carrier's annotation layer and the editor's own canvas all draw the same parts in the same
 * order from these functions, and a cut file is only one of the four. Keeping it in the exporter also kept
 * that file at its size budget, with every part fix landing in the middle of the outline and tab code.
 *
 * Entry points: {@link partShape} (a footprint on a break, the only implementation), {@link resistorShape}
 * and {@link switchShape} (it with the two fixed tools filled in), {@link partShapeOf} (the same for a
 * placed library part), {@link drawnParts} (every part a file draws, in one order so both cut files number
 * them identically) and {@link partsLayer} (those parts as SVG). {@link frameMirrored} answers whether the
 * caller's flat-to-sheet transform reverses orientation, which every one of them needs to be told.
 *
 * Units are the caller's: `partShape` is handed points already in the frame it should draw in — sheet
 * millimetres for the cut files, canvas units for the editor.
 */
import type { Vec2 } from "./electronics.js";
// `DEFAULT_LED` comes from the router rather than being written again here: the part an LED means
// when its circuit does not say is one decision, and a second copy of it is a second thing to drift.
import { DEFAULT_LED, acrossRun } from "./electronics-routing.js";
import { type Box, type Footprint, type Pad, holes, MM_PER_INCH, padAt, padSize, terminals } from "./footprint.js";
import { type AcrossPart, acrossPart, inlineNamedTerminals, padAxis, padRunBox, seatSigns } from "./parts.js";
import { R_1206, SW_SPDT } from "./footprints.generated.js";
import { footprintById } from "./library.js";
import { designators, partSvg } from "./part-render.js";

/**
 * The parts' own copper, read from the manufacturers' KiCad footprints by `ocaml/kicad.ml`.
 *
 * A named part is the size it is. Every pad, pitch and hole below is the datasheet's, so nothing here is a
 * guess at a footprint or a shape scaled to whatever the tape happens to be. The one thing that is ours —
 * the switch's common moved to the far edge, so a rail can run through the part rather than doubling back
 * around it — is derived and explained in `parts.ts`, not hidden in here.
 */
/** The library, by component id — so a placed part can be drawn from the id the circuit stores. */


/**
 * An LED, as the cut files take it: the two cut ends of the copper its legs bridge, and which part it is.
 *
 * `pwr` and `gnd` are the ends of the two nets' tape, in flat coordinates — the same points the runs are
 * narrowed against, so the drawing and the narrowing cannot disagree about where the chip sits. They are
 * NOT the pad centres: {@link inlineShape} puts a pad centre half a pad-length outboard of each cut end,
 * exactly as it does for a resistor, so an LED's pads land at the part's own pitch when the router has
 * brought the copper to within the part's own bare gap. One code path, one meaning for the two points.
 */
export interface LedPads {
  pwr: Vec2;
  gnd: Vec2;
  /** A `Component.id`. Absent means `DEFAULT_LED` — an LED saved before they had a choice of part. */
  component?: string;
}

/** An LED the router could not reach keeps its zeroed pads; there is no chip to draw there. */
const unplaced = (p: Vec2): boolean => p.x === 0 && p.y === 0;
/**
 * A resistor drawn across the break in the copper it bridges.
 *
 * Grey leads run the whole span, from one cut end of the tape to the other — that is what is taped down onto
 * the copper either side and carries the current. The black body sits in the middle, over the bare pattern
 * where there is deliberately no copper at all.
 */
export interface ResistorShape {
  /**
   * The contacts, one per terminal: a segment across the run with a width, which is the pad's rectangle.
   *
   * `name` is the terminal's own name in the footprint — "1", "GND", "throw_a" — so a renderer can look
   * the pad back up and draw its true outline and its label rather than a stand-in rectangle.
   */
  leads: {
    a: Vec2; b: Vec2; width: number; name?: string;
    /**
     * That this lead's pad has its footprint x across the run and its y along it, not the other way.
     *
     * A lead is a rectangle, so it cannot say which way round the outline that fills it goes. Absent, a
     * renderer maps the pad's y onto the segment and its x onto the width, which is right for a part
     * whose terminals run along x and a quarter turn out for one whose terminals run down y.
     */
    swap?: boolean;
  }[];
  /** The body, square across the run. */
  body: { x: number; y: number; w: number; h: number; angle: number; cx: number; cy: number };
  /** Mounting holes, where the part has them. Drawn, never cut: a hole through the pattern is the user's
   *  decision, not the exporter's. */
  holes?: { c: Vec2; r: number }[];
  /**
   * Copper to take out from under a pin, as a closed ring in sheet coordinates.
   *
   * The idle throw of an SPDT needs bare pattern beneath it, or the switch is wired to nothing in one
   * position and to the rail in both. Unlike the break, this does not sever the run: it is a window inside
   * the strip, and the copper carries on either side of it.
   */
  notch?: Vec2[];
}

/**
 * A library part drawn on the break it bridges — the generic form of {@link resistorShape} and
 * {@link switchShape}, and the only implementation of either.
 *
 * `a` and `b` are the two cut ends of the copper, already in sheet coordinates. Which of the two forms
 * a part takes is {@link acrossPart}'s decision and not this file's, because the router breaks copper by
 * that same decision and a cut file that disagrees with its own drawing is worse than either being
 * wrong. Every dimension then comes from the part's own pads and holes, so it is drawn at the size its
 * datasheet says it is; a wider tape does not make it bigger.
 */
export function partShape(
  fp: Footprint, a: Vec2, b: Vec2, flip?: boolean,
  /**
   * Whether the frame `a` and `b` are already in REVERSES ORIENTATION — see {@link frameMirrored}.
   *
   * Every sheet frame in this app does: `sheetFrame` and the editor's `tp()` both send flat `y` to
   * `maxY − y`, because FOLD is y-up and SVG y-down. A part's pads are laid out along the run and ACROSS
   * it, and a perpendicular computed after a reflection points the opposite way from one computed before
   * it — so a part drawn here came out mirrored against the same part placed by
   * `electronics-parts.ts › placementOf`, which works in flat units.
   *
   * Measured on `Module_XIAO_Generic_SocketSMD` in the editor: the net on pad 1 had its copper laid on
   * drawn pad 5, 10.16mm away, with pads 2 and 4 swapped and pad 3 standing still — a reflection about the
   * `common` pad. Defaults to `false` so a caller working in an unreflected frame (a plain scale, as the
   * tests do) needs to say nothing.
   */
  frameFlipped?: boolean,
): ResistorShape | null {
  const ts = inlineNamedTerminals(fp);
  if (ts.length < 2) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  const ux = dx / L, uy = dy / L;
  const across = acrossPart(fp);
  return across
    ? rowShape(fp, across, a, ux, uy, flip, frameFlipped)
    : inlineShape(fp, ts, a, b, ux, uy, dx, dy, frameFlipped);
}

/**
 * Whether a flat → sheet transform reverses orientation.
 *
 * Sampled rather than declared: the transform is built from a scale, a Y-flip and the author's own mirror
 * toggle, and asking it three times is exact for an affine map and cannot fall out of step with it the way
 * a hand-maintained boolean would. See {@link partShape}'s `frameFlipped`.
 */
export function frameMirrored(T: (p: Vec2) => Vec2): boolean {
  const o = T({ x: 0, y: 0 }), x = T({ x: 1, y: 0 }), y = T({ x: 0, y: 1 });
  return (x.x - o.x) * (y.y - o.y) - (y.x - o.x) * (x.y - o.y) < 0;
}

/**
 * The in-line form: the rail runs along the terminals, and the part bridges the break between them.
 *
 * Every terminal is drawn, at the part's own pitch, centred on the break — not just the two the router
 * measured the gap from. Those two still reach a pad's length past each cut end, because that is the
 * part that matters: it lies on the copper, and it is what holds the part down and carries the current.
 * Drawn only to the edge of the gap they would show a part touching nothing.
 *
 * It used to draw exactly two contacts, one at each cut end, and a three-pin header lost its middle pin
 * entirely: a pad with no part in the routing had no lead, and no lead meant nothing painted.
 */
function inlineShape(
  fp: Footprint, ts: [string, Pad][],
  a: Vec2, b: Vec2, ux: number, uy: number, dx: number, dy: number,
  frameFlipped?: boolean,
): ResistorShape {
  const ax = padAxis(fp);
  const pad = padSize(ts[0]![1]);
  const L = Math.hypot(dx, dy);
  // Across the run, in a frame that may reverse orientation — see `partShape`'s `frameFlipped`.
  const fs = frameFlipped ? -1 : 1;
  const px = -uy * fs, py = ux * fs;     // across the run
  const over = ax.alongIsY ? pad.h : pad.w;  // a contact's length along the run — the pad's own
  const bodyW = (ax.alongIsY ? pad.w : pad.h) * 0.85;  // the body, a little inside its contacts
  // The body spans the whole break and laps a little onto each contact. At four fifths of the gap it fell
  // short of both, leaving the part drawn as three pieces with bare pattern showing between them.
  const bodyL = L + over * 0.5;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  // The outermost two contacts, at the cut ends, exactly where this drawing has always put them: a band
  // of lead pressed down over the full width of the copper, not a line running down the middle.
  const endA = { x: a.x - ux * (over / 2), y: a.y - uy * (over / 2) };
  const endB = { x: b.x + ux * (over / 2), y: b.y + uy * (over / 2) };
  // And every terminal between them, at its own place along the part.
  //
  // The two the router measured the break from stay pinned to the ends, because a contact is what lies
  // on the copper and carries the current; the rest are read off the footprint and land in proportion
  // between them. On a break the length of the part's own `fit.gap` that proportion IS the datasheet
  // pitch, so this is the part's spacing and not a stretch of it. The middle pin of a three-pin header
  // had no role in the routing, so it had no lead and was not drawn at all; this is what puts it back.
  //
  // The guarantee is the library-part break specifically, not every break. `breakRuns` is also called
  // at a constant width for the two fixed tools — `SWITCH_GAP_MM` and `RESISTOR_MM` — and on one of
  // those the proportion would not be the pitch. Neither can show it today: the resistor has two
  // terminals and so nothing between them to place, and the switch is drawn by `rowShape`, not here.
  // A three-terminal part routed down the switch path would be the case that parts them.
  const first = ax.along(ts[0]![1]), last = ax.along(ts[ts.length - 1]![1]);
  const span = last - first;
  const leads = ts.map(([name, t], i) => {
    const size = padSize(t);
    // The pad's own extents, told apart by the axis the part is drawn on rather than by x and y: a pin
    // header runs down y, and reading its pads as though it ran along x turned every one of them a
    // quarter turn.
    const alongExt = ax.alongIsY ? size.h : size.w;
    const acrossExt = ax.alongIsY ? size.w : size.h;
    // Degenerate parts — every terminal at one point — keep the old two-contact reading rather than
    // divide by nothing.
    const f = Math.abs(span) < 1e-9 ? (i === 0 ? 0 : 1) : (ax.along(t) - first) / span;
    const o = ax.across(t);
    const c = {
      x: endA.x + (endB.x - endA.x) * f + px * o,
      y: endA.y + (endB.y - endA.y) * f + py * o,
    };
    return {
      a: { x: c.x - px * acrossExt / 2, y: c.y - py * acrossExt / 2 },
      b: { x: c.x + px * acrossExt / 2, y: c.y + py * acrossExt / 2 },
      width: alongExt,
      name,
      ...(ax.alongIsY ? { swap: true } : {}),
    };
  });
  return {
    leads,
    body: {
      x: mid.x - bodyL / 2, y: mid.y - bodyW / 2, w: bodyL, h: bodyW,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI, cx: mid.x, cy: mid.y,
    },
  };
}

/**
 * The two-row form: the rail arrives at one row and leaves at the other.
 *
 * Three pads at the part's own pitch. The break is one row separation, so the common sits on the copper
 * at the near end of it and the live throw on the copper at the far end, with the idle throw a pitch the
 * other way — one on one side, two on the other.
 *
 * The body is offset clear of the pad rows rather than drawn over them. That is where it really sits:
 * the legs reach out to the copper and the housing stands beside them. Drawn centred on the rail it
 * covered the very tape it is soldered to.
 */
/**
 * Every terminal of a genuinely two-row part, at its own place on the part.
 *
 * {@link rowShape} was written for the SPDT slide switch and draws exactly three contacts — idle, common,
 * live — synthesised from `pitch` and `rowSep`. That is right for a switch and wrong for everything else,
 * and `acrossPart` matches 87 of the 129 parts in the library. A 26-way USB-C socket came out with three
 * contacts. Worse, `PinSocket_01x02` has TWO terminals and came out with THREE: the third was not a pad
 * being dropped but a pad being INVENTED, at a place the part has no metal, on a file someone solders to.
 *
 * The mapping is a rigid one, anchored on the common pad, and it is exact rather than fitted: `rowSep` and
 * `pitch` are themselves `|across(live) - across(common)|` and `|along(live) - along(common)|` (`parts.ts`
 * :204-205), so sending the footprint's across-axis to the run and its along-axis across the run puts
 * `common` at `a` and `live` at `row ± pitch` — exactly where this function already put them. The routing
 * anchors do not move; the other terminals stop being invented.
 *
 * Returns `null` for a one-row part, which keeps the switch on the path it was written for. There the row
 * separation is a reflection `acrossPart` fabricates (`parts.ts:184`) rather than a distance the footprint
 * has: every terminal shares one across value, so there is no second row to map a pad onto and no honest
 * position to give it.
 *
 * That leaves two parts still drawn wrong, and they are named in the test rather than hidden here:
 * `Conn_USB_microB_Socket_WurthElektronik_629105136821` and `Conn_USB_miniB_Socket_CUIDevices_UJ2_MBH_1`,
 * both five terminals in one row, both still drawn with three. They cannot be fixed from this side. Drawing
 * their five pads where the footprint actually has them — all on one row — would contradict the routing,
 * which breaks the rail across a separation the part does not have. The root cause is that `acrossPart`
 * answers "is this a switch?" and "does this part sit across the run?" with one function; splitting those
 * is the owning session's work, and this returns `null` rather than guess at it.
 */
function rowLeads(
  fp: Footprint,
  names: { common: string; live: string; idle: string },
  a: Vec2, ux: number, uy: number, px: number, py: number,
  pad: (c: Vec2, size?: Box) => { a: Vec2; b: Vec2; width: number },
  flip?: boolean,
  frameFlipped?: boolean,
): { a: Vec2; b: Vec2; width: number; name: string }[] | null {
  const ax = padAxis(fp);
  const ts = terminals(fp);
  const common = ts.find(([n]) => n === names.common)?.[1];
  const live = ts.find(([n]) => n === names.live)?.[1];
  if (!common || !live) return null;

  const c0 = ax.across(common), a0 = ax.along(common);
  const dC = ax.across(live) - c0;
  if (Math.abs(dC) < 1e-9) return null; // one row: the separation is fabricated, not measured

  // Signs only — the magnitudes are the footprint's own. `live` must land on the far row, which is what
  // `rowShape` means by +`rowSep`.
  //
  // From `parts.ts › seatSigns`, not computed here. These two lines used to be a second copy of the two in
  // `electronics-parts.ts › placementOf`, and both had `sA` read off `live` — which made the seating a
  // REFLECTION about the common pad for 60 of the library's 87 across-parts, drawn and routed alike, so the
  // two agreed with each other and disagreed with the chip. A XIAO's pin 1 was drawn where pin 5 goes.
  const seat = seatSigns(fp);
  if (!seat) return null;
  const { sC, sA } = seat;
  // A rotation, so the across-run direction is the plain perpendicular rather than `acrossRun`'s
  // flip-dependent one, and the flip is a half-turn negating both signs. `px`/`py` still place the body,
  // the pegs and the three-terminal fallback, where the flip means which side the live throw takes.
  const turn = flip ? -1 : 1;
  // Turned the other way when `alongIsY` swaps the footprint's own two axes — the correction
  // `electronics-parts.ts › placementOf` makes on the same line, and without which one of the two cases is
  // orientation-reversing.
  const fs = frameFlipped ? -1 : 1;
  const qx = (ax.alongIsY ? -uy : uy) * fs, qy = (ax.alongIsY ? ux : -ux) * fs;

  return ts.map(([name, t]) => {
    const along = (ax.across(t) - c0) * sC * turn;   // the part's row axis runs along the rail
    const across = (ax.along(t) - a0) * sA * turn;   // and its pad axis runs across it
    const c = { x: a.x + ux * along + qx * across, y: a.y + uy * along + qy * across };
    // Normalised to the run, not raw: `pad()` reads `w` as the across-rail extent and `h` as the
    // along-rail one, and a turned part's footprint axes are the other way round. Raw `padSize` here drew
    // 43 of the library's 87 across-parts with their two extents swapped — see {@link padRunBox}.
    return { ...pad(c, padRunBox(ax, t)), name };
  });
}

function rowShape(
  fp: Footprint, g: AcrossPart, a: Vec2, ux: number, uy: number, flip?: boolean,
  frameFlipped?: boolean,
): ResistorShape {
  // Across the run, towards the live throw. The router chose the side when it placed the part; drawing
  // it the other way round would put the housing over the copper the idle throw is meant to avoid.
  //
  // The router chose it in FLAT units, so the direction has to be brought into this frame rather than
  // recomputed in it: a perpendicular flips sign under a reflection. See `partShape`'s `frameFlipped`.
  const fs = frameFlipped ? -1 : 1;
  const across = acrossRun({ x: ux, y: uy }, flip);
  const px = across.x * fs, py = across.y * fs;
  // The rail runs straight through the part: the common is on the near edge of the break, the two throws on
  // the far edge, a pitch either side of the centreline. The outgoing tape runs down the middle and reaches
  // neither throw by itself — one gets a land, the other is left bare, and that is what opens the circuit.
  const names = g.names;
  const p0 = g.pad;
  const common = a;
  // The throws sit a row's separation along from the common — not at the far cut end, which is pulled back
  // a neck further so the idle throw lands in clear pattern rather than beside the tape.
  const row = { x: a.x + ux * g.rowSep, y: a.y + uy * g.rowSep };
  const live = { x: row.x + px * g.pitch, y: row.y + py * g.pitch };
  const idle = { x: row.x - px * g.pitch, y: row.y - py * g.pitch };
  // The housing spans both rows, centred between them.
  const cx = (a.x + row.x) / 2, cy = (a.y + row.y) / 2;
  // Across the rail: out to the throws' centres. Each terminal then straddles a corner of the housing --
  // half its width on, half off -- so it reads as attached while still standing proud. Drawn out to the
  // pads' far edges instead the housing swallowed them; drawn short of their centres they met it at a
  // single point and looked detached, which is what they were.
  const bodyL = 2 * g.pitch;
  // Along the rail: exactly edge to edge between the two pad rows, so each terminal straddles the housing's
  // outline and half of it stands proud, as the legs do on the part. A pad's length deeper and every
  // terminal fell inside the outline, leaving the legs as slivers at the corners.
  const bodyW = g.rowSep;
  // A pad at its own size: `w` across the part's long axis, `h` along the rail.
  const pad = (c: Vec2, size: Box = p0): { a: Vec2; b: Vec2; width: number } => {
    const half = size.h / 2;
    return {
      a: { x: c.x - ux * half, y: c.y - uy * half },
      b: { x: c.x + ux * half, y: c.y + uy * half },
      width: size.w,
    };
  };
  // The mounting holes, on the body's own centre line. Drawn, never cut.
  const pegs = holes(fp).map((h) => {
    const at = padAt(h);
    return {
      c: { x: cx + ux * at.x + px * at.y, y: cy + uy * at.x + py * at.y },
      r: (h.drill!.diameter * MM_PER_INCH) / 2,
    };
  });
  return {
    leads: rowLeads(fp, names, a, ux, uy, px, py, pad, flip, frameFlipped) ?? [
      { ...pad(idle), name: names.idle },
      { ...pad(common), name: names.common },
      { ...pad(live), name: names.live },
    ],
    body: {
      x: cx - bodyL / 2, y: cy - bodyW / 2, w: bodyL, h: bodyW,
      angle: (Math.atan2(py, px) * 180) / Math.PI, cx, cy,
    },
    ...(pegs.length ? { holes: pegs } : {}),
  };
}

/** The 1206 chip resistor, on the break its leads bridge. {@link partShape} with the part filled in. */
export function resistorShape(a: Vec2, b: Vec2, frameFlipped?: boolean): ResistorShape | null {
  return partShape(R_1206, a, b, undefined, frameFlipped);
}

/** The SPDT slide switch, on the break its middle pads bridge. {@link partShape}, part filled in. */
export function switchShape(a: Vec2, b: Vec2, flip?: boolean, frameFlipped?: boolean): ResistorShape | null {
  return partShape(SW_SPDT, a, b, flip, frameFlipped);
}

/**
 * One placed part, drawn the way a PCB layout tool draws it: its real pads in copper and mask, each
 * carrying its own terminal name, with the designator beside it.
 *
 * The drawing is {@link partSvg}'s, and the palette lives with it in `part-render.ts` — there is no part
 * colour in this file. What this file still owns is the *placement*, which {@link partShape} decided and
 * which nothing here moves.
 */
function partMarks(fp: Footprint, sh: ResistorShape, designator: string): string[] {
  return partSvg(fp, sh, designator);
}

/**
 * A library part placed on a break, as the cut files take it: which part, and the two cut ends.
 *
 * The component's *id*, not its footprint — the circuit stores an id, and a file that carried a
 * footprint instead would go stale the moment the library was regenerated.
 */
export interface PlacedPartMark {
  component: string;
  a: Vec2;
  b: Vec2;
  flip?: boolean;
}

/** {@link partShape} for a placed part, or `null` if its component is not in the library. */
export function partShapeOf(r: PlacedPartMark, T: (p: Vec2) => Vec2): ResistorShape | null {
  const fp = footprintById(r.component);
  // `T` is the sheet frame, which flips Y — so the across-run direction has to be told, not re-derived.
  return fp ? partShape(fp, T(r.a), T(r.b), r.flip, frameMirrored(T)) : null;
}

/** A part about to be drawn: which footprint, which component it is, and the break it bridges. */
export interface DrawnPart {
  component: string;
  fp: Footprint;
  a: Vec2;
  b: Vec2;
  flip?: boolean;
}

/**
 * Every part a cut file draws, in one list and in one order.
 *
 * Both files build this list from the same three arguments, so both number the parts identically. A
 * resistor called `R1` on the strips and `R2` on the carrier would be worse than no designator at all:
 * the two files are meant to be laid one over the other, and the labels are how you tell which is which.
 * A component that is not in the library is dropped here rather than later, so it consumes no designator.
 */
export function drawnParts(
  resistors: { a: Vec2; b: Vec2 }[],
  switches: { a: Vec2; b: Vec2; flip?: boolean }[],
  parts: PlacedPartMark[],
  leds: LedPads[] = [],
): DrawnPart[] {
  return [
    ...resistors.map((r) => ({ component: "R_1206", fp: R_1206, a: r.a, b: r.b })),
    ...switches.map((s) => ({ component: "SW_SPDT", fp: SW_SPDT, a: s.a, b: s.b, flip: s.flip })),
    ...parts.flatMap((p) => {
      const fp = footprintById(p.component);
      return fp ? [{ component: p.component, fp, a: p.a, b: p.b, flip: p.flip }] : [];
    }),
    // The LEDs come last, and the editor's canvas builds its own list in this same order, so a chip is
    // the same LED1 on the screen and on both files. An LED the router could not seat is dropped here
    // rather than drawn at the sheet's corner, and so consumes no designator either.
    ...leds.flatMap((l) => {
      const id = l.component ?? DEFAULT_LED;
      const fp = footprintById(id);
      if (!fp || unplaced(l.pwr) || unplaced(l.gnd)) return [];
      // Anode first: pad "1" is the anode, and it is the PWR end of the break that its leg reaches.
      return [{ component: id, fp, a: l.pwr, b: l.gnd }];
    }),
  ];
}

/**
 * The parts layer: every part placed, named once, and drawn as its footprint.
 *
 * The designators are assigned over the parts that actually come out with a shape, so a degenerate
 * placement cannot silently eat a number and shift every part after it.
 */
export function partsLayer(drawn: DrawnPart[], T: (p: Vec2) => Vec2): string[] {
  const placed: { d: DrawnPart; sh: ResistorShape }[] = [];
  for (const d of drawn) {
    const sh = partShape(d.fp, T(d.a), T(d.b), d.flip);
    if (sh) placed.push({ d, sh });
  }
  const names = designators(placed.map((p) => p.d));
  return placed.flatMap((p, i) => partMarks(p.d.fp, p.sh, names[i] ?? ""));
}

/**
 * Containment by **winding number**, not even-odd.
 *
 * A run that doubles back on itself — a hairpin round a tile, which the router plans freely — outlines as a
 * ring that crosses itself, and the lobe where it overlaps is wound twice. Even-odd calls that lobe *outside*
 * the strip, so the cut kept the buried line there and dropped the line that was really on the outside; the
 * boundary then stood open by a millimetre or two at each crossing and would not close. Winding counts the
 * overlap as the solid copper it is: three of akde-hex's twelve runs self-intersect, nine crossings in all.
 */
/** The average of a ring's corners — good enough to say which strip a small window sits in. */
export function centreOf(ring: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of ring) { x += p.x; y += p.y; }
  return { x: x / ring.length, y: y / ring.length };
}

export function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let wind = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!;
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) {
      if (b.y > p.y && side > 0) wind++;
    } else if (b.y <= p.y && side < 0) wind--;
  }
  return wind !== 0;
}
