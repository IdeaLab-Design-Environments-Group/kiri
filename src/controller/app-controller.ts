/**
 * **Controller** — the only place that knows about *both* the Model and the
 * Views. It (1) translates view intents (file chosen, kirigamize, create
 * pyramid, load sample) into service calls + Model updates, and (2)
 * subscribes to the Model and pushes the new state into every View. Views and
 * the store never reference each other directly; the use-case logic itself
 * lives in `src/services/` so new features land there, not here.
 */
import { type AppState, AppStore } from "../model/app-store.js";
import { deriveFacts } from "../model/derive-facts.js";
import { type FoldFile, type LoadedModel } from "../model/fold-file.js";
import { canSimulate } from "../sim/index.js";
import { statusFromError } from "../core/errors.js";
import { loadedStatus, readModelFile, fetchSample } from "../services/model-loader.js";
import {
  kirigamizeMesh,
  createAkdePyramid,
  fkldFromPatternGrid,
  serializePatternGrid,
} from "../services/pattern-service.js";
import { resolveSimScene } from "../services/sim-scene-service.js";
import { resolveSvgExport } from "../services/svg-export-service.js";
import { resolveStlExport } from "../services/stl-export-service.js";
import { resolveRoutedCircuit } from "../services/electronics-service.js";
import { DEFAULT_PRINT_SIZE } from "../model/stl-export.js";
import { EMPTY_CIRCUIT, type Circuit } from "../model/electronics.js";
import type { ConvertPanel } from "../view/convert-panel.js";
import type { ViewerFrame } from "../view/viewer-frame.js";
import type { HeaderActions } from "../view/header-actions.js";
import type { SimModal } from "../view/sim-modal.js";
import type { ExportModal } from "../view/export-modal.js";
import type { PatternEditorModal } from "../view/pattern-editor-modal.js";
import type { ElectronicsModal } from "../view/electronics-modal.js";
import type { PatternGrid } from "../model/pattern-grid.js";

const SAMPLE_URL = "./examples/house.fkld";
const SAMPLE_NAME = "house.fkld";

export class AppController {
  constructor(
    private readonly store: AppStore,
    private readonly convert: ConvertPanel,
    private readonly viewer: ViewerFrame,
    private readonly header: HeaderActions,
    private readonly sim: SimModal,
    private readonly exporter: ExportModal,
    private readonly patternEditor: PatternEditorModal,
    private readonly electronics: ElectronicsModal,
  ) {
    // 3D Sim folds exactly what the VIEWER is showing (fall back to the loaded model). This keeps
    // "what you see is what gets simulated" true even when the viewer and the convert panel differ.
    this.sim.setProvider(() => {
      const { model, viewerShown, simMaterial } = this.store.getState();
      return resolveSimScene(model, viewerShown, simMaterial);
    });
    // The sim modal's Vinyl/3D-printed tabs feed the chosen material back into state; the provider
    // above then rebuilds the scene for that material on the next loadWorld().
    this.sim.onMaterialChange((material) => this.store.update({ simMaterial: material }));
    // The sim's adaptive-detail slider is the shared source of truth: store it so the STL export
    // defaults to the same detail — "what you see is what you print".
    this.sim.onDetailChange((detail) => this.store.update({ simDetail: detail }));
    // Likewise the sim's Gap slider: store it so the STL export uses the same inter-tile gap.
    this.sim.onGapChange((gap) => this.store.update({ simTileGap: gap }));

    // SVG export targets the same source — "what you see is what you cut" (black=cut, blue=score),
    // plus the LED copper layer (red) when a circuit is authored in the Electronics tool.
    this.exporter.setProvider(() => {
      const { model, viewerShown, circuit } = this.store.getState();
      return resolveSvgExport(model, viewerShown, circuit);
    });
    // STL export of the printed tiles (pinched hexagons, matched to the sim render). Height from the
    // menu; gap from the sim's shared `simTileGap` so export and sim match; `DEFAULT_PRINT_SIZE`
    // scales the unit-scale flat pattern to a printable mm sheet (else the export is sub-millimetre).
    this.exporter.setStlProvider((heightUnits, maxSubdiv, printSizeMm) => {
      const { model, viewerShown, simDetail, simTileGap } = this.store.getState();
      return resolveStlExport(model, viewerShown, heightUnits, maxSubdiv ?? simDetail, simTileGap, printSizeMm ?? DEFAULT_PRINT_SIZE);
    });
    // The viewer can load models on its own (file picker, example dropdown, drag-drop); record
    // what it shows in the store so sim enablement/provider derive from one source of truth.
    this.viewer.onLoaded((object, name) => this.store.update({ viewerShown: { object, name } }));

    // View intents → controller handlers.
    this.convert.onFileChosen((file) => this.loadFromFile(file));
    this.header.onCreatePyramid(() => this.createPyramid());
    this.header.onLoadSample(() => void this.loadSample());
    this.header.onKirigamize(() => this.kirigamize());

    // Secondary design path: the pattern editor commits a drawn grid as FKLD,
    // then shows it like any other pattern. The serializer feeds its download.
    this.patternEditor.onUse((grid) => this.usePattern(grid));
    this.patternEditor.setSerializer((grid) => serializePatternGrid(grid));

    // Electronics tool: the modal authors a Circuit; we store it and the next render
    // plans the routes and pushes the preview back (single-render path).
    this.electronics.onEdit((circuit) => this.updateCircuit(circuit));

    // Model changes → re-render every view (fires once immediately with state).
    this.store.subscribe((state) => this.render(state));
  }

