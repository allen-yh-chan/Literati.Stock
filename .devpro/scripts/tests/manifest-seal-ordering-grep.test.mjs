/**
 * Locks strengthen-manifest-seal-ordering: `devpro:pre-pr`'s seal-ordering
 * sentence, the two unavoidable-commit exit reconciliations
 * (`SKILL.md` and `subagent-dispatch-blocks.md`), and
 * `code-review-checklist.md`'s seal-only committed-worktree precondition
 * (kept distinct from the `current` relevant-paths-only verification scope)
 * must not be silently removed, reworded, or drift apart.
 *
 * Guard strength (rule-anchor-guard-strength.md): polarity clauses use
 * same-physical-line compound regexes; `封存順序` is pinned to appear exactly
 * once in `SKILL.md` so a duplicate or relocated sentence cannot silently
 * fork from the `dispatch_id` HEAD-sensitivity exit it complements.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const DISPATCH_BLOCKS =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const CHECKLIST = ".devpro/agent-rules/code-review-checklist.md";

function linesOf(path) {
  return readFileSync(repoPath(path), "utf8").split("\n");
}

function exactlyOneLine(lines, needle, path) {
  const hits = lines.filter((line) => line.includes(needle));
  assert.equal(
    hits.length,
    1,
    `expected exactly one line containing "${needle}" in ${path}, found ${hits.length}`,
  );
  return hits[0];
}

test("Scenario: devpro:pre-pr States Seal Ordering — SKILL.md seal-ordering sentence and both unavoidable-commit exit reconciliations", () => {
  // Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const skillLines = readPrePrSkillFullReadingOrder().split("\n");

  // "封存順序" must be the sole literal instance in the whole file — a second
  // copy would let the seal-ordering sentence silently drift apart from the
  // `dispatch_id` HEAD-sensitivity exit it complements.
  const orderingLine = exactlyOneLine(skillLines, "封存順序", SKILL);
  assert.match(
    orderingLine,
    /封存順序[\s\S]*本輪所有修改 MUST 先 commit 完才可執行 `seal-manifest`[\s\S]*seal 後到派 dp-reviewer 之間 MUST NOT 再 commit/,
    "seal-ordering sentence must bind 封存順序, the commit-before-seal MUST, and the MUST NOT re-commit clause on the same physical line",
  );
  assert.match(
    orderingLine,
    /HEAD[\s\S]*同輪 manifest 失效且不可重封/,
    "seal-ordering sentence must state that the post-seal commit advances HEAD and leaves the same-round manifest stale and not re-sealable",
  );

  const exitLine = exactlyOneLine(skillLines, "`dispatch_id` HEAD 敏感性（MUST）", SKILL);
  assert.match(
    exitLine,
    /若中間必須插入一個無法避免的 commit[\s\S]*MUST[\s\S]*classify-bounded[\s\S]*此出口對帶 sealed manifest 的 `route=bounded` \*\*不適用\*\*/,
    "SKILL.md unavoidable-commit exit sentence must state the sealed-manifest route=bounded exception on the same physical line as the exit itself",
  );
  assert.match(exitLine, /gitignored notes/, "SKILL.md exit reconciliation must record the classification result in gitignored notes");
  assert.match(exitLine, /route=full[\s\S]*不受影響/, "SKILL.md exit reconciliation must leave the route=full exit unchanged");

  const dispatchLine = exactlyOneLine(linesOf(DISPATCH_BLOCKS), "if a commit is unavoidable", DISPATCH_BLOCKS);
  assert.match(
    dispatchLine,
    /if a commit is unavoidable[\s\S]*does not apply to a `route=bounded` dispatch with sealed manifests/,
    "subagent-dispatch-blocks.md exit reconciliation must state the sealed-manifest route=bounded exception on the same physical line as the exit itself",
  );
  assert.match(
    dispatchLine,
    /record the classification in gitignored notes/,
    "subagent-dispatch-blocks.md exit reconciliation must record the classification in gitignored notes instead of a commit",
  );
  assert.match(
    dispatchLine,
    /`route=full` dispatch without manifests keeps this exit unchanged/,
    "subagent-dispatch-blocks.md exit reconciliation must leave the route=full exit unchanged",
  );
});

test("code-review-checklist.md keeps the seal-only committed-worktree precondition distinct from current's relevant-paths scope", () => {
  const line = exactlyOneLine(linesOf(CHECKLIST), "另要求整個工作區已 commit", CHECKLIST);
  assert.match(
    line,
    /`seal-manifest`[\s\S]*另要求整個工作區已 commit[\s\S]*否則拒封[\s\S]*專屬前置條件[\s\S]*`current` 驗證仍只看相關 paths/,
    "checklist line must bind the seal-only committed-worktree precondition and the current relevant-paths-only scope on the same physical line",
  );
});
