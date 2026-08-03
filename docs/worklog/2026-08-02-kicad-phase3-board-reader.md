# 2026-08-02 — KiCad Phase 3: the board reader, and a cap that was measured wrong

Phase 3 reads `.kicad_pcb`. The reader was written before this branch existed and sat uncommitted; this
lands it, with the corpus survey that changed one of its decisions.

## The board is not a bigger schematic

Three things differ structurally, and each is a way to be wrong *invisibly*:

- **A net is an integer.** Tracks write `(net 1)` and the name lives in a table at the top of the file;
  pads write `(net 1 "GND")` inline. Skip the lookup and the geometry still draws — it just belongs to no
  net, so cross-probe selects nothing and looks like a UI bug.
- **An element belongs to several layers.** A via spans two, a pad names three. Take the first and the via
  vanishes from the side you are looking at while its tracks stay, which reads as a broken connection.
- **Footprint children live in the footprint's frame.** `fp_line` coordinates are local and rotate with the
  part. Emit them raw and every silkscreen outline stacks at the board origin — the same class of failure
  as the schematic's pin transform, and just as invisible to a suite that only checks the file parsed.

So the board gets its own primitive union. It shares `Pt` with the schematic and nothing else.

## The cap was justified from one board, and one board was not enough

The reader capped every layer at 20,000 primitives. The justification, written into the code, was measured
on `jetson-agx-thor-baseboard`: `User.9` carries 286,621 elements of annotation while `F.Cu` sits at
12,581. 20,000 looked like ample headroom.

Surveying the rest of the corpus before building the endpoint:

| board | MB | F.Cu | worst layer |
| --- | --- | --- | --- |
| StickHub | 1.0 | 976 | — |
| One-Air-Max | 2.3 | 796 | `B.Cu` 2,107 |
| CM5_MINIMA_3 | 3.2 | 1,794 | — |
| kit-dev-coldfire-xilinx_5213 | 2.6 | 2,312 | — |
| video | 5.5 | 5,376 | — |
| jetson-agx-thor-baseboard | 80.9 | 12,581 | `User.9` 286,621 |
| **vme-wren** | **66.4** | **20,887** | `F.Cu` 20,887 |

`vme-wren`'s `F.Cu` is over the cap. So **copper** — the one layer the whole feature exists to show — was
being silently shortened by 4%. That is the viewer-that-lies failure, arriving through the mechanism
introduced to prevent it.

The number that looked like ample headroom was actually 60% of the real worst case. Nothing about the
first measurement was wrong; generalising it from a single board was.

### The fix is a rule, not a bigger number

**Structural layers are the drawing; everything else is annotation on top of it.** Structural gets a
100,000 backstop (5× the worst measured, kept only against a hostile file); annotation keeps 20,000.

Deciding which is which cannot use KiCad's declared `kind`: it marks copper `signal`, but files
`Edge.Cuts` and `B.SilkS` as `user` — the same kind it gives a scratch overlay. Name is what separates a
board outline from someone's notes, so `isStructuralLayer` tests both.

Truncation is still always reported, and the message now says *which kind* of loss it was. "Some
annotation is missing" and "the drawing is incomplete" are not the same sentence, and a caller that has to
guess which one it got is back to guessing.

## Verified

14 tests, each checked by breaking the rule it protects — reverting `capFor` to the flat cap fails exactly
the three new ones and nothing else.

On the real boards, after the change:

| | |
| --- | --- |
| `vme-wren` `F.Cu` | **20,887 prims, `truncated=false`** (was silently cut at 20,000) |
| `vme-wren` `B.Cu` | 9,031, complete |
| `jetson` `F.Cu` | 12,579, complete |
| `jetson` `User.9` | 20,000, `truncated=true`, reported as annotation |

Parse/serve on `vme-wren` (66 MB): parse **3.9 s** once, index **0.4 s**, then `F.Cu` = 20,887 primitives
/ 2.4 MB in **0.27 s**. Re-parsing per layer cost 6.5 s each before parse and serve were split.

2.4 MB for one layer is a real cost and I am not pretending otherwise — but it is the copper, which is the
thing you opened the board to see. The lever for reducing it is asking for fewer layers, not shipping a
partial one.

## Still to build

The endpoint (`GET …/kicad/board`) and the renderer. Neither exists yet; the plan records them as ⬜.

## The endpoint — and a 64 MB wall only curl could find

`GET /v1/repos/:repo/kicad/board` — index without `layer`, one layer with it. `zones=0` drops the pours.
The service layer caches the **parsed tree**, not finished scenes, because parsing is the whole cost.

Measured through HTTP against the 66 MB `vme-wren` at a committed ref:

| request | time | payload |
| --- | --- | --- |
| index (cold — includes the parse) | **6.2 s** | 239 KB, no geometry |
| `layer=F.Cu` | **0.36 s** | 2.6 MB, 20,887 primitives, not truncated |
| `layer=B.Cu` | **0.29 s** | 1.1 MB |
| a `.kicad_pro` | — | 400, `not a readable KiCad board: …` |

Pay 6 s once, then a fifth of a second per layer toggle. That is the design working.

### The wall: `git_error: stdout maxBuffer length exceeded`

The board endpoint returned **422** for every committed ref, with a message naming an internal buffer
rather than the file. The working tree worked fine, which made it look like a ref-resolution bug.

`gitBuffer`'s `MAX_BUFFER` is **64 MB**. `vme-wren.kicad_pcb` is **66.4 MB**. Every file this bridge had
ever been asked for fit inside 64 MB — a schematic is ~1.5 MB — so nothing had come close. A KiCad board is
the first artefact this product opens that is bigger than the pipe built to carry it.

