import { afterEach, describe, expect, it, vi } from "vitest";
import { HeaderActions } from "../../../src/view/header-actions.js";
import { installDom } from "./mock-dom.js";

describe("view/header-actions", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("appends the action buttons in order", () => {
    installDom();
    const header = new HeaderActions();
    header.appendActionButtons();

    const children = Array.from(header.element.children) as any[];
    // [Create pyramid] [Kirigamize ▶] -- "Load sample" moved into the viewer's own toolbar, where the
    // one-entry Example dropdown that loaded the same file used to be.
    expect(children.map((c) => c.tagName)).toEqual(["button", "button"]);
    expect(children.map((c) => c.textContent)).toEqual(["Create pyramid", "Kirigamize ▶"]);
  });

  it("fires registered handlers and toggles disabled state", () => {
    installDom();
    const header = new HeaderActions();
    header.appendActionButtons();
    const onCreate = vi.fn();
    const onKirigamize = vi.fn();
    header.onCreatePyramid(onCreate);
    header.onKirigamize(onKirigamize);

    const children = Array.from(header.element.children) as HTMLButtonElement[];
    children[0]?.click(); // Create pyramid
    header.setKirigamizeEnabled(true);
    children[1]?.click(); // Kirigamize ▶

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onKirigamize).toHaveBeenCalledTimes(1);
    expect(children[1]?.disabled).toBe(false);
  });
});
