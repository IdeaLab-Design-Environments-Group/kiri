import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FoldNet, FoldScene, FoldSolver, SimMaterial } from "../sim/index.js";
import { kineticDamp, removeRigidBodyMotion } from "../sim/index.js";
import { DEFAULT_MAX_SUBDIV, MAX_TILE_GAP, MIN_TILE_GAP, TILE_INSET_FRAC } from "../model/tile-subdiv.js";

/**
 * Three.js viewport for the forward fold — renders the FoldNet as lit triangle faces plus
 * mountain/valley/boundary/cut lines, driving the CPU `FoldSolver` (the unit-tested reference).
 *
 * Anti-twitch (model-level): a frustrated kirigami mesh (cut-induced floppy DOF + a driven
 * boundary) has no force-balanced state reachable by plain viscous damping — that only orbits a
 * limit cycle forever (the jitter). So once the fold reaches the target we run the **global Otter
 * quench**: zero ALL velocity each time total kinetic energy stops rising, which descends to a TRUE
 * static rest. On the CPU that's `kineticDamp`; on the GPU it's `gpu.relax()` (a per-frame velocity
 * read-back + a uReset zeroing pass — the GPU twin of the same algorithm, since JS-side damping is a
 * no-op there, velocity living on-device). When the per-frame max node motion stays below a
 * scale-relative threshold the view **freezes** (stops stepping); a hard frame cap freezes regardless.
 * (Rigid-body-motion removal is applied only to FREE folds — it fights a driven/pinned mesh.)
 *
 * Anti-overlap (uniform-pyramid presets): the mesh is split into a lateral-shell layer and a
 * molecule layer sharing one position buffer. Molecules carry a deeper polygonOffset, so when
 * they tuck coincident with the lateral faces mid-fold the laterals deterministically win the
 * depth test (no z-fight flicker). AT FULL FOLD the molecule layer and crease overlays hide
 * entirely and the N apex tips snap to one point — only the clean N-triangle shell remains.
 * Below full fold the whole mesh and all crease/cut lines are visible — the flat pattern must
 * show the molecules, not a 4-petal pinwheel. Camera near/far tightened to model scale for
 * depth precision.
 */
const COLOR_FACE = 0xec008b;
const COLOR_MOUNTAIN = 0xff3b30;
const COLOR_VALLEY = 0x1f6feb;
const COLOR_BOUNDARY = 0x888888;
const COLOR_CUT = 0x000000;
// 3D-printed mode: rigid plastic tiles, the fabric backing behind them, and the fabric-hinge lines.
const COLOR_TILE = 0xdfe3e8;
const COLOR_CLOTH = 0x5a5048;
const COLOR_HINGE = 0xb08d57;
/** Printed tile thickness as a fraction of the model's bbox diagonal (visual; physics is ratio-based). */
const TILE_THICK_FRAC = 0.018;
// `TILE_INSET_FRAC` (tile shrink toward centroid) is shared with the STL export via `tile-subdiv.ts`.

const STEPS_PER_FRAME = 40;
const GUIDED_STEPS_PER_FRAME = 80;
/** Guided mode: per-frame easing of the applied fold toward the slider target. */
const FOLD_EASE = 0.05;
/** Free mode: gentler per-step easing toward the target. */
const FREE_PER_STEP_EASE = 0.014;
/** |targetFold − foldPercent| below this counts as "at the target fold". */
const FOLD_REACHED_EPS = 1e-3;
/** Freeze after this many consecutive frames whose max node motion is below the settle threshold. */
const SETTLE_FRAMES = 10;
/** Settle threshold = SETTLE_REL · camera reach (scale-relative so it works at any model size). */
const SETTLE_REL = 4e-4;
/** Hard cap: freeze this many frames after reaching the target even if it never fully settles (~4s). */
const MAX_SETTLE_FRAMES = 240;

