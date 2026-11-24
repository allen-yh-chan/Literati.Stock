/**
 * entry-leaf-debundle-grep.test.mjs
 *
 * Structural assertions for the rationalize-overbundled-entry-leaves change.
 * Each task (T1–T6) gets its own describe block.
 * This file is extended by later tasks T2-T6.
 *
 * T1 covers: model-delegation entry leaf + 3 sibling files.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";


function readRule(filename) {
  return readFileSync(path.join(REPO_ROOT, ".devpro/agent-rules", filename), "utf8");
}

describe("T1: model-delegation de-bundle", () => {
  it("entry leaf contains Load-chain pointer to model-delegation-delegation-rules.md", () => {
    const content = readRule("model-delegation.md");
    assert.match(
      content,
      /model-delegation-delegation-rules\.md/,
      "entry leaf must contain Load-chain pointer to model-delegation-delegation-rules.md",
    );
  });

  it("entry leaf contains Load-chain pointer to model-delegation-token-efficiency.md", () => {
    const content = readRule("model-delegation.md");
    assert.match(
      content,
      /model-delegation-token-efficiency\.md/,
      "entry leaf must contain Load-chain pointer to model-delegation-token-efficiency.md",
    );
  });

  it("entry leaf contains Load-chain pointer to model-delegation-briefing.md", () => {
    const content = readRule("model-delegation.md");
    assert.match(
      content,
      /model-delegation-briefing\.md/,
      "entry leaf must contain Load-chain pointer to model-delegation-briefing.md",
    );
  });

  it("entry leaf does NOT contain ### Token 效率規則 (moved to sibling)", () => {
    const content = readRule("model-delegation.md");
    assert.doesNotMatch(
      content,
      /^### Token 效率規則/m,
      "### Token 效率規則 must not appear in entry leaf — it was moved to model-delegation-token-efficiency.md",
    );
  });

  it("model-delegation-delegation-rules.md contains ### MUST delegate 規則", () => {
    const content = readRule("model-delegation-delegation-rules.md");
    assert.match(
      content,
      /### MUST delegate 規則/,
      "model-delegation-delegation-rules.md must contain ### MUST delegate 規則",
    );
  });

  it("model-delegation-token-efficiency.md contains ### Token 效率規則", () => {
    const content = readRule("model-delegation-token-efficiency.md");
    assert.match(
      content,
      /### Token 效率規則/,
      "model-delegation-token-efficiency.md must contain ### Token 效率規則",
    );
  });

  it("model-delegation-briefing.md contains ### Briefing 模板", () => {
    const content = readRule("model-delegation-briefing.md");
    assert.match(
      content,
      /### Briefing 模板/,
      "model-delegation-briefing.md must contain ### Briefing 模板",
    );
  });

  it("model-delegation-briefing.md contains ### 回報格式", () => {
    const content = readRule("model-delegation-briefing.md");
    assert.match(
      content,
      /### 回報格式/,
      "model-delegation-briefing.md must contain ### 回報格式",
    );
  });

  it("model-delegation-delegation-rules.md starts with a Load-chain back-reference line", () => {
    const content = readRule("model-delegation-delegation-rules.md");
    assert.match(
      content,
      /Load-chain：/,
      "model-delegation-delegation-rules.md must contain a Load-chain: back-reference line",
    );
  });

  it("model-delegation-token-efficiency.md starts with a Load-chain back-reference line", () => {
    const content = readRule("model-delegation-token-efficiency.md");
    assert.match(
      content,
      /Load-chain：/,
      "model-delegation-token-efficiency.md must contain a Load-chain: back-reference line",
    );
  });

  it("model-delegation-briefing.md starts with a Load-chain back-reference line", () => {
    const content = readRule("model-delegation-briefing.md");
    assert.match(
      content,
      /Load-chain：/,
      "model-delegation-briefing.md must contain a Load-chain: back-reference line",
    );
  });
});

describe("T2: openspec-quality-and-formats de-bundle", () => {
  it("entry leaf contains backtick ref to openspec-quality-doc-formats.md", () => {
    const content = readRule("openspec-quality-and-formats.md");
    assert.match(
      content,
      /openspec-quality-doc-formats\.md/,
      "entry leaf must contain a backtick reference to openspec-quality-doc-formats.md",
    );
  });

  it("entry leaf contains backtick ref to openspec-quality-advanced-patterns.md", () => {
    const content = readRule("openspec-quality-and-formats.md");
    assert.match(
      content,
      /openspec-quality-advanced-patterns\.md/,
      "entry leaf must contain a backtick reference to openspec-quality-advanced-patterns.md",
    );
  });

  it("openspec-step-1-to-9.md contains backtick ref to openspec-quality-doc-formats.md (reachability)", () => {
    const content = readRule("openspec-step-1-to-9.md");
    assert.match(
      content,
      /openspec-quality-doc-formats\.md/,
      "openspec-step-1-to-9.md must contain a backtick reference to openspec-quality-doc-formats.md for reachability",
    );
  });

  it("openspec-step-1-to-9.md contains backtick ref to openspec-quality-advanced-patterns.md (reachability)", () => {
    const content = readRule("openspec-step-1-to-9.md");
    assert.match(
      content,
      /openspec-quality-advanced-patterns\.md/,
      "openspec-step-1-to-9.md must contain a backtick reference to openspec-quality-advanced-patterns.md for reachability",
    );
  });

  it("entry leaf does NOT contain ### meeting-notes.md (moved to sibling)", () => {
    const content = readRule("openspec-quality-and-formats.md");
    assert.doesNotMatch(
      content,
      /^### meeting-notes\.md/m,
      "### meeting-notes.md must not appear in entry leaf — it was moved to openspec-quality-doc-formats.md",
    );
  });

  it("entry leaf does NOT contain ### Archive-Time Task Split (moved to sibling)", () => {
    const content = readRule("openspec-quality-and-formats.md");
    assert.doesNotMatch(
      content,
      /^### Archive-Time Task Split/m,
      "### Archive-Time Task Split must not appear in entry leaf — it was moved to openspec-quality-advanced-patterns.md",
    );
  });

  it("entry leaf STILL contains ### Rule-feedback Surface Matrix (regression guard)", () => {
    const content = readRule("openspec-quality-and-formats.md");
    assert.match(
      content,
      /^### Rule-feedback Surface Matrix/m,
      "entry leaf must still contain ### Rule-feedback Surface Matrix — it was NOT moved",
    );
  });

  it("entry leaf STILL contains ### Writing Spec Deltas (regression guard)", () => {
    const content = readRule("openspec-quality-and-formats.md");
    assert.match(
      content,
      /^### Writing Spec Deltas/m,
      "entry leaf must still contain ### Writing Spec Deltas — it was NOT moved",
    );
  });

  it("openspec-quality-doc-formats.md contains ### meeting-notes.md", () => {
    const content = readRule("openspec-quality-doc-formats.md");
    assert.match(
      content,
      /^### meeting-notes\.md/m,
      "openspec-quality-doc-formats.md must contain ### meeting-notes.md",
    );
  });

  it("openspec-quality-doc-formats.md contains ### Requirement Ledger Lifecycle", () => {
    const content = readRule("openspec-quality-doc-formats.md");
    assert.match(
      content,
      /^### Requirement Ledger Lifecycle/m,
      "openspec-quality-doc-formats.md must contain ### Requirement Ledger Lifecycle",
    );
  });

  it("openspec-quality-advanced-patterns.md contains ### Diagram / Mermaid Evidence", () => {
    const content = readRule("openspec-quality-advanced-patterns.md");
    assert.match(
      content,
      /^### Diagram \/ Mermaid Evidence/m,
      "openspec-quality-advanced-patterns.md must contain ### Diagram / Mermaid Evidence",
    );
  });

  it("openspec-quality-advanced-patterns.md contains ### Archive-Time Task Split", () => {
    const content = readRule("openspec-quality-advanced-patterns.md");
    assert.match(
      content,
      /^### Archive-Time Task Split/m,
      "openspec-quality-advanced-patterns.md must contain ### Archive-Time Task Split",
    );
  });

  it("openspec-quality-doc-formats.md starts with a Load-chain back-reference line", () => {
    const content = readRule("openspec-quality-doc-formats.md");
    assert.match(
      content,
      /Load-chain：/,
      "openspec-quality-doc-formats.md must contain a Load-chain: back-reference line",
    );
  });

  it("openspec-quality-advanced-patterns.md starts with a Load-chain back-reference line", () => {
    const content = readRule("openspec-quality-advanced-patterns.md");
    assert.match(
      content,
      /Load-chain：/,
      "openspec-quality-advanced-patterns.md must contain a Load-chain: back-reference line",
    );
  });
});

describe("T3: openspec-flow-consumer de-bundle", () => {
  it("openspec-flow-consumer.md contains backtick ref to program-tracker-mode.md", () => {
    const content = readRule("openspec-flow-consumer.md");
    assert.match(
      content,
      /program-tracker-mode\.md/,
      "entry leaf must contain a backtick reference to program-tracker-mode.md",
    );
  });

  it("openspec-flow.md contains backtick ref to program-tracker-mode.md (reachability)", () => {
    const content = readRule("openspec-flow.md");
    assert.match(
      content,
      /program-tracker-mode\.md/,
      "openspec-flow.md must contain a backtick reference to program-tracker-mode.md for reachability",
    );
  });

  it("openspec-flow-consumer.md does NOT contain ### Issue-first Program Tracking (moved out)", () => {
    const content = readRule("openspec-flow-consumer.md");
    assert.doesNotMatch(
      content,
      /^### Issue-first Program Tracking/m,
      "### Issue-first Program Tracking must not appear in entry leaf — it was moved to program-tracker-mode.md",
    );
  });

  it("openspec-flow-consumer.md does NOT contain ### Local-MD Program Tracking (moved out)", () => {
    const content = readRule("openspec-flow-consumer.md");
    assert.doesNotMatch(
      content,
      /^### Local-MD Program Tracking/m,
      "### Local-MD Program Tracking must not appear in entry leaf — it was moved to program-tracker-mode.md",
    );
  });

  it("program-tracker-mode.md contains ### Issue-first Program Tracking", () => {
    const content = readRule("program-tracker-mode.md");
    assert.match(
      content,
      /^### Issue-first Program Tracking/m,
      "program-tracker-mode.md must contain ### Issue-first Program Tracking",
    );
  });

  it("program-tracker-mode.md contains ### Local-MD Program Tracking", () => {
    const content = readRule("program-tracker-mode.md");
    assert.match(
      content,
      /^### Local-MD Program Tracking/m,
      "program-tracker-mode.md must contain ### Local-MD Program Tracking",
    );
  });

  it("program-tracker-mode.md contains ### Program Tracker Mode", () => {
    const content = readRule("program-tracker-mode.md");
    assert.match(
      content,
      /^### Program Tracker Mode/m,
      "program-tracker-mode.md must contain ### Program Tracker Mode",
    );
  });

  it("program-tracker-mode.md starts with a Load-chain back-reference line", () => {
    const content = readRule("program-tracker-mode.md");
    assert.match(
      content,
      /Load-chain：/,
      "program-tracker-mode.md must contain a Load-chain: back-reference line",
    );
  });
});

describe("T4: release-sit-uat-pat-prod de-bundle", () => {
  it("entry leaf contains backtick ref to release-step-1-7.md", () => {
    const content = readRule("release-sit-uat-pat-prod.md");
    assert.match(
      content,
      /release-step-1-7\.md/,
      "entry leaf must contain a backtick reference to release-step-1-7.md",
    );
  });

  it("entry leaf contains backtick ref to release-rules-lane.md", () => {
    const content = readRule("release-sit-uat-pat-prod.md");
    assert.match(
      content,
      /release-rules-lane\.md/,
      "entry leaf must contain a backtick reference to release-rules-lane.md",
    );
  });

  it("entry leaf does NOT contain Step 1-7 body content (moved to sibling)", () => {
    const content = readRule("release-sit-uat-pat-prod.md");
    assert.doesNotMatch(
      content,
      /git worktree add.*release-\$DATE-\$SHORT_SHA/,
      "step 1-7 bash body must not appear in entry leaf — it was moved to release-step-1-7.md",
    );
  });

  it("entry leaf does NOT contain Rules Lane body content (moved to sibling)", () => {
    const content = readRule("release-sit-uat-pat-prod.md");
    assert.doesNotMatch(
      content,
      /git cherry-pick <sync-commit-sha>/,
      "Rules Lane cherry-pick body must not appear in entry leaf — it was moved to release-rules-lane.md",
    );
  });

  it("release-step-1-7.md contains ### Release 流程 step 1-7", () => {
    const content = readRule("release-step-1-7.md");
    assert.match(
      content,
      /### Release 流程 step 1-7/,
      "release-step-1-7.md must contain ### Release 流程 step 1-7",
    );
  });

  it("release-step-1-7.md contains Step 1 optional DEV confidence gate content", () => {
    const content = readRule("release-step-1-7.md");
    assert.match(
      content,
      /Step 1：Release intent \+ subset handoff \+ optional DEV confidence gate/,
      "release-step-1-7.md must contain Step 1 optional DEV confidence gate content",
    );
  });

  it("release-rules-lane.md contains cherry-pick distinctive string", () => {
    const content = readRule("release-rules-lane.md");
    assert.match(
      content,
      /git cherry-pick <sync-commit-sha>/,
      "release-rules-lane.md must contain git cherry-pick <sync-commit-sha>",
    );
  });

  it("release-rules-lane.md contains release/rules- distinctive string", () => {
    const content = readRule("release-rules-lane.md");
    assert.match(
      content,
      /release\/rules-/,
      "release-rules-lane.md must contain release/rules- pattern",
    );
  });

  it("release-rules-lane.md contains production-YYYYMMDD-rules distinctive string", () => {
    const content = readRule("release-rules-lane.md");
    assert.match(
      content,
      /production-YYYYMMDD-rules/,
      "release-rules-lane.md must contain production-YYYYMMDD-rules",
    );
  });

  it("release-step-1-7.md starts with a Load-chain back-reference line", () => {
    const content = readRule("release-step-1-7.md");
    assert.match(
      content,
      /Load-chain：/,
      "release-step-1-7.md must contain a Load-chain: back-reference line",
    );
  });

  it("release-rules-lane.md starts with a Load-chain back-reference line", () => {
    const content = readRule("release-rules-lane.md");
    assert.match(
      content,
      /Load-chain：/,
      "release-rules-lane.md must contain a Load-chain: back-reference line",
    );
  });
});

describe("T5: anti-patterns-examples de-bundle", () => {
  it("entry leaf contains backtick ref to anti-patterns-design.md", () => {
    const content = readRule("anti-patterns-examples.md");
    assert.match(
      content,
      /anti-patterns-design\.md/,
      "entry leaf must contain a backtick reference to anti-patterns-design.md",
    );
  });

  it("entry leaf contains backtick ref to anti-patterns-behavioral.md", () => {
    const content = readRule("anti-patterns-examples.md");
    assert.match(
      content,
      /anti-patterns-behavioral\.md/,
      "entry leaf must contain a backtick reference to anti-patterns-behavioral.md",
    );
  });

  it("entry leaf STILL contains the label §1 (index keeps all §N greppable)", () => {
    const content = readRule("anti-patterns-examples.md");
    assert.match(
      content,
      /§1/,
      "entry leaf must still contain §1 label in the pattern index",
    );
  });

  it("entry leaf STILL contains the label §16 (index keeps all §N greppable)", () => {
    const content = readRule("anti-patterns-examples.md");
    assert.match(
      content,
      /§16/,
      "entry leaf must still contain §16 label in the pattern index",
    );
  });

  it("entry leaf does NOT contain Drive-by Refactor antidote prose (moved to sibling)", () => {
    const content = readRule("anti-patterns-examples.md");
    assert.doesNotMatch(
      content,
      /IsNullOrWhiteSpace/,
      "Drive-by Refactor antidote prose (IsNullOrWhiteSpace) must not appear in entry leaf — it was moved to anti-patterns-design.md",
    );
  });

  it("anti-patterns-design.md contains ### §1 heading", () => {
    const content = readRule("anti-patterns-design.md");
    assert.match(
      content,
      /^### §1/m,
      "anti-patterns-design.md must contain ### §1 heading",
    );
  });

  it("anti-patterns-design.md contains ### §6 heading", () => {
    const content = readRule("anti-patterns-design.md");
    assert.match(
      content,
      /^### §6/m,
      "anti-patterns-design.md must contain ### §6 heading",
    );
  });

  it("anti-patterns-behavioral.md contains §7 label", () => {
    const content = readRule("anti-patterns-behavioral.md");
    assert.match(
      content,
      /§7/,
      "anti-patterns-behavioral.md must contain §7 label",
    );
  });

  it("anti-patterns-behavioral.md contains §12 label", () => {
    const content = readRule("anti-patterns-behavioral.md");
    assert.match(
      content,
      /§12/,
      "anti-patterns-behavioral.md must contain §12 label",
    );
  });

  it("anti-patterns-behavioral.md contains §13 label", () => {
    const content = readRule("anti-patterns-behavioral.md");
    assert.match(
      content,
      /§13/,
      "anti-patterns-behavioral.md must contain §13 label",
    );
  });

  it("anti-patterns-behavioral.md contains §14 label", () => {
    const content = readRule("anti-patterns-behavioral.md");
    assert.match(
      content,
      /§14/,
      "anti-patterns-behavioral.md must contain §14 label",
    );
  });

  it("anti-patterns-behavioral.md contains §16 label", () => {
    const content = readRule("anti-patterns-behavioral.md");
    assert.match(
      content,
      /§16/,
      "anti-patterns-behavioral.md must contain §16 label",
    );
  });

  it("anti-patterns-design.md starts with a Load-chain back-reference line", () => {
    const content = readRule("anti-patterns-design.md");
    assert.match(
      content,
      /Load-chain：/,
      "anti-patterns-design.md must contain a Load-chain: back-reference line",
    );
  });

  it("anti-patterns-behavioral.md starts with a Load-chain back-reference line", () => {
    const content = readRule("anti-patterns-behavioral.md");
    assert.match(
      content,
      /Load-chain：/,
      "anti-patterns-behavioral.md must contain a Load-chain: back-reference line",
    );
  });
});

describe("T6: code-review-checklist cross-model de-bundle", () => {
  it("entry leaf contains backtick ref to code-review-cross-model.md", () => {
    const content = readRule("code-review-checklist.md");
    assert.match(
      content,
      /code-review-cross-model\.md/,
      "entry leaf must contain a backtick reference to code-review-cross-model.md",
    );
  });

  it("entry leaf does NOT contain ### Merge Gate Enforcement (moved to sibling)", () => {
    const content = readRule("code-review-checklist.md");
    assert.doesNotMatch(
      content,
      /^### Merge Gate Enforcement/m,
      "### Merge Gate Enforcement must not appear in entry leaf — it was moved to code-review-cross-model.md",
    );
  });

  it("entry leaf does NOT contain ### External Reviewer CLI Skill Contract (moved to sibling)", () => {
    const content = readRule("code-review-checklist.md");
    assert.doesNotMatch(
      content,
      /^### External Reviewer CLI Skill Contract/m,
      "### External Reviewer CLI Skill Contract must not appear in entry leaf — it was moved to code-review-cross-model.md",
    );
  });

  it("entry leaf STILL contains ### 1. 功能正確性 (six axes kept — regression guard)", () => {
    const content = readRule("code-review-checklist.md");
    assert.match(
      content,
      /^### 1\. 功能正確性/m,
      "entry leaf must still contain ### 1. 功能正確性 — it was NOT moved",
    );
  });

  it("entry leaf STILL contains ### 6. Release 影響 (six axes kept — regression guard)", () => {
    const content = readRule("code-review-checklist.md");
    assert.match(
      content,
      /^### 6\. Release 影響/m,
      "entry leaf must still contain ### 6. Release 影響 — it was NOT moved",
    );
  });

  it("code-review-cross-model-cli-contract.md contains ### External Reviewer CLI Skill Contract", () => {
    const content = readRule("code-review-cross-model-cli-contract.md");
    assert.match(
      content,
      /^### External Reviewer CLI Skill Contract/m,
      "code-review-cross-model-cli-contract.md must contain ### External Reviewer CLI Skill Contract",
    );
  });

  it("code-review-cross-model.md does NOT contain ### External Reviewer CLI Skill Contract (moved to cli-contract sibling)", () => {
    const content = readRule("code-review-cross-model.md");
    assert.doesNotMatch(
      content,
      /^### External Reviewer CLI Skill Contract/m,
      "### External Reviewer CLI Skill Contract must not appear in code-review-cross-model.md — it was moved to code-review-cross-model-cli-contract.md",
    );
  });

  it("code-review-cross-model.md contains a pointer reference to code-review-cross-model-cli-contract.md", () => {
    const content = readRule("code-review-cross-model.md");
    assert.match(
      content,
      /code-review-cross-model-cli-contract\.md/,
      "code-review-cross-model.md must contain a pointer reference to code-review-cross-model-cli-contract.md",
    );
  });

  // refactor-cross-model-review-leaf: script-enforced dispatch mechanics moved verbatim to a cold sibling.
  const MOVED_DISPATCH_MECHANICS = [
    /^Before any live read, the builder refuses with `handoff_limit_exceeded`/m,
    /^- \*\*跨 repo 邊界\*\*：/m,
    /^ {3}- \*\*Invocation 與 tool surface\*\*：$/m,
    /^ {3}- \*\*Packet 與 control binding\*\*：$/m,
    /^ {3}- \*\*Completion contract\*\*：$/m,
    /^ {3}- \*\*Wrapper 與 attempt lock\*\*：$/m,
    /^ {3}- \*\*Scope evidence gate\*\*：$/m,
  ];

  it("code-review-cross-model-dispatch-mechanics.md carries the moved dispatch mechanics", () => {
    const content = readRule("code-review-cross-model-dispatch-mechanics.md");
    for (const pattern of MOVED_DISPATCH_MECHANICS) {
      assert.match(content, pattern, `code-review-cross-model-dispatch-mechanics.md must carry ${pattern}`);
    }
  });

  it("code-review-cross-model.md does NOT re-bundle the moved dispatch mechanics and points at the sibling", () => {
    const content = readRule("code-review-cross-model.md");
    for (const pattern of MOVED_DISPATCH_MECHANICS) {
      assert.doesNotMatch(
        content,
        pattern,
        `${pattern} must not appear in code-review-cross-model.md — it was moved to code-review-cross-model-dispatch-mechanics.md`,
      );
    }
    const pointers = content.split("\n").filter((line) => line.includes("`code-review-cross-model-dispatch-mechanics.md` §"));
    assert.equal(pointers.length, 4, "code-review-cross-model.md keeps one pointer per moved block");
  });

  it("the reviewer-duty sentence stays findable from the main leaf and the sibling's triggers", () => {
    // WARN／CRITICAL findings must carry `Suggested direction:`／`Verify by:`; that sentence moved with the
    // completion contract, so the main pointer and the sibling's triggers must both name it.
    const main = readRule("code-review-cross-model.md");
    const pointer = main.split("\n").find((line) => line.includes("§執行流程第 2 步：機制契約"));
    assert.ok(pointer, "code-review-cross-model.md keeps the mechanism-contract pointer");
    assert.match(pointer, /completion contract（含 WARN／CRITICAL finding 須附的 `Suggested direction:`／`Verify by:` 職責）/);
    const sibling = readRule("code-review-cross-model-dispatch-mechanics.md");
    const whenToUse = sibling.slice(sibling.indexOf("## When to Use"), sibling.indexOf("## Process"));
    assert.match(whenToUse, /^- 核對 WARN／CRITICAL finding 是否帶齊 `Suggested direction:`／`Verify by:` reviewer 職責/m);
    assert.doesNotMatch(whenToUse, /與 WARN 決策不讀本檔/);
  });

  it("code-review-cross-model.md contains ### Merge Gate Enforcement", () => {
    const content = readRule("code-review-cross-model.md");
    assert.match(
      content,
      /^### Merge Gate Enforcement/m,
      "code-review-cross-model.md must contain ### Merge Gate Enforcement",
    );
  });

  it("code-review-cross-model.md contains ### 豁免條件（SSOT）", () => {
    const content = readRule("code-review-cross-model.md");
    assert.match(
      content,
      /^### 豁免條件（SSOT）/m,
      "code-review-cross-model.md must contain ### 豁免條件（SSOT）",
    );
  });

  it("code-review-cross-model.md contains ### Second-Opinion / External-CLI Sandbox Policy", () => {
    const content = readRule("code-review-cross-model.md");
    assert.match(
      content,
      /^### Second-Opinion \/ External-CLI Sandbox Policy/m,
      "code-review-cross-model.md must contain ### Second-Opinion / External-CLI Sandbox Policy",
    );
  });

  it("code-review-cross-model.md starts with Load-chain back-ref", () => {
    const content = readRule("code-review-cross-model.md");
    assert.match(
      content,
      /Load-chain：/,
      "code-review-cross-model.md must contain a Load-chain: back-reference line",
    );
  });

  it("pointer carriers MUST NOT mention the removed cross-model-skip-paths extension", () => {
    const teachingFiles = [
      repoPath(".devpro/agent-rules/code-review-cross-model.md"),
      repoPath(".devpro/agent-rules/platform-adapters/cursor.md"),
      repoPath(".devpro/agent-rules/platform-adapters/copilot.md"),
      repoPath(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md"),
      repoPath(".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md"),
      repoPath("scenarios/scenario-s-cross-model-reviewer.md"),
      repoPath(".devpro/agent-rules/code-review-checklist.md"),
      repoPath(".devpro/agent-rules/post-pr-completion-gate.md"),
      repoPath(".devpro/agent-rules/rules-rigor-level.md"),
    ];
    const removedExtension = /cross-model-skip-paths|always-skip|marker 區塊追加|skip-paths?/i;
    const violations = [];
    for (const filePath of teachingFiles) {
      const fileContent = readFileSync(filePath, "utf8");
      if (removedExtension.test(fileContent)) {
        violations.push(`${filePath}: still mentions the removed cross-model-skip-paths extension`);
      }
    }
    assert.deepEqual(violations, [], violations.join("\n"));
  });

  it("no external citation pairs code-review-checklist.md with cross-model-skip-paths or 豁免條件（SSOT）", () => {
    // Files that may legitimately reference code-review-checklist.md for content that stayed
    // but must NOT pair it with the two moved items (skip-paths marker / 豁免條件 SSOT).
    // code-review-checklist.md itself is excluded (it may have a forwarding stub).
    // .claude/commands/dp/{cross-review,pre-pr}.md removed (migrate-skill-architecture-to-dp-prefix):
    // the `/dp:*` command surface is abolished; SSOT lives in the devpro:cross-review skill and
    // code-review-checklist.md /pre-pr flow, both already covered by other entries in this repo's
    // rule/spec grep suite, so no replacement candidate is needed here.
    const candidateFiles = [
      repoPath(".devpro/agent-rules/platform-adapters/copilot.md"),
      repoPath(".devpro/agent-rules/platform-adapters/cursor.md"),
      repoPath(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md"),
      repoPath(".devpro/agent-rules/platform-adapters/codex.md"),
      repoPath("scenarios/scenario-s-cross-model-reviewer.md"),
    ];
    const stalePattern = /code-review-checklist\.md.*(?:cross-model-skip-paths|豁免條件（SSOT）)|(?:cross-model-skip-paths|豁免條件（SSOT）).*code-review-checklist\.md/;
    const violations = [];
    for (const filePath of candidateFiles) {
      const fileContent = readFileSync(filePath, "utf8");
      const lines = fileContent.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (stalePattern.test(lines[i])) {
          violations.push(`${filePath}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Found stale citation(s) pairing code-review-checklist.md with cross-model-skip-paths or 豁免條件（SSOT） — these must point to code-review-cross-model.md:\n${violations.join("\n")}`,
    );
  });
});

describe("T7: ai-autonomy de-bundle", () => {
  // ── ai-autonomy.md entry: must NOT contain moved sections ────────────────────
  it("ai-autonomy.md does NOT contain ## Common Rationalizations (moved to sibling A)", () => {
    const content = readRule("ai-autonomy.md");
    assert.doesNotMatch(
      content,
      /^## Common Rationalizations$/m,
      "## Common Rationalizations must not appear in ai-autonomy.md — it was moved to ai-autonomy-rationalizations.md",
    );
  });

  it("ai-autonomy.md does NOT contain ## Verification (moved to sibling A)", () => {
    const content = readRule("ai-autonomy.md");
    assert.doesNotMatch(
      content,
      /^## Verification$/m,
      "## Verification must not appear in ai-autonomy.md — it was moved to ai-autonomy-rationalizations.md",
    );
  });

  it("ai-autonomy.md does NOT contain ### Root-Cause First (moved to sibling B)", () => {
    const content = readRule("ai-autonomy.md");
    assert.doesNotMatch(
      content,
      /^### Root-Cause First/m,
      "### Root-Cause First must not appear in ai-autonomy.md — it was moved to ai-autonomy-root-cause.md",
    );
  });

  // ── ai-autonomy.md entry: must contain 1-hop backtick references to siblings ─
  it("ai-autonomy.md contains backtick ref to ai-autonomy-rationalizations.md (1-hop anchor)", () => {
    const content = readRule("ai-autonomy.md");
    assert.match(
      content,
      /ai-autonomy-rationalizations\.md/,
      "ai-autonomy.md must contain a backtick reference to ai-autonomy-rationalizations.md for 1-hop reachability",
    );
  });

  it("ai-autonomy.md contains backtick ref to ai-autonomy-root-cause.md (1-hop anchor)", () => {
    const content = readRule("ai-autonomy.md");
    assert.match(
      content,
      /ai-autonomy-root-cause\.md/,
      "ai-autonomy.md must contain a backtick reference to ai-autonomy-root-cause.md for 1-hop reachability",
    );
  });

  // ── ai-autonomy-rationalizations.md sibling A ─────────────────────────────────
  it("ai-autonomy-rationalizations.md exists and contains ## Common Rationalizations", () => {
    const content = readRule("ai-autonomy-rationalizations.md");
    assert.match(
      content,
      /^## Common Rationalizations$/m,
      "ai-autonomy-rationalizations.md must contain ## Common Rationalizations",
    );
  });

  it("ai-autonomy-rationalizations.md contains ## Verification", () => {
    const content = readRule("ai-autonomy-rationalizations.md");
    assert.match(
      content,
      /^## Verification$/m,
      "ai-autonomy-rationalizations.md must contain ## Verification (Red Flags)",
    );
  });

  it("ai-autonomy-rationalizations.md contains Load-chain pointer mentioning ai-autonomy.md", () => {
    const content = readRule("ai-autonomy-rationalizations.md");
    assert.match(
      content,
      /Load-chain[：:][^\n]*ai-autonomy\.md/,
      "ai-autonomy-rationalizations.md must contain a Load-chain back-reference pointing to ai-autonomy.md",
    );
  });

  // ── ai-autonomy-root-cause.md sibling B ───────────────────────────────────────
  it("ai-autonomy-root-cause.md exists and contains Root-Cause First heading", () => {
    const content = readRule("ai-autonomy-root-cause.md");
    assert.match(
      content,
      /^#{2,3} Root-Cause First/m,
      "ai-autonomy-root-cause.md must contain a Root-Cause First heading (## or ###)",
    );
  });

  it("ai-autonomy-root-cause.md contains Load-chain pointer mentioning ai-autonomy.md", () => {
    const content = readRule("ai-autonomy-root-cause.md");
    assert.match(
      content,
      /Load-chain[：:][^\n]*ai-autonomy\.md/,
      "ai-autonomy-root-cause.md must contain a Load-chain back-reference pointing to ai-autonomy.md",
    );
  });
});

describe("T8: gitattributes-alignment new leaf", () => {
  it("gitattributes-alignment.md exists and contains ## Rules", () => {
    const content = readRule("gitattributes-alignment.md");
    assert.match(
      content,
      /^## Rules/m,
      "gitattributes-alignment.md must contain ## Rules",
    );
  });

  it("gitignore-alignment.md contains Load-chain pointer to gitattributes-alignment.md", () => {
    const content = readRule("gitignore-alignment.md");
    assert.match(
      content,
      /Load-chain[：:][^\n]*gitattributes-alignment\.md/,
      "gitignore-alignment.md must contain a Load-chain pointer to gitattributes-alignment.md",
    );
  });
});
