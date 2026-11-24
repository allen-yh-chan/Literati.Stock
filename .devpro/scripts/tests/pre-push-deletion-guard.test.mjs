/**
 * pre-push-deletion-guard.test.mjs
 *
 * Tests for .devpro/scripts/hooks-git/pre-push — git-native pre-push hook
 * that blocks accidental remote branch deletion.
 *
 * Test cases:
 *   1. local-sha all-zeros (deletion) → exit non-zero + stderr contains advisory
 *   2. Normal sha (non-deletion) → exit 0 + no advisory on stderr
 *   3. "(delete)" prefix line (as observed in git 2.50.1) → still detected as deletion
 *   4. Mixed lines (one deletion + one normal) → exit non-zero (deletion wins)
 *   5. Empty stdin → exit 0 (nothing to block)
 *   6. Advisory contains prune-merged-local --force-delete literal
 *   7. Advisory contains --no-verify bypass guidance
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { BASELINE_GATE_IDS } from "../hooks/lib/rigor-level.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";
import { resolveNativeExecutableOnPath } from "./lib/resolve-native-executable.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const PRE_PUSH = repoPath(".devpro/scripts/hooks-git/pre-push");
const PRE_PUSH_JS = repoPath(".devpro/scripts/hooks-git/pre-push.mjs");
const GITATTRIBUTES = repoPath(".gitattributes");

const ZERO_SHA = "0000000000000000000000000000000000000000";
const REAL_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const OTHER_SHA = "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3";
const REMOTE_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const PROTECTED_REFS = ["refs/heads/main", "refs/heads/production"];

function posixShellForWrapper() {
  if (process.platform !== "win32") return "sh";
  // git.exe is found under <root>\\cmd from cmd.exe and under <root>\\mingw64\\bin from inside Git Bash,
  // so walk up from it until a POSIX shell is found.
  const gitExe = resolveNativeExecutableOnPath("git");
  let gitRoot = path.dirname(gitExe);
  for (let depth = 0; depth < 4; depth += 1) {
    for (const candidate of [
      path.join(gitRoot, "bin", "bash.exe"),
      path.join(gitRoot, "usr", "bin", "bash.exe"),
      path.join(gitRoot, "usr", "bin", "sh.exe"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    gitRoot = path.dirname(gitRoot);
  }
  throw new Error(`Git for Windows POSIX shell not found above ${gitExe}`);
}

const POSIX_SHELL = posixShellForWrapper();

// HEAD push cases describe an ordinary checkout, even when this suite itself
// runs inside a local review worktree. Review cases pass their own explicit cwd.
const ORDINARY_PUSH_CWD = makeTempDir("pre-push-ordinary-");
const ordinaryInit = spawnSync("git", ["init", "-q", "-b", "feature/add-example"], { cwd: ORDINARY_PUSH_CWD, encoding: "utf8" });
assert.equal(ordinaryInit.status, 0, ordinaryInit.stderr);
after(() => rmSync(ORDINARY_PUSH_CWD, { recursive: true, force: true }));

/**
 * Runs the pre-push hook with the given stdin lines.
 * @param {string[]} lines
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runHook(lines, extraEnv = {}, options = {}) {
  const input = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  const env = { ...process.env };
  delete env.DEVPRO_PRUNE_REMOTE_DELETE;
  Object.assign(env, extraEnv);
  const result = spawnSync("node", [PRE_PUSH_JS], {
    cwd: options.cwd ?? ORDINARY_PUSH_CWD,
    input,
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function countOccurrences(text, literal) {
  return text.split(literal).length - 1;
}

test("local review refs cannot be published as source, destination or renamed source in a mixed push", () => {
  for (const lines of [
    [`refs/heads/review/pr41 ${REAL_SHA} refs/heads/review/pr41 ${ZERO_SHA}`],
    [`refs/heads/review/pr41 ${REAL_SHA} refs/heads/feature/add-example ${ZERO_SHA}`],
    [`refs/heads/feature/add-example ${REAL_SHA} refs/heads/review/pr41 ${ZERO_SHA}`],
    [`refs/heads/feature/add-example ${REAL_SHA} refs/heads/feature/add-example ${ZERO_SHA}`,
      `refs/heads/review/pr41 ${REAL_SHA} refs/heads/feature/add-renamed ${ZERO_SHA}`],
  ]) {
    const result = runHook(lines, { DEVPRO_AGENT_RULES_LEVEL: "off", DEVPRO_PRUNE_REMOTE_DELETE: "1" });
    assert.notEqual(result.status, 0, lines.join("\n"));
    assert.match(result.stderr, /local.review|僅本機/i);
  }
});

test("local review checkout cannot publish HEAD under an ordinary destination name", () => {
  const cwd = makeTempDir("local-review-push-");
  try {
    const init = spawnSync("git", ["init", "-q", "-b", "review/pr41"], { cwd, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const result = runHook([`HEAD ${REAL_SHA} refs/heads/feature/add-example ${ZERO_SHA}`], {}, { cwd });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local.review|僅本機/i);
    const ordinary = runHook([`refs/heads/feature/add-example ${REAL_SHA} refs/heads/feature/add-example ${ZERO_SHA}`], {}, { cwd });
    assert.equal(ordinary.status, 0, ordinary.stderr);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

function runWrapper(lines, extraEnv = {}, options = {}) {
  const input = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  const result = spawnSync(POSIX_SHELL, [PRE_PUSH], {
    cwd: options.cwd ?? ORDINARY_PUSH_CWD,
    input,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("OS-level hook entrypoint is a portable wrapper that delegates to pre-push.mjs", () => {
  const wrapper = readFileSync(PRE_PUSH, "utf8");
  const implementation = readFileSync(PRE_PUSH_JS, "utf8");

  assert.match(wrapper, /^#!\/bin\/sh\n/, "pre-push must be a POSIX sh wrapper");
  assert.match(wrapper, /pre-push\.mjs/, "wrapper must delegate to adjacent pre-push.mjs");
  assert.match(wrapper, /exec node /, "wrapper must exec node for the JS implementation");
  assert.equal(wrapper.includes("\r\n"), false, "wrapper must use LF line endings");
  assert.match(implementation, /git-native pre-push hook/, "pre-push.mjs must carry the guard implementation");
});

test("git hook entrypoints are pinned to LF by gitattributes", () => {
  const attributes = readFileSync(GITATTRIBUTES, "utf8");
  assert.match(
    attributes,
    /^\.devpro\/scripts\/hooks-git\/\*\s+text\s+eol=lf$/m,
    "hooks-git files must be pinned to LF so Git for Windows checkout cannot CRLF-break POSIX hook launchers",
  );
  assert.match(
    attributes,
    /^\.gitignore\s+text\s+eol=lf$/m,
    ".gitignore must be pinned to LF so managed-block byte checks remain stable on Git for Windows",
  );
  assert.match(
    attributes,
    /^\.gitattributes\s+text\s+eol=lf$/m,
    ".gitattributes must pin itself to LF so managed-block byte checks remain stable on Git for Windows",
  );
});

test("extensionless pre-push wrapper delegates stdin to pre-push.mjs deletion guard", () => {
  const r = runWrapper([
    `refs/heads/wrapper-delete ${ZERO_SHA} refs/heads/wrapper-delete ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0, "wrapper-delegated deletion should still block");
  assert.match(r.stderr, /remote branch deletion/i);
  assert.match(r.stderr, /wrapper-delete/);
});

test("extensionless pre-push wrapper resolves implementation relative to itself, not cwd", () => {
  const r = runWrapper(
    [`refs/heads/non-root-cwd ${ZERO_SHA} refs/heads/non-root-cwd ${REMOTE_SHA}`],
    {},
    { cwd: path.dirname(REPO_ROOT) },
  );
  assert.notEqual(r.status, 0, "wrapper must find adjacent pre-push.mjs even when cwd is not the repo root");
  assert.match(r.stderr, /remote branch deletion/i);
  assert.match(r.stderr, /non-root-cwd/);
});

test("all-zero local-sha → exit non-zero (deletion detected)", () => {
  const r = runHook([
    `refs/heads/my-branch ${ZERO_SHA} refs/heads/my-branch ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0, "should exit non-zero on deletion");
});

test("all-zero local-sha → stderr contains prune-merged-local advisory", () => {
  const r = runHook([
    `refs/heads/feature-x ${ZERO_SHA} refs/heads/feature-x ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(
    r.stderr,
    /prune-merged-local\.mjs/,
    "advisory should reference prune-merged-local.mjs"
  );
  assert.match(
    r.stderr,
    /--force-delete/,
    "advisory should reference --force-delete flag"
  );
});

test("all-zero local-sha → stderr contains --no-verify bypass", () => {
  const r = runHook([
    `refs/heads/feature-x ${ZERO_SHA} refs/heads/feature-x ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(
    r.stderr,
    /--no-verify/,
    "advisory should include --no-verify bypass guidance"
  );
});

test("normal (non-zero) sha → exit 0 (pass through)", () => {
  const r = runHook([
    `HEAD ${REAL_SHA} refs/heads/feature-y ${ZERO_SHA}`,
  ]);
  assert.equal(r.status, 0, "normal push should pass");
});

test("normal sha → no advisory on stderr", () => {
  const r = runHook([
    `HEAD ${REAL_SHA} refs/heads/feature-y ${ZERO_SHA}`,
  ]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr.trim(), "", "no stderr for normal push");
});

test("(delete) prefix line (git 2.50.1 format) → detected as deletion", () => {
  // git 2.50.1 sends: (delete) 000...0 refs/heads/<name> <remote-sha>
  const r = runHook([
    `(delete) ${ZERO_SHA} refs/heads/chore/old-branch ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0, "should detect deletion even with (delete) prefix");
  assert.match(r.stderr, /prune-merged-local\.mjs/);
  assert.match(r.stderr, /--force-delete/);
});

test("mixed lines: one deletion + one normal → exit non-zero", () => {
  const r = runHook([
    `HEAD ${REAL_SHA} refs/heads/keep-this ${ZERO_SHA}`,
    `refs/heads/delete-this ${ZERO_SHA} refs/heads/delete-this ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0, "deletion in batch should block entire push");
  assert.match(r.stderr, /prune-merged-local\.mjs/);
});

test("empty stdin → exit 0 (nothing to push or block)", () => {
  const r = runHook([]);
  assert.equal(r.status, 0, "empty stdin should pass silently");
  assert.equal(r.stderr.trim(), "", "no advisory for empty stdin");
});

test("advisory names the branch being deleted", () => {
  const r = runHook([
    `refs/heads/chore/cleanup ${ZERO_SHA} refs/heads/chore/cleanup ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(
    r.stderr,
    /chore\/cleanup/,
    "advisory should name the branch being deleted"
  );
});

test("advisory recommends the explicit --include-remote cleanup path", () => {
  const r = runHook([
    `refs/heads/feature/my-feat ${ZERO_SHA} refs/heads/feature/my-feat ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(
    r.stderr,
    /prune-merged-local\.mjs --include-remote --exec/,
    "advisory should recommend --include-remote --exec as the compliant remote-deletion path"
  );
  assert.match(
    r.stderr,
    /verifies each remote branch is merged into\s+production before deleting the remote ref/,
    "advisory should describe what --include-remote --exec actually does"
  );
});

test("advisory names unshipped-mainline compliant remote path and demotes --no-verify", () => {
  const r = runHook([
    `refs/heads/feature/my-feat ${ZERO_SHA} refs/heads/feature/my-feat ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(
    r.stderr,
    /--include-unshipped-mainline --include-remote --exec/,
    "advisory must name the compliant unshipped-mainline remote cleanup path",
  );
  assert.match(
    r.stderr,
    /Intentional bypass/i,
    "--no-verify must remain labelled intentional bypass, not official production-lag workflow",
  );
  assert.doesNotMatch(
    r.stderr,
    /official.*(production-lag|pre-first-release)|production-lag.*official|--no-verify.*official/i,
    "--no-verify must not be presented as the official production-lag / pre-first-release path",
  );
});

test("advisory names the per-branch remote deletion honestly (lease, batch refusal, local-only without --include-remote)", () => {
  const r = runHook([
    `refs/heads/feature/my-feat ${ZERO_SHA} refs/heads/feature/my-feat ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(
    r.stderr,
    /--force-delete feature\/my-feat --include-remote/,
    "advisory should show the named per-branch command for the deleted ref"
  );
  assert.match(
    r.stderr,
    /under an OID lease; it refuses branches already merged into main or shipped/,
    "advisory must say the named path refuses batch-owned branches instead of skipping merge checks"
  );
  assert.match(r.stderr, /Without --include-remote it is local-only/);
});

test("advisory offers no deletion command for protected or release branches", () => {
  const r = runHook([
    `refs/heads/main ${ZERO_SHA} refs/heads/main ${REMOTE_SHA}`,
    `refs/heads/release/v1.2.3 ${ZERO_SHA} refs/heads/release/v1.2.3 ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /--force-delete (main|release\/)/);
  assert.match(r.stderr, /main: protected branch; there is no deletion path/);
  assert.match(r.stderr, /release\/v1\.2\.3: .*intentionally retained/);
});

// ─── Canonical prune-script controlled bypass (issue #947 finding 1) ───
// The canonical remote cleanup path `prune-merged-local.mjs --include-remote --exec`
// runs `git push origin --delete` in its Phase 3 for branches it has verified as
// merged-into-production — that push would otherwise be blocked by this very hook.
// The script sets a SPECIFIC env marker on that remote-delete invocation; the hook
// honors it and passes the deletion through. A RAW `git push origin --delete` (no
// marker) still blocks — the marker is NOT a wildcard bypass. (`--force-delete <b>
// --include-remote` sets the same marker for one named non-release branch; plain
// `--force-delete` stays local-only and never reaches a remote deletion.)

test("DEVPRO_PRUNE_REMOTE_DELETE=1 → deletion passes (canonical prune controlled path)", () => {
  const r = runHook(
    [`refs/heads/feature/done ${ZERO_SHA} refs/heads/feature/done ${REMOTE_SHA}`],
    { DEVPRO_PRUNE_REMOTE_DELETE: "1" }
  );
  assert.equal(r.status, 0, `controlled prune delete must pass; got status=${r.status}, stderr=${r.stderr}`);
});

test("DEVPRO_PRUNE_REMOTE_DELETE=1 → (delete) prefix form also passes", () => {
  const r = runHook(
    [`(delete) ${ZERO_SHA} refs/heads/chore/old ${REMOTE_SHA}`],
    { DEVPRO_PRUNE_REMOTE_DELETE: "1" }
  );
  assert.equal(r.status, 0, `controlled prune delete (delete-prefix) must pass; got status=${r.status}`);
});

test("raw deletion WITHOUT the marker still blocks (marker is not a wildcard bypass)", () => {
  const r = runHook([
    `refs/heads/feature/raw ${ZERO_SHA} refs/heads/feature/raw ${REMOTE_SHA}`,
  ]);
  assert.notEqual(r.status, 0, "raw remote delete (no marker) must still hard-block");
  assert.match(r.stderr, /prune-merged-local\.mjs/);
});

test("marker only affects deletions — a normal push with the marker still passes (no behavior change)", () => {
  const r = runHook(
    [`HEAD ${REAL_SHA} refs/heads/feature/normal ${ZERO_SHA}`],
    { DEVPRO_PRUNE_REMOTE_DELETE: "1" }
  );
  assert.equal(r.status, 0, "normal push always passes regardless of marker");
});

test("marker must be exactly '1' — other values do NOT bypass (no loose truthiness bypass)", () => {
  for (const val of ["0", "", "true", "yes"]) {
    const r = runHook(
      [`refs/heads/feature/x ${ZERO_SHA} refs/heads/feature/x ${REMOTE_SHA}`],
      { DEVPRO_PRUNE_REMOTE_DELETE: val }
    );
    assert.notEqual(r.status, 0, `marker value "${val}" must NOT bypass (only exactly "1")`);
  }
});

// ─── Fixed protected non-deletion policy (issue #2756) ───────────────────

test("Fixed Protected Remote Refs Are PR-Only Everywhere", async (t) => {
  for (const remoteRef of PROTECTED_REFS) {
    await t.test(remoteRef, () => {
      const r = runHook([`HEAD ${REAL_SHA} ${remoteRef} ${REMOTE_SHA}`]);
      assert.equal(r.status, 1, `${remoteRef} must be PR-only; stderr=${r.stderr}`);
      assert.match(r.stderr, /pre-push: protected branch update requires PR/);
      assert.match(r.stderr, new RegExp(`  - ${remoteRef.replaceAll("/", "\\/")}`));
    });
  }
});

test("Protected Creation Fast-Forward And Force Updates Are Rejected", async (t) => {
  const cases = [
    {
      name: "main creation",
      line: `refs/heads/main ${REAL_SHA} refs/heads/main ${ZERO_SHA}`,
    },
    {
      name: "production creation",
      line: `refs/heads/production ${REAL_SHA} refs/heads/production ${ZERO_SHA}`,
    },
    {
      name: "main fast-forward shape",
      line: `refs/heads/main ${OTHER_SHA} refs/heads/main ${REAL_SHA}`,
    },
    {
      name: "production fast-forward shape",
      line: `refs/heads/production ${OTHER_SHA} refs/heads/production ${REAL_SHA}`,
    },
    {
      name: "main non-fast-forward or force shape",
      line: `refs/heads/main ${REAL_SHA} refs/heads/main ${OTHER_SHA}`,
    },
    {
      name: "production non-fast-forward or force shape",
      line: `refs/heads/production ${REAL_SHA} refs/heads/production ${OTHER_SHA}`,
    },
  ];

  for (const { name, line } of cases) {
    await t.test(name, () => {
      const r = runHook([line]);
      assert.equal(r.status, 1, `protected ${name} must reject; stderr=${r.stderr}`);
      assert.match(r.stderr, /pre-push: protected branch update requires PR/);
    });
  }
});

test("Unprotected Branch And Tag Updates Remain Allowed", async (t) => {
  const allowedRefs = [
    "refs/heads/feature/example",
    "refs/heads/bugfix/example",
    "refs/heads/chore/example",
    "refs/heads/release/example",
    "refs/heads/main-backup",
    "refs/heads/production/archive",
    "refs/tags/v1.2.3",
  ];
  // refs/tags/production-* is checked against the remote production branch;
  // see pre-push-production-tag-ancestry.test.mjs.

  for (const remoteRef of allowedRefs) {
    await t.test(remoteRef, () => {
      const r = runHook([`refs/heads/source ${REAL_SHA} ${remoteRef} ${REMOTE_SHA}`]);
      assert.equal(r.status, 0, `${remoteRef} should remain allowed; stderr=${r.stderr}`);
      assert.equal(r.stderr, "");
    });
  }
});

test("Protected Deletion Retains The Existing Deletion Contract", async (t) => {
  for (const remoteRef of PROTECTED_REFS) {
    await t.test(`${remoteRef} blocks without marker through deletion advisory`, () => {
      const r = runHook([`${remoteRef} ${ZERO_SHA} ${remoteRef} ${REMOTE_SHA}`]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /remote branch deletion detected/);
      assert.doesNotMatch(r.stderr, /protected branch update requires PR/);
    });

    await t.test(`${remoteRef} passes only with exact deletion marker`, () => {
      const exact = runHook(
        [`${remoteRef} ${ZERO_SHA} ${remoteRef} ${REMOTE_SHA}`],
        { DEVPRO_PRUNE_REMOTE_DELETE: "1" },
      );
      assert.equal(exact.status, 0, `exact marker must preserve protected deletion path: ${exact.stderr}`);

      const nonExact = runHook(
        [`${remoteRef} ${ZERO_SHA} ${remoteRef} ${REMOTE_SHA}`],
        { DEVPRO_PRUNE_REMOTE_DELETE: "true" },
      );
      assert.equal(nonExact.status, 1, "non-exact marker must not authorize deletion");
      assert.match(nonExact.stderr, /remote branch deletion detected/);
    });
  }
});

test("Deletion Marker Remains Deletion-Only", async (t) => {
  for (const remoteRef of PROTECTED_REFS) {
    await t.test(remoteRef, () => {
      const r = runHook(
        [`refs/heads/release/candidate ${REAL_SHA} ${remoteRef} ${REMOTE_SHA}`],
        { DEVPRO_PRUNE_REMOTE_DELETE: "1" },
      );
      assert.equal(r.status, 1, `marker must not bypass ${remoteRef}; stderr=${r.stderr}`);
      assert.match(r.stderr, /protected branch update requires PR/);
    });
  }
});

test("Protected Update Has No Local Or Business Bypass", async (t) => {
  const cases = [
    {
      name: "alternate local release ref cannot update main",
      line: `refs/heads/release/candidate ${REAL_SHA} refs/heads/main ${REMOTE_SHA}`,
      env: {},
    },
    {
      name: "alternate local work ref cannot update production",
      line: `refs/heads/feature/candidate ${OTHER_SHA} refs/heads/production ${REAL_SHA}`,
      env: {},
    },
    {
      name: "deletion marker cannot authorize a main update",
      line: `refs/heads/release/candidate ${REAL_SHA} refs/heads/main ${REMOTE_SHA}`,
      env: { DEVPRO_PRUNE_REMOTE_DELETE: "1" },
    },
    {
      name: "deletion marker cannot authorize a production update",
      line: `refs/heads/release/candidate ${OTHER_SHA} refs/heads/production ${REAL_SHA}`,
      env: { DEVPRO_PRUNE_REMOTE_DELETE: "1" },
    },
  ];

  for (const { name, line, env } of cases) {
    await t.test(name, () => {
      const r = runHook([line], env);
      assert.equal(r.status, 1, `${name} must reject; stderr=${r.stderr}`);
      assert.match(r.stderr, /protected branch update requires PR/);
    });
  }
});

test("One Protected Update Rejects The Entire Push Batch", async (t) => {
  const lines = [
    `refs/heads/feature/delete-me ${ZERO_SHA} refs/heads/feature/delete-me ${REMOTE_SHA}`,
    `refs/heads/feature/keep ${REAL_SHA} refs/heads/feature/keep ${REMOTE_SHA}`,
    `refs/tags/v1.2.3 ${REAL_SHA} refs/tags/v1.2.3 ${ZERO_SHA}`,
    `refs/heads/release/candidate ${REAL_SHA} refs/heads/production ${REMOTE_SHA}`,
  ];

  for (const marker of [undefined, "1"]) {
    await t.test(marker === "1" ? "exact deletion marker" : "marker unset", () => {
      const env = marker === undefined ? {} : { DEVPRO_PRUNE_REMOTE_DELETE: marker };
      const r = runHook(lines, env);
      assert.equal(r.status, 1, `mixed protected batch must reject; stderr=${r.stderr}`);
      assert.match(r.stderr, /protected branch update requires PR/);
      assert.doesNotMatch(r.stderr, /remote branch deletion detected/);
    });
  }
});

test("Protected Rejection Names Targets And The PR Recovery Path", () => {
  const r = runHook([
    `refs/heads/release/one ${REAL_SHA} refs/heads/production ${REMOTE_SHA}`,
    `refs/heads/release/two ${OTHER_SHA} refs/heads/main ${REMOTE_SHA}`,
    `refs/heads/release/three ${REAL_SHA} refs/heads/production ${OTHER_SHA}`,
    `refs/heads/release/four ${OTHER_SHA} refs/heads/main ${REAL_SHA}`,
  ]);

  assert.equal(r.status, 1, `protected batch must reject; stderr=${r.stderr}`);
  assert.equal(countOccurrences(r.stderr, "  - refs/heads/main"), 1);
  assert.equal(countOccurrences(r.stderr, "  - refs/heads/production"), 1);
  assert.ok(
    r.stderr.indexOf("  - refs/heads/main") < r.stderr.indexOf("  - refs/heads/production"),
    `protected targets must render in policy order: ${r.stderr}`,
  );
  assert.match(
    r.stderr,
    /Required path: push the work\/release branch, then open a PR to the protected target\./,
  );
});

test("Local Hook Boundary Is Disclosed Without A Sanctioned Bypass", () => {
  const r = runHook([
    `refs/heads/release/candidate ${REAL_SHA} refs/heads/main ${REMOTE_SHA}`,
  ]);

  assert.equal(r.status, 1, `protected update must reject; stderr=${r.stderr}`);
  assert.match(r.stderr, /this local hook is not remote protection/i);
  assert.match(r.stderr, /missing installation or git push --no-verify can skip it/i);
  assert.match(r.stderr, /not an approved release bypass/i);
});

test("Fixed Protected Policy Has No Consumer Configuration", () => {
  const source = readFileSync(PRE_PUSH_JS, "utf8");
  assert.match(
    source,
    /const PROTECTED_REMOTE_REFS = \["refs\/heads\/main", "refs\/heads\/production"\];/,
    "the protected policy must remain exactly the fixed ordered main/production pair",
  );
  assert.doesNotMatch(
    source,
    /protected_branches|rules\.config|\b(?:readFileSync|existsSync|statSync|accessSync)\b/i,
    "the hook must not discover protected refs from consumer configuration or filesystem lookup",
  );
});

test("malformed records remain ignored while later valid protected records are still classified", async (t) => {
  await t.test("malformed-only input passes silently", () => {
    const r = runHook(["malformed", "refs/heads/main only-three-fields nope"]);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
  });

  await t.test("malformed prefix does not prevent full-batch protected rejection", () => {
    const r = runHook([
      "malformed",
      `refs/heads/source ${REAL_SHA} refs/heads/production ${REMOTE_SHA}`,
    ]);
    assert.equal(r.status, 1, `later protected record must reject; stderr=${r.stderr}`);
    assert.match(r.stderr, /protected branch update requires PR/);
  });
});

test("ai-autonomy entry-anchor paragraph credits this git-native hook, not pre-tool-gate.mjs, for direct pushes to protected branches", () => {
  // amend-push-block-attribution R1, R3: the paragraph once said direct
  // pushes to protected branches are blocked by `pre-tool-gate.mjs`, which has no
  // push destination gate. The destination check lives in this hook, so the SSOT
  // sentence must name it and list every ref it enforces (a subset check: it does not
  // stop the sentence from also naming refs the hook does not enforce).
  const doc = readFileSync(repoPath(".devpro/agent-rules/ai-autonomy.md"), "utf8");
  const paragraph = doc
    .split("\n")
    .find((line) => line.includes("入口錨點取捨準則（AGENTS.md 只列子集的依據）"));
  assert.ok(paragraph, "the entry-anchor trade-off paragraph must exist in ai-autonomy.md");

  assert.ok(
    paragraph.includes("hooks-git/pre-push.mjs"),
    "the paragraph must name the git-native hook that blocks direct pushes to protected refs",
  );

  const declared = readFileSync(PRE_PUSH_JS, "utf8").match(
    /const PROTECTED_REMOTE_REFS = \[([^\]]*)\];/,
  );
  assert.ok(declared, "PROTECTED_REMOTE_REFS declaration must be readable from the hook source");
  const branches = [...declared[1].matchAll(/"refs\/heads\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(branches.length > 0, "the hook must declare at least one protected branch");
  for (const branch of branches) {
    assert.ok(
      paragraph.includes(`\`${branch}\``),
      `the paragraph must list the protected branch \`${branch}\` that the hook enforces`,
    );
  }

  assert.doesNotMatch(
    paragraph,
    STALE_ENTRY_ANCHOR_MARKER,
    "the paragraph must not attribute direct-push blocking to pre-tool-gate.mjs",
  );
  // Polarity-sensitive claims are bound to the wording that carries the direction
  // (who blocks, and that it is only a local first line), not to bare tokens.
  assert.match(
    paragraph,
    /直推 `main`／`production` 由 git 原生 `[^`]*hooks-git\/pre-push\.mjs` 攔，僅本機第一道，`--no-verify` 或未安裝即可跳過/,
    "the paragraph must say the git-native hook blocks direct pushes to main/production as a local first line that --no-verify or a missing install skips",
  );
  assert.match(
    paragraph,
    /`--no-verify` 本身在 `pre-tool-gate\.mjs` 只有 `git commit` 的軟提醒，無機械攔截/,
    "the paragraph must say --no-verify has only a git commit reminder in pre-tool-gate.mjs and no mechanical block",
  );
});

// amend-push-block-attribution R2, R3: two more carriers repeated the
// attribution that ai-autonomy.md carried. They credited the `protected-branch-write`
// baseline gate with blocking direct pushes, but that gate only matches local write
// verbs; the push destination check lives in this git-native hook. The literals below
// are the historical wording, kept as resident fixtures so a marker that drifts too
// narrow (stale text slips through) or too wide (correct text is rejected) turns red.
const SPEC_PATH = repoPath("openspec/specs/cross-runtime-parity/spec.md");
const RIGOR_LEAF = repoPath(".devpro/agent-rules/rules-rigor-level.md");
const PRE_TOOL_GATE = repoPath(".devpro/scripts/hooks/pre-tool-gate.mjs");
const BASELINE_REQUIREMENT = "Safety-Baseline Hooks Fire At Every Rigor Level";

// Grep-shaped proxy for "this hook reads the rigor level": the resolver module or its
// name, the env flag, the consumer config key or file, or dispatch through run-hook.mjs
// (which applies the rigor no-op policy). It cannot prove absence in general, so the
// fixtures below keep both polarities resident and the check covers the extensionless
// wrapper git actually executes as well as the JavaScript implementation.
const RIGOR_READ_MARKER = /rigor|AGENT_RULES_LEVEL|agent_rules_level|rules\.config|run-hook/i;
const RIGOR_READ_FIXTURES = [
  'import { resolveRigorLevel } from "../hooks/lib/rigor-level.mjs";',
  "process.env.DEVPRO_AGENT_RULES_LEVEL",
  "agent_rules_level=lite",
  'readFileSync(".devpro/rules.config", "utf8")',
  'exec node "$SCRIPT_DIR/../hooks/run-hook.mjs" pre-push "$@"',
];
const RIGOR_FREE_FIXTURE = 'exec node "$SCRIPT_DIR/pre-push.mjs" "$@"';

const STALE_SPEC_LINES = [
  "The system SHALL guarantee that exactly four baseline protections fire at every rigor level including `off`, on every supported runtime: (1) protected-branch-write (no direct push to `main` / protected branches), (2) Gate P PII-in-querystring blocking",
  "- **THEN** a direct push to `main` or another protected branch MUST be blocked by the protected-branch-write baseline gate",
];
const STALE_SPEC_MARKERS = [
  /\(1\) protected-branch-write \(no direct push to/,
  /a direct push to `main` or another protected branch MUST be blocked by the protected-branch-write/,
];
const CORRECT_SPEC_LINE =
  "- **THEN** a direct git write (for example `git commit`) on `main` or another protected branch MUST be blocked by the protected-branch-write baseline gate";

const STALE_RIGOR_ROW =
  "| 禁直推 main / protected branch | `protected-branch-write`、`protected-branch-uncertain-cwd`、`protected-branch-file-write` |";
const STALE_RIGOR_ROW_MARKER =
  /^\| 禁直推 main \/ protected branch \| `protected-branch-write`、`protected-branch-uncertain-cwd`、`protected-branch-file-write` \|$/;
const CORRECT_RIGOR_ROW =
  "| 禁直推 main / protected branch | `protected-branch-write`、`protected-branch-uncertain-cwd`、`protected-branch-file-write`（只擋保護分支上的本地寫入，不擋 push 目的地；直推見下方註） |";

// The historical bypass wording drops the PreToolUse scope, which is false for a direct
// push: the git-native pre-push hook still blocks it under DEVPRO_HOOK_BYPASS. The marker
// keeps both polarities resident: it must hit the historical sentence and pass the two
// scoped sentences the leaf carries today.
const UNSCOPED_BYPASS_MARKER = /連底線都跳/;

// Same residency rule for the two other forbidden-side markers below: the historical
// entry-anchor attribution, and the direct-read forms of DEVPRO_HOOK_BYPASS in the git
// hook files (the env name, or the lib/hook-bypass.mjs module). A grep proxy cannot prove
// absence in general: a read routed through some other module is invisible to it.
const STALE_ENTRY_ANCHOR_MARKER = /直推 protected branch[^—]*—\s*由 `pre-tool-gate\.mjs` 攔/;
const STALE_ENTRY_ANCHOR =
  "已被 hook mechanical 強制者（如直推 protected branch、`--no-verify`、squash/rebase merge — 由 `pre-tool-gate.mjs` 攔）仍列入口當可讀提醒";
const CORRECT_ENTRY_ANCHOR =
  "已被機械強制者仍列入口當可讀提醒（直推 `main`／`production` 由 git 原生 `.devpro/scripts/hooks-git/pre-push.mjs` 攔，僅本機第一道，`--no-verify` 或未安裝即可跳過；squash／rebase merge 的限制見上方該條；`--no-verify` 本身在 `pre-tool-gate.mjs` 只有 `git commit` 的軟提醒，無機械攔截）";
const HOOK_BYPASS_READ_MARKER = /hook.?bypass/i;
const HOOK_BYPASS_READ_FIXTURES = [
  "process.env.DEVPRO_HOOK_BYPASS",
  'import { hasInlineHookBypass } from "../hooks/lib/hook-bypass.mjs";',
];
const HOOK_BYPASS_FREE_FIXTURES = [RIGOR_FREE_FIXTURE, "const prune = process.env.DEVPRO_PRUNE_REMOTE_DELETE;"];
const STALE_BYPASS_LINES = [
  "| 「off 跟 BYPASS 一樣都是關 hook」 | off 仍 fire 底線；bypass 連底線都跳。兩者語意正交，勿混用 |",
  "兩旗標正交：`off` 仍 fire 4 條底線檢查；`DEVPRO_HOOK_BYPASS=1`（per-command，`lib/hook-bypass.mjs`）連底線都跳。off = 會話級流程降級，bypass = 單次命令全 gate 豁免。",
];
const CORRECT_BYPASS_LINES = [
  "| 「off 跟 BYPASS 一樣都是關 hook」 | off 仍 fire 底線；bypass 連 PreToolUse 底線 gate 都跳（git 原生 pre-push hook 不讀它）。兩者語意正交，勿混用 |",
  "兩旗標正交：`off` 仍 fire 4 條底線檢查；`DEVPRO_HOOK_BYPASS=1`（per-command，`lib/hook-bypass.mjs`）連 PreToolUse 的底線 gate 都跳（git 原生 pre-push hook 不讀它；能跳過 pre-push 的是 `git push --no-verify`）。",
];

// The section is bounded by the next sibling heading and must resolve to exactly one
// heading, so a duplicated or renamed requirement cannot hand the assertions the wrong text.
function requirementSection(specText, title) {
  const heading = `### Requirement: ${title}`;
  const lines = specText.split("\n");
  const starts = lines.flatMap((line, index) => (line === heading ? [index] : []));
  assert.equal(starts.length, 1, `expected exactly one "${heading}" heading, found ${starts.length}`);
  const rest = lines.slice(starts[0] + 1);
  const next = rest.findIndex((line) => line.startsWith("### Requirement:"));
  return (next === -1 ? rest : rest.slice(0, next)).join("\n");
}

test("stale-attribution markers match the historical wording and reject the corrected wording", () => {
  for (const line of STALE_SPEC_LINES) {
    assert.ok(
      STALE_SPEC_MARKERS.some((marker) => marker.test(line)),
      `a stale spec marker must still match the historical line: ${line.slice(0, 80)}`,
    );
  }
  assert.ok(
    !STALE_SPEC_MARKERS.some((marker) => marker.test(CORRECT_SPEC_LINE)),
    "the stale spec markers must not reject the corrected THEN line",
  );
  assert.match(STALE_RIGOR_ROW, STALE_RIGOR_ROW_MARKER);
  assert.doesNotMatch(CORRECT_RIGOR_ROW, STALE_RIGOR_ROW_MARKER);
  for (const line of STALE_BYPASS_LINES) {
    assert.match(line, UNSCOPED_BYPASS_MARKER, `the unscoped-bypass marker must still match a historical sentence: ${line.slice(0, 40)}`);
  }
  for (const line of CORRECT_BYPASS_LINES) {
    assert.doesNotMatch(line, UNSCOPED_BYPASS_MARKER, `the unscoped-bypass marker must not reject a scoped sentence: ${line.slice(0, 60)}`);
  }
  assert.match(STALE_ENTRY_ANCHOR, STALE_ENTRY_ANCHOR_MARKER, "the entry-anchor marker must still match the historical sentence");
  assert.doesNotMatch(CORRECT_ENTRY_ANCHOR, STALE_ENTRY_ANCHOR_MARKER, "the entry-anchor marker must not reject the corrected sentence");
  for (const line of HOOK_BYPASS_READ_FIXTURES) {
    assert.match(line, HOOK_BYPASS_READ_MARKER, `the hook-bypass marker must still match: ${line}`);
  }
  for (const line of HOOK_BYPASS_FREE_FIXTURES) {
    assert.doesNotMatch(line, HOOK_BYPASS_READ_MARKER, `the hook-bypass marker must not reject a hook line that ignores the flag: ${line}`);
  }
});

test("cross-runtime-parity baseline requirement credits the pre-push hook, not protected-branch-write, for direct pushes", () => {
  const section = requirementSection(readFileSync(SPEC_PATH, "utf8"), BASELINE_REQUIREMENT);
  for (const marker of STALE_SPEC_MARKERS) {
    assert.doesNotMatch(section, marker, `stale push attribution must be gone: ${marker}`);
  }
  assert.ok(
    section.includes(CORRECT_SPEC_LINE),
    "the off-level scenario must describe the baseline gate blocking a direct git write",
  );
  // Polarity-sensitive claims are bound to one physical line each.
  assert.match(
    section,
    /^[^\n]*`pre-tool-gate\.mjs` has no push-destination check[^\n]*hooks-git\/pre-push\.mjs[^\n]*never reads the rigor level[^\n]*`git push --no-verify`[^\n]*skips it[^\n]*$/m,
    "the requirement must say the pre-push hook blocks direct pushes, ignores the rigor level, and is skipped by --no-verify",
  );
  assert.match(
    section,
    /^[^\n]*not a fifth baseline[^\n]*`DEVPRO_HOOK_BYPASS`[^\n]*does not describe it[^\n]*$/m,
    "the requirement must keep the hook-bypass exclusivity clause scoped to the four baseline gates",
  );
});

test("rules-rigor-level mapping credits local writes to the protected-branch gates and direct pushes to the pre-push hook", () => {
  const leaf = readFileSync(RIGOR_LEAF, "utf8");
  const lines = leaf.split("\n");
  assert.ok(
    !lines.some((line) => STALE_RIGOR_ROW_MARKER.test(line)),
    "the mapping row must not credit the protected-branch gates with the direct-push promise alone",
  );
  const rows = lines.filter((line) => line.startsWith("| 禁直推 main / protected branch |"));
  assert.equal(rows.length, 1, `expected exactly one direct-push mapping row, found ${rows.length}`);
  assert.match(
    rows[0],
    /`protected-branch-write`[^\n]*`protected-branch-file-write`[^\n]*不擋 push 目的地/,
    "the mapping row must say the protected-branch gates do not inspect push destinations",
  );
  assert.match(
    leaf,
    /^[^\n]*hooks-git\/pre-push\.mjs[^\n]*不讀 rigor level[^\n]*`git push --no-verify`[^\n]*跳過[^\n]*$/m,
    "the leaf must name the pre-push hook, say it ignores the rigor level, and say --no-verify skips it",
  );
});

test("the corrected attribution matches the implementation", () => {
  const gate = readFileSync(PRE_TOOL_GATE, "utf8");
  const declared = gate.match(/const GIT_PROTECTED_WRITE_RE = new RegExp\(\s*`[^`]*\$\{GIT_WITH_C\}\(([^)]*)\)/);
  assert.ok(declared, "GIT_PROTECTED_WRITE_RE verb list must be readable from pre-tool-gate.mjs");
  const verbs = declared[1].split("|");
  assert.ok(verbs.includes("commit"), `the protected-write verb list must include commit: ${verbs}`);
  assert.ok(
    !verbs.includes("push"),
    "the protected-branch-write gate must not match push, or the docs must credit it again",
  );
  // rules-rigor-level.md says master / integration / release/* pushes have no mechanical
  // block because the hook only names main and production; widening the hook makes that stale.
  const refs = readFileSync(PRE_PUSH_JS, "utf8").match(/const PROTECTED_REMOTE_REFS = \[([^\]]*)\];/);
  assert.ok(refs, "PROTECTED_REMOTE_REFS declaration must be readable from the hook source");
  assert.deepEqual(
    [...refs[1].matchAll(/"refs\/heads\/([^"]+)"/g)].map((m) => m[1]),
    ["main", "production"],
    "the hook protects exactly main and production, or rules-rigor-level.md's note on other protected branches is stale",
  );
  for (const hookFile of [PRE_PUSH_JS, PRE_PUSH]) {
    assert.doesNotMatch(
      readFileSync(hookFile, "utf8"),
      RIGOR_READ_MARKER,
      `${path.basename(hookFile)} must not read the rigor level, or the docs claim that it never does is stale`,
    );
  }
});

test("the rigor-read marker matches every known way to read the rigor level and passes the hook's own dispatch line", () => {
  for (const line of RIGOR_READ_FIXTURES) {
    assert.match(line, RIGOR_READ_MARKER, `the marker must still match: ${line}`);
  }
  assert.doesNotMatch(
    RIGOR_FREE_FIXTURE,
    RIGOR_READ_MARKER,
    "the marker must not reject the wrapper's plain dispatch line",
  );
});

// amend-push-block-attribution R1, R2, R3: the carriers above also disclose gaps that
// this hook does not cover. These tests bind each disclosed gap to its carrier text
// (RED before the wording lands) and to the implementation fact it rests on, so a
// carrier that overclaims, or a later fix that leaves the wording stale, turns red.
test("ai-autonomy §Never squash/rebase line discloses that Gate 2c only matches the long flags and skips at off", () => {
  const line = readFileSync(repoPath(".devpro/agent-rules/ai-autonomy.md"), "utf8")
    .split("\n")
    .find((row) => row.startsWith("- 禁 Squash merge 或 Rebase merge"));
  assert.ok(line, "the §Never squash/rebase line must exist in ai-autonomy.md");
  assert.match(line, /`gh pr merge -s`／`-r` 擋不到/, "the line must say the short flags slip through");
  assert.match(line, /`off` 時不跑/, "the line must say the merge-strategy gate does not run at off");
});

test("rules-rigor-level leaf says direct push is not a gate-level baseline and scopes DEVPRO_HOOK_BYPASS to PreToolUse hooks", () => {
  const lines = readFileSync(RIGOR_LEAF, "utf8").split("\n");
  const note = lines.find((row) => row.includes("hooks-git/pre-push.mjs"));
  assert.ok(note, "the leaf must carry a note that names the pre-push hook");
  assert.match(note, /不是第五個 gate 層級的底線/, "the note must say direct push is not a fifth gate-level baseline");
  assert.match(note, /也不讀 `DEVPRO_HOOK_BYPASS`/, "the note must say the pre-push hook does not read DEVPRO_HOOK_BYPASS");
  const bypass = lines.find((row) => row.includes("`DEVPRO_HOOK_BYPASS=1`（per-command"));
  assert.ok(bypass, "the off-vs-bypass sentence must exist");
  assert.match(bypass, /git 原生 pre-push hook 不讀它/, "the bypass sentence must say the pre-push hook is outside its reach");
  // No copy of the bypass claim may drop the PreToolUse scope: the unscoped wording
  // ("bypass skips the baselines") is false for a direct push, which pre-push still blocks.
  const unscoped = lines.filter((row) => UNSCOPED_BYPASS_MARKER.test(row));
  assert.deepEqual(unscoped, [], "no line may say DEVPRO_HOOK_BYPASS skips the baselines without the PreToolUse scope");
});

test("the disclosed gaps match the implementation: merge-strategy is not a baseline gate and the git hooks ignore DEVPRO_HOOK_BYPASS", () => {
  assert.ok(
    !BASELINE_GATE_IDS.includes("merge-strategy"),
    "merge-strategy must stay outside BASELINE_GATE_IDS, or ai-autonomy.md's 「`off` 時不跑」 is stale",
  );
  for (const hookFile of [PRE_PUSH_JS, PRE_PUSH]) {
    assert.doesNotMatch(
      readFileSync(hookFile, "utf8"),
      HOOK_BYPASS_READ_MARKER,
      `${path.basename(hookFile)} must not read DEVPRO_HOOK_BYPASS, or the docs claim that it never does is stale`,
    );
  }
});
