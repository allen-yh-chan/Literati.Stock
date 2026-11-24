// A Critical verdict blocks merging but does not stop material coverage.
import assert from "node:assert/strict";
import test from "node:test";
import {
  collectCriticalFindings,
  emptyCheckpointLedger,
  emptyFindingsLedger,
  materialSha256,
} from "../second-review-material-contract.mjs";
import { resolveLivePageWindowStickyGate } from "../run-second-reviewer-projection.mjs";
import { pageWindowIntermediateStickyDisposition, secondReviewPacketStaticPrefix } from "../validate-second-review-packet.mjs";
const DEFAULT_CONTEXT = Object.freeze({ page_window_checkpoint_handoff: true, mode: "pr-sticky" });

function threePageMaterial(windowRole, pages, ledgers = {}) {
  return {
    manifest: {
      page_count: 3,
      pages: [
        { index: 1, sha256: materialSha256("page-one") },
        { index: 2, sha256: materialSha256("page-two") },
        { index: 3, sha256: materialSha256("page-three") },
      ],
    },
    pages,
    checkpoint_ledger: ledgers.checkpoint_ledger ?? emptyCheckpointLedger(),
    findings_ledger: ledgers.findings_ledger ?? emptyFindingsLedger(),
    window_role: windowRole,
  };
}

function criticalCompletion(windowIndex, summaryId) {
  return {
    status: "blocking-verdict",
    completion: {
      window_index: windowIndex,
      page_indices: [windowIndex],
      verdict: "CRITICAL",
      findings: [{ severity: "CRITICAL", summary_id: summaryId, summary: `blocking ${summaryId}` }],
    },
  };
}

function passCompletion(windowIndex) {
  return {
    status: "accepted",
    completion: { window_index: windowIndex, page_indices: [windowIndex], verdict: "PASS", findings: [] },
  };
}

function unavailableCompletion(windowIndex) {
  return {
    status: "blocking-verdict",
    completion: { window_index: windowIndex, page_indices: [windowIndex], verdict: "UNAVAILABLE", findings: [] },
  };
}

const PAGE_CONTENT = { 1: "page-one", 2: "page-two", 3: "page-three" };

function gateAt(context, windowIndex, completion, previous = null) {
  const windowRole = windowIndex === 3 ? "final" : "intermediate";
  return resolveLivePageWindowStickyGate({
    context,
    reviewMaterial: threePageMaterial(
      windowRole,
      [{ index: windowIndex, content: PAGE_CONTENT[windowIndex] }],
      previous?.advanced ?? {},
    ),
    completion,
  });
}

test("Critical is recorded and every remaining window is reviewed without a flag", () => {
  const first = gateAt(DEFAULT_CONTEXT, 1, criticalCompletion(1, "first"));
  assert.equal(first.continueToNextWindow, true);
  assert.equal(first.phase, "intermediate");
  assert.equal(first.stickyAuthorized, false);
  const second = gateAt(DEFAULT_CONTEXT, 2, criticalCompletion(2, "second"), first);
  assert.equal(second.continueToNextWindow, true);
  const final = gateAt(DEFAULT_CONTEXT, 3, passCompletion(3), second);
  assert.equal(final.scanComplete, true);
  assert.equal(final.stickyAuthorized, true);
  assert.equal(final.classification, "page_window_final_critical_sticky_authorized");
  assert.deepEqual(collectCriticalFindings(final.advanced.findings_ledger).map(f => f.summary_id), ["first", "second"]);
});

test("Critical invalidates a prior passing sticky before the next window", () => {
  for (const verdict of ["PASS", "WARN"]) {
    const gate = resolveLivePageWindowStickyGate({
      context: DEFAULT_CONTEXT,
      reviewMaterial: threePageMaterial("intermediate", [{ index: 1, content: PAGE_CONTENT[1] }]),
      completion: criticalCompletion(1, "first"),
      priorGateSatisfyingSticky: { verdict },
    });
    assert.equal(gate.phase, "intermediate_critical_sticky");
    assert.equal(gate.stickyAuthorized, true);
    assert.equal(gate.continueToNextWindow, false, "write/read-back checkpoint precedes continuation");
  }
});

test("clean scan authorizes its formal sticky in the same attempt", () => {
  const first = gateAt(DEFAULT_CONTEXT, 1, passCompletion(1));
  const second = gateAt(DEFAULT_CONTEXT, 2, passCompletion(2), first);
  const final = gateAt(DEFAULT_CONTEXT, 3, passCompletion(3), second);
  assert.equal(final.scanComplete, true);
  assert.equal(final.stickyAuthorized, true);
  assert.equal(final.classification, "page_window_final_authorized");
});

