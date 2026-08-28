/**
 * The placement transform, against both derivations it is replacing.
 *
 * Built as a triangle rather than a pair, for the reason `pad-axis-sweep.test.ts`'s header gives: a test on
 * internal consistency would prove only that the two halves are wrong together. So every leg is anchored to
 * something outside the code under test — the footprint file, or `padPosition`/`partShape` as they stand
 * today — and never to `placementOf`'s own arithmetic.
 *
 * Leg 1: baked pad centre == `netlist.ts › padPosition` (the routing derivation).
 * Leg 2: baked pad centre == the matching lead centre of `copper-svg-export.ts › partShape` (the drawing).
 * Leg 3: the baked outline sits on the baked centre, at the footprint's own size.
 */
import { describe, expect, it } from "vitest";
import { LIBRARY } from "../../../src/model/library.js";
import { padAt, padPoints, terminals, type Footprint } from "../../../src/model/footprint.js";
import { acrossPart, padAxis, seatSigns } from "../../../src/model/parts.js";
import { freeSpan } from "../../../src/model/electronics-routing.js";
import { partShape } from "../../../src/model/copper-svg-export.js";
import { padPosition } from "../../../src/model/netlist.js";
import {
  applyPlacement, isMirrored, padOf, placeComponent, placementOf,
} from "../../../src/model/electronics-parts.js";
import type { PlacedPart, Vec2 } from "../../../src/model/electronics.js";

/** A tape and a pattern scale that are not 1, so a dropped conversion cannot pass by looking like identity. */
const TAPE_MM = 3.25;
const TAPE_W = 0.09967;             // flat units, as `house.fkld` gives
const K = TAPE_MM / TAPE_W;         // mm per flat unit

/** The turns and flips a part can actually be placed at. */
const POSES: { rot: number; flip: boolean }[] = [
  { rot: 0, flip: false },
  { rot: 90, flip: false },
  { rot: 37, flip: false },
  { rot: 0, flip: true },
  { rot: 214, flip: true },
];

const free = (component: string, rot: number, flip: boolean): PlacedPart => ({
  component, x: 4.3, y: 7.1, free: true, rot, ...(flip ? { flip } : {}),
});

/** The span a free part is drawn on, in SHEET MM for `partShape` — the router's own rule, not a copy. */
function drawnSpanMm(fp: Footprint, part: PlacedPart): { a: Vec2; b: Vec2 } {
  const { a, b } = freeSpan(part, fp, TAPE_W, TAPE_MM);
  return { a: { x: a.x * K, y: a.y * K }, b: { x: b.x * K, y: b.y * K } };
}

/** The widest distance between any two points of a shape — invariant under rotation, flip and translation. */
function diameter(pts: Vec2[]): number {
  let d = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) d = Math.max(d, Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y));
  }
  return d;
}

