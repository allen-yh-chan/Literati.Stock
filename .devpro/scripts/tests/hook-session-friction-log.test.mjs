/**
 * hook-session-friction-log.test.mjs
 *
 * Tests for the friction log mechanism (T1-T4):
 *   - lib/friction-log.mjs: appendFrictionLog / clearFrictionLog
 *   - pre-tool-gate.mjs: hard-block (emitBlock) appends to log
 *   - gh-footer-gate.mjs: hard-block (block) appends to log
 *   - session-start.mjs: SessionStart clears the log
 *
 * Test cases:
 *   (a) pre-tool-gate representative hard-block payload (protected-branch git write on main)
 *       → log gains +1 line containing the gate name
 *   (a-2) pre-tool-gate representative non-branch/merge hard-block payload
 *       (Force-push gate) → log gains +1 line containing the gate name
 *   (b) gh-footer-gate hard-block payload (footer-missing gh write-back)
 *       → log gains +1 line containing the gate name
 *   (c) advisory/warn-only payload (pre-tool emitContext advisory: commit on
 *       feature branch with no attribution footer; gh-footer warn: non-write-back)
 *       → log does NOT gain lines
 *   (d) SessionStart (session-start.mjs) → log is cleared
 *   (e) extractGateName fullwidth-colon support: reason with "Gate：detail"
 *       → log records gate prefix only (no PR#/err.message leak); ASCII-colon still works
 *
 * Isolation: all tests use DEVPRO_FRICTION_LOG and DEVPRO_SENTINEL_STATE_DIR
 * pointing to per-test temp dirs so no real state is touched.
 *
 * TDD: test written alongside implementation — final state must be all green.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const HOOKS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks"
);
const PRE_TOOL_HOOK = path.join(HOOKS_DIR, "pre-tool-gate.mjs");
const GH_FOOTER_HOOK = path.join(HOOKS_DIR, "gh-footer-gate.mjs");
const SESSION_START_HOOK = path.join(HOOKS_DIR, "session-start.mjs");

const tmpRoot = makeTempDir("friction-log-test-");
let counter = 0;

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

/**
 * Create an isolated temp dir for each test case.
 * Returns paths for the friction log and sentinel state dir.
 */
