import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runOpenCodePrimaryReview, readPrimaryReviewVerdict } from "../lib/opencode-primary-review.mjs";
import * as primaryModule from "../lib/opencode-primary-review.mjs";
import { MAX_REVIEWER_OUTPUT_LINE_BYTES, terminateProcessTree } from "../lib/reviewer-process-guard.mjs";
import { parsePrimaryReviewArgs, runPrimaryReviewCli } from "../run-opencode-primary-review.mjs";
import portableCommandShims from "./lib/portable-command-shims.cjs";
import { repoPath } from "./lib/repo-root.mjs";

// The ordinary-primary route runs the real shared library against a fake `opencode` that only
// reports what it was given; the library must prove model, input and report from the export.
const TARGET = "local diff";
const DISPATCH = "dispatch-primary-0001";
const FINDING = "F-primary-1";

function writeFakeOpenCode(binDir) {
  const helperHref = pathToFileURL(repoPath(".devpro/scripts/tests/lib/portable-fake-reviewer-cli.mjs")).href;
  const fake = path.join(binDir, "opencode");
  writeFileSync(fake, `#!/usr/bin/env node\n`
    + `import(${JSON.stringify(helperHref)})\n`
    + `.then((helpers) => helpers.runFakeOpenCode())\n`
    + `.catch((error) => { console.error(error); process.exitCode = 1; });\n`, "utf8");
  chmodSync(fake, 0o755);
  if (process.platform === "win32") writeFileSync(`${fake}.exe`, "DevPro Windows test resolver marker\n", "utf8");
}

function assessmentSection(assessments, { target = TARGET, dispatch = DISPATCH } = {}) {
  return "## Guarantee Assessment\n```json\n"
    + JSON.stringify({ schema: "devpro.review-guarantee-assessment/v1", reviewed_target: target, dispatch_id: dispatch, assessments })
    + "\n```\n";
}

function report({ verdict, findings = [], assessment }) {
  const lines = ["## 六軸審查", "", "### 軸 1: 正確性"];
  for (const { severity, id } of findings) {
    lines.push(`- **[${severity}]** \`[finding_id:${id}] [observation_hash_sha256:${"a".repeat(64)}]\` 發現說明`);
  }
  lines.push("", "## 總判定", `**${verdict}**`, "");
  if (assessment !== undefined) lines.push(assessment);
  return lines.join("\n");
}

const withinCeiling = (id) => ({
  finding_id: id,
  guarantee_ceiling: "cooperative review; mechanical shape checks",
  classification: "within-ceiling",
  rationale: "An ordinary omission is within the promised review.",
});

