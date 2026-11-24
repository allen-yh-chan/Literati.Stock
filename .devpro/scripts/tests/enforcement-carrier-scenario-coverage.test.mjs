import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

function readOptional(relPath) {
  const fullPath = repoPath(relPath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

function assertGitattributesAlignmentCoverage(scenario, ruleLeaf) {
  assert.match(scenario, /\.devpro\/agent-rules\/gitattributes-alignment\.md/);
  assert.match(scenario, /non-normative walkthrough/i);
  assert.match(scenario, /terminal[\s\S]*last-match-wins|last-match-wins[\s\S]*terminal/i);
  assert.match(scenario, /consumer-owned[\s\S]*byte-for-byte unchanged/i);
  assert.match(scenario, /missing[\s\S]*non-terminal[\s\S]*overridden/i);
  assert.match(scenario, /first-sync notice/i);
  assert.match(scenario, /--sync/);
  assert.match(scenario, /subsequent `--check` passes/i);

  assert.match(ruleLeaf, /# devpro-agent-rules gitattributes managed begin/);
  assert.match(ruleLeaf, /Last-Match-Wins Priority/);
  assert.match(ruleLeaf, /First-sync notice/);
  assert.match(ruleLeaf, /Canonical Terminal Block/);
  assert.match(ruleLeaf, /consumer-owned attribute rules outside the managed block/);
  assert.match(ruleLeaf, /sync-agent-rules\.mjs --sync/);
  assert.match(ruleLeaf, /sync-agent-rules\.mjs --check/);
}

describe("enforcement carrier scenario coverage", () => {
  it("gh-footer-gate scenario covers write-back detection and reviewer subprocess FS isolation", () => {
    const scenario = read("scenarios/scenario-x-source-repo-gh-footer-gate-enforcement.md");
    assert.match(scenario, /gh-footer-gate\.mjs/);
    assert.match(scenario, /command-segment ownership/);
    assert.match(scenario, /DEVPRO_CROSS_MODEL_REVIEWER/);
    assert.match(scenario, /CRR-1a/);
    assert.match(scenario, /CRR-1c/);
    assert.match(scenario, /CRR-1d/);
    assert.match(scenario, /TL body file 寫在 main-checkout/);
  });

  it("subagent projection scenario covers Codex and Cursor status vocabulary negative gates", () => {
    const scenario = read("scenarios/scenario-y-source-repo-subagent-status-projection.md");
    assert.match(scenario, /Subagent Status Vocabulary/);
    assert.match(scenario, /codex-subagent-projection\.test\.mjs/);
    assert.match(scenario, /cursor-subagent-projection\.test\.mjs/);
    assert.match(scenario, /legacy term/);
    assert.match(scenario, /out-of-subset canonical term/);
    assert.match(scenario, /mutation proof/i);
  });

  it("pre-pr archive gate scenario covers bugfix check (l) missing tasks fail-closed behavior", () => {
    const scenario = read("scenarios/scenario-ab-source-repo-pre-pr-archive-gate.md");
    assert.match(scenario, /pre-pr-archive-gate\.mjs/);
    assert.match(scenario, /check `\(l\)`/);
    assert.match(scenario, /missing-`tasks\.md` fail-closed/);
    assert.match(scenario, /no prove-it marker/);
    assert.match(scenario, /non-bugfix skip/i);
  });

  it("scenario AD covers pre-pr archive gate check (m) Requirement Ledger integrity", () => {
    const scenario = readOptional("scenarios/scenario-ad-source-repo-requirement-ledger-archive-gate.md");

    assert.match(scenario, /Scenario AD/);
    assert.match(scenario, /check `\(m\)`/);
    assert.match(scenario, /valid[^\n]*ledger[^\n]*pass/i);
    assert.match(scenario, /missing[^\n]*ledger[^\n]*fail-closed/i);
    assert.match(scenario, /Invalid lineage shape/i);
    assert.match(scenario, /missing Root Requirement、Parent Requirement 或 Current Requirement column blocks/i);
    assert.match(scenario, /case \(m-8\)[^\n]*empty\/template-placeholder lineage cells block/i);
    assert.match(scenario, /task[^\n]*trace[^\n]*exact[^\n]*Requirement ID/i);
    assert.match(scenario, /escaped[^\n]*`\\\|`/i);
    assert.doesNotMatch(scenario, /parent resolves to another row|unresolved or cyclic parent|unresolved parent/i);
    assert.match(scenario, /pre-pr-archive-gate\.mjs/);
    assert.match(scenario, /pre-pr-archive-gate\.test\.mjs/);
    assert.match(scenario, /archive-tooling/);
  });

  it("cross-model reviewer scenario covers publication transaction remediation", () => {
    const scenario = read("scenarios/scenario-s-cross-model-reviewer.md");

    assert.match(scenario, /C19/);
    assert.match(scenario, /publication transaction remediation/i);
    assert.match(scenario, /devpro-second-review-publication-transaction-remediation\/v1/);
    assert.match(scenario, /digest-only/);
    assert.match(scenario, /raw malformed payload/i);
    assert.match(scenario, /same sweep/i);
    assert.match(scenario, /render-second-review-packet\.test\.mjs/);
  });

  it("scenario AE covers session ownership and compact Stop output", () => {
    const scenario = read("scenarios/scenario-ae-source-repo-post-pr-completion-cleanup.md");

    assert.match(scenario, /Scenario AE/);
    assert.match(scenario, /Foreign PR is silent.*does not adopt it, query GitHub, refresh clocks or clear authority/);
    assert.match(scenario, /Explicit adoption.*without stealing creator identity or overwriting dispatch bindings/);
    assert.match(scenario, /Compact AI output.*at most three lines/);
    assert.match(scenario, /Verified clearing only.*foreign Stop cannot perform merged self-heal or global evidence pruning/);
    assert.match(scenario, /targeted merge validation/);
  });

  it("scenario AF covers source-repo gitattributes alignment and binds the normative rule leaf", () => {
    const scenario = read("scenarios/scenario-af-source-repo-gitattributes-alignment.md");
    const ruleLeaf = read(".devpro/agent-rules/gitattributes-alignment.md");

    assertGitattributesAlignmentCoverage(scenario, ruleLeaf);

    const scenarioWithoutAnchor = scenario.replace(/first-sync notice/gi, "initial alignment notice");
    assert.throws(
      () => assertGitattributesAlignmentCoverage(scenarioWithoutAnchor, ruleLeaf),
      /first-sync notice/i,
    );

    const ruleLeafWithoutAnchor = ruleLeaf.replace("Canonical Terminal Block", "Managed Block Placement");
    assert.throws(
      () => assertGitattributesAlignmentCoverage(scenario, ruleLeafWithoutAnchor),
      /Canonical Terminal Block/,
    );
  });

  it("scenarios spec makes enforcement carrier coverage explicit", () => {
    const spec = [
      read("openspec/specs/scenarios/spec.md"),
      readOptional("openspec/changes/strengthen-round2-convergence-gates/specs/scenarios/spec.md"),
      readOptional("openspec/changes/add-enforcement-carrier-scenarios/specs/scenarios/spec.md"),
      readOptional("openspec/changes/archive/2026-06-16-add-enforcement-carrier-scenarios/specs/scenarios/spec.md"),
      readOptional("openspec/changes/fix-pending-rule-guard-gaps/specs/scenarios/spec.md"),
      readOptional("openspec/changes/strengthen-pr-1834-followups/specs/scenarios/spec.md"),
    ].join("\n");
    assert.match(spec, /Enforcement Carrier Scenario Coverage/);
    assert.match(spec, /gh-footer-gate\.mjs/);
    assert.match(spec, /reviewer subprocess FS-isolation/);
    assert.match(spec, /subagent projection status vocabulary/);
    assert.match(spec, /pre-pr-archive-gate\.mjs/);
    assert.match(spec, /missing-`tasks\.md` fail-closed/);
    assert.match(spec, /scenario-ad-source-repo-requirement-ledger-archive-gate\.md/);
    assert.match(spec, /check `\(m\)`/);
    assert.match(spec, /Requirement Ledger/);
    assert.match(spec, /missing lineage columns, empty or placeholder lineage cells/);
    assert.match(spec, /scenario-s-cross-model-reviewer\.md/);
    assert.match(spec, /publication transaction remediation/);
    assert.match(spec, /digest-only/);
    assert.match(spec, /scenario-ae-source-repo-post-pr-completion-cleanup\.md/);
    assert.match(spec, /skipped cleanup probe throttling/);
    assert.match(spec, /proof_missing/);
    assert.match(spec, /Source Repository Git Attributes Alignment Scenario Walkthrough/);
    assert.match(spec, /scenario-af-source-repo-gitattributes-alignment\.md/);
    assert.match(spec, /consumer-owned rules outside the managed block/);
  });
});
