import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as admission from "../hooks/lib/admission-record.mjs";
import { evaluatePostPrCostBudget } from "../hooks/lib/post-pr-cost-circuit-breaker.mjs";
import * as evidenceFacade from "../review-remediation-evidence.mjs";

// fix-codex-reviewer-intent-candidate-cap T2d (prove-it, R5): one successful same-common-dir worktree
// enumeration handle per hook run. The API under test (createWorktreeEnumerationMemo,
// isWorktreeEnumerationMemo, the optional enumerationMemo parameter, __testEnumerateLinkedWorktrees) is
// reached through a namespace import and asserted inside each test, so a missing export fails that test
// with a readable message instead of making the whole file a SyntaxError.
//
// __testEnumerateLinkedWorktrees is assumed to take the same option object as the private
// enumerateLinkedWorktrees ({ cwd, hooks, allowUnresolvablePaths, memo }) and to return its result.

function gitFixture(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}

// A main checkout that commits `changeIds` under openspec/changes/, plus one linked worktree per spec.
// `rel` is relative to the fixture root; a path with a `.worktree/<id>` segment makes the worktree a candidate.
function makeRepo({ changeIds, worktrees }) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "worktree-enumeration-memo-")));
  const mainRoot = path.join(root, "main");
  for (const id of changeIds) {
    mkdirSync(path.join(mainRoot, "openspec", "changes", id), { recursive: true });
    writeFileSync(path.join(mainRoot, "openspec", "changes", id, "tasks.md"), `# ${id}\n`);
  }
  gitFixture(mainRoot, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(mainRoot, ".gitignore"), ".worktree/\n");
  writeFileSync(path.join(mainRoot, "seed"), "seed\n");
  gitFixture(mainRoot, ["add", "."]);
  gitFixture(mainRoot, ["commit", "-qm", "seed"]);
  const repo = { root, mainRoot, cleanup() { rmSync(root, { recursive: true, force: true }); }, addWorktree };
  worktrees.forEach((rel, index) => addWorktree(rel, index));
  return repo;

  function addWorktree(rel, index = Math.random().toString(16).slice(2)) {
    const target = path.join(root, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    gitFixture(mainRoot, ["worktree", "add", "-q", "-b", `memo-${index}`, target, "HEAD"]);
  }
}

// Main + .worktree/alpha + two candidates that share the change id `dup` = 4 listed entries.
function standardRepo() {
  return makeRepo({
    changeIds: ["alpha", "dup", "gamma"],
    worktrees: ["main/.worktree/alpha", "main/.worktree/dup", "other/.worktree/dup"],
  });
}
const STANDARD_ENTRIES = 4;

// Test-process wrapper around child_process.spawnSync("git", ...): logs every git call, optionally fails the
// listed `git worktree list` calls (1-based) or pads the list with duplicate main-checkout entries. No production
// seam, no environment variable; everything else goes to the real git and the wrapper is always restored.
function installGitShim({ failListCalls = [], padListTo, padPath } = {}) {
  const original = childProcess.spawnSync;
  const calls = [];
  let listCalls = 0;
  childProcess.spawnSync = function shimmedSpawnSync(file, args, options) {
    if (file !== "git" || !Array.isArray(args)) return original.apply(this, arguments);
    calls.push({ cwd: String(options?.cwd ?? ""), args: [...args] });
    const isList = args[0] === "worktree" && args[1] === "list";
    if (isList) {
      listCalls += 1;
      if (failListCalls.includes(listCalls)) {
        return { status: 1, signal: null, stdout: "", stderr: "", output: [null, "", ""], pid: 0, error: undefined };
      }
    }
    const result = original.apply(this, arguments);
    if (isList && padListTo !== undefined && result.status === 0) {
      const raw = String(result.stdout);
      const have = (raw.match(/\0\0/gu) ?? []).length;
      return { ...result, stdout: raw + `worktree ${padPath}\0HEAD ${"a".repeat(40)}\0\0`.repeat(Math.max(0, padListTo - have)) };
    }
    return result;
  };
  syncBuiltinESMExports();
  return {
    calls,
    lists: () => calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "list").length,
    commonDirs: () => calls.filter((call) => call.args[0] === "rev-parse" && call.args[1] === "--git-common-dir").length,
    restore() {
      childProcess.spawnSync = original;
      syncBuiltinESMExports();
    },
  };
}

function withShim(options, run) {
  const shim = installGitShim(options);
  try {
    return { value: run(), shim };
  } finally {
    shim.restore();
  }
}

function requireMemoApi() {
  assert.equal(typeof admission.createWorktreeEnumerationMemo, "function", "admission-record.mjs must export createWorktreeEnumerationMemo");
  assert.equal(typeof admission.isWorktreeEnumerationMemo, "function", "admission-record.mjs must export isWorktreeEnumerationMemo");
}

