# 2026-08-12 — the `.deb` now sets up 3D instead of leaving it to be discovered

Plan item **A**: v0.1.15 shipped the 3D viewer and a freshly installed bridge could not render a single
part, because the package set neither a mesh cache nor any model-path mapping. Both bridges in use were
in exactly that state.

## What the code said that the plan did not

The plan called for pre-mapping "the six official `KICAD*_3DMODEL_DIR` names". Reading `board.ts` first
showed that is unnecessary: `libVarFor` already aliases every official name onto whichever one *is*
mapped, newest first. **One entry covers the family**, and six identical lines would be busywork that
silently costs coverage the day one is missed.

That is not a hypothetical — `video.kicad_pcb` references three generations (`KICAD6`, `KICAD7`,
`KICAD8_3DMODEL_DIR`) and all of them resolve through the single mapped entry.

## Two defects caught before shipping

**1. A bare `modelPaths:` parses as `null`, and the schema rejects it.** The first version wrote

```yaml
  modelPaths:
    # No official 3D library found. Install one and add it here:
    #   KICAD9_3DMODEL_DIR: /usr/share/kicad/3dmodels
```

A key whose only children are comments is `null`, not `{}`. `z.record(...).default({})` accepts
*undefined*, not *null*, so the bridge would have refused to load its config — on the branch taken by
every machine **without** the KiCad library, which is the common one. "3D unavailable" would have become
"the bridge does not start". Now an explicit `modelPaths: {}`, checked against the real zod schema rather
than against YAML alone, because YAML was perfectly happy with the broken version.

The example is written as a full replacement block rather than lines to uncomment, since entries cannot
follow an inline `{}`.

**2. `postinst` edits the conffile the package ships.** Documenting the `kicad:` block in
`packaging/deb/config.yaml` seemed obviously good, and it made `dpkg` prompt **interactively on every
upgrade** of an existing install: the shipped file had changed *and* the local one had been modified by a
previous `postinst`. That is fatal in any non-interactive context — it is exactly how the target machine
ended up half-configured mid-test. The template is reverted and the documentation rides in the block
`postinst` appends; the shipped conffile is byte-identical to the released one, confirmed by hash.

## Verifying

Both branches, on two machines, because the risky one is the branch most installs take.

**Library absent** (the second bridge): no prompt, config written, mesh cache created, service starts,
`/v1/health` answers, no errors in the journal.

**Library present** (`kicad-packages3d` 7.0.11, detected as `KICAD7_3DMODEL_DIR`): mapped automatically,
and measured against corpus boards rather than asserted —

| board | library mapped | no library |
| --- | --- | --- |
| `video` | **24 present**, 0 unmapped | 1 present, 23 unmapped |
| `vme-wren` | **29 present** + 33 embedded, 0 unmapped | 0 present + 33 embedded, 33 unmapped |

The comparison run nearly lied: the first "no library" config was produced with `sed`, which did not
match, so it still had the library mapped and would have shown no difference at all. Checking the config
before trusting the numbers is what caught it.

## Not done here

The operator still runs the converter once per repo — that is plan item **B** (ship it in the package)
and **C** (spawn it on demand). And a v7 library against v9/v10 references resolves ~95% of names; the
remainder report `missing`, which is the same answer a genuinely absent file gives.
