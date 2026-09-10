/**
 * What the jump toll buys, swept — the measurement behind `corridor-jumps.ts › JUMP_TOLL_DIAGS`.
 *
 * For each bundled pattern that has fold adjacency, N two-terminal nets are placed straddling the N
 * most-separated lip pairs — the cases a jump exists for, where going round costs most — and routed at
 * each candidate toll. What the table shows is where the answer stops moving: the price is chosen from a
 * plateau, not fitted to one model.
 *
 *   npx vite-node scripts/_jump-sweep.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { flatFaces, gapGraph, pointInFace, type FlatFace, type Vec2 } from "../src/model/electronics.js";
import { foldAdjacency, type FoldAdjacency } from "../src/model/fold-adjacency.js";
import { planNets } from "../src/model/net-routing.js";
import { countJumpClashes, totalLength } from "../src/model/route-metrics.js";
import { tapeWidthFor } from "../src/model/tape-width.js";
import type { ResolvedNet } from "../src/model/netlist.js";

const EXAMPLES = new URL("../public/examples/", import.meta.url).pathname;
const MODELS = ["desk-lamp-shade", "house", "puffin", "church", "thermometer-tube", "akde-hex"];
const NET_COUNTS = [2, 3, 4];
/** `"off"` is the baseline: no adjacency at all, so the router has to go round. Without it the table
 *  cannot say what the hop bought, only that its price did not change the answer. */
const TOLLS: (number | "off")[] = ["off", 0.25, 0.5, 1, 2, 5, 20];

const mid = (s: [Vec2, Vec2]): Vec2 => ({ x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 });
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** `p`, one unit toward the centroid of the face that owns the lip — just inside the material. */
function inside(p: Vec2, f: FlatFace): Vec2 {
  const dx = f.centroid.x - p.x, dy = f.centroid.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return { x: p.x, y: p.y };
  return { x: p.x + dx / d, y: p.y + dy / d };
}

/**
 * The N most-separated pairs, as one two-terminal net each. Deterministic: pairs are ordered by flat
 * separation, ties by pair index, and a pair whose nudged terminals do not both land on material is
 * passed over rather than routed onto a hole.
 */
function netsStraddling(adj: FoldAdjacency, faces: FlatFace[], n: number): ResolvedNet[] {
  const ranked = adj.pairs
    .map((pair, i) => ({ pair, i, sep: dist(mid(pair.lipA), mid(pair.lipB)) }))
    .sort((a, b) => b.sep - a.sep || a.i - b.i);
  const out: ResolvedNet[] = [];
  for (const { pair } of ranked) {
    if (out.length >= n) break;
    const fa = faces[pair.faceA], fb = faces[pair.faceB];
    if (!fa || !fb) continue;
    const a = inside(mid(pair.lipA), fa), b = inside(mid(pair.lipB), fb);
    if (pointInFace(faces, a) < 0 || pointInFace(faces, b) < 0) continue;
    const k = out.length;
    out.push({
      id: `n${k}`,
      name: `N${k}`,
      points: [
        { part: 2 * k, pad: "1", at: a },
        { part: 2 * k + 1, pad: "1", at: b },
      ],
    });
  }
  return out;
}

/** The closest two DIFFERENT nets come, centreline to centreline — `net-routing.test.ts › nearestBetweenNets`. */
function nearestBetweenNets(traces: { net: string; pts: Vec2[] }[]): number {
  const ptSeg = (a: Vec2, b: Vec2, c: Vec2): number => {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / L)) : 0;
    return Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy));
  };
  const crosses = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
    const o = (p: Vec2, q: Vec2, r: Vec2): number =>
      (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return ((o(a, b, c) > 0) !== (o(a, b, d) > 0)) && ((o(c, d, a) > 0) !== (o(c, d, b) > 0));
  };
  const segSeg = (p: Vec2, q: Vec2, r: Vec2, s: Vec2): number =>
    crosses(p, q, r, s) ? 0 : Math.min(ptSeg(p, q, r), ptSeg(p, q, s), ptSeg(r, s, p), ptSeg(r, s, q));
  let min = Infinity;
  for (let i = 0; i < traces.length; i++) {
    for (let j = i + 1; j < traces.length; j++) {
      const a = traces[i]!, b = traces[j]!;
      if (a.net === b.net) continue;
      for (let p = 1; p < a.pts.length; p++) {
        for (let q = 1; q < b.pts.length; q++) {
          min = Math.min(min, segSeg(a.pts[p - 1]!, a.pts[p]!, b.pts[q - 1]!, b.pts[q]!));
        }
      }
    }
  }
  return min;
}

