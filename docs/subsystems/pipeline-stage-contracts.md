# Subsystem: Pipeline Stage Contracts

This document gives the precise input/output contract for each pipeline stage.
Use it when adding tests or replacing placeholder algorithms.

## Driver

```ts
kirigamize(input: TriMesh, options?: Partial<KirigamizeOptions>): KirigamizeResult
kirigamizeText(text: string, ext: "obj" | "stl", options?): KirigamizeResult
```

Returns all intermediates:

- `conditioning`;
- `defects`;
- `plan`;
- `unfold`;
- `sheet`;
- `fkld`;
- `report`.

## Import

```ts
parseMesh(text, ext) -> TriMesh
```

Input:

- OBJ text or ASCII STL text.

Output:

- `TriMesh` with vertices and triangular faces.

Throws:

- `PipelineError("import", ...)`.

## Conditioning

```ts
condition(mesh) -> { mesh, reports }
assertGenusZero(mesh, topo) -> void
```

Input:

- raw `TriMesh`.

Output:

- repaired `TriMesh`;
- audit `ConditionReport[]`.

Throws:

- `PipelineError("conditioning", ...)`.

## Topology

```ts
buildTopology(mesh) -> MeshTopology
```

Input:

- conditioned, consistently oriented mesh.

Output:

- edges;
- edge index map;
- ordered vertex face fans;
- vertex edge lists;
- boundary vertex set.

Throws:

- `PipelineError("mesh", ...)`.

## Curvature

```ts
angleDefects(mesh, topo) -> DefectReport
targetFoldAngles(mesh, topo) -> (number | null)[]
```

Input:

- conditioned mesh;
- topology.

Output:

- vertex defects/classes;
- total defect;
- per-edge signed target dihedrals.

## Cut Planning

```ts
planCuts(mesh, topo, defects, opts) -> CutPlan
```

Input:

- mesh/topology;
- defect report;
- lambda/strategy/extra terminals.

Output:

- cut edge ids;
- per-vertex action;
- cost summary.

Throws:

- `PipelineError("plan-cuts", ...)`.

## Unfold

```ts
seamedUnfold(mesh, topo, plan) -> UnfoldResult
```

Input:

- source mesh/topology;
- cut plan.

Output:

- flat vertices;
- faces;
- lip pairs;
- relief edges;
- patch metadata;
- `origVertex` provenance.

Throws:

- `PipelineError("unfold", ...)`.

## Route and Pack

```ts
packPatches(unfold, { mesh, topo, defects }) -> Sheet
```

Input:

- unfold result;
- source mesh/topology/defects.

Output:

- packed flat vertices;
- faces/edges;
- assignments;
- fold angles;
- cut types;
- provenance/lips.

Throws:

- `PipelineError("route-seams", ...)`.

## Emit

```ts
emitFkld(sheet, opts) -> FoldFile
```

Input:

- packed sheet;
- source target mesh/topology/defects/actions.

Output:

- FOLD/FKLD object with standard arrays, extension arrays, guided-fold frame.

Throws:

- `PipelineError("emit", ...)`.

## Verify

```ts
verifyFold(fkld, target, opts?) -> VerifyReport
```

Input:

- emitted FKLD;
- source target mesh.

Output:

- Hausdorff/strain/crease metrics;
- convergence flag;
- worst source vertex.

Throws:

- `PipelineError("verify", ...)` for non-finite solver output or invalid scene.

