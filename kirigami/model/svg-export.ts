import type { PatternNet, PatternSegment, PatternStrokeRole } from "./pattern.js";
import type { FkldDownload } from "./fkld-export.js";
import { createZip } from "./zip.js";

/**
 * Cricut-ready SVG export, as **two separate files** packed into one folder:
 * - `…-cut.svg`   — everything to cut, black: the outer outline (which **V-notches inward at
 *   each molecule** so the relief wedge is already outside the silhouette — no separate slits)
 *   plus the major apex-hole cut. Roles `boundary` and `cut`.
 * - `…-score.svg` — the lines to crease, not cut, blue: the valley creases (`fold` role,
 *   each shortened to the wedge-vertex foldPt at the outer end) **plus each polygon
 *   triangle's two slant edges** (tip↔outerL, tip↔outerR) — the face↔molecule fold hinges.
 *
 * `buildCricutZip` bundles both into a single `.zip` whose contents sit in one folder
 * (`<baseName>/…`), since a browser download can't create a folder on disk directly.
 *
 * Both files share the same `viewBox` and mm size, so they stay registered (aligned) when
 * loaded into Cricut Design Space. Coords are mm, so they import at real size.
 *
 * **Cut layer = one `<g id="cut">` with a single filled even-odd path.** The smoothest Cricut
 * workflow uploads a kirigami net as one body whose V-notched perimeter and apex hole get cut
 * together. The cut layer is therefore a filled even-odd path (silhouette + apex-hole hole)
 * with `stroke="none"` — Cricut traces the fill edges as one continuous cut, no halo and no
 * double-cutting. Score lines stay per-segment stroked `<path>`s (Cricut scores *along* a line,
 * so they import fine that way).
 *
 * Face fills (`polygon` interiors, `molecule`, `molecule-fill`) are visual only and excluded;
 * the polygon outer base edges stay on the cut layer via the `boundary` outline.
 */

const CUT_ROLES: readonly PatternStrokeRole[] = ["boundary", "cut"];
const SCORE_ROLES: readonly PatternStrokeRole[] = ["fold"];

/** Cut layer colour — assign "Cut" in Cricut Design Space. */
export const CUT_COLOR = "#000000";
/** Score layer colour — assign "Score" in Cricut Design Space. */
export const SCORE_COLOR = "#0000ff";
/** Stroke width (mm) for the exported cut/score lines. */
export const LINE_STROKE_WIDTH = 0.25;
/**
 * Inset (mm) applied to each end of every score line so it doesn't touch a cut path. When a
 * score-line endpoint lands on the cut boundary (the V-notched silhouette or the apex-hole
 * rim), Cricut welds the coincident vertex and the score "compacts" the cut body — fragmenting
 * the imported piece. Pulling both ends inward by this gap keeps the crease clear of the cuts.
 */
export const SCORE_END_GAP = 1.5;

export interface CricutSvgFile {
  filename: string;
  svg: string;
}

/** A single downloadable archive (zip) containing the cut + score SVGs in one folder. */
export interface ExportArchive {
  filename: string;
  bytes: Uint8Array;
}

/** Inline preview SVGs (fit-to-box, non-scaling strokes) for the export modal. */
export interface CricutPreviews {
  /** Cut layer only. */
  cut: string;
  /** Score layer only. */
  score: string;
  /** Cut + score overlaid, same origin. */
  both: string;
}

/** Everything the export modal needs: thumbnails to show and the downloads to offer. */
export interface ExportPayload {
  previews: CricutPreviews;
  /** Two separate SVGs (cut, score) packed in one zip folder. */
  archive: ExportArchive;
  /** One combined SVG where stroke colour denotes the operation, or null when empty. */
  combined: CricutSvgFile | null;
  /**
   * FKLD JSON download — the full mesh topology + per-edge molecule
   * parameters serialized as a FOLD-superset file. Null when the
   * pattern is empty (matches `archive` / `combined`). The controller
   * populates this so the modal stays unaware of FoldNet internals.
   */
  fkld: FkldDownload | null;
}

/** One file per operation (cut, score). Layers with no paths are omitted. */
export function buildCricutSvgFiles(
  net: PatternNet,
  baseName = "akde-kirigami",
): CricutSvgFile[] {
  const cuts = cutSegments(net);
  const scores = scoreSegments(net);

  const files: CricutSvgFile[] = [];
  if (cuts.length > 0) {
    files.push({
      filename: `${baseName}-cut.svg`,
      svg: svgWrap(net, cutBodyMarkup(cuts, "  ")),
    });
  }
  if (scores.length > 0) {
    files.push({
      filename: `${baseName}-score.svg`,
      svg: svgWrap(net, linesMarkup(scores, "score", SCORE_COLOR, "  ")),
    });
  }
  return files;
}

