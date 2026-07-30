# 2026-07-30 — the watcher was eating the machine's entire inotify budget

Found sideways. Seven `repoWatcher` tests started failing with `got []`, which looked like flakiness and
was not: `chokidar.watch()` was throwing **`ENOSPC: System limit for number of file watchers reached`**
before it could observe anything. The holder was the bridge itself — **119,573 of the system's 119,664
watches**.

## The first diagnosis was wrong

I filed it as a lifecycle leak on the grounds that the bridge held 3.2 watches per *directory*. Wrong
denominator. Chokidar 4 watches every **path**, files included, and `watch()` was already idempotent per
repo id with `unwatch()` releasing correctly. Nothing leaked; the scope was simply enormous:

```
files + dirs in the four watched repos   180,210
watches held                             119,573   (capped by the kernel, not by choice)
directories alone                         25,014
```

It had walked 180k paths and stopped only because the kernel refused more. One ESP32 workspace
(`pico-e32`, 21 GB, 144,595 paths) exhausts the budget on its own.

**Blast radius is the machine, not the bridge.** Once the budget is gone, *any* program wanting a watcher
fails — editors, build tools, the test suite. And the bridge's own notifications then degrade **silently**:
it keeps serving HTTP and simply stops reporting changes.

## What the measurements actually said

A directory watch already reports create/modify/delete for files inside it, so per-file watches buy
nothing. Verified directly — one `fs.watch` on a directory of 500 files caught a modify, a create and a
delete, using **1 watch**.

| approach | watches for 21 dirs / 2,000 files |
| --- | --- |
| chokidar 4 (what we had) | 2,021 — one per path |
| `fs.watch(recursive: true)` (Node's own) | 2,021 — no better |
| **@parcel/watcher** | **21 — one per directory** |

`@parcel/watcher` is what VS Code uses, for this reason. On the four real repos: **25,014 watches, and
8,458 once ignored directories are pruned** — down from 119,573.

Node's recursive option is worth calling out as a dead end: it *works* on Linux, it is simply implemented
the same way, so it solves nothing.

## Ignore list: ask git, do not guess

Rather than hardcoding `build/`, `.pio/`, `target/`…, the watcher asks the repo:

```
git ls-files --others --ignored --exclude-standard --directory
```

On the ESP32 repo that is 28 entries pruning **103,850 of 144,595 paths**, and it found `build/`,
`managed_components/` and `assets/roms/` without being told. It is also exactly what `dropIgnored`
discards at flush time, so nothing that could have been reported is lost.

Two documented limits, both preferred to guessing: it is a snapshot taken at watch time (a build dir
created later stays watched until the repo is re-watched — costs watches, not correctness), and
`git ls-files` does not descend into submodules, the same blind spot that made `git check-ignore` refuse
submodule paths earlier this cycle.

## Three things this broke on the way through

- **`record()` never filtered events.** Chokidar's `ignored` callback had been doing double duty as both
  watch-pruner and event-filter. Parcel takes glob ignores, which cannot express "descend into `.git` but
  keep only HEAD, index and refs/**", so the filter had to move into `record()`. Two existing tests caught
  this immediately — the fine-grained `.git` rule is exactly what they cover.
- **The `.deb` would have shipped a watcher that throws on require.** `npm install --omit=optional` is
  there deliberately (it drops ~222 MB of Agent SDK binaries), but `@parcel/watcher` ships its native
  binding *as* an optional dependency. The package installed cleanly and failed at runtime: *"No prebuild
  or local build of @parcel/watcher found"*.
- **The first fix for that bloated the package 3.6 MB → 115 MB**, because a second `npm install`
  re-resolved the whole tree and dragged the omitted binaries back. Caught by looking inside the artifact
  instead of trusting the build.

## Per-arch packaging

The package can no longer be `Architecture: all`. `npm install` refuses a foreign-platform package
(`EBADPLATFORM`, and `--cpu`/`--os` do not override it), so the binding is fetched with **`npm pack`**,
which performs no validation — the extracted `watcher.node` is a genuine aarch64 ELF built on this x86
box. `release.sh` now builds `amd64` and `arm64` and **verifies each package carries the binding matching
its declared architecture**, because a mismatch installs fine and only fails at runtime.

One trap while writing that guard: `dpkg-deb -c "$d" | grep -q …` reports failure under `set -o pipefail`
— grep exits at the first match, dpkg-deb takes SIGPIPE. The guard failed on a perfectly good package.
`grep -c` reads to the end, so its status means what it looks like.

## Verified

- Suite **176 pass**; chokidar removed entirely.
- argonite: **8,458 watches** (was 119,573), package 3.9 MB, `Architecture: amd64`.
- quartz (`aarch64`): the cross-built arm64 package installs, service healthy, binding loads natively,
  **14,007 watches** for a repo of 237,713 paths — which alone would have wanted *twice* the kernel limit
  under the old watcher.

## One more fix the verification itself produced

Measuring quartz 12 seconds after install showed **0 watches**, and I could not tell whether the watcher
had failed or was still walking (that repo takes ~2 minutes). It was still walking — but the ambiguity was
real, because `subscribe()` swallowed errors with no output at all. It now logs the repo and the reason.
Availability is still the priority (one bad path must not kill the bridge), but silence is not.
