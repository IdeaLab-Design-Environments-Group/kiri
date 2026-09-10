/**
 * **Model** — the copper under each LED leg, laid after the bus is routed.
 *
 * Seating a part is not routing it. The rail stops short of the chip so the two nets keep the body gap
 * bare, and the last stretch of copper each leg stands on is laid unconditionally afterwards — extending
 * the run that already ends on the pad where that carries on the way it was going, and as a short strip
 * of its own where no run ends there. See {@link seatLedLegs} for what each branch is measured against.
 *
 * It lives apart from `electronics-routing.ts` because it needs nothing from the router: given the laid
 * traces, the tour's targets and the pad pairs it is pure planar geometry, and the routing module is at
 * its size budget. All geometry is flat-pattern 2D mm (the SVG export frame).
 */
import { add, near, scale, sub, unit } from "./trace-geometry.js";
import type { PadPair, Trace2D } from "./trace-types.js";
import type { Target } from "./led-tour.js";

/**
 * The copper under each LED leg.
 *
 * Laid as an extension of the run that already ends on the pad, not as a strip of its own. As its own
 * run it doubled the strip count — one LED came out as four runs rather than two — and a second strip
 * lying against the first is also what produced the self-overlap and the acute joins the router is
 * measured on. A leg is the last inch of the rail, so it is the same piece of tape.
 *
 * A leg is `padW` long and sits **outboard** of the copper end the rail arrives at: the two nets stop
 * `gap` apart so the chip's body has bare pattern under it, which puts every millimetre of both legs
 * past where the rail stops. So the leg's own copper is not something routing produces — it is part of
 * seating the part, like the switch's lands, and it is laid whether or not the route happened to arrive
 * in a shape that covers it.
 *
 * It had to become unconditional. `landPads` squares an approach into the axis where it can, and where it
 * can it lays exactly this rectangle as part of the rail, so nothing is added; but it only ever sees a pad
 * a run *ends* at, and it refuses a bend that would fold back or reach off the shape. Over the six bundled
 * patterns that left most legs partly or wholly off their own copper — measured on a 19x19 grid over each
 * leg, the worst leg on a pattern held 24-42% of its area, and the best 91%, scattered by which landings
 * happened to square rather than by anything about the part. With the land laid every leg sits on copper
 * along its whole length, and what is left uncovered is only the overhang across the axis that
 * {@link landingWidth} deliberately leaves (see its floor).
 *
 * Skipped where the rail already runs down the leg — that is `landPads` having done it — so a squared
 * landing stays one continuous strip of tape rather than gaining a second one lying exactly on top.
 */
export function seatLedLegs(laid: Trace2D[], targets: Target[], pads: PadPair[]): Trace2D[] {
  // Worked on a copy: `laid` is the routed set and the caller still holds it.
  const runs: Trace2D[] = laid.map((t) => ({ ...t, pts: [...t.pts] }));
  for (const t of targets) {
    const pair = pads[t.slot];
    if (!pair?.component) continue;
    for (const net of ["pwr", "gnd"] as const) {
      const own = net === "pwr" ? pair.pwr : pair.gnd;
      const mate = net === "pwr" ? pair.gnd : pair.pwr;
      const axis = unit(sub(own, mate));
      const anchor = add(own, scale(axis, t.reach));
      const already = runs.some(
        (r) =>
          r.net === net &&
          r.pts.some(
            (p, i) =>
              i > 0 &&
              ((near(p, own) && near(r.pts[i - 1]!, anchor)) ||
                (near(p, anchor) && near(r.pts[i - 1]!, own))),
          ),
      );
      if (already) continue;
      // Extend the run that already ends on this pad rather than laying a second strip beside it — but
      // only where the leg carries on the way the run was already going.
      //
      // The leg points outboard, away from the other pad. A run that arrived at the pad FROM outboard has
      // already laid that copper, and appending the leg folds it back along itself: the strip doubles up,
      // and the outline's miter at a 180-degree reversal throws a long spike out past the pad and into the
      // bare gap the chip body has to sit on. That spike was copper across the LED's own terminals —
      // measured before this guard, every LED on house, church and puffin had copper in its body gap,
      // covering up to 12 of 19 samples across it.
      const host = runs.find((r) => r.net === net && (near(r.pts[0]!, own) || near(r.pts[r.pts.length - 1]!, own)));
      if (host) {
        const atEnd = near(host.pts[host.pts.length - 1]!, own);
        const prev = atEnd ? host.pts[host.pts.length - 2] : host.pts[1];
        // Which way the run was travelling as it arrived, against the way the leg goes.
        const came = prev ? unit(sub(own, prev)) : axis;
        const carriesOn = came.x * axis.x + came.y * axis.y > 0;
        if (carriesOn) {
          if (atEnd) host.pts.push(anchor);
          else host.pts.unshift(anchor);
          continue;
        }
        // The run already covers the leg, but it arrives at an ANGLE to the LED's axis, and a strip's end
        // is squared off across its own direction — so one corner of that cap swings round and pokes into
        // the bare gap the chip body sits on. Measured on house: the gnd run reached about a third of the
        // way across five of the six gaps. Bringing the last stretch onto the axis turns the cap square to
        // the gap instead, and squares the pad onto the tape at the same time.
        if (prev && Math.abs(came.x * axis.x + came.y * axis.y) < 0.999) {
          // Outboard of the pad, the side the run is already coming from — inboard would lay copper
          // straight across the gap, which is the very thing this is here to stop.
          const along = anchor;
          if (atEnd) host.pts.splice(host.pts.length - 1, 0, along);
          else host.pts.splice(1, 0, along);
        }
      } else {
        // A separate strip from the pad outboard along the leg, where no run ENDS on this pad.
        //
        // It looks redundant when a run already passes through the pad, and guarding on that does cut the
        // strip count hard — puffin at twelve LEDs goes 25 runs to 14. But it is not redundant, and the
        // measurement says so: a run that merely passes the pad is narrowed by {@link landingWidth} to
        // keep the two nets apart under the chip, which caps it at 1.14mm beneath a 1.70mm pad. Guarding
        // the stub took GND coverage from 96-100% down to 30-99%, LEDs at 42%, 50%, 30%. The stub lands
        // END-ON, which is exempt from that narrowing, and full-width copper under the leg is the whole
        // reason the chip lights.
        //
        // So the extra strips are bought, not accidental: strip count against pad coverage, and coverage
        // is the one that decides whether the circuit works.
        runs.push({ net, pts: [own, anchor] });
      }
    }
  }
  return runs;
}

