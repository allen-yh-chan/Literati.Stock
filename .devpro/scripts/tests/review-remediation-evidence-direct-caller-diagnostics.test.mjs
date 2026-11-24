/**
 * review-remediation-evidence-direct-caller-diagnostics.test.mjs
 *
 * fix-integration-tier-regressions: locks the two-channel contract of the
 * review-remediation evidence core when the shared evidence reader hits a
 * durable-fs path-safety error or `derivedNotesRoot` rejects the notes root, and
 * the caller supplied no semantic failure code:
 *   - `.code` is the closed D30 catalog code (`evidence-artifact-invalid`), which
 *     the D30 request-file CLI turns into its fixed catalog detail;
 *   - `.message` keeps the concrete cause so direct helper callers
 *     (`verifyHeadBoundFinalEvidence`, `verifyCurrentCrossCarrierClosure`) can
 *     classify the failure instead of degrading to a generic reason.
 * The `verifyCurrentCrossCarrierClosure` scenario ("Oversized closure candidate
 * keeps its cause") needs a sealed closure fixture and is asserted by the
 * existing cross-carrier-remediation-closure.test.mjs, not duplicated here.
 *
 * `integration` tier (test-suite-manifest.mjs): spawns real `git` and a real
 * Node CLI child.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync, ftruncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as evidence from "../review-remediation-evidence.mjs";
import { finalEvidenceFileName } from "./lib/final-evidence-record-fixture.mjs";

const HELPER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../review-remediation-evidence.mjs");
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "review-evidence-direct-caller-diagnostics-"));
after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function makeGitRepo() {
  const dir = mkdtempSync(path.join(tmpRoot, "repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "x"), "x\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  return { dir, headSha, notesRoot: path.join(dir, "notes") };
}

function sparseFile(target, bytes) {
  const fd = openSync(target, "w");
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

function makeSymlink(t, target, linkPath) {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

// Scenario: Over-budget FinalEvidenceRecord keeps its budget reason
test("Over-budget FinalEvidenceRecord keeps its budget reason", () => {
  const repo = makeGitRepo();
  const changeId = "diag-over-budget";
  mkdirSync(repo.notesRoot, { recursive: true });
  sparseFile(path.join(repo.notesRoot, finalEvidenceFileName(changeId, repo.headSha)), 2049);
  assert.throws(
    () => evidence.verifyHeadBoundFinalEvidence({ repoRoot: repo.dir, changeId, headSha: repo.headSha, maxRecordBytes: 2048 }),
    (error) => error.name === "CoreFailure"
      && error.code === "evidence-artifact-invalid"
      && /final-evidence-over-caller-budget/.test(error.message),
  );
});

// Scenario: A missing or unsafe record and notes root keep their cause
test("A missing or unsafe record and notes root keep their cause: missing record names ENOENT", () => {
  const repo = makeGitRepo();
  const changeId = "diag-missing-record";
  assert.throws(
    () => evidence.verifyHeadBoundFinalEvidence({ repoRoot: repo.dir, changeId, headSha: repo.headSha }),
    (error) => error.name !== "CoreFailure"
      && error.code === "ENOENT"
      && /head-bound FinalEvidenceRecord is unreadable or unsafe: ENOENT/.test(error.message),
  );
});

test("A missing or unsafe record and notes root keep their cause: non-regular record names target-not-regular-file and keeps the closed code", (t) => {
  const repo = makeGitRepo();
  const changeId = "diag-not-regular";
  mkdirSync(repo.notesRoot, { recursive: true });
  const decoy = path.join(repo.notesRoot, "decoy-record.json");
  writeFileSync(decoy, "{}\n");
  if (!makeSymlink(t, decoy, path.join(repo.notesRoot, finalEvidenceFileName(changeId, repo.headSha)))) return;
  assert.throws(
    () => evidence.verifyHeadBoundFinalEvidence({ repoRoot: repo.dir, changeId, headSha: repo.headSha }),
    (error) => error.name === "CoreFailure"
      && error.code === "evidence-artifact-invalid"
      && /head-bound FinalEvidenceRecord is unreadable or unsafe: target-not-regular-file/.test(error.message),
  );
});

test("A missing or unsafe record and notes root keep their cause: symlinked notes root names the root and keeps the closed code", (t) => {
  const repo = makeGitRepo();
  const changeId = "diag-notes-root-symlink";
  const elsewhere = mkdtempSync(path.join(tmpRoot, "elsewhere-"));
  if (!makeSymlink(t, elsewhere, repo.notesRoot)) return;
  assert.throws(
    () => evidence.verifyHeadBoundFinalEvidence({ repoRoot: repo.dir, changeId, headSha: repo.headSha }),
    (error) => error.name === "CoreFailure"
      && error.code === "evidence-artifact-invalid"
      && /derived main notes root cannot be a symlink/.test(error.message),
  );
});

// Scenario: D30 CLI failure JSON keeps the closed code and fixed detail
// `build-receipt-request` reads `rawPayloadRef` through the no-semantic-code
// branch of `readEvidenceBytes` (the branch that now carries the diagnostic
// text); `verify-receipt` would take the semantic-code branch instead.
test("D30 CLI failure JSON keeps the closed code and fixed detail", (t) => {
  const repo = makeGitRepo();
  const changeId = "diag-cli-json";
  mkdirSync(repo.notesRoot, { recursive: true });
  mkdirSync(path.join(repo.dir, "openspec", "changes", changeId), { recursive: true });
  const decoy = path.join(repo.notesRoot, "cli-private-decoy-sentinel.json");
  writeFileSync(decoy, "{}\n");
  const rawName = `review-${changeId}-raw-payload.json`;
  if (!makeSymlink(t, decoy, path.join(repo.notesRoot, rawName))) return;
  const requestPath = path.join(tmpRoot, "build-receipt-request-request.json");
  writeFileSync(requestPath, `${JSON.stringify({ repoRoot: repo.dir, changeId, rawPayloadRef: { path: rawName, digest_sha256: "0".repeat(64) } })}\n`);
  const result = spawnSync(process.execPath, [HELPER_PATH, "build-receipt-request", "--request", requestPath], { cwd: repo.dir, encoding: "utf8" });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: "evidence-artifact-invalid",
    detail: "Use a regular evidence file inside its verified parent; remove unsafe target links or entries before retrying.",
  });
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /unreadable or unsafe|target-not-regular-file|rawPayloadRef|cli-private-decoy-sentinel/);
});
