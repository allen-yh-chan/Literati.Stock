import "./lib/portable-command-shims.cjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath, REPO_ROOT } from "./lib/repo-root.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const cliPath = repoPath(".devpro/scripts/accept-external-second-review.mjs");
const controlEvidencePath = repoPath(".devpro/scripts/hooks/lib/second-review-control-evidence.mjs");

async function loadControlEvidence() {
  return import(pathToFileURL(controlEvidencePath).href);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const REPO_SLUG = "devpro/example";
const HEAD_SHA = "a".repeat(40);

function baseDispatchRecord(overrides = {}) {
  return {
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: REPO_SLUG,
    pr_number: "1658",
    head_ref_oid: HEAD_SHA,
    attempt_id: "second-review-pr-1658-external",
    dispatch_id: "dispatch-1658-external",
    previous_dispatch_id: null,
    packet_sha256: "a".repeat(64),
    carrier_root_id: "b".repeat(64),
    executor_kind: "external-evaluator",
    reviewer_family: "gemini",
    primary_family: "claude",
    reviewer_tool: "Gemini CLI",
    sticky_write_action: "create",
    sticky_target_comment_id: null,
    sticky_snapshot_digest: "c".repeat(64),
    issued_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function runnerDispatchRecord(overrides = {}) {
  return {
    schema: "devpro-second-review-dispatch/v1",
    repository_slug: REPO_SLUG,
    pr_number: "1658",
    head_ref_oid: HEAD_SHA,
    attempt_id: "second-review-pr-1658-runner",
    dispatch_id: "dispatch-1658-runner",
    previous_dispatch_id: null,
    packet_sha256: "a".repeat(64),
    carrier_root_id: "b".repeat(64),
    ...overrides,
  };
}

/**
 * Sets up an isolated control-evidence root + packet-dir sidecar for one
 * external dispatch, reserved via the T2 API (never through the T3
 * renderer, per the delegation's "don't depend on T3" instruction).
 */
async function setupFixture({ record: recordOverrides = {}, context: contextOverrides = {}, useRecord = null } = {}) {
  const dir = makeTempDir("accept-external-second-review-");
  const rootDir = path.join(dir, "control-evidence");
  const packetDir = path.join(dir, "packet");
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(packetDir, { recursive: true });
  const contextPath = path.join(packetDir, "observability-context.json");
  const carrierRootId = sha256(packetDir);

  const { reserveDispatchRecord } = await loadControlEvidence();
  const record = useRecord ?? baseDispatchRecord({ carrier_root_id: carrierRootId, ...recordOverrides });
  await reserveDispatchRecord({ rootDir, record });

  const context = {
    dispatch_id: record.dispatch_id,
    attempt_id: record.attempt_id,
    repository_slug: record.repository_slug,
    pr_number: record.pr_number,
    head_ref_oid: record.head_ref_oid,
    observability_context_path: contextPath,
    control_evidence_root: rootDir,
    sticky_write_disposition: {
      action: record.sticky_write_action,
      ...(record.sticky_write_action === "update" ? { target: { id: record.sticky_target_comment_id } } : {}),
      snapshot_digest: record.sticky_snapshot_digest,
    },
    ...contextOverrides,
  };
  writeFileSync(contextPath, `${JSON.stringify(context)}\n`);

  return { dir, rootDir, packetDir, record, context };
}

function cleanupFixture(fixture) {
  rmSync(fixture.dir, { recursive: true, force: true });
}

function stickyComment({
  id = 5001,
  repositorySlug = REPO_SLUG,
  prNumber = "1658",
  verdict = "PASS",
  lastReviewedSha = HEAD_SHA,
  dispatchId = "dispatch-1658-external",
  reviewerTool = "Gemini CLI",
  reviewerModel = "gemini-2.5-pro",
  rulesVersion = "1.0.0",
  reason = "Looks good.",
  updatedAt = "2026-01-02T00:00:00Z",
  createdAt = "2026-01-02T00:00:00Z",
  bodyOverride = null,
} = {}) {
  const body = bodyOverride ?? [
    "<!-- cross-model-second-opinion:sticky -->",
    `verdict: ${verdict}`,
    `last_reviewed_sha: ${lastReviewedSha}`,
    `dispatch_id: ${dispatchId}`,
    `reason: ${reason}`,
    `Rules: v${rulesVersion} · Tool: ${reviewerTool} · Model: ${reviewerModel}`,
  ].join("\n");
  return {
    id,
    html_url: `https://github.com/${repositorySlug}/pull/${prNumber}#issuecomment-${id}`,
    node_id: `IC_${id}`,
    body,
    updated_at: updatedAt,
    created_at: createdAt,
  };
}

function writeFakeGh(binDir) {
  const fake = path.join(binDir, "gh");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.DEVPRO_FAKE_GH_LOG) {
  fs.appendFileSync(process.env.DEVPRO_FAKE_GH_LOG, args.join(" ") + "\\n");
}
if (process.env.DEVPRO_FAKE_GH_EXIT) {
  process.exit(Number(process.env.DEVPRO_FAKE_GH_EXIT));
}
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ headRefOid: process.env.DEVPRO_FAKE_GH_HEAD || "" }) + "\\n");
  process.exit(0);
}
if (args[0] === "api") {
  const commentsFile = process.env.DEVPRO_FAKE_GH_COMMENTS_FILE;
  const comments = commentsFile && fs.existsSync(commentsFile) ? JSON.parse(fs.readFileSync(commentsFile, "utf8")) : [];
  process.stdout.write(JSON.stringify([comments]) + "\\n");
  process.exit(0);
}
process.exit(1);
`
  );
  chmodSync(fake, 0o755);
}

function runCli(fixture, { binDir, head = HEAD_SHA, comments = [], log = null, extraEnv = {} } = {}) {
  const commentsFile = path.join(fixture.dir, `comments-${Date.now()}-${Math.random()}.json`);
  writeFileSync(commentsFile, JSON.stringify(comments));
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    DEVPRO_FAKE_GH_HEAD: head,
    DEVPRO_FAKE_GH_COMMENTS_FILE: commentsFile,
    ...extraEnv,
  };
  if (log) env.DEVPRO_FAKE_GH_LOG = log;
  const result = spawnSync(process.execPath, [cliPath, fixture.packetDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
  let parsed = null;
  try {
    parsed = JSON.parse((result.stdout ?? "").trim().split("\n").pop());
  } catch {
    parsed = null;
  }
  return { result, parsed };
}

function completionReceiptPath(fixture) {
  return path.join(fixture.rootDir, fixture.record.dispatch_id, "completion-receipt.json");
}

function slotPath(fixture) {
  return path.join(fixture.rootDir, fixture.record.dispatch_id, "external-closure.json");
}

test("new external acceptance validates the actual sticky assessment before writing completion", async (t) => {
  for (const variant of ["valid", "missing", "wrong-head", "unresolved", "blank-rationale"]) {
    await t.test(variant, async () => {
      const fixture = await setupFixture({ context: { guarantee_assessment_required: true } });
      const binDir = path.join(fixture.dir, "bin");
      mkdirSync(binDir, { recursive: true }); writeFakeGh(binDir);
      const report = {
        schema: "devpro.review-guarantee-assessment/v1",
        reviewed_target: variant === "wrong-head" ? "b".repeat(40) : HEAD_SHA,
        dispatch_id: fixture.record.dispatch_id,
        assessments: variant === "unresolved" || variant === "blank-rationale" ? [{
          finding_id: "F1", guarantee_ceiling: "Cooperative review",
          classification: variant === "unresolved" ? "unresolved" : "within-ceiling",
          rationale: variant === "blank-rationale" ? "" : "Need to clarify the promised scope.",
        }] : [],
      };
      const reason = variant === "missing" ? "Looks good."
        : "Looks good.\n\n## Guarantee Assessment\n```json\n" + JSON.stringify(report) + "\n```";
      try {
        const { result, parsed } = runCli(fixture, { binDir, comments: [stickyComment({ reason })] });
        if (variant === "valid") {
          assert.equal(result.status, 0, result.stderr);
          assert.equal(parsed.status, "accepted");
          assert.equal(existsSync(completionReceiptPath(fixture)), true);
        } else {
          assert.notEqual(result.status, 0);
          assert.equal(parsed.classification, "external_guarantee_assessment_invalid");
          assert.equal(existsSync(slotPath(fixture)), false);
          assert.equal(existsSync(completionReceiptPath(fixture)), false);
        }
      } finally { cleanupFixture(fixture); }
    });
  }
});

test("accept-external-second-review accepts a fresh create-disposition ticket and writes the fourth completion form", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [stickyComment({ verdict: "PASS" })],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsed.status, "accepted");
    assert.equal(existsSync(slotPath(fixture)), true);
    const slot = JSON.parse(readFileSync(slotPath(fixture), "utf8"));
    assert.equal(slot.kind, "accepted");
    const receipt = JSON.parse(readFileSync(completionReceiptPath(fixture), "utf8"));
    assert.equal(receipt.outcome, "external_evaluator_sticky_accepted");
    assert.equal(receipt.classification, "external_evaluator_accepted");
    assert.equal(receipt.process_close_observed, false);
    assert.equal(receipt.sticky_verdict, "PASS");
    assert.equal(receipt.sticky_comment_id, 5001);
    assert.equal(
      receipt.sticky_comment_url,
      `https://github.com/${REPO_SLUG}/pull/1658#issuecomment-5001`
    );
  } finally {
    cleanupFixture(fixture);
  }
});

