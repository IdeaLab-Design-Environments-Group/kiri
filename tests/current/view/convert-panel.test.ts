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

    expect(status?.textContent).toBe("no model loaded.");
    expect(empty?.textContent).toBe("load a model to see its facts.");
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

  it("is headed Model, and offers Cut & fold under the status, off until told otherwise", () => {
    installDom();
    const panel = new ConvertPanel();
    const root = panel.element as unknown as MockElement;
    const btn = childByClass(root, "convert-cut")!;
    const hint = childByClass(root, "cut-hint")!;

    expect(btn.textContent).toBe("Cut & fold");
    expect(btn.disabled).toBe(true);
    expect(hint.textContent).toContain("Load a 3D model");
    expect(JSON.stringify(root.children.map((c: any) => c.children?.map((k: any) => k.textContent)))).toContain("Model");
  });

  it("enables Cut & fold, says what it does or why it is off, and reports a press", () => {
    installDom();
    const panel = new ConvertPanel();
    const root = panel.element as unknown as MockElement;
    const btn = childByClass(root, "convert-cut")!;
    const hint = childByClass(root, "cut-hint")!;
    const onCut = vi.fn();
    panel.onCutAndFold(onCut);

    panel.setCutAndFold({ enabled: true, hint: "Cuts the mesh into a flat pattern." });
    expect(btn.disabled).toBe(false);
    expect(hint.textContent).toBe("Cuts the mesh into a flat pattern.");
    expect(btn.title).toBe("Cuts the mesh into a flat pattern.");
    expect(btn.getAttribute("aria-busy")).toBe("false");
    btn.dispatch("click");
    expect(onCut).toHaveBeenCalledTimes(1);

    panel.setCutAndFold({ enabled: false, busy: true, hint: "Working…" });
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");

    panel.setCutAndFold({ enabled: false, hint: "This is already a pattern." });
    expect(btn.disabled).toBe(true);
    expect(hint.textContent).toBe("This is already a pattern.");
    expect(btn.getAttribute("aria-busy")).toBe("false");
  });

  it("keeps the derived facts in a collapsed File details section, not an always-open table", () => {
    installDom();
    const panel = new ConvertPanel();
    const root = panel.element as unknown as MockElement;
    const derived = childByClass(root, "derived")!;
    const summary = childByClass(root, "derived-summary")!;

    expect(derived.tagName).toBe("details");
    expect(summary.tagName).toBe("summary");
    expect(summary.textContent).toBe("File details");
    // Collapsed unless opened: no `open` attribute is set by default.
    expect(derived.getAttribute("open")).toBeFalsy();
    // The table is still inside it, one click away.
    expect(childByClass(derived, "derived-list")).toBeTruthy();
  });
});
