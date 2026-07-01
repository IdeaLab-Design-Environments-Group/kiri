# Subsystem: GPU Simulation

The GPU simulation accelerates the same bar-and-hinge model used by the CPU
reference solver. Treat it as an optimization layer, not the source of truth.

## Files

| File | Role |
| --- | --- |
| `src/sim/gpu/pack.ts` | Pack `BarHingeModel` into float texture arrays. |
| `src/sim/gpu/shaders.ts` | GLSL force/integration shaders. |
| `src/sim/gpu/gpu-solver.ts` | Three.js `GPUComputationRenderer` wrapper. |
| `src/view/sim-canvas.ts` | Chooses GPU for guided scenes when available. |

## Runtime Requirements

GPU solver needs:

- browser environment;
- Three.js WebGL renderer;
- `GPUComputationRenderer`;
- float texture/render target support.

`GpuFoldSolver.create(...)` returns `null` when unavailable. Callers must fall
back to CPU.

## Texture Packing

`packModel` creates:

- node textures for position, velocity, mass/fixed/driven, goal;
- incidence metadata textures;
- beam metadata textures;
- crease node/parameter/face textures;
- face node/angle textures.

Every texture is square-ish and RGBA float. Indices are stored as float values
because GLSL texture channels are floats.

## Shader Contract

Shaders implement:

- axial and damping force gathering;
- crease torsion;
- face interior-angle springs;
- velocity integration;
- position integration;
- driven-node rest-to-goal interpolation;
- reset/quench support for settling.

CPU and GPU formulas should stay equivalent. If a formula changes in
`forces.ts`, audit `shaders.ts` and `pack.ts`.

## Readback

`GpuFoldSolver.readInto(model)` copies GPU position texture values back into
`model.position`.

The render path needs readback so Three.js buffer attributes backed by the model
array update correctly.

## Debug Order

If GPU differs from CPU:

1. Verify CPU first.
2. Compare `packModel` output to `BarHingeModel`.
3. Check texture dimensions and incidence list counts.
4. Check shader uniforms are set on both position and velocity variables.
5. Check `readInto` after stepping.
6. Check reset/quench uniforms if settling differs.

## Tests

Relevant tests:

- `tests/current/sim/gpu-pack.test.ts`;
- `tests/current/sim/shaders.test.ts`;
- `tests/current/sim/index.test.ts`;
- guided example tests that exercise GPU routing indirectly.

GPU rendering itself should be browser-smoke-tested; headless tests should
mostly validate packing and shader source contracts.

