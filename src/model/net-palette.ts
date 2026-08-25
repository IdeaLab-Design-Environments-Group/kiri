/**
 * **Model** — what colour a net is drawn in, and the two nets every circuit starts with.
 *
 * Colour is authored data, not a view detail, which is why it lives on {@link Net} and is decided here
 * rather than in the canvas. A net the author has coloured green is green in the sidebar, on the canvas
 * and in anything exported later; a colour minted at draw time would differ between those three the
 * moment one of them re-rendered in a different order.
 *
 * ## Why `pwr` and `gnd` are the ids, and not `n1`/`n2`
 *
 * The bus router already lays two rails and tags their copper with the literal net ids `"pwr"` and
 * `"gnd"`, and the strips SVG export takes a run onto one of its two cut layers by matching those same
 * two strings. Seeding the declared nets under those ids means a wire the author draws between two pads
 * of the declared PWR net lands on the PWR layer instead of being dropped from the file — which is what
 * `unlayeredWires()` in the editor exists to warn about.
 *
 * It does **not** make a declared PWR net the same copper as the bus's PWR rail. `routeDeclaredNets`
 * strikes every corridor node the bus used out of the graph before routing a declared net, so the two
 * are kept apart even when they share a name. That is the conservative reading — it can never short —
 * but it means a part wired to declared PWR is not thereby joined to the battery. Joining them is a
 * router change and is deliberately not made here.
 */
import type { Circuit, Net } from "./electronics.js";

/** The bus router's own tag for the positive rail — see the note above on why the declared net shares it. */
export const PWR_NET_ID = "pwr";
/** The bus router's own tag for the return rail. */
export const GND_NET_ID = "gnd";

/**
 * PWR red and GND black, because that is what the legend, the canvas and every battery in the world
 * already say. These two are pinned rather than drawn from {@link NET_PALETTE}: `.el-tape-pwr` and
 * `.el-tape-gnd` in the stylesheet are these exact values, and a seeded net that disagreed with the
 * copper drawn under it would be the sidebar contradicting the canvas.
 */
export const PWR_COLOUR = "#ff0000";
export const GND_COLOUR = "#222222";

/**
 * Colours for the nets the author adds, in the order they are handed out.
 *
 * Chosen to stay apart from each other *and* from what is already on the canvas — the gold of a pad
 * (`PCB_COLOURS.mask`), the cyan of a designator, the red and black of the two rails. A palette that
 * merely looked pleasant would put a net the same colour as the pads it runs to.
 */
export const NET_PALETTE: readonly string[] = [
  "#1f6feb", // blue
  "#16a34a", // green
  "#9333ea", // purple
  "#0891b2", // teal
  "#db2777", // magenta
  "#65a30d", // olive
  "#7c3aed", // violet
  "#0369a1", // deep blue
  "#15803d", // deep green
  "#a21caf", // plum
];

/**
 * The two nets a circuit starts with: the battery's rails, named the way a schematic names them.
 *
 * Returned fresh each call rather than shared, so a caller that edits one net does not edit the
 * default for every circuit opened afterwards.
 */
export function defaultNets(): Net[] {
  return [
    { id: PWR_NET_ID, name: "PWR", color: PWR_COLOUR },
    { id: GND_NET_ID, name: "GND", color: GND_COLOUR },
  ];
}

/**
 * The next colour to hand out, given the ones already in use.
 *
 * Walks the palette and takes the first colour nobody has, so deleting a net frees its colour rather
 * than leaving a gap that pushes every later net one further down the list. Once the palette is
 * exhausted it wraps by count — with more nets than colours some pair has to share, and sharing in
 * palette order at least keeps neighbours apart.
 */
export function nextNetColour(taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const c of taken) used.add(c.toLowerCase());
  for (const c of NET_PALETTE) {
    if (!used.has(c.toLowerCase())) return c;
  }
  return NET_PALETTE[used.size % NET_PALETTE.length]!;
}

/**
 * The colour to draw a net in — its own, or a stable stand-in derived from its position.
 *
 * A net saved before colours existed has none, and it still has to be drawn. Falling back on the index
 * rather than on one shared "unknown" colour keeps two such nets visually distinct, which is the whole
 * point of colouring them.
 */
export function netColour(net: Net, index = 0): string {
  const own = (net.color ?? "").trim();
  if (own) return own;
  if (net.id === PWR_NET_ID) return PWR_COLOUR;
  if (net.id === GND_NET_ID) return GND_COLOUR;
  return NET_PALETTE[index % NET_PALETTE.length]!;
}

/**
 * The circuit with its nets seeded and coloured, ready to author against.
 *
 * A circuit that has never declared a net gets the two rails; one that already has nets is left alone
 * apart from filling in colours for any that lack one. The distinction matters: re-seeding a circuit
 * whose author had deliberately deleted PWR would put it back on every reload, and the author would
 * have no way to say no.
 *
 * Never mutates its argument — the editor holds circuits as immutable snapshots and rebuilds on edit.
 */
export function withDefaultNets(circuit: Circuit): Circuit {
  const nets = circuit.nets;
  if (!nets || nets.length === 0) {
    return { ...circuit, nets: defaultNets(), terminals: circuit.terminals ?? [] };
  }
  if (nets.every((n) => (n.color ?? "").trim())) return circuit;
  const taken = nets.map((n) => n.color ?? "").filter(Boolean);
  return {
    ...circuit,
    nets: nets.map((n, i) => {
      if ((n.color ?? "").trim()) return n;
      const colour = netColour(n, i) || nextNetColour(taken);
      taken.push(colour);
      return { ...n, color: colour };
    }),
  };
}
