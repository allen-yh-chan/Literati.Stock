import "./lib/isolated-control-evidence-state.mjs";
import { after, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnWithReminderDetails } from "./lib/post-pr-reminder-fixtures.mjs";
import { existsSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "./lib/portable-command-shims.cjs";
import * as postPrState from "../hooks/lib/post-pr-completion-state.mjs";
import {
  defaultPostPrCompletionDir,
  writePostPrCompletionMarker,
} from "../hooks/lib/post-pr-completion-state.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

// Perf pattern (e) (test-performance-patterns.md): this file's 72 tests ran
// fully sequentially in one process (~26.89s isolated real time — the single
// largest file in the `integration` tier's critical path after the
// render-second-review-packet split, per the tier's effective-parallelism
// measurement). Only 2 "git init" mentions but 36 spawnSync/execSync calls
// across the file mean most of its cost is spawning the actual hook script
// under test (post-pr-completion-check.mjs / post-tool-gate.mjs) once per
// test case — inherent process-contract testing, not fixture setup, so a
// pattern (a) spawn-elimination rewrite does not apply here. node --test
// only parallelizes at file granularity, so shard registration across a
// sibling entry file (hook-post-pr-completion-runner-a.test.mjs, a thin
// `await import()` wrapper analogous to render-second-review-packet's and
// pre-pr-archive-gate's runner-a siblings) lets the 2 groups run as 2 OS
// processes concurrently instead of one serialized file. The core/runner_a
// boundary was chosen from measured per-test spec-reporter durations (not
// test count) so the ~28.0s of measured per-test work splits close to evenly
// between the two shards (~15.4s / ~12.7s single-process contributions).
// fix-post-pr-marker-non-ff-rebind T14 appends one exact PR #2927
// operator-closure/current-head-pending gate test; runner_a ends at 78.
// amend-chore-a-foreign-proposal-exemption (#3333) appends PRC-8F/PRC-8G at the end of
// the file (so no earlier test changes index); runner_a ends at 80.
// fix-merged-marker-waiver-clear (#3422) adds 14 waiver cases inside runner_a,
// so core keeps its indexes; runner_a ends at 94.

// These gate fixtures explicitly own their PRs. Existing gate assertions read
// the full scoped diagnostic; the isolation suite asserts the compact transport.
process.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = "post-pr-gate-fixture";
process.env.DEVPRO_HOOK_HOST = "test";
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_SESSION_ID;
delete process.env.CLAUDE_CONVERSATION_ID;
process.env.DEVPRO_AGENT_RULES_LEVEL = "full";
function spawnSync(...args) {
  const options = args[2];
  if (options?.env?.CODEX_THREAD_ID && options.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID === "post-pr-gate-fixture")
    options.env.DEVPRO_POST_PR_COMPLETION_SESSION_ID = options.env.CODEX_THREAD_ID;
  return spawnWithReminderDetails(...args);
}

const HOOK_POST_PR_COMPLETION_TEST_GROUP =
  process.env.DEVPRO_HOOK_POST_PR_COMPLETION_TEST_GROUP ?? "core";
const HOOK_POST_PR_COMPLETION_TEST_GROUP_RANGES = Object.freeze({
  core: [1, 28],
  runner_a: [29, 95],
});
const HOOK_POST_PR_COMPLETION_TEST_GROUP_RANGE_END = Math.max(
  ...Object.values(HOOK_POST_PR_COMPLETION_TEST_GROUP_RANGES).map(([, end]) => end),
);
let hookPostPrCompletionTestIndex = 0;

if (!Object.hasOwn(HOOK_POST_PR_COMPLETION_TEST_GROUP_RANGES, HOOK_POST_PR_COMPLETION_TEST_GROUP)) {
  throw new Error(
    `unknown hook-post-pr-completion test group: ${HOOK_POST_PR_COMPLETION_TEST_GROUP}`,
  );
}

function hookPostPrCompletionTestGroupForIndex(index) {
  for (const [group, [start, end]] of Object.entries(HOOK_POST_PR_COMPLETION_TEST_GROUP_RANGES)) {
    if (index >= start && index <= end) return group;
  }
  throw new Error(`hook-post-pr-completion test index ${index} has no group`);
}

function test(name, optionsOrFn, maybeFn) {
  hookPostPrCompletionTestIndex += 1;
  if (hookPostPrCompletionTestGroupForIndex(hookPostPrCompletionTestIndex) !== HOOK_POST_PR_COMPLETION_TEST_GROUP) return;
  if (typeof optionsOrFn === "function") {
    return nodeTest(name, optionsOrFn);
  }
  return nodeTest(name, optionsOrFn, maybeFn);
}

const POST_TOOL_HOOK = repoPath(".devpro/scripts/hooks/post-tool-gate.mjs");
const STOP_HOOK = repoPath(".devpro/scripts/hooks/post-pr-completion-check.mjs");
const CONTROL_EVIDENCE_HELPER = repoPath(".devpro/scripts/hooks/lib/second-review-control-evidence.mjs");
const tmpRoot = makeTempDir("post-pr-completion-test-");
// Isolated cwd keeps these evidence gate fixtures independent of local worktrees.
const noGitCwd = tmpRoot;

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let counter = 0;

function makeStateDir() {
  const dir = path.join(tmpRoot, `state-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadControlEvidenceHelper() {
  assert.equal(
    existsSync(CONTROL_EVIDENCE_HELPER),
    true,
    "post-PR fault lifecycle requires the durable control-evidence helper"
  );
  return import(`${pathToFileURL(CONTROL_EVIDENCE_HELPER).href}?gate-red=${Date.now()}`);
}

function withCanonicalDispatchBindings(record) {
  return {
    ...record,
    packet_sha256: "a".repeat(64),
    carrier_root_id: "b".repeat(64),
  };
}

async function completeDispatch(helper, rootDir, record, stickyVerdict = "PASS") {
  await helper.claimDispatchInvocation({ rootDir, record });
  return helper.writeCompletionReceipt({
    rootDir,
    record: {
      ...record,
      schema: helper.COMPLETION_SCHEMA,
      outcome: "reviewer_process_closed_and_sticky_verified",
      classification: "sticky_verified",
      sticky_verdict: stickyVerdict,
      sticky_last_reviewed_sha: record.head_ref_oid,
      sticky_dispatch_id: record.dispatch_id,
      sticky_comment_id: 4242,
      sticky_comment_url: `https://github.com/${record.repository_slug}/pull/${record.pr_number}#issuecomment-4242`,
      process_close_observed: true,
    },
  });
}

function writeMarkerInStateDir(stateDir, input) {
  const previous = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  try {
    return writePostPrCompletionMarker(input);
  } finally {
    if (previous === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previous;
  }
}

function runPostTool(payload, stateDir) {
  return spawnSync("node", [POST_TOOL_HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
    },
  });
}

function runStop(cwd, stateDir, extraEnv = {}) {
  return spawnSync("node", [STOP_HOOK], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      ...extraEnv,
    },
  });
}

function firstReminderTimestamp(marker, markerFile) {
  const dir = `${markerFile}.sessions`;
  if (!existsSync(dir)) return "";
  return readdirSync(dir).map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")).remindedAt).find(Boolean) || "";
}

function markerFiles(stateDir) {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir).filter((f) => f.startsWith("pending-post-pr-completion-") && f.endsWith(".json"));
}

function jsonRecordsInDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
}

function markerLockContender(markerFile, ownerToken) {
  return `${markerFile}.compare-and-swap.lock.${ownerToken}`;
}

function markerLockContenders(markerFile) {
  const prefix = `${path.basename(markerFile)}.compare-and-swap.lock.`;
  return readdirSync(path.dirname(markerFile))
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(path.dirname(markerFile), name));
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result.stdout.trim();
}

function makeGitRepo(name) {
  const repo = path.join(tmpRoot, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Devpro Test"]);
  writeFileSync(path.join(repo, "README.md"), "test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

test("PRC-0: default marker state dir is shared by linked worktrees", () => {
  const repo = makeGitRepo(`repo-${counter++}`);
  const worktree = path.join(tmpRoot, `linked-${counter++}`);
  git(repo, ["worktree", "add", "-b", "feature/linked", worktree]);

  assert.equal(
    defaultPostPrCompletionDir(repo),
    defaultPostPrCompletionDir(worktree),
    "main worktree and linked worktree should share post-PR marker state"
  );
});

test("PRC-1: successful gh pr create writes a post-PR completion marker", () => {
  const stateDir = makeStateDir();
  const result = runPostTool(
    {
      tool_name: "Bash",
      tool_input: {
        command: "gh pr create --base main --head feature/post-pr-completion-gate --title t",
        cwd: REPO_ROOT,
      },
      tool_response: {
        exit_code: 0,
        stdout: "https://github.com/devpro-tw/devpro-agent-rules/pull/123\n",
      },
    },
    stateDir
  );

  assert.equal(result.status, 0, `hook exits 0; stderr: ${result.stderr}`);
  const files = markerFiles(stateDir);
  assert.equal(files.length, 1, "one marker should be written");
  const marker = JSON.parse(readFileSync(path.join(stateDir, files[0]), "utf8"));
  assert.equal(marker.prNumber, "123");
  assert.equal(marker.url, "https://github.com/devpro-tw/devpro-agent-rules/pull/123");
});

test("PRC-1b: gh pr create without actual PR output does not create an obligation from --head", () => {
  const stateDir = makeStateDir();
  const repo = makeGitRepo(`repo-${counter++}`);
  assert.equal(git(repo, ["branch", "--show-current"]), "main");

  const result = runPostTool(
    {
      tool_name: "Bash",
      tool_input: {
        command: "gh pr create --base main --head feature/from-head --title t",
        cwd: repo,
      },
      tool_response: {
        exit_code: 0,
      },
    },
    stateDir
  );

  assert.equal(result.status, 0, `hook exits 0; stderr: ${result.stderr}`);
  const files = markerFiles(stateDir);
  assert.equal(files.length, 0, "empty create output cannot establish a PR obligation from --head alone");
});

test("PRC-2: failed gh pr create does not write a marker", () => {
  const stateDir = makeStateDir();
  const result = runPostTool(
    {
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base main --title t", cwd: REPO_ROOT },
      tool_response: { exit_code: 1, stderr: "failed" },
    },
    stateDir
  );

  assert.equal(result.status, 0, `hook exits 0; stderr: ${result.stderr}`);
  assert.deepEqual(markerFiles(stateDir), []);
});

test("PRC-3: Stop hook hard-blocks for stale pending marker without sticky", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "456",
    branch: "feature/post-pr-completion-gate",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/456",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  // Mock: no sticky exists for PR 456 → should hard-block
  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,  // non-git dir: currentBranch() returns "" → branch-mismatch early-return inactive
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",  // no mock sticky → simulates real "no sticky"
    },
  });

  assert.equal(result.status, 2, `stop hook should exit 2 (block); stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.decision, "block");
  assert.match(json.reason, /PR #456/);
  assert.match(json.reason, /\/devpro:cross-review/);
  assert.match(json.reason, /Post-PR completion gate/i);
  // Compact next-step contract (spec: Post-PR Blocked Response Next-Step Contract)
  // is emitted in the block reason. The full gate checklist (ledger / session-
  // close / handoff) lives in the leaf, which the message points at — the hook
  // no longer restates it verbatim.
  assert.match(json.reason, /Agent-facing next step \(not a user prompt\):/);
  assert.match(json.reason, /Status: blocked/);
  assert.match(json.reason, /Unblock condition:/);
  assert.match(json.reason, /post-pr-completion-gate\.md/);
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  assert.match(firstReminderTimestamp(marker, markerFile), /^\d{4}-\d{2}-\d{2}T/, "hard block should mark marker as reminded");
});

// Prove-it (issue #1200 FB-B): a marker whose PR has already MERGED must self-heal
// (clear + pass), not hard-block. Before the fix, snapshot lacked `state` and there
// was no merged→clear short-circuit, so a merged PR with a PATCHed/forced-head sticky
// could still hard-block until the 2h stale-expire.
test("PRC-MERGED-1: Stop hook clears marker (no block) when PR already MERGED", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "1203",
    branch: "chore/strengthen-rule-token-budget-coverage",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1203",
  });
  if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STATE: "1203:MERGED",
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",  // even with NO sticky, merged → clear
    },
  });

  assert.equal(result.status, 0, `merged PR must not hard-block; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "merged PR marker must be cleared");
});

// Prove-it (issue #1200 FB-B): the exact session scenario — create-output PR-number
// parsing failed so the marker is branch-only; the PR then MERGED. by-branch lookup
// must use --state all (not open) so the merged PR resolves and clears.
test("PRC-MERGED-2: branch-only marker for a MERGED PR self-heals via --state all lookup", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "",  // unknown PR number (create-output parse miss)
    branch: "chore/strengthen-rule-token-budget-coverage",
    url: "",
  });
  if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_BRANCH_PR: "chore/strengthen-rule-token-budget-coverage:1203",
      DEVPRO_POST_PR_GATE_MOCK_STATE: "1203:MERGED",
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    },
  });

  assert.equal(result.status, 0, `branch-only merged PR must not hard-block; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "branch-only merged PR marker must be cleared");
});

test("PRC-MERGED-3: merged PR self-heals even when changed-file fetch is unavailable", () => {
  const stateDir = makeStateDir();
  const branch = "chore/merged-files-unavailable";
  const repo = makeGitRepo(`repo-merged-files-unavailable-${counter++}`);
  git(repo, ["checkout", "-b", branch]);
  const mergedPr = {
    number: 1204,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1204",
    state: "MERGED",
    headRefName: branch,
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    comments: []
  };

  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: repo,
    prNumber: "1204",
    branch,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1204",
  });
  if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(repo, stateDir, {
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: JSON.stringify(mergedPr),
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES_ERROR: "files fetch unavailable",
    DEVPRO_POST_PR_GATE_MOCK_STATE: "1204:MERGED",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `1204:${branch}`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: "1204:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    DEVPRO_POST_PR_GATE_MOCK_FILES_UNAVAILABLE: "1204",
  });

  assert.equal(result.status, 0, `merged PR must clear without files; stdout: ${result.stdout}; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "merged PR marker must be cleared even when files fetch fails");
});

test("PRC-OPEN-FILES-1: open PR with unavailable changed files still blocks without sticky", () => {
  const stateDir = makeStateDir();
  const fakeBin = path.join(tmpRoot, `fake-gh-${counter++}`);
  mkdirSync(fakeBin, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  const jsonIdx = args.indexOf("--json");
  const fields = jsonIdx === -1 ? "" : String(args[jsonIdx + 1] || "");
  if (fields.split(",").includes("files")) {
    process.stderr.write("files fetch unavailable\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    number: 1205,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1205",
    state: "OPEN",
    headRefName: "chore/open-files-unavailable",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    comments: []
  }));
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`);
  chmodSync(fakeGh, 0o755);

  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "1205",
    branch: "chore/open-files-unavailable",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1205",
  });
  if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    },
  });

  assert.equal(result.status, 2, `open PR without sticky must still block; stdout: ${result.stdout}; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), true, "open PR marker must remain when files are unavailable and sticky is missing");
  assert.match(JSON.parse(result.stdout).reason, /PR #1205/);
});

test("PRC-OPEN-FILES-2: open PR with missing files array still blocks without sticky", () => {
  const stateDir = makeStateDir();
  const fakeBin = path.join(tmpRoot, `fake-gh-${counter++}`);
  mkdirSync(fakeBin, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  const jsonIdx = args.indexOf("--json");
  const fields = jsonIdx === -1 ? "" : String(args[jsonIdx + 1] || "");
  const base = {
    number: 1206,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1206",
    state: "OPEN",
    headRefName: "chore/open-files-missing",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    comments: []
  };
  process.stdout.write(JSON.stringify(base));
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`);
  chmodSync(fakeGh, 0o755);

  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "1206",
    branch: "chore/open-files-missing",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1206",
  });
  if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    },
  });

  assert.equal(result.status, 2, `missing files array must not imply exemption; stdout: ${result.stdout}; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), true, "marker must remain when files array is missing and sticky is absent");
  assert.match(JSON.parse(result.stdout).reason, /PR #1206/);
});

// fix-pr-changed-files-truncation — `gh pr view --json files` alone is capped
// by GitHub at 100 files. A chore/* PR with 433 real changed files whose
// `files` response is truncated to the first 100 (none a proposal.md) must
// NOT be treated as chore-A exempt: `changedFiles` (433) disagrees with the
// `files` length (100), so the snapshot builder must treat files as
// unavailable rather than clearing the marker on a false exemption.
test("Post-PR Stop hook keeps the marker on a truncated list", () => {
  const stateDir = makeStateDir();
  const fakeBin = path.join(tmpRoot, `fake-gh-${counter++}`);
  mkdirSync(fakeBin, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  const jsonIdx = args.indexOf("--json");
  const fields = jsonIdx === -1 ? "" : String(args[jsonIdx + 1] || "");
  const base = {
    number: 1207,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1207",
    state: "OPEN",
    headRefName: "chore/open-files-truncated",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    comments: []
  };
  if (fields.split(",").includes("files")) {
    const files = [];
    for (let i = 0; i < 100; i++) files.push({ path: ".devpro/scripts/f" + i + ".mjs" });
    process.stdout.write(JSON.stringify(Object.assign({}, base, { files: files, changedFiles: 433 })));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(base));
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`);
  chmodSync(fakeGh, 0o755);

  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "1207",
    branch: "chore/open-files-truncated",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1207",
  });
  if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    },
  });

  assert.equal(result.status, 2, `truncated files list must not imply chore-A exemption; stdout: ${result.stdout}; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), true, "marker must remain when files (100) disagrees with changedFiles (433)");
  assert.match(JSON.parse(result.stdout).reason, /PR #1207/);
});

