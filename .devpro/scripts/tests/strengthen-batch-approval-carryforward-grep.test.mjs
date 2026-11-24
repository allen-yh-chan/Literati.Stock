import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";
import { readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";



function parseStandardLedger(content, label) {
  const match = content.match(/^covers:\n((?:  - [^\n]+\n)+)excludes:\n((?:  - [^\n]+(?:\n|$))+)/m);
  assert.ok(match, `${label} missing contiguous covers/excludes ledger`);
  const entries = (block) => block.trimEnd().split("\n").map((line) => line.slice(4));
  return { covers: entries(match[1]), excludes: entries(match[2]) };
}

test("Ask First SSOT treats matching batch ledger as already satisfied for covered writes", () => {
  const autonomy = read(".devpro/agent-rules/ai-autonomy.md");
  assert.match(
    autonomy,
    /Matching Batch Approval Ledger = Ask First already satisfied/,
    "ai-autonomy.md missing Ask First ledger-satisfaction anchor",
  );
  assert.match(
    autonomy,
    /MUST NOT[\s\S]{0,120}commit[\s\S]{0,80}push/i,
    "ai-autonomy.md must forbid re-asking covered commit/push",
  );
});

test("devpro:change Step 5 matching batch: delegation plan is FYI + continue, no executor re-ask", () => {
  // The block starts in the moved 委派計畫 section and ends at 第七步 in SKILL.md, so it needs the full reading order.
  const skill = readChangeSkillFullReadingOrder();
  const step5 = skill.match(
    /\*\*Step 5 前置：委派計畫[\s\S]*?(?=\*\*第七步：Matching Ledger Carry-Forward)/,
  );
  assert.ok(step5, "change/SKILL.md missing Step 5 delegation-plan block before Step 7");
  assert.match(
    step5[0],
    /Matching `same-change-dp-change-batch`[\s\S]{0,200}FYI[+＋]當輪續跑/,
    "Step 5 must say matching same-change-dp-change-batch → FYI + continue",
  );
  assert.match(
    step5[0],
    /MUST NOT[\s\S]{0,80}重問 executor/,
    "Step 5 must forbid re-asking executor under matching batch",
  );
  assert.match(
    step5[0],
    /「輸出給使用者看」≠ Ask First pause/,
    "Step 5 must disambiguate show-plan vs Ask First pause",
  );
});

test("standard ledger templates cover worktree and local_commit", () => {
  for (const rel of [
    ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
    ".devpro/agent-rules/proposal-template.md",
  ]) {
    const ledger = parseStandardLedger(read(rel), rel);
    assert.ok(ledger.covers.includes("worktree"), `${rel} covers missing worktree`);
    assert.ok(ledger.covers.includes("local_commit"), `${rel} covers missing local_commit`);
  }
});

test("rationalizations call out re-asking commit/push despite batch approval", () => {
  const body = read(".devpro/agent-rules/ai-autonomy-rationalizations.md");
  assert.match(
    body,
    /batch approval[\s\S]{0,80}(commit|push)/i,
    "rationalizations missing batch+commit/push anti-idle row",
  );
});

test("Cursor adapter feed-forwards ChangeContext and matching-ledger no re-ask", () => {
  const cursor = read(".devpro/agent-rules/platform-adapters/cursor.md");
  assert.match(cursor, /ChangeContext:/, "cursor.md must name ChangeContext:");
  assert.match(
    cursor,
    /local_commit|matching.*ledger|same-change-dp-change-batch/i,
    "cursor.md must name matching ledger / local_commit carry-forward",
  );
});

test("Ready Response names minimal skeleton including ChangeContext before options", () => {
  const gate = read(".devpro/agent-rules/post-pr-completion-gate.md");
  assert.match(
    gate,
    /最小骨架[\s\S]{0,80}ChangeContext:/,
    "post-pr-completion-gate.md missing ChangeContext minimal skeleton",
  );
});

test("openspec-flow locks new carry-forward scenarios", () => {
  const canonical = read("openspec/specs/openspec-flow/spec.md");
  const archiveRoot = repoPath("openspec/changes/archive");
  const archived = readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-strengthen-batch-approval-carryforward"))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  assert.ok(archived, "missing archived strengthen-batch-approval-carryforward folder");
  const delta = read(`openspec/changes/archive/${archived}/specs/openspec-flow/spec.md`);
  for (const body of [canonical, delta]) {
    assert.match(body, /Ledger Covers Worktree And Local Commit/);
    assert.match(body, /Matching Ledger Satisfies Ask First For Covered Writes/);
    assert.match(body, /Host Adapter Feed-Forwards ChangeContext/);
  }
});
