/**
 * R9 reconciliation (`run-second-reviewer-projection.mjs --reconcile-*`) is
 * operator-invoked only. This guard sweeps every tracked executable carrier
 * for the reconcile flags, so a new or changed file anywhere in the repo can
 * turn it red. It lives in its own small file, outside the sharded
 * run-second-reviewer-projection.test.mjs body, so `run-test-suite.mjs
 * --changed` can run it on every PR (REPO_SWEEP_INTEGRATION_TESTS).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
test("R9 reconciliation is unreachable from every automated carrier", () => {
  const tracked = spawnSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  // .json is load-bearing here, not padding: this repo registers its hooks as
  // command strings inside .claude/settings.json, .codex/hooks.json and
  // .cursor/hooks.json, so a JSON-only sweep is exactly how an automated
  // caller would appear. .md is deliberately excluded — rule leaves and
  // OpenSpec artifacts name the flag legitimately.
  const executableCarriers = tracked.stdout
    .split("\0")
    .filter((file) => /\.(mjs|cjs|js|ts|sh|bash|ya?ml|json)$/.test(file))
    .filter((file) => existsSync(path.join(REPO_ROOT, file)));
  assert.ok(executableCarriers.length > 100, "carrier sweep must actually see the repository");
  const mentions = executableCarriers.filter((file) => {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
    return ["reconcile-closed-transport", "reconcile-legacy-diagnostic-scan", "reconcile-credential-gate-terminal"].some(flag => source.includes(flag));
  });
  // A text-only guard reads rule leaves and names the flags only as expected
  // text. It may sit on this list because the checks below prove it cannot
  // reach the runner: no runner reference, no child process, no dynamic import.
  const textOnlyGuards = [
    ".devpro/scripts/tests/second-review-operator-recovery-grep.test.mjs",
  ];
  assert.deepEqual(
    mentions.sort(),
    [
      ".devpro/scripts/run-second-reviewer-projection.mjs",
      ".devpro/scripts/tests/run-second-reviewer-projection.test.mjs",
      ".devpro/scripts/tests/second-review-reconciliation-unreachable-sweep.test.mjs",
      ...textOnlyGuards,
    ].sort(),
    "reconciliation is operator-invoked: no hook, renderer, gate, workflow or scheduled carrier may reach it"
  );
  for (const file of textOnlyGuards) {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
    assert.doesNotMatch(source, /run-second-reviewer-projection/, `${file} must not import or name the runner`);
    assert.doesNotMatch(source, /child_process/, `${file} must not start a process`);
    assert.doesNotMatch(source, /\bimport\s*\(/, `${file} must not load modules dynamically`);
  }
});
