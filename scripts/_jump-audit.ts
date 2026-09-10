/**
 * What fold adjacency does to declared-net routing across the whole bundled corpus. Read-only.
 *
 *   npx vite-node scripts/_jump-audit.ts
 *
 * Every number in `docs/fold-adjacent-routing.md` and in the "Measured" paragraph of
 * `src/model/corridor-jumps.ts` comes from a run of this file. It asks one question per pattern —
 * *what changes when `planNets` is handed the pattern's `foldAdjacency` instead of `null`* — and
 * answers it as copper, stranded terminals, jumps used, and the two metrics that must not move:
 * `countNetCrossings` (planar shorts, which jumps are exempt from by D7 and which must therefore stay
 * at zero on both arms) and `countJumpClashes` (the jump-side reading of the same fault).
 *
 * **Terminals.** For `n` nets the `n` most separated lip pairs are taken — separation measured between
 * the two lip midpoints in the *flat* pattern, which is exactly the distance a jump erases — and net
 * `k` is given two terminals, the centroids of pair `k`'s two faces. Greedy, and a pair whose faces are
 * already spoken for is skipped, so no two nets are handed the same terminal. Centroids rather than
 * points hard against the lip on purpose: a terminal on the lip makes the jump trivially the answer and
 * measures nothing but the toll, whereas a centroid makes the router earn its way to the seam first.
 *
 * **Rotations.** The four multiples of 90° about the bounding-box centre are the only rotations that
 * leave `patternDiag` — a bounding-box diagonal, and the unit both `FOLD_PENALTY_FRAC` and
 * `JUMP_TOLL_DIAGS` are quoted in — unchanged, so they are the only ones under which "the same pattern"
 * is a meaningful claim. Under them the router's geometry is an exact isometry and the sweep is a test
 * of tie-breaking and of `ptKey` rounding rather than of routing: a difference between rotations is a
 * finding about determinism, not about jumps. The run reports whether any appeared.
 *
 * **Budget.** The whole corpus at four net counts and four rotations turns out to fit inside
 * {@link BUDGET_MS} with room to spare, so nothing is tiered away by default; the deadline is still
 * checked before every pattern and every rotation, and whatever it stops is named in the findings
 * rather than silently dropped. Patterns with no lip pairs are skipped outright — with nothing to
 * rejoin, both arms are the same run by construction.
 *
 * The main table carries rotation 0 only, because printing four near-identical rows per case buries
 * the thing worth reading. The other three rotations are compared against it and reported as their own
 * section: where they agree the entry is one line, and where they do not the case is named.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { flatFaces, gapGraph, type FlatFace, type Vec2 } from "../src/model/electronics.js";
import { tapeWidthFor, type Trace2D } from "../src/model/electronics-routing.js";
import { planNets } from "../src/model/net-routing.js";
import { countJumpClashes, countNetCrossings } from "../src/model/route-metrics.js";
import { foldAdjacency, type FoldAdjacency, type LipPairFlat } from "../src/model/fold-adjacency.js";
import type { Jump } from "../src/model/trace-types.js";
import type { FoldFile } from "../src/model/fold-file.js";
import type { ResolvedNet } from "../src/model/netlist.js";

const EXAMPLES = new URL("../public/examples/", import.meta.url).pathname;
const OUT = new URL("./_jump-audit.md", import.meta.url).pathname;

/** Lips further apart than this in the flat pattern are a "rim" pair — the ones a jump is worth having.
 *  Five units is the figure `fold-adjacency.ts`'s own header quotes for desk-lamp-shade's 27. */
const RIM_UNITS = 5;
/** Net counts swept. Two is the smallest that can strand anything; five is where the corpus runs out of
 *  separated pairs on the smaller patterns. */
const NET_COUNTS = [2, 3, 4, 5];
/** The rotations swept. Multiples of 90° about the bounding-box centre, which are the only ones that
 *  leave `patternDiag` — and so the toll — unchanged; see the file header. */
const ROTATIONS = [0, 1, 2, 3];
/** Wall-clock cap. Past it the remaining patterns are reported as trimmed, not run. */
const BUDGET_MS = 5 * 60_000;

const t0 = Date.now();
const lines: string[] = [];
const say = (s = ""): void => {
  console.log(s);
  lines.push(s);
};

// ---------------------------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------------------------

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Total centreline length of a set of runs — "copper", in flat pattern units. */
function copperOf(traces: Trace2D[]): number {
  let n = 0;
  for (const t of traces) {
    for (let i = 1; i < t.pts.length; i++) n += dist(t.pts[i - 1]!, t.pts[i]!);
  }
  return n;
}

