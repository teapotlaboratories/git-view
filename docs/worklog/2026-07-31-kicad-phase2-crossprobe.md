# 2026-07-31 — KiCad Phase 2: cross-probe on the schematic

Continues [Phase 1](2026-07-30-kicad-phase1-scene.md). Half of Phase 2 had already shipped there — tapping
a wire selects its net, because every primitive already carries the net it belongs to. What was left is
the *component* side, and a way to pick a net without hunting for a wire thin enough to hit.

App-only: the bridge already serves everything needed.

## One selection model, deliberately

A `sealed interface Selection` with `Net` and `Component`, exposing a single `matches(primitive)`
predicate. Colour, stroke width and text weight all consult that one predicate.

The alternative — two independent "selected" flags — is the kind of thing that looks harmless and then
diverges: the draw loop grows two notions of what is selected, and eventually they disagree about what is
dimmed. Making them one type means a component and a net cannot both be active, and the draw code cannot
develop two rules.

## Hit-testing bodies only

`pickComponent` tests `rect`, `circle` and closed `poly` outlines. Two deliberate exclusions:

- **Not pins.** A pin sits exactly where a wire ends, so hit-testing pins would let a component steal
  every tap aimed at a net.
- **Not text.** A refdes label can sit some distance from its symbol, so hit-testing it would select a
  part from wherever KiCad happened to place the text.

The **smallest** containing body wins, so a part drawn inside a sub-sheet box resolves to the part rather
than the box.

## Two bugs, both found by running it

**The net chip selected but never deselected.** `active` was computed at composition and captured inside
`pointerInput(net)` — which restarts only when *its key* changes, not when `active` does. The handler kept
a frozen `false`, so the toggle branch never ran. It compiles, the chip highlights correctly on first tap,
and it silently does nothing on the second. Fixed by reading `selection` inside the handler rather than
capturing a derived flag. A classic Compose trap and completely invisible to a build.

**Body graphics did not honour selection.** They were drawn with a flat `pal.body` in Phase 1, which
nobody could have noticed then: only nets were selectable, and nets do not own bodies. Selecting a
component would have highlighted its pins and left its outline untouched. Now routed through the same
`colourFor`/`widthFor` as everything else — which is also what makes the e-ink component highlight work at
all, since there the stroke weight *is* the selection signal.

## Verified on all three form factors

| form factor | result |
| --- | --- |
| **Phone** 1080×2340 | component select + detail card (`R1  1k  ·  sallen_key_schlib:R  ·  2 pins`), net chips, toggle select→clear→select |
| **Tablet** 2560×1600 landscape | all 7 net chips fit the centre pane without wrapping — the narrowest place the new chip row lands, and the reason this was re-driven rather than assumed |
| **Bigme B7 Pro** 1264×1680, E-Ink ON | R1's outline draws markedly heavier than every other symbol; unambiguous at a glance with no hue involved |

The tablet check earns its place: Phase 2 adds a chip row that consumes vertical space, and the tablet's
centre pane is the narrowest of the three. Reasoning that it was "unchanged" would have been an
assumption dressed as a verification.

Suite **214 pass** (bridge untouched by this phase).

## Pin leads — spotted by the owner looking at a screenshot

Every wire stopped short of the part it landed on, leaving a visible gap: the schematic read as though
nothing was wired up.

A KiCad pin is **not a point**. `at` is the *connection* end, the symbol body sits `length` away, and KiCad
draws a line between them. The scene emitted the body and a dot at the connection point but never the lead
between the two — so the wire ended at the dot and the body floated clear of it. **3536 of the 3684 pins in
the KiCad 7 demos carry a nonzero length**, so this was the common case, not an edge case.

Why nothing caught it: connectivity was never affected — the solver only ever cares about the connection
*point*, which was correct all along, so 1722/1722 stayed green throughout. The tests assert primitive
kinds and net membership, and both were right. It is a purely drawable defect, invisible to every check
except looking at the picture, and I had looked at that picture several times without seeing it.

The lead is tagged with the pin's **net as well as its ref**, because electrically it continues the wire
and should highlight with it — `poly` gained an optional `net` for that.
