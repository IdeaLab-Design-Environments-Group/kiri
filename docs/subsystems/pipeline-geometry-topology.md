# Subsystem: Pipeline Geometry and Topology

Geometry/topology utilities are the substrate for all pipeline stages.

## Files

| File | Role |
| --- | --- |
| `src/pipeline/types.ts` | `TriMesh`, `MeshEdge`, `MeshTopology`, DTOs. |
| `src/pipeline/mesh.ts` | Topology construction and geometry helpers. |
| `src/pipeline/conditioning.ts` | Mesh repair before topology. |
| `src/core/vec3.ts` | Shared vector math. |

## Mesh Assumptions

`TriMesh` uses:

- vertices in millimetres;
- triangular faces;
- zero-based vertex indices;
- consistent face winding after conditioning.

Pipeline stages should not accept polygonal faces directly. Importers
triangulate first.

## Topology Output

`buildTopology(mesh)` returns:

- `edges`: undirected mesh edges;
- `edgeIndex`: `"a_b"` lookup;
- `vertexFaces`: ordered one-ring fan per vertex;
- `vertexEdges`: incident edge ids;
- `boundaryVertices`: set of boundary vertex ids.

## Non-Manifold Rejections

Topology construction rejects:

- face with repeated vertices;
- directed edge appearing twice;
- edge with more than two incident faces;
- vertex whose incident faces do not form one fan.

These are pipeline input failures, not viewer failures.

## Wedges

`vertexWedges(mesh, topo, v, isSeparator)` splits a vertex fan into angular
wedges separated by:

- boundary edges;
- planned cut edges;
- relief cut edges.

Wedges are used by:

- negative-curvature cut planning;
- cut-mesh vertex duplication.

## Boundary Loops and Genus

`countBoundaryLoops` and `eulerCharacteristic` support the genus gate:

```text
genus-0 with b boundary loops: chi = 2 - b
```

Anything else is rejected in v1.

## Rules

- Rebuild topology after changing connectivity.
- Do not mutate topology objects in later stages.
- Do not use topology built before conditioning.
- Keep edge keys normalized with `edgeKey`.
- Keep units in millimetres.