async function withFixture(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-primary-review-"));
  try {
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeOpenCode(binDir);
    const repoRoot = path.join(dir, "repo");
    mkdirSync(repoRoot);
    const tmpRoot = path.join(dir, "tmp");
    mkdirSync(tmpRoot);
    return await fn({ dir, binDir, repoRoot, tmpRoot });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function envFor(fixture, extra = {}) {
  return {
    ...process.env,
    PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH}`,
    ...(process.platform === "win32"
      ? { NODE_OPTIONS: portableCommandShims.appendPreload(process.env.NODE_OPTIONS, repoPath(".devpro/scripts/tests/lib/portable-command-shims.cjs")) }
      : {}),
    DEVPRO_FAKE_OPENCODE_STATE_DIR: path.join(fixture.dir, "fake-state"),
    ...extra,
  };
}

function review(fixture, reportText, extraEnv = {}, options = {}) {
  return runOpenCodePrimaryReview({
    promptBytes: Buffer.from("review the local diff\n", "utf8"),
    repoRoot: fixture.repoRoot,
    reviewedTarget: TARGET,
    dispatchId: DISPATCH,
    tmpRoot: fixture.tmpRoot,
    env: envFor(fixture, { DEVPRO_FAKE_OPENCODE_REPORT: reportText, ...extraEnv }),
    ...options,
  });
}

test("primary: a clean report with its assessment is finished, unsealed and read-only", async () => {
  await withFixture(async (fixture) => {
    const text = report({ verdict: "finished", assessment: assessmentSection([]) });
    const copy = path.join(fixture.dir, "launch-copy.json");
    const log = path.join(fixture.dir, "invocations.log");
    const outcome = await review(fixture, text, {
      DEVPRO_FAKE_OPENCODE_TOOL_USE: "read,glob",
      DEVPRO_FAKE_OPENCODE_CONFIG_COPY: copy,
      DEVPRO_FAKE_OPENCODE_INVOCATION_LOG: log,
    });
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    assert.equal(outcome.executor, "opencode-cli");
    assert.equal(outcome.sealed_admission, false);
    assert.equal(outcome.report_text, text);
    assert.equal(outcome.observed_selector, "deepseek/deepseek-v4-pro");
    assert.deepEqual(outcome.guarantee_assessment, { next_actions: [], requires_tl_ruling: false, requires_clarification: false });

    // read-only: only read-class actions plus the review root; no edit, no shell
    const rules = JSON.parse(readFileSync(copy, "utf8")).agents["devpro-review-primary"].permissions;
    assert.ok(rules.some((rule) => rule.action === "external_directory" && rule.resource === `${fixture.repoRoot}/*` && rule.effect === "allow"));
    assert.ok(!rules.some((rule) => ["edit", "shell"].includes(rule.action) && rule.effect === "allow"));
    const line = readFileSync(log, "utf8").trim();
    assert.match(line, /^run --standalone --format json --agent devpro-review-primary --model deepseek\/deepseek-v4-pro#max\t/u);
    assert.ok(line.includes("project_config_disabled=1"));
    assert.ok(!line.includes(`cwd=${fixture.repoRoot}\t`), "the review must not run inside the candidate repository");
    assert.deepEqual(readFileSync(path.join(fixture.dir, "fake-state", "count"), "utf8").trim(), "1");
    assert.deepEqual(readdirSync(fixture.tmpRoot), [], "the private work dir must be removed");
  });
});

test("primary: the verdict follows the listed findings (Critical blocked, Important partial)", async () => {
  await withFixture(async (fixture) => {
    const partial = await review(fixture, report({
      verdict: "partial",
      findings: [{ severity: "Important", id: FINDING }],
      assessment: assessmentSection([withinCeiling(FINDING)]),
    }));
    assert.equal(partial.status, "partial", JSON.stringify(partial));
    assert.deepEqual(partial.finding_ids, [FINDING]);
    assert.deepEqual(partial.guarantee_assessment.next_actions, [{ finding_id: FINDING, action: "apply-existing-finding-rules" }]);

    // a blocking review stays blocked even with no usable assessment
    const blocked = await review(fixture, report({ verdict: "blocked", findings: [{ severity: "Critical", id: FINDING }] }));
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.equal(blocked.guarantee_assessment, null);
  });
});

test("primary: a verdict that contradicts the findings, or a missing assessment, is a contract failure", async () => {
  await withFixture(async (fixture) => {
    const contradiction = await review(fixture, report({
      verdict: "finished",
      findings: [{ severity: "Critical", id: FINDING }],
      assessment: assessmentSection([withinCeiling(FINDING)]),
    }));
    assert.equal(contradiction.status, "failed");
    assert.equal(contradiction.classification, "primary_report_contract_invalid");

    const missing = await review(fixture, report({ verdict: "finished" }));
    assert.equal(missing.status, "failed");
    assert.equal(missing.classification, "primary_assessment_invalid");

    const wrongDispatch = await review(fixture, report({ verdict: "finished", assessment: assessmentSection([], { dispatch: "dispatch-other" }) }));
    assert.equal(wrongDispatch.classification, "primary_assessment_invalid");

    const uncovered = await review(fixture, report({
      verdict: "partial",
      findings: [{ severity: "Important", id: FINDING }],
      assessment: assessmentSection([]),
    }));
    assert.equal(uncovered.classification, "primary_assessment_invalid");
  });
});

test("primary: a security-shaped Critical line decides the verdict even without a finding id", () => {
  const securityCritical = "## Security Review\n- SQL injection: **Critical**: `a.cs:10` 字串拼接\n- PII: **OK**\n\n## 總判定\n";
  assert.equal(readPrimaryReviewVerdict(`${securityCritical}**finished**\n`).ok, false);
  assert.equal(readPrimaryReviewVerdict(`${securityCritical}**partial**\n`).ok, false);
  assert.equal(readPrimaryReviewVerdict(`${securityCritical}**blocked**\n`).verdict, "blocked");
  assert.equal(readPrimaryReviewVerdict("## Security Review\n- SQL injection: **OK**\n\n## 總判定\n**finished**\n").verdict, "finished");
});

test("primary: the report verdict reader rejects zero, multiple or conflicting verdicts", () => {
  assert.equal(readPrimaryReviewVerdict("no verdict here").ok, false);
  assert.equal(readPrimaryReviewVerdict("## 總判定\n**finished** / **blocked**\n").ok, false);
  assert.equal(readPrimaryReviewVerdict("## 總判定\n**finished**\n## 總判定\n**finished**\n").ok, false);
  assert.equal(readPrimaryReviewVerdict("## 總判定\n**partial**\n").ok, false, "partial without an Important finding is the empty-array guard");
  assert.deepEqual(readPrimaryReviewVerdict("## 總判定\n**finished**\n"), { ok: true, verdict: "finished", finding_ids: [] });
});

test("primary: an export that does not prove the model or the report voids the review", async () => {
  await withFixture(async (fixture) => {
    const text = report({ verdict: "finished", assessment: assessmentSection([]) });
    for (const [extra, adapter] of [
      [{ DEVPRO_FAKE_OPENCODE_EXPORT_MODEL: "deepseek/deepseek-v4-flash" }, "opencode_model_provenance_mismatch"],
      [{ DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "wrong-report" }, "opencode_report_mismatch"],
      [{ DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "wrong-input" }, "opencode_input_binding_mismatch"],
      // #3624: export output with no JSON is no usable export; JSON that is not a session stays malformed.
      [{ DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "malformed" }, "opencode_export_unavailable"],
      [{ DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "bad-schema" }, "opencode_export_malformed"],
      [{ DEVPRO_FAKE_OPENCODE_EXPORT_MODE: "unavailable" }, "opencode_export_unavailable"],
    ]) {
      const outcome = await review(fixture, text, extra);
      assert.equal(outcome.status, "failed", adapter);
      assert.equal(outcome.classification, "reviewer_model_provenance_unverified", adapter);
      assert.equal(outcome.adapter_classification, adapter);
      assert.equal(outcome.report_text, undefined, "an unproven report must not be handed to the consumer");
    }
  });
});

test("primary: a tool outside the read-only policy stops the review before any export", async () => {
  await withFixture(async (fixture) => {
    const text = report({ verdict: "finished", assessment: assessmentSection([]) });
    for (const tool of ["write", "shell", "webfetch", "grep"]) {
      const outcome = await review(fixture, text, { DEVPRO_FAKE_OPENCODE_TOOL_USE: tool });
      assert.equal(outcome.status, "failed", tool);
      assert.equal(outcome.classification, "opencode_tool_surface_violation", tool);
    }
  });
});

test("primary: a missing CLI, an unusable exit and bad input fail closed", async () => {
  await withFixture(async (fixture) => {
    const text = report({ verdict: "finished", assessment: assessmentSection([]) });
    const missing = await runOpenCodePrimaryReview({
      promptBytes: Buffer.from("x"), repoRoot: fixture.repoRoot, reviewedTarget: TARGET, dispatchId: DISPATCH,
      tmpRoot: fixture.tmpRoot, env: { PATH: path.join(fixture.dir, "empty") },
    });
    assert.equal(missing.classification, "opencode_cli_unavailable");

    const exit = await review(fixture, text, { DEVPRO_FAKE_OPENCODE_RUN_EXIT_CODE: "3" });
    assert.equal(exit.classification, "opencode_run_failed");

    for (const input of [
      { promptBytes: Buffer.alloc(0) },
      { repoRoot: "relative/path" },
      { reviewedTarget: " " },
      { dispatchId: "" },
    ]) {
      const bad = await runOpenCodePrimaryReview({
        promptBytes: Buffer.from("x"), repoRoot: fixture.repoRoot, reviewedTarget: TARGET, dispatchId: DISPATCH,
        tmpRoot: fixture.tmpRoot, env: envFor(fixture), ...input,
      });
      assert.equal(bad.classification, "opencode_primary_input_invalid");
    }
  });
});

test("primary cli: arguments are strict and the report is written to --out, not printed", async () => {
  assert.throws(() => parsePrimaryReviewArgs(["--prompt", "p"]), /usage/);
  assert.throws(() => parsePrimaryReviewArgs(["--prompt", "p", "--prompt", "q", "--repo-root", "r", "--target", "t", "--dispatch", "d", "--out", "o"]), /usage/);
  assert.throws(() => parsePrimaryReviewArgs(["--bogus", "x"]), /usage/);

  await withFixture(async (fixture) => {
    const text = report({ verdict: "finished", assessment: assessmentSection([]) });
    const promptPath = path.join(fixture.dir, "prompt.md");
    const outPath = path.join(fixture.dir, "report.md");
    writeFileSync(promptPath, "review the local diff\n");
    const summary = await runPrimaryReviewCli(
      ["--prompt", promptPath, "--repo-root", fixture.repoRoot, "--target", TARGET, "--dispatch", DISPATCH, "--out", outPath],
      { tmpRoot: fixture.tmpRoot, env: envFor(fixture, { DEVPRO_FAKE_OPENCODE_REPORT: text }) },
    );
    assert.equal(summary.status, "finished");
    assert.equal(summary.report_text, undefined);
    assert.equal(summary.report_path, outPath);
    assert.equal(readFileSync(outPath, "utf8"), text);
  });
});

test("primary: the outcome names the CLI version, provider and model, and carries the raw events; old keys stay", async () => {
  await withFixture(async (fixture) => {
    const outcome = await review(fixture, report({ verdict: "finished", assessment: assessmentSection([]) }));
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    for (const key of ["status", "classification", "reason", "executor", "sealed_admission", "session_id", "observed_selector",
      "report_text", "verdict", "finding_ids", "guarantee_assessment"]) {
      assert.ok(Object.hasOwn(outcome, key), `existing key ${key} must stay`);
    }
    assert.equal(outcome.cli_version, "2.0.24");
    assert.equal(outcome.provider_id, "deepseek");
    assert.equal(outcome.model_id, "deepseek-v4-pro");
    assert.equal(`${outcome.provider_id}/${outcome.model_id}`, outcome.observed_selector);
    assert.equal(typeof outcome.events_text, "string");
    assert.ok(outcome.events_text.length > 0);
    assert.ok(outcome.events_text.split("\n").every((line) => { try { JSON.parse(line); return true; } catch { return false; } }), "events are ndjson");
  });
});

test("primary: a failure after the run also keeps the events for the operator", async () => {
  await withFixture(async (fixture) => {
    const outcome = await review(fixture, report({ verdict: "finished" })); // no assessment -> contract failure
    assert.equal(outcome.classification, "primary_assessment_invalid");
    assert.equal(outcome.cli_version, "2.0.24");
    assert.equal(typeof outcome.events_text, "string");
  });
});

test("primary: instruction files reach the launch config as absolute paths; relative ones are refused up front", async () => {
  await withFixture(async (fixture) => {
    const text = report({ verdict: "finished", assessment: assessmentSection([]) });
    const copy = path.join(fixture.dir, "launch-copy.json");
    const rule = path.join(fixture.dir, "rules", "code-review-checklist.md");
    const outcome = await runOpenCodePrimaryReview({
      promptBytes: Buffer.from("review the local diff\n", "utf8"),
      repoRoot: fixture.repoRoot,
      reviewedTarget: TARGET,
      dispatchId: DISPATCH,
      tmpRoot: fixture.tmpRoot,
      instructionFiles: [rule],
      env: envFor(fixture, { DEVPRO_FAKE_OPENCODE_REPORT: text, DEVPRO_FAKE_OPENCODE_CONFIG_COPY: copy }),
    });
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    assert.deepEqual(JSON.parse(readFileSync(copy, "utf8")).instructions, [rule]);

    const bad = await runOpenCodePrimaryReview({
      promptBytes: Buffer.from("x"), repoRoot: fixture.repoRoot, reviewedTarget: TARGET, dispatchId: DISPATCH,
      tmpRoot: fixture.tmpRoot, instructionFiles: ["relative.md"], env: envFor(fixture),
    });
    assert.equal(bad.classification, "opencode_primary_input_invalid");
  });
});

test("primary cli: repeatable --instruction and one optional --events-out; events go to the file, not the summary", async () => {
  const base = ["--prompt", "p", "--repo-root", "r", "--target", "t", "--dispatch", "d", "--out", "o"];
  const parsed = parsePrimaryReviewArgs([...base, "--instruction", "/a.md", "--instruction", "/b.md", "--events-out", "e"]);
  assert.deepEqual(parsed.instructionFiles, [path.resolve("/a.md"), path.resolve("/b.md")]);
  assert.equal(parsed.eventsPath, path.resolve("e"));
  assert.deepEqual(parsePrimaryReviewArgs(base).instructionFiles, []);
  assert.equal(parsePrimaryReviewArgs(base).eventsPath, null);
  assert.throws(() => parsePrimaryReviewArgs([...base, "--events-out", "e", "--events-out", "f"]), /usage/);
  assert.throws(() => parsePrimaryReviewArgs([...base, "--instruction"]), /usage/);

  await withFixture(async (fixture) => {
    const text = report({ verdict: "finished", assessment: assessmentSection([]) });
    const promptPath = path.join(fixture.dir, "prompt.md");
    const outPath = path.join(fixture.dir, "report.md");
    const eventsPath = path.join(fixture.dir, "events.ndjson");
    writeFileSync(promptPath, "review the local diff\n");
    const summary = await runPrimaryReviewCli(
      ["--prompt", promptPath, "--repo-root", fixture.repoRoot, "--target", TARGET, "--dispatch", DISPATCH, "--out", outPath, "--events-out", eventsPath],
      { tmpRoot: fixture.tmpRoot, env: envFor(fixture, { DEVPRO_FAKE_OPENCODE_REPORT: text }) },
    );
    assert.equal(summary.status, "finished");
    assert.equal(summary.events_text, undefined, "raw events never travel on the summary line");
    assert.equal(summary.events_path, eventsPath);
    assert.equal(summary.cli_version, "2.0.24");
    assert.ok(readFileSync(eventsPath, "utf8").length > 0);
  });
});

// ---- output bounds and process-tree cleanup (cross-model review W2-F1 / W2-F2 / W2-F3)

const POSIX = process.platform !== "win32";
const cleanReport = () => report({ verdict: "finished", assessment: assessmentSection([]) });

async function waitUntilGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return true; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function readDescendantPid(file) {
  assert.ok(existsSync(file), "the fake reviewer must have started its descendant");
  return Number(readFileSync(file, "utf8").trim());
}

// The OpenCode stdout has its own line bound (512 KiB), apart from the 64 KiB of stderr and of the second-review wrapper:
// OpenCode writes one JSON event per line and a `read` event carries the file content twice (state.output and
// state.metadata.content), so a healthy review can pass 64 KiB in one line (a 108,328-byte event failed a real review).
// The 524,289th byte of a live stdout line fails the run closed. The contract's token for that is
// `reviewer_output_line_too_large`; as in the second-review runner (closedTerminalClassification), it travels as the
// fault reason, and the closed outcome classification it maps to is `reviewer_output_line_overflow`. Both are asserted.
// [Scenario: code-review-checklist :: A Read Event Of The Size Observed In The Failing Review Is Accepted] [WhenThen: 1]
// [Scenario: code-review-checklist :: A Stdout Line Of Exactly 524,288 Bytes Is Accepted] [WhenThen: 1]
// [Scenario: code-review-checklist :: A Stdout Line Of 524,289 Bytes Fails Closed] [WhenThen: 1]
test("primary: a stdout line of exactly 512 KiB is accepted, one byte more voids the run before any export", async () => {
  await withFixture(async (fixture) => {
    for (const bytes of [65_537, 108_328, 524_288]) {
      const accepted = await review(fixture, cleanReport(), { DEVPRO_FAKE_OPENCODE_STDOUT_LINE_BYTES: String(bytes) });
      assert.equal(accepted.status, "finished", `${bytes} bytes: ${JSON.stringify(accepted)}`);
    }

    const rejected = await review(fixture, cleanReport(), { DEVPRO_FAKE_OPENCODE_STDOUT_LINE_BYTES: "524289" });
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.classification, "reviewer_output_line_overflow");
    assert.equal(rejected.stream, "stdout");
    assert.equal(rejected.fault_reason, "reviewer_output_line_too_large");
    assert.equal(rejected.max_line_bytes, 524288);
    assert.equal(rejected.report_text, undefined, "an over-long stream is never handed on as a report");
    assert.equal(rejected.events_text.includes("x".repeat(1000)), false, "the oversize line is not kept in the events");
    if (POSIX) assert.equal(rejected.cleanup_confirmed, true, "the run was ended and nothing of it is left");
  });
});

// Only the OpenCode stdout bound moves: the guard's own constant (stderr here), the second-review wrapper's line bound
// and its separate Claude thinking and signature carriers keep their values.
// [Scenario: code-review-checklist :: The Second-Review Wrapper Bound Is Not Changed] [WhenThen: 1]
test("primary: only the OpenCode stdout bound is raised; the guard constant and the second-review wrapper keep 64 KiB", async () => {
  const wrapper = await import("../run-second-reviewer-projection.mjs");
  assert.equal(primaryModule.OPENCODE_PRIMARY_MAX_STDOUT_LINE_BYTES, 512 * 1024);
  assert.equal(MAX_REVIEWER_OUTPUT_LINE_BYTES, 64 * 1024);
  assert.equal(wrapper.__testReviewerOutput.maxLineBytes, 64 * 1024);
  assert.equal(wrapper.__testReviewerOutput.maxThinkingLineBytes, 1024 * 1024);
  assert.equal(wrapper.__testReviewerOutput.maxSignatureLineBytes, 1024 * 1024);
});

// [Scenario: code-review-checklist :: Stderr Keeps The 65,536-Byte Bound] [WhenThen: 1,2]
test("primary: stderr keeps the 64 KiB line limit", async () => {
  await withFixture(async (fixture) => {
    const accepted = await review(fixture, cleanReport(), { DEVPRO_FAKE_OPENCODE_STDERR_LINE_BYTES: "65536" });
    assert.equal(accepted.status, "finished", JSON.stringify(accepted));

    const rejected = await review(fixture, cleanReport(), { DEVPRO_FAKE_OPENCODE_STDERR_LINE_BYTES: "65537" });
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.classification, "reviewer_output_line_overflow");
    assert.equal(rejected.stream, "stderr");
    assert.equal(rejected.fault_reason, "reviewer_output_line_too_large");
    assert.equal(rejected.max_line_bytes, 65536);
    assert.equal(rejected.report_text, undefined, "an over-long stream is never handed on as a report");
    if (POSIX) assert.equal(rejected.cleanup_confirmed, true, "the run was ended and nothing of it is left");
  });
});

test("primary: a newline-free flood from a hung reviewer is cut off long before the hard timeout", async () => {
  await withFixture(async (fixture) => {
    const started = Date.now();
    const outcome = await review(fixture, cleanReport(), {
      DEVPRO_FAKE_OPENCODE_NO_NEWLINE_FLOOD_BYTES: String(1024 * 1024),   // twice the stdout line bound, no newline
      DEVPRO_FAKE_OPENCODE_HANG: "1",
    }, { timeoutMs: 120_000 });
    assert.equal(outcome.classification, "reviewer_output_line_overflow", JSON.stringify(outcome));
    assert.ok(Date.now() - started < 20_000, "the overflow must settle the run, not wait for the 120 s cap");
  });
});

test("primary: total stdout beyond its cap is cut off even when every line is within the line limit", async () => {
  await withFixture(async (fixture) => {
    const outcome = await review(fixture, cleanReport(), {
      DEVPRO_FAKE_OPENCODE_STDOUT_LINE_BYTES: "1000",
      DEVPRO_FAKE_OPENCODE_STDOUT_LINE_COUNT: "50",
      DEVPRO_FAKE_OPENCODE_HANG: "1",
    }, { timeoutMs: 120_000, maxStdoutBytes: 20_000 });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.classification, "reviewer_output_total_overflow", JSON.stringify(outcome));
    assert.equal(outcome.fault_reason, "reviewer_output_total_too_large");
  });
});

test("primary: a timed-out run with a descendant holding the pipes still settles and leaves no process behind", async () => {
  await withFixture(async (fixture) => {
    const pidFile = path.join(fixture.dir, "descendant.pid");
    const started = Date.now();
    // Starting node plus the fake reviewer's modules takes seconds on the Windows server (a real run showed the
    // 1 s cap firing before the descendant existed), so the cap must leave room for the descendant to start.
    // The cap starts at spawn: leave room for a node cold start before the fake records its descendant.
    const timeoutMs = POSIX ? 3000 : 8000;
    const outcome = await review(fixture, cleanReport(), {
      DEVPRO_FAKE_OPENCODE_DESCENDANT_PID_FILE: pidFile,
      DEVPRO_FAKE_OPENCODE_HANG: "1",
    }, { timeoutMs, killSettleMs: 1500 });
    const descendant = readDescendantPid(pidFile);
    try {
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.classification, "opencode_run_timeout", JSON.stringify(outcome));
      assert.ok(Date.now() - started < timeoutMs + 14_000, "the timeout must settle in bounded time");
      assert.equal(await waitUntilGone(descendant), true, "the descendant must be gone");
    } finally {
      try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ }
    }
  });
});

test("primary: a reviewer that exits normally but leaves a descendant on the pipes is swept and still judged", { skip: !POSIX && "process groups are POSIX-only" }, async () => {
  await withFixture(async (fixture) => {
    const pidFile = path.join(fixture.dir, "descendant.pid");
    const started = Date.now();
    const outcome = await review(fixture, cleanReport(), { DEVPRO_FAKE_OPENCODE_DESCENDANT_PID_FILE: pidFile }, { drainGraceMs: 200 });
    const descendant = readDescendantPid(pidFile);
    try {
      assert.equal(outcome.status, "finished", JSON.stringify(outcome));
      assert.equal(outcome.cleanup_confirmed, true);
      assert.ok(Date.now() - started < 15_000);
      assert.equal(await waitUntilGone(descendant), true, "the descendant must not outlive the review");
    } finally {
      try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ }
    }
  });
});

test("primary: a clean run reports that no reviewer process is left", async () => {
  await withFixture(async (fixture) => {
    const outcome = await review(fixture, cleanReport());
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    assert.equal(outcome.cleanup_confirmed, POSIX ? true : null, "Windows cannot probe a process group, so it must not claim confirmation");
  });
});

// A child that only exists in memory: the tests below decide exactly when it exits, writes and closes.
function scriptedChild(script) {
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
  child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  child.kill = () => true;
  setImmediate(() => script(child));
  return child;
}

const TOOL_USE_BASH = '{"type":"tool_use","part":{"tool":"bash"}}\n';

test("primary: a chunk that lands between the drain timer and its check phase restarts the quiet period", async () => {
  await withFixture(async (fixture) => {
    const grace = 120;
    const outcome = await review(fixture, cleanReport(), {}, {
      drainGraceMs: grace,
      killSettleMs: 50,
      spawnProcess: () => scriptedChild((child) => {
        child.emit("exit", 0, null); // arms the quiet period (timer T)
        // Created after T with the same duration, so it runs in the same timers phase, right behind T: the chunk is
        // delivered before the immediate that T queued. That immediate must notice it was superseded.
        setTimeout(() => child.stdout.emit("data", Buffer.from('{"type":"step_start"}\n')), grace);
        // Still inside the restarted quiet period, but long after the first one would have ended.
        setTimeout(() => child.stdout.emit("data", Buffer.from(TOOL_USE_BASH)), grace + grace / 2);
      }),
    });
    assert.equal(outcome.classification, "opencode_tool_surface_violation", JSON.stringify(outcome));
  });
});

test("primary: where process groups cannot be probed, an exit whose pipes stay open is a survivor, not an unknown", async () => {
  await withFixture(async (fixture) => {
    const heldPipes = (child) => child.emit("exit", 0, null); // never closes: a descendant still holds the pipes
    const windows = await review(fixture, cleanReport(), {}, { platform: "win32", drainGraceMs: 30, spawnProcess: () => scriptedChild(heldPipes) });
    assert.equal(windows.classification, "opencode_process_cleanup_unconfirmed", JSON.stringify(windows));
    assert.equal(windows.cleanup_confirmed, false);
    // A reviewer whose pipes closed normally has nothing holding them; Windows still cannot say more than "unknown".
    const closed = await review(fixture, cleanReport(), {}, {
      platform: "win32",
      drainGraceMs: 30,
      spawnProcess: () => scriptedChild((child) => { child.emit("exit", 1, null); child.emit("close", 1, null); }),
    });
    assert.equal(closed.classification, "opencode_run_failed", JSON.stringify(closed));
    assert.equal(closed.cleanup_confirmed, null);
    // POSIX judges the group itself, so a drained exit with an empty group is fine.
    const posix = await review(fixture, cleanReport(), {}, {
      platform: "linux",
      drainGraceMs: 30,
      spawnProcess: () => scriptedChild((child) => child.emit("exit", 1, null)),
    });
    assert.equal(posix.classification, "opencode_run_failed", JSON.stringify(posix));
    assert.equal(posix.cleanup_confirmed, true);
  });
});

test("primary: an OpenCode v1 CLI is a failed outcome with a stable classification, not an exception", async () => {
  await withFixture(async (fixture) => {
    const outcome = await review(fixture, cleanReport(), { DEVPRO_FAKE_OPENCODE_VERSION: "1.18.31" });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.classification, "opencode_version_unsupported", JSON.stringify(outcome));
    assert.deepEqual(readdirSync(fixture.tmpRoot), [], "the refused run leaves no work directory behind");
  });
});

function sidecarFiles(dir) {
  return {
    stdout: readFileSync(path.join(dir, "reviewer-stdout.ndjson")),
    stderr: readFileSync(path.join(dir, "reviewer-stderr.log")),
  };
}

test("primary: raw stdout and stderr reach private sidecars before they are bounded or judged", async () => {
  await withFixture(async (fixture) => {
    const sidecarRoot = path.join(fixture.dir, "raw");
    const cases = [
      { stream: "stdout", env: { DEVPRO_FAKE_OPENCODE_STDOUT_LINE_BYTES: "524288" }, bytes: 524288, accepted: true },
      { stream: "stdout", env: { DEVPRO_FAKE_OPENCODE_STDOUT_LINE_BYTES: "524289" }, bytes: 524289, accepted: false },
      { stream: "stderr", env: { DEVPRO_FAKE_OPENCODE_STDERR_LINE_BYTES: "65536" }, bytes: 65536, accepted: true },
      { stream: "stderr", env: { DEVPRO_FAKE_OPENCODE_STDERR_LINE_BYTES: "65537" }, bytes: 65537, accepted: false },
    ];
    for (const { stream, env, bytes, accepted } of cases) {
      const outcome = await review(fixture, cleanReport(), env, { sidecarRoot });
      const label = `${stream} ${bytes}`;
      if (accepted) assert.equal(outcome.status, "finished", `${label}: ${JSON.stringify(outcome)}`);
      else {
        assert.equal(outcome.classification, "reviewer_output_line_overflow", `${label}: ${JSON.stringify(outcome)}`);
        assert.equal(outcome.fault_reason, "reviewer_output_line_too_large", label);
      }
      const runDir = outcome.sidecar_dir;
      assert.equal(path.dirname(runDir), sidecarRoot, `${label}: every run gets its own directory under the root`);
      const raw = sidecarFiles(runDir)[stream];
      if (accepted) {
        assert.ok(raw.toString("utf8").split("\n").some((line) => Buffer.byteLength(line) === bytes), `${label}: the line is kept as it arrived`);
      } else {
        assert.ok(raw.length >= bytes, `${label}: the oversize line is kept although the run was cut off (${raw.length} bytes)`);
        assert.ok(raw.length < 1024 * 1024, `${label}: and the retention stays bounded (${raw.length} bytes)`);
      }
      if (POSIX) {
        assert.equal(statSync(path.join(runDir, `reviewer-${stream}.${stream === "stdout" ? "ndjson" : "log"}`)).mode & 0o777, 0o600, label);
        assert.equal(statSync(runDir).mode & 0o777, 0o700, label);
      }
    }
  });
});

test("primary: stderr has a total cap too, so a flood of short lines cannot fill the sidecar", async () => {
  await withFixture(async (fixture) => {
    const outcome = await review(fixture, cleanReport(), {
      DEVPRO_FAKE_OPENCODE_STDERR_LINE_BYTES: "1000",
      DEVPRO_FAKE_OPENCODE_STDERR_LINE_COUNT: "200",
    }, { sidecarRoot: path.join(fixture.dir, "raw"), maxStderrBytes: 10_000 });
    assert.equal(outcome.classification, "reviewer_output_total_overflow", JSON.stringify(outcome));
    assert.equal(outcome.stream, "stderr");
    const { stderr } = sidecarFiles(outcome.sidecar_dir);
    assert.ok(stderr.length >= 10_000 && stderr.length < 400_000, `kept ${stderr.length} bytes`);
  });
});

test("primary: a sidecar that cannot be opened or written fails the run instead of dropping the evidence", async () => {
  await withFixture(async (fixture) => {
    const blocker = path.join(fixture.dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const refused = await review(fixture, cleanReport(), {}, {
      sidecarRoot: path.join(blocker, "raw"),
      spawnProcess: () => assert.fail("no reviewer may start without a place to keep its output"),
    });
    assert.equal(refused.status, "failed");
    assert.equal(refused.classification, "opencode_primary_input_invalid", JSON.stringify(refused));

    const failing = await review(fixture, cleanReport(), {}, {
      sidecarRoot: path.join(fixture.dir, "raw-failing"),
      sidecarWriter: () => { throw new Error("disk full"); },
      killSettleMs: 1500,
    });
    assert.equal(failing.status, "failed");
    assert.equal(failing.classification, "reviewer_sidecar_write_failed", JSON.stringify(failing));
  });
});

test("primary: a root that already exists, however permissive or hostile, is never inherited or written through", { skip: !POSIX && "POSIX modes and symlinks" }, async () => {
  await withFixture(async (fixture) => {
    const root = path.join(fixture.dir, "raw-existing");
    mkdirSync(root);
    chmodSync(root, 0o755);
    const victim = path.join(fixture.dir, "victim.txt");
    writeFileSync(victim, "keep me");
    // Names the reviewer's sidecars would have used before: a world-readable leftover and a symlink to an unrelated file.
    writeFileSync(path.join(root, "reviewer-stdout.ndjson"), "old output");
    chmodSync(path.join(root, "reviewer-stdout.ndjson"), 0o644);
    symlinkSync(victim, path.join(root, "reviewer-stderr.log"));

    const first = await review(fixture, cleanReport(), {}, { sidecarRoot: root });
    const second = await review(fixture, cleanReport(), {}, { sidecarRoot: root });
    assert.equal(first.status, "finished", JSON.stringify(first));
    assert.notEqual(first.sidecar_dir, second.sidecar_dir, "a rerun never reuses the earlier run's files");
    assert.equal(readFileSync(victim, "utf8"), "keep me", "nothing was written through the symlink");
    assert.equal(readFileSync(path.join(root, "reviewer-stdout.ndjson"), "utf8"), "old output");
    assert.equal(statSync(path.join(root, "reviewer-stdout.ndjson")).mode & 0o777, 0o644, "the leftover is not touched");
    for (const outcome of [first, second]) {
      assert.equal(statSync(outcome.sidecar_dir).mode & 0o777, 0o700, "the run directory is private whatever the root is");
      for (const name of ["reviewer-stdout.ndjson", "reviewer-stderr.log"]) {
        assert.equal(statSync(path.join(outcome.sidecar_dir, name)).mode & 0o777, 0o600, name);
      }
      assert.ok(sidecarFiles(outcome.sidecar_dir).stdout.length > 0);
    }
  });
});

test("primary cli: raw output is kept next to the report unless --sidecar-root says otherwise", async () => {
  await withFixture(async (fixture) => {
    const text = report({ verdict: "finished", assessment: assessmentSection([]) });
    const promptPath = path.join(fixture.dir, "prompt.md");
    writeFileSync(promptPath, "review the local diff\n");
    const base = ["--prompt", promptPath, "--repo-root", fixture.repoRoot, "--target", TARGET, "--dispatch", DISPATCH];
    const options = { tmpRoot: fixture.tmpRoot, env: envFor(fixture, { DEVPRO_FAKE_OPENCODE_REPORT: text }) };

    const outPath = path.join(fixture.dir, "report.md");
    const byDefault = await runPrimaryReviewCli([...base, "--out", outPath], options);
    assert.equal(byDefault.status, "finished", JSON.stringify(byDefault));
    assert.equal(path.dirname(byDefault.sidecar_dir), `${outPath}.raw`);
    assert.ok(sidecarFiles(byDefault.sidecar_dir).stdout.length > 0, "the events the reviewer wrote are kept");

    const chosen = path.join(fixture.dir, "elsewhere");
    const explicit = await runPrimaryReviewCli([...base, "--out", path.join(fixture.dir, "other.md"), "--sidecar-root", chosen], options);
    assert.equal(path.dirname(explicit.sidecar_dir), chosen);
    assert.ok(existsSync(path.join(explicit.sidecar_dir, "reviewer-stderr.log")));
    assert.equal(existsSync(`${path.join(fixture.dir, "other.md")}.raw`), false);
  });
});

test("primary: a timed-out run whose process tree could not be confirmed ended says so", async () => {
  await withFixture(async (fixture) => {
    const outcome = await review(fixture, cleanReport(), {}, {
      platform: "win32",
      timeoutMs: 40,
      killSettleMs: 40,
      terminate: () => ({ method: "taskkill-tree", unconfirmed: true }),
      spawnProcess: () => scriptedChild(() => { /* never exits */ }),
    });
    assert.equal(outcome.classification, "opencode_run_timeout", JSON.stringify(outcome));
    assert.equal(outcome.cleanup_confirmed, false, "a stalled taskkill is not a confirmed cleanup");

    // The helper's own verdict reaches the runner: taskkill launched fine but failed (no spawn error, exit 1).
    const failedKill = await review(fixture, cleanReport(), {}, {
      platform: "win32",
      timeoutMs: 40,
      killSettleMs: 40,
      terminate: (child, options) => terminateProcessTree(child, { ...options, spawnSyncImpl: () => ({ status: 1 }) }),
      spawnProcess: () => Object.assign(scriptedChild(() => { /* never exits */ }), { pid: 4321 }),
    });
    assert.equal(failedKill.classification, "opencode_run_timeout", JSON.stringify(failedKill));
    assert.equal(failedKill.cleanup_confirmed, false, "a taskkill that failed is not a confirmed cleanup either");
  });
});

