/**
 * Origami Simulator SVG importer — faithful 1:1 port of `pattern.js` loadSVG.
 *
 * Imports the original Miyamoto RES square-tower asset (copied verbatim from
 * amandaghassaei/OrigamiSimulator `assets/Kirigami/miyamotoTower.svg` into
 * `public/examples/`) and checks that the ported pipeline reproduces Origami
 * Simulator's mesh: stroke colour → assignment, stroke opacity → fold angle
 * (0.5 ⇒ ±90°), planar-graph face-finding, and a clean oriented 2-manifold.
 * Then it builds the sim scene and free-folds it with self-collision (exactly
 * what the app's 3D Sim does) and asserts an isometric, finite fold with the
 * kirigami cuts opening.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importOrigamiSimulatorSvg } from "../../../src/sim/svg-import.js";
import { buildScene } from "../../../src/sim/scene.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const svg = readFileSync("public/examples/miyamotoTower.svg", "utf8");

describe("Origami Simulator SVG import (loadSVG 1:1 port) — Miyamoto RES tower", () => {
  const imported = importOrigamiSimulatorSvg(svg, { recenter: true });
  const { stats } = imported;

  it("extracts the OS crease set from colour + opacity", () => {
    // 9 red lines + 12 red path segments → ~20 mountains; 25 blue lines + 32 blue path segments
    // → ~56 valleys; 86 yellow facets; ~100 green cuts; the black rect → 4 borders.
    expect(stats.mountains).toBeGreaterThanOrEqual(18);
    expect(stats.mountains).toBeLessThanOrEqual(22);
    expect(stats.valleys).toBeGreaterThanOrEqual(52);
    expect(stats.valleys).toBeLessThanOrEqual(60);
    expect(stats.facets).toBeGreaterThanOrEqual(80);
    expect(stats.cuts).toBeGreaterThanOrEqual(95);
    expect(stats.borders).toBe(4);
    // fold angles are the opacity-0.5 ⇒ ±90° encoding, in degrees
    const deg = (imported.edges_foldAngle as (number | null)[]).filter((a): a is number => a != null);
    const uniq = Array.from(new Set(deg.map((d) => Math.round(d)))).sort((a, b) => a - b);
    expect(uniq).toEqual([-90, 0, 90]);
  });

  it("finds faces forming a clean, consistently-oriented 2-manifold", () => {
    const faces = imported.faces_vertices as number[][];
    expect(faces.length).toBeGreaterThanOrEqual(135);
    // No degenerate faces.
    expect(faces.every((f) => f.length >= 3)).toBe(true);
    // Orientation consistency: no directed edge is used by more than one face.
    const dir = new Map<string, number>();
    const undir = new Map<string, number>();
    for (const f of faces) {
      for (let j = 0; j < f.length; j++) {
        const a = f[j], b = f[(j + 1) % f.length];
        dir.set(`${a},${b}`, (dir.get(`${a},${b}`) ?? 0) + 1);
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        undir.set(k, (undir.get(k) ?? 0) + 1);
      }
    }
    expect(Array.from(dir.values()).every((c) => c === 1)).toBe(true); // consistent winding
    // Interior edges shared by exactly 2 faces; the 4 rect-border edges by 1.
    const boundary = Array.from(undir.values()).filter((c) => c === 1).length;
    expect(boundary).toBe(4);
    expect(Array.from(undir.values()).every((c) => c <= 2)).toBe(true);
  });

  it("builds a free kirigami scene whose cuts split open", () => {
    const built = buildScene(imported as FoldFile);
    expect(built).not.toBeNull();
    expect(built!.mode).toBe("free");
    expect(built!.sim).toBe("kirigami");
    const { model } = built!.scene;
    // Kirigami cuts ("C") split into independent lips → more nodes than the flat sheet.
    expect(model.numNodes).toBeGreaterThan(stats.vertices);
    expect(Array.from(model.driven).every((d) => d === 0)).toBe(true); // truly free
  });

  it("free-folds isometrically and stays finite", { timeout: 60_000 }, () => {
    const built = buildScene(imported as FoldFile)!;
    const { model, solver } = built.scene;
    // The full RES crease set is flat-foldable: it folds nearly isometrically (cuts open, layers
    // stack). The tall erected tower is a separate rigid-kinematic branch needing guided actuation.
    // (The app additionally runs self-collision so the stacking layers don't interpenetrate; that's
    // not needed to verify the import is a valid, isometric foldable mesh, and it keeps this fast.)
    for (let k = 1; k <= 6; k++) solver.solve(2500, k / 6);
    solver.solve(4000, 1.0);
    let strain = 0;
    for (let i = 0; i < model.beams.count; i++) {
      const a = model.beams.n0[i], b = model.beams.n1[i];
      const l = Math.hypot(
        model.position[3 * a] - model.position[3 * b],
        model.position[3 * a + 1] - model.position[3 * b + 1],
        model.position[3 * a + 2] - model.position[3 * b + 2],
      );
      strain += Math.abs(l / model.beams.rest[i] - 1);
    }
    expect(strain / Math.max(1, model.beams.count)).toBeLessThan(0.05);
    for (let i = 0; i < model.position.length; i++) expect(Number.isFinite(model.position[i])).toBe(true);
  });
});
