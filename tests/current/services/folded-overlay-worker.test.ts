import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  backgroundOverlayPlanner,
  createWorkerOverlayPlanner,
  type OverlayWorker,
} from "../../../src/services/folded-overlay-worker.js";
import {
  resolveFoldedCopperOverlay,
  runFoldedOverlayJob,
  type FoldedOverlayInput,
  type FoldedOverlayJob,
  type FoldedOverlayReply,
} from "../../../src/services/electronics-service.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { flatFaces, gapGraph, ledOf, type Circuit } from "../../../src/model/electronics.js";
import { TILE_INSET_FRAC } from "../../../src/model/tile-subdiv.js";

/**
 * Stands in for the Web Worker. What crosses `postMessage` is put through `structuredClone`, both ways, as
 * the browser does: a function in the job throws, and a class instance in the reply loses its prototype,
 * which `toStrictEqual` then catches. `reply()` runs the job the way the worker module does.
 */
class FakeWorker implements OverlayWorker {
  onmessage: ((e: { data: FoldedOverlayReply }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  posted: FoldedOverlayJob[] = [];
  terminated = false;

  postMessage(job: FoldedOverlayJob): void {
    this.posted.push(structuredClone(job));
  }

  reply(): void {
    this.onmessage?.({ data: structuredClone(runFoldedOverlayJob(this.posted.at(-1)!)) });
  }

  terminate(): void {
    this.terminated = true;
  }
}

function harness() {
  const spawned: FakeWorker[] = [];
  const plan = createWorkerOverlayPlanner(() => {
    const w = new FakeWorker();
    spawned.push(w);
    return w;
  });
  return { plan, spawned };
}

const house = (): FoldFile =>
  JSON.parse(readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"));

function input(fold: FoldFile, circuit: Circuit, extra: Partial<FoldedOverlayInput> = {}): FoldedOverlayInput {
  return {
    fold,
    circuit,
    tileGap: TILE_INSET_FRAC,
    sheetMm: 200,
    // Callbacks ride on the input; none of them may reach the worker, where they would not clone.
    onWarning: () => {},
    onDeferred: () => {},
    onBusy: () => {},
    onPlanned: () => {},
    force: true,
    ...extra,
  };
}

describe("services/folded-overlay-worker", () => {
  it("plans across a structured clone and returns the copper the page would have planned", async () => {
    const { plan, spawned } = harness();
    const fold = house();
    const gaps = gapGraph(fold, flatFaces(fold)).gaps;
    const job = input(fold, { leds: [ledOf(gaps[0]!.faceA, gaps[0]!.faceB)], battery: { face: 0 } });

    const pending = plan(job);
    spawned[0]!.reply();
    const traces = await pending;

    expect(traces.length).toBeGreaterThan(0);
    expect(traces).toStrictEqual(resolveFoldedCopperOverlay(job));
  });

  it("passes a failed plan's warning back to the page", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { plan, spawned } = harness();
    const onWarning = vi.fn();
    const broken = { leds: [{ face: 0 }], battery: { face: 0 }, wires: 5 } as never;

    const pending = plan(input(house(), broken, { onWarning }));
    spawned[0]!.reply();
    expect(await pending).toEqual([]);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]![0]).toContain("Copper could not be placed");
    errSpy.mockRestore();
  });

  it("stops the worker on a job that was overtaken, and keeps a worker that finished", async () => {
    const { plan, spawned } = harness();
    const fold = house();
    const first = plan(input(fold, { leds: [], battery: { face: 0 } }));
    const second = plan(input(fold, { leds: [], battery: { face: 1 } }));

    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.terminated).toBe(true); // a 28 s plan nobody wants must not hold up the next one
    await expect(first).rejects.toThrow(/superseded/);

    spawned[1]!.reply();
    expect((await second).length).toBeGreaterThan(0);

    const third = plan(input(fold, { leds: [], battery: { face: 2 } }));
    expect(spawned).toHaveLength(2); // idle worker reused: no reload of the routing code
    spawned[1]!.reply();
    await third;
  });

  it("rejects when the worker fails, and starts a fresh one for the next job", async () => {
    const { plan, spawned } = harness();
    const fold = house();
    const pending = plan(input(fold, { leds: [], battery: { face: 0 } }));
    spawned[0]!.onerror!({ message: "worker script failed to load" });
    await expect(pending).rejects.toThrow("worker script failed to load");
    expect(spawned[0]!.terminated).toBe(true);

    plan(input(fold, { leds: [], battery: { face: 1 } }));
    expect(spawned).toHaveLength(2);
  });

  it("offers no background planner where there is no Worker", () => {
    expect(typeof Worker).toBe("undefined");
    expect(backgroundOverlayPlanner()).toBeNull();
  });
});
