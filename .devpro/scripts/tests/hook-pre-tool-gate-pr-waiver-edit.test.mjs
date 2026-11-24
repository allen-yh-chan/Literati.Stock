import "./lib/git-location-isolated-env.mjs";
import "./lib/isolated-control-evidence-state.mjs";
/**
 * hook-pre-tool-gate-pr-waiver-edit.test.mjs
 *
 * `gh pr edit` with a new description is compared with the answer-time records
 * before the edit (inventory gate `per-pr-waiver-edit-record`; openspec-flow
 * requirement "PR Description Edit Compares Per-PR Waiver Lines With Answer-Time
 * Records"). The shared edit case table (pr-waiver-two-path-cases.mjs) runs through
 * the gate function from a checkout on `main`, with `--body-file` and `-F`. MCP
 * `update_issue` is not an edit path: the MCP backend refuses it for a PR number (#3496).
 *
 * Mocks: CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT is the `gh pr view` JSON,
 * CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE records every `_runGhPrView` call, and
 * CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER is the PR of the current branch,
 * set to another number than the selector so the PR number in the message proves
 * which PR was read. Every fixture is a temporary repository.
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
const OTHER_PR = "77";
// A comparison of a waiver needs the repository of the edit written in full: OWN for a makeRepo() checkout (origin
// owner/repo), SRC for a source one.
const OWN = "--repo github.com/owner/repo";
const SRC = "--repo github.com/owner/devpro-agent-rules";
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
  "GH_HOST",
];

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// kind: "direct" (consumer without .gitmodules), "source" (origin + sentinels), "unknown".
function makeRepo({ kind = "direct", branch = "main" } = {}) {
  const repo = makeTempDir("waiver-edit-");
  git(repo, ["init", "-q", "-b", branch]);
  if (kind === "direct") {
    mkdirSync(path.join(repo, ".devpro-agent-rules/.devpro/scripts"), { recursive: true });
    writeFileSync(path.join(repo, ".devpro-agent-rules/AGENTS.md"), "consumer rules");
    writeFileSync(path.join(repo, ".devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs"), "consumer rules");
  }
  if (kind === "source") {
    mkdirSync(path.join(repo, ".devpro/agent-rules"), { recursive: true });
    mkdirSync(path.join(repo, ".devpro/scripts"), { recursive: true });
    writeFileSync(path.join(repo, ".devpro/agent-rules/rule-audit-playbook.md"), "source");
    writeFileSync(path.join(repo, ".devpro/scripts/pre-pr-archive-gate.mjs"), "source");
  }
  git(repo, ["remote", "add", "origin", kind === "source" ? "https://github.com/owner/devpro-agent-rules.git" : "https://github.com/owner/repo.git"]);
  git(repo, ["commit", "--allow-empty", "-q", "--no-verify", "-m", "init"]);
  return repo;
}

function writeNotes(repo, notes) {
  if (notes === null || notes === undefined) return;
  mkdirSync(path.join(repo, "notes"), { recursive: true });
  if (notes === "unreadable") mkdirSync(path.join(repo, "notes/session-pending.md"));
  else writeFileSync(path.join(repo, "notes/session-pending.md"), notes);
}

const bodyOf = (dev) => `## Test Evidence\n- DEV deploy-verify: HEAD ${SHA}; ${dev}\n`;
const WAIVED = bodyOf("skipped per user decision: X");
const MATCHING_NOTES = waiverCases.notesOf(waiverCases.entry({ records: [waiverCases.devRecord("X")] }));

function bodyFile(text) {
  const file = path.join(makeTempDir("waiver-edit-body-"), "body.md");
  writeFileSync(file, text);
  return file;
}

function prView(fields = {}) {
  const view = { comments: [], headRefOid: SHA, headRefName: waiverCases.BRANCH, baseRefName: "main", state: "OPEN", isCrossRepository: false, ...fields };
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

function callEdit(cmd, repo, { view = prView(), env = {}, currentPr = OTHER_PR } = {}) {
  const traceFile = path.join(makeTempDir("waiver-edit-trace-"), "trace.jsonl");
  const result = withEnv({
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: typeof view === "string" ? view : JSON.stringify(view),
    CROSS_MODEL_MERGE_GATE_TRACE_REPO_FILE: traceFile,
    CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: currentPr,
    ...env,
  }, () => hook.checkPerPrWaiverOnEdit(cmd, repo));
  const trace = existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { result, trace };
}

function runHook(repo, command, { view, level = "lite" } = {}) {
  const env = {
    ...process.env,
    CODEX_CI: "",
    CODEX_THREAD_ID: "",
    DEVPRO_AGENT_RULES_LEVEL: level,
    DEVPRO_SENTINEL_STATE_DIR: makeTempDir("sentinel-waiver-edit-"),
    DEVPRO_POSTMERGE_STATE_DIR: makeTempDir("postmerge-waiver-edit-"),
    DEVPRO_RECAP_PENDING_DIR: makeTempDir("recap-pending-waiver-edit-"),
    DEVPRO_RECAP_STATE_DIR: makeTempDir("recap-state-waiver-edit-"),
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify(view ?? prView()),
    CROSS_MODEL_MERGE_GATE_MOCK_CURRENT_PR_NUMBER: OTHER_PR,
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

// ── The shared edit case table, through the gate function, from a checkout on main ──────────────────────

// [Scenario: openspec-flow :: A description edit that adds an unmatched waiver is blocked before the edit]
// [Scenario: openspec-flow :: A description edit whose waiver matches a record passes]
// [Scenario: openspec-flow :: A description edit without a waiver part passes without reading records]
for (const c of waiverCases.EDIT_CASES) {
  for (const flag of ["--body-file", "-F"]) {
    test(`[Scenario: openspec-flow :: ${c.scenario}] ${c.id} (gh pr edit ${flag})`, () => {
      const repo = makeRepo({ kind: "direct", branch: "main" });
      try {
        writeNotes(repo, c.notes);
        const file = bodyFile(bodyOf(c.dev));
        const { result, trace } = callEdit(`gh pr edit 23 ${OWN} ${flag} ${file}`, repo, { view: prView({ headRefName: c.head, isCrossRepository: Boolean(c.cross) }) });
        if (!c.expect.block) {
          assert.equal(result, null, `${c.id}: ${JSON.stringify(result)}`);
          if (!/skipped per user decision:/i.test(c.dev)) assert.deepEqual(trace, [], `${c.id}: no gh call without a waiver part`);
          return;
        }
        const reason = blockedBy(result, `${c.expect.gate}: `, c.id);
        // The selector's PR (23), not the PR of the current branch (77), is the one the message names.
        assert.ok(reason.includes("Edit-time check of PR #23"), `${c.id}: ${reason}`);
        assert.ok(!reason.includes(`#${OTHER_PR}`), `${c.id}: names the PR of the current branch\n${reason}`);
        for (const needle of c.expect.includes) assert.ok(reason.includes(needle), `${c.id}: missing ${needle}\n${reason}`);
        for (const needle of c.expect.excludes) assert.ok(!reason.includes(needle), `${c.id}: must not contain ${needle}\n${reason}`);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    });
  }
}

// [Scenario: pre-tool-mechanical-gates :: gh pr edit with a body file is compared before the edit]
test("inventory: per-pr-waiver-edit-record is its own STATE_BACKED BLOCK entry right after per-pr-waiver-merge-record and is not a baseline gate", () => {
  const ids = hook.BASH_BLOCKING_GATES.map((entry) => entry.id);
  const at = ids.indexOf("per-pr-waiver-edit-record");
  assert.ok(at > 0, "registered");
  assert.equal(ids[at - 1], "per-pr-waiver-merge-record");
  assert.equal(ids.filter((id) => id === "per-pr-waiver-edit-record").length, 1);
  const entry = hook.BASH_BLOCKING_GATES[at];
  assert.equal(entry.bucket, hook.GATE_BUCKETS.STATE_BACKED);
  assert.equal(entry.decision, hook.GATE_DECISIONS.BLOCK);
  assert.equal(entry.evidence, "github-pr-state");
  assert.equal(entry.risk, "pr-body-hygiene");
  assert.ok(!BASELINE_GATE_IDS.includes("per-pr-waiver-edit-record"), "not a baseline gate");
});

// [Scenario: pre-tool-mechanical-gates :: gh pr edit with a body file is compared before the edit]
test("hook: gh pr edit <number> --body-file / -F with an unmatched waiver is blocked by per-pr-waiver-edit-record, naming the edit-time check of that PR", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const file = bodyFile(WAIVED);
    const control = runHook(repo, `gh pr edit 23 ${OWN} --body-file ${bodyFile(bodyOf("N/A: docs only"))}`);
    passedWholeHook(control, "the control (no waiver part) must pass the whole hook first");
    for (const flag of ["--body-file", "-F"]) {
      const r = runHook(repo, `gh pr edit 23 ${OWN} ${flag} ${file}`);
      assert.equal(r.json?.decision, "block", `${flag}: ${r.stdout}\n${r.stderr}`);
      assert.match(r.json.reason, /^DEV deploy-verify gate: /);
      assert.ok(r.json.reason.includes("Edit-time check of PR #23"), r.json.reason);
      assert.ok(!r.json.reason.includes("DEVPRO_HOOK_BYPASS"), "no bypass hint");
      assert.ok(!r.json.reason.includes("gh pr create"), "no gh pr create recipe");
    }
    const entry = hook.BASH_BLOCKING_GATES.find((gate) => gate.id === "per-pr-waiver-edit-record");
    assert.ok(entry, "per-pr-waiver-edit-record is registered");
    const viaRunner = withEnv({ CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify(prView()) },
      () => entry.runner({ cmd: `gh pr edit 23 ${OWN} --body-file ${file}`, baseCwd: repo, effectiveCwd: repo }));
    assert.match(viaRunner?.reason ?? "", /^DEV deploy-verify gate: /, JSON.stringify(viaRunner));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: Source repository and rigor off do not compare description edits]
test("hook at rigor off does not compare an edit; at lite the same edit blocks", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const file = bodyFile(WAIVED);
    const off = runHook(repo, `gh pr edit 23 ${OWN} --body-file ${file}`, { level: "off" });
    passedWholeHook(off, "rigor off");
    const lite = runHook(repo, `gh pr edit 23 ${OWN} --body-file ${file}`, { level: "lite" });
    assert.equal(lite.json?.decision, "block", `${lite.stdout}\n${lite.stderr}`);
    assert.match(lite.json.reason, /^DEV deploy-verify gate: /);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: Source repository and rigor off do not compare description edits]
// [Scenario: pre-tool-mechanical-gates :: An unreadable new description is blocked in a consumer checkout]
test("source: the body file is not read and gh is not called; the same unreadable forms are not blocked", () => {
  const repo = makeRepo({ kind: "source" });
  try {
    const trace = [];
    for (const cmd of [`gh pr edit 23 ${SRC} --body-file ${bodyFile(WAIVED)}`, `gh pr edit 23 ${SRC} --body-file /nonexistent/body.md`, `gh pr edit 23 ${SRC} --body-file -`, `gh pr edit 23 ${SRC} --body "$(cat body.md)"`]) {
      const out = callEdit(cmd, repo, { view: prView() });
      assert.equal(out.result, null, cmd);
      trace.push(...out.trace);
    }
    assert.deepEqual(trace, [], "_runGhPrView must not be called for a positive source");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("source: an edit of another repository's PR is read like any other, so the exemption never covers it", () => {
  const repo = makeRepo({ kind: "source" });
  try {
    const reason = blockedBy(callEdit("gh pr edit 23 --repo github.com/other/repo --body-file /nonexistent/body.md", repo, { view: prView() }).result, "Per-PR waiver edit gate: ", "other repository");
    assert.match(reason, /new description of this gh pr edit cannot be read/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("source: the exemption needs the command to write its own repository in full; anything less is compared (PR #3703 r1 F1, F2; r2 F1, F3)", () => {
  const repo = makeRepo({ kind: "source" });
  try {
    const waived = bodyFile(WAIVED);
    const inFull = /the new description carries a waiver; write the repository of gh pr edit in full/;
    // Its own repository written in full keeps the exemption: nothing is read and gh is not called, whatever GH_HOST says.
    for (const [cmd, env] of [["gh pr edit 23 --repo github.com/owner/devpro-agent-rules --body-file /nonexistent/body.md", { GH_HOST: "ghe.example.com" }], ["gh pr edit https://github.com/owner/devpro-agent-rules/pull/23 --body-file /nonexistent/body.md", {}], [`export GH_HOST=ghe.example.com; gh pr edit 23 ${SRC} --body "${WAIVED}"`, {}]]) {
      const out = callEdit(cmd, repo, { env });
      assert.equal(out.result, null, cmd);
      assert.deepEqual(out.trace, [], cmd);
    }
    // No host, no target, or only an inherited GH_REPO: the shell may pick another host or repository, so the
    // description is read, and a waiver in it is blocked until the repository is written in full.
    for (const [cmd, env] of [
      [`gh pr edit 23 --repo owner/devpro-agent-rules --body-file ${waived}`, { GH_HOST: "ghe.example.com" }],
      [`gh pr edit 23 --repo owner/devpro-agent-rules --body-file ${waived}`, {}],
      [`gh pr edit 23 --body-file ${waived}`, {}],
      [`gh pr edit 23 --body-file ${waived}`, { GH_REPO: "github.com/owner/devpro-agent-rules" }],
      [`GH_HOST=ghe.example.com gh pr edit 23 --repo owner/devpro-agent-rules --body "${WAIVED}"`, {}],
      [`export GH_HOST=ghe.example.com; gh pr edit 23 --repo owner/devpro-agent-rules --body "${WAIVED}"`, {}],
    ]) {
      assert.match(blockedBy(callEdit(cmd, repo, { env }).result, "Per-PR waiver edit gate: ", cmd), inFull, cmd);
    }
    assert.match(blockedBy(callEdit("gh pr edit 23 --body-file /nonexistent/body.md", repo).result, "Per-PR waiver edit gate: ", "no target"), /new description of this gh pr edit cannot be read/);
    assert.equal(callEdit(`gh pr edit 23 --repo owner/devpro-agent-rules --body-file ${bodyFile(bodyOf("N/A: docs only"))}`, repo).result, null);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("source: the exemption reads only the written repository, so a branch selector of its own PR is exempt too (PR #3703 r4 F2)", () => {
  const source = makeRepo({ kind: "source" });
  const direct = makeRepo({ kind: "direct" });
  try {
    const waived = bodyFile(WAIVED);
    for (const cmd of [`gh pr edit 23 ${SRC} --body-file ${waived}`, `gh pr edit feature/x ${SRC} --body-file ${waived}`]) {
      const out = callEdit(cmd, source);
      assert.equal(out.result, null, cmd);
      assert.deepEqual(out.trace, [], cmd);
    }
    // Without a selector gh edits its current-branch PR, which the command does not name, so the edit is not exempt:
    // its body file is read like any other, a waiver is blocked before any gh call, an unreadable file is blocked, and
    // a description without a waiver passes (PR #3703 r11 W7-F1, #3706 r1 F4).
    const unnamed = callEdit(`gh pr edit ${SRC} --body-file ${waived}`, source);
    assert.match(blockedBy(unnamed.result, "Per-PR waiver edit gate: ", "no selector"), /name the PR by number or URL when the new description carries a waiver/);
    assert.deepEqual(unnamed.trace, []);
    const unreadable = callEdit(`gh pr edit ${SRC} --body-file /nonexistent/body.md`, source);
    assert.match(blockedBy(unreadable.result, "Per-PR waiver edit gate: ", "no selector, unreadable file"), /new description of this gh pr edit cannot be read/);
    assert.deepEqual(unreadable.trace, []);
    const plain = callEdit(`gh pr edit ${SRC} --body-file ${bodyFile(bodyOf("N/A: docs only"))}`, source);
    assert.equal(plain.result, null);
    assert.deepEqual(plain.trace, []);
    // Where a waiver is compared, a branch selector still cannot name the record's PR.
    const branch = callEdit(`gh pr edit feature/x ${OWN} --body-file ${waived}`, direct);
    assert.match(blockedBy(branch.result, "Per-PR waiver edit gate: ", "branch selector"), /name the PR by number or URL when the new description carries a waiver/);
    assert.deepEqual(branch.trace, []);
    // Without a waiver part the selector does not matter.
    assert.equal(callEdit(`gh pr edit feature/x ${OWN} --body-file ${bodyFile(bodyOf("N/A: docs only"))}`, direct).result, null);
  } finally {
    for (const dir of [source, direct]) rmSync(dir, { recursive: true, force: true });
  }
});

// [Scenario: pre-tool-mechanical-gates :: A source edit is exempt only for a selector that names its own PR]
test("source: a selector the hook cannot read gets no exemption, because its value can be another repository's PR URL (PR #3703 r9 W3-F1)", () => {
  const source = makeRepo({ kind: "source" });
  try {
    const waived = bodyFile(WAIVED);
    // $PR may hold https://github.com/other/repo/pull/5: gh would edit that PR, whatever --repo says.
    for (const [label, cmd] of [["variable", `gh pr edit $PR ${SRC} --body-file ${waived}`], ["quoted variable", `gh pr edit "$PR" ${SRC} --body-file ${waived}`], ["joined word", `gh pr edit "2"3 ${SRC} --body-file ${waived}`], ["inline body, variable", `gh pr edit \${PR} ${SRC} --body '${WAIVED}'`]]) {
      const out = callEdit(cmd, source);
      const reason = blockedBy(out.result, "Per-PR waiver edit gate: ", label);
      assert.ok(reason.startsWith("Per-PR waiver edit gate: name the PR by number or URL when the new description carries a waiver"), `${label}: ${reason}`);
      assert.deepEqual(out.trace, [], `${label}: nothing is read`);
    }
    // Without a waiver part the edit is not compared, so the unread selector does not matter.
    assert.equal(callEdit(`gh pr edit $PR ${SRC} --body-file ${bodyFile(bodyOf("N/A: docs only"))}`, source).result, null);
    // A literal branch name, a number and its own PR URL keep the exemption.
    for (const cmd of [`gh pr edit feature/x ${SRC} --body-file ${waived}`, `gh pr edit 23 ${SRC} --body-file ${waived}`, `gh pr edit https://github.com/owner/devpro-agent-rules/pull/23 --body-file ${waived}`]) {
      const out = callEdit(cmd, source);
      assert.equal(out.result, null, cmd);
      assert.deepEqual(out.trace, [], cmd);
    }
  } finally { rmSync(source, { recursive: true, force: true }); }
});

test("source: a body-file edit of its own PR still stands alone, checked before the exemption reads nothing (PR #3703 r1 F3)", () => {
  const repo = makeRepo({ kind: "source" });
  try {
    for (const cmd of [`gh pr view 1 && gh pr edit 23 ${SRC} --body-file ${bodyFile(WAIVED)}`, `gh pr edit 23 ${SRC} --body-file /nonexistent/body.md | tail -1`, `DEVPRO_NOTE=x\ngh pr edit 23 ${SRC} --body-file /nonexistent/body.md`]) {
      const out = callEdit(cmd, repo);
      assert.match(blockedBy(out.result, "Per-PR waiver edit gate: ", cmd), /another step (comes before|follows) gh pr edit/);
      assert.deepEqual(out.trace, [], cmd);
    }
    const alone = callEdit(`gh pr edit 23 ${SRC} --body-file /nonexistent/body.md`, repo);
    assert.equal(alone.result, null);
    assert.deepEqual(alone.trace, []);
    // An inline --body is not read from a file before the shell runs, so it is not held to the standalone form.
    assert.equal(callEdit(`gh pr view 1 && gh pr edit 23 ${SRC} --body "${WAIVED}"`, repo).result, null);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ── Edits that set no description, and the command position ─────────────────────────────────────────────

// [Scenario: openspec-flow :: A description edit without a waiver part passes without reading records]
test("an edit that sets no description is not inspected: no body read, no gh call, no records", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, "unreadable");
    for (const cmd of ["gh pr edit 23 --title x", "gh pr edit 23 --add-label bug --remove-label wip", "gh pr edit 23 --base main", 'gh pr edit 23 --title "new body-file title"', "gh pr edit 23 --milestone 5"]) {
      const { result, trace } = callEdit(cmd, repo, { view: "not-json" });
      assert.equal(result, null, cmd);
      assert.deepEqual(trace, [], `${cmd}: no gh call`);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a body without a waiver part passes without a gh call, a record read or git", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, "unreadable");
    for (const dev of ["N/A: docs only", "pending: x", "deployed PR head to DEV; login path passed"]) {
      const { result, trace } = callEdit(`gh pr edit 23 --body-file ${bodyFile(bodyOf(dev))}`, repo, { view: "not-json" });
      assert.equal(result, null, dev);
      assert.deepEqual(trace, [], dev);
    }
    const inline = callEdit(`gh pr edit 23 --body '${bodyOf("N/A: docs only")}'`, repo, { view: "not-json" });
    assert.equal(inline.result, null);
    assert.deepEqual(inline.trace, []);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("only a real gh pr edit command segment triggers the gate", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const file = bodyFile(WAIVED);
    for (const cmd of [`echo "gh pr edit 23 --body-file ${file}"`, `git commit -m 'gh pr edit 23 -F ${file}'`, `gh pr view 23 --body-file ${file}`, `# gh pr edit 23 --body-file ${file}`, `gh pr merge 23 --body-file ${file}`]) {
      const { result, trace } = callEdit(cmd, repo);
      assert.equal(result, null, cmd);
      assert.deepEqual(trace, [], cmd);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ── Unreadable new descriptions ─────────────────────────────────────────────────────────────────────────

// [Scenario: pre-tool-mechanical-gates :: An unreadable new description is blocked in a consumer checkout]
test("consumer and unknown: stdin, command substitution, a variable and a missing file are blocked, naming --body-file <absolute-body-file>", () => {
  for (const kind of ["direct", "unknown"]) {
    const repo = makeRepo({ kind });
    try {
      for (const [label, cmd] of [
        ["stdin", "gh pr edit 23 --body-file -"],
        ["stdin with -F", "gh pr edit 23 -F -"],
        ["command substitution", 'gh pr edit 23 --body "$(cat body.md)"'],
        ["variable", 'gh pr edit 23 --body "$BODY_TEXT"'],
        ["backtick", "gh pr edit 23 -b `cat body.md`"],
        ["body-file with a variable", "gh pr edit 23 --body-file $BODY_FILE"],
        ["missing file", `gh pr edit 23 --body-file ${path.join(repo, "missing-body.md")}`],
      ]) {
        const { result, trace } = callEdit(cmd, repo);
        const reason = blockedBy(result, "Per-PR waiver edit gate: ", `${kind} ${label}`);
        assert.ok(reason.includes("--body-file <absolute-body-file>"), `${kind} ${label}: ${reason}`);
        assert.ok(!reason.includes("DEVPRO_HOOK_BYPASS"), label);
        assert.deepEqual(trace, [], `${kind} ${label}: no gh call for an unreadable description`);
      }
      // An inline literal body is readable, and a single-quoted body may contain $.
      assert.equal(callEdit(`gh pr edit 23 --body '${bodyOf("N/A: docs only")} costs $5'`, repo).result, null);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test("an inline literal body with a waiver is compared; its relative body file resolves from the clause cwd", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const inline = callEdit(`gh pr edit 23 ${OWN} --body '${WAIVED}'`, repo);
    blockedBy(inline.result, "DEV deploy-verify gate: ", "inline literal");
    writeFileSync(path.join(repo, "body.md"), WAIVED);
    const relative = callEdit(`gh pr edit 23 ${OWN} --body-file body.md`, repo);
    assert.ok(blockedBy(relative.result, "DEV deploy-verify gate: ", "relative body file").includes("Edit-time check of PR #23"));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ── PR selector ─────────────────────────────────────────────────────────────────────────────────────────

// Shell redirections after gh pr edit are not the PR selector (round 8 F-ppdv-18).
// [Scenario: pre-tool-mechanical-gates :: gh pr edit with a body file is compared before the edit]
test("redirections after gh pr edit are not the PR selector", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const file = bodyFile(WAIVED);
    for (const [cmd, expectNumber] of [
      [`gh pr edit 23 ${OWN} --body-file ${file} 2>&1`, "23"],
      [`gh pr edit 23 ${OWN} --body-file ${file} > /tmp/edit.log`, "23"],
      [`gh pr edit 23 ${OWN} --body-file ${file} &>/dev/null`, "23"],
      [`gh pr edit ${OWN} --body-file ${file} 2>/dev/null 23`, "23"],
      [`gh pr edit 23 ${OWN} --body-file ${file} &`, "23"],
      [`gh pr edit 23 ${OWN} --body-file ${file} # note`, "23"],
    ]) {
      const reason = blockedBy(callEdit(cmd, repo).result, "DEV deploy-verify gate: ", cmd);
      assert.ok(reason.includes(`Edit-time check of PR #${expectNumber}`), `${cmd}: ${reason}`);
    }
    // A redirection is never the selector: without a number or URL the edit asks for one (PR #3703 r5 F1).
    for (const cmd of [`gh pr edit ${OWN} --body-file ${file} 2>&1`, `gh pr edit ${OWN} --body-file ${file} &>/dev/null`]) {
      assert.ok(blockedBy(callEdit(cmd, repo).result, "Per-PR waiver edit gate: ", cmd).includes("gh pr edit <number> --repo github.com/OWNER/REPO"), cmd);
    }
    // The body file is read before the shell runs, so an edit with a step before or beside it (a pipe,
    // an assignment step) is blocked before the file is compared.
    for (const cmd of [`gh pr edit --body-file ${file} 2>&1 | tail -3`, `N=23; gh pr edit "$N" --body-file ${file}`, `(gh pr edit ${OWN} --body-file ${file})`]) {
      const reason = blockedBy(callEdit(cmd, repo).result, "Per-PR waiver edit gate: ", cmd);
      assert.match(reason, /another step (?:comes before|follows) gh pr edit/, cmd);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: pre-tool-mechanical-gates :: gh pr edit with a body file is compared before the edit]
test("selector: a number, a PR URL or flags before it; no selector, a branch name or a variable is blocked before any read (PR #3703 r5 F1)", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const file = bodyFile(WAIVED);
    const check = (cmd, label, expectNumber, expectRepo) => {
      const { result, trace } = callEdit(cmd, repo);
      const reason = blockedBy(result, "DEV deploy-verify gate: ", label);
      assert.ok(reason.includes(`Edit-time check of PR #${expectNumber}`), `${label}: ${reason}`);
      // gh gets the repository as written, host included (PR #3703 r7 W5-F2), and the PR the selector names, whatever
      // the diagnostic says (PR #3703 r10 W7-F1).
      assert.deepEqual(trace.map((entry) => [entry.repo, entry.pr]), [[expectRepo, expectNumber]], `${label}: one read of the PR`);
    };
    check(`gh pr edit 23 ${OWN} --body-file ${file}`, "number", "23", "github.com/owner/repo");
    check(`gh pr edit ${OWN} --body-file ${file} 23`, "number after the flag", "23", "github.com/owner/repo");
    check(`gh pr edit --title "a b" --add-label x 23 ${OWN} --body-file ${file}`, "value-taking flags before the selector", "23", "github.com/owner/repo");
    check(`gh pr edit --title=x 23 ${OWN} --body-file ${file}`, "--flag=value before the selector", "23", "github.com/owner/repo");
    check(`gh pr edit https://github.com/owner/repo/pull/31 --body-file ${file}`, "PR URL of this repository", "31", "github.com/owner/repo");
    // A PR link inside an inline body is not the selector.
    const linked = bodyOf("skipped per user decision: X") + "see https://github.com/owner/repo/pull/99";
    const inline = callEdit(`gh pr edit 23 ${OWN} --body '${linked}'`, repo);
    assert.ok(blockedBy(inline.result, "DEV deploy-verify gate: ", "link in inline body").includes("Edit-time check of PR #23"));
    // No selector, a branch name or a non-literal selector is blocked and says how to name the PR: the PR of the current
    // branch is never read, even when its records would match.
    for (const [label, cmd] of [["no selector", `gh pr edit ${OWN} --body-file ${file}`], ["no selector, inline body", `gh pr edit ${OWN} --body '${linked}'`], ["branch name", `gh pr edit chore/some-change ${OWN} --body-file ${file}`], ["variable", `gh pr edit $PR ${OWN} --body-file ${file}`], ["number with 9 digits", `gh pr edit 123456789 ${OWN} --body-file ${file}`]]) {
      const out = callEdit(cmd, repo);
      const reason = blockedBy(out.result, "Per-PR waiver edit gate: ", label);
      // Each names its repository in full, so the block is the selector's own reason (PR #3703 r8 W6-F2).
      assert.ok(reason.startsWith("Per-PR waiver edit gate: name the PR by number or URL when the new description carries a waiver"), `${label}: ${reason}`);
      assert.ok(reason.includes("gh pr edit <number> --repo github.com/OWNER/REPO"), `${label}: ${reason}`);
      assert.deepEqual(out.trace, [], `${label}: nothing is read`);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("the selector is only needed when the new description carries a waiver part", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    for (const cmd of [`gh pr edit chore/some-change --body-file ${bodyFile(bodyOf("N/A: docs only"))}`, `gh pr edit --body-file ${bodyFile(bodyOf("pending: x"))}`]) {
      const { result, trace } = callEdit(cmd, repo, { currentPr: "" });
      assert.equal(result, null, cmd);
      assert.deepEqual(trace, [], cmd);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ── Target repository, fork, unreadable PR ──────────────────────────────────────────────────────────────

test("an edit of another repository blocks only a waiver; a PR URL of another repository is read as that repository", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, MATCHING_NOTES);
    const waived = bodyFile(WAIVED);
    const clean = bodyFile(bodyOf("N/A: docs only"));
    // Each reaches the waiver comparison with its destination read, and is blocked for the repository it names, not for
    // its form (PR #3703 r7 W5-F3).
    const otherRepository = (target) => `the new description carries a waiver, but the edit selects ${target}, which is not the repository of this checkout`;
    for (const [label, cmd, expected] of [
      ["--repo", `gh pr edit 23 --repo github.com/other/repo --body-file ${waived}`, otherRepository("github.com/other/repo")],
      ["-R", `gh pr edit 23 -R github.com/other/repo -F ${waived}`, otherRepository("github.com/other/repo")],
      ["PR URL", `gh pr edit https://github.com/other/repo/pull/12 --body-file ${waived}`, otherRepository("github.com/other/repo")],
      ["another host", `gh pr edit 23 --repo ghe.example.com/owner/repo --body-file ${waived}`, otherRepository("ghe.example.com/owner/repo")],
      ["command-local GH_REPO", `GH_REPO=github.com/other/repo gh pr edit 23 --body-file ${waived}`, "GH_REPO= changes what gh reads"],
    ]) {
      const reason = blockedBy(callEdit(cmd, repo).result, "Per-PR waiver edit gate: ", label);
      assert.ok(reason.includes(expected), `${label}: ${reason}`);
    }
    // A repository written without its host, or only in the hook's GH_REPO, is not written in full: a waiver is blocked for that.
    for (const [label, cmd, env] of [
      ["--repo without a host", `gh pr edit 23 --repo other/repo --body-file ${waived}`, {}],
      ["hook GH_REPO", `gh pr edit 23 --body-file ${waived}`, { GH_REPO: "other/repo" }],
    ]) {
      const reason = blockedBy(callEdit(cmd, repo, { env }).result, "Per-PR waiver edit gate: ", label);
      assert.ok(reason.includes("the new description carries a waiver; write the repository of gh pr edit in full"), `${label}: ${reason}`);
    }
    // The edit text is local, so no gh call is needed to decide that another repository is not covered by this checkout's records.
    const url = callEdit(`gh pr edit https://github.com/other/repo/pull/12 --body-file ${waived}`, repo);
    assert.deepEqual(url.trace, [], "another repository is blocked before any gh call");
    for (const cmd of [`gh pr edit 23 --repo other/repo --body-file ${clean}`, `gh pr edit 23 --repo github.com/other/repo --body-file ${clean}`, `gh pr edit https://github.com/other/repo/pull/12 --body-file ${clean}`]) {
      assert.equal(callEdit(cmd, repo).result, null, cmd);
    }
    // The same repository in host form, with a matching record, passes.
    assert.equal(callEdit(`gh pr edit 23 --repo github.com/owner/repo --body-file ${waived}`, repo).result, null);
    for (const [label, cmd] of [["--repo outside the form", `gh pr edit 23 --repo foo --body-file ${waived}`], ["--repo joining quoted parts", `gh pr edit 23 --repo "github.com/owner/repo"-docs --body-file ${waived}`]]) {
      const reason = blockedBy(callEdit(cmd, repo).result, "Per-PR waiver edit gate: ", label);
      assert.ok(reason.includes("--repo [HOST/]OWNER/REPO"), `${label}: ${reason}`);
    }
    // A command-local GH_REPO= is never read (PR #3703 r6 F1): in front of an inline edit with a waiver it blocks.
    for (const cmd of [`GH_REPO=$X gh pr edit 23 --body '${WAIVED}'`, `GH_REPO="github.com/owner/repo"-docs gh pr edit 23 --repo github.com/owner/repo --body '${WAIVED}'`]) {
      assert.match(blockedBy(callEdit(cmd, repo).result, "Per-PR waiver edit gate: ", cmd), /GH_REPO= in front of gh pr edit is not read/);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("an edit's variable selector is never read through an earlier assignment; a literal number is (PR #3703 r6 F3)", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, MATCHING_NOTES);
    for (const cmd of [`N=23; gh pr edit "$N" --repo github.com/owner/repo --body '${WAIVED}'`, `N=23; gh pr edit $N --repo github.com/owner/repo --body '${WAIVED}'`]) {
      const out = callEdit(cmd, repo);
      assert.ok(blockedBy(out.result, "Per-PR waiver edit gate: ", cmd).includes("gh pr edit <number> --repo github.com/OWNER/REPO"), cmd);
      assert.deepEqual(out.trace, [], `${cmd}: nothing is read`);
    }
    // Same assignment and checkout, only the selector differs (PR #3703 r10 W7-F2).
    const literal = callEdit(`N=23; gh pr edit 23 --repo github.com/owner/repo --body '${WAIVED}'`, repo);
    assert.equal(literal.result, null, JSON.stringify(literal.result));
    assert.deepEqual(literal.trace.map((entry) => entry.pr), ["23"]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a waiver edit binds the checkout by the origin URL it stores: one git rewrites binds nothing (PR #3703 r6 F5)", () => {
  const rewritten = makeRepo({ kind: "direct" });
  const stored = makeRepo({ kind: "direct" });
  try {
    for (const repo of [rewritten, stored]) writeNotes(repo, MATCHING_NOTES);
    // The rewritten checkout stores other/mirror, but git fetches and pushes owner/repo, so it is no checkout of either.
    git(rewritten, ["remote", "set-url", "origin", "https://github.com/other/mirror.git"]);
    git(rewritten, ["config", "url.https://github.com/owner/repo.git.insteadOf", "https://github.com/other/mirror.git"]);
    const cmd = `gh pr edit 23 --repo github.com/owner/repo --body-file ${bodyFile(WAIVED)}`;
    const blocked = callEdit(cmd, rewritten);
    assert.match(blockedBy(blocked.result, "Per-PR waiver edit gate: ", "rewritten origin"), /not the repository of this checkout/);
    assert.deepEqual(blocked.trace, [], "the PR is not read");
    // Naming the stored URL's repository is blocked too: git fetches and pushes another one, so the stored URL alone
    // binds nothing (PR #3703 r9 W7-F1).
    const storedName = callEdit(`gh pr edit 23 --repo github.com/other/mirror --body-file ${bodyFile(WAIVED)}`, rewritten);
    assert.match(blockedBy(storedName.result, "Per-PR waiver edit gate: ", "stored URL of a rewritten origin"), /not the repository of this checkout/);
    assert.deepEqual(storedName.trace, [], "the PR is not read");
    const passed = callEdit(cmd, stored);
    assert.equal(passed.result, null, JSON.stringify(passed.result));
    assert.deepEqual(passed.trace.map((entry) => entry.pr), ["23"]);
  } finally {
    for (const repo of [rewritten, stored]) rmSync(repo, { recursive: true, force: true });
  }
});

// [Scenario: openspec-flow :: A description edit whose waiver matches a record passes]
test("a fork PR with a waiver is blocked without reading the record file; a missing isCrossRepository or an unreadable PR blocks", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    writeNotes(repo, "unreadable");
    const file = bodyFile(WAIVED);
    const fork = callEdit(`gh pr edit 23 ${OWN} --body-file ${file}`, repo, { view: prView({ isCrossRepository: true }) });
    const reason = blockedBy(fork.result, "DEV deploy-verify gate: ", "fork");
    assert.ok(reason.includes("the PR head branch is in another repository"), reason);
    assert.ok(!reason.includes("cannot be read"), "the record file is not read");
    assert.ok(reason.includes("replace the waiver with the actual status") && !reason.includes("ask the user"), reason);
    for (const [label, isCrossRepository] of [["missing", undefined], ["a string", "false"]]) {
      const out = callEdit(`gh pr edit 23 ${OWN} --body-file ${file}`, repo, { view: prView({ isCrossRepository }) });
      assert.ok(blockedBy(out.result, "Per-PR waiver edit gate: ", label).includes("isCrossRepository"), label);
    }
    for (const [label, view] of [["not JSON", "not-json"], ["null", "null"]]) {
      const out = callEdit(`gh pr edit 23 ${OWN} --body-file ${file}`, repo, { view });
      assert.ok(blockedBy(out.result, "Per-PR waiver edit gate: ", label).includes("PR #23 cannot be read to find its head branch"), label);
    }
    // The body field of the PR is not needed: the new description is the one compared.
    writeNotes(repo, null);
    rmSync(path.join(repo, "notes"), { recursive: true, force: true });
    writeNotes(repo, MATCHING_NOTES);
    assert.equal(callEdit(`gh pr edit 23 ${OWN} --body-file ${file}`, repo, { view: prView({ body: undefined }) }).result, null);
    // GitHub reports no head branch.
    const noHead = callEdit(`gh pr edit 23 ${OWN} --body-file ${file}`, repo, { view: prView({ headRefName: undefined }) });
    assert.ok(blockedBy(noHead.result, "DEV deploy-verify gate: ", "no head").includes("GitHub reported no head branch for this PR"));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: pre-tool-mechanical-gates :: gh pr edit with a body file is compared before the edit]
test("an unresolvable checkout of the gh pr edit clause is blocked", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const file = bodyFile(WAIVED);
    const { result } = callEdit(`cd "$SOMEWHERE" && gh pr edit 23 --body-file ${file}`, repo);
    const reason = blockedBy(result, "Per-PR waiver edit gate: ", "dynamic cd");
    assert.ok(reason.includes("checkout of this gh pr edit cannot be resolved before the shell runs"), reason);
    // #3560: name the forms the hook does not follow and the forms it does.
    assert.ok(reason.includes("does not follow a cd inside { … }, backticks, a nested or later ( … )"), reason);
    assert.ok(reason.includes("run gh pr edit <number> --repo github.com/OWNER/REPO --body-file <absolute-body-file> as its own command from the PR checkout's working directory"), reason);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a body-file edit runs from its checkout's working directory: a cd or a subshell before it is another step (PR #3703 r3 F3, F4)", () => {
  const repo = makeRepo({ kind: "direct" });
  const source = makeRepo({ kind: "source" });
  const elsewhere = makeTempDir("waiver-edit-elsewhere-");
  try {
    const file = bodyFile(WAIVED);
    // Run from the checkout itself, the edit reaches the record check; a source checkout is not compared.
    blockedBy(callEdit(`gh pr edit 23 ${OWN} --body-file ${file}`, repo).result, "DEV deploy-verify gate: ", "from the checkout");
    assert.equal(callEdit(`gh pr edit 23 ${SRC} --body-file ${file}`, source).result, null);
    // A cd, quoted, backslash-escaped or inside ( … ), is another step, even into a source checkout.
    for (const cmd of [`cd ${repo} && gh pr edit 23 ${OWN} --body-file ${file}`, `cd "${repo}" && gh pr edit 23 ${OWN} --body-file ${file}`, `(cd ${repo} && gh pr edit 23 ${OWN} --body-file ${file})`, `( cd "${repo}" && gh pr edit 23 ${OWN} --body-file ${file} )`, `(cd ${source} && gh pr edit 23 ${SRC} --body-file ${file})`, `(gh pr edit 23 ${OWN} --body-file ${file}) > edit.log`]) {
      const reason = blockedBy(callEdit(cmd, elsewhere).result, "Per-PR waiver edit gate: ", cmd);
      assert.match(reason, /another step (?:comes before|follows) gh pr edit; run gh pr edit as its own command from the checkout's working directory/, cmd);
    }
    for (const cmd of [
      `(cd "$SOMEWHERE" && gh pr edit 23 --body-file ${file})`,
      `(cd $(git rev-parse --show-toplevel) && gh pr edit 23 --body-file ${file})`,
      `(cd ${repo} || exit 1 && gh pr edit 23 --body-file ${file})`,
      `cd ${elsewhere} && (cd ${repo} && gh pr edit 23 --body-file ${file})`,
      `(cd ${elsewhere}) && (cd ${repo} && gh pr edit 23 --body-file ${file})`,
      `((cd ${repo}) && gh pr edit 23 --body-file ${file})`,
      `{ cd ${repo} && gh pr edit 23 --body-file ${file}; }`,
    ]) {
      const reason = blockedBy(callEdit(cmd, elsewhere).result, "Per-PR waiver edit gate: ", cmd);
      assert.ok(reason.includes("checkout of this gh pr edit cannot be resolved before the shell runs"), `${cmd}: ${reason}`);
    }
  } finally {
    for (const dir of [repo, source, elsewhere]) rmSync(dir, { recursive: true, force: true });
  }
});

test("an inherited GIT_DIR blocks a description edit before any record or identity is read (PR #3703 r3 F2)", () => {
  const repo = makeRepo({ kind: "direct" });
  const source = makeRepo({ kind: "source" });
  try {
    const file = bodyFile(WAIVED);
    for (const [cmd, cwd] of [[`gh pr edit 23 ${OWN} --body-file ${file}`, repo], [`gh pr edit 23 ${SRC} --body-file ${file}`, source]]) {
      const { result, trace } = callEdit(cmd, cwd, { env: { GIT_DIR: path.join(repo, ".git") } });
      assert.match(blockedBy(result, "Per-PR waiver edit gate: ", cmd), /the hook's environment sets GIT_DIR/, cmd);
      assert.deepEqual(trace, [], cmd);
    }
  } finally {
    for (const dir of [repo, source]) rmSync(dir, { recursive: true, force: true });
  }
});

test("several gh pr edit clauses are each inspected, and the first block wins", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const clean = bodyFile(bodyOf("N/A: docs only"));
    const waived = bodyFile(WAIVED);
    // Two body-file edits in one command: neither stands alone, so the first is blocked before any file is compared.
    const { result } = callEdit(`gh pr edit 22 --body-file ${clean} && gh pr edit 23 --body-file ${waived}`, repo);
    assert.match(blockedBy(result, "Per-PR waiver edit gate: ", "two clauses"), /another step follows gh pr edit/);
    // A clean first edit does not end the inspection: the later inline edit reaches its own waiver comparison
    // (PR #3703 r8 W6-F1).
    for (const [label, cmd] of [["title edit, then waiver", `gh pr edit 22 ${OWN} --title x && gh pr edit 23 ${OWN} --body '${WAIVED}'`], ["clean body, then waiver", `gh pr edit 22 ${OWN} --body '${bodyOf("N/A: docs only")}'; gh pr edit 23 ${OWN} --body '${WAIVED}'`]]) {
      const out = callEdit(cmd, repo);
      const reason = blockedBy(out.result, "DEV deploy-verify gate: ", label);
      assert.ok(reason.includes("Edit-time check of PR #23"), `${label}: ${reason}`);
      assert.deepEqual(out.trace.map((entry) => entry.pr), ["23"], `${label}: only the waiver edit's PR is read`);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: pre-tool-mechanical-gates :: A merge marker uses the bound checkout and raw checks keep it]
// PR #3703 r11 W12-F2: a --repo without a host beside a PR URL blocks an edit only when its new description carries a
// waiver; an ordinary description passes and nothing is compared.
test("a hostless --repo beside a PR URL blocks an edit only when the new description carries a waiver (PR #3703 r11 W12-F2)", () => {
  const repo = makeRepo({ kind: "direct" });
  try {
    const url = "https://github.com/owner/repo/pull/23";
    const plain = callEdit(`gh pr edit ${url} -R owner/repo --body-file ${bodyFile(bodyOf("N/A: docs only"))}`, repo);
    assert.equal(plain.result, null);
    assert.deepEqual(plain.trace, []);
    const waived = callEdit(`gh pr edit ${url} -R owner/repo --body-file ${bodyFile(WAIVED)}`, repo);
    assert.match(blockedBy(waived.result, "Per-PR waiver edit gate: ", "hostless --repo"), /the --repo of this edit has no host/);
    assert.deepEqual(waived.trace, []);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// [Scenario: openspec-flow :: Source repository and rigor off do not compare description edits]
// #3706 r1 F3: a source edit without a selector is compared at lite and full only; at off the gate does not run.
test("hook: a source edit without a selector is blocked at lite and full and passes at off (#3706 r1 F3)", () => {
  const source = makeRepo({ kind: "source" });
  try {
    const command = `gh pr edit ${SRC} --body-file ${bodyFile(WAIVED)}`;
    passedWholeHook(runHook(source, command, { level: "off" }), "rigor off");
    for (const level of ["lite", "full"]) {
      const out = runHook(source, command, { level });
      assert.equal(out.json?.decision, "block", `${level}: ${out.stdout}\n${out.stderr}`);
      assert.match(out.json.reason, /^Per-PR waiver edit gate: name the PR by number or URL when the new description carries a waiver/, level);
    }
  } finally { rmSync(source, { recursive: true, force: true }); }
});