/**
 * The closest two DIFFERENT nets come, centreline to centreline — `net-routing.test.ts`'s helper of the
 * same name, restated here because a test file is not importable. Crossings are distance zero and the
 * four-projection minimum cannot see them, so the crossing case is tested for separately.
 */
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

/**
 * `fold` with its flat coordinates turned `k` quarter turns about the bounding-box centre.
 *
 * Only `vertices_coords` moves. The goal frame is the *folded* form and has nothing to do with how the
 * pattern is laid out on the sheet, so rotating it too would be rotating the artifact, not the pattern —
 * and would change nothing about the adjacency, which is welded in goal space.
 *
 * Written as additions and subtractions rather than as a sine and cosine so that a quarter turn is exact
 * to the last bit: any difference the sweep then shows between rotations is the router's, not the
 * rotation's.
 */
function rotateFlat(fold: FoldFile, k: number): FoldFile {
  const coords = (fold as { vertices_coords?: number[][] }).vertices_coords;
  if (!Array.isArray(coords) || k % 4 === 0) return fold;
  const xs = coords.map((c) => Number(c?.[0] ?? 0)), ys = coords.map((c) => Number(c?.[1] ?? 0));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const turn = (p: [number, number]): [number, number] => [cx + (cy - p[1]), cy + (p[0] - cx)];
  const out = coords.map((c) => {
    let p: [number, number] = [Number(c?.[0] ?? 0), Number(c?.[1] ?? 0)];
    for (let i = 0; i < ((k % 4) + 4) % 4; i++) p = turn(p);
    return [p[0], p[1], ...(c ?? []).slice(2)];
  });
  return { ...fold, vertices_coords: out } as FoldFile;
}

// ---------------------------------------------------------------------------------------------
// terminals
// ---------------------------------------------------------------------------------------------

/** How far apart a pair's two lips lie in the flat pattern — the distance a jump erases. */
const separation = (p: LipPairFlat): number =>
  dist(mid(p.lipA[0], p.lipA[1]), mid(p.lipB[0], p.lipB[1]));

/**
 * The `n` most separated pairs, no two sharing a face, in a deterministic order.
 *
 * Ties are broken on the pair index, which `fold-adjacency.ts` makes deterministic, so the same pattern
 * always yields the same nets — the whole sweep is otherwise not comparable between arms.
 */
function pickPairs(adj: FoldAdjacency, n: number): { pair: LipPairFlat; index: number }[] {
  const ranked = adj.pairs
    .map((pair, index) => ({ pair, index, sep: separation(pair) }))
    .sort((a, b) => b.sep - a.sep || a.index - b.index);
  const used = new Set<number>();
  const out: { pair: LipPairFlat; index: number }[] = [];
  for (const r of ranked) {
    if (out.length >= n) break;
    if (used.has(r.pair.faceA) || used.has(r.pair.faceB)) continue;
    used.add(r.pair.faceA);
    used.add(r.pair.faceB);
    out.push({ pair: r.pair, index: r.index });
  }
  return out;
}

/** One net per picked pair: two terminals, the centroids of the pair's two faces. */
function netsFor(faces: FlatFace[], picks: { pair: LipPairFlat }[]): ResolvedNet[] {
  return picks.map((p, k) => ({
    id: `n${k}`,
    name: `N${k}`,
    points: [p.pair.faceA, p.pair.faceB].map((f, j) => ({
      part: k,
      pad: String(j + 1),
      at: faces[f]!.centroid,
    })),
  }));
}

// ---------------------------------------------------------------------------------------------
// one run
// ---------------------------------------------------------------------------------------------

interface Arm {
  stranded: number;
  copper: number;
  crossings: number;
  clashes: number;
  jumps: Jump[];
  nearest: number;
}

/** `planNets` once, with or without the adjacency, reduced to the numbers this audit reports. */
function run(
  nets: ResolvedNet[],
  faces: FlatFace[],
  gaps: ReturnType<typeof gapGraph>["gaps"],
  tapeW: number,
  adj: FoldAdjacency | null,
): Arm {
  // Append-only parameter order, per `net-routing.ts`: … bandCap, graded, adjacency, prejoined.
  // `undefined` takes each default rather than restating it: a script that pinned `DEFAULT_SHEET` here
  // would keep measuring the old sheet the day that default moves.
  const r = planNets(
    nets, faces, gaps, tapeW, [], undefined, undefined, [], [], [], undefined, undefined, adj, [],
  );
  const jumps = r.jumps;
  return {
    stranded: r.nets.reduce((n, x) => n + x.stranded.length, 0),
    copper: copperOf(r.traces),
    crossings: countNetCrossings(r.traces),
    clashes: countJumpClashes(jumps, tapeW),
    jumps,
    nearest: nearestBetweenNets(r.traces),
  };
}

