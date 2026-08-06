# 2026-08-05 — `release.sh` reported failure on every successful build

## The symptom

`tools/release.sh --apk-only` printed a complete success report — assembled, signed, cert verified,
`SHA256SUMS` written, `Done (not published)` — and then exited **1**.

It matters more than a cosmetic wrong number. This script is the *only* sanctioned way to build or cut a
release, so its exit status is what any wrapper, CI step or future automation would gate on. A run that
did everything right looked like a failed one, and the natural reaction to a failing release build is to
distrust the artifact.

## The cause

```bash
cleanup() { [ -n "$TMP_KS_DIR" ] && rm -rf "$TMP_KS_DIR"; }
trap cleanup EXIT
```

`TMP_KS_DIR` is only set when `--keystore` synthesizes a temporary `keystore.properties`. On every other
run it is empty, so `[ -n "" ]` is false — and it is the function's **last** command, so `cleanup`
returns 1.

Under `set -e`, a non-zero status from an `EXIT` trap replaces the script's own exit status. The explicit
`exit 0` further down could not prevent it, because the trap runs *after* it.

The fix is `return 0` at the end of `cleanup`.

## The wrong first answer, kept because it was instructive

The first repro was:

```bash
bash -c 'cleanup() { [ -n "" ] && rm -rf /nonexistent; }; trap cleanup EXIT; exit 0'; echo $?
# → 0
```

which says the trap does **not** affect exit status, and would have closed the investigation with "the
trap is innocent, look elsewhere". It was wrong because it omitted `set -euo pipefail`, which the real
script sets on line 19. With it:

```bash
bash -c 'set -euo pipefail; T=""; cleanup() { [ -n "$T" ] && rm -rf /nonexistent; }; trap cleanup EXIT; exit 0'; echo $?
# → 1
```

A minimal repro is only evidence about the real thing if it reproduces the real thing's conditions. This
one differed in a single `set` line and inverted the answer.

## Verifying

Three levels, because the isolated repro is the part most likely to be lying:

1. The one-liner above returns 0 with the fix.
2. The `--keystore` path still deletes its temp dir — the `&&` short-circuit is unchanged, and the
   directory is gone after the shell exits. A "fix" that quietly stopped cleaning up would leave a
   `keystore.properties` containing real passwords behind.
3. `tools/release.sh --apk-only` run end to end, exit status read directly.

## Also written down

`tools/README.md` now states that the exit status is meaningful, because "0 means success" was an
assumption nobody had reason to check until it was false.