// r4-01: the ticket asks for the Sticky Comment Write Contract shape -- review heading
// plus Markdown six-axis/security results after reason: and before the footer. Prove
// that shape (bullets, indented prose, a code span) accepts end to end.
test("accept-external-second-review accepts a sticky with the review heading and Markdown six-axis results after reason: (r4-01)", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [
        stickyComment({
          bodyOverride: [
            "<!-- cross-model-second-opinion:sticky -->",
            "verdict: WARN",
            `last_reviewed_sha: ${HEAD_SHA}`,
            "dispatch_id: dispatch-1658-external",
            "reason: One Important finding in the accept helper routing; see results below.",
            "",
            "## Cross-Model Second Opinion Review",
            "",
            "### 軸 1 正確性",
            "- [Important] `accept-external-second-review.mjs` routes an early update accept as a collision. carrier_class: rule",
            "  Follow-up: document the wait-then-rerun branch.",
            "",
            "### Security",
            "- No findings.",
            "",
            "Rules: v1.0.0 · Tool: Gemini CLI · Model: gemini-2.5-pro",
          ].join("\n"),
        }),
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsed.status, "accepted");
  } finally {
    cleanupFixture(fixture);
  }
});

test("same-family fallback sticky must lead with the renderer-issued disclosure", async () => {
  const disclosure = "same-family fallback: codex and claude CLIs are rate limited";
  const fixture = await setupFixture({ context: { same_family_disclosure: disclosure } });
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const withoutLead = runCli(fixture, {
      binDir,
      comments: [stickyComment({ dispatchId: fixture.record.dispatch_id, reason: "Looks good." })],
    });
    assert.equal(withoutLead.result.status, 1);
    assert.match(JSON.stringify(withoutLead.parsed ?? {}), /external_sticky_contract_invalid/);

    const withLead = runCli(fixture, {
      binDir,
      comments: [stickyComment({ dispatchId: fixture.record.dispatch_id, reason: `${disclosure} — no findings in scope.` })],
    });
    assert.equal(withLead.result.status, 0, `${withLead.result.stderr}\n${withLead.result.stdout}`);
    assert.equal(withLead.parsed.status, "accepted");
  } finally {
    cleanupFixture(fixture);
  }
});

