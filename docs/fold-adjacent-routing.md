# Fold-adjacent routing

How a copper net crosses a cut the unfolder had to make, and what it costs.

## What a jump is

A flat pattern is a tree of the artifact's faces. To lay the solid out flat the unfolder has to sever
every edge that would otherwise close a loop, and each severed edge leaves two **lips** lying somewhere
else in the sheet — on desk-lamp-shade, three hundred units away. In the folded artifact those two lips
are one edge, touching. A **jump** is that relation made usable: two solder **lands**, one on each lip,
and a short length of wire the builder solders between them once the sheet is folded. It is the only
connection in this program that is not copper on the flat pattern, and it is deliberately never a
polyline — a `Trace2D` stays a pure planar object, because everything that reads one is entitled to
assume that the material under it exists. A jump instead carries its own two points, the net it belongs
to, and the pair of lips it crosses, and the two lands it leaves behind are ordinary traces a tape width
wide.

## How adjacency is found

`src/model/fold-adjacency.ts` answers the one question the electronics layer cannot ask for itself:
`electronics.ts › isGapEdge` requires two incident faces, so a cut's lips read as plain boundary and
there is nothing in the pattern that says they belong together. There are two sources, and the key wins.

- **The key.** `src/pipeline/emit.ts` knows the pairing exactly — `unfold.ts` computed it as
  `Sheet.lips`, with the ordered endpoint correspondence — and writes it into the file under
  `fkld:edges_lipPeer`, an array parallel to `edges_vertices` whose entries are `null` or
  `[peerEdge, aligned]`. Reading it back is cheap and exact. `model/` may not import `pipeline/`, so
  both files carry their own copy of the key string, the same split `DRIVEN_KEY` already lives with.
- **The weld.** Almost every bundled file predates the key, so in practice the fallback carries the
  corpus: weld the declared folded form. Two distinct vertices that the goal frame `file_frames[0]`
  places at the same point, within `1e-3 × span`, are a join the fabrication makes — which is the same
  statement `sim/origami-import.ts › buildSeams` makes to the solver, at the same tolerance. Cut edges
  with exactly one incident face are keyed by their welded endpoint classes; a class holding exactly two
  edges on different faces is a pair, and a class holding one or three is dropped rather than guessed at.

A malformed key falls through to the weld rather than failing, because a stale key is a worse answer
than a measured one. A pattern with neither reports `source: "none"` and no pairs, and everything
downstream then behaves exactly as it did before jumps existed.

The endpoint correspondence is the part that earns its keep. `lipA[i]` welds to `lipB[i]`, so the same
parameter `u` along both lips is the same point on the folded edge — which is what lets a hop across the
seam land on one 3D point instead of two, and what makes the router's own jumps pass the author's rule.

## How the corridor prices it

`src/model/corridor-jumps.ts` adds the hops. For each pair it places two nodes on each lip, at
`u ∈ {¼, ¾}` — the same quarter points a hinge is crossed at, two rather than one so that two nets can
rejoin the same cut on separate lands, and off the middle so neither is favoured. Each node is nudged a
hair toward its face's centroid so it is unambiguously on material, and a pair whose nudged node falls
off the material is skipped: a land cannot be soldered onto material that is not there.

The links go into `Corridor.bridges`, not into a second map, which is what keeps `reachableFaces` and
the path reconstruction untouched — they already union every hop out of a node. Only the relaxation in
`searchCorridor` tells the two apart, on `CorridorBridge.kind`. A jump differs from a bridge in three
ways:

- **Its flat length is never charged.** The flat distance between two lips is meaningless; the step is
  priced at zero and the toll is added on top.
- **It carries no strain band.** There is no substrate bending under a soldered wire.
- **It is exclusive, not tolled.** An occupied lip node is refused outright rather than made expensive,
  because a toll multiplied into a zero-length step buys nothing.

