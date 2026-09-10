# Jump audit

`npx vite-node scripts/_jump-audit.ts` — 29 bundled patterns, toll `JUMP_TOLL_DIAGS` at its module default.

## Adjacency over the corpus

| pattern | source | pairs | rim pairs (lips > 5 units apart) |
|---|---|---:|---:|
| akde-decagon-pyramid.fkld | goal-frame | 20 | 10 |
| akde-hex.fkld | goal-frame | 6 | 6 |
| bat-body.fkld | goal-frame | 89 | 41 |
| bat-ear-left.fkld | goal-frame | 11 | 5 |
| bat-ear-right.fkld | goal-frame | 11 | 5 |
| bat-wing-left.fkld | goal-frame | 32 | 11 |
| bat-wing-right.fkld | goal-frame | 32 | 11 |
| church.fkld | goal-frame | 6 | 0 |
| clock-base.fkld | goal-frame | 8 | 8 |
| clock-case.fkld | goal-frame | 95 | 58 |
| desk-lamp-base.fkld | goal-frame | 35 | 19 |
| desk-lamp-shade.fkld | goal-frame | 56 | 27 |
| drums-bass.fkld | goal-frame | 50 | 46 |
| drums-tom-high.fkld | goal-frame | 46 | 41 |
| drums-tom-low.fkld | goal-frame | 47 | 38 |
| guitar-headstock.fkld | goal-frame | 44 | 15 |
| guitar-lower-bout.fkld | goal-frame | 64 | 38 |
| guitar-neck.fkld | goal-frame | 19 | 11 |
| guitar-upper-bout.fkld | goal-frame | 49 | 27 |
| house.fkld | goal-frame | 9 | 0 |
| puffin.fkld | goal-frame | 49 | 28 |
| teapot-body.fkld | goal-frame | 125 | 80 |
| teapot-spout.fkld | goal-frame | 4 | 3 |
| thermometer-bulb.fkld | goal-frame | 71 | 25 |
| thermometer-tube.fkld | goal-frame | 45 | 32 |

Skipped, no pairs to rejoin: akde-square-pyramid.fkld (none), bistable-star-tiling.fkld (goal-frame), kirigami-flap.fkld (goal-frame), teapot-handle-solid.fkld (goal-frame).

## Sweep

Rotation 0 only; the other three are in the next section. `stranded`, `copper` and `cross` are given as before → after, where "after" is the arm handed the pattern's `foldAdjacency`. `clash` is `countJumpClashes` on the after arm, `clear` the closest two different nets come there.

