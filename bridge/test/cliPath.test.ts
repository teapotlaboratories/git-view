import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ClaudeCliNotFound, resolveClaudeCli } from "../src/claude/cliPath.js";

/** A fake `claude` binary (executable file) in a scratch dir. */
async function fakeCli(dir: string, name = "claude"): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, "#!/bin/sh\nexit 0\n");
  await chmod(p, 0o755);
  return p;
}

let scratch: string;
const savedPath = process.env["PATH"];
const savedEnv = process.env["GITVIEW_CLAUDE_CLI"];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "gitview-cli-"));
});

afterEach(() => {
  // Restore the env this suite deliberately mangles, so tests stay order-independent.
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  if (savedEnv === undefined) delete process.env["GITVIEW_CLAUDE_CLI"];
  else process.env["GITVIEW_CLAUDE_CLI"] = savedEnv;
});

test("configured cliPath wins and is returned verbatim", async () => {
  const cli = await fakeCli(scratch);
  const res = await resolveClaudeCli(cli);
  assert.equal(res.path, cli);
  assert.equal(res.source, "claude.cliPath");
});

test("a configured path that isn't executable is a hard error, not a silent fallback", async () => {
  const notExec = join(scratch, "claude");
  await writeFile(notExec, "not executable");
  await chmod(notExec, 0o644);
  await assert.rejects(() => resolveClaudeCli(notExec), /not an executable file/);
});

test("a relative configured path is rejected", async () => {
  await assert.rejects(() => resolveClaudeCli("./claude"), /must be an absolute path/);
});

test("GITVIEW_CLAUDE_CLI is used when no cliPath is configured", async () => {
  const cli = await fakeCli(scratch);
  process.env["GITVIEW_CLAUDE_CLI"] = cli;
  const res = await resolveClaudeCli();
  assert.equal(res.path, cli);
  assert.equal(res.source, "GITVIEW_CLAUDE_CLI");
});

// `bundled: () => null` simulates a packaged (.deb) install, where the SDK's ~222MB platform
// binary was omitted — the case this whole module exists for.
const packaged = { bundled: () => null, commonDirs: [] as string[] };

test("the SDK's bundled binary wins over a host CLI (exact version match)", async () => {
  const cli = await fakeCli(scratch);
  const res = await resolveClaudeCli(undefined, {
    bundled: () => "/somewhere/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    pathDirs: [scratch],
  });
  assert.equal(res.source, "bundled with the SDK");
  assert.equal(res.path, undefined, "no path → the SDK uses its own binary");
  assert.notEqual(res.path, cli);
});

test("packaged install falls back to `claude` on PATH", async () => {
  const cli = await fakeCli(scratch);
  const res = await resolveClaudeCli(undefined, { ...packaged, pathDirs: [scratch] });
  assert.equal(res.source, "PATH");
  assert.equal(res.path, cli);
});

test("packaged install falls back to a common install dir when PATH has none", async () => {
  const cli = await fakeCli(scratch);
  const res = await resolveClaudeCli(undefined, {
    bundled: () => null,
    pathDirs: [],
    commonDirs: [scratch],
  });
  assert.equal(res.source, scratch);
  assert.equal(res.path, cli);
});

test("throws an actionable ClaudeCliNotFound when nothing is installed", async () => {
  await assert.rejects(
    () => resolveClaudeCli(undefined, { ...packaged, pathDirs: [] }),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeCliNotFound);
      assert.match((err as Error).message, /Install Claude Code/);
      assert.match((err as Error).message, /cliPath|GITVIEW_CLAUDE_CLI/);
      return true;
    },
  );
});
