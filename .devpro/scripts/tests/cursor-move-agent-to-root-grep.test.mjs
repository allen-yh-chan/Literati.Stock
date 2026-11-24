/**
 * cursor-move-agent-to-root-grep.test.mjs
 *
 * Prove-it / wording lock for #2204 + strengthen-cursor-worktree-degraded-path:
 * Cursor adapter documents that move_agent_to_root changes checkout;
 * MUST NOT run in parallel with SetActiveBranch; identity assertion before write;
 * degraded path is first-class (binding root ≠ execution root); reopen-window
 * is not the default; forge-false "Task 真在 worktree 執行" must not pass.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";

const adapterPath = ".devpro/agent-rules/platform-adapters/cursor.md";
const namingPath = ".devpro/agent-rules/git-branch-naming-and-anchor.md";
const skillPath = ".devpro/agent-skills/devpro-workflows/change/SKILL.md";
const adapter = readFileSync(sourcePath(adapterPath), "utf8");
const naming = readFileSync(sourcePath(namingPath), "utf8");
const skill = readFileSync(sourcePath(skillPath), "utf8");

const ROOT_ONLY_BAN = /MUST NOT[^\n]*`move_agent_to_root`[^\n]*只換 IDE root/;
const PARALLEL_BAN = /MUST NOT[^\n]*`SetActiveBranch`[^\n]*並行/;
const FORGE_FALSE_BAN = /(?:MUST NOT 宣稱「Task 真在 worktree 執行」|不得宣稱 Task 真在 worktree 執行)/;
const FORGE_FALSE_AFFIRM = /(?:^|[^\u300c不得宣稱 MUST NOT])Task 真在 worktree 執行/;
const REOPEN_AS_DEFAULT = /MAY 預設另開|必要時另開已根於/;

function extractMoveAgentSection(md) {
  const block = md.match(
    /### 5\) Cursor 風險：move_agent_to_root 會改 checkout[\s\S]*?(?=\n### )/,
  );
  assert.ok(block, `${adapterPath}: ### 5) move_agent_to_root 風險段不存在`);
  return block[0];
}

function extractDegradedSection(md) {
  const block = md.match(
    /### 5b\) Cursor degraded worktree path[\s\S]*?(?=\n### )/,
  );
  assert.ok(block, `${adapterPath}: ### 5b) degraded worktree path 段不存在`);
  return block[0];
}

test("cursor.md has move_agent_to_root identity section", () => {
  const section = extractMoveAgentSection(adapter);
  assert.match(section, ROOT_ONLY_BAN);
  assert.match(section, PARALLEL_BAN);
  assert.match(section, /rev-parse --abbrev-ref HEAD/);
  assert.match(section, /git worktree list/);
  assert.match(section, /git switch/);
  assert.match(section, /尚未 push|local-only|未 push/);
  assert.match(section, /之前/);
});

test("move_agent_to_root polarity regexes reject root-only or parallel-ok fixtures", () => {
  const equated =
    "MAY 把 `move_agent_to_root` 當成只換 IDE root；MAY 與 `SetActiveBranch` 並行。";
  assert.match(equated, /move_agent_to_root/);
  assert.match(equated, /SetActiveBranch/);
  assert.doesNotMatch(equated, ROOT_ONLY_BAN);
  assert.doesNotMatch(equated, PARALLEL_BAN);
  const canonical =
    "MUST NOT 把 `move_agent_to_root` 當成只換 IDE root、不改 checkout。MUST NOT 與 `SetActiveBranch` 並行。";
  assert.match(canonical, ROOT_ONLY_BAN);
  assert.match(canonical, PARALLEL_BAN);
});

test("git-branch-naming pointer names move_agent_to_root without duplicating the parallel ban", () => {
  assert.match(naming, /move_agent_to_root/);
  assert.match(naming, /platform-adapters\/cursor\.md/);
  assert.doesNotMatch(naming, PARALLEL_BAN);
});

test("cursor.md degraded path locks binding root, execution root, and non-default reopen", () => {
  const section = extractDegradedSection(adapter);
  assert.match(section, /binding root/);
  assert.match(section, /execution root/);
  assert.match(section, /move_agent_to_root/);
  assert.match(section, /degraded|失敗/);
  assert.match(section, /\.worktree\/<change_id>/);
  assert.match(section, /git -C/);
  assert.match(section, /優選/);
  assert.match(section, /verified changeId|已驗證 changeId/);
  assert.match(section, /MUST NOT[^\n]*(另開|再開)/);
  assert.match(section, /最後手段|last resort|non-default/);
  assert.match(section, FORGE_FALSE_BAN);
});

test("devpro:change skill Cursor branch is degraded-first-class and bans forge-false", () => {
  assert.match(skill, /binding root/);
  assert.match(skill, /execution root/);
  assert.match(skill, FORGE_FALSE_BAN);
  assert.match(skill, /move_agent_to_root/);
  assert.match(skill, /\.worktree\/<change_id>/);
  assert.match(skill, /git -C/);
  // Reopen may remain only as explicit last-resort／non-default — not as the default remedy.
  if (skill.includes("另開已根於")) {
    assert.match(skill, /另開已根於[\s\S]{0,120}(最後手段|non-default|last resort)/);
  }
  assert.doesNotMatch(skill, /必要時另開已根於/);
});

test("forge-false polarity: claiming Task executes in worktree must not pass anchors", () => {
  const forged = "Task 真在 worktree 執行；MAY 預設另開已根於 `.worktree/<change_id>` 的 session。";
  assert.match(forged, /Task 真在 worktree 執行/);
  assert.match(forged, REOPEN_AS_DEFAULT);
  assert.doesNotMatch(forged, FORGE_FALSE_BAN);
  assert.match(adapter, FORGE_FALSE_BAN);
  assert.match(skill, FORGE_FALSE_BAN);
  // Affirmative forge-false (without the ban carrier) must not appear as a free claim.
  const strippedAdapter = adapter.replace(/MUST NOT 宣稱「Task 真在 worktree 執行」/g, "");
  const strippedSkill = skill.replace(/不得宣稱 Task 真在 worktree 執行/g, "");
  assert.doesNotMatch(strippedAdapter, /Task 真在 worktree 執行/);
  assert.doesNotMatch(strippedSkill, /Task 真在 worktree 執行/);
  void FORGE_FALSE_AFFIRM;
});

test("Scenario: Move failure does not default to reopening a window", () => {
  const section = extractDegradedSection(adapter);
  assert.match(section, /一等公民|first-class|degraded/);
  assert.match(section, /MUST NOT[^\n]*(另開|再開)/);
});

test("Scenario: Execution uses absolute worktree path and git -C", () => {
  const section = extractDegradedSection(adapter);
  assert.match(section, /execution root/);
  assert.match(section, /git -C/);
  assert.match(section, /\.worktree\/<change_id>/);
  assert.match(section, /絕對路徑|absolute/);
});

test("Scenario: Verified changeId exact-one binding", () => {
  const section = extractDegradedSection(adapter);
  assert.match(section, /binding root/);
  assert.match(section, /verified changeId|已驗證 changeId/);
  assert.match(section, /exact-one/);
});

test("Scenario: Binding root is not execution root", () => {
  const section = extractDegradedSection(adapter);
  assert.match(section, /binding root ≠ execution root|binding root.*execution root/);
  assert.match(skill, /binding root ≠ execution root/);
});

test("Scenario: Successful move remains preferred not unique", () => {
  const section = extractDegradedSection(adapter);
  assert.match(section, /優選/);
  assert.match(section, /非唯一|not unique|not the sole|非唯一合法/);
  assert.match(skill, /成功＝優選、非唯一|優選、非唯一/);
});

test("Scenario: Cursor Degraded Binding Must Not Forge Worktree Runtime Execution", () => {
  assert.match(adapter, FORGE_FALSE_BAN);
  assert.match(skill, FORGE_FALSE_BAN);
});

test("Scenario: Success preferred not sole lawful path", () => {
  assert.match(extractDegradedSection(adapter), /成功仍為優選/);
  assert.match(extractDegradedSection(adapter), /MUST NOT[^\n]*(另開|再開)/);
});
