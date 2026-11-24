/**
 * second-review-completion-evidence-consumer-grep.test.mjs
 *
 * fix-projection-completion-truncation (R2/R3, design D6) — mechanical proof that the
 * runner-owned `reviewer-completion-evidence.json` carrier is writer-only and
 * non-authoritative: no runtime file under `.devpro/scripts/` (the writer itself
 * excepted) — hooks included — may reference the carrier basename or its schema. The
 * carrier MUST NOT become a classification, sticky, receipt, or gate input, and this
 * guard is what keeps a future consumer from silently appearing.
 *
 * The second test is the F-r1-01 spillover inventory for the generic
 * `reviewer_completion_contract_missing` classification: its only owners inside
 * `.devpro/scripts/` are the runner's generic return, the outcome-group registry, and the
 * two test files pinned below — i.e. nothing outside this change's touch list, and no
 * hand-maintained classification enum on the frozen renderer/validator/ack surfaces.
 *
 * The seven `Scenario:` tests at the bottom are this change's asserting carriers for the
 * ADDED delta scenarios (lint-delta-new-scenario-assertion-coverage): each names its
 * scenario title and pins the registry/runner source that makes it true. The behavioral
 * fixtures for the same scenarios live in run-second-reviewer-projection.test.mjs; these
 * source-level invariants are what survives a refactor of those fixtures.
 *
 * Scanned: every file under `.devpro/scripts/` (or the runtime subset for the carrier
 * guard). Not scanned (documentation surface, intentionally out of scope): agent skills,
 * rule leaves, and spec deltas/canonical specs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const SCRIPTS_DIR = path.join(REPO_ROOT, ".devpro/scripts");
const WRITER_BASENAME = "run-second-reviewer-projection.mjs";
const GUARD_BASENAME = "second-review-completion-evidence-consumer-grep.test.mjs";
const CARRIER_NEEDLES = Object.freeze([
  "reviewer-completion-evidence",
  "devpro-second-review-completion-evidence",
]);
// F-r1-01 spillover inventory (design D3): the generic classification lives in the
// runner's generic missing return, the outcome-group registry, and test evidence only.
// Any additional runtime owner would mean a hand-maintained classification surface
// outside the change's touch list.
const GENERIC_MISSING_CLASSIFICATION = "reviewer_completion_contract_missing";
const EXPECTED_GENERIC_MISSING_OWNERS = Object.freeze([
  ".devpro/scripts/hooks/lib/second-review-control-evidence.mjs",
  ".devpro/scripts/run-second-reviewer-projection.mjs",
  ".devpro/scripts/tests/run-second-reviewer-projection.test.mjs",
  ".devpro/scripts/tests/second-review-control-evidence.test.mjs",
]);

function collectFilesUnder(dir, { includeTests = false, excludeBasenames = new Set() } = {}) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      if (entry.name === "tests" && !includeTests) continue;
      files.push(...collectFilesUnder(path.join(dir, entry.name), {
        includeTests,
        excludeBasenames,
      }));
      continue;
    }
    if (!entry.isFile()) continue;
    if (excludeBasenames.has(entry.name)) continue;
    files.push(path.join(dir, entry.name));
  }
  return files;
}

test("reviewer-completion-evidence carrier has zero runtime consumers outside its writer", () => {
  const files = collectFilesUnder(SCRIPTS_DIR, {
    excludeBasenames: new Set([WRITER_BASENAME]),
  });
  assert.ok(files.length > 0, "guard must scan the scripts tree");

  const hits = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const needle of CARRIER_NEEDLES) {
      if (source.includes(needle)) {
        hits.push(`${path.relative(REPO_ROOT, file)}: ${needle}`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    `carrier names must stay writer-only; found consumers:\n${hits.join("\n")}`,
  );

  // ...and the writer itself owns both names, so the zero-hit result above cannot pass
  // vacuously after a rename that orphans the carrier contract.
  const writerSource = readFileSync(path.join(SCRIPTS_DIR, WRITER_BASENAME), "utf8");
  for (const needle of CARRIER_NEEDLES) {
    assert.ok(writerSource.includes(needle), `writer must own the carrier name ${needle}`);
  }
});

test("generic completion-missing classification stays inside the bounded owner set", () => {
  // This guard file names the classification itself, so it is excluded from its own
  // inventory; everything else under .devpro/scripts/ is scanned, tests included.
  const files = collectFilesUnder(SCRIPTS_DIR, {
    includeTests: true,
    excludeBasenames: new Set([GUARD_BASENAME]),
  });
  const owners = files
    .filter((file) => readFileSync(file, "utf8").includes(GENERIC_MISSING_CLASSIFICATION))
    .map((file) => path.relative(REPO_ROOT, file).replaceAll("\\", "/"))
    .sort();
  assert.deepEqual(
    owners,
    EXPECTED_GENERIC_MISSING_OWNERS,
    "the generic classification must not gain a runtime owner outside the change's touch list",
  );

  // `retry_context.classification` is consumed as a substring token, never through a
  // maintained classification enum — so a new terminal classification needs no frozen
  // renderer/validator/ack surface change (design D3 spillover evidence).
  const validatorSource = readFileSync(
    path.join(SCRIPTS_DIR, "validate-second-review-packet.mjs"),
    "utf8",
  );
  assert.match(validatorSource, /SAME_FAMILY_FALLBACK_CLASSIFICATION_TOKEN = "same_family_fallback"/);
  assert.match(
    validatorSource,
    /classification\.includes\(SAME_FAMILY_FALLBACK_CLASSIFICATION_TOKEN\)/,
  );
  for (const relPath of [
    ".devpro/scripts/render-second-review-packet.mjs",
    ".devpro/scripts/validate-second-review-packet.mjs",
    ".devpro/scripts/ack-second-reviewer-projection.mjs",
  ]) {
    const source = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
    assert.equal(source.includes(GENERIC_MISSING_CLASSIFICATION), false, relPath);
    assert.equal(source.includes("reviewer_completion_stream_truncated"), false, relPath);
  }
});

// ── ADDED delta scenario carriers (cross-runtime-parity + code-review-checklist) ────────
//
// Each test below names one ADDED scenario of fix-projection-completion-truncation and
// asserts the registry/runner source that makes the scenario true. Behavioral fixtures for
// the same scenarios live in run-second-reviewer-projection.test.mjs (T1-T5); these
// source-level pins catch a change that moves the behavior without updating the spec.

const RUNNER_PATH = path.join(SCRIPTS_DIR, WRITER_BASENAME);
const CONTROL_EVIDENCE_LIB_PATH = path.join(
  SCRIPTS_DIR,
  "hooks/lib/second-review-control-evidence.mjs",
);
const TRUNCATED_CLASSIFICATION = "reviewer_completion_stream_truncated";
const OPERATOR_ABANDONED_CLASSIFICATION = "operator_abandoned_pre_spawn";
const STALE_RESERVATION_CLOSED_CLASSIFICATION = "stale_reservation_closed_pre_spawn";
const MISSING_CLASSIFICATION = "reviewer_completion_contract_missing";

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source anchor: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing anchor after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function squash(source) {
  return source.replace(/\s+/g, "");
}

/** Top-level `key:` names of one object literal, ignoring nested objects/calls. */
function extractTopLevelObjectKeys(objectText) {
  const keys = [];
  let depth = 0;
  let token = "";
  for (const char of objectText) {
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      token = "";
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      token = "";
      continue;
    }
    if (depth === 1 && /[A-Za-z0-9_$]/.test(char)) {
      token += char;
      continue;
    }
    if (depth === 1 && char === ":" && token.length > 0) {
      keys.push(token);
    }
    token = "";
  }
  return keys;
}

