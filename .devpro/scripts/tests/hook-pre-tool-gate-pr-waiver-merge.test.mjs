import "./lib/git-location-isolated-env.mjs";
import "./lib/isolated-control-evidence-state.mjs";
/**
 * hook-pre-tool-gate-pr-waiver-merge.test.mjs
 *
 * `gh pr merge` compares the current PR description again with the answer-time
 * records (inventory gate `per-pr-waiver-merge-record`; openspec-flow requirement
 * "PR Merge Compares Per-PR Waiver Lines With Answer-Time Records").
 *
 * The shared merge case table (pr-waiver-two-path-cases.mjs) runs through the gate
 * function from a checkout on `main`; the same table runs through the MCP client
 * policy in github-client-policy.test.mjs. Hook-level cases (spawned hook) cover
 * the inventory position, rigor `off`, and the exempt-branch merge of a
 * direct-adoption consumer that has no `.gitmodules`.
 *
 * Mocks: CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT is the `gh pr view` JSON and
 * CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE records every `_runGhPrView` call, so a
 * case can prove which repository was read and that a gate made no `gh` call.
 * Every fixture is a temporary repository; the runner's notes are never read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import * as hook from "../hooks/pre-tool-gate.mjs";
import { BASELINE_GATE_IDS } from "../hooks/lib/rigor-level.mjs";
import * as waiverCases from "./lib/pr-waiver-two-path-cases.mjs";

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../hooks/pre-tool-gate.mjs");
const SHA = "d".repeat(40);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "tester",
  GIT_AUTHOR_EMAIL: "tester.local",
  GIT_COMMITTER_NAME: "tester",
  GIT_COMMITTER_EMAIL: "tester.local",
};
const MOCK_KEYS = [
  "CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT",
  "CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE",
  "CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER",
  "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES",
  "CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR",
  "CROSS_MODEL_MERGE_GATE_MOCK_BRANCH",
  "GH_REPO",
];

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A repository checked out on `branch`, with an origin of owner/repo. `kind` selects the identity:
// "direct" = direct adoption without .gitmodules, "gitmodules" = consumer with the rules submodule files,
// "source" = positive source (origin + sentinels), "unknown" = no positive evidence.
function makeRepo({ kind = "direct", branch = "main", origin = "https://github.com/owner/repo.git" } = {}) {
  const repo = makeTempDir("waiver-merge-");
  git(repo, ["init", "-q", "-b", branch]);
  if (kind === "direct") {
    mkdirSync(path.join(repo, ".devpro-agent-rules/.devpro/scripts"), { recursive: true });
    writeFileSync(path.join(repo, ".devpro-agent-rules/AGENTS.md"), "consumer rules");
    writeFileSync(path.join(repo, ".devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs"), "consumer rules");
  }
  if (kind === "gitmodules") {
    writeFileSync(path.join(repo, ".gitmodules"), '[submodule "rules"]\n path = .devpro-agent-rules\n');
    mkdirSync(path.join(repo, ".devpro/scripts"), { recursive: true });
    writeFileSync(path.join(repo, ".devpro/scripts/sync-agent-rules.mjs"), "x");
    writeFileSync(path.join(repo, ".devpro/scripts/devpro-doctor.mjs"), "x");
  }
  if (kind === "source") {
    mkdirSync(path.join(repo, ".devpro/agent-rules"), { recursive: true });
    mkdirSync(path.join(repo, ".devpro/scripts"), { recursive: true });
    writeFileSync(path.join(repo, ".devpro/agent-rules/rule-audit-playbook.md"), "source");
    writeFileSync(path.join(repo, ".devpro/scripts/pre-pr-archive-gate.mjs"), "source");
  }
  git(repo, ["remote", "add", "origin", kind === "source" ? "https://github.com/owner/devpro-agent-rules.git" : origin]);
  git(repo, ["commit", "--allow-empty", "-q", "--no-verify", "-m", "init"]);
  return repo;
}

function writeNotes(repo, notes) {
  if (notes === null || notes === undefined) return;
  mkdirSync(path.join(repo, "notes"), { recursive: true });
  if (notes === "unreadable") mkdirSync(path.join(repo, "notes/session-pending.md"));
  else writeFileSync(path.join(repo, "notes/session-pending.md"), notes);
}

const bodyOf = (dev, consumer = null) => [
  "## Test Evidence",
  `- DEV deploy-verify: HEAD ${SHA}; ${dev}`,
  ...(consumer === null ? [] : [`- Consumer pre-PR checks: HEAD ${SHA}; ${consumer}`]),
  "",
].join("\n");
const WAIVED = bodyOf("skipped per user decision: X");
// A merge in a makeRepo() checkout (origin owner/repo) writes its repository in full.
const OWN_MERGE = "gh pr merge 23 --repo github.com/owner/repo --merge";

// `gh pr view` JSON; a key set to `undefined` is omitted so a missing field can be tested.
function prView(fields = {}) {
  const view = { comments: [], headRefOid: SHA, headRefName: waiverCases.BRANCH, baseRefName: "main", state: "OPEN", body: "", isCrossRepository: false, ...fields };
  for (const key of Object.keys(view)) if (view[key] === undefined) delete view[key];
  return view;
}

function withEnv(env, fn) {
  const saved = {};
  for (const key of MOCK_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  for (const [key, value] of Object.entries(env)) { saved[key] ??= process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

// Calls the gate function; `view` is the mocked `gh pr view` JSON (a string is used verbatim).
function callMerge(cmd, repo, { view = prView(), env = {}, prNumber = "23" } = {}) {
  const traceFile = path.join(makeTempDir("waiver-merge-trace-"), "trace.jsonl");
  const result = withEnv({
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: typeof view === "string" ? view : JSON.stringify(view),
    CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: traceFile,
    CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: prNumber,
    ...env,
  }, () => hook.checkPerPrWaiverOnMerge(cmd, repo));
  const trace = existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { result, trace };
}

function runHook(repo, command, { view, level = "lite", extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    CODEX_CI: "",
    CODEX_THREAD_ID: "",
    DEVPRO_AGENT_RULES_LEVEL: level,
    DEVPRO_SENTINEL_STATE_DIR: makeTempDir("sentinel-waiver-merge-"),
    DEVPRO_POSTMERGE_STATE_DIR: makeTempDir("postmerge-waiver-merge-"),
    DEVPRO_RECAP_PENDING_DIR: makeTempDir("recap-pending-waiver-merge-"),
    DEVPRO_RECAP_STATE_DIR: makeTempDir("recap-state-waiver-merge-"),
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify(view ?? prView()),
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "README.md",
    CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: "23",
    ...extraEnv,
  };
  delete env.GH_REPO;
  const result = spawnSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { cwd: repo, command } }), encoding: "utf8", env });
  let json = null;
  try { json = result.stdout.trim() ? JSON.parse(result.stdout) : null; } catch { /* not JSON */ }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

