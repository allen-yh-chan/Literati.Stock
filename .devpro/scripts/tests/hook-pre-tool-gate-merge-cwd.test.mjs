import "./lib/git-location-isolated-env.mjs";
import "./lib/isolated-control-evidence-state.mjs";
import "./lib/portable-command-shims.cjs";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "./lib/tmp.mjs";
import { evaluatePreToolUsePayload } from "../hooks/pre-tool-gate.mjs";

// Issue #3454: same PR number in two repos must resolve in the command's cwd.
const root = realpathSync(makeTempDir("merge-cwd-"));
const repoA = path.join(root, "repo-a");
const repoB = path.join(root, "repo b");
const bin = path.join(root, "bin");
const trace = path.join(root, "gh-trace.jsonl");
for (const dir of [repoA, repoB, bin]) mkdirSync(dir);
after(() => rmSync(root, { recursive: true, force: true }));
// A and B are checkouts of example/repo-a and example/repo-b, so a merge from A may name B as the evidence checkout
// of that repository. Every merge writes its repository in full.
for (const [dir, slug] of [[repoA, "repo-a"], [repoB, "repo-b"]]) {
  for (const args of [["init", "-q"], ["remote", "add", "origin", `https://github.com/example/${slug}.git`]]) {
    assert.equal(spawnSync("git", ["-C", dir, ...args]).status, 0, args.join(" "));
  }
}
const REPO_A = "--repo github.com/example/repo-a";
const REPO_B = "--repo github.com/example/repo-b";

writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MERGE_CWD_TRACE, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
// A lookup reads the fixture of the repository it names (--repo or a repos/<owner>/<repo>/ path), whatever its cwd, so
// a lookup that names the wrong repository gets that repository's PR (PR #3703 r8 W5-F1); one that names no known
// repository fails, so it can never pass as a lookup of the right one (PR #3703 r9 W5-F2). A repository counts only as
// the value right after --repo/-R or as an API path, so a lookup that drops the flag and keeps the value fails
// (PR #3703 r10 W6-F1).
const flag = args.findIndex((arg, i) => (arg === "--repo" || arg === "-R") && /^github\\.com\\/example\\/repo-[ab]$/.test(args[i + 1] ?? ""));
const named = flag >= 0 ? args[flag + 1].slice(-6) : args.map((arg) => /^repos\\/example\\/(repo-[ab])\\//.exec(arg)?.[1]).find(Boolean);
if (!named) { process.stderr.write("gh stub: the lookup names no known repository\\n"); process.exit(1); }
const fixture = named === "repo-a" ? process.env.MERGE_CWD_REPO_A : process.env.MERGE_CWD_REPO_B;
fs.writeFileSync(1, fs.readFileSync(path.join(fixture, "pr.json")));
`, { mode: 0o755 });

function evaluate(command, { aExempt = false, bExempt = true, expectGhCalls = true, cwd = repoA } = {}) {
  for (const [dir, exempt] of [[repoA, aExempt], [repoB, bExempt]]) {
    writeFileSync(path.join(dir, "pr.json"), JSON.stringify({
      headRefName: exempt ? "chore/bump-v1.0.1" : "feature/requires-review",
      headRefOid: "a".repeat(40), baseRefName: "main", comments: [], body: "", isCrossRepository: false,
    }));
  }
  writeFileSync(trace, "");
  const overrides = {
    DEVPRO_POSTMERGE_STATE_DIR: path.join(root, "postmerge-state"),
    DEVPRO_RECAP_PENDING_DIR: path.join(root, "recap-pending"),
    DEVPRO_RECAP_STATE_DIR: path.join(root, "recap-state"),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    MERGE_CWD_TRACE: trace,
    MERGE_CWD_REPO_A: repoA,
    MERGE_CWD_REPO_B: repoB,
    CROSS_MODEL_MERGE_GATE_MOCK_GH_OUTPUT: undefined,
    CROSS_MODEL_MERGE_GATE_MOCK_DIFF_FILES: "openspec/changes/test/proposal.md",
    CROSS_MODEL_MERGE_GATE_MOCK_BRANCH: undefined,
  };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const result = evaluatePreToolUsePayload({
      cwd, tool_name: "Bash", tool_input: { command },
    });
    const calls = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    if (expectGhCalls) assert.ok(calls.length > 0, "merge must query PR metadata through gh");
    return { result, calls };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("merge cwd: plain A merge still blocks a PR missing review", () => {
  const { result, calls } = evaluate(`gh pr merge 36 ${REPO_A} --merge`);
  assert.equal(result?.block, true);
  assert.match(result.reason, /Path B/);
  assert.ok(calls.every((call) => call.cwd === repoA));
});

test("merge cwd: plain A merge still permits an exempt PR", () => {
  const { result, calls } = evaluate(`gh pr merge 36 ${REPO_A} --merge`, { aExempt: true });
  assert.ok(!result?.block, JSON.stringify(result));
  assert.ok(calls.every((call) => call.cwd === repoA));
});

test("merge cwd: a merge run in B permits B's exempt PR despite A's same-number non-exempt PR", () => {
  const { result, calls } = evaluate(`gh pr merge 36 ${REPO_B} --merge`, { cwd: repoB });
  assert.ok(!result?.block, JSON.stringify(result));
  assert.ok(calls.every((call) => call.cwd === repoB), JSON.stringify(calls));
});

test("merge cwd: a cd into B before the merge is another step, blocked before any gh call (PR #3703 r3)", () => {
  const { result, calls } = evaluate(`cd "${repoB}" && gh pr merge 36 ${REPO_B} --merge`, { expectGhCalls: false });
  assert.equal(result?.block, true);
  assert.match(result.reason, /^Cross-repo PR merge gate: another step comes before gh pr merge/);
  assert.deepEqual(calls, []);
});

test("merge cwd: a merge run in B blocks B's missing review despite A's same-number exemption", () => {
  const { result, calls } = evaluate(`gh pr merge 36 ${REPO_B} --merge`, {
    aExempt: true, bExempt: false, cwd: repoB,
  });
  assert.equal(result?.block, true);
  assert.match(result.reason, /Path B/);
  assert.ok(calls.every((call) => call.cwd === repoB), JSON.stringify(calls));
});

test("merge cwd: explicit --repo selects B from A once the merge carries the marker and B's checkout", () => {
  const { result, calls } = evaluate(`DEVPRO_CROSS_REPO_PR=example/repo-b DEVPRO_PR_CHECKOUT="${repoB}" gh pr merge 36 ${REPO_B} --merge`);
  assert.ok(!result?.block, JSON.stringify(result));
  // Every lookup names B with its host (PR #3703 r3 F1) and runs in B's checkout, the post-merge marker lookup included
  // (PR #3703 r5 F4); the marker itself is still stored with the session until P2.
  const namesB = (args) => args.some((arg, i) => (arg === "--repo" || arg === "-R") && args[i + 1] === "github.com/example/repo-b")
    || (args[0] === "api" && args[1] === "--hostname" && args[2] === "github.com" && args.some((arg) => arg.startsWith("repos/example/repo-b/")));
  assert.ok(calls.every((call) => namesB(call.args)), JSON.stringify(calls));
  // ...and the PR the merge names, never the PR of a checkout's current branch (PR #3703 r4 F1).
  const views = calls.filter((call) => call.args[0] === "pr" && call.args[1] === "view");
  assert.ok(views.length > 0 && views.every((call) => call.args[2] === "36"), JSON.stringify(calls));
  assert.ok(calls.every((call) => call.cwd === repoB), JSON.stringify(calls));
});

// The control of the test above: A's exemption never answers for B, whose PR still needs its review (PR #3703 r10 W6-F2).
test("merge cwd: merging B from an exempt A with the marker and B's checkout still blocks B's missing review", () => {
  const { result, calls } = evaluate(`DEVPRO_CROSS_REPO_PR=example/repo-b DEVPRO_PR_CHECKOUT="${repoB}" gh pr merge 36 ${REPO_B} --merge`, { aExempt: true, bExempt: false });
  assert.equal(result?.block, true, JSON.stringify(result));
  assert.match(result.reason, /Path B/);
  assert.ok(calls.every((call) => call.cwd === repoB), JSON.stringify(calls));
});

test("merge cwd: a repository word that joins quoted parts is never read, so repo-a's evidence never answers for repo-b (PR #3703 r6 F1)", () => {
  // The shell gives gh example/repo-b for both words; the hook reads neither, and blocks before any gh call.
  for (const [command, reason] of [
    [`GH_REPO="github.com/example/repo"-b gh pr merge 36 --merge`, /GH_REPO= changes what gh reads/],
    [`gh pr merge 36 --repo "github.com/example/repo"-b --merge`, /cannot be read literally/],
  ]) {
    const { result, calls } = evaluate(command, { aExempt: true, expectGhCalls: false });
    assert.equal(result?.block, true, command);
    assert.match(result.reason, reason, command);
    assert.deepEqual(calls, [], command);
  }
});

test("merge cwd: explicit --repo of B from A without the marker and checkout is blocked before any gh call", () => {
  const { result, calls } = evaluate(`gh pr merge 36 ${REPO_B} --merge`, { expectGhCalls: false });
  assert.equal(result?.block, true);
  assert.match(result.reason, /^Cross-repo PR merge gate: this merges github\.com\/example\/repo-b, not the repository of this checkout/);
  assert.deepEqual(calls, []);
});

test("merge cwd: a repeated DEVPRO marker or checkout is blocked before any gh call, whichever value comes last (PR #3703 r7 W3-F1, W1-F1)", () => {
  // A second checkout of repo-b with other evidence: the shell would use the last value, a reader could take the first.
  const repoB2 = path.join(root, `repo b second ${Date.now()}`);
  mkdirSync(repoB2);
  for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/example/repo-b.git"]]) {
    assert.equal(spawnSync("git", ["-C", repoB2, ...args]).status, 0, args.join(" "));
  }
  const checkoutB = `DEVPRO_PR_CHECKOUT="${repoB}"`;
  for (const command of [
    `DEVPRO_CROSS_REPO_PR=example/repo-a DEVPRO_CROSS_REPO_PR=example/repo-b ${checkoutB} gh pr merge 36 ${REPO_B} --merge`,
    `DEVPRO_CROSS_REPO_PR=example/repo-b DEVPRO_CROSS_REPO_PR=example/repo-a ${checkoutB} gh pr merge 36 ${REPO_B} --merge`,
    `DEVPRO_CROSS_REPO_PR=example/repo-b ${checkoutB} DEVPRO_PR_CHECKOUT="${repoB2}" gh pr merge 36 ${REPO_B} --merge`,
    `DEVPRO_CROSS_REPO_PR=example/repo-b DEVPRO_PR_CHECKOUT="${repoB2}" ${checkoutB} gh pr merge 36 ${REPO_B} --merge`,
  ]) {
    const { result, calls } = evaluate(command, { expectGhCalls: false });
    assert.equal(result?.block, true, command);
    assert.match(result.reason, /^Cross-repo PR merge gate: DEVPRO_(?:CROSS_REPO_PR|PR_CHECKOUT)= is assigned more than once in front of gh pr merge/, command);
    assert.deepEqual(calls, [], command);
  }
  // Each name written once passes: repoB2 is a checkout of repo-b, and B's PR is exempt (PR #3703 r8 W5-F2).
  const { result, calls } = evaluate(`DEVPRO_CROSS_REPO_PR=example/repo-b DEVPRO_PR_CHECKOUT="${repoB2}" gh pr merge 36 ${REPO_B} --merge`);
  assert.ok(!result?.block, JSON.stringify(result));
  // The lookups run in the declared checkout, not in repo-b's other checkout (PR #3703 r9 W6-F1).
  assert.ok(calls.every((call) => call.cwd === repoB2), JSON.stringify(calls));
});

test("fixtures: an inherited GIT_DIR never redirects a fixture's git init or origin to another repository (PR #3703 r7 W5-F1)", () => {
  const third = path.join(root, "third repository");
  const fresh = path.join(root, "fresh fixture");
  mkdirSync(third);
  mkdirSync(fresh);
  assert.equal(spawnSync("git", ["init", "-q", third]).status, 0);
  // The child imports the isolation module first, then initializes a fixture the way these tests do.
  const lib = new URL("./lib/git-location-isolated-env.mjs", import.meta.url).href;
  const script = `await import(${JSON.stringify(lib)});
const { spawnSync } = await import("node:child_process");
for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/example/fresh.git"]]) {
  const r = spawnSync("git", ["-C", ${JSON.stringify(fresh)}, ...args]);
  if (r.status !== 0) process.exit(1);
}`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, GIT_DIR: path.join(third, ".git") }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const origin = (dir) => spawnSync("git", ["-C", dir, "config", "--local", "--get", "remote.origin.url"], { encoding: "utf8" }).stdout.trim();
  assert.equal(origin(fresh), "https://github.com/example/fresh.git");
  assert.equal(origin(third), "", "the inherited GIT_DIR's repository is unchanged");
});

test("merge cwd: an ordinary assignment such as a lowercase proxy in front of a merge is blocked before any gh call (PR #3703 r8 W2-F4)", () => {
  const { result, calls } = evaluate(`http_proxy=http://127.0.0.1:9 gh pr merge 36 ${REPO_A} --merge`, { aExempt: true, expectGhCalls: false });
  assert.equal(result?.block, true);
  assert.match(result.reason, /^Cross-repo PR merge gate: http_proxy= changes what gh reads/);
  assert.deepEqual(calls, []);
  const control = evaluate(`gh pr merge 36 ${REPO_A} --merge`, { aExempt: true });
  assert.ok(!control.result?.block, JSON.stringify(control.result));
});

test("merge cwd: raw checks do not read or consume hub or target workflow markers", () => {
  const stateDir = path.join(root, "postmerge-state");
  mkdirSync(stateDir, { recursive: true });
  const own = path.join(stateDir, "feature_requires-review.merge");
  const target = path.join(stateDir, "github.com+example+repo-b#36.merge");
  writeFileSync(own, JSON.stringify({ branch: "feature/requires-review", kind: "merge" }));
  writeFileSync(target, JSON.stringify({ kind: "merge", repo: "github.com/example/repo-b", prNumber: "36" }));
  for (const command of [`gh pr checks 36 ${REPO_A}`, `gh pr checks 36 ${REPO_B}`, "gh pr checks https://github.com/example/repo-b/pull/36"]) {
    const { calls } = evaluate(command, { expectGhCalls: false });
    assert.deepEqual(calls, []);
    assert.ok(existsSync(own));
    assert.ok(existsSync(target));
  }
});
