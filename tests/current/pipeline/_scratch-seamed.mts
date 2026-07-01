import { condition } from "../../../src/pipeline/conditioning.js";
import { angleDefects } from "../../../src/pipeline/curvature.js";
import { buildTopology } from "../../../src/pipeline/mesh.js";
import { planCuts } from "../../../src/pipeline/plan-cuts.js";
import { cutAlongEdges, unfoldPatch } from "../../../src/pipeline/unfold.js";
import { makeSaddleRoof } from "./fixtures/targets.js";

const raw = makeSaddleRoof();
const { mesh } = condition(raw);
const topo = buildTopology(mesh);
const defects = angleDefects(mesh, topo);
const plan = planCuts(mesh, topo, defects, { lambda: 0, strategy: "dart" });
const ventAngles = new Map<number, number>();
for (let v = 0; v < plan.perVertexAction.length; v++) {
  if (plan.perVertexAction[v] === "slit" && defects.defects[v] < 0) ventAngles.set(v, -defects.defects[v]);
}
let t0 = Date.now();
const cut = cutAlongEdges(mesh, topo, [...plan.cutEdges], ventAngles);
console.log(`cut: F=${cut.mesh.faces.length} ms=${Date.now()-t0}`);
t0 = Date.now();
try {
  unfoldPatch(cut, cut.mesh.faces.map((_, f) => f));
  console.log(`unfold OK ms=${Date.now()-t0}`);
} catch (e) {
  console.log(`unfold THREW ${(e as Error).message} ms=${Date.now()-t0}`);
}
