/**
 * Pure presenter: a loaded model → the ordered rows shown in the "Derived"
 * list. No DOM — the view is a thin wrapper that renders these term/value
 * pairs. Mirrors `fkld-metadata.ts` (the FKLD-panel presenter) for the convert
 * column.
 */
import { type LoadedModel, isFkld } from "./fold-file.js";

export function deriveFacts(model: LoadedModel): [string, string][] {
  if (model.kind === "fold") {
    const obj = model.object;
    const kind = isFkld(obj) ? "FKLD" : "FOLD";
    return [
      ["File", model.name],
      ["Format", kind],
      ["Vertices", String(obj.vertices_coords?.length ?? 0)],
      ["Faces", String(obj.faces_vertices?.length ?? 0)],
      ["Edges", String(obj.edges_vertices?.length ?? 0)],
      ["Unit", obj.frame_unit ?? "—"],
    ];
  }
  return [
    ["File", model.name],
    ["Type", `${model.ext.toUpperCase()} mesh`],
    ["Lines", String(model.text.split("\n").length)],
  ];
}
