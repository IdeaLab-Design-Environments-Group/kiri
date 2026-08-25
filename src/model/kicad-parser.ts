/**
 * **Model** — reading a `.kicad_mod` file into the library's pad representation.
 *
 * This is a TypeScript port of svg-pcb's `js/ki_cad_parser.js`, kept deliberately close to it: the same
 * s-expression reader, the same five shape cases, the same fixed tessellation, the same `${name}_${i}`
 * naming for repeated pads, and the same final flattening of a polygon list into one SVG path string.
 * Where this file departs from svg-pcb it says so and says why — there are exactly two such places, both
 * marked DIVERGENCE, and neither changes the shape of the output.
 *
 * The representation is svg-pcb's: a footprint is an object keyed by pad name, each pad an SVG path about
 * its own origin (`shape`), where that origin sits (`pos`), and which layers it is on (`layers`). Lengths
 * are INCHES — KiCad's millimetres divided by 25.4 — and Y grows upward, KiCad's growing downward. Both
 * conversions happen here and nowhere else; {@link ./footprint.ts} converts back at the point of use.
 */
import type { Footprint, Pad } from "./footprints.generated.js";

/** KiCad is millimetres; the representation is inches. */
const SCALE = 1 / 25.4;

/** svg-pcb tessellates a full circle into this many chords, regardless of radius. */
const CIRCLE_STEPS = 360 / 2;

/** svg-pcb puts this many points on each corner of a rounded rectangle, regardless of radius. */
const POINTS_PER_CORNER = 10;

type Point = [number, number];
type Poly = Point[];

/** An s-expression: an atom is always a string — see {@link sParse}. */
type SExpr = string | SExpr[];

// ---- s-expression reader -------------------------------------------------

