/**
 * Hand-drawn wires: where a stored endpoint actually lands on the flat pattern.
 *
 * Two properties carry this file. The first is that a wire is attached to a *thing* and not to a place —
 * move the part, the wire's end moves with it — and the second is that when the thing is gone the vertex
 * is dropped and the rest of the wire survives. A resolver that threw on a deleted part would take the
 * author's drawing with it, which is the one failure here that cannot be undone.
 *
 * The third, quieter property is that an LED's leg does not depend on the router. Which leg carries which
 * rail is a routing *output*, so a wire naming a side would depend on the plan it is meant to constrain.
 * The test for it resolves the same leg under two different batteries and demands the same point.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  manualTraces,
  resolveVertex,
  resolveWire,
  toFlat,
  type ManualWire,
  type WireContext,
} from "../../../src/model/manual-wire.js";
import {
  flatFaces,
  gapGraph,
  ledOf,
  pointInFace,
  type Circuit,
  type GapEdge,
  type Vec2,
} from "../../../src/model/electronics.js";
import {
  TAPE_MM,
  batteryTerminals,
  patternDiag,
  tapeWidthFor,
} from "../../../src/model/electronics-routing.js";
import { padPosition } from "../../../src/model/netlist.js";
import { R_1206 } from "../../../src/model/footprints.generated.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** A pattern whose tape is the full 3.25mm, so pattern units ARE millimetres and the arithmetic is legible. */
const TAPE_W = TAPE_MM;

