/**
 * **Model** — the netlist: nets the author declares, and where their terminals actually are.
 *
 * This is the half of multi-net routing that is pure geometry and bookkeeping, kept apart from the router
 * itself so it can be read and tested without planning a single route. It answers one question — *for each
 * net, which points on the flat pattern have to end up joined?* — and reports every way the netlist can be
 * malformed rather than routing something that was never asked for.
 *
 * Units: a part's `x`/`y` are **flat pattern units**, the same as everything else the router works in, while
 * a footprint's pads are in **millimetres** about the part's own origin. {@link TAPE_MM} and the pattern's
 * own tape width convert between them, exactly as `toFlat` does in the router. Getting this wrong yields
 * pad positions that look plausible and are the wrong size, which has caught this codebase out before.
 */
import type { Circuit, PlacedPart, Terminal, Vec2 } from "./electronics.js";
import {
  isTerminal, nearestTerminalMm, padAt, terminals, type Footprint,
} from "./footprint.js";
import { componentById } from "./library.js";
import {
  applyPlacement, padOf, placeComponent, placementOf, type PlacedComponent,
} from "./electronics-parts.js";
// Taken from the modules that own each rule rather than from electronics-routing.js. This import used to
// close a live cycle — the router imports `resolveNetlist` from here — which was safe only because every
// name was a plain function declaration used inside a function body, never at module-evaluation time.
// That is a property nobody could see from a call site, so the widths and landings moved to leaf modules
// and the cycle went with them.
import { MIN_LAND_FRAC, weedGapFor } from "./tape-width.js";
import { landingWidthFor, padRoomFor } from "./pad-landing.js";
import type { PadField } from "./trace-types.js";

/** One terminal, resolved: which pad of which part, where it is, and the net it is on. */
export interface NetPoint {
  /** Index into `Circuit.parts`. */
  part: number;
  /** The pad's own name in its footprint. */
  pad: string;
  /** Where the pad sits on the flat pattern, in pattern units. */
  at: Vec2;
  /**
   * The pad's own narrowest extent, in pattern units — what a run should shrink to as it lands here.
   *
   * The smaller of the pad's two footprint dimensions, so a trace that tapers down to it clears the pad
   * on both axes whichever way the part is turned. `planNets` uses this to narrow a leg's last stretch
   * rather than running full tape width onto a pad a fraction of that size.
   *
   * Optional so a hand-built point — every fixture in the test suite, and any future caller that has not
   * been taught about it — still type-checks; absent, `planNets` lays that end at the ordinary tape width,
   * exactly as it always has.
   */
  padWidth?: number;
}

/** One net, resolved: the points that have to end up on the same copper. */
export interface ResolvedNet {
  id: string;
  name: string;
  points: NetPoint[];
}

/**
 * Why a netlist entry could not be used.
 *
 * Reported rather than dropped. A terminal that silently vanishes is a net that silently loses a
 * connection, and the resulting circuit looks routed and is wrong — the failure mode this whole file
 * exists to avoid.
 */
export interface NetlistFault {
  kind:
    | "no-such-part"
    | "no-such-pad"
    | "no-such-net"
    | "unknown-component"
    | "duplicate-terminal"
    | "single-terminal-net"
    | "pads-too-close";
  /** Human-readable, and specific enough to act on. */
  why: string;
  part?: number;
  pad?: string;
  net?: string;
}

export interface Netlist {
  nets: ResolvedNet[];
  faults: NetlistFault[];
  /**
   * Every terminal of every part that has anything wired to it — the metal a run has to make room for.
   *
   * Includes the part's **unwired** pins, deliberately. A pin nobody assigned a net to is still solder-side
   * metal, and full-width tape passing over it shorts the part just as surely as tape on a wired one. It is
   * the geometry that matters here, not the netlist.
   *
   * Derived, rebuilt on every call, and never stored on `Circuit` — so `cloneCircuit` needs no new field.
   */
  fields: PadField[];
  /**
   * Every pad of every placed part as a polygon copper must stay off, with the net it belongs to.
   *
   * `fields` says how WIDE copper may be near a pad; this says where it may not go at all. The two are
   * different questions and only the first was ever asked: a leg narrowed to a hair still shorted a part
   * if it ran straight across an unwired pin, because the clearance gate measures against other nets'
   * RUNS and a pad is not a run. See `net-routing.ts › padHitBy`.
   *
   * Every part, not only the wired ones. A part nobody has assigned a net to is still solder-side metal,
   * and tape laid over it is a short whether or not the netlist mentions it. `net` is `null` for a pin
   * nobody wired, and a net is only ever let through its OWN pads — the ones its legs have to land on.
   */
  pads: PadObstacle[];
}

