/**
 * hook-pre-tool-gate-codex-cwd.test.mjs
 *
 * Prove-it tests (TDD) for Codex protected-branch diagnostic (T1, issue #649).
 *
 * Test strategy:
 *   - case A (positive): Codex payload with all cwd/workdir fields absent +
 *     plain `git add` (no `git -C`) → fallback-only proof gap advisory,
 *     not a hard block.
 *
 *   - case B (reverse — has cwd evidence): tool_input.cwd points to main
 *     worktree + `git add x` → expect decision: "block" and a cwd evidence
 *     snapshot whose `source=` names the supplying payload field.
 *     STATUS: PASS (regression baseline).
 *
 *   - case C (reverse — git -C): no cwd in payload + `git -C <worktree> add x`
 *     → expect no block (regression: Git C Flag Remains Per-Invocation Override).
 *     STATUS: PASS (regression baseline).
 *
 *   - case D/E (reverse locks): protected-branch bare writes still block;
 *     `UNRESOLVABLE_CWD` (`cd "$WT"`) and Codex fallback-only evidence stay
 *     advisory, never block.
 *
 * Assertions read the fixed-order cwd evidence snapshot
 * (`Cwd evidence：source=… baseCwd=… resolved=… chdir=… gitC=…`) instead of the
 * retired diagnostic triad, plus reason.includes(...) containment for the
 * remaining guidance text.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

const tmpRoot = makeTempDir("pre-tool-gate-codex-cwd-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// Minimal preflight-checklist.md fixture (same as hook-pre-tool-gate.test.mjs)
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

function setupRepoWithWorktree(worktreeBranch = "bugfix/hook-cwd") {
  const repo = setupRepo("main");
  const wt = path.join(tmpRoot, `wt-${repoCounter++}`);
  spawnSync("git", ["worktree", "add", "-b", worktreeBranch, wt, "HEAD"], {
    cwd: repo,
    stdio: "ignore",
  });
  writeFileSync(path.join(wt, "x"), "worktree change\n");
  return { repo, wt };
}

/**
 * run() — invoke the hook with a synthetic PreToolUse payload on stdin.
 *
 * @param {object} payload  — full JSON payload passed to the hook
 * @param {object} opts
 *   cwd        — filesystem cwd for the hook process (also sets PWD)
 *   env        — extra environment overrides
 *   sentinelDir — optional DEVPRO_SENTINEL_STATE_DIR (fresh tmp used if omitted)
 */