| pattern | nets | stranded | jumps | copper | cross | clash | clear |
|---|---:|---|---:|---|---|---:|---:|
| akde-decagon-pyramid.fkld | 2 | 0 → 0 | 0 | 25.0 → 25.0 | 0 → 0 | 0 | 201.339 |
| akde-decagon-pyramid.fkld | 3 | 0 → 0 | 0 | 37.5 → 37.5 | 0 → 0 | 0 | 72.469 |
| akde-decagon-pyramid.fkld | 4 | 0 → 0 | 0 | 50.0 → 50.0 | 0 → 0 | 0 | 72.469 |
| akde-decagon-pyramid.fkld | 5 | 0 → 0 | 0 | 62.5 → 62.5 | 0 → 0 | 0 | 72.469 |
| akde-hex.fkld | 2 | 0 → 0 | 0 | 45.8 → 45.8 | 0 → 0 | 0 | 186.032 |
| akde-hex.fkld | 3 | 0 → 0 | 0 | 68.7 → 68.7 | 0 → 0 | 0 | 79.828 |
| akde-hex.fkld | 4 | 0 → 0 | 0 | 91.5 → 91.5 | 0 → 0 | 0 | 79.828 |
| akde-hex.fkld | 5 | 0 → 0 | 0 | 114.4 → 114.4 | 0 → 0 | 0 | 79.828 |
| bat-body.fkld | 2 | 1 → 0 | 2 | 162.9 → 14.5 | 0 → 0 | 0 | 5.651 |
| bat-body.fkld | 3 | 2 → 0 | 3 | 159.6 → 23.5 | 0 → 0 | 0 | 5.651 |
| bat-body.fkld | 4 | 3 → 0 | 4 | 158.8 → 29.1 | 0 → 0 | 0 | 5.651 |
| bat-body.fkld | 5 | 4 → 0 | 5 | 158.8 → 35.9 | 0 → 0 | 0 | 4.010 |
| bat-ear-left.fkld | 2 | 0 → 0 | 2 | 61.1 → 5.8 | 0 → 0 | 0 | 4.039 |
| bat-ear-left.fkld | 3 | 1 → 0 | 3 | 56.8 → 9.6 | 0 → 0 | 0 | 3.418 |
| bat-ear-left.fkld | 4 | 2 → 0 | 4 | 48.6 → 18.4 | 0 → 0 | 0 | 3.418 |
| bat-ear-left.fkld | 5 | 2 → 0 | 5 | 64.9 → 24.7 | 0 → 0 | 0 | 3.418 |
| bat-ear-right.fkld | 2 | 0 → 0 | 2 | 61.1 → 5.8 | 0 → 0 | 0 | 4.039 |
| bat-ear-right.fkld | 3 | 1 → 0 | 3 | 56.8 → 9.6 | 0 → 0 | 0 | 3.418 |
| bat-ear-right.fkld | 4 | 2 → 0 | 4 | 48.6 → 18.4 | 0 → 0 | 0 | 3.418 |
| bat-ear-right.fkld | 5 | 2 → 0 | 5 | 64.9 → 24.7 | 0 → 0 | 0 | 3.418 |
| bat-wing-left.fkld | 2 | 1 → 0 | 2 | 235.4 → 20.9 | 0 → 0 | 0 | 10.916 |
| bat-wing-left.fkld | 3 | 2 → 0 | 3 | 235.4 → 30.4 | 0 → 0 | 0 | 9.814 |
| bat-wing-left.fkld | 4 | 3 → 0 | 4 | 208.0 → 40.3 | 0 → 0 | 0 | 9.561 |
| bat-wing-left.fkld | 5 | 4 → 0 | 5 | 208.0 → 49.1 | 0 → 0 | 0 | 9.561 |
| bat-wing-right.fkld | 2 | 1 → 0 | 2 | 235.4 → 20.9 | 0 → 0 | 0 | 10.916 |
| bat-wing-right.fkld | 3 | 2 → 0 | 3 | 235.4 → 30.4 | 0 → 0 | 0 | 9.814 |
| bat-wing-right.fkld | 4 | 3 → 0 | 4 | 208.0 → 40.3 | 0 → 0 | 0 | 9.561 |
| bat-wing-right.fkld | 5 | 4 → 0 | 5 | 208.0 → 49.1 | 0 → 0 | 0 | 9.561 |
| church.fkld | 2 | 0 → 0 | 2 | 6.4 → 1.1 | 0 → 0 | 0 | 1.353 |
| church.fkld | 3 | 1 → 0 | 3 | 5.4 → 2.0 | 0 → 0 | 0 | 0.785 |
| church.fkld | 4 | 2 → 0 | 4 | 4.7 → 2.7 | 0 → 0 | 0 | 0.250 |
| clock-base.fkld | 2 | 0 → 0 | 2 | 205.9 → 32.5 | 0 → 0 | 0 | 15.054 |
| clock-base.fkld | 3 | 0 → 0 | 3 | 302.7 → 63.3 | 0 → 0 | 0 | 12.384 |
| clock-base.fkld | 4 | 0 → 0 | 4 | 404.7 → 78.6 | 0 → 0 | 0 | 12.384 |
| clock-base.fkld | 5 | 1 → 0 | 5 | 357.1 → 118.1 | 0 → 0 | 0 | 7.133 |
| clock-case.fkld | 2 | 0 → 0 | 2 | 442.1 → 23.5 | 0 → 0 | 0 | 4.515 |
| clock-case.fkld | 3 | 1 → 0 | 3 | 440.8 → 30.9 | 0 → 0 | 0 | 4.356 |
| clock-case.fkld | 4 | 2 → 0 | 4 | 439.8 → 46.1 | 0 → 0 | 0 | 4.356 |
| clock-case.fkld | 5 | 3 → 0 | 5 | 439.8 → 61.3 | 0 → 0 | 0 | 4.356 |
| desk-lamp-base.fkld | 2 | 0 → 0 | 2 | 295.5 → 38.4 | 0 → 0 | 0 | 18.706 |
| desk-lamp-base.fkld | 3 | 0 → 0 | 3 | 443.3 → 57.6 | 0 → 0 | 0 | 14.762 |
| desk-lamp-base.fkld | 4 | 0 → 0 | 4 | 603.1 → 74.2 | 0 → 0 | 0 | 14.762 |
| desk-lamp-base.fkld | 5 | 0 → 0 | 5 | 753.8 → 86.6 | 0 → 0 | 0 | 14.762 |
| desk-lamp-shade.fkld | 2 | 0 → 0 | 2 | 585.6 → 46.3 | 0 → 0 | 0 | 12.225 |
| desk-lamp-shade.fkld | 3 | 1 → 0 | 3 | 585.6 → 68.4 | 0 → 0 | 0 | 8.686 |
| desk-lamp-shade.fkld | 4 | 2 → 0 | 4 | 585.6 → 87.7 | 0 → 0 | 0 | 8.686 |
| desk-lamp-shade.fkld | 5 | 3 → 0 | 5 | 585.6 → 106.4 | 0 → 0 | 0 | 6.821 |
| drums-bass.fkld | 2 | 0 → 0 | 2 | 603.2 → 65.2 | 0 → 0 | 0 | 3.859 |
| drums-bass.fkld | 3 | 0 → 0 | 3 | 887.0 → 85.2 | 0 → 0 | 0 | 3.859 |
| drums-bass.fkld | 4 | 1 → 1 | 3 | 886.5 → 85.2 | 0 → 0 | 0 | 3.859 |
| drums-bass.fkld | 5 | 2 → 1 | 4 | 886.5 → 105.4 | 0 → 0 | 0 | 3.859 |
| drums-tom-high.fkld | 2 | 0 → 0 | 2 | 307.6 → 22.7 | 0 → 0 | 0 | 14.378 |
| drums-tom-high.fkld | 3 | 0 → 0 | 3 | 426.6 → 36.2 | 0 → 0 | 0 | 5.981 |
| drums-tom-high.fkld | 4 | 1 → 0 | 4 | 425.1 → 49.2 | 0 → 0 | 0 | 3.788 |
| drums-tom-high.fkld | 5 | 2 → 0 | 5 | 423.7 → 62.3 | 0 → 0 | 0 | 3.788 |
| drums-tom-low.fkld | 2 | 0 → 0 | 2 | 360.0 → 24.8 | 0 → 0 | 0 | 14.903 |
| drums-tom-low.fkld | 3 | 0 → 0 | 3 | 476.7 → 39.4 | 0 → 0 | 0 | 6.683 |
| drums-tom-low.fkld | 4 | 0 → 0 | 4 | 637.2 → 53.3 | 0 → 0 | 0 | 4.219 |
| drums-tom-low.fkld | 5 | 1 → 0 | 5 | 637.2 → 67.9 | 0 → 0 | 0 | 4.219 |
| guitar-headstock.fkld | 2 | 0 → 0 | 2 | 185.3 → 16.3 | 0 → 0 | 0 | 8.488 |
| guitar-headstock.fkld | 3 | 1 → 0 | 3 | 171.8 → 23.1 | 0 → 0 | 0 | 7.511 |
| guitar-headstock.fkld | 4 | 2 → 0 | 4 | 158.3 → 29.9 | 0 → 0 | 0 | 7.511 |
| guitar-headstock.fkld | 5 | 3 → 0 | 5 | 145.1 → 36.7 | 0 → 0 | 0 | 4.481 |
| guitar-lower-bout.fkld | 2 | 0 → 0 | 2 | 446.6 → 34.7 | 0 → 0 | 0 | 16.517 |
| guitar-lower-bout.fkld | 3 | 1 → 0 | 3 | 446.6 → 53.6 | 0 → 0 | 0 | 15.035 |
| guitar-lower-bout.fkld | 4 | 2 → 0 | 4 | 446.6 → 72.4 | 0 → 0 | 0 | 15.035 |
| guitar-lower-bout.fkld | 5 | 3 → 0 | 5 | 446.6 → 91.6 | 0 → 0 | 0 | 7.696 |
| guitar-neck.fkld | 2 | 0 → 0 | 2 | 246.1 → 46.8 | 0 → 0 | 0 | 27.508 |
| guitar-neck.fkld | 3 | 1 → 0 | 3 | 209.2 → 69.3 | 0 → 0 | 0 | 10.314 |
| guitar-neck.fkld | 4 | 1 → 0 | 4 | 298.6 → 109.1 | 0 → 0 | 0 | 6.291 |
| guitar-neck.fkld | 5 | 2 → 0 | 5 | 271.4 → 143.0 | 0 → 0 | 0 | 4.536 |
| guitar-upper-bout.fkld | 2 | 0 → 0 | 2 | 397.6 → 25.8 | 0 → 0 | 0 | 10.611 |
| guitar-upper-bout.fkld | 3 | 1 → 0 | 3 | 389.5 → 36.5 | 0 → 0 | 0 | 8.011 |
| guitar-upper-bout.fkld | 4 | 2 → 0 | 4 | 389.5 → 48.6 | 0 → 0 | 0 | 8.011 |
| guitar-upper-bout.fkld | 5 | 3 → 0 | 5 | 389.5 → 62.3 | 0 → 0 | 0 | 8.011 |
| house.fkld | 2 | 0 → 0 | 2 | 8.0 → 1.4 | 0 → 0 | 0 | 0.395 |
| house.fkld | 3 | 1 → 0 | 3 | 7.6 → 2.0 | 0 → 0 | 0 | 0.395 |
| house.fkld | 4 | 2 → 0 | 4 | 5.9 → 2.8 | 0 → 0 | 0 | 0.333 |
| house.fkld | 5 | 3 → 0 | 5 | 4.8 → 3.7 | 0 → 0 | 0 | 0.333 |
| puffin.fkld | 2 | 0 → 0 | 2 | 356.7 → 36.6 | 0 → 0 | 0 | 15.589 |
| puffin.fkld | 3 | 0 → 0 | 3 | 504.1 → 59.0 | 0 → 0 | 0 | 15.589 |
| puffin.fkld | 4 | 0 → 0 | 4 | 602.3 → 77.7 | 0 → 0 | 0 | 15.589 |
| puffin.fkld | 5 | 1 → 0 | 5 | 562.7 → 94.1 | 0 → 0 | 0 | 6.587 |
| teapot-body.fkld | 2 | 1 → 0 | 2 | 335.8 → 22.6 | 0 → 0 | 0 | 10.036 |
| teapot-body.fkld | 3 | 2 → 0 | 3 | 312.2 → 33.8 | 0 → 0 | 0 | 10.036 |
| teapot-body.fkld | 4 | 2 → 0 | 4 | 554.0 → 44.8 | 0 → 0 | 0 | 4.488 |
| teapot-body.fkld | 5 | 3 → 0 | 5 | 472.9 → 57.0 | 0 → 0 | 0 | 4.488 |
| teapot-spout.fkld | 2 | 0 → 0 | 2 | 61.9 → 32.9 | 0 → 0 | 0 | 4.744 |
| teapot-spout.fkld | 3 | 1 → 0 | 3 | 55.7 → 48.0 | 0 → 0 | 0 | 1.300 |
| thermometer-bulb.fkld | 2 | 1 → 0 | 2 | 109.5 → 12.2 | 0 → 0 | 0 | 6.455 |
| thermometer-bulb.fkld | 3 | 2 → 0 | 3 | 95.6 → 19.4 | 0 → 0 | 0 | 5.180 |
| thermometer-bulb.fkld | 4 | 2 → 0 | 4 | 197.1 → 26.3 | 0 → 0 | 0 | 5.180 |
| thermometer-bulb.fkld | 5 | 3 → 0 | 5 | 188.0 → 32.5 | 0 → 0 | 0 | 3.866 |
| thermometer-tube.fkld | 2 | 0 → 0 | 2 | 180.0 → 20.3 | 0 → 0 | 0 | 26.499 |
| thermometer-tube.fkld | 3 | 0 → 0 | 3 | 270.0 → 30.4 | 0 → 0 | 0 | 10.018 |
| thermometer-tube.fkld | 4 | 0 → 0 | 4 | 360.0 → 40.6 | 0 → 0 | 0 | 10.018 |
| thermometer-tube.fkld | 5 | 0 → 0 | 5 | 450.1 → 50.7 | 0 → 0 | 0 | 10.018 |