/**
 * The pin a pad belongs to: its name with the parser's repeat suffix taken off.
 *
 * `kicad.ml` emits every pad sharing one KiCad pad NUMBER as `1`, `1_1`, `1_2` — a through-hole pad and its
 * surface-mount twin, a castellated hole and the land beside it. They are one pin of the part and therefore
 * one net, always, by construction: KiCad has no way to wire them apart.
 *
 * It matters because a pad is now an obstacle. Read as separate pads, `1_1` is foreign metal beside pad `1`
 * and a net wired to pad 1 is refused for coming too near — blocked from its own pin by another instance
 * of it. Measured on `SeeedStudio_XIAO_ESP32C3`, where the two sit 0.628mm apart.
 */
export function padPin(name: string): string {
  return name.replace(/_\d+$/, "");
}

/** One pad, as an obstacle: where it is, what shape it is, and whose it is. Pattern units. */
export interface PadObstacle {
  at: Vec2;
  /** Its true outline, placed — the datasheet's own polygon, not a bounding box. */
  outline: Vec2[];
  /** The net wired to it, or `null` for a pin nobody assigned. */
  net: string | null;
  /** Index into `circuit.parts`, and the pad's own name — for reporting, never for geometry. */
  part: number;
  pad: string;
}

/** Millimetres on a footprint to this pattern's units — the router's `toFlat`, which is not exported. */
function toFlat(mm: number, tapeW: number, tapeMm: number): number {
  return (mm * tapeW) / tapeMm;
}

/**
 * Where one pad of one placed part sits on the flat pattern.
 *
 * `flip` turns the part through half a turn about its own origin, which is what it already means
 * everywhere else: it is the difference between a polarised part's two orientations, not a mirror. A
 * mirrored part would put its pads in the wrong order along the rail and read as a different component.
 *
 * A **free** part turns by `rot` as well — the author's own turn, since it has no run to take an angle
 * from (see {@link PlacedPart.rot}) — and, when its footprint is a **two-row** one (`acrossPart(fp)` —
 * everything from a pin socket to a 26-way USB connector), the pads are placed the way
 * `rowShape`/`freeParts` in `electronics-routing.ts` actually draw them: anchored on the `common` pad,
 * not on the footprint's own origin, with the footprint's across-reading mapped onto the rotated frame's
 * along-axis and vice versa. Until this existed, a free two-row part's pads routed at their raw
 * unrotated footprint coordinates — the right point only when `rot` was 0 and the footprint's origin
 * happened to coincide with `rowShape`'s anchor, which for a multi-pad socket it does not. The visible
 * symptom was a declared net that tapped the bus copper cleanly and still routed to the wrong physical
 * pin, with nothing in the geometry saying so.
 *
 * Seated (non-free) parts are untouched: `rot` is meaningless there — a seated part's angle comes from
 * the run it breaks, which this function has never had a way to see — so they keep exactly the placement
 * this file always gave them rather than gaining a rotation there is no data for.
 */
export function padPosition(
  part: PlacedPart,
  fp: Footprint,
  padName: string,
  tapeW: number,
  tapeMm: number,
): Vec2 | null {
  // Gated on `isTerminal`, not on the pad merely existing. A footprint's file also holds mechanical pads —
  // an unnamed one, and the `_1`-style repeats the parser mints for duplicate names — and three of the
  // eager library's parts have both. Resolving one of those gives a real, plausible position for a
  // mounting peg, so a hand-written or imported circuit would get copper routed to a hole while looking
  // perfectly well-formed. That is the exact failure this file exists to prevent, so it is refused here as
  // well as at the netlist gate rather than trusting every caller to have checked first.
  const pad = fp[padName];
  if (!pad || !isTerminal(padName, pad)) return null;
  // The placement is the one derivation; this reads a pad through it. Every branch that used to live here —
  // seated, free in-line, free two-row — is now `electronics-parts.ts › placementOf`, expressed once as an
  // origin and a matrix instead of three times as coordinates. Proved equal for every pad of all 129 library
  // parts at every turn and flip in `tests/current/model/placed-component.test.ts`.
  return applyPlacement(placementOf(part, fp, tapeW, tapeMm), padAt(pad));
}

