/**
 * Whether a hand-drawn wire can be built on the folded sheet.
 *
 * Three claims, stated as properties of real patterns rather than as golden geometry: the checker reads
 * copper *width* and not just centrelines, it charges the author only for what their own wire adds, and it
 * reads net identity the way the rest of the codebase does — so the same polyline is clean on its own rail
 * and a short when it is drawn unnamed.
 *
 * `akde-hex.fkld` throughout, because it is the one example carrying both `M` hinges and shallow `V` ones,
 * which is what makes the fold-fatigue contrast testable at all rather than assumed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  flatFaces,
  gapGraph,
  ledOf,
  pointInFace,
  type Circuit,
  type GapEdge,
  type Led,
  type Vec2,
} from "../../../src/model/electronics.js";
import {
  batteryTerminals,
  countAcuteJoins,
  countNetCrossings,
  countOverLed,
  countUnderLed,
  countUnderTerminal,
  patternDiag,
  planRoutes,
  segsCross,
  tapeOnBody,
  tapeWidthFor,
  type RoutedCircuit,
  type Trace2D,
} from "../../../src/model/electronics-routing.js";
import {
  ALL_WIRE_FAULT_KINDS,
  ERRORS,
  WARNINGS,
  checkWire,
  isBuildable,
  type WireFaultKind,
} from "../../../src/model/wire-rules.js";
import type { WireContext } from "../../../src/model/manual-wire.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** A routed pattern and the context a wire is checked against — the fixture every test here starts from. */
function fixture(name = "akde-hex.fkld", ledCount = 3) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const seen = new Set<string>();
  const leds: Led[] = [];
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const k = `${l.a}_${l.b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    leds.push(l);
    if (leds.length >= ledCount) break;
  }
  const circuit: Circuit = { leds, battery: { face: 0 } };
  const tapeW = tapeWidthFor(faces);
  const routed = planRoutes(faces, gaps, circuit);
  const ctx: WireContext = { faces, gaps, circuit, tapeW };
  return { faces, gaps, circuit, tapeW, routed, ctx };
}

const kinds = (fs: { kind: WireFaultKind }[]): WireFaultKind[] => fs.map((f) => f.kind);

/** A segment straight across the hinge, `d` either side of its midpoint along the hinge's own normal. */
function acrossHinge(g: GapEdge, d: number): Vec2[] {
  const ex = g.ends[1].x - g.ends[0].x, ey = g.ends[1].y - g.ends[0].y;
  const L = Math.hypot(ex, ey);
  const nx = -ey / L, ny = ex / L;
  return [
    { x: g.point.x - nx * d, y: g.point.y - ny * d },
    { x: g.point.x + nx * d, y: g.point.y + ny * d },
  ];
}

/** Distance from `p` to segment `ab` — for checking a reported point really lies on the runs it names. */
function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const L2 = abx * abx + aby * aby;
  const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/**
 * The width test at a single point of `ab`, oriented along it.
 *
 * {@link tapeOnBody} takes its normal from the segment's own direction, so a degenerate segment `(p, p)`
 * silently becomes a centreline test — the very reading the checker exists to replace. A short segment
 * through `p` along `ab` keeps the strip pointing the way the wire points.
 */
function tapeAt(faces: ReturnType<typeof flatFaces>, tapeW: number, p: Vec2, a: Vec2, b: Vec2): boolean {
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ex = ((b.x - a.x) / L) * 1e-6, ey = ((b.y - a.y) / L) * 1e-6;
  return tapeOnBody(faces, tapeW, { x: p.x - ex, y: p.y - ey }, { x: p.x + ex, y: p.y + ey });
}

/** Deterministic PRNG (mulberry32). Seeded, because a property that only sometimes holds is not a property. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("model/wire-rules", () => {
  it("finds nothing wrong with a wire laid along copper of its own net", { timeout: 20_000 }, () => {
    const { ctx, routed } = fixture();
    // A chord between two points of one routed GND run: on the material, on its own net, ends on copper.
    const wire: Trace2D = { pts: [{ x: 12.5, y: -37.4 }, { x: 14.8, y: -37.0 }], net: "gnd" };
    const faults = checkWire(wire, ctx, routed);
    expect(faults).toEqual([]);
    expect(isBuildable(faults)).toBe(true);
  });

  it("reports off-body for a wire whose centreline is on the sheet but whose half-width is not", { timeout: 20_000 }, () => {
    const { faces, ctx, routed, tapeW } = fixture();
    // Parallel to face 0's bottom edge (y = -132.29), inset less than half a tape width.
    const y = -132.29 + 0.8;
    const a = { x: -20, y }, b = { x: 20, y };

    // The control, and the whole point of the test: a centreline reading passes this wire.
    expect(pointInFace(faces, a)).toBeGreaterThanOrEqual(0);
    expect(pointInFace(faces, b)).toBeGreaterThanOrEqual(0);
    expect(pointInFace(faces, { x: 0, y })).toBeGreaterThanOrEqual(0);
    // The width-aware reading does not.
    expect(tapeOnBody(faces, tapeW, a, b)).toBe(false);

    const faults = checkWire({ pts: [a, b], net: "w" }, ctx, routed);
    expect(kinds(faults)).toContain("off-body");
    expect(isBuildable(faults)).toBe(false);
    // And the point it reports is on the wire, not somewhere else on the sheet...
    const at = faults.find((f) => f.kind === "off-body")!.at;
    expect(distToSeg(at, a, b)).toBeLessThan(1e-9);
    // ...and is a point the check itself rejected: the strip there really has no material under it.
    expect(tapeAt(faces, tapeW, at, a, b)).toBe(false);
  });

  it("reports the point where the tape first leaves the material, not the middle of the run", { timeout: 20_000 }, () => {
    const { faces, ctx, routed, tapeW } = fixture();
    // Straight down through face 0 and out through the bottom edge, so that most of the run is on the
    // material and the crossing is past the halfway mark. The midpoint is therefore a point the wire is
    // perfectly fine at, and reporting it would be reporting the wrong place.
    const a = { x: 0, y: -100 }, b = { x: 0, y: -140 };
    const mid = { x: 0, y: -120 };
    expect(tapeAt(faces, tapeW, a, a, b)).toBe(true);
    expect(tapeAt(faces, tapeW, mid, a, b)).toBe(true);

    const at = checkWire({ pts: [a, b], net: "w" }, ctx, routed).find((f) => f.kind === "off-body")!.at;
    expect(distToSeg(at, a, b)).toBeLessThan(1e-9);
    // The strip is off the material where it points...
    expect(tapeAt(faces, tapeW, at, a, b)).toBe(false);
    // ...and that is where it first goes off, within the resolution the check samples at. Found here by an
    // independent fine scan, so the claim is about the pattern rather than about the sampling loop.
    let first = Infinity;
    for (let k = 0; k <= 20_000; k++) {
      const y = a.y + (b.y - a.y) * (k / 20_000);
      if (!tapeAt(faces, tapeW, { x: 0, y }, a, b)) { first = y; break; }
    }
    expect(Number.isFinite(first)).toBe(true);
    expect(Math.abs(at.y - first)).toBeLessThanOrEqual(tapeW * 0.5);
    // Which the midpoint is not, by a wide margin — the fallback is a fallback, not the answer.
    expect(Math.abs(mid.y - first)).toBeGreaterThan(tapeW * 0.5);
  });

  it("clears the same wire once it is inset by more than half a tape width", { timeout: 20_000 }, () => {
    const { faces, ctx, routed, tapeW } = fixture();
    const y = -132.29 + tapeW * 0.5 + 0.4;
    const a = { x: -20, y }, b = { x: 20, y };
    expect(tapeOnBody(faces, tapeW, a, b)).toBe(true);
    expect(kinds(checkWire({ pts: [a, b], net: "w" }, ctx, routed))).not.toContain("off-body");
  });

  it("reports over-led for a wire drawn across an LED's legs", { timeout: 20_000 }, () => {
    const { ctx, routed } = fixture();
    const pad = routed.pads[0]!;
    const mx = (pad.pwr.x + pad.gnd.x) / 2, my = (pad.pwr.y + pad.gnd.y) / 2;
    const dx = pad.gnd.x - pad.pwr.x, dy = pad.gnd.y - pad.pwr.y, L = Math.hypot(dx, dy);
    const px = -dy / L, py = dx / L; // across the chip's axis, so it passes between the two legs
    const wire: Trace2D = { pts: [{ x: mx - px * 4, y: my - py * 4 }, { x: mx + px * 4, y: my + py * 4 }], net: "w" };

    const faults = checkWire(wire, ctx, routed);
    const led = faults.find((f) => f.kind === "over-led");
    expect(led).toBeDefined();
    expect(led!.led).toBe(0); // named, so the canvas can point at the chip rather than at the sheet
    expect(isBuildable(faults)).toBe(false);
  });

  it("does not charge a wire for a chip the routed copper had already spoiled", { timeout: 20_000 }, () => {
    const { ctx, routed } = fixture();
    const pad = routed.pads[0]!;
    const mx = (pad.pwr.x + pad.gnd.x) / 2, my = (pad.pwr.y + pad.gnd.y) / 2;
    const dx = pad.gnd.x - pad.pwr.x, dy = pad.gnd.y - pad.pwr.y, L = Math.hypot(dx, dy);
    const px = -dy / L, py = dx / L;
    const over = (n: string): Trace2D => ({
      pts: [{ x: mx - px * 4, y: my - py * 4 }, { x: mx + px * 4, y: my + py * 4 }], net: n,
    });

    // The very same copper, already on the sheet before the author drew anything.
    const spoiled: RoutedCircuit = { ...routed, traces: [...routed.traces, over("pwr")] };
    expect(kinds(checkWire(over("w"), ctx, spoiled))).not.toContain("over-led");
    // ...while against the circuit as actually routed, that wire is the one that spoils the chip.
    expect(kinds(checkWire(over("w"), ctx, routed))).toContain("over-led");
  });

  it("reports over-led for a wire lying alongside a chip without ever crossing its axis", { timeout: 20_000 }, () => {
    const { ctx, routed, tapeW } = fixture();
    // `countOverLed` reads zero-width centrelines for a proper crossing of the pad-to-pad segment;
    // `countUnderLed` reads tape width against the chip body. A run parallel to the chip's own axis, offset
    // by less than half a strip, is under the body and crosses nothing — so only the second reading sees it,
    // which is what makes the two a disjunction rather than one subsuming the other.
    const pad = routed.pads[0]!;
    const dx = pad.gnd.x - pad.pwr.x, dy = pad.gnd.y - pad.pwr.y, L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L;          // along the chip's axis
    const px = -dy / L, py = dx / L;         // across it
    const off = 1.0;                          // less than the half tape width `overLed` clears by
    expect(off).toBeLessThan(tapeW * 0.5);
    const mx = (pad.pwr.x + pad.gnd.x) / 2 + px * off;
    const my = (pad.pwr.y + pad.gnd.y) / 2 + py * off;
    const wire: Trace2D = { pts: [{ x: mx - ux * 5, y: my - uy * 5 }, { x: mx + ux * 5, y: my + uy * 5 }], net: "w" };

    const one = [pad];
    const after = [...routed.traces, wire];
    const clear = tapeW * 0.5, padR = clear * 1.2;
    // The crossing reading is blind to this wire...
    expect(countOverLed(after, one) - countOverLed(routed.traces, one)).toBe(0);
    // ...the width-aware one is not...
    expect(countUnderLed(after, one, clear, padR) - countUnderLed(routed.traces, one, clear, padR)).toBe(1);
    // ...and the checker reports the chip, because it asks both.
    const led = checkWire(wire, ctx, routed).find((f) => f.kind === "over-led");
    expect(led).toBeDefined();
    expect(led!.led).toBe(0);
  });

  it("reports crosses-net where a wire crosses another net's run, at a point on both runs", { timeout: 20_000 }, () => {
    const { ctx, routed } = fixture();
    const gnd = routed.traces.find((t) => t.net === "gnd" && t.pts.length > 3)!;
    const a0 = gnd.pts[1]!, b0 = gnd.pts[2]!;
    const mx = (a0.x + b0.x) / 2, my = (a0.y + b0.y) / 2;
    const gx = b0.x - a0.x, gy = b0.y - a0.y, L = Math.hypot(gx, gy);
    const qx = -gy / L, qy = gx / L;
    const wire: Trace2D = { pts: [{ x: mx - qx * 6, y: my - qy * 6 }, { x: mx + qx * 6, y: my + qy * 6 }], net: "pwr" };

    const faults = checkWire(wire, ctx, routed);
    const hit = faults.find((f) => f.kind === "crosses-net" && f.net === "gnd");
    expect(hit).toBeDefined();
    expect(isBuildable(faults)).toBe(false);
    // The reported point lies on the wire AND on the run it names — the two segments `segsCross` agreed on.
    expect(distToSeg(hit!.at, wire.pts[0]!, wire.pts[1]!)).toBeLessThan(1e-6);
    let onGnd = Infinity;
    for (let i = 1; i < gnd.pts.length; i++) onGnd = Math.min(onGnd, distToSeg(hit!.at, gnd.pts[i - 1]!, gnd.pts[i]!));
    expect(onGnd).toBeLessThan(1e-6);
    expect(segsCross(wire.pts[0]!, wire.pts[1]!, a0, b0)).toBe(true);
  });

  it("reads the same geometry as a short when unnamed and as clean on its own net", { timeout: 20_000 }, () => {
    const { ctx, routed } = fixture();
    const gnd = routed.traces.find((t) => t.net === "gnd" && t.pts.length > 3)!;
    const a0 = gnd.pts[1]!, b0 = gnd.pts[2]!;
    const mx = (a0.x + b0.x) / 2, my = (a0.y + b0.y) / 2;
    const gx = b0.x - a0.x, gy = b0.y - a0.y, L = Math.hypot(gx, gy);
    const qx = -gy / L, qy = gx / L;
    const pts = [{ x: mx - qx * 6, y: my - qy * 6 }, { x: mx + qx * 6, y: my + qy * 6 }];

    // On its own net there is no short: single-sided tape at one potential may cross itself freely.
    expect(kinds(checkWire({ pts, net: "gnd" }, ctx, routed))).not.toContain("crosses-net");
    // Named for the other rail it is a short...
    expect(kinds(checkWire({ pts, net: "pwr" }, ctx, routed))).toContain("crosses-net");
    // ...and unnamed it is one too, because `resolveWire` gives an unnamed wire its own id as its net, which
    // differs from every other net. Unclaimed copper joins what it touches and nothing else.
    expect(kinds(checkWire({ pts, net: "wire-7" }, ctx, routed))).toContain("crosses-net");
  });

  it("reports a short where a wire runs across the battery terminal of the rail it does not own", { timeout: 20_000 }, () => {
    const { faces, ctx, routed, tapeW } = fixture();
    const face = faces[ctx.circuit.battery!.face]!;
    const term = batteryTerminals(face.centroid, patternDiag(faces), face.poly, tapeW);
    const clear = term.half + tapeW * 0.5; // the router's own `termClear` — both must mean the same thing

    // Straight through the PWR pole, and crossing no copper on the way: the only thing wrong with this run
    // is the pole it lies across, so nothing else can account for the fault.
    const pts = [{ x: term.pwr.x, y: term.pwr.y - 6 }, { x: term.pwr.x, y: term.pwr.y + 6 }];
    for (const o of routed.traces) {
      for (let i = 1; i < o.pts.length; i++) expect(segsCross(pts[0]!, pts[1]!, o.pts[i - 1]!, o.pts[i]!)).toBe(false);
    }
    expect(countUnderTerminal(routed.traces, term, clear)).toBe(0);

    // Carrying GND, this run bridges the cell's two poles through whatever else it touches.
    const shorted = checkWire({ pts, net: "gnd" }, ctx, routed);
    const hit = shorted.find((f) => f.kind === "crosses-net" && f.net === "pwr");
    expect(hit).toBeDefined();
    expect(hit!.at.x).toBeCloseTo(term.pwr.x, 9);
    expect(hit!.at.y).toBeCloseTo(term.pwr.y, 9);
    expect(isBuildable(shorted)).toBe(false); // the one short that cannot be taped over afterwards
    expect(countUnderTerminal([...routed.traces, { pts, net: "gnd" }], term, clear)).toBeGreaterThan(0);

    // The same copper carrying PWR lands on its own terminal, which is where a PWR rail is meant to start.
    expect(kinds(checkWire({ pts, net: "pwr" }, ctx, routed))).not.toContain("crosses-net");
    // Unnamed it owns neither pole, so it shorts the cell just as the GND-named run does.
    const unnamed = checkWire({ pts, net: "wire-7" }, ctx, routed);
    expect(unnamed.find((f) => f.kind === "crosses-net" && f.net === "pwr")).toBeDefined();
  });

  it("counts exactly the crossings its faults report", { timeout: 20_000 }, () => {
    const { ctx, routed } = fixture();
    const gnd = routed.traces.find((t) => t.net === "gnd" && t.pts.length > 3)!;
    const a0 = gnd.pts[1]!, b0 = gnd.pts[2]!;
    const mx = (a0.x + b0.x) / 2, my = (a0.y + b0.y) / 2;
    const gx = b0.x - a0.x, gy = b0.y - a0.y, L = Math.hypot(gx, gy);
    const qx = -gy / L, qy = gx / L;

    for (const net of ["pwr", "gnd", "wire-7"]) {
      const wire: Trace2D = { pts: [{ x: mx - qx * 6, y: my - qy * 6 }, { x: mx + qx * 6, y: my + qy * 6 }], net };
      const delta = countNetCrossings([...routed.traces, wire]) - countNetCrossings(routed.traces);
      // Adding a run can only add crossings, never remove one, so the delta is the wire's own doing.
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(kinds(checkWire(wire, ctx, routed)).includes("crosses-net")).toBe(delta > 0);
    }
  });

  it("warns of fold fatigue across a mountain hinge and not across a shallow valley", { timeout: 20_000 }, () => {
    const { gaps, ctx, routed } = fixture();
    const mountain = gaps.find((g) => g.assignment === "M")!;
    const valley = gaps.find((g) => g.assignment === "V")!;
    // The fixture only means anything if the valley really is the shallow kind `buildCorridor` lets pass.
    expect(valley.dihedral == null || Math.abs(valley.dihedral) <= 170).toBe(true);

    const overM = checkWire({ pts: acrossHinge(mountain, 8), net: "w" }, ctx, routed);
    const overV = checkWire({ pts: acrossHinge(valley, 8), net: "w" }, ctx, routed);
    expect(kinds(overM)).toContain("fold-fatigue");
    expect(kinds(overV)).not.toContain("fold-fatigue");
    // Costly, not forbidden: a mountain crossing on its own must never block the cut.
    expect(isBuildable(overM.filter((f) => f.kind === "fold-fatigue"))).toBe(true);
  });

  it("ranks proximity to another net by distance: on top of it, near it, then clear", { timeout: 20_000 }, () => {
    const { ctx, routed, tapeW } = fixture();
    // The GND run along y = -69.4, with the wire parallel to it at a growing centreline separation.
    const at = (d: number) => kinds(checkWire({ pts: [{ x: -10, y: -69.4 + d }, { x: 10, y: -69.4 + d }], net: "pwr" }, ctx, routed));
    // Written in tape widths, not in millimetres: both bounds scale with `tapeW`, and a literal would only
    // land in the right band on a pattern whose tape happens to be 3.25 units wide.
    expect(at(tapeW * 0.3)).toContain("too-close");   // strips deep in each other
    expect(at(tapeW * 0.92)).toContain("too-close");  // barely, but still sharing copper
    expect(at(tapeW * 1.15)).toContain("unweedable"); // they clear; the backing between them tears
    expect(at(tapeW * 1.15)).not.toContain("too-close");
    expect(at(tapeW * 1.85)).not.toContain("unweedable");
    expect(at(tapeW * 1.85)).not.toContain("too-close");
    // The tolerances are centreline separations and must be ordered, or the warning can never fire.
    expect(tapeW).toBeLessThan(tapeW + (3.25 * 0.35));
  });

  it("calls two strips that physically overlap an error, however slightly they overlap", { timeout: 20_000 }, () => {
    const { ctx, routed, tapeW } = fixture();
    // Both tolerances are CENTRELINE separations, so the geometry is not a matter of taste: two strips of
    // width `w` share copper whenever their centrelines are closer than `w`. Anything inside that is one
    // net laid on another -- a short -- and no amount of weeding fixes it, because there is no backing
    // between them to weed.
    const at = (d: number) => checkWire({ pts: [{ x: -10, y: -69.4 + d }, { x: 10, y: -69.4 + d }], net: "pwr" }, ctx, routed);

    // A hair inside a full tape width: 3.25mm strips at 3.15mm centres still share 0.1mm of copper. Sampled
    // this close to the bound on purpose -- a looser pair of samples pins only the ORDERING of the two
    // tolerances and leaves the constant itself free to drift by a third of a tape width unnoticed.
    const overlapping = at(tapeW * 0.97);
    expect(kinds(overlapping)).toContain("too-close");
    expect(isBuildable(overlapping)).toBe(false);

    // A hair outside it: the strips clear each other, and what is left is a weeding problem -- real, but
    // survivable, and the router itself ships copper this close.
    const touchingClear = at(tapeW * 1.02);
    expect(kinds(touchingClear)).not.toContain("too-close");
    expect(isBuildable(touchingClear)).toBe(true);
  });

  it("does not call a stub running along its own rail too close to anything", { timeout: 20_000 }, () => {
    const { ctx, routed } = fixture();
    const gnd = routed.traces.find((t) => t.net === "gnd" && t.pts.length > 3)!;
    // Copper laid directly on top of a GND run, and carrying GND: one potential, so nothing is wrong with
    // it. `selfOverlapLength` rises here, which is exactly why proximity is not derived from it.
    const wire: Trace2D = { pts: [gnd.pts[1]!, gnd.pts[2]!], net: "gnd" };
    const k = kinds(checkWire(wire, ctx, routed));
    expect(k).not.toContain("too-close");
    expect(k).not.toContain("unweedable");
    expect(k).not.toContain("crosses-net");
  });

  it("warns of a sharp join where the wire doubles back on itself", { timeout: 20_000 }, () => {
    const { ctx, routed } = fixture();
    const y = -129.29;
    const wire: Trace2D = { pts: [{ x: -20, y }, { x: 20, y }, { x: -19, y: y + 0.7 }], net: "w" };
    const faults = checkWire(wire, ctx, routed);
    const join = faults.find((f) => f.kind === "acute-join");
    expect(join).toBeDefined();
    expect(join!.at.x).toBeCloseTo(20, 6); // the vertex it turns at, not an endpoint
    expect(isBuildable(faults)).toBe(true); // costly to weed, still buildable
  });

  it("charges an acute join made against copper already on the sheet to the end that made it", { timeout: 20_000 }, () => {
    const { ctx, routed } = fixture();
    // A straight two-point wire has no interior vertex of its own, so its own angle reading finds nothing.
    // What it does have is an end sitting exactly on a vertex of a GND run and leaving nearly back along it —
    // a join between two runs of one net at a shared point, which only `countAcuteJoins` can see.
    const gnd = routed.traces.find((t) => t.net === "gnd" && t.pts.length > 3)!;
    const start = gnd.pts[1]!, back = gnd.pts[0]!;
    const a = Math.atan2(back.y - start.y, back.x - start.x) + (5 * Math.PI) / 180;
    const wire: Trace2D = { pts: [start, { x: start.x + Math.cos(a) * 4, y: start.y + Math.sin(a) * 4 }], net: "gnd" };

    // The delta the wire's own vertices cannot account for — there are no interior vertices at all.
    expect(wire.pts).toHaveLength(2);
    expect(countAcuteJoins([...routed.traces, wire])).toBeGreaterThan(countAcuteJoins(routed.traces));

    const faults = checkWire(wire, ctx, routed);
    const join = faults.find((f) => f.kind === "acute-join");
    expect(join).toBeDefined();
    // Charged to the end that made the join, since the wire has no vertex of its own to point at.
    expect(join!.at.x).toBeCloseTo(start.x, 9);
    expect(join!.at.y).toBeCloseTo(start.y, 9);
    expect(isBuildable(faults)).toBe(true); // costly to weed, still buildable
  });

  it("warns of an end that reaches no copper, and stays silent when both ends land on some", { timeout: 20_000 }, () => {
    const { ctx, routed } = fixture();
    const loose = checkWire({ pts: [{ x: -20, y: -129.29 }, { x: 20, y: -129.29 }], net: "w" }, ctx, routed);
    expect(loose.filter((f) => f.kind === "dangling")).toHaveLength(2);
    expect(isBuildable(loose)).toBe(true);

    const gnd = routed.traces.find((t) => t.net === "gnd" && t.pts.length > 3)!;
    const anchored = checkWire({ pts: [gnd.pts[1]!, gnd.pts[2]!], net: "gnd" }, ctx, routed);
    expect(kinds(anchored)).not.toContain("dangling");
  });

  /**
   * The three unopened cuts in `kirigami-flap`, found the way the pattern defines them rather than by
   * asking the checker: two edges lying on the same line while naming different vertices. Every other
   * bundled pattern has none, which is why an earlier reading of this rule called the case hypothetical --
   * it had been measured only on the seven patterns that cannot have one.
   */
  function seamsIn(faces: ReturnType<typeof flatFaces>): [Vec2, Vec2][] {
    const at = (p: Vec2): string => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    const byLine = new Map<string, { idx: string; seg: [Vec2, Vec2] }[]>();
    for (const f of faces) {
      const n = f.poly.length;
      for (let i = 0; i < n; i++) {
        const a = f.poly[i]!, b = f.poly[(i + 1) % n]!;
        const ka = at(a), kb = at(b);
        const line = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const idx = [f.verts[i], f.verts[(i + 1) % n]].sort((x, y) => x - y).join("_");
        byLine.set(line, [...(byLine.get(line) ?? []), { idx, seg: [a, b] }]);
      }
    }
    const out: [Vec2, Vec2][] = [];
    for (const l of byLine.values()) {
      if (l.length > 1 && new Set(l.map((e) => e.idx)).size > 1) out.push(l[0]!.seg);
    }
    return out;
  }

  it("calls a wire across an unopened cut what it is, and not a wire off the edge", { timeout: 20_000 }, () => {
    // An unopened cut is a slit with material on BOTH sides, so nothing about it is near the boundary.
    // Reported as `off-body` -- which it was -- the message sends the author to hunt along the edge of the
    // sheet for a wire lying well inside it.
    const { ctx, routed, faces } = fixture("kirigami-flap.fkld", 1);
    const seams = seamsIn(faces);
    expect(seams).toHaveLength(3);

    const [p, q] = seams[0]!;
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    const nx = -(q.y - p.y) / L, ny = (q.x - p.x) / L;
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    // DELIBERATELY ASYMMETRIC about the cut. `firstOffBody` falls back to the segment's own midpoint when
    // it finds nothing off the sheet, which is exactly what happens on an unopened cut -- so a chord
    // centred on the cut makes the wrong point and the right one identical, and the assertion below passes
    // against an implementation that never consulted the seam at all. It did: this test was written that
    // way first and a mutant using `firstOffBody` survived it.
    const d = L * 0.1;
    const wire = {
      pts: [{ x: mid.x - nx * d, y: mid.y - ny * d }, { x: mid.x + nx * d * 3, y: mid.y + ny * d * 3 }],
      net: "w",
    };
    const centre = { x: (wire.pts[0]!.x + wire.pts[1]!.x) / 2, y: (wire.pts[0]!.y + wire.pts[1]!.y) / 2 };
    expect(distToSeg(centre, p, q)).toBeGreaterThan(1e-3); // the two candidate points really do differ

    const faults = checkWire(wire, ctx, routed);
    const cut = faults.filter((f) => f.kind === "spans-cut");
    expect(cut).toHaveLength(1);
    expect(kinds(faults)).not.toContain("off-body");
    // Unbuildable: bridging a hole is not a wire, whatever the rest of the reading says.
    expect(isBuildable(faults)).toBe(false);
    // And the point is ON the cut, not merely somewhere along the wire -- that is the whole reason the
    // crossing point is taken from the seam rather than from `firstOffBody`, which samples for material
    // that is missing and finds none here, because on an unopened cut there is material on both sides.
    expect(distToSeg(cut[0]!.at, p, q)).toBeLessThan(1e-6);
    expect(distToSeg(cut[0]!.at, wire.pts[0]!, wire.pts[1]!)).toBeLessThan(1e-6);
  });

  it("still calls a wire that hangs off the sheet off the sheet", { timeout: 20_000 }, () => {
    // The other half of the split: the boundary reading has to survive the cut reading being added ahead
    // of it, or the fix trades one wrong message for another.
    const { ctx, routed, faces } = fixture("kirigami-flap.fkld", 1);
    let minX = Infinity, y = 0;
    for (const f of faces) for (const v of f.poly) if (v.x < minX) { minX = v.x; y = v.y; }
    const wire = { pts: [{ x: minX - 40, y }, { x: minX - 5, y }], net: "w" };
    const faults = checkWire(wire, ctx, routed);
    expect(kinds(faults)).toContain("off-body");
    expect(kinds(faults)).not.toContain("spans-cut");
    expect(isBuildable(faults)).toBe(false);
  });

  it("splits every fault kind into exactly one severity", () => {
    // Written as a Record over the union, so a kind added to `WireFaultKind` without a severity fails to
    // COMPILE here rather than quietly defaulting to harmless.
    const severity: Record<WireFaultKind, "error" | "warning"> = {
      "off-body": "error",
      "spans-cut": "error",
      "over-led": "error",
      "crosses-net": "error",
      "too-close": "error",
      "unweedable": "warning",
      "fold-fatigue": "warning",
      "acute-join": "warning",
      "dangling": "warning",
    };
    const all = Object.keys(severity) as WireFaultKind[];
    expect([...ALL_WIRE_FAULT_KINDS].sort()).toEqual([...all].sort());

    for (const kind of all) {
      const inErrors = ERRORS.has(kind);
      const inWarnings = WARNINGS.has(kind);
      expect(inErrors || inWarnings).toBe(true);          // total
      expect(inErrors && inWarnings).toBe(false);         // disjoint
      expect(inErrors).toBe(severity[kind] === "error");  // and the right way round
    }
    expect(ERRORS.size + WARNINGS.size).toBe(all.length);
  });

  it("blocks a build on any error and on no warning", () => {
    for (const kind of ALL_WIRE_FAULT_KINDS) {
      const faults = [{ kind, at: { x: 0, y: 0 }, why: "" }];
      expect(isBuildable(faults)).toBe(!ERRORS.has(kind));
    }
    expect(isBuildable([])).toBe(true);
  });

  it("reads tape width, not centrelines, over a hundred seeded segments of a real pattern", { timeout: 20_000 }, () => {
    const { faces, tapeW } = fixture();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of faces) for (const p of f.poly) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    /** The centreline-only reading `tapeOnBody` replaced — same sampling, no offset edges. */
    const centrelineOnBody = (a: Vec2, b: Vec2): boolean => {
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(9, Math.ceil(L / (tapeW * 0.5)));
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        if (pointInFace(faces, { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }) < 0) return false;
      }
      return true;
    };

    const rnd = mulberry32(0x5eed);
    let strictlyStronger = 0;
    for (let i = 0; i < 100; i++) {
      const a = { x: x0 + rnd() * (x1 - x0), y: y0 + rnd() * (y1 - y0) };
      const b = { x: a.x + (rnd() - 0.5) * 30, y: a.y + (rnd() - 0.5) * 30 };
      const centre = centrelineOnBody(a, b);
      const tape = tapeOnBody(faces, tapeW, a, b);
      // Width-aware is never more permissive: copper off the sheet at the centre is off the sheet.
      if (tape) expect(centre).toBe(true);
      if (centre && !tape) strictlyStronger++;
    }
    // ...and it is strictly stronger, which is the reason it exists. A centreline test would pass these.
    expect(strictlyStronger).toBeGreaterThan(0);
  });
});
