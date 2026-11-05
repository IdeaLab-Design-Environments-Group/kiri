import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportModal } from "../../../src/view/export-modal.js";
import { installDom, MockElement } from "./mock-dom.js";

describe("view/export-modal", () => {
  const createObjectURL = vi.fn(() => "blob:mock");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    (globalThis as any).URL = { createObjectURL, revokeObjectURL };
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
    delete (globalThis as any).URL;
  });

  it("mounts the trigger, toggles enabled state, and shows empty status when no payload exists", () => {
    const { document } = installDom();
    const modal = new ExportModal();
    const host = document.createElement("div");
    modal.mountTrigger(host as unknown as HTMLElement);
    modal.setEnabled(true);
    modal.setProvider(() => null);
    modal.open();

    expect(host.children[0]?.textContent).toBe("Export");
    expect(host.children[0]?.disabled).toBe(false);

    const overlay = document.body.children[0]!;
    expect(overlay.hidden).toBe(false);
    expect(overlay.querySelector(".sim-status")?.textContent).toContain("No pattern to export");
    expect(overlay.querySelector(".export-zip-btn")?.disabled).toBe(true);
    expect(overlay.querySelector(".export-combined-btn")).toBeNull();
  });

  it("renders previews and enables downloads when a payload exists", () => {
    const { document } = installDom();
    const modal = new ExportModal();
    modal.setProvider(() => ({
      previews: { cut: "<svg>cut</svg>", score: "<svg>score</svg>", both: "<svg>both</svg>" },
      files: [],
      archive: { filename: "cut.zip", bytes: new Uint8Array([1, 2, 3]) },
      combined: { filename: "all.svg", svg: "<svg />" },
    }));

    modal.open();
    const overlay = document.body.children[0]!;
    expect(overlay.querySelector('[data-k="cut"]')?.innerHTML).toBe("<svg>cut</svg>");
    expect(overlay.querySelector('[data-k="score"]')?.innerHTML).toBe("<svg>score</svg>");
    expect(overlay.querySelector('[data-k="both"]')?.innerHTML).toBe("<svg>both</svg>");
    expect(overlay.querySelector(".export-zip-btn")?.disabled).toBe(false);
    expect(overlay.querySelector(".export-combined-btn")).toBeNull(); // the zip carries the combined SVG
  });

  it("offers no STL detail box, since the printed tiles are never subdivided", () => {
    const { document } = installDom();
    new ExportModal();
    expect(document.body.children[0]!.querySelector(".export-stl-detail")).toBeFalsy();
  });

  it("downloads the zip using object URLs, and closes via button or Escape", () => {
    const { document } = installDom();
    const modal = new ExportModal();
    modal.setProvider(() => ({
      previews: { cut: "", score: "", both: "" },
      files: [],
      archive: { filename: "cut.zip", bytes: new Uint8Array([1, 2]) },
      combined: { filename: "all.svg", svg: "<svg />" },
    }));

    modal.open();
    const overlay = document.body.children[0]!;
    const zip = overlay.querySelector(".export-zip-btn")!;
    zip.click();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);

    overlay.querySelector(".sim-modal-close")?.click();
    expect(overlay.hidden).toBe(true);

    modal.open();
    document.dispatch("keydown", { key: "Escape" });
    expect(overlay.hidden).toBe(true);
  });

  it("names the two downloads for what you get, and draws them as the main actions", () => {
    const { document } = installDom();
    new ExportModal();
    const overlay = document.body.children[0]!;
    const stl = overlay.querySelector(".export-stl-btn")!;
    const zip = overlay.querySelector(".export-zip-btn")!;
    expect(stl.textContent).toBe("Download 3D tiles (.stl)");
    expect(zip.textContent).toBe("Download cut files (.zip)");
    // The blue primary look, not a small outlined button under a paragraph.
    expect(stl.className).toContain("export-trigger");
    expect(zip.className).toContain("export-trigger");
  });

  it("explains the zip in plain words, with no 'registered' and no 'layer ops'", () => {
    const { document } = installDom();
    const modal = new ExportModal();
    modal.setProvider(() => ({
      previews: { cut: "", score: "", both: "" },
      files: [],
      archive: { filename: "cut.zip", bytes: new Uint8Array([1]) },
      combined: { filename: "all.svg", svg: "<svg />" },
    }));
    modal.open();
    const text = document.body.children[0]!.querySelector(".sim-status")!.textContent;
    expect(text).toContain("Black is cut, blue is score");
    expect(text).toContain("three SVG files at true size (mm)");
    expect(text).not.toMatch(/registered|layer ops/);
  });

  describe("a tile size or thickness that cannot be used", () => {
    function open() {
      const { document } = installDom();
      const modal = new ExportModal();
      const calls: Array<[number | null, number | null | undefined, number | null | undefined]> = [];
      modal.setStlProvider(((h: number | null, d: number | null | undefined, s: number | null | undefined) => {
        calls.push([h, d, s]);
        return { filename: "t.stl", text: "solid", height: 1.6, unit: "mm" } as never;
      }) as never);
      modal.setProvider(() => null);
      modal.open();
      const overlay = document.body.children[0]!;
      return {
        modal,
        calls,
        overlay,
        height: overlay.querySelector(".export-stl-height")!,
        size: overlay.querySelector(".export-stl-size")!,
        status: () => overlay.querySelector(".sim-status")!.textContent,
        press: () => overlay.querySelector(".export-stl-btn")!.click(),
      };
    }

    it("says so, and puts the value that was used back in the box, instead of ignoring a 0 in silence", () => {
      const t = open();
      t.calls.length = 0;
      t.height.value = "0";
      t.press();
      expect(t.status()).toContain("Tile thickness must be more than 0, so 1.6 mm was used.");
      expect(t.height.value).toBe("1.6");
      expect(t.calls).toHaveLength(1); // still downloads, with the default
      expect(t.calls[0]![0]).toBeNull();
    });

    it("does the same for a longest side that is empty or not a number", () => {
      const t = open();
      t.size.value = "abc";
      t.press();
      expect(t.status()).toContain("Longest side must be more than 0, so 130 mm was used.");
      expect(t.size.value).toBe("130");
    });

    it("keeps saying it after the previews are redrawn, which rewrites the status line", () => {
      // The size box refreshes the previews when it changes. The sentence was put straight on the status line,
      // so it was overwritten a moment later, before anyone could read it.
      vi.useFakeTimers();
      try {
        const t = open();
        t.height.value = "0";
        t.press();
        t.modal.refreshPreviews();
        vi.runAllTimers();
        expect(t.status()).toContain("Tile thickness must be more than 0, so 1.6 mm was used.");
      } finally {
        vi.useRealTimers();
      }
    });

    it("goes when a box is edited, and when the dialog is opened again", () => {
      const t = open();
      t.height.value = "0";
      t.press();
      expect(t.status()).toContain("must be more than 0");
      t.height.dispatch("input");
      expect(t.status()).not.toContain("must be more than 0");

      t.size.value = "0";
      t.press();
      expect(t.status()).toContain("Longest side must be more than 0");
      t.modal.open();
      expect(t.status()).not.toContain("must be more than 0");
    });

    it("says nothing about values that are fine", () => {
      const t = open();
      const before = t.status();
      t.height.value = "2.5";
      t.size.value = "90";
      t.calls.length = 0;
      t.press();
      expect(t.status()).toBe(before);
      expect(t.calls[0]![0]).toBe(2.5);
      expect(t.calls[0]![2]).toBe(90);
    });
  });

  it("refreshPreviews re-runs the provider after a debounce, only while open", () => {
    vi.useFakeTimers();
    try {
      const { document } = installDom();
      const modal = new ExportModal();
      let n = 0;
      modal.setProvider(() => {
        n++;
        return {
          previews: { cut: `<svg>${n}</svg>`, score: "", both: "" },
          files: [],
          archive: { filename: "cut.zip", bytes: new Uint8Array([1]) },
          combined: { filename: "all.svg", svg: "<svg />" },
        };
      });
      modal.refreshPreviews();
      vi.advanceTimersByTime(300);
      expect(n).toBe(0); // closed: nothing planned

      modal.open();
      const overlay = document.body.children[0]!;
      expect(overlay.querySelector('[data-k="cut"]')?.innerHTML).toBe("<svg>1</svg>");
      modal.refreshPreviews();
      modal.refreshPreviews();
      modal.refreshPreviews();
      vi.advanceTimersByTime(100);
      expect(n).toBe(1); // still waiting
      vi.advanceTimersByTime(200);
      expect(n).toBe(2); // one planning run for the burst
      expect(overlay.querySelector('[data-k="cut"]')?.innerHTML).toBe("<svg>2</svg>");
    } finally {
      vi.useRealTimers();
    }
  });
});
