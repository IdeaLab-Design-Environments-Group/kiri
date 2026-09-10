/**
 * Whether a jump can be soldered: adjacency, position along the seam, and clearance around its lands.
 *
 * `desk-lamp-shade.fkld` throughout. It is the pattern the whole jump feature was proposed for — a strip
 * whose two short edges are one rim — and it is the one bundled example with lip pairs whose two lips lie
 * hundreds of units apart in the flat pattern, which is exactly the case a planar reading cannot express.
 * Its 56 pairs come from `fold-adjacency.test.ts`; here they are only the raw material.
 *
 * Nothing below pins geometry the implementation produced. Each case is a property: an end nudged one unit
 * into its own face off the middle of a lip is a jump the folding closes; two ends a tenth and nine tenths
 * of the way along the same seam are a jump it does not; a land laid on another net's copper is a short
 * whatever the topology says. The `"along the seam"` wording is asserted because it is the only message
 * that tells an author they have the right cut and the wrong place on it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, type FlatFace, type Vec2 } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { DEFAULT_SHEET } from "../../../src/model/fold-strain.js";
import { foldAdjacency, type FoldAdjacency } from "../../../src/model/fold-adjacency.js";
import { jumpLandTraces } from "../../../src/model/manual-jump.js";
import { tapeMmFor, tapeWidthFor } from "../../../src/model/tape-width.js";
import type { Jump, Trace2D } from "../../../src/model/trace-types.js";
import { ERRORS, isBuildable, type WireFaultKind } from "../../../src/model/wire-rules.js";
import { JUMP_SKEW_TAPES, checkJump, type JumpRuleContext } from "../../../src/model/jump-rules.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** The pattern, its lip pairing, and the context every case here is checked against. */
function fixture(name = "desk-lamp-shade.fkld"): {
  faces: FlatFace[];
  adjacency: FoldAdjacency;
  ctx: JumpRuleContext;
} {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8")) as FoldFile;
  const faces = flatFaces(fold);
  const adjacency = foldAdjacency(fold, faces);
  const tapeW = tapeWidthFor(faces);
  const tapeMm = tapeMmFor(faces);
  return { faces, adjacency, ctx: { adjacency, tapeW, tapeMm, sheet: DEFAULT_SHEET, faces } };
}

/**
 * A point `u` of the way along one lip of pair `pi`, nudged `nudge` units toward its own face's centroid.
 *
 * The nudge is what an author's tap produces: a lip is the boundary of its face, so a point exactly on it
 * is on the edge of the material and `pointInFace` may or may not claim it. One unit in is unambiguously
 * on the face and still well inside the tape width `pairContaining` reaches with.
 */
function endAt(
  fx: ReturnType<typeof fixture>,
  pi: number,
  side: "A" | "B",
  u: number,
  nudge = 1,
): Vec2 {
  const pair = fx.adjacency.pairs[pi]!;
  const lip = side === "A" ? pair.lipA : pair.lipB;
  const face = fx.faces[side === "A" ? pair.faceA : pair.faceB]!;
  const x = lip[0].x + (lip[1].x - lip[0].x) * u;
  const y = lip[0].y + (lip[1].y - lip[0].y) * u;
  const dx = face.centroid.x - x, dy = face.centroid.y - y;
  const L = Math.hypot(dx, dy);
  return { x: x + (dx / L) * nudge, y: y + (dy / L) * nudge };
}

/** Pairs whose two lips are far apart in the flat pattern — the rim of the shade, and the interesting case. */
function rimPairs(fx: ReturnType<typeof fixture>): number[] {
  const out: number[] = [];
  fx.adjacency.pairs.forEach((p, i) => {
    if (Math.hypot(p.lipA[0].x - p.lipB[0].x, p.lipA[0].y - p.lipB[0].y) > 20) out.push(i);
  });
  return out;
}

/** A jump across pair `pi` at the middle of both lips: the one the folding closes exactly. */
function cleanJump(fx: ReturnType<typeof fixture>, pi: number, net = "sig", id = "j1"): Jump {
  return { a: endAt(fx, pi, "A", 0.5), b: endAt(fx, pi, "B", 0.5), net, pair: pi, source: "drawn", id };
}

/**
 * The land the rule measures clearance around, taken from the module that lays it.
 *
 * `jumpLandTraces` and not a reconstruction, so a foreign run built here sits exactly on the copper the
 * rule reads rather than merely near it — the land is shortened where the material runs out, and a
 * hand-built full-length stub would test a slightly different segment than the one under check.
 */
function landOf(fx: ReturnType<typeof fixture>, j: Jump, end: 0 | 1): Vec2[] {
  return jumpLandTraces([j], fx.ctx.tapeW, fx.faces)[end]!.pts;
}

const kinds = (fs: { kind: WireFaultKind }[]): WireFaultKind[] => fs.map((f) => f.kind);

