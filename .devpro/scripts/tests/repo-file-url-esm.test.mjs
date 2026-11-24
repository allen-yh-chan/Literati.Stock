/**
 * Prove-it + fix: dynamic ESM import must use file:// (Windows drive-letter scheme).
 * fix-windows-consumer-parity D4 / T3+T8.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoFileUrl, repoPath } from "./lib/repo-root.mjs";

test("repoFileUrl returns a file:// href under the repo root", () => {
  const href = repoFileUrl(".devpro/scripts/tests/lib/repo-root.mjs");
  assert.match(href, /^file:/);
  assert.equal(href, pathToFileURL(repoPath(".devpro/scripts/tests/lib/repo-root.mjs")).href);
});

test("raw Windows-style abs path is an unsupported ESM URL scheme", () => {
  const probe = `
try {
  await import(${JSON.stringify("C:\\\\Users\\\\x\\\\mod.mjs")});
  process.stdout.write("imported");
} catch (error) {
  process.stdout.write(String(error?.code || error?.message || error));
}
`;
  const result = spawnSync("node", ["--input-type=module"], {
    input: probe,
    encoding: "utf8",
  });
  assert.match(
    result.stdout,
    /ERR_UNSUPPORTED_ESM_URL_SCHEME/,
    `expected scheme failure, got: ${result.stdout} / ${result.stderr}`
  );
});

test("repoFileUrl href imports successfully in a child process", () => {
  const href = repoFileUrl(".devpro/scripts/tests/lib/repo-root.mjs");
  const probe = `
import { repoPath } from ${JSON.stringify(href)};
process.stdout.write(repoPath("."));
`;
  const result = spawnSync("node", ["--input-type=module"], {
    input: probe,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(path.resolve(result.stdout), path.resolve(REPO_ROOT));
});

test("listed dynamic-import tests no longer stringify raw abs module paths into from", () => {
  const listed = [
    "rules-rigor-level.test.mjs",
    "recap-utils.test.mjs",
    "recap-utils-check-discussion.test.mjs",
    "clarification-contract.test.mjs",
    "codex-reviewer-admission.test.mjs",
    "git-utils.test.mjs",
    "half-state-override-claim.test.mjs",
    "hook-pre-tool-gate-meeting-notes-pii.test.mjs",
    "hook-session-friction-log.test.mjs",
    "suite-live-state-isolation.test.mjs",
  ];
  const offenders = [];
  for (const name of listed) {
    const text = readFileSync(repoPath(`.devpro/scripts/tests/${name}`), "utf8");
    // Ban: from ${JSON.stringify(<abs-looking path expression>)}; allow .href / pathToFileURL / repoFileUrl / URL
    const re = /from \$\{JSON\.stringify\(([^)]+)\)\}/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const arg = match[1].trim();
      const ok =
        /pathToFileURL|repoFileUrl|\.href|FileUrl|URL\(|new URL/.test(arg)
        || /_URL|_HREF|LIB_URL|ADMISSION_RECORD_URL|realPiiUrl|RECAP_UTILS|RECAP_UTILS_PATH|RIGOR_LIB|frictionLogMjs|moduleUrl|href/.test(arg);
      // Constants that are assigned from path.resolve/repoPath without .href are offenders —
      // those listed consts were converted to .href in this change; verify assignment.
      if (!ok) offenders.push(`${name}: ${arg}`);
    }
  }
  // Absolute dynamic paths require file URLs; a relative import is already portable.
  const rigor = readFileSync(repoPath(".devpro/scripts/tests/rules-rigor-level.test.mjs"), "utf8");
  assert.match(rigor, /const RIGOR_LIB = repoFileUrl\(/);
  const recap = readFileSync(repoPath(".devpro/scripts/tests/recap-utils.test.mjs"), "utf8");
  assert.match(recap, /await import\("\.\.\/hooks\/lib\/recap-utils\.mjs"\)/);
  const friction = readFileSync(repoPath(".devpro/scripts/tests/hook-session-friction-log.test.mjs"), "utf8");
  assert.match(friction, /pathToFileURL\(path\.join\(HOOKS_DIR/);
  // Value-layer asserts for #2644 verify-only Touch files (href / pathToFileURL / new URL().href)
  const clarification = readFileSync(repoPath(".devpro/scripts/tests/clarification-contract.test.mjs"), "utf8");
  assert.match(clarification, /const realPiiUrl = new URL\([^)]+\)\.href/);
  const admission = readFileSync(repoPath(".devpro/scripts/tests/codex-reviewer-admission.test.mjs"), "utf8");
  assert.match(admission, /const ADMISSION_RECORD_URL = new URL\([^)]+\)\.href/);
  const halfState = readFileSync(repoPath(".devpro/scripts/tests/half-state-override-claim.test.mjs"), "utf8");
  assert.match(halfState, /const LIB_URL = pathToFileURL\(.+\)\.href/);
  const meetingPii = readFileSync(repoPath(".devpro/scripts/tests/hook-pre-tool-gate-meeting-notes-pii.test.mjs"), "utf8");
  assert.match(meetingPii, /const realPiiUrl = new URL\(.+\)\.href/);
  assert.match(meetingPii, /HOOK_SOURCE_URL\.href/);
  assert.deepEqual(offenders, [], `raw abs from-stringify leftovers: ${offenders.join("; ")}`);
});
