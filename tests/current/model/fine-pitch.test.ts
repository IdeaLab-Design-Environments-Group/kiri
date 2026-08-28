/**
 * Routing copper to a part whose pins are closer together than the tape is wide.
 *
 * A 2.54mm pin header against 3.25mm tape is the case that broke: the clearance gate held every pair of
 * runs a full tape width apart however narrow they actually were, so a second net could never reach a
 * neighbouring pin, and a leg widened back to full tape one segment out of the pad and blanketed the pins
 * either side of the one it landed on. See `net-routing.ts › gapNeeded` and `legWidths`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, type Circuit, type Vec2 } from "../../../src/model/electronics.js";
import {
  landingWidthFor, narrowedTo, partFit, planRoutes, tapeMmFor, tapeWidthFor, type PadField,
} from "../../../src/model/electronics-routing.js";
import { padPosition, resolveNetlist } from "../../../src/model/netlist.js";
import { partShape, stripOutline } from "../../../src/model/copper-svg-export.js";
import { footprintById } from "../../../src/model/library.js";
import { nearestTerminalMm, terminals } from "../../../src/model/footprint.js";
import { DEFAULT_SHEET, minWebMm } from "../../../src/model/fold-strain.js";
import { planNets } from "../../../src/model/net-routing.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;
const XIAO = "SeeedStudio_XIAO_ESP32C3";

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  return { faces, gaps: gapGraph(fold, faces).gaps, tapeW: tapeWidthFor(faces), tapeMm: tapeMmFor(faces) };
}

/**
 * A XIAO standing on the sheet with two nets on ADJACENT pins, each crossing from one row to the pad
 * opposite it. Pads 1 and 14 share a y; 2 and 13 share the next one, one 2.54mm pitch along — so the two
 * legs run parallel, one pitch apart, and neither passes over the other's pads.
 *
 * Deliberately not four pins of one row (1 and 3 against 2 and 4): a leg from pad 1 to pad 3 runs straight
 * over pad 2, which is a genuine short and is rightly refused however narrow the copper is.
 */
function xiaoOnTwoNets(at: Vec2): Circuit {
  return {
    leds: [],
    battery: null,
    parts: [{ component: XIAO, x: at.x, y: at.y, free: true, rot: 0 }],
    nets: [
      { id: "n1", name: "N1", color: "#1f6feb" },
      { id: "n2", name: "N2", color: "#16a34a" },
    ],
    terminals: [
      { part: 0, pad: "1", net: "n1" },
      { part: 0, pad: "14", net: "n1" },
      { part: 0, pad: "2", net: "n2" },
      { part: 0, pad: "13", net: "n2" },
    ],
  };
}

/** Edge-to-edge distance between two sets of closed rings, in the rings' own units; 0 if any pair meets. */
function minRingDist(A: Vec2[][], B: Vec2[][]): number {
  const ptSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
    const ax = b.x - a.x, ay = b.y - a.y, l2 = ax * ax + ay * ay;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ax + (p.y - a.y) * ay) / l2));
    return Math.hypot(p.x - (a.x + ax * t), p.y - (a.y + ay * t));
  };
  const crosses = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
    const o = (p: Vec2, q: Vec2, r: Vec2): number =>
      (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return ((o(a, b, c) > 0) !== (o(a, b, d) > 0)) && ((o(c, d, a) > 0) !== (o(c, d, b) > 0));
  };
  const inRing = (p: Vec2, ring: Vec2[]): boolean => {
    let w = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!, b = ring[j]!;
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) w = !w;
    }
    return w;
  };
  let m = Infinity;
  for (const X of A) for (const Y of B) {
    if (X.some((p) => inRing(p, Y)) || Y.some((p) => inRing(p, X))) return 0;
    for (let i = 0; i < X.length; i++) {
      const a = X[i]!, b = X[(i + 1) % X.length]!;
      for (let j = 0; j < Y.length; j++) {
        const c = Y[j]!, d = Y[(j + 1) % Y.length]!;
        if (crosses(a, b, c, d)) return 0;
        m = Math.min(m, ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
      }
    }
  }
  return m;
}

