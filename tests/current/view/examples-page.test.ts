/**
 * The Examples page, driven the way a person drives it, plus the checks that cannot be made from inside
 * the app: that every tile names files that are there, and that the two numbers it prints are the two
 * numbers in the pattern behind it.
 *
 * Those last ones are why this file exists. The tiles are built from a hand-written catalogue and the
 * models are sixty-odd files on disk with hand-slugged names; nothing but a test connects the two, so a
 * regenerated or renamed pattern is a broken tile — or worse, a tile quoting a face count that stopped
 * being true — that no type error and no build failure would ever mention. Checked in both directions: a
 * tile with no files, and a pattern no tile offers, because a model that was kirigamized and never linked
 * is the same waste as a dead tile.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ExamplesPage } from "../../../src/view/examples-page.js";
import { EXAMPLE_MODELS, allExamples } from "../../../src/view/examples-catalog.js";
import { installDom, childByClass, childrenByClass, childrenByTag, type MockElement } from "./mock-dom.js";

const MEDIA = fileURLToPath(new URL("../../../public/examples/", import.meta.url));

/** Build the page and hand back the pieces a test drives it by. */
function makePage(): { page: ExamplesPage; overlay: MockElement; header: MockElement } {
  const { document } = installDom();
  const page = new ExamplesPage();
  const header = document.createElement("div");
  page.mountTrigger(header as unknown as HTMLElement);
  const overlay = childByClass(document.body, "ex-page")!;
  return { page, overlay, header };
}

function tiles(overlay: MockElement): MockElement[] {
  return childrenByClass(overlay, "ex-tile");
}

function visibleTiles(overlay: MockElement): MockElement[] {
  return tiles(overlay).filter((t) => !t.hidden);
}

function trigger(header: MockElement): MockElement {
  return header.children[0]!;
}

describe("view/examples-page", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("names a pattern and two previews that exist for every tile", () => {
    const onDisk = new Set(readdirSync(MEDIA));
    const previews = new Set(readdirSync(`${MEDIA}previews`));
    for (const part of allExamples()) {
      expect(onDisk.has(`${part.slug}.fkld`), `no pattern for "${part.title}"`).toBe(true);
      expect(previews.has(`${part.slug}.svg`), `no folded preview for "${part.title}"`).toBe(true);
      expect(previews.has(`${part.slug}-flat.svg`), `no flat preview for "${part.title}"`).toBe(true);
    }
  });

  it("offers every pattern that has a preview drawn for it", () => {
    // Against the PREVIEWS, not against every `.fkld` in the folder: that folder also holds the patterns
    // the app itself ships with (the bundled sample, the sim fixtures), which are not examples to browse.
    // A preview, on the other hand, is only ever made by the generator for a tile to show.
    const listed = new Set(allExamples().map((p) => p.slug));
    const unlisted = readdirSync(`${MEDIA}previews`)
      .filter((f) => f.endsWith(".svg") && !f.endsWith("-flat.svg"))
      .map((f) => f.replace(/\.svg$/, ""))
      .filter((slug) => !listed.has(slug));
    expect(unlisted, "patterns with previews that no tile offers").toEqual([]);
  });

  it("prints the face and cut counts the pattern actually has", () => {
    // The numbers are the reason to pick one model over another, so they have to come from the file
    // rather than from whatever was true when the blurb was written.
    for (const part of allExamples()) {
      const fkld = JSON.parse(readFileSync(`${MEDIA}${part.slug}.fkld`, "utf8"));
      const cuts = (fkld.edges_assignment as string[]).filter((a) => a === "C" || a === "B").length;
      expect(fkld.faces_vertices.length, `${part.slug}: face count`).toBe(part.faces);
      expect(cuts, `${part.slug}: cut count`).toBe(part.cuts);
    }
  });

  it("groups the parts by the prefix their filenames share", () => {
    // The grouping is the page's whole structure, and it is only honest while the parts of a group really
    // are the files that start with its slug — which is what makes a mis-filed part findable at all.
    for (const model of EXAMPLE_MODELS) {
      for (const part of model.parts) {
        expect(part.slug.startsWith(`${model.slug}-`), `${part.slug} is not a ${model.title} part`).toBe(true);
      }
    }
    const slugs = allExamples().map((p) => p.slug);
    expect(new Set(slugs).size, "the same part is listed twice").toBe(slugs.length);
  });

  it("gives every part a title and a sentence of its own", () => {
    for (const part of allExamples()) {
      expect(part.blurb.length, `"${part.title}" has no blurb`).toBeGreaterThan(20);
    }
  });

  it("builds one tile per part, in catalogue order, under one section per model", () => {
    const { overlay } = makePage();
    const titles = childrenByClass(overlay, "ex-tile-title").map((n) => n.textContent);
    expect(titles).toEqual(allExamples().map((p) => p.title));
    expect(childrenByClass(overlay, "ex-group")).toHaveLength(EXAMPLE_MODELS.length);
  });

  it("keeps its media paths relative, so the page works from a file:// build", () => {
    const { overlay } = makePage();
    const imgs = childrenByTag(overlay, "img");
    expect(imgs).toHaveLength(allExamples().length * 2);
    for (const img of imgs) {
      expect(img.src.startsWith("/"), `${img.src} leaves the project under file://`).toBe(false);
      expect(img.src).toMatch(/^examples\/previews\/.+\.svg$/);
      expect((img as any).loading, "a preview below the fold is downloaded anyway").toBe("lazy");
    }
  });

  it("starts hidden, and the trigger puts it up", () => {
    const { overlay, header } = makePage();
    expect(overlay.hidden).toBe(true);
    trigger(header).click();
    expect(overlay.hidden).toBe(false);
    expect((globalThis as any).document.body.classList.contains("is-examples")).toBe(true);
  });

  it("hands the chosen slug over and goes back to the model, where the load shows up", () => {
    const { overlay, header, page } = makePage();
    const picked: string[] = [];
    page.onPick((slug) => picked.push(slug));
    trigger(header).click();
    tiles(overlay)[0]!.click();
    expect(picked).toEqual([allExamples()[0]!.slug]);
    expect(overlay.hidden, "the page stayed up over the model it just loaded").toBe(true);
    expect((globalThis as any).document.body.classList.contains("is-examples")).toBe(false);
  });

  it("filters the tiles by what is typed, and hides a model left with nothing", () => {
    const { overlay } = makePage();
    const search = childByClass(overlay, "ex-search")!;
    const tally = childByClass(overlay, "ex-tally")!;
    expect(visibleTiles(overlay)).toHaveLength(allExamples().length);
    expect(tally.textContent).toBe(`${allExamples().length} models`);

    search.value = "guitar";
    search.dispatch("input");
    const shown = visibleTiles(overlay);
    expect(shown.length).toBe(EXAMPLE_MODELS.find((m) => m.slug === "guitar")!.parts.length);
    expect(childrenByClass(overlay, "ex-group").some((g) => g.hidden)).toBe(true);
    expect(tally.textContent).toBe(`${shown.length} of ${allExamples().length}`);
  });

  it("says so when nothing matches, rather than showing an empty page", () => {
    const { overlay } = makePage();
    const search = childByClass(overlay, "ex-search")!;
    search.value = "zzzz-no-such-model";
    search.dispatch("input");
    expect(visibleTiles(overlay)).toHaveLength(0);
    expect(childByClass(overlay, "ex-tally")!.textContent).toBe(`0 of ${allExamples().length}`);
  });
});
