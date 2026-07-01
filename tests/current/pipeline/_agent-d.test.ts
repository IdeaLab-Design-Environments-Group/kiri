/** Agent-D scratch diagnostics — DELETE BEFORE FINISHING. */
import { describe, it } from "vitest";
import { condition } from "../../../src/pipeline/conditioning.js";
import { angleDefects } from "../../../src/pipeline/curvature.js";
import { buildTopology, edgeKey } from "../../../src/pipeline/mesh.js";
import { planCuts } from "../../../src/pipeline/plan-cuts.js";
import { cutAlongEdges } from "../../../src/pipeline/unfold.js";
import type { TriMesh } from "../../../src/pipeline/types.js";
import { makeSaddleRoof, makeEnneper } from "./fixtures/targets.js";

/** Tiny face-connectivity labeling over shared undirected edge keys. */
function labelComponents(mesh: TriMesh): { count: number; label: number[] } {
  const edgeFaces = new Map<string, number[]>();
  for (let f = 0; f < mesh.faces.length; f++) {
    const [i, j, k] = mesh.faces[f];
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const key = edgeKey(a, b);
      (edgeFaces.get(key) ?? edgeFaces.set(key, []).get(key)!).push(f);
    }
  }
  const label = new Array<number>(mesh.faces.length).fill(-1);
  let count = 0;
  for (let seed = 0; seed < mesh.faces.length; seed++) {
    if (label[seed] !== -1) continue;
    const stack = [seed];
    label[seed] = count;
    while (stack.length) {
      const f = stack.pop()!;
      const [i, j, k] = mesh.faces[f];
      for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
        for (const g of edgeFaces.get(edgeKey(a, b))!) {
          if (label[g] === -1) { label[g] = count; stack.push(g); }
        }
      }
    }
    count++;
  }
  return { count, label };
}

function battery(name: string, raw: TriMesh) {
  const { mesh } = condition(raw);
  const topo = buildTopology(mesh);
  const defects = angleDefects(mesh, topo);
  const plan = planCuts(mesh, topo, defects, { lambda: 0, strategy: "dart" });

  console.log(`\n=== ${name} ===`);
  console.log(`V=${mesh.vertices.length} F=${mesh.faces.length} E=${topo.edges.length}`);

  const bare = cutAlongEdges(mesh, topo, plan.cutEdges);
  const comps = labelComponents(bare.mesh);
  console.log(`bare cut: V=${bare.mesh.vertices.length} F=${bare.mesh.faces.length} components=${comps.count}`);

  if (comps.count === 1) {
    try {
      const vented = cutAlongEdges(mesh, topo, plan.cutEdges, new Map([[6, 0.135]]));
      const vc = labelComponents(vented.mesh);
      console.log(`vented(6, 0.135): F=${vented.mesh.faces.length} components=${vc.count}`);
    } catch (err) {
      console.log(`vented(6, 0.135) THREW: ${(err as Error).message}`);
    }
    const ventAngles = new Map<number, number>();
    for (let v = 0; v < mesh.vertices.length; v++) {
      if (plan.perVertexAction[v] === "slit" && defects.defects[v] < 0) ventAngles.set(v, -defects.defects[v]);
    }
    console.log(`full vent map: ${[...ventAngles.entries()].map(([v, a]) => `${v}:${a.toFixed(3)}`).join(" ")}`);
    const t0 = Date.now();
    try {
      const vented = cutAlongEdges(mesh, topo, plan.cutEdges, ventAngles);
      const vc = labelComponents(vented.mesh);
      console.log(`vented(ALL): F=${vented.mesh.faces.length} components=${vc.count} ms=${Date.now() - t0}`);
    } catch (err) {
      console.log(`vented(ALL) THREW: ${(err as Error).message}`);
    }
  }
}

describe("agent-d diagnostics", () => {
  it("saddle roof", () => battery("saddleRoof", makeSaddleRoof()));
  it("enneper", () => battery("enneper", makeEnneper()));
});
