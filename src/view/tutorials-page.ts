/**
 * **View** — the Tutorials page: every screen recording of Kiri, grouped, with a line saying what each
 * one shows.
 *
 * A page and not a modal, for the same reason the electronics editor is one: it has its own URL
 * (`#/tutorials`), it is left with Back, and a person following along will want to link someone else
 * straight to a clip. It reads no store state and emits no intents — the catalogue and the files under
 * `public/tutorials/` are all it needs — so it is wired in `main.ts` and the controller never sees it.
 *
 * **The clips run themselves.** They are silent, short and looped, so a card that plays on its own reads
 * as an animated figure rather than as a video that started shouting at you — and the alternative is
 * pressing play twenty-four times to find the one you want. Only what is on screen runs: an
 * `IntersectionObserver` starts a clip as it scrolls into view and stops it as it leaves, and leaving the
 * page stops every one of them. Without that, the page would hold two dozen decoders open and pull the
 * whole 5 MB down at once, most of it for cards nobody has scrolled to.
 *
 * `preload="none"` and the poster frames are what make that cheap: a card costs a ~25 KB still until it
 * is actually on screen, so opening the page fetches stills, not footage. Where there is no
 * `IntersectionObserver` — the test DOM, an old browser — the page falls back to playing every clip while
 * it is up, which is the behaviour asked for, just without the thrift.
 *
 * Paths are relative (`tutorials/x.mp4`, not `/tutorials/x.mp4`) because `main.ts` is built to work from
 * `file://`, where a root-relative path leaves the project entirely.
 */
import { el } from "./dom.js";
import { HOME, currentRoute, goToRoute, onRouteChange } from "./route.js";
import { TUTORIAL_SECTIONS, type Tutorial } from "./tutorials-catalog.js";

/** The route this page answers to. `#/tutorials`. */
const ROUTE = "tutorials";

/** Where the clips and their poster frames live, relative to the document. */
const MEDIA = "tutorials/";

export class TutorialsPage {
  private readonly trigger: HTMLButtonElement;
  private readonly overlay: HTMLElement;
  private readonly search: HTMLInputElement;
  /** Card element ↔ the words it can be searched by, built once. */
  private readonly cards: { node: HTMLElement; haystack: string; section: HTMLElement }[] = [];
  private readonly sections: HTMLElement[] = [];
  private readonly tally: HTMLElement;
  /** Every clip on the page, in card order — what the autoplay machinery drives. */
  private readonly videos: HTMLVideoElement[] = [];
  private observer: IntersectionObserver | null = null;

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger tut-nav";
    this.trigger.textContent = "tutorials";
    this.trigger.title = "short screen recordings of every part of kiri";
    this.trigger.addEventListener("click", () => this.open());

    this.overlay = el("div", "tut-page");
    this.overlay.hidden = true;
    this.overlay.setAttribute("role", "region");
    this.overlay.setAttribute("aria-label", "Tutorials");

    const inner = el("div", "tut-page-inner");
    const header = el("header", "tut-page-header");
    const back = el("button", "el-back tut-back") as HTMLButtonElement;
    back.type = "button";
    back.textContent = "← Model";
    back.setAttribute("aria-label", "Back to the model");
    back.addEventListener("click", () => this.goBack());
    const title = el("span", "el-page-title");
    title.textContent = "kiri Tutorials";
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.className = "tut-search";
    this.search.placeholder = "filter tutorials";
    this.search.setAttribute("aria-label", "Filter tutorials");
    this.search.addEventListener("input", () => this.applyFilter());
    this.tally = el("span", "tut-tally");
    this.tally.setAttribute("aria-live", "polite");
    header.append(back, title, this.search, this.tally);

    const body = el("div", "tut-body");
    for (const section of TUTORIAL_SECTIONS) {
      const node = el("section", "tut-section");
      const h = el("h2", "tut-section-title");
      h.textContent = section.title;
      const intro = el("p", "tut-section-intro");
      intro.textContent = section.intro;
      const grid = el("div", "tut-grid");
      for (const item of section.items) {
        const card = this.buildCard(item);
        grid.append(card);
        this.cards.push({
          node: card,
          haystack: `${item.title} ${item.blurb}`.toLowerCase(),
          section: node,
        });
      }
      node.append(h, intro, grid);
      body.append(node);
      this.sections.push(node);
    }

    inner.append(header, body);
    this.overlay.append(inner);

    const appRoot = document.querySelector("#app");
    if (appRoot && typeof (appRoot as HTMLElement).insertAdjacentElement === "function") {
      (appRoot as HTMLElement).insertAdjacentElement("afterend", this.overlay);
    } else {
      document.body?.appendChild(this.overlay);
    }

