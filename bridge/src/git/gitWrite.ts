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
}
