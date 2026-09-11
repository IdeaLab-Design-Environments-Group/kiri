/**
 * **Model** — how good a routing plan is, measured.
 *
 * ## Why this is its own file
 *
 * The router searches: it lays several candidate plans and keeps the best one. "Best" is decided here,
 * and nowhere else. Splitting the scoring from the search means a change to what counts as a fault is a
 * change to one small file, and the tests that pin those faults do not have to load the router to check
 * arithmetic over a list of polylines.
 *
 * Everything here is a pure function of already-laid copper — {@link Trace2D}s and {@link PadPair}s in.
 * Nothing plans, nothing mutates, nothing knows how the traces were arrived at. The ranking itself is
 * {@link PlanKey} compared by {@link lexLess}: worst fault first, and the first entry that differs decides.
 */
import type { Vec2 } from "./electronics.js";
import type { PadPair, Trace2D } from "./trace-types.js";
import {
  cross,
  isOrigin,
  polyCrosses,
  ptKey,
  intersection,
  len,
  mid,
  nearPolyline,
  segNearSeg,
  segPointDist,
  segsCross,
  sharesEnd,
  sub,
  unit,
} from "./trace-geometry.js";

/**
 * How good a plan is, as a tuple ranked worst-fault-first — the router's objective.
 *
 * `[ chips, terminals, crossings, defects, length ]`, every entry a count or a length and all of them
 * "lower is better". Compared by {@link lexLess}: the first entry that differs decides, and nothing below
 * it is consulted. Tape under a chip destroys the part, tape over a battery terminal shorts the supply, a
 * PWR×GND crossing shorts the layout, a defect makes the sheet hard to weed, and length is only a
 * tie-breaker — so no amount of one may ever buy a unit of the one above it.
 *
 * **This used to be a weighted sum**, `chips·1e12 + terms·1e9 + crossings·1e6 + defects + length·1e-6`,
 * whose comments claimed exactly the ranking above. It behaved that way only because the constants were far
 * apart: nothing clamped a tier, so a large enough lower tier would have outranked a higher one and the
 * guarantee held by arithmetic accident rather than by construction. Measured before the change, the worst
 * defect tier on the bundled patterns was 214.5 against the 1e6 crossing weight — a margin of about 4,700×,
 * so the separation was in no danger here. That is why the change is output-identical, and it is also why
 * it was worth making: a property that is true by construction does not have to be re-measured whenever a
 * pattern gets bigger.
 *
 * **Index 3 is deliberately a sum, and it is the one place two measures are traded.** See {@link planRoutes}.
 */
export type PlanKey = readonly [
  chips: number,
  terminals: number,
  crossings: number,
  defects: number,
  length: number,
];

/**
 * Whether `a` is a strictly better plan than `b` — lexicographic, short-circuiting at the first difference.
 *
 * `upto` limits the comparison to the leading entries, which is how a caller asks "better on everything
 * except length": pass 4. That replaces subtracting the length term back out of a weighted sum, which was
 * itself a trick that depended on the scale separation holding.
 *
 * Equal keys give `false`, so this is a strict order and `!lexLess(b, a)` is "a is no worse than b".
 */