const CHANGE_IDS = ["alpha", "dup", "missing", "alpha"];

function resolveAll(repo, memoFor) {
  return CHANGE_IDS.map((changeId) => admission.resolveExactOneChangeWorktreeBinding({
    cwd: repo.mainRoot,
    changeId,
    ...(memoFor === undefined ? {} : { enumerationMemo: memoFor }),
  }));
}

test("Same-Branch Markers Share One Successful Worktree Enumeration: K resolutions with one handle list worktrees once and return exactly what independent resolutions return", () => {
  requireMemoApi();
  const repo = standardRepo();
  try {
    const baseline = withShim({}, () => resolveAll(repo));
    assert.deepEqual(baseline.value.map((entry) => entry.code ?? "ok"), ["ok", "change-worktree-ambiguous", "change-worktree-required", "ok"],
      "the fixture covers a success, an ambiguity and a zero-candidate resolution");
    assert.equal(baseline.shim.lists(), CHANGE_IDS.length, "without a handle every resolution enumerates (existing behavior)");
    assert.equal(baseline.shim.commonDirs(), CHANGE_IDS.length * (STANDARD_ENTRIES + 1));

    const memo = admission.createWorktreeEnumerationMemo();
    assert.equal(admission.isWorktreeEnumerationMemo(memo), true);
    const shared = withShim({}, () => resolveAll(repo, memo));
    assert.equal(shared.shim.lists(), 1, "git worktree list ran exactly once for the whole run");
    assert.deepEqual(shared.value, baseline.value, "every result is field-for-field the same as without a handle");
    assert.equal(shared.shim.commonDirs(), STANDARD_ENTRIES + CHANGE_IDS.length,
      "the canonical common-dir is still resolved per call; the per-worktree checks run once");
    assert.equal(
      shared.shim.calls.filter((call) => call.args[0] === "rev-parse" && call.args[1] === "HEAD").length,
      2,
      "HEAD is still revalidated for each of the two resolutions that select a worktree",
    );
  } finally {
    repo.cleanup();
  }
});

test("Same-Branch Markers Share One Successful Worktree Enumeration: the reused enumeration result is deeply frozen", () => {
  requireMemoApi();
  assert.equal(typeof admission.__testEnumerateLinkedWorktrees, "function", "admission-record.mjs must export the test-only __testEnumerateLinkedWorktrees");
  const repo = standardRepo();
  try {
    const memo = admission.createWorktreeEnumerationMemo();
    const first = admission.__testEnumerateLinkedWorktrees({ cwd: repo.mainRoot, memo });
    assert.equal(first.ok, true);
    assert.equal(first.linked.length, 3, "alpha and both dup worktrees are candidates; main is not");
    assert.equal(Object.isFrozen(first), true, "the result object is frozen");
    assert.equal(Object.isFrozen(first.linked), true, "the linked array is frozen");
    for (const entry of first.linked) assert.equal(Object.isFrozen(entry), true, "each linked entry is frozen");
    assert.throws(() => first.linked.push({ repoRoot: "x", changeId: "x" }), TypeError);
    assert.throws(() => { first.linked[0].changeId = "tampered"; }, TypeError);
    assert.throws(() => { first.linked.length = 0; }, TypeError);

    const second = admission.__testEnumerateLinkedWorktrees({ cwd: repo.mainRoot, memo });
    assert.equal(second.linked.length, 3, "the failed mutation attempts changed nothing for the next caller");
    assert.deepEqual(second.linked.map((entry) => entry.changeId), first.linked.map((entry) => entry.changeId));
  } finally {
    repo.cleanup();
  }
});

test("Same-Branch Markers Share One Successful Worktree Enumeration: the cache key separates the unresolvable-path flag and distinct repositories", () => {
  requireMemoApi();
  const repo = standardRepo();
  const other = makeRepo({ changeIds: ["alpha"], worktrees: ["main/.worktree/alpha"] });
  try {
    const memo = admission.createWorktreeEnumerationMemo();
    const flags = withShim({}, () => [
      admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", requireChangeDir: true, enumerationMemo: memo }),
      admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", requireChangeDir: false, enumerationMemo: memo }),
      admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", requireChangeDir: true, enumerationMemo: memo }),
      admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", requireChangeDir: false, enumerationMemo: memo }),
    ]);
    assert.equal(flags.shim.lists(), 2, "requireChangeDir true and false never share an entry; each mode lists once");
    assert.deepEqual(flags.value.map((entry) => entry.ok), [true, true, true, true]);

    const repos = withShim({}, () => [
      admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", enumerationMemo: memo }),
      admission.resolveExactOneChangeWorktreeBinding({ cwd: other.mainRoot, changeId: "alpha", enumerationMemo: memo }),
      admission.resolveExactOneChangeWorktreeBinding({ cwd: other.mainRoot, changeId: "alpha", enumerationMemo: memo }),
    ]);
    assert.equal(repos.shim.lists(), 1, "the first repository was cached by the earlier calls; only the second repository lists, once");
    assert.equal(repos.value[0].repoRoot, path.join(repo.root, "main", ".worktree", "alpha"));
    assert.equal(repos.value[1].repoRoot, path.join(other.root, "main", ".worktree", "alpha"), "a different repository never reuses another one's members");
    assert.deepEqual(repos.value[2], repos.value[1]);
  } finally {
    repo.cleanup();
    other.cleanup();
  }
});

