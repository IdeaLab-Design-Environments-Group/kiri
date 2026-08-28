/**
 * **Model** — what each library part's pads *are*, as opposed to where they sit.
 *
 * A footprint names its pads the way the datasheet does: "1", "2", "3". That is right for the file and
 * useless for the router, which needs to know which of those three a rail arrives at and which two it
 * chooses between. This is where a pad number becomes a role.
 *
 * It is also where the one deliberate departure from the manufacturer's footprint lives, so that the
 * parser stays a faithful reader and the fudge stays visible:
 *
 * The SPDT slide switch is a surface-mount part, so all three of its terminals sit in a single row on
 * one edge — you solder it to pads on a board and the traces approach from underneath. Copper tape on a
 * folded sheet has no underneath. A rail that arrives and leaves on the same edge has to double back
 * around the housing, which is what put all three terminals on one side and made the part unusable.
 *
 * So the common is reflected through the part's own origin — the line its two mounting pegs sit on — to
 * the opposite edge. The rail then runs straight through: in at the common, out at whichever throw is
 * selected, with the idle throw stranded in bare pattern. The pitch, the pad sizes and the peg positions
 * are all still the part's own; only that one reflection is ours.
 */
import { LED_1206, R_1206, SW_SPDT } from "./footprints.generated.js";
import {
  holes,
  padAt,
  padNamed,
  padSize,
  terminals,
  type Box,
  type Footprint,
  type Pad,
  type Vec2,
} from "./footprint.js";

/** A two-terminal part in line with the rail: the tape runs in one pad and out the other. */
export interface InlinePart {
  footprint: Footprint;
  /** Centre to centre between the terminals, in millimetres. */
  pitch: number;
  /** The bare pattern between them — the copper the part replaces. */
  gap: number;
  /** How big one terminal is. */
  pad: { w: number; h: number };
}

function inline(fp: Footprint, a: string, b: string): InlinePart {
  const [p, q] = [padNamed(fp, a), padNamed(fp, b)];
  const pad = padSize(p);
  const pitch = Math.abs(padAt(q).x - padAt(p).x);
  return { footprint: fp, pitch, gap: pitch - pad.w, pad };
}

/** The 1206 LED. Pad 1 is the anode, pad 2 the cathode. */
export const LED = inline(LED_1206, "1", "2");

/** The 1206 chip resistor. */
export const RESISTOR = inline(R_1206, "1", "2");

/** The SPDT slide switch, with the common moved across — see the note at the top of this file. */
export const SPDT = (() => {
  const throwA = padNamed(SW_SPDT, "1");
  const commonPad = padNamed(SW_SPDT, "2");
  const throwB = padNamed(SW_SPDT, "3");
  const pad = padSize(throwA);
  const row = padAt(throwA);
  /** The common, reflected to the far edge: same x, opposite y. */
  const common: Vec2 = { x: padAt(commonPad).x, y: -padAt(commonPad).y };
  return {
    footprint: SW_SPDT,
    /** Centre to centre along the row — one throw to the common's column. */
    pitch: Math.abs(padAt(throwB).x - padAt(commonPad).x),
    /** Across the part, common row to throw row. This is the reflection's doing. */
    rowSep: row.y - common.y,
    /** How far the throws stand off the part's origin. */
    offset: row.y,
    pad,
    common,
    throwA: padAt(throwA),
    throwB: padAt(throwB),
  };
})();

/**
 * How near two terminals must be across the part to count as sitting in the same row, in millimetres.
 *
 * Well under any real pad, so it separates rows rather than pads: the closest two rows in the library
 * are the switch's 5.5mm apart, and the closest two pads within a row 1mm.
 */
const ROW_TOL_MM = 0.05;

/**
 * The axis a part's terminals are laid out along, as a pair of coordinate readings.
 *
 * Read off the pads rather than assumed. KiCad orients a footprint the way its datasheet drawing was
 * oriented, so a 1206's two pads run along x while a pin header's run down y — 62 of the library's 159
 * footprints are the second kind. Reading the rows across a hardcoded y put every one of those into a
 * row of its own, which made a two-pin header read as a two-row part like the switch, and lost the
 * middle pin of a three-pin header, since only three terminals are ever given a role.
 */
