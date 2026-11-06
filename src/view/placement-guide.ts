/**
 * **View** — what the electronics editor tells someone who has not placed anything yet (issue #57).
 *
 * The default tool places an LED across the nearest fold, and nothing on an empty page said so: the only
 * text was a status line of zero counts. The first step is written on the canvas, where the eye already
 * is, and it names the Seat control because Seat is what decides where an LED can go. It comes down as
 * soon as anything is on the sheet.
 *
 * Kept out of `electronics-modal.ts`, which holds the listeners: this is a sentence and a toggle.
 */
import type { Circuit } from "../model/electronics.js";

/** Where a tap seats an LED or a part: across the nearest fold, or on the tile under it. */
export type PlaceMode = "gap" | "free";

/** The first step, for the Seat setting in force. */
export function firstStep(mode: PlaceMode): string {
  return mode === "free"
    ? "Tap a tile to place an LED, then pick battery and tap a tile. " +
      "Seat › across a fold puts an LED across a hinge instead."
    : "Tap near a fold to place an LED, then pick battery and tap a tile. " +
      "Seat › on a tile puts an LED anywhere on a tile instead.";
}

/** Whether the sheet is still empty: no LED, battery, part or hand-drawn wire of any kind. */
export function nothingPlaced(circuit: Circuit): boolean {
  return !circuit.leds.length && !circuit.battery && !(circuit.parts ?? []).length &&
    !(circuit.resistors ?? []).length && !(circuit.switches ?? []).length && !(circuit.wires ?? []).length;
}

/** Show the first step on an empty sheet, in the words for the Seat in force, and hide it otherwise. */
export function syncFirstStep(
  el: { hidden: boolean; textContent: string | null } | null | undefined,
  circuit: Circuit,
  mode: PlaceMode,
): void {
  if (!el) return;
  el.hidden = !nothingPlaced(circuit);
  if (!el.hidden) el.textContent = firstStep(mode);
}
