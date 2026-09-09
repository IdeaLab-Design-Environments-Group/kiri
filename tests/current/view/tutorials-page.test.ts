/**
 * The Tutorials page, driven the way a person drives it, plus the one check that cannot be made from
 * inside the app: that every card names a file that is actually there.
 *
 * That last one is the reason this file exists at all. The cards are built from a hand-written
 * catalogue and the media are twenty-four files on disk with hand-slugged names; nothing but a test
 * connects the two, so a renamed clip is a black rectangle that no type error and no build failure
 * would ever mention. It is checked in both directions -- a card with no file, and a file no card
 * shows -- because a recording that was made and then never linked is the same waste as a broken card.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TutorialsPage } from "../../../src/view/tutorials-page.js";
import { TUTORIAL_SECTIONS, allTutorials } from "../../../src/view/tutorials-catalog.js";
import { installDom, childByClass, childrenByClass, childrenByTag, type MockElement } from "./mock-dom.js";

const MEDIA = fileURLToPath(new URL("../../../public/tutorials/", import.meta.url));

/** Build the page and hand back the pieces a test drives it by. */
function makePage(): { page: TutorialsPage; overlay: MockElement; header: MockElement } {
  const { document } = installDom();
  const page = new TutorialsPage();
  const header = document.createElement("div");
  page.mountTrigger(header as unknown as HTMLElement);
  const overlay = childByClass(document.body, "tut-page")!;
  return { page, overlay, header };
}

function cards(overlay: MockElement): MockElement[] {
  return childrenByClass(overlay, "tut-card");
}

function visibleCards(overlay: MockElement): MockElement[] {
  return cards(overlay).filter((c) => !c.hidden);
}

/** Give a mock <video> the two methods the page drives it by, and a flag saying which one won. */
function stubPlayback(node: MockElement): { node: MockElement; playing: boolean } {
  const state = { node, playing: false };
  const video = node as any;
  video.paused = true;
  video.play = () => {
    state.playing = true;
    video.paused = false;
    return Promise.resolve();
  };
  video.pause = () => {
    state.playing = false;
    video.paused = true;
  };
  return state;
}

function trigger(header: MockElement): MockElement {
  return header.children[0]!;
}

