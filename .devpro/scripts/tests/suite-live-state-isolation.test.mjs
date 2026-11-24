import "./lib/model-probe-fixture.mjs";
/**
 * Prove-it + regression for suite live-state isolation (P038 / P121 / P131).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { deriveMainCheckoutNotesTmp } from "../second-reviewer-cli-recipe-contract.mjs";
import { REPO_ROOT, repoPath, repoFileUrl } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { runHook } from "./lib/hook-harness.mjs";
import {
  assertAttemptUnderOwnedRoot,
  clearOwnedCanonicalCache,
  ownedCarrierRootFor,
  prepareOwnedCanonicalRenderer,
} from "./lib/owned-canonical-carrier.mjs";
import { suiteOwnedFrictionEnv } from "../run-test-suite.mjs";

process.env.DEVPRO_ALLOW_CLAUDE_EFFORT_STUB ??= "1";
process.env.DEVPRO_SECOND_REVIEW_CLAUDE_EFFORT_STUB ??= "xhigh";

const renderer = repoPath(".devpro/scripts/render-second-review-packet.mjs");
const liveCanonicalCarrierRoot = path.join(
  path.dirname(deriveMainCheckoutNotesTmp(REPO_ROOT)),
  "cross-review",
);
const liveFrictionLog = path.join(
  REPO_ROOT,
  ".devpro/scripts/hooks/state/session-friction.log",
);

const minimalHandoff = {
  mode: "audit-only",
  attempt: "initial",
  primary_family: "openai-codex",
  reviewer_family: "claude",
  target: "local diff",
  head_ref_oid: "none",
  repository_slug: "devpro/example",
  approval_context: "none",
  approval_resolution: { status: "not-required" },
  scope_summary: "owned-canonical prove-it",
  changed_files_or_touch_list: [".devpro/scripts/render-second-review-packet.mjs"],
  review_material_carrier: "embedded-diff",
  review_material_complete: true,
  review_material: "bounded diff excerpt",
  primary_validation_evidence: "prove-it",
  primary_test_evidence: "prove-it",
  retry_context: { classification: "none", sticky_verification: "not-needed" },
  write_path: "none",
  allowed_tools: "read-only audit mode",
};

function frictionSnapshot() {
  if (!existsSync(liveFrictionLog)) {
    return { exists: false, digest: null, bytes: null };
  }
  const bytes = readFileSync(liveFrictionLog);
  return {
    exists: true,
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

/** F2: prove THIS attempt is absent from live — never global set-diff (parallel writers flake). */
function assertAttemptAbsentFromLive(attemptOrPacketPath) {
  const attemptDir = attemptOrPacketPath.endsWith("packet.md")
    || attemptOrPacketPath.endsWith(`${path.sep}packet.md`)
    ? path.dirname(attemptOrPacketPath)
    : attemptOrPacketPath;
  const attemptName = path.basename(attemptDir);
  assert.equal(
    existsSync(path.join(liveCanonicalCarrierRoot, attemptName)),
    false,
    `fixture attempt ${attemptName} must not appear under live notes/cross-review`,
  );
}

function listOwnedAttempts(ownedRoot) {
  if (!existsSync(ownedRoot)) return [];
  return readdirSync(ownedRoot)
    .filter((name) => name.startsWith("second-review-"))
    .map((name) => path.join(ownedRoot, name));
}

test("T1/T3 static: render helper no longer falls back to live canonicalCarrierRoot", () => {
  const source = readFileSync(
    repoPath(".devpro/scripts/tests/render-second-review-packet.test.mjs"),
    "utf8",
  );
  assert.equal(
    source.includes("options.carrierRoot ?? canonicalCarrierRoot"),
    false,
    "default render must not silent-fallback to live canonicalCarrierRoot",
  );
});

