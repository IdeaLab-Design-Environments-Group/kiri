/**
 * **View** — the boundary between the app and the 3D subsystem.
 *
 * Everything three.js is behind this interface. `sim-modal` holds a `SimView`, never a `SimCanvas`, and reaches
 * the real thing only through one `import()` at the moment the user opens the modal — so three.js and the
 * solver are code-split into their own chunk and the rest of the app neither loads them nor breaks when they
 * fail to load. This file deliberately imports no three.js and pulls in nothing that does.
 *
 * It is an interface rather than a convention because a convention had already drifted: the modal grew
 * `setTileGap`, `setOverlay` and `setOverlayVisible`, the test's stand-in canvas did not, and the mismatch was
 * swallowed by the `try` around the scene load — the viewer failed silently and the test that should have
 * caught it was the thing hiding it. With the stand-in typed against this, that cannot happen again: the
 * modal, the real canvas and the double are checked against one declaration.
 */
import type { FoldScene, FoldDrive } from "../sim/index.js";
import type { AnchoredMesh } from "../model/trace-anchor.js";

/** What the modal needs of the 3D view — no more, so the double is cheap and the boundary stays thin. */
export interface SimView {
  setScene(scene: FoldScene): void;
  setFoldPercent(p: number): void;
  setTileDetail(cap: number): void;
  setTileGap(frac: number): void;
  /** The copper, pinned to the mesh — see `trace-anchor`. */
  setOverlay(meshes: AnchoredMesh[]): void;
  setOverlayVisible(visible: boolean): void;
  /**
   * Report how the fold is doing, whenever it changes: `stretch` is the mean tensile bar strain
   * (0.01 = 1%), `held` says the guide is still holding the shape and has not been let go of yet.
   * Origami Simulator keeps the same number on screen at all times, and that is what makes a fold
   * that is really a shape-blend visible instead of plausible. `error` is set once, when the solver
   * threw and the fold has stopped.
   */
  setStatusListener(fn: (s: { stretch: number; held: boolean; drive: FoldDrive; error?: string }) => void): void;
  /** The fold actually applied (0..1) whenever a drawn frame changes it; it lags the target while it eases. */
  setProgressListener(fn: (applied: number) => void): void;
  warmToTarget(): void;
  /**
   * Take a fold that is driven to a goal to its current target faster than it animates: each animation
   * frame runs as many fold frames as fit a time box. They are the same frames in the same order, so the
   * pose arrived at is the same; only fewer of them are drawn. `draw: false` draws none until the fold
   * has settled (reduced motion). A new target ends it; a free fold, which has to be watched, ignores it.
   */
  hurryToTarget(opts: { draw: boolean }): void;
  start(): void;
  stop(): void;
}