export class SimCanvas {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0.65);
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  private readonly fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly group = new THREE.Group();

  private fold: FoldScene | null = null;
  private cpu: FoldSolver | null = null;
  /** Uniform-pyramid preset (7N mesh topology): eligible for shell display at full fold. */
  private shellCapable = false;
  /** Currently drawing only the N lateral shell faces (true only at full fold). */
  private shellDisplayed = false;
  private faceMat: THREE.MeshStandardMaterial | null = null;
  /** Molecule layer (pyramid presets only): depth-biased behind the lateral shell. */
  private molMesh: THREE.Mesh | null = null;
  private molGeo: THREE.BufferGeometry | null = null;
  private creaseLines: THREE.LineSegments[] = [];
  private geo: THREE.BufferGeometry | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  // 3D-printed thick-tile layer (rebuilt each frame from the live folded positions).
  private material: SimMaterial = "vinyl";
  private net: FoldNet | null = null; // kept so a detail change can rebuild the tiles without a full reload
  private thickGeo: THREE.BufferGeometry | null = null;
  private thickPos: Float32Array | null = null;
  private thickAttr: THREE.BufferAttribute | null = null;
  private thickMesh: THREE.Mesh | null = null;
  private tileFaces: number[] | null = null;
  private tileDetail = DEFAULT_MAX_SUBDIV; // max adaptive subdivision; shared with the STL export (export only)
  private tileInset = TILE_INSET_FRAC; // gap: tile shrink toward centroid (the "Gap" slider); shared with export
  private tileT = 0; // one-sided extrude thickness (model units)
  private tileSign: Float32Array | null = null; // per-face ±1: extrude side, made consistent across mixed winding
  // Foldable printed joinery (see model/printed-joinery.ts): a gap opens around every tile so the
  // sheet folds up (rotating units). Per net-tri edge, true iff it is interior (shared 2-face) or a
  // "C" cut → its midpoint pinches inward to open the gap; the export bridges the fold gaps with thin
  // living hinges. Tile CORNERS always stay full = the pinpoint pivots.
  private tileEdgePinch: boolean[][] | null = null;
  private foldPercent = 0;
  // Open at the flat full sheet (0): the kirigamized body is first shown as the complete
  // paper with every cut line visible, then the user drives the fold slider up to the target.
  private targetFold = 0;
  private running = false;
  /** True when the scene drives boundary nodes to a goal mesh (AKDE pyramid). */
  private guided = false;
  /** Freeze stepping once folded + settled so the pose is dead still (no twitch). */
  private frozen = false;
  /** Previous frame's node positions, for the position-delta settle test. */
  private prevPos: Float32Array | null = null;
  private settledFrames = 0;
  private framesAtTarget = 0;
  /** Max per-frame node motion (model units) below which the fold counts as still. */
  private settleEps = 1e-3;
  /** Global-quench (Otter) kinetic-energy tracker for the CPU paths (the GPU keeps its own). */
  private prevKE = Infinity;

  constructor(container: HTMLElement) {
    const w = container.clientWidth || 480;
    const h = container.clientHeight || 360;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0xf4f4f6, 1);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xf4f4f6);
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.5, 20000);
    this.camera.position.set(260, -260, 220);
    this.camera.up.set(0, 0, 1); // z-up to match the model's vertical apex axis

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.zoomToCursor = true; // KiCad-style: wheel zooms toward the cursor
    this.controls.screenSpacePanning = true;

    this.scene.add(this.ambient);
    this.keyLight.position.set(1, -1, 2);
    this.scene.add(this.keyLight);
    this.fillLight.position.set(-1, 1, 0.5);
    this.scene.add(this.fillLight);
    this.scene.add(this.group);

    this.loop = this.loop.bind(this);
  }

  /** Load a fold scene: build render meshes, pick the solver backend, reset fold. */
  setScene(scene: FoldScene): void {
    this.disposeGeo();
    this.fold = scene;
    const { net, model } = scene;
    this.net = net;
    this.thickMesh = null; // disposeGeo()/group.clear() dropped the old tile mesh
    this.material = scene.material ?? "vinyl";

    this.guided = anyDriven(model.driven);
    this.foldPercent = 0;
    this.frozen = false;
    this.settledFrames = 0;
    this.framesAtTarget = 0;
    this.prevKE = Infinity;
    this.prevPos = model.position.slice();

    this.posAttr = new THREE.BufferAttribute(model.position, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);

    // Printed mode renders thick tiles, never the thin pyramid shell swap.
    this.shellCapable = isUniformPyramidShell(net) && this.material !== "printed";
    this.shellDisplayed = false;
    // Pyramid presets split into lateral shell + molecule layers (shared position buffer) so the
    // molecules can carry a deeper depth bias; other meshes draw as one layer.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", this.posAttr);
    geo.setIndex(this.shellCapable ? lateralFaceIndices(net) : net.faces.flat());
    geo.computeVertexNormals();
    this.geo = geo;

    // Vinyl: the flat sheet itself. Printed: this flat mesh becomes the fabric BACKING that shows
    // through the hinge gaps, with the thick rigid tiles drawn on top (buildPrintedTiles below).
    this.faceMat = new THREE.MeshStandardMaterial({
      color: this.material === "printed" ? COLOR_CLOTH : COLOR_FACE,
      side: THREE.DoubleSide,
      flatShading: true,
      metalness: 0.0,
      roughness: this.material === "printed" ? 0.95 : 0.75,
      polygonOffset: true,
      polygonOffsetFactor: this.material === "printed" ? 4 : 1,
      polygonOffsetUnits: this.material === "printed" ? 4 : 1,
    });
    this.group.add(new THREE.Mesh(geo, this.faceMat));

    this.molMesh = null;
    this.molGeo = null;
    if (this.shellCapable) {
      // Molecules tuck flush against the lateral faces near full fold; the deeper polygon offset
      // pushes them behind in the depth buffer so the coincident surfaces never z-fight.
      const molGeo = new THREE.BufferGeometry();
      molGeo.setAttribute("position", this.posAttr);
      molGeo.setIndex(moleculeFaceIndices(net));
      molGeo.computeVertexNormals();
      this.molGeo = molGeo;
      const molMat = new THREE.MeshStandardMaterial({
        color: COLOR_FACE,
        side: THREE.DoubleSide,
        flatShading: true,
        metalness: 0.0,
        roughness: 0.75,
        polygonOffset: true,
        polygonOffsetFactor: 3,
        polygonOffsetUnits: 3,
      });
      this.molMesh = new THREE.Mesh(molGeo, molMat);
      this.group.add(this.molMesh);
    }

    // Crease/cut lines coloured by assignment (facets hidden); all share the live position
    // buffer. Shell presets hide them only at full fold (syncShellDisplay), where the molecule
    // creases and duplicate apex tips converge and z-fight as visual clutter.
    const byKind = creaseIndices(net);
    // Printed: M/V/B fold lines are the fabric hinges (one cloth colour); cuts stay black.
    const colors: Record<string, number> =
      this.material === "printed"
        ? { M: COLOR_HINGE, V: COLOR_HINGE, B: COLOR_HINGE, C: COLOR_CUT }
        : { M: COLOR_MOUNTAIN, V: COLOR_VALLEY, B: COLOR_BOUNDARY, C: COLOR_CUT };
    const widths: Record<string, number> = { M: 1, V: 1, B: 1, C: 2 };
    this.creaseLines = [];
    for (const kind of ["B", "M", "V", "C"]) {
      const idx = byKind[kind];
      if (!idx || idx.length === 0) continue;
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", this.posAttr);
      lg.setIndex(idx);
      const line = new THREE.LineSegments(
        lg,
        new THREE.LineBasicMaterial({ color: colors[kind], linewidth: widths[kind] }),
      );
      this.creaseLines.push(line);
      this.group.add(line);
    }

    // Printed: thick rigid tiles drawn on top of the fabric backing, rebuilt each frame.
    if (this.material === "printed") this.buildPrintedTiles(net);

    // CPU reference solver for all modes (guided AKDE presets are verified on this path).
    this.cpu = scene.solver;
    // Self-collision so folded layers don't pass through each other. Driven (guided) nodes are
    // fixed and skipped, so prescribed shapes are unaffected; free folds get layer-vs-layer contact.
    this.cpu.enableCollision();

    // Frame the camera to the model's ACTUAL bounding box — the union of the flat rest and the
    // folded goal, so nothing crops as the fold slider scrubs — rather than a fixed radius. The
    // importer normalizes every model to a bounding-SPHERE of radius 1, so a high-aspect relief (a
    // tall, narrow relief especially) occupies only a thin slice of a fixed sphere and renders as
    // a sliver. Fitting to the box makes any aspect fill the view. Tightening near/far to the box
    // also keeps the ~250:1 depth ratio that stops coincident folded faces z-fighting.
    const mdl = scene.model;
    const anyDrivenNode = ((): boolean => { for (let i = 0; i < mdl.driven.length; i++) if (mdl.driven[i]) return true; return false; })();
    let loX = Infinity, loY = Infinity, loZ = Infinity, hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity;
    const swallow = (a: Float32Array): void => {
      for (let i = 0; i < mdl.numNodes; i++) {
        const x = a[3 * i], y = a[3 * i + 1], z = a[3 * i + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (x < loX) loX = x; if (x > hiX) hiX = x;
        if (y < loY) loY = y; if (y > hiY) hiY = y;
        if (z < loZ) loZ = z; if (z > hiZ) hiZ = z;
      }
    };
    swallow(mdl.position);
    if (anyDrivenNode) swallow(mdl.goal); // guided: also bound the folded relief it eases into
    const cx = (loX + hiX) / 2, cy = (loY + hiY) / 2, cz = (loZ + hiZ) / 2;
    // Fit the LARGEST box dimension to the frame. (Old code framed the radius-1 bounding sphere —
    // span≈2 — at reach 2.4, i.e. reach ≈ span·1.2; reuse that density so the proven framing is
    // unchanged for square models while narrow signs now fill the view too.)
    const span = Math.max(hiX - loX, hiY - loY, hiZ - loZ, 1e-3);
    const reach = span * 1.2;
    this.settleEps = reach * SETTLE_REL;
    this.camera.near = Math.max(0.02, reach * 0.04);
    this.camera.far = reach * 12;
    this.camera.position.set(cx + reach, cy - reach, cz + reach * 0.85);
    this.camera.updateProjectionMatrix();
    this.controls.target.set(cx, cy, cz);
    this.controls.update();
  }

  /** Active solver backend, for status display. */
  backend(): "gpu" | "cpu" | "none" {
    return this.cpu ? "cpu" : "none";
  }

  /**
   * Fast-forward a guided fold to the current slider target. The modal now opens flat (target 0),
   * so this is a no-op on open (the early return below) and only does work once the user scrubs the
   * fold slider to a non-zero target — without the burst the mesh would ease in over many frames.
   */
  warmToTarget(): void {
    if (!this.fold || !this.guided || !this.cpu || this.targetFold < FOLD_REACHED_EPS) return;
    this.cpu.solve(16000, this.targetFold);
    this.foldPercent = this.targetFold;
    this.syncShellDisplay();
    this.flushGeometry();
    this.prevPos = this.fold.model.position.slice();
  }

  setFoldPercent(p: number): void {
    this.targetFold = Math.min(1, Math.max(0, p));
    this.frozen = false; // scrubbing wakes a frozen fold
    this.settledFrames = 0;
    this.framesAtTarget = 0;
    this.prevKE = Infinity;
    this.prevPos = this.fold?.model.position.slice() ?? null; // restart the settle test from here
  }

  getFoldPercent(): number {
    return this.targetFold;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
  }

  dispose(): void {
    this.stop();
    this.disposeGeo();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private advance(): void {
    if (!this.fold || this.frozen) return; // frozen: hold the pose, orbit only
    const m = this.fold.model;

    // The quench only runs ONCE THE SHAPE IS REACHED. During the ramp the driven boundary keeps
    // injecting energy, so quenching then would repeatedly halt the lagging interior and leave a
    // worse pose; under bare ζ the ramp stays smooth, and the quench settles it afterward.
    if (this.guided) {
      this.foldPercent += (this.targetFold - this.foldPercent) * FOLD_EASE;
      if (Math.abs(this.targetFold - this.foldPercent) < FOLD_REACHED_EPS) this.foldPercent = this.targetFold;
      const atTarget = this.foldPercent === this.targetFold;
      if (this.cpu) {
        this.cpu.foldPercent = this.foldPercent;
        for (let i = 0; i < GUIDED_STEPS_PER_FRAME; i++) {
          this.cpu.step();
          if (atTarget) this.prevKE = kineticDamp(m, this.prevKE);
        }
      }
    } else if (this.cpu) {
      // Free fold (self-supporting origami/kirigami, e.g. the Miyamoto RES tower): drive crease
      // targets and let the OS-faithful under-damped dynamics settle — exactly as Origami Simulator
      // does. NO kinetic quench here: zeroing velocity at the first equilibrium traps an
      // underconstrained sheet flat before it can buckle UP into shape (the RES tower stalled at
      // h/w≈0.2 with the quench vs ≈0.57 erected without it). Rigid-removal kills the un-pinned
      // mesh's global drift; the per-frame motion-freeze settles it once it stops moving.
      for (let i = 0; i < STEPS_PER_FRAME; i++) {
        this.foldPercent += (this.targetFold - this.foldPercent) * FREE_PER_STEP_EASE;
        this.cpu.foldPercent = this.foldPercent;
        this.cpu.step();
        removeRigidBodyMotion(m);
      }
      if (Math.abs(this.targetFold - this.foldPercent) < FOLD_REACHED_EPS) this.foldPercent = this.targetFold;
    }

    this.flushGeometry();
    this.maybeFreeze();
  }

  /**
   * Freeze once the fold has reached the target AND the mesh has stopped moving (max per-frame node
   * displacement below `settleEps` for `SETTLE_FRAMES` frames), or after a hard frame cap. Freezing
   * stops all stepping, so the held pose is perfectly still. With the per-node quick-min quench the
   * mesh actually reaches rest, so this fires quickly instead of bottoming out at the cap.
   */
  private maybeFreeze(): void {
    const pos = this.fold!.model.position;
    let moved = Infinity;
    if (this.prevPos && this.prevPos.length === pos.length) {
      moved = 0;
      for (let i = 0; i < pos.length; i++) {
        const d = Math.abs(pos[i] - this.prevPos[i]);
        if (d > moved) moved = d;
      }
      this.prevPos.set(pos);
    } else {
      this.prevPos = pos.slice();
    }

    const atTarget = Math.abs(this.targetFold - this.foldPercent) < FOLD_REACHED_EPS;
    if (!atTarget) {
      this.framesAtTarget = 0;
      this.settledFrames = 0;
      return;
    }
    this.framesAtTarget++;
    if (moved < this.settleEps) this.settledFrames++;
    else this.settledFrames = 0;

    if (this.settledFrames >= SETTLE_FRAMES || this.framesAtTarget >= MAX_SETTLE_FRAMES) {
      this.fold!.model.velocity.fill(0); // hold the pose dead still (CPU; GPU just stops stepping)
      this.frozen = true;
    }
  }

  private flushGeometry(): void {
    this.syncShellDisplay();
    if (this.posAttr) this.posAttr.needsUpdate = true;
    this.geo?.computeVertexNormals();
    if (this.molMesh?.visible) this.molGeo?.computeVertexNormals();
    if (this.material === "printed") this.updatePrintedTiles();
  }

  /**
   * Build the 3D-printed thick-tile layer: one solid prism per (triangular) face. A tile is inset
   * per-EDGE — kept full at fold edges (M/V/F) so neighbouring tiles meet into one structure, pulled
   * in at cut/boundary edges so those open. The non-indexed buffer is rebuilt every frame from the
   * live folded positions (`updatePrintedTiles`) since the inset + extrusion follow each face frame.
   */
  private buildPrintedTiles(net: FoldNet): void {
    if (!this.fold) return;
    const pos = this.fold.model.position;
    // Visual thickness from the model size (physics closure is ratio-based, set elsewhere).
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
      minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
      minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]);
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    // One-sided: the full tile thickness extrudes to ONE side of the hinge plane (the +normal face);
    // the cloth surface mesh stays at the plane as the backing.
    this.tileT = diag * TILE_THICK_FRAC;

    if (this.thickMesh) { // rebuild just this layer — drop the previous tile mesh first
      this.group.remove(this.thickMesh);
      this.thickGeo?.dispose();
      (this.thickMesh.material as THREE.Material).dispose();
      this.thickMesh = null;
    }

    this.tileFaces = net.faces.flat();
    const ff = this.tileFaces;
    const nTris = ff.length / 3;
    const r = this.fold.model.rest;
    // Per-tile extrude side: pin every tile to ONE side vs the mesh's mean (flat) normal so mixed
    // winding doesn't flip some tiles. Plus per-tile pinch flags (`isPinch`) for the foldable layout.
    const edgeFaces = new Map<string, number>();
    net.faces.forEach((f) => {
      for (let k = 0; k < f.length; k++) {
        const key = f[k] < f[(k + 1) % f.length] ? `${f[k]}_${f[(k + 1) % f.length]}` : `${f[(k + 1) % f.length]}_${f[k]}`;
        edgeFaces.set(key, (edgeFaces.get(key) ?? 0) + 1);
      }
    });
    const assign = new Map<string, string>();
    for (const e of net.edges) assign.set(e.a < e.b ? `${e.a}_${e.b}` : `${e.b}_${e.a}`, e.assignment);
    // FOLDABLE joinery (rotating units, matches the STL export / printed-joinery.ts): a gap is opened
    // only where two tiles genuinely meet as separate bodies — the real HINGE folds ("M"/"V") and the
    // "C" cuts. PINCH = pull an edge midpoint in to open that gap; tile CORNERS stay full → the pinpoint
    // pivots the tiles fold about. A flat-facet ("F") edge is the interior triangulation diagonal of ONE
    // logical polygon, NOT a joint: it must NOT pinch, so coplanar triangles stay merged into a single
    // rigid tile. Otherwise a flat polygon shatters into triangles that "fold" along the vinyl facet
    // lines instead of at the 3D joints where polygons actually touch.
    const isPinch = (u: number, w: number): boolean => {
      const key = u < w ? `${u}_${w}` : `${w}_${u}`;
      const a = assign.get(key);
      if (a === "C") return true; // cut → the kirigami opening
      if (a === "F") return false; // flat facet (triangulation interior) → keep tiles merged, no fold here
      return (edgeFaces.get(key) ?? 0) >= 2; // real interior fold (M/V) → hinge joint between two tiles
    };
    this.tileSign = new Float32Array(nTris);
    this.tileEdgePinch = [];
    let mx = 0, my = 0, mz = 0;
    const nrm: number[][] = [];
    for (let f = 0; f < ff.length; f += 3) {
      const ia = ff[f], ib = ff[f + 1], ic = ff[f + 2], a = ia * 3, b = ib * 3, c = ic * 3;
      const nx = (r[b + 1] - r[a + 1]) * (r[c + 2] - r[a + 2]) - (r[b + 2] - r[a + 2]) * (r[c + 1] - r[a + 1]);
      const ny = (r[b + 2] - r[a + 2]) * (r[c] - r[a]) - (r[b] - r[a]) * (r[c + 2] - r[a + 2]);
      const nz = (r[b] - r[a]) * (r[c + 1] - r[a + 1]) - (r[b + 1] - r[a + 1]) * (r[c] - r[a]);
      nrm.push([nx, ny, nz]); mx += nx; my += ny; mz += nz;
      this.tileEdgePinch.push([isPinch(ia, ib), isPinch(ib, ic), isPinch(ic, ia)]); // edges AB, BC, CA
    }
    for (let i = 0; i < nrm.length; i++) {
      this.tileSign[i] = nrm[i][0] * mx + nrm[i][1] * my + nrm[i][2] * mz >= 0 ? 1 : -1;
    }

    // Each tile is a 6-gon prism (3 corners + 3 edge midpoints): top fan (6 tris) + 6 side quads (12).
    this.thickPos = new Float32Array(nTris * 18 * 3 * 3);
    this.thickGeo = new THREE.BufferGeometry();
    this.thickAttr = new THREE.BufferAttribute(this.thickPos, 3);
    this.thickAttr.setUsage(THREE.DynamicDrawUsage);
    this.thickGeo.setAttribute("position", this.thickAttr);
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_TILE,
      side: THREE.DoubleSide,
      flatShading: true,
      metalness: 0.0,
      roughness: 0.6,
    });
    this.thickMesh = new THREE.Mesh(this.thickGeo, mat);
    this.group.add(this.thickMesh);
    this.updatePrintedTiles();
  }

  /** Set the fold-adaptive detail cap (shared with the export) and rebuild the printed tiles. */
  setTileDetail(cap: number): void {
    const v = Math.max(0, Math.floor(cap));
    if (v === this.tileDetail) return;
    this.tileDetail = v;
    if (this.material === "printed" && this.net) this.buildPrintedTiles(this.net);
  }

  /** Set the inter-tile gap (shrink-toward-centroid fraction, shared with the export) and rebuild. */
  setTileGap(frac: number): void {
    const v = Math.min(MAX_TILE_GAP, Math.max(MIN_TILE_GAP, frac));
    if (v === this.tileInset) return;
    this.tileInset = v;
    if (this.material === "printed" && this.net) this.buildPrintedTiles(this.net);
  }

  /**
   * Refill the printed-tile buffer (foldable joinery): each net triangle is a 6-gon prism
   * [A, mAB, B, mBC, C, mCA] extruded +t. Interior + "C" cut edges pinch their midpoint inward to open
   * a gap around every tile (so the sheet folds up); the export then bridges the fold/facet gaps with
   * thin living hinges. Corners stay full (the pinpoint pivots). Walls all round (the open bottom is
   * hidden by the cloth backing).
   */
  private updatePrintedTiles(): void {
    const faces = this.tileFaces, pinchFlags = this.tileEdgePinch, out = this.thickPos;
    if (!faces || !pinchFlags || !out || !this.fold) return;
    const p = this.fold.model.position;
    const t = this.tileT, inset = this.tileInset, sign = this.tileSign;
    type V = [number, number, number];
    let o = 0;
    const push = (v: V): void => { out[o++] = v[0]; out[o++] = v[1]; out[o++] = v[2]; };
    for (let f = 0, fi = 0; f < faces.length; f += 3, fi++) {
      const A: V = [p[faces[f] * 3], p[faces[f] * 3 + 1], p[faces[f] * 3 + 2]];
      const B: V = [p[faces[f + 1] * 3], p[faces[f + 1] * 3 + 1], p[faces[f + 1] * 3 + 2]];
      const C: V = [p[faces[f + 2] * 3], p[faces[f + 2] * 3 + 1], p[faces[f + 2] * 3 + 2]];
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
      const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1, s = sign ? sign[fi] : 1;
      nx = (nx / nl) * s; ny = (ny / nl) * s; nz = (nz / nl) * s;
      const Gx = (A[0] + B[0] + C[0]) / 3, Gy = (A[1] + B[1] + C[1]) / 3, Gz = (A[2] + B[2] + C[2]) / 3;
      const pinch = pinchFlags[fi]; // [AB, BC, CA]
      // Pinch distance from the tile's inradius (scaled by the Gap) — uniform regardless of tile shape.
      const peri = Math.hypot(ux, uy, uz) + Math.hypot(C[0] - B[0], C[1] - B[1], C[2] - B[2]) + Math.hypot(A[0] - C[0], A[1] - C[1], A[2] - C[2]) || 1;
      const d = inset * (nl / peri) * 2; // inradius = 2·area/peri = nl/peri
      // Edge midpoint pushed PERPENDICULAR to its edge (toward the centroid) by d → opens the empty space.
      const mid = (P: V, Q: V, doPinch: boolean): V => {
        const mx = (P[0] + Q[0]) / 2, my = (P[1] + Q[1]) / 2, mz = (P[2] + Q[2]) / 2;
        if (!doPinch) return [mx, my, mz];
        const ex = Q[0] - P[0], ey = Q[1] - P[1], ez = Q[2] - P[2];
        let px = ny * ez - nz * ey, py = nz * ex - nx * ez, pz = nx * ey - ny * ex; // in-plane ⟂ to the edge
        const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
        if (px * (Gx - mx) + py * (Gy - my) + pz * (Gz - mz) < 0) { px = -px; py = -py; pz = -pz; } // inward
        return [mx + px * d, my + py * d, mz + pz * d];
      };
      // CCW 6-gon ring: corner, edge-midpoint, corner, … — corners full (hinges), interior mids pinched.
      const ring: V[] = [A, mid(A, B, pinch[0]), B, mid(B, C, pinch[1]), C, mid(C, A, pinch[2])];
      const top = (v: V): V => [v[0] + nx * t, v[1] + ny * t, v[2] + nz * t];
      const tops = ring.map(top);
      const gT: V = [Gx + nx * t, Gy + ny * t, Gz + nz * t];
      for (let e = 0; e < 6; e++) { const j = (e + 1) % 6; push(gT); push(tops[e]); push(tops[j]); } // top fan
      for (let e = 0; e < 6; e++) { // side walls (open bottom — hidden by the cloth backing)
        const j = (e + 1) % 6;
        push(ring[e]); push(ring[j]); push(tops[j]);
        push(ring[e]); push(tops[j]); push(tops[e]);
      }
    }
    this.thickAttr!.needsUpdate = true;
    this.thickGeo!.computeVertexNormals();
  }

  /**
   * Swap between the full-mesh and shell display for uniform-pyramid presets. Below full fold
   * the whole mesh (molecule layer included) and all crease lines are drawn; at full fold the
   * molecule layer and crease lines hide and the duplicate apex tips snap to one point, leaving
   * only the clean N-triangle lateral shell.
   */
  private syncShellDisplay(): void {
    if (!this.shellCapable || !this.fold) return;
    const wantShell = this.foldPercent >= 1 - FOLD_REACHED_EPS;
    if (wantShell !== this.shellDisplayed) {
      this.shellDisplayed = wantShell;
      if (this.molMesh) this.molMesh.visible = !wantShell;
      if (this.faceMat) {
        this.faceMat.side = wantShell ? THREE.FrontSide : THREE.DoubleSide;
        this.faceMat.needsUpdate = true;
      }
      for (const line of this.creaseLines) line.visible = !wantShell;
    }
    if (wantShell) snapTipsToMean(this.fold.model.position, this.fold.net.tips);
  }

  private loop(): void {
    if (!this.running) return;
    this.advance();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.loop);
  }

  private disposeGeo(): void {
    this.group.clear();
    this.geo?.dispose();
    this.geo = null;
    this.molGeo?.dispose();
    this.molGeo = null;
    this.molMesh = null;
    this.posAttr = null;
    this.thickGeo?.dispose();
    this.thickGeo = null;
    this.thickPos = null;
    this.thickAttr = null;
    this.thickMesh = null;
    this.tileFaces = null;
    this.tileEdgePinch = null;
    this.cpu = null;
    this.faceMat = null;
    this.creaseLines = [];
    this.shellCapable = false;
    this.shellDisplayed = false;
  }
}

