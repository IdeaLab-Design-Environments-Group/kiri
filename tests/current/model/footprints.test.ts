import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPONENTS,
  LED_1206,
  R_1206,
  SW_SPDT,
} from "../../../src/model/footprints.generated.js";
import { REST_COMPONENTS } from "../../../src/model/footprints.rest.generated.js";
import {
  carriesCopper,
  holes,
  isTerminal,
  MM_PER_INCH,
  padAt,
  padNamed,
  padPoints,
  padSize,
  terminals,
} from "../../../src/model/footprint.js";
import { LED, netPlacement, placement, RESISTOR, SPDT } from "../../../src/model/parts.js";
import { footprintById } from "../../../src/model/library.js";

/** The whole FabLib, both halves of the split. Tests bundle nothing, so both can be imported. */
const ALL = [...COMPONENTS, ...REST_COMPONENTS];

/**
 * The component library.
 *
 * These parts are not authored here — they are read out of the manufacturers' own KiCad footprints by
 * `ocaml/kicad.ml`, and the generated file is committed. So what is worth asserting is not "the resistor
 * is 4mm long" (that is the file's business) but that the pipeline between the file and the router keeps
 * its meaning: units, axis, which pads are terminals, and the one place we knowingly depart from the part.
 */
describe("model/footprints", () => {
  it("gives every part pads with an outline, numbered from one", () => {
    expect(ALL.length).toBe(129);
    for (const c of ALL) {
      // Every part must have pads, because a footprint with none is a file the scan failed to read.
      // Terminals are a weaker claim: the reading below still tolerates a part with none, though the
      // library no longer holds one — the `MountingHole_*` parts were the only such parts and went with
      // the through-hole cull.
      expect(Object.keys(c.footprint).length, `${c.id} has no pads`).toBeGreaterThan(0);
      const t = terminals(c.footprint);
      // Pad numbers are the part's own, so they start at 1 and do not repeat.
      const indices = t.map(([, p]) => p.index);
      expect(new Set(indices).size).toBe(indices.length);
      if (t.length > 0) expect(Math.min(...indices)).toBe(1);
      for (const [name, pad] of t) {
        expect(padPoints(pad).length, `${c.id}.${name} has no outline`).toBeGreaterThan(2);
        const { w, h } = padSize(pad);
        expect(w, `${c.id}.${name} is flat`).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);
      }
    }
  });

  it("keeps millimetres out of the stored representation and inches out of the model", () => {
    // A 1206 pad is a couple of millimetres, which is a couple of hundredths of an inch. If the scale
    // were dropped the two would differ by 25x, and a pad would be the size of a fingernail.
    const pad = padNamed(R_1206, "1");
    expect(Math.abs(pad.pos[0])).toBeLessThan(0.5);        // inches, as stored
    expect(Math.abs(padAt(pad).x)).toBeGreaterThan(1);     // millimetres, as read
    expect(padAt(pad).x * (1 / MM_PER_INCH)).toBeCloseTo(pad.pos[0], 12);
  });

  it("tells a terminal from a mounting hole", () => {
    // The switch seats on two pegs. They are in the footprint because we cut them, but a rail must never
    // try to reach one — being off every copper layer is what says so.
    const pegs = holes(SW_SPDT);
    expect(pegs.length).toBe(2);
    for (const peg of pegs) {
      // The FabLib declares these `thru_hole` on `*.Cu`, so they really are plated and copper alone
      // does not tell them from a terminal. What does is that the file gives them no name.
      expect(carriesCopper(peg)).toBe(true);
      const name = Object.entries(SW_SPDT).find(([, p]) => p === peg)![0];
      expect(isTerminal(name, peg)).toBe(false);
      expect(peg.drill!.diameter).toBeGreaterThan(0);
    }
    expect(terminals(SW_SPDT).map(([n]) => n)).toEqual(["1", "2", "3"]);
  });

  it("reads a two-terminal part as a gap the rail can be broken by", () => {
    for (const part of [LED, RESISTOR]) {
      expect(part.pitch).toBeGreaterThan(part.pad.w);
      // The gap is bare pattern between the pads — pitch less one pad, so each pad still lands on copper.
      expect(part.gap).toBeCloseTo(part.pitch - part.pad.w, 12);
      expect(part.gap).toBeGreaterThan(0);
    }
    // They used to be asserted equal — both are 1206 packages, so both were 4mm pitch on 2mm pads.
    // The FabLib does not agree with itself about that: its `LED_1206` is the wide hand-solder land
    // (3.4mm centres, 1.4mm pads) and its `R_1206` the tighter one (3.0mm on 1.2mm). That is the
    // vendor's reading of the same package and we take it, so what is checked now is that both are
    // still 1206-sized rather than that they match — an inch slipped in anywhere would be 25x out.
    for (const part of [LED, RESISTOR]) {
      expect(part.pitch).toBeGreaterThan(2.5);
      expect(part.pitch).toBeLessThan(4.5);
    }
    expect(LED.pitch).not.toBeCloseTo(RESISTOR.pitch, 1);
  });

  it("moves only the switch's common, and moves it across", () => {
    // The part itself is single-row surface mount: all three terminals share an edge.
    const rows = new Set(terminals(SW_SPDT).map(([, p]) => p.pos[1]));
    expect(rows.size, "the stored footprint should be the manufacturer's, unmodified").toBe(1);

    // The model puts the common on the far side so a rail runs through rather than doubling back.
    expect(Math.sign(SPDT.common.y)).toBe(-Math.sign(SPDT.throwA.y));
    expect(SPDT.rowSep).toBeCloseTo(SPDT.throwA.y - SPDT.common.y, 12);
    expect(SPDT.rowSep).toBeGreaterThan(0);

    // The throws stay where the part put them: same row, a pitch either side of the common's column.
    expect(SPDT.throwA.y).toBeCloseTo(SPDT.throwB.y, 12);
    expect(SPDT.throwB.x - SPDT.common.x).toBeCloseTo(SPDT.pitch, 12);
    expect(SPDT.common.x - SPDT.throwA.x).toBeCloseTo(SPDT.pitch, 12);
  });

  it("takes the switch pitch from the file rather than from the package name", () => {
    // Twice this was wrong: 2.54mm assumed from "1x03", then 2.5mm read off a datasheet page. The
    // footprint says 2.5mm exactly, and now so do we.
    // To four places, not nine: coordinates are stored quantised to a millionth of an inch, so 2.5mm
    // comes back 5 nanometres short. The number this test exists to reject is 2.54, which is 0.04 away.
    expect(SPDT.pitch).toBeCloseTo(2.5, 4);
  });

  it("draws a rect pad as its four corners and no more", () => {
    // The cheapest possible check that a pad's outline is the pad and not a stand-in: a `rect` is a
    // closed quadrilateral, five points. Anything else means the shape branch changed under us. What a
    // *curved* pad's outline has to be is `kicad-parser.test.ts`'s question — it holds the chord budget
    // and the FabLib's one roundrect part — and is not restated here.
    expect(padPoints(padNamed(LED_1206, "1")).length).toBe(5);
    expect(padPoints(padNamed(R_1206, "2")).length).toBe(5);
  });

  it("keeps the LED's pads a pad-width apart, so a break leaves copper under both", () => {
    const [a, c] = [padNamed(LED_1206, "1"), padNamed(LED_1206, "2")];
    expect(padAt(a).y).toBeCloseTo(padAt(c).y, 12);
    expect(Math.abs(padAt(c).x - padAt(a).x)).toBeCloseTo(LED.pitch, 12);
    expect(padSize(a)).toEqual(padSize(c));
  });
});


