import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerFrame } from "../../../src/view/viewer-frame.js";
import { installDom, MockElement } from "./mock-dom.js";

const ORIGIN = "http://localhost:4173";

/** Install the DOM stub with an origin and give the frame's iframe a contentWindow to match against. */
function setup() {
  const { window } = installDom();
  (window as any).location = { origin: ORIGIN };
  const frame = new ViewerFrame();
  const iframe = (frame.element as unknown as MockElement).children[0] as MockElement;
  const postMessage = vi.fn();
  iframe.contentWindow = { postMessage };
  const send = (data: unknown, over: { source?: unknown; origin?: string } = {}) =>
    window.dispatch("message", {
      data,
      source: "source" in over ? over.source : iframe.contentWindow,
      origin: over.origin ?? ORIGIN,
    });
  return { frame, iframe, postMessage, send };
}

describe("view/viewer-frame", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("queues show() until the viewer reports ready, then posts the payload", () => {
    const { frame, postMessage, send } = setup();

    frame.show({ vertices_coords: [[0, 0]] }, "sample.fkld");
    expect(postMessage).not.toHaveBeenCalled();

    send({ type: "kirigamizer:viewer-ready" });
    expect(postMessage).toHaveBeenCalledWith(
      { type: "kirigamizer:load", fkld: { vertices_coords: [[0, 0]] }, name: "sample.fkld" },
      ORIGIN,
    );
  });

  it("forwards viewer-loaded callbacks (state itself now lives in the AppStore)", () => {
    const { frame, send } = setup();
    const loaded = vi.fn();
    frame.onLoaded(loaded);

    send({ type: "kirigamizer:viewer-loaded", fkld: { vertices_coords: [[1, 2]] }, name: "from-viewer.fkld" });

    expect(loaded).toHaveBeenCalledWith({ vertices_coords: [[1, 2]] }, "from-viewer.fkld");
  });

  it("notifies onLoaded eagerly when the host pushes a model via show()", () => {
    const { frame } = setup();
    const loaded = vi.fn();
    frame.onLoaded(loaded);

    frame.show({ vertices_coords: [[3, 4]] }, "host-pushed.fkld");

    // Eager: the store's viewerShown must track the push even before the
    // viewer's kirigamizer:viewer-loaded echo arrives.
    expect(loaded).toHaveBeenCalledWith({ vertices_coords: [[3, 4]] }, "host-pushed.fkld");
  });

  it("ignores messages from another window or another origin", () => {
    const { frame, postMessage, send } = setup();
    const loaded = vi.fn();
    frame.onLoaded(loaded);
    const loadedMsg = { type: "kirigamizer:viewer-loaded", fkld: { vertices_coords: [[5, 6]] }, name: "x" };

    send(loadedMsg, { source: { postMessage: vi.fn() } });
    send(loadedMsg, { source: null });
    send(loadedMsg, { origin: "https://evil.example" });
    expect(loaded).not.toHaveBeenCalled();

    // A forged ready from outside must not flush the queued payload either.
    frame.show({ vertices_coords: [[0, 0]] }, "q.fkld");
    send({ type: "kirigamizer:viewer-ready" }, { origin: "https://evil.example" });
    send({ type: "kirigamizer:viewer-ready" }, { source: {} });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("reports the echo of a pushed model as the very object pushed, not the viewer's copy", () => {
    const { frame, send } = setup();
    send({ type: "kirigamizer:viewer-ready" });
    const seen: unknown[] = [];
    frame.onLoaded((o) => seen.push(o));
    const pushed = { vertices_coords: [[0, 0]] };
    frame.show(pushed, "a.fkld");
    send({ type: "kirigamizer:viewer-loaded", fkld: { vertices_coords: [[0, 0]] }, name: "a.fkld" });
    expect(seen[1]).toBe(pushed);
    // A model the viewer loads by itself afterwards is its own.
    const own = { vertices_coords: [[1, 1]] };
    send({ type: "kirigamizer:viewer-loaded", fkld: own, name: "b.fkld" });
    expect(seen[2]).toBe(own);
  });

  it("forwards rotate and align-edge requests, and drops malformed ones", () => {
    const { frame, send } = setup();
    const turns: number[] = [];
    const aligns: [number, string][] = [];
    frame.onRotate((d) => turns.push(d));
    frame.onAlignEdge((e, a) => aligns.push([e, a]));
    send({ type: "kirigamizer:rotate", degrees: -15 });
    send({ type: "kirigamizer:rotate", degrees: "15" });
    send({ type: "kirigamizer:rotate", degrees: Number.NaN });
    send({ type: "kirigamizer:align-edge", edge: 3, axis: "y" });
    send({ type: "kirigamizer:align-edge", edge: 1.5, axis: "x" });
    send({ type: "kirigamizer:align-edge", edge: 2, axis: "z" });
    send({ type: "kirigamizer:rotate", degrees: 90 }, { origin: "http://evil.example" });
    expect(turns).toEqual([-15]);
    expect(aligns).toEqual([[3, "y"]]);
  });
});
