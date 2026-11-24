/**
 * Shared fixture: lint-risk-classes-record and classify-bounded risk-shape parsing (#2390).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lintRiskClassesRecord } from "../lint-risk-classes-record.mjs";
import { classifyBoundedRereview } from "../review-remediation-evidence.mjs";
import { riskClassesAlignmentFixturePath } from "./lib/risk-classes-alignment-fixture.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const FIXTURE = riskClassesAlignmentFixturePath();

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

function makeChangeFromFixture() {
  const root = makeTempDir("risk-classes-alignment-");
  const changeFolder = join(root, "openspec", "changes", "alignment-fixture");
  mkdirSync(changeFolder, { recursive: true });
  writeFileSync(join(changeFolder, "proposal-mini.md"), readFileSync(FIXTURE, "utf8"), "utf8");
  return { root, changeFolder };
}

test("shared fixture passes lint-risk-classes-record", () => {
  const { root, changeFolder } = makeChangeFromFixture();
  try {
    const result = lintRiskClassesRecord({ changeFolder });
    assert.equal(result.pass, true, JSON.stringify(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared fixture classify-bounded derives dispatch authority from none+rationale", () => {
  const root = makeTempDir("risk-classes-classify-");
  try {
    git(root, ["init", "--quiet", "-b", "main"]);
    git(root, ["config", "user.email", "risk-alignment@example.invalid"]);
    git(root, ["config", "user.name", "Risk Alignment Test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "review-target.mjs"), "export const reviewTarget = true;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", "baseline"]);
    git(root, ["checkout", "--quiet", "-b", "feature/alignment-fixture"]);
    const changeFolder = join(root, "openspec", "changes", "alignment-fixture");
    mkdirSync(changeFolder, { recursive: true });
    writeFileSync(join(changeFolder, "proposal-mini.md"), readFileSync(FIXTURE, "utf8"), "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", "add alignment fixture change"]);
    // Pin remote-tracking tip for receipt Git authority (exact-ref SSOT).
    git(root, ["update-ref", "refs/remotes/origin/main", git(root, ["rev-parse", "main"])]);
    const result = classifyBoundedRereview({
      repoRoot: root,
      changeId: "alignment-fixture",
      previousReceiptRef: null,
      repairDeltaManifestRef: null,
      dependencyClosureManifestRef: null,
      predecessorMatches: [],
    });
    assert.equal(result.dispatch_ready, true, JSON.stringify(result));
    assert.equal(result.route, "full");
    assert.match(result.dispatch_id, /^[0-9a-f]{64}$/);
    assert.match(result.risk_shape_digest_sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
