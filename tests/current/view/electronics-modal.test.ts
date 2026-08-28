import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectronicsModal, UNSHELVED, shelfFor } from "../../../src/view/electronics-modal.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { flatFaces, pointInFace } from "../../../src/model/electronics.js";
import { batteryTerminals, patternDiag, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { printScale } from "../../../src/model/print-scale.js";
import { COMPONENTS, R_1206, SW_SPDT } from "../../../src/model/footprints.generated.js";
import { PCB_COLOURS } from "../../../src/model/part-render.js";
import { padNamed, padSize, terminals } from "../../../src/model/footprint.js";
import { netPlacement } from "../../../src/model/parts.js";
import { LIBRARY, componentById } from "../../../src/model/library.js";
import { sheetFrame } from "../../../src/model/copper-svg-export.js";
import { ERRORS } from "../../../src/model/wire-rules.js";
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
    // The address bar too: a leaked `#/electronics` would put the next modal on the editor page before
    // its test asked for it, which is a confusing way for an unrelated test to fail.
    delete (globalThis as any).location;
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

  describe("what the router wired, shown but not stored", () => {
    /** The nets panel's counts, by net name — what the author actually looks at. */
    function netCounts(modal: any): Record<string, number> {
      const out: Record<string, number> = {};
      modal.overlay.querySelectorAll(".el-net").forEach((row: any) => {
        const name = row.children.find((c: any) => c.className.includes("el-net-name"));
        const tally = row.children.find((c: any) => c.className.includes("el-net-count"));
        if (name && tally) out[name.value] = Number(tally.textContent);
      });
      return out;
    }

    it("stops PWR and GND reading zero once there is a battery and a routed LED", () => {
      // The report that prompted this: a battery placed, an LED routed, and the panel reading PWR 0 GND 0.
      // Both are on those rails by construction, but the panel could only see STORED assignments -- and to
      // the person looking at it, a rail that says 0 is not wired.
      const { modal } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      expect(modal.routed.traces.length, "nothing routed, so nothing to derive").toBeGreaterThan(0);

      const counts = netCounts(modal);
      expect(counts.PWR, "PWR still reads zero on a routed circuit").toBeGreaterThan(0);
      expect(counts.GND, "GND still reads zero on a routed circuit").toBeGreaterThan(0);
    });

    it("claims nothing before anything is routed", () => {
      // A row saying PWR where the copper never arrived is worse than an absent row.
      const { modal } = openOn(grid2x2());
      expect(modal.routed.traces).toHaveLength(0);
      const counts = netCounts(modal);
      expect(counts.PWR ?? 0).toBe(0);
      expect(counts.GND ?? 0).toBe(0);
    });

    it("keeps the derived rows out of the circuit, and out of the store", () => {
      // The load-bearing one. Something real now flows INTO the panel that must never flow back out: if a
      // save path picked a derived row up, the router's `flip[]` and the stored value would disagree the
      // moment it flipped one -- the drift the whole stored/derived split exists to prevent.
      const { modal, edits } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      expect(netCounts(modal).PWR).toBeGreaterThan(0); // the rows are really there...

      // ...and none of them is on the circuit or in what the controller was handed.
      expect(modal.circuit.terminals ?? [], "a derived row was written to the circuit").toHaveLength(0);
      const sent = edits[edits.length - 1] as any;
      expect(sent.terminals ?? [], "a derived row reached the store").toHaveLength(0);
    });

    it("does not let an edit elsewhere write the derived rows into the circuit", () => {
      // `assignPad` and `deleteNet` rebuild `circuit.terminals` from what they read. Reading the panel's
      // rows there -- rather than the stored terminals -- would persist every derived row on the next edit.
      const { modal } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);

      // Any edit that goes through the terminal-rebuilding path.
      const gnd = modal.circuit.nets.findIndex((n: any) => n.id === "gnd");
      modal.overlay.querySelectorAll(".el-net-del")[gnd].dispatch("click", {});

      expect(modal.circuit.terminals ?? [], "an edit persisted the derived rows").toHaveLength(0);
    });
  });

  describe("an LED placed on a tile", () => {
    /** Arm the LED tool in free-placement mode — an LED on a tile rather than across a hinge. */
    function armFreeLed(modal: any): void {
      modal.selectTool("led");
      const seat = modal.overlay.querySelectorAll(".el-place").find((b: any) => b.dataset.place === "free");
      expect(seat, "no free-placement control").toBeTruthy();
      seat.dispatch("click", {});
    }

    it("lands unwired, because placing a part and wiring it are two decisions", () => {
      // **Changed 2026-08-28.** An LED placed on a tile used to arrive with its two pads already assigned to
      // PWR and GND, on the reasoning that an anode and a cathode have one pair they can light on. It was
      // the only part in the library with a default — the editor gated it on the component being an LED.
      //
      // The trouble was that the guess was STORED, so the sidebar showed it as the author's own assignment
      // and there was no way to tell a default apart from a decision. An LED meant for a signal net had to
      // be un-wired before it could be wired.
      const { modal } = openOn(grid2x2());
      armFreeLed(modal);
      tapFlat(modal, { x: 0.5, y: 0.5 });

      expect(modal.circuit.parts).toHaveLength(1);
      expect(modal.circuit.terminals ?? [], "the LED arrived already wired").toHaveLength(0);
      // Its pads are still there to wire — nothing about the part changed, only what is assumed about it.
      expect(terminals(componentById("LED_1206")!.footprint).length).toBe(2);
    });

    it("stores nothing for an LED on a hinge, whose polarity is the router's to decide", () => {
      // A hinge-LED's membership of PWR and GND is true by construction and is NOT stored: which leg is
      // positive is a routing OUTPUT — `planRoutes` searches over `flip[]` — so a stored assignment would
      // state as fact something the router is still deciding, and the two would disagree the moment it
      // flipped one. The panel may show it; the circuit must not carry it.
      //
      // Guarded through the round trip rather than at the write, because `cloneCircuit` carries fields it
      // was never taught about: a derived row picked up by a save path is exactly how the drift gets in.
      const { modal, edits } = openOn(grid2x2());
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      expect(modal.circuit.leds, "no hinge LED was placed").toHaveLength(1);

      expect(modal.circuit.terminals ?? [], "a hinge LED wrote terminals into the circuit").toHaveLength(0);
      const sent = edits[edits.length - 1] as any;
      expect(sent.terminals ?? [], "terminals for a hinge LED reached the store").toHaveLength(0);
    });

    it("defaults nothing for a part from the palette either, by the other placement path", () => {
      // Nothing gets a default netlist any more — see the LED test above, which took the last one away.
      // Kept because this reaches the circuit by a different route: the parts palette rather than the LED
      // tool, and the two write `circuit.parts` in two places. A resistor is the right subject for it
      // regardless, since its two pads carry no polarity and PWR/GND would be an invented circuit.
      const { modal } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      const at = { x: 0.5, y: 0.5 };
      const select = modal.overlay.querySelector(".el-part");
      select.value = "R_1206";
      select.dispatch("change", {});
      tapFlat(modal, at);

      const parts = modal.circuit.parts ?? [];
      expect(parts.length, "no resistor was placed at all").toBeGreaterThan(0);
      const last = parts.length - 1;
      expect(modal.circuit.terminals.filter((t: any) => t.part === last)).toHaveLength(0);
    });
  });

  describe("the round trip to the store", () => {
    /**
     * A circuit with every optional field populated.
     *
     * This fixture is the guard. `cloneCircuit` has silently eaten six fields over this project's life —
     * `flip`, `component`, `nets`/`terminals`, `wires`, `free`, `color` — and every one drew on the canvas
     * and was gone one hop later, with nothing thrown and nothing logged. A test cannot know about a field
     * added tomorrow, but the moment someone adds one to `Circuit` and populates it HERE, the assertions
     * below fail until the clone carries it.
     *
     * So: **adding a field to `Circuit` means adding it to this fixture.**
     */
    function fullCircuit(): any {
      return {
        leds: [{ a: 0, b: 1, flip: true, component: "LED_0603" }],
        battery: { face: 2 },
        resistors: [{ x: 1, y: 2, flip: true }],
        switches: [{ x: 3, y: 4, flip: false }],
        parts: [{ component: "C_1206", x: 5, y: 6, flip: true, free: true, rot: 90 }],
        nets: [{ id: "n1", name: "SDA", color: "#ff8800" }],
        terminals: [{ part: 0, pad: "1", net: "n1" }],
        wires: [{
          id: "w1",
          // Every vertex kind, so a clone that flattens one to a bare point is caught here.
          pts: [
            { kind: "free", x: 0, y: 0 },
            { kind: "pad", part: 0, pad: "1" },
            { kind: "led", led: 0, leg: 1 },
            { kind: "battery", side: "pwr" },
          ],
          net: "n1",
          width: 2,
        }],
      };
    }

    it("hands the store every field it was given, and shares none of them", () => {
      const { modal, edits } = openOn(grid2x2());
      const full = fullCircuit();
      modal.circuit = full;
      modal.emit();

      const sent = edits[edits.length - 1] as any;
      // Every field arrives...
      expect(Object.keys(sent).sort(), "the clone dropped or invented a field").toEqual(
        Object.keys(full).sort(),
      );
      // ...with its value intact...
      expect(sent).toEqual(full);
      // ...and nothing is shared with the modal's own circuit, or an edit here would reach into what the
      // controller already holds.
      for (const key of Object.keys(full)) {
        if (Array.isArray(full[key]) && full[key].length > 0) {
          expect(sent[key], `${key} is the same array`).not.toBe(full[key]);
          expect(sent[key][0], `${key}[0] is the same object`).not.toBe(full[key][0]);
        }
      }
      expect(sent.battery, "battery is the same object").not.toBe(full.battery);
    });

    it("carries a field the clone has never heard of, rather than dropping it", () => {
      // The inversion that makes the trap survivable: `cloneCircuit` deep-copies what it knows by name and
      // spreads the rest, so a field added to the model outlives the trip even before anyone teaches this
      // function about it. It arrives by reference — good enough for a value, and the test above is what
      // says a nested one wants a real copy.
      const { modal, edits } = openOn(grid2x2());
      modal.circuit = { ...fullCircuit(), somethingNobodyHasWrittenYet: 42 };
      modal.emit();

      const sent = edits[edits.length - 1] as any;
      expect(sent.somethingNobodyHasWrittenYet, "an unknown field was silently dropped").toBe(42);
    });
  });

  describe("the toolbar", () => {
    it("draws every set of mutually exclusive choices as one segmented control", () => {
      // A wall of identically-styled buttons said nothing about which were modes, which were actions, and
      // which belonged together. Each set of choices is now one control with dividers -- and this is the
      // guard, because the cheap way to add a tool is to drop another loose button beside the others.
      // Read off the markup rather than the parsed tree: the mock DOM flattens `innerHTML`, so nesting
      // only exists in the string. The segments are not themselves nested, so "inside a segment" is
      // "the nearest tag before me that opens or closes one, opens one".
      const { modal } = openOn(grid2x2());
      const html = modal.overlay.innerHTML as string;
      const inSegment = (at: number): boolean => {
        const opened = html.lastIndexOf('<span class="el-seg">', at);
        const closed = html.lastIndexOf("</span>", at);
        return opened !== -1 && opened > closed;
      };
      for (const cls of ["el-tool", "el-place", "el-view", "el-mirror", "el-auto"]) {
        const found = [...html.matchAll(new RegExp(`class="${cls}"`, "g"))];
        expect(found.length, `no .${cls} buttons at all`).toBeGreaterThan(0);
        for (const m of found) {
          expect(
            inSegment(m.index!),
            `a .${cls} mode button sits loose outside a segmented control`,
          ).toBe(true);
        }
      }
    });

    it("does not label two different groups with the same word", () => {
      // There were briefly two groups both captioned "Place": one for what to place, one for how it sits.
      // A toolbar that says the same word twice about different things is worse than an unlabelled one.
      const { modal } = openOn(grid2x2());
      const labels = modal.overlay.querySelectorAll(".el-group-label")
        .map((l: any) => String(l.textContent).trim())
        .filter((t: string) => t.length > 0);
      expect(new Set(labels).size, `duplicate group captions: ${labels.join(", ")}`).toBe(labels.length);
    });
  });

  describe("when the copper is re-planned", () => {
    /** The grid, with an LED placed so there is copper to go stale. */
    function withCopper(): { modal: any; edits: unknown[] } {
      const got = openOn(grid2x2());
      got.modal.selectTool("battery");
      tapFlat(got.modal, { x: 0.5, y: 0.5 });
      got.modal.selectTool("led");
      tapFlat(got.modal, { x: 1, y: 0.5 });
      return got;
    }

    /** Press one of the toolbar's buttons by class. */
    function press(modal: any, cls: string, i = 0): void {
      modal.overlay.querySelectorAll(`.${cls}`)[i].dispatch("click", {});
    }

    it("re-plans on every edit by default, as it always has", () => {
      const { modal } = withCopper();
      const before = modal.routed.traces.length;
      expect(before).toBeGreaterThan(0);
      modal.selectTool("led");
      tapFlat(modal, { x: 0.5, y: 1 }); // a second hinge
      expect(modal.routed.traces.length).not.toBe(before);
      expect(modal.stale).toBe(false);
    });

    it("leaves the copper alone under Manual, and says the drawing is out of date", () => {
      // The whole point of the control: a full plan is most of a second, and an author placing a dozen
      // parts pays it a dozen times over for plans each following placement throws away. What must NOT
      // happen quietly is the copper on screen ceasing to describe the parts on top of it — so the plan is
      // kept, and the status line and the Route button both say it is stale.
      const { modal } = withCopper();
      const kept = modal.routed;
      press(modal, "el-auto", 1); // Manual
      modal.selectTool("led");
      tapFlat(modal, { x: 0.5, y: 1 });
      expect(modal.circuit.leds).toHaveLength(2); // the edit landed
      expect(modal.routed, "the plan is the one from before the edit").toBe(kept);
      expect(modal.stale).toBe(true);
      expect(modal.statusEl.textContent).toContain("out of date");
      expect(modal.overlay.querySelector(".el-route").classList.contains("is-stale")).toBe(true);
    });

    it("plans on request, without calling that an edit", () => {
      // Route changes no circuit, so nothing is written to the store. An edit emitted here would put an
      // identical circuit through the controller and undo history for a button that authored nothing.
      const { modal, edits } = withCopper();
      press(modal, "el-auto", 1);
      modal.selectTool("led");
      tapFlat(modal, { x: 0.5, y: 1 });
      const n = edits.length;
      press(modal, "el-route");
      expect(modal.stale).toBe(false);
      expect(modal.routed.traces.length).toBeGreaterThan(0);
      expect(edits).toHaveLength(n);
      expect(modal.statusEl.textContent).not.toContain("out of date");
    });

    it("re-plans the moment Auto is turned back on", () => {
      // Otherwise the mode says the copper is live while what is on screen is not, which is the one thing
      // this control exists to make unambiguous.
      const { modal } = withCopper();
      press(modal, "el-auto", 1);
      modal.selectTool("led");
      tapFlat(modal, { x: 0.5, y: 1 });
      expect(modal.stale).toBe(true);
      press(modal, "el-auto", 0); // Auto
      expect(modal.stale).toBe(false);
      expect(modal.autoRoute).toBe(true);
    });

    it("clears the copper on Clear all whatever the mode says", () => {
      // Clear means clear. Left to the Manual rule, the copper for the circuit just thrown away would stay
      // on the canvas with nothing under it to explain it.
      const { modal } = withCopper();
      press(modal, "el-auto", 1);
      press(modal, "el-clear");
      expect(modal.circuit.leds).toEqual([]);
      expect(modal.routed.traces).toEqual([]);
      expect(modal.stale).toBe(false);
    });
  });

  describe("as a page rather than a dialog", () => {
    it("is a region on the page, and claims nothing about the rest of it", () => {
      // `role="dialog" aria-modal="true"` told a screen reader the header and the model behind it did not
      // exist. That was true of a modal and is a lie about a page, which is the whole point of the change.
      const { modal } = openOn(grid2x2());
      const shell = modal.overlay.innerHTML as string;
      expect(modal.overlay.className).toContain("el-page");
      expect(modal.overlay.className, "still an overlay over the app").not.toContain("sim-overlay");
      expect(shell).not.toContain("aria-modal");
      expect(shell).not.toContain('role="dialog"');
      // And there is no dismiss control, because a page is left rather than closed.
      expect(shell).toContain("el-back");
      expect(shell).not.toContain('aria-label="Close"');
    });

    it("takes the model page down while it is up, and gives it back on the way out", () => {
      // Hidden by a class on <body>, never emptied or moved: `installResizableLayout` is bound to #app,
      // and the viewer's iframe reloads to a blank preview the moment it is re-parented.
      const { modal } = openOn(grid2x2());
      const body = (globalThis as any).document.body;
      expect(body.classList.contains("is-electronics")).toBe(true);
      expect(modal.trigger.classList.contains("is-active"), "the nav link does not say where you are").toBe(true);

      modal.close();
      expect(body.classList.contains("is-electronics")).toBe(false);
      expect(modal.trigger.classList.contains("is-active")).toBe(false);
    });

    it("opens at its own URL, and the browser's Back leaves it", () => {
      const loc = { hash: "#/" };
      (globalThis as any).location = loc;
      const { document } = installDom();
      const listeners: (() => void)[] = [];
      (globalThis as any).window = { addEventListener: (_t: string, fn: () => void) => listeners.push(fn) };
      const modal = new ElectronicsModal() as any;
      modal.mountTrigger(document.createElement("div") as unknown as HTMLElement);
      modal.setPattern(grid2x2());

      modal.open();
      expect(loc.hash, "the editor did not put itself in the address bar").toBe("#/electronics");
      expect(modal.overlay.hidden).toBe(false);

      // The browser going back: the hash returns to the model page and `hashchange` fires.
      loc.hash = "#/";
      for (const fn of listeners) fn();
      expect(modal.overlay.hidden, "Back left the editor showing").toBe(true);
      expect((globalThis as any).document.body.classList.contains("is-electronics")).toBe(false);

      // ...and Forward brings it back, without the trigger being clicked again.
      loc.hash = "#/electronics";
      for (const fn of listeners) fn();
      expect(modal.overlay.hidden).toBe(false);

      delete (globalThis as any).location;
    });

    it("starts on the editor when the page is loaded straight at its URL", () => {
      // A pasted or bookmarked #/electronics has to arrive on the editor, not on the model page with the
      // address bar claiming otherwise.
      (globalThis as any).location = { hash: "#/electronics" };
      installDom();
      const modal = new ElectronicsModal() as any;
      expect(modal.overlay.hidden).toBe(false);
      delete (globalThis as any).location;
    });
  });

  it("draws a placed LED immediately, as the footprint that will be cut", () => {
    // It used to be two coloured circles invented here. It is now the library part, drawn through the same
    // `partSvg` every other part goes through, so what is on the canvas is what comes out of the cutter.
    const { modal, edits } = openOn(grid2x2());

    modal.selectTool("led");
    const base = edits.length;
    const gap = modal.gaps[0];
    tapFlat(modal, gap.point);

    expect(edits).toHaveLength(base + 1);
    expect((edits[base] as any).leds).toHaveLength(1);
    // Two real pads, in the PCB palette's copper and mask, inside the board's copper layer.
    expect(modal.svg.innerHTML).toContain('<g id="F.Cu">');
    expect(modal.svg.innerHTML).toContain(PCB_COLOURS.mask);
    expect(modal.drawnParts().map((d: any) => d.component)).toEqual(["LED_1206"]);
    expect(modal.drawnParts()[0].shape.leads).toHaveLength(2);
    // And nothing is left of the bespoke marker it used to be drawn as.
    expect(modal.svg.innerHTML).not.toContain("el-led-pwr");
    expect(modal.svg.innerHTML).not.toContain("el-led-gnd");
    expect(modal.svg.innerHTML).not.toContain("el-led-body");
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
      expect(modal.svg.innerHTML).toContain('<g id="F.Cu">');
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
        // The LED is drawn through the same list now, so pick the resistor out of it rather than
        // assuming it is alone.
        const drawn = modal.drawnParts().filter((d: any) => d.component === "R_1206");
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
      // The parts group is still there — it holds the LED, which is drawn through it too — but the
      // resistor is not in it any more.
      expect(modal.drawnParts().map((d: any) => d.component)).toEqual(["LED_1206"]);
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


    it("stands a part on the sheet where there is no rail, instead of swallowing the click", () => {
      // A rail passes through at most three terminals, so for most of the library the only way to place a
      // part at all is to stand it on the sheet and wire its pads. That click used to do NOTHING -- no part,
      // no message -- which reads as a broken palette rather than as a rule.
      const { modal, edits } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      const before = modal.routed.traces;
      expect(before.length).toBeGreaterThan(0);

      // Right on top of a rail, deliberately. A twenty-six-way socket has no seat to land in whatever it is
      // near: `placement` refuses anything past three terminals, because a rail passes THROUGH a part and
      // there is no meaning to splicing a USB socket into a run of tape. So proximity must not get a vote,
      // and this asserts that by choosing the least favourable point for it.
      const spot = before[0].pts[Math.floor(before[0].pts.length / 2)];
      expect(pointInFace(modal.faces, spot)).toBeGreaterThanOrEqual(0);
      expect(modal.nearestOnRail(spot).dist).toBeLessThan(modal.pickRadius());

      modal.selectPlaceMode("free");
      pick(modal, "Conn_USB_C_Socket_Molex_2171790001");
      tapFlat(modal, spot!);

      const circuit = edits[edits.length - 1] as any;
      expect(circuit.parts).toHaveLength(1);
      expect(circuit.parts[0].free).toBe(true);
      expect(circuit.parts[0].x).toBeCloseTo(spot!.x, 9);
      expect(circuit.parts[0].y).toBeCloseTo(spot!.y, 9);
      // And no copper was cut for it: a free part is not in series with anything.
      expect(modal.routed.traces).toEqual(before);
    });

    it("draws a free part on the canvas, at the size the rail would have given it", () => {
      // The router is not asked about free parts -- it skips them when it cuts rails -- so nothing puts one
      // in `routed.parts`. Placed, stored, exported in the netlist and INVISIBLE is the worst of the
      // available failures: the author drops a socket, sees nothing, and drops another.
      const { modal } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      const before = modal.svg.innerHTML as string;

      modal.selectPlaceMode("free");
      pick(modal, "Conn_USB_C_Socket_Molex_2171790001");
      tapFlat(modal, { x: 1.2, y: 1.2 });
      expect(modal.circuit.parts[0].free).toBe(true);

      // On the canvas, not merely in the circuit.
      expect(modal.svg.innerHTML).not.toBe(before);
      expect(modal.svg.innerHTML).toContain('<g id="F.Cu">');
      // And drawn from its own footprint: 26 terminals means 26 contacts, the count `rowShape` used to
      // flatten to three. This is the two fixes meeting -- free placement is what finally puts a
      // twenty-six-way part on the sheet at all.
      const drawn = modal.routedParts().find((p: any) => p.source === 0);
      expect(drawn).toBeDefined();
      expect(modal.partShapeOf(drawn).leads).toHaveLength(26);
    });

    it("drags a free part to a new place, committing once on release", () => {
      const { modal, edits } = openOn(grid2x2());
      modal.selectPlaceMode("free");
      pick(modal, "Conn_USB_C_Socket_Molex_2171790001");
      tapFlat(modal, { x: 1.2, y: 1.2 });
      const from = { ...modal.circuit.parts[0] };
      const base = edits.length;

      const grab = modal.tp({ x: from.x, y: from.y });
      const drop = modal.tp({ x: from.x + 0.6, y: from.y + 0.4 });
      modal.svg.dispatch("pointerdown", { clientX: grab.x, clientY: grab.y, pointerId: 1, button: 0 });
      modal.svg.dispatch("pointermove", { clientX: drop.x, clientY: drop.y, pointerId: 1 });
      // Mid-drag the part has NOT moved and nothing has been re-planned: a full plan is most of a second,
      // and paying it per pointer-move is the stutter the live layer exists to avoid.
      expect(modal.circuit.parts[0].x).toBeCloseTo(from.x, 9);
      expect(edits.length).toBe(base);
      expect(modal.liveLayer().innerHTML).toContain("el-part-ghost");

      modal.svg.dispatch("pointerup", { clientX: drop.x, clientY: drop.y, pointerId: 1 });
      expect(modal.circuit.parts[0].x).toBeCloseTo(from.x + 0.6, 6);
      expect(modal.circuit.parts[0].y).toBeCloseTo(from.y + 0.4, 6);
      expect(edits.length).toBe(base + 1); // once, on release
      expect(modal.circuit.parts[0].free).toBe(true);
    });

    it("does not drag a SEATED part, whose place belongs to the run it breaks", () => {
      // A seated part is held by the copper: the router cut a gap for it at a point on a rail, and moving
      // the drawing without re-cutting would show it somewhere the break is not. Dropping it again is how
      // you move one, because that re-plans the break too. Only free parts -- which no copper is cut for --
      // move under the cursor.
      const { modal } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      const run = modal.routed.traces[0];
      const on = run.pts[Math.floor(run.pts.length / 2)];
      modal.selectPlaceMode("free");
      pick(modal, "R_1206");
      tapFlat(modal, on);
      expect(modal.circuit.parts[0].free).toBeUndefined(); // seated, not free
      const was = { ...modal.circuit.parts[0] };

      const grab = modal.tp({ x: was.x, y: was.y });
      modal.svg.dispatch("pointerdown", { clientX: grab.x, clientY: grab.y, pointerId: 1, button: 0 });
      modal.svg.dispatch("pointermove", { clientX: grab.x + 40, clientY: grab.y + 30, pointerId: 1 });
      modal.svg.dispatch("pointerup", { clientX: grab.x + 40, clientY: grab.y + 30, pointerId: 1 });

      expect(modal.circuit.parts[0].x).toBeCloseTo(was.x, 9);
      expect(modal.circuit.parts[0].y).toBeCloseTo(was.y, 9);
    });

    it("still pans when the drag started away from any part", () => {
      // The part grab is tested BEFORE `this.pan` is armed, so it is placed where it could swallow a pan.
      const { modal } = openOn(grid2x2());
      modal.selectPlaceMode("free");
      pick(modal, "Conn_USB_C_Socket_Molex_2171790001");
      tapFlat(modal, { x: 1.2, y: 1.2 });
      const before = { ...modal.view };

      const away = modal.tp({ x: 40, y: 40 });
      modal.svg.dispatch("pointerdown", { clientX: away.x, clientY: away.y, pointerId: 1, button: 0 });
      modal.svg.dispatch("pointermove", { clientX: away.x + 60, clientY: away.y + 40, pointerId: 1 });
      modal.svg.dispatch("pointerup", { clientX: away.x + 60, clientY: away.y + 40, pointerId: 1 });
      expect(modal.view).not.toEqual(before);
      expect(modal.circuit.parts[0].x).toBeCloseTo(1.2, 9); // and moved nothing
    });

    it("turns a free part a quarter at a time, and all the way back round", () => {
      // A seated part FLIPS -- its angle belongs to the run it breaks. A free part has no run, so R turns it.
      const { modal } = openOn(grid2x2());
      modal.selectPlaceMode("free");
      pick(modal, "Conn_USB_C_Socket_Molex_2171790001");
      tapFlat(modal, { x: 1.2, y: 1.2 });
      expect(modal.circuit.parts[0].rot).toBeUndefined();

      const press = () => (globalThis as any).document.dispatch("keydown", { key: "r" });
      press();
      expect(modal.circuit.parts[0].rot).toBe(90);
      press(); press();
      expect(modal.circuit.parts[0].rot).toBe(270);
      press();
      expect(modal.circuit.parts[0].rot).toBe(0); // round, not 360
      // And the turn reaches the drawing, not just the circuit.
      modal.circuit = { ...modal.circuit, parts: [{ ...modal.circuit.parts[0], rot: 90 }] };
      const turned = modal.routedParts().find((p: any) => p.source === 0);
      expect(Math.abs(turned.b.x - turned.a.x)).toBeLessThan(Math.abs(turned.b.y - turned.a.y));
    });

    it("puts an LED on a tile when asked to, instead of always bridging a fold", () => {
      // An LED bridging a hinge was a rule about the PART. It is now a rule about the MODE, and the same
      // choice is offered for every component. On a tile the LED gets no `Led` entry at all, so the router
      // never bridges it and never decides which leg is positive -- the author wires both pads.
      const { modal } = openOn(grid2x2());
      modal.selectTool("led");
      modal.selectPlaceMode("free");
      tapFlat(modal, { x: 1.2, y: 1.2 });

      expect(modal.circuit.leds).toHaveLength(0);
      expect(modal.circuit.parts).toHaveLength(1);
      expect(modal.circuit.parts[0].free).toBe(true);
      expect(modal.circuit.parts[0].component).toMatch(/^LED_/);
      expect(modal.circuit.parts[0].x).toBeCloseTo(1.2, 9);
    });

    it("still bridges a fold with an LED in gap mode, exactly as it always did", () => {
      // The default is unchanged, and this is the assertion that says so: adding the choice must not have
      // quietly moved where an LED goes when nobody asks for anything different.
      const { modal } = openOn(grid2x2());
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      expect(modal.circuit.leds).toHaveLength(1);
      expect(modal.circuit.parts ?? []).toHaveLength(0);
    });

    it("stands a part across a fold in gap mode, turned to cross the hinge", () => {
      // The other direction, and the one that had no way of being asked for at all: a two-pad chip has as
      // much reason to bridge a fold as an LED does.
      const { modal } = openOn(grid2x2());
      const g = modal.gaps[0];
      pick(modal, "C_1206");
      tapFlat(modal, g.point);

      const part = modal.circuit.parts[0];
      expect(part.free).toBe(true);          // no rail is cut for it
      expect(part.rot).toBeDefined();
      // On the hinge, and ACROSS it: the part's own axis is perpendicular to the fold, or both pads would
      // land on the same tile and it would bridge nothing.
      const [p, q] = g.ends;
      expect(part.x).toBeCloseTo((p.x + q.x) / 2, 9);
      expect(part.y).toBeCloseTo((p.y + q.y) / 2, 9);
      const drawn = modal.routedParts().find((r: any) => r.source === 0);
      const along = { x: drawn.b.x - drawn.a.x, y: drawn.b.y - drawn.a.y };
      const hinge = { x: q.x - p.x, y: q.y - p.y };
      const dot = (along.x * hinge.x + along.y * hinge.y)
        / (Math.hypot(along.x, along.y) * Math.hypot(hinge.x, hinge.y));
      expect(Math.abs(dot)).toBeLessThan(1e-6); // perpendicular
    });

    it("drops nothing in the margin, where there is no sheet to stick a part to", () => {
      const { modal, edits } = openOn(grid2x2());
      const outside = { x: 40, y: 40 };
      expect(pointInFace(modal.faces, outside)).toBe(-1);
      const base = edits.length;
      modal.selectPlaceMode("free");
      pick(modal, "Conn_USB_C_Socket_Molex_2171790001");
      tapFlat(modal, outside);
      expect(edits.length).toBe(base);
    });

    it("offers every part in the library it can wire, and grows without a button each", () => {
      // The rule changed under this test and the test is the record of it. A rail can only pass THROUGH a
      // part with two or three terminals, so the palette used to offer 37 of 129 and file the rest under
      // "not in series on a rail". With nets a part is a set of pads to wire, not something a rail passes
      // through, so a USB socket is as placeable as a resistor and the only requirement left is a
      // terminal to wire. Stated as the rule, never as a count -- the count has already rotted once.
      const { modal } = openOn(grid2x2());
      const offered = modal.overlay.querySelector(".el-part")
        .querySelectorAll("option").map((o: any) => o.value);
      const wirable = LIBRARY.filter((c) => netPlacement(c.footprint).placeable && !FIXED.has(c.id));
      expect(offered.sort()).toEqual(wirable.map((c) => c.id).sort());
      // Including the parts that were refused before...
      for (const id of ["R_1206", "C_1206", "SW_SPDT"]) expect(offered).toContain(id);
      expect(offered.some((id: string) => /USB_C/.test(id)), "no USB socket on offer").toBe(true);
      // ...**including the LEDs, since 2026-08-28.** They were held back so the LED tool would be "the only
      // way to place one", on the reasoning that an LED in the palette would end up along a rail with both
      // pads on one net. That is a guess about the author's circuit enforced by hiding the part: an LED has
      // two pads to wire like anything else, and the pads panel has always been able to wire them. The LED
      // tool still places one across a hinge, where the bus router lays the rails to it.
      for (const id of ["LED_1206", "LED_0603"]) expect(offered).toContain(id);
      // The battery is still the one fixed part: it pins to a face rather than going on a rail.
      expect(offered).not.toContain("BAT_COIN_20");
      // One control for the library, not one button per part. Stated as the rule and not as a count of
      // the toolbar, for the reason given above: the count has rotted twice now, most recently when the
      // wire tool arrived — a button that places no part at all, and so no evidence either way.
      const tools = modal.overlay.querySelectorAll(".el-tool").map((b: any) => b.dataset.tool);
      expect(tools.filter((t: string) => offered.includes(t))).toEqual([]);
    });

    /** The parts the two fixed tools place, which the library picker therefore never offers. */
    // Only the battery now: LEDs came onto the palette on 2026-08-28 and are ordinary parts.
    const FIXED = new Set(["BAT_COIN_20"]);

    /** The LIBRARY picker's rows, as a browser would read them: what each offers, whether selectable. */
    function rows(modal: any): { value: string; text: string; disabled: boolean }[] {
      return modal.overlay.querySelector(".el-part").querySelectorAll("option").map((o: any) => ({
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
      const groups = modal.overlay.querySelector(".el-part").querySelectorAll("optgroup");
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
      modal.selectPlaceMode("free");
      pick(modal, "C_1206");
      search(modal, "resistor");
      expect(modal.tool, "typing re-armed the tool").toBe("C_1206");
      expect(rows(modal).map((r) => r.value)).toContain("C_1206");
      expect(modal.overlay.querySelector(".el-part").value).toBe("C_1206");
    });

    it("has the whole library the moment it opens, without fetching a second half", async () => {
      // The library used to arrive in two halves, the second fetched on first open, and the picker merged
      // it in when it landed. The split is gone -- `library.ts` joins them statically -- because only the
      // palette ever merged the halves: the router, the cut files and the netlist all resolved against the
      // eager half alone, so a part from the other one could be placed and then fail to resolve everywhere
      // that mattered. What is left to test is that nothing has to be waited for.
      const { modal } = openOn(grid2x2());
      const before = rows(modal).length;
      const usb = LIBRARY.find((c) => /USB_C/.test(c.id))!;
      expect(usb, "the library has no USB-C part to look for").toBeTruthy();

      search(modal, usb.id.toLowerCase());
      const row = rows(modal).find((r) => r.text.includes(usb.id));
      expect(row, `${usb.id} is in the library but the picker never heard of it`).toBeTruthy();
      expect(row!.disabled, "a wirable part was offered greyed out").toBe(false);

      // ...and awaiting the old fetch changes nothing, because there is nothing to fetch.
      search(modal, "");
      await modal.libraryReady;
      expect(rows(modal)).toHaveLength(before);
    });

    it("needs no redraw for a library half, because there is no second half", async () => {
      // This used to assert the picker was rebuilt when the fetched half landed -- it knew the eager half
      // first, and the count line went on claiming that half was the whole library until the redraw. With
      // `library.ts` there is one library from the first paint, so what is left to guard is that the count
      // is honest immediately rather than after an await.
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
      expect(before, "the count changed once the old fetch settled").toBe(count.textContent);
      expect(before).not.toContain("search to see");
    });

    it("arms a part that used to be refused, and places it", () => {
      // The USB socket was the standing example of a part in the library and not on offer: four pads, and
      // a rail cannot pass through it. With nets it is four pads to wire, so it is offered like anything
      // else -- and the test that used to assert it was greyed out now asserts it works.
      const { modal, at } = withRails();
      const usb = LIBRARY.find((c) => /USB_C/.test(c.id))!;
      pick(modal, usb.id);
      expect(modal.tool).toBe(usb.id);

      tapFlat(modal, at);
      expect(modal.circuit.parts.map((p: any) => p.component)).toEqual([usb.id]);
    });

    it("will not arm a tool on a part the palette does not offer", () => {
      // Nothing in the library is refused any more -- every one of the 129 has a terminal to wire -- but
      // the guard still has work to do: the fixed tools' own parts are not on the palette, and the canvas
      // must never be left armed with a tool that places nothing.
      const { modal } = openOn(grid2x2());
      modal.selectPlaceMode("free");
      pick(modal, "C_1206");
      const select = modal.overlay.querySelector(".el-part");
      // The battery, not an LED: LEDs joined the palette on 2026-08-28 and arming one is now legitimate.
      select.value = "BAT_COIN_20"; // placed by the battery tool, never by the library picker
      select.dispatch("change", {});
      expect(modal.tool).toBe("C_1206");
    });

    it("says how many parts are on offer, and counts the hits while searching", () => {
      // The line existed to say that most of the library was NOT on offer. Now everything with a terminal
      // is, so it has only the good news left: how many there are.
      //
      // **Shortened 2026-08-28.** It used to carry `— search by name or package` too, which made it a
      // sentence that needed a line of its own under the picker and cost the toolbar a row's height. The
      // hint is the search box's placeholder now, so it is beside the field it is a hint about.
      const { modal } = openOn(grid2x2());
      const count = modal.overlay.querySelector(".el-part-count");
      expect(count.textContent).toBe(`${rows(modal).length} parts`);
      expect(modal.overlay.querySelector(".el-part-search").getAttribute("placeholder"))
        .toBe("Search by name or package");

      search(modal, "resistor");
      expect(count.textContent).toContain(`${rows(modal).length} match`);
    });

    /** The library menu's shelves, as a reader sees them: heading, tally, and whether it is open. */
    function shelves(modal: any): { label: string; open: boolean; rows: string[] }[] {
      return modal.overlay.querySelectorAll(".el-part-shelf").map((sh: any) => {
        const head = sh.children.find((c: any) => c.className.includes("el-part-shelf-head"));
        const body = sh.children.find((c: any) => c.className.includes("el-part-shelf-body"));
        return {
          label: head.textContent,
          open: head.getAttribute("aria-expanded") === "true",
          rows: body.children.map((r: any) => r.dataset.id ?? r.textContent),
        };
      });
    }

    /** Click a shelf heading by its label, the way a reader opens one. */
    function openShelf(modal: any, label: string): void {
      const head = modal.overlay.querySelectorAll(".el-part-shelf-head")
        .find((h: any) => h.textContent === label);
      expect(head, `no shelf called ${label}`).toBeTruthy();
      head.dispatch("click", {});
    }

    it("shows the library as shelves that are shut until they are asked for", async () => {
      // The native select opened as one flat scroll of every offered part, with the group names as
      // dividers you cannot click -- so finding a capacitor meant reading the whole library. The menu is
      // built in JS for exactly this: a shut shelf is one line and a count.
      const { modal } = openOn(grid2x2());
      await modal.libraryReady;
      const shut = shelves(modal);
      expect(shut.length, "no shelves at all").toBeGreaterThan(1);
      // Every shelf carries its own tally, so its one line says how much is behind it.
      for (const sh of shut) expect(sh.rows.length).toBeGreaterThan(0);
      // ...and all of them are shut, bar the one holding whatever is armed.
      const armed = modal.tool;
      const openOnes = shut.filter((sh) => sh.open);
      expect(openOnes.length, "more than the armed part's shelf was open").toBeLessThanOrEqual(1);
      if (openOnes.length === 1) expect(openOnes[0]!.rows).toContain(armed);
    });

    it("opens a shelf on a click and shuts it on the next one", async () => {
      const { modal } = openOn(grid2x2());
      await modal.libraryReady;
      const before = shelves(modal).find((sh) => sh.label.startsWith("Capacitors"))!;
      expect(before.open, "Capacitors was already open").toBe(false);

      openShelf(modal, before.label);
      const opened = shelves(modal).find((sh) => sh.label.startsWith("Capacitors"))!;
      expect(opened.open).toBe(true);
      expect(opened.rows).toContain("C_1206");

      openShelf(modal, before.label);
      expect(shelves(modal).find((sh) => sh.label.startsWith("Capacitors"))!.open).toBe(false);
    });

    it("arms the part on the row that was clicked, and puts the menu away", async () => {
      const { modal } = openOn(grid2x2());
      await modal.libraryReady;
      modal.overlay.querySelector(".el-part-trigger").dispatch("click", {});
      expect(modal.menuOpen).toBe(true);

      const capacitors = shelves(modal).find((sh) => sh.label.startsWith("Capacitors"))!;
      openShelf(modal, capacitors.label);
      const row = modal.overlay.querySelectorAll(".el-part-row")
        .find((r: any) => r.dataset.id === "C_1206");
      row.dispatch("click", {});

      expect(modal.tool, "the clicked row did not arm its part").toBe("C_1206");
      expect(modal.menuOpen, "choosing a part left the menu up").toBe(false);
      // The trigger says what is armed, so the shut menu still answers "which part am I placing?".
      expect(modal.overlay.querySelector(".el-part-trigger").textContent).toContain("C_1206");
    });

    it("opens the shelves a search matches, rather than making them be hunted for", async () => {
      const { modal } = openOn(grid2x2());
      await modal.libraryReady;
      search(modal, "capacitor");

      expect(modal.menuOpen, "typing did not bring the list out").toBe(true);
      const found = shelves(modal);
      expect(found.length).toBeGreaterThan(0);
      for (const sh of found) expect(sh.open, `${sh.label} stayed shut while searching`).toBe(true);
      // And clearing the box shuts them again, bar the armed part's own.
      search(modal, "");
      expect(shelves(modal).filter((sh) => sh.open).length).toBeLessThanOrEqual(1);
    });

    it("closes the menu on Escape, and leaves the page where it is", async () => {
      // Escape used to close the editor once the menu was away, which was right for a dialog and is wrong
      // for a page: a page is not dismissible, and a stray Escape wiping out the view you navigated to is
      // how work gets lost. Back is the way out now.
      const { modal } = openOn(grid2x2());
      await modal.libraryReady;
      modal.overlay.querySelector(".el-part-trigger").dispatch("click", {});
      expect(modal.menuOpen).toBe(true);

      (globalThis as any).document.dispatch("keydown", { key: "Escape" });
      expect(modal.menuOpen, "Escape left the menu up").toBe(false);
      expect(modal.overlay.hidden, "Escape threw the whole editor away with the menu").toBe(false);

      (globalThis as any).document.dispatch("keydown", { key: "Escape" });
      expect(modal.overlay.hidden, "a second Escape closed the page -- a page is not dismissible").toBe(false);

      // The Back control is what leaves, and it takes the model page's body class back with it.
      modal.overlay.querySelector(".el-back").dispatch("click", {});
      expect(modal.overlay.hidden).toBe(true);
      expect((globalThis as any).document.body.classList.contains("is-electronics")).toBe(false);
    });

    it("places the picked part on the nearest rail, snapped to the copper, and draws it", () => {
      const { modal, edits, at } = withRails();
      modal.selectPlaceMode("free");
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
      // Measured as a distance, not on x alone. The rail the click snaps to here runs very nearly
      // straight up the sheet, so the snap moves the point in y and leaves x where it was — on x alone
      // this read as "the click was not snapped" the moment the router's geometry shifted.
      const moved = Math.hypot(modal.circuit.parts[0].x - off.x, modal.circuit.parts[0].y - off.y);
      expect(moved, "stored the raw click, not the snap").toBeGreaterThan(1e-9);
      // And it is on screen, not merely in the circuit: nothing else re-renders the modal.
      expect(modal.svg.innerHTML).toContain('<g id="F.Cu">');
      expect(modal.svg.innerHTML).toContain(PCB_COLOURS.mask);
    });

    it("carries the placed parts through to the controller", () => {
      // `cloneCircuit` has silently dropped a newly added field before, and the symptom is nasty: the part
      // draws on the canvas and vanishes the moment the circuit reaches the store.
      const { modal, edits, at } = withRails();
      modal.selectPlaceMode("free");
      pick(modal, "R_2010");
      tapFlat(modal, at);

      const sent = edits[edits.length - 1] as any;
      expect(sent.parts).toEqual(modal.circuit.parts);
      expect(sent.parts, "the clone shares the array with the modal's own circuit").not.toBe(modal.circuit.parts);
      expect(sent.parts[0], "the clone shares a part object").not.toBe(modal.circuit.parts[0]);
      // `rot` is part of that guarantee now: a seated part carries the angle of the run it landed on, chosen
      // once at drop time (`electronics-parts.ts › placementOf`). Dropping it in the clone would put the part
      // back to routing unrotated while being drawn along its run — 2.59mm to 3.54mm out on the bundled
      // patterns, a whole pad pitch on an R_1206.
      expect(sent.parts[0]).toEqual({
        component: "R_2010", x: expect.any(Number), y: expect.any(Number), rot: expect.any(Number),
      });
    });

    it("selects a placed part when it is tapped again, and removes it on Delete", () => {
      const { modal, at } = withRails();
      modal.selectPlaceMode("free");
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
      expect(modal.drawnParts().map((d: any) => d.component)).toEqual(["LED_1206"]);
    });

    it("places several of the same part on one rail, and routes every one of them", () => {
      // The point of the whole exercise: more than one capacitor. Each tap used to land inside the target
      // of the part already there -- a target sized to the pattern rather than to the part -- so the second
      // tap deleted the first and the circuit never held two of anything.
      const { modal } = withRails();
      modal.selectPlaceMode("free");
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
      expect(modal.drawnParts().filter((d: any) => d.component === "C_1206")).toHaveLength(3);
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
      // Not across a fold: this test is about a RAIL running out of room, so every part here has to be
      // going onto the rail. In gap mode they would stand on hinges instead and the rail would stay empty.
      modal.selectPlaceMode("free");
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
      modal.selectPlaceMode("free");
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

    it("puts a picked part down on the next tap instead of dropping another copy", () => {
      // The bug: placing is armed all the time, so tapping a part to read its pads and then tapping away
      // -- the obvious way to stop looking at it -- placed a second one of whatever the palette held.
      const { modal } = withRails();
      modal.selectPlaceMode("free");
      pick(modal, "C_1206");
      const run = modal.routed.traces.find((t: any) => t.net === "pwr");
      tapFlat(modal, alongRun(run, 0.25));
      expect(modal.circuit.parts).toHaveLength(1);

      tapFlat(modal, modal.circuit.parts[0]); // pick it up
      expect(modal.selected).toEqual({ kind: "part", index: 0 });

      tapFlat(modal, alongRun(run, 0.75)); // and tap away
      expect(modal.circuit.parts, "the tap that deselects placed a part").toHaveLength(1);
      expect(modal.selected).toBeNull();

      // The tap after that places as usual -- the rule is one tap swallowed, not a disarmed palette.
      tapFlat(modal, alongRun(run, 0.75));
      expect(modal.circuit.parts).toHaveLength(2);
    });

    it("keeps placing on tap after tap, because placing does not count as picking one up", () => {
      // The other half: a selection the author MADE by placing must not swallow anything, or laying a row
      // of parts out would cost two taps each.
      const { modal } = withRails();
      modal.selectPlaceMode("free");
      pick(modal, "C_1206");
      const run = modal.routed.traces.find((t: any) => t.net === "pwr");
      for (const u of [0.2, 0.5, 0.8]) tapFlat(modal, alongRun(run, u));
      expect(modal.circuit.parts).toHaveLength(3);
    });

    it("turns a selected part round on R, and hands the choice back on a second press", () => {
      // A switch is a part the rail steps ACROSS, so which way round it sits decides which side its idle
      // throw is stranded on. The router picks one; R overrules it, and R again gives the decision back.
      const { modal } = withRails();
      modal.selectPlaceMode("free");
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
      modal.selectPlaceMode("free");
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

    /** Declare a net through the bar, the way the author does. */
    function addNet(modal: any, name: string): void {
      const box = modal.overlay.querySelector(".el-net-new");
      box.value = name;
      modal.overlay.querySelector(".el-net-add").dispatch("click", {});
    }

    /** The net chips, as they read: name, and how many pads are on each. */
    function netChips(modal: any): { name: string; count: string }[] {
      return modal.overlay.querySelectorAll(".el-net").map((chip: any) => ({
        name: chip.children.find((c: any) => c.className.includes("el-net-name")).value,
        count: chip.children.find((c: any) => c.className.includes("el-net-count")).textContent,
      }));
    }

    /** Put a placed part's pad on a net, through the pad panel — by typing the name, as the author does. */
    function wirePad(modal: any, pad: string, netName: string): void {
      const box = modal.overlay.querySelectorAll(".el-pad-net").find((p: any) => p.dataset.pad === pad);
      expect(box, `no pad row called ${pad}`).toBeTruthy();
      box.value = netName;
      box.dispatch("change", {});
    }

    /** Place one library part on the rail and select it, so its pads are on offer. */
    function placeAndSelect(modal: any, id: string, at: { x: number; y: number }): void {
      pick(modal, id);
      tapFlat(modal, at);
      const placed = modal.circuit.parts[modal.circuit.parts.length - 1];
      tapFlat(modal, placed); // a tap on a placed part selects it
    }

    /** Two spots that hold two distinct, free-standing parts.
     *
     *  Two hinges, not two points on a tile: on a pattern this small `pickRadius` floors at 2 units --
     *  wider than the whole sheet -- so a part put down anywhere in free mode seats itself in the nearest
     *  rail, and a seated part cannot be dragged. Distinct gaps also keep the two parts off each other,
     *  which matters because the hit test can only ever find the lower of two parts on the same point.
     *  Gap 0 is where `withRails` put its LED. */
    function spots(modal: any): { x: number; y: number }[] {
      expect(modal.gaps.length, "this pattern has too few hinges to hold two parts apart").toBeGreaterThan(2);
      return [modal.gaps[1].point, modal.gaps[2].point];
    }

    /** The parts list, as it reads: designator, and how many of its pads are on a net. */
    function partRows(modal: any): { tag: string; wired: string; active: boolean }[] {
      return modal.overlay.querySelectorAll(".el-placed-row").map((row: any) => ({
        tag: row.children.find((c: any) => c.className.includes("el-placed-tag")).textContent,
        wired: row.children.find((c: any) => c.className.includes("el-placed-wired")).textContent,
        active: row.classList.contains("is-active"),
      }));
    }

    describe("what the router could not do", () => {
      it("says so when a net has only one pad on it, the commonest authoring slip", () => {
        // `resolveNetlist` has always reported this -- a net with one terminal has nothing to connect to,
        // so it is dropped from the routing set -- and `netFaults` was carried all the way out to the view
        // and read by nothing. Wiring one pad and forgetting the other looked exactly like success.
        const { modal, at } = withRails();
        addNet(modal, "SIG");
        placeAndSelect(modal, "C_1206", at);
        wirePad(modal, "1", "SIG");

        expect(modal.routed.netFaults.map((f: any) => f.kind)).toContain("single-terminal-net");
        expect(modal.statusEl.textContent).toContain("netlist fault");
        expect(modal.statusEl.textContent).toContain("only one terminal");
      });

      it("marks the net the router could not finish, with the count and the reason", () => {
        // Driven from a router result rather than from a geometry that happens to strand: what is under
        // test is that the panel reads `stranded` and `why` at all, and a fixture that strands today can
        // stop stranding for reasons that have nothing to do with this panel.
        const { modal } = withRails();
        addNet(modal, "SIG");
        const id = modal.circuit.nets.find((n: any) => n.name === "SIG").id;
        modal.routed = {
          ...modal.routed,
          nets: [{ id, name: "SIG", traces: [], stranded: [1, 2], why: "two of three terminals on \"SIG\" could not be reached" }],
        };
        modal.renderNets();
        modal.renderStatus();

        const row = modal.overlay.querySelectorAll(".el-net")
          .find((r: any) => r.children.some((c: any) => c.className.includes("el-net-name") && c.value === "SIG"));
        const mark = row.children.find((c: any) => c.className.includes("el-net-short"));
        expect(mark, "the net the router gave up on is not marked").toBeTruthy();
        expect(mark.textContent).toBe("2");
        expect(mark.title).toContain("could not be reached");
        expect(modal.statusEl.textContent).toContain("2 terminals could not be reached");
      });

      it("does not greet a fresh pattern with faults it did not cause", () => {
        // A circuit is seeded with PWR and GND, and an unwired net resolves as "fewer than two terminals"
        // exactly as a half-wired one does. Reporting that would put two faults on every new pattern
        // before the author had touched anything -- which teaches them to ignore the line entirely.
        const { modal } = withRails();
        expect(modal.circuit.nets.length).toBeGreaterThan(0);
        expect(modal.statusEl.textContent).not.toContain("netlist fault");
      });

      it("leaves a net alone when the router finished it", () => {
        const { modal } = withRails();
        addNet(modal, "SIG");
        const id = modal.circuit.nets.find((n: any) => n.name === "SIG").id;
        modal.routed = { ...modal.routed, nets: [{ id, name: "SIG", traces: [], stranded: [] }] };
        modal.renderNets();
        expect(modal.overlay.querySelectorAll(".el-net-short")).toHaveLength(0);
      });
    });

    describe("the parts list", () => {
      it("keeps the first part reachable, and its wiring readable, once a second is placed", () => {
        // The reported defect: "the first added component disappears". Nothing was lost from the model --
        // this asserts through the SIDEBAR, because the pads panel shows the SELECTED part alone and
        // placing a part selects it. A test on `circuit.terminals` passes against the bug.
        const { modal, at } = withRails();
        addNet(modal, "SIG");
        const [a, b] = spots(modal);
        placeAndSelect(modal, "C_1206", a!);
        wirePad(modal, "1", "SIG");
        // Kept as a check that the net really was declared — the box below reads back the NAME, which is
        // the whole point of typing it, but the id is what `Terminal.net` holds.
        expect(modal.circuit.nets.find((n: any) => n.name === "SIG")).toBeTruthy();

        placeAndSelect(modal, "R_1206", b!);
        expect(partRows(modal)).toHaveLength(2);

        // Back to the first part from the list alone -- no hunting for it on the canvas.
        modal.overlay.querySelectorAll(".el-placed-row")[0].dispatch("click", {});
        expect(modal.selected).toEqual({ kind: "part", index: 0 });
        expect(modal.overlay.querySelector(".el-pad-part").textContent).toContain("C_1206");
        const pick = modal.overlay.querySelectorAll(".el-pad-net").find((p: any) => p.dataset.pad === "1");
        expect(pick.value, "the first part's assignment is not readable again").toBe("SIG");
      });

      it("says how many of each part's pads are on a net, and marks one with none", () => {
        const { modal, at } = withRails();
        addNet(modal, "SIG");
        placeAndSelect(modal, "SW_SPDT", at); // three terminals, none defaulted
        expect(partRows(modal)[0]!.wired).toBe("0/3");

        wirePad(modal, "1", "SIG");
        expect(partRows(modal)[0]!.wired).toBe("1/3");
      });

      it("marks the selected row, and follows the canvas selection", () => {
        const { modal, at } = withRails();
        const [a, b] = spots(modal);
        placeAndSelect(modal, "C_1206", a!);
        placeAndSelect(modal, "R_1206", b!);
        expect(partRows(modal).map((r) => r.active)).toEqual([false, true]);

        tapFlat(modal, modal.circuit.parts[0]); // picked up on the canvas instead
        expect(partRows(modal).map((r) => r.active)).toEqual([true, false]);
      });

      it("follows a part picked up on the canvas, from the press rather than the click", () => {
        // Pressing a free part starts a drag and selects it there and then. A press that never moves
        // commits nothing, so if the sidebar waited for the click it would show the previous part for the
        // whole gesture -- and for a tap, for good.
        const { modal, at } = withRails();
        const [a, b] = spots(modal);
        placeAndSelect(modal, "C_1206", a!);
        placeAndSelect(modal, "R_1206", b!);
        const p0 = modal.circuit.parts[0];
        expect(p0.free, "the part was seated in a rail, so pressing it starts no drag").toBe(true);
        const { x: clientX, y: clientY } = modal.tp(p0);
        modal.svg.dispatch("pointerdown", { button: 0, clientX, clientY, pointerId: 1 });
        expect(partRows(modal).map((r) => r.active)).toEqual([true, false]);
        expect(modal.overlay.querySelector(".el-pad-part").textContent).toContain("C_1206");
      });

      it("empties itself when a new pattern is loaded under it", () => {
        // The circuit is reset with the pattern; a list left painted names parts that are gone, and the
        // pads panel offers the pads of one of them.
        const { modal, at } = withRails();
        placeAndSelect(modal, "C_1206", at);
        expect(partRows(modal)).toHaveLength(1);
        modal.setPattern(grid2x2());
        expect(partRows(modal)).toHaveLength(0);
        expect(modal.overlay.querySelector(".el-placed").hidden).toBe(true);
        expect(modal.overlay.querySelector(".el-pads").hidden).toBe(true);
      });

      it("is not shown at all until something is placed", () => {
        const { modal, at } = withRails();
        expect(modal.overlay.querySelector(".el-placed").hidden).toBe(true);
        placeAndSelect(modal, "C_1206", at);
        expect(modal.overlay.querySelector(".el-placed").hidden).toBe(false);
      });
    });

    describe("nets", () => {
      it("declares a net, and refuses a name already in use", () => {
        const { modal } = withRails();
        addNet(modal, "PWR");
        addNet(modal, "GND");
        expect(netChips(modal).map((n) => n.name)).toEqual(["PWR", "GND"]);

        addNet(modal, "pwr"); // same name, different case -- a typo, not a design
        expect(netChips(modal)).toHaveLength(2);
        expect(modal.statusEl.textContent).toContain("already a net called pwr");
      });

      it("keeps a net's id when it is renamed, so the pads on it stay wired", () => {
        // The id is what `Terminal.net` points at. A rename that minted a new one would unwire every pad
        // on the net and report nothing -- the netlist would still resolve, against a net nobody is on.
        const { modal, at } = withRails();
        addNet(modal, "PWR");
        const id = modal.circuit.nets[0].id;
        placeAndSelect(modal, "C_1206", at);
        wirePad(modal, "1", "PWR");
        expect(modal.circuit.terminals).toEqual([{ part: 0, pad: "1", net: id }]);

        const box = modal.overlay.querySelector(".el-net-name");
        box.value = "VCC";
        box.dispatch("change", {});

        // Fields, not the whole object: a net also carries an authored `color`, and asserting the shape
        // would fail every time the model gains a field rather than when the rename breaks.
        expect(modal.circuit.nets[0].id).toBe(id);
        expect(modal.circuit.nets[0].name).toBe("VCC");
        expect(modal.circuit.terminals, "the rename unwired the pad").toEqual([
          { part: 0, pad: "1", net: id },
        ]);
      });

      it("unwires the pads on a net when the net is deleted", () => {
        const { modal, at } = withRails();
        addNet(modal, "PWR");
        placeAndSelect(modal, "C_1206", at);
        wirePad(modal, "1", "PWR");
        expect(modal.circuit.terminals).toHaveLength(1);

        const before = modal.circuit.nets.length;
        const doomed = modal.circuit.nets.find((n: any) => n.name === "PWR").id;
        modal.overlay.querySelectorAll(".el-net-del")[
          modal.circuit.nets.findIndex((n: any) => n.id === doomed)
        ].dispatch("click", {});

        // One fewer net, and it is that one. A circuit is seeded with the battery's own PWR and GND, so
        // "no nets left" was never the right assertion -- it only passed before those existed.
        expect(modal.circuit.nets).toHaveLength(before - 1);
        expect(modal.circuit.nets.map((n: any) => n.id)).not.toContain(doomed);
        expect(modal.circuit.terminals, "a terminal was left pointing at a deleted net").toHaveLength(0);
        expect(modal.statusEl.textContent).toContain("unwired 1 pad");
      });

      it("offers a part's terminals by name, and not its mounting pegs", () => {
        // The pad names come from `terminals(fp)`, the same reading the router and the renderer use. The
        // slide switch's two locating pegs are plated copper and are not terminals; offered here they
        // would be wireable to a net that then routes to a hole.
        const { modal, at } = withRails();
        addNet(modal, "PWR");
        placeAndSelect(modal, "SW_SPDT", at);
        const offered = modal.overlay.querySelectorAll(".el-pad-net").map((p: any) => p.dataset.pad);
        expect(offered).toEqual(terminals(SW_SPDT).map(([name]) => name));
        expect(offered).toHaveLength(3); // the three throws, not the five copper pads
      });

      it("shows the pad panel only for a part that has pads to wire", () => {
        const { modal, at } = withRails();
        addNet(modal, "PWR");
        // An LED straddles a hinge and its polarity is the router's -- there is nothing here to assign.
        tapFlat(modal, modal.gaps[0].point);
        expect(modal.selected.kind).toBe("led");
        expect(modal.overlay.querySelector(".el-pads").hidden).toBe(true);

        placeAndSelect(modal, "C_1206", at);
        expect(modal.overlay.querySelector(".el-pads").hidden).toBe(false);
      });

      it("declares a net from the pad row when the name typed is not one yet", () => {
        // The reason the pad's net is typed and not picked. A menu can only offer what already exists, so
        // wiring a pad to a new net meant leaving the pad, declaring the net in the box above, and coming
        // back to it — three gestures for the commonest edit there is.
        const { modal, at } = withRails();
        const before = modal.circuit.nets.length;
        placeAndSelect(modal, "C_1206", at);
        wirePad(modal, "1", "SDA");

        const made = modal.circuit.nets.find((n: any) => n.name === "SDA");
        expect(made, "typing a new name did not declare the net").toBeTruthy();
        expect(modal.circuit.nets).toHaveLength(before + 1);
        // Wired to the net it just made, not merely alongside it.
        expect(modal.circuit.terminals).toEqual([{ part: 0, pad: "1", net: made.id }]);
        // And it is a net like any other: coloured, and offered to every row after it.
        expect(made.color).toBeTruthy();
        expect(made.id).not.toBe("");
      });

      it("takes an existing net by name rather than declaring a second one that reads the same", () => {
        // Two nets called GND is the failure this has to not have: the pads would divide between them and
        // the netlist would resolve, so nothing would report it. Case is not a difference, because
        // `addNet` already refuses to declare two names that differ only by it.
        const { modal, at } = withRails();
        addNet(modal, "GND");
        const n = modal.circuit.nets.length;
        placeAndSelect(modal, "C_1206", at);
        wirePad(modal, "1", "gnd");

        expect(modal.circuit.nets).toHaveLength(n);
        expect(modal.circuit.terminals[0].net).toBe(
          modal.circuit.nets.find((x: any) => x.name === "GND").id,
        );
      });

      it("moves a pad from one net to another rather than putting it on both", () => {
        // Two nets on one pad is a short, and the router would dutifully build it.
        const { modal, at } = withRails();
        addNet(modal, "PWR");
        addNet(modal, "GND");
        placeAndSelect(modal, "C_1206", at);
        wirePad(modal, "1", "PWR");
        wirePad(modal, "1", "GND");
        expect(modal.circuit.terminals).toHaveLength(1);
        expect(modal.circuit.terminals[0].net).toBe(modal.circuit.nets[1].id);

        // And "—" takes it off entirely.
        const pick = modal.overlay.querySelectorAll(".el-pad-net").find((p: any) => p.dataset.pad === "1");
        pick.value = "";
        pick.dispatch("change", {});
        expect(modal.circuit.terminals).toHaveLength(0);
      });

      it("renumbers the terminals when a part below them is deleted", () => {
        // `Terminal.part` is an INDEX into `circuit.parts`. Delete part 0 and every terminal above it now
        // names its neighbour: the netlist still resolves, and wires the wrong pads. Nothing errors.
        const { modal } = withRails();
        addNet(modal, "PWR");
        const net = modal.circuit.nets[0].id;
        const run = modal.routed.traces.find((t: any) => t.net === "pwr");
        // Free placement, so the two parts land where they are put. In the default gap mode both taps
        // snap to the nearest hinge midpoint -- the same point -- and the second part sits exactly on top
        // of the first, where the hit test can only ever find the lower one.
        modal.selectPlaceMode("free");
        placeAndSelect(modal, "C_1206", alongRun(run, 0.25));
        wirePad(modal, "1", "PWR");
        placeAndSelect(modal, "R_1206", alongRun(run, 0.75));
        wirePad(modal, "2", "PWR");
        expect(modal.circuit.parts.map((p: any) => p.component)).toEqual(["C_1206", "R_1206"]);
        expect(modal.circuit.terminals).toEqual([
          { part: 0, pad: "1", net },
          { part: 1, pad: "2", net },
        ]);

        // Select the capacitor -- part 0 -- and delete it.
        tapFlat(modal, modal.circuit.parts[0]);
        expect(modal.selected).toEqual({ kind: "part", index: 0 });
        (globalThis as any).document.dispatch("keydown", { key: "Delete" });

        expect(modal.circuit.parts.map((p: any) => p.component)).toEqual(["R_1206"]);
        // The capacitor's terminal went with it, and the resistor's came down to index 0 -- still its own.
        expect(modal.circuit.terminals).toEqual([{ part: 0, pad: "2", net }]);
      });

      it("carries the nets and the terminals through to the controller", () => {
        // The same trap `flip` and `component` were: drawn in the bar, gone the moment it round-trips.
        const { modal, edits, at } = withRails();
        addNet(modal, "PWR");
        placeAndSelect(modal, "C_1206", at);
        wirePad(modal, "1", "PWR");

        const sent = edits[edits.length - 1] as any;
        expect(sent.nets).toEqual(modal.circuit.nets);
        expect(sent.terminals).toEqual(modal.circuit.terminals);
        expect(sent.nets, "the clone shares the modal's own array").not.toBe(modal.circuit.nets);
        expect(sent.terminals[0], "the clone shares a terminal object").not.toBe(modal.circuit.terminals[0]);
      });

      it("keeps the declared nets through Clear, and drops what they were wired to", () => {
        const { modal, at } = withRails();
        addNet(modal, "PWR");
        placeAndSelect(modal, "C_1206", at);
        wirePad(modal, "1", "PWR");

        const declared = modal.circuit.nets.map((n: any) => n.name);
        modal.overlay.querySelector(".el-clear").dispatch("click", {});
        // Every declared net survives, the seeded PWR and GND among them: they are names the author chose
        // or the circuit came with, they cost nothing to keep, and the parts they were wired to are what
        // Clear is for.
        expect(modal.circuit.nets.map((n: any) => n.name), "the net names were thrown away").toEqual(declared);
        expect(modal.circuit.terminals, "a terminal outlived the part it was on").toHaveLength(0);
        expect(modal.circuit.parts ?? []).toHaveLength(0);
      });

      it("offers every part in the library, all of them wirable", () => {
        // This replaces an invariant test written a few hours ago, which asserted that no PLACEABLE part
        // sat in the lazily-fetched half -- the condition under which a part could be placed and then not
        // resolved. `netPlacement` made all 92 of them placeable at once, which would have fired it, and
        // the fix landed first: there is one library now and every lookup goes through it. What is worth
        // guarding is the property that replaced it -- nothing is offered that cannot be resolved.
        const { modal } = openOn(grid2x2());
        const offered = rows(modal).map((r) => r.value);
        expect(offered.length).toBeGreaterThan(100);
        for (const id of offered) {
          expect(componentById(id), `${id} is offered and does not resolve`).toBeTruthy();
        }
      });
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
      modal.selectPlaceMode("free");
      pick(modal, "C_1206");
      tapFlat(modal, at);

      const html = modal.svg.innerHTML as string;
      // The circuit's LED is drawn through this same list and group now, so read the counts off the
      // capacitor alone rather than off everything in the group.
      const drawn = modal.drawnParts().filter((d: any) => d.component === "C_1206");
      expect(drawn).toHaveLength(1);
      // Grouped by layer across the whole board, svg-pcb's way: one copper group, one mask group, and the
      // drills punched between them and the writing. Read the pads off those rather than off a per-part
      // group, which no longer exists.
      const groupOf = (id: string): string => {
        const m = new RegExp(`<g id="${id}"[^>]*>([\\s\\S]*?)</g>`).exec(html);
        expect(m, `the board has no ${id} layer`).toBeTruthy();
        return m![1]!;
      };
      const marks = groupOf("F.Cu") + groupOf("F.Mask") + groupOf("origins");
      // One copper path and one mask path for every terminal the footprint has -- counted from the library,
      // not from the shape being drawn, or a drawing that lost a pad would agree with itself about it.
      const pins = terminals(drawn[0].footprint).length;
      expect(pins).toBe(2); // a 1206 capacitor
      expect(drawn[0].shape.leads).toHaveLength(pins);
      // Counted over the whole group, which holds the LED's two pads as well as the capacitor's.
      const all = modal.drawnParts().reduce((n: number, d: any) => n + terminals(d.footprint).length, 0);
      // No stroke on the copper any more: svg-pcb fills each layer flat and lets the opaque mask cover the
      // copper, rather than holding the mask back to leave an edge showing.
      expect(groupOf("F.Cu"), "the pads still carry the kiri rim").not.toContain("stroke-width");
      const copper = marks.match(new RegExp(`fill="${PCB_COLOURS.copper}"`, "g")) ?? [];
      const mask = marks.match(new RegExp(`fill="${PCB_COLOURS.mask}"`, "g")) ?? [];
      expect(copper).toHaveLength(all);
      expect(mask).toHaveLength(all);
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
      // The ROOMIEST run of each net, not the first one in the list. A part needs its own gap of run to sit
      // in, and when `TAPE_MM` fell to 1.5 on 2026-08-28 the replan left the first GND run too short for the
      // switch — the fixture then placed two parts instead of four and the test read as a designator bug,
      // which it is not. Whether a short run can hold a part is `resistor.test.ts`'s business, not this
      // test's; here the parts simply have to exist so that they can be numbered.
      const runLen = (t: any): number => {
        let s = 0;
        for (let i = 1; i < t.pts.length; i++) s += Math.hypot(t.pts[i].x - t.pts[i - 1].x, t.pts[i].y - t.pts[i - 1].y);
        return s;
      };
      const roomiest = (net: string): any =>
        modal.routed.traces.filter((t: any) => t.net === net).sort((a: any, b: any) => runLen(b) - runLen(a))[0];
      // One of each kind, each on a run of its own -- two parts on one run and the second will not fit.
      modal.selectTool("resistor");
      tapFlat(modal, mid(roomiest("pwr")));
      modal.selectTool("switch");
      // Longest GND run first, then its other points: a switch reaches a pitch plus half a pad off its own
      // centreline, so it is refused near a bend or where the other rail runs close, and which points those
      // are moves with the tape. See `resistor.test.ts › slides one dropped at the very end of a run`.
      sw: for (const t of modal.routed.traces.filter((x: any) => x.net === "gnd").sort((a: any, b: any) => runLen(b) - runLen(a))) {
        for (const p of t.pts) {
          tapFlat(modal, p);
          if (modal.drawnParts().some((d: any) => d.component === "SW_SPDT")) break sw;
        }
      }
      modal.selectPlaceMode("free");
      pick(modal, "R_2010");
      // Every point of every un-parted run, until one takes it: free placement needs bare pattern under the
      // whole part, and which points have that moves with the plan.
      outer: for (const t of modal.routed.traces.filter((x: any) => x.width === undefined)) {
        for (const p of t.pts) {
          tapFlat(modal, p);
          if (modal.routedParts().length) break outer;
        }
      }
      // The LEDs come last, which is the order both cut files take them in — see `drawnParts`.
      expect(modal.drawnParts().map((d: any) => d.component))
        .toEqual(["R_1206", "SW_SPDT", "R_2010", "LED_1206"]);

      // Zoomed in far enough that the text is worth emitting at all.
      modal.zoomBy(4);
      const html = modal.svg.innerHTML as string;
      const tags = [...html.matchAll(
        new RegExp(`fill="${PCB_COLOURS.componentLabel}"[^>]*>([^<]+)<`, "g"),
      )].map((m) => m[1]);
      // The two resistors share a family and are numbered through it, whichever list each came from.
      expect(tags).toEqual(["R1", "SW1", "R2", "LED1"]);
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
      modal.selectPlaceMode("free");
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

      // No library part placed yet. The fixture's LED is a part now, so both files already have a parts
      // layer — what they must not have is the capacitor.
      modal.overlay.querySelector(".el-export").dispatch("click", {});
      modal.overlay.querySelector(".el-export-carrier").dispatch("click", {});
      const [stripsBefore, carrierBefore] = svgs.splice(0, 2);
      expect(stripsBefore).not.toContain(">C1<");
      expect(carrierBefore).not.toContain(">C1<");

      modal.selectPlaceMode("free");
      pick(modal, "C_1206");
      tapFlat(modal, at);
      expect(modal.routed.parts, "the router placed nothing to export").toHaveLength(1);

      modal.overlay.querySelector(".el-export").dispatch("click", {});
      modal.overlay.querySelector(".el-export-carrier").dispatch("click", {});
      const [stripsAfter, carrierAfter] = svgs.splice(0, 2);
      // The part is drawn on its own layer in each file — it is annotation, never copper to cut.
      expect(stripsAfter, "the part never reached the strips file").toContain('<g id="parts">');
      expect(carrierAfter, "the part never reached the carrier file").toContain('<g id="annotation"');
      expect(stripsAfter, "the part is not named in the strips file").toContain(">C1<");
      expect(carrierAfter, "the part is not named in the carrier file").toContain(">C1<");

      delete (globalThis as any).URL;
      delete (globalThis as any).Blob;
    });
  });


  it("lands a net's copper on the pad the canvas draws, in the canvas's own flipped frame", () => {
    // **The bug the whole "pin 1 routes to pin 5" report was about, and it lived HERE, not in the model.**
    //
    // `tp()` sends flat `y` to `maxY − y`: FOLD is y-up, SVG is y-down, so the canvas frame REVERSES
    // ORIENTATION. `partShape` was handed points already in that frame and derived the across-run
    // perpendicular there, while `electronics-parts.ts › placementOf` derives it in flat units. A
    // perpendicular flips sign under a reflection, so the drawn pin row came out mirrored against the
    // routed one: on `Module_XIAO_Generic_SocketSMD` the net on pad 1 had its copper on drawn pad 5,
    // 10.16mm off, with 2 and 4 swapped and 3 standing still.
    //
    // Every model-level test missed it because they all compare in a plain SCALE — `p.x * k` — which
    // preserves orientation. Only the editor and the cut files reflect, so only a test that goes through
    // `tp()` can see it. That is why this one is in the view file.
    const { modal } = openOn(grid2x2());
    const f = modal.faces;
    modal.circuit = {
      ...modal.circuit,
      parts: [
        { component: "Module_XIAO_Generic_SocketSMD", x: f[0].centroid.x, y: f[0].centroid.y, free: true, rot: 0 },
        { component: "C_1206", x: f[3].centroid.x, y: f[3].centroid.y, free: true, rot: 0 },
      ],
      terminals: [{ part: 0, pad: "1", net: "pwr" }, { part: 1, pad: "1", net: "pwr" }],
    };
    modal.render();

    const xiao = modal.drawnParts().find((d: any) => d.component.startsWith("Module_XIAO"));
    expect(xiao, "the socket was not drawn at all").toBeTruthy();
    const traces = modal.routed.traces.filter((t: any) => t.net === "pwr");
    expect(traces.length, "the net laid no copper to land anywhere").toBeGreaterThan(0);
    // Every point the net's copper stops at, in the same frame the pads are drawn in.
    const ends = traces
      .flatMap((t: any) => [t.pts[0], t.pts[t.pts.length - 1]])
      .map((p: any) => modal.tp(p));
    const reach = (name: string): number => {
      const l = xiao.shape.leads.find((q: any) => q.name === name);
      const c = { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 };
      return Math.min(...ends.map((e: any) => Math.hypot(e.x - c.x, e.y - c.y)));
    };

    expect(reach("1"), "no copper ends on the pad the canvas labels 1").toBeLessThan(1e-6);
    // And pad 5 is where it used to land. Named rather than left implicit, because "somewhere else" is
    // what a reflection about pad 3 means on this footprint and it is the whole shape of the bug.
    expect(reach("5"), "copper ends on drawn pad 5 — the frame's reflection is back").toBeGreaterThan(5);
  });

  describe("which LED", () => {
    it("draws each LED from its own footprint, so two packages on one circuit differ", () => {
      // A saved circuit may name either package — the toolbar picker that used to choose between them is
      // gone, but the field it wrote is still read. Drawing every LED from one footprint would put both at
      // the 1206's pads and cut copper a 0603's legs cannot reach.
      const { modal } = openOn(grid2x2());
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      tapFlat(modal, modal.gaps[1].point);
      // The second is a 0603, the way a file that carries one says so.
      modal.circuit = {
        ...modal.circuit,
        leds: modal.circuit.leds.map((l: any, i: number) => (i === 1 ? { ...l, component: "LED_0603" } : l)),
      };

      const leds = modal.drawnParts().filter((d: any) => d.component.startsWith("LED_"));
      expect(leds.map((d: any) => d.component)).toEqual(["LED_1206", "LED_0603"]);
      // A lead's segment carries the pad's own height. Read it off the footprint, not written down here.
      for (const d of leds) {
        const l = d.shape.leads[0];
        expect(Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y))
          .toBeCloseTo(padSize(padNamed(d.footprint, "1")).h, 4);
      }
      const span = (d: any): number =>
        Math.hypot(d.shape.leads[0].b.x - d.shape.leads[0].a.x, d.shape.leads[0].b.y - d.shape.leads[0].a.y);
      expect(span(leds[0]), "both LEDs came out the same size").toBeGreaterThan(span(leds[1]));
      // Each pad carries its terminal's own name, which is what says which way round to fit the part:
      // pad 1 is the anode and it is drawn on the PWR pad the router landed on.
      expect(leds[0].shape.leads.map((l: any) => l.name)).toEqual(["1", "2"]);
    });

    it("places a hinge LED as the default package, naming it by leaving the field out", () => {
      // **Changed 2026-08-28.** The toolbar had a second picker, beside the LED button, offering the 1206
      // and the 0603. It went when LEDs joined the library palette — a control for two of the library's
      // parts, sitting where the library picker could not reach, is a rule about LEDs held in the toolbar.
      //
      // `component` stays absent rather than being written as `"LED_1206"`, so two identical circuits do
      // not serialise differently depending on when they were authored.
      const { modal, edits } = openOn(grid2x2());
      expect(modal.overlay.querySelector(".el-led-part"), "the LED package picker is still in the toolbar")
        .toBe(null);

      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      expect(modal.circuit.leds).toEqual([{ a: modal.gaps[0].faceA, b: modal.gaps[0].faceB }]);
      // And it survives the clone into the store — a field invented on the way out would be a decision the
      // author never took.
      const sent = edits[edits.length - 1] as any;
      expect(sent.leds.map((l: any) => l.component)).toEqual([undefined]);
    });

    it("keeps the hinge pick radius off the LED's size", () => {
      // The pick radius is how near a tap must land to a hinge to drop an LED there. It is the pattern's,
      // not the part's — tied to a 0603's 0.8mm pads it would be all but untappable.
      const { modal } = openOn(grid2x2());
      const diag = Math.hypot(
        modal.bounds.maxX - modal.bounds.minX, modal.bounds.maxY - modal.bounds.minY,
      );
      expect(modal.pickRadius()).toBe(Math.max(2, diag * 0.06));
    });

    it("paints a declared net's copper in the colour the author gave it, not in GND black", () => {
      // A `fill=` presentation attribute sits BELOW every CSS rule in the cascade, so `.el-tape-gnd`'s
      // `fill: #222222` beat the colour the emitter passed and every declared net was painted black. The
      // sidebar swatch said one thing and the copper under it said another — the exact contradiction
      // `net-palette.ts` exists to prevent, since it puts colour on the model so all three views agree.
      //
      // Asserted on the emitted markup rather than through a real browser, so what this pins is that the
      // colour is emitted at a precedence that can win, not merely that it is emitted at all.
      const { modal } = openOn(grid2x2());
      modal.circuit = {
        ...modal.circuit,
        nets: [{ id: "sig", name: "SIG", color: "#16a34a" }],
        parts: [
          { component: "R_1206", x: modal.faces[0].centroid.x, y: modal.faces[0].centroid.y, free: true },
          { component: "R_1206", x: modal.faces[1].centroid.x, y: modal.faces[1].centroid.y, free: true },
        ],
        terminals: [{ part: 0, pad: "1", net: "sig" }, { part: 1, pad: "1", net: "sig" }],
      };
      modal.render();

      const html = modal.svg.innerHTML as string;
      if (html.includes("el-tape el-tape-gnd")) {
        // The net laid copper, so it must carry its own colour where a class cannot override it.
        expect(html).toContain("style=\"fill:#16a34a\"");
        expect(html).not.toMatch(/class="el-tape el-tape-gnd" fill="#16a34a"/);
      }
    });

    it("draws a line from a terminal the router could not reach to the copper it belongs on, and none once the net is whole", () => {
      // A net that loses a pad otherwise looks on the canvas exactly like one that did not: the only sign
      // was a count in the sidebar and a sentence in the status line, neither of which says WHERE.
      //
      // The second half is the half that matters, and it is what svg-pcb's shipped ratsnest cannot do —
      // its lines come from the declared netlist alone and stay on screen however much copper you lay.
      const { modal } = openOn(grid2x2());

      // A net whose two pads are on faces the router cannot join: no battery, no copper, nothing reached.
      modal.circuit = {
        ...modal.circuit,
        nets: [{ id: "x1", name: "X1", color: "#1f6feb" }],
        parts: [
          { component: "R_1206", x: modal.faces[0].centroid.x, y: modal.faces[0].centroid.y, free: true },
          // Off the material entirely, so this terminal is stranded for a reason the router cannot argue
          // with — `faceOfPoint` returns -1 and it can never be reached, whatever the corridor looks like.
          { component: "R_1206", x: 100, y: 100, free: true },
        ],
        terminals: [
          { part: 0, pad: "1", net: "x1" },
          { part: 1, pad: "1", net: "x1" },
        ],
      };
      modal.render();

      const stranded = (modal.routed.nets ?? []).reduce(
        (a: number, n: any) => a + n.stranded.length, 0);
      expect(stranded, "the fixture is meant to strand a terminal").toBeGreaterThan(0);
      expect(modal.svg.innerHTML).toContain("el-ratsnest");

      // Now take the netlist away entirely: nothing is asked for, so nothing can be missing.
      modal.circuit = { ...modal.circuit, nets: [], terminals: [] };
      modal.render();
      expect(modal.svg.innerHTML).not.toContain("el-ratsnest");
    });

    it("rings an LED the copper never reached, and the one that is selected", () => {
      // The bespoke marker is gone, so these two marks are all that is left saying anything about an LED
      // beyond its footprint. With no battery, nothing is reachable.
      const { modal } = openOn(grid2x2());
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      expect(modal.routed.unreachable).toContain(0);
      expect(modal.svg.innerHTML).toContain("el-led-orphan");
      expect(modal.svg.innerHTML).toContain("el-led-selected");

      // Ringed, not shrunk to the part: a 0603 is 1.5mm across and a ring that size is a dot inside it.
      const r = [...(modal.svg.innerHTML as string).matchAll(
        /r="([\d.]+)" class="el-led-(?:orphan|selected)"/g,
      )].map((m) => Number(m[1]));
      expect(r).toHaveLength(2);
      for (const x of r) expect(x).toBeGreaterThanOrEqual(1.7);
      // And the floor itself, on the size that needs it: an LED_0603's legs are 1.5mm apart, so a ring at
      // three quarters of its span would be 1.1mm — drawn inside the part rather than around it.
      const tiny = modal.selectionRing({ x: 0, y: 0 }, { x: 1.5, y: 0 }, "el-led-selected");
      expect(Number(/r="([\d.]+)"/.exec(tiny)![1])).toBeGreaterThanOrEqual(1.7);
    });
  });


  /**
   * The wire tool, as the page wires it in. The gesture grammar itself is `wire-tool.test.ts`'s; what is
   * checked here is only what the modal owns — arming it, letting it have the pointer, keeping its copper
   * across the round trip to the store, and repainting it without repainting the canvas.
   */
  describe("drawing copper by hand", () => {
    /** The palette button that arms `tool`. */
    function toolBtn(modal: any, tool: string): any {
      return modal.overlay.querySelectorAll(".el-tool").find((b: any) => b.dataset.tool === tool);
    }

    it("arms from the palette, and abandons a part-drawn wire when another tool is picked", () => {
      const { modal } = openOn(grid2x2());
      // Inert until armed: a tap on the canvas with the LED tool up is an LED, not a vertex.
      tapFlat(modal, { x: 0.3, y: 0.3 });
      expect(modal.wire.drawing()).toBe(false);

      toolBtn(modal, "wire").click();
      expect(toolBtn(modal, "wire").classList.contains("is-active")).toBe(true);
      // It places no part, so the library picker must not read as armed alongside it.
      expect(modal.activePart()).toBe(null);

      tapFlat(modal, { x: 0.3, y: 0.3 });
      expect(modal.wire.drawing()).toBe(true);

      // Walking away from a half-drawn wire drops it. Committing one on the way out would leave copper
      // nobody asked for. Any other tool will do — battery, because the LED tool lost its button when LEDs
      // became ordinary library parts, and this test is about leaving the wire tool, not about which tool
      // is picked up next.
      toolBtn(modal, "battery").click();
      expect(modal.wire.drawing()).toBe(false);
      expect(modal.circuit.wires ?? []).toHaveLength(0);
    });

    it("takes the pointer while armed, so drawing a wire never pans the canvas", () => {
      const { modal } = openOn(grid2x2());
      toolBtn(modal, "wire").click();
      const box = (): string => modal.svg.getAttribute("viewBox") as string;
      const before = box();
      const at = modal.tp({ x: 0.3, y: 0.3 });
      modal.svg.dispatch("pointerdown", { button: 0, clientX: at.x, clientY: at.y, pointerId: 1 });
      modal.svg.dispatch("pointermove", { clientX: at.x + 40, clientY: at.y + 40, pointerId: 1 });
      expect(box()).toBe(before);
    });

    it("commits the wire on the finishing tap, and the store gets it", () => {
      const { modal, edits } = openOn(grid2x2());
      toolBtn(modal, "wire").click();
      const a = { x: 0.3, y: 0.3 }, b = { x: 1.7, y: 0.3 };
      tapFlat(modal, a);
      tapFlat(modal, b);
      // Nothing is committed until the wire is finished — mid-draw it lives in the tool alone.
      expect(modal.circuit.wires ?? []).toHaveLength(0);
      tapFlat(modal, b); // tapping the last point laid is the finish gesture

      expect(modal.circuit.wires).toHaveLength(1);
      expect(modal.circuit.wires[0].pts).toHaveLength(2);
      // And it is drawn as the outline that gets cut, like any other copper on the sheet.
      expect(modal.svg.innerHTML).toContain("el-wire-copper");

      // THE trap. `cloneCircuit` copies field by field and silently drops anything it does not name, so a
      // wire missing from it would draw on the canvas and vanish the moment the circuit reached the store.
      const stored = edits[edits.length - 1] as any;
      expect(stored.wires).toHaveLength(1);
      expect(stored.wires[0].pts).toEqual(modal.circuit.wires[0].pts);
      // A copy, not the editor's own array: the store must not hold vertices the canvas can still move.
      expect(stored.wires[0].pts[0]).not.toBe(modal.circuit.wires[0].pts[0]);
    });

    it("keeps a wire drawn onto a part's pad attached to that part", () => {
      const { modal, edits } = openOn(grid2x2());
      // A battery and an LED, so the pattern has copper on it and a terminal to snap to.
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      modal.selectTool("led");
      tapFlat(modal, modal.gaps[0].point);
      expect(modal.routed.traces.length).toBeGreaterThan(0);
      const pwr = batteryTerminals(
        modal.faces[0].centroid, patternDiag(modal.faces), modal.faces[0].poly, modal.tapeW(),
      ).pwr;

      toolBtn(modal, "wire").click();
      tapFlat(modal, pwr);
      tapFlat(modal, { x: 1.7, y: 1.7 });
      tapFlat(modal, { x: 1.7, y: 1.7 });

      const wire = modal.circuit.wires[0];
      // Stored as WHAT it is attached to, never as where that thing happens to be — which is the whole
      // reason a wire follows the thing it is drawn to.
      expect(wire.pts[0].kind).toBe("battery");
      // And it carries the rail it landed on, so it is not charged with crossing the net it is drawn on.
      expect(wire.net).toBe("pwr");
      expect((edits[edits.length - 1] as any).wires[0].net).toBe("pwr");
    });

    it("repaints the wire's own layer, leaving the rest of the canvas byte-identical", () => {
      const { modal } = openOn(grid2x2());
      toolBtn(modal, "wire").click();
      tapFlat(modal, { x: 0.3, y: 0.3 });

      // In the mock DOM the live layer is a child element with an `innerHTML` of its own, so the canvas's
      // own markup is exactly the static half — which is what makes the two comparable here at all.
      const staticBefore = modal.svg.innerHTML as string;
      expect(staticBefore).toContain("el-static");
      expect(staticBefore).toContain("el-live");
      const liveBefore = modal.liveLayer().innerHTML as string;

      const at = modal.tp({ x: 1.2, y: 0.9 });
      modal.svg.dispatch("pointermove", { clientX: at.x, clientY: at.y, pointerId: 1 });

      // The rubber band moved...
      const liveAfter = modal.liveLayer().innerHTML as string;
      expect(liveAfter).not.toBe(liveBefore);
      expect(liveAfter).toContain("el-wire-band");
      // ...and the static half came through it unaltered, which is what this test is good for: the live
      // repaint does not corrupt the canvas under it. It is NOT evidence that the canvas was left alone —
      // see the test below, which is where that claim actually lives.
      expect(modal.svg.innerHTML).toBe(staticBefore);
    });

    it("does not repaint the canvas at all on a pointer move", () => {
      // Asserted as a CALL, because the guarantee is about one. `draw()` is deterministic, so a redundant
      // repaint regenerates byte-identical markup and an assertion on content cannot see it — content is
      // exactly what a wasted repaint does not change. The test above passes cleanly with `this.draw()`
      // spliced into the pointer-move guard, which is the stutter this one exists to catch.
      //
      // And the cost is the whole reason the canvas is split in two: a full re-plan is most of a second,
      // and a drag that re-planned on every move would be a drag that stutters. The tool commits on
      // pointer UP, once, and the host re-plans in its own time.
      const { modal } = openOn(grid2x2());
      toolBtn(modal, "wire").click();
      tapFlat(modal, { x: 0.3, y: 0.3 });

      let draws = 0;
      const real = modal.draw.bind(modal);
      modal.draw = () => {
        draws++;
        return real();
      };

      const at = modal.tp({ x: 1.2, y: 0.9 });
      modal.svg.dispatch("pointermove", { clientX: at.x, clientY: at.y, pointerId: 1 });
      expect(draws, "the canvas was repainted during a drag").toBe(0);
      // The band still moved — the point is that it moved without a repaint, not that nothing happened.
      expect(modal.liveLayer().innerHTML).toContain("el-wire-band");

      // A second move is no different: this holds for every event in the gesture, not just the first.
      const on = modal.tp({ x: 1.4, y: 1.1 });
      modal.svg.dispatch("pointermove", { clientX: on.x, clientY: on.y, pointerId: 1 });
      expect(draws).toBe(0);
    });

    it("puts the live layer back after the canvas is repainted under it", () => {
      const { modal } = openOn(grid2x2());
      toolBtn(modal, "wire").click();
      tapFlat(modal, { x: 0.3, y: 0.3 });
      const at = modal.tp({ x: 1.2, y: 0.9 });
      modal.svg.dispatch("pointermove", { clientX: at.x, clientY: at.y, pointerId: 1 });
      expect(modal.liveLayer().innerHTML).toContain("el-wire-band");

      // A zoom throws the whole canvas away and builds it again; the wire being drawn must survive it.
      modal.zoomBy(1.25);
      modal.render();
      expect(modal.liveLayer().innerHTML).toContain("el-wire-band");
    });

    /** Captures every SVG the modal downloads, in order. Returns the list and the teardown. */
    function catchDownloads(): { svgs: string[]; done: () => void } {
      const svgs: string[] = [];
      (globalThis as any).URL = { createObjectURL: () => "blob:mock", revokeObjectURL: () => {} };
      (globalThis as any).Blob = class {
        constructor(parts: any[]) {
          svgs.push(String(parts[0]));
        }
      };
      return {
        svgs,
        done: () => {
          delete (globalThis as any).URL;
          delete (globalThis as any).Blob;
        },
      };
    }

    /** Draw one wire through the given flat points, finishing on the last. */
    function drawWire(modal: any, pts: { x: number; y: number }[]): void {
      toolBtn(modal, "wire").click();
      for (const p of pts) tapFlat(modal, p);
      tapFlat(modal, pts[pts.length - 1]!); // tapping the last point laid finishes the wire
    }

    it("exports a sheet whose only copper is hand-drawn", () => {
      // The canvas has already told the author this copper exists. A cut file that leaves it out — while
      // blaming them for not having placed a battery — is worse than the feature being absent.
      const { modal } = openOn(grid2x2());
      const { svgs, done } = catchDownloads();

      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      expect(modal.routed.traces, "the router planned copper; this case is about a sheet with none")
        .toHaveLength(0);

      // Nothing drawn yet, so there is genuinely nothing to cut, and it still says so.
      modal.overlay.querySelector(".el-export").dispatch("click", {});
      expect(svgs).toHaveLength(0);
      expect(modal.statusEl.textContent).toContain("Nothing to export");

      // A wire off the battery's PWR terminal is copper on the PWR rail, and the file has a layer for it.
      const term = batteryTerminals(
        modal.faces[0].centroid, patternDiag(modal.faces), modal.faces[0].poly, modal.tapeW(),
      );
      drawWire(modal, [term.pwr, { x: 1.6, y: 0.6 }]);
      expect(modal.circuit.wires[0].net).toBe("pwr");

      modal.overlay.querySelector(".el-export").dispatch("click", {});
      expect(svgs, "a sheet with copper on it exported nothing").toHaveLength(1);
      expect(modal.statusEl.textContent).toContain("1 PWR strip");
      done();
    });

    it("puts the drawn wire's own geometry in the strips file", () => {
      // Not merely "a path appeared": the copper in the file has to be the copper on the canvas. Checked as
      // geometry rather than as a string, so the assertion survives a change to how the file is written.
      const { modal } = openOn(grid2x2());
      const { svgs, done } = catchDownloads();
      modal.selectTool("battery");
      tapFlat(modal, { x: 0.5, y: 0.5 });
      const term = batteryTerminals(
        modal.faces[0].centroid, patternDiag(modal.faces), modal.faces[0].poly, modal.tapeW(),
      );
      const far = { x: 1.6, y: 0.6 };
      drawWire(modal, [term.pwr, far]);

      modal.overlay.querySelector(".el-export").dispatch("click", {});
      const pwr = /<g id="pwr"[^>]*>([\s\S]*?)<\/g>/.exec(svgs[0]!)![1]!;
      const nums = [...pwr.matchAll(/[-\d.]+ [-\d.]+/g)].map((m) => {
        const [x, y] = m[0].split(" ").map(Number);
        return { x: x!, y: y! };
      });
      expect(nums.length, "no copper on the PWR layer").toBeGreaterThan(3);

      // The far end of the wire, in the file's own sheet coordinates, has copper within half a tape of it.
      const { T, scale } = sheetFrame(modal.fold, { x: false, y: false }, undefined);
      const want = T(far);
      const near = Math.min(...nums.map((p) => Math.hypot(p.x - want.x, p.y - want.y)));
      expect(near).toBeLessThanOrEqual(modal.tapeW() * scale);
      done();
    });

    it("carries a wire on no rail in the carrier file, and says the strips file could not", () => {
      // The two files disagree, and the difference is real: the carrier holds runs in a frame whatever net
      // they are on, while the strips file sorts them onto two cut layers, PWR and GND, and has nowhere to
      // put a third. A wire between two free points is its own net, so it lands on neither.
      const { modal } = openOn(grid2x2());
      const { svgs, done } = catchDownloads();
      drawWire(modal, [{ x: 0.4, y: 0.4 }, { x: 1.6, y: 0.6 }]);
      expect(modal.circuit.wires[0].net, "a free wire should carry no net").toBeUndefined();

      modal.overlay.querySelector(".el-export").dispatch("click", {});
      expect(svgs, "the file was not built at all").toHaveLength(1);
      // Not silently: the author is told which file has it, and how to put it on a rail.
      expect(modal.statusEl.textContent).toContain("1 drawn wire is not in this file");
      expect(modal.statusEl.textContent).toContain("carrier file carries them all");

      modal.overlay.querySelector(".el-export-carrier").dispatch("click", {});
      expect(svgs).toHaveLength(2);
      expect(modal.statusEl.textContent).toContain("holding 1 trace");
      done();
    });

    it("tells an unbuildable wire apart from a merely costly one", () => {
      // An ERROR means the wire cannot be cut; a WARNING means it can and will cost something. Reading
      // alike, the author cannot tell which one they are looking at.
      const { modal } = openOn(grid2x2());
      toolBtn(modal, "wire").click();
      // Off the material entirely: `off-body` is an error, so the line must say it cannot be cut.
      tapFlat(modal, { x: -8, y: -8 });
      tapFlat(modal, { x: -9, y: -9 });
      const faults = modal.wire.faults();
      expect(faults.length, "the fixture drew a wire the rules are happy with").toBeGreaterThan(0);
      expect(faults.some((f: any) => ERRORS.has(f.kind)), "no error among the faults").toBe(true);
      expect(modal.statusEl.textContent).toContain("cannot be cut");
      expect(modal.statusEl.textContent).not.toContain("still cuttable");
    });

    it("gives the wire tool the keys it needs, and leaves the others alone", () => {
      const { modal } = openOn(grid2x2());
      toolBtn(modal, "wire").click();
      tapFlat(modal, { x: 0.3, y: 0.3 });
      tapFlat(modal, { x: 1.7, y: 0.3 });
      (globalThis as any).document.dispatch("keydown", { key: "Enter" });
      expect(modal.circuit.wires).toHaveLength(1);
      expect(modal.wire.drawing()).toBe(false);

      // Delete takes the selected wire off — and it must not also fall through to `removeSelected`.
      (globalThis as any).document.dispatch("keydown", { key: "Delete" });
      expect(modal.circuit.wires).toHaveLength(0);
    });
  });


  describe("shelving the library", () => {
    /** Every part the palette can shelve, which is the whole library — LEDs and the coin cell included. */
    const shelved = LIBRARY.map((c) => ({ id: c.id, shelf: shelfFor(c.id) }));

    it("leaves nothing on the catch-all shelf", () => {
      // The point of naming the shelves: a heading that says only "not one of the others" is the one
      // shelf a person cannot skim, and it used to hold 53 of the 129 parts. The rule stays as a
      // backstop — a part added to the library must land somewhere — so this is the assertion that the
      // backstop is not doing the work.
      const stray = shelved.filter((s) => s.shelf === UNSHELVED).map((s) => s.id);
      expect(stray, `${stray.length} parts have no named shelf`).toEqual([]);
    });

    it("keeps every shelf small enough to read", () => {
      // Forty names in one scroll is the wall the shelves exist to knock down, so a shelf that grows
      // back to a third of the library has stopped being a shelf. `Headers & sockets` is the largest at
      // 27, which is a real family of near-identical parts rather than a failure to sort.
      const size = new Map<string, number>();
      for (const s of shelved) size.set(s.shelf, (size.get(s.shelf) ?? 0) + 1);
      const worst = [...size].sort((a, b) => b[1] - a[1])[0]!;
      expect(worst[1], `"${worst[0]}" holds ${worst[1]} parts`).toBeLessThanOrEqual(30);
      expect(size.size, "the library should fill most of the shelves").toBeGreaterThanOrEqual(10);
    });

    it("shelves a part by what it does, not by the package it is moulded in", () => {
      // This is what the rule order buys, and it is the only reason the order is not arbitrary.
      expect(shelfFor("Multiplexer_8_1_Texas_CD74HC4051M96_SOIC_16")).toBe("Analog & logic ICs");
      expect(shelfFor("MotorDriver_BipolarStepper_Trinamic_TMC2226_HTSSOP_28_EP")).toBe("Motor drivers");
      expect(shelfFor("SOIC_8_3_9x4_9mm_P1_27mm")).toBe("IC packages");
      // And the pair that shares a suffix: a transistor and a package outline one letter apart.
      expect(shelfFor("SOT_23_5")).toBe("Diodes & transistors");
      expect(shelfFor("TSOT_23_5")).toBe("IC packages");
    });

    it("still shelves an unrecognised part rather than dropping it", () => {
      expect(shelfFor("Fnord_Widget_9000")).toBe(UNSHELVED);
    });
  });

});
