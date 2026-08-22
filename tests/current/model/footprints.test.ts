import { describe, expect, it } from "vitest";
import {
  LED_1206_part,
  R_1206_part,
  padNamed,
  padSpan,
  slide_switch_part,
  type Component,
} from "../../../src/model/footprints.generated.js";

const ALL: Component[] = [LED_1206_part, R_1206_part, slide_switch_part];

describe("model/footprints", () => {
  it("addresses a terminal by name, and says so when there is none", () => {
    // The point of naming them. Reading `pads[1]` quietly returns whatever is second, and the order has
    // already changed once — when the switch's common moved to the far edge.
    expect(padNamed(slide_switch_part, "common").index).toBe(2);
    expect(padNamed(LED_1206_part, "A").at.x).toBeLessThan(0);
    expect(padNamed(LED_1206_part, "C").at.x).toBeGreaterThan(0);
    expect(() => padNamed(LED_1206_part, "nope")).toThrow(/no pad nope/);
  });

  it("gives every pad an outline, a place, a layer and a number", () => {
    for (const c of ALL) {
      expect(c.pads.length, c.name).toBeGreaterThan(0);
      const names = new Set<string>();
      const indices = new Set<number>();
      for (const p of c.pads) {
        expect(p.name, `${c.name} pad name`).not.toBe("");
        expect(names.has(p.name), `${c.name} repeats the pad name ${p.name}`).toBe(false);
        names.add(p.name);
        expect(indices.has(p.index), `${c.name} repeats the index ${p.index}`).toBe(false);
        indices.add(p.index);
        expect(p.layers.length, `${c.name}.${p.name} layers`).toBeGreaterThan(0);
        // A polygon, not a pair of numbers: at least a triangle, and closed by convention rather than by
        // repeating the first point.
        expect(p.outline.length, `${c.name}.${p.name} outline`).toBeGreaterThanOrEqual(3);
        expect(p.outline[0]).not.toEqual(p.outline[p.outline.length - 1]);
      }
    }
  });

  it("keeps the path and the points saying the same thing", () => {
    // Both are emitted so neither side has to parse the other; they must not drift apart.
    for (const c of ALL) {
      for (const p of c.pads) {
        const nums = (p.shape.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        expect(nums.length, `${c.name}.${p.name}`).toBe(p.outline.length * 2);
        p.outline.forEach((q, i) => {
          expect(nums[2 * i]).toBeCloseTo(q.x, 4);
          expect(nums[2 * i + 1]).toBeCloseTo(q.y, 4);
        });
        expect(p.shape.trimEnd().endsWith("Z"), `${c.name}.${p.name} closes`).toBe(true);
      }
    }
  });

  it("measures a pad from its outline, whatever shape it is", () => {
    // `padSpan` reads the polygon, so it is right for a pad that is not a rectangle — which the old width
    // and height could not even express.
    const a = padNamed(LED_1206_part, "A");
    expect(padSpan(a).w).toBeCloseTo(0.064 * 25.4, 4);
    expect(padSpan(a).h).toBeCloseTo(0.068 * 25.4, 4);

    const skew = { ...a, outline: [{ x: 0, y: 0 }, { x: 3, y: 1 }, { x: 2, y: 4 }] };
    expect(padSpan(skew).w).toBeCloseTo(3, 9);
    expect(padSpan(skew).h).toBeCloseTo(4, 9);
  });

  it("holds the switch's own arrangement: two throws one side, the common the other", () => {
    const t1 = padNamed(slide_switch_part, "throw_a");
    const t2 = padNamed(slide_switch_part, "throw_b");
    const common = padNamed(slide_switch_part, "common");
    expect(t1.at.y).toBeCloseTo(t2.at.y, 9);              // the throws share an edge
    expect(Math.sign(common.at.y)).toBe(-Math.sign(t1.at.y)); // the common is on the other
    expect(common.at.x).toBeCloseTo((t1.at.x + t2.at.x) / 2, 9); // square between them
    // And its two mounting holes, on the centre line between the rows.
    expect(slide_switch_part.holes).toHaveLength(2);
    for (const h of slide_switch_part.holes) expect(h.at.y).toBeCloseTo(0, 9);
  });
});
