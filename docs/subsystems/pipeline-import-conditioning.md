# Pipeline Import And Conditioning

This subsystem owns the first mesh-processing boundary: user text becomes a
validated `TriMesh` suitable for topological processing.

## Files

| File | Responsibility |
| --- | --- |
| `src/pipeline/import.ts` | Parse OBJ or ASCII STL text into `TriMesh`. |
| `src/pipeline/conditioning.ts` | Repair coarse mesh defects before topology and curvature stages. |
| `src/pipeline/mesh.ts` | Supplies topology helpers consumed by the genus gate. |
| `src/pipeline/types.ts` | Defines `TriMesh`, `ConditionReport`, `MeshTopology`, and `PipelineError`. |

## Import Contract

`parseMesh(text, ext)` is pure: it does not read files, touch the DOM, or infer
extensions. The controller and services decide where text comes from.

Supported inputs:

| Extension | Behavior |
| --- | --- |
| `.obj` | Reads `v` vertices and `f` faces, accepts slash references, supports negative indices, and fan-triangulates polygons. |
| `.stl` | Reads ASCII STL `vertex` triples as triangle soup. |

Unsupported inputs:

| Input | Failure |
| --- | --- |
| Binary STL | `PipelineError("import", ...)` with an actionable ASCII-export message. |
| Empty OBJ/STL | `PipelineError("import", ...)`. |
| Malformed vertex or face index | `PipelineError("import", ...)` including line context when available. |

## Conditioning Contract

`condition(mesh)` composes three repair passes and returns `{ mesh, reports }`.
The reports are user/audit data, not control flow.

Pass order:

| Pass | Function | Purpose |
| --- | --- | --- |
| Weld | `weldVertices` | Merge coincident vertices using a quantized key. |
| Degenerate removal | `dropDegenerates` | Remove zero-area faces and then remove unused vertices. |
| Orientation | `orientFaces` | BFS over shared edges so adjacent faces traverse shared edges in opposite directions. |

The pass order matters. STL imports are triangle soup, so welding must happen
before topology, and degenerate removal must happen before orientation to avoid
false non-orientability failures.

## Genus Gate

`assertGenusZero(mesh, topo)` enforces the current scope: genus-0 targets only.
It compares Euler characteristic against the expected value for a genus-0
surface with the measured boundary-loop count.

Rejected surfaces include handled objects such as tori. This is intentional:
handle-loop cutting is not implemented by the current proper-kirigami planner.

## Invariants After This Subsystem

Downstream stages assume:

| Invariant | Why It Matters |
| --- | --- |
| Faces are triangles. | Curvature and unfolding use triangle face angles. |
| Vertex indices are compact. | Topology arrays index directly by vertex id. |
| Adjacent face winding is consistent. | Signed dihedral signs depend on normals. |
| Coincident STL vertices are welded. | Edge adjacency must represent mesh topology, not triangle soup. |
| Genus is supported. | Cut planning assumes no handle-loop cut synthesis is needed. |

## Extension Points

Add new text mesh formats in `src/pipeline/import.ts`, but keep file I/O in
`src/services/model-loader.ts`. Add new conditioning passes as pure functions
that return `{ mesh, report }`, then compose them inside `condition()`.

Do not hide topology-changing repairs in later stages. If a repair changes
faces or vertices, it belongs here so reports and tests can isolate it.

