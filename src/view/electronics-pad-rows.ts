/**
 * The pad rows of the parts panel: one row per pad of the selected part, with the net it is on.
 *
 * Built here rather than in the editor, which is over its line budget. Pure DOM in, callbacks out: nothing
 * in this file reaches the circuit; the editor decides what putting a pad on a net means.
 */
import type { PadPanel } from "./electronics-presenters.js";

export interface PadRowHandlers {
  /** Put the pad on the net of this name (declaring it if new). `""` takes the pad off its net. */
  assign(pad: string, netName: string): void;
}

/**
 * Fill `into` with the datalist and the rows of `panel`.
 *
 * Each row has a clear button that takes the pad off its net, and the box commits as soon as it is emptied
 * rather than only on blur or Enter: emptying the box is the whole gesture for "none", and waiting for a
 * blur made it look as if nothing had happened. After such a commit the panel is rebuilt, so focus is put
 * back on the same box to keep typing from being cut off.
 */
export function fillPadRows(into: HTMLElement, panel: PadPanel, listId: string, on: PadRowHandlers): void {
  const list = document.createElement("datalist");
  list.id = listId;
  for (const name of panel.suggestions) {
    const opt = document.createElement("option");
    opt.value = name;
    list.appendChild(opt);
  }
  into.appendChild(list);

  for (const pad of panel.rows) {
    const row = document.createElement("div");
    row.className = "el-pad";
    row.setAttribute("role", "treeitem");
    if (pad.last) row.classList.add("is-last");

    const tag = document.createElement("span");
    tag.className = "el-pad-name";
    tag.textContent = pad.pad;
    tag.title = pad.padTitle;

    const dot = document.createElement("i");
    dot.className = "el-pad-dot";
    // `setAttribute`, not `.style` — the same way the nets tree colours its own dots, and the only one
    // the test DOM implements. Held at zero size rather than dropped when the pad is on nothing, so the
    // names stay aligned.
    if (pad.colour) dot.setAttribute("style", `background:${pad.colour}`);
    else dot.classList.add("is-empty");

    const name = document.createElement("input");
    name.type = "text";
    name.className = "el-pad-net";
    name.value = pad.netName;
    name.placeholder = "—";
    name.dataset.pad = pad.pad;
    name.setAttribute("list", listId);
    name.setAttribute("aria-label", `Net for pad ${pad.pad}`);
    name.title = "type a net name. A name that is not yet a net declares it; empty takes the pad off.";
    name.addEventListener("change", () => on.assign(pad.pad, name.value));
    name.addEventListener("input", () => {
      if (pad.netName === "" || name.value.trim() !== "") return;
      on.assign(pad.pad, "");
      const again = Array.from(into.querySelectorAll<HTMLInputElement>(".el-pad-net")).find((b) => b.dataset.pad === pad.pad);
      again?.focus?.();
    });

    const off = document.createElement("button");
    off.type = "button";
    off.className = "el-pad-off";
    off.textContent = "×";
    off.title = `Take pad ${pad.pad} off its net`;
    off.setAttribute("aria-label", `Clear net of pad ${pad.pad}`);
    if (pad.netName === "") off.hidden = true;
    off.addEventListener("click", () => on.assign(pad.pad, ""));

    row.appendChild(tag);
    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(off);
    into.appendChild(row);
  }
}
