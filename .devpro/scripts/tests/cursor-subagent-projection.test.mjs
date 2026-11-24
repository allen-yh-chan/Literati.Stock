import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SUBAGENT_BEHAVIORAL_CONTRACTS } from "../subagent-behavioral-contracts.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const CURSOR_AGENTS = {
  "dp-analyst": {
    statuses: ["finished", "failed", "questions"],
    readOnly: false,
  },
  "dp-architect": {
    statuses: ["finished", "questions", "failed"],
    readOnly: false,
  },
  "dp-programmer": {
    statuses: ["finished", "failed", "partial"],
    readOnly: false,
  },
  "dp-assistant": {
    statuses: ["finished", "failed", "partial"],
    readOnly: false,
  },
  "dp-reviewer": {
    statuses: ["finished", "blocked", "partial"],
    readOnly: true,
  },
  "dp-explorer": {
    statuses: [],
    readOnly: true,
  },
  "dp-second-reviewer": {
    statuses: ["finished", "blocked", "partial"],
    readOnly: true,
  },
};

const REQUIRED_SSOT = [
  ".devpro/agent-rules/model-delegation.md",
  ".devpro/agent-rules/multi-agent-handoff.md",
];

function cursorAgentPath(agentName) {
  return `.cursor/agents/${agentName}.md`;
}

function readCursorAgent(agentName) {
  return read(cursorAgentPath(agentName));
}

function frontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "Cursor agent must start with YAML frontmatter");
  const result = {};
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^([a-z_]+):\s*(.*)$/);
    if (pair) result[pair[1]] = pair[2].replace(/^"|"$/g, "");
  }
  return result;
}