## Rotation

Each pattern rotated 90°, 180° and 270° about its bounding-box centre and swept again. The rotation is exact to the last bit and `patternDiag` is invariant under it, so the router is being handed the same problem: any difference below is the search's own tie-breaking, not the geometry's.

`plan` is a net count whose stranded count or jump count changed — a different plan. `copper` is one that laid the same plan to a different length, with the difference in pattern units.

| pattern | rotation | plan | copper |
|---|---:|---|---|
| desk-lamp-base.fkld | 90° | — | 3 (-2.58) |
| desk-lamp-base.fkld | 180° | — | 2 (-2.58), 3 (-2.58) |
| desk-lamp-base.fkld | 270° | — | 2 (-2.58), 3 (-2.58) |
| drums-bass.fkld | 180° | — | 5 (1.90) |
| drums-tom-high.fkld | 180° | — | 3 (-0.46), 4 (-0.46) |
| drums-tom-high.fkld | 270° | — | 5 (0.46) |
| drums-tom-low.fkld | 90° | — | 3 (0.52), 4 (0.52), 5 (0.52) |
| drums-tom-low.fkld | 180° | — | 2 (0.69), 3 (-0.64), 4 (-0.64), 5 (-0.12) |
| drums-tom-low.fkld | 270° | — | 2 (0.69), 3 (-0.64), 4 (-0.64), 5 (-0.12) |
| guitar-neck.fkld | 90° | — | 2 (-5.14), 3 (-5.14), 4 (-5.14), 5 (-5.14) |
| guitar-neck.fkld | 180° | — | 2 (-5.14), 3 (-8.80), 4 (-8.80), 5 (-8.80) |
| guitar-neck.fkld | 270° | — | 2 (-5.14), 3 (-8.80), 4 (-8.80), 5 (-8.80) |
| guitar-upper-bout.fkld | 180° | — | 2 (-4.67), 3 (-4.67), 4 (-4.67), 5 (-4.67) |
| guitar-upper-bout.fkld | 270° | — | 2 (-4.67), 3 (-4.67), 4 (-4.67), 5 (-4.67) |
| house.fkld | 90° | — | 4 (0.11) |
| house.fkld | 180° | — | 4 (0.11) |
| house.fkld | 270° | — | 4 (0.11) |
| teapot-spout.fkld | 180° | — | 2 (0.17), 3 (0.17) |
| teapot-spout.fkld | 270° | — | 2 (0.17), 3 (0.17) |

