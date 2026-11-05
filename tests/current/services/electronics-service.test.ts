import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DEFERRED_OVERLAY_LEDS, PLANNING_ROUTES, createElectronicsPlanning, memoizeFoldedOverlay, resolveElectronicsTarget, resolveFoldedCopperOverlay } from "../../../src/services/electronics-service.js";
import type { FoldFile, LoadedModel } from "../../../src/model/fold-file.js";
import { flatFaces, type Circuit } from "../../../src/model/electronics.js";
import { TILE_INSET_FRAC } from "../../../src/model/tile-subdiv.js";

function twoTri(): FoldFile {
  return {
    vertices_coords: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    faces_vertices: [
      [0, 1, 2],
      [0, 2, 3],
    ],
    edges_vertices: [
      [0, 1],
      [1, 2],
      [2, 0],
      [2, 3],
      [3, 0],
    ],
    edges_assignment: ["B", "B", "M", "B", "B"],
  };
}

describe("services/electronics-service", () => {
  it("prefers the shown viewer model over the loaded fold model", () => {
    const model: LoadedModel = { kind: "fold", name: "loaded.fold", object: { vertices_coords: [], faces_vertices: [] } };
    const shown = { object: twoTri(), name: "viewer.fkld" };
    expect(resolveElectronicsTarget(model, shown)?.object).toBe(shown.object);
  });

  it("falls back to the loaded fold model, and is null when nothing is shown", () => {
    const model: LoadedModel = { kind: "fold", name: "loaded.fold", object: twoTri() };
    expect(resolveElectronicsTarget(model, null)?.object).toBe(model.object);
    expect(resolveElectronicsTarget(null, null)).toBeNull();
  });

  it("puts a declared net's copper on the folded model when the circuit has only parts", () => {
    // No hinge LED, no battery, no hand wire: the netlist still routes the two pads together, and the
    // editor draws that copper, so the folded model has to carry it too.
    const fold = JSON.parse(
      readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"),
    ) as FoldFile;
    const faces = flatFaces(fold);
    const at = (f: number) => faces[f]!.centroid;
    const circuit: Circuit = {
      leds: [],
      battery: null,
      nets: [{ id: "a", name: "A" }],
      parts: [
        { component: "R_1206", x: at(0).x, y: at(0).y, free: true, rot: 0 },
        { component: "R_1206", x: at(1).x, y: at(1).y, free: true, rot: 0 },
      ],
      terminals: [{ part: 0, pad: "1", net: "a" }, { part: 1, pad: "1", net: "a" }],
    };
    const overlay = resolveFoldedCopperOverlay({ fold, circuit, tileGap: TILE_INSET_FRAC, sheetMm: 200 });
    expect(overlay.length).toBeGreaterThan(0);
  });

  it("warns instead of failing silently when the copper cannot be planned", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onWarning = vi.fn();
    const circuit = { leds: [{ face: 0 }], battery: { face: 0 }, wires: 5 } as never;
    const out = resolveFoldedCopperOverlay({ fold: twoTri(), circuit, tileGap: 0.16, sheetMm: 100, onWarning });
    expect(out).toEqual([]);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]![0]).toContain("Copper could not be placed");
    errSpy.mockRestore();
  });

  it("re-plans the overlay only when an input is replaced", () => {
    const plan = vi.fn((_input: unknown) => []);
    const overlay = memoizeFoldedOverlay(plan);
    const fold = twoTri();
    const circuit: Circuit = { leds: [], battery: { face: 0 } };
    const input = { fold, circuit, tileGap: 0.16, sheetMm: 100 };
    const first = overlay(input);
    expect(overlay({ ...input })).toBe(first); // a fresh input object holding the same things
    expect(plan).toHaveBeenCalledTimes(1);

    overlay({ ...input, circuit: { ...circuit } }); // an edit replaces the circuit
    overlay({ ...input, circuit: { ...circuit }, tileGap: 0.2 });
    overlay({ ...input, fold: twoTri() });
    overlay({ ...input, sheetMm: 200 });
    expect(plan).toHaveBeenCalledTimes(5);
  });

  it("repeats a remembered failure's warning on every reuse", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const plan = vi.fn(resolveFoldedCopperOverlay);
    const overlay = memoizeFoldedOverlay(plan);
    const input = { fold: twoTri(), circuit: { leds: [{ face: 0 }], battery: { face: 0 }, wires: 5 } as never, tileGap: 0.16, sheetMm: 100 };
    const first = vi.fn();
    const again = vi.fn();
    expect(overlay({ ...input, onWarning: first })).toEqual([]);
    expect(overlay({ ...input, onWarning: again })).toEqual([]);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(again).toHaveBeenCalledWith(first.mock.calls[0]![0]);
    errSpy.mockRestore();
  });

  it("leaves a board of many LEDs unplanned until forced, then keeps the forced plan", () => {
    const plan = vi.fn((_input: unknown) => [{ kind: "pwr" }] as never[]);
    const overlay = memoizeFoldedOverlay(plan);
    const circuit = { leds: Array.from({ length: DEFERRED_OVERLAY_LEDS }, () => ({ face: 0 })), battery: null } as never;
    const onDeferred = vi.fn();
    const input = { fold: twoTri(), circuit, tileGap: 0.16, sheetMm: 100, onDeferred };

    expect(overlay(input)).toEqual([]);
    expect(overlay(input)).toEqual([]); // still deferred: nothing was remembered
    expect(plan).not.toHaveBeenCalled();
    expect(onDeferred).toHaveBeenCalledTimes(2);
    expect(onDeferred.mock.calls[0]![0]).toMatch(new RegExp(`^${DEFERRED_OVERLAY_LEDS} LEDs: `));

    const forced = overlay({ ...input, force: true });
    expect(forced).not.toEqual([]);
    expect(overlay(input)).toBe(forced); // same inputs, unforced: the requested plan is reused
    expect(plan).toHaveBeenCalledTimes(1);
    expect(onDeferred).toHaveBeenCalledTimes(2);
  });

  it("plans a board just under the deferral count without being asked", () => {
    const plan = vi.fn((_input: unknown) => []);
    const circuit = { leds: Array.from({ length: DEFERRED_OVERLAY_LEDS - 1 }, () => ({ face: 0 })), battery: null } as never;
    memoizeFoldedOverlay(plan)({ fold: twoTri(), circuit, tileGap: 0.16, sheetMm: 100 });
    expect(plan).toHaveBeenCalledTimes(1);
  });
});

