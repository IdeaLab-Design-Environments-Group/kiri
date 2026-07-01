import { describe, expect, it, vi } from "vitest";
import { AppStore } from "../../../src/model/app-store.js";

describe("model/app-store", () => {
  it("starts with a null model and default status", () => {
    const store = new AppStore();
    expect(store.getState()).toEqual({
      model: null,
      status: { msg: "No model loaded.", kind: "" },
      viewerShown: null,
      simMaterial: "vinyl",
      simDetail: 0,
      simTileGap: 0.16,
    });
  });

  it("notifies subscribers immediately and on updates, then stops after unsubscribe", () => {
    const store = new AppStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    store.setStatus("Ready", "ok");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.lastCall?.[0].status).toEqual({ msg: "Ready", kind: "ok" });

    unsubscribe();
    store.setStatus("Later", "bad");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("merges partial updates without dropping untouched state", () => {
    const store = new AppStore();
    store.update({
      model: {
        kind: "mesh",
        name: "shape.obj",
        ext: "obj",
        text: "v 0 0 0",
      },
    });

    expect(store.model?.name).toBe("shape.obj");
    expect(store.getState().status.msg).toBe("No model loaded.");
  });
});
