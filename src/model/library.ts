/**
 * **Model** — the component library, as one lookup.
 *
 * Everything that resolves a `Component.id` goes through here. Before this existed there were three
 * separate lookups — one in the router, one in the cut files, one in the netlist — and every one of them
 * searched `COMPONENTS` alone, the eagerly-loaded half. The palette merged in `REST_COMPONENTS` and nothing
 * else did, so a part from the other half could be offered, chosen and placed, and then silently fail to
 * resolve everywhere that mattered.
 *
 * That was survivable only by accident. The generator split the library on `placement()` — can a rail pass
 * through this part — so the lazy half was exactly the parts nothing could route anyway, and the coupling
 * had no way to show itself. {@link netPlacement} ends that: with nets, a part is a set of pads to wire
 * rather than something a rail passes through, so all 129 parts are placeable and 92 of them were in the
 * half the router cannot see.
 *
 * So the split is gone. It cost about 21kB gzipped on first load and bought a class of bug where the app
 * offers a part it cannot wire, which is not a trade worth keeping. The two generated modules remain as
 * they are — regenerating them is the generator's business, not this file's — and this joins them.
 */
import { COMPONENTS, type Component } from "./footprints.generated.js";
import { REST_COMPONENTS } from "./footprints.rest.generated.js";
import type { Footprint } from "./footprint.js";

/**
 * The handful of parts the UI names outright — a default battery, resistor and switch for the toolbar.
 *
 * Re-exported here rather than imported from the generated module directly, so that "everything that
 * resolves a part goes through this file" is true of constants as well as of lookups. A view reaching
 * past this facade into `footprints.generated.js` also silently depends on which *half* of the generated
 * split a part landed in, which is the generator's business and has changed before.
 */
export { BAT_COIN_20, R_1206, SW_SPDT } from "./footprints.generated.js";

/** Every part in the library, both halves of the generated split. */
export const LIBRARY: Component[] = [...COMPONENTS, ...REST_COMPONENTS];

const BY_ID = new Map(LIBRARY.map((c) => [c.id, c]));

/** One part by its `Component.id`, or undefined. */
export function componentById(id: string): Component | undefined {
  return BY_ID.get(id);
}

/** One part's footprint by id — the common case, since most callers want only the pads. */
export function footprintById(id: string): Footprint | undefined {
  return BY_ID.get(id)?.footprint;
}
