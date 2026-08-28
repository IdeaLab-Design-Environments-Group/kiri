/**
 * **Model** — turning the paths a search returned into copper anyone would actually lay.
 *
 * ## Why this is its own file
 *
 * The corridor search hands back one polyline per destination, each starting at the battery. Laid as
 * they are, that is a fan of overlapping runs: the same copper taped down four times because four LEDs
 * happen to share the first stretch. {@link asTree} merges them into branches, {@link junctions} finds
 * where branches part, {@link straighten} pulls the dog-legs out of a path that a graph search had to
 * take one waypoint at a time, and {@link dodgeChips} nudges a straightened run back off any chip it
 * cut the corner over.
 *
 * All four are shape-in, shape-out. They do not decide where copper goes — that is settled by the time
 * they run — only what it looks like once it gets there.
 */
import { type Vec2, dist2 } from "./electronics.js";
import type { Trace2D } from "./trace-types.js";
import type { Target } from "./led-tour.js";
import { chordKey } from "./corridor.js";
import {
  add,
  cross,
  dedupe,
  len,
  near,
  ptKey,
  scale,
  segNearSeg,
  segPointDist,
  segsCross,
  sub,
  unit,
} from "./trace-geometry.js";

/**
 * Turn a net's walk into the tape you would actually lay for it.
 *
 * The walk is one path through every pad of the net, so wherever it has to come back the way it went it
 * retraces its own steps and the strip is laid twice over. That is electrically harmless -- one net, one
 * potential -- but it is wasted tape and it reads as a mistake. Since every segment belongs to the same net,
 * laying each *once* leaves exactly the same circuit: the walk becomes a tree.
 *
 * Duplicate segments are dropped, then what is left is broken into the longest chains that can be laid in one
 * pass, so this trades strip count for tape length and legibility.
 */
export function asTree(branches: Vec2[][], net: "pwr" | "gnd", first: Vec2, required: Vec2[]): Trace2D[] {
  const flat = branches.filter((b) => b.length >= 2);
  if (!flat.length) return branches.length ? [{ pts: branches[0]!, net }] : [];

  const nodes = new Map<string, Vec2>();
  const edges = new Map<string, { a: string; b: string; w: number }>();
  for (const pts of flat) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      const ka = ptKey(a), kb = ptKey(b);
      if (ka === kb) continue;
      nodes.set(ka, a);
      nodes.set(kb, b);
      // Keyed, so a segment walked twice is stored once.
      edges.set(chordKey(a, b), { a: ka, b: kb, w: Math.sqrt(dist2(a, b)) });
    }
  }
  if (!edges.size) return [{ pts: flat[0]!, net }];

  // Spanning tree, shortest edges first. Deduplicating segments was not enough: where the walk went out one
  // way and came back another, the union of the two contains a *cycle*, and every point on it is reached
  // twice over. One net needs exactly one path to each of its pads, so cycle-closing edges are dropped.
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(k) !== r) { const nxt = parent.get(k)!; parent.set(k, r); k = nxt; }
    return r;
  };
  for (const k of nodes.keys()) parent.set(k, k);

  const adj = new Map<string, Set<string>>();
  for (const k of nodes.keys()) adj.set(k, new Set());
  const sorted = [...edges.values()].sort((x, y) => x.w - y.w || (x.a < y.a ? -1 : 1));
  for (const e of sorted) {
    const ra = find(e.a), rb = find(e.b);
    if (ra === rb) continue; // would close a loop: that is the double connection
    parent.set(ra, rb);
    adj.get(e.a)!.add(e.b);
    adj.get(e.b)!.add(e.a);
  }

  // Prune dead ends. The tree still holds waypoints the walk merely passed through on a detour it no longer
  // needs; a branch ending anywhere that is not a pad or a terminal carries no current.
  const keep = new Set(required.map(ptKey));
  keep.add(ptKey(first));
  for (;;) {
    const dead = [...adj.keys()].filter((k) => adj.get(k)!.size === 1 && !keep.has(k));
    if (!dead.length) break;
    for (const k of dead) {
      for (const n of adj.get(k)!) adj.get(n)!.delete(k);
      adj.get(k)!.clear();
    }
  }

  // Lay it out as the longest runs that can be taped in one pass, starting at this net's own terminal.
  const out: Trace2D[] = [];
  const firstKey = ptKey(first);
  const starts = [...adj.keys()].sort((a, b) => {
    if (a === firstKey) return -1;
    if (b === firstKey) return 1;
    return (adj.get(a)!.size - adj.get(b)!.size) || (a < b ? -1 : 1);
  });
  for (const from of starts) {
    while (adj.get(from)!.size) {
      const chain: Vec2[] = [nodes.get(from)!];
      let at = from;
      for (;;) {
        const options = [...adj.get(at)!];
        if (!options.length) break;
        // At a junction, carry straight on. Taking whichever branch came first made a strip turn a corner at
        // every fork, so one continuous piece of tape read as a handful of fragments; the count of pieces is
        // fixed by the tree's leaves, but which edges each piece is made of is not.
        let to = options[0]!;
        if (options.length > 1 && chain.length >= 2) {
          const came = unit(sub(nodes.get(at)!, chain[chain.length - 2]!));
          let bestDot = -Infinity;
          for (const cand of options) {
            const d = unit(sub(nodes.get(cand)!, nodes.get(at)!));
            const dot = came.x * d.x + came.y * d.y;
            if (dot > bestDot) { bestDot = dot; to = cand; }
          }
        }
        adj.get(at)!.delete(to);
        adj.get(to)!.delete(at);
        chain.push(nodes.get(to)!);
        at = to;
      }
      if (chain.length >= 2) out.push({ pts: chain, net });
    }
  }
  return out.length ? out : [{ pts: flat[0]!, net }];
}

