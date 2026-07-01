import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FoldScene } from "../sim/index.js";
import type { FoldSolver } from "../sim/solver.js";
import { GpuFoldSolver } from "../sim/gpu/gpu-solver.js";

/**
 * Three.js viewport for the forward kirigami fold (the only module that imports `three`; the sim
 * core stays dependency-free so it runs in Node tests). It renders the FoldNet as lit triangle
 * faces plus mountain/valley/boundary crease lines, and drives the **GPU** bar-and-hinge solver
 * (`GpuFoldSolver`, GPUComputationRenderer — Gershenfeld's GPGPU method), falling back to the
 * CPU `FoldSolver` when WebGL float support is unavailable. `foldPercent` ramps 0→1 so the flat
 * net visibly folds into the pyramid, then keeps stepping to relax.
 *
 * The face/line geometries share the model's own `position` Float32Array as their buffer, so the
 * CPU solver (which mutates it) and the GPU solver (which reads back into it) both feed the
 * render with no extra copy.
 */
const COLOR_FACE = 0xec008b;
const COLOR_MOUNTAIN = 0xff3b30;
const COLOR_VALLEY = 0x1f6feb;
const COLOR_BOUNDARY = 0x888888;
const COLOR_CUT = 0x000000; // kirigami cuts (apex-hole rim + molecule dart mouths)

const STEPS_PER_FRAME = 40;
/** Per-frame easing of the applied fold toward the slider target (smooth scrub + intro). */
const FOLD_EASE = 0.05;

export class SimCanvas {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly group = new THREE.Group();

  private fold: FoldScene | null = null;
  private gpu: GpuFoldSolver | null = null;
  private cpu: FoldSolver | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  /** Eased fold value actually fed to the solver each frame (0 = flat, 1 = fully folded). */
  private foldPercent = 0;
  /** Slider-controlled fold target the eased value chases. */
  private targetFold = 1;
  private running = false;

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

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(1, -1, 2);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
    fillLight.position.set(-1, 1, 0.5);
    this.scene.add(fillLight);
    this.scene.add(this.group);

    this.loop = this.loop.bind(this);
  }

  /** Load a fold scene: build render meshes, pick the GPU solver (or CPU fallback), reset fold. */
  setScene(scene: FoldScene): void {
    this.disposeGeo();
    this.fold = scene;
    const { net, model } = scene;

    this.posAttr = new THREE.BufferAttribute(model.position, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", this.posAttr);
    geo.setIndex(net.faces.flat());
    geo.computeVertexNormals();
    this.geo = geo;

    const faceMat = new THREE.MeshStandardMaterial({
      color: COLOR_FACE,
      side: THREE.DoubleSide,
      flatShading: true,
      metalness: 0.0,
      roughness: 0.75,
    });
    this.group.add(new THREE.Mesh(geo, faceMat));

    // crease/cut lines coloured by assignment (facets hidden); all share the live position buffer
    const byKind: Record<string, number[]> = { M: [], V: [], B: [], C: [] };
    for (const e of net.edges) {
      if (e.assignment === "F") continue;
      byKind[e.assignment]?.push(e.a, e.b);
    }
    const colors: Record<string, number> = {
      M: COLOR_MOUNTAIN,
      V: COLOR_VALLEY,
      B: COLOR_BOUNDARY,
      C: COLOR_CUT,
    };
    const widths: Record<string, number> = { M: 1, V: 1, B: 1, C: 2 };
    for (const kind of ["B", "M", "V", "C"]) {
      const idx = byKind[kind];
      if (!idx || idx.length === 0) continue;
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", this.posAttr);
      lg.setIndex(idx);
      this.group.add(
        new THREE.LineSegments(
          lg,
          new THREE.LineBasicMaterial({ color: colors[kind], linewidth: widths[kind] }),
        ),
      );
    }

    // solver backend: GPU preferred, CPU fallback (the scene already carries a CPU solver)
    this.gpu = GpuFoldSolver.create(model, this.renderer);
    this.cpu = this.gpu ? null : scene.solver;
    this.foldPercent = 0; // ease up from flat toward the current slider target

    // frame the model in view
    const reach = Math.max(net.meta.s, net.meta.H, 1) * 2.4;
    this.camera.position.set(reach, -reach, reach * 0.85);
    this.controls.target.set(0, 0, net.meta.H * 0.2);
    this.controls.update();
  }

  /** Active solver backend, for status display. */
  backend(): "gpu" | "cpu" | "none" {
    return this.gpu ? "gpu" : this.cpu ? "cpu" : "none";
  }

  /** Set the fold target (0..1); the view eases the applied fold toward it (smooth scrub). */
  setFoldPercent(p: number): void {
    this.targetFold = Math.min(1, Math.max(0, p));
  }

  /** Current fold target (0..1). */
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

  private advance(): void {
    if (!this.fold) return;
    // ease the applied fold toward the slider target so the intro and scrubbing stay smooth
    this.foldPercent += (this.targetFold - this.foldPercent) * FOLD_EASE;
    const foldPercent = this.foldPercent;
    if (this.gpu) {
      this.gpu.foldPercent = foldPercent;
      this.gpu.step(STEPS_PER_FRAME);
      this.gpu.readInto(this.fold.model);
    } else if (this.cpu) {
      this.cpu.foldPercent = foldPercent;
      for (let i = 0; i < STEPS_PER_FRAME; i++) this.cpu.step();
    }
    if (this.posAttr) this.posAttr.needsUpdate = true;
    this.geo?.computeVertexNormals();
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
    this.posAttr = null;
    this.gpu = null;
    this.cpu = null;
  }
}
