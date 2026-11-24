/**
 * run-test-suite.test.mjs
 *
 * Prove-it for the tier-selection logic in run-test-suite.mjs: --tier/--changed
 * arg parsing, integration-carrier path classification, and the fail-closed
 * tier selection for a changed-file list.
 */

import { test, describe, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RUN_TEST_SUITE_SCRIPT,
  suiteRuntimeSummaryLines,
} from "../check-suite-runtime-budget.mjs";
import * as runnerModule from "../run-test-suite.mjs";
import { lintManifest } from "../lint-test-suite-manifest.mjs";
import { stripJsCommentSpans, JsCommentSpanScanError } from "../lib/js-comment-spans.mjs";
import {
  FAST_INTEGRATION_TESTS,
  REPO_SWEEP_INTEGRATION_TESTS,
  buildChangedTestExecutionPlan,
  consumerRulesSmokeCommands,
  expandExplicitTier,
  fastIntegrationFiles,
  INTERLEAVED_INTEGRATION_TEST_PRIORITY,
  isConsumerRulesRepoRoot,
  isConsumerRulesTagBase,
  orderFilesForTier,
  parseArgs,
  EXIT_FULL_FALLBACK,
  formatChangedSelectionSummary,
  formatFullFallbackBanner,
  resolveTierFromArgv,
  runNodeCommand,
  runTierSequence,
  summarizeTapLog,
  TIER_FAST,
  maybePrintTransientGitEintrHint,
  emitTransientHintForTierResult,
} from "../run-test-suite.mjs";
import {
  listFiles,
  resolveTier,
  SUITE_DIR,
  TIER_UNIT,
  TIER_INTEGRATION,
} from "../test-suite-manifest.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

// notes/ is gitignored, so a fresh worktree has no notes/tmp until something creates it.
function manifestTempDir(prefix) {
  mkdirSync(repoPath("notes/tmp"), { recursive: true });
  return mkdtempSync(path.join(repoPath("notes/tmp"), prefix));
}
import { makeTempDir } from "./lib/tmp.mjs";

// Grounded in the actual manifest (test-suite-manifest.mjs): tag-shapes.test.mjs
// is "unit", git-utils.test.mjs is "integration".
const KNOWN_UNIT_TEST = `${SUITE_DIR}tag-shapes.test.mjs`;
const KNOWN_NESTED_UNIT_TEST = `${SUITE_DIR}lib/version-helpers.test.mjs`;
const KNOWN_INTEGRATION_TEST = `${SUITE_DIR}git-utils.test.mjs`;
const UNKNOWN_TEST = `${SUITE_DIR}does-not-exist.test.mjs`;
const tmpRoot = makeTempDir("run-test-suite-test-");

function requiredRunnerSeam(name) {
  const seam = runnerModule[name];
  assert.equal(typeof seam, "function", `run-test-suite.mjs must export ${name}`);
  return seam;
}

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * amend-changed-integration-selection-by-reference fixture: scripts, plus
 * integration tests that name a script by full repo-relative path, by basename
 * only, or not at all, a sharded body that names `subject` with one wrapper,
 * and tests that still name a deleted script and the old path of a renamed one.
 * `integrationFiles` is in manifest order.
 */
function makeReferenceFixture(name) {
  const repoRoot = path.join(tmpRoot, name);
  const t = (file) => `${SUITE_DIR}${file}`;
  const scripts = {
    hook: ".devpro/scripts/hooks/example-hook.mjs",
    lib: ".devpro/scripts/lib/example-lib.mjs",
    subject: ".devpro/scripts/lib/shard-subject.mjs",
    removed: ".devpro/scripts/hooks/removed-hook.mjs",
    renamedOld: ".devpro/scripts/lib/old-name.mjs",
    renamedNew: ".devpro/scripts/lib/old-name.cjs",
  };
  const tests = {
    refFull: t("ref-full.test.mjs"),
    refBasename: t("ref-basename.test.mjs"),
    refNone: t("ref-none.test.mjs"),
    refRemoved: t("ref-removed.test.mjs"),
    refRenamedOld: t("ref-renamed-old.test.mjs"),
    shardBody: t("ref-shard-body.test.mjs"),
    shardWrapper: t("ref-shard-body-extra.test.mjs"),
  };
  const sources = {
    [tests.refFull]: `repoPath("${scripts.hook}");\n`,
    [tests.refBasename]: "// mentions example-hook.mjs by basename only\n",
    [tests.refNone]: "// mentions no script\n",
    [tests.refRemoved]: `repoPath("${scripts.removed}");\n`,
    [tests.refRenamedOld]: `repoPath("${scripts.renamedOld}");\n`,
    [tests.shardBody]: [
      'const GROUP = process.env.DEVPRO_REF_SHARD_TEST_GROUP ?? "core";',
      `repoPath("${scripts.subject}");`,
      "export { GROUP };",
      "",
    ].join("\n"),
    [tests.shardWrapper]: [
      'process.env.DEVPRO_REF_SHARD_TEST_GROUP = "extra";',
      "",
      'await import("./ref-shard-body.test.mjs");',
      "",
    ].join("\n"),
  };
  for (const [file, content] of Object.entries(sources)) {
    mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
    writeFileSync(path.join(repoRoot, file), content);
  }
  return { repoRoot, scripts, tests, integrationFiles: Object.values(tests) };
}

function makeConsumerRoot(name) {
  const dir = path.join(tmpRoot, name);
  mkdirSync(path.join(dir, ".devpro-agent-rules", ".devpro", "scripts"), {
    recursive: true,
  });
  writeFileSync(path.join(dir, ".devpro-agent-rules", "AGENTS.md"), "版本：0.0.0\n");
  writeFileSync(
    path.join(dir, ".devpro-agent-rules", ".devpro", "scripts", "sync-agent-rules.mjs"),
    "",
  );
  return dir;
}

function makeDeclaredConsumerRoot(name) {
  const dir = path.join(tmpRoot, name);
  mkdirSync(path.join(dir, ".devpro", "scripts"), { recursive: true });
  writeFileSync(
    path.join(dir, ".gitmodules"),
    [
      '[submodule ".devpro-agent-rules"]',
      "\tpath = .devpro-agent-rules",
      "\turl = https://example.invalid/devpro-agent-rules.git",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(dir, ".devpro", "scripts", "sync-agent-rules.mjs"), "");
  writeFileSync(path.join(dir, ".devpro", "scripts", "devpro-doctor.mjs"), "");
  return dir;
}

const GROUP_RANGES_DECL_RE =
  /^\s*const\s+\w+_TEST_GROUP_RANGES\s*=\s*Object\.freeze\(\{/m;
const GROUP_RANGES_KEY_RE = /^\s*(?:['"](\w+)['"]|(\w+))\s*:/gm;
const FAMILY_ENV_RE = /process\.env\.(DEVPRO_\w+_TEST_GROUP)/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFrozenObjectBody(source, declMatch) {
  const openIdx = source.indexOf("{", source.indexOf(declMatch));
  if (openIdx === -1) {
    return "";
  }
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIdx + 1, i);
      }
    }
  }
  return "";
}

function parseGroupKeys(objectBody) {
  const keys = [];
  for (const match of objectBody.matchAll(GROUP_RANGES_KEY_RE)) {
    keys.push(match[1] ?? match[2]);
  }
  return keys;
}

function wrapperProblems(wrapperSource, { envVar, group, mainFile }) {
  const problems = [];
  const envAssign = new RegExp(
    String.raw`process\.env\.${escapeRegExp(envVar)}\s*=\s*["']${escapeRegExp(group)}["']`,
  );
  if (!envAssign.test(wrapperSource)) {
    problems.push(`missing ${envVar}="${group}" assignment`);
  }
  const importCall = new RegExp(
    String.raw`import\(\s*["']\./${escapeRegExp(mainFile)}["']\s*\)`,
  );
  if (!importCall.test(wrapperSource)) {
    problems.push(`missing import("./${mainFile}")`);
  }
  return problems;
}

/**
 * Lexical residuals under testsDir that stripJsCommentSpans refuses.
 * Exact named list — a file entering or leaving must turn the assert red.
 * None of these carry `*_TEST_GROUP_RANGES` (asserted via raw-source scan).
 */
const EXPECTED_SHARD_DISCOVERY_SCANNER_REJECTS = Object.freeze([
  "architect-new-mode-dissent-grep.test.mjs",
  "archive-timing-cross-doc.test.mjs",
  "batch-approval-ledger.test.mjs",
  "bounded-rereview-manifest-production-grep.test.mjs",
  "branch-naming.test.mjs",
  "clarify-ledger-schema-pointer-grep.test.mjs",
  "codex-subagent-authorization-fallback.test.mjs",
  // Double-backtick sample regexes (``...``) defeat stripJsCommentSpans, so shard
  // discovery skips this file. Listed deliberately: the contract requires every
  // scanner reject to be an explicit expectation.
  "consumer-pre-pr-checks-grep.test.mjs",
  "cross-review-bodyfile-gate-guidance-grep.test.mjs",
  "design-core-leaf.test.mjs",
  "dp-architect-template-alignment.test.mjs",
  "dp-change-classification-routing.test.mjs",
  "dp-change-session-pending-claim-grep.test.mjs",
  "environment-setup-openspec-node-floor-grep.test.mjs",
  "force-push-verify-head-grep.test.mjs",
  "github-policy-artifact.test.mjs",
  "hook-pre-tool-gate-b2.test.mjs",
  "hook-pre-tool-gate-git-flow.test.mjs",
  "hook-pre-tool-gate-lite-scope.test.mjs",
  "hook-runtime-cost-boundary-grep.test.mjs",
  "host-dp-reviewer-primary-second-review-only-v1-grep.test.mjs",
  "lm1-intent-alignment.test.mjs",
  "mandate-executor-kind-dp-pre-pr-grep.test.mjs",
  "mandate-seal-receipt-dp-pre-pr-grep.test.mjs",
  "notes-tmp-lifecycle-grep.test.mjs",
  "opencode-hook-bridge.test.mjs",
  "openspec-flow-fallback-verb-ssot.test.mjs",
  "platform-adapter-codex-gh-auth.test.mjs",
  "post-pr-completion-gate-grep.test.mjs",
  "pre-push-deletion-guard.test.mjs",
  "pre-review-gate-ordering-grep.test.mjs",
  "protected-anchor-grep.test.mjs",
  "protected-branch-pr-only-release-carriers.test.mjs",
  "render-second-review-external-ticket.test.mjs",
  "review-requirement-anchoring-grep.test.mjs",
  "reviewer-issue-context-grep.test.mjs",
  "rule-feedback-issues-grep.test.mjs",
  // rules-lane-alignment-grep.test.mjs left the list when its carrier ancestry repair test changed the
  // backtick count in its regex literals (the scanner reads those backticks as template delimiters).
  "rules-rigor-level.test.mjs",
  "runtime-parity-preflight-grep.test.mjs",
  "second-reviewer-skill-family-parity-grep.test.mjs",
  "session-start-hookspath-install.test.mjs",
  "spec-delta-requirement-mode-grep.test.mjs",
  "sql-index-design-rule-guard.test.mjs",
  "strengthen-matt-skill-mechanisms-grep.test.mjs",
  "strengthen-pre-change-clarification-grep.test.mjs",
  "subagent-prompt-routing.test.mjs",
  "subagent-status-vocabulary.test.mjs",
  "sync-agent-rules-gitattributes-derive.test.mjs",
  "validate-second-review-packet.test.mjs",
]);

function discoverShardFamilyMains(testsDir) {
  const familyMains = [];
  const scannerRejects = [];
  for (const name of readdirSync(testsDir)) {
    if (!name.endsWith(".test.mjs")) {
      continue;
    }
    const raw = readFileSync(path.join(testsDir, name), "utf8");
    let source;
    try {
      source = stripJsCommentSpans(raw);
    } catch (error) {
      if (!(error instanceof JsCommentSpanScanError)) throw error;
      scannerRejects.push(name);
      continue;
    }
    if (GROUP_RANGES_DECL_RE.test(source)) {
      familyMains.push(name);
    }
  }
  return { familyMains, scannerRejects: scannerRejects.sort() };
}

function listDiscoveredShardFamilyMains(testsDir) {
  return discoverShardFamilyMains(testsDir).familyMains;
}

/**
 * Discover every `const <NAME>_TEST_GROUP_RANGES = Object.freeze({...})` family
 * under testsDir and report non-`core` groups that lack an executable wrapper.
 * Iterates discovered keys; does not hardcode a per-family wrapper filename list.
 */
function collectMissingShardGroupWrappers(testsDir, { checkTier } = {}) {
  const missing = [];

  for (const mainFile of listDiscoveredShardFamilyMains(testsDir)) {
    let source;
    try {
      source = stripJsCommentSpans(readFileSync(path.join(testsDir, mainFile), "utf8"));
    } catch (error) {
      if (!(error instanceof JsCommentSpanScanError)) throw error;
      throw new Error(
        `shard family main ${mainFile} became unparseable mid-scan; expected reject list is owned by discoverShardFamilyMains`,
      );
    }
    const declMatch = source.match(GROUP_RANGES_DECL_RE);
    if (!declMatch) {
      continue;
    }

    const groups = parseGroupKeys(extractFrozenObjectBody(source, declMatch[0]));
    const envVar = source.match(FAMILY_ENV_RE)?.[1];
    const stem = mainFile.slice(0, -".test.mjs".length);

    for (const group of groups) {
      if (group === "core") {
        continue;
      }

      const wrapperFile = `${stem}-${group.replaceAll("_", "-")}.test.mjs`;
      const wrapperPath = path.join(testsDir, wrapperFile);
      const problems = [];

      if (!existsSync(wrapperPath)) {
        problems.push(`missing wrapper ${wrapperFile}`);
      } else {
        if (!envVar) {
          problems.push("missing process.env.DEVPRO_*_TEST_GROUP in main file");
        } else {
          problems.push(
            ...wrapperProblems(readFileSync(wrapperPath, "utf8"), {
              envVar,
              group,
              mainFile,
            }),
          );
        }
        if (checkTier) {
          try {
            if (resolveTier(wrapperFile) !== TIER_INTEGRATION) {
              problems.push(`${wrapperFile} is not ${TIER_INTEGRATION}-tier`);
            }
          } catch {
            problems.push(`${wrapperFile} is not in the test-suite manifest`);
          }
        }
      }

      if (problems.length > 0) {
        missing.push({
          group,
          mainFile,
          wrapperFile,
          reason: problems.join("; "),
        });
      }
    }
  }

  return missing;
}

function formatMissingShardGroupWrappers(missing) {
  return missing
    .map((item) => `${item.group}: ${item.reason ?? "missing wrapper"}`)
    .join("\n");
}

describe("parseArgs", () => {
  test("no flags → all tier, no changedBase", () => {
    assert.deepEqual(parseArgs([], { repoRoot: REPO_ROOT }), {
      tier: "all",
      changedBase: null,
      repoRoot: REPO_ROOT,
      allowFullFallback: false,
      stdioMode: "log",
    });
  });

  test("--tier unit → unit tier, no changedBase", () => {
    assert.deepEqual(parseArgs(["--tier", "unit"], { repoRoot: REPO_ROOT }), {
      tier: "unit",
      changedBase: null,
      repoRoot: REPO_ROOT,
      allowFullFallback: false,
      stdioMode: "log",
    });
  });

  test("--tier fast → explicit fast tier, no changedBase", () => {
    assert.deepEqual(parseArgs(["--tier", "fast"], { repoRoot: REPO_ROOT }), {
      tier: "fast",
      changedBase: null,
      repoRoot: REPO_ROOT,
      allowFullFallback: false,
      stdioMode: "log",
    });
  });

  test("--changed main → no tier, changedBase main", () => {
    assert.deepEqual(parseArgs(["--changed", "main"], { repoRoot: REPO_ROOT }), {
      tier: null,
      changedBase: "main",
      repoRoot: REPO_ROOT,
      allowFullFallback: false,
      stdioMode: "log",
    });
  });

  test("--stdio inherit preserves explicit raw-console mode", () => {
    assert.deepEqual(parseArgs(["--changed", "main", "--stdio", "inherit"], { repoRoot: REPO_ROOT }), {
      tier: null,
      changedBase: "main",
      repoRoot: REPO_ROOT,
      allowFullFallback: false,
      stdioMode: "inherit",
    });
  });

  test("--stdio rejects unknown modes", () => {
    assert.throws(
      () => parseArgs(["--stdio", "pipe"], { repoRoot: REPO_ROOT }),
      /--stdio requires one of: log, inherit/,
    );
  });

  test("--stdio with no value throws", () => {
    assert.throws(
      () => parseArgs(["--stdio"], { repoRoot: REPO_ROOT }),
      /--stdio requires one of: log, inherit/,
    );
  });

  test("--tier and --changed together throws", () => {
    assert.throws(
      () => parseArgs(["--tier", "unit", "--changed", "main"], { repoRoot: REPO_ROOT }),
      /mutually exclusive/,
    );
  });

  test("--changed with no ref throws", () => {
    assert.throws(
      () => parseArgs(["--changed"], { repoRoot: REPO_ROOT }),
      /--changed requires a base ref/,
    );
  });

  test("Scenario: Source Integration Manifest Runs Only Valid Tier Files After Preflight", () => {
    assert.deepEqual(
      parseArgs(
        ["--tier", "integration", "--integration-manifest", "notes/tmp/exact-files.list"],
        { repoRoot: REPO_ROOT },
      ),
      {
        tier: "integration",
        changedBase: null,
        integrationManifestPath: "notes/tmp/exact-files.list",
        repoRoot: REPO_ROOT,
        allowFullFallback: false,
        stdioMode: "log",
      },
    );
  });

  test("Scenario: Invalid Or Consumer Integration Manifest Fails Before Any Tier Spawn", () => {
    for (const args of [
      ["--integration-manifest"],
      ["--tier", "unit", "--integration-manifest", "notes/tmp/files.list"],
      ["--tier", "fast", "--integration-manifest", "notes/tmp/files.list"],
      ["--tier", "all", "--integration-manifest", "notes/tmp/files.list"],
      ["--tier", "integration", "--changed", "main", "--integration-manifest", "notes/tmp/files.list"],
      ["--tier", "integration", "--root", "somewhere", "--integration-manifest", "notes/tmp/files.list"],
    ]) {
      assert.throws(() => parseArgs(args, { repoRoot: REPO_ROOT }));
    }

    const assertSourceOnlyManifestRoute = requiredRunnerSeam("assertSourceOnlyManifestRoute");
    assert.doesNotThrow(() =>
      assertSourceOnlyManifestRoute({
        integrationManifestPath: "notes/tmp/files.list",
        route: "source-suite",
      }),
    );
    assert.throws(
      () =>
        assertSourceOnlyManifestRoute({
          integrationManifestPath: "notes/tmp/files.list",
          route: "consumer-na",
        }),
      /source-suite only/i,
    );
    assert.throws(
      () =>
        assertSourceOnlyManifestRoute({
          integrationManifestPath: "notes/tmp/files.list",
          route: "consumer-smoke",
        }),
      /source-suite only/i,
    );
  });
});

describe("source suite preflight dispatch", () => {
  function makeSourceCheckoutFixture(name, markers) {
    const fixtureRoot = path.join(tmpRoot, name);
    mkdirSync(path.join(fixtureRoot, ".devpro", "scripts"), { recursive: true });
    for (const marker of markers) {
      writeFileSync(path.join(fixtureRoot, marker), "fixture marker\n");
    }
    const init = spawnSync("git", ["init", "--quiet", fixtureRoot], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    return fixtureRoot;
  }

  function runSourceFixture(fixtureRoot) {
    return spawnSync(
      process.execPath,
      [
        repoPath(".devpro/scripts/run-test-suite.mjs"),
        "--tier",
        "unit",
        "--root",
        fixtureRoot,
        "--stdio",
        "log",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 20_000 },
    );
  }

  test("Scenario: Invalid Checkout Fails Before Tier Spawn", () => {
    const fixtureRoot = makeSourceCheckoutFixture("invalid-source-checkout", [
      ".devpro/scripts/sync-agent-rules.mjs",
      ".devpro/scripts/test-suite-manifest.mjs",
    ]);
    const result = runSourceFixture(fixtureRoot);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `${output}`);
    assert.match(output, /checkout-preflight=FAIL/);
    assert.doesNotMatch(output, /\[test-suite\] tier=unit/);
  });

  test("Scenario: POSIX Common-Check Failure Stops Before Tier Spawn", () => {
    const source = readFileSync(repoPath(".devpro/scripts/run-test-suite.mjs"), "utf8");
    const failureExit = source.indexOf(
      "if (checkoutPreflightStatus !== 0) process.exit(checkoutPreflightStatus)",
    );
    const tierDispatch = source.indexOf("const status = runTier(", failureExit);
    assert.ok(failureExit >= 0, "a failed common preflight must exit the source route");
    assert.ok(tierDispatch > failureExit, "no tier may spawn after a failed common check");
  });

  test("Scenario: Source Root Missing A Required Marker Fails Closed", () => {
    const fixtureRoot = makeSourceCheckoutFixture("partial-source-checkout", [
      ".devpro/scripts/sync-agent-rules.mjs",
    ]);
    const result = runSourceFixture(fixtureRoot);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `${output}`);
    assert.match(output, /checkout-preflight=FAIL/);
    assert.doesNotMatch(output, /checkout-preflight=skip/);
    assert.doesNotMatch(output, /\[test-suite\] tier=unit/);
  });

  test("Scenario: Corrected Native-Windows Checkout Passes Preflight Before Selected Tiers", () => {
    const source = readFileSync(repoPath(".devpro/scripts/run-test-suite.mjs"), "utf8");
    const preflight = source.indexOf("runWindowsCheckoutPreflight({ repoRoot })");
    const tierDispatch = source.indexOf("const status = runTier(", preflight);
    assert.ok(preflight >= 0, "canonical source runner must call checkout preflight");
    assert.ok(tierDispatch > preflight, "preflight must precede selected tier dispatch");
  });
});

