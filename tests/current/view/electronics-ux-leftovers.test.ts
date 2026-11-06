import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElectronicsModal } from "../../../src/view/electronics-modal.js";
import { shellMarkup } from "../../../src/view/electronics-shell.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { MockElement, installDom } from "./mock-dom.js";

/**
 * The small UI and accessibility leftovers from the UX review (issue #64), driven through the page.
 */

const css = readFileSync("src/styles.css", "utf8");

/** The body of the first CSS rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m"));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1]!;
}

/** A 2x2 grid of square faces `side` units wide: four tiles, hinges between neighbours. */
function grid(side: number): FoldFile {
  const s = side;
  return {
    vertices_coords: [
      [0, 0], [s, 0], [2 * s, 0],
      [0, s], [s, s], [2 * s, s],
      [0, 2 * s], [s, 2 * s], [2 * s, 2 * s],
    ],
    faces_vertices: [[0, 1, 4, 3], [1, 2, 5, 4], [3, 4, 7, 6], [4, 5, 8, 7]],
    edges_vertices: [[1, 4], [3, 4], [4, 5], [4, 7]],
    edges_assignment: ["M", "M", "M", "M"],
  } as unknown as FoldFile;
}

function openOn(fold: FoldFile): any {
  const { document } = installDom();
  const modal = new ElectronicsModal() as any;
  modal.mountTrigger(document.createElement("div") as unknown as HTMLElement);
  modal.setEnabled(true);
  modal.setPattern(fold);
  modal.open();
  return modal;
}

function tapFlat(modal: any, flat: { x: number; y: number }): void {
  const { x: clientX, y: clientY } = modal.tp(flat);
  modal.svg.dispatch("pointerdown", { button: 0, clientX, clientY, pointerId: 1 });
  modal.svg.dispatch("pointerup", { button: 0, clientX, clientY, pointerId: 1 });
}

function q(modal: any, sel: string): any {
  return modal.overlay.querySelector(sel);
}

function click(modal: any, sel: string, pick?: (b: any) => boolean): void {
  const all = modal.overlay.querySelectorAll(sel);
  (pick ? all.find(pick) : all[0]).dispatch("click", {});
}

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
  delete (globalThis as any).location;
});

describe("#64 the status line never changes the canvas height", () => {
  it("is laid out as one line that ellipsises, whatever its length", () => {
    const status = rule(".el-footer-row .el-status");
    expect(status).toMatch(/white-space:\s*nowrap/);
    expect(status).toMatch(/text-overflow:\s*ellipsis/);
    expect(status).toMatch(/overflow:\s*hidden/);
    expect(status).toMatch(/min-width:\s*0/);
    // The row it sits in must not wrap the status onto a second line either.
    expect(rule(".el-footer-row")).toMatch(/flex-wrap:\s*nowrap/);
  });

  it("stacks the canvas above the two rails on a phone, so it is not squeezed to nothing", () => {
    const phone = css.match(/@media \(max-width: 760px\) \{((?:[^{}]*\{[^}]*\})*)\s*\}/g) ?? [];
    const block = phone.find((b) => b.includes(".el-workspace")) ?? "";
    expect(block).toMatch(/\.el-workspace \{ flex-direction: column; \}/);
    expect(block).toMatch(/\.el-canvas-wrap \{ order: -1; \}/);
  });

  it("carries the whole sentence in its title, for every way the line is written", () => {
    const modal = openOn(grid(100));
    const status = q(modal, ".el-status");
    expect(status.title).toBe(status.textContent);
    // A tap away from every fold writes its own line straight onto the status element.
    tapFlat(modal, { x: 50, y: 50 });
    expect(status.textContent).toMatch(/fold/);
    expect(status.title).toBe(status.textContent);
    // And a long routed line, after an LED and a battery.
    tapFlat(modal, { x: 100, y: 50 });
    click(modal, ".el-tool", (b) => b.dataset.tool === "battery");
    tapFlat(modal, { x: 150, y: 150 });
    click(modal, ".el-route");
    expect(status.textContent.length).toBeGreaterThan(40);
    expect(status.title).toBe(status.textContent);
  });
});

