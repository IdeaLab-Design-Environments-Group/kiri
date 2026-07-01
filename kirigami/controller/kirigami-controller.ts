import { computeState, defaultInputs } from "../model/geometry.js";
import { evaluateConstraints } from "../model/constraints.js";
import { buildPatternNet } from "../model/pattern.js";
import { buildExportPayload, type ExportPayload } from "../model/svg-export.js";
import { buildFkldDownload, buildFkldFile, type FkldFile } from "../model/fkld-export.js";
import {
  APEX_HEIGHT_ERROR,
  MATERIAL_THICKNESS_ERROR,
  validateInputs,
} from "../model/validation.js";
import type { ConstraintState, KirigamiInputs, KirigamiState } from "../model/types.js";
import { formatAngleDeg, formatMm } from "./formatters.js";
import type {
  InputsPanel,
  InputsPanelDerivedField,
  InputsPanelRenderModel,
} from "../view/inputs-panel.js";
import type { ChecklistView } from "../view/checklist-view.js";
import type { PatternCanvas } from "../view/pattern-canvas.js";
import type { FkldMetadataView } from "../view/fkld-metadata-view.js";

export interface KirigamiControllerOptions {
  inputsPanel: InputsPanel;
  checklistView: ChecklistView;
  patternCanvas: PatternCanvas;
  /** Optional metadata panel sourced from the FKLD object. */
  fkldMetadataView?: FkldMetadataView;
  debounceMs?: number;
}

export class KirigamiController {
  private state: KirigamiState | null = null;
  private constraints: ConstraintState[] = [];
  /**
   * Cached FKLD object for the current state. Built once per recompute
   * so the on-screen metadata view and the .fkld download share the
   * same object — there is no second source of truth for what the
   * pattern "is".
   */
  private fkldFile: FkldFile | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(private readonly options: KirigamiControllerOptions) {
    this.debounceMs = options.debounceMs ?? 80;
    options.inputsPanel.setInputs(defaultInputs());
    options.inputsPanel.onChange(() => this.scheduleRecompute());
    this.recompute();
  }

  getState(): KirigamiState | null {
    return this.state;
  }

  getConstraints(): ConstraintState[] {
    return this.constraints;
  }

  /**
   * Export payload (cut/score/both previews + the zip archive + the
   * FKLD JSON download); null if inputs are invalid. The SVG side and
   * the FKLD side are composed here because each helper needs a
   * different view of the model (PatternNet vs. KirigamiState +
   * FoldNet), and keeping the composition in the controller avoids
   * pulling FoldNet into the SVG export module. The FKLD download
   * reuses the FKLD object already cached for the metadata view so
   * we don't rebuild the FoldNet on every Export modal open.
   */
  getExportPayload(): ExportPayload | null {
    if (!this.state) return null;
    const payload = buildExportPayload(buildPatternNet(this.state));
    if (!payload) return null;
    payload.fkld = buildFkldDownload(this.fkldFile ?? this.state);
    return payload;
  }

  /** Latest FKLD object built from the current state (null if invalid). */
  getFkldFile(): FkldFile | null {
    return this.fkldFile;
  }

  recompute(): void {
    const { inputsPanel } = this.options;
    const inputs = inputsPanel.getInputs();
    if (validateInputs(inputs) !== null) {
      this.state = null;
      this.constraints = [];
      this.fkldFile = null;
      this.pushToViews(inputs);
      return;
    }

    this.state = computeState(inputs);
    this.constraints = evaluateConstraints(this.state);
    this.fkldFile = buildFkldFile(this.state);
    this.pushToViews(inputs);
  }

  private scheduleRecompute(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.recompute();
    }, this.debounceMs);
  }

  private pushToViews(inputs: KirigamiInputs): void {
    const { inputsPanel, checklistView, patternCanvas, fkldMetadataView } =
      this.options;
    inputsPanel.render(this.buildInputsPanelModel(inputs));
    checklistView.render(this.constraints);
    patternCanvas.render(
      this.state,
      this.state ? buildPatternNet(this.state) : null,
    );
    fkldMetadataView?.render(this.fkldFile);
  }

  private buildInputsPanelModel(inputs: KirigamiInputs): InputsPanelRenderModel {
    return {
      derived: this.state ? this.buildDerivedFields(this.state) : [],
      apexHeightError: inputs.totalCurvature > 0 ? null : APEX_HEIGHT_ERROR,
      materialThicknessError:
        inputs.materialThickness > 0 ? null : MATERIAL_THICKNESS_ERROR,
    };
  }

  private buildDerivedFields(state: KirigamiState): InputsPanelDerivedField[] {
    return [
      { termHtml: "R", valueText: formatMm(state.R) },
      { termHtml: "s (slant)", valueText: formatMm(state.s) },
      { termHtml: "ψ", valueText: formatAngleDeg(state.psi) },
      { termHtml: "κ", valueText: state.kappa.toFixed(4) },
      { termHtml: "η", valueText: formatAngleDeg(state.eta) },
      { termHtml: "δ<sub>apex</sub>", valueText: formatAngleDeg(state.deltaApex) },
      { termHtml: "θ", valueText: formatAngleDeg(state.theta) },
      { termHtml: "w", valueText: formatMm(state.w) },
      { termHtml: "τ", valueText: formatAngleDeg(state.tau) },
      {
        termHtml: "r<sub>apex</sub> (major cut)",
        valueText: formatMm(state.rApex),
      },
      { termHtml: "minor cut", valueText: formatMm(state.minorCutLength) },
    ];
  }
}

export function createController(
  options: KirigamiControllerOptions,
): KirigamiController {
  return new KirigamiController(options);
}

export type { KirigamiInputs, KirigamiState, ConstraintState };