/** A promise and the hands that settle it, so a test decides when a background plan lands. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** Let settled promises run their handlers. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("services/electronics-service: plans that finish later", () => {
  const circuit = (face: number): Circuit => ({ leds: [], battery: { face } });

  it("says it is busy while a plan runs, and hands the plan over once it lands", async () => {
    const job = deferred<never[]>();
    const plan = vi.fn((_input: unknown) => job.promise);
    const overlay = memoizeFoldedOverlay(plan);
    const onBusy = vi.fn();
    const onPlanned = vi.fn();
    const input = { fold: twoTri(), circuit: circuit(0), tileGap: 0.16, sheetMm: 100, onBusy, onPlanned };

    expect(overlay(input)).toEqual([]);
    expect(overlay({ ...input })).toEqual([]); // asked again before it lands: still the one plan
    expect(plan).toHaveBeenCalledTimes(1);
    expect(onBusy).toHaveBeenCalledTimes(2);
    expect(onBusy.mock.calls[0]![0]).toBe(PLANNING_ROUTES);
    expect(onPlanned).not.toHaveBeenCalled();

    const traces = [{ kind: "pwr", tris: [] }] as never[];
    job.resolve(traces);
    await settle();
    expect(onPlanned).toHaveBeenCalledTimes(1);
    expect(overlay({ ...input })).toBe(traces);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("drops a plan whose circuit was replaced while it ran", async () => {
    const jobs = [deferred<never[]>(), deferred<never[]>()];
    let n = 0;
    const overlay = memoizeFoldedOverlay(() => jobs[n++]!.promise);
    const fold = twoTri();
    const onPlannedOld = vi.fn();
    const onPlannedNew = vi.fn();
    const old = { fold, circuit: circuit(0), tileGap: 0.16, sheetMm: 100, onPlanned: onPlannedOld };
    const current = { fold, circuit: circuit(1), tileGap: 0.16, sheetMm: 100, onPlanned: onPlannedNew };

    overlay(old);
    overlay(current);
    jobs[0]!.resolve([{ kind: "old", tris: [] }] as never[]);
    await settle();
    expect(onPlannedOld).not.toHaveBeenCalled();
    expect(overlay(current)).toEqual([]); // the old circuit's copper is not this one's

    const fresh = [{ kind: "new", tris: [] }] as never[];
    jobs[1]!.resolve(fresh);
    await settle();
    expect(onPlannedNew).toHaveBeenCalledTimes(1);
    expect(overlay(current)).toBe(fresh);
  });

  it("drops a running plan when the board it was for is now left until asked", async () => {
    const job = deferred<never[]>();
    const overlay = memoizeFoldedOverlay(() => job.promise);
    const onPlanned = vi.fn();
    const fold = twoTri();
    overlay({ fold, circuit: circuit(0), tileGap: 0.16, sheetMm: 100, onPlanned });
    const big = { leds: Array.from({ length: DEFERRED_OVERLAY_LEDS }, () => ({ face: 0 })), battery: null } as never;
    const onDeferred = vi.fn();
    expect(overlay({ fold, circuit: big, tileGap: 0.16, sheetMm: 100, onDeferred })).toEqual([]);
    expect(onDeferred).toHaveBeenCalledTimes(1);
    job.resolve([{ kind: "pwr", tris: [] }] as never[]);
    await settle();
    expect(onPlanned).not.toHaveBeenCalled();
  });

  it("turns a plan that failed elsewhere into the copper warning", async () => {
    const job = deferred<never[]>();
    const overlay = memoizeFoldedOverlay(() => job.promise);
    const input = { fold: twoTri(), circuit: circuit(0), tileGap: 0.16, sheetMm: 100 };
    overlay(input);
    job.reject(new Error("worker died"));
    await settle();
    const onWarning = vi.fn();
    expect(overlay({ ...input, onWarning })).toEqual([]);
    expect(onWarning).toHaveBeenCalledWith("Copper could not be placed on the folded model: worker died");
  });

  it("plans on the page when no background planner is given", () => {
    const fold = JSON.parse(
      readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"),
    ) as FoldFile;
    const traces = createElectronicsPlanning().foldedOverlay({ fold, circuit: { leds: [], battery: { face: 0 } }, tileGap: TILE_INSET_FRAC, sheetMm: 200 });
    expect(traces.length).toBeGreaterThan(0);
  });
});
