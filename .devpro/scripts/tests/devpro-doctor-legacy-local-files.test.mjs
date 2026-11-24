import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkLegacyConsumerLocalFiles, runDoctor } from "../devpro-doctor.mjs";

// Consumers that still carry a `.local` file whose feature was removed would otherwise be
// silently ignored (sync never deletes consumer files). The doctor tells them once.

const LEGACY_FILES = [
  { name: "cross-model-skip-paths.local", rel: ".devpro/cross-model-skip-paths.local", action: /delete/i, replacement: null },
  { name: "pre-pr-checks.local", rel: ".devpro/pre-pr-checks.local", action: /rename/i, replacement: ".devpro/pre-pr-checks.local.md" },
  { name: "second-review-rules.local", rel: ".devpro/second-review-rules.local", action: /rename/i, replacement: ".devpro/second-review-rules.local.md" },
];
const SKIP_PATHS = LEGACY_FILES[0];
const CHECK_NAME = SKIP_PATHS.name;
const LEGACY_PATH = SKIP_PATHS.rel;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const REPORT_TOOL_RUNNER = (command) => ({ status: 127, stdout: "", stderr: `${command} not stubbed` });

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

async function withConsumerDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-legacy-local-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    await fs.writeFile(path.join(dir, "README.md"), "fixture\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "fixture base");
    const scriptsDir = path.join(dir, ".devpro-agent-rules", ".devpro", "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(dir, ".devpro-agent-rules", "AGENTS.md"), "# rules\n");
    await fs.writeFile(path.join(scriptsDir, "sync-agent-rules.mjs"), "\n");
    await fs.writeFile(
      path.join(dir, ".gitmodules"),
      ['[submodule ".devpro-agent-rules"]', "\tpath = .devpro-agent-rules", "\tbranch = production", ""].join("\n"),
    );
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeLegacy(dir, content = "docs/**\n", rel = LEGACY_PATH) {
  const full = path.join(dir, ...rel.split("/"));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

/** Real git for the repo, a fixed answer for `git submodule status`, nothing else. */
function consumerReportRunner(command, args, options) {
  if (command !== "git") return REPORT_TOOL_RUNNER(command);
  if (args[0] === "submodule") return { status: 1, stdout: "", stderr: "" };
  return spawnSync(command, args, { ...options, env: GIT_ENV });
}

// [Scenario: consumer-adoption-tooling :: Absent file and source mode produce no check]
test("An absent legacy file produces no check at all", async () => {
  await withConsumerDir(async (dir) => {
    assert.deepEqual(checkLegacyConsumerLocalFiles(dir), []);
  });
});

// [Scenario: consumer-adoption-tooling :: Stale skip-paths file warns once and is never read]
test("A present cross-model-skip-paths.local is a WARN that says it is no longer read and should be deleted", async () => {
  await withConsumerDir(async (dir) => {
    await writeLegacy(dir);
    const checks = checkLegacyConsumerLocalFiles(dir);
    assert.equal(checks.length, 1, JSON.stringify(checks));
    assert.equal(checks[0].name, CHECK_NAME);
    assert.equal(checks[0].status, "WARN");
    assert.match(checks[0].detail, /no longer read/);
    assert.match(checks[0].detail, /delete/i);
    assert.ok(checks[0].detail.includes(LEGACY_PATH), checks[0].detail);
    assert.ok(!checks.some((check) => check.status === "FAIL"));
  });
});

// [Scenario: consumer-adoption-tooling :: Stale skip-paths file warns once and is never read]
test("Detection never opens the path: a directory at the legacy path still yields one WARN and does not throw", async () => {
  await withConsumerDir(async (dir) => {
    await fs.mkdir(path.join(dir, ...LEGACY_PATH.split("/")), { recursive: true });
    const checks = checkLegacyConsumerLocalFiles(dir);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, "WARN");
    assert.equal(checks[0].name, CHECK_NAME);
  });
});

test("The legacy file content is irrelevant: an empty file still warns", async () => {
  await withConsumerDir(async (dir) => {
    await writeLegacy(dir, "");
    assert.equal(checkLegacyConsumerLocalFiles(dir).length, 1);
  });
});

test("runDoctor in consumer mode surfaces the WARN, keeps ok, and adds a removal next action", async () => {
  await withConsumerDir(async (dir) => {
    const without = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });
    await writeLegacy(dir);
    const withLegacy = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });

    assert.equal(withLegacy.mode, "consumer");
    const named = (report) => report.checks.filter((check) => check.name === CHECK_NAME);
    assert.equal(named(without).length, 0);
    assert.equal(named(withLegacy).length, 1);
    assert.equal(named(withLegacy)[0].status, "WARN");
    assert.equal(withLegacy.ok, without.ok, "an advisory WARN must never change ok");
    const others = (report) => report.checks.filter((check) => check.name !== CHECK_NAME);
    assert.deepEqual(others(withLegacy), others(without));
    assert.ok(
      withLegacy.nextActions.some((action) => action.includes(LEGACY_PATH) && /delete/i.test(action)),
      withLegacy.nextActions.join("\n"),
    );
    assert.ok(!without.nextActions.some((action) => action.includes(LEGACY_PATH)), without.nextActions.join("\n"));
  });
});

