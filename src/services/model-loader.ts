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

/** Parse file text into a LoadedModel based on its extension. Throws AppError. */
export function parseLoaded(text: string, name: string): LoadedModel {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "fold" || ext === "fkld" || ext === "json") {
    try {
      return { kind: "fold", name, object: JSON.parse(text) as FoldFile };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError("parse", `Parse error in ${name}: ${message}`, err);
    }
  }
  if (ext === "obj" || ext === "stl") {
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
    return { msg: `Loaded ${kind} model "${model.name}". Ready to Kirigamize.${sim}`, kind: "ok" };
  }
  return {
    msg: `Loaded ${model.ext.toUpperCase()} mesh "${model.name}". Press Kirigamize ▶ to convert.`,
    kind: "",
  };
}
