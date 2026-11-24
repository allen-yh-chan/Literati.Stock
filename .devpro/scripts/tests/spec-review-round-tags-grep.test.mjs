import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, SOURCE_ROOT } from "./lib/repo-root.mjs";

// #2858: two canonical specs carried review-round tags ("issue #851/#848 cross-model round 12",
// "round 22／F-page22", "dp-second-reviewer round-26 (dispatch-…) found …"). They name the review that
// produced a clause, not the mechanism, so a reader cannot tell whether the clause still applies and a
// model copies the tags into new text. The clauses stay; the behaviour they describe is locked by the
// gate tests, and the survival anchors below keep the rewritten narrative from dropping a rule sentence.

const preToolGates = readFileSync(path.join(SOURCE_ROOT, "openspec/specs/pre-tool-mechanical-gates/spec.md"), "utf8");
const ambiguityScoring = readFileSync(path.join(SOURCE_ROOT, "openspec/specs/ambiguity-scoring/spec.md"), "utf8");

function tagHits(text, re) {
  return text
    .split("\n")
    .map((line, i) => ({ n: i + 1, found: line.match(re) }))
    .filter(({ found }) => found)
    .map(({ n, found }) => `${n}: ${found.join(", ")}`);
}

test("pre-tool-mechanical-gates spec carries no review-round, finding-ID or dispatch-ID tag", () => {
  // every `round N` in this spec is a review round; the gate semantics never count rounds
  const hits = tagHits(preToolGates, /\bround[ -]\d+|cross-model rounds?\b|dp-second-reviewer round|dispatch-[0-9a-f]{8}|finding I-\d+|F-page\d+/g);
  assert.deepEqual(hits, [], `review-round tags are back: ${hits.join(" | ")}`);
});

test("ambiguity-scoring spec carries no review-round or finding-ID tag", () => {
  // `round 1`-`round 4` here are clarification rounds, so only the review-tag shapes are matched
  const hits = tagHits(ambiguityScoring, /F-page\d+|round \d+／|cross-model round|dp-second-reviewer round|dispatch-[0-9a-f]{8}/g);
  assert.deepEqual(hits, [], `review-round tags are back: ${hits.join(" | ")}`);
});

test("the note that called the removed round tags history is gone with them", () => {
  assert.equal(preToolGates.includes("Lineage notes in this requirement"), false);
});

test("the rewritten footer-gate separator paragraphs keep their rule sentences", () => {
  for (const anchor of [
    /`CONTINUATION_WS_SEP` MUST NOT be hand-duplicated at either position/,
    /the `=` alternative is deliberately excluded there/,
    /`SHORT_FLAG_VALUE_SEP` MUST NOT be reused for the\s+typed-field `body=` surfaces below/,
    /The stripping step MUST be implemented once at that one shared resolution function/,
    /the two MUST NOT diverge, because a fix to only one leaves the other exposed/,
    /loops the strip, repeatedly re-matching `GH_GLOBAL_REPO_FLAG_RE`/,
    /A per-surface separator MUST NOT be hand-duplicated across these three surfaces/,
  ]) {
    assert.match(preToolGates, anchor);
  }
});
