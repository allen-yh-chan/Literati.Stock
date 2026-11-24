/**
 * Real-Git CLI coverage for Mode A and Mode B consumer routing.
 *
 * The true-submodule fixture is created once for this file. General consumer
 * requests must stop before any source manifest child is dispatched.
 */

import { after, before, test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isCanonicalSourceRepoRoot } from "../windows-checkout-preflight.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const runnerPath = path.join(REPO_ROOT, ".devpro", "scripts", "run-test-suite.mjs");
const fixtureRoot = realpathSync(
  makeTempDir("consumer-routing-test-"),
);
const directConsumerRoot = path.join(fixtureRoot, "direct-consumer");
const submoduleSourceRoot = path.join(fixtureRoot, "submodule-source");
const submoduleConsumerRoot = path.join(fixtureRoot, "submodule-consumer");
const trueSubmoduleRoot = path.join(
  submoduleConsumerRoot,
  ".devpro-agent-rules",
);
const EXPECTED_NA =
  "[test-suite] source-maintainer checks: N/A reason=consumer repository profile; source-only corpus checks are not required";
const EXPECTED_SMOKE_NA =
  "[test-suite] source-maintainer checks: N/A reason=consumer rules lane uses generated-file smoke; source-only corpus checks are not required";

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function configureFixtureIdentity(root) {
  runGit(["config", "user.name", "Consumer Routing Fixture"], root);
  runGit(["config", "user.email", "fixture@example.invalid"], root);
}

function writeConsumerEntrypoints(root) {
  mkdirSync(path.join(root, ".devpro", "scripts"), { recursive: true });
  writeFileSync(path.join(root, ".devpro", "scripts", "sync-agent-rules.mjs"), "");
  writeFileSync(
    path.join(root, ".devpro", "scripts", "devpro-doctor.mjs"),
    "process.exit(7);\n",
  );
}

function runConsumerRoute(root, requestArgs) {
  return spawnSync(
    process.execPath,
    [runnerPath, ...requestArgs, "--root", root, "--stdio", "inherit"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
}

function assertConsumerNa(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), EXPECTED_NA);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\[test-suite\] (tier|smoke)=/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /checkout-preflight=/);
}

function assertSmokeFailurePropagates(result) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, "synthetic smoke fixture must fail");
  assert.ok(result.stdout.includes(EXPECTED_SMOKE_NA));
  assert.match(result.stdout, /\[test-suite\] smoke=/);
  assert.doesNotMatch(result.stdout, /\[test-suite\] tier=/);
  assert.doesNotMatch(result.stdout, /checkout-preflight=/);
}

before(() => {
  mkdirSync(path.join(directConsumerRoot, ".devpro-agent-rules", ".devpro", "scripts"), {
    recursive: true,
  });
  writeFileSync(
    path.join(directConsumerRoot, ".devpro-agent-rules", "AGENTS.md"),
    "版本：0.0.0\n",
  );
  writeFileSync(
    path.join(
      directConsumerRoot,
      ".devpro-agent-rules",
      ".devpro",
      "scripts",
      "sync-agent-rules.mjs",
    ),
    "",
  );

  mkdirSync(submoduleSourceRoot, { recursive: true });
  runGit(["init", "--initial-branch=main"], submoduleSourceRoot);
  configureFixtureIdentity(submoduleSourceRoot);
  mkdirSync(path.join(submoduleSourceRoot, ".devpro", "scripts"), {
    recursive: true,
  });
  writeFileSync(path.join(submoduleSourceRoot, "AGENTS.md"), "版本：0.0.0\n");
  writeFileSync(
    path.join(submoduleSourceRoot, ".devpro", "scripts", "sync-agent-rules.mjs"),
    "",
  );
  runGit(["add", "AGENTS.md", ".devpro/scripts/sync-agent-rules.mjs"], submoduleSourceRoot);
  runGit(["commit", "-m", "fixture source"], submoduleSourceRoot);

  mkdirSync(submoduleConsumerRoot, { recursive: true });
  runGit(["init", "--initial-branch=main"], submoduleConsumerRoot);
  configureFixtureIdentity(submoduleConsumerRoot);
  writeConsumerEntrypoints(submoduleConsumerRoot);
  runGit(["add", ".devpro/scripts"], submoduleConsumerRoot);
  runGit(["commit", "-m", "fixture consumer"], submoduleConsumerRoot);
  runGit(
    [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleSourceRoot,
      ".devpro-agent-rules",
    ],
    submoduleConsumerRoot,
  );
  runGit(["commit", "-am", "add fixture submodule"], submoduleConsumerRoot);
});

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test("real-Git Mode B fixture reports the owning superproject", () => {
  assert.equal(
    runGit(["rev-parse", "--show-superproject-working-tree"], trueSubmoduleRoot).replace(/\\/gu, "/"),
    submoduleConsumerRoot.replace(/\\/gu, "/"),
  );
  assert.equal(
    runGit(["config", "--file", ".gitmodules", "--get", "submodule..devpro-agent-rules.path"], submoduleConsumerRoot),
    ".devpro-agent-rules",
  );
});

test("consumer routes import the real checkout-preflight module", () => {
  assert.equal(typeof isCanonicalSourceRepoRoot, "function");
});

const REQUESTS = [
  ["changed main", ["--changed", "main"]],
  ["default", []],
  ["tier all", ["--tier", "all"]],
  ["explicit unit tier", ["--tier", "unit"]],
];

for (const [label, requestArgs] of REQUESTS) {
  test(`Mode A ${label} returns exact N/A without source dispatch`, () => {
    assertConsumerNa(runConsumerRoute(directConsumerRoot, requestArgs));
  });

  test(`Mode B ${label} returns exact N/A without source dispatch`, () => {
    assertConsumerNa(runConsumerRoute(trueSubmoduleRoot, requestArgs));
  });
}

test("Scenario: Consumer Rules Release Route Precedes Source Checkout Preflight — Mode A smoke failure propagates", () => {
  assertSmokeFailurePropagates(
    runConsumerRoute(directConsumerRoot, [
      "--changed",
      "production-20260707-rules",
    ]),
  );
});

test("Scenario: Consumer Rules Release Route Precedes Source Checkout Preflight — Mode B smoke failure propagates", () => {
  assertSmokeFailurePropagates(
    runConsumerRoute(trueSubmoduleRoot, [
      "--changed",
      "production-20260707-rules",
    ]),
  );
});

test("Scenario: Non-release Consumer Route Reports Source Checks N-A", () => {
  assertConsumerNa(runConsumerRoute(directConsumerRoot, ["--changed", "main"]));
});

test("Scenario: Explicit Source Tier Does Not Bypass Consumer Routing", () => {
  assertConsumerNa(runConsumerRoute(directConsumerRoot, ["--tier", "unit"]));
});

test("Scenario: Invalid Or Consumer Integration Manifest Fails Before Any Tier Spawn", () => {
  const result = runConsumerRoute(directConsumerRoot, [
    "--tier",
    "integration",
    "--integration-manifest",
    "notes/tmp/exact-integration-files.list",
  ]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, output);
  assert.match(
    output,
    /--integration-manifest cannot be combined with --root|source-suite only/i,
  );
  assert.doesNotMatch(output, /\[test-suite\] (tier|smoke)=/);
  assert.doesNotMatch(output, /checkout-preflight=/);
});
