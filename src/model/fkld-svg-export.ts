/**
 * FKLD → vinyl-cutter SVG export (à la AKDE's Cricut export, but for any FKLD/FOLD flat pattern).
 *
 * Reads the loaded flat frame — 2D `vertices_coords` (mm), `edges_vertices`, `edges_assignment`
 * (M/V/F/B/C) — and splits edges into two registered, mm-sized layers:
 *   • **cut** (black `#000000`): boundary `B` (the silhouette) + cut `C` (slits/darts);
 *   • **score** (blue `#0000ff`): mountain `M` + valley `V` fold creases.
 * `F` (flat/facet) edges are internal triangulation and are excluded.
 *
 * Both layers share one `viewBox` in mm so they import registered in Cricut Design Space (set the
 * black layer to *Cut*, the blue to *Score*). Conventions mirror `kirigami/model/svg-export.ts`:
 * 0.25 mm strokes, score lines inset 1.5 mm per end (so creases don't touch the cut and weld), and
 * non-scaling-stroke previews. The dependency-free ZIP writer is reused from the AKDE module.
 */
import { createZip } from "@kirigami/model/zip.js";
import type { FoldFile } from "./fold-file.js";
import { TAPE_W, type Trace2D, tapeQuads } from "./electronics.js";

const CUT_COLOR = "#000000";
const SCORE_COLOR = "#0000ff";
const COPPER_PWR = "#ff0000"; // PWR rail
const COPPER_GND = "#222222"; // GND rail (dark, conventional ground)
const STROKE_W = 0.25; // mm
const SCORE_END_GAP = 1.5; // mm — pull each score line in from both ends
const MARGIN = 8; // mm border around the pattern

export interface SvgFile {
  filename: string;
  svg: string;
}
export interface SvgArchive {
  filename: string;
  bytes: Uint8Array;
}
export interface SvgExportPayload {
  /** Inline thumbnails (fit-to-box, non-scaling strokes) for the modal. */
  previews: { cut: string; score: string; both: string };
  /** The two registered layer files (`…-cut.svg`, `…-score.svg`). */
  files: SvgFile[];
  /** One colour-coded file (black cut + blue score) for single-import workflows. */
  combined: SvgFile;
  /** `…-cut.svg` + `…-score.svg` zipped under a `<baseName>/` folder. */
  archive: SvgArchive;
}

type P = { x: number; y: number };

const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0");

/**
 * Build the full SVG export payload from a flat FKLD/FOLD pattern, or null if there's nothing to cut.
 * `copper` (optional) adds a third red trace layer (LED copper-tape routes) in the same mm space —
 * its points are already in the flat `vertices_coords` frame, so they register with cut/score.
 */
