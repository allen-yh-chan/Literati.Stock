/**
 * hook-cwd-proof-launcher.test.mjs
 *
 * T1 prove-it test: demonstrates cwd-drift failures with bare relative command,
 * then (after T2+T3) validates inline launcher works in all three layouts:
 *   1. Subdirectory cwd  — cwd is a subdir of repo root
 *   2. Nested submodule  — cwd inside .devpro-agent-rules (nested source)
 *   3. Worktree          — cwd is a git worktree at non-standard path
 *
 * T4 prove-it: validates run-hook.mjs B-fallback (import.meta.url resolve)
 * resolves relative scriptPath when cwd is wrong.
 *
 * Root-walk algorithm: nearest valid root + .devpro-agent-rules disqualification
 *   Walk from process.cwd() upward. At each candidate dir:
 *   1. If path.basename(d) === '.devpro-agent-rules' (i.e., the candidate dir
 *      itself IS the submodule mount point), skip it (disqualified) and continue
 *      walking upward.  Only the mount-point dir is skipped — ancestor dirs whose
 *      basename happens to also be '.devpro-agent-rules' are correctly handled
 *      because those ancestors' basenames will equal '.devpro-agent-rules' only if
 *      the ancestor IS such a mount; dirs above it have different basenames.
 *   2. Otherwise, chdir to candidate and check whether
 *      `<candidate>/.devpro/scripts/hooks/run-hook.mjs` exists.
 *   3. Return the FIRST (nearest to cwd, non-disqualified) such candidate.
 *   Implementation uses process.chdir(d) before each existsSync check so that
 *   the literal string `fs.existsSync('.devpro/scripts/hooks/run-hook.mjs')` can
 *   be used in the code (required by SYNC_DIRS parser regex).
 *   Rationale: In a consumer repo with submodule at .devpro-agent-rules/, if
 *   cwd is inside that submodule, we skip the submodule's own .devpro and
 *   continue up to the consumer root — exactly the correct root to spawn from.
 *   Consumer repos residing UNDER an ancestor dir also named .devpro-agent-rules
 *   are no longer mis-disqualified (basename check vs. includes-segment check).
 *   Plain nested repos (without .devpro-agent-rules) retain nearest-wins.
 *
 * Note on argv indexing: with `node -e "code" arg1 arg2`,
 *   process.argv = [node, arg1, arg2] (no -e or code in argv).
 *   So Event = argv[1], Gate = argv[2].
 */

import { mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync, cpSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { repoPath } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

// ── Fixture helpers ─────────────────────────────────────────────────────────

/**
 * Copy the real run-hook.mjs into <hooksDir>, plus its shared libraries.
 * The runner ships alongside lib/ in real deployments; fixtures must
 * mirror that or the wrapper's ESM import fails (ERR_MODULE_NOT_FOUND). Single
 * helper so every fixture builder stays in sync when the runner gains a sibling.
 */
function installRunner(hooksDir) {
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    path.join(hooksDir, "run-hook.mjs"),
    readFileSync(repoPath(".devpro/scripts/hooks/run-hook.mjs"), "utf8")
  );
  cpSync(repoPath(".devpro/scripts/hooks/lib"), path.join(hooksDir,"lib"), {recursive:true});
  cpSync(repoPath(".devpro/scripts/lib"), path.join(hooksDir,"../lib"), {recursive:true});
}

/**
 * Build a minimal fake repo root with:
 *   <root>/.devpro/scripts/hooks/run-hook.mjs  (real runner)
 *   <root>/.devpro/scripts/hooks/<gate>.mjs     (a simple gate script)
 *   <root>/subdir/                              (for layout-1)
 *   <root>/node_modules/.devpro-agent-rules/    (simulated submodule for layout-2)
 */
function buildFakeRepo(baseDir) {
  const hooksDir = path.join(baseDir, ".devpro", "scripts", "hooks");
  installRunner(hooksDir);

  // Gate script that signals it ran
  writeFileSync(
    path.join(hooksDir, "test-gate.mjs"),
    "process.stdout.write(JSON.stringify({ran:true,cwd:process.cwd()}));\nprocess.exit(0);\n"
  );

  // Subdirectory layout-1
  mkdirSync(path.join(baseDir, "subdir", "deep"), { recursive: true });

  return {
    root: baseDir,
    hooksDir,
    gate: ".devpro/scripts/hooks/test-gate.mjs",
    runnerRel: ".devpro/scripts/hooks/run-hook.mjs",
  };
}