// fix-pr-changed-files-truncation — a snapshot that carries `files` but no
// integer `changedFiles` at all (e.g. an older gh response shape, or a
// caller that forgot to request the field) must be treated the same as a
// disagreeing count: files unavailable, marker kept.
test("Post-PR Stop hook treats a missing total as unavailable", () => {
  const stateDir = makeStateDir();
  const fakeBin = path.join(tmpRoot, `fake-gh-${counter++}`);
  mkdirSync(fakeBin, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  const jsonIdx = args.indexOf("--json");
  const fields = jsonIdx === -1 ? "" : String(args[jsonIdx + 1] || "");
  const base = {
    number: 1208,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1208",
    state: "OPEN",
    headRefName: "chore/open-files-no-total",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    comments: []
  };
  if (fields.split(",").includes("files")) {
    const files = [
      { path: ".devpro/scripts/f0.mjs" },
      { path: ".devpro/scripts/f1.mjs" },
      { path: ".devpro/scripts/f2.mjs" }
    ];
    process.stdout.write(JSON.stringify(Object.assign({}, base, { files: files })));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(base));
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`);
  chmodSync(fakeGh, 0o755);

  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "1208",
    branch: "chore/open-files-no-total",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1208",
  });
  if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    },
  });

  assert.equal(result.status, 2, `missing changedFiles total must not imply exemption; stdout: ${result.stdout}; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), true, "marker must remain when changedFiles total is absent");
  assert.match(JSON.parse(result.stdout).reason, /PR #1208/);
});

// fix-pr-changed-files-truncation — the positive side: a complete list still
// earns the chore-A self-heal. The fake gh returns `changedFiles` only when the
// hook asks for it, so dropping the field from GH_PR_FULL_FIELDS turns every
// list unavailable and fails this test.
test("Post-PR Stop hook clears the marker on a complete chore-A list", () => {
  const stateDir = makeStateDir();
  const fakeBin = path.join(tmpRoot, `fake-gh-${counter++}`);
  mkdirSync(fakeBin, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  const jsonIdx = args.indexOf("--json");
  const fields = jsonIdx === -1 ? [] : String(args[jsonIdx + 1] || "").split(",");
  const data = {
    number: 1209,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1209",
    state: "OPEN",
    headRefName: "chore/open-files-complete",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    comments: []
  };
  if (fields.includes("files")) data.files = [{ path: "docs/a.md" }, { path: "docs/b.md" }];
  if (fields.includes("changedFiles")) data.changedFiles = 2;
  process.stdout.write(JSON.stringify(data));
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`);
  chmodSync(fakeGh, 0o755);

  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "1209",
    branch: "chore/open-files-complete",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1209",
  });
  if (prevStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    },
  });

  assert.equal(result.status, 0, `complete chore-A list must still self-heal; stdout: ${result.stdout}; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "marker must clear when files (2) equals changedFiles (2) and no proposal is present");
});

test("PRC-3b: external cross-model reviewer subprocess skips Stop hard-block without clearing marker", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "457",
    branch: "feature/reviewer-subprocess",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/457",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_CROSS_MODEL_REVIEWER: "1",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });

  assert.equal(result.status, 0, `reviewer subprocess stop hook should pass; stderr: ${result.stderr}`);
  assert.equal(result.stdout, "", "reviewer subprocess should not receive Post-PR completion hard-block text");
  assert.equal(markerFiles(stateDir).length, 1, "reviewer subprocess must not clear parent TL pending marker");
});

test("PRC-3c: repeated Stop hard-block downgrades to soft reminder to avoid loop", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "458",
    branch: "feature/repeated-stop",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/458",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }

  const first = runStop(noGitCwd, stateDir, {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });
  assert.equal(first.status, 2, `first stop should hard-block; stderr: ${first.stderr}`);

  const second = runStop(noGitCwd, stateDir, {
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });
  assert.equal(second.status, 0, `repeated stop should soft-remind; stderr: ${second.stderr}`);
  const json = JSON.parse(second.stdout);
  assert.match(json.systemMessage, /still pending/);
  assert.match(json.systemMessage, /Stop hook loop/);
  assert.match(json.systemMessage, /Agent-facing next step \(not a user prompt\):/);
  assert.match(json.systemMessage, /Status: blocked/);
  assert.match(json.systemMessage, /Owner: TL\/reviewer/);
  assert.doesNotMatch(json.systemMessage, /Disclosure: |Approval requirement:|Owner after approval:|ExternalDisclosureApproval/);
  assert.match(json.systemMessage, /Next action:/);
  assert.match(json.systemMessage, /\/devpro:cross-review <PR#>/);
  assert.match(json.systemMessage, /Unblock condition:/);
  assert.match(json.systemMessage, /last_reviewed_sha == headRefOid/);
  assert.equal(markerFiles(stateDir).length, 1, "soft reminder must not clear pending marker");
});

test("PRC-3d: hard-block dedup is per session when session id exists", () => {
  const stateDir = makeStateDir();
  const repo = makeGitRepo(`repo-${counter++}`);
  git(repo, ["checkout", "-b", "feature/cross-session-stop"]);
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  writePostPrCompletionMarker({
    cwd: repo,
    prNumber: "459",
    branch: "feature/cross-session-stop",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/459",
    sessionId: "session-a",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }

  const firstA = runStop(repo, stateDir, {
    DEVPRO_POST_PR_COMPLETION_SESSION_ID: "session-a",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });
  assert.equal(firstA.status, 2, `session A first stop should hard-block; stderr: ${firstA.stderr}`);

  const secondA = runStop(repo, stateDir, {
    DEVPRO_POST_PR_COMPLETION_SESSION_ID: "session-a",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });
  assert.equal(secondA.status, 0, `session A repeated stop should soft-remind; stderr: ${secondA.stderr}`);
  assert.match(JSON.parse(secondA.stdout).systemMessage, /Stop hook loop/);

  const firstB = runStop(repo, stateDir, {
    DEVPRO_POST_PR_COMPLETION_SESSION_ID: "session-b",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
  });
  assert.equal(firstB.status, 0, `foreign session B must be silent; stderr: ${firstB.stderr}`);
  assert.equal(firstB.stdout, "");
  assert.equal(markerFiles(stateDir).length, 1, "cross-session hard-block must not clear pending marker");
});

test("PRC-4: Stop hook self-heals (clears marker) when sticky already exists", () => {
  const stateDir = makeStateDir();
  const controlEvidenceDir = path.join(stateDir, "legacy-sticky-control-evidence");
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "789",
    branch: "feature/x",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/789",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: controlEvidenceDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "789",  // mock: PR 789 has sticky → self-heal
    },
  });

  assert.equal(result.status, 0, `stop hook should pass (sticky exists); stderr: ${result.stderr}`);
  // Marker should be cleared
  assert.deepEqual(markerFiles(stateDir), [], "marker should be cleared via self-heal");
  assert.equal(
    existsSync(controlEvidenceDir),
    false,
    "legacy sticky with no new-format dispatch record must not synthesize new dispatch evidence"
  );
});

test("PRC-4-AUTHORITY: Stop hook clears exactly one sticky authority and rejects two", () => {
  const headRefOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ghViewPreload = path.join(tmpRoot, "exact-sticky-gh-view-preload.mjs");
  writeFileSync(ghViewPreload, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (command === "gh" && args?.[0] === "pr" && args?.[1] === "view") {
    return { status: 0, stdout: process.env.DEVPRO_TEST_GH_VIEW_JSON, stderr: "" };
  }
  return realSpawnSync(command, args, options);
};
syncBuiltinESMExports();
`, "utf8");
  const preloadOption = `--import=${pathToFileURL(ghViewPreload).href}`;
  for (const authorityCount of [1, 2]) {
    const stateDir = makeStateDir();
    const prNumber = String(1800 + authorityCount);
    const branch = "feature/exact-one-sticky-authority";
    const repo = makeGitRepo(`repo-exact-one-sticky-authority-${counter++}`);
    git(repo, ["checkout", "-b", branch]);
    const body = [
      "<!-- cross-model-second-opinion:sticky -->",
      "## Cross-Model Review",
      "verdict: PASS",
      `last_reviewed_sha: ${headRefOid}`,
      "dispatch_id: legacy-authority",
      "reason: The bounded review completed for the requested scope.",
      "Rules: v6.83.10 · Tool: Claude Code · Model: claude-test",
    ].join("\n");
    const prSnapshot = {
      number: Number(prNumber),
      url: `https://github.com/devpro-tw/devpro-agent-rules/pull/${prNumber}`,
      state: "OPEN",
      headRefName: branch,
      headRefOid,
      comments: Array.from({ length: authorityCount }, (_, index) => ({
        body,
        url: `https://example.test/sticky/${index + 1}`,
      })),
    };
    const markerFile = writeMarkerInStateDir(stateDir, {
      cwd: repo,
      prNumber,
      branch,
      url: `https://github.com/devpro-tw/devpro-agent-rules/pull/${prNumber}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const result = runStop(repo, stateDir, {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preloadOption].filter(Boolean).join(" "),
      DEVPRO_TEST_GH_VIEW_JSON: JSON.stringify(prSnapshot),
      CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "openspec/changes/exact-one-sticky-authority/proposal.md",
    });

    assert.equal(
      result.status,
      authorityCount === 1 ? 0 : 2,
      `${authorityCount} sticky authorities produced an unexpected gate result; stdout: ${result.stdout}; stderr: ${result.stderr}`
    );
    assert.equal(
      existsSync(markerFile),
      authorityCount !== 1,
      "only exactly one sticky authority may clear the legacy marker"
    );
  }
});

test("PRC-4-AUTHORITY-BODY: one sticky comment with any duplicate authority carrier retains the marker", () => {
  const headRefOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const canonicalLines = [
    "<!-- cross-model-second-opinion:sticky -->",
    "verdict: PASS",
    `last_reviewed_sha: ${headRefOid}`,
    "dispatch_id: legacy-authority-body",
    "reason: The bounded review completed for the requested scope.",
    "Rules: v6.83.10 · Tool: Claude Code · Model: claude-test",
  ];

  for (const authority of [
    "marker",
    "verdict",
    "last_reviewed_sha",
    "dispatch_id",
    "reason",
    "rules",
    "tool",
    "model",
  ]) {
    const lines = [...canonicalLines];
    const footer = lines.at(-1);
    const mutations = {
      marker: () => lines.splice(1, 0, lines[0]),
      verdict: () => lines.splice(2, 0, "verdict: PASS"),
      last_reviewed_sha: () => lines.splice(3, 0, `last_reviewed_sha: ${headRefOid}`),
      dispatch_id: () => lines.splice(4, 0, "dispatch_id: legacy-authority-body"),
      reason: () => lines.splice(5, 0, "reason: The bounded review completed for the requested scope."),
      rules: () => lines.splice(lines.length - 1, 0, footer),
      tool: () => lines.splice(lines.length - 1, 0, "Tool: Claude Code"),
      model: () => lines.splice(lines.length - 1, 0, "Model: claude-test"),
    };
    mutations[authority]();

    const stateDir = makeStateDir();
    const prNumber = String(1810 + counter++);
    const fakeBin = path.join(tmpRoot, `fake-gh-sticky-body-authority-${counter++}`);
    mkdirSync(fakeBin, { recursive: true });
    const fakeGh = path.join(fakeBin, "gh");
    writeFileSync(fakeGh, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  number: ${JSON.stringify(prNumber)},
  url: "https://github.com/devpro-tw/devpro-agent-rules/pull/${prNumber}",
  state: "OPEN",
  headRefName: "feature/exact-one-sticky-body-authority",
  headRefOid: ${JSON.stringify(headRefOid)},
  comments: [{ body: ${JSON.stringify(lines.join("\n"))} }],
  files: [{ path: "openspec/changes/exact-one-sticky-body-authority/proposal.md" }],
}));
`);
    chmodSync(fakeGh, 0o755);
    const markerFile = writeMarkerInStateDir(stateDir, {
      cwd: REPO_ROOT,
      prNumber,
      branch: "feature/exact-one-sticky-body-authority",
      url: `https://github.com/devpro-tw/devpro-agent-rules/pull/${prNumber}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const result = runStop(noGitCwd, stateDir, {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    });
    assert.equal(
      result.status,
      2,
      `${authority} duplicate must retain the marker; stdout: ${result.stdout}; stderr: ${result.stderr}`
    );
    assert.equal(existsSync(markerFile), true, `${authority} duplicate must fail closed`);
  }
});

test("PRC-4-EXACT-ONE: Stop hook rejects duplicate verdict and SHA machine fields", () => {
  const headRefOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const cases = [
    {
      name: "identical verdicts",
      envName: "DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT",
      envValue: "PASS\nverdict: PASS",
    },
    {
      name: "conflicting verdicts",
      envName: "DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT",
      envValue: "PASS\nverdict: WARN",
    },
    {
      name: "identical last_reviewed_sha values",
      envName: "DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA",
      envValue: `${headRefOid}\nlast_reviewed_sha: ${headRefOid}`,
    },
    {
      name: "conflicting last_reviewed_sha values",
      envName: "DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA",
      envValue: `${headRefOid}\nlast_reviewed_sha: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    },
  ];

  for (const { name, envName, envValue } of cases) {
    const stateDir = makeStateDir();
    const prNumber = "1789";
    const markerFile = writeMarkerInStateDir(stateDir, {
      cwd: REPO_ROOT,
      prNumber,
      branch: "feature/exact-one-sticky-authority",
      url: `https://github.com/devpro-tw/devpro-agent-rules/pull/${prNumber}`,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const result = runStop(noGitCwd, stateDir, {
      DEVPRO_POST_PR_GATE_MOCK_STICKY: prNumber,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${prNumber}:${headRefOid}`,
      [envName]: `${prNumber}:${envValue}`,
    });

    assert.equal(
      result.status,
      2,
      `${name} must not be resolved by selecting the first machine field; stdout: ${result.stdout}; stderr: ${result.stderr}`
    );
    assert.equal(existsSync(markerFile), true, `${name} must retain the pending marker`);
  }
});

test("PRC-4c: Stop hook resolves branch-only marker and self-heals when sticky already exists", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "",
    branch: "feature/from-head",
    url: "",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_BRANCH_PR: "feature/from-head:901",
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "901",
    },
  });

  assert.equal(result.status, 0, `stop hook should pass (branch marker resolved to sticky PR); stderr: ${result.stderr}`);
  assert.deepEqual(markerFiles(stateDir), [], "branch-key marker should clear via self-heal");
});

test("PRC-4b: Stop hook keeps blocking when sticky verdict is UNAVAILABLE", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "790",
    branch: "feature/x",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/790",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "790",
      DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: "790:UNAVAILABLE",
    },
  });

  assert.equal(result.status, 2, `stop hook should block UNAVAILABLE sticky; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.decision, "block");
  // The block behavior (exit 2 + marker preserved) is the UNAVAILABLE contract;
  // the verdict-class wording lives in the leaf (CRITICAL/UNAVAILABLE → blocked),
  // not restated in the now-compact hook message.
  assert.equal(markerFiles(stateDir).length, 1, "UNAVAILABLE sticky must not clear marker");
});

test("PRC-5: sticky command observation alone does not clear existing marker; Stop hook verifies freshness", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "100",
    branch: "feature/x",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/100",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  assert.equal(markerFiles(stateDir).length, 1);

  // Simulate `gh pr comment 100 --body "<inline-body-with-marker>"` success
  const stickyBody = "## Cross-Model Review  <!-- cross-model-second-opinion:sticky -->  verdict: PASS";
  const result = runPostTool(
    {
      tool_name: "Bash",
      tool_input: {
        command: `gh pr comment 100 --body "${stickyBody}"`,
        cwd: REPO_ROOT,
      },
      tool_response: {
        exit_code: 0,
        stdout: "Comment posted: https://github.com/devpro-tw/devpro-agent-rules/pull/100#issuecomment-12345\n",
      },
    },
    stateDir
  );

  assert.equal(result.status, 0);
  assert.equal(markerFiles(stateDir).length, 1, "post-tool observation alone should not clear marker");

  const stop = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "100",
    },
  });

  assert.equal(stop.status, 0, `stop hook should self-heal after fresh sticky; stderr: ${stop.stderr}`);
  assert.deepEqual(markerFiles(stateDir), [], "marker should clear only after fresh sticky verification");
});

test("PRC-6: stale owner authority remains pending in read-only Stop inventory", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "999",
    branch: "feature/stale",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/999",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  // Set utime > 2h ago (STALE_AFTER_MS = 2h)
  const stale = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(markerFile, stale, stale);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    },
  });

  assert.equal(result.status, 2, "Stop must not expire unresolved session authority");
  assert.equal(existsSync(markerFile), true, "Stop inventory remains read-only");
});

