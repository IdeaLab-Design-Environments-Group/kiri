/**
 * Hand-drawn jumps: the one connection on the sheet that is not copper in the plane.
 *
 * Three properties carry this file. The first is that adjacency is *measured*, not asserted — two ends the
 * author put down resolve to a pair index only when they actually sit on the two lips of one cut, which is
 * what makes `pair` safe for everything downstream to key on. The second is that failing that test is not
 * an error here: the jump still resolves, with `pair === -1`, so the rule layer can say why rather than the
 * author's drawing silently disappearing. The third is that a land is always emitted, even where it will
 * not fit, for the same reason.
 *
 * The fixture is desk-lamp-shade, the pattern the whole feature exists for: a strip whose two short edges
 * are one rim, 305 units apart in the flat pattern and touching in the folded artifact.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  jumpLandTraces,
  manualJumps,
  resolveJump,
  type JumpContext,
  type ManualJump,
} from "../../../src/model/manual-jump.js";
import { cloneCircuit } from "../../../src/model/circuit-commands.js";
import { foldAdjacency, type LipPairFlat } from "../../../src/model/fold-adjacency.js";
import {
  flatFaces,
  gapGraph,
  pointInFace,
  type Circuit,
  type Vec2,
} from "../../../src/model/electronics.js";
import { tapeWidthFor } from "../../../src/model/electronics-routing.js";
import type { WireVertex } from "../../../src/model/manual-wire.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** The rim pair whose lips lie furthest apart in the flat pattern — the case the feature is for. */
const RIM_PAIR = 0;
/** A second pair, to put an end on a lip that belongs to a different cut. */
const OTHER_PAIR = 5;

/** How far inside its face a hand-placed end sits. One unit, comfortably inside a 1.5-unit tape's reach. */
const INSET = 1;

interface Shade extends JumpContext {
  pairs: LipPairFlat[];
}

