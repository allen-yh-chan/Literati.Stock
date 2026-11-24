/**
 * hook-pre-tool-gate-cwd-evidence.test.mjs
 *
 * Prove-it tests (T1) for the protected-branch cwd evidence snapshot
 * (`Protected-Branch Gate Cwd Evidence Snapshot` in
 * `openspec/changes/fix-protected-branch-gate-payload-cwd/specs/pre-tool-mechanical-gates/spec.md`).
 *
 * Strategy: drive the real hook entry point (spawned `pre-tool-gate.mjs` with a
 * synthetic PreToolUse payload on stdin — same fixture style as
 * `hook-pre-tool-gate-codex-cwd.test.mjs`) and read the one-line snapshot back
 * out of the emitted reason. No second payload-simulation path is introduced.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
// Namespace import: `requireGateExport()` turns a missing renderer export into a
// per-scenario assertion message instead of an ESM link error that aborts the file.
// The snapshot renderer is exported today; the guard keeps a future rename from
// failing only at import time.
import * as preToolGate from "../hooks/pre-tool-gate.mjs";
import { UNRESOLVABLE_CWD } from "../hooks/lib/hook-command-context.mjs";

function requireGateExport(name) {
  const fn = preToolGate[name];
  assert.equal(
    typeof fn,
    "function",
    `pre-tool-gate.mjs must export ${name}() for the cwd evidence snapshot`
  );
  return fn;
}

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

const tmpRoot = makeTempDir("pre-tool-gate-cwd-evidence-test-");

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

function setupRepoWithWorktree(worktreeBranch = "bugfix/cwd-evidence") {
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
 * Same contract as `hook-pre-tool-gate-codex-cwd.test.mjs`.
 */
