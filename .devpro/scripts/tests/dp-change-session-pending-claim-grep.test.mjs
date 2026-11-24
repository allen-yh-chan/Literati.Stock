import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



function literalRe(s) {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("/devpro:change command requires session-pending claim before worktree creation", () => {
  const command = read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");
  const precheckIndex = command.indexOf("Session-pending Source Claim Precheck");
  const worktreeIndex = command.indexOf("git worktree add");

  assert.notEqual(precheckIndex, -1, "claim precheck section must exist");
  assert.notEqual(worktreeIndex, -1, "worktree creation section must exist");
  assert.ok(precheckIndex < worktreeIndex, "claim precheck must appear before worktree creation");

  for (const phrase of [
    "notes/session-pending.md",
    "session-pending-claim.mjs list",
    "session-pending-claim.mjs claim --item <N> --change <change-name>",
    "claim 成功才可繼續",
    "禁止直接 `git worktree add`",
    "<main-checkout-root>/notes/session-pending.md",
  ]) {
    assert.match(command, literalRe(phrase));
  }
});

test("openspec step leaf has conditional Step 2d gate before Step 3", () => {
  const step = read(".devpro/agent-rules/openspec-step-1-to-9.md");
  const step2dIndex = step.indexOf("Step 2d session-pending source claim gate");
  const step3Index = step.indexOf("### Step 3 選前綴");

  assert.notEqual(step2dIndex, -1, "Step 2d claim gate must exist");
  assert.notEqual(step3Index, -1, "Step 3 heading must exist");
  assert.ok(step2dIndex < step3Index, "claim gate must precede branch/worktree step");
  assert.match(step, /claim --item <N> --change <change-name>/);
  assert.match(step, /禁止建 branch\/worktree/);
});

test("session-pending lifecycle documents helper as standard claim carrier", () => {
  const leaf = read(".devpro/agent-rules/session-pending-lifecycle.md");
  for (const phrase of [
    "標準載體",
    "session-pending-claim.mjs claim --item <N> --change <change-name>",
    "session-pending-claim.lock",
    "atomic rename",
    "worktree-local ghost file",
    "prefix-aware lookup",
    'git branch --list "*/<change-name>"',
  ]) {
    assert.match(leaf, literalRe(phrase));
  }
});

test("Codex devpro:workflows skill mirrors pending-source claim precheck", () => {
  const skill = read(".devpro/agent-skills/devpro-workflows/workflows/SKILL.md");
  assert.match(skill, /\/devpro:change` requests sourced from `notes\/session-pending\.md`/);
  assert.match(skill, /session-pending-claim\.mjs claim --item <N> --change <change-name>/);
  assert.match(skill, /before branch\/worktree creation/);
});
