/**
 * **Script** — kirigamize a folder of meshes into the examples the Examples page shows.
 *
 * For each `.stl` it is given: run the same pipeline the app runs, write the pattern as `<slug>.fkld`
 * beside the mesh in `public/examples/`, and draw two previews into `public/examples/previews/`:
 *
 * - `<slug>.svg` — the FOLDED form, shaded, from the pattern's own solved frame. This is what the tile
 *   shows, because it is what the person is choosing between: the thing the sheet becomes.
 * - `<slug>-flat.svg` — the flat pattern, creases coloured by assignment. Shown on the back of the tile,
 *   so a glance says how much cutting a model is before it is opened.
 *
 * Both previews are drawn from the FKLD rather than from the mesh, deliberately: they then describe the
 * pattern the page actually hands you, and a model whose kirigamization changes gets a preview that
 * changes with it. The 3D one is a painter-sorted projection with one light — no GL, so this runs in
 * plain node with everything else.
 *
 * Usage:  npx vite-node scripts/gen-example-previews.ts -- <folder-of-stls> [slug ...]
 * Naming: the slug is the file's basename, and the part before the first `-` groups it on the page
 *         (`guitar-neck` and `guitar-headstock` are one model). See `examples-catalog.ts`.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseMesh } from "../src/pipeline/import.js";
import { kirigamize } from "../src/pipeline/kirigamize.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "public", "examples");
const PREVIEWS = join(OUT, "previews");

/** The preview palette. Deliberately the page's own tokens, so a tile and its picture agree. */
const INK = "#1f2328";
const FACE_LIT = "#dfe6f5";
const FACE_DARK = "#7f8ea8";
const FLAT_FILL = "#f6f8fc";
const MOUNTAIN = "#c2410c";
const VALLEY = "#1f6feb";
const CUT = "#1f2328";
const FLAT_EDGE = "#c2c9d6";

type Vec3 = [number, number, number];
type Vec2 = [number, number];