const AXIS_CACHE = new WeakMap<Footprint, PadAxis>();
const ACROSS_CACHE = new WeakMap<Footprint, { v: AcrossPart | null }>();

export function padAxis(fp: Footprint): PadAxis {
  const hit = AXIS_CACHE.get(fp);
  if (hit) return hit;
  const made = readPadAxis(fp);
  AXIS_CACHE.set(fp, made);
  return made;
}

/**
 * Both readings are cached on the footprint, the way `footprint.ts › nearestTerminalMm` is and for the same
 * reason: they are properties of the PART, not of any placement — no `rot`, `flip` or `free` can change
 * which axis a footprint's pads line up along or how many rows it has. Keyed on the footprint object, which
 * is a module-level singleton `cloneCircuit` never touches, so unlike a cache on a `PlacedPart` this one
 * actually hits.
 *
 * It became worth doing when `electronics-parts.ts › placementOf` started calling both per pad: a fourteen-pin
 * part re-read its own row structure fourteen times for one placement, and the wire tool does that for every
 * part on every pointer move.
 */
function readPadAxis(fp: Footprint): PadAxis {
  const at = terminals(fp).map(([, p]) => padAt(p));
  // Which axis the pads line up along is what having FEW rows means, so count the rows each reading
  // gives and take the tidier one. The obvious rule — whichever axis the pads are spread furthest along
  // — is wrong, and a two-row part is where it breaks: rows six apart with their pads four apart spread
  // furthest ACROSS the part, so the span rule reads the part sideways and puts every pad in a row of
  // its own, which is the very failure this function exists to stop.
  const groups = (v: number[]): number => {
    const seen: number[] = [];
    for (const x of v) if (!seen.some((s) => Math.abs(s - x) <= ROW_TOL_MM)) seen.push(x);
    return seen.length;
  };
  // Ties go to x, which is what every part read correctly before this existed.
  return groups(at.map((p) => p.x)) < groups(at.map((p) => p.y))
    ? { alongIsY: true, along: (p) => padAt(p).y, across: (p) => padAt(p).x }
    : { alongIsY: false, along: (p) => padAt(p).x, across: (p) => padAt(p).y };
}

/**
 * Which way round a footprint is drawn, and the accessors that read a pad by it.
 *
 * `alongIsY` is the same fact the two accessors carry, said plainly: a drawing needs it to know which of
 * a pad's own extents runs along the rail, which the accessors cannot answer because they take a pad
 * rather than a length.
 */
export interface PadAxis {
  alongIsY: boolean;
  along: (p: Pad) => number;
  across: (p: Pad) => number;
}

/** The part's terminals grouped into rows across it, near side first. */
function terminalRows(fp: Footprint, ax = padAxis(fp)): { y: number; pads: Pad[] }[] {
  const rows: { y: number; pads: Pad[] }[] = [];
  for (const [, pad] of terminals(fp)) {
    const y = ax.across(pad);
    const row = rows.find((r) => Math.abs(r.y - y) <= ROW_TOL_MM);
    if (row) row.pads.push(pad);
    else rows.push({ y, pads: [pad] });
  }
  return rows.sort((a, b) => a.y - b.y);
}

/** A part the rail steps ACROSS: in at one row, out at the other. The switch, generalised. */
export interface AcrossPart {
  /** The terminals this reading picked, by their own names in the footprint. */
  names: { common: string; live: string; idle: string };
  /** Across the part, common row to throw row, in millimetres. */
  rowSep: number;
  /** Centre to centre along the throw row, the common's column to the throw the rail leaves by. */
  pitch: number;
  /** One terminal, normalised to the RUN by {@link padRunBox}: `w` across the rail, `h` along it. */
  pad: Box;
}

