# Subsystem: CPU Simulation

The CPU simulation is the reference implementation of the bar-and-hinge solver.
Use it for correctness work and tests before debugging GPU behavior.

## Files

| File | Role |
| --- | --- |
| `src/sim/model.ts` | Build `BarHingeModel` arrays. |
| `src/sim/forces.ts` | Face normals, fold angles, forces, integration, timestep. |
| `src/sim/solver.ts` | `FoldSolver` stepping and solve helpers. |
| `src/sim/stabilize.ts` | Kinetic damping, velocity damping, rigid-body removal, guards. |
| `src/sim/vec3.ts` | Vector math utilities. |

## Data Model

`BarHingeModel` is struct-of-arrays:

- node arrays: `position`, `rest`, `velocity`, `force`, `mass`, `fixed`,
  `goal`, `driven`;
- beam arrays: endpoints, rest length, axial stiffness;
- crease arrays: wing nodes, crease nodes, adjacent faces, stiffness, target;
- face arrays: triangle vertices, nominal angles, normals.

This layout mirrors the GPU texture packing and makes CPU/GPU comparison
straightforward.

## Step Order

One CPU step:

```text
driveBoundary()
computeFaceNormals()
computeThetas()
accumulateForces()
integrate()
```

Driven nodes are kinematically placed from rest to goal by `foldPercent`.

## Stability Tools

`src/sim/stabilize.ts` owns anti-jitter math:

- `totalKineticEnergy`;
- `kineticDamp`;
- `dampVelocity`;
- `removeRigidBodyMotion`;
- `guardFinite`.

Keep these functions pure over model arrays. Do not reimplement copies in the
view.

## Sign Convention

For the Ghassaei/Demaine/Gershenfeld solver:

- mountain target theta is negative at FOLD/FKLD assignment defaults;
- valley target theta is positive;
- fold adapter converts `edges_foldAngle` degrees to radians;
- crease edges are oriented from face winding so signed theta is stable.

Pipeline source dihedral signs may differ before FKLD emission. Keep conversion
logic at boundaries.

## Debug Checklist

When CPU sim is wrong:

1. Test `singleHingeModel` or a two-triangle pattern.
2. Inspect `model.creases.targetTheta`.
3. Inspect `computeThetas` output sign.
4. Disable face springs only for isolation tests, not as a production fix.
5. Check `computeDt` after stiffness changes.
6. Use `guardFinite` to catch divergence early.

## Tests

Relevant tests are under:

- `tests/current/sim/model.test.ts`;
- `tests/current/sim/forces.test.ts`;
- `tests/current/sim/solver.test.ts`;
- `tests/current/sim/stabilize.test.ts`;
- `tests/current/sim/origami-exact.test.ts`;
- `tests/current/sim/stability.test.ts`.

