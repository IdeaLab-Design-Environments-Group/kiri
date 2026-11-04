import { describe, expect, it } from "vitest";
import { carrierExport, type ExportRequest } from "../../../src/view/electronics-export.js";

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

  it("says nothing about components when no tab passes over one", () => {
    expect(carrierExport(request({})).message).not.toContain("component");
  });
});
