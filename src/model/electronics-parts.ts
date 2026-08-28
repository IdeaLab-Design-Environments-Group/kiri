/**
 * **Model** — a placed part, with its pads as real things.
 *
 * Until this file, kiri had no *placed pad*. A {@link Footprint} is a shared immutable dictionary whose pad
 * positions are in the footprint's own frame; a pad on the sheet was never instantiated. Its identity was
 * the pair `(part index, pad name)` and its geometry was a function recomputed on demand — three times, by
 * three different pieces of code, in two different units:
 *
 * | derivation | frame | for |
 * |---|---|---|
 * | `netlist.ts › padPosition` | flat pattern units | routing targets, wire snapping |
 * | `copper-svg-export.ts › partShape` → `inlineShape`/`rowLeads` | sheet mm | the drawing, anchored on the routed run |
 * | `part-render.ts › padRing` | pad-local mm | the pad's true outline |
 *
 * They agreed only by hand-transcription — `padPosition`'s two-row branch is a copy of `rowLeads` — and
 * `parts.ts › padRunBox` records the night that cost: 43 of the library's 87 across-parts drawn with their
 * two extents swapped, in the cut file as well as the drawing.
 *
 * This is svg-pcb's `pcb_helpers.js › makeComponent`, ported. One transform per placed part, every pad baked
 * from it once, and every consumer reading the same array. Routing becomes pad-to-pad rather than
 * object-position-plus-offsets.
 *
 * ## Rebuilt every pass, never cached
 *
 * svg-pcb bakes its `Component` at `board.add()` and never invalidates it — because it re-executes the
 * user's entire program on every mousemove, so the bake lives for one frame and is thrown away. That is the
 * part worth copying, and it is the part that makes this safe here.
 *
 * A stored cache would be wrong in kiri for two measured reasons. `cloneCircuit` rebuilds every
 * {@link PlacedPart} as a fresh object literal on each edit, so a `WeakMap` keyed on one would never hit.
 * And a pad's position in flat units goes through `tapeW`, which is `tapeWidthFor(faces, sheetMm, sheet,
 * circuit)` — circuit-global, so adding any part anywhere moves every pad of every part. "This part's pads"
 * is not a per-part fact. So nothing here is stored: `placeComponent` is a pure function, called per pass.
 *
 * ## Units
 *
 * **Flat pattern units**, throughout. That is where {@link PlacedPart.x}/`y` live and where the router
 * decides, so it is the frame in which "pad to pad" means anything. The cut files and the canvas compose
 * their own flat→sheet-mm transform (`copper-svg-export.ts › sheetFrame`, and the editor's `tp()`) on top.
 */
import type { PlacedPart, Vec2 } from "./electronics.js";
import {
  carriesCopper, isTerminal, padAt, padNamed, padPoints, padSize, terminals,
  type Box, type Footprint,
} from "./footprint.js";
import { acrossPart, padAxis, seatSigns } from "./parts.js";
// `partFit` and `acrossRun` are the two readings a placement has to agree with, and a second copy of
// either is a second thing to drift. Taken from `part-fit.ts` rather than from the router's facade: this
// used to be a live cycle (the router reaches placement through `netlist.ts`), safe only by the accident
// that both names were function declarations read inside a function body.
import { acrossRun, partFit } from "./part-fit.js";

/**
 * How a part sits on the sheet: `at = origin + m · padLocal`.
 *
 * **A 2×2, and deliberately not `{rot, flip}`.** A two-row part's placement sends the footprint's across-axis
 * along the run and its along-axis across it, with two independent signs — so its determinant is negative
 * for half the sign combinations and the placement is **orientation-reversing**. `PlacedPart.flip` is a
 * half-turn and its docblock is explicit that it is *not* a mirror, so no `{origin, rot, flip}` triple can
 * express those placements. svg-pcb has no such trouble because its own `flip` genuinely is a mirror
 * (`scale(shape, [-1, 1], [0, 0])`).
 *
 * Storing the matrix means the reflection cannot be silently dropped by a model that only knows about
 * angles. `m` is row-major: `[m00, m01, m10, m11]`.
 */
