/**
 * The electronics canvas's pure layers. Split out of the modal, so tested without one: these take data
 * and return SVG, and what they must get right is which BUILD is on screen — the printed sheet is cut
 * into tiles with a gap between them, and the vinyl sheet is not cut at all.
 */
import { describe, expect, it } from "vitest";
import type { FlatFace, GapEdge, TilePoly, Vec2 } from "../../../src/model/electronics.js";
import { batteryParts, ratsnestParts, substrateParts } from "../../../src/view/electronics-draw.js";

const id = (p: Vec2): Vec2 => p;

/** Two unit squares side by side, hinged on the edge they share. */
const FACES: FlatFace[] = [
  { poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], centroid: { x: 0.5, y: 0.5 }, verts: [0, 1, 2, 3] },
  { poly: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }], centroid: { x: 1.5, y: 0.5 }, verts: [1, 4, 5, 2] },
] as unknown as FlatFace[];

const TILES: TilePoly[] = [
  { face: 0, ring: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }] },
  { face: 1, ring: [{ x: 1.1, y: 0.1 }, { x: 1.9, y: 0.1 }, { x: 1.9, y: 0.9 }] },
];

const gap = (assignment: string): GapEdge => ({
  mid: 2, faceA: 0, faceB: 1, point: { x: 1, y: 0.5 },
  ends: [{ x: 1, y: 0 }, { x: 1, y: 1 }], verts: [1, 2],
  legA: { x: 0.9, y: 0.5 }, legB: { x: 1.1, y: 0.5 },
  assignment, dihedral: assignment === "V" ? -90 : 90,
} as unknown as GapEdge);

describe("view/electronics-draw", () => {
  it("cuts the printed sheet into tiles on a backing, and scores no creases on it", () => {
    const svg = substrateParts("printed", FACES, TILES, [gap("M")], id).join("");
    expect(svg).toContain("el-cloth");
    expect(svg).toContain("el-tile");
    // The gaps between the tiles ARE the creases on this build; drawing score lines too would say there
    // are folds where the sheet is merely cut.
    expect(svg).not.toContain("el-crease");
  });

  it("leaves the vinyl sheet whole and scores its creases, mountain apart from valley", () => {
    const svg = substrateParts("vinyl", FACES, TILES, [gap("M"), gap("V"), gap("F")], id).join("");
    expect(svg).toContain("el-sheet");
    // Nothing is cut away, so the tiles are the faces: drawing them would paint the same sheet twice.
    expect(svg).not.toContain("el-tile");
    // Mountain and valley are drawn apart because they are priced apart — copper over a mountain is in
    // tension and cracks, over a valley it is in compression and does not.
    expect(svg).toContain("el-crease-m");
    expect(svg).toContain("el-crease-v");
    expect(svg).toContain("el-crease-f");
  });

  it("draws one sheet path per face, on either build", () => {
    for (const material of ["vinyl", "printed"] as const) {
      const parts = substrateParts(material, FACES, TILES, [], id);
      expect(parts.filter((p) => /el-(sheet|cloth)/.test(p))).toHaveLength(FACES.length);
    }
  });

  it("skips a degenerate face rather than emitting a path with no area", () => {
    const thin = [...FACES, { poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }], centroid: { x: 0, y: 0 }, verts: [0, 1] }] as unknown as FlatFace[];
    expect(substrateParts("vinyl", thin, [], [], id)).toHaveLength(FACES.length);
  });

  it("draws nothing for a ratsnest with nothing in it", () => {
    expect(ratsnestParts(undefined, id)).toEqual([]);
    expect(ratsnestParts([{ ratsnest: [] }], id)).toEqual([]);
    expect(ratsnestParts([{ ratsnest: [[{ x: 0, y: 0 }, { x: 1, y: 1 }]] }], id)).toHaveLength(1);
  });

  it("gives the battery two terminals, each signed", () => {
    const svg = batteryParts({ pwr: { x: 1, y: 1 }, gnd: { x: 2, y: 2 } }, 0.5, id).join("");
    expect(svg.match(/<rect /g)).toHaveLength(2);
    expect(svg).toContain("+");
    expect(svg).toContain("−");
    expect(svg).toContain("el-batt-pwr");
    expect(svg).toContain("el-batt-gnd");
  });
});