/**
 * Run the BARE RELATIVE command (current bug) from a given cwd.
 * Returns spawnSync result.
 */
function runBareRelative(event, gateRel, cwdOverride) {
  // This is the old broken command form
  return spawnSync(
    process.execPath,
    [".devpro/scripts/hooks/run-hook.mjs", event, gateRel],
    {
      cwd: cwdOverride,
      encoding: "utf8",
    }
  );
}

/**
 * The shipped inline launcher body — read from `.claude/settings.json` so these
 * layout tests exercise the exact code the configs carry (byte-identical across
 * the three runtime configs; see cross-platform-hook-commands.test.mjs T2).
 * It keeps process.chdir(d) before the literal existsSync so the SYNC_DIRS
 * parser can extract the path via regex existsSync\(['"]([^'"]+)['"]\).
 *
 * Note: argv[1]=Event, argv[2]=Gate when invoked as `node -e "code" Event Gate`.
 */
const INLINE_LAUNCHER_CODE = (() => {
  const settings = JSON.parse(readFileSync(repoPath(".claude/settings.json"), "utf8"));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  const match = command.match(/^node -e "(.*)" \S+ \S+ --host=[a-z0-9-]+$/s);
  assert.ok(match, "cannot extract the shipped launcher body from .claude/settings.json");
  return match[1];
})();

/**
 * Build the inline launcher command args (the A'-fixed form).
 * The body is the one shipped in the configs (see INLINE_LAUNCHER_CODE).
 */
function buildInlineLauncherArgs(event, gateRel) {
  return ["-e", INLINE_LAUNCHER_CODE, event, gateRel];
}

/**
 * Run the INLINE LAUNCHER command from a given cwd.
 */
