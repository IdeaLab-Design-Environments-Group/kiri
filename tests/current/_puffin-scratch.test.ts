/**
 * SCRATCH: build a low-poly 3D puffin body, kirigamize it (3D -> foldable flat
 * pattern), verify it folds back, and write the artifacts into the lablab vault.
 * Run: npx vitest run tests/current/_puffin-scratch.test.ts
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { kirigamize } from "../../src/pipeline/kirigamize.js";
import { buildFkldSvgExport } from "../../src/model/fkld-svg-export.js";
import { buildScene } from "../../src/sim/index.js";
import type { FoldFile } from "../../src/model/fold-file.js";
import type { TriMesh, Vec3 } from "../../src/pipeline/types.js";

/**
 * Low-poly puffin: a single closed UV-sphere-topology shell whose width/centre
 * profile from beak tip (+z) to tail tip (-z) gives a pointed beak, fat body and
 * pointed up-tilted tail. `yc` lifts the centreline (belly flatter than the back),
 * `flat` squashes width vertically. One clean genus-0 manifold for the pipeline.
 */
function genPuffin(): TriMesh {
  // Analytic egg (the proven-robust convex form): r = width(θ)·sinθ with a smooth
  // monotone width from tail->head. Convex everywhere => positive Gaussian curvature
  // => darts only, no vents/relief churn. Elongated + flattened for a bird body;
  // head pole (+z) is fatter (the puffin's big head), tail pole (−z) tapers to a point.
  const N = 7;       // latitude stacks
  const S = 8;       // longitude slices
  const L = 125;     // body length (mm; +z head, −z tail) — chunkier, rounder puffin body
  const tailW = 12;  // half-width scale near tail (tapers to a point)
  const headW = 47;  // half-width scale near head (big rounded head end)
  const flat = 0.8;  // vertical squash (slightly flattened belly/back)

  const verts: Vec3[] = [];
  const ringBase: number[] = [];
  verts.push({ x: 0, y: 0, z: L * 0.5 }); // head pole
  for (let i = 1; i <= N - 1; i++) {
    ringBase[i] = verts.length;
    const theta = (Math.PI * i) / N;
    const frac = (Math.cos(theta) + 1) / 2;           // 1 head .. 0 tail
    const width = tailW + (headW - tailW) * frac;
    const r = width * Math.sin(theta);
    for (let j = 0; j < S; j++) {
      const phi = (2 * Math.PI * j) / S;
      verts.push({ x: r * Math.cos(phi), y: r * Math.sin(phi) * flat, z: L * 0.5 * Math.cos(theta) });
    }
  }
  const tail = verts.length;
  verts.push({ x: 0, y: 0, z: -L * 0.5 }); // tail pole

  const faces: [number, number, number][] = [];
  const ring = (i: number, j: number) => ringBase[i] + (((j % S) + S) % S);
  for (let j = 0; j < S; j++) faces.push([0, ring(1, j), ring(1, j + 1)]);
  for (let i = 1; i <= N - 2; i++) {
    for (let j = 0; j < S; j++) {
      faces.push([ring(i, j), ring(i, j + 1), ring(i + 1, j + 1)]);
      faces.push([ring(i, j), ring(i + 1, j + 1), ring(i + 1, j)]);
    }
  }
  for (let j = 0; j < S; j++) faces.push([tail, ring(N - 1, j + 1), ring(N - 1, j)]);
  return { vertices: verts, faces };
}

function toObj(m: TriMesh): string {
  const v = m.vertices.map((p) => `v ${p.x.toFixed(4)} ${p.y.toFixed(4)} ${p.z.toFixed(4)}`).join("\n");
  const f = m.faces.map((t) => `f ${t[0] + 1} ${t[1] + 1} ${t[2] + 1}`).join("\n");
  return `# low-poly puffin body\n${v}\n${f}\n`;
}

describe("scratch: kirigami puffin", () => {
  // Side-effecting generator (writes OBJ/FKLD/SVG into the vault). Inert in normal
  // `npm test`; run explicitly with: PUFFIN=1 npx vitest run tests/current/_puffin-scratch.test.ts
  it.skipIf(!process.env.PUFFIN)("kirigamizes a 3D puffin body into a foldable flat pattern", () => {
    const mesh = genPuffin();
    const t0 = Date.now();
    const res = kirigamize(mesh);
    console.log("PUFFIN_GENMS " + (Date.now() - t0));
    const fkld = res.fkld as Record<string, unknown>;

    const ea = (fkld["edges_assignment"] as string[]) ?? [];
    const counts = ea.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
    const svg = buildFkldSvgExport(res.fkld, "puffin");

    const outDir = "/Users/emredayangac/Documents/lablab/outputs/puffin";
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/puffin.obj`, toObj(mesh));
    writeFileSync(`${outDir}/puffin.fkld`, JSON.stringify(res.fkld));
    if (svg) writeFileSync(`${outDir}/puffin-flat.svg`, svg.combined.svg);
    // also drop the fkld where the kirigamizer viewer/sim can load it
    writeFileSync("/Users/emredayangac/Documents/kirigamizer/public/examples/puffin.fkld", JSON.stringify(res.fkld));

    const summary = {
      mesh: { vertices: mesh.vertices.length, faces: mesh.faces.length },
      pattern: {
        vertices: (fkld["vertices_coords"] as unknown[]).length,
        faces: (fkld["faces_vertices"] as unknown[]).length,
        edges: ea.length,
        assignment: counts,
        cutLengthMm: res.sheet.vertices ? undefined : undefined,
      },
      verify: res.report ? { converged: res.report.converged } : null,
    };
    writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
    console.log("PUFFIN_SUMMARY " + JSON.stringify(summary));

    // 3D-printed folded geometry (cloth membrane = the deforming mesh; rigid tiles ride on it).
    const built = buildScene(res.fkld as FoldFile, "printed");
    if (built) {
      const { model, solver, net } = built.scene;
      solver.solve(12000, 1);
      writeFileSync(
        `${outDir}/printed-folded.json`,
        JSON.stringify({ positions: Array.from(model.position), faces: net.faces }),
      );
      console.log("PUFFIN_PRINTED nodes=" + model.numNodes + " faces=" + net.faces.length);
    }

    expect((fkld["faces_vertices"] as unknown[]).length).toBeGreaterThan(0);
  });
});
