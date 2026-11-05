import { afterEach, describe, expect, it, vi } from "vitest";
import { installFirstRun, mountWelcomeCard } from "../../../src/view/first-run.js";
import { childByClass, childrenByClass, installDom, MockElement } from "./mock-dom.js";

describe("view/first-run", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  });

  function setup() {
    installDom();
    const host = document.createElement("section") as unknown as HTMLElement;
    const actions = { openExample: vi.fn(), chooseFile: vi.fn(), openSimulate: vi.fn(), openTutorials: vi.fn() };
    const welcome = mountWelcomeCard(host, actions)!;
    const card = welcome.element as unknown as MockElement;
    const buttons = () => childrenByClass(card, "welcome-action");
    const text = () => childByClass(card, "welcome-text")!.textContent;
    return { host, actions, welcome, card, buttons, text };
  }

  it("with nothing open, offers the house example, a model file and the tutorials, then dismisses", () => {
    const { actions, card, buttons } = setup();
    expect(buttons().map((b) => b.textContent)).toEqual([
      "Open the house example",
      "Choose a model file…",
      "Watch the tutorials",
    ]);
    buttons()[0]!.click();
    buttons()[1]!.click();
    buttons()[2]!.click();
    expect(actions.openExample).toHaveBeenCalledTimes(1);
    expect(actions.chooseFile).toHaveBeenCalledTimes(1);
    expect(actions.openTutorials).toHaveBeenCalledTimes(1);
    expect(card.hidden).toBe(true);
  });

  it("does not offer to open the house when a pattern is already open, and offers Simulate", () => {
    // The banner used to say "Open the house example" with the house loaded and named in the Model column.
    const { actions, welcome, buttons, text } = setup();
    welcome.update({ kind: "pattern", name: "house.fkld", canSimulate: true });
    const [primary] = buttons();
    expect(primary!.textContent).toBe("Simulate");
    expect(primary!.hidden).toBe(false);
    expect(text()).toContain("house.fkld is open");
    expect(text()).toContain("Press Simulate");
    primary!.click();
    expect(actions.openSimulate).toHaveBeenCalledTimes(1);
    expect(actions.openExample).not.toHaveBeenCalled();
  });

  it("hides the Simulate button for a pattern that cannot be simulated, and says what to do instead", () => {
    const { welcome, buttons, text } = setup();
    welcome.update({ kind: "pattern", name: "odd.fold", canSimulate: false });
    expect(buttons()[0]!.hidden).toBe(true);
    expect(text()).not.toContain("Press Simulate");
    expect(text()).toContain("Drop your own 3D model");
  });

  it("points at Cut & fold when a 3D mesh is open, with no primary button", () => {
    const { welcome, buttons, text } = setup();
    welcome.update({ kind: "mesh", name: "cube.stl" });
    expect(buttons()[0]!.hidden).toBe(true);
    expect(text()).toContain("cube.stl is loaded");
    expect(text()).toContain("Cut & fold");
  });

  it("goes back to offering the house when nothing is open again", () => {
    const { actions, welcome, buttons } = setup();
    welcome.update({ kind: "pattern", name: "house.fkld", canSimulate: true });
    welcome.update({ kind: "none" });
    expect(buttons()[0]!.textContent).toBe("Open the house example");
    expect(buttons()[0]!.hidden).toBe(false);
    buttons()[0]!.click();
    expect(actions.openExample).toHaveBeenCalledTimes(1);
    expect(actions.openSimulate).not.toHaveBeenCalled();
  });

  it("can be dismissed and then stays away", () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const { host, actions, card } = setup();
    childByClass(card, "welcome-close")!.click();
    expect(card.hidden).toBe(true);
    expect(actions.openExample).not.toHaveBeenCalled();
    expect(mountWelcomeCard(host, actions)).toBeNull();
  });

  describe("installFirstRun", () => {
    function install(canSimulate = true) {
      installDom();
      const host = document.createElement("section") as unknown as HTMLElement;
      const loadSample = vi.fn().mockResolvedValue(undefined);
      const simulate = vi.fn();
      let push: (s: { model: any }) => void = () => {};
      const store = { subscribe: (fn: (s: { model: any }) => void) => { push = fn; fn({ model: null }); } };
      installFirstRun(host, document.createElement("div") as unknown as HTMLElement, { loadSample }, {
        store, simulate, canSimulate: () => canSimulate,
      });
      const card = childByClass(host as unknown as MockElement, "welcome-card")!;
      return { host, loadSample, simulate, push, buttons: () => childrenByClass(card, "welcome-action") };
    }

    it("routes the example button to the sample loader while nothing is open", () => {
      const { loadSample, buttons } = install();
      buttons()[0]!.click();
      expect(loadSample).toHaveBeenCalledWith(true);
    });

    it("follows the store: a pattern loads, the card offers Simulate, and Simulate opens the dialog", () => {
      const { simulate, push, buttons, loadSample } = install();
      push({ model: { kind: "fold", name: "house.fkld", object: {} } });
      expect(buttons()[0]!.textContent).toBe("Simulate");
      buttons()[0]!.click();
      expect(simulate).toHaveBeenCalledTimes(1);
      expect(loadSample).not.toHaveBeenCalled();
    });

    it("follows the store to a mesh, and back to nothing", () => {
      const { push, buttons } = install();
      push({ model: { kind: "mesh", name: "cube.stl", ext: "stl", text: "" } });
      expect(buttons()[0]!.hidden).toBe(true);
      push({ model: null });
      expect(buttons()[0]!.hidden).toBe(false);
      expect(buttons()[0]!.textContent).toBe("Open the house example");
    });

    it("asks whether Simulate is on at the moment the pattern arrives", () => {
      const { push, buttons } = install(false);
      push({ model: { kind: "fold", name: "odd.fold", object: {} } });
      expect(buttons()[0]!.hidden).toBe(true);
    });
  });
});
