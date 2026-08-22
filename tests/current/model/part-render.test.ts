import { describe, expect, it } from "vitest";
import { PCB_COLOURS, designators, partSvg } from "../../../src/model/part-render.js";
import { partShape, type ResistorShape } from "../../../src/model/copper-svg-export.js";
import { BAT_COIN_20, R_1206, SW_SPDT, type Footprint } from "../../../src/model/footprints.generated.js";
import { padNamed, padPoints, padSize } from "../../../src/model/footprint.js";
import type { Vec2 } from "../../../src/model/electronics.js";

/** The numbers out of an SVG path's `d`, as points. */
function pathPoints(d: string): Vec2[] {
  const n = d.match(/-?\d+(\.\d+)?([eE][-+]?\d+)?/g)?.map(Number) ?? [];
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push({ x: n[i]!, y: n[i + 1]! });
  return out;
}

function dOf(el: string): string {
  return el.match(/ d="([^"]*)"/)?.[1] ?? "";
}

function bbox(pts: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const fills = (els: string[], colour: string): string[] =>
  els.filter((e) => e.includes(`fill="${colour}"`));

/** A hand-built shape, so a test can say exactly what rectangle a pad is asked to fill. */
function leadShape(leads: ResistorShape["leads"], body?: Partial<ResistorShape["body"]>): ResistorShape {
  return {
    leads,
    body: { x: 0, y: 0, w: 10, h: 4, angle: 0, cx: 5, cy: 0, ...body },
  };
}

describe("PCB_COLOURS", () => {
  it("is the PCB layer palette, exactly", () => {
    expect(PCB_COLOURS).toEqual({
      copper: "#be7a27",
      mask: "#ffa50a",
      padLabel: "#ffff99",
      componentLabel: "#00e5e5",
      origin: "#8b1a1a",
    });
  });
});

describe("designators", () => {
  it("numbers within a family, in placement order", () => {
    const got = designators(
      ["R_1206", "C_1206", "R_2010", "SW_SPDT", "C_1206"].map((component) => ({ component })),
    );
    expect(got).toEqual(["R1", "C1", "R2", "SW1", "C2"]);
  });

  it("takes the family from the id up to the first underscore", () => {
    expect(designators([{ component: "LED_1206" }, { component: "BAT_COIN_20" }])).toEqual(["LED1", "BAT1"]);
  });

  it("gives a nameless component a designator rather than an empty one", () => {
    expect(designators([{ component: "" }, { component: "" }])).toEqual(["U1", "U2"]);
  });

  it("is empty for no parts", () => {
    expect(designators([])).toEqual([]);
  });
});

describe("partSvg pads", () => {
  /** A lead running up the page: the pad's own y extent along it, its x extent across. */
  const upright = leadShape([{ a: { x: 20, y: 4 }, b: { x: 20, y: 12 }, width: 8, name: "2" }]);

  it("draws the pad's TRUE outline, not a stand-in rectangle", () => {
    const els = partSvg(BAT_COIN_20, upright, "BT1");
    const copper = pathPoints(dOf(fills(els, PCB_COLOURS.copper)[0]!));
    // The coin cell's centre pad is a circle: as many points as the footprint's own path has, and every
    // one of them the same distance from the centre.
    expect(copper.length).toBe(padPoints(padNamed(BAT_COIN_20, "2")).length);
    const r = copper.map((p) => Math.hypot(p.x - 20, p.y - 8));
    // Loose only by the four decimals the path is written to; a square would be out by 40%.
    expect(Math.max(...r) - Math.min(...r)).toBeLessThan(1e-3);
  });

  it("maps that outline onto the rectangle the lead already describes", () => {
    const els = partSvg(BAT_COIN_20, upright, "BT1");
    const b = bbox(pathPoints(dOf(fills(els, PCB_COLOURS.copper)[0]!)));
    // Exactly the lead's rectangle: 8mm along the segment, 6mm across it, centred on its midpoint.
    expect(b.y1 - b.y0).toBeCloseTo(8, 6);
    expect(b.x1 - b.x0).toBeCloseTo(8, 6);
    expect((b.x0 + b.x1) / 2).toBeCloseTo(20, 6);
    expect((b.y0 + b.y1) / 2).toBeCloseTo(8, 6);
  });

  it("takes placement from the lead alone — moving the lead moves the pad by the same amount", () => {
    const moved = leadShape([{ a: { x: 23, y: 9 }, b: { x: 23, y: 17 }, width: 8, name: "2" }]);
    const at = (sh: ResistorShape) => pathPoints(dOf(fills(partSvg(BAT_COIN_20, sh, "BT1"), PCB_COLOURS.copper)[0]!));
    const before = at(upright), after = at(moved);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!.x).toBeCloseTo(before[i]!.x + 3, 6);
      expect(after[i]!.y).toBeCloseTo(before[i]!.y + 5, 6);
    }
  });

  it("follows the lead's rotation", () => {
    // The same lead turned a quarter turn about its own centre: the outline turns with it.
    const turned = leadShape([{ a: { x: 16, y: 8 }, b: { x: 24, y: 8 }, width: 6, name: "1" }]);
    const b = bbox(pathPoints(dOf(fills(partSvg(BAT_COIN_20, turned, "BT1"), PCB_COLOURS.copper)[0]!)));
    expect(b.x1 - b.x0).toBeCloseTo(8, 6);
    expect(b.y1 - b.y0).toBeCloseTo(6, 6);
  });

  it("falls back to the plain rectangle for a lead with no name", () => {
    const els = partSvg(R_1206, leadShape([{ a: { x: 0, y: 0 }, b: { x: 0, y: 8 }, width: 6 }]), "R1");
    const pts = pathPoints(dOf(fills(els, PCB_COLOURS.copper)[0]!));
    expect(pts).toHaveLength(4);
    expect(bbox(pts)).toEqual({ x0: -3, y0: 0, x1: 3, y1: 8 });
  });

  it("falls back to the plain rectangle for a name the footprint does not have", () => {
    const els = partSvg(R_1206, leadShape([{ a: { x: 0, y: 0 }, b: { x: 0, y: 8 }, width: 6, name: "99" }]), "R1");
    expect(pathPoints(dOf(fills(els, PCB_COLOURS.copper)[0]!))).toHaveLength(4);
  });

  it("paints copper first and the mask opening over it, held back to leave a copper edge", () => {
    // Deliberately not square, so an opening held back by a fraction of each side rather than by an even
    // rim would show up as a differently shaped pad.
    const els = partSvg(BAT_COIN_20, leadShape([{ a: { x: 20, y: 4 }, b: { x: 20, y: 12 }, width: 5, name: "2" }]), "BT1");
    const copperAt = els.findIndex((e) => e.includes(`fill="${PCB_COLOURS.copper}"`));
    const maskAt = els.findIndex((e) => e.includes(`fill="${PCB_COLOURS.mask}"`));
    expect(copperAt).toBeLessThan(maskAt);
    const c = bbox(pathPoints(dOf(els[copperAt]!)));
    const m = bbox(pathPoints(dOf(els[maskAt]!)));
    expect(m.x1 - m.x0).toBeLessThan(c.x1 - c.x0);
    expect(m.y1 - m.y0).toBeLessThan(c.y1 - c.y0);
    // Held back evenly, so the edge reads as a rim on the pad and not as a second, differently shaped pad.
    expect((c.x1 - c.x0) - (m.x1 - m.x0)).toBeCloseTo((c.y1 - c.y0) - (m.y1 - m.y0), 6);
  });

  it("skips a lead with no length rather than dividing by it", () => {
    const els = partSvg(R_1206, leadShape([{ a: { x: 1, y: 1 }, b: { x: 1, y: 1 }, width: 2, name: "1" }]), "R1");
    expect(fills(els, PCB_COLOURS.copper)).toHaveLength(0);
    expect(els.join("")).not.toContain("NaN");
  });
});

