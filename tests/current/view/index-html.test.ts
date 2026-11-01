import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("index.html", () => {
  it("declares an inline favicon so the browser never requests /favicon.ico", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toMatch(/<link rel="icon" href="data:image\/svg\+xml,/);
  });
});