function freshEnv() {
  const dir = path.join(tmpRoot, `case-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const frictionLog = path.join(dir, "session-friction.log");
  const sentinelDir = path.join(dir, "sentinel");
  mkdirSync(sentinelDir, { recursive: true });
  return { dir, frictionLog, sentinelDir };
}

/**
 * Read lines from the friction log (empty array if file does not exist).
 */
function readLogLines(frictionLog) {
  if (!existsSync(frictionLog)) return [];
  const content = readFileSync(frictionLog, "utf8");
  return content.split("\n").filter((l) => l.trim() !== "");
}

/**
 * Create a minimal git repo on the given branch name.
 * Returns the repo dir path.
 */
function setupGitRepo(branchName) {
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", branchName], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "x"), "");
  // Write minimal preflight-checklist.md so verb-whitelist gate does not fire
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(
    path.join(dir, ".devpro/agent-rules/preflight-checklist.md"),
    [
      "<!-- branch-verb-whitelist:start -->",
      "- `fix` — 修 bug",
      "<!-- branch-verb-whitelist:end -->",
      "",
      "<!-- rules-source-whitelist:start -->",
      "- `agent-rules` — devpro-agent-rules submodule（規範同步）",
      "<!-- rules-source-whitelist:end -->",
      "",
    ].join("\n")
  );
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────
// (a) pre-tool-gate representative hard-block → log +1 line with gate name
// ─────────────────────────────────────────────────────────────────────────

test("(a) pre-tool-gate hard-block (protected branch write) → friction log gains 1 line with gate name", () => {
  const { frictionLog, sentinelDir } = freshEnv();
  const repo = setupGitRepo("main");

  // Payload: git commit on main → Protected-branch gate block
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "git commit -m foo", cwd: repo },
  };

  const branch = spawnSync("git", ["branch", "--show-current"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();

  const result = spawnSync("node", [PRE_TOOL_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: repo,
    env: {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_FRICTION_LOG: frictionLog,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
      PWD: repo,
      // Mock cross-model gate so it doesn't interfere
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
        comments: [],
        headRefOid: "a".repeat(40),
        headRefName: branch,
      }),
      CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
    },
  });

  // Hook should block
  const json = result.stdout ? JSON.parse(result.stdout) : null;
  assert.equal(json?.decision, "block", `expected block, got: ${JSON.stringify(json)}`);
  assert.match(json.reason, /Protected-branch gate/, "reason should mention Protected-branch gate");

  // Friction log should have exactly 1 line
  const lines = readLogLines(frictionLog);
  assert.equal(lines.length, 1, `expected 1 log line, got ${lines.length}: ${JSON.stringify(lines)}`);

  // Line format: <ISO8601>\t<gate-name>
  const [ts, gateName] = lines[0].split("\t");
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/, "first field should be ISO8601 timestamp");
  assert.match(gateName, /Protected-branch gate/, "gate name should match Protected-branch gate");
});

test("(a-2) pre-tool-gate hard-block (force-push) → friction log gains 1 line with Force-push gate", () => {
  const { frictionLog, sentinelDir } = freshEnv();
  const repo = setupGitRepo("fix/some-feature");

  // Payload: git push --force on a feature/fix repo → Force-push gate block
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "git push --force origin feature/foo", cwd: repo },
  };

  const branch = "fix/some-feature";

  const result = spawnSync("node", [PRE_TOOL_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: repo,
    env: {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_FRICTION_LOG: frictionLog,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
      PWD: repo,
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
        comments: [],
        headRefOid: "a".repeat(40),
        headRefName: branch,
      }),
      CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
    },
  });

  const json = result.stdout ? JSON.parse(result.stdout) : null;
  assert.equal(json?.decision, "block", `expected block, got: ${JSON.stringify(json)}`);
  assert.match(json.reason, /Force-push gate/, "reason should mention Force-push gate");

  const lines = readLogLines(frictionLog);
  assert.equal(lines.length, 1, `expected 1 log line, got ${lines.length}: ${JSON.stringify(lines)}`);

  const [ts, gateName] = lines[0].split("\t");
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/, "first field should be ISO8601 timestamp");
  assert.equal(gateName, "Force-push gate", `gate name should be "Force-push gate", got: ${JSON.stringify(gateName)}`);
});

// ─────────────────────────────────────────────────────────────────────────
// (b) gh-footer-gate hard-block (footer missing) → log +1 line
// ─────────────────────────────────────────────────────────────────────────

test("(b) gh-footer-gate hard-block (footer missing on gh issue create) → friction log gains 1 line with gate name", () => {
  const { frictionLog, sentinelDir } = freshEnv();

  // Payload: gh issue create with body that has NO footer → block
  // DEVPRO_HOOK_PROTOCOL=json forces the JSON protocol path so block() emits
  // { decision: "block", reason } to stdout (exit 0) instead of stderr (exit 1).
  // Both paths call appendFrictionLog; we test the JSON path for predictability.
  const payload = {
    tool_input: {
      command: 'gh issue create --body "This is an issue body with no footer line."',
    },
  };

  const result = spawnSync("node", [GH_FOOTER_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_HOOK_PROTOCOL: "json",
      DEVPRO_FRICTION_LOG: frictionLog,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
    },
  });

  // Hook should block (JSON protocol path: decision: "block")
  const json = result.stdout ? JSON.parse(result.stdout) : null;
  assert.equal(json?.decision, "block", `expected block, got code=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(json.reason, /Footer/i, "reason should mention Footer");

  // Friction log should have exactly 1 line
  const lines = readLogLines(frictionLog);
  assert.equal(lines.length, 1, `expected 1 log line, got ${lines.length}: ${JSON.stringify(lines)}`);

  // Line format: <ISO8601>\t<gate-name>
  const [ts, gateName] = lines[0].split("\t");
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/, "first field should be ISO8601 timestamp");
  assert.ok(gateName && gateName.length > 0, "gate name should be non-empty");
  assert.match(gateName, /Footer/, "gate name should mention Footer");
});

// ─────────────────────────────────────────────────────────────────────────
// (c) advisory/warn-only payloads → log does NOT grow
// ─────────────────────────────────────────────────────────────────────────

