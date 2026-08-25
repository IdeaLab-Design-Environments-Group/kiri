import { afterEach, describe, expect, it } from "vitest";
import { HOME, currentRoute, goToRoute, onRouteChange } from "../../../src/view/route.js";

/** A stand-in for the browser's address bar: the one thing the module actually reads and writes. */
function installLocation(hash: string): { hash: string } {
  const loc = { hash };
  (globalThis as any).location = loc;
  return loc;
}

describe("view/route", () => {
  afterEach(() => {
    delete (globalThis as any).location;
    delete (globalThis as any).window;
  });

  it("reads the page name out of the hash", () => {
    installLocation("#/electronics");
    expect(currentRoute()).toBe("electronics");
  });

  it("reads the front page as the empty name, however the hash is written", () => {
    // A fresh load has no hash at all; clicking Back to the model leaves "#/" behind. Both are home, and
    // a route that told them apart would show the editor on one of them.
    for (const hash of ["", "#", "#/"]) {
      installLocation(hash);
      expect(currentRoute(), `"${hash}" is not the front page`).toBe(HOME);
    }
  });

  it("navigates by writing the hash, which is what gives Back something to return to", () => {
    const loc = installLocation("#/");
    goToRoute("electronics");
    expect(loc.hash).toBe("#/electronics");
    goToRoute(HOME);
    expect(loc.hash).toBe("#/");
  });

  it("does not rewrite the hash it is already on", () => {
    // Writing the same hash again is a no-op in a browser, but it would be a second history entry in any
    // implementation that did not check -- and then Back would appear not to work.
    const loc = installLocation("#/electronics");
    let writes = 0;
    Object.defineProperty(loc, "hash", {
      get: () => "#/electronics",
      set: () => { writes++; },
    });
    goToRoute("electronics");
    expect(writes).toBe(0);
  });

  it("passes the new page to its listeners when the browser changes the hash", () => {
    installLocation("#/");
    const seen: string[] = [];
    const listeners: (() => void)[] = [];
    (globalThis as any).window = { addEventListener: (_t: string, fn: () => void) => listeners.push(fn) };
    onRouteChange((r) => seen.push(r));

    (globalThis as any).location.hash = "#/electronics";
    for (const fn of listeners) fn(); // the browser firing `hashchange`
    expect(seen).toEqual(["electronics"]);
  });

  it("is inert where there is no URL at all, rather than throwing", () => {
    // Not hypothetical: this module is constructed in a test DOM, and under `file://` the app is built to
    // degrade rather than break. A route that threw here would take the whole editor down with it.
    delete (globalThis as any).location;
    delete (globalThis as any).window;
    expect(currentRoute()).toBe(HOME);
    expect(() => goToRoute("electronics")).not.toThrow();
    expect(() => onRouteChange(() => {})).not.toThrow();
  });
});