/**
 * The points where one run of a net hangs off another.
 *
 * A net is laid as several runs that meet at shared points, and those meeting points hold the tree together.
 * Straightening must treat them as anchors: shortcutting one run past the vertex another attaches to silently
 * cuts that run -- and everything beyond it -- off from the battery. That is an open circuit, not a cosmetic
 * problem, so it outranks any length or overlap the shortcut would buy.
 */
export function junctions(traces: Trace2D[]): Vec2[] {
  const count = new Map<string, { p: Vec2; n: number }>();
  for (const t of traces) {
    // Per run, count a point once: a run that revisits a point does not make it a junction.
    for (const key of new Set(t.pts.map(ptKey))) {
      const at = t.pts.find((p) => ptKey(p) === key)!;
      const rec = count.get(key);
      if (rec) rec.n++;
      else count.set(key, { p: at, n: 1 });
    }
  }
  return [...count.values()].filter((r) => r.n > 1).map((r) => r.p);
}

/**
 * Pull each run straight where it may be.
 *
 * The corridor is a graph, so a route is a sequence of hops between edge crossing points -- shortest *in the
 * graph*, which is not the same as shortest on the material. Two pads with clear material between them come
 * out as a dogleg via whatever crossing points lay on the way. Wherever the direct line between two points of
 * a run is legal, the vertices between them are dropped.
 *
 * A shortcut has to keep every promise the route already made, so it is taken only if it stays on the body,
 * clears every chip by a tape width, and does not cross the other net. Pads and terminals are anchors -- a
 * shortcut may never skip past one, or the tape would stop touching what it is there to connect.
 */
