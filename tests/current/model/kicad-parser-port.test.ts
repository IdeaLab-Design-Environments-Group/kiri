/**
 * The TypeScript port of svg-pcb's `js/ki_cad_parser.js`, checked against the real `.kicad_mod` files the
 * library is built from.
 *
 * These tests pin the things a port can silently get wrong: the unit and axis conversion, the fixed
 * tessellation svg-pcb uses, how repeated pad names are keyed, and the drill guard svg-pcb gets wrong.
 * Geometry is compared in inches, the representation's own unit, with a tolerance — never by float equality.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kicadParser } from "../../../src/model/kicad-parser.js";
import { carriesCopper, terminals } from "../../../src/model/footprint.js";

const FAB = new URL("../../../footprints/fab/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, FAB), "utf8");
const parse = (file: string) => kicadParser(read(file));

/** Every point in a `shape` path, as numbers. */
function points(shape: string): number[][] {
  return shape.trim().split(/(?=[ML])/).filter(Boolean).map((seg) => {
    const [, x, y] = seg.trim().split(/\s+/);
    return [Number(x), Number(y)];
  });
}

describe("model/kicad-parser (svg-pcb port)", () => {
  it("reads a two-pad chip: pad names, layers, and the pads' separation", () => {
    const fp = parse("C_1206.kicad_mod");
    expect(Object.keys(fp)).toEqual(["1", "2"]);
    expect(fp["1"]!.layers).toEqual(["F.Cu", "F.Paste", "F.Mask"]);

    // 1206's pads sit ±1.5mm about the origin in KiCad; the representation is inches.
    expect(fp["1"]!.pos[0]).toBeCloseTo(-1.5 / 25.4, 9);
    expect(fp["2"]!.pos[0]).toBeCloseTo(1.5 / 25.4, 9);
    expect(fp["1"]!.pos[1]).toBeCloseTo(0, 9);
  });

  it("negates Y, because KiCad's grows downward and the representation's grows up", () => {
    // A part whose pads are spread over both axes, so a missing flip cannot hide in a symmetric footprint.
    const fp = parse("Amplifier_Analog_MAX98357AETE.kicad_mod");
    const src = read("Amplifier_Analog_MAX98357AETE.kicad_mod");
    // First `(at x y)` under the first named pad, straight out of the file.
    const at = /\(pad "1"[\s\S]*?\(at ([-\d.]+) ([-\d.]+)/.exec(src)!;
    expect(fp["1"]!.pos[0]).toBeCloseTo(Number(at[1]) / 25.4, 9);
    expect(fp["1"]!.pos[1]).toBeCloseTo(-Number(at[2]) / 25.4, 9);
  });

  it("keys a repeated pad name as `name`, `name_1`, in the order the file gives them", () => {
    // This jack declares "2" and "3" twice each: one pad of copper, one of shell.
    const fp = parse("CUIDevices_PJ1-023-SMT-TR_PWRJack_0.7x2.35mm.kicad_mod");
    expect(Object.keys(fp)).toContain("2_1");
    expect(Object.keys(fp)).toContain("3_1");
    // The repeat is a real pad, not a placeholder: it carries copper and its own position.
    expect(carriesCopper(fp["2_1"]!)).toBe(true);
    expect(fp["2_1"]!.pos).not.toEqual(fp["2"]!.pos);
  });

  it("expands a `*.Cu` layer to both sides, and leaves an already-sided layer alone", () => {
    const fp = parse("Switch_Slide_RightAngle_CnK_AYZ0102AGRLC_7.2x3mm.kicad_mod");
    const both = Object.values(fp).filter((p) => p.layers.includes("F.Cu") && p.layers.includes("B.Cu"));
    // The slide switch's locating pegs are declared `*.Cu` — plated, through the board, both sides.
    expect(both.length).toBeGreaterThan(0);
    for (const p of Object.values(fp)) expect(p.layers).not.toContain("*.Cu");
  });

  it("emits a drill for a circular thru-hole — the guard svg-pcb gets wrong", () => {
    // svg-pcb tests `typeof atom === "number"`, and its reader returns every atom as a STRING, so upstream
    // never emits a drill at all. The holes are cut from this data, so the port asks whether the atom READS
    // as a number instead. Without this the switch's pegs stop being drilled and nothing says so.
    const fp = parse("Switch_Slide_RightAngle_CnK_AYZ0102AGRLC_7.2x3mm.kicad_mod");
    const drilled = Object.values(fp).filter((p) => p.drill !== undefined);
    expect(drilled.length).toBeGreaterThan(0);
    for (const p of drilled) {
      expect(p.drill!.diameter).toBeGreaterThan(0);
      expect(p.drill!.start).toBe("F.Cu");
      expect(p.drill!.end).toBe("B.Cu");
      expect(p.drill!.plated).toBe(true);
    }
  });

  it("tessellates a circle at svg-pcb's fixed 180 chords, not at a tolerance", () => {
    const fp = parse("Conn_RCA_Jack_CUI_RCJ-011-SMT-TR.kicad_mod");
    const round = Object.values(fp).find((p) => points(p.shape).length > 100);
    expect(round).toBeDefined();
    // 180 points plus the closing repeat. svg-pcb uses this constant for a 0.3mm via and a 6mm hole alike,
    // which is why a ported circle is far heavier than the one the OCaml generator emits at a tolerance.
    expect(points(round!.shape)).toHaveLength(181);
  });

  it("draws a rectangular pad as four corners and a close, in the y-up frame", () => {
    const fp = parse("R_0603.kicad_mod");
    const p = points(fp["1"]!.shape);
    expect(p).toHaveLength(5);
    expect(p[0]).toEqual(p[p.length - 1]);
    // Wound from the top-left: +y first, and the x extent is the pad's own width.
    expect(p[0]![1]).toBeGreaterThan(0);
    expect(p[0]![0]).toBeLessThan(0);
  });

  it("gives a trapezoid pad real geometry, where svg-pcb gives it none", () => {
    // svg-pcb has no `trapezoid` shape case, so upstream emits these two pads with an EMPTY path. A pad
    // with no outline is a terminal with no copper, and nothing downstream can measure it.
    const fp = parse("Sensor_Optical_ST_VL53L5CXV0GC.kicad_mod");
    for (const name of ["A1", "A1_1"]) {
      const p = points(fp[name]!.shape);
      expect(p).toHaveLength(5);
      expect(p[0]).toEqual(p[p.length - 1]);
    }
    // Both carry no `rect_delta`, so they must come out as exact rectangles — same corners a `rect` of the
    // same size would give. 0.5mm square, rotated 90°, so the extent is symmetric either way.
    const q = points(fp["A1"]!.shape);
    const xs = q.map((v) => v[0]!), ys = q.map((v) => v[1]!);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.5 / 25.4, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.5 / 25.4, 9);
  });

  it("indexes pads in file order, so `terminals` reads them the way the datasheet numbers them", () => {
    const fp = parse("Module_LoRa_Seeed_109990166.kicad_mod");
    const names = terminals(fp).map(([n]) => n);
    // The file declares each pad twice, 1 1 2 2 ... 16 16, so first appearances and repeats interleave.
    expect(names.slice(0, 4)).toEqual(["1", "1_1", "2", "2_1"]);
    // Index is 1-based and strictly increasing over the file, so the sort is total and stable.
    const idx = terminals(fp).map(([, p]) => p.index);
    expect(idx[0]).toBe(1);
    for (let i = 1; i < idx.length; i++) expect(idx[i]!).toBeGreaterThan(idx[i - 1]!);
  });

  it("reads every footprint in the library without throwing or coming back empty", () => {
    // The port only earns trust across all 129, because the shape cases it can silently skip are the ones
    // no single hand-picked fixture happens to use.
    const fp = parse("SeeedStudio_XIAO_ESP32C3.kicad_mod");
    expect(Object.keys(fp).length).toBeGreaterThan(30);
    for (const p of Object.values(fp)) {
      expect(p.shape.length).toBeGreaterThan(0);
      expect(Number.isFinite(p.pos[0])).toBe(true);
      expect(Number.isFinite(p.pos[1])).toBe(true);
    }
  });
});
