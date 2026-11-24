import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConsumerPrePrChecks, checkConsumerSecondReviewRules, runDoctor } from "../devpro-doctor.mjs";
import { CONSUMER_PRE_PR_CHECKS_BASENAME, CONSUMER_PRE_PR_CHECKS_REL } from "../lib/consumer-pre-pr-checks.mjs";
import {
  CONSUMER_SECOND_REVIEW_RULES_BASENAME,
  CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES,
  CONSUMER_SECOND_REVIEW_RULES_REL,
} from "../lib/consumer-second-review-rules.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// consumer-adoption-tooling delta (add-consumer-second-review-rules): the doctor
// check for `.devpro/second-review-rules.local.md` (free-form markdown: integrity problems only, no entries). Each state is built in a real
// temporary git repo so the D13 decision table runs against real git
// behavior; the injected `toolRunner` only records calls (and refuses every
// tool except git) or, for the failure paths, fakes the git result.

const CHECK_NAME = CONSUMER_SECOND_REVIEW_RULES_BASENAME;
const LIST_PATH = CONSUMER_SECOND_REVIEW_RULES_REL;
const PRE_PR_PATH = CONSUMER_PRE_PR_CHECKS_REL;
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
  ["ls-files", "--error-unmatch", "--", LIST_PATH],
  ["check-ignore", "-v", "--", LIST_PATH],
];
const STOPS = "consumer_review_rules_invalid";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function withRepo(fn, { commit = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-second-review-rules-"));
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

async function writeAt(dir, rel, content) {
  const full = path.join(dir, ...rel.split("/"));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

const writeList = (dir, content) => writeAt(dir, LIST_PATH, content);

async function commitList(dir, content) {
  const full = await writeList(dir, content);
  git(dir, "add", LIST_PATH);
  git(dir, "commit", "-q", "-m", "add second-review rules list");
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
  return checkConsumerSecondReviewRules(dir, runner);
}

function assertNoFailOrNameDrift(checks) {
  assert.ok(checks.length >= 1, "the check must report at least one entry");
  for (const check of checks) {
    assert.equal(check.name, CHECK_NAME);
    assert.notEqual(check.status, "FAIL", JSON.stringify(check));
  }
}

const hasWillNotApply = (checks) => checks.some((check) => check.detail.includes("will NOT apply"));
const infoOf = (checks) => checks.find((check) => check.status === "INFO");
const warnsOf = (checks) => checks.filter((check) => check.status === "WARN");

// Assembled at run time so this file holds no credential-shaped literal.
const CREDENTIAL_SHAPED = `Connect with ${"pass"}${"word"}=${"Sup3r"}${"S3cret"} first.`;
const SECRET_FRAGMENT = ["Sup3r", "S3cret"].join("");

test("Absent file reports INFO without calling git", async () => {
  await withRepo(async (dir) => {
    const calls = [];
    const checks = inspect(dir, recordingRunner(calls));
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, CHECK_NAME);
    assert.equal(checks[0].status, "INFO");
    assert.ok(checks[0].detail.startsWith("absent"), checks[0].detail);
    assert.match(checks[0].detail, /only the working tree was inspected/);
    assert.equal(calls.length, 0, "git must not be invoked when the working tree has no file");
  });
});

test("Tracked file reports its byte count", async () => {
  await withRepo(async (dir) => {
    const content = `# Rules\n\n${"Keep handlers thin. ".repeat(5)}`.padEnd(120, "x");
    assert.equal(Buffer.byteLength(content), 120);
    await commitList(dir, content);
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.equal(checks.length, 1, JSON.stringify(checks));
    assert.equal(checks[0].status, "INFO");
    assert.ok(checks[0].detail.includes("tracked; 120 bytes"), checks[0].detail);
    assert.doesNotMatch(checks[0].detail, /entries/);
    assert.match(checks[0].detail, /each pull request applies the version on its base commit/);
    assert.equal(warnsOf(checks).length, 0);
  });
});

test("Tracked file reports its byte count: the count is the raw size of the working-tree file, BOM included", async () => {
  await withRepo(async (dir) => {
    await commitList(dir, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Keep handlers thin.\n")]));
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.equal(checks.length, 1, JSON.stringify(checks));
    assert.ok(checks[0].detail.includes("tracked; 23 bytes"), checks[0].detail);
  });
});

test("Ignored file warns that it will not apply", async () => {
  await withRepo(async (dir) => {
    await fs.writeFile(path.join(dir, ".gitignore"), "*.local.md\n");
    await writeList(dir, "Keep handlers thin.\n");
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    const warns = warnsOf(checks);
    assert.equal(warns.length, 1, JSON.stringify(checks));
    assert.ok(warns[0].detail.includes("will NOT apply"), warns[0].detail);
    assert.ok(warns[0].detail.includes(".gitignore:1:*.local.md"), warns[0].detail);
    assert.equal(infoOf(checks), undefined, "an ignored file must not also report tracked");
  });
});

test("Untracked file warns that it will not apply", async () => {
  await withRepo(async (dir) => {
    await writeList(dir, "Keep handlers thin.\n");
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    const warns = warnsOf(checks);
    assert.equal(warns.length, 1, JSON.stringify(checks));
    assert.ok(warns[0].detail.includes("will NOT apply"), warns[0].detail);
    assert.ok(warns[0].detail.includes("untracked"), warns[0].detail);
  });
});

test("Staged but uncommitted file warns that it will not apply", async () => {
  await withRepo(async (dir) => {
    await writeList(dir, "Keep handlers thin.\n");
    git(dir, "add", LIST_PATH);
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    const warns = warnsOf(checks);
    assert.equal(warns.length, 1, JSON.stringify(checks));
    assert.ok(warns[0].detail.includes("will NOT apply"), warns[0].detail);
    assert.ok(warns[0].detail.includes("staged but not committed"), warns[0].detail);
  });
});

const FORMAT_CASES = [
  { code: "invalid-utf8", content: Buffer.from([0x4b, 0x65, 0x65, 0x70, 0x20, 0xff, 0xfe, 0x0a]) },
  { code: "nul-byte", content: "# Rules\nKeep handlers thin.\n\nKeep\u0000small.\n" },
  { code: "credential-shape", content: `# Rules\nKeep handlers thin.\n${CREDENTIAL_SHAPED}\n` },
];

for (const { code, content } of FORMAT_CASES) {
  test(`Integrity problems are reported as blocking warnings: ${code}`, async () => {
    await withRepo(async (dir) => {
      await commitList(dir, content);
      const checks = inspect(dir);
      assertNoFailOrNameDrift(checks);
      assert.equal(hasWillNotApply(checks), false, JSON.stringify(checks));
      assert.ok(infoOf(checks).detail.includes("tracked; "), JSON.stringify(checks));
      const named = warnsOf(checks).filter((check) => check.detail.includes(code));
      assert.equal(named.length, 1, JSON.stringify(checks));
      assert.equal(warnsOf(checks).length, 1, JSON.stringify(checks));
      assert.ok(named[0].detail.includes(STOPS), named[0].detail);
      assert.doesNotMatch(named[0].detail, /consumer-rule\[|line \d|entry/);
      assert.ok(!named[0].detail.includes(SECRET_FRAGMENT), "the file text must not be echoed");
    });
  });
}

test("Integrity problems are reported as blocking warnings: a leading BOM on an otherwise well-formed file is silent", async () => {
  await withRepo(async (dir) => {
    await commitList(dir, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Keep handlers thin.\n")]));
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.equal(checks.length, 1, JSON.stringify(checks));
    assert.equal(checks[0].status, "INFO");
  });
});

test("Integrity problems are reported as blocking warnings: each code is its own WARN", async () => {
  await withRepo(async (dir) => {
    const content = `Keep\u0000small.\n${"x".repeat(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES)}\n`;
    await commitList(dir, content);
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    const warns = warnsOf(checks);
    assert.equal(warns.length, 2, JSON.stringify(checks));
    assert.equal(warns.filter((check) => check.detail.includes("nul-byte")).length, 1);
    assert.equal(warns.filter((check) => check.detail.includes("too-large")).length, 1);
    assert.ok(warns.every((check) => check.detail.includes(STOPS)));
  });
});

test("Integrity problems are reported as blocking warnings: the working-tree version is the one inspected", async () => {
  await withRepo(async (dir) => {
    await commitList(dir, "Keep handlers thin.\n");
    await writeList(dir, Buffer.from([0x4b, 0xff, 0x0a]));
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.ok(infoOf(checks).detail.includes("tracked; 3 bytes"), JSON.stringify(checks));
    assert.equal(warnsOf(checks).filter((check) => check.detail.includes("invalid-utf8")).length, 1, JSON.stringify(checks));
  });
});

test("A file over the size limit is reported: 32769 bytes warns and 32768 bytes does not", async () => {
  await withRepo(async (dir) => {
    await commitList(dir, "x".repeat(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES + 1));
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.ok(infoOf(checks).detail.includes(`tracked; ${CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES + 1} bytes`), JSON.stringify(checks));
    const named = warnsOf(checks).filter((check) => check.detail.includes("too-large"));
    assert.equal(named.length, 1, JSON.stringify(checks));
    assert.ok(named[0].detail.includes(String(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES)), named[0].detail);
    assert.ok(named[0].detail.includes(STOPS), named[0].detail);
  });
  await withRepo(async (dir) => {
    await commitList(dir, "x".repeat(CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES));
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.ok(infoOf(checks).detail.includes(`tracked; ${CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES} bytes`), JSON.stringify(checks));
    assert.equal(warnsOf(checks).length, 0, JSON.stringify(checks));
  });
});

test("Integrity problems are reported as blocking warnings: the builder-only stops are not reported by doctor", async () => {
  await withRepo(async (dir) => {
    // Email- and phone-shaped text is a PII pattern for the builder's line scan, not an integrity problem.
    await commitList(dir, `Ask ${"reviewer.name"}${"@"}example.invalid or call +886 912 345 678 before merging.\n`);
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    assert.equal(checks.length, 1, JSON.stringify(checks));
    assert.equal(checks[0].status, "INFO");
  });
});

test("The check never fails and never throws: only fixed git argv, and list content is never executed", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-second-review-sentinel-"));
  try {
    const sentinel = path.join(tmpRoot, "sentinel-created");
    const content = `node -e "require('node:fs').writeFileSync(process.argv[1], 'x')" "${sentinel}"\ntouch "${sentinel}"\n`;
    const states = [
      ["tracked", async (dir) => { await commitList(dir, content); }],
      ["changed", async (dir) => { await commitList(dir, "Keep handlers thin.\n"); await writeList(dir, content); }],
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

const REPORT_TOOL_RUNNER = (command) => ({ status: 127, stdout: "", stderr: `${command} not stubbed` });

async function withConsumerDir(fn, { commit = true } = {}) {
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
  }, { commit });
}

/** Real git for the list check, a fixed answer for `git submodule status`, nothing else. */
function consumerReportRunner(command, args, options) {
  if (command !== "git") return REPORT_TOOL_RUNNER(command);
  if (args[0] === "submodule") return { status: 1, stdout: "", stderr: "" };
  return spawnSync(command, args, { ...options, env: GIT_ENV });
}

/** The doctor result with the file must have the same `ok` (exit code source) as without it, and no FAIL of its own. */
async function assertDoctorOutcomeUnchanged(dir, build, runner) {
  const without = await runDoctor({ repoRoot: dir, toolRunner: runner });
  await build(dir);
  const withFile = await runDoctor({ repoRoot: dir, toolRunner: runner });
  assert.equal(without.mode, "consumer");
  assert.equal(withFile.ok, without.ok);
  const own = withFile.checks.filter((check) => check.name === CHECK_NAME);
  assert.ok(own.length >= 1, "the consumer report must carry the check");
  assert.ok(own.every((check) => check.status !== "FAIL"), JSON.stringify(own));
  assert.deepEqual(
    withFile.checks.find((check) => check.name === "consumer readiness"),
    without.checks.find((check) => check.name === "consumer readiness")
  );
  return own;
}

test("The check never fails and never throws: the file cannot be read", async () => {
  await withRepo(async (dir) => {
    await fs.mkdir(path.join(dir, ...LIST_PATH.split("/")), { recursive: true });
    const checks = inspect(dir, recordingRunner([]));
    assertNoFailOrNameDrift(checks);
    assert.equal(warnsOf(checks).length, 1, JSON.stringify(checks));
    assert.match(warnsOf(checks)[0].detail, /cannot be read/);
    assert.equal(hasWillNotApply(checks), false, JSON.stringify(checks));
  });
  await withConsumerDir((dir) =>
    assertDoctorOutcomeUnchanged(dir, (d) => fs.mkdir(path.join(d, ...LIST_PATH.split("/")), { recursive: true }), consumerReportRunner)
  );
});

test("The check never fails and never throws: git cannot be run", async () => {
  await withRepo(async (dir) => {
    await commitList(dir, "Keep handlers thin.\n");
    const spawnFailure = { status: null, stdout: "", stderr: "", error: new Error("spawn git ENOENT") };
    const runners = [
      ["spawn error result", () => spawnFailure],
      ["runner throws", () => { throw new Error("spawn git ENOENT"); }],
      ["git ended by a signal", () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "" })],
      ["git exits 128", fakeGitRunner({ "ls-tree": { status: 128, stdout: "", stderr: "fatal" } })],
    ];
    for (const [label, runner] of runners) {
      const checks = inspect(dir, runner);
      assertNoFailOrNameDrift(checks);
      const warns = warnsOf(checks);
      assert.ok(warns.length >= 1, `${label}: ${JSON.stringify(checks)}`);
      assert.ok(warns.some((check) => check.detail.includes("cannot be confirmed")), `${label}: ${JSON.stringify(checks)}`);
      assert.equal(hasWillNotApply(checks), false, `${label}: ${JSON.stringify(checks)}`);
    }
    // The tracking and ignore queries may fail too, without turning the answer into a claim about git state.
    await writeList(dir, "Keep handlers thin.\n");
    const failure = (status) => ({ status, stdout: "", stderr: "fatal" });
    const notInHead = { status: 0, stdout: "", stderr: "" };
    const cases = [
      ["ls-files exits 128", { "ls-tree": notInHead, "ls-files": failure(128) }],
      ["check-ignore exits 128", { "ls-tree": notInHead, "ls-files": failure(1), "check-ignore": failure(128) }],
      ["ls-files ended by a signal", { "ls-tree": notInHead, "ls-files": { status: null, signal: "SIGKILL", stdout: "", stderr: "" } }],
    ];
    for (const [label, results] of cases) {
      const checks = inspect(dir, fakeGitRunner(results));
      assertNoFailOrNameDrift(checks);
      assert.ok(
        warnsOf(checks).some((check) => /tracking or ignore status cannot be confirmed/.test(check.detail)),
        `${label}: ${JSON.stringify(checks)}`
      );
      assert.ok(!warnsOf(checks).some((check) => /is untracked|is ignored by/.test(check.detail)), `${label}: ${JSON.stringify(checks)}`);
    }
  });
  const gitCannotStart = (command, args, options) => (command === "git" ? { status: null, stdout: "", stderr: "", error: new Error("spawn git ENOENT") } : consumerReportRunner(command, args, options));
  await withConsumerDir((dir) => assertDoctorOutcomeUnchanged(dir, (d) => writeList(d, "Keep handlers thin.\n"), gitCannotStart));
});

test("The check never fails and never throws: the repository has no commit", async () => {
  await withRepo(async (dir) => {
    await writeList(dir, "Keep handlers thin.\n");
    git(dir, "add", LIST_PATH);
    const checks = inspect(dir);
    assertNoFailOrNameDrift(checks);
    const warns = warnsOf(checks);
    assert.equal(warns.length, 1, JSON.stringify(checks));
    assert.ok(warns[0].detail.includes("cannot be confirmed"), warns[0].detail);
    assert.equal(hasWillNotApply(checks), false, JSON.stringify(checks));
  }, { commit: false });
  await withConsumerDir(
    (dir) => assertDoctorOutcomeUnchanged(dir, (d) => writeList(d, "Keep handlers thin.\n"), consumerReportRunner),
    { commit: false }
  );
});

test("Source mode does not report the check", async () => {
  const report = await runDoctor({ repoRoot: REPO_ROOT, toolRunner: REPORT_TOOL_RUNNER });
  assert.equal(report.mode, "source");
  assert.ok(!report.checks.some((check) => check.name === CHECK_NAME), "source mode must not run the second-review rules check");
});

test("Other checks are unchanged when the file is absent: every other check reports the same in both fixtures", async () => {
  await withConsumerDir(async (dir) => {
    const without = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });
    await writeList(dir, "Keep handlers thin.\n");
    const withFile = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });

    assert.equal(without.mode, "consumer");
    assert.equal(withFile.mode, "consumer");
    const named = (report) => report.checks.filter((check) => check.name === CHECK_NAME);
    assert.equal(named(without).length, 1);
    assert.equal(named(without)[0].status, "INFO");
    assert.ok(named(without)[0].detail.startsWith("absent"));
    assert.equal(named(withFile).some((check) => check.status === "WARN"), true, "untracked file should warn");
    const others = (report) => report.checks.filter((check) => check.name !== CHECK_NAME);
    assert.deepEqual(others(withFile), others(without));
    assert.equal(withFile.ok, without.ok);
  });
});