test("Same-Branch Markers Share One Successful Worktree Enumeration: an injected git runner or native-fault propagation bypasses the handle and a new handle sees later worktrees", () => {
  requireMemoApi();
  const repo = standardRepo();
  try {
    const memo = admission.createWorktreeEnumerationMemo();

    let injectedLists = 0;
    // The porcelain -z listing must keep its NUL terminators, so it bypasses gitFixture's trim.
    const rawGit = (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        injectedLists += 1;
        return execFileSync("git", args, { cwd, encoding: "utf8" });
      }
      return gitFixture(cwd, args);
    };
    for (let i = 0; i < 2; i += 1) {
      const result = admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", hooks: { git: rawGit }, enumerationMemo: memo });
      assert.equal(result.ok, true, result.code);
    }
    assert.equal(injectedLists, 2, "an injected git runner is never cached: both calls ran the injected list");

    const propagated = withShim({}, () => [1, 2].map(() => admission.resolveExactOneChangeWorktreeBinding({
      cwd: repo.mainRoot,
      changeId: "alpha",
      propagateNativeFaults: true,
      enumerationMemo: memo,
    })));
    assert.equal(propagated.shim.lists(), 2, "propagateNativeFaults bypasses the handle: neither call reads nor writes it");
    assert.deepEqual(propagated.value.map((entry) => entry.ok), [true, true]);

    const afterBypass = withShim({}, () => [1, 2].map(() => admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", enumerationMemo: memo })));
    assert.equal(afterBypass.shim.lists(), 1, "the bypassed calls left nothing in the handle; the first ordinary call lists once and caches");

    // Independent handles, and a handle built after a change sees the new worktree.
    const otherMemo = admission.createWorktreeEnumerationMemo();
    const independent = withShim({}, () => admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", enumerationMemo: otherMemo }));
    assert.equal(independent.shim.lists(), 1, "a second handle does not inherit the first handle's entry");

    repo.addWorktree("main/.worktree/gamma", "gamma");
    const stale = admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "gamma", enumerationMemo: memo });
    assert.equal(stale.code, "change-worktree-required", "the run's own handle keeps its snapshot");
    const fresh = admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "gamma", enumerationMemo: admission.createWorktreeEnumerationMemo() });
    assert.equal(fresh.ok, true, "a newly created handle enumerates from scratch and sees the later worktree");
    const nohandle = admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "gamma" });
    assert.equal(nohandle.ok, true);
  } finally {
    repo.cleanup();
  }
});

test("Failed Worktree Enumeration Is Never Reused: a failed listing is retried, the first success is cached, and a new handle starts over", () => {
  requireMemoApi();
  const repo = standardRepo();
  try {
    const memo = admission.createWorktreeEnumerationMemo();
    const run = withShim({ failListCalls: [1] }, () => ["alpha", "alpha", "alpha"].map((changeId) => admission.resolveExactOneChangeWorktreeBinding({
      cwd: repo.mainRoot,
      changeId,
      enumerationMemo: memo,
    })));
    assert.deepEqual(run.value.map((entry) => entry.code ?? "ok"), ["intent-scan-failed", "ok", "ok"],
      "the transient failure is reported once and does not stick to the later resolutions");
    assert.equal(run.shim.lists(), 2, "one failed listing plus one successful listing that was then reused");

    const nextRun = withShim({}, () => admission.resolveExactOneChangeWorktreeBinding({
      cwd: repo.mainRoot,
      changeId: "alpha",
      enumerationMemo: admission.createWorktreeEnumerationMemo(),
    }));
    assert.equal(nextRun.value.ok, true);
    assert.equal(nextRun.shim.lists(), 1, "the next hook run's new handle enumerates from the start");
  } finally {
    repo.cleanup();
  }
});

