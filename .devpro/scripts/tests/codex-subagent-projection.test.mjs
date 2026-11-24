import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { SUBAGENT_BEHAVIORAL_CONTRACTS } from "../subagent-behavioral-contracts.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { readSecondReviewSkillWithHostRoutes } from "./lib/second-review-skill.mjs";
import { readRepoFile as read } from "./lib/read.mjs";

const CODEX_AGENTS = {
  "dp-analyst": {
    statuses: ["finished", "failed", "questions"],
    sandbox: "workspace-write",
  },
  "dp-architect": {
    statuses: ["finished", "questions", "failed"],
    sandbox: "workspace-write",
  },
  "dp-programmer": {
    statuses: ["finished", "failed", "partial"],
    sandbox: "workspace-write",
  },
  "dp-assistant": {
    statuses: ["finished", "failed", "partial"],
    sandbox: "workspace-write",
  },
  "dp-reviewer": {
    statuses: ["finished", "blocked", "partial"],
    sandbox: "read-only",
  },
  "dp-explorer": {
    statuses: [],
    sandbox: "read-only",
  },
  "dp-second-reviewer": {
    statuses: ["finished", "blocked", "partial"],
    sandbox: "danger-full-access",
  },
};

const REQUIRED_SSOT = [
  ".devpro/agent-rules/model-delegation.md",
  ".devpro/agent-rules/multi-agent-handoff.md",
];

function codexAgentPath(agentName) {
  return `.codex/agents/${agentName}.toml`;
}

function readCodexAgent(agentName) {
  return read(codexAgentPath(agentName));
}

function tomlString(content, key) {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  return match ? match[1] : null;
}