// A pass of the whole hook: exit 0 and stdout that is empty or JSON that is not a block (a crash or unparsable
// output must not count as a pass).
const passedWholeHook = (run, label) => {
  assert.equal(run.code, 0, `${label}: exit ${run.code}\n${run.stdout}\n${run.stderr}`);
  assert.ok(run.stdout.trim() === "" || run.json !== null, `${label}: stdout is not JSON: ${run.stdout}`);
  assert.notEqual(run.json?.decision, "block", `${label}: ${run.stdout}\n${run.stderr}`);
};

const blockedBy = (result, prefix, label) => {
  assert.ok(result?.block, `${label}: expected a block, got ${JSON.stringify(result)}`);
  assert.ok(result.reason.startsWith(prefix), `${label}: ${result.reason}`);
  return result.reason;
};

// ── The shared merge case table, through the gate function, from a checkout on main ─────────────────────

// [Scenario: openspec-flow :: A waiver added after the PR was opened blocks the merge without a record]
// [Scenario: openspec-flow :: A matching record lets the merge pass from a checkout on another branch]
// [Scenario: openspec-flow :: A description without a waiver part passes the merge without reading records]
// [Scenario: openspec-flow :: Records that are missing or bound elsewhere block the merge as at PR creation]
// [Scenario: openspec-flow :: A waiver on a PR whose head is in another repository blocks the merge]
for (const c of waiverCases.MERGE_CASES) {
  test(`[Scenario: openspec-flow :: ${c.scenario}] ${c.id} (gh pr merge)`, () => {
    const repo = makeRepo({ kind: "direct", branch: "main" });
    try {
      writeNotes(repo, c.notes);
      const { result } = callMerge("gh pr merge 23 --merge", repo, { view: prView({ headRefName: c.head, isCrossRepository: Boolean(c.cross), body: bodyOf(c.dev) }) });
      if (!c.expect.block) { assert.equal(result, null, `${c.id}: ${JSON.stringify(result)}`); return; }
      const reason = blockedBy(result, `${c.expect.gate}: `, c.id);
      assert.ok(reason.includes("Merge-time check of PR #23"), `${c.id}: ${reason}`);
      for (const needle of c.expect.includes) assert.ok(reason.includes(needle), `${c.id}: missing ${needle}\n${reason}`);
      for (const needle of c.expect.excludes) assert.ok(!reason.includes(needle), `${c.id}: must not contain ${needle}\n${reason}`);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
}

// The merge reads the head ref GitHub reports, never the branch of the checkout.
// [Scenario: openspec-flow :: A matching record lets the merge pass from a checkout on another branch]
test("the PR head branch decides, not the checkout branch, and the PR is read once", () => {
  const repo = makeRepo({ kind: "direct", branch: "main" });
  try {
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    const { result, trace } = callMerge("gh pr merge 23 --merge", repo, { view: prView({ body: WAIVED }) });
    assert.equal(result, null);
    assert.deepEqual(trace.map((entry) => entry.helper), ["_runGhPrView"]);
    git(repo, ["checkout", "-q", "-b", waiverCases.BRANCH]);
    const other = callMerge("gh pr merge 23 --merge", repo, { view: prView({ headRefName: "chore/another-change", body: WAIVED }) });
    assert.match(blockedBy(other.result, "DEV deploy-verify gate: ", "head decides"), /another-change \(branch chore\/another-change\)/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: A description without a waiver part passes the merge without reading records]
test("a null or empty description, or no DEV line, passes without reading the notes file", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, "unreadable");
    for (const body of [null, "", "## Test Evidence\nAll tests pass.\n"]) {
      assert.equal(callMerge("gh pr merge 23 --merge", repo, { view: prView({ body }) }).result, null, JSON.stringify(body));
    }
    assert.ok(blockedBy(callMerge("gh pr merge 23 --merge", repo, { view: prView({ body: WAIVED }) }).result, "DEV deploy-verify gate: ", "waiver reads the unreadable file")
      .includes("notes/session-pending.md cannot be read"), "the unreadable notes file is only touched when a waiver is present");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: An unreadable description or a missing head branch blocks the merge]
test("an unreadable PR, a missing body field, a body of the wrong type or a missing head branch blocks", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    const cannotRead = /the description of PR #23 cannot be read/;
    for (const [label, view] of [["gh pr view output is not JSON", "not-json"], ["gh pr view returns null", "null"],
      ["no body field", prView({ body: undefined })], ["body is a number", prView({ body: 123 })], ["body is an object", prView({ body: {} })]]) {
      const reason = blockedBy(callMerge("gh pr merge 23 --merge", repo, { view }).result, "Per-PR waiver merge gate: ", label);
      assert.match(reason, cannotRead, label);
      assert.match(reason, /gh/, label);
      assert.ok(!reason.includes("DEVPRO_HOOK_BYPASS"), label);
    }
    for (const headRefName of [undefined, "", null, 7]) {
      const reason = blockedBy(callMerge("gh pr merge 23 --merge", repo, { view: prView({ body: WAIVED, headRefName }) }).result, "DEV deploy-verify gate: ", String(headRefName));
      assert.ok(reason.includes("GitHub reported no head branch for this PR"), reason);
      assert.ok(!reason.includes("ask the user"), "no record step without a head branch");
    }
    assert.equal(callMerge("gh pr merge 23 --merge", repo, { view: prView({ body: "", headRefName: undefined }) }).result, null, "a missing head ref only matters with a waiver part");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: Source repository and rigor off do not compare at merge]
test("source: no gh call and no body read for a PR of its own origin; the gate function is silent", () => {
  const repo = makeRepo({ kind: "source" });
  try {
    for (const cmd of ["gh pr merge 23 --repo github.com/owner/devpro-agent-rules --merge", "gh pr merge https://github.com/owner/devpro-agent-rules/pull/23 --merge"]) {
      const { result, trace } = callMerge(cmd, repo, { view: prView({ body: WAIVED }) });
      assert.equal(result, null, cmd);
      assert.deepEqual(trace, [], `${cmd}: _runGhPrView must not be called for a positive source`);
    }
    // Without its repository written in full the merge is not known to be its own PR, so it is compared (PR #3703 r2 F1).
    for (const cmd of ["gh pr merge 23 --merge", "gh pr merge 23 --repo owner/devpro-agent-rules --merge"]) {
      const { trace } = callMerge(cmd, repo, { view: prView({ body: WAIVED }) });
      assert.notDeepEqual(trace, [], `${cmd}: the description must be read`);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: Source repository and rigor off do not compare at merge]
test("source: a PR of another repository is compared, so the source checkout's exemption never covers it", () => {
  const repo = makeRepo({ kind: "source" });
  try {
    for (const cmd of ["gh pr merge 23 --repo other/repo --merge", "gh pr merge https://github.com/other/repo/pull/12"]) {
      const { result } = callMerge(cmd, repo, { view: prView({ body: WAIVED }) });
      assert.equal(result?.block, true, cmd);
      assert.match(result.reason, /^Per-PR waiver merge gate: PR #\d+ carries a waiver, but the merge selects (?:github\.com\/)?other\/repo, which is not the repository of this checkout/, cmd);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: Source repository and rigor off do not compare at merge]
test("hook at rigor off does not compare; at lite the same merge blocks", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const view = prView({ body: WAIVED });
    const off = runHook(repo, OWN_MERGE, { view, level: "off" });
    passedWholeHook(off, "rigor off");
    const lite = runHook(repo, OWN_MERGE, { view, level: "lite" });
    assert.equal(lite.json?.decision, "block", `${lite.stdout}\n${lite.stderr}`);
    assert.match(lite.json.reason, /^DEV deploy-verify gate: /);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: pre-tool-mechanical-gates :: An exempt-branch merge in a direct-adoption consumer without .gitmodules is still compared]
test("hook: an exempt chore/<name> docs-only merge of a direct-adoption consumer without .gitmodules is compared", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    assert.ok(!existsSync(path.join(repo, ".gitmodules")), "fixture has no .gitmodules");
    const control = runHook(repo, OWN_MERGE, { view: prView({ body: bodyOf("N/A: docs only") }) });
    passedWholeHook(control, "the control (no waiver part) must pass the whole hook first");
    const waived = runHook(repo, OWN_MERGE, { view: prView({ body: WAIVED }) });
    assert.equal(waived.json?.decision, "block", `${waived.stdout}\n${waived.stderr}`);
    assert.match(waived.json.reason, /^DEV deploy-verify gate: /);
    assert.ok(waived.json.reason.includes("Merge-time check of PR #23"), waived.json.reason);
    assert.ok(waived.json.reason.includes(waiverCases.NAME), waived.json.reason);
    assert.ok(!waived.json.reason.includes("DEVPRO_HOOK_BYPASS"), "no bypass hint");
    assert.ok(!waived.json.reason.includes("gh pr create"), "no gh pr create recipe");
    // The inventory entry itself (gate id) is what blocks.
    const entry = hook.BASH_BLOCKING_GATES.find((gate) => gate.id === "per-pr-waiver-merge-record");
    assert.ok(entry, "per-pr-waiver-merge-record is registered");
    const viaRunner = withEnv({ CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify(prView({ body: WAIVED })) },
      () => entry.runner({ cmd: OWN_MERGE, baseCwd: repo, effectiveCwd: repo }));
    assert.match(viaRunner?.reason ?? "", /^DEV deploy-verify gate: /, JSON.stringify(viaRunner));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: pre-tool-mechanical-gates :: The merge gate is registered after local-test-merge-evidence]
test("inventory: per-pr-waiver-merge-record is its own STATE_BACKED BLOCK entry right after local-test-merge-evidence and is not a baseline gate", () => {
  const ids = hook.BASH_BLOCKING_GATES.map((entry) => entry.id);
  const at = ids.indexOf("per-pr-waiver-merge-record");
  assert.ok(at > 0, "registered");
  assert.equal(ids[at - 1], "local-test-merge-evidence");
  assert.equal(ids.filter((id) => id === "per-pr-waiver-merge-record").length, 1);
  const entry = hook.BASH_BLOCKING_GATES[at];
  assert.equal(entry.bucket, hook.GATE_BUCKETS.STATE_BACKED);
  assert.equal(entry.decision, hook.GATE_DECISIONS.BLOCK);
  assert.equal(entry.evidence, "github-pr-state");
  assert.equal(entry.risk, "pr-body-hygiene");
  assert.ok(!BASELINE_GATE_IDS.includes("per-pr-waiver-merge-record"), "not a baseline gate");
});

// [Scenario: pre-tool-mechanical-gates :: The merge gate is registered after local-test-merge-evidence]
test("hook: when local-test-merge-evidence blocks the same merge, that block is reported", () => {
  // The local-test gate applies only to a positive source checkout (a consumer is never asked for the source suite).
  const repo = makeRepo({ kind: "source" });
  try {
    const view = prView({ body: WAIVED });
    const r = runHook(repo, "gh pr merge 23 --repo github.com/owner/devpro-agent-rules --merge", { view, extraEnv: { CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: ".devpro/scripts/hooks/pre-tool-gate.mjs\nsome-other.mjs" } });
    assert.equal(r.json?.decision, "block", `${r.stdout}\n${r.stderr}`);
    assert.match(r.json.reason, /\[Local-Test Gate\]/, r.json.reason);
    assert.ok(!r.json.reason.includes("Merge-time check of PR"), "the earlier gate wins");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ── Target repository: --repo, GH_REPO, PR URL ──────────────────────────────────────────────────────────

// [Scenario: pre-tool-mechanical-gates :: A cross-repository merge blocks only a waiver]
test("a merge into another repository blocks only a description with a waiver part (--repo, -R, GH_REPO, hook GH_REPO)", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    const variants = [
      ["--repo other/repo", "gh pr merge 23 --repo other/repo --merge", {}],
      ["-R other/repo", "gh pr merge 23 -R other/repo --merge", {}],
      ["--repo=other/repo", "gh pr merge 23 --repo=other/repo", {}],
      ["hook GH_REPO", "gh pr merge 23 --merge", { GH_REPO: "other/repo" }],
    ];
    // A command-local GH_REPO= is never read, with or without a waiver (PR #3703 r6 F1).
    for (const body of [WAIVED, bodyOf("N/A: docs only")]) {
      const local = callMerge("GH_REPO=other/repo gh pr merge 23 --merge", repo, { view: prView({ body }) });
      assert.match(blockedBy(local.result, "Per-PR waiver merge gate: ", "command-local GH_REPO="), /GH_REPO= in front of gh pr merge is not read/);
      assert.deepEqual(local.trace, []);
    }
    for (const [label, cmd, env] of variants) {
      const waived = callMerge(cmd, repo, { view: prView({ body: WAIVED }), env });
      const reason = blockedBy(waived.result, "Per-PR waiver merge gate: ", label);
      assert.ok(reason.includes("gh pr edit"), `${label}: names gh pr edit as a next step`);
      assert.ok(!reason.includes("DEVPRO_HOOK_BYPASS"), label);
      assert.deepEqual(waived.trace.map((entry) => entry.repo), ["other/repo"], `${label}: the PR is read from the named repository`);
      const clean = callMerge(cmd, repo, { view: prView({ body: bodyOf("N/A: docs only") }), env });
      assert.equal(clean.result, null, `${label}: no waiver part is not blocked`);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: pre-tool-mechanical-gates :: An undeterminable PR or target repository blocks the merge]
test("an unresolvable PR number, a non-literal GH_REPO and a --repo outside [HOST/]OWNER/REPO block", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const noNumber = callMerge("gh pr merge --merge", repo, { view: prView({ body: bodyOf("N/A: docs only") }), prNumber: "" });
    blockedBy(noNumber.result, "Per-PR waiver merge gate: ", "no PR number");
    assert.deepEqual(noNumber.trace, [], "nothing is read without a PR number");
    for (const [label, cmd, env] of [
      ["GH_REPO=$X", "GH_REPO=$X gh pr merge 23 --merge", {}],
      ["GH_REPO with command substitution", "GH_REPO=$(echo other/repo) gh pr merge 23 --merge", {}],
      ["GH_REPO empty", "GH_REPO= gh pr merge 23 --merge", {}],
      ["--repo not owner/repo", "gh pr merge 23 --repo foo --merge", {}],
      ["--repo with four segments", "gh pr merge 23 --repo a/b/c/d --merge", {}],
      ["--repo variable", "gh pr merge 23 --repo $TARGET --merge", {}],
      ["-R backtick", "gh pr merge 23 -R `echo a/b` --merge", {}],
      ["hook GH_REPO not in the form", "gh pr merge 23 --merge", { GH_REPO: "not-a-repo" }],
    ]) {
      const { result, trace } = callMerge(cmd, repo, { view: prView({ body: bodyOf("N/A: docs only") }), env });
      const reason = blockedBy(result, "Per-PR waiver merge gate: ", label);
      assert.ok(reason.includes(label.startsWith("GH_REPO") ? "GH_REPO= in front of gh pr merge is not read" : "--repo [HOST/]OWNER/REPO"), `${label}: ${reason}`);
      assert.deepEqual(trace, [], `${label}: no PR is read for an unreadable target`);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: pre-tool-mechanical-gates :: An undeterminable PR or target repository blocks the merge]
test("hook: cross-repo-pr-merge is the gate that blocks an undeterminable PR or target, before the waiver gate (PR #3703 r9 W9-F2)", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    for (const [label, cmd] of [["command-local GH_REPO", "GH_REPO=owner/repo gh pr merge 23 --repo github.com/owner/repo --merge"], ["unreadable --repo", "gh pr merge 23 --repo foo --merge"], ["no PR", "gh pr merge --repo github.com/owner/repo --merge"]]) {
      const r = runHook(repo, cmd, { view: prView({ body: WAIVED }) });
      assert.equal(r.json?.decision, "block", `${label}: ${r.stdout}\n${r.stderr}`);
      assert.match(r.json.reason, /^Cross-repo PR merge gate: /, `${label}: ${r.json.reason}`);
      assert.ok(!r.json.reason.includes("Per-PR waiver merge gate"), `${label}: the waiver gate is not reached`);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: pre-tool-mechanical-gates :: A PR URL of another repository is read and compared as that repository]
test("a PR URL selector names both the repository and the PR number; a --repo of another repository beside it blocks before any read", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    // Own PR #12 has no waiver, the PR of the other repository does: the other one is read and blocks.
    const other = callMerge("gh pr merge https://github.com/other/repo/pull/12 --merge", repo, { view: prView({ body: WAIVED }), prNumber: "99" });
    const reason = blockedBy(other.result, "Per-PR waiver merge gate: ", "other repository URL");
    assert.deepEqual(other.trace.map((entry) => entry.repo), ["github.com/other/repo"], "the repository of the URL is read");
    assert.ok(reason.includes("gh pr edit"), reason);
    const quoted = callMerge('gh pr merge "https://github.com/other/repo/pull/12" --merge', repo, { view: prView({ body: WAIVED }), prNumber: "99" });
    blockedBy(quoted.result, "Per-PR waiver merge gate: ", "quoted URL");
    assert.deepEqual(quoted.trace.map((entry) => entry.repo), ["github.com/other/repo"]);
    // A URL and a --repo of different repositories are blocked before any read: neither is picked (PR #3703 r8 W9-F4).
    const flagged = callMerge("gh pr merge https://github.com/other/repo/pull/12 --repo github.com/owner/repo --merge", repo, { view: prView({ body: WAIVED }), env: { GH_REPO: "owner/repo" } });
    assert.ok(blockedBy(flagged.result, "Per-PR waiver merge gate: ", "URL beside another --repo").includes("the PR URL and --repo of this merge name different repositories"), JSON.stringify(flagged.result));
    assert.deepEqual(flagged.trace, []);
    // The same repository, whose waiver has a matching record, is not blocked; the PR number comes from the URL.
    const same = callMerge("gh pr merge https://github.com/owner/repo/pull/12 --merge", repo, { view: prView({ body: WAIVED }), prNumber: "" });
    assert.equal(same.result, null, JSON.stringify(same.result));
    assert.deepEqual(same.trace.map((entry) => entry.repo), ["github.com/owner/repo"]);
    // The number of the URL is the one in the message.
    git(repo, ["checkout", "-q", "-b", "chore/elsewhere"]);
    const missing = callMerge("gh pr merge https://github.com/owner/repo/pull/12 --merge", repo, { view: prView({ body: bodyOf("skipped per user decision: Y") }) });
    assert.ok(blockedBy(missing.result, "DEV deploy-verify gate: ", "same repository URL, no matching record").includes("Merge-time check of PR #12"));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// Only the merge clause's own selector names the PR (round 7 F-ppdv-17): a number, a branch, or with none the PR
// of the current branch. A /pull/N link in another clause of the same command never does.
test("the merge selector names the PR: a /pull/N link in another clause is ignored and a branch is read by name", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    const linked = callMerge("gh pr view https://github.com/owner/repo/pull/77 && gh pr merge 23 --merge", repo, { view: prView({ body: WAIVED }), prNumber: "" });
    assert.equal(linked.result, null, JSON.stringify(linked.result));
    assert.deepEqual(linked.trace.map((entry) => entry.pr), ["23"], "the number of the merge clause is read, not #77");
    // No selector: the PR of the current branch is never read (PR #3703 r9 W3-F2).
    checkSelector("gh pr merge --merge", "31", callMerge("gh pr merge --merge", repo, { view: prView({ body: WAIVED }), prNumber: "31" }));
    // A branch selector reads that branch's PR, never the current branch's; without a waiver part it passes.
    const plain = callMerge("gh pr merge feature/other --merge", repo, { view: prView({ body: bodyOf("N/A: docs only") }), prNumber: "31" });
    assert.equal(plain.result, null, JSON.stringify(plain.result));
    assert.deepEqual(plain.trace.map((entry) => entry.pr), ["feature/other"]);
    // With a waiver part, a branch selector blocks and asks for the number, as the edit gate does.
    const waived = callMerge("gh pr merge feature/other --merge", repo, { view: prView({ body: WAIVED }), prNumber: "31" });
    assert.match(blockedBy(waived.result, "Per-PR waiver merge gate: ", "branch selector with a waiver"), /the PR of branch feature\/other carries a waiver; name the PR by number or URL/);
    // A selector that is not literal is not read.
    const variable = callMerge('gh pr merge "$PR" --merge', repo, { view: prView({ body: "" }), prNumber: "31" });
    assert.match(blockedBy(variable.result, "Per-PR waiver merge gate: ", "variable selector"), /cannot be read literally; name it by number or URL/);
    assert.deepEqual(variable.trace, [], "nothing is read for a selector that is not literal");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// A selector case: "31" is the current branch's PR, which is never read, so a merge without a selector blocks before any
// read (PR #3703 r9 W3-F2); any other number is the selector of the merge clause, read and compared.
function checkSelector(cmd, pr, { result, trace }) {
  if (pr === "31") {
    assert.match(blockedBy(result, "Per-PR waiver merge gate: ", JSON.stringify(cmd)), /the PR of this merge cannot be resolved/, JSON.stringify(cmd));
    assert.deepEqual(trace, [], JSON.stringify(cmd));
    return;
  }
  assert.equal(result, null, `${JSON.stringify(cmd)}: ${JSON.stringify(result)}`);
  assert.deepEqual(trace.map((entry) => entry.pr), [pr], JSON.stringify(cmd));
}

// Shell redirections and a heredoc in the merge clause are not the PR selector (round 8 F-ppdv-18): with no selector
// the merge is blocked (the current branch's PR is never read), and a number after a redirection is still the selector.
// [Scenario: pre-tool-mechanical-gates :: An undeterminable PR or target repository blocks the merge]
test("redirections and a heredoc after gh pr merge are not the PR selector", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    const cases = [
      ["gh pr merge --squash 2>&1", "31"],
      ["gh pr merge --squash > /tmp/merge.log", "31"],
      ["gh pr merge --squash >/tmp/merge.log", "31"],
      ["gh pr merge --squash >> /tmp/merge.log 2>&1", "31"],
      ["gh pr merge --squash --delete-branch 2>&1 | tail -5", "31"],
      ["gh pr merge --squash &>/dev/null", "31"],
      ["gh pr merge --squash < /dev/null", "31"],
      ["gh pr merge --squash --body-file - <<'EOF'\nmerged after review\nEOF", "31"],
      ["gh pr merge 23 --squash 2>&1", "23"],
      ["gh pr merge --squash 2>/dev/null 23", "23"],
    ];
    for (const [cmd, pr] of cases) {
      checkSelector(cmd, pr, callMerge(cmd, repo, { view: prView({ body: WAIVED }), prNumber: "31" }));
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// The same root cause in other shell syntax (round 9 F-ppdv-20): a ")" closing a subshell, the operand of a here-string
// written apart, and a background "&" are not the PR selector either.
// [Scenario: pre-tool-mechanical-gates :: An undeterminable PR or target repository blocks the merge]
test("a subshell close, a here-string operand and a background & after gh pr merge are not the PR selector", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    const cases = [
      ["(cd /tmp && gh pr merge --squash 12)", "12"],
      ["(gh pr merge --squash)", "31"],
      ["gh pr merge --squash <<< y", "31"],
      ["gh pr merge 12 --squash <<< y", "12"],
      ["gh pr merge --squash 2>&1 &", "31"],
    ];
    for (const [cmd, pr] of cases) {
      checkSelector(cmd, pr, callMerge(cmd, repo, { view: prView({ body: WAIVED }), prNumber: "31" }));
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// The clause ends at a comment or at the ")" closing a subshell, also when that ")" sits on a --repo value
// (round 10 F-ppdv-22).
// [Scenario: pre-tool-mechanical-gates :: An undeterminable PR or target repository blocks the merge]
test("a trailing comment and a subshell's closing paren end the gh pr merge clause", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    const cases = [
      ["gh pr merge --squash # merge it", "31"],
      ["gh pr merge 12 --squash # merge it", "12"],
      ["(cd /tmp && gh pr merge 12 --squash --repo owner/repo)", "12"],
      ["(cd /tmp && gh pr merge 12 --squash -R owner/repo)", "12"],
      ["(cd /tmp && gh pr merge 12 --squash --repo=owner/repo)", "12"],
    ];
    for (const [cmd, pr] of cases) {
      checkSelector(cmd, pr, callMerge(cmd, repo, { view: prView({ body: WAIVED }), prNumber: "31" }));
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// A variable selector names the PR its last assignment in the same command gives as a literal number (round 10
// F-ppdv-21); without such an assignment it still blocks. The cross-model merge gate does not read the assignment and
// blocks a variable selector (#3556), so the hotfix carrier recipe now names the merged PR literally.
// [Scenario: pre-tool-mechanical-gates :: An undeterminable PR or target repository blocks the merge]
test("a variable selector is read through its literal assignment earlier in the same command", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const plain = prView({ body: bodyOf("N/A: docs only") });
    const recipe = 'PRODUCTION_PR=12\nCARRIER_SHA=$(git rev-parse HEAD)\ngh pr merge "$PRODUCTION_PR" --merge --match-head-commit "$CARRIER_SHA"';
    for (const cmd of [recipe, "PR=12; gh pr merge $PR --merge", "export PR=12 && gh pr merge \"${PR}\" --merge", "PR='12'; gh pr merge \"$PR\" --merge"]) {
      const { result, trace } = callMerge(cmd, repo, { view: plain, prNumber: "31" });
      assert.equal(result, null, `${JSON.stringify(cmd)}: ${JSON.stringify(result)}`);
      assert.deepEqual(trace.map((entry) => entry.pr), ["12"], JSON.stringify(cmd));
    }
    for (const [label, cmd] of [
      ["last assignment not literal", 'PR=12; PR=$(cat pr.txt); gh pr merge "$PR" --merge'],
      ["assignment only inside a quoted string", 'echo "PR=12"; gh pr merge "$PR" --merge'],
      ["assignment only inside a comment", '# PR=12\ngh pr merge "$PR" --merge'],
      ["assignment after the merge", 'gh pr merge "$PR" --merge; PR=12'],
      ["assignment only as an environment prefix of gh", 'PR=12 gh pr merge "$PR" --merge'],
    ]) {
      const { result, trace } = callMerge(cmd, repo, { view: plain, prNumber: "31" });
      assert.match(blockedBy(result, "Per-PR waiver merge gate: ", label), /cannot be read literally/);
      assert.deepEqual(trace, [], label);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// Every real gh pr merge clause of the command is compared, not only the first (round 8 F-ppdv-19); any block blocks.
// [Scenario: pre-tool-mechanical-gates :: A cross-repository merge blocks only a waiver]
test("every gh pr merge clause of a command is compared and any block blocks the command", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    const both = callMerge("gh pr merge 12 --squash && gh pr merge 13 --squash", repo, { view: prView({ body: WAIVED }) });
    assert.equal(both.result, null, JSON.stringify(both.result));
    assert.deepEqual(both.trace.map((entry) => entry.pr), ["12", "13"], "each clause reads its own PR");
    const second = callMerge("gh pr merge 12 --squash && gh pr merge 13 --squash --repo other/repo", repo, { view: prView({ body: WAIVED }) });
    assert.match(blockedBy(second.result, "Per-PR waiver merge gate: ", "second clause into another repository"), /PR #13 carries a waiver, but the merge selects other\/repo/);
    assert.deepEqual(second.trace.map((entry) => entry.pr), ["12", "13"]);
    const unreadable = callMerge('gh pr merge 12 --squash; gh pr merge "$PR" --squash', repo, { view: prView({ body: WAIVED }) });
    assert.match(blockedBy(unreadable.result, "Per-PR waiver merge gate: ", "second clause not literal"), /cannot be read literally/);
    assert.deepEqual(unreadable.trace.map((entry) => entry.pr), ["12"]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: pre-tool-mechanical-gates :: A host-qualified repository value of this checkout is the local repository]
test("a host-qualified value naming this checkout is the local repository; another host with a waiver is a cross-repository merge", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const clean = prView({ body: bodyOf("N/A: docs only") });
    for (const [label, cmd, env] of [
      ["--repo HOST/OWNER/REPO", "gh pr merge 23 --repo github.com/owner/repo --merge", {}],
      ["-R OWNER/REPO", "gh pr merge 23 -R owner/repo --merge", {}],
      ["hook GH_REPO host form", "gh pr merge 23 --merge", { GH_REPO: "github.com/owner/repo" }],
      ["upper-case owner/repo", "gh pr merge 23 --repo GitHub.com/Owner/Repo --merge", {}],
    ]) {
      assert.equal(callMerge(cmd, repo, { view: clean, env }).result, null, label);
    }
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    for (const [label, cmd] of [
      ["--repo other-host", "gh pr merge 23 --repo ghe.example.com/owner/repo --merge"],
      ["--repo other-host with port", "gh pr merge 23 --repo ghe.example.com:8443/owner/repo --merge"],
    ]) {
      const { result } = callMerge(cmd, repo, { view: prView({ body: WAIVED }) });
      assert.ok(blockedBy(result, "Per-PR waiver merge gate: ", label).includes("gh pr edit"), label);
    }
    // A same-repository value for a description that carries a waiver with a matching record passes.
    assert.equal(callMerge("gh pr merge 23 --repo github.com/owner/repo --merge", repo, { view: prView({ body: WAIVED }) }).result, null);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// A target is "another repository" also when origin cannot be resolved.
// [Scenario: pre-tool-mechanical-gates :: A cross-repository merge blocks only a waiver]
test("a named target with an unresolvable origin counts as another repository, but only with a waiver part", () => {
  const repo = makeRepo({ kind: "direct", origin: "/local/path/not-a-slug" });
  try {
    const waived = callMerge("gh pr merge 23 --repo owner/repo --merge", repo, { view: prView({ body: WAIVED }) });
    blockedBy(waived.result, "Per-PR waiver merge gate: ", "origin unresolved");
    assert.equal(callMerge("gh pr merge 23 --repo owner/repo --merge", repo, { view: prView({ body: bodyOf("N/A: docs only") }) }).result, null);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: pre-tool-mechanical-gates :: A fork PR with a waiver is blocked even when a local record matches]
test("a fork PR (isCrossRepository true or missing) with a waiver blocks without reading the record file; false passes", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    // An unreadable notes file proves the record file is not read: reading it would say "cannot be read".
    writeNotes(repo, "unreadable");
    for (const [label, isCrossRepository] of [["true", true], ["missing", undefined], ["a string", "false"], ["null", null]]) {
      const { result } = callMerge("gh pr merge 23 --merge", repo, { view: prView({ body: WAIVED, isCrossRepository }) });
      const reason = blockedBy(result, label === "true" ? "DEV deploy-verify gate: " : "Per-PR waiver merge gate: ", label);
      assert.ok(!reason.includes("cannot be read"), `${label}: ${reason}`);
      if (label === "true") {
        assert.ok(reason.includes("the PR head branch is in another repository"), reason);
        assert.ok(reason.includes("replace the waiver with the actual status"), reason);
        assert.ok(!reason.includes("ask the user"), reason);
      } else {
        assert.ok(reason.includes("isCrossRepository"), reason);
      }
    }
    writeNotes(repo, null);
    rmSync(path.join(repo, "notes"), { recursive: true, force: true });
    writeNotes(repo, waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] })));
    assert.equal(callMerge("gh pr merge 23 --merge", repo, { view: prView({ body: WAIVED, isCrossRepository: false }) }).result, null, "false passes with the matching record");
    assert.equal(callMerge("gh pr merge 23 --merge", repo, { view: prView({ body: bodyOf("N/A: docs only"), isCrossRepository: undefined }) }).result, null, "the field is only required with a waiver part");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("only a real gh pr merge command segment triggers the gate", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    for (const cmd of ['echo "gh pr merge 23 --merge"', "git commit -m 'gh pr merge 23'", "gh pr view 23", "gh pr edit 23 --title x", "# gh pr merge 23"]) {
      const { result, trace } = callMerge(cmd, repo, { view: prView({ body: WAIVED }) });
      assert.equal(result, null, cmd);
      assert.deepEqual(trace, [], cmd);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("the merge comparison does not check the DEV line format", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    for (const body of ["## Test Evidence\nno DEV line at all\n", bodyOf("pending: x"), bodyOf("not verified"), bodyOf("N/A:")]) {
      assert.equal(callMerge("gh pr merge 23 --merge", repo, { view: prView({ body }) }).result, null, JSON.stringify(body));
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// fix-cross-repo-merge-destination: a merge into another repository reads that repository's checkout, never the
// session's. The hub holds a matching record and the target does not: the hub's record must not let the merge pass.
test("cross-repo merge: the hub's record never covers the target's PR; the target checkout's own record does", () => {
  const hub = makeRepo({ kind: "direct", origin: "https://github.com/owner/hub.git" });
  const target = makeRepo({ kind: "direct", origin: "https://github.com/owner/target.git" });
  try {
    const record = waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] }));
    writeNotes(hub, record);
    const view = prView({ body: WAIVED });
    const command = `DEVPRO_CROSS_REPO_PR=github.com/owner/target DEVPRO_PR_CHECKOUT="${target}" gh pr merge 23 --repo github.com/owner/target --merge`;
    const traceFile = path.join(hub, "merge-waiver-reads.jsonl");
    function withTargetTrace(merge, view) {
      writeFileSync(traceFile, "");
      const result = runHook(hub, merge, { view, extraEnv: { CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: traceFile } });
      const reads = readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        .filter(({ helper }) => helper === "_runGhPrView");
      return { result, reads };
    }
    const fromHubRecord = withTargetTrace(command, view).result;
    assert.equal(fromHubRecord.json?.decision, "block", `${fromHubRecord.stdout}\n${fromHubRecord.stderr}`);
    // Blocked for the target's missing record, not for a fork head: the two reasons are asserted apart (PR #3703 r11
    // W8-F1).
    assert.match(fromHubRecord.json.reason, /^DEV deploy-verify gate: .*notes\/session-pending\.md does not exist/);
    assert.doesNotMatch(fromHubRecord.json.reason, /head branch is in another repository/);
    // Only the target holds the record: the merge passes, so the hub's record is never required too (PR #3703 r10 W8-F1).
    rmSync(path.join(hub, "notes/session-pending.md"));
    writeNotes(target, record);
    passedWholeHook(runHook(hub, command, { view }), "only the target checkout holds the record");
    // The record covers a PR whose head is in the target only: a fork PR is still blocked (PR #3703 r9 W9-F1, W10-F4).
    for (const isCrossRepository of [true, undefined]) {
      const { result: fork, reads } = withTargetTrace(command, prView({ body: WAIVED, isCrossRepository }));
      assert.equal(fork.json?.decision, "block", `fork ${isCrossRepository}: ${fork.stdout}\n${fork.stderr}`);
      const expected = isCrossRepository ? /^DEV deploy-verify gate: .*the PR head branch is in another repository/ : /^Per-PR waiver merge gate: PR #23 carries a waiver, but gh pr view returned no isCrossRepository field/;
      assert.match(fork.json.reason, expected, fork.json.reason);
      assert.ok(reads.length > 0, "the fork case fetches the PR before waiver evaluation");
      assert.ok(reads.every(({ pr, repo }) => pr === "23" && repo === "github.com/owner/target"), JSON.stringify(reads));
    }
    // Without the marker and the checkout, the cross-repo merge gate blocks before any record is read.
    const { result: bare, reads } = withTargetTrace("gh pr merge 23 --repo github.com/owner/target --merge", view);
    assert.equal(bare.json?.decision, "block", bare.stdout);
    assert.match(bare.json.reason, /^Cross-repo PR merge gate: this merges github\.com\/owner\/target/);
    assert.deepEqual(reads, [], "an unbound merge does not look up any PR");
  } finally {
    rmSync(hub, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
