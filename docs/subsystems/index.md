# Subsystem Docs

Subsystem docs are narrower than the architecture docs. Each page describes a
single working area: files, data flow, extension points, and failure modes.

| Subsystem | Doc | Covers |
| --- | --- | --- |
| Core | `core.md` | Dependency-free errors and vector primitives. |
| Error handling | `error-handling.md` | AppError/PipelineError domains and controller policy. |
| Services | `services.md` | Use-case facades between controller and domain modules. |
| Model loading | `model-loading.md` | File parsing, FileReader callback flow, sample loading. |
| App shell/controller | `app-shell.md` | MVC orchestration, intents, app state, controller failure handling. |
| App state | `app-state.md` | Store shape, mutation rules, render derivation. |
| UI components | `ui-components.md` | View contracts, callback/render methods, component test expectations. |
| Viewer bridge | `viewer-bridge.md` | iframe `postMessage` contract and current-viewer model tracking. |
| Metadata/presenters | `metadata-presenters.md` | Derived facts and FKLD metadata presenters. |
| Creation pipeline | `creation-pipeline.md` | Transferred AKDE pyramid generation path. |
| General pipeline | `../pipeline.md` | Mesh-to-FKLD conversion stages M1-M5. |
| Pipeline stage contracts | `pipeline-stage-contracts.md` | Input/output/throw contract for each pipeline stage. |
| Pipeline geometry/topology | `pipeline-geometry-topology.md` | TriMesh, MeshTopology, wedges, boundary/genus helpers. |
| Pipeline import/conditioning | `pipeline-import-conditioning.md` | OBJ/STL parsing, mesh repair passes, genus gate, conditioning invariants. |
| Pipeline curvature/cuts | `pipeline-curvature-cut-planning.md` | Angle defects, dihedral targets, relief strategy, cut forest routing. |
| Pipeline unfolding/placement | `pipeline-unfolding-placement.md` | Cut mesh splitting, vent slivers, flat development, edge classification. |
| Pipeline FKLD emission | `pipeline-emission.md` | FKLD serialization, guided-fold frame, driven flags, extension validation. |
| Pipeline verification | `pipeline-verification.md` | Equilibrium verification, metrics, retry hook. |
| Bistable star tiling | `bst-pipeline.md` | BST uniform/surface-fit pipeline, FKLD emission, and method-selector route. |
| Simulation | `../simulation.md` | Bar-and-hinge solver and guided/free simulation modes. |
| CPU simulation | `simulation-cpu.md` | Reference solver, model arrays, stabilization, debugging. |
| GPU simulation | `simulation-gpu.md` | Texture packing, shaders, readback, CPU parity. |
| FKLD validation | `fkld-validation.md` | Extension keys, validators, emission checks. |
| SVG export | `svg-export.md` | Cut/score layer export, ZIP payloads, export modal. |
| Export modal routing | `export-modal.md` | Shared SVG/STL download surface and provider lifecycle. |
| STL export | `stl-export.md` | Printed tile STL export, adaptive subdivision, sim/export parity. |
| Pattern editor | `pattern-editor.md` | Paintable crease lattice, presets, and FKLD emission route. |
| SVG import | `svg-import.md` | Origami Simulator SVG to FOLD/FKLD importer and RES Tower generator. |
| Origami/FOLD sim import | `origami-import.md` | FOLD/FKLD preprocessing, fold-angle policy, and solver model assembly. |
| Scene routing | `scene-routing.md` | Viewer-first source selection for sim/export. |
| Modal lifecycle | `modal-lifecycle.md` | Sim/export modal providers, open/close, downloads. |
| Static assets/examples | `static-assets-and-examples.md` | `public/`, samples, viewer asset source of truth. |
| Example generators | `example-generators.md` | Reproducible scripts that create bundled public examples. |
| Build/config | `build-and-config.md` | Vite, Vitest, CoffeeScript transform, aliases, command expectations. |
| Styling | `styling.md` | Global CSS contract, view class names, modal/export style ownership. |
| Test suite | `test-suite.md` | Test folders, patterns, architecture checks. |

Use this directory when changing one subsystem and you need local rules without
reading the full architecture document.
