/**
 * **Model** — importing someone else's SVG (a PCB drawing) safely.
 *
 * An imported file is untrusted: it arrives from a board house, a KiCad plot, a download, and it ends up
 * rendered *inside the app's own page*, where it would run with the app's origin and see the app's DOM. So the
 * file is never handed to the browser as-is. It is scanned here, as text, and everything that could act rather
 * than draw is removed before any of it reaches the document.
 *
 * The scan is deliberately a plain string tokeniser rather than `DOMParser`: this module is model code, it runs
 * under the node test environment where there is no DOM, and parsing through the browser would mean building
 * the very nodes we are trying to vet. What comes back is the *inner* markup of the root `<svg>` plus its
 * viewBox, so the view can wrap it in an `<svg>` of its own and pan/zoom it like the layout canvas — the
 * imported root element, with whatever width/height/style it declared, never becomes an element of the page.
 *
 * This is a sanitiser, not a validator: anything it does not recognise as dangerous is passed through, so the
 * drawing still looks like the drawing. Coordinates are the file's own units; nothing is rescaled.
 */

/** A rectangle in the imported file's own user units — its viewBox, or one inferred from width/height. */
export interface SvgBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImportedSvg {
  /** Sanitised markup from *inside* the root `<svg>`, ready to be placed in an `<svg>` the app owns. */
  inner: string;
  /** The coordinate window the markup was authored against, so the view can frame it. */
  viewBox: SvgBox;
  /** What was taken out, so the user can be told rather than silently shown a different drawing. */
  removed: {
    /** `<script>`, `<style>`, `<foreignObject>`, … — elements dropped whole, with their contents. */
    elements: number;
    /** `on*` attributes — inline event handlers. */
    handlers: number;
    /** `href` / `xlink:href` / `style: url(…)` pointing outside the file. */
    externalRefs: number;
  };
}

export class SvgImportError extends Error {}

/**
 * Elements dropped entirely, contents and all.
 *
 * - `script` runs JavaScript in the app's origin — the whole reason this module exists.
 * - `foreignObject` embeds arbitrary HTML, which is a second door to the same place (iframes, scripts, forms).
 * - `style` is not scoped to the imported drawing: an inline stylesheet applies to the *whole page*, so an
 *   imported file could restyle or hide the app around it, and its `@import`/`url()` rules fetch from the
 *   network. Presentation attributes on the shapes themselves survive, so most drawings still look right.
 * - `handler` is SVG's own event-handler element (SVG Tiny 1.2) — a `script` by another name.
 * - `animate`, `animateTransform`, `animateMotion` and `set` can rewrite *any* attribute after load, including
 *   one this pass just cleaned, so a file could smuggle a `javascript:` href past a static scan.
 */
const DROP_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "style",
  "handler",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
]);

/** Attributes that name a resource, and so are the ones that can reach off the file. */
const REF_ATTRS = new Set(["href", "xlink:href", "src", "xlink:src"]);

/**
 * Sanitise `source` and pull out what the view needs to draw it.
 *
 * Throws {@link SvgImportError} when there is no root `<svg>` at all — a file that is not an SVG cannot be
 * shown, and failing loudly is better than rendering an empty frame the user has to guess about.
 */
export function importSvg(source: string): ImportedSvg {
  const removed = { elements: 0, handlers: 0, externalRefs: 0 };
  // Comments and the XML prolog/doctype are dropped before anything else: a comment can hide an unbalanced
  // tag that would otherwise confuse the scan below, and a DOCTYPE can declare external entities.
  const text = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");

  const root = findRoot(text);
  const viewBox = rootBox(root.attrs);

  const out: string[] = [];
  let i = root.contentStart;
  // Depth of the dropped subtree we are currently inside, if any. Everything is skipped while it is > 0, which
  // is what makes a `<script>`'s *contents* go away and not just its tags.
  let skipDepth = 0;
  let skipName = "";

  while (i < root.contentEnd) {
    const lt = text.indexOf("<", i);
    if (lt < 0 || lt >= root.contentEnd) {
      if (skipDepth === 0) out.push(text.slice(i, root.contentEnd));
      break;
    }
    if (skipDepth === 0) out.push(text.slice(i, lt));
    const tag = readTag(text, lt);
    if (!tag) {
      // A bare "<" that never closes: keep going past it rather than looping forever.
      i = lt + 1;
      continue;
    }
    i = tag.end;

    if (skipDepth > 0) {
      // Inside a dropped element: only its own open/close tags matter, to find where it ends.
      if (tag.name === skipName && !tag.selfClosing) skipDepth += tag.closing ? -1 : 1;
      if (skipDepth === 0) skipName = "";
      continue;
    }
    if (tag.closing) {
      out.push(`</${tag.name}>`);
      continue;
    }
    if (DROP_ELEMENTS.has(tag.name)) {
      removed.elements++;
      if (!tag.selfClosing) {
        skipDepth = 1;
        skipName = tag.name;
      }
      continue;
    }
    out.push(cleanTag(tag, removed));
  }

  return { inner: out.join(""), viewBox, removed };
}

// ---- tag scanning ----------------------------------------------------------

interface Tag {
  name: string;
  attrs: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
}

