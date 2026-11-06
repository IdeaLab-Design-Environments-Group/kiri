import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { carrierExport, type ExportRequest } from "../../../src/view/electronics-export.js";
import { defaultElectronicsDesign } from "../../../src/model/electronics-design.js";

/** A design adapter whose carrier reports the given counts; nothing else is called. */
function request(extra: Record<string, number>): ExportRequest {
  const out = {
    filename: "kiri-front.svg", svg: "<svg/>", widthMm: 6.5, tooNarrow: false,
    counts: { traces: 3, tabs: 4 }, padTabs: 0, componentTabs: 0, crossingTabs: 0, unclosedCuts: 0,
    ...extra,
  };
  return {
    design: { carrier: () => out } as unknown as ExportRequest["design"],
    fold: {} as ExportRequest["fold"],
    traces: [{}] as unknown as ExportRequest["traces"],
    tapeW: 1, side: "front", mirror: { x: false, y: false },
  };
}

describe("view/electronics-export carrierExport", () => {
  it("warns when tabs pass over a component", () => {
    expect(carrierExport(request({ componentTabs: 5 })).message).toContain("warning: 5 tabs pass over a component");
    expect(carrierExport(request({ componentTabs: 1 })).message).toContain("warning: 1 tab pass over a component");
  });

  it("warns on a real carrier whose only tab out passes over a pad", () => {
    // The model's count and the view's sentence, joined: a run ringed by pads a tape apart has no way to a
    // wall that misses one, so its tab is the fallback over a part.
    const fold = JSON.parse(readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url), "utf8"));
    const keepOff = Array.from({ length: 40 }, (_, k) => ({
      x: 7 + 0.6 * Math.cos((k / 40) * 2 * Math.PI), y: 7 + 0.6 * Math.sin((k / 40) * 2 * Math.PI),
    }));
    const req: ExportRequest = {
      design: defaultElectronicsDesign, fold, tapeW: 0.1, side: "front", mirror: { x: false, y: false },
      traces: [{ net: "pwr", pts: [{ x: 6.9, y: 7 }, { x: 7.1, y: 7 }] }] as ExportRequest["traces"],
    };
    expect(carrierExport(req).message).not.toContain("component");
    expect(carrierExport({ ...req, keepOff }).message).toContain("warning: 1 tab pass over a component");
  });

  it("says nothing about components when no tab passes over one", () => {
    expect(carrierExport(request({})).message).not.toContain("component");
  });
});
