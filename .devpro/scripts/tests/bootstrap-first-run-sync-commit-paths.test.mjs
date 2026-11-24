/**
 * bootstrap-first-run-sync-commit-paths.test.mjs
 *
 * F1 fixture (sticky PR #2650): after temp-consumer --sync, run the README
 * Step 6 git-add recipe shape and assert git add + --check succeed. Also prove
 * `node -e` import of sync-agent-rules.mjs does not throw and writes only the
 * NUL-separated path list to stdout (no main-guard / diagnostic noise).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import {
  createConsumerRepo,
  run,
  setRunUsesFullSubmodSource,
} from "./lib/sync-agent-rules-harness.mjs";
import { listSyncCommitPaths } from "../sync-agent-rules.mjs";
import { resolveNativeExecutableOnPath } from "./lib/resolve-native-executable.mjs";

const README_NODE_E =
  'import("./.devpro/scripts/sync-agent-rules.mjs").then((m) => { const p = m.listSyncCommitPaths(); if (!p.length) { console.error("listSyncCommitPaths returned empty"); process.exit(1); } process.stdout.write(p.join("\\0")); })';

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function recipeBashExecutable() {
  if (process.platform !== "win32") return "bash";
  // git.exe is found under <root>\\cmd from cmd.exe and under <root>\\mingw64\\bin from inside Git Bash,
  // so walk up from it until <dir>\\bin\\bash.exe exists.
  const gitExecutable = resolveNativeExecutableOnPath("git");
  let dir = path.dirname(gitExecutable);
  for (let depth = 0; depth < 4; depth += 1) {
    const bash = path.join(dir, "bin", "bash.exe");
    if (existsSync(bash)) return bash;
    dir = path.dirname(dir);
  }
  assert.fail(`Git for Windows Bash is required for the README recipe; none found above ${gitExecutable}`);
}

test(
  "README Step 6 recipe: temp consumer --sync → pipefail git add → --check exit 0",
  { concurrency: false },
  async () => {
    setRunUsesFullSubmodSource(true);
    const ctx = await createConsumerRepo({ fullSubmod: true });
    try {
      const sync = run(ctx.syncScript, "--sync", { cwd: ctx.tmpDir, timeout: 120_000 });
      assert.equal(sync.exitCode, 0, sync.stderr);

      git(ctx.tmpDir, ["init", "-q"]);
      git(ctx.tmpDir, ["config", "user.email", "t@t.com"]);
      git(ctx.tmpDir, ["config", "user.name", "t"]);
      // First-import Step 5 already has .gitmodules; plain createConsumerRepo does not.
      await fs.writeFile(
        path.join(ctx.tmpDir, ".gitmodules"),
        '[submodule ".devpro-agent-rules"]\n\tpath = .devpro-agent-rules\n\turl = https://example.com/devpro-agent-rules.git\n',
      );

      for (const p of listSyncCommitPaths()) {
        await fs.access(path.join(ctx.tmpDir, p));
      }

      // node -e import: no throw, stdout is exactly NUL-joined managed paths, no stderr
      const importProbe = spawnSync(process.execPath, ["-e", README_NODE_E], {
        cwd: ctx.tmpDir,
        encoding: "buffer",
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
        },
      });
      assert.equal(importProbe.status, 0, importProbe.stderr?.toString());
      assert.equal((importProbe.stderr || Buffer.alloc(0)).length, 0, "node -e must not write stderr");
      const expectedStdout = Buffer.from(listSyncCommitPaths().join("\0"), "utf8");
      assert.ok(expectedStdout.equals(importProbe.stdout), "node -e stdout must be only NUL-joined paths");

      const recipePath = path.join(ctx.tmpDir, "_readme-step6-git-add.sh");
      await fs.writeFile(
        recipePath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `node -e '${README_NODE_E}' | xargs -0 git add --`,
          "",
        ].join("\n"),
      );

      const shell = spawnSync(recipeBashExecutable(), [recipePath], {
        cwd: ctx.tmpDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
        },
      });
      assert.equal(shell.status, 0, shell.stderr || shell.stdout);

      const staged = git(ctx.tmpDir, ["diff", "--cached", "--name-only"])
        .trim()
        .split("\n")
        .filter(Boolean);
      assert.ok(staged.length > 0, "git add must stage at least one managed path");
      assert.ok(
        staged.includes("AGENTS.md") || staged.some((p) => p.startsWith(".devpro/")),
        "staged set must include sync managed outputs",
      );

      const rootScript = path.join(ctx.tmpDir, ".devpro", "scripts", "sync-agent-rules.mjs");
      const check = run(rootScript, "--check", { cwd: ctx.tmpDir, timeout: 120_000 });
      assert.equal(check.exitCode, 0, check.stderr);
    } finally {
      setRunUsesFullSubmodSource(false);
      await fs.rm(ctx.tmpDir, { recursive: true, force: true });
    }
  },
);