function run(payload, { cwd, env, sentinelDir } = {}) {
  const tempSentinelDir = sentinelDir || makeTempDir("sentinel-cwd-evidence-test-");
  try {
    const hookCwd = cwd || process.cwd();
    const fullEnv = {
      ...process.env,
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

function reasonOf(r) {
  return (
    r.json?.reason ??
    r.json?.systemMessage ??
    r.json?.hookSpecificOutput?.additionalContext ??
    r.stderr ??
    ""
  );
}

/** Parse the fixed-order snapshot line back into its items. */
function cwdEvidence(reason) {
  const m =
    /Cwd evidence：source=(\S+) baseCwd=(\S+) resolved=(\S+) chdir=(yes|no) gitC=(yes|no)/.exec(
      reason
    );
  if (!m) return null;
  return {
    line: m[0],
    source: m[1],
    baseCwd: m[2],
    resolved: m[3],
    chdir: m[4],
    gitC: m[5],
  };
}

function assertSnapshot(reason, label) {
  const ev = cwdEvidence(reason);
  assert.ok(ev, `cwd evidence snapshot missing for ${label}; got: ${reason}`);
  return ev;
}

// ─────────────────────────────────────────────────────────────────────────
// Scenario: Definite Block Reports The Cwd Evidence Items
// (all three block exits: git commit, content-materialize, broad write)
// ─────────────────────────────────────────────────────────────────────────

test("Protected-branch gate cwd evidence: Definite Block Reports The Cwd Evidence Items", () => {
  const repo = setupRepo("main");
  const repoBase = path.basename(repo);

  const cases = [
    ["broad write", "git add x"],
    ["git commit", "git commit -m x"],
    ["content-materialize", "git checkout HEAD -- x"],
  ];

  for (const [label, command] of cases) {
    // Payload carries no cwd/workdir field at all → fallback source token.
    const r = run(
      { tool_name: "Bash", tool_input: { command } },
      { cwd: repo }
    );

    assert.equal(
      r.json?.decision,
      "block",
      `${label} must hard-block on a protected branch, got: ${JSON.stringify(r.json)}`
    );

    const reason = reasonOf(r);
    assert.match(reason, /Protected-branch gate/, `${label} reason: ${reason}`);

    const ev = assertSnapshot(reason, label);
    assert.match(
      ev.source,
      /^(env\.PWD|process\.cwd\(\))$/,
      `${label} must report a fallback source token, got: ${ev.source}`
    );
    assert.equal(ev.baseCwd, repoBase, `${label} base cwd basename`);
    assert.equal(ev.resolved, repoBase, `${label} resolved basename`);
    assert.equal(ev.chdir, "no", `${label} chdir`);
    assert.equal(ev.gitC, "no", `${label} gitC`);

    // Exactly one recommended git-write form (`git -C <abs-worktree> ...`).
    assert.equal(
      (reason.match(/git -C <abs-worktree>/g) || []).length,
      1,
      `${label} must carry the single \`git -C <abs-worktree>\` suggestion form; got: ${reason}`
    );
    // T4: the cd-prefixed form is retired; add/commit must be separate calls.
    assert.ok(
      !reason.includes("cd <abs-worktree> && git "),
      `${label} must not recommend the retired cd-prefixed git write form; got: ${reason}`
    );
    assert.match(
      reason,
      /分兩次 Bash 呼叫/,
      `${label} must state that git add and git commit are separate Bash calls; got: ${reason}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario: Payload Supplied Cwd Is Reported Truthfully
// ─────────────────────────────────────────────────────────────────────────

test("Protected-branch gate cwd evidence: Payload Supplied Cwd Is Reported Truthfully", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const repoBase = path.basename(repo);
  const wtBase = path.basename(wt);

  // Top-level payload cwd = linked worktree; the matched invocation itself is
  // `git -C <protected-checkout> add`, so the write definitely targets `main`.
  const payload = {
    tool_name: "Bash",
    cwd: wt,
    tool_input: { command: `git -C ${repo} add x` },
  };

  const r = run(payload, { cwd: repo });

  assert.equal(
    r.json?.decision,
    "block",
    `git -C <protected-checkout> add must block, got: ${JSON.stringify(r.json)}`
  );

  const reason = reasonOf(r);
  const ev = assertSnapshot(reason, "payload-supplied cwd");
  assert.equal(ev.source, "cwd", "source must name the supplying payload field");
  assert.equal(ev.baseCwd, wtBase, "base cwd is the payload-supplied worktree");
  assert.equal(
    ev.resolved,
    repoBase,
    "resolved must be the per-write `git -C` target, never backfilled from base cwd"
  );
  assert.notEqual(ev.resolved, ev.baseCwd, "resolved must differ from base cwd here");
  assert.equal(ev.chdir, "no", "the matched invocation has no chdir prefix");
  assert.equal(ev.gitC, "yes", "the matched invocation carries an explicit git -C");
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario: Fallback-Only Advisory Carries The Same Snapshot
// ─────────────────────────────────────────────────────────────────────────

test("Protected-branch gate cwd evidence: Fallback-Only Advisory Carries The Same Snapshot", () => {
  const { repo, wt } = setupRepoWithWorktree();
  // `sub` exists under both checkouts so a relative `cd sub` cannot prove the cwd.
  for (const dir of [repo, wt]) {
    mkdirSync(path.join(dir, "sub"), { recursive: true });
  }

  // 1) plain git add, no chdir prefix → chdir=no, gitC=no, fallback source.
  const plain = run(
    { tool_name: "functions.exec_command", tool_input: { command: "git add x" } },
    { cwd: repo, env: { CODEX_CI: "1" } }
  );

  assert.notEqual(
    plain.json?.decision,
    "block",
    `fallback-only evidence must not hard-block, got: ${JSON.stringify(plain.json)}`
  );

  const plainReason = reasonOf(plain);
  assert.match(plainReason, /fallback-only evidence/);
  const plainEv = assertSnapshot(plainReason, "fallback-only plain git add");
  assert.match(
    plainEv.source,
    /^(env\.PWD|process\.cwd\(\))$/,
    `advisory must report the fallback source token, got: ${plainEv.source}`
  );
  assert.equal(plainEv.chdir, "no", "plain git add has no chdir prefix");
  assert.equal(plainEv.gitC, "no", "plain git add has no git -C");
  assert.doesNotMatch(
    plainReason,
    /confirmed protected-branch state/i,
    "advisory must not present fallback evidence as confirmed state"
  );

  // 2) relative `cd sub` → chdir flag reflects the matched prefix (yes) but the
  //    chdir did not pin the cwd, and the advisory must say so.
  const rel = run(
    {
      tool_name: "functions.exec_command",
      tool_input: { command: "cd sub && git add x" },
    },
    { cwd: repo, env: { CODEX_CI: "1" } }
  );

  assert.notEqual(
    rel.json?.decision,
    "block",
    `a relative cd resolved from the fallback PWD is not confirmed evidence, got: ${JSON.stringify(rel.json)}`
  );

  const relReason = reasonOf(rel);
  assert.match(relReason, /fallback-only evidence/);
  const relEv = assertSnapshot(relReason, "fallback-only relative cd");
  assert.equal(relEv.chdir, "yes", "a relative cd prefix is still a hook-visible chdir");
  assert.equal(relEv.gitC, "no", "no explicit git -C in the matched invocation");
  assert.match(
    relReason,
    /hook-visible chdir/,
    `advisory must name the hook-visible chdir; got: ${relReason}`
  );
  assert.match(
    relReason,
    /未固定/,
    `advisory must state the chdir did not pin the cwd; got: ${relReason}`
  );
  assert.match(plainReason, /分兩次 Bash 呼叫/, "the advisory must repeat the add/commit split duty");
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario: Unresolvable-Target Advisory Carries The Same Snapshot
// (add-uncertain-advisory-cwd-evidence: the non-Codex "無法靜態判定" advisory)
// ─────────────────────────────────────────────────────────────────────────

test("Protected-branch gate cwd evidence: Unresolvable-Target Advisory Carries The Same Snapshot", () => {
  const repo = setupRepo("main");
  const repoBase = path.basename(repo);

  const cases = [
    // [label, command, expected chdir, expected gitC]
    ["variable cd", 'cd "$TARGET_DIR" && git add x', "yes", "no"],
    ["variable git -C", 'git -C "$TARGET_DIR" add x', "no", "yes"],
  ];

  for (const [label, command, chdir, gitC] of cases) {
    const r = run({ tool_name: "Bash", tool_input: { command } }, { cwd: repo });
    assert.notEqual(
      r.json?.decision,
      "block",
      `${label}: an unresolvable cwd must stay a non-blocking advisory, got: ${JSON.stringify(r.json)}`
    );
    const reason = reasonOf(r);
    assert.match(reason, /無法靜態判定其目標分支\/目錄/, `${label} reason: ${reason}`);
    const ev = assertSnapshot(reason, `uncertain advisory (${label})`);
    assert.match(
      ev.source,
      /^(env\.PWD|process\.cwd\(\))$/,
      `${label} must report the fallback source token, got: ${ev.source}`
    );
    assert.equal(ev.baseCwd, repoBase, `${label} base cwd basename`);
    // The resolver could not settle the write's cwd: never backfilled from the base cwd.
    assert.equal(ev.resolved, "(unresolved)", `${label} resolved`);
    assert.equal(ev.chdir, chdir, `${label} chdir`);
    assert.equal(ev.gitC, gitC, `${label} gitC`);
    assert.ok(!reason.includes(repo), `${label} snapshot must not leak the absolute path; got: ${reason}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario: Snapshot Omits Command Text And Absolute Paths
// ─────────────────────────────────────────────────────────────────────────

test("Protected-branch gate cwd evidence: Snapshot Omits Command Text And Absolute Paths", () => {
  const repo = setupRepo("main");
  const repoBase = path.basename(repo);
  const commandMarker = "sentinel-command-marker.txt";

  const r = run(
    { tool_name: "Bash", tool_input: { command: `git add ${commandMarker}` } },
    { cwd: repo }
  );

  assert.equal(
    r.json?.decision,
    "block",
    `expected block, got: ${JSON.stringify(r.json)}`
  );

  const reason = reasonOf(r);
  const ev = assertSnapshot(reason, "omit command text");
  assert.equal(ev.baseCwd, repoBase, "base cwd renders as a basename");
  assert.equal(ev.resolved, repoBase, "resolved renders as a basename");

  assert.ok(
    !reason.includes(repo),
    `reason must not contain an absolute host path; got: ${reason}`
  );
  assert.ok(
    !reason.includes(commandMarker),
    `reason must not contain command text; got: ${reason}`
  );

  // The per-write resolver's unresolvable sentinel renders as the unresolved
  // marker — never backfilled from the base cwd.
  const unresolvedLine = requireGateExport("buildProtectedCwdEvidence")({
    source: "env.PWD",
    baseCwd: repo,
    resolvedCwd: UNRESOLVABLE_CWD,
    chdir: false,
    gitC: false,
  });
  assert.match(unresolvedLine, /resolved=\(unresolved\)/);
  const unresolvedEv = cwdEvidence(unresolvedLine);
  assert.ok(unresolvedEv, `unresolved line must still parse; got: ${unresolvedLine}`);
  assert.equal(unresolvedEv.baseCwd, repoBase, "base cwd keeps its own basename");
  assert.notEqual(
    unresolvedEv.resolved,
    unresolvedEv.baseCwd,
    "the unresolved marker must never be backfilled from the base cwd"
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario: Snapshot Assembly Failure Leaves The Decision Unchanged
// ─────────────────────────────────────────────────────────────────────────

test("Protected-branch gate cwd evidence: Snapshot Assembly Failure Leaves The Decision Unchanged", () => {
  // Assembly throws → the wrapper swallows it and omits the line.
  const throwingViolation = {};
  Object.defineProperty(throwingViolation, "cwd", {
    get() {
      throw new Error("snapshot assembly boom");
    },
  });
  const failedAssembly = requireGateExport("protectedCwdEvidenceLine")({
    toolInput: {},
    payload: {},
    baseCwd: process.cwd(),
    violation: throwingViolation,
    matchText: "git add x",
  });
  assert.equal(
    failedAssembly.line,
    "",
    "a throwing assembly must yield no snapshot line"
  );
  assert.equal(failedAssembly.source, "", "a throwing assembly must not claim a provenance");

  // Unusable (non-string) payload values must not change the block decision.
  const repo = setupRepo("main");
  const control = run(
    { tool_name: "Bash", tool_input: { command: "git add x" } },
    { cwd: repo }
  );
  const poisoned = run(
    { tool_name: "Bash", tool_input: { command: "git add x", workdir: 42 } },
    { cwd: repo }
  );

  assert.equal(
    control.json?.decision,
    "block",
    `control must block, got: ${JSON.stringify(control.json)}`
  );
  assert.equal(
    poisoned.json?.decision,
    control.json?.decision,
    `decision must be unchanged when snapshot fields are unusable, got: ${JSON.stringify(poisoned.json)}`
  );
  assert.equal(poisoned.code, 0, `hook must still exit 0; stderr: ${poisoned.stderr}`);
  assert.match(reasonOf(poisoned), /Protected-branch gate/);
});

// ─────────────────────────────────────────────────────────────────────────
// D2b truthfulness (design D6): resolver-provided cwd must not be backfilled
// ─────────────────────────────────────────────────────────────────────────

test("D2b truthfulness: tool_input.workdir worktree + git -C <protected-checkout> add reports source=tool_input.workdir, gitC=yes, resolved != baseCwd", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const repoBase = path.basename(repo);
  const wtBase = path.basename(wt);

  const payload = {
    tool_name: "Bash",
    tool_input: { workdir: wt, command: `git -C ${repo} add x` },
  };

  const r = run(payload, { cwd: repo });

  assert.equal(
    r.json?.decision,
    "block",
    `git -C <protected-checkout> add must block, got: ${JSON.stringify(r.json)}`
  );

  const reason = reasonOf(r);
  const ev = assertSnapshot(reason, "D2b truthfulness");
  assert.equal(ev.source, "tool_input.workdir");
  assert.equal(ev.gitC, "yes");
  assert.equal(ev.baseCwd, wtBase);
  assert.equal(ev.resolved, repoBase);
  assert.notEqual(
    ev.resolved,
    ev.baseCwd,
    "resolved must come from the per-match resolver, not the base cwd"
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Legacy evidence set: execution-cwd aliases (`working_directory`) are NOT
// protected-branch evidence, so they must keep the pre-change decision.
// ─────────────────────────────────────────────────────────────────────────

test("working_directory-only payload stays a fallback-only advisory and does not claim absence of payload fields", () => {
  const repo = setupRepo("main");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git add -A", working_directory: repo },
    },
    { cwd: repo, env: { CODEX_CI: "1" } }
  );
  assert.notEqual(r.json?.decision, "block", "an execution-cwd alias alone must not hard-block");
  const reason = reasonOf(r);
  assert.match(reason, /execution-cwd alias/, "advisory must name the alias source");
  assert.doesNotMatch(
    reason,
    /沒有任何 legacy payload cwd\/workdir 欄位提供 base cwd/,
    "advisory must not claim no payload field supplied the cwd"
  );
  const ev = assertSnapshot(reason, "working_directory-only advisory");
  assert.equal(ev.source, "tool_input.working_directory");
});

test("working_directory plus a legacy payload cwd field keeps the definite block", () => {
  const { repo, wt } = setupRepoWithWorktree();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git add -A", working_directory: repo },
      cwd: wt,
    },
    { cwd: repo }
  );
  assert.equal(r.json?.decision, "block", "legacy payload cwd evidence must keep the block");
  const ev = assertSnapshot(reasonOf(r), "legacy evidence block");
  assert.equal(ev.source, "tool_input.working_directory");
});

test("renderer reports unknown provenance instead of fabricating process.cwd()", () => {
  const line = requireGateExport("buildProtectedCwdEvidence")({});
  assert.match(line, /source=unknown/);
  assert.doesNotMatch(line, /source=process\.cwd\(\)/);
});

test("gitC reflects a -C among git global options and still blocks under Codex", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "Bash", tool_input: { command: `git --no-pager -C ${repo} add -A` } },
    { cwd: repo, env: { CODEX_CI: "1" } }
  );
  assert.equal(r.json?.decision, "block", "a definite protected write must still block under Codex");
  const ev = assertSnapshot(reasonOf(r), "global-option -C block");
  assert.equal(ev.gitC, "yes", "gitC must see a -C that follows other git global options");
});

test("gitC sees path-qualified and boundary-glued git invocations", () => {
  const cases = [
    ["true;git", (repo) => `true;git -C ${repo} add -A`],
    ["true&&git", (repo) => `true&&git -C ${repo} add -A`],
    ["(git", (repo) => `(git -C ${repo} add -A)`],
    ["/usr/bin/git", (repo) => `/usr/bin/git -C ${repo} add -A`],
    ["backtick", (repo) => `\`git -C ${repo} add -A\``],
    ["env value ending in /git", (repo) => `X=a/git git -C ${repo} add -A`],
  ];
  for (const [label, build] of cases) {
    const repo = setupRepo("main");
    const r = run(
      { tool_name: "Bash", tool_input: { command: build(repo) } },
      { cwd: repo, env: { CODEX_CI: "1" } }
    );
    assert.equal(r.json?.decision, "block", `${label} must stay a definite block under Codex`);
    const ev = assertSnapshot(reasonOf(r), `${label} block`);
    assert.equal(ev.gitC, "yes", `${label} must report gitC=yes`);
  }
});

test("a provenance that cannot be tied to the base cwd renders the unknown marker", () => {
  const line = requireGateExport("protectedCwdEvidenceLine")({
    toolInput: { cwd: "/tmp/elsewhere" },
    payload: {},
    baseCwd: "/tmp/another-place",
    violation: { cwd: "/tmp/another-place" },
    matchText: "git add x",
  });
  assert.match(line.line, /source=unknown/);
  assert.equal(line.source, "unknown");
});

test("a -C inside a quoted config value never reads as an explicit git -C", () => {
  const repo = setupRepo("main");
  const r = run(
    { tool_name: "functions.exec_command", tool_input: { command: 'git -c core.pager="x -C y" add -A' } },
    { cwd: repo, env: { CODEX_CI: "1" } }
  );
  // The resolver treats the quoted -C as an unresolvable target, so the safe
  // outcome is the fail-open advisory; what MUST NOT happen is a `gitC=yes`
  // claim (or a definite block built on that false evidence).
  assert.notEqual(r.json?.decision, "block", "a quoted -C value must not make the write definite");
  const reason = reasonOf(r);
  assert.doesNotMatch(reason, /gitC=yes/, "a quoted -C value is data, not an invocation flag");
  // The unresolvable-target advisory carries the snapshot, so this check is never vacuous.
  const ev = assertSnapshot(reason, "quoted -C value");
  assert.equal(ev.gitC, "no", "quoted -C must not be reported as the invocation flag");
  assert.equal(ev.resolved, "(unresolved)", "the quoted -C target stays unresolved");
});
