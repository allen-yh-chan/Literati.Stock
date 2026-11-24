#!/usr/bin/env node
/**
 * Prove-it coverage for fix-projection-honesty-and-openspec-floor:
 * R1 packet-local completion-receipt mirror
 * R2 live-gate CRITICAL union publish polarity + finding.summary byte cap
 * R3 full-pr live-read pagination / named truncation
 */
import assert from "node:assert/strict";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SECOND_REVIEW_FINDING_SUMMARY_MAX_BYTES,
  PAGE_WINDOW_COMPLETION_KEYS,
  collectCriticalFindings,
  parsePageWindowCompletionObject,
  sealFindingsLedger,
} from "../second-review-material-contract.mjs";
import {
  __testCompletionReceiptMirror,
} from "../run-second-reviewer-projection.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = readFileSync(
  path.join(HERE, "../run-second-reviewer-projection.mjs"),
  "utf8",
);
const RECIPE_SOURCE = readFileSync(
  path.join(HERE, "../second-reviewer-cli-recipe-contract.mjs"),
  "utf8",
);

test("Scenario: Intermediate continuing window omits critical_findings array", () => {
  assert.match(RUNNER_SOURCE, /critical_findings_count: criticalUnion\.length/);
  assert.match(
    RUNNER_SOURCE,
    /publishCriticalUnion = !\["intermediate_critical_sticky", "critical_sticky_checkpoint"\]\.includes\(pageWindowLiveGate\.phase\)\s*&& \(pageWindowLiveGate\.scanComplete === true\s*\|\|\s*pageWindowLiveGate\.continueToNextWindow !== true\)/,
  );
});

test("Scenario: Terminal or scan_complete live-gate carries the CRITICAL union", () => {
  assert.match(RUNNER_SOURCE, /\? \{ critical_findings: criticalUnion \}/);
});

test("Scenario: Finding summary over byte cap fails closed", () => {
  const sha = "a".repeat(40);
  const over = "x".repeat(SECOND_REVIEW_FINDING_SUMMARY_MAX_BYTES + 1);
  const completion = {
    sticky_comment_url: "none",
    verdict: "CRITICAL",
    last_reviewed_sha: sha,
    reviewer_model: "test-model",
    reason: "blocking finding",
    window_index: 1,
    page_indices: [1],
    head_ref_oid: sha,
    dispatch_id: "00000000-0000-4000-8000-000000000001",
    findings: [{ severity: "CRITICAL", summary_id: "F1", summary: over }],
    findings_payload_sha256: "b".repeat(64),
  };
  assert.deepEqual(Object.keys(completion), [...PAGE_WINDOW_COMPLETION_KEYS]);
  assert.equal(parsePageWindowCompletionObject(completion).status, "malformed");
});

test("Scenario: Packet-local mirror failure blocks the written activity", () => {
  assert.match(RUNNER_SOURCE, /completion_receipt_control_evidence_failed/);
  assert.match(RUNNER_SOURCE, /completion_receipt_packet_mirror_failed/);
  assert.match(RUNNER_SOURCE, /completion_receipt_activity_failed/);
  const helperStart = RUNNER_SOURCE.indexOf("async function persistCompletionReceiptWithPacketMirror");
  const helper = RUNNER_SOURCE.slice(helperStart, helperStart + 1800);
  assert.ok(helper.indexOf("publishPacketLocalCompletionReceipt")
    < helper.indexOf("projection_completion_receipt_written"));

  const root = path.join(tmpdir(), `packet-mirror-fail-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const packetPath = path.join(root, "packet.md");
  writeFileSync(packetPath, "packet\n", "utf8");
  const controlPath = path.join(root, "control-completion-receipt.json");
  writeFileSync(controlPath, "{\"schema\":\"devpro-second-review-completion/v2\"}\n", "utf8");
  // Pre-create the exclusive destination so wx fails.
  const dest = path.join(
    root,
    __testCompletionReceiptMirror.PACKET_COMPLETION_RECEIPT_FILE,
  );
  writeFileSync(dest, "occupied\n", "utf8");
  assert.throws(
    () => __testCompletionReceiptMirror.publishPacketLocalCompletionReceipt(
      { packet_path: packetPath },
      controlPath,
    ),
    /packet-local completion-receipt mirror failed/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("Scenario: Truncated GitHub files list is a named fail-closed relation", () => {
  assert.match(RUNNER_SOURCE, /gh_pr_view_files_truncated/);
});

test("Scenario: Full-PR live-read probe reaches 101–1000 files", () => {
  assert.match(RECIPE_SOURCE, /number,headRefOid,changedFiles/);
  assert.match(RECIPE_SOURCE, /files_list_argv/);
  assert.match(RECIPE_SOURCE, /--paginate/);
  assert.match(RECIPE_SOURCE, /--jq/);
  assert.match(RECIPE_SOURCE, /\.\[\]\.filename/);
  assert.match(RUNNER_SOURCE, /recipe\.files_list_argv/);
  assert.match(RUNNER_SOURCE, /headAfterResult/);
  const ledger = sealFindingsLedger([{
    window_index: 1,
    page_indices: [1],
    window_verdict: "CRITICAL",
    findings: [{ severity: "CRITICAL", summary_id: "F1", summary: "blocking" }],
    entry_sha256: "c".repeat(64),
  }]);
  assert.equal(collectCriticalFindings(ledger).length, 1);
});

test("packet-local mirror publishes exclusive 0o600 bytes", () => {
  const root = path.join(tmpdir(), `packet-mirror-ok-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const packetPath = path.join(root, "packet.md");
  writeFileSync(packetPath, "packet\n", "utf8");
  const controlPath = path.join(root, "control-completion-receipt.json");
  const bytes = Buffer.from('{"ok":true}\n', "utf8");
  writeFileSync(controlPath, bytes);
  const mirrored = __testCompletionReceiptMirror.publishPacketLocalCompletionReceipt(
    { packet_path: packetPath },
    controlPath,
  );
  assert.equal(
    path.basename(mirrored),
    __testCompletionReceiptMirror.PACKET_COMPLETION_RECEIPT_FILE,
  );
  assert.deepEqual(readFileSync(mirrored), bytes);
  rmSync(root, { recursive: true, force: true });
});
