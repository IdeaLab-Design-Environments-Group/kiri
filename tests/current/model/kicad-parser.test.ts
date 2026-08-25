import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPONENTS } from "../../../src/model/footprints.generated.js";
import {
  REST_COMPONENTS,
  Sensor_Optical_ST_VL53L5CXV0GC,
  TQFP_144_20x20mm_P0_5mm,
} from "../../../src/model/footprints.rest.generated.js";
import { padNamed, padPoints, padSize, type Pad, type Vec2 } from "../../../src/model/footprint.js";

/**
 * The KiCad reader, checked against the files it read.
 *
 * `ocaml/kicad.ml` runs at build time, so nothing here can call it. What it produces is committed as
 * `footprints.generated.ts`, and the honest test of a reader is to put its output back beside its
 * input: every vendored `.kicad_mod` file and its every pad, too many to eyeball. So this file parses the
 * sources independently — a few regexes over the s-expressions, sharing no code with the OCaml — and
 * asserts the two agree on how many pads there are and how big each one is.
 *
 * The two failures it exists to catch are the ones that are invisible in the app until something is
 * cut wrong: a pad shape the reader does not know, which used to emit an *empty* outline and vanish
 * silently, and a tessellation that is either coarser than the geometry allows or far finer than
 * anything downstream can resolve.
 */

const FAB = new URL("../../../footprints/fab/", import.meta.url);
/**
 * Both halves of the generated library. The split is a bundling decision — the parts the editor can
 * place load eagerly, the rest lazily — and a reader has to be checked against every one either way.
 */
const GENERATED = [
  new URL("../../../src/model/footprints.generated.ts", import.meta.url),
  new URL("../../../src/model/footprints.rest.generated.ts", import.meta.url),
];
const EVERY_PART = [...COMPONENTS, ...REST_COMPONENTS];

/** The chord-error budget `kicad.ml` tessellates to, and its floor on chords per revolution. */
const CHORD_TOLERANCE_MM = 0.005;
const MIN_CHORDS_PER_TURN = 16;
/** Half a step of the grid emitted coordinates are snapped to — 1e-6 inch — in millimetres. */
const GRID_MM = (25.4 * 1e-6) / 2;

/**
 * Which file each generated const came from. The generator writes it into the doc comment above each
 * one, which is the only place the provenance survives — without it there is no way to check a part
 * against its source.
 */
