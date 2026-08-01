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

## Review of PR #49 — three findings, all fixed

**Phase 2 had shipped with zero tests.** Nothing in the diff touched a test file, in the one phase where
two defects escaped — the chip toggle (caught by hand-driving an emulator) and the pin leads (caught by the
owner looking at a screenshot). Phases 0 and 1 carry 214 tests between them, each verified to fail when its
rule breaks; Phase 2 carried none.

Now 3 bridge tests (a pin lead reaches the body, a hidden pin draws none, a sheet box is not a component)
and **11 Kotlin unit tests** for the hit-testing and selection logic — the first unit tests the schematic
viewer has. Verified by breaking the implementation three ways: making sheet boxes pickable, hit-testing
pins, and preferring the largest body. Each break fails 3 tests.

The Kotlin helpers had to become `internal` to be reachable from the test sourceset. Worth it: `pickComponent`,
`pointInPolygon` and `polygonArea` are pure functions, exactly the kind of thing that should never have
needed an emulator to check.

**Sub-sheet boxes were pickable as components.** Sheet symbols carry a `ref` so they highlight as a unit,
but they are not parts — measured on `video`'s root, **7 rects have a ref with no matching entry in
`scene.components`**. Tapping one showed a card with an empty value, empty `lib_id` and "0 pins": a sheet
presented as a component, telling the user nothing. `pickComponent` now considers only refs that are
actually components; sheet boxes fall through to net selection.

**The net picker was not searchable, and the plan said it was.** `docs/PLAN.md` promised "a *searchable*
list beats hunting for a wire", and a bare chip row shipped. On the sheets that motivated the feature that
is worse, not better: scrolling `buspci`'s 162 chips to reach `DQ7` is harder than tapping the wire. A
filter field now appears once a sheet passes 12 nets, so `sallen_key`'s 7 keep a bare row and e-ink does
not pay for a text box it does not need.

That last one is the one worth remembering: the demo sheet had 7 nets, so the shortfall never showed. It
was only visible by reading the plan back against what shipped.

Suite **217 bridge + 11 app**; 1722/1722 nets unchanged.

## The net filter on e-ink — the worry was overstated, and one part is untestable here

I flagged the filter's text field as a risk on the mono panel: a keyboard covering the schematic you are
filtering against, with every keystroke a full-panel redraw. Driven on `bus_pci` (162 nets) under the
E-Ink profile:

| | phone 1080×2340 | e-ink 1264×1680 |
| --- | --- | --- |
| chips visible at once | 8 | **13** |
| keyboard share of the panel | **56%** | **39%** |

So it costs *less* screen on e-ink than on the phone, not more — the panel is proportionally wider and
shorter, so the chip row fits more and the keyboard eats less. Filtering to 32 and selecting `DQ0` through
it both work, and everything stays legible in mono. **No profile-specific affordance is warranted**, and
building one on the strength of an untested hunch would have been the wrong call.

**What this could not test, and I am not claiming it did:** the actual refresh cost of typing on a real
EPD panel. The emulator has no electrophoretic display — it redraws instantly — so this verifies *layout
and legibility* and says nothing about whether each keystroke feels like a full-panel flash on the
hardware. That is consistent with ADR-014: there is no public Bigme SDK and a real EPD cannot be emulated.
It stays an open question for the physical device, not a solved one.

## Two defects reported from the phone, both invisible to every check I had

Neither was found by the suite, the build, or the emulator screenshots — both came back from the owner
using the release-signed build on real hardware.

**"The schematic is visible on top of the search bar and navigation bar."** A Compose `Canvas` does
**not** clip its drawing to its own `Box`. Nothing in the layout says it should, and nothing warns you: the
canvas happily paints outside its bounds, so a panned schematic drew over the net-filter field above it
and under the system navigation bar below. Two modifiers fix it — `clipToBounds()` on the canvas and
`navigationBarsPadding()` on the pane — and I have left a comment saying the first is load-bearing rather
than cosmetic, because it looks exactly like the kind of line a later cleanup deletes.

**"See some writing on the left bottom, what is that?"** Free-standing annotation — a SPICE directive —
parked well away from the circuit. The sheet bbox included every drawable, so that one text element set
the minimum and the whole circuit rendered small and off-centre. On `sallen_key` the text sits at x=109.2
while the circuit starts at x=152.4.

The fix is `circuitBounds()`: frame on wires, pins and component bodies, and let annotation fall outside
the frame while still being drawn. It is a **framing choice, not a bug** — the text is genuinely part of
the schematic, it is just not what you want to fill the screen with.

⚠️ Worth recording that I called this a fit *bug* twice before measuring it, and nearly "fixed" it with a
scale fudge that would have made every other sheet slightly wrong to make this one look right.

Re-checked on all three form factors. Suite unchanged.
