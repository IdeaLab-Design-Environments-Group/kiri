/**
 * Dump every stage of the kirigami pipeline as JSON, for figure rendering.
 *
 * Runs the same stages `kirigamize` runs, in the same order, and writes what each
 * one produced: the conditioned mesh, the angle defects, the planned cut forest,
 * the unfolded patch and the emitted sheet.  Nothing here decides anything -- it
 * re-uses the pipeline's own functions so the picture cannot drift from the code.
 *
 *     npx tsx scripts/_dump-pipeline.ts <mesh.stl> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { condition } from "../src/pipeline/conditioning.js";
import { cutHandles } from "../src/pipeline/handle-cut.js";
import { angleDefects } from "../src/pipeline/curvature.js";
import { parseMesh } from "../src/pipeline/import.js";
import { buildTopology } from "../src/pipeline/mesh.js";
import { kirigamize } from "../src/pipeline/kirigamize.js";

const [src, out] = process.argv.slice(2);
const ext = src.toLowerCase().endsWith(".obj") ? "obj" : "stl";
const input = parseMesh(readFileSync(src, "utf8"), ext);

// Stage 0-1, repeated exactly as kirigamize does it, so edge ids line up.
const conditioned = condition(input);
const handle = cutHandles(conditioned.mesh);
const mesh = handle.mesh;
const topo = buildTopology(mesh);
const defects = angleDefects(mesh, topo);

const result = kirigamize(input, {});

writeFileSync(out, JSON.stringify({
  input: { vertices: input.vertices, faces: input.faces },
  mesh: { vertices: mesh.vertices, faces: mesh.faces },
  defects: { defects: defects.defects, classes: defects.classes, total: defects.totalDefect },
  plan: {
    cutEdges: result.plan.cutEdges.map((e) => [topo.edges[e]!.a, topo.edges[e]!.b]),
    perVertexAction: result.plan.perVertexAction,
    cost: result.plan.cost,
  },
  unfold: {
    flat: result.unfold.flat,
    faces: result.unfold.faces,
    patchOfFace: result.unfold.patchOfFace,
    patchCount: result.unfold.patchCount,
    reliefEdges: result.unfold.reliefEdges.length,
    totalCutLength: result.unfold.totalCutLength,
  },
  sheet: {
    vertices: result.sheet.vertices,
    faces: result.sheet.faces,
    edges: result.sheet.edges.map((e) => [e.a, e.b]),
    assignment: result.sheet.assignment,
    foldAngle: result.sheet.foldAngle,
    cutType: result.sheet.cutType,
    sheetRect: result.sheet.sheetRect,
  },
  report: result.report,
}));
console.log("faces", mesh.faces.length, "verts", mesh.vertices.length,
            "cutEdges", result.plan.cutEdges.length,
            "patches", result.unfold.patchCount,
            "sheetFaces", result.sheet.faces.length);
