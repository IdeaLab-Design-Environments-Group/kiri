/**
 * What the jump toll is worth, pinned at the price it was chosen from.
 *
 * `corridor-jumps.ts › JUMP_TOLL_DIAGS` is one pattern diagonal, and the reason it is defensible is that
 * it sits in the middle of a plateau rather than on a slope. `scripts/_jump-sweep.ts` swept it from a
 * quarter of a diagonal to twenty — a bridge's price, the corridor's deliberate last resort — across six
 * patterns at two, three and four nets, and **the plan never moved**. So the plateau is not a window
 * inside the swept range, it is the whole of it, and this file pins that rather than a narrower claim
 * the sweep does not support.
 *
 * The reason it is that flat is worth stating, because it is a fact about the corridor and not about the
 * constant: on desk-lamp-shade the alternative to one hop is a hundred-odd faces of strip, every crease
 * of it priced at half a diagonal (`tape-width.ts › FOLD_PENALTY_FRAC`), so going round costs tens of
 * diagonals and no price in this range competes with it. What decides the route is therefore whether a
 * jump exists at all, which is the second test: adjacency off lays 617 units of copper, adjacency on
 * lays 27.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, pointInFace, type FlatFace, type Vec2 } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { foldAdjacency, type FoldAdjacency } from "../../../src/model/fold-adjacency.js";
import { planNets } from "../../../src/model/net-routing.js";
import { totalLength } from "../../../src/model/route-metrics.js";
import { tapeWidthFor } from "../../../src/model/electronics-routing.js";
import type { ResolvedNet } from "../../../src/model/netlist.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

const mid = (s: [Vec2, Vec2]): Vec2 => ({ x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 });

/** One unit toward the owning face's centroid: just inside the material, never on its boundary line. */
function inside(p: Vec2, f: FlatFace): Vec2 {
  const dx = f.centroid.x - p.x, dy = f.centroid.y - p.y;
  const d = Math.hypot(dx, dy);
  return d < 1e-9 ? { x: p.x, y: p.y } : { x: p.x + dx / d, y: p.y + dy / d };
}

/** The same terminals `scripts/_jump-sweep.ts` places: the N most-separated pairs, one net each. */
function netsStraddling(adj: FoldAdjacency, faces: FlatFace[], n: number): ResolvedNet[] {
  const sep = (p: { lipA: [Vec2, Vec2]; lipB: [Vec2, Vec2] }): number => {
    const a = mid(p.lipA), b = mid(p.lipB);
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  const ranked = adj.pairs
    .map((pair, i) => ({ pair, i, sep: sep(pair) }))
    .sort((a, b) => b.sep - a.sep || a.i - b.i);
  const out: ResolvedNet[] = [];
  for (const { pair } of ranked) {
    if (out.length >= n) break;
    const fa = faces[pair.faceA], fb = faces[pair.faceB];
    if (!fa || !fb) continue;
    const a = inside(mid(pair.lipA), fa), b = inside(mid(pair.lipB), fb);
    if (pointInFace(faces, a) < 0 || pointInFace(faces, b) < 0) continue;
    const k = out.length;
    out.push({
      id: `n${k}`,
      name: `N${k}`,
      points: [{ part: 2 * k, pad: "1", at: a }, { part: 2 * k + 1, pad: "1", at: b }],
    });
  }
  return out;
}

describe("the jump toll", () => {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}desk-lamp-shade.fkld`, "utf8")) as FoldFile;
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const tapeW = tapeWidthFor(faces);
  const adj = foldAdjacency(fold, faces);
  const nets = netsStraddling(adj, faces, 2);

  const at = (toll: number | null) =>
    planNets(nets, faces, gaps, tapeW, [], undefined, undefined, [], [], [], undefined, undefined,
      toll === null ? null : { ...adj, tollDiags: toll });
  const plan = (r: ReturnType<typeof at>) => JSON.stringify({ jumps: r.jumps, traces: r.traces });

  it("gives the same plan everywhere on the plateau", { timeout: 20_000 }, () => {
    // Half a diagonal to two diagonals is a factor of four in price and no change in the answer, which is
    // what makes 1.0 a choice from a range rather than a tuned constant. Compared as JSON because it is
    // the whole plan that has to match — every jump and every point of every trace — not a summary of it.
    const one = plan(at(1));
    expect(plan(at(0.5)), "tollDiags 0.5 against 1.0").toBe(one);
    expect(plan(at(2)), "tollDiags 2.0 against 1.0").toBe(one);
  });

  it("does not move even at a bridge's price", { timeout: 20_000 }, () => {
    // Measured, not assumed, and it is the opposite of what the plan for this work expected: twenty
    // diagonals is `corridor.ts › BRIDGE_TOLL_DIAGS`, a price meant to make a hop a last resort, and the
    // router takes the jump anyway. It is right to: the alternative here is the length of the strip and
    // every crease along it, which the next test measures at 617 units against 27. A toll of twenty
    // diagonals is simply not dear enough to compete with that, so no price in the swept range changes
    // this route — see `scripts/_jump-sweep.ts`, where the whole 0.25–20 sweep collapses to one row on
    // every pattern.
    const one = at(1), bridgePriced = at(20);
    expect(bridgePriced.jumps).toHaveLength(one.jumps.length);
    expect(
      plan(bridgePriced),
      `toll 20 lays ${totalLength(bridgePriced.traces).toFixed(1)} units over ${bridgePriced.jumps.length} jumps, ` +
      `toll 1 lays ${totalLength(one.traces).toFixed(1)} over ${one.jumps.length}`,
    ).toBe(plan(one));
    // A quarter of a diagonal is the other end of the swept range, and it agrees too.
    expect(plan(at(0.25)), "tollDiags 0.25 against 1.0").toBe(plan(one));
  });

  it("is the presence of the hop, not its price, that decides this route", { timeout: 20_000 }, () => {
    // What the toll cannot do, the absence of adjacency does. This is the difference the whole feature
    // buys on the clean case: the rim of desk-lamp-shade, where going round is the length of the strip.
    const off = at(null), on = at(1);
    expect(off.jumps).toHaveLength(0);
    expect(on.jumps).toHaveLength(2);
    expect(totalLength(off.traces), "copper with adjacency off").toBeGreaterThan(600);
    expect(totalLength(on.traces), "copper with adjacency on").toBeLessThan(60);
  });
});
