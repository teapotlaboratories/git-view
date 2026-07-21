# Worklog — Redesign step 2: chat transcript

**Date:** 2026-07-20 · **Branch:** `redesign/step1-tokens-theme` (step 2 stacks on step 1's tokens)

## Goal
Rebuild the agent chat as the readable/trustworthy transcript from the handoff (step 2 of the redesign
build order): `LazyColumn` + `StreamingText` + `ToolActivityCard` + shared `DiffRow`, fed by the
bridge WebSocket. The permission bar/sheet + inline approval and the budget bar are **step 3**;
Workspace IA is **step 4**; E-Ink transcript pagination is **step 6**.

## Owner decisions (confirmed before coding)
1. **Extend the wire** — add `tool_use_id` to `tool_use` + `tool_result` (robust card correlation;
   fixes the unreliable-`name` bug), and populate `tool_result.summary`/`content` (badge + result
   preview) in the bridge. Contract-first: `docs/API.md` → `wire.ts`/`Wire.kt`, re-verified live.
2. **Add a markdown library** — `com.halilibo.compose-richtext` (`richtext-commonmark` +
   `richtext-ui-material3`); themes via M3 so it inherits `profileTypography` (weight-based on E-Ink).

## Plan / status
- [x] Contract: `docs/API.md` §6.2 (+ `docs/html/API.html` twin) — `tool_use{id}`, `tool_result{id,summary?,content?}`.
- [x] ADR-024 (+ HTML twin) — tool-event correlation + capped result preview on the wire.
- [x] Bridge: `wire.ts` (fields), `sessionManager.ts` (emit `id`; map `tool_use_id`→name; compute summary + capped content).
- [x] Android wire: `Wire.kt` (`ToolUse{id,input}`, `ToolResult{id,summary,content}`), `BridgeClient.kt` parse.
- [x] Chat model: `ui/chat/ChatModels.kt` (kind-tagged `ChatItem`, `ToolKind` classify, Edit→diff synth — Compose-free, unit-tested).
- [x] `StreamingText`, `ToolActivityCard`, `ChatTranscript`, markdown via richtext; extracted shared `DiffRow`/`InlineDiff`.
- [x] `AppViewModel` transcript rework; `ChatScreen` swaps `ChatList`→`ChatTranscript`.

## Verification (done)
- **Bridge typecheck** clean; **`assembleDebug`** clean; **`testDebugUnitTest`** green (`ChatModelsTest` 7 + `DiffClassifierTest`).
- **Live local-SDK session** (bridge + real `claude` Opus, sandbox off, throwaway repo): a Read+Edit prompt
  produced `tool_use{id, input.file_path/old_string/new_string}` and `tool_result{same id, name filled,
  summary "8 lines"/"226 chars", content = line-numbered preview}` — correlation-by-id confirmed.
- **On-device (kancil_test phone), both profiles**: user bubble, Read + Edit `ToolActivityCard`s (name, mono
  path, badge, ✓), expand → Read preview + Edit synthesized diff; markdown inline `code` via richtext;
  streaming + cost accumulation. E-Ink shows strikethrough/bold diff + weight-based tool names + bordered
  cards; Standard shows green/red tinted diff + violet accent. Screenshots in the session scratchpad.
- **Bug found on-device + fixed + re-verified**: Read result content is already `N⇥…`-numbered by the SDK,
  so `PreviewBlock` no longer adds its own numbering (was showing "1 1", "2 2").

## Notes / decisions
- Markdown lib pinned to **`com.halilibo.compose-richtext:*:1.0.0-alpha02`** — the last release on Compose
  1.7.x; alpha03 needs Compose 1.8 / compileSdk 35, alpha04+ pulls Compose 1.11-beta. Themes via M3, so it
  inherits `profileTypography` (weight/mono on E-Ink).
- Result `content` capped (~120 lines / 8 KB, `… (truncated)`); Edit/Write inline diffs synthesized
  client-side from `tool_use.input` (old→new) via `classifyDiff`'s `@@`/`-`/`+` format.
- Tablet + Bigme-AVD form factors not re-captured (phone covered both profiles via the in-app toggle);
  the transcript is single-column so layout is form-factor-agnostic here.
- Deferred to later steps: permission bar/sheet/RiskMeter + inline approval (3), budget bar (3), Workspace
  segment/split (4), E-Ink transcript pagination (6), Sora editor code-font.
