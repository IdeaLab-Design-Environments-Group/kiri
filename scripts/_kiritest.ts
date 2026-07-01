import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseMesh } from "../src/pipeline/import.js";
import { kirigamize } from "../src/pipeline/kirigamize.js";
const root = resolve(import.meta.dirname, "..");
const name = process.argv[2] ?? "corner-saloon";
const lambda = +(process.argv[3] ?? "0");
try {
  const mesh = parseMesh(readFileSync(resolve(root, `public/examples/${name}.stl`), "utf8"), "stl");
  const fkld = kirigamize(mesh, { lambda } as never).fkld as Record<string, unknown>;
  console.log(`OK ${name} λ=${lambda}: faces=${(fkld.faces_vertices as unknown[]).length}`);
} catch (e: unknown) {
  const err = e as { stage?: string; message?: string };
  console.log(`FAIL ${name} λ=${lambda}: ${err.stage} ${err.message ?? ""}`.slice(0, 130));
}
