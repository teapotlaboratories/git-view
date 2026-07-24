# Reasoning-effort selector (Claude agent settings)

Asked for: an effort-level selection under the model selection in settings.

## SDK basis (checked, not assumed)
The installed Agent SDK (0.2.141) takes effort on the query `Options`:
`effort?: EffortLevel` where `EffortLevel = 'low'|'medium'|'high'|'xhigh'|'max'`
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:480` and `:1425`, inside
`export declare type Options = {` at `:1155`). Support is model-dependent — `xhigh` is documented as
Opus 4.7 only, `max` as select models — and the SDK *silently downgrades* an unsupported level
(`sdk.d.ts:141`). Since the Model field accepts arbitrary custom ids, the app cannot know the target
model's capabilities, so the UI hints at this instead of filtering the list.

## Design — mirrors the existing model override exactly
- `claude.effort` in config.yaml is the **reset target** (optional; unset ⇒ no `effort` key is passed
  at all, so the CLI default stands and today's behaviour is unchanged).
- `ClaudeSettingsStore` gains an `effort` override persisted in the same 0600 `claude-settings.json`.
- `GET/PUT /v1/claude/settings` gain `effort` + `configEffort`; PUT is present-key-only and `""` clears.
- `sessionManager.start()` sets `options.effort` only when a level is in force.
- Validation lives at the boundary: an unknown level is a **400**, never reaching the SDK where it would
  fail the query mid-session. The store also re-validates on *load*, so a hand-edited file can't smuggle
  a bad level in.

## Verification

Bridge unit tests — **111 pass** (10 new, `test/claudeEffort.test.ts`): unset stays undefined, config
default vs override precedence, blank/null reset, reset with no config default, rejection leaves prior
state intact, all five levels round-trip through persistence, coexistence with model+auth, bogus value
in a hand-edited file ignored on load, file stays 0600, `isEffortLevel` narrowing.

Live REST round-trip against a scratch bridge (`GITVIEW_CONFIG=… node dist/index.js`, port 8791,
`claude.effort: medium`):

| step | result |
|---|---|
| GET, no override | `effort: medium`, `configEffort: medium` |
| PUT `{"effort":"xhigh"}` | `effort: xhigh` |
| PUT `{"effort":"turbo"}` | **HTTP 400** `unknown effort level "turbo" (expected low, medium, high, xhigh, max)` |
| GET after the rejected PUT | still `xhigh` — the bad write did not clobber |
| PUT `{"effort":""}` | `effort: medium` (back to config default) |
| persisted file after reset | `{}` — override cleared, not pinned to "" |

App: `gradle :app:assembleDebug` clean.

## On-device verification — completed (phone AVD, `kancil_test`)

Paired to the real systemd daemon on `:8787`, opened `git-view`, ⋮ → **Claude agent…**:

- ✅ **Effort renders directly under Model**, labelled `Effort`, showing
  `Default · Claude CLI default` when nothing is pinned, with the capability hint beneath
  (`2026-07-23-effort-dropdown.png`).
- ✅ **Dropdown lists exactly**: `Default · Claude CLI default`, `low`, `medium`, `high`, `xhigh`, `max`.
- ✅ **Select → Save persists.** Picking `high` and saving wrote
  `/var/lib/gitview-bridge/claude-settings.json` = `{"effort": "high"}`.
- ✅ **Reopening pre-fills the stored level** — the dialog came back showing `Effort: high`, i.e. it is
  read back from `GET /v1/claude/settings`, not just local state (`2026-07-23-effort-persisted.png`).
- ✅ **Default clears the override.** Selecting Default and saving returned the file to `{}` — the
  daemon was left unpinned, as found.

### Gotcha that cost a cycle: the packaged daemon was a stale build
The first pass looked like a save bug — the field showed `high`, the dialog closed, but the settings
file stayed `{}`. The PUT *had* reached the bridge (audit line at the right second), yet nothing stored.
Cause: the running daemon is `/opt/gitview-bridge/dist`, installed from the `.deb` **before** effort
existed (`grep -c effort /opt/gitview-bridge/dist/http/rest.js` → `0`, local dist → `5`). It silently
ignored the unknown `effort` key. Rebuilding + reinstalling the `.deb` fixed it immediately.
**Any app-side test of a new bridge field must redeploy the `.deb` first** — `npm test` and a scratch
bridge both pass while the packaged daemon is still old, so this failure mode looks like an app bug.

### Audit gap found and fixed
The settings audit line recorded only `model=… auth=host`, so an effort change left no trace —
`docs/SECURITY.md` states every write is audited. `rest.ts` now logs
`model=… effort=… auth=…`; verified live: `target":"model=claude-opus-4-8 effort=default auth=host"`.
Re-ran the suite after the change: **111 pass**.

### Not covered
Tablet and Bigme e-ink form factors were not captured (phone only). The dialog is a plain
`AlertDialog` with no Paginate-specific branch, so the risk is low, but it is unverified.

### Side effect to note
While testing an earlier scratch bridge, a `pkill` pattern also killed the real systemd daemon; it was
restarted (`systemctl start gitview-bridge`) and is healthy. Kill scratch bridges by port or PID, never
by a `node dist/index.js` pattern that matches the service.

---

## Follow-up: friendlier model labels

Asked for: drop the `claude` prefix, dashes as spaces, capitalised.

Added `modelLabel()` in `ui/Screens.kt`:
`id.removePrefix("claude-").split('-').filter { it.isNotEmpty() }.joinToString(" ") { it.replaceFirstChar(Char::uppercase) }`

Applied to the three **display** sites only — the read-only field, the `Default · …` row, and each
menu row. `onClick` still assigns the **raw id**, state still holds the raw id, and the
`model !in MODEL_CHOICES` custom-detection still compares raw ids, so a relabel cannot change which
model is selected. The `Custom…` free-text field deliberately keeps the raw id (it is an id input, and
showing a prettified name there would invite typing a name that is not a valid model id).

Renders as: `Opus 4 8`, `Opus 4 7`, `Sonnet 5`, `Haiku 4 5`, `Fable 5` (`2026-07-23-model-labels.png`).

**Verified on-device that it stayed cosmetic:** selected `Sonnet 5` from the menu and saved → the bridge
stored `{"model": "claude-sonnet-5"}` and audited `model=claude-sonnet-5`, i.e. the raw id, not the
label. Reopening showed `Sonnet 5` in the field. Reset to Default returned the file to `{}`, leaving the
daemon unpinned.

**Resolved:** the owner wants the dotted, human-friendly form, and the same treatment for effort.

## Does the SDK provide the labels? — checked, and NO (for this use)

`ModelInfo` has `displayName` (`sdk.d.ts:1089`), but the only way to obtain it is
`Query.supportedModels()` (`sdk.d.ts:2023,2104`) — a method on a **live query handle**, not a
standalone export. Ran it against the packaged SDK to see what it actually returns:

```
default             -> "Default (recommended)"   effort: low..max
opus[1m]            -> "Opus"                    effort: low..max
claude-fable-5[1m]  -> "Fable"                   effort: low..max
sonnet              -> "Sonnet"                  effort: low..max
haiku               -> "Haiku"                   (no supportsEffort / levels)
```

Three reasons not to use it for labelling:
1. The names are **unversioned** — `"Opus"`, not `"Opus 4.8"`. It cannot label a version-pinned list.
2. The values are CLI **aliases** (`opus`, `sonnet`, plus a `[1m]` context-variant suffix), not the
   pinned ids the app stores. Adopting the list would silently switch model pinning from an exact
   version to a floating alias — a behaviour change, not a labelling change.
3. It costs a **CLI process spawn** per fetch, and would need an endpoint, caching, and a fallback.

Genuinely useful finding to keep: **Haiku reports no effort support at all**, and the other models
report all five levels. That corroborates the capability hint shown under the dropdown. Exposing
`supportedEffortLevels` per model (to grey out unsupported levels) is a possible future improvement,
but it needs the spawn+cache endpoint above, so it was not built.

## Labels implemented locally

`modelLabel()` derives the name rather than using a lookup table, so a new pinned id reads correctly
with no code change: drop the vendor prefix, title-case the name words, and rejoin a **trailing run of
numeric segments** with dots (that run is the version; interior dashes are word separators).

```
claude-opus-4-8 -> Opus 4.8      claude-haiku-4-5 -> Haiku 4.5
claude-sonnet-5 -> Sonnet 5      my-custom-model  -> My Custom Model
```

`effortLabel()` maps the wire values to words: Low / Medium / High / **Extra high** / **Maximum**.
The capability hint was reworded to match ("Extra high / Maximum need a model that supports them") —
it previously said "xhigh / max", which no longer appeared anywhere in the UI.

**Verified on-device** (`2026-07-23-friendly-labels.png`): the dialog shows `Default · Opus 4.8` and the
effort menu lists Low / Medium / High / Extra high / Maximum.

**Cosmetic-only, proven both directions:**
- Selecting `Sonnet 5` stored `{"model": "claude-sonnet-5"}` (raw id, audited as such).
- Selecting `Extra high` stored `{"effort": "xhigh"}` (raw wire value).
- Reopening with `xhigh` stored rendered `Extra high`, so the read-back path maps too.
- Selecting Default cleared both — the daemon was left at `{}`.

## Emulator note
Partway through, `screencap` began returning all-black frames while `uiautomator` still reported a
correct hierarchy — the renderer degrades after repeated boots on this box. Killing and rebooting the
AVD restored it. A black screenshot here means "restart the emulator", not "the app broke".

## Three form factors (captured sequentially, one AVD at a time)

| device | AVD | resolution | screenshot |
|---|---|---|---|
| Phone | `kancil_test` | 1080×2340 | `2026-07-23-agent-dialog-phone.png` |
| Galaxy Tab S8-class | `tabS8` | 2560×1600 landscape | `2026-07-23-agent-dialog-tablet.png` |
| Bigme B7 Pro (E-Ink profile ON) | `bigmeB7` | 1264×1680 | `2026-07-23-agent-dialog-eink.png` |

The dialog holds up on all three: Model reads `Default · Opus 4.8`, Effort reads
`Default · Claude CLI default`, and the capability hint wraps to two lines on the phone and e-ink,
one line on the tablet. On the tablet the dialog centres over the two-pane explorer+chat layout. On
e-ink the **Color E-Ink DisplayProfile** was toggled on via ⋮ → "Switch to E-Ink display": the dialog
inverts to the high-contrast light surface, controls are distinguished by border and weight rather than
hue (the segmented auth control shows the selected item by fill + check, not colour), and the file list
behind it switches to the paginated footer (`1–10 of 10`) instead of a scroll.

Driver notes for repeating this: each emulator is a distinct device, so **each needs its own pairing**
(`kill -HUP` the bridge, read the code from the journal, type it in). Also, `content-desc="more options"`
is NOT a workspace marker — the Connections screen carries the same descriptor; use
`content-desc="git actions"`, which only exists inside a workspace.
