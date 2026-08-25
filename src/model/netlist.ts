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
import { isTerminal, padAt, terminals, type Footprint } from "./footprint.js";
import { componentById } from "./library.js";
import { GND_NET_ID, PWR_NET_ID } from "./net-palette.js";

/** One terminal, resolved: which pad of which part, where it is, and the net it is on. */
export interface NetPoint {
  /** Index into `Circuit.parts`. */
  part: number;
  /** The pad's own name in its footprint. */
  pad: string;
  /** Where the pad sits on the flat pattern, in pattern units. */
  at: Vec2;
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
    | "single-terminal-net";
  /** Human-readable, and specific enough to act on. */
  why: string;
  part?: number;
  pad?: string;
  net?: string;
}

export interface Netlist {
  nets: ResolvedNet[];
  faults: NetlistFault[];
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
  const local = padAt(pad);
  const s = part.flip ? -1 : 1;
  return {
    x: part.x + toFlat(local.x * s, tapeW, tapeMm),
    y: part.y + toFlat(local.y * s, tapeW, tapeMm),
  };
}

/**
 * Resolve a circuit's netlist into the points each net has to join.
 *
 * Nets with fewer than two terminals come back as a fault and are left out of the routing set: there is
 * nothing to connect, and handing the router a one-point net would have it plan a route of zero length and
 * report success. That is a real authoring mistake — a pad assigned to a net nothing else is on — and the
 * user can only fix it if they are told.
 *
 * Order is the author's: nets in declaration order, points in the order the terminals were written. The
 * router's own ordering decisions are the router's, and doing any of them here would hide them.
 */
export function resolveNetlist(circuit: Circuit, tapeW: number, tapeMm: number): Netlist {
  const faults: NetlistFault[] = [];
  const parts = circuit.parts ?? [];
  const byId = new Map((circuit.nets ?? []).map((n) => [n.id, n]));
  const points = new Map<string, NetPoint[]>();
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
    const at = padPosition(part, comp.footprint, t.pad, tapeW, tapeMm);
    if (!at) continue; // unreachable: `terminals()` above has already accepted this pad name
    points.get(t.net)!.push({ part: t.part, pad: t.pad, at });
  }

  const nets: ResolvedNet[] = [];
  for (const n of circuit.nets ?? []) {
    const pts = points.get(n.id)!;
    if (pts.length < 2) {
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
  return { nets, faults };
}

/**
 * The nets a newly-placed part's pads should default onto, if any.
 *
 * Placing a two-terminal part and then having to wire both its pads by hand is busywork with exactly one
 * sensible answer: a two-pad part bridges the supply, one pad on each rail. That is what the bus router
 * does for an LED on a hinge without being asked, and a part standing on a tile had no equivalent — it
 * arrived with no terminals at all and stayed unwired until the author did it themselves.
 *
 * Only for a part with exactly TWO terminals, and deliberately so. Three or more and there is no answer
 * to guess: a transistor's pads are not a supply pair, and putting its first two on PWR and GND would be
 * a short stated as a default. Better to leave those to the author than to invent a circuit for them.
 *
 * Returns the assignments rather than applying them, so the caller decides whether an existing terminal on
 * that pad should be kept — re-wiring a pad the author has already assigned would be the same busywork in
 * the other direction.
 *
 * **Which pad gets PWR is the footprint's own order and carries no polarity claim.** `terminals()` yields
 * pads in the order the file lists them, so an LED_1206 defaults anode-to-PWR because its anode happens to
 * be listed first — right for that part, arbitrary for a resistor, and harmless either way because the
 * author can swap it. Nothing here reads polarity out of a pad name, and nothing should start: pad "1" is
 * not a promise about which end is positive, and a part whose datasheet numbers its pads "A" and "K" would
 * make that reading wrong immediately.
 */
export function defaultTerminals(
  partIndex: number,
  fp: Footprint,
  nets: { id: string }[],
): Terminal[] {
  const ts = terminals(fp);
  if (ts.length !== 2) return [];
  // Against the seeded rails BY ID, and only if both are still there. The author may have deleted or
  // renamed them, and a default that pointed at a net which no longer exists would be a `no-such-net`
  // fault raised by the app on the author's behalf — worse than leaving the pads unwired.
  const has = (id: string): boolean => nets.some((n) => n.id === id);
  if (!has(PWR_NET_ID) || !has(GND_NET_ID)) return [];
  return [
    { part: partIndex, pad: ts[0]![0], net: PWR_NET_ID },
    { part: partIndex, pad: ts[1]![0], net: GND_NET_ID },
  ];
}
