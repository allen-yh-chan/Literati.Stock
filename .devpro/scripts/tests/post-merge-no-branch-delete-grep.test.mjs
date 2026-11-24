/**
 * post-merge-no-branch-delete-grep.test.mjs
 *
 * Locks `Post-merge sync ≠ 可刪分支（強制 guard）` rule in `git-workflow-tracking.md`:
 * after post-merge local sync, TL must NOT delete branches/worktrees without
 * explicit user consent and waiting until after production release.
 *
 * Companion to post-merge-local-sync-grep.test.mjs.
 *
 * REQUIRED locks: guard heading (≥2 occurrences) + dangerous commands + cleanup deferral
 * + SSOT pointer + structural position + regression guard.
 *
 * MAINTENANCE NOTE: This guard section is a near-location *reminder* that points to
 * git-branch-hygiene.md as the SSOT for the actual 判定 (timing / consent / exemption).
 * The literal command tokens locked below (git push origin --delete, git branch -d/-D,
 * gh pr merge --delete-branch, git worktree remove) are the guard's *coverage list*, not
 * a copy of hygiene's 判定 wording. If git-branch-hygiene.md updates its SSOT 判定 wording,
 * do NOT treat these literal locks as the authority — update the guard section to stay a
 * faithful pointer, then update this test to match. The guard must never become a reverse
 * lock that resists the hygiene SSOT's legitimate evolution.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
const rulePath = repoPath(".devpro/agent-rules/git-workflow-tracking.md");
const ruleBody = readFileSync(rulePath, "utf8");
const prRulePath = repoPath(".devpro/agent-rules/git-pr-template-and-merge.md");
const prRuleBody = readFileSync(prRulePath, "utf8");

const guardMarker = "Post-merge sync ≠ 可刪分支（強制 guard）";
const whyAnchor = "**Why**：避免 stale ref";
const guardIdx = ruleBody.indexOf(guardMarker);
const whyIdx = ruleBody.indexOf(whyAnchor);
const guardBody =
  guardIdx !== -1 && whyIdx !== -1 && guardIdx < whyIdx
    ? ruleBody.slice(guardIdx, whyIdx)
    : "";
const linkedWorktreeMarker = "#### Linked Worktree Merge Cleanup Note";
const exceptionsMarker = "#### Exceptions";
const linkedWorktreeIdx = prRuleBody.indexOf(linkedWorktreeMarker);
const exceptionsIdx = prRuleBody.indexOf(exceptionsMarker);
const linkedWorktreeBody =
  linkedWorktreeIdx !== -1 && exceptionsIdx !== -1 && linkedWorktreeIdx < exceptionsIdx
    ? prRuleBody.slice(linkedWorktreeIdx, exceptionsIdx)
    : "";

// 1. Guard heading appears ≥ 2 times (guard section heading + rationalization row each have 1)
test("git-workflow-tracking.md guard heading 'Post-merge sync ≠ 可刪分支' appears ≥ 2 times", () => {
  const needle = "Post-merge sync ≠ 可刪分支";
  let count = 0;
  let start = 0;
  while (true) {
    const idx = ruleBody.indexOf(needle, start);
    if (idx === -1) break;
    count++;
    start = idx + 1;
  }
  assert.ok(
    count >= 2,
    `expected "${needle}" to appear ≥ 2 times, found ${count}`
  );
});

// 2. git push origin --delete mentioned
test("git-workflow-tracking.md mentions 'git push origin --delete'", () => {
  assert.ok(
    ruleBody.includes("git push origin --delete"),
    `expected git-workflow-tracking.md to contain "git push origin --delete" (branch delete guard)`
  );
});

// 3. gh pr merge --delete-branch mentioned
test("git-workflow-tracking.md mentions 'gh pr merge --delete-branch'", () => {
  assert.ok(
    ruleBody.includes("gh pr merge --delete-branch"),
    `expected git-workflow-tracking.md to contain "gh pr merge --delete-branch" (auto delete-branch guard)`
  );
});

// 4. git worktree remove mentioned
test("git-workflow-tracking.md mentions 'git worktree remove'", () => {
  assert.ok(
    ruleBody.includes("git worktree remove"),
    `expected git-workflow-tracking.md to contain "git worktree remove" (worktree cleanup guard)`
  );
});

// 5. git branch -d mentioned
test("git-workflow-tracking.md mentions 'git branch -d'", () => {
  assert.ok(
    ruleBody.includes("git branch -d"),
    `expected git-workflow-tracking.md to contain "git branch -d" (local branch delete guard)`
  );
});

// 6. git branch -D (force variant) mentioned — distinct from -d so deleting `-D` is caught
test("git-workflow-tracking.md mentions 'git branch -D' (force delete variant)", () => {
  assert.ok(
    ruleBody.includes("git branch -d`/`-D") || ruleBody.includes("git branch -D"),
    `expected git-workflow-tracking.md to cover force-delete variant "git branch -D"`
  );
});

// 6c. Behavioral substance: merge into main ≠ shipped to PROD (the core mental-model correction)
test("git-workflow-tracking.md states merge into main ≠ shipped to PROD", () => {
  assert.ok(
    ruleBody.includes("尚未上 PROD"),
    `expected git-workflow-tracking.md to contain "尚未上 PROD" (merge ≠ production guard substance)`
  );
});

// 6d. Lifecycle wording: cleanup is explicitly deferred until production release.
test("git-workflow-tracking.md guard states cleanup deferred until production", () => {
  assert.ok(
    guardBody.includes("cleanup deferred until production"),
    `expected git-workflow-tracking.md to contain "cleanup deferred until production" (post-merge cleanup timing lock)`
  );
});

test("git-workflow-tracking.md guard forbids cleanup as next-step option after main merge", () => {
  for (const phrase of ["NextAction", "AskFirstPending", "選項 1", "只能列為狀態註記"]) {
    assert.ok(
      guardBody.includes(phrase),
      `expected post-merge cleanup guard to contain "${phrase}"`
    );
  }
});

test("git-pr-template-and-merge.md linked worktree note defers cleanup until production", () => {
  for (const phrase of [
    "PR merge to main",
    "workflow watch + local sync/status",
    "cleanup deferred until production",
    "Release Step 6",
    "PROD merge/tag pushed",
    "git-branch-hygiene.md",
  ]) {
    assert.ok(
      linkedWorktreeBody.includes(phrase),
      `expected linked worktree cleanup note to contain "${phrase}"`
    );
  }
});

test("git-pr-template-and-merge.md does not route post-main-merge cleanup by consent", () => {
  for (const stalePhrase of [
    "之後**取得使用者明示同意，再走 canonical cleanup flow",
    "之後取得使用者明示同意，再走 canonical cleanup flow",
    "cleanup 取得明示同意後走",
  ]) {
    assert.equal(
      prRuleBody.includes(stalePhrase),
      false,
      `stale cleanup timing phrase must stay removed: ${stalePhrase}`
    );
  }
  assert.ok(
    prRuleBody.includes("PR merge to main / post-merge local sync 都不是清 branch/worktree 的時機"),
    "expected rationalization table to state PR merge/post-merge sync is not cleanup timing"
  );
});

// 7. SSOT points to git-branch-hygiene.md as authority, and guard honestly declares it does NOT copy 判定 原文.
//    NOTE: locks the *pointer relationship*, not hygiene's 判定 wording (see MAINTENANCE NOTE above).
test("git-workflow-tracking.md SSOT points to git-branch-hygiene.md and declares non-duplication", () => {
  assert.ok(
    ruleBody.includes("git-branch-hygiene.md"),
    `expected git-workflow-tracking.md to reference "git-branch-hygiene.md" as SSOT`
  );
  assert.ok(
    ruleBody.includes("以 `git-branch-hygiene.md` 為準"),
    `expected guard to declare hygiene wins on conflict ("以 git-branch-hygiene.md 為準")`
  );
  assert.ok(
    ruleBody.includes("不在此複寫判定原文"),
    `expected guard to declare it does not copy SSOT 判定 原文 ("不在此複寫判定原文")`
  );
});

// 8. Structural position: guard section appears after sync section tail marker and before Why anchor
test("git-workflow-tracking.md guard section is positioned after sync tail and before Why anchor", () => {
  const syncTailMarker = "完成後**保持在 `main`**";
  const syncTailIdx = ruleBody.indexOf(syncTailMarker);

  assert.ok(syncTailIdx !== -1, `sync tail marker "${syncTailMarker}" not found`);
  assert.ok(guardIdx !== -1, `guard marker "${guardMarker}" not found`);
  assert.ok(whyIdx !== -1, `Why anchor "${whyAnchor}" not found`);

  assert.ok(
    syncTailIdx < guardIdx,
    `guard section (pos=${guardIdx}) must appear after sync tail (pos=${syncTailIdx})`
  );
  assert.ok(
    guardIdx < whyIdx,
    `guard section (pos=${guardIdx}) must appear before Why anchor (pos=${whyIdx})`
  );
});

// 9a. Regression guard: §Post-merge Local Sync heading still present
test("git-workflow-tracking.md regression: '### Post-merge Local Sync' heading still present", () => {
  assert.ok(
    ruleBody.includes("### Post-merge Local Sync"),
    `regression: "### Post-merge Local Sync" heading missing from git-workflow-tracking.md`
  );
});

// 9b. Regression guard: Exit Criteria 3rd item keyword still present
test("git-workflow-tracking.md regression: Exit Criteria 'Post-merge Local Sync 序列' keyword still present", () => {
  assert.ok(
    ruleBody.includes("Post-merge Local Sync 序列"),
    `regression: Exit Criteria must still contain "Post-merge Local Sync 序列"`
  );
});
