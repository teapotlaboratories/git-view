# Worklog — Redesign step 5: Connections & Repos status

**Date:** 2026-07-21 · **Branch:** `redesign/step1-tokens-theme` (steps 1–5 stack)

## Goal
Redesign step 5: surface live status. Connections → "Bridges" with reachability + latency + "used ago"
+ per-bridge provider; Repos cards get git-state chips (`main · ↑2 ↓1 · 3 dirty`); History commits get
`+/−` stats (`1 file · +7 −1`).

## Owner decision
**Extend the bridge** for git-state: `RepoSummary` gains `branch/ahead/behind/dirty`, `CommitSummary`
gains `files/additions/deletions` (git computes). (Reachability + latency stay client-side via `/health`.)

## Scout findings
- `GET /v1/repos` is built from **static config** — `defaultBranch` hardcoded `"main"`, no live git-state.
- `log()` returns commits with **no stat**. `status()` + `getRefs()` exist; `rev-list` NOT in the read allowlist.
- `Connection` entity (Room v1) has no `provider`/`lastUsedAt` → needs a v1→v2 migration.
- `/v1/health` exists → latency = client-side round-trip timing.

## Plan / status
- [x] Bridge: `gitService.ts` (`repoState` + `log` `--shortstat` parse + allow `rev-list`), `rest.ts` `/repos`
      (parallel repoState), `wire.ts` (RepoSummary + CommitSummary fields). Typecheck + build clean.
- [x] Docs: `API.md`(+html) payloads; ADR-027 (+html) git-state on the wire.
- [x] Android wire: `Wire.kt` (RepoSummary + CommitSummary fields, defaulted for `ignoreUnknownKeys`).
- [x] Room: `Connection` += `provider` (SessionProvider + `Converters`) + `lastUsedAt`; **Migration(1,2)**
      (`ALTER TABLE … ADD COLUMN`, non-destructive); db version 2.
- [x] VM: `Reachability` map (online/latency/checkedAt, 15s poller while Connections visible + `Retry`),
      per-bridge provider (`setConnectionProvider` + `selectConnection` sets `ui.provider`), `touch` on select.
- [x] UI: Connections "Bridges" redesign (`StatusDot` ●/○, latency, "used Xm ago", `ProviderToggle`,
      dashed `AddBridgeRow`/`AddBridgeForm`); Repos `RepoStateChips` (`feature-1 · ↑1 · 2 dirty`);
      History `CommitStat` (`3 files · +3`). Hued off E-Ink / weight+glyph on E-Ink (`GitViewColors.hueless`).
- [x] Verify: bridge live (repos `{branch,ahead:1,dirty:2}` + log `3 files +3` / `2 files +8`); on-device
      Connections + Repos + History on **3 form factors** (see below).

## Verification (2026-07-21)
- **Bridge live:** fresh build, paired; `GET /v1/repos` → `feature-1 · ↑1 · 2 dirty`;
  `GET /v1/repos/demo/log` → `local ahead commit: 3 files +3`, `init: 2 files +8`.
- **Room v1→v2 migration:** installed the new APK **over old v1 data** on 3 emulators; app opened with **no
  crash**, and the pre-existing `demo` + `notes` connections were preserved (provider defaulted to `Local`,
  `lastUsedAt` null → "never used"). Migration path confirmed on real old data, not just a fresh install.
- **bigmeB7 (Color E-Ink, 632dp):** Connections (● online·1207 ms / ○ offline+Retry, hueless glyphs),
  Repos (`feature-1 ↑1 2 dirty`, ink), History (`3 files +3` / `2 files +8`, `+` sign carries add).
- **kancil_test (phone, Standard):** Connections (**green** ● online·72 ms / **amber** ○ offline / violet
  Retry), Repos (**amber** "2 dirty"), History (**green** `+3` / `+8`).
- **tabS8 (tablet 1280×800dp, Standard):** Connections width-capped + centered at 640dp, hued as phone.
- **Reachability poller:** demo (8787, real bridge) → online + latency; notes (8899, nothing) → offline +
  Retry; latency observed 72–1207 ms depending on box load.

## Scope OUT (→ step 7 states polish)
Loading skeletons, offline banner, error variants — step 5 does the status data + redesigned cards + a
basic empty/loading state, not the exhaustive states polish.