export interface Placement {
  origin: Vec2;
  m: [number, number, number, number];
}

/** One pad of one placed part, in flat pattern units. */
export interface PlacedPad {
  /** The pad's own name in its footprint — `"1"`, `"GND"`, `"throw_a"`. */
  name: string;
  /** Its centre. */
  at: Vec2;
  /** Its true outline, the datasheet's own shape, placed. Not a stand-in rectangle. */
  outline: Vec2[];
  /** Its extents. `w` across the part's long axis and `h` along it — {@link padRunBox}'s normalisation. */
  size: Box;
  /** Whether it carries copper at all, as against being a mechanical hole. */
  onCopper: boolean;
}

/** A part on the sheet, and every pad it has — wired or not. */
export interface PlacedComponent {
  /** Index into `Circuit.parts` — the only handle back, since routed spans are not index-aligned. */
  source: number;
  /** A `Component.id` from the library. */
  component: string;
  footprint: Footprint;
  placement: Placement;
  /**
   * Every terminal, in `terminals(fp)` order — **including the ones nobody wired**.
   *
   * An unwired pin is still solder-side metal, and copper passing over it shorts the part just as surely as
   * copper on a wired one. What matters here is the geometry, not the netlist.
   */
  pads: PlacedPad[];
  /** Mounting holes, placed. Drawn, never cut — a hole through the pattern is the author's decision. */
  drills: { at: Vec2; r: number }[];
}

/** Apply a placement to a point in the footprint's own frame. */
export function applyPlacement(p: Placement, local: Vec2): Vec2 {
  return {
    x: p.origin.x + p.m[0] * local.x + p.m[1] * local.y,
    y: p.origin.y + p.m[2] * local.x + p.m[3] * local.y,
  };
}

/** Whether a placement reverses orientation — i.e. it is a reflection, not a rotation. */
export function isMirrored(p: Placement): boolean {
  return p.m[0] * p.m[3] - p.m[1] * p.m[2] < 0;
}

/**
 * Where a part's own frame lands on the sheet.
 *
 * Reproduces `netlist.ts › padPosition` exactly, as one transform rather than as three branches computing
 * points. The branches remain, because they are three genuinely different seatings — but each now yields an
 * `origin` and an `m` instead of a coordinate, and everything downstream reads pads through them.
 */
