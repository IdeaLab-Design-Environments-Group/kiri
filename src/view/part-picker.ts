/**
 * **View** — the electronics editor's library picker: the search box, the "Pick a part…" menu and the
 * hidden `<select>` that holds the value.
 *
 * Split out of `electronics-modal.ts`, which was at its size budget. The modal still decides what a pick
 * means — which tool is armed, and whether the part goes down with its socket — and this file only shows
 * the library and reports which row was chosen. It holds no circuit and knows nothing about the canvas.
 */
import type { Component } from "../model/footprint.js";
import { mountingHint, mountingOf } from "../model/part-mounting.js";
import { socketAction } from "./socket-action.js";
import {
  BLOCKED,
  BLOCKED_SHOWN,
  GROUP_OF,
  OFFERED,
  PART_BY_ID,
  PART_GROUPS,
  matches,
  paletteCount,
  partLabel,
} from "./electronics-palette.js";

/** What the picker needs of the editor it sits in. */
export interface PickerHost {
  /** The library part the canvas is armed with, or undefined when another tool is armed. */
  armed(): Component | undefined;
  /** Whether that part goes down together with its socket (issue #36). */
  withSocket(): boolean;
  /** Arm this library part, alone or with its socket. Only ever called with an id the palette offers. */
  arm(id: string, withSocket: boolean): void;
}

export class PartPicker {
  /** The library picker — one control for the whole library, so a part added to it costs no toolbar room. */
  private readonly select: HTMLSelectElement;
  /** Narrows the picker. At this many footprints the list is longer than the screen and the names are things
   *  like `Switch_Slide_RightAngle_CnK_AYZ0102AGRLC_7.2x3mm`; typing is the only way in. */
  private readonly search: HTMLInputElement;
  /** Says how much of the library the picker is showing, and how much of it can never be shown. */
  private readonly count: HTMLElement;
  /** The button that opens the library menu, showing what is armed. */
  private readonly trigger: HTMLButtonElement;
  /** The menu itself: shelves that open one at a time under the trigger. */
  private readonly menu: HTMLElement;
  /** Which shelves the author has opened. Closed is the default — see {@link fillMenu}. */
  private readonly openShelves = new Set<string>();
  private menuOpen = false;
  /** Set by a click inside the menu, read and cleared by the document-level close. The mock DOM in the
   *  tests has no event bubbling, and `stopPropagation` on a real click would be a lie either way: the
   *  menu is not trying to swallow the click, only to say it was its own. */
  private menuClickGuard = false;

  constructor(root: HTMLElement, private readonly host: PickerHost) {
    this.select = root.querySelector(".el-part")!;
    this.search = root.querySelector(".el-part-search")!;
    this.count = root.querySelector(".el-part-count")!;
    this.trigger = root.querySelector(".el-part-trigger")!;
    this.menu = root.querySelector(".el-part-menu")!;
    this.trigger.addEventListener("click", () => this.toggle());
    // A click anywhere else puts the menu away. The guard above is what tells "anywhere else" from a
    // click on the menu's own shelves and rows.
    document.addEventListener("click", () => {
      if (this.menuClickGuard) this.menuClickGuard = false;
      else if (this.menuOpen) this.setOpen(false);
    });
    this.fill();
    // The browser would default a select to its first option; say so explicitly, so `value` names a real
    // part before anyone has touched it and the two agree from the start.
    this.select.value = OFFERED[0]?.id ?? "";
    // Picking a part IS choosing the tool — there is no separate "place a part" button to arm first. A
    // plain click re-arms it too, so coming back from the LED tool is one gesture rather than two.
    this.select.addEventListener("change", () => this.armPicked());
    this.select.addEventListener("click", () => this.armPicked());
    // Typing narrows the list; it never arms anything. Re-arming on every keystroke would change what the
    // next click on the canvas places while the user is still reading the names.
    for (const ev of ["input", "search"]) {
      this.search.addEventListener(ev, () => {
        // Typing is a way into the list, so the list comes out to meet it: the menu opens on the first
        // keystroke and the shelves that match open with it (see {@link fillMenu}).
        this.fill();
        if (this.search.value.trim()) this.setOpen(true);
      });
    }
    this.search.addEventListener("click", () => (this.menuClickGuard = true));
  }