interface Row { model: string; nets: number; toll: number | "off"; stranded: number; jumps: number; copper: string; clashes: number; nearest: string }
const rows: Row[] = [];
const notes: string[] = [];
const t0 = Date.now();

for (const name of MODELS) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}.fkld`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const tapeW = tapeWidthFor(faces);
  const adj = foldAdjacency(fold, faces);
  if (!adj.pairs.length) {
    notes.push(`- \`${name}\`: skipped, no fold adjacency (source \`${adj.source}\`).`);
    continue;
  }
  const done = new Set<number>();
  for (const n of NET_COUNTS) {
    const nets = netsStraddling(adj, faces, n);
    if (nets.length < n) {
      notes.push(`- \`${name}\` at ${n} nets: only ${nets.length} usable pairs, routed as ${nets.length}.`);
    }
    if (!nets.length || done.has(nets.length)) continue;
    done.add(nets.length);
    for (const toll of TOLLS) {
      const r = planNets(
        nets, faces, gaps, tapeW, [], undefined, undefined, [], [], [], undefined, undefined,
        toll === "off" ? null : { ...adj, tollDiags: toll },
      );
      const stranded = r.nets.reduce((s, x) => s + x.stranded.length, 0);
      const near = nearestBetweenNets(r.traces);
      rows.push({
        model: name,
        nets: nets.length,
        toll,
        stranded,
        jumps: r.jumps.length,
        copper: totalLength(r.traces).toFixed(1),
        clashes: countJumpClashes(r.jumps, tapeW),
        nearest: Number.isFinite(near) ? near.toFixed(1) : "—",
      });
    }
  }
}

const cells = (r: Row): string[] =>
  [r.model, String(r.nets), String(r.toll), String(r.stranded), String(r.jumps), r.copper, String(r.clashes), r.nearest];
const HEAD = ["model", "nets", "toll", "stranded", "jumps", "copper", "clashes", "nearest"];
const render = (body: string[][]): string =>
  [`| ${HEAD.join(" | ")} |`, `| ${HEAD.map(() => "---").join(" | ")} |`, ...body.map((c) => `| ${c.join(" | ")} |`)].join("\n");

/**
 * The same table with every toll that agrees collapsed to one row.
 *
 * Not a convenience: it *is* the result. If a whole priced range produces one row, the constant was
 * picked from a plateau and the plateau is what belongs in the docblock, not seven copies of it.
 */
const collapsed: string[][] = [];
const seenCase = new Set<string>();
for (const r of rows) {
  const key = `${r.model}/${r.nets}`;
  if (seenCase.has(key)) continue;
  const mine = rows.filter((x) => x.model === r.model && x.nets === r.nets);
  const off = mine.find((x) => x.toll === "off")!;
  const priced = mine.filter((x) => x.toll !== "off");
  const same = priced.every((x) => x.stranded === priced[0]!.stranded && x.jumps === priced[0]!.jumps
    && x.copper === priced[0]!.copper && x.clashes === priced[0]!.clashes && x.nearest === priced[0]!.nearest);
  collapsed.push(cells(off));
  if (same) {
    const c = cells(priced[0]!);
    c[2] = `${priced[0]!.toll}–${priced[priced.length - 1]!.toll}`;
    collapsed.push(c);
  } else {
    for (const x of priced) collapsed.push(cells(x));
  }
  seenCase.add(key);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const out = [
  `# Jump toll sweep (\`scripts/_jump-sweep.ts\`, ${secs}s)`,
  "",
  "N two-terminal nets straddling the N most-separated lip pairs; `toll` is `adjacency.tollDiags` in",
  "pattern diagonals, and `off` is `adjacency = null` — the router that was here before jumps existed.",
  "`copper` and `nearest` are pattern units; `nearest` is `—` when only one net laid any copper.",
  "",
  ...(notes.length ? [...notes, ""] : []),
  "## Collapsed — one row per priced range that gives one answer",
  "",
  render(collapsed),
  "",
  "## Every cell",
  "",
  render(rows.map(cells)),
  "",
].join("\n");
console.log(out);
writeFileSync(new URL("./_jump-sweep.md", import.meta.url).pathname, out);
