# 2026-08-05 — `release.sh` guessed "release absent" from any failure

The second `release.sh` bug of the evening, and the more dangerous one. Logged in `docs/PLAN.md` since
v0.1.12 and fixed now, immediately after publishing v0.1.15 straight through the affected branch.

## The defect

```bash
if "$GH_BIN" release view "$TAG" >/dev/null 2>&1; then   # edit path
else                                                     # create path
```

The condition asks *"did `gh release view` succeed?"*, but the decision needs *"does the release
exist?"* — and those differ every time the API does. A network blip, an expired token or a rate limit all
exit non-zero, and all used to mean **absent**.

Downstream that is not symmetrical:

- Against a release that **does** exist, a `--clobber` run took the create path and died on "a release
  with the same tag name already exists". Confusing, but safe.
- Against a release that is genuinely **missing**, the same slip creates a release nobody asked for, from
  whatever happens to be sitting in `dist/`. That one is public and awkward to walk back.

Only luck had kept the second case from firing. Tonight's v0.1.15 publish went through this exact branch.

## The fix

Three outcomes, not two, and the unknown is refused rather than guessed:

```bash
if view_err="$("$GH_BIN" release view "$TAG" 2>&1 >/dev/null)"; then
  RELEASE_EXISTS=1
elif printf '%s' "$view_err" | grep -qi "release not found"; then
  RELEASE_EXISTS=0
else
  die "could not tell whether release $TAG already exists, so refusing to publish. gh said: $view_err"
fi
```

The discriminator was **observed, not assumed**. Both a missing release and a broken API exit 1; what
separates them is stderr:

| case | exit | stderr |
| --- | --- | --- |
| release exists | 0 | *(empty)* |
| release missing | 1 | `release not found` |
| API/auth failure | 1 | `none of the git remotes configured…` |

## Verifying

The decision logic was exercised standalone against all three real cases — no release was created,
edited or deleted to test it:

1. `v0.1.15` (exists) → **EXISTS**
2. `v9.9.9-nope` → **ABSENT**
3. `GH_HOST=nonexistent.invalid` → **REFUSE**

And the same third input under the old logic → **ABSENT**, i.e. it would have taken the create path.
That contrast is the whole fix, so it is worth keeping as the regression note: there is no shell test
harness here, and this is the evidence that the change does something.

## Note on `2>&1 >/dev/null`

Order matters and looks backwards: it points stderr at the current stdout (the command substitution,
which is what gets captured) and *then* sends stdout to `/dev/null`. Written `>/dev/null 2>&1` it would
capture nothing, the `grep` would never match, and every missing release would be reported as an
unknown — turning a safe path into a hard failure.