// ---------------------------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------------------------

interface Loaded {
  name: string;
  fold: FoldFile;
  faces: FlatFace[];
  adj: FoldAdjacency;
  rim: number;
}

const FILES = readdirSync(EXAMPLES).filter((f) => f.endsWith(".fkld")).sort();
const loaded: Loaded[] = [];
const noPairs: string[] = [];

for (const name of FILES) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8")) as FoldFile;
  const faces = flatFaces(fold);
  const adj = foldAdjacency(fold, faces);
  if (!adj.pairs.length) {
    noPairs.push(`${name} (${adj.source})`);
    continue;
  }
  loaded.push({
    name,
    fold,
    faces,
    adj,
    rim: adj.pairs.filter((p) => separation(p) > RIM_UNITS).length,
  });
}

say("# Jump audit");
say();
say(`\`npx vite-node scripts/_jump-audit.ts\` — ${FILES.length} bundled patterns, ` +
  `toll \`JUMP_TOLL_DIAGS\` at its module default.`);
say();
say("## Adjacency over the corpus");
say();
say("| pattern | source | pairs | rim pairs (lips > 5 units apart) |");
say("|---|---|---:|---:|");
for (const f of loaded) say(`| ${f.name} | ${f.adj.source} | ${f.adj.pairs.length} | ${f.rim} |`);
say();
say(`Skipped, no pairs to rejoin: ${noPairs.length ? noPairs.join(", ") : "none"}.`);
say();

let crossFindings = 0, clashFindings = 0;
let totalCrossBefore = 0, totalCrossAfter = 0, totalClash = 0;
let recovered = 0, casesSwept = 0;
const trimmed: string[] = [];
const notSwept: string[] = [];
/** Per pattern, the rotations whose whole result differed from 0°, and on which net counts. */
const rotDiff: { name: string; rot: number; hard: string[]; soft: string[] }[] = [];

say("## Sweep");
say();
say("Rotation 0 only; the other three are in the next section. `stranded`, `copper` and `cross` are " +
  "given as before → after, where \"after\" is the arm handed the pattern's `foldAdjacency`. `clash` " +
  "is `countJumpClashes` on the after arm, `clear` the closest two different nets come there.");
say();
say("| pattern | nets | stranded | jumps | copper | cross | clash | clear |");
say("|---|---:|---|---:|---|---|---:|---:|");

for (const f of loaded) {
  if (Date.now() - t0 > BUDGET_MS) {
    notSwept.push(f.name);
    continue;
  }
  /** Per rotation, one record per net count, so rotations can be compared field by field. */
  const perRot = new Map<number, Map<number, { hard: string; copper: number }>>();
  for (const rot of ROTATIONS) {
    if (Date.now() - t0 > BUDGET_MS) {
      trimmed.push(`${f.name} rot ${rot * 90}°`);
      continue;
    }
    const fold = rotateFlat(f.fold, rot);
    const faces = flatFaces(fold);
    const adj = foldAdjacency(fold, faces);
    const gaps = gapGraph(fold, faces).gaps;
    const tapeW = tapeWidthFor(faces);
    const sig = new Map<number, { hard: string; copper: number }>();
    for (const n of NET_COUNTS) {
      const picks = pickPairs(adj, n);
      if (picks.length < n) continue; // not enough disjoint pairs for n nets — say nothing rather than guess
      const nets = netsFor(faces, picks);
      const before = run(nets, faces, gaps, tapeW, null);
      const after = run(nets, faces, gaps, tapeW, adj);
      casesSwept++;
      totalCrossBefore += before.crossings;
      totalCrossAfter += after.crossings;
      totalClash += after.clashes;
      if (before.crossings || after.crossings) crossFindings++;
      if (after.clashes) clashFindings++;
      if (after.stranded < before.stranded) recovered += before.stranded - after.stranded;
      // Split deliberately. `hard` is what a user would notice — which terminals were reached and how
      // many wires they must solder — and a difference there is a different plan. Copper is kept as a
      // raw number so a rotation that lays the same plan a hair longer is reported as that, and not as a
      // routing difference: rounding the two together would make every float wobble look like a reroute.
      sig.set(n, {
        hard: `${before.stranded}/${after.stranded}/${after.jumps.length}`,
        copper: after.copper,
      });
      if (rot !== 0) continue;
      say(`| ${f.name} | ${n} | ${before.stranded} → ${after.stranded} | ` +
        `${after.jumps.length} | ${before.copper.toFixed(1)} → ${after.copper.toFixed(1)} | ` +
        `${before.crossings} → ${after.crossings} | ${after.clashes} | ` +
        `${Number.isFinite(after.nearest) ? after.nearest.toFixed(3) : "n/a"} |`);
    }
    perRot.set(rot, sig);
  }
  const base = perRot.get(0);
  for (const rot of [1, 2, 3]) {
    const s = perRot.get(rot);
    if (!base || !s) continue;
    const hard: string[] = [], soft: string[] = [];
    for (const n of NET_COUNTS) {
      const a = base.get(n), b = s.get(n);
      if (!a || !b) continue;
      if (a.hard !== b.hard) hard.push(String(n));
      // A tenth of a unit is a fifteenth of a tape width on the finest pattern here: below it the two
      // rotations laid the same run and differ only in accumulated rounding.
      else if (Math.abs(a.copper - b.copper) > 0.1) {
        soft.push(`${n} (${(b.copper - a.copper).toFixed(2)})`);
      }
    }
    if (hard.length || soft.length) rotDiff.push({ name: f.name, rot, hard, soft });
  }
}
say();