function shade(over: Partial<Circuit> = {}): Shade {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}desk-lamp-shade.fkld`, "utf8"));
  const faces = flatFaces(fold);
  const adjacency = foldAdjacency(fold, faces);
  return {
    faces,
    gaps: gapGraph(fold, faces).gaps,
    tapeW: tapeWidthFor(faces),
    adjacency,
    pairs: adjacency.pairs,
    circuit: { leds: [], battery: null, ...over },
  };
}

const lerp = (a: Vec2, b: Vec2, u: number): Vec2 => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });

/** A point on the given lip at parameter `u`, pulled `INSET` toward its face's centroid so it is on material. */
function onLip(ctx: Shade, pair: number, side: "A" | "B", u = 0.5): WireVertex {
  const p = ctx.pairs[pair]!;
  const lip = side === "A" ? p.lipA : p.lipB;
  const face = ctx.faces[side === "A" ? p.faceA : p.faceB]!;
  const at = lerp(lip[0], lip[1], u);
  const dx = face.centroid.x - at.x, dy = face.centroid.y - at.y;
  const L = Math.hypot(dx, dy);
  return { kind: "free", x: at.x + (dx / L) * INSET, y: at.y + (dy / L) * INSET };
}

const unit = (v: Vec2 | undefined): number => Math.hypot(v!.x, v!.y);

describe("model/manual-jump", () => {
  it("reads the pair off the two lips the author's ends sit on", () => {
    const ctx = shade();
    const j: ManualJump = { id: "j1", a: onLip(ctx, RIM_PAIR, "A"), b: onLip(ctx, RIM_PAIR, "B"), net: "gnd" };

    const resolved = resolveJump(j, ctx)!;

    expect(resolved.pair).toBe(RIM_PAIR);
    expect(resolved.source).toBe("drawn");
    expect(resolved.id).toBe("j1");
    expect(resolved.net).toBe("gnd");
    // The lip directions the folded ribbon is drawn from: units, so a caller can scale them by a half width.
    expect(unit(resolved.dirA)).toBeCloseTo(1, 12);
    expect(unit(resolved.dirB)).toBeCloseTo(1, 12);
  });

  it("carries its own id as its net when the author has not named one", () => {
    // The same floor `ManualWire.net` sets, and for the same reason: two unnamed jumps must not read as
    // one net downstream.
    const ctx = shade();
    const j: ManualJump = { id: "j7", a: onLip(ctx, RIM_PAIR, "A"), b: onLip(ctx, RIM_PAIR, "B") };

    expect(resolveJump(j, ctx)!.net).toBe("j7");
  });

  it("resolves ends on two different cuts, and says so with pair -1", () => {
    // Not null: the author drew something, and it is the rule layer's job to explain why it will not work.
    const ctx = shade();
    const j: ManualJump = { id: "j1", a: onLip(ctx, RIM_PAIR, "A"), b: onLip(ctx, OTHER_PAIR, "A"), net: "gnd" };

    const resolved = resolveJump(j, ctx)!;

    expect(resolved.pair).toBe(-1);
    expect(resolved.dirA).toBeUndefined();
    expect(resolved.dirB).toBeUndefined();
    expect(resolved.net).toBe("gnd");
  });

  it("refuses a pair when both ends sit on the same lip of one cut", () => {
    // One lip is one side of the seam. A jump from a lip to itself joins a point to its neighbour and
    // crosses nothing, so it is no more adjacent than a jump between two different cuts.
    const ctx = shade();
    const j: ManualJump = {
      id: "j1",
      a: onLip(ctx, RIM_PAIR, "A", 0.25),
      b: onLip(ctx, RIM_PAIR, "A", 0.75),
    };

    expect(resolveJump(j, ctx)!.pair).toBe(-1);
  });

  it("drops a jump whose end names a part that is not in the circuit", () => {
    // One end short, a jump is not a connection and there is nothing to draw — unlike a wire, which keeps
    // the stretch that survives.
    const ctx = shade();
    const j: ManualJump = { id: "j1", a: { kind: "pad", part: 3, pad: "1" }, b: onLip(ctx, RIM_PAIR, "B") };

    expect(resolveJump(j, ctx)).toBeNull();
  });

  it("lays two solder lands, on material, one per end", () => {
    const ctx = shade();
    const j: ManualJump = { id: "j1", a: onLip(ctx, RIM_PAIR, "A"), b: onLip(ctx, RIM_PAIR, "B"), net: "gnd" };
    const resolved = resolveJump(j, ctx)!;

    const lands = jumpLandTraces([resolved], ctx.tapeW, ctx.faces);

    expect(lands).toHaveLength(2);
    for (const land of lands) {
      expect(land.pts).toHaveLength(2);
      expect(land.width).toBe(ctx.tapeW);
      expect(land.net).toBe("gnd");
      for (const p of land.pts) expect(pointInFace(ctx.faces, p)).toBeGreaterThanOrEqual(0);
    }
    // Each land starts at its own end and reaches at least half a tape onto the sheet.
    expect(lands[0]!.pts[0]).toEqual(resolved.a);
    expect(lands[1]!.pts[0]).toEqual(resolved.b);
    for (const land of lands) {
      const [p, q] = land.pts as [Vec2, Vec2];
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeGreaterThanOrEqual(ctx.tapeW * 0.5 - 1e-9);
    }
  });

  it("still lays a land for an end that is off the material, rather than losing the copper", () => {
    // Off the sheet nothing will fit, and the half-tape stub is what lets `jump-rules.ts` report the jump
    // as unanchored instead of the author seeing a jump with no copper at either end and no fault either.
    const ctx = shade();
    const off: Vec2 = { x: -10_000, y: -10_000 };
    const lands = jumpLandTraces(
      [{ a: off, b: off, net: "gnd", pair: -1, source: "drawn" }],
      ctx.tapeW,
      ctx.faces,
    );

    expect(lands).toHaveLength(2);
    for (const land of lands) {
      const [p, q] = land.pts as [Vec2, Vec2];
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeCloseTo(ctx.tapeW * 0.5, 12);
      expect(pointInFace(ctx.faces, q)).toBe(-1);
    }
  });

  it("finds no jumps on a circuit that has never had one", () => {
    expect(manualJumps(shade())).toEqual([]);
  });

  it("resolves every jump on the circuit, in order", () => {
    const base = shade();
    const ctx = shade({
      jumps: [
        { id: "j1", a: onLip(base, RIM_PAIR, "A"), b: onLip(base, RIM_PAIR, "B"), net: "gnd" },
        { id: "j2", a: { kind: "pad", part: 3, pad: "1" }, b: onLip(base, RIM_PAIR, "B") },
        { id: "j3", a: onLip(base, OTHER_PAIR, "A"), b: onLip(base, OTHER_PAIR, "B") },
      ],
    });

    const jumps = manualJumps(ctx);

    // The dangling one is gone; the other two keep the order the author drew them in.
    expect(jumps.map((j) => j.id)).toEqual(["j1", "j3"]);
    expect(jumps.map((j) => j.pair)).toEqual([RIM_PAIR, OTHER_PAIR]);
  });

  it("keeps jumps through a clone, as copies", () => {
    // THE trap, as `electronics-modal.test.ts` names it: `cloneCircuit` copies field by field and silently
    // drops anything it does not name, so a jump missing from it would draw on the canvas and vanish the
    // moment the circuit reached the store.
    const circuit: Circuit = {
      leds: [],
      battery: null,
      jumps: [{ id: "j1", a: { kind: "free", x: 1, y: 2 }, b: { kind: "pad", part: 0, pad: "1" }, net: "gnd" }],
    };

    const cloned = cloneCircuit(circuit);

    expect(cloned.jumps).toEqual(circuit.jumps);
    expect(cloned.jumps![0]).not.toBe(circuit.jumps![0]);
    expect(cloned.jumps![0]!.a).not.toBe(circuit.jumps![0]!.a);
    (cloned.jumps![0]!.a as { x: number }).x = 99;
    cloned.jumps![0]!.net = "pwr";
    expect(circuit.jumps![0]!.a).toEqual({ kind: "free", x: 1, y: 2 });
    expect(circuit.jumps![0]!.net).toBe("gnd");
  });
});
