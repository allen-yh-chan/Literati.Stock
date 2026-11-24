import { describe, it, before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const detectScript = path.join(REPO_ROOT, ".devpro", "scripts", "detect-branch-base.mjs");

import {
  sortProductionTags,
  extractTagDate,
  normalizeReleaseBranchRecord,
} from "../detect-branch-base.mjs";

// Split the argument string here instead of handing it to a shell: cmd.exe does not treat single quotes
// as quoting, so `commit -m 'feat: v2'` and `branch --list 'release/*'` reach Git as different arguments there.
const splitGitArgs = (args) =>
  (args.match(/'[^']*'|"[^"]*"|\S+/g) || []).map((token) => (/^(['"])[\s\S]*\1$/.test(token) ? token.slice(1, -1) : token));
const git = (cwd, args) =>
  execFileSync("git", splitGitArgs(args), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("anchor Git discovery commands avoid shell-only quoting", async () => {
  const source = await fs.readFile(detectScript, "utf8");
  assert.doesNotMatch(source, /tag -l 'production-\*'/);
  assert.doesNotMatch(source, /for-each-ref --format='%(refname:short)'/);
  assert.doesNotMatch(source, /merge-base \$\{latest\.ref\}/);
  assert.match(source, /\["tag",\s*"-l",\s*"production-\*"\]/);
  assert.match(source, /"--format=%\(refname:short\)"/);
  assert.match(source, /\["merge-base",\s*latest\.ref,\s*mainRef\]/);
});

test("release branch normalizer strips legacy shell quotes", () => {
  assert.deepEqual(normalizeReleaseBranchRecord("'release/20260728'"), {
    name: "release/20260728",
    ref: "release/20260728",
  });
  assert.deepEqual(normalizeReleaseBranchRecord('"release/20260728"'), {
    name: "release/20260728",
    ref: "release/20260728",
  });
  assert.deepEqual(normalizeReleaseBranchRecord("'origin/release/20260728'", { remote: true }), {
    name: "release/20260728",
    ref: "origin/release/20260728",
  });
  assert.equal(normalizeReleaseBranchRecord("'feature/not-release'"), null);
  assert.equal(normalizeReleaseBranchRecord("'release/20260728'", { remote: true }), null);
});

async function createRepoWithRemoteOnlyReleaseBranch() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");

  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");
  await fs.writeFile(path.join(work, "a.txt"), "hi\n");
  git(work, "add .");
  git(work, 'commit -q -m init');
  const mainSha = git(work, "rev-parse HEAD");

  execSync(`git init -q --bare "${bare}"`);
  git(work, `remote add origin "${bare}"`);
  git(work, "push -q origin main");

  // Create release branch directly on remote, not locally
  git(bare, `branch release/20260414 ${mainSha}`);
  git(work, "fetch -q origin");

  // Sanity: no local release/*, but remote tracking exists
  const local = git(work, "branch --list 'release/*'");
  const remote = git(work, "branch -r --list 'origin/release/*'");
  assert.equal(local, "", "precondition: no local release branches");
  assert.ok(remote.includes("origin/release/20260414"), "precondition: remote tracking exists");

  return { tmp, work, mainSha };
}

async function createRepoWithMainAhead() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-mainahead-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  // commit 1 + tag production-v0.1.0
  await fs.writeFile(path.join(work, "a.txt"), "v1\n");
  git(work, "add .");
  git(work, "commit -q -m 'v1'");
  git(work, "tag production-v0.1.0");

  // commit 2 (main ahead by 1)
  await fs.writeFile(path.join(work, "b.txt"), "v2\n");
  git(work, "add .");
  git(work, "commit -q -m 'feat: v2'");

  // commit 3 (main ahead by 2)
  await fs.writeFile(path.join(work, "c.txt"), "v3\n");
  git(work, "add .");
  git(work, "commit -q -m 'fix: v3'");

  return { tmp, work };
}

async function createRepoWithLargeMainAhead({ commitCount = 24, subjectBytes = 4000 } = {}) {
  // Long subjects push `--anchor` and `--main-tip` output past the 64 KiB a pipe accepts at once.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-large-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");
  await fs.writeFile(path.join(work, "a.txt"), "v1\n");
  git(work, "add .");
  git(work, "commit -q -m 'v1'");
  git(work, "tag production-v0.1.0");
  for (let i = 0; i < commitCount; i += 1) {
    await fs.writeFile(path.join(work, `f${i}.txt`), `v${i}\n`);
    git(work, "add .");
    git(work, `commit -q -m '${`feat ${i} `.padEnd(subjectBytes, "x")}'`);
  }
  // `--touch-divergence` compares against origin/main, so give the fixture a remote-tracking ref.
  git(work, "update-ref refs/remotes/origin/main HEAD");
  return { tmp, work, commitCount };
}

async function createRepoWithGraphOnlyMainAhead() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-graph-only-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  await fs.writeFile(path.join(work, "version.txt"), "v1\n");
  git(work, "add .");
  git(work, "commit -q -m 'base'");
  const baseSha = git(work, "rev-parse HEAD");

  git(work, "checkout -q -b chore/bump-v0.1.0");
  await fs.writeFile(path.join(work, "version.txt"), "v2\n");
  git(work, "add .");
  git(work, "commit -q -m 'chore: bump v0.1.0'");

  git(work, "checkout -q main");
  git(work, "merge -q --no-ff chore/bump-v0.1.0 -m 'Merge pull request #1 from chore/bump-v0.1.0'");

  git(work, `checkout -q -b production ${baseSha}`);
  git(work, "merge -q --no-ff chore/bump-v0.1.0 -m 'release: promote v0.1.0'");
  git(work, "tag production-v0.1.0");
  git(work, "checkout -q main");

  return { tmp, work };
}

async function createRepoWithDivergedProductionTag() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-diverged-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  await fs.writeFile(path.join(work, "base.txt"), "base\n");
  git(work, "add .");
  git(work, "commit -q -m 'base'");
  const baseSha = git(work, "rev-parse HEAD");

  await fs.writeFile(path.join(work, "main.txt"), "main\n");
  git(work, "add .");
  git(work, "commit -q -m 'main change'");

  git(work, `checkout -q -b production ${baseSha}`);
  await fs.writeFile(path.join(work, "prod.txt"), "prod\n");
  git(work, "add .");
  git(work, "commit -q -m 'prod change'");
  git(work, "tag production-v0.2.0");
  git(work, "checkout -q main");

  return { tmp, work };
}

let ancestryGitProcessCount = 0;

