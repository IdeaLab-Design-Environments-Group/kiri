/**
 * **View data** — what the tutorials page shows, and in what order.
 *
 * One entry per screen recording under `public/tutorials/`. `slug` is the shared basename of the pair
 * of files that entry needs: `<slug>.mp4` (the clip) and `<slug>.jpg` (its poster frame, so the grid
 * paints without downloading a single video). A test walks this list against the directory, because a
 * renamed clip is otherwise a broken card nobody notices until a workshop.
 *
 * Kept apart from `tutorials-page.ts` for the reason `electronics-shell.ts` is kept apart from its
 * modal: this is the copy, that is the behaviour, and the person editing a blurb should not have to
 * read a DOM builder to find it.
 */

/** One recording: a title, a sentence saying what it shows, and the basename of its two files. */
export interface Tutorial {
  slug: string;
  title: string;
  blurb: string;
}

/** A run of tutorials under one heading. Order here is the order on the page. */
export interface TutorialSection {
  title: string;
  /** One line under the heading saying what this run of clips covers. */
  intro: string;
  items: Tutorial[];
}

export const TUTORIAL_SECTIONS: TutorialSection[] = [
  {
    title: "getting around",
    intro: "The model page: loading something to work on, and looking at it.",
    items: [
      {
        slug: "import-a-model",
        title: "import a model",
        blurb:
          "Drop an STL, OBJ, FOLD or FKLD file onto the Convert panel — or pick one with the file "
          + "chooser — and it loads into the FKLD viewer beside it.",
      },
      {
        slug: "using-top-bar-on-main-page",
        title: "use the top bar",
        blurb:
          "What each header button is for: Simulation & Routing, Export, Pattern editor, Electronics, "
          + "Create pyramid, Load sample and cut&fold ▶.",
      },
      {
        slug: "adjust-zoom-and-viewing-axis-main-page",
        title: "zoom and viewing axis",
        blurb:
          "Zoom the viewer and change the axis you look down, so a flat pattern or a folded form sits "
          + "square on screen.",
      },
      {
        slug: "alternate-between-folded-and-unfolded-version-in-main-page",
        title: "folded and unfolded",
        blurb:
          "The viewer's Shape toggle swaps the flat crease pattern for the folded form of the same "
          + "model, without touching the file.",
      },
      {
        slug: "viewing-fkld-stored-properties-of-model",
        title: "read what the FKLD file stores",
        blurb:
          "Vertices, edges, faces and their assignments are all in the file. The viewer's layers and "
          + "panels are how you read them back.",
      },
    ],
  },
  {
    title: "making a pattern",
    intro: "From a mesh — or from nothing — to a crease pattern you can fold.",
    items: [
      {
        slug: "creating-pyriamid-model-base-for-simulation",
        title: "create a pyramid",
        blurb:
          "Create pyramid builds the AKDE pyramid from the creation pipeline: the small, well-behaved "
          + "model to try the simulator and the router on first.",
      },
      {
        slug: "kirigamize-a-model",
        title: "kirigamize a model",
        blurb: "cut&fold ▶ turns the loaded mesh into a cut-and-fold kirigami pattern.",
      },
      {
        slug: "adjust-relief-width-and-face-detail-in-3d",
        title: "relief width and face detail",
        blurb:
          "Gap sets how wide the bare hinge between printed tiles is; Detail sets how deep the sharpest "
          + "folds are subdivided. Finer tiles leave narrower gaps, so the model folds further.",
      },
    ],
  },
  {
    title: "folding it in 3D",
    intro: "The same design, folded as either of the two builds kiri makes.",
    items: [
      {
        slug: "folding-3d-modality",
        title: "fold the 3D-printed build",
        blurb:
          "Simulation & Routing folds the tiled build — rigid tiles with a bare hinge gap, which is what "
          + "stops it closing flat.",
      },
      {
        slug: "simulate-vinyl-version-of-model",
        title: "fold the vinyl build",
        blurb: "The same design folded as one continuous sheet, scored at the creases rather than cut.",
      },
    ],
  },
  {
    title: "electronics: getting in",
    intro:
      "Where the copper is laid: which build it is for, and which face of the design it goes on.",
    items: [
      {
        slug: "navigate-to-electronics-interface",
        title: "open the electronics editor",
        blurb: "Electronics is a page of its own, at its own URL — the Back control returns to the model.",
      },
      {
        slug: "switch-between-vinyl-and-3d-in-elec",
        title: "route on vinyl or on tiles",
        blurb:
          "The Build segment draws and routes whichever build the simulator folds — one scored sheet, or "
          + "rigid tiles with gaps between them.",
      },
      {
        slug: "alternate-between-the-inside-and-outside-faces-of-a-design",
        title: "inside and outside copper",
        blurb: "Each face carries its own circuit. Side switches which one you are editing.",
      },
    ],
  },
  {
    title: "electronics: placing parts",
    intro:
      "Finding a component, seating it on the sheet, and turning it once it is there.",
    items: [
      {
        slug: "navigate-and-open-components-menu",
        title: "find a part in the library",
        blurb: "Search the component library by name or by package, then place what you picked.",
      },
      {
        slug: "add-parts-across-a-fold-or-on-a-tile",
        title: "seat a part across a fold, or on a tile",
        blurb:
          "Across a fold bridges the hinge with a pad on each side; On a tile stands the part where you "
          + "put it and wires its pads by net or by hand.",
      },
      {
        slug: "rotatebypressingr",
        title: "rotate a part with R",
        blurb: "With a part selected, R turns it on the sheet.",
      },
    ],
  },
  {
    title: "electronics: nets and copper",
    intro:
      "What is joined to what, and the copper the router lays to do it.",
    items: [
      {
        slug: "creating-nets",
        title: "declare a net",
        blurb: "Names are yours — PWR, GND, SDA. A net exists as soon as you name it.",
      },
      {
        slug: "assigning-nets",
        title: "put a pad on a net",
        blurb: "Wiring is assignment: a pad joins a net, and the router works out the copper.",
      },
      {
        slug: "autoroute",
        title: "route the copper",
        blurb:
          "Route re-plans the copper now; Auto re-plans on every edit that moves it. Manual leaves the "
          + "last plan on the canvas while you work.",
      },
    ],
  },
  {
    title: "electronics: the whole sheet",
    intro:
      "The two controls that act on the design entire, rather than on one part of it.",
    items: [
      {
        slug: "switch-between-strips-and-carriers",
        title: "strips and carriers",
        blurb:
          "The Copper group draws the same circuit two ways — as bare tape strips, or as the parts on a "
          + "carrier frame — and each is exported on its own.",
      },
      {
        slug: "mirror-designs-according-to-needs",
        title: "mirror the design",
        blurb:
          "Mirror flips the whole sheet left–right or top–bottom, for when the copper has to go on from "
          + "the other side.",
      },
    ],
  },
  {
    title: "getting it made",
    intro: "The files a cutter, a printer or a pick-and-place actually needs.",
    items: [
      {
        slug: "export-for-vinyl-fab",
        title: "export for vinyl cutting",
        blurb: "Cut, score and copper layers at one print size, ready for the vinyl cutter.",
      },
      {
        slug: "export-for-3d-fab",
        title: "export for 3D printing",
        blurb: "The tiled build as geometry to print, at the gap and detail the simulator folded.",
      },
      {
        slug: "export-electronics",
        title: "export the electronics",
        blurb: "The copper, the parts and the netlist, out of the editor and into fabrication.",
      },
    ],
  },
];

/** Every tutorial on the page, flat — for the tests and for the search filter. */
export function allTutorials(): Tutorial[] {
  return TUTORIAL_SECTIONS.flatMap((s) => s.items);
}
