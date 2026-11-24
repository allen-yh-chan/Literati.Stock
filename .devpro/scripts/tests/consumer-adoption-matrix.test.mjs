import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import {
  ENFORCEMENT_BUCKETS,
  SUPPORTED_PROFILES,
  buildEnforcementMap,
  buildSummary,
  discoverRuleLeaves,
  discoverKnownCarriers,
  buildProfileView,
  formatEnforcementMapMarkdown,
  formatAgentsMdArtifact,
  formatProfileMarkdown,
  formatSummaryMarkdown,
  generateMatrix,
  validateMatrix,
  formatMarkdown,
} from "../consumer-adoption-matrix.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const matrixScript = repoPath(".devpro/scripts/consumer-adoption-matrix.mjs");
const execFileAsync = promisify(execFile);
const consumerAdoptionRule = readFileSync(
  repoPath(".devpro/agent-rules/consumer-adoption.md"),
  "utf8",
);

test("consumer adoption matrix covers every rule leaf", async () => {
  const leaves = await discoverRuleLeaves(REPO_ROOT);
  const matrix = await generateMatrix(REPO_ROOT);
  const errors = validateMatrix(matrix, leaves);

  assert.equal(matrix.length, leaves.length);
  assert.deepEqual(errors, []);
});

test("consumer adoption matrix pins key profile and audience classifications", async () => {
  const matrix = await generateMatrix(REPO_ROOT);
  const byPath = new Map(matrix.map((entry) => [entry.path, entry]));

  assert.equal(byPath.get("rule-design-principles.md").audience, "source-maintainer");
  assert.equal(byPath.get("openspec-flow-consumer.md").audience, "consumer-owned");
  assert.equal(byPath.get("consumer-adoption.md").audience, "consumer-owned");
  const playbook = byPath.get("consumer-failure-playbook.md");
  assert.ok(playbook, "consumer-failure-playbook.md must be registered in the matrix");
  assert.equal(playbook.audience, "consumer-owned");
  assert.ok(playbook.profiles.includes("consumer-lite"));
  assert.ok(byPath.get("ai-autonomy.md").profiles.includes("consumer-lite"));
  assert.ok(byPath.get("rules-flow.md").profiles.includes("consumer-lite"));
});

// Issue #3213: leaves split out of a consumer-lite entry keep the entry's profile.
test("leaves split out of openspec-quality-and-formats.md stay in the consumer-lite profile", async () => {
  const matrix = await generateMatrix(REPO_ROOT);
  const byPath = new Map(matrix.map((entry) => [entry.path, entry]));
  assert.ok(byPath.get("openspec-quality-and-formats.md").profiles.includes("consumer-lite"));
  for (const leaf of [
    "openspec-archive-principles.md",
    "openspec-quality-advanced-patterns.md",
    "openspec-quality-doc-formats.md",
    "openspec-scope-change.md",
    "openspec-spec-delta-pitfalls.md",
    "requirement-count-ratchet-internals.md",
  ]) {
    assert.ok(byPath.get(leaf), `${leaf} must be registered in the matrix`);
    assert.ok(byPath.get(leaf).profiles.includes("consumer-lite"), `${leaf} must be in consumer-lite`);
  }
});

test("consumer adoption matrix markdown names enforcement classes", async () => {
  const markdown = formatMarkdown(await generateMatrix(REPO_ROOT));

  assert.match(markdown, /hard-gate|doctrine|advisory/);
  assert.match(markdown, /`consumer-adoption\.md`/);
});

test("consumer adoption matrix exposes canonical enforcement buckets", () => {
  assert.deepEqual(ENFORCEMENT_BUCKETS.map((bucket) => bucket.key), [
    "hard-gate",
    "advisory",
    "doctrine",
  ]);
});