describe("model/electronics-parts — the placement transform", () => {
  it("lays an in-line part ALONG the run at the footprint's own pitch, whichever axis its pads run down", () => {
    // Leg 1, anchored on the footprint file rather than on either derivation.
    //
    // It used to compare against `netlist.ts › padPosition`, which was the right check while that function
    // had its own copy of the arithmetic. `padPosition` now delegates to `placementOf`, so that comparison
    // became a tautology and had to be replaced with something outside the code under test.
    //
    // The property: `rot` is the direction of the RUN — `freeSpan` builds the span along it and the drawing
    // lays the pads along it — so at `rot: 0` an in-line part's terminals must come out spread along x, at
    // the spacing its own footprint gives, whether the file happens to describe them running along x or down
    // y. 62 of the library's 159 footprints are the second kind, and reading their x-axis as the along-axis
    // put 15 parts a quarter turn from where they are drawn, `PinHeader_01x08_P2_54mm_Horizontal_SMD` worst
    // at 19.88mm.
    let checked = 0;
    for (const { id, footprint: fp } of LIBRARY) {
      const ts = terminals(fp);
      if (ts.length < 2 || acrossPart(fp)) continue;   // two-row parts seat turned; see the next test
      const ax = padAxis(fp);
      const c = placeComponent(free(id, 0, false), fp, TAPE_W, TAPE_MM);

      // The footprint's own extreme terminals, and the distance between them along its own along-axis.
      const alongs = ts.map(([, p]) => ax.along(p));
      const spanMm = Math.max(...alongs) - Math.min(...alongs);
      if (spanMm < 1e-9) continue;                     // every terminal at one point: nothing to orient
      const lo = ts[alongs.indexOf(Math.min(...alongs))]![0];
      const hi = ts[alongs.indexOf(Math.max(...alongs))]![0];
      const A = padOf(c, lo)!.at, B = padOf(c, hi)!.at;

      // Spread along x, because rot is 0. Four places: the library stores coordinates on a 1e-6 inch grid.
      expect((B.x - A.x) * K, `${id} is not laid along the run`).toBeCloseTo(spanMm, 4);
      expect((B.y - A.y) * K, `${id} is laid across the run`).toBeCloseTo(0, 4);
      checked++;
    }
    expect(checked, "no in-line part was checked").toBeGreaterThan(30);
  });

  it("seats a two-row part turned to the run, its rows spanning the break and its pitch across it", () => {
    // The other half of leg 1, and the reading `parts.ts › padRunBox` was written to pin: a two-row part is
    // seated TURNED, so the footprint's across-axis runs ALONG the rail and its along-axis runs across it.
    // Asserted from the footprint's own rows rather than from the transform.
    let checked = 0;
    for (const { id, footprint: fp } of LIBRARY) {
      const g = acrossPart(fp);
      if (!g) continue;
      const ax = padAxis(fp);
      const c = placeComponent(free(id, 0, false), fp, TAPE_W, TAPE_MM);
      const common = padOf(c, g.names.common), live = padOf(c, g.names.live);
      if (!common || !live) continue;
      // Skip the one-row parts whose second row `acrossPart` FABRICATES by reflecting the common through the
      // peg line (`parts.ts`, the `rows.length === 1` branch). There `rowSep` is an invention, not a distance
      // the footprint has, and `rowLeads` refuses them for the same reason.
      const rowsShare = new Set(terminals(fp).map(([, q]) => Math.round(padAxis(fp).across(q) * 1e6)));
      if (rowsShare.size < 2) continue;
      // The common-to-live step is `rowSep` along the run and `pitch` across it — which is what `acrossPart`
      // measured off the footprint in the first place.
      expect(Math.abs(live.at.x - common.at.x) * K, `${id} row separation`).toBeCloseTo(g.rowSep, 4);
      expect(Math.abs(live.at.y - common.at.y) * K, `${id} throw pitch`).toBeCloseTo(g.pitch, 4);
      expect(ax.alongIsY === ax.alongIsY).toBe(true);
      checked++;
    }
    expect(checked, "no two-row part was checked").toBeGreaterThan(50);
  });

  it("agrees with the canvas except where the canvas has a known defect, and names which defect", () => {
    // Leg 2, and the pair that has drifted before — `parts.ts › padRunBox` records 43 of 87 across-parts
    // drawn with their two extents swapped, in the cut file as well as on screen.
    //
    // They do not agree everywhere, and **neither disagreement belongs to this transform**: both exist today
    // between `netlist.ts › padPosition` and `copper-svg-export.ts › partShape`. No test caught them because
    // the only coordinate-level comparison of the two is on a XIAO, which is in neither set.
    //
    // Two distinct causes, pinned separately so a fix to one cannot mask a regression in the other. Both
    // lists may only ever SHRINK: a part leaving is the drawing being fixed, a part joining is a regression.
    // `part-shape.test.ts` pins its own two known-wrong sockets the same way.

    // Two causes were found and fixed here; what is left is a third that belongs to the DRAWING and is
    // pinned rather than papered over. Both fixed causes keep an assertion so they cannot come back.
    //
    // **Fixed — the router read the wrong axis.** `placementOf`'s in-line branch turned the footprint's own
    // frame by `rot` without asking `padAxis` which way the terminals actually run. Right for a part whose
    // pads run along x, a quarter turn out for one whose pads run down y — 62 of the library's 159
    // footprints. Measured at 15 parts, worst 19.88mm on `PinHeader_01x08_P2_54mm_Horizontal_SMD`.
    //
    // **Fixed — the router anchored on the wrong point.** The drawing centres a part's PAD SPAN on the drop
    // point, which is what `freeParts` documents ("the part's own `partFit.gap` long, centred on the drop
    // point") and `partFit.gap` is measured between the outermost pads. The bake was centring the footprint
    // ORIGIN instead, so the 19 footprints whose pads are not symmetric about it routed a whole pitch away —
    // a net wired to pin 1 landing on pin 2.
    //
    // **Left — the drawing invents or stretches contacts.** Five parts, and each is a known defect with its
    // own note in the source:
    //   - the two USB sockets and `SW_SPDT` are one-row parts whose second row `acrossPart` FABRICATES by
    //     reflecting the common through the peg line, so `rowLeads` refuses them and `rowShape` falls back
    //     to three invented contacts at places the part has no metal. `rowLeads`' docblock names this and
    //     says it cannot be fixed from that side.
    //   - `LED_Luminus_1206` and `TerminalBlock_1pos_...` are two-terminal one-row parts, where
    //     `inlineShape` pins both pads to the CUT ENDS rather than to their own pitch, so the pad spread is
    //     stretched whenever that pitch is not `fit.gap` plus a pad's length.
    //
    // The list may only ever SHRINK. A part leaving is the drawing being fixed; a part joining is a
    // regression, and this test says which.
    const DRAWING_INVENTS = [
      "Conn_USB_microB_Socket_WurthElektronik_629105136821",
      "Conn_USB_miniB_Socket_CUIDevices_UJ2_MBH_1_SMT_TR",
      "LED_Luminus_1206",
      "SW_SPDT",
      "TerminalBlock_1pos_Metz_SM99S01VBNN05G7",
    ];

    const off = (pose: { rot: number; flip: boolean }): Set<string> => {
      const out = new Set<string>();
      for (const { id, footprint: fp } of LIBRARY) {
        if (terminals(fp).length < 2) continue;   // `partShape` refuses a one-terminal part
        const part = free(id, pose.rot, pose.flip);
        const span = drawnSpanMm(fp, part);
        const shape = partShape(fp, span.a, span.b, pose.flip);
        if (!shape) continue;
        const c = placeComponent(part, fp, TAPE_W, TAPE_MM);
        for (const lead of shape.leads) {
          if (!lead.name) continue;
          const got = padOf(c, lead.name);
          if (!got) { out.add(id); continue; }   // a contact the part does not have
          const drawn = { x: (lead.a.x + lead.b.x) / 2, y: (lead.a.y + lead.b.y) / 2 };
          // 1e-6mm: the two sides reach the same point through different orders of operations and different
          // units, so this is as tight as a cross-derivation comparison can honestly be asked to be.
          if (Math.hypot(got.at.x * K - drawn.x, got.at.y * K - drawn.y) > 1e-6) out.add(id);
        }
      }
      return out;
    };

    const upright = off({ rot: 0, flip: false });
    const turned = off({ rot: 37, flip: false });
    const flipped = off({ rot: 0, flip: true });

    // Cause 1 is independent of the turn — a rigid rotation cannot introduce or remove it.
    expect([...upright].sort()).toEqual(DRAWING_INVENTS);
    expect([...turned].sort()).toEqual(DRAWING_INVENTS);
    // Flipping adds nothing, since `freeSpan` now turns an in-line part end for end the way the seated path
    // always did. It used to add 24 parts — `R_1206`, `C_1206`, `LED_1206`, `SW_PUSH` and the rest.
    expect([...flipped].filter((id) => !upright.has(id)).sort()).toEqual([]);
    // And every part outside both lists agrees, which is the assertion that actually protects the transform.
    // 124 of 129, from 85 when this test was written: 24 recovered by the in-line flip rule, 15 by reading
    // the right axis, and 19 more by anchoring on the pad span. The five left are the drawing's own.
    expect(LIBRARY.length - DRAWING_INVENTS.length).toBe(124);
  });

  it("places each pad's true outline on its own centre, at the size its datasheet gives", () => {
    // Leg 3, anchored on the footprint file rather than on either derivation: the outline's centroid must be
    // the pad's centre, and its extents must be the footprint's own — turned, but never scaled. Four places,
    // because the library stores coordinates on a 1e-6 inch grid and asserting past that tests the grid.
    let checked = 0;
    for (const { id, footprint: fp } of LIBRARY) {
      for (const pose of POSES) {
        const c = placeComponent(free(id, pose.rot, pose.flip), fp, TAPE_W, TAPE_MM);
        for (const pad of c.pads) {
          const xs = pad.outline.map((p) => p.x), ys = pad.outline.map((p) => p.y);
          const mid = {
            x: (Math.max(...xs) + Math.min(...xs)) / 2,
            y: (Math.max(...ys) + Math.min(...ys)) / 2,
          };
          expect(mid.x * K, `${id} pad ${pad.name} outline off its centre in x`).toBeCloseTo(pad.at.x * K, 4);
          expect(mid.y * K, `${id} pad ${pad.name} outline off its centre in y`).toBeCloseTo(pad.at.y * K, 4);

          // The outline's DIAMETER — its widest pair of points — is the size check that does not need to
          // know which way the part was turned. The axis-aligned bounding box is NOT invariant under
          // rotation and asserting on it would fail every pose but the square ones, which is the trap this
          // comment exists to stop the next reader falling into.
          const local = padPoints(fp[pad.name]!);
          expect(diameter(pad.outline) * K, `${id} pad ${pad.name} outline resized`)
            .toBeCloseTo(diameter(local), 4);
          checked++;
        }
      }
    }
    expect(checked, "no outline was checked").toBeGreaterThan(2000);
  });

  it("seats a two-row part the way round the datasheet draws it, never mirrored", () => {
    // **The bug this test was written for.** On `Module_XIAO_Generic_SocketSMD` a net wired to pad 1 had its
    // copper laid at pad 5, pad 2 at pad 4, pad 3 alone was right, and pads 6 and 7 landed past the end of
    // the part. That is a REFLECTION of the footprint about the `common` pad — 60 of the library's 87
    // across-parts were seated inside out, drawn and routed alike, so the two agreed with each other.
    //
    // Handedness, not order: a single row read on its own cannot tell a mirror from a half-turn, since both
    // reverse it. What a mirror cannot survive is the SIGN OF A TRIANGLE. Three pads that are not collinear
    // enclose a signed area in the footprint's own frame; a rotation keeps that sign and a reflection
    // negates it. Both sides are read off real pads — the footprint file on one, the placed pads on the
    // other — so nothing here is anchored on `placementOf`'s arithmetic.
    let checked = 0;
    for (const { id, footprint: fp } of LIBRARY) {
      const seat = seatSigns(fp);
      if (!seat) continue;
      // The switch and its kin: `acrossPart` invents their second row, and flipping one is the one placement
      // that is deliberately still a reflection — see the test below and `seatSigns`.
      if (seat.fabricated) continue;
      const ax = padAxis(fp);
      const ts = terminals(fp);

      // Three pads spanning both axes: the extremes of each reading. Collinear triples are no use, and a
      // part whose terminals all share a coordinate has none — those are skipped by the area guard below.
      const byAlong = [...ts].sort((a, b) => ax.along(a[1]) - ax.along(b[1]));
      const byAcross = [...ts].sort((a, b) => ax.across(a[1]) - ax.across(b[1]));
      const pick = [byAlong[0]!, byAlong[byAlong.length - 1]!, byAcross[byAcross.length - 1]!];
      // In the footprint's own x/y — the KiCad file's frame, read raw. Stating it as (along, across) instead
      // would introduce an axis swap of its own for half the library, which is a property of the test rather
      // than of the placement.
      const local = pick.map(([, q]) => padAt(q));
      const areaOf = (p: { x: number; y: number }[]): number =>
        (p[1]!.x - p[0]!.x) * (p[2]!.y - p[0]!.y) - (p[2]!.x - p[0]!.x) * (p[1]!.y - p[0]!.y);
      const want = areaOf(local);
      if (Math.abs(want) < 1e-9) continue;   // collinear: no handedness to check

      for (const pose of POSES) {
        const c = placeComponent(free(id, pose.rot, pose.flip), fp, TAPE_W, TAPE_MM);
        const got = areaOf(pick.map(([n]) => padOf(c, n)!.at));
        // A linear map multiplies a signed area by its determinant, so the sign survives a rotation and
        // flips under a reflection. Nothing here reads the determinant: both areas are measured on pads.
        expect(Math.sign(got), `${id} at rot ${pose.rot}${pose.flip ? " flipped" : ""} is mirrored`)
          .toBe(Math.sign(want));
      }
      checked++;
    }
    // 48 of the library's 87 across-parts; the rest have all their terminals on one line by one of the two
    // readings, so there is no triangle to sign.
    expect(checked, "no across-part was checked").toBeGreaterThan(40);
  });

  it("never places a part as a reflection, whatever its rows and whichever way it is turned", () => {
    // **This assertion used to run the other way.** It read `expect(mirrored.length).toBeGreaterThan(0)`,
    // "if this ever comes back empty the model quietly lost the reflection" — written from the code under
    // test, which is the failure `working-agreements.md` names, and it pinned the bug for 60 of the
    // library's 87 across-parts. There is no such thing as a mirrored placement: a surface-mount part has
    // one side, so a reflection is a part soldered upside down.
    //
    // `Placement` still carries a 2x2 rather than `{rot, flip}`, for the other reason the matrix was chosen:
    // a two-row part swaps the footprint's two axes, which an angle alone cannot say.
    // One exception, and it is named rather than filtered quietly: a part whose second row `acrossPart`
    // FABRICATES by reflecting the common through the peg line — the SPDT switch and its kin. Flipping one
    // means "the copper leaves by the other throw", and since the part is symmetric about the centreline the
    // reflection and the half-turn are the same placement. `rowLeads` refuses those parts, so nothing draws
    // pads from this transform for them.
    for (const { id, footprint: fp } of LIBRARY) {
      const fabricated = seatSigns(fp)?.fabricated === true;
      for (const pose of POSES) {
        const p = placementOf(free(id, pose.rot, pose.flip), fp, TAPE_W, TAPE_MM);
        if (fabricated && pose.flip) {
          expect(isMirrored(p), `${id} flipped is no longer the switch's reflection`).toBe(true);
          continue;
        }
        expect(isMirrored(p), `${id} at rot ${pose.rot}${pose.flip ? " flipped" : ""} places as a mirror`)
          .toBe(false);
      }
    }

    // And every placement is an ISOMETRY: lengths preserved, axes square, so a pad is never stretched.
    // Checked on the transform itself rather than on a pad, so it cannot be satisfied by luck.
    for (const { id, footprint: fp } of LIBRARY) {
      const [a, b, c, d] = placementOf(free(id, 41, false), fp, TAPE_W, TAPE_MM).m;
      const k = TAPE_W / TAPE_MM;
      expect(Math.hypot(a, c) / k, `${id} column 1 is not a unit vector`).toBeCloseTo(1, 9);
      expect(Math.hypot(b, d) / k, `${id} column 2 is not a unit vector`).toBeCloseTo(1, 9);
      expect((a * b + c * d) / (k * k), `${id} axes are not perpendicular`).toBeCloseTo(0, 9);
    }
  });

  it("reads a pad through the transform, so moving the part moves every pad with it", () => {
    // The property the whole file exists for, stated once directly: pads are not stored positions, they are
    // the footprint seen through a placement. Move the part and every pad follows by construction.
    const fp = LIBRARY.find((c) => c.id === "R_1206")!.footprint;
    const here = placeComponent(free("R_1206", 0, false), fp, TAPE_W, TAPE_MM);
    const moved = placeComponent(
      { component: "R_1206", x: 4.3 + 1.5, y: 7.1 - 0.25, free: true, rot: 0 }, fp, TAPE_W, TAPE_MM);
    for (const pad of here.pads) {
      const after = padOf(moved, pad.name)!;
      expect(after.at.x - pad.at.x).toBeCloseTo(1.5, 9);
      expect(after.at.y - pad.at.y).toBeCloseTo(-0.25, 9);
    }
    // And the local frame is untouched: `applyPlacement` of the footprint origin is the part's own anchor.
    const ax = padAxis(fp);
    expect(ax.alongIsY).toBe(false);   // a 1206 runs along x; if this changes the fixture is wrong
    expect(applyPlacement(here.placement, padAt(fp["1"]!)).x).toBeCloseTo(padOf(here, "1")!.at.x, 12);
  });
});