export function buildFkldSvgExport(
  fold: FoldFile,
  baseName = "kirigami",
  copper: Trace2D[] = [],
): SvgExportPayload | null {
  const coords = fold.vertices_coords;
  const edges = fold.edges_vertices;
  if (!Array.isArray(coords) || coords.length === 0 || !Array.isArray(edges) || edges.length === 0) {
    return null;
  }
  const assign = (fold.edges_assignment as string[] | undefined) ?? [];

  // Bounds over the flat 2D coords (use x,y; ignore any z), then map to SVG space: shift to a
  // positive origin with a margin and flip Y (FOLD is y-up, SVG is y-down) so the sheet is upright.
  // (Y-flip is a vertical flip only — it never mirrors the cut left↔right.)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pts: P[] = coords.map((c) => ({ x: Number(c[0]) || 0, y: Number(c[1]) || 0 }));
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX + 2 * MARGIN;
  const h = maxY - minY + 2 * MARGIN;
  const T = (i: number): P => ({ x: pts[i]!.x - minX + MARGIN, y: maxY - pts[i]!.y + MARGIN });
  // Same map for arbitrary flat-mm points (copper routes live in the vertex frame, not on vertices).
  const TP = (p: P): P => ({ x: p.x - minX + MARGIN, y: maxY - p.y + MARGIN });

  // Classify edges into the cut layer (boundary B = full-sheet silhouette; cut C = interior
  // slits/darts/vents) and the score layer (M,V); F is excluded. B and C are kept SEPARATE so the
  // silhouette can be filled while every performed cut is always stroked on top of it (never
  // swallowed by the fill) — so all cuts to perform on the paper stay visible.
  const boundaryEdges: [number, number][] = [];
  const cutEdges: [number, number][] = [];
  const scoreSegs: string[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e) continue;
    const a = e[0], b = e[1];
    if (a == null || b == null || a >= pts.length || b >= pts.length) continue;
    const role = assign[i] ?? "B";
    if (role === "B") {
      boundaryEdges.push([a, b]);
    } else if (role === "C") {
      cutEdges.push([a, b]);
    } else if (role === "M" || role === "V") {
      const seg = shortenedSeg(T(a), T(b), SCORE_END_GAP);
      if (seg) scoreSegs.push(seg);
    }
  }
  if (boundaryEdges.length === 0 && cutEdges.length === 0 && scoreSegs.length === 0) return null;

  const cutBody = cutMarkup(boundaryEdges, cutEdges, T);
  const scoreBody = scoreSegs.length
    ? `<path d="${scoreSegs.join(" ")}" fill="none" stroke="${SCORE_COLOR}" stroke-width="${STROKE_W}" />`
    : "";
  const copperBody = copperMarkup(copper, TP);

  const files: SvgFile[] = [];
  if (cutBody) files.push({ filename: `${baseName}-cut.svg`, svg: svgWrap(w, h, cutBody) });
  if (scoreBody) files.push({ filename: `${baseName}-score.svg`, svg: svgWrap(w, h, scoreBody) });
  if (copperBody) files.push({ filename: `${baseName}-copper.svg`, svg: svgWrap(w, h, copperBody) });

  const combined: SvgFile = {
    filename: `${baseName}-combined.svg`,
    svg: svgWrap(w, h, cutBody + scoreBody + copperBody),
  };

  const previews = {
    cut: previewWrap(w, h, cutBody),
    score: previewWrap(w, h, scoreBody),
    // "both" is the all-layers preview, so it also shows the copper routes when present.
    both: previewWrap(w, h, cutBody + scoreBody + copperBody),
  };

  const enc = new TextEncoder();
  const archive: SvgArchive = {
    filename: `${baseName}.zip`,
    bytes: createZip(files.map((f) => ({ name: `${baseName}/${f.filename}`, data: enc.encode(f.svg) }))),
  };

  return { previews, files, combined, archive };
}

/**
 * Cut layer markup. Boundary `B` edges (the full-sheet silhouette) are assembled into closed loops
 * and emitted as one filled even-odd `<path>` (a clean single silhouette cut, as AKDE does); if they
 * don't form clean loops (open / non-manifold boundary) we fall back to stroking them so nothing is
 * ever dropped. Cut `C` edges (interior slits/darts/vents) are then ALWAYS stroked on top, so every
 * performed cut stays visible and is never hidden inside the silhouette fill. Closed meshes have no
 * `B` edges — their flat-net perimeter is itself `C` lips, so the stroked cuts form the outline.
 */
function cutMarkup(
  boundaryEdges: [number, number][],
  cutEdges: [number, number][],
  T: (i: number) => P,
): string {
  const parts: string[] = [];
  if (boundaryEdges.length > 0) {
    const loops = assembleLoops(boundaryEdges);
    if (loops) {
      const d = loops
        .map((loop) => "M " + loop.map((i, k) => (k === 0 ? "" : "L ") + ptStr(T(i))).join(" ") + " Z")
        .join(" ");
      parts.push(`<path d="${d}" fill="${CUT_COLOR}" fill-rule="evenodd" stroke="none" />`);
    } else {
      const d = boundaryEdges.map(([a, b]) => `M ${ptStr(T(a))} L ${ptStr(T(b))}`).join(" ");
      parts.push(`<path d="${d}" fill="none" stroke="${CUT_COLOR}" stroke-width="${STROKE_W}" />`);
    }
  }
  if (cutEdges.length > 0) {
    const d = cutEdges.map(([a, b]) => `M ${ptStr(T(a))} L ${ptStr(T(b))}`).join(" ");
    parts.push(`<path d="${d}" fill="none" stroke="${CUT_COLOR}" stroke-width="${STROKE_W}" />`);
  }
  return parts.join("");
}

