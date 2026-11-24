/**
 * archived-touch-path-hygiene.test.mjs
 *
 * Guard for archived proposal Touch/file-list path hygiene (archive-tooling
 * ADDED requirement): an archived change proposal MUST NOT reference its own
 * pre-archive active path (`openspec/changes/<name>/`) inside table rows; the
 * dated archive path must be used instead.
 *
 * Scenario: Archived Touch row keeps the pre-archive path
 * Scenario: Dated archive paths pass
 * Scenario: Legacy-listed folder may keep its historical rows
 *
 * Legacy set (2026-09-21 user ruling, strengthen-residue-guards): the one-time
 * sweep covers only folders the post-archive gate can re-audit; the listed
 * folders carry structural debt the gate refuses without rewriting history, so
 * the guard lists them explicitly and self-verifies that every entry still
 * holds a legacy row (an entry whose rows are later fixed must be removed from
 * the list; a non-listed folder with such a row fails).
 *
 * Teeth: detector fixtures are permanent; the repo-wide pass asserts archived
 * folder / proposal inventory floors so a shrunken corpus cannot fake a pass.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { findOwnActivePathRows } from "../lib/touch-path-hygiene.mjs";

const ARCHIVE_DIR = "openspec/changes/archive";

// Folders reverted from the sweep (gate-failing legacy set; provenance:
// notes/tmp/archive-gate-classification.json in the introducing change).
const LEGACY_FOLDERS = new Set([
  "2026-04-25-refactor-hook-and-agents-md-dedupe",
  "2026-04-26-strengthen-post-pr-handoff",
  "2026-04-26-strengthen-rules-from-recap-143",
  "2026-04-27-add-anti-patterns-from-karpathy",
  "2026-04-27-add-design-core-meta-principle",
  "2026-04-27-add-pre-pr-archive-gate",
  "2026-04-28-add-baseline-setup-defaults",
  "2026-04-28-add-doc-splitting-sop",
  "2026-04-28-add-local-first-codeql-execution-path",
  "2026-04-28-add-mvc-views-disable-to-codeql-template",
  "2026-04-28-add-per-change-worktree",
  "2026-04-28-fix-security-scan-runner-detection",
  "2026-04-29-gate-1-allow-release-merge-verbs",
  "2026-04-29-gate-1-tmp-allow-token-advisories",
  "2026-04-29-pretool-followups",
  "2026-04-29-split-pre-tool-mechanical-gates",
  "2026-05-03-wire-multi-runtime-parity-platform-adapters",
  "2026-05-05-strengthen-commit-attribution-gate",
  "2026-05-08-add-recap-hook-diagnostic-logging-and-marker-test",
  "2026-05-08-add-reference-pattern-and-threshold-cheatsheet",
  "2026-05-08-enforce-post-merge-release-handoff-routing",
  "2026-05-08-enforce-recap-body-structure-via-lint-and-hook",
  "2026-05-08-enforce-remote-branch-delete-gate",
  "2026-05-08-enforce-root-cause-first-prevent-surface-fix",
  "2026-05-08-fix-pre-pr-pr-template-routing",
  "2026-05-08-refactor-extract-git-utils-lib-and-fix-head-abbrev",
  "2026-05-08-strengthen-chore-a-self-alignment-grep",
  "2026-05-08-strengthen-step25-trigger-cover-hook-scripts",
  "2026-05-09-fix-pending-recap-chore-a-leak",
  "2026-05-10-add-baseline-self-check-and-destructive-auth",
  "2026-05-10-enforce-worktree-mandatory-gate",
  "2026-05-10-fix-gate-d-shell-expansion",
  "2026-05-10-fix-gh-footer-gate-cluster",
  "2026-05-10-fix-recap-discussion-cluster",
  "2026-05-10-refactor-archive-gate-to-scope-bound",
  "2026-05-10-refactor-extract-session-recap-to-leaf",
  "2026-05-10-strengthen-hygiene-shipped-detection",
  "2026-05-10-strengthen-onboarding-rules-prefix-bootstrap",
  "2026-05-11-clarify-readme-rules-sync-prompt",
  "2026-05-11-strengthen-sync-add-list-gitignore",
  "2026-05-14-enforce-codex-protected-branch-cwd-rule",
  "2026-05-14-fix-compliance-telemetry-import-side-effect",
  "2026-05-14-fix-squash-source-cleanup",
  "2026-05-17-add-platform-migration-rule",
  "2026-05-19-enforce-cross-model-default-on",
  "2026-05-21-add-observability-skills-and-pattern-docs",
  "2026-05-21-add-reusable-skill-evaluation",
  "2026-05-21-fix-post-pr-exempt-cold-start",
  "2026-05-22-strengthen-codex-gh-footer-strict",
  "2026-05-30-fix-archive-gate-worktree-cwd",
  "2026-06-01-amend-cross-model-and-fallback-rules",
  "2026-06-03-enforce-fixes-keyword-not-in-code-span",
  "2026-06-03-fix-codex-post-pr-cross-model-gate",
  "2026-06-03-strengthen-sql-server-string-encoding",
  "2026-06-03-strengthen-token-frugal-exploratory-rg-gate",
  "2026-06-03-sync-gitignore-alignment",
  "2026-06-04-refactor-hook-gate-strategy",
  "2026-06-05-fix-claude-cli-reviewer-hook-boundary",
  "2026-06-05-fix-claude-cross-review-max-turns",
  "2026-06-05-fix-hook-gate-policy-convergence",
  "2026-06-05-fix-post-pr-marker-crosssession-overblock",
  "2026-06-07-enforce-branch-name-scope-validation",
  "2026-06-07-enforce-change-folder-content-gates",
  "2026-06-07-enforce-production-tag-gate",
  "2026-06-07-fix-archive-gate-promote-scope",
  "2026-06-07-fix-hook-cwd-proof-launcher",
  "2026-06-08-enforce-pre-archive-scenario-guard",
  "2026-06-08-enforce-release-tag-suffix-match",
  "2026-06-08-enforce-tool-brand-sentence-ban",
  "2026-06-08-fix-branch-verb-gate-noarg-offset",
  "2026-06-08-fix-release-sha-length-regex",
  "2026-06-09-strengthen-commit-body-file-input",
  "2026-06-09-wire-troubleshooting-build-failure-route",
  "2026-06-11-rationalize-deferred-audit-fixes",
  "2026-06-12-fix-session-audit-enforcement-gaps",
  "2026-06-14-fix-cross-review-evidence-friction",
  "2026-06-14-fix-footer-gate-segment-aware",
  "2026-06-14-fix-v4-gate-worktree-cwd",
  "2026-06-14-strengthen-reviewer-issue-context",
  "2026-06-14-strengthen-runtime-parity-preflight",
  "2026-06-16-add-enforcement-carrier-scenarios",
  "2026-06-16-fix-codex-cross-review-safe-mode",
  "2026-06-16-strengthen-codex-subagent-authorization",
  "2026-06-17-add-consumer-adoption-tooling",
  "2026-06-17-enforce-requirement-ledger-completion-gate",
  "2026-06-17-strengthen-reviewer-sticky-staging-boundary",
  "2026-06-18-fix-production-tag-command-split",
  "2026-06-18-fix-recap-pending-dedup",
  "2026-06-18-strengthen-adoption-matrix-observability",
  "2026-06-21-clarify-rule-feedback-disposition",
  "2026-06-23-add-rule-self-evolution",
  "2026-06-23-add-rules-rigor-level",
  "2026-06-25-enforce-post-pr-blocked-next-step",
  "2026-06-25-strengthen-codex-token-gates",
  "2026-06-28-clarify-openspec-flow-step-count-heading",
  "2026-06-28-strengthen-body-carrier-subdir-coverage-test",
  "2026-06-28-strengthen-cross-model-blindspot-rationale",
  "2026-06-28-strengthen-delta-body-canonical-byte-match-lint",
  "2026-06-28-strengthen-spike-conclusion-citation-guard",
  "2026-06-29-refactor-test-suite-runtime",
  "2026-06-29-strengthen-rule-maintenance-guardrails",
  "2026-07-01-fix-codex-rule-load-ledger-bash",
  "2026-07-01-fix-post-pr-completion-merged-self-heal",
  "2026-07-01-strengthen-auto-compact-sync-guidance",
  "2026-07-01-strengthen-broad-rg-high-output-gate",
  "2026-07-02-fix-duplicate-rule-load-ledger-subagent-scope",
  "2026-07-03-fix-recap-discussion-lookup-timeout",
  "2026-07-04-fix-test-compliance",
  "2026-07-04-migrate-skill-architecture-to-dp-prefix",
  "2026-07-04-strengthen-worktree-gate-word-continuation",
  "2026-07-05-enforce-sync-prune-verification",
  "2026-07-05-fix-t9-grep-worktree-pollution",
  "2026-07-07-fix-production-tag-linked-worktree-gate",
  "2026-07-07-strengthen-second-reviewer-test-evidence-reuse",
  "2026-07-08-fix-consumer-root-validation-false-positives",
  "2026-07-10-fix-fix-class-fail-open",
  "2026-07-10-fix-rules-lane-consumer-smoke",
  "2026-07-14-fix-codeql-native-windows-routing",
  "2026-07-15-fix-gate-n-heading-boundary",
  "2026-07-15-fix-production-ancestry",
  "2026-07-16-fix-production-ancestry",
  "2026-07-17-strengthen-tooling-runtime-safety",
  "2026-07-19-fix-focused-range-evidence-capability",
  "2026-07-19-fix-worktree-quoted-literal-path",
  "2026-07-19-strengthen-agent-index-loadchain-guard",
  "2026-07-20-fix-claude-reviewer-safe-recipes",
  "2026-07-21-strengthen-maintenance-scope-gates",
  "2026-07-23-strengthen-gh-footer-gate-validator-only",
  "2026-07-24-strengthen-token-waste-controls",
  "2026-07-29-fix-consumer-check-scope",
  "2026-08-07-strengthen-matt-skill-mechanisms",
  "2026-08-07-strengthen-pre-change-clarification",
  "2026-08-08-clarify-rules-lane-pat-smoke-recipe",
  "2026-08-08-strengthen-authorization-brief-plain-language",
  "2026-08-08-strengthen-merge-authorization-brief",
  "2026-08-11-strengthen-requirements-clarification-contract",
  "2026-08-12-migrate-risk-classes-front-matter",
  "2026-08-13-fix-second-review-contract-integrity",
  "2026-08-15-strengthen-dry-ssot-corpus-scope",
  "2026-08-21-remove-token-budget-pr-gate",
  "2026-08-22-fix-spec-eof-blank-line",
  "2026-08-26-fix-review-warn-followups",
  "2026-08-30-strengthen-cursor-recovery-verification",
  "2026-09-02-add-lineage-usage-telemetry",
  "2026-09-09-enforce-hotfix-semver-assemble",
  "2026-09-11-fix-opencode-hookspecific-decision-parse",
  "2026-09-11-fix-post-pr-stop-hotpath-timeout",
  "2026-09-16-fix-pre-pr-tip-currency-two-gates",
  "2026-09-18-fix-cross-review-visibility",
  "2026-09-20-enforce-protected-branch-pr-only",
]);

describe("archived proposal Touch path hygiene guard", () => {
  it("fixtures: own active path reds; dated archive path and other-change paths pass", () => {
    const open = "| \`openspec/changes/";
    assert.deepEqual(findOwnActivePathRows(`${open}foo/**\` | openspec | A | — |`, "foo"), [1]);
    assert.deepEqual(
      findOwnActivePathRows(`${open}archive/2026-01-01-foo/**\` | openspec | A | — |`, "foo"),
      []
    );
    assert.deepEqual(findOwnActivePathRows(`${open}bar/**\` | openspec | A | — |`, "foo"), []);
    // prose (non-table) mentions are out of scope for this guard
    assert.deepEqual(findOwnActivePathRows(`touch set: ${open}foo/SKILL.md\``, "foo"), []);
  });

  it("no non-legacy archived proposal references its own pre-archive active path; legacy entries self-verify (Scenario: Archived Touch row keeps the pre-archive path / Scenario: Dated archive paths pass / Scenario: Legacy-listed folder may keep its historical rows)", () => {
    const archiveAbs = repoPath(ARCHIVE_DIR);
    const folders = readdirSync(archiveAbs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\d{4}-\d{2}-\d{2}-.+$/u.test(name))
      .sort();
    assert.ok(folders.length >= 900, `archived folder inventory unexpectedly small: ${folders.length}`);
    assert.ok(LEGACY_FOLDERS.size >= 100, `legacy set unexpectedly small: ${LEGACY_FOLDERS.size}`);
    const folderSet = new Set(folders);
    for (const folder of LEGACY_FOLDERS) {
      assert.ok(folderSet.has(folder), `legacy folder missing from archive: ${folder}`);
    }
    const violations = [];
    const legacyWithRows = new Set();
    let scanned = 0;
    for (const folder of folders) {
      const changeName = folder.slice(11);
      for (const file of ["proposal.md", "proposal-mini.md"]) {
        const rel = `${ARCHIVE_DIR}/${folder}/${file}`;
        if (!existsSync(repoPath(rel))) continue;
        scanned += 1;
        let text;
        try {
          text = readFileSync(repoPath(rel), "utf8");
        } catch (err) {
          violations.push(`${rel}: unreadable (${err.message})`);
          continue;
        }
        const rows = findOwnActivePathRows(text, changeName);
        if (LEGACY_FOLDERS.has(folder)) {
          if (rows.length > 0) legacyWithRows.add(folder);
        } else {
          for (const line of rows) violations.push(`${rel}:${line}`);
        }
      }
    }
    for (const folder of LEGACY_FOLDERS) {
      assert.ok(
        legacyWithRows.has(folder),
        `legacy folder no longer holds a legacy row and must leave the list: ${folder}`
      );
    }
    assert.ok(scanned >= 900, `archived proposal inventory unexpectedly small: ${scanned}`);
    assert.deepEqual(violations, [], `archived Touch path violations:\n${violations.join("\n")}`);
  });
});