describe("source-only integration manifest", () => {
  test("Scenario: Source Integration Manifest Runs Only Valid Tier Files After Preflight", () => {
    const source = readFileSync(repoPath(".devpro/scripts/run-test-suite.mjs"), "utf8");
    const formatManifestSelection = requiredRunnerSeam("formatIntegrationManifestSelection");
    const preflight = source.indexOf(
      "const checkoutPreflightStatus = runWindowsCheckoutPreflight({ repoRoot })",
    );
    const manifestValidation = source.indexOf(
      "integrationFilesOverride = readIntegrationManifestFiles(",
      preflight,
    );
    const manifestReport = source.indexOf(
      "console.log(formatIntegrationManifestSelection(",
      manifestValidation,
    );
    const tierDispatch = source.indexOf("const status = runTier(", preflight);
    assert.ok(preflight >= 0, "canonical source runner must call checkout preflight");
    assert.ok(manifestValidation >= 0, "source runner must resolve the explicit manifest");
    assert.ok(manifestValidation > preflight, "manifest validation must follow source preflight");
    assert.ok(manifestReport > manifestValidation, "manifest selection provenance must be reported after validation");
    assert.ok(tierDispatch > manifestReport, "manifest-selected child must follow validation and provenance output");

    const readIntegrationManifestFiles = requiredRunnerSeam("readIntegrationManifestFiles");
    const manifestDir = manifestTempDir("suite-manifest-test-");
    try {
      const manifestPath = path.join(manifestDir, "integration-files.list");
      writeFileSync(manifestPath, `${KNOWN_INTEGRATION_TEST}\n`);
      const files = readIntegrationManifestFiles(path.relative(REPO_ROOT, manifestPath), {
        repoRoot: REPO_ROOT,
      });
      assert.deepEqual(files, [KNOWN_INTEGRATION_TEST]);
      assert.equal(files.every((file) => resolveTier(file.slice(SUITE_DIR.length)) === TIER_INTEGRATION), true);
      assert.equal(
        formatManifestSelection("notes/tmp/exact-files.list", files),
        "[test-suite] integration selection=explicit-manifest manifest=notes/tmp/exact-files.list files=1",
      );

      const capturedSpawnPath = path.join(manifestDir, "captured-spawn.json");
      const preloadPath = path.join(manifestDir, "capture-test-child.cjs");
      writeFileSync(
        preloadPath,
        [
          'const childProcess = require("node:child_process");',
          'const { syncBuiltinESMExports } = require("node:module");',
          "const realSpawnSync = childProcess.spawnSync;",
          "childProcess.spawnSync = function (command, args, options) {",
          '  if (command === process.execPath && Array.isArray(args) && args[0] === "--test") {',
          '    require("node:fs").writeFileSync(process.env.DEVPRO_TEST_SUITE_CAPTURE_PATH, JSON.stringify({ command, args, cwd: options?.cwd ?? null }));',
          "    return { status: 0, signal: null, error: undefined };",
          "  }",
          "  return realSpawnSync(command, args, options);",
          "};",
          "syncBuiltinESMExports();",
          "",
        ].join("\n"),
      );

      const manifestRepoPath = path.relative(REPO_ROOT, manifestPath).split(path.sep).join("/");
      const execution = spawnSync(
        process.execPath,
        [
          "--require",
          preloadPath,
          repoPath(".devpro/scripts/run-test-suite.mjs"),
          "--tier",
          "integration",
          "--integration-manifest",
          manifestRepoPath,
          "--stdio",
          "inherit",
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            DEVPRO_TEST_SUITE_CAPTURE_PATH: capturedSpawnPath,
          },
        },
      );
      const executionOutput = `${execution.stdout}\n${execution.stderr}`;
      assert.equal(execution.error, undefined, executionOutput);
      assert.equal(execution.status, 0, executionOutput);
      const preflightReport = execution.stdout.indexOf("[test-suite] checkout-preflight=pass");
      const manifestReport = execution.stdout.indexOf(
        `[test-suite] integration selection=explicit-manifest manifest=${manifestRepoPath} files=1`,
      );
      const tierSpawnReport = execution.stdout.indexOf("[test-suite] tier=integration files=1");
      assert.ok(preflightReport >= 0, "the runner must report successful checkout preflight");
      assert.ok(manifestReport > preflightReport, "manifest provenance must follow checkout preflight");
      assert.ok(tierSpawnReport > manifestReport, "the selected tier must start after manifest reporting");

      const capturedSpawn = JSON.parse(readFileSync(capturedSpawnPath, "utf8"));
      assert.equal(capturedSpawn.command, process.execPath);
      assert.equal(capturedSpawn.cwd, REPO_ROOT);
      assert.deepEqual(
        capturedSpawn.args,
        ["--test", KNOWN_INTEGRATION_TEST],
        "the integration child must receive only manifest-listed paths",
      );
    } finally {
      rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  test("Scenario: Invalid Or Consumer Integration Manifest Fails Before Any Tier Spawn", () => {
    const readIntegrationManifestFiles = requiredRunnerSeam("readIntegrationManifestFiles");
    const manifestDir = manifestTempDir("suite-manifest-invalid-test-");
    try {
      const manifestPath = path.join(manifestDir, "integration-files.list");
      const repoRelativePath = path.relative(REPO_ROOT, manifestPath);
      const invalidManifests = [
        "",
        `${KNOWN_INTEGRATION_TEST}\n\n`,
        `${KNOWN_INTEGRATION_TEST}\n${KNOWN_INTEGRATION_TEST}\n`,
        `${KNOWN_UNIT_TEST}\n`,
        `${UNKNOWN_TEST}\n`,
        `${path.resolve(REPO_ROOT, KNOWN_INTEGRATION_TEST)}\n`,
        "../outside.test.mjs\n",
      ];
      for (const content of invalidManifests) {
        writeFileSync(manifestPath, content);
        assert.throws(
          () => readIntegrationManifestFiles(repoRelativePath, { repoRoot: REPO_ROOT }),
          `invalid manifest should reject ${JSON.stringify(content)}`,
        );
      }
      writeFileSync(manifestPath, `${KNOWN_INTEGRATION_TEST}\n`);
      assert.throws(
        () => readIntegrationManifestFiles(path.resolve(tmpRoot, "outside.list"), { repoRoot: REPO_ROOT }),
        /inside the repository/i,
      );
    } finally {
      rmSync(manifestDir, { recursive: true, force: true });
    }
  });
});

describe("stdio log mode", () => {
  test("runNodeCommand writes child stdout/stderr to notes/tmp log by default", () => {
    const result = runNodeCommand(
      [
        "-e",
        "console.log('ok 1 - tiny'); console.log('# tests 1'); console.log('# pass 1'); console.log('# fail 0'); console.error('stderr marker');",
      ],
      { repoRoot: tmpRoot, stdioMode: "log", logLabel: "unit-test" },
    );

    assert.equal(result.status, 0);
    assert.equal(result.error, null);
    assert.equal(existsSync(result.logPath), true);
    assert.match(result.logPath.replaceAll("\\", "/"), /notes\/tmp\/run-test-suite-unit-test\./);
    assert.equal(result.summary.tests, 1);
    assert.equal(result.summary.pass, 1);
    assert.equal(result.summary.fail, 0);

    const body = readFileSync(result.logPath, "utf8");
    assert.match(body, /ok 1 - tiny/);
    assert.match(body, /stderr marker/);
  });

  test("summarizeTapLog extracts failed test names without dumping TAP", () => {
    const dir = path.join(tmpRoot, "summary");
    mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "tap.log");
    writeFileSync(
      logPath,
      [
        "not ok 3 - failing case",
        "# tests 4",
        "# pass 3",
        "# fail 1",
        "",
      ].join("\n"),
    );

    const summary = summarizeTapLog(logPath);
    assert.equal(summary.tests, 4);
    assert.equal(summary.pass, 3);
    assert.equal(summary.fail, 1);
    assert.equal(
      summary.digestSha256,
      createHash("sha256").update(readFileSync(logPath)).digest("hex"),
      "summary binds the exact raw log bytes",
    );
    assert.deepEqual(summary.failedNames, ["failing case"]);
  });

  test("summarizeTapLog reads counts and failed names from a spec-reporter log", () => {
    // Node 24 prints the spec format even when output is redirected to a file; these
    // lines are copied from a real `node --test --test-reporter=spec` run.
    const dir = path.join(tmpRoot, "summary-spec");
    mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "spec.log");
    writeFileSync(
      logPath,
      [
        "\u2714 top passes (0.436ms)",
        "\u2716 top fails here (0.517834ms)",
        "\u25b6 group",
        "  \u2716 inner fails (4.022292ms)",
        "  \u2714 inner ok (0.067334ms)",
        "\u2716 group (4.229166ms)",
        "\ufe63 skipped one (0.052917ms) # SKIP",
        "\u2139 tests 5",
        "\u2139 suites 1",
        "\u2139 pass 2",
        "\u2139 fail 2",
        "\u2139 cancelled 0",
        "\u2139 skipped 1",
        "\u2139 todo 0",
        "\u2139 duration_ms 66.524917",
        "",
        "\u2716 failing tests:",
        "",
        "test at a.test.mjs:4:1",
        "\u2716 top fails here (0.517834ms)",
        "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
        "",
      ].join("\n"),
    );

    const summary = summarizeTapLog(logPath);
    assert.deepEqual(
      [summary.tests, summary.suites, summary.pass, summary.fail, summary.cancelled, summary.skipped, summary.todo],
      [5, 1, 2, 2, 0, 1, 0],
    );
    assert.deepEqual(
      summary.failedNames,
      ["top fails here", "group"],
      "top-level failures once each, without the duration and without the recap section",
    );
  });

  test("summarizeTapLog keeps a failed test whose name starts like the spec recap heading", () => {
    const dir = path.join(tmpRoot, "summary-spec-heading-lookalike");
    mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "spec.log");
    writeFileSync(
      logPath,
      [
        "\u2716 failing tests: are listed once (1.5ms)",
        "\u2716 later failure (2ms)",
        "\u2139 tests 2",
        "\u2139 fail 2",
        "",
        "\u2716 failing tests:",
        "",
        "\u2716 failing tests: are listed once (1.5ms)",
        "\u2716 later failure (2ms)",
        "",
      ].join("\n"),
    );

    assert.deepEqual(summarizeTapLog(logPath).failedNames, [
      "failing tests: are listed once",
      "later failure",
    ]);
  });

  test("summarizeTapLog leaves counts unknown when the log has neither summary format", () => {
    const dir = path.join(tmpRoot, "summary-none");
    mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "other.log");
    writeFileSync(logPath, ["tests 4", "note: # tests 9 and \u2139 pass 9 mid-line", ""].join("\n"));

    const summary = summarizeTapLog(logPath);
    assert.deepEqual([summary.tests, summary.pass, summary.fail], [null, null, null]);
    assert.deepEqual(summary.failedNames, []);
  });

  test("formatLogSummary exposes the exact digest-bound producer contract", () => {
    const formatLogSummary = requiredRunnerSeam("formatLogSummary");
    assert.equal(
      formatLogSummary({
        scope: "tier",
        label: "unit",
        logPath: "notes/tmp/unit.log",
        summary: {
          lines: 8,
          bytes: 256,
          digestSha256: "a".repeat(64),
          tests: 2,
          pass: 2,
          fail: 0,
          skipped: 0,
          failedNames: [],
        },
      }),
      `[test-suite] tier=unit log=notes/tmp/unit.log lines=8 bytes=256 digest_sha256=${"a".repeat(64)} tests=2 pass=2 fail=0 skipped=0`,
    );
  });
});

