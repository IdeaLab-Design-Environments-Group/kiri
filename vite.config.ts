import { defineConfig } from "vite";
import { resolve } from "node:path";

// Relative base so the built site works under any path (static host, GitHub
// Pages project page, or file://-style preview). Override with VITE_BASE.
//
// The transferred AKDE creation pipeline lives under `kirigami/` (TypeScript),
// reached via the `@kirigami` alias. The FKLD format library is consumed from
// the `@dayangac/fkld` npm package (no longer vendored in-repo).
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  resolve: {
    alias: {
      "@kirigami": resolve(__dirname, "kirigami"),
    },
  },
  server: { open: true },
  build: { outDir: "dist", emptyOutDir: true },
});
