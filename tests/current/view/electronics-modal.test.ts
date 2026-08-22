import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectronicsModal } from "../../../src/view/electronics-modal.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { flatFaces } from "../../../src/model/electronics.js";
import { batteryTerminals, patternDiag, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { printScale } from "../../../src/model/print-scale.js";
import { COMPONENTS, R_1206 } from "../../../src/model/footprints.generated.js";
import { REST_COMPONENTS } from "../../../src/model/footprints.rest.generated.js";
import { PCB_COLOURS } from "../../../src/model/part-render.js";
import { padNamed, padSize, terminals } from "../../../src/model/footprint.js";
import { placement } from "../../../src/model/parts.js";
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

/** A point a fraction `u` of the way along a run, measured by length — so three of them are three places
 *  on the copper, and not the same corner twice on a run with only two vertices. */
function alongRun(run: { pts: { x: number; y: number }[] }, u: number): { x: number; y: number } {
  const seg = run.pts.slice(1).map((b, i) => Math.hypot(b.x - run.pts[i]!.x, b.y - run.pts[i]!.y));
  const total = seg.reduce((a, b) => a + b, 0);
  let want = u * total;
  for (let i = 0; i < seg.length; i++) {
    if (want > seg[i]! && i < seg.length - 1) {
      want -= seg[i]!;
      continue;
    }
    const t = seg[i]! > 0 ? Math.min(1, want / seg[i]!) : 0;
    const a = run.pts[i]!, b = run.pts[i + 1]!;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return { ...run.pts[0]! };
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

  it("redraws the tiles and the leg pads when the sim's Gap slider moves", () => {
    // The gray tiles here ARE the printed tiles, and the diamonds between them are the gaps an LED
    // bridges. Leaving them at the default while the sim shows 40% would have the tool laying parts on
    // a build that no longer exists.
    const { modal } = openOn(grid2x2());
    modal.selectTool("led");
    tapFlat(modal, { x: 1, y: 0.5 }); // the hinge between faces 0 and 1
    const placed = modal.circuit.leds.length;
    expect(placed).toBe(1);

    const narrowTiles = modal.tiles.map((t: any) => t.ring.map((p: any) => [p.x, p.y]));
    const narrowLegs = modal.gaps.map((g: any) => [g.legA.x, g.legA.y]);
    const before = modal.svg.innerHTML;

    modal.setTileGap(0.4); // the sim slider at 40%

    expect(modal.tiles.map((t: any) => t.ring.map((p: any) => [p.x, p.y]))).not.toEqual(narrowTiles);
    expect(modal.gaps.map((g: any) => [g.legA.x, g.legA.y])).not.toEqual(narrowLegs);
    expect(modal.svg.innerHTML).not.toBe(before); // and it is on screen, not just in the fields
    // The LED is stored as the pair of faces it straddles, so a wider gap moves it -- it does not lose it.
    expect(modal.circuit.leds).toHaveLength(placed);
  });

  it("ignores a gap change that is not a change", () => {
    const { modal, edits } = openOn(grid2x2());
    const before = modal.svg.innerHTML;
    const n = edits.length;
    modal.setTileGap(modal.tileGap);
    expect(modal.svg.innerHTML).toBe(before);
    expect(edits).toHaveLength(n); // no edit emitted: the circuit never changed
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
    expect(modal.selected).toEqual({ kind: "led", index: 0 });
    expect(modal.svg.innerHTML).toContain("el-led-selected");

    (globalThis as any).document.dispatch("keydown", { key: "Delete" });
    expect(modal.circuit.leds).toHaveLength(0);
    expect(modal.selected).toBeNull();
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
    expect(modal.statusEl.textContent).toContain("Select a component first");
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
      expect(modal.svg.innerHTML).toContain("el-part-marks");
      expect(modal.svg.innerHTML).toContain(PCB_COLOURS.copper);
    });

    it("is drawn at its own footprint's size, not the tape's", () => {
      // Sized from the tape it broke, a resistor came out to whatever scale the pattern happened to use.
      //
      // This used to assert the resistor matched an LED, which held only while both were hand-solder
      // 1206s and the two were drawn from one shared size. They are their own parts now — FabLib's LED
      // is 1.4x1.7mm and its resistor 1.2x1.6 — so equality with the LED was a coincidence, not the
      // property worth guarding. The property is that the size comes from the PART: it must be the
      // footprint's own pad, and it must not move when the tape does.
      const measure = (): number => {
        const { modal } = openOn(grid2x2());
        modal.selectTool("battery");
        tapFlat(modal, { x: 0.5, y: 0.5 });
        modal.selectTool("led");
        tapFlat(modal, modal.gaps[0].point);
        const run = modal.routed.traces[0];
        modal.selectTool("resistor");
        tapFlat(modal, run.pts[Math.floor(run.pts.length / 2)]);
        const drawn = modal.drawnParts();
        expect(drawn, "no resistor drawn").toHaveLength(1);
        // Read off the shape the canvas hands the renderer, not the markup: pads are painted as their
        // true outlines now, and it is the placement this test is about.
        const lead = drawn[0].shape.leads[0];
        return Math.hypot(lead.b.x - lead.a.x, lead.b.y - lead.a.y);
      };
      const span = measure();
      expect(span).toBeCloseTo(padSize(padNamed(R_1206, "1")).h, 4);
      // And the same on a pattern of a different size, where the tape is a different width.
      expect(measure()).toBeCloseTo(span, 9);
    });

    it("draws a switch's land copper on the canvas, not just in the export", () => {
      // The rail steps across the part: a stub to the common, another across to one throw. Both are narrow
      // land copper, not tape. The canvas has to draw them or it shows a rail with a hole in it and no way
      // for the current to get across — a circuit that cannot work, drawn as though it does.
      const { modal } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      const before = modal.routed.traces.length;
      const run = modal.routed.traces.find((t: any) => t.net === "pwr");
      modal.selectTool("switch");
      tapFlat(modal, run.pts[Math.floor(run.pts.length / 2)]);

      expect(modal.routed.switches.length).toBeGreaterThan(0);
      const lands = modal.routed.traces.filter((t: any) => t.width !== undefined);
      expect(lands).toHaveLength(2);
      // The break makes one more run, and the two lands are two more again.
      expect(modal.routed.traces.length).toBe(before + 3);
      // Each land is narrower than the tape, and each is drawn.
      for (const l of lands) expect(l.width).toBeLessThan(modal.tapeW());
      expect((modal.svg.innerHTML.match(/class="el-tape/g) ?? []).length)
        .toBe(modal.routed.traces.length);
    });

    it("selects one when it is tapped again, and removes it on Delete", () => {
      // Tapping one used to delete it, which is what made a second resistor impossible to place near the
      // first: the tap meant to add landed on the one already there and took it off. It now selects, as
      // tapping an LED does, and Delete is what removes it.
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
      expect(modal.circuit.resistors, "a second tap selects rather than deletes").toHaveLength(1);
      expect(modal.selected).toEqual({ kind: "resistor", index: 0 });
      expect(modal.svg.innerHTML).toContain("el-part-selected");

      (globalThis as any).document.dispatch("keydown", { key: "Delete" });
      expect(modal.circuit.resistors).toHaveLength(0);
      expect(modal.selected).toBeNull();
      expect(modal.svg.innerHTML).not.toContain("el-part-marks");
    });
  });

  describe("library parts", () => {
    /** A circuit with copper on it, and a point in the middle of a run to place parts on. */
    function withRails(): { modal: any; edits: unknown[]; at: { x: number; y: number } } {
      const { modal, edits } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      expect(modal.routed.traces.length).toBeGreaterThan(0);
      const run = modal.routed.traces[0];
      return { modal, edits, at: run.pts[Math.floor(run.pts.length / 2)] };
    }

    /** Arm the palette on a library part, the way clicking the picker does. */
    function pick(modal: any, id: string): void {
      const select = modal.overlay.querySelector(".el-part");
      select.value = id;
      select.dispatch("change", {});
      expect(modal.tool).toBe(id);
    }

    /** Every part in the library, both halves of the generated file — the palette must weigh them the
     *  same. Which half a part is emitted into is a bundling decision, not a fact about the part. */
    const WHOLE_LIBRARY = [...COMPONENTS, ...REST_COMPONENTS];

    it("offers every series part in the library, and grows without a button each", async () => {
      // The palette is built from COMPONENTS, so a part added to the library has to appear here with no
      // change to the view. A button per part was the thing to avoid: seven fits on the toolbar, twenty
      // does not.
      const { modal } = openOn(grid2x2());
      await modal.libraryReady;
      const offered = modal.overlay.querySelectorAll("option").map((o: any) => o.value);
      const ids = WHOLE_LIBRARY.map((c) => c.id);
      for (const id of offered) expect(ids, `${id} is not a library part`).toContain(id);
      // Everything in series on a rail is offered...
      for (const id of ["R_1206", "R_2010", "C_1206", "SW_SPDT", "SW_PUSH"]) {
        expect(offered, `${id} missing from the palette`).toContain(id);
      }
      // ...and the two the fixed tools place are not, since neither goes in series: an LED straddles a
      // hinge and the battery pins to a face.
      expect(offered).not.toContain("LED_1206");
      expect(offered).not.toContain("BAT_COIN_20");
      // Exactly the library parts a rail can pass through, less those two. Stated as the rule rather
      // than as a number: the library went from 8 footprints to 159 and a count would have been a lie
      // by the next commit.
      const series = WHOLE_LIBRARY.filter(
        (c) => placement(c.footprint).placeable && c.id !== "LED_1206" && c.id !== "BAT_COIN_20",
      );
      expect(offered.sort()).toEqual(series.map((c) => c.id).sort());
      // One control for the library, not one button per part.
      expect(modal.overlay.querySelectorAll(".el-tool")).toHaveLength(2);
    });

    /** The picker's rows, as a browser would read them: what each offers, whether it is selectable. */
    function rows(modal: any): { value: string; text: string; disabled: boolean }[] {
      return modal.overlay.querySelectorAll("option").map((o: any) => ({
        value: o.value,
        text: o.textContent,
        disabled: o.disabled === true,
      }));
    }

    /** Type into the palette's search box, as a user does. */
    function search(modal: any, query: string): void {
      const box = modal.overlay.querySelector(".el-part-search");
      box.value = query;
      box.dispatch("input", {});
    }

    it("shelves the parts it offers into named groups, and puts every one of them on a shelf", () => {
      // Forty-odd rows in one scroll is a wall. The shelves are what make it a menu -- and every offered
      // part has to be on one, or the grouping has quietly lost a part instead of filing it.
      const { modal } = openOn(grid2x2());
      const groups = modal.overlay.querySelectorAll("optgroup");
      expect(groups.length).toBeGreaterThan(1);
      for (const g of groups) expect(g.getAttribute("label")).toBeTruthy();
      const shelved = groups.flatMap((g: any) => g.children.map((o: any) => o.value));
      expect(shelved.sort()).toEqual(rows(modal).map((r) => r.value).sort());
      // The library's own kinds, not one shelf per part.
      const labels = groups.map((g: any) => g.getAttribute("label"));
      expect(labels).toContain("Resistors");
      expect(labels).toContain("Switches & buttons");
      expect(labels.length).toBeLessThan(rows(modal).length);
    });

    it("narrows the picker to what is typed, matching the note as well as the id", () => {
      // The names are datasheet part numbers -- `Switch_Slide_Top_CnK_JS102011JCQN_8_5x3_5mm` -- so
      // scrolling for one is hopeless and typing is the only way in.
      const { modal } = openOn(grid2x2());
      const all = rows(modal).length;
      search(modal, "resistor");
      const hits = rows(modal);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThan(all);
      for (const r of hits) {
        const c = COMPONENTS.find((x) => x.id === r.value)!;
        expect(`${c.id} ${c.note}`.toLowerCase(), `${c.id} does not match "resistor"`)
          .toContain("resistor");
      }
      // Every term has to match, so a second word narrows rather than widens.
      search(modal, "resistor 2010");
      expect(rows(modal).map((r) => r.value)).toEqual(["R_2010"]);
      // And clearing it gives the whole shelf back.
      search(modal, "");
      expect(rows(modal)).toHaveLength(all);
    });

    it("keeps the armed part in the picker even when the search excludes it, and does not re-arm", () => {
      // Typing narrows the view; it must not change what the next click on the canvas places. If the
      // armed part dropped out of the list the picker would be showing one part and placing another.
      const { modal } = openOn(grid2x2());
      pick(modal, "C_1206");
      search(modal, "resistor");
      expect(modal.tool, "typing re-armed the tool").toBe("C_1206");
      expect(rows(modal).map((r) => r.value)).toContain("C_1206");
      expect(modal.overlay.querySelector(".el-part").value).toBe("C_1206");
    });

    it("reaches the half of the library that is not in the main bundle", async () => {
      // The 117 parts a rail cannot pass through are a megabyte of pad outlines and are emitted into a
      // second file, fetched only when the modal opens. They are emitted at all so the palette can name
      // them -- so the picker has to actually know about them, and know them by the same rule as the
      // rest: which file a part was emitted into is a bundling decision, not a fact about the part.
      const { modal } = openOn(grid2x2());
      await modal.libraryReady;
      const lazy = REST_COMPONENTS.find((c) => /USB_C/.test(c.id))!;
      expect(lazy, "the lazy half has no USB-C part to look for").toBeTruthy();

      search(modal, lazy.id.toLowerCase());
      const row = rows(modal).find((r) => r.text.includes(lazy.id));
      expect(row, `${lazy.id} is in the library but the picker never heard of it`).toBeTruthy();
      // Judged by placement(), not by which file it came out of.
      const verdict = placement(lazy.footprint);
      expect(verdict.placeable).toBe(false);
      expect(row!.disabled).toBe(true);
      expect(row!.text).toContain(verdict.placeable ? "" : verdict.why);
    });

    it("redraws the picker when the lazily-loaded half of the library arrives", async () => {
      // The library is fetched once per page, so by the second test in this file it is already there.
      // This one asks for a fresh module registry, so the modal is genuinely opened against a picker
      // that does not yet know the other 114 parts -- and has to be redrawn when they land, or the
      // count line goes on claiming the eager half is the whole library.
      vi.resetModules();
      const { ElectronicsModal: Fresh } = await import("../../../src/view/electronics-modal.js");
      const { document } = installDom();
      const modal = new (Fresh as any)() as any;
      modal.mountTrigger(document.createElement("div") as unknown as HTMLElement);
      modal.setEnabled(true);
      modal.setPattern(grid2x2());
      modal.open();

      const count = modal.overlay.querySelector(".el-part-count");
      const before = count.textContent;
      await modal.libraryReady;

      expect(before, "the picker knew the lazy half before it was fetched").not.toContain("search to see");
      expect(count.textContent, "the picker was never redrawn when the library landed").toContain(
        `search to see the other ${REST_COMPONENTS.length}`,
      );
    });

    it("finds a part it cannot place and says why, instead of showing nothing", async () => {
      // The library holds 159 footprints and most cannot go in series on a rail. Hunting for a USB socket
      // and getting an empty list reads as a broken app -- so the search turns it up, greyed out, under
      // the reason it is not on offer.
      const { modal } = openOn(grid2x2());
      await modal.libraryReady;
      search(modal, "usb");
      const blocked = rows(modal).filter((r) => r.disabled);
      expect(blocked.length, "no USB part was surfaced at all").toBeGreaterThan(0);
      for (const r of blocked) {
        expect(r.text.toLowerCase()).toContain("usb");
        expect(r.text, `${r.text} does not say why it cannot be placed`).toMatch(/terminal/);
        expect(r.value, "an unplaceable row could be picked").toBeFalsy();
      }
      // It is named, not merely counted: the id is there to recognise.
      expect(blocked.map((r) => r.text).join(" ")).toContain("Conn_USB");
      // And it is under a shelf that says what the greyed-out rows are.
      const labels = modal.overlay.querySelectorAll("optgroup").map((g: any) => g.getAttribute("label"));
      expect(labels).toContain("In the library, but not in series on a rail");
    });

    it("will not arm a tool on a part it cannot place", () => {
      // Belt and braces on the greyed-out rows: even if a browser let one through, the canvas must not be
      // left armed with a tool that places nothing.
      const { modal } = openOn(grid2x2());
      pick(modal, "C_1206");
      const select = modal.overlay.querySelector(".el-part");
      select.value = "Conn_USB_C_Socket_Molex_2171790001";
      select.dispatch("change", {});
      expect(modal.tool).toBe("C_1206");
    });

    it("says how much of the library is on offer, so the picker is not read as all of it", async () => {
      const { modal } = openOn(grid2x2());
      await modal.libraryReady;
      const count = modal.overlay.querySelector(".el-part-count");
      const offered = rows(modal).length;
      const notFixed = WHOLE_LIBRARY.filter((c) => c.id !== "LED_1206" && c.id !== "BAT_COIN_20");
      const library = notFixed.length;
      const unplaceable = notFixed.filter((c) => !placement(c.footprint).placeable).length;
      expect(count.textContent).toBe(
        `${offered} of ${library} parts go in series on a rail — search to see the other ${unplaceable}`,
      );
      // While searching it counts the hits, and says how many more the library has that it cannot place.
      search(modal, "usb");
      const hits = rows(modal).filter((r) => !r.disabled).length;
      const missed = rows(modal).filter((r) => r.disabled).length;
      expect(count.textContent).toContain(`${hits} match`);
      expect(count.textContent).toContain(`${missed} in the library but not placeable`);
    });

    it("places the picked part on the nearest rail, snapped to the copper, and draws it", () => {
      const { modal, edits, at } = withRails();
      pick(modal, "C_1206");

      // Click just off the copper: what gets stored is the point on the run, not where the cursor was.
      const off = { x: at.x + 0.02, y: at.y + 0.02 };
      const snap = modal.nearestOnRail(off);
      const base = edits.length;
      tapFlat(modal, off);

      expect(edits.length).toBeGreaterThan(base);
      expect(modal.circuit.parts).toHaveLength(1);
      expect(modal.circuit.parts[0].component).toBe("C_1206");
      expect(modal.circuit.parts[0].x).toBeCloseTo(snap.point.x, 9);
      expect(modal.circuit.parts[0].y).toBeCloseTo(snap.point.y, 9);
      expect(modal.circuit.parts[0].x, "stored the raw click, not the snap").not.toBeCloseTo(off.x, 9);
      // And it is on screen, not merely in the circuit: nothing else re-renders the modal.
      expect(modal.svg.innerHTML).toContain("el-part-marks");
      expect(modal.svg.innerHTML).toContain(PCB_COLOURS.mask);
    });

    it("carries the placed parts through to the controller", () => {
      // `cloneCircuit` has silently dropped a newly added field before, and the symptom is nasty: the part
      // draws on the canvas and vanishes the moment the circuit reaches the store.
      const { modal, edits, at } = withRails();
      pick(modal, "R_2010");
      tapFlat(modal, at);

      const sent = edits[edits.length - 1] as any;
      expect(sent.parts).toEqual(modal.circuit.parts);
      expect(sent.parts, "the clone shares the array with the modal's own circuit").not.toBe(modal.circuit.parts);
      expect(sent.parts[0], "the clone shares a part object").not.toBe(modal.circuit.parts[0]);
      expect(sent.parts[0]).toEqual({ component: "R_2010", x: expect.any(Number), y: expect.any(Number) });
    });

    it("selects a placed part when it is tapped again, and removes it on Delete", () => {
      const { modal, at } = withRails();
      pick(modal, "C_1206");
      tapFlat(modal, at);
      expect(modal.circuit.parts).toHaveLength(1);

      tapFlat(modal, modal.circuit.parts[0]);
      expect(modal.circuit.parts, "a second tap selects rather than deletes").toHaveLength(1);
      expect(modal.selected).toEqual({ kind: "part", index: 0 });
      expect(modal.svg.innerHTML).toContain("el-part-selected");

      (globalThis as any).document.dispatch("keydown", { key: "Delete" });
      expect(modal.circuit.parts).toHaveLength(0);
      expect(modal.selected).toBeNull();
      expect(modal.svg.innerHTML).not.toContain("el-part-marks");
    });

    it("places several of the same part on one rail, and routes every one of them", () => {
      // The point of the whole exercise: more than one capacitor. Each tap used to land inside the target
      // of the part already there -- a target sized to the pattern rather than to the part -- so the second
      // tap deleted the first and the circuit never held two of anything.
      const { modal } = withRails();
      pick(modal, "C_1206");
      const run = modal.routed.traces.find((t: any) => t.net === "pwr");
      // Three points spread along the run, each on its own segment so they are genuinely apart.
      const spots = [0.2, 0.5, 0.8].map((u) => alongRun(run, u));
      for (const spot of spots) tapFlat(modal, spot);

      expect(modal.circuit.parts).toHaveLength(3);
      for (const p of modal.circuit.parts) expect(p.component).toBe("C_1206");
      // And all three are on the copper, not merely in the circuit.
      expect(modal.routedParts()).toHaveLength(3);
      expect(modal.routedParts().map((p: any) => p.source).sort()).toEqual([0, 1, 2]);
      expect(modal.drawnParts()).toHaveLength(3);
      expect(modal.statusEl.textContent).not.toContain("did not fit");
    });

    it("places different parts on the same rail together", () => {
      // A resistor, a capacitor and a larger resistor on one rail: each component is its own group, broken
      // in turn with its own fit, and each group sees the breaks the ones before it made.
      //
      // This used to end with an SPDT rather than the 2010. It cannot: the switch needs a 6.5mm break
      // plus 4.3mm of copper to seat on either side, and once the first two parts have cut this small
      // grid's rail into thirds there is nowhere with 15mm of continuous run left. That is the router
      // being right, so the next test asserts it rather than the fixture being enlarged to hide it.
      const { modal } = withRails();
      const run = modal.routed.traces.find((t: any) => t.net === "pwr");
      const spots = [0.2, 0.5, 0.8].map((u) => alongRun(run, u));
      const ids = ["R_1206", "C_1206", "R_2010"];
      ids.forEach((id, i) => {
        pick(modal, id);
        tapFlat(modal, spots[i]!);
      });

      expect(modal.circuit.parts.map((p: any) => p.component)).toEqual(ids);
      expect(modal.routedParts()).toHaveLength(3);
      expect(new Set(modal.routedParts().map((p: any) => p.component))).toEqual(new Set(ids));
      expect(modal.statusEl.textContent).not.toContain("did not fit");
    });

    it("says so when the rail has no room left for one more part", () => {
      // The other half of the test above. Three parts have taken this rail apart; a switch needs a 6.5mm
      // break with 4.3mm of copper each side, and no run is that long any more. It must be refused and
      // reported — not dropped in silence, and not squeezed in over another part.
      const { modal } = withRails();
      const run = modal.routed.traces.find((t: any) => t.net === "pwr");
      const spots = [0.2, 0.5, 0.8].map((u) => alongRun(run, u));
      ["R_1206", "C_1206", "R_2010"].forEach((id, i) => {
        pick(modal, id);
        tapFlat(modal, spots[i]!);
      });
      pick(modal, "SW_SPDT");
      tapFlat(modal, alongRun(run, 0.35));

      expect(modal.circuit.parts).toHaveLength(4);   // the click was taken
      expect(modal.routedParts()).toHaveLength(3);   // the switch could not be seated
      expect(modal.routedParts().map((p: any) => p.component)).not.toContain("SW_SPDT");
      expect(modal.statusEl.textContent).toContain("did not fit");
    });

    it("picks up the part that was tapped, not its neighbour", () => {
      const { modal } = withRails();
      pick(modal, "C_1206");
      const run = modal.routed.traces.find((t: any) => t.net === "pwr");
      for (const u of [0.25, 0.75]) tapFlat(modal, alongRun(run, u));
      expect(modal.circuit.parts).toHaveLength(2);

      tapFlat(modal, modal.circuit.parts[1]);
      expect(modal.selected).toEqual({ kind: "part", index: 1 });
      // And Delete takes that one off, leaving its neighbour where it was.
      const kept = { ...modal.circuit.parts[0] };
      (globalThis as any).document.dispatch("keydown", { key: "Delete" });
      expect(modal.circuit.parts).toEqual([kept]);
    });

    it("turns a selected part round on R, and hands the choice back on a second press", () => {
      // A switch is a part the rail steps ACROSS, so which way round it sits decides which side its idle
      // throw is stranded on. The router picks one; R overrules it, and R again gives the decision back.
      const { modal } = withRails();
      pick(modal, "SW_SPDT");
      const run = modal.routed.traces.find((t: any) => t.net === "pwr");
      tapFlat(modal, alongRun(run, 0.5));
      expect(modal.routedParts()).toHaveLength(1);
      const chosen = modal.routedParts()[0].flip;

      tapFlat(modal, modal.circuit.parts[0]); // select it
      (globalThis as any).document.dispatch("keydown", { key: "r" });
      expect(modal.circuit.parts[0].flip).toBe(!chosen);
      expect(modal.routedParts()[0].flip, "the router ignored the authored turn").toBe(!chosen);

      (globalThis as any).document.dispatch("keydown", { key: "r" });
      expect(modal.circuit.parts[0].flip).toBeUndefined();
      expect(modal.routedParts()[0].flip).toBe(chosen);
    });

    it("turns an in-line part end for end, swapping which terminal lands on which cut end", () => {
      // In line with the rail there is no idle terminal to strand, so the turn is the swap of its two ends
      // -- which is what a polarised part needs and what the drawing has to follow.
      const { modal } = withRails();
      pick(modal, "C_1206");
      const run = modal.routed.traces.find((t: any) => t.net === "pwr");
      tapFlat(modal, alongRun(run, 0.5));
      const before = modal.routedParts()[0];
      const ends = { a: { ...before.a }, b: { ...before.b } };

      tapFlat(modal, modal.circuit.parts[0]);
      (globalThis as any).document.dispatch("keydown", { key: "r" });

      const after = modal.routedParts()[0];
      expect(after.a).toEqual(ends.b);
      expect(after.b).toEqual(ends.a);
    });

    it("says so when a placed part did not fit", () => {
      // The router drops a part whose run is too short, and without this the click registered, the circuit
      // kept the part, and nothing at all appeared on the canvas.
      const { modal } = withRails();
      modal.circuit = { ...modal.circuit, parts: [{ component: "C_1206", x: 0, y: 0 }] };
      modal.routed = { ...modal.routed, parts: [] };
      modal.renderStatus();
      expect(modal.statusEl.textContent).toContain("1 part did not fit");
    });

    it("keys the legend to the colours actually on the canvas", () => {
      // The legend used to describe the cartoon -- "Part, in line with the rail" against a grey swatch --
      // and a legend that names colours the canvas no longer paints is worse than none.
      const { modal } = openOn(grid2x2());
      const legend = modal.overlay.innerHTML as string;
      expect(legend).toContain(PCB_COLOURS.mask);
      expect(legend).toContain(PCB_COLOURS.componentLabel);
      expect(legend, "the legend still keys the old grey contact").not.toContain("el-key-res");
    });

    it("draws each part as its real footprint pads, not an invented body", () => {
      // The parts used to be a black rounded rect with two grey stubs -- a cartoon that answered none of the
      // questions you look at a footprint to answer. Every terminal is now the pad that will actually be
      // cut: its own outline, in copper with the mask opening over it.
      const { modal, at } = withRails();
      pick(modal, "C_1206");
      tapFlat(modal, at);

      const html = modal.svg.innerHTML as string;
      const drawn = modal.drawnParts();
      expect(drawn).toHaveLength(1);
      const group = /<g class="el-part-marks">([\s\S]*?)<\/g>/.exec(html);
      expect(group, "the parts are not drawn in their own group").toBeTruthy();
      const marks = group![1]!;
      // One copper path and one mask path for every terminal the footprint has -- counted from the library,
      // not from the shape being drawn, or a drawing that lost a pad would agree with itself about it.
      const pins = terminals(drawn[0].footprint).length;
      expect(pins).toBe(2); // a 1206 capacitor
      expect(drawn[0].shape.leads).toHaveLength(pins);
      const copper = marks.match(new RegExp(`fill="${PCB_COLOURS.copper}"`, "g")) ?? [];
      const mask = marks.match(new RegExp(`fill="${PCB_COLOURS.mask}"`, "g")) ?? [];
      expect(copper).toHaveLength(pins);
      expect(mask).toHaveLength(pins);
      expect(marks, "the black cartoon body is still being drawn").not.toContain("#111111");
      expect(marks, "the grey cartoon contacts are still being drawn").not.toContain("#c3cad6");
      // And the origin dot that says where the part's own centre is.
      expect(marks).toContain(PCB_COLOURS.origin);
    });

    it("numbers the designators per family across every part on the canvas at once", () => {
      // The canvas draws three lists -- the two tools that predate the library, and the library itself --
      // and they have to be designated as one set. A part called R1 here and R2 in the cut file would be
      // worse than no label at all.
      const { modal } = withRails();
      const mid = (t: any): { x: number; y: number } => t.pts[Math.floor(t.pts.length / 2)];
      // One of each kind, each on a run of its own -- two parts on one run and the second will not fit.
      modal.selectTool("resistor");
      tapFlat(modal, mid(modal.routed.traces.find((t: any) => t.net === "pwr")));
      modal.selectTool("switch");
      tapFlat(modal, mid(modal.routed.traces.find((t: any) => t.net === "gnd")));
      pick(modal, "R_2010");
      for (const t of modal.routed.traces.filter((x: any) => x.width === undefined)) {
        tapFlat(modal, mid(t));
        if (modal.routedParts().length) break;
      }
      expect(modal.drawnParts().map((d: any) => d.component)).toEqual(["R_1206", "SW_SPDT", "R_2010"]);

      // Zoomed in far enough that the text is worth emitting at all.
      modal.zoomBy(4);
      const html = modal.svg.innerHTML as string;
      const tags = [...html.matchAll(
        new RegExp(`fill="${PCB_COLOURS.componentLabel}"[^>]*>([^<]+)<`, "g"),
      )].map((m) => m[1]);
      // The two resistors share a family and are numbered through it, whichever list each came from.
      expect(tags).toEqual(["R1", "SW1", "R2"]);
    });

    it("holds the pin names back until a pad is big enough on screen to carry one", () => {
      // The canvas fits itself to the whole sheet, so at Fit a 1206 pad is a few pixels across and its own
      // name written on it is a smear that hides the pad instead of naming it. Zooming in is what makes the
      // names worth having, and it must not move anything to show them.
      //
      // Zoomed for until the labels appear rather than by a fixed factor. This test used to zoom exactly
      // 4x, which passed only because a hand-solder 1206 pad happened to cross the threshold there; when
      // the library moved to FabLib's smaller reflow parts the labels arrived at 5.1x and the test failed
      // on a part change rather than a behaviour change. The behaviour worth pinning is the ORDER — the
      // designator first, because it sits beside the part, then the pin names once a pad can hold one —
      // and that nothing moves to reveal either.
      const { modal, at } = withRails();
      pick(modal, "C_1206");
      tapFlat(modal, at);
      modal.fitView();
      modal.draw();

      const placement = (): string[] =>
        modal.drawnParts().map((d: any) => JSON.stringify(d.shape.leads));
      const where = placement();
      const html = (): string => modal.svg.innerHTML as string;

      // At Fit the whole sheet is on screen and a 1206 is a few pixels: no writing on it at all.
      const before = html();
      expect(before, "a pin name at Fit, where it is a smear").not.toContain(PCB_COLOURS.padLabel);
      expect(before, "a designator at Fit, where it is a smear").not.toContain(PCB_COLOURS.componentLabel);
      expect(modal.drawnParts().every((d: any) => !modal.padLabelsFit(d.shape))).toBe(true);

      // Zooming repaints the parts by itself — nothing edits the circuit.
      let designatorAt = 0, pinNamesAt = 0, zoom = 1;
      for (let i = 0; i < 10 && !pinNamesAt; i++) {
        modal.zoomBy(1.5);
        zoom *= 1.5;
        if (!designatorAt && html().includes(PCB_COLOURS.componentLabel)) designatorAt = zoom;
        if (!pinNamesAt && html().includes(PCB_COLOURS.padLabel)) pinNamesAt = zoom;
        // Whatever is or is not written, the copper never moves to make room for it.
        expect(placement(), `parts moved at ${zoom.toFixed(2)}x`).toEqual(where);
      }

      expect(designatorAt, "the designator never appeared").toBeGreaterThan(0);
      expect(pinNamesAt, "the pin names never appeared").toBeGreaterThan(0);
      // The designator comes first: it sits beside the part, so nothing is hidden behind it, whereas a pin
      // name is written inside a pad and a barely-legible one is worse than none.
      expect(designatorAt).toBeLessThan(pinNamesAt);
      // And both within a zoom someone would actually reach — a label that needs 50x is not a feature.
      expect(pinNamesAt, "pin names need an unreasonable zoom").toBeLessThan(12);
      expect(html()).not.toBe(before);
    });

    it("puts the placed parts in both cut files", () => {
      // Drawn on the copper files (never cut) — a part missing from them is a part nobody building this
      // knows to fit.
      const svgs: string[] = [];
      const { modal, at } = withRails();
      (globalThis as any).URL = { createObjectURL: () => "blob:mock", revokeObjectURL: () => {} };
      (globalThis as any).Blob = class {
        constructor(parts: any[]) {
          svgs.push(String(parts[0]));
        }
      };

      // Nothing placed yet, so neither file has a parts layer at all.
      modal.overlay.querySelector(".el-export").dispatch("click", {});
      modal.overlay.querySelector(".el-export-carrier").dispatch("click", {});
      const [stripsBefore, carrierBefore] = svgs.splice(0, 2);
      expect(stripsBefore).not.toContain('<g id="parts">');
      expect(carrierBefore).not.toContain('<g id="annotation"');

      pick(modal, "C_1206");
      tapFlat(modal, at);
      expect(modal.routed.parts, "the router placed nothing to export").toHaveLength(1);

      modal.overlay.querySelector(".el-export").dispatch("click", {});
      modal.overlay.querySelector(".el-export-carrier").dispatch("click", {});
      const [stripsAfter, carrierAfter] = svgs.splice(0, 2);
      // The part is drawn on its own layer in each file — it is annotation, never copper to cut.
      expect(stripsAfter, "the part never reached the strips file").toContain('<g id="parts">');
      expect(carrierAfter, "the part never reached the carrier file").toContain('<g id="annotation"');

      delete (globalThis as any).URL;
      delete (globalThis as any).Blob;
    });
  });

});