describe("model/fine-pitch parts", () => {
  it("routes two nets to adjacent pins of a 2.54mm part, which a whole-tape-width clearance made impossible", () => {
    // The reported bug, as the smallest circuit that shows it. Before the clearance gate could read a
    // width, `n2` came back with no copper at all and one stranded terminal, blamed on `n1`.
    const { faces, gaps } = load("house.fkld");
    const r = planRoutes(faces, gaps, xiaoOnTwoNets(faces[0]!.centroid));
    const nets = r.nets ?? [];
    expect(nets).toHaveLength(2);
    for (const n of nets) {
      expect(n.stranded, `net ${n.id}: ${n.why ?? ""}`).toHaveLength(0);
      expect(n.traces.length, `net ${n.id} laid no copper`).toBeGreaterThan(0);
    }
  });

  it("leaves a weedable web between them, because routing something that cannot be weeded is worse than refusing it", () => {
    // "Both nets routed" is not the goal on its own — a router that reached both pins by laying copper
    // that touches would have made the circuit worse, not better. Measured on the real outlines the blade
    // follows (`stripOutline`), not on centrelines.
    const { faces, gaps, tapeW, tapeMm } = load("house.fkld");
    const r = planRoutes(faces, gaps, xiaoOnTwoNets(faces[0]!.centroid));
    const rings = (id: string): Vec2[][] =>
      (r.nets ?? []).filter((n) => n.id === id).flatMap((n) =>
        n.traces.map((t) => stripOutline(t, tapeW, r.pads)).filter((g) => g.length >= 3));
    const webMm = minRingDist(rings("n1"), rings("n2")) * (tapeMm / tapeW);
    expect(webMm).toBeGreaterThanOrEqual(minWebMm(DEFAULT_SHEET));
  });

  it("holds two full-width runs exactly as far apart as it always did, so this is a generalisation and not a re-plan", () => {
    // The guard on the whole change. `gapNeeded` is `max((wA + wB) / 2, weed)`, and for two runs at the
    // tape's own width that is the tape's own width — the constant it replaced. If this ever fails, the
    // gate has started refusing or permitting ordinary copper differently and every recorded reach figure
    // in `net-routing.test.ts` is measuring something else.
    const { faces, gaps, tapeW } = load("house.fkld");
    const nets = [0, 1, 2].map((n) => ({
      id: `n${n}`,
      name: `N${n}`,
      // No `padWidth` anywhere, so every leg is planned at full tape width.
      points: [0, 1, 2].map((m) => ({
        part: m, pad: "1", at: faces[(n + m * 3) % faces.length]!.centroid,
      })),
    }));
    const r = planNets(nets, faces, gaps, tapeW);
    expect(r.traces.every((t) => t.widths === undefined)).toBe(true);
    expect(9 - r.nets.reduce((a, x) => a + x.stranded.length, 0)).toBe(7);
  });

  it("narrows a pad's landing to the room beside it, not merely to the pad's own size", () => {
    // A XIAO's pads are 1.6mm across on a 2.54mm pitch, so the pad's own size is NOT the binding number:
    // full 1.6mm copper on both of two adjacent pins leaves 0.94mm of web, under the 1.1375mm that can be
    // weeded. `landingWidthFor` gives 1.4025mm, which leaves exactly the floor.
    const { faces, tapeW, tapeMm } = load("house.fkld");
    const { nets } = resolveNetlist(xiaoOnTwoNets(faces[0]!.centroid), tapeW, tapeMm, new Set());
    const widthsMm = nets.flatMap((n) => n.points.map((p) => (p.padWidth ?? tapeW) * (tapeMm / tapeW)));
    expect(widthsMm.length).toBe(4);
    for (const w of widthsMm) {
      expect(w).toBeCloseTo(landingWidthFor(2.54, 3.25), 3);
      expect(w).toBeLessThan(1.6); // the pad's own size, which is what it used to be
      expect(2.54 - w).toBeGreaterThanOrEqual(minWebMm(DEFAULT_SHEET) - 1e-9);
    }
  });

  it("does not count a pad's own duplicate as its neighbour, since the two are one piece of metal", () => {
    // The parser mints `1` and `1_1` for a through-hole pad and its surface-mount twin, at the SAME point.
    // Measured on this footprint: 37 terminals, 14 coincident pairs. Read as neighbours they put the room
    // at zero and collapse every landing to the floor — on precisely the parts this rule exists to serve.
    const fp = footprintById(XIAO)!;
    const names = terminals(fp).map(([n]) => n);
    expect(names).toContain("1");
    expect(names).toContain("1_1");
    // Its nearest *distinct* neighbour is a pitch away, not the twin sitting on top of it.
    expect(nearestTerminalMm(fp, "1")).toBeGreaterThan(1);
    expect(nearestTerminalMm(fp, "1")).toBeCloseTo(nearestTerminalMm(fp, "1_1"), 9);
  });

  it("keeps a run narrow for as long as it stands over the part, not just at the pad it ends on", () => {
    // Narrowing only the endpoint left the copper at full tape width by its first interior point — a
    // corridor node, typically millimetres away — so a 3.25mm strip covered the pins either side of the
    // 1.6mm one it landed on. That is what "the wire goes to the closest pin" looked like on screen.
    const tapeW = 1;
    const fields: PadField[] = [{ at: { x: 0, y: 0 }, safe: 0.4, reach: 2 }];
    expect(narrowedTo(tapeW, { x: 0, y: 0 }, fields)).toBeCloseTo(0.4, 9);   // on the pad
    expect(narrowedTo(tapeW, { x: 1.5, y: 0 }, fields)).toBeCloseTo(0.4, 9); // still over the part
    expect(narrowedTo(tapeW, { x: 2.5, y: 0 }, fields)).toBeCloseTo(1, 9);   // clear of it, full width
  });

  it("finishes its taper within a part's own pitch, instead of smearing it across a corridor hop", () => {
    // `legWidths` gives a width per POINT and `outlineStrip` tapers linearly between them, so the profile is
    // only as good as the point spacing. A leg out of a pin runs pad -> corridor node, and a corridor node is
    // a face centre millimetres away: measured on the reported circuit, three points over 24.96mm carrying
    // 1.20mm, 3.03mm and 1.00mm, drawn as a wedge some 3mm wide across four neighbouring pins.
    //
    // Asserted as a PROFILE against distance travelled, not as a point count, so a future change that keeps
    // the taper short by some other means still passes.
    const { faces, gaps, tapeW, tapeMm } = load("house.fkld");
    const at = faces[0]!.centroid;
    const circuit: Circuit = {
      ...xiaoOnTwoNets(at),
      nets: [{ id: "s", name: "S", color: "#1f6feb" }],
      parts: [
        { component: XIAO, x: at.x, y: at.y, free: true, rot: 0 },
        { component: "R_1206", x: at.x + 0.35, y: at.y, free: true, rot: 0 },
      ],
      terminals: [{ part: 1, pad: "1", net: "s" }, { part: 0, pad: "7", net: "s" }],
    };
    const r = planRoutes(faces, gaps, circuit);
    const k = tapeMm / tapeW;
    const laid = (r.nets ?? []).flatMap((n) => n.traces).filter((t) => t.widths);
    expect(laid.length, "the fixture is meant to lay tapered copper").toBeGreaterThan(0);

    for (const t of laid) {
      // The property that actually forbids a wedge: **wherever the width changes, it changes over a short
      // distance.** `outlineStrip` ramps linearly between consecutive points, so a long segment whose ends
      // carry different widths IS a wedge — that is exactly what the reported circuit had, 1.20mm to 3.03mm
      // across a single 12.5mm hop.
      //
      // Stated as a gradient rather than as "the taper finishes by Xmm", because the width legitimately
      // follows the metal along the whole leg: this part's pads are 2.54mm apart and the leg passes near
      // many of them, so it narrows and widens repeatedly. What must never happen is one of those changes
      // being smeared across a corridor hop.
      let worstRamp = 0;
      let worstAt = 0;
      for (let i = 1; i < t.pts.length; i++) {
        const seg = Math.hypot(t.pts[i]!.x - t.pts[i - 1]!.x, t.pts[i]!.y - t.pts[i - 1]!.y) * k;
        const dw = Math.abs((t.widths![i] ?? tapeW) - (t.widths![i - 1] ?? tapeW)) * k;
        if (dw > 0.05 && seg > worstRamp) { worstRamp = seg; worstAt = dw; }
      }
      // One tape width: `densifyNearFields` splits at half that, so a change can never span more than one
      // step plus rounding. Before the fix this was 12.5mm.
      expect(worstRamp, `a ${worstAt.toFixed(2)}mm width change ramped over ${worstRamp.toFixed(2)}mm`)
        .toBeLessThanOrEqual(tapeMm);
      // And it starts narrow: full tape width at the pad itself is what blankets the neighbouring pins.
      expect((t.widths![0] ?? tapeW) * k, "the leg starts at full tape width").toBeLessThan(2);
    }
  });

  it("puts every pin where the canvas draws it, so a disagreement cannot hide behind a plausible drawing", () => {
    // The natural first hypothesis for "copper goes to the wrong pin", and it is wrong: the two positions
    // agree exactly. Kept as a test because they are computed twice from one footprint — `padPosition` for
    // the routing and `rowLeads` for the drawing — and `parts.ts › padRunBox` records what it costs when
    // two such readings drift.
    //
    // Read in ONE frame: `padPosition` answers in flat pattern units and `partShape` in sheet millimetres,
    // and comparing them unconverted shows a bogus half-metre error rather than agreement.
    const { faces, tapeW, tapeMm } = load("house.fkld");
    const at = faces[0]!.centroid;
    const fp = footprintById(XIAO)!;
    const k = tapeMm / tapeW;
    const mm = (p: Vec2): Vec2 => ({ x: p.x * k, y: p.y * k });
    const part = xiaoOnTwoNets(at).parts![0]!;
    // The span the part is drawn on, exactly as `electronics-modal.ts › freeParts` builds it: the part's
    // own `partFit.gap` long, centred on the drop point, along `rot` (which is 0 here).
    const half = ((partFit(fp).gap * tapeW) / tapeMm) / 2;
    const shape = partShape(fp, mm({ x: at.x - half, y: at.y }), mm({ x: at.x + half, y: at.y }), false);
    expect(shape).not.toBeNull();

    let compared = 0;
    for (const [name] of terminals(fp)) {
      const routed = padPosition(part, fp, name, tapeW, tapeMm);
      const lead = shape!.leads.find((l) => l.name === name);
      if (!routed || !lead) continue;
      const drawn = { x: (lead.a.x + lead.b.x) / 2, y: (lead.a.y + lead.b.y) / 2 };
      expect(Math.hypot(mm(routed).x - drawn.x, mm(routed).y - drawn.y), `pad ${name}`).toBeLessThan(1e-6);
      compared++;
    }
    // Or the loop above proves nothing by comparing nothing.
    expect(compared).toBe(terminals(fp).length);
  });

  it("runs the copper all the way to the pad the canvas draws, through the whole planner", () => {
    // The leg the other tests in this file do not cover: `padPosition` and `partShape` agreeing is one
    // thing, and `planRoutes` actually finishing a net on that point is another. Measured on
    // `Module_XIAO_Generic_SocketSMD`, the staggered socket the mirror was reported on.
    //
    // **What this cannot show, and it is worth saying so here.** A reflection preserves every distance, so
    // no measurement of "how far is the copper from pad 1" can see one — the pad and the copper move
    // together. Handedness is the only thing that can, and it is pinned in `placed-component.test.ts ›
    // seats a two-row part the way round the datasheet draws it`. This test is about reach, not handedness.
    const SOCKET = "Module_XIAO_Generic_SocketSMD";
    const { faces, gaps, tapeW, tapeMm } = load("house.fkld");
    const k = tapeMm / tapeW;
    const fp = footprintById(SOCKET)!;
    const parts = [
      { component: SOCKET, x: faces[0]!.centroid.x, y: faces[0]!.centroid.y, free: true, rot: 0 },
      { component: "C_1206", x: faces[1]!.centroid.x, y: faces[1]!.centroid.y, free: true, rot: 0 },
    ];
    const circuit: Circuit = {
      leds: [], battery: null, parts,
      nets: [{ id: "sig", name: "SIG", color: "#1f6feb" }],
      terminals: [{ part: 0, pad: "1", net: "sig" }, { part: 1, pad: "1", net: "sig" }],
    };
    const routed = planRoutes(faces, gaps, circuit);
    const sig = routed.traces.filter((t) => t.net === "sig");
    expect(sig.length, "the net laid no copper at all").toBeGreaterThan(0);

    // Pad 1 as the CANVAS has it, off `partShape` — the drawing is what the author is looking at when they
    // say the wire went to the wrong pin.
    const half = ((partFit(fp).gap * tapeW) / tapeMm) / 2;
    const mm = (p: Vec2): Vec2 => ({ x: p.x * k, y: p.y * k });
    const at = faces[0]!.centroid;
    const shape = partShape(fp, mm({ x: at.x - half, y: at.y }), mm({ x: at.x + half, y: at.y }), false)!;
    const lead = shape.leads.find((l) => l.name === "1")!;
    const drawn = { x: (lead.a.x + lead.b.x) / 2, y: (lead.a.y + lead.b.y) / 2 };

    const ends = sig.flatMap((t) => [t.pts[0]!, t.pts.at(-1)!]);
    const reach = Math.min(...ends.map((e) => Math.hypot(mm(e).x - drawn.x, mm(e).y - drawn.y)));
    expect(reach, "no copper ends on the pad the canvas labels 1").toBeLessThan(1e-6);
  });
});

