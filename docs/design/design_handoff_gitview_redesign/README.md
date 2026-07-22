# Handoff: GitView Redesign (Standard + Color E-Ink)

## Overview
GitView is a native **Android (Jetpack Compose + Material 3)** git editor with a full-tool
Claude agent working the same repo over a Tailscale bridge. This package redesigns its visual
identity and rebuilds four weak points: an illegible agent chat, a permission system shown as
jargon, no fluid path between editing and chatting, and e-ink treated as a recolor. It ships
**one component set in two first-class visual languages** — **Standard** (LCD) and **Color
E-Ink** (Bigme B7 Pro, Kaleido 3).

## About the Design Files
The file in this bundle (`GitView Spec.dc.html`) is a **design reference created in HTML** — a
prototype showing intended look and behavior, **not production code to copy**. The task is to
**recreate these designs natively in the GitView Android app** using Jetpack Compose + Material 3
and the app's existing patterns (Sora Editor view, the bridge REST + WebSocket client). Treat
the HTML/CSS as a spec for layout, tokens, and behavior — re-express everything as composables.
Do **not** ship a WebView.

To view the prototype: open `GitView Spec.dc.html` in a browser (keep `support.js` beside it).
The **Chat** section is interactive — send a message, expand a tool call, open the permission
sheet, switch to "Ask first" to trigger the inline approval gate.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, dp measurements, component mapping, and
interactions are specified. Recreate pixel-faithfully with Compose/Material 3 components; where
a value isn't listed, match the prototype. Chat streaming/tool/diff/permission behavior is the
priority and is fully demonstrated in the prototype.

## Direction & Type
- **Modern editor** direction: dark violet Standard UI, near-mono paper E-Ink.
- **UI font:** IBM Plex Sans. **Code font:** JetBrains Mono. (E-Ink code stays monospace.)
- Auto-detect picks the profile per device; a **user override always wins**.

---

## Design Tokens

### Standard color scheme (dark)
| Role | Hex | Usage |
|---|---|---|
| background | `#14161B` | app canvas, editor gutter |
| surface | `#181B21` | bars, cards, sheets |
| surfaceVariant | `#1E222A` | inputs, chips, hover |
| border | `#262B34` | hairlines, dividers |
| borderStrong | `#2A2F3A` | raised / focused edges |
| primary | `#7F7BF5` | accent, active nav, send, caret, selection |
| primarySoft | `#A99DFF` | tool names, links on dark |
| onPrimary | `#0E0F14` | text/icon on primary |
| textHi | `#E4E7EC` | titles, code |
| textMid | `#CDD2DB` | body |
| textLow | `#8B93A1` | meta, labels |
| textFaint | `#5C6472` | placeholders, disabled |
| add / success | `#4ED08A` | diff add, online, done |
| remove / danger | `#F0736A` | diff remove, error, destructive |
| warning | `#E0A96D` | medium risk, dirty |
| info | `#57A3E8` | branch, informational |

Diff add background tint `rgba(78,208,138,.13)`; remove tint `rgba(240,115,106,.13)`.

### Color E-Ink scheme (near-mono paper)
| Role | Hex | Usage |
|---|---|---|
| background | `#FCFCFA` | app canvas |
| surface | `#FFFFFF` | cards, bars, sheets |
| surfaceVariant | `#F1F1ED` | inputs, selected fill, added-line band |
| border | `#C7C7C1` | hairlines (visible on Kaleido) |
| borderStrong | `#8C8C85` | emphasis rules, focus |
| inkHi | `#0A0A0A` | text, code, icons |
| inkMid | `#33332F` | body |
| inkLow | `#63635C` | meta (min weight 500) |
| accent | `#4A4780` | the ONE muted violet: selection, active tab underline (sparing) |

**E-Ink carries semantics without hue:** diff **add = bold**, **remove = strikethrough**, the
`+ / −` gutter is always kept; syntax = weight/italic; risk = filled/empty squares + text label;
status = text badges (`ONLINE` / `OFFLINE` / `DIRTY`), not colored dots.