say("## Rotation");
say();
say("Each pattern rotated 90°, 180° and 270° about its bounding-box centre and swept again. The " +
  "rotation is exact to the last bit and `patternDiag` is invariant under it, so the router is being " +
  "handed the same problem: any difference below is the search's own tie-breaking, not the geometry's.");
say();
if (!rotDiff.length) {
  say("No difference anywhere: every rotation of every pattern reproduced rotation 0 exactly, on " +
    "stranded count, jump count and copper length alike.");
} else {
  say("`plan` is a net count whose stranded count or jump count changed — a different plan. `copper` " +
    "is one that laid the same plan to a different length, with the difference in pattern units.");
  say();
  say("| pattern | rotation | plan | copper |");
  say("|---|---:|---|---|");
  for (const d of rotDiff) {
    say(`| ${d.name} | ${d.rot * 90}° | ${d.hard.join(", ") || "—"} | ${d.soft.join(", ") || "—"} |`);
  }
}
say();

// ---------------------------------------------------------------------------------------------
// why terminals strand — one net at a time, no adjacency
// ---------------------------------------------------------------------------------------------

/**
 * The plan expected adjacency to recover no stranded terminal, because P2-A found every bundled sheet is
 * one connected patch: if the material joins two faces at all, the router could already reach between
 * them the long way round, and a jump only shortens what it was already doing. The sweep recovers a great
 * many, so one of the two has to give — and this section says which.
 *
 * Each net is routed **alone**, with no adjacency and nothing else on the sheet. A terminal stranded here
 * is one the corridor genuinely could not reach: no path, or none that clears the weed floor. A terminal
 * stranded in the n-net arm but reached alone was lost to the *other nets* — congestion, not topology —
 * and a jump recovers it by taking that net off the long way round and out of everyone else's way.
 */
say("## Why terminals strand");
say();
say("Each net routed alone, no adjacency, nothing else on the sheet — against the same nets routed " +
  "together. A terminal stranded alone is one the corridor could not reach at all; one stranded only in " +
  "company was lost to the other nets.");
say();
say("| pattern | nets | stranded alone | stranded together | stranded with adjacency |");
say("|---|---:|---:|---:|---:|");
let soloStranded = 0, togetherStranded = 0;
for (const f of loaded) {
  if (Date.now() - t0 > BUDGET_MS) break;
  const gaps = gapGraph(f.fold, f.faces).gaps;
  const tapeW = tapeWidthFor(f.faces);
  const n = [...NET_COUNTS].reverse().find((k) => pickPairs(f.adj, k).length >= k);
  if (n === undefined) continue;
  const nets = netsFor(f.faces, pickPairs(f.adj, n));
  const alone = nets.reduce((acc, net) => acc + run([net], f.faces, gaps, tapeW, null).stranded, 0);
  const together = run(nets, f.faces, gaps, tapeW, null).stranded;
  const withAdj = run(nets, f.faces, gaps, tapeW, f.adj).stranded;
  soloStranded += alone;
  togetherStranded += together;
  say(`| ${f.name} | ${n} | ${alone} | ${together} | ${withAdj} |`);
}
say();
say(`Totals: ${soloStranded} stranded alone, ${togetherStranded} stranded together.`);
say();

// ---------------------------------------------------------------------------------------------
// desk-lamp-shade — the rim
// ---------------------------------------------------------------------------------------------

