import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConsumerPrePrChecks, runDoctor } from "../devpro-doctor.mjs";
import { CONSUMER_PRE_PR_CHECKS_REL, CONSUMER_PRE_PR_CHECKS_BASENAME } from "../lib/consumer-pre-pr-checks.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// consumer-adoption-tooling delta (add-consumer-pre-pr-checks): the doctor
// check for `.devpro/pre-pr-checks.local.md` (free-form markdown: never parsed, counted or validated). Each state is built in a real
// temporary git repo so the D12 decision table runs against real git
// behavior; the injected `toolRunner` only records calls (and refuses every
// tool except git) or, for the failure paths, fakes the git result.

const CHECK_NAME = CONSUMER_PRE_PR_CHECKS_BASENAME;
const LIST_PATH = CONSUMER_PRE_PR_CHECKS_REL;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const FIXED_GIT_ARGV = [
  ["ls-tree", "--name-only", "HEAD", "--", LIST_PATH],
  ["diff", "--quiet", "HEAD", "--", LIST_PATH],
  ["ls-files", "--error-unmatch", "--", LIST_PATH],
  ["check-ignore", "-v", "--", LIST_PATH],
];

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function withRepo(fn, { commit = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-pre-pr-checks-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    if (commit) {
      await fs.writeFile(path.join(dir, "README.md"), "fixture\n");
      git(dir, "add", "README.md");
      git(dir, "commit", "-q", "-m", "fixture base");
    }
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeList(dir, content) {
  const full = path.join(dir, ...LIST_PATH.split("/"));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

async function commitList(dir, content) {
  const full = await writeList(dir, content);
  git(dir, "add", LIST_PATH);
  git(dir, "commit", "-q", "-m", "add pre-PR checks list");
  return full;
}

/** Real git (isolated config); every other tool is refused. Records each call. */
function recordingRunner(calls) {
  return (command, args, options) => {
    calls.push([command, ...args]);
    if (command !== "git") return { status: 127, stdout: "", stderr: `${command} refused` };
    return spawnSync(command, args, { ...options, env: GIT_ENV });
  };
}

/** Fake git: each result is keyed by the first git argument. */
function fakeGitRunner(results, calls = []) {
  return (command, args) => {
    calls.push([command, ...args]);
    const result = command === "git" ? results[args[0]] : undefined;
    return result ?? { status: 127, stdout: "", stderr: "not stubbed" };
  };
}

function inspect(dir, runner = recordingRunner([])) {
  return checkConsumerPrePrChecks(dir, runner);
}

function assertNoFailOrNameDrift(checks) {
  for (const check of checks) {
    assert.equal(check.name, CHECK_NAME);
    assert.notEqual(check.status, "FAIL", JSON.stringify(check));
  }
}

const hasWillNotRun = (checks) => checks.some((check) => check.detail.includes("will NOT run"));
const infoOf = (checks) => checks.find((check) => check.status === "INFO");
const warnsOf = (checks) => checks.filter((check) => check.status === "WARN");

test("Absent list reports INFO without calling git", async () => {
  await withRepo(async (dir) => {
    const calls = [];
    const checks = inspect(dir, recordingRunner(calls));
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, CHECK_NAME);
    assert.equal(checks[0].status, "INFO");
    assert.ok(checks[0].detail.startsWith("absent"), checks[0].detail);
    assert.match(checks[0].detail, /only the working tree was inspected/);
    assert.match(checks[0].detail, /HEAD was not checked/);
    assert.equal(calls.length, 0, "git must not be invoked when the working tree has no list");
  });
});

test("Tracked file reports INFO tracked without an entry count", async () => {
  await withRepo(async (dir) => {
    await commitList(dir, "# checks\n\nStart the local database, then run `node --test a.test.mjs`.\n");
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.equal(checks.length, 1, JSON.stringify(checks));
    assert.equal(checks[0].status, "INFO");
    assert.ok(checks[0].detail.includes("tracked"), checks[0].detail);
    assert.doesNotMatch(checks[0].detail, /entries/);
    assert.equal(warnsOf(checks).length, 0);
  });
});

test("Ignored list warns that it will not run", async () => {
  await withRepo(async (dir) => {
    await fs.writeFile(path.join(dir, ".gitignore"), `${LIST_PATH}\n`);
    await writeList(dir, "node --test a.test.mjs\n");
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    const warns = warnsOf(checks);
    assert.equal(warns.length, 1, JSON.stringify(checks));
    assert.ok(warns[0].detail.includes("will NOT run"), warns[0].detail);
    assert.ok(warns[0].detail.includes(`.gitignore:1:${LIST_PATH}`), warns[0].detail);
  });
});

test("Untracked list warns that it will not run", async () => {
  await withRepo(async (dir) => {
    await writeList(dir, "node --test a.test.mjs\n");
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    const warns = warnsOf(checks);
    assert.equal(warns.length, 1, JSON.stringify(checks));
    assert.ok(warns[0].detail.includes("will NOT run"), warns[0].detail);
    assert.ok(warns[0].detail.includes("untracked"), warns[0].detail);
  });
});

test("Staged but uncommitted list warns that it will not run", async () => {
  await withRepo(async (dir) => {
    await writeList(dir, "node --test a.test.mjs\n");
    git(dir, "add", LIST_PATH);
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    const warns = warnsOf(checks);
    assert.equal(warns.length, 1, JSON.stringify(checks));
    assert.ok(warns[0].detail.includes("will NOT run"), warns[0].detail);
    assert.ok(warns[0].detail.includes("not committed"), warns[0].detail);
  });
});

test("Working tree that differs from HEAD warns about uncommitted changes: working-tree content differs", async () => {
  await withRepo(async (dir) => {
    await commitList(dir, "node --test a.test.mjs\n");
    await writeList(dir, "node --test a.test.mjs\nnode --test b.test.mjs\nnode --test c.test.mjs\n");
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.ok(infoOf(checks).detail.includes("tracked"), JSON.stringify(checks));
    const warns = warnsOf(checks);
    assert.equal(warns.length, 1, JSON.stringify(checks));
    assert.ok(warns[0].detail.includes("uncommitted changes"), warns[0].detail);
    assert.match(warns[0].detail, /committed in HEAD/);
    assert.equal(hasWillNotRun(checks), false, JSON.stringify(checks));
  });
});

test("Working tree that differs from HEAD warns about uncommitted changes: removed from the index, file kept", async () => {
  await withRepo(async (dir) => {
    await commitList(dir, "node --test a.test.mjs\nnode --test b.test.mjs\n");
    git(dir, "rm", "--cached", "-q", LIST_PATH);
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.ok(infoOf(checks).detail.includes("tracked"), JSON.stringify(checks));
    const warns = warnsOf(checks);
    assert.equal(warns.length, 1, JSON.stringify(checks));
    assert.ok(warns[0].detail.includes("uncommitted changes"), warns[0].detail);
    assert.match(warns[0].detail, /committed in HEAD/);
    assert.equal(hasWillNotRun(checks), false, JSON.stringify(checks));
  });
});

test("Working tree that differs from HEAD warns about uncommitted changes: index-only change with working tree equal to HEAD has INFO only", async () => {
  await withRepo(async (dir) => {
    const original = "node --test a.test.mjs\n";
    await commitList(dir, original);
    await writeList(dir, "node --test a.test.mjs\nnode --test b.test.mjs\n");
    git(dir, "add", LIST_PATH);
    await writeList(dir, original);
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.equal(checks.length, 1, JSON.stringify(checks));
    assert.equal(checks[0].status, "INFO");
    assert.ok(checks[0].detail.includes("tracked"), checks[0].detail);
    assert.equal(warnsOf(checks).length, 0);
  });
});

// Free-form markdown: whatever the bytes are, a tracked file yields the INFO line and no format WARN.
const ANY_CONTENT_CASES = [
  ["an empty file", ""],
  ["a single line of 2,000 bytes", `${"x".repeat(2000)}\n`],
  ["a line ending with a backslash", "Run the suite \\\n"],
  ["a leading UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# checks\n")])],
  ["bytes that are not valid UTF-8", Buffer.from([0x6e, 0x6f, 0x64, 0x65, 0x20, 0xff, 0xfe, 0x0a])],
  ["a NUL byte", "# checks\nnode\u0000--test\n"],
  ["only comments and blank lines", "# only a comment\n\n   \n"],
];