test("PRC-7: Stop hook self-heals (clears marker) when PR is cross-model exempt (codex round-2 Critical fix)", () => {
  // Issue #768 / devpro:second-review round-2 Critical: hard-block was unconditionally
  // applied to ALL pending markers. Cross-model-exempt PRs (chore/bump-v*, rules/*,
  // release/*, chore-A diff-shape) should bypass the block via isCrossModelExempt
  // check, mirroring merge gate Path A semantics.
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "555",
    branch: "chore/bump-v6.0.0",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/555",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      // Mock headRefName as exempt branch pattern (chore/bump-v*)
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: "555:chore/bump-v6.0.0",
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",  // no sticky — exemption alone should clear
    },
  });

  assert.equal(result.status, 0, `stop hook should pass (exempt PR auto-cleared); stderr: ${result.stderr}`);
  assert.deepEqual(markerFiles(stateDir), [], "marker should be cleared via exemption self-heal");
});

test("PRC-8: Stop hook self-heals (clears marker) when PR is chore-A diff-shape exempt", () => {
  // Companion to PRC-7: chore-A diff-shape exemption (no proposal*.md in PR diff)
  // should also clear marker without requiring sticky.
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "666",
    branch: "chore/typo-fix",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/666",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      // No proposal*.md in diff → chore-A exempt
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: "666:chore/typo-fix",
      DEVPRO_POST_PR_GATE_MOCK_FILES: "666:README.md|.devpro/agent-rules/typo-fix.md",
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    },
  });

  assert.equal(result.status, 0, `stop hook should pass (chore-A exempt PR auto-cleared); stderr: ${result.stderr}`);
  assert.deepEqual(markerFiles(stateDir), [], "marker should be cleared via chore-A exemption self-heal");
});

test("PRC-9: Stop hook keeps blocking when sticky is missing last_reviewed_sha", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "777",
    branch: "feature/x",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/777",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "777",
      DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: "777:missing",
    },
  });

  assert.equal(result.status, 2, `stop hook should block invalid sticky; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /last_reviewed_sha/);
  assert.match(json.reason, /headRefOid/);
  assert.equal(markerFiles(stateDir).length, 1, "invalid sticky must not clear marker");
});

test("PRC-10: Stop hook keeps blocking when sticky last_reviewed_sha is stale", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "778",
    branch: "feature/x",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/778",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "778",
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: "778:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: "778:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  });

  assert.equal(result.status, 2, `stop hook should block stale sticky; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /last_reviewed_sha/);
  assert.match(json.reason, /headRefOid/);
  assert.equal(markerFiles(stateDir).length, 1, "stale sticky must not clear marker");
});

test("PRC-11: Stop hook clears release/rules marker before PR snapshot when branch-pattern exempt", () => {
  // Issue #798 prove-it: a release/rules-* marker already contains enough
  // branch metadata to determine cross-model exemption. It must not hard-block
  // only because gh pr view is unavailable during Stop hook cold-start.
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "880",
    branch: "release/rules-20260521-2",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/880",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "880",
    },
  });

  assert.equal(result.status, 0, `stop hook should pass (branch-pattern exempt marker); stderr: ${result.stderr}`);
  assert.deepEqual(markerFiles(stateDir), [], "marker should be cleared before PR snapshot fetch");
});

test("PRC-12: Stop hook keeps blocking non-exempt marker when PR snapshot is unavailable", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "881",
    branch: "feature/requires-cross-review",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/881",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "881",
    },
  });

  assert.equal(result.status, 2, `stop hook should still block non-exempt marker; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.match(json.reason, /PR #881/);
  assert.equal(markerFiles(stateDir).length, 1, "non-exempt marker must remain pending");
});

test("PRC-13: unrelated cross-session PR marker does not block read-only session", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "895",
    branch: "bugfix/fix-crossmodel-gate-commitmsg-falsepos",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/895",
    sessionId: "other-session",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  // NOTE: this Stop hook invocation is the ONLY one in this suite that runs with
  // cwd: repoRoot (the real project worktree) instead of an isolated temp repo.
  // Without an explicit override, the skipped-marker advisory notice sidecar
  // (D2) would resolve via git-common-dir to this ACTUAL repo's
  // notes/tmp/state/devpro-post-pr-skipped-advisory/ directory and pollute it.
  // Point it at an isolated tmp path instead.
  const advisoryStateDir = path.join(stateDir, "advisory-notices");
  const result = spawnSync("node", [STOP_HOOK], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: advisoryStateDir,
      CODEX_THREAD_ID: "current-read-only-session",
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "895",
    },
  });

  assert.equal(result.status, 0, `unrelated marker must not block; stderr: ${result.stderr}; stdout: ${result.stdout}`);
  // The marker is filtered as irrelevant (different branch), so it may now surface as a
  // skipped-marker advisory (D1) instead of the pre-fix silent empty stdout — but it must
  // never be a hard-block payload.
  assert.equal(result.stdout, "", "foreign or unbound markers remain silent");
  assert.equal(markerFiles(stateDir).length, 1, "unrelated marker remains for its owning session");
});

// PRC-14: prove-it tests for fix-post-pr-marker-crosssession-overblock (fix-A branch-mismatch early-return)
// Case (1): RED→GREEN — empty sessionId + headRefName differs from current branch → must NOT block after fix-A.
// Before fix-A, isMarkerRelevantToCurrentTurn returns true (fail-open on empty sessionId) and the hook
// hard-blocks even though the marker belongs to a different branch. After fix-A, branch mismatch is detected
// first and returns false (not relevant), so the hook exits 0 with no payload.
test("PRC-14a: empty-sessionId marker on different branch does not block current session (prove-it RED→GREEN)", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  // Marker from a different branch (simulates real-world overblock bug: PR#915 / #917)
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "915",
    branch: "bugfix/refactor-pre-tool-gate-core",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/915",
    sessionId: "",  // legacy / empty — the bug: fail-open before branch check
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  // Run from a repo whose current branch is NOT "bugfix/refactor-pre-tool-gate-core"
  // We use a fresh git repo on "main" so currentBranch(cwd) returns "main" — clearly different.
  const repo = makeGitRepo(`repo-prc14a-${counter++}`);
  // repo is on "main" branch; marker headRefName is "bugfix/refactor-pre-tool-gate-core"

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      CODEX_THREAD_ID: "current-session-abc",  // current session != empty markerSessionId
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "915",
    },
  });

  // After fix-A: branch mismatch → marker filtered out → exit 0. It may now surface as a
  // skipped-marker advisory (D1) instead of the pre-fix silent empty stdout, but the fix-A
  // guarantee under test here — no hard-block — must still hold.
  assert.equal(result.status, 0, `cross-branch empty-sessionId marker must not block; stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.stdout, "", "foreign or unbound markers remain silent");
  assert.equal(markerFiles(stateDir).length, 1, "marker remains (not cleared — only filtered as irrelevant)");
});

// Case (2): same-branch guard — empty sessionId + headRefName == current branch → still block.
// Uses makeGitRepo + checkout to a named feature branch so cwd branch == marker headRefName.
// Must NOT use cwd: repoRoot (worktree branch drifts to bugfix/fix-post-pr-marker-crosssession-overblock).
test("PRC-14b: empty-sessionId marker stays silent even on the same branch", () => {
  const stateDir = makeStateDir();
  const MARKER_BRANCH = "feature/same-branch-guard-test";

  // Build a repo and switch to the exact branch the marker records
  const repo = makeGitRepo(`repo-prc14b-${counter++}`);
  git(repo, ["checkout", "-b", MARKER_BRANCH]);

  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: repo,
    prNumber: "920",
    branch: MARKER_BRANCH,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/920",
    sessionId: "",  // legacy empty session
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: repo,  // cwd branch == MARKER_BRANCH → same branch → should still block
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      CODEX_THREAD_ID: "some-other-session",
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "920",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "legacy-unbound marker never adopts a matching branch");
  assert.equal(existsSync(markerFile), true);
});