function run(payload, { cwd, env, sentinelDir } = {}) {
  const tempSentinelDir =
    sentinelDir || makeTempDir("sentinel-codex-test-");
  try {
    const hookCwd = cwd || process.cwd();
    const fullEnv = {
      ...process.env,
      // Codex detection env vars — cleared by default (tests opt-in as needed)
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_SENTINEL_STATE_DIR: tempSentinelDir,
      PWD: hookCwd,
      ...(env || {}),
    };
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      cwd: hookCwd,
      env: fullEnv,
    });
    let parsed = null;
    if (result.stdout && result.stdout.trim()) {
      try {
        parsed = JSON.parse(result.stdout);
      } catch {}
    }
    return {
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      json: parsed,
    };
  } finally {
    if (!sentinelDir) {
      try {
        rmSync(tempSentinelDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

/**
 * Read the protected-branch cwd evidence snapshot back out of the emitted text.
 * Fixed item order, basenames only:
 * `Cwd evidence：source=… baseCwd=… resolved=… chdir=yes|no gitC=yes|no`.
 * The same shape `hook-pre-tool-gate-cwd-evidence.test.mjs` owns; this file only
 * asserts the tokens it needs for the decision-unchanged locks.
 */
const CWD_EVIDENCE_RE =
  /Cwd evidence：source=(\S+) baseCwd=(\S+) resolved=(\S+) chdir=(yes|no) gitC=(yes|no)/;

function cwdEvidence(reason) {
  const m = CWD_EVIDENCE_RE.exec(reason);
  assert.ok(m, `cwd evidence snapshot missing; got: ${reason}`);
  return {
    source: m[1],
    baseCwd: m[2],
    resolved: m[3],
    chdir: m[4],
    gitC: m[5],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// case A (positive — fallback-only proof gap advisory)
// ─────────────────────────────────────────────────────────────────────────

test("Codex CWD diagnostic: all cwd/workdir fields absent + plain git add → fallback-only proof-gap advisory", () => {
  // Set up main repo + linked worktree; hook process PWD remains main while
  // the target worktree cannot be proven from payload or command text.
  const { repo } = setupRepoWithWorktree();

  // Codex payload: tool_input and all 10 top-level cwd/workdir fields absent.
  // Mirrors real Codex functions.exec_command hook invocation where runtime does NOT
  // inject cwd into payload (issue #649 scenario).
  const payload = {
    tool_name: "functions.exec_command",
    // No top-level cwd / workdir / working_dir / workingDir /
    // current_working_directory / currentWorkingDirectory fields.
    tool_input: {
      // No cwd / workdir / working_dir / workingDir fields.
      command: "git add some/path",
      // No git -C flag in command.
    },
  };

  // PWD is set to repo (main), which causes toolInputCwd() to fall back to
  // process.cwd() → main → Gate 1 fires.
  const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

  assert.notEqual(
    r.json?.decision,
    "block",
    `fallback-only evidence must not hard-block, got: ${JSON.stringify(r.json)}`
  );

  const reason =
    r.json?.systemMessage ??
    r.json?.hookSpecificOutput?.additionalContext ??
    r.stderr ??
    "";

  assert.match(reason, /fallback-only evidence/);
  assert.match(reason, /target branch\/worktree could not be proven/);
  assert.match(reason, /git -C <abs-worktree>/);
  assert.match(reason, /\.devpro\/agent-rules\/git-branch-naming-and-anchor\.md § Worktree 規範/);
  assert.doesNotMatch(reason, /DEVPRO_HOOK_BYPASS/);

  // The retired triad is replaced by the snapshot: fallback provenance from
  // `PWD`, base cwd = the hook cwd, and a plain `git add` (no chdir/git -C).
  const ev = cwdEvidence(reason);
  assert.match(
    ev.source,
    /^(env\.PWD|process\.cwd\(\))$/,
    `advisory must report the fallback source token; got: ${reason}`
  );
  assert.equal(ev.baseCwd, path.basename(repo), `base cwd basename; got: ${reason}`);
  assert.equal(ev.resolved, path.basename(repo), `resolved basename; got: ${reason}`);
  assert.equal(ev.chdir, "no", `plain git add has no chdir prefix; got: ${reason}`);
  assert.equal(ev.gitC, "no", `plain git add has no git -C; got: ${reason}`);
  assert.ok(
    reason.includes("platform-adapters/codex.md"),
    `reason should reference "platform-adapters/codex.md"; got: ${reason}`
  );
  assert.ok(
    reason.includes("Protected-Branch git Write Rule"),
    `reason should contain "Protected-Branch git Write Rule"; got: ${reason}`
  );
});

test("Codex CWD diagnostic: DEVPRO_HOOK_HOST=codex preserves fallback-only advisory when CODEX env is absent", () => {
  const { repo } = setupRepoWithWorktree();

  const payload = {
    tool_name: "functions.exec_command",
    tool_input: {
      command: "git add some/path",
    },
  };

  const r = run(payload, {
    cwd: repo,
    env: {
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_HOOK_HOST: "codex",
    },
  });

  assert.notEqual(
    r.json?.decision,
    "block",
    `codex host marker fallback-only evidence must not hard-block, got: ${JSON.stringify(r.json)}`
  );

  const reason =
    r.json?.systemMessage ??
    r.json?.hookSpecificOutput?.additionalContext ??
    r.stderr ??
    "";

  assert.match(reason, /fallback-only evidence/);
  assert.match(reason, /target branch\/worktree could not be proven/);
});

test("Codex CWD diagnostic: missing Codex env and host marker + plain git add on main still blocks", () => {
  const repo = setupRepo("main");

  const payload = {
    tool_name: "functions.exec_command",
    tool_input: {
      command: "git add some/path",
    },
  };

  const r = run(payload, {
    cwd: repo,
    env: {
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_HOOK_HOST: "",
    },
  });

  assert.equal(
    r.json?.decision,
    "block",
    `non-Codex fallback protected evidence should still block, got: ${JSON.stringify(r.json)}`
  );
  assert.match(r.json?.reason ?? "", /Protected-branch gate/);
});

// ─────────────────────────────────────────────────────────────────────────
// case B (reverse — has cwd evidence → existing reason path + payload-sourced snapshot)
// ─────────────────────────────────────────────────────────────────────────

test("Codex CWD diagnostic: tool_input.cwd points to main + git add → block with payload-sourced snapshot (no fallback-only advisory)", () => {
  // Set up main repo (protected).
  const repo = setupRepo("main");

  // tool_input.cwd is provided and points to the main repo.
  // toolInputCwd() resolves evidence → gate blocks via existing reason path.
  // The three-part diagnostic must NOT appear (not a Codex-absence scenario).
  const payload = {
    tool_name: "functions.exec_command",
    tool_input: {
      cwd: repo,
      command: "git add x",
    },
  };

  const r = run(payload, { cwd: repo });

  // Base assertion: Gate 1 still blocks (cwd points to protected main).
  assert.equal(
    r.json?.decision,
    "block",
    `Expected decision: "block", got: ${JSON.stringify(r.json)}`
  );

  const reason = r.json?.reason ?? "";

  // Payload-supplied cwd is the provenance (not fallback PWD): the snapshot must
  // name the supplying field, and the matched invocation is a plain `git add`.
  const ev = cwdEvidence(reason);
  assert.equal(ev.source, "tool_input.cwd", `source must name the payload field; got: ${reason}`);
  assert.equal(ev.baseCwd, path.basename(repo), `base cwd basename; got: ${reason}`);
  assert.equal(ev.resolved, path.basename(repo), `resolved basename; got: ${reason}`);
  assert.equal(ev.chdir, "no", `plain git add has no chdir prefix; got: ${reason}`);
  assert.equal(ev.gitC, "no", `plain git add has no git -C; got: ${reason}`);
  // Not a Codex cwd-absence scenario → the fallback-only advisory never appears.
  assert.doesNotMatch(
    reason,
    /fallback-only evidence/,
    `reason must NOT carry the fallback-only advisory when cwd is provided; got: ${reason}`
  );
  assert.doesNotMatch(
    reason,
    /Protected-Branch git Write Rule/,
    `reason must NOT contain "Protected-Branch git Write Rule" when cwd is provided; got: ${reason}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// case R2 (reverse lock — UNRESOLVABLE_CWD stays advisory, never blocks)
// A non-static `cd` (`$VAR`, `$(...)`) leaves the per-match cwd unresolvable,
// so the protected write is uncertain and MUST fail open (advisory) even when
// the fallback PWD is a protected checkout.
// ─────────────────────────────────────────────────────────────────────────

for (const [label, command] of [
  ["variable cd", 'cd "$WT" && git add x'],
  ["subshell cd", 'cd "$(git rev-parse --show-toplevel)" && git add x'],
]) {
  test(`Codex CWD diagnostic: ${label} leaves the write cwd unresolvable → advisory, not block`, () => {
    const repo = setupRepo("main");

    const r = run(
      { tool_name: "functions.exec_command", tool_input: { command } },
      { cwd: repo, env: { CODEX_CI: "1" } }
    );

    assert.notEqual(
      r.json?.decision,
      "block",
      `UNRESOLVABLE_CWD must stay advisory (fail-open), got: ${JSON.stringify(r.json)}`
    );

    const reason =
      r.json?.systemMessage ??
      r.json?.hookSpecificOutput?.additionalContext ??
      r.stderr ??
      "";
    assert.match(
      reason,
      /無法靜態判定其目標分支\/目錄/,
      `uncertain-cwd advisory must fire; got: ${reason}`
    );
    // The uncertain path reports the shared snapshot with the target left unresolved.
    assert.match(reason, /Cwd evidence：source=\S+ baseCwd=\S+ resolved=\(unresolved\) chdir=(yes|no) gitC=(yes|no)/);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// case C (reverse — git -C → no block, regression baseline)
// Mirrors: "Gate 1: git -C <worktree> add from hook cwd main → pass"
// scenario name in proposal: "Git C Flag Remains Per-Invocation Override"
// ─────────────────────────────────────────────────────────────────────────

for (const branchName of ["feature/hook-cwd", "bugfix/hook-cwd"]) {
  test(`Codex CWD diagnostic: no cwd in payload + git -C <${branchName}> add → NOT blocked and no fallback-only advisory`, () => {
    // Set up main repo + worktree on a non-protected branch.
    const { repo, wt } = setupRepoWithWorktree(branchName);

    // Payload has no cwd fields at all (mimics Codex absence scenario), and the
    // hook process PWD remains main, but the command explicitly targets the
    // linked worktree. That git -C evidence must win over fallback PWD.
    const payload = {
      tool_name: "functions.exec_command",
      // No top-level cwd/workdir fields.
      tool_input: {
        // No cwd/workdir fields.
        command: `git -C ${wt} add x`,
      },
    };

    const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

    // Gate 1 must NOT block: `git -C <worktree>` targets a non-protected branch.
    assert.equal(
      r.json?.decision,
      undefined,
      `should not block when git -C targets non-protected worktree, got: ${JSON.stringify(r.json)}`
    );
    assert.equal(
      r.code,
      0,
      `hook should exit 0, got: ${r.code}; stderr: ${r.stderr}`
    );

    const output = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(output, /fallback-only evidence/);
    assert.doesNotMatch(output, /target branch\/worktree could not be proven/);
    assert.doesNotMatch(output, /Protected-branch gate proof gap/);
  });
}

test("Codex CWD diagnostic: no cwd in payload + git -C <main> add → hard-blocks as confirmed main evidence", () => {
  const repo = setupRepo("main");

  const payload = {
    tool_name: "functions.exec_command",
    // No top-level cwd/workdir fields.
    tool_input: {
      // No cwd/workdir fields. The command itself confirms the protected cwd.
      command: `git -C ${repo} add x`,
    },
  };

  const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

  assert.equal(
    r.json?.decision,
    "block",
    `Expected decision: "block", got: ${JSON.stringify(r.json)}`
  );

  const reason = r.json?.reason ?? "";
  assert.match(reason, /Protected-branch gate/);
  assert.match(reason, /`main`/);
  assert.match(reason, /\.devpro\/agent-rules\/git-branch-naming-and-anchor\.md § Worktree 規範/);
  assert.match(reason, /git -C <abs-worktree>/);
  assert.doesNotMatch(reason, /DEVPRO_HOOK_BYPASS/);
  assert.doesNotMatch(reason, /fallback-only evidence/);
  assert.doesNotMatch(reason, /target branch\/worktree could not be proven/);
  assert.doesNotMatch(reason, /Protected-branch gate proof gap/);
});

// ─────────────────────────────────────────────────────────────────────────
// case E (hook-visible cd → confirmed protected evidence, not fallback-only)
// Spec: "Confirmed Protected Evidence Still Blocks Under Codex" lists
// `cd <main-checkout>` before a protected git write as confirmed evidence.
// ─────────────────────────────────────────────────────────────────────────

for (const [label, chdir] of [
  ["cd with &&", (repo) => `cd ${repo} && git add x`],
  ["cd with ;", (repo) => `cd ${repo}; git add x`],
  ["builtin cd", (repo) => `builtin cd ${repo} && git add x`],
  ["pushd", (repo) => `pushd ${repo} && git add x`],
]) {
  test(`Codex CWD diagnostic: no cwd in payload + ${label} <main> before git add → hard-blocks, not advisory`, () => {
    const repo = setupRepo("main");

    const payload = {
      tool_name: "functions.exec_command",
      tool_input: { command: chdir(repo) },
    };

    const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

    assert.equal(
      r.json?.decision,
      "block",
      `hook-visible cd to a protected checkout is confirmed evidence, got: ${JSON.stringify(r.json)}`
    );
    const reason = r.json?.reason ?? "";
    assert.match(reason, /Protected-branch gate/);
    assert.doesNotMatch(reason, /fallback-only evidence/);
    assert.doesNotMatch(reason, /Protected-branch gate proof gap/);
    // The cd itself confirms the checkout, so the snapshot must record the
    // hook-visible chdir prefix (`chdir=yes`) and no `git -C` in this match.
    const ev = cwdEvidence(reason);
    assert.equal(ev.chdir, "yes", `absolute cd prefix must be reported; got: ${reason}`);
    assert.equal(ev.gitC, "no", `no git -C in the matched invocation; got: ${reason}`);
    assert.match(
      ev.source,
      /^(env\.PWD|process\.cwd\(\))$/,
      `no payload cwd → fallback source token; got: ${reason}`
    );
  });
}

test("Codex CWD diagnostic: a cd that only appears inside quoted text is not hook-visible → still fallback-only advisory", () => {
  const { repo } = setupRepoWithWorktree();

  const payload = {
    tool_name: "functions.exec_command",
    tool_input: { command: `echo "cd ${repo}"; git add x` },
  };

  const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

  assert.notEqual(
    r.json?.decision,
    "block",
    `quoted cd text is data, not evidence; must stay advisory, got: ${JSON.stringify(r.json)}`
  );
  const reason =
    r.json?.systemMessage ??
    r.json?.hookSpecificOutput?.additionalContext ??
    r.stderr ??
    "";
  assert.match(reason, /fallback-only evidence/);
});

test("Codex CWD diagnostic: a cd after the git write does not count as evidence for it → still fallback-only advisory", () => {
  const { repo } = setupRepoWithWorktree();

  const payload = {
    tool_name: "functions.exec_command",
    tool_input: { command: `git add x && cd ${repo}` },
  };

  const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

  assert.notEqual(
    r.json?.decision,
    "block",
    `a trailing cd cannot retroactively prove the cwd of the earlier write, got: ${JSON.stringify(r.json)}`
  );
  const reason =
    r.json?.systemMessage ??
    r.json?.hookSpecificOutput?.additionalContext ??
    r.stderr ??
    "";
  assert.match(reason, /fallback-only evidence/);
});

test("Codex CWD diagnostic: a relative cd cannot prove the cwd from a fallback PWD → still fallback-only advisory", () => {
  // `sub` exists under both checkouts. Codex's real cwd may be the worktree,
  // so resolving `cd sub` against the fallback PWD (main) proves nothing.
  const { repo, wt } = setupRepoWithWorktree();
  for (const dir of [repo, wt]) {
    mkdirSync(path.join(dir, "sub"), { recursive: true });
  }

  const payload = {
    tool_name: "functions.exec_command",
    tool_input: { command: "cd sub && git add x" },
  };

  const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

  assert.notEqual(
    r.json?.decision,
    "block",
    `a relative cd resolved from the fallback PWD is not confirmed evidence, got: ${JSON.stringify(r.json)}`
  );
  const reason =
    r.json?.systemMessage ??
    r.json?.hookSpecificOutput?.additionalContext ??
    r.stderr ??
    "";
  assert.match(reason, /fallback-only evidence/);
});

test("Codex CWD diagnostic: a relative cd whose .. hops reach / still cannot prove the cwd → still fallback-only advisory", () => {
  // `../` x N climbs to `/` from the fallback PWD and from any shallower base alike, then descends to the main
  // checkout; a deeper real cwd (a worktree) would land elsewhere. Resolving identically from two bases is not
  // evidence — only a cd target that is itself absolute is.
  const { repo } = setupRepoWithWorktree();
  const real = realpathSync(repo);
  const rel = path.relative(path.parse(real).root, real);
  const hops = "../".repeat(real.split(path.sep).filter(Boolean).length + 1);

  const payload = {
    tool_name: "functions.exec_command",
    tool_input: { command: `cd ${hops}${rel} && git add x` },
  };

  const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

  assert.notEqual(
    r.json?.decision,
    "block",
    `a relative cd is never base-independent, however many .. hops it takes, got: ${JSON.stringify(r.json)}`
  );
  const reason =
    r.json?.systemMessage ??
    r.json?.hookSpecificOutput?.additionalContext ??
    r.stderr ??
    "";
  assert.match(reason, /fallback-only evidence/);
});

test("Codex CWD diagnostic: an absolute cd followed by a relative cd keeps the cwd pinned → hard-blocks", () => {
  const repo = setupRepo("main");
  mkdirSync(path.join(repo, "sub"), { recursive: true });

  const payload = {
    tool_name: "functions.exec_command",
    tool_input: { command: `cd ${repo} && cd sub && git add x` },
  };

  const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

  assert.equal(
    r.json?.decision,
    "block",
    `the absolute cd pins the base for the relative one that follows, got: ${JSON.stringify(r.json)}`
  );
  assert.doesNotMatch(r.json?.reason ?? "", /fallback-only evidence/);
});

test("Codex CWD diagnostic: pushd <abs> then popd returns to the unproven cwd → still fallback-only advisory", () => {
  const { repo } = setupRepoWithWorktree();

  const payload = {
    tool_name: "functions.exec_command",
    tool_input: { command: `pushd ${repo} && popd && git add x` },
  };

  const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

  assert.notEqual(
    r.json?.decision,
    "block",
    `popd restores the pre-pushd cwd, which was never proven, got: ${JSON.stringify(r.json)}`
  );
  const reason =
    r.json?.systemMessage ??
    r.json?.hookSpecificOutput?.additionalContext ??
    r.stderr ??
    "";
  assert.match(reason, /fallback-only evidence/);
});

test("Codex CWD diagnostic: cd to a non-protected worktree before git add → neither blocked nor advised", () => {
  const { repo, wt } = setupRepoWithWorktree();

  const payload = {
    tool_name: "functions.exec_command",
    tool_input: { command: `cd ${wt} && git add x` },
  };

  const r = run(payload, { cwd: repo, env: { CODEX_CI: "1" } });

  assert.equal(
    r.json?.decision,
    undefined,
    `cd to a worktree resolves the write there, got: ${JSON.stringify(r.json)}`
  );
  const output = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(output, /fallback-only evidence/);
  assert.doesNotMatch(output, /Protected-branch gate proof gap/);
});

test("Codex CWD diagnostic: tool_input.workdir points to worktree + plain git add → NOT blocked", () => {
  const { repo, wt } = setupRepoWithWorktree();

  const payload = {
    tool_name: "functions.exec_command",
    tool_input: {
      workdir: wt,
      command: "git add x",
    },
  };

  const r = run(payload, { cwd: repo });

  assert.equal(
    r.json?.decision,
    undefined,
    `should not block when tool_input.workdir targets non-protected worktree, got: ${JSON.stringify(r.json)}`
  );
  assert.equal(
    r.code,
    0,
    `hook should exit 0, got: ${r.code}; stderr: ${r.stderr}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// case D (multi-segment, stash filter — Finding 1, PR #661 review)
// Command: `git stash list && git add some/path`
// The first segment is a read-only stash invocation (filtered); the violation
// is in the second segment. The guidance verb must be `add`, not `stash`.
// ─────────────────────────────────────────────────────────────────────────

test("Codex CWD diagnostic: multi-segment stash+add → block with verb=add in guidance (not stash)", () => {
  const repo = setupRepo("main");

  // No cwd/workdir fields anywhere — full Codex absence fingerprint.
  const payload = {
    tool_name: "functions.exec_command",
    tool_input: {
      command: "git stash list && git add some/path",
    },
  };

  const r = run(payload, { cwd: repo });

  assert.equal(
    r.json?.decision,
    "block",
    `Expected decision: "block", got: ${JSON.stringify(r.json)}`
  );

  const reason = r.json?.reason ?? "";

  // Snapshot replaces the retired triad: fallback provenance from `PWD`, base
  // cwd = the hook cwd, and a plain `git add` (no chdir/`git -C`).
  const ev = cwdEvidence(reason);
  assert.match(
    ev.source,
    /^(env\.PWD|process\.cwd\(\))$/,
    `fallback source token; got: ${reason}`
  );
  assert.equal(ev.baseCwd, path.basename(repo), `base cwd basename; got: ${reason}`);
  assert.equal(ev.resolved, path.basename(repo), `resolved basename; got: ${reason}`);
  assert.equal(ev.chdir, "no", `no chdir prefix; got: ${reason}`);
  assert.equal(ev.gitC, "no", `no git -C in the matched invocation; got: ${reason}`);
  assert.match(reason, /\.devpro\/agent-rules\/git-branch-naming-and-anchor\.md § Worktree 規範/);

  // Critical: the guidance snippet must show `add`, NOT `stash`.
  // (Finding 1: guidance must scope to the violating segment, not re-scan raw cmd.)
  assert.ok(
    reason.includes("git -C <abs-worktree> add"),
    `guidance verb must be "add" (not "stash"); got: ${reason}`
  );
  assert.ok(
    !reason.includes("git -C <abs-worktree> stash"),
    `guidance verb must NOT be "stash"; got: ${reason}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// case E (multi-segment, git -C in earlier read-only segment — Finding 1)
// Command: `git -C /tmp/somewhere status; git add some/path`
// An earlier segment has `git -C` but is read-only (status). The violating
// segment (`git add`) has no `-C`. Diagnostic must NOT be suppressed.
// ─────────────────────────────────────────────────────────────────────────

test("Codex CWD diagnostic: git -C in earlier read-only segment must not suppress diagnostic for later plain git add", () => {
  const repo = setupRepo("main");

  // No cwd/workdir fields anywhere — full Codex absence fingerprint.
  const payload = {
    tool_name: "functions.exec_command",
    tool_input: {
      command: "git -C /tmp/somewhere status; git add some/path",
    },
  };

  const r = run(payload, { cwd: repo });

  assert.equal(
    r.json?.decision,
    "block",
    `Expected decision: "block", got: ${JSON.stringify(r.json)}`
  );

  const reason = r.json?.reason ?? "";

  // Snapshot replaces the retired triad. Lock: an earlier read-only `git -C` in
  // another segment must NOT leak into this invocation's `gitC=` (scope =
  // matchedSegment, not the raw command), and must not suppress the block.
  const ev = cwdEvidence(reason);
  assert.equal(ev.gitC, "no", `earlier read-only \`git -C\` must not leak into gitC=; got: ${reason}`);
  assert.equal(ev.chdir, "no", `no chdir prefix; got: ${reason}`);
  assert.match(
    ev.source,
    /^(env\.PWD|process\.cwd\(\))$/,
    `fallback source token; got: ${reason}`
  );
  assert.equal(ev.baseCwd, path.basename(repo), `base cwd basename; got: ${reason}`);
  assert.equal(ev.resolved, path.basename(repo), `resolved basename; got: ${reason}`);
  assert.match(reason, /\.devpro\/agent-rules\/git-branch-naming-and-anchor\.md § Worktree 規範/);
  assert.ok(
    reason.includes("git -C <abs-worktree> add"),
    `guidance verb must be "add"; got: ${reason}`
  );
});