test("Scenario: Named classification registers in exactly one outcome group", () => {
  const source = readFileSync(CONTROL_EVIDENCE_LIB_PATH, "utf8");
  // Named exactly once in the whole helper: the registry entry itself.
  assert.equal((source.match(new RegExp(TRUNCATED_CLASSIFICATION, "g")) ?? []).length, 1);

  const registry = sliceBetween(
    source,
    "export const TERMINAL_RECEIPT_OUTCOME_CLASSIFICATIONS",
    "const terminalReceiptOutcomeByClassification",
  );
  const groups = [...registry.matchAll(/([a-z_]+): Object\.freeze\(\[([\s\S]*?)\]\)/g)]
    .map(([, name, body]) => ({ name, body }));
  const ownerGroups = groups
    .filter((group) => group.body.includes(TRUNCATED_CLASSIFICATION))
    .map((group) => group.name);
  assert.deepEqual(
    ownerGroups,
    ["terminal_contract_or_cli_failure"],
    "the truncation classification must register in exactly one outcome group",
  );

  const operatorGroups = groups
    .filter((group) => group.body.includes(OPERATOR_ABANDONED_CLASSIFICATION))
    .map((group) => group.name);
  assert.deepEqual(
    operatorGroups,
    ["operator_abandonment"],
    "the operator-abandonment classification must register in its own exact group",
  );

  const staleReservationGroups = groups
    .filter((group) => group.body.includes(STALE_RESERVATION_CLOSED_CLASSIFICATION))
    .map((group) => group.name);
  assert.deepEqual(
    staleReservationGroups,
    ["stale_reservation_closure"],
    "the stale-reservation classification must register in its own exact group",
  );

  // Keep the complete group-name set explicit, including the separately authorized operator closure.
  assert.deepEqual(groups.map((group) => group.name), [
    "reviewer_blocking_verdict",
    "provider_blocked",
    "confirmed_timeout",
    "spawn_or_probe_failure",
    "tool_surface_fault",
    "output_safety_overflow",
    "terminal_contract_or_cli_failure",
    "external_evaluator_closed",
    "operator_abandonment",
    "stale_reservation_closure",
    "diagnostic_scan_closed",
  ]);

  // Mutual exclusivity: no classification string is registered under two groups.
  const classifications = groups
    .flatMap((group) => [...group.body.matchAll(/"([a-z_]+)"/g)].map(([, name]) => name));
  assert.equal(new Set(classifications).size, classifications.length);
  assert.ok(classifications.includes(TRUNCATED_CLASSIFICATION));
});