function runGit(cwd, args) {
  ancestryGitProcessCount += 1;
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed with ${result.status}: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function runGitStatus(cwd, args) {
  ancestryGitProcessCount += 1;
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function splitLines(value) {
  return value === "" ? [] : value.split("\n").filter(Boolean);
}

async function createProductionAncestryFixture(lane) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `detect-branch-ancestry-${lane}-`));
  const work = path.join(tmp, "work");
  const payloadPath = `${lane}-payload.txt`;
  const ownPath = `${lane}-own-change.txt`;
  const tag = lane === "rules" ? "production-20260715-rules" : "production-v9.9.9";
  const productionBranch = `fixture-production-${lane}`;
  const expectedMainBranch = `fixture-reconciled-main-${lane}`;
  const ambiguousRef = `fixture-ambiguous-${lane}`;

  await fs.mkdir(work);
  runGit(work, ["init", "-q", "-b", "main"]);
  runGit(work, ["config", "user.email", "fixture@example.invalid"]);
  runGit(work, ["config", "user.name", "issue-1663-fixture"]);

  await fs.writeFile(path.join(work, "base.txt"), "base\n");
  runGit(work, ["add", "base.txt"]);
  runGit(work, ["commit", "-q", "-m", `test: ${lane} base`]);
  const baseSha = runGit(work, ["rev-parse", "HEAD"]);

  await fs.writeFile(path.join(work, payloadPath), `${lane} payload\n`);
  runGit(work, ["add", payloadPath]);
  runGit(work, ["commit", "-q", "-m", `feat: ${lane} payload`]);
  const mainPayloadSha = runGit(work, ["rev-parse", "HEAD"]);
  const preReconciliationMainSha = mainPayloadSha;

  runGit(work, ["checkout", "-q", "-b", productionBranch, baseSha]);
  runGit(work, ["cherry-pick", "--no-commit", mainPayloadSha]);
  runGit(work, ["commit", "-q", "-m", `release: promote ${lane} payload`]);
  const productionSha = runGit(work, ["rev-parse", "HEAD"]);
  runGit(work, ["tag", tag, productionSha]);

  assert.notEqual(
    productionSha,
    mainPayloadSha,
    `${lane} fixture must model a different-SHA cherry-pick`,
  );
  assert.equal(
    runGit(work, ["rev-parse", `${productionSha}^{tree}`]),
    runGit(work, ["rev-parse", `${mainPayloadSha}^{tree}`]),
    `${lane} fixture cherry-pick must be patch-equivalent to main`,
  );

  runGit(work, ["branch", ambiguousRef, mainPayloadSha]);
  runGit(work, ["tag", ambiguousRef, productionSha]);
  const ambiguousBranchSha = runGit(work, ["rev-parse", `refs/heads/${ambiguousRef}`]);
  const ambiguousTagSha = runGit(work, ["rev-parse", `refs/tags/${ambiguousRef}`]);
  assert.notEqual(
    ambiguousBranchSha,
    ambiguousTagSha,
    `${lane} fixture ambiguous branch and tag must resolve to different commits`,
  );
  const ambiguousProbe = runGitStatus(work, ["rev-parse", "--verify", ambiguousRef]);
  assert.match(
    ambiguousProbe.stderr,
    /ambiguous/,
    `${lane} fixture short ref must be ambiguous to Git`,
  );

  runGit(work, ["checkout", "-q", "main"]);
  const preAncestry = runGitStatus(work, [
    "merge-base",
    "--is-ancestor",
    tag,
    preReconciliationMainSha,
  ]);
  assert.equal(preAncestry.status, 1, `${lane} fixture must begin with a diverged production tag`);

  runGit(work, ["checkout", "-q", "-b", expectedMainBranch, preReconciliationMainSha]);
  runGit(work, [
    "merge",
    "-q",
    "--no-ff",
    tag,
    "-m",
    `fix: reconcile ${tag} into main`,
  ]);
  const reconciledMainSha = runGit(work, ["rev-parse", "HEAD"]);
  const reconciliationFirstParentCount = Number(
    runGit(work, [
      "rev-list",
      "--first-parent",
      "--count",
      `${preReconciliationMainSha}..${reconciledMainSha}`,
    ]),
  );
  const reconciliationFirstParentSha = runGit(work, [
    "rev-list",
    "--first-parent",
    "--max-count=1",
    `${preReconciliationMainSha}..${reconciledMainSha}`,
  ]);
  const reconciledParents = splitLines(
    runGit(work, ["show", "-s", "--format=%P", reconciledMainSha]).replaceAll(" ", "\n"),
  );
  const reconciliationTreeDelta = splitLines(
    runGit(work, ["diff", "--name-only", preReconciliationMainSha, reconciledMainSha]),
  );
  const postAncestry = runGitStatus(work, [
    "merge-base",
    "--is-ancestor",
    tag,
    reconciledMainSha,
  ]);
  assert.equal(postAncestry.status, 0, `${lane} fixture reconciliation must restore ancestry`);

  runGit(work, ["update-ref", "refs/remotes/origin/main", preReconciliationMainSha]);
  runGit(work, ["checkout", "-q", "-b", `fixture-own-${lane}`, tag]);
  await fs.writeFile(path.join(work, ownPath), `${lane} own change\n`);
  runGit(work, ["add", ownPath]);
  runGit(work, ["commit", "-q", "-m", `test: ${lane} own change`]);
  const pollutedThreeDotPaths = splitLines(
    runGit(work, ["diff", "origin/main...HEAD", "--name-only"]),
  );
  runGit(work, ["update-ref", "refs/remotes/origin/main", reconciledMainSha]);
  const reconciledThreeDotPaths = splitLines(
    runGit(work, ["diff", "origin/main...HEAD", "--name-only"]),
  );

  let treeMismatchRef;
  let conflictMainRef;
  let conflictProductionRef;
  if (lane === "rules") {
    treeMismatchRef = "fixture-tree-mismatch-production";
    runGit(work, ["checkout", "-q", "-b", treeMismatchRef, tag]);
    await fs.writeFile(path.join(work, "production-only.txt"), "production-only\n");
    runGit(work, ["add", "production-only.txt"]);
    runGit(work, ["commit", "-q", "-m", "test: production-only tree delta"]);

    conflictMainRef = "fixture-conflict-main";
    runGit(work, ["checkout", "-q", "-b", conflictMainRef, baseSha]);
    await fs.writeFile(path.join(work, "conflict.txt"), "main version\n");
    runGit(work, ["add", "conflict.txt"]);
    runGit(work, ["commit", "-q", "-m", "test: main conflict side"]);

    conflictProductionRef = "fixture-conflict-production";
    runGit(work, ["checkout", "-q", "-b", conflictProductionRef, baseSha]);
    await fs.writeFile(path.join(work, "conflict.txt"), "production version\n");
    runGit(work, ["add", "conflict.txt"]);
    runGit(work, ["commit", "-q", "-m", "test: production conflict side"]);
  }

  runGit(work, ["checkout", "-q", "main"]);

  return {
    lane,
    tmp,
    work,
    tag,
    productionSha,
    preReconciliationMainSha,
    reconciledMainSha,
    expectedMainBranch,
    reconciliationFirstParentCount,
    reconciliationFirstParentSha,
    reconciledParents,
    reconciliationTreeDelta,
    payloadPath,
    ownPath,
    pollutedThreeDotPaths,
    reconciledThreeDotPaths,
    treeMismatchRef,
    conflictMainRef,
    conflictProductionRef,
    ambiguousRef,
    ambiguousBranchSha,
    ambiguousTagSha,
  };
}

function runDetector(ctx, mode, productionRef, mainRef, { warnAmbiguousRefs = true } = {}) {
  return spawnSync(
    process.execPath,
    [detectScript, mode, "--production-ref", productionRef, "--main-ref", mainRef],
    {
      cwd: ctx.work,
      encoding: "utf8",
      env:
        warnAmbiguousRefs === false
          ? {
              ...process.env,
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "core.warnAmbiguousRefs",
              GIT_CONFIG_VALUE_0: "false",
            }
          : process.env,
    },
  );
}

