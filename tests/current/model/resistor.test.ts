import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type Circuit, type Vec2 } from "../../../src/model/electronics.js";
import {
  RESISTOR_MM,
  SWITCH_PITCH_MM,
  SWITCH_ROW_MM,
  breakRuns,
  planRoutes,
  tapeWidthFor,
  totalLength,
} from "../../../src/model/electronics-routing.js";
import {
  buildCopperCarrierExport,
  buildCopperSvgExport,
  resistorShape,
  stripOutline,
  switchShape,
} from "../../../src/model/copper-svg-export.js";
import { printScale } from "../../../src/model/print-scale.js";
import { holes, padAt } from "../../../src/model/footprint.js";
import { RESISTOR, SPDT } from "../../../src/model/parts.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** house, and the midpoint of its PWR run — somewhere a resistor can sit.
 *
 *  One LED by default. Three when both rails need a run longer than the resistor's body: with one, house's
 *  GND run is 5.7mm end to end and cannot take a 6.5mm part at all. */
function fixture(leds = 1) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}house.fkld`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const seen = new Set<string>();
  const chosen = [];
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const key = `${l.a}_${l.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(l);
    if (chosen.length >= leds) break;
  }
  const base: Circuit = { leds: chosen, battery: { face: 0 } };
  const plain = planRoutes(faces, gaps, base);
  const pwr = plain.traces.find((t) => t.net === "pwr")!;
  const mid = pwr.pts[Math.floor(pwr.pts.length / 2)]!;
  return { fold, faces, gaps, base, plain, mid, tapeW: tapeWidthFor(faces), k: printScale(fold) };
}

/** Every fill and stroke colour used in a chunk of SVG, lowercased. */
function paintIn(svg: string): Set<string> {
  return new Set(
    [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1]!.toLowerCase()),
  );
}

