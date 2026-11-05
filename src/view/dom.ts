/** Tiny DOM helpers shared by the view layer. */
export function el(tag: string, className = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function heading(level: "h2" | "h3", text: string): HTMLElement {
  const node = document.createElement(level);
  node.textContent = text;
  return node;
}

/**
 * Save `blob` as `filename` through a temporary link: how every export in the app reaches the downloads folder.
 * It was written out twice, character for character, in the export dialog and in the Electronics editor.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Render an ordered list of term/value pairs into a <dl>, replacing its contents. */
export function renderDefinitionList(dl: HTMLDListElement, rows: Iterable<[string, string]>): void {
  dl.innerHTML = "";
  for (const [term, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }
}