describe("issue #1663 production ancestry prove-it graph", () => {
  const contexts = [];

  before(async () => {
    contexts.push(
      await createProductionAncestryFixture("rules"),
      await createProductionAncestryFixture("ordinary"),
    );
  });

  after(async () => {
    for (const ctx of contexts) {
      await fs.rm(ctx.tmp, { recursive: true, force: true });
      await assert.rejects(fs.access(ctx.tmp), { code: "ENOENT" });
    }
  });

  for (const lane of ["rules", "ordinary"]) {
    it(`${lane} fixture exposes divergence as exact-ref JSON with a non-zero exit`, () => {
      const ctx = contexts.find((candidate) => candidate.lane === lane);
      const result = runDetector(
        ctx,
        "--require-main-ancestor",
        ctx.tag,
        ctx.preReconciliationMainSha,
      );

      assert.notEqual(result.status, 0, "unreconciled production ancestry must fail closed");
      assert.doesNotMatch(result.stderr, /Unknown mode|Usage:/, "ancestry mode must be implemented");
      const output = JSON.parse(result.stdout);
      assert.equal(output.productionRef, ctx.tag);
      assert.equal(output.mainRef, ctx.preReconciliationMainSha);
      assert.equal(output.isMainAncestor, false);
    });

    it(`${lane} fixture classifies patch-equivalent divergence as graph-only`, () => {
      const ctx = contexts.find((candidate) => candidate.lane === lane);
      const result = runDetector(
        ctx,
        "--reconciliation-status",
        ctx.tag,
        ctx.preReconciliationMainSha,
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.productionRef, ctx.tag);
      assert.equal(output.mainRef, ctx.preReconciliationMainSha);
      assert.equal(output.classification, "graph-only");
      assert.equal(output.reconciliationRequired, true);
      assert.equal(output.recommendedRoute, "release-lane-back-merge");
    });

    it(`${lane} fixture restores ancestry through a zero-delta normal merge`, () => {
      const ctx = contexts.find((candidate) => candidate.lane === lane);
      assert.equal(
        ctx.reconciliationFirstParentCount,
        1,
        "reconciliation first-parent range must contain exactly one new commit",
      );
      assert.equal(
        ctx.reconciliationFirstParentSha,
        ctx.reconciledMainSha,
        "the only reconciliation first-parent commit must be the reconciliation merge",
      );
      assert.deepEqual(
        ctx.reconciledParents,
        [ctx.preReconciliationMainSha, ctx.productionSha],
        "reconciliation must preserve main and exact production tag as merge parents",
      );
      assert.deepEqual(ctx.reconciliationTreeDelta, [], "graph-only merge must preserve main tree");

      const result = runDetector(
        ctx,
        "--require-main-ancestor",
        ctx.tag,
        ctx.reconciledMainSha,
      );
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.isMainAncestor, true);
    });

    it(`${lane} fixture classifies already-ancestor status as no-op`, () => {
      const ctx = contexts.find((candidate) => candidate.lane === lane);
      const result = runDetector(
        ctx,
        "--reconciliation-status",
        ctx.tag,
        ctx.reconciledMainSha,
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.productionRef, ctx.tag);
      assert.equal(output.mainRef, ctx.reconciledMainSha);
      assert.equal(output.isMainAncestor, true);
      assert.equal(output.classification, "main-ancestor-confirmed");
      assert.notEqual(output.classification, "graph-only");
      assert.equal(output.reconciliationRequired, false);
      assert.equal(output.recommendedRoute, "no-op");
    });

    it(`${lane} fixture proves reconciliation removes three-dot payload pollution`, () => {
      const ctx = contexts.find((candidate) => candidate.lane === lane);
      assert.deepEqual(
        ctx.pollutedThreeDotPaths.sort(),
        [ctx.ownPath, ctx.payloadPath].sort(),
        "unreconciled lineage must expose the promoted payload as false own work",
      );
      assert.deepEqual(
        ctx.reconciledThreeDotPaths,
        [ctx.ownPath],
        "a branch from the exact tag must show only its own path after reconciliation",
      );
    });
  }

  it("classifies a conflict as content-review-required", () => {
    const ctx = contexts.find((candidate) => candidate.lane === "rules");
    const result = runDetector(
      ctx,
      "--reconciliation-status",
      ctx.conflictProductionRef,
      ctx.conflictMainRef,
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "content-review-required");
    assert.equal(output.reconciliationRequired, true);
    assert.equal(output.recommendedRoute, "production-ancestry-repair");
  });

  it("classifies a resulting-tree mismatch as content-review-required", () => {
    const ctx = contexts.find((candidate) => candidate.lane === "rules");
    const result = runDetector(
      ctx,
      "--reconciliation-status",
      ctx.treeMismatchRef,
      ctx.preReconciliationMainSha,
    );

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.classification, "content-review-required");
    assert.equal(output.reconciliationRequired, true);
    assert.equal(output.recommendedRoute, "production-ancestry-repair");
  });

  for (const mode of ["--require-main-ancestor", "--reconciliation-status"]) {
    for (const refPosition of ["production", "main"]) {
      it(`${mode} rejects an ambiguous short ${refPosition} ref when Git warnings are disabled`, () => {
        const ctx = contexts.find((candidate) => candidate.lane === "rules");
        const productionRef = refPosition === "production" ? ctx.ambiguousRef : ctx.tag;
        const mainRef =
          refPosition === "main" ? ctx.ambiguousRef : ctx.preReconciliationMainSha;
        const result = runDetector(ctx, mode, productionRef, mainRef, {
          warnAmbiguousRefs: false,
        });

        assert.notEqual(result.status, 0, `${mode} must fail closed independently of warnings`);
        const output = JSON.parse(result.stdout);
        assert.equal(output.classification, "invalid-ref");
        assert.equal(output.isMainAncestor, null);
      });
    }

    for (const refShape of ["fully-qualified refs", "raw OIDs"]) {
      it(`${mode} accepts ${refShape}`, () => {
        const ctx = contexts.find((candidate) => candidate.lane === "rules");
        const productionRef =
          refShape === "fully-qualified refs" ? `refs/tags/${ctx.tag}` : ctx.productionSha;
        const mainRef =
          refShape === "fully-qualified refs"
            ? `refs/heads/${ctx.expectedMainBranch}`
            : ctx.reconciledMainSha;
        const result = runDetector(ctx, mode, productionRef, mainRef, {
          warnAmbiguousRefs: false,
        });

        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        const output = JSON.parse(result.stdout);
        assert.equal(output.productionRef, productionRef);
        assert.equal(output.mainRef, mainRef);
        assert.equal(output.productionSha, ctx.productionSha);
        assert.equal(output.mainSha, ctx.reconciledMainSha);
      });
    }
  }

  for (const mode of ["--require-main-ancestor", "--reconciliation-status"]) {
    for (const refCase of ["invalid", "unresolved", "ambiguous"]) {
      for (const refPosition of ["production", "main"]) {
        it(`${mode} fails closed for an ${refCase} exact ${refPosition} ref`, async () => {
          const ctx = contexts.find((candidate) => candidate.lane === "rules");
          const markerPath = path.join(
            ctx.tmp,
            `argv-safety-${mode.slice(2)}-${refCase}-${refPosition}`,
          );
          const rejectedRef = {
            invalid: `--invalid;touch\${IFS}${markerPath};#`,
            unresolved:
              refPosition === "production"
                ? "refs/tags/fixture-missing-production"
                : "refs/heads/fixture-missing-main",
            ambiguous: ctx.ambiguousRef,
          }[refCase];
          const productionRef = refPosition === "production" ? rejectedRef : ctx.tag;
          const mainRef =
            refPosition === "main" ? rejectedRef : ctx.preReconciliationMainSha;
          const result = runDetector(ctx, mode, productionRef, mainRef);

          assert.notEqual(
            result.status,
            0,
            `${mode} must reject ${refCase} exact ${refPosition} refs`,
          );
          await assert.rejects(
            fs.access(markerPath),
            { code: "ENOENT" },
            "exact refs must remain argv-safe and must not execute shell metacharacters",
          );
          assert.doesNotMatch(
            `${result.stdout}\n${result.stderr}`,
            /Unknown mode|Usage:|用法：/,
            `${mode} must recognize and reject ${refCase} ${refPosition} refs instead of falling into usage`,
          );
          assert.doesNotMatch(
            result.stdout,
            /graph-only/,
            `${mode} must not emit graph-only for ${refCase} ${refPosition} refs`,
          );
        });
      }
    }
  }

  it("records bounded fixture telemetry", (t) => {
    assert.equal(contexts.length, 2, "rules and ordinary must share the same fixture factory");
    assert.ok(ancestryGitProcessCount > 0, "fixture must invoke real Git processes");
    assert.ok(ancestryGitProcessCount <= 100, "fixture process count must remain bounded");
    t.diagnostic(`issue-1663 fixtures=2 git_processes=${ancestryGitProcessCount} cleanup=after-hook`);
  });
});