export function lexLess(a: PlanKey, b: PlanKey, upto: number = a.length): boolean {
  for (let i = 0; i < upto; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}

/** A plan with no fault of any kind left to fix — every entry zero, so the search can stop. */
export function flawless(k: PlanKey): boolean {
  return k.every((v) => v === 0);
}

/** Count PWR×GND proper crossings in `traces` — the property this router exists to keep at zero. */
export function countNetCrossings(traces: Trace2D[]): number {
  let n = 0;
  for (let i = 0; i < traces.length; i++) {
    for (let j = i + 1; j < traces.length; j++) {
      const A = traces[i]!, B = traces[j]!;
      if (A.net === B.net) continue; // same net may overlap freely: single-sided tape, one potential
      for (let a = 1; a < A.pts.length; a++) {
        for (let b = 1; b < B.pts.length; b++) {
          if (segsCross(A.pts[a - 1]!, A.pts[a]!, B.pts[b - 1]!, B.pts[b]!)) n++;
        }
      }
    }
  }
  return n;
}

/** Count traces running over an LED chip body — the other thing that must stay at zero. */
export function countOverLed(traces: Trace2D[], pads: PadPair[]): number {
  let n = 0;
  for (const t of traces) {
    for (const p of pads) {
      if (p.pwr.x === 0 && p.pwr.y === 0 && p.gnd.x === 0 && p.gnd.y === 0) continue;
      // A rail legitimately *lands* on its own pad, so an endpoint touch is not a violation.
      if (polyCrosses(t.pts, p.pwr, p.gnd)) n++;
    }
  }
  return n;
}

/**
 * Chips with copper physically under them.
 *
 * {@link countOverLed} tests zero-width centrelines for a *proper crossing*, which real tape does not
 * honour: a strip whose centreline merely passes close to a chip still sits under it, because the tape is
 * wide. This measures what actually matters -- centreline within `clear` of the chip body -- while allowing
 * the one contact that must exist, the tape landing on its own pad.
 *
 * **This is currently violated: 6-12 chips per model.** `countOverLed` reads zero throughout, which is why
 * it went unnoticed; the zero was an artefact of ignoring tape width. Routing around it is unsolved. One
 * attempt is recorded: approach each pad from beyond it along the chip's own axis, with a width-aware
 * dodge. That measured *worse* (akde-square 0 -> 15 zero-width crossings) because the stand-off point falls
 * outside the tile and its approach segment clips the body. The fix wants the spine to run *along* each
 * hinge so both pads flank the direction of travel -- the same missing property that blocks zero crossings
 * and the lane-sharing that would cut overlap.
 */
export function countUnderLed(
  traces: Trace2D[],
  pads: PadPair[],
  clear: number,
  padR: number,
): number {
  let n = 0;
  for (const pad of pads) {
    if (isOrigin(pad.pwr) && isOrigin(pad.gnd)) continue;
    let bad = false;
    for (const t of traces) {
      // The pad this run is allowed to land on — a rail's own. A declared net has none: it has no business
      // on either of the chip's legs, so nothing is exempt and any copper over the body counts.
      //
      // `t.net === "pwr" ? pad.pwr : pad.gnd` gave every non-rail net GND's pad as its own, which both
      // excused it from real copper over the chip and scored it against the wrong leg.
      const own: Vec2 | null =
        t.net === "pwr" ? pad.pwr : t.net === "gnd" ? pad.gnd : null;
      for (let i = 1; i < t.pts.length && !bad; i++) {
        const a = t.pts[i - 1]!, b = t.pts[i]!;
        const L = len(sub(b, a));
        const steps = Math.max(2, Math.ceil(L / (clear * 0.5)));
        for (let k = 0; k <= steps; k++) {
          const u = k / steps;
          const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
          if (own && len(sub(m, own)) <= padR) continue; // landing on its own pad is the point
          if (segPointDist(pad.pwr, pad.gnd, m) < clear) { bad = true; break; }
        }
      }
      if (bad) break;
    }
    if (bad) n++;
  }
  return n;
}




/**
 * Runs passing under the *other* net's battery terminal.
 *
 * The two terminals sit a couple of millimetres apart, so a run leaving one can sweep straight across the
 * other -- shorting the battery, which is the one short that cannot be fixed with a bit of tape afterwards.
 * A net touching its own terminal is the point; touching the other one is a fault.
 */
export function countUnderTerminal(
  traces: Trace2D[],
  term: PadPair,
  clear: number,
): number {
  let n = 0;
  for (const t of traces) {
    // A rail must clear the OTHER rail's terminal; its own is where it starts. Anything else — a declared
    // net — has no terminal of its own here and must clear both.
    //
    // `t.net === "pwr" ? term.gnd : term.pwr` read every non-PWR net as GND, so a net called `sig` was
    // forbidden from the PWR terminal and free to sweep the GND one. Wrong in both directions at once.
    const forbidden =
      t.net === "pwr" ? [term.gnd] : t.net === "gnd" ? [term.pwr] : [term.pwr, term.gnd];
    for (let i = 1; i < t.pts.length; i++) {
      const a = t.pts[i - 1]!, b = t.pts[i]!;
      if (forbidden.some((f) => segPointDist(a, b, f) < clear)) {
        n++;
        break; // one fault per run is enough to report
      }
    }
  }
  return n;
}

/** Length over which PWR and GND run on top of each other. Same-net overlap is free -- one potential, and
 *  single-sided tape may touch itself -- but the two nets shadowing each other is unbuildable: you cannot
 *  lay the second strip where the first already is. Sampled, so partial overlap counts too.
 *
 *  Currently 11-41% of copper length. It is NOT solved: both nets have to traverse the same spine of the
 *  pattern, and there is no second way through -- tolling a waypoint the other net already used diverts
 *  almost nothing even at 400x. Shifting each net sideways into its own half of the lane cuts overlap
 *  (akde-hex 17% -> 4%) but needs a *shared* centreline to offset from; offsetting each net's own path
 *  instead lets the two lanes swap sides, which measured 5 -> 44 crossings on puffin and put copper back
 *  over chips, so it is not shipped. */
export function overlapLength(traces: Trace2D[], tol: number): number {
  // Each unordered PAIR of distinct nets, once, rather than PWR against GND by name. With declared nets a
  // circuit has more than two, and naming the rails left every other pair unscored — two signal nets could
  // lie on each other for free.
  //
  // Pairs and not "each run against all the others", which is the same idea and is wrong: it charges a
  // PWR/GND overlap twice, once from each side, which is a different number from the one this function has
  // always returned. That number feeds the bus router's own scoring, so doubling it silently re-planned
  // every bundled circuit and cost two tests that had nothing to do with nets. The rails keep their exact
  // reading; the new pairs are additive.
  const nets = [...new Set(traces.map((t) => t.net))];
  const pairs: [string, string][] = [];
  for (let i = 0; i < nets.length; i++) {
    for (let j = i + 1; j < nets.length; j++) {
      // PWR first when this is the rail pair, so the sampled side is the one it has always been.
      const [a, b] = [nets[i]!, nets[j]!];
      pairs.push(b === "pwr" ? [b, a] : [a, b]);
    }
  }
  let shared = 0;
  for (const [from, to] of pairs) {
  const gnd = traces.filter((t) => t.net === to);
  for (const a of traces.filter((t) => t.net === from)) {
    for (let i = 1; i < a.pts.length; i++) {
      const p = a.pts[i - 1]!, q = a.pts[i]!;
      const L = len(sub(q, p));
      if (L < 1e-12) continue;
      const steps = Math.max(2, Math.ceil(L / tol));
      let hits = 0;
      for (let k = 0; k < steps; k++) {
        const u = (k + 0.5) / steps;
        const m = { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u };
        if (gnd.some((b) => nearPolyline(b.pts, m) <= tol)) hits++;
      }
      shared += (L * hits) / steps;
    }
  }
  }
  return shared;
}


/**
 * Length a net lays within `tol` of a non-adjacent part of *itself* — tape laid twice over.
 *
 * Electrically free, since it is one net at one potential, but it is wasted copper and it reads as a mistake:
 * the strip runs out and comes back alongside where it has already been. Segments that share an endpoint are
 * skipped, or every corner would count as its own overlap.
 */
export function selfOverlapLength(traces: Trace2D[], tol: number): number {
  let sum = 0;
  // Every net present, not the two rails by name. A circuit may now carry any number of declared nets, and
  // naming the rails made a routed declared net free to lie on top of itself and cost nothing.
  for (const net of new Set(traces.map((t) => t.net))) {
    const mine = traces.filter((t) => t.net === net);
    for (let ti = 0; ti < mine.length; ti++) {
      const a = mine[ti]!;
      for (let i = 1; i < a.pts.length; i++) {
        const p = a.pts[i - 1]!, q = a.pts[i]!;
        const L = len(sub(q, p));
        if (L < 1e-12) continue;
        const steps = Math.max(2, Math.ceil(L / tol));
        let hits = 0;
        for (let k = 0; k < steps; k++) {
          const u = (k + 0.5) / steps;
          const m = { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u };
          let near = false;
          for (let tj = 0; tj < mine.length && !near; tj++) {
            const b = mine[tj]!;
            for (let j = 1; j < b.pts.length && !near; j++) {
              if (tj === ti && Math.abs(j - i) <= 1) continue;
              const c = b.pts[j - 1]!, d = b.pts[j]!;
              // Cheap rejection first: most segment pairs are nowhere near each other, and the distance test
              // is what made scoring every candidate cost seconds.
              if (m.x < Math.min(c.x, d.x) - tol || m.x > Math.max(c.x, d.x) + tol) continue;
              if (m.y < Math.min(c.y, d.y) - tol || m.y > Math.max(c.y, d.y) + tol) continue;
              if (sharesEnd(p, q, c, d)) continue;
              if (segPointDist(c, d, m) <= tol) near = true;
            }
          }
          if (near) hits++;
        }
        sum += (L * hits) / steps;
      }
    }
  }
  return sum;
}


/**
 * Joins where two runs of one net leave the same point at a sharp angle.
 *
 * A cutter has to weed the substrate between them, and a narrow wedge tears or lifts instead of coming away —
 * so two strips doubling back alongside each other are a cutting defect, not just an untidy one.
 */
export function countAcuteJoins(traces: Trace2D[], minAngle = Math.PI / 6): number {
  let n = 0;
  // Every net present, not the two rails by name: a declared net's runs meet at sharp angles and tear the
  // substrate exactly as a rail's do. For a bus circuit the set is precisely {pwr, gnd}, so this reads the
  // same number it always has.
  for (const net of new Set(traces.map((t) => t.net))) {
    const mine = traces.filter((t) => t.net === net);
    const at = new Map<string, Vec2[]>();
    for (const t of mine) {
      for (let i = 0; i < t.pts.length; i++) {
        const here = t.pts[i]!;
        const away = t.pts[i === 0 ? 1 : i - 1];
        if (!away) continue;
        const k = ptKey(here);
        at.set(k, [...(at.get(k) ?? []), { x: away.x - here.x, y: away.y - here.y }]);
      }
    }
    for (const dirs of at.values()) {
      for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
          const a = Math.atan2(dirs[i]!.y, dirs[i]!.x);
          const b = Math.atan2(dirs[j]!.y, dirs[j]!.x);
          let d = Math.abs(a - b);
          if (d > Math.PI) d = 2 * Math.PI - d;
          if (d < minAngle) n++;
        }
      }
    }
  }
  return n;
}

