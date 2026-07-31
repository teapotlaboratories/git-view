# 2026-07-30 — KiCad Phase 0: the solver, and a measurement that was confidently wrong

Continues [2026-07-29 — does the schematic give up its nets?](2026-07-29-kicad-phase0.md), which built the
s-expression reader and the pin transform. This day builds the connectivity solver itself — and discovers
that the transform the previous day measured was **wrong**, in a way that day's oracle physically could
not detect.

Phase 0's actual deliverable: `nets.ts`, deriving connectivity by union-find over coordinates. It now
matches `kicad-cli`'s own netlist on **582 of 582 nets** across the 14 flat demo sheets — exact partition
match, zero merges, zero splits. Getting there was almost entirely a story of being wrong in ways that
still scored well.

## A better oracle, and what it exposed

The `no_connect` probe from yesterday scores *positions*. I built the netlist oracle
(`tools/kicad-netlist-oracle.ts`, `kicad-cli sch export netlist`) expecting it to confirm the transform
and move on. First run: **24.9%**.

Ubuntu only packages `kicad-cli` **7**, which cannot open KiCad 10 files. That is fine — connectivity
rules are not version-specific — so netlist scoring runs on the 7.x corpus while the KiCad 10 corpus keeps
the position probe. Worth stating rather than hiding, since the headline number now comes from the older
files.

**The transform was wrong, and the old oracle could not have told me.** Every diode on StickHub had its
pin 2 on GND and pin 1 on the signal — an exactly-backwards circuit that renders perfectly. The cause:
mirror was applied *before* rotation. Both orders put pins at the same *coordinates* and merely exchange
which pin sits at which end, and most mirrored parts are two-pin, so the marker oracle scored the wrong
order **90.6%** against the right one's **91.8%**. That gap reads like noise. It was a blind spot.

Sweeping all eight orderings against the netlist separates them completely:

```
rot-r mirror-after  x:negY   582/582  100.0%   <- shipping
rot-r mirror-before x:negY   555/582   95.4%   <- what shipped before
rot+r mirror-after  x:negY   455/582   78.2%
```

The generalisable bit: **an oracle that cannot distinguish two hypotheses will still rank them, and the
ranking looks like an answer.** I had written "mirror before rotation" into `transform.ts` with a tidy
justification — KiCad stores the mirror in the symbol's own frame — which is a good argument for a false
conclusion. The comment made it *more* convincing, not less.

`kicad-probe.ts` now carries the losing candidate permanently, so the blind spot is visible in its output
rather than described in a file nobody opens.

## Rules I would not have guessed

Each of these was found by diffing against the oracle, not by reading docs.

| rule | found via |
| --- | --- |
| A wire ending **mid-span of another does not connect** without a junction dot | `electric.kicad_sch`: a vertical wire ends at (115.57, 20.32), dead centre of a horizontal one, no junction — KiCad keeps them apart. I had joined them, merging two real nets. |
| …but a **pin** mid-span **does** connect | Correcting the above to "junctions only" split 59 of `carte_test`'s 100 nets. The rule is asymmetric. |
| **Power symbols name a net without being a node on it** | `GND` in the netlist lists the pins it reaches and no `#PWR0x`. |
| A power symbol is `(power)` **plus a `power_in` pin** | Both obvious tests fail: sallen_key keeps GND in `sallen_key_schlib:`, not `power:`; KiCad 10's `power:GND` pin is *visible*. And `PWR_FLAG` is flagged power but is `power_out` — trusting the flag alone names a net `PWR_FLAG`. |
| **Same-name labels join islands sharing no wire** | Ground arriving as one island per symbol: 21 splits on stickhub, 90 on interf_u. |
| **Hidden `power_in` pins connect by pin name** | The 74xx convention. `U1.7`/`U2.7` missing from GND on `sonde xilinx`. |
| A **multi-unit part's shared-body pins are one pin** | Unit 0 is placed once per unit, so a quad NAND emitted `U2.7` four times. Enough to fail an exact set comparison while looking correct in every dump. |

Scoring merges separately from splits was the single most useful reporting decision: merges silently short
two nets, splits only fail to highlight. Watching merges go 1064 → 0 was the real progress signal.

