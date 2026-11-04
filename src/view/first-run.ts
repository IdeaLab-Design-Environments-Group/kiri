/**
 * **View** — the first-run welcome card: a slim dismissible banner above the viewer (in flow, so it never covers a viewer control) with the ways in
 * (what to do next with what is open, choose a model file, open the tutorials).
 *
 * It follows what is loaded. It used to be fixed text whose main button read "Open the house example", while the
 * house pattern was already open on first paint and the Model column said so: the one thing on screen that
 * contradicted the rest. Now, with a pattern open it says so and offers Simulate; with a 3D mesh open it points at
 * Cut & fold; with nothing open (for example when the sample could not be fetched) it still offers the house.
 *
 * It owns no loading logic. Each action calls something that already exists: the controller's sample loader, the
 * file input of the model panel, the Simulate dialog, and the tutorials route.
 */
import { el } from "./dom.js";
import { goToRoute } from "./route.js";

const SEEN_KEY = "kiri.welcome.dismissed";

export interface FirstRunActions {
  /** Load the bundled house example (the controller's existing sample loader). */
  openExample: () => void;
  /** Open the file chooser of the model panel. */
  chooseFile: () => void;
  /** Open the Simulate dialog. */
  openSimulate: () => void;
  /** Go to the tutorials page. */
  openTutorials: () => void;
}

/** What is open, as far as the card cares. */
export type WelcomeState =
  | { kind: "none" }
  | { kind: "pattern"; name: string; canSimulate: boolean }
  | { kind: "mesh"; name: string };

export interface WelcomeCard {
  element: HTMLElement;
  /** Say the right thing for what is open now. */
  update(state: WelcomeState): void;
}

function wasDismissed(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Private mode: the card simply comes back next visit.
  }
}

/** Build the card and mount it in `host`. Returns null if the visitor already dismissed it. */
export function mountWelcomeCard(host: HTMLElement, actions: FirstRunActions): WelcomeCard | null {
  if (wasDismissed()) return null;
  const card = el("aside", "welcome-card");
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "Welcome");

  const close = el("button", "welcome-close") as HTMLButtonElement;
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss welcome");
  close.title = "Dismiss";
  close.textContent = "×";

  const title = el("h2", "welcome-title");
  title.textContent = "Welcome to kiri";
  const text = el("p", "welcome-text");

  const dismiss = (): void => {
    remember();
    card.hidden = true;
  };
  const button = (label: string, run: () => void, primary = false): HTMLButtonElement => {
    const b = el("button", primary ? "welcome-action welcome-primary" : "welcome-action") as HTMLButtonElement;
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      run();
      dismiss();
    });
    return b;
  };

  // The first button is the one that changes with what is open; the other two always apply.
  let primaryAction: () => void = actions.openExample;
  const primary = button("Open the house example", () => primaryAction(), true);
  const choose = button("Choose a model file…", actions.chooseFile);
  const tutorials = button("Watch the tutorials", actions.openTutorials);

  const update = (state: WelcomeState): void => {
    if (state.kind === "pattern") {
      text.textContent = state.canSimulate
        ? `${state.name} is open. Press Simulate to see it fold, or drop your own 3D model on the left.`
        : `${state.name} is open. Drop your own 3D model on the left to make a new pattern.`;
      primary.textContent = "Simulate";
      primaryAction = actions.openSimulate;
      primary.hidden = !state.canSimulate;
    } else if (state.kind === "mesh") {
      text.textContent = `${state.name} is loaded. Press Cut & fold on the left to turn it into a pattern.`;
      primary.hidden = true;
    } else {
      text.textContent = "Turn a 3D model into a foldable kirigami sheet.";
      primary.textContent = "Open the house example";
      primaryAction = actions.openExample;
      primary.hidden = false;
    }
  };
  update({ kind: "none" });

  close.addEventListener("click", dismiss);
  card.append(close, title, text, primary, choose, tutorials);
  host.prepend(card); // above the iframe, in flow
  return { element: card, update };
}

/** What the card needs to know about the app: the store to follow, and whether Simulate can run. */
export interface FirstRunContext {
  store: { subscribe(listener: (state: { model: import("../model/fold-file.js").LoadedModel | null }) => void): unknown };
  /** Open the Simulate dialog. */
  simulate: () => void;
  /** Whether the Simulate button is on for what is open. */
  canSimulate: () => boolean;
}

/** Wire the card to the existing loaders and to what is loaded. The one call `main.ts` makes. */
export function installFirstRun(
  viewerHost: HTMLElement,
  convertHost: HTMLElement,
  controller: { loadSample(announce?: boolean): Promise<void> },
  context?: FirstRunContext,
): void {
  const card = mountWelcomeCard(viewerHost, {
    openExample: () => void controller.loadSample(true),
    chooseFile: () => (convertHost.querySelector("input") as HTMLInputElement | null)?.click(),
    openSimulate: () => context?.simulate(),
    openTutorials: () => goToRoute("tutorials"),
  });
  if (!card || !context) return;
  context.store.subscribe(({ model }) => {
    if (!model) card.update({ kind: "none" });
    else if (model.kind === "fold") card.update({ kind: "pattern", name: model.name, canSimulate: context.canSimulate() });
    else card.update({ kind: "mesh", name: model.name });
  });
}