/**
 * Single-file export: one SVG containing **both** operations, where the stroke colour
 * denotes the operation — cut paths in {@link CUT_COLOR} (black), score paths in
 * {@link SCORE_COLOR} (blue). This is the slicebug `plan` / Cricut "one import,
 * colour-coded layers" flow: feed this one file to slicebug with
 * `--map 000000:fine_point_blade --map 0000ff:scoring_stylus`, or import it into Design
 * Space and assign Cut to the black layer and Score to the blue layer.
 *
 * Same `viewBox` and mm size as the two-file export, so it imports at real size and the
 * two operations stay registered. Returns null when there is nothing to export.
 */
export function buildCombinedCricutSvg(
  net: PatternNet,
  baseName = "akde-kirigami",
): CricutSvgFile | null {
  const cuts = cutSegments(net);
  const scores = scoreSegments(net);
  if (cuts.length === 0 && scores.length === 0) return null;
  const body = [
    cuts.length > 0 ? cutBodyMarkup(cuts, "  ") : "",
    scores.length > 0 ? linesMarkup(scores, "score", SCORE_COLOR, "  ") : "",
  ]
    .filter((m) => m.length > 0)
    .join("\n");
  return {
    filename: `${baseName}-combined.svg`,
    svg: svgWrap(net, body),
  };
}

/**
 * Bundle the cut + score SVGs into one zip whose files live in a single `<baseName>/`
 * folder. Returns null if there is nothing to export.
 */
export function buildCricutZip(
  net: PatternNet,
  baseName = "akde-kirigami",
): ExportArchive | null {
  const files = buildCricutSvgFiles(net, baseName);
  if (files.length === 0) return null;
  const enc = new TextEncoder();
  const entries = files.map((f) => ({
    name: `${baseName}/${f.filename}`,
    data: enc.encode(f.svg),
  }));
  return { filename: `${baseName}.zip`, bytes: createZip(entries) };
}

/**
 * Build the three modal previews from one net: cut only, score only, and both overlaid
 * (same viewBox ⇒ same origin/scale, so they register exactly). Strokes use
 * `vector-effect="non-scaling-stroke"` so they stay visible at thumbnail size.
 */
export function buildCricutPreviews(net: PatternNet): CricutPreviews {
  const cuts = cutSegments(net);
  const scores = scoreSegments(net);
  return {
    cut: previewSvg(net, [{ segs: cuts, color: CUT_COLOR }]),
    score: previewSvg(net, [{ segs: scores, color: SCORE_COLOR }]),
    both: previewSvg(net, [
      { segs: cuts, color: CUT_COLOR },
      { segs: scores, color: SCORE_COLOR },
    ]),
  };
}

/**
 * Net → SVG-side export payload (previews + zip + combined), or null when
 * there is nothing to export. `fkld` is initialised to null here — the
 * controller fills it in via `buildFkldDownload(state)` because that
 * helper needs the full KirigamiState, not just the flat PatternNet.
 * Keeping the SVG and FKLD pipelines split in this module avoids a
 * dependency from `svg-export` onto FoldNet.
 */
export function buildExportPayload(
  net: PatternNet,
  baseName = "akde-kirigami",
): ExportPayload | null {
  const archive = buildCricutZip(net, baseName);
  if (!archive) return null;
  return {
    previews: buildCricutPreviews(net),
    archive,
    combined: buildCombinedCricutSvg(net, baseName),
    fkld: null,
  };
}

function previewSvg(
  net: PatternNet,
  groups: { segs: PatternSegment[]; color: string }[],
): string {
  const [x, y, w, h] = net.viewBox;
  const body = groups
    .filter((g) => g.segs.length > 0)
    .map(
      (g) =>
        `<g fill="none" stroke="${g.color}">` +
        g.segs
          .map(
            (s) =>
              `<path d="${s.d}" vector-effect="non-scaling-stroke" stroke-width="1.2" />`,
          )
          .join("") +
        `</g>`,
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}" ` +
    `preserveAspectRatio="xMidYMid meet" width="100%" height="100%">${body}</svg>`
  );
}

/** Wrap inner markup in an mm-sized SVG sharing the net's viewBox (so layers stay registered). */
function svgWrap(net: PatternNet, body: string): string {
  const [x, y, w, h] = net.viewBox;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${fmt(w)}mm" height="${fmt(h)}mm" ` +
    `viewBox="${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}">\n` +
    `${body}\n` +
    `</svg>\n`
  );
}

/**
 * Emit all segments as ONE compound stroked `<path>` (subpaths joined by their own `M`),
 * wrapped in an identified `<g>`. Cricut imports separate `<path>` elements as independent
 * objects and auto-arranges them on the mat — the shapes stay correct but their absolute
 * positions scatter, so the score lines drift away from the cut layer. Combining the lines
 * into one compound path imports as a single registered object: same trick that keeps the
 * cut layer aligned. Subpaths begin with `M` (moveto), so no spurious connecting line is
 * drawn between them; `fill="none"` keeps open subpaths from rendering as filled regions.
 */
