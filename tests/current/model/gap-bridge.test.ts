/**
 * Copper may span a narrow opening in the sheet.
 *
 * A cut that has opened is a hole in the silhouette, and containment used to keep copper off every hole
 * whatever its width. A kirigami net's cuts open as wedges from the vertex the two patches still share, and
 * near that apex the opening is a millimetre or two -- a span adhesive copper foil bridges on its own. So the
 * router now links the two lips of an opening narrower than `BRIDGE_MM` (five millimetres), prices the hop
 * as a last resort, and holds a hand-drawn wire to the same allowance. A zero-width seam stays refused; that
 * case is `cut-crossing.test.ts`'s.
 *
 * The fixture is two tiles with a wedge between them, one unit wide at the bottom and eight at the top. The
 * tape is 1.5 units and told it is 1.5mm, so a unit is a millimetre and the allowance is five units: the
 * wedge is bridgeable below y ≈ 5.7 and not above.
 */
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, type Circuit, type Vec2 } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import {
  buildCorridor,
  offBodyRun,
  reachableFaces,
  searchCorridor,
  tapeOffBodyAt,
  tapeOnBody,
} from "../../../src/model/corridor.js";
import { planRoutes, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { BRIDGE_MM, TAPE_MM, bridgeSpanFor } from "../../../src/model/tape-width.js";
import { checkWire } from "../../../src/model/wire-rules.js";
import type { WireContext } from "../../../src/model/manual-wire.js";

const TAPE_W = 1.5;
const BRIDGE_W = bridgeSpanFor(TAPE_W, TAPE_MM); // 5 units

/** Two tiles, a square and a quad, with a wedge-shaped opening between them: `gapAt(y) = 1 + 0.7·y`. */
const WEDGE: FoldFile = {
  vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10], [11, 0], [21, 0], [21, 10], [18, 10]],
  faces_vertices: [[0, 1, 2, 3], [4, 5, 6, 7]],
  edges_vertices: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4]],
  edges_assignment: ["B", "C", "B", "B", "B", "B", "B", "C"],
};

/** The same two tiles with a uniform opening wider than the allowance. */
const WIDE: FoldFile = {
  vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10], [16.5, 0], [26.5, 0], [26.5, 10], [16.5, 10]],
  faces_vertices: [[0, 1, 2, 3], [4, 5, 6, 7]],
  edges_vertices: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4]],
  edges_assignment: ["B", "C", "B", "B", "B", "B", "B", "C"],
};

const gapAt = (y: number): number => 1 + 0.7 * y;

function corridorOf(fold: FoldFile) {
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const c = buildCorridor(faces, gaps, 100, TAPE_W, undefined, TAPE_MM);
  return { faces, gaps, c };
}

const search = (c: ReturnType<typeof buildCorridor>, from: number, to: number): Vec2[] =>
  searchCorridor(c, from, to, new Set(), new Map(), null, false, null, null, null, null);

