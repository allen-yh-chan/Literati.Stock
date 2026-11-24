import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: that the reverse-self-check leaf keeps its three moments, the Recap
 * three-line shape, and the "unverifiable counts as not asked" standard, and
 * that the Recap carrier points at it.
 * Does NOT prove: that anyone answers the questions, that the answers are
 * honest, or that a session's self-report was true. Those stay review and
 * cross-session judgement.
 */

const LEAF = ".devpro/agent-rules/reverse-self-check.md";

test("[Scenario: output-discipline :: The three moments and the self-report shape survive edits] the leaf carries all three moments and the self-report shape", () => {
  const leaf = read(LEAF);
  for (const moment of ["**動手前**", "**談需求時**", "**交付前**"]) {
    assert.ok(leaf.includes(moment), `missing moment: ${moment}`);
  }
  for (const line of ["- 動手前：", "- 需求：", "- 交付前："]) {
    assert.ok(leaf.includes(line), `missing self-report line: ${line}`);
  }
  assert.ok(
    leaf.includes("寫不出可驗的東西，就等於沒問"),
    "the verifiability standard must survive"
  );
  assert.ok(
    leaf.includes("沒有反例的宣告，就是沒驗過的宣告"),
    "the counter-example rule must survive"
  );
});

test("[Scenario: output-discipline :: The Recap carrier names the section without gating it] the Recap template requires the self-check", () => {
  const recap = read(".devpro/agent-rules/session-recap.md");
  assert.ok(recap.includes("反向自檢"), "session-recap must name the section");
  assert.ok(recap.includes("reverse-self-check.md"), "session-recap must point at the leaf");
});

test("the leaf states what it does and does not prove", () => {
  const leaf = read(LEAF);
  assert.match(leaf, /^證明：/m, "must state what the record proves (line-anchored, so 不證明 cannot satisfy it)");
  assert.match(leaf, /^不證明：/m, "must state what it does not prove");
});