/**
 * Whether a rail steps ACROSS this part, and if so with what geometry — read off the footprint alone.
 *
 * Two rows of terminals means the rail arrives at one and leaves at the other; that is the direct case.
 * The other is the surface-mount one described at the top of this file: all the terminals on one edge,
 * off the line the part's mounting pegs sit on, and the middle one reflected through that line to the
 * far edge so the rail runs straight through instead of doubling back round the housing.
 *
 * Fewer than three terminals is a part in line with the rail, not one it steps across; and with no pegs
 * there is no line to reflect through. Both stay one-row and are routed and drawn like a resistor.
 *
 * It lives here, alone, because it is one decision wearing two hats. The router breaks copper by it and
 * the export draws by it, and when the two briefly had a rule each they agreed on every part in the
 * library except the coin cell — three terminals but no pegs — which the router would have cut as an
 * in-line part while the export drew a housing across the rail. A cut file that disagrees with its own
 * drawing is the worst failure this code has, because it looks right until the copper is on the sheet.
 */
export function acrossPart(fp: Footprint): AcrossPart | null {
  const hit = ACROSS_CACHE.get(fp);
  if (hit) return hit.v;
  const made = readAcrossPart(fp);
  // Boxed, so a `null` answer is cached as an answer rather than re-read every call — and most of the
  // library is `null` here.
  ACROSS_CACHE.set(fp, { v: made });
  return made;
}

function readAcrossPart(fp: Footprint): AcrossPart | null {
  const ax = padAxis(fp);
  const rows = terminalRows(fp, ax);
  if (rows.length === 1) {
    const row = rows[0]!;
    if (row.pads.length < 3 || Math.abs(row.y) <= ROW_TOL_MM || holes(fp).length === 0) return null;
    const byX = [...row.pads].sort((a, b) => ax.along(a) - ax.along(b));
    const common = byX[Math.floor(byX.length / 2)]!;
    const live = byX[byX.length - 1]!;
    const idle = byX[0]!;
    return {
      names: nameOf(fp, common, live, idle),
      // The reflection, and nothing else: same column, opposite side.
      rowSep: ax.across(live) + ax.across(common),
      pitch: Math.abs(ax.along(live) - ax.along(common)),
      pad: padRunBox(ax, live),
    };
  }
  if (rows.length < 2) return null;
  // Genuinely two rows. The rail arrives at the sparser one — one common against several throws — and
  // leaves at the throw furthest from the common's column, which is the one the neck has to clear.
  const [near, far] = rows[0]!.pads.length <= rows[rows.length - 1]!.pads.length
    ? [rows[0]!, rows[rows.length - 1]!]
    : [rows[rows.length - 1]!, rows[0]!];
  const common = [...near.pads].sort((a, b) => ax.along(a) - ax.along(b))[Math.floor(near.pads.length / 2)]!;
  const byReach = [...far.pads].sort(
    (a, b) => Math.abs(ax.along(a) - ax.along(common)) - Math.abs(ax.along(b) - ax.along(common)),
  );
  const live = byReach[byReach.length - 1]!;
  // The idle throw is whatever else that row holds; with only one throw there is nothing to switch to and
  // it stands in for itself, which keeps the naming total rather than optional.
  const idle = byReach.length > 1 ? byReach[0]! : live;
  return {
    names: nameOf(fp, common, live, idle),
    rowSep: Math.abs(ax.across(live) - ax.across(common)),
    pitch: Math.abs(ax.along(live) - ax.along(common)),
    pad: padRunBox(ax, live),
  };
}

