import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvertPanel } from "../../../src/view/convert-panel.js";
import { childByClass, installDom, MockElement } from "./mock-dom.js";

describe("view/convert-panel", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("renders default status and derived-empty state", () => {
    installDom();
    const panel = new ConvertPanel();
    const status = childByClass(panel.element as unknown as MockElement, "status");
    const empty = childByClass(panel.element as unknown as MockElement, "fkld-meta-empty");

    expect(status?.textContent).toBe("No model loaded.");
    expect(empty?.textContent).toBe("Load a model to see its facts.");
    expect(empty?.hidden).toBe(false);
  });

  it("updates status styling and renders facts into the definition list", () => {
    installDom();
    const panel = new ConvertPanel();
    const status = childByClass(panel.element as unknown as MockElement, "status")!;
    const dl = childByClass(panel.element as unknown as MockElement, "derived-list")!;
    const empty = childByClass(panel.element as unknown as MockElement, "fkld-meta-empty")!;

    panel.setStatus("Ready", "ok");
    panel.renderFacts([
      ["File", "shape.fold"],
      ["Vertices", "3"],
    ]);

    expect(status.textContent).toBe("Ready");
    expect(status.className).toBe("status ok");
    expect(dl.children.map((node) => node.textContent)).toEqual(["File", "shape.fold", "Vertices", "3"]);
    expect(empty.hidden).toBe(true);
  });

  it("forwards chosen, changed, and dropped files to the registered handler", () => {
    installDom();
    const panel = new ConvertPanel();
    const handler = vi.fn();
    panel.onFileChosen(handler);

    const dropzone = childByClass(panel.element as unknown as MockElement, "dropzone")!;
    const fileInput = dropzone.children[0] as MockElement;
    const file = { name: "shape.fold" } as File;

    fileInput.files = [file];
    fileInput.dispatch("change");
    dropzone.dispatch("drop", { dataTransfer: { files: [file] }, preventDefault() {} });
    dropzone.dispatch("dragenter", { preventDefault() {} });
    dropzone.dispatch("dragleave", { preventDefault() {} });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, file);
    expect(handler).toHaveBeenNthCalledWith(2, file);
    expect(dropzone.classList.contains("dragover")).toBe(false);
  });
});