for (const verdict of ["PASS", "WARN", "CRITICAL", "UNAVAILABLE"]) {
  test(`accept-external-second-review accepts and records a ${verdict} verdict receipt`, async () => {
    const fixture = await setupFixture({
      record: { dispatch_id: `dispatch-verdict-${verdict}`, attempt_id: `attempt-verdict-${verdict}` },
    });
    const binDir = path.join(fixture.dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeGh(binDir);
    try {
      const { result, parsed } = runCli(fixture, {
        binDir,
        comments: [stickyComment({ verdict, dispatchId: fixture.record.dispatch_id })],
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(parsed.status, "accepted");
      const receipt = JSON.parse(readFileSync(completionReceiptPath(fixture), "utf8"));
      assert.equal(receipt.sticky_verdict, verdict);
    } finally {
      cleanupFixture(fixture);
    }
  });
}

test("accept-external-second-review is idempotent (already_accepted) on a second run with no further gh calls", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  const log = path.join(fixture.dir, "gh.log");
  try {
    const first = runCli(fixture, { binDir, comments: [stickyComment()], log });
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(first.parsed.status, "accepted");
    const firstReceipt = readFileSync(completionReceiptPath(fixture), "utf8");
    const firstLogLines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
    assert.ok(firstLogLines > 0, "fresh accept must perform at least one live gh call");

    const second = runCli(fixture, { binDir, comments: [stickyComment()], log });
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.equal(second.parsed.status, "already_accepted");
    const secondReceipt = readFileSync(completionReceiptPath(fixture), "utf8");
    assert.equal(secondReceipt, firstReceipt);
    const secondLogLines = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    assert.equal(secondLogLines, firstLogLines, "already_accepted must not perform any further gh calls");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review resumes a slot-only crash purely from receipt_payload, with no live re-read", async () => {
  const fixture = await setupFixture();
  const { writeExternalClosureSlot } = await loadControlEvidence();
  const plantedPayload = {
    schema: "devpro-second-review-completion/v2",
    repository_slug: fixture.record.repository_slug,
    pr_number: fixture.record.pr_number,
    head_ref_oid: fixture.record.head_ref_oid,
    attempt_id: fixture.record.attempt_id,
    dispatch_id: fixture.record.dispatch_id,
    previous_dispatch_id: fixture.record.previous_dispatch_id,
    sticky_verdict: "WARN",
    sticky_last_reviewed_sha: fixture.record.head_ref_oid,
    sticky_dispatch_id: fixture.record.dispatch_id,
    sticky_comment_id: 9001,
    sticky_comment_url: `https://github.com/${REPO_SLUG}/pull/1658#issuecomment-9001`,
    sticky_body_sha256: sha256("planted-slot-only receipt body"),
  };
  // Simulate a prior run that published the slot (D4 step 5) but crashed
  // before writing the completion receipt (D4 step 7).
  await writeExternalClosureSlot({
    rootDir: fixture.rootDir,
    dispatchId: fixture.record.dispatch_id,
    kind: "accepted",
    receiptPayload: plantedPayload,
  });
  assert.equal(existsSync(completionReceiptPath(fixture)), false);

  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  const log = path.join(fixture.dir, "gh.log");
  try {
    // The stub, if called at all, would report a DIFFERENT sticky (verdict
    // CRITICAL, different comment id) than what was planted in the slot.
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [stickyComment({ id: 4242, verdict: "CRITICAL" })],
      log,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsed.status, "accepted");
    assert.equal(existsSync(log), false, "resume-from-slot must not perform any live gh call");
    const receipt = JSON.parse(readFileSync(completionReceiptPath(fixture), "utf8"));
    assert.equal(receipt.sticky_verdict, "WARN");
    assert.equal(receipt.sticky_comment_id, 9001);
    assert.equal(receipt.sticky_body_sha256, plantedPayload.sticky_body_sha256);
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review fails closed on a tampered completion receipt instead of reporting already_accepted", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const first = runCli(fixture, { binDir, comments: [stickyComment({ verdict: "PASS" })] });
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(first.parsed.status, "accepted");

    // Tamper the published receipt's verdict in place (still a byte-valid
    // receipt with a self-consistent integrity_id) so a mere-presence check
    // would wrongly call this already_accepted.
    const receiptPath = completionReceiptPath(fixture);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.sticky_verdict = "CRITICAL";
    const { integrity_id: _drop, ...withoutIntegrity } = receipt;
    receipt.integrity_id = sha256(JSON.stringify(withoutIntegrity));
    // Canonical evidence bytes are `${JSON.stringify(record)}\n` (a trailing
    // newline) — write the same shape the control-evidence library itself
    // publishes so this exercises the receipt-vs-slot bytes comparison, not
    // an incidental canonical-bytes-format mismatch.
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);

    const second = runCli(fixture, { binDir, comments: [stickyComment({ verdict: "PASS" })] });
    assert.equal(second.result.status, 1);
    assert.equal(second.parsed.classification, "reviewer_dispatch_identity_collision");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects a forged sticky dispatch_id as reviewer_dispatch_identity_collision", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [stickyComment({ dispatchId: "dispatch-forged" })],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "reviewer_dispatch_identity_collision");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects an unparseable closure slot as external_closure_incomplete with no live gh call", async () => {
  const fixture = await setupFixture();
  const dispatchDir = path.dirname(slotPath(fixture));
  mkdirSync(dispatchDir, { recursive: true });
  writeFileSync(slotPath(fixture), "{not json");
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  const log = path.join(fixture.dir, "gh.log");
  try {
    const { result, parsed } = runCli(fixture, { binDir, comments: [stickyComment()], log });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_closure_incomplete");
    assert.equal(existsSync(log), false, "a corrupt slot must not trigger a live gh call");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects a gh failure during the live re-read as external_ticket_live_read_failed", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [stickyComment()],
      extraEnv: { DEVPRO_FAKE_GH_EXIT: "1" },
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_ticket_live_read_failed");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects a voided dispatch as external_dispatch_closed", async () => {
  const fixture = await setupFixture();
  const { writeExternalClosureSlot } = await loadControlEvidence();
  await writeExternalClosureSlot({
    rootDir: fixture.rootDir,
    dispatchId: fixture.record.dispatch_id,
    kind: "voided",
  });
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, { binDir, comments: [stickyComment()] });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_dispatch_closed");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects a non-external dispatch record as reviewer_dispatch_identity_collision", async () => {
  const runnerRecord = runnerDispatchRecord();
  // Build the fixture around the runner-shaped record: the context still
  // names the correct dispatch_id/repo/PR/head, but the persisted record has
  // no executor_kind at all.
  const dir = makeTempDir("accept-external-second-review-");
  try {
    const rootDir = path.join(dir, "control-evidence");
    const packetDir = path.join(dir, "packet");
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(packetDir, { recursive: true });
    const contextPath = path.join(packetDir, "observability-context.json");
    const record = { ...runnerRecord, carrier_root_id: sha256(packetDir) };
    const { reserveDispatchRecord } = await loadControlEvidence();
    await reserveDispatchRecord({ rootDir, record });
    const context = {
      dispatch_id: record.dispatch_id,
      attempt_id: record.attempt_id,
      repository_slug: record.repository_slug,
      pr_number: record.pr_number,
      head_ref_oid: record.head_ref_oid,
      observability_context_path: contextPath,
      control_evidence_root: rootDir,
      sticky_write_disposition: { action: "create", snapshot_digest: null },
    };
    writeFileSync(contextPath, `${JSON.stringify(context)}\n`);
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeGh(binDir);
    const result = spawnSync(process.execPath, [cliPath, packetDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    const parsed = JSON.parse((result.stdout ?? "").trim());
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "reviewer_dispatch_identity_collision");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const identityDriftCases = [
  ["head_ref_oid", "f".repeat(40)],
  ["dispatch_id", "dispatch-wrong"],
  ["attempt_id", "attempt-wrong"],
  ["repository_slug", "devpro/other"],
  ["pr_number", "9999"],
];

for (const [field, badValue] of identityDriftCases) {
  test(`accept-external-second-review rejects a context/${field} drift as reviewer_dispatch_identity_collision`, async () => {
    const fixture = await setupFixture({ context: { [field]: badValue } });
    const binDir = path.join(fixture.dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeGh(binDir);
    try {
      const { result, parsed } = runCli(fixture, { binDir, comments: [stickyComment()] });
      assert.equal(result.status, 1);
      assert.equal(parsed.classification, "reviewer_dispatch_identity_collision");
    } finally {
      cleanupFixture(fixture);
    }
  });
}

// F-12: carrier_root_id is recomputed from the resolved packet-dir CLI
// argument itself, mirroring voidExternalDispatch's own derivation (T5/D5) —
// observability_context_path in the context file is no longer trusted for
// this purpose at all (a stale/foreign value in that field is therefore no
// longer a distinct collision cause; see EXT-ACCEPT-F12-1 below for the
// scenario this actually guards against: the packet-dir itself being
// copied/relocated after the renderer wrote it).
test("accept-external-second-review ignores a stale observability_context_path once carrier_root_id is recomputed from the real packet-dir", async () => {
  const fixture = await setupFixture({
    context: { observability_context_path: "/tmp/some-other-dir/observability-context.json" },
  });
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, { binDir, comments: [stickyComment({ verdict: "PASS" })] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsed.status, "accepted");
  } finally {
    cleanupFixture(fixture);
  }
});

test("EXT-ACCEPT-F12-1: accept-external-second-review rejects a copied/relocated packet-dir as reviewer_dispatch_identity_collision", async () => {
  const fixture = await setupFixture();
  const copiedPacketDir = path.join(fixture.dir, "packet-copy");
  mkdirSync(copiedPacketDir, { recursive: true });
  // The context file's own contents (including its stale
  // observability_context_path) are copied verbatim, exactly as a plain
  // filesystem copy/move of the packet-dir would carry them.
  writeFileSync(
    path.join(copiedPacketDir, "observability-context.json"),
    readFileSync(path.join(fixture.packetDir, "observability-context.json"), "utf8")
  );
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  const commentsFile = path.join(fixture.dir, "copy-comments.json");
  writeFileSync(commentsFile, JSON.stringify([stickyComment()]));
  const log = path.join(fixture.dir, "gh.log");
  try {
    const result = spawnSync(process.execPath, [cliPath, copiedPacketDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DEVPRO_FAKE_GH_HEAD: HEAD_SHA,
        DEVPRO_FAKE_GH_COMMENTS_FILE: commentsFile,
        DEVPRO_FAKE_GH_LOG: log,
      },
    });
    const parsed = JSON.parse((result.stdout ?? "").trim());
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "reviewer_dispatch_identity_collision");
    assert.equal(existsSync(log), false, "a copied packet-dir must be rejected before any live gh call");
  } finally {
    cleanupFixture(fixture);
  }
});

test("EXT-ACCEPT-F12-2: accept-external-second-review rejects a missing control_evidence_root as reviewer_dispatch_identity_collision", async () => {
  const fixture = await setupFixture({ context: { control_evidence_root: undefined } });
  // JSON.stringify drops an `undefined` value entirely, matching a context
  // file that never carried the field.
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  const log = path.join(fixture.dir, "gh.log");
  try {
    const { result, parsed } = runCli(fixture, { binDir, comments: [stickyComment()], log });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "reviewer_dispatch_identity_collision");
    assert.equal(existsSync(log), false, "a missing control_evidence_root must be rejected before any live gh call");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects a sticky_write_disposition drift as reviewer_dispatch_identity_collision", async () => {
  const fixture = await setupFixture({
    context: { sticky_write_disposition: { action: "update", target: { id: 42 }, snapshot_digest: "c".repeat(64) } },
  });
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, { binDir, comments: [stickyComment()] });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "reviewer_dispatch_identity_collision");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects a moved PR head as external_head_moved", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      head: "d".repeat(40),
      comments: [stickyComment()],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_head_moved");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects a sticky last_reviewed_sha that lags the live head as external_head_moved", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [stickyComment({ lastReviewedSha: "e".repeat(40) })],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_head_moved");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects zero sticky candidates as external_sticky_ambiguous", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, { binDir, comments: [] });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_sticky_ambiguous");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects two sticky candidates as external_sticky_ambiguous", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [stickyComment({ id: 1 }), stickyComment({ id: 2 })],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_sticky_ambiguous");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects a footer Tool mismatch as external_sticky_provenance_mismatch", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [stickyComment({ reviewerTool: "Codex" })],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_sticky_provenance_mismatch");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review rejects a footer Model mismatch as external_sticky_provenance_mismatch", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [stickyComment({ reviewerModel: "claude-opus-4" })],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_sticky_provenance_mismatch");
  } finally {
    cleanupFixture(fixture);
  }
});

// F-08: external_sticky_contract_invalid — the Tool/Model provenance footer
// itself is fine (so this is NOT external_sticky_provenance_mismatch), but a
// reserved machine field the sticky-authority contract requires is missing.
test("accept-external-second-review rejects a sticky body missing a reserved machine field as external_sticky_contract_invalid", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [
        stickyComment({
          // No `reason:` line at all — Tool/Model still match the dispatch,
          // so parseSecondReviewStickyAuthorityBody's contract_errors carries
          // only sticky_reason_missing, never sticky_reviewer_tool_mismatch.
          bodyOverride: [
            "<!-- cross-model-second-opinion:sticky -->",
            "verdict: PASS",
            `last_reviewed_sha: ${HEAD_SHA}`,
            "dispatch_id: dispatch-1658-external",
            "Rules: v1.0.0 · Tool: Gemini CLI · Model: gemini-2.5-pro",
          ].join("\n"),
        }),
      ],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_sticky_contract_invalid");
  } finally {
    cleanupFixture(fixture);
  }
});

// r2-01: the external ticket's old "### Sticky Body Format" wording ("MUST end with
// exactly this footer block") described marker+fields+footer as a trailing unit, which
// an evaluator could read as license to write its own summary heading before that block.
// parseSecondReviewStickyAuthorityBody requires the canonical marker on the body's FIRST
// physical line (sticky_marker_not_first_line otherwise), so that summary-before-marker
// body always failed accept — this proves the fixed ticket text (marker MUST be the very
// first physical line) is load-bearing, not merely cosmetic.
test("accept-external-second-review rejects a sticky body with prose before the marker as external_sticky_contract_invalid (r2-01)", async () => {
  const fixture = await setupFixture();
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [
        stickyComment({
          bodyOverride: [
            "## Cross-model review",
            "Summary of findings before the sticky marker.",
            "",
            "<!-- cross-model-second-opinion:sticky -->",
            "verdict: PASS",
            `last_reviewed_sha: ${HEAD_SHA}`,
            "dispatch_id: dispatch-1658-external",
            "reason: Looks good.",
            "Rules: v1.0.0 · Tool: Gemini CLI · Model: gemini-2.5-pro",
          ].join("\n"),
        }),
      ],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_sticky_contract_invalid");
  } finally {
    cleanupFixture(fixture);
  }
});

