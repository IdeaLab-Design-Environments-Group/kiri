/**
 * **Model** — drawing a placed part the way a PCB layout tool draws it.
 *
 * A component is not a black box with two grey stubs. It is a set of pads, each one a copper shape the
 * datasheet fixes, with a solder-mask opening over it and the terminal's own name written on it. That is
 * what a layout tool shows you, and it is what you need to see to answer the only questions worth asking
 * of the drawing: where the copper is, how big it is, and which pin is which.
 *
 * This file paints; it never places. Every position it draws at comes from a {@link ResistorShape} the
 * router and {@link partShape} already decided on. In particular a pad's true outline is *mapped onto*
 * the rectangle the lead already describes rather than re-derived from the footprint's `pos` — the
 * rectangle is already correctly rotated and flipped by decisions made elsewhere, and re-deriving it
 * would silently move parts while looking like a paint change.
 *
 * Units are sheet millimetres throughout, as in the cut files and the editor canvas.
 */
import { padNamed, padPoints, type Footprint, type Vec2 } from "./footprint.js";
import type { ResistorShape } from "./copper-svg-export.js";

/**
 * The layer colours a PCB tool paints with — the whole palette, in one place.
 *
 * Nothing else in this codebase may write a part colour as a hex literal. The tape's own net colours and
 * every cut and score colour are deliberately NOT here: those encode what the blade does, and repainting
 * them would change what the cut files mean.
 */
export const PCB_COLOURS = {
  /** The pad's copper. */
  copper: "#be7a27",
  /** The solder-mask opening on top of it — the gold you actually see. */
  mask: "#ffa50a",
  /** The terminal's own name, written on the pad. */
  padLabel: "#ffff99",
  /** The designator, beside the part. */
  componentLabel: "#00e5e5",
  /** A dot at the part's origin. */
  origin: "#8b1a1a",
} as const;

/** How much of a pad's short side is left showing as bare copper around the mask opening. */
const RIM = 0.16;

/**
 * How thickly the mask outlines the pad's true boundary, as a fraction of the pad's short side.
 *
 * The copper edge alone is not enough to find a pad by. On the white strips file it reads, but the
 * carrier file is drawn on a field of copper the same colour, and there the edge simply vanishes and only
 * the gold centre is left. Outlining the boundary in mask puts a gold line round every pad, which reads
 * against both grounds, and it leaves the copper showing as a groove between the outline and the opening
 * rather than as the pad's outer edge — one shape either way, and no new colour.
 */
const MASK_LINE = 0.1;

/** How big a designator is, in sheet millimetres. One size for every part in a drawing. */
const DESIGNATOR_MM = 1.5;

/**
 * The smallest text worth emitting, in millimetres as rendered.
 *
 * Below this a label is a grey smudge that hides the pad it is meant to name, so it is dropped instead.
 * Silkscreen text on a real board bottoms out around here for the same reason.
 */
const MIN_TEXT_MM = 0.62;

/** Roughly how wide one character is, as a fraction of the font size, in a sans face. */
const CHAR_W = 0.62;

/** Trim the float noise that a rotation leaves behind — the same rounding the SVG exports use. */
function fmt(n: number): string {
  return Number(n.toFixed(4)).toString();
}

/** Text goes into an SVG document, so it is escaped, whatever the footprint chose to call a pad. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Designators for a list of placed parts: `R1`, `R2`, `C1`, `SW1` — per family, in placement order.
 *
 * The family is the component id up to its first underscore, which is what the library already names the
 * part by: `R_1206` is an R, `SW_SPDT` an SW, `BAT_COIN_20` a BAT. One rule and no lookup table, so a
 * part added to the library gets a sensible designator without this file having to hear about it.
 */
export function designators(parts: { component: string }[]): string[] {
  const seen = new Map<string, number>();
  return parts.map((p) => {
    const family = familyOf(p.component);
    const n = (seen.get(family) ?? 0) + 1;
    seen.set(family, n);
    return `${family}${n}`;
  });
}

function familyOf(component: string): string {
  const head = (component ?? "").split("_")[0]!.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return head || "U";
}

interface Lead {
  a: Vec2;
  b: Vec2;
  width: number;
  name?: string;
  /** That this pad's footprint x runs across the rail and its y along it — see {@link padRing}. */
  swap?: boolean;
}

/** A lead's rectangle read back as a frame: where its centre is and which way its two axes point. */
interface Frame {
  c: Vec2;
  /** Along the segment `a`→`b`, and how long it is. */
  d: Vec2;
  len: number;
  /** Across it, and how wide. */
  p: Vec2;
  wid: number;
}