test("Scenario: Truncation shape classifies identically across host runtimes", () => {
  const source = readFileSync(RUNNER_PATH, "utf8");
  const shapeDecision = sliceBetween(
    source,
    "function deriveCompletionStreamEndShape(",
    "function classifyCliExit(",
  );
  const missingBranch = sliceBetween(
    source,
    'if (requiresCompletion && completion?.status === "missing")',
    'if (requiresCompletion && completion?.status === "reason-missing")',
  );

  // No host-conditional branch may change the classification.
  for (const [label, slice] of [
    ["deriveCompletionStreamEndShape", shapeDecision],
    ["classifyCliExit missing branch", missingBranch],
  ]) {
    assert.doesNotMatch(slice, /process\.platform|process\.arch|os\.platform/, label);
  }

  // The missing branch returns exactly the named truncation classification and the generic
  // fallback; the runner names the new classification in that one place only.
  assert.deepEqual(
    [...missingBranch.matchAll(/return "([a-z_]+)";/g)].map(([, name]) => name),
    [TRUNCATED_CLASSIFICATION, MISSING_CLASSIFICATION],
  );
  assert.equal((source.match(new RegExp(TRUNCATED_CLASSIFICATION, "g")) ?? []).length, 1);
});

test("Scenario: Unproven shapes stay generic", () => {
  const source = readFileSync(RUNNER_PATH, "utf8");
  const shapeDecision = sliceBetween(
    source,
    "function deriveCompletionStreamEndShape(",
    "function classifyCliExit(",
  );
  // Closed vocabulary: only partial_line / mid_turn_stream are proven truncation shapes;
  // no_bytes and clean_boundary are the absence of truncation evidence.
  assert.deepEqual(
    [...shapeDecision.matchAll(/return "([a-z_]+)";/g)].map(([, name]) => name),
    ["no_bytes", "partial_line", "mid_turn_stream", "clean_boundary"],
  );

  const missingBranch = sliceBetween(
    source,
    'if (requiresCompletion && completion?.status === "missing")',
    'if (requiresCompletion && completion?.status === "reason-missing")',
  );
  // Only the two proven shapes escalate; every unproven shape falls through to the generic
  // missing classification (no truncation classification fabricated from no_bytes/clean_boundary).
  assert.match(
    squash(missingBranch),
    new RegExp(
      'if\\(stdoutEndShape==="partial_line"\\|\\|stdoutEndShape==="mid_turn_stream"\\)\\{'
      + `return"${TRUNCATED_CLASSIFICATION}";\\}return"${MISSING_CLASSIFICATION}";`,
    ),
  );
  assert.equal(missingBranch.includes('"no_bytes"'), false);
  assert.equal(missingBranch.includes('"clean_boundary"'), false);
});

