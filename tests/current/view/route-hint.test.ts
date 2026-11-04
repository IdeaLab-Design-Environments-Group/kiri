import { describe, expect, it } from "vitest";
import { routeHintShown, syncRouteHint, syncWireDelete, syncWireWidth } from "../../../src/view/electronics-presenters.js";

describe("route hint", () => {
  it("shows only with LEDs and a stale plan", () => {
    expect(routeHintShown(1, true)).toBe(true);
    expect(routeHintShown(0, true)).toBe(false);
    expect(routeHintShown(2, false)).toBe(false);
  });

  it("toggles the button class and the strip", () => {
    const strip = { hidden: true };
    const classes = new Set<string>();
    const btn = {
      classList: {
        toggle: (n: string, f?: boolean) => (f ? classes.add(n) : classes.delete(n)),
      },
      closest: () => ({ querySelector: () => strip }),
    };
    syncRouteHint(btn, 1, true);
    expect(strip.hidden).toBe(false);
    expect(classes.has("is-stale")).toBe(true);
    syncRouteHint(btn, 1, false);
    expect(strip.hidden).toBe(true);
    expect(classes.has("is-stale")).toBe(false);
    expect(() => syncRouteHint(undefined, 1, true)).not.toThrow();
  });

  it("marks the editor body while the plan is stale, so the stylesheet can dim the old copper", () => {
    const bodyClasses = new Set<string>();
    const body = {
      querySelector: () => ({ hidden: true }),
      classList: { toggle: (n: string, f?: boolean) => (f ? bodyClasses.add(n) : bodyClasses.delete(n)) },
    };
    const btn = { classList: { toggle: () => undefined }, closest: () => body };
    syncRouteHint(btn, 1, true);
    expect(bodyClasses.has("is-route-stale")).toBe(true);
    syncRouteHint(btn, 1, false);
    expect(bodyClasses.has("is-route-stale")).toBe(false);
  });

  it("shows the selected wire's width, or empty with the plan's tape as the hint", () => {
    const box = { value: "stale", placeholder: "", ownerDocument: { activeElement: null as unknown } };
    const group = { querySelector: () => box };
    syncWireWidth(group as unknown as Element, 2.25, 1.5);
    expect(box.value).toBe("2.25");
    expect(box.placeholder).toBe("auto (1.5)");
    syncWireDelete({ hidden: true } as unknown as Element, "w1");
    syncWireWidth(group as unknown as Element, null, 1.5);
    expect(box.value).toBe("");
    expect(() => syncWireWidth(null, 1, 1.5)).not.toThrow();
  });

  it("leaves the width box alone while it has focus", () => {
    const box: { value: string; placeholder: string; ownerDocument: { activeElement: unknown } } = {
      value: "3.", placeholder: "", ownerDocument: { activeElement: null },
    };
    box.ownerDocument.activeElement = box;
    syncWireWidth({ querySelector: () => box } as unknown as Element, 3, 1.5);
    expect(box.value).toBe("3."); // not rewritten under the cursor
    expect(box.placeholder).toBe("auto (1.5)"); // the hint still follows the plan
  });

  it("shows the delete-wire group only while a wire is selected", () => {
    const group = { hidden: true };
    syncWireDelete(group as unknown as Element, "w1");
    expect(group.hidden).toBe(false);
    syncWireDelete(group as unknown as Element, null);
    expect(group.hidden).toBe(true);
    expect(() => syncWireDelete(null, "w1")).not.toThrow();
  });
});
