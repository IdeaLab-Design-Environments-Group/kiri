/**
 * **View data** — the models the Examples page offers, grouped by the thing they belong to.
 *
 * One entry per part under `public/examples/`. `slug` is the shared basename of the three files that
 * entry needs: `<slug>.fkld` (the kirigamized pattern the page loads), `previews/<slug>.svg` (the folded
 * form, which is the tile's picture) and `previews/<slug>-flat.svg` (the pattern, shown on hover). All
 * three are written by `scripts/gen-example-previews.ts`, and a test walks this list against the
 * directory — a renamed file is otherwise a broken tile nobody notices until a workshop.
 *
 * **The grouping is the point.** These parts are not twenty-one unrelated models; they are seven objects
 * that come apart — a guitar is a headstock, a neck and two bouts — and a flat list of them buries that.
 * The group is the top level, its parts are the tiles inside it, and the group's `slug` is the prefix its
 * parts' filenames share, which is what makes the pairing checkable rather than a convention to remember.
 *
 * `faces` and `cuts` are read off the pattern that was generated, and the same test re-reads them from
 * the file. They are on the tile because they are the two numbers that say what a model will cost to
 * make: how many tiles the sheet becomes, and how much of it the knife has to travel.
 *
 * Kept apart from `examples-page.ts` for the reason `tutorials-catalog.ts` is kept apart from its page:
 * this is the copy, that is the behaviour.
 */

/** One part of one model: a tile on the page. */
export interface Example {
  slug: string;
  title: string;
  /** One line saying what it is and what its pattern does. */
  blurb: string;
  /** Faces in the kirigamized pattern — the tiles the sheet is cut into. */
  faces: number;
  /** Edges the knife cuts, mountains and valleys excluded. */
  cuts: number;
}

/** A whole object, and the parts it comes apart into. Order here is the order on the page. */
export interface ExampleModel {
  /** The prefix every part's filename starts with. `guitar` ⇒ `guitar-neck.fkld`. */
  slug: string;
  title: string;
  /** One line under the heading saying what the object is. */
  intro: string;
  parts: Example[];
}

