import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { kirigamizeMesh } from "../src/services/pattern-service.js";
const root = resolve(import.meta.dirname, "..");
for (const name of process.argv.slice(2)) {
  try {
    const txt = readFileSync(resolve(root, `public/examples/${name}.stl`), "utf8");
    const o = kirigamizeMesh(txt, "stl", `${name}.stl`);
    console.log(`${name}: ok=${o.ok} :: ${o.summary}`);
  } catch (e: any) { console.log(`${name}: ERR ${e.stage ?? ""} ${e.message ?? e}`); }
}
