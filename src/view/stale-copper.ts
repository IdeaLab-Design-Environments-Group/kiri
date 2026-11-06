/**
 * **View helper** — the plan on screen, with a deleted part taken out of it (issue #64).
 *
 * Under Manual routing an edit leaves the last plan drawn, faded, until Route is pressed. That is the honest
 * picture for a part that moved — its copper really is where it was — but not for one that was deleted:
 * faded copper still ran to an LED that was no longer there. Worse, the plan's per-LED lists are indexed by
 * position in `circuit.leds`, so once one LED was gone every LED after it was drawn on its predecessor's
 * pads. These take the deleted part out of the plan the moment it is deleted, and shift the indices of the
 * ones after it, so the stale picture is the old plan minus what was removed rather than the old plan.
 *
 * Pure: a plan in, a plan out. Nothing is re-planned; the copper stays marked out of date.
 */
import type { PartSpan, RoutedCircuit, Trace2D } from "../model/electronics-routing.js";
import type { Vec2 } from "../model/electronics.js";

/** Indices into a list one entry shorter, once entry `gone` has been taken out of it. */
function closeUp(indices: readonly number[], gone: number): number[] {
  return indices.filter((i) => i !== gone).map((i) => (i > gone ? i - 1 : i));
}

/**
 * The plan without LED `index`: its pads, its reachability, and every run of copper that comes within
 * `reach` (flat units) of either of its pads.
 *
 * A zeroed pad pair — an LED the router never reached — has no copper to take away; its entry still goes,
 * so the LEDs after it keep their own pads.
 */
export function withoutLed(routed: RoutedCircuit, index: number, reach: number): RoutedCircuit {
  const gone = routed.pads[index];
  const ends: Vec2[] = gone ? [gone.pwr, gone.gnd].filter((p) => p.x !== 0 || p.y !== 0) : [];
  const leadsThere = (t: Trace2D): boolean =>
    t.pts.some((p) => ends.some((e) => Math.hypot(p.x - e.x, p.y - e.y) <= reach));
  return {
    ...routed,
    traces: routed.traces.filter((t) => !leadsThere(t)),
    pads: routed.pads.filter((_, i) => i !== index),
    unreachable: closeUp(routed.unreachable, index),
    ...(routed.unseated ? { unseated: closeUp(routed.unseated, index) } : {}),
  };
}

/** Where the plan keeps each kind of part. */
const FIELD = { part: "parts", resistor: "resistors", switch: "switches" } as const;

/** The plan without placed part `index` of this kind, and the parts after it renumbered to match. */
export function withoutPart(routed: RoutedCircuit, kind: keyof typeof FIELD, index: number): RoutedCircuit {
  const field = FIELD[kind];
  const spans = (routed[field] ?? []) as (PartSpan & { source?: number })[];
  const kept = spans
    .filter((s) => s.source !== index)
    .map((s) => (s.source !== undefined && s.source > index ? { ...s, source: s.source - 1 } : s));
  return { ...routed, [field]: kept };
}