/** house, its faces and its gaps — the fixture the routing tests use. */
function house(): { faces: ReturnType<typeof flatFaces>; gaps: GapEdge[] } {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}house.fkld`, "utf8"));
  const faces = flatFaces(fold);
  return { faces, gaps: gapGraph(fold, faces).gaps };
}

/** A context on a real pattern, with one LED on its first gap and the battery on `batteryFace`. */
function onHouse(batteryFace: number, over: Partial<Circuit> = {}): WireContext {
  const { faces, gaps } = house();
  const g = gaps[0]!;
  return {
    faces,
    gaps,
    tapeW: tapeWidthFor(faces),
    circuit: { leds: [ledOf(g.faceA, g.faceB)], battery: { face: batteryFace }, ...over },
  };
}

/** A bare context with no pattern — enough for the vertex kinds that only read the circuit. */
function bare(circuit: Partial<Circuit> = {}): WireContext {
  return { faces: [], gaps: [], tapeW: TAPE_W, circuit: { leds: [], battery: null, ...circuit } };
}

describe("model/manual-wire", () => {
  it("converts millimetres to pattern units so that a tape width round-trips to itself", () => {
    expect(toFlat(TAPE_MM, TAPE_MM)).toBe(TAPE_MM);
    expect(toFlat(TAPE_MM, 1.5)).toBeCloseTo(1.5, 12);
    // Linear through the origin: the conversion is a scale, never an offset.
    expect(toFlat(0, 1.5)).toBe(0);
    expect(toFlat(2 * TAPE_MM, 1.5)).toBeCloseTo(2 * toFlat(TAPE_MM, 1.5), 12);
  });

  it("leaves a free vertex exactly where the author put it", () => {
    const at = resolveVertex({ kind: "free", x: 12.5, y: -3.25 }, bare())!;
    expect(at).toEqual({ x: 12.5, y: -3.25 });
  });

  it("puts a pad vertex where the netlist puts that pad", () => {
    const part = { component: "R_1206", x: 10, y: 4 };
    const ctx = bare({ parts: [part] });
    const at = resolveVertex({ kind: "pad", part: 0, pad: "1" }, ctx)!;
    const want = padPosition(part, R_1206, "1", TAPE_W, TAPE_MM)!;
    expect(at.x).toBeCloseTo(want.x, 12);
    expect(at.y).toBeCloseTo(want.y, 12);
  });

  it("drags a pad vertex with its part, by exactly the distance the part moved", () => {
    const before = resolveVertex(
      { kind: "pad", part: 0, pad: "1" },
      bare({ parts: [{ component: "R_1206", x: 10, y: 4 }] }),
    )!;
    const after = resolveVertex(
      { kind: "pad", part: 0, pad: "1" },
      bare({ parts: [{ component: "R_1206", x: 10 + 7, y: 4 - 2.5 }] }),
    )!;
    expect(after.x - before.x).toBeCloseTo(7, 12);
    expect(after.y - before.y).toBeCloseTo(-2.5, 12);
  });

  it("refuses a pad vertex naming a part that is no longer in the circuit", () => {
    const ctx = bare({ parts: [{ component: "R_1206", x: 0, y: 0 }] });
    expect(resolveVertex({ kind: "pad", part: 3, pad: "1" }, ctx)).toBeNull();
    expect(resolveVertex({ kind: "pad", part: 0, pad: "no-such-pad" }, ctx)).toBeNull();
    expect(resolveVertex({ kind: "pad", part: 0, pad: "" }, bare({ parts: [{ component: "not-a-part", x: 0, y: 0 }] }))).toBeNull();
  });

  it("drops a dangling vertex from a wire instead of throwing, and keeps the rest of it", () => {
    const ctx = bare({ parts: [{ component: "R_1206", x: 10, y: 0 }] });
    const wire: ManualWire = {
      id: "w1",
      pts: [
        { kind: "free", x: 0, y: 0 },
        { kind: "pad", part: 9, pad: "1" }, // gone
        { kind: "pad", part: 0, pad: "1" },
      ],
    };
    const trace = resolveWire(wire, ctx)!;
    expect(trace.pts).toHaveLength(2);
    expect(trace.pts[0]).toEqual({ x: 0, y: 0 });
    // The wire is untouched in the circuit — resolution reports, it does not repair or delete.
    expect(wire.pts).toHaveLength(3);
  });

  it("gives no run at all for a wire with fewer than two vertices left", () => {
    const ctx = bare({ parts: [] });
    expect(resolveWire({ id: "w", pts: [{ kind: "free", x: 0, y: 0 }] }, ctx)).toBeNull();
    expect(
      resolveWire(
        { id: "w", pts: [{ kind: "free", x: 0, y: 0 }, { kind: "pad", part: 0, pad: "1" }] },
        ctx,
      ),
    ).toBeNull();
    expect(resolveWire({ id: "w", pts: [] }, ctx)).toBeNull();
  });

  it("carries the wire's own net and width onto the run, and falls back to its id for a net", () => {
    const ctx = bare();
    const pts: ManualWire["pts"] = [
      { kind: "free", x: 0, y: 0 },
      { kind: "free", x: 5, y: 5 },
    ];
    expect(resolveWire({ id: "w1", pts }, ctx)!.net).toBe("w1");
    expect(resolveWire({ id: "w1", pts }, ctx)!.width).toBeUndefined();
    const named = resolveWire({ id: "w1", pts, net: "gnd", width: 0.8 }, ctx)!;
    expect(named.net).toBe("gnd");
    expect(named.width).toBe(0.8);
  });

  it("resolves an LED's leg identically however the battery is placed", { timeout: 20_000 }, () => {
    // The non-circularity property. Which leg is PWR is decided by the router, and the router's decision
    // moves with the battery; if a leg vertex depended on that decision these two would differ.
    const a = onHouse(0);
    const b = onHouse(3);
    expect(a.circuit.battery).not.toEqual(b.circuit.battery);
    for (const leg of [0, 1] as const) {
      const pa = resolveVertex({ kind: "led", led: 0, leg }, a);
      const pb = resolveVertex({ kind: "led", led: 0, leg }, b);
      expect(pa).not.toBeNull();
      expect(pa).toEqual(pb);
    }
    // Nor does declaring the LED's orientation move its legs — flip names which pad is +, not where it sits.
    const flipped = onHouse(0);
    flipped.circuit.leds[0]!.flip = true;
    expect(resolveVertex({ kind: "led", led: 0, leg: 0 }, flipped)).toEqual(
      resolveVertex({ kind: "led", led: 0, leg: 0 }, a),
    );
  });

  it("lands an LED's two legs on its two different faces, one each", { timeout: 20_000 }, () => {
    const ctx = onHouse(0);
    const led = ctx.circuit.leds[0]!;
    const p0 = resolveVertex({ kind: "led", led: 0, leg: 0 }, ctx)!;
    const p1 = resolveVertex({ kind: "led", led: 0, leg: 1 }, ctx)!;
    expect(p0).not.toEqual(p1);
    // Leg 0 is the leg on the LED's own face `a`, leg 1 the one on face `b` — not the gap's A/B order.
    expect(pointInFace(ctx.faces, p0)).toBe(led.a);
    expect(pointInFace(ctx.faces, p1)).toBe(led.b);
  });

  it("refuses an LED vertex whose hinge the pattern no longer has", { timeout: 20_000 }, () => {
    const ctx = onHouse(0);
    ctx.circuit.leds = [ledOf(0, 9999)]; // no such pair of adjacent faces
    expect(resolveVertex({ kind: "led", led: 0, leg: 0 }, ctx)).toBeNull();
    expect(resolveVertex({ kind: "led", led: 4, leg: 0 }, ctx)).toBeNull();
    // An LED naming a part the library does not have cannot be seated either.
    const unknown = onHouse(0);
    unknown.circuit.leds[0]!.component = "NOT_A_LED";
    expect(resolveVertex({ kind: "led", led: 0, leg: 0 }, unknown)).toBeNull();
  });

  it("puts a battery vertex on the battery's own face, and moves it when the battery moves", { timeout: 20_000 }, () => {
    const ctx = onHouse(0);
    const pwr = resolveVertex({ kind: "battery", side: "pwr" }, ctx)!;
    const gnd = resolveVertex({ kind: "battery", side: "gnd" }, ctx)!;
    expect(pwr).not.toEqual(gnd);
    const moved = onHouse(3);
    expect(resolveVertex({ kind: "battery", side: "pwr" }, moved)).not.toEqual(pwr);
  });

  it("puts a battery vertex on the pole the router places for that side", { timeout: 20_000 }, () => {
    // Not merely "the two differ". Each side has to be the pole the ROUTER lays for that side, computed
    // the same way from the same face: a wire the author drew to + that resolves onto - is copper on the
    // wrong terminal, and it reads as clean, because nothing downstream re-derives which pole is which.
    const ctx = onHouse(0);
    const face = ctx.faces[ctx.circuit.battery!.face]!;
    const term = batteryTerminals(face.centroid, patternDiag(ctx.faces), face.poly, ctx.tapeW);
    expect(resolveVertex({ kind: "battery", side: "pwr" }, ctx)).toEqual(term.pwr);
    expect(resolveVertex({ kind: "battery", side: "gnd" }, ctx)).toEqual(term.gnd);
    expect(term.pwr).not.toEqual(term.gnd);
  });

  it("refuses a battery vertex when there is no battery, or its face has gone", () => {
    expect(resolveVertex({ kind: "battery", side: "pwr" }, bare())).toBeNull();
    const ctx = onHouse(0);
    ctx.circuit.battery = { face: 9999 };
    expect(resolveVertex({ kind: "battery", side: "gnd" }, ctx)).toBeNull();
  });

  it("resolves the whole circuit's wires the same way twice, to the last decimal", { timeout: 20_000 }, () => {
    // The canvas and the export resolve independently and have to agree: a wire that moved by a rounding
    // step between the two would print somewhere the author never saw it.
    const ctx = onHouse(0, { parts: [{ component: "R_1206", x: 12, y: 8 }] });
    ctx.circuit.wires = [
      {
        id: "w1",
        pts: [
          { kind: "battery", side: "pwr" },
          { kind: "free", x: 20, y: 20 },
          { kind: "led", led: 0, leg: 0 },
        ],
      },
      { id: "w2", net: "gnd", width: 1.25, pts: [{ kind: "pad", part: 0, pad: "1" }, { kind: "pad", part: 0, pad: "2" }] },
      { id: "dangling", pts: [{ kind: "pad", part: 7, pad: "1" }, { kind: "free", x: 1, y: 1 }] },
    ];
    const first = manualTraces(ctx);
    const second = manualTraces(ctx);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // The two whole wires come through; the one that lost a vertex and fell under two points does not.
    expect(first.map((t) => t.net)).toEqual(["w1", "gnd"]);
    expect(first[0]!.pts).toHaveLength(3);
  });

  it("gives two unnamed wires two different nets, so neither is folded into the other", () => {
    // The property the `net ?? id` fallback exists for. A shared placeholder would make two unrelated
    // hand wires read as one conductor downstream: `countNetCrossings` skips a pair only when their nets
    // are equal, so merging them would hide every crossing between them instead of reporting it.
    const ctx = bare();
    ctx.circuit.wires = [
      { id: "w1", pts: [{ kind: "free", x: 0, y: 0 }, { kind: "free", x: 10, y: 0 }] },
      { id: "w2", pts: [{ kind: "free", x: 5, y: -5 }, { kind: "free", x: 5, y: 5 }] },
    ];
    const [a, b] = manualTraces(ctx);
    expect(a!.net).not.toBe(b!.net);
    // And a wire that IS named keeps that name, even next to an unnamed one — the fallback is a floor.
    ctx.circuit.wires[1]!.net = "gnd";
    const named = manualTraces(ctx);
    expect(named.map((t) => t.net)).toEqual(["w1", "gnd"]);
  });

  it("gives no runs for a circuit that has no wires", () => {
    expect(manualTraces(bare())).toEqual([]);
    const ctx = bare();
    ctx.circuit.wires = [];
    expect(manualTraces(ctx)).toEqual([]);
  });
});