test("consumer adoption matrix formats markdown profile output", async () => {
  const matrix = await generateMatrix(REPO_ROOT);
  const markdown = formatProfileMarkdown(matrix, "consumer-lite");
  const litePaths = buildProfileView(matrix, "consumer-lite").entries.map((entry) => entry.path);
  const sourceOnlyPaths = buildProfileView(matrix, "source-maintainer").entries
    .filter((entry) => !entry.profiles.includes("consumer-lite"))
    .map((entry) => entry.path);

  assert.match(markdown, /^# Consumer Adoption Profile: `consumer-lite`/);
  assert.match(markdown, /`ai-autonomy\.md`/);
  assert.ok(litePaths.includes("consumer-adoption.md"));
  assert.ok(sourceOnlyPaths.length > 0);
  for (const sourcePath of sourceOnlyPaths) {
    assert.equal(markdown.includes(`\`${sourcePath}\``), false);
  }
});

test("consumer adoption matrix builds deterministic JSON profile views", async () => {
  const matrix = await generateMatrix(REPO_ROOT);
  const view = buildProfileView(matrix, "consumer-full");

  assert.equal(view.profile, "consumer-full");
  assert.ok(view.entries.length > 0);
  assert.ok(view.entries.every((entry) => entry.profiles.includes("consumer-full")));

  const { stdout } = await execFileAsync(process.execPath, [matrixScript, "--profile", "consumer-full", "--json"]);
  const cliView = JSON.parse(stdout);

  assert.equal(cliView.generatedAt, new Date(0).toISOString());
  assert.equal(cliView.profile, "consumer-full");
  assert.deepEqual(cliView.entries, view.entries);
});

test("consumer adoption matrix formats profile enforcement maps", async () => {
  const matrix = await generateMatrix(REPO_ROOT);
  const markdown = formatEnforcementMapMarkdown(matrix, "consumer-lite");
  const litePaths = buildProfileView(matrix, "consumer-lite").entries.map((entry) => entry.path);
  const sourceOnlyPaths = buildProfileView(matrix, "source-maintainer").entries
    .filter((entry) => !entry.profiles.includes("consumer-lite"))
    .map((entry) => entry.path);

  assert.match(markdown, /^# Consumer Adoption Enforcement Map: `consumer-lite`/);
  assert.match(markdown, /## Hard Gate/);
  assert.match(markdown, /## Advisory/);
  assert.match(markdown, /## Doctrine/);
  assert.ok(markdown.includes("Hard Gate = mechanically blocked"));
  assert.ok(litePaths.includes("consumer-adoption.md"));
  for (const sourcePath of sourceOnlyPaths) {
    assert.equal(markdown.includes(`\`${sourcePath}\``), false);
  }
});

test("consumer adoption matrix builds deterministic JSON enforcement maps", async () => {
  const matrix = await generateMatrix(REPO_ROOT);
  const view = buildEnforcementMap(matrix, "consumer-full");

  assert.equal(view.profile, "consumer-full");
  assert.ok(view.buckets["hard-gate"].length > 0);
  assert.ok(view.buckets.doctrine.length > 0);
  assert.ok(view.buckets["hard-gate"].every((entry) => entry.profiles.includes("consumer-full")));

  const { stdout } = await execFileAsync(process.execPath, [
    matrixScript,
    "--profile",
    "consumer-full",
    "--enforcement-map",
    "--json",
  ]);
  const cliView = JSON.parse(stdout);

  assert.equal(cliView.generatedAt, new Date(0).toISOString());
  assert.equal(cliView.profile, "consumer-full");
  assert.deepEqual(cliView.buckets, view.buckets);
});

test("consumer adoption matrix rejects hard gates without carriers", async () => {
  const leaves = await discoverRuleLeaves(REPO_ROOT);
  const matrix = await generateMatrix(REPO_ROOT);
  const synthetic = matrix.map((entry) => ({ ...entry }));

  synthetic[0] = {
    ...synthetic[0],
    enforcement: ["hard-gate"],
    carriers: [],
  };

  const errors = validateMatrix(synthetic, leaves);

  assert.match(errors.join("\n"), /hard-gate enforcement requires at least one carrier/);
});

test("consumer adoption matrix rejects generated carriers that do not exist", async () => {
  const leaves = await discoverRuleLeaves(REPO_ROOT);
  const matrix = await generateMatrix(REPO_ROOT);
  const synthetic = matrix.map((entry) => ({ ...entry }));
  const knownCarriers = await discoverKnownCarriers(REPO_ROOT);

  synthetic[0] = {
    ...synthetic[0],
    carriers: ["definitely-missing-carrier.mjs"],
  };

  const errors = validateMatrix(synthetic, leaves, { knownCarriers });

  assert.match(errors.join("\n"), /unknown generated carrier: definitely-missing-carrier\.mjs/);
});

test("consumer adoption matrix generated carriers resolve to known repo carriers", async () => {
  const leaves = await discoverRuleLeaves(REPO_ROOT);
  const knownCarriers = await discoverKnownCarriers(REPO_ROOT);
  const matrix = await generateMatrix(REPO_ROOT);
  const errors = validateMatrix(matrix, leaves, { knownCarriers });

  assert.deepEqual(errors, []);
});

test("consumer adoption matrix does not emit wildcard carrier fragments", async () => {
  const matrix = await generateMatrix(REPO_ROOT);
  const carriers = matrix.flatMap((entry) => entry.carriers);

  assert.equal(carriers.includes(".test.mjs"), false);
  assert.equal(carriers.some((carrier) => carrier.startsWith(".")), false);
  assert.equal(carriers.includes("X.test.mjs"), false);
});

test("consumer adoption matrix builds non-empty views for every supported profile", async () => {
  const matrix = await generateMatrix(REPO_ROOT);

  for (const profile of SUPPORTED_PROFILES) {
    const view = buildProfileView(matrix, profile);

    assert.equal(view.profile, profile);
    assert.ok(view.entries.length > 0);
    assert.ok(view.entries.every((entry) => entry.profiles.includes(profile)));
  }
});

test("consumer adoption matrix rejects invalid profiles", async () => {
  assert.throws(
    () => buildProfileView([{ path: "x.md", profiles: ["consumer-lite"] }], "unknown-profile"),
    /unknown profile: unknown-profile/
  );

  await assert.rejects(
    execFileAsync(process.execPath, [matrixScript, "--profile", "unknown-profile"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /unknown profile: unknown-profile/);
      return true;
    }
  );
});

test("consumer adoption matrix builds deterministic summary views", async () => {
  const matrix = await generateMatrix(REPO_ROOT);
  const summary = buildSummary(matrix, "consumer-lite");
  const markdown = formatSummaryMarkdown(matrix, "consumer-lite");

  assert.equal(summary.profile, "consumer-lite");
  assert.equal(summary.totalEntries, buildProfileView(matrix, "consumer-lite").entries.length);
  assert.equal(
    Object.values(summary.enforcementCounts).reduce((sum, count) => sum + count, 0),
    summary.enforcementAssignments
  );
  assert.match(markdown, /^# Consumer Adoption Summary: `consumer-lite`/);
  assert.match(markdown, /## Enforcement/);
  assert.match(markdown, /## Audience/);
});

test("consumer adoption rule pins compact lazy-load profile guidance", () => {
  assert.match(consumerAdoptionRule, /compact profile first/, "compact profile first anchor missing");
  assert.match(consumerAdoptionRule, /load leaf rules on demand/, "leaf lazy-load anchor missing");
  assert.match(consumerAdoptionRule, /do not copy full rule corpus/, "full corpus copy ban missing");
  assert.match(consumerAdoptionRule, /documented reason/, "full/source-maintainer reason anchor missing");
  assert.match(consumerAdoptionRule, /rule-load-ledger\.mjs/, "rule-load ledger anchor missing");
  assert.match(consumerAdoptionRule, /do not re-read unchanged leaves/, "duplicate rule read anchor missing");
});

test("consumer adoption matrix emits deterministic JSON summary from CLI", async () => {
  const matrix = await generateMatrix(REPO_ROOT);
  const expected = buildSummary(matrix, "consumer-lite");
  const { stdout } = await execFileAsync(process.execPath, [
    matrixScript,
    "--profile",
    "consumer-lite",
    "--summary",
    "--json",
  ]);
  const cliView = JSON.parse(stdout);

  assert.equal(cliView.generatedAt, new Date(0).toISOString());
  assert.deepEqual(cliView.summary, expected);
});

test("consumer adoption matrix formats generated agents-md profile artifact", async () => {
  const matrix = await generateMatrix(REPO_ROOT);
  const markdown = formatAgentsMdArtifact(matrix, "consumer-lite");
  const sourceOnlyPaths = buildProfileView(matrix, "source-maintainer").entries
    .filter((entry) => !entry.profiles.includes("consumer-lite"))
    .map((entry) => entry.path);

  assert.match(markdown, /^# AGENTS profile: consumer-lite/);
  assert.match(markdown, /Generated from `consumer-adoption-matrix\.mjs --profile consumer-lite --agents-md`/);
  assert.match(markdown, /compact profile first/, "generated compact profile first guidance missing");
  assert.match(markdown, /Load leaf rules on demand when the active task explicitly needs that rule domain/);
  assert.match(markdown, /Do not copy the full rule corpus/);
  assert.match(markdown, /documented reason/);
  assert.match(markdown, /Track loaded rule bytes with `rule-load-ledger\.mjs`/);
  assert.match(markdown, /do not re-read unchanged leaves in the same session/);
  assert.match(markdown, /`consumer-failure-playbook\.md`/);
  assert.match(markdown, /## Profile Leaves/);
  for (const sourcePath of sourceOnlyPaths) {
    assert.equal(markdown.includes(`\`${sourcePath}\``), false);
  }

  const fullMarkdown = formatAgentsMdArtifact(matrix, "consumer-full");
  assert.match(fullMarkdown, /^# AGENTS profile: consumer-full/);
});

test("consumer adoption matrix emits generated agents-md artifact from CLI", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    matrixScript,
    "--profile",
    "consumer-lite",
    "--agents-md",
  ]);

  assert.match(stdout, /^# AGENTS profile: consumer-lite/);
  assert.match(stdout, /`consumer-adoption\.md`/);
  assert.match(stdout, /`consumer-failure-playbook\.md`/);
});

test("consumer adoption matrix agents-md output requires an explicit profile", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [matrixScript, "--agents-md"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--agents-md requires --profile/);
      return true;
    }
  );
});

test("consumer adoption matrix agents-md output rejects other output modes", async () => {
  for (const conflictingFlag of ["--json", "--check", "--summary", "--enforcement-map"]) {
    await assert.rejects(
      execFileAsync(process.execPath, [
        matrixScript,
        "--profile",
        "consumer-lite",
        "--agents-md",
        conflictingFlag,
      ]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /cannot combine --agents-md/);
        return true;
      }
    );
  }
});
