import { afterEach, describe, expect, it } from "vitest";
import { ElectronicsModal } from "../../../src/view/electronics-modal.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { flatFaces } from "../../../src/model/electronics.js";
import { batteryTerminals, patternDiag, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { printScale } from "../../../src/model/print-scale.js";
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

/** Drive a tap at a flat-pattern point: the mock CTM is the identity, so world == client coords.
 *  The point is put through the modal's own flat-to-world transform rather than a copy of it -- a copy
 *  goes stale the moment that transform gains a term, and then taps land on the wrong tile. */
function tapFlat(modal: any, flat: { x: number; y: number }): void {
  const svg = modal.svg;
  const { x: clientX, y: clientY } = modal.tp(flat);
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

    // Same separation as the router's own terminals, converted to the millimetres the canvas draws in:
    // the transform is a flip, a translation and the pattern's print scale, so distance is preserved up
    // to that scale.
    const faces = flatFaces(fold);
    const term = batteryTerminals(faces[0]!.centroid, patternDiag(faces), faces[0]!.poly, tapeWidthFor(faces));
    const want =
      Math.hypot(term.pwr.x - term.gnd.x, term.pwr.y - term.gnd.y) * modal.scale();
    const got = Math.hypot(rects[0]!.x - rects[1]!.x, rects[0]!.y - rects[1]!.y);
    // The markup is written through fmt(), which rounds to 3 decimals, so compare at that precision. The
    // regression this guards against is a ~36x discrepancy, nowhere near the rounding floor.
    expect(Math.abs(got - want), `pad spacing ${got} vs router ${want}`).toBeLessThan(2e-3);

    // And both are on the sheet, which is what actually failed on screen.
    const { w, h } = modal.sheet();
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

  it("selects an LED when it is tapped, and removes it on Delete", () => {
    // Tapping an existing LED used to delete it. It now selects it: deleting on the same gesture that selects
    // would leave no way to pick an LED up in order to turn it round.
    const { modal } = openOn(grid2x2());
    modal.selectTool("led");
    const gap = modal.gaps[0];
    tapFlat(modal, gap.point);
    expect(modal.circuit.leds).toHaveLength(1);

    tapFlat(modal, gap.point);
    expect(modal.circuit.leds, "a second tap selects rather than deletes").toHaveLength(1);
    expect(modal.selected).toBe(0);
    expect(modal.svg.innerHTML).toContain("el-led-selected");

    (globalThis as any).document.dispatch("keydown", { key: "Delete" });
    expect(modal.circuit.leds).toHaveLength(0);
    expect(modal.selected).toBe(-1);
  });

  it("turns the selected LED round on R, and fixes that orientation", () => {
    const { modal } = openOn(grid2x2());
    modal.selectTool("battery");
    tapFlat(modal, { x: 0.5, y: 0.5 });
    modal.selectTool("led");
    tapFlat(modal, modal.gaps[0].point);

    const before = modal.routed.pads[0];
    (globalThis as any).document.dispatch("keydown", { key: "r" });

    // The two pads have swapped, and the choice is recorded on the LED so the router cannot undo it.
    const after = modal.routed.pads[0];
    expect(after.pwr).toEqual(before.gnd);
    expect(after.gnd).toEqual(before.pwr);
    expect(modal.circuit.leds[0].flip).toBeTypeOf("boolean");

    // And again hands the decision back to the router, rather than fixing the opposite orientation forever.
    // Fixing one the wrong way can force a crossing the router would have avoided, so there has to be a way out.
    (globalThis as any).document.dispatch("keydown", { key: "r" });
    expect(modal.circuit.leds[0].flip).toBeUndefined();
    expect(modal.routed.pads[0].pwr).toEqual(before.pwr);
  });

  it("says what to do when R is pressed with nothing selected", () => {
    const { modal } = openOn(grid2x2());
    (globalThis as any).document.dispatch("keydown", { key: "r" });
    expect(modal.statusEl.textContent).toContain("Select an LED first");
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

  it("frames the whole drawing on a pattern the print size scales up", () => {
    // A scale-less pattern is cut at the print sheet, so everything the canvas draws is multiplied by
    // printScale -- 65x for this 2-unit fixture, ~33x for house and ~40x for church. The box used for framing
    // and for the zoom clamp held the raw pattern extent instead, so Fit set a 2mm viewBox over a 130mm
    // drawing: an empty corner of the sheet, with the zoom-out clamp too tight to ever find the copper again.
    const fold = grid2x2();
    const { modal } = openOn(fold);
    const k = printScale(fold);
    expect(k, "fixture must actually exercise the scaling").toBeGreaterThan(1);

    const MARGIN = 8;
    const b = modal.bounds;
    // Where `tp()` puts the pattern: scaled by k, offset by the margin.
    const drawnW = (b.maxX - b.minX) * k, drawnH = (b.maxY - b.minY) * k;

    const box = (): number[] => (modal.svg.getAttribute("viewBox") as string).split(" ").map(Number);
    modal.overlay.querySelector(".el-fit").dispatch("click", {});
    const [vx, vy, vw, vh] = box();
    expect(vx, "Fit crops the left of the drawing").toBeLessThanOrEqual(MARGIN);
    expect(vy, "Fit crops the top of the drawing").toBeLessThanOrEqual(MARGIN);
    expect(vx + vw, "Fit crops the right of the drawing").toBeGreaterThanOrEqual(MARGIN + drawnW);
    expect(vy + vh, "Fit crops the bottom of the drawing").toBeGreaterThanOrEqual(MARGIN + drawnH);

    // And zooming out can still reach the whole sheet: the clamp measures against the same box.
    for (let i = 0; i < 30; i++) modal.zoomBy(1 / 1.12);
    expect(box()[2], "zoom-out clamped tighter than the drawing").toBeGreaterThanOrEqual(drawnW);
  });

  describe("mirroring", () => {
    /** Tap at a client point, which the identity mock CTM makes a world point. */
    const tapWorld = (modal: any, x: number, y: number): void => {
      modal.svg.dispatch("pointerdown", { button: 0, clientX: x, clientY: y, pointerId: 1 });
      modal.svg.dispatch("pointerup", { button: 0, clientX: x, clientY: y, pointerId: 1 });
    };

    it("draws the mirrored layout, not just exports one", () => {
      // Placing parts against an unmirrored picture of a mirrored cut is how a board comes out right on
      // screen and reversed on the mat, so the canvas has to flip with the file.
      const { modal } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      const plain = modal.svg.innerHTML;

      modal.toggleMirror("x");
      expect(modal.svg.innerHTML).not.toBe(plain);

      // Reflection is its own inverse: flipping back restores exactly what was there.
      modal.toggleMirror("x");
      expect(modal.svg.innerHTML).toBe(plain);
    });

    it("still places parts where the cursor is once the view is mirrored", () => {
      // The regression this guards: `tp` mirrors while `clientToFlat` does not, so every click lands on the
      // unmirrored twin of the tile under the cursor -- the battery appears across the pattern from the tap.
      const { modal, edits } = openOn(grid2x2());
      modal.selectTool("battery");

      // Face 0 in the unmirrored view, tapped through the plain transform.
      tapFlat(modal, { x: 0.5, y: 0.5 });
      const target = modal.tp({ x: 0.5, y: 0.5 });
      expect((edits[edits.length - 1] as any).battery).toEqual({ face: 0 });

      modal.toggleMirror("x");
      // Same tile, now drawn somewhere else. Tap where it is drawn now.
      const moved = modal.tp({ x: 0.5, y: 0.5 });
      expect(moved.x).not.toBeCloseTo(target.x, 6);
      const before = edits.length;
      tapWorld(modal, moved.x, moved.y);

      // Tapping the battery's own tile toggles it off -- which only happens if the click resolved to face 0.
      expect(edits).toHaveLength(before + 1);
      expect((edits[before] as any).battery).toBeNull();
    });

    it("shows which way it is flipped, and says so on the file it saves", () => {
      const { modal } = openOn(grid2x2());
      const btnX = modal.overlay.querySelector(".el-mirror");
      expect(btnX.classList.contains("is-active")).toBe(false);

      btnX.dispatch("click", {});
      expect(btnX.classList.contains("is-active")).toBe(true);
      expect(btnX.getAttribute("aria-pressed")).toBe("true");

      // And the saved file is named and reported as mirrored.
      const anchors: any[] = [];
      const origCreate = (globalThis as any).document.createElement.bind((globalThis as any).document);
      (globalThis as any).document.createElement = (tag: string) => {
        const el = origCreate(tag);
        if (tag === "a") anchors.push(el);
        return el;
      };
      (globalThis as any).URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
      (globalThis as any).Blob = class {};

      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      modal.overlay.querySelector(".el-export").dispatch("click", {});

      expect(anchors).toHaveLength(1);
      expect(anchors[0].download).toBe("kiri-copper-mirrored-x.svg");
      expect(modal.statusEl.textContent).toContain("mirrored left-right");

      (globalThis as any).document.createElement = origCreate;
      delete (globalThis as any).URL;
      delete (globalThis as any).Blob;
    });
  });

  describe("resistors", () => {
    it("places one on the nearest rail, and draws it straight away", () => {
      const { modal, edits } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      expect(modal.routed.traces.length).toBeGreaterThan(0);

      // Somewhere on a run of copper.
      const run = modal.routed.traces[0];
      const at = run.pts[Math.floor(run.pts.length / 2)];
      const base = edits.length;
      modal.selectTool("resistor");
      tapFlat(modal, at);

      const circuit = edits[edits.length - 1] as any;
      expect(edits.length).toBeGreaterThan(base);
      expect(circuit.resistors).toHaveLength(1);
      // On screen, not merely in the circuit: nothing else re-renders the modal.
      expect(modal.svg.innerHTML).toContain("el-res-body");
      expect(modal.svg.innerHTML).toContain("el-res-lead");
    });

    it("takes one off when it is tapped again", () => {
      const { modal } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      const run = modal.routed.traces[0];
      const at = run.pts[Math.floor(run.pts.length / 2)];

      modal.selectTool("resistor");
      tapFlat(modal, at);
      expect(modal.circuit.resistors).toHaveLength(1);
      tapFlat(modal, modal.circuit.resistors[0]);
      expect(modal.circuit.resistors).toHaveLength(0);
      expect(modal.svg.innerHTML).not.toContain("el-res-body");
    });
  });
});