The toll itself, `JUMP_TOLL_DIAGS`, is one pattern diagonal, bracketed from both sides rather than
fitted. It sits **above one fatiguing crease** (`FOLD_PENALTY_FRAC`, half a diagonal), so a route that
could stay on the material and cross one bad crease still does and a jump is not a way of dodging a
mountain fold. It sits **far below a bridge** (`BRIDGE_TOLL_DIAGS`, twenty diagonals, a deliberate last
resort), because a bridge is tape hanging over a hole and a jump is a wire the builder solders. One
diagonal is also, by construction, the most a jump can ever save: the longest route the corridor can
offer between two points of one pattern is bounded by its bounding-box diagonal, so at this price a jump
is taken only where going round costs more than the whole sheet's width.

Adjacency is **off by default**. `buildCorridor`, `planNets` and `planRoutes` all take it as an appended
parameter defaulting to `null`, and `null` yields a bit-identical corridor.

## How the router splits a path

`src/model/net-legs.ts › layPath` is the whole of a leg that may leave the sheet and come back. A
corridor path is cut into pieces at each jump hop, each piece is laid by `layLeg` exactly as a
jump-free leg always was, and the hops between the pieces come back as `Jump`s rather than as copper.
Every piece passes `pathOk` on its own, and one failing piece fails the whole leg, as today. A path with
no jump in it lays exactly one leg, which is why a router handed no adjacency is the router that was
here before.

Each jump leaves two lands, plain two-point traces a tape width wide running from the lip into the
owning face. The routed pieces end at the land centres, so the copper and the wire meet where the
builder will put the solder. `planNets`'s tie-break becomes `[stranded, jumps, copper]`: reaching a
terminal always beats not reaching it, and between two plans that reach the same terminals the one
asking for fewer hand-soldered wires wins even if it lays more copper.

## How the rules judge a drawn jump

`src/model/jump-rules.ts › checkJump` asks three questions and no others, and reports its answers as
ordinary `WireFault`s in `wire-rules.ts`'s registry rather than as a parallel vocabulary — the author
sees one list of things wrong with the copper and does not care which reading found them.

- `jump-unanchored` (warning) — an end does not rest on material at all.
- `jump-not-adjacent` (error) — the two ends are not the two lips of one cut, or they are but sit at
  different places along it. The along-seam allowance is `JUMP_SKEW_TAPES`, one tape width: below that
  the two lands touch anyway once the sheet is folded, and much above it the author has drawn a jump
  between two places the folding never brings together. This must agree with the corridor's own nodes,
  and does with room to spare: `u ∈ {¼, ¾}` on *both* lips means a router-emitted jump has zero skew by
  construction.
- `jump-land-clash` (error) — a land sits within `gapNeeded` of another net's copper or of another net's
  land.

A jump whose ends both resolve but which sits on no pair still resolves, with `pair === -1`, so the rule
can say why. Returning nothing there would delete the evidence the author needs.

## What is exempt from planar metrics, and why

`PlanKey` stays the five-tuple it has always been, and `countNetCrossings` does not see jumps. This is a
decision, not an oversight, and it rests on two facts.

A jump has **no copper in the plane between its ends**: the wire leaves the sheet at one land and comes
back at the other, so there is nothing for a segment-intersection test to intersect. Charging a crossing
there would be inventing a fault out of a coincidence of the layout.

And two jumps **cannot cross each other in 3D**, because each lip node is exclusive — the search refuses
an occupied one — so two jumps of different nets never share an end to begin with.

What is left is the lands, and those are blamed three ways already: search-time exclusivity keeps the
router from laying a clash, `claim`/`owner` carry which net holds each land, and `jump-land-clash`
catches a drawn one. For scripts and tests that want the number after the fact there is a pure metric,
`route-metrics.ts › countJumpClashes`, which counts unordered pairs of jumps of different nets sharing a
land. It must never be fed into `PlanKey`.

## The bus-rail boundary

