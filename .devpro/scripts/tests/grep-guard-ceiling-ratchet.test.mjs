import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: that every literal-presence guard (`*-grep.test.mjs` or
 * `*-guard.test.mjs`) whose source names a high-risk carrier either declares its
 * own ceiling or sits on a baseline that may only shrink.
 * Does NOT prove: that a declared ceiling is accurate or that it matches what
 * the guard actually asserts. A guard can carry a true-sounding ceiling that
 * describes a different scope; this file only checks the declaration exists and
 * that the baseline does not grow. Review owns the accuracy half.
 */

const TEST_DIR = ".devpro/scripts/tests";
// Two literal-guard naming families exist in this repo; scanning only one would
// leave the other family outside the ratchet (review finding F3, PR #3582).
const GUARD_SUFFIXES = ["-grep.test.mjs", "-guard.test.mjs"];

function isGuardFile(file) {
  return GUARD_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

// A ceiling declaration is a comment line in the guard's own source that starts
// with `Guarantee ceiling` or `保證上限`. The same words inside an assertion, a
// regex, a string fixture or a test title are assertion data, not a
// declaration; an earlier loose marker counted them and let 12 guards pass by
// coincidence (post-merge review of PR #3582).
const CEILING_DECLARATION = /^\s*(?:\/\/|\/?\*+)\s*(?:Guarantee ceiling|保證上限)/m;

// Carriers whose guards protect the Core Contract, security rules, or DB
// conventions. A silent limit on these is what motivated the ratchet; guards on
// low-stakes carriers are out of scope to keep this from becoming boilerplate.
const HIGH_RISK_CARRIERS = [
  "AGENTS.md",
  "design-core.md",
  "security-coding.md",
  "database-conventions.md",
  "ai-autonomy.md",
  "security-scanning.md",
];

// Grandfathered at introduction (2026-11-13). This list is frozen: never add,
// remove or swap a name here; its size and digest are pinned below. When a
// baselined guard gains a ceiling, list its name in RETIRED instead. The live
// baseline is this list minus RETIRED, so it can only shrink, and a new silent
// guard cannot take a retired slot: it is not in the frozen list, so the
// missing-ceiling check names it.
const BASELINE_AT_INTRODUCTION_SIZE = 61;
const BASELINE_AT_INTRODUCTION_SHA256 = "21704ef1b081f13569d2ef14acb7ee659ee210e4214abc31bd1e6e03b471f465";
const BASELINE_AT_INTRODUCTION = Object.freeze([
  "agent-file-colon-form-guard-grep",
  "agent-runtime-safety-patterns-grep",
  "agent-working-style-rules-grep",
  "agents-direct-intent-routing-grep",
  "batch-scope-record-residual-grep",
  "bootstrap-first-run-blockers-grep",
  "clarify-process-kill-ownership-grep",
  "clarify-sql-change-name-path-grep",
  "clarify-workflow-watch-dir-precheck-grep",
  "code-review-fallback-alignment-grep",
  "command-evidence-gates-grep",
  "consumer-failure-playbook-grep",
  "current-intent-after-continuation-grep",
  "current-state-delta-gate-grep",
  "delegation-threshold-wording-grep",
  "enforce-codex-api-latch-evidence-gate-grep",
  "enforce-decide-now-discipline-grep",
  "enforce-load-efficiency-self-check-grep",
  "enforce-session-env-isolation-grep",
  "enforce-spike-conclusion-citation-guard-grep",
  "entry-leaf-debundle-grep",
  "fix-batch-covered-idle-stop-grep",
  "flow-decay-discipline-grep",
  "full-batch-ledger-revocation-grep",
  "gate-outcome-honesty-grep",
  "hook-runtime-cost-boundary-grep",
  "knowledge-distillation-grep",
  "platform-adapter-bootstrap-grep",
  "platform-brand-isolation-grep",
  "post-pr-completion-gate-grep",
  "pre-tool-gates-spec-rule-cites-grep",
  "program-issue-routing-grep",
  "protected-anchor-grep",
  "readme-agents-ssot-routing-grep",
  "recap-discussion-location-grep",
  "release-already-live-backfill-grep",
  "remote-review-gateway-grep",
  "remove-gh-body-grep",
  "reusable-skill-adoption-grep",
  "rule-consistency-conflicts-grep",
  "rule-feedback-issues-grep",
  "rule-file-line-cite-ban-grep",
  "rules-sync-footer-version-anchor-grep",
  "session-recap-rule-feedback-grep",
  "source-release-lane-disambiguation-grep",
  "spawn-context-admission-grep",
  "spec-eof-newline-grep",
  "stop-point-comms-grep",
  "strengthen-batch-approval-carryforward-grep",
  "strengthen-commit-body-file-input-grep",
  "strengthen-design-review-independence-grep",
  "strengthen-matt-skill-mechanisms-grep",
  "strengthen-openspec-flow-rules-grep",
  "strengthen-pre-change-clarification-grep",
  "strengthen-rule-self-audit-grep",
  "structural-backstop-meta-grep",
  "subagent-footer-example-version-grep",
  "workflow-cost-controls-grep",
  "agents-md-import-guard",
  "pre-push-deletion-guard",
  "sql-server-string-encoding-rule-guard",
]);

// Names that left the baseline because their guard now declares a ceiling.
const RETIRED = new Set([]);

function liveBaseline(frozen, retired) {
  return new Set(frozen.filter((name) => !retired.has(name)));
}

const BASELINE = liveBaseline(BASELINE_AT_INTRODUCTION, RETIRED);

function guardName(file) {
  return file.replace(/\.test\.mjs$/, "");
}

function isHighRisk(text) {
  return HIGH_RISK_CARRIERS.some((carrier) => text.includes(carrier));
}

function declaresCeiling(text) {
  return CEILING_DECLARATION.test(text);
}

/**
 * Pure predicate over `{ name, text }` entries so the mutation probe can drive
 * it with fixtures instead of the live tree.
 */
function violations(entries, baseline = BASELINE) {
  const missing = [];
  const stale = [];
  for (const { name, text } of entries) {
    if (!isHighRisk(text)) continue;
    const declared = declaresCeiling(text);
    if (!declared && !baseline.has(name)) missing.push(name);
    if (declared && baseline.has(name)) stale.push(name);
  }
  return { missing, stale };
}

/** Pure check of the frozen list and the retired names against it. */
function baselineDrift(frozen, retired) {
  const digest = createHash("sha256").update(frozen.join("\n")).digest("hex");
  return {
    frozenEdited: frozen.length !== BASELINE_AT_INTRODUCTION_SIZE || digest !== BASELINE_AT_INTRODUCTION_SHA256,
    foreignRetired: [...retired].filter((name) => !frozen.includes(name)),
  };
}

function liveEntries() {
  return readdirSync(repoPath(TEST_DIR))
    .filter(isGuardFile)
    .map((file) => ({
      file,
      name: guardName(file),
      text: readFileSync(repoPath(`${TEST_DIR}/${file}`), "utf8"),
    }));
}

test("[Scenario: test-governance :: A new high-risk guard without a ceiling is rejected] every high-risk grep guard declares its ceiling or is baselined", () => {
  const { missing } = violations(liveEntries());
  assert.deepEqual(
    missing,
    [],
    `these guards lock a high-risk carrier without stating what they cannot catch; add a ceiling declaration to the guard itself (the baseline may not grow): ${missing.join(", ")}`
  );
});

test("the baseline may only shrink: the introduction list is frozen and every retired name comes from it", () => {
  const { frozenEdited, foreignRetired } = baselineDrift(BASELINE_AT_INTRODUCTION, RETIRED);
  assert.equal(
    frozenEdited,
    false,
    `BASELINE_AT_INTRODUCTION changed (size ${BASELINE_AT_INTRODUCTION.length}, frozen ${BASELINE_AT_INTRODUCTION_SIZE}); it is frozen: retire a guard by listing it in RETIRED, and give a new silent guard a ceiling declaration instead`
  );
  assert.deepEqual(foreignRetired, [], `RETIRED names that were never in the frozen baseline: ${foreignRetired.join(", ")}`);
});

test("[Scenario: test-governance :: A baselined guard that gains a ceiling must leave the baseline] the baseline may only shrink", () => {
  const { stale } = violations(liveEntries());
  assert.deepEqual(
    stale,
    [],
    `these guards now declare a ceiling and must leave the baseline; list them in RETIRED: ${stale.join(", ")}`
  );
});

test("every baseline entry still exists and is still high-risk", () => {
  const files = new Set(readdirSync(repoPath(TEST_DIR)).filter(isGuardFile));
  const entriesByName = new Map(liveEntries().map((e) => [e.name, e]));
  const orphaned = [];
  const outOfScope = [];
  for (const name of BASELINE) {
    const file = `${name}.test.mjs`;
    if (!files.has(file)) {
      orphaned.push(name);
      continue;
    }
    if (!isHighRisk(entriesByName.get(name).text)) outOfScope.push(name);
  }
  assert.deepEqual(orphaned, [], `baseline entries whose guard file no longer exists: ${orphaned.join(", ")}`);
  assert.deepEqual(
    outOfScope,
    [],
    `baseline entries that no longer name a high-risk carrier; remove them so the baseline stays honest: ${outOfScope.join(", ")}`
  );
});

test("mutation probe: the predicate rejects a new silent high-risk guard and a stale baseline entry", () => {
  const control = [
    { name: "declared-guard-grep", text: "// Guarantee ceiling: presence only\nread('AGENTS.md')" },
    { name: "low-stakes-guard-grep", text: "read('notes/whatever.md')" },
  ];
  assert.deepEqual(violations(control), { missing: [], stale: [] }, "control must pass");

  const newSilent = [
    ...control,
    { name: "brand-new-high-risk-grep", text: "read('.devpro/agent-rules/design-core.md')" },
  ];
  assert.deepEqual(
    violations(newSilent).missing,
    ["brand-new-high-risk-grep"],
    "a new high-risk guard with no ceiling must be rejected"
  );

  const baselinedAndDeclared = [...control, { name: BASELINE.values().next().value, text: "// Guarantee ceiling: presence only\nread('AGENTS.md')" }];
  assert.deepEqual(
    violations(baselinedAndDeclared).stale.length,
    1,
    "a baselined guard that now declares a ceiling must be reported as stale"
  );
});

test("[Scenario: test-governance :: A ceiling marker inside assertion data is not a declaration] only a comment line that starts the declaration counts", () => {
  const notDeclarations = {
    "assert-only-grep": "assert.match(body, /cooperative-only/);\nread('AGENTS.md')",
    "regex-only-grep": "const MARKER = /Guarantee ceiling|保證上限/;\nread('AGENTS.md')",
    "string-fixture-grep": "const text = \"// Guarantee ceiling: presence only\";\nread('AGENTS.md')",
    "test-title-grep": "test(\"Guarantee ceiling is declared\", () => {});\nread('AGENTS.md')",
    "descriptive-comment-grep": "// This guard checks the cooperative-only label; Does NOT prove much.\nread('AGENTS.md')",
  };
  const entries = Object.entries(notDeclarations).map(([name, text]) => ({ name, text }));
  assert.deepEqual(
    violations(entries).missing,
    Object.keys(notDeclarations),
    "marker words outside a declaration comment line must not count as a ceiling"
  );

  const declarations = {
    "block-comment-grep": "/**\n * Guarantee ceiling (cooperative-only).\n */\nread('AGENTS.md')",
    "line-comment-grep": "// Guarantee ceiling: presence only\nread('AGENTS.md')",
    "zh-comment-grep": "// 保證上限：只鎖字面存在\nread('AGENTS.md')",
  };
  const declared = Object.entries(declarations).map(([name, text]) => ({ name, text }));
  assert.deepEqual(violations(declared).missing, [], "positive control: declaration comment lines must count");
});

test("[Scenario: test-governance :: A swapped baseline entry is rejected by name] retiring one guard does not open a slot for another", () => {
  const [kept, retiredName] = BASELINE_AT_INTRODUCTION;
  const retired = new Set([retiredName]);
  const baseline = liveBaseline(BASELINE_AT_INTRODUCTION, retired);
  // One baselined guard gained a ceiling and was retired; a new silent guard
  // tries to take its place under a different name.
  const swapped = [
    { name: kept, text: "read('AGENTS.md')" },
    { name: retiredName, text: "// Guarantee ceiling: presence only\nread('AGENTS.md')" },
    { name: "foreign-silent-grep", text: "read('.devpro/agent-rules/design-core.md')" },
  ];
  assert.deepEqual(violations(swapped, baseline), { missing: ["foreign-silent-grep"], stale: [] });

  // Writing the foreign name into RETIRED or the frozen list fails too.
  assert.deepEqual(baselineDrift(BASELINE_AT_INTRODUCTION, new Set(["foreign-silent-grep"])).foreignRetired, ["foreign-silent-grep"]);
  const frozenSwap = BASELINE_AT_INTRODUCTION.map((name) => (name === retiredName ? "foreign-silent-grep" : name));
  assert.equal(baselineDrift(frozenSwap, new Set()).frozenEdited, true, "a swap inside the frozen list must change its digest");
  assert.equal(baselineDrift(BASELINE_AT_INTRODUCTION, new Set()).frozenEdited, false, "control: the untouched frozen list passes");
});