describe("issue #1663 universal tagged promotion completion topologies", () => {
  it("full-main promotion still needs an exact-tag normal merge into main", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-full-main-"));
    const work = path.join(tmp, "work");
    await fs.mkdir(work);

    try {
      runGit(work, ["init", "-q", "-b", "main"]);
      runGit(work, ["config", "user.email", "fixture@example.invalid"]);
      runGit(work, ["config", "user.name", "issue-1663-full-main"]);
      await fs.writeFile(path.join(work, "base.txt"), "base\n");
      runGit(work, ["add", "base.txt"]);
      runGit(work, ["commit", "-q", "-m", "test: full-main base"]);
      const baseSha = runGit(work, ["rev-parse", "HEAD"]);

      await fs.writeFile(path.join(work, "main.txt"), "full main\n");
      runGit(work, ["add", "main.txt"]);
      runGit(work, ["commit", "-q", "-m", "feat: selected full main"]);
      const selectedMainSha = runGit(work, ["rev-parse", "HEAD"]);

      runGit(work, ["checkout", "-q", "-b", "fixture-full-main-production", baseSha]);
      runGit(work, ["merge", "-q", "--no-ff", selectedMainSha, "-m", "release: full-main production"]);
      runGit(work, ["tag", "production-v10.0.0"]);
      const productionSha = runGit(work, ["rev-parse", "production-v10.0.0^{commit}"]);
      assert.equal(
        runGit(work, ["rev-parse", `${productionSha}^{tree}`]),
        runGit(work, ["rev-parse", `${selectedMainSha}^{tree}`]),
        "full-main promotion may preserve the selected main tree while creating a new merge commit",
      );

      const preGate = runDetector(
        { work },
        "--require-main-ancestor",
        "production-v10.0.0",
        selectedMainSha,
      );
      assert.notEqual(preGate.status, 0, "the promoted tag is not yet an ancestor of selected main");

      runGit(work, ["checkout", "-q", "main"]);
      runGit(work, ["merge", "-q", "--no-ff", "production-v10.0.0", "-m", "fix: reconcile full-main tag"]);
      const reconciledMainSha = runGit(work, ["rev-parse", "HEAD"]);
      assert.deepEqual(
        runGit(work, ["show", "-s", "--format=%P", reconciledMainSha]).split(" "),
        [selectedMainSha, productionSha],
        "the normal merge must preserve selected main and the exact production tag as real parents",
      );
      assert.equal(
        runGit(work, ["diff", "--name-only", selectedMainSha, reconciledMainSha]),
        "",
        "graph-only full-main reconciliation must have zero tree delta",
      );
      const postGate = runDetector(
        { work },
        "--require-main-ancestor",
        "production-v10.0.0",
        reconciledMainSha,
      );
      assert.equal(postGate.status, 0, `stderr: ${postGate.stderr}`);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("hotfix tag-forward prevents a stale-H PR from erasing production lineage", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-hotfix-tag-forward-"));
    const work = path.join(tmp, "work");
    await fs.mkdir(work);

    try {
      runGit(work, ["init", "-q", "-b", "main"]);
      runGit(work, ["config", "user.email", "fixture@example.invalid"]);
      runGit(work, ["config", "user.name", "issue-1663-hotfix"]);
      await fs.writeFile(path.join(work, "base.txt"), "base\n");
      runGit(work, ["add", "base.txt"]);
      runGit(work, ["commit", "-q", "-m", "test: hotfix base"]);
      const baseSha = runGit(work, ["rev-parse", "HEAD"]);

      await fs.writeFile(path.join(work, "main.txt"), "main ahead\n");
      runGit(work, ["add", "main.txt"]);
      runGit(work, ["commit", "-q", "-m", "feat: main ahead"]);
      const mainSha = runGit(work, ["rev-parse", "HEAD"]);

      runGit(work, ["checkout", "-q", "-b", "hotfix/fixture", baseSha]);
      await fs.writeFile(path.join(work, "hotfix.txt"), "fixed\n");
      runGit(work, ["add", "hotfix.txt"]);
      runGit(work, ["commit", "-q", "-m", "fix: production incident"]);
      const hotfixSha = runGit(work, ["rev-parse", "HEAD"]);

      runGit(work, ["checkout", "-q", "-b", "production", baseSha]);
      runGit(work, ["merge", "-q", "--no-ff", hotfixSha, "-m", "hotfix: merge production"]);
      runGit(work, ["tag", "production-v10.0.1"]);
      const productionSha = runGit(work, ["rev-parse", "production-v10.0.1^{commit}"]);

      runGit(work, ["checkout", "-q", "-b", "fixture-stale-main", mainSha]);
      runGit(work, ["merge", "-q", "--no-ff", hotfixSha, "-m", "hotfix: stale PR2"]);
      const staleMainSha = runGit(work, ["rev-parse", "HEAD"]);
      assert.equal(
        runGitStatus(work, ["merge-base", "--is-ancestor", productionSha, staleMainSha]).status,
        1,
        "merging stale H to main must not count as exact production-tag ancestry",
      );

      runGit(work, ["checkout", "-q", "hotfix/fixture"]);
      runGit(work, ["merge", "--ff-only", "production-v10.0.1"]);
      assert.equal(
        runGit(work, ["rev-parse", "HEAD"]),
        productionSha,
        "tag-forward must advance the same hotfix branch exactly to P",
      );
      assert.equal(
        runGit(work, ["diff", "--name-only", "production-v10.0.1", "HEAD"]),
        "",
        "ff-only tag-forward must create no tree delta",
      );

      runGit(work, ["checkout", "-q", "main"]);
      runGit(work, ["merge", "-q", "--no-ff", "hotfix/fixture", "-m", "hotfix: exact tag to main"]);
      const correctedMainSha = runGit(work, ["rev-parse", "HEAD"]);
      assert.deepEqual(
        runGit(work, ["show", "-s", "--format=%P", correctedMainSha]).split(" "),
        [mainSha, productionSha],
        "corrected PR2 must preserve the exact promoted tag as a real parent",
      );
      const postGate = runDetector(
        { work },
        "--require-main-ancestor",
        "production-v10.0.1",
        correctedMainSha,
      );
      assert.equal(postGate.status, 0, `stderr: ${postGate.stderr}`);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("detect-branch-base --anchor", () => {
  let ctx;

  before(async () => {
    ctx = await createRepoWithRemoteOnlyReleaseBranch();
  });

  after(async () => {
    if (ctx) await fs.rm(ctx.tmp, { recursive: true, force: true });
  });

  it("does not leak fatal stderr when only remote tracking release branch exists", () => {
    const result = spawnSync("node", [detectScript, "--anchor"], {
      cwd: ctx.work,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `exit code: ${result.status}\nstderr: ${result.stderr}`);
    assert.equal(
      result.stderr,
      "",
      `stderr should be empty but got: ${JSON.stringify(result.stderr)}`
    );

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.source, "release-branch-base");
    assert.equal(parsed.ref, "release/20260414");
    assert.doesNotMatch(parsed.ref, /['"]/);
    assert.ok(parsed.sha && /^[0-9a-f]{40}$/.test(parsed.sha), `sha should be 40 hex: ${parsed.sha}`);
    assert.equal(
      parsed.sha,
      git(ctx.work, "merge-base origin/release/20260414 main"),
      "release fallback sha must equal the actual release/main merge-base"
    );
  });
});

describe("detect-branch-base --anchor mainAheadCommits", () => {
  let ctx;
  before(async () => { ctx = await createRepoWithMainAhead(); });
  after(async () => { if (ctx) await fs.rm(ctx.tmp, { recursive: true, force: true }); });

  it("includes mainAheadCommits when main has content ahead of production tag", () => {
    const result = spawnSync("node", [detectScript, "--anchor"], {
      cwd: ctx.work, encoding: "utf8"
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.source, "production-tag");
    assert.ok(Array.isArray(json.mainAheadCommits), "mainAheadCommits must be array");
    assert.equal(json.mainAheadCommits.length, 2, "expected 2 commits ahead");
    for (const c of json.mainAheadCommits) {
      assert.match(c.sha, /^[0-9a-f]{40}$/, `sha must be 40 hex chars, got: ${JSON.stringify(c.sha)}`);
      assert.ok(c.subject, "commit must have subject");
    }
    assert.equal(json.mainRef, "main");
    assert.equal(json.isMainAncestor, true, "production tag should be an ancestor of aligned main");
  });

  it("returns empty mainAheadCommits when main equals production tag", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-aligned-"));
    const work = path.join(tmp, "work");
    await fs.mkdir(work);
    git(work, "init -q -b main");
    git(work, "config user.email t@e.x");
    git(work, "config user.name test");
    await fs.writeFile(path.join(work, "a.txt"), "v1\n");
    git(work, "add .");
    git(work, "commit -q -m 'v1'");
    git(work, "tag production-v0.1.0");

    const result = spawnSync("node", [detectScript, "--anchor"], {
      cwd: work, encoding: "utf8"
    });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.deepEqual(json.mainAheadCommits, [], "mainAheadCommits must be empty array");
    assert.equal(json.mainRef, "main");
    assert.equal(json.isMainAncestor, true, "production tag at main must be a main ancestor");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reports isMainAncestor false when production tag is not a main ancestor", async () => {
    const diverged = await createRepoWithDivergedProductionTag();
    try {
      const result = spawnSync("node", [detectScript, "--anchor"], {
        cwd: diverged.work, encoding: "utf8"
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.source, "production-tag");
      assert.equal(json.ref, "production-v0.2.0");
      assert.equal(json.mainRef, "main");
      assert.equal(json.isMainAncestor, false);
    } finally {
      await fs.rm(diverged.tmp, { recursive: true, force: true });
    }
  });

  it("returns empty mainAheadCommits when main is graph-ahead but content-equivalent to production", async () => {
    const graphOnly = await createRepoWithGraphOnlyMainAhead();
    try {
      const graphLog = git(graphOnly.work, "log production-v0.1.0..main --oneline");
      assert.match(graphLog, /Merge pull request #1/, "fixture must have graph-only main-ahead commit");
      assert.equal(git(graphOnly.work, "diff --name-only production-v0.1.0 main"), "");

      const result = spawnSync("node", [detectScript, "--anchor"], {
        cwd: graphOnly.work, encoding: "utf8"
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.source, "production-tag");
      assert.deepEqual(json.mainAheadCommits, [], "graph-only release-lane merges must not trigger dependency prompts");
    } finally {
      await fs.rm(graphOnly.tmp, { recursive: true, force: true });
    }
  });
});

describe("detect-branch-base --main-tip", () => {
  let ctx;
  before(async () => { ctx = await createRepoWithMainAhead(); });
  after(async () => { if (ctx) await fs.rm(ctx.tmp, { recursive: true, force: true }); });

  it("outputs commits with sha/subject/authorDate/filesTouched", () => {
    const result = spawnSync("node", [detectScript, "--main-tip"], {
      cwd: ctx.work, encoding: "utf8"
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const data = JSON.parse(result.stdout);
    assert.ok(Array.isArray(data.commits));
    assert.equal(data.commits.length, 2);
    assert.equal(data.totalCount, 2);
    assert.equal(data.truncated, false);
    for (const c of data.commits) {
      assert.match(c.sha, /^[0-9a-f]{40}$/, `sha must be 40 hex chars, got: ${JSON.stringify(c.sha)}`);
      assert.ok(c.subject, "must have subject");
      assert.ok(c.authorDate, "must have authorDate");
      assert.ok(Array.isArray(c.filesTouched), "must have filesTouched array");
    }
  });

  it("outputs empty array and exits 0 when main equals production tag", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-empty-"));
    const work = path.join(tmp, "work");
    await fs.mkdir(work);
    git(work, "init -q -b main");
    git(work, "config user.email t@e.x");
    git(work, "config user.name test");
    await fs.writeFile(path.join(work, "a.txt"), "v1\n");
    git(work, "add .");
    git(work, "commit -q -m 'v1'");
    git(work, "tag production-v0.1.0");

    const result = spawnSync("node", [detectScript, "--main-tip"], {
      cwd: work, encoding: "utf8"
    });
    assert.equal(result.status, 0);
    const data = JSON.parse(result.stdout);
    assert.deepEqual(data.commits, []);
    assert.equal(data.totalCount, 0);
    assert.equal(data.truncated, false);

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("outputs empty array when graph-ahead main has no content diff from production", async () => {
    const graphOnly = await createRepoWithGraphOnlyMainAhead();
    try {
      const result = spawnSync("node", [detectScript, "--main-tip"], {
        cwd: graphOnly.work, encoding: "utf8"
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const data = JSON.parse(result.stdout);
      assert.deepEqual(data.commits, []);
      assert.equal(data.totalCount, 0);
      assert.equal(data.truncated, false);
    } finally {
      await fs.rm(graphOnly.tmp, { recursive: true, force: true });
    }
  });
});

describe("detect-branch-base --main-tip --limit", () => {
  let ctx;
  before(async () => { ctx = await createRepoWithMainAhead(); });
  after(async () => { if (ctx) await fs.rm(ctx.tmp, { recursive: true, force: true }); });

  it("default limit is 50 and commits ≤ 50 are not truncated", () => {
    const result = spawnSync("node", [detectScript, "--main-tip"], {
      cwd: ctx.work, encoding: "utf8"
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const data = JSON.parse(result.stdout);
    assert.equal(data.limit, 50);
    assert.equal(data.truncated, false);
    assert.equal(data.commits.length, data.totalCount);
    assert.ok(Array.isArray(data.commits));
  });

  it("--limit 2 truncates and returns the most recent N commits", async () => {
    // ctx has 2 commits ahead. Need ≥3 for truncation. Build a fresh repo with 3.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-3ahead-"));
    const work = path.join(tmp, "work");
    await fs.mkdir(work);
    git(work, "init -q -b main");
    git(work, "config user.email t@e.x");
    git(work, "config user.name test");
    await fs.writeFile(path.join(work, "a.txt"), "v1\n");
    git(work, "add ."); git(work, "commit -q -m 'v1'");
    git(work, "tag production-v0.1.0");
    for (const i of [2, 3, 4]) {
      await fs.writeFile(path.join(work, `${i}.txt`), `v${i}\n`);
      git(work, "add ."); git(work, `commit -q -m 'feat: v${i}'`);
    }

    const result = spawnSync("node", [detectScript, "--main-tip", "--limit", "2"], {
      cwd: work, encoding: "utf8"
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const data = JSON.parse(result.stdout);
    assert.equal(data.limit, 2);
    assert.equal(data.totalCount, 3);
    assert.equal(data.truncated, true);
    assert.equal(data.commits.length, 2);
    // Most recent 2 means subjects of v3 and v4 (slice -2 of asc-ordered list)
    assert.equal(data.commits[0].subject, "feat: v3");
    assert.equal(data.commits[1].subject, "feat: v4");

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("rejects --limit 0 and non-positive values with exit 1", () => {
    for (const bad of ["0", "-1", "abc"]) {
      const result = spawnSync("node", [detectScript, "--main-tip", "--limit", bad], {
        cwd: ctx.work, encoding: "utf8"
      });
      assert.equal(result.status, 1, `--limit ${bad} should exit 1, got ${result.status}`);
      assert.ok(result.stderr.length > 0, `--limit ${bad} should emit stderr`);
    }
  });

  it("commits ≤ limit means truncated=false and commits.length === totalCount", () => {
    const result = spawnSync("node", [detectScript, "--main-tip", "--limit", "100"], {
      cwd: ctx.work, encoding: "utf8"
    });
    assert.equal(result.status, 0);
    const data = JSON.parse(result.stdout);
    assert.equal(data.limit, 100);
    assert.equal(data.truncated, false);
    assert.equal(data.commits.length, data.totalCount);
    assert.equal(data.commits.length, 2); // ctx has 2 commits ahead
  });
});

describe("detect-branch-base JSON output survives a pipe larger than the pipe buffer", () => {
  let ctx;
  before(async () => { ctx = await createRepoWithLargeMainAhead(); });
  after(async () => { if (ctx) await fs.rm(ctx.tmp, { recursive: true, force: true }); });

  // `process.exit()` right after `console.log` drops what a pipe has not accepted yet, so a reader
  // used to get the first 64 KiB (8 KiB through spawnSync) and JSON.parse failed.
  const readPiped = args =>
    spawnSync("node", [detectScript, ...args], { cwd: ctx.work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const readToFile = async args => {
    const out = path.join(ctx.tmp, `out-${args[0].replace(/[^a-z-]/g, "")}.json`);
    const fd = await fs.open(out, "w");
    try {
      const result = spawnSync("node", [detectScript, ...args], { cwd: ctx.work, stdio: ["ignore", fd.fd, "pipe"] });
      assert.equal(result.status, 0);
    } finally {
      await fd.close();
    }
    return fs.readFile(out, "utf8");
  };

  // The file run is the reference: it must exceed the pipe cut (so the fixture proves something) and
  // the piped run must carry every one of its bytes.
  const expectCompleteOverPipe = async (args, check) => {
    const fileText = await readToFile(args);
    assert.ok(Buffer.byteLength(fileText) > 65536, `${args[0]} fixture must exceed the 64 KiB pipe cut`);
    const piped = readPiped(args);
    assert.equal(piped.status, 0, `stderr: ${piped.stderr}`);
    assert.equal(Buffer.byteLength(piped.stdout), Buffer.byteLength(fileText), `${args[0]} lost bytes over the pipe`);
    assert.equal(piped.stdout, fileText);
    check(JSON.parse(piped.stdout));
  };

  it("--anchor prints complete, parseable JSON over a pipe past 64 KiB", async () => {
    await expectCompleteOverPipe(["--anchor"], json => {
      assert.equal(json.mainAheadCommits.length, ctx.commitCount);
    });
  });

  it("--main-tip --limit prints complete, parseable JSON over a pipe past 64 KiB", async () => {
    await expectCompleteOverPipe(["--main-tip", "--limit", "1000"], data => {
      assert.equal(data.totalCount, ctx.commitCount);
      assert.equal(data.commits.length, ctx.commitCount);
      assert.equal(data.truncated, false);
    });
  });

  it("--touch-divergence prints complete, parseable JSON over a pipe past 64 KiB", async () => {
    // 700 short names keep the command line about 23 KB (Windows allows 32767) and still print over 64 KiB.
    const files = Array.from({ length: 700 }, (_, i) => `${"d".repeat(24)}${String(i).padStart(4, "0")}.txt`);
    await expectCompleteOverPipe(["--touch-divergence", ...files], data => {
      assert.equal(data.files.length, files.length);
    });
  });

  it("a reader that closes the pipe early still gets the original exit code and no stack trace", async () => {
    // `| head` closes its end before everything is written. The pre-fix script exited 0 quietly; a stdout
    // 'error' (EPIPE) nobody listens for would turn that into an uncaught exception and exit 1.
    for (const args of [["--anchor"], ["--main-tip", "--limit", "1000"]]) {
      const child = spawn("node", [detectScript, ...args], { cwd: ctx.work, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdout.destroy();
      const code = await new Promise(resolve => child.on("close", resolve));
      assert.equal(code, 0, `${args[0]} exited ${code} after the reader closed; stderr: ${stderr}`);
      assert.doesNotMatch(stderr, /Unhandled 'error'|EPIPE/, `${args[0]} printed a stack trace`);
    }
  });

  it("keeps the exit code and stderr contract for a bad --limit and an unknown mode", () => {
    const badLimit = readPiped(["--main-tip", "--limit", "0"]);
    assert.equal(badLimit.status, 1);
    assert.ok(badLimit.stderr.length > 0);
    assert.equal(badLimit.stdout, "");
    const unknown = readPiped(["--no-such-mode"]);
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stdout, "");
  });
});

test("productionTags semver-aware sort: v6.9.0 + v6.10.0 + v6.11.0 → takes v6.11.0 last", () => {
  const tags = ["production-v6.9.0", "production-v6.10.0", "production-v6.11.0"];
  const sorted = sortProductionTags(tags);
  assert.equal(sorted[sorted.length - 1], "production-v6.11.0");
});

test("productionTags: production-20260520 (date-tag) is date-aware, sorts after older v-tag", () => {
  // After date-tag recognition fix (issue #783), production-YYYYMMDD has parsed date.
  // production-v6.10.0 has commit date 20260426 (real tag in this repo) or null (no-history env).
  // Either way, production-20260520 (date > 20260426) should sort last.
  const tags = ["production-v6.10.0", "production-20260520"];
  const sorted = sortProductionTags(tags);
  assert.equal(sorted[sorted.length - 1], "production-20260520");
});

// ── extractTagDate unit tests ──────────────────────────────────────────────

test("extractTagDate: production-20260509-rules → '20260509'", () => {
  assert.equal(extractTagDate("production-20260509-rules"), "20260509");
});

test("extractTagDate: production-20260101-rules → '20260101'", () => {
  assert.equal(extractTagDate("production-20260101-rules"), "20260101");
});

test("extractTagDate: production-20260509-rules-2 → '20260509' (same-day rules suffix)", () => {
  assert.equal(extractTagDate("production-20260509-rules-2"), "20260509");
});

test("extractTagDate: production-20260509-rules-x → null (non-numeric suffix)", () => {
  assert.equal(extractTagDate("production-20260509-rules-x"), null);
});

test("extractTagDate: production-foo → null", () => {
  assert.equal(extractTagDate("production-foo"), null);
});

test("extractTagDate: production-rules → null (no date)", () => {
  assert.equal(extractTagDate("production-rules"), null);
});

test("extractTagDate: production-20260520 → '20260520' (date-tag, no ordinal)", () => {
  assert.equal(extractTagDate("production-20260520"), "20260520");
});

test("extractTagDate: production-20260520-2 → '20260520' (date-tag with ordinal)", () => {
  assert.equal(extractTagDate("production-20260520-2"), "20260520");
});

test("extractTagDate: production-20260520-1 → null (rejected unsuffixed=1 form)", () => {
  // Mirror RULES_TAG_RE: -1 not allowed (unsuffixed means 1)
  assert.equal(extractTagDate("production-20260520-1"), null);
});

test("sortProductionTags: date-tag ordinal tiebreaker (production-20260520 < production-20260520-2)", () => {
  const tags = ["production-20260520-2", "production-20260520"];
  const sorted = sortProductionTags(tags);
  assert.equal(sorted[0], "production-20260520");
  assert.equal(sorted[1], "production-20260520-2");
});

test("sortProductionTags: issue #783 repro — newer date-tag wins over older rules-tag", () => {
  // Exact scenario from issue #783: `--anchor` should pick production-20260520-2,
  // not the rules tag (production-20260519-rules-2).
  const tags = [
    "production-20260520-2",
    "production-20260520",
    "production-20260519-rules-2",
    "production-20260519-rules",
  ];
  const sorted = sortProductionTags(tags);
  assert.equal(sorted[sorted.length - 1], "production-20260520-2", "newest should be production-20260520-2");
  assert.equal(sorted[0], "production-20260519-rules", "oldest should be production-20260519-rules");
});

test("sortProductionTags: same-date rules-tag sorts before date-tag (rules sync precedes prod cut)", () => {
  // Per release-sit-uat-pat-prod.md, rules sync typically lands before prod cut on the same day.
  const tags = ["production-20260520", "production-20260520-rules"];
  const sorted = sortProductionTags(tags);
  assert.equal(sorted[0], "production-20260520-rules");
  assert.equal(sorted[1], "production-20260520");
});

// ── sortProductionTags mixed-format tests ─────────────────────────────────

test("sortProductionTags: two rules tags → earlier date first, later last", () => {
  const tags = ["production-20260509-rules", "production-20260101-rules"];
  const sorted = sortProductionTags(tags);
  assert.equal(sorted[0], "production-20260101-rules");
  assert.equal(sorted[sorted.length - 1], "production-20260509-rules");
});

test("sortProductionTags: same-day rules suffixes sort numerically after unsuffixed tag", () => {
  const tags = [
    "production-20260509-rules-10",
    "production-20260509-rules",
    "production-20260509-rules-2",
  ];
  const sorted = sortProductionTags(tags);
  assert.deepEqual(sorted, [
    "production-20260509-rules",
    "production-20260509-rules-2",
    "production-20260509-rules-10",
  ]);
});

test("sortProductionTags: production-foo (no date) sorts before tags with date", () => {
  // Tags without extractable date sort to the beginning (before dated tags)
  const tags = ["production-20260509-rules", "production-foo"];
  const sorted = sortProductionTags(tags);
  assert.equal(sorted[0], "production-foo");
  assert.equal(sorted[sorted.length - 1], "production-20260509-rules");
});

test("sortProductionTags: multiple no-date tags use lexical sort among themselves", () => {
  const tags = ["production-zzz", "production-aaa", "production-20260509-rules"];
  const sorted = sortProductionTags(tags);
  // no-date tags: production-aaa < production-zzz lexically
  assert.equal(sorted[0], "production-aaa");
  assert.equal(sorted[1], "production-zzz");
  assert.equal(sorted[2], "production-20260509-rules");
});

test("sortProductionTags: mixed rules + v tags in a temp repo (integration via --anchor)", async () => {
  // Create a temporary repo so production-vX.Y.Z tags have real commits for git log.
  // We test the full --anchor path: older rules tag should yield the v tag as anchor
  // (v tag was created after the rules tag → v tag is the most recent anchor).
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-mixed-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  // commit 1 → tag production-20260101-rules (date encoded in name: 20260101)
  await fs.writeFile(path.join(work, "a.txt"), "v1\n");
  git(work, "add .");
  git(work, "commit -q -m 'rules-release'");
  git(work, "tag production-20260101-rules");

  // commit 2 → tag production-v1.0.0 (committer date = today, which is > 20260101)
  await fs.writeFile(path.join(work, "b.txt"), "v2\n");
  git(work, "add .");
  git(work, "commit -q -m 'semver-release'");
  git(work, "tag production-v1.0.0");

  // commit 3 (main ahead by 1 after production-v1.0.0)
  await fs.writeFile(path.join(work, "c.txt"), "v3\n");
  git(work, "add .");
  git(work, "commit -q -m 'feat: after-release'");

  // Run --anchor: should pick production-v1.0.0 as most recent (today > 20260101)
  const result = spawnSync("node", [detectScript, "--anchor"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `exit: ${result.status}\nstderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.source, "production-tag");
  assert.equal(json.ref, "production-v1.0.0",
    `expected production-v1.0.0 as anchor (most recent), got: ${json.ref}`);
  assert.equal(json.mainAheadCommits.length, 1,
    `expected 1 commit ahead of production-v1.0.0`);

  await fs.rm(tmp, { recursive: true, force: true });
});

// ── issue #1628: same-day plain-date vs -rules tag topology guard ─────────

test("sortProductionTags: issue #1628 — same-day plain-date sorts AFTER -rules (naming layer, coarse order only)", () => {
  // Records the CURRENT naming-layer behaviour: compareTags treats a same-day
  // plain date-tag as newer than the -rules tag (per the "rules sync precedes
  // prod cut" convention). This is a COARSE ordering assumption — it is correct
  // as a naming heuristic but says nothing about the real git topology. The
  // issue #1628 bug (plain tag actually an ANCESTOR of the -rules tag) is NOT
  // fixable in this pure-naming sort; the fix lives in resolveAnchor()'s
  // topology post-check. This test passes today and MUST keep passing after the
  // fix — it pins that the sort layer is intentionally left unchanged.
  const tags = ["production-20260710-rules", "production-20260710"];
  const sorted = sortProductionTags(tags);
  assert.equal(sorted[sorted.length - 1], "production-20260710",
    "naming layer places same-day plain date-tag last (coarse order; topology decides real latest)");
});

test("resolveAnchor via --anchor: issue #1628 topology guard — same-day plain tag is ANCESTOR of -rules tag → anchor MUST be the descendant -rules tip", async () => {
  // Real failure (devpro-tw/SinoPac.IbmMq 6.83.7 → 6.83.8 rules sync): a
  // backdated plain date-tag `production-20260710` points at an ANCESTOR commit
  // (baseline, no submodule), while `production-20260710-rules` points at the
  // real production tip (descendant). The naming sort places the plain tag last
  // (see the sort-layer test above), so resolveAnchor() currently mis-selects
  // the older ancestor as the latest anchor → downstream rules-lane release
  // bases on the wrong commit → production regression.
  //
  // Topology: commit A (tag production-20260710) → commit B (tag
  // production-20260710-rules, parent = A). A is a strict ancestor of B.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-topo-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  // commit A → plain date-tag (backdated baseline, the ANCESTOR)
  await fs.writeFile(path.join(work, "a.txt"), "baseline\n");
  git(work, "add .");
  git(work, "commit -q -m 'baseline'");
  git(work, "tag production-20260710");
  const shaA = git(work, "rev-list -n 1 production-20260710");

  // commit B (parent = A) → -rules tag (the real production tip, the DESCENDANT)
  await fs.writeFile(path.join(work, "b.txt"), "prod-tip\n");
  git(work, "add .");
  git(work, "commit -q -m 'prod-tip'");
  git(work, "tag production-20260710-rules");
  const shaB = git(work, "rev-list -n 1 production-20260710-rules");

  const result = spawnSync("node", [detectScript, "--anchor"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `exit: ${result.status}\nstderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.source, "production-tag");
  assert.equal(json.ref, "production-20260710-rules",
    `anchor MUST be the descendant -rules tip, not the ancestor plain tag; got: ${json.ref}`);
  assert.equal(json.sha, shaB,
    `anchor sha MUST be commit B (descendant tip ${shaB}), not ancestor A (${shaA}); got: ${json.sha}`);

  await fs.rm(tmp, { recursive: true, force: true });
});

test("--main-tip: issue #1628 topology guard — naming-latest plain tag is ANCESTOR of -rules tip → main-tip bases from the descendant tip, not the ancestor", async () => {
  // Same bug class as the --anchor topology guard above, but in the --main-tip
  // main-ahead listing: before this fix, the --main-tip block picked
  // `latest = tags[tags.length - 1]` (naming-latest only, no topology
  // post-check), so a backdated ancestor naming-latest tag would be used as the
  // base for `latest..main`, wrongly widening the reported commit set to
  // include commits that are actually BEFORE the real production tip.
  //
  // Topology: commit A (tag production-20260710) → commit B (tag
  // production-20260710-rules, parent = A, the real production tip) → commit M1
  // (main commit, parent = B, main's actual lead over the tip).
  // A is a strict ancestor of B; naming sort places the plain tag A last
  // (coarse same-day convention), so pre-fix `--main-tip` bases from A.
  //
  // Pre-fix:  latest = A  → `A..main` = {B, M1}  (includes B: WRONG, too wide)
  // Post-fix: latest = topologyLatestTag = B → `B..main` = {M1}  (correct)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-maintip-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  // commit A → plain date-tag (backdated baseline, the ANCESTOR)
  await fs.writeFile(path.join(work, "a.txt"), "baseline\n");
  git(work, "add .");
  git(work, "commit -q -m 'baseline'");
  git(work, "tag production-20260710");

  // commit B (parent = A) → -rules tag (the real production tip, the DESCENDANT)
  await fs.writeFile(path.join(work, "b.txt"), "prod-tip\n");
  git(work, "add .");
  git(work, "commit -q -m 'prod-tip'");
  git(work, "tag production-20260710-rules");
  const shaB = git(work, "rev-list -n 1 production-20260710-rules");

  // commit M1 (parent = B): main's real lead over the descendant tip
  await fs.writeFile(path.join(work, "m1.txt"), "main-ahead\n");
  git(work, "add .");
  git(work, "commit -q -m 'main-ahead'");
  const shaM1 = git(work, "rev-list -n 1 main");

  const result = spawnSync("node", [detectScript, "--main-tip"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `exit: ${result.status}\nstderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.totalCount, 1,
    `main-tip base MUST be the descendant tip B, so totalCount is exactly 1 (just M1); got: ${json.totalCount}`);
  assert.equal(json.commits.length, 1);
  assert.equal(json.commits[0].sha, shaM1,
    `the single main-tip commit MUST be M1 (${shaM1}); got: ${json.commits[0] && json.commits[0].sha}`);
  assert.ok(json.commits.every(c => c.sha !== shaB),
    `commit B (${shaB}, the descendant tip itself) MUST NOT appear in the --main-tip commit list; a backdated ancestor base would wrongly include it`);

  await fs.rm(tmp, { recursive: true, force: true });
});

test("resolveAnchor via --anchor: issue #1628 parallel fork — naming-latest ancestor of TWO incomparable descendants → fail closed to naming-order-last descendant", async () => {
  // Topology: commit A (tag production-20260710, the naming-latest plain
  // date-tag) forks into TWO children that are NOT ancestors of each other:
  //   A → B (tag production-20260710-rules)
  //   A → C (tag production-20260710-rules-2)
  // Both B and C are strict descendants of A, but neither descends past the
  // other (parallel fork). The guard MUST fail closed to the naming-order-last
  // descendant (deterministic, not random). Naming order is
  // [rules, rules-2, plain]; the descendants are {rules, rules-2}; the
  // naming-order-last descendant is production-20260710-rules-2.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-fork-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  // commit A → plain date-tag (naming-latest; the fork point)
  await fs.writeFile(path.join(work, "a.txt"), "base\n");
  git(work, "add .");
  git(work, "commit -q -m 'base'");
  git(work, "tag production-20260710");
  const shaA = git(work, "rev-list -n 1 production-20260710");

  // commit B (parent = A) → -rules
  await fs.writeFile(path.join(work, "b.txt"), "branch-b\n");
  git(work, "add .");
  git(work, "commit -q -m 'branch-b'");
  git(work, "tag production-20260710-rules");
  const shaB = git(work, "rev-list -n 1 production-20260710-rules");

  // commit C (parent = A too, sibling of B) → -rules-2
  git(work, `checkout -q ${shaA}`);
  await fs.writeFile(path.join(work, "c.txt"), "branch-c\n");
  git(work, "add .");
  git(work, "commit -q -m 'branch-c'");
  git(work, "tag production-20260710-rules-2");
  const shaC = git(work, "rev-list -n 1 production-20260710-rules-2");

  // Sanity: B and C are incomparable (neither is ancestor of the other)
  assert.notEqual(shaB, shaC);

  const result = spawnSync("node", [detectScript, "--anchor"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `exit: ${result.status}\nstderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.source, "production-tag");
  assert.equal(json.ref, "production-20260710-rules-2",
    `parallel fork MUST fail closed to naming-order-last descendant; got: ${json.ref}`);
  assert.equal(json.sha, shaC,
    `anchor sha MUST be the naming-order-last descendant C (${shaC}); got: ${json.sha}`);

  await fs.rm(tmp, { recursive: true, force: true });
});

test("resolveAnchor via --anchor: issue #1628 sibling leaf — naming-latest is NOT an ancestor of any candidate → no-op returns naming-latest", async () => {
  // Topology: a shared base R forks into two siblings that are NOT ancestors of
  // each other:
  //   R → A (tag production-20260710, the naming-latest plain date-tag)
  //   R → B (tag production-20260710-rules)
  // The naming-latest plain tag A is a sibling leaf, NOT an ancestor of B, so
  // the guard finds no descendant and MUST be a no-op returning the
  // naming-latest tag unchanged (per the spec: naming-latest with no candidate
  // descendant → no-op). This proves the guard only intervenes on a real
  // ancestor relationship, never on incomparable siblings.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-sibling-"));
  const work = path.join(tmp, "work");
  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  // shared base R
  await fs.writeFile(path.join(work, "r.txt"), "root\n");
  git(work, "add .");
  git(work, "commit -q -m 'root'");
  const shaR = git(work, "rev-list -n 1 HEAD");

  // commit A (parent = R) → plain date-tag (naming-latest, sibling leaf)
  await fs.writeFile(path.join(work, "a.txt"), "sib-a\n");
  git(work, "add .");
  git(work, "commit -q -m 'sib-a'");
  git(work, "tag production-20260710");
  const shaA = git(work, "rev-list -n 1 production-20260710");

  // commit B (parent = R too, sibling of A) → -rules
  git(work, `checkout -q ${shaR}`);
  await fs.writeFile(path.join(work, "b.txt"), "sib-b\n");
  git(work, "add .");
  git(work, "commit -q -m 'sib-b'");
  git(work, "tag production-20260710-rules");

  const result = spawnSync("node", [detectScript, "--anchor"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `exit: ${result.status}\nstderr: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  assert.equal(json.source, "production-tag");
  assert.equal(json.ref, "production-20260710",
    `sibling-leaf naming-latest MUST be a no-op (returns plain tag); got: ${json.ref}`);
  assert.equal(json.sha, shaA,
    `anchor sha MUST be the naming-latest plain tag A (${shaA}); got: ${json.sha}`);

  await fs.rm(tmp, { recursive: true, force: true });
});

// ── Strict SemVer ordering guard (Critical 1 regression guard) ───────────

test("sortProductionTags: pure semver v6.9.0 < v6.10.0 < v6.11.0 (strict ordering, regression guard for Critical 1)", () => {
  const tags = ["production-v6.10.0", "production-v6.9.0", "production-v6.11.0"];
  const sorted = sortProductionTags(tags);
  // Strict ordering: v6.9 < v6.10 < v6.11 (numeric, not lexical)
  assert.deepStrictEqual(sorted, [
    "production-v6.9.0",
    "production-v6.10.0",
    "production-v6.11.0",
  ]);
});

// ── detect-branch-base --touch-divergence ─────────────────────────────────

async function createRepoForTouchDivergence() {
  // Topology:
  //   anchor (production-v0.1.0 tag) → origin/main adds a change to divergent.txt
  //   clean.txt is not touched in origin/main after the tag
  //
  //   bare remote = origin; work clones from it so origin/main is resolvable
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-touchdiv-"));
  const bare = path.join(tmp, "remote.git");
  const work = path.join(tmp, "work");

  await fs.mkdir(work);
  git(work, "init -q -b main");
  git(work, "config user.email t@e.x");
  git(work, "config user.name test");

  // Initial commit — both files exist at anchor point
  await fs.writeFile(path.join(work, "divergent.txt"), "original line\n");
  await fs.writeFile(path.join(work, "clean.txt"), "unchanged line\n");
  git(work, "add .");
  git(work, "commit -q -m 'base'");
  git(work, "tag production-v0.1.0");

  // Push to bare remote
  execSync(`git init -q --bare "${bare}"`);
  git(work, `remote add origin "${bare}"`);
  git(work, "push -q origin main");
  git(work, "push -q origin --tags");

  // Add a commit on origin/main that modifies divergent.txt (simulates another unit landing)
  // We do this by pushing directly from work, then resetting work to the tag
  await fs.writeFile(path.join(work, "divergent.txt"), "changed line by other unit\n");
  git(work, "add .");
  git(work, "commit -q -m 'chore: other unit changes divergent.txt'");
  git(work, "push -q origin main");

  // Reset work back to the production tag (simulating our branch built from anchor)
  git(work, "reset -q --hard production-v0.1.0");
  // Fetch so origin/main remote-tracking ref reflects the new commit
  git(work, "fetch -q origin");

  return { tmp, work };
}

describe("detect-branch-base --touch-divergence", () => {
  let ctx;
  before(async () => { ctx = await createRepoForTouchDivergence(); });
  after(async () => { if (ctx) await fs.rm(ctx.tmp, { recursive: true, force: true }); });

  it("reports diverged file as clean:false with non-zero divergedLines", () => {
    const result = spawnSync("node", [detectScript, "--touch-divergence", "divergent.txt", "clean.txt"], {
      cwd: ctx.work, encoding: "utf8"
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    const data = JSON.parse(result.stdout);
    assert.ok(data.anchor, "result must have anchor metadata");
    assert.equal(data.mainRef, "origin/main", "result must record the compared mainRef");
    assert.ok(Array.isArray(data.files), "result.files must be an array");
    assert.equal(data.files.length, 2, "must report both files");

    const divergentResult = data.files.find(f => f.file === "divergent.txt");
    const cleanResult = data.files.find(f => f.file === "clean.txt");

    assert.ok(divergentResult, "divergent.txt must be in results");
    assert.ok(cleanResult, "clean.txt must be in results");

    assert.equal(divergentResult.clean, false, "divergent.txt must be clean:false");
    assert.ok(divergentResult.divergedLines > 0, `divergent.txt divergedLines must be > 0, got ${divergentResult.divergedLines}`);

    assert.equal(cleanResult.clean, true, "clean.txt must be clean:true");
    assert.equal(cleanResult.divergedLines, 0, "clean.txt must have 0 divergedLines");
  });

  it("exits 1 and emits usage when no file args provided", () => {
    const result = spawnSync("node", [detectScript, "--touch-divergence"], {
      cwd: ctx.work, encoding: "utf8"
    });
    assert.equal(result.status, 1, `expected exit 1 but got ${result.status}`);
    assert.ok(result.stderr.includes("--touch-divergence"), "usage must mention --touch-divergence");
  });

  it("does not shell-evaluate filenames containing metacharacters (no command injection)", async () => {
    // A file arg like `x;touch SIDE_EFFECT` must be treated as a literal filename
    // (spawnSync argv form, no shell), never executed.
    const probe = path.join(ctx.tmp, "INJECTION_SIDE_EFFECT");
    const result = spawnSync("node", [detectScript, "--touch-divergence", `x;touch ${probe}`], {
      cwd: ctx.work, encoding: "utf8"
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    let sideEffectExists = true;
    try { await fs.access(probe); } catch { sideEffectExists = false; }
    assert.equal(sideEffectExists, false, "metacharacter filename must not be shell-executed");
    const data = JSON.parse(result.stdout);
    assert.equal(data.files[0].file, `x;touch ${probe}`, "filename must pass through verbatim as a literal arg");
  });
});

describe("detect-branch-base --touch-divergence without origin/main", () => {
  it("refuses to report all-clean and exits 1 when origin/main is unresolvable", async () => {
    // A purely local repo with no origin remote: the gate must NOT silently
    // report every file clean (false-negative); it must error so the caller
    // knows it could not compare, not that the touch set is clean.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "detect-branch-noorigin-"));
    const work = path.join(tmp, "work");
    await fs.mkdir(work);
    git(work, "init -q -b main");
    git(work, "config user.email t@e.x");
    git(work, "config user.name test");
    await fs.writeFile(path.join(work, "a.txt"), "v1\n");
    git(work, "add ."); git(work, "commit -q -m 'v1'");
    git(work, "tag production-v0.1.0");

    const result = spawnSync("node", [detectScript, "--touch-divergence", "a.txt"], {
      cwd: work, encoding: "utf8"
    });
    assert.equal(result.status, 1, `expected exit 1 (cannot compare), got ${result.status}\nstdout: ${result.stdout}`);
    assert.ok(/origin\/main/.test(result.stderr), `stderr must explain origin/main is unresolvable: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "", "must not emit a clean JSON report when it cannot compare");

    await fs.rm(tmp, { recursive: true, force: true });
  });
});

test("sortProductionTags: same-day multi v tags preserve SemVer tuple ordering (Critical 1 regression guard)", () => {
  // Simulate this repo's history: 10 tags landed on 2026-04-26.
  // Lexical sort would put v6.9.0 last (since '9' > '8' but '6.9' > '6.10' lexically → wrong).
  const tags = [
    "production-v6.10.0", "production-v6.11.0", "production-v6.12.0",
    "production-v6.3.0",  "production-v6.4.0",  "production-v6.5.0",
    "production-v6.6.0",  "production-v6.7.0",  "production-v6.8.0",
    "production-v6.9.0",
  ];
  const sorted = sortProductionTags(tags);
  // LATEST must be v6.12.0 (not v6.9.0 as lexical sort would produce)
  assert.strictEqual(sorted[sorted.length - 1], "production-v6.12.0");
  assert.strictEqual(sorted[0], "production-v6.3.0");
});