describe("#64 one way to find a part: the search box and the list are one combobox", () => {
  let focused: any = null;
  const realFocus = (MockElement.prototype as any).focus;
  beforeEach(() => {
    focused = null;
    (MockElement.prototype as any).focus = function (this: any) { focused = this; };
  });
  afterEach(() => {
    (MockElement.prototype as any).focus = realFocus;
  });

  it("makes the search box the combobox that owns the parts list", () => {
    const modal = openOn(grid(1));
    const search = q(modal, ".el-part-search");
    const menu = q(modal, ".el-part-menu");
    expect(search.getAttribute("role")).toBe("combobox");
    expect(search.getAttribute("aria-controls")).toBe(menu.getAttribute("id"));
    expect(search.getAttribute("aria-expanded")).toBe("false");
    search.value = "cap";
    search.dispatch("input", {});
    expect(menu.hidden).toBe(false);
    expect(search.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the same list from Pick a part, with the cursor in the search box", () => {
    const modal = openOn(grid(1));
    q(modal, ".el-part-trigger").dispatch("click", {});
    expect(q(modal, ".el-part-menu").hidden).toBe(false);
    expect(focused, "Pick a part did not hand the keyboard to the search box").toBe(q(modal, ".el-part-search"));
    expect(q(modal, ".el-part-search").getAttribute("aria-expanded")).toBe("true");
  });

  it("goes down into the list with the arrow key and arms a part from it, socket action included", () => {
    const modal = openOn(grid(1));
    const search = q(modal, ".el-part-search");
    search.value = "LED";
    search.dispatch("input", {});
    search.dispatch("keydown", { key: "ArrowDown", preventDefault() {} });
    expect(focused?.className).toBe("el-part-row");
    focused.dispatch("click", {});
    expect(modal.tool).toBe(focused.dataset.id);
    expect(q(modal, ".el-part-menu").hidden).toBe(true);
    // #36's "+ socket" is still on the rows of a part that needs one.
    search.value = "XIAO";
    search.dispatch("input", {});
    expect(modal.overlay.querySelectorAll(".el-part-with-socket").length).toBeGreaterThan(0);
  });
});

describe("#64 deleting a part takes its stale copper with it", () => {
  /** Two LEDs on hinges and a battery, routed under Manual. */
  function routedTwo(): { modal: any; pads: { pwr: any; gnd: any }[] } {
    const modal = openOn(grid(1));
    modal.selectTool("led");
    tapFlat(modal, modal.gaps[0].point);
    tapFlat(modal, modal.gaps[2].point);
    click(modal, ".el-tool", (b) => b.dataset.tool === "battery");
    tapFlat(modal, { x: 1.5, y: 1.5 });
    click(modal, ".el-route");
    expect(modal.circuit.leds).toHaveLength(2);
    expect(modal.routed.traces.length, "the fixture planned no copper").toBeGreaterThan(0);
    modal.selectTool("led"); // so a tap on an LED picks it up
    return { modal, pads: modal.routed.pads.map((p: any) => ({ pwr: { ...p.pwr }, gnd: { ...p.gnd } })) };
  }
  const mid = (p: { pwr: any; gnd: any }): { x: number; y: number } =>
    ({ x: (p.pwr.x + p.gnd.x) / 2, y: (p.pwr.y + p.gnd.y) / 2 });
  const near = (p: any, q: any, r: number): boolean => Math.hypot(p.x - q.x, p.y - q.y) <= r;

  it("drops the copper that ran to a deleted LED at once, without waiting for Route", () => {
    const { modal, pads } = routedTwo();
    const reach = modal.tapeW() / 2;
    const ranThere = (): number => modal.routed.traces.filter((t: any) =>
      t.pts.some((p: any) => near(p, pads[0]!.pwr, reach) || near(p, pads[0]!.gnd, reach))).length;
    expect(ranThere(), "no copper ran to the LED in the first place").toBeGreaterThan(0);

    tapFlat(modal, mid(pads[0]!)); // pick the first LED up
    expect(modal.selected).toEqual({ kind: "led", index: 0 });
    (globalThis as any).document.dispatch("keydown", { key: "Delete" });

    expect(modal.circuit.leds).toHaveLength(1);
    expect(ranThere(), "faded copper still leads to the deleted LED").toBe(0);
    // Still stale: what is left is the old plan minus the LED, not a new plan.
    expect(q(modal, ".el-route").classList.contains("is-stale")).toBe(true);
  });

  it("keeps the LED after it on its own pads, not its deleted neighbour's", () => {
    const { modal, pads } = routedTwo();
    tapFlat(modal, mid(pads[0]!));
    expect(modal.selected).toEqual({ kind: "led", index: 0 });
    (globalThis as any).document.dispatch("keydown", { key: "Delete" });
    expect(modal.routed.pads).toHaveLength(1);
    expect(modal.routed.pads[0].pwr).toEqual(pads[1]!.pwr);
    expect(modal.routed.pads[0].gnd).toEqual(pads[1]!.gnd);
  });
});

describe("#64 the wire width box is there as soon as the wire tool is", () => {
  it("shows it greyed with a note while no wire is selected, live once one is, and gone with the tool", () => {
    const modal = openOn(grid(1));
    const sect = q(modal, ".el-wire-sect");
    expect(sect.hidden, "the Wire group is up before the wire tool is armed").toBe(true);

    click(modal, ".el-tool", (b) => b.dataset.tool === "wire");
    expect(sect.hidden, "arming the wire tool did not show the width box").toBe(false);
    expect(q(modal, ".el-wire-width").disabled).toBe(true);
    expect(q(modal, ".el-wire-delete").disabled).toBe(true);
    expect(q(modal, ".el-wire-note").hidden).toBe(false);
    expect(q(modal, ".el-wire-note").textContent).toMatch(/select|tap a wire/i);

    // Drawing one leaves it selected.
    tapFlat(modal, { x: 0.3, y: 0.3 });
    tapFlat(modal, { x: 1.7, y: 0.3 });
    (globalThis as any).document.dispatch("keydown", { key: "Enter" });
    expect(modal.wire.selected()).not.toBeNull();
    expect(q(modal, ".el-wire-width").disabled).toBe(false);
    expect(q(modal, ".el-wire-delete").disabled).toBe(false);
    expect(q(modal, ".el-wire-note").hidden).toBe(true);

    click(modal, ".el-tool", (b) => b.dataset.tool === "led");
    expect(sect.hidden).toBe(true);
  });
});

describe("#64 every small control is a 24 px target (WCAG 2.5.8)", () => {
  const welcome = readFileSync("src/styles-welcome.css", "utf8");
  /** The px a declaration sets in a rule body, or 0. */
  function px(body: string, prop: string): number {
    const m = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+(?:\\.\\d+)?)px`));
    return m ? Number(m[1]) : 0;
  }
  function ruleIn(sheet: string, selector: string): string {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const all = [...sheet.matchAll(new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "gm"))];
    if (!all.length) throw new Error(`no rule for ${selector}`);
    return all.map((m) => m[1]).join(";");
  }
  it.each([
    ["src/styles.css", ".col-collapse"],
    ["src/styles-welcome.css", ".welcome-close"],
    ["src/styles.css", ".el-net-add"],
    ["src/styles.css", ".el-net-twist"],
    ["src/styles.css", ".el-net-colour"],
    ["src/styles.css", ".el-net-del"],
    ["src/styles.css", ".el-net-kid-off"],
    ["src/styles.css", ".el-pad-off"],
    ["src/styles.css", ".el-net-name"],
    ["src/styles.css", ".el-pad-net"],
  ])("%s %s is at least 24 x 24 px", (file, selector) => {
    const body = ruleIn(file.endsWith("welcome.css") ? welcome : css, selector);
    const w = Math.max(px(body, "width"), px(body, "min-width"));
    const h = Math.max(px(body, "height"), px(body, "min-height"));
    // Text inputs are as wide as the column; it is their height that was short.
    if (!/name|pad-net/.test(selector)) expect(w, `${selector} width`).toBeGreaterThanOrEqual(24);
    expect(h, `${selector} height`).toBeGreaterThanOrEqual(24);
  });
});

describe("#64 nothing reachable by Tab or a screen reader is nameless or 2 px wide", () => {
  it("takes the value-holding part select out of the page instead of shrinking it to 2x2 px", () => {
    const select = shellMarkup().match(/<select[^>]*class="el-part"[^>]*>/)?.[0] ?? "";
    expect(select).toMatch(/\shidden(\s|>)/);
    expect(rule(".el-part")).toMatch(/display:\s*none/);
    // The caption names the control a person actually uses: the search box.
    expect(shellMarkup()).toMatch(/<label[^>]*for="el-part-search"/);
  });

  it("names the FKLD viewer's scrolling details panel, which Chrome makes a Tab stop", () => {
    const viewer = readFileSync("public/viewer/index.html", "utf8");
    const aside = viewer.match(/<aside id="sidebar"[^>]*>/)?.[0] ?? "";
    expect(aside).toMatch(/aria-label="[^"]+"/);
    expect(aside).toMatch(/role="region"/);
    expect(aside).toMatch(/tabindex="0"/);
  });
});

/** The element in the page carrying this id (the mock DOM lays the markup out flat). */
function byId(modal: any, id: string | undefined): any {
  return id ? modal.overlay.children.find((c: any) => c.attributes.id === id) : undefined;
}

describe("#64 the toolbar's labels make sense without hovering", () => {
  const GROUPS = [
    { cls: "el-place", label: "Parts go", buttons: ["across a fold", "on a tile"] },
    { cls: "el-build", label: "Sheet", buttons: ["vinyl / paper", "3D-printed tiles"] },
    { cls: "el-face", label: "Copper on", buttons: ["inside face", "outside face"] },
    { cls: "el-view", label: "Show copper as", buttons: ["strips", "carrier frame"] },
  ];

  it.each(GROUPS)("names the $label group in words, on the control itself", ({ cls, label, buttons }) => {
    const modal = openOn(grid(1));
    const btns = modal.overlay.querySelectorAll(`.${cls}`);
    expect(btns.map((b: any) => b.textContent)).toEqual(buttons);
    for (const b of btns) {
      // Labelled by the visible caption and its own text, and described by a sentence a screen reader
      // reads out without anyone hovering for the tooltip.
      const by = (b.attributes["aria-labelledby"] ?? "").split(" ");
      expect(byId(modal, by[0])?.textContent).toBe(label);
      const desc = byId(modal, b.attributes["aria-describedby"]);
      expect(desc, `${b.textContent} has no description`).toBeDefined();
      expect(desc.textContent.length).toBeGreaterThan(30);
    }
  });

  it("drops the old one-word captions", () => {
    const modal = openOn(grid(1));
    const captions = modal.overlay.querySelectorAll(".el-group-label").map((l: any) => l.textContent);
    for (const old of ["Seat", "Build", "Side"]) expect(captions).not.toContain(old);
  });
});