describe("model/net-routing ratsnest", () => {
  it("says nothing at all about a net that routed whole", () => {
    // The property svg-pcb's shipped ratsnest lacks: its lines are drawn from the declared netlist alone
    // and stay on screen however much copper you lay. These are derived from what was laid, so they go.
    const { faces, gaps } = load("house.fkld");
    const r = planRoutes(faces, gaps, xiaoOnTwoNets(faces[0]!.centroid));
    for (const n of r.nets ?? []) {
      expect(n.stranded).toHaveLength(0);
      expect(n.ratsnest, `net ${n.id} routed whole but still has a ratsnest`).toBeUndefined();
    }
  });

  it("draws one line per terminal it could not reach, so a lost pad is visible and not merely absent", () => {
    // A net that loses a pad otherwise looks on the canvas exactly like one that did not.
    const { faces, gaps, tapeW } = load("church.fkld");
    const nets = [0, 1, 2].map((n) => ({
      id: `n${n}`,
      name: `N${n}`,
      points: [0, 1, 2].map((m) => ({
        part: m, pad: "1", at: faces[(n + m * 3) % faces.length]!.centroid,
      })),
    }));
    const r = planNets(nets, faces, gaps, tapeW);
    const short = r.nets.filter((n) => n.stranded.length);
    expect(short.length, "this fixture is meant to strand something").toBeGreaterThan(0);
    for (const n of short) {
      expect(n.ratsnest ?? []).toHaveLength(n.stranded.length);
      // Each line starts on the terminal it is about, and goes somewhere else.
      for (const [a, b] of n.ratsnest ?? []) {
        expect(n.stranded.some((i) => nets.find((x) => x.id === n.id)!.points[i]!.at === a)).toBe(true);
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0);
      }
    }
  });
});
