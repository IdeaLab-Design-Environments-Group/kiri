/**
 * The embedded FKLD viewer (`public/viewer/index.html`), driven the way a person drives it.
 *
 * The page is a standalone HTML document with an inline script, not a view module, so nothing in the
 * suite loaded it and switching a layer on could break with no test noticing -- which is what happened:
 * `svg .vert-text { font-size: 9px }` is read as NINE USER UNITS inside the viewer's `-1 -1 2 2`
 * viewBox, so pressing Vertices, Face Text or Molecules painted a black slab over the whole canvas.
 * The shapes escape that trap with `vector-effect: non-scaling-stroke`; font-size has no equivalent, so
 * the renderer sets it per render and this test holds it there.
 *
 * The DOM stub is local rather than `mock-dom.ts`'s because the page needs what a page needs --
 * `getElementById`, `createElementNS`, `prepend`, `getBoundingClientRect` -- and none of that belongs in
 * the helper the view modules share. It is deliberately strict: `setAttribute` throws on a non-finite
 * number, since an `x="NaN"` is invisible in a browser and fatal to the drawing.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VIEWER = fileURLToPath(new URL("../../../public/viewer/index.html", import.meta.url));
const EXAMPLES = fileURLToPath(new URL("../../../public/examples/", import.meta.url));

/** The canvas the stub reports; the label size is derived from it, so the numbers below are fixed. */
const CANVAS_PX = { width: 900, height: 600 };
/** The viewer's viewBox is 2x2 user units. Anything approaching that swamps the drawing. */
const VIEWBOX_SPAN = 2;

class StubEl {
  readonly children: StubEl[] = [];
  readonly attrs: Record<string, string> = {};
  readonly handlers: Record<string, ((ev: unknown) => void)[]> = {};
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  dataset: Record<string, string> = {};
  textContent = "";
  innerHTML = "";
  value = "";
  className = "";
  checked = false;
  hidden = false;
  type = "";

  constructor(readonly tag: string) {}

  setAttribute(name: string, value: unknown): void {
    const bad = value === undefined || value === null
      || (typeof value === "number" && !Number.isFinite(value));
    if (bad) throw new Error(`<${this.tag} ${name}="${String(value)}">`);
    this.attrs[name] = String(value);
  }
  getAttribute(name: string): string | undefined { return this.attrs[name]; }
  appendChild(child: StubEl): StubEl { this.children.push(child); return child; }
  prepend(child: StubEl): StubEl { this.children.unshift(child); return child; }
  removeChild(child: StubEl): void { this.children.splice(this.children.indexOf(child), 1); }
  remove(): void {}
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.handlers[type] ??= []).push(fn);
  }
  removeEventListener(): void {}
  fire(type: string): void { for (const fn of this.handlers[type] ?? []) fn({}); }
  querySelector(): StubEl { return new StubEl("div"); }
  querySelectorAll(): StubEl[] { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, ...CANVAS_PX }; }
  focus(): void {}
  click(): void {}
}

interface ViewerApi {
  loadObject: (file: unknown, name: string) => void;
  render: () => void;
  layers: Record<string, { on: boolean }>;
  canvas: StubEl;
  status: StubEl;
  toggles: { name: string; press: (on: boolean) => void }[];
}

/** Evaluate the page's own inline script against the stub, and hand back what a test can drive. */
function loadViewer(): ViewerApi {
  const html = readFileSync(VIEWER, "utf8");
  const open = html.indexOf("<script>") + "<script>".length;
  const script = html.slice(open, html.indexOf("</script>", open));

  const byId = new Map<string, StubEl>();
  const document = {
    getElementById(id: string) {
      if (!byId.has(id)) byId.set(id, new StubEl(id));
      return byId.get(id)!;
    },
    createElement: (tag: string) => new StubEl(tag),
    createElementNS: (_ns: string, tag: string) => new StubEl(tag),
    addEventListener() {},
    querySelector: () => new StubEl("div"),
    querySelectorAll: () => [] as StubEl[],
    body: new StubEl("body"),
  };
  const window: Record<string, unknown> = {
    addEventListener() {}, removeEventListener() {},
    location: { search: "" }, devicePixelRatio: 2,
    requestAnimationFrame: () => 0,
  };
  window.parent = window;   // "not in an iframe", so the postMessage handshake stays out of the way

  const api = new Function(
    "document", "window", "FileReader", "requestAnimationFrame", "localStorage",
    `${script}\nreturn { loadObject, render, layers };`,
  )(document, window, class {}, () => 0, { getItem: () => null, setItem: () => {} }) as ViewerApi;

  const group = document.getElementById("toggle-group");
  const toggles = group.children.map((label) => {
    const box = label.children.find((c) => c.tag === "input")!;
    return {
      name: label.textContent,
      press: (on: boolean) => { box.checked = on; box.fire("change"); },
    };
  });
  return {
    ...api,
    canvas: document.getElementById("canvas"),
    status: document.getElementById("status-text"),
    toggles,
  };
}

