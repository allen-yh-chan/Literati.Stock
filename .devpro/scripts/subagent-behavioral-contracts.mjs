/**
 * Behavioral contracts for dp-* subagent definitions.
 *
 * Each entry asserts that a given subagent projection file contains certain phrases
 * that anchor that subagent's role identity. Removing any of these phrases would
 * constitute behavior drift and is blocked by
 * .devpro/scripts/tests/subagent-behavioral-contract.test.mjs.
 *
 * Borrowed pattern: refs/oh-my-codex-main/src/hooks/__tests__/prompt-guidance-contract.test.ts
 * (CORE_ROLE_CONTRACTS), simplified to vanilla node:test substring matching.
 */

export const SUBAGENT_BEHAVIORAL_CONTRACTS = [
  {
    subagent: "dp-analyst",
    mustInclude: ["pre-flight checklist", "需求分析", "brd.md", "ambiguity", "Contrarian"],
  },
  {
    subagent: "dp-architect",
    mustInclude: ["target state", "done-when", "proposal", "design.md"],
  },
  {
    subagent: "dp-reviewer",
    mustInclude: ["六軸"],
  },
  {
    subagent: "dp-programmer",
    mustInclude: ["實作", "不做架構決策"],
  },
  {
    subagent: "dp-assistant",
    mustInclude: ["機械化", "不做設計"],
  },
  {
    subagent: "dp-explorer",
    mustInclude: ["read-only", "Fan-out", "file:line"],
  },
  {
    subagent: "dp-second-reviewer",
    mustInclude: [
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
      "六軸",
      "sticky",
      "cross-model-second-opinion:sticky",
      "verdict",
      "DEVPRO_CROSS_MODEL_REVIEWER=1",
      "terminal leaf",
      "MUST NOT dispatch, probe, project, bootstrap, run any projection runner, or consume any wrapper sidecar",
      "MUST NOT return a verdict without projection_cli_exited in activity_log_path; otherwise blocked naming attempt_id",
    ],
  },
];