describe("cursor-subagent-projection", () => {
  describe("Cursor custom agent files exist and use required frontmatter fields", () => {
    for (const [agentName, { readOnly }] of Object.entries(CURSOR_AGENTS)) {
      it(`${cursorAgentPath(agentName)} defines a project-scoped custom agent`, () => {
        const content = readCursorAgent(agentName);
        const fm = frontmatter(content);
        assert.equal(fm.name, agentName);
        assert.ok(fm.description, `${agentName} missing description`);
        assert.equal(fm.read_only, String(readOnly));
        assert.equal(fm.is_background, "false");
        if (agentName === "dp-second-reviewer") {
          assert.match(
            content,
            /\.devpro\/agent-skills\/devpro-reviews\/second-review\/SKILL\.md/,
            "dp-second-reviewer must cite the common devpro:second-review skill SSOT"
          );
          assert.match(content, /platform-adapters\/cursor\.md/);
          assert.match(content, /\.devpro\/agent-skills-refs\/autonomous-ai-agents\/codex\/SKILL\.md/);
          assert.match(content, /\.devpro\/agent-skills-refs\/autonomous-ai-agents\/claude-code\/SKILL\.md/);
          assert.doesNotMatch(
            content,
            /\.claude\/agents\/dp-second-reviewer\.md/,
            "Cursor dp-second-reviewer must not route through the Claude projection"
          );
        } else {
          assert.match(
            content,
            new RegExp(`\\.claude/agents/${agentName}\\.md`),
            `${agentName} must cite the Claude projection path`
          );
        }
      });
    }
  });

  describe("Cursor projections cite shared SSOT files", () => {
    for (const agentName of Object.keys(CURSOR_AGENTS)) {
      it(`${agentName} cites model delegation and handoff SSOT`, () => {
        const content = readCursorAgent(agentName);
        for (const ssot of REQUIRED_SSOT) {
          assert.match(content, new RegExp(ssot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
        assert.match(
          content,
          /projection, not SSOT|projection only|投影，不是 SSOT|投影，非 SSOT/i,
          `${agentName} must state that runtime files are projections, not SSOT`
        );
      });
    }
  });

  describe("Cursor projections preserve canonical status subsets", () => {
    for (const [agentName, { statuses }] of Object.entries(CURSOR_AGENTS)) {
      it(`${agentName} includes its canonical terminal status subset`, () => {
        const content = readCursorAgent(agentName);
        for (const status of statuses) {
          assert.match(
            content,
            new RegExp(`\\b${status}\\b`),
            `${agentName} missing canonical status ${status}`
          );
        }
      });
    }
  });

  describe("Cursor projections preserve behavioral anchor phrases", () => {
    for (const contract of SUBAGENT_BEHAVIORAL_CONTRACTS) {
      it(`${contract.subagent}.md contains shared behavioral anchors`, () => {
        const content = readCursorAgent(contract.subagent);
        const missing = contract.mustInclude.filter((phrase) => !content.includes(phrase));
        assert.deepEqual(
          missing,
          [],
          `${cursorAgentPath(contract.subagent)} missing behavioral anchors: ${missing.join(", ")}`
        );
      });
    }
  });

  describe("Cursor projections use bounded write permissions", () => {
    for (const [agentName, { readOnly }] of Object.entries(CURSOR_AGENTS)) {
      it(`${agentName} read_only = ${readOnly}`, () => {
        const content = readCursorAgent(agentName);
        const fm = frontmatter(content);
        assert.equal(fm.read_only, String(readOnly));
      });
    }
  });

  // ── Negative assertions: status-context aware (spec line 45, NFR2 cursor parity) ─
  // Extract the terminal status declaration line from a Cursor MD agent.
  // Cursor agents declare status in ## Terminal Status section via "只能使用：<enums>" line.
  // For dp-second-reviewer the following line adds "Sticky verdict 必須是 PASS/…";
  // we extract only the 只能使用 line to isolate the terminal-status segment.
  function extractCursorStatusContext(content) {
    const m = content.match(/只能使用：([^\n]+)/);
    return m ? m[1] : null;
  }

  // Individual legacy terminal status terms that must NOT appear in status context.
  // Source: subagent-status-vocabulary.test.mjs LEGACY_STATUS_ENUMS vocabulary.
  const CURSOR_LEGACY_STATUS_TERMS = ["DONE", "FAIL", "PASS", "OK", "PARTIAL", "QUESTIONS", "BLOCK"];

  // Five canonical terminal status terms.
  const ALL_CANONICAL_TERMS = ["finished", "blocked", "failed", "questions", "partial"];

  describe("Cursor projections reject legacy + out-of-subset status terms (spec line 45)", () => {
    for (const [agentName, { statuses }] of Object.entries(CURSOR_AGENTS)) {
      if (statuses.length === 0) continue; // dp-explorer declares no terminal status

      it(`${agentName} status context does not contain legacy term`, () => {
        const ctx = extractCursorStatusContext(readCursorAgent(agentName));
        assert.ok(ctx !== null, `${agentName} missing 只能使用 status declaration line`);
        for (const term of CURSOR_LEGACY_STATUS_TERMS) {
          assert.doesNotMatch(
            ctx,
            new RegExp(`\\b${term}\\b`),
            `${agentName} status context contains legacy term "${term}"`
          );
        }
      });

      it(`${agentName} status context does not contain out-of-subset canonical term`, () => {
        const ctx = extractCursorStatusContext(readCursorAgent(agentName));
        assert.ok(ctx !== null, `${agentName} missing 只能使用 status declaration line`);
        const outOfSubset = ALL_CANONICAL_TERMS.filter((t) => !statuses.includes(t));
        for (const term of outOfSubset) {
          assert.doesNotMatch(
            ctx,
            new RegExp(`\\b${term}\\b`),
            `${agentName} status context contains out-of-subset canonical term "${term}" (declared subset: ${statuses.join(", ")})`
          );
        }
      });
    }

    // RED proof via inline mutation: inject a legacy term into the status context line
    // and confirm the doesNotMatch regex fires (assertion is not vacuous).
    it("mutation fixture: injected legacy term is caught by doesNotMatch (RED proof — legacy term)", () => {
      const realContent = readCursorAgent("dp-analyst");
      // Inject legacy term "DONE" into the 只能使用 declaration line
      const mutated = realContent.replace(
        /只能使用：([^\n]+)/,
        "只能使用：`finished` / `DONE` / `questions`。"
      );
      const ctx = extractCursorStatusContext(mutated);
      assert.ok(ctx !== null, "mutated content must have status declaration line");
      let caught = false;
      try {
        assert.doesNotMatch(ctx, /\bDONE\b/);
      } catch {
        caught = true;
      }
      assert.ok(caught, "doesNotMatch must throw on legacy term in status context (RED proof)");
    });

    it("mutation fixture: injected out-of-subset canonical term is caught by doesNotMatch (RED proof — out-of-subset)", () => {
      // dp-analyst subset is ["finished", "failed", "questions"] — "blocked" is out-of-subset
      const realContent = readCursorAgent("dp-analyst");
      const mutated = realContent.replace(
        /只能使用：([^\n]+)/,
        "只能使用：`finished` / `failed` / `questions` / `blocked`。"
      );
      const ctx = extractCursorStatusContext(mutated);
      assert.ok(ctx !== null, "mutated content must have status declaration line");
      let caught = false;
      try {
        assert.doesNotMatch(ctx, /\bblocked\b/);
      } catch {
        caught = true;
      }
      assert.ok(caught, "doesNotMatch must throw on out-of-subset canonical term in status context (RED proof)");
    });
  });
});