function example(name: string): unknown {
  return JSON.parse(readFileSync(EXAMPLES + name, "utf8"));
}

const MODELS = readdirSync(EXAMPLES).filter((f) => f.endsWith(".fkld"));

function texts(root: StubEl): StubEl[] {
  const out: StubEl[] = root.tag === "text" ? [root] : [];
  for (const child of root.children) out.push(...texts(child));
  return out;
}

describe("view/fkld-viewer", () => {
  it("has a model to draw", () => {
    expect(MODELS.length).toBeGreaterThan(0);
  });

  it("draws every layer of every bundled model, on and off, without throwing", () => {
    const viewer = loadViewer();
    for (const name of MODELS) {
      viewer.loadObject(example(name), name);
      for (const toggle of viewer.toggles) {
        expect(() => toggle.press(true), `${name}: ${toggle.name} on`).not.toThrow();
        expect(() => toggle.press(false), `${name}: ${toggle.name} off`).not.toThrow();
      }
    }
  });

  it("sizes labels in user units, so a label cannot swamp the viewBox", () => {
    // The regression. Every label the viewer draws is asserted twice: it carries a size at all (a
    // stylesheet px value would be silently read as user units), and that size is a small fraction of
    // the 2-unit viewBox rather than several times it.
    const viewer = loadViewer();
    viewer.loadObject(example("house.fkld"), "house.fkld");
    for (const name of ["Vertices", "Face Text", "Molecules"]) {
      viewer.toggles.find((t) => t.name === name)!.press(true);
    }
    const labels = texts(viewer.canvas);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      const size = Number(label.getAttribute("font-size"));
      expect(size, `<text> with no font-size: ${label.textContent}`).toBeGreaterThan(0);
      expect(size).toBeLessThan(VIEWBOX_SPAN / 10);
    }
  });

  it("scales a label to the canvas: nine pixels of a six-hundred-pixel side", () => {
    // 9px on a 600px side is 9 * 2 / 600 = 0.03 user units. Fixing the arithmetic here means a change
    // to `labelSize` that happens to keep labels "small" but wrong still fails.
    const viewer = loadViewer();
    viewer.loadObject(example("house.fkld"), "house.fkld");
    viewer.toggles.find((t) => t.name === "Vertices")!.press(true);
    const size = Number(texts(viewer.canvas)[0]!.getAttribute("font-size"));
    expect(size).toBeCloseTo((9 * VIEWBOX_SPAN) / Math.min(CANVAS_PX.width, CANVAS_PX.height), 6);
  });

  it("says so when a layer the file has no data for is switched on", () => {
    // `house.fkld` is kirigamized with the dart strategy, so no vertex is tucked, so no edge carries a
    // molecule theta: pressing Molecules correctly draws nothing. Silence there is indistinguishable
    // from a broken toggle -- which is exactly how it was read.
    const viewer = loadViewer();
    viewer.loadObject(example("house.fkld"), "house.fkld");
    viewer.toggles.find((t) => t.name === "Molecules")!.press(true);
    expect(viewer.status.textContent).toMatch(/annotates none/);
  });

  it("stays quiet when the layer does have something to draw", () => {
    const viewer = loadViewer();
    viewer.loadObject(example("akde-hex.fkld"), "akde-hex.fkld");
    viewer.toggles.find((t) => t.name === "Molecules")!.press(true);
    expect(viewer.status.textContent).not.toMatch(/annotates none/);
    expect(texts(viewer.canvas).some((t) => t.textContent.startsWith("θ="))).toBe(true);
  });

  it("points at Vertices when Curvature is switched on alone", () => {
    // Curvature only recolours the vertex dots, so on its own it is a no-op on screen.
    const viewer = loadViewer();
    viewer.loadObject(example("house.fkld"), "house.fkld");
    viewer.toggles.find((t) => t.name === "Curvature")!.press(true);
    expect(viewer.status.textContent).toMatch(/switch Vertices on/);
  });

  it("gives text the same stroke escape hatch the shapes have", () => {
    // The labels carry a white halo (paint-order: stroke). Without non-scaling-stroke its width is read
    // in user units too, and 2 units of halo is the whole canvas.
    const css = readFileSync(VIEWER, "utf8");
    const rule = /svg polygon,[^{]*\{\s*vector-effect: non-scaling-stroke;/.exec(css);
    expect(rule, "the non-scaling-stroke rule moved or was renamed").not.toBeNull();
    expect(rule![0]).toContain("svg text");
  });

  it("states no font-size in CSS pixels for the SVG labels", () => {
    const css = readFileSync(VIEWER, "utf8");
    for (const cls of ["face-text", "vert-text"]) {
      const rule = new RegExp(`svg \\.${cls}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? "";
      expect(rule, `svg .${cls} rule not found`).not.toBe("");
      expect(rule).not.toMatch(/font-size/);
    }
  });
});
