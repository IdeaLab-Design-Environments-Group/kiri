/**
 * **View** — the "+ socket" action beside a library row for a part that goes in a socket (issue #36).
 *
 * A sibling of the row rather than a child: the row is itself a button, and a button inside a button is
 * not valid HTML. Clicking the row arms the part alone, exactly as before; clicking this arms it with its
 * socket, so the next drop puts down both.
 */
import { mountingOf } from "../model/part-mounting.js";

/** The action for the part with this id, or null when it needs no socket. */
export function socketAction(id: string, choose: (id: string) => void): HTMLButtonElement | null {
  const m = mountingOf(id);
  if (m.kind !== "needs-socket") return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "el-part-with-socket";
  btn.dataset.id = id;
  btn.textContent = "+ socket";
  btn.title = `Place ${id} together with its socket, ${m.socket}`;
  btn.addEventListener("click", () => choose(id));
  return btn;
}