### Type scale
| Token | Size / weight | Font | Use |
|---|---|---|---|
| Display | 62 / 700 | UI | onboarding hero only |
| Headline | 22dp / 600 | UI | screen & sheet titles |
| Title | 17dp / 600 | UI | card titles, list primary |
| Body | 15dp / 400 | UI | chat text, descriptions |
| Label | 13dp / 500 | UI | meta, chips, captions |
| Code | 13dp / 400 | JetBrains Mono | editor, diffs, tool args |
| Code-sm | 11.5dp / 400 | JetBrains Mono | paths, counts, ids |

E-Ink deltas: body floor **16dp**, low-contrast text min weight **500**.

### Spacing — 4dp base
`4 (xs)` chip inset · `8 (sm)` list gaps · `12 (md)` card/bubble padding · `16 (lg)` phone
gutters · `24 (xl)` section gaps · `32 (2xl)` tablet gutters / sheet padding.
**Touch targets: 48dp min (Standard), 56dp (E-Ink)** — fixes today's 34–36dp.

### Shape / elevation / motion
- **Standard:** corners 12dp cards/sheets, 8dp chips/inputs, 999dp send; depth = 1dp tonal
  surface + soft shadow; M3 emphasized easing 200–300ms; ripple; per-token chat streaming;
  skeleton shimmer.
- **E-Ink:** corners 6dp; **no shadow ever** (depth = 1.5px border); **no motion** (no ripple,
  overscroll, shimmer); press = instant 1-bit invert; streaming commits **whole lines**;
  navigation & long lists **paginate** in discrete full-screen repaints (no fling/scroll).

---

## Information Architecture
Collapse Browse + Chat into one **Workspace**:
- **Phone:** a `SegmentedButton` (Files ⇄ Chat) in the top bar — the agent is always one tap away.
- **Tablet:** a tree + editor + chat **split**; the divider is **user-draggable** (default ~55:45
  editor:chat, position persisted).
- **Diff, History, Commit** are overlays over the Workspace, not separate destinations.
- Nav path: Connections → Repositories → Workspace (+ overlays).

---

## Screens

### Connections
- **Purpose:** manage saved bridges (servers where repos live).
- **Layout:** `TopAppBar` (title "Bridges" 56dp + add `FilledIconButton`), section label "SAVED · n",
  a `LazyColumn` of bridge cards (padding 12dp, gap 10dp), then a dashed "+ Add a bridge" row.
- **Bridge card:** status dot + name (Title) + latency (e.g. `12ms`); mono base URL; sub-line
  "Online · used 2m ago". Offline card is dimmed with `Retry`. Pairing-required card shows a
  `Pair` filled button.
- **Compose:** `TopAppBar`, `ElevatedCard` (Std) / `OutlinedCard` (E-Ink), `ListItem`, `AssistChip`
  + `Badge` for status, `FilledIconButton`, pairing in `AlertDialog`. Reachability polled from the
  bridge `/health` over REST. **Remote / Local SDK provider is chosen per bridge here.**
- **States:** Loading = 3 skeleton cards (shimmer Std / static grey E-Ink). Empty/first-run =
  centered "Add your first bridge" + expanded form + Tailscale hint. Error = red/strike status +
  inline Retry; bad token → re-pair dialog. Offline = no-network banner, cards dimmed, stale clock.
- **E-Ink:** status as text badges, 56dp rows, filled-surface selection.

### Repositories & History
- Repo cards now carry **branch, dirty, ahead/behind** (e.g. `main · ↑2 · 3 dirty`).
- History commits gain **files-changed count + `+/−` stat** (e.g. `1 file · +7 −1`); tap → Diff overlay.
- **Compose:** `LazyColumn` of `OutlinedCard`; git state as `AssistChip`/text; E-Ink paginates.

### Browse / Editor (the Workspace)
- The **Sora Editor** `AndroidView` stays (fixed component — restyle chrome only).
- **Phone layout:** `TopAppBar` (56dp) with `SegmentedButton` Files/Chat (40dp) + overflow;
  `ScrollableTabRow` of open files (40dp) with a dirty `Badge` dot; path/ref bar (36dp) with a
  `main ▾` ref chip that **switches branch** and a save affordance; editor; bottom toolbar (48dp)
  with Diff dropdown + Save.