// Case (3): same-session guard — markerSessionId == current CODEX_THREAD_ID → still block.
test("PRC-14c: same-session marker still blocks even if branches could differ", () => {
  const stateDir = makeStateDir();
  const SESSION_ID = "prc14c-session-xyz";
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "921",
    branch: "feature/some-other-feature",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/921",
    sessionId: SESSION_ID,
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  // Build a fresh repo on "main" — current branch differs from marker branch "feature/some-other-feature".
  // But session id MATCHES → fix-A branch-mismatch early-return fires first (branch && headRefName && branch !== headRefName)
  // → returns false → does NOT block. Wait — same-session case: if branch mismatch comes first, same-session
  // won't block cross-branch. This test validates the documented behavior from decision D1:
  // "same-session but branch can be proven different → not block" (new normative boundary per D4).
  // So case (3) must be: same-session + same branch (or branch info unavailable) → blocks.
  // We set cwd to a non-git dir so currentBranch returns "" → branch evidence absent → falls through to same-session check.
  const nonGitDir = path.join(tmpRoot, `non-git-prc14c-${counter++}`);
  mkdirSync(nonGitDir, { recursive: true });

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: nonGitDir,  // no git → currentBranch() returns "" → branch-mismatch early-return does NOT fire
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      CODEX_THREAD_ID: SESSION_ID,  // same session as marker
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "921",
    },
  });

  assert.equal(result.status, 2, `same-session marker must still block when branch evidence absent; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.decision, "block", "same-session marker must emit block decision");
});

// Case (4): dual-evidence-absent guard — empty sessionId + headRefName empty + cwd non-git → fail-open blocks.

// Case (5): D4 core — same-session but branch is provably different → does NOT block.
// Key difference from PRC-14c: PRC-14c uses a non-git cwd (branch absent → fail-open blocks);
// PRC-14e uses a real git repo with a named branch that is DIFFERENT from the marker headRefName.
// The branch-mismatch early-return (line 249) fires *before* the same-session check,
// so even though markerSessionId == current CODEX_THREAD_ID, the marker is filtered out.
test("PRC-14e: same-session marker remains pending on a different branch", () => {
  const stateDir = makeStateDir();
  const SESSION_ID = "prc14e-session-d4-core";
  const MARKER_BRANCH = "feature/marker-branch-prc14e";
  const CURRENT_BRANCH = "feature/current-branch-prc14e";

  // Build a real git repo and switch to CURRENT_BRANCH — this gives currentBranch(cwd) a non-empty value.
  const repo = makeGitRepo(`repo-prc14e-${counter++}`);
  git(repo, ["checkout", "-b", CURRENT_BRANCH]);

  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  // Marker records MARKER_BRANCH (≠ CURRENT_BRANCH) with same SESSION_ID as current session.
  const markerFile = writePostPrCompletionMarker({
    cwd: repo,
    prNumber: "923",
    branch: MARKER_BRANCH,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/923",
    sessionId: SESSION_ID,  // same session — D4: must NOT block when branch is provably different
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: repo,  // cwd branch == CURRENT_BRANCH ≠ MARKER_BRANCH → branch-mismatch early-return fires
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      CODEX_THREAD_ID: SESSION_ID,  // SAME session as marker — D4 boundary: still must not block
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "923",
    },
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, /PR #923/);
  assert.equal(markerFiles(stateDir).length, 1, "same session keeps its pending obligation across branches");
});

test("PRC-14d: empty-sessionId marker with no branch evidence stays unbound and silent", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  // Marker with no branch info and empty sessionId
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "922",
    branch: "",       // no branch → headRefName will also be empty (headRefName || branch || "")
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/922",
    sessionId: "",   // empty session
    headRefName: "", // explicitly empty
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  // cwd: non-git dir → currentBranch() returns "" → both branch evidences absent → fail-open → block
  const nonGitDir = path.join(tmpRoot, `non-git-prc14d-${counter++}`);
  mkdirSync(nonGitDir, { recursive: true });

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: nonGitDir,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      CODEX_THREAD_ID: "some-session",  // non-empty, but doesn't match marker (marker sessionId is "")
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "922",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "legacy-unbound marker never adopts a matching branch");
  assert.equal(existsSync(markerFile), true);
});

// PRC-15: prove-it for fix-post-pr-orphan-marker-relevance (empty-sessionId identity sanity).
// Quarantine fixture shape (notes/.../quarantined-pending-post-pr-completion-123.json.bak):
//   sessionId "", url github.com/OWNER/REPO, empty repository_slug / head_ref_oid / expected_dispatch_id.
// Before fix: empty-sessionId legacy-compat returns true → hard-block (exit 2).
// After fix: identity sanity rejects → not relevant → exit 0, no {decision:"block"}.

test("PRC-15a: quarantine-shaped empty-sessionId OWNER/REPO marker on same branch does not hard-block", () => {
  const stateDir = makeStateDir();
  const MARKER_BRANCH = "bugfix/fix-pre-pr-gate-mechanism-gaps";

  const repo = makeGitRepo(`repo-prc15a-${counter++}`);
  git(repo, ["checkout", "-b", MARKER_BRANCH]);

  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: repo,
    prNumber: "123",
    branch: MARKER_BRANCH,
    url: "https://github.com/OWNER/REPO/pull/123",
    sessionId: "",
    repositorySlug: "",
    headRefOid: "",
    expectedDispatchId: "",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      CODEX_THREAD_ID: "prc15a-session",
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "123",
    },
  });

  assert.equal(result.status, 0, `orphan OWNER/REPO same-branch marker must not hard-block; stderr: ${result.stderr}; stdout: ${result.stdout}`);
  assert.equal(result.stdout, "", "unbound orphan must remain silent");
  assert.equal(markerFiles(stateDir).length, 1, "relevance reject must leave the orphan marker on disk");
});

test("PRC-15b: quarantine-shaped empty-sessionId OWNER/REPO marker with branch evidence absent does not hard-block", () => {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber: "123",
    branch: "bugfix/fix-pre-pr-gate-mechanism-gaps",
    url: "https://github.com/OWNER/REPO/pull/123",
    sessionId: "",
    repositorySlug: "",
    headRefOid: "",
    expectedDispatchId: "",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const nonGitDir = path.join(tmpRoot, `non-git-prc15b-${counter++}`);
  mkdirSync(nonGitDir, { recursive: true });

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: nonGitDir,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      CODEX_THREAD_ID: "prc15b-session",
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "123",
    },
  });

  assert.equal(result.status, 0, `orphan OWNER/REPO branch-absent marker must not hard-block; stderr: ${result.stderr}; stdout: ${result.stdout}`);
  if (result.stdout) {
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision, undefined, "orphan branch-absent marker must not emit a hard-block decision");
  }
  assert.equal(markerFiles(stateDir).length, 1, "relevance reject must leave the orphan marker on disk");
});

test("PRC-15c: irrelevant quarantine-shaped orphan does not refresh marker mtime via remind", () => {
  const stateDir = makeStateDir();
  const MARKER_BRANCH = "bugfix/fix-pre-pr-gate-mechanism-gaps";

  const repo = makeGitRepo(`repo-prc15c-${counter++}`);
  git(repo, ["checkout", "-b", MARKER_BRANCH]);

  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: repo,
    prNumber: "123",
    branch: MARKER_BRANCH,
    url: "https://github.com/OWNER/REPO/pull/123",
    sessionId: "",
    repositorySlug: "",
    headRefOid: "",
    expectedDispatchId: "",
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const oldMs = Date.now() - 35_000;
  const old = new Date(oldMs);
  utimesSync(markerFile, old, old);
  const mtimeBefore = statSync(markerFile).mtimeMs;
  const bodyBefore = readFileSync(markerFile, "utf8");

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      CODEX_THREAD_ID: "prc15c-session",
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
      DEVPRO_POST_PR_GATE_MOCK_SNAPSHOT_UNAVAILABLE: "123",
    },
  });

  assert.equal(result.status, 0, `irrelevant orphan must not hard-block; stderr: ${result.stderr}; stdout: ${result.stdout}`);
  const mtimeAfter = statSync(markerFile).mtimeMs;
  assert.equal(mtimeAfter, mtimeBefore, "irrelevant orphan must not have mtime refreshed by markPostPrCompletionReminded");
  assert.equal(readFileSync(markerFile, "utf8"), bodyBefore, "irrelevant orphan marker bytes must be unchanged (no remind write)");
});

// ─────────────────────────────────────────────────────────────────────────
// PRC-GATE-FP-1 ~ PRC-GATE-FP-4: gate-validation command false-positive fix
//
// Bug: isGhPrCreateCommand(cmd) in post-tool-gate.mjs (L78) mistakenly treats
//   node .devpro/scripts/hooks/gh-footer-gate.mjs --strict-exit -- gh pr create ...
// as a real "gh pr create", causing a post-PR completion marker to be written
// with an empty prNumber. The Stop hook then hard-blocks with "PR #(empty)".
//
// Fix A (in isGhPrCreateCommand): exclude gate-validation shape:
//   if command contains "gh-footer-gate" or "--strict-exit" AND "gh pr create"
//   appears AFTER "--", return false.
// Fix B (in writePostPrCompletionMarker call site): if prNumber is empty AND
//   branch is empty (no --head flag) → skip writing marker.
// ─────────────────────────────────────────────────────────────────────────

// Case 1 (ROOT CAUSE): gate-validation command must NOT write a marker.
// command = "node .devpro/scripts/hooks/gh-footer-gate.mjs --strict-exit -- gh pr create ..."
// tool_response = gate's exit 0 output (no PR URL) → no marker should be written.
// RED before Fix A lands.
test("PRC-GATE-FP-1: gate-validation command (node gh-footer-gate.mjs --strict-exit -- gh pr create) does not write marker", () => {
  const stateDir = makeStateDir();
  const result = runPostTool(
    {
      tool_name: "Bash",
      tool_input: {
        command:
          "node .devpro/scripts/hooks/gh-footer-gate.mjs --strict-exit -- gh pr create --title \"feat: test\" --body-file /x/notes/tmp/remove-gh-body-pr-body-fp1.md",
        cwd: REPO_ROOT,
      },
      tool_response: {
        exit_code: 0,
        stdout: "footer gate: OK\n",
      },
    },
    stateDir
  );

  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
  assert.deepEqual(
    markerFiles(stateDir),
    [],
    "gate-validation command must NOT write a post-PR completion marker"
  );
});

// Case 2 (REGRESSION GUARD): real gh pr create with PR URL must still write marker.
// Ensures Fix A does not false-negative genuine PR creates.
// GREEN immediately (existing behavior is correct for this case).
test("PRC-GATE-FP-2: real gh pr create with PR URL still writes marker with correct prNumber", () => {
  const stateDir = makeStateDir();
  const result = runPostTool(
    {
      tool_name: "Bash",
      tool_input: {
        command:
          "gh pr create --base main --head feature/my-feature --title \"feat: real PR\" --body-file /x/notes/tmp/my-feature-pr-body-1324.md",
        cwd: REPO_ROOT,
      },
      tool_response: {
        exit_code: 0,
        stdout: "https://github.com/owner/repo/pull/1324\n",
      },
    },
    stateDir
  );

  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
  const files = markerFiles(stateDir);
  assert.equal(files.length, 1, "real gh pr create must write exactly one marker");
  const marker = JSON.parse(readFileSync(path.join(stateDir, files[0]), "utf8"));
  assert.equal(marker.prNumber, "1324", "marker must record prNumber=1324");
  assert.equal(
    marker.url,
    "https://github.com/owner/repo/pull/1324",
    "marker must record the PR URL"
  );
});

// fix-pre-verb-repo-flag-gates: gh accepts -R before `pr` and between `pr` and the verb; a create written that way
// is still a real create and records the same marker as the after-verb form.
test("PRC-REPO-FLAG-POSITION: gh pr create with -R before the verb writes the same marker as the after-verb form", () => {
  const markerFor = (command) => {
    const stateDir = makeStateDir();
    const result = runPostTool(
      {
        tool_name: "Bash",
        tool_input: { command, cwd: REPO_ROOT },
        tool_response: { exit_code: 0, stdout: "https://github.com/owner/repo/pull/1324\n" },
      },
      stateDir
    );
    assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
    const files = markerFiles(stateDir);
    assert.equal(files.length, 1, `${command}: exactly one marker`);
    const { prNumber, url, branch } = JSON.parse(readFileSync(path.join(stateDir, files[0]), "utf8"));
    return { prNumber, url, branch };
  };
  const args = "--base main --head feature/my-feature --title \"feat: real PR\" --body-file /x/notes/tmp/my-feature-pr-body-1324.md";
  const reference = markerFor(`gh pr create ${args} --repo owner/repo`);
  assert.equal(reference.prNumber, "1324");
  assert.equal(reference.branch, "feature/my-feature");
  for (const command of [`gh -R owner/repo pr create ${args}`, `gh pr -R owner/repo create ${args}`, `gh --repo=owner/repo pr create ${args}`]) {
    assert.deepEqual(markerFor(command), reference, command);
  }
});

// Case 3 (FIX B): real gh pr create but output has no PR URL and no --head branch
// (empty prNumber, no branch evidence) must NOT write marker.
// Without prNumber or branch, the marker has no useful identity for the Stop hook
// to track — writing it only causes spurious hard-blocks with "PR #(empty)".
// RED before Fix B lands.
test("PRC-GATE-FP-3: real gh pr create with no PR URL and no --head branch does not write marker", () => {
  const stateDir = makeStateDir();
  const result = runPostTool(
    {
      tool_name: "Bash",
      tool_input: {
        command: "gh pr create --base main --title \"feat: no-url-output\"",
        cwd: REPO_ROOT,
      },
      tool_response: {
        exit_code: 0,
        stdout: "Creating pull request for main into main in owner/repo\n",
      },
    },
    stateDir
  );

  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
  assert.deepEqual(
    markerFiles(stateDir),
    [],
    "gh pr create with no PR URL and no --head branch must NOT write a marker (Fix B: empty identity guard)"
  );
});

// Case 4 (FIX A VARIANT): --strict-exit gate without body-file is also excluded.
// Ensures Fix A is based on gate-validation shape, not body-file presence.
// RED before Fix A lands.
test("PRC-GATE-FP-4: gate-validation command without body-file (--strict-exit -- gh pr create --body inline) also excluded", () => {
  const stateDir = makeStateDir();
  const result = runPostTool(
    {
      tool_name: "Bash",
      tool_input: {
        command:
          "node .devpro/scripts/hooks/gh-footer-gate.mjs --strict-exit -- gh pr create --title \"chore: bump\" --body \"short body\"",
        cwd: REPO_ROOT,
      },
      tool_response: {
        exit_code: 0,
        stdout: "footer gate: OK\n",
      },
    },
    stateDir
  );

  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
  assert.deepEqual(
    markerFiles(stateDir),
    [],
    "gate-validation command (--strict-exit without body-file) must NOT write a marker"
  );
});

// PRC-GATE-FP-5: load-bearing `dashDashPos < ghPos` guard — a REAL gh pr create
// whose own arg list places `--` AFTER `gh pr create` AND happens to contain the
// `--strict-exit` token MUST still write a marker. This is the regression-fence
// for the gate-validation exclusion: if someone simplifies the guard to
// `dashDashPos !== -1` (dropping the `< ghPos` position check), this real create
// would be silently mis-classified as gate-validation and the marker dropped.
// (devpro:second-review Suggestion — pin the `--` must-come-before-gh condition.)
test("PRC-GATE-FP-5: real gh pr create with trailing -- and a --strict-exit token still writes marker", () => {
  const stateDir = makeStateDir();
  const result = runPostTool(
    {
      tool_name: "Bash",
      tool_input: {
        command:
          "gh pr create --base main --head feature/edge --title \"docs: note --strict-exit usage\" -- ",
        cwd: REPO_ROOT,
      },
      tool_response: {
        exit_code: 0,
        stdout: "https://github.com/owner/repo/pull/2025\n",
      },
    },
    stateDir
  );

  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
  const markers = markerFiles(stateDir);
  assert.equal(
    markers.length,
    1,
    "real gh pr create (-- after gh, --strict-exit token present) MUST write a marker"
  );
});

// PRC-GATE-FP-6: compound `gate-validation && real-create` — EVERY gh pr create
// occurrence must be evaluated, not just the first. The `--`-preceded dry-run
// occurrence (gate-validation) must NOT mask the later REAL create in the same
// compound command; the real create's PR URL drives a written marker.
// (cross-model finding: first-match-only false-negative.)
test("PRC-GATE-FP-6: compound gate-validation preflight && real gh pr create writes marker for the real one", () => {
  const stateDir = makeStateDir();
  const result = runPostTool(
    {
      tool_name: "Bash",
      tool_input: {
        command:
          "node .devpro/scripts/hooks/gh-footer-gate.mjs --strict-exit -- gh pr create --title \"t\" --body-file /x/notes/tmp/remove-gh-body-pr-body-fp6a.md && gh pr create --base main --head feature/real --title \"t\" --body-file /x/notes/tmp/remove-gh-body-pr-body-fp6b.md",
        cwd: REPO_ROOT,
      },
      tool_response: {
        exit_code: 0,
        stdout: "footer gate: OK\nhttps://github.com/owner/repo/pull/2026\n",
      },
    },
    stateDir
  );

  assert.equal(result.status, 0, `hook must exit 0; stderr: ${result.stderr}`);
  const markers = markerFiles(stateDir);
  assert.equal(
    markers.length,
    1,
    "compound (gate-validation && real create) MUST write a marker for the real create (first-match-only would miss it)"
  );
});

test("PRC-DISPATCH-1: marker persists the expected current dispatch binding", () => {
  const stateDir = makeStateDir();
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "chore/strengthen-control-plane-evidence",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1658",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-current",
  });
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));

  assert.equal(marker.expected_dispatch_id, "dispatch-1658-current");
  assert.equal(marker.head_ref_oid, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(marker.repository_slug, "devpro-tw/devpro-agent-rules");
});

test("PRC-DISPATCH-2: marker compare-and-swap rejects a stale competing expected dispatch", async () => {
  const stateDir = makeStateDir();
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "chore/strengthen-control-plane-evidence",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
  });
  assert.equal(
    typeof postPrState.compareAndSwapPostPrCompletionExpectedDispatch,
    "function",
    "state helper must expose a real compare-and-swap update, not a blind marker rewrite"
  );

  const first = await postPrState.compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile,
    repositorySlug: "devpro-tw/devpro-agent-rules",
    prNumber: "1658",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
    nextDispatchId: "dispatch-1658-second",
  });
  assert.equal(first.status, "updated");

  const stale = await postPrState.compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile,
    repositorySlug: "devpro-tw/devpro-agent-rules",
    prNumber: "1658",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
    nextDispatchId: "dispatch-1658-racing-writer",
  });
  assert.equal(stale.status, "conflict");
  assert.equal(stale.classification, "reviewer_dispatch_identity_collision");
  assert.equal(
    JSON.parse(readFileSync(markerFile, "utf8")).expected_dispatch_id,
    "dispatch-1658-second",
    "stale CAS must not overwrite the winning dispatch binding"
  );
});

test("PRC-DISPATCH-2b: marker compare-and-swap safely recovers a crash-leftover contender", async () => {
  const stateDir = makeStateDir();
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "chore/strengthen-control-plane-evidence",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
  });
  const lockFile = markerLockContender(markerFile, "crashed-owner");
  writeFileSync(lockFile, JSON.stringify({
    schema: "devpro-post-pr-marker-lock/v1",
    owner_pid: 99_999_999,
    owner_token: "crashed-owner",
    created_at: new Date(Date.now() - 60_000).toISOString(),
  }));
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lockFile, stale, stale);

  const recovered = await postPrState.compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile,
    repositorySlug: "devpro-tw/devpro-agent-rules",
    prNumber: "1658",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
    nextDispatchId: "dispatch-1658-after-crash",
  });

  assert.equal(recovered.status, "updated");
  assert.equal(existsSync(lockFile), false, "recovered CAS must remove the stale unique contender");
  assert.deepEqual(markerLockContenders(markerFile), [], "successful CAS must release its own contender");
  assert.equal(
    JSON.parse(readFileSync(markerFile, "utf8")).expected_dispatch_id,
    "dispatch-1658-after-crash"
  );
});

test("PRC-DISPATCH-2c: marker compare-and-swap never steals an old contender from a live owner", async () => {
  const stateDir = makeStateDir();
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "chore/strengthen-control-plane-evidence",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
  });
  const lockFile = markerLockContender(markerFile, "live-owner");
  writeFileSync(lockFile, JSON.stringify({
    schema: "devpro-post-pr-marker-lock/v1",
    owner_pid: process.pid,
    owner_token: "live-owner",
    created_at: new Date(Date.now() - 60_000).toISOString(),
  }));
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lockFile, stale, stale);

  const result = await postPrState.compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile,
    repositorySlug: "devpro-tw/devpro-agent-rules",
    prNumber: "1658",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
    nextDispatchId: "dispatch-1658-must-not-win",
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.classification, "reviewer_dispatch_identity_collision");
  assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).owner_token, "live-owner");
  assert.equal(
    JSON.parse(readFileSync(markerFile, "utf8")).expected_dispatch_id,
    "dispatch-1658-first"
  );
  rmSync(lockFile, { force: true });
});

test("PRC-DISPATCH-2d: marker compare-and-swap recovers an expired malformed crash-leftover contender", async () => {
  const stateDir = makeStateDir();
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "chore/strengthen-control-plane-evidence",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
  });
  const lockFile = markerLockContender(markerFile, "malformed-owner");
  writeFileSync(lockFile, "crash-before-lock-record-publication");
  const stale = new Date(Date.now() - 60_000);
  utimesSync(lockFile, stale, stale);

  const recovered = await postPrState.compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile,
    repositorySlug: "devpro-tw/devpro-agent-rules",
    prNumber: "1658",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
    nextDispatchId: "dispatch-1658-after-malformed-lock",
  });

  assert.equal(recovered.status, "updated");
  assert.equal(existsSync(lockFile), false);
  assert.equal(
    JSON.parse(readFileSync(markerFile, "utf8")).expected_dispatch_id,
    "dispatch-1658-after-malformed-lock"
  );
});

test("PRC-DISPATCH-2e: stale contender recovery cannot delete a fresh live contender", async () => {
  const stateDir = makeStateDir();
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "chore/strengthen-control-plane-evidence",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
  });
  const staleFile = markerLockContender(markerFile, "crashed-owner");
  const liveFile = markerLockContender(markerFile, "fresh-live-owner");
  writeFileSync(staleFile, JSON.stringify({
    schema: "devpro-post-pr-marker-lock/v1",
    owner_pid: 99_999_999,
    owner_token: "crashed-owner",
    created_at: new Date(Date.now() - 60_000).toISOString(),
  }));
  const stale = new Date(Date.now() - 60_000);
  utimesSync(staleFile, stale, stale);
  writeFileSync(liveFile, JSON.stringify({
    schema: "devpro-post-pr-marker-lock/v1",
    owner_pid: process.pid,
    owner_token: "fresh-live-owner",
    created_at: new Date().toISOString(),
  }));

  const result = await postPrState.compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile,
    repositorySlug: "devpro-tw/devpro-agent-rules",
    prNumber: "1658",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-first",
    nextDispatchId: "dispatch-1658-must-not-win",
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.classification, "reviewer_dispatch_identity_collision");
  assert.equal(existsSync(staleFile), false, "only the stale unique contender may be reclaimed");
  assert.equal(existsSync(liveFile), true, "fresh live contender must remain untouched");
  assert.equal(JSON.parse(readFileSync(liveFile, "utf8")).owner_token, "fresh-live-owner");
  assert.equal(
    JSON.parse(readFileSync(markerFile, "utf8")).expected_dispatch_id,
    "dispatch-1658-first"
  );
  rmSync(liveFile, { force: true });
});

test("PRC-DISPATCH-3: fresh sticky must match the marker's current dispatch", () => {
  const stateDir = makeStateDir();
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "feature/dispatch-binding",
    repositorySlug: "devpro-tw/devpro-agent-rules",
    headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedDispatchId: "dispatch-1658-current",
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "1658",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: "1658:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: "1658:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: "1658:dispatch-1658-stale",
  });

  assert.equal(result.status, 2, `stale-dispatch sticky must block; stdout: ${result.stdout}; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), true, "dispatch mismatch must not clear the marker");
});

test("PRC-DISPATCH-3-EXACT-ONE: duplicate dispatch machine fields retain the marker", async () => {
  const cases = [
    {
      name: "identical dispatch IDs",
      duplicateDispatchId: "dispatch-1659-exact-one",
    },
    {
      name: "conflicting dispatch IDs",
      duplicateDispatchId: "dispatch-1659-conflicting",
    },
    {
      name: "one valid and one malformed dispatch field",
      duplicateDispatchId: "invalid dispatch id with spaces",
    },
  ];

  for (const { name, duplicateDispatchId } of cases) {
    const stateDir = makeStateDir();
    const evidenceRoot = path.join(stateDir, "control-evidence");
    const helper = await loadControlEvidenceHelper();
    const record = withCanonicalDispatchBindings({
      schema: "devpro-second-review-dispatch/v1",
      repository_slug: "devpro-tw/devpro-agent-rules",
      pr_number: "1659",
      head_ref_oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      attempt_id: "second-review-pr-1659-exact-one",
      dispatch_id: "dispatch-1659-exact-one",
      previous_dispatch_id: null,
    });
    await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
    await completeDispatch(helper, evidenceRoot, record);

    const markerFile = writeMarkerInStateDir(stateDir, {
      cwd: REPO_ROOT,
      prNumber: record.pr_number,
      branch: "feature/dispatch-exact-one",
      repositorySlug: record.repository_slug,
      headRefOid: record.head_ref_oid,
      expectedDispatchId: record.dispatch_id,
    });
    const old = new Date(Date.now() - 35_000);
    utimesSync(markerFile, old, old);

    const result = runStop(noGitCwd, stateDir, {
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
      DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
      DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: [
        `${record.pr_number}:${record.dispatch_id}`,
        `dispatch_id: ${duplicateDispatchId}`,
      ].join("\n"),
    });

    assert.equal(
      result.status,
      2,
      `${name} must not be resolved by selecting one dispatch field; stdout: ${result.stdout}; stderr: ${result.stderr}`
    );
    assert.equal(existsSync(markerFile), true, `${name} must retain the dispatch-bound marker`);
  }
});