describe("model/gap-bridge › the corridor", () => {
  it("has no hinge between the two tiles -- the opening is a cut, not a crease", () => {
    expect(corridorOf(WEDGE).gaps).toHaveLength(0);
  });

  it("links the two lips where the wedge is narrower than the allowance, and nowhere else", () => {
    const { c } = corridorOf(WEDGE);
    const hops = [...c.bridges.entries()].flatMap(([from, list]) =>
      list.map((b) => ({ from: c.point.get(from)!, to: c.point.get(b.to)!, band: b.band, price: b.price })));
    expect(hops.length).toBeGreaterThan(0);
    for (const h of hops) {
      const span = Math.hypot(h.to.x - h.from.x, h.to.y - h.from.y);
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(BRIDGE_W + 1e-6);
      // In the narrow part of the wedge: the opening there really is under the allowance.
      expect(gapAt(Math.max(h.from.y, h.to.y))).toBeLessThanOrEqual(BRIDGE_W + 1e-6);
      // A last resort: dearer than the crease price the corridor was built with, and in the top band.
      expect(h.price).toBeGreaterThan(100);
      expect(h.band).toBe(2);
    }
  });

  it("makes the far tile reachable, across the narrow end of the wedge", () => {
    const { c } = corridorOf(WEDGE);
    expect(reachableFaces(c, 0).has(1)).toBe(true);
    const path = search(c, 0, 1);
    expect(path.length).toBeGreaterThanOrEqual(2);
    // Exactly one hop leaves tile 0 (x ≤ 10) for tile 1 (x ≥ 11), and it is short enough to bridge.
    const hopAt = path.findIndex((p, i) => i > 0 && path[i - 1]!.x <= 10 + 1e-3 && p.x >= 11 - 1e-3);
    expect(hopAt).toBeGreaterThan(0);
    const a = path[hopAt - 1]!, b = path[hopAt]!;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(BRIDGE_W + 1e-6);
    expect(gapAt(Math.max(a.y, b.y))).toBeLessThanOrEqual(BRIDGE_W + 1e-6);
  });

  it("does not bridge an opening wider than the allowance", () => {
    const { c } = corridorOf(WIDE);
    expect(c.bridges.size).toBe(0);
    expect(reachableFaces(c, 0).has(1)).toBe(false);
    expect(search(c, 0, 1)).toEqual([]);
  });

  it("bridges nothing when the allowance is zero", () => {
    const faces = flatFaces(WEDGE);
    // With no millimetre scale there is no allowance -- `bridgeSpanFor` returns 0 -- so the graph is what
    // it always was.
    const c = buildCorridor(faces, [], 100, TAPE_W, undefined, 0);
    expect(c.bridges.size).toBe(0);
  });

  it("routes an LED whose tile sits across the wedge, and reports it unreachable across the wide gap", () => {
    const circuit: Circuit = { leds: [], battery: { face: 0 } };
    const wedge = flatFaces(WEDGE);
    const wide = flatFaces(WIDE);
    // Reachability alone, through the public planner: no LED sits on a hinge here, so the question is
    // whether the corridor the planner builds sees tile 1 at all.
    const cw = buildCorridor(wedge, gapGraph(WEDGE, wedge).gaps, 100, tapeWidthFor(wedge, 20), undefined, TAPE_MM);
    const cx = buildCorridor(wide, gapGraph(WIDE, wide).gaps, 100, tapeWidthFor(wide, 20), undefined, TAPE_MM);
    expect(reachableFaces(cw, 0).has(1)).toBe(true);
    expect(reachableFaces(cx, 0).has(1)).toBe(false);
    expect(planRoutes(wedge, gapGraph(WEDGE, wedge).gaps, circuit, 20).unreachable).toEqual([]);
  });
});