  /** Whether the library menu is out. */
  get open(): boolean {
    return this.menuOpen;
  }

  /** Mark the picker as the active control (a part tool is armed) and show which part, or neither. */
  sync(part: { id: string } | null): void {
    this.select.classList.toggle("is-active", part !== null);
    this.trigger.classList.toggle("is-active", part !== null);
    if (part) this.select.value = part.id;
  }

  /**
   * Arm whatever the picker is showing — but only if it is a part that can actually be placed.
   *
   * The picker also carries rows for parts the rail cannot pass through, so that searching for a USB
   * socket finds it and says why it is not on offer. Those rows are disabled and carry no value, and a
   * browser that lets one through anyway must not leave the canvas armed with a tool that places
   * nothing.
   */
  private armPicked(withSocket = false): void {
    const id = this.select.value;
    if (PART_BY_ID.has(id)) this.host.arm(id, withSocket);
  }

  /**
   * Rebuild the picker from the search box.
   *
   * Two things have to be true at once. The list has to be short enough to read — hence the search, and
   * hence the shelves, which turn forty-odd names into eight groups of five. And a part the rail cannot
   * pass through has to be *findable*, not absent: hunting for a connector and getting an empty list
   * reads as a broken app, so a search that turns one up lists it, greyed out, under the reason. They
   * are only listed while searching; every one of them at once would put the wall straight back.
   *
   * The armed part is always in the list even when the search excludes it, so narrowing the view never
   * silently disagrees with what the next click will place.
   */
  fill(): void {
    const terms = this.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const armed = this.host.armed();
    const shown = OFFERED.filter((c) => c === armed || matches(c, terms));
    const blocked = terms.length ? BLOCKED.filter((b) => matches(b.component, terms)) : [];

    this.select.innerHTML = "";
    for (const { label } of PART_GROUPS) {
      const on = shown.filter((c) => GROUP_OF.get(c.id) === label);
      if (on.length === 0) continue;
      const group = this.addGroup(label);
      for (const c of on) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = partLabel(c);
        group.appendChild(opt);
      }
    }
    if (shown.length === 0) this.addGroup("No part matches").disabled = true;
    if (blocked.length > 0) {
      const group = this.addGroup("In the library, but not in series on a rail");
      group.disabled = true;
      for (const b of blocked.slice(0, BLOCKED_SHOWN)) {
        const opt = document.createElement("option");
        opt.disabled = true;
        opt.textContent = `${b.component.id} — ${b.why}`;
        group.appendChild(opt);
      }
      if (blocked.length > BLOCKED_SHOWN) {
        const more = document.createElement("option");
        more.disabled = true;
        more.textContent = `…and ${blocked.length - BLOCKED_SHOWN} more`;
        group.appendChild(more);
      }
    }
    // A rebuilt select forgets its selection, and the armed part is always present, so say it again.
    if (armed) this.select.value = armed.id;
    this.fillMenu(shown, blocked, terms.length > 0, armed);
    this.count.textContent = paletteCount(terms.length > 0, shown.length, blocked.length);
  }

  /**
   * Build the library menu: a shelf per group, each one closed until it is asked for.
   *
   * A native `<select>` cannot do this. It opens as one flat scroll — every offered part at once, with
   * the group headings as unclickable dividers — so the list you have to read to find a capacitor is the
   * whole library every time. Here a shelf is a button: shut, it is one line saying how many parts are
   * behind it; open, it is those parts and nothing else's.
   *
   * The `<select>` stays in the DOM beside it, hidden, and is still what holds the value. It is the model
   * this menu writes to, so `change` fires exactly as it always did, and nothing downstream of the picker
   * had to learn that the menu exists.
   *
   * Which shelves are open:
   *   - searching, every shelf with a hit — typing is a request to see the matches, not to go hunting
   *     for them behind eight more clicks;
   *   - otherwise, the ones the author opened, plus the one holding the armed part, so opening the menu
   *     always shows you where you are.
   */
  private fillMenu(
    shown: Component[], blocked: { component: Component; why: string }[], searching: boolean,
    armed: Component | undefined,
  ): void {
    this.menu.innerHTML = "";
    this.trigger.textContent = armed ? partLabel(armed) + (this.host.withSocket() ? " + socket" : "") : "Pick a part…";
    this.trigger.classList.toggle("is-empty", !armed);

    for (const { label } of PART_GROUPS) {
      const on = shown.filter((c) => GROUP_OF.get(c.id) === label);
      if (on.length === 0) continue;
      const holdsArmed = armed !== undefined && on.includes(armed);
      const open = searching || this.openShelves.has(label) || holdsArmed;
      const body = this.addShelf(label, on.length, open);
      for (const c of on) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "el-part-row";
        row.dataset.id = c.id;
        row.textContent = partLabel(c);
        // Issue #36: which header or socket the part needs, or that it needs none.
        const mount = row.appendChild(document.createElement("span"));
        mount.className = "el-part-mount";
        mount.textContent = mountingHint(mountingOf(c.id));
        row.setAttribute("role", "option");
        const isArmed = c === armed;
        row.setAttribute("aria-selected", isArmed ? "true" : "false");
        row.classList.toggle("is-armed", isArmed);
        row.addEventListener("click", () => this.choose(c.id, false));
        body.appendChild(row);
        const pair = socketAction(c.id, (id) => this.choose(id, true));
        if (pair) body.appendChild(pair);
      }
    }
    if (shown.length === 0) this.addShelf("No part matches", 0, false, true);
    if (blocked.length > 0) {
      // Open on sight: it exists only because a search turned up something the rail cannot pass through,
      // and shut behind a click it would read as "no such part".
      const body = this.addShelf("In the library, but with no terminal to wire", blocked.length, true, true);
      for (const b of blocked.slice(0, BLOCKED_SHOWN)) {
        body.appendChild(this.deadRow(`${b.component.id} — ${b.why}`));
      }
      if (blocked.length > BLOCKED_SHOWN) {
        body.appendChild(this.deadRow(`…and ${blocked.length - BLOCKED_SHOWN} more`));
      }
    }
  }

  /** One shelf: its heading button and the (possibly hidden) box its parts hang in, which is returned. */
  private addShelf(label: string, count: number, open: boolean, dead = false): HTMLElement {
    const shelf = document.createElement("div");
    shelf.className = "el-part-shelf";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "el-part-shelf-head";
    head.textContent = label;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    head.classList.toggle("is-open", open);
    head.disabled = dead;
    if (count > 0) {
      const tally = document.createElement("span");
      tally.className = "el-part-shelf-count";
      tally.textContent = String(count);
      head.appendChild(tally);
    }
    if (!dead) head.addEventListener("click", () => this.toggleShelf(label));
    const body = document.createElement("div");
    body.className = "el-part-shelf-body";
    body.hidden = !open;
    shelf.appendChild(head);
    shelf.appendChild(body);
    this.menu.appendChild(shelf);
    return body;
  }

  /** A row that names a part the picker cannot arm — the reason it cannot, spelled out. */
  private deadRow(text: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "el-part-row is-dead";
    row.textContent = text;
    return row;
  }

  /** Open a shut shelf, or shut an open one. The menu stays up: shelving is browsing, not choosing. */
  private toggleShelf(label: string): void {
    this.menuClickGuard = true;
    if (this.openShelves.has(label)) this.openShelves.delete(label);
    else this.openShelves.add(label);
    this.fill();
  }

  /** Arm the part on a menu row, and put the menu away — that one WAS the choice. */
  private choose(id: string, withSocket: boolean): void {
    this.menuClickGuard = true;
    this.select.value = id;
    this.armPicked(withSocket);
    this.setOpen(false);
    this.fill();
  }

  private toggle(): void {
    this.menuClickGuard = true;
    this.setOpen(!this.menuOpen);
  }

  /** Show or hide the menu, keeping the trigger's own state in step with it. */
  setOpen(open: boolean): void {
    this.menuOpen = open;
    this.menu.hidden = !open;
    this.trigger.setAttribute("aria-expanded", open ? "true" : "false");
    this.trigger.classList.toggle("is-open", open);
    if (open) this.fill();
  }

  /** One shelf in the picker, appended and returned so its parts can be hung on it. */
  private addGroup(label: string): HTMLOptGroupElement {
    const group = document.createElement("optgroup");
    group.setAttribute("label", label);
    this.select.appendChild(group);
    return group;
  }
}
