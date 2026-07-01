import { kirigamize } from "../../../src/pipeline/kirigamize.js";
import { makeSaddleFan, makeSaddleRoof, makeEnneper } from "./fixtures/targets.js";

for (const [name, mesh] of [["fan", makeSaddleFan()], ["roof", makeSaddleRoof()], ["enneper", makeEnneper()]] as const) {
  const t0 = Date.now();
  try {
    const r = kirigamize(mesh, { verify: false });
    console.log(`${name}: OK F=${r.unfold.faces.length} vents=${r.unfold.vents.length} ms=${Date.now()-t0}`);
  } catch (e) {
    console.log(`${name}: THREW ${(e as Error).message} ms=${Date.now()-t0}`);
  }
}