test("PRC-DISPATCH-3B: exact current-head PASS clears before a current fault or missing completion receipt can block", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1658",
    head_ref_oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    attempt_id: "second-review-pr-1658-terminal-receipt",
    dispatch_id: "dispatch-1658-terminal-receipt",
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  await helper.claimDispatchInvocation({ rootDir: evidenceRoot, record });
  await helper.writeFaultCapsule({
    rootDir: evidenceRoot,
    record: {
      ...record,
      schema: "devpro-second-review-fault-capsule/v1",
      classification: "reviewer_orchestration_permission_denied",
      evidence_provenance: "provider_typed_event",
      evidence_confidence: "high",
      matcher_id: "claude.permission-denials.typed.v1",
      denied_action_class: "reviewer_sticky_write",
      redacted_excerpt: "Write action denied after sticky publication",
    },
  });
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: record.pr_number,
    branch: "feature/dispatch-terminal-receipt",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);
  const env = {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${record.pr_number}:${record.dispatch_id}`,
  };

  const authoritativePass = runStop(noGitCwd, stateDir, env);
  assert.equal(authoritativePass.status, 0, `authoritative PASS must clear; stderr: ${authoritativePass.stderr}`);
  assert.equal(existsSync(markerFile), false, "authoritative PASS must CAS-clear the marker");
  assert.equal(
    existsSync(path.join(evidenceRoot, record.dispatch_id, "fault-capsule.json")),
    true,
    "a post-PASS local fault capsule remains diagnostic and must not be consumed"
  );
  assert.equal(
    existsSync(path.join(evidenceRoot, record.dispatch_id, "consumption-receipt.json")),
    false,
    "authoritative PASS must clear before fault consumption"
  );
  assert.equal(
    existsSync(path.join(evidenceRoot, record.dispatch_id, "completion-receipt.json")),
    false,
    "authoritative PASS must not depend on a completion receipt"
  );
});

test("PRC-DISPATCH-3C: WARN retains the completion-receipt path", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1658",
    head_ref_oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    attempt_id: "second-review-pr-1658-warn-terminal-receipt",
    dispatch_id: "dispatch-1658-warn-terminal-receipt",
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  await helper.claimDispatchInvocation({ rootDir: evidenceRoot, record });
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: record.pr_number,
    branch: "feature/dispatch-warn-terminal-receipt",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);
  const env = {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${record.pr_number}:${record.dispatch_id}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${record.pr_number}:WARN`,
  };

  const invocationOnly = runStop(noGitCwd, stateDir, env);
  assert.equal(invocationOnly.status, 2, "WARN plus invocation claim is not terminal evidence");
  assert.equal(existsSync(markerFile), true);

  await helper.writeCompletionReceipt({
    rootDir: evidenceRoot,
    record: {
      ...record,
      schema: helper.COMPLETION_SCHEMA,
      outcome: "reviewer_process_closed_and_sticky_verified",
      classification: "sticky_verified",
      sticky_verdict: "WARN",
      sticky_last_reviewed_sha: record.head_ref_oid,
      sticky_dispatch_id: record.dispatch_id,
      sticky_comment_id: 4242,
      sticky_comment_url: `https://github.com/${record.repository_slug}/pull/${record.pr_number}#issuecomment-4242`,
      process_close_observed: true,
    },
  });
  const terminal = runStop(noGitCwd, stateDir, env);
  assert.equal(terminal.status, 0, `terminal WARN completion must clear; stderr: ${terminal.stderr}`);
  assert.equal(existsSync(markerFile), false);
});

test("PRC-DISPATCH-4A: current orchestration fault is consumed even without a fresh sticky", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const dispatchId = "dispatch-1658-fault-without-sticky";
  const baseRecord = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1658",
    head_ref_oid: headRefOid,
    attempt_id: "second-review-pr-1658-aaaaaaaa-no-sticky",
    dispatch_id: dispatchId,
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: baseRecord });
  await helper.writeFaultCapsule({
    rootDir: evidenceRoot,
    record: {
      ...baseRecord,
      schema: "devpro-second-review-fault-capsule/v1",
      classification: "reviewer_orchestration_permission_denied",
      evidence_provenance: "provider_typed_event",
      evidence_confidence: "high",
      matcher_id: "anthropic.claude-agent-sdk.SDKPermissionDenial.v0.3.212",
      denied_action_class: "tool:Write",
      redacted_excerpt: "typed permission denial",
    },
  });
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "feature/dispatch-fault-no-sticky",
    repositorySlug: baseRecord.repository_slug,
    headRefOid,
    expectedDispatchId: dispatchId,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `1658:${headRefOid}`,
  });

  assert.equal(result.status, 2, `current fault without a sticky must block; stdout: ${result.stdout}`);
  assert.equal(existsSync(markerFile), true, "the gate must retain the marker after consuming the fault");
  const consumption = JSON.parse(readFileSync(
    path.join(evidenceRoot, dispatchId, "consumption-receipt.json"),
    "utf8"
  ));
  assert.equal(consumption.outcome, "blocked_orchestration_fault");
  assert.equal(consumption.dispatch_id, dispatchId);
  assert.equal(
    existsSync(path.join(evidenceRoot, dispatchId, "fault-capsule.json")),
    true,
    "session Stop preserves consumed capsule; global evidence pruning is outside its scope"
  );
});

test("PRC-DISPATCH-4B: gate consumes the marker-bound old-head fault before a verified new-head successor clears", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const oldHeadRefOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const newHeadRefOid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const faultDispatchId = "dispatch-1658-old-head-fault";
  const verifiedDispatchId = "dispatch-1658-new-head-verified";
  const faultRecord = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1658",
    head_ref_oid: oldHeadRefOid,
    attempt_id: "second-review-pr-1658-old-head-fault",
    dispatch_id: faultDispatchId,
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: faultRecord });
  await helper.claimDispatchInvocation({ rootDir: evidenceRoot, record: faultRecord });
  await helper.writeFaultCapsule({
    rootDir: evidenceRoot,
    record: {
      ...faultRecord,
      schema: "devpro-second-review-fault-capsule/v1",
      classification: "reviewer_orchestration_permission_denied",
      evidence_provenance: "provider_typed_event",
      evidence_confidence: "high",
      matcher_id: "anthropic.claude-agent-sdk.SDKPermissionDenial.v0.3.212",
      denied_action_class: "tool:Write",
      redacted_excerpt: "typed permission denial",
    },
  });
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "feature/dispatch-head-advance",
    repositorySlug: faultRecord.repository_slug,
    headRefOid: oldHeadRefOid,
    expectedDispatchId: faultDispatchId,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const consumedOldHead = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `1658:${newHeadRefOid}`,
  });
  assert.equal(
    consumedOldHead.status,
    2,
    `the old-head fault must be consumed and remain blocked after the PR advances; stdout: ${consumedOldHead.stdout}`
  );
  assert.equal(existsSync(markerFile), true, "consumption must retain the old-head marker");
  const consumptionPath = path.join(evidenceRoot, faultDispatchId, "consumption-receipt.json");
  const consumptionBytes = readFileSync(consumptionPath);
  assert.equal(JSON.parse(consumptionBytes).outcome, "blocked_orchestration_fault");

  const verifiedRecord = {
    ...faultRecord,
    head_ref_oid: newHeadRefOid,
    attempt_id: "second-review-pr-1658-new-head-verified",
    dispatch_id: verifiedDispatchId,
    previous_dispatch_id: faultDispatchId,
  };
  const priorMarkerRoot = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  let advanced;
  try { advanced = await postPrState.compareAndSwapPostPrCompletionHeadBinding({
    markerFile,
    repositorySlug: faultRecord.repository_slug,
    prNumber: faultRecord.pr_number,
    expectedHeadRefOid: oldHeadRefOid,
    expectedDispatchId: faultDispatchId,
    nextHeadRefOid: newHeadRefOid,
    nextDispatchId: verifiedDispatchId,
    beforeCommit: async (snapshot) => helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: verifiedRecord,
      predecessorMarker: { file: markerFile, snapshot, sha256: createHash("sha256").update(readFileSync(markerFile)).digest("hex") } }),
  }); } finally {
    if (priorMarkerRoot === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = priorMarkerRoot;
  }
  await completeDispatch(helper, evidenceRoot, verifiedRecord, "WARN");
  assert.equal(advanced.status, "updated");
  utimesSync(markerFile, old, old);

  const verified = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "1658",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `1658:${newHeadRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `1658:${newHeadRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `1658:${verifiedDispatchId}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: "1658:WARN",
  });
  assert.equal(verified.status, 0, `verified new-head successor must clear; stderr: ${verified.stderr}`);
  assert.equal(existsSync(markerFile), false);
  assert.deepEqual(
    readFileSync(consumptionPath),
    consumptionBytes,
    "new-head verification must preserve the gate-owned old-head consumption receipt"
  );
  const supersession = JSON.parse(readFileSync(
    path.join(evidenceRoot, faultDispatchId, "supersession-receipt.json"),
    "utf8"
  ));
  assert.equal(supersession.fault_dispatch_id, faultDispatchId);
  assert.equal(supersession.verified_dispatch_id, verifiedDispatchId);
  assert.equal(supersession.outcome, `superseded_by_verified_dispatch:${verifiedDispatchId}`);
});

test("PRC-DISPATCH-4: WARN with a current orchestration fault stays blocked and a verified WARN successor appends receipts before clear", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const currentDispatchId = "dispatch-1658-fault";
  const successorDispatchId = "dispatch-1658-successor";
  const baseRecord = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1658",
    head_ref_oid: headRefOid,
    attempt_id: "second-review-pr-1658-aaaaaaaa-initial",
    dispatch_id: currentDispatchId,
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: baseRecord });
  await helper.claimDispatchInvocation({ rootDir: evidenceRoot, record: baseRecord });
  await helper.writeFaultCapsule({
    rootDir: evidenceRoot,
    record: {
      ...baseRecord,
      schema: "devpro-second-review-fault-capsule/v1",
      classification: "reviewer_orchestration_permission_denied",
      evidence_provenance: "provider_typed_event",
      evidence_confidence: "high",
      matcher_id: "claude.permission-denials.typed.v1",
      denied_action_class: "reviewer_sticky_write",
      redacted_excerpt: "Write action denied",
    },
  });
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "feature/dispatch-fault",
    repositorySlug: baseRecord.repository_slug,
    headRefOid,
    expectedDispatchId: currentDispatchId,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const current = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "1658",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `1658:${headRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `1658:${headRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `1658:${currentDispatchId}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: "1658:WARN",
  });
  assert.equal(current.status, 2, `current fault dispatch must remain blocked; stdout: ${current.stdout}`);
  assert.equal(existsSync(markerFile), true);
  const consumptionPath = path.join(evidenceRoot, currentDispatchId, "consumption-receipt.json");
  assert.equal(existsSync(consumptionPath), true, "gate must durably consume the current fault before returning blocked");
  const consumptionBytes = readFileSync(consumptionPath);
  assert.equal(JSON.parse(consumptionBytes).outcome, "blocked_orchestration_fault");
  assert.equal(
    existsSync(path.join(evidenceRoot, currentDispatchId, "fault-capsule.json")),
    true,
    "session Stop preserves consumed capsule; global evidence pruning is outside its scope"
  );

  const successorRecord = {
    ...baseRecord,
    attempt_id: "second-review-pr-1658-aaaaaaaa-successor",
    dispatch_id: successorDispatchId,
    previous_dispatch_id: currentDispatchId,
  };
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: successorRecord });
  await completeDispatch(helper, evidenceRoot, successorRecord, "WARN");
  assert.equal(typeof postPrState.compareAndSwapPostPrCompletionExpectedDispatch, "function");
  const cas = await postPrState.compareAndSwapPostPrCompletionExpectedDispatch({
    markerFile,
    repositorySlug: baseRecord.repository_slug,
    prNumber: "1658",
    headRefOid,
    expectedDispatchId: currentDispatchId,
    nextDispatchId: successorDispatchId,
  });
  assert.equal(cas.status, "updated");

  const successor = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "1658",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `1658:${headRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `1658:${headRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `1658:${successorDispatchId}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: "1658:WARN",
  });
  assert.equal(successor.status, 0, `verified successor should clear only after receipt chain; stderr: ${successor.stderr}`);
  assert.equal(existsSync(markerFile), false);
  assert.deepEqual(readFileSync(consumptionPath), consumptionBytes, "successor must not rewrite blocked consumption");
  const supersession = JSON.parse(readFileSync(
    path.join(evidenceRoot, currentDispatchId, "supersession-receipt.json"),
    "utf8"
  ));
  assert.equal(supersession.schema, "devpro-second-review-fault-supersession/v1");
  assert.equal(supersession.fault_dispatch_id, currentDispatchId);
  assert.equal(supersession.verified_dispatch_id, successorDispatchId);
  assert.equal(supersession.outcome, `superseded_by_verified_dispatch:${successorDispatchId}`);

  const mature = new Date(Date.now() - 3 * 60 * 60_000);
  for (const dispatchId of [currentDispatchId, successorDispatchId]) {
    const directory = path.join(evidenceRoot, dispatchId);
    for (const file of readdirSync(directory)) {
      utimesSync(path.join(directory, file), mature, mature);
    }
  }
  const cleanup = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
  });
  assert.equal(cleanup.status, 0, `marker-free Stop hook must run owner cleanup; stderr: ${cleanup.stderr}`);
  assert.equal(
    existsSync(path.join(evidenceRoot, currentDispatchId)),
    true,
    "session Stop does not run global receipt-chain pruning"
  );
  assert.equal(
    existsSync(path.join(evidenceRoot, successorDispatchId)),
    true,
    "session Stop does not prune other dispatch evidence"
  );
});

test("PRC-DISPATCH-4C-PASS: relevant merged exact PASS clears without local dispatch evidence", () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "missing-control-evidence");
  const record = {
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1658",
    head_ref_oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dispatch_id: "dispatch-1658-merged-authoritative-pass",
  };
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: record.pr_number,
    branch: "feature/dispatch-merged-authoritative-pass",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${record.pr_number}:MERGED`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${record.pr_number}:${record.dispatch_id}`,
  });

  assert.equal(result.status, 0, `merged authoritative PASS must clear; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, "merged authoritative PASS must not wait for local receipts");
  assert.equal(existsSync(evidenceRoot), false, "PASS verification must not create or consume local evidence");
});

test("PRC-DISPATCH-4C: merged WARN dispatch-bound marker appends the complete fault receipt chain before clear", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const headRefOid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const faultDispatchId = "dispatch-1658-merged-fault";
  const verifiedDispatchId = "dispatch-1658-merged-successor";
  const faultRecord = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1658",
    head_ref_oid: headRefOid,
    attempt_id: "second-review-pr-1658-merged-chain",
    dispatch_id: faultDispatchId,
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: faultRecord });
  await helper.claimDispatchInvocation({ rootDir: evidenceRoot, record: faultRecord });
  await helper.writeFaultCapsule({
    rootDir: evidenceRoot,
    record: {
      ...faultRecord,
      schema: "devpro-second-review-fault-capsule/v1",
      classification: "reviewer_orchestration_permission_denied",
      evidence_provenance: "provider_typed_event",
      evidence_confidence: "high",
      matcher_id: "claude.permission-denials.typed.v1",
      denied_action_class: "reviewer_sticky_write",
      redacted_excerpt: "Write action denied",
    },
  });
  const verifiedRecord = {
    ...faultRecord,
    attempt_id: "second-review-pr-1658-merged-successor",
    dispatch_id: verifiedDispatchId,
    previous_dispatch_id: faultDispatchId,
  };
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: verifiedRecord });
  await completeDispatch(helper, evidenceRoot, verifiedRecord, "WARN");
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1658",
    branch: "feature/dispatch-merged-chain",
    repositorySlug: verifiedRecord.repository_slug,
    headRefOid,
    expectedDispatchId: verifiedDispatchId,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: "1658:MERGED",
    DEVPRO_POST_PR_GATE_MOCK_STICKY: "1658",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `1658:${headRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `1658:${headRefOid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `1658:${verifiedDispatchId}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: "1658:WARN",
  });

  assert.equal(result.status, 0, `verified merged successor should clear; stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false);
  const consumption = JSON.parse(readFileSync(
    path.join(evidenceRoot, faultDispatchId, "consumption-receipt.json"),
    "utf8"
  ));
  assert.equal(consumption.outcome, "blocked_orchestration_fault");
  const supersession = JSON.parse(readFileSync(
    path.join(evidenceRoot, faultDispatchId, "supersession-receipt.json"),
    "utf8"
  ));
  assert.equal(supersession.fault_dispatch_id, faultDispatchId);
  assert.equal(supersession.verified_dispatch_id, verifiedDispatchId);
});

