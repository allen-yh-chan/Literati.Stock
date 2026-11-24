import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/user-prompt-gate.mjs"
);

function runPrompt(prompt) {
  const root = mkdtempSync(path.join(os.tmpdir(), "user-prompt-gate-test-"));
  try {
    // A real repository on `main`, not a fake `git` on PATH: Windows starts only `git.exe` for a bare
    // `git`, so a script shim there is never picked.
    const repo = path.join(root, "repo");
    mkdirSync(repo, { recursive: true });
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"],
    ]) {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }

    return spawnSync("node", [HOOK], {
      input: JSON.stringify({ prompt }),
      encoding: "utf8",
      cwd: repo,
      env: {
        ...process.env,
        DEVPRO_RECAP_PENDING_DIR: path.join(root, "pending"),
        DEVPRO_RECAP_STATE_DIR: path.join(root, "state"),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("task notifications with intent words emit no warnings on main", () => {
  const result = runPrompt(
    "  \n<task-notification>PR fix feature release</task-notification>"
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("ordinary bugfix prompts still warn on main", () => {
  const result = runPrompt("修 bug");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Intent=bugfix but on 'main'/);
});

test("system reminders with session-end words emit no warnings", () => {
  const result = runPrompt("<system-reminder>算了</system-reminder>");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
