/**
 * BST result → FOLD/FKLD file the viewer renders and the 3D Sim deploys.
 *
 * The flat contracted tiling is the crease pattern (`frame_classes:["creasePattern"]`, 2D). The
 * deployed state is carried as `file_frames[0]` (`foldedForm`, 3D) + `fkld:vertices_driven`, exactly
 * the guided-fold contract `src/sim/origami-import.ts#applyDeclaredGoal` consumes (same as
 * src/pipeline/emit.ts). The sim morphs the driven vertices contracted→deployed.
 *
 * Edge roles: each rigid tile is a quad split into 2 triangles. Tile boundary edges are `"B"`
 * (boundary) — NOT `"C"` — so `splitCuts` never duplicates the shared pivot/hinge vertices and the
 * tiles stay connected as a linkage. The tile diagonal is `"F"` (flat/rigid). (Slit cut-lines as a
 * visual are a later refinement; correctness of the linkage comes first.)
 */
import type { FoldFile } from "../../model/fold-file.js";
import type { BstParams, BstResult } from "./types.js";

const DRIVEN_KEY = "fkld:vertices_driven";

export function emitBstFkld(result: BstResult, params: BstParams): FoldFile {
  const { contracted, expandedCurved, driven, bars } = result;
  // Flat (2D) + deployed (3D) vertex arrays; bars append E,F to both, kept parallel.
  const coords2: [number, number][] = contracted.vertices.map((p) => [p.x, p.y]);
  const coords3: [number, number, number][] = expandedCurved.map((p) => [p.x, p.y, p.z]);
  const drivenOut: number[] = driven.map((d) => (d ? 1 : 0));

  const edges: [number, number][] = [];
  const assignment: string[] = [];
  const foldAngle: (number | null)[] = [];
  const seen = new Map<string, number>();
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const addEdge = (a: number, b: number, role: string): void => {
    const k = key(a, b);
    if (seen.has(k)) return;
    seen.set(k, edges.length);
    edges.push([a, b]);
    assignment.push(role);
    foldAngle.push(role === "F" ? 0 : null); // B/C → null (per FOLD); F flat → 0
  };

  const faces: number[][] = [];
  for (const tile of contracted.tiles) {
    const [a, b, c, d] = tile;
    faces.push([a, b, c], [a, c, d]); // fan-split the rigid quad
    addEdge(a, b, "B");
    addEdge(b, c, "B");
    addEdge(c, d, "B");
    addEdge(d, a, "B");
    addEdge(a, c, "F"); // shared diagonal of the two triangles (rigid)
  }

  // Bistable bars: append E,F vertices (flat + deployed, driven) and the rigid connector/bar edges.
  for (const bar of bars) {
    const [a, b, c, d] = bar.corners;
    const e = coords2.length; coords2.push([bar.Ec.x, bar.Ec.y]); coords3.push([bar.Ee.x, bar.Ee.y, bar.Ee.z]); drivenOut.push(1);
    const f = coords2.length; coords2.push([bar.Fc.x, bar.Fc.y]); coords3.push([bar.Fe.x, bar.Fe.y, bar.Fe.z]); drivenOut.push(1);
    addEdge(a, e, "F"); addEdge(b, e, "F"); // connector ABE
    addEdge(c, f, "F"); addEdge(d, f, "F"); // connector CDF
    addEdge(e, f, "F"); // the bar
  }

  return {
    file_spec: 1.2,
    file_creator: "kirigamizer: bistable star tiling (BST)",
    file_classes: ["creasePattern"],
    frame_title: `BST star tiling (α=${((params.alpha * 180) / Math.PI).toFixed(0)}°, γ=${params.gamma}, ${params.grid.nx}×${params.grid.ny})`,
    frame_classes: ["creasePattern"],
    frame_attributes: ["2D"],
    frame_unit: "mm",
    vertices_coords: coords2,
    edges_vertices: edges,
    edges_assignment: assignment,
    edges_foldAngle: foldAngle,
    faces_vertices: faces,
    file_frames: [
      {
        frame_classes: ["foldedForm"],
        frame_attributes: ["3D"],
        frame_unit: "mm",
        frame_parent: 0,
        frame_inherit: true,
        vertices_coords: coords3,
      },
    ],
    [DRIVEN_KEY]: drivenOut,
    "fkld:meta_bars": bars.length,
    "fkld:meta_architecture": { source: "bst", scaleMeters: 0.001, alpha: params.alpha, gamma: params.gamma, beta0: params.beta0 },
  };
}
