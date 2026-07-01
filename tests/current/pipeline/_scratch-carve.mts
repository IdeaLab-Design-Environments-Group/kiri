import { condition } from "../../../src/pipeline/conditioning.js";
import { angleDefects } from "../../../src/pipeline/curvature.js";
import { buildTopology } from "../../../src/pipeline/mesh.js";
import { planCuts } from "../../../src/pipeline/plan-cuts.js";
import { cutAlongEdges, findSelfOverlap } from "../../../src/pipeline/unfold.js";
import { makeSaddleRoof } from "./fixtures/targets.js";

const raw = makeSaddleRoof();
const { mesh } = condition(raw);
const topo = buildTopology(mesh);
const defects = angleDefects(mesh, topo);
const plan = planCuts(mesh, topo, defects, { lambda: 0, strategy: "dart" });
const ventAngles = new Map<number, number>();
for (let v = 0; v < mesh.vertices.length; v++) {
  if (plan.perVertexAction[v] === "slit" && defects.defects[v] < 0) ventAngles.set(v, -defects.defects[v]);
}
try {
  const t0 = Date.now();
  const result = cutAlongEdges(mesh, topo, plan.cutEdges, ventAngles);
  console.log(JSON.stringify({
    F: result.mesh.faces.length,
    V: result.mesh.vertices.length,
    vents: result.vents.length,
    ms: Date.now() - t0,
  }));
} catch (err) {
  console.log("THREW", (err as Error).message);
}
