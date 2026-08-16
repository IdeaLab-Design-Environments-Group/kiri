import { describe, expect, it } from "vitest";
import { SvgImportError, importSvg } from "../../../src/model/svg-import.js";

/** Wrap a fragment in a minimal root, so each test says only what it is about. */
const svg = (inner: string, attrs = 'viewBox="0 0 100 50"'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe("model/svg-import", () => {
  it("keeps the drawing", () => {
    // The point of a sanitiser is that the drawing still looks like the drawing: anything not dangerous
    // survives, attributes and all.
    const out = importSvg(svg('<path d="M0 0 L10 10" fill="#f00" stroke-width="0.5" /><circle cx="5" cy="5" r="2"/>'));
    expect(out.inner).toContain('d="M0 0 L10 10"');
    expect(out.inner).toContain('fill="#f00"');
    expect(out.inner).toContain("<circle");
    expect(out.removed).toEqual({ elements: 0, handlers: 0, externalRefs: 0 });
  });

  it("reads the viewBox, and falls back to width/height", () => {
    expect(importSvg(svg("<g/>", 'viewBox="1 2 30 40"')).viewBox).toEqual({ x: 1, y: 2, w: 30, h: 40 });
    expect(importSvg(svg("<g/>", 'width="80mm" height="60mm"')).viewBox).toEqual({ x: 0, y: 0, w: 80, h: 60 });
    // Neither: a unit square, which the view's fit-to-frame then scales.
    expect(importSvg(svg("<g/>", "")).viewBox).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("refuses a file that is not an SVG at all", () => {
    // Failing loudly beats rendering an empty frame the user has to guess about.
    expect(() => importSvg("<html><body>nope</body></html>")).toThrow(SvgImportError);
    expect(() => importSvg("")).toThrow(SvgImportError);
  });

  describe("what it strips", () => {
    it("drops a script and everything inside it", () => {
      const out = importSvg(svg('<script>alert(1)</script><rect width="1" height="1"/>'));
      expect(out.inner).not.toContain("alert");
      expect(out.inner).not.toContain("script");
      expect(out.inner).toContain("<rect");
      expect(out.removed.elements).toBe(1);
    });

    it("drops inline event handlers but keeps the shape", () => {
      const out = importSvg(svg('<rect onload="alert(1)" onclick="steal()" width="2" height="2"/>'));
      expect(out.inner).not.toMatch(/onload|onclick|alert|steal/);
      expect(out.inner).toContain('width="2"');
      expect(out.removed.handlers).toBe(2);
    });

    it("drops references that leave the file, and keeps ones that do not", () => {
      const out = importSvg(
        svg(
          '<use href="#local"/><image href="https://evil.example/x.png"/>' +
            '<image href="data:image/png;base64,AAAA"/><a xlink:href="javascript:alert(1)"/>',
        ),
      );
      expect(out.inner).toContain('href="#local"');
      expect(out.inner).toContain("data:image/png");
      expect(out.inner).not.toContain("evil.example");
      expect(out.inner).not.toContain("javascript:");
      expect(out.removed.externalRefs).toBe(2);
    });

    it("sees through entity-escaped and whitespace-split schemes", () => {
      // The obvious dodges: hide the scheme from a plain string match.
      const escaped = importSvg(svg('<a href="&#106;avascript:alert(1)"/>'));
      expect(escaped.inner).not.toContain("avascript");
      const split = importSvg(svg('<a href="java\tscript:alert(1)"/>'));
      expect(split.inner).not.toContain("script:");
    });

    it("drops a style element, and a style attribute that fetches", () => {
      // An inline stylesheet is not scoped to the drawing — it restyles the app around it — and its url()
      // rules fetch from the network.
      const el = importSvg(svg("<style>.a{fill:red}</style><rect/>"));
      expect(el.inner).not.toContain("fill:red");
      expect(el.removed.elements).toBe(1);

      const attr = importSvg(svg('<rect style="fill:url(https://evil.example/x)"/>'));
      expect(attr.inner).not.toContain("evil.example");
      // A style attribute that only paints is left alone.
      const plain = importSvg(svg('<rect style="fill:red"/>'));
      expect(plain.inner).toContain("fill:red");
    });

    it("drops the animation elements that could rewrite a cleaned attribute after load", () => {
      const out = importSvg(svg('<rect><set attributeName="href" to="javascript:alert(1)"/></rect>'));
      expect(out.inner).not.toContain("javascript");
      expect(out.removed.elements).toBe(1);
    });

    it("drops foreignObject, which is a door back to arbitrary HTML", () => {
      const out = importSvg(svg("<foreignObject><iframe src='https://evil.example'></iframe></foreignObject>"));
      expect(out.inner).not.toContain("iframe");
      expect(out.inner).not.toContain("evil.example");
      expect(out.removed.elements).toBe(1);
    });

    it("is not fooled by a > inside an attribute value", () => {
      // A naive scan splits the tag here and lets the rest through unchecked.
      const out = importSvg(svg(`<rect data-note="a > b" onclick="alert(1)"/>`));
      expect(out.inner).not.toContain("onclick");
      expect(out.inner).toContain("data-note");
    });

    it("drops a comment that hides a tag, rather than letting it reappear", () => {
      const out = importSvg(svg("<!-- <script>alert(1)</script> --><rect/>"));
      expect(out.inner).not.toContain("alert");
      expect(out.inner).toContain("<rect");
    });

    it("drops a DOCTYPE, which can declare external entities", () => {
      const out = importSvg(
        '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 1 1"><rect/></svg>',
      );
      expect(out.inner).not.toContain("ENTITY");
      expect(out.inner).not.toContain("passwd");
    });

    it("does not hang on a malformed tag that never closes", () => {
      // A file can be truncated or simply broken; the scan must still terminate.
      const out = importSvg('<svg viewBox="0 0 1 1"><rect <rect width="1"/></svg>');
      expect(typeof out.inner).toBe("string");
    });
  });
});
