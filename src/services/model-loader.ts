/**
 * **Service** — loading models into the app: text → LoadedModel parsing,
 * File reading, and sample fetching. Stateless and view-free; throws/reports
 * `AppError` so the controller can route failures uniformly:
 *   domain "parse" → clear the model + show the error
 *   domain "io"    → status only (model untouched)
 *
 * NOTE: `readModelFile` deliberately keeps the callback-style FileReader
 * mechanics (not a Promise): the loaded/error callbacks fire in the same tick
 * as the reader's own events, which the controller tests (and the UI's
 * status sequencing) rely on.
 */
import { AppError } from "../core/errors.js";
import type { FoldFile, LoadedModel } from "../model/fold-file.js";
import { isFkld } from "../model/fold-file.js";
import { canSimulate } from "../sim/index.js";
import type { Status } from "../model/app-store.js";

/** Largest file we will read into memory. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Largest mesh we will hand to the (synchronous) pipeline. */
export const MAX_MESH_VERTICES = 500_000;
export const MAX_MESH_TRIANGLES = 1_000_000;

/** Cheap upper-bound estimate of the vertex / triangle count of an STL or OBJ text. Null when unknown. */
function meshCounts(text: string, ext: "obj" | "stl"): { vertices: number; triangles: number } {
  let vertices = 0;
  let triangles = 0;
  if (ext === "stl") {
    // ASCII STL: three "vertex" lines per facet.
    for (let i = text.indexOf("vertex"); i >= 0; i = text.indexOf("vertex", i + 6)) vertices++;
    return { vertices, triangles: Math.floor(vertices / 3) };
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("v ")) vertices++;
    else if (line.startsWith("f ")) triangles += Math.max(1, line.trim().split(/\s+/).length - 3);
  }
  return { vertices, triangles };
}

/** Parse file text into a LoadedModel based on its extension. Throws AppError. */
export function parseLoaded(text: string, name: string): LoadedModel {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "fold" || ext === "fkld" || ext === "json") {
    let object: unknown;
    try {
      object = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError("parse", `Parse error in ${name}: ${message}`, err);
    }
    if (object === null || typeof object !== "object" || Array.isArray(object)) {
      throw new AppError("parse", `Parse error in ${name}: expected a FOLD/FKLD object, got ${object === null ? "null" : Array.isArray(object) ? "an array" : typeof object}.`);
    }
    return { kind: "fold", name, object: object as FoldFile };
  }
  if (ext === "obj" || ext === "stl") {
    const { vertices, triangles } = meshCounts(text, ext);
    if (vertices > MAX_MESH_VERTICES || triangles > MAX_MESH_TRIANGLES) {
      throw new AppError(
        "parse",
        `${name} is too large to process in the browser (${vertices.toLocaleString("en-US")} vertices, ` +
          `${triangles.toLocaleString("en-US")} triangles; limit ${MAX_MESH_VERTICES.toLocaleString("en-US")} / ` +
          `${MAX_MESH_TRIANGLES.toLocaleString("en-US")}). Simplify the mesh and try again.`,
      );
    }
    return { kind: "mesh", name, ext, text };
  }
  throw new AppError("io", `Unsupported file type: .${ext}`);
}

/**
 * Read a File and parse it. Callback-style by design (see module note):
 * `onLoaded` fires with the parsed model, `onError` with an AppError.
 */
export function readModelFile(
  file: File,
  onLoaded: (model: LoadedModel) => void,
  onError: (err: AppError) => void,
): void {
  const name = file.name;
  if (file.size > MAX_FILE_BYTES) {
    onError(new AppError("io", `${name} is too large (${(file.size / 1048576).toFixed(1)} MB; limit ${MAX_FILE_BYTES / 1048576} MB).`));
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      onLoaded(parseLoaded(String(reader.result), name));
    } catch (err) {
      onError(err instanceof AppError ? err : new AppError("io", String(err), err));
    }
  };
  reader.onerror = () => onError(new AppError("io", `Could not read ${name}.`));
  reader.readAsText(file);
}

/** Fetch the bundled sample as a fold model. Throws AppError("io") on failure. */
export async function fetchSample(url: string, name: string): Promise<LoadedModel> {
  const resp = await fetch(url);
  if (!resp.ok) throw new AppError("io", `HTTP ${resp.status}`);
  return { kind: "fold", name, object: JSON.parse(await resp.text()) as FoldFile };
}

/** The status line shown when a model loads (same strings as before extraction). */
export function loadedStatus(model: LoadedModel): Status {
  if (model.kind === "fold") {
    const kind = isFkld(model.object) ? "FKLD" : "FOLD";
    const sim = canSimulate(model.object) ? " 3D Sim ready." : "";
    return { msg: `Loaded ${kind} model "${model.name}". Ready to cut & fold.${sim}`, kind: "ok" };
  }
  return {
    msg: `Loaded ${model.ext.toUpperCase()} mesh "${model.name}". Press Cut & fold to convert.`,
    kind: "",
  };
}