test("(c-1) pre-tool-gate advisory (commit attribution missing on feature branch) → log unchanged", () => {
  const { frictionLog, sentinelDir } = freshEnv();
  const repo = setupGitRepo("fix/some-feature");

  // Payload: git commit on a feature branch without attribution footer
  // This triggers the Commit attribution gate advisory (emitContext), not a hard block.
  const payload = {
    tool_name: "Bash",
    tool_input: {
      command: 'git commit -m "fix: something without footer"',
      cwd: repo,
    },
  };

  const branch = "fix/some-feature";

  const result = spawnSync("node", [PRE_TOOL_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: repo,
    env: {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_FRICTION_LOG: frictionLog,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
      PWD: repo,
      CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
        comments: [],
        headRefOid: "a".repeat(40),
        headRefName: branch,
      }),
      CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
    },
  });

  // Should NOT be a hard block
  const json = result.stdout ? JSON.parse(result.stdout) : null;
  assert.notEqual(json?.decision, "block", `should not block, got: ${JSON.stringify(json)}`);

  // Friction log should NOT have been written (advisory, not hard-block)
  const lines = readLogLines(frictionLog);
  assert.equal(lines.length, 0, `expected 0 log lines (advisory only), got ${lines.length}: ${JSON.stringify(lines)}`);
});

test("(c-2) gh-footer-gate warn-level (non-write-back gh command) → log unchanged", () => {
  const { frictionLog, sentinelDir } = freshEnv();

  // Non-write-back gh command (gh auth status) → gate exits 0 without block/warn
  const payload = {
    tool_input: { command: "gh auth status" },
  };

  const result = spawnSync("node", [GH_FOOTER_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_HOOK_PROTOCOL: "json",
      DEVPRO_FRICTION_LOG: frictionLog,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
    },
  });

  assert.equal(result.status, 0, "non-write-back gh command should exit 0");

  // Friction log should NOT exist or be empty (no hard-block fired)
  const lines = readLogLines(frictionLog);
  assert.equal(lines.length, 0, `expected 0 log lines (pass-through), got ${lines.length}: ${JSON.stringify(lines)}`);
});

test("(c-3) gh-footer-gate warn-level (body with code-span keyword → warn() only) → log unchanged", () => {
  const { frictionLog, sentinelDir } = freshEnv();

  // gh pr create with footer present but body also has a code-span closing keyword
  // → warn() fires (advisory) but no block → log unchanged
  const payload = {
    tool_input: {
      command:
        'gh pr create --body "Fix desc. `Fixes #123`\nRules: v6.78.1 · Tool: Claude Code · Model: Sonnet"',
    },
  };

  const result = spawnSync("node", [GH_FOOTER_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_HOOK_PROTOCOL: "json",
      DEVPRO_FRICTION_LOG: frictionLog,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
    },
  });

  // Should exit 0 (footer present → no block; warn fires but is advisory)
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);

  // Friction log should NOT be written (warn is advisory, not hard-block)
  const lines = readLogLines(frictionLog);
  assert.equal(lines.length, 0, `expected 0 log lines (warn-only), got ${lines.length}: ${JSON.stringify(lines)}`);
});

// ─────────────────────────────────────────────────────────────────────────
// (e) extractGateName — fullwidth colon（全形冒號）support
//     reason 含「Gate名稱：detail」→ log 只記 Gate 名稱，不含冒號後 detail
//     end-to-end via appendFrictionLog (node -e inline script)
// ─────────────────────────────────────────────────────────────────────────

test("(e-1) appendFrictionLog with fullwidth-colon reason (Advisory gate：<detail>) → log records gate prefix only", () => {
  const { frictionLog } = freshEnv();
  const frictionLogMjs = pathToFileURL(path.join(HOOKS_DIR, "lib", "friction-log.mjs")).href;

  // Inline script: import appendFrictionLog and call it with a fullwidth-colon reason
  const script = [
    `import { appendFrictionLog } from ${JSON.stringify(frictionLogMjs)};`,
    `appendFrictionLog("Advisory gate：某 PR 詳情 #123");`,
  ].join("\n");

  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_FRICTION_LOG: frictionLog,
    },
  });

  assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);

  const lines = readLogLines(frictionLog);
  assert.equal(lines.length, 1, `expected 1 log line, got ${lines.length}: ${JSON.stringify(lines)}`);

  const [ts, gateName] = lines[0].split("\t");
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/, "first field should be ISO8601 timestamp");
  // Gate name should be the prefix before the fullwidth colon
  assert.equal(gateName, "Advisory gate", `gate name should be "Advisory gate", got: ${JSON.stringify(gateName)}`);
  // Must NOT contain anything after the fullwidth colon (no PR# or detail)
  assert.ok(!gateName.includes("123"), "gate name must not contain PR# detail");
  assert.ok(!gateName.includes("："), "gate name must not contain the fullwidth colon itself");
});