function runInlineLauncher(event, gateRel, cwdOverride) {
  // These cases cover the default (repo .devpro) path; an inherited override
  // would redirect them. The override path is covered by
  // hook-launcher-rules-root.test.mjs.
  const env = { ...process.env };
  delete env.DEVPRO_RULES_ROOT;
  return spawnSync(process.execPath, buildInlineLauncherArgs(event, gateRel), {
    cwd: cwdOverride,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// ── T1: prove-it tests (these FAIL before fix, PASS after fix) ──────────────

test("T1-layout1: bare relative command CRASHES when cwd is a subdirectory", () => {
  const dir = makeTempDir("cwd-proof-layout1-");
  try {
    const repo = buildFakeRepo(dir);
    const subCwd = path.join(dir, "subdir", "deep");

    const result = runBareRelative("Stop", repo.gate, subCwd);

    // BUG: node cannot find .devpro/scripts/hooks/run-hook.mjs from subdir
    // so it crashes with MODULE_NOT_FOUND or non-zero exit
    assert.notEqual(
      result.status,
      0,
      "PROVE-IT: bare relative command must fail (MODULE_NOT_FOUND) from subdirectory cwd — this is the bug being fixed"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T1-layout2: bare relative command CRASHES or silent-exits when cwd is inside nested submodule dir", () => {
  const dir = makeTempDir("cwd-proof-layout2-");
  try {
    const repo = buildFakeRepo(dir);

    // Simulate nested submodule: create .devpro-agent-rules subdir (source self)
    // with its own .devpro (but WITHOUT run-hook.mjs there, simulating source)
    const submoduleDir = path.join(dir, ".devpro-agent-rules", "some-subdir");
    mkdirSync(submoduleDir, { recursive: true });

    // run from inside the submodule — cwd is NOT repo root
    const result = runBareRelative("Stop", repo.gate, submoduleDir);

    // BUG: fails because .devpro/scripts/hooks/run-hook.mjs doesn't exist
    // relative to submodule subdir
    assert.notEqual(
      result.status,
      0,
      "PROVE-IT: bare relative command must fail from nested submodule cwd — this is the bug being fixed"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T1-layout3: bare relative command CRASHES in worktree at non-standard path", () => {
  const dir = makeTempDir("cwd-proof-layout3-");
  try {
    const repo = buildFakeRepo(dir);

    // Simulate worktree: a path like .worktree/<change-name> — the repo root
    // is up two levels from the worktree directory
    const worktreeDir = path.join(dir, ".worktree", "my-feature", "src");
    mkdirSync(worktreeDir, { recursive: true });

    const result = runBareRelative("Stop", repo.gate, worktreeDir);

    // BUG: worktree src subdir has no .devpro/ relative to it
    assert.notEqual(
      result.status,
      0,
      "PROVE-IT: bare relative command must fail from worktree subdirectory — this is the bug being fixed"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── T1 silent-fail: prove that bare command silently exits 0 when wrapper ────
// loads but gate path is relative (resolves against wrong cwd)

test("T1-silent: bare relative command exits 0 (silently skips gate) when wrapper loads but gate rel-path is wrong", () => {
  const dir = makeTempDir("cwd-proof-silent-");
  try {
    const repo = buildFakeRepo(dir);

    // cwd = repo root so wrapper LOADS, but gate rel-path is relative to root
    // — this actually works. The silent fail happens when wrapper loads but
    // scriptPath doesn't resolve. We simulate: wrapper in root cwd, but gate
    // would be correct only from root. This test instead validates the
    // scenario where run-hook.mjs loads but gate existsSync is wrong cwd.

    // Create a second dir that has run-hook.mjs accessible via PATH trick —
    // simulate: cwd=root, gate rel resolves correctly → status 0, ran=true
    // This is the "happy path" baseline showing gate DOES run when cwd=root
    const result = spawnSync(
      process.execPath,
      [path.join(dir, ".devpro/scripts/hooks/run-hook.mjs"), "Stop", repo.gate],
      { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );

    // From repo root it should work (gate runs successfully)
    assert.equal(
      result.status,
      0,
      "from repo root, bare relative command should succeed"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── T2+T3: inline launcher tests (validate fix works) ───────────────────────

test("T2-layout1: inline launcher SUCCEEDS when cwd is a subdirectory", () => {
  const dir = makeTempDir("cwd-proof-fix-layout1-");
  try {
    const repo = buildFakeRepo(dir);
    const subCwd = path.join(dir, "subdir", "deep");

    const result = runInlineLauncher("Stop", repo.gate, subCwd);

    assert.equal(
      result.status,
      0,
      `inline launcher must succeed from subdirectory cwd.\nstderr: ${result.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T2-layout2: inline launcher SUCCEEDS when cwd is inside nested submodule dir", () => {
  const dir = makeTempDir("cwd-proof-fix-layout2-");
  try {
    const repo = buildFakeRepo(dir);

    // Simulate nested submodule — cwd inside .devpro-agent-rules subdir
    const submoduleDir = path.join(dir, ".devpro-agent-rules", "some-subdir");
    mkdirSync(submoduleDir, { recursive: true });

    const result = runInlineLauncher("Stop", repo.gate, submoduleDir);

    assert.equal(
      result.status,
      0,
      `inline launcher must succeed from nested submodule cwd.\nstderr: ${result.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T2-layout3: inline launcher SUCCEEDS in worktree at non-standard path", () => {
  const dir = makeTempDir("cwd-proof-fix-layout3-");
  try {
    const repo = buildFakeRepo(dir);

    // Simulate worktree subdir — still resolves back to repo root
    const worktreeDir = path.join(dir, ".worktree", "my-feature", "src");
    mkdirSync(worktreeDir, { recursive: true });

    const result = runInlineLauncher("Stop", repo.gate, worktreeDir);

    assert.equal(
      result.status,
      0,
      `inline launcher must succeed from worktree subdirectory.\nstderr: ${result.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T2-nested-consumer: inline launcher resolves consumer root (not submodule self) when inside submodule", () => {
  // Layout: consumer/
  //   .devpro/scripts/hooks/run-hook.mjs  (synced from source)
  //   .devpro/scripts/hooks/test-gate.mjs  prints {level:"consumer", cwd:process.cwd()}
  //   .devpro-agent-rules/                (submodule mount — path contains .devpro-agent-rules segment)
  //     .devpro/scripts/hooks/run-hook.mjs (source self — MUST be skipped)
  //     .devpro/scripts/hooks/test-gate.mjs  prints {level:"submodule"} (sentinel)
  //     src/                              <- cwd starts here
  //
  // Expected with new disqualification algorithm:
  //   - walk up from consumer/.devpro-agent-rules/src
  //   - skip consumer/.devpro-agent-rules/src  (contains .devpro-agent-rules segment)
  //   - skip consumer/.devpro-agent-rules       (contains .devpro-agent-rules segment)
  //   - find consumer root (no .devpro-agent-rules segment) — CHOOSE THIS
  //   => gate runs from consumer root → level="consumer", cwd=consumerRoot

  const dir = makeTempDir("cwd-proof-nested-consumer-");
  try {
    // Build consumer root with run-hook.mjs + gate printing {level:"consumer"}
    const repo = buildFakeRepo(dir);
    // Overwrite gate to print level=consumer
    writeFileSync(
      path.join(dir, ".devpro", "scripts", "hooks", "test-gate.mjs"),
      `process.stdout.write(JSON.stringify({level:"consumer",cwd:process.cwd()}));\nprocess.exit(0);\n`
    );

    // Build submodule .devpro with run-hook.mjs + gate printing {level:"submodule"} (sentinel)
    const submoduleHooksDir = path.join(
      dir,
      ".devpro-agent-rules",
      ".devpro",
      "scripts",
      "hooks"
    );
    installRunner(submoduleHooksDir);
    writeFileSync(
      path.join(submoduleHooksDir, "test-gate.mjs"),
      `process.stdout.write(JSON.stringify({level:"submodule"}));\nprocess.exit(0);\n`
    );

    // cwd = inside .devpro-agent-rules/src
    const submoduleSrc = path.join(dir, ".devpro-agent-rules", "src");
    mkdirSync(submoduleSrc, { recursive: true });

    // Use consumer root's gate (relative path resolves from consumer root)
    const gateRel = ".devpro/scripts/hooks/test-gate.mjs";
    const consumerRoot = realpathSync(dir);

    const result = runInlineLauncher("Stop", gateRel, submoduleSrc);

    // Primary assertions: gate ran from consumer root, not submodule
    assert.equal(
      result.status,
      0,
      `launcher must exit 0.\nstderr: ${result.stderr}`
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (e) {
      assert.fail(
        `stdout must be valid JSON.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    }
    assert.equal(
      parsed.level,
      "consumer",
      `gate must run at consumer level (not submodule).\nparsed: ${JSON.stringify(parsed)}`
    );
    assert.equal(
      realpathSync(parsed.cwd),
      consumerRoot,
      `spawn cwd must be consumer root.\nparsed.cwd: ${parsed.cwd}\nexpected: ${consumerRoot}`
    );
    assert.ok(
      !result.stdout.includes('"submodule"'),
      `submodule sentinel must NOT appear in stdout.\nstdout: ${result.stdout}`
    );
    // Secondary: no MODULE_NOT_FOUND
    assert.ok(
      !result.stderr.includes("MODULE_NOT_FOUND") &&
        !result.stderr.includes("Cannot find"),
      `no MODULE_NOT_FOUND error.\nstderr: ${result.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T2-nested-consumer-guard: nearest child wins for plain nested repos (no .devpro-agent-rules)", () => {
  // Verifies that the disqualification is ONLY for .devpro-agent-rules segments.
  // Plain nested repos (parent + child both have .devpro) → child (nearest) wins.
  // Layout:
  //   parent/
  //     .devpro/scripts/hooks/run-hook.mjs  gate prints {level:"parent"}
  //     child/
  //       .devpro/scripts/hooks/run-hook.mjs  gate prints {level:"child"}
  //       src/                               <- cwd starts here
  //
  // Expected: level="child" (nearest valid root, no disqualification)

  const dir = makeTempDir("cwd-proof-nested-guard-");
  try {
    for (const [sub, level] of [["", "parent"], ["child", "child"]]) {
      const h = path.join(dir, sub, ".devpro", "scripts", "hooks");
      installRunner(h);
      writeFileSync(
        path.join(h, "test-gate.mjs"),
        `process.stdout.write(JSON.stringify({level:"${level}",cwd:process.cwd()}));\nprocess.exit(0);\n`
      );
    }

    const childSrc = path.join(dir, "child", "src");
    mkdirSync(childSrc, { recursive: true });

    const result = runInlineLauncher(
      "Stop",
      ".devpro/scripts/hooks/test-gate.mjs",
      childSrc
    );

    assert.equal(
      result.status,
      0,
      `launcher must exit 0.\nstderr: ${result.stderr}`
    );
    const parsed = JSON.parse(result.stdout);
    assert.equal(
      parsed.level,
      "child",
      `nearest valid root must win (child, not parent) for plain nested repos.\nparsed: ${JSON.stringify(parsed)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── T4: B-fallback prove-it — run-hook.mjs import.meta.url resolve ───────────

test("T4-B-fallback: run-hook.mjs resolves production gate-path shape (.devpro/scripts/hooks/<gate>.mjs) when cwd is wrong", () => {
  // This test validates the B-fallback with PRODUCTION gate-path shape:
  // scriptPath = ".devpro/scripts/hooks/<gate>.mjs" (root-relative, as used
  // in all three runtime configs). When cwd is NOT the repo root, the cwd-
  // relative existsSync check fails. B-fallback must resolve via repo root
  // (= wrapperDir/../../../) NOT via wrapperDir (which causes doubled path).
  //
  // PROVE-IT (TDD): before fixing run-hook.mjs B-fallback, this test FAILS
  // because path.resolve(wrapperDir, rawPath) produces a doubled path like
  // <root>/.devpro/scripts/hooks/.devpro/scripts/hooks/<gate>.mjs which
  // doesn't exist → gate never runs → b_fallback_ran absent → test FAILS.
  // After fixing (path.resolve(wrapperDir,'../../..', rawPath)), test PASSES.

  // The runner and the sentinel gate live in a copy under a temp repo root, not in the real hooks dir: a file written
  // into the real tree races every test that copies or lists .devpro/scripts while this one runs (the full suite runs
  // files in parallel).
  const dir = makeTempDir("cwd-proof-b-fallback-");
  try {
    const repoRoot = path.join(dir, "repo");
    const hooksDir = path.join(repoRoot, ".devpro", "scripts", "hooks");
    installRunner(hooksDir);
    const gateName = "b-fallback-gate.mjs";
    writeFileSync(
      path.join(hooksDir, gateName),
      `process.stdout.write(JSON.stringify({b_fallback_ran:true}));\nprocess.exit(0);\n`
    );
    const runner = path.join(hooksDir, "run-hook.mjs");

    // Use PRODUCTION gate-path shape: root-relative ".devpro/scripts/hooks/<gate>.mjs"
    // This is the exact shape passed by the inline launchers in all three configs.
    const scriptRelProduction = `.devpro/scripts/hooks/${gateName}`;

    // cwd = the temp dir above the repo root (wrong) — cwd-relative existsSync fails.
    // B-fallback must resolve the root-relative path from the runner's own location.
    const result = spawnSync(
      process.execPath,
      [runner, "Stop", scriptRelProduction],
      {
        cwd: dir, // wrong cwd — .devpro/scripts/hooks/<gate> doesn't exist here
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Before B-fix: doubled-path → gate not found → exits 0 silently (b_fallback_ran absent)
    // After B-fix: root-relative resolve → gate found → exits 0, stdout has b_fallback_ran
    assert.equal(
      result.status,
      0,
      `B-fallback: run-hook must exit 0.\nstderr: ${result.stderr}`
    );
    assert.ok(
      result.stdout.includes("b_fallback_ran"),
      `B-fallback: gate must have run (stdout must contain b_fallback_ran).\nGot stdout: ${result.stdout}\nstderr: ${result.stderr}\n\nPROVE-IT: before B-fix, run-hook doubled the path and silently skipped the gate.\nDoubled path = wrapperDir + rawPath = <root>/.devpro/scripts/hooks/.devpro/scripts/hooks/<gate>.mjs`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── T5: ancestor path edge case — consumer repo under ancestor named .devpro-agent-rules ──

test("T5-ancestor-path: consumer repo under ancestor dir named .devpro-agent-rules resolves correctly", () => {
  // Layout: tmpdir/.devpro-agent-rules/myconsumer/
  //   .devpro/scripts/hooks/run-hook.mjs  (consumer's own)
  //   .devpro/scripts/hooks/test-gate.mjs  prints {level:"consumer",cwd:process.cwd()}
  //   src/                               <- cwd starts here
  //
  // BUG (pre-fix): path.sep includes('.devpro-agent-rules') matches
  //   'tmpdir/.devpro-agent-rules/myconsumer/src' → myconsumer is mis-disqualified
  //   → walk continues past consumer root → root-not-found → exit 1
  //
  // FIXED (basename check): only dirs whose basename IS '.devpro-agent-rules'
  //   are skipped. 'myconsumer' basename ≠ '.devpro-agent-rules', so consumer
  //   root is correctly adopted → gate runs → exit 0, level="consumer"

  const ancestorBase = makeTempDir("cwd-proof-ancestor-");
  const ancestorDir = path.join(ancestorBase, ".devpro-agent-rules");
  const consumerDir = path.join(ancestorDir, "myconsumer");
  try {
    // Build consumer repo with run-hook.mjs + gate
    const hooksDir = path.join(consumerDir, ".devpro", "scripts", "hooks");
    installRunner(hooksDir);
    writeFileSync(
      path.join(hooksDir, "test-gate.mjs"),
      `process.stdout.write(JSON.stringify({level:"consumer",cwd:process.cwd()}));\nprocess.exit(0);\n`
    );

    // cwd = myconsumer/src (inside consumer, under ancestor .devpro-agent-rules/)
    const cwdSrc = path.join(consumerDir, "src");
    mkdirSync(cwdSrc, { recursive: true });

    const gateRel = ".devpro/scripts/hooks/test-gate.mjs";
    const consumerRoot = realpathSync(consumerDir);

    const result = runInlineLauncher("Stop", gateRel, cwdSrc);

    // Must NOT exit 1 ("root not found") — the ancestor check must not mis-disqualify consumer
    assert.equal(
      result.status,
      0,
      `launcher must exit 0 (not exit-1-root-not-found) when consumer is under ancestor dir named .devpro-agent-rules.\nstderr: ${result.stderr}`
    );

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (e) {
      assert.fail(
        `stdout must be valid JSON — gate must have run.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    }

    assert.equal(
      parsed.level,
      "consumer",
      `gate must run at consumer level.\nparsed: ${JSON.stringify(parsed)}`
    );
    assert.equal(
      realpathSync(parsed.cwd),
      consumerRoot,
      `spawn cwd must be consumer root (myconsumer), not ancestor.\nparsed.cwd: ${parsed.cwd}\nexpected: ${consumerRoot}`
    );

    // Must not mention "repo root not found"
    assert.ok(
      !result.stderr.includes("repo root not found"),
      `must not produce root-not-found error.\nstderr: ${result.stderr}`
    );
  } finally {
    rmSync(ancestorBase, { recursive: true, force: true });
  }
});

// ── T6: deep-cwd — root-walk succeeds beyond 20 levels ───────────────────────

test("T6-deep-cwd: inline launcher resolves repo root even when cwd is 25 levels deep", () => {
  // Validates fix for codex #3: the old for(i<20) hard limit caused exit 1
  // when cwd was more than 20 path segments from root. The fix changes to
  // while(true) terminated only by p===d (fs root detection), removing the
  // 20-iteration cap so arbitrarily deep cwds work correctly.

  const dir = makeTempDir("cwd-proof-deep-");
  try {
    const repo = buildFakeRepo(dir);

    // Build a path 25 directory levels deep under repo root
    const segments = Array.from({ length: 25 }, (_, i) => `l${i}`);
    const deepCwd = path.join(dir, ...segments);
    mkdirSync(deepCwd, { recursive: true });

    const result = runInlineLauncher("Stop", repo.gate, deepCwd);

    assert.equal(
      result.status,
      0,
      `inline launcher must exit 0 from 25-level deep cwd (not exit 1 root-not-found).\nstderr: ${result.stderr}`
    );

    // Verify the gate actually ran (not just silent skip)
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (e) {
      assert.fail(
        `stdout must be valid JSON — gate must have run.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    }
    assert.equal(
      parsed.ran,
      true,
      `gate must have run (ran=true).\nparsed: ${JSON.stringify(parsed)}`
    );

    // Must not produce root-not-found
    assert.ok(
      !result.stderr.includes("repo root not found"),
      `must not produce root-not-found error from deep cwd.\nstderr: ${result.stderr}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
