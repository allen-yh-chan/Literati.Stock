import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { git, initRepo } from "./lib/git.mjs";
import { makeConsumerIdentity, makeNonDevproIdentity } from "./lib/identity-fixtures.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { repoPath } from "./lib/repo-root.mjs";
import {
  fakeGhExecutor,
  run,
  withConsumerRepo,
  withSlimSyncSource,
} from "./lib/sync-agent-rules-harness.mjs";
import {
  DP_CHANGE_ENVIRONMENT_STAGES,
  maybeRepairConsumerMergePolicy,
  runDpChangeEnvironmentChecks,
} from "../dp-change-environment-checks.mjs";

/**
 * Tests for the devpro:change environment merge-policy check (design.md D1-D5, D7, D8).
 *
 * Unit coverage of `maybeRepairConsumerMergePolicy(promptSession, consumerRoot,
 * options = {})` plus the devpro:change entry-point / raw-sync isolation spawn tests
 * and the rule-anchor grep guard.
 *
 * `consumerRoot` is never touched by the filesystem in the unit tests:
 * `options.runGh` is always injected (design.md D2), so it only needs to be a
 * stable string passed through as `spawnSync`'s `cwd`.
 */
const FAKE_CONSUMER_ROOT = "/fake/consumer-root";
const GH_VIEW_QUERY_ARGS = [
  "repo",
  "view",
  "--json",
  "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerPermission,nameWithOwner",
];

function validViewResult({
  mergeCommitAllowed = true,
  squashMergeAllowed = false,
  rebaseMergeAllowed = false,
  viewerPermission = "ADMIN",
  nameWithOwner = "devpro-tw/example",
} = {}) {
  return {
    status: 0,
    stdout: JSON.stringify({
      mergeCommitAllowed,
      squashMergeAllowed,
      rebaseMergeAllowed,
      viewerPermission,
      nameWithOwner,
    }),
    stderr: "",
  };
}

// Spy promptSession — same { ask(), close() } shape as createPromptSession(),
// but records call count so tests can assert "prompt was never shown"
// (harness's fakePromptSession() answers questions but doesn't count calls).
function spyPromptSession(answer) {
  return {
    calls: 0,
    async ask() {
      this.calls += 1;
      return answer;
    },
    close() {},
  };
}

// Capture only stdout (console.log), matching the stream split asserted by
// this suite: all in-band skip/warning messages are console.log per
// design.md D3; only the D4 outer-catch fallback is console.warn/stderr,
// which this suite intentionally does not assert (tasks.md T1 note).
async function captureStdout(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(" ")); };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

async function captureResult(fn) {
  let result;
  const stdout = await captureStdout(async () => {
    result = await fn();
  });
  return { result, stdout };
}

function editCallsOf(fakeGh) {
  return fakeGh.calls.filter((args) => args[0] === "repo" && args[1] === "edit");
}

// ---------------------------------------------------------------------------
// T1 — five degradation reasons + quiet-when-compliant + non-interactive
// ---------------------------------------------------------------------------

it("skips with 'gh CLI not installed' when commandExists is injected false", async () => {
  const fakeGh = fakeGhExecutor({});
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(true), FAKE_CONSUMER_ROOT, {
      commandExists: () => false,
      runGh: fakeGh.runGh,
    })
  );
  assert.match(stdout, /Skipped GitHub merge policy update \(gh CLI not installed\)\.$/m);
  assert.equal(fakeGh.calls.length, 0, "must not query gh when it is not installed");
});

it("skips with 'gh query failed or unavailable' when gh repo view exits non-zero", async () => {
  const fakeGh = fakeGhExecutor({
    view: { status: 1, stdout: "", stderr: "error: authentication required" },
  });
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(true), FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.match(stdout, /Skipped GitHub merge policy update \(gh query failed or unavailable\)\.$/m);
});

