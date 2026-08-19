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
import type { FoldScene } from "../sim/index.js";
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
  warmToTarget(): void;
  start(): void;
  stop(): void;
}
