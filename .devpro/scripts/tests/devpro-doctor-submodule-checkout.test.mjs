import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "../devpro-doctor.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// Consumer clones that did not run the rules sync (a cloud routine, a teammate's
// clone, a second machine) keep a stale `.devpro-agent-rules` checkout after
// `git pull`: git does not move a submodule to the new gitlink by itself. The
// doctor reports that read-only. A bare consumer layout is enough here — a
// submodule root carrying AGENTS.md and the sync script switches runDoctor to
// consumer mode, and these tests assert only on the `submodule checkout` check
// and its next action.

const SUBMODULE_UPDATE = "git submodule update --init .devpro-agent-rules";

async function withConsumerDir(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-submodule-checkout-"));
  try {
    const scriptsDir = path.join(tmpDir, ".devpro-agent-rules", ".devpro", "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".devpro-agent-rules", "AGENTS.md"), "# rules\n");
    await fs.writeFile(path.join(scriptsDir, "sync-agent-rules.mjs"), "\n");
    await fs.writeFile(
      path.join(tmpDir, ".gitmodules"),
      ['[submodule ".devpro-agent-rules"]', "\tpath = .devpro-agent-rules", "\tbranch = production", ""].join("\n"),
    );
    return await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function runnerWithSubmoduleStatus(statusResult, calls = []) {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "submodule" && args[1] === "status") return statusResult;
    return { status: 127, stdout: "", stderr: `${command} not stubbed` };
  };
}

const checkOf = (report) => report.checks.find((check) => check.name === "submodule checkout");
const sha = "0123456789abcdef0123456789abcdef01234567";

for (const prefix of ["+", "-", "U"]) {
  test(`doctor warns when the submodule checkout status starts with "${prefix}" and names the update command`, async () => {
    await withConsumerDir(async (tmpDir) => {
      const report = await runDoctor({
        repoRoot: tmpDir,
        toolRunner: runnerWithSubmoduleStatus({
          status: 0,
          stdout: `${prefix}${sha} .devpro-agent-rules (production-v6.95.0)\n`,
          stderr: "",
        }),
      });
      assert.equal(report.mode, "consumer");
      const check = checkOf(report);
      assert.ok(check, "a `submodule checkout` check must be reported in consumer mode");
      assert.equal(check.status, "WARN");
      assert.ok(check.detail.includes(`"${prefix}"`), check.detail);
      assert.ok(
        report.nextActions.some((action) => action.includes(SUBMODULE_UPDATE) && /do not commit/i.test(action)),
        report.nextActions.join("\n"),
      );
    });
  });
}

test("doctor reports an aligned submodule checkout (leading space) as OK without a next action", async () => {
  await withConsumerDir(async (tmpDir) => {
    const report = await runDoctor({
      repoRoot: tmpDir,
      toolRunner: runnerWithSubmoduleStatus({
        status: 0,
        stdout: ` ${sha} .devpro-agent-rules (production-v6.98.0)\n`,
        stderr: "",
      }),
    });
    const check = checkOf(report);
    assert.ok(check);
    assert.equal(check.status, "OK");
    assert.ok(!report.nextActions.some((action) => action.includes(SUBMODULE_UPDATE)));
  });
});

test("doctor never turns an unverifiable submodule status into a warning", async () => {
  const unavailable = [
    { status: 127, stdout: "", stderr: "git not found" },
    { status: 128, stdout: "", stderr: "fatal: not a git repository" },
    { status: 0, stdout: "", stderr: "" },
  ];
  for (const result of unavailable) {
    await withConsumerDir(async (tmpDir) => {
      const report = await runDoctor({ repoRoot: tmpDir, toolRunner: runnerWithSubmoduleStatus(result) });
      const check = checkOf(report);
      assert.ok(check, `status=${result.status}`);
      assert.equal(check.status, "INFO", `status=${result.status}: ${check.detail}`);
      assert.ok(!report.nextActions.some((action) => action.includes(SUBMODULE_UPDATE)));
    });
  }
});

test("doctor only reads the submodule status; it never runs the update itself", async () => {
  await withConsumerDir(async (tmpDir) => {
    const calls = [];
    await runDoctor({
      repoRoot: tmpDir,
      toolRunner: runnerWithSubmoduleStatus({ status: 0, stdout: `+${sha} .devpro-agent-rules (x)\n`, stderr: "" }, calls),
    });
    const gitCalls = calls.filter(([command]) => command === "git");
    assert.deepEqual(gitCalls, [["git", "submodule", "status", ".devpro-agent-rules"]]);
  });
});

test("doctor does not probe the submodule checkout in source mode", async () => {
  const calls = [];
  const report = await runDoctor({ repoRoot: REPO_ROOT, toolRunner: runnerWithSubmoduleStatus({ status: 0, stdout: "", stderr: "" }, calls) });
  assert.equal(report.mode, "source");
  assert.equal(checkOf(report), undefined);
  assert.ok(!calls.some(([command, sub]) => command === "git" && sub === "submodule"));
});
