/**
 * pre-pr-before-create-grep.test.mjs
 *
 * Locks the `### 建 PR 前先過 /devpro:pre-pr`（advisory）section in
 * `git-branch-and-pr-flow.md` (the PR-flow hub):
 * - The advisory must exist, declare six-axis as mandatory gate, and
 *   honestly acknowledge there is no create-time hard gate.
 * - The Common Rationalizations table must contain the matching row.
 * - The advisory must be structurally positioned inside §Process, before §分支前綴.
 *
 * MAINTENANCE NOTE: This test locks the *hub advisory's* existence and structural
 * position. The advisory points to `/devpro:pre-pr` command as SSOT for the actual
 * pre-PR step sequence; it does NOT copy the command step details here. If
 * git-branch-and-pr-flow.md is refactored (heading text changes, section is
 * moved, or advisory wording is updated), update this test to match the new
 * literals. The test must never become a reverse lock that resists legitimate
 * hub evolution — it guards presence and position, not exact prose.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
const rulePath = repoPath(".devpro/agent-rules/git-branch-and-pr-flow.md");
const ruleBody = readFileSync(rulePath, "utf8");

// 1. Advisory heading exists: contains '建 PR 前先過' and '/devpro:pre-pr'
test("git-branch-and-pr-flow.md advisory heading '建 PR 前先過 /devpro:pre-pr' exists", () => {
  assert.ok(
    ruleBody.includes("建 PR 前先過"),
    `expected git-branch-and-pr-flow.md to contain advisory heading text "建 PR 前先過"`
  );
  assert.ok(
    ruleBody.includes("/devpro:pre-pr"),
    `expected git-branch-and-pr-flow.md to contain "/devpro:pre-pr" in advisory heading`
  );
});

// 2. Advisory mentions 'gh pr create' and '/devpro:pre-pr' as prerequisite (both appear in advisory body)
test("git-branch-and-pr-flow.md advisory mentions 'gh pr create' with '/devpro:pre-pr' as pre-requisite", () => {
  assert.ok(
    ruleBody.includes("gh pr create"),
    `expected git-branch-and-pr-flow.md to contain "gh pr create" in advisory`
  );
  // Advisory must frame /devpro:pre-pr as something to run before gh pr create
  assert.ok(
    ruleBody.includes("裸 `gh pr create` **不是** PR 流程的起點"),
    `expected advisory to state 裸 gh pr create is not the starting point ("裸 \`gh pr create\` **不是** PR 流程的起點")`
  );
});

// 3. Advisory states 六軸 is pre-PR mandatory gate
//    Scoped to the advisory section only (between advisory heading and ### 分支前綴),
//    so a rationalization-row occurrence cannot rescue a missing advisory statement.
test("git-branch-and-pr-flow.md advisory states '六軸是 pre-PR mandatory gate'", () => {
  const advisoryMarker = "### 建 PR 前先過";
  const branchPrefixMarker = "### 分支前綴";

  const advisoryIdx = ruleBody.indexOf(advisoryMarker);
  const branchPrefixIdx = ruleBody.indexOf(branchPrefixMarker);

  assert.ok(advisoryIdx !== -1, `advisory heading "### 建 PR 前先過" not found`);
  assert.ok(branchPrefixIdx !== -1, `"### 分支前綴" heading not found`);

  const advisorySection = ruleBody.slice(advisoryIdx, branchPrefixIdx);
  assert.ok(
    advisorySection.includes("六軸是 pre-PR mandatory gate"),
    `expected advisory section (between "### 建 PR 前先過" and "### 分支前綴") to contain "六軸是 pre-PR mandatory gate" (six-axis as mandatory gate)`
  );
});

// 4. Honest note: advisory declares no create-time hard gate / 兜底在 gh pr merge
test("git-branch-and-pr-flow.md advisory contains honest 'no create-time hard gate' note with checkCrossModelMergeGate reference", () => {
  assert.ok(
    ruleBody.includes("create-time hard gate") || ruleBody.includes("無 create-time hard gate"),
    `expected advisory to contain honest note about "create-time hard gate" absence`
  );
  assert.ok(
    ruleBody.includes("checkCrossModelMergeGate"),
    `expected advisory to reference "checkCrossModelMergeGate" as merge-time fallback`
  );
});

// 5. Common Rationalizations row: '碼/檔改好了，直接' + 'gh pr create' + '比較快'
test("git-branch-and-pr-flow.md Common Rationalizations contains '碼/檔改好了，直接...gh pr create...比較快' row", () => {
  assert.ok(
    ruleBody.includes("碼/檔改好了，直接"),
    `expected Common Rationalizations to contain "碼/檔改好了，直接" rationalization row`
  );
  // The row mentions gh pr create and 比較快
  const rowIdx = ruleBody.indexOf("碼/檔改好了，直接");
  const rowSnippet = ruleBody.slice(rowIdx, rowIdx + 200);
  assert.ok(
    rowSnippet.includes("gh pr create") && rowSnippet.includes("比較快"),
    `expected the rationalization row starting with "碼/檔改好了，直接" to contain "gh pr create" and "比較快" within 200 chars`
  );
});

// 6. Structural position: advisory heading appears after '## Process' and before '### 分支前綴'
test("git-branch-and-pr-flow.md advisory heading is positioned after '## Process' and before '### 分支前綴'", () => {
  const processMarker = "## Process";
  const advisoryMarker = "### 建 PR 前先過";
  const branchPrefixMarker = "### 分支前綴";

  const processIdx = ruleBody.indexOf(processMarker);
  const advisoryIdx = ruleBody.indexOf(advisoryMarker);
  const branchPrefixIdx = ruleBody.indexOf(branchPrefixMarker);

  assert.ok(processIdx !== -1, `"## Process" section not found`);
  assert.ok(advisoryIdx !== -1, `advisory heading "### 建 PR 前先過" not found`);
  assert.ok(branchPrefixIdx !== -1, `"### 分支前綴" heading not found`);

  assert.ok(
    processIdx < advisoryIdx,
    `advisory (pos=${advisoryIdx}) must appear after "## Process" (pos=${processIdx})`
  );
  assert.ok(
    advisoryIdx < branchPrefixIdx,
    `advisory (pos=${advisoryIdx}) must appear before "### 分支前綴" (pos=${branchPrefixIdx})`
  );
});

// 7a. Regression guard: '## Routing Index' still present
test("git-branch-and-pr-flow.md regression: '## Routing Index' still present", () => {
  assert.ok(
    ruleBody.includes("## Routing Index"),
    `regression: "## Routing Index" heading missing from git-branch-and-pr-flow.md`
  );
});

// 7b. Regression guard: '### 分支前綴' still present
test("git-branch-and-pr-flow.md regression: '### 分支前綴' heading still present", () => {
  assert.ok(
    ruleBody.includes("### 分支前綴"),
    `regression: "### 分支前綴" heading missing from git-branch-and-pr-flow.md`
  );
});

// 7c. Regression guard: existing rationalization row '從 main 建分支比較快' still present
test("git-branch-and-pr-flow.md regression: existing rationalization '從 main 建分支比較快' still present", () => {
  assert.ok(
    ruleBody.includes("從 main 建分支比較快"),
    `regression: existing rationalization "從 main 建分支比較快" must not be removed`
  );
});

function advisorySection() {
  const advisoryMarker = "### 建 PR 前先過";
  const branchPrefixMarker = "### 分支前綴";
  const advisoryIdx = ruleBody.indexOf(advisoryMarker);
  const branchPrefixIdx = ruleBody.indexOf(branchPrefixMarker);
  assert.ok(advisoryIdx !== -1, `advisory heading "### 建 PR 前先過" not found`);
  assert.ok(branchPrefixIdx !== -1, `"### 分支前綴" heading not found`);
  return ruleBody.slice(advisoryIdx, branchPrefixIdx);
}

test("git-branch-and-pr-flow.md advisory section contains 'post-PR' and 'checkCrossModelMergeGate'", () => {
  const section = advisorySection();
  assert.ok(
    section.includes("post-PR"),
    `expected advisory section (between "### 建 PR 前先過" and "### 分支前綴") to contain "post-PR"`
  );
  assert.ok(
    section.includes("checkCrossModelMergeGate"),
    `expected advisory section (between "### 建 PR 前先過" and "### 分支前綴") to contain "checkCrossModelMergeGate"`
  );
});

test("git-branch-and-pr-flow.md advisory section must not contain bundled six-axis merge-fallback wording", () => {
  const section = advisorySection();
  assert.ok(
    !section.includes("六軸/cross-model 的機械兜底"),
    `advisory section must not contain "六軸/cross-model 的機械兜底"`
  );
  assert.ok(
    !section.includes("六軸兜底"),
    `advisory section must not contain "六軸兜底"`
  );
});

test("git-branch-and-pr-flow.md must not contain '六軸兜底在'", () => {
  assert.ok(
    !ruleBody.includes("六軸兜底在"),
    `git-branch-and-pr-flow.md must not contain "六軸兜底在"`
  );
});

const skillPath = repoPath(
  ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md"
);
const skillBody = readFileSync(skillPath, "utf8");

test("devpro:cross-review skill SSOT must not say 'PR 前全套含跨模型' and must mention Step 5.5", () => {
  assert.ok(
    !skillBody.includes("PR 前全套含跨模型"),
    `skill SSOT must not contain "PR 前全套含跨模型"`
  );
  assert.ok(
    skillBody.includes("Step 5.5"),
    `skill SSOT must contain "Step 5.5"`
  );
});