export function straighten(
  traces: Trace2D[],
  keep: Vec2[],
  bodies: [Vec2, Vec2][],
  onBody: (a: Vec2, b: Vec2) => boolean,
  others: Trace2D[],
  clear: number,
  apart: number,
  forbidden: Vec2,
  forbiddenClear: number,
  terminals: [Vec2, Vec2],
  near: number,
): Trace2D[] {
  const anchors = new Set(keep.map(ptKey));
  const legal = (a: Vec2, b: Vec2): boolean => {
    if (!onBody(a, b)) return false;
    // A shortcut may not sweep across the other net's battery terminal.
    if (segPointDist(a, b, forbidden) < forbiddenClear) return false;
    const L = Math.sqrt(dist2(a, b));
    const steps = Math.max(2, Math.ceil(L / (clear * 0.5)));
    for (const [c, d] of bodies) {
      // No shortcut may pass through a chip, pad exemption or not. The exemption below is about *proximity*
      // near the pad the run lands on; a run that actually crosses the body is over the part either way.
      if (segsCross(a, b, c, d)) return false;
      // Exempting a whole chip because the shortcut *ends* on one of its pads is too generous: the run can
      // then lie alongside that chip's body all the way in. Only the pad's own neighbourhood is exempt, which
      // is the same rule the under-chip measure applies.
      const own = anchors.has(ptKey(c)) ? c : anchors.has(ptKey(d)) ? d : null;
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        if (own && Math.sqrt(dist2(m, own)) <= clear * 1.2) continue;
        if (segPointDist(c, d, m) < clear) return false;
      }
    }
    // Right at the battery the two nets are unavoidably close: their pads sit about a strip and a half apart, so
    // every departure fails the separation rule below and the run is left with a hard turn the moment it leaves
    // the pad. Near the terminals only crossing is forbidden, not proximity.
    const nearBattery =
      len(sub(a, terminals[0])) < near || len(sub(a, terminals[1])) < near ||
      len(sub(b, terminals[0])) < near || len(sub(b, terminals[1])) < near;

    // Keep clear of the other net, not merely uncrossed. Directness and separation pull against each other --
    // the shortest route between the same two regions is much the same for both nets, so straightening both
    // makes them parallel. A shortcut is therefore only taken where it does not come within a tape width of
    // the other net: the run stays bent exactly where being direct would mean shadowing.
    for (const o of others) {
      for (let i = 1; i < o.pts.length; i++) {
        const gap = segNearSeg(a, b, o.pts[i - 1]!, o.pts[i]!);
        if (nearBattery ? gap <= 0 : gap < apart) return false;
      }
    }
    return true;
  };

  return traces.map((t) => {
    const pts = t.pts;
    const out: Vec2[] = [pts[0]!];
    let i = 0;
    while (i < pts.length - 1) {
      // Reach as far ahead as the direct line allows, stopping at the first anchor on the way.
      let best = i + 1;
      for (let j = i + 2; j < pts.length; j++) {
        if (anchors.has(ptKey(pts[j - 1]!))) break; // cannot skip past a pad or a terminal
        if (!legal(pts[i]!, pts[j]!)) continue;
        best = j;
      }
      out.push(pts[best]!);
      i = best;
    }
    return { pts: out, net: t.net };
  });
}

/** Binary min-heap keyed by string, for the corridor search frontier. */
export function dodgeChips(pts: Vec2[], targets: Target[], onBody: (a: Vec2, b: Vec2) => boolean): Vec2[] {
  const byHinge = new Map<string, Target>();
  for (const t of targets) byHinge.set(ptKey(t.hinge), t);
  const out = pts.slice();
  for (let i = 1; i < out.length - 1; i++) {
    const t = byHinge.get(ptKey(out[i]!));
    if (!t) continue;
    const a = out[i - 1]!, b = out[i + 1]!;
    const body: [Vec2, Vec2] = [t.legs[0], t.legs[1]];
    if (!segsCross(a, out[i]!, ...body) && !segsCross(out[i]!, b, ...body)) continue;
    // Try each end corner; take the first that clears the chip on both sides.
    for (const end of [t.ends[0], t.ends[1]].sort((x, y) => dist2(x, a) - dist2(y, a))) {
      // The corner can be a long way off, and a long jump to it can leave the material -- so the dodge only
      // counts if it clears the chip *and* stays on the body.
      if (
        !segsCross(a, end, ...body) &&
        !segsCross(end, b, ...body) &&
        onBody(a, end) &&
        onBody(end, b)
      ) {
        out[i] = end;
        break;
      }
    }
  }
  return out;
}

