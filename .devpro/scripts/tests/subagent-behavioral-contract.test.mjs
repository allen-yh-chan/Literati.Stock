/**
 * subagent-behavioral-contract.test.mjs
 *
 * Verifies each dp-* subagent projection contains the role-anchoring phrases
 * declared in .devpro/scripts/subagent-behavioral-contracts.mjs. Removing any
 * such phrase would constitute behavior drift and is blocked here.
 *
 * Borrowed pattern: refs/oh-my-codex-main/src/hooks/__tests__/prompt-guidance-contract.test.ts
 * (CORE_ROLE_CONTRACTS), simplified to vanilla node:test substring matching.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { SUBAGENT_BEHAVIORAL_CONTRACTS } from "../subagent-behavioral-contracts.mjs";
import { evaluatePreToolUsePayload, PASS_THROUGH } from "../hooks/pre-tool-gate.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import { readSecondReviewSkillWithHostRoutes } from "./lib/second-review-skill.mjs";

const TERMINAL_LEAF_GUARD =
  "DEVPRO_CROSS_MODEL_REVIEWER=1 is a terminal leaf; that process MUST NOT dispatch, probe, project, bootstrap, run any projection runner, or consume any wrapper sidecar.";

const RETURN_GATE_ANCHOR =
  "MUST NOT return a verdict without projection_cli_exited in activity_log_path; otherwise blocked naming attempt_id";

const RETURN_GATE_CARRIERS = [
  { label: "SKILL.md", relPath: ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md" },
  { label: "Claude", relPath: ".claude/agents/dp-second-reviewer.md" },
  { label: "Codex", relPath: ".codex/agents/dp-second-reviewer.toml" },
  { label: "Cursor", relPath: ".cursor/agents/dp-second-reviewer.md" },
  { label: "OpenCode", relPath: ".opencode/agent/dp-second-reviewer.md" },
];

const PROJECTION_SURFACES = [
  {
    label: "Claude",
    dir: ".claude/agents",
    ext: "md",
  },
  {
    label: "Codex",
    dir: ".codex/agents",
    ext: "toml",
  },
  {
    label: "Cursor",
    dir: ".cursor/agents",
    ext: "md",
  },
  {
    label: "OpenCode",
    dir: ".opencode/agent",
    ext: "md",
  },
];

const OPENCODE_ADMISSION_FIELDS = [
  "objective: independent-judgment",
  "responsibility_id: opencode-admission-negative",
  "instance_mode: fresh",
  "evidence_scope: .opencode/agent; spawn admission",
  "return_and_stop: status JSON; stop after reporting",
  "role: dp-explorer",
];

function opencodeChangeWorktreeFixture(changeName = "add-opencode-runtime-parity") {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-admission-"));
  const cwd = path.join(root, ".worktree", changeName);
  const stateDir = path.join(root, "state");
  mkdirSync(path.join(cwd, "openspec", "changes", changeName), { recursive: true });
  const git = (args) =>
    spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });
  git(["init", "-q"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  return { root, cwd, stateDir, changeName };
}

function isAllowed(result) {
  return result === null || result === PASS_THROUGH;
}

function hasTerminalLeafGuardOnOnePhysicalLine(content) {
  return content.split(/\r?\n/u).some((line) => line.includes(TERMINAL_LEAF_GUARD));
}

function hasReturnGateAnchorOnOnePhysicalLine(content) {
  return content.split(/\r?\n/u).some((line) => line.includes(RETURN_GATE_ANCHOR));
}

describe("subagent-behavioral-contract", () => {
  for (const surface of PROJECTION_SURFACES) {
    for (const contract of SUBAGENT_BEHAVIORAL_CONTRACTS) {
      it(`${surface.label} ${contract.subagent}.${surface.ext} 含核心 behavioral phrases`, async () => {
        const relPath = `${surface.dir}/${contract.subagent}.${surface.ext}`;
        const filePath = repoPath(relPath);
        let content;
        try {
          content = await fs.readFile(filePath, "utf8");
        } catch {
          assert.fail(`找不到檔案：${relPath}`);
        }

        const missing = [];
        for (const phrase of contract.mustInclude) {
          if (!content.includes(phrase)) {
            missing.push(phrase);
          }
        }

        if (missing.length > 0) {
          assert.fail(
            [
              `違規：${relPath} 缺核心 behavioral phrases。`,
              "刪除這些 phrase 等於 subagent 行為漂移；必須保留。",
              `缺漏：${missing.map((p) => `「${p}」`).join("、")}`,
            ].join("\n")
          );
        }
      });
    }
  }

  it("common devpro:second-review skill carries second-review behavioral phrases", async () => {
    const relPath = ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md";
    const content = readSecondReviewSkillWithHostRoutes();
    const contract = SUBAGENT_BEHAVIORAL_CONTRACTS.find((entry) => entry.subagent === "dp-second-reviewer");
    assert.ok(contract, "dp-second-reviewer contract missing");
    const missing = contract.mustInclude.filter((phrase) => !content.includes(phrase));
    assert.deepEqual(
      missing,
      [],
      `${relPath} missing behavioral anchors: ${missing.join(", ")}`
    );
  });

  it("common skill and every projection keep the terminal-leaf guard on one physical line", async () => {
    const relPaths = [
      ".devpro/agent-skills/devpro-reviews/second-review/SKILL.md",
      ".claude/agents/dp-second-reviewer.md",
      ".codex/agents/dp-second-reviewer.toml",
      ".cursor/agents/dp-second-reviewer.md",
      ".opencode/agent/dp-second-reviewer.md",
    ];

    for (const relPath of relPaths) {
      const content = await fs.readFile(repoPath(relPath), "utf8");
      assert.equal(
        hasTerminalLeafGuardOnOnePhysicalLine(content),
        true,
        `${relPath} must carry the exact terminal-leaf compound guard on one physical line`
      );
    }
  });

  it("OpenCode Task named projection fails closed on missing/malformed admission", () => {
    const fixture = opencodeChangeWorktreeFixture();
    try {
      const missing = evaluatePreToolUsePayload(
        {
          tool_name: "Task",
          tool_input: { subagent_type: "dp-explorer", prompt: "explore without admission fields" },
          cwd: fixture.cwd,
        },
        { host: "opencode", spawnContextStateDir: fixture.stateDir, nowMs: 1000 }
      );
      assert.equal(missing?.block, true, "unauthorized/missing admission must block");
      assert.match(String(missing?.reason || ""), /Spawn Context Admission Gate/);

      const malformed = evaluatePreToolUsePayload(
        {
          tool_name: "Task",
          tool_input: {
            subagent_type: "dp-explorer",
            prompt: OPENCODE_ADMISSION_FIELDS.map((line) =>
              line.replace("objective: independent-judgment", "objective: save-tokens")
            ).join("\n"),
          },
          cwd: fixture.cwd,
        },
        { host: "opencode", spawnContextStateDir: fixture.stateDir, nowMs: 1000 }
      );
      assert.equal(malformed?.block, true, "malformed admission must block");
      assert.match(String(malformed?.reason || ""), /objective/);

      const roleMismatch = evaluatePreToolUsePayload(
        {
          tool_name: "Task",
          tool_input: {
            subagent_type: "dp-reviewer",
            prompt: OPENCODE_ADMISSION_FIELDS.join("\n"),
          },
          cwd: fixture.cwd,
        },
        { host: "opencode", spawnContextStateDir: fixture.stateDir, nowMs: 1000 }
      );
      assert.equal(roleMismatch?.block, true, "role ≠ subagent_type must block");
      assert.match(String(roleMismatch?.reason || ""), /role/);

      const recordsDir = path.join(
        fixture.cwd,
        "openspec",
        "changes",
        fixture.changeName,
        "admission-records"
      );
      assert.equal(
        existsSync(recordsDir) ? readdirSync(recordsDir).length : 0,
        0,
        "no admission record on blocked OpenCode Task"
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("OpenCode Task named projection writes host=opencode admission record when fields are valid", () => {
    const fixture = opencodeChangeWorktreeFixture();
    try {
      const prompt = OPENCODE_ADMISSION_FIELDS.join("\n") + "\n\nmap symbols";
      const result = evaluatePreToolUsePayload(
        {
          tool_name: "Task",
          tool_input: { subagent_type: "dp-explorer", prompt },
          cwd: fixture.cwd,
        },
        { host: "opencode", spawnContextStateDir: fixture.stateDir, nowMs: 1000 }
      );
      assert.equal(isAllowed(result) || typeof result?.advisory === "string", true);
      assert.match(String(result?.advisory || ""), /admission_record:/);
      const match = /^admission_record: ([0-9a-f-]{36}) sha256=([0-9a-f]{64})$/m.exec(
        String(result?.advisory || "")
      );
      assert.ok(match, `expected admission handoff, got ${JSON.stringify(result)}`);
      const file = path.join(
        fixture.cwd,
        "openspec",
        "changes",
        fixture.changeName,
        "admission-records",
        `${match[1]}.json`
      );
      const bytes = readFileSync(file);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), match[2]);
      const record = JSON.parse(bytes.toString("utf8"));
      assert.equal(record.host, "opencode");
      assert.equal(record.role, "dp-explorer");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("terminal-leaf guard rejects polarity and boundary mutations", () => {
    const mutations = [
      TERMINAL_LEAF_GUARD.replace("=1", "=0"),
      TERMINAL_LEAF_GUARD.replace("MUST NOT", "MAY"),
      TERMINAL_LEAF_GUARD.replace("dispatch, ", ""),
      TERMINAL_LEAF_GUARD.replace("probe, ", ""),
      TERMINAL_LEAF_GUARD.replace("project, ", ""),
      TERMINAL_LEAF_GUARD.replace("run any projection runner, ", ""),
    ];

    assert.equal(hasTerminalLeafGuardOnOnePhysicalLine(TERMINAL_LEAF_GUARD), true);
    for (const mutation of mutations) {
      assert.equal(
        hasTerminalLeafGuardOnOnePhysicalLine(mutation),
        false,
        `mutated guard must fail: ${mutation}`
      );
    }
  });

  for (const carrier of RETURN_GATE_CARRIERS) {
    it(`${carrier.label} carries the reviewer projection return-gate anchor on one physical line`, async () => {
      const content = await fs.readFile(repoPath(carrier.relPath), "utf8");
      assert.equal(
        hasReturnGateAnchorOnOnePhysicalLine(content),
        true,
        `${carrier.relPath} must carry the exact return-gate anchor on one physical line`
      );
    });
  }

  it("return-gate anchor rejects polarity and boundary mutations", () => {
    const mutations = [
      RETURN_GATE_ANCHOR.replace("MUST NOT", "MUST"),
      RETURN_GATE_ANCHOR.replace(
        "activity_log_path; otherwise",
        "activity_log_path;\notherwise"
      ),
    ];

    assert.equal(hasReturnGateAnchorOnOnePhysicalLine(RETURN_GATE_ANCHOR), true);
    for (const mutation of mutations) {
      assert.equal(
        hasReturnGateAnchorOnOnePhysicalLine(mutation),
        false,
        `mutated return-gate anchor must fail: ${JSON.stringify(mutation)}`
      );
    }
  });
});
