import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



test("code-review checklist routes evidence claims to PR evidence verification leaf", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");

  assert.match(checklist, /Load-chain/);
  assert.match(checklist, /Evidence claim/);
  assert.match(checklist, /pr-review-evidence-verification\.md/);
});

test("active adapter load-chain aligns read-only scope with action-specific leaves", () => {
  const contract = read(".devpro/agent-rules/platform-adapter-contract.md");
  const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
  const tokenFrugal = read(".devpro/agent-rules/token-frugal-io.md");

  assert.match(contract, /唯讀 rg／cat 檢索只載 shared contract 與 active adapter/);
  assert.match(contract, /唯讀發現若轉成寫入、測試、git\/gh、reviewer 或 workflow/);
  assert.match(codex, /### Action-based Load Chain/);
  assert.match(codex, /缺 leaf／未證 gate visibility 即 STOP/);
  assert.match(tokenFrugal, /read-only inspection 停在 active adapter/);
  for (const leaf of [
    "codex-github-writes.md",
    "codex-cli-tooling.md",
    "codex-workflow-capabilities.md",
    "codex-host-cross-review.md",
    "codex-effort-tiers.md",
  ]) {
    assert.ok(codex.includes(leaf), `active Codex Load-chain must retain ${leaf}`);
  }
  assert.ok(codex.includes("post-pr-completion-gate.md"));
});