test("Other checks are unchanged when the file is absent: the check follows the pre-PR checks entry", async () => {
  await withConsumerDir(async (dir) => {
    const report = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });
    const names = report.checks.map((check) => check.name);
    assert.equal(names.indexOf(CHECK_NAME), names.indexOf(CONSUMER_PRE_PR_CHECKS_BASENAME) + 1, names.join(", "));
  });
});

test("Other checks are unchanged when the file is absent: pre-pr-checks.local.md output is byte-identical", async () => {
  const wrong = (detail) => ({ name: CONSUMER_PRE_PR_CHECKS_BASENAME, status: "WARN", detail });
  const cases = [
    {
      label: "absent",
      build: async () => {},
      expected: [{ name: CONSUMER_PRE_PR_CHECKS_BASENAME, status: "INFO", detail: "absent; only the working tree was inspected, HEAD was not checked" }],
    },
    {
      label: "untracked",
      build: async (dir) => { await writeAt(dir, PRE_PR_PATH, "node --test a.test.mjs\n"); },
      expected: [wrong(`${PRE_PR_PATH} exists but is untracked; pre-PR will NOT run it until it is committed`)],
    },
    {
      label: "staged",
      build: async (dir) => { await writeAt(dir, PRE_PR_PATH, "node --test a.test.mjs\n"); git(dir, "add", PRE_PR_PATH); },
      expected: [wrong(`${PRE_PR_PATH} is staged but not committed; pre-PR will NOT run it until it is committed`)],
    },
    {
      label: "ignored",
      build: async (dir) => {
        await fs.writeFile(path.join(dir, ".gitignore"), "*.local.md\n");
        await writeAt(dir, PRE_PR_PATH, "node --test a.test.mjs\n");
      },
      expected: [wrong(`${PRE_PR_PATH} exists but is ignored by .gitignore:1:*.local.md; pre-PR will NOT run it (the list must be committed)`)],
    },
    {
      label: "tracked",
      build: async (dir) => {
        await writeAt(dir, PRE_PR_PATH, "Run the suite \\\n");
        git(dir, "add", PRE_PR_PATH);
        git(dir, "commit", "-q", "-m", "add pre-PR list");
      },
      expected: [{ name: CONSUMER_PRE_PR_CHECKS_BASENAME, status: "INFO", detail: "tracked" }],
      loose: true,
    },
  ];
  for (const { label, build, expected, loose } of cases) {
    await withRepo(async (dir) => {
      await build(dir);
      // The second-review file's presence must not change the pre-PR output either.
      const before = checkConsumerPrePrChecks(dir, recordingRunner([]));
      await writeList(dir, "Keep handlers thin.\n");
      const after = checkConsumerPrePrChecks(dir, recordingRunner([]));
      assert.deepEqual(after, before, label);
      if (loose) {
        // Wording after `tracked` belongs to the pre-PR contract; only its shape is pinned here.
        assert.equal(after.length, expected.length, label);
        assert.equal(after[0].status, "INFO", label);
        assert.ok(after[0].detail.startsWith("tracked"), label);
      } else {
        assert.deepEqual(after, expected, label);
      }
    });
  }
});
