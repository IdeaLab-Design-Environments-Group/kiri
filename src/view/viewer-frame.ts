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

  constructor() {
    this.element = el("section", "column viewer-column");
    this.iframe = el("iframe", "viewer-frame") as HTMLIFrameElement;
    this.iframe.src = "./viewer/index.html";
    this.iframe.title = "FKLD viewer";
    this.element.append(this.iframe);

    window.addEventListener("message", (e: MessageEvent) => {
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
        this.loadedHandler(msg.fkld as FoldFile, (msg.name as string) ?? "viewer-model");
      }
    });
  }

  /** Register a callback fired whenever the viewer's displayed model changes (any load path). */
  onLoaded(handler: (object: FoldFile, name: string) => void): void {
    this.loadedHandler = handler;
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
    this.iframe.contentWindow?.postMessage(payload, "*");
  }
}