## Why terminals strand

Each net routed alone, no adjacency, nothing else on the sheet — against the same nets routed together. A terminal stranded alone is one the corridor could not reach at all; one stranded only in company was lost to the other nets.

| pattern | nets | stranded alone | stranded together | stranded with adjacency |
|---|---:|---:|---:|---:|
| akde-decagon-pyramid.fkld | 5 | 0 | 0 | 0 |
| akde-hex.fkld | 5 | 0 | 0 | 0 |
| bat-body.fkld | 5 | 0 | 4 | 0 |
| bat-ear-left.fkld | 5 | 0 | 2 | 0 |
| bat-ear-right.fkld | 5 | 0 | 2 | 0 |
| bat-wing-left.fkld | 5 | 0 | 4 | 0 |
| bat-wing-right.fkld | 5 | 0 | 4 | 0 |
| church.fkld | 4 | 0 | 2 | 0 |
| clock-base.fkld | 5 | 0 | 1 | 0 |
| clock-case.fkld | 5 | 0 | 3 | 0 |
| desk-lamp-base.fkld | 5 | 0 | 0 | 0 |
| desk-lamp-shade.fkld | 5 | 0 | 3 | 0 |
| drums-bass.fkld | 5 | 0 | 2 | 1 |
| drums-tom-high.fkld | 5 | 0 | 2 | 0 |
| drums-tom-low.fkld | 5 | 0 | 1 | 0 |
| guitar-headstock.fkld | 5 | 0 | 3 | 0 |
| guitar-lower-bout.fkld | 5 | 0 | 3 | 0 |
| guitar-neck.fkld | 5 | 0 | 2 | 0 |
| guitar-upper-bout.fkld | 5 | 0 | 3 | 0 |
| house.fkld | 5 | 0 | 3 | 0 |
| puffin.fkld | 5 | 0 | 1 | 0 |
| teapot-body.fkld | 5 | 0 | 3 | 0 |
| teapot-spout.fkld | 3 | 0 | 1 | 0 |
| thermometer-bulb.fkld | 5 | 0 | 3 | 0 |
| thermometer-tube.fkld | 5 | 0 | 0 | 0 |

