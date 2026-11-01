/**
 * **View** — the header's vocabulary in one place: the sentence-case label of every header button and
 * a `title` tooltip saying what it does and what it needs.
 *
 * Applied once after the buttons are mounted, matching each button by its label (case-insensitive,
 * trailing arrows ignored). This is what lets the Electronics button, whose module is not edited for
 * copy, share the same vocabulary as the rest.
 */
export interface HeaderCopy {
  label: string;
  title: string;
}

export const HEADER_COPY: readonly HeaderCopy[] = [
  { label: "Simulate", title: "Fold the pattern in 3D. Needs a pattern: press Cut & fold first." },
  { label: "Export", title: "Save the cut-and-score SVG or STL tiles. Needs a pattern: press Cut & fold first." },
  { label: "Pattern editor", title: "Draw a pattern grid by hand." },
  {
    label: "Electronics",
    title: "Place LEDs and route copper tape on the pattern. Needs a pattern: press Cut & fold first.",
  },
  { label: "Examples", title: "Open one of the bundled models, already cut and ready to fold." },
  { label: "Tutorials", title: "Short screen recordings of every part of kiri." },
  { label: "Create pyramid", title: "Generate a pyramid pattern. Needs nothing loaded." },
  { label: "Cut & fold", title: "Turn the loaded mesh into a cut-and-fold pattern. Needs a mesh: drop a model first." },
];

function key(text: string): string {
  return text.replace(/[▶\s]+$/u, "").trim().toLowerCase();
}

/** Give every button in `header` its canonical label and tooltip. Unknown buttons are left alone. */
export function applyHeaderCopy(header: HTMLElement): void {
  const children = Array.from((header?.children ?? []) as unknown as ArrayLike<HTMLElement>);
  for (const button of children) {
    const copy = HEADER_COPY.find((c) => key(c.label) === key(button.textContent ?? ""));
    if (!copy) continue;
    button.textContent = copy.label;
    button.title = copy.title;
  }
}
