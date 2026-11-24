import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor, formatReport } from "../devpro-doctor.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// Perf pattern (e) (test-performance-patterns.md): ~10.4s standalone wall
// time; ~45.9s summed duration_ms under 145-file concurrency. Sharded for
// symmetry with the review-remediation-evidence split — zero-risk, retained
// per 2026-08-22 user decision (proposal-mini.md/meeting-notes.md).
// node --test parallelizes at file granularity only, so shard registration
// across 2 sibling entry files (devpro-doctor-runner-a.test.mjs, a thin
// `await import()` wrapper matching pre-pr-archive-gate.test.mjs's pattern)
// lets both groups run as concurrent OS processes. Group boundaries were
// chosen from measured per-test duration_ms (DP-balanced contiguous
// partition), not a naive even split of the 17 index count.
const DEVPRO_DOCTOR_TEST_GROUP =
  process.env.DEVPRO_DOCTOR_TEST_GROUP ?? "core";
const DEVPRO_DOCTOR_TEST_GROUP_RANGES = Object.freeze({
  core: [1, 9],
  runner_a: [10, 19],
});
const DEVPRO_DOCTOR_TEST_GROUP_RANGE_END = Math.max(
  ...Object.values(DEVPRO_DOCTOR_TEST_GROUP_RANGES).map(([, end]) => end),
);
let devproDoctorTestIndex = 0;

if (!Object.hasOwn(DEVPRO_DOCTOR_TEST_GROUP_RANGES, DEVPRO_DOCTOR_TEST_GROUP)) {
  throw new Error(`unknown devpro-doctor test group: ${DEVPRO_DOCTOR_TEST_GROUP}`);
}

{
  const orderedRanges = Object.values(DEVPRO_DOCTOR_TEST_GROUP_RANGES);
  for (let i = 0; i < orderedRanges.length - 1; i++) {
    const [, end] = orderedRanges[i];
    const [nextStart] = orderedRanges[i + 1];
    if (end + 1 !== nextStart) {
      throw new Error(
        `devpro-doctor test group ranges are not contiguous at seam index ${end}: ` +
          `expected next group to start at ${end + 1}, got ${nextStart}`,
      );
    }
  }
}

function devproDoctorTestGroupForIndex(index) {
  for (const [group, [start, end]] of Object.entries(DEVPRO_DOCTOR_TEST_GROUP_RANGES)) {
    if (index >= start && index <= end) return group;
  }
  throw new Error(`devpro-doctor test index ${index} has no group`);
}

function test(name, optionsOrFn, maybeFn) {
  devproDoctorTestIndex += 1;
  if (
    devproDoctorTestGroupForIndex(devproDoctorTestIndex) !==
    DEVPRO_DOCTOR_TEST_GROUP
  ) {
    return;
  }
  if (typeof optionsOrFn === "function") {
    return nodeTest(name, optionsOrFn);
  }
  return nodeTest(name, optionsOrFn, maybeFn);
}

function okToolRunner(command, args) {
  if (command === "openspec" && args[0] === "--version") {
    return { status: 0, stdout: "1.0.0\n", stderr: "" };
  }
  if (command === "gh" && args[0] === "--version") {
    return { status: 0, stdout: "gh version 2.0.0\n", stderr: "" };
  }
  if (command === "gh" && args[0] === "auth") {
    return { status: 0, stdout: "logged in\n", stderr: "" };
  }
  return { status: 127, stdout: "", stderr: `${command} not stubbed` };
}

function unavailableToolRunner(command, args) {
  if (command === "openspec" && args[0] === "--version") {
    return { status: 127, stdout: "", stderr: "openspec not found" };
  }
  if (command === "gh" && args[0] === "--version") {
    return { status: 0, stdout: "gh version 2.0.0\n", stderr: "" };
  }
  if (command === "gh" && args[0] === "auth") {
    return { status: 1, stdout: "", stderr: "not logged in" };
  }
  return { status: 127, stdout: "", stderr: `${command} not stubbed` };
}

