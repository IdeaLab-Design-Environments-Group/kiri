import { describe, expect, it } from "vitest";
import {
  emptyScene,
  fmt,
  ptStr,
  sceneLayers,
  sceneSvg,
  type Scene,
  type SceneItem,
} from "../../../src/view/pcb-scene.js";

/** The tag names in a fragment, in the order they are painted. */
function tags(svg: string): string[] {
  return [...svg.matchAll(/<(\w+)/g)].map((m) => m[1]!);
}

/** The class of each element in a fragment, in paint order. */
function classes(svg: string): string[] {
  return [...svg.matchAll(/ class="([^"]*)"/g)].map((m) => m[1]!);
}

const poly = (over: Partial<SceneItem & { kind: "poly" }> = {}): SceneItem =>
  ({ kind: "poly", d: "M 0 0 L 1 0 L 1 1 Z", cls: "el-cloth", ...over }) as SceneItem;

/** A scene with one uniquely-classed item on each layer, so paint order is readable off the output. */
function markedScene(): Scene {
  const s = emptyScene();
  for (const k of ["cloth", "tiles", "copper", "parts", "marks"] as const) {
    s[k].push(poly({ cls: k }));
  }
  return s;
}

describe("view/pcb-scene", () => {
  it("writes a filled polygon as a path carrying its class", () => {
    expect(sceneSvg([poly()])).toBe(`<path d="M 0 0 L 1 0 L 1 1 Z" class="el-cloth" />`);
  });

  it("emits fill-rule evenodd only when the item asks for it", () => {
    expect(sceneSvg([poly()])).not.toContain("fill-rule");
    expect(sceneSvg([poly({ evenodd: false })])).not.toContain("fill-rule");
    expect(sceneSvg([poly({ evenodd: true })])).toContain(`fill-rule="evenodd"`);
  });

  it("gives a wire a round cap, a round join and a stroke width, and no fill", () => {
    const out = sceneSvg([{ kind: "wire", d: "M 0 0 L 5 0", cls: "el-preview", width: 1.5 }]);
    expect(out).toContain(`stroke-linecap="round"`);
    expect(out).toContain(`stroke-linejoin="round"`);
    expect(out).toContain(`stroke-width="1.5"`);
    expect(out).toContain(`fill="none"`);
  });

  it("rounds a wire's width the way the canvas rounds every other number", () => {
    const out = sceneSvg([{ kind: "wire", d: "M 0 0 L 1 0", cls: "w", width: 0.12345 }]);
    expect(out).toContain(`stroke-width="0.123"`);
  });

  it("escapes text content, because a pad name goes into an XML document", () => {
    const out = sceneSvg([{ kind: "text", x: 0, y: 0, size: 2, cls: "t", value: `R&<>"'1` }]);
    expect(out).toContain(`>R&amp;&lt;&gt;&quot;&#39;1</text>`);
    expect(out).not.toContain("R&<");
  });

  it("draws text upright, refusing svg-pcb's per-label counter-flip", () => {
    const out = sceneSvg([{ kind: "text", x: 1, y: 2, size: 3, cls: "el-batt-sign", value: "+" }]);
    expect(out).not.toContain("transform");
    expect(out).not.toContain("scale(1");
    expect(out).toBe(`<text x="1" y="2" class="el-batt-sign" font-size="3">+</text>`);
  });

  it("draws a dot as a circle", () => {
    const out = sceneSvg([{ kind: "dot", x: -1.5, y: 2.25, r: 0.5, cls: "el-led-selected" }]);
    expect(out).toBe(`<circle cx="-1.5" cy="2.25" r="0.5" class="el-led-selected" />`);
  });

  it("paints the layers cloth, tiles, copper, parts, marks, in that order", () => {
    expect(classes(sceneLayers(markedScene()))).toEqual([
      "cloth", "tiles", "copper", "parts", "marks",
    ]);
  });

  it("emits nothing at all for an empty layer, not an empty group", () => {
    const s = emptyScene();
    s.copper.push(poly({ cls: "el-tape" }));
    const out = sceneLayers(s);
    expect(tags(out)).toEqual(["path"]);
    expect(out).not.toContain("<g");
  });

  it("emits an empty string for a wholly empty scene", () => {
    expect(sceneLayers(emptyScene())).toBe("");
    expect(sceneSvg([])).toBe("");
  });

  it("keeps the order of the items within one layer", () => {
    const s = emptyScene();
    s.marks.push(poly({ cls: "first" }), poly({ cls: "second" }));
    expect(classes(sceneLayers(s))).toEqual(["first", "second"]);
  });

  describe("number formatting", () => {
    it("rounds to three decimals, as the canvas does", () => {
      expect(fmt(1.23456)).toBe("1.235");
      expect(fmt(0.0004)).toBe("0");
      expect(fmt(-2.5005)).toBe("-2.5");
    });

    it("leaves a whole number whole, with no trailing zeros", () => {
      expect(fmt(3)).toBe("3");
      expect(fmt(-0)).toBe("0");
      expect(fmt(1.5)).toBe("1.5");
    });

    it("turns anything that is not a finite number into a zero", () => {
      expect(fmt(NaN)).toBe("0");
      expect(fmt(Infinity)).toBe("0");
      expect(fmt(-Infinity)).toBe("0");
    });

    it("writes a point as two formatted numbers separated by a space", () => {
      expect(ptStr({ x: 1.23456, y: -7 })).toBe("1.235 -7");
    });
  });

  /**
   * The exact bytes this module emits for each shape the electronics canvas draws.
   *
   * Every expected string below is a literal. That is the whole point of the block: an expectation built by
   * calling `fmt` or `itemSvg` back holds for any `fmt` and any `itemSvg` whatsoever, so it pins nothing.
   * `1.2 * 1.5` is here on purpose — it is `1.7999999999999998`, and only a three-decimal rounding writes it
   * as `1.8`.
   *
   * **What this does NOT check**: that these bytes match what `electronics-modal.ts`'s `draw()` emits.
   * Nothing in this file imports the modal, and nothing can: its `fmt` is module-private. The two are
   * byte-identical today by hand, and the only thing keeping them so is the note on {@link fmt}. Enforcing
   * it would take exporting the modal's `fmt` — or, better, having the modal use this one.
   */
  describe("the bytes this module emits", () => {
    it("writes a cloth and a tile path", () => {
      const d = "M 0 0 L 10 0 L 10 10 Z";
      expect(sceneSvg([{ kind: "poly", d, cls: "el-cloth" }])).toBe(
        `<path d="M 0 0 L 10 0 L 10 10 Z" class="el-cloth" />`,
      );
      expect(sceneSvg([{ kind: "poly", d, cls: "el-tile" }])).toBe(
        `<path d="M 0 0 L 10 0 L 10 10 Z" class="el-tile" />`,
      );
    });

    it("writes a run of copper tape, holes and all", () => {
      const d = "M 0 0 L 10 0 L 10 2 Z M 3 0.5 L 4 0.5 L 4 1.5 Z";
      expect(sceneSvg([{ kind: "poly", d, cls: "el-tape el-tape-pwr", evenodd: true }])).toBe(
        `<path d="M 0 0 L 10 0 L 10 2 Z M 3 0.5 L 4 0.5 L 4 1.5 Z" ` +
          `class="el-tape el-tape-pwr" fill-rule="evenodd" />`,
      );
    });

    it("writes a selection ring", () => {
      expect(sceneSvg([{ kind: "dot", x: 4.5, y: 3.5, r: 2.75, cls: "el-part-selected" }])).toBe(
        `<circle cx="4.5" cy="3.5" r="2.75" class="el-part-selected" />`,
      );
    });

    it("writes a battery sign, rounding its size to three decimals", () => {
      // The size the canvas computes for the sign: a square's radius times 1.5, which lands on
      // 1.7999999999999998 and must be written `1.8`.
      expect(sceneSvg([
        { kind: "text", x: 2, y: 3, size: 1.2 * 1.5, cls: "el-batt-sign", value: "−" },
      ])).toBe(`<text x="2" y="3" class="el-batt-sign" font-size="1.8">−</text>`);
    });
  });
});
