/**
 * Where keyboard focus goes when something opens over the model, and where it goes back to.
 *
 * Without this, opening a dialog left focus on the button that opened it, so Tab walked through the header
 * *behind* the dialog (19 of 25 presses, measured), and closing it dropped focus on the page body. The dialogs
 * already carry `role="dialog"` and `aria-modal`, which tell a screen reader the page behind is out of reach;
 * this makes the keyboard match.
 *
 * Two shapes, after the WAI-ARIA Authoring Practices:
 *
 *  - a **dialog** (Simulate, Export, the pattern editor) is modal: focus moves in, Tab and Shift+Tab stay inside
 *    it, and closing returns focus to whatever opened it;
 *  - a **page** (Electronics, Examples, Tutorials) is not modal, as the header stays usable beside it: focus
 *    moves in when it opens and back to its header button when it closes, with no trap.
 *
 * Escape is the dialogs' own business and is left alone. The pages deliberately do not leave on Escape (see
 * the note in `electronics-modal.ts`: a stray Escape must not drop a half-made circuit).
 *
 * The test DOM has no `activeElement` and no `focus()`, so every step quietly does nothing there.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** What can take focus inside `root` right now: enabled, and actually laid out (not `display: none`). */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll?.<HTMLElement>(FOCUSABLE) ?? []);
  return all.filter((el) => !el.hidden && (el.getClientRects?.().length ?? 1) > 0);
}

function activeElement(): Element | null {
  return typeof document === "undefined" ? null : (document.activeElement ?? null);
}

/** Give focus back to `el` if it is still there to take it. */
function restore(el: HTMLElement | null): void {
  if (!el || !el.isConnected || (el as HTMLButtonElement).disabled) return;
  el.focus?.();
}

export interface FocusOptions {
  /** What to focus on entry. Defaults to the first focusable thing inside. */
  initial?: HTMLElement | null;
  /** Keep Tab inside `root` while it is open: for a modal dialog, not for a page. */
  trap?: boolean;
}

/**
 * Move focus into `root` and, when asked, hold it there. Returns a function that undoes it: it releases the
 * trap and puts focus back on `opener`.
 *
 * Call it just after `root` is shown (it measures what is visible), and call the function it returns when
 * `root` is hidden again. Safe to call the returned function twice.
 */
export function enterFocusScope(root: HTMLElement, opener: HTMLElement | null, options: FocusOptions = {}): () => void {
  const first = options.initial ?? focusableWithin(root)[0] ?? null;
  first?.focus?.();

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "Tab") return;
    const items = focusableWithin(root);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const firstItem = items[0]!;
    const lastItem = items[items.length - 1]!;
    const active = activeElement();
    if (!active || !root.contains(active)) {
      e.preventDefault(); // focus got out (a click on the page behind): bring it back in
      firstItem.focus();
    } else if (e.shiftKey && active === firstItem) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && active === lastItem) {
      e.preventDefault();
      firstItem.focus();
    }
  };

  const trap = options.trap === true && typeof document !== "undefined";
  // On the document, in the capture phase: when focus has dropped to the body, the dialog never sees the key.
  if (trap) document.addEventListener?.("keydown", onKeydown, true);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (trap) document.removeEventListener?.("keydown", onKeydown, true);
    restore(opener);
  };
}