## Keeping the score honest

The tool refuses to average away what it does not support. Hierarchical projects score ~6% because the
oracle netlists a whole design and the solver reads one sheet — that is "out of scope", not "broken", and
it is printed under its own heading so it cannot be mistaken for either. Buses are listed separately too;
the bus-carrying demo happens to score 173/173 because its members are labelled, which is luck and is
labelled as such.

## Tests, and proving they discriminate

The oracle cannot run in CI: KiCad is not installed there and the demos are separately licensed. So the
rules are re-stated as 11 tests on **hand-authored** fixtures.

Then I broke the implementation twelve different ways to check each test actually catches its own rule.
Eleven landed on exactly the intended test. **One caught nothing**: the "power symbol is not a node" test
used a `#PWR01` reference, and the `#`-prefix rule excludes that pin regardless — two mechanisms masking
each other, so the assertion held even with the power rule deleted. A test that cannot fail. Fixed by
giving the fixture an ordinary reference so the rule under test is the only thing holding it up.

Same lesson as the watcher fixture earlier in the week, arriving by a different route: a test is not
evidence until it has been seen to fail.

## Verified

- **582/582** nets against `kicad-cli` on the 14 flat sheets; 0 merges, 0 splits.
- Position probe **91.8%** of 19,978 pins over 115 KiCad 10 sheets (up from 90.6% — the mirror fix).
- Suite **189 pass** (178 + 11 new).
- Not implemented, and known: hierarchy, explicit bus membership. Both Phase 1.

## Hierarchy and buses — the rest of Phase 0

Went after the two known gaps rather than land a solver that was merely honest about being incomplete.
The endpoint's wire format depends on whether nets are per-sheet or per-design, so this genuinely blocked
Phase 1 rather than being polish.

**Result: 1722 of 1722 nets across all 19 demo projects — zero merges, zero splits.**

### Both corpora had evaporated

`/tmp` had been cleaned, taking both demo sets with it. Re-fetched to **`~/kicad-corpus/`** (k7 from
`apt-get download kicad-demos`, k10 from the GitLab path-filtered archive) so a reboot stops costing a
re-download, and confirmed the previous 409/409 reproduced from the new location before changing anything.

### Three hierarchy mechanisms, each the only one somewhere

Counting sheet symbols and pins with the *parser* rather than grep — grep had already misled me twice on
this format, because `(pin "1" (uuid …))` on a symbol instance looks exactly like a sheet pin:

| project | sheets | sheet pins | hier labels | mechanism |
| --- | --- | --- | --- | --- |
| `complex_hierarchy` | 2 | 0 | 0 | same file placed twice — **per-instance references** |
| `flat_hierarchy` | 3 | 0 | 0 | **global labels** only |
| `video` | 8 | 160 | 162 | **sheet pin ↔ hierarchical label** |

Implementing any two of those looks like it works until it meets the third.

The reference one is the nastiest, because it is not about nets at all. `ampli_ht.kicad_sch` is placed
twice and the same potentiometer is `RV1` in one placement and `RV2` in the other; the `Reference`
property holds only one. Trusting it reports one reference twice — two components collapsed into one, in
a netlist that otherwise reads perfectly. References live in an `instances` block keyed by the path
`/rootUuid/sheetUuid`.

### Two bugs that scored well

**Sheet pins bound through the parent's name scope.** `video` places two sheets that each expose a pin
named `BLUE`, wired to *different* parent nets. Routing both through one parent-scope `BLUE` node shorted
them — a merge, the dangerous direction. A sheet pin's identity on the parent is its **geometry**; the
name only selects which of the child's labels it feeds. Fixing that took merges to zero and stayed there.

**Power symbol names came from `Value`.** In `kit-dev-coldfire` one supply carries the Value `+3,3V` —
with a comma — while its pin is named `+3.3V`. KiCad uses the pin name. Trusting Value split that supply
into two nets differing by one character, in a 90-pin net where nobody would ever spot it by eye.

### Buses were entangled with hierarchy, not separate from it

`kit-dev` passes a bus sheet pin `AN[0..7]` into a child that refers to its members as plain local labels
`AN0`…`AN7` and never mentions the bus. Expanding members across the boundary took it 250/278 → **278/278**.

