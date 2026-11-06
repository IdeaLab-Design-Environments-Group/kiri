import { afterEach, describe, expect, it, vi } from "vitest";
import { PatternEditorModal } from "../../../src/view/pattern-editor-modal.js";
import { installDom } from "./mock-dom.js";

/**
 * The pattern editor dialog's keyboard handling, as tried in a browser for issue #64: it has no button of
 * its own in the header, so it is opened from wherever focus happens to be, and its number boxes take
 * digits that are also its brush shortcuts.
 */

function open(): { pe: any; document: any; opener: any } {
  const { document } = installDom() as any;
  document.createElementNS = (_ns: string, tag: string) => document.createElement(tag);
  const opener = document.createElement("button");
  opener.isConnected = true;
  opener.focus = vi.fn();
  document.activeElement = opener;
  const pe = new PatternEditorModal() as any;
  pe.open();
  return { pe, document, opener };
}

function activeBrush(pe: any): string {
  return [...pe.toolButtons.entries()].find(([, b]: any) => b.classList.contains("is-active"))![0];
}

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
});

describe("view/pattern-editor-modal", () => {
  it("gives focus back to whatever had it when the dialog opened, since it has no trigger on the page", () => {
    const { pe, opener } = open();
    pe.close();
    expect(opener.focus).toHaveBeenCalled();
  });

  it("does not switch brush when a digit is typed into one of its number boxes", () => {
    const { pe, document } = open();
    expect(activeBrush(pe)).toBe("M");
    document.dispatch("keydown", { key: "1", target: pe.colsInput });
    document.dispatch("keydown", { key: "0", target: pe.colsInput });
    expect(activeBrush(pe), "typing 10 into cols picked the eraser").toBe("M");
    // Outside a box the digits are still the brush shortcuts.
    document.dispatch("keydown", { key: "0", target: document.body });
    expect(activeBrush(pe)).toBe("E");
  });
});
