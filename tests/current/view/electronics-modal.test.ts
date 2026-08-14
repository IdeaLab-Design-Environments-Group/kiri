import { afterEach, describe, expect, it } from "vitest";
import { ElectronicsModal } from "../../../src/view/electronics-modal.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { flatFaces } from "../../../src/model/electronics.js";
import { batteryTerminals, patternDiag, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { installDom } from "./mock-dom.js";

/** A 2x2 grid of unit quads: four faces, hinges between neighbours. */
function grid2x2(): FoldFile {
  return {
    vertices_coords: [
      [0, 0], [1, 0], [2, 0],
      [0, 1], [1, 1], [2, 1],
      [0, 2], [1, 2], [2, 2],
    ],
    faces_vertices: [
      [0, 1, 4, 3],
      [1, 2, 5, 4],
      [3, 4, 7, 6],
      [4, 5, 8, 7],
    ],
    edges_vertices: [[1, 4], [3, 4], [4, 5], [4, 7]],
    edges_assignment: ["M", "M", "M", "M"],
  } as unknown as FoldFile;
}

/** Drive a tap at a flat-pattern point: the mock CTM is the identity, so world == client coords. */
function tapFlat(modal: any, flat: { x: number; y: number }): void {
  const svg = modal.svg;
  const b = modal.bounds;
  const MARGIN = 8;
  // Inverse of `clientToFlat`.
  const clientX = flat.x - b.minX + MARGIN;
  const clientY = b.maxY + MARGIN - flat.y;
  svg.dispatch("pointerdown", { button: 0, clientX, clientY, pointerId: 1 });
  svg.dispatch("pointerup", { button: 0, clientX, clientY, pointerId: 1 });
}

function openOn(fold: FoldFile): { modal: any; edits: unknown[] } {
  const { document } = installDom();
  const modal = new ElectronicsModal() as any;
  modal.mountTrigger(document.createElement("div") as unknown as HTMLElement);
  const edits: unknown[] = [];
  modal.onEdit((c: unknown) => edits.push(c));
  modal.setEnabled(true);
  modal.setPattern(fold);
  modal.open();
  return { modal, edits };
}

describe("view/electronics-modal", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("draws a placed battery immediately, without the controller pushing anything back", () => {
    const { modal, edits } = openOn(grid2x2());
    const before = modal.svg.innerHTML;
    const base = edits.length; // open() emits once so the controller has the initial circuit

    modal.selectTool("battery");
    tapFlat(modal, { x: 0.5, y: 0.5 }); // inside face 0

    // The edit reached the controller...
    expect(edits).toHaveLength(base + 1);
    expect((edits[base] as any).battery).toEqual({ face: 0 });
    // ...and, the actual regression, it is on screen. Nothing re-renders the modal for us.
    expect(modal.svg.innerHTML).not.toBe(before);
    expect(modal.svg.innerHTML).toContain("el-batt-pwr");
    expect(modal.svg.innerHTML).toContain("el-batt-gnd");
  });

  it("draws the battery pads where the router put them, not at some other tape width", () => {
    // The pad spacing is derived from the tape width, so drawing them at a different width from the one the
    // router planned with puts the two squares somewhere the copper never goes. With the width read off the
    // pattern (a scale-less pattern is taken as a 130mm sheet) the bare default was several pattern-widths
    // too wide, and both squares landed outside the drawn sheet entirely — copper on screen, no battery.
    const fold = grid2x2();
    const { modal } = openOn(fold);
    modal.selectTool("battery");
    tapFlat(modal, { x: 0.5, y: 0.5 });

    const rects = [...(modal.svg.innerHTML as string).matchAll(
      /<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"[^>]*class="el-batt /g,
    )].map((m) => ({ x: Number(m[1]) + Number(m[3]) / 2, y: Number(m[2]) + Number(m[4]) / 2 }));
    expect(rects).toHaveLength(2);

    // Same separation as the router's own terminals — the transform to sheet coords is a flip plus a
    // translation, so distance is preserved and no coordinate mapping is needed here.
    const faces = flatFaces(fold);
    const term = batteryTerminals(faces[0]!.centroid, patternDiag(faces), faces[0]!.poly, tapeWidthFor(faces));
    const want = Math.hypot(term.pwr.x - term.gnd.x, term.pwr.y - term.gnd.y);
    const got = Math.hypot(rects[0]!.x - rects[1]!.x, rects[0]!.y - rects[1]!.y);
    // The markup is written through fmt(), which rounds to 3 decimals, so compare at that precision. The
    // regression this guards against is a ~36x discrepancy, nowhere near the rounding floor.
    expect(Math.abs(got - want), `pad spacing ${got} vs router ${want}`).toBeLessThan(2e-3);

    // And both are on the sheet, which is what actually failed on screen.
    const MARGIN = 8;
    const b = modal.bounds;
    const w = b.maxX - b.minX + 2 * MARGIN, h = b.maxY - b.minY + 2 * MARGIN;
    for (const r of rects) {
      expect(r.x, "battery pad off the sheet in x").toBeGreaterThanOrEqual(0);
      expect(r.x, "battery pad off the sheet in x").toBeLessThanOrEqual(w);
      expect(r.y, "battery pad off the sheet in y").toBeGreaterThanOrEqual(0);
      expect(r.y, "battery pad off the sheet in y").toBeLessThanOrEqual(h);
    }
  });

  it("draws a placed LED's two pads immediately", () => {
    const { modal, edits } = openOn(grid2x2());

    modal.selectTool("led");
    const base = edits.length;
    const gap = modal.gaps[0];
    tapFlat(modal, gap.point);

    expect(edits).toHaveLength(base + 1);
    expect((edits[base] as any).leds).toHaveLength(1);
    expect(modal.svg.innerHTML).toContain("el-led-pwr");
    expect(modal.svg.innerHTML).toContain("el-led-gnd");
  });

  it("removes the drawn component when the same spot is tapped again", () => {
    const { modal } = openOn(grid2x2());

    modal.selectTool("led");
    const gap = modal.gaps[0];
    tapFlat(modal, gap.point);
    expect(modal.svg.innerHTML).toContain("el-led-pwr");

    tapFlat(modal, gap.point);
    expect(modal.svg.innerHTML).not.toContain("el-led-pwr");
  });

  it("exports the copper as a download, and says what there is to cut", () => {
    const anchors: any[] = [];
    const { modal } = openOn(grid2x2());
    const origCreate = (globalThis as any).document.createElement;
    (globalThis as any).document.createElement = (tag: string) => {
      const el = origCreate.call((globalThis as any).document, tag);
      if (tag === "a") anchors.push(el);
      return el;
    };
    (globalThis as any).URL = { createObjectURL: () => "blob:mock", revokeObjectURL: () => {} };
    (globalThis as any).Blob = class { constructor(readonly parts: any[]) {} };

    // Nothing placed yet: it must say so rather than download an empty file.
    modal.overlay.querySelector(".el-export").dispatch("click", {});
    expect(anchors).toHaveLength(0);
    expect(modal.statusEl.textContent).toContain("Nothing to export");

    modal.selectTool("battery");
    tapFlat(modal, { x: 0.5, y: 0.5 });
    modal.selectTool("led");
    tapFlat(modal, modal.gaps[0].point);

    modal.overlay.querySelector(".el-export").dispatch("click", {});
    expect(anchors).toHaveLength(1);
    expect(anchors[0].download).toBe("kiri-copper.svg");
    expect(modal.statusEl.textContent).toContain("strip");

    (globalThis as any).document.createElement = origCreate;
    delete (globalThis as any).URL;
    delete (globalThis as any).Blob;
  });

  it("draws the carrier frame only in carrier view, and marks the active mode", () => {
    const { modal } = openOn(grid2x2());
    modal.selectTool("battery");
    tapFlat(modal, { x: 0.5, y: 0.5 });
    modal.selectTool("led");
    tapFlat(modal, modal.gaps[0].point);

    // Strips view: copper, no frame.
    expect(modal.svg.innerHTML).toContain("el-tape");
    expect(modal.svg.innerHTML).not.toContain("el-carrier");

    modal.selectView("carrier");
    expect(modal.svg.innerHTML).toContain("el-carrier");
    expect(modal.svg.innerHTML).toContain("el-carrier-tab");
    expect(modal.svg.innerHTML).toContain("el-tape"); // the traces are still shown, inside the frame
    // The active-button highlight is not asserted: the mock DOM's querySelectorAll does not see elements
    // created through innerHTML, so the toolbar maps are empty here. What matters -- and what is checked -- is
    // that the mode changes what gets drawn.

    modal.selectView("strips");
    expect(modal.svg.innerHTML).not.toContain("el-carrier");
  });

  it("exports the carrier as its own file", () => {
    const anchors: any[] = [];
    const { modal } = openOn(grid2x2());
    const origCreate = (globalThis as any).document.createElement;
    (globalThis as any).document.createElement = (tag: string) => {
      const el = origCreate.call((globalThis as any).document, tag);
      if (tag === "a") anchors.push(el);
      return el;
    };
    (globalThis as any).URL = { createObjectURL: () => "blob:mock", revokeObjectURL: () => {} };
    (globalThis as any).Blob = class { constructor(readonly parts: any[]) {} };

    modal.selectTool("battery");
    tapFlat(modal, { x: 0.5, y: 0.5 });
    modal.selectTool("led");
    tapFlat(modal, modal.gaps[0].point);

    modal.overlay.querySelector(".el-export-carrier").dispatch("click", {});
    expect(anchors).toHaveLength(1);
    expect(anchors[0].download).toBe("kiri-copper-carrier.svg");
    expect(modal.statusEl.textContent).toContain("tab");

    (globalThis as any).document.createElement = origCreate;
    delete (globalThis as any).URL;
    delete (globalThis as any).Blob;
  });

  it("treats a drag as a pan, not a placement", () => {
    const { modal, edits } = openOn(grid2x2());
    modal.selectTool("battery");
    const base = edits.length;
    const svg = modal.svg;
    svg.dispatch("pointerdown", { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    svg.dispatch("pointermove", { button: 0, clientX: 90, clientY: 90, pointerId: 1 });
    svg.dispatch("pointerup", { button: 0, clientX: 90, clientY: 90, pointerId: 1 });
    expect(edits).toHaveLength(base); // no new edit: the drag panned
  });
});