test("primary: a finding bullet that carries a severity but no finding_id is a contract failure, not a clean pass", () => {
  for (const severity of ["Critical", "Important", "Suggestion"]) {
    const bullet = `- **[${severity}]** \`a.cs:10\` 這裡有問題但沒有編號`;
    const verdict = readPrimaryReviewVerdict(`## 六軸審查\n${bullet}\n\n## 總判定\n**finished**\n`);
    assert.equal(verdict.ok, false, severity);
    assert.match(verdict.reason, /finding_id/u, severity);
  }
  // a bullet that has its id keeps working, and prose that merely mentions a severity is not a bullet
  assert.equal(readPrimaryReviewVerdict(`## 六軸審查\n- **[Important]** \`[finding_id:F-1]\` x\n\n## 總判定\n**partial**\n`).ok, true);
  assert.equal(readPrimaryReviewVerdict("## 六軸審查\n本次沒有 **[Critical]** 的問題\n\n## 總判定\n**finished**\n").ok, true);
});

test("primary cli: terminating the wrapper also takes down the detached reviewer and its descendants", { skip: !POSIX && "process groups are POSIX-only" }, async () => {
  await withFixture(async (fixture) => {
    const promptPath = path.join(fixture.dir, "prompt.md");
    const pidFile = path.join(fixture.dir, "descendant.pid");
    writeFileSync(promptPath, "review the local diff\n");
    const wrapper = spawn(process.execPath, [
      repoPath(".devpro/scripts/run-opencode-primary-review.mjs"),
      "--prompt", promptPath, "--repo-root", fixture.repoRoot, "--target", TARGET, "--dispatch", DISPATCH, "--out", path.join(fixture.dir, "report.md"),
    ], {
      env: envFor(fixture, { DEVPRO_FAKE_OPENCODE_REPORT: cleanReport(), DEVPRO_FAKE_OPENCODE_DESCENDANT_PID_FILE: pidFile, DEVPRO_FAKE_OPENCODE_HANG: "1" }),
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => wrapper.once("exit", (code, signal) => resolve({ code, signal })));
    let descendant = null;
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      descendant = readDescendantPid(pidFile);
      wrapper.kill("SIGTERM");
      const outcome = await exited;
      assert.equal(outcome.signal, "SIGTERM", "the wrapper must still die by the signal it was sent");
      assert.equal(await waitUntilGone(descendant), true, "the reviewer's descendant must not be orphaned");
    } finally {
      if (descendant !== null) { try { process.kill(descendant, "SIGKILL"); } catch { /* already gone */ } }
      wrapper.kill("SIGKILL");
    }
  });
});
