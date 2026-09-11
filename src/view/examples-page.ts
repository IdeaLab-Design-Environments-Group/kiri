/**
 * **View** — the Examples page: every bundled model, grouped by the object it is part of, each tile
 * showing what it folds into and what its pattern looks like flat.
 *
 * A page and not a modal, for the reason the Tutorials page is one: it has its own URL (`#/examples`), it
 * is left with Back, and someone running a workshop will want to link straight to it. It reads no store
 * state — the catalogue and the files under `public/examples/` are all it needs — and it emits exactly one
 * intent, {@link onPick}, which `main.ts` wires to the controller's loader. Choosing a model is the only
 * thing this page does to the app.
 *
 * **Two pictures per tile, both cheap.** The folded form is the tile's face; the flat pattern replaces it
 * on hover and on focus. They are SVGs of a few hundred polygons rather than renders, so the whole page is
 * some tens of kilobytes and needs no GL — and because both are generated from the FKLD the tile loads,
 * they cannot drift from it. `loading="lazy"` keeps the ones below the fold off the wire until they are
 * scrolled to.
 *
 * Paths are relative (`examples/x.fkld`, not `/examples/x.fkld`) because the app is built to work from
 * `file://`, where a root-relative path leaves the project entirely.
 */
import { el } from "./dom.js";
import { EXAMPLE_MODELS, type Example, type ExampleModel } from "./examples-catalog.js";
import { HOME, currentRoute, goToRoute, onRouteChange } from "./route.js";

/** The route this page answers to. `#/examples`. */
const ROUTE = "examples";

/** Where the patterns and their previews live, relative to the document. */
const MEDIA = "examples/";

export class ExamplesPage {
  private readonly trigger: HTMLButtonElement;
  private readonly overlay: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly tally: HTMLElement;
  /** Tile ↔ the words it can be searched by, built once. */
  private readonly tiles: { node: HTMLElement; haystack: string; group: HTMLElement }[] = [];
  private readonly groups: HTMLElement[] = [];
  private pickHandler: (slug: string) => void = () => {};

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger ex-nav";
    this.trigger.textContent = "examples";
    this.trigger.title = "bundled models, kirigamized and ready to open";
    this.trigger.addEventListener("click", () => this.open());

    this.overlay = el("div", "ex-page");
    this.overlay.hidden = true;
    this.overlay.setAttribute("role", "region");
    this.overlay.setAttribute("aria-label", "Examples");

    const inner = el("div", "ex-page-inner");
    const header = el("header", "ex-page-header");
    const back = el("button", "el-back ex-back") as HTMLButtonElement;
    back.type = "button";
    back.textContent = "← Model";
    back.setAttribute("aria-label", "Back to the model");
    back.addEventListener("click", () => this.goBack());
    const title = el("span", "el-page-title");
    title.textContent = "examples";
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.className = "ex-search";
    this.search.placeholder = "filter models";
    this.search.setAttribute("aria-label", "Filter models");
    this.search.addEventListener("input", () => this.applyFilter());
    this.tally = el("span", "ex-tally");
    this.tally.setAttribute("aria-live", "polite");
    header.append(back, title, this.search, this.tally);

    const body = el("div", "ex-body");
    const lede = el("p", "ex-lede");
    lede.textContent =
      "every model here has been through the same pipeline the Kirigamize button runs, and opens as the "
      + "pattern it produced. Pick a part to load it; hover a tile to see it flat.";
    body.append(lede);
    for (const model of EXAMPLE_MODELS) body.append(this.buildGroup(model));

    inner.append(header, body);
    this.overlay.append(inner);

    const appRoot = document.querySelector("#app");
    if (appRoot && typeof (appRoot as HTMLElement).insertAdjacentElement === "function") {
      (appRoot as HTMLElement).insertAdjacentElement("afterend", this.overlay);
    } else {
      document.body?.appendChild(this.overlay);
    }

