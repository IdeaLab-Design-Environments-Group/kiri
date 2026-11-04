import { afterEach, describe, expect, it } from "vitest";
import { applyHeaderCopy, HEADER_COPY } from "../../../src/view/header-copy.js";
import { installDom } from "./mock-dom.js";

describe("view/header-copy", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("gives every header button a sentence-case label and a tooltip", () => {
    installDom();
    const header = document.createElement("div");
    for (const raw of ["electronics", "Simulate", "cut&fold ▶", "mystery"]) {
      const b = document.createElement("button");
      b.textContent = raw;
      header.append(b);
    }
    applyHeaderCopy(header);
    const kids = Array.from(header.children) as HTMLButtonElement[];
    expect(kids[0]!.textContent).toBe("Electronics");
    expect(kids[0]!.title).not.toContain("Needs");
    expect(kids[1]!.title).not.toContain("Needs");
    // "cut&fold" without spaces is not the vocabulary; only the exact label matches.
    expect(kids[2]!.textContent).toBe("cut&fold ▶");
    expect(kids[3]!.title).toBe("");
  });

  it("says what is needed only while the button is disabled", () => {
    installDom();
    const header = document.createElement("div");
    for (const raw of ["Simulate", "Cut & fold"]) {
      const b = document.createElement("button");
      b.textContent = raw;
      b.disabled = true;
      header.append(b);
    }
    const kids = Array.from(header.children) as HTMLButtonElement[];
    applyHeaderCopy(header);
    expect(kids[0]!.title).toContain("Needs a pattern: press Cut & fold first");
    expect(kids[1]!.title).toContain("Needs a mesh: drop a model first");
    for (const k of kids) k.disabled = false;
    applyHeaderCopy(header);
    expect(kids[0]!.title).toBe("Fold the pattern in 3D.");
    expect(kids[1]!.title).not.toContain("Needs");
  });

  it("covers every label the header mounts", () => {
    const labels = HEADER_COPY.map((c) => c.label);
    for (const l of ["Simulate", "Export", "Electronics", "Examples", "Tutorials", "Create pyramid", "Cut & fold"]) {
      expect(labels).toContain(l);
    }
    for (const c of HEADER_COPY) expect(c.title.length).toBeGreaterThan(10);
  });
});
