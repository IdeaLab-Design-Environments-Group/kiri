/**
 * Application **Model**: the single source of truth for UI state — the loaded
 * model and the current status line — with observer notification.
 *
 * Pure state: no DOM, no file parsing, no rendering. The Controller mutates it
 * (`update` / `setStatus`); Views subscribe and re-render. The *simulation*
 * model lives separately under `sim/` (the domain); this store only holds the
 * app/UI state that the three panels and the action buttons read.
 */
import type { FoldFile, LoadedModel } from "./fold-file.js";
import { DEFAULT_MAX_SUBDIV, TILE_INSET_FRAC } from "./tile-subdiv.js";

/**
 * Mirrors `SimMaterial` from sim/index — inlined (structurally identical union) so the model layer
 * never imports the sim layer (architecture rule R8). Stays in lock-step with the sim definition.
 */
export type SimMaterial = "vinyl" | "printed";

export type StatusKind = "" | "ok" | "bad";

export interface Status {
  msg: string;
  kind: StatusKind;
}

export interface AppState {
  model: LoadedModel | null;
  status: Status;
  /**
   * The model currently displayed in the FKLD viewer iframe — set from the
   * viewer's `kirigamizer:viewer-loaded` events (it can load models on its
   * own via file picker / example dropdown / drag-drop). Single source of
   * truth for "what's on screen": the 3D Sim folds this, falling back to
   * `model` when the viewer is empty.
   */
  viewerShown: { object: FoldFile; name: string } | null;
  /** Which sim material the 3D Sim modal folds: "vinyl" (default) or "printed". */
  simMaterial: SimMaterial;
  /** Fold-adaptive tile detail cap, shared by the 3D-printed sim render and the STL export. */
  simDetail: number;
  /** Inter-tile gap (shrink-toward-centroid fraction), shared by the 3D-printed sim render and the STL export. */
  simTileGap: number;
}

export type StateListener = (state: Readonly<AppState>) => void;

export class AppStore {
  private state: AppState = {
    model: null,
    status: { msg: "No model loaded.", kind: "" },
    viewerShown: null,
    simMaterial: "vinyl",
    simDetail: DEFAULT_MAX_SUBDIV,
    simTileGap: TILE_INSET_FRAC,
  };
  private readonly listeners = new Set<StateListener>();

  getState(): Readonly<AppState> {
    return this.state;
  }

  get model(): LoadedModel | null {
    return this.state.model;
  }

  /** Merge a partial state and notify all subscribers exactly once. */
  update(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Convenience: change only the status line (model untouched). */
  setStatus(msg: string, kind: StatusKind = ""): void {
    this.update({ status: { msg, kind } });
  }

  /** Subscribe and receive the current state immediately; returns an unsubscribe. */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
}