    this.applyFilter();
    onRouteChange((route) => this.syncRoute(route));
    if (currentRoute() === ROUTE) this.show();
  }

  /** One object: its heading, the line under it, and a tile per part. */
  private buildGroup(model: ExampleModel): HTMLElement {
    const node = el("section", "ex-group");
    node.dataset.model = model.slug;
    const head = el("div", "ex-group-head");
    const h = el("h2", "ex-group-title");
    h.textContent = model.title;
    const count = el("span", "ex-group-count");
    count.textContent = `${model.parts.length} ${model.parts.length === 1 ? "part" : "parts"}`;
    head.append(h, count);
    const intro = el("p", "ex-group-intro");
    intro.textContent = model.intro;

    const grid = el("div", "ex-grid");
    for (const part of model.parts) {
      const tile = this.buildTile(part);
      grid.append(tile);
      this.tiles.push({
        node: tile,
        haystack: `${model.title} ${part.title} ${part.blurb} ${part.slug}`.toLowerCase(),
        group: node,
      });
    }
    node.append(head, intro, grid);
    this.groups.push(node);
    return node;
  }

  /** One part: the two pictures, the name, what it is, and the two numbers that say what it costs. */
  private buildTile(part: Example): HTMLElement {
    // A button, not a div with a click handler: this loads a model, which is an action, and the keyboard
    // and the screen reader both already know what a button is.
    const tile = el("button", "ex-tile") as HTMLButtonElement;
    tile.type = "button";
    tile.dataset.slug = part.slug;
    tile.title = `Open ${part.title} — ${part.slug}.fkld`;
    tile.addEventListener("click", () => this.pick(part.slug));

    const art = el("span", "ex-art");
    const folded = document.createElement("img");
    folded.className = "ex-art-folded";
    folded.src = `${MEDIA}previews/${part.slug}.svg`;
    folded.loading = "lazy";
    folded.alt = `${part.title}, folded`;
    const flat = document.createElement("img");
    flat.className = "ex-art-flat";
    flat.src = `${MEDIA}previews/${part.slug}-flat.svg`;
    flat.loading = "lazy";
    flat.alt = `${part.title}, flat pattern`;
    art.append(folded, flat);

    const name = el("span", "ex-tile-title");
    name.textContent = part.title;
    const blurb = el("span", "ex-tile-blurb");
    blurb.textContent = part.blurb;

    const stats = el("span", "ex-stats");
    stats.append(
      this.stat(`${part.faces}`, "tiles"),
      this.stat(`${part.cuts}`, "cuts"),
    );

    tile.append(art, name, blurb, stats);
    return tile;
  }

  private stat(value: string, label: string): HTMLElement {
    const stat = el("span", "ex-stat");
    const n = el("span", "ex-stat-value");
    n.textContent = value;
    const l = el("span", "ex-stat-label");
    l.textContent = label;
    stat.append(n, l);
    return stat;
  }

  /** Hand the choice to whoever wired {@link onPick}, then get out of the way: the model page is where
   *  the thing that was just loaded actually appears. */
  private pick(slug: string): void {
    this.pickHandler(slug);
    this.goBack();
  }

  /** Show only the tiles matching the filter box, and hide a group left with nothing in it. */
  private applyFilter(): void {
    const needle = this.search.value.trim().toLowerCase();
    const shown = new Set<HTMLElement>();
    let count = 0;
    for (const tile of this.tiles) {
      const hit = needle === "" || tile.haystack.includes(needle);
      tile.node.hidden = !hit;
      if (hit) {
        shown.add(tile.group);
        count++;
      }
    }
    for (const group of this.groups) group.hidden = !shown.has(group);
    this.tally.textContent = needle === "" ? `${count} models` : `${count} of ${this.tiles.length}`;
  }

  /** Show or hide the page to match the URL — Back, Forward and a pasted link all arrive here. */
  private syncRoute(route: string): void {
    if (route === ROUTE) this.show();
    else this.hide();
  }

  private show(): void {
    this.overlay.hidden = false;
    document.body?.classList.add("is-examples");
    this.trigger.classList.add("is-active");
  }

  private hide(): void {
    if (this.overlay.hidden) return;
    this.overlay.hidden = true;
    document.body?.classList.remove("is-examples");
    this.trigger.classList.remove("is-active");
  }

  private goBack(): void {
    goToRoute(HOME);
    this.hide();
  }

  // ---- public lifecycle (mirrors TutorialsPage) ----------------------------

  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  /** Register what happens when a model is chosen. One handler: `main.ts` gives it the controller. */
  onPick(handler: (slug: string) => void): void {
    this.pickHandler = handler;
  }

  /** Go to the examples page. The URL is written first, so Back has somewhere to return to. */
  open(): void {
    goToRoute(ROUTE);
    this.show();
  }

  close(): void {
    this.goBack();
  }
}