const SPACE_PAREN_OR_END = /^(\s|\\|"|'|`|,|\(|\)|$)/;
const STRING_OR_ESCAPED_OR_END = /^(\\|"|$)/;

/**
 * Parse one s-expression from `text`.
 *
 * Ported from the `fwg/s-expression` reader svg-pcb vendors. The one property worth stating, because the
 * rest of this file depends on it and because svg-pcb itself gets caught out by it: **an atom is always a
 * string.** There is no number coercion anywhere in the reader, so `(drill 1.2)` yields the string
 * `"1.2"`, never the number `1.2`. Every call site that wants a number wraps it in `Number(...)`.
 */
export function sParse(text: string): SExpr {
  let pos = 0;

  const peek = (): string => text[pos] ?? "";
  const consume = (): string => text[pos++] ?? "";

  const until = (re: RegExp): string => {
    let out = "";
    while (pos < text.length && !re.test(text.slice(pos, pos + 1))) out += consume();
    return out;
  };

  const skipSpace = (): void => {
    while (pos < text.length && /\s/.test(peek())) pos++;
  };

  const string = (): string => {
    consume(); // opening quote
    let out = "";
    for (;;) {
      out += until(STRING_OR_ESCAPED_OR_END);
      const ch = peek();
      if (ch === '"') { consume(); break; }
      if (ch === "\\") { consume(); out += consume(); continue; }
      break; // end of input inside a string: take what we have, as the reader does
    }
    return out;
  };

  const atom = (): string => {
    if (peek() === '"') return string();
    let out = "";
    for (;;) {
      out += until(SPACE_PAREN_OR_END);
      if (peek() !== "\\") break;
      consume();
      out += consume();
    }
    return out;
  };

  const list = (): SExpr[] => {
    consume(); // "("
    const out: SExpr[] = [];
    for (;;) {
      skipSpace();
      if (pos >= text.length) break;
      if (peek() === ")") { consume(); break; }
      out.push(expr());
    }
    return out;
  };

  const expr = (): SExpr => (peek() === "(" ? list() : atom());

  skipSpace();
  return expr();
}

// ---- geometry ------------------------------------------------------------

/** A rectangle about the origin, wound from the top-left and closed. */
function rectangle(w: number, h: number): Poly[] {
  const p0: Point = [-w / 2, h / 2];
  const p1: Point = [w / 2, h / 2];
  const p2: Point = [w / 2, -h / 2];
  const p3: Point = [-w / 2, -h / 2];
  return [[p0, p1, p2, p3, p0]];
}

/**
 * KiCad's trapezoid: a rectangle whose opposite sides are shortened by `(rect_delta dx dy)`, which is how
 * a pad is drawn to fan out towards a package's corner.
 *
 * **DIVERGENCE 3 — svg-pcb has no `trapezoid` case at all.** Its `shapeCases` covers `rect`, `roundrect`,
 * `circle`, `oval` and `custom`, so a trapezoid falls through to `[]` and the pad is emitted with an EMPTY
 * path — a terminal with no copper, which `padSize`/`padPoints` cannot measure. This library has exactly
 * two such pads (`A1` and its repeat on `Sensor_Optical_ST_VL53L5CXV0GC`), and both carry no `rect_delta`,
 * so with zero deltas this reduces corner-for-corner to {@link rectangle}. Following KiCad's own
 * `TransformTrapezoidToPolygon`: with half-sizes hw/hh and half-deltas ddx/ddy the corners are
 * (-hw ± ddy, ±hh ± ddx). Wound from the top-left and closed, to match {@link rectangle}.
 */
function trapezoid(w: number, h: number, dx: number, dy: number): Poly[] {
  const hw = w / 2, hh = h / 2, ddx = dx / 2, ddy = dy / 2;
  const pts: Poly = [
    [-hw + ddy, hh + ddx],
    [hw - ddy, hh - ddx],
    [hw + ddy, -hh + ddx],
    [-hw - ddy, -hh - ddx],
  ];
  pts.push([pts[0]![0], pts[0]![1]]);
  return [pts];
}

/** A circle about the origin, at svg-pcb's fixed {@link CIRCLE_STEPS} chords. */
function circle(r: number): Poly[] {
  const pts: Poly = [];
  for (let i = 0; i < CIRCLE_STEPS; i++) {
    const theta = ((Math.PI * 2) / CIRCLE_STEPS) * i;
    pts.push([r * Math.cos(theta), r * Math.sin(theta)]);
  }
  pts.push([pts[0]![0], pts[0]![1]]);
  return [pts];
}

/**
 * A rounded rectangle, cornered by `rratio` of its shorter side. `rratio = 1` rounds it into an oval,
 * which is how svg-pcb builds the `oval` pad shape too.
 */
function generateRoundRect(
  centerX: number, centerY: number, width: number, height: number,
  rratio: number, numPointsPerCorner = POINTS_PER_CORNER,
): Poly {
  const radius = (Math.min(width, height) * rratio) / 2;

  const topLeft: Point = [centerX - width / 2 + radius, centerY - height / 2 + radius];
  const topRight: Point = [centerX + width / 2 - radius, centerY - height / 2 + radius];
  const bottomRight: Point = [centerX + width / 2 - radius, centerY + height / 2 - radius];
  const bottomLeft: Point = [centerX - width / 2 + radius, centerY + height / 2 - radius];

  const points: Poly = [];
  const sweep = (i: number): number => (Math.PI / 2) * (i / (numPointsPerCorner - 1));

  for (let i = 0; i < numPointsPerCorner; i++) {
    const a = sweep(i);
    points.push([topLeft[0] - radius * Math.cos(a), topLeft[1] - radius * Math.sin(a)]);
  }
  for (let i = 0; i < numPointsPerCorner; i++) {
    const a = sweep(i);
    points.push([topRight[0] + radius * Math.sin(a), topRight[1] - radius * Math.cos(a)]);
  }
  for (let i = 0; i < numPointsPerCorner; i++) {
    const a = sweep(i);
    points.push([bottomRight[0] + radius * Math.cos(a), bottomRight[1] + radius * Math.sin(a)]);
  }
  for (let i = 0; i < numPointsPerCorner; i++) {
    const a = sweep(i);
    points.push([bottomLeft[0] - radius * Math.sin(a), bottomLeft[1] + radius * Math.cos(a)]);
  }

  points.push([points[0]![0], points[0]![1]]);
  return points;
}

/** Rotate every point of every polygon by `angle` DEGREES about `point`, in place. */
function rotateShape(shape: Poly[], angle: number, point: Point = [0, 0]): Poly[] {
  const delta = (angle / 180) * Math.PI;
  const cos = Math.cos(delta), sin = Math.sin(delta);
  shape.forEach((pl, i) => {
    shape[i] = pl.map(([x, y]): Point => {
      const hx = x - point[0], hy = y - point[1];
      return [hx * cos - hy * sin + point[0], hy * cos + hx * sin + point[1]];
    });
  });
  return shape;
}

// ---- s-expression helpers ------------------------------------------------

/**
 * `*.Cu` means both sides. Expand it, and pass anything already sided straight through.
 */
function convertLayers(layers: string[]): string[] {
  return layers.reduce<string[]>((acc, cur) => {
    const l = cur.split(".");
    if (l.length === 0) return acc;
    if (l[0] !== "*") return [...acc, cur];
    return [...acc, `F.${l[1]}`, `B.${l[1]}`];
  }, []);
}

/** The tail of the child list headed by `name` — `(at 1 2)` under `"at"` gives `["1","2"]`. */
function getNamedArray(line: SExpr[], name: string): SExpr[] {
  const found = line.find((entry) => Array.isArray(entry) && entry[0] === name);
  return Array.isArray(found) ? found.slice(1) : [];
}

const num = (v: SExpr | undefined): number => Number(typeof v === "string" ? v : NaN);

/** Whether an atom reads as a number. See the DIVERGENCE note in {@link kicadParser}. */
function isNumeric(v: SExpr | undefined): boolean {
  return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
}

// ---- the parser ----------------------------------------------------------

interface RawPad {
  pos: number[];
  shape: Poly[];
  layers: string[];
  drill?: { diameter: number; start: string; end: string; plated: boolean };
  /** Position of this pad in the FILE, 1-based. See the note on `index` in {@link kicadParser}. */
  ord: number;
}

/**
 * Read a `.kicad_mod` file into a {@link Footprint}.
 *
 * Follows svg-pcb's `kicadParser` step for step: take every `pad` that is `smd` or `thru_hole`, scale it
 * to inches, flip Y, build its outline from the shape case, rotate it, and key it by pad name — with
 * repeats of one name becoming `name`, `name_1`, `name_2` in file order.
 *
 * **DIVERGENCE 1 — circular drills.** svg-pcb guards this with `typeof line[drillIndex][1] === "number"`,
 * and its s-expression reader returns atoms as STRINGS, so that test can never pass and svg-pcb emits a
 * `drill` for no pad at all. Reproducing that faithfully would drop all 157 drills in this library, and
 * they are not decorative: {@link ../model/footprint.ts} selects mounting holes by `drill !== undefined`,
 * and the cut file draws each one at `drill.diameter`. A faithful port would silently stop cutting holes.
 * So the guard here asks whether the atom READS as a number, which is what svg-pcb meant.
 *
 * **DIVERGENCE 2 — `index`.** svg-pcb's pads carry no index. kiri's do, and the router reads it:
 * `parts.ts` orders terminals by it. It is the 1-based order of first appearance, so it is a function of
 * the file alone and does not depend on anything svg-pcb would have computed differently.
 */
export function kicadParser(data: string): Footprint {
  const parsed = sParse(data);
  const root: SExpr[] = Array.isArray(parsed) ? parsed : [];

  const padsToAdd: Record<string, RawPad[]> = {};
  let ord = 0;

  for (const entry of root) {
    if (!Array.isArray(entry)) continue;
    const line = entry;
    if (line[0] !== "pad") continue;
    if (line[2] !== "smd" && line[2] !== "thru_hole") continue;

    const shape = typeof line[3] === "string" ? line[3] : "";
    const name = typeof line[1] === "string" ? line[1] : "";

    const atRaw = getNamedArray(line, "at");
    const at = atRaw.slice(0, 2).map((x) => num(x) * SCALE);
    at[1] = -(at[1] ?? 0); // KiCad's Y grows downward
    const rotate = atRaw.length === 3 ? num(atRaw[2]) : 0;

    const layers = convertLayers(getNamedArray(line, "layers").filter((l): l is string => typeof l === "string"));
    const size = getNamedArray(line, "size").map((x) => num(x) * SCALE);

    let geometry: Poly[];
    switch (shape) {
      case "rect":
        geometry = rectangle(size[0]!, size[1]!);
        break;
      case "roundrect": {
        const ratio = num(getNamedArray(line, "roundrect_rratio")[0]);
        geometry = [generateRoundRect(0, 0, size[0]!, size[1]!, ratio)];
        break;
      }
      case "circle":
        geometry = circle(size[0]! / 2);
        break;
      case "trapezoid": {
        const d = getNamedArray(line, "rect_delta").map((x) => num(x) * SCALE);
        geometry = trapezoid(size[0]!, size[1]!, d[0] ?? 0, d[1] ?? 0);
        break;
      }
      case "oval":
        geometry = [generateRoundRect(0, 0, size[0]!, size[1]!, 1)];
        break;
      case "custom": {
        const primitives = getNamedArray(line, "primitives");
        const first = primitives[0];
        const pts = Array.isArray(first) && Array.isArray(first[1]) ? first[1].slice(1) : [];
        geometry = [pts.map((xy): Point => (Array.isArray(xy) ? [num(xy[1]) * SCALE, num(xy[2]) * SCALE] : [0, 0]))];
        break;
      }
      default:
        geometry = [];
    }

    rotateShape(geometry, rotate);

    ord += 1;
    const pad: RawPad = { pos: at, shape: geometry, layers, ord };

    const drillIdx = line.findIndex((e) => Array.isArray(e) && e[0] === "drill");
    const drillLine = drillIdx !== -1 ? (line[drillIdx] as SExpr[]) : null;

    if (drillLine && isNumeric(drillLine[1])) {
      pad.drill = { diameter: num(drillLine[1]) * SCALE, start: "F.Cu", end: "B.Cu", plated: true };
    }

    // An oval drill is a slot, not a hole: svg-pcb emits it as a second pad on its own layers so the
    // outline can be cut rather than drilled.
    if (drillLine && drillLine[1] === "oval") {
      const slot = [generateRoundRect(0, 0, num(drillLine[2]) * SCALE, num(drillLine[3]) * SCALE, 1)];
      rotateShape(slot, rotate);
      const key = `${name}_plated_cut`;
      ord += 1;
      const cut: RawPad = { pos: at, shape: slot, layers: ["outline", "Thru.Hole"], ord };
      (padsToAdd[key] ??= []).push(cut);
    }

    (padsToAdd[name] ??= []).push(pad);
  }

  // Repeats of one pad name become `name`, `name_1`, `name_2` in file order.
  const flat: Record<string, RawPad> = {};
  for (const [key, value] of Object.entries(padsToAdd)) {
    if (value.length === 1) flat[key] = value[0]!;
    else value.forEach((v, i) => { flat[i === 0 ? key : `${key}_${i}`] = v; });
  }

  const out: Record<string, Pad> = {};
  for (const key of Object.keys(flat)) {
    const raw = flat[key]!;
    let d = "";
    for (const poly of raw.shape) {
      poly.forEach(([x, y], i) => { d += `${i === 0 ? "M" : "L"} ${x} ${y} `; });
    }
    out[key] = {
      shape: d,
      pos: [raw.pos[0] ?? 0, raw.pos[1] ?? 0],
      layers: raw.layers,
      index: raw.ord,
      ...(raw.drill ? { drill: raw.drill } : {}),
    } as Pad;
  }

  return out as Footprint;
}