- **Tablet:** custom 2/3-pane `Layout` — tree (280dp) + editor + chat pane (360dp) — **draggable
  divider**, position persisted. Agent edits appear live in the open file.
- **E-Ink:** editor **paginates** (page prev/next footer, no fling); syntax = weight/italic;
  save/diff are full-width buttons; the tree opens as a full-screen list, not an overlay drawer.
- **States:** Loading = tab strip + gutter skeleton (Sora mounts on bytes). Empty = "Pick a file".
  Error = save-conflict bar (reload / overwrite / diff). Offline = read-only + reconnect banner,
  unsaved buffer preserved.

### Diff overlay
- Full-screen overlay; header 56dp with file switcher `DropdownMenu` (working tree / staged /
  commit); gutter 22dp; one **synchronized horizontal scroll** shared by all rows.
- **Standard:** add/remove tinted + colored gutter. **E-Ink:** add = **bold**, remove =
  **strikethrough**, gutter glyph kept, `surfaceVariant` band marks added lines. No hue.
- **Compose:** custom `DiffRow` (gutter span + code span) in a `LazyColumn`.

---

## Chat / agent session (PRIORITY)
The centerpiece — make the session readable and trustworthy.

- **Transcript:** `LazyColumn` fed by the bridge **WebSocket**. Message kinds: user bubble
  (right, primary), assistant markdown text (left, inline `code` spans), tool activity, inline
  permission request, streaming placeholder.
- **Tool activity (`ToolActivityCard`, custom):** collapsed = caret + tool name (colored) + mono
  path + result badge (`142ln ✓`) / spinner (running) / red `✕` (error). Tap header to expand:
  Read shows a line-numbered preview; Edit shows the write as an **inline diff** (reuse `DiffRow`).
  Standard uses `AnimatedVisibility` for the body; E-Ink is static.
- **Streaming (`StreamingText`, custom):** "Thinking" + animated dots → assistant text. Standard
  reveals **per token**; E-Ink commits **whole lines** (avoid ghosting).
- **Permission bar + sheet:** a persistent bar above the composer shows the active tier + a
  `RiskMeter` (4 bars) + risk label. Tap → `ModalBottomSheet` listing all six tiers (name, risk
  meter, description, `was: <oldName>`, selected check). In **Ask first**, an edit pauses for an
  inline `ElevatedCard` with **Allow once / Allow for session / Deny**; "Allow for session"
  permanently upgrades the tier to Auto-edit.
- **Cost:** not a bare number — **Turn $ · Session $** against a **budget** `LinearProgressIndicator`.
  At 100% → **warn** (banner + red bar), never hard-stop mid-turn.
- **Composer:** `OutlinedTextField` + `FilledIconButton` (↑ send / ■ stop while running).

---

## Permission model
Rename the six raw profiles; order by escalating risk; each has an explicit allow/deny and a
0–4 risk signal. **Default = `ask-first`.** Power user keeps every level.

| id | Name | was | Risk | Allows without asking | Prompts / denies |
|---|---|---|---|---|---|
| `read-only` | Read-only | read-only | 0 None | Read · search · analyze | All writes & commands |
| `ask-first` | **Ask first** *(default)* | confined | 1 Low | Nothing without your OK | Prompts on every edit & command |
| `auto-edit` | Auto-edit | acceptEdits | 2 Medium | Create/edit/delete in repo | Prompts before any command |
| `auto-run` | Auto-run | auto | 3 High | Edits + safe commands | Prompts on destructive / outside-repo |
| `no-prompts` | No prompts | dontAsk | 3 High | Edits + commands, no prompts | Still confined to repo dir |
| `unrestricted` | Unrestricted | bypass | 4 Critical | Anything, anywhere on host | No sandbox · **hold-to-confirm** |

Risk colors (Standard bars/labels): None `#57A3E8`, Low `#4ED08A`, Medium `#E0A96D`, High
`#E8895A`, Critical `#F0736A`. E-Ink: filled/empty squares + text label (`MEDIUM · 2/4`).
`Unrestricted` requires hold-to-confirm and shows a persistent red bar all session.