/**
 * One pad's extents stated in the RUN's axes rather than the footprint's own.
 *
 * **The transpose this file's other fields already perform, applied to the one that was missing it.**
 * `acrossPart` returns `rowSep` through `ax.across` and `pitch` through `ax.along`, and both are consumed
 * the other way round — `rowSep` along the run, `pitch` across it. That is not an inconsistency, it is what
 * "across part" means: the rail steps across the part, so the part is seated **turned**, and the
 * footprint's own along-axis becomes the run's across-axis.
 *
 * `pad` was returned as raw `padSize(...)` — always `{w: x-extent, h: y-extent}` — while its two siblings
 * were normalised. That is true for a part whose terminals run along x and false for one whose terminals
 * run along y, and **43 of the library's 87 across-parts are the second kind** (`SOT_23_3`, `TO_252`,
 * `ESP32_WROOM_32E`, the `PinHeader_02xNN`s). Every consumer that read `.w` as "across the rail" was
 * therefore right about 44 parts and wrong about 43, in the drawing and in the copper alike.
 *
 * `padAxis` already carries `alongIsY` for exactly this, and its docblock says so: it is there "because a
 * drawing needs to know which of a pad's own extents runs along the rail, which the accessors cannot
 * answer because they take a pad rather than a length". This is the function that asks it.
 *
 * Do not use it for a part seated IN LINE with the rail. There the rail runs along the terminals and no
 * transpose happens, so the run's along-axis is the footprint's own — the opposite answer to this one, for
 * the same question. `partFit`'s two branches sit three lines apart and need the two different readings.
 */
export function padRunBox(ax: PadAxis, p: Pad): Box {
  const s = padSize(p);
  return ax.alongIsY ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
}

/** Look three chosen pads back up by the names the footprint gives them. */
function nameOf(
  fp: Footprint, common: Pad, live: Pad, idle: Pad,
): { common: string; live: string; idle: string } {
  const find = (target: Pad): string => terminals(fp).find(([, p]) => p === target)?.[0] ?? "";
  return { common: find(common), live: find(live), idle: find(idle) };
}

/** The terminals in line with the rail, outermost first — the one-row reading. */
export function inlineTerminals(fp: Footprint): Pad[] {
  return inlineNamedTerminals(fp).map(([, p]) => p);
}

/** The same, keeping each terminal's own name — what a drawing needs to label a pad. */
export function inlineNamedTerminals(fp: Footprint): [string, Pad][] {
  const ax = padAxis(fp);
  return terminals(fp).sort((a, b) => ax.along(a[1]) - ax.along(b[1]));
}

/**
 * Which way round a two-row part is seated on the run — the two signs, defined once.
 *
 * The placement sends the footprint's ACROSS-coordinate along the rail (scaled by `sC`) and its
 * ALONG-coordinate across it (scaled by `sA`). `sC` is read off the footprint: `live`'s row has to be the
 * downstream one, or the rail arrives at the wrong side of the break.
 *
 * ## `sA` is not free, and reading it off `live` was the bug
 *
 * It used to be `sign(along(live) − along(common))`, computed identically in
 * `electronics-parts.ts › placementOf` and `copper-svg-export.ts › rowLeads`. With
 * `p = ±perp(u)` the determinant of the placement is `sC · sA · (u × p)`, so an `sA` that disagreed with
 * `sC` made the placement **orientation-reversing** — a reflection. Since both `origin` expressions anchor
 * on the `common` pad, that is a mirror about `common`, and it reversed the part's pin order.
 *
 * Measured on `Module_XIAO_Generic_SocketSMD`: `common` = pad 3, `live` = pad 8, `sC` = +1, `sA` = −1, and
 * the pins came out 1↔5, 2↔4, 3 fixed, 6 and 7 past the end of the part. **60 of the library's 87
 * across-parts placed as a reflection.** A surface-mount part has one side; a placement is never allowed to
 * be a mirror.
 *
 * Three things wanted to be true at once — `live`'s row downstream, `live` on the `+p` side, and the
 * placement a rotation — and only two of them can be. The middle one is what {@link acrossPart}'s reading
 * was written for: the **SPDT switch**, where the router picks which throw the copper leaves by. For a
 * fourteen-pin socket `live` is an arbitrary pad and that sign is an arbitrary reflection, so it goes:
 * `sA = sC`, and `PlacedPart.flip` carries the half-turn it is documented to mean.
 *
 * ## `fabricated`
 *
 * True where {@link acrossPart} INVENTED the second row by reflecting the common through the peg line (its
 * `rows.length === 1` branch). There every terminal shares one across-coordinate, so `sC` is a sign of
 * zero and the row has no order along the run to get wrong; those parts keep the old reading, since that is
 * the three-terminal case `idleSide` and `acrossRun` exist for and `rowLeads` refuses them anyway.
 */