test("Scenario: Truncation evidence carries no completion authority", () => {
  // The carrier stays writer-only: no runtime consumer — hooks included — may reference the
  // carrier basename or schema, so it cannot become a classification, sticky, receipt, or
  // gate input (the writer is the one excluded file).
  const runtimeFiles = collectFilesUnder(SCRIPTS_DIR, {
    excludeBasenames: new Set([WRITER_BASENAME]),
  });
  const hookFiles = runtimeFiles.filter((file) => (
    path.relative(SCRIPTS_DIR, file).startsWith(`hooks${path.sep}`)
  ));
  assert.ok(runtimeFiles.length > 0, "guard must scan the scripts tree");
  assert.ok(hookFiles.length > 0, "guard must scan the hooks tree");

  const hits = [];
  for (const file of runtimeFiles) {
    const source = readFileSync(file, "utf8");
    for (const needle of CARRIER_NEEDLES) {
      if (source.includes(needle)) {
        hits.push(`${path.relative(REPO_ROOT, file)}: ${needle}`);
      }
    }
  }
  assert.deepEqual(hits, [], `carrier names must stay writer-only; found consumers:\n${hits.join("\n")}`);
});

test("Scenario: Diagnostics fields stay bounded and content-free", () => {
  const source = readFileSync(RUNNER_PATH, "utf8");
  const summary = sliceBetween(
    source,
    "function completionStreamEvidenceSummary(",
    "function completionStreamDiagnosticApplies(",
  );
  const returnIndex = summary.indexOf("return {");
  assert.notEqual(returnIndex, -1, "the diagnostics summary must return an object literal");
  const keys = extractTopLevelObjectKeys(summary.slice(returnIndex));
  assert.deepEqual(
    keys,
    [
      "stdout_bytes",
      "stdout_end_shape",
      "stdout_trailing_partial_bytes",
      "stdout_last_complete_event",
      "stdout_window_truncated",
      "completion_evidence",
    ],
    "the diagnostics event fields are an exact allowlist",
  );
  for (const rawName of ["reason", "payload", "stdout_text", "stderr_text", "completion_text"]) {
    assert.equal(keys.includes(rawName), false, `reviewer raw content field ${rawName} must stay off the event`);
  }

  // Emitted exactly once per dispatch from this summary, and exposed on the result payload
  // (the heartbeat receives that same result object).
  assert.equal((source.match(/"projection_completion_stream_evidence"/g) ?? []).length, 1);
  assert.match(
    squash(source),
    /appendActivity\(context,"projection_completion_stream_evidence",completionStreamEvidence\);/,
  );
  assert.equal((source.match(/completion_stream_evidence:/g) ?? []).length, 2);
});