// [Scenario: consumer-adoption-tooling :: Absent file and source mode produce no check]
test("Source mode never reports the legacy file even when the file exists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-legacy-source-"));
  try {
    await writeLegacy(dir);
    const report = await runDoctor({ repoRoot: dir, toolRunner: REPORT_TOOL_RUNNER });
    assert.equal(report.mode, "source");
    assert.ok(!report.checks.some((check) => check.name === CHECK_NAME), JSON.stringify(report.checks));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// [Scenario: consumer-adoption-tooling :: Stale skip-paths file warns once and is never read]
for (const { name, rel } of LEGACY_FILES) {
  test(`${name}: one WARN that says it is no longer read and names its path; a directory at the path still warns once`, async () => {
    await withConsumerDir(async (dir) => {
      await writeLegacy(dir, "node --test a.test.mjs\n", rel);
      const checks = checkLegacyConsumerLocalFiles(dir);
      assert.equal(checks.length, 1, JSON.stringify(checks));
      assert.equal(checks[0].name, name);
      assert.equal(checks[0].status, "WARN");
      assert.match(checks[0].detail, /no longer read/);
      assert.ok(checks[0].detail.includes(rel), checks[0].detail);
    });
    await withConsumerDir(async (dir) => {
      await fs.mkdir(path.join(dir, ...rel.split("/")), { recursive: true });
      const checks = checkLegacyConsumerLocalFiles(dir);
      assert.equal(checks.length, 1);
      assert.equal(checks[0].name, name);
      assert.equal(checks[0].status, "WARN");
    });
  });
}

// [Scenario: consumer-adoption-tooling :: Legacy file warnings tell the developer to delete or rename]
test("Each legacy file WARN and next action says delete (skip-paths) or rename to the .local.md path (the two lists)", async () => {
  await withConsumerDir(async (dir) => {
    const without = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });
    for (const { rel } of LEGACY_FILES) await writeLegacy(dir, "x\n", rel);
    const report = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });

    assert.equal(report.ok, without.ok, "an advisory WARN must never change ok");
    for (const { name, rel, action, replacement } of LEGACY_FILES) {
      const named = report.checks.filter((check) => check.name === name);
      assert.equal(named.length, 1, name);
      assert.equal(named[0].status, "WARN");
      assert.match(named[0].detail, action);
      if (replacement) {
        assert.ok(named[0].detail.includes(replacement), named[0].detail);
      } else {
        assert.doesNotMatch(named[0].detail, /rename/i);
      }
      const actions = report.nextActions.filter((text) => text.includes(rel) && action.test(text) && (!replacement || text.includes(replacement)));
      assert.equal(actions.length, 1, `${rel}: ${report.nextActions.join("\n")}`);
    }
    assert.ok(!report.nextActions.some((text) => /rename/i.test(text) && text.includes(SKIP_PATHS.rel)), report.nextActions.join("\n"));
  });
});

// [Scenario: consumer-adoption-tooling :: A legacy file next to its renamed file reports both independently]
test("A legacy file next to its renamed file reports both independently", async () => {
  await withConsumerDir(async (dir) => {
    const renamed = [".devpro/pre-pr-checks.local.md", ".devpro/second-review-rules.local.md"];
    for (const rel of renamed) await writeLegacy(dir, "# Notes\n", rel);
    git(dir, "add", ...renamed);
    git(dir, "commit", "-q", "-m", "add renamed files");

    const sameCheck = (report, name) => report.checks.filter((check) => check.name === name);
    const without = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });
    await writeLegacy(dir, "node --test a.test.mjs\n", ".devpro/pre-pr-checks.local");
    await writeLegacy(dir, "Keep handlers thin.\n", ".devpro/second-review-rules.local");
    const withLegacy = await runDoctor({ repoRoot: dir, toolRunner: consumerReportRunner });

    for (const name of ["pre-pr-checks.local", "second-review-rules.local"]) {
      assert.equal(sameCheck(withLegacy, name).length, 1, name);
      assert.equal(sameCheck(withLegacy, name)[0].status, "WARN");
      assert.match(sameCheck(withLegacy, name)[0].detail, /already exists, merge what you still need into it and delete/, `${name}: git mv is refused when the new file exists, so the WARN says what to do instead`);
    }
    for (const name of ["pre-pr-checks.local.md", "second-review-rules.local.md"]) {
      assert.deepEqual(sameCheck(withLegacy, name), sameCheck(without, name));
      assert.ok(sameCheck(withLegacy, name).length >= 1, name);
    }
  });
});
