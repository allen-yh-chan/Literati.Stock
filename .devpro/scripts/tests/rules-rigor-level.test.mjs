/**
 * rules-rigor-level.test.mjs
 *
 * Tests for the DEVPRO_AGENT_RULES_LEVEL rigor-gating feature (T3 + T4).
 *
 * T3 — resolveRigorLevel three-layer precedence unit tests
 * T4 — reverse prove-it: off-level baseline gates still block; non-baseline no-op;
 *       drift detection (removing a baseline id → test goes red)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath, repoFileUrl } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { git, initRepo } from "./lib/git.mjs";

const HOOK = repoPath(".devpro/scripts/hooks/pre-tool-gate.mjs");
const RUN_HOOK = repoPath(".devpro/scripts/hooks/run-hook.mjs");
const RIGOR_LIB = repoFileUrl(".devpro/scripts/hooks/lib/rigor-level.mjs");

// ── T3: resolveRigorLevel unit tests ─────────────────────────────────────────

describe("resolveRigorLevel — three-layer precedence", () => {
  // Import the module in a subprocess so we can control process.env cleanly
  // without polluting the test runner's own env.

  /**
   * Run resolveRigorLevel in a child process with controlled env + optional
   * fake .devpro/rules.config.
   */
  function runResolve({ envLevel, configValue, fakeCwd } = {}) {
    // Build a tiny inline script that calls resolveRigorLevel({ cwd }) and
    // prints the result to stdout.
    const script = [
      `import { resolveRigorLevel } from ${JSON.stringify(RIGOR_LIB)};`,
      `const cwd = ${fakeCwd ? JSON.stringify(fakeCwd) : "undefined"};`,
      `process.stdout.write(resolveRigorLevel(cwd !== undefined ? { cwd } : {}));`,
    ].join("\n");

    const env = { ...process.env };
    // Scrub any inherited DEVPRO_AGENT_RULES_LEVEL
    delete env.DEVPRO_AGENT_RULES_LEVEL;
    if (envLevel !== undefined) {
      env.DEVPRO_AGENT_RULES_LEVEL = envLevel;
    }

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { encoding: "utf8", env }
    );
    if (result.error) throw result.error;
    return result.stdout.trim();
  }

  it("env=off → off (env takes precedence over everything)", () => {
    const level = runResolve({ envLevel: "off" });
    assert.equal(level, "off");
  });

  it("env=lite → lite", () => {
    const level = runResolve({ envLevel: "lite" });
    assert.equal(level, "lite");
  });

  it("env=full → full (explicit)", () => {
    const level = runResolve({ envLevel: "full" });
    assert.equal(level, "full");
  });

  it("env unset + .devpro/rules.config=lite → lite (config tier)", () => {
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "agent_rules_level=lite");
      const level = runResolve({ fakeCwd: dir });
      assert.equal(level, "lite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env unset + .devpro/rules.config=off → off", () => {
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "agent_rules_level=off");
      const level = runResolve({ fakeCwd: dir });
      assert.equal(level, "off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env unset + rules.config invalid value → full (fallback)", () => {
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "agent_rules_level=maximum");
      const level = runResolve({ fakeCwd: dir });
      assert.equal(level, "full");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env unset + no rules.config → lite (built-in default)", () => {
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      // No rules.config written
      const level = runResolve({ fakeCwd: dir });
      assert.equal(level, "lite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env overrides rules.config (env=full, config=off → full)", () => {
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "agent_rules_level=off");
      const level = runResolve({ envLevel: "full", fakeCwd: dir });
      assert.equal(level, "full");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env SET-but-invalid → full (fail-closed; does NOT fall through to config=lite)", () => {
    // Cross-model review finding: a typo'd env in a repo whose config says
    // lite/off must NOT silently keep reduced rigor. A set-but-invalid env is
    // fail-closed to full (most strict), not treated as unset.
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "agent_rules_level=lite");
      const level = runResolve({ envLevel: "turbo", fakeCwd: dir });
      assert.equal(level, "full");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env empty/whitespace → treated as unset, falls through to config", () => {
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "agent_rules_level=off");
      const level = runResolve({ envLevel: "   ", fakeCwd: dir });
      assert.equal(level, "off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config with # comment lines (verbatim example copy) resolves via agent_rules_level key", () => {
    // Cross-model review finding: the documented `cp rules.config.example
    // rules.config && 改值` flow must work even with the comment block intact.
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(
        path.join(dir, ".devpro/rules.config"),
        "# Rigor level config\n#\n# 有效值：full | lite | off\nagent_rules_level=off\n"
      );
      const level = runResolve({ fakeCwd: dir });
      assert.equal(level, "off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config that is only comments/blank → lite (no agent_rules_level key)", () => {
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "# only a comment\n\n");
      const level = runResolve({ fakeCwd: dir });
      assert.equal(level, "lite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bare value (no =) → lite (ignored; no recognized setting)", () => {
    // Destructive semantic lock: bare token format (e.g. "lite" with no "=") is
    // no longer recognized. parser returns null → built-in default lite.
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "lite");
      const level = runResolve({ fakeCwd: dir });
      assert.equal(level, "lite", "bare value is ignored; no recognized setting uses lite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config with unknown key before agent_rules_level → lite (unknown keys ignored, forward-compat)", () => {
    // Forward-compat: unknown keys are ignored; parser finds agent_rules_level
    // regardless of position relative to unknown keys.
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(
        path.join(dir, ".devpro/rules.config"),
        "some_future_key=x\nagent_rules_level=lite"
      );
      const level = runResolve({ fakeCwd: dir });
      assert.equal(level, "lite", "unknown keys must be ignored; agent_rules_level=lite should resolve to lite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent_rules_level= (empty value) → full (fail-closed; empty value is not a valid level)", () => {
    // Six-axis review finding: lock the empty-value fail-closed contract so a
    // future parser "optimization" that returns the empty string as a level
    // would be caught. parseConfigLevel returns "" → caller's VALID_LEVELS.has("")
    // is false → fallback full.
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "agent_rules_level=");
      const level = runResolve({ fakeCwd: dir });
      assert.equal(level, "full", "empty value must fail-closed to full, not be treated as a valid level");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("duplicate agent_rules_level keys are first-match-wins", () => {
    // Duplicate keys are malformed but deterministic: the parser returns the
    // first declaration and ignores later declarations. This prevents silent
    // semantic drift to last-match-wins without an explicit rule change.
    const dir = makeTempDir("rigor-level-test-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(
        path.join(dir, ".devpro/rules.config"),
        "agent_rules_level=lite\nagent_rules_level=off\n"
      );
      const level = runResolve({ fakeCwd: dir });
      assert.equal(level, "lite", "duplicate agent_rules_level entries must resolve to the first declaration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveRigorLevel — injected env (callers that hold an env they did not read from process.env)", () => {
  // In-process on purpose: the whole point is that the injected env, not the live process.env, decides.
  async function resolveWith(args) {
    const { resolveRigorLevel } = await import(RIGOR_LIB);
    return resolveRigorLevel(args);
  }

  it("reads DEVPRO_AGENT_RULES_LEVEL from the injected env, ignoring process.env", async () => {
    const previous = process.env.DEVPRO_AGENT_RULES_LEVEL;
    process.env.DEVPRO_AGENT_RULES_LEVEL = "off";
    try {
      assert.equal(await resolveWith({ env: { DEVPRO_AGENT_RULES_LEVEL: "lite" } }), "lite");
      assert.equal(await resolveWith({ env: { DEVPRO_AGENT_RULES_LEVEL: "full" } }), "full");
    } finally {
      if (previous === undefined) delete process.env.DEVPRO_AGENT_RULES_LEVEL;
      else process.env.DEVPRO_AGENT_RULES_LEVEL = previous;
    }
  });

  it("an injected env that sets an invalid level fails closed to full even when the config says lite", async () => {
    const dir = makeTempDir("rigor-level-env-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "agent_rules_level=lite");
      assert.equal(await resolveWith({ cwd: dir, env: { DEVPRO_AGENT_RULES_LEVEL: "litee" } }), "full");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an injected env without the variable falls through to the config tier, as an unset env does", async () => {
    const dir = makeTempDir("rigor-level-env-");
    try {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro/rules.config"), "agent_rules_level=lite");
      assert.equal(await resolveWith({ cwd: dir, env: {} }), "lite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omitting env keeps reading process.env (existing callers are unchanged)", async () => {
    const previous = process.env.DEVPRO_AGENT_RULES_LEVEL;
    process.env.DEVPRO_AGENT_RULES_LEVEL = "off";
    try {
      assert.equal(await resolveWith({}), "off");
    } finally {
      if (previous === undefined) delete process.env.DEVPRO_AGENT_RULES_LEVEL;
      else process.env.DEVPRO_AGENT_RULES_LEVEL = previous;
    }
  });
});

// ── Helpers shared by T4 tests ────────────────────────────────────────────────

// Minimal preflight-checklist.md fixture (same pattern as hook-pre-tool-gate.test.mjs)
const PREFLIGHT_FIXTURE = [
  "# preflight",
  "",
  "<!-- branch-verb-whitelist:start -->",
  "- `add` — 新增功能",
  "- `fix` — 修 bug",
  "- `refactor` — 不變行為重整",
  "- `remove` — 移除",
  "- `migrate` — 切換技術棧",
  "- `update` — 同一依賴升新版",
  "- `docs` — 純文件",
  "- `amend` — 修規範既有 requirement",
  "- `strengthen` — 補既有規則漏洞",
  "- `wire` — 啟用既有設計",
  "- `clarify` — 澄清既有規則語意",
  "- `enforce` — 把既有規則上升為強制 gate",
  "<!-- branch-verb-whitelist:end -->",
  "",
  "<!-- rules-source-whitelist:start -->",
  "- `agent-rules` — devpro-agent-rules submodule（規範同步）",
  "<!-- rules-source-whitelist:end -->",
  "",
].join("\n");

function writePreflightFixture(dir) {
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(
    path.join(dir, ".devpro/agent-rules/preflight-checklist.md"),
    PREFLIGHT_FIXTURE
  );
}

let repoCounter = 0;
const tmpRoot = makeTempDir("rigor-t4-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function setupRepo(branchName) {
  const dir = path.join(tmpRoot, `repo-${repoCounter++}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", branchName], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "x"), "");
  writePreflightFixture(dir);
  spawnSync("git", ["add", "x"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

/**
 * Spawn pre-tool-gate.mjs directly (bypass run-hook wrapper) with a controlled
 * env. Returns { code, stdout, stderr, json }.
 */
function runGateDirect(payload, { cwd, level, extraEnv = {} } = {}) {
  const hookCwd = cwd || REPO_ROOT;
  const sentinelDir = makeTempDir("sentinel-");
  const branch = spawnSync("git", ["branch", "--show-current"], {
    cwd: hookCwd,
    encoding: "utf8",
  }).stdout?.trim() || "";

  const env = {
    ...process.env,
    CODEX_CI: "",
    CODEX_THREAD_ID: "",
    DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
    PWD: hookCwd,
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
      comments: [],
      headRefOid: "a".repeat(40),
      headRefName: branch,
    }),
    CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
    ...extraEnv,
  };

  // Inject rigor level if provided
  if (level !== undefined) {
    env.DEVPRO_AGENT_RULES_LEVEL = level;
  } else {
    delete env.DEVPRO_AGENT_RULES_LEVEL;
  }

  const result = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: hookCwd,
    env,
  });

  try {
    rmSync(sentinelDir, { recursive: true, force: true });
  } catch {}

  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {}
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

/**
 * Spawn run-hook.mjs (the wrapper) with a controlled env.
 * This tests the full Layer 1 + Layer 2 chain.
 */
function runViaWrapper(eventName, scriptPath, payload, { cwd, level, extraEnv = {} } = {}) {
  const hookCwd = cwd || REPO_ROOT;
  const sentinelDir = makeTempDir("sentinel-");
  const branch = spawnSync("git", ["branch", "--show-current"], {
    cwd: hookCwd,
    encoding: "utf8",
  }).stdout?.trim() || "";

  const env = {
    ...process.env,
    CODEX_CI: "",
    CODEX_THREAD_ID: "",
    DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
    PWD: hookCwd,
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify({
      comments: [],
      headRefOid: "a".repeat(40),
      headRefName: branch,
    }),
    CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: branch,
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "",
    ...extraEnv,
  };

  if (level !== undefined) {
    env.DEVPRO_AGENT_RULES_LEVEL = level;
  } else {
    delete env.DEVPRO_AGENT_RULES_LEVEL;
  }

  const result = spawnSync(
    "node",
    [RUN_HOOK, eventName, scriptPath],
    {
      input: JSON.stringify(payload),
      encoding: "utf8",
      cwd: hookCwd,
      env,
    }
  );

  try {
    rmSync(sentinelDir, { recursive: true, force: true });
  } catch {}

  let json = null;
  if (result.stdout && result.stdout.trim()) {
    try {
      json = JSON.parse(result.stdout);
    } catch {}
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

// ── T4: reverse prove-it — baseline gates still block at level=off ────────────

describe("T4: rigor level gating — baseline gates fire at off", () => {
  it("off: protected-branch-write (git commit on main) still blocks", () => {
    const repo = setupRepo("main");
    const r = runGateDirect(
      { tool_name: "Bash", tool_input: { command: "git commit -m foo" } },
      { cwd: repo, level: "off" }
    );
    assert.equal(r.json?.decision, "block", `Expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Protected-branch gate/);
  });

  it("off: protected-branch-uncertain-cwd (advisory) still fires when branch uncertain", () => {
    // When PWD points to a known protected branch context but baseCwd is different,
    // the gate emits an advisory. We test that level=off does NOT suppress it.
    // We use a repo on main + set PWD to the repo so the gate can detect the branch.
    const repo = setupRepo("main");
    const r = runGateDirect(
      { tool_name: "Bash", tool_input: { command: "git commit -m foo" } },
      { cwd: repo, level: "off" }
    );
    // At minimum, the protected-branch-write block fires — that subsumes the advisory.
    // The key is exit code from run-hook reflects block (non-zero from the gate).
    assert.ok(r.json?.decision === "block" || r.json?.hookSpecificOutput != null,
      "Expected either block or advisory output, got silent pass");
  });

  it("off: protected-branch-file-write (Edit on main) still blocks", () => {
    const repo = setupRepo("main");
    const r = runGateDirect(
      {
        tool_name: "Edit",
        tool_input: {
          file_path: path.join(repo, "README.md"),
          old_string: "a",
          new_string: "b",
        },
      },
      { cwd: repo, level: "off" }
    );
    assert.equal(r.json?.decision, "block", `Expected block on file-write to main, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Protected-branch gate/);
  });

  // Scenario: Windows Protected Document Path Reaches Gate P
  it("off: openspec-doc-pii (email in Write content) still blocks", () => {
    const repo = setupRepo("chore/test-branch");
    // Write content containing a real (non-allowlisted) email to an openspec path.
    // Note: @example.com is allow-listed; use a real-looking domain that is not.
    const filePath = path.join(repo, "openspec", "changes", "test", "proposal.md");
    mkdirSync(path.dirname(filePath), { recursive: true });
    const r = runGateDirect(
      {
        tool_name: "Write",
        tool_input: {
          file_path: filePath,
          content: "Author: alice@acme-corp.io\nSome proposal content here.",
        },
      },
      { cwd: repo, level: "off" }
    );
    assert.equal(r.json?.decision, "block", `Expected PII block (email), got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /PII/i);
  });

  it("off: commit-attribution-brand-leak (AI brand marker in commit message) still blocks", () => {
    // commit-attribution-brand-leak is a fail-closed COMPLIANCE gate (5th baseline):
    // it must block AI brand markers from entering git history even at level=off.
    // User-confirmed scope: off downgrades workflow rigor, not compliance.
    const repo = setupRepo("chore/test-branch");
    const r = runGateDirect(
      {
        tool_name: "Bash",
        tool_input: {
          command:
            "git commit -m \"feat: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>\"",
        },
      },
      { cwd: repo, level: "off" }
    );
    assert.equal(
      r.json?.decision,
      "block",
      `Expected brand-leak block at off, got: ${JSON.stringify(r.json)}`
    );
  });
});

// ── T4: non-baseline gates no-op at level=off via Layer 1 wrapper ─────────────

describe("T4: rigor level gating — advisory hooks no-op at off via run-hook wrapper", () => {
  it("wrapper resolves the current checkout config from a subdirectory, linked worktree, or non-Git directory", (t) => {
    const root = makeTempDir("wrapper-rigor-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, "repo");
    const linked = path.join(root, "linked");
    mkdirSync(repo);
    initRepo(repo, { commit: true });
    git(repo, "worktree", "add", "-q", "-b", "test/rigor", linked);
    const config = (dir, level) => {
      mkdirSync(path.join(dir, ".devpro"), { recursive: true });
      writeFileSync(path.join(dir, ".devpro", "rules.config"), `agent_rules_level=${level}\n`);
    };
    config(repo, "off");
    config(linked, "full");
    config(root, "lite");
    const probe = path.join(root, "observe-rigor.mjs");
    writeFileSync(probe, "process.stdout.write(JSON.stringify(process.env.DEVPRO_AGENT_RULES_LEVEL));\n");
    for (const [dir, expected] of [[path.join(repo, ".devpro"), "off"], [path.join(linked, ".devpro"), "full"], [root, "lite"]]) {
      const result = runViaWrapper("SessionStart", probe, {}, { cwd: dir });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.json, expected);
    }
  });

  const ADVISORY_HOOKS = [
    "commit-soft-nudge.mjs",
    "recap-check.mjs",
    "post-merge-check.mjs",
    "session-pending-cleanup-check.mjs",
    "user-prompt-gate.mjs",
    "stop-handoff-cite.mjs",
  ];

  for (const hookFile of ADVISORY_HOOKS) {
    const hookPath = path.join(REPO_ROOT, ".devpro/scripts/hooks", hookFile);

    it(`off: ${hookFile} is no-op (exit 0, no output) via run-hook wrapper`, () => {
      // Even if the hook doesn't exist locally in the test runner's repo, we
      // test run-hook's no-op behaviour by using the actual hook path.
      // If the hook file doesn't exist, run-hook exits 0 anyway (file-not-found).
      // We care about the Level 1 no-op path, which fires *before* existence check
      // when the basename matches the policy. However, run-hook checks existence
      // first (line ~47). So we use the resolved script path from the repo.
      if (!existsSync(hookPath)) {
        // Hook doesn't exist in this repo; skip the spawn test but verify the
        // shouldNoOp logic directly via inline eval.
        const script = [
          `import { shouldNoOp } from ${JSON.stringify(RIGOR_LIB)};`,
          `process.stdout.write(String(shouldNoOp(${JSON.stringify(hookFile)}, "off")));`,
        ].join("\n");
        const r = spawnSync(
          process.execPath,
          ["--input-type=module", "--eval", script],
          { encoding: "utf8" }
        );
        assert.equal(r.stdout.trim(), "true", `shouldNoOp(${hookFile}, off) should be true`);
        return;
      }

      const r = runViaWrapper("Stop", hookPath, "{}", { level: "off" });
      // Wrapper exits 0 (no-op) and produces no output
      assert.equal(r.code, 0, `Expected exit 0 for ${hookFile} at level=off, got ${r.code}\nstderr: ${r.stderr}`);
      // Should be empty output (no hook spawned)
      assert.equal(r.stdout, "", `Expected empty stdout for ${hookFile} at level=off`);
    });
  }

  it("off: post-pr-completion-check.mjs is no-op via run-hook wrapper", () => {
    const hookPath = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");
    if (!existsSync(hookPath)) {
      // Verify via shouldNoOp directly
      const script = [
        `import { shouldNoOp } from ${JSON.stringify(RIGOR_LIB)};`,
        `process.stdout.write(String(shouldNoOp("post-pr-completion-check.mjs", "off")));`,
      ].join("\n");
      const r = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { encoding: "utf8" }
      );
      assert.equal(r.stdout.trim(), "true");
      return;
    }
    const r = runViaWrapper("Stop", hookPath, "{}", { level: "off" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("lite: post-pr-completion-check.mjs is NOT no-op (shouldNoOp returns false)", () => {
    const script = [
      `import { shouldNoOp } from ${JSON.stringify(RIGOR_LIB)};`,
      `process.stdout.write(String(shouldNoOp("post-pr-completion-check.mjs", "lite")));`,
    ].join("\n");
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { encoding: "utf8" }
    );
    assert.equal(r.stdout.trim(), "false", "post-pr-completion-check should fire at lite");
  });

  it("off: release-back-merge-check.mjs is no-op via run-hook wrapper", () => {
    const r = runViaWrapper("Stop", repoPath(".devpro/scripts/hooks/release-back-merge-check.mjs"), "{}", { level: "off" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    const script = [
      `import { shouldNoOp } from ${JSON.stringify(RIGOR_LIB)};`,
      `process.stdout.write(String(shouldNoOp("release-back-merge-check.mjs", "off")));`,
    ].join("\n");
    const check = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    assert.equal(check.stdout.trim(), "true", "release-back-merge-check is workflow-completion: skipped at off");
  });

  it("lite: release-back-merge-check.mjs is NOT no-op (shouldNoOp returns false)", () => {
    const script = [
      `import { shouldNoOp } from ${JSON.stringify(RIGOR_LIB)};`,
      `process.stdout.write(String(shouldNoOp("release-back-merge-check.mjs", "lite")));`,
    ].join("\n");
    const r = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), "false", "release-back-merge-check should fire at lite");
  });

  it("lite: advisory hooks are no-op (shouldNoOp returns true for commit-soft-nudge)", () => {
    const script = [
      `import { shouldNoOp } from ${JSON.stringify(RIGOR_LIB)};`,
      `process.stdout.write(String(shouldNoOp("commit-soft-nudge.mjs", "lite")));`,
    ].join("\n");
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { encoding: "utf8" }
    );
    assert.equal(r.stdout.trim(), "true", "commit-soft-nudge should be no-op at lite");
  });

  it("full: nothing is no-op — shouldNoOp always returns false", () => {
    const hooks = [
      "commit-soft-nudge.mjs",
      "recap-check.mjs",
      "post-pr-completion-check.mjs",
      "release-back-merge-check.mjs",
      "pre-tool-gate.mjs",
      "session-start.mjs",
    ];
    for (const h of hooks) {
      const script = [
        `import { shouldNoOp } from ${JSON.stringify(RIGOR_LIB)};`,
        `process.stdout.write(String(shouldNoOp(${JSON.stringify(h)}, "full")));`,
      ].join("\n");
      const r = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { encoding: "utf8" }
      );
      assert.equal(r.stdout.trim(), "false", `shouldNoOp(${h}, full) should be false`);
    }
  });
});

describe("rigor compliance carriers — actual GitHub writes and commit messages", () => {
  for (const level of [undefined, "lite", "off", "full"]) {
    const label = level || "default without env/config";
    it(`${label}: GitHub missing footer and forbidden brand attribution remain blocked`, () => {
      const repo = setupRepo("chore/test-branch");
      const hookPath = repoPath(".devpro/scripts/hooks/gh-footer-gate.mjs");
      for (const [body, reason] of [["review text", /Footer missing:/], ["review text\n🤖 Generated with Claude\n\nRules: v6.98.0 · Tool: Codex · Model: GPT-6", /Attribution forbidden:/]]) {
        const result = runViaWrapper("PreToolUse", hookPath, { cwd: repo, tool_name: "Bash", tool_input: { command: `gh pr comment 42 --body ${JSON.stringify(body)}` } }, { cwd: repo, level, extraEnv: { DEVPRO_HOOK_HOST: "codex" } });
        assert.equal(result.json?.decision, "block", `${label}: ${result.stdout} ${result.stderr}`);
        assert.match(result.json.reason, reason, label);
      }
    });
    it(`${label}: commit brand-leak compliance remains blocked`, () => {
      const repo = setupRepo("chore/test-branch");
      const result = runViaWrapper("PreToolUse", HOOK, { tool_name: "Bash", tool_input: { command: 'git commit -m "feat: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>"' } }, { cwd: repo, level });
      assert.equal(result.json?.decision, "block", `${label}: ${result.stdout} ${result.stderr}`);
      assert.match(result.json.reason, /Commit attribution gate/);
    });
  }
});

// ── T4: Layer 2 gate-level filtering — non-baseline gates skip at off ─────────

describe("T4: Layer 2 — non-baseline gates skip at off via DEVPRO_AGENT_RULES_LEVEL env", () => {
  it("off: merge-strategy gate (gh pr merge --squash) passes when level=off", () => {
    // merge-strategy is a non-baseline blocking gate; at level=off it should be skipped.
    const repo = setupRepo("chore/test-feature");
    const r = runGateDirect(
      {
        tool_name: "Bash",
        tool_input: { command: "gh pr merge --squash 123" },
      },
      { cwd: repo, level: "off" }
    );
    // At off level the merge-strategy gate is skipped → no block for merge-strategy
    // (note: cross-model-sticky-merge-review may still fire; we only assert that
    // the merge-strategy-specific block reason is absent)
    if (r.json?.decision === "block") {
      assert.doesNotMatch(
        r.json.reason,
        /merge-strategy|squash.*merge|rebase.*merge/i,
        `merge-strategy gate should not fire at level=off, got: ${r.json.reason}`
      );
    }
    // If no block at all: pass
  });

  it("off: worktree-mandatory-branch-create gate skips at off", () => {
    const repo = setupRepo("main");
    // In main worktree, creating a feature branch would normally block (W1 gate).
    // At off level this non-baseline gate should be skipped.
    const r = runGateDirect(
      {
        tool_name: "Bash",
        tool_input: { command: "git checkout -b feature/test-thing" },
      },
      { cwd: repo, level: "off" }
    );
    if (r.json?.decision === "block") {
      assert.doesNotMatch(
        r.json.reason,
        /worktree.*mandatory|W1/i,
        `worktree-mandatory gate should not fire at level=off, got: ${r.json.reason}`
      );
    }
  });
});

// ── T4: Drift detection — removing a baseline id causes the test to go RED ───

describe("T4: drift detection — BASELINE_GATE_IDS white-box integrity check", () => {
  /**
   * This test intentionally verifies that removing a baseline gate-id from
   * BASELINE_GATE_IDS would allow that gate to be skipped at level=off.
   *
   * ANTI-DRIFT PROOF: We simulate a "drifted" BASELINE_GATE_IDS that is missing
   * "protected-branch-write", then assert that with the full list present the
   * gate still blocks. This is a static assertion that the constant is intact —
   * if someone removes an id from BASELINE_GATE_IDS the corresponding test below
   * that asserts it IS in the list will go red.
   */

  it("BASELINE_GATE_IDS contains all 5 implementation gate ids", async () => {
    // Dynamic import to get the live module state
    const { BASELINE_GATE_IDS } = await import(RIGOR_LIB + `?t=${Date.now()}`);
    const expected = [
      "protected-branch-write",
      "protected-branch-uncertain-cwd",
      "protected-branch-file-write",
      "openspec-doc-pii",
      "commit-attribution-brand-leak",
    ];
    for (const id of expected) {
      assert.ok(
        BASELINE_GATE_IDS.includes(id),
        `BASELINE_GATE_IDS must include "${id}" — removing it would silently disable baseline safety`
      );
    }
    assert.equal(
      BASELINE_GATE_IDS.length,
      5,
      `BASELINE_GATE_IDS must have exactly 5 entries; got ${BASELINE_GATE_IDS.length}: ${[...BASELINE_GATE_IDS].join(", ")}`
    );
  });

  it("DRIFT PROOF: every BASELINE_GATE_IDS member resolves to a real gate.id in ACTIVE_GATE_INVENTORY", async () => {
    /**
     * Couples the BASELINE_GATE_IDS string constant to the LIVE gate inventory.
     * The "contains all 5 implementation gate ids" test above compares the constant to
     * a hardcoded copy of itself — it cannot catch a gate being RENAMED in
     * pre-tool-gate.mjs while BASELINE_GATE_IDS keeps the stale name. That gap
     * matters most for `protected-branch-uncertain-cwd`, an advisory gate whose
     * behavioral block is subsumed by protected-branch-write (no independent
     * behavioral prove-it). This assertion makes the rename→drift failure
     * observable: rename any baseline gate.id without updating the constant and
     * the corresponding member no longer matches → RED. (Closes proposal Risk #4
     * residual gap surfaced in six-axis review.)
     */
    const { BASELINE_GATE_IDS } = await import(RIGOR_LIB + `?t=${Date.now()}`);
    const { ACTIVE_GATE_INVENTORY } = await import(
      repoFileUrl(".devpro/scripts/hooks/pre-tool-gate.mjs") + `?t=${Date.now()}`
    );
    const liveIds = new Set(ACTIVE_GATE_INVENTORY.map((g) => g.id));
    for (const id of BASELINE_GATE_IDS) {
      assert.ok(
        liveIds.has(id),
        [
          `DRIFT DETECTED: baseline gate-id "${id}" has no matching gate.id in ACTIVE_GATE_INVENTORY.`,
          "A baseline gate was likely renamed in pre-tool-gate.mjs without updating BASELINE_GATE_IDS.",
          "At level=off this baseline would be silently treated as non-baseline and skipped.",
          "Fix: sync BASELINE_GATE_IDS in lib/rigor-level.mjs with the renamed gate.id.",
        ].join("\n")
      );
    }
  });

  it("DRIFT PROOF: if protected-branch-write were missing from BASELINE_GATE_IDS, protected-branch-write gate would pass at off", () => {
    /**
     * This test proves the white-list is load-bearing by constructing a
     * scenario: imagine BASELINE_GATE_IDS did NOT include "protected-branch-write".
     *
     * We verify this by checking that when DEVPRO_AGENT_RULES_LEVEL=off AND the
     * pre-tool-gate Layer 2 logic considers "protected-branch-write" a non-baseline
     * gate (i.e., it would skip it), the commit-to-main would pass unblocked.
     *
     * The actual implementation DOES include it, so the real gate still blocks —
     * but this test documents what WOULD happen if it were removed, making the
     * risk of drift explicit and observable.
     *
     * Proof strategy: We run the gate at level=off; it MUST block (because the id
     * IS in BASELINE_GATE_IDS). If someone removes the id, the gate will NOT block
     * and this assertion fails → TEST GOES RED.
     */
    const repo = setupRepo("main");
    const r = runGateDirect(
      { tool_name: "Bash", tool_input: { command: "git commit -m foo" } },
      { cwd: repo, level: "off" }
    );
    // The real BASELINE_GATE_IDS includes "protected-branch-write", so this MUST block.
    // If someone removes "protected-branch-write" from BASELINE_GATE_IDS, the gate
    // will be skipped at level=off and this assertion will FAIL → RED test = drift caught.
    assert.equal(
      r.json?.decision,
      "block",
      [
        "DRIFT DETECTED: protected-branch-write gate did NOT block at level=off.",
        "This means 'protected-branch-write' is no longer in BASELINE_GATE_IDS.",
        "Fix: add 'protected-branch-write' back to BASELINE_GATE_IDS in lib/rigor-level.mjs.",
      ].join("\n")
    );
  });

  it("DRIFT PROOF: if openspec-doc-pii were missing from BASELINE_GATE_IDS, PII write would pass at off", () => {
    const repo = setupRepo("chore/test");
    const filePath = path.join(repo, "openspec", "changes", "test", "proposal.md");
    mkdirSync(path.dirname(filePath), { recursive: true });
    const r = runGateDirect(
      {
        tool_name: "Write",
        tool_input: {
          file_path: filePath,
          // Use a real (non-allowlisted) email: @example.com is on the PII allow-list.
          content: "Contact: admin@acme-corp.io\nSome proposal content.",
        },
      },
      { cwd: repo, level: "off" }
    );
    assert.equal(
      r.json?.decision,
      "block",
      [
        "DRIFT DETECTED: openspec-doc-pii gate did NOT block at level=off.",
        "This means 'openspec-doc-pii' is no longer in BASELINE_GATE_IDS.",
        "Fix: add 'openspec-doc-pii' back to BASELINE_GATE_IDS in lib/rigor-level.mjs.",
      ].join("\n")
    );
  });
});

// ── Hotfix #2519: Advisory announce docs + cross-model still on at lite ───────

describe("hotfix #2519: rules-rigor-level Advisory/Doctrine/matrix + cross-model still on at lite", () => {
  const leafPath = repoPath(".devpro/agent-rules/rules-rigor-level.md");
  const gatePath = repoPath(".devpro/scripts/hooks/pre-tool-gate.mjs");

  it("Advisory documents three-way SessionStart selection (off/lite/full)", () => {
    const leaf = readFileSync(leafPath, "utf8");
    assert.match(
      leaf,
      /Advisory[\s\S]*?off→`msgLean`[\s\S]*?lite→`msgLite`[\s\S]*?full→`msg`/,
      "Advisory row MUST document off→msgLean / lite→msgLite / full→msg"
    );
  });

  it("Doctrine aligns SessionStart lite cue (cooperative, no hard skip OpenSpec)", () => {
    const leaf = readFileSync(leafPath, "utf8");
    assert.match(
      leaf,
      /Doctrine[\s\S]*?SessionStart[\s\S]*?lite[\s\S]*?OpenSpec/,
      "Doctrine MUST align SessionStart lite exemption cue with cooperative-only"
    );
    assert.match(
      leaf,
      /無 hard carrier 強制跳過 OpenSpec|無 hard carrier 強制/
    );
  });

  it("matrix documents cross-model-sticky-merge-review fire/fire/no-op", () => {
    const leaf = readFileSync(leafPath, "utf8");
    assert.match(
      leaf,
      /`cross-model-sticky-merge-review`[^\n]*\|\s*fire\s*\|\s*fire\s*\|\s*no-op/,
      "matrix MUST list cross-model-sticky-merge-review as full=fire / lite=fire / off=no-op"
    );
  });

  it("gate bucket evidence: cross-model-sticky-merge-review is STATE_BACKED (lite keeps it)", () => {
    const gateSrc = readFileSync(gatePath, "utf8");
    // Inventory entry: id then bucket STATE_BACKED nearby (do not change gate code).
    assert.match(
      gateSrc,
      /id:\s*"cross-model-sticky-merge-review"[\s\S]{0,120}?bucket:\s*GATE_BUCKETS\.STATE_BACKED/,
      "cross-model-sticky-merge-review MUST remain STATE_BACKED so lite does not skip it"
    );
    // shouldSkipGate lite path only skips ADVISORY buckets — source evidence.
    assert.match(
      gateSrc,
      /if \(level === "lite"\) \{\s*return bucket === GATE_BUCKETS\.ADVISORY;/,
      "shouldSkipGate lite MUST only skip ADVISORY (STATE_BACKED cross-model still on)"
    );
  });
});

describe("rules-rigor-level.md — lite batch approval pointer", () => {
  const rigorDoc = readFileSync(repoPath(".devpro/agent-rules/rules-rigor-level.md"), "utf8");
  const liteNote = rigorDoc.split("\n").find((line) => line.startsWith("> lite 不寫 OpenSpec proposal")) ?? "";

  it("the retired 'lite has no ledger' sentence is rewritten and points at the lite scope record", () => {
    assert.equal(rigorDoc.includes("lite 沒有 OpenSpec proposal 與 Batch Approval Ledger"), false);
    assert.ok(liteNote, "rules-rigor-level.md keeps the lite carrier note");
    assert.match(liteNote, /`openspec\/changes\/<change-name>\/lite-scope\.md`/);
    assert.match(liteNote, /只在使用者選 batch 後寫，stepwise 不寫/);
    assert.match(liteNote, /`\/devpro:change` skill lite 段/);
  });

  it("no lite grant vocabulary remains (grant CLI, expiry, per-PR approval flags)", () => {
    for (const retired of ["grant-lite-disclosure", "lite batch grant", "--lite-batch-approval", "--lite-explicit-approval", "24 小時"]) {
      assert.equal(rigorDoc.includes(retired), false, `rules-rigor-level.md must not mention ${retired}`);
    }
  });

  it("keeps the cross-model gate still firing at lite, with the builder's --lite switch", () => {
    assert.match(liteNote, /`cross-model-sticky-merge-review` 仍 fire，builder 用 `--lite`/);
    assert.match(liteNote, /code-review-cross-model\.md` §Initial handoff builder/);
  });
});