/**
 * Where two runs of one net meet, stop the redundant one at the meeting point.
 *
 * The connection is made where they touch — everything past that is copper laid for nothing, and on a cut sheet
 * it is a second strip to weed and stick down alongside the first. So the run is truncated at the crossing,
 * keeping its shape and simply ending earlier.
 *
 * Only a tail that reaches nothing is removed: if the part beyond the crossing carries a pad or a terminal, it
 * is the reason that run exists and it stays.
 *
 * This handles runs that *cross*. Runs that merely lie alongside each other were tried too -- dropping a tail
 * already covered by another run of its own net -- and were not worth it: repeated tape stayed at the same 26%
 * across the bundled patterns, because what is left is mid-run parallelism rather than redundant ends, and it
 * split church's copper from four strips into eight. Mid-run doubling cannot be trimmed without cutting the
 * connection; it has to not be routed that way in the first place.
 */
export function trimAtOwnJoins(traces: Trace2D[], required: Vec2[]): Trace2D[] {
  const needed = new Set(required.map(ptKey));
  const out = traces.map((t) => ({ ...t, pts: t.pts.slice() }));

  // Junctions count as required too. A tail past a crossing may be where another run of this net attaches, and
  // cutting it strands that run and everything beyond it -- an open circuit, not a saving. Pads and terminals
  // alone were not enough: this orphaned a pad on puffin.
  const seen = new Map<string, number>();
  for (const t of out) {
    for (const k of new Set(t.pts.map(ptKey))) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) if (n > 1) needed.add(k);

  // Longest redundant tail first, and re-checked each round: which run gives way should be the one with more
  // copper to save, not whichever happens to come first in the list.
  for (;;) {
    let best: { i: number; fromEnd: boolean; cut: { index: number; at: Vec2 }; saved: number } | null = null;
    for (let i = 0; i < out.length; i++) {
      const t = out[i]!;
      const others = out.filter((o, k) => k !== i && o.net === t.net);
      if (!others.length) continue;
      for (const fromEnd of [true, false]) {
        const cut = firstJoin(t.pts, others, fromEnd);
        if (!cut) continue;
        const tail = fromEnd ? t.pts.slice(cut.index + 1) : t.pts.slice(0, cut.index + 1);
        if (!tail.length || tail.some((p) => needed.has(ptKey(p)))) continue;
        const from = fromEnd ? cut.at : cut.at;
        let saved = len(sub(tail[fromEnd ? 0 : tail.length - 1]!, from));
        for (let k = 1; k < tail.length; k++) saved += len(sub(tail[k]!, tail[k - 1]!));
        if (!best || saved > best.saved) best = { i, fromEnd, cut, saved };
      }
    }
    if (!best) break;
    const t = out[best.i]!;
    t.pts = best.fromEnd
      ? [...t.pts.slice(0, best.cut.index + 1), best.cut.at]
      : [best.cut.at, ...t.pts.slice(best.cut.index + 1)];
    // Junctions can appear or vanish as runs shorten, so the protected set is rebuilt before the next round.
    const again = new Map<string, number>();
    for (const o of out) for (const k of new Set(o.pts.map(ptKey))) again.set(k, (again.get(k) ?? 0) + 1);
    for (const [k, n] of again) if (n > 1) needed.add(k);
  }

  return out.filter((t) => t.pts.length >= 2);
}



/** The crossing nearest the chosen end of `pts`, as the index of the segment before it and the point itself. */
function firstJoin(
  pts: Vec2[],
  others: Trace2D[],
  fromEnd: boolean,
): { index: number; at: Vec2 } | null {
  const order = fromEnd
    ? [...Array(pts.length - 1).keys()].reverse()
    : [...Array(pts.length - 1).keys()];
  for (const i of order) {
    const a = pts[i]!, b = pts[i + 1]!;
    for (const o of others) {
      for (let j = 1; j < o.pts.length; j++) {
        const c = o.pts[j - 1]!, d = o.pts[j]!;
        if (!segsCross(a, b, c, d)) continue;
        const at = intersection(a, b, c, d);
        if (at) return { index: i, at };
      }
    }
  }
  return null;
}


/** Total copper length. */
export function totalLength(traces: Trace2D[]): number {
  let s = 0;
  for (const t of traces) {
    for (let i = 1; i < t.pts.length; i++) s += len(sub(t.pts[i]!, t.pts[i - 1]!));
  }
  return s;
}