/**
 * Resolve a circuit's netlist into the points each net has to join.
 *
 * Nets with fewer than two terminals come back as a fault and are left out of the routing set: there is
 * nothing to connect, and handing the router a one-point net would have it plan a route of zero length and
 * report success. That is a real authoring mistake — a pad assigned to a net nothing else is on — and the
 * user can only fix it if they are told.
 *
 * **Unless the bus already laid a rail for that net**, which is what `railNets` names. A single pad on PWR
 * is not an authoring mistake when there is a PWR rail on the sheet: it is a part asking to be tapped onto
 * it, and the router can do that (see `planNets`, which routes the tap leg). Reported as a fault and
 * dropped, that pad got no copper at all while the sidebar showed it on a net with three members — the
 * drawing said wired and the circuit was not.
 *
 * A net with NO terminals is still a fault and still dropped, rail or no rail. There is nothing to tap.
 *
 * Order is the author's: nets in declaration order, points in the order the terminals were written. The
 * router's own ordering decisions are the router's, and doing any of them here would hide them.
 */
export function resolveNetlist(
  circuit: Circuit,
  tapeW: number,
  tapeMm: number,
  /** Nets the bus has already laid copper for — see above. Their ids are `Trace2D.net`. */
  railNets: ReadonlySet<string> = new Set(),
): Netlist {
  const faults: NetlistFault[] = [];
  const parts = circuit.parts ?? [];
  const byId = new Map((circuit.nets ?? []).map((n) => [n.id, n]));
  const points = new Map<string, NetPoint[]>();
  /** Parts with at least one terminal on a net — the ones whose metal a run has to clear. */
  const wiredParts = new Set<number>();
  /**
   * Each part placed once, and read many times.
   *
   * The placement is the single derivation every pad position now comes from — see
   * `electronics-parts.ts`. Baked per part rather than per pad because a part with fourteen terminals was
   * otherwise transformed fourteen times over for the net points and fourteen more for the fields.
   */
  const placed = new Map<number, PlacedComponent>();
  const placeOnce = (i: number): PlacedComponent | undefined => {
    const got = placed.get(i);
    if (got) return got;
    const part = parts[i];
    const comp = part ? componentById(part.component) : undefined;
    if (!part || !comp) return undefined;
    const made = placeComponent(part, comp.footprint, tapeW, tapeMm, i);
    placed.set(i, made);
    return made;
  };
  for (const n of circuit.nets ?? []) points.set(n.id, []);

  const seen = new Set<string>();
  for (const t of circuit.terminals ?? []) {
    if (!byId.has(t.net)) {
      faults.push({ kind: "no-such-net", why: `no net "${t.net}"`, net: t.net, part: t.part, pad: t.pad });
      continue;
    }
    const part = parts[t.part];
    if (!part) {
      faults.push({ kind: "no-such-part", why: `no part at index ${t.part}`, part: t.part, pad: t.pad });
      continue;
    }
    const comp = componentById(part.component);
    if (!comp) {
      faults.push({
        kind: "unknown-component",
        why: `part ${t.part} is "${part.component}", which is not in the library`,
        part: t.part,
        pad: t.pad,
      });
      continue;
    }
    // Against the TERMINALS, not against every pad: a mounting peg is a pad in the file and carries no
    // signal, so assigning a net to one is a mistake worth reporting rather than a connection to honour.
    if (!terminals(comp.footprint).some(([name]) => name === t.pad)) {
      faults.push({
        kind: "no-such-pad",
        why: `${part.component} has no terminal "${t.pad}"`,
        part: t.part,
        pad: t.pad,
      });
      continue;
    }
    const key = `${t.part}:${t.pad}`;
    if (seen.has(key)) {
      faults.push({
        kind: "duplicate-terminal",
        why: `pad "${t.pad}" of part ${t.part} is on more than one net`,
        part: t.part,
        pad: t.pad,
        net: t.net,
      });
      continue;
    }
    seen.add(key);
    wiredParts.add(t.part);
    const here = placeOnce(t.part);
    const placedPad = here ? padOf(here, t.pad) : undefined;
    if (!placedPad) continue; // unreachable: `terminals()` above has already accepted this pad name
    const at = placedPad.at;
    // The narrower of two bounds, so this can only ever narrow: the pad's own size, as it always was, and
    // the room between this pad and the metal beside it. On a 1206 the second is the looser and nothing
    // changes; on a 2.54mm pin header it binds, and it is the difference between copper that lands on one
    // pin and copper that blankets its neighbours. See `footprint.ts › nearestTerminalMm`.
    const sepMm = nearestTerminalMm(comp.footprint, t.pad);
    // `PlacedPad.size` is already in flat units and already run-normalised; the min of the two extents is
    // the same number either way round, so no conversion and no transpose is needed here.
    const padWidth = Math.min(
      Math.min(placedPad.size.w, placedPad.size.h),
      landingWidthFor(toFlat(sepMm, tapeW, tapeMm), tapeW, weedGapFor(tapeW, tapeMm)),
    );
    // Where even the floor cannot be weeded, say so. The terminal is still routed, at the floor width —
    // dropping it would be the silent stranding this reporting exists to end. The fault and `stranded`
    // together distinguish "physically impossible on this tape" from "another net got there first".
    if (padRoomFor(toFlat(sepMm, tapeW, tapeMm), tapeW, weedGapFor(tapeW, tapeMm)) < tapeW * MIN_LAND_FRAC) {
      const needMm = ((tapeW * MIN_LAND_FRAC * 2) * tapeMm) / tapeW;
      faults.push({
        kind: "pads-too-close",
        why:
          `${part.component} pad "${t.pad}" is ${sepMm.toFixed(2)}mm from its nearest neighbour. ` +
          `${tapeMm.toFixed(2)}mm tape needs about ${needMm.toFixed(2)}mm between pad centres to land on ` +
          `one and still leave a strip that can be weeded, and cannot be cut narrower than ` +
          `${(tapeMm * MIN_LAND_FRAC).toFixed(2)}mm. This part cannot be broken out pad by pad on this ` +
          `tape: use a larger pattern, a narrower tape, or bridge these pads by hand.`,
        part: t.part,
        pad: t.pad,
        net: t.net,
      });
    }
    points.get(t.net)!.push({ part: t.part, pad: t.pad, at, padWidth });
  }

  const nets: ResolvedNet[] = [];
  for (const n of circuit.nets ?? []) {
    const pts = points.get(n.id)!;
    if (pts.length < 2 && !(pts.length === 1 && railNets.has(n.id))) {
      faults.push({
        kind: "single-terminal-net",
        why:
          pts.length === 0
            ? `net "${n.name}" has no terminals`
            : `net "${n.name}" has only one terminal, so there is nothing to connect it to`,
        net: n.id,
      });
      continue;
    }
    nets.push({ id: n.id, name: n.name, points: pts });
  }

  // The pad fields, once every terminal has been resolved. Built from the PARTS that have a wired terminal
  // rather than from the terminals themselves, so a part's unwired pins are in the field too — see
  // {@link Netlist.fields}.
  const fields: PadField[] = [];
  for (const idx of wiredParts) {
    const here = placeOnce(idx);
    if (!here) continue;
    for (const pad of here.pads) {
      const sep = toFlat(nearestTerminalMm(here.footprint, pad.name), tapeW, tapeMm);
      // `reach` is the part's own pitch: a point nearer to this pad than its neighbour is stands over the
      // part's metal, and a point further away has cleared it and may widen back to the tape.
      fields.push({
        at: pad.at,
        safe: landingWidthFor(sep, tapeW, weedGapFor(tapeW, tapeMm)),
        reach: Number.isFinite(sep) ? sep : 0,
      });
    }
  }
  // And the same pads again as obstacles. Built from EVERY placed part rather than only the wired ones:
  // `fields` narrows copper near a part the netlist is already talking about, but a part with nothing
  // wired to it is still metal on the sheet that another net's tape must not cross.
  const wiredTo = new Map<string, string>();
  for (const t of circuit.terminals ?? []) wiredTo.set(`${t.part}\u0000${padPin(t.pad)}`, t.net);
  const padObstacles: PadObstacle[] = [];
  parts.forEach((_, idx) => {
    const here = placeOnce(idx);
    if (!here) return;
    for (const pad of here.pads) {
      // A mechanical hole carries no copper, so nothing can be shorted through it.
      if (!pad.onCopper) continue;
      padObstacles.push({
        at: pad.at,
        outline: pad.outline,
        // By the PIN, so wiring pad `1` wires `1_1` with it — they are one pin. See {@link padPin}.
        net: wiredTo.get(`${idx}\u0000${padPin(pad.name)}`) ?? null,
        part: idx,
        pad: pad.name,
      });
    }
  });

  return { nets, faults, fields, pads: padObstacles };
}

/**
 * There is no default netlist for a newly placed part, and `defaultTerminals` is gone (2026-08-28).
 *
 * It wired a two-pad part's terminals onto PWR and GND as it was dropped. Only LEDs ever reached it — the
 * editor gated it on the component being an LED — on the reasoning that an anode and a cathode have one
 * pair they can light on. The trouble was that the guess was *stored*: the sidebar showed it as the
 * author's own assignment, and an LED meant for a signal net had to be un-wired before it could be wired.
 * Placing a part and wiring it are two decisions and this made one of them silently.
 */