export const EXAMPLE_MODELS: ExampleModel[] = [
  {
    slug: "bat",
    title: "bat",
    intro: "A body, two ears and two wings — the most cut-heavy of the set, and the best test of a fold.",
    parts: [
      {
        slug: "bat-body",
        title: "body",
        blurb: "The trunk the ears and wings hang off. Nearly every edge is cut: a dense shell that "
          + "closes from an almost fully severed sheet.",
        faces: 180,
        cuts: 178,
      },
      {
        slug: "bat-ear-left",
        title: "ear, left",
        blurb: "A small cone. Twenty-four tiles is about the floor for a shape that still reads as "
          + "curved once it is up.",
        faces: 24,
        cuts: 22,
      },
      {
        slug: "bat-ear-right",
        title: "ear, right",
        blurb: "The mirror of the left. Kirigamized separately, so the two patterns can be compared "
          + "against each other for symmetry.",
        faces: 24,
        cuts: 22,
      },
      {
        slug: "bat-wing-left",
        title: "wing, left",
        blurb: "A wide, thin membrane: many faces held by comparatively few cuts, which is what lets it "
          + "stay in one piece across its span.",
        faces: 253,
        cuts: 103,
      },
      {
        slug: "bat-wing-right",
        title: "wing, right",
        blurb: "The other wing, at the same face count — the pair folds to a matching sweep.",
        faces: 253,
        cuts: 103,
      },
    ],
  },
  {
    slug: "clock",
    title: "clock",
    intro: "A cased desk clock: a ring to stand on and a body to hold the movement.",
    parts: [
      {
        slug: "clock-base",
        title: "base",
        blurb: "Twenty tiles, every edge cut. The simplest pattern here, and the one to open first to "
          + "see how a sheet becomes a ring.",
        faces: 20,
        cuts: 20,
      },
      {
        slug: "clock-case",
        title: "case",
        blurb: "The drum the face sits in. Cut throughout, so it folds from a sheet that is more slit "
          + "than material.",
        faces: 192,
        cuts: 190,
      },
    ],
  },
  {
    slug: "desk-lamp",
    title: "desk lamp",
    intro: "Two halves of a lamp — the weighted foot and the shade over it.",
    parts: [
      {
        slug: "desk-lamp-base",
        title: "base",
        blurb: "A hundred and twenty tiles with only seventy-eight cuts: much of it folds rather than "
          + "opens, which is what keeps the foot stiff.",
        faces: 120,
        cuts: 78,
      },
      {
        slug: "desk-lamp-shade",
        title: "shade",
        blurb: "The same face count, fully cut. The contrast with the base is the clearest example here "
          + "of what a cut buys you: curvature.",
        faces: 120,
        cuts: 120,
      },
    ],
  },
  {
    slug: "drums",
    title: "drum kit",
    intro: "Three shells at three sizes, so a pattern can be watched as the same form scales.",
    parts: [
      {
        slug: "drums-bass",
        title: "bass drum",
        blurb: "The largest shell: a wide cylinder whose pattern is a long band of tiles.",
        faces: 154,
        cuts: 104,
      },
      {
        slug: "drums-tom-high",
        title: "tom, high",
        blurb: "The small tom. Nearly the bass drum's pattern at a shorter span — the same shape, fewer "
          + "tiles around.",
        faces: 144,
        cuts: 98,
      },
      {
        slug: "drums-tom-low",
        title: "tom, low",
        blurb: "The deeper tom, two cuts more than the high one: the depth is what the extra cuts buy.",
        faces: 144,
        cuts: 100,
      },
    ],
  },
  {
    slug: "guitar",
    title: "guitar",
    intro: "A guitar in four pieces — the two bouts of the body, the neck between them, and the head.",
    parts: [
      {
        slug: "guitar-headstock",
        title: "headstock",
        blurb: "The flat head with its taper. Ninety tiles, cut almost throughout.",
        faces: 90,
        cuts: 88,
      },
      {
        slug: "guitar-neck",
        title: "neck",
        blurb: "Forty tiles: a long, gently curved strip, and the quickest of the four to cut.",
        faces: 40,
        cuts: 38,
      },
      {
        slug: "guitar-upper-bout",
        title: "upper bout",
        blurb: "The shoulder of the body, where the neck meets it.",
        faces: 100,
        cuts: 98,
      },
      {
        slug: "guitar-lower-bout",
        title: "lower bout",
        blurb: "The wide half of the body — the largest single curve in the model.",
        faces: 130,
        cuts: 128,
      },
    ],
  },
  {
    slug: "teapot",
    title: "teapot",
    intro: "The Utah teapot, taken apart: the body it is famous for, plus a spout and a handle.",
    parts: [
      {
        slug: "teapot-body",
        title: "body",
        blurb: "Two hundred and seventy-six tiles, and the doubly curved surface the whole pipeline was "
          + "written for. Its flat pattern is a pair of spirals.",
        faces: 276,
        cuts: 250,
      },
      {
        slug: "teapot-spout",
        title: "spout",
        blurb: "Sixteen tiles. Small, sharply curved, and a good check that a tight radius still unrolls.",
        faces: 16,
        cuts: 16,
      },
      {
        slug: "teapot-handle-solid",
        title: "handle",
        blurb: "The handle as a solid loop: thirty-eight tiles, thirty-two of them cut apart.",
        faces: 38,
        cuts: 32,
      },
    ],
  },
  {
    slug: "thermometer",
    title: "thermometer",
    intro: "A bulb and the tube above it — a sphere and a long cylinder, side by side.",
    parts: [
      {
        slug: "thermometer-bulb",
        title: "bulb",
        blurb: "A sphere, cut through: the pattern opens into petals and closes back into a ball.",
        faces: 144,
        cuts: 142,
      },
      {
        slug: "thermometer-tube",
        title: "tube",
        blurb: "Two hundred and seventy-six tiles held by only a hundred and two cuts — a developable "
          + "surface needs far less opening than the bulb beneath it.",
        faces: 276,
        cuts: 102,
      },
    ],
  },
];

/** Every part, in page order — the list both the page and its test walk. */
export function allExamples(): Example[] {
  return EXAMPLE_MODELS.flatMap((m) => m.parts);
}