export function placementOf(
  part: PlacedPart,
  fp: Footprint,
  tapeW: number,
  tapeMm: number,
): Placement {
  const k = tapeW / tapeMm;        // footprint mm → flat pattern units
  const s = part.flip ? -1 : 1;    // the authored half-turn: both axes negated, determinant +1
  const at = { x: part.x, y: part.y };

  // A seated part saved before seated parts had an angle.
  //
  // `PlacedPart.rot` used to be meaningful only for a free part — "a seated part takes its angle from the
  // run it breaks, which this function has never had a way to see" — so this branch applied no rotation at
  // all while the part was DRAWN along its run. Measured on the bundled patterns, that put an R_1206's pads
  // **2.59mm to 3.54mm** from where they are drawn: a whole pad pitch, so a net wired to pad 1 had its
  // copper laid on pad 2.
  //
  // Seated parts now carry a `rot` chosen when they are dropped, and everything below treats them exactly
  // as a free part. This branch is only for circuits saved before that, and it reproduces the old answer
  // deliberately: silently re-placing a part in a file the author already cut copper for would be worse
  // than leaving it where it was. Re-dropping the part fixes it.
  if (!part.free && part.rot === undefined) {
    return { origin: at, m: [k * s, 0, 0, k * s] };
  }

  const th = ((part.rot ?? 0) * Math.PI) / 180;
  const u = { x: Math.cos(th), y: Math.sin(th) };
  const across = acrossPart(fp);
  const ax = padAxis(fp);

  // In line with the rail: the part lies ALONG the run, turned by `rot` about the drop point.
  //
  // Axis-aware, like the two-row branch below and for the same reason. `rot` is the direction of the RUN —
  // `freeSpan` builds the span along it and `inlineShape` lays the pads along it — so the footprint's own
  // along-axis is what must point that way. Reading the footprint's x-axis as the along-axis is right for a
  // part whose terminals run along x and **a quarter turn out for one whose terminals run down y**, which is
  // 62 of the library's 159 footprints.
  //
  // Measured before this was fixed: 15 parts routed at a quarter turn to where they were drawn, the pad
  // spacing identical and the whole set rotated — `PinHeader_01x08_P2_54mm_Horizontal_SMD` worst at 19.88mm,
  // which is a net wired to pin 8 having its copper laid nearer pin 1. `parts.ts › padAxis` exists to answer
  // exactly this and its docblock says so; this branch simply was not asking.
  if (!across) {
    const c = k * s;
    const p0 = { x: -u.y, y: u.x };   // across the run
    // Anchored on the middle of the PAD SPAN, not on the footprint's origin.
    //
    // `electronics-modal.ts › freeParts` says what the drop point means: the span is "the part's own
    // `partFit.gap` long, centred on the drop point", and `partFit.gap` is measured between the outermost
    // pads. So the author drops a part by its terminals, not by whatever point its KiCad file happens to
    // call the origin — and for the 19 footprints whose pads are not symmetric about that origin, the two
    // are different places. Measured before this: `PinHeader_01x03_P2_54mm_Horizontal_SMD` routed a whole
    // 2.54mm pitch away from where it is drawn, so a net wired to pin 1 landed on pin 2.
    const alongs = terminals(fp).map(([, q]) => ax.along(q));
    const mid = alongs.length ? (Math.min(...alongs) + Math.max(...alongs)) / 2 : 0;
    const origin = { x: at.x - u.x * c * mid, y: at.y - u.y * c * mid };
    // Columns are the images of the footprint's x and y axes.
    //
    // The x column is NEGATED where along is y, and that is not a flourish: a rotation taking y to `u` must
    // take x to `u` turned a quarter the other way. Written as `+p0` it was orientation-reversing, so all 15
    // of the library's y-oriented in-line footprints were placed as reflections. No pad moves — every one of
    // those 15 has all its pads on a single across-coordinate, measured — but a pad's own OUTLINE was being
    // mirrored, and `isMirrored` could never have been true of a correct placement.
    return ax.alongIsY
      ? { origin, m: [-c * p0.x, c * u.x, -c * p0.y, c * u.y] }  // along = y, so y maps to the run
      : { origin, m: [c * u.x, c * p0.x, c * u.y, c * p0.y] };   // along = x
  }

  // Two rows. The part is seated TURNED to the rail: the footprint's across-reading runs along the rail and
  // its along-reading runs across it — `rowShape`'s own swap, not a mistake repeated here. The anchor is the
  // `common` pad at the near cut end, half the part's own gap back along `rot`, because that is where
  // `rowShape` puts it and `freeParts` drops the part on its centre.
  const half = (partFit(fp).gap * k) / 2;
  const common = padNamed(fp, across.names.common);
  const c0 = ax.across(common), a0 = ax.along(common);
  // The two signs, from `parts.ts › seatSigns` rather than read off `live` here — one definition, shared
  // with `copper-svg-export.ts › rowLeads`, which used to hold a second copy of exactly these two lines.
  //
  // A genuine two-row part is seated by a ROTATION: `sA` equals `sC`, the across-run direction is the plain
  // perpendicular, and `part.flip` negates both signs, which is the half-turn `PlacedPart.flip` documents
  // itself to be. Reading `sA` off `live` instead made the placement a reflection about the `common` pad for
  // 60 of the library's 87 across-parts, so a XIAO's pin 1 was routed at pin 5. See `seatSigns`.
  //
  // Where the second row is FABRICATED the old reading stands, `acrossRun` and all: that is the three-terminal
  // switch, whose `flip` is which side its live throw takes, and it is symmetric so the reflection is a
  // half-turn by another name.
  const { sC, sA, fabricated } = seatSigns(fp, across)!;
  const turn = !fabricated && part.flip ? -1 : 1;
  // The perpendicular the along-axis maps to turns the OTHER way when `alongIsY` swaps the footprint's two
  // axes — the same correction the in-line branch above needs, and for the same reason: with one fixed
  // perpendicular, exactly one of the two `alongIsY` cases comes out orientation-reversing.
  const q = ax.alongIsY ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x };
  // A fabricated row keeps `acrossRun`'s flip-dependent side, which is the three-terminal switch's choice of
  // which throw the copper leaves by. That one placement genuinely IS a reflection when flipped — the part
  // is its own mirror image, so it is a half-turn by another name, and `rowLeads` refuses those parts anyway.
  const p = fabricated && part.flip ? { x: -q.x, y: -q.y } : q;

  // `u` carries the footprint's ACROSS coordinate and `p` its ALONG one. Which of the pad's own x/y each of
  // those reads is `padAxis`'s answer, so the matrix columns swap with `alongIsY`.
  const cu = sC * turn * k, cp = sA * turn * k;
  const m: [number, number, number, number] = ax.alongIsY
    ? [u.x * cu, p.x * cp, u.y * cu, p.y * cp]     // across = x, along = y
    : [p.x * cp, u.x * cu, p.y * cp, u.y * cu];    // across = y, along = x

  // Fold the anchor's own offsets into the origin, so `applyPlacement` needs no special case.
  const origin = {
    x: at.x - u.x * (c0 * cu + half) - p.x * (a0 * cp),
    y: at.y - u.y * (c0 * cu + half) - p.y * (a0 * cp),
  };
  return { origin, m };
}