Blobs now get their own ceiling (192 MB), and the size is checked with `cat-file -s` **before** reading, so
exceeding it is a 413 naming the file and both numbers rather than a mystery after 64 MB have moved.

No test had a file big enough to notice, and no build would have. Only curling it did.

## Two self-inflicted incidents, recorded because they cost real time

**A literal NUL byte, for the third time in this repo.** I wrote the cache-key separator as an actual NUL
character rather than the escape sequence — in *two* files, and then a third time in the shell command
writing this very worklog entry, where the tool rejected it. The symptom is nasty: `grep` finds nothing in
the file (ugrep's `-I` skips it as binary), `file` reports `data`, and git would have committed it as
`Bin 0 -> N bytes`, unreviewable. `repoHygiene.test.ts` caught the second one, which is exactly why it
exists.

The board cache now keys on `JSON.stringify([resolved, path])`, which sidesteps separators entirely and is
injective, so `("ab","c")` and `("a","bc")` cannot collide on one entry. Choosing a construction with no
foot-gun beats remembering not to fire it.

**I destroyed the service file mid-fix.** Rewriting those lines programmatically, I used `open(p, "w")`
with an `ascii` encoding: Python truncates on open and *then* threw on an em-dash elsewhere in the file,
leaving 0 bytes — with no git copy to restore from, because the file was still untracked. Rewritten from
scratch. The lesson is dull and worth writing down anyway: write to a temp path and rename, or commit
before rewriting.

Also worth noting: one mutation in the break-test round silently did nothing, because backticks inside a
`python -c` string were command-substituted by bash before Python ever saw them. The test "passed" and
proved nothing — the same trap as the Gradle `25 up-to-date` run on the last branch. Mutations now assert
their anchor exists before writing, because a mutation that cannot fail is worthless in the same way a test
that cannot fail is.

## The renderer — and why it opens on an empty board

`BoardView.kt` draws a *chosen set of layers*, which is the one structural difference from the schematic
viewer and the thing the whole design turns on.

**Opening a board fetches the index and nothing else.** Only `Edge.Cuts` is switched on to begin with. That
looks timid until you price the alternative: the outline is ~2 KB and appears instantly, while `F.Cu` on
`vme-wren` is 2.6 MB. Spending megabytes before anyone has said what they want to look at is the wrong
default, and the layer chips carry their populations — `F.Cu 5376`, `B.Cu 4771`, `In2.Cu 540` — so turning
copper on is an informed choice rather than a surprise.

Only layers that hold something are offered. A board declares 39 and most are empty; listing all of them
would bury the four that matter.

**Draw order is the order a board is read**: copper, then silkscreen, then the outline last so the edge
stays legible over whatever is under it.

**Selection is by net, and only by net.** Tapping a track or pad selects the net it belongs to; highlight
is accent on colour and **stroke weight** on e-ink, the same weight-not-hue rule the diff and schematic
viewers follow. Component selection is deliberately *not* offered: it needs footprint-level hit-testing
that the per-layer wire format does not carry, and putting a control in the UI that half-works would be the
viewer-that-lies problem in a smaller costume.

**Truncation is surfaced in the UI**, not left in a field nobody reads. A layer cut short that looks
complete is exactly what the role-aware caps exist to prevent; the cap reporting itself is worth nothing if
the client swallows the report.

### Driven on a real board

`video.kicad_pcb` on the B7 Pro AVD with the Color E-Ink profile:

| step | result |
| --- | --- |
| open | index only; outline draws immediately — recognisably the card-edge board with its notches |
| tap `F.Cu 5376` | copper arrives: traces, pads, vias, the card-edge fingers |
| tap `F.SilkS 429` | silkscreen outlines over the copper |
| tap a trace | `Net: /CAS0-`, and that trace draws markedly heavier than its neighbours |

The last row is the one worth having a picture of: on a mono panel there is no accent to fall back on, so
if weight did not carry selection the feature would be invisible exactly where it is most needed.

### Not done, and not claimed

- **Component selection** — needs a footprint-level shape the per-layer format does not carry.
- **Phone and tablet** for *this* view. The schematic was driven on all three; the board has only been on
  the 1264×1680 e-ink panel so far. The layer chip row is the same 48 dp control as the net picker, so the
  tablet's narrow centre pane is again where it would show first.

### All three form factors, board view

| form factor | result |
| --- | --- |
| **Bigme B7 Pro** 1264×1680, Color E-Ink ON | outline → `F.Cu` → `F.SilkS`; tap selects `/CAS0-`, drawn markedly heavier — weight carries selection where there is no accent |
| **Phone** 1080×2340 | `F.Cu` in its copper red over the white outline; chip 48.0 dp, `clickable`, `checked` |
| **Galaxy Tab S8** 2560×1600 landscape | three panes, board in the **narrow centre**; six chips fit without wrapping |

Two things this cost that are worth writing down.

**The host ran out of memory with three emulators up.** `lowmemorykiller` killed the app mid-run and the
first phone attempt looked like a crash — 12 of 15 GB used, swap exhausted. It was the harness, not the
app. One emulator at a time from now on; freeing the other two took usage back to 5 GB.

**The tablet was in portrait and I nearly recorded it as landscape.** `wm size` reported `2560x1600` while
`screencap` returned a 1600×2560 image — the AVD's *natural* orientation is landscape, so `user_rotation 1`
rotated it away from what I wanted. `user_rotation 0` is landscape here. Checking the screenshot's actual
dimensions rather than trusting `wm size` is the only reason this did not go into the worklog wrong.
