# Chat transcript: open at the newest message + selectable text

Reported: "every time I open a chat it always brings me to the top; it should go down to the bottom
and tail it" — plus "can you have the content on the chat select and copyable".

## Findings

**1. Opening a chat lands on the oldest message.** `ChatTranscript.kt` scrolled to a target derived
from layout state:

```kotlin
val last = (layoutInfo.totalItemsCount - 1).coerceAtLeast(0)
scrollToItem(last)
```

On the first frame after a transcript loads the list has not been measured yet, so
`totalItemsCount` is still `0` → `last = 0` → it scrolls to **index 0, the top**. The caller's
settle loop was supposed to correct this on a later frame, but its exit condition is
`if (!listState.canScrollForward) break` — and an *unmeasured* list also reports
`canScrollForward == false`, so the loop read "top of an unmeasured list" as "already at the
bottom" and broke immediately. That combination makes the bug deterministic rather than flaky,
which matches the report of "always".

**2. Follow-state leaked across sessions.** `follow` was an unkeyed
`rememberSaveable { mutableStateOf(true) }`. Scrolling up to read history in one chat persisted
`follow = false` into every chat opened afterwards, so even reaching the bottom of a *new* session
would not start tailing until the user scrolled again.

**3. No text selection.** Nothing in the transcript was wrapped in a `SelectionContainer`, so no
reply, code block, or tool output could be selected or copied.

## Changes

- `scrollToNewest(lastIndex: Int)` now takes the target from `items.lastIndex` (the data) instead of
  `layoutInfo`. `scrollToItem` accepts an index the layout has not seen yet, so the correct target is
  available a frame earlier and does not depend on measurement.
- Added a `sessionKey: String?` parameter (wired to `ui.sessionId` in `Screens.kt`). `follow` is now
  `rememberSaveable(sessionKey)`, so scroll-up survives rotation *within* a chat but resets per chat.
- Added `LaunchedEffect(sessionKey, items.isNotEmpty())` that re-pins to the newest message when a
  chat opens. `items.isNotEmpty()` is part of the key because a resumed transcript arrives *after*
  first composition, so the jump has to wait for the data.
- Wrapped the transcript in `SelectionContainer`, with `DisableSelection` around the pending-approval
  and attachment rows (pure controls, where a long-press should not start a selection drag).

The existing user-scroll detection is unchanged: scrolling up still stops the auto-scroll and
scrolling back to the bottom still resumes tailing.

## Verification status — INCOMPLETE, honest record

- ✅ `gradle :app:assembleDebug` clean (exit 0).
- ✅ Installed on the `kancil_test` phone AVD; app launches with **no crash** (`pidof` alive, no
  `AndroidRuntime:E` / FATAL in logcat). This does rule out a runtime blow-up from the
  `SelectionContainer` / `DisableSelection` wrapping, since the app composes and runs.
- ❌ **The transcript behaviour itself is NOT verified on-device.** The app resumed onto the
  Connections screen and reaching a chat with a long transcript needs a reconnect → open repo →
  resume session flow; I ran out of the session's token budget before completing it. So
  open-at-newest, continued tailing, scroll-up-to-pause, and long-press-to-copy are currently
  supported by the code reasoning above and a clean build **only**.
- ❌ Three form factors (phone / Tab S8 / Bigme B7 e-ink) not captured — same blocker. The e-ink
  path matters here because Paginate mode takes a different branch in both effects.

**Next session should start by finishing that on-device pass** before this is treated as done.

## Environment notes

- The emulator crashed on launch with a Qt platform-plugin error until given `-no-window`; headless
  is the working invocation on this box (`emulator -avd kancil_test -no-window -no-snapshot-save
  -no-boot-anim -gpu swiftshader_indirect`).
- The attached physical device (`e445f6e`) shows `no permissions (missing udev rules)` and is not
  usable for verification as-is.

---

## On-device verification — completed (phone AVD, `kancil_test`)

Paired the app to the local bridge (`10.0.2.2:8787`), opened the `git-view` workspace, and resumed a
**long** session from the picker.

