# 2026-07-29 — KiCad Phase 0: does the schematic give up its nets?

ADR-038 rests on one claim: everything the viewer needs is already in the `.kicad_sch` / `.kicad_pcb`, so
no KiCad binary is required. Phase 0 exists to test the part of that claim that could be false — schematic
nets are **not** stored, they have to be derived from geometry.

## Corpus, without installing KiCad

`apt-get download kicad-demos` — 3.3 MB, `Architecture: all`, extracted with `dpkg-deb -x`. 35 schematics
and 14 boards of real (if dated) KiCad projects, and **no KiCad install**. Worth knowing: the sample data
ships independently of the application.

## What the files actually contain

Measured, not assumed, on `flat_hierarchy/pic_sockets.kicad_sch` and a 916 KB board:

```
lib_symbols        every symbol the sheet uses, embedded
42 footprints      inline on the board, with pad geometry
365/365 segments   carry (net N "name")
8 filled_polygon   zone fills precomputed
```

So the board hands you nets for free. The schematic does not: 81 wires, **zero** carrying a net.

## The geometry problem nobody mentions

A symbol *instance* on the sheet lists its pins by number and uuid — **no coordinates**:

```
(symbol (lib_id "flat_hierarchy_schlib:PIC12C508A") (at 83.82 76.2 0) (unit 1)
  (pin "1" (uuid 7889a823-…))
```

The coordinates live in `lib_symbols`, in the symbol's local frame, and must be transformed by the
instance placement. Get that transform wrong and every pin lands in the wrong place, so connectivity is
garbage — silently, because the render still looks fine.

I did not want to trust a remembered convention, so I measured it. **`no_connect` markers are a precise
oracle**: KiCad places one exactly on an unconnected pin, so a correct transform must put a pin there.
Wire endpoints serve the same purpose for connected pins.

Across **33 real schematics, 5711 pins**:

| transform | pins landing on a wire end or no_connect |
| --- | --- |
| Y-flip, then rotate(−r) | **86.9%** |
| Y-flip, then rotate(+r) | 86.4% |
| no Y-flip | 85.1% (single-sheet run) |

**The Y-flip is real** — library symbols are Y-up, sheets are Y-down. Rotation sign leans negative but is
barely separated (24 pins across the corpus), because most rotated parts in this corpus are two-pin and
symmetric about their origin, so both signs produce the same *set* of positions. A non-symmetric rotated
part is needed to settle it.

## The residual 13% is explained, not mysterious

- **141 instances carry `(mirror x)` or `(mirror y)`** out of 1611 (~9%) and the probe ignores mirroring
  entirely. That is most of the gap and a straightforward addition.
- The rest are genuinely floating pins — a pin with no wire *and* no `no_connect` is legal and common in
  demo files. An unmatched pin is not necessarily a wrong pin, so 87% is a **lower bound** on correctness,
  not an error rate.

## State

- `bridge/src/kicad/sexpr.ts` — s-expression reader. Deliberately a reader, not a schema: it returns
  nested lists and lets callers pick fields, so a KiCad version adding a field cannot break it. `tsc`
  clean. Numbers are only parsed when the *whole* token is numeric, so `R12` and `1.27mm` stay strings.
- The transform is established well enough to build on, with mirror as a known gap.

## Next

The union-find solver itself: join wire endpoints, merge at junctions and pin coordinates, then name each
group by label priority (local → hierarchical → global, else auto-name). The trap to respect is that two
wires crossing **without** a junction are not connected — get that wrong and nets silently merge.

Ground truth for that step still needs an oracle netlist. `kicad-cli` is the obvious source and remains
fine as a **development-time** dependency; nothing about it needs to reach a bridge.

## Correction: the target is KiCad 10, not 9

The owner asked whether we should be building against KiCad 10. I had concluded from the **snap store**
that 9.0.7 (2026-02-12) was current, across stable, candidate, beta *and* edge. That was wrong: KiCad's
GitLab tags show **10.0.5 on 2026-07-21**, eight days ago. The snap is five months stale, and treating a
packaging channel as a release oracle is what put the first draft of ADR-038 on the wrong version.

Switched the corpus to the real thing — a path-filtered archive of `demos/` at tag 10.0.5, 93 MB,
**115 schematics and 19 boards** against the 7.x package's 35 and 14. Formats: sch `20250114`,
pcb `20241229`.

### What that changed, and what it did not

Everything the parser leans on survived: `lib_symbols`, `wire`, `junction`, `label`, `global_label`,
`no_connect`. What changed is **formatting** — KiCad 10 pretty-prints with `(symbol` and `(lib_id …)` on
separate lines. The s-expression reader does not care, because it is a reader; a regex-based one would
have broken silently on exactly that. The "schema-less reader" decision paid off three hours after it was
made.

### The bigger corpus settled the open question

Rotation sign was ambiguous on 7.x (88.1% vs 87.5% — 24 pins apart). On the KiCad 10 corpus it is not:

| transform | KiCad 7 (5281 pins) | KiCad 10 (17019 pins) |
| --- | --- | --- |
| **Y-flip, rotate(−r)** | 88.1% | **91.2%** |
| Y-flip, rotate(+r) | 87.5% | 84.6% |
| no Y-flip | 76.2% | 54.1% |

Both runs now **exclude mirrored instances** (141 in the 7.x corpus, 892 in the 10.x) rather than folding
them into the average, because `(mirror x|y)` is not modelled yet and burying it would flatter the number.

### Two further consequences

- **The 3D model variable is version-dependent**: `${KISYS3DMOD}` in the KiCad 10 demos,
  `${KICAD6_3DMODEL_DIR}` in the 7.x ones. Resolution has to handle several.
- **`embedded_files` is real and in use** — 2 boards in the KiCad 10 corpus embed files. If a project
  embeds its 3D models, Phase 4 needs no 5.7 GB asset library for it at all. Worth checking properly then.