function sourceFiles(): Map<string, string> {
  const map = new Map<string, string>();
  for (const url of GENERATED) {
    const text = readFileSync(url, "utf8");
    const re = /from `([^`]+\.kicad_mod)`\.\s*\*\/\s*export const (\w+): Footprint/g;
    for (let m = re.exec(text); m; m = re.exec(text)) map.set(m[2]!, m[1]!);
  }
  return map;
}

interface SourcePad {
  kind: string;
  shape: string;
  x: number;
  y: number;
  w: number;
  h: number;
  slot: boolean;
}

/** The `(pad ...)` blocks of a `.kicad_mod`, by balanced parentheses — everything else is ignored. */
function sourcePads(text: string): SourcePad[] {
  const out: SourcePad[] = [];
  for (let i = text.indexOf("(pad "); i >= 0; i = text.indexOf("(pad ", i + 1)) {
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) break;
    }
    const block = text.slice(i, j + 1);
    const head = /^\(pad\s+(?:"[^"]*"|\S+)\s+(\S+)\s+(\S+)/.exec(block);
    const at = /\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?\s*\)/.exec(block);
    const size = /\(size\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(block);
    if (!head || !at || !size) continue;
    // Every rotation in this library is a multiple of 90 degrees, so a bounding box only ever swaps.
    const turn = Math.round(Number(at[3] ?? 0) / 90) % 2 !== 0;
    const w = Number(size[1]);
    const h = Number(size[2]);
    out.push({
      kind: head[1]!,
      shape: head[2]!,
      x: Number(at[1]),
      y: -Number(at[2]),
      w: turn ? h : w,
      h: turn ? w : h,
      slot: /\(drill\s+oval\b/.test(block),
    });
  }
  return out;
}

/** A pad as this test compares it: where it sits and how big it is, in millimetres. */
function measured(pad: Pad): [number, number, number, number] {
  const { w, h } = padSize(pad);
  return [pad.pos[0] * 25.4, pad.pos[1] * 25.4, w, h];
}

function byPosition(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 1e-6) return a[i]! - b[i]!;
  return 0;
}

/**
 * An outline as a cycle of distinct vertices: the closing point dropped, points repeated where an
 * oval's quadrants meet collapsed, and the whole thing turned so it starts at the same corner however
 * the pad was rotated. What survives is the polygon itself and which way round it is wound.
 */
function corners(pad: Pad): Vec2[] {
  const pts = padPoints(pad).slice(0, -1);
  const distinct = pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length]!;
    return Math.hypot(p.x - q.x, p.y - q.y) > 2 * GRID_MM;
  });
  let first = 0;
  for (let i = 1; i < distinct.length; i++) {
    const a = distinct[i]!;
    const b = distinct[first]!;
    if (a.x < b.x - 1e-9 || (Math.abs(a.x - b.x) <= 1e-9 && a.y < b.y - 1e-9)) first = i;
  }
  return [...distinct.slice(first), ...distinct.slice(0, first)];
}

/**
 * If every vertex of an outline is the same distance from the pad's own origin, the outline is a
 * tessellated circle and that distance is its radius. Squares qualify too, which is why this wants
 * enough vertices to be a curve rather than a corner.
 */
function asCircle(pad: Pad): number | undefined {
  const pts = padPoints(pad).slice(0, -1);
  if (pts.length < 8) return undefined;
  const radii = pts.map((p) => Math.hypot(p.x, p.y));
  const r = radii.reduce((a, b) => a + b, 0) / radii.length;
  // Equidistant to within the coordinate grid — vertices are snapped, so they are not exactly so.
  return radii.every((d) => Math.abs(d - r) < 2 * GRID_MM) ? r : undefined;
}

describe("model/kicad-parser", () => {
  it("reads every vendored footprint back to the pad count and pad sizes of its source", () => {
    const files = sourceFiles();
    // Non-vacuous: every part in either half is checked, and the library really is a library — the
    // bound is a floor well under any plausible cull, not a count to be re-recorded after one.
    expect(EVERY_PART.length, "the library went missing").toBeGreaterThan(120);
    expect(files.size, "a part records no source file").toBe(EVERY_PART.length);

    for (const c of EVERY_PART) {
      const file = files.get(c.id);
      expect(file, `${c.id} records no source file`).toBeDefined();
      const src = sourcePads(readFileSync(new URL(file!, FAB), "utf8"));
      // Only pads land in the representation; `connect` and friends are not terminals.
      const kept = src.filter((p) => ["smd", "thru_hole", "np_thru_hole"].includes(p.kind));

      // A slot is cut as its own outline beside its pad, so it adds one entry and no dimensions to
      // compare — it is the drill's shape, not the pad's.
      const pads = Object.entries(c.footprint);
      const slots = pads.filter(([name]) => name.endsWith("_plated_cut"));
      expect(slots.length, `${c.id}: slot outlines`).toBe(kept.filter((p) => p.slot).length);
      const real = pads.filter(([name]) => !name.endsWith("_plated_cut"));
      expect(real.length, `${c.id}: pad count`).toBe(kept.length);

      // Names and order are the parser's business (it renumbers); position and size are the file's.
      const want = kept.map((p) => [p.x, p.y, p.w, p.h]).sort(byPosition);
      const got = real.map(([, p]) => measured(p)).sort(byPosition);
      for (let i = 0; i < want.length; i++) {
        for (let k = 0; k < 4; k++) {
          // A tessellated circle's bounding box can fall short of the true one by a chord error at
          // each end, and nothing else here is allowed to differ by more.
          expect(
            Math.abs(got[i]![k]! - want[i]![k]!),
            `${c.id}: pad ${JSON.stringify(want[i])} came back as ${JSON.stringify(got[i])}`,
          ).toBeLessThanOrEqual(2 * CHORD_TOLERANCE_MM);
        }
      }
    }
  });

  it("never leaves a pad without an outline, whatever shape the file asked for", () => {
    // An unhandled shape used to emit an empty path. Nothing downstream notices: the pad is still in
    // the footprint, still has a position and layers, and simply never gets drawn or cut.
    let pads = 0;
    for (const c of EVERY_PART) {
      for (const [name, pad] of Object.entries(c.footprint)) {
        const pts = padPoints(pad);
        expect(pts.length, `${c.id}.${name} has no outline`).toBeGreaterThanOrEqual(4);
        // Closed: the path returns to where it started.
        expect(Math.hypot(pts[0]!.x - pts.at(-1)!.x, pts[0]!.y - pts.at(-1)!.y)).toBeLessThan(1e-9);
        // Only of a pad that carries copper. Some vendored files declare paste-only slivers a
        // nanometre tall — ICM-20948 has `(size 0.050001 0.000001)` — and a reader that refused to
        // reproduce those would be correcting the file rather than reading it.
        const { w, h } = padSize(pad);
        if (pad.layers.some((l) => l.endsWith(".Cu")))
          expect(Math.min(w, h), `${c.id}.${name} is flat`).toBeGreaterThan(0);
        pads++;
      }
    }
    expect(pads, "the library went missing").toBeGreaterThan(1000);
  });

  it("gives the trapezoid pads of the ST sensor the outline its file describes", () => {
    // The only two trapezoid pads in the library. Neither carries a `rect_delta`, so each is exactly
    // its rectangle — 0.5mm and 0.2mm square — and each used to come through as nothing at all.
    for (const [name, side] of [
      ["A1", 0.5],
      ["A1_1", 0.2],
    ] as const) {
      const pad = padNamed(Sensor_Optical_ST_VL53L5CXV0GC, name);
      expect(padPoints(pad).length, `${name} is not four corners and a close`).toBe(5);
      expect(Math.abs(padSize(pad).w - side)).toBeLessThanOrEqual(2 * GRID_MM);
      expect(Math.abs(padSize(pad).h - side)).toBeLessThanOrEqual(2 * GRID_MM);
    }

    // A zero delta must not merely produce the right size — it must produce the same polygon a `rect`
    // of that size would have, corner for corner and wound the same way, because that is exactly what
    // KiCad's trapezoid degenerates to. `A2` is the neighbouring 0.5mm rect pad; it is not turned and
    // `A1` is turned by 90°, so on a square the two differ only by which corner is written first.
    const trapezoid = corners(padNamed(Sensor_Optical_ST_VL53L5CXV0GC, "A1"));
    const rect = corners(padNamed(Sensor_Optical_ST_VL53L5CXV0GC, "A2"));
    expect(trapezoid.length).toBe(rect.length);
    for (let i = 0; i < rect.length; i++) {
      expect(Math.hypot(trapezoid[i]!.x - rect[i]!.x, trapezoid[i]!.y - rect[i]!.y)).toBeLessThanOrEqual(
        2 * GRID_MM,
      );
    }
  });

  it("tessellates a circle to its own size, neither coarser nor finer than the chord budget", () => {
    // The resolution is a length, not a point count: no chord may fall more than CHORD_TOLERANCE_MM
    // inside the true arc. Both halves of that are worth asserting, and they fail in opposite
    // directions — too coarse and a hole is not round enough to seat a leg, too fine and the 180-point
    // circles come back that made this file a megabyte on their own.
    let circles = 0;
    for (const c of EVERY_PART) {
      for (const [name, pad] of Object.entries(c.footprint)) {
        const r = asCircle(pad);
        if (r === undefined) continue;
        const pts = corners(pad);

        // Measured, not inferred from the point count: the widest gap between neighbouring vertices
        // is what sets the error, and an oval's quadrants meet at a repeated point that would flatter
        // any count-based estimate.
        let widest = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[(i + 1) % pts.length]!;
          widest = Math.max(widest, Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)));
        }
        expect(r * (1 - Math.cos(widest / 2)), `${c.id}.${name} is coarser than the budget`)
          .toBeLessThanOrEqual(CHORD_TOLERANCE_MM + GRID_MM);

        // A vertex on each axis, so the polygon's bounding box is the pad's true size. Everything
        // downstream measures a pad by its box, and a circle tessellated in whole quadrants is the
        // only way that box is not a chord error short on one side — which, scaled into a lead
        // rectangle, is the difference between a round pad and a visibly elliptical one.
        // Slack of four grid steps, since the radius is itself averaged over snapped vertices. That
        // is 0.05µm — a hundred times inside the 5µm a missing axis vertex would cost.
        const box = padSize(pad);
        expect(Math.abs(box.w - 2 * r), `${c.id}.${name}: box ${box.w} across a ${2 * r} circle`)
          .toBeLessThanOrEqual(4 * GRID_MM);
        expect(Math.abs(box.h - 2 * r), `${c.id}.${name}: box ${box.h} tall for a ${2 * r} circle`)
          .toBeLessThanOrEqual(4 * GRID_MM);

        // And no finer than the budget asks for. A circle is drawn in one sweep and an oval as four
        // quarters rounded up independently, so the ceiling is the more generous of the two.
        const step = 2 * Math.acos(1 - CHORD_TOLERANCE_MM / r);
        const cap = 4 * Math.max(MIN_CHORDS_PER_TURN / 4, Math.ceil(Math.PI / 2 / step));
        expect(pts.length, `${c.id}.${name}: ${pts.length} chords for r=${r}mm, at most ${cap}`)
          .toBeLessThanOrEqual(cap);
        circles++;
      }
    }
    expect(circles, "no circular pads found — the check proved nothing").toBeGreaterThan(100);
  });

  it("spends its points on the corner radius a roundrect actually has", () => {
    // The library's only roundrect: 1.475 x 0.3mm at rratio 0.25, so a 0.0375mm corner. The chord
    // budget alone would give that two segments per quarter, which reads as a chamfer however small
    // the error is, so the floor lifts it to four — four corners of five points, and the close.
    expect(padPoints(padNamed(TQFP_144_20x20mm_P0_5mm, "1")).length).toBe(
      4 * (MIN_CHORDS_PER_TURN / 4 + 1) + 1,
    );
  });
});