test("(e-2) appendFrictionLog with fullwidth-colon reason (Cross-Model Merge Gate：<err>) → log records gate prefix only", () => {
  const { frictionLog } = freshEnv();
  const frictionLogMjs = pathToFileURL(path.join(HOOKS_DIR, "lib", "friction-log.mjs")).href;

  const script = [
    `import { appendFrictionLog } from ${JSON.stringify(frictionLogMjs)};`,
    `appendFrictionLog("Cross-Model Merge Gate：unable to fetch PR changed files for #456: network error");`,
  ].join("\n");

  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_FRICTION_LOG: frictionLog,
    },
  });

  assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);

  const lines = readLogLines(frictionLog);
  assert.equal(lines.length, 1, `expected 1 log line, got ${lines.length}: ${JSON.stringify(lines)}`);

  const [ts, gateName] = lines[0].split("\t");
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/, "first field should be ISO8601 timestamp");
  assert.equal(gateName, "Cross-Model Merge Gate", `gate name should be "Cross-Model Merge Gate", got: ${JSON.stringify(gateName)}`);
  // Must NOT contain err.message or PR# detail
  assert.ok(!gateName.includes("456"), "gate name must not contain PR# detail");
  assert.ok(!gateName.includes("network error"), "gate name must not contain err.message detail");
  assert.ok(!gateName.includes("："), "gate name must not contain the fullwidth colon itself");
});

test("(e-3) appendFrictionLog with ASCII-colon reason (Protected-branch gate: detail) → still works correctly (no regression)", () => {
  const { frictionLog } = freshEnv();
  const frictionLogMjs = pathToFileURL(path.join(HOOKS_DIR, "lib", "friction-log.mjs")).href;

  const script = [
    `import { appendFrictionLog } from ${JSON.stringify(frictionLogMjs)};`,
    `appendFrictionLog("Protected-branch gate: git commit on main is forbidden");`,
  ].join("\n");

  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_FRICTION_LOG: frictionLog,
    },
  });

  assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);

  const lines = readLogLines(frictionLog);
  assert.equal(lines.length, 1, `expected 1 log line, got ${lines.length}`);

  const [ts, gateName] = lines[0].split("\t");
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/, "first field should be ISO8601 timestamp");
  assert.equal(gateName, "Protected-branch gate", `ASCII-colon gate name should be "Protected-branch gate", got: ${JSON.stringify(gateName)}`);
  assert.ok(!gateName.includes("main"), "gate name must not contain detail after ASCII colon");
});

// ─────────────────────────────────────────────────────────────────────────
// (d) SessionStart → friction log cleared
// ─────────────────────────────────────────────────────────────────────────

test("(d) SessionStart (session-start.mjs) clears friction log", () => {
  const { frictionLog, sentinelDir } = freshEnv();

  // Pre-populate the friction log with a fake entry
  writeFileSync(
    frictionLog,
    "2026-01-01T00:00:00.000Z\tProtected-branch gate\n2026-01-01T00:01:00.000Z\tFooter missing\n",
    "utf8"
  );
  const linesBefore = readLogLines(frictionLog);
  assert.equal(linesBefore.length, 2, "pre-condition: log should have 2 lines");

  // Run session-start.mjs with isolated env
  const result = spawnSync("node", [SESSION_START_HOOK], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_FRICTION_LOG: frictionLog,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
      // Disable recap-pending and session-pending side effects
      DEVPRO_RECAP_PENDING_DIR: path.join(tmpRoot, `recap-${counter++}`),
      DEVPRO_RECAP_STATE_DIR: path.join(tmpRoot, `recap-state-${counter++}`),
    },
  });

  assert.equal(result.status, 0, `session-start should exit 0, stderr: ${result.stderr}`);

  // Friction log should be cleared (file absent or empty)
  const linesAfter = readLogLines(frictionLog);
  assert.equal(
    linesAfter.length,
    0,
    `expected friction log cleared after SessionStart, got ${linesAfter.length} lines: ${JSON.stringify(linesAfter)}`
  );
});
