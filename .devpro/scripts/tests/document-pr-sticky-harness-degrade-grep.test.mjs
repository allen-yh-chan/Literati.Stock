/**
 * Locks harness gh write-block degrade SOP anchors for issue #2367.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const SECOND_REVIEW_SKILL =
  ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md";
const CROSS_REVIEW_SKILL =
  ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md";
const TROUBLESHOOTING = ".devpro/agent-rules/troubleshooting.md";
const MARKER_DISPOSITION = ".devpro/agent-rules/post-pr-marker-disposition.md";
const POST_PR_GATE = ".devpro/agent-rules/post-pr-completion-gate.md";

const REQUIRED_PHRASES = [
  "Harness write-block degrade path",
  "provenance: manual-publish audit-only",
  "NOT gate artifact",
  "merge gate remains unsatisfied",
  "explicit user waiver",
];

function read(relPath) {
  return readFileSync(repoPath(relPath), "utf8");
}

test("devpro:second-review SKILL documents full harness write-block degrade SOP", () => {
  const source = read(SECOND_REVIEW_SKILL);
  for (const phrase of REQUIRED_PHRASES) {
    assert.ok(
      source.includes(phrase),
      `devpro:second-review missing required anchor: ${phrase}`,
    );
  }
  assert.match(
    source,
    /audit round cap 3[\s\S]{0,400}provenance: manual-publish audit-only/,
    "degrade path must bind audit-only cap 3 to manual-publish provenance",
  );
  assert.match(
    source,
    /audit-only[\s\S]{0,120}NOT[\s\S]{0,40}merge gate/,
    "degrade path must state audit-only is not merge gate",
  );
});

test("devpro:cross-review §5 points to harness write-block degrade path", () => {
  const source = read(CROSS_REVIEW_SKILL);
  assert.ok(source.includes("Harness write-block degrade path"));
  assert.ok(source.includes("provenance: manual-publish audit-only"));
  assert.ok(source.includes("merge gate remains unsatisfied"));
});

test("troubleshooting.md pointers harness gh write-block degrade path", () => {
  const source = read(TROUBLESHOOTING);
  assert.ok(source.includes("Harness write-block degrade path"));
  assert.ok(source.includes("provenance: manual-publish audit-only"));
});

function linesMatching(source, regex) {
  return source.split("\n").filter((line) => regex.test(line));
}

test("stale-waiver recipe lives in the post-PR marker disposition leaf and stays reachable", () => {
  const recipe = linesMatching(read(MARKER_DISPOSITION), /^\*\*Path W \/ stale post-PR\*\*/);
  assert.equal(recipe.length, 1, "disposition leaf must hold exactly one stale-waiver recipe line");
  assert.match(
    recipe[0],
    /刪舊 comment.*OWNER\|MEMBER\|COLLABORATOR.*`waived_head_sha`.*CRITICAL sticky 存在時 Path W \*\*不能\*\*解除.*使用者還沒在對話說要豁免時，AI 不得貼 waiver.*`hasFreshWaiver`.*\*\*stale UNAVAILABLE\*\*.*勿假設 merge 與 post-PR/,
    "recipe line must keep the repost steps, the CRITICAL limit, the no-waiver-before-the-user-says-so rule and the merge vs post-PR difference",
  );

  const entry = linesMatching(read(TROUBLESHOOTING), /^\*\*Path W \/ stale post-PR\*\*/);
  assert.equal(entry.length, 1, "troubleshooting.md must keep exactly one stale-waiver routing line");
  assert.match(
    entry[0],
    /stale waiver.*`post-pr-marker-disposition\.md` §Path W／stale waiver 排錯/,
    "troubleshooting.md must route stale-waiver readers to the disposition leaf",
  );
  assert.ok(!entry[0].includes("hasFreshWaiver"), "troubleshooting.md must not restate the recipe");

  const gate = linesMatching(read(POST_PR_GATE), /^- \*\*Path W pointer\*\*/);
  assert.equal(gate.length, 1, "post-PR gate must keep exactly one Path W pointer line");
  assert.match(
    gate[0],
    /stale waiver（sha ≠ head）.*`post-pr-marker-disposition\.md` §Path W／stale waiver 排錯/,
    "post-PR gate Path W pointer must route stale-waiver readers to the disposition leaf",
  );
});
