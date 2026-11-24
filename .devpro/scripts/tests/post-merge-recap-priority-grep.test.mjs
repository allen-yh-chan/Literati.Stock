/**
 * post-merge-recap-priority-grep.test.mjs
 *
 * Locks the post-merge handoff priority after automatic sync/status:
 * if Session Recap is due, Recap must be the first next action before
 * release, bump, next-work, or cleanup-style continuations.
 * Also locks those post-merge continuation anchors out of Post-PR handoff.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath, SOURCE_ROOT } from "./lib/repo-root.mjs";

const changeName = "strengthen-convergence-round1-rule-guards";

const rulePath = repoPath(".devpro/agent-rules/git-workflow-tracking.md");
const canonicalSpecPath = repoPath("openspec/specs/openspec-flow/spec.md");
const activeDeltaSpecPath = path.join(SOURCE_ROOT, "openspec/changes", changeName, "specs/openspec-flow/spec.md");

const ruleBody = readFileSync(rulePath, "utf8");
const canonicalSpec = readFileSync(canonicalSpecPath, "utf8");
const activeDeltaSpec = existsSync(activeDeltaSpecPath)
  ? readFileSync(activeDeltaSpecPath, "utf8")
  : "";
const archiveDir = repoPath("openspec/changes/archive");
const archivedDeltaSpec = existsSync(archiveDir)
  ? readdirSync(archiveDir)
      .filter((name) => name.endsWith(`-${changeName}`))
      .map((name) =>
        readFileSync(path.join(archiveDir, name, "specs/openspec-flow/spec.md"), "utf8")
      )
      .join("\n")
  : "";
const deltaSpec = [activeDeltaSpec, archivedDeltaSpec].join("\n");

const REQUIRED_RULE_PHRASES = [
  "post-merge handoff priority: Recap-first after sync/status",
  "session-recap.md",
  "notes/session-pending.md",
  "delete completed claimed pending entries",
  "Session Recap Discussion creation",
  "release / bump / next-work options",
  "cleanup deferred until production",
];

for (const phrase of REQUIRED_RULE_PHRASES) {
  test(`git-workflow-tracking.md contains post-merge Recap priority phrase: ${phrase}`, () => {
    assert.ok(
      ruleBody.includes(phrase),
      `expected git-workflow-tracking.md to contain "${phrase}" (post-merge Recap priority lock)`
    );
  });
}

test("post-merge Recap priority lives inside completion handoff before local-sync details", () => {
  const handoffIdx = ruleBody.indexOf("### Post-merge completion handoff");
  const priorityIdx = ruleBody.indexOf("post-merge handoff priority: Recap-first after sync/status");
  const localSyncIdx = ruleBody.indexOf("### Post-merge Local Sync");

  assert.ok(handoffIdx !== -1, "Post-merge completion handoff section missing");
  assert.ok(priorityIdx !== -1, "post-merge Recap priority anchor missing");
  assert.ok(localSyncIdx !== -1, "Post-merge Local Sync section missing");
  assert.ok(
    handoffIdx < priorityIdx && priorityIdx < localSyncIdx,
    `Recap priority must be part of completion handoff before local sync details (handoff=${handoffIdx}, priority=${priorityIdx}, localSync=${localSyncIdx})`
  );
});

test("Post-PR created handoff does not carry post-merge continuation anchors", () => {
  const postPrIdx = ruleBody.indexOf("### Post-PR created handoff");
  const postMergeIdx = ruleBody.indexOf("### Post-merge completion handoff");

  assert.ok(postPrIdx !== -1, "Post-PR created handoff section missing");
  assert.ok(postMergeIdx !== -1, "Post-merge completion handoff section missing");
  assert.ok(postPrIdx < postMergeIdx, "Post-PR section must stay before post-merge section");

  const postPrSection = ruleBody.slice(postPrIdx, postMergeIdx);
  for (const phrase of [
    "Session Recap Discussion creation",
    "release / bump / next-work options",
    "cleanup deferred until production",
  ]) {
    assert.equal(
      postPrSection.includes(phrase),
      false,
      `Post-PR created handoff must not include post-merge continuation anchor "${phrase}"`
    );
  }
});

const REQUIRED_SPEC_PHRASES = [
  "After sync/status, the post-merge handoff priority SHALL be Recap-first after sync/status",
  "completed claimed `notes/session-pending.md` entries for the merged change MUST already be deleted or completion-cleaned",
  "Session Recap Discussion creation MUST be the first/recommended next action",
  "#### Scenario: Post-Merge Handoff Prioritizes Recap",
  "release / bump / next-work options MAY follow only after Recap disposition",
  "cleanup MUST remain status-only as deferred until production",
];

const POST_MERGE_CONTINUATION_SEQUENCE =
  "sync main -> recap -> user-requested release -> production back merge -> cleanup";

test("openspec-flow delta resolves from active change or archive", () => {
  assert.ok(
    deltaSpec.trim().length > 0,
    "expected active or archived openspec-flow delta for strengthen-convergence-round1-rule-guards"
  );
});

for (const phrase of REQUIRED_SPEC_PHRASES) {
  test(`canonical openspec-flow spec contains Recap priority phrase: ${phrase}`, () => {
    assert.ok(
      canonicalSpec.includes(phrase),
      `expected canonical openspec-flow spec to contain "${phrase}"`
    );
  });

  test(`active or archived openspec-flow delta contains Recap priority phrase: ${phrase}`, () => {
    assert.ok(
      deltaSpec.includes(phrase),
      `expected active or archived openspec-flow delta to contain "${phrase}"`
    );
  });
}

test("post-merge continuation sequence keeps cleanup after production", () => {
  assert.ok(
    ruleBody.includes(POST_MERGE_CONTINUATION_SEQUENCE),
    `expected git-workflow-tracking.md to contain exact sequence "${POST_MERGE_CONTINUATION_SEQUENCE}"`
  );
  assert.match(
    ruleBody,
    /cleanup MUST NOT be (?:offered as|the) first next action before production/i,
    "cleanup must not be the first next action before production"
  );
});