export interface SeatSigns {
  /** The footprint's across-axis, onto the run. */
  sC: number;
  /** Its along-axis, onto the across-run direction. Equal to `sC` unless the second row is fabricated. */
  sA: number;
  /** Whether {@link acrossPart} invented the second row — see above. */
  fabricated: boolean;
}

/** The signs for this footprint, or `null` if the rail does not step across it. */
export function seatSigns(fp: Footprint, g: AcrossPart | null = acrossPart(fp)): SeatSigns | null {
  if (!g) return null;
  const ax = padAxis(fp);
  const common = padNamed(fp, g.names.common);
  const live = padNamed(fp, g.names.live);
  const dC = ax.across(live) - ax.across(common);
  // The same test `rowLeads` already used to refuse a fabricated row, and for the same reason.
  if (Math.abs(dC) < 1e-9) {
    return { sC: 1, sA: Math.sign(ax.along(live) - ax.along(common)) || 1, fabricated: true };
  }
  const sC = Math.sign(dC);
  return { sC, sA: sC, fabricated: false };
}

/**
 * Whether a part can go in series on a rail at all, and if not, why not.
 *
 * The FabLib holds 159 footprints and most of them are not series parts: a forty-pin connector has no
 * meaning spliced into a run of copper tape, and a single-terminal pad has nothing to bridge. The
 * palette needs to know which are which — and, when it refuses one, to say something truer than
 * nothing, because a user hunting for a USB socket and finding an empty list concludes the app is
 * broken rather than that the part cannot be wired this way.
 *
 * It lives here rather than in the generated data because it is the same decision {@link acrossPart}
 * and `partFit` already make, and a second copy of it in the generator would be a second rule to drift
 * from this one. That has happened once in this codebase already: the router and the export each grew
 * their own reading of a footprint's rows, agreed on every part but the coin cell, and would have cut
 * it as one shape while drawing another. One rule, one place.
 */
export type Placement = { placeable: true } | { placeable: false; why: string };

/** How many terminals a rail could reach: two in line, or three where it steps across. */
const MAX_IN_SERIES = 3;

export function placement(fp: Footprint): Placement {
  const n = terminals(fp).length;
  if (n < 2) {
    return { placeable: false, why: n === 1 ? "one terminal — nothing to bridge" : "no terminals" };
  }
  if (n > MAX_IN_SERIES) {
    return { placeable: false, why: `${n} terminals — a rail passes through at most ${MAX_IN_SERIES}` };
  }
  return { placeable: true };
}

/**
 * Whether a part can be placed on a circuit that has NETS, rather than in series on a rail.
 *
 * A far weaker condition, and deliberately so. {@link placement} asks whether a rail can pass *through* a
 * part, which is why it stops at three terminals: a run of tape arrives, the part bridges a break in it,
 * and the run leaves. A forty-pin connector has no meaning spliced into a run of copper, so it was refused,
 * and two thirds of the library sat under "in the library, but not in series on a rail".
 *
 * Once the author declares nets, that question is the wrong one. A part is no longer something a rail
 * passes through; it is a set of pads, each wired to whichever net the author says. A USB socket is then
 * perfectly placeable — four pads, four net assignments — and so is anything else with a pad to wire.
 *
 * So the only real requirement is a terminal to wire. One is enough: a single-pad part is a test point or a
 * mounting pad, and connecting it to a net is a legitimate thing to want, even though it has nothing to
 * bridge and so could never sit in series.
 */
export function netPlacement(fp: Footprint): Placement {
  return terminals(fp).length >= 1
    ? { placeable: true }
    : { placeable: false, why: "no terminals — nothing to wire to a net" };
}