function frameOf(l: Lead): Frame | null {
  const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9) || !(l.width > 0)) return null;
  const d = { x: dx / len, y: dy / len };
  return { c: { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }, d, len, p: { x: -d.y, y: d.x }, wid: l.width };
}

function at(f: Frame, along: number, across: number): Vec2 {
  return { x: f.c.x + f.d.x * along + f.p.x * across, y: f.c.y + f.d.y * along + f.p.y * across };
}

/** The lead's own rectangle, as a ring — what a pad falls back to when its outline cannot be had. */
function rectRing(f: Frame, rim: number): Vec2[] {
  const hl = f.len / 2 - rim, hw = f.wid / 2 - rim;
  return [at(f, -hl, -hw), at(f, hl, -hw), at(f, hl, hw), at(f, -hl, hw)];
}

/**
 * The pad's TRUE outline, put where the lead already says the pad is.
 *
 * The lead's segment runs across the rail and its `width` along it, which is how both forms of
 * {@link partShape} build a contact: the segment carries the pad's own y extent and the width its x
 * extent. So the outline's bounding box maps onto that rectangle — y onto the segment, x onto the width —
 * and the pad lands exactly where the plain rectangle did, at exactly the same size, but with its rounded
 * corners, its circle, or its custom polygon showing.
 *
 * The rectangle says nothing about which way round the pad's x axis went, so a pad asymmetric about its
 * own origin could come out mirrored. Every pad in the library is symmetric, and a mirror keeps the
 * pad where it is, which is the property that matters.
 */
function padRing(fp: Footprint, l: Lead, f: Frame, rim: number): Vec2[] {
  if (!l.name) return rectRing(f, rim);
  let pts: Vec2[];
  try {
    pts = padPoints(padNamed(fp, l.name));
  } catch {
    return rectRing(f, rim);
  }
  if (pts.length < 3) return rectRing(f, rim);
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const bw = maxX - minX, bh = maxY - minY;
  if (!(bw > 1e-9) || !(bh > 1e-9)) return rectRing(f, rim);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // Which of the outline's own extents runs across the rail. A part whose terminals go down y has its
  // pads a quarter turn from one whose terminals go along x, and the lead rectangle cannot say so —
  // `swap` is the shape's word for it, and mapping without it turned every pin header's pads sideways.
  const [along, across] = l.swap ? [bh, bw] : [bw, bh];
  const kl = (f.len - 2 * rim) / across, kw = (f.wid - 2 * rim) / along;
  // The segment carries the outline's across-the-rail extent and the width its along-the-rail one, so
  // `swap` picks the coordinate as well as the scale — taking one without the other would map the
  // outline onto the far side's dimensions and stretch every pad instead of turning it.
  return l.swap
    ? pts.map((q) => at(f, (q.x - cx) * kl, (q.y - cy) * kw))
    : pts.map((q) => at(f, (q.y - cy) * kl, (q.x - cx) * kw));
}

function ringPath(ring: Vec2[]): string {
  return "M " + ring.map((p, i) => (i === 0 ? "" : "L ") + `${fmt(p.x)} ${fmt(p.y)}`).join(" ") + " Z";
}

/**
 * A label, upright, or `null` if it would be too small to read at this zoom.
 *
 * Always upright: a pad on a diagonal break would otherwise carry its name sideways, and the pad at the
 * other end of the same break would carry it upside down. Every label in a PCB drawing is horizontal for
 * exactly that reason, and it costs nothing — the pad itself still turns with the run.
 *
 * `scale` is how many rendered units a sheet millimetre becomes, so the same drawing suppresses at editor
 * zoom what it would happily print. It changes what is emitted, never where.
 */
function label(text: string, c: Vec2, size: number, colour: string, scale: number): string | null {
  if (!text || !(size > 0) || !(size * scale >= MIN_TEXT_MM)) return null;
  return (
    `<text x="${fmt(c.x)}" y="${fmt(c.y)}" fill="${colour}" font-family="sans-serif" ` +
    `font-size="${fmt(size)}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>`
  );
}

/** The upright box a ring occupies — the room an upright label has to fit into. */
function extent(ring: Vec2[]): { c: Vec2; w: number; h: number } {
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { c: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, w: x1 - x0, h: y1 - y0 };
}

/**
 * One placed part as SVG elements, in paint order: pads, holes, pad names, then designator and origin.
 *
 * `opts.labels === false` drops the pad names — for a caller that wants the copper without the writing.
 * `opts.scale` is the rendered units per sheet millimetre the result will be shown at; it changes only
 * whether text is legible enough to emit, never any position.
 */
