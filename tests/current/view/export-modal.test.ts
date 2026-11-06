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

  describe("3D preview of the tiles", () => {
    /** A preview viewer that records what it was asked to draw, standing in for the WebGL one. */
    function fakeViewer() {
      const shown: string[] = [];
      const mounts: MockElement[] = [];
      let disposed = 0;
      let release: () => void = () => {};
      let gate: Promise<void> | null = null;
      const factory = (mount: HTMLElement) => {
        mounts.push(mount as unknown as MockElement);
        return { show: (text: string) => { shown.push(text); }, dispose: () => { disposed++; } };
      };
      return {
        shown,
        mounts,
        disposed: () => disposed,
        /** Hold the viewer's chunk back until `release` is called. */
        hold() { gate = new Promise<void>((r) => { release = r; }); },
        release: () => release(),
        loader: async () => { if (gate) await gate; return factory; },
      };
    }

    function setup(opts: { collapsed?: boolean; hold?: boolean } = {}) {
      vi.useFakeTimers();
      const { document } = installDom();
      const modal = new ExportModal();
      const viewer = fakeViewer();
      if (opts.hold) viewer.hold();
      const calls: Array<[number | null, number | null, number | null]> = [];
      modal.setStlProvider((h, d, s) => {
        calls.push([h, d, s]);
        return { filename: "t.stl", text: `solid h=${h ?? "default"} s=${s}`, height: 1.6, unit: "mm", maxSubdiv: 0 };
      });
      modal.setProvider(() => null);
      modal.setTilePreview(viewer.loader);
      const overlay = document.body.children[0]!;
      const section = overlay.querySelector(".export-tiles-preview")! as MockElement & { open: boolean };
      if (opts.collapsed) section.open = false;
      const type = (box: MockElement, value: string) => { box.value = value; box.dispatch("input"); };
      return {
        modal, viewer, calls, overlay, section, type,
        height: overlay.querySelector(".export-stl-height")!,
        size: overlay.querySelector(".export-stl-size")!,
        toggle(open: boolean) { section.open = open; section.dispatch("toggle"); },
      };
    }

    afterEach(() => { vi.useRealTimers(); });

    it("draws the tiles when the dialog opens, from the build that prefills the boxes", async () => {
      const t = setup();
      t.modal.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.section.open).toBe(true);
      expect(t.viewer.mounts).toEqual([t.overlay.querySelector(".export-tiles-view")]);
      expect(t.viewer.shown).toEqual(["solid h=default s=130"]);
      expect(t.calls).toHaveLength(1); // no second STL build just for the picture
    });

    it("rebuilds once, after the debounce, when the thickness or longest side change", async () => {
      const t = setup();
      t.modal.open();
      await vi.advanceTimersByTimeAsync(0);
      t.type(t.height, "2.5");
      t.type(t.size, "90");
      t.type(t.height, "3");
      await vi.advanceTimersByTimeAsync(100);
      expect(t.calls).toHaveLength(1); // still typing: nothing built yet
      await vi.advanceTimersByTimeAsync(400);
      expect(t.calls).toHaveLength(2);
      expect(t.calls[1]).toEqual([3, null, 90]);
      expect(t.viewer.shown.at(-1)).toBe("solid h=3 s=90");
      expect(t.viewer.mounts).toHaveLength(1); // the same viewer is redrawn, not a new one per edit
    });

    it("keeps an empty or zero box on the builder's default while previewing, without a notice", async () => {
      const t = setup();
      t.modal.open();
      await vi.advanceTimersByTimeAsync(0);
      const status = t.overlay.querySelector(".sim-status")!.textContent;
      t.type(t.height, "0");
      await vi.advanceTimersByTimeAsync(500);
      expect(t.calls.at(-1)).toEqual([null, null, 130]);
      expect(t.height.value).toBe("0"); // the box is only corrected on download, not mid-typing
      expect(t.overlay.querySelector(".sim-status")!.textContent).toBe(status);
    });

    it("builds nothing while the section is collapsed, and builds when it is opened", async () => {
      const t = setup({ collapsed: true });
      t.modal.open();
      await vi.advanceTimersByTimeAsync(500);
      expect(t.viewer.mounts).toHaveLength(0);
      t.type(t.height, "2");
      await vi.advanceTimersByTimeAsync(500);
      expect(t.calls).toHaveLength(1); // only the probe that prefills the boxes

      t.toggle(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(t.calls).toHaveLength(2);
      expect(t.viewer.shown).toEqual(["solid h=2 s=130"]);

      t.toggle(false);
      expect(t.viewer.disposed()).toBe(1);
      t.type(t.height, "4");
      await vi.advanceTimersByTimeAsync(500);
      expect(t.calls).toHaveLength(2);
    });

    it("drops a pending rebuild and frees the viewer when the dialog closes", async () => {
      const t = setup();
      t.modal.open();
      await vi.advanceTimersByTimeAsync(0);
      t.type(t.height, "2");
      t.modal.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(t.calls).toHaveLength(1);
      expect(t.viewer.disposed()).toBe(1);
      expect(t.viewer.shown).toEqual(["solid h=default s=130"]);
    });

    it("never makes a viewer whose chunk arrives after the dialog closed", async () => {
      const t = setup({ hold: true });
      t.modal.open();
      t.modal.close();
      t.viewer.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.viewer.mounts).toHaveLength(0);
      expect(t.viewer.shown).toHaveLength(0);
    });

    it("draws only the newest build when one lands while the viewer is still loading", async () => {
      const t = setup({ hold: true });
      t.modal.open();
      t.type(t.height, "2.2");
      await vi.advanceTimersByTimeAsync(500);
      expect(t.calls).toHaveLength(2);
      t.viewer.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.viewer.shown).toEqual(["solid h=2.2 s=130"]);
    });

    it("makes a fresh viewer each time the dialog is opened again", async () => {
      const t = setup();
      t.modal.open();
      await vi.advanceTimersByTimeAsync(0);
      t.modal.close();
      t.modal.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.viewer.mounts).toHaveLength(2);
      expect(t.viewer.disposed()).toBe(1);
    });

    it("says so in the section when the viewer cannot start", async () => {
      const t = setup();
      t.modal.setTilePreview(async () => () => { throw new Error("no WebGL"); });
      t.modal.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.overlay.querySelector(".export-tiles-view")!.textContent).toContain("no WebGL");
    });

    it("shows no viewer for a pattern with no tiles", async () => {
      const t = setup();
      t.modal.setStlProvider(() => null);
      t.modal.open();
      await vi.advanceTimersByTimeAsync(500);
      expect(t.viewer.mounts).toHaveLength(0);
      expect(t.section.hidden).toBe(true);
    });
  });
});
