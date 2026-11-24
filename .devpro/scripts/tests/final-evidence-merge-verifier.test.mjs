/**
 * final-evidence-merge-verifier.test.mjs
 *
 * design.md D5/D11 (fix-merge-gate-regression-currency), tasks.md T4(a).
 * Covers `.devpro/scripts/hooks/lib/final-evidence-merge-verifier.mjs`:
 *   - `classifyFinalEvidenceVerifierResult` — pure classifier table.
 *   - `runFinalEvidenceVerifierChild` — real child spawns (positive, tiny
 *     heap, timeout, byte-budget) and fake-child spawns (crash, malformed
 *     stdout, output overflow, signal, echo mismatch) via an injected
 *     `entry` script — never an env seam.
 *   - Source locks (D5 "鎖相容性" / D11).
 *
 * `integration` tier (test-suite-manifest.mjs): spawns real `git` and real
 * Node child processes throughout.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  ftruncateSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFinalEvidenceVerifierResult,
  FINAL_EVIDENCE_VERDICT_SCHEMA,
  FINAL_EVIDENCE_VERIFIER_BUDGET,
  formatRecordRejectedReason,
  runFinalEvidenceVerifierChild,
} from "../hooks/lib/final-evidence-merge-verifier.mjs";
import {
  buildManifestHeavyRecordFixture,
  finalEvidenceFileName,
  writeFinalEvidenceRecordFixture,
} from "./lib/final-evidence-record-fixture.mjs";

const MERGE_VERIFIER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/lib/final-evidence-merge-verifier.mjs",
);
const HOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs",
);

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "final-evidence-merge-verifier-test-"));
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
  return { dir, headSha };
}

/** Writes a fake-child Node script (design D11 "假 child…以 entry 注入") and
 * returns its absolute path. Never a `*.test.mjs` fixture file — a plain
 * throwaway script under this file's own tmp root. */
function writeFakeChildScript(code) {
  const scriptPath = path.join(mkdtempSync(path.join(tmpRoot, "fake-child-")), "child.mjs");
  writeFileSync(scriptPath, code);
  return scriptPath;
}

// ─────────────────────────────────────────────────────────────────────────
// classifyFinalEvidenceVerifierResult — pure classifier table
// ─────────────────────────────────────────────────────────────────────────