Router-emitted jumps come from `planNets` only. The two-rail LED bus that `planRoutes` builds at
`electronics-routing.ts` is built **without** adjacency and stays jump-free: its corridor is constructed
before the declared nets are routed and its rails are laid as a pair that every other net then works
around, so putting hops into it changes the shape of the problem every declared net is solving rather
than adding an option to one net's search. Author-drawn jumps work on any net, bus rails included —
those reach the router as `prejoined` pairs, which is the only path by which an author's jump changes a
route.

Automatic jumps for the bus rails are deferred as a separate piece of work (P4), planned on its own.

## Measured

All of it from one run of `scripts/_jump-audit.ts`, about ninety seconds over the 29 bundled patterns. Each case
is `n` nets, one per lip pair, terminals at the centroids of the pair's two faces, routed twice —
`adjacency: null` against the pattern's own `foldAdjacency`. 388 cases: 97 combinations of pattern and
net count, each at four rotations.

**The corpus.** 25 of the 29 bundled patterns carry lip pairs, all of them from the goal frame — no
bundled file yet carries `fkld:edges_lipPeer`, so the weld is what runs today. Four carry none:
akde-square-pyramid has no goal frame at all, and bistable-star-tiling, kirigami-flap and
teapot-handle-solid have a frame that welds nothing, their cuts being slits with both lips on one face.
Pair counts run from 4 on teapot-spout to 125 on teapot-body. desk-lamp-shade has 56, of which 27 have
their lips more than five units apart in the flat sheet; house has 9, of which **none** do — its seams
are severed between faces that the layout happens to leave side by side, which is why house is the
pattern where a jump saves the least.

**Copper.** Across the 97 rotation-0 cases, total copper falls from 28550 to 4368 pattern units, a
reduction of 85%, and 306 jumps are used across 89 of the 97 cases.

**desk-lamp-shade, the rim.** One net, two terminals at the centroids of faces 9 and 10 — the two sides
of the pair whose lips lie 303.8 units apart in the flat sheet and are one edge in the folded shade:

| arm | copper | jumps |
|---|---:|---:|
| without adjacency | 286.9 | 0 |
| with adjacency | 23.5 | 1 |

A 92% reduction on one hand-soldered wire, which is the case the whole feature was proposed for.

**house, the nine seams.** Five of the nine were rejoined at least once over nets 2 to 5 — pairs 1, 2,
5, 6 and 8, joining faces 1–10, 2–12, 4–11, 5–15 and 7–14. The other four were never worth a jump: with
every lip pair on this pattern less than five units apart, going round is usually cheaper than a toll of
one diagonal, and the router takes a jump only where congestion from the other nets makes it pay.

**Crossings and clashes.** `countNetCrossings` is **0 on both arms of all 388 cases**, and
`countJumpClashes` is **0 on every case**. The planar guarantee the router exists to keep is unchanged
by jumps, which is the empirical half of D7.

**Stranding.** The plan expected adjacency to recover no stranded terminal, on the ground that every
bundled sheet is one connected patch and so the router could already reach anywhere the long way round.
The connectivity claim holds exactly: routing each net **alone** on each pattern at its largest net
count strands **0 terminals out of 25 patterns**. But the same nets routed **together** without
adjacency strand 52, and with adjacency 1 — so terminals are recovered after all, 428 of them across the
sweep. The mechanism is not topology, it is room: a net sent the long way round occupies most of the
sheet, and the nets behind it have nowhere left to go. A jump takes that net off the long route and out
of everyone else's way. The single terminal still stranded with adjacency is on drums-bass at five nets.

**Rotation.** Every pattern was also swept at 90°, 180° and 270° about its bounding-box centre — the
only rotations leaving `patternDiag`, and so the toll, invariant, and exact to the last bit as written.
The **plan is rotation-stable**: no rotation of any pattern changed a stranded count or a jump count
anywhere. 19 of the 75 rotated pattern-sweeps laid the same plan to a slightly different length, the
largest difference 8.8 units on guitar-neck, which is the search's own tie-breaking between equal-cost
paths rather than a routing difference.
