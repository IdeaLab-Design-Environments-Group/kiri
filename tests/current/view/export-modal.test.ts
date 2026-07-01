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
    expect(overlay.querySelector(".export-combined-btn")?.disabled).toBe(true);
  });

  it("renders previews and enables downloads when a payload exists", () => {
    const { document } = installDom();
    const modal = new ExportModal();
    modal.setProvider(() => ({
      previews: { cut: "<svg>cut</svg>", score: "<svg>score</svg>", both: "<svg>both</svg>" },
      archive: { filename: "cut.zip", bytes: new Uint8Array([1, 2, 3]) },
      combined: { filename: "all.svg", svg: "<svg />" },
    }));

    modal.open();
    const overlay = document.body.children[0]!;
    expect(overlay.querySelector('[data-k="cut"]')?.innerHTML).toBe("<svg>cut</svg>");
    expect(overlay.querySelector('[data-k="score"]')?.innerHTML).toBe("<svg>score</svg>");
    expect(overlay.querySelector('[data-k="both"]')?.innerHTML).toBe("<svg>both</svg>");
    expect(overlay.querySelector(".export-zip-btn")?.disabled).toBe(false);
    expect(overlay.querySelector(".export-combined-btn")?.disabled).toBe(false);
  });

  it("downloads zip and combined svg using object URLs, and closes via button or Escape", () => {
    const { document } = installDom();
    const modal = new ExportModal();
    modal.setProvider(() => ({
      previews: { cut: "", score: "", both: "" },
      archive: { filename: "cut.zip", bytes: new Uint8Array([1, 2]) },
      combined: { filename: "all.svg", svg: "<svg />" },
    }));

    modal.open();
    const overlay = document.body.children[0]!;
    const zip = overlay.querySelector(".export-zip-btn")!;
    const combined = overlay.querySelector(".export-combined-btn")!;
    zip.click();
    combined.click();

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);

    overlay.querySelector(".sim-modal-close")?.click();
    expect(overlay.hidden).toBe(true);

    modal.open();
    document.dispatch("keydown", { key: "Escape" });
    expect(overlay.hidden).toBe(true);
  });
});
