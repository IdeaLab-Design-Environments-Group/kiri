import { describe, expect, it } from "vitest";
import { carrierExport, stripsExport, type ExportRequest } from "../../../src/view/electronics-export.js";
import type { ElectronicsDesignAdapter } from "../../../src/model/electronics-design.js";
import type { CopperCarrierExport, CopperSvgExport } from "../../../src/model/copper-svg-export.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import type { Jump } from "../../../src/model/trace-types.js";
import type { Trace2D } from "../../../src/model/electronics-routing.js";

/**
 * A stand-in for the real builders: the sentences are what is under test, not the geometry.
 *
 * It records the input it was handed, because half of what this module does is *thread* — a `jumps` the
 * modal supplies and the adapter never receives would show up as a silent zero rather than as a wrong
 * sentence, and no assertion on the message would catch it.
 */
function stubDesign(): ElectronicsDesignAdapter & { seen: { strips?: unknown; carrier?: unknown } } {
  const seen: { strips?: unknown; carrier?: unknown } = {};
  const nope = () => {
    throw new Error("not used by the export helpers");
  };
  return {
    seen,
    route: nope,
    tapeWidth: nope,
    tapeMm: nope,
    batteryTerminals: nope,
    patternDiag: nope,
    strips: (input): CopperSvgExport => {
      seen.strips = input;
      return {
        filename: "k-copper.svg", svg: "<svg/>", widthMm: 3.25, narrowestMm: 3.25, tooNarrow: false,
        counts: { pwr: 1, gnd: 1, jumps: (input.jumps ?? []).length },
      };
    },
    carrier: (input): CopperCarrierExport => {
      seen.carrier = input;
      return {
        filename: "k-copper-carrier.svg", svg: "<svg/>", widthMm: 3.25, narrowestMm: 3.25, tooNarrow: false,
        counts: { traces: 2, tabs: 2, jumps: (input.jumps ?? []).length },
        crossingTabs: 0, padTabs: 0, componentTabs: 0, tabPaths: [], unclosedCuts: 0,
        frame: { window: { x0: 0, y0: 0, x1: 1, y1: 1 }, outer: { x0: 0, y0: 0, x1: 2, y1: 2 } },
      };
    },
  };
}

const TRACE: Trace2D = { pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }], net: "gnd", width: 1 };

function request(design: ElectronicsDesignAdapter, jumps?: Jump[]): ExportRequest {
  return {
    design, fold: {} as FoldFile, traces: [TRACE], tapeW: 1, side: "front",
    mirror: { x: false, y: false }, jumps,
  };
}

/** `n` jumps, each across its own seam, so they carry `n` distinct labels. */
function jumps(n: number): Jump[] {
  const p = { x: 0, y: 0 };
  return Array.from({ length: n }, (_, i) => ({ a: p, b: p, net: "gnd", pair: i, source: "drawn" as const }));
}

const SOLDER = "to solder by hand: join each pair of J-labelled lands with wire once the sheet is folded";

describe("view/electronics-export: the jump sentence", () => {
  it("says nothing about jumps when there are none", () => {
    // Silence is the whole point: on the overwhelming majority of sheets there is no seam to solder, and a
    // "0 jumps" clause would be one more thing to read past on every export.
    const design = stubDesign();
    expect(carrierExport(request(design)).message).not.toContain("jump");
    expect(carrierExport(request(design, [])).message).not.toContain("jump");
  });

  it("says one jump in the singular", () => {
    const message = carrierExport(request(stubDesign(), jumps(1))).message;
    expect(message).toContain(`1 jump ${SOLDER}`);
    expect(message).not.toContain("1 jumps");
  });

  it("says three jumps in the plural", () => {
    expect(carrierExport(request(stubDesign(), jumps(3))).message).toContain(`3 jumps ${SOLDER}`);
  });

  it("says it last, after the warnings about the cut itself", () => {
    // Order is deliberate. Everything before this is about whether the file will cut; this is about what is
    // left to do once it has, so it reads as the next step rather than as another fault.
    const message = carrierExport(request(stubDesign(), jumps(1))).message;
    expect(message.indexOf("jump")).toBeGreaterThan(message.indexOf("mm wide"));
  });

  it("hands the jumps to both builders, not just to the sentence", () => {
    // The carrier draws them; the strips file only counts them. Both are given the same list.
    const design = stubDesign();
    const req = request(design, jumps(2));
    carrierExport(req);
    stripsExport(req);
    expect((design.seen.carrier as { jumps?: Jump[] }).jumps).toHaveLength(2);
    expect((design.seen.strips as { jumps?: Jump[] }).jumps).toHaveLength(2);
  });

  it("leaves the strips file's sentence alone", () => {
    // The strips file has no annotation layer and no frame: a jump's lands are cut there as ordinary GND
    // strips and are already counted as such, so there is nothing extra to say.
    expect(stripsExport(request(stubDesign(), jumps(2))).message).not.toContain("jump");
  });
});
