/**
 * **Worker** — plans the folded copper off the page. Receives a {@link FoldedOverlayJob}, posts back a
 * {@link FoldedOverlayReply}. Started by `folded-overlay-worker.ts`.
 */
import { runFoldedOverlayJob, type FoldedOverlayJob, type FoldedOverlayReply } from "./electronics-service.js";

/** The worker global, narrowed to what this uses (the project compiles against the DOM lib). */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<FoldedOverlayJob>) => void) | null;
  postMessage(reply: FoldedOverlayReply): void;
};

scope.onmessage = (e) => scope.postMessage(runFoldedOverlayJob(e.data));
