import type { WriteResult } from "../wire.js";
import { git } from "./gitService.js";
import { confine } from "../util/paths.js";
import { gitError } from "../util/errors.js";
import type { AuditLog } from "../util/audit.js";

/**
 * Working-tree git mutations: stage / commit / discard. Paths are confined before use, `--` always
 * separates options from pathspecs (no option injection), and each action is audited.
 */
export class GitWrite {
  constructor(private readonly audit: AuditLog) {}

  private async confineAll(root: string, paths: string[]): Promise<string[]> {
    await Promise.all(paths.map((p) => confine(root, p, /* mustExist */ false)));
    return paths;
  }

  async stage(repoId: string, root: string, paths: string[], actor: "app" | "claude"): Promise<WriteResult> {
    await this.confineAll(root, paths);
    await git(root, ["add", "--", ...paths]);
    await this.audit.record({ actor, repo: repoId, action: "stage", target: paths.join(", "), ok: true });
    return { ok: true };
  }

  async commit(repoId: string, root: string, message: string, paths: string[] | undefined,
    actor: "app" | "claude"): Promise<WriteResult> {
    if (!message.trim()) throw new Error("commit message is required");
    const args = ["commit", "-m", message];
    if (paths && paths.length) {
      await this.confineAll(root, paths);
      args.push("--", ...paths);
    }
    // Turn git's opaque non-zero exit on an empty commit into a clear message the app can show as-is.
    const staged = await git(root, ["diff", "--cached", "--name-only", ...(paths && paths.length ? ["--", ...paths] : [])]);
    if (!staged.trim()) throw gitError("Nothing to commit — stage some changes first.");
    await git(root, args);
    const oid = (await git(root, ["rev-parse", "HEAD"])).trim();
    await this.audit.record({ actor, repo: repoId, action: "commit", target: oid, ok: true, detail: message });
    return { ok: true, oid };
  }

  async discard(repoId: string, root: string, paths: string[], actor: "app" | "claude"): Promise<WriteResult> {
    await this.confineAll(root, paths);
    // Restore both staged and worktree state for the given paths.
    await git(root, ["restore", "--staged", "--worktree", "--", ...paths]);
    await this.audit.record({ actor, repo: repoId, action: "discard", target: paths.join(", "), ok: true });
    return { ok: true };
  }

  /**
   * `git init` a folder that the user opened as a workspace. Only ever invoked on a path already
   * confined to a configured root (the route checks containment before calling this).
   */
  async initRepo(dir: string): Promise<void> {
    await git(dir, ["init"]);
    await this.audit.record({ actor: "app", repo: dir, action: "repo.init", target: dir, ok: true });
  }

  /** Switch to (or create) a branch. Real working-tree checkout; the fs watcher then pushes repo.changed. */
  async checkout(repoId: string, root: string, ref: string, create: boolean, actor: "app" | "claude"): Promise<WriteResult> {
    assertBranchName(ref);
    try {
      await git(root, create ? ["checkout", "-b", ref] : ["checkout", ref]);
    } catch (e) {
      // A checkout that fails while the tree is dirty is git's "local changes would be overwritten" refusal.
      // Detect it locale-independently (status is non-empty) and surface a clean, stable message the app can
      // show as-is — no fragile matching on git's localized wording.
      const dirty = (await git(root, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;
      if (dirty) throw gitError(`Can't switch to "${ref}" — you have uncommitted changes. Commit or stash them first.`);
      throw e;
    }
    // Report the new HEAD. `symbolic-ref` works on an UNBORN branch (a fresh repo with no commit yet),
    // where `rev-parse --abbrev-ref HEAD` fails ("ambiguous argument 'HEAD'"); fall back to the short oid
    // for a detached-HEAD checkout (which has no symbolic ref), then to the requested ref.
    const head = (await git(root, ["symbolic-ref", "--short", "HEAD"])
      .catch(() => git(root, ["rev-parse", "--short", "HEAD"]))
      .catch(() => ref)).trim();
    await this.audit.record({ actor, repo: repoId, action: "checkout", target: head, ok: true, detail: create ? "created" : undefined });
    return { ok: true, oid: head };
  }

  /**
   * Push to a remote using the HOST's git credentials (network egress). Defaults to `git push` (current
   * branch → its upstream); pass remote/branch/setUpstream to be explicit. Audited. See docs/SECURITY.md.
   */
  async push(repoId: string, root: string, remote: string | undefined, branch: string | undefined,
    setUpstream: boolean, actor: "app" | "claude"): Promise<WriteResult> {
    // Default push (the app's Push button sends no target): if the current branch has no upstream,
    // set it up automatically so a new branch's FIRST push works instead of "no upstream branch".
    if (!remote && !branch && !setUpstream) {
      const upstream = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        .then((s) => s.trim())
        .catch(() => "");
      if (!upstream) {
        remote = "origin";
        // symbolic-ref works on an unborn branch (rev-parse --abbrev-ref HEAD would throw there); fall back
        // for a detached HEAD.
        branch = (await git(root, ["symbolic-ref", "--short", "HEAD"])
          .catch(() => git(root, ["rev-parse", "--abbrev-ref", "HEAD"]))).trim();
        setUpstream = true;
      }
    }
    const args = ["push"];
    if (setUpstream) args.push("--set-upstream");
    if (remote) { assertBranchName(remote); args.push(remote); }
    if (branch) { assertBranchName(branch); args.push(branch); }
    await git(root, args);
    await this.audit.record({ actor, repo: repoId, action: "push", target: `${remote ?? ""} ${branch ?? ""}`.trim() || "default", ok: true });
    return { ok: true };
  }
}

/** Reject option-injection and shell/glob metacharacters in a branch/remote name (matches gitService). */
function assertBranchName(name: string): void {
  if (!name || name.startsWith("-") || /[\s~^:?*[\]\\]/.test(name)) {
    throw new Error(`invalid branch/remote name: ${name}`);
  }
}
