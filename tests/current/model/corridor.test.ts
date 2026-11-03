/**
 * The corridor: where tape may go, and the search over it.
 *
 * The fixtures are hand-built folds small enough to reason about by eye. A bridge over an opening is
 * `gap-bridge.test.ts`'s and a zero-width seam is `cut-crossing.test.ts`'s; this file is the rest.
 */
import { describe, expect, it } from "vitest";
import { flatFaces } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { tapeOffBodyAt, tapeOnBody } from "../../../src/model/corridor.js";

/** A FOLD of the given face outlines, with vertices shared wherever two outlines meet at a corner. */
function fold(polys: [number, number][][]): FoldFile {
  const verts: [number, number][] = [];
  const idx = (p: [number, number]): number => {
    const k = verts.findIndex((v) => Math.abs(v[0] - p[0]) < 1e-9 && Math.abs(v[1] - p[1]) < 1e-9);
    if (k >= 0) return k;
    verts.push(p);
    return verts.length - 1;
  };
  return { vertices_coords: verts, faces_vertices: polys.map((poly) => poly.map(idx)) } as unknown as FoldFile;
}

describe("model/corridor › a strip of tape", () => {
  it("is off the body when its centreline runs along a slit narrower than the tape", () => {
    // Two tiles half a unit apart, tape 1.5 wide. Laid lengthwise down the slit, both edges of the strip
    // are on material and the middle of it is over nothing.
    const faces = flatFaces(fold([
      [[0, 0], [10, 0], [10, 10], [0, 10]],
      [[10.5, 0], [20, 0], [20, 10], [10.5, 10]],
    ]));
    const a = { x: 10.25, y: 1 }, b = { x: 10.25, y: 9 };
    expect(tapeOnBody(faces, 1.5, a, b)).toBe(false);
    expect(tapeOffBodyAt(faces, 1.5, a, b)).not.toBeNull();
    // The controls: wholly on one tile is fine, across the slit is not.
    expect(tapeOnBody(faces, 1.5, { x: 2, y: 5 }, { x: 8, y: 5 })).toBe(true);
    expect(tapeOnBody(faces, 1.5, { x: 5, y: 5 }, { x: 15, y: 5 })).toBe(false);
  });
});