describe("stdio inherit mode", () => {
  test("runCommand executes a real child without observing an external notes/tmp symlink", () => {
    const repoRoot = path.join(tmpRoot, "inherit-symlink-repo");
    const outside = path.join(tmpRoot, "inherit-symlink-outside");
    mkdirSync(path.join(repoRoot, "notes"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(repoRoot, "notes", "tmp"), "dir");

    const runCommand = requiredRunnerSeam("runCommand");
    const result = runCommand(process.execPath, ["-e", "process.exit(0)"], {
      repoRoot,
      stdioMode: "inherit",
      logLabel: "must-remain-pathless",
    });

    assert.equal(result.status, 0);
    assert.equal(result.error, null);
    assert.equal(result.logPath, null);
    assert.equal(result.summary, null);
    assert.deepEqual(readdirSync(outside), [], "inherit mode must not create any outside log artifact");
    assert.equal(existsSync(path.join(outside, "command.log")), false);
  });

  test("runCommand injects DEVPRO_FRICTION_LOG under os.tmpdir (P131/F-4)", () => {
    const runCommand = requiredRunnerSeam("runCommand");
    const suiteOwnedFrictionEnv = requiredRunnerSeam("suiteOwnedFrictionEnv");
    const probe = suiteOwnedFrictionEnv({ suiteToken: "unit-probe" });
    assert.ok(probe.DEVPRO_FRICTION_LOG.startsWith(tmpdir()));
    assert.equal(probe.DEVPRO_FRICTION_LOG.includes(`${path.sep}notes${path.sep}tmp`), false);

    const repoRoot = path.join(tmpRoot, "friction-env-repo");
    mkdirSync(repoRoot, { recursive: true });
    const result = runCommand(
      process.execPath,
      [
        "-e",
        "const p=process.env.DEVPRO_FRICTION_LOG; if(!p||!p.includes('devpro-suite-friction-')) process.exit(3); if(p.includes('/notes/tmp')||p.includes('\\\\notes\\\\tmp')) process.exit(4); process.exit(0);",
      ],
      { repoRoot, stdioMode: "inherit", logLabel: "friction-env" },
    );
    assert.equal(result.status, 0, "suite child must receive owned DEVPRO_FRICTION_LOG");
    // Direct suiteOwnedFrictionEnv probe is caller-owned; runCommand tears down its own dir.
    rmSync(path.dirname(probe.DEVPRO_FRICTION_LOG), { recursive: true, force: true });
  });

  test("runCommand tears down its owned friction dir after the child exits (F3)", () => {
    const runCommand = requiredRunnerSeam("runCommand");
    const repoRoot = path.join(tmpRoot, "friction-teardown-repo");
    mkdirSync(repoRoot, { recursive: true });
    const markerPath = path.join(repoRoot, "friction-path.txt");
    const result = runCommand(
      process.execPath,
      [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, process.env.DEVPRO_FRICTION_LOG);`,
      ],
      { repoRoot, stdioMode: "inherit", logLabel: "friction-teardown" },
    );
    assert.equal(result.status, 0, result.error?.message);
    const frictionLog = readFileSync(markerPath, "utf8");
    assert.ok(frictionLog.includes("devpro-suite-friction-"));
    assert.equal(
      existsSync(path.dirname(frictionLog)),
      false,
      "runCommand must remove the owned friction directory after the child exits",
    );
  });

  test("runCommand gives the child its own temp root and removes what the child left there", () => {
    const runCommand = requiredRunnerSeam("runCommand");
    const repoRoot = path.join(tmpRoot, "owned-tmp-repo");
    mkdirSync(repoRoot, { recursive: true });
    const markerPath = path.join(repoRoot, "leaked-dir.txt");
    const result = runCommand(
      process.execPath,
      [
        "-e",
        // The child leaks a temp directory on purpose, the way most suite files do.
        `const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const d=fs.mkdtempSync(path.join(os.tmpdir(),'leaky-test-'));fs.writeFileSync(path.join(d,'f'),'x');fs.writeFileSync(${JSON.stringify(markerPath)}, d);`,
      ],
      { repoRoot, stdioMode: "inherit", logLabel: "owned-tmp" },
    );
    assert.equal(result.status, 0, result.error?.message);
    const leakedDir = readFileSync(markerPath, "utf8");
    const ownedRoot = path.dirname(leakedDir);
    assert.ok(
      path.basename(ownedRoot).startsWith("devpro-suite-tmp-"),
      `child os.tmpdir() must be the runner-owned temp root, got ${ownedRoot}`,
    );
    assert.equal(path.dirname(ownedRoot), tmpdir(), "the owned temp root lives directly under the runner's os.tmpdir()");
    assert.equal(existsSync(leakedDir), false, "a temp directory the child never cleaned must be gone after runCommand");
    assert.equal(existsSync(ownedRoot), false, "runCommand must remove its owned temp root after the child exits");
  });
});

describe("runtime budget summary", () => {
  test("runtime budget helper uses the manifest runner", () => {
    assert.equal(RUN_TEST_SUITE_SCRIPT, ".devpro/scripts/run-test-suite.mjs");
  });

  test("runtime budget helper relays compact runner summary only", () => {
    const lines = suiteRuntimeSummaryLines(
      [
        "raw TAP line",
        "[test-suite] tier=unit real=2.4s status=pass",
        "# tests 2035",
        "[test-suite] tier=all real=65.6s status=pass",
        "",
      ].join("\n"),
    );

    assert.deepEqual(lines, [
      "[test-suite] tier=unit real=2.4s status=pass",
      "[test-suite] tier=all real=65.6s status=pass",
    ]);
  });

  test("runtime budget helper relays consumer source-maintainer N/A summary", () => {
    const line =
      "[test-suite] source-maintainer checks: N/A reason=consumer repository profile; source-only corpus checks are not required";

    assert.deepEqual(suiteRuntimeSummaryLines(`${line}\n`), [line]);
  });
});

describe("resolveTierFromArgv", () => {
  test("returns the .tier field", () => {
    assert.equal(resolveTierFromArgv([]), "all");
    assert.equal(resolveTierFromArgv(["--tier", "unit"]), "unit");
    assert.equal(resolveTierFromArgv(["--tier", "integration"]), "integration");
    assert.equal(resolveTierFromArgv(["--tier", "fast"]), "fast");
  });
});

describe("expandExplicitTier", () => {
  test("all tier expands to sequential manifest tiers", () => {
    assert.deepEqual(expandExplicitTier("all"), [TIER_UNIT, TIER_INTEGRATION]);
  });

  test("single tiers stay single", () => {
    assert.deepEqual(expandExplicitTier("unit"), [TIER_UNIT]);
    assert.deepEqual(expandExplicitTier("integration"), [TIER_INTEGRATION]);
  });

  test("fast tier expands to complete unit plus the bounded fast carrier tier", () => {
    assert.deepEqual(expandExplicitTier(TIER_FAST), [TIER_UNIT, TIER_FAST]);
  });

  test("all tier implementation does not fall back to raw suite directory", () => {
    const source = readFileSync(
      repoPath(".devpro/scripts/run-test-suite.mjs"),
      "utf8",
    );
    assert.doesNotMatch(source, /files\s*=\s*\[\s*SUITE_DIR\s*\]/);
    assert.match(source, /expandExplicitTier\("all"\)/);
  });

  test("tier sequence keeps running after an earlier tier fails", () => {
    const calls = [];
    const status = runTierSequence([TIER_UNIT, TIER_INTEGRATION], (tier) => {
      calls.push(tier);
      return tier === TIER_UNIT ? 1 : 0;
    });

    assert.deepEqual(calls, [TIER_UNIT, TIER_INTEGRATION]);
    assert.equal(status, 1);
  });
});

describe("orderFilesForTier", () => {
  test("prioritizes long integration tests so tail-heavy files start early", () => {
    const files = [
      ".devpro/scripts/tests/ack-second-reviewer-projection.test.mjs",
      ".devpro/scripts/tests/pre-pr-archive-gate.test.mjs",
      ".devpro/scripts/tests/run-second-reviewer-projection-runner-b.test.mjs",
      ".devpro/scripts/tests/sync-agent-rules-check.test.mjs",
      ".devpro/scripts/tests/hook-pre-tool-gate-a2.test.mjs",
      ".devpro/scripts/tests/run-second-reviewer-projection.test.mjs",
      ".devpro/scripts/tests/run-second-reviewer-projection-ownership.test.mjs",
      ".devpro/scripts/tests/run-second-reviewer-projection-runner-a.test.mjs",
      ".devpro/scripts/tests/render-second-review-packet.test.mjs",
      ".devpro/scripts/tests/sync-agent-rules-uninstall-b.test.mjs",
      ".devpro/scripts/tests/sync-agent-rules-git-flow.test.mjs",
      ".devpro/scripts/tests/sync-agent-rules-d.test.mjs",
      ".devpro/scripts/tests/sync-agent-rules-full-source.test.mjs",
      ".devpro/scripts/tests/sync-agent-rules-auto-compact-check.test.mjs",
      ".devpro/scripts/tests/sync-agent-rules.test.mjs",
      ".devpro/scripts/tests/sync-agent-rules-workflows.test.mjs",
      ".devpro/scripts/tests/sync-agent-rules-uninstall.test.mjs",
      ".devpro/scripts/tests/sync-agent-rules-e.test.mjs",
      ".devpro/scripts/tests/git-utils.test.mjs",
    ];

    const ordered = orderFilesForTier(TIER_INTEGRATION, files);

    // Assert the invariant, not a hand-pasted literal: this keeps the test
    // valid across future re-measure/re-sorts of the priority list (see
    // test-performance-patterns.md (e)) instead of needing a matching edit
    // every time durations are re-measured.
    assert.deepEqual(
      new Set(ordered),
      new Set(files),
      "order must be a permutation of the input, not a different file set",
    );

    const priorityIndex = new Map(
      INTERLEAVED_INTEGRATION_TEST_PRIORITY.map((file, index) => [file, index]),
    );
    const orderedPriorityFiles = ordered.filter((file) => priorityIndex.has(file));
    const orderedNonPriorityFiles = ordered.filter((file) => !priorityIndex.has(file));

    assert.deepEqual(
      ordered.slice(0, orderedPriorityFiles.length),
      orderedPriorityFiles,
      "every priority-listed file must precede every non-priority file",
    );
    assert.deepEqual(
      [...orderedPriorityFiles].sort(
        (a, b) => priorityIndex.get(a) - priorityIndex.get(b),
      ),
      orderedPriorityFiles,
      "priority-listed files must appear in INTERLEAVED_INTEGRATION_TEST_PRIORITY order",
    );

    const inputNonPriorityOrder = files.filter((file) => !priorityIndex.has(file));
    assert.deepEqual(
      orderedNonPriorityFiles,
      inputNonPriorityOrder,
      "non-priority files must keep their original relative order",
    );
  });

  // Companion guard for the assertions directly above. Those key on
  // `priorityIndex.has(file)`, so a priority entry that is misspelled -- or whose
  // file was later renamed or retiered -- simply never matches: it becomes silent
  // dead weight that stops shortening the critical path while every test stays
  // green. The hand-pasted literal array this file used to assert against would
  // have failed on such an entry; these assertions restore that detection without
  // re-pinning the order (which is what made the literal costly to maintain).
  test("every INTERLEAVED_INTEGRATION_TEST_PRIORITY entry is a real integration-tier file", () => {
    assert.equal(
      new Set(INTERLEAVED_INTEGRATION_TEST_PRIORITY).size,
      INTERLEAVED_INTEGRATION_TEST_PRIORITY.length,
      "priority list must not contain duplicate entries",
    );

    for (const file of INTERLEAVED_INTEGRATION_TEST_PRIORITY) {
      assert.ok(
        file.startsWith(SUITE_DIR),
        `priority entry must live under ${SUITE_DIR}: ${file}`,
      );
      // resolveTier throws on a filename the manifest does not know, which is
      // exactly the typo/rename case; surface it as a named failure instead of
      // letting the raw throw escape.
      const manifestKey = file.slice(SUITE_DIR.length);
      assert.doesNotThrow(
        () => resolveTier(manifestKey),
        `priority entry is not in the test-suite manifest (typo or renamed file?): ${file}`,
      );
      assert.equal(
        resolveTier(manifestKey),
        TIER_INTEGRATION,
        `the priority list only orders the integration tier, but ${file} is not integration-tier`,
      );
    }
  });

  test("leaves non-integration tier order unchanged", () => {
    const files = [
      ".devpro/scripts/tests/sync-agent-rules-check.test.mjs",
      ".devpro/scripts/tests/tag-shapes.test.mjs",
    ];

    assert.deepEqual(orderFilesForTier(TIER_UNIT, files), files);
  });

  test("run-second-reviewer-projection samples split into file-level wrapper groups", () => {
    const source = readFileSync(
      repoPath(".devpro/scripts/tests/run-second-reviewer-projection.test.mjs"),
      "utf8",
    );
    const testRegistrationSiteCount = source.match(/^\s*test\(/gm)?.length ?? 0;

    // Source registration-site count after merge of origin/main + strengthen-reviewer-model-selection
    // model-record tests. reviewer_home end tracks executed indices (may exceed source count
    // when template-literal multi-register inflation applies); current end=323.
    assert.equal(testRegistrationSiteCount, 307);
    assert.match(source, /DEVPRO_SECOND_REVIEWER_PROJECTION_TEST_GROUP/);
    assert.match(source, /PROJECTION_TEST_GROUP_RANGES/);
    assert.match(source, /core:\s*\[1,\s*48\]/);
    assert.match(source, /runner_a:\s*\[49,\s*91\]/);
    assert.match(source, /runner_b:\s*\[92,\s*119\]/);
    assert.match(source, /ownership:\s*\[120,\s*137\]/);
    assert.match(source, /reconcile:\s*\[138,\s*166\]/);
    assert.match(source, /reviewer_home:\s*\[167,\s*322\]/);
    // The R9 "unreachable from every automated carrier" sweep lives in its own
    // small file so `--changed` can run it on every PR without this body.
    assert.doesNotMatch(source, /R9 reconciliation is unreachable from every automated carrier/);
    assert.match(source, /nodeTest\(name,\s*optionsOrFn,\s*maybeFn\)/);
    assert.doesNotMatch(source, /bounded integration samples/);
  });

  test("Scenario: Suite Fail Path Hint Helper Is Driveable", () => {
    const lines = [];
    assert.equal(
      maybePrintTransientGitEintrHint({
        status: 1,
        logText: "fatal: unable to open loose object ab: Interrupted system call",
        writeErr: (msg) => lines.push(msg),
      }),
      true,
    );
    assert.match(lines.join("\n"), /transient-git-eintr/);
    lines.length = 0;
    assert.equal(
      maybePrintTransientGitEintrHint({
        status: 1,
        logText: "AssertionError [ERR_ASSERTION]: expected EINTR retry",
        writeErr: (msg) => lines.push(msg),
      }),
      false,
    );
    assert.equal(lines.length, 0);
    assert.equal(
      maybePrintTransientGitEintrHint({
        status: null,
        logText: "fatal: unable to open loose object ab: Interrupted system call",
        writeErr: (msg) => lines.push(msg),
      }),
      true,
    );
    assert.match(lines.join("\n"), /transient-git-eintr/);
    lines.length = 0;
    assert.equal(
      maybePrintTransientGitEintrHint({
        status: 0,
        logText: "fatal: unable to open loose object ab: Interrupted system call",
        writeErr: (msg) => lines.push(msg),
      }),
      false,
    );
  });

  test("Scenario: Null Tier Status Still Emits Transient Hint On Matching Logs", () => {
    const dir = makeTempDir("tier-hint-log-");
    const logPath = path.join(dir, "tier.log");
    writeFileSync(logPath, "fatal: unable to open loose object xx: Interrupted system call\n", "utf8");
    for (const status of [null, undefined]) {
      const lines = [];
      assert.equal(
        emitTransientHintForTierResult(
          { status, logPath, error: null },
          { writeErr: (msg) => lines.push(msg) },
        ),
        true,
        `status=${String(status)}`,
      );
      assert.match(lines.join("\n"), /transient-git-eintr/);
    }
  });

  test("declared GROUP_RANGES group without a wrapper fails and names the group", () => {
    const testsDir = makeTempDir("missing-shard-wrapper-");
    try {
      writeFileSync(
        path.join(testsDir, "fake-shard.test.mjs"),
        [
          'const FAKE_SHARD_TEST_GROUP = process.env.DEVPRO_FAKE_SHARD_TEST_GROUP ?? "core";',
          "const FAKE_SHARD_TEST_GROUP_RANGES = Object.freeze({",
          "  core: [1, 1],",
          "  runner_z: [2, 2],",
          "});",
          "",
        ].join("\n"),
      );

      const missing = collectMissingShardGroupWrappers(testsDir, { checkTier: false });
      const groups = missing.map((item) => item.group);
      const joined = formatMissingShardGroupWrappers(missing);

      assert.ok(
        groups.includes("runner_z"),
        `expected missing groups to include runner_z, got ${JSON.stringify(missing)}`,
      );
      assert.match(joined, /runner_z/);
    } finally {
      rmSync(testsDir, { recursive: true, force: true });
    }
  });

  test("wrapper-group registration covers every live GROUP_RANGES family", () => {
    const testsDir = repoPath(".devpro/scripts/tests");
    const { familyMains, scannerRejects } = discoverShardFamilyMains(testsDir);
    assert.deepEqual(
      scannerRejects,
      [...EXPECTED_SHARD_DISCOVERY_SCANNER_REJECTS],
      "stripJsCommentSpans rejects for shard discovery must stay an explicit expected-reject list",
    );
    for (const name of scannerRejects) {
      const raw = readFileSync(path.join(testsDir, name), "utf8");
      assert.equal(
        GROUP_RANGES_DECL_RE.test(raw),
        false,
        `${name} is scanner-rejected but raw source still declares *_TEST_GROUP_RANGES — refuse silent skip`,
      );
    }
    assert.ok(
      familyMains.length >= 6,
      `expected at least 6 GROUP_RANGES families, got ${familyMains.length}: ${familyMains.join(", ")}`,
    );
    const missing = collectMissingShardGroupWrappers(testsDir, { checkTier: true });
    assert.deepEqual(
      missing,
      [],
      `declared GROUP_RANGES groups missing wrappers:\n${formatMissingShardGroupWrappers(missing)}`,
    );
  });

  test("sync-agent-rules plain-checkout fallback matrix stays concurrently isolated", () => {
    const source = readFileSync(
      repoPath(".devpro/scripts/tests/sync-agent-rules.test.mjs"),
      "utf8",
    );

    assert.match(
      source,
      /describe\("plain-checkout discovery link fallback",\s*\{\s*concurrency:\s*true\s*\},/,
    );
    for (const code of ["EPERM", "EACCES", "ENOSYS"]) {
      assert.match(source, new RegExp(`"${code}"`));
    }
  });
});

describe("fast integration carrier set", () => {
  test("is fixed, unique, present, and integration-tier in the manifest", () => {
    assert.equal(Object.isFrozen(FAST_INTEGRATION_TESTS), true);
    assert.equal(new Set(FAST_INTEGRATION_TESTS).size, FAST_INTEGRATION_TESTS.length);
    assert.deepEqual(fastIntegrationFiles({ repoRoot: REPO_ROOT }), FAST_INTEGRATION_TESTS);

    for (const file of FAST_INTEGRATION_TESTS) {
      assert.ok(file.startsWith(SUITE_DIR), `fast carrier must live under ${SUITE_DIR}: ${file}`);
      assert.equal(
        resolveTier(file.slice(SUITE_DIR.length)),
        TIER_INTEGRATION,
        `fast carrier must remain integration-tier: ${file}`,
      );
      assert.equal(existsSync(repoPath(file)), true, `fast carrier must exist: ${file}`);
    }
  });

  test("fast tier sequence keeps running after an earlier tier fails", () => {
    const calls = [];
    const status = runTierSequence([TIER_UNIT, TIER_FAST], (tier) => {
      calls.push(tier);
      return tier === TIER_UNIT ? 1 : 0;
    });

    assert.deepEqual(calls, [TIER_UNIT, TIER_FAST]);
    assert.equal(status, 1);
  });
});

describe("classifyChangedPathForSelection", () => {
  // D2: carrier paths no longer drive selection, but MUST remain classified
  // (never "unknown") — this is the C1 invariant this describe locks.
  function classify(file, overrides = {}) {
    const fn = requiredRunnerSeam("classifyChangedPathForSelection");
    const integrationSet = new Set(listFiles(TIER_INTEGRATION));
    return fn(file, { integrationSet, deletedSet: new Set(), ...overrides });
  }

  test("rule .md classifies as known, not unknown", () => {
    assert.equal(classify(".devpro/agent-rules/testing-and-qa.md"), "known");
  });

  test("rigor config example is known without classifying runtime or lookalike configs", () => {
    assert.equal(classify(".devpro/rules.config.example"), "known");
    assert.equal(classify(".devpro/rules.config"), "unknown");
    assert.equal(classify(".devpro/rules.config.example.bak"), "unknown");
  });

  test("notes classify as known, not unknown", () => {
    assert.equal(classify("notes/session-pending.md"), "known");
  });

  test("hook scripts classify as known", () => {
    assert.equal(classify(".devpro/scripts/hooks/pre-tool-gate.mjs"), "known");
  });

  test("git-native hooks (hooks-git/, non-.mjs) classify as known", () => {
    assert.equal(classify(".devpro/scripts/hooks-git/pre-push"), "known");
  });

  test("non-test scripts under .devpro/scripts/ classify as known", () => {
    assert.equal(classify(".devpro/scripts/run-test-suite.mjs"), "known");
  });

  test("non-.mjs script under .devpro/scripts/ root classifies as known", () => {
    assert.equal(classify(".devpro/scripts/install-hooks.sh"), "known");
  });

  test("skill files classify as known", () => {
    assert.equal(classify(".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md"), "known");
  });

  test("OpenCode runtime plugin paths classify as known (parallel to .claude/)", () => {
    assert.equal(classify(".opencode/plugins/devpro-hooks.js"), "known");
  });

  test("Codex runtime projection paths classify as known (parallel to .claude/)", () => {
    assert.equal(classify(".codex/agents/dp-second-reviewer.toml"), "known");
  });

  test("Cursor runtime projection paths classify as known (parallel to .claude/)", () => {
    assert.equal(classify(".cursor/agents/dp-second-reviewer.md"), "known");
  });

  test("Codex/Cursor skill discovery entries under .agents/ classify as known (parallel to .claude/)", () => {
    assert.equal(classify(".agents/skills/devpro"), "known");
    assert.equal(
      classify(".agents/skills/devpro", { deletedSet: new Set([".agents/skills/devpro"]) }),
      "known",
    );
  });

  test("skill catalog and refs payload (non-SKILL.md) classify as known", () => {
    assert.equal(classify(".devpro/agent-skills/manifest.json"), "known");
    assert.equal(classify(".devpro/agent-skills/.claude-plugin/plugin.json"), "known");
    assert.equal(
      classify(".devpro/agent-skills/devpro-workflows/workflows/agents/openai.yaml"),
      "known",
    );
    assert.equal(classify(".devpro/agent-skills-refs/manifest.json"), "known");
  });

  test("skill catalog matchers stop at the directory boundary", () => {
    assert.equal(classify(".devpro/agent-skillsx/manifest.json"), "unknown");
    assert.equal(classify(".agentsx/skills/devpro"), "unknown");
  });

  test(".gitattributes classifies as known", () => {
    assert.equal(classify(".gitattributes"), "known");
  });

  test(".gitignore classifies as known, and only the repo-root file", () => {
    assert.equal(classify(".gitignore"), "known");
    assert.equal(classify("openspec/changes/x/.gitignore"), "known", "openspec/ is already a known carrier prefix");
    assert.equal(classify("packages/.gitignore"), "unknown", "a nested ignore file outside a known prefix is not the root file");
  });

  test("known unit-tier test file classifies as unit-test", () => {
    assert.equal(classify(KNOWN_UNIT_TEST), "unit-test");
  });

  test("known nested unit-tier test file classifies as unit-test", () => {
    assert.equal(classify(KNOWN_NESTED_UNIT_TEST), "unit-test");
  });

  test("known integration-tier test file classifies as integration-test", () => {
    assert.equal(classify(KNOWN_INTEGRATION_TEST), "integration-test");
  });

  test("unregistered test file fails closed to unknown", () => {
    assert.equal(classify(UNKNOWN_TEST), "unknown");
  });

  test("unclassifiable non-test path fails closed to unknown", () => {
    assert.equal(classify("mystery.bin"), "unknown");
  });

  test("git-confirmed deleted suite test classifies as deleted-test", () => {
    assert.equal(
      classify(KNOWN_INTEGRATION_TEST, { deletedSet: new Set([KNOWN_INTEGRATION_TEST]) }),
      "deleted-test",
    );
  });

  test("deleted-test exemption is shape-scoped: a deleted non-suite-test path does not get it", () => {
    const deletedHook = ".devpro/scripts/hooks/removed-hook.mjs";
    assert.equal(
      classify(deletedHook, { deletedSet: new Set([deletedHook]) }),
      "known",
    );
  });

  test("deleted-test takes priority over manifest membership (D over integration-test)", () => {
    assert.equal(
      classify(KNOWN_UNIT_TEST, { deletedSet: new Set([KNOWN_UNIT_TEST]) }),
      "deleted-test",
    );
  });
});

describe("changed execution plan tiers", () => {
  test("rule .md only → unit tier plus only the repo-sweep guards", () => {
    const execution = buildChangedTestExecutionPlan([".devpro/agent-rules/foo.md"]);
    assert.deepEqual(execution.tiers, [TIER_UNIT, TIER_INTEGRATION]);
    assert.deepEqual(execution.integrationPlan.files, [...REPO_SWEEP_INTEGRATION_TESTS]);
  });

  test("empty changed-file list fails closed to unit + integration", () => {
    assert.deepEqual(buildChangedTestExecutionPlan([]).tiers, [
      TIER_UNIT,
      TIER_INTEGRATION,
    ]);
  });

  test("mix with one real integration-tier test includes integration", () => {
    const execution = buildChangedTestExecutionPlan([
      ".devpro/agent-rules/foo.md",
      "notes/session-pending.md",
      KNOWN_INTEGRATION_TEST,
    ]);
    assert.deepEqual(execution.tiers, [TIER_UNIT, TIER_INTEGRATION]);
  });

  // The fixed list of integration tests that sweep every tracked file: a new
  // or changed file anywhere can turn them red, so a scoped `--changed` run
  // always carries them (amend-changed-selection-repo-sweep-guards).
  const EXPECTED_REPO_SWEEP_TESTS = [
    `${SUITE_DIR}hotfix-release-carrier-marker-scan.test.mjs`,
    `${SUITE_DIR}opencode-skill-discovery.test.mjs`,
    `${SUITE_DIR}second-review-reconciliation-unreachable-sweep.test.mjs`,
    `${SUITE_DIR}skill-entry-rename-sweep-guard.test.mjs`,
  ];
  const repoSweepTests = () => {
    const list = runnerModule.REPO_SWEEP_INTEGRATION_TESTS;
    assert.ok(Array.isArray(list), "run-test-suite.mjs must export REPO_SWEEP_INTEGRATION_TESTS");
    return list;
  };

  // The list's own validity (exists, integration tier) is checked in the unit
  // tier by test-suite-manifest.test.mjs, so it runs on every `--changed`.
  test("Scenario: Repo-sweep guards run on every scoped changed run", () => {
    assert.deepEqual([...repoSweepTests()], EXPECTED_REPO_SWEEP_TESTS);
    const formatRepoSweepSummary = requiredRunnerSeam("formatRepoSweepSummary");
    const execution = buildChangedTestExecutionPlan([".devpro/agent-rules/testing-and-qa.md"]);
    const total = listFiles(TIER_INTEGRATION).length;
    const sweep = [...repoSweepTests()];

    assert.deepEqual(execution.tiers, [TIER_UNIT, TIER_INTEGRATION]);
    assert.deepEqual(execution.integrationPlan.files, sweep);
    assert.equal(execution.integrationPlan.fallbackToFull, false, execution.integrationPlan.reason);
    assert.equal(
      formatChangedSelectionSummary(execution.integrationPlan, total),
      `integration_files=${sweep.length}/${total} selection=scoped`,
    );
    assert.equal(
      formatRepoSweepSummary(execution.integrationPlan),
      `repo_sweep files=${sweep.length} paths=${sweep.join(",")}`,
    );
    // Reading no integration source: the list is fixed, not derived.
    assert.equal(execution.integrationPlan.diagnostics.scriptReferences, undefined);

    // A changed sweep guard is selected once, not twice.
    const changedGuard = buildChangedTestExecutionPlan([sweep[0]]);
    assert.deepEqual(changedGuard.integrationPlan.files, sweep);

    // A full fallback already runs everything and prints no repo_sweep line.
    const fallback = buildChangedTestExecutionPlan(["unknown/path.txt"]);
    assert.equal(fallback.integrationPlan.fallbackToFull, true);
    assert.equal(formatRepoSweepSummary(fallback.integrationPlan), null);

    // A fixture manifest without those tests selects none of them.
    const fixture = makeReferenceFixture("repo-sweep-absent-from-fixture-manifest");
    const fixturePlan = buildChangedTestExecutionPlan([".devpro/agent-rules/testing-and-qa.md"], {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
    });
    assert.deepEqual(fixturePlan.integrationPlan.files, []);
    assert.equal(formatRepoSweepSummary(fixturePlan.integrationPlan), null);
  });

  test("the plan validator accepts repo-sweep guards only when they are declared", () => {
    const defaultPlanValidator = requiredRunnerSeam("defaultPlanValidator");
    const sweep = [...repoSweepTests()];
    const integrationSet = new Set(listFiles(TIER_INTEGRATION));
    const base = {
      files: sweep,
      integrationSet,
      changedIntegrationTests: [],
      expected: sweep,
      referencedTests: [],
      shardWrappers: [],
    };
    assert.equal(defaultPlanValidator({ ...base, repoSweepTests: sweep }), true);
    assert.equal(defaultPlanValidator(base), false, "an undeclared selected file is unexplained");
  });

  // SC1 (Target State 1): touching only a non-test carrier selects no
  // integration test of its own and stays scoped; only the fixed repo-sweep
  // guards run.
  const zeroIntegrationCases = [
    [".devpro/scripts/hooks-git/pre-push"],
    [".devpro/agent-skills/rules-authoring/rule-governance/SKILL.md"],
    [`${SUITE_DIR}lib/repo-root.mjs`],
    [`${SUITE_DIR}fixtures/claude-code-binary-strings.json`],
  ];
  for (const changed of zeroIntegrationCases) {
    test(`SC1: changed=${JSON.stringify(changed)} selects only the repo-sweep guards`, () => {
      const execution = buildChangedTestExecutionPlan(changed);
      const total = listFiles(TIER_INTEGRATION).length;
      const sweep = [...repoSweepTests()];
      assert.deepEqual(execution.tiers, [TIER_UNIT, TIER_INTEGRATION]);
      assert.deepEqual(execution.integrationPlan.files, sweep);
      assert.equal(execution.integrationPlan.fallbackToFull, false);
      assert.equal(
        formatChangedSelectionSummary(execution.integrationPlan, total),
        `integration_files=${sweep.length}/${total} selection=scoped`,
      );
    });
  }

  // amend-pr-integration-test-scope T12 (delta scenario): the non-test carrier
  // families in one changed set — hooks, SKILL bodies, test helpers, fixtures,
  // root .gitattributes, root .gitignore, Codex/Cursor runtime projections — must all stay on
  // the unit tier with a zero-file scoped integration plan, and every one of
  // those paths must classify as a known path (never "unknown", so never a
  // full-fallback).
  test("Scenario: Change touching only carriers without integration references selects only the repo-sweep guards", () => {
    const changedFiles = [
      ...zeroIntegrationCases.flat(),
      ".gitattributes",
      ".gitignore",
      ".codex/agents/dp-second-reviewer.toml",
      ".cursor/agents/dp-second-reviewer.md",
    ];
    const execution = buildChangedTestExecutionPlan(changedFiles);
    const total = listFiles(TIER_INTEGRATION).length;
    const sweep = [...repoSweepTests()];

    assert.deepEqual(execution.tiers, [TIER_UNIT, TIER_INTEGRATION]);
    assert.deepEqual(execution.integrationPlan.files, sweep);
    assert.equal(
      execution.integrationPlan.fallbackToFull,
      false,
      execution.integrationPlan.reason,
    );
    assert.equal(
      formatChangedSelectionSummary(execution.integrationPlan, total),
      `integration_files=${sweep.length}/${total} selection=scoped`,
    );

    const classifyPath = requiredRunnerSeam("classifyChangedPathForSelection");
    const integrationSet = new Set(listFiles(TIER_INTEGRATION));
    for (const file of changedFiles) {
      assert.notEqual(
        classifyPath(file, { integrationSet, deletedSet: new Set() }),
        "unknown",
        `${file} must classify as a known path (C1 invariant)`,
      );
    }

    // …and a non-test script that no integration test names stays at zero too
    // (synthetic fixture: the claim must not depend on today's real tests).
    const fixture = makeReferenceFixture("scenario-zero-unreferenced-script");
    const scriptPlan = buildChangedTestExecutionPlan([fixture.scripts.lib, ...changedFiles], {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
    });
    assert.deepEqual(scriptPlan.tiers, [TIER_UNIT]);
    assert.deepEqual(scriptPlan.integrationPlan.files, []);
    assert.equal(scriptPlan.integrationPlan.fallbackToFull, false, scriptPlan.integrationPlan.reason);
  });

  test("F1 regression lock: a changed unit-tier test alone never needs the integration tier", () => {
    // Vacuous today (no real unit-tier shard body exists — design.md Risks),
    // but this must already be true on the CURRENT runner: it locks the
    // invariant a future wrapper-expansion change must not violate.
    // The fixed repo-sweep guards run on every scoped plan; the changed unit
    // test itself adds nothing beyond them.
    const execution = buildChangedTestExecutionPlan([KNOWN_UNIT_TEST], { repoSweepTests: [] });
    assert.deepEqual(execution.tiers, [TIER_UNIT]);
    assert.equal(execution.integrationPlan?.files?.length ?? 0, 0);
    const withGuards = buildChangedTestExecutionPlan([KNOWN_UNIT_TEST]);
    assert.deepEqual(withGuards.integrationPlan.files, [...repoSweepTests()]);
  });

  test("F1 regression lock: a shard-import wrapper for a changed unit-tier body is not expanded", () => {
    // Non-vacuous variant: a fixture wrapper that would import KNOWN_UNIT_TEST
    // (if it were an integration-tier body) is injected via `integrationFiles`
    // — asserting it is never selected proves wrapper expansion only ever
    // triggers off a changed INTEGRATION-tier body (D1), not off a same-named
    // unit-tier one. Green on the current runner too: it ignores `repoRoot`/
    // `integrationFiles` for tier selection when the real manifest already
    // says KNOWN_UNIT_TEST is unit-tier.
    const fixtureRoot = path.join(tmpRoot, "f1-unit-body-wrapper-no-expand");
    const wrapper = ".devpro/scripts/tests/tag-shapes-runner-a.test.mjs";
    mkdirSync(path.dirname(path.join(fixtureRoot, wrapper)), { recursive: true });
    writeFileSync(
      path.join(fixtureRoot, wrapper),
      [
        'process.env.DEVPRO_TAG_SHAPES_TEST_GROUP = "runner_a";',
        "",
        'await import("./tag-shapes.test.mjs");',
        "",
      ].join("\n"),
    );

    const execution = buildChangedTestExecutionPlan([KNOWN_UNIT_TEST], {
      repoRoot: fixtureRoot,
      integrationFiles: [wrapper],
    });

    assert.deepEqual(execution.tiers, [TIER_UNIT]);
    assert.equal(execution.integrationPlan?.files?.length ?? 0, 0);
  });

  test("Target State 2: one non-shard integration test change plus a script that no test names selects only that test", () => {
    // A real hook such as pre-tool-gate.mjs is now named by many integration
    // tests, so the "hook adds nothing" claim is pinned on a synthetic fixture.
    const fixture = makeReferenceFixture("target-state-2-script-unreferenced");
    const execution = buildChangedTestExecutionPlan(
      [fixture.tests.refNone, fixture.scripts.lib],
      { repoRoot: fixture.repoRoot, integrationFiles: fixture.integrationFiles },
    );
    assert.deepEqual(execution.tiers, [TIER_UNIT, TIER_INTEGRATION]);
    assert.deepEqual(execution.integrationPlan.files, [fixture.tests.refNone]);
    assert.equal(execution.integrationPlan.fallbackToFull, false);
  });
});

describe("selectIntegrationTestFilesForChangedFiles", () => {
  function selectIntegration(changed, options) {
    return requiredRunnerSeam("selectIntegrationTestFilesForChangedFiles")(
      changed,
      options,
    );
  }

  /**
   * D10 fixture: one shard-import family (body + a `-runner-a` wrapper + a
   * wrapper NOT named `-runner-*`), a plain non-shard integration test
   * ("self"), a test whose only mention of the wrapper shape is inside a
   * quoted string literal (must NOT be misdetected as a wrapper), and an
   * unrelated hook file.
   */
  function makeSelectorFixture(name) {
    const repoRoot = path.join(tmpRoot, name);
    const files = {
      body: ".devpro/scripts/tests/shard-body.test.mjs",
      wrapperRunnerA: ".devpro/scripts/tests/shard-body-runner-a.test.mjs",
      wrapperOther: ".devpro/scripts/tests/shard-body-extra.test.mjs",
      self: ".devpro/scripts/tests/self.test.mjs",
      stringFixtureTest: ".devpro/scripts/tests/mentions-wrapper-string.test.mjs",
      hook: ".devpro/scripts/hooks/example-hook.mjs",
    };
    for (const file of Object.values(files)) {
      mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
    }
    writeFileSync(
      path.join(repoRoot, files.body),
      [
        'const SHARD_BODY_TEST_GROUP =',
        '  process.env.DEVPRO_SHARD_BODY_TEST_GROUP ?? "core";',
        "export const marker = SHARD_BODY_TEST_GROUP;",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(repoRoot, files.wrapperRunnerA),
      [
        'process.env.DEVPRO_SHARD_BODY_TEST_GROUP = "runner_a";',
        "",
        'await import("./shard-body.test.mjs");',
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(repoRoot, files.wrapperOther),
      [
        'process.env.DEVPRO_SHARD_BODY_TEST_GROUP = "extra";',
        "",
        'await import("./shard-body.test.mjs");',
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(repoRoot, files.self), "// changed test self\n");
    writeFileSync(
      path.join(repoRoot, files.stringFixtureTest),
      [
        "const documentationExample =",
        '  \'process.env.DEVPRO_SHARD_BODY_TEST_GROUP = "runner_a"; await import("./shard-body.test.mjs");\';',
        "void documentationExample;",
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(repoRoot, files.hook), "export const hook = true;\n");
    return {
      repoRoot,
      files,
      integrationFiles: [
        files.body,
        files.wrapperRunnerA,
        files.wrapperOther,
        files.self,
        files.stringFixtureTest,
      ],
    };
  }

  test("D5 selector guard treats a false planValidator as selection-unexplained", () => {
    const validatePlan = requiredRunnerSeam("defaultPlanValidator");
    const selected = ".devpro/scripts/tests/always.test.mjs";
    assert.equal(
      validatePlan({
        files: [selected],
        integrationSet: new Set([selected]),
        changedIntegrationTests: [selected],
        expected: [],
        deletedSet: new Set(),
      }),
      false,
    );
  });

  test("changed integration test selects itself and nothing else", () => {
    const fixture = makeSelectorFixture("selector-self");
    const plan = selectIntegration([fixture.files.self], {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
    });
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.equal(plan.reason, "scoped");
    assert.deepEqual(plan.files, [fixture.files.self]);
  });

  test("a quoted-string mention of the wrapper shape is not misdetected as a shard signal", () => {
    const fixture = makeSelectorFixture("selector-string-fixture-no-misdetect");
    const plan = selectIntegration([fixture.files.stringFixtureTest], {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
    });
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.deepEqual(plan.files, [fixture.files.stringFixtureTest]);
  });

  test("SC9/F1: changed integration-tier shard body selects every shard-import wrapper, including a non -runner- named one", () => {
    const fixture = makeSelectorFixture("selector-shard-expand");
    const plan = selectIntegration([fixture.files.body], {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
    });
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.deepEqual(
      new Set(plan.files),
      new Set([fixture.files.body, fixture.files.wrapperRunnerA, fixture.files.wrapperOther]),
    );
  });

  // amend-pr-integration-test-scope T12 (delta scenario): each THEN/AND clause of
  // "Changed sharded test body selects its shard-import wrappers" gets a real
  // assertion here; the changed-unit-tier-body clause is non-vacuously locked by
  // the two `F1 regression lock:` cases above (injected wrapper importing a
  // unit-tier body) and is re-checked at the selector seam below.
  test("Scenario: Changed sharded test body selects its shard-import wrappers", () => {
    const fixture = makeSelectorFixture("scenario-shard-expand");

    // THEN: every shard-import wrapper of the changed body is selected alongside it…
    const plan = selectIntegration([fixture.files.body], {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
    });
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.deepEqual(
      new Set(plan.files),
      new Set([fixture.files.body, fixture.files.wrapperRunnerA, fixture.files.wrapperOther]),
      "every shard-import wrapper must be selected alongside the changed body",
    );
    // AND: …regardless of wrapper filename — wrapperOther is not named `-runner-*`.
    assert.ok(
      plan.files.includes(fixture.files.wrapperOther),
      "wrapper discovery must follow the shard-import relation regardless of wrapper filename",
    );

    // AND: a shard-import signal whose literal target cannot be resolved fails
    // closed with selector-error instead of under-selecting.
    const badTarget = ".devpro/scripts/tests/shard-signal-no-target.test.mjs";
    mkdirSync(path.dirname(path.join(fixture.repoRoot, badTarget)), { recursive: true });
    writeFileSync(
      path.join(fixture.repoRoot, badTarget),
      [
        'const dynamicTarget = "./" + "shard-body" + ".test.mjs";',
        'process.env.DEVPRO_BROKEN_SHARD_TEST_GROUP = "runner_a";',
        "await import(dynamicTarget);",
        "",
      ].join("\n"),
    );
    const errorPlan = selectIntegration([fixture.files.body], {
      repoRoot: fixture.repoRoot,
      integrationFiles: [...fixture.integrationFiles, badTarget],
    });
    assert.equal(errorPlan.fallbackToFull, true);
    assert.equal(errorPlan.reason, "selector-error");

    // AND: a changed unit-tier test expands no wrapper, even as a shard-import
    // target (the non-vacuous fixture case is the `F1 regression lock:` above).
    const unitPlan = selectIntegration([KNOWN_UNIT_TEST], {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
    });
    assert.equal(unitPlan.fallbackToFull, false, unitPlan.reason);
    assert.deepEqual(unitPlan.files, []);
  });

  test("a shard-import signal without a resolvable literal target fails closed (selector-error)", () => {
    const fixture = makeSelectorFixture("selector-shard-error");
    const badTarget = ".devpro/scripts/tests/shard-signal-no-target.test.mjs";
    mkdirSync(path.dirname(path.join(fixture.repoRoot, badTarget)), { recursive: true });
    writeFileSync(
      path.join(fixture.repoRoot, badTarget),
      [
        'const dynamicTarget = "./" + "shard-body" + ".test.mjs";',
        'process.env.DEVPRO_BROKEN_SHARD_TEST_GROUP = "runner_a";',
        "await import(dynamicTarget);",
        "",
      ].join("\n"),
    );

    const plan = selectIntegration([fixture.files.body], {
      repoRoot: fixture.repoRoot,
      integrationFiles: [...fixture.integrationFiles, badTarget],
    });

    assert.equal(plan.fallbackToFull, true);
    assert.equal(plan.reason, "selector-error");
  });

  test("each fail-closed family returns the complete integration manifest and a stable reason (SC11)", () => {
    const fixture = makeSelectorFixture("selector-fallbacks");
    const common = {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
    };
    const cases = [
      { changed: [], options: common, reason: "changed-set-unavailable" },
      { changed: ["unclassified/carrier.bin"], options: common, reason: "unknown-path" },
      {
        changed: [fixture.files.body],
        options: { ...common, shardTargetDetector: () => { throw new Error("detector boom"); } },
        reason: "selector-error",
      },
      {
        changed: [fixture.files.self],
        options: { ...common, planValidator: () => false },
        reason: "selection-unexplained",
      },
    ];

    for (const fixtureCase of cases) {
      const plan = selectIntegration(fixtureCase.changed, fixtureCase.options);
      assert.equal(plan.fallbackToFull, true, fixtureCase.reason);
      assert.equal(plan.reason, fixtureCase.reason);
      assert.deepEqual(plan.files, fixture.integrationFiles);
    }
  });

  test(".gitattributes classifies as known and stays scoped with only the repo-sweep guards (no seeded owners)", () => {
    const plan = selectIntegration([".gitattributes"]);
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.equal(plan.reason, "scoped");
    assert.deepEqual(plan.files, [...REPO_SWEEP_INTEGRATION_TESTS]);
  });

  test(".gitignore classifies as known and stays scoped with only the repo-sweep guards (final suite is not forced to full-fallback)", () => {
    const plan = selectIntegration([".gitignore"]);
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.equal(plan.reason, "scoped");
    assert.deepEqual(plan.files, [...REPO_SWEEP_INTEGRATION_TESTS]);
  });

  test("Codex/Cursor runtime projections classify as known and stay scoped with only the repo-sweep guards", () => {
    for (const changed of [
      ".codex/agents/dp-second-reviewer.toml",
      ".cursor/agents/dp-second-reviewer.md",
    ]) {
      const plan = selectIntegration([changed]);
      assert.equal(plan.fallbackToFull, false, `${changed} must stay scoped (got reason=${plan.reason})`);
      assert.equal(plan.reason, "scoped");
      assert.deepEqual(plan.files, [...REPO_SWEEP_INTEGRATION_TESTS]);
    }
  });

  test("retired .cursor/skills path classifies as known and stays scoped with only the repo-sweep guards", () => {
    const plan = selectIntegration([".cursor/skills/example-skill"]);
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.equal(plan.reason, "scoped");
    assert.deepEqual(plan.files, [...REPO_SWEEP_INTEGRATION_TESTS]);
  });

  test("explicit tier arguments remain outside the changed-file selector seam", () => {
    for (const tier of ["fast", "integration", "all"]) {
      const parsed = parseArgs(["--tier", tier], { repoRoot: tmpRoot });
      assert.equal(parsed.tier, tier);
      assert.equal(parsed.changedBase, null);
    }
  });

  test("changed execution plan carries scoped integration files and observable summary", () => {
    const fixture = makeSelectorFixture("selector-wiring");
    const execution = buildChangedTestExecutionPlan([fixture.files.self], {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
    });

    assert.deepEqual(execution.tiers, [TIER_UNIT, TIER_INTEGRATION]);
    assert.deepEqual(execution.integrationPlan.files, [fixture.files.self]);
    assert.equal(
      formatChangedSelectionSummary(execution.integrationPlan, fixture.integrationFiles.length),
      `integration_files=1/${fixture.integrationFiles.length} selection=scoped`,
    );
  });

  test("unclassified changed paths enter the full integration fallback", () => {
    const fixture = makeSelectorFixture("selector-unknown-plan");
    const execution = buildChangedTestExecutionPlan(["unclassified/carrier.bin"], {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
    });

    assert.deepEqual(execution.tiers, [TIER_UNIT, TIER_INTEGRATION]);
    assert.equal(execution.integrationPlan.fallbackToFull, true);
    assert.equal(execution.integrationPlan.reason, "unknown-path");
    assert.deepEqual(execution.integrationPlan.files, fixture.integrationFiles);
  });

  describe("deleted-test exemption (D4/D5, SC11)", () => {
    test("Scenario: Git-confirmed deleted suite test is a known path", () => {
      const deletedTest = ".devpro/scripts/tests/removed-example.test.mjs";
      const plan = selectIntegration([deletedTest], { deletedFiles: [deletedTest] });
      assert.equal(plan.fallbackToFull, false, plan.reason);
      assert.equal(plan.reason, "scoped");
      assert.deepEqual(plan.files, [...REPO_SWEEP_INTEGRATION_TESTS]);

      // AND: a manifest entry left behind for the deleted file MUST still fail
      // the manifest lint in the unit tier — the D exemption never orphans a
      // manifest entry. On a temp root whose `.devpro/scripts/tests/` is empty,
      // every manifest entry is disk-missing, so the leftover-entry error
      // prefix must surface (and the lint must not silently pass).
      const manifestRoot = path.join(tmpRoot, "deleted-test-leftover-manifest-entry");
      mkdirSync(path.join(manifestRoot, ".devpro", "scripts", "tests"), {
        recursive: true,
      });
      const { ok, errors } = lintManifest({ repoRoot: manifestRoot });
      assert.equal(ok, false, "a manifest entry with no disk file must fail the manifest lint");
      const leftoverErrors = errors.filter((error) =>
        error.startsWith("manifest entry for missing file: "),
      );
      assert.ok(
        leftoverErrors.length > 0,
        `expected a "manifest entry for missing file:" error, got: ${JSON.stringify(errors.slice(0, 3))}`,
      );
    });

    test("the deleted-test exemption does not mask an unrelated unknown path", () => {
      const deletedTest = ".devpro/scripts/tests/removed-example.test.mjs";
      const plan = selectIntegration([deletedTest, "mystery.bin"], {
        deletedFiles: [deletedTest],
      });
      assert.equal(plan.fallbackToFull, true);
      assert.equal(plan.reason, "unknown-path");
    });

    test("the deleted-test exemption is shape-scoped: a deleted hook stays known, not exempted-as-test", () => {
      // Synthetic fixture: against the real repo this file's own source (which
      // names the path) would count as a reference and select itself.
      const fixture = makeReferenceFixture("deleted-hook-shape-scoped");
      const deletedHook = ".devpro/scripts/hooks/never-named-by-any-test.mjs";
      const plan = selectIntegration([deletedHook], {
        repoRoot: fixture.repoRoot,
        integrationFiles: fixture.integrationFiles,
        deletedFiles: [deletedHook],
      });
      assert.equal(plan.fallbackToFull, false, plan.reason);
      assert.equal(plan.reason, "scoped");
      assert.deepEqual(plan.files, []);
    });
  });
});

describe("script reference selection (amend-changed-integration-selection-by-reference)", () => {
  function selectIntegration(changed, options) {
    return requiredRunnerSeam("selectIntegrationTestFilesForChangedFiles")(changed, options);
  }
  function summaryOf(plan) {
    return requiredRunnerSeam("formatScriptReferenceSummary")(plan);
  }
  function optionsOf(fixture, extra = {}) {
    return {
      repoRoot: fixture.repoRoot,
      integrationFiles: fixture.integrationFiles,
      ...extra,
    };
  }

  test("isScriptReferenceCarrier accepts only non-test .mjs scripts outside the suite directory", () => {
    const isCarrier = requiredRunnerSeam("isScriptReferenceCarrier");
    for (const file of [
      ".devpro/scripts/hooks/pre-tool-gate.mjs",
      ".devpro/scripts/hooks/lib/branch-naming.mjs",
      ".devpro/scripts/lib/repo-root.mjs",
      ".devpro/scripts/run-test-suite.mjs",
    ]) {
      assert.equal(isCarrier(file), true, file);
    }
    for (const file of [
      `${SUITE_DIR}lib/repo-root.mjs`,
      `${SUITE_DIR}git-utils.test.mjs`,
      ".devpro/scripts/lib/outside-suite.test.mjs",
      ".devpro/scripts/hooks-git/pre-push",
      ".devpro/scripts/lib/old-name.cjs",
      ".claude/hooks/x.mjs",
      ".devpro/agent-rules/foo.md",
      "AGENTS.md",
    ]) {
      assert.equal(isCarrier(file), false, file);
    }
  });

  test("a *.test.mjs outside the suite directory stays an unknown path and is never a carrier", () => {
    const fixture = makeReferenceFixture("ref-outside-suite-test");
    const plan = selectIntegration([".devpro/scripts/lib/outside-suite.test.mjs"], optionsOf(fixture));
    assert.equal(plan.fallbackToFull, true);
    assert.equal(plan.reason, "unknown-path");
    assert.equal(summaryOf(plan), null);
  });

  test("Scenario: Changed script selects the integration tests that name its full path", () => {
    const fixture = makeReferenceFixture("scenario-script-full-path");
    const plan = selectIntegration([fixture.scripts.hook], optionsOf(fixture));
    assert.equal(plan.fallbackToFull, false, plan.reason);
    // The test that names the full path is selected; the basename-only test and
    // the test that names nothing are not.
    assert.deepEqual(plan.files, [fixture.tests.refFull]);
    const total = fixture.integrationFiles.length;
    assert.equal(
      formatChangedSelectionSummary(plan, total),
      `integration_files=1/${total} selection=scoped`,
    );
    assert.equal(summaryOf(plan), "script_references carriers=1 referencing_files=1 unreferenced=0");
  });

  test("Scenario: Changed integration test selects itself", () => {
    const fixture = makeReferenceFixture("scenario-selects-itself");
    // WHEN: the changed set holds an integration test. THEN: it is selected and
    // nothing else is (every unchanged test stays out, including the one that
    // names the hook by full path, because no script changed).
    const alone = selectIntegration([fixture.tests.refNone], optionsOf(fixture));
    assert.equal(alone.fallbackToFull, false, alone.reason);
    assert.deepEqual(alone.files, [fixture.tests.refNone]);
    // AND: next to a changed script, the unchanged test that names the script by
    // its full path joins the changed test (union, manifest order); the
    // basename-only test is still not selected.
    const withScript = selectIntegration(
      [fixture.tests.refNone, fixture.scripts.hook],
      optionsOf(fixture),
    );
    assert.equal(withScript.fallbackToFull, false, withScript.reason);
    assert.deepEqual(withScript.files, [fixture.tests.refFull, fixture.tests.refNone]);
    assert.ok(!withScript.files.includes(fixture.tests.refBasename));
  });

  test("Scenario: Changed script selects integration tests that spell its path in adjacent quoted segments", () => {
    const fixture = makeReferenceFixture("scenario-script-segmented-path");
    const refSegments = `${SUITE_DIR}ref-segments.test.mjs`;
    const refMixed = `${SUITE_DIR}ref-mixed.test.mjs`;
    const refMultiline = `${SUITE_DIR}ref-multiline.test.mjs`;
    const refIndirect = `${SUITE_DIR}ref-indirect.test.mjs`;
    const extra = {
      [refSegments]: 'path.join(REPO_ROOT, ".devpro", "scripts", "hooks", "example-hook.mjs");\n',
      [refMixed]: "path.join(REPO_ROOT, '.devpro/scripts/hooks', 'example-hook.mjs');\n",
      [refMultiline]: 'path.join(\n  REPO_ROOT,\n  ".devpro",\n  "scripts",\n  "hooks",\n  `example-hook.mjs`,\n);\n',
      // The path is split across two expressions; only the basename sits next to the call.
      [refIndirect]: 'const HOOKS = path.join(REPO_ROOT, ".devpro", "scripts", "hooks");\npath.join(HOOKS, "example-hook.mjs");\n',
    };
    for (const [file, content] of Object.entries(extra)) {
      writeFileSync(path.join(fixture.repoRoot, file), content);
    }
    const plan = selectIntegration([fixture.scripts.hook], {
      repoRoot: fixture.repoRoot,
      integrationFiles: [...fixture.integrationFiles, ...Object.keys(extra)],
    });
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.deepEqual(plan.files, [fixture.tests.refFull, refSegments, refMixed, refMultiline]);
    assert.ok(!plan.files.includes(fixture.tests.refBasename));
    assert.ok(!plan.files.includes(refIndirect));
    assert.equal(summaryOf(plan), "script_references carriers=1 referencing_files=4 unreferenced=0");
  });

  test("prove-it: a changed prune-merged-local.mjs selects the tests that path.join its segments", () => {
    const plan = selectIntegration([".devpro/scripts/prune-merged-local.mjs"], {});
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.ok(plan.files.includes(".devpro/scripts/tests/prune-rules-lane.test.mjs"), plan.files.join("\n"));
    assert.ok(plan.files.includes(".devpro/scripts/tests/prune-merged-local-c.test.mjs"), plan.files.join("\n"));
  });

  test("a test selected by reference does not turn the other scripts it names into carriers (no recursion)", () => {
    const fixture = makeReferenceFixture("ref-no-recursion");
    const secondScript = ".devpro/scripts/lib/second-script.mjs";
    const refBoth = `${SUITE_DIR}ref-both.test.mjs`;
    const refSecondOnly = `${SUITE_DIR}ref-second-only.test.mjs`;
    writeFileSync(
      path.join(fixture.repoRoot, refBoth),
      `repoPath("${fixture.scripts.hook}");\nrepoPath("${secondScript}");\n`,
    );
    writeFileSync(path.join(fixture.repoRoot, refSecondOnly), `repoPath("${secondScript}");\n`);
    const plan = selectIntegration([fixture.scripts.hook], {
      repoRoot: fixture.repoRoot,
      integrationFiles: [...fixture.integrationFiles, refBoth, refSecondOnly],
    });
    assert.equal(plan.fallbackToFull, false, plan.reason);
    // refBoth names the changed hook so it is selected; refSecondOnly names only
    // the second script, which did not change, so it stays out.
    assert.deepEqual(plan.files, [fixture.tests.refFull, refBoth]);
    assert.equal(summaryOf(plan), "script_references carriers=1 referencing_files=2 unreferenced=0");
  });

  test("Scenario: Script reference selection expands the shard-import wrappers of a referencing sharded body", () => {
    const fixture = makeReferenceFixture("scenario-script-shard-body");
    const plan = selectIntegration([fixture.scripts.subject], optionsOf(fixture));
    assert.equal(plan.fallbackToFull, false, plan.reason);
    // THEN: the body and its wrapper are both selected …
    assert.deepEqual(plan.files, [fixture.tests.shardBody, fixture.tests.shardWrapper]);
    // AND: … regardless of wrapper filename (the wrapper is not named -runner-*).
    assert.ok(!fixture.tests.shardWrapper.includes("-runner-"));
    assert.equal(summaryOf(plan), "script_references carriers=1 referencing_files=1 unreferenced=0");
  });

  test("Scenario: Changed script that no integration test names selects nothing and does not fall back", () => {
    const fixture = makeReferenceFixture("scenario-script-unreferenced");
    const execution = buildChangedTestExecutionPlan([fixture.scripts.lib], optionsOf(fixture));
    const plan = execution.integrationPlan;
    assert.deepEqual(execution.tiers, [TIER_UNIT]);
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.deepEqual(plan.files, []);
    const summary = formatChangedSelectionSummary(plan, fixture.integrationFiles.length);
    assert.equal(summary, `integration_files=0/${fixture.integrationFiles.length} selection=scoped`);
    assert.doesNotMatch(summary, /full-fallback/);
    assert.equal(
      summaryOf(plan),
      `script_references carriers=1 referencing_files=0 unreferenced=1 unreferenced_paths=${fixture.scripts.lib}`,
    );
  });

  test("Scenario: Reference lookup reads integration sources only when a changed script exists", () => {
    const fixture = makeReferenceFixture("scenario-no-lookup");
    // Integration sources are unreadable from this root: any read would throw.
    const unreadable = {
      repoRoot: path.join(tmpRoot, "scenario-no-lookup-nowhere"),
      integrationFiles: fixture.integrationFiles,
    };
    const noScripts = [
      ".devpro/agent-rules/foo.md",
      KNOWN_UNIT_TEST,
      `${SUITE_DIR}lib/repo-root.mjs`,
      ".devpro/agent-skills/rules-authoring/rule-governance/SKILL.md",
      ".claude/agents/dp-reviewer.md",
      "notes/session-pending.md",
      "openspec/specs/test-governance/spec.md",
    ];
    const plan = selectIntegration(noScripts, unreadable);
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.deepEqual(plan.files, []);
    assert.equal(summaryOf(plan), null);

    // Contrast: the same unreadable root plus one script must look up references.
    const withScript = selectIntegration([...noScripts, fixture.scripts.hook], unreadable);
    assert.equal(withScript.fallbackToFull, true);
    assert.equal(withScript.reason, "selector-error");
  });

  test("a changed integration body without any changed script still finds its wrappers and prints no script_references", () => {
    const fixture = makeReferenceFixture("ref-body-no-script");
    const plan = selectIntegration([fixture.tests.shardBody], optionsOf(fixture));
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.deepEqual(plan.files, [fixture.tests.shardBody, fixture.tests.shardWrapper]);
    assert.equal(summaryOf(plan), null);
  });

  test("Scenario: Unreadable integration test source during reference lookup fails closed", () => {
    const fixture = makeReferenceFixture("scenario-unreadable-source");
    const missing = `${SUITE_DIR}ref-missing.test.mjs`;
    const integrationFiles = [...fixture.integrationFiles, missing];
    const plan = selectIntegration([fixture.scripts.hook], { repoRoot: fixture.repoRoot, integrationFiles });
    assert.equal(plan.fallbackToFull, true);
    assert.equal(plan.reason, "selector-error");
    assert.deepEqual(plan.files, integrationFiles);
    assert.equal(summaryOf(plan), null);
  });

  test("Scenario: Deleted or renamed script selects the integration tests that still name its old path", () => {
    const fixture = makeReferenceFixture("scenario-deleted-renamed");
    const plan = selectIntegration(
      [fixture.scripts.removed, fixture.scripts.renamedNew],
      optionsOf(fixture, {
        deletedFiles: [fixture.scripts.removed],
        renamedFromFiles: [fixture.scripts.renamedOld],
      }),
    );
    assert.equal(plan.fallbackToFull, false, plan.reason);
    // THEN: the test naming the deleted script and the test naming only the old
    // path of the renamed script are selected; the test naming neither is not.
    assert.deepEqual(plan.files, [fixture.tests.refRemoved, fixture.tests.refRenamedOld]);
    // AND: the .cjs new path is not a carrier, the deleted path and the old path are.
    assert.equal(summaryOf(plan), "script_references carriers=2 referencing_files=2 unreferenced=0");
  });

  test("a .mjs to .mjs rename counts both the old and the new path as carriers", () => {
    const fixture = makeReferenceFixture("ref-rename-mjs-to-mjs");
    const newPath = ".devpro/scripts/lib/new-name.mjs";
    const plan = selectIntegration(
      [newPath],
      optionsOf(fixture, { renamedFromFiles: [fixture.scripts.renamedOld] }),
    );
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.deepEqual(plan.files, [fixture.tests.refRenamedOld]);
    assert.equal(
      summaryOf(plan),
      `script_references carriers=2 referencing_files=1 unreferenced=1 unreferenced_paths=${newPath}`,
    );
  });

  test("rename sources that cannot be determined (renamedFromFiles null) fall back as changed-set-unavailable", () => {
    const fixture = makeReferenceFixture("ref-rename-null");
    const plan = selectIntegration([fixture.scripts.hook], optionsOf(fixture, { renamedFromFiles: null }));
    assert.equal(plan.fallbackToFull, true);
    assert.equal(plan.reason, "changed-set-unavailable");
    assert.deepEqual(plan.files, fixture.integrationFiles);
    assert.equal(summaryOf(plan), null);
    // undefined means "no rename information": the scoped selection is unchanged.
    const plain = selectIntegration([fixture.scripts.hook], optionsOf(fixture, { renamedFromFiles: undefined }));
    assert.equal(plain.fallbackToFull, false, plain.reason);
    assert.deepEqual(plain.files, [fixture.tests.refFull]);
  });

  test("a changed script alongside an unknown path or a failing validator falls back and prints no script_references", () => {
    const fixture = makeReferenceFixture("ref-script-fallbacks");
    const unknown = selectIntegration([fixture.scripts.hook, "unclassified/carrier.bin"], optionsOf(fixture));
    assert.equal(unknown.fallbackToFull, true);
    assert.equal(unknown.reason, "unknown-path");
    assert.equal(summaryOf(unknown), null);
    const unexplained = selectIntegration(
      [fixture.scripts.hook],
      optionsOf(fixture, { planValidator: () => false }),
    );
    assert.equal(unexplained.fallbackToFull, true);
    assert.equal(unexplained.reason, "selection-unexplained");
    assert.equal(summaryOf(unexplained), null);
  });

  test("formatScriptReferenceSummary percent-escapes %, comma and control characters so the line stays single-line", () => {
    const unreferenced = ["a,b.mjs", "c\nd.mjs", "e%f.mjs", "h\u0085i.mjs"];
    const plan = {
      files: [],
      fallbackToFull: false,
      reason: "scoped",
      diagnostics: {
        scriptReferences: {
          carriers: [...unreferenced, "ok/g.mjs"],
          referencedTests: [],
          unreferenced,
          referencingFiles: 0,
        },
      },
    };
    const line = summaryOf(plan);
    assert.equal(
      line,
      "script_references carriers=5 referencing_files=0 unreferenced=4 unreferenced_paths=a%2Cb.mjs,c%0Ad.mjs,e%25f.mjs,h%85i.mjs",
    );
    assert.equal(line.includes("\n"), false);
  });

  test("formatScriptReferenceSummary prints nothing on fallback or without carriers", () => {
    assert.equal(
      summaryOf({ files: [], fallbackToFull: true, reason: "unknown-path", diagnostics: {} }),
      null,
    );
    assert.equal(
      summaryOf({ files: [], fallbackToFull: false, reason: "scoped", diagnostics: { classifications: {} } }),
      null,
    );
  });

  test("defaultPlanValidator keeps the five-field semantics and checks the new fields only when provided", () => {
    const validate = requiredRunnerSeam("defaultPlanValidator");
    const body = `${SUITE_DIR}b.test.mjs`;
    const wrapper = `${SUITE_DIR}b-extra.test.mjs`;
    const referenced = `${SUITE_DIR}r.test.mjs`;
    const base = { integrationSet: new Set([body, wrapper, referenced]), deletedSet: new Set() };
    // A legacy five-field call with a legitimate wrapper stays valid.
    assert.equal(
      validate({ ...base, files: [body, wrapper], changedIntegrationTests: [body], expected: [body, wrapper] }),
      true,
    );
    // When shardWrappers is provided it must explain every selected file.
    const wrapped = { ...base, files: [body, wrapper], changedIntegrationTests: [body], expected: [body, wrapper] };
    assert.equal(validate({ ...wrapped, shardWrappers: [] }), false);
    assert.equal(validate({ ...wrapped, shardWrappers: [wrapper] }), true);
    // A referenced test must be part of the selection.
    const refCase = { ...base, changedIntegrationTests: [body], referencedTests: [referenced], shardWrappers: [] };
    assert.equal(validate({ ...refCase, files: [body], expected: [body] }), false);
    assert.equal(validate({ ...refCase, files: [body, referenced], expected: [body, referenced] }), true);
  });
});

describe("renamedSourcesVsBase and the changed-mode call chain (amend-changed-integration-selection-by-reference)", () => {
  function renamedSources(base, root, options) {
    return requiredRunnerSeam("renamedSourcesVsBase")(base, root, options);
  }

  test("renamedSourcesVsBase asks git for NUL-delimited rename status and returns the old paths losslessly", () => {
    const calls = [];
    const result = renamedSources("main", "/repo", {
      spawnGit: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stdout: "R100\0.devpro/scripts/lib/old one.mjs\0.devpro/scripts/lib/new.mjs\0R087\0é.mjs\0x.mjs\0",
        };
      },
    });
    assert.deepEqual(result, [".devpro/scripts/lib/old one.mjs", "é.mjs"]);
    assert.equal(calls.length, 1);
    for (const arg of ["diff", "main...HEAD", "--name-status", "-z", "--diff-filter=R"]) {
      assert.ok(calls[0].includes(arg), `git argv must include ${arg}: ${calls[0].join(" ")}`);
    }
  });

  test("renamedSourcesVsBase returns an empty list when git reports no rename", () => {
    assert.deepEqual(renamedSources("main", "/repo", { spawnGit: () => ({ status: 0, stdout: "" }) }), []);
  });

  test("renamedSourcesVsBase returns null (undetermined) on git failure or unparseable output", () => {
    for (const result of [
      { status: 1, stdout: "" },
      { status: 0, stdout: undefined },
      { status: 0, stdout: "R100\0only-two-tokens\0" },
      { status: 0, stdout: "M\0a.mjs\0b.mjs\0" },
    ]) {
      assert.equal(renamedSources("main", "/repo", { spawnGit: () => result }), null, JSON.stringify(result));
    }
  });

  function stubGit({ changed = "", deleted = "", renamed = "", renamedStatus = 0 }) {
    return (command, args) => {
      if (args.includes("--diff-filter=D")) return { status: 0, stdout: deleted };
      if (args.includes("--diff-filter=R")) return { status: renamedStatus, stdout: renamed };
      return { status: 0, stdout: changed };
    };
  }
  function resolve(fixture, spawnGit) {
    return requiredRunnerSeam("resolveChangedExecutionPlan")("main", fixture.repoRoot, {
      spawnGit,
      integrationFiles: fixture.integrationFiles,
    });
  }

  test("resolveChangedExecutionPlan carries a rename's old path through to the selector", () => {
    const fixture = makeReferenceFixture("chain-rename-success");
    const { changed, execution } = resolve(
      fixture,
      stubGit({
        changed: `${fixture.scripts.renamedNew}\n`,
        renamed: `R100\0${fixture.scripts.renamedOld}\0${fixture.scripts.renamedNew}\0`,
      }),
    );
    assert.deepEqual(changed, [fixture.scripts.renamedNew]);
    assert.equal(execution.integrationPlan.fallbackToFull, false, execution.integrationPlan.reason);
    assert.deepEqual(execution.integrationPlan.files, [fixture.tests.refRenamedOld]);
    assert.deepEqual(execution.tiers, [TIER_UNIT, TIER_INTEGRATION]);
  });

  test("resolveChangedExecutionPlan stays scoped when git reports no rename", () => {
    const fixture = makeReferenceFixture("chain-no-rename");
    const { execution } = resolve(fixture, stubGit({ changed: `${fixture.scripts.hook}\n` }));
    assert.equal(execution.integrationPlan.fallbackToFull, false, execution.integrationPlan.reason);
    assert.deepEqual(execution.integrationPlan.files, [fixture.tests.refFull]);
  });

  test("resolveChangedExecutionPlan falls back as changed-set-unavailable when the rename query fails or is malformed", () => {
    const fixture = makeReferenceFixture("chain-rename-undetermined");
    for (const git of [
      stubGit({ changed: `${fixture.scripts.hook}\n`, renamedStatus: 1 }),
      stubGit({ changed: `${fixture.scripts.hook}\n`, renamed: "R100\0only-two-tokens\0" }),
    ]) {
      const { execution } = resolve(fixture, git);
      assert.equal(execution.integrationPlan.fallbackToFull, true);
      assert.equal(execution.integrationPlan.reason, "changed-set-unavailable");
      assert.deepEqual(execution.integrationPlan.files, fixture.integrationFiles);
      assert.deepEqual(execution.tiers, [TIER_UNIT, TIER_INTEGRATION]);
      assert.equal(requiredRunnerSeam("formatScriptReferenceSummary")(execution.integrationPlan), null);
    }
  });
});

describe("real-repo script reference checkpoint (PR #3324)", () => {
  test("changing the post-PR completion hook selects hook-post-pr-completion.test.mjs", () => {
    // PR #3324 removed a line the hook printed; the test that asserted it was
    // unchanged, so the old --changed selected nothing and main went red.
    const selectIntegration = requiredRunnerSeam("selectIntegrationTestFilesForChangedFiles");
    const plan = selectIntegration([".devpro/scripts/hooks/post-pr-completion-check.mjs"]);
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.ok(
      plan.files.includes(`${SUITE_DIR}hook-post-pr-completion.test.mjs`),
      "the test that names the hook by full path must be selected",
    );
    assert.ok(plan.files.length < listFiles(TIER_INTEGRATION).length, "selection must stay scoped");
  });
});

describe("changedSetVsBase (D4)", () => {
  function changedSetVsBase(base, root, options) {
    return requiredRunnerSeam("changedSetVsBase")(base, root, options);
  }

  test("two successful git calls return separate changed and deleted path lists", () => {
    const calls = [];
    const result = changedSetVsBase("main", "/repo", {
      spawnGit: (command, args) => {
        calls.push(args);
        return args.includes("--diff-filter=D")
          ? { status: 0, stdout: "b.test.mjs\n" }
          : { status: 0, stdout: "a.mjs\nb.test.mjs\n" };
      },
    });
    assert.deepEqual(result, {
      changed: ["a.mjs", "b.test.mjs"],
      deleted: ["b.test.mjs"],
    });
    assert.equal(calls.length, 2);
  });

  test("a failed changed-set query returns an empty changed list (fails closed)", () => {
    const result = changedSetVsBase("main", "/repo", {
      spawnGit: (command, args) =>
        args.includes("--diff-filter=D")
          ? { status: 0, stdout: "" }
          : { status: 1, stdout: "" },
    });
    assert.deepEqual(result.changed, []);
  });

  test("a failed deleted-set query returns an empty deleted list without breaking the changed list", () => {
    const result = changedSetVsBase("main", "/repo", {
      spawnGit: (command, args) =>
        args.includes("--diff-filter=D")
          ? { status: 1, stdout: "" }
          : { status: 0, stdout: "a.mjs\n" },
    });
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.changed, ["a.mjs"]);
  });

  test("a D-status path appears in both the changed and deleted lists", () => {
    const result = changedSetVsBase("main", "/repo", {
      spawnGit: (command, args) =>
        args.includes("--diff-filter=D")
          ? { status: 0, stdout: "removed.test.mjs\n" }
          : { status: 0, stdout: "removed.test.mjs\nkept.mjs\n" },
    });
    assert.deepEqual([...result.changed].sort(), ["kept.mjs", "removed.test.mjs"]);
    assert.deepEqual(result.deleted, ["removed.test.mjs"]);
  });
});

describe("resolveChangedBaseRef: --changed prefers the remote-tracking ref over a stale local branch", () => {
  function resolveChangedBaseRef(base, root, options) {
    return requiredRunnerSeam("resolveChangedBaseRef")(base, root, options);
  }
  function changedSetVsBase(base, root, options) {
    return requiredRunnerSeam("changedSetVsBase")(base, root, options);
  }
  function probeWith(status) {
    const calls = [];
    return {
      calls,
      spawnGit: (command, args, opts) => {
        calls.push({ command, args, cwd: opts?.cwd });
        return { status, stdout: "" };
      },
    };
  }

  test("a bare branch name resolves to origin/<name> when that remote-tracking ref exists", () => {
    const probe = probeWith(0);
    assert.equal(resolveChangedBaseRef("main", "/repo", probe), "origin/main");
    assert.equal(probe.calls.length, 1);
    assert.equal(probe.calls[0].cwd, "/repo");
    assert.ok(
      probe.calls[0].args.includes("refs/remotes/origin/main^{commit}"),
      `must probe the exact remote-tracking ref, got ${probe.calls[0].args.join(" ")}`,
    );
  });

  test("a missing remote-tracking ref falls back to the name as given", () => {
    assert.equal(resolveChangedBaseRef("main", "/repo", probeWith(1)), "main");
  });

  test("a source release tag has no remote-tracking ref, so the probe fails and the tag is used as given", () => {
    const probe = probeWith(1);
    assert.equal(resolveChangedBaseRef("production-v6.98.0", "/repo", probe), "production-v6.98.0");
    assert.equal(probe.calls.length, 1);
  });

  test("an already exact base is returned untouched without probing: full ref, consumer rules tag, empty, non-string", () => {
    for (const base of ["origin/main", "refs/heads/main", "feature/x", "production-20261003-rules", "production-20261003-rules-2", ""]) {
      const probe = probeWith(0);
      assert.equal(resolveChangedBaseRef(base, "/repo", probe), base, `base ${JSON.stringify(base)}`);
      assert.equal(probe.calls.length, 0, `base ${JSON.stringify(base)} must not be probed`);
    }
    const probe = probeWith(0);
    assert.equal(resolveChangedBaseRef(null, "/repo", probe), null);
    assert.equal(probe.calls.length, 0);
  });

  function git(cwd, ...args) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  }
  function initIdentity(dir) {
    git(dir, "config", "user.email", "t@example.invalid");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "commit.gpgsign", "false");
  }
  function commitFile(dir, name) {
    writeFileSync(path.join(dir, name), `${name}\n`);
    git(dir, "add", name);
    git(dir, "commit", "-q", "-m", `add ${name}`);
  }

  // The real scenario: other PRs landed on origin/main, the PR branch was cut from the fresh origin/main in a linked
  // worktree, and the local `main` branch was never fast-forwarded (it cannot be, from there).
  function makeStaleLocalMainRepo(label) {
    const origin = path.join(tmpRoot, `${label}-origin.git`);
    const seed = path.join(tmpRoot, `${label}-seed`);
    const work = path.join(tmpRoot, `${label}-work`);
    mkdirSync(origin, { recursive: true });
    git(origin, "init", "-q", "--bare", "-b", "main");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    initIdentity(seed);
    git(seed, "remote", "add", "origin", origin);
    commitFile(seed, "base.txt");
    git(seed, "push", "-q", "origin", "main");
    git(tmpRoot, "clone", "-q", origin, work);
    initIdentity(work);
    commitFile(seed, "other-pr-1.txt");
    commitFile(seed, "other-pr-2.txt");
    git(seed, "push", "-q", "origin", "main");
    git(work, "fetch", "-q", "origin");
    git(work, "checkout", "-q", "-b", "feature/pr", "--no-track", "origin/main");
    commitFile(work, "pr-change.txt");
    return work;
  }

  test("stale local main: the old base drags in other PRs' files, the resolved base selects only this PR's", () => {
    const work = makeStaleLocalMainRepo("stale-main");
    assert.notEqual(
      git(work, "rev-parse", "main"),
      git(work, "rev-parse", "origin/main"),
      "fixture must have a local main behind origin/main",
    );
    const stale = changedSetVsBase("main", work).changed.sort();
    assert.deepEqual(stale, ["other-pr-1.txt", "other-pr-2.txt", "pr-change.txt"], "documents the bloat of the unresolved base");

    const base = resolveChangedBaseRef("main", work);
    assert.equal(base, "origin/main");
    assert.deepEqual(changedSetVsBase(base, work).changed, ["pr-change.txt"]);
  });

  test("no remote-tracking ref: the local base is used and the selection is unchanged", () => {
    const dir = path.join(tmpRoot, "no-remote-repo");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    initIdentity(dir);
    commitFile(dir, "base.txt");
    git(dir, "checkout", "-q", "-b", "feature/pr");
    commitFile(dir, "pr-change.txt");
    const base = resolveChangedBaseRef("main", dir);
    assert.equal(base, "main");
    assert.deepEqual(changedSetVsBase(base, dir).changed, ["pr-change.txt"]);
  });
});

describe("SC9: real-repo shard-import wrapper checkpoint (D3, fcc85c336)", () => {
  // Only reads real manifest source files (no spawn) — pinned against design.md
  // D3's named checkpoint so a future re-shard silently drops a wrapper never
  // goes unnoticed.
  test("review-remediation-evidence.test.mjs selects its seven -runner- wrappers (a, b, c, d1-d4)", () => {
    const selectIntegration = requiredRunnerSeam("selectIntegrationTestFilesForChangedFiles");
    const body = `${SUITE_DIR}review-remediation-evidence.test.mjs`;
    const plan = selectIntegration([body]);
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.deepEqual(
      new Set(plan.files),
      new Set([
        body,
        `${SUITE_DIR}review-remediation-evidence-runner-a.test.mjs`,
        `${SUITE_DIR}review-remediation-evidence-runner-b.test.mjs`,
        `${SUITE_DIR}review-remediation-evidence-runner-c.test.mjs`,
        `${SUITE_DIR}review-remediation-evidence-runner-d1.test.mjs`,
        `${SUITE_DIR}review-remediation-evidence-runner-d2.test.mjs`,
        `${SUITE_DIR}review-remediation-evidence-runner-d3.test.mjs`,
        `${SUITE_DIR}review-remediation-evidence-runner-d4.test.mjs`,
        ...REPO_SWEEP_INTEGRATION_TESTS,
      ]),
    );
  });

  test("run-second-reviewer-projection.test.mjs selects its five wrappers, including non -runner- named ones", () => {
    const selectIntegration = requiredRunnerSeam("selectIntegrationTestFilesForChangedFiles");
    const body = `${SUITE_DIR}run-second-reviewer-projection.test.mjs`;
    const plan = selectIntegration([body]);
    assert.equal(plan.fallbackToFull, false, plan.reason);
    assert.deepEqual(
      new Set(plan.files),
      new Set([
        body,
        `${SUITE_DIR}run-second-reviewer-projection-ownership.test.mjs`,
        `${SUITE_DIR}run-second-reviewer-projection-reconcile.test.mjs`,
        `${SUITE_DIR}run-second-reviewer-projection-reviewer-home.test.mjs`,
        `${SUITE_DIR}run-second-reviewer-projection-runner-a.test.mjs`,
        `${SUITE_DIR}run-second-reviewer-projection-runner-b.test.mjs`,
        ...REPO_SWEEP_INTEGRATION_TESTS,
      ]),
    );
  });
});

describe("consumer rules smoke selection", () => {
  test("recognizes only production rules tag bases", () => {
    assert.equal(isConsumerRulesTagBase("production-20260707-rules"), true);
    assert.equal(isConsumerRulesTagBase("production-20260707-rules-2"), true);
    assert.equal(isConsumerRulesTagBase("production-20260707"), false);
    assert.equal(isConsumerRulesTagBase("production-v6.83.0"), false);
  });

  test("detects installed consumer source by .devpro-agent-rules files", () => {
    const consumerRoot = makeConsumerRoot("consumer-installed");
    const unrelatedRoot = path.join(tmpRoot, "unrelated");
    mkdirSync(path.join(unrelatedRoot, ".devpro-agent-rules"), { recursive: true });
    writeFileSync(path.join(unrelatedRoot, ".devpro-agent-rules", "AGENTS.md"), "");

    assert.equal(isConsumerRulesRepoRoot(consumerRoot), true);
    assert.equal(isConsumerRulesRepoRoot(unrelatedRoot), false);
    assert.equal(isConsumerRulesRepoRoot(REPO_ROOT), false);
  });

  test("detects fresh consumer rules worktree before submodule init", () => {
    const freshRoot = makeDeclaredConsumerRoot("consumer-declared-fresh");
    const declaredWithoutRootScripts = path.join(tmpRoot, "declared-without-root-scripts");
    mkdirSync(declaredWithoutRootScripts, { recursive: true });
    writeFileSync(
      path.join(declaredWithoutRootScripts, ".gitmodules"),
      '[submodule ".devpro-agent-rules"]\n\tpath = .devpro-agent-rules\n',
    );

    assert.equal(
      existsSync(path.join(freshRoot, ".devpro-agent-rules", "AGENTS.md")),
      false,
    );
    assert.equal(isConsumerRulesRepoRoot(freshRoot), true);
    assert.equal(isConsumerRulesRepoRoot(declaredWithoutRootScripts), false);
  });

  test("consumer smoke commands use synchronized root scripts and source N/A surface", () => {
    const commands = consumerRulesSmokeCommands({ nodeCommand: "node" });
    assert.deepEqual(
      commands.map(({ label, command, args }) => [label, command, args]),
      [
        ["submodule-init", "git", ["submodule", "update", "--init", ".devpro-agent-rules"]],
        [
          "submodule-sync",
          "node",
          [".devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs", "--sync"],
        ],
        ["sync-check", "node", [".devpro/scripts/sync-agent-rules.mjs", "--check"]],
        [
          "doctor-consumer-smoke",
          "node",
          [".devpro/scripts/devpro-doctor.mjs", "--consumer-smoke"],
        ],
        [
          "generated-tool-tests",
          "node",
          [
            "--test",
            ".devpro/scripts/tests/multi-runtime-parity.test.mjs",
            ".devpro/scripts/tests/hook-pre-tool-gate-git-flow.test.mjs",
          ],
        ],
      ],
    );

    const flattened = commands.flatMap(({ args }) => args);
    assert.equal(flattened.includes("--sync"), true);
    assert.equal(
      flattened.includes(".devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs"),
      true,
    );
  });
});

describe("consumer context resolution", () => {
  test("direct consumer markers resolve without probing Git", () => {
    const resolveConsumerRulesContext = requiredRunnerSeam(
      "resolveConsumerRulesContext",
    );
    const consumerRoot = makeConsumerRoot("resolver-direct");
    let probeCount = 0;

    const context = resolveConsumerRulesContext(consumerRoot, {
      runGit: () => {
        probeCount += 1;
        return { status: 0, stdout: "" };
      },
    });

    assert.equal(probeCount, 0);
    assert.deepEqual(context, {
      profile: "consumer",
      mode: "direct",
      consumerRoot: path.resolve(consumerRoot),
    });
  });

  test("validated exact consumer-owned submodule resolves to its owner", () => {
    const resolveConsumerRulesContext = requiredRunnerSeam(
      "resolveConsumerRulesContext",
    );
    const consumerRoot = makeDeclaredConsumerRoot("resolver-submodule-owner");
    const submoduleRoot = path.join(consumerRoot, ".devpro-agent-rules");
    mkdirSync(submoduleRoot, { recursive: true });
    const calls = [];

    const context = resolveConsumerRulesContext(submoduleRoot, {
      runGit: (command, args) => {
        calls.push([command, args]);
        return { status: 0, stdout: `${consumerRoot}\n` };
      },
    });

    assert.deepEqual(calls, [
      [
        "git",
        ["-C", path.resolve(submoduleRoot), "rev-parse", "--show-superproject-working-tree"],
      ],
    ]);
    assert.deepEqual(context, {
      profile: "consumer",
      mode: "submodule",
      consumerRoot: path.resolve(consumerRoot),
    });
  });

  test("empty superproject output keeps normal source context", () => {
    const resolveConsumerRulesContext = requiredRunnerSeam(
      "resolveConsumerRulesContext",
    );
    const sourceRoot = path.join(tmpRoot, "resolver-source");
    mkdirSync(sourceRoot, { recursive: true });

    const context = resolveConsumerRulesContext(sourceRoot, {
      runGit: () => ({ status: 0, stdout: "\n" }),
    });

    assert.deepEqual(context, { profile: "source", mode: "direct" });
  });

  test("probe failure keeps source context with a bounded diagnostic", () => {
    const resolveConsumerRulesContext = requiredRunnerSeam(
      "resolveConsumerRulesContext",
    );
    const sourceRoot = path.join(tmpRoot, "resolver-probe-error");
    mkdirSync(sourceRoot, { recursive: true });

    const context = resolveConsumerRulesContext(sourceRoot, {
      runGit: () => ({ status: 128, stdout: "", stderr: "synthetic failure" }),
    });

    assert.equal(context.profile, "source");
    assert.equal(context.mode, "direct");
    assert.match(context.diagnostic ?? context.reason ?? "", /probe/i);
  });

  test("wrong submodule path and unvalidated owner preserve source rigor", () => {
    const resolveConsumerRulesContext = requiredRunnerSeam(
      "resolveConsumerRulesContext",
    );
    const consumerRoot = makeDeclaredConsumerRoot("resolver-wrong-path-owner");
    const wrongPath = path.join(consumerRoot, "nested-source");
    mkdirSync(wrongPath, { recursive: true });
    const unvalidatedOwner = path.join(tmpRoot, "resolver-unvalidated-owner");
    const unvalidatedSubmodule = path.join(
      unvalidatedOwner,
      ".devpro-agent-rules",
    );
    mkdirSync(unvalidatedSubmodule, { recursive: true });

    const wrongPathContext = resolveConsumerRulesContext(wrongPath, {
      runGit: () => ({ status: 0, stdout: `${consumerRoot}\n` }),
    });
    const unvalidatedContext = resolveConsumerRulesContext(unvalidatedSubmodule, {
      runGit: () => ({ status: 0, stdout: `${unvalidatedOwner}\n` }),
    });

    assert.equal(wrongPathContext.profile, "source");
    assert.equal(unvalidatedContext.profile, "source");
  });
});

describe("test suite route selection", () => {
  test("rules tags retain smoke precedence for both consumer modes", () => {
    const selectTestSuiteRoute = requiredRunnerSeam("selectTestSuiteRoute");

    for (const mode of ["direct", "submodule"]) {
      assert.equal(
        selectTestSuiteRoute({
          changedBase: "production-20260707-rules",
          consumerContext: { profile: "consumer", mode },
        }),
        "consumer-smoke",
      );
    }
  });

  test("all non-rules-tag consumer requests select deterministic N/A", () => {
    const selectTestSuiteRoute = requiredRunnerSeam("selectTestSuiteRoute");

    for (const mode of ["direct", "submodule"]) {
      for (const changedBase of [null, "main", "feature/base"]) {
        assert.equal(
          selectTestSuiteRoute({
            changedBase,
            consumerContext: { profile: "consumer", mode },
          }),
          "consumer-na",
        );
      }
    }
  });

  test("source and unresolved contexts preserve the source suite", () => {
    const selectTestSuiteRoute = requiredRunnerSeam("selectTestSuiteRoute");

    for (const consumerContext of [
      { profile: "source", mode: "direct" },
      null,
      undefined,
    ]) {
      assert.equal(
        selectTestSuiteRoute({ changedBase: "main", consumerContext }),
        "source-suite",
      );
    }
  });
});

test("test-suite-cadence documents PR-stage integration scope and governance full suite", () => {
  const leaf = readFileSync(
    repoPath(".devpro/agent-rules/test-suite-cadence.md"),
    "utf8",
  );
  const lines = leaf.split("\n");
  const sectionStart = lines.findIndex((line) =>
    line.startsWith("### Source Repo Test Runtime Budget"),
  );
  assert.notEqual(sectionStart, -1, "§Source Repo Test Runtime Budget must exist");
  const nextHeadingOffset = lines
    .slice(sectionStart + 1)
    .findIndex((line) => line.startsWith("### "));
  const sectionEnd =
    nextHeadingOffset === -1 ? lines.length : sectionStart + 1 + nextHeadingOffset;
  const section = lines.slice(sectionStart, sectionEnd).join("\n");
  const changedRouteLine = lines.find((line) => line.includes("`--changed <base>` 機械判定"));

  // Assert on stable tokens (not whole sentences) — the surrounding prose is
  // still being authored by a concurrent task in this same change.
  for (const token of [
    "changed manifest integration tests",
    "shard-import wrappers",
    "changed unit-tier test 不展開任何 wrapper",
    "integration_files=0/<total> selection=scoped",
    "changed-set-unavailable",
    "unknown-path",
    "selector-error",
    "selection-unexplained",
  ]) {
    assert.ok(
      (changedRouteLine ?? "").includes(token),
      `§Source Repo Test Runtime Budget --changed bullet must mention "${token}"`,
    );
  }

  // Old selection mechanism vocabulary MUST NOT survive in this section (SC7).
  for (const stalePhrase of ["ownership graph", "recursive repo-scan", "carrier owners"]) {
    assert.equal(
      section.includes(stalePhrase),
      false,
      `§Source Repo Test Runtime Budget must not still describe "${stalePhrase}"`,
    );
  }

  // SC7's two questions must be directly answerable from this section: which
  // integration files run at PR stage, and when the full set runs.
  assert.match(section, /本 PR 新增或修改的 integration-tier/);
  assert.match(section, /`devpro:rule-governance`/);
  assert.match(section, /release/);
});

/**
 * strengthen-evidence-reverifiability R5 — wall-clock 不作為驗收證據.
 *
 * The rule lives in test-suite-cadence.md, but the fact it asserts is a property of
 * THIS runner: `realSeconds` reaches only `console.log`, while the named log
 * carries the child's TAP and `summarizeTapLog` reads back no timing field. So
 * the clause is locked next to the mechanism it describes — if a refactor ever
 * gives the summary a seconds field, the prose stops being true and this goes
 * red instead of the rule silently rotting.
 */
describe("R5 wall-clock is run-time visibility, not acceptance evidence", () => {
  const leaf = readFileSync(
    repoPath(".devpro/agent-rules/test-suite-cadence.md"),
    "utf8",
  );

  // Bind on ONE physical line per rule-anchor-guard-strength.md, and count the
  // matching lines so 唯一命中 is asserted rather than assumed.
  const operativeLines = (content, pattern) =>
    content.split("\n").filter((line) => pattern.test(line));

  test("prose separates run-time visibility from acceptance evidence", () => {
    const hits = operativeLines(
      leaf,
      /「回報耗時」是 run-time 可見度，不等於驗收證據[^\n]*沒有任何一個欄位帶秒數[^\n]*把 wall-clock 寫進驗收證據行 MUST NOT 發生/,
    );
    assert.equal(
      hits.length,
      1,
      "test-suite-cadence.md 必須有且只有一行同時綁定「耗時=可見度」與「wall-clock MUST NOT 進驗收證據行」",
    );
  });

  test("prose points completion evidence at the named log's counts", () => {
    const hits = operativeLines(
      leaf,
      /完成證據取\*\*最終狀態\*\*那次 run 的具名 log 與其計數[^\n]*不得沿用中途[^\n]*run-time 可見度而非完成證據/,
    );
    assert.equal(
      hits.length,
      1,
      "完成證據 bullet 必須唯一綁定具名 log 計數，且明示 real time 不充當「跑完了」憑據",
    );
  });

  test("summarizeTapLog exposes no timing field (with a two-way fixture)", () => {
    const dir = path.join(tmpRoot, "r5-no-timing-field");
    mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "tap.log");
    writeFileSync(
      logPath,
      ["ok 1 - only case", "# tests 1", "# pass 1", "# fail 0", ""].join("\n"),
    );

    const timingFields = (shape) =>
      Object.keys(shape).filter((key) =>
        /sec|dur|elapsed|real|wall|millis|\btime/i.test(key),
      );

    // 反例（MUST 放行）：the real shape the rule describes.
    const summary = summarizeTapLog(logPath);
    assert.deepEqual(
      timingFields(summary),
      [],
      "summarizeTapLog 回讀欄位不得帶秒數 — 一旦有，test-suite-cadence.md 的「沒有任何一個欄位帶秒數」就不再為真，須同步改規則",
    );

    // 正例（MUST 轉紅）：a forbidden-side assertion with no positive fixture is
    // 恆綠 and indistinguishable from a no-op (rule-anchor-guard-strength.md
    // §缺席軸). These pin that the detector actually fires.
    assert.deepEqual(timingFields({ ...summary, realSeconds: 7.4 }), [
      "realSeconds",
    ]);
    assert.deepEqual(timingFields({ ...summary, durationMs: 7400 }), [
      "durationMs",
    ]);
  });
});

describe("fix-silent-gate-skip R4 full-fallback explicit degrade", () => {
  test("parseArgs accepts --allow-full-fallback", () => {
    assert.deepEqual(
      parseArgs(["--changed", "main", "--allow-full-fallback"], { repoRoot: REPO_ROOT }),
      {
        tier: null,
        changedBase: "main",
        repoRoot: REPO_ROOT,
        allowFullFallback: true,
        stdioMode: "log",
      },
    );
  });

  test("EXIT_FULL_FALLBACK is dedicated code 75; summary lists unresolved paths", () => {
    assert.equal(EXIT_FULL_FALLBACK, 75);
    const summary = formatChangedSelectionSummary(
      {
        files: ["a.test.mjs"],
        fallbackToFull: true,
        reason: "unknown-path",
        diagnostics: { classifications: { "mystery.bin": "unknown" } },
      },
      10,
    );
    assert.match(summary, /full-fallback:unknown-path/);
    assert.match(summary, /unresolved_paths=mystery\.bin/);
  });

  // CLI spawn prove-it lives in run-test-suite-full-fallback.test.mjs (integration).

  test("--allow-full-fallback is opt-in escape only (not CI default); banner still printed", () => {
    assert.equal(
      parseArgs(["--changed", "main"], { repoRoot: REPO_ROOT }).allowFullFallback,
      false,
    );
    const denied = formatFullFallbackBanner({
      reason: "unknown-path",
      summary: "selection=full-fallback:unknown-path",
      allowFullFallback: false,
    });
    const allowed = formatFullFallbackBanner({
      reason: "unknown-path",
      summary: "selection=full-fallback:unknown-path",
      allowFullFallback: true,
    });
    assert.match(denied, /FULL-FALLBACK \(fail-visible\)/);
    assert.match(denied, new RegExp(`exiting ${EXIT_FULL_FALLBACK}`));
    assert.match(allowed, /FULL-FALLBACK \(fail-visible\)/);
    assert.match(allowed, /--allow-full-fallback/);
    assert.match(allowed, /opt-in escape/);
    assert.doesNotMatch(allowed, new RegExp(`exiting ${EXIT_FULL_FALLBACK}`));
  });
});

describe("suite digest line", () => {
  const UNIT = "1".repeat(64);
  const INTEGRATION = "2".repeat(64);
  const sha = (text) => createHash("sha256").update(text).digest("hex");

  function captureStdout(fn) {
    const original = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(" "));
    try {
      fn();
    } finally {
      console.log = original;
    }
    return lines;
  }

  test("combineTierDigests hashes one `<tier>=<digest>` line per tier, sorted by tier name", () => {
    const combineTierDigests = requiredRunnerSeam("combineTierDigests");
    const expected = sha(`integration=${INTEGRATION}\nunit=${UNIT}\n`);
    assert.equal(
      combineTierDigests([
        { tier: "unit", digestSha256: UNIT },
        { tier: "integration", digestSha256: INTEGRATION },
      ]),
      expected,
    );
    assert.equal(
      combineTierDigests([
        { tier: "integration", digestSha256: INTEGRATION },
        { tier: "unit", digestSha256: UNIT },
      ]),
      expected,
      "run order must not change the value",
    );
  });

  test("a unit-only run and a unit + integration run get different values", () => {
    const combineTierDigests = requiredRunnerSeam("combineTierDigests");
    const unitOnly = combineTierDigests([{ tier: "unit", digestSha256: UNIT }]);
    const both = combineTierDigests([
      { tier: "unit", digestSha256: UNIT },
      { tier: "integration", digestSha256: INTEGRATION },
    ]);
    assert.notEqual(unitOnly, both);
    assert.match(unitOnly, /^[0-9a-f]{64}$/);
    assert.notEqual(unitOnly, UNIT, "the combined value is not the bare tier digest");
  });

  test("changing any tier digest changes the value", () => {
    const combineTierDigests = requiredRunnerSeam("combineTierDigests");
    const base = combineTierDigests([
      { tier: "unit", digestSha256: UNIT },
      { tier: "integration", digestSha256: INTEGRATION },
    ]);
    const changed = combineTierDigests([
      { tier: "unit", digestSha256: UNIT },
      { tier: "integration", digestSha256: "3".repeat(64) },
    ]);
    assert.notEqual(base, changed);
  });

  test("combineTierDigests refuses a digest that is not 64 lowercase hex", () => {
    const combineTierDigests = requiredRunnerSeam("combineTierDigests");
    for (const bad of ["", "abc", "g".repeat(64), "A".repeat(64), "1".repeat(63), undefined]) {
      assert.throws(() => combineTierDigests([{ tier: "unit", digestSha256: bad }]), /64 lowercase hex/);
    }
  });

  test("formatSuiteDigest names the tiers it covers", () => {
    const formatSuiteDigest = requiredRunnerSeam("formatSuiteDigest");
    assert.equal(
      formatSuiteDigest([
        { tier: "unit", digestSha256: UNIT },
        { tier: "integration", digestSha256: INTEGRATION },
      ]),
      `[test-suite] suite_digest_sha256=${sha(`integration=${INTEGRATION}\nunit=${UNIT}\n`)} tiers=integration,unit`,
    );
  });

  test("reportSuiteDigest prints the line for a passing run that logged every tier", () => {
    const reportSuiteDigest = requiredRunnerSeam("reportSuiteDigest");
    const digests = [
      { tier: "unit", digestSha256: UNIT },
      { tier: "integration", digestSha256: INTEGRATION },
    ];
    const lines = captureStdout(() => reportSuiteDigest(digests, 2, 0));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[test-suite\] suite_digest_sha256=[0-9a-f]{64} tiers=integration,unit$/);
  });

  test("reportSuiteDigest prints nothing for a failing run, so a red digest never becomes a receipt", () => {
    const reportSuiteDigest = requiredRunnerSeam("reportSuiteDigest");
    const lines = captureStdout(() =>
      reportSuiteDigest([{ tier: "unit", digestSha256: UNIT }], 1, 1),
    );
    assert.deepEqual(lines, []);
  });

  test("reportSuiteDigest says so when a tier wrote no log", () => {
    const reportSuiteDigest = requiredRunnerSeam("reportSuiteDigest");
    const lines = captureStdout(() =>
      reportSuiteDigest([{ tier: "unit", digestSha256: UNIT }], 2, 0),
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[test-suite\] suite_digest_sha256=unavailable reason=/);
  });
});
