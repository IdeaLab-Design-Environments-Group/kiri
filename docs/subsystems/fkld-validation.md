# Subsystem: FKLD Validation and Extension Keys

FKLD validation keeps emitted extension arrays aligned with the FKLD spec and
viewer expectations.

## Files

| File | Role |
| --- | --- |
| `fkld/spec.coffee` | Registry of FKLD extension keys. |
| `fkld/cut-types.coffee` | Cut subtype validation. |
| `fkld/molecule.coffee` | Molecule annotation validation. |
| `fkld/bridge.coffee` | FKLD bridge utilities. |
| `src/pipeline/emit.ts` | Consumes validators before returning FKLD. |
| `src/model/fkld-metadata.ts` | Displays extension values. |

## Key Rule

Do not hardcode extension strings in many places. Prefer the `KEYS` registry
from `fkld/spec.coffee` where possible.

Exception:

- `fkld:vertices_driven` is currently defined in `src/pipeline/emit.ts` as
  `DRIVEN_KEY` because it is consumed by the simulation adapter.

If `fkld:vertices_driven` becomes part of the formal FKLD registry, move it to
`fkld/spec.coffee` and update imports.

## Validation Flow

```text
Sheet
  -> emitFkld(...)
  -> build standard FOLD arrays
  -> build FKLD extension arrays
  -> validateEdgeCutTypes(...)
  -> validateMoleculeArrays(...)
  -> return FoldFile or throw PipelineError("emit")
```

## Extension Arrays

Current emitted extensions include:

- edge cut type;
- edge dihedral target;
- edge molecule theta;
- edge molecule width;
- vertex angle defect;
- vertex curvature class;
- vertex relief strategy;
- architecture metadata;
- driven vertex flags.

## Adding an Extension

1. Add the key to `fkld/spec.coffee`.
2. Add or update validators if the extension has invariants.
3. Emit it in `src/pipeline/emit.ts`.
4. Display it in `src/model/fkld-metadata.ts` if user-facing.
5. Add tests under `tests/fkld/` or `tests/current/pipeline/`.
6. Update this document and `docs/pipeline.md`.

## Validation Expectations

Validators should check:

- array length matches the relevant entity count;
- nullability is consistent with edge assignment;
- numeric values are finite where required;
- enum values are from the known set;
- molecule arrays are present together when needed.

## Failure Handling

Pipeline emission wraps validation failures in `PipelineError("emit", ...)`.
The controller displays the stage-prefixed message directly.