function linesMarkup(
  segs: PatternSegment[],
  id: string,
  color: string,
  indent = "",
): string {
  const d = segs.map((s) => s.d.trim()).join(" ");
  return (
    `${indent}<g id="${id}" fill="none" stroke="${color}" ` +
    `stroke-width="${LINE_STROKE_WIDTH}">\n` +
    `${indent}  <path d="${d}" fill="none" stroke="${color}" ` +
    `stroke-width="${LINE_STROKE_WIDTH}" />\n` +
    `${indent}</g>`
  );
}

/**
 * Cut layer = one `<g id="cut">` with a single filled even-odd path containing the closed cuts
 * (`boundary` + major `cut`). `stroke="none"` keeps the silhouette and the apex hole rendering
 * cleanly — no outline halo ringing the fill edge, no double-cutting in Cricut. The boundary
 * is already V-notched at each molecule, so the relief wedges are outside the silhouette and
 * there are no separate slit paths to emit.
 */
function cutBodyMarkup(cuts: PatternSegment[], indent = ""): string {
  const closed: string[] = [];
  const open: string[] = [];
  for (const seg of cuts) {
    const d = seg.d.trim();
    if (/[zZ]\s*$/.test(d)) closed.push(d);
    else open.push(d);
  }
  const parts: string[] = [];
  if (closed.length > 0) {
    parts.push(
      `${indent}  <path fill="${CUT_COLOR}" fill-rule="evenodd" stroke="none" ` +
        `d="${closed.join(" ")}" />`,
    );
  }
  if (open.length > 0) {
    parts.push(
      `${indent}  <path fill="none" stroke="${CUT_COLOR}" ` +
        `stroke-width="${LINE_STROKE_WIDTH}" d="${open.join(" ")}" />`,
    );
  }
  return `${indent}<g id="cut">\n${parts.join("\n")}\n${indent}</g>`;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0";
}

/**
 * Score lines: the valley creases (`fold`) plus each polygon triangle's two slant edges
 * (tip→outerL, tip→outerR), which are the face↔molecule fold hinges. Polygon base edges live
 * on the boundary (cut), not on score. Every emitted score line is inset by {@link SCORE_END_GAP}
 * at both ends so it doesn't touch the cut paths and weld the cut body in Cricut.
 */
function scoreSegments(net: PatternNet): PatternSegment[] {
  const folds: PatternSegment[] = [];
  for (const s of net.segments) {
    if (!SCORE_ROLES.includes(s.role)) continue;
    const shortened = shortenLine(s.d, SCORE_END_GAP);
    if (shortened) folds.push({ ...s, d: shortened });
  }
  return [...folds, ...polygonSlantSegments(net)];
}

/** Polygon slant edges (tip↔outerL and tip↔outerR per face) as score lines, end-inset. */
function polygonSlantSegments(net: PatternNet): PatternSegment[] {
  const out: PatternSegment[] = [];
  for (const seg of net.segments) {
    if (seg.role !== "polygon") continue;
    const verts = parsePathPoints(seg.d);
    if (verts.length < 3) continue;
    const [tip, outerL, outerR] = verts;
    for (const corner of [outerL, outerR]) {
      const shortened = shortenLine(
        `M ${tip!.x} ${tip!.y} L ${corner!.x} ${corner!.y}`,
        SCORE_END_GAP,
      );
      if (shortened) out.push({ role: "fold", d: shortened });
    }
  }
  return out;
}

/**
 * Pull both endpoints of a two-point `M…L…` line inward by `gap` along its own direction.
 * Returns null when the line is shorter than 2·gap (it would collapse / flip).
 */
function shortenLine(d: string, gap: number): string | null {
  const verts = parsePathPoints(d);
  if (verts.length < 2) return null;
  const a = verts[0]!;
  const b = verts[verts.length - 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 2 * gap + 1e-6) return null;
  const ux = dx / len;
  const uy = dy / len;
  return (
    `M ${fmt(a.x + ux * gap)} ${fmt(a.y + uy * gap)} ` +
    `L ${fmt(b.x - ux * gap)} ${fmt(b.y - uy * gap)}`
  );
}

function parsePathPoints(d: string): { x: number; y: number }[] {
  const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)?.map(Number) ?? [];
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i]!, y: nums[i + 1]! });
  return out;
}

/** Cut segments: the `boundary` (V-notched silhouette) and the major apex-hole `cut`. */
function cutSegments(net: PatternNet): PatternSegment[] {
  return net.segments.filter((s) => CUT_ROLES.includes(s.role));
}

