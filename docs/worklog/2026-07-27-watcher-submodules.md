# Watcher: submodule-aware filtering (rimba diff refreshing every second)

Owner-reported: rimba's diff view refreshes **every second on quartz** while behaving on the dev box.

## Diagnosis — measured, not guessed
- **Idle produces 0 `repo.changed`.** The bridge is not firing on its own; the loop is driven by the
  request itself. Each worktree-diff poll emitted 1–2 events for exactly one path:
  `vendor/esp-idf/.git/index.lock`. Serving the diff makes git take a lock inside the submodule → the
  watcher reports it → the app re-fetches the diff → git takes the lock again.
- **Not the architecture and not the git version.** The dev box only looked healthy because its rimba was
  cloned hours earlier: its diff was 174 bytes against quartz's 34 632, and its submodule indexes were
  fresh. It would drift into the same loop.
- **`isIgnored` only ever matched the TOP-LEVEL `.git`.** It tested `parts[0] === ".git"`, but a
  submodule's git dir is `vendor/esp-idf/.git/…`, where `parts[0]` is `vendor`. So every bit of a
  submodule's internal churn reached the client.

## The second, worse defect this exposed
`git check-ignore` **refuses any path inside a submodule** — `fatal: Pathspec 'vendor/esp-idf/Kconfig' is
in submodule 'vendor/esp-idf'`, exit 128 — and it refuses ordinary files, not just `.git` ones.
`dropIgnored` catches every error and fails open, so **one submodule path anywhere in a batch silently
disabled gitignore filtering for that whole batch**. PR #36's diff-flicker fix therefore never actually
held on rimba, the repo it was written for: ESP-IDF `build/` churn still got through whenever a submodule
path rode along.

## Fix
- **`isIgnored` applies the `.git` rule at any depth** (`parts.indexOf(".git")`), keeping the same
  HEAD/index/refs signals. Cheapest possible layer — chokidar never queues the noise. A submodule moving
  to a new commit still surfaces via its own HEAD/refs and the superproject's `.git/index`.
- **`dropIgnored` partitions the batch by owning repo** and runs `check-ignore` inside each, so a
  submodule path can no longer fail the batch open. This also makes a submodule's *own* `.gitignore`
  apply for the first time — esp-idf's build output could not be filtered even in principle before.
- Submodules are enumerated with `ls-files --stage` (gitlinks are mode 160000), recursively and cached.
  Deliberately **not** `git submodule`, which is not on the read allowlist and would drag its writing
  subcommands in with it. Depth-capped at 4.

## Verification
- Bridge suite **138 pass**. Four new watcher tests; **three of them fail against the pre-fix watcher**
  and all pass after — lock churn stays silent, a submodule's own `.gitignore` is applied, and one
  submodule path no longer lets ignored churn ride along. The fourth (a real submodule edit still fires)
  passes both ways by design: it is the regression guard for the owner's question, "does this mean any
  submodule changes will not be shown?"
- Two of those tests were initially worthless and had to be corrected: the lock test deleted the file
  instantly, so `awaitWriteFinish` (150 ms) swallowed it and the test passed against the broken code; and
  it created directories while the watcher ran, so the *directory* creation was what fired.