test("Scenario: Arrived evidence carrier is non-authoritative and attempt-local", () => {
  const source = readFileSync(RUNNER_PATH, "utf8");

  // Attempt-local derivation: the carrier is a sibling of this attempt's stdout archive.
  const pathFn = sliceBetween(
    source,
    "function completionEvidenceArtifactPath(",
    "// D5 derivation",
  );
  assert.match(
    squash(pathFn),
    /returnpath\.join\(path\.dirname\(context\.stdout_log_path\),COMPLETION_EVIDENCE_FILE_NAME\);/,
  );

  // Literal non-authority marker in the single canonical record builder.
  const recordFn = sliceBetween(
    source,
    "function buildCompletionEvidenceRecord(",
    "// D5 write:",
  );
  const recordFlat = squash(recordFn);
  assert.equal((recordFlat.match(/completion_authority:"none"/g) ?? []).length, 1);
  assert.match(recordFlat, /file_role:"reviewer_stdout_archive"/);

  // The carrier path/schema names never reach the control-evidence root write surface:
  // every occurrence lives inside the carrier block or its test seam.
  const carrierStart = source.indexOf("// ── R2 (D4/D5");
  const carrierEnd = source.indexOf("export function shouldBlockUnavailableStickyOverwrite");
  const seamStart = source.indexOf("export const __testCompletionStreamEvidence");
  const seamEnd = source.indexOf("function safeCliExit");
  assert.ok(carrierStart !== -1 && carrierEnd > carrierStart, "carrier block anchors must exist");
  assert.ok(seamStart !== -1 && seamEnd > seamStart, "carrier test-seam anchors must exist");
  for (const constant of ["COMPLETION_EVIDENCE_FILE_NAME", "COMPLETION_EVIDENCE_SCHEMA"]) {
    let occurrences = 0;
    for (
      let at = source.indexOf(constant);
      at !== -1;
      at = source.indexOf(constant, at + constant.length)
    ) {
      occurrences += 1;
      const inCarrierBlock = at > carrierStart && at < carrierEnd;
      const inTestSeam = at > seamStart && at < seamEnd;
      assert.ok(
        inCarrierBlock || inTestSeam,
        `${constant} must stay off the control-evidence root write surface`,
      );
    }
    assert.ok(occurrences > 0, `${constant} must be defined`);
  }
});

test("Scenario: Truncation never yields a verified terminal", () => {
  const source = readFileSync(RUNNER_PATH, "utf8");
  const flat = squash(source);

  // A completion receipt is reachable only through a successful completion: `finished`
  // starts solely from `reviewer_cli_completed`…
  assert.match(flat, /letstatus=cliClassification==="reviewer_cli_completed"\?"finished":"blocked";/);
  // …and each receipt branch re-checks its own success premises, downgrading to blocked.
  assert.match(
    flat,
    /if\(context\.mode==="pr-sticky"&&status==="finished"\)\{if\(sticky\.status!=="verified"\|\|cliResult\.process_close_observed!==true\)\{status="blocked";classification="reviewer_transport_termination_unconfirmed";\}/,
  );
  assert.match(
    flat,
    /if\(context\.mode==="audit-only"&&status==="finished"&&cliResult\.process_close_observed===true\)\{/,
  );

  const receiptSlice = sliceBetween(
    source,
    'if (context.mode === "pr-sticky" && status === "finished") {',
    'if (status === "blocked" && activeOrchestrationEvidence === null) {',
  );
  assert.equal((source.match(/writeCompletionReceipt\(/g) ?? []).length, 1, "control-evidence write lives only inside persistCompletionReceiptWithPacketMirror");
  assert.equal((source.match(/persistCompletionReceiptWithPacketMirror\(/g) ?? []).length, 3, "helper definition plus two guarded call sites");
  assert.equal((receiptSlice.match(/persistCompletionReceiptWithPacketMirror\(/g) ?? []).length, 2);
  assert.equal((receiptSlice.match(/writeCompletionReceipt\(/g) ?? []).length, 0);
  assert.equal((source.match(/projection_completion_receipt_written/g) ?? []).length, 1, "written activity emits only after packet-local mirror");
  assert.match(source, /packet_completion_receipt_path/);
  assert.match(squash(receiptSlice), /outcome:"reviewer_process_closed_and_sticky_verified"/);
  assert.match(squash(receiptSlice), /outcome:"reviewer_process_closed_audit_only"/);
  // The receipt surface never consumes the truncation classification or the preserved carrier.
  for (const forbidden of [
    TRUNCATED_CLASSIFICATION,
    "completion_stream_evidence",
    "completionEvidenceArtifact",
    "COMPLETION_EVIDENCE_FILE_NAME",
  ]) {
    assert.equal(receiptSlice.includes(forbidden), false, `${forbidden} must stay off the receipt surface`);
  }

  // The truncation classification is a fail-closed closed terminal in
  // terminal_contract_or_cli_failure — never a success outcome.
  const libSource = readFileSync(CONTROL_EVIDENCE_LIB_PATH, "utf8");
  const group = sliceBetween(
    libSource,
    "terminal_contract_or_cli_failure: Object.freeze([",
    "])",
  );
  assert.ok(group.includes(`"${TRUNCATED_CLASSIFICATION}"`));
});
