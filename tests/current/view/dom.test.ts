import { afterEach, describe, expect, it } from "vitest";
import { el, heading, renderDefinitionList } from "../../../src/view/dom.js";
import { childrenByTag, installDom, MockElement } from "./mock-dom.js";

describe("view/dom", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("creates elements with an optional class name", () => {
    installDom();
    const node = el("section", "panel");
    expect(node.tagName).toBe("section");
    expect(node.className).toBe("panel");
  });

  it("creates headings with text content", () => {
    installDom();
    const node = heading("h2", "Example");
    expect(node.tagName).toBe("h2");
    expect(node.textContent).toBe("Example");
  });

  it("renders definition-list rows and clears prior contents", () => {
    installDom();
    const dl = new MockElement("dl") as unknown as HTMLDListElement;
    renderDefinitionList(dl, [
      ["A", "1"],
      ["B", "2"],
    ]);

    const tags = childrenByTag(dl as unknown as MockElement, "dt").map((node) => node.textContent);
    const values = childrenByTag(dl as unknown as MockElement, "dd").map((node) => node.textContent);
    expect(tags).toEqual(["A", "B"]);
    expect(values).toEqual(["1", "2"]);
    expect((dl as unknown as MockElement).innerHTML).toBe("");
  });
});