test("Failed Worktree Enumeration Is Never Reused: over-cap listings are judged again by every call without multiplying per-worktree checks", () => {
  requireMemoApi();
  const repo = standardRepo();
  try {
    const memo = admission.createWorktreeEnumerationMemo();
    const K = 3;
    const run = withShim({ padListTo: 129, padPath: repo.mainRoot }, () => Array.from({ length: K }, () => admission.resolveExactOneChangeWorktreeBinding({
      cwd: repo.mainRoot,
      changeId: "alpha",
      enumerationMemo: memo,
    })));
    assert.deepEqual(run.value, Array.from({ length: K }, () => ({ ok: false, code: "intent-candidate-limit-exceeded" })));
    assert.equal(run.shim.lists(), K, "the cap failure is not stored: each call lists again");
    assert.equal(run.shim.commonDirs(), K, "each failed call costs one canonical common-dir probe, not one per listed worktree");
  } finally {
    repo.cleanup();
  }
});

test("Caller-Built Enumeration Handle Is Refused: anything the enumeration module did not create throws enumeration-memo-invalid before any git call", () => {
  requireMemoApi();
  const repo = standardRepo();
  try {
    const forgeries = [
      ["plain object", {}],
      ["frozen plain object", Object.freeze({})],
      ["prototype-less object", Object.create(null)],
      ["string", "memo"],
      ["number", 7],
      ["null", null],
      ["Map-shaped object", { get() {}, set() {}, has() { return true; } }],
    ];
    const real = admission.createWorktreeEnumerationMemo();
    assert.equal(admission.isWorktreeEnumerationMemo(real), true);
    for (const [label, forged] of forgeries) {
      assert.equal(admission.isWorktreeEnumerationMemo(forged), false, `isWorktreeEnumerationMemo(${label})`);
      const plain = withShim({}, () => {
        assert.throws(
          () => admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", enumerationMemo: forged }),
          /enumeration-memo-invalid/u,
        );
      });
      assert.deepEqual(plain.shim.calls, [], "no git call ran before the refusal");

      let injectedCalls = 0;
      assert.throws(
        () => admission.resolveExactOneChangeWorktreeBinding({
          cwd: repo.mainRoot,
          changeId: "alpha",
          hooks: { git() { injectedCalls += 1; return null; } },
          enumerationMemo: forged,
        }),
        /enumeration-memo-invalid/u,
        "an injected git runner does not exempt a forged handle",
      );
      assert.equal(injectedCalls, 0, "the injected runner was not called either");

      assert.throws(
        () => admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", propagateNativeFaults: true, enumerationMemo: forged }),
        /enumeration-memo-invalid/u,
        "native-fault propagation does not exempt a forged handle",
      );
    }
    assert.equal(
      admission.resolveExactOneChangeWorktreeBinding({ cwd: repo.mainRoot, changeId: "alpha", enumerationMemo: undefined }).ok,
      true,
      "an absent handle (undefined) is the ordinary uncached call",
    );
  } finally {
    repo.cleanup();
  }
});

test("Caller-Built Enumeration Handle Is Refused: the stall observation facade throws and the Cost Circuit Breaker maps it to unavailable, never not-applicable", () => {
  requireMemoApi();
  const repo = standardRepo();
  try {
    const forged = {};
    const facade = withShim({}, () => {
      assert.throws(
        () => evidenceFacade.queryReviewStallState({ repoRoot: repo.mainRoot, changeId: "alpha", enumerationMemo: forged }),
        /enumeration-memo-invalid/u,
        "the production facade refuses a caller-built handle before it reaches the core (the core would swallow it as not-applicable)",
      );
    });
    assert.deepEqual(facade.shim.calls, [], "no git call ran before the facade refusal");

    for (const seam of ["fsOps", "gitImpl", "spawnSyncImpl", "runnerImpl", "testMode"]) {
      assert.throws(
        () => evidenceFacade.queryReviewStallState({ repoRoot: repo.mainRoot, changeId: "alpha", [seam]: {} }),
        undefined,
        `the ${seam} mutation seam is still refused by the facade`,
      );
    }

    const budget = evaluatePostPrCostBudget({ branch: "chore/alpha", cwd: repo.mainRoot, enumerationMemo: forged });
    assert.deepEqual(budget.result.thresholds.stalled_rounds, { value: null, limit: null, state: "unavailable" },
      "a refused handle fails closed: the stall threshold is unavailable, which blocks");

    const memo = admission.createWorktreeEnumerationMemo();
    const honest = evaluatePostPrCostBudget({ branch: "chore/alpha", cwd: repo.mainRoot, enumerationMemo: memo });
    assert.equal(honest.result.thresholds.stalled_rounds.state, "not-applicable", "a real handle over a change with no receipts stays not-applicable");
  } finally {
    repo.cleanup();
  }
});