// r3-03: the parser counts `Rules:`/`Tool:`/`Model:` anywhere in the body, so a reason
// that quotes one (natural when reviewing a provenance-footer PR) fails accept. This is
// why the ticket's reserved_literal_rule exists; the rejection itself stays fail-closed.
for (const literal of ["Tool:", "Rules:", "Model:"]) {
  test(`accept-external-second-review rejects a reason quoting the reserved literal ${literal} as external_sticky_contract_invalid (r3-03)`, async () => {
    const fixture = await setupFixture();
    const binDir = path.join(fixture.dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFakeGh(binDir);
    try {
      const { result, parsed } = runCli(fixture, {
        binDir,
        comments: [stickyComment({ reason: `footer check still reads ${literal} from the last line.` })],
      });
      assert.equal(result.status, 1);
      assert.equal(parsed.classification, "external_sticky_contract_invalid");
    } finally {
      cleanupFixture(fixture);
    }
  });
}

test("accept-external-second-review binds an update disposition to its target comment id", async () => {
  const fixture = await setupFixture({
    record: {
      dispatch_id: "dispatch-update-id-mismatch",
      attempt_id: "attempt-update-id-mismatch",
      sticky_write_action: "update",
      sticky_target_comment_id: 7000,
    },
  });
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      // Sticky exists, but at a different comment id than the dispatched target.
      comments: [stickyComment({ id: 7001, dispatchId: fixture.record.dispatch_id })],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_sticky_disposition_unbound");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review binds an update disposition to updated_at not earlier than issued_at", async () => {
  const fixture = await setupFixture({
    record: {
      dispatch_id: "dispatch-update-stale",
      attempt_id: "attempt-update-stale",
      sticky_write_action: "update",
      sticky_target_comment_id: 7000,
      issued_at: "2026-01-05T00:00:00.000Z",
    },
  });
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [
        stickyComment({
          id: 7000,
          dispatchId: fixture.record.dispatch_id,
          updatedAt: "2026-01-01T00:00:00Z",
        }),
      ],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_sticky_disposition_unbound");
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review accepts an update disposition bound to its target and freshness", async () => {
  const fixture = await setupFixture({
    record: {
      dispatch_id: "dispatch-update-ok",
      attempt_id: "attempt-update-ok",
      sticky_write_action: "update",
      sticky_target_comment_id: 7000,
      issued_at: "2026-01-01T00:00:00.000Z",
    },
  });
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [
        stickyComment({
          id: 7000,
          dispatchId: fixture.record.dispatch_id,
          updatedAt: "2026-01-02T00:00:00Z",
        }),
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsed.status, "accepted");
    const receipt = JSON.parse(readFileSync(completionReceiptPath(fixture), "utf8"));
    assert.equal(receipt.sticky_comment_id, 7000);
  } finally {
    cleanupFixture(fixture);
  }
});

test("accept-external-second-review binds a create disposition to created_at not earlier than issued_at", async () => {
  const fixture = await setupFixture({
    record: {
      dispatch_id: "dispatch-create-stale",
      attempt_id: "attempt-create-stale",
      issued_at: "2026-01-05T00:00:00.000Z",
    },
  });
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);
  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [
        stickyComment({
          dispatchId: fixture.record.dispatch_id,
          createdAt: "2026-01-01T00:00:00Z",
        }),
      ],
    });
    assert.equal(result.status, 1);
    assert.equal(parsed.classification, "external_sticky_disposition_unbound");
  } finally {
    cleanupFixture(fixture);
  }
});