function missingGhToolRunner(command, args) {
  if (command === "openspec" && args[0] === "--version") {
    return { status: 0, stdout: "1.0.0\n", stderr: "" };
  }
  if (command === "gh" && args[0] === "--version") {
    return { status: 127, stdout: "", stderr: "gh not found" };
  }
  return { status: 127, stdout: "", stderr: `${command} not stubbed` };
}

function ghNetworkBlockedToolRunner(command, args) {
  if (command === "openspec" && args[0] === "--version") {
    return { status: 0, stdout: "1.0.0\n", stderr: "" };
  }
  if (command === "gh" && args[0] === "--version") {
    return { status: 0, stdout: "gh version 2.0.0\n", stderr: "" };
  }
  if (command === "gh" && args[0] === "auth") {
    return { status: 1, stdout: "", stderr: "token invalid in this surface" };
  }
  if (command === "gh" && args[0] === "api") {
    return {
      status: 1,
      stdout: "",
      stderr: "error connecting to api.github.com\ncheck your internet connection\n",
    };
  }
  return { status: 127, stdout: "", stderr: `${command} not stubbed` };
}

async function copyIfExists(src, dst) {
  try {
    const stat = await fs.stat(src);
    if (stat.isDirectory()) {
      // verbatimSymlinks: true — preserve each symlink's original relative
      // target byte-for-byte, exactly as `git clone` of the submodule would.
      // Node's fs.cp default (verbatimSymlinks: false) REWRITES a relative
      // link like `../../.devpro/agent-skills/...` into an absolute path
      // pointing back at THIS worktree, which is an artifact of copying rather
      // than cloning — it would make the fixture's discovery symlinks resolve
      // outside the consumer tree and trip the install-side confinement guard
      // with a link no real (git-cloned) submodule consumer would ever have.
      await fs.cp(src, dst, { recursive: true, verbatimSymlinks: true });
    } else {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function placeCopiedSyncEntrypointLibs(destScriptsDir) {
  const libDest = path.join(destScriptsDir, "lib");
  await fs.mkdir(libDest, { recursive: true });
  for (const name of ["cli-entry.mjs", "prompt-session.mjs", "consumer-pre-pr-checks.mjs", "consumer-second-review-rules.mjs", "second-review-sticky-credential-gate.mjs", "legacy-skill-entry-artifacts.mjs"]) {
    await fs.copyFile(
      path.join(REPO_ROOT, ".devpro", "scripts", "lib", name),
      path.join(libDest, name)
    );
  }
}

let sharedConsumerFixturePromise;
let doctorFixtureIoChain = Promise.resolve();

function withExclusiveDoctorFixtureIo(fn) {
  const run = doctorFixtureIoChain.then(fn, fn);
  doctorFixtureIoChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function initializeSharedConsumerFixture() {
  return withExclusiveDoctorFixtureIo(async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-"));
    const submoduleRoot = path.join(tmpDir, ".devpro-agent-rules");

    for (const relPath of [
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      ".windsurfrules",
      ".agents",
      ".claude",
      ".codex",
      ".cursor",
      ".opencode",
      ".devpro",
      ".github",
    ]) {
      await copyIfExists(path.join(REPO_ROOT, relPath), path.join(submoduleRoot, relPath));
    }

    await fs.writeFile(
      path.join(tmpDir, ".gitmodules"),
      [
        '[submodule ".devpro-agent-rules"]',
        "\tpath = .devpro-agent-rules",
        "\turl = https://example.invalid/devpro-agent-rules.git",
        "\tbranch = production",
        "",
      ].join("\n")
    );

    await placeCopiedSyncEntrypointLibs(path.join(submoduleRoot, ".devpro", "scripts"));

    execFileSync(
      process.execPath,
      [path.join(submoduleRoot, ".devpro", "scripts", "sync-agent-rules.mjs"), "--sync"],
      { cwd: tmpDir, encoding: "utf8" }
    );

    return { tmpDir, submoduleRoot };
  });
}

async function createConsumerFixture(options = {}) {
  sharedConsumerFixturePromise ??= initializeSharedConsumerFixture();
  const fixture = await sharedConsumerFixturePromise;

  await fs.writeFile(
    path.join(fixture.tmpDir, ".gitmodules"),
    [
      ...(options.gitmodulesPrelude || []),
      '[submodule ".devpro-agent-rules"]',
      "\tpath = .devpro-agent-rules",
      "\turl = https://example.invalid/devpro-agent-rules.git",
      "\tbranch = production",
      "",
    ].join("\n")
  );
  await fs.rm(path.join(fixture.tmpDir, "AGENTS.local.md"), { force: true });

  return fixture;
}

async function retainSharedConsumerFixture(tmpDir) {
  const fixture = await sharedConsumerFixturePromise;
  assert.equal(tmpDir, fixture.tmpDir, "consumer test must retain the process-shared fixture");
}

nodeTest.after(async () => {
  if (!sharedConsumerFixturePromise) return;
  const { tmpDir } = await sharedConsumerFixturePromise;
  await fs.rm(tmpDir, { recursive: true, force: true });
  sharedConsumerFixturePromise = undefined;
});

test("copied --sync fails with ERR_MODULE_NOT_FOUND when scripts/lib/cli-entry.mjs is missing", async () => {
  await withExclusiveDoctorFixtureIo(async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-missing-lib-"));
    const submoduleRoot = path.join(tmpDir, ".devpro-agent-rules");
    try {
      for (const relPath of [
        "AGENTS.md",
        "CLAUDE.md",
        "GEMINI.md",
        ".windsurfrules",
        ".agents",
        ".claude",
        ".codex",
        ".cursor",
        ".opencode",
        ".devpro",
        ".github",
      ]) {
        await copyIfExists(path.join(REPO_ROOT, relPath), path.join(submoduleRoot, relPath));
      }

      await fs.writeFile(
        path.join(tmpDir, ".gitmodules"),
        [
          '[submodule ".devpro-agent-rules"]',
          "\tpath = .devpro-agent-rules",
          "\turl = https://example.invalid/devpro-agent-rules.git",
          "\tbranch = production",
          "",
        ].join("\n")
      );

      const destScriptsDir = path.join(submoduleRoot, ".devpro", "scripts");
      await fs.rm(path.join(destScriptsDir, "lib"), { recursive: true, force: true });

      const syncArgs = [path.join(destScriptsDir, "sync-agent-rules.mjs"), "--sync"];
      const syncOptions = { cwd: tmpDir, encoding: "utf8" };

      let missingLibError;
      try {
        execFileSync(process.execPath, syncArgs, syncOptions);
      } catch (error) {
        missingLibError = error;
      }
      assert.ok(missingLibError, "copied --sync must fail when dest scripts/lib/cli-entry.mjs is missing");
      const missingLibOutput = String(missingLibError.stderr || missingLibError.message);
      assert.match(missingLibOutput, /ERR_MODULE_NOT_FOUND/);
      assert.match(missingLibOutput, /cli-entry/);

      await placeCopiedSyncEntrypointLibs(destScriptsDir);
      execFileSync(process.execPath, syncArgs, syncOptions);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test("devpro doctor passes in source mode", async () => {
  const report = await runDoctor({ repoRoot: REPO_ROOT, toolRunner: okToolRunner });
  assert.equal(report.mode, "source");
  assert.equal(report.ok, true, formatReport(report));
  assert.ok(report.checks.some((check) => check.name === "rules source" && check.status === "OK"));
  assert.ok(report.checks.some((check) => check.name === "profiles" && check.status === "OK"));
  assert.ok(report.checks.some((check) => check.name === "openspec" && check.status === "OK"));
  assert.ok(report.checks.some((check) => check.name === "gh" && check.status === "OK"));
  assert.ok(
    report.checks.some((check) =>
      check.name === "consumer readiness" &&
      check.status === "OK" &&
      check.detail === "source mode; consumer readiness aggregate not applicable"
    ),
    formatReport(report)
  );
  assert.ok(
    report.checks.some(
      (check) => check.name === "OpenCode CLI carriers" && check.status === "OK"
    ),
    formatReport(report)
  );
  const opencodeCarriers = report.checks.find((check) => check.name === "OpenCode CLI carriers");
  assert.match(
    opencodeCarriers.detail,
    /plugin\+package\+7 agents present/,
    formatReport(report)
  );
  const desktop = report.checks.find((check) => check.name === "OpenCode Desktop");
  assert.ok(desktop, formatReport(report));
  assert.equal(desktop.status, "WARN", formatReport(report));
  assert.match(desktop.detail, /unsupported/);
  assert.match(desktop.detail, /unverified/);
  assert.match(formatReport(report), /unsupported/);
});

test("devpro doctor report surfaces a read-only uninstall command hint in consumer mode", async () => {
  // Uninstall only makes sense for a consumer repo (there is nothing to
  // uninstall in the source repo itself, which would hit SOURCE_ROOT_ERROR
  // if it tried), so this hint must be tied to consumer mode.
  const { tmpDir } = await createConsumerFixture();
  try {
    const report = await runDoctor({ repoRoot: tmpDir, toolRunner: okToolRunner });
    assert.equal(report.mode, "consumer");
    const output = formatReport(report);
    assert.match(
      output,
      /sync-agent-rules\.mjs --uninstall --dry-run/,
      "doctor output must point at the uninstall preview command"
    );
    assert.match(output, /--uninstall --git-flow/, "doctor output must mention the git-flow uninstall path");
    // Doctor is read-only: it must never place uninstall in nextActions as an
    // action it took, nor invoke the removal — the hint is informational only.
    assert.ok(
      !report.nextActions.some((action) => /--uninstall/.test(action)),
      "uninstall must be a standing hint, not a doctor-executed next action"
    );
  } finally {
    await retainSharedConsumerFixture(tmpDir);
  }
});

test("devpro doctor report does NOT surface the uninstall hint in source mode", async () => {
  // The source repo has nothing installed by --sync to uninstall; printing
  // the hint here would point a source-repo maintainer at a command that
  // hits SOURCE_ROOT_ERROR.
  const report = await runDoctor({ repoRoot: REPO_ROOT, toolRunner: okToolRunner });
  assert.equal(report.mode, "source");
  const output = formatReport(report);
  assert.doesNotMatch(
    output,
    /--uninstall/,
    "source mode doctor output must not mention --uninstall"
  );
});

test("devpro doctor consumer smoke is observable in source mode", async () => {
  const report = await runDoctor({ repoRoot: REPO_ROOT, consumerSmoke: true, toolRunner: okToolRunner });
  assert.equal(report.mode, "source");
  assert.equal(report.ok, true, formatReport(report));
  assert.ok(
    report.checks.some((check) =>
      check.name === "consumer smoke" &&
      check.status === "OK" &&
      check.detail === "source mode uses the read-only/source-safe doctor path"
    ),
    formatReport(report)
  );
});

test("devpro doctor passes after a consumer sync fixture", async () => {
  const { tmpDir } = await createConsumerFixture();
  try {
    const report = await runDoctor({ repoRoot: tmpDir, consumerSmoke: true, toolRunner: okToolRunner });
    assert.equal(report.mode, "consumer");
    assert.equal(report.ok, true, formatReport(report));
    assert.ok(
      report.checks.some((check) => check.name === "generated files" && check.status === "OK")
    );
    assert.ok(
      report.checks.some((check) => check.name === "submodule branch" && check.status === "OK")
    );
    assert.ok(
      report.checks.some((check) =>
        check.name === "consumer smoke" &&
        check.status === "OK" &&
        check.detail === "consumer-safe/generated-file smoke path is active"
      ),
      formatReport(report)
    );
    assert.ok(
      report.checks.some((check) =>
        check.name === "profiles" &&
        check.status === "OK" &&
        check.detail.includes("consumer-lite=")
      ),
      formatReport(report)
    );
    assert.ok(
      report.checks.some((check) =>
        check.name === "consumer readiness" &&
        check.status === "OK" &&
        check.detail === "consumer essentials present"
      ),
      formatReport(report)
    );
  } finally {
    await retainSharedConsumerFixture(tmpDir);
  }
});

test("devpro doctor reads the .devpro-agent-rules submodule branch only", async () => {
  const { tmpDir } = await createConsumerFixture({
    gitmodulesPrelude: [
      '[submodule "business"]',
      "\tpath = business",
      "\turl = https://example.invalid/business.git",
      "\tbranch = develop",
      "",
    ],
  });
  try {
    const report = await runDoctor({ repoRoot: tmpDir, consumerSmoke: true, toolRunner: okToolRunner });
    assert.equal(report.mode, "consumer");
    assert.equal(report.ok, true, formatReport(report));
    const branchCheck = report.checks.find((check) => check.name === "submodule branch");
    assert.deepEqual(
      branchCheck,
      {
        name: "submodule branch",
        status: "OK",
        detail: ".gitmodules branch=production",
      },
      formatReport(report)
    );
  } finally {
    await retainSharedConsumerFixture(tmpDir);
  }
});

test("devpro doctor reports optional tool gaps as warnings", async () => {
  const report = await runDoctor({
    repoRoot: REPO_ROOT,
    consumerSmoke: true,
    toolRunner: unavailableToolRunner,
  });

  assert.equal(report.mode, "source");
  assert.equal(report.ok, true, formatReport(report));
  assert.ok(
    report.checks.some((check) => check.name === "openspec" && check.status === "WARN"),
    formatReport(report)
  );
  assert.ok(
    report.checks.some((check) => check.name === "gh" && check.status === "WARN"),
    formatReport(report)
  );
  assert.ok(
    report.nextActions.some((action) => action.includes("OpenSpec")),
    formatReport(report)
  );
  assert.ok(
    report.nextActions.some((action) => action.includes("gh auth login -h github.com")),
    formatReport(report)
  );
  assert.ok(
    !report.nextActions.some((action) => action.includes("Install GitHub CLI")),
    formatReport(report)
  );
});

test("devpro doctor separates missing gh CLI from auth warnings", async () => {
  const report = await runDoctor({
    repoRoot: REPO_ROOT,
    toolRunner: missingGhToolRunner,
  });

  assert.equal(report.mode, "source");
  assert.equal(report.ok, true, formatReport(report));
  assert.ok(
    report.checks.some((check) =>
      check.name === "gh" &&
      check.status === "WARN" &&
      check.detail === "gh CLI unavailable"
    ),
    formatReport(report)
  );
  assert.ok(
    report.nextActions.some((action) => action.includes("Install GitHub CLI")),
    formatReport(report)
  );
  assert.ok(
    !report.nextActions.some((action) => action.includes("gh auth login")),
    formatReport(report)
  );
});

test("devpro doctor separates gh surface/network failures from auth-login advice", async () => {
  const report = await runDoctor({
    repoRoot: REPO_ROOT,
    toolRunner: ghNetworkBlockedToolRunner,
  });

  assert.equal(report.mode, "source");
  assert.equal(report.ok, true, formatReport(report));
  assert.ok(
    report.checks.some((check) =>
      check.name === "gh" &&
      check.status === "WARN" &&
      check.detail === "gh available; auth surface unavailable"
    ),
    formatReport(report)
  );
  assert.ok(
    report.nextActions.some((action) => action.includes("host/network-enabled shell")),
    formatReport(report)
  );
  assert.ok(
    !report.nextActions.some((action) => action.includes("gh auth login")),
    formatReport(report)
  );
});

test("runTool enables shell:true on win32 so openspec.cmd probes succeed", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  const calls = [];

  function win32CmdAwareRunner(command, args, options = {}) {
    calls.push({ command, args, options });
    if (command === "openspec" && args[0] === "--version") {
      // Mimic CreateProcess ENOENT for unshelled npm .cmd shims.
      if (options.shell !== true) {
        const error = new Error("spawn openspec ENOENT");
        error.code = "ENOENT";
        return { status: 1, stdout: "", stderr: "", error };
      }
      return { status: 0, stdout: "1.0.0\n", stderr: "" };
    }
    return okToolRunner(command, args);
  }

  try {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
      enumerable: true,
    });
    const report = await runDoctor({
      repoRoot: REPO_ROOT,
      toolRunner: win32CmdAwareRunner,
    });
    const openspecCalls = calls.filter((call) => call.command === "openspec");
    assert.ok(openspecCalls.length > 0, "openspec must be probed");
    for (const call of openspecCalls) {
      assert.equal(
        call.options.shell,
        true,
        "win32 runTool must pass shell:true for .cmd shim resolution"
      );
    }
    const openspecCheck = report.checks.find((check) => check.name === "openspec");
    assert.ok(openspecCheck, formatReport(report));
    assert.match(openspecCheck.detail, /cli=/, formatReport(report));
    assert.equal(
      openspecCheck.detail.includes("cli unavailable"),
      false,
      formatReport(report)
    );
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("runTool does not force shell:true on POSIX", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  const calls = [];

  function capturingRunner(command, args, options = {}) {
    calls.push({ command, args, options });
    return okToolRunner(command, args);
  }

  try {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
      enumerable: true,
    });
    await runDoctor({
      repoRoot: REPO_ROOT,
      toolRunner: capturingRunner,
    });
    const toolCalls = calls.filter(
      (call) => call.command === "openspec" || call.command === "gh"
    );
    assert.ok(toolCalls.length > 0, "external tools must be probed");
    for (const call of toolCalls) {
      assert.notEqual(
        call.options.shell,
        true,
        `${call.command} must not force shell:true on POSIX`
      );
    }
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("devpro doctor skips AGENTS.local.md overlay check in source mode", async () => {
  const report = await runDoctor({ repoRoot: REPO_ROOT, toolRunner: okToolRunner });
  assert.equal(report.mode, "source");
  assert.ok(
    !report.checks.some((check) => check.name === "AGENTS.local.md"),
    "source mode must skip consumer-facing AGENTS.local.md overlay checks"
  );
});

test("devpro doctor reports AGENTS.local.md absent as INFO in consumer mode", async () => {
  const { tmpDir } = await createConsumerFixture();
  try {
    const report = await runDoctor({ repoRoot: tmpDir, toolRunner: okToolRunner });
    assert.equal(report.mode, "consumer");
    assert.equal(report.ok, true, formatReport(report));
    const overlayChecks = report.checks.filter((check) => check.name === "AGENTS.local.md");
    assert.equal(overlayChecks.length, 1, formatReport(report));
    assert.deepEqual(
      overlayChecks[0],
      { name: "AGENTS.local.md", status: "INFO", detail: "absent" },
      formatReport(report)
    );
    assert.ok(
      !overlayChecks.some((check) => check.status === "FAIL"),
      "overlay check must never FAIL"
    );
  } finally {
    await retainSharedConsumerFixture(tmpDir);
  }
});

test("devpro doctor reports AGENTS.local.md present bytes as INFO without WARN when clean", async () => {
  const { tmpDir } = await createConsumerFixture();
  try {
    const body = "# Local overlay\n\nAdd team-specific reminders only.\n";
    await fs.writeFile(path.join(tmpDir, "AGENTS.local.md"), body, "utf8");
    const expectedBytes = Buffer.byteLength(body, "utf8");

    const report = await runDoctor({ repoRoot: tmpDir, toolRunner: okToolRunner });
    assert.equal(report.mode, "consumer");
    assert.equal(report.ok, true, formatReport(report));

    const overlayChecks = report.checks.filter((check) => check.name === "AGENTS.local.md");
    assert.equal(overlayChecks.length, 1, formatReport(report));
    assert.equal(overlayChecks[0].status, "INFO", formatReport(report));
    assert.equal(overlayChecks[0].detail, `present; bytes=${expectedBytes}`, formatReport(report));
    assert.ok(!overlayChecks.some((check) => check.status === "WARN"), formatReport(report));
    assert.ok(!overlayChecks.some((check) => check.status === "FAIL"), formatReport(report));
  } finally {
    await retainSharedConsumerFixture(tmpDir);
  }
});

test("devpro doctor advisory WARN on relaxing+gate co-occurrence never upgrades to FAIL", async () => {
  const { tmpDir } = await createConsumerFixture();
  try {
    const body = [
      "# Local overlay",
      "",
      "可以 skip OpenSpec for this hotfix.",
      "Tokens on separate lines do not warn:",
      "skip",
      "OpenSpec",
      "",
    ].join("\n");
    await fs.writeFile(path.join(tmpDir, "AGENTS.local.md"), body, "utf8");

    const report = await runDoctor({ repoRoot: tmpDir, toolRunner: okToolRunner });
    assert.equal(report.mode, "consumer");
    assert.equal(report.ok, true, formatReport(report));

    const overlayChecks = report.checks.filter((check) => check.name === "AGENTS.local.md");
    assert.ok(
      overlayChecks.some((check) => check.status === "INFO" && /^present; bytes=\d+$/.test(check.detail)),
      formatReport(report)
    );
    const warn = overlayChecks.find((check) => check.status === "WARN");
    assert.ok(warn, formatReport(report));
    assert.match(warn.detail, /consumer-local-rules\.md/);
    assert.match(warn.detail, /additive-only/);
    assert.match(warn.detail, /line\(s\) 3\b/);
    assert.ok(
      !overlayChecks.some((check) => check.status === "FAIL"),
      "overlay advisory must never be FAIL"
    );
    assert.ok(
      report.nextActions.some((action) => /consumer-local-rules\.md/.test(action)),
      formatReport(report)
    );
  } finally {
    await retainSharedConsumerFixture(tmpDir);
  }
});

test("devpro doctor WARN on tightening false-positive still stays non-FAIL", async () => {
  // "不可跳過 … test" co-occurs relaxing token + gate noun; advisory FP expected.
  const { tmpDir } = await createConsumerFixture();
  try {
    await fs.writeFile(
      path.join(tmpDir, "AGENTS.local.md"),
      "不可跳過 test 與 code review。\n",
      "utf8"
    );

    const report = await runDoctor({ repoRoot: tmpDir, toolRunner: okToolRunner });
    assert.equal(report.ok, true, formatReport(report));
    const overlayChecks = report.checks.filter((check) => check.name === "AGENTS.local.md");
    assert.ok(overlayChecks.some((check) => check.status === "INFO"), formatReport(report));
    assert.ok(overlayChecks.some((check) => check.status === "WARN"), formatReport(report));
    assert.ok(!overlayChecks.some((check) => check.status === "FAIL"), formatReport(report));
  } finally {
    await retainSharedConsumerFixture(tmpDir);
  }
});

test("devpro doctor WARNs when OpenCode plugins/package.json is missing", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-opencode-pkg-"));
  try {
    // Minimal source-shaped tree: plugin JS + seven agents, but no plugins/package.json.
    const pluginDir = path.join(tmpDir, ".opencode", "plugins");
    const agentDir = path.join(tmpDir, ".opencode", "agent");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "devpro-hooks.js"), "export default async () => ({});\n");
    for (const role of [
      "dp-analyst",
      "dp-architect",
      "dp-assistant",
      "dp-explorer",
      "dp-programmer",
      "dp-reviewer",
      "dp-second-reviewer",
    ]) {
      await fs.writeFile(path.join(agentDir, `${role}.md`), `---\ndescription: ${role}\n---\n`);
    }
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "version: test\n");
    const report = await runDoctor({ repoRoot: tmpDir, toolRunner: okToolRunner });
    const carriers = report.checks.find((check) => check.name === "OpenCode CLI carriers");
    assert.ok(carriers, formatReport(report));
    assert.equal(carriers.status, "WARN", formatReport(report));
    assert.match(
      carriers.detail,
      /\.opencode\/plugins\/package\.json/,
      formatReport(report)
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("devpro doctor probes opencode2 --version and reports V1 face unverified in both V1-binary states", async () => {
  // T7 / R6,R8,R18 + W1-CODE-001: the V2 re-anchor of the version probe. A
  // missing V1 binary must surface "V1 face unverified" without failing the
  // whole doctor run (no fail-whole). The version probe is ONLY a literal
  // report — the V1 face stays unverified even when the V1 binary is present
  // (no live verification mechanism exists; the probe is never face proof).
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "devpro-doctor-opencode2-probe-"));
  try {
    const pluginDir = path.join(tmpDir, ".opencode", "plugins");
    const agentDir = path.join(tmpDir, ".opencode", "agent");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "devpro-hooks.js"), "export default async () => ({});\n");
    await fs.writeFile(path.join(pluginDir, "package.json"), '{"type":"module"}\n');
    for (const role of [
      "dp-analyst",
      "dp-architect",
      "dp-assistant",
      "dp-explorer",
      "dp-programmer",
      "dp-reviewer",
      "dp-second-reviewer",
    ]) {
      await fs.writeFile(path.join(agentDir, `${role}.md`), `---\ndescription: ${role}\n---\n`);
    }
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "version: test\n");

    const baseRunner = (command, args) => {
      if (command === "openspec" && args[0] === "--version") {
        return { status: 0, stdout: "1.0.0\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "--version") {
        return { status: 0, stdout: "gh version 2.0.0\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "auth") {
        return { status: 0, stdout: "logged in\n", stderr: "" };
      }
      return { status: 127, stdout: "", stderr: `${command} not stubbed` };
    };
    // V1 binary missing, V2 present → "V1 face unverified"; status stays OK.
    const runnerV2Only = (command, args) => {
      if (command === "opencode2" && args[0] === "--version") {
        return { status: 0, stdout: "opencode2 v0.0.0-beta-19425\n", stderr: "" };
      }
      if (command === "opencode" && args[0] === "--version") {
        return { status: 127, stdout: "", stderr: "opencode: command not found\n" };
      }
      return baseRunner(command, args);
    };
    const report = await runDoctor({ repoRoot: tmpDir, toolRunner: runnerV2Only });
    const carriers = report.checks.find((check) => check.name === "OpenCode CLI carriers");
    assert.ok(carriers, formatReport(report));
    assert.equal(carriers.status, "OK", formatReport(report));
    assert.match(carriers.detail, /opencode2=v0\.0\.0-beta-19425/);
    assert.match(carriers.detail, /V1 face unverified/);

    // V1 binary present too → literal reported, face STILL unverified (W1-CODE-001).
    const runnerBoth = (command, args) => {
      if (command === "opencode" && args[0] === "--version") {
        return { status: 0, stdout: "1.18.30\n", stderr: "" };
      }
      return runnerV2Only(command, args);
    };
    const reportBoth = await runDoctor({ repoRoot: tmpDir, toolRunner: runnerBoth });
    const carriersBoth = reportBoth.checks.find((check) => check.name === "OpenCode CLI carriers");
    assert.ok(carriersBoth, formatReport(reportBoth));
    assert.equal(carriersBoth.status, "OK", formatReport(reportBoth));
    assert.match(carriersBoth.detail, /V1 CLI present/);
    assert.match(carriersBoth.detail, /1\.18\.30/);
    assert.match(
      carriersBoth.detail,
      /V1 face unverified/,
      "V1 binary presence must not read as V1-face verification (W1-CODE-001)"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

if (devproDoctorTestIndex !== DEVPRO_DOCTOR_TEST_GROUP_RANGE_END) {
  throw new Error(
    `devpro-doctor grouped ${devproDoctorTestIndex} tests, expected ${DEVPRO_DOCTOR_TEST_GROUP_RANGE_END}`,
  );
}