  /** Single render path: derive view data from state and push to all views. */
  private render(state: Readonly<AppState>): void {
    const m = state.model;
    this.convert.renderFacts(m ? deriveFacts(m) : []);
    this.convert.setStatus(state.status.msg, state.status.kind);
    this.header.setKirigamizeEnabled(!!m);
    // Sim enablement follows what would actually be simulated: the viewer's
    // model first, else the loaded fold model. (Previously the viewer-driven
    // enablement was silently overridden by the next render — now it derives
    // consistently from state.)
    const simObject = state.viewerShown?.object ?? (m?.kind === "fold" ? m.object : null);
    this.sim.setEnabled(!!simObject && canSimulate(simObject));
    // Export is available for any displayed FKLD/FOLD pattern (even non-simulable ones).
    this.exporter.setEnabled(!!simObject);
    // Electronics: lay LEDs on any displayed flat pattern; feed the planned routes to the modal.
    this.electronics.setEnabled(!!simObject);
    this.electronics.setPattern(simObject);
    this.electronics.setPreview(
      simObject ? resolveRoutedCircuit(m, state.viewerShown, state.circuit ?? EMPTY_CIRCUIT) : null,
    );
  }

  /** Store the authored LED circuit; the render subscription re-plans + previews it. */
  updateCircuit(circuit: Circuit): void {
    this.store.update({ circuit });
  }

  // ---- intents (each: a service call + a store update) ---------------------

  loadFromFile(file: File): void {
    readModelFile(
      file,
      (model) => this.apply(model),
      (err) => {
        // Parse failures invalidate the current model; IO failures (unsupported
        // type, unreadable file) leave it untouched — same behavior as before.
        if (err.domain === "parse") this.store.update({ model: null, status: { msg: err.message, kind: "bad" } });
        else this.store.setStatus(err.message, "bad");
      },
    );
  }

  /**
   * The general pipeline (M1–M5): condition → curvature → plan cuts →
   * seamed unfold → pack/classify → emit FKLD → fold in the sim and verify
   * d_H against the source mesh. FOLD/FKLD models pass through to the viewer.
   */
  kirigamize(): void {
    const m = this.store.model;
    if (!m) return;
    if (m.kind === "fold") {
      this.viewer.show(m.object, m.name); // already a pattern — just show it
      this.store.setStatus(`Showing "${m.name}" in the viewer (already a FOLD/FKLD pattern).`, "ok");
      return;
    }
    this.store.setStatus(`Kirigamizing ${m.name}… (plan cuts → unfold → emit → verify)`, "");
    try {
      const outcome = kirigamizeMesh(m.text, m.ext, m.name);
      this.showPattern(outcome.fkld, outcome.name);
      this.store.setStatus(outcome.summary, outcome.ok ? "ok" : "bad");
    } catch (err) {
      // PipelineError passes through with its "<stage>: <message>" text;
      // anything else is wrapped with the kirigamize prefix.
      const { msg, kind } = statusFromError(err, "pipeline", "kirigamize failed");
      this.store.setStatus(msg, kind);
    }
  }

  /** Commit a hand-drawn crease pattern (the editor's lattice) as an FKLD pattern and show it. */
  usePattern(grid: PatternGrid): void {
    try {
      const outcome = fkldFromPatternGrid(grid);
      this.showPattern(outcome.fkld, outcome.name);
      this.store.setStatus(outcome.summary, outcome.ok ? "ok" : "bad");
      this.patternEditor.close();
    } catch (err) {
      const { msg, kind } = statusFromError(err, "create", "pattern editor failed");
      this.store.setStatus(msg, kind);
    }
  }

  /** Generate an AKDE pyramid via the transferred creation pipeline (see pattern-service). */
  createPyramid(): void {
    try {
      const outcome = createAkdePyramid();
      this.showPattern(outcome.fkld, outcome.name);
      this.store.setStatus(outcome.summary, "ok");
    } catch (err) {
      const { msg, kind } = statusFromError(err, "create");
      this.store.setStatus(msg, kind);
    }
  }

  async loadSample(announce = true): Promise<void> {
    try {
      const model = await fetchSample(SAMPLE_URL, SAMPLE_NAME);
      this.apply(model);
      if (model.kind === "fold") this.viewer.show(model.object, model.name);
      if (announce) this.store.setStatus("Loaded bundled sample into the viewer.", "ok");
    } catch {
      if (announce)
        this.store.setStatus("Sample fetch failed (serve over http). The viewer shows it by default.", "");
    }
  }

  // ---- model transitions --------------------------------------------------

  /** Commit a loaded model to the store with its standard status line (and a fresh, empty circuit). */
  private apply(model: LoadedModel): void {
    this.store.update({ model, status: loadedStatus(model), circuit: null });
  }

  /** Commit a generated pattern and show it in the viewer. */
  private showPattern(fkld: FoldFile, name: string): void {
    this.apply({ kind: "fold", name, object: fkld });
    this.viewer.show(fkld, name);
  }
}