describe("classifyFinalEvidenceVerifierResult (design D5 step 1-5, pure)", () => {
  const changeId = "classifier-table-change";
  const headSha = "a".repeat(40);
  const digest = "b".repeat(64);
  const successLine = `${JSON.stringify({
    schema: FINAL_EVIDENCE_VERDICT_SCHEMA,
    ok: true,
    change_id: changeId,
    head_sha: headSha,
    record_digest_sha256: digest,
  })}\n`;
  const budgetRejectionLine = `${JSON.stringify({
    schema: FINAL_EVIDENCE_VERDICT_SCHEMA,
    ok: false,
    reason: "record-exceeds-merge-verifier-budget: 33554432 bytes",
  })}\n`;
  const rejectedLine = `${JSON.stringify({
    schema: FINAL_EVIDENCE_VERDICT_SCHEMA,
    ok: false,
    reason: "record-rejected: head mismatch",
  })}\n`;
  const argvInvalidLine = `${JSON.stringify({
    schema: FINAL_EVIDENCE_VERDICT_SCHEMA,
    ok: false,
    reason: "argv-invalid: bad argv",
  })}\n`;

  const cases = [
    ["ETIMEDOUT spawn error → verifier-timeout", { error: { code: "ETIMEDOUT" }, status: null, signal: "SIGKILL" }, { satisfied: false, failure_kind: "verifier-timeout" }],
    ["ENOBUFS spawn error → verifier-output-overflow", { error: { code: "ENOBUFS" }, status: null, signal: "SIGTERM" }, { satisfied: false, failure_kind: "verifier-output-overflow" }],
    ["other spawn error → verifier-spawn-failed", { error: { code: "ENOENT", message: "spawn nope" }, status: null, signal: null }, { satisfied: false, failure_kind: "verifier-spawn-failed" }],
    ["SIGKILL signal (no error) → verifier-signal", { error: null, status: null, signal: "SIGKILL" }, { satisfied: false, failure_kind: "verifier-signal" }],
    ["SIGABRT signal (heap exhaustion) → verifier-signal", { error: null, status: null, signal: "SIGABRT" }, { satisfied: false, failure_kind: "verifier-signal" }],
    ["status 134 no signal (shell-reported heap abort) → verifier-exit-nonzero", { error: null, status: 134, signal: null }, { satisfied: false, failure_kind: "verifier-exit-nonzero" }],
    ["status 2 → verifier-exit-nonzero", { error: null, status: 2, signal: null }, { satisfied: false, failure_kind: "verifier-exit-nonzero" }],
    ["status 1, empty stdout (no rejection line) → verifier-exit-nonzero", { error: null, status: 1, signal: null, stdout: "" }, { satisfied: false, failure_kind: "verifier-exit-nonzero" }],
    ["status 1, rejection reason not one of the three codes → verifier-exit-nonzero", { error: null, status: 1, signal: null, stdout: `${JSON.stringify({ schema: FINAL_EVIDENCE_VERDICT_SCHEMA, ok: false, reason: "totally-unrelated: nope" })}\n` }, { satisfied: false, failure_kind: "verifier-exit-nonzero" }],
    ["status 1, strict record-exceeds-merge-verifier-budget rejection → verifier-budget-exceeded", { error: null, status: 1, signal: null, stdout: budgetRejectionLine }, { satisfied: false, failure_kind: "verifier-budget-exceeded" }],
    ["status 1, strict record-rejected rejection → verifier-rejected", { error: null, status: 1, signal: null, stdout: rejectedLine }, { satisfied: false, failure_kind: "verifier-rejected" }],
    ["status 1, strict argv-invalid rejection → verifier-rejected", { error: null, status: 1, signal: null, stdout: argvInvalidLine }, { satisfied: false, failure_kind: "verifier-rejected" }],
    ["status 0, valid single-line verdict → satisfied", { error: null, status: 0, signal: null, stdout: successLine }, { satisfied: true }],
    ["status 0, missing trailing LF → verifier-output-malformed", { error: null, status: 0, signal: null, stdout: successLine.slice(0, -1) }, { satisfied: false, failure_kind: "verifier-output-malformed" }],
    ["status 0, second line present → verifier-output-malformed", { error: null, status: 0, signal: null, stdout: `${successLine}extra\n` }, { satisfied: false, failure_kind: "verifier-output-malformed" }],
    ["status 0, extra key → verifier-output-malformed", { error: null, status: 0, signal: null, stdout: `${JSON.stringify({ schema: FINAL_EVIDENCE_VERDICT_SCHEMA, ok: true, change_id: changeId, head_sha: headSha, record_digest_sha256: digest, extra: 1 })}\n` }, { satisfied: false, failure_kind: "verifier-output-malformed" }],
    ["status 0, missing key → verifier-output-malformed", { error: null, status: 0, signal: null, stdout: `${JSON.stringify({ schema: FINAL_EVIDENCE_VERDICT_SCHEMA, ok: true, change_id: changeId, head_sha: headSha })}\n` }, { satisfied: false, failure_kind: "verifier-output-malformed" }],
    ["status 0, wrong schema → verifier-output-malformed", { error: null, status: 0, signal: null, stdout: `${JSON.stringify({ schema: "wrong/v1", ok: true, change_id: changeId, head_sha: headSha, record_digest_sha256: digest })}\n` }, { satisfied: false, failure_kind: "verifier-output-malformed" }],
    ["status 0, ok:false → verifier-output-malformed", { error: null, status: 0, signal: null, stdout: `${JSON.stringify({ schema: FINAL_EVIDENCE_VERDICT_SCHEMA, ok: false, change_id: changeId, head_sha: headSha, record_digest_sha256: digest })}\n` }, { satisfied: false, failure_kind: "verifier-output-malformed" }],
    ["status 0, change_id echo mismatch → verifier-output-malformed", { error: null, status: 0, signal: null, stdout: `${JSON.stringify({ schema: FINAL_EVIDENCE_VERDICT_SCHEMA, ok: true, change_id: "another-change", head_sha: headSha, record_digest_sha256: digest })}\n` }, { satisfied: false, failure_kind: "verifier-output-malformed" }],
    ["status 0, head_sha echo mismatch → verifier-output-malformed", { error: null, status: 0, signal: null, stdout: `${JSON.stringify({ schema: FINAL_EVIDENCE_VERDICT_SCHEMA, ok: true, change_id: changeId, head_sha: "c".repeat(40), record_digest_sha256: digest })}\n` }, { satisfied: false, failure_kind: "verifier-output-malformed" }],
    ["status 0, non-hex digest → verifier-output-malformed", { error: null, status: 0, signal: null, stdout: `${JSON.stringify({ schema: FINAL_EVIDENCE_VERDICT_SCHEMA, ok: true, change_id: changeId, head_sha: headSha, record_digest_sha256: "NOT-HEX" })}\n` }, { satisfied: false, failure_kind: "verifier-output-malformed" }],
  ];

  for (const [name, result, expected] of cases) {
    test(name, () => {
      const classified = classifyFinalEvidenceVerifierResult(result, { changeId, headSha });
      assert.equal(classified.satisfied, expected.satisfied, JSON.stringify(classified));
      if (expected.failure_kind) {
        assert.equal(classified.failure_kind, expected.failure_kind, JSON.stringify(classified));
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// formatRecordRejectedReason — F-r1-4 remediation: the child's
// "record-rejected: " prefix MUST count toward the classifier's 512-char
// reason ceiling, not just the truncated core message.
// ─────────────────────────────────────────────────────────────────────────

describe("formatRecordRejectedReason (design D5/D11 remediation F-r1-4)", () => {
  const changeId = "format-record-rejected-change";
  const headSha = "a".repeat(40);

  test("a core error message far longer than 512 chars still yields a <=512-char whole reason", () => {
    const longMessage = "x".repeat(1000);
    const reason = formatRecordRejectedReason(longMessage);
    assert.ok(reason.length <= 512, `formatRecordRejectedReason produced ${reason.length} chars, must be <=512`);
    assert.ok(reason.startsWith("record-rejected: "), reason);
  });

  test("a message that alone is exactly 512 chars (so the naive bug's 530-char total would previously exceed the ceiling) round-trips through classifyFinalEvidenceVerifierResult as verifier-rejected, not verifier-exit-nonzero", () => {
    const message = "y".repeat(512);
    const reason = formatRecordRejectedReason(message);
    assert.ok(reason.length <= 512, `formatRecordRejectedReason produced ${reason.length} chars, must be <=512`);
    const stdout = `${JSON.stringify({ schema: FINAL_EVIDENCE_VERDICT_SCHEMA, ok: false, reason })}\n`;
    const classified = classifyFinalEvidenceVerifierResult(
      { error: null, status: 1, signal: null, stdout },
      { changeId, headSha },
    );
    assert.equal(classified.satisfied, false);
    assert.equal(classified.failure_kind, "verifier-rejected", JSON.stringify(classified));
    assert.equal(classified.reason, reason);
  });

  test("a short message is preserved verbatim (no unnecessary truncation)", () => {
    const reason = formatRecordRejectedReason("short core error");
    assert.equal(reason, "record-rejected: short core error");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runFinalEvidenceVerifierChild — fake-child injected entry (design D11)
// ─────────────────────────────────────────────────────────────────────────

describe("runFinalEvidenceVerifierChild — fake child scripts (never an env seam)", () => {
  const repoFixture = makeGitRepo();
  const changeId = "fake-child-change";

  test("non-zero exit without a strict rejection line → not satisfied, verifier-exit-nonzero", () => {
    const entry = writeFakeChildScript("process.exitCode = 3;\n");
    const result = runFinalEvidenceVerifierChild({ repoRoot: repoFixture.dir, changeId, headSha: repoFixture.headSha, entry });
    assert.equal(result.satisfied, false);
    assert.equal(result.failure_kind, "verifier-exit-nonzero");
  });

  test("malformed stdout (not JSON) with exit 0 → not satisfied, verifier-output-malformed", () => {
    const entry = writeFakeChildScript('process.stdout.write("not json\\n"); process.exitCode = 0;\n');
    const result = runFinalEvidenceVerifierChild({ repoRoot: repoFixture.dir, changeId, headSha: repoFixture.headSha, entry });
    assert.equal(result.satisfied, false);
    assert.equal(result.failure_kind, "verifier-output-malformed");
  });

  test("stdout exceeding maxOutputBytes → not satisfied, verifier-output-overflow", () => {
    const entry = writeFakeChildScript('process.stdout.write("x".repeat(200000) + "\\n");\n');
    const budget = { ...FINAL_EVIDENCE_VERIFIER_BUDGET, maxOutputBytes: 1024 };
    const result = runFinalEvidenceVerifierChild({ repoRoot: repoFixture.dir, changeId, headSha: repoFixture.headSha, entry, budget });
    assert.equal(result.satisfied, false);
    assert.equal(result.failure_kind, "verifier-output-overflow");
  });

  test("self SIGKILL → not satisfied, verifier-signal", () => {
    const entry = writeFakeChildScript("process.kill(process.pid, 'SIGKILL');\n");
    const result = runFinalEvidenceVerifierChild({ repoRoot: repoFixture.dir, changeId, headSha: repoFixture.headSha, entry });
    assert.equal(result.satisfied, false);
    // Windows has no signal termination: the killed child is reported with a non-zero exit status and no signal.
    assert.equal(result.failure_kind, process.platform === "win32" ? "verifier-exit-nonzero" : "verifier-signal");
  });

  test("child that never exits → not satisfied, verifier-timeout (injected small timeoutMs)", () => {
    const entry = writeFakeChildScript("setTimeout(() => {}, 999999);\n");
    const budget = { ...FINAL_EVIDENCE_VERIFIER_BUDGET, timeoutMs: 200 };
    const result = runFinalEvidenceVerifierChild({ repoRoot: repoFixture.dir, changeId, headSha: repoFixture.headSha, entry, budget });
    assert.equal(result.satisfied, false);
    assert.equal(result.failure_kind, "verifier-timeout");
  });

  test("verdict echoing a different change_id → not satisfied, verifier-output-malformed", () => {
    const entry = writeFakeChildScript(
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          schema: FINAL_EVIDENCE_VERDICT_SCHEMA,
          ok: true,
          change_id: "some-other-change",
          head_sha: repoFixture.headSha,
          record_digest_sha256: "a".repeat(64),
        }),
      )} + "\\n");\nprocess.exitCode = 0;\n`,
    );
    const result = runFinalEvidenceVerifierChild({ repoRoot: repoFixture.dir, changeId, headSha: repoFixture.headSha, entry });
    assert.equal(result.satisfied, false);
    assert.equal(result.failure_kind, "verifier-output-malformed");
  });

  test("verdict echoing a different head_sha → not satisfied, verifier-output-malformed", () => {
    const entry = writeFakeChildScript(
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          schema: FINAL_EVIDENCE_VERDICT_SCHEMA,
          ok: true,
          change_id: changeId,
          head_sha: "f".repeat(40),
          record_digest_sha256: "a".repeat(64),
        }),
      )} + "\\n");\nprocess.exitCode = 0;\n`,
    );
    const result = runFinalEvidenceVerifierChild({ repoRoot: repoFixture.dir, changeId, headSha: repoFixture.headSha, entry });
    assert.equal(result.satisfied, false);
    assert.equal(result.failure_kind, "verifier-output-malformed");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runFinalEvidenceVerifierChild — real production child (positive + budgets)
// ─────────────────────────────────────────────────────────────────────────

describe("runFinalEvidenceVerifierChild — real production child", () => {
  test("a legitimate small FinalEvidenceRecord verifies via the real production entry/budget", () => {
    const repo = makeGitRepo();
    const changeId = "real-child-small-record";
    writeFinalEvidenceRecordFixture({
      notesRoot: path.join(repo.dir, "notes"),
      changeId,
      headSha: repo.headSha,
    });
    const result = runFinalEvidenceVerifierChild({ repoRoot: repo.dir, changeId, headSha: repo.headSha });
    assert.deepEqual(result, { satisfied: true }, JSON.stringify(result));
  });

  // Scenario: Consumer not-applicable FinalEvidenceRecord does not satisfy the FinalEvidenceRecord form
  test("a complete, validator-legal v1 consumer not-applicable record is rejected by the real child on pass-only, not by validator", () => {
    const repo = makeGitRepo();
    const changeId = "real-child-consumer-na-record";
    const { record } = writeFinalEvidenceRecordFixture({
      notesRoot: path.join(repo.dir, "notes"),
      changeId,
      headSha: repo.headSha,
      result: "not-applicable-consumer-profile",
    });
    // Fixture must be a full v1 N/A record the shared validator accepts, so a
    // rejection can only come from the pass-only predicate.
    assert.deepEqual(Object.keys(record.payload).sort(), [
      "canonical_owner_id", "command_id", "failed", "final_carrier_manifest", "head_sha",
      "log", "passed", "result", "review_coverage", "tests",
    ]);
    assert.equal(record.payload.result, "not-applicable-consumer-profile");
    assert.deepEqual([record.payload.tests, record.payload.passed, record.payload.failed], [null, null, null]);
    const result = runFinalEvidenceVerifierChild({ repoRoot: repo.dir, changeId, headSha: repo.headSha });
    assert.equal(result.satisfied, false, JSON.stringify(result));
    assert.equal(result.failure_kind, "verifier-rejected", JSON.stringify(result));
    assert.equal(
      result.reason,
      formatRecordRejectedReason("head-bound FinalEvidenceRecord suite result is not pass"),
    );
    assert.doesNotMatch(result.reason, /invalid final suite authority/);
    assert.doesNotMatch(result.reason, /must not carry counts/);
    assert.doesNotMatch(result.reason, /digest mismatch/);
  });

  test("input validation: relative repoRoot → verifier-input-invalid (no spawn)", () => {
    const result = runFinalEvidenceVerifierChild({ repoRoot: "relative/path", changeId: "x", headSha: "a".repeat(40) });
    assert.equal(result.satisfied, false);
    assert.equal(result.failure_kind, "verifier-input-invalid");
  });

  test("input validation: invalid changeId → verifier-input-invalid (no spawn)", () => {
    const repo = makeGitRepo();
    const result = runFinalEvidenceVerifierChild({ repoRoot: repo.dir, changeId: "../escape", headSha: "a".repeat(40) });
    assert.equal(result.satisfied, false);
    assert.equal(result.failure_kind, "verifier-input-invalid");
  });

  test("input validation: non-40-hex headSha → verifier-input-invalid (no spawn)", () => {
    const repo = makeGitRepo();
    const result = runFinalEvidenceVerifierChild({ repoRoot: repo.dir, changeId: "x", headSha: "not-a-sha" });
    assert.equal(result.satisfied, false);
    assert.equal(result.failure_kind, "verifier-input-invalid");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Adequacy (production budget worst case) + tiny-heap + budget-exceeded
// (design D5/D11: the large fixture is built ONCE and shared between the
// adequacy and tiny-heap tests)
// ─────────────────────────────────────────────────────────────────────────

// Writer's own inline-log cap (2 MiB, `MAX_INLINE_LOG_BYTES` in
// review-remediation-evidence-core.mjs — an unexported internal constant this
// test file MUST NOT import; hardcoded here as the shared fixture builder's
// existing precedent already does, e.g. review-remediation-evidence.test.mjs
// `const maxBytes = 2 * 1024 * 1024;`).
const WRITER_MAX_INLINE_LOG_BYTES = 2 * 1024 * 1024;

/**
 * Manifest-heavy record at `targetBytes` with the writer-maximum inline log.
 * Delegates to the shared many-entry builder so heap cost scales with the
 * number of parsed objects, not one padded string (review r1 F-r1-5).
 */
function buildRecordAtSize({ changeId, headSha, targetBytes }) {
  return buildManifestHeavyRecordFixture({
    changeId,
    headSha,
    targetBytes,
    inlineLogBytes: WRITER_MAX_INLINE_LOG_BYTES,
  });
}

describe("adequacy (production budget) + tiny heap (design D5/D11 — shared fixture)", () => {
  let repo;
  const changeId = "adequacy-manifest-heavy-change";
  let fixtureBytes;

  before(() => {
    repo = makeGitRepo();
    const targetBytes = FINAL_EVIDENCE_VERIFIER_BUDGET.maxRecordBytes - 32 * 1024; // within the required [-64 KiB, 0] band
    const built = buildRecordAtSize({ changeId, headSha: repo.headSha, targetBytes });
    assert.ok(
      built.bytes <= FINAL_EVIDENCE_VERIFIER_BUDGET.maxRecordBytes &&
        built.bytes >= FINAL_EVIDENCE_VERIFIER_BUDGET.maxRecordBytes - 64 * 1024,
      `fixture must land within 64 KiB of maxRecordBytes, got ${built.bytes}`,
    );
    writeFinalEvidenceRecordFixture({
      notesRoot: path.join(repo.dir, "notes"),
      changeId,
      headSha: repo.headSha,
      record: built.record,
    });
    fixtureBytes = built.bytes;
  });

  test("a manifest-heavy record at the byte budget (writer-maximum inline log) verifies via the real production child", () => {
    const result = runFinalEvidenceVerifierChild({ repoRoot: repo.dir, changeId, headSha: repo.headSha });
    assert.deepEqual(result, { satisfied: true }, `fixture was ${fixtureBytes} bytes; result: ${JSON.stringify(result)}`);
  });

  test("the same near-budget record with a tiny injected heap → not satisfied (unbound failure_kind)", () => {
    const budget = { ...FINAL_EVIDENCE_VERIFIER_BUDGET, heapMiB: 16 };
    const result = runFinalEvidenceVerifierChild({ repoRoot: repo.dir, changeId, headSha: repo.headSha, budget });
    assert.equal(result.satisfied, false, JSON.stringify(result));
  });
});

test("a record one byte over the production maxRecordBytes → verifier-budget-exceeded, rejected before being read into memory", () => {
  const repo = makeGitRepo();
  const changeId = "over-budget-change";
  const notesRoot = path.join(repo.dir, "notes");
  mkdirSync(notesRoot, { recursive: true });
  const targetPath = path.join(notesRoot, finalEvidenceFileName(changeId, repo.headSha));
  const fd = openSync(targetPath, "w");
  ftruncateSync(fd, FINAL_EVIDENCE_VERIFIER_BUDGET.maxRecordBytes + 1);
  closeSync(fd);
  const result = runFinalEvidenceVerifierChild({ repoRoot: repo.dir, changeId, headSha: repo.headSha });
  assert.equal(result.satisfied, false);
  assert.equal(result.failure_kind, "verifier-budget-exceeded");
  assert.match(result.reason || "", /record-exceeds-merge-verifier-budget/);
});

test("a real child with an injected 1ms timeout → not satisfied, verifier-timeout", () => {
  const repo = makeGitRepo();
  const changeId = "timeout-real-child-change";
  writeFinalEvidenceRecordFixture({
    notesRoot: path.join(repo.dir, "notes"),
    changeId,
    headSha: repo.headSha,
  });
  const budget = { ...FINAL_EVIDENCE_VERIFIER_BUDGET, timeoutMs: 1 };
  const result = runFinalEvidenceVerifierChild({ repoRoot: repo.dir, changeId, headSha: repo.headSha, budget });
  assert.equal(result.satisfied, false);
  assert.equal(result.failure_kind, "verifier-timeout");
  assert.equal(result.timeoutMs, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// Source locks (design D5 "鎖相容性" / D11)
// ─────────────────────────────────────────────────────────────────────────

describe("source locks", () => {
  test("pre-tool-gate.mjs never references the evidence façade or its core module by path", () => {
    const hookSource = readFileSync(HOOK_PATH, "utf8");
    assert.ok(!hookSource.includes("review-remediation-evidence"), "hook must not statically import the façade or the core module");
  });

  test("the local-test gate dispatcher supplies the target checkout and PR binding as its only dependency", () => {
    const hookSource = readFileSync(HOOK_PATH, "utf8");
    const gate = hookSource.match(/id: "local-test-merge-evidence",[\s\S]*?(?=\n  \},)/)?.[0] || "";
    assert.match(
      gate,
      /runner: \(\{ cmd, baseCwd, effectiveCwd \}\) =>\s+checkLocalTestGateOnMerge\(cmd, _mergeEvidenceCwd\(cmd, baseCwd, effectiveCwd\), \{ bound: _mergeEvidenceBinding\(cmd, baseCwd, effectiveCwd\) \}\),$/,
      "the production dispatcher must read the bound checkout and pass only the bound PR, without injecting test dependencies",
    );
  });

  test("final-evidence-merge-verifier.mjs never imports the internal evidence core module (core-importer lock)", () => {
    const source = readFileSync(MERGE_VERIFIER_PATH, "utf8");
    assert.ok(!source.includes("review-remediation-evidence-core.mjs"), "must never reference the core module's relative path string");
  });

  test("final-evidence-merge-verifier.mjs has no static façade import and exactly one dynamic import() (only inside the child entry point)", () => {
    const source = readFileSync(MERGE_VERIFIER_PATH, "utf8");
    assert.doesNotMatch(
      source,
      /^\s*import\s[^\n]*review-remediation-evidence\.mjs/m,
      "must not statically import the production façade at module load",
    );
    const dynamicImportCallCount = (source.match(/\bawait import\(/g) || []).length;
    assert.equal(dynamicImportCallCount, 1, "exactly one `await import(...)` call, inside the child entry point");
  });

  test("final-evidence-merge-verifier.mjs never reads the hook runner's timeout override variable", () => {
    const source = readFileSync(MERGE_VERIFIER_PATH, "utf8");
    assert.doesNotMatch(source, /DEVPRO_HOOK_TIMEOUT_MS/);
  });

  test("final-evidence-merge-verifier.mjs never sources the child entry or budget from process.env (design D11)", () => {
    const source = readFileSync(MERGE_VERIFIER_PATH, "utf8");
    const codeLines = source.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    const envLines = codeLines.filter((line) => line.includes("process.env"));
    assert.deepEqual(
      envLines.map((line) => line.trim()),
      ["const env = { ...process.env };"],
      "the only code use of process.env is copying the child env",
    );
    assert.match(source, /^\s*entry = THIS_FILE,$/m, "entry default must be THIS_FILE");
    assert.match(source, /^\s*budget = FINAL_EVIDENCE_VERIFIER_BUDGET,$/m, "budget default must be FINAL_EVIDENCE_VERIFIER_BUDGET");
  });

  test("FINAL_EVIDENCE_VERIFIER_BUDGET.timeoutMs x 4 <= run-hook.mjs's MAX_HOOK_TIMEOUT_MS (unexported; read from source per design D11)", () => {
    const runHookSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../hooks/run-hook.mjs"),
      "utf8",
    );
    const match = runHookSource.match(/^const MAX_HOOK_TIMEOUT_MS = (\d[\d_]*);$/m);
    assert.ok(match, "run-hook.mjs must declare `const MAX_HOOK_TIMEOUT_MS = <n>;`");
    const maxHookTimeoutMs = Number(match[1].replaceAll("_", ""));
    assert.ok(
      FINAL_EVIDENCE_VERIFIER_BUDGET.timeoutMs * 4 <= maxHookTimeoutMs,
      `timeoutMs (${FINAL_EVIDENCE_VERIFIER_BUDGET.timeoutMs}) x 4 must stay within the hook runner's ${maxHookTimeoutMs}ms ceiling`,
    );
  });

  test("FINAL_EVIDENCE_VERIFIER_BUDGET.heapMiB stays below the 1024 MiB ceiling design D11 sets on adequacy remediation", () => {
    assert.ok(FINAL_EVIDENCE_VERIFIER_BUDGET.heapMiB < 1024);
  });

  test("FINAL_EVIDENCE_VERIFIER_BUDGET.maxRecordBytes stays at or above the 8 MiB floor design D11 sets on adequacy remediation", () => {
    assert.ok(FINAL_EVIDENCE_VERIFIER_BUDGET.maxRecordBytes >= 8 * 1024 * 1024);
  });
});
