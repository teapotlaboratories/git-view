# Worklog — Browse host filesystem + open a folder as a workspace

**Date:** 2026-07-21 · **Branch:** `redesign/step1-tokens-theme`

## Goal
Stop being limited to pre-registered `config.yaml` repos. Let a paired client **browse the host
filesystem**, create directories, and **open a folder as a workspace** — initializing git when the
folder isn't a repo yet. All fenced to operator-declared roots and off by default.

## Owner decisions (three forks)
- **Scope = roots-confined.** New `workspaceRoots: string[]` in `config.yaml`; browse / `mkdir` / open are
  allowed **only within** those roots, gated by the **same `confine()`** containment as every other path
  (rejects absolute / `..` / symlink escape). **Empty list ⇒ feature off** (`/v1/fs/*` + `/v1/workspaces/*`
  → `404`; `GET /v1/health` → `features.workspaces = false`).
- **Non-git folder = prompt-to-git-init.** The bridge **never auto-inits.** `POST /v1/workspaces/open` on a
  non-repo folder returns `{ needsInit: true, path }`; git is `init`-ed only when the caller passes
  `initGit: true`, which the app sends **only after the user confirms**.
- **Persist to a bridge state file.** Opened workspaces persist to `.gitview/workspaces.json` (mode `0600`,
  mirroring `tokens.json`); **`config.yaml` is never rewritten.** `GET /v1/repos` now **merges** config
  repos + persisted workspaces, deduped by `id` (config wins on collision).

See [DECISIONS.md](../DECISIONS.md) ADR-030.

## Built
- **Bridge endpoints** (all behind the existing Bearer auth gate — *not* in the pairing/health exemption):
  - `GET /v1/fs/roots` → `{ roots: [{ id, path, label }] }` (`id` = stable filename-safe slug per root).
  - `GET /v1/fs/list?root=&path=` → `{ root, path, parent, entries }`; dirs first, then files, name-sorted;
    `isRepo` flags a dir that's already a git repo; `parent` is `null` at the root.
  - `POST /v1/fs/mkdir { root, path, name }` → `{ path }`; an existing name is `409 conflict`.
  - `POST /v1/workspaces/open { root, path, initGit?, provider?, profile? }` → `{ repo: RepoSummary }` when
    registered (already a repo, or `initGit` ran) **or** `{ needsInit: true, path }` when it's a non-repo
    and `initGit` wasn't set. `RepoSummary` is reused verbatim from `GET /v1/repos`.
  - `GET /v1/health` gains `features: { workspaces }` (true iff `workspaceRoots` is non-empty);
    `GET /v1/repos` merges opened workspaces.
  - Path-escape / bad-root-id / clobber reuse the existing `pathEscape` / `notFound` / `conflict` helpers in
    `bridge/src/util/errors.ts`; browse/mkdir/open all route through the existing `confine()`.
- **App folder browser** — gated on `features.workspaces`: roots → drill into dirs, a **new-folder** action,
  and **open** a folder as a workspace. On `{ needsInit: true }` it shows a confirm prompt; on confirm it
  re-calls open with `initGit: true` and the new workspace lands in the repos list.
- **Docs** — `API.md` (fs/workspaces endpoints + `/v1/health` features + merged `/v1/repos`), `SECURITY.md`
  ("Workspace roots / filesystem browse" section), `DECISIONS.md` (ADR-030), `PLAN.md` entry, this worklog.

## Wire choice worth calling out
`open` returns a **200 with a `needsInit` flag rather than a 409.** A non-repo folder isn't an error — it's
an expected fork the app resolves by prompting — so it stays on the success channel; `409 conflict` is
reserved for genuine clobbers (e.g. `mkdir` onto an existing name).

## Review round (findings fixed before verification)
An adversarial security review of the confinement/open/init code and a separate app-diff correctness
review ran; every real finding was fixed:
- **[medium] Revocation gap** — persisted workspaces were served with the full read/write/push surface
  even after the operator narrowed/emptied `workspaceRoots`. Fixed: `servedWorkspaceIds()` gates the repo
  registry + boot watch-loop, so a workspace is served/watched only while the feature is enabled **and**
  its path is still inside a current root (record kept in `workspaces.json`; re-widening a root restores
  it). Covered by a new e2e revocation test + unit tests.
- **[low] Symlink disclosure** — `fs/list` followed symlinks (via `stat`) to classify them + probe `.git`,
  leaking the type/repo-ness of out-of-root targets. Fixed: no-follow (`lstat`); a symlink shows as a
  non-navigable file.
- **[low, accepted] `features.workspaces` on unauth `/v1/health`** — a reconnaissance-only boolean, no
  paths/data; documented as an accepted disclosure in `SECURITY.md` (keep the bridge network-gated).
- **[app, real] Dead browser "Retry"** when the *roots* fetch failed on first open (`fsRetry` early-returned
  on null `fsRoot`). Fixed to re-fetch roots.
- **[app, minor] Double-fire** on "Open this folder"/"Initialize" — added an `fsOpening` in-flight guard +
  disabled button.

## Verification (done)
- **Bridge:** `npm run typecheck` clean; **60/60 tests pass** (fsBrowse / workspaces / openFlow, incl. the
  new revocation + `servedWorkspaceIds` tests); `npm run build` OK.
- **Live curl smoke** (bridge booted on a scratch config): `features.workspaces` true/false per config;
  unauth → `401`; feature-off → `404` even with a valid token; listing is dirs-first with dotfiles shown,
  `isRepo` on git repos, and the escaping symlink shown as `kind:"file"` (no disclosure); `..` / absolute /
  symlink-escape all `400`; `mkdir` works; open existing-repo → `{repo}`, bare dir → `{needsInit}`, bare
  dir + `initGit` → `{repo}` with `.git` created; `/v1/repos` merges the opened workspaces.
- **On-device** (Android emulator, real paired bridge): the `＋ Open a folder` affordance appears only when
  the bridge advertises the feature; the browser lists the real host root (dirs-first, dotfiles, `repo`
  badges, symlink as a non-navigable file); drilling into a non-git folder and tapping **Open this folder**
  raises the **"Not a git repository — Initialize?"** prompt; confirming ran `git init` on the host, entered
  the new workspace, and persisted it to `.gitview/workspaces.json` (`0600`).
- **App:** `assembleDebug` SUCCESS (twice — before and after the app fixes).