describe("model/resistor", () => {
  it("breaks the copper it sits on, instead of narrowing it", () => {
    // Both a resistor's ends are on +. Tape running underneath therefore shorts it out and the LEDs see the
    // full battery — so unlike an LED, which straddles the two nets and only needs the strip pinched, this
    // has to be a real gap in the copper.
    const { faces, gaps, base, plain, mid, k } = fixture();
    const withRes = planRoutes(faces, gaps, { ...base, resistors: [mid] });

    const pwrBefore = plain.traces.filter((t) => t.net === "pwr").length;
    const pwrAfter = withRes.traces.filter((t) => t.net === "pwr").length;
    expect(pwrAfter).toBe(pwrBefore + 1); // one run became two

    const removed = (totalLength(plain.traces) - totalLength(withRes.traces)) * k;
    expect(removed).toBeCloseTo(RESISTOR_MM, 1); // exactly the body's length of copper
  });

  it("reports where the leads land, so the part can be drawn on the break", () => {
    const { faces, gaps, base, mid, tapeW, k } = fixture();
    const r = planRoutes(faces, gaps, { ...base, resistors: [mid] });
    expect(r.resistors).toHaveLength(1);
    const { a, b } = r.resistors[0]!;
    // The two ends are the cut ends of the run: a body's length apart along it, so at most that in a line.
    const span = Math.hypot(a.x - b.x, a.y - b.y) * k;
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThanOrEqual(RESISTOR_MM + 1e-6);
    // And they are on the copper's centreline, not somewhere off the run.
    const near = r.traces
      .filter((t) => t.net === "pwr")
      .some((t) => t.pts.some((p) => Math.hypot(p.x - a.x, p.y - a.y) < tapeW * 0.01));
    expect(near).toBe(true);
  });

  it("breaks whichever rail it is put on", () => {
    // In series is in series: a resistor limits the current the same on the way out as on the way back, so
    // either rail will take one.
    // Three LEDs: with one, house's GND run is too short to hold a resistor (see the test below).
    const { faces, gaps, base, plain, k } = fixture(3);
    const runLength = (t: { pts: { x: number; y: number }[] }): number => {
      let s = 0;
      for (let i = 1; i < t.pts.length; i++) s += Math.hypot(t.pts[i]!.x - t.pts[i - 1]!.x, t.pts[i]!.y - t.pts[i - 1]!.y);
      return s;
    };
    for (const net of ["pwr", "gnd"] as const) {
      // The longest run of this net — a run shorter than the body cannot take one, see below.
      const run = plain.traces
        .filter((t) => t.net === net)
        .sort((x, y) => runLength(y) - runLength(x))[0]!;
      const at = run.pts[Math.floor(run.pts.length / 2)]!;
      const r = planRoutes(faces, gaps, { ...base, resistors: [at] });
      const before = plain.traces.filter((t) => t.net === net).length;
      expect(r.traces.filter((t) => t.net === net), `${net} run split`).toHaveLength(before + 1);
      expect(r.resistors).toHaveLength(1);
      expect((totalLength(plain.traces) - totalLength(r.traces)) * k).toBeCloseTo(RESISTOR_MM, 1);
    }
  });

  it("leaves a run too short to hold one alone", () => {
    // Breaking a run shorter than the part would take all its copper and strand whatever it feeds. Better a
    // part whose leads need bending than a branch that quietly loses its supply. Tested on `breakRuns`
    // directly: with a 1206's 1.42mm gap no bundled run is short enough to show it.
    const run = { net: "pwr" as const, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
    const wide = breakRuns([run], [{ x: 0.5, y: 0 }], 4); // a part four times the run's length
    expect(wide.traces).toEqual([run]);
    expect(wide.placed).toEqual([]);

    // One that does fit still breaks it.
    const fits = breakRuns([run], [{ x: 0.5, y: 0 }], 0.4);
    expect(fits.traces).toHaveLength(2);
    expect(fits.placed).toHaveLength(1);
  });

  it("lays its contacts across the tape, not along it", () => {
    // The join is a band of lead pressed over the copper. Drawn along the run it read as a line down the
    // middle of the tape, which is not where a lead touches.
    const { faces, gaps, base, mid, k } = fixture();
    const r = planRoutes(faces, gaps, { ...base, resistors: [mid] });
    // Into sheet millimetres, which is what both the canvas and the cut files draw in — and what the
    // footprint is in, now that the part is drawn at its own size rather than the tape's.
    const { a: fa, b: fb } = r.resistors[0]!;
    const a = { x: fa.x * k, y: fa.y * k }, b = { x: fb.x * k, y: fb.y * k };
    const sh = resistorShape(a, b)!;
    expect(sh.leads).toHaveLength(2);
    // And the body reaches both of them: drawn shorter than the break, the part came out as three
    // disconnected pieces with bare pattern showing between the black and each grey contact.
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    expect(sh.body.w).toBeGreaterThanOrEqual(span);
    const run = { x: b.x - a.x, y: b.y - a.y };
    const runLen = Math.hypot(run.x, run.y);
    for (const l of sh.leads) {
      const across = { x: l.b.x - l.a.x, y: l.b.y - l.a.y };
      // Square to the run: the dot product of the two directions is nil.
      const dot = (across.x * run.x + across.y * run.y) / (Math.hypot(across.x, across.y) * runLen);
      expect(Math.abs(dot)).toBeLessThan(1e-9);
      // The contact is the part's own pad, not a band the width of whatever tape it happens to sit on.
      expect(Math.hypot(across.x, across.y)).toBeCloseTo(RESISTOR.pad.h, 9);
      expect(l.width).toBeCloseTo(RESISTOR.pad.w, 9);
    }
  });

  it("is drawn on both cut files, and cut on neither", () => {
    // The part is not copper. A cut along it would slice the tape it is bridging.
    //
    // Asserted against whatever the part is actually painted with rather than against pinned hexes. This
    // test used to name the two colours the old drawing happened to use, which made it a mirror of the
    // paint: it broke the moment parts were redrawn, for reasons that had nothing to do with the thing it
    // exists to guard. What matters is that no colour the part is drawn in turns up in the copper the
    // blade follows — and that holds however the part is painted.
    const { fold, faces, gaps, base, mid, tapeW } = fixture();
    const r = planRoutes(faces, gaps, { ...base, resistors: [mid] });

    const strips = buildCopperSvgExport(fold, r.traces, tapeW, "k", r.pads, undefined, undefined, r.resistors);
    expect(strips.svg).toContain('id="parts"');
    // The parts layer is emitted last, so it runs to the end of the file.
    const partPaint = paintIn(strips.svg.slice(strips.svg.indexOf('<g id="parts"')));
    expect(partPaint.size, "the part must actually be drawn").toBeGreaterThan(0);

    const carrier = buildCopperCarrierExport(
      fold, r.traces, tapeW, "k", [], undefined, undefined, r.pads, r.resistors,
    );
    // The carrier group only: it is filled copper now, and the annotation that names the parts is drawn on
    // top of it — so slicing to the end of the file would sweep the annotation in and prove nothing.
    const from = carrier.svg.indexOf('<g id="carrier"');
    const cut = carrier.svg.slice(from, carrier.svg.indexOf("</g>", from));
    for (const colour of partPaint) {
      expect(cut, `${colour} is a part colour and must not appear in the cut`).not.toContain(colour);
    }
    // And drawn on the carrier too, not merely absent from its cuts.
    const drawnOnCarrier = paintIn(carrier.svg.slice(carrier.svg.indexOf("</g>", from)));
    for (const colour of partPaint) expect(drawnOnCarrier.has(colour)).toBe(true);
  });

  it("leaves the circuit alone when there are none", () => {
    const { faces, gaps, base, plain } = fixture();
    const same = planRoutes(faces, gaps, { ...base, resistors: [] });
    expect(same.traces).toEqual(plain.traces);
    expect(same.resistors).toEqual([]);
  });
});

describe("model/part placement", () => {
  it("puts a part where it was clicked, not at the end of a segment", () => {
    // `dist2` returns the distance despite its name, so dividing by it instead of by its square made the
    // projection `u` times too large. Clamped to 1, every part landed at the far end of whichever segment
    // was nearest: on a straight 10-unit run, clicks at 3, 5 and 7 all produced the same break at 9.
    const run = { net: "pwr" as const, pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    for (const x of [3, 5, 7]) {
      const s = breakRuns([run], [{ x, y: 0 }], 1).placed[0]!;
      expect(s.a.x, `click at ${x}`).toBeCloseTo(x - 0.5, 9);
      expect(s.b.x, `click at ${x}`).toBeCloseTo(x + 0.5, 9);
    }
  });

  it("lands on the click along a real, bent run", () => {
    // Walked along the run at a tenth, a third, a half and so on: the break must straddle the point clicked.
    // What is left is the chord across a bend inside the span, which is geometry, not drift.
    const { faces, gaps, base, plain, k } = fixture(3);
    const run = plain.traces.find((t) => t.net === "pwr")!;
    const segs: number[] = [];
    let total = 0;
    for (let i = 1; i < run.pts.length; i++) {
      const l = Math.hypot(run.pts[i]!.x - run.pts[i - 1]!.x, run.pts[i]!.y - run.pts[i - 1]!.y);
      segs.push(l);
      total += l;
    }
    const along = (f: number): Vec2 => {
      let want = f * total, acc = 0;
      for (let i = 0; i < segs.length; i++) {
        if (want <= acc + segs[i]!) {
          const t = (want - acc) / segs[i]!;
          return {
            x: run.pts[i]!.x + (run.pts[i + 1]!.x - run.pts[i]!.x) * t,
            y: run.pts[i]!.y + (run.pts[i + 1]!.y - run.pts[i]!.y) * t,
          };
        }
        acc += segs[i]!;
      }
      return run.pts[run.pts.length - 1]!;
    };
    const toSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (l2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
      return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
    };

    for (const f of [0.2, 0.4, 0.6, 0.8]) {
      const click = along(f);
      const r = planRoutes(faces, gaps, { ...base, resistors: [click] });
      expect(r.resistors, `resistor at ${f}`).toHaveLength(1);
      const { a, b } = r.resistors[0]!;
      expect(toSeg(click, a, b) * k, `resistor clicked at ${f * 100}% of the run`).toBeLessThan(0.5);
    }
  });
});

describe("model/switch", () => {
  /** house with one LED and a switch on the middle of a rail. */
  function withSwitch(net: "pwr" | "gnd" = "pwr", at?: (pts: Vec2[]) => Vec2, leds = 3) {
    // Three LEDs by default: the part is 5.08mm along the rail, and house's one-LED GND run is 5.7mm end to
    // end — barely longer than the switch itself, with no rail left either side to seat it on.
    const { fold, faces, gaps, base, plain, tapeW, k } = fixture(leds);
    const run = plain.traces.find((t) => t.net === net)!;
    const pick = at ?? ((p: Vec2[]) => ({
      x: (p[0]!.x + p[p.length - 1]!.x) / 2,
      y: (p[0]!.y + p[p.length - 1]!.y) / 2,
    }));
    const r = planRoutes(faces, gaps, { ...base, switches: [pick(run.pts)] });
    return { fold, faces, gaps, base, plain, tapeW, k, r };
  }

  /** Winding containment, in sheet millimetres. */
  const inRing = (p: Vec2, ring: Vec2[]): boolean => {
    let w = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!, b = ring[j]!;
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) w = !w;
    }
    return w;
  };

  /** Which copper, if any, each terminal sits on — and whether the two lands touch each other. */
  function seat(r: ReturnType<typeof withSwitch>["r"], tapeW: number, k: number) {
    const w0 = r.switches[0]!;
    const sh = switchShape(
      { x: w0.a.x * k, y: w0.a.y * k },
      { x: w0.b.x * k, y: w0.b.y * k },
      w0.flip,
    )!;
    const rings = r.traces.map((t, i) => ({
      i,
      land: t.width !== undefined,
      ring: stripOutline(t, tapeW, r.pads).map((q) => ({ x: q.x * k, y: q.y * k })),
    }));
    const on = sh.leads.map((l) => {
      const c = { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 };
      return rings.filter((rg) => inRing(c, rg.ring)).map((rg) => rg.i);
    });
    const lands = rings.filter((x) => x.land);
    let clear = Infinity;
    if (lands.length === 2) {
      for (const a of lands[0]!.ring) {
        for (const b of lands[1]!.ring) clear = Math.min(clear, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    return { sh, rings, lands, idle: on[0]!, common: on[1]!, live: on[2]!, clear };
  }

  it("steps the rail across the part: in at the common, out at one throw", () => {
    // An SPDT switching a rail. The terminals stay in a row as pcb.py has them; the COPPER is what moves.
    // The rail arrives at the common in the middle of the break and leaves from one throw a pitch to the
    // side, on land of its own. The other throw is a pitch the other way, over bare pattern — which is what
    // opens the circuit in that position.
    //
    // Run under the part in a line, as this was, one throw shares copper with the common: the common is
    // soldered to a throw for good and the part switches nothing at all.
    for (const net of ["pwr", "gnd"] as const) {
      const { r, tapeW, k } = withSwitch(net);
      expect(r.switches, net).toHaveLength(1);
      const { idle, common, live, lands, clear } = seat(r, tapeW, k);

      expect(idle, `${net}: the idle throw must reach no copper`).toEqual([]);
      expect(common.length, `${net}: the common must sit on copper`).toBeGreaterThan(0);
      expect(live.length, `${net}: the live throw must sit on copper`).toBeGreaterThan(0);
      expect(
        common.some((i) => live.includes(i)),
        `${net}: common and live must not share copper — that bypasses the switch`,
      ).toBe(false);

      // Two lands, and they must not meet: joined, they bridge the incoming rail straight to the outgoing
      // one around the part, and the switch is bypassed.
      expect(lands).toHaveLength(2);
      expect(clear, `${net}: land clearance`).toBeGreaterThan(0.3);
    }
  });

  it("leaves the idle throw a real gap, not a whisker", () => {
    // The void has to be a proper keep-out, the sort of clearance an LED's pads get — not merely "no copper
    // exactly under the centre". The idle throw sits a pitch off the rail; with the outgoing tape ending
    // level with the pad row, 3.25mm of tape left its pad edge 0.27mm from copper, close enough for solder
    // to bridge. The tape is pulled back a neck beyond the row, which makes it a millimetre.
    const { r, tapeW, k } = withSwitch();
    const { sh, rings, idle } = seat(r, tapeW, k);
    expect(idle, "the idle throw must reach no copper").toEqual([]);

    const toSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (l2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
      return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
    };
    const c = { x: (sh.leads[0]!.a.x + sh.leads[0]!.b.x) / 2, y: (sh.leads[0]!.a.y + sh.leads[0]!.b.y) / 2 };
    let nearest = Infinity;
    for (const rg of rings) {
      for (let q = 0; q < rg.ring.length; q++) {
        nearest = Math.min(nearest, toSeg(c, rg.ring[q]!, rg.ring[(q + 1) % rg.ring.length]!));
      }
    }
    // From the pad's own edge, not from its centre.
    const gap = nearest - SPDT.pad.h / 2;
    expect(gap, "gap from the idle pad's edge to the nearest copper").toBeGreaterThan(0.8);
  });

  it("attaches every leg to the housing", () => {
    // A terminal that meets the body at a single corner reads as a loose square floating beside it. Each has
    // to overlap the outline properly. Narrower than the throws' centres, the housing caught them at its
    // corners and only a percent or two of each pad touched it.
    const { r, tapeW, k } = withSwitch();
    const { sh } = seat(r, tapeW, k);
    const b = sh.body;
    const rad = (b.angle * Math.PI) / 180, ca = Math.cos(rad), sa = Math.sin(rad);
    // Into the housing's own frame, where it is an axis-aligned box.
    const local = (q: Vec2): Vec2 => {
      const dx = q.x - b.cx, dy = q.y - b.cy;
      return { x: dx * ca + dy * sa, y: -dx * sa + dy * ca };
    };
    const inside = (q: Vec2): boolean => {
      const l = local(q);
      return Math.abs(l.x) <= b.w / 2 && Math.abs(l.y) <= b.h / 2;
    };

    const names = ["idle", "common", "live"];
    sh.leads.forEach((l, i) => {
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
      const len = Math.hypot(dx, dy);
      const ux = dx / len, uy = dy / len, px = -uy, py = ux, hw = l.width / 2;
      let on = 0, total = 0;
      for (let u = 0; u <= 20; u++) {
        for (let v = -10; v <= 10; v++) {
          const q = {
            x: l.a.x + ux * len * (u / 20) + px * (v / 10) * hw,
            y: l.a.y + uy * len * (u / 20) + py * (v / 10) * hw,
          };
          total++;
          if (inside(q)) on++;
        }
      }
      expect((100 * on) / total, `${names[i]} leg overlapping the housing, %`).toBeGreaterThan(15);
    });
  });

  it("lands on pad-sized copper, not on full tape", () => {
    // The terminals are .098in apart. Two full-width stubs would meet between them and short the part.
    const { r, tapeW, k } = withSwitch();
    const lands = r.traces.filter((t) => t.width !== undefined);
    expect(lands).toHaveLength(2);
    for (const l of lands) {
      expect(l.width! * k).toBeCloseTo(SPDT.pad.h, 4);
      expect(l.width!).toBeLessThan(tapeW);
    }
  });

  it("is the size the datasheet says", () => {
    // Every dimension here is read off the footprint rather than written out a second time: pinning the
    // numbers is what let a hand-picked 0.4318mm pad survive a change of part.
    const { r, tapeW, k } = withSwitch();
    const { sh } = seat(r, tapeW, k);

    expect(sh.leads).toHaveLength(3);
    for (const l of sh.leads) {
      expect(l.width).toBeCloseTo(SPDT.pad.w, 4);
      expect(Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y)).toBeCloseTo(SPDT.pad.h, 4);
    }

    // Two throws on one edge, a pitch either side of the rail, so twice the pitch apart. The common is
    // alone on the other edge, square between them — which is what lets the rail run straight through.
    const c = sh.leads.map((l) => ({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }));
    const [idle, common, live] = c as [Vec2, Vec2, Vec2];
    expect(Math.hypot(live.x - idle.x, live.y - idle.y)).toBeCloseTo(2 * SWITCH_PITCH_MM, 6);
    // The common is equidistant from the two throws, and a pad row's separation away from their edge.
    const dIdle = Math.hypot(common.x - idle.x, common.y - idle.y);
    const dLive = Math.hypot(common.x - live.x, common.y - live.y);
    expect(dIdle).toBeCloseTo(dLive, 6);
    // The rows' own separation, not the break: the break is that plus a neck, which pulls the tape back
    // clear of the idle throw but does not move the part.
    expect(dIdle).toBeCloseTo(Math.hypot(SWITCH_PITCH_MM, SWITCH_ROW_MM), 6);

    expect(sh.holes).toHaveLength(2);
    const pegs = holes(SPDT.footprint);
    expect(pegs).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(sh.holes![i]!.r).toBeCloseTo((pegs[i]!.drill!.diameter * 25.4) / 2, 9);
    }
    expect(Math.hypot(sh.holes![1]!.c.x - sh.holes![0]!.c.x, sh.holes![1]!.c.y - sh.holes![0]!.c.y))
      .toBeCloseTo(Math.abs(padAt(pegs[1]!).x - padAt(pegs[0]!).x), 9);

    // No window to cut: the idle throw is off the copper by where it sits, not by a hole in the strip.
    expect(sh.notch).toBeUndefined();
  });

  it("slides one dropped at the very end of a run inboard, or refuses it outright", () => {
    // A part needs copper either side of its break to seat on. Dropped near an end there was not room, and
    // it was simply not placed: a click that did nothing, with nothing to say why. It slides inboard now.
    //
    // Except at the end of the GND run, where sliding inboard is not enough. That end is at the battery,
    // where the two rails run alongside each other, and a switch reaches a pitch plus half a pad off its
    // own centreline — far enough that a throw comes down 0.5mm inside the PWR copper. That is a short
    // through the part, so the seat is refused. Both outcomes are correct and the test allows either; what
    // it does not allow is a part placed with a terminal on the other net, which is what used to happen.
    for (const net of ["pwr", "gnd"] as const) {
      for (const which of [0, -1]) {
        const { r, tapeW, k } = withSwitch(net, (p) => (which === 0 ? p[0]! : p[p.length - 1]!));
        if (r.switches.length === 0) continue;      // refused rather than shorted
        const { idle, common, live } = seat(r, tapeW, k);
        expect(idle).toEqual([]);
        // The common's land overlaps the rail it continues, so it may read as more than one run — what
        // matters is that it reaches copper, and that it is not the same copper the live throw reaches.
        expect(common.length).toBeGreaterThan(0);
        expect(live.length).toBeGreaterThan(0);
        expect(common.some((i) => live.includes(i))).toBe(false);
      }
    }
    // And it is not a blanket refusal: the PWR ends still seat, so the veto has not simply banned the part
    // from run ends altogether.
    for (const which of [0, -1]) {
      const { r } = withSwitch("pwr", (p) => (which === 0 ? p[0]! : p[p.length - 1]!));
      expect(r.switches, `pwr at end ${which}`).toHaveLength(1);
    }
  });

  it("refuses a run too short to seat the part", () => {
    // Breaking a run shorter than the part takes all its copper and strands what it feeds. Tested on
    // `breakRuns` directly: across the break the switch is compact enough that no bundled run is too short.
    const run = { net: "pwr" as const, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
    const tooBig = breakRuns([run], [{ x: 0.5, y: 0 }], 4, { before: 4, after: 4 });
    expect(tooBig.traces).toEqual([run]);
    expect(tooBig.placed).toEqual([]);
  });

  it("takes a switch and a resistor on the same circuit", () => {
    const { faces, gaps, base, plain, mid } = fixture(3);
    const pwr = plain.traces.filter((t) => t.net === "pwr");
    const other = pwr[pwr.length - 1]!;
    const at = other.pts[Math.floor(other.pts.length / 2)]!;
    const r = planRoutes(faces, gaps, { ...base, resistors: [mid], switches: [at] });
    expect(r.resistors).toHaveLength(1);
    expect(r.switches).toHaveLength(1);
    // The switch's two lands are extra runs; the resistor's break makes one more.
    expect(r.traces.filter((t) => t.width !== undefined)).toHaveLength(2);
  });
});