`video` needed more. Its top sheet runs one physical bus past five sheet symbols that each name it
differently — `DQ[0..31]`, `DPC[0..31]`, `PC_D[0..7]`, `DQ[0..15]` — and KiCad pairs member *i* of one
with member *i* of the other. My first attempt at that changed nothing, because bus wires are `(bus …)`,
a **separate element type** the reader had never parsed: the anchors were never in the same group, so
there was nothing to alias. Reading bus geometry took video 522/588 → **588/588**.

Bus geometry lives in its **own** union-find, deliberately. A bus is a bundle, not a net; one accidental
join between a bus node and a signal node collapses every member of that bus into a single net. There is
a test that breaks if bus segments are ever fed to the signal solver.

### A diagnostic that lied

Mid-way, `--explain` reported sub-sheet pins as `(nowhere)` and sent me hunting a walker bug that did not
exist. The score had been switched to whole-design solving; `--explain` had not, so the two halves of the
same tool disagreed. Both now go through `loadDesign`. Worth the note because the failure looked exactly
like a real bug in the code under test.

### Tests

9 more, on hand-authored fixtures with an in-memory file map (`loadDesign` takes an injectable `read`,
which the bridge needs anyway to serve git blobs rather than working trees). Then nine deliberate breaks
to confirm each test catches its own rule — including the `BLUE` short and bus geometry leaking into
signal connectivity, the two regressions most likely to be reintroduced by someone tidying up.

### Verified

- **1722/1722** nets against `kicad-cli`, all 19 projects, 0 merges, 0 splits.
- Suite **198 pass**.
- Position probe unchanged at **91.8%** of 19,978 pins over 115 KiCad 10 sheets.
- Corpora at `~/kicad-corpus/{k7,k10}`; both tools document their fetch commands.

## Self-review pass

`/code-review` is user-triggered and billed, so this was a manual read of the diff. It is **not** a
substitute for the billed review before merge — that still has to run on the PR.

Five findings, all fixed:

- **The mid-span contact scan was quadratic with no pruning.** `contacts × segments` per sheet, and
  `video` took **1149 ms**. Schematic wires are short and axis-aligned, so rejecting out-of-range contacts
  by bounding box first discards nearly everything for four comparisons: **213 ms**, 5.4× faster, whole
  corpus 2526 → 664 ms. Purely a speed-up — the box is a superset of the segment, so nothing `onSegment`
  would have accepted is skipped. Worth doing now because Phase 1 parses on demand at file-open.
- **The root file was fetched twice.** `read()` may be pulling a git blob. Now read once; it is still
  parsed twice, because the root's uuid *is* the instance path that references resolve against, and that
  is only knowable after a parse. Noted in the code rather than left to look accidental.
- **A comment that described the wrong thing.** The `seenPaths` guard was documented as catching a sheet
  that contains itself. It cannot: a self-containing sheet generates a *new* path at every level and is
  caught by `MAX_DEPTH`. What `seenPaths` actually catches is two sheet symbols sharing a uuid — a
  malformed file whose references would silently overwrite each other. Same class of mistake as the
  comment-vs-code one in ADR-036: the comment was confident and wrong, which is worse than absent.
- **A silent `catch` on an unreadable sub-sheet.** Availability-first is right — one bad sheet should not
  cost the design — but swallowing the reason is the exact thing the watcher work was pulled up on last
  week. `Design` now carries `problems: string[]`, so the bridge can log it and the viewer can say which
  sheet is missing. A viewer that quietly drops a sheet renders something wrong that looks complete.
- **A dead re-export** of `GLOBAL_SCOPE` from `design.ts`, used by nothing.

Two more tests (one for the reported problem, one asserting a healthy design reports none), both checked
by breaking the code. Suite **200 pass**; still **1722/1722** nets, 0 merges, 0 splits.

### Left alone, deliberately

`readSheet`'s injectable `place` parameter stays. It is production surface existing only so the oracle can
sweep transform candidates — but that sweep is what caught the mirror-order bug, and losing the ability to
re-run it costs more than the seam does. Documented as test-only; nothing in the bridge passes it.
