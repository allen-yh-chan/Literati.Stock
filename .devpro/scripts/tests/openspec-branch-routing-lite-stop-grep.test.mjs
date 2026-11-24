import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

/**
 * Rule #4 sends a repair of a merged, unreleased PR back to its original branch. When that branch
 * already carries the change's proposal (active or archived) and the repair runs at rigor lite,
 * the lite second-review builder refuses the head with `lite_proposal_present`. The routing leaf
 * must make the AI stop for a routing choice before it creates a branch, instead of failing at the
 * last step or splitting the unit on its own.
 */

const ROUTING = ".devpro/agent-rules/openspec-branch-routing.md";
const BUILDER = ".devpro/scripts/build-pr-sticky-handoff.mjs";
const RULE_4_ROW = "| MERGED | 否（未上 PROD） | 是 | **回原 branch 加 commit 再推**";

function requireOrdered(text, needles, label) {
  let at = 0;
  for (const needle of needles) {
    const found = text.indexOf(needle, at);
    assert.ok(found >= 0, `${label}: missing or out of order: ${JSON.stringify(needle)}`);
    at = found + needle.length;
  }
}

// [Scenario: openspec-flow :: A lite repair whose original branch carries a proposal stops for a routing choice]
test("Step 0 states the lite exception after the Rule #4 row: stop before a branch and offer full on the original branch or a lite bugfix/ from main HEAD", () => {
  const routing = read(ROUTING);
  const row = routing.indexOf(RULE_4_ROW);
  assert.ok(row >= 0, "the Rule #4 row of the Step 0 table is unchanged");
  assert.ok(routing.slice(row).includes("禁止新建 bugfix 分支分裂同一 logical unit"), "Rule #4 still forbids splitting the unit by default");
  requireOrdered(
    routing.slice(row),
    [
      "**lite 例外**",
      "原分支 HEAD 已帶該 change 的 proposal（含 archive）而本次走 lite",
      "`lite_proposal_present`",
      "建分支前停下問使用者",
      "回原分支走 full",
      "從 main HEAD 開 `bugfix/` 走 lite",
      "release 時兩分支一起選",
    ],
    "the lite exception follows the Rule #4 row",
  );
  const exception = routing.indexOf("**lite 例外**");
  const nextHeading = routing.indexOf("\n## ", row);
  assert.ok(nextHeading < 0 || exception < nextHeading, "the exception stays in the Step 0 section of the Rule #4 row");
  assert.equal(routing.split("**lite 例外**").length - 1, 1, "the exception is stated once");
});

test("the refusal the exception names is the one the lite builder raises", () => {
  assert.ok(read(BUILDER).includes('"lite_proposal_present"'), "build-pr-sticky-handoff.mjs still refuses with lite_proposal_present");
});
