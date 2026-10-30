/**
 * Agent Benchmark Engine for Kiri (Traceform)
 *
 * Automated regression test & optimization harness for AI agents and developers.
 * Measures routing performance (ms), memory footprint, copper length,
 * strain/fatigue crossings, and design rule checks (DRC).
 *
 * Usage:
 *   npx vite-node scripts/agent-benchmark.ts               # Run standard benchmark
 *   npx vite-node scripts/agent-benchmark.ts --fast        # Quick 4-pattern loop (3-5s)
 *   npx vite-node scripts/agent-benchmark.ts --full        # Full 8-pattern corpus
 *   npx vite-node scripts/agent-benchmark.ts --save-baseline  # Save current as baseline
 *   npx vite-node scripts/agent-benchmark.ts --compare     # Compare against baseline
 *   npx vite-node scripts/agent-benchmark.ts --json        # Machine-readable JSON
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { flatFaces, gapGraph, ledOf, pointInFace, type FlatFace, type GapEdge, type Led } from "../src/model/electronics.js";
import {
  countNetCrossings,
  overlapLength,
  patternDiag,
  planRoutes,
  totalLength,
} from "../src/model/electronics-routing.js";
import { DEFAULT_SHEET, STRAIN_BAND_CAP, foldStrain, strainBand } from "../src/model/fold-strain.js";
import { TAPE_MM, tapeWidthFor } from "../src/model/tape-width.js";

const EXAMPLES_DIR = new URL("../public/examples/", import.meta.url).pathname;
const BASELINE_PATH = resolve(new URL(".", import.meta.url).pathname, "benchmark-baseline.json");

const FAST_PATTERNS = [
  "house.fkld",
  "church.fkld",
  "akde-hex.fkld",
  "akde-square-pyramid.fkld",
];

const FULL_PATTERNS = [
  "house.fkld",
  "church.fkld",
  "akde-hex.fkld",
  "akde-square-pyramid.fkld",
  "akde-decagon-pyramid.fkld",
  "puffin.fkld",
  "bat-body.fkld",
  "desk-lamp-shade.fkld",
];

export interface PatternBenchmarkResult {
  pattern: string;
  success: boolean;
  error?: string;
  timeMs: number;
  copperLength: number;
  tracesCount: number;
  pointsCount: number;
  tensionCrossings: number;
  fatiguingCrossings: number;
  worstBand: number;
  netCrossings: number;
  overlapLength: number;
}

export interface BenchmarkReport {
  timestamp: string;
  nodeVersion: string;
  gitCommit?: string;
  totalTimeMs: number;
  heapUsedMb: number;
  results: Record<string, PatternBenchmarkResult>;
  summary: {
    totalPatterns: number;
    passedPatterns: number;
    totalCopperLength: number;
    totalTensionCrossings: number;
    totalNetCrossings: number;
    avgTimeMs: number;
  };
}

function loadPattern(name: string) {
  const raw = readFileSync(`${EXAMPLES_DIR}${name}`, "utf8");
  const fold = JSON.parse(raw);
  const faces = flatFaces(fold);
  const { gaps } = gapGraph(fold, faces);
  return { fold, faces, gaps };
}

function selectLeds(gaps: GapEdge[], maxCount = 12): Led[] {
  const leds: Led[] = [];
  const seen = new Set<string>();
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const key = `${l.a}_${l.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leds.push(l);
    if (leds.length >= maxCount) break;
  }
  return leds;
}

function benchmarkPattern(
  patternName: string,
  ledCount = 12,
  sheet = DEFAULT_SHEET,
): PatternBenchmarkResult {
  const t0 = performance.now();
  try {
    const { faces, gaps } = loadPattern(patternName);
    const leds = selectLeds(gaps, ledCount);

    const tRoute0 = performance.now();
    const routed = planRoutes(
      faces,
      gaps,
      { leds, battery: { face: 0 } },
      undefined,
      sheet,
      undefined,
      STRAIN_BAND_CAP,
    );
    const timeMs = Math.round((performance.now() - tRoute0) * 100) / 100;

    const gapFor = new Map<string, GapEdge>();
    for (const g of gaps) {
      gapFor.set(`${Math.min(g.faceA, g.faceB)}_${Math.max(g.faceA, g.faceB)}`, g);
    }

    const tapeW = tapeWidthFor(faces);
    const mmPerUnit = tapeW > 0 ? TAPE_MM / tapeW : 0;
    const step = patternDiag(faces) / 1000;

    let tensionCrossings = 0;
    let fatiguingCrossings = 0;
    let worstBand = 0;

    for (const t of routed.traces) {
      let lastFace = -1;
      for (let i = 1; i < t.pts.length; i++) {
        const a = t.pts[i - 1]!;
        const b = t.pts[i]!;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.ceil(dist / step));
        for (let k = 0; k <= steps; k++) {
          const pt = {
            x: a.x + ((b.x - a.x) * k) / steps,
            y: a.y + ((b.y - a.y) * k) / steps,
          };
          const f = pointInFace(faces, pt);
          if (f < 0) continue;
          if (lastFace >= 0 && f !== lastFace) {
            const gap = gapFor.get(`${Math.min(f, lastFace)}_${Math.max(f, lastFace)}`);
            if (gap) {
              const isTension = gap.dihedral != null ? gap.dihedral > 0 : gap.assignment === "M";
              if (isTension) {
                tensionCrossings++;
                const hingeMm = Math.hypot(gap.legB.x - gap.legA.x, gap.legB.y - gap.legA.y) * mmPerUnit;
                const deg = gap.dihedral ?? 180;
                if (foldStrain(hingeMm, deg, sheet) > sheet.routingThresholdStrain) {
                  fatiguingCrossings++;
                }
                worstBand = Math.max(worstBand, strainBand(hingeMm, deg, sheet, undefined, 99));
              }
            }
          }
          lastFace = f;
        }
      }
    }

    const netCrossings = countNetCrossings(routed.traces);
    const overlapLen = +overlapLength(routed.traces, tapeW).toFixed(2);
    const copperLength = +totalLength(routed.traces).toFixed(2);
    const pointsCount = routed.traces.reduce((sum, t) => sum + t.pts.length, 0);

    return {
      pattern: patternName,
      success: true,
      timeMs,
      copperLength,
      tracesCount: routed.traces.length,
      pointsCount,
      tensionCrossings,
      fatiguingCrossings,
      worstBand,
      netCrossings,
      overlapLength: overlapLen,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      pattern: patternName,
      success: false,
      error: msg,
      timeMs: Math.round(performance.now() - t0),
      copperLength: 0,
      tracesCount: 0,
      pointsCount: 0,
      tensionCrossings: 0,
      fatiguingCrossings: 0,
      worstBand: 0,
      netCrossings: 0,
      overlapLength: 0,
    };
  }
}

export function runBenchmark(patterns: string[]): BenchmarkReport {
  const startT = performance.now();
  const results: Record<string, PatternBenchmarkResult> = {};

  let totalCopper = 0;
  let totalTension = 0;
  let totalNetCross = 0;
  let totalTime = 0;
  let passedCount = 0;

  for (const p of patterns) {
    const res = benchmarkPattern(p);
    results[p] = res;
    if (res.success) {
      passedCount++;
      totalCopper += res.copperLength;
      totalTension += res.tensionCrossings;
      totalNetCross += res.netCrossings;
      totalTime += res.timeMs;
    }
  }

  const durationMs = Math.round((performance.now() - startT) * 100) / 100;
  const heapMb = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;

  return {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    totalTimeMs: durationMs,
    heapUsedMb: heapMb,
    results,
    summary: {
      totalPatterns: patterns.length,
      passedPatterns: passedCount,
      totalCopperLength: +totalCopper.toFixed(2),
      totalTensionCrossings: totalTension,
      totalNetCrossings: totalNetCross,
      avgTimeMs: passedCount > 0 ? +(totalTime / passedCount).toFixed(2) : 0,
    },
  };
}

function formatDelta(curr: number, prev: number, invertGood = false): string {
  if (prev === 0 && curr === 0) return "  0.0%";
  if (prev === 0) return ` +${curr}`;
  const pct = ((curr - prev) / prev) * 100;
  const sign = pct > 0 ? "+" : "";
  const formatted = `${sign}${pct.toFixed(1)}%`;
  return formatted.padStart(7);
}

function printReport(current: BenchmarkReport, baseline?: BenchmarkReport | null) {
  console.log("\n" + "=".repeat(78));
  console.log(" 🚀 KIRI AGENT BENCHMARK & DRC REPORT");
  console.log("=".repeat(78));
  console.log(` Timestamp: ${current.timestamp} | Node: ${current.nodeVersion} | Heap: ${current.heapUsedMb} MB\n`);

  const header = baseline
    ? "Pattern                   |  Time (ms)  | Copper (mm) | Tens Cross | Shorts |  Status"
    : "Pattern                   | Time (ms) | Copper (mm) | Tens Cross | Fatig | Shorts | Status";
  console.log(header);
  console.log("-".repeat(header.length));

  for (const [name, res] of Object.entries(current.results)) {
    const pName = name.padEnd(25);
    if (!res.success) {
      console.log(`${pName} | FAILED: ${res.error}`);
      continue;
    }

    if (baseline && baseline.results[name]?.success) {
      const base = baseline.results[name]!;
      const timeD = formatDelta(res.timeMs, base.timeMs);
      const copD = formatDelta(res.copperLength, base.copperLength);
      const tensD = (res.tensionCrossings - base.tensionCrossings);
      const tensStr = `${res.tensionCrossings} (${tensD >= 0 ? "+" : ""}${tensD})`.padEnd(10);
      const shorts = res.netCrossings > 0 ? `⚠️ ${res.netCrossings}` : " 0 ";

      console.log(
        `${pName} | ${res.timeMs.toFixed(1).padStart(6)} (${timeD}) | ${res.copperLength.toFixed(1).padStart(7)} (${copD}) | ${tensStr} | ${shorts.padStart(6)} |  ✅ PASS`,
      );
    } else {
      console.log(
        `${pName} | ${res.timeMs.toFixed(1).padStart(9)} | ${res.copperLength.toFixed(1).padStart(11)} | ${String(res.tensionCrossings).padStart(10)} | ${String(res.fatiguingCrossings).padStart(5)} | ${String(res.netCrossings).padStart(6)} |  ✅ PASS`,
      );
    }
  }

  console.log("-".repeat(header.length));
  console.log(
    `TOTALS: ${current.summary.passedPatterns}/${current.summary.totalPatterns} patterns passed | Avg Time: ${current.summary.avgTimeMs} ms | Copper: ${current.summary.totalCopperLength} mm | Total Tension: ${current.summary.totalTensionCrossings} | Total Shorts: ${current.summary.totalNetCrossings}`,
  );
  console.log("=".repeat(78) + "\n");
}

// -------------------------------- CLI Entry --------------------------------
const args = process.argv.slice(2);
const isFast = args.includes("--fast") || (!args.includes("--full") && !args.includes("--all"));
const patterns = isFast ? FAST_PATTERNS : FULL_PATTERNS;

const report = runBenchmark(patterns);

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  let baseline: BenchmarkReport | null = null;
  if ((args.includes("--compare") || existsSync(BASELINE_PATH)) && !args.includes("--save-baseline")) {
    try {
      if (existsSync(BASELINE_PATH)) {
        baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
      }
    } catch {
      baseline = null;
    }
  }

  printReport(report, baseline);

  if (args.includes("--save-baseline")) {
    writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2));
    console.log(`💾 Baseline saved to ${BASELINE_PATH}`);
  }
}
