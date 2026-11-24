/**
 * Locks devpro:change Step 7: matching batch ledger carry-forward must forbid milestone idle-stop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const SKILL = ".devpro/agent-skills/devpro-workflows/change/SKILL.md";

function step7Slice(content) {
  const heading = "**第七步：Matching Ledger Carry-Forward（implementation-complete → ship；禁 milestone idle-stop）**";
  const start = content.indexOf(heading);
  assert.ok(start >= 0, "devpro:change missing Step 7 carry-forward heading");
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? content.slice(start) : content.slice(start, start + heading.length + next);
}

test("devpro:change Step 7 forbids covered-scope re-ask and mandates ship chain", () => {
  const content = readFileSync(repoPath(SKILL), "utf8");
  const slice = step7Slice(content);

  assert.match(slice, /Turn-end Ledger Self-Check/);
  assert.match(slice, /owner=AI/);
  assert.match(slice, /MUST NOT.*commit\+PR.*只 commit/s);
  assert.match(slice, /pre_pr_gate.*`\/devpro:pre-pr`/s);
  assert.match(slice, /only commit when requested/);
  assert.match(slice, /excludes/);
  assert.match(slice, /merge.*release/s);
  assert.match(slice, /cross_repo_write/);
  assert.match(slice, /僅當使用者於 batch scope 明確 opt-in/);
});

test("proposal-mini ledger keeps merge in excludes not covers", () => {
  const proposal = readFileSync(
    repoPath("openspec/changes/archive/2026-09-02-strengthen-dp-change-ledger-carry-forward/proposal-mini.md"),
    "utf8",
  );
  const ledger = proposal.match(/```yaml\n([\s\S]*?)```/)?.[1] ?? "";
  const coversBlock = ledger.match(/covers:\n([\s\S]*?)excludes:/)?.[1] ?? "";
  assert.match(ledger, /excludes:\n(?:  - .+\n)*  - merge/);
  assert.doesNotMatch(coversBlock, /^\s*- merge\s*$/m);
});

test("devpro:change Test Scenarios includes ledger carry-forward row", () => {
  const content = readFileSync(repoPath(SKILL), "utf8");
  assert.match(content, /Ledger-Carry-Forward/);
  assert.match(content, /不.*問.*commit\+PR/);
});