test("T5 static: writeSingleTurnClaudeCodeFixture is imported, not redefined locally", () => {
  const source = readFileSync(
    repoPath(".devpro/scripts/tests/render-second-review-packet.test.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /import \{ writeSingleTurnClaudeCodeFixture \} from "\.\/lib\/change-usage-fixtures\.mjs"/,
  );
  assert.equal(
    source.includes("function writeSingleTurnClaudeCodeFixture"),
    false,
  );
  assert.match(source, /function seedResolvableChangeCostUsage\(dir,/);
});

test("T1/T2 behavioral: owned render leaves its attempt off live notes/cross-review", () => {
  const dir = makeTempDir("suite-live-isolation-render-");
  try {
    const handoffPath = path.join(dir, "handoff.json");
    writeFileSync(handoffPath, JSON.stringify(minimalHandoff), "utf8");
    const prepared = prepareOwnedCanonicalRenderer({
      fixtureDir: dir,
      repoRoot: REPO_ROOT,
      rendererPath: renderer,
    });
    const result = spawnSync(
      process.execPath,
      [prepared.mutatedRendererPath, handoffPath, "--carrier-root", prepared.carrierRootArg],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(dir, "control-evidence"),
          DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(dir, "post-pr-completion-state"),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const packetPath = result.stdout.trim();
    assertAttemptUnderOwnedRoot(packetPath, prepared.ownedCarrierRoot);
    assertAttemptAbsentFromLive(packetPath);
  } finally {
    clearOwnedCanonicalCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4 interruption: kill mid-render then fixture teardown clears owned residue only", async () => {
  const dir = makeTempDir("suite-live-isolation-interrupt-");
  let child;
  let attemptName = null;
  try {
    const handoffPath = path.join(dir, "handoff.json");
    writeFileSync(handoffPath, JSON.stringify(minimalHandoff), "utf8");
    // Stall after the attempt directory exists so the test can SIGTERM mid-publish.
    const stallMarker = path.join(dir, "stall-after-attempt.marker");
    const prepared = prepareOwnedCanonicalRenderer({
      fixtureDir: dir,
      repoRoot: REPO_ROOT,
      rendererPath: renderer,
      extraMutate: (source) => {
        let withMkdir = source;
        if (!/\bmkdirSync\b/.test(source)) {
          withMkdir = source.replace(
            "writeFileSync,\n} from \"node:fs\";",
            "writeFileSync,\n  mkdirSync,\n} from \"node:fs\";",
          );
          assert.notEqual(withMkdir, source, "stall mutate must import mkdirSync");
        }
        const needle = "const effectivePacketPath = options.autoCarrierRoot";
        assert.equal(withMkdir.includes(needle), true, "renderer stall hook must match current source");
        return withMkdir.replace(
          needle,
          `
            {
              const __ownedAttemptDir = path.join(canonicalCarrierRoot, attemptId);
              mkdirSync(__ownedAttemptDir, { recursive: true });
              writeFileSync(${JSON.stringify(stallMarker)}, __ownedAttemptDir, "utf8");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
            }
            const effectivePacketPath = options.autoCarrierRoot`,
        );
      },
    });
    child = spawn(
      process.execPath,
      [prepared.mutatedRendererPath, handoffPath, "--carrier-root", prepared.carrierRootArg],
      {
        cwd: REPO_ROOT,
        stdio: "ignore",
        env: {
          ...process.env,
          DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR: path.join(dir, "control-evidence"),
          DEVPRO_POST_PR_COMPLETION_STATE_DIR: path.join(dir, "post-pr-completion-state"),
        },
      },
    );
    const deadline = Date.now() + 15_000;
    while (!existsSync(stallMarker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(existsSync(stallMarker), true, "mutated renderer must reach owned attempt before stall");
    const attemptDir = readFileSync(stallMarker, "utf8").trim();
    attemptName = path.basename(attemptDir);
    assert.ok(listOwnedAttempts(prepared.ownedCarrierRoot).includes(attemptDir));
    assertAttemptUnderOwnedRoot(attemptDir, prepared.ownedCarrierRoot);
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    child = null;
    // Real fixture teardown path (clear cache + rm owned tree), not a hand-rolled rm of a fake packet.
    clearOwnedCanonicalCache(dir);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(attemptDir), false, "fixture teardown must clear owned attempt residue");
    assert.equal(
      existsSync(path.join(liveCanonicalCarrierRoot, attemptName)),
      false,
      "interrupted attempt must not appear under live notes/cross-review",
    );
  } finally {
    if (child) {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      await new Promise((r) => child.once("exit", r).unref?.() ?? setTimeout(r, 50));
    }
    clearOwnedCanonicalCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T6: suiteOwnedFrictionEnv points under os.tmpdir and leaves live friction unchanged", () => {
  const before = frictionSnapshot();
  const env = suiteOwnedFrictionEnv({ suiteToken: `prove-${randomUUID()}` });
  assert.ok(env.DEVPRO_FRICTION_LOG.startsWith(tmpdir()));
  assert.equal(env.DEVPRO_FRICTION_LOG.includes(`${path.sep}notes${path.sep}tmp`), false);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { appendFrictionLog, FRICTION_LOG } from ${JSON.stringify(repoFileUrl(".devpro/scripts/hooks/lib/friction-log.mjs"))};
      if (FRICTION_LOG !== process.env.DEVPRO_FRICTION_LOG) {
        console.error("FRICTION_LOG did not bind suite env", FRICTION_LOG, process.env.DEVPRO_FRICTION_LOG);
        process.exit(2);
      }
      appendFrictionLog("prove-it suite friction isolation");
      `,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(env.DEVPRO_FRICTION_LOG), true);
  const after = frictionSnapshot();
  assert.deepEqual(after, before, "live session-friction.log must be unchanged by suite-owned writes");
  rmSync(path.dirname(env.DEVPRO_FRICTION_LOG), { recursive: true, force: true });
});

/**
 * T9: a hook test that builds its own env for runHook used to drop the DEVPRO_FRICTION_LOG the suite
 * runner injects, so its hard-block fixtures landed in the live session-friction.log. The stub hook
 * reports what the child sees instead of going through a real gate, so a regression here fails
 * without writing to the live log.
 */
function withFrictionStub(run) {
  const dir = makeTempDir("devpro-friction-stub-");
  const stub = path.join(dir, "stub-hook.mjs");
  writeFileSync(
    stub,
    [
      'import { existsSync } from "node:fs";',
      'import path from "node:path";',
      "const log = process.env.DEVPRO_FRICTION_LOG ?? null;",
      "process.stdout.write(JSON.stringify({ log, dirExists: log ? existsSync(path.dirname(log)) : false }));",
    ].join("\n"),
  );
  const before = frictionSnapshot();
  const savedParent = process.env.DEVPRO_FRICTION_LOG;
  try {
    run({ stub, dir });
  } finally {
    if (savedParent === undefined) delete process.env.DEVPRO_FRICTION_LOG;
    else process.env.DEVPRO_FRICTION_LOG = savedParent;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(frictionSnapshot(), before, "live session-friction.log must be unchanged");
}

function assertOwnedTempLog(report, label) {
  assert.ok(report.log, `${label}: the hook must see a DEVPRO_FRICTION_LOG`);
  assert.ok(report.log.startsWith(tmpdir()), `${label}: ${report.log} must be under os.tmpdir()`);
  assert.notEqual(report.log, liveFrictionLog, `${label}: must not be the live log`);
  assert.equal(report.dirExists, true, `${label}: the temp log directory must exist while the hook runs`);
  assert.equal(
    existsSync(path.dirname(report.log)),
    false,
    `${label}: the helper must remove the temp log directory it created`,
  );
}

test("T9a: runHook gives a hook an isolated temp friction log when the caller env omits it, and removes it", () => {
  withFrictionStub(({ stub, dir }) => {
    const result = runHook(stub, {}, { cwd: dir, env: { PATH: process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    assertOwnedTempLog(JSON.parse(result.stdout), "caller env without DEVPRO_FRICTION_LOG");
  });
});

test("T9b: runHook passes a caller-supplied DEVPRO_FRICTION_LOG through unchanged", () => {
  withFrictionStub(({ stub, dir }) => {
    const supplied = path.join(dir, "caller-owned", "session-friction.log");
    mkdirSync(path.dirname(supplied), { recursive: true });
    const result = runHook(stub, {}, { cwd: dir, env: { PATH: process.env.PATH, DEVPRO_FRICTION_LOG: supplied } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).log, supplied);
    assert.equal(existsSync(path.dirname(supplied)), true, "a caller-owned log directory is left for the caller to clean up");
  });
});

test("T9c: runHook with no env supplies an isolated temp friction log when the parent process has none", () => {
  withFrictionStub(({ stub, dir }) => {
    delete process.env.DEVPRO_FRICTION_LOG;
    const result = runHook(stub, {}, { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assertOwnedTempLog(JSON.parse(result.stdout), "no env and no parent DEVPRO_FRICTION_LOG");
  });
});

test("T9d: runHook with no env passes through the parent's non-empty DEVPRO_FRICTION_LOG", () => {
  withFrictionStub(({ stub, dir }) => {
    const inherited = path.join(dir, "suite-owned", "session-friction.log");
    process.env.DEVPRO_FRICTION_LOG = inherited;
    const result = runHook(stub, {}, { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).log, inherited);
  });
});

/**
 * T10: a test file that drives a hook and is run alone with `node --test` has no suite-injected
 * DEVPRO_FRICTION_LOG, so its hard-block fixtures used to land in the live session-friction.log
 * (hook-gh-footer-gate, high-output-command-gate and hook-pre-tool-gate-base-production-block did).
 * lib/owned-friction-log.mjs, imported first by each of them, supplies an owned temp log.
 */
function runOwnedFrictionHelperChild(envOverrides) {
  const env = { ...process.env };
  delete env.DEVPRO_FRICTION_LOG;
  delete env.DEVPRO_SENTINEL_STATE_DIR;
  Object.assign(env, envOverrides);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { existsSync } from "node:fs";
      import path from "node:path";
      import ${JSON.stringify(repoFileUrl(".devpro/scripts/tests/lib/owned-friction-log.mjs"))};
      const { FRICTION_LOG } = await import(${JSON.stringify(repoFileUrl(".devpro/scripts/hooks/lib/friction-log.mjs"))});
      process.stdout.write(JSON.stringify({ log: FRICTION_LOG, dirExists: existsSync(path.dirname(FRICTION_LOG)) }));
      `,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", env },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("T10a: owned-friction-log binds friction-log.mjs to an owned temp log when the variable is unset, and removes it on exit", () => {
  assertOwnedTempLog(runOwnedFrictionHelperChild({}), "DEVPRO_FRICTION_LOG unset");
});

test("T10b: owned-friction-log treats an empty DEVPRO_FRICTION_LOG as unset", () => {
  assertOwnedTempLog(runOwnedFrictionHelperChild({ DEVPRO_FRICTION_LOG: "" }), "DEVPRO_FRICTION_LOG empty");
});

test("T10c: owned-friction-log leaves a non-empty DEVPRO_FRICTION_LOG alone", () => {
  const dir = makeTempDir("devpro-friction-supplied-");
  try {
    const supplied = path.join(dir, "caller-owned", "session-friction.log");
    const report = runOwnedFrictionHelperChild({ DEVPRO_FRICTION_LOG: supplied });
    assert.equal(report.log, supplied);
    assert.equal(report.dirExists, false, "a supplied value must not make the helper create a temp directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runTestFileAlone(file, pattern, envOverrides) {
  const env = { ...process.env };
  delete env.DEVPRO_FRICTION_LOG;
  delete env.DEVPRO_SENTINEL_STATE_DIR;
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, envOverrides);
  const result = spawnSync(
    process.execPath,
    ["--test", `--test-name-pattern=${pattern}`, repoPath(`.devpro/scripts/tests/${file}`)],
    { cwd: REPO_ROOT, encoding: "utf8", env },
  );
  assert.equal(
    result.status,
    0,
    `${file} [${pattern}] must pass when run alone:\n${result.stdout.slice(-600)}${result.stderr.slice(-600)}`,
  );
}

// One cheap, blocking test per file: the pattern must select tests that really write friction lines.
const FRICTION_TEST_FILES_RUN_ALONE = [
  { file: "hook-gh-footer-gate.test.mjs", pattern: "缺 footer" },
  { file: "high-output-command-gate.test.mjs", pattern: "BLOCKS bare full source test suite" },
  {
    file: "hook-pre-tool-gate-base-production-block.test.mjs",
    pattern: "reads the branch at the gh pr create position",
  },
];

for (const { file, pattern } of FRICTION_TEST_FILES_RUN_ALONE) {
  test(`T10d: ${file} run alone does not write the live friction log`, () => {
    const collectorDir = makeTempDir("devpro-friction-collector-");
    const stateDir = makeTempDir("devpro-friction-state-");
    try {
      // Control: with a collector supplied, the selected tests do write friction lines, so an empty state dir below means something.
      const collector = path.join(collectorDir, "session-friction.log");
      runTestFileAlone(file, pattern, { DEVPRO_FRICTION_LOG: collector });
      assert.ok(
        existsSync(collector) && readFileSync(collector, "utf8").trim() !== "",
        `control: ${file} [${pattern}] must write friction lines when a log is supplied`,
      );
      // Alone: no DEVPRO_FRICTION_LOG, and the live-log fallback is redirected to a throwaway state dir that must stay empty.
      runTestFileAlone(file, pattern, { DEVPRO_SENTINEL_STATE_DIR: stateDir });
      assert.equal(
        existsSync(path.join(stateDir, "session-friction.log")),
        false,
        `${file} run alone must not write the live friction log`,
      );
    } finally {
      rmSync(collectorDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test("T8 scope guard: no live batch-delete / mismatch-relax helpers", () => {
  const implementation = [
    readFileSync(repoPath(".devpro/scripts/tests/lib/owned-canonical-carrier.mjs"), "utf8"),
    readFileSync(repoPath(".devpro/scripts/run-test-suite.mjs"), "utf8"),
  ].join("\n");
  assert.equal(/rmSync\(\s*liveCanonicalCarrierRoot/.test(implementation), false);
  assert.equal(/rmSync\(\s*canonicalCarrierRoot/.test(implementation), false);
  assert.equal(
    /relax[\s\S]{0,40}canonical_carrier_root_mismatch|canonical_carrier_root_mismatch[\s\S]{0,40}relax/.test(
      implementation,
    ),
    false,
  );
  // Structural: owned helper is the write path; production mismatch string is not rewritten here.
  assert.match(implementation, /prepareOwnedCanonicalRenderer/);
});
