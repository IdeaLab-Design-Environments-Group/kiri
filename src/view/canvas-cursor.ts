/**
 * **View** — a keyboard cursor for the electronics canvas (issue #64).
 *
 * Placing was pointer-only: the canvas was not focusable, so a keyboard could arm the LED tool and then do
 * nothing with it. This is the keyboard's pointer. When the canvas has focus a cursor sits on the pattern;
 * the arrow keys move it (Shift for bigger steps), and Enter or Space is a tap where it is — the very same
 * tap a pointer makes, so an LED lands on the fold the cursor lights, the battery on the tile under it,
 * and a wire point wherever it is. Escape is handed back to the editor, which uses it to put a selection
 * down.
 *
 * The cursor lives in the canvas's world space — the SVG viewBox — rather than in pattern units, so Right
 * is right on screen whatever the mirror toggles have done to the drawing. It is kept inside the visible
 * window, so it can never be walked somewhere the author cannot see it.
 *
 * Kept out of `electronics-modal.ts`: the modal owns the canvas and what a tap means, this owns where the
 * keyboard's tap is.
 */
import type { Vec2 } from "../model/electronics.js";

/** What the cursor needs of the canvas it moves on. All points are world (viewBox) coordinates. */
export interface CursorHost {
  /** The window of the canvas on screen. */
  view(): { x: number; y: number; w: number; h: number };
  /** Where a newly focused cursor starts: the middle of the pattern. */
  home(): Vec2;
  /** A tap at this point, exactly as a pointer would make it. */
  tap(at: Vec2): void;
  /** One short sentence on what is under the cursor and what Enter would do there. */
  describe(at: Vec2): string;
  /** Extra marks to draw under the cursor (the fold a tap would seat on), as SVG markup. */
  marks(at: Vec2): string;
  /** The group the cursor is drawn into, and the line it is described in. Re-read on every paint. */
  layer(): { innerHTML: string } | null;
  say(text: string): void;
}

/** Arrow steps across the visible window: fine enough to land on a fold, few enough to cross the sheet. */
const STEPS_ACROSS = 60;
/** How much further a Shift+arrow goes. */
const BIG_STEP = 6;

const MOVES: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

export class CanvasCursor {
  /** Where the cursor is, or was when the canvas last had focus. */
  private at: Vec2 | null = null;
  private shown = false;

  constructor(private readonly host: CursorHost) {}

  /** Where the cursor is, or null while the canvas does not have focus. */
  where(): Vec2 | null {
    return this.shown ? this.at : null;
  }

  /** One arrow press, in world units. */
  step(): number {
    return this.host.view().w / STEPS_ACROSS;
  }

  /** The canvas took focus: put the cursor up, where it was last if that is still in view. */
  show(): void {
    this.shown = true;
    this.at = this.clamp(this.at ?? this.host.home());
    this.paint();
  }

  /** The canvas lost focus: take the cursor down, but remember where it was. */
  hide(): void {
    this.shown = false;
    this.paint();
  }

  /**
   * A key pressed while the canvas has focus. Answers whether it was the cursor's.
   *
   * Only the arrows, Enter and Space. Everything else — R, Delete, Escape, the wire tool's keys — is the
   * editor's, and falls through to it.
   */
  onKey(e: { key: string; shiftKey?: boolean; preventDefault?(): void }): boolean {
    if (!this.shown) this.show();
    const move = MOVES[e.key];
    if (move) {
      const d = this.step() * (e.shiftKey ? BIG_STEP : 1);
      this.at = this.clamp({ x: this.at!.x + move[0] * d, y: this.at!.y + move[1] * d });
      e.preventDefault?.(); // or the page scrolls under the cursor
      this.paint();
      return true;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault?.();
      this.host.tap(this.at!);
      this.paint();
      return true;
    }
    return false;
  }

  /** Redraw the cursor — after a move, and after the canvas has repainted underneath it. */
  paint(): void {
    const layer = this.host.layer();
    const at = this.where();
    if (!at) {
      if (layer) layer.innerHTML = "";
      this.host.say("");
      return;
    }
    const v = this.host.view();
    const r = Math.min(v.w, v.h) / 40;
    if (layer) {
      layer.innerHTML = this.host.marks(at) +
        `<g class="el-cursor-mark">` +
        `<circle cx="${at.x}" cy="${at.y}" r="${r}" />` +
        `<path d="M${at.x - 2 * r} ${at.y}H${at.x + 2 * r}M${at.x} ${at.y - 2 * r}V${at.y + 2 * r}" />` +
        `</g>`;
    }
    this.host.say(this.host.describe(at));
  }

  /** Keep a point inside the visible window. */
  private clamp(p: Vec2): Vec2 {
    const v = this.host.view();
    return {
      x: Math.min(v.x + v.w, Math.max(v.x, p.x)),
      y: Math.min(v.y + v.h, Math.max(v.y, p.y)),
    };
  }
}

/** What is under the cursor, as {@link describeSpot} reads it. */
export interface Spot {
  /** The tool armed: `led`, `battery`, `wire`, or a library part's name. */
  tool: string;
  /** Whether parts go across a fold (`gap`) or on a tile (`free`). */
  mode: "gap" | "free";
  /** The placed part under the cursor, by its label, if any. */
  onPart: string | null;
  /** Whether a fold is in reach, so a tap would seat across it. */
  onFold: boolean;
  /** Whether the cursor is over the sheet at all. */
  onTile: boolean;
}

/** One sentence for the cursor's live region: where it is, and what Enter would do there. */
export function describeSpot(s: Spot): string {
  if (s.tool === "wire") {
    return s.onTile
      ? "On the sheet. Space lays a wire point here; Enter finishes the wire."
      : "Off the sheet. Move onto the pattern to lay a wire point.";
  }
  if (s.onPart) return `On ${s.onPart}. Enter picks it up; then R turns it and Delete removes it.`;
  if (s.tool === "battery") {
    return s.onTile ? "On a tile. Enter puts the battery here." : "Off the sheet. Move onto a tile for the battery.";
  }
  const what = s.tool === "led" ? "an LED" : s.tool;
  if (s.mode === "gap") {
    if (s.onFold) return `On a fold. Enter places ${what} across it.`;
    return s.onTile ? "On a tile, away from every fold. Move closer to a fold to place across it." : "Off the sheet.";
  }
  return s.onTile ? `On a tile. Enter places ${what} here.` : "Off the sheet. Move onto a tile.";
}