---

## Interactions & Behavior
- **Send** → `StreamingText` "Thinking" → assistant text → `ToolActivityCard` Read (running→ok)
  → assistant text → **Edit**: if tier is `ask-first`, emit an inline permission request and wait;
  otherwise apply directly. On apply, expand the tool body showing the diff, then a closing line +
  cost update. **Stop** cancels the in-flight turn.
- **Expand/collapse** any tool card by tapping its header.
- **Permission bar** tap opens the sheet; selecting a tier updates the bar and (for edits) whether
  future writes prompt.
- Transcript auto-scrolls to newest on update (do not use scrollIntoView on Android; set list
  position explicitly).
- **Standard** animates (M3 200–300ms, ripple); **E-Ink** does none of it (discrete repaints).

## State Management
- `profile: Standard | Eink` (auto-detected, user override wins) → drives `ProfileTheme`.
- Chat: `messages[]` (kind-tagged), `streaming/running`, `expanded[msgId]`, `tier`, `sheetOpen`,
  `cost {turn, session, budget}`, `pendingEdit` (held while awaiting approval), composer `input`.
- Workspace: `activePane (files/chat)` (phone), `splitRatio` (tablet, persisted), open tabs +
  dirty flags, active file, ref/branch.
- Connections: saved bridges + polled reachability/latency, active bridge, provider per bridge.
- Data: REST to the bridge (repos, files, history, diff, `/health`); one WebSocket for the agent
  stream (tokens + tool events + cost). No on-device git/LLM compute.

## Custom composables to build
`ProfileTheme` (token swap + motion gate) · `ToolActivityCard` · `DiffRow`/`DiffView` (shared by
Diff overlay + Chat) · `RiskMeter` · `WorkspaceScaffold` (segment/phone, draggable split/tablet)
· `EinkPaginator` · `StreamingText`. Everything else maps to stock M3 (`TopAppBar`,
`SegmentedButton`, `ScrollableTabRow`, `ListItem`, `Elevated/OutlinedCard`, `Filter/AssistChip`,
`DropdownMenu`, `ModalBottomSheet`, `AlertDialog`, `OutlinedTextField`, `Filled/IconButton`,
`LinearProgressIndicator`, `Badge`, `Snackbar`).

## Suggested build order (highest impact first)
1. **Design tokens + ProfileTheme** — both ColorSchemes, Typography, spacing/shape, motion gate.
2. **Chat transcript** — LazyColumn + StreamingText + ToolActivityCard + DiffRow over WebSocket.
3. **Permission model** — tiers, sheet, RiskMeter, inline approval.
4. **Workspace IA** — segment (phone) + draggable split (tablet); Diff/History overlays.
5. **Connections & Repos status** — reachability, latency, git-state chips.
6. **E-Ink profile pass** — EinkPaginator, no-motion, weight/underline semantics, 56dp.
7. **States polish** — loading / empty / error / offline across all screens.

## Resolved decisions (owner-confirmed)
- Default tier = **Ask first**.
- "Allow for session" **permanently** upgrades the tier (→ Auto-edit) until changed.
- Tablet split divider is **user-draggable** (persisted).
- Remote / Local SDK provider is set **per connection**.
- **Branch switching is in scope** for v1 (ref chip) + commit message & push.
- At 100% budget → **warn** (never hard-stop mid-turn).

## Assets
No raster assets. Icons = Material Symbols. Fonts = IBM Plex Sans + JetBrains Mono (bundle or use
Google Fonts). The "G" mark is a simple rounded-square glyph; replace with the real app icon.
Sora Editor is an existing embedded view — do not rebuild its text surface.

## Files
- `GitView Spec.dc.html` — the full interactive spec/prototype (design reference).
- `support.js` — runtime needed only to open the HTML prototype locally; not part of the app.
- `screens/` — reference PNGs: `01-hero`, `02-design-system`, `03-information-architecture`,
  `04-screens`, `05-chat-prototype`, `06-permission-model`, `07-flows`, `08-implementation`.
