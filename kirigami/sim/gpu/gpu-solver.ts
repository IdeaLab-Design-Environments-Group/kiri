import * as THREE from "three";
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import type { BarHingeModel } from "../model.js";
import { computeDt } from "../forces.js";
import { packModel, type PackedModel } from "./pack.js";
import { POSITION_SHADER, VELOCITY_SHADER } from "./shaders.js";

/**
 * GPU folding solver — Gershenfeld's explicit bar-and-hinge integration on the GPU via three's
 * `GPUComputationRenderer` (ping-pong float-texture GPGPU, the same mechanism as the paper's
 * WebGL implementation). Drop-in alternative to the CPU `FoldSolver`: same `dt` / `foldPercent`
 * / `step()` surface, plus `readInto(model)` to pull positions back for rendering / assertions.
 *
 * Browser-only (needs a WebGL2 context with float render targets); the CPU `FoldSolver` is the
 * unit-tested reference twin. `create()` returns null if the GPU path is unavailable so callers
 * can fall back.
 */
export class GpuFoldSolver {
  readonly dt: number;
  foldPercent = 0;
  private readonly gpu: GPUComputationRenderer;
  private readonly posVar: ReturnType<GPUComputationRenderer["addVariable"]>;
  private readonly velVar: ReturnType<GPUComputationRenderer["addVariable"]>;
  private readonly packed: PackedModel;
  private readonly buffer: Float32Array;

  private constructor(
    private readonly model: BarHingeModel,
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    this.dt = computeDt(model);
    const packed = packModel(model, model.params.zeta);
    this.packed = packed;
    const [W, H] = packed.dim;
    this.buffer = new Float32Array(W * H * 4);

    const gpu = new GPUComputationRenderer(W, H, renderer);
    this.gpu = gpu;

    const pos0 = gpu.createTexture();
    (pos0.image.data as unknown as Float32Array).set(packed.position);
    const vel0 = gpu.createTexture();
    (vel0.image.data as unknown as Float32Array).set(packed.velocity);

    const posVar = gpu.addVariable("texturePosition", POSITION_SHADER, pos0);
    const velVar = gpu.addVariable("textureVelocity", VELOCITY_SHADER, vel0);
    gpu.setVariableDependencies(posVar, [posVar, velVar]);
    gpu.setVariableDependencies(velVar, [posVar, velVar]);
    this.posVar = posVar;
    this.velVar = velVar;

    const tex = (data: Float32Array, w: number, h: number): THREE.DataTexture => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
      t.needsUpdate = true;
      return t;
    };
    const v2 = (d: [number, number]) => new THREE.Vector2(d[0], d[1]);
    const shared = {
      uMass: { value: tex(packed.mass, W, H) },
      uRest: { value: tex(packed.position.slice(), W, H) }, // static flat positions (driven nodes)
      uGoal: { value: tex(packed.goal, W, H) },
      uNodeMeta: { value: tex(packed.nodeMeta, W, H) },
      uNodeMeta2: { value: tex(packed.nodeMeta2, W, H) },
      uBeamMeta: { value: tex(packed.beamMeta, packed.beamDim[0], packed.beamDim[1]) },
      uBeamDim: { value: v2(packed.beamDim) },
      uCreaseList: { value: tex(packed.creaseList, packed.creaseListDim[0], packed.creaseListDim[1]) },
      uCreaseListDim: { value: v2(packed.creaseListDim) },
      uCreaseNodes: { value: tex(packed.creaseNodes, packed.creaseDim[0], packed.creaseDim[1]) },
      uCreaseDim: { value: v2(packed.creaseDim) },
      uCreaseParams: { value: tex(packed.creaseParams, packed.creaseDim[0], packed.creaseDim[1]) },
      uCreaseFace1: { value: tex(packed.creaseFace1, packed.creaseDim[0], packed.creaseDim[1]) },
      uCreaseFace2: { value: tex(packed.creaseFace2, packed.creaseDim[0], packed.creaseDim[1]) },
      uFaceList: { value: tex(packed.faceList, packed.faceListDim[0], packed.faceListDim[1]) },
      uFaceListDim: { value: v2(packed.faceListDim) },
      uFaceNodes: { value: tex(packed.faceNodes, packed.faceDim[0], packed.faceDim[1]) },
      uFaceDim: { value: v2(packed.faceDim) },
      uFaceAngles: { value: tex(packed.faceAngles, packed.faceDim[0], packed.faceDim[1]) },
      uDt: { value: this.dt },
      uFoldPercent: { value: 0 },
      uKFace: { value: model.params.kFace },
    };
    for (const variable of [posVar, velVar]) {
      Object.assign((variable.material as THREE.ShaderMaterial).uniforms, structuredCloneUniforms(shared));
    }

    const err = gpu.init();
    if (err) throw new Error(`GPUComputationRenderer init failed: ${err}`);
  }

  /** Build a GPU solver, or return null if WebGL/float support is missing. */
  static create(model: BarHingeModel, renderer: THREE.WebGLRenderer): GpuFoldSolver | null {
    try {
      return new GpuFoldSolver(model, renderer);
    } catch (e) {
      console.warn("GPU solver unavailable, falling back to CPU:", e);
      return null;
    }
  }

  /** Advance `n` explicit steps at the current `foldPercent`. */
  step(n = 1): void {
    for (const variable of [this.posVar, this.velVar]) {
      const u = (variable.material as THREE.ShaderMaterial).uniforms;
      if (u.uFoldPercent) u.uFoldPercent.value = this.foldPercent;
    }
    for (let i = 0; i < n; i++) this.gpu.compute();
  }

  /** Read current GPU positions back into `model.position` (3·numNodes). */
  readInto(model: BarHingeModel = this.model): void {
    const [W, H] = this.packed.dim;
    const rt = this.gpu.getCurrentRenderTarget(this.posVar);
    this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, this.buffer);
    for (let i = 0; i < model.numNodes; i++) {
      model.position[3 * i] = this.buffer[4 * i];
      model.position[3 * i + 1] = this.buffer[4 * i + 1];
      model.position[3 * i + 2] = this.buffer[4 * i + 2];
    }
  }
}

/** Clone a uniforms map so each variable material owns its own uniform objects. */
function structuredCloneUniforms(
  u: Record<string, { value: unknown }>,
): Record<string, { value: unknown }> {
  const out: Record<string, { value: unknown }> = {};
  for (const k of Object.keys(u)) out[k] = { value: u[k].value };
  return out;
}