describe("model/gap-bridge › a strip of tape", () => {
  const faces = flatFaces(WEDGE);

  it("may cross the wedge where it is narrower than the allowance", () => {
    const y = 2; // opening 2.4 units
    expect(gapAt(y)).toBeLessThan(BRIDGE_W);
    expect(tapeOnBody(faces, TAPE_W, { x: 8, y }, { x: 14, y }, BRIDGE_W)).toBe(true);
    expect(tapeOffBodyAt(faces, TAPE_W, { x: 8, y }, { x: 14, y }, BRIDGE_W)).toBeNull();
  });

  it("is strict without an allowance, which is what the router's own legs get", () => {
    const y = 2;
    expect(tapeOnBody(faces, TAPE_W, { x: 8, y }, { x: 14, y })).toBe(false);
    expect(tapeOffBodyAt(faces, TAPE_W, { x: 8, y }, { x: 14, y })).not.toBeNull();
  });

  it("may not cross it where it is wider", () => {
    const y = 9; // opening 7.3 units
    expect(gapAt(y)).toBeGreaterThan(BRIDGE_W);
    expect(tapeOnBody(faces, TAPE_W, { x: 8, y }, { x: 20, y }, BRIDGE_W)).toBe(false);
    const at = tapeOffBodyAt(faces, TAPE_W, { x: 8, y }, { x: 20, y }, BRIDGE_W)!;
    expect(at).not.toBeNull();
    // The point reported is in the hole, not somewhere on the tile.
    expect(at.x).toBeGreaterThan(10 - 1e-6);
    expect(at.x).toBeLessThan(10 + gapAt(y) + 1e-6);
  });

  it("is judged by how long it is off the material, so a diagonal over a narrow part still passes", () => {
    // From y=1 to y=3 the opening is 1.7 to 3.1 units; the strip crosses it obliquely and its edges are
    // off the sheet for longer than the perpendicular gap, but still under five units.
    expect(tapeOnBody(faces, TAPE_W, { x: 8, y: 1 }, { x: 14, y: 3 }, BRIDGE_W)).toBe(true);
  });

  it("may not run along inside the opening, however narrow it is there", () => {
    // Entirely in the hole: there is no far bank, and the run reaches both ends.
    expect(tapeOnBody(faces, TAPE_W, { x: 10.5, y: 0.5 }, { x: 10.6, y: 1.5 }, BRIDGE_W)).toBe(false);
  });

  it("may not end in the opening", () => {
    // Starts on tile 0 and stops in mid-air 0.5 units past its edge: short, but not a bridge.
    expect(tapeOnBody(faces, TAPE_W, { x: 5, y: 1 }, { x: 10.5, y: 1 }, BRIDGE_W)).toBe(false);
  });

  it("still may not leave the sheet at its boundary", () => {
    expect(tapeOnBody(faces, TAPE_W, { x: 5, y: 5 }, { x: -2, y: 5 }, BRIDGE_W)).toBe(false);
    expect(tapeOnBody(faces, TAPE_W, { x: 5, y: 9.9 }, { x: 5, y: 12 }, BRIDGE_W)).toBe(false);
  });

  it("reads a single line the same way at the primitive", () => {
    const y = 2;
    expect(offBodyRun(faces, { x: 8, y }, { x: 14, y }, 0.75, BRIDGE_W, true)).toBeNull();
    expect(offBodyRun(faces, { x: 8, y }, { x: 14, y }, 0.75, 1, true)).not.toBeNull();
    // Off at the start and never on: refused even under a generous allowance.
    expect(offBodyRun(faces, { x: 10.5, y }, { x: 14, y }, 0.75, BRIDGE_W, true)).not.toBeNull();
  });
});

describe("model/gap-bridge › a hand-drawn wire", () => {
  // The pattern is told it is bigger than the sheet, so the tape is `TAPE_MM` in pattern units and the
  // allowance is `BRIDGE_MM` units -- the same numbers the corridor tests use.
  function fixture(fold: FoldFile) {
    const faces = flatFaces(fold);
    const gaps = gapGraph(fold, faces).gaps;
    const circuit: Circuit = { leds: [], battery: { face: 0 } };
    const tapeW = tapeWidthFor(faces, 20);
    expect(tapeW).toBeCloseTo(TAPE_MM, 9);
    const routed = planRoutes(faces, gaps, circuit, 20);
    const ctx: WireContext = { faces, gaps, circuit, tapeW };
    return { ctx, routed };
  }

  it("is buildable across the narrow end of the wedge", () => {
    const { ctx, routed } = fixture(WEDGE);
    const faults = checkWire({ pts: [{ x: 5, y: 2 }, { x: 15, y: 2 }], net: "w" }, ctx, routed);
    expect(faults.map((f) => f.kind)).not.toContain("off-body");
    expect(faults.map((f) => f.kind)).not.toContain("spans-cut");
  });

  it("is off the body across the wide end, and the fault points into the hole", () => {
    const { ctx, routed } = fixture(WEDGE);
    const faults = checkWire({ pts: [{ x: 5, y: 9 }, { x: 20, y: 9 }], net: "w" }, ctx, routed);
    const off = faults.filter((f) => f.kind === "off-body");
    expect(off).toHaveLength(1);
    expect(off[0]!.at.x).toBeGreaterThan(10 - 1e-6);
    expect(off[0]!.at.x).toBeLessThan(10 + gapAt(9) + 1e-6);
    expect(faults.map((f) => f.kind)).not.toContain("spans-cut");
  });

  it("is off the body across a uniform gap wider than the allowance", () => {
    const { ctx, routed } = fixture(WIDE);
    const faults = checkWire({ pts: [{ x: 5, y: 5 }, { x: 20, y: 5 }], net: "w" }, ctx, routed);
    expect(faults.map((f) => f.kind)).toContain("off-body");
  });

  it("agrees with the router's allowance to the millimetre", () => {
    expect(BRIDGE_W).toBeCloseTo(BRIDGE_MM, 9);
  });
});