/** Walk boundary edges into closed vertex loops; null if any vertex isn't 2-regular (can't form clean loops). */
function assembleLoops(bEdges: [number, number][]): number[][] | null {
  const adj = new Map<number, number[]>();
  for (const [a, b] of bEdges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  for (const nbrs of adj.values()) if (nbrs.length !== 2) return null; // open / non-manifold → fallback
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const used = new Set<string>();
  const loops: number[][] = [];
  for (const [a0, b0] of bEdges) {
    if (used.has(key(a0, b0))) continue;
    used.add(key(a0, b0));
    const loop = [a0];
    let prev = a0, cur = b0;
    while (cur !== a0) {
      loop.push(cur);
      const nbrs = adj.get(cur)!;
      const next = nbrs[0] === prev ? nbrs[1]! : nbrs[0]!;
      if (used.has(key(cur, next))) break;
      used.add(key(cur, next));
      prev = cur;
      cur = next;
    }
    loops.push(loop);
  }
  return loops;
}

/**
 * Copper layer markup: each route becomes filled **copper-tape rectangles** (`tapeQuads`, one quad
 * per straight run, `TAPE_W` wide), grouped into one filled `<path>` per net colour (PWR = red,
 * GND = dark). Routes are flat-mm polylines already in the vertex frame; `TP` shifts them into SVG
 * space alongside the cut/score layers. PWR and GND tape may overlap where routes cross — fine, the
 * tape underside is insulated. A slight fill-opacity keeps crossings legible.
 */
function copperMarkup(copper: Trace2D[], TP: (p: P) => P): string {
  if (!copper || copper.length === 0) return "";
  const byColor = new Map<string, string[]>();
  for (const seg of copper) {
    const pts = seg.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    const color = seg.net === "gnd" ? COPPER_GND : COPPER_PWR;
    const ds = byColor.get(color) ?? byColor.set(color, []).get(color)!;
    for (const quad of tapeQuads(pts, TAPE_W)) {
      ds.push("M " + quad.map((p, k) => (k === 0 ? "" : "L ") + ptStr(TP(p))).join(" ") + " Z");
    }
  }
  let out = "";
  for (const [color, ds] of byColor) {
    if (ds.length === 0) continue;
    out += `<path d="${ds.join(" ")}" fill="${color}" fill-opacity="0.85" stroke="none" />`;
  }
  return out;
}

/** A two-point line `M…L…` pulled in by `gap` at both ends; null if it would collapse. */
function shortenedSeg(a: P, b: P, gap: number): string | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 2 * gap + 1e-6) return `M ${ptStr(a)} L ${ptStr(b)}`; // too short to inset — keep full
  const ux = dx / len, uy = dy / len;
  return `M ${fmt(a.x + ux * gap)} ${fmt(a.y + uy * gap)} L ${fmt(b.x - ux * gap)} ${fmt(b.y - uy * gap)}`;
}

const ptStr = (p: P): string => `${fmt(p.x)} ${fmt(p.y)}`;

/** mm-sized SVG sharing the given viewBox so the cut & score files import registered. */
function svgWrap(w: number, h: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" ` +
    `viewBox="0 0 ${fmt(w)} ${fmt(h)}">\n${body}\n</svg>\n`
  );
}

/** Fit-to-box preview: non-scaling strokes stay visible when shrunk into the modal thumbnail. */
function previewWrap(w: number, h: number, body: string): string {
  const withVE = body.replace(/<path /g, `<path vector-effect="non-scaling-stroke" `);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" ` +
    `preserveAspectRatio="xMidYMid meet" width="100%" height="100%">${withVE}</svg>`
  );
}