interface Fkld {
  vertices_coords: number[][];
  edges_vertices: [number, number][];
  edges_assignment: string[];
  faces_vertices: number[][];
  file_frames?: { vertices_coords: number[][] }[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Three-quarter view: turned and tipped, the angle a model is photographed from. */
function camera(): { right: Vec3; up: Vec3; fwd: Vec3 } {
  const yaw = (-35 * Math.PI) / 180;
  const pitch = (28 * Math.PI) / 180;
  const fwd = norm([Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]);
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = norm(cross(right, fwd));
  return { right, up, fwd };
}

/** Fit a cloud of 2D points into a `size`-square box with a margin, as a transform. */
function fitter(pts: Vec2[], size: number, pad: number): (p: Vec2) => Vec2 {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const k = (size - 2 * pad) / span;
  const ox = pad + ((size - 2 * pad) - (maxX - minX) * k) / 2;
  const oy = pad + ((size - 2 * pad) - (maxY - minY) * k) / 2;
  return (p) => [ox + (p[0] - minX) * k, oy + (p[1] - minY) * k];
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();

/** Mix two hex colours, `t` of the way from `a` to `b`. */
function mix(a: string, b: string, t: number): string {
  const hex = (c: string): [number, number, number] =>
    [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const [ar, ag, ab] = hex(a);
  const [br, bg, bb] = hex(b);
  const ch = (x: number, y: number): string =>
    Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

/** The folded model, shaded, as an SVG. */
function foldedSvg(fkld: Fkld, size = 480): string {
  const frame = fkld.file_frames?.[0]?.vertices_coords;
  if (!frame) return flatSvg(fkld, size);
  const verts = frame.map((v) => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] as Vec3);
  const { right, up, fwd } = camera();
  const project = (v: Vec3): Vec2 => [dot(v, right), -dot(v, up)];
  const flat = verts.map(project);
  const fit = fitter(flat, size, 26);
  const light = norm([-0.4, 0.8, 0.45]);

  // Painter's algorithm: draw the far faces first. Depth is the face centre along the view direction,
  // which is exact enough for the closed shells these examples are and needs no BSP.
  const faces = fkld.faces_vertices
    .map((f) => {
      const vs = f.map((i) => verts[i]!);
      const n = norm(cross(sub(vs[1]!, vs[0]!), sub(vs[2]!, vs[0]!)));
      const depth = vs.reduce((a, v) => a + dot(v, fwd), 0) / vs.length;
      // Two-sided: a kirigami sheet is looked at from both faces, and an unlit back reads as a hole.
      const lambert = Math.abs(dot(n, light));
      return { f, depth, shade: 0.25 + 0.75 * lambert };
    })
    .sort((a, b) => b.depth - a.depth);

  const body = faces.map(({ f, shade }) => {
    const pts = f.map((i) => fit(flat[i]!)).map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");
    const fill = mix(FACE_DARK, FACE_LIT, Math.min(1, Math.max(0, shade)));
    return `<polygon points="${pts}" fill="${fill}" stroke="${fill}" stroke-width="0.6"/>`;
  }).join("");

  // The silhouette back on top: every edge the pattern cuts, which is what makes a kirigami read as
  // pierced rather than as a smooth blob.
  const cuts = fkld.edges_vertices
    .map((e, i) => ({ e, a: fkld.edges_assignment[i] }))
    .filter(({ a }) => a === "C" || a === "B")
    .map(({ e }) => {
      const [p, q] = [fit(flat[e[0]]!), fit(flat[e[1]]!)];
      return `<line x1="${fmt(p[0])}" y1="${fmt(p[1])}" x2="${fmt(q[0])}" y2="${fmt(q[1])}"`
        + ` stroke="${INK}" stroke-opacity="0.35" stroke-width="1" stroke-linecap="round"/>`;
    }).join("");

  return svg(size, `${body}${cuts}`);
}

/** The flat pattern, creases coloured by assignment. */
function flatSvg(fkld: Fkld, size = 480): string {
  const flat = fkld.vertices_coords.map((v) => [v[0] ?? 0, v[1] ?? 0] as Vec2);
  const fit = fitter(flat, size, 26);
  const faces = fkld.faces_vertices.map((f) => {
    const pts = f.map((i) => fit(flat[i]!)).map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");
    return `<polygon points="${pts}" fill="${FLAT_FILL}" stroke="${FLAT_EDGE}" stroke-width="0.5"/>`;
  }).join("");
  const stroke = (a: string): { colour: string; width: number; dash: string } => {
    if (a === "M") return { colour: MOUNTAIN, width: 1.4, dash: "" };
    if (a === "V") return { colour: VALLEY, width: 1.4, dash: ` stroke-dasharray="5 3"` };
    if (a === "C" || a === "B") return { colour: CUT, width: 1.8, dash: "" };
    return { colour: FLAT_EDGE, width: 0.6, dash: "" };
  };
  const edges = fkld.edges_vertices.map((e, i) => {
    const { colour, width, dash } = stroke(fkld.edges_assignment[i] ?? "F");
    const [p, q] = [fit(flat[e[0]]!), fit(flat[e[1]]!)];
    return `<line x1="${fmt(p[0])}" y1="${fmt(p[1])}" x2="${fmt(q[0])}" y2="${fmt(q[1])}"`
      + ` stroke="${colour}" stroke-width="${width}" stroke-linecap="round"${dash}/>`;
  }).join("");
  return svg(size, `${faces}${edges}`);
}

function svg(size: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" `
    + `width="${size}" height="${size}" role="img">${body}</svg>\n`;
}

function main(): void {
  const [, , dirArg, ...only] = process.argv;
  if (!dirArg) throw new Error("usage: gen-example-previews.ts <folder-of-stls> [slug ...]");
  const dir = resolve(dirArg);
  mkdirSync(PREVIEWS, { recursive: true });
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".stl"))
    .filter((f) => only.length === 0 || only.includes(basename(f, ".stl")))
    .sort();
  for (const file of files) {
    const slug = basename(file, ".stl");
    const started = Date.now();
    try {
      const mesh = parseMesh(readFileSync(join(dir, file), "utf8"), "stl");
      const fkld = (kirigamize(mesh, {} as never) as { fkld: Fkld }).fkld;
      writeFileSync(join(OUT, `${slug}.fkld`), JSON.stringify(fkld));
      writeFileSync(join(PREVIEWS, `${slug}.svg`), foldedSvg(fkld));
      writeFileSync(join(PREVIEWS, `${slug}-flat.svg`), flatSvg(fkld));
      const cuts = fkld.edges_assignment.filter((a) => a === "C" || a === "B").length;
      console.log(
        `OK   ${slug.padEnd(24)} faces=${String(fkld.faces_vertices.length).padStart(5)} `
        + `cuts=${String(cuts).padStart(4)}  ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    } catch (e: unknown) {
      const err = e as { stage?: string; message?: string };
      console.log(`FAIL ${slug.padEnd(24)} ${err.stage ?? ""} ${err.message ?? String(e)}`.slice(0, 160));
    }
  }
}

main();