say("## desk-lamp-shade — the rim");
say();
const shade = loaded.find((f) => f.name === "desk-lamp-shade.fkld");
if (!shade) {
  say("Not in the corpus, or it carries no pairs.");
} else {
  const gaps = gapGraph(shade.fold, shade.faces).gaps;
  const tapeW = tapeWidthFor(shade.faces);
  const picks = pickPairs(shade.adj, 1);
  const nets = netsFor(shade.faces, picks);
  const before = run(nets, shade.faces, gaps, tapeW, null);
  const after = run(nets, shade.faces, gaps, tapeW, shade.adj);
  const p = picks[0]!;
  say(`One net, two terminals: the centroids of faces ${p.pair.faceA} and ${p.pair.faceB}, the two ` +
    `sides of pair ${p.index} — the most separated the pattern has, its lips ` +
    `${separation(p.pair).toFixed(1)} units apart in the flat sheet and one edge in the folded shade.`);
  say();
  say("| arm | copper | jumps | stranded |");
  say("|---|---:|---:|---:|");
  say(`| without adjacency | ${before.copper.toFixed(1)} | ${before.jumps.length} | ${before.stranded} |`);
  say(`| with adjacency | ${after.copper.toFixed(1)} | ${after.jumps.length} | ${after.stranded} |`);
  say();
  const drop = before.copper > 0 ? (1 - after.copper / before.copper) * 100 : 0;
  say(`Copper falls by ${drop.toFixed(1)}%. Tape width ${tapeW.toFixed(3)} units.`);
}
say();

// ---------------------------------------------------------------------------------------------
// house — which of the nine seams got a rejoin
// ---------------------------------------------------------------------------------------------

say("## house — which seams got a rejoin");
say();
const house = loaded.find((f) => f.name === "house.fkld");
if (!house) {
  say("Not in the corpus, or it carries no pairs.");
} else {
  const gaps = gapGraph(house.fold, house.faces).gaps;
  const tapeW = tapeWidthFor(house.faces);
  const used = new Map<number, number[]>();
  for (const n of NET_COUNTS) {
    const picks = pickPairs(house.adj, n);
    if (picks.length < n) continue;
    const after = run(netsFor(house.faces, picks), house.faces, gaps, tapeW, house.adj);
    for (const j of after.jumps) {
      const at = used.get(j.pair) ?? [];
      if (!at.includes(n)) at.push(n);
      used.set(j.pair, at);
    }
  }
  say(`${house.adj.pairs.length} pairs, ${house.rim} of them with lips more than ${RIM_UNITS} units ` +
    `apart. Rejoined at least once over nets ${NET_COUNTS.join(", ")}:`);
  say();
  say("| pair | faces | lip separation | rejoined at net counts |");
  say("|---:|---|---:|---|");
  house.adj.pairs.forEach((p, i) => {
    const at = used.get(i);
    say(`| ${i} | ${p.faceA}–${p.faceB} | ${separation(p).toFixed(1)} | ` +
      `${at ? at.join(", ") : "—"} |`);
  });
}
say();

// ---------------------------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------------------------

const secs = ((Date.now() - t0) / 1000).toFixed(1);
say("## Findings");
say();
say(`- \`countNetCrossings\`: ${totalCrossBefore} without adjacency, ${totalCrossAfter} with, over ` +
  `${casesSwept} cases swept${crossFindings ? ` — **${crossFindings} case(s) non-zero**` : " (zero throughout)"}.`);
say(`- \`countJumpClashes\`: ${totalClash} over every case swept` +
  `${clashFindings ? ` — **${clashFindings} case(s) non-zero**` : " (zero throughout)"}.`);
say(`- Stranded terminals recovered by adjacency: ${recovered} over ${casesSwept} cases. Of the ` +
  `${togetherStranded} stranded without adjacency in the largest-net case of each pattern, ` +
  `${soloStranded} were also stranded with the sheet to themselves — see "Why terminals strand".`);
const rotPlan = rotDiff.filter((d) => d.hard.length).length;
say(`- Rotation: ${rotDiff.length ? `**${rotDiff.length} (pattern, rotation) pair(s) differed from 0°**, ` +
  `${rotPlan} of them in the plan itself rather than only in copper length` :
  "every rotation of every pattern reproduced rotation 0 exactly"}.`);
say(`- Trimmed: ${trimmed.length ? trimmed.join(", ") : "no rotation"}` +
  `${notSwept.length ? `; not swept at all: ${notSwept.join(", ")}` : ""}.`);
say(`- Runtime ${secs}s.`);
say();

writeFileSync(OUT, lines.join("\n") + "\n");
console.log(`\nwritten to ${OUT}`);