Totals: 0 stranded alone, 52 stranded together.

## desk-lamp-shade — the rim

One net, two terminals: the centroids of faces 9 and 10, the two sides of pair 0 — the most separated the pattern has, its lips 303.8 units apart in the flat sheet and one edge in the folded shade.

| arm | copper | jumps | stranded |
|---|---:|---:|---:|
| without adjacency | 286.9 | 0 | 0 |
| with adjacency | 23.5 | 1 | 0 |

Copper falls by 91.8%. Tape width 1.500 units.

## house — which seams got a rejoin

9 pairs, 0 of them with lips more than 5 units apart. Rejoined at least once over nets 2, 3, 4, 5:

| pair | faces | lip separation | rejoined at net counts |
|---:|---|---:|---|
| 0 | 0–8 | 0.5 | — |
| 1 | 1–10 | 1.7 | 5 |
| 2 | 2–12 | 2.8 | 3, 4, 5 |
| 3 | 2–14 | 3.6 | — |
| 4 | 3–9 | 0.5 | — |
| 5 | 4–11 | 1.7 | 4, 5 |
| 6 | 5–15 | 3.6 | 2, 3, 4, 5 |
| 7 | 5–13 | 2.8 | — |
| 8 | 7–14 | 4.0 | 2, 3, 4, 5 |

## Findings

- `countNetCrossings`: 0 without adjacency, 0 with, over 388 cases swept (zero throughout).
- `countJumpClashes`: 0 over every case swept (zero throughout).
- Stranded terminals recovered by adjacency: 428 over 388 cases. Of the 52 stranded without adjacency in the largest-net case of each pattern, 0 were also stranded with the sheet to themselves — see "Why terminals strand".
- Rotation: **19 (pattern, rotation) pair(s) differed from 0°**, 0 of them in the plan itself rather than only in copper length.
- Trimmed: no rotation.
- Runtime 88.1s.