/** AKDE uniform pyramid: N lateral tris + 6N molecule tris = 7N faces. */
function isUniformPyramidShell(net: FoldNet): boolean {
  const N = net.meta.N;
  return N > 0 && net.faces.length === 7 * N;
}

/** The N lateral shell triangles (faces[7k] of each molecule group). */
function lateralFaceIndices(net: FoldNet): number[] {
  const out: number[] = [];
  for (let k = 0; k < net.meta.N; k++) out.push(...net.faces[7 * k]);
  return out;
}

/** The 6N molecule triangles (everything but the laterals). */
function moleculeFaceIndices(net: FoldNet): number[] {
  const out: number[] = [];
  for (let f = 0; f < net.faces.length; f++) {
    if (f % 7 !== 0) out.push(...net.faces[f]);
  }
  return out;
}

function creaseIndices(net: FoldNet): Record<string, number[]> {
  const byKind: Record<string, number[]> = { M: [], V: [], B: [], C: [] };
  for (const e of net.edges) {
    if (e.assignment === "F") continue;
    byKind[e.assignment]?.push(e.a, e.b);
  }
  return byKind;
}

function snapTipsToMean(pos: Float32Array, tips: number[]): void {
  if (tips.length === 0) return;
  let x = 0, y = 0, z = 0;
  for (const i of tips) {
    x += pos[3 * i];
    y += pos[3 * i + 1];
    z += pos[3 * i + 2];
  }
  const n = tips.length;
  x /= n;
  y /= n;
  z /= n;
  for (const i of tips) {
    pos[3 * i] = x;
    pos[3 * i + 1] = y;
    pos[3 * i + 2] = z;
  }
}

function anyDriven(driven: Uint8Array): boolean {
  for (let i = 0; i < driven.length; i++) if (driven[i]) return true;
  return false;
}