describe("codex-subagent-projection", () => {
  describe("Codex custom agent files exist and use required TOML fields", () => {
    for (const agentName of Object.keys(CODEX_AGENTS)) {
      it(`${codexAgentPath(agentName)} defines a project-scoped custom agent`, () => {
        const content = readCodexAgent(agentName);
        assert.equal(tomlString(content, "name"), agentName);
        assert.ok(tomlString(content, "description"), `${agentName} missing description`);
        assert.match(
          content,
          /^developer_instructions\s*=\s*"""/m,
          `${agentName} missing developer_instructions triple-quoted string`
        );
        if (agentName === "dp-second-reviewer") {
          assert.match(
            content,
            /\.devpro\/agent-skills\/devpro-reviews\/second-review\/SKILL\.md/,
            "dp-second-reviewer must cite the common devpro:second-review skill SSOT"
          );
          assert.match(content, /platform-adapters\/codex\.md/);
          assert.match(content, /platform-adapters\/codex-host-cross-review\.md/);
          assert.match(content, /\.devpro\/agent-skills-refs\/autonomous-ai-agents\/claude-code\/SKILL\.md/);
          assert.doesNotMatch(
            content,
            /\.claude\/agents\/dp-second-reviewer\.md/,
            "Codex dp-second-reviewer must not route through the Claude projection"
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

  describe("Codex projections cite shared SSOT files", () => {
    for (const agentName of Object.keys(CODEX_AGENTS)) {
      it(`${agentName} cites model delegation and handoff SSOT`, () => {
        const content = readCodexAgent(agentName);
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

  describe("Codex projections preserve canonical status subsets", () => {
    for (const [agentName, { statuses }] of Object.entries(CODEX_AGENTS)) {
      it(`${agentName} includes its canonical terminal status subset`, () => {
        const content = readCodexAgent(agentName);
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

  describe("Codex projections preserve behavioral anchor phrases", () => {
    for (const contract of SUBAGENT_BEHAVIORAL_CONTRACTS) {
      it(`${contract.subagent}.toml contains shared behavioral anchors`, () => {
        const content = readCodexAgent(contract.subagent);
        const missing = contract.mustInclude.filter((phrase) => !content.includes(phrase));
        assert.deepEqual(
          missing,
          [],
          `${codexAgentPath(contract.subagent)} missing behavioral anchors: ${missing.join(", ")}`
        );
      });
    }
  });

  describe("Codex projections preserve delegation trigger anchors", () => {
    it("dp-assistant projection names rote multi-step and bulk-file triggers", () => {
      const content = readCodexAgent("dp-assistant");

      assert.match(content, /Codex trigger 投影/);
      assert.match(content, /≥2 步非判斷性工作/);
      assert.match(content, /bulk ≥2 檔機械任務/);
      assert.match(content, /trigger SSOT 仍是 model-delegation\.md \/ multi-agent-handoff\.md/);
    });

    it("dp-programmer projection names multi-file implementation and test-writing triggers", () => {
      const content = readCodexAgent("dp-programmer");

      assert.match(content, /Codex trigger 投影/);
      assert.match(content, /implementation_plan\/touch list/);
      assert.match(content, /撰寫 ≥2 檔實作或測試/);
      assert.match(content, /trigger SSOT 仍是 model-delegation\.md \/ multi-agent-handoff\.md/);
    });
  });

  describe("Codex projections use bounded sandbox modes", () => {
    for (const [agentName, { sandbox }] of Object.entries(CODEX_AGENTS)) {
      it(`${agentName} sandbox_mode = ${sandbox}`, () => {
        const content = readCodexAgent(agentName);
        assert.equal(tomlString(content, "sandbox_mode"), sandbox);
      });
    }
  });

  describe("Codex host routes dp-second-reviewer through the common skill", () => {
    it("exposes a thin Codex dp-second-reviewer projection that points to SSOT and adapter route", () => {
      const relPath = ".codex/agents/dp-second-reviewer.toml";
      assert.equal(existsSync(repoPath(relPath)), true, `${relPath} must exist`);

      const content = read(relPath);
      const requiredAnchors = [
        ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
        "platform-adapters/codex.md",
        "platform-adapters/codex-host-cross-review.md",
        ".devpro/agent-skills-refs/autonomous-ai-agents/claude-code/SKILL.md",
        "platform-adapters/claude-code-cross-review.md",
        "claude -p",
        "same-family fallback",
        "cross-model-second-opinion:sticky",
        "verdict",
      ];

      const missing = requiredAnchors.filter((anchor) => !content.includes(anchor));
      assert.deepEqual(missing, [], `${relPath} missing route anchors: ${missing.join(", ")}`);
      assert.match(
        content,
        /projection, not SSOT|projection only|投影，不是 SSOT|投影，非 SSOT/i,
        `${relPath} must state that it is a projection, not SSOT`
      );
      assert.doesNotMatch(
        content,
        /default(?: reviewer)? (?:route|path)[^\n]*(?:codex exec|Codex reviewer|Codex-family)/i,
        `${relPath} must not make codex exec or Codex reviewer the default route`
      );
      assert.doesNotMatch(
        content,
        /(?:codex exec|Codex reviewer|Codex-family)[^\n]*default(?: reviewer)? (?:route|path)/i,
        `${relPath} must not make codex exec or Codex reviewer the default route`
      );
      assert.doesNotMatch(
        content,
        /\.claude\/agents\/dp-second-reviewer\.md/,
        `${relPath} must not route through the Claude projection`
      );
    });

    it("common skill and Codex-host adapter define projection-first Codex -> Claude path", () => {
      const skill = readSecondReviewSkillWithHostRoutes();
      const codexHost = read(".devpro/agent-rules/platform-adapters/codex-host-cross-review.md");
      assert.match(skill, /Codex host MUST use projection-first routing when the runtime exposes `dp-second-reviewer`/);
      assert.match(skill, /`platform-adapters\/codex-host-cross-review\.md`|platform-adapters\/codex-host-cross-review\.md/);
      assert.match(skill, /executor-internal direct `claude -p` packet mode/);
      assert.match(skill, /TL MAY use the direct `claude -p` adapter recipe only as `projection_unavailable` \/ `projection_runner_unavailable` \/ `tool_discovery_blocked` \/ explicit manual fallback \/ explicit projection failure \/ stale-or-no-fresh-sticky-after-projection-observation-window/);
      assert.match(codexHost, /MAY expose `.codex\/agents\/dp-second-reviewer\.toml` only as a thin projection/);
      assert.match(codexHost, /when runtime exposes `dp-second-reviewer`, Codex default path is projection-first/);
      assert.match(codexHost, /MUST NOT dispatch the projection as a Codex-family default reviewer route/);
      assert.match(codexHost, /executor-internal direct `claude -p` packet mode/);
      assert.doesNotMatch(codexHost, /Codex default path is common skill ->[\s\S]{0,160}direct `claude -p` packet mode/);
    });
  });

  // ── Negative assertions: status-context aware (spec line 45) ──────────────
  // Extract the terminal status declaration portion from a Codex TOML agent.
  // Pattern: 必要標準 terminal status 字串：<enums>。
  // Some projections add non-terminal-status terms near the status line;
  // isolate only the terminal-status segment before "另外" to avoid false positives.
  function extractCodexStatusContext(content) {
    const m = content.match(/必要標準 terminal status 字串：([^\n]+)/);
    if (!m) return null;
    // Trim at "另外" to exclude subsidiary sticky-verdict clause
    const afterColon = m[1];
    const altIdx = afterColon.indexOf("另外");
    return altIdx === -1 ? afterColon : afterColon.slice(0, altIdx);
  }

  // Individual legacy terminal status terms that must NOT appear in status context.
  // Source: subagent-status-vocabulary.test.mjs LEGACY_STATUS_ENUMS vocabulary.
  const CODEX_LEGACY_STATUS_TERMS = ["DONE", "FAIL", "PASS", "OK", "PARTIAL", "QUESTIONS", "BLOCK"];

  // Five canonical terminal status terms.
  const ALL_CANONICAL_TERMS = ["finished", "blocked", "failed", "questions", "partial"];

  describe("Codex projections reject legacy + out-of-subset status terms (spec line 45)", () => {
    for (const [agentName, { statuses }] of Object.entries(CODEX_AGENTS)) {
      if (statuses.length === 0) continue; // dp-explorer declares no terminal status

      it(`${agentName} status context does not contain legacy term`, () => {
        const ctx = extractCodexStatusContext(readCodexAgent(agentName));
        assert.ok(ctx !== null, `${agentName} missing 必要標準 terminal status 字串 line`);
        for (const term of CODEX_LEGACY_STATUS_TERMS) {
          assert.doesNotMatch(
            ctx,
            new RegExp(`\\b${term}\\b`),
            `${agentName} status context contains legacy term "${term}"`
          );
        }
      });

      it(`${agentName} status context does not contain out-of-subset canonical term`, () => {
        const ctx = extractCodexStatusContext(readCodexAgent(agentName));
        assert.ok(ctx !== null, `${agentName} missing 必要標準 terminal status 字串 line`);
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

    // RED proof via inline mutation: inject a legacy term into a status context line
    // and confirm the doesNotMatch regex fires (assertion is not vacuous).
    it("mutation fixture: injected legacy term is caught by doesNotMatch (RED proof — legacy term)", () => {
      const realContent = readCodexAgent("dp-analyst");
      // Inject legacy term "DONE" into the status declaration line
      const mutated = realContent.replace(
        /必要標準 terminal status 字串：([^\n]+)/,
        "必要標準 terminal status 字串：finished / DONE / questions。"
      );
      const ctx = extractCodexStatusContext(mutated);
      assert.ok(ctx !== null, "mutated content must have status line");
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
      const realContent = readCodexAgent("dp-analyst");
      const mutated = realContent.replace(
        /必要標準 terminal status 字串：([^\n]+)/,
        "必要標準 terminal status 字串：finished / failed / questions / blocked。"
      );
      const ctx = extractCodexStatusContext(mutated);
      assert.ok(ctx !== null, "mutated content must have status line");
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
