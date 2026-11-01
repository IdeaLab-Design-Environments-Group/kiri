import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles.css", "utf8");

function lum(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a: string, b: string): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`missing token ${name}`);
  return m[1];
}

describe("styles.css accessibility", () => {
  it("keeps muted text readable on the page background", () => {
    expect(ratio(token("muted"), token("bg"))).toBeGreaterThanOrEqual(4.5);
  });
  it.each([
    ["white", () => "#ffffff"],
    ["--surface-soft", () => token("surface-soft")],
    ["--bg", () => token("bg")],
  ])("keeps control borders at 3:1 on %s", (_name, surface) => {
    expect(ratio(token("border-control"), surface())).toBeGreaterThanOrEqual(3);
  });
  it("has a global focus-visible ring and no bare outline: none", () => {
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent\)/);
    expect(css).not.toMatch(/outline:\s*none/);
  });
});