test("UNAVAILABLE preserves the partial Critical list without claiming a complete scan", () => {
  const first = gateAt(DEFAULT_CONTEXT, 1, criticalCompletion(1, "first"));
  for (const index of [2, 3]) {
    const previous = index === 3 ? gateAt(DEFAULT_CONTEXT, 2, passCompletion(2), first) : first;
    const stop = gateAt(DEFAULT_CONTEXT, index, unavailableCompletion(index), previous);
    assert.equal(stop.continueToNextWindow, false);
    assert.equal(stop.stickyAuthorized, false);
    assert.equal(stop.scanComplete, false);
    assert.deepEqual(collectCriticalFindings(stop.advanced.findings_ledger).map(f => f.summary_id), ["first"]);
  }
});

test("an invalid completion retains previously recorded Critical evidence", () => {
  const first = gateAt(DEFAULT_CONTEXT, 1, criticalCompletion(1, "first"));
  const stopped = gateAt(DEFAULT_CONTEXT, 2, { status: "missing" }, first);
  assert.equal(stopped.continueToNextWindow, false);
  assert.equal(stopped.scanComplete, false);
  assert.deepEqual(collectCriticalFindings(stopped.advanced.findings_ledger).map(f => f.summary_id), ["first"]);
});

test("a failed write checkpoint cannot append duplicate coverage or continue", () => {
  const first = gateAt(DEFAULT_CONTEXT, 1, criticalCompletion(1, "first"));
  const stopped = gateAt({ ...DEFAULT_CONTEXT, page_window_critical_sticky_checkpoint: true }, 1, passCompletion(1), first);
  assert.equal(stopped.classification, "reviewer_completion_contract_invalid");
  assert.equal(stopped.continueToNextWindow, false);
  assert.equal(stopped.advanced.findings_ledger.windows.length, 1);
});

test("both reviewer families receive continuation duties and the bound Critical write checkpoint", () => {
  const authorized = {
    schema: "devpro-second-review-sticky-write-disposition/v1",
    action: "create", repository_slug: "devpro/example", pr_number: 1,
    dispatch_id: "scan-contract", candidate_count: 0, snapshot_digest: "none",
  };
  for (const tool of ["Claude Code", "Codex CLI"]) {
    const prefix = (disposition, options = {}) => secondReviewPacketStaticPrefix(tool, "pr-sticky", "scan-contract", disposition, "devpro-second-review-data/v5", { pageWindowCheckpointHandoff: true, ...options });
    const ordinary = prefix(pageWindowIntermediateStickyDisposition(authorized));
    assert.match(ordinary, /remaining windows MUST still be reviewed/);
    assert.doesNotMatch(ordinary, /sticky_write_exact_recipe:/);
    const checkpoint = prefix(authorized, { criticalStickyCheckpoint: true });
    assert.match(checkpoint, /sticky_write_exact_recipe:/);
    assert.match(checkpoint, /runner will resume the remaining windows/);
    assert.doesNotMatch(checkpoint, /MUST NOT review remaining pages/);
  }
});

test("T4: collectCriticalFindings ignores non-CRITICAL findings and tolerates an empty or malformed ledger", () => {
  assert.deepEqual(collectCriticalFindings(emptyFindingsLedger()), []);
  assert.deepEqual(collectCriticalFindings(null), []);
  assert.deepEqual(collectCriticalFindings({ windows: "not-an-array" }), []);
  const mixed = gateAt(DEFAULT_CONTEXT, 1, {
    status: "blocking-verdict",
    completion: {
      window_index: 1,
      page_indices: [1],
      verdict: "CRITICAL",
      findings: [
        { severity: "WARN", summary_id: "w1-warn", summary: "advisory" },
        { severity: "CRITICAL", summary_id: "w1-critical", summary: "blocking" },
      ],
    },
  });
  assert.deepEqual(
    collectCriticalFindings(mixed.advanced.findings_ledger).map((entry) => entry.summary_id),
    ["w1-critical"],
  );
  // Verdict-only CRITICAL window (legal reviewer output: explicit scope limitation, no structured
  // finding) must still appear in the union as a window-level entry with a null summary_id.
  const verdictOnly = gateAt(DEFAULT_CONTEXT, 2, {
    status: "blocking-verdict",
    completion: { window_index: 2, page_indices: [2], verdict: "CRITICAL", findings: [] },
  }, mixed);
  assert.equal(verdictOnly.continueToNextWindow, true);
  assert.deepEqual(
    collectCriticalFindings(verdictOnly.advanced.findings_ledger).map((entry) => [entry.window_index, entry.summary_id]),
    [[1, "w1-critical"], [2, null]],
  );
});
