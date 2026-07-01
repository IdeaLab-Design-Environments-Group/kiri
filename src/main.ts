/**
 * Composition root. Wires the Kirigamizer shell together in classic MVC:
 *
 *   Model       src/model/   — AppStore (observable UI state) + derive-facts presenter;
 *                              the simulation domain model lives under src/sim/.
 *   View        src/view/    — ConvertPanel · ViewerFrame · HeaderActions ·
 *                              SimModal. Dumb: render state, emit user intents.
 *   Controller  src/controller/ — AppController: file IO/parsing, the kirigamize/sample
 *                              actions, and the store↔view subscription.
 *
 * This file owns no behavior beyond construction and mounting.
 */
import "./styles.css";
import { AppStore } from "./model/app-store.js";
import { ConvertPanel } from "./view/convert-panel.js";
import { ViewerFrame } from "./view/viewer-frame.js";
import { installResizableLayout } from "./view/layout.js";
import { HeaderActions } from "./view/header-actions.js";
import { SimModal } from "./view/sim-modal.js";
import { ExportModal } from "./view/export-modal.js";
import { PatternEditorModal } from "./view/pattern-editor-modal.js";
import { ElectronicsModal } from "./view/electronics-modal.js";
import { AppController } from "./controller/app-controller.js";

const app = document.getElementById("app");
if (!app) throw new Error("Missing #app root");

// ---- Model ----------------------------------------------------------------
const store = new AppStore();

// ---- Views (two columns + header actions + sim modal) ---------------------
const convert = new ConvertPanel();
const viewer = new ViewerFrame();
app.append(convert.element, viewer.element);
installResizableLayout(app, convert.element, viewer.element);

const simModal = new SimModal();
const exportModal = new ExportModal();
const patternEditor = new PatternEditorModal();
const electronics = new ElectronicsModal();
const header = new HeaderActions();
simModal.mountTrigger(header.element); // 3D Sim trigger first…
exportModal.mountTrigger(header.element); // …then Export SVG…
patternEditor.mountTrigger(header.element); // …then Pattern editor (secondary design path)…
electronics.mountTrigger(header.element); // …then Electronics (LED copper-tape routing)…
header.appendActionButtons(); // …then Create / Load sample / Kirigamize ▶
document.querySelector(".app-header")?.appendChild(header.element);

// ---- Controller -----------------------------------------------------------
const controller = new AppController(store, convert, viewer, header, simModal, exportModal, patternEditor, electronics);

// Default state: load the bundled FKLD example so the panels, viewer, and 3D
// Sim are all live on first paint (no-op under file:// where fetch is blocked).
void controller.loadSample(false);