describe("partSvg holes, labels and origin", () => {
  const sw = partShape(SW_SPDT, { x: 10, y: 20 }, { x: 34, y: 27 })!;

  it("draws each mounting hole as a ring, after the pads", () => {
    const els = partSvg(SW_SPDT, sw, "SW1");
    const rings = els.filter((e) => e.startsWith("<circle") && e.includes('fill="none"'));
    // Two pegs, each an annulus of copper with the mask over it.
    expect(rings).toHaveLength(2 * (sw.holes ?? []).length);
    expect(els.indexOf(rings[0]!)).toBeGreaterThan(els.findIndex((e) => e.includes(`fill="${PCB_COLOURS.mask}"`)));
  });

  it("writes each pad's own name on it, in the label colour", () => {
    const els = partSvg(SW_SPDT, sw, "SW1");
    const texts = els.filter((e) => e.includes(PCB_COLOURS.padLabel));
    expect(texts).toHaveLength(3);
    expect(texts.map((t) => t.replace(/.*>([^<]*)<.*/, "$1")).sort()).toEqual(["1", "2", "3"]);
  });

  it("leaves the pad names out when the caller asks for none, but keeps the copper", () => {
    const els = partSvg(SW_SPDT, sw, "SW1", { labels: false });
    expect(els.filter((e) => e.includes(PCB_COLOURS.padLabel))).toHaveLength(0);
    expect(fills(els, PCB_COLOURS.copper).length).toBeGreaterThan(0);
    expect(els.filter((e) => e.includes(PCB_COLOURS.componentLabel))).toHaveLength(1);
  });

  it("puts the designator beside the part — further out than any of its copper", () => {
    const els = partSvg(SW_SPDT, sw, "SW1");
    const t = els.find((e) => e.includes(PCB_COLOURS.componentLabel))!;
    expect(t).toContain(">SW1<");
    const at = { x: Number(t.match(/x="([^"]*)"/)![1]), y: Number(t.match(/y="([^"]*)"/)![1]) };
    const d = Math.hypot(at.x - sw.body.cx, at.y - sw.body.cy);
    const u = { x: (at.x - sw.body.cx) / d, y: (at.y - sw.body.cy) / d };
    const out = (p: Vec2) => (p.x - sw.body.cx) * u.x + (p.y - sw.body.cy) * u.y;
    const pads = fills(els, PCB_COLOURS.copper).flatMap((e) => pathPoints(dOf(e)));
    expect(out(at)).toBeGreaterThan(Math.max(...pads.map(out)));
  });

  it("takes the part's narrow way out, so a two-row part's designator is not up its own run", () => {
    const els = partSvg(SW_SPDT, sw, "SW1");
    const t = els.find((e) => e.includes(PCB_COLOURS.componentLabel))!;
    const at = { x: Number(t.match(/x="([^"]*)"/)![1]), y: Number(t.match(/y="([^"]*)"/)![1]) };
    // The rail steps across the switch, so it runs along the body's short axis; the designator must not.
    const rad = (sw.body.angle * Math.PI) / 180;
    const alongRun = Math.abs(-(at.x - sw.body.cx) * Math.sin(rad) + (at.y - sw.body.cy) * Math.cos(rad));
    const acrossRun = Math.abs((at.x - sw.body.cx) * Math.cos(rad) + (at.y - sw.body.cy) * Math.sin(rad));
    expect(acrossRun).toBeGreaterThan(alongRun * 4);
  });

  it("outlines the pad's boundary in mask, so it reads on a copper ground as well as on white", () => {
    const els = partSvg(SW_SPDT, sw, "SW1");
    for (const e of fills(els, PCB_COLOURS.copper)) {
      expect(e).toContain(`stroke="${PCB_COLOURS.mask}"`);
      expect(Number(e.match(/stroke-width="([^"]*)"/)![1])).toBeGreaterThan(0);
    }
  });

  it("marks the part's origin with a dot at the body's centre", () => {
    const els = partSvg(SW_SPDT, sw, "SW1");
    const dot = els.find((e) => e.includes(PCB_COLOURS.origin))!;
    expect(Number(dot.match(/cx="([^"]*)"/)![1])).toBeCloseTo(sw.body.cx, 3);
    expect(Number(dot.match(/cy="([^"]*)"/)![1])).toBeCloseTo(sw.body.cy, 3);
    expect(Number(dot.match(/ r="([^"]*)"/)![1])).toBeGreaterThan(0);
  });
});

describe("partSvg text sizing", () => {
  const rectLead = (w: number, len: number, name: string): ResistorShape =>
    leadShape([{ a: { x: 0, y: -len / 2 }, b: { x: 0, y: len / 2 }, width: w, name }]);

  const sizeOf = (el: string) => Number(el.match(/font-size="([^"]*)"/)![1]);

  it("sizes a pad's label from the pad, not from a fixed value", () => {
    const small = partSvg(R_1206, rectLead(2, 1.7, "1"), "R1");
    const large = partSvg(R_1206, rectLead(8, 6.8, "1"), "R1");
    const s = sizeOf(small.find((e) => e.includes(PCB_COLOURS.padLabel))!);
    const l = sizeOf(large.find((e) => e.includes(PCB_COLOURS.padLabel))!);
    expect(l).toBeCloseTo(s * 4, 5);
  });

  it("keeps a long name inside the pad by shrinking it", () => {
    // The same pad twice, once named "1" and once named something six characters long.
    const long: Footprint = { COMMON: { ...padNamed(R_1206, "1"), index: 1 } };
    const one = partSvg(R_1206, rectLead(2.5, 6, "1"), "S1", { scale: 4 });
    const many = partSvg(long, rectLead(2.5, 6, "COMMON"), "S1", { scale: 4 });
    expect(sizeOf(many.find((e) => e.includes(PCB_COLOURS.padLabel))!))
      .toBeLessThan(sizeOf(one.find((e) => e.includes(PCB_COLOURS.padLabel))!));
  });

  it("suppresses a name the pad is too small to hold, keeping the pad and its designator", () => {
    const els = partSvg(R_1206, rectLead(0.3, 0.25, "1"), "R1");
    expect(els.filter((e) => e.includes(PCB_COLOURS.padLabel))).toHaveLength(0);
    expect(els.filter((e) => e.includes(PCB_COLOURS.componentLabel))).toHaveLength(1);
    expect(fills(els, PCB_COLOURS.copper)).toHaveLength(1);
  });

  it("suppresses text the caller's zoom would make unreadable, and keeps it when zoomed in", () => {
    const pad = rectLead(2, 1.7, "1");
    expect(partSvg(R_1206, pad, "R1", { scale: 0.05 }).filter((e) => e.includes("<text"))).toHaveLength(0);
    expect(partSvg(R_1206, pad, "R1", { scale: 4 }).filter((e) => e.includes("<text"))).toHaveLength(2);
  });

  it("keeps every label upright, whatever angle the part is placed at", () => {
    const slanted = partShape(SW_SPDT, { x: 10, y: 20 }, { x: 34, y: 27 })!;
    for (const e of partSvg(SW_SPDT, slanted, "SW1", { scale: 6 }).filter((x) => x.includes("<text"))) {
      expect(e).not.toContain("rotate");
      expect(e).not.toContain("transform");
    }
  });

  it("gives every part in a drawing the same designator, whatever size its pads are", () => {
    const a = partShape(R_1206, { x: 0, y: 0 }, { x: 12, y: 0 })!;
    const b = partShape(SW_SPDT, { x: 0, y: 30 }, { x: 12, y: 30 })!;
    const of = (fp: Footprint, sh: ResistorShape) =>
      sizeOf(partSvg(fp, sh, "X1").find((e) => e.includes(PCB_COLOURS.componentLabel))!);
    expect(of(R_1206, a)).toBe(of(SW_SPDT, b));
  });

  it("escapes anything it writes into the document", () => {
    const odd: Footprint = { '<a&b"c>': { ...padNamed(R_1206, "1"), index: 1 } };
    const els = partSvg(odd, rectLead(20, 20, '<a&b"c>'), '<R&1>');
    const text = els.filter((e) => e.includes("<text")).join("");
    expect(text).toContain("&lt;a&amp;b&quot;c&gt;");
    expect(text).toContain("&lt;R&amp;1&gt;");
    expect(text).not.toMatch(/>[^<]*<a/);
  });
});

describe("partSvg on the library's real placements", () => {
  it("draws every library part at the size its own pads say", () => {
    for (const fp of [R_1206, SW_SPDT, BAT_COIN_20]) {
      const sh = partShape(fp, { x: 10, y: 20 }, { x: 34, y: 27 })!;
      const els = partSvg(fp, sh, "X1");
      expect(fills(els, PCB_COLOURS.copper)).toHaveLength(sh.leads.length);
      for (let i = 0; i < sh.leads.length; i++) {
        const l = sh.leads[i]!;
        const pts = pathPoints(dOf(fills(els, PCB_COLOURS.copper)[i]!));
        // Measured in the lead's own frame, since the part is placed on a slant.
        const len = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
        const d = { x: (l.b.x - l.a.x) / len, y: (l.b.y - l.a.y) / len };
        const span = (u: Vec2) => {
          const v = pts.map((q) => q.x * u.x + q.y * u.y);
          return Math.max(...v) - Math.min(...v);
        };
        const size = padSize(padNamed(fp, l.name!));
        // The drawn pad is the footprint's own pad, to the millimetre.
        const dims = [span(d), span({ x: -d.y, y: d.x })].sort((p, q) => p - q);
        expect(dims[0]).toBeCloseTo(Math.min(size.w, size.h), 6);
        expect(dims[1]).toBeCloseTo(Math.max(size.w, size.h), 6);
      }
    }
  });

  it("centres each pad's name on that pad, and emits no NaN", () => {
    for (const fp of [R_1206, SW_SPDT, BAT_COIN_20]) {
      const sh = partShape(fp, { x: 0, y: 0 }, { x: 0, y: 18 })!;
      const els = partSvg(fp, sh, "X1", { scale: 8 });
      expect(els.join("")).not.toContain("NaN");
      const texts = els.filter((e) => e.includes(PCB_COLOURS.padLabel));
      expect(texts).toHaveLength(sh.leads.length);
      for (let i = 0; i < sh.leads.length; i++) {
        const l = sh.leads[i]!;
        expect(Number(texts[i]!.match(/x="([^"]*)"/)![1])).toBeCloseTo((l.a.x + l.b.x) / 2, 3);
        expect(Number(texts[i]!.match(/y="([^"]*)"/)![1])).toBeCloseTo((l.a.y + l.b.y) / 2, 3);
      }
    }
  });
});