export function partSvg(
  fp: Footprint,
  shape: ResistorShape,
  designator: string,
  opts?: { labels?: boolean; scale?: number },
): string[] {
  const scale = opts?.scale ?? 1;
  const labels = opts?.labels !== false;
  const out: string[] = [];
  const rings: { copper: Vec2[]; mask: Vec2[]; f: Frame; name?: string }[] = [];

  for (const l of shape.leads as Lead[]) {
    const f = frameOf(l);
    if (!f) continue;
    // The mask opening is the same outline held back by an even rim all the way round, so what shows of
    // the copper beneath reads as an edge on the pad rather than as a second, differently shaped pad.
    const rim = RIM * Math.min(f.len, f.wid);
    rings.push({
      copper: padRing(fp, l, f, 0), mask: padRing(fp, l, f, rim), f,
      ...(l.name ? { name: l.name } : {}),
    });
  }

  // 1. The copper, with the mask opening over it: a gold pad with a copper edge showing round it.
  for (const { copper, f } of rings) {
    out.push(
      `<path d="${ringPath(copper)}" fill="${PCB_COLOURS.copper}" stroke="${PCB_COLOURS.mask}" ` +
        `stroke-width="${fmt(MASK_LINE * Math.min(f.len, f.wid))}" stroke-linejoin="round" />`,
    );
  }
  for (const { mask } of rings) {
    out.push(`<path d="${ringPath(mask)}" fill="${PCB_COLOURS.mask}" />`);
  }

  // 2. The mounting holes, as rings — an annulus of copper with mask over it, open in the middle so the
  //    sheet shows through. We draw them; we never cut them.
  for (const h of shape.holes ?? []) {
    const r = h.r * 1.25;
    const w = h.r * 0.55;
    out.push(
      `<circle cx="${fmt(h.c.x)}" cy="${fmt(h.c.y)}" r="${fmt(r)}" fill="none" ` +
        `stroke="${PCB_COLOURS.copper}" stroke-width="${fmt(w)}" />`,
      `<circle cx="${fmt(h.c.x)}" cy="${fmt(h.c.y)}" r="${fmt(r)}" fill="none" ` +
        `stroke="${PCB_COLOURS.mask}" stroke-width="${fmt(w * 0.55)}" />`,
    );
  }

  // 3. Each pad's own name, on the pad — sized to the room the pad leaves an upright label.
  if (labels) {
    for (const { mask, name } of rings) {
      const box = extent(mask);
      if (!name) continue;
      const fit = (box.w * 0.86) / Math.max(1, name.length * CHAR_W);
      const t = label(name, box.c, Math.min(box.h * 0.7, fit), PCB_COLOURS.padLabel, scale);
      if (t) out.push(t);
    }
  }

  // 4. The designator beside the part, and a dot at the part's origin.
  //
  // One size for every part in a drawing: a designator names the part, not the pad it happens to sit
  // next to, and sized off the pads an SPDT's came out twice a chip resistor's on the same sheet.
  const b = shape.body;
  const rad = (b.angle * Math.PI) / 180;
  const axes: Vec2[] = [
    { x: Math.cos(rad), y: Math.sin(rad) },
    { x: -Math.cos(rad), y: -Math.sin(rad) },
    { x: -Math.sin(rad), y: Math.cos(rad) },
    { x: Math.sin(rad), y: -Math.cos(rad) },
  ];
  // "Beside" is the part's narrow way out: of the body's four directions, the one its pads reach least
  // far along. On a part in line with the rail that is across the rail; on one the rail steps across it
  // is along the row of throws — either way, the way out with no copper under it. Taking a fixed
  // direction instead put the switch's designator straight up the run it is soldered to.
  const reachOf = (u: Vec2) => {
    let r = 0;
    for (const { copper } of rings) {
      for (const q of copper) r = Math.max(r, (q.x - b.cx) * u.x + (q.y - b.cy) * u.y);
    }
    return r;
  };
  const beside = axes.map((u) => ({ u, r: Math.max(reachOf(u), Math.min(b.w, b.h) / 2) }))
    .reduce((best, a) => (a.r < best.r ? a : best));
  const off = beside.r + DESIGNATOR_MM * 0.9;
  const c = { x: b.cx + beside.u.x * off, y: b.cy + beside.u.y * off };
  const t = label(designator, c, DESIGNATOR_MM, PCB_COLOURS.componentLabel, scale);
  if (t) out.push(t);
  out.push(
    `<circle cx="${fmt(b.cx)}" cy="${fmt(b.cy)}" r="${fmt(Math.max(0.12, Math.min(b.w, b.h) * 0.08))}" ` +
      `fill="${PCB_COLOURS.origin}" />`,
  );
  return out;
}
