import { afterEach, describe, expect, it } from "vitest";
import { HeaderActions } from "../../../src/view/header-actions.js";
import { installDom } from "./mock-dom.js";

describe("view/header-actions", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("is two groups of navigation, workflow first and the library after it", () => {
    installDom();
    const header = new HeaderActions();

    const groups = Array.from(header.element.children) as any[];
    expect(groups).toEqual([header.workflow, header.library]);
    expect(groups.map((g) => g.tagName)).toEqual(["nav", "nav"]);
    // Named, so a screen reader can tell the two navigation regions apart.
    expect(header.workflow.getAttribute("aria-label")).toBe("Workflow");
    expect(header.library.getAttribute("aria-label")).toBe("Examples and help");
  });

  it("starts empty: the triggers are mounted by the pages and dialogs that own them", () => {
    installDom();
    const header = new HeaderActions();
    expect(header.workflow.children).toHaveLength(0);
    expect(header.library.children).toHaveLength(0);
  });

  it("holds no model action: Cut & fold lives in the Model column, beside the file", () => {
    installDom();
    const header = new HeaderActions() as unknown as Record<string, unknown>;
    expect(header.onKirigamize).toBeUndefined();
    expect(header.setKirigamizeEnabled).toBeUndefined();
    expect(header.appendActionButtons).toBeUndefined();
  });
});
