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
    const actions = { openExample: vi.fn(), chooseFile: vi.fn(), openTutorials: vi.fn() };
    const card = mountWelcomeCard(host, actions) as unknown as MockElement;
    return { host, actions, card };
  }

  it("shows three actions that call the existing loaders and then dismiss", () => {
    const { actions, card } = setup();
    const buttons = childrenByClass(card, "welcome-action");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Open the house example",
      "Choose a model file…",
      "Watch the tutorials",
    ]);
    buttons[0]!.click();
    buttons[1]!.click();
    buttons[2]!.click();
    expect(actions.openExample).toHaveBeenCalledTimes(1);
    expect(actions.chooseFile).toHaveBeenCalledTimes(1);
    expect(actions.openTutorials).toHaveBeenCalledTimes(1);
    expect(card.hidden).toBe(true);
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

  it("installFirstRun routes the example button to the sample loader", () => {
    installDom();
    const host = document.createElement("section") as unknown as HTMLElement;
    const loadSample = vi.fn().mockResolvedValue(undefined);
    installFirstRun(host, document.createElement("div") as unknown as HTMLElement, { loadSample });
    childByClass(host as unknown as MockElement, "welcome-primary")!.click();
    expect(loadSample).toHaveBeenCalledWith(true);
  });
});
