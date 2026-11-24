/**
 * subagent-execution-location-anchor-grep.test.mjs
 *
 * Asserts that the "執行位置" (execution location) enforcement anchors exist in
 * the four files modified by fix-session-audit-enforcement-gaps (gap #3):
 *
 *   - model-delegation-briefing.md → briefing template contains `working_directory`
 *     (rationalize-overbundled-entry-leaves T1: Briefing template moved from
 *     model-delegation.md to the on-demand sibling model-delegation-briefing.md)
 *   - multi-agent-handoff.md      → contains `執行位置回報` (mandatory reporting section)
 *   - .claude/agents/dp-assistant.md → output schema contains `執行位置`
 *   - .claude/agents/dp-programmer.md → output schema contains `執行位置`
 *
 * Removing any anchor would silently break the enforcement contract.
 *
 * Related: T6 of openspec/changes/fix-session-audit-enforcement-gaps/proposal.md
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
function readFile(relPath) {
  return readFileSync(repoPath(relPath), "utf8");
}

describe("subagent-execution-location-anchor-grep", () => {
  // rationalize-overbundled-entry-leaves T1: Briefing template moved from
  // model-delegation.md to model-delegation-briefing.md (on-demand sibling).
  // Assertions repointed to the sibling file where the content now lives.
  describe("model-delegation-briefing.md briefing template", () => {
    it("contains 'working_directory' in dp-programmer briefing", () => {
      const content = readFile(".devpro/agent-rules/model-delegation-briefing.md");
      assert.ok(
        content.includes("working_directory"),
        "model-delegation-briefing.md must contain 'working_directory' in briefing template — anchor missing"
      );
    });

    it("contains 'working_directory' at least twice (both dp-programmer and dp-assistant templates)", () => {
      const content = readFile(".devpro/agent-rules/model-delegation-briefing.md");
      const count = (content.match(/working_directory/g) || []).length;
      assert.ok(
        count >= 2,
        `model-delegation-briefing.md should have 'working_directory' in both briefing templates, found ${count} occurrence(s)`
      );
    });
  });

  describe("multi-agent-handoff.md execution location reporting", () => {
    it("contains '執行位置回報' section heading", () => {
      const content = readFile(".devpro/agent-rules/multi-agent-handoff.md");
      assert.ok(
        content.includes("執行位置回報"),
        "multi-agent-handoff.md must contain '執行位置回報' — mandatory execution location reporting section missing"
      );
    });

    it("contains '執行位置' string (broader anchor)", () => {
      const content = readFile(".devpro/agent-rules/multi-agent-handoff.md");
      assert.ok(
        content.includes("執行位置"),
        "multi-agent-handoff.md must contain '執行位置' — anchor missing"
      );
    });
  });

  describe("dp-assistant.md output schema", () => {
    it("contains '執行位置' in output schema", () => {
      const content = readFile(".claude/agents/dp-assistant.md");
      assert.ok(
        content.includes("執行位置"),
        ".claude/agents/dp-assistant.md output schema must contain '執行位置' — anchor missing"
      );
    });
  });

  describe("dp-programmer.md output schema", () => {
    it("contains '執行位置' in output schema", () => {
      const content = readFile(".claude/agents/dp-programmer.md");
      assert.ok(
        content.includes("執行位置"),
        ".claude/agents/dp-programmer.md output schema must contain '執行位置' — anchor missing"
      );
    });
  });
});
