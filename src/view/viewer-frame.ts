/**
 * **View** — the central FKLD viewer column. Owns the preview `<iframe>` and
 * encapsulates the cross-frame handshake: it buffers a payload until the
 * embedded viewer posts `kirigamizer:viewer-ready`, then forwards it. Callers
 * just call `show(object, name)`; the readiness/queueing is hidden here.
 *
 * What's currently on screen is NOT stored here — it lives in the AppStore
 * (`state.viewerShown`), fed through `onLoaded`: fired eagerly by `show()`
 * (host push) and again by the viewer's `kirigamizer:viewer-loaded` echo,
 * which also covers models the viewer loads on its own (file picker, example
 * dropdown, drag-drop). The duplicate notification is idempotent by design.
 */
import type { FoldFile } from "../model/fold-file.js";
import { el } from "./dom.js";

interface LoadPayload {
  type: "kirigamizer:load";
  fkld: FoldFile;
  name: string;
}

export class ViewerFrame {
  readonly element: HTMLElement;
  private readonly iframe: HTMLIFrameElement;
  private ready = false;
  private pending: LoadPayload | null = null;
  private loadedHandler: (object: FoldFile, name: string) => void = () => {};
  private rotateHandler: (degrees: number) => void = () => {};
  private alignHandler: (edge: number, axis: "x" | "y") => void = () => {};
  /** The model last posted to the viewer. Its echo comes back as a copy, and is reported as this object, so
   *  the store sees the same model rather than a new one (which would drop the circuit). */
  private posted: FoldFile | null = null;

  constructor() {
    this.element = el("section", "column viewer-column");
    this.iframe = el("iframe", "viewer-frame") as HTMLIFrameElement;
    this.iframe.src = "./viewer/index.html";
    this.iframe.title = "FKLD viewer";
    this.element.append(this.iframe);

    window.addEventListener("message", (e: MessageEvent) => {
      // Accept only our own viewer iframe, served from the same origin.
      if (e.source !== this.iframe.contentWindow || e.origin !== window.location.origin) return;
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "kirigamizer:viewer-ready") {
        this.ready = true;
        if (this.pending) {
          this.post(this.pending);
          this.pending = null;
        }
      } else if (msg.type === "kirigamizer:viewer-loaded" && msg.fkld) {
        // The viewer loaded a model by ANY path (its own file picker, example
        // dropdown, drag-drop, or the echo of our show()). Report it upward so
        // the store's `viewerShown` tracks exactly what is on screen.
        const object = this.posted ?? (msg.fkld as FoldFile);
        this.posted = null;
        this.loadedHandler(object, (msg.name as string) ?? "viewer-model");
      } else if (msg.type === "kirigamizer:rotate" && Number.isFinite(msg.degrees)) {
        this.rotateHandler(msg.degrees as number);
      } else if (msg.type === "kirigamizer:align-edge" && Number.isInteger(msg.edge) && (msg.axis === "x" || msg.axis === "y")) {
        this.alignHandler(msg.edge as number, msg.axis);
      }
    });
  }

  /** Register a callback fired whenever the viewer's displayed model changes (any load path). */
  onLoaded(handler: (object: FoldFile, name: string) => void): void {
    this.loadedHandler = handler;
  }

  /** Register a callback for the viewer's request to turn the sheet by some degrees, anticlockwise. */
  onRotate(handler: (degrees: number) => void): void {
    this.rotateHandler = handler;
  }

  /** Register a callback for the viewer's request to turn the sheet so an edge lies along x or y. */
  onAlignEdge(handler: (edge: number, axis: "x" | "y") => void): void {
    this.alignHandler = handler;
  }

  /** Show a FOLD/FKLD object in the viewer (queued until the viewer is ready). */
  show(object: FoldFile, name: string): void {
    const payload: LoadPayload = { type: "kirigamizer:load", fkld: object, name };
    if (this.ready) this.post(payload);
    else this.pending = payload;
    // Eager notification: the viewer will display this next; its
    // `kirigamizer:viewer-loaded` echo re-confirms idempotently.
    this.loadedHandler(object, name);
  }

  private post(payload: LoadPayload): void {
    this.posted = payload.fkld;
    this.iframe.contentWindow?.postMessage(payload, window.location.origin);
  }
}