it("skips with 'gh query failed or unavailable' when runGh reports a spawnSync error (timeout/ENOENT)", async () => {
  const fakeGh = fakeGhExecutor({
    view: { error: new Error("spawnSync gh ETIMEDOUT") },
  });
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(true), FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.match(stdout, /Skipped GitHub merge policy update \(gh query failed or unavailable\)\.$/m);
});

it("skips with 'gh query failed or unavailable' when gh repo view returns non-JSON stdout", async () => {
  const fakeGh = fakeGhExecutor({
    view: { status: 0, stdout: "not json at all", stderr: "" },
  });
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(true), FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.match(stdout, /Skipped GitHub merge policy update \(gh query failed or unavailable\)\.$/m);
});

it("skips (does not silently treat as compliant) when squashMergeAllowed key is missing from an exit-0 JSON payload", async () => {
  const fakeGh = fakeGhExecutor({
    view: {
      status: 0,
      stdout: JSON.stringify({
        mergeCommitAllowed: true,
        rebaseMergeAllowed: false,
        viewerPermission: "ADMIN",
        nameWithOwner: "devpro-tw/example",
      }),
      stderr: "",
    },
  });
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(true), FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.ok(stdout.length > 0, "F1: missing-field shape must not be misjudged as quiet-compliant");
  assert.match(stdout, /Skipped GitHub merge policy update \(gh query failed or unavailable\)\.$/m);
});

it("skips (does not silently treat as compliant) when squashMergeAllowed is null in an exit-0 JSON payload", async () => {
  const fakeGh = fakeGhExecutor({
    view: {
      status: 0,
      stdout: JSON.stringify({
        mergeCommitAllowed: true,
        squashMergeAllowed: null,
        rebaseMergeAllowed: false,
        viewerPermission: "ADMIN",
        nameWithOwner: "devpro-tw/example",
      }),
      stderr: "",
    },
  });
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(true), FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.ok(stdout.length > 0, "F1: null-valued shape must not be misjudged as quiet-compliant");
  assert.match(stdout, /Skipped GitHub merge policy update \(gh query failed or unavailable\)\.$/m);
});

it("skips with 'gh query failed or unavailable' when viewerPermission key is absent", async () => {
  const fakeGh = fakeGhExecutor({
    view: {
      status: 0,
      stdout: JSON.stringify({
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        nameWithOwner: "devpro-tw/example",
      }),
      stderr: "",
    },
  });
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(true), FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.match(stdout, /Skipped GitHub merge policy update \(gh query failed or unavailable\)\.$/m);
});

