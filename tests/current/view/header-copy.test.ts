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
    for (const raw of ["Simulate", "Export"]) {
      const b = document.createElement("button");
      b.textContent = raw;
      b.disabled = true;
      header.append(b);
    }
    const kids = Array.from(header.children) as HTMLButtonElement[];
    applyHeaderCopy(header);
    expect(kids[0]!.title).toContain("Needs a pattern: load a pattern file, or Cut & fold a 3D model first");
    expect(kids[1]!.title).toContain("Needs a pattern");
    for (const k of kids) k.disabled = false;
    applyHeaderCopy(header);
    expect(kids[0]!.title).toBe("Fold the pattern in 3D.");
    expect(kids[1]!.title).not.toContain("Needs");
  });

  it("finds the buttons one level down, in the header's groups", () => {
    installDom();
    const header = document.createElement("div");
    const flow = document.createElement("nav");
    const library = document.createElement("nav");
    const named = (raw: string) => {
      const b = document.createElement("button");
      b.textContent = raw;
      return b;
    };
    const sim = named("simulate");
    const tut = named("Tutorials");
    flow.append(sim);
    library.append(tut);
    header.append(flow, library);
    applyHeaderCopy(header);
    expect(sim.textContent).toBe("Simulate");
    expect(sim.title).toBe("Fold the pattern in 3D.");
    expect(tut.title).toContain("screen recordings");
  });

  it("covers every label the header mounts", () => {
    const labels = HEADER_COPY.map((c) => c.label);
    for (const l of ["Simulate", "Export", "Electronics", "Examples", "Tutorials"]) {
      expect(labels).toContain(l);
    }
    for (const c of HEADER_COPY) expect(c.title.length).toBeGreaterThan(10);
  });
});
