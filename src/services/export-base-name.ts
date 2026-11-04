/**
 * The name an export is saved under, made from whatever the viewer says the model is called.
 *
 * The viewer reports where a model came from, not just its file name: the bundled house arrives as
 * `../examples/house.fkld`. Stripping only the extension left the folders in, so the zip held entries called
 * `../examples/house/../examples/house-cut.svg` (some archive tools refuse a `..` entry or put it in the wrong
 * place) and the browser saved `_examples_house.zip`.
 *
 * So: the last path segment only, no query or fragment, no extension, and ASCII letters, digits, `.`, `-` and
 * `_`. ASCII because the zip writer does not mark names as UTF-8, so an accented name shows up garbled in some
 * extractors. Turkish letters are mapped to their plain forms (ş to s, ğ to g, ı to i) rather than dropped.
 */
const EXTENSION = /\.(fkld|fold|json|stl|obj)$/i;

export function exportBaseName(name: string, fallback = "kirigami"): string {
  const lastSegment = name.replace(/[?#].*$/, "").split(/[\\/]/).pop() ?? "";
  const stem = lastSegment.replace(EXTENSION, "");
  const plain = stem
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  const clean = plain
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.\-_]+/, "") // no leading dot or dash: that would hide the file or read as an option
    .replace(/[.\-_]+$/, "");
  return clean || fallback;
}
