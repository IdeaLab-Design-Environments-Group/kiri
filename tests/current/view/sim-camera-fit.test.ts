import { describe, expect, it } from "vitest";
import { foldFrame } from "../../../src/view/sim-camera-fit.js";

/** A 10 × 10 flat sheet whose guided goal folds it into a 2 × 2 × 2 block standing at (20, 0, 0). */
function sheetFoldingToBlock(driven: boolean) {
  const position = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
  const goal = new Float32Array([19, -1, 0, 21, -1, 0, 21, 1, 2, 19, 1, 2]);
  return { numNodes: 4, position, goal, driven: new Uint8Array(driven ? [1, 1, 1, 1] : [0, 0, 0, 0]) };
}

describe("view/sim-camera-fit", () => {
  it("frames a guided fold on its folded shape, not the flat sheet it starts from", () => {
    // Framing the union of the two left the folded house a speck in a frame sized for the sheet.
    const { centre, span } = foldFrame(sheetFoldingToBlock(true));
    expect(span).toBeCloseTo(2, 6);
    expect(centre.x).toBeCloseTo(20, 6);
    expect(centre.y).toBeCloseTo(0, 6);
    expect(centre.z).toBeCloseTo(1, 6);
  });

  it("keeps the old sheet-and-goal extent for the freeze threshold", () => {
    expect(foldFrame(sheetFoldingToBlock(true)).reachSpan).toBeCloseTo(21, 6); // x from 0 to 21
    expect(foldFrame(sheetFoldingToBlock(false)).reachSpan).toBeCloseTo(10, 6);
  });

  it("frames a free fold on the sheet, since it has no declared folded shape", () => {
    const { centre, span } = foldFrame(sheetFoldingToBlock(false));
    expect(span).toBeCloseTo(10, 6);
    expect(centre.x).toBeCloseTo(5, 6);
    expect(centre.y).toBeCloseTo(5, 6);
    expect(centre.z).toBeCloseTo(0, 6);
  });

  it("skips non-finite nodes and never returns a zero span", () => {
    const m = sheetFoldingToBlock(true);
    m.goal.fill(3);
    m.goal[0] = Number.NaN;
    const { centre, span } = foldFrame(m);
    expect(span).toBeGreaterThan(0);
    expect(centre).toEqual({ x: 3, y: 3, z: 3 });
  });

  it("falls back to the sheet when the goal has no finite node", () => {
    const m = sheetFoldingToBlock(true);
    m.goal.fill(Number.NaN);
    expect(foldFrame(m).span).toBeCloseTo(10, 6);
  });
});
