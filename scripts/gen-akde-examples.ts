/**
 * Regenerates the AKDE hex and decagon presets: the uniform-pyramid FoldNet exported as FKLD
 * (`foldNetToFkld`) plus its guided-fold goal, a `foldedForm` frame holding the isometric folded
 * pyramid from `src/sim/build.ts › pyramidGoal`, every vertex declared driven.
 *
 *   npx vite-node scripts/gen-akde-examples.ts
 *
 * The hex is cut for a 3.5 mm sheet. Its major-cut radius is T / sin(θ/2), and at N=6 a 1 mm sheet
 * leaves an apex hole smaller than the sim's contact thickness: the tips collide before they meet and
 * the fold settles anywhere from max strain 0.02 to 2.1 depending on the rim swing (issue #67). From
 * about 2.2 mm up it settles at max 0.0005 whatever the swing. The decagon's hole is large enough at
 * 1 mm. The square pyramid preset is a separate legacy export with no goal frame and is left alone.
 */
import { writeFileSync } from "node:fs";
import { computeState } from "@kirigami/model/geometry.js";
import { foldNetToFkld } from "@kirigami/model/fkld-bridge.js";
import { buildFoldNet } from "../src/sim/foldnet.js";
import { pyramidGoal } from "../src/sim/build.js";

const PRESETS = [
  {
    file: "akde-hex.fkld",
    N: 6,
    T: 3.5,
    title: "AKDE hex kirigami (N=6, L=100mm, H=100mm, T=3.5mm, DETC edge molecules) — guided fold",
  },
  {
    file: "akde-decagon-pyramid.fkld",
    N: 10,
    T: 1,
    title: "AKDE decagon kirigami (N=10, L=100mm, H=100mm, T=1mm, DETC edge molecules) — guided fold",
  },
];

for (const { file, N, T, title } of PRESETS) {
  const state = computeState({ edgeCount: N, edgeLength: 100, totalCurvature: 100, materialThickness: T });
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
