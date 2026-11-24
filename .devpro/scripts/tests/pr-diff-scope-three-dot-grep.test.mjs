/**
 * pr-diff-scope-three-dot-grep.test.mjs
 *
 * Locks issue #1245: PR file-scope observation must use three-dot diff
 * (`<target-base-ref>...HEAD`) or equivalent merge-base-to-HEAD semantics.
 * Two-dot base..HEAD is still valid for commit ownership logs, but not for
 * changed-file scope, path filters, reviewer/exemption scope, or archive-gate
 * relevant-file detection when the base branch has advanced.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



test("PR scope docs name three-dot diff and distinguish commit ownership", () => {
  const prePr = read(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");
  const workflow = read(".devpro/agent-rules/git-workflow-tracking.md");
  const review = read(".devpro/agent-rules/code-review-checklist.md");
  const fallback = read(".devpro/agent-rules/code-review-checklist-fallback.md");
  const delegation = read(".devpro/agent-rules/model-delegation-token-efficiency.md");
  const archiveSpec = read("openspec/specs/archive-tooling/spec.md");
  const tokenBudgetSpec = read("openspec/specs/token-budget-tooling/spec.md");

  // CI tracking reads the files of the tracked event's commits in the tracked repository, never the current checkout or
  // the PR's live diff, which a later push changes (#3704 r6 F5, #3707 r1 F2).
  // A push compares its two commits (a force push back to an older commit still shows the removed file); a pull request
  // compares from its merge base.
  assert.match(workflow, /git -C <checkout> diff <before commit SHA> <after commit SHA> --name-only/, "a push event diffs its before and after commits");
  assert.match(workflow, /git -C <checkout> diff <base commit SHA>\.\.\.<head commit SHA> --name-only/, "a pull request event diffs from its merge base");
  assert.doesNotMatch(workflow, /repos\/OWNER\/REPO\/compare\//, "the compare API lists at most 300 files and is not the file list");
  assert.doesNotMatch(workflow, /gh pr diff <N> --name-only/, "a PR's live diff is not the tracked event's file list");
  for (const [name, body] of [
    ["pre-pr", prePr],
    ["review", review],
    ["fallback", fallback],
    ["delegation", delegation],
  ]) {
    assert.match(
      body,
      /git diff <target-base-ref>\.\.\.HEAD/,
      `${name} must use three-dot target-base PR file scope`
    );
  }

  assert.match(prePr, /commit ownership/, "pre-pr must distinguish commit ownership from PR file scope");
  assert.match(archiveSpec, /origin\/main\.\.\.HEAD/, "archive-tooling spec must use three-dot origin/main PR file scope");
  assert.match(tokenBudgetSpec, /origin\/main\.\.\.HEAD/, "token-budget spec must use three-dot origin/main PR file scope");
  assert.doesNotMatch(prePr, /git diff \$BASE\.\.HEAD/, "pre-pr file-scope checks must not use a two-dot merge-base-to-HEAD diff");
  assert.doesNotMatch(prePr, /git diff <anchor-sha>\.\.HEAD/, "reviewer prompt must not use anchor two-dot diff for PR file scope");
});

test("No-trigger SOP requires evidence tied to the event before reporting CI N/A", () => {
  const workflow = read(".devpro/agent-rules/git-workflow-tracking.md");
  const sopSections = workflow.split("   **No-trigger 判定 SOP**");
  assert.equal(sopSections.length, 2, "the rule must have one No-trigger SOP");
  const sop = sopSections[1].split("\n2. ", 1)[0];
  const playbook = read(".devpro/agent-rules/consumer-failure-playbook.md");

  assert.match(sop, /新分支 push[^\n]*最深 commit[^\n]*祖先的父 commit[^\n]*兩點 diff/);
  assert.match(sop, /tag push[^\n]*不套用路徑篩選/);
  assert.match(sop, /缺目標 repo 的 checkout[^\n]*缺 merge base[^\n]*diff 結束碼非 0[^\n]*回報 `CI: 未定`/);
  assert.match(sop, /diff 成功且完整清單沒有改檔[^\n]*路徑篩選略過/);
  assert.match(sop, /push 超過 1,000 個 commit[^\n]*略過路徑篩選並追蹤 workflow/);
  assert.match(sop, /GitHub 產生 diff 逾時[^\n]*略過路徑篩選並追蹤 workflow/);
  assert.match(sop, /前 3,000 個檔案[^\n]*無法確認 GitHub 使用的清單[^\n]*回報 `CI: 未定`/);
  assert.match(sop, /即使 run 清單為空，也先核對 PR 的 required check/);
  assert.match(sop, /required check[^\n]*`Pending`[^\n]*不得視為通過/);
  assert.match(sop, /PR 沒有待通過的 required check，才能回報 `CI: N\/A`/);
  assert.match(playbook, /^\| No CI \/ no checks \|[^\n]*No-trigger SOP[^\n]*report CI as undetermined/m);
});

test("archive-gate PR-scope probes use origin/main...HEAD", () => {
  const gate = read(".devpro/scripts/pre-pr-archive-gate.mjs");
  assert.match(gate, /origin\/main\.\.\.HEAD/, "archive gate must contain three-dot origin/main...HEAD probes");
  assert.doesNotMatch(gate, /origin\/main\.\.HEAD/, "archive gate must not use two-dot origin/main-to-HEAD probes");
});
