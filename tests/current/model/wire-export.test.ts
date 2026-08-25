/**
 * A hand-drawn wire is an ordinary run of copper, and everything downstream must treat it as one.
 *
 * `manualTraces` hands back plain {@link Trace2D}s, so the strips file and the folded model should pick
 * them up with no branch of their own. That is the property under test here, and it is worth pinning: the
 * alternative — a second path through the export for "the drawn ones" — is how the carrier once came to lay
 * copper at a width the strips file did not.
 *
 * The width is the sharp edge of it. A wire may be narrower than the tape, and a strip emitted at full
 * width where the author drew a thin one is copper the cutter takes off the sheet in the wrong place. The
 * cut file already honours `Trace2D.width`; `anchorOverlay` did not, so the 3D view showed a wire wider
 * than the one being cut.
 *
 * **What these tests do not say.** Every one of them hands `manualTraces(ctx)` to the export itself. They
 * therefore show that the export and the overlay *can* render a hand-drawn wire correctly when given one —
 * not that anything in the app ever gives them one. Checked at the time of writing, no production call site
 * does:
 *
 *  - the cut file: `electronics-modal.ts`'s `exportCopper` passes `this.routed.traces`;
 *  - the folded model: `app-controller.ts`'s `tracesForSim` passes `routed.traces` to `anchorOverlay`.
 *
 * `planRoutes` does not read `circuit.wires`, so neither list contains a drawn wire. The only place a
 * manual trace reaches today is the modal's own canvas (`manualTraces(this.wireContext())` in `draw()`).
 * A hand-drawn wire is thus visible on screen and absent from the cut file and from the 3D view — a real
 * gap in the feature, not a gap in these tests. Wiring the two call sites up is what would make these
 * tests speak for the app; until then they are unit tests of the export, and this file must not be read as
 * evidence that a drawn wire gets cut.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { manualTraces, type ManualWire, type WireContext } from "../../../src/model/manual-wire.js";
import {
  buildCopperSvgExport,
  sheetFrame,
  stripOutline,
} from "../../../src/model/copper-svg-export.js";
import { anchorOverlay } from "../../../src/model/trace-anchor.js";
import { tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { flatFaces, gapGraph, pointInFace, type FlatFace, type Vec2 } from "../../../src/model/electronics.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** house, its pattern and its tape — the fixture the routing and wire tests already use. */
function house() {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}house.fkld`, "utf8"));
  const faces = flatFaces(fold);
  return { fold, faces, gaps: gapGraph(fold, faces).gaps, tapeW: tapeWidthFor(faces) };
}

/**
 * Two points well inside face `index`, `length` apart along that face's first edge.
 *
 * Picked rather than written down so the fixture cannot drift out of the face when the pattern changes,
 * and checked here: a wire whose ends fall off the material would be dropped by `anchorOverlay` for a
 * reason that has nothing to do with what these tests are about.
 */
function segmentIn(faces: FlatFace[], index: number, length: number): [Vec2, Vec2] {
  const f = faces[index]!;
  const d = { x: f.poly[1]!.x - f.poly[0]!.x, y: f.poly[1]!.y - f.poly[0]!.y };
  const n = Math.hypot(d.x, d.y);
  const u = { x: d.x / n, y: d.y / n };
  const a = { x: f.centroid.x - (u.x * length) / 2, y: f.centroid.y - (u.y * length) / 2 };
  const b = { x: f.centroid.x + (u.x * length) / 2, y: f.centroid.y + (u.y * length) / 2 };
  expect(pointInFace(faces, a)).toBe(index);
  expect(pointInFace(faces, b)).toBe(index);
  return [a, b];
}

/** A context carrying exactly `wires` on house, and nothing else. */
function withWires(wires: ManualWire[]): WireContext & { fold: unknown } {
  const { fold, faces, gaps, tapeW } = house();
  return { fold, faces, gaps, tapeW, circuit: { leds: [], battery: null, wires } };
}

/** The `<path d="...">` rings of one layer of the export, as points. */
function ringsOf(svg: string, id: string): Vec2[][] {
  const from = svg.indexOf(`<g id="${id}"`);
  if (from < 0) return [];
  const layer = svg.slice(from, svg.indexOf("</g>", from));
  const out: Vec2[][] = [];
  for (const m of layer.matchAll(/<path d="([^"]+)"/g)) {
    for (const sub of m[1]!.split(/(?=M )/)) {
      if (!sub.trim()) continue;
      const n = sub.replace(/[MLZ]/g, " ").trim().split(/\s+/).map(Number);
      const pts: Vec2[] = [];
      for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i]!, y: n[i + 1]! });
      out.push(pts);
    }
  }
  return out;
}

/** How far the outline reaches either side of the straight run `a`→`b` — the run's half-width. */
function halfWidthAbout(outline: Vec2[], a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  let far = 0;
  for (const p of outline) {
    far = Math.max(far, Math.abs(((p.x - a.x) * dy - (p.y - a.y) * dx) / L));
  }
  return far;
}

/** Every anchored corner put back on the flat pattern, so a ribbon can be measured where it was built. */
function flatten(tris: { tri: [number, number, number]; bary: [number, number, number] }[], faces: FlatFace[]): Vec2[] {
  const at = new Map<number, Vec2>();
  for (const f of faces) f.verts.forEach((v, i) => at.set(v, f.poly[i]!));
  return tris.map((t) => {
    let x = 0, y = 0;
    for (let k = 0; k < 3; k++) {
      const p = at.get(t.tri[k]!)!;
      x += t.bary[k]! * p.x;
      y += t.bary[k]! * p.y;
    }
    return { x, y };
  });
}

describe("model/wire-export", () => {
  it("cuts a hand-drawn wire it is handed as copper, on the net's own layer and not among the parts", () => {
    const [a, b] = segmentIn(house().faces, 0, 0.3);
    const ctx = withWires([{ id: "w1", net: "pwr", pts: [
      { kind: "free", x: a.x, y: a.y },
      { kind: "free", x: b.x, y: b.y },
    ] }]);
    const traces = manualTraces(ctx);
    expect(traces).toHaveLength(1);

    const out = buildCopperSvgExport(ctx.fold as never, traces, ctx.tapeW);
    expect(out.counts).toEqual({ pwr: 1, gnd: 0 });

    // The emitted ring IS the strip outline of that trace, mapped onto the sheet — the drawn wire goes
    // through the same geometry as a routed run rather than a path of its own.
    const { T } = sheetFrame(ctx.fold as never);
    const want = stripOutline(traces[0]!, ctx.tapeW).map(T);
    const [ring] = ringsOf(out.svg, "pwr");
    expect(ring).toHaveLength(want.length);
    ring!.forEach((p, i) => {
      expect(p.x).toBeCloseTo(want[i]!.x, 2);
      expect(p.y).toBeCloseTo(want[i]!.y, 2);
    });

    // Parts are drawn, never cut. Nothing was placed, so there is no parts layer to have leaked into.
    expect(ringsOf(out.svg, "parts")).toHaveLength(0);
  });

  it("cuts a wire it is handed at its own width where the author set one, and at the tape's where they did not", () => {
    const [a, b] = segmentIn(house().faces, 0, 0.3);
    const pts: ManualWire["pts"] = [
      { kind: "free", x: a.x, y: a.y },
      { kind: "free", x: b.x, y: b.y },
    ];
    const { tapeW } = house();
    const narrow = tapeW / 3;

    const plain = manualTraces(withWires([{ id: "w1", net: "pwr", pts }]))[0]!;
    const thin = manualTraces(withWires([{ id: "w2", net: "pwr", pts, width: narrow }]))[0]!;
    expect(plain.width).toBeUndefined();
    expect(thin.width).toBeCloseTo(narrow, 12);

    expect(halfWidthAbout(stripOutline(plain, tapeW), a, b)).toBeCloseTo(tapeW / 2, 9);
    expect(halfWidthAbout(stripOutline(thin, tapeW), a, b)).toBeCloseTo(narrow / 2, 9);
  });

  it("draws a hand-drawn wire it is handed onto the folded model, at the width it would be cut at", () => {
    const { faces, tapeW } = house();
    const [a, b] = segmentIn(faces, 0, 0.3);
    const pts: ManualWire["pts"] = [
      { kind: "free", x: a.x, y: a.y },
      { kind: "free", x: b.x, y: b.y },
    ];
    const narrow = tapeW / 3;
    const plain = manualTraces(withWires([{ id: "w1", net: "pwr", pts }]));
    const thin = manualTraces(withWires([{ id: "w2", net: "pwr", pts, width: narrow }]));

    const meshOf = (traces: typeof plain) => {
      const meshes = anchorOverlay(traces, [], null, tapeW, faces);
      expect(meshes).toHaveLength(1);
      expect(meshes[0]!.kind).toBe("pwr");
      // A quad of ribbon, as two triangles.
      expect(meshes[0]!.tris).toHaveLength(6);
      return meshes[0]!.tris;
    };

    expect(halfWidthAbout(flatten(meshOf(plain), faces), a, b)).toBeCloseTo(tapeW / 2, 9);
    // The one the overlay used to get wrong: a narrow wire drew full-width on the model while the cut
    // file took it off the sheet at a third of that.
    expect(halfWidthAbout(flatten(meshOf(thin), faces), a, b)).toBeCloseTo(narrow / 2, 9);
  });

  it("quietly drops a wire whose ends no longer attach to anything, cutting and drawing nothing", () => {
    // Both ends name a part that is not in the circuit any more — the author deleted it under the wire.
    const ctx = withWires([{ id: "w1", net: "pwr", pts: [
      { kind: "pad", part: 3, pad: "1" },
      { kind: "pad", part: 3, pad: "2" },
    ] }]);
    const traces = manualTraces(ctx);
    expect(traces).toEqual([]);

    const out = buildCopperSvgExport(ctx.fold as never, traces, ctx.tapeW);
    expect(out.counts).toEqual({ pwr: 0, gnd: 0 });
    expect(ringsOf(out.svg, "pwr")).toHaveLength(0);
    expect(anchorOverlay(traces, [], null, ctx.tapeW, ctx.faces)).toEqual([]);
  });
});
