import { describe, expect, it } from "vitest";
import { routeHintShown, syncRouteHint } from "../../../src/view/electronics-presenters.js";

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
});
