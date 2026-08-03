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
