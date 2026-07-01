import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/current/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@kirigami": resolve(__dirname, "kirigami"),
    },
  },
});
