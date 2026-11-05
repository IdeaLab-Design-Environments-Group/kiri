/**
 * Regenerates the AKDE decagon preset: the uniform-pyramid FoldNet exported as FKLD (`foldNetToFkld`)
 * plus its guided-fold goal, a `foldedForm` frame holding the isometric folded pyramid from
 * `src/sim/build.ts › pyramidGoal`, every vertex declared driven.
 *
 *   npx vite-node scripts/gen-akde-examples.ts
 *
 * akde-hex.fkld is not regenerated: its goal from this generator is isometric too, but the fold does
 * not settle to it (issue #14), so it stays a reference-only example. The square pyramid preset is a
 * separate legacy export with no goal frame and is left alone.
 */
import { writeFileSync } from "node:fs";
import { computeState } from "@kirigami/model/geometry.js";
import { foldNetToFkld } from "@kirigami/model/fkld-bridge.js";
import { buildFoldNet } from "../src/sim/foldnet.js";
import { pyramidGoal } from "../src/sim/build.js";

const PRESETS = [
  {
    file: "akde-decagon-pyramid.fkld",
    N: 10,
    title: "AKDE decagon kirigami (N=10, L=100mm, H=100mm, T=1mm, DETC edge molecules) — guided fold",
  },
];

for (const { file, N, title } of PRESETS) {
  const state = computeState({ edgeCount: N, edgeLength: 100, totalCurvature: 100, materialThickness: 1 });
  const net = buildFoldNet(state);
  const inv = 1 / net.meta.scale;
  const fkld = foldNetToFkld(net, state);
  fkld.file_frames = [
    {
      frame_classes: ["foldedForm"],
      frame_attributes: ["3D"],
      frame_inherit: true,
      frame_parent: 0,
      vertices_coords: pyramidGoal(net).map((p) => [p.x * inv, p.y * inv, p.z * inv]),
    },
  ];
  fkld["fkld:vertices_driven"] = net.vertices.map(() => 1);
  fkld.frame_title = title;
  writeFileSync(new URL(`../public/examples/${file}`, import.meta.url), JSON.stringify(fkld));
  console.log(`wrote ${file}: ${net.vertices.length} vertices, ${net.edges.length} edges`);
}
