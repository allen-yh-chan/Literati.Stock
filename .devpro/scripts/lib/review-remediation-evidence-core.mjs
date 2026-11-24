import { validateReviewGuaranteeAssessment } from "../review-guarantee-assessment.mjs";
import { constants as BUFFER_CONSTANTS } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isWhitelistedPath } from "../hooks/lib/fresh-equivalent-compare.mjs";
import { parseRiskClassesFrontMatter } from "../lint-risk-classes-record.mjs";
import { isCanonicalCapPressureSoftWarn } from "./cap-pressure-soft-warn.mjs";
import { CHANGE_ID_SHAPE as ADMISSION_CHANGE_ID_SHAPE, createExclusiveDurableFile, fsyncDirectory, isDurablePathError, readNoFollowFile } from "./durable-fs.mjs";
import { retryOnTransientGitIo } from "./eintr-retry.mjs";
import {
  FINAL_SUITE_RESULT_CONSUMER_NA,
  FINAL_SUITE_RESULT_PASS,
  checkFinalSuiteOutput,
  determineFinalSuiteProfile,
} from "./final-suite-profile.mjs";
import { ADMISSION_RECORD_SCHEMA, CODEX_REVIEWER_ADMISSION_SCHEMA, admissionChangeEntryExists, claimAdmissionRecord, readAdmissionRecord, readAdmissionRecordClaim, resolveAdmissionChangeDir, resolveChangeIdFromCwd, resolveExactOneChangeWorktreeBinding, verifyCodexReviewerAdmissionAuthority } from "../hooks/lib/admission-record.mjs";
import { BUDGET_STATES, HALF_STATE_OVERRIDE_SCOPE, claimHalfStateOverride, hasConsumedHalfStateOverrideClaim } from "./half-state-override.mjs";
import { isStrictPlainObject, sha256Hex } from "./primitives.mjs";
import { PROPOSAL_CARRIERS } from "./proposal-carriers.mjs";
import { findUnmappedPromotionTitles, parseRequirementBodies as parsePromotionRequirementBodies } from "./requirement-body-whitespace.mjs";
import { deriveReviewStallStreak, isReviewStallBudgetExhausted } from "./review-stall-budget.mjs";
import { extractExactH2Bodies, findExactHeadingSpan, forEachMarkdownLine, fenceDelimiter, closesFence, neutraliseInertMarkdown } from "./markdown-fence-aware.mjs";

// Receipt schema epochs (strengthen-subagent-delegation-strategy design D6):
// v3 is current and adds exact normal/post-hoc authority plus output binding.
// Legacy v2 keeps its closed {runtime-agent, tl-direct} executor set; v1 is a
// bounded grandfather with {role} identity. Neither legacy epoch is independent.
const REVIEW_RECEIPT_SCHEMA_V1 = "devpro.review-remediation.receipt/v1";
const REVIEW_RECEIPT_SCHEMA_V2 = "devpro.review-remediation.receipt/v2";
const REVIEW_RECEIPT_SCHEMA = "devpro.review-remediation.receipt/v3";
const REVIEW_RECEIPT_SCHEMAS = new Set([REVIEW_RECEIPT_SCHEMA_V1, REVIEW_RECEIPT_SCHEMA_V2, REVIEW_RECEIPT_SCHEMA]);
const REVIEWER_PAYLOAD_V3_KEYS = Object.freeze([
  "change_id", "responsibility_id", "dispatch_id", "reviewer_identity", "review_authority", "output_evidence",
  "review_mode", "round_number", "bounded_rereview_count", "lineage", "scope", "findings", "verdict",
]);
const HISTORICAL_POST_HOC_RAW_PAYLOAD_KEYS = Object.freeze(
  REVIEWER_PAYLOAD_V3_KEYS.filter((key) => key !== "review_authority" && key !== "output_evidence"),
);
const LEGACY_V2_EXECUTOR_KINDS = new Set(["runtime-agent", "tl-direct"]);
const V3_EXECUTOR_KINDS = new Set([...LEGACY_V2_EXECUTOR_KINDS, "post-hoc-tl-attested-runtime-review"]);
const RECEIPT_COMMIT_SCHEMA = "devpro.review-remediation.receipt-commit/v1";
const POST_HOC_PREPARED_SCHEMA = "devpro.review-remediation.post-hoc-prepared/v1";
const POST_HOC_AUTHORIZATION_SCHEMA = "devpro.review-remediation.post-hoc-authorization/v1";
const POST_HOC_AUTHORIZATION_CLAIM_SCHEMA = "devpro.review-remediation.post-hoc-authorization-claim/v1";
const POST_HOC_ATTESTATION_SCHEMA = "devpro.review-remediation.post-hoc-attestation/v1";
const POST_HOC_ATTESTATION_CLAIM_SCHEMA = "devpro.review-remediation.post-hoc-attestation-claim/v1";
const POST_HOC_ELIGIBLE_REASON = "codex-named-dp-reviewer-opaque-message-message-only-parser-v1";
const POST_HOC_CUTOFF_SHA = "ab95bc8c2f33dc45818ac80b83364228dae0487c";
const POST_HOC_ALLOWED = Object.freeze([
  Object.freeze({ change_id: "fix-zero-value-review-rounds", base_sha: "f1e879d1079bdf4029967df4d84823f7815c225c", reviewed_head_sha: "401953888a5b8478bfb31c8062897f1b7fa34862", dispatch_id: "48aab43c3fccda343b95ae07a6f4d0e64b8defbb3792b25b2b0646d067c99b8a", responsibility_id: "primary-review", review_mode: "full", round_number: 4, risk_shape_digest_sha256: "adf13108ced3da29a4da871df187ea1d3de67f849e2622ab0211423e1db96e21", raw_payload_sha256: "cdba59067bff2e66976d731b70608aeb6b31130b2e5bf18f9c57187298afaafb", verdict: "partial", open_finding_ids: Object.freeze(["F-fzvrr-r10-01", "F-fzvrr-r10-02"]) }),
  Object.freeze({ change_id: "fix-zero-value-review-rounds", base_sha: "f1e879d1079bdf4029967df4d84823f7815c225c", reviewed_head_sha: "737e8cecf81974c8dbf299ce5a8666288f6aff2d", dispatch_id: "a4aec7bd119d193e88359ed888fbae1a9a2a2b72caadba283a4fb46717092dbf", responsibility_id: "primary-review", review_mode: "full", round_number: 4, risk_shape_digest_sha256: "f0f06f74f7e6a2818a515fed9fcba44e568485da568a66174b6459de6e784f28", raw_payload_sha256: "f6ec4522e010cc50e4091ccbc3f8e9461747434467abb4a88c64440787fa5f2d", verdict: "blocked", open_finding_ids: Object.freeze(["F-fzvrr-r11-01", "F-fzvrr-r11-02"]) }),
]);
const REVIEWER_ROLES = new Set(["dp-reviewer"]);
const ADMISSION_RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = ADMISSION_RECORD_ID;
const RESPONSIBILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const REVIEW_MANIFEST_SCHEMA = "devpro.review-remediation.manifest/v1";
const FINAL_EVIDENCE_SCHEMA = "devpro.review-remediation.final-evidence/v1";
const CROSS_CARRIER_CLOSURE_SCHEMA = "devpro.review-remediation.cross-carrier-closure/v1";
const ARCHIVE_TRANSITION_SCHEMA = "devpro.review-remediation.archive-transition-evidence/v1";
// Change-folder prefixes that MUST NOT be tracked by Git. Paths are relative
// to the change folder. These are hook-written, worktree-local carriers
// (spawn admission records, half-state override claims).
//
// Decisive facts (PR #2473 cross-model Critical, verified 2026-09-06):
//   - `.gitignore` (managed block, SSOT `gitignore-alignment.md`) already
//     ignores `openspec/changes/**/admission-records/` and
//     `openspec/changes/**/override-ledger/`.
//   - `git ls-files | grep -cE 'admission-records/|override-ledger/'` is 0 at
//     HEAD. The legitimate TRACKED inventory under these prefixes is therefore
//     the empty set BY CONSTRUCTION, not by policy.
//
// This constant used to be named for an exemption: a blanket carve-out that
// filtered both prefixes out of the reviewed-head <-> archive exact mapping.
// Its stated premise was that hook-written carriers land in the change folder
// after the reviewed head, which silently assumed they are TRACKED. They are
// not — they are gitignored, so they never legitimately appear in any tree.
// The carve-out therefore tolerated something that cannot exist by design, and
// in doing so silently accepted unreviewed files force-added with `git add -f`
// under these two prefixes: `deriveTransitionFacts` only paired archive-side
// additions against matching active-side deletions, so an addition with no
// corresponding deletion was never inspected at all.
//
// An empty expected inventory is exactly why the correct gate is an absence
// assertion rather than an exemption: there is nothing legitimate to exempt,
// so any tracked hit is unambiguously a defect and MUST fail closed.
const ARCHIVE_TRANSITION_UNTRACKED_PREFIXES = /^(?:admission-records|override-ledger)\//u;
const TRANSITION_TIMEOUT_MS = 120000;

// D30's typed failure boundary is deliberately closed. Keep this catalog in
// the core so a code can only be minted by a semantic source that names one of
// these reviewed conditions; CLI prose and arbitrary `.code` properties are
// never consulted.
const D30_CODE_SET = new Set(`
request-size-exceeded request-unparseable request-shape-invalid identifier-invalid sha-invalid digest-invalid timestamp-invalid
raw-payload-read-failed raw-payload-size-exceeded raw-payload-collision raw-payload-digest-mismatch raw-payload-invalid raw-payload-root-unavailable raw-payload-publication-denied raw-payload-publication-failed raw-payload-publication-partial raw-payload-publication-indeterminate raw-payload-existing-unsafe predecessor-finding-omitted open-finding-ids-noncanonical verdict-open-set-digest-mismatch cooperative-identity-not-distinct ordinary-review-not-independent
post-hoc-eligible-tuple-mismatch reviewed-head-after-cutoff eligible-reason-invalid authorization-stale authorization-binding-mismatch authorization-consumed authorization-claim-write-failed attestation-binding-mismatch attestation-consumed attestation-claim-write-failed post-hoc-evidence-invalid
receipt-output-evidence-mismatch receipt-payload-digest-mismatch receipt-ref-digest-mismatch receipt-size-exceeded receipt-unparseable receipt-noncanonical receipt-path-schema-mismatch receipt-path-collision receipt-publish-failed receipt-readback-mismatch receipt-scan-failed receipt-candidate-limit-exceeded receipt-ambiguous receipt-not-committed legacy-receipt-seal-forbidden legacy-receipt-not-independent receipt-authority-missing receipt-authority-mixed receipt-identity-authority-mismatch receipt-authority-changed admission-record-consumed admission-claim-write-failed intent-scan-failed intent-candidate-limit-exceeded binding-root-mismatch change-worktree-required change-worktree-ambiguous git-head-unavailable receipt-path-change-mismatch receipt-evidence-invalid receipt-authority-invalid
artifact-size-exceeded artifact-unparseable artifact-noncanonical artifact-ref-digest-mismatch artifact-read-failed artifact-write-failed artifact-readback-mismatch artifact-parent-invalid archive-scan-failed archive-candidate-limit-exceeded archive-candidate-invalid archive-entry-case-mismatch proposal-scan-failed proposal-carrier-case-mismatch proposal-carrier-invalid proposal-carrier-ambiguous artifact-class-unknown evidence-artifact-invalid unexpected-io-fault
`.trim().split(/\s+/u));

// Export a read-only iterable view: freezing a Set does not freeze its
// entries, so consumers must not receive mutation methods for the closed
// runtime catalog.
export const D30_CODES = Object.freeze({
  get size() { return D30_CODE_SET.size; },
  has(code) { return D30_CODE_SET.has(code); },
  [Symbol.iterator]() { return D30_CODE_SET[Symbol.iterator](); },
});

const D30_SAFE_REASONS = Object.freeze({
  "full-review-manifests-nonnull": {
    codes: ["raw-payload-invalid"],
    detail: "Set both bounded manifest references to null and reproduce the full-review payload before capture.",
  },
  "raw-risk-digest-missing": {
    codes: ["raw-payload-invalid"],
    detail: "Include scope.risk_shape_digest_alg from the dispatch contract in the reviewer payload before capture.",
  },
  "evidence-parent-unsafe": {
    codes: ["evidence-artifact-invalid"],
    detail: "Use plain evidence directories inside the repository boundary; remove unsafe parent links before retrying.",
  },
  "evidence-target-unsafe": {
    codes: ["evidence-artifact-invalid"],
    detail: "Use a regular evidence file inside its verified parent; remove unsafe target links or entries before retrying.",
  },
  "evidence-read-raced": {
    codes: ["evidence-artifact-invalid"],
    detail: "Evidence changed during a verified read. Retry with stable evidence and rerun the affected command.",
  },
});

export class CoreFailure extends Error {
  #detailReason;
  constructor(code, message = code, detailReason = null) {
    if (!D30_CODE_SET.has(code)) throw new TypeError("CoreFailure code is not in the D30 catalog");
    if (detailReason !== null && (!Object.hasOwn(D30_SAFE_REASONS, detailReason)
      || !D30_SAFE_REASONS[detailReason].codes.includes(code))) throw new TypeError("CoreFailure reason does not own this code");
    super(message);
    this.name = "CoreFailure";
    this.code = code;
    this.#detailReason = detailReason;
  }
  static safeDetail(error) {
    if (!(error instanceof CoreFailure) || !(#detailReason in error) || error.#detailReason === null) return null;
    const reason = D30_SAFE_REASONS[error.#detailReason];
    return reason.codes.includes(error.code) ? reason.detail : null;
  }
}

const CORE_DOMAIN_PREDICATE = Symbol("core-domain-predicate");
const CORE_SAFE_REASON = Symbol("core-safe-reason");

function durableFailureReason(error) {
  if (!isDurablePathError(error)) return null;
  switch (error.code) {
    case "parent-outside-root": case "parent-not-plain-directory": case "parent-identity-changed":
      return "evidence-parent-unsafe";
    case "target-not-in-parent": case "target-not-regular-file": case "target-outside-parent":
      return "evidence-target-unsafe";
    case "same-inode-proof-failed": case "file-changed-while-reading":
      return "evidence-read-raced";
    default: return null;
  }
}

function withSemanticFailureCode(code, action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof CoreFailure || !error?.[CORE_DOMAIN_PREDICATE]) throw error;
    // Keep the old internal diagnostic available to direct helper callers,
    // while `.code` remains minted only by this source-owned semantic wrapper.
    // The CLI serializes only the fixed catalog detail for that code.
    const reason = error[CORE_SAFE_REASON];
    const ownedReason = Object.hasOwn(D30_SAFE_REASONS, reason) && D30_SAFE_REASONS[reason].codes.includes(code) ? reason : null;
    throw new CoreFailure(code, `${code}: ${error.message}`, ownedReason);
  }
}

// Size bound for the admission-record uniqueness scan's receipt reads.
// Measured 2026-09-06 over every sealed receipt in this repo's notes/
// (`review-*-receipt-r*.json`, n=104): max 25,000 bytes, min 858. 256 KiB is
// ~10x the observed maximum, which leaves room for receipts carrying far
// larger finding ledgers while still bounding a corrupt or adversarial file.
// Deliberately NOT the 64 KiB used by session-usage-lineage.mjs for admission
// records: receipts carry full finding and scope ledgers and are an order of
// magnitude larger, so 64 KiB would sit only ~2.6x above the measured max.
const RECEIPT_SCAN_MAX_BYTES = 256 * 1024;

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const RECEIPT_VERDICTS = new Set(["finished", "blocked", "partial"]);
const REVIEW_MODES = new Set(["full", "bounded"]);
const FINDING_STATES = new Set(["open", "closed"]);
const DISPOSITIONS = new Set([
  "fix-now",
  "tracked-follow-up",
  "defer-with-owner-trigger",
  "non-issue-with-evidence",
]);
const CROSS_CARRIER_CLASSIFICATIONS = new Set(["not-applicable", "cross-carrier"]);
const CROSS_CARRIER_MATCH_DISPOSITIONS = new Set([
  "aligned",
  "historical-rejected",
  "quoted-in-evidence",
]);
const CROSS_CARRIER_MAX_FINDINGS = 128;
const CROSS_CARRIER_MAX_LITERALS_PER_FINDING = 32;
const CROSS_CARRIER_MAX_MATCHES = 4096;
const CROSS_CARRIER_MAX_LITERAL_BYTES = 1024;
const CROSS_CARRIER_MAX_TEXT_BYTES = 4096;
const CROSS_CARRIER_MAX_FINDING_ID_BYTES = 256;
const CROSS_CARRIER_CLOSURE_MAX_BYTES = 32 * 1024 * 1024;
const CROSS_CARRIER_MAX_CANDIDATES = 64;
const MANIFEST_PURPOSES = new Set(["repair-delta", "dependency-closure", "content-comparison"]);
const MANIFEST_RESULTS = new Set(["pass", "exceptions", "partial", "error"]);
const EDGE_KINDS = new Set([
  "import",
  "reference",
  "generated-from",
  "registry",
  "symlink",
  "test-maps-to",
]);
const CANONICAL_SUITE_COMMAND = "node .devpro/scripts/run-test-suite.mjs --changed main";
const ORACLE_BUILTINS = new Set(["node:crypto"]);
const RISK_SHAPE_SCHEMA = "devpro.review-remediation.risk-shape/v1";
const RISK_SHAPE_DIGEST_ALG_V1 = "behavior-risk-v1";
const RISK_SHAPE_DIGEST_ALG_LEGACY = "full-prose-v0";
const SEAL_CLEARANCE_DISPOSITIONS = Object.freeze(["fix-now", "non-issue-with-evidence"]);
// Closed receipt-finding scope vocabulary (fix-out-of-requirement-seal-disposition D6).
// A missing key means in-scope. The four human-readable projections of this set are
// locked by review-requirement-anchoring-grep.test.mjs, which also reads this literal,
// so keep it on one line.
const REQUIREMENT_SCOPES = Object.freeze(["in-scope", "out-of-requirement", "scope-unresolved"]);
// The only disposition that may close an out-of-requirement (or ruled scope-unresolved)
// Critical/Important. Deliberately not part of the seal-clearance set: that set stays the
// two dispositions that clear a finding of any scope.
const OUT_OF_SCOPE_CLOSURE_DISPOSITION = "tracked-follow-up";
// TL scope rulings (design D2/D9): one live `## Scope Rulings` H2 in the change's decisions.md,
// read from the receipt's bound-HEAD Git object, holding one json fence of six-key entries.
const SCOPE_RULINGS_HEADING = "## Scope Rulings";
const SCOPE_RULING_KEYS = Object.freeze(["finding_id", "observation_hash_sha256", "round_number", "proposal_sha256", "ruling", "rationale"]);
const SCOPE_RULING_VALUES = Object.freeze(["in-scope", "out-of-requirement"]);
// The closed set of reasons a scope-unresolved closure can name when no ruling qualifies. A
// binding mismatch (finding id, observation hash, round or proposal bytes) deliberately shares
// one reason: each is one field away from a qualifying entry and the TL repairs it the same way.
const SCOPE_RULING_REASONS = Object.freeze({
  repoRootAbsent: "no repository root is available to read the ruling at the bound HEAD",
  decisionsAbsent: "decisions.md is absent at the bound HEAD",
  decisionsUnreadable: "decisions.md is unreadable or not valid UTF-8 at the bound HEAD",
  headingNotUnique: "## Scope Rulings is absent or not unique",
  fenceNotUnique: "## Scope Rulings must hold exactly one json fence",
  jsonInvalid: "## Scope Rulings json is invalid",
  entryMalformed: "## Scope Rulings entry is malformed",
  tupleRepeated: "## Scope Rulings repeats a binding tuple",
  carrierAmbiguous: "proposal carrier is absent or ambiguous at the bound HEAD",
  ruledInScope: "TL ruled in-scope",
  noBinding: "no ruling matches the finding id, observation hash, round and proposal content",
});
const LOGICAL_DISPATCH_SCHEMA = "devpro.review-remediation.logical-dispatch/v1";
const RISK_CLASSES = new Set(["auth", "state/invariant", "write", "external-disclosure"]);
const REAL_RISK_FS_OPS = Object.freeze({
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
});
const REAL_GIT_OPS = Object.freeze({
  readExactTreeRecord({ repoRoot, headSha, path: repoRelativePath }) {
    return retryOnTransientGitIo(() => execFileSync("git", [
      "ls-tree",
      "-z",
      "--full-tree",
      headSha,
      "--",
      `:(literal)${repoRelativePath}`,
    ], { cwd: repoRoot, encoding: "buffer" }));
  },
  readTreeRecordsUnderPath({ repoRoot, headSha, path: repoRelativePath }) {
    return retryOnTransientGitIo(() => execFileSync("git", [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      headSha,
      "--",
      `:(literal)${repoRelativePath}`,
    ], { cwd: repoRoot, encoding: "buffer" }));
  },
  readBlobByOid({ repoRoot, oid }) {
    return gitBuffer(repoRoot, ["cat-file", "blob", oid], "cannot read Git blob");
  },
  mergeBase({ repoRoot, leftSha, rightSha }) {
    return retryOnTransientGitIo(() => execFileSync("git", ["merge-base", leftSha, rightSha], {
      cwd: repoRoot,
      encoding: "utf8",
    })).trim();
  },
  isAncestor({ repoRoot, ancestorSha, descendantSha }) {
    try {
      retryOnTransientGitIo(() => execFileSync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], {
        cwd: repoRoot,
        // Keep stderr piped: isTransientGitIoError classifies EINTR from the
        // git error text, which "ignore" would discard (F-hrr-f2-01).
        stdio: ["ignore", "ignore", "pipe"],
      }));
      return true;
    } catch (error) {
      if (error?.status === 1 && error?.signal == null) return false;
      throw error;
    }
  },
});
const ORACLE_BOOTSTRAP = String.raw`
import crypto from "node:crypto";
import vm from "node:vm";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const transport = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const sources = new Map(transport.modules.map((entry) => [entry.path, Buffer.from(entry.source_base64, "base64").toString("utf8")]));
const context = vm.createContext({});
const modules = new Map();
const builtinCrypto = new vm.SyntheticModule(["default", "createHash"], function initialize() {
  this.setExport("default", crypto);
  this.setExport("createHash", crypto.createHash);
}, { context, identifier: "node:crypto" });
const resolve = (specifier, importer) => {
  if (specifier === "node:crypto") return specifier;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) throw new Error("forbidden oracle module specifier");
  const base = importer.slice(0, importer.lastIndexOf("/") + 1);
  const segments = [];
  for (const segment of (base + specifier).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new Error("oracle module escape");
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join("/");
};
const load = (modulePath) => {
  if (modulePath === "node:crypto") return builtinCrypto;
  if (!sources.has(modulePath)) throw new Error("unresolved oracle module");
  if (!modules.has(modulePath)) {
    modules.set(modulePath, new vm.SourceTextModule(sources.get(modulePath), {
      context,
      identifier: modulePath,
      importModuleDynamically() { throw new Error("dynamic oracle import forbidden"); },
    }));
  }
  return modules.get(modulePath);
};
const root = load(transport.root_path);
await root.link((specifier, referencingModule) => load(resolve(specifier, referencingModule.identifier)));
await root.evaluate({ timeout: 30000 });
const exported = Object.keys(root.namespace).sort();
if (exported.length !== 1 || exported[0] !== "verify" || typeof root.namespace.verify !== "function") {
  throw new Error("oracle must export exactly verify(request)");
}
const result = await root.namespace.verify(transport.request);
const compare = (left, right) => {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
};
const canonical = (value) => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("noncanonical oracle number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (!value || Object.prototype.toString.call(value) !== "[object Object]") throw new Error("noncanonical oracle result");
  return "{" + Object.keys(value).sort(compare).map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};
process.stdout.write(canonical(result) + "\n");
`;

function fail(message, detailReason = null) {
  if (D30_CODE_SET.has(message)) throw new CoreFailure(message, message, detailReason);
  const error = new Error(message);
  error[CORE_DOMAIN_PREDICATE] = true;
  error[CORE_SAFE_REASON] = detailReason;
  throw error;
}

function assertObject(value, label) {
  if (!isStrictPlainObject(value)) fail(`${label} must be a plain object`);
}

function assertExactKeys(value, expected, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unknown or missing fields`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${label} must be a non-empty string`);
  }
}

function assertSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
}

function assertDigest(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !HEX_64.test(value)) fail(`${label} must be lowercase 64-hex`);
}

function assertSha(value, label) {
  if (typeof value !== "string" || !HEX_40.test(value)) fail(`${label} must be lowercase 40-hex`);
}

function isExactObjectSha(value) {
  return typeof value === "string" && (HEX_40.test(value) || HEX_64.test(value));
}

function assertUniqueStrings(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array`);
  const seen = new Set();
  for (const value of values) {
    assertString(value, `${label}[]`);
    if (seen.has(value)) fail(`${label} contains duplicate values`);
    seen.add(value);
  }
  return seen;
}

function compareCodePoints(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail("canonical-json-v1 permits canonical safe integers only");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("canonical-json-v1 does not permit cycles");
    if (Object.keys(value).length !== value.length) fail("canonical-json-v1 does not permit sparse arrays");
    seen.add(value);
    const encoded = value.map((entry) => canonicalValue(entry, seen));
    seen.delete(value);
    return `[${encoded.join(",")}]`;
  }
  if (!isStrictPlainObject(value)) fail("canonical-json-v1 permits only JSON plain objects");
  if (Object.getOwnPropertySymbols(value).length > 0) fail("canonical-json-v1 does not permit symbol keys");
  if (seen.has(value)) fail("canonical-json-v1 does not permit cycles");
  seen.add(value);
  const encoded = Object.keys(value)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`);
  seen.delete(value);
  return `{${encoded.join(",")}}`;
}

function canonicalJsonV1(value) {
  return canonicalValue(value, new Set());
}

function parseJsonDuplicateAware(text) {
  let index = 0;
  const error = (message) => fail(`${message} at JSON character offset ${index}`);
  const whitespace = () => {
    while (/\s/.test(text[index] ?? "")) index += 1;
  };
  const string = () => {
    if (text[index] !== '"') error("expected JSON string");
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code < 0x20) error("unescaped control character");
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (text[index] === "\\") {
        index += 1;
        if (index >= text.length) error("unterminated escape");
        if (text[index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) error("invalid unicode escape");
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(text[index])) error("invalid escape");
      }
      index += 1;
    }
    error("unterminated string");
  };
  const number = () => {
    const match = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) error("invalid JSON number");
    index += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) error("non-finite JSON number");
    return parsed;
  };
  const array = () => {
    const result = [];
    index += 1;
    whitespace();
    if (text[index] === "]") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      result.push(value());
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") error("expected array comma");
      index += 1;
      whitespace();
    }
    error("unterminated array");
  };
  const object = () => {
    const result = {};
    const seen = new Set();
    index += 1;
    whitespace();
    if (text[index] === "}") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      const key = string();
      if (seen.has(key)) error(`duplicate JSON object key: ${key}`);
      seen.add(key);
      whitespace();
      if (text[index] !== ":") error("expected object colon");
      index += 1;
      result[key] = value();
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") error("expected object comma");
      index += 1;
      whitespace();
    }
    error("unterminated object");
  };
  const value = () => {
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === "{") return object();
    if (text[index] === "[") return array();
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    return number();
  };
  const parsed = value();
  whitespace();
  if (index !== text.length) error("trailing JSON content");
  return parsed;
}

function parseCanonicalJsonV1(bytes) {
  if (!Buffer.isBuffer(bytes) && typeof bytes !== "string") {
    fail("canonical-json-v1 input must be bytes or text");
  }
  const originalBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes, "utf8");
  const text = originalBytes.toString("utf8");
  if (!text.endsWith("\n") || text.endsWith("\n\n")) {
    fail("canonical-json-v1 whole file must end with exactly one LF");
  }
  const body = text.slice(0, -1);
  const value = parseJsonDuplicateAware(body);
  const canonicalBytes = Buffer.from(`${canonicalJsonV1(value)}\n`, "utf8");
  if (!canonicalBytes.equals(originalBytes)) fail("non-canonical JSON or invalid UTF-8 bytes");
  return value;
}

function parseRequestJson(text) {
  if (typeof text !== "string") fail("CLI request transport must be text");
  const value = parseJsonDuplicateAware(text);
  assertObject(value, "CLI request");
  return value;
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeRepoRelativePath({ repoRoot, candidatePath, platform = process.platform, semanticFailureCode = null }) {
  assertString(repoRoot, "repoRoot");
  assertString(candidatePath, "candidatePath");
  const rejectPath = (message) => {
    if (semanticFailureCode !== null) throw new CoreFailure(semanticFailureCode, message);
    fail(message);
  };
  if (candidatePath.includes("\0")) rejectPath("candidatePath contains NUL");
  if (candidatePath.startsWith("/") || /^[A-Za-z]:/.test(candidatePath) || /^[\\/]{2}/.test(candidatePath)) {
    rejectPath("candidatePath must be repo-relative");
  }
  const rawSegments = candidatePath.split(/[\\/]/);
  if (rawSegments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    rejectPath("candidatePath contains traversal or non-canonical segments");
  }
  if (platform !== "win32" && candidatePath.includes("\\")) {
    rejectPath("candidatePath must use canonical '/' separators");
  }
  const canonicalPath = rawSegments.join("/");
  const root = realpathSync(repoRoot);
  const unresolvedTarget = path.join(root, ...rawSegments);
  let ancestor = unresolvedTarget;
  while (true) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) rejectPath("cannot establish nearest existing ancestor containment");
      ancestor = parent;
    }
  }
  const resolvedAncestor = realpathSync(ancestor);
  if (!insideRoot(root, resolvedAncestor)) rejectPath("candidatePath resolves outside repo root");
  return canonicalPath;
}

function git(repoRoot, args, options = {}) {
  try {
    return retryOnTransientGitIo(() => execFileSync("git", args, {
      cwd: repoRoot,
      encoding: options.encoding ?? "utf8",
      stdio: options.stdio,
      ...options,
    }));
  } catch (error) {
    // Keep the process error untyped. D30's writer deliberately maps it to
    // unexpected-io-fault without serializing stderr or exception metadata.
    throw error;
  }
}

function selectedGitOps(injected) {
  return injected ?? REAL_GIT_OPS;
}

const GIT_OPERATION_CONTEXTS = new WeakMap();

function operationRepoIdentity(repoRoot) {
  return realpathSync(repoRoot);
}

function operationObjectFormat(context, repoRoot) {
  const repoIdentity = operationRepoIdentity(repoRoot);
  if (!context.objectFormats.has(repoIdentity)) {
    const objectFormat = git(repoRoot, ["rev-parse", "--show-object-format"]).trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      fail(`unsupported Git object format: ${objectFormat}`);
    }
    context.objectFormats.set(repoIdentity, objectFormat);
  }
  return context.objectFormats.get(repoIdentity);
}

function verifyGitBlobBytes({ oid, bytes, objectFormat }) {
  if (!Buffer.isBuffer(bytes)) fail("Git blob read did not return bytes");
  const expectedOid = createHash(objectFormat)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (expectedOid !== oid) fail("Git blob bytes do not match the selected OID");
}

function createOperationGitOps(injected) {
  const source = selectedGitOps(injected);
  const context = {
    objectFormats: new Map(),
    treeBytes: new Map(),
    treeListings: new Map(),
    treeFileBytes: new Map(),
    parsedTreeRecords: new Map(),
    blobBytes: new Map(),
    historicalRiskDigests: new Map(),
    notesRoots: new Map(),
    mergeBases: new Map(),
    ancestorPairs: new Set(),
    equivalentReanchorBases: new Map(),
  };
  const operation = Object.freeze({
    readExactTreeRecord(input) {
      const repoIdentity = operationRepoIdentity(input.repoRoot);
      const objectFormat = operationObjectFormat(context, input.repoRoot);
      const key = `${repoIdentity}\0${objectFormat}\0${input.headSha}\0${input.path}`;
      if (!context.treeBytes.has(key)) {
        const bytes = source.readExactTreeRecord(input);
        if (!Buffer.isBuffer(bytes)) return bytes;
        context.treeBytes.set(key, Buffer.from(bytes));
      }
      return Buffer.from(context.treeBytes.get(key));
    },
    readTreeRecordsUnderPath(input) {
      const key = `${operationRepoIdentity(input.repoRoot)}\0${input.headSha}\0${input.path}`;
      if (!context.treeListings.has(key)) {
        const bytes = source.readTreeRecordsUnderPath(input);
        if (!Buffer.isBuffer(bytes)) return bytes;
        context.treeListings.set(key, Buffer.from(bytes));
      }
      return Buffer.from(context.treeListings.get(key));
    },
    readBlobByOid(input) {
      const repoIdentity = operationRepoIdentity(input.repoRoot);
      const objectFormat = operationObjectFormat(context, input.repoRoot);
      const key = `${repoIdentity}\0${objectFormat}\0${input.oid}`;
      const oidPattern = objectFormat === "sha1" ? HEX_40 : objectFormat === "sha256" ? HEX_64 : null;
      if (oidPattern === null || !oidPattern.test(input.oid)) fail("Git blob OID has wrong object format");
      const cached = context.blobBytes.get(key);
      const bytes = cached === undefined ? source.readBlobByOid(input) : cached;
      verifyGitBlobBytes({ oid: input.oid, bytes, objectFormat });
      if (cached === undefined) context.blobBytes.set(key, Buffer.from(bytes));
      return Buffer.from(bytes);
    },
    mergeBase(input) {
      const cacheable = isExactObjectSha(input.leftSha) && isExactObjectSha(input.rightSha);
      const key = cacheable
        ? `${operationRepoIdentity(input.repoRoot)}\0${input.leftSha}\0${input.rightSha}`
        : null;
      if (key !== null && context.mergeBases.has(key)) return context.mergeBases.get(key);
      const result = source.mergeBase(input);
      if (key !== null && isExactObjectSha(result)) context.mergeBases.set(key, result);
      return result;
    },
    isAncestor(input) {
      const cacheable = isExactObjectSha(input.ancestorSha) && isExactObjectSha(input.descendantSha);
      const key = cacheable
        ? `${operationRepoIdentity(input.repoRoot)}\0${input.ancestorSha}\0${input.descendantSha}`
        : null;
      if (key !== null && context.ancestorPairs.has(key)) return true;
      const result = source.isAncestor(input);
      if (key !== null && result === true) context.ancestorPairs.add(key);
      return result;
    },
  });
  GIT_OPERATION_CONTEXTS.set(operation, context);
  return operation;
}

function gitOperationContext(gitOps) {
  return GIT_OPERATION_CONTEXTS.get(gitOps);
}

function requiredOperationGitOps(gitOps) {
  const ops = selectedGitOps(gitOps);
  if (gitOperationContext(ops) === undefined) fail("Git blob authority requires an operation-local boundary");
  return ops;
}

function assertGitOps(value) {
  assertExactKeys(value, ["readExactTreeRecord", "readTreeRecordsUnderPath", "readBlobByOid", "mergeBase", "isAncestor"], "core gitOps");
  for (const name of ["readExactTreeRecord", "readTreeRecordsUnderPath", "readBlobByOid", "mergeBase", "isAncestor"]) {
    if (typeof value[name] !== "function") fail(`core gitOps.${name} must be a function`);
  }
}

function gitObjectHexPattern(repoRoot, gitOps) {
  const context = gitOperationContext(gitOps);
  const objectFormat = context === undefined
    ? git(repoRoot, ["rev-parse", "--show-object-format"]).trim()
    : operationObjectFormat(context, repoRoot);
  if (objectFormat === "sha1") return /^[0-9a-f]{40}$/u;
  if (objectFormat === "sha256") return /^[0-9a-f]{64}$/u;
  fail(`unsupported Git object format: ${objectFormat}`);
}

// Route-scoped closed enum for classifyBoundedRereview()'s risk_shape_unavailable
// route (fix-risk-shape-unavailable-diagnostics). Human-diagnosis-only: MUST NOT
// become a named export, MUST NOT enter DISPATCH_RESULT_KEYS or logicalDispatch()'s
// digest input, and MUST NOT be read as a routing signal (see cliHelp()'s
// risk_shape_debug_reason section). Mirrors the closed-enum shape of the sibling
// FULL_REOPEN_DEBUG_REASONS (below, fix-classify-bounded-diagnostics).
const RISK_SHAPE_DEBUG_REASONS = Object.freeze({
  CARRIER_NOT_AT_HEAD: "carrier_not_at_head",
  SECTION_SHAPE_INVALID: "section_shape_invalid",
  FRONT_MATTER_INVALID: "front_matter_invalid",
  CHANGE_FOLDER_INVALID: "change_folder_invalid",
  CAPABILITY_DELTA_INVALID: "capability_delta_invalid",
  CARRIER_INTEGRITY_UNSAFE: "carrier_integrity_unsafe",
  REQUEST_OR_GIT_AUTHORITY_INVALID: "request_or_git_authority_invalid",
  UNCLASSIFIED_FAULT: "unclassified_fault",
});

// Fault-scope marks live out-of-band in a WeakMap keyed by the thrown error object
// itself -- never on the error object (no new property, no error class change) and
// never derived from error.message/.stack -- so risk_shape_debug_reason can never
// leak raw fail() text (FR4/NFR2) and every other catch site is unaffected. Marking
// is set-if-absent: nested try/catch scopes unwind innermost-first, so the first
// (most specific) mark wins and an enclosing default mark is a no-op (design.md D2/D3).
const RISK_SHAPE_FAULT_SCOPE = new WeakMap();

function markRiskShapeFault(error, reason) {
  if (error !== null && typeof error === "object" && !RISK_SHAPE_FAULT_SCOPE.has(error)) {
    RISK_SHAPE_FAULT_SCOPE.set(error, reason);
  }
  return error;
}

function riskShapeFaultReason(error) {
  if (error === null || typeof error !== "object") return RISK_SHAPE_DEBUG_REASONS.UNCLASSIFIED_FAULT;
  return RISK_SHAPE_FAULT_SCOPE.get(error) ?? RISK_SHAPE_DEBUG_REASONS.UNCLASSIFIED_FAULT;
}

// For the small number of stations whose group differs from the group their
// enclosing withRiskShapeFaultScope() call would otherwise assign by default
// (design.md D2's "顯式標記" rows). Does not change fail()'s bare-Error contract.
function failRiskShape(message, reason) {
  throw markRiskShapeFault(new Error(message), reason);
}

// Wraps one of the ~11 risk-shape call-boundary marking points from design.md D2:
// on catch, mark the thrown error with this station's default group (set-if-absent)
// and rethrow unchanged so every other catch site keeps its existing behavior.
function withRiskShapeFaultScope(reason, action) {
  try {
    return action();
  } catch (error) {
    markRiskShapeFault(error, reason);
    throw error;
  }
}

function parseExactTreeRecord({ repoRoot, repoRelativePath, bytes, gitOps }) {
  if (!Buffer.isBuffer(bytes)) fail("historical tree lookup did not return bytes");
  if (bytes.length === 0) failRiskShape("historical tree record is missing", RISK_SHAPE_DEBUG_REASONS.CARRIER_NOT_AT_HEAD);
  const terminators = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) terminators.push(index);
  }
  if (terminators.length !== 1 || terminators[0] !== bytes.length - 1) {
    fail(terminators.length === 0
      ? "historical tree record is not NUL terminated"
      : "historical tree lookup returned duplicate or multiple records");
  }
  const record = strictUtf8Bytes(bytes.subarray(0, -1));
  const match = record.match(/^([0-9]{6}) ([a-z]+) ([0-9a-f]+)\t(.+)$/u);
  if (!match) fail("historical tree record is malformed");
  const [, mode, type, oid, recordPath] = match;
  if (recordPath !== repoRelativePath) fail("historical tree record path mismatch");
  const canonicalPath = assertSafeRepoRelativePath({ repoRoot, candidatePath: recordPath });
  if (canonicalPath !== recordPath) fail("historical tree record path is not canonical");
  if (mode !== "100644" || type !== "blob") {
    fail(`historical risk carrier must be exact 100644 blob, got ${mode} ${type}`);
  }
  if (!gitObjectHexPattern(repoRoot, gitOps).test(oid)) fail("historical tree record OID has wrong object format");
  return { mode, type, oid, path: recordPath };
}

function currentHead(repoRoot) {
  return git(repoRoot, ["rev-parse", "HEAD"]).trim();
}

function resolvedMain(repoRoot) {
  // Receipt main tip SSOT: exact-ref remote-tracking tip homologous with
  // PR/reviewer three-dot base. MUST NOT fall back to `rev-parse main`, bare
  // `origin/main`, or `rev-parse refs/remotes/origin/main` (namespace fallback
  // can hit refs/tags/refs/remotes/origin/main when the remote-tracking tip is
  // missing).
  try {
    return retryOnTransientGitIo(() => execFileSync("git", ["show-ref", "--verify", "--hash", "refs/remotes/origin/main"], {
      cwd: repoRoot,
      encoding: "utf8",
    })).trim();
  } catch (error) {
    fail(
      `Git authority check failed: refs/remotes/origin/main remote-tracking tip unavailable: ${
        error?.stderr?.toString?.().trim() || error.message
      }`,
    );
  }
}

function riskFsOps(injected) {
  const selected = {};
  for (const [name, implementation] of Object.entries(REAL_RISK_FS_OPS)) {
    selected[name] = typeof injected?.[name] === "function" ? injected[name] : implementation;
  }
  return selected;
}

function strictUtf8Bytes(bytes, label = "risk-shape carrier") {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} contains invalid UTF-8`);
  }
}

function statIdentity(metadata) {
  const known = (value) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    || (typeof value === "bigint" && value > 0n);
  if (!known(metadata.dev) || !known(metadata.ino)) fail("risk-shape carrier identity is unavailable");
  return `${metadata.dev}:${metadata.ino}`;
}

function statTimestamp(metadata, name) {
  const nanoseconds = metadata[`${name}Ns`];
  if (typeof nanoseconds === "bigint") return `ns:${nanoseconds}`;
  const milliseconds = metadata[`${name}Ms`];
  if (typeof milliseconds === "bigint" || (typeof milliseconds === "number" && Number.isFinite(milliseconds))) {
    return `ms:${milliseconds}`;
  }
  const date = metadata[name];
  if (date instanceof Date && Number.isFinite(date.getTime())) return `date:${date.getTime()}`;
  fail(`risk-shape carrier ${name} identity is unavailable`);
}

function assertSameOpenedObject(pathMetadata, handleMetadata) {
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || !handleMetadata.isFile()) {
    fail("risk-shape carrier must remain one regular non-symlink object");
  }
  if (statIdentity(pathMetadata) !== statIdentity(handleMetadata)) {
    fail("risk-shape pre-path and opened-handle identities differ");
  }
}

function assertStableHandle(preRead, postRead, expectedLength) {
  if (!preRead.isFile() || !postRead.isFile()
    || statIdentity(preRead) !== statIdentity(postRead)
    || preRead.mode !== postRead.mode
    || preRead.size !== postRead.size
    || statTimestamp(preRead, "mtime") !== statTimestamp(postRead, "mtime")
    || statTimestamp(preRead, "ctime") !== statTimestamp(postRead, "ctime")) {
    fail("risk-shape pinned carrier identity or metadata changed during read");
  }
  if (typeof preRead.size !== "bigint" || preRead.size < 0n || preRead.size > BigInt(Number.MAX_SAFE_INTEGER)
    || Number(preRead.size) !== expectedLength) {
    fail("risk-shape pinned carrier size or read length is unsafe");
  }
}

function gitObjectBytesFromRecord({
  repoRoot,
  candidateHead,
  repoRelativePath,
  gitOps,
  readRecordBytes,
}) {
  assertSha(candidateHead, "risk-shape candidate HEAD");
  const canonicalPath = assertSafeRepoRelativePath({ repoRoot, candidatePath: repoRelativePath });
  if (canonicalPath !== repoRelativePath) fail("risk-shape Git object path is not canonical");
  const ops = requiredOperationGitOps(gitOps);
  const context = gitOperationContext(ops);
  const objectFormat = context === undefined ? "" : operationObjectFormat(context, repoRoot);
  const recordKey = `${operationRepoIdentity(repoRoot)}\0${objectFormat}\0${candidateHead}\0${repoRelativePath}`;
  let record = context?.parsedTreeRecords.get(recordKey);
  if (record === undefined) {
    record = parseExactTreeRecord({
      repoRoot,
      repoRelativePath,
      bytes: readRecordBytes(ops),
      gitOps: ops,
    });
    context?.parsedTreeRecords.set(recordKey, record);
  }
  const bytes = ops.readBlobByOid({ repoRoot, oid: record.oid });
  if (!Buffer.isBuffer(bytes)) fail("risk-shape Git object read did not return bytes");
  return bytes;
}

function gitObjectBytes(repoRoot, candidateHead, repoRelativePath, injectedGitOps) {
  return gitObjectBytesFromRecord({
    repoRoot,
    candidateHead,
    repoRelativePath,
    gitOps: injectedGitOps,
    readRecordBytes: (ops) => ops.readExactTreeRecord({
      repoRoot,
      headSha: candidateHead,
      path: repoRelativePath,
    }),
  });
}

function reviewerBoundHeadObjectBytes(repoRoot, candidateHead, repoRelativePath, gitOps) {
  try {
    return gitObjectBytes(repoRoot, candidateHead, repoRelativePath, gitOps);
  } catch (error) {
    // A successful `ls-tree` with no record proves that the reviewer's bound
    // carrier/evidence path is absent. Keep native Git/spawn faults untyped.
    if (riskShapeFaultReason(error) === RISK_SHAPE_DEBUG_REASONS.CARRIER_NOT_AT_HEAD) {
      error[CORE_DOMAIN_PREDICATE] = true;
    }
    throw error;
  }
}

function historicalTreeListing({ repoRoot, candidateHead, gitOps }) {
  const rootPath = "openspec/changes";
  const ops = selectedGitOps(gitOps);
  const raw = ops.readTreeRecordsUnderPath({ repoRoot, headSha: candidateHead, path: rootPath });
  if (!Buffer.isBuffer(raw)) fail("historical tree listing did not return bytes");
  const records = strictUtf8Bytes(raw, "historical tree listing").split("\0");
  if (records.pop() !== "") fail("historical tree listing is not NUL terminated");
  const recordBytesByPath = new Map();
  for (const record of records) {
    const match = record.match(/^([0-9]{6}) ([a-z]+) ([0-9a-f]+)\t(.+)$/u);
    if (!match) fail("historical tree listing record is malformed");
    const recordPath = match[4];
    if (recordPath !== rootPath && !recordPath.startsWith(`${rootPath}/`)) {
      fail("historical tree listing record escapes the requested root");
    }
    const canonicalPath = assertSafeRepoRelativePath({ repoRoot, candidatePath: recordPath });
    if (canonicalPath !== recordPath) fail("historical tree listing record path is not canonical");
    if (recordBytesByPath.has(recordPath)) fail("historical tree listing returned a duplicate path");
    recordBytesByPath.set(recordPath, Buffer.from(`${record}\0`));
  }
  return { ops, paths: [...recordBytesByPath.keys()], recordBytesByPath };
}

function pinnedRiskFile({ filePath, changeRoot, repoRoot, candidateHead, fsOps, gitOps }) {
  const ops = riskFsOps(fsOps);
  const root = ops.realpathSync(changeRoot);
  const repo = ops.realpathSync(repoRoot);
  const lexical = path.resolve(filePath);
  if (!insideRoot(root, lexical) || !insideRoot(repo, lexical)) fail("risk-shape carrier lexical path escapes its authority root");
  const parent = ops.realpathSync(path.dirname(lexical));
  const resolved = ops.realpathSync(lexical);
  if (!insideRoot(root, parent) || !insideRoot(root, resolved)
    || !insideRoot(repo, parent) || !insideRoot(repo, resolved)) {
    fail("risk-shape carrier realpath escapes its authority root");
  }
  const pathMetadata = ops.lstatSync(lexical, { bigint: true });
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    fail("risk-shape carrier must be a regular non-symlink file");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = ops.openSync(lexical, fsConstants.O_RDONLY | noFollow);
    const preRead = ops.fstatSync(handle, { bigint: true });
    assertSameOpenedObject(pathMetadata, preRead);
    if (typeof preRead.size !== "bigint" || preRead.size < 0n || preRead.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("risk-shape pinned carrier size is unsafe");
    }
    const expectedLength = Number(preRead.size);
    const bytes = Buffer.alloc(expectedLength);
    let offset = 0;
    while (offset < expectedLength) {
      const read = ops.readSync(handle, bytes, offset, expectedLength - offset, offset);
      if (!Number.isSafeInteger(read) || read <= 0 || read > expectedLength - offset) {
        fail("risk-shape pinned carrier read was short or invalid");
      }
      offset += read;
    }
    const postRead = ops.fstatSync(handle, { bigint: true });
    assertStableHandle(preRead, postRead, offset);
    const repoRelativePath = path.relative(repo, lexical).split(path.sep).join("/");
    if (repoRelativePath.startsWith("../") || path.isAbsolute(repoRelativePath)
      || !bytes.equals(gitObjectBytes(repo, candidateHead, repoRelativePath, gitOps))) {
      failRiskShape("risk-shape pinned bytes differ from candidate HEAD Git object", RISK_SHAPE_DEBUG_REASONS.CARRIER_NOT_AT_HEAD);
    }
    return strictUtf8Bytes(bytes);
  } finally {
    if (handle !== undefined) ops.closeSync(handle);
  }
}

function normalizedBlock(text) {
  const lines = normalizedDocument(text).split("\n");
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function normalizedDocument(text) {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    .split("\n").map((line) => line.replace(/[\t ]+$/u, "")).join("\n");
}

function exactHeadingBlock(text, heading, { endHeading = null } = {}) {
  const normalized = normalizedDocument(text);
  /** @type {number[]} */
  const starts = [];
  forEachMarkdownLine(normalized, (line, index, { inFence }) => {
    if (!inFence && line === heading) starts.push(index);
  });
  if (starts.length !== 1) fail(`risk-shape heading is missing or duplicate: ${heading}`);
  const span = findExactHeadingSpan(normalized, heading, { endHeading });
  if (span === null) {
    fail(endHeading !== null
      ? `risk-shape end heading is missing, duplicate, or reordered: ${endHeading}`
      : `risk-shape heading is missing or duplicate: ${heading}`);
  }
  return normalizedBlock(span.lines.slice(span.start, span.end).join("\n"));
}

// Aligned with lint-risk-classes-record.mjs / OpenSpec template front matter:
// `risk_classes: [auth,...]` single-line flow list OR `risk_classes: none` + substantive
// `rationale:` second line. none+rationale → empty `risk_classes: []` in the risk-shape
// snapshot so classify-bounded can derive dispatch authority (same shape lint accepts).
function parseRiskClasses(proposal) {
  const parsed = parseRiskClassesFrontMatter(proposal);
  if (parsed.status === "declared") {
    if (parsed.value.kind === "none") {
      return [];
    }
    return parsed.normalized.split(",");
  }
  if (parsed.status === "undeclared" || parsed.status === "no-declaration") {
    fail("risk-shape proposal requires leading YAML front matter");
  }
  fail(parsed.detail ?? "risk_classes front matter is malformed");
}

function validateTouchBoundary(block) {
  const lines = block.split("\n");
  const tableLines = lines.filter((line) => line.startsWith("|"));
  if (tableLines.length < 3
    || tableLines[0].split("|").slice(1, -1).map((cell) => cell.trim()).join("|") !== "檔案|類別|動作|Requirement"
    || !/^\|(?:\s*:?-+:?\s*\|){4}$/u.test(tableLines[1])) {
    fail("risk-shape Touch table is missing or unclosed");
  }
  const carriers = new Map();
  for (const row of tableLines.slice(2)) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 4 || cells.some((cell) => cell === "")) fail("risk-shape Touch row is incomplete");
    const previous = carriers.get(cells[0]);
    const canonicalRow = canonicalJsonV1(cells);
    if (previous !== undefined && previous !== canonicalRow) fail("risk-shape Touch carrier has conflicting rows");
    carriers.set(cells[0], canonicalRow);
  }
}

function validatePhysicalTouchHeader(proposal, heading) {
  // CRLF-only normalize: trailing horizontal whitespace on the physical table
  // header must remain visible so the exact-spacing contract can reject it.
  const lines = proposal.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  /** @type {number[]} */
  const starts = [];
  forEachMarkdownLine(lines.join("\n"), (line, index, { inFence }) => {
    if (!inFence && line.replace(/[\t ]+$/u, "") === heading) starts.push(index);
  });
  if (starts.length !== 1) fail(`risk-shape heading is missing or duplicate: ${heading}`);
  let end = lines.length;
  /** @type {{ char: string, length: number } | null} */
  let openFence = null;
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (openFence !== null) {
      const delim = fenceDelimiter(line);
      if (delim && closesFence(delim, openFence)) openFence = null;
      continue;
    }
    const delim = fenceDelimiter(line);
    if (delim) {
      openFence = delim;
      continue;
    }
    if (/^## (?!#)/u.test(line.replace(/[\t ]+$/u, ""))) {
      end = index;
      break;
    }
  }
  const tableHeader = lines.slice(starts[0] + 1, end).find((line) => line.startsWith("|"));
  if (tableHeader !== "| 檔案 | 類別 | 動作 | Requirement |") {
    fail("risk-shape Touch physical header must exactly match the canonical header");
  }
}

function parseCapabilityRequirementDocuments(documents) {
  const requirements = [];
  for (const { capability, text: spec } of documents) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(capability)) fail("invalid risk capability directory");
    const lines = normalizedDocument(spec).split("\n");
    let mode = null;
    const seen = new Set();
    for (const line of lines) {
      const modeMatch = line.match(/^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements$/u);
      if (modeMatch) {
        mode = modeMatch[1];
        continue;
      }
      const requirementMatch = line.match(/^### Requirement: (.+)$/u);
      if (requirementMatch) {
        if (mode === null) fail("risk capability requirement is outside a delta mode");
        const title = normalizedBlock(requirementMatch[1]);
        const key = `${mode}\0${title}`;
        if (seen.has(key)) fail("duplicate risk capability requirement");
        seen.add(key);
        requirements.push({ capability, delta_mode: mode, requirement_title: title });
      }
    }
  }
  return requirements.sort((left, right) => compareCodePoints(
    `${left.capability}\0${left.delta_mode}\0${left.requirement_title}`,
    `${right.capability}\0${right.delta_mode}\0${right.requirement_title}`,
  ));
}

function currentCapabilityDocuments({ changeRoot, repoRoot, candidateHead, fsOps, gitOps }) {
  const ops = riskFsOps(fsOps);
  const specsRoot = path.join(changeRoot, "specs");
  let capabilityNames;
  try {
    capabilityNames = ops.readdirSync(specsRoot).sort(compareCodePoints);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const documents = [];
  for (const capability of capabilityNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(capability)) fail("invalid risk capability directory");
    const capabilityRoot = path.join(specsRoot, capability);
    const metadata = ops.lstatSync(capabilityRoot, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !insideRoot(changeRoot, ops.realpathSync(capabilityRoot))) {
      fail("risk capability directory escapes change root");
    }
    const specPath = path.join(capabilityRoot, "spec.md");
    let specExists = true;
    try {
      ops.lstatSync(specPath, { bigint: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      specExists = false;
    }
    if (!specExists) {
      failRiskShape(`risk capability '${capability}' is missing spec.md`, RISK_SHAPE_DEBUG_REASONS.CHANGE_FOLDER_INVALID);
    }
    documents.push({
      capability,
      text: withRiskShapeFaultScope(RISK_SHAPE_DEBUG_REASONS.CARRIER_INTEGRITY_UNSAFE, () => pinnedRiskFile({
        filePath: specPath,
        changeRoot,
        repoRoot,
        candidateHead,
        fsOps,
        gitOps,
      })),
    });
  }
  return documents;
}

function findNearMissDecisionHeadings(decisionsBlock) {
  const nearMisses = [];
  for (const line of decisionsBlock.split("\n")) {
    if (!/^###\s/u.test(line)) continue;
    if (/^### D([1-9][0-9]*) — (.+)$/u.test(line)) continue;
    // Near-miss: looks like a D-number decision heading but is not the strict
    // em-dash form (bare `### D1`, `### D1:…`, `### D1：…`, missing title, …).
    if (/^###\s*D[1-9][0-9]*/u.test(line)) nearMisses.push(line);
  }
  return nearMisses;
}

function parseArchitectureDecisions(design) {
  const decisions = exactHeadingBlock(design, "## Decisions");
  const nearMisses = findNearMissDecisionHeadings(decisions);
  if (nearMisses.length > 0) {
    fail(
      "標題格式不對: ## Decisions headings must be `### D<n> — <title>` (ASCII em-dash + non-empty title); "
      + `near-miss: ${nearMisses.join(" | ")}`,
    );
  }
  const lines = decisions.split("\n");
  const starts = [];
  for (let index = 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^### D([1-9][0-9]*) — (.+)$/u);
    if (match) starts.push({ index, number: Number(match[1]) });
  }
  if (starts.length === 0 || new Set(starts.map(({ number }) => number)).size !== starts.length) {
    fail("risk-shape Decisions require unique D-number blocks");
  }
  return starts.map((entry, index) => {
    const block = normalizedBlock(lines.slice(entry.index, starts[index + 1]?.index ?? lines.length).join("\n"));
    if (block.split("\n").slice(1).every((line) => line === "")) fail("risk-shape decision block is empty");
    return { number: entry.number, block };
  }).sort((left, right) => left.number - right.number);
}

function parseSafetyObligations(proposal) {
  const consequence = exactHeadingBlock(proposal, "## Consequence Assessment");
  const rows = consequence.split("\n").filter((line) => line.startsWith("|"));
  const wanted = ["Security/trust/privacy/data", "Material negatives/non-goals"];
  const selected = [];
  for (const dimension of wanted) {
    const matches = rows.filter((line) => line.split("|").slice(1, -1)[0]?.trim() === dimension);
    if (matches.length !== 1) fail(`risk-shape consequence row is missing or duplicate: ${dimension}`);
    selected.push(normalizedBlock(matches[0]));
  }
  selected.push(exactHeadingBlock(proposal, "## Risk Classes and Material Negatives"));
  return selected;
}

function resolveRiskChangeRoot(repoRoot, changeId, fsOps) {
  const ops = riskFsOps(fsOps);
  const repo = ops.realpathSync(repoRoot);
  const changesRoot = path.join(repo, "openspec", "changes");
  const active = path.join(changesRoot, changeId);
  let activeExists = false;
  try {
    const metadata = ops.lstatSync(active, { bigint: true });
    activeExists = true;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !insideRoot(repo, ops.realpathSync(active))) {
      fail("active risk-shape change directory is unsafe");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const archiveRoot = path.join(changesRoot, "archive");
  let archives = [];
  try {
    archives = ops.readdirSync(archiveRoot)
      .filter((name) => /^\d{4}-\d{2}-\d{2}-/u.test(name) && name.slice(11) === changeId)
      .sort(compareCodePoints);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (activeExists && archives.length > 0) fail("active and archived risk-shape authorities are ambiguous");
  const selected = activeExists ? active : archives.length > 0 ? path.join(archiveRoot, archives.at(-1)) : null;
  if (selected === null) fail("risk-shape change artifact is missing");
  const metadata = ops.lstatSync(selected, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !insideRoot(repo, ops.realpathSync(selected))) {
    fail("risk-shape change directory is unsafe");
  }
  return ops.realpathSync(selected);
}

function resolveRiskShapeDigestAlg(value) {
  if (value === undefined || value === null || value === "") return RISK_SHAPE_DIGEST_ALG_LEGACY;
  if (value === RISK_SHAPE_DIGEST_ALG_V1 || value === RISK_SHAPE_DIGEST_ALG_LEGACY) return value;
  fail(`unsupported risk_shape_digest_alg: ${value}`);
}

function parseTouchPathToken(cell) {
  const tick = cell.match(/`([^`]+)`/u);
  let token = (tick ? tick[1] : cell).trim();
  token = token.replace(/\s*≈:\d+.*$/u, "").trim();
  if (token.length === 0) fail("risk-shape Touch path token is empty");
  return token;
}

function parseTouchStructuredRows(touchBoundary) {
  validateTouchBoundary(touchBoundary);
  const lines = touchBoundary.split("\n");
  const tableLines = lines.filter((line) => line.startsWith("|"));
  const rows = [];
  for (const row of tableLines.slice(2)) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 4 || cells.some((cell) => cell === "")) fail("risk-shape Touch row is incomplete");
    const requirementIds = cells[3]
      .split(/[,\s]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .sort(compareCodePoints);
    rows.push({
      path: parseTouchPathToken(cells[0]),
      category: cells[1],
      action: cells[2],
      requirement_ids: requirementIds,
    });
  }
  return rows.sort((left, right) => compareCodePoints(
    `${left.path}\0${left.category}\0${left.action}\0${left.requirement_ids.join(",")}`,
    `${right.path}\0${right.category}\0${right.action}\0${right.requirement_ids.join(",")}`,
  ));
}

function fullProseRiskSnapshotFromDocuments({ changeId, full, proposal, design, capabilityDocuments }) {
  const targetState = exactHeadingBlock(proposal, full
    ? "## Section 1: Target State (Done When)"
    : "## Target State");
  const touchHeading = full ? "## Section 2: Touch" : "## Touch";
  validatePhysicalTouchHeader(proposal, touchHeading);
  const touchBoundary = exactHeadingBlock(proposal, touchHeading, {
    endHeading: full ? "## Section 3: Tasks" : null,
  });
  validateTouchBoundary(touchBoundary);
  const snapshot = {
    schema: RISK_SHAPE_SCHEMA,
    change_id: changeId,
    risk_classes: withRiskShapeFaultScope(RISK_SHAPE_DEBUG_REASONS.FRONT_MATTER_INVALID, () => parseRiskClasses(proposal)),
    target_state: targetState,
    capabilities: {
      proposal_block: full ? exactHeadingBlock(proposal, "## Capabilities") : "",
      requirement_tuples: withRiskShapeFaultScope(
        RISK_SHAPE_DEBUG_REASONS.CAPABILITY_DELTA_INVALID,
        () => parseCapabilityRequirementDocuments(capabilityDocuments),
      ),
    },
    touch_boundary: touchBoundary,
    architecture_decisions: [],
    safety_obligations: [],
  };
  if (full) {
    if (design === null) failRiskShape("full risk-shape design is missing", RISK_SHAPE_DEBUG_REASONS.CHANGE_FOLDER_INVALID);
    snapshot.architecture_decisions = parseArchitectureDecisions(design);
    snapshot.safety_obligations = parseSafetyObligations(proposal);
  }
  return snapshot;
}

function behaviorRiskSnapshotFromDocuments({ changeId, full, proposal, design, capabilityDocuments }) {
  // Target State must still exist for section-shape validation, but its prose
  // is excluded from the behavior-risk digest (doc-only must not force full).
  exactHeadingBlock(proposal, full
    ? "## Section 1: Target State (Done When)"
    : "## Target State");
  const touchHeading = full ? "## Section 2: Touch" : "## Touch";
  validatePhysicalTouchHeader(proposal, touchHeading);
  const touchBoundary = exactHeadingBlock(proposal, touchHeading, {
    endHeading: full ? "## Section 3: Tasks" : null,
  });
  const touchRows = parseTouchStructuredRows(touchBoundary);
  const snapshot = {
    schema: RISK_SHAPE_SCHEMA,
    digest_alg: RISK_SHAPE_DIGEST_ALG_V1,
    change_id: changeId,
    risk_classes: withRiskShapeFaultScope(RISK_SHAPE_DEBUG_REASONS.FRONT_MATTER_INVALID, () => parseRiskClasses(proposal)),
    capabilities: {
      requirement_tuples: withRiskShapeFaultScope(
        RISK_SHAPE_DEBUG_REASONS.CAPABILITY_DELTA_INVALID,
        () => parseCapabilityRequirementDocuments(capabilityDocuments),
      ),
    },
    touch_rows: touchRows,
    architecture_decisions: [],
    safety_obligations: [],
  };
  if (full) {
    if (design === null) failRiskShape("full risk-shape design is missing", RISK_SHAPE_DEBUG_REASONS.CHANGE_FOLDER_INVALID);
    // Capabilities proposal_block is full-only prose authority for full-prose-v0;
    // behavior-risk keeps requirement_tuples only, but the heading must exist.
    exactHeadingBlock(proposal, "## Capabilities");
    snapshot.architecture_decisions = parseArchitectureDecisions(design);
    snapshot.safety_obligations = parseSafetyObligations(proposal);
  }
  return snapshot;
}

function riskShapeSnapshotFromDocuments(args) {
  return behaviorRiskSnapshotFromDocuments(args);
}

function riskShapeSnapshotFromDocumentsForAlg(args, digestAlg) {
  const alg = resolveRiskShapeDigestAlg(digestAlg);
  return alg === RISK_SHAPE_DIGEST_ALG_V1
    ? behaviorRiskSnapshotFromDocuments(args)
    : fullProseRiskSnapshotFromDocuments(args);
}

function deriveRiskShapeSnapshot({ repoRoot, changeId, candidateHead = currentHead(repoRoot), fsOps, gitOps }) {
  assertChangeId(changeId);
  const ops = riskFsOps(fsOps);
  const changeRoot = withRiskShapeFaultScope(
    RISK_SHAPE_DEBUG_REASONS.CHANGE_FOLDER_INVALID,
    () => resolveRiskChangeRoot(repoRoot, changeId, fsOps),
  );
  const fullPath = path.join(changeRoot, "proposal.md");
  const miniPath = path.join(changeRoot, "proposal-mini.md");
  const exists = (candidate) => {
    try {
      ops.lstatSync(candidate, { bigint: true });
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  const full = exists(fullPath);
  const mini = exists(miniPath);
  if (full === mini) failRiskShape("risk-shape requires exactly one full or B-mini proposal", RISK_SHAPE_DEBUG_REASONS.CHANGE_FOLDER_INVALID);
  const proposal = withRiskShapeFaultScope(RISK_SHAPE_DEBUG_REASONS.CARRIER_INTEGRITY_UNSAFE, () => pinnedRiskFile({
    filePath: full ? fullPath : miniPath,
    changeRoot,
    repoRoot,
    candidateHead,
    fsOps,
    gitOps,
  }));
  const designPath = path.join(changeRoot, "design.md");
  if (full && !exists(designPath)) {
    failRiskShape("full risk-shape design.md is absent from the change folder", RISK_SHAPE_DEBUG_REASONS.CHANGE_FOLDER_INVALID);
  }
  const design = full ? withRiskShapeFaultScope(RISK_SHAPE_DEBUG_REASONS.CARRIER_INTEGRITY_UNSAFE, () => pinnedRiskFile({
    filePath: designPath,
    changeRoot,
    repoRoot,
    candidateHead,
    fsOps,
    gitOps,
  })) : null;
  const capabilityDocuments = withRiskShapeFaultScope(
    RISK_SHAPE_DEBUG_REASONS.CAPABILITY_DELTA_INVALID,
    () => currentCapabilityDocuments({ changeRoot, repoRoot, candidateHead, fsOps, gitOps }),
  );
  return withRiskShapeFaultScope(
    RISK_SHAPE_DEBUG_REASONS.SECTION_SHAPE_INVALID,
    () => riskShapeSnapshotFromDocuments({ changeId, full, proposal, design, capabilityDocuments }),
  );
}

function historicalRiskDocuments({ repoRoot, changeId, candidateHead, gitOps }) {
  const { ops, paths, recordBytesByPath } = historicalTreeListing({
    repoRoot,
    candidateHead,
    gitOps,
  });
  const activeRoot = `openspec/changes/${changeId}`;
  const active = paths.some((entry) => entry.startsWith(`${activeRoot}/`));
  const archiveNames = new Set();
  for (const entry of paths) {
    const match = entry.match(/^openspec\/changes\/archive\/(\d{4}-\d{2}-\d{2}-.+?)\//u);
    if (match && match[1].slice(11) === changeId) archiveNames.add(match[1]);
  }
  const archives = [...archiveNames].sort(compareCodePoints);
  if (active && archives.length > 0) fail("historical active and archived risk-shape authorities are ambiguous");
  const changeRoot = active
    ? activeRoot
    : archives.length > 0 ? `openspec/changes/archive/${archives.at(-1)}` : null;
  if (changeRoot === null) fail("historical risk-shape change artifact is missing");
  const fullPath = `${changeRoot}/proposal.md`;
  const miniPath = `${changeRoot}/proposal-mini.md`;
  const full = paths.includes(fullPath);
  const mini = paths.includes(miniPath);
  if (full === mini) fail("historical risk-shape requires exactly one full or B-mini proposal");
  const readText = (repoRelativePath) => strictUtf8Bytes(gitObjectBytesFromRecord({
    repoRoot,
    candidateHead,
    repoRelativePath,
    gitOps: ops,
    readRecordBytes: () => recordBytesByPath.get(repoRelativePath) ?? Buffer.alloc(0),
  }));
  const specsPrefix = `${changeRoot}/specs/`;
  const capabilities = new Set();
  for (const entry of paths.filter((candidate) => candidate.startsWith(specsPrefix))) {
    const remainder = entry.slice(specsPrefix.length);
    const capability = remainder.split("/")[0];
    if (capability !== "") capabilities.add(capability);
  }
  const capabilityDocuments = [...capabilities].sort(compareCodePoints).map((capability) => {
    const specPath = `${specsPrefix}${capability}/spec.md`;
    if (!paths.includes(specPath)) fail("historical risk capability spec is missing");
    return { capability, text: readText(specPath) };
  });
  return {
    full,
    proposal: readText(full ? fullPath : miniPath),
    design: full ? readText(`${changeRoot}/design.md`) : null,
    capabilityDocuments,
  };
}

function deriveHistoricalRiskShapeSnapshot({ repoRoot, changeId, candidateHead, gitOps, digestAlg = RISK_SHAPE_DIGEST_ALG_V1 }) {
  assertChangeId(changeId);
  assertSha(candidateHead, "historical risk candidate HEAD");
  return riskShapeSnapshotFromDocumentsForAlg({
    changeId,
    ...historicalRiskDocuments({ repoRoot, changeId, candidateHead, gitOps }),
  }, digestAlg);
}

function deriveRiskShapeDigest(snapshot) {
  return sha256Hex(canonicalJsonV1(snapshot));
}

function deriveHistoricalRiskShapeDigest({ repoRoot, changeId, candidateHead, gitOps, digestAlg = RISK_SHAPE_DIGEST_ALG_V1 }) {
  const alg = resolveRiskShapeDigestAlg(digestAlg);
  const context = gitOperationContext(gitOps);
  const objectFormat = context === undefined ? "" : operationObjectFormat(context, repoRoot);
  const key = `${operationRepoIdentity(repoRoot)}\0${objectFormat}\0${candidateHead}\0${changeId}\0${alg}`;
  if (!context?.historicalRiskDigests.has(key)) {
    const digest = deriveRiskShapeDigest(deriveHistoricalRiskShapeSnapshot({
      repoRoot,
      changeId,
      candidateHead,
      gitOps,
      digestAlg: alg,
    }));
    context?.historicalRiskDigests.set(key, digest);
    return digest;
  }
  return context.historicalRiskDigests.get(key);
}

function currentGitAuthority(repoRoot, gitOps) {
  const targetSha = resolvedMain(repoRoot);
  const headSha = currentHead(repoRoot);
  const mergeBaseSha = selectedGitOps(gitOps).mergeBase({ repoRoot, leftSha: targetSha, rightSha: headSha });
  return {
    // Review authority follows the immutable reviewed surface, not the moving
    // target-branch tip. Parallel changes may advance main without changing
    // this branch's merge-base or diff; latest-main integration is checked by
    // the final suite's separate coverage snapshot below.
    base_sha: mergeBaseSha,
    merge_base_sha: mergeBaseSha,
    head_sha: headSha,
  };
}

/** Authorization reasons that enter the logical-dispatch digest so a sealed
 * post-cap receipt can prove whether classify issued `convergence_recovery`
 * or `handback_authorized_*` (D2). Ordinary reopen reasons stay out of the
 * digest — they are diagnostic only and must not change `dispatch_id`. */
const DIGESTED_AUTHORIZATION_REASONS = new Set([
  "convergence_recovery",
  "wording_repair_bounded",
  "handback_authorized_bounded",
  "handback_authorized_full",
]);

const HANDBACK_CAUSES = new Set([
  "requirement_conflict",
  "irreversible_high_risk",
  "reviewer_unrecoverable",
]);

const RECOVERY_DISPOSITIONS = new Set([
  "fix-now",
  "simplification",
  "non-issue-with-evidence",
]);

function authorizationReasonForDigest(reason) {
  return DIGESTED_AUTHORIZATION_REASONS.has(reason) ? reason : null;
}

function logicalDispatch({ changeId, reviewMode, roundNumber, boundedCount, gitAuthority, previousReceiptRef,
  initialFullDigest, repairManifestRef, closureManifestRef, riskDigest, authorizationReason = null }) {
  const logical = {
    schema: LOGICAL_DISPATCH_SCHEMA,
    change_id: changeId,
    review_mode: reviewMode,
    round_number: roundNumber,
    bounded_rereview_count: boundedCount,
    ...gitAuthority,
    previous_receipt_ref: previousReceiptRef,
    initial_full_receipt_digest_sha256: initialFullDigest,
    repair_delta_manifest_ref: repairManifestRef,
    dependency_closure_manifest_ref: closureManifestRef,
    risk_shape_digest_sha256: riskDigest,
  };
  if (authorizationReason !== null) {
    logical.authorization_reason = authorizationReason;
  }
  return sha256Hex(canonicalJsonV1(logical));
}

function logicalDispatchArgsFromPayload(payload, riskDigest, changeId = payload.change_id) {
  return {
    changeId,
    reviewMode: payload.review_mode,
    roundNumber: payload.round_number,
    boundedCount: payload.bounded_rereview_count,
    gitAuthority: {
      base_sha: payload.lineage.base_sha,
      merge_base_sha: payload.lineage.merge_base_sha,
      head_sha: payload.lineage.head_sha,
    },
    previousReceiptRef: payload.lineage.previous_receipt_ref,
    initialFullDigest: payload.lineage.initial_full_receipt_digest_sha256,
    repairManifestRef: payload.review_mode === "bounded" ? payload.scope.repair_delta_manifest_ref : null,
    closureManifestRef: payload.review_mode === "bounded" ? payload.scope.dependency_closure_manifest_ref : null,
    riskDigest,
  };
}

function matchAuthorizationReasonForDispatch(payload, riskDigest, changeId = payload.change_id) {
  const args = logicalDispatchArgsFromPayload(payload, riskDigest, changeId);
  if (payload.dispatch_id === logicalDispatch({ ...args, authorizationReason: null })) return null;
  for (const reason of DIGESTED_AUTHORIZATION_REASONS) {
    if (payload.dispatch_id === logicalDispatch({ ...args, authorizationReason: reason })) return reason;
  }
  return undefined;
}

function validateHistoricalReceiptAuthority({ repoRoot, changeId, payload, gitOps }) {
  const digestAlg = resolveRiskShapeDigestAlg(payload.scope.risk_shape_digest_alg);
  const historicalRiskDigest = deriveHistoricalRiskShapeDigest({
    repoRoot,
    changeId,
    candidateHead: payload.lineage.head_sha,
    gitOps,
    digestAlg,
  });
  if (payload.scope.risk_shape_digest_sha256 !== historicalRiskDigest) {
    fail("previous receipt historical risk authority mismatch");
  }
  const matched = matchAuthorizationReasonForDispatch(payload, historicalRiskDigest, changeId);
  if (matched === undefined) {
    fail("previous receipt historical logical dispatch authority mismatch");
  }
  return historicalRiskDigest;
}

function dispatchResult({ route, count, roundNumber, riskDigest, reason, changeId, gitAuthority,
  previousReceiptRef = null, initialFullDigest = null, repairManifestRef = null, closureManifestRef = null }) {
  const reviewMode = route === "bounded" ? "bounded" : "full";
  return {
    route,
    dispatch_ready: true,
    next_bounded_rereview_count: count,
    round_number: roundNumber,
    risk_shape_digest_sha256: riskDigest,
    risk_shape_digest_alg: RISK_SHAPE_DIGEST_ALG_V1,
    dispatch_id: logicalDispatch({
      changeId,
      reviewMode,
      roundNumber,
      boundedCount: count,
      gitAuthority,
      previousReceiptRef,
      initialFullDigest,
      repairManifestRef: reviewMode === "bounded" ? repairManifestRef : null,
      closureManifestRef: reviewMode === "bounded" ? closureManifestRef : null,
      riskDigest,
      authorizationReason: authorizationReasonForDigest(reason),
    }),
    full_reopen_reason: reason,
  };
}

function riskUnavailable(count, reason) {
  return {
    route: "risk_shape_unavailable",
    dispatch_ready: false,
    next_bounded_rereview_count: count,
    round_number: null,
    risk_shape_digest_sha256: null,
    risk_shape_digest_alg: null,
    dispatch_id: null,
    full_reopen_reason: "risk_shape_unavailable",
    risk_shape_debug_reason: reason,
  };
}

function derivedNotesRoot(repoRoot, gitOps, semanticSafetyCode = null, fsOps = null) {
  const resolveRealpath = fsOps?.realpathSync ?? realpathSync;
  const inspectPath = fsOps?.lstatSync ?? lstatSync;
  const makeDirectory = fsOps?.mkdirSync ?? mkdirSync;
  const rejectRoot = (message) => {
    if (semanticSafetyCode !== null) throw new CoreFailure(semanticSafetyCode, "evidence-artifact-invalid");
    throw new CoreFailure("evidence-artifact-invalid", message);
  };
  const context = gitOperationContext(gitOps);
  const repoIdentity = context === undefined ? null : operationRepoIdentity(repoRoot);
  if (repoIdentity !== null && context.notesRoots.has(repoIdentity)) {
    return context.notesRoots.get(repoIdentity);
  }
  const commonDir = git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const mainRoot = path.dirname(resolveRealpath(commonDir));
  const root = path.join(mainRoot, "notes");
  try {
    const metadata = inspectPath(root);
    if (metadata.isSymbolicLink()) rejectRoot("derived main notes root cannot be a symlink");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    makeDirectory(root, { recursive: false });
  }
  const resolvedRoot = resolveRealpath(root);
  if (!insideRoot(mainRoot, resolvedRoot)) rejectRoot("derived main notes root resolves outside main checkout");
  if (repoIdentity !== null) context.notesRoots.set(repoIdentity, resolvedRoot);
  return resolvedRoot;
}

function assertChangeId(changeId) {
  assertString(changeId, "changeId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(changeId)) fail("changeId must be a safe evidence slug");
}

/** Non-throwing probe: can `git rev-parse --git-common-dir` answer at this root? */
function callerCommonDirResolvable(callerRoot, propagateNativeFaults = false) {
  try {
    const result = spawnSync("git", ["-C", callerRoot, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (propagateNativeFaults && (result.error || result.status !== 0)) {
      throw result.error ?? new Error("unlisted Git result");
    }
    return result.status === 0 && String(result.stdout ?? "").trim().length > 0;
  } catch (error) {
    if (propagateNativeFaults) throw error;
    return false;
  }
}

function assertBindingRootPin(effectiveRoot, bindingRoot, propagateNativeFaults = false) {
  if (bindingRoot === null || bindingRoot === undefined) return;
  let pin = null;
  let resolved = null;
  try { pin = realpathSync(bindingRoot); } catch (error) {
    if (propagateNativeFaults) throw error;
    pin = null;
  }
  try { resolved = realpathSync(effectiveRoot); } catch (error) {
    if (propagateNativeFaults) throw error;
    resolved = null;
  }
  if (pin === null || resolved === null || pin !== resolved) fail("binding-root-mismatch");
}

/**
 * Consumer-side effective-root resolver (strengthen-admission-binding-portability
 * design D7.1, one shared seam — no second resolver).
 *
 * The change identity comes from the explicit caller `changeId` (optionally
 * pinned with `bindingRoot`), else the cwd fast path revalidated by the same
 * exact-one selection; the caller cwd alone MUST NOT locate the change. When
 * the exact-one selection resolves, the binding worktree root replaces the
 * caller root for every subsequent change-directory / notes / HEAD /
 * containment lookup, so a main-checkout round trip reaches the records the
 * gate wrote under `.worktree/<change_id>`.
 *
 * The back-compat window: zero candidates because the worktree was removed
 * (post-merge `git worktree remove` / prune) while the caller root still
 * locates the change directory at its active or archive location falls back to
 * that caller root rather than failing closed. Two or more candidates, a scan
 * fault, an unresolvable common-dir, or neither location holding a locatable
 * change directory still fail closed. A caller `bindingRoot` pin that does not
 * realpath-equal the resolved root fails closed with `binding-root-mismatch`
 * and never overrides the filesystem result.
 */
function resolveConsumerBinding({ repoRoot, changeId = null, bindingRoot = null, propagateNativeFaults = false, enumerationMemo } = {}) {
  const callerRoot = repoRoot;
  let key = changeId ?? null;
  if (key === null) {
    let canonicalCaller = null;
    try { canonicalCaller = realpathSync(callerRoot); } catch (error) {
      if (propagateNativeFaults) throw error;
      canonicalCaller = null;
    }
    key = canonicalCaller === null ? null : resolveChangeIdFromCwd(canonicalCaller);
  }
  if (key === null) fail("change-worktree-required");
  assertChangeId(key);
  if (!ADMISSION_CHANGE_ID_SHAPE.test(key)) {
    // Historical evidence slugs outside the canonical change_id grammar (the
    // consumer's own assert is deliberately looser) cannot name a
    // `.worktree/<id>` binding — the admission resolver would reject the id as
    // `change-id-invalid` and the enumeration could never select it — so these
    // keep the historical caller-root behavior instead of newly failing closed.
    assertBindingRootPin(callerRoot, bindingRoot, propagateNativeFaults);
    return { repoRoot: callerRoot, changeId: key };
  }
  const binding = resolveExactOneChangeWorktreeBinding({ cwd: callerRoot, changeId: key, propagateNativeFaults, enumerationMemo });
  let effectiveRoot;
  if (binding.ok) {
    effectiveRoot = binding.repoRoot;
  } else if (binding.code === "change-worktree-required" && callerCommonDirResolvable(callerRoot, propagateNativeFaults)
    && resolveAdmissionChangeDir(callerRoot, key, { propagateNativeFaults }) !== null) {
    effectiveRoot = callerRoot;
  } else {
    fail(binding.code);
  }
  assertBindingRootPin(effectiveRoot, bindingRoot, propagateNativeFaults);
  return { repoRoot: effectiveRoot, changeId: key };
}

/**
 * Graceful variant for the query surfaces (stall state, current closure
 * projection, final readiness): resolve the binding root when the
 * exact-one selection succeeds and keep the caller root only on "nowhere to
 * look" (cross-model CM-3, design D7.1／D7.2). The tolerated family is exactly
 * the closed `change-worktree-required` token — zero candidates for the lookup
 * key, no lookup key at all, or no same-common-dir to enumerate: those
 * surfaces' own state vocabulary covers an absent change, and their reads
 * then fail or report not-ready at the caller root. Every other resolution
 * fault — two or more candidates, a scan fault, the candidate cap, an
 * unavailable HEAD — describes a broken or ambiguous workspace whose read
 * must not be silently served from the caller root, so it propagates fail
 * closed (canonical: "two or more candidates, a scan fault, an unresolvable
 * common-dir, or neither location holding a locatable change directory MUST
 * still fail closed"). The stall query (`queryReviewStallState`) is the one
 * caller that then maps the candidate-cap fault to `unavailable` instead of
 * `not-applicable`. `enumerationMemo` (optional, Stop hook only) is forwarded
 * untouched to the shared exact-one resolver.
 */
function resolveConsumerBindingOrCaller({ repoRoot, changeId = null, enumerationMemo } = {}) {
  try {
    return resolveConsumerBinding({ repoRoot, changeId, enumerationMemo });
  } catch (error) {
    if (error?.message !== "change-worktree-required") throw error;
    return { repoRoot, changeId };
  }
}

function assertDurableRef(ref, label) {
  assertExactKeys(ref, ["path", "digest_sha256"], label);
  assertString(ref.path, `${label}.path`);
  assertDigest(ref.digest_sha256, `${label}.digest_sha256`);
}

// Every sealed record carries an inner digest over its canonical-JSON payload,
// and every ref carries a digest over the whole file — two different values for
// the same artifact. `seal-receipt` and `seal-manifest` print the inner one, so
// hand-building a ref from what they print is the natural mistake, and it
// otherwise surfaces only as `receipt_authority_invalid`, which names neither
// field. When the supplied digest is exactly the inner one, say so and hand back
// the value the ref actually wants.
function innerDigestHint(bytes, supplied) {
  let record;
  try {
    record = parseCanonicalJsonV1(bytes);
  } catch {
    return "";
  }
  const inner = ["receipt_digest_sha256", "manifest_digest_sha256", "record_digest_sha256"]
    .find((key) => record?.[key] === supplied);
  if (inner === undefined) return "";
  return ` (the supplied value is the record's ${inner}, which covers only the canonical-JSON payload;`
    + ` a ref needs the whole-file digest ${sha256Hex(bytes)}, which the sealing command returns as ref.digest_sha256)`;
}

function evidenceRefFromBytes(notesRoot, targetPath, bytes) {
  return {
    path: path.relative(notesRoot, targetPath).split(path.sep).join("/"),
    digest_sha256: sha256Hex(bytes),
  };
}

function readEvidenceBytes({
  repoRoot,
  targetPath,
  label,
  gitOps,
  maxBytes = RECEIPT_SCAN_MAX_BYTES,
  semanticSafetyCode = null,
  fsOps = null,
  preserveTargetOversize = false,
}) {
  const notesRoot = derivedNotesRoot(repoRoot, gitOps, semanticSafetyCode, fsOps);
  const candidatePath = path.relative(notesRoot, targetPath).split(path.sep).join("/");
  const canonicalPath = assertSafeRepoRelativePath({ repoRoot: notesRoot, candidatePath });
  const canonicalTarget = path.join(notesRoot, ...canonicalPath.split("/"));
  let bytes;
  try {
    ({ bytes } = readNoFollowFile({
      root: notesRoot,
      parent: path.dirname(canonicalTarget),
      target: canonicalTarget,
      maxBytes,
      hooks: {
        ...(typeof fsOps?.openSync === "function" ? { openSync: fsOps.openSync } : {}),
        ...(typeof fsOps?.readSync === "function" ? { readSync: fsOps.readSync } : {}),
      },
    }));
  } catch (error) {
    if (isDurablePathError(error)) {
      if (preserveTargetOversize && error.code === "target-oversize") throw error;
      if (semanticSafetyCode !== null) {
        throw new CoreFailure(error.code === "target-oversize" ? "receipt-size-exceeded" : semanticSafetyCode);
      }
      // Typed code for the D30 CLI (fixed catalog detail only); the concrete
      // cause stays in `.message` for direct helper callers such as the merge
      // gate's `verifyHeadBoundFinalEvidence` and closure discovery.
      throw new CoreFailure("evidence-artifact-invalid", `${label} is unreadable or unsafe: ${error.code}`, durableFailureReason(error));
    }
    throw error;
  }
  return {
    targetPath: canonicalTarget,
    bytes,
    ref: evidenceRefFromBytes(notesRoot, canonicalTarget, bytes),
  };
}

function readEvidencePath({
  repoRoot,
  targetPath,
  label,
  validateRecord,
  gitOps,
  maxBytes = RECEIPT_SCAN_MAX_BYTES,
  semanticSafetyCode = null,
  fsOps = null,
  preserveTargetOversize = false,
}) {
  const loaded = readEvidenceBytes({
    repoRoot,
    targetPath,
    label,
    gitOps,
    maxBytes,
    semanticSafetyCode,
    fsOps,
    preserveTargetOversize,
  });
  const { bytes } = loaded;
  const record = parseCanonicalJsonV1(bytes);
  validateRecord(record);
  return { ...loaded, record };
}

function readEvidenceRef({ repoRoot, ref, label, validateRecord, gitOps, maxBytes = RECEIPT_SCAN_MAX_BYTES, semanticSafetyCode = null, fsOps = null }) {
  assertDurableRef(ref, label);
  const notesRoot = derivedNotesRoot(repoRoot, gitOps, semanticSafetyCode, fsOps);
  const canonicalPath = assertSafeRepoRelativePath({
    repoRoot: notesRoot,
    candidatePath: ref.path,
    semanticFailureCode: semanticSafetyCode,
  });
  const targetPath = path.join(notesRoot, ...canonicalPath.split("/"));
  const loaded = readEvidenceBytes({ repoRoot, targetPath, label, gitOps, maxBytes, semanticSafetyCode, fsOps });
  const { bytes } = loaded;
  if (sha256Hex(bytes) !== ref.digest_sha256) {
    fail(`${label} whole-file digest mismatch${innerDigestHint(bytes, ref.digest_sha256)}`);
  }
  const record = parseCanonicalJsonV1(bytes);
  validateRecord(record);
  return { record, targetPath: loaded.targetPath, bytes };
}

function evidenceRef(notesRoot, targetPath) {
  return {
    path: path.relative(notesRoot, targetPath).split(path.sep).join("/"),
    digest_sha256: sha256Hex(readFileSync(targetPath)),
  };
}

// The ref a *sealing* command returns MUST come from the bytes that seal just
// published, never from a fresh read. `durableSeal` runs every filesystem step
// through the injected `fsOps` seam so durability faults can be exercised; a
// raw `readFileSync` after it steps outside that seam, which throws ENOENT the
// moment the seam is a test double and, even on a real filesystem, hashes a
// second read rather than the bytes publication actually verified. Re-encoding
// the sealed record reproduces those bytes exactly with no filesystem access at
// all: `durableSeal` builds the file as `${canonicalJsonV1(record)}\n` and
// asserts the whole-file readback equals it, so this is the same equality that
// publication already proved, not a new assumption. `evidenceRef` above stays
// only for the legacy archive-transition capture below. Auto-discovery and
// authority reads MUST use `readEvidenceBytes` / `readEvidencePath` so digesting
// and parsing consume the same bounded, no-follow byte buffer.
function sealedEvidenceRef(notesRoot, targetPath, record) {
  return {
    path: path.relative(notesRoot, targetPath).split(path.sep).join("/"),
    digest_sha256: sha256Hex(Buffer.from(`${canonicalJsonV1(record)}\n`, "utf8")),
  };
}

function receiptFileName(changeId, roundNumber) {
  return `review-${changeId}-receipt-r${roundNumber}.json`;
}

function receiptFileNameV3(changeId, roundNumber, dispatchId) {
  return `review-${changeId}-receipt-r${roundNumber}-${dispatchId}.json`;
}

function receiptFileNameForPayload(changeId, payload) {
  return Object.hasOwn(payload, "review_authority")
    ? receiptFileNameV3(changeId, payload.round_number, payload.dispatch_id)
    : receiptFileName(changeId, payload.round_number);
}

function receiptCommitFileNameV3(changeId, roundNumber, dispatchId) {
  return `review-${changeId}-receipt-r${roundNumber}-${dispatchId}.commit.json`;
}

const RECEIPT_CANDIDATE_LIMIT = 64;

function parseReceiptCandidateName(changeId, name) {
  const escaped = changeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = name.match(new RegExp(`^review-${escaped}-receipt-r([1-9][0-9]*)(?:-([0-9a-f]{64}))?\\.json$`, "u"));
  if (match === null) return null;
  const round = Number(match[1]);
  const dispatchId = match[2] ?? null;
  return {
    name,
    round,
    dispatchId,
    markerName: dispatchId === null ? null : receiptCommitFileNameV3(changeId, round, dispatchId),
  };
}

function hasValidReceiptCommitMarkerCandidate({ repoRoot, changeId, notesRoot, candidate, gitOps, fsOps, propagateNativeFaults = false }) {
  if (candidate.markerName === null) return true;
  try {
    const receiptLoaded = withSemanticFailureCode("receipt-evidence-invalid", () => readEvidencePath({
      repoRoot,
      targetPath: path.join(notesRoot, candidate.name),
      label: "receipt candidate",
      validateRecord: (record) => {
        if (record?.schema !== REVIEW_RECEIPT_SCHEMA) fail("receipt-not-committed");
        assertObject(record.reviewer_payload, "receipt candidate reviewer_payload");
        assertSafeInteger(record.reviewer_payload.round_number, "receipt candidate round_number");
        assertDigest(record.reviewer_payload.dispatch_id, "receipt candidate dispatch_id");
        assertObject(record.reviewer_payload.review_authority, "receipt candidate review_authority");
        if (record.reviewer_payload.round_number !== candidate.round
          || record.reviewer_payload.dispatch_id !== candidate.dispatchId) fail("receipt-not-committed");
      },
      gitOps,
      maxBytes: RECEIPT_SCAN_MAX_BYTES,
      fsOps,
    }));
    const markerLoaded = withSemanticFailureCode("receipt-evidence-invalid", () => readEvidencePath({
      repoRoot,
      targetPath: path.join(notesRoot, candidate.markerName),
      label: "receipt commit marker candidate",
      validateRecord: validateReceiptCommitMarkerRecord,
      gitOps,
      fsOps,
    }));
    return canonicalJsonV1(markerLoaded.record.receipt_ref) === canonicalJsonV1(receiptLoaded.ref)
      && markerLoaded.record.authority_snapshot_sha256
        === sha256Hex(canonicalJsonV1(receiptLoaded.record.reviewer_payload.review_authority));
  } catch (error) {
    if (!(error instanceof CoreFailure) && propagateNativeFaults) throw error;
    return false;
  }
}

function validateReceiptCommitMarkerRecord(record) {
  assertExactKeys(record, ["schema", "receipt_ref", "authority_snapshot_sha256", "committed_at"], "receipt commit marker");
  if (record.schema !== RECEIPT_COMMIT_SCHEMA) fail("receipt-not-committed");
  assertDurableRef(record.receipt_ref, "receipt commit marker receipt_ref");
  assertDigest(record.authority_snapshot_sha256, "receipt commit marker authority snapshot");
  if (typeof record.committed_at !== "string" || !Number.isFinite(Date.parse(record.committed_at))) {
    fail("receipt-not-committed");
  }
}

function validateCommittedReceiptMarker({ repoRoot, changeId, receiptRef, receipt, gitOps, fsOps }) {
  if (receipt.schema !== REVIEW_RECEIPT_SCHEMA) return null;
  const payload = receipt.reviewer_payload;
  const notesRoot = derivedNotesRoot(repoRoot, gitOps, null, fsOps);
  const markerPath = path.join(notesRoot, receiptCommitFileNameV3(changeId, payload.round_number, payload.dispatch_id));
  try { lstatSync(markerPath); } catch (error) {
    if (error?.code === "ENOENT") fail("receipt-not-committed");
    throw error;
  }
  let marker;
  try {
    marker = withSemanticFailureCode("receipt-evidence-invalid", () => readEvidencePath({
      repoRoot,
      targetPath: markerPath,
      label: "receipt commit marker",
      validateRecord: validateReceiptCommitMarkerRecord,
      gitOps,
      fsOps,
    })).record;
  } catch (error) {
    if (error instanceof CoreFailure || error?.[CORE_DOMAIN_PREDICATE]) fail("receipt-not-committed");
    throw error;
  }
  if (canonicalJsonV1(marker.receipt_ref) !== canonicalJsonV1(receiptRef)
    || marker.authority_snapshot_sha256 !== sha256Hex(canonicalJsonV1(payload.review_authority))) {
    fail("receipt-not-committed");
  }
  return marker;
}

function rawReviewerOutputFileName(changeId, roundNumber, dispatchId) {
  return `review-${changeId}-raw-r${roundNumber}-${dispatchId}.bin`;
}

function validateCanonicalRawReviewerPayload({ bytes, repoRoot, changeId = null, roundNumber = null, dispatchId = null, gitOps }) {
  const payload = parseCanonicalJsonV1(bytes);
  assertExactKeys(payload, [
    ...REVIEWER_PAYLOAD_V3_KEYS,
    ...(Object.hasOwn(payload, "execution_root_head") ? ["execution_root_head"] : []),
    ...(Object.hasOwn(payload, "guarantee_assessment") ? ["guarantee_assessment"] : []),
  ], "raw reviewer payload");
  if (payload.review_authority !== null || payload.output_evidence !== null) {
    fail("raw reviewer payload producer-owned fields must be null");
  }
  assertObject(payload.reviewer_identity, "raw reviewer payload identity");
  if (!Object.hasOwn(payload.reviewer_identity, "executor_kind")) {
    fail("raw reviewer payload identity missing executor_kind");
  }
  assertExactKeys(payload.reviewer_identity, ["role", "executor_kind"], "raw reviewer payload identity");
  if (payload.reviewer_identity.role !== "dp-reviewer"
    || !LEGACY_V2_EXECUTOR_KINDS.has(payload.reviewer_identity.executor_kind)) {
    fail("raw reviewer payload identity is invalid");
  }
  const semanticPayload = {
    dispatch_id: payload.dispatch_id,
    change_id: payload.change_id,
    responsibility_id: payload.responsibility_id,
    reviewer_identity: { role: "dp-reviewer", executor_kind: "tl-direct" },
    review_mode: payload.review_mode,
    round_number: payload.round_number,
    bounded_rereview_count: payload.bounded_rereview_count,
    lineage: payload.lineage,
    scope: payload.scope,
    findings: payload.findings,
    verdict: payload.verdict,
  };
  validateReviewerPayload(semanticPayload, {
    repoRoot,
    gitOps,
    schema: REVIEW_RECEIPT_SCHEMA_V2,
    claimRequired: false,
    requirementScopeEpoch: true,
  });
  validatePayloadGuaranteeAssessment(payload);
  const openFindingIds = payload.scope.open_finding_ids;
  if (!Array.isArray(openFindingIds) || openFindingIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(openFindingIds).size !== openFindingIds.length
    || openFindingIds.some((id, index) => index > 0 && compareCodePoints(openFindingIds[index - 1], id) >= 0)) {
    fail("open-finding-ids-noncanonical");
  }
  if (changeId !== null && payload.change_id !== changeId) fail("raw reviewer payload change mismatch");
  if (roundNumber !== null && payload.round_number !== roundNumber) fail("raw reviewer payload round mismatch");
  if (dispatchId !== null && payload.dispatch_id !== dispatchId) fail("raw reviewer payload dispatch mismatch");
  return payload;
}

function matchesClosedHistoricalRaw({ changeId, roundNumber, dispatchId, rawPayloadSha256 }) {
  return POST_HOC_ALLOWED.some((entry) => entry.review_mode === "full"
    && entry.change_id === changeId
    && entry.round_number === roundNumber
    && entry.dispatch_id === dispatchId
    && entry.raw_payload_sha256 === rawPayloadSha256);
}

function isClosedHistoricalRawCapture({ bytes, changeId, roundNumber, dispatchId }) {
  return matchesClosedHistoricalRaw({ changeId, roundNumber, dispatchId, rawPayloadSha256: sha256Hex(bytes) });
}

// True only for a receipt whose change, round, dispatch and raw output digest equal
// one POST_HOC_ALLOWED tuple, so the carry-forward exception below cannot widen
// past the frozen raw bytes even if a post-hoc binding ever existed for another one.
function isClosedHistoricalPostHocReceipt(payload) {
  return matchesClosedHistoricalRaw({
    changeId: payload.change_id,
    roundNumber: payload.round_number,
    dispatchId: payload.dispatch_id,
    rawPayloadSha256: payload.output_evidence?.raw_payload_sha256,
  });
}

// Required carry-forward set of a successor receipt (design D1/D2): every id in
// the immediate predecessor's scope.open_finding_ids, plus every predecessor
// finding that is closed and Critical, except a Critical closed under a TL
// scope ruling (requirement_scope scope-unresolved with tracked-follow-up),
// whose closure the chain walk keeps validated at its closing receipt. Under
// the closed historical post-hoc authority (a receipt whose change, round,
// dispatch and raw digest equal a POST_HOC_ALLOWED tuple) only the open part
// is checked, because the allowlisted raw bytes predate this rule. The check requires
// containment by finding_id only and never rejects a superset. Pure: reads no
// file or Git state and does not throw on a well-formed payload. Returns the
// Set of missing ids, or null when the successor is complete. It is called
// only from the producer side (captureReviewerOutput and
// prepareReviewRoundReceiptPreclaim); the shared read side (transition,
// temporal, authority snapshot, chain walk, record validation) MUST NOT call
// it, or already sealed chains that predate the rule would stop verifying.
function predecessorCarryForwardProblem(successorPayload, predecessorPayload, { postHocAuthority }) {
  const carried = new Set(successorPayload.findings.map((entry) => entry.finding_id));
  const missing = new Set();
  for (const findingId of predecessorPayload.scope.open_finding_ids) {
    if (!carried.has(findingId)) missing.add(findingId);
  }
  if (!postHocAuthority) {
    for (const entry of predecessorPayload.findings) {
      if (entry.state !== "closed" || entry.observation.severity !== "Critical") continue;
      if (entry.observation.requirement_scope === "scope-unresolved" && entry.disposition === "tracked-follow-up") continue;
      if (!carried.has(entry.finding_id)) missing.add(entry.finding_id);
    }
  }
  return missing.size === 0 ? null : missing;
}

// Reads the immediate predecessor receipt named by lineage.previous_receipt_ref.
function readPredecessorReceiptPayload({ repoRoot, payload, gitOps, fsOps }) {
  const loaded = readEvidenceRef({
    repoRoot,
    ref: payload.lineage.previous_receipt_ref,
    label: "previous receipt",
    validateRecord: (record) => validateReceiptRecord(record, { repoRoot, gitOps, claimRequired: false, fsOps }),
    gitOps,
    semanticSafetyCode: "evidence-artifact-invalid",
    fsOps,
  });
  return loaded.record.reviewer_payload;
}

// True only for the native ENOENT of the predecessor receipt file named by `ref`.
function isAbsentPredecessorReceiptFile(error, ref) {
  return error?.code === "ENOENT"
    && typeof error.path === "string"
    && error.path.endsWith(`${path.sep}${ref.path.split("/").join(path.sep)}`);
}

function omittedCarryForwardFailure(missing) {
  return new CoreFailure("predecessor-finding-omitted", `predecessor-finding-omitted: ${[...missing].sort().join(", ")}`);
}

function validateRawReviewerCapture({ bytes, repoRoot, changeId, roundNumber, dispatchId, gitOps }) {
  let payload;
  try {
    payload = withSemanticFailureCode("raw-payload-invalid", () =>
      validateCanonicalRawReviewerPayload({ bytes, repoRoot, changeId, roundNumber, dispatchId, gitOps }));
  } catch (error) {
    if (isClosedHistoricalRawCapture({ bytes, changeId, roundNumber, dispatchId })) return null;
    throw error;
  }
  // fix-flow-gate-gaps D2 fail-fast: a payload that passed canonical raw
  // validation is a NEW capture (its dispatch tuple is freshly minted at
  // render time, so the closed POST_HOC_ALLOWED list can never match it). The
  // dispatch contract now carries scope.risk_shape_digest_alg, so a
  // missing/blank value stops here with the named code instead of surfacing
  // later as an opaque receipt-output-evidence-mismatch. Resolvability of a
  // PRESENT value is already enforced by canonical validation
  // (validateReviewerPayload → resolveRiskShapeDigestAlg); that helper's
  // optional closure stays untouched so legacy sealed receipts still verify.
  const digestAlg = payload?.scope?.risk_shape_digest_alg;
  if (digestAlg === undefined || digestAlg === null || digestAlg === "") {
    if (isClosedHistoricalRawCapture({ bytes, changeId, roundNumber, dispatchId })) return null;
    fail("raw-payload-invalid", "raw-risk-digest-missing");
  }
  return payload;
}

function inspectRawPublicationTarget({ notesRoot, targetPath, bytes }) {
  try {
    const loaded = readNoFollowFile({
      root: notesRoot,
      parent: notesRoot,
      target: targetPath,
      maxBytes: 4 * 1024 * 1024,
    });
    return {
      kind: loaded.bytes.equals(bytes) ? "exact" : "different",
      stat: loaded.stat,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "absent" };
    if (isDurablePathError(error)) return { kind: "unsafe" };
    throw error;
  }
}

function makeExistingRawCarrierDurable({ notesRoot, targetPath, bytes, expectedStat }) {
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  // Win32 requires a write-capable handle for fsync/FlushFileBuffers. This
  // verification path never writes through the handle; identity, size, and
  // byte checks below still prove the existing carrier is unchanged.
  const openMode = process.platform === "win32" ? fsConstants.O_RDWR : fsConstants.O_RDONLY;
  let fd;
  try {
    fd = openSync(targetPath, openMode | noFollow);
    const open = fstatSync(fd);
    if (!open.isFile()
      || open.dev !== expectedStat.dev
      || open.ino !== expectedStat.ino
      || open.size !== expectedStat.size) fail("raw-payload-existing-unsafe");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  fsyncDirectory(notesRoot);
  const verified = readNoFollowFile({
    root: notesRoot,
    parent: notesRoot,
    target: targetPath,
    maxBytes: 4 * 1024 * 1024,
  });
  if (!verified.bytes.equals(bytes)
    || verified.stat.dev !== expectedStat.dev
    || verified.stat.ino !== expectedStat.ino
    || verified.stat.size !== expectedStat.size) fail("raw-payload-existing-unsafe");
}

function rawPublicationOps(fsOps) {
  return {
    createExclusiveDurableFile: fsOps?.rawCreateExclusiveDurableFile ?? createExclusiveDurableFile,
    makeExistingRawCarrierDurable: fsOps?.rawMakeExistingDurable ?? makeExistingRawCarrierDurable,
  };
}

function captureReviewerOutput({ repoRoot, changeId, roundNumber, dispatchId, payloadPath, fsOps, gitOps, hooks = {} }) {
  assertChangeId(changeId);
  assertSafeInteger(roundNumber, "roundNumber");
  if (roundNumber < 1) fail("roundNumber must be positive");
  assertDigest(dispatchId, "dispatchId");
  assertString(payloadPath, "payloadPath");
  assertExactKeys(hooks, Object.hasOwn(hooks, "afterPayloadRead") ? ["afterPayloadRead"] : [], "capture hooks");
  if (Object.hasOwn(hooks, "afterPayloadRead") && typeof hooks.afterPayloadRead !== "function") {
    fail("capture hooks are invalid");
  }
  const payloadParent = path.dirname(path.resolve(payloadPath));
  const payloadTarget = path.resolve(payloadPath);
  try { lstatSync(payloadTarget); } catch (error) {
    if (error?.code === "ENOENT") fail("raw-payload-read-failed");
    throw error;
  }
  let bytes;
  try {
    ({ bytes } = readNoFollowFile({
      root: payloadParent,
      parent: payloadParent,
      target: payloadTarget,
      maxBytes: 4 * 1024 * 1024,
      hooks: fsOps?.readNoFollowFileHooks,
    }));
  } catch (error) {
    if (isDurablePathError(error)) {
      if (error.code === "target-oversize") fail("raw-payload-size-exceeded");
      fail("evidence-artifact-invalid", durableFailureReason(error));
    }
    throw error;
  }
  const capturedPayload = validateRawReviewerCapture({ bytes, repoRoot, changeId, roundNumber, dispatchId, gitOps });
  // A closed historical byte-exact carrier returns null and skips the check; so does
  // a payload without a predecessor (round one or a missing_predecessor_seal restart).
  // A predecessor ref whose receipt does not exist or fails validation is a
  // dispatch-tuple failure (raw-payload-invalid, nothing published). Of the native
  // I/O faults only the proven absence of the predecessor receipt file itself maps
  // there; an ENOENT anywhere else (admission record, attestation, git object,
  // notes root) stays untyped, like every other native fault. A ref path that is
  // not a flat receipt file name (for example a leading "notes/") names no receipt
  // at all, so it fails validation before any read instead of surfacing the ENOENT
  // of the directory level it invents.
  if (capturedPayload !== null && capturedPayload.lineage.previous_receipt_ref !== null) {
    // The predecessor is validated against its admission record or post-hoc
    // attestation, which live under the change's binding worktree: resolve that
    // root first, as build and seal do, so a capture issued from the main
    // checkout reads the same records. Publication below keeps using the caller
    // root (the notes root is the same either way). Only "nowhere to look" keeps
    // the caller root; every other resolution fault fails closed.
    const predecessorRef = capturedPayload.lineage.previous_receipt_ref;
    if (predecessorRef.path !== path.posix.basename(predecessorRef.path) || predecessorRef.path.includes("\\")) fail("raw-payload-invalid");
    const predecessorRoot = resolveConsumerBindingOrCaller({ repoRoot, changeId }).repoRoot;
    let predecessorPayload;
    try {
      predecessorPayload = readPredecessorReceiptPayload({ repoRoot: predecessorRoot, payload: capturedPayload, gitOps, fsOps });
    } catch (error) {
      if (error instanceof CoreFailure || error?.[CORE_DOMAIN_PREDICATE] || isAbsentPredecessorReceiptFile(error, predecessorRef)) {
        fail("raw-payload-invalid");
      }
      throw error;
    }
    const missing = predecessorCarryForwardProblem(capturedPayload, predecessorPayload, { postHocAuthority: false });
    if (missing !== null) throw omittedCarryForwardFailure(missing);
  }
  if (typeof hooks.afterPayloadRead === "function") hooks.afterPayloadRead();
  // Root resolution/creation is part of the typed publication boundary: faults from
  // derivedNotesRoot must classify as denied/root-unavailable/failed, not escape as
  // unexpected-io-fault before the publication try/catch.
  let notesRoot;
  try {
    notesRoot = derivedNotesRoot(repoRoot, gitOps, null, fsOps);
  } catch (error) {
    throw error;
  }
  const targetPath = path.join(notesRoot, rawReviewerOutputFileName(changeId, roundNumber, dispatchId));
  const ops = rawPublicationOps(fsOps);
  try {
    ops.createExclusiveDurableFile({ root: notesRoot, parent: notesRoot, target: targetPath, body: bytes });
  } catch (error) {
    const inspection = inspectRawPublicationTarget({ notesRoot, targetPath, bytes });
    if (error?.code !== "EEXIST") {
      if (inspection.kind === "different") fail("raw-payload-publication-partial");
      if (inspection.kind === "unsafe") fail("raw-payload-publication-indeterminate");
      if (inspection.kind === "absent") throw error;
      try {
        ops.makeExistingRawCarrierDurable({ notesRoot, targetPath, bytes, expectedStat: inspection.stat });
        return { path: path.basename(targetPath), digest_sha256: sha256Hex(bytes) };
      } catch (durabilityError) {
        if (isDurablePathError(durabilityError)) fail("raw-payload-publication-indeterminate");
        throw durabilityError;
      }
    }
    if (inspection.kind === "different") fail("raw-payload-collision");
    if (inspection.kind !== "exact") fail("raw-payload-existing-unsafe");
    try {
      ops.makeExistingRawCarrierDurable({ notesRoot, targetPath, bytes, expectedStat: inspection.stat });
    } catch (durabilityError) {
      if (isDurablePathError(durabilityError)) fail("raw-payload-existing-unsafe");
      throw durabilityError;
    }
  }
  return {
    path: path.basename(targetPath),
    digest_sha256: sha256Hex(bytes),
  };
}

const PREPARED_KEYS = ["schema", "attestation_id", "change_id", "reviewed_head_sha", "base_sha", "dispatch_id", "responsibility_id", "review_mode", "round_number", "risk_shape_digest_sha256", "raw_payload_ref", "raw_payload_sha256", "verdict", "findings_digest_sha256", "open_finding_ids", "verdict_open_set_sha256", "preparer_id", "eligible_reason", "prepared_at"];
const AUTHORIZATION_KEYS = ["schema", "authorization_id", "prepared_ref", "prepared_sha256", "authorized_by", "authority_provenance", "authorization_text", "authorized_at"];
const ATTESTATION_KEYS = ["schema", "attestation_id", "authority", "prepared_ref", "authorization_ref", "change_id", "reviewed_head_sha", "base_sha", "dispatch_id", "responsibility_id", "review_mode", "round_number", "risk_shape_digest_sha256", "raw_payload_ref", "raw_payload_sha256", "verdict", "findings_digest_sha256", "open_finding_ids", "verdict_open_set_sha256", "preparer_id", "witness_id", "witnessed_at", "eligible_reason"];
const REVIEW_SEVERITIES = Object.freeze(["Critical", "Important", "Suggestion"]);

function postHocPrettyBytes(record) {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function assertOrderedKeys(value, keys, code) {
  if (!isStrictPlainObject(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key, index) => key !== keys[index])) fail(code);
}

function assertPostHocIdentifier(value) {
  if (typeof value !== "string" || !RESPONSIBILITY_ID.test(value)) fail("identifier-invalid");
}

function assertPostHocUuid(value) {
  if (typeof value !== "string" || !UUID_V4.test(value)) fail("identifier-invalid");
}

function assertPostHocSha(value) {
  if (typeof value !== "string" || !HEX_40.test(value)) fail("sha-invalid");
}

function assertPostHocDigest(value) {
  if (typeof value !== "string" || !HEX_64.test(value)) fail("digest-invalid");
}

function postHocTimestampMs(value, code = "timestamp-invalid") {
  const hasMilliseconds = typeof value === "string" && value.includes(".");
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) fail(code);
  const parsed = Date.parse(value);
  const roundTrip = hasMilliseconds
    ? new Date(parsed).toISOString()
    : new Date(parsed).toISOString().replace(/\.000Z$/u, "Z");
  if (roundTrip !== value) fail(code);
  return parsed;
}

function validatePostHocFindings(findings, openFindingIds) {
  if (!Array.isArray(findings) || !Array.isArray(openFindingIds)) fail("request-shape-invalid");
  const ids = new Set();
  const open = [];
  for (const entry of findings) {
    assertOrderedKeys(entry, ["finding_id", "state", "disposition", "observation"], "request-shape-invalid");
    if (typeof entry.finding_id !== "string" || entry.finding_id.length === 0 || ids.has(entry.finding_id)) fail("request-shape-invalid");
    ids.add(entry.finding_id);
    if (!FINDING_STATES.has(entry.state)) fail("request-shape-invalid");
    if (entry.state === "open") {
      if (entry.disposition !== null) fail("request-shape-invalid");
      open.push(entry.finding_id);
    } else if (!DISPOSITIONS.has(entry.disposition)) fail("request-shape-invalid");
    assertOrderedKeys(entry.observation, ["axis", "severity", "carrier", "anchor", "detail", "evidence"], "request-shape-invalid");
    if (!/^[1-6]$/u.test(entry.observation.axis)
      || !REVIEW_SEVERITIES.includes(entry.observation.severity)
      || ![entry.observation.carrier, entry.observation.anchor, entry.observation.detail].every((item) => typeof item === "string" && item.length > 0)
      || !Array.isArray(entry.observation.evidence) || entry.observation.evidence.length === 0
      || entry.observation.evidence.some((item) => typeof item !== "string" || item.length === 0)) fail("request-shape-invalid");
  }
  if (openFindingIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(openFindingIds).size !== openFindingIds.length
    || openFindingIds.some((id, index) => index > 0 && compareCodePoints(openFindingIds[index - 1], id) >= 0)
    || canonicalJsonV1(open) !== canonicalJsonV1(openFindingIds)) fail("open-finding-ids-noncanonical");
}

function postHocTuple(value) {
  return {
    change_id: value.change_id,
    base_sha: value.base_sha,
    reviewed_head_sha: value.reviewed_head_sha,
    dispatch_id: value.dispatch_id,
    responsibility_id: value.responsibility_id,
    review_mode: value.review_mode,
    round_number: value.round_number,
    risk_shape_digest_sha256: value.risk_shape_digest_sha256,
    raw_payload_sha256: value.raw_payload_sha256,
    verdict: value.verdict,
    open_finding_ids: value.open_finding_ids,
  };
}

function postHocTupleDigest(value) {
  return sha256Hex(canonicalJsonV1(postHocTuple(value)));
}

function validatePostHocAllowlistConstants() {
  for (const tuple of POST_HOC_ALLOWED) {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/u.test(tuple.change_id)) fail("identifier-invalid");
    assertPostHocSha(tuple.base_sha);
    assertPostHocSha(tuple.reviewed_head_sha);
    assertPostHocDigest(tuple.dispatch_id);
    assertPostHocIdentifier(tuple.responsibility_id);
    if (tuple.review_mode !== "full" || tuple.round_number !== 4) fail("identifier-invalid");
    assertPostHocDigest(tuple.risk_shape_digest_sha256);
    assertPostHocDigest(tuple.raw_payload_sha256);
    if (!RECEIPT_VERDICTS.has(tuple.verdict) || !Array.isArray(tuple.open_finding_ids)
      || tuple.open_finding_ids.some((id) => typeof id !== "string" || id.length === 0)
      || new Set(tuple.open_finding_ids).size !== tuple.open_finding_ids.length
      || tuple.open_finding_ids.some((id, index) => index > 0 && compareCodePoints(tuple.open_finding_ids[index - 1], id) >= 0)) {
      fail("identifier-invalid");
    }
  }
  assertPostHocSha(POST_HOC_CUTOFF_SHA);
}
validatePostHocAllowlistConstants();

function validatePreparedAuthority({ repoRoot, changeId, prepared, findings = null, gitOps, failureCode = null }) {
  const validate = () => {
    assertOrderedKeys(prepared, PREPARED_KEYS, "request-shape-invalid");
    if (prepared.schema !== POST_HOC_PREPARED_SCHEMA || prepared.change_id !== changeId
      || !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(prepared.change_id)) fail("identifier-invalid");
    assertPostHocUuid(prepared.attestation_id);
    assertPostHocSha(prepared.reviewed_head_sha); assertPostHocSha(prepared.base_sha);
    assertPostHocDigest(prepared.dispatch_id); assertPostHocDigest(prepared.risk_shape_digest_sha256);
    assertPostHocDigest(prepared.raw_payload_sha256); assertPostHocDigest(prepared.findings_digest_sha256);
    assertPostHocDigest(prepared.verdict_open_set_sha256);
    assertPostHocIdentifier(prepared.responsibility_id); assertPostHocIdentifier(prepared.preparer_id);
    if (!REVIEW_MODES.has(prepared.review_mode) || !Number.isSafeInteger(prepared.round_number)
      || prepared.round_number < 1 || !RECEIPT_VERDICTS.has(prepared.verdict)) fail("request-shape-invalid");
    postHocTimestampMs(prepared.prepared_at);
    if (prepared.eligible_reason !== POST_HOC_ELIGIBLE_REASON) fail("eligible-reason-invalid");
    if (!Array.isArray(prepared.open_finding_ids)
      || prepared.open_finding_ids.some((id) => typeof id !== "string" || id.length === 0)
      || new Set(prepared.open_finding_ids).size !== prepared.open_finding_ids.length
      || prepared.open_finding_ids.some((id, index) => index > 0 && compareCodePoints(prepared.open_finding_ids[index - 1], id) >= 0)) {
      fail("open-finding-ids-noncanonical");
    }
    if (findings !== null) {
      validatePostHocFindings(findings, prepared.open_finding_ids);
      if (prepared.findings_digest_sha256 !== sha256Hex(canonicalJsonV1(findings))) fail("post-hoc-eligible-tuple-mismatch");
    }
    const rawBytes = readRawPostHocPayload({
      repoRoot,
      changeId,
      roundNumber: prepared.round_number,
      dispatchId: prepared.dispatch_id,
      ref: prepared.raw_payload_ref,
      gitOps,
    });
    if (prepared.raw_payload_sha256 !== sha256Hex(rawBytes)
      || prepared.raw_payload_ref.digest_sha256 !== prepared.raw_payload_sha256) fail("raw-payload-digest-mismatch");
    const expectedVerdictOpenSet = sha256Hex(canonicalJsonV1({
      verdict: prepared.verdict,
      open_finding_ids: prepared.open_finding_ids,
    }));
    if (prepared.verdict_open_set_sha256 !== expectedVerdictOpenSet) fail("verdict-open-set-digest-mismatch");
    const candidate = postHocTuple(prepared);
    if (!POST_HOC_ALLOWED.some((entry) => canonicalJsonV1(entry) === canonicalJsonV1(candidate))) {
      fail("post-hoc-eligible-tuple-mismatch");
    }
    if (!isAncestor(repoRoot, prepared.reviewed_head_sha, POST_HOC_CUTOFF_SHA, gitOps)) fail("reviewed-head-after-cutoff");
  };
  try {
    validate();
  } catch (error) {
    if (failureCode !== null && error?.[CORE_DOMAIN_PREDICATE]) fail(failureCode);
    throw error;
  }
}

function postHocMutationOps(fsOps) {
  return {
    mkdirSync: fsOps?.postHocMkdirSync ?? mkdirSync,
    fsyncDirectory: fsOps?.postHocFsyncDirectory ?? fsyncDirectory,
    createExclusiveDurableFile: fsOps?.postHocCreateExclusiveDurableFile ?? createExclusiveDurableFile,
  };
}

function postHocRoot(repoRoot, changeId, { create = true, fsOps } = {}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0 || !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(changeId)) fail("identifier-invalid");
  const changeDir = resolveAdmissionChangeDir(repoRoot, changeId, { propagateNativeFaults: true });
  if (changeDir === null) {
    if (admissionChangeEntryExists(repoRoot, changeId, { propagateNativeFaults: true })) {
      fail("evidence-artifact-invalid", "evidence-parent-unsafe");
    }
    fail("artifact-read-failed");
  }
  const ops = postHocMutationOps(fsOps);
  let parent = changeDir;
  for (const segment of ["admission-records", "post-hoc"]) {
    const next = path.join(parent, segment);
    if (create) {
      let created = false;
      try {
        ops.mkdirSync(next, { recursive: false, mode: 0o700 });
        created = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (created) {
        ops.fsyncDirectory(parent);
      }
    }
    let metadata;
    try { metadata = lstatSync(next); } catch (error) {
      if (error?.code === "ENOENT") fail("artifact-read-failed");
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("evidence-artifact-invalid", "evidence-parent-unsafe");
    parent = next;
  }
  return { changeDir, root: parent };
}

function postHocRef(repoRoot, target, bytes) {
  return { path: path.relative(repoRoot, target).split(path.sep).join("/"), digest_sha256: sha256Hex(bytes) };
}

function readPostHocTarget({ repoRoot, target, keys, schema, failureCode = "artifact-read-failed", fsOps }) {
  try { lstatSync(target); } catch (error) {
    if (error?.code === "ENOENT") fail(failureCode);
    throw error;
  }
  let bytes;
  try { ({ bytes } = readNoFollowFile({ root: repoRoot, parent: path.dirname(target), target, maxBytes: 64 * 1024, hooks: fsOps?.readNoFollowFileHooks })); } catch (error) {
    if (isDurablePathError(error)) fail(error.code === "target-oversize" ? "artifact-size-exceeded" : "evidence-artifact-invalid", durableFailureReason(error));
    throw error;
  }
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = parseJsonDuplicateAware(text);
  } catch (error) {
    if (error instanceof CoreFailure) throw error;
    fail(failureCode);
  }
  if (!bytes.equals(postHocPrettyBytes(value))) fail(failureCode);
  assertOrderedKeys(value, keys, failureCode);
  if (value.schema !== schema) fail(failureCode);
  return { value, bytes, ref: postHocRef(repoRoot, target, bytes) };
}

function readPostHocRef({ repoRoot, ref, expectedTarget, keys, schema, failureCode, fsOps }) {
  try { assertDurableRef(ref, "post-hoc ref"); } catch (error) {
    if (error instanceof CoreFailure || error?.[CORE_DOMAIN_PREDICATE]) fail(failureCode);
    throw error;
  }
  const expectedPath = path.relative(repoRoot, expectedTarget).split(path.sep).join("/");
  if (ref.path !== expectedPath) fail(failureCode);
  const loaded = readPostHocTarget({ repoRoot, target: expectedTarget, keys, schema, failureCode, fsOps });
  if (loaded.ref.digest_sha256 !== ref.digest_sha256) fail(failureCode);
  return loaded;
}

function writePostHocArtifact({ repoRoot, root, target, record, keys, schema, collisionCode, idempotent, fsOps }) {
  assertOrderedKeys(record, keys, collisionCode);
  if (record.schema !== schema) fail(collisionCode);
  const bytes = postHocPrettyBytes(record);
  try {
    postHocMutationOps(fsOps).createExclusiveDurableFile({ root, parent: root, target, body: bytes });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!idempotent) fail(collisionCode);
    const existing = readPostHocTarget({ repoRoot, target, keys, schema, failureCode: collisionCode, fsOps });
    if (!existing.bytes.equals(bytes)) fail(collisionCode);
    return { value: existing.value, ref: existing.ref };
  }
  const readback = readPostHocTarget({ repoRoot, target, keys, schema, failureCode: collisionCode, fsOps });
  if (!readback.bytes.equals(bytes)) fail(collisionCode);
  return { value: readback.value, ref: readback.ref };
}

function readRawPostHocPayload({ repoRoot, changeId, roundNumber, dispatchId, ref, gitOps, fsOps }) {
  try { assertDurableRef(ref, "rawPayloadRef"); } catch (error) {
    if (error instanceof CoreFailure || error?.[CORE_DOMAIN_PREDICATE]) fail("raw-payload-digest-mismatch");
    throw error;
  }
  const notesRoot = derivedNotesRoot(repoRoot, gitOps, null, fsOps);
  if (ref.path !== rawReviewerOutputFileName(changeId, roundNumber, dispatchId)) fail("raw-payload-digest-mismatch");
  const target = path.join(notesRoot, ref.path);
  try { lstatSync(target); } catch (error) {
    if (error?.code === "ENOENT") fail("raw-payload-digest-mismatch");
    throw error;
  }
  let bytes;
  try { ({ bytes } = readNoFollowFile({ root: notesRoot, parent: notesRoot, target, maxBytes: 4 * 1024 * 1024, hooks: fsOps?.readNoFollowFileHooks })); } catch (error) {
    if (isDurablePathError(error)) fail("evidence-artifact-invalid", durableFailureReason(error));
    throw error;
  }
  if (sha256Hex(bytes) !== ref.digest_sha256) fail("raw-payload-digest-mismatch");
  return bytes;
}

function preparePostHocAttestation({ repoRoot, changeId, attestationId, reviewedHeadSha, baseSha, dispatchId, responsibilityId, reviewMode, roundNumber, riskShapeDigestSha256, rawPayloadRef, verdict, findings, openFindingIds, preparerId, eligibleReason, preparedAt, fsOps, gitOps }) {
  assertPostHocUuid(attestationId);
  assertPostHocSha(reviewedHeadSha); assertPostHocSha(baseSha);
  assertPostHocDigest(dispatchId); assertPostHocDigest(riskShapeDigestSha256);
  assertPostHocIdentifier(responsibilityId); assertPostHocIdentifier(preparerId);
  if (!REVIEW_MODES.has(reviewMode) || !Number.isSafeInteger(roundNumber) || roundNumber < 1 || !RECEIPT_VERDICTS.has(verdict)) fail("request-shape-invalid");
  postHocTimestampMs(preparedAt);
  if (eligibleReason !== POST_HOC_ELIGIBLE_REASON) fail("eligible-reason-invalid");
  validatePostHocFindings(findings, openFindingIds);
  const rawBytes = readRawPostHocPayload({ repoRoot, changeId, roundNumber, dispatchId, ref: rawPayloadRef, gitOps, fsOps });
  const rawDigest = sha256Hex(rawBytes);
  const candidate = { change_id: changeId, base_sha: baseSha, reviewed_head_sha: reviewedHeadSha, dispatch_id: dispatchId, responsibility_id: responsibilityId, review_mode: reviewMode, round_number: roundNumber, risk_shape_digest_sha256: riskShapeDigestSha256, raw_payload_sha256: rawDigest, verdict, open_finding_ids: openFindingIds };
  if (!POST_HOC_ALLOWED.some((entry) => canonicalJsonV1(entry) === canonicalJsonV1(candidate))) fail("post-hoc-eligible-tuple-mismatch");
  if (!isAncestor(repoRoot, reviewedHeadSha, POST_HOC_CUTOFF_SHA, gitOps)) fail("reviewed-head-after-cutoff");
  const prepared = {
    schema: POST_HOC_PREPARED_SCHEMA, attestation_id: attestationId, change_id: changeId, reviewed_head_sha: reviewedHeadSha,
    base_sha: baseSha, dispatch_id: dispatchId, responsibility_id: responsibilityId, review_mode: reviewMode, round_number: roundNumber,
    risk_shape_digest_sha256: riskShapeDigestSha256, raw_payload_ref: structuredClone(rawPayloadRef), raw_payload_sha256: rawDigest,
    verdict, findings_digest_sha256: sha256Hex(canonicalJsonV1(findings)), open_finding_ids: [...openFindingIds],
    verdict_open_set_sha256: sha256Hex(canonicalJsonV1({ verdict, open_finding_ids: openFindingIds })), preparer_id: preparerId,
    eligible_reason: eligibleReason, prepared_at: preparedAt,
  };
  validatePreparedAuthority({ repoRoot, changeId, prepared, findings, gitOps });
  const { root } = postHocRoot(repoRoot, changeId, { fsOps });
  const target = path.join(root, `${attestationId}.prepared.json`);
  const written = writePostHocArtifact({ repoRoot, root, target, record: prepared, keys: PREPARED_KEYS, schema: POST_HOC_PREPARED_SCHEMA, collisionCode: "artifact-readback-mismatch", idempotent: true, fsOps });
  return { prepared: written.value, ref: written.ref, eligible_tuple_digest_sha256: postHocTupleDigest(prepared) };
}

function loadPrepared({ repoRoot, changeId, ref, failureCode = "authorization-binding-mismatch", readOnly = false, fsOps, gitOps }) {
  const { root } = postHocRoot(repoRoot, changeId, { create: !readOnly, fsOps });
  const match = ref?.path?.match(/\/([0-9a-f-]{36})\.prepared\.json$/u);
  if (!match || !UUID_V4.test(match[1])) fail(failureCode);
  const target = path.join(root, `${match[1]}.prepared.json`);
  const loaded = readPostHocRef({ repoRoot, ref, expectedTarget: target, keys: PREPARED_KEYS, schema: POST_HOC_PREPARED_SCHEMA, failureCode, fsOps });
  if (loaded.value.change_id !== changeId || loaded.value.attestation_id !== match[1]) fail(failureCode);
  validatePreparedAuthority({ repoRoot, changeId, prepared: loaded.value, gitOps, failureCode });
  return { ...loaded, root };
}

function recordPostHocAuthorization({ repoRoot, changeId, authorizationId, preparedRef, authorizedBy, authorizationText, authorizedAt, fsOps }) {
  assertPostHocUuid(authorizationId); assertPostHocIdentifier(authorizedBy); postHocTimestampMs(authorizedAt);
  const prepared = loadPrepared({ repoRoot, changeId, ref: preparedRef, fsOps });
  const expectedText = `authorize post-hoc recovery: prepared_sha256=${preparedRef.digest_sha256}; authorization_id=${authorizationId}`;
  if (authorizationText !== expectedText || Buffer.byteLength(authorizationText, "utf8") > 8192) fail("authorization-binding-mismatch");
  const authorization = {
    schema: POST_HOC_AUTHORIZATION_SCHEMA, authorization_id: authorizationId, prepared_ref: structuredClone(preparedRef),
    prepared_sha256: preparedRef.digest_sha256, authorized_by: authorizedBy, authority_provenance: "cooperative-attributed",
    authorization_text: authorizationText, authorized_at: authorizedAt,
  };
  const target = path.join(prepared.root, `${authorizationId}.authorization.json`);
  const written = writePostHocArtifact({ repoRoot, root: prepared.root, target, record: authorization, keys: AUTHORIZATION_KEYS, schema: POST_HOC_AUTHORIZATION_SCHEMA, collisionCode: "authorization-binding-mismatch", idempotent: true, fsOps });
  return { authorization: written.value, ref: written.ref, eligible_tuple_digest_sha256: postHocTupleDigest(prepared.value) };
}

function loadAuthorization({ repoRoot, changeId, ref, failureCode = "authorization-binding-mismatch", readOnly = false, fsOps }) {
  const { root } = postHocRoot(repoRoot, changeId, { create: !readOnly, fsOps });
  const match = ref?.path?.match(/\/([0-9a-f-]{36})\.authorization\.json$/u);
  if (!match || !UUID_V4.test(match[1])) fail(failureCode);
  const target = path.join(root, `${match[1]}.authorization.json`);
  const loaded = readPostHocRef({ repoRoot, ref, expectedTarget: target, keys: AUTHORIZATION_KEYS, schema: POST_HOC_AUTHORIZATION_SCHEMA, failureCode, fsOps });
  if (loaded.value.authorization_id !== match[1] || loaded.value.authority_provenance !== "cooperative-attributed") fail(failureCode);
  return { ...loaded, root };
}

function ensurePlainChild(root, parent, name, failureCode, fsOps) {
  const target = path.join(parent, name);
  const ops = postHocMutationOps(fsOps);
  let created = false;
  try {
    ops.mkdirSync(target, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (created) {
    ops.fsyncDirectory(parent);
  }
  let metadata;
  try { metadata = lstatSync(target); } catch (error) {
    if (error?.code === "ENOENT") fail(failureCode);
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !insideRoot(realpathSync(root), realpathSync(target))) fail("evidence-artifact-invalid");
  return target;
}

function claimPostHocAuthorization({ repoRoot, root, tupleDigest, authorization, attestationId, claimedAt, fsOps }) {
  const ops = postHocMutationOps(fsOps);
  const tupleRoot = ensurePlainChild(root, root, "authorization-tuples", "authorization-claim-write-failed", fsOps);
  const claimDir = path.join(tupleRoot, `${tupleDigest}.claim`);
  try {
    ops.mkdirSync(claimDir, { recursive: false, mode: 0o700 });
    ops.fsyncDirectory(tupleRoot);
  } catch (error) {
    if (error?.code === "EEXIST") fail("authorization-consumed");
    throw error;
  }
  const proof = {
    schema: POST_HOC_AUTHORIZATION_CLAIM_SCHEMA,
    eligible_tuple_digest_sha256: tupleDigest,
    authorization_id: authorization.value.authorization_id,
    authorization_sha256: authorization.ref.digest_sha256,
    attestation_id: attestationId,
    claimed_at: claimedAt,
  };
  const keys = ["schema", "eligible_tuple_digest_sha256", "authorization_id", "authorization_sha256", "attestation_id", "claimed_at"];
  ops.createExclusiveDurableFile({ root, parent: claimDir, target: path.join(claimDir, "consumed.json"), body: postHocPrettyBytes(proof) });
  return { claimDir, proof, keys };
}

function validatePostHocTimeAndBinding(prepared, authorization, witnessId, witnessedAt) {
  if (canonicalJsonV1(authorization.value.prepared_ref) !== canonicalJsonV1(prepared.ref)
    || authorization.value.prepared_sha256 !== prepared.ref.digest_sha256) fail("authorization-binding-mismatch");
  const preparedAt = postHocTimestampMs(prepared.value.prepared_at, "attestation-binding-mismatch");
  const authorizedAt = postHocTimestampMs(authorization.value.authorized_at, "attestation-binding-mismatch");
  const witnessAt = postHocTimestampMs(witnessedAt, "timestamp-invalid");
  if (preparedAt > authorizedAt || authorizedAt > witnessAt || authorizedAt - preparedAt > 600_000 || witnessAt - authorizedAt > 600_000) {
    fail("authorization-stale");
  }
  assertPostHocIdentifier(witnessId);
  if (prepared.value.preparer_id === witnessId) fail("cooperative-identity-not-distinct");
}

function attestationFromBindings(prepared, authorization, witnessId, witnessedAt) {
  const p = prepared.value;
  return {
    schema: POST_HOC_ATTESTATION_SCHEMA, attestation_id: p.attestation_id, authority: "post-hoc-tl-attested-runtime-review",
    prepared_ref: structuredClone(prepared.ref), authorization_ref: structuredClone(authorization.ref), change_id: p.change_id,
    reviewed_head_sha: p.reviewed_head_sha, base_sha: p.base_sha, dispatch_id: p.dispatch_id, responsibility_id: p.responsibility_id,
    review_mode: p.review_mode, round_number: p.round_number, risk_shape_digest_sha256: p.risk_shape_digest_sha256,
    raw_payload_ref: structuredClone(p.raw_payload_ref), raw_payload_sha256: p.raw_payload_sha256, verdict: p.verdict,
    findings_digest_sha256: p.findings_digest_sha256, open_finding_ids: [...p.open_finding_ids],
    verdict_open_set_sha256: p.verdict_open_set_sha256, preparer_id: p.preparer_id, witness_id: witnessId,
    witnessed_at: witnessedAt, eligible_reason: p.eligible_reason,
  };
}

function sealPostHocAttestation({ repoRoot, changeId, preparedRef, authorizationRef, witnessId, witnessedAt, fsOps }) {
  const prepared = loadPrepared({ repoRoot, changeId, ref: preparedRef, failureCode: "attestation-binding-mismatch", fsOps });
  const authorization = loadAuthorization({ repoRoot, changeId, ref: authorizationRef, fsOps });
  validatePostHocTimeAndBinding(prepared, authorization, witnessId, witnessedAt);
  const tupleDigest = postHocTupleDigest(prepared.value);
  claimPostHocAuthorization({ repoRoot, root: prepared.root, tupleDigest, authorization, attestationId: prepared.value.attestation_id, claimedAt: witnessedAt, fsOps });
  const attestation = attestationFromBindings(prepared, authorization, witnessId, witnessedAt);
  const target = path.join(prepared.root, `${attestation.attestation_id}.json`);
  const written = writePostHocArtifact({ repoRoot, root: prepared.root, target, record: attestation, keys: ATTESTATION_KEYS, schema: POST_HOC_ATTESTATION_SCHEMA, collisionCode: "artifact-write-failed", idempotent: false, fsOps });
  const authorityRef = { attestation_id: attestation.attestation_id, digest_sha256: written.ref.digest_sha256 };
  return { attestation: written.value, ref: written.ref, authority_ref: authorityRef, eligible_tuple_digest_sha256: tupleDigest };
}

function verifyPostHocAuthorizationClaim({ repoRoot, root, tupleDigest, authorization, attestation, fsOps }) {
  const target = path.join(root, "authorization-tuples", `${tupleDigest}.claim`, "consumed.json");
  const keys = ["schema", "eligible_tuple_digest_sha256", "authorization_id", "authorization_sha256", "attestation_id", "claimed_at"];
  const loaded = readPostHocTarget({ repoRoot, target, keys, schema: POST_HOC_AUTHORIZATION_CLAIM_SCHEMA, failureCode: "attestation-binding-mismatch", fsOps });
  if (loaded.value.eligible_tuple_digest_sha256 !== tupleDigest
    || loaded.value.authorization_id !== authorization.value.authorization_id
    || loaded.value.authorization_sha256 !== authorization.ref.digest_sha256
    || loaded.value.attestation_id !== attestation.attestation_id
    || loaded.value.claimed_at !== attestation.witnessed_at) fail("attestation-binding-mismatch");
}

function verifyPostHocAttestation({ repoRoot, changeId, attestationId, fsOps }) {
  assertPostHocUuid(attestationId);
  const { root } = postHocRoot(repoRoot, changeId, { create: false });
  const target = path.join(root, `${attestationId}.json`);
  const loaded = readPostHocTarget({ repoRoot, target, keys: ATTESTATION_KEYS, schema: POST_HOC_ATTESTATION_SCHEMA, failureCode: "artifact-read-failed", fsOps });
  const a = loaded.value;
  if (a.attestation_id !== attestationId || a.change_id !== changeId || a.authority !== "post-hoc-tl-attested-runtime-review") fail("attestation-binding-mismatch");
  const prepared = loadPrepared({ repoRoot, changeId, ref: a.prepared_ref, failureCode: "attestation-binding-mismatch", readOnly: true, fsOps });
  const authorization = loadAuthorization({ repoRoot, changeId, ref: a.authorization_ref, failureCode: "attestation-binding-mismatch", readOnly: true, fsOps });
  validatePostHocTimeAndBinding(prepared, authorization, a.witness_id, a.witnessed_at);
  const expected = attestationFromBindings(prepared, authorization, a.witness_id, a.witnessed_at);
  if (canonicalJsonV1(expected) !== canonicalJsonV1(a)) fail("attestation-binding-mismatch");
  const tupleDigest = postHocTupleDigest(prepared.value);
  verifyPostHocAuthorizationClaim({ repoRoot, root, tupleDigest, authorization, attestation: a, fsOps });
  const authorityRef = { attestation_id: a.attestation_id, digest_sha256: loaded.ref.digest_sha256 };
  return { attestation: a, ref: loaded.ref, authority_ref: authorityRef, eligible_tuple_digest_sha256: tupleDigest };
}

function assertPostHocReceiptBinding(payload, attestationRef, verified) {
  const a = verified.attestation;
  if (canonicalJsonV1(attestationRef) !== canonicalJsonV1(verified.ref)
    || payload.reviewer_identity?.executor_kind !== "post-hoc-tl-attested-runtime-review"
    || canonicalJsonV1(payload.review_authority) !== canonicalJsonV1({ kind: "post-hoc-tl-attested-runtime-review", attestation_ref: verified.authority_ref })
    || payload.change_id !== a.change_id || payload.responsibility_id !== a.responsibility_id
    || payload.dispatch_id !== a.dispatch_id || payload.review_mode !== a.review_mode || payload.round_number !== a.round_number
    || payload.lineage?.base_sha !== a.base_sha || payload.lineage?.head_sha !== a.reviewed_head_sha
    || payload.scope?.risk_shape_digest_sha256 !== a.risk_shape_digest_sha256
    || canonicalJsonV1(payload.scope?.open_finding_ids) !== canonicalJsonV1(a.open_finding_ids)
    || payload.verdict !== a.verdict || sha256Hex(canonicalJsonV1(payload.findings)) !== a.findings_digest_sha256
    || canonicalJsonV1(payload.output_evidence?.raw_payload_ref) !== canonicalJsonV1(a.raw_payload_ref)
    || payload.output_evidence?.raw_payload_sha256 !== a.raw_payload_sha256
    || payload.output_evidence?.verdict_open_set_sha256 !== a.verdict_open_set_sha256) fail("attestation-binding-mismatch");
}

function claimPostHocAttestation({ repoRoot, changeId, verified, payload, claimedAt = new Date().toISOString(), fsOps }) {
  const ops = postHocMutationOps(fsOps);
  const { root } = postHocRoot(repoRoot, changeId, { fsOps });
  const claimDir = path.join(root, `${verified.attestation.attestation_id}.claim`);
  try {
    ops.mkdirSync(claimDir, { recursive: false, mode: 0o700 });
    ops.fsyncDirectory(root);
  } catch (error) {
    if (error?.code === "EEXIST") fail("attestation-consumed");
    throw error;
  }
  const proof = {
    schema: POST_HOC_ATTESTATION_CLAIM_SCHEMA,
    attestation_id: verified.attestation.attestation_id,
    attestation_sha256: verified.ref.digest_sha256,
    round_number: payload.round_number,
    head_sha: payload.lineage.head_sha,
    responsibility_id: payload.responsibility_id,
    dispatch_id: payload.dispatch_id,
    claimed_at: claimedAt,
  };
  ops.createExclusiveDurableFile({ root, parent: claimDir, target: path.join(claimDir, "consumed.json"), body: postHocPrettyBytes(proof) });
  return proof;
}

function assertPostHocAttestationClaim({ repoRoot, changeId, verified, payload, required, fsOps }) {
  const { root } = postHocRoot(repoRoot, changeId, { create: false });
  const target = path.join(root, `${verified.attestation.attestation_id}.claim`, "consumed.json");
  const keys = ["schema", "attestation_id", "attestation_sha256", "round_number", "head_sha", "responsibility_id", "dispatch_id", "claimed_at"];
  let loaded;
  try {
    loaded = readPostHocTarget({ repoRoot, target, keys, schema: POST_HOC_ATTESTATION_CLAIM_SCHEMA, failureCode: "attestation-binding-mismatch", fsOps });
  } catch (error) {
    // Only the helper's explicit missing/incorrect-ref boundary is an
    // optional unclaimed state. Native reads, parser faults and safety
    // failures must remain observable to the D30 generic fallback.
    if (!required && error instanceof CoreFailure && error.code === "attestation-binding-mismatch") return false;
    throw error;
  }
  const proof = loaded.value;
  if (proof.attestation_id !== verified.attestation.attestation_id || proof.attestation_sha256 !== verified.ref.digest_sha256
    || proof.round_number !== payload.round_number || proof.head_sha !== payload.lineage.head_sha
    || proof.responsibility_id !== payload.responsibility_id || proof.dispatch_id !== payload.dispatch_id
    || !Number.isFinite(Date.parse(proof.claimed_at))) fail("attestation-binding-mismatch");
  return true;
}

function crossCarrierClosureFileName(changeId, targetRoundNumber, sealHeadSha) {
  return `review-${changeId}-cross-carrier-closure-r${targetRoundNumber}-${sealHeadSha}.json`;
}

function manifestFileName(changeId, purpose, roundNumber) {
  return `review-${changeId}-manifest-${purpose}-r${roundNumber}.json`;
}

function finalFileName(changeId, headSha) {
  return `review-${changeId}-final-evidence-${headSha}.json`;
}

function archiveTransitionFileName(changeId, headSha) {
  return `review-${changeId}-archive-transition-${headSha}.json`;
}

function safeAbsoluteTarget(repoRoot, targetPath) {
  assertString(targetPath, "targetPath");
  const lexicalRoot = path.resolve(repoRoot);
  const absolute = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(lexicalRoot, targetPath);
  const relative = path.relative(lexicalRoot, absolute).split(path.sep).join("/");
  const canonical = assertSafeRepoRelativePath({ repoRoot, candidatePath: relative });
  return path.join(realpathSync(repoRoot), ...canonical.split("/"));
}

function defaultFsOps() {
  return {
    createExclusiveTemp({ targetPath, mode }) {
      const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
      return { handle: openSync(tempPath, "wx", mode), tempPath };
    },
    writeAll(handle, bytes) {
      let bytesWritten = 0;
      while (bytesWritten < bytes.length) {
        const written = writeSync(handle, bytes, bytesWritten, bytes.length - bytesWritten);
        if (written <= 0) fail("partial write while sealing evidence");
        bytesWritten += written;
      }
      return { bytesWritten };
    },
    fsyncFile(handle) {
      fsyncSync(handle);
    },
    publishExclusive({ tempPath, targetPath, bytes }) {
      try {
        linkSync(tempPath, targetPath);
        return { published: true };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = readFileSync(targetPath);
        if (!existing.equals(bytes)) fail(`evidence collision: ${targetPath} already exists with different bytes`);
        return { idempotent: true };
      }
    },
    fsyncParent({ targetPath }) {
      fsyncDirectory(path.dirname(targetPath));
      return process.platform === "win32"
        ? { documentedNoop: true, platform: "win32" }
        : { synced: true };
    },
    readWholeFile({ targetPath }) {
      return readFileSync(targetPath);
    },
    closeTemp({ handle }) {
      if (typeof handle === "number") closeSync(handle);
    },
    unlinkTemp({ tempPath }) {
      try {
        unlinkSync(tempPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}

function durableSeal({ repoRoot, targetPath, record, validateRecord, fsOps, collisionOnExisting = false }) {
  const absoluteTarget = safeAbsoluteTarget(repoRoot, targetPath);
  const bytes = Buffer.from(`${canonicalJsonV1(record)}\n`, "utf8");
  const ops = fsOps ?? defaultFsOps();
  let ownedTemp = null;
  try {
    ownedTemp = ops.createExclusiveTemp({ targetPath: absoluteTarget, mode: 0o600 });
    const writeResult = ops.writeAll(ownedTemp.handle, bytes);
    if (writeResult?.bytesWritten !== bytes.length) fail("receipt-publish-failed");
    ops.fsyncFile(ownedTemp.handle);
    const publication = ops.publishExclusive({ ...ownedTemp, targetPath: absoluteTarget, bytes });
    if (collisionOnExisting && publication?.idempotent) fail("receipt-path-collision");
    ops.fsyncParent({ targetPath: absoluteTarget });
    const readback = Buffer.from(ops.readWholeFile({ targetPath: absoluteTarget }));
    if (!readback.equals(bytes)) fail("receipt-readback-mismatch");
    let parsed;
    try {
      parsed = parseCanonicalJsonV1(readback);
    } catch (error) {
      if (error instanceof CoreFailure) throw error;
      fail("receipt-readback-mismatch");
    }
    validateRecord(parsed);
    ops.revalidateWholeFile?.({ record: parsed, bytes: readback });
    return parsed;
  } finally {
    if (ownedTemp !== null) {
      if (typeof ops.closeTemp === "function" && typeof ops.unlinkTemp === "function") {
        try {
          ops.closeTemp?.(ownedTemp);
        } catch {
          // Closing and unlinking are independent best-effort cleanup stages.
        }
        try {
          ops.unlinkTemp?.(ownedTemp);
        } catch {
          // Cleanup failure does not turn an unverified publication into PASS.
        }
      } else {
        try {
          ops.removeTemp(ownedTemp);
        } catch {
          // Backward-compatible injected seam cleanup remains best-effort.
        }
      }
    }
  }
}

function readCanonicalRecord({ repoRoot, targetPath, validateRecord }) {
  const absoluteTarget = safeAbsoluteTarget(repoRoot, targetPath);
  const record = parseCanonicalJsonV1(readFileSync(absoluteTarget));
  validateRecord(record);
  return record;
}

function assertResponsibilityId(value) {
  if (typeof value !== "string" || !RESPONSIBILITY_ID.test(value)) fail("reviewer_payload.responsibility_id must be a bounded identifier");
}

// D6 (2.5): conditional exact key sets — tl-direct is exactly {role, executor_kind};
// runtime-agent is exactly {role, executor_kind, executor_evidence}; any other
// executor_kind (including a missing one) is rejected. No default is applied.
function validateReviewerIdentityV2(identity) {
  assertObject(identity, "reviewer_payload.reviewer_identity");
  if (!LEGACY_V2_EXECUTOR_KINDS.has(identity.executor_kind)) fail("reviewer_identity.executor_kind must be runtime-agent or tl-direct");
  if (identity.executor_kind === "tl-direct") {
    assertExactKeys(identity, ["role", "executor_kind"], "reviewer_payload.reviewer_identity");
  } else {
    assertExactKeys(identity, ["role", "executor_kind", "executor_evidence"], "reviewer_payload.reviewer_identity");
    assertExactKeys(identity.executor_evidence, ["admission_record_id", "admission_record_sha256", "dispatch_id_sha256"], "reviewer_identity.executor_evidence");
    if (typeof identity.executor_evidence.admission_record_id !== "string" || !ADMISSION_RECORD_ID.test(identity.executor_evidence.admission_record_id)) {
      fail("executor_evidence.admission_record_id must be a UUID v4");
    }
    assertDigest(identity.executor_evidence.admission_record_sha256, "executor_evidence.admission_record_sha256");
    assertDigest(identity.executor_evidence.dispatch_id_sha256, "executor_evidence.dispatch_id_sha256");
  }
  if (!REVIEWER_ROLES.has(identity.role)) fail("reviewer role must be dp-reviewer");
}

// Independence attribution is schema-aware: current v3 normal and closed
// post-hoc authorities retain their exact executor kind; v1 and malformed
// legacy/current identities are unattributed. The terminal independence gate
// below still rejects tl-direct and every legacy receipt.
function receiptExecutorAttribution(record) {
  if (record?.schema === REVIEW_RECEIPT_SCHEMA_V1) return "legacy-unattributed";
  const kind = record?.reviewer_payload?.reviewer_identity?.executor_kind;
  return V3_EXECUTOR_KINDS.has(kind) ? kind : "legacy-unattributed";
}

function loadBoundAdmissionRecord({ repoRoot, payload, fsOps }) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) fail("admission record binding requires repoRoot");
  const evidence = payload.reviewer_identity.executor_evidence;
  // D15 (C) Read path: identifier validation, no-follow open, same-inode proof,
  // containment, body read through the fd — all inside readAdmissionRecord.
  const loaded = readAdmissionRecord({ repoRoot, changeId: payload.change_id, recordId: evidence.admission_record_id, propagateNativeFaults: true, readNoFollowFileHooks: fsOps?.admissionRecordReadHooks });
  if (!loaded.ok) fail(`admission record unavailable (${loaded.code})`);
  return loaded;
}

// D6 (2.4) binding rules, verified by producer and validator alike.
function assertAdmissionRecordBinding({ record, digest, payload, nowMs = Date.now() }) {
  const identity = payload.reviewer_identity;
  const evidence = identity.executor_evidence;
  if (digest !== evidence.admission_record_sha256) fail("admission record digest mismatch");
  if (record.role !== identity.role || !REVIEWER_ROLES.has(record.role)) fail("admission record role does not bind the reviewer identity");
  if (record.change_id !== payload.change_id) fail("admission record change_id mismatch");
  if (record.responsibility_id !== payload.responsibility_id) fail("admission record responsibility_id mismatch");
  if (record.head_sha !== payload.lineage.head_sha) fail("admission record head_sha does not match the reviewed head");
  const admitted = typeof record.admitted_at === "string" ? Date.parse(record.admitted_at) : Number.NaN;
  if (!Number.isFinite(admitted) || admitted > nowMs) fail("admission record admitted_at must precede receipt production");
  if (evidence.dispatch_id_sha256 !== payload.dispatch_id) fail("executor_evidence dispatch_id_sha256 must equal the receipt dispatch_id");
}

// A continuation inherits its independence from the fresh spawn that opened the
// responsibility thread (D34). Neither runtime's continuation payload carries a
// role field, so this chain — not the payload — is what binds a `continue`
// record to an independent reviewer. Which instance_mode may evidence
// independence lives here alone: `fresh` roots the chain, `continue` walks one
// hop, anything else (today `fork`) fails closed. Traversal is bounded at one
// record read per hop. The bound is in HOPS, not dispatches: a responsibility
// whose longest plausible life is five records (an initial full, three bounded
// rereviews and one replacement) spans four hops, so 8 is roughly double the
// expected depth. It is a fail-closed traversal ceiling deliberately NOT derived
// from the review round cap — coupling a safety bound to a policy number would
// silently move it whenever the policy moves. Deeper or cyclic chains fail
// closed instead of walking unbounded. The walker returns the fresh root record
// it reached: the generic v1 call site checks the root's schema and
// role_binding, while the v2 `executor_evidence` call site ignores the return
// value and keeps its original judgment.
const ADMISSION_CHAIN_MAX_HOPS = 8;

function assertAdmissionChainRootsToFresh({ repoRoot, record, fsOps }) {
  let current = record;
  const seen = new Set([current.record_id]);
  for (let hop = 0; hop <= ADMISSION_CHAIN_MAX_HOPS; hop += 1) {
    if (current.instance_mode === "fresh") return current;
    if (current.instance_mode !== "continue") {
      fail(`${current.instance_mode} admission record cannot evidence an independent runtime-agent reviewer`);
    }
    const loaded = readAdmissionRecord({ repoRoot, changeId: current.change_id, recordId: current.parent_record_id, propagateNativeFaults: true, readNoFollowFileHooks: fsOps?.admissionRecordReadHooks });
    if (!loaded.ok) fail(`admission chain parent unavailable (${loaded.code})`);
    const parent = loaded.record;
    if (seen.has(parent.record_id)) fail("admission chain contains a cycle");
    seen.add(parent.record_id);
    if (parent.change_id !== current.change_id) fail("admission chain parent change_id mismatch");
    if (parent.role !== current.role) fail("admission chain parent role mismatch");
    if (parent.responsibility_id !== current.responsibility_id) fail("admission chain parent responsibility_id mismatch");
    const parentAt = Date.parse(parent.admitted_at);
    const currentAt = Date.parse(current.admitted_at);
    if (!Number.isFinite(parentAt) || !Number.isFinite(currentAt) || parentAt >= currentAt) {
      fail("admission chain parent admitted_at must precede the continuation");
    }
    current = parent;
  }
  fail(`admission chain exceeds ${ADMISSION_CHAIN_MAX_HOPS} hops to a fresh root`);
}

// Each admission record evidences at most one receipt per change. The
// irreversible claim taken in `sealReviewRoundReceipt` is the first line; this
// scan remains a defence-in-depth reader for already-published receipts,
// including a different dispatch at the same round. Validation excludes only
// the exact receipt path it is currently reading, never every same-round name.
function assertAdmissionRecordUnique({ repoRoot, changeId, recordId, currentReceiptName, gitOps, fsOps }) {
  const notesRoot = derivedNotesRoot(repoRoot, gitOps, null, fsOps);
  const candidates = (fsOps?.readdirSync ?? readdirSync)(notesRoot)
    .map((name) => parseReceiptCandidateName(changeId, name))
    .filter((candidate) => candidate !== null);
  if (candidates.length > RECEIPT_CANDIDATE_LIMIT) fail("receipt-candidate-limit-exceeded");
  for (const candidate of candidates) {
    const { name } = candidate;
    // Validation walks an already-published receipt and therefore sees that
    // exact target in the directory. Only that exact self path is excluded;
    // another dispatch at the same round remains a conflicting use.
    if (candidate.name === currentReceiptName) continue;
    let bytes;
    try {
      // D15 (C) Read: verified parent containment, O_NOFOLLOW, regular-file and
      // same-inode proof, size bound, realpath still under the parent. The old
      // readFileSync on a lexically joined path followed symlinks and had no
      // size bound.
      ({ bytes } = readNoFollowFile({
        root: notesRoot,
        parent: notesRoot,
        target: path.join(notesRoot, name),
        maxBytes: RECEIPT_SCAN_MAX_BYTES,
      }));
    } catch (error) {
      if (!isDurablePathError(error)) throw error;
      fail(error.code === "target-oversize" ? "receipt-size-exceeded" : "evidence-artifact-invalid", durableFailureReason(error));
    }
    const other = withSemanticFailureCode("receipt-evidence-invalid", () => parseCanonicalJsonV1(bytes));
    const boundRecordId = other?.reviewer_payload?.review_authority?.admission_ref?.record_id
      ?? other?.reviewer_payload?.reviewer_identity?.executor_evidence?.admission_record_id;
    if (boundRecordId === recordId) {
      fail("admission record already evidences another receipt in this change");
    }
  }
}

function validateAdmissionBinding({ repoRoot, payload, gitOps, claimRequired, fsOps }) {
  const loaded = loadBoundAdmissionRecord({ repoRoot, payload, fsOps });
  assertAdmissionRecordBinding({ record: loaded.record, digest: loaded.digest, payload });
  assertAdmissionChainRootsToFresh({ repoRoot, record: loaded.record, fsOps });
  assertAdmissionRecordUnique({
    repoRoot,
    changeId: payload.change_id,
    recordId: payload.reviewer_identity.executor_evidence.admission_record_id,
    currentReceiptName: receiptFileNameForPayload(payload.change_id, payload),
    gitOps,
  });
  assertAdmissionRecordClaimMatches({ repoRoot, payload, claimRequired, fsOps });
}

// Single-use authority is the atomic claim written by sealReviewRoundReceipt
// (cross-model CRITICAL on PR #2473); the readdir scan above stays as a second
// line only. A claim that exists MUST be this receipt's claim.
//
// A proven-absent (ENOENT) claim is tolerated on exactly two paths, both
// deliberate. First, the pre-claim validation pass inside
// `sealReviewRoundReceipt`, which by construction runs before
// `claimAdmissionRecord` writes anything. Second, `walkReceiptAuthorityChain`,
// which reaches a receipt only as a lineage ancestor and so never asserts that
// receipt's own independence: the claim lives in gitignored
// `admission-records/**`, so demanding it during traversal would expire a
// committed chain together with its oldest surviving local claim
// (decisions.md D61). Every other caller is asserting the authority of the
// receipt it is reading back, where an absent claim means
// the single-use proof Done When 4 requires is simply not there — never written,
// or lost — and tolerating it there let such a receipt satisfy
// `verify-receipt --require-independence` anyway (C-04, PR #2473 second
// cross-model round). v1 legacy receipts never reach here: `legacy` short-circuits
// `validateAdmissionBinding` at its only call site.
function admissionClaimTuple(payload) {
  return {
    round_number: payload.round_number,
    head_sha: payload.lineage.head_sha,
    responsibility_id: payload.responsibility_id,
    dispatch_id: payload.dispatch_id,
  };
}

function assertAdmissionRecordClaimMatches({ repoRoot, payload, claimRequired, fsOps }) {
  const recordId = payload.reviewer_identity.executor_evidence.admission_record_id;
  const read = readAdmissionRecordClaim({ repoRoot, changeId: payload.change_id, recordId, propagateNativeFaults: true, readNoFollowFileHooks: fsOps?.admissionRecordReadHooks });
  if (!read.ok) fail(`admission record claim unavailable (${read.code})`);
  if (read.claim === null) {
    if (claimRequired) fail("admission-record-consumed");
    return;
  }
  const expected = admissionClaimTuple(payload);
  // A claim owned by another dispatch means the record was consumed elsewhere;
  // a claim owned by this dispatch whose other fields drifted is tampering.
  if (read.claim.dispatch_id !== expected.dispatch_id) fail("admission-record-consumed");
  for (const key of Object.keys(expected)) {
    if (read.claim[key] !== expected[key]) fail(`admission record claim does not match the receipt (${key})`);
  }
}

function validateV3IdentityAuthority(identity, authority) {
  if (!hasExactKeySet(identity, ["role", "executor_kind"])) fail("receipt-identity-authority-mismatch");
  if (!V3_EXECUTOR_KINDS.has(identity.executor_kind)) fail("receipt-identity-authority-mismatch");
  if (!isStrictPlainObject(authority) || Object.keys(authority).length === 0 || !Object.hasOwn(authority, "kind")) fail("receipt-authority-missing");
  // D2 (fix-receipt-authority-host-generic): runtime-admission accepts a
  // closed two-shape set — the Codex two-piece {kind, intent_ref,
  // admission_ref} or the generic one-piece {kind, admission_ref}. A shape
  // matching neither keeps the existing closed tokens: every actual key
  // inside the union means a candidate shape is missing a key
  // (receipt-authority-missing); anything outside the union is a mixed shape
  // (receipt-authority-mixed). post-hoc and tl-direct shapes are unchanged.
  const authorityKeySets = authority.kind === "runtime-admission"
    ? [["kind", "intent_ref", "admission_ref"], ["kind", "admission_ref"]]
    : authority.kind === "post-hoc-tl-attested-runtime-review"
      ? [["kind", "attestation_ref"]]
      : authority.kind === "tl-direct-review"
        ? [["kind"]]
        : null;
  if (authorityKeySets === null) fail("receipt-identity-authority-mismatch");
  const actualKeys = Object.keys(authority);
  const matchesKeySet = (keySet) => actualKeys.length === keySet.length && keySet.every((key) => actualKeys.includes(key));
  if (!authorityKeySets.some(matchesKeySet)) {
    const union = [...new Set(authorityKeySets.flat())];
    fail(actualKeys.every((key) => union.includes(key)) ? "receipt-authority-missing" : "receipt-authority-mixed");
  }
  const expectedKind = identity.executor_kind === "runtime-agent"
    ? "runtime-admission"
    : identity.executor_kind === "post-hoc-tl-attested-runtime-review"
      ? "post-hoc-tl-attested-runtime-review"
      : "tl-direct-review";
  if (identity.role !== "dp-reviewer" || authority.kind !== expectedKind) fail("receipt-identity-authority-mismatch");
  if (authority.intent_ref !== undefined) {
    assertExactKeys(authority.intent_ref, ["intent_id", "digest_sha256"], "review_authority.intent_ref");
    if (!UUID_V4.test(authority.intent_ref.intent_id)) fail("receipt-authority-mixed");
    assertDigest(authority.intent_ref.digest_sha256, "review_authority.intent_ref.digest_sha256");
  }
  if (authority.admission_ref !== undefined) {
    assertExactKeys(authority.admission_ref, ["record_id", "digest_sha256"], "review_authority.admission_ref");
    if (!UUID_V4.test(authority.admission_ref.record_id)) fail("receipt-authority-mixed");
    assertDigest(authority.admission_ref.digest_sha256, "review_authority.admission_ref.digest_sha256");
  }
  if (authority.attestation_ref !== undefined) {
    assertExactKeys(authority.attestation_ref, ["attestation_id", "digest_sha256"], "review_authority.attestation_ref");
    if (!UUID_V4.test(authority.attestation_ref.attestation_id)) fail("receipt-authority-mixed");
    assertDigest(authority.attestation_ref.digest_sha256, "review_authority.attestation_ref.digest_sha256");
  }
}

function hasExactKeySet(value, expected) {
  if (!isStrictPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function validateV3OutputEvidence(payload, repoRoot) {
  const output = payload.output_evidence;
  assertExactKeys(output, ["raw_payload_ref", "raw_payload_sha256", "verdict_open_set_sha256"], "reviewer_payload.output_evidence");
  assertDurableRef(output.raw_payload_ref, "output_evidence.raw_payload_ref");
  assertDigest(output.raw_payload_sha256, "output_evidence.raw_payload_sha256");
  assertDigest(output.verdict_open_set_sha256, "output_evidence.verdict_open_set_sha256");
  if (output.raw_payload_ref.digest_sha256 !== output.raw_payload_sha256) fail("receipt-output-evidence-mismatch");
  if (output.raw_payload_ref.path !== rawReviewerOutputFileName(payload.change_id, payload.round_number, payload.dispatch_id)) {
    fail("receipt-output-evidence-mismatch");
  }
  const ids = payload.scope.open_finding_ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(ids).size !== ids.length
    || ids.some((id, index) => index > 0 && compareCodePoints(ids[index - 1], id) >= 0)) {
    fail("receipt-output-evidence-mismatch");
  }
  const expected = sha256Hex(canonicalJsonV1({ verdict: payload.verdict, open_finding_ids: ids }));
  if (expected !== output.verdict_open_set_sha256) fail("receipt-output-evidence-mismatch");
  if (repoRoot !== null) {
    const notesRoot = derivedNotesRoot(repoRoot);
    const target = path.join(notesRoot, ...assertSafeRepoRelativePath({ repoRoot: notesRoot, candidatePath: output.raw_payload_ref.path }).split("/"));
    let bytes;
    try {
      ({ bytes } = readNoFollowFile({ root: notesRoot, parent: notesRoot, target, maxBytes: 4 * 1024 * 1024 }));
    } catch (error) {
      if (!isDurablePathError(error)) throw error;
      fail("evidence-artifact-invalid", durableFailureReason(error));
    }
    if (sha256Hex(bytes) !== output.raw_payload_sha256) fail("receipt-output-evidence-mismatch");
    if (payload.review_authority.kind !== "post-hoc-tl-attested-runtime-review") {
      let rawPayload;
      try {
        rawPayload = parseJsonDuplicateAware(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        assertExactKeys(rawPayload, [
          ...REVIEWER_PAYLOAD_V3_KEYS,
          ...(Object.hasOwn(rawPayload, "execution_root_head") ? ["execution_root_head"] : []),
          ...(Object.hasOwn(rawPayload, "guarantee_assessment") ? ["guarantee_assessment"] : []),
        ], "raw reviewer payload");
      } catch {
        fail("receipt-output-evidence-mismatch");
      }
      if (rawPayload.review_authority !== null || rawPayload.output_evidence !== null) {
        fail("receipt-output-evidence-mismatch");
      }
      const expectedRawPayload = structuredClone(payload);
      expectedRawPayload.review_authority = null;
      expectedRawPayload.output_evidence = null;
      if (canonicalJsonV1(rawPayload) !== canonicalJsonV1(expectedRawPayload)) {
        fail("receipt-output-evidence-mismatch");
      }
    }
  }
}

// D1/D3 (fix-receipt-authority-host-generic): schema-first runtime-admission
// authority. A v2 record keeps the exact Codex prepared-intent path
// (verifyCodexReviewerAdmissionAuthority, zero behavior change); a v1 record
// binds through the generic content-to-ID checks below. The producer (seal)
// and validator (verify) sides share these two helpers so the binding set
// cannot drift between them. The branch key is the record's own schema —
// host strings never enter control flow (NFR4).
function deriveRuntimeAdmissionAuthorityRefs({ repoRoot, payload, recordId, fsOps }) {
  const loaded = readAdmissionRecord({ repoRoot, changeId: payload.change_id, recordId, propagateNativeFaults: true, readNoFollowFileHooks: fsOps?.admissionRecordReadHooks });
  if (!loaded.ok) fail("receipt-identity-authority-mismatch");
  if (loaded.record.schema === CODEX_REVIEWER_ADMISSION_SCHEMA) {
    const authority = verifyCodexReviewerAdmissionAuthority({ repoRoot, changeId: payload.change_id, recordId, propagateNativeFaults: true });
    if (!authority.ok) fail("receipt-identity-authority-mismatch");
    return {
      intent_ref: structuredClone(authority.intent_ref),
      admission_ref: structuredClone(authority.admission_ref),
    };
  }
  if (loaded.record.schema !== ADMISSION_RECORD_SCHEMA) fail("receipt-identity-authority-mismatch");
  const admissionRef = { record_id: recordId, digest_sha256: loaded.digest };
  assertGenericAdmissionContentToId({ repoRoot, loaded, payload, admissionRef, fsOps });
  return { admission_ref: admissionRef };
}

// The generic content-to-ID binding (design D3). Check 1 (ref digest == record
// bytes digest) is the content-to-ID core; the reader already proved
// record.record_id == the ref's record_id. The next checks bind the record's
// content fields to the payload, so a continuation record must name the head
// the receipt reviewed. The record's role_binding then picks the path, never a
// host string: `host-verified` is the fresh authority and passes unchanged; a
// `cooperative-only` record passes only as a declared `continue` whose chain
// roots at a host-verified v1 fresh record, walked by the one shared
// assertAdmissionChainRootsToFresh (strengthen-continuation-receipt-chain-
// verification D1/D2); every other record stays one closed
// `receipt-identity-authority-mismatch`. A chain fault is
// `receipt-authority-invalid` on the build, seal and verify faces alike and its
// message names the fault, never a path.
function assertGenericAdmissionContentToId({ repoRoot, loaded, payload, admissionRef, fsOps }) {
  if (loaded.digest !== admissionRef.digest_sha256) fail("receipt-identity-authority-mismatch");
  const record = loaded.record;
  if (record.change_id !== payload.change_id
    || record.head_sha !== payload.lineage.head_sha
    || record.responsibility_id !== payload.responsibility_id
    || record.role !== "dp-reviewer") {
    fail("receipt-identity-authority-mismatch");
  }
  if (record.role_binding === "host-verified") return;
  if (record.role_binding !== "cooperative-only" || record.instance_mode !== "continue") {
    fail("receipt-identity-authority-mismatch");
  }
  withSemanticFailureCode("receipt-authority-invalid", () => {
    const root = assertAdmissionChainRootsToFresh({ repoRoot, record, fsOps });
    if (root.schema !== ADMISSION_RECORD_SCHEMA) fail("admission chain root is not a generic admission record");
    if (root.role_binding !== "host-verified") fail("admission chain root is not host-verified");
  });
}

function validateV3NormalAuthority({ repoRoot, payload, gitOps, claimRequired, fsOps }) {
  if (payload.review_authority.kind !== "runtime-admission") return;
  if (repoRoot === null) fail("receipt-authority-mixed");
  const { admission_ref: admissionRef, intent_ref: intentRef } = payload.review_authority;
  // D1 (fix-receipt-authority-host-generic): the record's own schema decides
  // the path — v2 prepared intent, v1 generic binding — never a host string.
  // A v1 record carrying an intent_ref and a v2 record without one are both
  // fail-closed mismatches.
  const loaded = readAdmissionRecord({ repoRoot, changeId: payload.change_id, recordId: admissionRef.record_id, propagateNativeFaults: true, readNoFollowFileHooks: fsOps?.admissionRecordReadHooks });
  if (!loaded.ok) fail("receipt-identity-authority-mismatch");
  if (loaded.record.schema === CODEX_REVIEWER_ADMISSION_SCHEMA) {
    if (intentRef === undefined) fail("receipt-identity-authority-mismatch");
    const authority = verifyCodexReviewerAdmissionAuthority({ repoRoot, changeId: payload.change_id, recordId: admissionRef.record_id, propagateNativeFaults: true });
    if (!authority.ok) fail("receipt-identity-authority-mismatch");
    const { record } = authority.admission;
    if (authority.admission.digest !== admissionRef.digest_sha256 || authority.intent_ref.intent_id !== intentRef.intent_id
      || authority.intent_ref.digest_sha256 !== intentRef.digest_sha256
      || record.change_id !== payload.change_id || record.head_sha !== payload.lineage.head_sha
      || record.responsibility_id !== payload.responsibility_id || record.role !== "dp-reviewer") {
      fail("receipt-identity-authority-mismatch");
    }
  } else if (loaded.record.schema === ADMISSION_RECORD_SCHEMA) {
    if (intentRef !== undefined) fail("receipt-identity-authority-mismatch");
    assertGenericAdmissionContentToId({ repoRoot, loaded, payload, admissionRef, fsOps });
  } else {
    fail("receipt-identity-authority-mismatch");
  }
  // D8.2: a present `execution_root_head` MUST equal the admission record
  // `head_sha` the receipt is bound to; any difference is the existing
  // `receipt-authority-changed` (no new code). Absent values stay readable for
  // historical payloads; the producer side (prepare) requires the key on every
  // new runtime-agent seal.
  if (Object.hasOwn(payload, "execution_root_head") && payload.execution_root_head !== loaded.record.head_sha) {
    fail("receipt-authority-changed");
  }
  withSemanticFailureCode("receipt-authority-invalid", () => assertAdmissionRecordUnique({
    repoRoot,
    changeId: payload.change_id,
    recordId: admissionRef.record_id,
    currentReceiptName: receiptFileNameForPayload(payload.change_id, payload),
    gitOps,
    fsOps,
  }));
  const claim = readAdmissionRecordClaim({ repoRoot, changeId: payload.change_id, recordId: admissionRef.record_id, propagateNativeFaults: true, readNoFollowFileHooks: fsOps?.admissionRecordReadHooks });
  if (!claim.ok) fail("admission-record-consumed");
  if (claim.claim === null) {
    if (claimRequired) fail("admission-record-consumed");
    return;
  }
  const expected = admissionClaimTuple(payload);
  if (Object.keys(expected).some((key) => claim.claim[key] !== expected[key])) fail("admission-record-consumed");
}

function validateV3PostHocAuthority({ repoRoot, payload, claimRequired }) {
  if (payload.review_authority.kind !== "post-hoc-tl-attested-runtime-review") return;
  if (repoRoot === null) fail("attestation-binding-mismatch");
  const ref = payload.review_authority.attestation_ref;
  const verified = verifyPostHocAttestation({ repoRoot, changeId: payload.change_id, attestationId: ref.attestation_id });
  assertPostHocReceiptBinding(payload, { path: verified.ref.path, digest_sha256: ref.digest_sha256 }, verified);
  assertPostHocAttestationClaim({ repoRoot, changeId: payload.change_id, verified, payload, required: claimRequired });
}

// Optional on historical v3 payloads; new dispatch acceptance checks presence.
// Metadata stays outside immutable finding observations and receipt authority.
function validatePayloadGuaranteeAssessment(payload) {
  if (!Object.hasOwn(payload, "guarantee_assessment")) return null;
  try {
    return validateReviewGuaranteeAssessment(payload.guarantee_assessment, {
      reviewedTarget: payload.lineage.head_sha, dispatchId: payload.dispatch_id,
      findingIds: payload.findings.map(entry => entry.finding_id),
    });
  } catch (error) { fail(error.message); }
}

function validateReviewerPayloadV3(payload, { repoRoot = null, gitOps, claimRequired = true, fsOps } = {}) {
  // `execution_root_head` is the conditional positional attestation (design
  // D8.1), in the same "present ⇒ validated" shape as
  // `scope.risk_shape_digest_alg`: a historical payload that predates the key
  // stays readable, while a present value must be a 40-hex sha.
  assertExactKeys(payload, [
    ...REVIEWER_PAYLOAD_V3_KEYS,
    ...(Object.hasOwn(payload, "execution_root_head") ? ["execution_root_head"] : []),
    ...(Object.hasOwn(payload, "guarantee_assessment") ? ["guarantee_assessment"] : []),
  ], "reviewer_payload");
  if (Object.hasOwn(payload, "execution_root_head")) {
    assertSha(payload.execution_root_head, "reviewer_payload.execution_root_head");
  }
  withSemanticFailureCode("receipt-authority-invalid", () =>
    validateV3IdentityAuthority(payload.reviewer_identity, payload.review_authority));
  const legacyShape = {
    dispatch_id: payload.dispatch_id,
    change_id: payload.change_id,
    responsibility_id: payload.responsibility_id,
    reviewer_identity: { role: "dp-reviewer", executor_kind: "tl-direct" },
    review_mode: payload.review_mode,
    round_number: payload.round_number,
    bounded_rereview_count: payload.bounded_rereview_count,
    lineage: payload.lineage,
    scope: payload.scope,
    findings: payload.findings,
    verdict: payload.verdict,
  };
  withSemanticFailureCode("receipt-evidence-invalid", () =>
    validateReviewerPayload(legacyShape, { repoRoot, gitOps, schema: REVIEW_RECEIPT_SCHEMA_V2, claimRequired: false, fsOps, requirementScopeEpoch: true }));
  withSemanticFailureCode("receipt-evidence-invalid", () => validatePayloadGuaranteeAssessment(payload));
  withSemanticFailureCode("receipt-evidence-invalid", () => validateV3OutputEvidence(payload, repoRoot));
  withSemanticFailureCode("receipt-authority-invalid", () =>
    validateV3NormalAuthority({ repoRoot, payload, gitOps, claimRequired, fsOps }));
  withSemanticFailureCode("post-hoc-evidence-invalid", () =>
    validateV3PostHocAuthority({ repoRoot, payload, claimRequired }));
}

// `requirementScopeEpoch` is module-internal (never a request field): only the v3 entries
// (the legacy-shape call in validateReviewerPayloadV3 and the raw-capture validation) pass
// true, so a real v1/v2 receipt that carries `requirement_scope` still fails as an unknown
// observation key and an outer-resigned legacy receipt cannot acquire a label.
function validateReviewerPayload(payload, { repoRoot = null, gitOps, schema = REVIEW_RECEIPT_SCHEMA, claimRequired = true, fsOps, requirementScopeEpoch = false } = {}) {
  if (!REVIEW_RECEIPT_SCHEMAS.has(schema)) fail("unknown review receipt schema");
  if (schema === REVIEW_RECEIPT_SCHEMA) return validateReviewerPayloadV3(payload, { repoRoot, gitOps, claimRequired, fsOps });
  const legacy = schema === REVIEW_RECEIPT_SCHEMA_V1;
  assertExactKeys(payload, [
    "dispatch_id",
    "reviewer_identity",
    "review_mode",
    "round_number",
    "bounded_rereview_count",
    "lineage",
    "scope",
    "findings",
    "verdict",
    ...(legacy ? [] : ["change_id", "responsibility_id"]),
  ], "reviewer_payload");
  assertDigest(payload.dispatch_id, "reviewer_payload.dispatch_id");
  if (legacy) {
    assertExactKeys(payload.reviewer_identity, ["role"], "reviewer_payload.reviewer_identity");
    if (payload.reviewer_identity.role !== "dp-reviewer") fail("reviewer role must be dp-reviewer");
  } else {
    assertChangeId(payload.change_id);
    assertResponsibilityId(payload.responsibility_id);
    validateReviewerIdentityV2(payload.reviewer_identity);
  }
  if (!REVIEW_MODES.has(payload.review_mode)) {
    fail(`invalid review_mode: expected one of ${[...REVIEW_MODES].join(" | ")}, got ${JSON.stringify(payload.review_mode)}`);
  }
  assertSafeInteger(payload.round_number, "round_number");
  if (payload.round_number < 1) fail("round_number must be positive");
  assertSafeInteger(payload.bounded_rereview_count, "bounded_rereview_count");
  if (payload.bounded_rereview_count < 0) fail("bounded rereview count cannot be negative");
  if (payload.review_mode === "bounded" && payload.bounded_rereview_count === 0) {
    fail("bounded receipt count must be positive");
  }
  if (!RECEIPT_VERDICTS.has(payload.verdict)) fail("invalid receipt verdict");

  assertExactKeys(payload.lineage, [
    "base_sha",
    "merge_base_sha",
    "head_sha",
    "previous_receipt_ref",
    "initial_full_receipt_digest_sha256",
  ], "reviewer_payload.lineage");
  assertSha(payload.lineage.base_sha, "lineage.base_sha");
  assertSha(payload.lineage.merge_base_sha, "lineage.merge_base_sha");
  assertSha(payload.lineage.head_sha, "lineage.head_sha");
  if (payload.lineage.previous_receipt_ref !== null) {
    assertDurableRef(payload.lineage.previous_receipt_ref, "lineage.previous_receipt_ref");
  }
  assertDigest(payload.lineage.initial_full_receipt_digest_sha256, "lineage.initial full receipt digest", true);

  assertExactKeys(payload.scope, [
    "risk_shape_digest_sha256",
    "open_finding_ids",
    "repair_delta_manifest_ref",
    "dependency_closure_manifest_ref",
    ...(Object.hasOwn(payload.scope, "risk_shape_digest_alg") ? ["risk_shape_digest_alg"] : []),
  ], "reviewer_payload.scope");
  assertDigest(payload.scope.risk_shape_digest_sha256, "scope risk shape digest");
  if (Object.hasOwn(payload.scope, "risk_shape_digest_alg")) {
    resolveRiskShapeDigestAlg(payload.scope.risk_shape_digest_alg);
  }
  const openIds = assertUniqueStrings(payload.scope.open_finding_ids, "scope.open_finding_ids");
  for (const [key, label] of [
    ["repair_delta_manifest_ref", "scope repair manifest ref"],
    ["dependency_closure_manifest_ref", "scope closure manifest ref"],
  ]) {
    if (payload.scope[key] !== null) assertDurableRef(payload.scope[key], label);
  }
  if (payload.review_mode === "bounded"
    && (payload.lineage.previous_receipt_ref === null
      || payload.lineage.initial_full_receipt_digest_sha256 === null
      || payload.scope.repair_delta_manifest_ref === null
      || payload.scope.dependency_closure_manifest_ref === null)) {
    fail("bounded receipt requires complete receipt and manifest lineage");
  }
  if (payload.round_number === 1) {
    if (payload.review_mode !== "full" || payload.bounded_rereview_count !== 0
      || payload.lineage.previous_receipt_ref !== null
      || payload.lineage.initial_full_receipt_digest_sha256 !== null) {
      fail("round one must be initial full with zero count and null predecessor lineage");
    }
  } else if (payload.lineage.previous_receipt_ref === null
    || payload.lineage.initial_full_receipt_digest_sha256 === null) {
    fail("round_number successor receipt requires previous receipt ref and initial full digest");
  }
  if (payload.review_mode === "full"
    && (payload.scope.repair_delta_manifest_ref !== null || payload.scope.dependency_closure_manifest_ref !== null)) {
    fail("full receipt cannot own bounded manifests", "full-review-manifests-nonnull");
  }
  if (!Array.isArray(payload.findings)) fail("reviewer_payload.findings must be an array");
  const findingIds = new Set();
  const currentOpenIds = new Set();
  for (const [index, entry] of payload.findings.entries()) {
    const label = `reviewer_payload.findings[${index}]`;
    assertExactKeys(entry, ["finding_id", "state", "disposition", "observation"], label);
    assertString(entry.finding_id, `${label}.finding_id`);
    if (findingIds.has(entry.finding_id)) fail("duplicate finding_id in reviewer payload");
    findingIds.add(entry.finding_id);
    if (!FINDING_STATES.has(entry.state)) fail(`${label}.state is invalid`);
    if (entry.state === "open") {
      if (entry.disposition !== null) fail(`${label}.open finding disposition must be null`);
      currentOpenIds.add(entry.finding_id);
    } else if (!DISPOSITIONS.has(entry.disposition)) {
      fail(`${label}.closed finding requires a closed disposition`);
    }
    assertObject(entry.observation, `${label}.observation`);
    assertExactKeys(entry.observation, [
      "axis", "severity", "carrier", "anchor", "detail", "evidence",
      ...(requirementScopeEpoch && Object.hasOwn(entry.observation, "requirement_scope") ? ["requirement_scope"] : []),
    ], `${label}.observation`);
    if (Object.hasOwn(entry.observation, "requirement_scope")
      && !REQUIREMENT_SCOPES.includes(entry.observation.requirement_scope)) {
      fail(`${label}.observation.requirement_scope is invalid`);
    }
    if (!/^[1-6]$/.test(entry.observation.axis)) fail(`${label}.observation.axis is invalid`);
    if (!["Critical", "Important", "Suggestion"].includes(entry.observation.severity)) {
      fail(`${label}.observation.severity is invalid`);
    }
    assertString(entry.observation.carrier, `${label}.observation.carrier`);
    assertString(entry.observation.anchor, `${label}.observation.anchor`);
    assertString(entry.observation.detail, `${label}.observation.detail`);
    if (repoRoot !== null) {
      assertSafeRepoRelativePath({ repoRoot, candidatePath: entry.observation.carrier });
    }
    if (!Array.isArray(entry.observation.evidence) || entry.observation.evidence.length === 0) {
      fail(`${label}.observation.evidence must be non-empty`);
    }
    for (const evidence of entry.observation.evidence) {
      assertString(evidence, `${label}.observation.evidence[]`);
      if (repoRoot !== null) assertSafeRepoRelativePath({ repoRoot, candidatePath: evidence });
    }
    if (entry.state === "closed" && (entry.observation.severity === "Important" || entry.observation.severity === "Critical")) {
      // D1 close-time fail-fast: Important/Critical may not close via follow-up/defer unless
      // the finding is out of the requirement package (closedBlockingDispositionProblem, the
      // same verdict assertConvergedReceipt applies). Bound-HEAD carrier proof below stays
      // Critical-only and applies to every Critical that passes the disposition verdict.
      const dispositionProblem = closedBlockingDispositionProblem({ entry, payload, repoRoot, gitOps });
      if (dispositionProblem !== null) fail(`${label}.${dispositionProblem}`);
    }
    if (entry.state === "closed" && entry.observation.severity === "Critical") {
      if (repoRoot === null) fail(`${label}.Critical closure requires bound-HEAD evidence authority`);
      let carrierBytes;
      try {
        carrierBytes = reviewerBoundHeadObjectBytes(repoRoot, payload.lineage.head_sha, entry.observation.carrier, gitOps);
      } catch (error) {
        // Git process failures are untyped I/O unless the owning command has a
        // listed completed status. Keep them out of the receipt-content code.
        throw error;
      }
      if (!carrierBytes.includes(Buffer.from(entry.observation.anchor, "utf8"))) {
        fail(`${label}.Critical closure anchor is stale or absent from its bound-HEAD carrier`);
      }
      const evidencePaths = new Set();
      for (const evidence of entry.observation.evidence) {
        if (evidencePaths.has(evidence)) fail(`${label}.Critical closure evidence is not unique`);
        evidencePaths.add(evidence);
        try {
          reviewerBoundHeadObjectBytes(repoRoot, payload.lineage.head_sha, evidence, gitOps);
        } catch (error) {
          throw error;
        }
      }
    }
  }
  if (openIds.size !== currentOpenIds.size || [...openIds].some((id) => !currentOpenIds.has(id))) {
    fail("scope open_finding_ids must exactly match open findings");
  }
  if (!legacy && payload.reviewer_identity.executor_kind === "runtime-agent") {
    validateAdmissionBinding({ repoRoot, payload, gitOps, claimRequired, fsOps });
  }
}

// Seal-clearing verdict for one closed Critical/Important finding, shared by the close-time
// loop in validateReviewerPayload and by assertConvergedReceipt so the two can never disagree
// (design D9). Returns null when the closure clears the seal, otherwise the failure text
// (without the caller's label prefix). Severity is never rewritten here.
//   fix-now / non-issue-with-evidence ........ clears, any scope
//   tracked-follow-up + in-scope / unlabeled .. rejected (existing message)
//   tracked-follow-up + out-of-requirement .... clears
//   tracked-follow-up + scope-unresolved ...... clears only with a bound TL scope ruling
//   defer-with-owner-trigger .................. rejected, any scope (existing message)
function closedBlockingDispositionProblem({ entry, payload, repoRoot, gitOps }) {
  const severity = entry.observation?.severity;
  if (entry.state !== "closed" || (severity !== "Critical" && severity !== "Important")) return null;
  if (SEAL_CLEARANCE_DISPOSITIONS.includes(entry.disposition)) return null;
  const scope = Object.hasOwn(entry.observation, "requirement_scope") ? entry.observation.requirement_scope : "in-scope";
  const floor = `${severity} finding disposition cannot close a receipt (blocking_id=${entry.finding_id})`;
  if (entry.disposition !== OUT_OF_SCOPE_CLOSURE_DISPOSITION || scope === "in-scope") return floor;
  if (scope === "out-of-requirement") return null;
  // Anything else than the closed scope-unresolved value (unreachable for a validated payload)
  // keeps the in-scope floor: an unrecognised label must never loosen the gate.
  if (scope !== "scope-unresolved") return floor;
  const reason = scopeRulingProblem({ entry, payload, repoRoot, gitOps });
  if (reason === null) return null;
  return `scope-unresolved ${severity} closure needs a TL scope ruling bound to its observation hash, round and proposal content (${reason}; blocking_id=${entry.finding_id})`;
}

// A scope-unresolved Critical/Important closed with tracked-follow-up clears the seal only with a
// TL ruling committed at the receipt's bound HEAD (design D2/D9). Returns null when exactly one
// entry binds this finding, its observation hash, the receipt's round and the proposal carrier's
// raw bytes with `ruling: out-of-requirement`; otherwise one reason from SCOPE_RULING_REASONS.
// Everything unproven fails closed. Only a Git fault that is not a proven-missing carrier is
// rethrown untouched: it stays a fault and is never reported as a missing or unbound ruling.
// Nothing here parses a requirement ledger (design gate round 3 F-r3-01): the proposal binding is
// the sha256 of the carrier's bytes, so any edit unbinds an earlier ruling.
function scopeRulingProblem({ entry, payload, repoRoot, gitOps }) {
  if (repoRoot === null) return SCOPE_RULING_REASONS.repoRootAbsent;
  const changeFolder = `openspec/changes/${payload.change_id}`;
  const headSha = payload.lineage.head_sha;
  const decisions = boundHeadCarrier(repoRoot, headSha, `${changeFolder}/decisions.md`, gitOps);
  if (decisions.state === "absent") return SCOPE_RULING_REASONS.decisionsAbsent;
  if (decisions.state === "unreadable") return SCOPE_RULING_REASONS.decisionsUnreadable;
  let decisionsText;
  try {
    decisionsText = strictUtf8Bytes(decisions.bytes, "decisions.md");
  } catch (error) {
    if (!error?.[CORE_DOMAIN_PREDICATE] || error instanceof CoreFailure) throw error;
    return SCOPE_RULING_REASONS.decisionsUnreadable;
  }
  const rulings = readScopeRulings(decisionsText);
  if (typeof rulings === "string") return rulings;
  const carriers = PROPOSAL_CARRIERS
    .map((name) => boundHeadCarrier(repoRoot, headSha, `${changeFolder}/${name}`, gitOps))
    .filter(({ state }) => state !== "absent");
  if (carriers.length !== 1 || carriers[0].state !== "present") return SCOPE_RULING_REASONS.carrierAmbiguous;
  const proposalSha = sha256Hex(carriers[0].bytes);
  const observationHash = observationDigest(entry);
  const matches = rulings.filter((ruling) => ruling.finding_id === entry.finding_id
    && ruling.observation_hash_sha256 === observationHash
    && ruling.round_number === payload.round_number
    && ruling.proposal_sha256 === proposalSha);
  if (matches.length === 0) return SCOPE_RULING_REASONS.noBinding;
  // readScopeRulings already rejected a repeated binding tuple, so at most one entry matches.
  return matches[0].ruling === "out-of-requirement" ? null : SCOPE_RULING_REASONS.ruledInScope;
}

// One Git object read at the bound HEAD. `absent` is only the proven-missing carrier; a domain
// failure from the read (not a 100644 blob, malformed record) is `unreadable`; any other fault,
// such as a Git or spawn error, is rethrown.
function boundHeadCarrier(repoRoot, headSha, repoRelativePath, gitOps) {
  try {
    return { state: "present", bytes: reviewerBoundHeadObjectBytes(repoRoot, headSha, repoRelativePath, gitOps) };
  } catch (error) {
    if (riskShapeFaultReason(error) === RISK_SHAPE_DEBUG_REASONS.CARRIER_NOT_AT_HEAD) return { state: "absent", bytes: null };
    if (error?.[CORE_DOMAIN_PREDICATE] && !(error instanceof CoreFailure)) return { state: "unreadable", bytes: null };
    throw error;
  }
}

// The validated entries of the one live `## Scope Rulings` section, or a reason string.
// HTML comments outside fences are blanked first: a ruling wrapped in `<!-- -->` is not shown on
// the rendered page, so it must not authorize anything (the TL's way to revoke without deleting).
function readScopeRulings(decisionsText) {
  const { count, bodies } = extractExactH2Bodies(neutraliseInertMarkdown(decisionsText, { keepFences: true }), SCOPE_RULINGS_HEADING);
  if (count !== 1) return SCOPE_RULING_REASONS.headingNotUnique;
  const jsonText = onlyJsonFence(bodies[0]);
  if (jsonText === null) return SCOPE_RULING_REASONS.fenceNotUnique;
  let parsed;
  try {
    parsed = parseJsonDuplicateAware(jsonText);
  } catch (error) {
    if (!error?.[CORE_DOMAIN_PREDICATE] || error instanceof CoreFailure) throw error;
    return SCOPE_RULING_REASONS.jsonInvalid;
  }
  if (!Array.isArray(parsed)) return SCOPE_RULING_REASONS.jsonInvalid;
  const tuples = new Set();
  for (const [index, ruling] of parsed.entries()) {
    try {
      assertExactKeys(ruling, SCOPE_RULING_KEYS, `scope ruling ${index}`);
      assertString(ruling.finding_id, `scope ruling ${index}.finding_id`);
      assertDigest(ruling.observation_hash_sha256, `scope ruling ${index}.observation_hash_sha256`);
      assertSafeInteger(ruling.round_number, `scope ruling ${index}.round_number`);
      assertDigest(ruling.proposal_sha256, `scope ruling ${index}.proposal_sha256`);
      assertString(ruling.rationale, `scope ruling ${index}.rationale`);
      if (!SCOPE_RULING_VALUES.includes(ruling.ruling)) fail(`scope ruling ${index}.ruling is invalid`);
    } catch (error) {
      if (!error?.[CORE_DOMAIN_PREDICATE] || error instanceof CoreFailure) throw error;
      return SCOPE_RULING_REASONS.entryMalformed;
    }
    const tuple = canonicalJsonV1([ruling.finding_id, ruling.observation_hash_sha256, ruling.round_number, ruling.proposal_sha256]);
    if (tuples.has(tuple)) return SCOPE_RULING_REASONS.tupleRepeated;
    tuples.add(tuple);
  }
  return parsed;
}

// The text of the section's fence when it holds exactly one fence and that fence is ```json,
// otherwise null. An unclosed fence is never accepted.
function onlyJsonFence(sectionBody) {
  const fences = [];
  let open = null;
  let current = null;
  for (const line of sectionBody.split("\n")) {
    const delimiter = fenceDelimiter(line);
    if (open === null) {
      if (delimiter !== null) {
        open = delimiter;
        current = { info: delimiter.info.trim(), lines: [] };
      }
    } else if (delimiter !== null && closesFence(delimiter, open)) {
      fences.push(current);
      open = null;
      current = null;
    } else {
      current.lines.push(line);
    }
  }
  if (open !== null || fences.length !== 1 || fences[0].info !== "json") return null;
  return fences[0].lines.join("\n");
}

function observationDigest(entry) {
  return sha256Hex(canonicalJsonV1({ finding_id: entry.finding_id, observation: entry.observation }));
}

function validateReceiptRecord(record, options = {}) {
  return withSemanticFailureCode("receipt-evidence-invalid", () => validateReceiptRecordContents(record, options));
}

function validateReceiptRecordContents(record, options = {}) {
  assertExactKeys(record, ["schema", "receipt_digest_sha256", "observation_hashes", "reviewer_payload"], "receipt");
  if (!REVIEW_RECEIPT_SCHEMAS.has(record.schema)) fail("unknown review receipt schema");
  validateReviewerPayload(record.reviewer_payload, { ...options, schema: record.schema });
  assertDigest(record.receipt_digest_sha256, "receipt digest");
  if (record.receipt_digest_sha256 !== sha256Hex(canonicalJsonV1(record.reviewer_payload))) {
    fail("receipt payload digest mismatch");
  }
  if (!Array.isArray(record.observation_hashes)) fail("observation_hashes must be an array");
  if (record.schema === REVIEW_RECEIPT_SCHEMA && record.observation_hashes.length !== record.reviewer_payload.findings.length) {
    fail("receipt-output-evidence-mismatch");
  }
  const hashes = new Map();
  const hashValues = new Set();
  for (const [index, entry] of record.observation_hashes.entries()) {
    assertExactKeys(entry, ["finding_id", "observation_hash_sha256"], `observation_hashes[${index}]`);
    assertString(entry.finding_id, `observation_hashes[${index}].finding_id`);
    assertDigest(entry.observation_hash_sha256, `observation_hashes[${index}].observation_hash_sha256`);
    if (hashes.has(entry.finding_id)) fail("duplicate observation finding_id");
    if (hashValues.has(entry.observation_hash_sha256)) fail("observation hash collision across finding IDs");
    hashes.set(entry.finding_id, entry.observation_hash_sha256);
    hashValues.add(entry.observation_hash_sha256);
  }
  if (hashes.size !== record.reviewer_payload.findings.length) fail("observation/finding ID sets differ");
  for (const finding of record.reviewer_payload.findings) {
    if (hashes.get(finding.finding_id) !== observationDigest(finding)) {
      fail(record.schema === REVIEW_RECEIPT_SCHEMA ? "receipt-output-evidence-mismatch" : "observation hash mismatch or missing finding ID");
    }
  }
  if (record.schema === REVIEW_RECEIPT_SCHEMA && record.observation_hashes.some((entry, index) => entry.finding_id !== record.reviewer_payload.findings[index].finding_id)) {
    fail("receipt-output-evidence-mismatch");
  }
  return record;
}

function isAncestor(repoRoot, ancestor, descendant, gitOps) {
  return selectedGitOps(gitOps).isAncestor({
    repoRoot,
    ancestorSha: ancestor,
    descendantSha: descendant,
  });
}

// Git object comparison, not range-diff porcelain: preserve every tracked
// review-bearing byte/mode, including paths absent from Touch or manifests.
// The existing Path D′ whitelist is narrowed here to plain Markdown blobs;
// this does not extend post-PR sticky freshness or authorize Git rewrites.
function equivalentForwardReanchorBase(repoRoot, previousHead, candidateHead, newBase, gitOps) {
  const context = gitOperationContext(gitOps);
  const key = `${operationRepoIdentity(repoRoot)}\0${previousHead}\0${candidateHead}\0${newBase}`;
  if (context?.equivalentReanchorBases.has(key)) return context.equivalentReanchorBases.get(key);
  let result = null;
  try {
    const oldBase = selectedGitOps(gitOps).mergeBase({ repoRoot, leftSha: previousHead, rightSha: newBase });
    if (oldBase !== newBase && isAncestor(repoRoot, oldBase, newBase, gitOps)
      && isAncestor(repoRoot, newBase, candidateHead, gitOps)) {
      const bytes = gitBuffer(repoRoot, ["diff", "--raw", "--no-abbrev", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", previousHead, candidateHead, "--"], "cannot compare reanchor trees");
      const records = strictUtf8Bytes(bytes, "reanchor tree comparison").split("\0");
      if (records.pop() !== "" || records.length % 2 !== 0) fail("reanchor tree comparison is incomplete");
      let equivalent = true;
      for (let i = 0; i < records.length; i += 2) {
        const recordPath = records[i + 1];
        // Unchanged blobs/modes do not appear in --raw. Every changed entry
        // must be a regular 100644 Markdown bookkeeping file (or absent).
        if (!/^:(?:000000|100644) (?:000000|100644) [a-f0-9]+ [a-f0-9]+ [ADM]$/u.test(records[i])
          || !isWhitelistedPath(recordPath) || !recordPath.endsWith(".md")
          || assertSafeRepoRelativePath({ repoRoot, candidatePath: recordPath }) !== recordPath) {
          equivalent = false;
          break;
        }
      }
      if (equivalent) result = oldBase;
    }
  } catch {
    // Missing objects, overflow or unavailable evidence never narrow review.
  }
  context?.equivalentReanchorBases.set(key, result);
  return result;
}

function validateReceiptOwnGitLineage({ repoRoot, payload, gitOps }) {
  const actualMergeBase = selectedGitOps(gitOps).mergeBase({
    repoRoot,
    leftSha: payload.lineage.base_sha,
    rightSha: payload.lineage.head_sha,
  });
  if (actualMergeBase !== payload.lineage.merge_base_sha) fail("receipt merge-base mismatch");
}

function validateRoundOwnedManifests({ repoRoot, changeId, payload, previousPayload, gitOps }) {
  if (payload.review_mode !== "bounded") return;
  for (const [ref, purpose] of [
    [payload.scope.repair_delta_manifest_ref, "repair-delta"],
    [payload.scope.dependency_closure_manifest_ref, "dependency-closure"],
  ]) {
    if (ref.path !== manifestFileName(changeId, purpose, payload.round_number)) {
      fail("bounded receipt manifest ownership or round mismatch");
    }
    const loaded = readEvidenceRef({
      repoRoot,
      ref,
      label: `${purpose} historical manifest ref`,
      validateRecord: validateManifestRecord,
      gitOps,
    });
    validateManifestFilesAndTrust(loaded.record, { repoRoot, verificationMode: "historical", gitOps });
    // D15 (r12 F-r12-1): the same eligibility classify requires before a bounded
    // dispatch. A pass manifest already has no exceptions or errors (manifest
    // shape rule), so result plus the closure cycle check is the full set.
    if (loaded.record.result !== "pass" || (purpose === "dependency-closure" && hasDirectedCycle(loaded.record))) {
      fail(`${purpose} historical manifest is not bounded eligible`);
    }
    if (loaded.record.purpose !== purpose
      || loaded.record.lineage.change_base_sha !== payload.lineage.base_sha
      || loaded.record.lineage.surface_base_sha !== previousPayload.lineage.head_sha
      || loaded.record.lineage.candidate_head_sha !== payload.lineage.head_sha) {
      fail(`${purpose} historical manifest lineage does not match receipt round`);
    }
  }
}

function requireRecoveryStallExhausted(stallProjection, previousRoundNumber) {
  const rounds = stallProjection.filter((round) => round.round_number <= previousRoundNumber);
  if (!isReviewStallBudgetExhausted({ rounds })) fail("bounded receipt risk shape changed");
}

function validateReceiptTransition({
  repoRoot, changeId, payload, previousPayload, previousRef, gitOps, requireRecoveryStall,
}) {
  if (payload.round_number !== previousPayload.round_number + 1) fail("receipt round chain is not contiguous");
  const expectedPreviousPath = receiptFileNameForPayload(changeId, previousPayload);
  if (payload.lineage.previous_receipt_ref.path !== expectedPreviousPath
    || payload.lineage.previous_receipt_ref.path !== previousRef.path
    || payload.lineage.previous_receipt_ref.digest_sha256 !== previousRef.digest_sha256) {
    fail("previous receipt ref is not the exact immediate round");
  }
  if (previousPayload.round_number !== payload.round_number - 1) fail("receipt round chain is not contiguous");
  const gitLineageChanged = previousPayload.lineage.base_sha !== payload.lineage.base_sha
    || previousPayload.lineage.merge_base_sha !== payload.lineage.merge_base_sha
    || !isAncestor(repoRoot, previousPayload.lineage.head_sha, payload.lineage.head_sha, gitOps);
  if (gitLineageChanged && payload.review_mode !== "full") {
    const equivalent = resolveRiskShapeDigestAlg(previousPayload.scope.risk_shape_digest_alg) === RISK_SHAPE_DIGEST_ALG_V1
      && resolveRiskShapeDigestAlg(payload.scope.risk_shape_digest_alg) === RISK_SHAPE_DIGEST_ALG_V1
      && previousPayload.scope.risk_shape_digest_sha256 === payload.scope.risk_shape_digest_sha256
      && equivalentForwardReanchorBase(repoRoot, previousPayload.lineage.head_sha, payload.lineage.head_sha, payload.lineage.base_sha, gitOps) === previousPayload.lineage.base_sha;
    if (!equivalent) fail("only a full-review successor may cross a changed Git lineage");
  }
  const expectedInitialDigest = previousPayload.round_number === 1
    ? payload.lineage.previous_receipt_ref.digest_sha256
    : previousPayload.lineage.initial_full_receipt_digest_sha256;
  if (payload.lineage.initial_full_receipt_digest_sha256 !== expectedInitialDigest) {
    fail("initial full receipt digest mismatch");
  }
  const expectedCount = previousPayload.bounded_rereview_count + (payload.review_mode === "bounded" ? 1 : 0);
  if (payload.bounded_rereview_count !== expectedCount) fail("bounded rereview count is not monotonic");
  // R9 (fix-merge-gate-regression-currency D14): under an exhausted stall,
  // classify issues convergence_recovery for a mere risk_shape_changed, and
  // that dispatch must seal. The dispatch_id, recomputed from this receipt,
  // must carry the convergence_recovery authorization reason, but it is
  // recomputable, so it only names the authorization (D14 security).
  // enforce-hotfix-release-carrier D13 also requires every receipt-derivable
  // condition under which the classifier mints that round:
  // behavior-risk-v1 on both sides (else digest_alg_mismatch reopens full), a
  // predecessor that was not handback-authorized (else handback_required),
  // and a stall-exhausted sealed predecessor chain. Bounded-eligible round
  // manifests (pass, acyclic closure) are enforced for every bounded receipt
  // by validateRoundOwnedManifests below.
  // A wording-repair bounded receipt (wordingRepairFindingIds) is the other bounded round that may carry a
  // new risk digest: the walk re-derives its eligibility from the same evidence classify used, below the
  // automatic cap only, and never after a handback-authorized predecessor.
  const wordingRepair = payload.review_mode === "bounded"
    && previousPayload.scope.risk_shape_digest_sha256 !== payload.scope.risk_shape_digest_sha256
    && receiptWasWordingRepair(payload, changeId);
  if (wordingRepair) {
    if (resolveRiskShapeDigestAlg(payload.scope.risk_shape_digest_alg) !== RISK_SHAPE_DIGEST_ALG_V1
      || resolveRiskShapeDigestAlg(previousPayload.scope.risk_shape_digest_alg) !== RISK_SHAPE_DIGEST_ALG_V1
      || previousPayload.bounded_rereview_count >= 3
      || receiptWasHandbackAuthorized(previousPayload, changeId)
      || wordingRepairFromEvidence({ repoRoot, changeId, previousPayload, candidateHead: payload.lineage.head_sha, gitOps }) === null) {
      fail("bounded receipt risk shape changed");
    }
  } else if (payload.review_mode === "bounded"
    && previousPayload.scope.risk_shape_digest_sha256 !== payload.scope.risk_shape_digest_sha256) {
    if (!receiptWasConvergenceRecovery(payload, changeId)
      || resolveRiskShapeDigestAlg(payload.scope.risk_shape_digest_alg) !== RISK_SHAPE_DIGEST_ALG_V1
      || resolveRiskShapeDigestAlg(previousPayload.scope.risk_shape_digest_alg) !== RISK_SHAPE_DIGEST_ALG_V1
      || receiptWasHandbackAuthorized(previousPayload, changeId)) {
      fail("bounded receipt risk shape changed");
    }
    requireRecoveryStall(previousPayload.round_number);
  }
  validateRoundOwnedManifests({ repoRoot, changeId, payload, previousPayload, gitOps });
}

function requirePostCapOverrideClaim({ repoRoot, changeId, payload, gitOps }) {
  if (payload.review_mode !== "bounded" || payload.bounded_rereview_count <= 3) return;
  if (hasConsumedHalfStateOverrideClaim({
    repoRoot,
    changeId,
    responsibilityId: payload.responsibility_id,
    dispatchId: payload.dispatch_id,
  })) {
    return;
  }
  if (proveConvergenceRecoveryPostCapExemption({ repoRoot, changeId, payload, gitOps })) {
    return;
  }
  fail("bounded receipt past automatic cap requires consumed review-dispatch override claim");
}

function proveConvergenceRecoveryPostCapExemption({ repoRoot, changeId, payload, gitOps }) {
  // D2: exempt only when chain walk proves classify issued convergence_recovery
  // bound to this dispatch_id + manifests, and the predecessor was a cap/stall
  // gate that was not handback_authorized_*.
  const digestAlg = resolveRiskShapeDigestAlg(payload.scope.risk_shape_digest_alg);
  const riskDigest = digestAlg === RISK_SHAPE_DIGEST_ALG_V1
    ? payload.scope.risk_shape_digest_sha256
    : deriveHistoricalRiskShapeDigest({
      repoRoot,
      changeId,
      candidateHead: payload.lineage.head_sha,
      gitOps,
      digestAlg,
    });
  if (matchAuthorizationReasonForDispatch(payload, riskDigest, changeId) !== "convergence_recovery") {
    return false;
  }
  if (payload.lineage.previous_receipt_ref === null) return false;
  const previousPayload = readEvidenceRef({
    repoRoot,
    ref: payload.lineage.previous_receipt_ref,
    label: "convergence recovery predecessor",
    validateRecord: (record) => validateReceiptRecord(record, { repoRoot, gitOps, claimRequired: false }),
    gitOps,
  }).record.reviewer_payload;
  if (payload.bounded_rereview_count !== previousPayload.bounded_rereview_count + 1) {
    return false;
  }
  const prevRisk = previousPayload.scope.risk_shape_digest_sha256;
  const prevAuth = matchAuthorizationReasonForDispatch(previousPayload, prevRisk, changeId);
  if (prevAuth === "handback_authorized_bounded" || prevAuth === "handback_authorized_full") {
    return false;
  }
  // Cap-path and post-first-recovery seals always see predecessor count >= 3.
  // Stall's first recovery seals at count 3 (below this gate); a forged jump
  // from count < 3 to count > 3 is rejected here.
  return previousPayload.bounded_rereview_count >= 3;
}

function walkReceiptAuthorityChain({ repoRoot, changeId, targetRef, gitOps, fsOps }) {
  const seenPaths = new Set();
  const seenDigests = new Set();
  const seenRounds = new Set();
  // `fix-zero-value-review-rounds` D3: the open-finding trajectory is
  // collected during THIS traversal rather than by a second walk of the same
  // chain. Every round's payload is already loaded and validated here, so a
  // separate reader would re-do the identical work and, worse, could reach a
  // different verdict about the same chain. Descending (newest first) while
  // walking; reversed to ascending before it is returned, which is the order
  // `deriveReviewStallStreak` documents.
  const stallProjectionDescending = [];
  // Recovery transitions are walked newest first, before the rounds below
  // them are loaded; their stall proof runs once the projection is complete.
  const recoveryStallRounds = [];
  let ref = targetRef;
  let expectedRound = null;
  let descendantPayload = null;
  let target = null;
  let visited = 0;
  while (true) {
    assertDurableRef(ref, "receipt chain ref");
    if (seenPaths.has(ref.path) || seenDigests.has(ref.digest_sha256)) {
      fail("receipt chain contains a duplicate path or digest");
    }
    seenPaths.add(ref.path);
    seenDigests.add(ref.digest_sha256);
    // `claimRequired: false`: this walk never asserts any receipt's own
    // independence. It establishes chain integrity, and it reaches every
    // receipt through `previous_receipt_ref` lineage. Stating the property of
    // the walk rather than of its callers is deliberate: `validateReceiptTemporal`
    // does validate its own payload strictly first, but `classifyBoundedRereview`
    // hands `previousReceiptRef` straight here with no prior strict pass -- which
    // is sound precisely because it derives routing, not independence. The claim
    // lives in gitignored `admission-records/**`, so requiring it here would make
    // a committed chain expire with its oldest local claim; independence is
    // proved once, at the round that seals it (decisions.md D61).
    const loaded = readEvidenceRef({
      repoRoot,
      ref,
      label: "receipt chain ref",
      validateRecord: (record) => validateReceiptRecord(record, { repoRoot, gitOps, claimRequired: false, fsOps }),
      gitOps,
      semanticSafetyCode: "evidence-artifact-invalid",
      fsOps,
    });
    const payload = loaded.record.reviewer_payload;
    requirePostCapOverrideClaim({ repoRoot, changeId, payload, gitOps });
    if (expectedRound === null) expectedRound = payload.round_number;
    if (payload.round_number !== expectedRound
      || ref.path !== receiptFileNameForPayload(changeId, payload)
      || seenRounds.has(payload.round_number)) {
      fail("receipt chain round/path is duplicate or discontinuous");
    }
    seenRounds.add(payload.round_number);
    validateCommittedReceiptMarker({ repoRoot, changeId, receiptRef: ref, receipt: loaded.record, gitOps, fsOps });
    stallProjectionDescending.push({
      round_number: payload.round_number,
      open_finding_ids: [...payload.scope.open_finding_ids],
      blocking_ids: blockingIdsFromFindings(payload.findings),
    });
    visited += 1;
    validateReceiptOwnGitLineage({ repoRoot, payload, gitOps });
    validateHistoricalReceiptAuthority({ repoRoot, changeId, payload, gitOps });
    if (target === null) target = { ...loaded, ref };
    if (descendantPayload !== null) {
      withSemanticFailureCode("receipt-evidence-invalid", () => validateReceiptTransition({
        repoRoot,
        changeId,
        payload: descendantPayload,
        previousPayload: payload,
        previousRef: ref,
        gitOps,
        requireRecoveryStall: (previousRoundNumber) => recoveryStallRounds.push(previousRoundNumber),
      }));
    }
    if (expectedRound === 1) {
      if (payload.round_number !== 1
        || payload.review_mode !== "full"
        || payload.bounded_rereview_count !== 0
        || payload.lineage.previous_receipt_ref !== null
        || payload.lineage.initial_full_receipt_digest_sha256 !== null) {
        fail("receipt chain did not terminate at an exact initial full round");
      }
      break;
    }
    if (payload.lineage.previous_receipt_ref === null) fail("receipt chain terminated before round one");
    descendantPayload = payload;
    ref = payload.lineage.previous_receipt_ref;
    expectedRound -= 1;
  }
  if (target === null || visited !== target.record.reviewer_payload.round_number) {
    fail("receipt chain did not contain its declared round count");
  }
  // D3: an additional field on a module-private return value. It is NOT part
  // of any exported schema — `DISPATCH_RESULT_KEYS`, the receipt record shape
  // and `REQUIRED_CORE_EXPORTS` are all unchanged. All three existing callers
  // read only `.record` / `.ref` / `.bytes`, so the field is inert for them.
  target.stallProjection = stallProjectionDescending.slice().reverse();
  for (const previousRoundNumber of recoveryStallRounds) {
    requireRecoveryStallExhausted(target.stallProjection, previousRoundNumber);
  }
  return target;
}

function validateReceiptTemporal({ repoRoot, changeId, payload, gitOps, fsOps }) {
  validateReceiptOwnGitLineage({ repoRoot, payload, gitOps });
  requirePostCapOverrideClaim({ repoRoot, changeId, payload, gitOps });
  if (payload.round_number === 1) return null;
  const previous = walkReceiptAuthorityChain({
    repoRoot,
    changeId,
    targetRef: payload.lineage.previous_receipt_ref,
    gitOps,
    fsOps,
  });
  withSemanticFailureCode("receipt-evidence-invalid", () => validateReceiptTransition({
    repoRoot,
    changeId,
    payload,
    previousPayload: previous.record.reviewer_payload,
    previousRef: previous.ref,
    gitOps,
    requireRecoveryStall: (previousRoundNumber) => requireRecoveryStallExhausted(
      previous.stallProjection, previousRoundNumber),
  }));
  return previous;
}

function expectedReceiptDispatch({ repoRoot, changeId, payload, riskDigest, gitOps }) {
  const gitAuthority = currentGitAuthority(repoRoot, gitOps);
  if (payload.lineage.base_sha !== gitAuthority.base_sha
    || payload.lineage.merge_base_sha !== gitAuthority.merge_base_sha
    || payload.lineage.head_sha !== gitAuthority.head_sha) {
    fail("receipt-authority-changed");
  }
  const matchedReason = matchAuthorizationReasonForDispatch(payload, riskDigest, changeId);
  if (matchedReason === undefined) fail("receipt-authority-changed");
  const expected = dispatchResult({
    route: payload.review_mode,
    count: payload.bounded_rereview_count,
    roundNumber: payload.round_number,
    riskDigest,
    reason: matchedReason,
    changeId,
    gitAuthority,
    previousReceiptRef: payload.lineage.previous_receipt_ref,
    initialFullDigest: payload.lineage.initial_full_receipt_digest_sha256,
    repairManifestRef: payload.scope.repair_delta_manifest_ref,
    closureManifestRef: payload.scope.dependency_closure_manifest_ref,
  });
  if (payload.dispatch_id !== expected.dispatch_id) fail("receipt-authority-changed");
  return expected.dispatch_id;
}

function receiptAuthoritySnapshot({ repoRoot, changeId, payload, fsOps, gitOps }) {
  if (currentHead(repoRoot) !== payload.lineage.head_sha) fail("receipt-authority-changed");
  const previous = validateReceiptTemporal({ repoRoot, changeId, payload, gitOps, fsOps });
  const digestAlg = resolveRiskShapeDigestAlg(payload.scope.risk_shape_digest_alg);
  // Current seals under behavior-risk-v1 re-read the pinned worktree so
  // selected-section drift fails closed. Historical full-prose digests (post-hoc
  // allowlist) recompute from the bound Git tree only.
  const riskDigest = digestAlg === RISK_SHAPE_DIGEST_ALG_V1
    ? deriveRiskShapeDigest(deriveRiskShapeSnapshot({
      repoRoot,
      changeId,
      candidateHead: payload.lineage.head_sha,
      fsOps,
      gitOps,
    }))
    : deriveHistoricalRiskShapeDigest({
      repoRoot,
      changeId,
      candidateHead: payload.lineage.head_sha,
      gitOps,
      digestAlg,
    });
  if (payload.scope.risk_shape_digest_sha256 !== riskDigest) fail("receipt-authority-changed");
  const dispatchId = expectedReceiptDispatch({ repoRoot, changeId, payload, riskDigest, gitOps });
  const authority = {
    head_sha: payload.lineage.head_sha,
    risk_shape_digest_sha256: riskDigest,
    dispatch_id: dispatchId,
    previous_receipt_digest_sha256: null,
    manifests: [],
  };
  if (payload.lineage.previous_receipt_ref !== null) {
    if (previous === null) fail("previous receipt authority is unavailable");
    authority.previous_receipt_digest_sha256 = sha256Hex(previous.bytes);
  }
  if (payload.review_mode === "bounded") {
    for (const [ref, purpose] of [
      [payload.scope.repair_delta_manifest_ref, "repair-delta"],
      [payload.scope.dependency_closure_manifest_ref, "dependency-closure"],
    ]) {
      const loaded = readEvidenceRef({
        repoRoot,
        ref,
        label: `${purpose} manifest ref`,
        validateRecord: validateManifestRecord,
        gitOps,
      });
      withSemanticFailureCode("receipt-evidence-invalid", () =>
        validateManifestFilesAndTrust(loaded.record, { repoRoot, verificationMode: "current", gitOps }));
      if (loaded.record.purpose !== purpose
        || loaded.record.lineage.change_base_sha !== payload.lineage.base_sha
        || loaded.record.lineage.candidate_head_sha !== payload.lineage.head_sha) {
        fail(`${purpose} manifest lineage does not match receipt`);
      }
      authority.manifests.push({ purpose, digest_sha256: sha256Hex(loaded.bytes) });
    }
  }
  return sha256Hex(canonicalJsonV1(authority));
}

// D41: bind exactly one producer authority branch. Normal runtime reviews bind
// admissionRecordId to the payload's prepared-intent/admission refs; closed
// post-hoc recovery binds attestationRef; tl-direct binds neither. A legacy
// caller-supplied executor_evidence or mixed transport refs are rejected.
function bindProducerReviewAuthority({ repoRoot, changeId, reviewerPayload, admissionRecordId, attestationRef }) {
  assertObject(reviewerPayload, "reviewer_payload");
  if (!Object.hasOwn(reviewerPayload, "review_authority") || !Object.hasOwn(reviewerPayload, "output_evidence")) {
    fail("legacy-receipt-seal-forbidden");
  }
  if (reviewerPayload.change_id !== changeId) fail("reviewer_payload.change_id must equal the sealed changeId");
  const identity = reviewerPayload.reviewer_identity;
  assertObject(identity, "reviewer_payload.reviewer_identity");
  if (Object.hasOwn(identity, "executor_evidence")) fail("receipt-authority-mixed");
  if (identity.executor_kind === "runtime-agent") {
    const boundId = reviewerPayload.review_authority?.admission_ref?.record_id;
    if (typeof admissionRecordId !== "string" || admissionRecordId !== boundId || attestationRef !== null && attestationRef !== undefined) fail("receipt-identity-authority-mismatch");
    return { reviewerPayload, postHoc: null };
  }
  if (identity.executor_kind === "post-hoc-tl-attested-runtime-review") {
    if (admissionRecordId !== null && admissionRecordId !== undefined) fail("receipt-identity-authority-mismatch");
    const attestationId = reviewerPayload.review_authority?.attestation_ref?.attestation_id;
    const verified = verifyPostHocAttestation({ repoRoot, changeId, attestationId });
    assertPostHocReceiptBinding(reviewerPayload, attestationRef, verified);
    return { reviewerPayload, postHoc: verified };
  }
  if (admissionRecordId !== null && admissionRecordId !== undefined || attestationRef !== null && attestationRef !== undefined) {
    fail("receipt-identity-authority-mismatch");
  }
  return { reviewerPayload, postHoc: null };
}

function readRawReviewerPayloadForBuilder({ repoRoot, rawPayloadRef, allowHistoricalPostHoc, gitOps }) {
  assertDurableRef(rawPayloadRef, "rawPayloadRef");
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const canonicalPath = assertSafeRepoRelativePath({ repoRoot: notesRoot, candidatePath: rawPayloadRef.path });
  const loaded = readEvidenceBytes({
    repoRoot,
    targetPath: path.join(notesRoot, ...canonicalPath.split("/")),
    label: "rawPayloadRef",
    gitOps,
    maxBytes: 4 * 1024 * 1024,
  });
  if (loaded.ref.digest_sha256 !== rawPayloadRef.digest_sha256) fail("raw-payload-digest-mismatch");
  try {
    const payload = validateCanonicalRawReviewerPayload({ bytes: loaded.bytes, repoRoot, gitOps });
    return { payload, bytes: loaded.bytes };
  } catch (error) {
    if (!error?.[CORE_DOMAIN_PREDICATE] && !(error instanceof CoreFailure)) throw error;
    if (!allowHistoricalPostHoc) fail("receipt-output-evidence-mismatch");
    // The only post-hoc authority is the closed D40 historical recovery set.
    // Its already-attested raw carrier predates canonical v3 and contains one
    // fenced reviewerPayload. Keep this parser unreachable without a verified
    // post-hoc ref so it cannot become a general legacy/markdown fallback.
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes);
    } catch {
      fail("receipt-output-evidence-mismatch");
    }
    const marker = "## reviewerPayload\n\n```json\n";
    const start = text.indexOf(marker);
    const end = start < 0 ? -1 : text.indexOf("\n```", start + marker.length);
    if (start < 0 || end < 0 || text.indexOf(marker, start + marker.length) >= 0) {
      fail("receipt-output-evidence-mismatch");
    }
    let payload;
    try {
      payload = parseJsonDuplicateAware(text.slice(start + marker.length, end));
      assertExactKeys(payload, HISTORICAL_POST_HOC_RAW_PAYLOAD_KEYS, "historical post-hoc raw reviewer payload");
    } catch {
      fail("receipt-output-evidence-mismatch");
    }
    return { payload, bytes: loaded.bytes };
  }
}

function buildReviewRoundReceiptRequest({
  repoRoot,
  changeId,
  rawPayloadRef,
  admissionRecordId = null,
  attestationRef = null,
  bindingRoot = null,
  fsOps,
  gitOps,
}) {
  assertChangeId(changeId);
  // Design D7.2: resolve the effective root once, at the outermost layer, and
  // pass the binding root down; the builder and sealer replay the same seam.
  const consumerBinding = resolveConsumerBinding({ repoRoot, changeId, bindingRoot, propagateNativeFaults: true });
  repoRoot = consumerBinding.repoRoot;
  changeId = consumerBinding.changeId;
  if (admissionRecordId !== null && attestationRef !== null) fail("receipt-authority-mixed");
  let verifiedPostHoc = null;
  if (attestationRef !== null) {
    assertDurableRef(attestationRef, "attestationRef");
    const match = path.basename(attestationRef.path).match(/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u);
    if (match === null) fail("attestation-binding-mismatch");
    verifiedPostHoc = verifyPostHocAttestation({ repoRoot, changeId, attestationId: match[1] });
    if (canonicalJsonV1(verifiedPostHoc.ref) !== canonicalJsonV1(attestationRef)) fail("attestation-binding-mismatch");
  }
  const raw = readRawReviewerPayloadForBuilder({
    repoRoot,
    rawPayloadRef,
    allowHistoricalPostHoc: verifiedPostHoc !== null,
    gitOps,
  });
  const reviewerPayload = structuredClone(raw.payload);
  if (reviewerPayload.change_id !== changeId
    || rawPayloadRef.path !== rawReviewerOutputFileName(
      changeId,
      reviewerPayload.round_number,
      reviewerPayload.dispatch_id,
    )) {
    fail("receipt-output-evidence-mismatch");
  }

  if (verifiedPostHoc !== null) {
    if (admissionRecordId !== null) fail("receipt-authority-mixed");
    reviewerPayload.reviewer_identity = {
      role: "dp-reviewer",
      executor_kind: "post-hoc-tl-attested-runtime-review",
    };
    reviewerPayload.review_authority = {
      kind: "post-hoc-tl-attested-runtime-review",
      attestation_ref: structuredClone(verifiedPostHoc.authority_ref),
    };
  } else if (reviewerPayload.reviewer_identity?.executor_kind === "runtime-agent") {
    if (typeof admissionRecordId !== "string") fail("receipt-identity-authority-mismatch");
    // D5 (fix-receipt-authority-host-generic): the authority refs are derived
    // from the verified record bytes — v2 through the Codex prepared-intent
    // verifier, v1 through the shared generic content-to-ID helper — never
    // accepted from the caller.
    reviewerPayload.review_authority = {
      kind: "runtime-admission",
      ...deriveRuntimeAdmissionAuthorityRefs({ repoRoot, payload: reviewerPayload, recordId: admissionRecordId, fsOps }),
    };
  } else if (reviewerPayload.reviewer_identity?.executor_kind === "tl-direct") {
    if (admissionRecordId !== null) fail("receipt-identity-authority-mismatch");
    reviewerPayload.review_authority = { kind: "tl-direct-review" };
  } else {
    fail("receipt-identity-authority-mismatch");
  }
  reviewerPayload.output_evidence = {
    raw_payload_ref: structuredClone(rawPayloadRef),
    raw_payload_sha256: rawPayloadRef.digest_sha256,
    verdict_open_set_sha256: sha256Hex(canonicalJsonV1({
      verdict: reviewerPayload.verdict,
      open_finding_ids: reviewerPayload.scope?.open_finding_ids,
    })),
  };
  if (verifiedPostHoc !== null) {
    try {
      assertPostHocReceiptBinding(reviewerPayload, attestationRef, verifiedPostHoc);
    } catch {
      fail("attestation-binding-mismatch");
    }
  }
  const sealRequest = {
    repoRoot,
    changeId,
    reviewerPayload,
    ...(admissionRecordId === null ? {} : { admissionRecordId }),
    ...(attestationRef === null ? {} : { attestationRef: structuredClone(attestationRef) }),
  };
  // D15: the seal CLI reads this request up to RECEIPT_SCAN_MAX_BYTES, so a
  // larger one would be a builder success that the sealer can never read.
  if (Buffer.byteLength(`${canonicalJsonV1(sealRequest)}\n`, "utf8") > RECEIPT_SCAN_MAX_BYTES) {
    fail("receipt-size-exceeded");
  }
  prepareReviewRoundReceiptPreclaim({ ...sealRequest, fsOps, gitOps });
  return sealRequest;
}

function prepareReviewRoundReceiptPreclaim({
  repoRoot,
  changeId,
  reviewerPayload: callerPayload,
  admissionRecordId = null,
  attestationRef = null,
  bindingRoot = null,
  fsOps,
  gitOps,
}) {
  assertChangeId(changeId);
  const consumerBinding = resolveConsumerBinding({ repoRoot, changeId, bindingRoot, propagateNativeFaults: true });
  repoRoot = consumerBinding.repoRoot;
  changeId = consumerBinding.changeId;
  const binding = bindProducerReviewAuthority({ repoRoot, changeId, reviewerPayload: callerPayload, admissionRecordId, attestationRef });
  const reviewerPayload = binding.reviewerPayload;
  // D8.1: every new `executor_kind: runtime-agent` review／verify seal MUST
  // carry `execution_root_head` — the admission record has no binding-path
  // discriminator, so the requirement is not conditioned on a declared path.
  // Historical payloads that predate the conditional key stay readable because
  // this check lives on the producer side only.
  if (reviewerPayload.reviewer_identity.executor_kind === "runtime-agent"
    && !Object.hasOwn(reviewerPayload, "execution_root_head")) {
    fail("receipt-authority-changed");
  }
  // Stamp behavior-risk-v1 only when the bound digest already matches that alg
  // at the receipt HEAD. Blind stamping would rewrite historical full-prose
  // digests (post-hoc golden receipts) into a false v1 claim.
  if (
    typeof reviewerPayload.scope?.risk_shape_digest_sha256 === "string"
    && reviewerPayload.scope.risk_shape_digest_sha256.length > 0
    && (reviewerPayload.scope.risk_shape_digest_alg === undefined
      || reviewerPayload.scope.risk_shape_digest_alg === null
      || reviewerPayload.scope.risk_shape_digest_alg === "")
  ) {
    const v1Digest = deriveHistoricalRiskShapeDigest({
      repoRoot,
      changeId,
      candidateHead: reviewerPayload.lineage.head_sha,
      gitOps,
      digestAlg: RISK_SHAPE_DIGEST_ALG_V1,
    });
    if (reviewerPayload.scope.risk_shape_digest_sha256 === v1Digest) {
      reviewerPayload.scope.risk_shape_digest_alg = RISK_SHAPE_DIGEST_ALG_V1;
    }
  }
  validateReviewerPayload(reviewerPayload, { repoRoot, gitOps, claimRequired: false, fsOps });
  // D15: every receipt reader loads at most RECEIPT_SCAN_MAX_BYTES. Refuse a
  // receipt that would exceed it here, before any claim or write, rather than
  // publish one that breaks the chain for every later reader.
  if (receiptRecordBytes(reviewerPayload).length > RECEIPT_SCAN_MAX_BYTES) fail("receipt-size-exceeded");
  if (reviewerPayload.reviewer_identity.executor_kind === "runtime-agent") {
    const prior = readAdmissionRecordClaim({
      repoRoot,
      changeId,
      recordId: reviewerPayload.review_authority.admission_ref.record_id,
      propagateNativeFaults: true,
    });
    if (!prior.ok || prior.claim !== null) fail("admission-record-consumed");
  }
  if (binding.postHoc !== null && assertPostHocAttestationClaim({
    repoRoot,
    changeId,
    verified: binding.postHoc,
    payload: reviewerPayload,
    required: false,
  })) fail("attestation-consumed");
  let authoritySnapshot;
  try {
    authoritySnapshot = receiptAuthoritySnapshot({ repoRoot, changeId, payload: reviewerPayload, fsOps, gitOps });
  } catch (error) { throw error; }
  // Producer-side carry-forward check (design D3): after the predecessor chain has
  // been validated and before any admission claim, post-hoc attestation claim,
  // receipt or marker write. Build and seal share this preclaim.
  if (reviewerPayload.lineage.previous_receipt_ref !== null) {
    const predecessorPayload = readPredecessorReceiptPayload({ repoRoot, payload: reviewerPayload, gitOps, fsOps });
    const missing = predecessorCarryForwardProblem(reviewerPayload, predecessorPayload, {
      postHocAuthority: binding.postHoc !== null && isClosedHistoricalPostHocReceipt(reviewerPayload),
    });
    if (missing !== null) throw omittedCarryForwardFailure(missing);
  }
  return { reviewerPayload, binding, authoritySnapshot, consumerRoot: repoRoot };
}

// D7.4 revalidation: the resolution plus a HEAD revalidation is re-run before
// every irreversible claim (and again before publication via the seal readback
// validator). A resolution that no longer selects the root it selected a
// moment ago — the worktree vanished, the change directory became
// unlocatable — or a HEAD that drifted away from the reviewed head fails
// closed with `receipt-authority-changed` and consumes nothing.
function revalidateConsumerBinding({ root, changeId, expectedHeadSha }) {
  const revalidated = resolveConsumerBinding({ repoRoot: root, changeId, propagateNativeFaults: true });
  if (revalidated.repoRoot !== root) fail("receipt-authority-changed");
  const head = currentHead(root);
  if (head !== expectedHeadSha) fail("receipt-authority-changed");
}

function sealReviewRoundReceipt({ repoRoot, changeId, reviewerPayload: callerPayload, admissionRecordId = null, attestationRef = null, bindingRoot = null, fsOps, gitOps }) {
  const prepared = prepareReviewRoundReceiptPreclaim({
    repoRoot,
    changeId,
    reviewerPayload: callerPayload,
    admissionRecordId,
    attestationRef,
    bindingRoot,
    fsOps,
    gitOps,
  });
  const { binding, reviewerPayload, authoritySnapshot, consumerRoot } = prepared;
  revalidateConsumerBinding({ root: consumerRoot, changeId, expectedHeadSha: reviewerPayload.lineage.head_sha });
  // The prepare seam above resolved the effective root from the caller root
  // plus the declaration (design D7.1). Every irreversible step after it MUST
  // run against that resolved binding root — never the caller root: a direct
  // seal from a non-binding caller root (e.g. a main-checkout session with the
  // `bindingRoot` pin) would otherwise read the record at the wrong root, fail
  // as `admission-record-unreadable`, and remap that fault to the misleading
  // `admission-record-consumed`, while a resolved caller-root copy could be
  // consumed there even though the authority checks bound the worktree.
  // `claimRequired: false`: this pass runs before `claimAdmissionRecord` below,
  // so the claim legitimately does not exist yet. This is one of exactly two
  // deliberate exemptions; the other is `walkReceiptAuthorityChain`'s lineage
  // traversal (D61). Every caller that asserts a receipt's own authority reads
  // back a sealed receipt and MUST find the claim (C-04).
  // Consume the admission record atomically before publication: mkdir admits
  // exactly one winner, so two concurrent seals of different rounds can no
  // longer both pass the receipt scan and both write (cross-model CRITICAL on
  // PR #2473). The claim is irreversible: a failure after the winning mkdir
  // remains consumed; only verification of an already committed result or a
  // fresh normal review may continue the lane.
  const admissionRecordIdFromAuthority = reviewerPayload.review_authority?.admission_ref?.record_id ?? admissionRecordId;
  const claimed = reviewerPayload.reviewer_identity.executor_kind === "runtime-agent"
    ? claimAdmissionRecord({
        repoRoot: consumerRoot,
        changeId,
        recordId: admissionRecordIdFromAuthority,
        claim: admissionClaimTuple(reviewerPayload),
        hooks: fsOps?.admissionClaimHooks,
        propagateNativeFaults: true,
      })
    : null;
  if (claimed !== null && !claimed.ok) {
    fail(claimed.code === "admission-record-already-claimed"
      ? "admission-record-consumed"
      : "receipt-authority-invalid");
  }
  if (binding.postHoc !== null) claimPostHocAttestation({ repoRoot: consumerRoot, changeId, verified: binding.postHoc, payload: reviewerPayload, fsOps });
  return sealClaimedReviewRoundReceipt({ repoRoot: consumerRoot, changeId, reviewerPayload, authoritySnapshot, fsOps, gitOps });
}

function reviewRoundReceiptRecord(reviewerPayload) {
  return {
    schema: REVIEW_RECEIPT_SCHEMA,
    receipt_digest_sha256: sha256Hex(canonicalJsonV1(reviewerPayload)),
    observation_hashes: reviewerPayload.findings.map((entry) => ({
      finding_id: entry.finding_id,
      observation_hash_sha256: observationDigest(entry),
    })),
    reviewer_payload: structuredClone(reviewerPayload),
  };
}

// The exact bytes durableSeal writes for this receipt.
function receiptRecordBytes(reviewerPayload) {
  return Buffer.from(`${canonicalJsonV1(reviewRoundReceiptRecord(reviewerPayload))}\n`, "utf8");
}

function sealClaimedReviewRoundReceipt({ repoRoot, changeId, reviewerPayload, authoritySnapshot, fsOps, gitOps }) {
  const receipt = reviewRoundReceiptRecord(reviewerPayload);
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const targetPath = path.join(notesRoot, receiptFileNameV3(changeId, reviewerPayload.round_number, reviewerPayload.dispatch_id));
  let sealed;
  try {
    sealed = durableSeal({
      repoRoot: notesRoot,
      targetPath,
      record: receipt,
      validateRecord: (record) => {
        try {
          validateReceiptRecord(record, { repoRoot, gitOps, fsOps });
          const readbackSnapshot = receiptAuthoritySnapshot({
            repoRoot,
            changeId,
            payload: record.reviewer_payload,
            fsOps,
            gitOps,
          });
          if (readbackSnapshot !== authoritySnapshot) fail("receipt-authority-changed");
        } catch (error) {
          if (error instanceof CoreFailure) throw error;
          if (error?.[CORE_DOMAIN_PREDICATE]) fail("receipt-authority-changed");
          throw error;
        }
      },
      fsOps,
      collisionOnExisting: true,
    });
  } catch (error) {
    if (error instanceof CoreFailure) throw error;
    if (isDurablePathError(error)) fail("evidence-artifact-invalid", durableFailureReason(error));
    throw error;
  }
  const ref = sealedEvidenceRef(notesRoot, targetPath, sealed);
  const authoritySnapshotSha256 = sha256Hex(canonicalJsonV1(sealed.reviewer_payload.review_authority));
  const marker = {
    schema: RECEIPT_COMMIT_SCHEMA,
    receipt_ref: ref,
    authority_snapshot_sha256: authoritySnapshotSha256,
    committed_at: new Date().toISOString(),
  };
  const markerPath = path.join(notesRoot, receiptCommitFileNameV3(changeId, reviewerPayload.round_number, reviewerPayload.dispatch_id));
  try {
    durableSeal({
      repoRoot: notesRoot,
      targetPath: markerPath,
      record: marker,
      validateRecord: (candidate) => {
        assertExactKeys(candidate, ["schema", "receipt_ref", "authority_snapshot_sha256", "committed_at"], "receipt commit marker");
        if (candidate.schema !== RECEIPT_COMMIT_SCHEMA) fail("receipt-readback-mismatch");
        assertDurableRef(candidate.receipt_ref, "receipt commit marker receipt_ref");
        assertDigest(candidate.authority_snapshot_sha256, "receipt commit marker authority snapshot");
        if (!Number.isFinite(Date.parse(candidate.committed_at))
          || canonicalJsonV1(candidate.receipt_ref) !== canonicalJsonV1(ref)
          || candidate.authority_snapshot_sha256 !== authoritySnapshotSha256) fail("receipt-readback-mismatch");
      },
      fsOps,
      collisionOnExisting: true,
    });
  } catch (error) {
    if (error instanceof CoreFailure) throw error;
    if (isDurablePathError(error)) fail("evidence-artifact-invalid", durableFailureReason(error));
    throw error;
  }
  return { receipt: sealed, ref, commit_ref: sealedEvidenceRef(notesRoot, markerPath, marker) };
}

// requireIndependence: the caller's contract needs independent judgment (see
// devpro:pre-pr Step 3). A v3 normal receipt bound to prepared intent/admission or
// a v3 owner-authorized post-hoc attestation satisfies it; tl-direct and both
// legacy epochs fail closed.
function verifyReviewRoundReceipt({ repoRoot, receiptRef, requireIndependence = false, changeId = null, bindingRoot = null, fsOps, gitOps }) {
  if (typeof requireIndependence !== "boolean") fail("requireIndependence must be a boolean");
  const match = receiptRef?.path?.match(/^review-(.+)-receipt-r([1-9][0-9]*)(?:-([0-9a-f]{64}))?\.json$/u);
  if (!match) fail("receiptRef path is not a canonical receipt target");
  const [, receiptChangeId, roundText, pathDispatchId] = match;
  assertChangeId(receiptChangeId);
  // D7.3: an explicit `changeId` is a second identity declaration and MUST
  // agree with the change id carried by receiptRef; the resolution itself uses
  // the receipt's own change id (optionally pinned with `bindingRoot`).
  if (changeId !== null && changeId !== undefined && changeId !== receiptChangeId) {
    fail("receipt-path-change-mismatch");
  }
  const consumerBinding = resolveConsumerBinding({ repoRoot, changeId: receiptChangeId, bindingRoot, propagateNativeFaults: true });
  repoRoot = consumerBinding.repoRoot;
  const changeIdResolved = consumerBinding.changeId;
  const loaded = readEvidenceRef({
    repoRoot,
    ref: receiptRef,
    label: "receiptRef",
    validateRecord: (record) => withSemanticFailureCode("receipt-evidence-invalid", () =>
      validateReceiptRecord(record, { repoRoot, gitOps, fsOps })),
    gitOps,
    semanticSafetyCode: "evidence-artifact-invalid",
    fsOps,
  });
  if (loaded.record.reviewer_payload.round_number !== Number(roundText)) fail("receiptRef round does not match receipt payload");
  const v3 = loaded.record.schema === REVIEW_RECEIPT_SCHEMA;
  if ((v3 && pathDispatchId !== loaded.record.reviewer_payload.dispatch_id) || (!v3 && pathDispatchId !== undefined)) {
    fail("receipt-path-schema-mismatch");
  }
  withSemanticFailureCode("receipt-authority-invalid", () =>
    receiptAuthoritySnapshot({ repoRoot, changeId: changeIdResolved, payload: loaded.record.reviewer_payload, fsOps, gitOps }));
  const executorAttribution = receiptExecutorAttribution(loaded.record);
  if (executorAttribution === "post-hoc-tl-attested-runtime-review" && requireIndependence !== true) {
    fail("receipt-identity-authority-mismatch");
  }
  if (v3) {
    validateCommittedReceiptMarker({ repoRoot, changeId: changeIdResolved, receiptRef, receipt: loaded.record, gitOps, fsOps });
  }
  // Fail-token decision (design Open Q2 / seams no-ticket-ordinary-all-hosts-v3):
  // closed code `ordinary-review-not-independent` alone (CLI public codes are
  // entirely lowercase letters/digits/hyphens; a colon message becomes
  // unexpected-io-fault). Legacy receipts (!v3) cannot satisfy independence—
  // same closed code as ordinary non-sealable. Callers classify without
  // discarding findings. Forbidden: a third path that lets requireIndependence
  // pass without real admission.
  if (requireIndependence && !v3) fail("ordinary-review-not-independent");
  if (requireIndependence && !["runtime-agent", "post-hoc-tl-attested-runtime-review"].includes(executorAttribution)) {
    fail("ordinary-review-not-independent");
  }
  return { receipt: loaded.record, executor_attribution: executorAttribution };
}

function validateManifestShape(manifest, { requireDigest }) {
  const keys = [
    "schema",
    "purpose",
    "validator",
    "lineage",
    "normalization",
    "hash",
    "inputs",
    "coverage",
    "dependency_edges",
    "exceptions",
    "errors",
    "result",
  ];
  if (requireDigest) keys.push("manifest_digest_sha256");
  assertExactKeys(manifest, keys, "review manifest");
  if (manifest.schema !== REVIEW_MANIFEST_SCHEMA) fail("unknown review manifest schema");
  if (!MANIFEST_PURPOSES.has(manifest.purpose)) fail("invalid manifest purpose");
  assertExactKeys(manifest.validator, [
    "id",
    "version",
    "source_path",
    "source_digest_sha256",
    "provenance",
    "independent_evidence",
  ], "manifest.validator");
  assertString(manifest.validator.id, "manifest.validator.id");
  assertString(manifest.validator.version, "manifest.validator.version");
  assertString(manifest.validator.source_path, "manifest.validator.source_path");
  assertDigest(manifest.validator.source_digest_sha256, "validator source digest");
  if (!["pre-existing-trusted", "independently-verified-same-change"].includes(manifest.validator.provenance)) {
    fail("invalid validator provenance");
  }
  if (manifest.validator.independent_evidence !== null) assertObject(manifest.validator.independent_evidence, "validator independent evidence");
  assertExactKeys(manifest.lineage, ["change_base_sha", "surface_base_sha", "candidate_head_sha"], "manifest.lineage");
  assertSha(manifest.lineage.change_base_sha, "manifest.lineage.change_base_sha");
  assertSha(manifest.lineage.surface_base_sha, "manifest.lineage.surface_base_sha");
  assertSha(manifest.lineage.candidate_head_sha, "manifest.lineage.candidate_head_sha");
  assertExactKeys(manifest.normalization, ["id", "version", "rules_digest_sha256"], "manifest.normalization");
  assertString(manifest.normalization.id, "normalization.id");
  assertString(manifest.normalization.version, "normalization.version");
  assertDigest(manifest.normalization.rules_digest_sha256, "normalization rules digest");
  assertExactKeys(manifest.hash, ["algorithm", "canonicalization"], "manifest.hash");
  if (manifest.hash.algorithm !== "sha256" || manifest.hash.canonicalization !== "canonical-json-v1") {
    fail("unsupported manifest hash contract");
  }
  assertExactKeys(manifest.inputs, ["count", "root_digest_sha256", "entries"], "manifest.inputs");
  assertSafeInteger(manifest.inputs.count, "manifest.inputs.count");
  assertDigest(manifest.inputs.root_digest_sha256, "manifest input root digest");
  if (!Array.isArray(manifest.inputs.entries)) fail("manifest.inputs.entries must be an array");
  const inputIds = new Set();
  const inputPaths = new Set();
  for (const [index, entry] of manifest.inputs.entries.entries()) {
    assertExactKeys(entry, ["id", "path", "digest_sha256"], `manifest.inputs.entries[${index}]`);
    assertString(entry.id, `manifest.inputs.entries[${index}].id`);
    assertString(entry.path, `manifest.inputs.entries[${index}].path`);
    assertDigest(entry.digest_sha256, `manifest.inputs.entries[${index}].digest_sha256`);
    if (inputIds.has(entry.id)) fail("duplicate manifest input id");
    if (inputPaths.has(entry.path)) fail("duplicate manifest input path");
    inputIds.add(entry.id);
    inputPaths.add(entry.path);
  }
  if (manifest.inputs.count !== manifest.inputs.entries.length) fail("manifest input count mismatch");
  if (manifest.inputs.root_digest_sha256 !== sha256Hex(canonicalJsonV1(manifest.inputs.entries))) {
    fail("manifest input path/hash root digest mismatch");
  }
  assertExactKeys(manifest.coverage, [
    "expected_count",
    "processed_count",
    "complete",
    "unknown_inputs",
    "omitted_inputs",
  ], "manifest.coverage");
  assertSafeInteger(manifest.coverage.expected_count, "coverage.expected_count");
  assertSafeInteger(manifest.coverage.processed_count, "coverage.processed_count");
  if (typeof manifest.coverage.complete !== "boolean") fail("coverage.complete must be boolean");
  assertUniqueStrings(manifest.coverage.unknown_inputs, "coverage.unknown_inputs");
  assertUniqueStrings(manifest.coverage.omitted_inputs, "coverage.omitted_inputs");
  if (!Array.isArray(manifest.dependency_edges)) fail("dependency_edges must be an array");
  for (const [index, edge] of manifest.dependency_edges.entries()) {
    assertExactKeys(edge, ["from", "to", "kind"], `dependency_edges[${index}]`);
    assertString(edge.from, `dependency_edges[${index}].from`);
    assertString(edge.to, `dependency_edges[${index}].to`);
    if (!EDGE_KINDS.has(edge.kind)) fail(`dependency_edges[${index}].kind is invalid`);
    if (!inputIds.has(edge.from) || !inputIds.has(edge.to)) fail("dependency edge endpoints must reference input IDs");
  }
  if (!Array.isArray(manifest.exceptions)) fail("manifest.exceptions must be an array");
  const exceptionIds = new Set();
  for (const [index, exception] of manifest.exceptions.entries()) {
    assertExactKeys(exception, ["id", "detail"], `manifest.exceptions[${index}]`);
    assertString(exception.id, `manifest.exceptions[${index}].id`);
    assertString(exception.detail, `manifest.exceptions[${index}].detail`);
    if (exceptionIds.has(exception.id)) fail("duplicate manifest exception id");
    exceptionIds.add(exception.id);
  }
  assertUniqueStrings(manifest.errors, "manifest.errors");
  if (!MANIFEST_RESULTS.has(manifest.result)) fail("invalid manifest result");
  if (manifest.result === "pass") {
    if (!manifest.coverage.complete
      || manifest.coverage.expected_count !== manifest.coverage.processed_count
      || manifest.coverage.expected_count !== manifest.inputs.count
      || manifest.coverage.unknown_inputs.length > 0
      || manifest.coverage.omitted_inputs.length > 0
      || manifest.exceptions.length > 0
      || manifest.errors.length > 0) {
      fail("pass manifest is incomplete or contains exceptions/errors");
    }
  }
  if (manifest.result === "exceptions" && manifest.exceptions.length === 0) {
    fail("exceptions result requires manifest exceptions");
  }
  if (manifest.validator.provenance === "pre-existing-trusted" && manifest.validator.independent_evidence !== null) {
    fail("pre-existing validator cannot carry independent evidence");
  }
  if (manifest.validator.provenance === "independently-verified-same-change"
    && manifest.validator.independent_evidence === null) {
    fail("same-change validator requires structured independent evidence");
  }
  if (requireDigest) assertDigest(manifest.manifest_digest_sha256, "manifest digest");
}

function manifestWithoutDigest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.manifest_digest_sha256;
  return copy;
}

function validateManifestRecord(manifest) {
  validateManifestShape(manifest, { requireDigest: true });
  if (manifest.manifest_digest_sha256 !== sha256Hex(canonicalJsonV1(manifestWithoutDigest(manifest)))) {
    fail("manifest digest mismatch");
  }
  return manifest;
}

function gitBuffer(repoRoot, args, label) {
  try {
    // Blob callers already materialize a complete Buffer, like readFileSync.
    // Match that platform limit instead of the child-process 1 MiB default;
    // metadata queries retain their existing capture bound.
    const readsBlob = (args.length === 2 && args[0] === "show")
      || (args.length === 3 && args[0] === "cat-file" && args[1] === "blob");
    return retryOnTransientGitIo(() => execFileSync("git", args, {
      cwd: repoRoot,
      ...(readsBlob ? { maxBuffer: BUFFER_CONSTANTS.MAX_LENGTH } : {}),
    }));
  } catch (error) {
    // A child-process failure is I/O provenance, even when a human-readable
    // label is available to its caller. Semantic Git outcomes are classified
    // only by their owning completed command (for example merge-base status 1).
    throw error;
  }
}

function assertAncestor(repoRoot, ancestor, descendant, label, gitOps) {
  if (!isAncestor(repoRoot, ancestor, descendant, gitOps)) {
    fail(`${label} is not an ancestor of candidate HEAD`);
  }
}

function treeBytes(repoRoot, sha, carrierPath, label, gitOps) {
  const context = gitOperationContext(gitOps);
  const key = context === undefined
    ? null
    : `${operationRepoIdentity(repoRoot)}\0${sha}\0${carrierPath}`;
  if (key !== null && context.treeFileBytes.has(key)) {
    return Buffer.from(context.treeFileBytes.get(key));
  }
  const bytes = gitBuffer(repoRoot, ["show", `${sha}:${carrierPath}`], `${label} is absent from Git candidate tree`);
  if (key !== null) context.treeFileBytes.set(key, Buffer.from(bytes));
  return bytes;
}

// A path under `text eol=crlf`, `core.autocrlf` or any clean filter is checked out with bytes
// that differ from its Git blob even though `git status` is clean (#2914). `git hash-object
// --path` runs the same conversions `git add` would, so equal object ids mean the worktree
// file stages as exactly the candidate blob. Paths with no conversion hash their raw bytes,
// so for them this is the same byte-exact comparison.
function worktreeFileStagesAsCandidateBlob(repoRoot, candidateSha, carrierPath, absolutePath) {
  const staged = gitBuffer(
    repoRoot,
    ["hash-object", `--path=${carrierPath}`, "--", absolutePath],
    "cannot hash relevant manifest path under its Git conversions",
  ).toString("utf8").trim();
  const blob = gitBuffer(
    repoRoot,
    ["rev-parse", "--verify", `${candidateSha}:${carrierPath}`],
    "candidate carrier is absent from Git candidate tree",
  ).toString("utf8").trim();
  return staged !== "" && staged === blob;
}

function manifestAssertion(manifest) {
  const assertion = manifestWithoutDigest(manifest);
  delete assertion.validator.independent_evidence;
  return assertion;
}

function assertCanonicalOracleModulePath(repoRoot, candidatePath, label) {
  const canonicalPath = assertSafeRepoRelativePath({ repoRoot, candidatePath });
  if (canonicalPath !== candidatePath || !/\.(?:mjs|js)$/.test(canonicalPath)) {
    fail(`${label} must be a canonical repo-relative ESM path`);
  }
  return canonicalPath;
}

function oracleModuleSpecifiers(source, modulePath) {
  if (Buffer.from(source, "utf8").toString("utf8") !== source) fail(`oracle module is not valid UTF-8: ${modulePath}`);
  if (/\bimport\s*\(/.test(source)) fail(`dynamic oracle import is forbidden: ${modulePath}`);
  if (/\brequire\s*\(|\bimport\.meta\b|\b(?:process|globalThis|fetch|XMLHttpRequest|WebSocket|__dirname|__filename)\b/.test(source)) {
    fail(`oracle module uses a forbidden runtime resource: ${modulePath}`);
  }
  const specifiers = [];
  const pattern = /(?:^|[;\n])\s*(?:import\s+(?:[^"'()]*?\s+from\s+)?|export\s+[^"'()]*?\s+from\s+)(["'])([^"']+)\1/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) specifiers.push(match[2]);
  return specifiers;
}

function resolveOracleModulePath(repoRoot, importerPath, specifier) {
  if (ORACLE_BUILTINS.has(specifier)) return { builtin: specifier };
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    fail(`oracle module specifier is not in the closed allowlist: ${specifier}`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
  if (resolved.startsWith("../") || resolved === ".." || path.posix.isAbsolute(resolved)) {
    fail(`oracle module import escapes the repository: ${specifier}`);
  }
  return { path: assertCanonicalOracleModulePath(repoRoot, resolved, "oracle dependency") };
}

function buildOracleModuleGraph(repoRoot, baseSha, candidateSha, rootPath, gitOps) {
  const sources = new Map();
  const visit = (modulePath) => {
    if (sources.has(modulePath)) return;
    const baseBytes = treeBytes(repoRoot, baseSha, modulePath, "oracle module", gitOps);
    const candidateBytes = treeBytes(repoRoot, candidateSha, modulePath, "oracle module", gitOps);
    if (!baseBytes.equals(candidateBytes)) fail(`oracle module must be pre-existing and unchanged: ${modulePath}`);
    const source = candidateBytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(candidateBytes)) fail(`oracle module is not valid UTF-8: ${modulePath}`);
    sources.set(modulePath, candidateBytes);
    for (const specifier of oracleModuleSpecifiers(source, modulePath)) {
      const resolved = resolveOracleModulePath(repoRoot, modulePath, specifier);
      if (resolved.path !== undefined) visit(resolved.path);
    }
  };
  visit(rootPath);
  const entries = [...sources.entries()]
    .map(([modulePath, bytes]) => ({ path: modulePath, digest_sha256: sha256Hex(bytes) }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  return {
    entries,
    rootDigest: sha256Hex(canonicalJsonV1(entries)),
    modules: entries.map(({ path: modulePath }) => ({
      path: modulePath,
      source_base64: sources.get(modulePath).toString("base64"),
    })),
    sources,
  };
}

function oracleWorktreeSnapshot(repoRoot, graph) {
  const paths = graph.entries.map((entry) => entry.path);
  const status = gitBuffer(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths], "cannot determine oracle worktree status");
  if (status.length > 0) fail("oracle worktree module graph is dirty or changed");
  const root = realpathSync(repoRoot);
  return canonicalJsonV1(paths.map((modulePath) => {
    const absolutePath = path.join(root, ...modulePath.split("/"));
    const metadata = lstatSync(absolutePath, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail("oracle worktree carrier must be a regular non-symlink file");
    if (!readFileSync(absolutePath).equals(graph.sources.get(modulePath))) {
      fail("oracle worktree bytes differ from trusted candidate module graph");
    }
    return {
      path: modulePath,
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      mode: String(metadata.mode),
      size: String(metadata.size),
      mtime_ns: String(metadata.mtimeNs),
      ctime_ns: String(metadata.ctimeNs),
    };
  }));
}

function validateIndependentEvidence(manifest, { repoRoot, verificationMode, spawnSyncImpl = spawnSync, gitOps }) {
  const evidence = manifest.validator.independent_evidence;
  assertExactKeys(evidence, ["schema", "oracle", "subject", "lineage", "result", "evidence_digest_sha256"], "validator independent evidence");
  if (evidence.schema !== "devpro.review-remediation.validator-evidence/v1") fail("unknown validator evidence schema");
  assertExactKeys(evidence.oracle, ["id", "version", "source_path", "source_digest_sha256", "module_graph"], "validator evidence oracle");
  assertString(evidence.oracle.id, "oracle id");
  assertString(evidence.oracle.version, "oracle version");
  const oraclePath = assertCanonicalOracleModulePath(repoRoot, evidence.oracle.source_path, "oracle source path");
  assertDigest(evidence.oracle.source_digest_sha256, "oracle source digest");
  assertExactKeys(evidence.oracle.module_graph, ["root_digest_sha256", "entries"], "oracle module graph");
  assertDigest(evidence.oracle.module_graph.root_digest_sha256, "oracle module graph root digest");
  if (!Array.isArray(evidence.oracle.module_graph.entries) || evidence.oracle.module_graph.entries.length === 0) {
    fail("oracle module graph entries must be a non-empty array");
  }
  let previousPath = null;
  for (const [index, entry] of evidence.oracle.module_graph.entries.entries()) {
    assertExactKeys(entry, ["path", "digest_sha256"], `oracle module graph entry ${index}`);
    const modulePath = assertCanonicalOracleModulePath(repoRoot, entry.path, `oracle module graph entry ${index} path`);
    assertDigest(entry.digest_sha256, `oracle module graph entry ${index} digest`);
    if (previousPath !== null && compareCodePoints(previousPath, modulePath) >= 0) {
      fail("oracle module graph entries must be uniquely code-point sorted");
    }
    previousPath = modulePath;
  }
  assertExactKeys(evidence.subject, ["validator_source_path", "validator_source_digest_sha256", "manifest_assertion_digest_sha256"], "validator evidence subject");
  assertString(evidence.subject.validator_source_path, "oracle subject validator path");
  assertDigest(evidence.subject.validator_source_digest_sha256, "oracle subject validator digest");
  assertDigest(evidence.subject.manifest_assertion_digest_sha256, "oracle subject assertion digest");
  assertExactKeys(evidence.lineage, ["change_base_sha", "candidate_head_sha"], "validator evidence lineage");
  assertSha(evidence.lineage.change_base_sha, "oracle lineage base");
  assertSha(evidence.lineage.candidate_head_sha, "oracle lineage candidate");
  if (evidence.result !== "verified") fail("oracle result is not verified");
  assertDigest(evidence.evidence_digest_sha256, "oracle evidence digest");
  const withoutDigest = structuredClone(evidence);
  delete withoutDigest.evidence_digest_sha256;
  if (sha256Hex(canonicalJsonV1(withoutDigest)) !== evidence.evidence_digest_sha256) fail("oracle evidence digest mismatch");
  if (oraclePath === manifest.validator.source_path) fail("oracle cannot be the validator itself");
  if (/(^|\/)(?:tests?|docs?)(\/|$)/i.test(oraclePath) || !/\.(?:mjs|js|cjs)$/.test(oraclePath)) {
    fail("oracle must be a production executable, not tests or prose");
  }
  const graph = buildOracleModuleGraph(
    repoRoot,
    manifest.lineage.change_base_sha,
    manifest.lineage.candidate_head_sha,
    oraclePath,
    gitOps,
  );
  if (canonicalJsonV1(graph.entries) !== canonicalJsonV1(evidence.oracle.module_graph.entries)
    || graph.rootDigest !== evidence.oracle.module_graph.root_digest_sha256) {
    fail("oracle module graph digest or entries mismatch");
  }
  const rootEntry = graph.entries.find((entry) => entry.path === oraclePath);
  if (rootEntry?.digest_sha256 !== evidence.oracle.source_digest_sha256) fail("oracle source digest mismatch");
  const mode = git(repoRoot, ["ls-tree", manifest.lineage.change_base_sha, "--", oraclePath]).trim().split(/\s+/)[0];
  if (mode !== "100755") fail("oracle must be executable in the change base");
  const assertion = manifestAssertion(manifest);
  const assertionDigest = sha256Hex(canonicalJsonV1(assertion));
  if (evidence.subject.validator_source_path !== manifest.validator.source_path
    || evidence.subject.validator_source_digest_sha256 !== manifest.validator.source_digest_sha256
    || evidence.subject.manifest_assertion_digest_sha256 !== assertionDigest
    || evidence.lineage.change_base_sha !== manifest.lineage.change_base_sha
    || evidence.lineage.candidate_head_sha !== manifest.lineage.candidate_head_sha) {
    fail("oracle subject or lineage mismatch");
  }
  if (verificationMode === "historical") return;
  if (verificationMode !== "current") fail("unknown oracle verification mode");
  const preSnapshot = oracleWorktreeSnapshot(repoRoot, graph);
  const transport = {
    modules: graph.modules,
    root_path: oraclePath,
    request: { manifest_assertion: assertion, oracle: evidence.oracle },
  };
  const result = spawnSyncImpl(process.execPath, [
    "--no-warnings",
    "--experimental-vm-modules",
    "--input-type=module",
    "--eval",
    ORACLE_BOOTSTRAP,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    input: `${canonicalJsonV1(transport)}\n`,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const postSnapshot = oracleWorktreeSnapshot(repoRoot, graph);
  if (postSnapshot !== preSnapshot) fail("oracle worktree module graph changed during verification");
  if (result?.status !== 0 || result?.signal) {
    const detail = String(result?.stderr ?? "").trim();
    fail(`oracle exited with nonzero status${detail === "" ? "" : `: ${detail}`}`);
  }
  if (String(result.stderr ?? "") !== "") fail("oracle emitted stderr");
  let observed;
  try {
    observed = parseCanonicalJsonV1(Buffer.from(String(result.stdout ?? ""), "utf8"));
  } catch (error) {
    fail(`oracle output is not canonical JSON: ${error.message}`);
  }
  if (canonicalJsonV1(observed) !== canonicalJsonV1(evidence)) fail("oracle output does not agree with sealed evidence");
}

function validateManifestFilesAndTrust(manifest, {
  repoRoot,
  verificationMode = "historical",
  spawnSyncImpl = spawnSync,
  gitOps,
}) {
  const { change_base_sha: changeBaseSha, surface_base_sha: surfaceBaseSha, candidate_head_sha: candidateHeadSha } = manifest.lineage;
  assertAncestor(repoRoot, changeBaseSha, candidateHeadSha, "manifest change base", gitOps);
  if (!isAncestor(repoRoot, surfaceBaseSha, candidateHeadSha, gitOps)
    && equivalentForwardReanchorBase(repoRoot, surfaceBaseSha, candidateHeadSha, changeBaseSha, gitOps) === null) {
    fail("manifest surface base is not an ancestor of candidate HEAD");
  }
  const sourcePath = assertSafeRepoRelativePath({ repoRoot, candidatePath: manifest.validator.source_path });
  const sourceBytes = treeBytes(repoRoot, candidateHeadSha, sourcePath, "validator source", gitOps);
  if (sha256Hex(sourceBytes) !== manifest.validator.source_digest_sha256) {
    fail("validator source digest mismatch");
  }
  for (const entry of manifest.inputs.entries) {
    const inputPath = assertSafeRepoRelativePath({ repoRoot, candidatePath: entry.path });
    const inputBytes = treeBytes(repoRoot, candidateHeadSha, inputPath, `manifest input ${entry.id}`, gitOps);
    if (sha256Hex(inputBytes) !== entry.digest_sha256) fail(`manifest input digest mismatch: ${entry.id}`);
  }
  for (const candidatePath of [
    ...manifest.coverage.unknown_inputs,
    ...manifest.coverage.omitted_inputs,
  ]) {
    assertSafeRepoRelativePath({ repoRoot, candidatePath });
  }
  const inputPaths = manifest.inputs.entries.map((entry) => entry.path);
  const relevantPaths = [sourcePath, ...inputPaths];
  if (verificationMode === "current") {
    if (currentHead(repoRoot) !== candidateHeadSha) fail("manifest candidate HEAD is stale for current verification");
    const status = gitBuffer(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...relevantPaths], "cannot determine relevant manifest path status");
    if (status.length > 0) fail("relevant manifest paths are dirty or untracked");
    for (const carrierPath of relevantPaths) {
      const absolutePath = path.join(realpathSync(repoRoot), ...carrierPath.split("/"));
      const currentBytes = readFileSync(absolutePath);
      if (
        !currentBytes.equals(treeBytes(repoRoot, candidateHeadSha, carrierPath, "candidate carrier", gitOps))
        && !worktreeFileStagesAsCandidateBlob(repoRoot, candidateHeadSha, carrierPath, absolutePath)
      ) {
        fail(`relevant manifest path bytes diverge from candidate: ${carrierPath}`);
      }
    }
  } else if (verificationMode !== "historical") {
    fail("unknown manifest verification mode");
  }
  const changed = gitBuffer(repoRoot, ["diff", "--name-only", "-z", changeBaseSha, candidateHeadSha, "--", sourcePath], "cannot determine validator change status").length > 0
    || (VALIDATOR_TRUST_SURFACE_ROOTS.includes(sourcePath)
      && validatorTrustSurfaceTouched(repoRoot, changeBaseSha, candidateHeadSha));
  if (changed && manifest.validator.provenance === "pre-existing-trusted") {
    fail("changed validator cannot claim pre-existing-trusted provenance");
  }
  if (manifest.validator.provenance === "independently-verified-same-change") {
    validateIndependentEvidence(manifest, { repoRoot, verificationMode, spawnSyncImpl, gitOps });
  }
}

// F-d1-01 / tasks 4.1: seal-manifest surface_base_sha equality uses the same
// predecessor resolution as classify-bounded eligibility — prefer explicit
// `previousReceiptRef` when present; else `latestReceipt` (classifier canonical
// latest-receipt-for-change). Do not invent a second "latest" heuristic.
function resolvePredecessorReceiptForSurfaceEquality({
  repoRoot,
  changeId,
  previousReceiptRef,
  gitOps,
}) {
  if (previousReceiptRef !== undefined && previousReceiptRef !== null) {
    return readEvidenceRef({
      repoRoot,
      ref: previousReceiptRef,
      label: "previousReceiptRef",
      validateRecord: (record) => validateReceiptRecord(record, { repoRoot, gitOps }),
      gitOps,
    }).record;
  }
  // Absent predecessor (first seal / round-1 convention) skips equality; an
  // unreadable existing candidate still fails closed via latestReceipt.
  if (listReceiptCandidates({ repoRoot, changeId, gitOps }).candidates.length === 0) {
    return null;
  }
  return latestReceipt({ repoRoot, changeId, gitOps }).receipt;
}

function assertManifestSurfaceMatchesPredecessor({
  repoRoot,
  changeId,
  manifest,
  previousReceiptRef,
  gitOps,
}) {
  const predecessor = resolvePredecessorReceiptForSurfaceEquality({
    repoRoot,
    changeId,
    previousReceiptRef,
    gitOps,
  });
  if (predecessor === null) return;
  const expectedHead = predecessor.reviewer_payload.lineage.head_sha;
  if (manifest.lineage.surface_base_sha !== expectedHead) {
    // Distinct from assertAncestor's "manifest surface base is not an ancestor…"
    fail(
      "manifest surface_base_sha must equal predecessor receipt lineage.head_sha"
      + ` (resolvePredecessorReceiptForSurfaceEquality; expected ${expectedHead})`,
    );
  }
}

function sealReviewManifest({
  repoRoot,
  changeId,
  roundNumber,
  manifest,
  previousReceiptRef,
  fsOps,
  spawnSyncImpl,
  gitOps,
}) {
  assertChangeId(changeId);
  // Design D7.2: resolve the binding root once at this entry (best-effort —
  // this surface keeps its historical caller-root behavior when no worktree
  // resolves) and pass the effective root to every inner lookup.
  ({ repoRoot, changeId } = resolveConsumerBindingOrCaller({ repoRoot, changeId }));
  // strengthen-manifest-seal-ordering R1/D1: refuse before any predecessor or
  // file verification, and before the durable write, when the binding root
  // has any uncommitted change (a commit made after sealing would move HEAD
  // and leave this same-round manifest stale with no legal re-seal path).
  // This precondition is seal-manifest's own — it is deliberately not folded
  // into `validateManifestFilesAndTrust`'s `current` mode, which
  // `classify-bounded` and receipt sealing also share and which keeps its
  // narrower relevant-paths-only scope.
  assertWholeTreeClean(repoRoot, SEAL_MANIFEST_REQUIRES_COMMITTED_WORKTREE_MESSAGE);
  assertSafeInteger(roundNumber, "roundNumber");
  if (roundNumber < 1) fail("roundNumber must be positive");
  validateManifestShape(manifest, { requireDigest: false });
  // Produce-side equality before durable write (D3): reject white-seal of a
  // surface_base_sha that classify eligibility would refuse.
  assertManifestSurfaceMatchesPredecessor({
    repoRoot,
    changeId,
    manifest,
    previousReceiptRef,
    gitOps,
  });
  validateManifestFilesAndTrust(manifest, {
    repoRoot,
    verificationMode: "current",
    spawnSyncImpl,
    gitOps,
  });
  const sealedManifest = {
    ...structuredClone(manifest),
    manifest_digest_sha256: sha256Hex(canonicalJsonV1(manifest)),
  };
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const targetPath = path.join(notesRoot, manifestFileName(changeId, manifest.purpose, roundNumber));
  const sealed = durableSeal({
    repoRoot: notesRoot,
    targetPath,
    record: sealedManifest,
    validateRecord: (record) => {
      validateManifestRecord(record);
      assertManifestSurfaceMatchesPredecessor({
        repoRoot,
        changeId,
        manifest: record,
        previousReceiptRef,
        gitOps,
      });
      validateManifestFilesAndTrust(record, {
        repoRoot,
        verificationMode: "current",
        spawnSyncImpl,
        gitOps,
      });
    },
    fsOps,
  });
  return { manifest: sealed, ref: sealedEvidenceRef(notesRoot, targetPath, sealed) };
}

// A native errno fault keeps its `.code` (a D30 CLI maps it to
// `unexpected-io-fault`) but not its native message, which carries the syscall
// and an absolute path: only the label and the code are named. Anything that is
// not a native errno fault passes through untouched.
function namedNativeFault(error, label) {
  if (error instanceof CoreFailure || !/^E[A-Z0-9]+$/.test(error?.code ?? "")) return error;
  const unreadable = new Error(`${label} is unreadable or unsafe: ${error.code}`);
  unreadable.code = error.code;
  return unreadable;
}

function verifyReviewManifest({
  repoRoot,
  manifestRef,
  verificationMode = "historical",
  spawnSyncImpl = spawnSync,
  gitOps,
}) {
  try {
    const manifest = readEvidenceRef({
      repoRoot,
      ref: manifestRef,
      label: "manifestRef",
      validateRecord: validateManifestRecord,
      gitOps,
    }).record;
    validateManifestFilesAndTrust(manifest, { repoRoot, verificationMode, spawnSyncImpl, gitOps });
    return { manifest };
  } catch (error) {
    throw namedNativeFault(error, "manifest");
  }
}

function validateFinalCarrierManifest(manifest) {
  assertExactKeys(manifest, ["merge_base_sha", "head_sha", "entries", "digest_sha256"], "final carrier manifest");
  assertSha(manifest.merge_base_sha, "final carrier merge base");
  assertSha(manifest.head_sha, "final carrier HEAD");
  if (!Array.isArray(manifest.entries)) fail("final carrier entries must be an array");
  for (const [index, entry] of manifest.entries.entries()) {
    assertExactKeys(entry, ["path", "status", "old_mode", "new_mode", "old_object_id", "new_object_id"], `final carrier entry ${index}`);
    assertString(entry.path, `final carrier entry ${index} path`);
    assertString(entry.status, `final carrier entry ${index} status`);
    if (!/^\d{6}$/.test(entry.old_mode) || !/^\d{6}$/.test(entry.new_mode)) fail("invalid final carrier Git mode");
    assertSha(entry.old_object_id, "final carrier old object");
    assertSha(entry.new_object_id, "final carrier new object");
  }
  assertDigest(manifest.digest_sha256, "final carrier manifest digest");
  const withoutDigest = structuredClone(manifest);
  delete withoutDigest.digest_sha256;
  if (sha256Hex(canonicalJsonV1(withoutDigest)) !== manifest.digest_sha256) fail("final carrier manifest digest mismatch");
}

function finalCarrierManifest(repoRoot, mergeBaseSha, headSha) {
  const raw = gitBuffer(repoRoot, ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", mergeBaseSha, headSha], "cannot derive final carrier manifest");
  const fields = raw.toString("utf8").split("\0");
  if (fields.at(-1) !== "") fail("malformed Git raw final carrier manifest");
  fields.pop();
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    const metadata = fields[index];
    const carrierPath = fields[index + 1];
    const match = metadata?.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z][0-9]*)$/);
    if (!match || carrierPath === undefined) fail("malformed Git raw final carrier entry");
    entries.push({ path: carrierPath, status: match[5], old_mode: match[1], new_mode: match[2], old_object_id: match[3], new_object_id: match[4] });
  }
  const carrier = { merge_base_sha: mergeBaseSha, head_sha: headSha, entries };
  return { ...carrier, digest_sha256: sha256Hex(canonicalJsonV1(carrier)) };
}

// The receipt-filename shape has exactly one reader. `latestReceipt` turns an
// empty result into a failure; `queryReviewStallState` has to tell "no receipt
// was ever sealed" apart from "a receipt exists but could not be read"
// (D20), so it needs to see the empty list rather than the failure. Both go
// through here, because a second copy of this pattern is precisely the
// scattered-duplicate defect AGENTS.md §0 point 10 is about: a change to the
// receipt naming would then have to be found twice.
function isReceiptDirectoryEnumerateIoFailure(error) {
  return error?.code === "EACCES" || error?.code === "EIO";
}

function listReceiptCandidates({ repoRoot, changeId, gitOps, fsOps, propagateNativeFaults = false }) {
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const ops = riskFsOps(fsOps);
  let names;
  try {
    names = ops.readdirSync(notesRoot);
  } catch (error) {
    // Preserve EACCES/EIO so queryReviewStallState can map them to unavailable
    // instead of collapsing every listing failure into not-applicable.
    if (isReceiptDirectoryEnumerateIoFailure(error)) {
      const wrapped = new Error("receipt-scan-failed");
      wrapped.code = error.code;
      throw wrapped;
    }
    fail("receipt-scan-failed");
  }
  const matching = names
    .map((name) => parseReceiptCandidateName(changeId, name))
    .filter((candidate) => candidate !== null);
  if (matching.length > RECEIPT_CANDIDATE_LIMIT) fail("receipt-candidate-limit-exceeded");
  const nameSet = new Set(names);
  const candidates = [];
  const orphans = [];
  for (const candidate of matching) {
    if (candidate.markerName === null) {
      candidates.push(candidate);
    } else if (nameSet.has(candidate.markerName)
      && hasValidReceiptCommitMarkerCandidate({ repoRoot, changeId, notesRoot, candidate, gitOps, fsOps, propagateNativeFaults })) {
      candidates.push(candidate);
    } else {
      orphans.push(candidate);
    }
  }
  candidates.sort((left, right) => right.round - left.round);
  return { notesRoot, candidates, orphans };
}

function latestReceipt({ repoRoot, changeId, gitOps }) {
  const { notesRoot, candidates, orphans } = listReceiptCandidates({ repoRoot, changeId, gitOps });
  if (candidates.length === 0) fail(orphans.length > 0 ? "receipt-not-committed" : "latest terminal receipt is absent");
  if (candidates.length > 1 && candidates[0].round === candidates[1].round) fail("receipt-ambiguous");
  const candidate = candidates[0];
  const targetPath = path.join(notesRoot, candidate.name);
  let loaded;
  try {
    loaded = readEvidencePath({
      repoRoot,
      targetPath,
      label: "latest receipt",
      validateRecord: (record) => validateReceiptRecord(record, { repoRoot, gitOps }),
      gitOps,
      maxBytes: RECEIPT_SCAN_MAX_BYTES,
    });
  } catch (error) {
    fail(`latest receipt is invalid or changed: ${error.message}`);
  }
  const receipt = loaded.record;
  const ref = loaded.ref;
  validateCommittedReceiptMarker({ repoRoot, changeId, receiptRef: ref, receipt, gitOps });
  validateReceiptTemporal({ repoRoot, changeId, payload: receipt.reviewer_payload, gitOps });
  if (receipt.reviewer_payload.round_number !== candidate.round) fail("latest receipt round mismatch");
  return { receipt, ref };
}

function assertBoundedClosureText(value, label, {
  singleLine = false,
  maxBytes = CROSS_CARRIER_MAX_TEXT_BYTES,
} = {}) {
  assertString(value, label);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  if (singleLine && /[\r\n]/u.test(value)) fail(`${label} must be single-line fixed text`);
}

function assertCanonicalStringOrder(values, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodePoints(values[index - 1], values[index]) >= 0) {
      fail(`${label} must be unique and sorted by Unicode code point`);
    }
  }
}

function compareCrossCarrierMatches(left, right) {
  return compareCodePoints(left.literal, right.literal) || compareCodePoints(left.path, right.path);
}

function validateCrossCarrierSearchLiterals(finding, label) {
  if (finding.search_literals.length === 0
    || finding.search_literals.length > CROSS_CARRIER_MAX_LITERALS_PER_FINDING) {
    fail(`${label}.search_literals must contain 1..${CROSS_CARRIER_MAX_LITERALS_PER_FINDING} entries`);
  }
  const literalSet = assertUniqueStrings(finding.search_literals, `${label}.search_literals`);
  assertCanonicalStringOrder(finding.search_literals, `${label}.search_literals`);
  for (const [literalIndex, literal] of finding.search_literals.entries()) {
    assertBoundedClosureText(literal, `${label}.search_literals[${literalIndex}]`, {
      singleLine: true,
      maxBytes: CROSS_CARRIER_MAX_LITERAL_BYTES,
    });
  }
  return literalSet;
}

function validateCrossCarrierMatches({ repoRoot, finding, literalSet, label }) {
  const matchKeys = new Set();
  for (const [matchIndex, match] of finding.matches.entries()) {
    const matchLabel = `${label}.matches[${matchIndex}]`;
    assertExactKeys(match, ["path", "literal", "occurrence_count", "disposition"], matchLabel);
    assertBoundedClosureText(match.path, `${matchLabel}.path`, { singleLine: true });
    const canonicalPath = assertSafeRepoRelativePath({ repoRoot, candidatePath: match.path });
    if (canonicalPath !== match.path) fail(`${matchLabel}.path must be canonical`);
    assertString(match.literal, `${matchLabel}.literal`);
    if (!literalSet.has(match.literal)) fail(`${matchLabel}.literal is not declared by this finding`);
    assertSafeInteger(match.occurrence_count, `${matchLabel}.occurrence_count`);
    if (match.occurrence_count < 1) fail(`${matchLabel}.occurrence_count must be positive`);
    if (!CROSS_CARRIER_MATCH_DISPOSITIONS.has(match.disposition)) fail(`${matchLabel}.disposition is invalid`);
    const key = `${match.literal}\0${match.path}`;
    if (matchKeys.has(key)) fail(`${label}.matches contains a duplicate path/literal row`);
    matchKeys.add(key);
    if (matchIndex > 0 && compareCrossCarrierMatches(finding.matches[matchIndex - 1], match) >= 0) {
      fail(`${label}.matches must be unique and sorted by literal then path`);
    }
  }
}

function validateCrossCarrierClosureFinding({ repoRoot, finding, findingIndex }) {
  const label = `cross-carrier closure findings[${findingIndex}]`;
  assertExactKeys(finding, [
    "finding_id",
    "expected_observation_hash_sha256",
    "classification",
    "rationale",
    "semantic_invariant",
    "search_literals",
    "matches",
  ], label);
  assertBoundedClosureText(finding.finding_id, `${label}.finding_id`, {
    singleLine: true,
    maxBytes: CROSS_CARRIER_MAX_FINDING_ID_BYTES,
  });
  assertDigest(finding.expected_observation_hash_sha256, `${label}.expected_observation_hash_sha256`);
  if (!CROSS_CARRIER_CLASSIFICATIONS.has(finding.classification)) fail(`${label}.classification is invalid`);
  assertBoundedClosureText(finding.rationale, `${label}.rationale`);
  if (!Array.isArray(finding.search_literals) || !Array.isArray(finding.matches)) {
    fail(`${label}.search_literals and matches must be arrays`);
  }
  if (finding.classification === "not-applicable") {
    if (finding.semantic_invariant !== null || finding.search_literals.length !== 0 || finding.matches.length !== 0) {
      fail(`${label}.not-applicable must carry null invariant and empty literal/match sets`);
    }
    return 0;
  }
  assertBoundedClosureText(finding.semantic_invariant, `${label}.semantic_invariant`);
  const literalSet = validateCrossCarrierSearchLiterals(finding, label);
  validateCrossCarrierMatches({ repoRoot, finding, literalSet, label });
  return finding.matches.length;
}

function validateCrossCarrierClosureRecord(record, { repoRoot }) {
  assertExactKeys(record, ["schema", "record_digest_sha256", "payload"], "cross-carrier closure");
  if (record.schema !== CROSS_CARRIER_CLOSURE_SCHEMA) fail("unknown cross-carrier closure schema");
  assertDigest(record.record_digest_sha256, "cross-carrier closure record digest");
  assertExactKeys(record.payload, [
    "change_id", "source_receipt_ref", "source_round_number", "target_round_number",
    "seal_head_sha", "findings", "result",
  ], "cross-carrier closure payload");
  const payload = record.payload;
  assertChangeId(payload.change_id);
  assertDurableRef(payload.source_receipt_ref, "cross-carrier closure source_receipt_ref");
  assertSafeInteger(payload.source_round_number, "cross-carrier closure source_round_number");
  assertSafeInteger(payload.target_round_number, "cross-carrier closure target_round_number");
  if (payload.source_round_number < 1 || payload.target_round_number !== payload.source_round_number + 1) {
    fail("cross-carrier closure target round must immediately follow the source round");
  }
  assertSha(payload.seal_head_sha, "cross-carrier closure seal_head_sha");
  if (payload.result !== "pass") fail("cross-carrier closure result must be pass");
  if (!Array.isArray(payload.findings) || payload.findings.length === 0
    || payload.findings.length > CROSS_CARRIER_MAX_FINDINGS) {
    fail(`cross-carrier closure findings must contain 1..${CROSS_CARRIER_MAX_FINDINGS} entries`);
  }
  const totalMatches = payload.findings.reduce((total, finding, findingIndex) =>
    total + validateCrossCarrierClosureFinding({ repoRoot, finding, findingIndex }), 0);
  if (totalMatches > CROSS_CARRIER_MAX_MATCHES) {
    fail(`cross-carrier closure matches exceed ${CROSS_CARRIER_MAX_MATCHES} entries`);
  }
  assertCanonicalStringOrder(payload.findings.map(({ finding_id: findingId }) => findingId), "cross-carrier closure finding IDs");
  if (record.record_digest_sha256 !== sha256Hex(canonicalJsonV1(payload))) {
    fail("cross-carrier closure payload digest mismatch");
  }
  return record;
}

function refsEqual(left, right) {
  return left.path === right.path && left.digest_sha256 === right.digest_sha256;
}

function validateCrossCarrierClosureSource({ repoRoot, record, gitOps }) {
  const payload = record.payload;
  const latest = latestReceipt({ repoRoot, changeId: payload.change_id, gitOps });
  if (!refsEqual(payload.source_receipt_ref, latest.ref)) {
    fail("cross-carrier closure source receipt is not the latest sealed receipt");
  }
  const source = walkReceiptAuthorityChain({
    repoRoot,
    changeId: payload.change_id,
    targetRef: payload.source_receipt_ref,
    gitOps,
  }).record;
  const sourcePayload = source.reviewer_payload;
  if (!new Set(["partial", "blocked"]).has(sourcePayload.verdict)) {
    fail("cross-carrier closure source receipt must be partial or blocked");
  }
  if (sourcePayload.scope.open_finding_ids.length === 0) {
    fail("cross-carrier closure source receipt has no open findings");
  }
  if (payload.source_round_number !== sourcePayload.round_number) {
    fail("cross-carrier closure source round does not match its receipt");
  }
  // R8 (fix-merge-gate-regression-currency D13): a tip-freeze Gate A∧B rebase
  // rewrites the reviewed head, so a seal head whose history still contains the
  // receipt's recorded merge-base is accepted too. That arm also admits a seal
  // head at the merge-base itself or on a rewound branch. Safety rests on the
  // remaining checks (latest sealed receipt as source, exact open finding/hash
  // set, current-HEAD literal replay); the seal HEAD is provenance only, and a
  // closure authorizes one more dispatch, never seal-final.
  if (!isAncestor(repoRoot, sourcePayload.lineage.head_sha, payload.seal_head_sha, gitOps)
    && !isAncestor(repoRoot, sourcePayload.lineage.merge_base_sha, payload.seal_head_sha, gitOps)) {
    fail("cross-carrier closure seal HEAD does not descend from the reviewed HEAD, and its history does not contain the receipt merge-base");
  }
  const expectedHashes = new Map(source.observation_hashes
    .filter(({ finding_id }) => sourcePayload.scope.open_finding_ids.includes(finding_id))
    .map(({ finding_id, observation_hash_sha256 }) => [finding_id, observation_hash_sha256]));
  if (payload.findings.length !== expectedHashes.size) {
    fail("cross-carrier closure must classify every open finding exactly once");
  }
  for (const finding of payload.findings) {
    if (expectedHashes.get(finding.finding_id) !== finding.expected_observation_hash_sha256) {
      fail("cross-carrier closure finding ID/hash set does not exactly match the source receipt");
    }
    expectedHashes.delete(finding.finding_id);
  }
  if (expectedHashes.size !== 0) fail("cross-carrier closure omitted an open finding");
  return source;
}

function parseRegularTextBlobAtHead({ repoRoot, headSha, repoRelativePath }) {
  const raw = gitBuffer(repoRoot, [
    "ls-tree",
    "-z",
    "--full-tree",
    headSha,
    "--",
    `:(literal)${repoRelativePath}`,
  ], "cross-carrier literal hit is absent from the current Git tree");
  const records = strictUtf8Bytes(raw, "cross-carrier literal tree record").split("\0");
  if (records.pop() !== "" || records.length !== 1) {
    fail("cross-carrier literal tree lookup did not resolve exactly one record");
  }
  const match = records[0].match(/^([0-9]{6}) ([a-z]+) ([0-9a-f]+)\t(.+)$/u);
  if (!match || match[4] !== repoRelativePath || !["100644", "100755"].includes(match[1]) || match[2] !== "blob") {
    fail("cross-carrier literal hit must be a tracked regular blob");
  }
  const bytes = gitBuffer(repoRoot, ["cat-file", "blob", match[3]], "cross-carrier literal blob read failed");
  return strictUtf8Bytes(bytes, `cross-carrier literal blob ${repoRelativePath}`);
}

function countLiteralOccurrences(text, literal) {
  let count = 0;
  let from = 0;
  while (true) {
    const index = text.indexOf(literal, from);
    if (index === -1) return count;
    count += 1;
    from = index + literal.length;
  }
}

function literalHitPaths({ repoRoot, headSha, literal }) {
  let output;
  try {
    output = retryOnTransientGitIo(() => execFileSync(
      "git",
      ["grep", "-I", "-F", "-l", "-z", "-e", literal, headSha, "--"],
      // stderr stays piped: silent like the previous spawnSync shape while
      // remaining classifiable inside the retry wrapper (cross-model F4).
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    ));
  } catch (error) {
    // exit status 1 is git grep's "no matches" signal, not a failure.
    if (error?.status === 1) return [];
    fail(`cross-carrier fixed-literal grep failed: ${error?.stderr?.toString?.().trim() || error?.message || String(error)}`);
  }
  const bytes = Buffer.from(output ?? []);
  if (bytes.length === 0) return [];
  const fields = strictUtf8Bytes(bytes, "cross-carrier fixed-literal grep output").split("\0");
  if (fields.pop() !== "") fail("cross-carrier fixed-literal grep output is not NUL terminated");
  const prefix = `${headSha}:`;
  return fields.map((field) => {
    if (!field.startsWith(prefix)) fail("cross-carrier fixed-literal grep output has unexpected tree prefix");
    const candidatePath = field.slice(prefix.length);
    assertBoundedClosureText(candidatePath, "cross-carrier fixed-literal grep path", { singleLine: true });
    const canonicalPath = assertSafeRepoRelativePath({ repoRoot, candidatePath });
    if (canonicalPath !== candidatePath) fail("cross-carrier fixed-literal grep returned a noncanonical path");
    return candidatePath;
  }).sort(compareCodePoints);
}

function replayCrossCarrierClosure({ repoRoot, record, currentHeadSha }) {
  const actualByFinding = new Map();
  let totalActualMatches = 0;
  for (const finding of record.payload.findings) {
    if (finding.classification === "not-applicable") continue;
    const rows = [];
    for (const literal of finding.search_literals) {
      for (const hitPath of literalHitPaths({ repoRoot, headSha: currentHeadSha, literal })) {
        totalActualMatches += 1;
        if (totalActualMatches > CROSS_CARRIER_MAX_MATCHES) {
          fail(`current-HEAD cross-carrier literal hits exceed ${CROSS_CARRIER_MAX_MATCHES} entries`);
        }
        const text = parseRegularTextBlobAtHead({ repoRoot, headSha: currentHeadSha, repoRelativePath: hitPath });
        const occurrenceCount = countLiteralOccurrences(text, literal);
        if (occurrenceCount < 1) fail("cross-carrier fixed-literal grep returned a zero-count hit");
        rows.push({ path: hitPath, literal, occurrence_count: occurrenceCount });
      }
    }
    rows.sort(compareCrossCarrierMatches);
    actualByFinding.set(finding.finding_id, rows);
  }
  for (const finding of record.payload.findings) {
    if (finding.classification === "not-applicable") continue;
    const declared = finding.matches.map(({ path: hitPath, literal, occurrence_count: occurrenceCount }) => ({
      path: hitPath,
      literal,
      occurrence_count: occurrenceCount,
    }));
    const actual = actualByFinding.get(finding.finding_id);
    if (canonicalJsonV1(declared) !== canonicalJsonV1(actual)) {
      fail(`cross-carrier literal coverage mismatch for finding ${finding.finding_id}: current HEAD hits differ from the sealed match ledger`);
    }
  }
}

function validateCrossCarrierClosureAuthority({
  repoRoot, record, gitOps, replay = true, currentHeadSha = currentHead(repoRoot), requireSealAncestor = true,
}) {
  validateCrossCarrierClosureRecord(record, { repoRoot });
  validateCrossCarrierClosureSource({ repoRoot, record, gitOps });
  if (requireSealAncestor && !isAncestor(repoRoot, record.payload.seal_head_sha, currentHeadSha, gitOps)) {
    fail("cross-carrier closure seal HEAD is not an ancestor of current HEAD");
  }
  if (replay) replayCrossCarrierClosure({ repoRoot, record, currentHeadSha });
  return currentHeadSha;
}

function sealCrossCarrierClosure({ repoRoot, changeId, sourceReceiptRef, findings, fsOps, gitOps }) {
  assertChangeId(changeId);
  ({ repoRoot, changeId } = resolveConsumerBindingOrCaller({ repoRoot, changeId }));
  assertDurableRef(sourceReceiptRef, "sourceReceiptRef");
  if (!Array.isArray(findings)) fail("findings must be an array");
  const source = walkReceiptAuthorityChain({ repoRoot, changeId, targetRef: sourceReceiptRef, gitOps });
  const sealHeadSha = currentHead(repoRoot);
  const targetRoundNumber = source.record.reviewer_payload.round_number + 1;
  const intendedFileName = crossCarrierClosureFileName(changeId, targetRoundNumber, sealHeadSha);
  const currentBeforeSeal = verifyCurrentCrossCarrierClosure({ repoRoot, changeId, gitOps });
  if (currentBeforeSeal.status === "verified" && currentBeforeSeal.closure_ref.path !== intendedFileName) {
    fail("a replay-valid cross-carrier closure already covers current HEAD; do not seal a redundant successor");
  }
  if (!["verified", "missing-current-closure"].includes(currentBeforeSeal.status)) {
    fail(`cannot seal cross-carrier closure while current closure state is ${currentBeforeSeal.status}`);
  }
  const payload = {
    change_id: changeId,
    source_receipt_ref: structuredClone(sourceReceiptRef),
    source_round_number: source.record.reviewer_payload.round_number,
    target_round_number: targetRoundNumber,
    seal_head_sha: sealHeadSha,
    findings: structuredClone(findings),
    result: "pass",
  };
  const record = {
    schema: CROSS_CARRIER_CLOSURE_SCHEMA,
    record_digest_sha256: sha256Hex(canonicalJsonV1(payload)),
    payload,
  };
  validateCrossCarrierClosureAuthority({ repoRoot, record, gitOps, currentHeadSha: sealHeadSha });
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const targetPath = path.join(notesRoot, intendedFileName);
  const sealed = durableSeal({
    repoRoot: notesRoot,
    targetPath,
    record,
    validateRecord: (candidate) => validateCrossCarrierClosureAuthority({ repoRoot, record: candidate, gitOps }),
    fsOps,
  });
  return { closure: sealed, ref: sealedEvidenceRef(notesRoot, targetPath, sealed) };
}

function closureRefIdentity(closureRef) {
  const match = closureRef?.path?.match(/^review-(.+)-cross-carrier-closure-r([1-9][0-9]*)-([0-9a-f]{40})\.json$/u);
  if (!match) fail("closureRef path is not a canonical cross-carrier closure target");
  return { changeId: match[1], targetRoundNumber: Number(match[2]), sealHeadSha: match[3] };
}

function readCrossCarrierClosure({ repoRoot, closureRef, gitOps }) {
  const identity = closureRefIdentity(closureRef);
  assertChangeId(identity.changeId);
  const loaded = readEvidenceRef({
    repoRoot,
    ref: closureRef,
    label: "cross-carrier closure ref",
    validateRecord: (record) => validateCrossCarrierClosureRecord(record, { repoRoot }),
    gitOps,
    maxBytes: CROSS_CARRIER_CLOSURE_MAX_BYTES,
  });
  return assertCrossCarrierClosureIdentity({ loaded, closureRef });
}

function assertCrossCarrierClosureIdentity({ loaded, closureRef }) {
  const identity = closureRefIdentity(closureRef);
  const payload = loaded.record.payload;
  if (payload.change_id !== identity.changeId
    || payload.target_round_number !== identity.targetRoundNumber
    || payload.seal_head_sha !== identity.sealHeadSha) {
    fail("cross-carrier closure filename identity does not match its payload");
  }
  return loaded;
}

function readCrossCarrierClosureCandidate({ repoRoot, targetPath, gitOps }) {
  const loaded = readEvidencePath({
    repoRoot,
    targetPath,
    label: "cross-carrier closure candidate",
    validateRecord: (record) => validateCrossCarrierClosureRecord(record, { repoRoot }),
    gitOps,
    maxBytes: CROSS_CARRIER_CLOSURE_MAX_BYTES,
    preserveTargetOversize: true,
  });
  return assertCrossCarrierClosureIdentity({ loaded, closureRef: loaded.ref });
}

function verifyCrossCarrierClosure({ repoRoot, closureRef, gitOps }) {
  const loaded = readCrossCarrierClosure({ repoRoot, closureRef, gitOps });
  validateCrossCarrierClosureAuthority({ repoRoot, record: loaded.record, gitOps });
  return { closure: loaded.record };
}

function verifyCurrentCrossCarrierClosure({ repoRoot, changeId, gitOps }) {
  assertChangeId(changeId);
  ({ repoRoot, changeId } = resolveConsumerBindingOrCaller({ repoRoot, changeId }));
  const { candidates, orphans } = listReceiptCandidates({ repoRoot, changeId, gitOps });
  if (candidates.length === 0) {
    if (orphans.length > 0) {
      return { ok: false, status: "invalid-closure", change: changeId, reason: "receipt-not-committed" };
    }
    return { ok: true, status: "not-required", change: changeId, reason: "no sealed receipt" };
  }
  const latest = latestReceipt({ repoRoot, changeId, gitOps });
  const sourcePayload = latest.receipt.reviewer_payload;
  if (!["partial", "blocked"].includes(sourcePayload.verdict)
    || sourcePayload.scope.open_finding_ids.length === 0) {
    return {
      ok: true,
      status: "not-required",
      change: changeId,
      source_round_number: sourcePayload.round_number,
      reason: "latest receipt has no open partial/blocked finding set",
    };
  }
  const targetRoundNumber = sourcePayload.round_number + 1;
  const currentHeadSha = currentHead(repoRoot);
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const escaped = changeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^review-${escaped}-cross-carrier-closure-r${targetRoundNumber}-[0-9a-f]{40}\\.json$`, "u");
  const names = readdirSync(notesRoot).filter((name) => pattern.test(name)).sort(compareCodePoints);
  if (names.length > CROSS_CARRIER_MAX_CANDIDATES) {
    return {
      ok: false,
      status: "invalid-closure",
      change: changeId,
      source_round_number: sourcePayload.round_number,
      target_round_number: targetRoundNumber,
      reason: `cross-carrier closure candidate count exceeds ${CROSS_CARRIER_MAX_CANDIDATES}`,
    };
  }
  const current = [];
  for (const name of names) {
    const targetPath = path.join(notesRoot, name);
    let loaded;
    try {
      loaded = readCrossCarrierClosureCandidate({ repoRoot, targetPath, gitOps });
      validateCrossCarrierClosureAuthority({
        repoRoot,
        record: loaded.record,
        gitOps,
        replay: false,
        currentHeadSha,
        requireSealAncestor: false,
      });
    } catch (error) {
      return {
        ok: false,
        status: "invalid-closure",
        change: changeId,
        source_round_number: sourcePayload.round_number,
        target_round_number: targetRoundNumber,
        reason: error.message,
      };
    }
    // R8 (D13): a structurally valid closure whose seal HEAD is no longer in
    // current history — after a forward re-anchor, or any other rewrite such as
    // an amend or a reset — is stale evidence, like a failed replay below. It
    // never satisfies the gate and must not block resealing.
    if (!isAncestor(repoRoot, loaded.record.payload.seal_head_sha, currentHeadSha, gitOps)) continue;
    try {
      replayCrossCarrierClosure({ repoRoot, record: loaded.record, currentHeadSha });
      current.push({ ref: loaded.ref, record: loaded.record });
    } catch {
      // A structurally valid historical closure whose declared hit set no
      // longer covers current HEAD is stale evidence, not malformed evidence.
    }
  }
  if (current.length === 1) {
    return {
      ok: true,
      status: "verified",
      change: changeId,
      source_round_number: sourcePayload.round_number,
      target_round_number: targetRoundNumber,
      closure_ref: current[0].ref,
    };
  }
  return {
    ok: false,
    status: current.length === 0 ? "missing-current-closure" : "ambiguous-current-closure",
    change: changeId,
    source_round_number: sourcePayload.round_number,
    target_round_number: targetRoundNumber,
    reason: current.length === 0
      ? "no sealed closure exactly covers the latest open findings at current HEAD"
      : "multiple sealed closures claim the same latest open findings at current HEAD",
  };
}

/**
 * D10: the report surface's loader for the stall observation. It is a LOADER
 * AND A DELEGATION, never a second rule. The streak question is answered by
 * `review-stall-budget.mjs` and by nothing else -- this function's whole job
 * is to get a validated projection into that module's hands. If the streak
 * condition were ever spelled out here as well, gate and report could reach
 * different verdicts about the same chain, which is the failure D9 rejects.
 *
 * The anchor differs from the gate's, and deliberately: `classifyBoundedRereview`
 * walks from the receipt the caller declares, because it is deciding whether to
 * authorize the NEXT round; this walks from the newest sealed receipt, because
 * it is reporting what has happened so far. D3 fixed that precedence (gate
 * authoritative, report diagnostic).
 *
 * The four states are distinct on purpose (D20 + fix-false-green-signals D4):
 *
 *   not-applicable  zero receipts -- nothing SHOULD have been read. A change
 *                   that has never run a review round must not be blocked by
 *                   a gate about review rounds. Also: listing cannot be
 *                   produced because there was nowhere to look (no change id,
 *                   caller's root is not inside a repo). Collapsing those into
 *                   `unavailable` would stop every post-PR turn outside a repo.
 *   ok / exhausted  the chain read and validated; the rule decided.
 *   unavailable     receipts exist but the chain would not load or validate,
 *                   OR receipt-directory enumeration failed with EACCES/EIO
 *                   (permission / IO damage — evidence is not readable, so the
 *                   answer is NEVER `not-applicable` "never reviewed"),
 *                   OR binding resolution hit the worktree candidate cap
 *                   (the receipt location is unknown, which is not the same
 *                   as no receipts). Every other binding-resolution fault
 *                   keeps `not-applicable`.
 *
 * `enumerationMemo` (optional) is the post-PR Stop hook's per-run worktree-enumeration handle: it lets
 * the binding resolution reuse one successful member enumeration across markers. It caches the member LIST only,
 * never this function's result: every call still resolves the binding, lists receipts and walks the chain fresh.
 *
 * Nothing here throws: a producer that threw would crash its caller instead of
 * degrading it. Listing failures split by cause: EACCES/EIO → `unavailable`;
 * "nowhere to look" / assert failures → `not-applicable`.
 *
 * The cost of the split is that a `notes/` symlink -- `derivedNotesRoot`'s own
 * tamper guard -- reports `not-applicable` here rather than `unavailable`.
 * That is accepted because this is the observation surface, not the
 * authorizing one: `latestReceipt` / `classifyBoundedRereview` still refuse
 * the same root outright, and they are what grants a round.
 *
 * (The "decide before any query" invariant belongs to the evaluator in
 * `cost-budget.mjs`, which is the surface whose result must stay bit-identical
 * for callers with no receipt-chain concept; this is the producer, which is
 * only ever called by a caller that has one.)
 */
function queryReviewStallState({ repoRoot, changeId, gitOps, fsOps, enumerationMemo }) {
  let candidates;
  let orphans;
  try {
    assertString(changeId, "review stall change id");
    ({ repoRoot, changeId } = resolveConsumerBindingOrCaller({ repoRoot, changeId, enumerationMemo }));
    ({ candidates, orphans } = listReceiptCandidates({ repoRoot, changeId, gitOps, fsOps }));
  } catch (error) {
    if (isReceiptDirectoryEnumerateIoFailure(error)) {
      return { state: "unavailable", streak: null };
    }
    // Binding resolution hit the worktree budget: the receipt location is unknown, which is not an absence of
    // receipts. Since PR #2915, fail() throws CoreFailure for D30 codes and its .code and .message both equal the
    // code, so matching `.message` (as resolveConsumerBindingOrCaller does) is equivalent to matching `.code`.
    // Only this one resolution fault maps to unavailable; every other one keeps not-applicable below.
    if (error?.message === "intent-candidate-limit-exceeded") return { state: "unavailable", streak: null };
    return { state: "not-applicable", streak: null };
  }
  if (candidates.length === 0) {
    if (orphans.length > 0) return { state: "unavailable", streak: null };
    return { state: "not-applicable", streak: null };
  }
  try {
    // Two passes over the same chain, on purpose. `latestReceipt` validates
    // the anchor (temporal ordering, round agreement, digest) and yields its
    // ref; the walk from that ref is what produces `stallProjection`, which
    // covers rounds 1..N. Collapsing this into one unvalidated read would buy
    // a few file reads and give up the validation that makes `ok` mean
    // anything -- do not "optimize" it away.
    const { ref } = latestReceipt({ repoRoot, changeId, gitOps });
    const rounds = walkReceiptAuthorityChain({ repoRoot, changeId, targetRef: ref, gitOps }).stallProjection;
    return {
      state: isReviewStallBudgetExhausted({ rounds }) ? "exhausted" : "ok",
      streak: deriveReviewStallStreak(rounds),
    };
  } catch {
    // Bound deliberately: the error text of a receipt-chain failure carries
    // absolute paths and digests, and this value is rendered into a
    // user-facing budget report. The diagnosis lives in the receipt tooling
    // (`verify-receipt`), not in a threshold row.
    return { state: "unavailable", streak: null };
  }
}

function blockingIdsFromFindings(findings) {
  const ids = [];
  for (const entry of findings ?? []) {
    const severity = entry.observation?.severity;
    if (entry.state === "open" && (severity === "Critical" || severity === "Important")) {
      ids.push(entry.finding_id);
    }
  }
  return ids.sort(compareCodePoints);
}

// Marks the one coverage failure that means "this receipt is not a terminal converged review": the
// verdict is not finished, or some finding is still open. `classifyFinalReadiness` reports it as a
// named diagnosis so the caller can see it before archive, when it is still cheap to act on; after
// archive the same refusal from `seal-final` costs an archive undo and another review round.
const RECEIPT_NOT_CONVERGED = Symbol("receipt-not-converged");
// Carries the finding IDs whose guarantee assessment is unresolved, so classify-final can name the one
// non-convergence cause that open_finding_ids cannot show (every finding may already be closed).
const RECEIPT_UNRESOLVED_ASSESSMENTS = Symbol("receipt-unresolved-assessments");

// Diagnosis only: lists the finding IDs whose guarantee assessment is `unresolved`. It never changes what a
// receipt seals or verifies to; assertConvergedReceipt still refuses the receipt through requires_clarification.
function unresolvedAssessmentIds(payload) {
  const assessments = payload?.guarantee_assessment?.assessments;
  if (!Array.isArray(assessments)) return [];
  return [...new Set(assessments
    .filter((entry) => entry?.classification === "unresolved" && typeof entry.finding_id === "string")
    .map((entry) => entry.finding_id))].sort(compareCodePoints);
}

function unclosedFindingIds(payload) {
  return [...new Set([
    ...payload.scope.open_finding_ids,
    ...payload.findings.filter(({ state }) => state !== "closed").map(({ finding_id: findingId }) => findingId),
  ])].sort(compareCodePoints);
}

function failNotConverged(message, payload) {
  try {
    fail(message);
  } catch (error) {
    if (error !== null && typeof error === "object") {
      error[RECEIPT_NOT_CONVERGED] = unclosedFindingIds(payload);
      error[RECEIPT_UNRESOLVED_ASSESSMENTS] = unresolvedAssessmentIds(payload);
    }
    throw error;
  }
}

function assertConvergedReceipt(receipt, { repoRoot = null, gitOps } = {}) {
  const payload = receipt.reviewer_payload;
  if (validatePayloadGuaranteeAssessment(payload)?.requires_clarification) {
    failNotConverged("guarantee assessment requires clarification", payload);
  }
  if (payload.verdict !== "finished") failNotConverged("latest receipt is partial or blocked, not terminal finished", payload);
  const blockingIds = [];
  for (const entry of payload.findings) {
    const severity = entry.observation?.severity;
    if (entry.state === "open" && (severity === "Critical" || severity === "Important")) {
      blockingIds.push(entry.finding_id);
      continue;
    }
    if (closedBlockingDispositionProblem({ entry, payload, repoRoot, gitOps }) !== null) {
      blockingIds.push(entry.finding_id);
    }
  }
  if (payload.scope.open_finding_ids.length > 0 || payload.findings.some(({ state }) => state !== "closed")) {
    const openBlock = blockingIds.length > 0 ? ` blocking_ids=${blockingIds.join(",")}` : "";
    failNotConverged(`latest finished receipt still contains open findings${openBlock} open_finding_ids=${unclosedFindingIds(payload).join(",")}`, payload);
  }
  if (blockingIds.length > 0) {
    fail(`latest finished receipt still contains seal-blocking Critical/Important findings blocking_ids=${blockingIds.join(",")}`);
  }
}

function assertWholeTreeClean(repoRoot, message = "whole worktree/index is dirty, staged, unstaged, or untracked") {
  if (gitBuffer(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "cannot determine whole-tree status").length > 0) {
    fail(message);
  }
}

// Refusal text for sealReviewManifest's committed-worktree precondition (see
// the call site for why it is not part of the `current` verification mode).
const SEAL_MANIFEST_REQUIRES_COMMITTED_WORKTREE_MESSAGE = "seal-manifest requires a committed worktree"
  + " — a commit made after sealing moves HEAD and leaves the same-round manifest stale and not re-sealable;"
  + " commit or discard the pending changes before sealing again";

const MAX_INLINE_LOG_BYTES = 2 * 1024 * 1024;
const RAW_CAPTURE_MAX_BYTES = MAX_INLINE_LOG_BYTES + 1;

function parseSuiteSummary(stdoutBytes, stderrBytes) {
  const stdout = strictUtf8Bytes(stdoutBytes, "canonical final suite stdout");
  strictUtf8Bytes(stderrBytes, "canonical final suite stderr");
  const summaries = [...stdout.matchAll(/^\[test-suite\] tier=([A-Za-z0-9_-]+) log=[^\r\n]* digest_sha256=([0-9a-f]{64}) tests=(\d+) pass=(\d+) fail=(\d+) skipped=(\d+)(?: failed_names=[^\r\n]*)?$/gm)];
  const terminals = [...stdout.matchAll(/^\[test-suite\] tier=([A-Za-z0-9_-]+) [^\r\n]* status=(pass|fail)$/gm)];
  const malformed = (reason) => fail(
    `canonical final suite ${reason} (summaries=${summaries.length}, terminals=${terminals.length}, stdout_digest_sha256=${sha256Hex(stdoutBytes)})`,
  );
  if (summaries.length === 0 || summaries.length !== terminals.length) {
    malformed("terminal summary is malformed");
  }
  const tierLabels = new Set();
  const counts = summaries.map((summary, index) => {
    const label = summary[1];
    if (tierLabels.has(label) || terminals[index][1] !== label) {
      malformed("tier summary/terminal pairing is malformed");
    }
    tierLabels.add(label);
    return {
      tests: Number(summary[3]),
      passed: Number(summary[4]),
      failed: Number(summary[5]),
      skipped: Number(summary[6]),
    };
  });
  // node:test folds skips into `tests` but not pass/fail. Require exact
  // tests === pass + fail + skipped, fail=0, status=pass, and at least one
  // real pass when tests>0 so an all-skip tier cannot seal as complete pass.
  if (terminals.some((terminal) => terminal[2] !== "pass")
    || counts.some((entry) => (
      entry.failed !== 0
      || entry.tests !== entry.passed + entry.failed + entry.skipped
      || (entry.tests > 0 && entry.passed === 0)
    ))) {
    fail("canonical final suite did not PASS");
  }
  const tests = counts.reduce((total, entry) => total + entry.tests, 0);
  const passed = counts.reduce((total, entry) => total + entry.passed, 0);
  const failed = counts.reduce((total, entry) => total + entry.failed, 0);
  return { tests, passed, failed };
}

function inlineLog(bytes, label) {
  if (!Buffer.isBuffer(bytes)) fail(`${label} bytes must be a Buffer`);
  if (bytes.length > MAX_INLINE_LOG_BYTES) fail(`${label} exceeds the 2 MiB inline limit`);
  return {
    encoding: "base64",
    bytes_base64: bytes.toString("base64"),
    byte_length: bytes.length,
    digest_sha256: sha256Hex(bytes),
  };
}

function validateInlineLog(log, label) {
  assertExactKeys(log, ["encoding", "bytes_base64", "byte_length", "digest_sha256"], label);
  if (log.encoding !== "base64") fail(`${label}.encoding must be base64`);
  if (typeof log.bytes_base64 !== "string") fail(`${label}.bytes_base64 must be a string`);
  const bytes = Buffer.from(log.bytes_base64, "base64");
  if (bytes.toString("base64") !== log.bytes_base64) fail(`${label}.bytes_base64 is not canonical RFC4648 base64`);
  assertSafeInteger(log.byte_length, `${label}.byte_length`);
  if (log.byte_length < 0 || log.byte_length > MAX_INLINE_LOG_BYTES || log.byte_length !== bytes.length) {
    fail(`${label}.byte_length is invalid or exceeds the 2 MiB inline limit`);
  }
  assertDigest(log.digest_sha256, `${label}.digest_sha256`);
  if (log.digest_sha256 !== sha256Hex(bytes)) fail(`${label}.digest_sha256 mismatch`);
  return bytes;
}

function transitionTreeFactFromListing(repoRoot, rootPath, record, gitOps) {
  const match = record.match(/^([0-9]{6}) ([a-z]+) ([0-9a-f]+)\t(.+)$/u);
  if (!match) fail("archive transition tree record is malformed");
  const [, mode, type, oid, carrierPath] = match;
  if (mode !== "100644" || type !== "blob") fail("archive transition carriers must be exact 100644 blobs");
  if (carrierPath !== rootPath && !carrierPath.startsWith(`${rootPath}/`)) {
    fail("archive transition tree record escapes the requested root");
  }
  const canonicalPath = assertSafeRepoRelativePath({ repoRoot, candidatePath: carrierPath });
  if (canonicalPath !== carrierPath) fail("archive transition tree record path is not canonical");
  if (!gitObjectHexPattern(repoRoot, gitOps).test(oid)) fail("archive transition tree record OID has wrong object format");
  const bytes = requiredOperationGitOps(gitOps).readBlobByOid({ repoRoot, oid });
  if (!Buffer.isBuffer(bytes)) fail("archive transition Git object read did not return bytes");
  return { path: carrierPath, mode, oid, bytes };
}

function transitionTreeFacts(repoRoot, headSha, rootPath, gitOps) {
  const raw = selectedGitOps(gitOps).readTreeRecordsUnderPath({ repoRoot, headSha, path: rootPath });
  if (!Buffer.isBuffer(raw)) fail("archive transition tree listing did not return bytes");
  const records = strictUtf8Bytes(raw).split("\0");
  if (records.pop() !== "") fail("archive transition tree listing is not NUL terminated");
  return records.map((record) => transitionTreeFactFromListing(repoRoot, rootPath, record, gitOps));
}

function transitionTreePaths(repoRoot, headSha) {
  const raw = git(repoRoot, ["ls-tree", "-r", "-z", "--name-only", headSha, "--", "openspec/changes"], { encoding: "buffer" });
  const paths = strictUtf8Bytes(raw).split("\0");
  if (paths.pop() !== "") fail("archive transition path listing is not NUL terminated");
  return paths;
}

// Refuses any path under `root` whose change-folder-relative form matches a
// prefix that MUST NOT be tracked. The message names the offending path and
// the remedy, because the only correct operator action is to untrack it.
function assertHookCarriersUntracked(paths, root, label) {
  const offenders = paths
    .filter((carrierPath) => carrierPath.startsWith(`${root}/`))
    .filter((carrierPath) => ARCHIVE_TRANSITION_UNTRACKED_PREFIXES.test(carrierPath.slice(root.length + 1)))
    .sort(compareCodePoints);
  if (offenders.length === 0) return;
  fail(
    `archive transition ${label} tracks ${offenders.length} path(s) under a gitignored hook-carrier prefix, ` +
    `first: ${offenders[0]}. admission-records/ and override-ledger/ are worktree-local carriers ignored by ` +
    ".gitignore and MUST NOT be tracked; a tracked entry means unreviewed content is riding the archive commit. " +
    `Untrack it (git rm --cached -r -- '<path>'), confirm .gitignore carries the managed block, and re-run the ` +
    "review at a head where nothing under those prefixes is tracked.",
  );
}

function deriveActiveArchiveMapping({ repoRoot, changeId, reviewedHeadSha, postArchiveHeadSha, gitOps }) {
  const activeRoot = `openspec/changes/${changeId}`;
  const paths = transitionTreePaths(repoRoot, postArchiveHeadSha);
  if (paths.some((entry) => entry.startsWith(`${activeRoot}/`))) fail("archive transition post HEAD still contains active artifacts");
  const archiveRoots = new Set();
  for (const carrierPath of paths) {
    const match = carrierPath.match(/^openspec\/changes\/archive\/(\d{4}-\d{2}-\d{2}-.+?)\//u);
    if (match && match[1].slice(11) === changeId) archiveRoots.add(`openspec/changes/archive/${match[1]}`);
  }
  if (archiveRoots.size !== 1) fail("archive transition requires one unique dated archive");
  const archiveRoot = [...archiveRoots][0];
  // Fail closed on any TRACKED path under the hook-carrier prefixes (see
  // ARCHIVE_TRANSITION_UNTRACKED_PREFIXES). Both prefixes are gitignored, so a
  // hit here is never a legitimate carrier: it is either a `git add -f` of an
  // unreviewed file riding the archive commit, or a stale tracked entry from
  // before the ignore rules landed. Both must stop the transition.
  // Assert absence BEFORE deriving tree facts. `transitionTreeFacts` parses
  // every record's mode and rejects anything that is not an exact 100644 blob,
  // so a carrier force-added as 100755 used to be reported as a file-mode
  // problem -- telling the operator to chmod a path that must not be tracked at
  // all, instead of to untrack it. The `--name-only` listing never parses a
  // mode, so the actionable message wins (r19 `F-r19-mode-mismatch-message`,
  // re-opened at r21 after r20 substituted its observation subject).
  assertHookCarriersUntracked(transitionTreePaths(repoRoot, reviewedHeadSha), activeRoot, "reviewed HEAD");
  assertHookCarriersUntracked(paths, archiveRoot, "archive commit");
  const active = transitionTreeFacts(repoRoot, reviewedHeadSha, activeRoot, gitOps);
  const archived = transitionTreeFacts(repoRoot, postArchiveHeadSha, archiveRoot, gitOps);
  // Deliberately kept alongside the pre-facts pair, not folded into it: these
  // run on canonicalized `fact.path` values, so a listing whose raw path the
  // name-only pass could not match is still caught here. Two sources, one
  // fail-closed property -- do not "simplify" either away.
  assertHookCarriersUntracked(active.map((fact) => fact.path), activeRoot, "reviewed HEAD");
  assertHookCarriersUntracked(archived.map((fact) => fact.path), archiveRoot, "archive commit");
  if (active.length === 0) fail("reviewed HEAD has no active artifacts");
  const relativeMap = (facts, root) => new Map(facts.map((fact) => [fact.path.slice(root.length + 1), fact]));
  const activeMap = relativeMap(active, activeRoot);
  const archiveMap = relativeMap(archived, archiveRoot);
  if (activeMap.size !== active.length || archiveMap.size !== archived.length || activeMap.size !== archiveMap.size) {
    fail("archive transition mapping is missing or duplicate");
  }
  const entries = [];
  for (const relativePath of [...activeMap.keys()].sort(compareCodePoints)) {
    const before = activeMap.get(relativePath);
    const after = archiveMap.get(relativePath);
    if (!after || before.mode !== after.mode || before.oid !== after.oid || !before.bytes.equals(after.bytes)) {
      fail("archive transition byte/mode/OID mapping mismatch");
    }
    entries.push({
      active_path: before.path, archive_path: after.path,
      active_mode: before.mode, archive_mode: after.mode,
      active_object_id: before.oid, archive_object_id: after.oid,
    });
  }
  const preProjection = [...activeMap].map(([relativePath, fact]) => ({
    relative_path: relativePath, mode: fact.mode, object_id: fact.oid,
  })).sort((a, b) => compareCodePoints(a.relative_path, b.relative_path));
  const postProjection = [...archiveMap].map(([relativePath, fact]) => ({
    relative_path: relativePath, mode: fact.mode, object_id: fact.oid,
  })).sort((a, b) => compareCodePoints(a.relative_path, b.relative_path));
  return {
    archiveRoot,
    mapping: { entries, digest_sha256: sha256Hex(canonicalJsonV1(entries)) },
    preSemanticDigest: sha256Hex(canonicalJsonV1(preProjection)),
    postSemanticDigest: sha256Hex(canonicalJsonV1(postProjection)),
  };
}

function parseRequirementBodies(text, label, delta = false) {
  try {
    return parsePromotionRequirementBodies(text, label, delta);
  } catch (error) {
    fail(error.message);
  }
}

function optionalCanonical({ repoRoot, headSha, canonicalPath, gitOps }) {
  const facts = transitionTreeFacts(repoRoot, headSha, canonicalPath, gitOps);
  if (facts.length === 0) return { entries: [], oid: null };
  if (facts.length !== 1) fail("canonical promotion path is ambiguous");
  return { entries: parseRequirementBodies(strictUtf8Bytes(facts[0].bytes), canonicalPath), oid: facts[0].oid };
}

function derivePromotion({ repoRoot, reviewedHeadSha, postArchiveHeadSha, archiveRoot, mapping, gitOps }) {
  const deltaPaths = mapping.entries.map(({ archive_path: carrierPath }) => carrierPath)
    .filter((carrierPath) => carrierPath.startsWith(`${archiveRoot}/specs/`) && carrierPath.endsWith("/spec.md"))
    .sort(compareCodePoints);
  const entries = [];
  const canonicalFiles = [];
  for (const deltaPath of deltaPaths) {
    const capability = deltaPath.slice(`${archiveRoot}/specs/`.length, -"/spec.md".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(capability)) fail("archive transition capability path is invalid");
    const canonicalPath = `openspec/specs/${capability}/spec.md`;
    const [deltaFact] = transitionTreeFacts(repoRoot, postArchiveHeadSha, deltaPath, gitOps);
    if (!deltaFact) fail("archive transition delta spec is missing");
    const deltas = parseRequirementBodies(strictUtf8Bytes(deltaFact.bytes), deltaPath, true);
    const pre = optionalCanonical({ repoRoot, headSha: reviewedHeadSha, canonicalPath, gitOps });
    const post = optionalCanonical({ repoRoot, headSha: postArchiveHeadSha, canonicalPath, gitOps });
    canonicalFiles.push({ path: canonicalPath, pre_object_id: pre.oid, post_object_id: post.oid });
    const preMap = new Map(pre.entries.map(({ title, body }) => [title, body]));
    const postMap = new Map(post.entries.map(({ title, body }) => [title, body]));
    const expected = new Map(preMap);
    const deltaTitles = new Set(deltas.map((item) => item.title));
    for (const item of deltas) {
      const preBody = preMap.get(item.title);
      const postBody = postMap.get(item.title);
      if (item.mode === "ADDED") {
        if (preBody !== undefined || postBody !== item.body) fail(`ADDED promotion title/body mismatch or absence (${item.title}; ${canonicalPath})`);
        expected.set(item.title, item.body);
      } else if (item.mode === "MODIFIED") {
        if (preBody === undefined || postBody !== item.body) fail(`MODIFIED promotion title/body mismatch (${item.title}; ${canonicalPath})`);
        expected.set(item.title, item.body);
      } else {
        if (preBody !== item.body || postBody !== undefined) fail(`REMOVED promotion retained or title/body mismatch (${item.title}; ${canonicalPath})`);
        expected.delete(item.title);
      }
      entries.push({
        delta_path: deltaPath, delta_mode: item.mode, requirement_title: item.title,
        delta_body_digest: item.body_digest, canonical_spec_path: canonicalPath,
        pre_body_digest: preBody === undefined ? null : sha256Hex(Buffer.from(preBody)),
        post_body_digest: postBody === undefined ? null : sha256Hex(Buffer.from(postBody)),
      });
    }
    const mismatchedTitles = findUnmappedPromotionTitles({
      expectedMap: expected,
      postMap,
      deltaTitles,
    });
    if (mismatchedTitles.length > 0) {
      const named = mismatchedTitles.slice(0, 8).join(", ");
      fail(`canonical promotion contains an unmapped semantic change (${named})`);
    }
  }
  entries.sort((a, b) => compareCodePoints(`${a.delta_path}\0${a.delta_mode}\0${a.requirement_title}`, `${b.delta_path}\0${b.delta_mode}\0${b.requirement_title}`));
  canonicalFiles.sort((a, b) => compareCodePoints(a.path, b.path));
  return {
    mapping: { entries, digest_sha256: sha256Hex(canonicalJsonV1(entries)) },
    canonicalFiles,
  };
}

function rawTransitionManifest(repoRoot, fromSha, toSha) {
  const raw = gitBuffer(repoRoot, ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", fromSha, toSha], "cannot derive transition diff");
  const fields = strictUtf8Bytes(raw).split("\0");
  if (fields.pop() !== "") fail("transition raw diff is not NUL terminated");
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = fields[index]?.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z][0-9]*)$/u);
    if (!match || fields[index + 1] === undefined) fail("transition raw diff entry is malformed");
    entries.push({ path: fields[index + 1], status: match[5], old_mode: match[1], new_mode: match[2], old_object_id: match[3], new_object_id: match[4] });
  }
  const manifest = { from_sha: fromSha, to_sha: toSha, entries };
  return { ...manifest, digest_sha256: sha256Hex(canonicalJsonV1(manifest)) };
}

function headingSectionBytes(text, heading) {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].replace(/[\t ]+$/u, "") === heading) starts.push(index);
  }
  if (starts.length === 0) return null;
  if (starts.length !== 1) fail(`tip-move heading is duplicate: ${heading}`);
  let end = lines.length;
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    if (/^## (?!#)/u.test(lines[index].replace(/[\t ]+$/u, ""))) {
      end = index;
      break;
    }
  }
  return `${lines.slice(starts[0], end).join("\n")}\n`;
}

function gitShowText(repoRoot, sha, repoRelativePath) {
  try {
    // stderr stays piped so a transient EINTR remains classifiable inside
    // git()'s retry wrapper (F-hrr-f2-01).
    return git(repoRoot, ["show", `${sha}:${repoRelativePath}`], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

/** Git diff-tree rename/copy status (Rnnn / Cnnn) without re-typing ledger id digit class. */
function isGitRenameOrCopyNameStatus(status) {
  if (typeof status !== "string" || status.length === 0) return false;
  const kind = status.codePointAt(0);
  if (kind !== 0x52 && kind !== 0x43) return false; // R or C
  for (let i = 1; i < status.length; i += 1) {
    const c = status.codePointAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

function tipMovePathAllowed(changeId, repoRelativePath) {
  if (repoRelativePath === `openspec/changes/${changeId}/decisions.md`) return "decisions";
  const match = repoRelativePath.match(new RegExp(`^notes/review-${changeId.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-r([1-9][0-9]*)\\.md$`, "u"));
  if (match) return "notes";
  return null;
}

/**
 * D6 tip-move whitelist: (reviewedSha, headSha] first-parent chain may only
 * touch decisions.md (non-Identity) and append-only notes/review-<id>-rN.md,
 * with behavior-risk-v1 digest unchanged. FAIL CLOSED otherwise.
 */
function classifyTipMoveWhitelist({ repoRoot, reviewedSha, headSha, changeId, gitOps }) {
  assertChangeId(changeId);
  assertSha(reviewedSha, "tip-move reviewedSha");
  assertSha(headSha, "tip-move headSha");
  if (!/^[0-9a-f]{40}$/u.test(reviewedSha) || !/^[0-9a-f]{40}$/u.test(headSha)) {
    fail("tip-move shas must be 40-char lowercase hex");
  }
  if (reviewedSha === headSha) fail("tip-move requires a non-empty (reviewed, head] range");
  if (!isAncestor(repoRoot, reviewedSha, headSha, gitOps)) {
    fail("tip-move headSha must be a descendant of reviewedSha");
  }

  const range = git(repoRoot, ["rev-list", "--first-parent", `${reviewedSha}..${headSha}`])
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  if (range.length === 0) fail("tip-move first-parent range is empty");

  for (const sha of range) {
    const tokens = git(repoRoot, ["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/u);
    if (tokens.length !== 2 || tokens[0] !== sha) {
      fail("tip-move rejects merge commits (commit must have exactly one parent)");
    }
    const nameStatus = git(repoRoot, [
      "diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "-z", sha,
    ]);
    const fields = nameStatus.split("\0").filter((part) => part.length > 0);
    for (let index = 0; index < fields.length; ) {
      const status = fields[index];
      if (status === undefined) fail("tip-move diff-tree status missing");
      if (isGitRenameOrCopyNameStatus(status)) {
        const oldPath = fields[index + 1];
        const newPath = fields[index + 2];
        if (oldPath === undefined || newPath === undefined) fail("tip-move rename/copy paths missing");
        if (tipMovePathAllowed(changeId, oldPath) === null || tipMovePathAllowed(changeId, newPath) === null) {
          fail(`tip-move rename/copy escapes allowlist: ${oldPath} -> ${newPath}`);
        }
        index += 3;
        continue;
      }
      const pathName = fields[index + 1];
      if (pathName === undefined) fail("tip-move diff-tree path missing");
      if (tipMovePathAllowed(changeId, pathName) === null) {
        fail(`tip-move path not allowlisted: ${pathName}`);
      }
      index += 2;
    }
  }

  const decisionsPath = `openspec/changes/${changeId}/decisions.md`;
  const beforeDecisions = gitShowText(repoRoot, reviewedSha, decisionsPath);
  const afterDecisions = gitShowText(repoRoot, headSha, decisionsPath);
  if (beforeDecisions !== null || afterDecisions !== null) {
    const beforeIdentity = beforeDecisions === null
      ? null
      : headingSectionBytes(beforeDecisions, "## Design-Author Identity");
    const afterIdentity = afterDecisions === null
      ? null
      : headingSectionBytes(afterDecisions, "## Design-Author Identity");
    if (beforeIdentity !== afterIdentity) {
      fail("tip-move must not modify ## Design-Author Identity");
    }
  }

  // Notes envelopes: append-only relative to reviewed tree.
  const changedNotes = git(repoRoot, [
    "diff-tree", "-r", "--name-only", "-z", reviewedSha, headSha,
  ]).split("\0").filter((part) => tipMovePathAllowed(changeId, part) === "notes");
  for (const notesPath of changedNotes) {
    const before = gitShowText(repoRoot, reviewedSha, notesPath);
    const after = gitShowText(repoRoot, headSha, notesPath);
    if (after === null) fail(`tip-move notes file deleted: ${notesPath}`);
    if (before !== null && !after.startsWith(before)) {
      fail(`tip-move notes must be append-only: ${notesPath}`);
    }
  }

  const preRisk = deriveHistoricalRiskShapeDigest({
    repoRoot,
    changeId,
    candidateHead: reviewedSha,
    gitOps,
    digestAlg: RISK_SHAPE_DIGEST_ALG_V1,
  });
  const postRisk = deriveHistoricalRiskShapeDigest({
    repoRoot,
    changeId,
    candidateHead: headSha,
    gitOps,
    digestAlg: RISK_SHAPE_DIGEST_ALG_V1,
  });
  if (preRisk !== postRisk) fail("tip-move behavior-risk digest changed");
  return { ok: true, reviewed_sha: reviewedSha, head_sha: headSha, commit_count: range.length };
}

function deriveTransitionFacts({ repoRoot, changeId, receipt, receiptRef, headSha, gitOps }) {
  const reviewed = receipt.reviewer_payload.lineage.head_sha;
  const parents = git(repoRoot, ["rev-list", "--parents", "-n", "1", headSha]).trim().split(/\s+/u);
  if (parents.length !== 2 || parents[0] !== headSha) {
    fail("archive transition HEAD must have exactly one parent");
  }
  const parentSha = parents[1];
  let tipMove = null;
  if (parentSha === reviewed) {
    // classic sole-child archive commit
  } else {
    tipMove = classifyTipMoveWhitelist({
      repoRoot,
      reviewedSha: reviewed,
      headSha: parentSha,
      changeId,
      gitOps,
    });
  }
  const mappingBase = parentSha;
  const moved = deriveActiveArchiveMapping({ repoRoot, changeId, reviewedHeadSha: mappingBase, postArchiveHeadSha: headSha, gitOps });
  const promotion = derivePromotion({ repoRoot, reviewedHeadSha: mappingBase, postArchiveHeadSha: headSha, archiveRoot: moved.archiveRoot, mapping: moved.mapping, gitOps });
  const preRisk = deriveHistoricalRiskShapeDigest({
    repoRoot,
    changeId,
    candidateHead: reviewed,
    gitOps,
    digestAlg: RISK_SHAPE_DIGEST_ALG_V1,
  });
  const postRisk = deriveHistoricalRiskShapeDigest({
    repoRoot,
    changeId,
    candidateHead: headSha,
    gitOps,
    digestAlg: RISK_SHAPE_DIGEST_ALG_V1,
  });
  const receiptAlg = resolveRiskShapeDigestAlg(receipt.reviewer_payload.scope.risk_shape_digest_alg);
  if (receiptAlg !== RISK_SHAPE_DIGEST_ALG_V1) {
    fail("archive transition digest_alg_mismatch: receipt must seal under behavior-risk-v1");
  }
  if (preRisk !== receipt.reviewer_payload.scope.risk_shape_digest_sha256 || preRisk !== postRisk) fail("archive transition risk-shape mismatch");
  const raw = rawTransitionManifest(repoRoot, mappingBase, headSha);
  const expected = new Map();
  for (const item of moved.mapping.entries) { expected.set(item.active_path, "D"); expected.set(item.archive_path, "A"); }
  for (const canonical of promotion.canonicalFiles) {
    if (canonical.pre_object_id !== canonical.post_object_id) {
      expected.set(canonical.path, canonical.pre_object_id === null ? "A" : canonical.post_object_id === null ? "D" : "M");
    }
  }
  // Third absence assertion, on the raw diff itself (see
  // ARCHIVE_TRANSITION_UNTRACKED_PREFIXES). Strictly this is implied by the two
  // tree-level assertions in deriveActiveArchiveMapping — a path absent from
  // both trees cannot appear in the diff between them — but the raw diff is the
  // artifact that gets sealed into the transition payload, so it is asserted
  // directly rather than by inference. There is no pairing step any more: the
  // previous code consumed archive-side additions by matching them against
  // active-side deletions, which meant an addition with no matching deletion
  // was never inspected. Nothing under these prefixes may appear at all.
  const activeRoot = `openspec/changes/${changeId}`;
  const rawPaths = raw.entries.map((item) => item.path);
  assertHookCarriersUntracked(rawPaths, activeRoot, "raw diff (active side)");
  assertHookCarriersUntracked(rawPaths, moved.archiveRoot, "raw diff (archive side)");
  const mappedEntries = raw.entries;
  if (mappedEntries.length !== expected.size || mappedEntries.some((item) => expected.get(item.path) !== item.status[0])) fail("archive transition raw diff contains unmapped paths");
  return {
    archiveRoot: moved.archiveRoot,
    tipMove,
    payload: {
      change_id: changeId, terminal_receipt_ref: receiptRef, base_sha: receipt.reviewer_payload.lineage.base_sha,
      reviewed_head_sha: reviewed, post_archive_head_sha: headSha, post_archive_parent_sha: parentSha,
      active_archive_mapping: moved.mapping, canonical_promotion_mapping: promotion.mapping,
      d2_equivalence: {
        pre_risk_shape_digest_sha256: preRisk, post_risk_shape_digest_sha256: postRisk,
        pre_semantic_projection_digest_sha256: moved.preSemanticDigest,
        post_semantic_projection_digest_sha256: moved.postSemanticDigest,
      },
      raw_diff_manifest: raw,
    },
  };
}

function assertGitObjectId(value, label) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    fail(`${label} must be a full lowercase Git object id`);
  }
}

function validateDigestEnvelope(value, entryKeys, label) {
  assertExactKeys(value, ["entries", "digest_sha256"], label);
  if (!Array.isArray(value.entries)) fail(`${label}.entries must be an array`);
  for (const [index, entry] of value.entries.entries()) {
    assertExactKeys(entry, entryKeys, `${label} entry ${index}`);
  }
  assertDigest(value.digest_sha256, `${label} digest`);
  if (value.digest_sha256 !== sha256Hex(canonicalJsonV1(value.entries))) fail(`${label} digest mismatch`);
}

function validateArchiveTransitionRecord(record) {
  assertExactKeys(record, ["schema", "record_digest_sha256", "payload"], "ArchiveTransitionEvidence");
  if (record.schema !== ARCHIVE_TRANSITION_SCHEMA) fail("unknown ArchiveTransitionEvidence schema");
  const payload = record.payload;
  assertExactKeys(payload, [
    "change_id", "terminal_receipt_ref", "base_sha", "reviewed_head_sha", "post_archive_head_sha",
    "post_archive_parent_sha", "active_archive_mapping", "canonical_promotion_mapping", "d2_equivalence",
    "raw_diff_manifest", "mechanical_gate_runs", "result",
  ], "ArchiveTransitionEvidence payload");
  assertChangeId(payload.change_id);
  assertDurableRef(payload.terminal_receipt_ref, "transition terminal receipt ref");
  for (const [field, label] of [
    ["base_sha", "transition base"], ["reviewed_head_sha", "transition reviewed HEAD"],
    ["post_archive_head_sha", "transition post HEAD"], ["post_archive_parent_sha", "transition parent"],
  ]) assertSha(payload[field], label);
  if (payload.post_archive_parent_sha !== payload.reviewed_head_sha
    && !/^[0-9a-f]{40}$/u.test(payload.post_archive_parent_sha)) {
    fail("transition parent must be reviewed HEAD or a tip-move descendant sha");
  }
  // Classic sole-child keeps parent === reviewed; tip-move sets parent to the
  // allowlisted tip. Exact ancestry is re-derived in deriveTransitionFacts.

  validateDigestEnvelope(payload.active_archive_mapping, [
    "active_path", "archive_path", "active_mode", "archive_mode", "active_object_id", "archive_object_id",
  ], "active/archive mapping");
  const activePaths = new Set();
  const archivePaths = new Set();
  for (const entry of payload.active_archive_mapping.entries) {
    for (const key of ["active_path", "archive_path"]) assertString(entry[key], `transition ${key}`);
    if (!/^\d{6}$/u.test(entry.active_mode) || !/^\d{6}$/u.test(entry.archive_mode)) fail("transition mapping mode is invalid");
    assertGitObjectId(entry.active_object_id, "transition active object");
    assertGitObjectId(entry.archive_object_id, "transition archive object");
    if (activePaths.has(entry.active_path) || archivePaths.has(entry.archive_path)) fail("transition mapping has duplicate paths");
    activePaths.add(entry.active_path);
    archivePaths.add(entry.archive_path);
  }

  validateDigestEnvelope(payload.canonical_promotion_mapping, [
    "delta_path", "delta_mode", "requirement_title", "delta_body_digest", "canonical_spec_path",
    "pre_body_digest", "post_body_digest",
  ], "canonical promotion mapping");
  const promotionKeys = new Set();
  for (const entry of payload.canonical_promotion_mapping.entries) {
    for (const key of ["delta_path", "requirement_title", "canonical_spec_path"]) assertString(entry[key], `promotion ${key}`);
    if (!["ADDED", "MODIFIED", "REMOVED"].includes(entry.delta_mode)) fail("promotion delta mode is invalid");
    assertDigest(entry.delta_body_digest, "promotion delta body digest");
    assertDigest(entry.pre_body_digest, "promotion pre body digest", true);
    assertDigest(entry.post_body_digest, "promotion post body digest", true);
    const key = `${entry.delta_path}\0${entry.delta_mode}\0${entry.requirement_title}`;
    if (promotionKeys.has(key)) fail("promotion mapping has duplicate requirement bindings");
    promotionKeys.add(key);
  }

  assertExactKeys(payload.d2_equivalence, [
    "pre_risk_shape_digest_sha256", "post_risk_shape_digest_sha256",
    "pre_semantic_projection_digest_sha256", "post_semantic_projection_digest_sha256",
  ], "transition D2 equivalence");
  for (const [field, value] of Object.entries(payload.d2_equivalence)) assertDigest(value, `transition D2 ${field}`);
  if (payload.d2_equivalence.pre_risk_shape_digest_sha256 !== payload.d2_equivalence.post_risk_shape_digest_sha256
    || payload.d2_equivalence.pre_semantic_projection_digest_sha256 !== payload.d2_equivalence.post_semantic_projection_digest_sha256) {
    fail("transition D2 equivalence mismatch");
  }

  assertExactKeys(payload.raw_diff_manifest, ["from_sha", "to_sha", "entries", "digest_sha256"], "transition raw diff manifest");
  assertSha(payload.raw_diff_manifest.from_sha, "transition raw diff from");
  assertSha(payload.raw_diff_manifest.to_sha, "transition raw diff to");
  if (!Array.isArray(payload.raw_diff_manifest.entries)) fail("transition raw diff entries must be an array");
  for (const [index, entry] of payload.raw_diff_manifest.entries.entries()) {
    assertExactKeys(entry, ["path", "status", "old_mode", "new_mode", "old_object_id", "new_object_id"], `transition raw diff entry ${index}`);
    assertString(entry.path, `transition raw diff entry ${index} path`);
    assertString(entry.status, `transition raw diff entry ${index} status`);
    if (!/^\d{6}$/u.test(entry.old_mode) || !/^\d{6}$/u.test(entry.new_mode)) fail("transition raw diff mode is invalid");
    assertGitObjectId(entry.old_object_id, "transition raw diff old object");
    assertGitObjectId(entry.new_object_id, "transition raw diff new object");
  }
  const rawWithoutDigest = structuredClone(payload.raw_diff_manifest);
  delete rawWithoutDigest.digest_sha256;
  assertDigest(payload.raw_diff_manifest.digest_sha256, "transition raw diff digest");
  if (payload.raw_diff_manifest.digest_sha256 !== sha256Hex(canonicalJsonV1(rawWithoutDigest))) fail("transition raw diff digest mismatch");

  if (!Array.isArray(payload.mechanical_gate_runs) || payload.mechanical_gate_runs.length !== 3) fail("transition mechanical gate set is incomplete");
  for (const [index, run] of payload.mechanical_gate_runs.entries()) {
    assertExactKeys(run, ["command_id", "argv", "timeout_ms", "exit_code", "log"], `transition gate run ${index}`);
    assertString(run.command_id, `transition gate run ${index} command id`);
    assertUniqueStrings(run.argv, `transition gate run ${index} argv`);
    if (run.timeout_ms !== TRANSITION_TIMEOUT_MS || run.exit_code !== 0) fail("transition gate result is not accepted");
    validateInlineLog(run.log, `transition gate run ${index} inline log`);
  }
  if (payload.result !== "pass") fail("ArchiveTransitionEvidence only permits pass");
  assertDigest(record.record_digest_sha256, "transition record digest");
  if (record.record_digest_sha256 !== sha256Hex(canonicalJsonV1(payload))) fail("ArchiveTransitionEvidence digest mismatch");
  return record;
}

// The second fixed gate follows the repository profile determination (the same one that decides the
// final-suite route): a direct consumer cannot control the spec state it inherits, so it runs the
// consumer-only delta gate (new or changed invalidity vs the review merge-base) instead of the
// repo-wide validation; every other profile, including every failure to determine one, keeps the
// repo-wide validation (`determineFinalSuiteProfile` is total: it maps every oracle failure to a
// source route and never throws). The base is the sealed receipt's merge-base, so it never moves
// with `main`.
function transitionGateAuthority({ repoRoot, changeId, receipt }) {
  const baseSha = receipt.reviewer_payload.lineage.merge_base_sha;
  assertSha(baseSha, "archive transition delta gate base");
  return { consumer: determineFinalSuiteProfile(repoRoot).route === "consumer-na", changeId, baseSha };
}

function transitionGateDefinitions(archiveRoot, gateAuthority) {
  const openSpecGate = gateAuthority.consumer
    ? {
      commandId: "openspec-validate-delta",
      command: process.execPath,
      args: [".devpro/scripts/openspec-validate-delta.mjs", "--change", gateAuthority.changeId, "--base", gateAuthority.baseSha],
    }
    : { commandId: "openspec validate --strict --specs", command: "openspec", args: ["validate", "--strict", "--specs", "--no-interactive"] };
  return [
    { commandId: "pre-pr-archive-gate", command: process.execPath, args: [".devpro/scripts/pre-pr-archive-gate.mjs"] },
    openSpecGate,
    { commandId: "lint-spec-shall-must", command: process.execPath, args: [".devpro/scripts/lint-spec-shall-must.mjs", archiveRoot] },
  ];
}

// On Windows the npm-installed `openspec` is a `.cmd` shim, which `spawnSync` can only start
// through a shell (Node refuses to spawn a `.cmd` directly since CVE-2024-27980). Only the
// `openspec` gate needs it and its argv is a fixed literal, so no caller text reaches the
// shell. The recorded argv stays `["openspec", ...]` on every platform: the sealed
// transition record must not depend on where it was produced (#2874).
function transitionGateSpawnOptions(gate, platform) {
  return platform === "win32" && gate.command === "openspec" ? { shell: true } : {};
}

function runTransitionGates({ repoRoot, archiveRoot, gateAuthority, spawnSyncImpl, platform = process.platform }) {
  const runs = [];
  for (const gate of transitionGateDefinitions(archiveRoot, gateAuthority)) {
    const result = spawnSyncImpl(gate.command, gate.args, {
      cwd: repoRoot,
      timeout: TRANSITION_TIMEOUT_MS,
      maxBuffer: RAW_CAPTURE_MAX_BYTES,
      ...transitionGateSpawnOptions(gate, platform),
    });
    if (!result || typeof result !== "object") fail(`archive transition gate ${gate.commandId} returned malformed result`);
    if (result.error?.code === "ETIMEDOUT") fail(`archive transition gate ${gate.commandId} timeout`);
    if (result.error?.code === "ENOBUFS") fail(`archive transition gate ${gate.commandId} capture overflow`);
    if (result.error !== undefined && result.error !== null) fail(`archive transition gate ${gate.commandId} spawn failed`);
    if (result.signal !== undefined && result.signal !== null) fail(`archive transition gate ${gate.commandId} terminated by signal`);
    if (!Number.isInteger(result.status)) fail(`archive transition gate ${gate.commandId} returned malformed status`);
    if (result.status !== 0) fail(`archive transition gate ${gate.commandId} failed`);
    if (!Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)) fail(`archive transition gate ${gate.commandId} returned non-Buffer output`);
    const acceptsCapPressureSoftWarn = gate.commandId === "pre-pr-archive-gate"
      && isCanonicalCapPressureSoftWarn(result.stderr);
    if (result.stderr.length !== 0 && !acceptsCapPressureSoftWarn) {
      fail(`archive transition gate ${gate.commandId} emitted stderr`);
    }
    const logBytes = Buffer.concat([result.stdout, result.stderr]);
    runs.push({
      command_id: gate.commandId,
      argv: [gate.command, ...gate.args],
      timeout_ms: TRANSITION_TIMEOUT_MS,
      exit_code: 0,
      log: inlineLog(logBytes, `transition gate ${gate.commandId} inline log`),
    });
  }
  return runs;
}

function expectedTransitionRuns(archiveRoot, gateAuthority) {
  return transitionGateDefinitions(archiveRoot, gateAuthority).map((gate) => ({
    command_id: gate.commandId,
    argv: [gate.command, ...gate.args],
    timeout_ms: TRANSITION_TIMEOUT_MS,
    exit_code: 0,
  }));
}

function verifyTransitionGateRuns({ archiveRoot, runs, gateAuthority }) {
  const expected = expectedTransitionRuns(archiveRoot, gateAuthority);
  if (runs.length !== expected.length) fail("transition gate run count mismatch");
  for (const [index, run] of runs.entries()) {
    const authority = expected[index];
    for (const key of ["command_id", "timeout_ms", "exit_code"]) {
      if (run[key] !== authority[key]) fail("transition gate authority mismatch");
    }
    if (canonicalJsonV1(run.argv) !== canonicalJsonV1(authority.argv)) fail("transition gate argv mismatch");
    validateInlineLog(run.log, `transition gate run ${index} inline log`);
  }
}

function sameTransitionPayload(left, right) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function verifyArchiveTransition({ repoRoot, changeId, receipt, receiptRef, headSha, gitOps, transitionRef = null }) {
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const targetPath = path.join(notesRoot, archiveTransitionFileName(changeId, headSha));
  const expectedRef = evidenceRef(notesRoot, targetPath);
  if (transitionRef !== null && canonicalJsonV1(transitionRef) !== canonicalJsonV1(expectedRef)) fail("archive transition ref mismatch");
  const record = readCanonicalRecord({ repoRoot: notesRoot, targetPath, validateRecord: validateArchiveTransitionRecord });
  const facts = deriveTransitionFacts({ repoRoot, changeId, receipt, receiptRef, headSha, gitOps });
  const expectedPayload = { ...facts.payload, mechanical_gate_runs: record.payload.mechanical_gate_runs, result: "pass" };
  if (!sameTransitionPayload(record.payload, expectedPayload)) fail("archive transition evidence does not match Git-derived transition");
  verifyTransitionGateRuns({
    archiveRoot: facts.archiveRoot,
    runs: record.payload.mechanical_gate_runs,
    gateAuthority: transitionGateAuthority({ repoRoot, changeId, receipt }),
  });
  return { record, ref: expectedRef, archiveRoot: facts.archiveRoot };
}

// Set on the error `verifyArchiveTransition` throws when the only thing missing is the sealed transition record:
// no record exists for this HEAD AND the HEAD is a Git-equivalent archive transition (the same derivation
// `sealArchiveTransition` runs first succeeds). `classifyFinalReadiness` reports that as a pending `seal-final`
// step instead of the bare `full_reopen_required` that a genuinely invalid transition also gets. The error itself
// is rethrown unchanged for every other caller.
const ARCHIVE_TRANSITION_UNSEALED = Symbol("archive-transition-unsealed");

function verifyArchiveTransitionMarkingUnsealed(input) {
  try {
    return verifyArchiveTransition(input);
  } catch (error) {
    try {
      const notesRoot = derivedNotesRoot(input.repoRoot, input.gitOps);
      const targetPath = path.join(notesRoot, archiveTransitionFileName(input.changeId, input.headSha));
      if (!pathExistsForTransition(targetPath)) {
        deriveTransitionFacts(input);
        if (error !== null && typeof error === "object") error[ARCHIVE_TRANSITION_UNSEALED] = true;
      }
    } catch {
      // absent record on a tree that is not an equivalent transition, or an unreadable path: not the benign case
    }
    throw error;
  }
}

function sealArchiveTransition({ repoRoot, changeId, receipt, receiptRef, headSha, gitOps, fsOps, spawnSyncImpl, platform }) {
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const targetPath = path.join(notesRoot, archiveTransitionFileName(changeId, headSha));
  try {
    return verifyArchiveTransition({ repoRoot, changeId, receipt, receiptRef, headSha, gitOps });
  } catch (error) {
    if (pathExistsForTransition(targetPath)) fail(`archive transition collision or invalid existing evidence: ${error.message}`);
  }
  const facts = deriveTransitionFacts({ repoRoot, changeId, receipt, receiptRef, headSha, gitOps });
  const gateAuthority = transitionGateAuthority({ repoRoot, changeId, receipt });
  const mechanicalGateRuns = runTransitionGates({
    repoRoot, archiveRoot: facts.archiveRoot, gateAuthority, spawnSyncImpl, platform,
  });
  const payload = { ...facts.payload, mechanical_gate_runs: mechanicalGateRuns, result: "pass" };
  const record = { schema: ARCHIVE_TRANSITION_SCHEMA, record_digest_sha256: sha256Hex(canonicalJsonV1(payload)), payload };
  const sealed = durableSeal({ repoRoot: notesRoot, targetPath, record, validateRecord: validateArchiveTransitionRecord, fsOps });
  verifyTransitionGateRuns({ archiveRoot: facts.archiveRoot, runs: sealed.payload.mechanical_gate_runs, gateAuthority });
  return { record: sealed, ref: sealedEvidenceRef(notesRoot, targetPath, sealed), archiveRoot: facts.archiveRoot };
}

function pathExistsForTransition(targetPath) {
  try { lstatSync(targetPath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function validateReviewCoverage(coverage) {
  assertExactKeys(coverage, ["mode", "terminal_receipt_ref", "reviewed_head_sha", "archive_transition_ref"], "review coverage");
  if (!["direct", "archive_transition"].includes(coverage.mode)) fail("invalid review coverage mode");
  assertDurableRef(coverage.terminal_receipt_ref, "review coverage terminal receipt ref");
  assertSha(coverage.reviewed_head_sha, "review coverage reviewed HEAD");
  if (coverage.mode === "direct") {
    if (coverage.archive_transition_ref !== null) fail("direct review coverage requires null transition ref");
  } else {
    assertDurableRef(coverage.archive_transition_ref, "review coverage transition ref");
  }
}

function validateFinalPayload(payload) {
  assertExactKeys(payload, [
    "canonical_owner_id", "head_sha", "review_coverage", "final_carrier_manifest", "command_id", "result",
    "tests", "passed", "failed", "log",
  ], "final evidence payload");
  assertString(payload.canonical_owner_id, "canonical owner id");
  assertSha(payload.head_sha, "final evidence head sha");
  validateReviewCoverage(payload.review_coverage);
  validateFinalCarrierManifest(payload.final_carrier_manifest);
  // Closed two-type result: the source pass shape and the consumer
  // not-applicable shape. Any other result value or command id is rejected.
  if (payload.command_id !== "source-change-scoped-suite") fail("invalid final suite authority");
  if (payload.result === FINAL_SUITE_RESULT_PASS) {
    assertSafeInteger(payload.tests, "final tests");
    assertSafeInteger(payload.passed, "final passed");
    assertSafeInteger(payload.failed, "final failed");
    if (payload.failed !== 0
      || payload.tests < payload.passed + payload.failed
      || (payload.tests > 0 && payload.passed === 0)) {
      fail("final suite counts do not represent a complete pass");
    }
  } else if (payload.result === FINAL_SUITE_RESULT_CONSUMER_NA) {
    if (payload.tests !== null || payload.passed !== null || payload.failed !== null) {
      fail("not-applicable final suite result must not carry counts");
    }
  } else {
    fail("invalid final suite authority");
  }
  validateInlineLog(payload.log, "final inline log");
}

function validateFinalRecord(record) {
  assertExactKeys(record, ["schema", "record_digest_sha256", "payload"], "FinalEvidenceRecord");
  if (record.schema !== FINAL_EVIDENCE_SCHEMA) fail("unknown FinalEvidenceRecord schema");
  validateFinalPayload(record.payload);
  assertDigest(record.record_digest_sha256, "final record digest");
  if (record.record_digest_sha256 !== sha256Hex(canonicalJsonV1(record.payload))) fail("FinalEvidenceRecord digest mismatch");
  return record;
}

function coverageSnapshot({ repoRoot, changeId, gitOps, fsOps, spawnSyncImpl, platform, sealTransition = false }) {
  const headSha = currentHead(repoRoot);
  const mainSha = resolvedMain(repoRoot);
  const { receipt, ref } = latestReceipt({ repoRoot, changeId, gitOps });
  assertConvergedReceipt(receipt, { repoRoot, gitOps });
  const reviewedHeadSha = receipt.reviewer_payload.lineage.head_sha;
  const mergeBaseSha = selectedGitOps(gitOps).mergeBase({
    repoRoot,
    leftSha: mainSha,
    rightSha: reviewedHeadSha,
  });
  if (receipt.reviewer_payload.lineage.base_sha !== mergeBaseSha || receipt.reviewer_payload.lineage.merge_base_sha !== mergeBaseSha) {
    fail("latest receipt review-base/merge-base lineage mismatch");
  }
  let reviewCoverage;
  if (reviewedHeadSha === headSha) {
    reviewCoverage = { mode: "direct", terminal_receipt_ref: ref, reviewed_head_sha: reviewedHeadSha, archive_transition_ref: null };
  } else {
    const transition = sealTransition
      ? sealArchiveTransition({ repoRoot, changeId, receipt, receiptRef: ref, headSha, gitOps, fsOps, spawnSyncImpl, platform })
      : verifyArchiveTransitionMarkingUnsealed({ repoRoot, changeId, receipt, receiptRef: ref, headSha, gitOps });
    reviewCoverage = { mode: "archive_transition", terminal_receipt_ref: ref, reviewed_head_sha: reviewedHeadSha, archive_transition_ref: transition.ref };
  }
  const headMergeBaseSha = selectedGitOps(gitOps).mergeBase({
    repoRoot,
    leftSha: mainSha,
    rightSha: headSha,
  });
  return {
    headSha,
    mainSha,
    reviewCoverage,
    carrier: finalCarrierManifest(repoRoot, headMergeBaseSha, headSha),
  };
}

function sameCoverageSnapshot(left, right) {
  return left.headSha === right.headSha && left.mainSha === right.mainSha
    && canonicalJsonV1(left.reviewCoverage) === canonicalJsonV1(right.reviewCoverage)
    && left.carrier.digest_sha256 === right.carrier.digest_sha256;
}

function sealFinalEvidenceRecord({ repoRoot, changeId, canonicalOwnerId, fsOps, gitOps, spawnSyncImpl = spawnSync, platform }) {
  assertChangeId(changeId);
  ({ repoRoot, changeId } = resolveConsumerBindingOrCaller({ repoRoot, changeId }));
  assertString(canonicalOwnerId, "canonicalOwnerId");
  assertWholeTreeClean(repoRoot);
  const staged = coverageSnapshot({ repoRoot, changeId, gitOps, fsOps, spawnSyncImpl, platform, sealTransition: true });
  assertWholeTreeClean(repoRoot);
  const before = coverageSnapshot({ repoRoot, changeId, gitOps, sealTransition: false });
  if (!sameCoverageSnapshot(staged, before)) fail("HEAD, main, review coverage, or carrier manifest changed during transition publication");
  const profileBefore = determineFinalSuiteProfile(repoRoot);
  const result = spawnSyncImpl(process.execPath, [
    ".devpro/scripts/run-test-suite.mjs", "--changed", "main", "--stdio", "log",
  ], { cwd: repoRoot, maxBuffer: RAW_CAPTURE_MAX_BYTES });
  if (!result || typeof result !== "object") fail("canonical final suite returned malformed result");
  if (result.error?.code === "ENOBUFS") fail("canonical final suite capture overflow");
  if (result.error !== undefined && result.error !== null) fail("canonical final suite spawn failed");
  if (result.signal !== undefined && result.signal !== null) fail("canonical final suite terminated by signal");
  if (!Number.isInteger(result.status)) fail("canonical final suite returned malformed status");
  if (result.status !== 0) fail("canonical final suite failed");
  if (!Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)) fail("canonical final suite returned non-Buffer output");
  const outputCheck = checkFinalSuiteOutput({ route: profileBefore.route, stdout: result.stdout, stderr: result.stderr });
  if (!outputCheck.ok) {
    fail(
      `canonical final suite output does not match the repository profile determination (reason=${outputCheck.reason}, basis=${profileBefore.basis}, stdout_digest_sha256=${sha256Hex(result.stdout)})`,
    );
  }
  const summary = profileBefore.route === "consumer-na"
    ? { tests: null, passed: null, failed: null }
    : parseSuiteSummary(result.stdout, result.stderr);
  const logBytes = Buffer.concat([result.stdout, result.stderr]);
  const log = inlineLog(logBytes, "final inline log");
  assertWholeTreeClean(repoRoot);
  const after = coverageSnapshot({ repoRoot, changeId, gitOps, sealTransition: false });
  if (!sameCoverageSnapshot(before, after)) fail("HEAD, main, review coverage, or carrier manifest changed during final suite");
  const profileAfter = determineFinalSuiteProfile(repoRoot);
  if (profileAfter.route !== profileBefore.route || profileAfter.basis !== profileBefore.basis) {
    fail("repository profile determination changed during final suite");
  }
  const payload = {
    canonical_owner_id: canonicalOwnerId,
    head_sha: after.headSha,
    review_coverage: after.reviewCoverage,
    final_carrier_manifest: after.carrier,
    command_id: "source-change-scoped-suite",
    result: profileBefore.expectedResult,
    tests: summary.tests,
    passed: summary.passed,
    failed: summary.failed,
    log,
  };
  validateFinalPayload(payload);
  const record = { schema: FINAL_EVIDENCE_SCHEMA, record_digest_sha256: sha256Hex(canonicalJsonV1(payload)), payload };
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const targetPath = path.join(notesRoot, finalFileName(changeId, after.headSha));
  return { record: durableSeal({ repoRoot: notesRoot, targetPath, record, validateRecord: validateFinalRecord, fsOps }) };
}

function verifyFinalEvidenceRecord({ repoRoot, changeId, gitOps }) {
  assertChangeId(changeId);
  ({ repoRoot, changeId } = resolveConsumerBindingOrCaller({ repoRoot, changeId }));
  assertWholeTreeClean(repoRoot);
  const snapshot = coverageSnapshot({ repoRoot, changeId, gitOps, sealTransition: false });
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const record = readCanonicalRecord({ repoRoot: notesRoot, targetPath: path.join(notesRoot, finalFileName(changeId, snapshot.headSha)), validateRecord: validateFinalRecord });
  const payload = record.payload;
  if (payload.head_sha !== snapshot.headSha || canonicalJsonV1(payload.review_coverage) !== canonicalJsonV1(snapshot.reviewCoverage)
    || canonicalJsonV1(payload.final_carrier_manifest) !== canonicalJsonV1(snapshot.carrier)) fail("final coverage, HEAD, or Git carrier manifest mismatch");
  validateInlineLog(payload.log, "final inline log");
  const profile = determineFinalSuiteProfile(repoRoot);
  if (payload.result !== profile.expectedResult) {
    fail(`final suite result does not match the repository profile determination (basis=${profile.basis})`);
  }
  return { record };
}

// design.md D4 (fix-merge-gate-regression-currency) "Writer/reader 大小契約":
// `durableSeal` always round-trips the whole record through one JS string
// (`${canonicalJsonV1(record)}\n`, written, then read back and reparsed in the
// same process), so any record a real writer could ever have sealed has a
// UTF-16 length <= `buffer.constants.MAX_STRING_LENGTH`. UTF-8 bytes are at
// most 3x that (every UTF-16 code unit encodes to at most 3 UTF-8 bytes; a
// surrogate pair is 2 units / 4 bytes, still <= 3x2). This bound MUST be
// derived from the runtime constant, never a numeric literal, so a reader and
// writer sharing a Node runtime never disagree about it, and a reader on a
// smaller-limit runtime only ever fails closed (never accepts something the
// writer could not have produced).
const FINAL_EVIDENCE_READ_MAX_BYTES = 3 * BUFFER_CONSTANTS.MAX_STRING_LENGTH;

// design.md D4/D5 (fix-merge-gate-regression-currency): the merge-time,
// read-only FinalEvidenceRecord verifier. Reuses only writer-side SSOT
// (`derivedNotesRoot`, `finalFileName`, `readEvidencePath`, `validateFinalRecord`,
// `parseReceiptCandidateName`, `archiveTransitionFileName`) and MUST NOT call
// `assertWholeTreeClean`/`coverageSnapshot`/`currentHead`/`resolvedMain` (the
// exact calls that make `verifyFinalEvidenceRecord` unusable at merge time,
// when the tree may be dirty, main may have advanced, and cwd HEAD may differ
// from the recorded head) or `resolveConsumerBindingOrCaller` (the gate has
// already limited the caller to the source repo at Step 0).
//
// `maxRecordBytes` is optional (design D4 "merge 層 byte budget", F-r2-1): when
// the caller supplies it, an oversized file is rejected before any buffer is
// allocated: `.code` stays `evidence-artifact-invalid` and `.message` carries
// the distinct `final-evidence-over-caller-budget` token (rather than the
// default limit's generic `target-oversize`), which the merge verifier matches
// by message, not by `.code` -- `readNoFollowFile`
// (durable-fs.mjs) already compares the `fstat` size against `maxBytes` before
// calling `Buffer.allocUnsafe`.
function verifyHeadBoundFinalEvidence({ repoRoot, changeId, headSha, maxRecordBytes, gitOps }) {
  assertChangeId(changeId);
  assertSha(headSha, "head-bound FinalEvidenceRecord headSha");
  if (maxRecordBytes !== undefined
    && (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0 || maxRecordBytes > FINAL_EVIDENCE_READ_MAX_BYTES)) {
    fail("maxRecordBytes must be a positive safe integer not exceeding FINAL_EVIDENCE_READ_MAX_BYTES");
  }
  const notesRoot = derivedNotesRoot(repoRoot, gitOps);
  const targetPath = path.join(notesRoot, finalFileName(changeId, headSha));
  let loaded;
  try {
    loaded = readEvidencePath({
      repoRoot,
      targetPath,
      label: "head-bound FinalEvidenceRecord",
      validateRecord: validateFinalRecord,
      gitOps,
      maxBytes: maxRecordBytes ?? FINAL_EVIDENCE_READ_MAX_BYTES,
      preserveTargetOversize: maxRecordBytes !== undefined,
    });
  } catch (error) {
    if (maxRecordBytes !== undefined && /target-oversize/.test(error?.message ?? "")) {
      throw new CoreFailure("evidence-artifact-invalid", `final-evidence-over-caller-budget: record exceeds ${maxRecordBytes} bytes`);
    }
    // A native errno fault (for example ENOENT for a missing record) escapes
    // `readEvidenceBytes` raw so a D30 CLI can map it to `unexpected-io-fault`.
    // This gate-only verifier keeps it a native fault (same `.code`, not a
    // CoreFailure) and only names the cause in the message; the native
    // message, path and syscall stay out.
    throw namedNativeFault(error, "head-bound FinalEvidenceRecord");
  }
  const { record } = loaded;
  const payload = record.payload;
  if (payload.result !== FINAL_SUITE_RESULT_PASS) fail("head-bound FinalEvidenceRecord suite result is not pass");
  if (payload.head_sha !== headSha) fail("head-bound FinalEvidenceRecord head mismatch");
  if (payload.final_carrier_manifest.head_sha !== headSha) fail("head-bound FinalEvidenceRecord carrier manifest head mismatch");
  if (parseReceiptCandidateName(changeId, payload.review_coverage.terminal_receipt_ref.path) === null) {
    fail("head-bound FinalEvidenceRecord terminal receipt ref does not belong to this change");
  }
  if (payload.review_coverage.mode === "archive_transition"
    && payload.review_coverage.archive_transition_ref.path !== archiveTransitionFileName(changeId, headSha)) {
    fail("head-bound FinalEvidenceRecord archive transition ref does not match this head");
  }
  return { record };
}

// Closed, module-internal diagnostic enum for the `full_reopen_required` route.
// Values are derived from the control-flow phase reached inside
// classifyBoundedRereview() (design.md D2/D6) -- never from a bound error
// object -- so raw error.message/stack/absolute-path text has no code path
// into the output. Human-diagnosis-only (design.md D5/D7); MUST NOT be
// exported (it would have to reach the production façade to be, and that
// façade's export set is a pinned contract -- see the "public façade remains
// exactly" test in review-remediation-evidence.test.mjs, whose
// `REQUIRED_EXPORTS` list is the only place the counts belong) and MUST NOT
// be read by any routing decision, gate, or dispatch_id digest input.
//
// This clause named the count itself -- "exactly-14-exports contract" -- until
// fix-zero-value-review-rounds T7, by which time the contract had moved to 16
// and this copy had not. Nothing checked this one, so nothing caught it. The
// number now lives only where it is asserted, and this comment points at that
// assertion instead of restating it.
const FULL_REOPEN_DEBUG_REASONS = Object.freeze({
  MANIFEST_REFS_ABSENT: "manifest_refs_absent",
  MANIFEST_VERIFICATION_FAILED: "manifest_verification_failed",
  RECEIPT_AUTHORITY_INVALID: "receipt_authority_invalid",
  BOUNDED_INPUT_INVALID: "bounded_input_invalid",
  UNCLASSIFIED_FAULT: "unclassified_fault",
});

const VALIDATOR_TRUST_SURFACE_ROOTS = Object.freeze([
  ".devpro/scripts/review-remediation-evidence.mjs",
  ".devpro/scripts/lib/review-remediation-evidence-core.mjs",
]);

// Production entrypoints and their complete static import closure. The closure
// guard derives membership from source imports; tests/docs/oracle stay excluded.
const VALIDATOR_TRUST_SURFACE_PATHS = Object.freeze([
  ...VALIDATOR_TRUST_SURFACE_ROOTS,
  ".devpro/scripts/hooks/lib/admission-record.mjs",
  ".devpro/scripts/hooks/lib/branch-naming.mjs",
  ".devpro/scripts/hooks/lib/fresh-equivalent-compare.mjs",
  ".devpro/scripts/hooks/lib/repo-state-identity.mjs",
  ".devpro/scripts/hooks/lib/shell-context.mjs",
  ".devpro/scripts/hooks/lib/tag-shapes.mjs",
  ".devpro/scripts/hooks/lib/version-helpers.mjs",
  ".devpro/scripts/lib/cap-pressure-soft-warn.mjs",
  ".devpro/scripts/lib/durable-fs.mjs",
  ".devpro/scripts/lib/eintr-retry.mjs",
  ".devpro/scripts/lib/final-suite-profile.mjs",
  ".devpro/scripts/lib/git-exec-retry.mjs",
  ".devpro/scripts/lib/half-state-override.mjs",
  ".devpro/scripts/lib/markdown-fence-aware.mjs",
  ".devpro/scripts/lib/openspec-linter-cli.mjs",
  ".devpro/scripts/lib/pii-pattern-contract.mjs",
  ".devpro/scripts/lib/primitives.mjs",
  ".devpro/scripts/lib/proposal-carriers.mjs",
  ".devpro/scripts/lib/repo-identity.mjs",
  ".devpro/scripts/lib/requirement-body-whitespace.mjs",
  ".devpro/scripts/lib/review-stall-budget.mjs",
  ".devpro/scripts/lint-risk-classes-record.mjs",
  ".devpro/scripts/lint-test-suite-manifest.mjs",
  ".devpro/scripts/run-test-suite.mjs",
  ".devpro/scripts/test-suite-manifest.mjs",
  ".devpro/scripts/windows-checkout-preflight.mjs",
  ".devpro/scripts/review-guarantee-assessment.mjs",
]);

// R14 / decisions D16: the production validator oracle, fixed by the
// canonical scenario "Production Validator Oracle Is An Independently
// Recomputing Executable" -- not a new path.
const PRODUCTION_VALIDATOR_ORACLE_PATH = ".devpro/scripts/tools/review-remediation-validator-oracle.mjs";

// Closed trust-eligible failure messages from validateManifestFilesAndTrust /
// validateIndependentEvidence. Unknown messages fail closed as structural.
const VALIDATOR_TRUST_ELIGIBLE_EXACT = Object.freeze(new Set([
  "changed validator cannot claim pre-existing-trusted provenance",
  "oracle cannot be the validator itself",
  "oracle must be a production executable, not tests or prose",
  "oracle must be executable in the change base",
  "oracle subject or lineage mismatch",
  "oracle worktree module graph is dirty or changed",
  "oracle worktree module graph changed during verification",
  "oracle worktree carrier must be a regular non-symlink file",
  "oracle worktree bytes differ from trusted candidate module graph",
  "oracle result is not verified",
  "oracle evidence digest mismatch",
  "oracle module graph digest or entries mismatch",
  "oracle source digest mismatch",
  "oracle output does not agree with sealed evidence",
  "oracle emitted stderr",
  "unknown validator evidence schema",
  "oracle module graph entries must be a non-empty array",
  "same-change validator requires structured independent evidence",
  "invalid validator provenance",
  "pre-existing validator cannot carry independent evidence",
]));

const VALIDATOR_TRUST_ELIGIBLE_PREFIXES = Object.freeze([
  "oracle module must be pre-existing and unchanged:",
  "oracle exited with nonzero status",
  "oracle output is not canonical JSON:",
  "oracle module is not valid UTF-8:",
  "dynamic oracle import is forbidden:",
  "oracle module uses a forbidden runtime resource:",
  "oracle module specifier is not in the closed allowlist:",
  "oracle module import escapes the repository:",
  "oracle module graph entries must be uniquely code-point sorted",
  "oracle module graph entry ",
  "oracle dependency must be a canonical repo-relative ESM path",
  "oracle source path must be a canonical repo-relative ESM path",
  "validator independent evidence has unknown or missing fields",
  "validator evidence oracle has unknown or missing fields",
  "validator evidence subject has unknown or missing fields",
  "validator evidence lineage has unknown or missing fields",
  "oracle id must be a non-empty string",
  "oracle version must be a non-empty string",
  "oracle subject validator path must be a non-empty string",
]);

function isValidatorTrustEligibleFailure(message) {
  if (typeof message !== "string" || message.length === 0) return false;
  if (VALIDATOR_TRUST_ELIGIBLE_EXACT.has(message)) return true;
  return VALIDATOR_TRUST_ELIGIBLE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function validatorTrustSurfaceTouched(repoRoot, baseSha, headSha) {
  const output = gitBuffer(
    repoRoot,
    ["diff", "--name-only", "-z", baseSha, headSha, "--", ...VALIDATOR_TRUST_SURFACE_PATHS],
    "cannot determine validator trust-surface change status",
  );
  return output.length > 0;
}

// R14 / decisions D16: can the production oracle independently verify a
// validator trust-surface change between baseSha and headSha? Reads
// committed Git objects only. Returns a closed trust-eligible message when
// it cannot, null when it can; any other fault throws.
function productionValidatorOracleUnavailableReason(repoRoot, baseSha, headSha, gitOps) {
  const treeMode = (sha) => git(repoRoot, ["ls-tree", sha, "--", PRODUCTION_VALIDATOR_ORACLE_PATH]).trim().split(/\s+/)[0];
  if (treeMode(baseSha) !== "100755") return "oracle must be executable in the change base";
  if (treeMode(headSha) === "") return `oracle module must be pre-existing and unchanged: ${PRODUCTION_VALIDATOR_ORACLE_PATH}`;
  try {
    buildOracleModuleGraph(repoRoot, baseSha, headSha, PRODUCTION_VALIDATOR_ORACLE_PATH, gitOps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isValidatorTrustEligibleFailure(message)) return message;
    throw error;
  }
  return null;
}

function fullReopen(count, reason) {
  return { route: "full_reopen_required", next_bounded_rereview_count: count, full_reopen_debug_reason: reason };
}

function refOwnedByChange(ref, changeId, filePattern) {
  if (ref === null || ref === undefined) return false;
  return ref.path === filePattern;
}

function hasDirectedCycle(manifest) {
  const graph = new Map(manifest.inputs.entries.map(({ id }) => [id, []]));
  for (const edge of manifest.dependency_edges) graph.get(edge.from).push(edge.to);
  const visiting = new Set();
  const visited = new Set();
  const walk = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (graph.get(id).some(walk)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...graph.keys()].some(walk);
}

// Authorization order: exact single-use override > prior batch approval.
// Applied only when a dispatch id is actually issued; the override is consumed
// (D12 exact-once claim) in the same step, before the id is returned. Failures
// throw: no id, no dispatch.
//
// D8 used to open that order with two more terms: a hard stop whenever
// `budgetState === "exhausted"`, and a required override for a `route=full`
// dispatch at `at-or-above-half`. Both were driven by the three cumulative
// token/time totals, and `fix-zero-value-review-rounds` R1/D19 removed them
// at every consumer. A cumulative total measures how big a change has grown,
// not whether the current round is wasting anything, so the only review it
// can stop is one that is still closing findings. What replaced it is the
// stall budget in `classifyBoundedRereviewCore` (D6): consecutive rounds that
// closed nothing. `budgetState` is still validated here and still passed to
// the claim -- D18 keeps it a legal field with audit/report meaning and no
// routing effect, so a reader who finds it below should not infer a gate.
function applyHalfStateAuthorization(input, result) {
  const budgetState = input.budgetState === undefined ? "unavailable" : input.budgetState;
  if (!BUDGET_STATES.includes(budgetState)) fail("budgetState must be one of below-half | at-or-above-half | exhausted | unavailable");
  const overrideId = input.overrideId === undefined ? null : input.overrideId;
  const responsibilityId = input.responsibilityId === undefined ? null : input.responsibilityId;
  if (overrideId !== null && (typeof overrideId !== "string" || !UUID_V4.test(overrideId))) fail("overrideId must be a UUID v4");
  if (overrideId !== null && responsibilityId === null) fail("overrideId requires responsibilityId");
  if (result?.dispatch_ready !== true) return result;
  if (overrideId === null) return result;
  // R9: an override authorizes exactly one post-handback review dispatch. A
  // normal bounded refresh still needs no override and must not consume one;
  // only the classifier's two named handback exits are eligible. The route and
  // reason are both computed here, not caller-supplied.
  const authorizedHandback = (result.route === "bounded"
      && result.full_reopen_reason === "handback_authorized_bounded")
    || (result.route === "full"
      && result.full_reopen_reason === "handback_authorized_full");
  if (!authorizedHandback) {
    fail(`override scope is ${HALF_STATE_OVERRIDE_SCOPE}: route=${result.route} is not an authorized handback continuation`);
  }
  const claim = claimHalfStateOverride({ repoRoot: input.repoRoot, changeId: input.changeId, overrideId, responsibilityId, dispatchId: result.dispatch_id, budgetState });
  if (!claim.ok) fail(`override claim failed (${claim.code}): no dispatch id is issued`);
  // The dispatchable result keeps its exact eight-field contract; the claim
  // proof (override_id, dispatch_id, consumed_at) lives only in
  // override-ledger/<override_id>.claim/consumed.json, bound to this dispatch_id.
  return result;
}

// Binding-root boundary (strengthen-admission-binding-portability D7.2): this
// classifier keeps the caller root on purpose. Its route vocabulary already
// answers "the change is not visible from here" with `risk_shape_unavailable`,
// and a binding-resolution fault MUST NOT be folded into routing; the receipt
// round trip (build／seal／verify) and the query surfaces (stall state, current
// closure, final readiness, final evidence) resolve the effective root
// instead.
function classifyBoundedRereview(input, fsOps, gitOps) {
  return applyHalfStateAuthorization(input, classifyBoundedRereviewCore(input, fsOps, gitOps));
}

// fix-validator-touching-bounded-escape D2: when the validator trust surface
// changed and lineage/risk reopen are still null, classify both required
// manifests without short-circuiting on the first trust failure. Prefer-A keeps
// reopen null (existing loop runs). Trust-eligible-only failures mint
// `validator_trust_surface_changed`. Structural blockers stay full_reopen_required
// without a dispatch id. R14 / decisions D16: when both refs are absent, the
// mint is gated on the production oracle being unable to independently verify
// the trust-surface change -- see the "absent" branch below.
function classifyValidatorTouchingManifestGate({
  input,
  changeId,
  expectedRound,
  payload,
  headSha,
  baseSha,
  gitOps,
}) {
  const outcomes = [];
  for (const [ref, purpose] of [
    [input.repairDeltaManifestRef, "repair-delta"],
    [input.dependencyClosureManifestRef, "dependency-closure"],
  ]) {
    if (ref === null || ref === undefined) {
      outcomes.push({ kind: "absent", phase: FULL_REOPEN_DEBUG_REASONS.MANIFEST_REFS_ABSENT });
      continue;
    }
    // Retain the parsed record whenever readEvidenceRef succeeded before a
    // later throw so trust/structural-after-read outcomes can still feed the
    // dependency-closure cycle gate (F-fvte-r1-01).
    let parsedManifest = null;
    try {
      if (!refOwnedByChange(ref, changeId, manifestFileName(changeId, purpose, expectedRound))) {
        fail("manifest ref has cross-change or stale ownership");
      }
      parsedManifest = readEvidenceRef({
        repoRoot: input.repoRoot,
        ref,
        label: `${purpose} manifest ref`,
        validateRecord: validateManifestRecord,
        gitOps,
      }).record;
      // F-fvte-r1-06 / D2: trust outcome must not mask bounded-eligibility
      // structural faults. Swallow only trust-eligible failures here so purpose /
      // result / exceptions / errors / transition-lineage still run on the
      // retained parse; non-trust throws stay structural via the outer catch.
      let trustEligibleFailure = null;
      try {
        validateManifestFilesAndTrust(parsedManifest, {
          repoRoot: input.repoRoot,
          verificationMode: "current",
          gitOps,
        });
      } catch (trustError) {
        const trustMessage = trustError instanceof Error ? trustError.message : String(trustError);
        if (!isValidatorTrustEligibleFailure(trustMessage)) throw trustError;
        trustEligibleFailure = trustMessage;
      }
      if (parsedManifest.purpose !== purpose
        || parsedManifest.result !== "pass"
        || parsedManifest.exceptions.length > 0
        || parsedManifest.errors.length > 0
        || parsedManifest.lineage.change_base_sha !== baseSha
        || parsedManifest.lineage.surface_base_sha !== payload.lineage.head_sha
        || parsedManifest.lineage.candidate_head_sha !== currentHead(input.repoRoot)) {
        fail("manifest is not bounded eligible");
      }
      if (trustEligibleFailure !== null) {
        outcomes.push({
          kind: "trust",
          phase: FULL_REOPEN_DEBUG_REASONS.MANIFEST_VERIFICATION_FAILED,
          message: trustEligibleFailure,
          manifest: parsedManifest,
        });
        continue;
      }
      outcomes.push({ kind: "ok", phase: FULL_REOPEN_DEBUG_REASONS.MANIFEST_VERIFICATION_FAILED, manifest: parsedManifest });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retained = parsedManifest === null ? {} : { manifest: parsedManifest };
      if (isValidatorTrustEligibleFailure(message)) {
        outcomes.push({ kind: "trust", phase: FULL_REOPEN_DEBUG_REASONS.MANIFEST_VERIFICATION_FAILED, message, ...retained });
      } else {
        const phase = message.includes("ownership") || message.includes("bounded eligible")
          || message.includes("predecessor")
          ? (message.includes("ownership") || message.includes("manifest ref")
            ? FULL_REOPEN_DEBUG_REASONS.MANIFEST_VERIFICATION_FAILED
            : FULL_REOPEN_DEBUG_REASONS.BOUNDED_INPUT_INVALID)
          : (message.includes("absent") || message.includes("missing")
            ? FULL_REOPEN_DEBUG_REASONS.MANIFEST_REFS_ABSENT
            : FULL_REOPEN_DEBUG_REASONS.MANIFEST_VERIFICATION_FAILED);
        outcomes.push({ kind: "structural", phase, message, ...retained });
      }
    }
  }

  const repair = outcomes[0];
  const closure = outcomes[1];
  // Cycle inspection runs whenever a dependency-closure record was parsed —
  // including trust-fail / structural-after-read — before Prefer-A / Else-B.
  if (closure.manifest && hasDirectedCycle(closure.manifest)) {
    return { action: "structural", phase: FULL_REOPEN_DEBUG_REASONS.MANIFEST_VERIFICATION_FAILED };
  }

  if (repair.kind === "ok" && closure.kind === "ok") {
    // Prefer-A: both sides trust+eligibility clean and cycle-free. Predecessor
    // matches and optional content-comparison stay in the existing loop.
    return { action: "prefer_a" };
  }

  if (repair.kind === "absent" || closure.kind === "absent") {
    if (repair.kind === "absent" && closure.kind === "absent") {
      // R14 / decisions D16: absent refs reopen full only when honest manifests
      // could not be sealed, i.e. the production oracle cannot independently
      // verify this trust-surface change. Otherwise they are unevaluable.
      let unavailable = null;
      try {
        unavailable = productionValidatorOracleUnavailableReason(input.repoRoot, payload.lineage.base_sha, headSha, gitOps);
      } catch {
        unavailable = null;
      }
      return unavailable === null
        ? { action: "structural", phase: FULL_REOPEN_DEBUG_REASONS.MANIFEST_REFS_ABSENT }
        : { action: "else_b" };
    }
    return { action: "structural", phase: FULL_REOPEN_DEBUG_REASONS.MANIFEST_REFS_ABSENT };
  }

  if (repair.kind === "structural" || closure.kind === "structural") {
    const phase = repair.kind === "structural" ? repair.phase : closure.phase;
    return { action: "structural", phase };
  }

  if (repair.kind === "trust" || closure.kind === "trust") {
    return { action: "else_b" };
  }

  return { action: "structural", phase: FULL_REOPEN_DEBUG_REASONS.UNCLASSIFIED_FAULT };
}

// Shared by Prefer-A's post-manifest loop and Else-B's pre-reopen path
// (F-fvte-r1-04 / D2): predecessor exact-set and optional content-comparison
// mapping must stay structural blockers. Else-B MUST NOT mint a dispatchable
// validator_trust_surface_changed reopen while these checks would fail.
// Returns null on success; may return manifest_repair_required; structural
// failures throw via fail() for the caller's catch → full_reopen_required.
function verifyPredecessorAndOptionalContentComparison({
  input,
  previous,
  payload,
  expectedRound,
  count,
  gitOps,
  setPhase,
}) {
  setPhase(FULL_REOPEN_DEBUG_REASONS.BOUNDED_INPUT_INVALID);
  if (!Array.isArray(input.predecessorMatches)) fail("predecessorMatches must be an array");
  const expected = new Map(previous.observation_hashes
    .filter(({ finding_id }) => payload.scope.open_finding_ids.includes(finding_id))
    .map(({ finding_id, observation_hash_sha256 }) => [finding_id, observation_hash_sha256]));
  const seen = new Set();
  for (const match of input.predecessorMatches) {
    assertExactKeys(match, ["finding_id", "expected_observation_hash_sha256"], "predecessor match");
    if (seen.has(match.finding_id)
      || expected.get(match.finding_id) !== match.expected_observation_hash_sha256) fail("predecessor match set is not exact");
    seen.add(match.finding_id);
  }
  if (seen.size !== expected.size) fail("predecessor match set is incomplete");

  if (input.contentComparisonManifestRef !== undefined) {
    const ref = input.contentComparisonManifestRef;
    setPhase((ref === null || ref === undefined)
      ? FULL_REOPEN_DEBUG_REASONS.MANIFEST_REFS_ABSENT
      : FULL_REOPEN_DEBUG_REASONS.MANIFEST_VERIFICATION_FAILED);
    if (!refOwnedByChange(ref, input.changeId, manifestFileName(input.changeId, "content-comparison", expectedRound))) fail("content manifest ownership mismatch");
    const content = readEvidenceRef({
      repoRoot: input.repoRoot,
      ref,
      label: "content manifest ref",
      validateRecord: validateManifestRecord,
      gitOps,
    }).record;
    validateManifestFilesAndTrust(content, {
      repoRoot: input.repoRoot,
      verificationMode: "current",
      gitOps,
    });
    const complete = content.coverage.complete
      && content.coverage.expected_count === content.coverage.processed_count
      && content.coverage.expected_count === content.inputs.count
      && content.coverage.unknown_inputs.length === 0
      && content.coverage.omitted_inputs.length === 0
      && content.errors.length === 0;
    if (!complete || ["partial", "error"].includes(content.result)) {
      return { route: "manifest_repair_required", next_bounded_rereview_count: count };
    }
    if (content.result === "exceptions") {
      setPhase(FULL_REOPEN_DEBUG_REASONS.BOUNDED_INPUT_INVALID);
      const dispositions = input.contentExceptionDispositions;
      if (!Array.isArray(dispositions)) fail("content exception dispositions missing");
      const exceptions = new Set(content.exceptions.map(({ id }) => id));
      const mappedExceptions = new Set();
      const mappedFindings = new Set();
      for (const mapping of dispositions) {
        assertExactKeys(mapping, ["exception_id", "finding_id", "disposition"], "content exception disposition");
        const finding = payload.findings.find(({ finding_id }) => finding_id === mapping.finding_id);
        if (!exceptions.has(mapping.exception_id) || mappedExceptions.has(mapping.exception_id)
          || mappedFindings.has(mapping.finding_id) || finding?.state !== "closed"
          || finding.disposition !== mapping.disposition || mapping.disposition === null) fail("content exception mapping is not one-to-one closed disposition");
        mappedExceptions.add(mapping.exception_id);
        mappedFindings.add(mapping.finding_id);
      }
      if (mappedExceptions.size !== exceptions.size) fail("content exceptions remain unmapped");
    } else if (content.result !== "pass") {
      return { route: "manifest_repair_required", next_bounded_rereview_count: count };
    }
  }
  return null;
}

function receiptWasConvergenceRecovery(payload, changeId) {
  const matched = matchAuthorizationReasonForDispatch(
    payload,
    payload.scope.risk_shape_digest_sha256,
    changeId ?? payload.change_id,
  );
  return matched === "convergence_recovery";
}

function receiptWasHandbackAuthorized(payload, changeId) {
  const matched = matchAuthorizationReasonForDispatch(
    payload,
    payload.scope.risk_shape_digest_sha256,
    changeId ?? payload.change_id,
  );
  return matched === "handback_authorized_bounded" || matched === "handback_authorized_full";
}

// Wording-repair exception (add-wording-fix-now-bounded-route). A risk-shape change stays bounded when the
// predecessor round raised only Suggestions and the change is limited to what its fix-now Suggestions named:
// any design ## Decisions block when one of them points at design.md, and only the named safety-obligation
// entries of proposal.md. Risk classes, requirement tuples, Touch rows and the set of D-numbers must be
// unchanged. Pure over its inputs so classify-bounded and the receipt-chain walk decide it the same way.
// Returns the sorted authorizing finding IDs, or null when the exception does not apply.
const WORDING_REPAIR_MUTABLE_KEYS = new Set(["architecture_decisions", "safety_obligations"]);

function wordingRepairFindingIds({ changeId, previousPayload, earlierFindingIds, previousSnapshot, currentSnapshot }) {
  const keys = new Set([...Object.keys(previousSnapshot), ...Object.keys(currentSnapshot)]);
  for (const key of keys) {
    if (WORDING_REPAIR_MUTABLE_KEYS.has(key)) continue;
    if (canonicalJsonV1(previousSnapshot[key] ?? null) !== canonicalJsonV1(currentSnapshot[key] ?? null)) return null;
  }
  const previousDecisions = previousSnapshot.architecture_decisions;
  const currentDecisions = currentSnapshot.architecture_decisions;
  const previousSafety = previousSnapshot.safety_obligations;
  const currentSafety = currentSnapshot.safety_obligations;
  if (!Array.isArray(previousDecisions) || !Array.isArray(currentDecisions) || previousDecisions.length === 0
    || !Array.isArray(previousSafety) || !Array.isArray(currentSafety) || previousSafety.length !== currentSafety.length) return null;
  if (canonicalJsonV1(previousDecisions.map(({ number }) => number))
    !== canonicalJsonV1(currentDecisions.map(({ number }) => number))) return null;
  const raised = previousPayload.findings.filter(({ finding_id: id }) => !earlierFindingIds.has(id));
  if (raised.some(({ observation }) => observation?.severity !== "Suggestion")) return null;
  const named = raised.filter(({ disposition }) => disposition === "fix-now");
  const designPath = `openspec/changes/${changeId}/design.md`;
  const proposalPath = `openspec/changes/${changeId}/proposal.md`;
  const authorizing = new Set();
  const decisionsChanged = previousDecisions.some(({ block }, index) => block !== currentDecisions[index].block);
  if (decisionsChanged) {
    const designNamed = named.filter(({ observation }) => observation.carrier === designPath);
    if (designNamed.length === 0) return null;
    for (const { finding_id: id } of designNamed) authorizing.add(id);
  }
  let safetyChanged = false;
  for (let index = 0; index < previousSafety.length; index += 1) {
    if (previousSafety[index] === currentSafety[index]) continue;
    safetyChanged = true;
    const rowNamed = named.filter(({ observation }) => observation.carrier === proposalPath
      && typeof observation.anchor === "string" && observation.anchor.length > 0
      && previousSafety[index].includes(observation.anchor));
    if (rowNamed.length === 0) return null;
    for (const { finding_id: id } of rowNamed) authorizing.add(id);
  }
  if (!decisionsChanged && !safetyChanged) return null;
  return [...authorizing].sort(compareCodePoints);
}

// Reads what wordingRepairFindingIds needs from sealed evidence and Git. The finding IDs the predecessor
// round raised are the ones its own predecessor receipt does not carry (an initial round raised them all).
function wordingRepairFromEvidence({ repoRoot, changeId, previousPayload, candidateHead, gitOps }) {
  const earlierRef = previousPayload.lineage.previous_receipt_ref;
  const earlierFindingIds = new Set(earlierRef === null ? [] : readEvidenceRef({
    repoRoot,
    ref: earlierRef,
    label: "wording repair earlier receipt",
    validateRecord: (record) => validateReceiptRecord(record, { repoRoot, gitOps, claimRequired: false }),
    gitOps,
  }).record.reviewer_payload.findings.map(({ finding_id: id }) => id));
  return wordingRepairFindingIds({
    changeId,
    previousPayload,
    earlierFindingIds,
    previousSnapshot: deriveHistoricalRiskShapeSnapshot({ repoRoot, changeId, candidateHead: previousPayload.lineage.head_sha, gitOps }),
    currentSnapshot: deriveHistoricalRiskShapeSnapshot({ repoRoot, changeId, candidateHead, gitOps }),
  });
}

function receiptWasWordingRepair(payload, changeId) {
  return matchAuthorizationReasonForDispatch(
    payload,
    payload.scope.risk_shape_digest_sha256,
    changeId ?? payload.change_id,
  ) === "wording_repair_bounded";
}

/** Stall keeps convergent recovery for mere Target-State risk churn only. */
function stallYieldsToMandatoryFullReopen(reopen) {
  return reopen !== null && reopen.reason !== "risk_shape_changed";
}

function hasRecoveryDispositionsForOpenBlocking(input, previousPayload) {
  const blockingIds = blockingIdsFromFindings(previousPayload.findings);
  if (blockingIds.length === 0) return true;
  const entries = input.recoveryDispositions;
  if (!Array.isArray(entries)) return false;
  const bound = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const keys = Object.keys(entry).sort();
    if (keys.join("\0") !== ["bound_dispatch_id", "disposition", "finding_id"].join("\0")) return false;
    if (typeof entry.finding_id !== "string" || entry.finding_id.length === 0) return false;
    if (!RECOVERY_DISPOSITIONS.has(entry.disposition)) return false;
    if (entry.bound_dispatch_id !== previousPayload.dispatch_id) return false;
    if (bound.has(entry.finding_id)) return false;
    bound.set(entry.finding_id, entry.disposition);
  }
  return blockingIds.every((id) => bound.has(id));
}

function classifyBoundedRereviewCore(input, fsOps, gitOps) {
  let count = 0;
  let riskDigest;
  let gitAuthority;
  let previousReceipt;
  // `fix-zero-value-review-rounds` D6. Stays false unless the receipt chain
  // below is read successfully: every path that fails to read it either
  // returns before the gate or lands in a catch, so an unreadable chain can
  // never present itself as an exhausted stall budget.
  let stallExhausted = false;
  // R6/D22. Holds the reopen decision (`git_lineage_changed` /
  // `risk_shape_changed` / `validator_trust_surface_changed` / …) taken inside
  // the try below, so the stop can be read before the dispatch that acts on it.
  // Cap yields to any pending reopen. Stall yields only to mandatory-full
  // reopen reasons other than a mere `risk_shape_changed` (F1 / Stall Revokes);
  // mere Target-State prose churn must not displace convergent recovery.
  let reopen = null;
  // Set when the wording-repair exception keeps a risk-shape change bounded (wordingRepairFindingIds).
  let wordingRepairIds = null;
  // FR8/S3 (design.md D5): assertChangeId/currentGitAuthority are not risk-shape
  // derivation -- they are the request's own authority -- so they get their own
  // leading try/catch with a fixed reason, kept separate from the risk-shape
  // fault-scope marks read below.
  try {
    assertChangeId(input.changeId);
    gitAuthority = currentGitAuthority(input.repoRoot, gitOps);
  } catch {
    return riskUnavailable(count, RISK_SHAPE_DEBUG_REASONS.REQUEST_OR_GIT_AUTHORITY_INVALID);
  }
  try {
    riskDigest = deriveRiskShapeDigest(deriveRiskShapeSnapshot({
      repoRoot: input.repoRoot,
      changeId: input.changeId,
      candidateHead: gitAuthority.head_sha,
      fsOps,
      gitOps,
    }));
  } catch (error) {
    return riskUnavailable(count, riskShapeFaultReason(error));
  }

  if (input.previousReceiptRef === null) {
    try {
      if (input.repairDeltaManifestRef !== null || input.dependencyClosureManifestRef !== null
        || !Array.isArray(input.predecessorMatches) || input.predecessorMatches.length !== 0) {
        fail("initial dispatch requires null durable refs and no predecessor matches");
      }
      return dispatchResult({
        route: "full",
        count: 0,
        roundNumber: 1,
        riskDigest,
        reason: "initial_review",
        changeId: input.changeId,
        gitAuthority,
      });
    } catch {
      return fullReopen(0, FULL_REOPEN_DEBUG_REASONS.BOUNDED_INPUT_INVALID);
    }
  }

  let phase = FULL_REOPEN_DEBUG_REASONS.UNCLASSIFIED_FAULT;
  try {
    phase = FULL_REOPEN_DEBUG_REASONS.RECEIPT_AUTHORITY_INVALID;
    const chain = walkReceiptAuthorityChain({
      repoRoot: input.repoRoot,
      changeId: input.changeId,
      targetRef: input.previousReceiptRef,
      gitOps,
    });
    previousReceipt = chain.record;
    // D6: derived in the same statement region as `previousReceipt`, and
    // deliberately so. The handback branch below can only reach its override
    // sub-branch while `previousReceipt !== undefined`; were `stallExhausted`
    // ever true with `previousReceipt` still unset, a user's named override
    // would fall silently through to an unconditional handback -- an
    // authorization bug, not a cosmetic one. Setting both from the same walk
    // result makes that state structurally unreachable.
    //
    // The projection covers rounds 1..N-1: the gate decides whether to
    // dispatch the *next* round from the rounds already sealed. A throw here
    // lands in the catch below and becomes `fullReopen`, which is the safe
    // direction -- a chain that cannot be read never silently skips the gate.
    stallExhausted = isReviewStallBudgetExhausted({ rounds: chain.stallProjection });
    const previous = previousReceipt;
    const payload = previous.reviewer_payload;
    count = payload.bounded_rereview_count;
    if (input.previousReceiptRef.path !== receiptFileNameForPayload(input.changeId, payload)) fail("receipt is owned by another change");
    const expectedRound = payload.round_number + 1;
    const initialFullDigest = payload.round_number === 1
      ? input.previousReceiptRef.digest_sha256
      : payload.lineage.initial_full_receipt_digest_sha256;
    phase = FULL_REOPEN_DEBUG_REASONS.UNCLASSIFIED_FAULT;
    if (["new_critical", "out_of_manifest_carrier", "wording_repair_substantive"].includes(input.postDispatchDiscovery)) {
      if (input.observationRecorded !== true) return { route: "record_observation_required", next_bounded_rereview_count: count };
      // A caller-recorded post-dispatch discovery is a mandatory-full
      // reopen. Keep it in the deferred `reopen` slot so it receives the same
      // cap/stall gate as every other dispatchable full reopen; returning a
      // diagnostic-only result here leaves the operator without dispatch
      // authority, while dispatching here would skip that gate.
      reopen = { reason: input.postDispatchDiscovery, roundNumber: expectedRound, initialFullDigest };
    }

    if (reopen === null) {
      const gitLineageChanged = payload.lineage.base_sha !== gitAuthority.base_sha
        || payload.lineage.merge_base_sha !== gitAuthority.merge_base_sha
        || !isAncestor(input.repoRoot, payload.lineage.head_sha, gitAuthority.head_sha, gitOps);
      // R6/D22: both reopen conditions are *recorded* here and dispatched
      // after the catch, below the stall/cap gate. Returning a `route: full`
      // dispatch from inside this try is what let a stalled chain mint a
      // fresh dispatch id -- the gate reads `stallExhausted`, the gate sits
      // after the catch, so an early return jumped straight over it.
      // Deferring the reopen, rather than hoisting the gate up into the try,
      // keeps the gate outside every catch; that matters because a catch
      // converts a fault into `full_reopen_required`, a route without
      // dispatch authority. A gate whose whole job is "do not dispatch" must
      // not be reachable through the fault path it exists to stop.
      const equivalentReanchor = gitLineageChanged
        && resolveRiskShapeDigestAlg(payload.scope.risk_shape_digest_alg) === RISK_SHAPE_DIGEST_ALG_V1
        && riskDigest === payload.scope.risk_shape_digest_sha256
        && equivalentForwardReanchorBase(input.repoRoot, payload.lineage.head_sha, gitAuthority.head_sha, gitAuthority.base_sha, gitOps) === payload.lineage.base_sha;
      if (gitLineageChanged && !equivalentReanchor) {
        reopen = { reason: "git_lineage_changed", roundNumber: expectedRound, initialFullDigest };
      } else {
        const prevAlg = resolveRiskShapeDigestAlg(payload.scope.risk_shape_digest_alg);
        if (prevAlg !== RISK_SHAPE_DIGEST_ALG_V1) {
          // Legacy full-prose receipt vs current behavior-risk-v1: must not silent-equal.
          reopen = { reason: "digest_alg_mismatch", roundNumber: expectedRound, initialFullDigest };
        } else if (riskDigest !== payload.scope.risk_shape_digest_sha256) {
          // Wording-repair exception: below the automatic cap only (count three keeps today's full), not on a
          // stall-exhausted chain (convergence_recovery owns that), and not after a handback-authorized
          // predecessor. Any fault while reading its evidence falls back to the ordinary full reopen.
          let ids = null;
          if (count < 3 && !stallExhausted && !receiptWasHandbackAuthorized(payload, input.changeId)) {
            try {
              ids = wordingRepairFromEvidence({ repoRoot: input.repoRoot, changeId: input.changeId, previousPayload: payload, candidateHead: gitAuthority.head_sha, gitOps });
            } catch {
              ids = null;
            }
          }
          if (ids === null) reopen = { reason: "risk_shape_changed", roundNumber: expectedRound, initialFullDigest };
          else wordingRepairIds = ids;
        }
      }
    }

    // A stall-exhausted chain whose only reopen is risk_shape_changed stays on
    // bounded convergence_recovery below, so it must clear the same bounded
    // eligibility as a reopen-free round: lineage is unchanged, so this
    // round's manifests are current, not expected-stale. A handback request
    // never becomes that recovery, so it keeps the reopen-only path.
    const staysBoundedRecovery = () => stallExhausted && reopen?.reason === "risk_shape_changed"
      && (input.handbackCause === undefined || input.handbackCause === null);

    // fix-validator-touching-bounded-escape D2: Prefer-A / Else-B after lineage
    // and risk reopen recording, before the mandatory manifest loop.
    if ((reopen === null || staysBoundedRecovery())
      && validatorTrustSurfaceTouched(input.repoRoot, payload.lineage.base_sha, gitAuthority.head_sha)) {
      const touchingGate = classifyValidatorTouchingManifestGate({
        input,
        changeId: input.changeId,
        expectedRound,
        payload,
        headSha: gitAuthority.head_sha,
        baseSha: gitAuthority.base_sha,
        gitOps,
      });
      if (touchingGate.action === "else_b") {
        // F-fvte-r1-04 / D2: run predecessor + optional content-comparison
        // structural checks before Else-B reopen so they cannot be masked.
        const elseBStructural = verifyPredecessorAndOptionalContentComparison({
          input,
          previous,
          payload,
          expectedRound,
          count,
          gitOps,
          setPhase: (next) => { phase = next; },
        });
        if (elseBStructural !== null) return elseBStructural;
        reopen = { reason: "validator_trust_surface_changed", roundNumber: expectedRound, initialFullDigest };
      } else if (touchingGate.action === "structural") {
        phase = touchingGate.phase;
        return fullReopen(count, phase);
      }
      // prefer_a: leave reopen null and fall through to the existing loop.
    }

    // Everything below verifies manifests that are bound to the *previous*
    // payload's lineage, so a reopen makes them expected-stale rather than
    // defective. Skipping them here reproduces the short-circuit the two
    // early returns used to provide, byte for byte. The one exception is a
    // stalled mere risk_shape_changed (fix-merge-gate-regression-currency D15;
    // staysBoundedRecovery above): the lineage is unchanged, so the manifests
    // are still current, and the recovery dispatch must meet the same
    // eligibility as any other bounded dispatch. An explicit handbackCause
    // never reaches that recovery, so it keeps skipping the bounded manifests.
    if (reopen === null || staysBoundedRecovery()) {
      const loaded = [];
      phase = FULL_REOPEN_DEBUG_REASONS.MANIFEST_VERIFICATION_FAILED;
      for (const [ref, purpose] of [
        [input.repairDeltaManifestRef, "repair-delta"],
        [input.dependencyClosureManifestRef, "dependency-closure"],
      ]) {
        phase = (ref === null || ref === undefined)
          ? FULL_REOPEN_DEBUG_REASONS.MANIFEST_REFS_ABSENT
          : FULL_REOPEN_DEBUG_REASONS.MANIFEST_VERIFICATION_FAILED;
        if (!refOwnedByChange(ref, input.changeId, manifestFileName(input.changeId, purpose, expectedRound))) fail("manifest ref has cross-change or stale ownership");
        const manifest = readEvidenceRef({
          repoRoot: input.repoRoot,
          ref,
          label: `${purpose} manifest ref`,
          validateRecord: validateManifestRecord,
          gitOps,
        }).record;
        validateManifestFilesAndTrust(manifest, {
          repoRoot: input.repoRoot,
          verificationMode: "current",
          gitOps,
        });
        if (manifest.purpose !== purpose
          || manifest.result !== "pass"
          || manifest.exceptions.length > 0
          || manifest.errors.length > 0
          || manifest.lineage.change_base_sha !== gitAuthority.base_sha
          || manifest.lineage.surface_base_sha !== payload.lineage.head_sha
          || manifest.lineage.candidate_head_sha !== currentHead(input.repoRoot)) fail("manifest is not bounded eligible");
        loaded.push(manifest);
      }
      if (hasDirectedCycle(loaded[1])) fail("dependency closure contains a cycle");

      const structuralRoute = verifyPredecessorAndOptionalContentComparison({
        input,
        previous,
        payload,
        expectedRound,
        count,
        gitOps,
        setPhase: (next) => { phase = next; },
      });
      if (structuralRoute !== null) return structuralRoute;
    }
  } catch {
    return fullReopen(count, phase);
  }
  if ((count >= 3 && reopen === null) || (stallExhausted && !stallYieldsToMandatoryFullReopen(reopen))) {
    // Cap and convergent stall share this gate. Mere risk_shape_changed while
    // stalled stays here (recovery). Other pending reopen reasons fall through
    // to the full reopen dispatch below (F1). True stop-loss handback requires
    // an explicit handbackCause; override remains the narrow bridge off that
    // durable handback only (D1/D3).
    const handbackCause = input.handbackCause === undefined ? null : input.handbackCause;
    if (handbackCause !== null && !HANDBACK_CAUSES.has(handbackCause)) {
      fail("handbackCause must be requirement_conflict | irreversible_high_risk | reviewer_unrecoverable");
    }
    if (handbackCause !== null) {
      if (input.overrideId !== undefined && input.overrideId !== null && previousReceipt !== undefined) {
        const authorized = previousReceipt.reviewer_payload;
        if (reopen === null) {
          return dispatchResult({
            route: "bounded",
            count: count + 1,
            roundNumber: authorized.round_number + 1,
            riskDigest,
            reason: "handback_authorized_bounded",
            changeId: input.changeId,
            gitAuthority,
            previousReceiptRef: input.previousReceiptRef,
            initialFullDigest: authorized.round_number === 1
              ? input.previousReceiptRef.digest_sha256
              : authorized.lineage.initial_full_receipt_digest_sha256,
            repairManifestRef: input.repairDeltaManifestRef,
            closureManifestRef: input.dependencyClosureManifestRef,
          });
        }
        return dispatchResult({
          route: "full",
          count,
          roundNumber: authorized.round_number + 1,
          riskDigest,
          reason: "handback_authorized_full",
          changeId: input.changeId,
          gitAuthority,
          previousReceiptRef: input.previousReceiptRef,
          initialFullDigest: authorized.round_number === 1
            ? input.previousReceiptRef.digest_sha256
            : authorized.lineage.initial_full_receipt_digest_sha256,
        });
      }
      return {
        route: "handback_required",
        dispatch_ready: false,
        next_bounded_rereview_count: count,
        round_number: null,
        risk_shape_digest_sha256: riskDigest,
        risk_shape_digest_alg: RISK_SHAPE_DIGEST_ALG_V1,
        dispatch_id: null,
        full_reopen_reason: null,
      };
    }
    // Convergent recovery. A second recovery while the stall/cap gate still
    // holds requires per-id dispositions bound to the previous recovery
    // dispatch; otherwise stop with recovery_disposition_required (not handback).
    // F2: a unfinished handback_authorized_* predecessor must not mint
    // convergence_recovery (seal would reject that exemption) — return
    // handback_required so the operator re-supplies handbackCause + override.
    if (previousReceipt !== undefined) {
      const previous = previousReceipt.reviewer_payload;
      if (receiptWasHandbackAuthorized(previous, input.changeId)) {
        return {
          route: "handback_required",
          dispatch_ready: false,
          next_bounded_rereview_count: count,
          round_number: null,
          risk_shape_digest_sha256: riskDigest,
          risk_shape_digest_alg: RISK_SHAPE_DIGEST_ALG_V1,
          dispatch_id: null,
          full_reopen_reason: null,
        };
      }
      if (receiptWasConvergenceRecovery(previous, input.changeId)
        && !hasRecoveryDispositionsForOpenBlocking(input, previous)) {
        return {
          route: "recovery_disposition_required",
          dispatch_ready: false,
          next_bounded_rereview_count: count,
          round_number: null,
          risk_shape_digest_sha256: riskDigest,
          risk_shape_digest_alg: RISK_SHAPE_DIGEST_ALG_V1,
          dispatch_id: null,
          full_reopen_reason: null,
        };
      }
      return dispatchResult({
        route: "bounded",
        count: count + 1,
        roundNumber: previous.round_number + 1,
        riskDigest,
        reason: "convergence_recovery",
        changeId: input.changeId,
        gitAuthority,
        previousReceiptRef: input.previousReceiptRef,
        initialFullDigest: previous.round_number === 1
          ? input.previousReceiptRef.digest_sha256
          : previous.lineage.initial_full_receipt_digest_sha256,
        repairManifestRef: input.repairDeltaManifestRef,
        closureManifestRef: input.dependencyClosureManifestRef,
      });
    }
    return {
      route: "handback_required",
      dispatch_ready: false,
      next_bounded_rereview_count: count,
      round_number: null,
      risk_shape_digest_sha256: riskDigest,
      risk_shape_digest_alg: RISK_SHAPE_DIGEST_ALG_V1,
      dispatch_id: null,
      full_reopen_reason: null,
    };
  }
  if (reopen !== null) {
    return dispatchResult({
      route: "full",
      count,
      roundNumber: reopen.roundNumber,
      riskDigest,
      reason: reopen.reason,
      changeId: input.changeId,
      gitAuthority,
      previousReceiptRef: input.previousReceiptRef,
      initialFullDigest: reopen.initialFullDigest,
    });
  }
  if (previousReceipt === undefined) return fullReopen(count, FULL_REOPEN_DEBUG_REASONS.UNCLASSIFIED_FAULT);
  const previous = previousReceipt.reviewer_payload;
  const bounded = dispatchResult({
    route: "bounded",
    count: count + 1,
    roundNumber: previous.round_number + 1,
    riskDigest,
    reason: wordingRepairIds === null ? null : "wording_repair_bounded",
    changeId: input.changeId,
    gitAuthority,
    previousReceiptRef: input.previousReceiptRef,
    initialFullDigest: previous.round_number === 1
      ? input.previousReceiptRef.digest_sha256
      : previous.lineage.initial_full_receipt_digest_sha256,
    repairManifestRef: input.repairDeltaManifestRef,
    closureManifestRef: input.dependencyClosureManifestRef,
  });
  // The classifier result keeps its exact eight-field contract: full_reopen_reason names the wording-repair
  // grant; the authorizing findings are the predecessor round's new fix-now Suggestions, which the TL hands to
  // the reviewer, who escalates with postDispatchDiscovery=wording_repair_substantive when the repair is more
  // than wording.
  return bounded;
}

function classifyFinalReadiness(input, gitOps) {
  let effective;
  try {
    assertChangeId(input.changeId);
    // Best-effort binding-root resolution (design D7.2): a resolvable
    // `.worktree/<changeId>` redirects the read; a fault keeps the historical
    // caller-root behavior instead of turning this classifier into a thrower.
    // The caller's input object stays untouched.
    effective = resolveConsumerBindingOrCaller({ repoRoot: input.repoRoot, changeId: input.changeId });
    latestReceipt({ repoRoot: effective.repoRoot, changeId: effective.changeId, gitOps });
  } catch {
    return {
      final_ready: false,
      review_lineage_valid: false,
      review_coverage_valid: false,
      review_coverage_mode: null,
      route: "full_reopen_required",
    };
  }
  let snapshot;
  try {
    snapshot = coverageSnapshot({ repoRoot: effective.repoRoot, changeId: effective.changeId, gitOps, sealTransition: false });
  } catch (error) {
    // `full_reopen_debug_reason` is the same diagnosis-only field classify-bounded carries. Present only when the
    // tree is a Git-equivalent archive transition whose sealed record does not exist yet: that is the `seal-final`
    // step, not a reason to reopen the six axes. Every other cause keeps the bare shape.
    return {
      final_ready: false,
      review_lineage_valid: true,
      review_coverage_valid: false,
      review_coverage_mode: null,
      route: "full_reopen_required",
      ...(error?.[ARCHIVE_TRANSITION_UNSEALED] === true ? { full_reopen_debug_reason: "archive_transition_unsealed" } : {}),
      ...(Array.isArray(error?.[RECEIPT_NOT_CONVERGED])
        ? { full_reopen_debug_reason: "latest_receipt_not_converged", open_finding_ids: error[RECEIPT_NOT_CONVERGED] }
        : {}),
      ...(error?.[RECEIPT_UNRESOLVED_ASSESSMENTS]?.length > 0
        ? { unresolved_assessment_ids: error[RECEIPT_UNRESOLVED_ASSESSMENTS] }
        : {}),
    };
  }
  const covered = (finalReady, route) => ({
    final_ready: finalReady,
    review_lineage_valid: true,
    review_coverage_valid: true,
    review_coverage_mode: snapshot.reviewCoverage.mode,
    route,
  });
  try {
    assertWholeTreeClean(effective.repoRoot);
  } catch {
    return covered(false, "not_final_ready");
  }
  const notesRoot = derivedNotesRoot(effective.repoRoot, gitOps);
  const targetPath = path.join(notesRoot, finalFileName(effective.changeId, snapshot.headSha));
  let candidate;
  try {
    candidate = parseCanonicalJsonV1(readFileSync(targetPath));
  } catch {
    return covered(false, "not_final_ready");
  }
  const candidateCoverage = candidate?.payload?.review_coverage;
  if (candidateCoverage !== undefined
    && canonicalJsonV1(candidateCoverage) !== canonicalJsonV1(snapshot.reviewCoverage)) {
    return {
      final_ready: false,
      review_lineage_valid: true,
      review_coverage_valid: false,
      review_coverage_mode: null,
      route: "full_reopen_required",
    };
  }
  try {
    validateFinalRecord(candidate);
  } catch {
    return covered(false, "not_final_ready");
  }
  try {
    verifyFinalEvidenceRecord({ ...input, repoRoot: effective.repoRoot, changeId: effective.changeId, gitOps });
    return covered(true, "final_ready");
  } catch {
    return covered(false, "not_final_ready");
  }
}

export function createReviewRemediationEvidenceCore(dependencies = {}) {
  assertObject(dependencies, "core dependencies");
  const allowed = ["fsOps", "gitOps", "spawnSyncImpl", "platform"];
  const unknown = Object.keys(dependencies).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`unknown core dependencies: ${unknown.join(", ")}`);
  const injectedFsOps = dependencies.fsOps;
  const injectedGitOps = dependencies.gitOps;
  if (injectedGitOps !== undefined) assertGitOps(injectedGitOps);
  const injectedSpawnSyncImpl = dependencies.spawnSyncImpl;
  const injectedPlatform = dependencies.platform;
  if (injectedPlatform !== undefined) assertString(injectedPlatform, "core platform");
  return Object.freeze({
    RECEIPT_SCAN_MAX_BYTES,
    REVIEW_RECEIPT_SCHEMA,
    REVIEW_RECEIPT_SCHEMA_V1,
    REVIEW_RECEIPT_SCHEMA_V2,
    receiptExecutorAttribution,
    REVIEW_MANIFEST_SCHEMA,
    FINAL_EVIDENCE_SCHEMA,
    canonicalJsonV1,
    parseCanonicalJsonV1,
    parseRequestJson,
    assertSafeRepoRelativePath,
    refOwnedByChange,
    predecessorCarryForwardProblem,
    isClosedHistoricalPostHocReceipt,
    unresolvedAssessmentIds,
    captureReviewerOutput: (input) => captureReviewerOutput({
      ...input,
      fsOps: injectedFsOps,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    buildReviewRoundReceiptRequest: (input) => buildReviewRoundReceiptRequest({
      ...input,
      fsOps: injectedFsOps,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    preparePostHocAttestation: (input) => preparePostHocAttestation({
      ...input,
      fsOps: injectedFsOps,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    recordPostHocAuthorization: (input) => recordPostHocAuthorization({ ...input, fsOps: injectedFsOps }),
    sealPostHocAttestation: (input) => sealPostHocAttestation({ ...input, fsOps: injectedFsOps }),
    verifyPostHocAttestation: (input) => verifyPostHocAttestation({ ...input, fsOps: injectedFsOps }),
    sealReviewRoundReceipt: (input) => sealReviewRoundReceipt({
      ...input,
      fsOps: injectedFsOps,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    verifyReviewRoundReceipt: (input) => verifyReviewRoundReceipt({
      ...input,
      fsOps: injectedFsOps,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    sealCrossCarrierClosure: (input) => sealCrossCarrierClosure({
      ...input,
      fsOps: injectedFsOps,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    verifyCrossCarrierClosure: (input) => verifyCrossCarrierClosure({
      ...input,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    verifyCurrentCrossCarrierClosure: (input) => verifyCurrentCrossCarrierClosure({
      ...input,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    sealReviewManifest: (input) => sealReviewManifest({
      ...input,
      fsOps: injectedFsOps,
      spawnSyncImpl: injectedSpawnSyncImpl,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    verifyReviewManifest: (input) => verifyReviewManifest({
      ...input,
      spawnSyncImpl: injectedSpawnSyncImpl,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    sealFinalEvidenceRecord: (input) => sealFinalEvidenceRecord({
      ...input,
      fsOps: injectedFsOps,
      gitOps: createOperationGitOps(injectedGitOps),
      spawnSyncImpl: injectedSpawnSyncImpl,
      platform: injectedPlatform,
    }),
    verifyFinalEvidenceRecord: (input) => verifyFinalEvidenceRecord({
      ...input,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    verifyHeadBoundFinalEvidence: (input) => verifyHeadBoundFinalEvidence({
      ...input,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    classifyBoundedRereview: (input) => classifyBoundedRereview(
      input,
      injectedFsOps,
      createOperationGitOps(injectedGitOps),
    ),
    classifyFinalReadiness: (input) => classifyFinalReadiness(
      input,
      createOperationGitOps(injectedGitOps),
    ),
    classifyTipMoveWhitelist: (input) => classifyTipMoveWhitelist({
      ...input,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    deriveHistoricalRiskShapeDigest: (input) => deriveHistoricalRiskShapeDigest({
      ...input,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
    queryReviewStallState: (input) => queryReviewStallState({
      ...input,
      fsOps: injectedFsOps,
      gitOps: createOperationGitOps(injectedGitOps),
    }),
  });
}
