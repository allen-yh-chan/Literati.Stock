/**
 * hook-harness.test.mjs
 *
 * Integration tests for tests/lib/hook-harness.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { git } from "./git.mjs";
import {
  advisoryText,
  createGateRepoFactory,
  runHook,
} from "./hook-harness.mjs";
import { makeTempDir } from "./tmp.mjs";

test("runHook fail-opens a real hook with a tiny non-matching payload", () => {
  const result = runHook(".devpro/scripts/hooks/commit-soft-nudge.mjs", {
    tool_name: "Read",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("advisoryText prefers hookSpecificOutput.additionalContext", () => {
  assert.equal(
    advisoryText({
      stdout: JSON.stringify({
        systemMessage: "sys",
        hookSpecificOutput: { additionalContext: "ctx" },
      }),
    }),
    "ctx",
  );
  assert.equal(advisoryText({ stdout: "not-json" }), "");
});

test("createGateRepoFactory setupRepo with commit is a usable git checkout", () => {
  const tmpRoot = makeTempDir("devpro-gate-factory-");
  try {
    const { setupRepo } = createGateRepoFactory({
      tmpRoot,
      writeFixture(dir) {
        mkdirSync(path.join(dir, ".devpro", "agent-rules"), { recursive: true });
      },
    });
    const repo = setupRepo("feat/demo", { withCommit: true });
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feat/demo");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