/**
 * The scan.
 *
 * `ocaml/footprints.ml` no longer holds a list of parts. It reads `footprints/fab/`, so the library is
 * whatever is on disk and adding a part is dropping a file in a directory. That moves where the risk
 * lives: nothing can be *wrong* in a list any more, but a file can be silently missed, two files can
 * collide onto one name, and the name or the blurb can drift from what the file actually says. None of
 * those is visible by reading the generated output — the parts are listed in it — so all four are
 * checked here against the directory itself rather than against a copy of the answer.
 *
 * `kicad-parser.test.ts` checks the other direction: every generated part back against its own source
 * file's pad count and pad sizes. Between the two, all the footprints are accounted for both ways —
 * nothing on disk is missing from the library, and nothing in the library was invented.
 */
describe("model/footprints — the scan", () => {
  const FAB = new URL("../../../footprints/fab/", import.meta.url);
  const GENERATED = [
    new URL("../../../src/model/footprints.generated.ts", import.meta.url),
    new URL("../../../src/model/footprints.rest.generated.ts", import.meta.url),
  ];

  /** The three parts whose names predate the FabLib, and which no rule over a filename can produce. */
  const ALIASES: Record<string, string> = {
    "Switch_Slide_RightAngle_CnK_AYZ0102AGRLC_7.2x3mm.kicad_mod": "SW_SPDT",
    "Button_CnK_PTS636.0_6x3.5mm.kicad_mod": "SW_PUSH",
    "Battery-Holder_Coin-Cell_CR2032_Linx_BAT-HLD-001.kicad_mod": "BAT_COIN_20",
  };

  const files = readdirSync(FAB).filter((f) => f.endsWith(".kicad_mod")).sort();
  const source = (file: string) => readFileSync(new URL(file, FAB), "utf8");

  /**
   * Which file each part came from, out of the doc comment the generator writes above it. Read from
   * the text rather than from the data because the data does not carry it — and the whole question
   * here is whether the file on disk and the const in the library are the same part.
   */
  const provenance = (() => {
    const map = new Map<string, string>();
    for (const url of GENERATED) {
      const text = readFileSync(url, "utf8");
      const re = /from `([^`]+\.kicad_mod)`\.\s*\*\/\s*export const (\w+): Footprint/g;
      for (let m = re.exec(text); m; m = re.exec(text)) map.set(m[2]!, m[1]!);
    }
    return map;
  })();

  /**
   * The id rule, restated: everything that cannot appear in a TypeScript identifier becomes `_`, runs
   * of those collapse, the ends are trimmed, and a leading digit gets a `_` in front of it. Written
   * out again here rather than shared with the generator, which is in OCaml and cannot be imported —
   * so this is a second reading of the rule, which is the only kind worth testing against.
   */
  function derivedId(stem: string): string {
    const s = stem.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
    if (s === "") return "part";
    return /^[0-9]/.test(s) ? `_${s}` : s;
  }

  /** A KiCad string literal's escapes, undone — `descr` fields carry `\"` around inch measurements. */
  const unescape = (s: string) =>
    s.replace(/\\(.)/g, (_, c: string) =>
      c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c);

  /** A `(descr ...)` value, which is usually a quoted string but is a bare atom in a few files. */
  const field = (text: string, name: string) => {
    const m = new RegExp(`\\(${name}\\s+(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s()]+))`).exec(text);
    if (!m) return "";
    return unescape(m[1] ?? m[2]!).replace(/\s+/g, " ").trim();
  };

  /** The note rule, restated: the file's own `descr` with any bare URL taken out of it, else its
      `tags`, else the filename as words. */
  function derivedNote(file: string, text: string): string {
    const tidy = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[\s,;:\-(]+$/, "");
    const descr = tidy(
      field(text, "descr")
        .split(" ")
        // A leading bracket or quote does not stop a word being a link: one `descr` reads
        // "TQFP, 144 Pin (http://…), generated with …".
        .filter((w) => !/^[([<"']*https?:\/\//.test(w))
        .join(" "),
    );
    if (descr !== "") return descr;
    const tags = tidy(field(text, "tags"));
    if (tags !== "") return tags;
    return file.replace(/\.kicad_mod$/, "").replace(/_/g, " ");
  }

  it("emits exactly one part per footprint file, and nothing for what is not a footprint", () => {
    // The directory is vendored wholesale, so it holds the FabLib's licence too. A scan that took
    // every file would either crash on it or, worse, emit an empty part named LICENSE.
    expect(readdirSync(FAB)).toContain("LICENSE");
    expect(files.length).toBe(129);

    // Every file is in the library exactly once, and every part in the library is one of those files.
    // Checked as a bijection rather than as a count: one part short with one part twice counts the
    // same as one from each file, and is a part silently missing.
    const byFile = new Map<string, string[]>();
    for (const c of ALL) {
      const file = provenance.get(c.id);
      expect(file, `${c.id} records no source file`).toBeDefined();
      byFile.set(file!, [...(byFile.get(file!) ?? []), c.id]);
    }
    expect([...byFile.keys()].sort()).toEqual(files);
    for (const [file, ids] of byFile) expect(ids, `${file} emitted more than once`).toHaveLength(1);
  });

  it("names a part by a rule over its filename, aliasing only where the rule cannot reach", () => {
    const aliased: string[] = [];
    for (const c of ALL) {
      const file = provenance.get(c.id)!;
      const stem = file.replace(/\.kicad_mod$/, "");
      if (ALIASES[file] !== undefined) {
        expect(c.id, `${file} should be aliased`).toBe(ALIASES[file]);
        // An alias is only justified where the rule genuinely cannot produce the wanted name.
        expect(derivedId(stem), `${file} needs no alias`).not.toBe(ALIASES[file]);
        aliased.push(file);
        continue;
      }
      expect(c.id, `${file} was not named by the rule`).toBe(derivedId(stem));
    }
    expect(aliased.sort(), "aliases beyond the three declared ones").toEqual(Object.keys(ALIASES).sort());

    // And every name is usable: a legal identifier, and its own.
    for (const c of ALL) expect(c.id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(new Set(ALL.map((c) => c.id)).size).toBe(ALL.length);
  });

  it("keeps the seven names the app and its tests already reach for", () => {
    // These are imported by `parts.ts`, by the export, and by four test files. A rename here is not a
    // rename, it is a part that has vanished.
    const want: Record<string, string> = {
      LED_1206: "LED_1206.kicad_mod",
      R_1206: "R_1206.kicad_mod",
      C_1206: "C_1206.kicad_mod",
      R_2010: "R_2010.kicad_mod",
      SW_SPDT: "Switch_Slide_RightAngle_CnK_AYZ0102AGRLC_7.2x3mm.kicad_mod",
      SW_PUSH: "Button_CnK_PTS636.0_6x3.5mm.kicad_mod",
      BAT_COIN_20: "Battery-Holder_Coin-Cell_CR2032_Linx_BAT-HLD-001.kicad_mod",
    };
    for (const [id, file] of Object.entries(want)) {
      const c = ALL.find((x) => x.id === id);
      expect(c, `${id} is gone from the library`).toBeDefined();
      expect(provenance.get(id), `${id} now comes from a different part`).toBe(file);
      expect(Object.keys(c!.footprint).length).toBeGreaterThan(0);
    }
  });

  it("says what a part is in the words of its own file, not in its filename", () => {
    for (const c of ALL) {
      const file = provenance.get(c.id)!;
      expect(c.note, `${c.id} has no note`).not.toBe("");
      expect(c.note, `${c.id}'s note is not its file's`).toBe(derivedNote(file, source(file)));
    }

    // The three cases the rule exists for, spelled out. A `descr` is used as it stands; a `descr` that
    // is nothing but a datasheet URL is no description of a part, so the tags carry it; and with
    // neither field there is only the filename, which at least becomes words.
    const noteOf = (id: string) => ALL.find((c) => c.id === id)!.note;
    expect(noteOf("R_1206")).toBe("Resistor SMD 1206, hand soldering");
    expect(field(source("Switch_Slide_RightAngle_CnK_AYZ0102AGRLC_7.2x3mm.kicad_mod"), "descr")).toMatch(/^https?:\/\//);
    expect(noteOf("SW_SPDT")).toBe("switch spdt right angle slide");
    expect(field(source("Battery-Holder_Coin-Cell_CR2032_Linx_BAT-HLD-001.kicad_mod"), "descr")).toBe("");
    expect(noteOf("BAT_COIN_20")).toBe("Battery-Holder Coin-Cell CR2032 Linx BAT-HLD-001");

    // No note may carry a URL: the palette shows this string, and a link it cannot follow is noise
    // sitting where the part's name should be.
    for (const c of ALL) expect(c.note, `${c.id}`).not.toMatch(/https?:\/\//);
  });

  it("catalogues the very footprints it exported, not copies of them", () => {
    // `COMPONENTS` and the named consts are two ways to reach one library. If the catalogue held
    // clones, a part could be placed through the palette and drawn through the export and the two
    // would be different objects with the same numbers — until one of them changed.
    expect(COMPONENTS.find((c) => c.id === "R_1206")!.footprint).toBe(R_1206);
    expect(COMPONENTS.find((c) => c.id === "SW_SPDT")!.footprint).toBe(SW_SPDT);
    expect(COMPONENTS.find((c) => c.id === "LED_1206")!.footprint).toBe(LED_1206);
    // In id order, so the palette has something stable to lay out and a diff of the file is readable.
    for (const list of [COMPONENTS, REST_COMPONENTS]) {
      expect(list.map((c) => c.id)).toEqual([...list.map((c) => c.id)].sort());
    }
  });

  it("offers the whole library once the circuit has nets, not just the parts a rail can take", () => {
    // The two questions are different and the difference is the point. `placement()` asks whether a rail
    // can pass THROUGH a part, so it stops at three terminals — a forty-pin connector spliced into a run of
    // copper tape means nothing. `netPlacement()` asks only whether there is a pad to wire, because once
    // the author declares nets a part is a set of pads and a USB socket is perfectly placeable.
    //
    // This is what the user asked for: the palette's "in the library, but not in series on a rail" section
    // is empty in netlist mode.
    const inSeries = ALL.filter((c) => placement(c.footprint).placeable);
    const withNets = ALL.filter((c) => netPlacement(c.footprint).placeable);
    expect(inSeries.length).toBe(37);
    expect(withNets.length).toBe(129);
    // Nothing a rail can take is refused by the weaker test — it has to be strictly more permissive, or
    // turning nets on would take parts away.
    for (const c of inSeries) expect(netPlacement(c.footprint).placeable, c.id).toBe(true);
    // And every part it accepts can actually be resolved, or the palette is offering what nothing can wire.
    for (const c of withNets) expect(footprintById(c.id), c.id).toBeDefined();
  });

  it("refuses a part with nothing to wire, even with nets", () => {
    // One terminal is enough — a test point wired to a net is a legitimate thing to want, even though it
    // has nothing to bridge and so could never sit in series. Zero is not.
    expect(netPlacement({}).placeable).toBe(false);
    const one = Object.fromEntries([Object.entries(R_1206)[0]!]);
    expect(netPlacement(one).placeable).toBe(true);
    expect(placement(one).placeable).toBe(false); // and the series test still refuses it
  });

  it("puts a part in the eagerly-loaded half exactly when a rail can take it", () => {
    // The split USED to keep the main bundle small, holding back the parts a rail could not take. It no
    // longer does anything at load time: `library.ts` imports both halves statically, because once nets
    // arrived every part became placeable (see `netPlacement`) and the app was offering 92 parts that the
    // router, the cut files and the netlist could not resolve. Merging cost about 21kB gzipped and removed
    // a class of bug where the palette hands you a part it cannot wire.
    //
    // So this now checks the generator's rule against `placement()` and nothing more: two readings of a
    // footprint that must agree, which is a thing this codebase has been bitten by before. It costs
    // neither bytes nor correctness today — kept because the day the split is made load-bearing again is
    // the day a silent disagreement would matter.
    for (const c of ALL) {
      const eager = COMPONENTS.some((x) => x.id === c.id);
      expect(eager, `${c.id}: ${JSON.stringify(placement(c.footprint))}`).toBe(
        placement(c.footprint).placeable,
      );
    }
    // The two halves are one library between them: disjoint, and everything is in one of them.
    expect(COMPONENTS.length + REST_COMPONENTS.length).toBe(129);
    expect(new Set(ALL.map((c) => c.id)).size).toBe(129);
    // Most of the library is in the half a rail cannot take, which is what made the split look worthwhile.
    expect(REST_COMPONENTS.length).toBeGreaterThan(COMPONENTS.length);
  });
});
