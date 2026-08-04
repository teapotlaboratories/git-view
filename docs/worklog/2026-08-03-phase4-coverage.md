# 2026-08-03 — Phase 4 step 1: model coverage, no assets

The re-scope said the first deliverable is **coverage reporting and nothing else** — report per board how
many parts have a 3D model that resolves, and under which variable. It needs no assets, costs almost
nothing, and answers the question everything downstream depends on: *can this board be shown at all?*

## What it does

`readBoard` already walks every footprint. It now also classifies each `(model "…")` reference while it is
there, so coverage is free rather than a second pass.

Three pieces:

- **`classifyModel(raw, known)`** — pure, exported, testable without a board. A path is `project`
  (`${KIPRJMOD}` or relative — resolvable from the repo alone), `configured` (a variable the operator has
  mapped), `unmapped` (a variable nobody told us about), or `absolute` (someone else's machine).
- **`config.kicad.modelPaths`** — the operator maps the variables they have. The bridge does not guess,
  because it *cannot*: `${ANT3DMDL}` is 1,007 references to somebody's private library, defined in their
  KiCad settings and shipped nowhere.
- **`Board.models`** — counts over **unique** models, because reuse is ~22×. `vme-wren` makes 1,480
  references to 66 distinct models, and it is the 66 that would ever be fetched or converted. Counting
  references would overstate the work by more than an order of magnitude.

## Measured over the corpus, through the implementation

Mapping the six official `KICAD*_3DMODEL_DIR` / `KISYS3DMOD` variables and nothing else:

| board | unique | configured | in repo | unmapped | what to map |
| --- | --- | --- | --- | --- | --- |
| `jetson-agx-thor-baseboard` | 67 | 0 | 0 | **66** | `ANT3DMDL` (66) |
| `One-Air-Max` | 40 | 0 | 4 | **36** | `EASYEDA2KICAD` (36) |
| `vme-wren` | 66 | 33 | 33 | 0 | — |
| `CM5_MINIMA_3` | 32 | 17 | 6 | 5 | `KICAD_3RD_PARTY` (4) |
| `video` | 27 | 23 | 4 | 0 | — |
| **all 19** | **392** | 207 (53%) | 73 (19%) | **107 (27%)** | |

That reproduces the by-hand survey that drove the re-scope — 392 unique, 207 official, 107 unresolvable —
and is slightly *more* precise: the hand script folded absolute paths in with in-repo ones, where the
implementation separates them (5 unique).

The useful column is the last one. "This board has 66 models we cannot resolve, and they are all
`ANT3DMDL`" is actionable in a way "3D is unavailable" is not — and it is known **before** anyone
downloads 5.7 GB or opens a board that would draw one part out of 67.

## Deliberately not done

No renderer, no asset fetching, no conversion. Nothing is downloaded. Whether a mapped file is actually
*on disk* is a separate question this does not ask: coverage is about whether a path can be **addressed**,
which is the part that needs no assets to answer.

## Checking the next gate — and correcting myself again

The re-scope flagged one thing as unverified and blocking: **would Ubuntu's `kicad-packages3d` 7.0.11
actually satisfy references naming `KICAD9`/`KICAD10` paths?** It said to measure that before anyone spends
5.7 GB. So I did, without spending it.

**First correction: the download is 424 MB.** 5.7 GB is the *installed* size. The original framing treated
the number as the obstacle, and 424 MB is the part anyone actually waits for. Worth stating plainly.

Then I sampled 24 models the corpus references through an official variable and asked the upstream library
whether each exists at tag `7.0.11` and at `10.0.5`:

| | |
| --- | --- |
| in both | 8 |
| **only in 7.0.11** | **15** |
| only in 10.0.5 | 0 |
| in neither | 1 |

Backwards from what I expected, so I did not stop there. Listing one "missing" model's directory at both
tags showed what was really going on — the model is present in v10, as `.step`; it is the `.wrl` that is
gone. Counting per directory:

| directory | 7.0.11 wrl/step | 10.0.5 wrl/step |
| --- | --- | --- |
| `Connector_PinHeader_2.54mm` | 49 / 50 | **0** / 99 |
| `Resistor_SMD` | 40 / 40 | **0** / 40 |
| `Capacitor_SMD` | 50 / 50 | **0** / 91 |
| `Package_QFP` | 49 / 50 | **0** / 62 |

**Upstream dropped WRL in v9.** Stated from the library's `install()` rules, not its directory listing —
the distinction matters, because inferring the shipped contents from the repo contents is the mistake that
produced the previous version of this paragraph.

### What that overturns

The re-scope said "the official 5.7 GB library is mostly `.wrl`; everything outside it is mostly `.step`,
so the cheap path covers exactly the assets we do not have." The second half holds. The first half was
wrong, and wrong in a way worth naming: I inferred the library's contents from the *references in demo
boards*, never from the library. The demos still name `.wrl` because they were authored when it existed.

So the real position is sharper than the one I wrote:

- `assimp` + WRL works **only** against a library version upstream has abandoned.
- Ubuntu's "three majors stale" package is simultaneously the **only** easy path and a **dead end**.
- Anything meant to stay current must handle STEP, which means carrying a CAD kernel — that is the actual
  decision Phase 4 turns on, not the 5.7 GB.

That is twice now on Phase 4 that measuring has overturned a written assumption, and both times the flaw
was the same: inferring a property of one thing (the library) from evidence about another (the boards).

## Step 2: resolve to files, by basename rather than by extension

The recommendation coming out of the format work was: **STEP only, resolved by basename** — not "support
both". The reasoning, now that it is measured rather than assumed:

- Every library version ships `.step`. v6/v7/v8 ship it *alongside* `.wrl`; v9/v10 ship it alone. Checked
  from the library's own `install()` rules, which match `"*.wrl"` and `"*.step"` at 6.0.11/7.0.11/8.0.8 and
  only `"*.step"` at 9.0.9/10.0.5.
- So a STEP reader covers v6 → v10. WRL support would duplicate coverage on old installs and add nothing
  on new ones.
- What *is* needed is the extension fallback, because boards keep naming the format they were authored
  with. Measured against the real library: **0 of 20** `.wrl` references resolve as written on a current
  install; **19 of 20** have a `.step` twin at the same basename.

### What was built

`modelResolve.ts` — resolve one reference to a file on this host, or say why not. `readBoard` stays pure
(no filesystem), exposing the unique raw paths; the route does the resolving, because only the bridge
knows the operator's mapping.

Two rules carry the weight, and both are tested by breaking them:

- **Basename fallback.** `Foo.wrl` finds `Foo.step`, and says `viaTwin` rather than pretending it found
  what was asked for. The named extension still wins when it is actually present — an old install has
  both, and the reference is the better signal about which the author meant.
- **Confinement.** Model paths come out of repository content, so `${VAR}/../../secret/tokens.json` is a
  model reference like any other. Resolution is confined to the mapped directory, compared after
  `realpath` so a symlink out is caught too, and a refusal is reported as `outside-root` rather than
  folded into `missing` — those mean different things and only one of them is someone probing.

`missing` and `unmapped` are also kept apart: one means the operator told us where to look and it is not
there, the other means they have not told us. Only the second is fixed by configuration.

### Verified against a real board

`video.kicad_pcb` is the exact case this exists for — a v6/v7/v8-era board where **all 27 references name
`.wrl`** — opened against a STEP-only library like KiCad 9+ ships:

| | |
| --- | --- |
| addressable | 23 configured, 4 from the repo |
| on disk | **present 24, of which viaTwin 23**, missing 3 |

**23 of 23 configured models resolved, every one of them through the fallback.** Without the rule this
board resolves zero. That is the entire difference between "3D is unavailable" and "3D is available" for
anyone who has upgraded KiCad since v8.

Nothing has been downloaded, no kernel carried, no renderer written. The next decision — whether a 4 MB
bridge should carry OpenCascade — now has real numbers to be made against, which was the point of doing
this first.

## The tab's two rules, moved somewhere a test can reach them

Separately from Phase 4, and prompted by the three defects v0.1.14 shipped: two of those three were
decisions living inside coroutines in `AppViewModel`, where nothing could call them. So both moved to
`ui/kicad/KicadTabRules.kt` as pure functions, with `AppViewModel` calling them:

- **`isKicadPath`** — decides whether a tab fetches the blob on open. Answering yes for a 66 MB board is
  what produced the 157 MB allocation that killed the app.
- **`boardLayersToShow`** — first open vs re-solve. The re-solve branch is the one that shipped wrong,
  resetting the user's chosen layers because a file changed on disk.

Nine tests, each pinned to a case that shipped wrong rather than one imagined, and all nine
mutation-checked: dropping the probing condition, dropping `intersect live`, conflating an *empty*
selection with *no* selection, and assuming `Edge.Cuts` is present are each caught by a different test.
The suite is 86 app tests, up from 77.

The Kotlin extraction is deliberately not a behaviour change — the bodies are the previous expressions
moved verbatim — so it belongs with the defect fixes rather than with Phase 4.

## How this branch splits

`fix/large-board-on-device` is carrying two unrelated scopes and should not go up as one PR. The
attribution is clean; the two touch disjoint files apart from `board.ts` and `kicadBoard.test.ts`, and
there at different commits.

**A — the v0.1.14 defect fixes** (this is what v0.1.15 is): commit `32f95e4` (OOM, `fontSize`), plus the
uncommitted `BoardView.kt` zoom fix, `KicadTabRules.kt` + its test, and the `AppViewModel` rewiring.
Needs the app version bump.

**B — Phase 4 coverage and model resolution**: commit `09cf8f8` (the re-scope), plus `modelResolve.ts` +
its test, the `board.ts` `ModelCoverage` walk, `boardService.ts`/`rest.ts`/`config.ts` wiring, the
`classifyModel` tests, this worklog, and the `PLAN` edits. Bridge-side only; no version bump until it
ships something a user can see.

B rebases onto A cleanly — its `board.ts` changes are additive to A's. A goes first because it is the
release.

## Resolution cost, measured rather than assumed

`resolveAll` runs on **every** board-index request, including cache hits — it sits after `getBoardIndex`
returns, so the parse cache does not cover it. That was worth a number rather than a shrug:

| board | unique models | before | after |
| --- | --- | --- | --- |
| `vme-wren` | 66 | 21.5 ms | **1.26 ms** |
| `tinytapeout-demo` | 27 | 12.3 ms | **1.30 ms** |
| `One-Air-Max` | 40 | 2.4 ms | **0.39 ms** |

The first measurement had 27 unique models costing five times more than 40, which is the shape of a
wrong explanation rather than a slow one — a warm-up pass ruled out cold FS cache and left the real
cause: `within()` called `realpathSync` on every candidate, including the ones that were never there.
`realpathSync` throws for an absent path, and constructing and catching ENOENT was almost the whole
cost. A `.wrl` reference generates three candidates, so a board of misses paid for three throws each.

Split in two: textual containment first (no syscall, and valid for a path that does not exist), then
`realpath` only for a file that actually exists — the only case where the two can disagree. 17× on the
board this feature exists for, and 21 ms of blocking syscalls off the event loop per request.

Behaviour is unchanged, checked end-to-end rather than by suite alone: `video.kicad_pcb` still reports
`present 24, viaTwin 23, missing 3` over HTTP, the same numbers as before the restructure.

### Two mutations survived, and one was a real gap

Re-running the break-check after the restructure — because the confinement rules had changed *shape*,
so the earlier verification no longer covered them:

- **Removing the textual check survived.** The traversal test targets a file that exists, so the symlink
  check caught it anyway and the test stayed green. But the comment claimed the textual check is what
  stops a probe being reported as a plain `missing` — and nothing tested that. A traversal to a path that
  *does not* exist now asserts `outside-root`, and that mutation is caught. Reporting `missing` there is
  a directory oracle: it says the path was accepted and merely empty.
- **Removing the fail-closed branch in `containedReally` survived, and stays uncovered.** `existsSync`
  and `realpathSync` resolve the same path the same way, so reaching it means winning a race between two
  syscalls. Flagged in the comment as deliberately untested rather than left looking covered — a test
  that cannot fail is worse than an absent one.

## An intermittently red suite, fixed

`BridgeClientRevokedTest` failed once during this work — `Gave up waiting for queue to shut down`, in
`tearDown`, nothing to do with the change under test. `job.cancel()` returns while the retry loop may
still be mid-dial, and `server.shutdown()` then races that connection. `cancelAndJoin()` waits for the
coroutine to actually stop, so nothing is left that could open another socket.

Three consecutive full-suite runs are green where it had flaked — not proof for a race, but the
mechanism is understood and the fix addresses it directly rather than widening a timeout.

## `kicad-embed://` — a third of `vme-wren`'s models were reported missing from the file containing them

Found by being asked *why* 27% of the corpus is unresolvable, and checking rather than reciting the
survey. Most of that 27% is honest — `${ANT3DMDL}` (66 unique) is a private library, `${EASYEDA2KICAD}`
(36) is a converter's output directory, and eight references are absolute paths into
`C:/Users/santa/Documents/…`. Those name someone else's machine and nothing we install will fix them.

But two entries in that bucket were mine, not the corpus's:

- **`${KISYS3DMOD}` (5 unique) is just the pre-v6 name for the official library.** An alias, not a
  missing library. Not yet fixed — noted here so it is not rediscovered as a mystery.
- **`kicad-embed://` (39 unique) is not unresolvable at all.** KiCad 9 stores the model *inside* the
  board, base64 over zstd — decoded one to confirm rather than trusting the magic bytes, and it is a
  real `ISO-10303-21;` STEP file, 448 KB from 72 KB compressed. The resolver saw a path with no
  variable, treated it as relative-to-project, found nothing, and reported `missing`.

On `vme-wren` that is **33 of 66 unique models**, and it is why the coverage reported earlier —
`present 1, missing 65` — was wrong. Now `present 1, embedded 33, missing 32`, with the remaining 32
genuinely absent because the test library only carries `video`'s models. `video` is unchanged at
`present 24, viaTwin 23`, which is the regression check that matters: it has no embedded models.

### Two filters, both load-bearing

The count is over payload entries, not references, and the difference is large:

| | `vme-wren` |
| --- | --- |
| per-footprint declarations | 155 |
| payload entries at board level | 45 |
| of those, `(type model)` | **33** |
| of those, `(type datasheet)` | 12 |

A footprint *declares* the embedded file it uses; the bytes appear once at board level. Counting
declarations would claim five times the models the file carries. And a board embeds more than geometry —
`vme-wren` carries 12 PDF datasheets — so without the type filter the coverage listed PDFs as models and
a `kicad-embed://…pdf` reference would have resolved as renderable. Both are the viewer-that-lies
failure in miniature: claiming a part is available and then having nothing to draw.

Five mutations, all caught: counting declarations, dropping the type filter, `classifyModel` forgetting
the scheme, treating every embed reference as available, and removing the branch entirely.

### It changes the kernel argument slightly, in the right direction

Embedded models are the cheapest case there is — no download, no operator configuration, no variable
that can fail. They are also STEP, so they still need the kernel; but they arrive with the board, which
makes the ahead-of-time pipeline more attractive rather than less: for a board like `vme-wren` half its
models need nothing fetched at all.

## One mapping for the official library, and the version question answered on the way

`${KISYS3DMOD}` was the last entry in the "unresolvable" bucket that was our bug rather than a fact
about somebody else's machine: it is the **pre-v6 name for the official library**, not a missing one.
Fixing it properly means treating all six names — `KISYS3DMOD` and `KICAD6`…`KICAD10_3DMODEL_DIR` — as
what they are: the same library, differently addressed. An operator maps **one**; the rest follow,
preferring the newest mapping.

That fallback assumes a v7-era filename still satisfies a v9/v10 reference, which `PLAN.md` had
explicitly flagged as **unverified and to be measured before anyone downloads 424 MB**. So it was
measured — basenames per directory, at four tags:

| directory | v6 | v7 | v9 | v10 | v7 names still at v10 |
| --- | --- | --- | --- | --- | --- |
| `Resistor_SMD` | 40 | 40 | 40 | 40 | 40/40 (100%) |
| `Package_QFP` | 68 | 68 | 62 | 62 | 59/68 (86%) |
| `Connector_PinHeader_2.54mm` | 278 | 278 | 278 | 278 | 278/278 (100%) |
| `Capacitor_THT` | 375 | 375 | 375 | 375 | 375/375 (100%) |
| `Package_SO` | 199 | 204 | 210 | 212 | 174/204 (85%) |
| **total** | | **965** | | | **926 (95%)** |

95% carry over, and the 5% that do not report `missing` — the same answer an operator would get for a
file genuinely absent from the version they *did* map. Nothing is claimed present that is not, which is
the only property that actually matters here.

Verified end to end by **deleting** mappings rather than adding one: the test config now maps only
`KICAD9_3DMODEL_DIR`, while `video.kicad_pcb` addresses `KICAD6` (14), `KICAD7` (1) and `KICAD8` (8).
All 23 resolve as `configured`, `present 24 / viaTwin 23` — unchanged from when all four were mapped.
Before the alias those 23 would have been `unmapped`.

The fallback is confined to that family. `${ANT3DMDL}` is somebody's private library, and resolving it
against the official one would return a part with the right filename and the wrong geometry — worse
than reporting nothing, and the sort of failure nobody would catch by looking.

### Two mutations survived first, and one exposed an untested common case

- **Removing the newest-first preference survived**, because every test mapped exactly one official
  variable, so ordering could never matter. Now pinned with two generations mapped to different
  directories.
- **Removing "exact mapping wins" survived**, and that one was the real gap: nothing tested that a
  mapped *non-official* variable resolves at all — the ordinary case of an operator mapping their own
  library. The alias rule sits in front of that path, so a fallback that forgot to honour the exact
  mapping first would have broken every private library while all the alias tests stayed green.

Also updated: one existing assertion in `kicadBoard.test.ts` encoded the old rule
(`${KICAD6_3DMODEL_DIR}` → `unmapped` when only `KICAD9` is mapped). That is a deliberate behaviour
change, not a broken test, so it now asserts the new boundary — the family aliases, everything outside
it does not.