test("PRIM-F3: accept-external rejects isolated synth literal when sidecar material has Pwd= shape", async () => {
  const SYNTH = "SYNTH_PWD_TEST_ONLY_9f3a";
  const fixture = await setupFixture({
    record: {
      dispatch_id: "dispatch-cred-literal",
      attempt_id: "attempt-cred-literal",
    },
  });
  const binDir = path.join(fixture.dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFakeGh(binDir);

  const sidecarPayload = {
    schema: "devpro-second-review-sticky-credential-gate-sidecar/v1",
    disposition: "create",
    repository_slug: REPO_SLUG,
    pr_number: 1658,
    dispatch_id: fixture.record.dispatch_id,
    body_file: "cross-model-second-opinion.md",
    materialTexts: [`Pwd=${SYNTH}`],
    explicitDenyList: [],
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(sidecarPayload), "utf8")
    .digest("hex");
  writeFileSync(
    path.join(fixture.packetDir, "sticky-credential-gate-sidecar.json"),
    `${JSON.stringify({ ...sidecarPayload, digest })}\n`,
  );

  try {
    const { result, parsed } = runCli(fixture, {
      binDir,
      comments: [
        stickyComment({
          dispatchId: fixture.record.dispatch_id,
          // Body is only the secret literal — no Pwd= shape in the sticky itself.
          reason: SYNTH,
        }),
      ],
    });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(parsed.classification, "sticky_credential_literal_detected");
  } finally {
    cleanupFixture(fixture);
  }
});