for (const [label, content] of ANY_CONTENT_CASES) {
  test(`Tracked file reports INFO tracked without an entry count: no format WARN for ${label}`, async () => {
    await withRepo(async (dir) => {
      await commitList(dir, content);
      const checks = inspect(dir);
      assertNoFailOrNameDrift(checks);
      assert.equal(checks.length, 1, JSON.stringify(checks));
      assert.equal(checks[0].status, "INFO");
      assert.ok(checks[0].detail.includes("tracked"), checks[0].detail);
      assert.doesNotMatch(checks[0].detail, /entries|format problem|line\(s\)/);
    });
  });
}

test("The check never fails and never executes list content: sentinel", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-pre-pr-sentinel-"));
  try {
    const sentinel = path.join(tmpRoot, "sentinel-created");
    const content = `node -e "require('node:fs').writeFileSync(process.argv[1], 'x')" "${sentinel}"\ntouch "${sentinel}"\n`;
    const states = [
      ["tracked", async (dir) => { await commitList(dir, content); }],
      ["changed", async (dir) => { await commitList(dir, "echo base\n"); await writeList(dir, content); }],
      ["staged", async (dir) => { await writeList(dir, content); git(dir, "add", LIST_PATH); }],
      ["untracked", async (dir) => { await writeList(dir, content); }],
      ["ignored", async (dir) => { await fs.writeFile(path.join(dir, ".gitignore"), `${LIST_PATH}\n`); await writeList(dir, content); }],
    ];
    const seen = new Set();
    for (const [label, build] of states) {
      await withRepo(async (dir) => {
        await build(dir);
        const calls = [];
        const checks = inspect(dir, recordingRunner(calls));
        assertNoFailOrNameDrift(checks);
        assert.ok(calls.length > 0, `${label}: git must be consulted`);
        for (const call of calls) {
          assert.equal(call[0], "git", `${label}: only git may be invoked`);
          const argv = call.slice(1);
          const index = FIXED_GIT_ARGV.findIndex((fixed) => JSON.stringify(fixed) === JSON.stringify(argv));
          assert.notEqual(index, -1, `${label}: unexpected git argv ${JSON.stringify(argv)}`);
          seen.add(index);
          assert.ok(!argv.join(" ").includes(sentinel), `${label}: list content must not enter an argument`);
        }
      });
      await assert.rejects(fs.access(sentinel), `${label}: list content must never be executed`);
    }
    assert.equal(seen.size, FIXED_GIT_ARGV.length, "every fixed git argv should have been exercised");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("The check never fails and never executes list content: git cannot start", async () => {
  await withRepo(async (dir) => {
    await commitList(dir, "node --test a.test.mjs\n");
    const spawnFailure = { status: null, stdout: "", stderr: "", error: new Error("spawn git ENOENT") };
    const runners = [
      ["spawn error result", () => spawnFailure],
      ["runner throws", () => { throw new Error("spawn git ENOENT"); }],
    ];
    for (const [label, runner] of runners) {
      const checks = inspect(dir, runner);
      assertNoFailOrNameDrift(checks);
      const warns = warnsOf(checks);
      assert.ok(warns.length >= 1, `${label}: ${JSON.stringify(checks)}`);
      assert.ok(warns.some((check) => check.detail.includes("cannot be confirmed")), `${label}: ${JSON.stringify(checks)}`);
      assert.equal(hasWillNotRun(checks), false, `${label}: ${JSON.stringify(checks)}`);
    }
  });
});

test("The check never fails and never executes list content: git exits with a code other than 0 or 1", async () => {
  await withRepo(async (dir) => {
    await writeList(dir, "node --test a.test.mjs\n");
    const failure = (status) => ({ status, stdout: "", stderr: "fatal" });
    const cases = [
      ["diff exits 2 with the list in HEAD", { "ls-tree": { status: 0, stdout: `${LIST_PATH}\n`, stderr: "" }, diff: failure(2) }, /working tree matches HEAD/, false],
      ["ls-files exits 128", { "ls-tree": failure(0), "ls-files": failure(128) }, /tracking or ignore status cannot be confirmed/, true],
      ["check-ignore exits 128", { "ls-tree": failure(0), "ls-files": failure(1), "check-ignore": failure(128) }, /tracking or ignore status cannot be confirmed/, true],
    ];
    for (const [label, results, expected, headMissing] of cases) {
      const checks = inspect(dir, fakeGitRunner(results));
      assertNoFailOrNameDrift(checks);
      assert.ok(warnsOf(checks).some((check) => expected.test(check.detail)), `${label}: ${JSON.stringify(checks)}`);
      assert.equal(hasWillNotRun(checks), headMissing, `${label}: ${JSON.stringify(checks)}`);
    }
  });
});

test("The check never fails and never executes list content: git ended by a signal is not read as exit code 1", async () => {
  await withRepo(async (dir) => {
    await writeList(dir, "node --test a.test.mjs\n");
    const signalled = { status: null, signal: "SIGKILL", stdout: "", stderr: "" };
    const inHead = { status: 0, stdout: `${LIST_PATH}\n`, stderr: "" };
    const notInHead = { status: 0, stdout: "", stderr: "" };
    const exitOne = { status: 1, stdout: "", stderr: "" };
    const cases = [
      ["diff", { "ls-tree": inHead, diff: signalled }, /working tree matches HEAD cannot be confirmed/, /uncommitted changes/],
      ["ls-files", { "ls-tree": notInHead, "ls-files": signalled, "check-ignore": exitOne }, /tracking or ignore status cannot be confirmed/, /is untracked|is ignored by/],
      ["check-ignore", { "ls-tree": notInHead, "ls-files": exitOne, "check-ignore": signalled }, /tracking or ignore status cannot be confirmed/, /is untracked|is ignored by/],
    ];
    for (const [label, results, expected, forbidden] of cases) {
      const checks = inspect(dir, fakeGitRunner(results));
      assertNoFailOrNameDrift(checks);
      const details = warnsOf(checks).map((check) => check.detail);
      assert.ok(details.some((detail) => expected.test(detail)), `${label}: ${JSON.stringify(checks)}`);
      assert.ok(!details.some((detail) => forbidden.test(detail)), `${label}: ${JSON.stringify(checks)}`);
    }
  });
});

test("The check never fails and never executes list content: repository without any commit", async () => {
  await withRepo(async (dir) => {
    await writeList(dir, "node --test a.test.mjs\n");
    git(dir, "add", LIST_PATH);
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    const warns = warnsOf(checks);
    assert.equal(warns.length, 1, JSON.stringify(checks));
    assert.ok(warns[0].detail.includes("cannot be confirmed"), warns[0].detail);
    assert.equal(hasWillNotRun(checks), false, JSON.stringify(checks));
  }, { commit: false });
});

test("The check never fails and never executes list content: will NOT run is absent when the HEAD state cannot be confirmed", async () => {
  await withRepo(async (dir) => {
    await writeList(dir, "node --test a.test.mjs\n");
    const stubs = [
      ["ls-tree exits 128", { "ls-tree": { status: 128, stdout: "", stderr: "fatal" }, "ls-files": { status: 1, stdout: "", stderr: "" }, "check-ignore": { status: 1, stdout: "", stderr: "" } }],
      ["ls-tree cannot start", { "ls-tree": { status: null, stdout: "", stderr: "", error: new Error("spawn git ENOENT") } }],
    ];
    for (const [label, results] of stubs) {
      const checks = inspect(dir, fakeGitRunner(results));
      assertNoFailOrNameDrift(checks);
      assert.ok(warnsOf(checks).length >= 1, `${label}: ${JSON.stringify(checks)}`);
      assert.equal(hasWillNotRun(checks), false, `${label}: ${JSON.stringify(checks)}`);
    }
  });
});

test("The check never fails and never executes list content: an unreadable list degrades to WARN", async () => {
  await withRepo(async (dir) => {
    await fs.mkdir(path.join(dir, ...LIST_PATH.split("/")), { recursive: true });
    const calls = [];
    const checks = inspect(dir, recordingRunner(calls));
    assertNoFailOrNameDrift(checks);
    assert.equal(warnsOf(checks).length, 1, JSON.stringify(checks));
    assert.equal(hasWillNotRun(checks), false, JSON.stringify(checks));
  });
});

const REPORT_TOOL_RUNNER = (command) => ({ status: 127, stdout: "", stderr: `${command} not stubbed` });

async function withConsumerDir(fn) {
  return withRepo(async (dir) => {
    const scriptsDir = path.join(dir, ".devpro-agent-rules", ".devpro", "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(dir, ".devpro-agent-rules", "AGENTS.md"), "# rules\n");
    await fs.writeFile(path.join(scriptsDir, "sync-agent-rules.mjs"), "\n");
    await fs.writeFile(
      path.join(dir, ".gitmodules"),
      ['[submodule ".devpro-agent-rules"]', "\tpath = .devpro-agent-rules", "\tbranch = production", ""].join("\n"),
    );
    return fn(dir);
  });
}

/** Real git for the list check, a fixed answer for `git submodule status`, nothing else. */
function consumerReportRunner(command, args, options) {
  if (command !== "git") return REPORT_TOOL_RUNNER(command);
  if (args[0] === "submodule") return { status: 1, stdout: "", stderr: "" };
  return spawnSync(command, args, { ...options, env: GIT_ENV });
}

test("Source mode has no pre-PR checks entry", async () => {
  const report = await runDoctor({ repoRoot: REPO_ROOT, toolRunner: REPORT_TOOL_RUNNER });
  assert.equal(report.mode, "source");
  assert.ok(
    !report.checks.some((check) => check.name === CHECK_NAME),
    "source mode must not run the pre-PR checks list check"
  );
});

test("Other doctor checks are unaffected by the list", async () => {
  await withConsumerDir(async (dir) => {
    const without = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });
    await writeList(dir, "node --test a.test.mjs\n");
    const withList = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });

    assert.equal(without.mode, "consumer");
    assert.equal(withList.mode, "consumer");
    const named = (report) => report.checks.filter((check) => check.name === CHECK_NAME);
    assert.equal(named(without).length, 1);
    assert.equal(named(without)[0].status, "INFO");
    assert.equal(named(withList).some((check) => check.status === "WARN"), true, "untracked list should warn");
    const others = (report) => report.checks.filter((check) => check.name !== CHECK_NAME);
    assert.deepEqual(others(withList), others(without));
    assert.equal(withList.ok, without.ok);
    assert.ok(
      withList.nextActions.some((action) => action.includes(LIST_PATH) && action.includes("consumer-pre-pr-checks.md §Consumer Pre-PR Checks")),
      withList.nextActions.join("\n")
    );
    assert.ok(!without.nextActions.some((action) => action.includes(LIST_PATH)), without.nextActions.join("\n"));
  });
});
