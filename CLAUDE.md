# kiri

This project has an Obsidian knowledge base at **`~/Documents/ObsidianPT/traceform/wiki/`**, entry point
`index.md`.

It exists so an agent can read a forty-line article instead of a two-thousand-line source file. Read the
article for the area you are about to touch, then open only the files it names. `working-agreements.md`
records the traps that have already cost time in this repo — `cloneCircuit` silently dropping fields,
`Terminal.part` renumbering, the viewer iframe that must never be re-parented.

Articles cite `file.ts › symbolName` rather than line numbers, because line numbers here rot quickly. An
article naming a symbol that no longer exists is stale, and is worth fixing in the same pass as the code.
