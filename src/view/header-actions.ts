/**
 * **View** — the header's navigation: two groups of triggers, and nothing else. It holds no app state and
 * emits no intents; each trigger belongs to the page or dialog it opens, and is mounted here by `main.ts`.
 *
 *  - **workflow**: Simulate, Electronics, Export. What you do with the pattern once you have one, in the order
 *    you would come to them: look at it fold, put a circuit on it, send it to be made.
 *  - **library**: Examples and Tutorials. Where to find a model and how to use the app, which are not steps
 *    of the work, so they sit apart and are drawn quieter.
 *
 * "Cut & fold" used to be the last button here, drawn in blue on every page. It acts on the loaded model, so
 * it moved to the Model column beside the file (see `convert-panel.ts`). "Load sample" and "Create pyramid"
 * left the header earlier: the first now lives in the viewer, the second was removed.
 */
import { el } from "./dom.js";

export class HeaderActions {
  readonly element: HTMLElement;
  /** Simulate, Electronics, Export. */
  readonly workflow: HTMLElement;
  /** Examples, Tutorials. */
  readonly library: HTMLElement;

  constructor() {
    this.element = el("div", "header-actions");
    this.workflow = el("nav", "header-group header-flow");
    this.workflow.setAttribute("aria-label", "Workflow");
    this.library = el("nav", "header-group header-library");
    this.library.setAttribute("aria-label", "Examples and help");
    this.element.append(this.workflow, this.library);
  }
}
