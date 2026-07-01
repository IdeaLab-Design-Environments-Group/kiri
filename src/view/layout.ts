/**
 * **View** — resizable + collapsible app columns. Installs a draggable gutter
 * between the Convert card and the Viewer, with a chevron that collapses /
 * expands the left (Convert) panel. Pure DOM/CSS chrome driven by the
 * `--app-col1` width var + a `left-collapsed` class on the grid; it holds no
 * app state and emits no intents.
 */
const DEFAULT_W = 330;
const MIN_W = 220;
const MAX_W = 560;

export function installResizableLayout(
  grid: HTMLElement,
  convertEl: HTMLElement,
  viewerEl: HTMLElement,
): void {
  const setWidth = (px: number): void => {
    grid.style.setProperty("--app-col1", `${Math.max(MIN_W, Math.min(MAX_W, px))}px`);
  };

  // The gutter *is* the gap between the two cards — a thin draggable strip.
  const gutter = document.createElement("div");
  gutter.className = "col-resizer";
  gutter.setAttribute("role", "separator");
  gutter.setAttribute("aria-orientation", "vertical");
  gutter.title = "Drag to resize · double-click to reset";

  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "col-collapse";
  collapse.title = "Hide panel";
  collapse.setAttribute("aria-label", "Hide panel");
  collapse.textContent = "‹"; // ‹
  gutter.append(collapse);

  grid.insertBefore(gutter, viewerEl);

  // ---- drag the gutter to resize the left column ----
  let startX = 0;
  let startW = 0;
  const onMove = (e: MouseEvent): void => setWidth(startW + (e.clientX - startX));
  const onUp = (): void => {
    gutter.classList.remove("dragging");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  gutter.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.target === collapse) return; // the chevron owns its own click
    if (grid.classList.contains("left-collapsed")) return;
    e.preventDefault();
    startX = e.clientX;
    startW = convertEl.getBoundingClientRect().width || DEFAULT_W;
    gutter.classList.add("dragging");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  gutter.addEventListener("dblclick", () => {
    if (!grid.classList.contains("left-collapsed")) setWidth(DEFAULT_W);
  });

  // ---- collapse / expand the left (Convert) panel ----
  collapse.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    const collapsed = grid.classList.toggle("left-collapsed");
    collapse.textContent = collapsed ? "›" : "‹"; // › / ‹
    collapse.title = collapsed ? "Show panel" : "Hide panel";
    collapse.setAttribute("aria-label", collapse.title);
  });
}