- ✅ **Opens at the newest message.** On resume the transcript rendered the *latest* activity, not the
  start of the session. Confirmed twice, on two separate builds. Cross-checked by tapping
  jump-to-newest immediately after opening: the content did not change, i.e. we were already there.
  This is the reported bug, fixed.
- ✅ **Text is selectable and copyable.** Long-press on assistant prose raises selection handles and a
  **Copy / Select all** toolbar — screenshot: `2026-07-23-chat-selection.png`. Note that
  `uiautomator dump` does *not* show this toolbar (it is a separate popup window), so the dump-based
  check was a false negative; the screenshot is the real evidence. Tool cards remained tappable.
- ⚠️ **Auto-tail resume is still unproven.** While verifying, the jump-to-newest button stayed visible
  even after swiping hard to the end. That is pre-existing behaviour (`canScrollDown` has always been
  `listState.canScrollForward`), not something this change introduced.

### Attempted fix for that, then reverted — recorded so it isn't retried blindly

Hypothesis: bottom `contentPadding` keeps `canScrollForward == true` at the true end, which would make
`follow = !canScrollForward` permanently false after any manual scroll and so kill auto-tail. Wrote an
`isAtNewest(lastIndex)` geometry helper (last visible item is the last index *and* its bottom edge is
within `viewportEndOffset + afterContentPadding`) and used it for the follow decision, the settle-loop
exit, and the button's visibility.

It could not be validated: **the session under test is this very session**, so every `adb` command
appended new transcript items and "at newest" was a moving target — indistinguishable from "detector
returns false". Shipping an unverified change here risks setting `follow = false` after every scroll,
which would break tailing *worse* than the status quo, so it was reverted to `canScrollForward`.

**To settle it next time:** resume a session that is NOT being written to (e.g. the short "Respond with
PONG" session), scroll to the end, and check whether the jump button disappears. That isolates the
detector from live growth.

### Not covered
Tablet + Bigme e-ink form factors were not captured (phone only). The e-ink path matters here because
Paginate mode takes the other branch in both scroll effects.

---

## Review follow-ups (PR #33 self-review) — #1, #2, #3

**#1 — orphaned KDoc.** The `/** Common Claude models… */` comment had been left above `modelLabel`
after the helpers were inserted; moved it back onto `MODEL_CHOICES`. (Screens.kt.)

**#2 — re-pin no longer yanks during a new chat's first exchange.** `follow` + the open-re-pin were
keyed on `ui.sessionId`, which is null on a brand-new chat until `session.init`; that null→id flip
mid-first-exchange reset follow and re-pinned to newest. Re-keyed both on the transcript's OLDEST item
id (`items.firstOrNull()?.id`) — a globally-unique UUID (`newId()`), stable for a chat's whole life and
changing exactly when you open/switch chats. Dropped the now-unused `sessionKey` param + call-site arg.

**#3 — auto-tail resume: CONFIRMED broken, then fixed + verified.** On-device on a *static* transcript,
the jump-to-newest button persisted at the true bottom — so `canScrollForward` really does stay `true`
there (instrumented: `end=1339 afterPad=33`, and at a normal transcript's bottom `off+size=1290 ≤
end=1323` with `canFwd=false`, but the huge 679-item session kept `canFwd=true`). Left as-is,
`follow = !canScrollForward` never re-enabled, so auto-tail didn't resume after a manual scroll.
Replaced the signal with a geometry helper `LazyListState.isAtNewest(lastIndex)` (last item is the last
index AND its bottom edge is within the viewport, `+4` rounding slack), used for the follow decision,
the settle-loop exit, and the jump-button visibility. Verified on a clean transcript (30-row table):
at bottom → button hidden; scroll up → button appears; scroll back to bottom → button hidden **and
follow resumes**. This is the earlier-reverted fix, now grounded in measured `layoutInfo` and confirmed.

(Debug `Log.i` instrumentation used to capture the layoutInfo values was removed before commit.)