describe("checkJump", () => {
  it("passes a jump whose ends are the middle of both lips of one cut", { timeout: 20_000 }, () => {
    const fx = fixture();
    const rim = rimPairs(fx);
    expect(rim.length).toBeGreaterThan(0);
    const j = cleanJump(fx, rim[0]!);
    expect(checkJump(j, fx.ctx, [], [])).toEqual([]);
    expect(isBuildable(checkJump(j, fx.ctx, [], []))).toBe(true);
  });

  it("refuses a jump between lips of two different cuts", { timeout: 20_000 }, () => {
    const fx = fixture();
    const rim = rimPairs(fx);
    expect(rim.length).toBeGreaterThan(1);
    // `pair` is set to a real pair index deliberately: the -1 shortcut is tested separately, and this case
    // has to fail on the geometry rather than on the resolver having already said so.
    const j: Jump = {
      a: endAt(fx, rim[0]!, "A", 0.5),
      b: endAt(fx, rim[1]!, "B", 0.5),
      net: "sig",
      pair: rim[0]!,
      source: "drawn",
      id: "j1",
    };
    const faults = checkJump(j, fx.ctx, [], []);
    expect(kinds(faults)).toEqual(["jump-not-adjacent"]);
    expect(isBuildable(faults)).toBe(false);
  });

  it("takes the resolver's word when it already said the ends sit on no one pair", { timeout: 20_000 }, () => {
    const fx = fixture();
    const j = { ...cleanJump(fx, rimPairs(fx)[0]!), pair: -1 };
    expect(kinds(checkJump(j, fx.ctx, [], []))).toEqual(["jump-not-adjacent"]);
  });

  it("refuses two ends far apart along the same seam, and says so", { timeout: 20_000 }, () => {
    const fx = fixture();
    const pi = rimPairs(fx)[0]!;
    const pair = fx.adjacency.pairs[pi]!;
    const seam = Math.hypot(pair.lipA[1].x - pair.lipA[0].x, pair.lipA[1].y - pair.lipA[0].y);
    // The property, not the number: eight tenths of this seam has to be more than the allowance, or the
    // case proves nothing about the rule.
    expect(0.8 * seam).toBeGreaterThan(JUMP_SKEW_TAPES * fx.ctx.tapeW);

    const j: Jump = {
      a: endAt(fx, pi, "A", 0.1),
      b: endAt(fx, pi, "B", 0.9),
      net: "sig",
      pair: pi,
      source: "drawn",
      id: "j1",
    };
    const faults = checkJump(j, fx.ctx, [], []);
    expect(kinds(faults)).toEqual(["jump-not-adjacent"]);
    expect(faults[0]!.why).toContain("along the seam");
  });

  it("warns about an end resting on no material, and says nothing else about it", { timeout: 20_000 }, () => {
    const fx = fixture();
    const pi = rimPairs(fx)[0]!;
    let maxX = -Infinity, y = 0;
    for (const f of fx.faces) for (const v of f.poly) if (v.x > maxX) { maxX = v.x; y = v.y; }
    const j: Jump = {
      a: endAt(fx, pi, "A", 0.5),
      b: { x: maxX + 50, y },
      net: "sig",
      pair: pi,
      source: "drawn",
      id: "j1",
    };
    const faults = checkJump(j, fx.ctx, [], []);
    // Exactly one: the adjacency reading is skipped rather than piling a second, misleading message onto an
    // end that has no lip to be measured against.
    expect(kinds(faults)).toEqual(["jump-unanchored"]);
    expect(faults[0]!.at.x).toBeCloseTo(maxX + 50, 9);
    expect(isBuildable(faults)).toBe(true);
  });

  it("refuses a land laid on another net's routed copper, and names the net", { timeout: 20_000 }, () => {
    const fx = fixture();
    const j = cleanJump(fx, rimPairs(fx)[0]!, "sig");
    const foreign: Trace2D = { pts: landOf(fx, j, 0), net: "gnd" };
    const faults = checkJump(j, fx.ctx, [foreign], []);
    expect(kinds(faults)).toEqual(["jump-land-clash"]);
    expect(faults[0]!.net).toBe("gnd");
    expect(faults[0]!.why).toContain("gnd");
    expect(faults[0]!.jump).toBe("j1");
    expect(isBuildable(faults)).toBe(false);
  });

  it("does not charge a jump for running alongside its own net", { timeout: 20_000 }, () => {
    const fx = fixture();
    const j = cleanJump(fx, rimPairs(fx)[0]!, "sig");
    const mine: Trace2D = { pts: landOf(fx, j, 0), net: "sig" };
    expect(checkJump(j, fx.ctx, [mine], [])).toEqual([]);
  });

  it("refuses a land within the weed gap of another net's land", { timeout: 20_000 }, () => {
    const fx = fixture();
    const pi = rimPairs(fx)[0]!;
    const j = cleanJump(fx, pi, "sig", "j1");
    const other: Jump = { ...cleanJump(fx, pi, "pwr", "j2") };
    const faults = checkJump(j, fx.ctx, [], [other]);
    // Both ends clash — the two jumps are the same geometry on two nets — and each is charged to its own
    // end, so the author knows there are two places to move.
    expect(kinds(faults)).toEqual(["jump-land-clash", "jump-land-clash"]);
    expect(faults.every((f) => f.net === "pwr")).toBe(true);
  });

  it("lets two jumps of one net share a seam", { timeout: 20_000 }, () => {
    const fx = fixture();
    const pi = rimPairs(fx)[0]!;
    const j = cleanJump(fx, pi, "sig", "j1");
    const twin: Jump = { ...cleanJump(fx, pi, "sig", "j2") };
    expect(checkJump(j, fx.ctx, [], [twin])).toEqual([]);
    // And a jump handed itself in `others` is not its own clash, whatever the caller passes.
    expect(checkJump(j, fx.ctx, [], [j])).toEqual([]);
  });

  it("blocks a build on a jump's errors and on neither of its warnings", () => {
    for (const kind of ["jump-not-adjacent", "jump-land-clash"] as const) {
      expect(ERRORS.has(kind)).toBe(true);
      expect(isBuildable([{ kind, at: { x: 0, y: 0 }, why: "" }])).toBe(false);
    }
    expect(ERRORS.has("jump-unanchored")).toBe(false);
    expect(isBuildable([{ kind: "jump-unanchored", at: { x: 0, y: 0 }, why: "" }])).toBe(true);
  });
});