test("PRC-DISPATCH-4D: merged state alone cannot clear a dispatch-bound marker without matching sticky evidence", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1658",
    head_ref_oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    attempt_id: "second-review-pr-1658-merged-without-sticky",
    dispatch_id: "dispatch-1658-merged-without-sticky",
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  await completeDispatch(helper, evidenceRoot, record);
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: record.pr_number,
    branch: "feature/dispatch-merged-without-sticky",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${record.pr_number}:MERGED`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
  });

  assert.equal(result.status, 2, "merge state must not waive matching sticky evidence");
  assert.equal(existsSync(markerFile), true, "dispatch-bound marker must remain fail closed");
});

// #3422: a MERGED marker leaves the loop before the open-PR Path W check, so a
// started dispatch needs the same waiver proof on the merged branch. Conditions
// stay those of Path W itself; these cases hold both directions.
function mergedWaiverComment(head, overrides = {}) {
  return {
    id: 9021,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1#issuecomment-9021",
    body: [
      "<!-- devpro-cross-model-waiver -->",
      `waived_head_sha: ${head}`,
      "granted_by: repository owner",
      "reason: Reviewer CLI failed; the owner merged without waiting for it.",
    ].join("\n"),
    author: { login: "repository-owner" },
    authorAssociation: "OWNER",
    ...overrides,
  };
}

function mergedStickyComment(id, verdict, head, dispatchId) {
  return {
    id,
    url: `https://github.com/devpro-tw/devpro-agent-rules/pull/1#issuecomment-${id}`,
    body: [
      "<!-- cross-model-second-opinion:sticky -->",
      "## Cross-Model Review",
      `verdict: ${verdict}`,
      `last_reviewed_sha: ${head}`,
      `dispatch_id: ${dispatchId}`,
      "reason: The reviewer CLI did not finish the requested scope.",
      "Rules: v7.6.0 · Tool: Claude Code · Model: claude-test",
    ].join("\n"),
    author: { login: "repository-owner" },
    authorAssociation: "OWNER",
  };
}

const MERGED_WAIVER_HEAD = "a".repeat(40);

function holdMarkerLock(markerFile) {
  writeFileSync(markerLockContender(markerFile, "live-owner"), JSON.stringify({
    schema: "devpro-post-pr-marker-lock/v1",
    owner_pid: process.pid,
    owner_token: "live-owner",
    created_at: new Date().toISOString(),
  }));
}

function writeOrchestrationFault({ helper, evidenceRoot, record }) {
  return helper.writeFaultCapsule({
    rootDir: evidenceRoot,
    record: {
      ...record,
      schema: "devpro-second-review-fault-capsule/v1",
      classification: "reviewer_orchestration_permission_denied",
      evidence_provenance: "provider_typed_event",
      evidence_confidence: "high",
      matcher_id: "anthropic.claude-agent-sdk.SDKPermissionDenial.v0.3.212",
      denied_action_class: "tool:Write",
      redacted_excerpt: "typed permission denial",
    },
  });
}

function refuseDispatchAuthority({ evidenceRoot, record }) {
  writeFileSync(path.join(evidenceRoot, record.dispatch_id, "operator-disposition.json"), "{}\n");
}

async function runStartedDispatch(prNumber, { comments, state = "MERGED", prepare = async () => {}, prepareMarker = () => {} }) {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: prNumber,
    head_ref_oid: MERGED_WAIVER_HEAD,
    attempt_id: `second-review-pr-${prNumber}-merged-waiver`,
    dispatch_id: `dispatch-${prNumber}-merged-waiver`,
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  await helper.claimDispatchInvocation({ rootDir: evidenceRoot, record });
  await prepare({ helper, evidenceRoot, record });
  const branch = "feature/merged-waiver";
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber,
    branch,
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  prepareMarker(markerFile);
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);
  const roundSidecar = path.join(stateDir, `review-round-${prNumber}.json`);
  writeFileSync(roundSidecar, JSON.stringify({
    schema_version: 1, pr_number: prNumber, repository_slug: record.repository_slug, round_count: 1, dispatch_lineage: [],
  }));
  const fakeBin = path.join(stateDir, "fake-gh");
  mkdirSync(fakeBin, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env node\nprocess.stdout.write(process.env.DEVPRO_TEST_PR_SNAPSHOT_JSON || "{}");\n`);
  chmodSync(fakeGh, 0o755);
  const result = runStop(noGitCwd, stateDir, {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_TEST_PR_SNAPSHOT_JSON: JSON.stringify({
      number: Number(prNumber),
      url: `https://github.com/devpro-tw/devpro-agent-rules/pull/${prNumber}`,
      state,
      headRefName: branch,
      headRefOid: record.head_ref_oid,
      comments: comments(record),
      files: [{ path: "src/app.mjs" }],
      changedFiles: 1,
    }),
  });
  return {
    status: result.status,
    markerExists: existsSync(markerFile),
    roundSidecarExists: existsSync(roundSidecar),
    consumptionExists: existsSync(path.join(evidenceRoot, record.dispatch_id, "consumption-receipt.json")),
    output: `stdout: ${result.stdout}; stderr: ${result.stderr}`,
  };
}

const MERGED_WAIVER_CLEARS = [
  ["no sticky", 34221, { comments: () => [mergedWaiverComment(MERGED_WAIVER_HEAD)] }],
  ["an UNAVAILABLE sticky", 34222, {
    comments: (record) => [
      mergedStickyComment(9022, "UNAVAILABLE", MERGED_WAIVER_HEAD, record.dispatch_id),
      mergedWaiverComment(MERGED_WAIVER_HEAD),
    ],
  }],
  ["an orchestration fault", 34223, {
    comments: () => [mergedWaiverComment(MERGED_WAIVER_HEAD)],
    prepare: writeOrchestrationFault,
  }],
];

for (const [label, prNumber, scenario] of MERGED_WAIVER_CLEARS) {
  test(`PRC-MERGED-WAIVER: valid waiver clears a merged started dispatch with ${label}`, async () => {
    const run = await runStartedDispatch(String(prNumber), scenario);
    assert.equal(run.status, 0, run.output);
    assert.equal(run.markerExists, false, "the waiver is the proof; no sticky or receipt chain is required");
    assert.equal(run.roundSidecarExists, false, "merged clears retire the review-round sidecar");
    assert.equal(run.consumptionExists, false, "Path W runs before fault consumption, as on an open PR");
  });
}

const MERGED_WAIVER_RETAINS = [
  ["no waiver", 34224, { comments: () => [] }],
  ["a waiver for another head", 34225, { comments: () => [mergedWaiverComment("b".repeat(40))] }],
  ["an unauthorized waiver author", 34226, {
    comments: () => [mergedWaiverComment(MERGED_WAIVER_HEAD, { authorAssociation: "CONTRIBUTOR" })],
  }],
  ["two waivers", 34227, {
    comments: () => [mergedWaiverComment(MERGED_WAIVER_HEAD), mergedWaiverComment(MERGED_WAIVER_HEAD, { id: 9023 })],
  }],
  ["a CRITICAL sticky", 34228, {
    comments: (record) => [
      mergedStickyComment(9022, "CRITICAL", MERGED_WAIVER_HEAD, record.dispatch_id),
      mergedWaiverComment(MERGED_WAIVER_HEAD),
    ],
  }],
  ["two stickies", 34229, {
    comments: (record) => [
      mergedStickyComment(9022, "UNAVAILABLE", MERGED_WAIVER_HEAD, record.dispatch_id),
      mergedStickyComment(9024, "UNAVAILABLE", MERGED_WAIVER_HEAD, record.dispatch_id),
      mergedWaiverComment(MERGED_WAIVER_HEAD),
    ],
  }],
  ["an unreadable operator disposition", 34230, {
    comments: () => [mergedWaiverComment(MERGED_WAIVER_HEAD)],
    prepare: refuseDispatchAuthority,
  }],
  ["a marker held by a live writer", 34231, {
    comments: () => [mergedWaiverComment(MERGED_WAIVER_HEAD)],
    prepareMarker: holdMarkerLock,
  }],
];

for (const [label, prNumber, scenario] of MERGED_WAIVER_RETAINS) {
  test(`PRC-MERGED-WAIVER: merged started dispatch stays pending with ${label}`, async () => {
    const run = await runStartedDispatch(String(prNumber), scenario);
    assert.equal(run.status, 2, run.output);
    assert.equal(run.markerExists, true, "without Path W proof a merged dispatch-bound marker stays fail closed");
    assert.equal(run.roundSidecarExists, true, "a retained marker keeps its review-round sidecar");
  });
}

test("PRC-OPEN-WAIVER: valid waiver clears an open started dispatch and keeps its review rounds", async () => {
  const run = await runStartedDispatch("34232", {
    state: "OPEN",
    comments: () => [mergedWaiverComment(MERGED_WAIVER_HEAD)],
  });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.markerExists, false, "Path W clears an open PR's marker without a sticky");
  assert.equal(run.roundSidecarExists, true, "only merged and closed clears retire the review-round sidecar");
});

for (const [label, prNumber, scenario] of [
  ["a refused dispatch authority fence", 34233, { prepare: refuseDispatchAuthority }],
  ["a marker held by a live writer", 34234, { prepareMarker: holdMarkerLock }],
]) {
  test(`PRC-OPEN-WAIVER: open started dispatch stays pending with ${label}`, async () => {
    const run = await runStartedDispatch(String(prNumber), {
      state: "OPEN",
      comments: () => [mergedWaiverComment(MERGED_WAIVER_HEAD)],
      ...scenario,
    });
    assert.equal(run.status, 2, run.output);
    assert.equal(run.markerExists, true, "a Path W clear that cannot complete leaves the marker pending");
  });
}

test("PRC-DISPATCH-4E: merged cross-branch exact PASS self-heals without local dispatch evidence", () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "missing-control-evidence");
  const repo = makeGitRepo(`repo-dispatch-merged-skipped-${counter++}`);
  const record = {
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1660",
    head_ref_oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    dispatch_id: "dispatch-1660-merged-skipped",
  };
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    prNumber: record.pr_number,
    branch: "feature/deleted-merged-branch",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(repo, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${record.pr_number}:MERGED`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${record.pr_number}:${record.dispatch_id}`,
    DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: path.join(stateDir, "skipped-advisory"),
  });

  assert.equal(result.status, 0, `merged skipped marker should self-heal; stderr: ${result.stderr}`);
  assert.match(JSON.parse(result.stdout).systemMessage, /Cost circuit breaker unavailable[\s\S]*PR #1660/);
  assert.doesNotMatch(result.stdout, /Post-PR completion gate hard-block/);
  assert.equal(existsSync(markerFile), false, "verified merged skipped marker must be cleared");
  assert.equal(existsSync(evidenceRoot), false, "skipped merged PASS must not create or consume local evidence");
});

test("PRC-DISPATCH-4E-NONMERGED: foreign non-merged exact PASS is silent and retains authority", () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "missing-control-evidence");
  const repo = makeGitRepo(`repo-dispatch-open-skipped-${counter++}`);
  const record = {
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1665",
    head_ref_oid: "abababababababababababababababababababab",
    dispatch_id: "dispatch-1665-open-skipped-pass",
  };
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    prNumber: record.pr_number,
    sessionId: "foreign-dispatch-session",
    branch: "feature/open-skipped-pass",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(repo, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${record.pr_number}:OPEN`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${record.pr_number}:${record.dispatch_id}`,
    DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: path.join(stateDir, "skipped-advisory"),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "foreign authority must not inject gate advice");
  assert.equal(existsSync(markerFile), true, "foreign marker stays intact regardless of live PR proof");

});

