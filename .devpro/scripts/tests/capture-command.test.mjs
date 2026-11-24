import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const captureScript = repoPath(".devpro/scripts/capture-command.mjs");

function parseLogPath(stdout) {
  const match = stdout.match(/\blog=([^\n]+)$/m);
  assert.ok(match, `summary missing log path:\n${stdout}`);
  return match[1];
}

function cleanupLog(logPath) {
  rmSync(path.dirname(logPath), { recursive: true, force: true });
}

test("capture-command writes stdout+stderr to notes/tmp and prints compact summary", () => {
  const result = spawnSync(
    process.execPath,
    [
      captureScript,
      "--topic",
      "unit-capture",
      "--",
      process.execPath,
      "-e",
      "console.log('stdout-ok'); console.error('stderr-ok')",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /command=/);
  assert.match(result.stdout, /rc=0/);
  assert.match(result.stdout, /lines=2/);
  assert.match(result.stdout, /bytes=\d+/);
  // The summary prints the OS-native log path, so accept either separator.
  assert.match(result.stdout, /notes[\\/]tmp[\\/]unit-capture\.[^\\/]+[\\/]command\.log/);
  assert.equal(result.stderr, "");

  const logPath = parseLogPath(result.stdout);
  const log = readFileSync(logPath, "utf8");
  assert.match(log, /stdout-ok/);
  assert.match(log, /stderr-ok/);
  cleanupLog(logPath);
});

test("capture-command preserves child nonzero exit code and still reports log", () => {
  const result = spawnSync(
    process.execPath,
    [
      captureScript,
      "--topic",
      "unit-capture-fail",
      "--",
      process.execPath,
      "-e",
      "console.error('boom'); process.exit(7)",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  assert.equal(result.status, 7);
  assert.match(result.stdout, /rc=7/);
  assert.match(result.stdout, /lines=1/);

  const logPath = parseLogPath(result.stdout);
  assert.match(readFileSync(logPath, "utf8"), /boom/);
  cleanupLog(logPath);
});
