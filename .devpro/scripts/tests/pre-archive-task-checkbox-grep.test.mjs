/**
 * pre-archive-task-checkbox-grep.test.mjs
 *
 * Guards the execution-loop + closing-layer + cross-model enforcement
 * anchors added by chore/strengthen-pre-archive-task-checkbox-gate.
 *
 * Root cause closed: AI treated the task checklist as decoration, not an
 * item-by-item execution loop — proposal written once, never revisited, so
 * checkboxes stayed `[ ]` while the PR body claimed "all done" (memory-driven).
 * No gate verified checkbox state OR "check = has evidence". This change adds:
 *   R1 execution layer — openspec-quality-and-formats.md §Tasks.md 品質要求
 *      「執行迴路」 (逐條認領→做→當下回勾, each [x] bound to evidence) + a
 *      /dp:pre-pr Step 1 pointer;
 *   R2 closing layer — lint-proposal-tasks-checked.mjs (pre-archive) +
 *      pre-pr-archive-gate.mjs check (o) (post-archive) + code-review-checklist.md
 *      axis-1 sub-check (claimed-done vs checkbox+evidence);
 *   R3 gap 2 — /dp:pre-pr Step 5.5.2 pre-dispatch clause (its approval wait is retired:
 *      the clause is now an absence guard).
 *   R4 single-ledger contract — full change uses tasks.md only; proposal.md
 *      carries a pointer/summary, while B-mini keeps proposal-mini.md inline tasks.
 *
 * Removing any anchor silently reopens a gap → this test goes red.
 * (Adversarial-verified: flipping / deleting each anchor turns the matching
 * assertion red; see the corresponding behavior tests
 * lint-proposal-tasks-checked.test.mjs + pre-pr-archive-gate.test.mjs (o-1..o-8).)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { checkEvidenceAnchor } from "../lint-proposal-tasks-checked.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";
import { readChangeSkillFullReadingOrder } from "./lib/change-skill.mjs";

function readFile(relPath) {
  return readFileSync(repoPath(relPath), "utf8");
}

// Per rule-anchor-guard-strength.md: bind polarity-sensitive clauses on ONE
// physical line with a compound regex, and count the matching lines so 唯一命中
// is asserted rather than assumed.
function operativeLines(content, pattern) {
  return content.split("\n").filter((line) => pattern.test(line));
}

describe("pre-archive-task-checkbox-grep", () => {
  describe("R1 execution layer — openspec-quality-and-formats.md §Tasks.md 品質要求 執行迴路", () => {
    const content = readFile(".devpro/agent-rules/openspec-quality-and-formats.md");

    it("contains the 執行迴路 clause marking checkbox as execution state, not decoration", () => {
      assert.ok(
        content.includes("執行迴路") && content.includes("非事後裝飾"),
        "openspec-quality-and-formats.md must contain the 執行迴路 clause with '非事後裝飾' anchor — execution-loop requirement missing"
      );
    });

    it("mandates 逐條認領→做→當下回勾 (item-by-item claim→do→check-off-now)", () => {
      assert.ok(
        content.includes("逐條認領") && content.includes("當下回勾"),
        "openspec-quality-and-formats.md 執行迴路 must require 逐條認領 + 當下回勾 — the memory-driven-defeat anchor is missing"
      );
    });

    it("binds each [x] to verifiable evidence", () => {
      assert.ok(
        content.includes("綁可驗證證據"),
        "openspec-quality-and-formats.md 執行迴路 must bind each [x] to 可驗證證據 — evidence-binding anchor missing"
      );
    });

    it("cross-references multi-agent-handoff §Finding Verification (memory=hypothesis principle, DRY)", () => {
      assert.ok(
        content.includes("multi-agent-handoff.md") && content.includes("Finding Verification"),
        "openspec-quality-and-formats.md 執行迴路 must cross-reference multi-agent-handoff.md §Finding Verification — DRY anchor missing"
      );
    });
  });

  describe("R1 execution layer — /dp:pre-pr Step 1 pointer", () => {
    const content = readFile(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");

    it("Step 1 points at the 執行迴路 + harness task tracking", () => {
      assert.ok(
        content.includes("執行迴路") && content.includes("harness task 追蹤"),
        ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md Step 1 must reference the 執行迴路 + harness task 追蹤 — pointer missing"
      );
    });
  });

  describe("R2 closing layer — lint-proposal-tasks-checked.mjs (pre-archive)", () => {
    const content = readFile(".devpro/scripts/lint-proposal-tasks-checked.mjs");

    it("exports lintProposalTasksChecked (shared SSOT for pre- and post-archive)", () => {
      assert.ok(
        content.includes("export function lintProposalTasksChecked"),
        "lint-proposal-tasks-checked.mjs must export lintProposalTasksChecked — the shared checkbox verifier is missing"
      );
    });

    it("verifies checked tasks carry both a [Req: R#] and a 驗收/acceptance anchor", () => {
      // The 驗收/acceptance side is still a source LITERAL match: the regex lives
      // in this file and removing it must turn this red.
      assert.ok(
        content.includes("驗收|acceptance"),
        "lint-proposal-tasks-checked.mjs must keep the `驗收|acceptance` regex — hasAcceptance structural-evidence check missing"
      );
      // The [Req: R#] side is asserted BEHAVIOURALLY. Its id shape moved to
      // lib/requirement-ledger-rows.mjs (add-requirement-count-ratchet) so that
      // this probe, the archive gate's ledger parser and the requirement-count
      // ratchet cannot drift apart; a source-literal match would now lock the
      // wrong thing, and would in any case pass on a literal left behind as dead
      // code. Exercising the exported function is strictly stronger.
      assert.equal(checkEvidenceAnchor("- [x] T1 [Req: R1] 驗收: green").hasReq, true);
      assert.equal(checkEvidenceAnchor("- [x] T1 [Req: R4a] 驗收: green").hasReq, true);
      assert.equal(checkEvidenceAnchor("- [x] T1 no ledger tag 驗收: green").hasReq, false);
      assert.equal(checkEvidenceAnchor("- [x] T1 [Req: none] 驗收: green").hasReq, false);
      assert.ok(
        content.includes("requirement-ledger-rows.mjs"),
        "lint-proposal-tasks-checked.mjs must take the requirement-id shape from the shared lib, not re-type it"
      );
    });

    it("honours the ## Deferred escape-hatch for authorized unchecked tasks", () => {
      assert.ok(
        content.includes("Deferred"),
        "lint-proposal-tasks-checked.mjs must support the ## Deferred escape-hatch — authorized-unchecked path missing"
      );
    });

    it("documents ACTIVE-folder-only scope and forbids archive-path misuse (#2267)", () => {
      assert.ok(
        content.includes("ACTIVE") && content.includes("openspec/changes/archive/"),
        "lint-proposal-tasks-checked.mjs must say ACTIVE change folders only and MUST NOT archive/ paths — #2267 scope note missing"
      );
      assert.ok(
        content.includes("# Tasks: <change-name>") || content.includes("# Tasks: <name>"),
        "lint-proposal-tasks-checked.mjs must name archived H1 `# Tasks: <change-name>` as out of scope"
      );
    });
  });

  describe("R2 closing layer — /dp:pre-pr Step 3.6 pre-archive lint hookup", () => {
    const content = readFile(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");

    it("Step 3.6 runs lint-proposal-tasks-checked.mjs before openspec archive", () => {
      assert.ok(
        content.includes("lint-proposal-tasks-checked.mjs"),
        ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md Step 3.6 must invoke lint-proposal-tasks-checked.mjs in the pre-archive lint list — hookup missing"
      );
    });
  });

  describe("R2 closing layer — pre-pr-archive-gate.mjs check (o) (post-archive backstop)", () => {
    const content = readFile(".devpro/scripts/pre-pr-archive-gate.mjs");

    it("imports the shared lintProposalTasksChecked (DRY, one SSOT)", () => {
      assert.ok(
        content.includes("import { lintProposalTasksChecked }"),
        "pre-pr-archive-gate.mjs must import lintProposalTasksChecked — check (o) DRY reuse missing"
      );
    });

    it("has a check (o) block referencing the archived change folder", () => {
      assert.ok(
        content.includes("Pre-PR archive gate (o)"),
        "pre-pr-archive-gate.mjs must emit the '(o)' violation message — post-archive checkbox backstop missing"
      );
    });

    it("places (o) before the chore-A pass-through so B-mini (no specs) is still gated", () => {
      const idxO = content.indexOf("Pre-PR archive gate (o)");
      const idxChoreA = content.lastIndexOf("passArchiveGate('chore-A or no spec delta')");
      assert.ok(idxO !== -1 && idxChoreA !== -1, "both anchors must exist");
      assert.ok(
        idxO < idxChoreA,
        "check (o) must run BEFORE the `if (!anySpecsFound)` chore-A pass-through — otherwise B-mini (no specs/) exits before reaching (o)"
      );
    });
  });

  describe("R2 closing layer — code-review-checklist.md axis-1 sub-check", () => {
    const content = readFile(".devpro/agent-rules/code-review-checklist.md");

    it("axis 1 has a claimed-done vs checkbox+evidence consistency sub-check", () => {
      assert.ok(
        content.includes("Task 完成宣稱 vs checkbox+證據一致 sub-check"),
        "code-review-checklist.md axis 1 must have the '完成宣稱 vs checkbox+證據一致' sub-check — reviewer axis for checkbox drift missing"
      );
    });
  });

  describe("R3 gap 2 — /dp:pre-pr Step 5.5.2 pre-dispatch: no approval wait", () => {
    const content = readFile(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md");

    it("keeps the Step 5.5.2 pre-dispatch clause", () => {
      assert.ok(
        content.includes("Step 5.5.2"),
        ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md must keep a Step 5.5.2 pre-dispatch clause"
      );
    });

    it("no longer asks the user for an approval before dispatch", () => {
      assert.equal(
        content.includes("ExternalDisclosureApproval"),
        false,
        "pre-pr/SKILL.md must not carry the retired ExternalDisclosureApproval wait"
      );
    });
  });

  describe("R4 single-ledger contract — authoring carriers and enforcement stay aligned", () => {
    const proposalTemplate = readFile(".devpro/agent-rules/proposal-template.md");
    const quality = readFile(".devpro/agent-rules/openspec-quality-and-formats.md");
    const authoringSkill = readFile(".devpro/agent-skills/openspec/openspec-artifact-authoring/SKILL.md");
    // tasks.md ledger paragraph lives in references/full-analysis-and-design.md; read the full reading order.
    const changeSkill = readChangeSkillFullReadingOrder();
    // Full-rigor steps live in references/full-review-and-archive.md; read the full-rigor reading order.
    const prePrSkill = readPrePrSkillFullReadingOrder();
    const analyst = readFile(".claude/agents/dp-analyst.md");
    const architect = readFile(".claude/agents/dp-architect.md");
    const codeReview = readFile(".devpro/agent-rules/code-review-checklist.md");
    const delegation = readFile(".devpro/agent-rules/model-delegation.md");
    const delegationRules = readFile(".devpro/agent-rules/model-delegation-delegation-rules.md");
    const lint = readFile(".devpro/scripts/lint-proposal-tasks-checked.mjs");

    it("full proposal template requires tasks.md as the unique executable ledger", () => {
      assert.ok(
        proposalTemplate.includes("唯一 executable task ledger") &&
          proposalTemplate.includes("MUST NOT") &&
          proposalTemplate.includes("top-level task checkbox"),
        "proposal-template.md must forbid top-level task checkboxes in full proposal.md and point to the unique tasks.md ledger"
      );
    });

    it("quality rule identifies the canonical task-ledger artifact and keeps B-mini explicit", () => {
      assert.ok(
        quality.includes("canonical task-ledger artifact") &&
          quality.includes("B-mini") &&
          quality.includes("tasks.md") &&
          quality.includes("explicit `## Deferred`") &&
          quality.includes("Deferred 不授權第二份 ledger"),
        "openspec-quality-and-formats.md must define the full/B-mini canonical task-ledger split"
      );
    });

    it("authoring skill and architect handoff preserve the same full/B-mini role split", () => {
      for (const [carrier, content] of [["authoring skill", authoringSkill], ["dp-architect", architect]]) {
        assert.ok(
          content.includes("唯一 executable ledger") && content.includes("B-mini") && content.includes("tasks.md"),
          `${carrier} must state the single-ledger full/B-mini handoff contract`
        );
      }
    });

    it("delegation and devpro:change keep architect task planning as a tasks.md handoff", () => {
      assert.ok(
        delegation.includes("Task Outline handoff") &&
          delegation.includes("dp-architect MUST NOT把task rows寫入`proposal.md`") &&
          delegation.includes("TL / dp-assistant（tasks.md）"),
        "model-delegation.md must separate architect task-impact analysis from the tasks.md writer role"
      );
      const architectWritesTasks = /dp-architect[^\n]*寫入 `tasks\.md`/;
      assert.doesNotMatch(delegation, architectWritesTasks);
      assert.match("dp-architect 直接寫入 `tasks.md`", architectWritesTasks);
      assert.ok(
        changeSkill.includes("Task Outline handoff") &&
          changeSkill.includes("`proposal.md` Section 3") &&
          changeSkill.includes("MUST NOT contain task checkboxes"),
        "devpro:change architect dispatch must keep the full-change proposal non-executable and hand task rows to tasks.md"
      );
    });

    it("agent summaries and review routing name the canonical task-ledger artifact", () => {
      for (const [carrier, content] of [
        ["dp-analyst", analyst],
        ["dp-architect", architect],
        ["delegation rules", delegationRules],
      ]) {
        assert.ok(
          content.includes("Task Outline handoff"),
          `${carrier} must call architect task planning a Task Outline handoff, not proposal task rows`
        );
      }
      assert.ok(
        codeReview.includes("canonical task-ledger artifact（full=`tasks.md`；B-mini=`proposal-mini.md`）"),
        "code-review-checklist.md must route checkbox review to the full/B-mini canonical task-ledger artifact"
      );
    });

    it("shared lint exposes duplicate-ledger diagnostics and actionable remediation", () => {
      assert.ok(
        lint.includes("duplicate-ledger") &&
          lint.includes("extractDeferredSections(proposalContent)") &&
          lint.includes("proposal.md is not an executable task ledger") &&
          lint.includes("tasks.md"),
        "lint-proposal-tasks-checked.mjs must reject canonical/Deferred proposal task rows with actionable remediation"
      );
    });

    it("pre-PR workflow documents the same duplicate-ledger remediation", () => {
      assert.ok(
        prePrSkill.includes("Duplicate ledger") &&
          prePrSkill.includes("移到 `tasks.md`") &&
          prePrSkill.includes("non-executable pointer") &&
          prePrSkill.includes("每個 explicit `## Deferred` section"),
        "devpro:pre-pr must explain how to remediate a duplicate full-change ledger before archive"
      );
    });
  });

  // strengthen-evidence-reverifiability R3 — the 錨點 face of the same
  // §Tasks.md 品質要求 clause list this file already guards. `file:line` rots
  // inside the very change that writes it, so an evidence line anchored on a
  // line number cannot be re-verified afterwards by anyone without this
  // session's memory.
  describe("R3 evidence-anchor layer — 行號腐爛，錨在機械集合", () => {
    const content = readFile(".devpro/agent-rules/openspec-quality-and-formats.md");

    it("binds 行號腐爛 → MUST NOT 單獨作為錨點 → 機械集合 on one line", () => {
      const hits = operativeLines(
        content,
        /把證據行交給[^\n]*在同一個 change 內就會腐爛[^\n]*\*\*MUST NOT\*\* 單獨作為證據錨點[^\n]*MUST 改指向能重算它的機械集合/,
      );
      assert.equal(
        hits.length,
        1,
        "openspec-quality-and-formats.md 必須有且只有一行綁定 R3 錨點紀律（行號腐爛 + MUST NOT 單獨為錨 + 機械集合）",
      );
    });

    it("keeps the 時序 face routed to its sibling leaf so the two faces stay one rule", () => {
      const hits = operativeLines(
        content,
        /時序\*\*面（守門跑在非最終內容或未 commit 狀態上）[^\n]*openspec-quality-advanced-patterns\.md/,
      );
      assert.equal(
        hits.length,
        1,
        "錨點面 bullet 必須唯一指向 openspec-quality-advanced-patterns.md 的時序面，否則兩面散成無關兩條",
      );
    });
  });

  // fix-pre-pr-gate-mechanism-gaps T14 (Req: R7) — cross-carrier phrase-anchor
  // unification + evidence-durability guard. Bug #5's check (l) fix taught
  // pre-pr-archive-gate.mjs to accept proposal-mini.md as a tasks.md fallback,
  // but every OTHER carrier that states the bugfix-prove-it mandate still says
  // "tasks.md" only — a B-mini author reading any of them would believe no
  // prove-it task is required. Each assertion group below carries its own
  // RED/GREEN timing (see tasks.md T14 稽核記錄); groups are independent so a
  // partial sync (e.g. T15 landed, T16/T17/T18 not yet) reports per-group
  // pass/fail rather than one misleading aggregate.
  describe("T14 R7 cross-carrier anchor guard — proposal-mini.md phrase-anchor unification + :76 durability", () => {
    describe("(i-non-spec-a) proposal-mini.md same-sentence coverage — 3 non-spec, non-check(o) carriers (T15 turns green)", () => {
      const carriers = [
        {
          label: "openspec-quality-and-formats.md",
          relPath: ".devpro/agent-rules/openspec-quality-and-formats.md",
          expectedJointLines: 3,
        },
        {
          label: "openspec-flow-fallback.md",
          relPath: ".devpro/agent-rules/openspec-flow-fallback.md",
          expectedJointLines: 2,
        },
        {
          label: "openspec-artifact-authoring/SKILL.md",
          relPath: ".devpro/agent-skills/openspec/openspec-artifact-authoring/SKILL.md",
          expectedJointLines: 1,
        },
      ];

      for (const { label, relPath, expectedJointLines } of carriers) {
        it(`${label}: every bugfix-prove-it + tasks.md line also covers proposal-mini.md on the same line`, () => {
          const content = readFile(relPath);
          const proveItTasksLines = operativeLines(content, /(?=.*prove-it)(?=.*tasks\.md)/i);
          assert.equal(
            proveItTasksLines.length,
            expectedJointLines,
            `${label}: expected ${expectedJointLines} bugfix-prove-it + tasks.md line(s) — carrier shape changed since this test was written; re-verify before trusting the assertion below`,
          );
          const withProposalMini = operativeLines(content, /(?=.*prove-it)(?=.*tasks\.md)(?=.*proposal-mini)/i);
          assert.equal(
            withProposalMini.length,
            expectedJointLines,
            `${label}: every bugfix-prove-it + tasks.md line must also mention proposal-mini.md on the same line (R7 same-sentence anchor, per rule-anchor-guard-strength.md) — got ${withProposalMini.length}/${expectedJointLines}`,
          );
        });
      }
    });

    describe("(i-non-spec-b) pre-pr/SKILL.md check (o) blocking-reason enumeration (T15 turns green)", () => {
      it("check (o) bullet enumerates the 有 ledger 證據但 heading 非 canonical hard-fail reason", () => {
        // 第三點六步段 lives in references/full-review-and-archive.md; read the full-rigor reading order.
        const content = readPrePrSkillFullReadingOrder();
        const hits = operativeLines(content, /\(o\) Single-ledger.*有 ledger 證據但 heading 非 canonical/);
        assert.equal(
          hits.length,
          1,
          "pre-pr/SKILL.md check (o) 阻擋原因列舉必須新增「有 ledger 證據但 heading 非 canonical」一項——此為 T3/T4 已落地的 tasksBody===null 分支新 violation kind 之文件同步缺口（R1 doc-sync，與 proposal-mini.md 語意無關，故與 (i-non-spec-a) 分開個別驗證）",
        );
      });
    });

    describe("(i-scenario) scenario walkthrough B-mini fallback sync (deferred to T16, expected RED at T14/T15)", () => {
      // An existence-only `hits.length >= 1` check let a stale single-carrier
      // line hide behind one compliant line elsewhere in the file (round-6
      // Important #3: Context line 7 said tasks.md-only while Rule Walkthrough
      // lines 18-19 correctly said tasks.md-or-proposal-mini.md, and this test
      // still passed because SOME line had both). Scoped to everything before
      // "## Assertions" (that section legitimately quotes literal substrings
      // from other files verbatim and must not be forced to restate this
      // scenario's own carrier wording), every tasks.md-mentioning line must
      // now mention proposal-mini on the same line — not just one of them.
      it("every tasks.md-mentioning line before ## Assertions must also mention proposal-mini.md on the same line", () => {
        const content = readFile("scenarios/scenario-ab-source-repo-pre-pr-archive-gate.md");
        const preAssertions = content.split(/^## Assertions/m)[0];
        const tasksLines = operativeLines(preAssertions, /tasks\.md/);
        const jointLines = operativeLines(preAssertions, /(?=.*tasks\.md)(?=.*proposal-mini)/i);
        assert.ok(
          tasksLines.length >= 1,
          "expected at least one tasks.md-mentioning line before ## Assertions in scenario-ab-source-repo-pre-pr-archive-gate.md — scenario shape changed since this test was written; re-verify before trusting the assertion below",
        );
        assert.equal(
          jointLines.length,
          tasksLines.length,
          `every tasks.md-mentioning line in scenario-ab-source-repo-pre-pr-archive-gate.md before ## Assertions (Context／Rule Walkthrough／Negative Checks) must also mention proposal-mini.md on the same line (B-mini fallback, T16 scope) — got ${jointLines.length}/${tasksLines.length} joint lines`,
        );
      });
    });

    describe("(i-spec) archive-tooling + openspec-flow canonical spec sync (deferred to T17/T18, expected RED at T14/T15)", () => {
      it("archive-tooling/spec.md 的 check (l) 條文涵蓋 tasks.md-或-proposal-mini.md 有序候選", () => {
        const content = readFile("openspec/specs/archive-tooling/spec.md");
        const hits = operativeLines(content, /Check \(l\).*tasks\.md.*proposal-mini/);
        assert.ok(
          hits.length >= 1,
          "openspec/specs/archive-tooling/spec.md 的 check (l) requirement 正文必須涵蓋 tasks.md-或-proposal-mini.md 有序候選措辭（T17 scope）——目前預期 RED，待 T17 完成後轉綠",
        );
      });

      it("openspec-flow/spec.md 的 bugfix prove-it THEN 子句涵蓋 proposal-mini.md inline Tasks", () => {
        const content = readFile("openspec/specs/openspec-flow/spec.md");
        const hits = operativeLines(
          content,
          /THEN.*tasks\.md MUST include at least one prove-it test task.*proposal-mini/i,
        );
        assert.ok(
          hits.length >= 1,
          "openspec/specs/openspec-flow/spec.md 的 bugfix prove-it THEN 子句必須涵蓋 proposal-mini.md inline ## Tasks（T18 scope）——目前預期 RED，待 T18 完成後轉綠",
        );
      });
    });

    describe("(ii) pre-pr-archive-gate.mjs — stale openspec-quality-and-formats.md:76 references removed (T15 turns green)", () => {
      it("contains zero remaining :76 line-number references (guard scoped to :76 only, not check (j)'s :63)", () => {
        const content = readFile(".devpro/scripts/pre-pr-archive-gate.mjs");
        const hits = operativeLines(content, /openspec-quality-and-formats\.md:76/);
        assert.equal(
          hits.length,
          0,
          `pre-pr-archive-gate.mjs 不得再含任何 openspec-quality-and-formats.md:76 行號引用（evidence-durability：file:line 在同一 change 內就會腐爛）——目前命中 ${hits.length} 處，T15 完成後應為 0`,
        );
      });

      it("check (j)'s shared-validator source reference remains explicit", () => {
        const content = readFile(".devpro/scripts/pre-pr-archive-gate.mjs");
        const hits = operativeLines(content, /openspec-quality-doc-formats\.md §brd\.md。/);
        assert.equal(
          hits.length,
          1,
          "pre-pr-archive-gate.mjs check (j) 經 shared BRD validator 收斂後仍須保留一處可操作的來源指引（openspec-quality-doc-formats.md §brd.md；寫章節不寫行號）",
        );
      });
    });

    describe("(iii-control) pre-pr-archive-gate.mjs check (l) 已於 T13 涵蓋 tasks.md-或-proposal-mini.md 措辭（regression lock，全程維持綠，非 RED→GREEN 序列的一員）", () => {
      it("check (l) stderr 仍保留兩處 tasks.md（或 B-mini 的 proposal-mini.md）同句措辭", () => {
        const content = readFile(".devpro/scripts/pre-pr-archive-gate.mjs");
        const hits = operativeLines(content, /tasks\.md（或 B-mini 的 proposal-mini\.md/);
        assert.equal(
          hits.length,
          2,
          "pre-pr-archive-gate.mjs check (l) 必須保留兩處 T13 已落地的「tasks.md（或 B-mini 的 proposal-mini.md）」同句措辭——這是迴歸鎖，非待修項；T15 編輯同檔 :76 引用時不得意外破壞它",
        );
      });
    });
  });

  // strengthen-tasks-evidence-currency T3 (Req: R3) — anchor guard for the
  // evidence-line carriers: the §Tasks.md 品質要求 證據行表徵 clause (SSOT for
  // R1), its §證據時序 pointer in openspec-quality-advanced-patterns.md (DRY
  // direction) and the devpro:pre-pr Final-tree freeze sub-check (R2). Polarity-
  // sensitive anchors bind the polarity word + 受詞 on ONE physical line with
  // compound regexes and count the matching lines (rule-anchor-guard-strength.md);
  // no compensatory alternation — every core 受詞 is a required token.
  describe("T3 R3 evidence-line-representation anchor guard — SSOT compound + freeze-section position + DRY reverse", () => {
    const FORBIDDEN_MUST_COPY = "MUST NOT 內嵌";

    // 缺席軸雙向常駐 fixture（rule-anchor-guard-strength.md §驗證方法）：forbidden
    // 側沒有刪除審計可用，改以「正例＝真實殘留原文／反例＝必須放行的正當 pointer
    // 行」釘死 marker。marker 改窄 → 正例漏放轉紅；改寬 → 反例誤傷轉紅。
    // Markdown emphasis is stripped first: house style bolds only the polarity
    // word (`**MUST NOT** 內嵌…`), which the bare literal would otherwise miss.
    function hasForbiddenMustCopy(text) {
      return text.replace(/\*/g, "").includes(FORBIDDEN_MUST_COPY);
    }

    // DRY 反向 marker：SSOT 允許載體清單的副本（freeze 子檢查＝中文、canonical
    // scenario＝英文）。與 hasForbiddenMustCopy 同樣以常駐雙向 fixture 釘死。
    const FREEZE_CARRIER_COPY = "可重跑命令／test 名／grep 字面";
    function hasFreezeCarrierCopy(text) {
      return text.includes(FREEZE_CARRIER_COPY);
    }
    const SCENARIO_CARRIER_COPY = /command, test name, or grep literal/;
    function hasScenarioCarrierCopy(text) {
      return SCENARIO_CARRIER_COPY.test(text);
    }

    // 收據欄位值內嵌 marker：動作點指引只能寫收據路徑＋欄位名，寫出欄位值
    // （`status=pass`、`fail`＝0）即違反 SSOT 的 MUST NOT 內嵌。
    const INLINE_RECEIPT_VALUE = /(?:suite_evidence\.status|\bfail)`?\s*[=＝]\s*`?(?:pass|fail|\d)/;
    function hasInlineReceiptValue(text) {
      return INLINE_RECEIPT_VALUE.test(text);
    }

    // 段落切片：heading 行起、至下一個 `#{1,3} ` heading（無 → EOF）。
    function sliceSection(content, heading) {
      const startIdx = content.indexOf(heading);
      assert.notEqual(startIdx, -1, `必須有 ${heading} 段`);
      assert.ok(
        startIdx === 0 || content[startIdx - 1] === "\n",
        `${heading} 必須是行首 heading（避免匹配到內文引用而非真段頭）`
      );
      const rest = content.slice(startIdx + heading.length);
      const nextHeading = /\n#{1,3} /.exec(rest);
      return nextHeading ? rest.slice(0, nextHeading.index) : rest;
    }

    it("absent-axis fixture: marker catches the real residue and does not misfire on the legit pointer line", () => {
      // 正例：自 SSOT 條文取樣的真實殘留原文（同一 change 內漂移值的內嵌寫法）
      const staleCopySample =
        "**MUST NOT 內嵌**會隨本 change 後續 commit 漂移的量測值——canonical scenario 計數、suite pass／fail 計數、tip／HEAD SHA";
      assert.equal(
        hasForbiddenMustCopy(staleCopySample),
        true,
        "forbidden-copy marker 必須能命中真實殘留原文——marker 被改窄／漂移即漏放，guard 空轉"
      );
      // 正例二：house-style 只加粗極性詞的自然改寫
      const houseStyleCopySample =
        "**MUST NOT** 內嵌會隨本 change 後續 commit 漂移的量測值";
      assert.equal(
        hasForbiddenMustCopy(houseStyleCopySample),
        true,
        "forbidden-copy marker 必須命中 house-style `**MUST NOT** 內嵌` 寫法——未去除強調標記即漏放"
      );
      // 反例：正當 pointer 行原文（含「內嵌」二字但無極性禁令）——marker 改寬即誤傷
      const legitPointerSample =
        "**證據行表徵（pointer）**：內嵌於證據行、會隨後續 commit 漂移的量測值同受 currency 約束；表徵規則 SSOT 見 `openspec-quality-and-formats.md` §Tasks.md 品質要求，本節只承擔時序面、不複寫該條文。";
      assert.equal(
        hasForbiddenMustCopy(legitPointerSample),
        false,
        "forbidden-copy marker 不得誤傷正當 pointer 行（含『內嵌』但無極性禁令）——marker 被改寬即誤傷合法內容"
      );
    });

    it("absent-axis fixture: carrier-copy markers catch the r1 residue and do not misfire on the compliant lines", () => {
      // 正例：r1 審查時實際存在的副本原文（freeze remedy／scenario THEN 括號）
      const freezeResidueSample =
        "引用了會隨本 change 後續 commit 漂移的量測值者（例：suite pass／fail 計數、tip／HEAD SHA；非窮舉），改引收據名＋穩定欄位或可重跑命令／test 名／grep 字面";
      assert.equal(
        hasFreezeCarrierCopy(freezeResidueSample),
        true,
        "freeze carrier-copy marker 必須命中 r1 殘留原文——marker 被改窄／漂移即漏放，guard 空轉"
      );
      const scenarioResidueSample =
        "- **THEN** the line MUST represent its evidence through a receipt name with stable fields or through a carrier that can be re-run later (a command, test name, or grep literal), so the evidence stays independently verifiable after subsequent commits";
      assert.equal(
        hasScenarioCarrierCopy(scenarioResidueSample),
        true,
        "scenario carrier-copy marker 必須命中 r1 殘留原文——marker 被改窄／漂移即漏放，guard 空轉"
      );
      // 反例：現行合規行（指回 SSOT、不列舉載體）——marker 改寬即誤傷
      const freezeCompliantSample =
        "  - **Tasks 證據行 currency 重核**（具名子檢查）：對 canonical ledger 每條 `[x]` 證據行在 committed HEAD 重讀一次，依 `openspec-quality-and-formats.md` §Tasks.md 品質要求 證據行表徵條（SSOT；漂移類別與不可變歷史 commit 引用免責以該條為準）判定——引用了會隨本 change 後續 commit 漂移的量測值者（例：suite pass／fail 計數、tip／HEAD SHA；非窮舉），改寫為該條允許的表徵；suite 證據以 `notes/qa-regression-head-<change>.json` 為準（只引收據路徑與穩定欄位名，例：`suite_evidence.status`／`suite_evidence.fail`，不寫欄位值；currency 由 gate 斷言），不得自抄數字。每次 remediation 批次後隨 freeze 重入。";
      assert.equal(
        hasFreezeCarrierCopy(freezeCompliantSample),
        false,
        "freeze carrier-copy marker 不得誤傷現行合規子檢查行——marker 被改寬即誤傷合法內容"
      );
      const scenarioCompliantSample =
        "- **THEN** the line MUST use an evidence representation permitted by the evidence-line representation clause in `.devpro/agent-rules/openspec-quality-and-formats.md` §Tasks.md 品質要求, so the evidence stays independently verifiable after subsequent commits";
      assert.equal(
        hasScenarioCarrierCopy(scenarioCompliantSample),
        false,
        "scenario carrier-copy marker 不得誤傷現行合規 THEN 行——marker 被改寬即誤傷合法內容"
      );
    });

    it("absent-axis fixture: inline-receipt-value marker catches the cross-review residue and does not misfire on field-name-only lines", () => {
      // 正例：cross-model review 抓到的真實殘留原文（freeze 指引／T4 證據行）
      const freezeValueSample =
        "suite 證據以 `notes/qa-regression-head-<change>.json` 為準（引用其穩定欄位，例：`suite_evidence.status=pass`／`fail=0`；currency 由 gate 斷言）";
      assert.equal(
        hasInlineReceiptValue(freezeValueSample),
        true,
        "inline-receipt-value marker 必須命中 freeze 指引殘留原文——marker 被改窄即漏放"
      );
      const ledgerValueSample =
        "suite 以 `notes/qa-regression-head-strengthen-tasks-evidence-currency.json` 的 `suite_evidence.status`＝pass／`fail`＝0 為準";
      assert.equal(
        hasInlineReceiptValue(ledgerValueSample),
        true,
        "inline-receipt-value marker 必須命中全形等號的證據行殘留原文——marker 被改窄即漏放"
      );
      // 反例：只寫欄位名的合規行（現行 freeze 指引、SSOT exemplar）——marker 改寬即誤傷
      const fieldNameOnlySample =
        "suite 證據以 `notes/qa-regression-head-<change>.json` 為準（只引收據路徑與穩定欄位名，例：`suite_evidence.status`／`suite_evidence.fail`，不寫欄位值；currency 由 gate 斷言），不得自抄數字。";
      assert.equal(
        hasInlineReceiptValue(fieldNameOnlySample),
        false,
        "inline-receipt-value marker 不得誤傷只寫欄位名的合規 freeze 指引——marker 被改寬即誤傷合法內容"
      );
      const ssotExemplarSample =
        "例如 `notes/qa-regression-head-<change>.json` 的 `suite_evidence.status`／`fail`（currency 由收據自身維護、由既有 regression-head currency gate 斷言）";
      assert.equal(
        hasInlineReceiptValue(ssotExemplarSample),
        false,
        "inline-receipt-value marker 不得誤傷 SSOT exemplar（欄位名、無值）——marker 被改寬即誤傷合法內容"
      );
    });

    it("openspec-quality-and-formats.md: 極性詞＋受詞＋exemplar 收據名＋不可變歷史 commit 引用免責同一物理行（唯一命中）", () => {
      const section = sliceSection(
        readFile(".devpro/agent-rules/openspec-quality-and-formats.md"),
        "### Tasks.md 品質要求"
      );
      const hits = operativeLines(
        section,
        /量測值類證據[^\n]*MUST 以收據名／穩定欄位表徵[^\n]*或引可重跑命令／test 名／grep 字面[^\n]*notes\/qa-regression-head-<change>\.json[^\n]*MUST NOT 內嵌[^\n]*量測值[^\n]*canonical scenario 計數[^\n]*suite pass／fail 計數[^\n]*tip／HEAD SHA[^\n]*其後僅 markdown 變更[^\n]*不可變歷史 commit 引用[^\n]*不在此限[^\n]*補充（不取代）[^\n]*本條為證據行表徵規則的 SSOT[^\n]*僅得放 pointer/
      );
      assert.equal(
        hits.length,
        1,
        "openspec-quality-and-formats.md §Tasks.md 品質要求 證據行表徵條必須恰有一行同時綁定 量測值類證據 MUST 以收據名／穩定欄位表徵＋可重跑載體替代＋exemplar 收據名＋MUST NOT 內嵌＋四類漂移受詞＋不可變歷史引用免責（不在此限）＋補充（不取代）既有錨點＋SSOT 宣告＋僅得放 pointer——缺一即弱化，移出該段即 pointer 懸空，多一行全文副本即漂移"
      );
    });

    it("pre-pr/SKILL.md: `Tasks 證據行 currency 重核` 恰一次且落在 Final-tree freeze 段內", () => {
      // Final-tree freeze (第三步) lives in references/full-review-and-archive.md; read the full-rigor reading order.
      const content = readPrePrSkillFullReadingOrder();
      const literal = "Tasks 證據行 currency 重核";
      assert.equal(
        content.split(literal).length - 1,
        1,
        ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md 必須恰有一處 `Tasks 證據行 currency 重核` 字面（T2 子檢查；`grep -c -F`＝1 條件）"
      );
      const startMarker = "**Final-tree freeze（MUST）**";
      const endMarker = "**Pre-first-review artifact checklist";
      const startIdx = content.indexOf(startMarker);
      const endIdx = content.indexOf(endMarker, startIdx === -1 ? 0 : startIdx + startMarker.length);
      assert.ok(startIdx !== -1, `freeze 段起點 ${startMarker} 必須存在`);
      assert.ok(endIdx > startIdx, `freeze 段終點 ${endMarker} 必須存在且落在起點之後`);
      const freezeSection = content.slice(startIdx, endIdx);
      assert.ok(
        freezeSection.includes(literal),
        "`Tasks 證據行 currency 重核` 必須落在 Final-tree freeze 段（heading → Pre-first-review artifact checklist 邊界切片）內——移到段外即失去『派工前重核』的時機語意"
      );
      // DRY 方向：子檢查行 MUST 指回 SSOT，不得自帶一份窮舉類別清單（副本會與 SSOT 漂移）。
      const pointerHits = operativeLines(
        freezeSection,
        /Tasks 證據行 currency 重核[^\n]*openspec-quality-and-formats\.md[^\n]*§Tasks\.md 品質要求[^\n]*SSOT/
      );
      assert.equal(
        pointerHits.length,
        1,
        "`Tasks 證據行 currency 重核` 子檢查行必須同一物理行指回 `openspec-quality-and-formats.md` §Tasks.md 品質要求（SSOT）——拿掉 pointer 即變成無出處的第二副本"
      );
      assert.equal(
        hasInlineReceiptValue(freezeSection),
        false,
        "freeze 段指引只能寫收據路徑＋欄位名，不得寫出欄位值（`status=pass`／`fail=0`）——指引自己內嵌值即與 SSOT 的 MUST NOT 內嵌矛盾"
      );
      assert.equal(
        hasFreezeCarrierCopy(freezeSection),
        false,
        "freeze 段不得複寫 SSOT 的允許載體清單（`可重跑命令／test 名／grep 字面`）——改 SSOT 載體集合時副本會無聲漂移"
      );
    });

    it("openspec-flow canonical scenario defers to the SSOT clause without enumerating carriers (DRY 反向)", () => {
      const content = readFile("openspec/specs/openspec-flow/spec.md");
      const title = "#### Scenario: Evidence Lines Stay Verifiable Across Later Commits";
      const startIdx = content.indexOf(title);
      assert.notEqual(startIdx, -1, `canonical openspec-flow 必須有 ${title}`);
      const rest = content.slice(startIdx + title.length);
      const next = /\n#{1,4} /.exec(rest);
      const block = next ? rest.slice(0, next.index) : rest;
      assert.equal(
        operativeLines(block, /THEN[^\n]*permitted by the evidence-line representation clause[^\n]*openspec-quality-and-formats\.md[^\n]*§Tasks\.md 品質要求/).length,
        1,
        "scenario THEN 必須同一行以 SSOT 條（openspec-quality-and-formats.md §Tasks.md 品質要求）為準"
      );
      assert.equal(
        hasScenarioCarrierCopy(block),
        false,
        "scenario 不得複寫 SSOT 的允許載體清單——改 SSOT 載體集合時副本會無聲漂移"
      );
    });

    it("openspec-quality-advanced-patterns.md §證據時序: pointer 存在＋不複寫 MUST NOT 內嵌（DRY 反向）", () => {
      const content = readFile(".devpro/agent-rules/openspec-quality-advanced-patterns.md");
      const heading = "### 證據時序";
      const startIdx = content.indexOf(heading);
      assert.notEqual(startIdx, -1, `openspec-quality-advanced-patterns.md 必須有 ${heading} 段`);
      assert.ok(
        startIdx === 0 || content[startIdx - 1] === "\n",
        `${heading} 必須是行首 heading（避免匹配到內文引用而非真段頭）`
      );
      const rest = content.slice(startIdx + heading.length);
      // terminator＝下一個同級或更高級 heading（`#{1,3} `），無 → EOF（有限集合取 min）
      const nextHeading = /\n#{1,3} /.exec(rest);
      const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
      const pointerHits = operativeLines(
        section,
        /證據行表徵（pointer）[^\n]*openspec-quality-and-formats\.md[^\n]*§Tasks\.md 品質要求[^\n]*不複寫/
      );
      assert.equal(
        pointerHits.length,
        1,
        "§證據時序 必須恰有一行 pointer：同句綁『證據行表徵（pointer）』＋SSOT 指向 `openspec-quality-and-formats.md` §Tasks.md 品質要求＋不複寫"
      );
      assert.equal(
        hasForbiddenMustCopy(section),
        false,
        "§證據時序 不得出現 `MUST NOT 內嵌` 字面——MUST 只留在 formats SSOT，pointer 段複寫即第二副本漂移源（DRY 方向）"
      );
    });
  });
});