describe("view/tutorials-page", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("names a clip and a poster that exist for every card", () => {
    const onDisk = new Set(readdirSync(MEDIA));
    for (const item of allTutorials()) {
      expect(onDisk.has(`${item.slug}.mp4`), `no clip for "${item.title}"`).toBe(true);
      expect(onDisk.has(`${item.slug}.jpg`), `no poster for "${item.title}"`).toBe(true);
    }
  });

  it("shows every recording that was made", () => {
    const listed = new Set(allTutorials().map((t) => t.slug));
    const unlisted = readdirSync(MEDIA)
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => f.replace(/\.mp4$/, ""))
      .filter((slug) => !listed.has(slug));
    expect(unlisted, "recordings on disk that no card links to").toEqual([]);
  });

  it("gives every tutorial a title and a sentence of its own", () => {
    const titles = allTutorials().map((t) => t.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const item of allTutorials()) {
      expect(item.blurb.length, `"${item.title}" has no blurb`).toBeGreaterThan(20);
    }
  });

  it("builds one card per tutorial, in catalogue order", () => {
    const { overlay } = makePage();
    const titles = childrenByClass(overlay, "tut-card-title").map((n) => n.textContent);
    expect(titles).toEqual(allTutorials().map((t) => t.title));
    expect(childrenByClass(overlay, "tut-section")).toHaveLength(TUTORIAL_SECTIONS.length);
  });

  it("downloads nothing until a clip is asked for", () => {
    // The page is twenty-odd videos. Opening it must cost the posters and no footage, or a workshop on
    // a shared connection spends its first minute downloading tutorials nobody chose to watch.
    const { overlay } = makePage();
    const videos = childrenByTag(overlay, "video");
    expect(videos).toHaveLength(allTutorials().length);
    for (const video of videos) {
      expect((video as any).preload).toBe("none");
      expect((video as any).poster).toMatch(/^tutorials\/.+\.jpg$/);
      expect(video.src).toMatch(/^tutorials\/.+\.mp4$/);
    }
  });

  it("keeps its media paths relative, so the page works from a file:// build", () => {
    const { overlay } = makePage();
    for (const video of childrenByTag(overlay, "video")) {
      expect(video.src.startsWith("/"), `${video.src} leaves the project under file://`).toBe(false);
    }
  });

  it("starts hidden, and the trigger puts it up", () => {
    const { overlay, header } = makePage();
    expect(overlay.hidden).toBe(true);
    trigger(header).click();
    expect(overlay.hidden).toBe(false);
    expect((globalThis as any).document.body.classList.contains("is-tutorials")).toBe(true);
  });

  it("goes back to the model, and stops every clip on the way out", () => {
    const { overlay, header } = makePage();
    const videos = childrenByTag(overlay, "video").map(stubPlayback);
    trigger(header).click();
    childByClass(overlay, "tut-back")!.click();
    expect(overlay.hidden).toBe(true);
    expect((globalThis as any).document.body.classList.contains("is-tutorials")).toBe(false);
    expect(videos.some((v) => v.playing), "a hidden page kept a clip running").toBe(false);
  });

  it("starts every clip with the page, where the browser cannot say which are on screen", () => {
    // No IntersectionObserver: nothing can report visibility, so the fallback is what was asked for --
    // the clips run while the page is up -- and it must not be a silent no-op.
    const { overlay, header } = makePage();
    const videos = childrenByTag(overlay, "video").map(stubPlayback);
    trigger(header).click();
    expect(videos.every((v) => v.playing), "a clip stayed on its poster").toBe(true);
  });

  it("runs only the clips that are on screen, when the browser can tell it", () => {
    // Two dozen decoders and 5 MB of footage for the cards nobody scrolled to is the thing the observer
    // is here to avoid, so the test drives the observer rather than trusting that one was made.
    const observed: any[] = [];
    let report: (entries: { target: any; isIntersecting: boolean }[]) => void = () => {};
    (globalThis as any).IntersectionObserver = class {
      constructor(cb: any) { report = cb; }
      observe(node: any) { observed.push(node); }
      disconnect() {}
    };
    try {
      const { overlay, header } = makePage();
      const videos = childrenByTag(overlay, "video").map(stubPlayback);
      expect(observed).toHaveLength(videos.length);
      trigger(header).click();
      expect(videos.some((v) => v.playing), "the observer decides, not `show`").toBe(false);

      report([{ target: videos[0].node, isIntersecting: true }]);
      expect(videos[0].playing).toBe(true);
      expect(videos[1].playing).toBe(false);

      report([{ target: videos[0].node, isIntersecting: false }]);
      expect(videos[0].playing).toBe(false);
    } finally {
      delete (globalThis as any).IntersectionObserver;
    }
  });

  it("stops a clip the filter has just hidden", () => {
    const { overlay, header } = makePage();
    const videos = childrenByTag(overlay, "video").map(stubPlayback);
    trigger(header).click();
    const search = childByClass(overlay, "tut-search")!;
    search.value = "zzzz-no-such-tutorial";
    search.dispatch("input");
    expect(videos.some((v) => v.playing), "a filtered-away clip kept running").toBe(false);
  });

  it("filters the cards by what is typed, and hides a section left with nothing", () => {
    const { overlay } = makePage();
    const search = childByClass(overlay, "tut-search")!;
    const tally = childByClass(overlay, "tut-tally")!;
    expect(visibleCards(overlay)).toHaveLength(allTutorials().length);
    expect(tally.textContent).toBe(`${allTutorials().length} tutorials`);

    search.value = "vinyl";
    search.dispatch("input");
    const shown = visibleCards(overlay);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(allTutorials().length);
    for (const card of shown) {
      expect(card.textContent + childByClass(card, "tut-card-title")!.textContent
        + childByClass(card, "tut-card-blurb")!.textContent).toMatch(/vinyl/i);
    }
    expect(childrenByClass(overlay, "tut-section").some((s) => s.hidden)).toBe(true);
    expect(tally.textContent).toBe(`${shown.length} of ${allTutorials().length}`);
  });

  it("says so when nothing matches, rather than showing an empty page", () => {
    const { overlay } = makePage();
    const search = childByClass(overlay, "tut-search")!;
    search.value = "zzzz-no-such-tutorial";
    search.dispatch("input");
    expect(visibleCards(overlay)).toHaveLength(0);
    expect(childByClass(overlay, "tut-tally")!.textContent).toBe(`0 of ${allTutorials().length}`);
  });
});
