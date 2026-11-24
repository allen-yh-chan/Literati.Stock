import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isCwdAvailable } from "../hooks/lib/cwd-availability.mjs";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const HELPER_URL = pathToFileURL(
  path.join(REPO_ROOT, ".devpro/scripts/hooks/lib/cwd-availability.mjs"),
).href;

function runChild(code) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
  });
}

test("isCwdAvailable reports true in a live directory (run-hook preflight probe helper)", () => {
  assert.equal(isCwdAvailable(), true);
});

test("isCwdAvailable reports false once the process cwd is deleted", {
  // win32 cannot remove an in-use cwd (RemoveDirectory fails while the process
  // stays inside it), so this probe is POSIX-only by construction (F-hrr-f1-05).
  skip: process.platform === "win32"
    ? "win32 cannot delete a process cwd (RemoveDirectory fails on in-use cwd)"
    : false,
}, () => {
  const code = [
    'import { mkdtempSync, rmdirSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import path from "node:path";',
    `import { isCwdAvailable } from ${JSON.stringify(HELPER_URL)};`,
    'const dir = mkdtempSync(path.join(tmpdir(), "devpro-cwd-deleted-"));',
    "process.chdir(dir);",
    "rmdirSync(dir);",
    "console.log(isCwdAvailable());",
  ].join("\n");
  const result = runChild(code);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "false");
});

test("run-hook preflight names a deleted session cwd and every host profile fails open identically (cross-model F5; fix-codex-reviewer-intent-candidate-cap D17)", {
  skip: process.platform === "win32"
    ? "win32 cannot delete a process cwd (RemoveDirectory fails on in-use cwd)"
    : false,
}, () => {
  const script = repoPath(".devpro/scripts/hooks/run-hook.mjs");
  const buildCode = (host) => [
    'const { mkdtempSync, rmdirSync } = require("node:fs");',
    'const { tmpdir } = require("node:os");',
    'const path = require("node:path");',
    'const dir = mkdtempSync(path.join(tmpdir(), "devpro-run-hook-cwd-"));',
    "process.chdir(dir);",
    "rmdirSync(dir);",
    `process.argv = [process.argv[0], ${JSON.stringify(script)}, "PreToolUse", "pre-tool-gate.mjs", "--host=${host}"];`,
    `import(${JSON.stringify(pathToFileURL(script).href)});`,
  ].join("\n");
  const opencode = spawnSync(process.execPath, ["-e", buildCode("opencode")], { encoding: "utf8" });
  assert.equal(opencode.status, 0, opencode.stderr);
  assert.match(opencode.stderr, /session working directory missing/);
  assert.match(opencode.stderr, /session_move/);
  assert.match(opencode.stderr, /; fail-open\n$/);
  assert.doesNotMatch(opencode.stderr, /fail-closed/);
  const other = spawnSync(process.execPath, ["-e", buildCode("claude")], { encoding: "utf8" });
  assert.equal(other.status, 0, other.stderr);
  assert.equal(opencode.stderr, other.stderr, "stderr is byte-identical across host profiles");
  assert.equal(opencode.stdout, other.stdout, "stdout is byte-identical across host profiles");
});

test("run-hook uses the shared probe and names the recovery in its diagnostic", () => {
  const source = readFileSync(repoPath(".devpro/scripts/hooks/run-hook.mjs"), "utf8");
  assert.match(source, /import \{ isCwdAvailable \} from "\.\/lib\/cwd-availability\.mjs"/);
  assert.match(source, /session working directory missing/);
  assert.match(source, /session_move/);
  assert.doesNotMatch(source, /hookHost === "opencode"/, "no host-specific polarity branch may remain");
  assert.match(source, /session working directory missing[^\n]*fail-open/);
});