/**
 * A part and every pad it has, placed — svg-pcb's `makeComponent`.
 *
 * Pure: call it per pass and throw the result away. See the note on lifetime at the top of this file.
 */
export function placeComponent(
  part: PlacedPart,
  fp: Footprint,
  tapeW: number,
  tapeMm: number,
  source = 0,
): PlacedComponent {
  const placement = placementOf(part, fp, tapeW, tapeMm);
  const ax = padAxis(fp);
  const k = tapeW / tapeMm;

  const pads: PlacedPad[] = terminals(fp).map(([name, pad]) => {
    const local = padAt(pad);
    // The pad's true outline, placed by the same transform as its centre — not a rectangle fitted to a
    // lead afterwards. `padPoints` is about the PAD's own origin, `padAt` about the footprint's, and they
    // are additive; getting that backwards puts every outline at the sheet's corner.
    const outline = padPoints(pad).map((q) =>
      applyPlacement(placement, { x: local.x + q.x, y: local.y + q.y }),
    );
    const raw = padSize(pad);
    return {
      name,
      at: applyPlacement(placement, local),
      outline,
      // Normalised to the RUN, as `parts.ts › padRunBox` means it: `w` across the rail, `h` along it.
      size: ax.alongIsY ? { w: raw.h * k, h: raw.w * k } : { w: raw.w * k, h: raw.h * k },
      onCopper: carriesCopper(pad),
    };
  });

  const drills = Object.entries(fp)
    .filter(([name, pad]) => !isTerminal(name, pad) && pad.drill !== undefined)
    .map(([, pad]) => ({
      at: applyPlacement(placement, padAt(pad)),
      r: (pad.drill!.diameter * 25.4 * k) / 2,
    }));

  return { source, component: part.component, footprint: fp, placement, pads, drills };
}

/** One pad by name, or undefined. A lookup on the baked array — svg-pcb's `Component.pad(name)`. */
export function padOf(c: PlacedComponent, name: string): PlacedPad | undefined {
  return c.pads.find((p) => p.name === name);
}
