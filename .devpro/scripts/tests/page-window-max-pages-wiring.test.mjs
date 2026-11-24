/**
 * page-window-max-pages-wiring.test.mjs
 *
 * T7 (D9, R10, R13): page_window_max_pages 1..4 all-callsite wiring prove-it. See
 * openspec/changes/add-external-evaluator-second-review/{tasks.md T7, design.md D9}.
 *
 * (a) grep-anchor: every renderer/validator/runner/contract production callsite of the
 *     windowMaxPages-parameterized contract functions passes an explicit windowMaxPages
 *     (or dispatchedWindowCount) argument — none may rely on the SECOND_REVIEW_PAGE_
 *     WINDOW_MAX_PAGES=1 default parameter.
 * (b) behavior: W=1/2/4 first/continuation/final-window sticky authorization, and the
 *     "resume" window-index reconstruction a restarted process or the validator performs
 *     from pageIndices alone.
 * (c) out-of-range/non-integer page_window_max_pages is a typed rejection.
 * (d) pagination-trigger lower bound: >262,144 bytes at <=32,768 bytes/page produces >=9
 *     pages, and W=4 dispatches >=3 windows for that material.
 *
 * The one property only the full renderer CLI can prove — handoff-to-context wiring
 * itself (declared/undeclared) — lives in render-second-review-packet.test.mjs
 * ("renderer rejects page_window_max_pages...", "renderer wires a declared
 * page_window_max_pages...", "renderer omits page_window_max_pages..."), reusing that
 * file's existing render()/withTempDir() CLI harness rather than duplicating it here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SECOND_REVIEW_EMBEDDED_MAX_BYTES,
  SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES,
  SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES_CEILING,
  emptyCheckpointLedger,
  emptyFindingsLedger,
  framePagedReviewMaterial,
  materialSha256,
  normalizePrStickyReviewMaterialData,
  pageWindowCount,
  pageWindowIndices,
  requiresPageWindowing,
  resolveDeclaredPageWindowMaxPages,
  reviewScopeFingerprintSha256,
  selectActiveWindowPages,
  validatePrStickyReviewMaterialContract,
} from "../second-review-material-contract.mjs";
import {
  PAGE_WINDOW_COMPLETION_RETRY_LIMIT,
  __testReviewerClassification,
  pageWindowCompletionRetry,
  resolveLivePageWindowStickyGate,
} from "../run-second-reviewer-projection.mjs";
import { pageWindowCompletionBindingFromReviewMaterial } from "../validate-second-review-packet.mjs";
import { readSourceFile } from "./lib/read.mjs";

// ---------------------------------------------------------------------------
// (a) grep-anchor: production callsites must pass windowMaxPages/dispatchedWindowCount
// explicitly, never rely on the contract functions' default parameter.
// ---------------------------------------------------------------------------

test("grep-anchor: second-review-material-contract.mjs internal callsites and validatePagedRow use the declared windowMaxPages, not the SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES constant", () => {
  const source = readSourceFile(".devpro/scripts/second-review-material-contract.mjs");
  // selectActiveWindowPages -> pageWindowIndices forwards the caller's windowMaxPages.
  assert.match(source, /pageWindowIndices\(fullPages\.length, windowIndex, windowMaxPages\)/);
  // framePagedReviewMaterial -> pageWindowCount / selectActiveWindowPages forward it too.
  assert.match(source, /pageWindowCount\(manifest\.page_count, windowMaxPages\)/);
  assert.match(source, /selectActiveWindowPages\(fullPages, windowIndex, windowMaxPages\)/);
  // authorizeGateSatisfyingSticky requires an explicit windowMaxPages (no implicit W=1
  // fallback survives) and validates it before touching ledgers.
  assert.match(
    source,
    /export function authorizeGateSatisfyingSticky\(\{\n {2}checkpointLedger,\n {2}findingsLedger,\n {2}pageCount,\n {2}windowMaxPages,\n {2}dispatchedWindowCount = null,\n\}\) \{/,
  );
  assert.match(
    source,
    /if \(!Number\.isSafeInteger\(windowMaxPages\) \|\| windowMaxPages <= 0\) \{\n {4}throw new TypeError\("authorizeGateSatisfyingSticky requires an explicit positive windowMaxPages"\);/,
  );
  assert.match(source, /pageWindowCount\(pageCount, windowMaxPages\)\n {4}: dispatchedWindowCount;/);
  // validatePagedRow: the page-length ceiling and the requiresPageWindowing probes must
  // read the caller's windowMaxPages, never the SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES=1
  // constant directly (that constant only remains as the default *parameter* value).
  assert.match(source, /reviewMaterial\.pages\.length > windowMaxPages\) \{/);
  assert.equal(
    /reviewMaterial\.pages\.length > SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES/.test(source),
    false,
    "validatePagedRow must not compare against the raw constant",
  );
  const requiresPageWindowingCallCount =
    (source.match(/requiresPageWindowing\(manifest\.page_count, windowMaxPages\)/g) ?? []).length;
  assert.equal(requiresPageWindowingCallCount, 2, "both validatePagedRow requiresPageWindowing probes must pass windowMaxPages");
});

test("grep-anchor: render-second-review-packet.mjs resolves once and threads windowMaxPages into every paged callsite", () => {
  const source = readSourceFile(".devpro/scripts/render-second-review-packet.mjs");
  assert.match(source, /const resolvedWindowMaxPages = resolveDeclaredPageWindowMaxPages\(input\.page_window_max_pages\);/);
  assert.match(
    source,
    /normalizePrStickyReviewMaterialData\(sourceData, \{\n {6}materialMaxBytes: SECOND_REVIEW_MATERIAL_MAX_BYTES,\n {6}windowMaxPages: resolvedWindowMaxPages,/,
  );
  const pageWindowCountCallCount =
    (source.match(/pageWindowCount\(data\.review_material\.manifest\.page_count, resolvedWindowMaxPages\)/g) ?? []).length;
  assert.equal(pageWindowCountCallCount, 2, "both paged branches (carrier-relocated and renderer-paged-snapshot) must pass resolvedWindowMaxPages");
  // The packet-owned completion suffix must bind the actual active window, not the
  // window-1/page-1 default (a declared W>1 first window already spans >1 page).
  assert.match(
    source,
    /secondReviewPacketStaticSuffix\(data\.schema_version, \{\n {6}windowIndex: context\.page_window_index,/,
  );
  // assertValidPacket must accept and forward windowMaxPages; both call sites resolve it
  // from the context that was just built (fresh render, and the CLI main() path).
  assert.match(source, /function assertValidPacket\(packet, windowMaxPages\) \{/);
  assert.match(source, /validateSecondReviewPacketText\(packet, \{ windowMaxPages \}\);/);
  const assertValidPacketCallCount =
    (source.match(/assertValidPacket\([^,]+, resolveDeclaredPageWindowMaxPages\([^)]+\.page_window_max_pages\)\);/g) ?? []).length;
  assert.equal(assertValidPacketCallCount, 2, "both assertValidPacket call sites must resolve windowMaxPages from their context");
});

test("grep-anchor: validate-second-review-packet.mjs never hardcodes windowMaxPages=1 and threads the caller's declared value", () => {
  const source = readSourceFile(".devpro/scripts/validate-second-review-packet.mjs");
  assert.equal(
    (source.match(/const windowMaxPages = 1/g) ?? []).length,
    0,
    "T7 acceptance: grep -c \"const windowMaxPages = 1\" validate-second-review-packet.mjs must be 0",
  );
  assert.match(
    source,
    /export function pageWindowCompletionBindingFromReviewMaterial\(reviewMaterial, windowMaxPages\) \{/,
  );
  assert.match(
    source,
    /if \(!Number\.isSafeInteger\(windowMaxPages\) \|\| windowMaxPages <= 0\) \{\n {4}throw new TypeError\("pageWindowCompletionBindingFromReviewMaterial requires an explicit positive windowMaxPages"\);/,
  );
  // validateSecondReviewPacketTextWithData resolves once and threads it to both the
  // review-data material validator and the suffix binding reconstruction.
  assert.match(source, /function validateReviewData\(data, windowMaxPages\) \{/);
  assert.match(source, /errors\.push\(\.\.\.validateReviewData\(data, windowMaxPages\)\);/);
  assert.match(
    source,
    /pageWindowCompletionBindingFromReviewMaterial\(data\?\.review_material, windowMaxPages\)/,
  );
  // authorizeSecondReviewPacketFile and main()'s pre-context structural check both resolve
  // windowMaxPages from a context read (trusted context, or a best-effort sibling peek).
  assert.match(
    source,
    /windowMaxPages: resolveDeclaredPageWindowMaxPages\(context\.page_window_max_pages\),\n {4}\}\);/,
  );
  assert.match(source, /function bestEffortDeclaredWindowMaxPagesForPacket\(packetPath\) \{/);
  assert.match(
    source,
    /windowMaxPages: bestEffortDeclaredWindowMaxPagesForPacket\(packetPath\),/,
  );
});

test("grep-anchor: run-second-reviewer-projection.mjs resolves windowMaxPages from context at every production callsite", () => {
  const source = readSourceFile(".devpro/scripts/run-second-reviewer-projection.mjs");
  const resolveCallCount =
    (source.match(/resolveDeclaredPageWindowMaxPages\(context\.page_window_max_pages\)/g) ?? []).length;
  // parseCanonicalSecondReviewPacketData (blocked-disposition rewrite + reconcile/resume),
  // advancePageWindowLedgers (live gate), pageWindowCompletionBindingFromReviewMaterial
  // (canonicalPageWindowPacket), framePagedReviewMaterial (assertTrustedPageWindowState +
  // advancePageWindowPacketAndContext's local windowMaxPages binding), plus the
  // closure-only legacy reconciler's pinned-manifest window-count check.
  assert.equal(resolveCallCount, 7, "every windowMaxPages callsite must use the shared resolver, including legacy closure");
  assert.match(
    source,
    /export function advancePageWindowLedgers\(\{\n {2}reviewMaterial,\n {2}completion,\n {2}windowMaxPages,\n {2}dispatchedWindowCount = null,\n\}\) \{/,
  );
  assert.match(
    source,
    /if \(!Number\.isSafeInteger\(windowMaxPages\) \|\| windowMaxPages <= 0\) \{\n {4}throw new TypeError\("page-window ledger advance requires an explicit positive windowMaxPages"\);/,
  );
  assert.match(
    source,
    /authorizeGateSatisfyingSticky\(\{\n {8}checkpointLedger,\n {8}findingsLedger,\n {8}pageCount: reviewMaterial\.manifest\.page_count,\n {8}windowMaxPages,\n {8}dispatchedWindowCount,\n {6}\}\)/,
  );
  // dispatchedWindowCount must be read straight off the dispatch's own page_window_count
  // (or null, letting the callee's own windowMaxPages-derived fallback apply) — never an
  // unguarded Number(context.page_window_count) that turns an absent value into NaN.
  assert.match(
    source,
    /dispatchedWindowCount: Number\.isSafeInteger\(context\.page_window_count\)\n {6}\? context\.page_window_count\n {6}: null,/,
  );
  // advancePageWindowPacketAndContext's totalWindows fallback and framePagedReviewMaterial
  // call must both use the resolved windowMaxPages, not an implicit default.
  assert.match(
    source,
    /const windowMaxPages = resolveDeclaredPageWindowMaxPages\(context\.page_window_max_pages\);\n {2}const nextWindowIndex/,
  );
  assert.match(
    source,
    /\|\| pageWindowCount\(reviewData\.review_material\.manifest\.page_count, windowMaxPages\);/,
  );
});

// ---------------------------------------------------------------------------
// (c) typed out-of-range / non-integer rejection at the contract layer functions
// themselves (the handoff-level page_window_max_pages_invalid rejection is proven
// end-to-end via the CLI in render-second-review-packet.test.mjs).
// ---------------------------------------------------------------------------

test("resolveDeclaredPageWindowMaxPages resolves 1..4 as declared, everything else to the unchanged default 1", () => {
  assert.equal(resolveDeclaredPageWindowMaxPages(undefined), 1);
  assert.equal(resolveDeclaredPageWindowMaxPages(1), 1);
  assert.equal(resolveDeclaredPageWindowMaxPages(2), 2);
  assert.equal(resolveDeclaredPageWindowMaxPages(3), 3);
  assert.equal(resolveDeclaredPageWindowMaxPages(4), 4);
  assert.equal(SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES_CEILING, 4);
  for (const outOfRange of [0, 5, 1.5, "2", null, -1, Number.NaN]) {
    assert.equal(resolveDeclaredPageWindowMaxPages(outOfRange), SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES);
  }
});

test("authorizeGateSatisfyingSticky, advancePageWindowLedgers, and pageWindowCompletionBindingFromReviewMaterial fail closed without an explicit positive windowMaxPages", () => {
  const covered = emptyCheckpointLedger();
  assert.throws(
    () => __testReviewerClassification.authorizeGateSatisfyingSticky({
      checkpointLedger: covered,
      findingsLedger: emptyFindingsLedger(),
      pageCount: 1,
    }),
    TypeError,
  );
  assert.throws(
    () => __testReviewerClassification.advancePageWindowLedgers({
      reviewMaterial: { manifest: { page_count: 1 }, pages: [], window_role: "final" },
      completion: { status: "accepted", completion: { window_index: 1, page_indices: [1], verdict: "PASS", findings: [] } },
    }),
    TypeError,
  );
  assert.throws(
    () => pageWindowCompletionBindingFromReviewMaterial({ pages: [{ index: 1, content: "x" }] }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// (b) contract-level W=1/2/4 correctness for the pure windowing primitives.
// ---------------------------------------------------------------------------

test("pageWindowIndices/pageWindowCount/selectActiveWindowPages/framePagedReviewMaterial partition consistently for W=1/2/4", () => {
  const pageCount = 9;
  const fullPages = Array.from({ length: pageCount }, (_, offset) => ({
    index: offset + 1,
    content: `page-${offset + 1}`,
  }));
  const manifest = {
    schema: "devpro-second-review-paged-manifest/v1",
    page_count: pageCount,
    max_page_utf8_bytes: 32_768,
    total_utf8_bytes: fullPages.reduce((sum, page) => sum + Buffer.byteLength(page.content, "utf8"), 0),
    aggregate_sha256: materialSha256(fullPages.map((page) => page.content).join("")),
    scope_fingerprint_sha256: "a".repeat(64),
    head_sha: "b".repeat(40),
    changed_paths_sha256: "c".repeat(64),
    pages: fullPages.map((page) => ({
      index: page.index,
      utf8_bytes: Buffer.byteLength(page.content, "utf8"),
      sha256: materialSha256(page.content),
    })),
  };
  for (const [windowMaxPages, expectedWindowCount] of [[1, 9], [2, 5], [4, 3]]) {
    assert.equal(pageWindowCount(pageCount, windowMaxPages), expectedWindowCount);
    assert.equal(requiresPageWindowing(pageCount, windowMaxPages), expectedWindowCount > 1);
    let coveredIndices = [];
    for (let windowIndex = 1; windowIndex <= expectedWindowCount; windowIndex += 1) {
      const indices = pageWindowIndices(pageCount, windowIndex, windowMaxPages);
      assert.ok(indices.length > 0 && indices.length <= windowMaxPages);
      const framed = framePagedReviewMaterial({ manifest, fullPages, windowIndex, windowMaxPages });
      assert.deepEqual(framed.pages.map((page) => page.index), indices);
      assert.deepEqual(selectActiveWindowPages(fullPages, windowIndex, windowMaxPages), framed.pages);
      assert.equal(framed.window_role, windowIndex === expectedWindowCount ? "final" : "intermediate");
      coveredIndices = coveredIndices.concat(indices);
    }
    assert.deepEqual(coveredIndices, Array.from({ length: pageCount }, (_, offset) => offset + 1));
  }
});

// ---------------------------------------------------------------------------
// (b) resume: reconstructing a mid-sequence window index from pageIndices alone
// requires the caller's declared windowMaxPages — this is exactly what a restarted
// runner process (reconcile) and the validator's independent suffix check must do.
// ---------------------------------------------------------------------------

test("pageWindowCompletionBindingFromReviewMaterial resume: reconstructs the correct window index only when given the dispatch's declared W", () => {
  // W=2, 6 pages: windows are [1,2] [3,4] [5,6]. Window 3's first page is index 5.
  const windowThreeMaterial = { pages: [{ index: 5, content: "p5" }, { index: 6, content: "p6" }] };
  assert.deepEqual(
    pageWindowCompletionBindingFromReviewMaterial(windowThreeMaterial, 2),
    { windowIndex: 3, pageIndices: [5, 6] },
  );
  // The exact bug this task fixes: reconstructing with the undeclared-default W=1 against
  // a W=2 dispatch derives the wrong window (5, not 3) — proving windowMaxPages must be
  // threaded from the dispatch's declared value, not assumed.
  assert.deepEqual(
    pageWindowCompletionBindingFromReviewMaterial(windowThreeMaterial, 1),
    { windowIndex: 5, pageIndices: [5, 6] },
  );
  // First window (page 1) is always window 1 regardless of W — this is the case that let
  // the pre-T7 hardcoded windowMaxPages=1 look correct for every W=1 dispatch.
  const windowOneMaterial = { pages: [{ index: 1, content: "p1" }] };
  for (const windowMaxPages of [1, 2, 4]) {
    assert.deepEqual(
      pageWindowCompletionBindingFromReviewMaterial(windowOneMaterial, windowMaxPages),
      { windowIndex: 1, pageIndices: [1] },
    );
  }
});

// ---------------------------------------------------------------------------
// (b) full first -> continuation -> final window loop authorization via the live gate,
// for W=1/2/4, plus (d) the pagination-trigger lower bound (>262,144 bytes at
// <=32,768 bytes/page produces >=9 pages; W=4 dispatches >=3 windows for that material).
// ---------------------------------------------------------------------------

function largeDiff(bytes) {
  const prefix = "diff --git a/x b/x\n";
  assert.ok(bytes > prefix.length);
  return `${prefix}${"a".repeat(bytes - prefix.length)}`;
}

function canonicalPagedSource(material) {
  const head = "d".repeat(40);
  const reviewScope = { kind: "full-pr", pull_request_number: 4400, head_sha: head };
  return {
    schema_version: "devpro-second-review-data/v4",
    mode: "pr-sticky",
    attempt: "initial",
    dispatch_id: "dispatch-page-window-max-pages-wiring",
    previous_dispatch_id: null,
    primary_family: "claude",
    reviewer_family: "codex",
    target: "PR #4400",
    head_ref_oid: head,
    approval_context: "none",
    approval_resolution: { status: "not-required" },
    review_scope: reviewScope,
    scope_summary: "page-window-max-pages-wiring prove-it",
    changed_files_or_touch_list: ["x"],
    review_material_carrier: "embedded-diff",
    review_material_capability: "scope-bound-embedded-complete-diff-v1",
    review_material_proof: {
      kind: "embedded-complete-diff-v1",
      scope_fingerprint_sha256: reviewScopeFingerprintSha256(reviewScope),
      material_format: "git-unified-diff",
      material_utf8_bytes: Buffer.byteLength(material, "utf8"),
      material_sha256: materialSha256(material),
    },
    review_material: material,
    previous_sticky: "none",
    retry_context: { classification: "none", sticky_verification: "not-needed" },
    linked_issue_context: "none",
    primary_verdict: "none",
    evidence: [
      { kind: "validation", narrative: "n/a" },
      { kind: "test", narrative: "n/a" },
    ],
  };
}

test("pagination trigger: >262,144 bytes at <=32,768 bytes/page produces >=9 pages", () => {
  const material = largeDiff(SECOND_REVIEW_EMBEDDED_MAX_BYTES + 1);
  const errors = validatePrStickyReviewMaterialContract(canonicalPagedSource(material), {
    materialMaxBytes: 2_097_152,
  });
  assert.deepEqual(errors, []);
  const normalized = normalizePrStickyReviewMaterialData(canonicalPagedSource(material));
  assert.ok(
    normalized.review_material.manifest.page_count >= 9,
    `expected >=9 pages, got ${normalized.review_material.manifest.page_count}`,
  );
  for (const page of normalized.__paged_full_pages) {
    assert.ok(Buffer.byteLength(page.content, "utf8") <= 32_768);
  }
});

for (const windowMaxPages of [1, 2, 4]) {
  test(`W=${windowMaxPages}: first/continuation/final window live-gate authorization loop reaches an authorized final sticky`, () => {
    const material = largeDiff(SECOND_REVIEW_EMBEDDED_MAX_BYTES + 1);
    const normalized = normalizePrStickyReviewMaterialData(canonicalPagedSource(material), { windowMaxPages });
    const manifest = normalized.review_material.manifest;
    const fullPages = normalized.__paged_full_pages;
    const totalWindows = pageWindowCount(manifest.page_count, windowMaxPages);
    assert.ok(manifest.page_count >= 9);
    if (windowMaxPages === 4) {
      assert.ok(totalWindows >= 3, `W=4 must dispatch >=3 windows for >=9 pages, got ${totalWindows}`);
    }
    let reviewMaterial = normalized.review_material;
    let windowIndex = 1;
    const context = {
      page_window_checkpoint_handoff: true,
      page_window_max_pages: windowMaxPages,
      page_window_count: totalWindows,
    };
    let lastGate = null;
    let iterations = 0;
    while (iterations <= totalWindows) {
      iterations += 1;
      const completion = {
        status: "accepted",
        completion: {
          window_index: windowIndex,
          page_indices: reviewMaterial.pages.map((page) => page.index),
          verdict: "PASS",
          findings: [],
        },
      };
      const gate = resolveLivePageWindowStickyGate({ context, reviewMaterial, completion });
      lastGate = gate;
      if (reviewMaterial.window_role === "final") break;
      assert.equal(gate.continueToNextWindow, true, `intermediate window ${windowIndex} must continue`);
      assert.equal(gate.stickyAuthorized, false, `intermediate window ${windowIndex} must not authorize sticky`);
      windowIndex += 1;
      reviewMaterial = framePagedReviewMaterial({
        manifest,
        fullPages,
        checkpointLedger: gate.advanced.checkpoint_ledger,
        findingsLedger: gate.advanced.findings_ledger,
        windowIndex,
        windowMaxPages,
      });
    }
    assert.ok(iterations <= totalWindows, "loop must terminate within the declared window count");
    assert.equal(windowIndex, totalWindows, "final iteration must be the last dispatched window");
    assert.equal(
      lastGate.stickyAuthorized,
      true,
      `final window must authorize with dispatchedWindowCount=${totalWindows} (W=${windowMaxPages})`,
    );
    assert.equal(lastGate.classification, "page_window_final_authorized");
  });
}

test("undeclared windowMaxPages at the live gate breaks a W=2 dispatch's final authorization (regression proof for D9 threading)", () => {
  // Same two-window W=2 material the fix threads through; this proves *why* threading
  // context.page_window_max_pages through resolveLivePageWindowStickyGate matters: a
  // context that omits it resolves to the default 1, which expects 4 one-page windows
  // instead of 2 two-page windows and must NOT authorize the correctly-dispatched final.
  const material = largeDiff(SECOND_REVIEW_EMBEDDED_MAX_BYTES + 1);
  const normalized = normalizePrStickyReviewMaterialData(canonicalPagedSource(material), { windowMaxPages: 2 });
  const manifest = normalized.review_material.manifest;
  const fullPages = normalized.__paged_full_pages;
  const totalWindows = pageWindowCount(manifest.page_count, 2);
  assert.ok(totalWindows >= 2);

  function runToFinal(context) {
    let reviewMaterial = normalized.review_material;
    let windowIndex = 1;
    let gate = null;
    for (let iterations = 0; iterations <= totalWindows; iterations += 1) {
      const completion = {
        status: "accepted",
        completion: {
          window_index: windowIndex,
          page_indices: reviewMaterial.pages.map((page) => page.index),
          verdict: "PASS",
          findings: [],
        },
      };
      gate = resolveLivePageWindowStickyGate({ context, reviewMaterial, completion });
      if (reviewMaterial.window_role === "final") return gate;
      windowIndex += 1;
      reviewMaterial = framePagedReviewMaterial({
        manifest,
        fullPages,
        checkpointLedger: gate.advanced.checkpoint_ledger,
        findingsLedger: gate.advanced.findings_ledger,
        windowIndex,
        windowMaxPages: 2,
      });
    }
    throw new Error("loop did not reach a final window");
  }

  const declared = runToFinal({
    page_window_checkpoint_handoff: true,
    page_window_max_pages: 2,
    page_window_count: totalWindows,
  });
  assert.equal(declared.stickyAuthorized, true);

  const undeclared = runToFinal({ page_window_checkpoint_handoff: true });
  assert.equal(
    undeclared.stickyAuthorized,
    false,
    "a live gate context that omits the dispatch's declared W must not authorize the same evidence",
  );
});

// ---------------------------------------------------------------------------
// #3623: a malformed completion payload earns one same-window re-dispatch; a real
// failure never does, and the exhausted reason names the window so the TL can
// re-dispatch that window instead of the whole batch.
// ---------------------------------------------------------------------------

test("page-window completion retry: a completion_invalid gate earns exactly one same-window retry", () => {
  const gate = { phase: "completion_invalid", classification: "reviewer_completion_contract_invalid" };
  const first = pageWindowCompletionRetry({ gate, retriesUsed: 0, runClean: true });
  assert.deepEqual(first, {
    retry: true,
    retriesUsed: 1,
    exhausted: false,
    classification: "reviewer_completion_contract_invalid",
  });
  const second = pageWindowCompletionRetry({ gate, retriesUsed: first.retriesUsed, runClean: true });
  assert.equal(second.retry, false, "the budget is one retry, not an open loop");
  assert.equal(second.exhausted, true);
  assert.equal(second.retriesUsed, PAGE_WINDOW_COMPLETION_RETRY_LIMIT);
  // The gate the loop holds is not mutated by the decision.
  assert.equal(gate.phase, "completion_invalid");
});

test("page-window completion retry: every other gate phase is a real result and is never retried", () => {
  for (const phase of [
    "critical_sticky_checkpoint",
    "intermediate",
    "intermediate_critical_sticky",
    "final",
    "credential_gate_invalid",
    "critical_sticky_checkpoint_failed",
  ]) {
    const decision = pageWindowCompletionRetry({ gate: { phase, classification: `page_window_${phase}` }, retriesUsed: 0, runClean: true });
    assert.equal(decision.retry, false, `${phase} must not be retried`);
    assert.equal(decision.exhausted, false, `${phase} is not an exhausted retry`);
    assert.equal(decision.retriesUsed, 0);
  }
  assert.equal(pageWindowCompletionRetry({ gate: null, retriesUsed: 0 }).retry, false);
});

test("page-window completion retry: the loop wires the helper, resets the budget per window and names the window when exhausted", () => {
  const source = readSourceFile(".devpro/scripts/run-second-reviewer-projection.mjs");
  assert.match(
    source,
    /pageWindowCompletionRetry\(\{\s*\n\s*gate: pageWindowLiveGate,/,
    "the window loop must ask the helper before failing closed"
  );
  assert.match(source, /classification: "page_window_completion_contract_retry_pending"/);
  assert.match(source, /pageWindowPassLimit \+= 1;/, "the retry must be allowed to spawn again");
  assert.equal(
    (source.match(/\n\s*completionRetryUsed = 0;/g) || []).length,
    2,
    "a completed window (intermediate advance and CRITICAL checkpoint) restores the budget"
  );
  assert.match(
    source,
    /window_index=\$\{retryWindowIndex\}; the same window was already retried/,
    "the fail-closed reason must name the window so only that window is re-dispatched"
  );
});

test("page-window completion retry: a run that did not close cleanly is never retried", () => {
  const gate = { phase: "completion_invalid", classification: "reviewer_completion_contract_invalid" };
  for (const runClean of [false, undefined, null]) {
    const decision = pageWindowCompletionRetry({ gate, retriesUsed: 0, runClean });
    assert.equal(decision.retry, false, `runClean=${String(runClean)} must not earn a second spawn`);
    assert.equal(decision.exhausted, false, "an unclean run is its own classification, not an exhausted retry");
    assert.equal(decision.retriesUsed, 0);
  }
});

test("page-window completion retry: only a cleanly closed exit-0 window qualifies", () => {
  const source = readSourceFile(".devpro/scripts/run-second-reviewer-projection.mjs");
  assert.match(
    source,
    /runClean: cliResult\.process_close_observed === true\s*\n\s*&& cliResult\.timed_out !== true\s*\n\s*&& cliResult\.fault_classification === undefined\s*\n\s*&& cliResult\.code === 0,/,
    "the retry must require a cleanly closed exit-0 run, like the OpenCode export evidence gate"
  );
});
