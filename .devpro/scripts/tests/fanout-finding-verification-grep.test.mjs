/**
 * fanout-finding-verification-grep.test.mjs
 *
 * Guards the Finding Verification enforcement anchors added by
 * chore/strengthen-fanout-finding-verification (review finding #4).
 *
 * Gap closed: Artifact Landing Verification only verifies that a subagent's
 * claimed FILES landed (`git status` / `test -f` / `git diff`); it never
 * verifies the CONTENT/JUDGMENT of an analytical finding. Fan-out audit/review/
 * explore agents produce false-positive findings (e.g. flagging a compliant
 * load-chain sibling as an orphan, reporting an existing file as "missing").
 * The "claim = hypothesis, re-verify at source" principle existed only in
 * pr-review-evidence-verification.md (PR-review scope). This change generalizes
 * it to ANY fan-out subagent finding via multi-agent-handoff.md §Finding
 * Verification, cross-referenced from rule-audit-playbook.md Fan-out execution.
 *
 * Removing any anchor silently reopens the gap → this test goes red.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
function readFile(relPath) {
  return readFileSync(repoPath(relPath), "utf8");
}

describe("fanout-finding-verification-grep", () => {
  describe("multi-agent-handoff.md §Finding Verification", () => {
    const content = readFile(".devpro/agent-rules/multi-agent-handoff.md");

    it("contains the 'Finding Verification' section heading", () => {
      assert.ok(
        content.includes("### Finding Verification"),
        "multi-agent-handoff.md must contain '### Finding Verification' — the fan-out finding content-verification section is missing"
      );
    });

    it("mandates re-verifying findings at source before acting (回源核對 / 逐項)", () => {
      assert.ok(
        /回源/.test(content) && /逐項/.test(content),
        "multi-agent-handoff.md Finding Verification must require per-item re-verification at source (回源核對 / 逐項) — anchor missing"
      );
    });

    it("treats subagent finding narration as hypothesis, not evidence", () => {
      assert.ok(
        content.includes("hypothesis"),
        "multi-agent-handoff.md Finding Verification must mark subagent finding narration as hypothesis (not evidence) — anchor missing"
      );
    });

    it("generalizes the PR-review evidence principle beyond PR review", () => {
      assert.ok(
        content.includes("pr-review-evidence-verification.md"),
        "multi-agent-handoff.md Finding Verification must cross-reference pr-review-evidence-verification.md (same principle, wider scope) — anchor missing"
      );
    });
  });

  describe("rule-audit-playbook.md Fan-out execution cross-reference", () => {
    const content = readFile(".devpro/agent-rules/rule-audit-playbook.md");

    it("routes synthesize-time finding verification to the handoff clause", () => {
      assert.ok(
        content.includes("Finding Verification") && /回源/.test(content),
        "rule-audit-playbook.md Fan-out execution must require synthesize-time 回源 verification and point to multi-agent-handoff.md §Finding Verification — anchor missing"
      );
    });
  });

  // Guards the mature-corpus sim FP taxonomy added by
  // chore/add-audit-sim-fp-taxonomy (convergence-loop Round 1-4 evidence).
  // The four systematic FP classes are an actionable identification checklist
  // applied AT the Fan-out 回源 gate: each class carries a "先確認 X" action so
  // TL rejects the FP instead of merely recognizing it. Removing any anchor
  // reopens the gap where sim narration hallucinations enter the disposition
  // ledger → this test goes red.
  describe("rule-audit-playbook.md mature-corpus sim FP taxonomy", () => {
    const content = readFile(".devpro/agent-rules/rule-audit-playbook.md");

    it("declares mature-corpus sim FP rate is near-total (減 sim, 移機械掃描)", () => {
      assert.ok(
        /成熟 corpus/.test(content) && /FP/.test(content) && /近 100%|近乎 100%|接近 100%/.test(content),
        "rule-audit-playbook.md must declare mature-corpus sim FP rate is near-total — 邊際遞減 anchor missing"
      );
    });

    it("carries a marginal-return steer: reduce sim, shift to mechanical scan", () => {
      assert.ok(
        /減\s*sim/.test(content) && /機械掃描/.test(content),
        "rule-audit-playbook.md must steer mature corpus to reduce sim headcount and shift effort to mechanical scan — configuration anchor missing"
      );
    });

    it("anchors class ① responsibility layering mistaken for missing impl", () => {
      assert.ok(
        /責任分層/.test(content) && /他檔|他層/.test(content),
        "rule-audit-playbook.md must anchor FP class ① 責任分層 → 誤判缺實作 (先確認他檔/他層是否承擔) — anchor missing"
      );
    });

    it("anchors class ② orthogonal cross-file conditions mistaken for conflict", () => {
      assert.ok(
        /正交/.test(content) && /互斥|不同時/.test(content),
        "rule-audit-playbook.md must anchor FP class ② 跨檔正交條件 → 誤判衝突 (先確認互斥情境/不同時發生) — anchor missing"
      );
    });

    it("anchors class ③ unified-design shared step mistaken for missing step", () => {
      assert.ok(
        /共用步驟|共用同一份/.test(content) && /缺步/.test(content),
        "rule-audit-playbook.md must anchor FP class ③ 統一設計共用步驟 → 誤判缺步 — anchor missing"
      );
    });

    it("anchors class ④ principle-based judgment mistaken for missing decision tree", () => {
      assert.ok(
        /原則式/.test(content) && /決策樹/.test(content),
        "rule-audit-playbook.md must anchor FP class ④ 原則式判準 → 誤判缺決策樹 — anchor missing"
      );
    });

    it("binds the taxonomy to the Fan-out 回源 gate as an actionable checklist", () => {
      // Token MUST be unique to the new taxonomy block. A looser regex like
      // /(套用|MUST).*回源/ is satisfied by the pre-existing Fan-out 執行 line
      // ("MUST ... 逐項回源核對"), making this a false-green: the block could be
      // removed and this anchor would stay green. "命中即駁回" appears only in the
      // taxonomy block's reject-action wording, so it goes red if the block dies.
      assert.ok(
        /命中即駁回/.test(content),
        "rule-audit-playbook.md FP taxonomy must be applied AT the Fan-out 回源 gate (命中即駁回, not just described) — action-binding anchor missing"
      );
    });
  });
});