test("PRC-DISPATCH-4F: foreign merged dispatch authority without sticky stays silent", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const repo = makeGitRepo(`repo-dispatch-merged-skipped-no-sticky-${counter++}`);
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1661",
    head_ref_oid: "cccccccccccccccccccccccccccccccccccccccc",
    attempt_id: "second-review-pr-1661-merged-skipped-no-sticky",
    dispatch_id: "dispatch-1661-merged-skipped-no-sticky",
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  await completeDispatch(helper, evidenceRoot, record);
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    prNumber: record.pr_number,
    sessionId: "foreign-dispatch-session",
    branch: "feature/deleted-merged-no-sticky",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(repo, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${record.pr_number}:MERGED`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: path.join(stateDir, "skipped-advisory"),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "foreign authority must not inject gate advice");
  assert.equal(existsSync(markerFile), true, "foreign marker stays intact regardless of live PR proof");

});

test("PRC-DISPATCH-4G: repeated foreign Stop never creates cleanup probe state", () => {
  const stateDir = makeStateDir();
  const cleanupProbeDir = path.join(stateDir, "skipped-cleanup-probes");
  const advisoryDir = path.join(stateDir, "skipped-advisory");
  const longBranch = `feature/${"skipped-cleanup-throttle-".repeat(8)}branch`;
  const repo = makeGitRepo(`repo-skipped-cleanup-throttle-${counter++}`);
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    prNumber: "1662",
    branch: longBranch,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/1662",
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const env = {
    DEVPRO_POST_PR_SKIPPED_CLEANUP_PROBE_STATE_DIR: cleanupProbeDir,
    DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: advisoryDir,
    DEVPRO_POST_PR_COMPLETION_SESSION_ID: `session-${"x".repeat(180)}`,
    DEVPRO_POST_PR_GATE_MOCK_STATE: "1662:OPEN",
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `1662:${longBranch}`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: "1662:dddddddddddddddddddddddddddddddddddddddd",
    DEVPRO_POST_PR_GATE_MOCK_FILES: "1662:openspec/changes/skipped-cleanup-throttle/proposal.md",
  };
  const first = runStop(repo, stateDir, env);
  assert.equal(first.status, 0, `first skipped cleanup probe must stay advisory-only; stderr: ${first.stderr}`);
  assert.equal(existsSync(markerFile), true, "non-merged skipped marker must remain");
  assert.equal(first.stdout, "");
  const second = runStop(repo, stateDir, env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "");
  assert.equal(existsSync(cleanupProbeDir), false, "foreign state is never probed or touched");
});

test("PRC-DISPATCH-4H: foreign proof-missing authority is preserved without probes", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const cleanupProbeDir = path.join(stateDir, "skipped-cleanup-probes");
  const helper = await loadControlEvidenceHelper();
  const repo = makeGitRepo(`repo-dispatch-skipped-proof-missing-${counter++}`);
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1663",
    head_ref_oid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    attempt_id: "second-review-pr-1663-proof-missing",
    dispatch_id: "dispatch-1663-proof-missing",
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  await helper.claimDispatchInvocation({ rootDir: evidenceRoot, record });
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    prNumber: record.pr_number,
    sessionId: "foreign-dispatch-session",
    branch: "feature/skipped-proof-missing",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(repo, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${record.pr_number}:MERGED`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${record.pr_number}:${record.dispatch_id}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${record.pr_number}:WARN`,
    DEVPRO_POST_PR_SKIPPED_CLEANUP_PROBE_STATE_DIR: cleanupProbeDir,
    DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: path.join(stateDir, "skipped-advisory"),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "foreign authority must not inject gate advice");
  assert.equal(existsSync(markerFile), true, "foreign marker stays intact regardless of live PR proof");
  assert.equal(existsSync(cleanupProbeDir), false, "foreign cleanup must not probe or write state");

});

test("PRC-DISPATCH-4I: foreign corrupt evidence stays untouched without probes", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const cleanupProbeDir = path.join(stateDir, "skipped-cleanup-probes");
  const helper = await loadControlEvidenceHelper();
  const repo = makeGitRepo(`repo-dispatch-skipped-corrupt-evidence-${counter++}`);
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1664",
    head_ref_oid: "ffffffffffffffffffffffffffffffffffffffff",
    attempt_id: "second-review-pr-1664-corrupt-evidence",
    dispatch_id: "dispatch-1664-corrupt-evidence",
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  writeFileSync(path.join(evidenceRoot, record.dispatch_id, "dispatch.json"), "{not-json\n");
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    prNumber: record.pr_number,
    sessionId: "foreign-dispatch-session",
    branch: "feature/skipped-corrupt-evidence",
    repositorySlug: record.repository_slug,
    headRefOid: record.head_ref_oid,
    expectedDispatchId: record.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = runStop(repo, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${record.pr_number}:MERGED`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY: record.pr_number,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${record.pr_number}:${record.head_ref_oid}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${record.pr_number}:${record.dispatch_id}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${record.pr_number}:WARN`,
    DEVPRO_POST_PR_SKIPPED_CLEANUP_PROBE_STATE_DIR: cleanupProbeDir,
    DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: path.join(stateDir, "skipped-advisory"),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "foreign authority must not inject gate advice");
  assert.equal(existsSync(markerFile), true, "foreign marker stays intact regardless of live PR proof");
  assert.equal(existsSync(cleanupProbeDir), false, "foreign cleanup must not probe or write state");

});

test("PRC-EVIDENCE-CLEANUP-4: unbound unreadable authority and mature control evidence remain untouched", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const dispatchId = "dispatch-unreadable-marker-protected";
  const record = withCanonicalDispatchBindings({
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: "devpro-tw/devpro-agent-rules",
    pr_number: "1658",
    head_ref_oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    attempt_id: "second-review-pr-1658-unreadable-marker",
    dispatch_id: dispatchId,
    previous_dispatch_id: null,
  });
  await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record });
  await helper.claimDispatchInvocation({ rootDir: evidenceRoot, record });

  const evidenceDirectory = path.join(evidenceRoot, dispatchId);
  const mature = new Date(Date.now() - 3 * 60 * 60_000);
  for (const file of readdirSync(evidenceDirectory)) {
    utimesSync(path.join(evidenceDirectory, file), mature, mature);
  }
  const markerFile = path.join(stateDir, "pending-post-pr-completion-corrupt.json");
  writeFileSync(markerFile, "{truncated-marker");

  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
  });

  assert.equal(result.status, 0, `unreadable marker must hard-block; stdout: ${result.stdout}`);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(markerFile), true, "unreadable marker must never self-clear as absent");
  assert.equal(
    existsSync(evidenceDirectory),
    true,
    "unreadable marker must conservatively protect every mature control-evidence directory"
  );
});

test("PRC-DISPATCH-5: gate source gives exact PASS early CAS authority and orders WARN receipts", () => {
  const stateSource = readFileSync(
    repoPath(".devpro/scripts/hooks/lib/post-pr-completion-state.mjs"),
    "utf8"
  );
  const hookSource = readFileSync(STOP_HOOK, "utf8");

  assert.ok(stateSource.includes("expected_dispatch_id"), "marker state must persist the expected dispatch");
  assert.ok(
    stateSource.includes("compareAndSwapPostPrCompletionExpectedDispatch"),
    "marker state must expose the expected-dispatch CAS"
  );
  assert.ok(
    /exclusive|O_EXCL|\bwx\b|compare-and-swap/i.test(stateSource),
    "marker CAS must use an exclusive or equivalent compare-and-swap primitive"
  );
  assert.ok(/parseStickyDispatchId|dispatch_id/.test(hookSource), "gate must parse sticky dispatch identity");
  const verifyStart = hookSource.indexOf("async function verifyDispatchEvidenceAndAppendReceipts");
  const verifyEnd = hookSource.indexOf("function clearDispatchBoundMarker", verifyStart);
  const verifySource = hookSource.slice(verifyStart, verifyEnd);
  assert.ok(verifySource.includes("isAuthoritativeCurrentHeadPass"), "gate must identify exact current-head PASS authority");
  assert.ok(
    verifySource.indexOf("clearDispatchBoundMarker") < verifySource.indexOf("controlEvidenceRoot"),
    "exact current-head PASS must attempt marker CAS before local evidence is read"
  );
  assert.ok(
    hookSource.includes("reviewer_orchestration_permission_denied"),
    "gate must recognize confirmed orchestration denial"
  );
  assert.ok(
    hookSource.includes("reviewer_orchestration_unknown"),
    "gate must recognize unknown orchestration evidence"
  );
  const consumptionIndex = hookSource.indexOf("writeConsumptionReceipt");
  const supersessionIndex = hookSource.indexOf("writeSupersessionReceipt");
  const clearIndex = hookSource.indexOf("clearPostPrCompletionMarker", supersessionIndex);
  assert.ok(consumptionIndex >= 0, "gate must write or verify blocked consumption evidence");
  assert.ok(supersessionIndex > consumptionIndex, "gate must append supersession after consumption verification");
  assert.ok(clearIndex > supersessionIndex, "gate must clear only after the full supersession chain verifies");
});

// Historical skipped-marker layouts now verify session isolation.

test("PRC-ADVISORY-1: main checkout stays silent for a foreign linked-worktree marker", () => {
  const stateDir = makeStateDir();
  const repo = makeGitRepo(`repo-advisory-main-${counter++}`);
  const markerBranchName = "feature/advisory-marker-branch";
  // Placed under the repo root (mirrors this repo's own `.worktree/<change>`
  // convention) so the advisory can name it as a main-checkout-relative path.
  const worktreeRel = path.join(".worktree", `linked-advisory-${counter++}`);
  const worktreePath = path.join(repo, worktreeRel);
  git(repo, ["worktree", "add", "-b", markerBranchName, worktreePath]);

  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    sessionId: "foreign-advisory-session",
    prNumber: "9101",
    branch: markerBranchName,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/9101",
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: repo, // main checkout, branch "main" — differs from markerBranchName
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: path.join(stateDir, "skipped-advisory"),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "foreign markers do not emit skipped advice");
  assert.equal(existsSync(markerFile), true);
});

test("PRC-ADVISORY-2: repeated foreign Stop remains silent without notice sidecars", () => {
  const stateDir = makeStateDir();
  const advisoryDir = path.join(stateDir, "skipped-advisory");
  const repo = makeGitRepo(`repo-advisory-throttle-${counter++}`);
  const markerBranchName = "feature/advisory-throttle-branch";

  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    sessionId: "foreign-advisory-session",
    prNumber: "9102",
    branch: markerBranchName,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/9102",
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const env = {
    ...process.env,
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
    DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: advisoryDir,
  };

  const first = spawnSync("node", [STOP_HOOK], { cwd: repo, encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "", "foreign markers do not emit skipped advice");
  assert.equal(existsSync(markerFile), true);
  const repeat = spawnSync("node", [STOP_HOOK], { cwd: repo, encoding: "utf8", env });
  assert.equal(repeat.stdout, "");
  assert.equal(existsSync(advisoryDir), false, "silent foreign markers create no notice sidecars");
});

test("PRC-ADVISORY-2b: moving branches cannot adopt a foreign marker", () => {
  const stateDir = makeStateDir();
  const advisoryDir = path.join(stateDir, "skipped-advisory");
  const repo = makeGitRepo(`repo-advisory-location-${counter++}`);
  const markerBranchName = "feature/advisory-location-marker";

  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    sessionId: "foreign-advisory-session",
    prNumber: "9107",
    branch: markerBranchName,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/9107",
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const env = {
    ...process.env,
    DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
    DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: advisoryDir,
  };

  // Location 1: main checkout on "main".
  const first = spawnSync("node", [STOP_HOOK], { cwd: repo, encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "", "foreign markers do not emit skipped advice");
  assert.equal(existsSync(markerFile), true);
  git(repo, ["checkout", "-b", "feature/relocated"]);
  const moved = spawnSync("node", [STOP_HOOK], { cwd: repo, encoding: "utf8", env });
  assert.equal(moved.stdout, "", "moving branches cannot make a foreign session relevant");
});

test("PRC-ADVISORY-3: foreign Stop never touches an unwritable advisory directory", () => {
  const stateDir = makeStateDir();
  const repo = makeGitRepo(`repo-advisory-failopen-${counter++}`);
  const markerBranchName = "feature/advisory-failopen-branch";

  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    sessionId: "foreign-advisory-session",
    prNumber: "9103",
    branch: markerBranchName,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/9103",
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  // A regular file at the sidecar path blocks mkdirSync(..., {recursive:true})
  // with ENOTDIR, simulating an unwritable notice sidecar without touching the
  // marker state directory itself.
  const blockedAdvisoryPath = path.join(tmpRoot, `blocked-advisory-sidecar-${counter++}`);
  writeFileSync(blockedAdvisoryPath, "not-a-directory");

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: blockedAdvisoryPath,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "foreign markers do not emit skipped advice");
  assert.equal(existsSync(markerFile), true);
});

test("PRC-ADVISORY-4: same-branch pending marker still hard-blocks, untouched by advisory handling (guard case)", () => {
  const stateDir = makeStateDir();
  const repo = makeGitRepo(`repo-advisory-guard-${counter++}`);
  const markerBranchName = "feature/advisory-guard-branch";
  git(repo, ["checkout", "-b", markerBranchName]);

  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    prNumber: "9104",
    branch: markerBranchName,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/9104",
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: repo, // cwd branch === markerBranchName → relevant, NOT skipped
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    },
  });

  assert.equal(result.status, 2, `same-branch pending marker must still hard-block; stderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.decision, "block");
  assert.match(json.reason, /PR #9104/);
  assert.doesNotMatch(
    json.reason,
    /skipped markers \(not checked\)/,
    "hard-block for a non-skipped marker must not be rewritten into an advisory-only message"
  );
});

// PRC-ADVISORY-5 covers the third exit path, which neither the `all.length === 0`
// case (ADVISORY-1/2/3) nor the hard-block case (ADVISORY-4) reaches: relevant
// markers DO exist, but every one of them self-heals and clears, so
// stillPending is empty. Before this case the hook returned exit 0 with zero
// stdout there, reproducing issue #1741's silent skip one branch later.
test("PRC-ADVISORY-5: owner self-heal stays silent about remaining foreign markers", () => {
  const stateDir = makeStateDir();
  const repo = makeGitRepo(`repo-advisory-selfheal-${counter++}`);
  const skippedBranchName = "feature/advisory-selfheal-skipped";

  // Relevant marker: same branch as cwd ("main"), self-heals via mock sticky.
  const relevantMarker = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    prNumber: "9105",
    branch: "main",
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/9105",
  });
  // Skipped marker: different branch → filtered out by relevance.
  const skippedMarker = writeMarkerInStateDir(stateDir, {
    cwd: repo,
    prNumber: "9106",
    sessionId: "foreign-advisory-session",
    branch: skippedBranchName,
    url: "https://github.com/devpro-tw/devpro-agent-rules/pull/9106",
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(relevantMarker, old, old);
  utimesSync(skippedMarker, old, old);

  const result = spawnSync("node", [STOP_HOOK], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_SKIPPED_ADVISORY_STATE_DIR: path.join(stateDir, "skipped-advisory"),
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "9105", // PR 9105 has a sticky → self-heal → cleared
    },
  });

  assert.equal(result.status, 0, `self-heal path must exit 0; stderr: ${result.stderr}`);
  assert.match(JSON.parse(result.stdout).systemMessage, /Cost circuit breaker unavailable[\s\S]*PR #9105/);
  assert.doesNotMatch(result.stdout, /PR #9106|advisory-selfheal-skipped/, "cleared owner authority cannot expose another session's marker");
  assert.equal(markerFiles(stateDir).length, 1, "only the skipped marker remains; the relevant one cleared");
});

test("clear action writes a durable obligation without retaining an active marker binding", async () => {
  const stateDir = makeStateDir();
  const repositorySlug = "devpro/example";
  const prNumber = "1658";
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  const oldDispatchId = "dispatch-11111111-1111-4111-8111-111111111111";
  const firstDispatchId = "dispatch-22222222-2222-4222-8222-222222222222";
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber,
    branch: "bugfix/approved-clear",
    repositorySlug,
    headRefOid: oldHead,
    expectedDispatchId: oldDispatchId,
  });
  const receiptId = "9001";
  const changed = await postPrState.compareAndSwapPostPrCompletionHeadBinding({
    markerFile,
    repositorySlug,
    prNumber,
    expectedHeadRefOid: oldHead,
    expectedDispatchId: oldDispatchId,
    nextHeadRefOid: newHead,
    nextDispatchId: firstDispatchId,
    lineageApprovalReceiptId: receiptId,
    lineageApprovalAction: "clear",
    lineageClearObligation: {
      schema: "devpro-post-pr-clear-obligation/v1",
      repository_slug: repositorySlug,
      pr_number: prNumber,
      obligation_head_ref_oid: newHead,
      current_dispatch_id: firstDispatchId,
      old_dispatch_id: oldDispatchId,
      approval_receipt_id: receiptId,
      first_dispatch_id: firstDispatchId,
      created_at: "2026-09-28T00:20:00.000Z",
    },
  });
  assert.equal(changed.status, "updated");
  const onDisk = JSON.parse(readFileSync(markerFile, "utf8"));
  assert.equal(onDisk.expected_dispatch_id, undefined, "clear removes the active marker dispatch binding");
  assert.equal(onDisk.lineage_clear_obligation.approval_receipt_ids[0], receiptId);
  const previousStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const listed = postPrState.listPostPrCompletionMarkers(REPO_ROOT).find((item) => item.file === markerFile);
  assert.equal(listed.expected_dispatch_id, firstDispatchId, "gates consume the obligation's fresh dispatch identity");
  const conflictingMarkerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: "1659",
    branch: "bugfix/conflicting-clear-dispatch",
    repositorySlug,
    headRefOid: newHead,
    expectedDispatchId: oldDispatchId,
  });
  const conflictingMarker = JSON.parse(readFileSync(conflictingMarkerFile, "utf8"));
  conflictingMarker.lineage_clear_obligation = {
    ...onDisk.lineage_clear_obligation,
    pr_number: "1659",
  };
  writeFileSync(conflictingMarkerFile, JSON.stringify(conflictingMarker, null, 2));
  const conflictingListed = postPrState.listPostPrCompletionMarkers(REPO_ROOT)
    .find((item) => item.file === conflictingMarkerFile);
  assert.equal(conflictingListed.marker_unreadable, true,
    "a marker dispatch that conflicts with its clear obligation is invalid and fails closed");
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(markerFile, old, old);
  assert.equal(postPrState.listPostPrCompletionMarkers(REPO_ROOT).some((item) => item.file === markerFile), true,
    "clear obligations survive the ordinary two-hour marker expiry");
  if (previousStateDir === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = previousStateDir;
});

test("clear obligation stays blocked without exact current-head sticky and discharges on authoritative PASS", async () => {
  const stateDir = makeStateDir();
  const repositorySlug = "devpro/example";
  const prNumber = "1658";
  const head = "c".repeat(40);
  const oldHead = "d".repeat(40);
  const oldDispatchId = "dispatch-33333333-3333-4333-8333-333333333333";
  const currentDispatchId = "dispatch-44444444-4444-4444-8444-444444444444";
  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber,
    branch: "bugfix/approved-clear-gate",
    repositorySlug,
    headRefOid: oldHead,
    expectedDispatchId: oldDispatchId,
  });
  const receiptId = "9010";
  await postPrState.compareAndSwapPostPrCompletionHeadBinding({
    markerFile,
    repositorySlug,
    prNumber,
    expectedHeadRefOid: oldHead,
    expectedDispatchId: oldDispatchId,
    nextHeadRefOid: head,
    nextDispatchId: currentDispatchId,
    lineageApprovalReceiptId: receiptId,
    lineageApprovalAction: "clear",
    lineageClearObligation: {
      schema: "devpro-post-pr-clear-obligation/v1",
      repository_slug: repositorySlug,
      pr_number: prNumber,
      obligation_head_ref_oid: head,
      current_dispatch_id: currentDispatchId,
      old_dispatch_id: oldDispatchId,
      approval_receipt_id: receiptId,
      first_dispatch_id: currentDispatchId,
      created_at: "2026-09-28T00:20:00.000Z",
    },
  });
  const obligationBytes = readFileSync(markerFile, "utf8");
  const fakeBin = path.join(tmpRoot, `fake-gh-clear-obligation-${counter++}`);
  mkdirSync(fakeBin, { recursive: true });
  const fakeGh = path.join(fakeBin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env node\nprocess.stdout.write(process.env.DEVPRO_TEST_PR_SNAPSHOT_JSON || "{}");\n`);
  chmodSync(fakeGh, 0o755);
  const snapshot = (headRefName, comments = [], state = "OPEN") => ({
    number: Number(prNumber),
    url: `https://github.com/devpro-tw/devpro-agent-rules/pull/${prNumber}`,
    state,
    headRefName,
    headRefOid: head,
    comments,
    files: [{ path: "openspec/changes/lineage-clear-obligation/proposal.md" }],
    changedFiles: 1,
  });
  const runWithSnapshot = (data) => runStop(noGitCwd, stateDir, {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    DEVPRO_TEST_PR_SNAPSHOT_JSON: JSON.stringify(data),
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "isolated-control-evidence"),
  });
  const exemptResult = runWithSnapshot(snapshot("chore/bump-v6.0.0"));
  const obligationSurvivedExemption = existsSync(markerFile);

  writeFileSync(markerFile, obligationBytes);
  rmSync(`${markerFile}.sessions`, { recursive: true, force: true });
  const waiverBody = [
    "<!-- devpro-cross-model-waiver -->",
    `waived_head_sha: ${head}`,
    "granted_by: repository owner",
    "reason: User approved waiver for this exact head.",
  ].join("\n");
  const waiverComment = {
    id: 9011,
    url: `https://github.com/devpro-tw/devpro-agent-rules/pull/${prNumber}#issuecomment-9011`,
    body: waiverBody,
    author: { login: "repository-owner" },
    authorAssociation: "OWNER",
  };
  const waiverResult = runWithSnapshot(snapshot("feature/approved-clear-gate", [waiverComment]));
  const obligationSurvivedWaiver = existsSync(markerFile);

  writeFileSync(markerFile, obligationBytes);
  rmSync(`${markerFile}.sessions`, { recursive: true, force: true });
  const mergedResult = runWithSnapshot(snapshot("feature/approved-clear-gate", [], "MERGED"));
  const obligationSurvivedMerge = existsSync(markerFile);

  writeFileSync(markerFile, obligationBytes);
  rmSync(`${markerFile}.sessions`, { recursive: true, force: true });
  const mergedWaiverResult = runWithSnapshot(snapshot("feature/approved-clear-gate", [waiverComment], "MERGED"));
  const obligationSurvivedMergedWaiver = existsSync(markerFile);
  assert.deepEqual(
    [
      { status: exemptResult.status, markerExists: obligationSurvivedExemption },
      { status: waiverResult.status, markerExists: obligationSurvivedWaiver },
      { status: mergedResult.status, markerExists: obligationSurvivedMerge },
      { status: mergedWaiverResult.status, markerExists: obligationSurvivedMergedWaiver },
    ],
    [
      { status: 2, markerExists: true },
      { status: 2, markerExists: true },
      { status: 2, markerExists: true },
      { status: 2, markerExists: true },
    ],
    "only fresh review evidence discharges the obligation; exemption, Path W waiver, merged never-started cleanup, and a merged waiver retain it",
  );

  const env = {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(stateDir, "isolated-control-evidence"),
    DEVPRO_POST_PR_GATE_MOCK_STICKY: prNumber,
    DEVPRO_POST_PR_GATE_MOCK_STATE: `${prNumber}:OPEN`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `${prNumber}:feature/approved-clear-gate`,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${prNumber}:${head}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${prNumber}:${head}`,
    DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${prNumber}:${currentDispatchId}`,
  };
  writeFileSync(markerFile, obligationBytes);
  rmSync(`${markerFile}.sessions`, { recursive: true, force: true });
  const unknown = runStop(noGitCwd, stateDir, { ...env, DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${prNumber}:UNAVAILABLE` });
  assert.equal(unknown.status, 2, `UNAVAILABLE cannot discharge the obligation; stdout: ${unknown.stdout}; stderr: ${unknown.stderr}`);
  assert.equal(existsSync(markerFile), true, "an incomplete current-head outcome retains the obligation");
  const passed = runStop(noGitCwd, stateDir, { ...env, DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${prNumber}:PASS` });
  assert.equal(passed.status, 0, `exact current-head PASS discharges the obligation: ${passed.stderr}`);
  assert.equal(existsSync(markerFile), false, "only the ordinary exact-head PASS path removes the obligation");
});

