import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enterFocusScope, focusableWithin } from "../../../src/view/dialog-focus.js";

/** Just enough of the DOM for focus: the tests run in Node, and the shared mock DOM has no focus at all. */
class El {
  children: El[] = [];
  constructor(
    readonly name: string,
    private readonly doc: Doc,
    public opts: { hidden?: boolean; disabled?: boolean; laidOut?: boolean; connected?: boolean } = {},
  ) {}
  get hidden(): boolean { return this.opts.hidden ?? false; }
  get disabled(): boolean { return this.opts.disabled ?? false; }
  get isConnected(): boolean { return this.opts.connected ?? true; }
  focus(): void { this.doc.activeElement = this; }
  getClientRects(): unknown[] { return (this.opts.laidOut ?? true) ? [{}] : []; }
  contains(el: El | null): boolean { return el === this || this.children.some((c) => c.contains(el)); }
  /** Stands in for the focusable selector: the real one leaves out disabled controls. */
  querySelectorAll(): El[] { return this.children.filter((c) => !c.disabled); }
}

class Doc {
  activeElement: El | null = null;
  private listeners: ((e: any) => void)[] = [];
  addEventListener(_t: string, fn: (e: any) => void): void { this.listeners.push(fn); }
  removeEventListener(_t: string, fn: (e: any) => void): void { this.listeners = this.listeners.filter((l) => l !== fn); }
  get listenerCount(): number { return this.listeners.length; }
  /** Press Tab. Returns whether the dialog stopped the key (a real browser would otherwise move focus itself). */
  tab(shift = false): boolean {
    const e = { key: "Tab", shiftKey: shift, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const l of [...this.listeners]) l(e);
    return e.defaultPrevented;
  }
  press(key: string): boolean {
    const e = { key, shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const l of [...this.listeners]) l(e);
    return e.defaultPrevented;
  }
}

let doc: Doc;
let dialog: El, close: El, input: El, ok: El, outside: El, opener: El;

beforeEach(() => {
  doc = new Doc();
  vi.stubGlobal("document", doc);
  dialog = new El("dialog", doc);
  close = new El("close", doc);
  input = new El("input", doc);
  ok = new El("ok", doc);
  dialog.children = [close, input, ok];
  outside = new El("header button", doc);
  opener = new El("opener", doc);
  opener.focus();
});
afterEach(() => vi.unstubAllGlobals());

const enter = (o?: Parameters<typeof enterFocusScope>[2]) => enterFocusScope(dialog as unknown as HTMLElement, opener as unknown as HTMLElement, o);

describe("view/dialog-focus: entering", () => {
  it("moves focus to the first thing that can take it", () => {
    enter();
    expect(doc.activeElement).toBe(close);
  });

  it("skips what is hidden or not laid out, and what is disabled", () => {
    close.opts.hidden = true;
    input.opts.laidOut = false;
    enter();
    expect(doc.activeElement).toBe(ok);
    expect(focusableWithin(dialog as unknown as HTMLElement)).toEqual([ok]);
    ok.opts.disabled = true;
    expect(focusableWithin(dialog as unknown as HTMLElement)).toEqual([]);
  });

  it("starts on the element it is told to", () => {
    enter({ initial: input as unknown as HTMLElement });
    expect(doc.activeElement).toBe(input);
  });
});

describe("view/dialog-focus: a modal dialog traps Tab", () => {
  beforeEach(() => { enter({ trap: true }); });

  it("wraps Tab from the last control round to the first", () => {
    ok.focus();
    expect(doc.tab()).toBe(true); // stopped here, so the browser does not walk out
    expect(doc.activeElement).toBe(close);
  });

  it("wraps Shift+Tab from the first control round to the last", () => {
    close.focus();
    expect(doc.tab(true)).toBe(true);
    expect(doc.activeElement).toBe(ok);
  });

  it("leaves Tab alone in the middle, for the browser to move on", () => {
    input.focus();
    expect(doc.tab()).toBe(false);
    expect(doc.tab(true)).toBe(false);
    expect(doc.activeElement).toBe(input);
  });

  it("brings focus back in if it was somewhere else, such as the page behind", () => {
    outside.focus();
    expect(doc.tab()).toBe(true);
    expect(doc.activeElement).toBe(close);
  });

  it("holds Tab still when there is nothing inside to focus", () => {
    close.opts.hidden = input.opts.hidden = ok.opts.hidden = true;
    expect(doc.tab()).toBe(true);
  });

  it("ignores other keys, Escape included: closing is the dialog's own business", () => {
    expect(doc.press("Escape")).toBe(false);
    expect(doc.press("Enter")).toBe(false);
  });
});

describe("view/dialog-focus: a page gets focus but no trap", () => {
  it("moves focus in and listens for no keys", () => {
    enter(); // trap off
    expect(doc.activeElement).toBe(close);
    expect(doc.listenerCount).toBe(0);
    ok.focus();
    expect(doc.tab()).toBe(false);
  });
});

describe("view/dialog-focus: leaving", () => {
  it("gives focus back to what opened it and stops trapping", () => {
    const leave = enter({ trap: true });
    expect(doc.listenerCount).toBe(1);
    leave();
    expect(doc.activeElement).toBe(opener);
    expect(doc.listenerCount).toBe(0);
  });

  it("can be called twice without moving focus the second time", () => {
    const leave = enter({ trap: true });
    leave();
    outside.focus();
    leave();
    expect(doc.activeElement).toBe(outside);
  });

  it("does not focus an opener that has gone from the page or been disabled", () => {
    let leave = enter();
    opener.opts.connected = false;
    outside.focus();
    leave();
    expect(doc.activeElement).toBe(outside);

    opener.opts.connected = true;
    leave = enter();
    opener.opts.disabled = true;
    outside.focus();
    leave();
    expect(doc.activeElement).toBe(outside);
  });

  it("copes with no opener at all", () => {
    const leave = enterFocusScope(dialog as unknown as HTMLElement, null, { trap: true });
    expect(() => leave()).not.toThrow();
  });
});

describe("view/dialog-focus: a test DOM with no focus support", () => {
  it("does nothing, and does not throw", () => {
    vi.unstubAllGlobals();
    const bare = { hidden: false, contains: () => false } as unknown as HTMLElement; // no querySelectorAll, no focus()
    expect(() => enterFocusScope(bare, bare, { trap: true })()).not.toThrow();
  });
});
