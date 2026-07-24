# Explorer: create file / folder

Asked: "ada capability to create file" → the backend/agent had it, but no app UI. Owner picked
**folder context menu + header ＋** and **file + folder**.

## Change
- `ExplorerTree` (Components.kt): folders' long-press menu gains **New file… / New folder…** above
  Rename. `onNewFile`/`onNewFolder` callbacks added.
- `ExplorerPane` (Screens.kt): a slim **Explorer** header with a **＋** (New file… / New folder…) that
  creates at the repo ROOT. Shown on a writable ref only; visible even on an empty repo (create the
  first file).
- `NewNodeDialog` prompts for a name (rejects empty / slashes).
- VM (`AppViewModel`): `NewNodeTarget` state, `requestNewFile/Folder`, `createNode`, `reloadDir`.
  A **folder** is `createFile("<path>/.gitkeep", "")` — the bridge's `create` already `mkdir`s parents,
  and git can't track empty dirs. After create, `reloadDir` re-fetches the parent's children and splices
  them in (auto-expanding a collapsed parent); a new **file** is opened in the editor.
- Reuses the existing `POST /v1/repos/{repo}/file` (`BridgeApi.createFile`) — no bridge changes.

## Verified on-device (tablet, tabS8)
- **Header ＋ → New file** at root → `scratch-demo.txt` created, sorted under README.md, opened in the
  editor (`2026-07-24-newfile-root.png`).
- **Folder menu → New folder** in `docs` → `docs/scratch-dir/.gitkeep` on disk (folder created).
- **Folder menu → New file** in a *collapsed* `docs` → tree auto-expands `docs` and shows/open
  `zz-treetest.txt` (`2026-07-24-newfile-in-folder.png`).
- On-disk checks confirmed each write; all test artifacts removed afterward.

Not re-shot on phone/e-ink (same explorer composable; the tablet renders it in the left pane).
