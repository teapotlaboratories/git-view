# 2026-07-29 — the Add-a-bridge form sat behind the soft keyboard

Owner-reported: "when adding bridge, can you resize the screen when the keyboard is up? that way it does
not cover the input box."

## I could not reproduce it at first, and nearly shipped a fix that proved nothing

The obvious cause was a missing IME inset, so the obvious fix was `imePadding()`. I applied it, took an
"after" screenshot showing the form nicely above the keyboard, and was one sentence away from calling it
done — except the **before** screenshot, on a build without the fix, looked *identical*. With an empty
bridge list there is plenty of height; `adjustResize` already handled it and my change did nothing.

Two things had to be true before any of this meant anything:

- **The AVD suppresses the soft keyboard entirely when a hardware keyboard is attached.** Every early run
  was "verifying" a screen with no keyboard on it. `settings put secure show_ime_with_hard_keyboard 1`
  fixes that; `dumpsys input_method | grep mInputShown` is the check that the keyboard is genuinely up.
- **The list has to be populated.** The owner's suggestion — "can you try 5 bridges" — is what produced
  the bug. With cards filling the screen the form sits below the fold, and that is when it disappears.

With three bridges present, on a build without the fix, the entire form — Name, Base URL, Save, Cancel —
was behind the keyboard on **all three** form factors. You type into a field you cannot see.

## Two causes, not one

1. **The IME inset was never consumed.** The manifest sets `adjustResize`, but `enableEdgeToEdge()` means
   the system no longer insets the window, so Compose has to apply it. `imePadding()` on the *content box*
   (not the whole screen, so the top bar stays put). The chat and terminal panes already did this; the
   Connections screen was simply missed.
2. **The form was a sibling below the `LazyColumn`.** It only ever got the height the list left over. With
   the keyboard up that was nothing — and because the form was *outside* the scrollable area, nothing
   could bring it back. `imePadding()` alone left the tablet with its fields visible but **Save clipped to
   a sliver and Cancel gone**: you could type, but not submit. That is a bad place to stop.

The form is now the **last item of the list**, so it scrolls like any other row, and opening it scrolls it
into view (`animateScrollToItem`). `weight(1f, fill = false)` became `weight(1f)` so the list actually
fills the space it is allowed to scroll within.

## Verified on all three, before and after, keyboard genuinely up

| | without the fix | with `imePadding()` only | with the form inside the list |
|---|---|---|---|
| **Phone** 1080×2340 | form entirely hidden | full form visible | form scrolled into view, rest reachable |
| **Tab S8** 2560×1600 | form entirely hidden behind the split keyboard | fields visible, **Save clipped** | fields visible, **Save + Cancel one scroll away** |
| **Bigme B7** 1264×1680 e-ink | three cards then keyboard, form gone | full form visible | form scrolled into view |

The tablet is the case that justifies the bigger change: its split keyboard takes ~45% of the height, so
the form cannot fit in what remains no matter how the insets are applied. Reachable-by-scrolling is the
only honest fix there, and it was confirmed by scrolling to Save **with the keyboard still open**.

## Notes

- App only — bridge untouched. App **0.1.10** (`versionCode` 11); 0.1.9 already shipped in v0.1.11.
- Emulator automation ate a lot of time to flaky helpers: a stale `/sdcard/u.xml` from an earlier run
  (owned by another uid, so `rm` failed and the pull silently returned the *previous screen*), and a
  `$RANDOM` filename that broke a dump helper outright. `adb exec-out cat` with a fixed path, deleted
  on-device first, is the reliable form. A Play Store "Update your app" dialog also silently ate taps
  mid-run. On this box, treat any emulator screenshot as guilty until proven fresh.