// Scenario: Completed Operator Abandonment Closes Only Its Dispatch
test("PR #2927 operator closure permits a current-head successor but cannot clear its pending post-PR marker", async () => {
  const stateDir = makeStateDir();
  const evidenceRoot = path.join(stateDir, "control-evidence");
  const helper = await loadControlEvidenceHelper();
  const oldHead = "1ca5d65c55dcb15f5395c201d413ce4a164ef327";
  const currentHead = "2999fc4c246e70cf0ba7b7e73bee00a56305a4d4";
  const repository = "devpro-tw/devpro-agent-rules";
  const sourceRef = "bugfix/fix-post-pr-marker-non-ff-rebind";
  const prior = {
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: repository,
    pr_number: "2927",
    head_ref_oid: oldHead,
    attempt_id: "second-review-pr-2927-1ca5d65c55dc-initial-56293eef-eb39-4583-93bc-d20a75e8c846",
    dispatch_id: "dispatch-791fa840-4c9a-41f5-b376-93bfd20ad602",
    previous_dispatch_id: "dispatch-79f1b681-bca6-41c8-bd79-e129b1458be3",
    packet_sha256: "dad31c833d7e6a67e74707b2cd95f6f985b22f420fb1375dcdab590be0317ce2",
    carrier_root_id: "7c9f58f723990df388ca9932e1460633698f616dc5559ec47b425fe10ec6c244",
    paged_full_material_sha256: "4a684cd5f268f7124a7501b79cb3f36a5a34f78131838b3e45a71fa92274d8a3",
    paged_full_material_created_at: "2026-09-30T09:47:51.779Z",
    paged_full_material_expires_at: "2026-09-30T11:47:51.779Z",
  };
  const priorDirectory = path.join(evidenceRoot, prior.dispatch_id);
  mkdirSync(priorDirectory, { recursive: true });
  writeFileSync(path.join(priorDirectory, "dispatch.json"), `${JSON.stringify(prior)}\n`);
  const authorization = {
    operator_login: "allenchan",
    repository_permissions_push: true,
    permission_source: "gh-api-repository",
    target_repository: repository,
    pr_number: "2927",
    pr_state: "OPEN",
    pr_merged: false,
    base_repository: repository,
    head_repository: repository,
    head_ref: sourceRef,
    remote_pr_head: oldHead,
    local_repository: repository,
    local_branch: sourceRef,
    local_implementation_commit: "b".repeat(40),
    authorization_checked_at: "2026-10-01T00:00:00.000Z",
  };
  await helper.writeOperatorAbandonmentClosure({
    rootDir: evidenceRoot,
    dispatchId: prior.dispatch_id,
    authorization,
    confirmation: "ABANDON dispatch-791fa840-4c9a-41f5-b376-93bfd20ad602 head 1ca5d65c55dcb15f5395c201d413ce4a164ef327 runner_not_started",
  });

  const successor = {
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: repository,
    pr_number: "2927",
    head_ref_oid: currentHead,
    attempt_id: "second-review-pr-2927-current-head-after-operator-closure",
    dispatch_id: "dispatch-2927-current-head-after-operator-closure",
    previous_dispatch_id: prior.dispatch_id,
    packet_sha256: "c".repeat(64),
    carrier_root_id: "d".repeat(64),
  };
  const oldMarker = writeMarkerInStateDir(stateDir, { cwd: REPO_ROOT, prNumber: prior.pr_number,
    branch: sourceRef, repositorySlug: repository, headRefOid: oldHead, expectedDispatchId: prior.dispatch_id });
  const savedMarkerRoot = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  try {
    const advanced = await postPrState.compareAndSwapPostPrCompletionHeadBinding({ markerFile: oldMarker,
      repositorySlug: repository, prNumber: prior.pr_number, expectedHeadRefOid: oldHead,
      expectedDispatchId: prior.dispatch_id, nextHeadRefOid: currentHead, nextDispatchId: successor.dispatch_id,
      beforeCommit: async (snapshot) => helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: successor,
        predecessorMarker: { file: oldMarker, snapshot, sha256: createHash("sha256").update(readFileSync(oldMarker)).digest("hex") } }) });
    assert.equal(advanced.status, "updated");
  } finally {
    if (savedMarkerRoot === undefined) delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
    else process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = savedMarkerRoot;
  }
  const current = helper.readDispatchEvidenceStrict({ rootDir: evidenceRoot, dispatchId: successor.dispatch_id });
  assert.equal(current.dispatch.previous_dispatch_id, prior.dispatch_id);
  assert.equal(current.invocationClaim, null);
  assert.equal(current.completion, null);
  assert.equal(current.terminal, null);

  const markerFile = writeMarkerInStateDir(stateDir, {
    cwd: REPO_ROOT,
    prNumber: successor.pr_number,
    branch: sourceRef,
    url: `https://github.com/${repository}/pull/2927`,
    repositorySlug: repository,
    headRefOid: currentHead,
    expectedDispatchId: successor.dispatch_id,
  });
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);
  const result = runStop(noGitCwd, stateDir, {
    DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
    DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `2927:${currentHead}`,
  });

  assert.equal(result.status, 2, `the current-head dispatch must remain a merge-gate blocker; stdout: ${result.stdout}; stderr: ${result.stderr}`);
  assert.equal(markerFiles(stateDir).length, 1, "operator closure and successor reservation do not clear the current-head marker");
  assert.equal(JSON.parse(readFileSync(markerFile, "utf8")).expected_dispatch_id, successor.dispatch_id);
});

// PRC-8F / PRC-8G (#3333): the post-PR self-heal reads the same status-aware chore-A rule as the merge gate.
// A chore PR that only edits another change's proposal in place is still chore-A exempt (marker cleared);
// one that ADDS a proposal is not (marker kept, sticky required).
function runChoreAProposalStopHook({ prNumber, mockFiles }) {
  const stateDir = makeStateDir();
  const prevStateDir = process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = stateDir;
  const markerFile = writePostPrCompletionMarker({
    cwd: REPO_ROOT,
    prNumber,
    branch: "chore/fix-release-date",
    url: `https://github.com/devpro-tw/devpro-agent-rules/pull/${prNumber}`,
  });
  if (prevStateDir === undefined) {
    delete process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR;
  } else {
    process.env.DEVPRO_POST_PR_COMPLETION_STATE_DIR = prevStateDir;
  }
  const old = new Date(Date.now() - 35_000);
  utimesSync(markerFile, old, old);
  const result = spawnSync("node", [STOP_HOOK], {
    cwd: noGitCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_POST_PR_COMPLETION_STATE_DIR: stateDir,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_REF: `${prNumber}:chore/fix-release-date`,
      DEVPRO_POST_PR_GATE_MOCK_FILES: `${prNumber}:${mockFiles}`,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: "",
    },
  });
  return { result, stateDir };
}

test("PRC-8F: Stop hook self-heals when a chore PR only modifies ANOTHER change's proposal in place", () => {
  const { result, stateDir } = runChoreAProposalStopHook({
    prNumber: "6681",
    mockFiles: "modified\topenspec/changes/some-other-change/proposal.md|modified\tREADME.md",
  });
  assert.equal(result.status, 0, `in-place edit of a foreign proposal stays chore-A; stderr: ${result.stderr}`);
  assert.deepEqual(markerFiles(stateDir), [], "marker should be cleared via chore-A exemption self-heal");
});

test("PRC-8G: Stop hook keeps blocking when a chore PR ADDS a proposal (or its status is unknown)", () => {
  for (const [prNumber, mockFiles] of [
    ["6682", "added\topenspec/changes/some-other-change/proposal.md"],
    ["6683", "openspec/changes/some-other-change/proposal.md"],
    ["6684", "modified\topenspec/changes/fix-release-date/proposal.md"],
  ]) {
    const { result, stateDir } = runChoreAProposalStopHook({ prNumber, mockFiles });
    assert.equal(result.status, 2, `${mockFiles} must not be chore-A exempt; stderr: ${result.stderr}`);
    assert.equal(markerFiles(stateDir).length, 1, `${mockFiles}: marker must stay`);
  }
});

if (hookPostPrCompletionTestIndex !== HOOK_POST_PR_COMPLETION_TEST_GROUP_RANGE_END) {
  throw new Error(
    `hook-post-pr-completion grouped ${hookPostPrCompletionTestIndex} tests, expected ${HOOK_POST_PR_COMPLETION_TEST_GROUP_RANGE_END}`,
  );
}

if (HOOK_POST_PR_COMPLETION_TEST_GROUP === "core") nodeTest("lineage lifetime gate retains markers for missing, corrupt and retiring ancestors with safe diagnostics", async () => {
  const { createHash } = await import("node:crypto");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  for (const kind of ["complete", "missing", "corrupt", "current-missing", "current-corrupt", "binding-mismatch", "retiring", "bad-authority", "pass-retiring"]) {
    const stateDir = makeStateDir(), evidenceRoot = path.join(stateDir, "control-evidence");
    const helper = await loadControlEvidenceHelper();
    const prior = withCanonicalDispatchBindings({ schema: helper.DISPATCH_SCHEMA,
      repository_slug: "devpro-tw/devpro-agent-rules", pr_number: "1658", head_ref_oid: "a".repeat(40),
      attempt_id: `attempt-gate-${kind}-prior`, dispatch_id: `dispatch-gate-${kind}-prior`, previous_dispatch_id: null });
    const next = { ...prior, attempt_id: `attempt-gate-${kind}-next`, dispatch_id: `dispatch-gate-${kind}-next`, previous_dispatch_id: prior.dispatch_id };
    await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: prior });
    await completeDispatch(helper, evidenceRoot, prior);
    await helper.reserveDispatchRecord({ rootDir: evidenceRoot, record: next });
    await completeDispatch(helper, evidenceRoot, next, kind === "pass-retiring" ? "PASS" : "WARN");
    const markerPr = kind === "binding-mismatch" ? "1659" : next.pr_number;
    const markerFile = writeMarkerInStateDir(stateDir, { cwd: REPO_ROOT, prNumber: markerPr,
      branch: "feature/dispatch-lineage-lifetime", repositorySlug: next.repository_slug,
      headRefOid: next.head_ref_oid, expectedDispatchId: next.dispatch_id });
    const originals = new Map([prior.dispatch_id, next.dispatch_id].map((id) => [id,
      readdirSync(path.join(evidenceRoot, id)).map((name) => [name, readFileSync(path.join(evidenceRoot, id, name))])]));
    const old = new Date(Date.now() - 35_000); utimesSync(markerFile, old, old);
    if (kind === "missing") rmSync(path.join(evidenceRoot, prior.dispatch_id), { recursive: true });
    if (kind === "corrupt") writeFileSync(path.join(evidenceRoot, prior.dispatch_id, "dispatch.json"), "{");
    if (kind === "current-missing") rmSync(path.join(evidenceRoot, next.dispatch_id), { recursive: true });
    if (kind === "current-corrupt") writeFileSync(path.join(evidenceRoot, next.dispatch_id, "dispatch.json"), "{");
    if (["retiring", "pass-retiring"].includes(kind)) {
      const id = kind === "retiring" ? prior.dispatch_id : next.dispatch_id;
      const directory = path.join(evidenceRoot, id);
      const plan = { schema: "devpro-second-review-retirement/v1", plan_id: "12345678-1234-4123-8123-123456789abc",
        root_identity_sha256: hash(path.resolve(evidenceRoot)), created_at: new Date().toISOString(), members: [{ dispatch_id: id,
          reservation: JSON.parse(readFileSync(path.join(directory, "dispatch.json"), "utf8")),
          reservation_sha256: hash(readFileSync(path.join(directory, "dispatch.json"))),
          files: readdirSync(directory).sort().map((name) => {
            const bytes = readFileSync(path.join(directory, name)); return { name, size: bytes.length, sha256: hash(bytes) };
          }) }] };
      writeFileSync(path.join(evidenceRoot, ".cleanup-retirement.json"), `${JSON.stringify(plan)}\n`);
    }
    if (kind === "bad-authority") writeFileSync(path.join(evidenceRoot, ".cleanup-retirement.json"), "{");
    const result = runStop(noGitCwd, stateDir, {
      DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
      DEVPRO_POST_PR_GATE_MOCK_STICKY: markerPr,
      DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${markerPr}:${next.head_ref_oid}`,
      DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${markerPr}:${next.head_ref_oid}`,
      DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${markerPr}:${next.dispatch_id}`,
      DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${markerPr}:${kind === "pass-retiring" ? "PASS" : "WARN"}`,
    });
    if (kind === "complete") {
      assert.equal(result.status, 0, `${kind}: ${result.stdout} ${result.stderr}`);
      assert.equal(existsSync(markerFile), false);
    } else {
      assert.equal(result.status, 2, `${kind}: ${result.stdout} ${result.stderr}`);
      assert.equal(existsSync(markerFile), true, `${kind}: blocked evidence must not clear its marker`);
      const diagnostic = `${result.stdout}\n${result.stderr}`;
      if (["missing", "corrupt", "current-missing", "current-corrupt"].includes(kind)) {
        assert.ok(diagnostic.includes(next.dispatch_id));
        // The diagnostic can arrive JSON-encoded, where a Windows path has its backslashes doubled.
        const rootText = path.resolve(evidenceRoot);
        assert.ok(diagnostic.includes(rootText) || diagnostic.includes(JSON.stringify(rootText).slice(1, -1)));
        if (!kind.startsWith("current-")) assert.ok(diagnostic.includes(prior.dispatch_id));
        assert.match(diagnostic, /Restore the original immutable evidence.*rerun.*If unavailable.*keep the marker blocked.*TL/s);
        assert.doesNotMatch(diagnostic, /issue a fresh review/);
      }
      if (kind === "binding-mismatch") {
        assert.match(diagnostic, /binding|mismatch/i);
        assert.doesNotMatch(diagnostic, /[Rr]estore the original immutable evidence/);
      }
      if (kind === "retiring" || kind === "pass-retiring") assert.match(diagnostic, /dispatch_evidence_retiring.*cleanupOwnedControlEvidence\(\{ rootDir \}\)/s);
      if (kind === "bad-authority") assert.match(diagnostic, /retirement_recovery_required.*Keep the authority/s);
      assert.doesNotMatch(diagnostic, /(?:Next action|safe action):[^\n]*delete (?:the )?(?:manifest|authority)/i);
      if (["missing", "corrupt", "current-missing", "current-corrupt"].includes(kind)) {
        // Follow the diagnostic using the exact original bytes, never synthesize a closure.
        for (const [id, files] of originals) {
          mkdirSync(path.join(evidenceRoot, id), { recursive: true });
          for (const [name, bytes] of files) writeFileSync(path.join(evidenceRoot, id, name), bytes);
        }
        const restored = runStop(noGitCwd, stateDir, {
          DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: evidenceRoot,
          DEVPRO_POST_PR_GATE_MOCK_STICKY: markerPr,
          DEVPRO_POST_PR_GATE_MOCK_HEAD_SHA: `${markerPr}:${next.head_ref_oid}`,
          DEVPRO_POST_PR_GATE_MOCK_STICKY_SHA: `${markerPr}:${next.head_ref_oid}`,
          DEVPRO_POST_PR_GATE_MOCK_STICKY_DISPATCH: `${markerPr}:${next.dispatch_id}`,
          DEVPRO_POST_PR_GATE_MOCK_STICKY_VERDICT: `${markerPr}:WARN`,
        });
        assert.equal(restored.status, 0, `${kind} restored: ${restored.stdout} ${restored.stderr}`);
        assert.equal(existsSync(markerFile), false, `${kind}: exact restoration permits normal gate completion`);
      }

    }
  }
});
