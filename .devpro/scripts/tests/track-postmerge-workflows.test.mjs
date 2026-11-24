import "./lib/portable-command-shims.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTempDir } from "./lib/tmp.mjs";

const command = fileURLToPath(new URL("../track-postmerge-workflows.mjs", import.meta.url));
const repo = "github.com/owner/target";
const sha = "a".repeat(40);
const pr = {
  number: 5,
  state: "closed",
  merged: true,
  merge_commit_sha: sha,
  base: { ref: "main", repo: { full_name: "Owner/Target" } },
  html_url: "https://github.com/Owner/Target/pull/5",
};
const emptyPage = [{ total_count: 0, workflow_runs: [] }];
const selectedMarker = "github.com+owner+target#5.merge";
const workflowRun = {
  id: 123, name: "Build", event: "push", head_branch: "main", head_sha: sha,
  status: "in_progress", conclusion: null, repository: { full_name: "Owner/Target" },
  html_url: "https://github.com/Owner/Target/actions/runs/123",
};

function fixture(dir) {
  const gh = path.join(dir, "gh");
  const trace = path.join(dir, "trace.jsonl");
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const isPr = args.some(arg => arg.endsWith("/pulls/5"));
fs.appendFileSync(process.env.TRACE, JSON.stringify(args) + "\\n");
if (isPr && process.env.PR_ERROR === "1") {
  process.stderr.write("authentication failed");
  process.exit(1);
}
if (!isPr && process.env.RUN_ERROR === "1") {
  process.stderr.write("request timed out");
  process.exit(1);
}
if (!isPr && process.env.REPLACE_MARKER) {
  fs.writeFileSync(process.env.REPLACE_MARKER, process.env.REPLACEMENT);
}
process.stdout.write(isPr ? process.env.PR_REPLY : process.env.RUN_REPLY);
`, { mode: 0o755 });
  function seed(name, fields) {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(fields));
    return file;
  }
  const marker = seed(selectedMarker, { repo, kind: "merge", prNumber: "5", baseRefName: "main" });
  function run({ args = ["--repo", repo, "--pr", "5"], ...overrides } = {}) {
    return spawnSync(process.execPath, [command, ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 8000,
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        GH_HOST: "ghe.example.test",
        GH_REPO: "other/wrong",
        TRACE: trace,
        DEVPRO_POSTMERGE_STATE_DIR: dir,
        PR_REPLY: JSON.stringify(pr),
        RUN_REPLY: JSON.stringify(emptyPage),
        ...overrides,
      },
    });
  }
  return { marker, run, seed, trace };
}

test("verified empty response clears only the repo and PR selected before the query", () => withTempDir(dir => {
  const f = fixture(dir);
  const otherRepo = f.seed("same-number.merge", { repo: "github.com/owner/hub", kind: "merge", branch: "topic", prNumber: "5" });
  const otherPr = f.seed("other-pr.merge", { repo, kind: "merge", branch: "topic", prNumber: "6" });
  const fallback = f.seed("unknown.merge", { repo_unknown: true, kind: "merge", branch: "topic", prNumber: "5" });
  const branchOnly = f.seed("branch-only.merge", { repo, kind: "merge", branch: "topic" });
  const malformed = f.seed("wrong-kind.merge", { repo, kind: "push", branch: "topic", prNumber: "5" });
  const sameBranchPush = f.seed("same-branch.push", { repo, kind: "push", branch: "topic" });
  const recap = f.seed("recap-pending", { repo, prNumber: "5" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mergeSha, sha);
  assert.deepEqual(output.runs, []);
  assert.equal(output.cleared, 1);
  assert.ok(!existsSync(f.marker));
  for (const file of [otherRepo, otherPr, fallback, branchOnly, malformed, sameBranchPush, recap]) assert.ok(existsSync(file));
  const [prCall, runsCall] = readFileSync(f.trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(prCall, ["api", "--hostname", "github.com", "--method", "GET", "repos/owner/target/pulls/5"]);
  assert.ok(runsCall.includes("repos/owner/target/actions/runs"));
  assert.ok(runsCall.includes(`head_sha=${sha}`));
  assert.ok(runsCall.includes("--paginate"));
  assert.ok(runsCall.includes("--slurp"));
  const replay = f.run();
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).cleared, 0);
}));

test("query failure, incomplete data and mismatched identity keep the record", () => withTempDir(dir => {
  const f = fixture(dir);
  for (const overrides of [
    { PR_ERROR: "1" },
    { RUN_ERROR: "1" },
    { PR_REPLY: "not JSON" },
    { PR_REPLY: JSON.stringify({ ...pr, number: 8 }) },
    { PR_REPLY: JSON.stringify({ ...pr, merged: false }) },
    { PR_REPLY: JSON.stringify({ ...pr, merge_commit_sha: "invalid" }) },
    { PR_REPLY: JSON.stringify({ ...pr, merge_commit_sha: [sha] }) },
    { PR_REPLY: JSON.stringify({ ...pr, base: { ref: "stale", repo: { full_name: "owner/target" } } }) },
    { PR_REPLY: JSON.stringify({ ...pr, base: { ref: "main", repo: { full_name: ["owner/target"] } } }) },
    { PR_REPLY: JSON.stringify({ ...pr, html_url: [pr.html_url] }) },
    { PR_REPLY: JSON.stringify({ ...pr, html_url: "https://github.com/owner/hub/pull/5" }) },
    { RUN_REPLY: "not JSON" },
    { RUN_REPLY: "[]" },
    { RUN_REPLY: JSON.stringify([{ total_count: 1, workflow_runs: [] }]) },
    { RUN_REPLY: JSON.stringify([{ total_count: 1000, workflow_runs: [] }]) },
    { RUN_REPLY: JSON.stringify([{ total_count: 1, workflow_runs: [{ ...workflowRun, head_sha: "b".repeat(40) }] }]) },
    { RUN_REPLY: JSON.stringify([{ total_count: 1, workflow_runs: [{ ...workflowRun, repository: { full_name: "owner/hub" } }] }]) },
    { RUN_REPLY: JSON.stringify([{ total_count: 1, workflow_runs: [{ ...workflowRun, repository: { full_name: ["owner/target"] } }] }]) },
    { RUN_REPLY: JSON.stringify([{ total_count: 2, workflow_runs: [workflowRun, workflowRun] }]) },
    ...[
      { name: undefined }, { event: undefined }, { head_branch: undefined },
      { status: "invalid" }, { status: "completed" }, { html_url: "https://example.test/run" },
    ].map(fields => ({ RUN_REPLY: JSON.stringify([{ total_count: 1, workflow_runs: [{ ...workflowRun, ...fields }] }]) })),
  ]) {
    const result = f.run(overrides);
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.ok(existsSync(f.marker), JSON.stringify(overrides));
  }
}));

test("complete paginated runs are returned even while CI is running or failed", () => withTempDir(dir => {
  const f = fixture(dir);
  const failedRun = {
    ...workflowRun, id: 124, status: "completed", conclusion: "failure",
    html_url: "https://github.com/Owner/Target/actions/runs/124",
  };
  const pages = [
    { total_count: 2, workflow_runs: [workflowRun] },
    { total_count: 2, workflow_runs: [failedRun] },
  ];
  const result = f.run({ RUN_REPLY: JSON.stringify(pages) });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.runs.map(({ id, status, conclusion }) => [id, status, conclusion]), [
    [123, "in_progress", null], [124, "completed", "failure"],
  ]);
  assert.equal(output.cleared, 1);
  assert.ok(!existsSync(f.marker));
}));

test("a scoped legacy branch query retires only matching push markers after success", () => withTempDir(dir => {
  const f = fixture(dir);
  const selected = f.seed("legacy.push", { repo, kind: "push", branch: "feature/topic" });
  const nearMatch = f.seed("near-match.push", { repo, kind: "push", branch: "feature_topic" });
  const sibling = f.seed("other.push", { repo: "github.com/owner/hub", kind: "push", branch: "feature/topic" });
  const branchOnlyMerge = f.seed("old.merge", { repo, kind: "merge", branch: "feature/topic" });
  const args = ["--repo", repo, "--branch", "feature/topic"];
  const failed = f.run({ args, RUN_ERROR: "1" });
  assert.notEqual(failed.status, 0);
  assert.ok(existsSync(selected));
  const result = f.run({ args });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cleared, 1);
  assert.ok(!existsSync(selected));
  assert.ok(existsSync(sibling));
  assert.ok(existsSync(nearMatch));
  assert.ok(existsSync(f.marker));
  assert.ok(existsSync(branchOnlyMerge));
  for (const line of readFileSync(f.trace, "utf8").trim().split("\n")) {
    const call = JSON.parse(line);
    assert.ok(call.includes("branch=feature/topic"));
    assert.ok(call.includes("repos/owner/target/actions/runs"));
  }
}));

test("a marker replaced during the network query is available for the next attempt", () => withTempDir(dir => {
  const f = fixture(dir);
  const replacement = JSON.stringify({ repo, kind: "merge", prNumber: "5", sessionId: "new-session" });
  const result = f.run({ REPLACE_MARKER: f.marker, REPLACEMENT: replacement });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cleared, 0);
  assert.equal(readFileSync(f.marker, "utf8"), replacement);
}));
