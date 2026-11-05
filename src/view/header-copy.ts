/**
 * **View** — the header's vocabulary in one place: the sentence-case label of every header button and
 * a `title` tooltip saying what it does and, only while the button is disabled, what it needs.
 *
 * Applied once after the buttons are mounted, matching each button by its label (case-insensitive,
 * trailing arrows ignored). The buttons may sit directly in `header` or one level down, in its groups. This is what lets the Electronics button, whose module is not edited for
 * copy, share the same vocabulary as the rest.
 */
export interface HeaderCopy {
  label: string;
  title: string;
  /** Said only while the button is disabled. */
  needs?: string;
}

const PATTERN = "Needs a pattern: load a pattern file, or Cut & fold a 3D model first.";

export const HEADER_COPY: readonly HeaderCopy[] = [
  { label: "Simulate", title: "Fold the pattern in 3D.", needs: PATTERN },
  { label: "Export", title: "Save the cut-and-score SVG or STL tiles.", needs: PATTERN },
  { label: "Electronics", title: "Place LEDs and route copper tape on the pattern.", needs: PATTERN },
  { label: "Examples", title: "Open one of the bundled models, already cut and ready to fold." },
  { label: "Tutorials", title: "Short screen recordings of every part of kiri." },
];

function key(text: string): string {
  return text.replace(/[▶\s]+$/u, "").trim().toLowerCase();
}

/**
 * Give every button in `header` its canonical label and a tooltip that follows its enabled state.
 * Safe to call again after each state change. Unknown buttons are left alone.
 */
export function applyHeaderCopy(header: HTMLElement): void {
  const top = Array.from((header?.children ?? []) as unknown as ArrayLike<HTMLElement>);
  const buttons = top.flatMap((child) =>
    child.tagName?.toLowerCase() === "button" ? [child] : Array.from((child.children ?? []) as unknown as ArrayLike<HTMLElement>),
  );
  for (const button of buttons) {
    const copy = HEADER_COPY.find((c) => key(c.label) === key(button.textContent ?? ""));
    if (!copy) continue;
    button.textContent = copy.label;
    if (button.getAttribute("aria-busy") === "true") {
      button.title = "Working… the button comes back when the pattern is ready.";
      continue;
    }
    button.title = (button as HTMLButtonElement).disabled && copy.needs ? `${copy.title} ${copy.needs}` : copy.title;
  }
}
