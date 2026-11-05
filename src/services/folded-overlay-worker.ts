/**
 * **Service** — the page's side of planning the folded copper in a Web Worker (issue #21): a board of
 * 8+ LEDs takes seconds to route, and planned on the page that froze it.
 *
 * The worker itself is `folded-overlay.worker.ts`. One job is in flight at a time, because the memo in
 * `electronics-service.ts` only asks again once the inputs have changed, and then the running job's result
 * is unwanted: its worker is terminated rather than left to finish, so a stale 28 s plan does not hold up
 * the current one. An idle worker is kept for the next job, so the routing code is loaded once.
 */
import {
  foldedOverlayJob,
  type FoldedOverlayJob,
  type FoldedOverlayPlanner,
  type FoldedOverlayReply,
} from "./electronics-service.js";
import type { AnchoredMesh } from "../model/trace-anchor.js";

/** The part of a `Worker` this uses; a test hands in a fake. */
export interface OverlayWorker {
  postMessage(job: FoldedOverlayJob): void;
  terminate(): void;
  onmessage: ((e: { data: FoldedOverlayReply }) => void) | null;
  onerror: ((e: { message: string }) => void) | null;
}

/** A planner that runs each job on a worker from `spawn`. */
export function createWorkerOverlayPlanner(spawn: () => OverlayWorker): FoldedOverlayPlanner {
  let worker: OverlayWorker | null = null;
  let abandon: (() => void) | null = null;
  return (input) => {
    if (abandon) {
      abandon();
      worker?.terminate();
      worker = null;
    }
    const w = (worker ??= spawn());
    return new Promise<AnchoredMesh[]>((resolve, reject) => {
      const done = () => {
        abandon = null;
        w.onmessage = null;
        w.onerror = null;
      };
      abandon = () => {
        done();
        reject(new Error("superseded by a newer plan"));
      };
      w.onmessage = ({ data }) => {
        done();
        if (data.warning !== null) input.onWarning?.(data.warning);
        resolve(data.traces);
      };
      w.onerror = (e) => {
        done();
        w.terminate();
        if (worker === w) worker = null;
        reject(new Error(e.message || "the route planner stopped"));
      };
      w.postMessage(foldedOverlayJob(input));
    });
  };
}

/** The browser's background planner, or null where there is no `Worker` (Node, vitest): plan on the page. */
export function backgroundOverlayPlanner(): FoldedOverlayPlanner | null {
  if (typeof Worker === "undefined") return null;
  return createWorkerOverlayPlanner(
    () => new Worker(new URL("./folded-overlay.worker.ts", import.meta.url), { type: "module" }) as unknown as OverlayWorker,
  );
}