it("skips with 'requires repo admin permission' and never prompts when viewerPermission is WRITE", async () => {
  const fakeGh = fakeGhExecutor({
    view: validViewResult({ viewerPermission: "WRITE", squashMergeAllowed: true }),
  });
  const promptSession = spyPromptSession(true);
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(promptSession, FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.match(stdout, /GitHub merge policy does not match the required target/);
  assert.match(stdout, /Skipped GitHub merge policy update \(requires repo admin permission\)\.$/m);
  assert.equal(promptSession.calls, 0, "non-admin viewer must not be prompted");
});

it("returns checked/compliant with zero output only when all three target flags match", async () => {
  const fakeGh = fakeGhExecutor({
    view: validViewResult({ squashMergeAllowed: false, rebaseMergeAllowed: false }),
  });
  const promptSession = spyPromptSession(true);
  const { result, stdout } = await captureResult(() =>
    maybeRepairConsumerMergePolicy(promptSession, FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.equal(stdout, "");
  assert.equal(promptSession.calls, 0);
  assert.equal(editCallsOf(fakeGh).length, 0);
  assert.deepEqual(fakeGh.calls[0], GH_VIEW_QUERY_ARGS);
  assert.deepEqual(result, {
    check: "github-merge-policy",
    execution: "checked",
    outcome: "compliant",
    detail: "merge commit is enabled; squash and rebase merge are disabled",
  });
});

it("treats disabled merge commits as noncompliant even when squash/rebase are disabled", async () => {
  const fakeGh = fakeGhExecutor({
    view: validViewResult({
      mergeCommitAllowed: false,
      squashMergeAllowed: false,
      rebaseMergeAllowed: false,
    }),
  });
  const promptSession = spyPromptSession(false);
  const { result, stdout } = await captureResult(() =>
    maybeRepairConsumerMergePolicy(promptSession, FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.match(stdout, /GitHub merge policy does not match the required target/);
  assert.equal(promptSession.calls, 1);
  assert.equal(editCallsOf(fakeGh).length, 0);
  assert.equal(result.execution, "checked");
  assert.equal(result.outcome, "risk");
});

it("non-interactive stdin only warns and never writes when squash is allowed", async () => {
  const fakeGh = fakeGhExecutor({
    view: validViewResult({ squashMergeAllowed: true }),
  });
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(null, FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.match(stdout, /GitHub merge policy does not match the required target/);
  assert.match(stdout, /Skipped GitHub merge policy update \(non-interactive stdin\)\.$/m);
  assert.equal(editCallsOf(fakeGh).length, 0);
});

// ---------------------------------------------------------------------------
// T2 — interactive repair, argv ordering, decline writes nothing
// ---------------------------------------------------------------------------

it("issues exactly one atomic gh repo edit with merge-commit enabled before squash/rebase disabled when user confirms", async () => {
  const fakeGh = fakeGhExecutor({
    view: validViewResult({ squashMergeAllowed: true, rebaseMergeAllowed: true }),
    edit: { status: 0, stdout: "", stderr: "" },
  });
  const { result } = await captureResult(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(true), FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  const editCalls = editCallsOf(fakeGh);
  assert.equal(editCalls.length, 1);
  const argv = editCalls[0];
  assert.ok(argv.includes("--enable-merge-commit"), argv.join(" "));
  assert.ok(argv.includes("--enable-squash-merge=false"), argv.join(" "));
  assert.ok(argv.includes("--enable-rebase-merge=false"), argv.join(" "));
  assert.ok(
    argv.indexOf("--enable-merge-commit") < argv.indexOf("--enable-squash-merge=false"),
    "merge-commit enable must precede squash disable in argv"
  );
  // The write target is pinned to the slug the user saw in the prompt rather
  // than left to gh's cwd-based base-repo resolution, which can land on a
  // fork's parent. Approved repo and written repo must be the same value.
  assert.equal(argv[2], "devpro-tw/example", argv.join(" "));
  assert.equal(result.execution, "checked");
  assert.equal(result.outcome, "repaired");
});

it("writes nothing and prints the unparenthesized skip message when user declines", async () => {
  const fakeGh = fakeGhExecutor({
    view: validViewResult({ squashMergeAllowed: true }),
  });
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(false), FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.equal(editCallsOf(fakeGh).length, 0);
  assert.match(stdout, /Skipped GitHub merge policy update\.$/m);
});

it("prints the squash/rebase warning body pointing at the git-pr-template-and-merge.md SSOT", async () => {
  const fakeGh = fakeGhExecutor({
    view: validViewResult({ squashMergeAllowed: true }),
  });
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(false), FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.match(stdout, /GitHub merge policy does not match the required target/);
  assert.match(stdout, /git-pr-template-and-merge\.md/);
});

it("skips with 'gh repo edit failed' when the confirmed write itself fails", async () => {
  const fakeGh = fakeGhExecutor({
    view: validViewResult({ squashMergeAllowed: true }),
    edit: { status: 1, stdout: "", stderr: "error: HTTP 403: Resource not accessible" },
  });
  const stdout = await captureStdout(() =>
    maybeRepairConsumerMergePolicy(spyPromptSession(true), FAKE_CONSUMER_ROOT, {
      commandExists: () => true,
      runGh: fakeGh.runGh,
    })
  );
  assert.match(stdout, /Skipped GitHub merge policy update \(gh repo edit failed\)\.$/m);
});

// ---------------------------------------------------------------------------
// T4 — raw sync/check isolation (end-to-end: real spawns of the CLI entrypoint).
//
// createFakeCommand(binDir, "gh") (sync-agent-rules-harness.mjs) always
// writes a fixed "#!/bin/sh\nexit 0\n" script with no stdout, so it cannot
// produce a realistic typed repo-view payload. This suite writes its own small
// inline `gh` script (same technique as createGitFlowFixture()'s fake `gh` in
// the harness) so it can prove raw sync/check never invoke that executable.
// ---------------------------------------------------------------------------

// `callLog`, when given, is a file every invocation appends its argv to — the
// `--check` isolation test needs "gh was never invoked at all", which stdout
// assertions alone cannot prove.
async function writeFakeGhRepoView(binDir, payload, { callLog } = {}) {
  const ghPath = path.join(binDir, "gh");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    ghPath,
    "#!/bin/sh\n" +
      (callLog ? `echo "$@" >> "${callLog}"\n` : "") +
      'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then\n' +
      `  echo '${payload}'\n` +
      "  exit 0\n" +
      "fi\n" +
      "exit 1\n"
  );
  await fs.chmod(ghPath, 0o755);
  return ghPath;
}

const NON_COMPLIANT_ADMIN_PAYLOAD = JSON.stringify({
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
  viewerPermission: "ADMIN",
  nameWithOwner: "devpro-tw/example",
});

it("--sync does not invoke GitHub merge policy diagnostics", async () => {
  await withConsumerRepo(async (local) => {
    const binDir = path.join(local.tmpDir, "gh-bin");
    const ghCallsFile = path.join(local.tmpDir, "sync-gh-calls.txt");
    await writeFakeGhRepoView(binDir, NON_COMPLIANT_ADMIN_PAYLOAD, { callLog: ghCallsFile });

    // No `input` is needed: raw sync must not reach any GitHub diagnostic path.
    const { stdout, exitCode, stderr } = run(local.syncScript, "--sync", {
      cwd: local.tmpDir,
      env: { PATH: `${binDir}:${process.env.PATH}` },
    });

    assert.equal(exitCode, 0, stderr);
    assert.doesNotMatch(stdout, /GitHub merge policy/);
    assert.doesNotMatch(stdout, /Skipped GitHub merge policy update/);
    const ghCalls = await fs.readFile(ghCallsFile, "utf8").catch(() => "");
    assert.equal(ghCalls, "", "gh must not be invoked during raw --sync");
  });
});

it("--check does not run GitHub merge policy diagnostics or invoke gh at all", async () => {
  await withSlimSyncSource(async ({ sourceRoot: slimSourceRoot }) => {
    await withConsumerRepo(async (local) => {
      const binDir = path.join(local.tmpDir, "gh-bin");
      const ghCallsFile = path.join(local.tmpDir, "gh-calls.txt");
      await writeFakeGhRepoView(binDir, NON_COMPLIANT_ADMIN_PAYLOAD, { callLog: ghCallsFile });

      const sync = run(local.syncScript, "--sync", {
        cwd: local.tmpDir,
        testSourceRoot: slimSourceRoot,
      });
      assert.equal(sync.exitCode, 0, sync.stderr);

      const rootScript = path.join(local.tmpDir, ".devpro", "scripts", "sync-agent-rules.mjs");
      const { stdout, exitCode, stderr } = run(rootScript, "--check", {
        cwd: local.tmpDir,
        env: { PATH: `${binDir}:${process.env.PATH}` },
        testSourceRoot: slimSourceRoot,
      });

      assert.equal(exitCode, 0, stderr);
      assert.match(stdout, /All derived files are in sync/);
      assert.doesNotMatch(stdout, /GitHub merge policy/);
      assert.doesNotMatch(stdout, /Skipped GitHub merge policy update/);
      const ghCalls = await fs.readFile(ghCallsFile, "utf8").catch(() => "");
      assert.equal(ghCalls.trim().length, 0, "gh must not be invoked at all during --check");
    });
  });
});

function assertRepoSettingsTrigger(body) {
  assert.ok(
    body.includes("repo settings 是網頁 UI 合併路徑的唯一防線"),
    "anchor literal missing from git-pr-template-and-merge.md"
  );
  // The bullet must stay inside the canonical merge-strategy section, not drift
  // into some other heading where readers of the merge policy will not see it.
  const sectionStart = body.indexOf("### 合併策略（feature → main）— canonical source");
  const anchorAt = body.indexOf("repo settings 是網頁 UI 合併路徑的唯一防線");
  assert.ok(sectionStart !== -1, "canonical merge-strategy heading missing");
  assert.ok(anchorAt > sectionStart, "anchor bullet must live under the merge-strategy heading");
  const sectionEnd = body.indexOf("#### Linked Worktree Merge Cleanup Note", sectionStart);
  assert.ok(sectionEnd > anchorAt, "canonical repo-settings section boundary missing");
  const section = body.slice(sectionStart, sectionEnd);
  assert.match(
    section,
    /`devpro:change` startup.*`node \.devpro\/scripts\/dp-change-environment-checks\.mjs`/s,
    "canonical merge rule must assign the diagnostic to the devpro:change environment entry"
  );
  assert.match(
    section,
    /raw `sync-agent-rules\.mjs --sync` 與 `--check` \*\*MUST NOT\*\* 執行此 external-state 診斷或修復/,
    "canonical merge rule must forbid raw sync/check from running the diagnostic"
  );
  assert.doesNotMatch(
    section,
    /`sync-agent-rules\.mjs --sync` 會 best-effort 診斷/,
    "canonical merge rule must not retain the old sync-owned trigger"
  );
}

// T5 anchor/trigger guard. Lives beside the behavior it explains so a stale
// canonical rule fails the same suite as the moved merge-policy capability.
it("git-pr-template-and-merge.md keeps the repo-settings anchor and devpro:change trigger", async () => {
  const rulePath = new URL("../../agent-rules/git-pr-template-and-merge.md", import.meta.url);
  const body = await fs.readFile(rulePath, "utf8");

  assertRepoSettingsTrigger(body);
  assert.throws(
    () => assertRepoSettingsTrigger(
      body
        .replace("`devpro:change` startup", "raw rules sync")
        .replace("raw `sync-agent-rules.mjs --sync` 與 `--check` **MUST NOT**", "raw `sync-agent-rules.mjs --sync` 與 `--check` MAY")
    ),
    /devpro:change environment entry|forbid raw sync\/check/,
    "assigning the canonical rule back to raw sync must make the guard fail"
  );
});

it("devpro:change environment registry owns all class 2 stages in deterministic order", () => {
  assert.deepEqual(
    DP_CHANGE_ENVIRONMENT_STAGES.map(({ check, owner, class: deliveryClass }) => ({ check, owner, class: deliveryClass })),
    [
      { check: "openspec-cli", owner: "devpro:change", class: 2 },
      { check: "local-excludes", owner: "devpro:change", class: 2 },
      { check: "hooks-path", owner: "devpro:change", class: 2 },
      { check: "core-symlinks", owner: "devpro:change", class: 2 },
      { check: "runtime-auto-compact", owner: "devpro:change", class: 2 },
      { check: "github-merge-policy", owner: "devpro:change", class: 2 },
    ]
  );
});

it("local excludes require consent and affect both worktrees without hiding other notes", async (t) => {
  const root = makeTempDir("startup-local-excludes-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  initRepo(root);
  makeNonDevproIdentity(root);
  const stage = DP_CHANGE_ENVIRONMENT_STAGES.find(({ check }) => check === "local-excludes");
  assert.ok(stage, "the startup environment runs the local exclude check");
  const gitignore = "# target-owned ignore\n*.local\n";
  await fs.writeFile(path.join(root, ".gitignore"), gitignore);
  const exclude = path.resolve(root, git(root, "rev-parse", "--git-common-dir"), "info/exclude");
  const existing = "# keep this\n/manual-cache/";
  await fs.writeFile(exclude, existing);
  const linked = path.join(root, ".worktree", "linked");
  git(root, "worktree", "add", "-q", "-b", "test/linked", linked);
  const beforeConfig = git(root, "config", "--local", "--list");
  const cli = spawnSync(process.execPath, [repoPath(".devpro/scripts/dp-change-environment-checks.mjs"), "--local-excludes-only"], {
    cwd: linked, encoding: "utf8", input: "",
  });
  assert.equal(cli.status, 0, cli.stderr);
  const results = JSON.parse(cli.stdout.trim().replace(/^devpro:change environment checks: /, ""));
  assert.deepEqual(results.map(({ check, outcome }) => [check, outcome]), [["local-excludes", "risk"]]);
  assert.equal(git(root, "config", "--local", "--list"), beforeConfig);
  assert.equal(await fs.readFile(exclude, "utf8"), existing);
  const runCheck = (promptSession) => runDpChangeEnvironmentChecks({ cwd: linked, stages: [stage], promptSession });

  assert.equal((await runCheck(null))[0].outcome, "risk");
  let asks = 0;
  assert.equal((await runCheck({ ask: async () => { asks++; return false; } }))[0].outcome, "risk");
  assert.equal(asks, 1);
  assert.equal(await fs.readFile(exclude, "utf8"), existing);

  assert.equal((await runCheck({ ask: async (question) => {
    assert.match(question, /info\/exclude file shared by all worktrees/);
    assert.match(question, /\/\.worktree\//);
    assert.ok(question.includes(JSON.stringify(path.join(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "exclude"))));
    return true;
  } }))[0].outcome, "repaired");
  const updated = await fs.readFile(exclude, "utf8");
  assert.ok(updated.startsWith(`${existing}\n`));
  assert.equal(await fs.readFile(path.join(root, ".gitignore"), "utf8"), gitignore);

  for (const cwd of [root, linked]) {
    await fs.mkdir(path.join(cwd, "notes", "tmp"), { recursive: true });
    await fs.writeFile(path.join(cwd, "notes", "tmp", "devpro.log"), "local\n");
    await fs.writeFile(path.join(cwd, "notes", "session-pending.md"), "local\n");
    await fs.writeFile(path.join(cwd, "notes", "product.md"), "product\n");
    const status = git(cwd, "status", "--short", "--untracked-files=all");
    assert.match(status, /notes\/product\.md/);
    assert.doesNotMatch(status, /(?:notes\/tmp\/|session-pending\.md|\.worktree\/)/);
  }
  assert.equal((await runCheck({ ask: async () => assert.fail("already configured") }))[0].outcome, "compliant");
  assert.equal(await fs.readFile(exclude, "utf8"), updated);
});

it("the local exclude check leaves an adopted consumer's Git metadata alone", async (t) => {
  const root = makeTempDir("startup-adopted-excludes-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  initRepo(root, { commit: true });
  makeConsumerIdentity(root);
  const stage = DP_CHANGE_ENVIRONMENT_STAGES.find(({ check }) => check === "local-excludes");
  assert.ok(stage);
  const result = await stage.run({ cwd: root, promptSession: { ask: async () => assert.fail("adopted repo") } });
  assert.equal(result.outcome, "not-applicable");
});

it("devpro:change environment entry continues after stage failure and never labels it compliant", async () => {
  const calls = [];
  const stages = [
    { check: "first", async run() { calls.push("first"); throw new Error("secret failure detail"); } },
    { check: "second", async run() { calls.push("second"); return { check: "second", execution: "checked", outcome: "compliant", detail: "ok" }; } },
  ];
  const results = await runDpChangeEnvironmentChecks({
    cwd: FAKE_CONSUMER_ROOT,
    homeDir: "/fake/home",
    promptSession: null,
    stages,
  });
  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(results[0], {
    check: "first",
    execution: "skipped",
    outcome: "risk",
    detail: "stage failed",
  });
  assert.equal(results[1].outcome, "compliant");
});
