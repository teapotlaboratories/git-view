import type { WriteResult } from "../wire.js";
import { git } from "./gitService.js";
import { confine } from "../util/paths.js";
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

  /** Switch to (or create) a branch. Real working-tree checkout; the fs watcher then pushes repo.changed. */
  async checkout(repoId: string, root: string, ref: string, create: boolean, actor: "app" | "claude"): Promise<WriteResult> {
    assertBranchName(ref);
    await git(root, create ? ["checkout", "-b", ref] : ["checkout", ref]);
    const head = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    await this.audit.record({ actor, repo: repoId, action: "checkout", target: head, ok: true, detail: create ? "created" : undefined });
    return { ok: true, oid: head };
  }

  /**
   * Push to a remote using the HOST's git credentials (network egress). Defaults to `git push` (current
   * branch → its upstream); pass remote/branch/setUpstream to be explicit. Audited. See docs/SECURITY.md.
   */
  async push(repoId: string, root: string, remote: string | undefined, branch: string | undefined,
    setUpstream: boolean, actor: "app" | "claude"): Promise<WriteResult> {
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
