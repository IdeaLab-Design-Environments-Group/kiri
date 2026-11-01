/**
 * **View** — the first-run welcome card: a slim dismissible banner above the viewer (in flow, so it never covers a viewer control) with the three
 * ways in (open the house example, choose a model file, open the tutorials).
 *
 * It owns no loading logic. Each action calls something that already exists: the controller's
 * sample loader, the file input of the convert panel, and the tutorials route.
 */
import { el } from "./dom.js";
import { goToRoute } from "./route.js";

const SEEN_KEY = "kiri.welcome.dismissed";

export interface FirstRunActions {
  /** Load the bundled house example (the controller's existing sample loader). */
  openExample: () => void;
  /** Open the file chooser of the convert panel. */
  chooseFile: () => void;
  /** Go to the tutorials page. */
  openTutorials: () => void;
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
export function mountWelcomeCard(host: HTMLElement, actions: FirstRunActions): HTMLElement | null {
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
  text.textContent = "Turn a 3D model into a foldable kirigami sheet.";

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

  close.addEventListener("click", dismiss);
  card.append(
    close,
    title,
    text,
    button("Open the house example", actions.openExample, true),
    button("Choose a model file…", actions.chooseFile),
    button("Watch the tutorials", actions.openTutorials),
  );
  host.prepend(card); // above the iframe, in flow
  return card;
}

/** Wire the card to the existing loaders. The one call `main.ts` makes. */
export function installFirstRun(
  viewerHost: HTMLElement,
  convertHost: HTMLElement,
  controller: { loadSample(announce?: boolean): Promise<void> },
): void {
  mountWelcomeCard(viewerHost, {
    openExample: () => void controller.loadSample(true),
    chooseFile: () => (convertHost.querySelector("input") as HTMLInputElement | null)?.click(),
    openTutorials: () => goToRoute("tutorials"),
  });
}