    this.applyFilter();
    this.watchVisibility();
    onRouteChange((route) => this.syncRoute(route));
    if (currentRoute() === ROUTE) this.show();
  }

  /** One card: heading, the clip behind its poster, and the sentence under it. */
  private buildCard(item: Tutorial): HTMLElement {
    const card = el("article", "tut-card");
    const head = el("div", "tut-card-head");
    const h = el("h3", "tut-card-title");
    h.textContent = item.title;
    head.append(h);

    const video = document.createElement("video");
    video.className = "tut-video";
    video.src = `${MEDIA}${item.slug}.mp4`;
    video.poster = `${MEDIA}${item.slug}.jpg`;
    video.controls = true;
    video.loop = true;
    video.muted = true; // the recordings carry no audio track at all; this keeps autoplay policies happy
    video.playsInline = true;
    video.preload = "none";
    video.setAttribute("aria-label", item.title);
    this.videos.push(video);

    const blurb = el("p", "tut-card-blurb");
    blurb.textContent = item.blurb;
    card.append(head, video, blurb);
    return card;
  }

  /**
   * Start a clip, tolerating a browser that says no.
   *
   * `play()` returns a promise that REJECTS when autoplay is blocked, and an unhandled rejection in a
   * view is a console error the author will spend an evening on. These are muted, so no policy in a
   * current browser blocks them — but a card that stayed on its poster is a far better failure than a
   * page full of red, so the refusal is swallowed and the poster stays up.
   */
  private static play(video: HTMLVideoElement): void {
    if (typeof video.play !== "function") return;
    const started = video.play() as unknown;
    if (started && typeof (started as Promise<void>).catch === "function") {
      (started as Promise<void>).catch(() => {});
    }
  }

  private static pause(video: HTMLVideoElement): void {
    if (typeof video.pause === "function" && !video.paused) video.pause();
  }

  /** Run the clips that are on screen, and only those. No-op where there is no observer to do it with. */
  private watchVisibility(): void {
    const Observer = (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
      .IntersectionObserver;
    if (typeof Observer !== "function") return;
    this.observer = new Observer(
      (entries) => {
        if (this.overlay.hidden) return; // a page on its way out must not restart anything
        for (const entry of entries) {
          const video = entry.target as HTMLVideoElement;
          if (entry.isIntersecting) TutorialsPage.play(video);
          else TutorialsPage.pause(video);
        }
      },
      // A quarter of the card is enough to be worth playing; the margin starts the next row just before
      // it arrives, so a clip is already moving by the time it is read.
      { threshold: 0.25, rootMargin: "100px 0px" },
    );
    for (const video of this.videos) this.observer.observe(video);
  }

  /** Stop every clip. What leaving the page does, and what a paused decoder costs nothing to redo. */
  private pauseAll(): void {
    for (const video of this.videos) TutorialsPage.pause(video);
  }

  /** Show only the cards matching the filter box, and hide a section left with nothing in it. */
  private applyFilter(): void {
    const needle = this.search.value.trim().toLowerCase();
    const shown = new Set<HTMLElement>();
    let count = 0;
    for (const card of this.cards) {
      const hit = needle === "" || card.haystack.includes(needle);
      card.node.hidden = !hit;
      if (hit) {
        shown.add(card.section);
        count++;
      }
    }
    for (const section of this.sections) section.hidden = !shown.has(section);
    // A hidden card is not "off screen" to an observer that has already reported it, so a clip filtered
    // away would go on running underneath the filter. Stop it here; scrolling back to it starts it again.
    for (const card of this.cards) {
      if (!card.node.hidden) continue;
      const video = card.node.querySelector("video");
      if (video) TutorialsPage.pause(video as HTMLVideoElement);
    }
    this.tally.textContent = needle === "" ? `${count} tutorials` : `${count} of ${this.cards.length}`;
  }

  /** Show or hide the page to match the URL — Back, Forward and a pasted link all arrive here. */
  private syncRoute(route: string): void {
    if (route === ROUTE) this.show();
    else this.hide();
  }

  private show(): void {
    this.overlay.hidden = false;
    document.body?.classList.add("is-tutorials");
    this.trigger.classList.add("is-active");
    // With an observer, the clips that are on screen start on their own as it reports them. Without one,
    // there is nothing to report anything, so every clip runs while the page is up.
    if (!this.observer) for (const video of this.videos) TutorialsPage.play(video);
  }

  /** Leaving stops whatever was playing: a clip running behind a hidden page is a download for nothing. */
  private hide(): void {
    if (this.overlay.hidden) return;
    this.overlay.hidden = true;
    document.body?.classList.remove("is-tutorials");
    this.trigger.classList.remove("is-active");
    this.pauseAll();
  }

  private goBack(): void {
    goToRoute(HOME);
    this.hide();
  }

  // ---- public lifecycle (mirrors SimModal / ElectronicsModal) ---------------

  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  /** Go to the tutorials page. The URL is written first, so Back has somewhere to return to. */
  open(): void {
    goToRoute(ROUTE);
    this.show();
  }

  close(): void {
    this.goBack();
  }
}