/** Read one tag starting at `<`. Quotes are tracked so a `>` inside an attribute value does not end the tag. */
function readTag(text: string, start: number): Tag | null {
  let quote = "";
  let end = -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let body = text.slice(start + 1, end);
  const closing = body.startsWith("/");
  if (closing) body = body.slice(1);
  const selfClosing = body.endsWith("/");
  if (selfClosing) body = body.slice(0, -1);
  const m = /^([A-Za-z_][\w.:-]*)/.exec(body.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  return { name, attrs: body.trim().slice(m[1]!.length), closing, selfClosing, end: end + 1 };
}

/** Re-emit an open tag with the dangerous attributes left out. */
function cleanTag(tag: Tag, removed: ImportedSvg["removed"]): string {
  const kept: string[] = [];
  for (const attr of parseAttrs(tag.attrs)) {
    const name = attr.name.toLowerCase();
    // Inline event handlers are JavaScript that runs on user interaction with the drawing.
    if (name.startsWith("on")) {
      removed.handlers++;
      continue;
    }
    if (REF_ATTRS.has(name)) {
      // References may point only *inside* the file: a `#fragment` (its own defs, gradients, `<use>` targets)
      // or an embedded `data:` payload. Anything else is a request off to another host — which leaks that the
      // file was opened and by whom, and lets the drawing change after the fact — or a `javascript:` URL,
      // which is a script with extra steps.
      if (!isSelfContainedRef(attr.value)) {
        removed.externalRefs++;
        continue;
      }
    } else if (/^\s*(javascript|vbscript)\s*:/i.test(decodeEntities(attr.value))) {
      // A script URL hiding in some other attribute this pass does not otherwise know about.
      removed.externalRefs++;
      continue;
    }
    // `url(…)` in a style attribute is a fetch (or, historically, `url(javascript:…)`), so a style that
    // carries one is dropped rather than half-cleaned.
    if (name === "style" && /url\s*\(/i.test(attr.value)) {
      removed.externalRefs++;
      continue;
    }
    kept.push(attr.raw);
  }
  const attrs = kept.length ? " " + kept.join(" ") : "";
  return `<${tag.name}${attrs}${tag.selfClosing ? " /" : ""}>`;
}

interface Attr {
  name: string;
  value: string;
  raw: string;
}

function parseAttrs(src: string): Attr[] {
  const out: Attr[] = [];
  const re = /([A-Za-z_:][\w.:-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rawValue = m[2] ?? "";
    const value = rawValue.replace(/^["']|["']$/g, "");
    out.push({ name: m[1]!, value, raw: m[0]! });
  }
  return out;
}

/** True when a reference stays inside the file: a same-document fragment or an inline `data:` payload. */
function isSelfContainedRef(value: string): boolean {
  const v = decodeEntities(value).trim();
  if (v.startsWith("#")) return true;
  // Only inert data payloads: `data:` can also carry HTML or SVG, which would bring scripts back in through
  // an `<image>` or a `<use>`.
  return /^data:image\/(png|jpeg|jpg|gif|webp);/i.test(v);
}

/** Undo the entity escapes an attacker would use to hide a scheme (`&#106;avascript:` and friends). */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([\da-f]+);?/gi, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => codePoint(parseInt(dec, 10)))
    .replace(/&(amp|quot|apos|lt|gt);/gi, (_, name) => {
      const map: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
      return map[String(name).toLowerCase()] ?? "";
    })
    // Control characters and whitespace are ignored inside a URL scheme by browsers (a tab inside "javascript:" still runs), so
    // they are ignored here too rather than letting them split a scheme in half.
    .replace(/[\u0000-\u0020\u00a0]/g, "");
}

/** A code point from a numeric entity, or nothing when the file gives one that is not a character at all. */
function codePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

interface Root {
  attrs: string;
  contentStart: number;
  contentEnd: number;
}

/** Locate the root `<svg>` element and the span of its contents. */
function findRoot(text: string): Root {
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    const tag = readTag(text, lt);
    if (!tag) break;
    if (tag.name === "svg" && !tag.closing) {
      // An empty root (`<svg … />`) is legal and simply draws nothing.
      if (tag.selfClosing) return { attrs: tag.attrs, contentStart: tag.end, contentEnd: tag.end };
      const close = text.toLowerCase().lastIndexOf("</svg");
      return { attrs: tag.attrs, contentStart: tag.end, contentEnd: close > tag.end ? close : text.length };
    }
    i = tag.end;
  }
  throw new SvgImportError("No <svg> element found — is this an SVG file?");
}

/**
 * The window the file was drawn against.
 *
 * A viewBox is used as given. Without one, width/height stand in — an SVG with only those is drawn in user
 * units from the origin. With neither there is nothing to go on, so a unit square is assumed and the view's
 * fit-to-frame does the rest.
 */
function rootBox(attrs: string): SvgBox {
  const map = new Map(parseAttrs(attrs).map((a) => [a.name.toLowerCase(), a.value]));
  const vb = (map.get("viewbox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every((n) => Number.isFinite(n)) && vb[2]! > 0 && vb[3]! > 0) {
    return { x: vb[0]!, y: vb[1]!, w: vb[2]!, h: vb[3]! };
  }
  const w = lengthOf(map.get("width"));
  const h = lengthOf(map.get("height"));
  if (w && h) return { x: 0, y: 0, w, h };
  return { x: 0, y: 0, w: 1, h: 1 };
}

/** A CSS length as a bare number — the unit is dropped, since the view only needs proportions. */
function lengthOf(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*([\d.+-]+(?:e[+-]?\d+)?)/i.exec(value);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
