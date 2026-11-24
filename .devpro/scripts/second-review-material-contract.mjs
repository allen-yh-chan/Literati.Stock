import { reviewGithubSpawnSync as spawnSync } from "./lib/second-review-github-transport.mjs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isStrictPlainObject as isPlainObject, sha256Hex as sha256Utf8 } from "./lib/primitives.mjs";

export const SECOND_REVIEW_AUDIT_SCHEMA_VERSION = "devpro-second-review-data/v3";
export const SECOND_REVIEW_PR_SCHEMA_VERSION = "devpro-second-review-data/v4";
export const SECOND_REVIEW_PAGED_PR_SCHEMA_VERSION = "devpro-second-review-data/v5";
export const SECOND_REVIEW_PAGED_MANIFEST_SCHEMA = "devpro-second-review-page-manifest/v1";
export const SECOND_REVIEW_EMBEDDED_MAX_BYTES = 262_144;
/**
 * Shared changed-path ceiling for packet validation and live-read recipes.
 * Complete large PRs (including the 542-path workflow change) need more than
 * 500 paths; keep one bounded 1000-path limit across every review carrier.
 * Overflow still fails closed without truncating the declared changed set.
 */
export const SECOND_REVIEW_CHANGED_PATHS_MAX = 1000;
export const SECOND_REVIEW_PAGE_MAX_BYTES = 32_768;
/** Shared verdict `reason` UTF-8 byte ceiling (packet guidance + completion parsers). */
export const SECOND_REVIEW_VERDICT_REASON_MAX_BYTES = 8_192;
/** Shared `evidence[].narrative` UTF-8 byte ceiling (handoff primary evidence fields). */
export const SECOND_REVIEW_EVIDENCE_NARRATIVE_MAX_BYTES = 8_192;
export const SECOND_REVIEW_FINDING_SUMMARY_MAX_BYTES = 4_096;

export const SECOND_REVIEW_V4_TOP_LEVEL_KEYS = Object.freeze([
  "schema_version",
  "mode",
  "attempt",
  "dispatch_id",
  "previous_dispatch_id",
  "primary_family",
  "reviewer_family",
  "target",
  "head_ref_oid",
  "approval_context",
  "approval_resolution",
  "review_scope",
  "scope_summary",
  "changed_files_or_touch_list",
  "review_material_carrier",
  "review_material_capability",
  "review_material_proof",
  "review_material",
  "previous_sticky",
  "retry_context",
  "linked_issue_context",
  "primary_verdict",
  "evidence",
]);
/** Optional trailing top-level keys after the exact v4/v5 required prefix (D3). */
export const SECOND_REVIEW_OPTIONAL_TOP_LEVEL_KEYS = Object.freeze([
  "github_transport",
  "done_when",
  "reviewer_constraints",
]);
export const SECOND_REVIEW_V5_TOP_LEVEL_KEYS = SECOND_REVIEW_V4_TOP_LEVEL_KEYS;

export const FULL_PR_SCOPE_KEYS = Object.freeze([
  "kind",
  "pull_request_number",
  "head_sha",
]);
export const COMMIT_RANGE_SCOPE_KEYS = Object.freeze([
  "kind",
  "base_sha",
  "head_sha",
]);
export const EMBEDDED_PROOF_KEYS = Object.freeze([
  "kind",
  "scope_fingerprint_sha256",
  "material_format",
  "material_utf8_bytes",
  "material_sha256",
]);
export const ADAPTER_ROUTE_PROOF_KEYS = Object.freeze([
  "kind",
  "scope_fingerprint_sha256",
  "route_id",
]);
export const PAGED_PROOF_KEYS = Object.freeze([
  "kind",
  "scope_fingerprint_sha256",
  "manifest_sha256",
]);
export const PAGED_REVIEW_MATERIAL_KEYS = Object.freeze([
  "manifest",
  "pages",
  "checkpoint_ledger",
  "findings_ledger",
  "window_role",
]);
export const PAGED_MANIFEST_KEYS = Object.freeze([
  "schema",
  "page_count",
  "max_page_utf8_bytes",
  "total_utf8_bytes",
  "aggregate_sha256",
  "scope_fingerprint_sha256",
  "head_sha",
  "changed_paths_sha256",
  "pages",
]);
export const PAGED_MANIFEST_PAGE_KEYS = Object.freeze(["index", "utf8_bytes", "sha256"]);
export const PAGED_DATA_PAGE_KEYS = Object.freeze(["index", "content"]);
export const SECOND_REVIEW_CHECKPOINT_LEDGER_SCHEMA = "devpro-second-review-checkpoint-ledger/v1";
export const SECOND_REVIEW_FINDINGS_LEDGER_SCHEMA = "devpro-second-review-findings-ledger/v1";
export const CHECKPOINT_LEDGER_KEYS = Object.freeze([
  "schema",
  "covered_indices",
  "page_bindings",
  "ledger_sha256",
]);
export const CHECKPOINT_PAGE_BINDING_KEYS = Object.freeze(["index", "sha256"]);
export const FINDINGS_LEDGER_KEYS = Object.freeze(["schema", "windows", "ledger_sha256"]);
export const FINDINGS_LEDGER_WINDOW_KEYS = Object.freeze([
  "window_index",
  "page_indices",
  "window_verdict",
  "findings",
  "entry_sha256",
]);
export const FINDING_ITEM_KEYS = Object.freeze(["severity", "summary_id", "summary"]);
export const WINDOW_ROLES = Object.freeze(["intermediate", "final"]);
export const WINDOW_VERDICTS = Object.freeze(["PASS", "WARN", "CRITICAL", "UNAVAILABLE"]);
export const FINDING_SEVERITIES = Object.freeze(["PASS", "WARN", "CRITICAL", "INFO"]);
export const PAGE_WINDOW_FINDING_SEVERITY_ALIASES = Object.freeze({ IMPORTANT: "WARN" });

export function canonicalPageWindowFindingSeverity(raw) {
  return Object.hasOwn(PAGE_WINDOW_FINDING_SEVERITY_ALIASES, raw)
    ? PAGE_WINDOW_FINDING_SEVERITY_ALIASES[raw]
    : raw;
}

// Conservative default: one page per window. Raising requires Ask First.
export const SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES = 1;
// D9: the highest windowMaxPages callers may declare per dispatch (1..4). The default
// above is unchanged; this only bounds explicit per-dispatch overrides (T7 wiring).
export const SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES_CEILING = 4;

// D9 (R10, R13): resolve a dispatch's declared page_window_max_pages (v5 dispatch/context
// state) to the concrete window size every windowMaxPages callsite must use explicitly.
// An absent/undeclared/out-of-range candidate resolves to the unchanged default 1 — this
// is the single seam every renderer/validator/runner callsite reads through so "undeclared"
// always means the same thing everywhere.
export function resolveDeclaredPageWindowMaxPages(candidate) {
  return Number.isSafeInteger(candidate)
    && candidate >= 1
    && candidate <= SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES_CEILING
    ? candidate
    : SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES;
}
export const PAGE_WINDOW_COMPLETION_KEYS = Object.freeze([
  "sticky_comment_url",
  "verdict",
  "last_reviewed_sha",
  "reviewer_model",
  "reason",
  "window_index",
  "page_indices",
  "head_ref_oid",
  "dispatch_id",
  "findings",
  "findings_payload_sha256",
]);
export const STICKY_FACING_COMPLETION_KEYS = Object.freeze([
  "sticky_comment_url",
  "verdict",
  "last_reviewed_sha",
  "reviewer_model",
  "reason",
]);
export const PAGED_FULL_PAGES_CARRIER_BASENAME = "paged-review-material-full.json";
export const PAGED_FULL_PAGES_CARRIER_SCHEMA = "devpro-second-review-paged-full-pages/v2";
export const SECOND_REVIEW_PRIVATE_CARRIER_MAX_BYTES = (2_097_152 * 6) + (256 * 1024);
export const PAGED_FULL_PAGES_CARRIER_KEYS = Object.freeze([
  "schema",
  "dispatch_id",
  "head_ref_oid",
  "scope_fingerprint_sha256",
  "carrier_root_id",
  "changed_set_authority",
  "changed_paths_sha256",
  "manifest_sha256",
  "created_at",
  "expires_at",
  "pages",
]);
export const PAGED_FULL_PAGES_AUTHORITY_KEYS = Object.freeze([
  "kind",
  "comparison_base_sha",
  "head_sha",
  "path_count",
  "paths_sha256",
]);
export const PAGED_FULL_PAGES_PAGE_KEYS = Object.freeze([
  "index",
  "utf8_bytes",
  "sha256",
  "content",
]);

const installedRendererScriptPath = realpathSync(fileURLToPath(
  new URL("./render-second-review-packet.mjs", import.meta.url),
));
export const SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT = realpathSync(
  path.resolve(path.dirname(installedRendererScriptPath), "../.."),
);
export const SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS = 10_000;
export const SECOND_REVIEW_GH_PROBE_TIMEOUT_MS = 15_000;
export const SECOND_REVIEW_GIT_RENAME_COPY_FLAGS = Object.freeze([
  "--find-renames",
  "--find-copies-harder",
]);
export const SECOND_REVIEW_GIT_RAW_DIFF_FLAGS = Object.freeze([
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--binary",
  "--full-index",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--unified=3",
  "--diff-algorithm=myers",
  "--no-indent-heuristic",
  "--submodule=short",
  ...SECOND_REVIEW_GIT_RENAME_COPY_FLAGS,
]);
const SECOND_REVIEW_AUTHORITATIVE_RAW_DIFF_MAX_BYTES = 2_097_152;

export const REVIEW_SCOPE_KINDS = Object.freeze([
  "full-pr",
  "commit-range",
]);
// `linked_issue_context` 是 mode token 而非 content 欄位：它只決定 reviewer 是否取得
// `Bash(node <absolute-linked-issue-reader> <validated-repository-slug>:*)`，issue 內容由 reviewer 自行讀取。route SSOT 為
// openspec/specs/cross-runtime-parity/spec.md → Requirement: External Reviewer Linked Issue Route。
// 本常數是該 token 集合在 runtime 的唯一定義點——packet validator 與 CLI recipe contract
// 皆由此 import；不得在任一 consumer 另抄一份字面值。
export const LINKED_ISSUE_CONTEXTS = Object.freeze([
  "none",
  "issue_read_required",
]);
export const REVIEW_MATERIAL_CARRIERS = Object.freeze([
  "embedded-diff",
  "adapter-live-pr-reads",
  "renderer-paged-snapshot",
  "external-live-reads",
]);
export const REVIEW_MATERIAL_CAPABILITIES = Object.freeze([
  "scope-bound-embedded-complete-diff-v1",
  "full-pr-bounded-live-reads-v1",
  "commit-range-exact-compare-v1",
  "scope-bound-renderer-paged-complete-diff-v1",
]);
export const REVIEW_MATERIAL_PROOF_KINDS = Object.freeze([
  "embedded-complete-diff-v1",
  "adapter-route-required-v1",
  "renderer-paged-complete-diff-v1",
]);
export const REVIEW_SCOPE_ROUTE_IDS = Object.freeze([
  "gh-pr-bounded-live-v1",
  "gh-api-exact-compare-v1",
]);

// Reviewer families dispatched through `codex exec --json`, whose command_execution
// telemetry embeds the complete per-command STDOUT on a single line. Pairing such a
// reviewer with a live-read carrier makes it fetch the full diff at runtime; a large
// single fetch overflows the runner's 64 KiB complete-line safety bound
// (run-second-reviewer-projection.mjs) -> terminal reviewer_output_line_overflow with no
// verdict and no sticky write. These reviewers MUST receive the wrapper-embedded diff so
// they read from the packet with zero live read. Claude reviewers stream small stream-json
// events per line and stay valid on the live-read carrier (issue #1728).
const canonicalReviewerFamilies = Object.freeze({
  claude: Object.freeze({
    token: "claude",
    cli_family: "claude",
    tool: "Claude Code",
    embeds_complete_output_per_line: false,
  }),
  codex: Object.freeze({
    token: "codex",
    cli_family: "codex",
    tool: "Codex",
    embeds_complete_output_per_line: true,
  }),
  "openai-codex": Object.freeze({
    token: "openai-codex",
    cli_family: "codex",
    tool: "Codex",
    embeds_complete_output_per_line: true,
  }),
  // Verified DeepSeek identity, reachable only through the OpenCode CLI (the provider
  // map in lib/opencode-reviewer.mjs is the single place a provider earns a family).
  // OpenCode `--format json` events embed whole tool outputs per line, so like Codex this
  // family MUST receive the wrapper-embedded diff instead of live reads.
  deepseek: Object.freeze({
    token: "deepseek",
    cli_family: "opencode",
    tool: "OpenCode",
    embeds_complete_output_per_line: true,
  }),
  // D2: external-evaluator-only — no runner CLI recipe exists for this family.
  // `cli_family: "external"` is deliberately not "claude" or "codex" so a runner
  // handoff declaring `gemini` cannot be mistaken for either recipe branch; D1/D7
  // typed-reject any runner-context dispatch before a CLI recipe would be selected.
  gemini: Object.freeze({
    token: "gemini",
    cli_family: "external",
    tool: "Gemini CLI",
    embeds_complete_output_per_line: false,
  }),
});

export const CANONICAL_REVIEWER_FAMILY_TOKENS = Object.freeze(
  Object.keys(canonicalReviewerFamilies),
);

// D2: reviewer_family -> model-provider group, used to prove cross-family review
// (REVIEWER_FAMILY_GROUPS[reviewer] !== REVIEWER_FAMILY_GROUPS[primary]). No "other":
// an unresolvable primary_family is `cross_model_family_unprovable`, fail closed.
export const REVIEWER_FAMILY_GROUPS = Object.freeze({
  claude: "anthropic",
  codex: "openai",
  "openai-codex": "openai",
  gemini: "google",
  deepseek: "deepseek",
});

export class ReviewerFamilyContractError extends Error {
  constructor() {
    super(`reviewer_family must be exactly ${CANONICAL_REVIEWER_FAMILY_TOKENS.join(", ")}`);
    this.name = "ReviewerFamilyContractError";
    this.classification = "reviewer_family_invalid";
  }
}

export function resolveCanonicalReviewerFamily(reviewerFamily) {
  if (typeof reviewerFamily !== "string"
    || !Object.hasOwn(canonicalReviewerFamilies, reviewerFamily)) {
    throw new ReviewerFamilyContractError();
  }
  return canonicalReviewerFamilies[reviewerFamily];
}

// The reviewer CLI is a separate axis from the reviewer family (plan r5 §3): the family
// answers "which model group reviews", the CLI answers "which executable runs it". Omission
// keeps the legacy resolver (the family's own CLI); an explicit value must be a CLI that is
// verified to execute that family, never a free pairing. `external` families have no CLI.
export const CANONICAL_REVIEWER_CLIS = Object.freeze(["claude", "codex", "opencode"]);

export class ReviewerCliContractError extends Error {
  constructor(message, classification = "reviewer_cli_invalid") {
    super(message);
    this.name = "ReviewerCliContractError";
    this.classification = classification;
  }
}

export function resolveReviewerCli(reviewerFamily, reviewerCli) {
  const descriptor = resolveCanonicalReviewerFamily(reviewerFamily);
  if (reviewerCli === undefined) return descriptor.cli_family;
  if (typeof reviewerCli !== "string" || !CANONICAL_REVIEWER_CLIS.includes(reviewerCli)) {
    throw new ReviewerCliContractError(
      `reviewer_cli must be exactly ${CANONICAL_REVIEWER_CLIS.join(", ")} when present`
    );
  }
  if (reviewerCli !== descriptor.cli_family) {
    throw new ReviewerCliContractError(
      `reviewer_cli ${reviewerCli} is not a verified executor for reviewer_family ${reviewerFamily}`,
      "reviewer_cli_family_mismatch"
    );
  }
  return reviewerCli;
}

export function reviewerTransportEmbedsCompleteOutputPerLine(reviewerFamily) {
  return resolveCanonicalReviewerFamily(reviewerFamily).embeds_complete_output_per_line;
}

const sha40Pattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/** Required keys as exact ordered prefix; optional keys may trail afterward only. */
function hasExactKeysAllowingOptional(value, requiredKeys, optionalKeys = []) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  if (actual.length < requiredKeys.length) return false;
  if (!requiredKeys.every((key, index) => actual[index] === key)) return false;
  const optionalSet = new Set(optionalKeys);
  return actual.slice(requiredKeys.length).every((key) => optionalSet.has(key));
}

export function canonicalReviewScopeJson(scope) {
  if (!isPlainObject(scope)) {
    throw new TypeError("review_scope must be an exact tagged object");
  }
  const expectedKeys = scope.kind === "full-pr"
    ? FULL_PR_SCOPE_KEYS
    : scope.kind === "commit-range"
      ? COMMIT_RANGE_SCOPE_KEYS
      : null;
  if (expectedKeys === null || !hasExactKeys(scope, expectedKeys)) {
    throw new TypeError("review_scope has unknown, missing, duplicate, or out-of-order fields");
  }
  return JSON.stringify(scope);
}

export function reviewScopeFingerprintSha256(scope) {
  return sha256Utf8(canonicalReviewScopeJson(scope));
}

export function materialSha256(material) {
  if (typeof material !== "string") throw new TypeError("review_material must be a string");
  return sha256Utf8(material);
}

export function changedPathsSha256(changedFiles) {
  if (!Array.isArray(changedFiles)) {
    throw new TypeError("changed_files_or_touch_list must be an array");
  }
  return sha256Utf8(JSON.stringify(changedFiles));
}

export function pageReviewMaterial(reviewMaterial, pageMaxBytes = SECOND_REVIEW_PAGE_MAX_BYTES) {
  if (typeof reviewMaterial !== "string" || reviewMaterial.length === 0) {
    throw new TypeError("review_material must be a non-empty string");
  }
  if (!Number.isSafeInteger(pageMaxBytes) || pageMaxBytes <= 0) {
    throw new TypeError("pageMaxBytes must be a positive safe integer");
  }
  const pages = [];
  let parts = [];
  let pageBytes = 0;
  for (const codePoint of reviewMaterial) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (codePointBytes > pageMaxBytes) {
      throw new TypeError("one Unicode code point exceeds the page UTF-8 byte ceiling");
    }
    if (pageBytes + codePointBytes > pageMaxBytes) {
      pages.push(parts.join(""));
      parts = [];
      pageBytes = 0;
    }
    parts.push(codePoint);
    pageBytes += codePointBytes;
  }
  if (parts.length > 0) pages.push(parts.join(""));
  return pages;
}

function canonicalLedgerSha256(valueWithoutHash) {
  return sha256Utf8(JSON.stringify(valueWithoutHash));
}

export function emptyCheckpointLedger() {
  const withoutHash = {
    schema: SECOND_REVIEW_CHECKPOINT_LEDGER_SCHEMA,
    covered_indices: [],
    page_bindings: [],
  };
  return {
    ...withoutHash,
    ledger_sha256: canonicalLedgerSha256(withoutHash),
  };
}

export function emptyFindingsLedger() {
  const withoutHash = {
    schema: SECOND_REVIEW_FINDINGS_LEDGER_SCHEMA,
    windows: [],
  };
  return {
    ...withoutHash,
    ledger_sha256: canonicalLedgerSha256(withoutHash),
  };
}

export function pageWindowIndices(pageCount, windowIndex, windowMaxPages = SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES) {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) {
    throw new TypeError("pageCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(windowIndex) || windowIndex <= 0) {
    throw new TypeError("windowIndex must be a positive safe integer");
  }
  if (!Number.isSafeInteger(windowMaxPages) || windowMaxPages <= 0) {
    throw new TypeError("windowMaxPages must be a positive safe integer");
  }
  const start = (windowIndex - 1) * windowMaxPages + 1;
  if (start > pageCount) {
    throw new TypeError(`windowIndex ${windowIndex} exceeds page_count ${pageCount}`);
  }
  const end = Math.min(pageCount, start + windowMaxPages - 1);
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

export function pageWindowCount(pageCount, windowMaxPages = SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES) {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) {
    throw new TypeError("pageCount must be a positive safe integer");
  }
  return Math.ceil(pageCount / windowMaxPages);
}

export function requiresPageWindowing(pageCount, windowMaxPages = SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES) {
  return pageWindowCount(pageCount, windowMaxPages) > 1;
}

export function selectActiveWindowPages(fullPages, windowIndex, windowMaxPages = SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES) {
  if (!Array.isArray(fullPages) || fullPages.length === 0) {
    throw new TypeError("fullPages must be a non-empty array");
  }
  const indices = pageWindowIndices(fullPages.length, windowIndex, windowMaxPages);
  return indices.map((index) => {
    const page = fullPages[index - 1];
    if (!hasExactKeys(page, PAGED_DATA_PAGE_KEYS) || page.index !== index) {
      throw new TypeError(`fullPages[${index - 1}] must be exact {index,content} for index ${index}`);
    }
    return { index: page.index, content: page.content };
  });
}

export function framePagedReviewMaterial({
  manifest,
  fullPages,
  checkpointLedger = emptyCheckpointLedger(),
  findingsLedger = emptyFindingsLedger(),
  windowIndex = 1,
  windowMaxPages = SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES,
}) {
  if (!hasExactKeys(manifest, PAGED_MANIFEST_KEYS)) {
    throw new TypeError("manifest must use exact paged manifest keys");
  }
  const totalWindows = pageWindowCount(manifest.page_count, windowMaxPages);
  if (!Number.isSafeInteger(windowIndex) || windowIndex < 1 || windowIndex > totalWindows) {
    throw new TypeError(`windowIndex must be in 1..${totalWindows}`);
  }
  return {
    manifest,
    pages: selectActiveWindowPages(fullPages, windowIndex, windowMaxPages),
    checkpoint_ledger: checkpointLedger,
    findings_ledger: findingsLedger,
    window_role: windowIndex === totalWindows ? "final" : "intermediate",
  };
}

export function findingsPayloadSha256({
  window_index: windowIndex,
  page_indices: pageIndices,
  head_ref_oid: headRefOid,
  dispatch_id: dispatchId,
  findings,
}) {
  return sha256Utf8(JSON.stringify({
    window_index: windowIndex,
    page_indices: pageIndices,
    head_ref_oid: headRefOid,
    dispatch_id: dispatchId,
    findings,
  }));
}

/** Runner-owned seal: overwrite reviewer-supplied digest (opaque / best-effort) with canonical digest. */
export function sealPageWindowCompletionFindingsPayload(completion) {
  if (!isPlainObject(completion)) {
    throw new TypeError("page-window completion seal requires a plain object");
  }
  return {
    ...completion,
    findings_payload_sha256: findingsPayloadSha256({
      window_index: completion.window_index,
      page_indices: completion.page_indices,
      head_ref_oid: completion.head_ref_oid,
      dispatch_id: completion.dispatch_id,
      findings: completion.findings,
    }),
  };
}

export function findingsLedgerEntrySha256(entryWithoutHash) {
  return canonicalLedgerSha256(entryWithoutHash);
}

export function sealCheckpointLedger({ covered_indices: coveredIndices, page_bindings: pageBindings }) {
  const withoutHash = {
    schema: SECOND_REVIEW_CHECKPOINT_LEDGER_SCHEMA,
    covered_indices: coveredIndices,
    page_bindings: pageBindings,
  };
  return {
    ...withoutHash,
    ledger_sha256: canonicalLedgerSha256(withoutHash),
  };
}

export function sealFindingsLedger(windows) {
  const withoutHash = {
    schema: SECOND_REVIEW_FINDINGS_LEDGER_SCHEMA,
    windows,
  };
  return {
    ...withoutHash,
    ledger_sha256: canonicalLedgerSha256(withoutHash),
  };
}

export function appendCheckpointCoverage(ledger, pages, manifest) {
  const covered = new Set(Array.isArray(ledger?.covered_indices) ? ledger.covered_indices : []);
  const bindings = new Map(
    (Array.isArray(ledger?.page_bindings) ? ledger.page_bindings : [])
      .map((binding) => [binding.index, binding.sha256])
  );
  for (const page of pages) {
    const manifestPage = manifest.pages[page.index - 1];
    if (!manifestPage || manifestPage.index !== page.index) {
      throw new TypeError(`manifest missing page index ${page.index}`);
    }
    const digest = materialSha256(page.content);
    if (digest !== manifestPage.sha256) {
      throw new TypeError(`page ${page.index} digest does not match manifest`);
    }
    covered.add(page.index);
    bindings.set(page.index, digest);
  }
  const coveredIndices = [...covered].sort((a, b) => a - b);
  const pageBindings = coveredIndices.map((index) => ({
    index,
    sha256: bindings.get(index),
  }));
  return sealCheckpointLedger({
    covered_indices: coveredIndices,
    page_bindings: pageBindings,
  });
}

/**
 * Union of CRITICAL findings across every recorded page window, in window order.
 * A pr-sticky page-window attempt keeps
 * advancing past CRITICAL windows (see resolveLivePageWindowStickyGate); the projection
 * runner publishes this union on terminal `projection_page_window_live_gate` events
 * (`scan_complete` or `continue_to_next_window === false`) so the TL reads every CRITICAL
 * of an attempt from one place without O(windows²) sidecar growth on intermediate continues.
 * Audit-only material is never paged and never reaches this path.
 */
export function collectCriticalFindings(findingsLedger) {
  const windows = Array.isArray(findingsLedger?.windows) ? findingsLedger.windows : [];
  const union = [];
  for (const window of windows) {
    if (!window || typeof window !== "object") continue;
    const findings = Array.isArray(window.findings) ? window.findings : [];
    let criticalFindingSeen = false;
    for (const finding of findings) {
      if (finding?.severity !== "CRITICAL") continue;
      criticalFindingSeen = true;
      union.push({
        window_index: window.window_index,
        window_verdict: window.window_verdict,
        severity: "CRITICAL",
        summary_id: finding.summary_id,
        summary: finding.summary,
      });
    }
    // A CRITICAL window verdict without a CRITICAL finding is legal reviewer output (explicit
    // scope limitation instead of a structured finding). The live gate and the final
    // aggregation both treat it as blocking, so the union must list the window too.
    if (!criticalFindingSeen && window.window_verdict === "CRITICAL") {
      union.push({
        window_index: window.window_index,
        window_verdict: "CRITICAL",
        severity: "CRITICAL",
        summary_id: null,
        summary: "window verdict CRITICAL without a CRITICAL finding; read the window completion for the reviewer's stated reason",
      });
    }
  }
  return union;
}

export function appendFindingsWindow(ledger, {
  window_index: windowIndex,
  page_indices: pageIndices,
  window_verdict: windowVerdict,
  findings,
}) {
  const priorWindows = Array.isArray(ledger?.windows) ? [...ledger.windows] : [];
  if (priorWindows.some((entry) => entry.window_index === windowIndex)) {
    throw new TypeError(`findings ledger already contains window_index ${windowIndex}`);
  }
  const withoutHash = {
    window_index: windowIndex,
    page_indices: pageIndices,
    window_verdict: windowVerdict,
    findings,
  };
  priorWindows.push({
    ...withoutHash,
    entry_sha256: findingsLedgerEntrySha256(withoutHash),
  });
  priorWindows.sort((a, b) => a.window_index - b.window_index);
  return sealFindingsLedger(priorWindows);
}

function validateCheckpointLedgerShape(ledger, errors, label = "checkpoint_ledger") {
  if (!hasExactKeys(ledger, CHECKPOINT_LEDGER_KEYS)) {
    errors.push(`${label} has unknown, missing, duplicate, or out-of-order fields`);
    return false;
  }
  if (ledger.schema !== SECOND_REVIEW_CHECKPOINT_LEDGER_SCHEMA) {
    errors.push(`${label}.schema must equal ${SECOND_REVIEW_CHECKPOINT_LEDGER_SCHEMA}`);
  }
  if (!Array.isArray(ledger.covered_indices) || !Array.isArray(ledger.page_bindings)) {
    errors.push(`${label} covered_indices and page_bindings must be arrays`);
    return false;
  }
  if (ledger.covered_indices.length !== ledger.page_bindings.length) {
    errors.push(`${label} covered_indices length must equal page_bindings length`);
  }
  for (let offset = 0; offset < ledger.page_bindings.length; offset += 1) {
    const binding = ledger.page_bindings[offset];
    if (!hasExactKeys(binding, CHECKPOINT_PAGE_BINDING_KEYS)) {
      errors.push(`${label}.page_bindings[${offset}] has unknown, missing, duplicate, or out-of-order fields`);
      continue;
    }
    if (binding.index !== ledger.covered_indices[offset]) {
      errors.push(`${label}.page_bindings[${offset}].index must equal covered_indices[${offset}]`);
    }
    if (!digestPattern.test(binding.sha256)) {
      errors.push(`${label}.page_bindings[${offset}].sha256 must be lowercase 64-hex`);
    }
  }
  const expected = sealCheckpointLedger({
    covered_indices: ledger.covered_indices,
    page_bindings: ledger.page_bindings,
  });
  if (ledger.ledger_sha256 !== expected.ledger_sha256) {
    errors.push(`${label}.ledger_sha256 must bind the canonical ledger JSON`);
    return false;
  }
  return errors.length === 0;
}

function validateFindingsLedgerShape(ledger, errors, label = "findings_ledger") {
  if (!hasExactKeys(ledger, FINDINGS_LEDGER_KEYS)) {
    errors.push(`${label} has unknown, missing, duplicate, or out-of-order fields`);
    return false;
  }
  if (ledger.schema !== SECOND_REVIEW_FINDINGS_LEDGER_SCHEMA) {
    errors.push(`${label}.schema must equal ${SECOND_REVIEW_FINDINGS_LEDGER_SCHEMA}`);
  }
  if (!Array.isArray(ledger.windows)) {
    errors.push(`${label}.windows must be an array`);
    return false;
  }
  for (let offset = 0; offset < ledger.windows.length; offset += 1) {
    const entry = ledger.windows[offset];
    if (!hasExactKeys(entry, FINDINGS_LEDGER_WINDOW_KEYS)) {
      errors.push(`${label}.windows[${offset}] has unknown, missing, duplicate, or out-of-order fields`);
      continue;
    }
    if (!Number.isSafeInteger(entry.window_index) || entry.window_index <= 0) {
      errors.push(`${label}.windows[${offset}].window_index must be a positive safe integer`);
    }
    if (offset > 0 && entry.window_index <= ledger.windows[offset - 1].window_index) {
      errors.push(`${label}.windows must be strictly increasing by window_index`);
    }
    if (!Array.isArray(entry.page_indices) || entry.page_indices.length === 0) {
      errors.push(`${label}.windows[${offset}].page_indices must be a non-empty array`);
    }
    if (!WINDOW_VERDICTS.includes(entry.window_verdict)) {
      errors.push(`${label}.windows[${offset}].window_verdict must be one of ${WINDOW_VERDICTS.join("|")}`);
    }
    if (!Array.isArray(entry.findings)) {
      errors.push(`${label}.windows[${offset}].findings must be an array`);
    } else {
      for (let findingOffset = 0; findingOffset < entry.findings.length; findingOffset += 1) {
        const finding = entry.findings[findingOffset];
        if (!hasExactKeys(finding, FINDING_ITEM_KEYS)) {
          errors.push(`${label}.windows[${offset}].findings[${findingOffset}] has unknown, missing, duplicate, or out-of-order fields`);
          continue;
        }
        if (
          canonicalPageWindowFindingSeverity(finding.severity) !== finding.severity
          || !FINDING_SEVERITIES.includes(finding.severity)
        ) {
          errors.push(`${label}.windows[${offset}].findings[${findingOffset}].severity is invalid`);
        }
        if (typeof finding.summary_id !== "string" || finding.summary_id.trim() === "") {
          errors.push(`${label}.windows[${offset}].findings[${findingOffset}].summary_id must be non-empty`);
        }
        if (typeof finding.summary !== "string" || finding.summary.trim() === "") {
          errors.push(`${label}.windows[${offset}].findings[${findingOffset}].summary must be non-empty`);
        } else if (Buffer.byteLength(finding.summary, "utf8") > SECOND_REVIEW_FINDING_SUMMARY_MAX_BYTES) {
          errors.push(`${label}.windows[${offset}].findings[${findingOffset}].summary must be at most ${SECOND_REVIEW_FINDING_SUMMARY_MAX_BYTES} UTF-8 bytes`);
        }
      }
    }
    const expectedEntrySha = findingsLedgerEntrySha256({
      window_index: entry.window_index,
      page_indices: entry.page_indices,
      window_verdict: entry.window_verdict,
      findings: entry.findings,
    });
    if (entry.entry_sha256 !== expectedEntrySha) {
      errors.push(`${label}.windows[${offset}].entry_sha256 must bind the canonical window entry`);
    }
  }
  const expected = sealFindingsLedger(ledger.windows.map((entry) => ({
    window_index: entry.window_index,
    page_indices: entry.page_indices,
    window_verdict: entry.window_verdict,
    findings: entry.findings,
    entry_sha256: entry.entry_sha256,
  })));
  // Recompute from sealed windows already including entry_sha256 in object; ledger hash
  // binds schema+windows including each entry_sha256.
  const expectedLedgerSha = canonicalLedgerSha256({
    schema: SECOND_REVIEW_FINDINGS_LEDGER_SCHEMA,
    windows: ledger.windows,
  });
  if (ledger.ledger_sha256 !== expectedLedgerSha) {
    errors.push(`${label}.ledger_sha256 must bind the canonical windows closure`);
    return false;
  }
  void expected;
  return true;
}

export function checkpointCoverageComplete(ledger, pageCount) {
  if (!hasExactKeys(ledger, CHECKPOINT_LEDGER_KEYS)) return false;
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) return false;
  if (ledger.covered_indices.length !== pageCount) return false;
  for (let index = 1; index <= pageCount; index += 1) {
    if (ledger.covered_indices[index - 1] !== index) return false;
  }
  return true;
}

export function authorizeGateSatisfyingSticky({
  checkpointLedger,
  findingsLedger,
  pageCount,
  windowMaxPages,
  dispatchedWindowCount = null,
}) {
  // D9 (R10, R13): the fallback below must use the caller's declared window size, never
  // an implicit W=1 default — a caller that omits dispatchedWindowCount MUST still supply
  // the windowMaxPages it dispatched with.
  if (!Number.isSafeInteger(windowMaxPages) || windowMaxPages <= 0) {
    throw new TypeError("authorizeGateSatisfyingSticky requires an explicit positive windowMaxPages");
  }
  const errors = [];
  if (!validateCheckpointLedgerShape(checkpointLedger, errors)
    || !validateFindingsLedgerShape(findingsLedger, errors)) {
    return {
      authorized: false,
      reason: "ledger_invalid",
      errors,
    };
  }
  if (!checkpointCoverageComplete(checkpointLedger, pageCount)) {
    return {
      authorized: false,
      reason: "incomplete_page_coverage",
      errors: ["checkpoint_ledger does not prove digest-matching coverage for every manifest index"],
    };
  }
  const expectedWindows = dispatchedWindowCount === null
    ? pageWindowCount(pageCount, windowMaxPages)
    : dispatchedWindowCount;
  if (findingsLedger.windows.length !== expectedWindows) {
    return {
      authorized: false,
      reason: "findings_lost_or_missing_window",
      errors: [`findings_ledger must contain exactly ${expectedWindows} dispatched window entries`],
    };
  }
  if (findingsLedger.windows.some(entry => entry.window_verdict === "UNAVAILABLE")) {
    return { authorized: false, reason: "intermediate_unavailable", errors: ["A dispatched window was unavailable"] };
  }
  for (const entry of findingsLedger.windows) {
    if (entry.window_verdict === "CRITICAL"
      || entry.window_verdict === "UNAVAILABLE"
      || entry.findings.some((finding) => finding.severity === "CRITICAL")) {
      return {
        authorized: false,
        reason: entry.window_verdict === "UNAVAILABLE"
          ? "intermediate_unavailable"
          : "unresolved_critical",
        errors: [`window ${entry.window_index} blocks gate-satisfying sticky`],
      };
    }
  }
  return { authorized: true, reason: "aggregation_passed", errors: [] };
}

export function parsePageWindowCompletionObject(completion, {
  headRefOid,
  dispatchId,
  expectedWindowIndex,
  expectedPageIndices,
} = {}) {
  if (!isPlainObject(completion)) {
    return { status: "malformed" };
  }
  const keys = Object.keys(completion);
  if (
    keys.length !== PAGE_WINDOW_COMPLETION_KEYS.length
    || PAGE_WINDOW_COMPLETION_KEYS.some((key) => !Object.hasOwn(completion, key))
  ) {
    return { status: "malformed" };
  }
  for (const key of STICKY_FACING_COMPLETION_KEYS) {
    if (typeof completion[key] !== "string" || completion[key].trim() === "") {
      return key === "reason" && completion.reason === ""
        ? { status: "reason-missing" }
        : { status: "malformed" };
    }
  }
  if (completion.reason !== completion.reason.trim()) {
    return { status: "malformed" };
  }
  if (Buffer.byteLength(completion.reason, "utf8") > SECOND_REVIEW_VERDICT_REASON_MAX_BYTES) {
    return { status: "malformed" };
  }
  if (!Number.isSafeInteger(completion.window_index) || completion.window_index <= 0) {
    return { status: "malformed" };
  }
  if (!Array.isArray(completion.page_indices) || completion.page_indices.length === 0) {
    return { status: "malformed" };
  }
  if (!completion.page_indices.every((index, offset, all) => (
    Number.isSafeInteger(index)
    && index > 0
    && (offset === 0 || index === all[offset - 1] + 1)
  ))) {
    return { status: "malformed" };
  }
  if (typeof completion.head_ref_oid !== "string"
    || typeof completion.dispatch_id !== "string"
    || !Array.isArray(completion.findings)
    || typeof completion.findings_payload_sha256 !== "string") {
    // findings_payload_sha256 remains a required key for eleven-key order stability,
    // but its reviewer-supplied value is opaque: runner seals the canonical digest below.
    return { status: "malformed" };
  }
  const canonicalFindings = [];
  for (const finding of completion.findings) {
    if (!hasExactKeys(finding, FINDING_ITEM_KEYS)
      || typeof finding.summary_id !== "string"
      || finding.summary_id.trim() === ""
      || typeof finding.summary !== "string"
      || finding.summary.trim() === ""
      || Buffer.byteLength(finding.summary, "utf8") > SECOND_REVIEW_FINDING_SUMMARY_MAX_BYTES) {
      return { status: "malformed" };
    }
    const severity = canonicalPageWindowFindingSeverity(finding.severity);
    if (!FINDING_SEVERITIES.includes(severity)) {
      return { status: "malformed" };
    }
    canonicalFindings.push({
      severity,
      summary_id: finding.summary_id,
      summary: finding.summary,
    });
  }
  const canonicalCompletion = {
    ...completion,
    findings: canonicalFindings,
  };
  if (headRefOid !== undefined && canonicalCompletion.head_ref_oid !== headRefOid) {
    return { status: "stale", completion: sealPageWindowCompletionFindingsPayload(canonicalCompletion) };
  }
  if (headRefOid !== undefined && canonicalCompletion.last_reviewed_sha !== headRefOid) {
    return { status: "stale", completion: sealPageWindowCompletionFindingsPayload(canonicalCompletion) };
  }
  if (canonicalCompletion.last_reviewed_sha !== canonicalCompletion.head_ref_oid) {
    return { status: "malformed" };
  }
  if (dispatchId !== undefined && canonicalCompletion.dispatch_id !== dispatchId) {
    return { status: "malformed" };
  }
  if (expectedWindowIndex !== undefined && canonicalCompletion.window_index !== expectedWindowIndex) {
    return { status: "malformed" };
  }
  if (expectedPageIndices !== undefined) {
    const expected = [...expectedPageIndices];
    if (
      canonicalCompletion.page_indices.length !== expected.length
      || canonicalCompletion.page_indices.some((index, offset) => index !== expected[offset])
    ) {
      return { status: "malformed" };
    }
  }
  if (!WINDOW_VERDICTS.includes(canonicalCompletion.verdict)) {
    return { status: "malformed" };
  }
  const sealed = sealPageWindowCompletionFindingsPayload(canonicalCompletion);
  if (canonicalCompletion.verdict === "PASS" || canonicalCompletion.verdict === "WARN") {
    return { status: "accepted", completion: sealed };
  }
  if (canonicalCompletion.verdict === "UNAVAILABLE" || canonicalCompletion.verdict === "CRITICAL") {
    return { status: "blocking-verdict", completion: sealed };
  }
  return { status: "malformed" };
}

function canonicalPagedManifest(data, reviewMaterial) {
  const pageContents = pageReviewMaterial(reviewMaterial);
  const manifestPages = pageContents.map((content, offset) => ({
    index: offset + 1,
    utf8_bytes: Buffer.byteLength(content, "utf8"),
    sha256: materialSha256(content),
  }));
  return {
    schema: SECOND_REVIEW_PAGED_MANIFEST_SCHEMA,
    page_count: pageContents.length,
    max_page_utf8_bytes: SECOND_REVIEW_PAGE_MAX_BYTES,
    total_utf8_bytes: Buffer.byteLength(reviewMaterial, "utf8"),
    aggregate_sha256: materialSha256(reviewMaterial),
    scope_fingerprint_sha256: reviewScopeFingerprintSha256(data.review_scope),
    head_sha: data.head_ref_oid,
    changed_paths_sha256: changedPathsSha256(data.changed_files_or_touch_list),
    pages: manifestPages,
  };
}

export function normalizePrStickyReviewMaterialData(data, {
  embeddedMaxBytes = SECOND_REVIEW_EMBEDDED_MAX_BYTES,
  materialMaxBytes = 2_097_152,
  windowMaxPages = SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES,
} = {}) {
  if (data?.schema_version !== SECOND_REVIEW_PR_SCHEMA_VERSION
    || data?.review_material_carrier === "renderer-paged-snapshot") {
    throw new TypeError("renderer input must be a canonical v4 non-paged pr-sticky row");
  }
  const sourceErrors = validatePrStickyReviewMaterialContract(data, { materialMaxBytes });
  if (sourceErrors.length > 0) {
    throw new TypeError(`invalid renderer source material: ${sourceErrors.join("; ")}`);
  }
  if (data.review_material_carrier !== "embedded-diff"
    || Buffer.byteLength(data.review_material, "utf8") <= embeddedMaxBytes) {
    return data;
  }

  const manifest = canonicalPagedManifest(data, data.review_material);
  const fullPages = pageReviewMaterial(data.review_material).map((content, offset) => ({
    index: offset + 1,
    content,
  }));
  const reviewMaterial = framePagedReviewMaterial({
    manifest,
    fullPages,
    windowIndex: 1,
    windowMaxPages,
  });
  return {
    ...data,
    schema_version: SECOND_REVIEW_PAGED_PR_SCHEMA_VERSION,
    review_material_carrier: "renderer-paged-snapshot",
    review_material_capability: "scope-bound-renderer-paged-complete-diff-v1",
    review_material_proof: {
      kind: "renderer-paged-complete-diff-v1",
      scope_fingerprint_sha256: manifest.scope_fingerprint_sha256,
      manifest_sha256: sha256Utf8(JSON.stringify(manifest)),
    },
    review_material: reviewMaterial,
    // Carrier-only: full pages for runner window advance. Never framed into Review Data.
    __paged_full_pages: fullPages,
  };
}

function decodeQuotedGitPath(token) {
  if (!token.startsWith('"') || !token.endsWith('"')) return token;
  const bytes = [];
  const body = token.slice(1, -1);
  for (let offset = 0; offset < body.length;) {
    const codePoint = body.codePointAt(offset);
    const character = String.fromCodePoint(codePoint);
    if (character !== "\\") {
      bytes.push(...Buffer.from(character, "utf8"));
      offset += character.length;
      continue;
    }
    offset += 1;
    if (offset >= body.length) return null;
    const escaped = body[offset];
    if (/[0-7]/.test(escaped)) {
      const octal = body.slice(offset).match(/^[0-7]{1,3}/)?.[0];
      const value = Number.parseInt(octal, 8);
      if (value > 255) return null;
      bytes.push(value);
      offset += octal.length;
      continue;
    }
    const escapeBytes = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      "\\": 0x5c,
    };
    if (!Object.hasOwn(escapeBytes, escaped)) return null;
    bytes.push(escapeBytes[escaped]);
    offset += 1;
  }
  return decodeUtf8Fatal(Buffer.from(bytes));
}

function pathFromDiffHeader(line) {
  if (!line.startsWith("diff --git ")) return null;
  const body = line.slice("diff --git ".length);
  if (body.startsWith('"a/')) {
    const match = body.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
    if (!match) return null;
    const right = decodeQuotedGitPath(match[2]);
    return typeof right === "string" && right.startsWith("b/") ? right.slice(2) : null;
  }
  const separator = body.lastIndexOf(" b/");
  if (!body.startsWith("a/") || separator < 0) return null;
  return body.slice(separator + 3);
}

function isCanonicalChangedPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && !value.includes("\\")
    && !value.startsWith("/")
    && !value.endsWith("/")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const FULL_PR_PATCH_GIT_FACT_KEYS = Object.freeze([
  "path",
  "status",
  "old_mode",
  "new_mode",
  "old_oid",
  "new_oid",
  "additions",
  "deletions",
]);
const FULL_PR_PATCH_GITHUB_STATUSES = new Set([
  "added",
  "changed",
  "copied",
  "deleted",
  "modified",
  "removed",
  "renamed",
  "unchanged",
]);

function fullPrPatchProbeFault(reason) {
  return { classification: "probe-fault", reason };
}

function validFullPrPatchGitFact(fact) {
  if (!hasExactKeys(fact, FULL_PR_PATCH_GIT_FACT_KEYS)
    || !isCanonicalChangedPath(fact.path)) return false;
  return isCanonicalNameStatus(fact.status)
    && /^[0-7]{6}$/u.test(fact.old_mode)
    && /^[0-7]{6}$/u.test(fact.new_mode)
    && sha40Pattern.test(fact.old_oid)
    && sha40Pattern.test(fact.new_oid)
    && ((fact.additions === "-" && fact.deletions === "-")
      || (/^(?:0|[1-9][0-9]*)$/u.test(fact.additions)
        && /^(?:0|[1-9][0-9]*)$/u.test(fact.deletions)));
}

function fullPrPatchGitKind(fact) {
  if (fact.old_mode === "160000" || fact.new_mode === "160000") return "submodule";
  if (fact.additions === "-" && fact.deletions === "-") return "binary";
  if (fact.old_oid === fact.new_oid
    && (fact.old_mode !== fact.new_mode || fact.status.startsWith("R") || fact.status.startsWith("C"))) {
    return "metadata-only";
  }
  return "expected-text";
}

export function classifyFullPrPatchCompleteness({ authorityPaths, gitFacts, githubRows } = {}) {
  if (!Array.isArray(authorityPaths)
    || authorityPaths.length === 0
    || authorityPaths.some((entry) => !isCanonicalChangedPath(entry))
    || new Set(authorityPaths).size !== authorityPaths.length) {
    return fullPrPatchProbeFault("authority-paths-invalid");
  }
  if (!Array.isArray(gitFacts)
    || gitFacts.length !== authorityPaths.length
    || gitFacts.some((fact) => !validFullPrPatchGitFact(fact))
    || new Set(gitFacts.map((fact) => fact.path)).size !== gitFacts.length) {
    return fullPrPatchProbeFault("git-facts-invalid");
  }
  if (!Array.isArray(githubRows)
    || githubRows.length !== authorityPaths.length
    || githubRows.some((row) => !isPlainObject(row)
      || !isCanonicalChangedPath(row.filename)
      || !FULL_PR_PATCH_GITHUB_STATUSES.has(row.status))
    || new Set(githubRows.map((row) => row.filename)).size !== githubRows.length) {
    return fullPrPatchProbeFault("github-rows-invalid");
  }

  const authority = sortPathsByUtf8Bytes([...authorityPaths]);
  const gitByPath = new Map(gitFacts.map((fact) => [fact.path, fact]));
  const githubByPath = new Map(githubRows.map((row) => [row.filename, row]));
  if (authority.some((entry) => !gitByPath.has(entry) || !githubByPath.has(entry))) {
    return fullPrPatchProbeFault("path-closure-mismatch");
  }
  for (const pathValue of authority) {
    const fact = gitByPath.get(pathValue);
    const row = githubByPath.get(pathValue);
    // Bind GitHub blob SHA to the immutable Git OID for that change shape.
    // Deletions keep the deleted blob on the pull-files row while git --raw
    // reports an all-zero new_oid, so deleted/removed rows bind to old_oid;
    // other rows bind to new_oid. Rows may omit sha; present sha must match.
    if (Object.hasOwn(row, "sha")) {
      const expectedOid = fact.status === "D"
        || row.status === "deleted"
        || row.status === "removed"
        ? fact.old_oid
        : fact.new_oid;
      if (typeof row.sha !== "string" || !/^[0-9a-f]{40}$/.test(row.sha) || row.sha !== expectedOid) {
        return fullPrPatchProbeFault("github-oid-mismatch");
      }
    }
  }
  const pathKinds = authority.map((pathValue) => ({
    path: pathValue,
    kind: fullPrPatchGitKind(gitByPath.get(pathValue)),
  }));
  const missing = pathKinds
    .filter(({ path: pathValue, kind }) => kind === "expected-text"
      && (typeof githubByPath.get(pathValue).patch !== "string"
        || githubByPath.get(pathValue).patch.trim().length === 0))
    .map(({ path: pathValue }) => pathValue);
  if (missing.length > 0) {
    return {
      classification: "expected-text-patch-missing",
      path_kinds: pathKinds,
      missing_expected_text_paths: missing,
    };
  }
  return { classification: "live-patch-complete", path_kinds: pathKinds };
}

function sortPathsByUtf8Bytes(paths) {
  return paths.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
}

function isCanonicalNameStatus(status) {
  return /^(?:[ADMTUXB]|[RC](?:100|0[0-9]{2}))$/.test(status);
}

function changedPathsFromNameStatusZ(material) {
  if (typeof material !== "string" || material.length === 0 || !material.endsWith("\0")) return null;
  const fields = material.slice(0, -1).split("\0");
  const paths = [];
  const seen = new Set();
  for (let offset = 0; offset < fields.length;) {
    const status = fields[offset++];
    if (!isCanonicalNameStatus(status)) return null;
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    if (offset + pathCount > fields.length) return null;
    const recordPaths = fields.slice(offset, offset + pathCount);
    offset += pathCount;
    if (recordPaths.some((entry) => !isCanonicalChangedPath(entry))) return null;
    const destination = recordPaths[pathCount - 1];
    if (seen.has(destination)) return null;
    seen.add(destination);
    paths.push(destination);
  }
  return paths.length > 0 ? sortPathsByUtf8Bytes(paths) : null;
}

function decodeUtf8Fatal(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function changedPathsFromGitDiff(material, options = {}) {
  if (options.format === "name-status-z") return changedPathsFromNameStatusZ(material);
  if (typeof material !== "string" || !material.startsWith("diff --git ")) return null;
  const paths = [];
  const seen = new Set();
  let currentHeaderPath = null;
  for (const line of material.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentHeaderPath = pathFromDiffHeader(line);
      if (currentHeaderPath === null) return null;
      if (!isCanonicalChangedPath(currentHeaderPath) || seen.has(currentHeaderPath)) return null;
      seen.add(currentHeaderPath);
      paths.push(currentHeaderPath);
      continue;
    }
    const destinationPrefix = line.startsWith("rename to ")
      ? "rename to "
      : line.startsWith("copy to ")
        ? "copy to "
        : null;
    if (destinationPrefix !== null && currentHeaderPath !== null) {
      const renamedPath = decodeQuotedGitPath(line.slice(destinationPrefix.length));
      if (!isCanonicalChangedPath(renamedPath)) return null;
      if (renamedPath !== currentHeaderPath) return null;
    }
  }
  return paths.length > 0 ? sortPathsByUtf8Bytes(paths) : null;
}

export function deriveAuthoritativeChangedSet(reviewScope, {
  repositorySlug,
  spawnSyncImpl = spawnSync,
} = {}) {
  const cwd = SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT;
  const rootResult = spawnSyncImpl("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const reportedRoot = String(rootResult.stdout ?? "").trim();
  try {
    if (rootResult.status !== 0 || realpathSync(reportedRoot) !== realpathSync(cwd)) return null;
  } catch {
    return null;
  }

  let comparisonBaseSha;
  const headSha = reviewScope?.head_sha;
  if (!/^[a-f0-9]{40}$/.test(String(headSha ?? ""))) return null;
  if (reviewScope?.kind === "commit-range") {
    comparisonBaseSha = reviewScope.base_sha;
  } else if (reviewScope?.kind === "full-pr"
    && /^[^/\s]+\/[^/\s]+$/.test(String(repositorySlug ?? ""))
    && Number.isSafeInteger(reviewScope.pull_request_number)
    && reviewScope.pull_request_number > 0) {
    const prResult = spawnSyncImpl("gh", [
      "pr", "view", String(reviewScope.pull_request_number),
      "--repo", repositorySlug,
      "--json", "baseRefOid,headRefOid",
    ], {
      cwd,
      encoding: "utf8",
      timeout: SECOND_REVIEW_GH_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let resolved;
    try {
      resolved = JSON.parse(String(prResult.stdout ?? ""));
    } catch {
      return null;
    }
    if (prResult.status !== 0 || resolved?.headRefOid !== headSha) return null;
    comparisonBaseSha = resolved.baseRefOid;
  } else {
    return null;
  }
  if (!/^[a-f0-9]{40}$/.test(String(comparisonBaseSha ?? ""))
    || comparisonBaseSha === headSha) return null;

  const mergeBaseResult = spawnSyncImpl("git", [
    "merge-base", "--all", comparisonBaseSha, headSha,
  ], {
    cwd,
    encoding: "buffer",
    timeout: SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS,
    maxBuffer: 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const mergeBaseText = decodeUtf8Fatal(mergeBaseResult.stdout);
  if (mergeBaseResult.status !== 0 || mergeBaseText === null) return null;
  const mergeBases = mergeBaseText.trimEnd().split("\n");
  if (mergeBases.length !== 1 || !sha40Pattern.test(mergeBases[0])) return null;
  if (reviewScope.kind === "commit-range" && mergeBases[0] !== comparisonBaseSha) return null;
  comparisonBaseSha = mergeBases[0];

  const diffResult = spawnSyncImpl("git", [
    "diff", "--name-status", "-z", ...SECOND_REVIEW_GIT_RENAME_COPY_FLAGS,
    comparisonBaseSha, headSha, "--",
  ], {
    cwd,
    encoding: "buffer",
    timeout: SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (diffResult.status !== 0 || !Buffer.isBuffer(diffResult.stdout)) return null;
  const decodedNameStatus = decodeUtf8Fatal(diffResult.stdout);
  if (decodedNameStatus === null) return null;
  const paths = changedPathsFromGitDiff(decodedNameStatus, { format: "name-status-z" });
  if (paths === null) return null;

  const rawDiffResult = spawnSyncImpl("git", [
    "diff", ...SECOND_REVIEW_GIT_RAW_DIFF_FLAGS,
    comparisonBaseSha, headSha, "--",
  ], {
    cwd,
    encoding: "buffer",
    timeout: SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS,
    maxBuffer: SECOND_REVIEW_AUTHORITATIVE_RAW_DIFF_MAX_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (rawDiffResult.status !== 0 || !Buffer.isBuffer(rawDiffResult.stdout)) return null;
  const rawDiff = decodeUtf8Fatal(rawDiffResult.stdout);
  if (rawDiff === null
    || Buffer.byteLength(rawDiff, "utf8") > SECOND_REVIEW_AUTHORITATIVE_RAW_DIFF_MAX_BYTES) return null;
  const rawDiffPaths = changedPathsFromGitDiff(rawDiff);
  if (rawDiffPaths === null
    || rawDiffPaths.length !== paths.length
    || rawDiffPaths.some((entry, index) => entry !== paths[index])) return null;

  return Object.freeze({
    kind: reviewScope.kind,
    comparison_base_sha: comparisonBaseSha,
    head_sha: headSha,
    paths: Object.freeze(paths),
    path_count: paths.length,
    paths_sha256: changedPathsSha256(paths),
    raw_diff: rawDiff,
  });
}

function parseTargetPullRequestNumber(target) {
  const match = typeof target === "string" ? target.match(/^PR #([1-9][0-9]*)$/) : null;
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function validateScope(data, errors) {
  const scope = data.review_scope;
  const expectedKeys = scope?.kind === "full-pr"
    ? FULL_PR_SCOPE_KEYS
    : scope?.kind === "commit-range"
      ? COMMIT_RANGE_SCOPE_KEYS
      : null;
  if (expectedKeys === null || !hasExactKeys(scope, expectedKeys)) {
    errors.push("review_scope has unknown, missing, duplicate, or out-of-order fields");
    return null;
  }
  if (!sha40Pattern.test(scope.head_sha)) {
    errors.push("review_scope.head_sha must be exactly 40 lowercase hexadecimal characters");
  }
  if (scope.head_sha !== data.head_ref_oid) {
    errors.push("review_scope.head_sha must equal head_ref_oid");
  }
  if (scope.kind === "full-pr") {
    if (!Number.isSafeInteger(scope.pull_request_number) || scope.pull_request_number <= 0) {
      errors.push("review_scope.pull_request_number must be a positive safe integer");
    }
    const targetNumber = parseTargetPullRequestNumber(data.target);
    if (targetNumber === null || scope.pull_request_number !== targetNumber) {
      errors.push("review_scope.pull_request_number must equal the canonical target PR number");
    }
  } else {
    if (!sha40Pattern.test(scope.base_sha)) {
      errors.push("review_scope.base_sha must be exactly 40 lowercase hexadecimal characters");
    }
    if (scope.base_sha === scope.head_sha) {
      errors.push("review_scope.base_sha must differ from review_scope.head_sha");
    }
  }
  return scope;
}

function validateChangedPathClosure(changedFiles, material, errors) {
  if (!Array.isArray(changedFiles)) {
    errors.push("changed_files_or_touch_list must be an array");
    return;
  }
  if (changedFiles.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    errors.push("changed_files_or_touch_list entries must be non-empty strings");
    return;
  }
  if (new Set(changedFiles).size !== changedFiles.length) {
    errors.push("changed_files_or_touch_list must not contain duplicate paths");
  }
  const materialPaths = changedPathsFromGitDiff(material);
  if (materialPaths === null) {
    errors.push("review_material must begin with a parseable raw git unified diff header");
    return;
  }
  const expectedPaths = [...new Set(changedFiles)].sort();
  const actualPaths = [...new Set(materialPaths)].sort();
  if (actualPaths.length !== expectedPaths.length
    || actualPaths.some((entry, index) => entry !== expectedPaths[index])) {
    errors.push("review_material changed paths must exactly reconcile with changed_files_or_touch_list");
  }
}

function validateEmbeddedRow(data, scopeFingerprint, errors, materialMaxBytes) {
  if (data.review_material_capability !== "scope-bound-embedded-complete-diff-v1") {
    errors.push("embedded-diff requires scope-bound-embedded-complete-diff-v1 capability");
  }
  const proof = data.review_material_proof;
  if (!hasExactKeys(proof, EMBEDDED_PROOF_KEYS)) {
    errors.push("embedded review_material_proof has unknown, missing, duplicate, or out-of-order fields");
    return;
  }
  if (proof.kind !== "embedded-complete-diff-v1") {
    errors.push("embedded-diff requires embedded-complete-diff-v1 proof");
  }
  if (proof.scope_fingerprint_sha256 !== scopeFingerprint) {
    errors.push("review_material_proof scope fingerprint does not match canonical review_scope");
  }
  if (!digestPattern.test(proof.scope_fingerprint_sha256)) {
    errors.push("review_material_proof.scope_fingerprint_sha256 must be 64 lowercase hexadecimal characters");
  }
  if (proof.material_format !== "git-unified-diff") {
    errors.push("embedded proof material_format must equal git-unified-diff");
  }
  if (typeof data.review_material !== "string" || data.review_material.length === 0) {
    errors.push("embedded review_material must be a non-empty raw Git diff");
    return;
  }
  const materialBytes = Buffer.byteLength(data.review_material, "utf8");
  if (materialBytes > materialMaxBytes) {
    errors.push(`review_material exceeds ${materialMaxBytes} UTF-8 bytes`);
  }
  if (!Number.isSafeInteger(proof.material_utf8_bytes)
    || proof.material_utf8_bytes !== materialBytes) {
    errors.push("review_material_proof.material_utf8_bytes must equal the exact review_material UTF-8 byte count");
  }
  const digest = materialSha256(data.review_material);
  if (!digestPattern.test(proof.material_sha256) || proof.material_sha256 !== digest) {
    errors.push("review_material_proof.material_sha256 must equal the exact review_material SHA-256");
  }
  validateChangedPathClosure(data.changed_files_or_touch_list, data.review_material, errors);
}

function expectedLiveRow(scopeKind) {
  return scopeKind === "full-pr"
    ? {
      capability: "full-pr-bounded-live-reads-v1",
      routeId: "gh-pr-bounded-live-v1",
    }
    : {
      capability: "commit-range-exact-compare-v1",
      routeId: "gh-api-exact-compare-v1",
    };
}

function validateLiveRow(data, scope, scopeFingerprint, errors) {
  const row = expectedLiveRow(scope.kind);
  if (data.review_material_capability !== row.capability) {
    errors.push(`${scope.kind} live reads require ${row.capability} capability`);
  }
  if (data.review_material !== "") {
    errors.push("adapter-live-pr-reads requires review_material to be the exact empty string");
  }
  const proof = data.review_material_proof;
  if (!hasExactKeys(proof, ADAPTER_ROUTE_PROOF_KEYS)) {
    errors.push("live review_material_proof has unknown, missing, duplicate, or out-of-order fields");
    return;
  }
  if (proof.kind !== "adapter-route-required-v1") {
    errors.push("adapter-live-pr-reads requires adapter-route-required-v1 proof");
  }
  if (!digestPattern.test(proof.scope_fingerprint_sha256)
    || proof.scope_fingerprint_sha256 !== scopeFingerprint) {
    errors.push("review_material_proof scope fingerprint does not match canonical review_scope");
  }
  if (proof.route_id !== row.routeId) {
    errors.push(`${scope.kind} live reads require route_id ${row.routeId}`);
  }
}

function validatePagedRow(data, scopeFingerprint, errors, materialMaxBytes, windowMaxPages) {
  if (data.review_material_capability !== "scope-bound-renderer-paged-complete-diff-v1") {
    errors.push("renderer-paged-snapshot requires scope-bound-renderer-paged-complete-diff-v1 capability");
  }
  const proof = data.review_material_proof;
  if (!hasExactKeys(proof, PAGED_PROOF_KEYS)) {
    errors.push("paged review_material_proof has unknown, missing, duplicate, or out-of-order fields");
    return;
  }
  if (proof.kind !== "renderer-paged-complete-diff-v1") {
    errors.push("renderer-paged-snapshot requires renderer-paged-complete-diff-v1 proof");
  }
  if (!digestPattern.test(proof.scope_fingerprint_sha256)
    || proof.scope_fingerprint_sha256 !== scopeFingerprint) {
    errors.push("paged proof scope fingerprint does not match canonical review_scope");
  }

  const reviewMaterial = data.review_material;
  if (!hasExactKeys(reviewMaterial, PAGED_REVIEW_MATERIAL_KEYS)) {
    errors.push("paged review_material has unknown, missing, duplicate, or out-of-order fields");
    return;
  }
  if (!WINDOW_ROLES.includes(reviewMaterial.window_role)) {
    errors.push("paged review_material.window_role must be intermediate or final");
  }
  validateCheckpointLedgerShape(reviewMaterial.checkpoint_ledger, errors);
  validateFindingsLedgerShape(reviewMaterial.findings_ledger, errors);

  const manifest = reviewMaterial.manifest;
  if (!hasExactKeys(manifest, PAGED_MANIFEST_KEYS)) {
    errors.push("paged manifest has unknown, missing, duplicate, or out-of-order fields");
    return;
  }
  if (manifest.schema !== SECOND_REVIEW_PAGED_MANIFEST_SCHEMA) {
    errors.push(`paged manifest.schema must equal ${SECOND_REVIEW_PAGED_MANIFEST_SCHEMA}`);
  }
  if (manifest.max_page_utf8_bytes !== SECOND_REVIEW_PAGE_MAX_BYTES) {
    errors.push(`paged manifest.max_page_utf8_bytes must equal ${SECOND_REVIEW_PAGE_MAX_BYTES}`);
  }
  if (!Array.isArray(manifest.pages) || !Array.isArray(reviewMaterial.pages)) {
    errors.push("paged manifest.pages and review_material.pages must be arrays");
    return;
  }
  if (!Number.isSafeInteger(manifest.page_count)
    || manifest.page_count <= 0
    || manifest.page_count !== manifest.pages.length) {
    errors.push("paged manifest.page_count must equal the non-empty manifest.pages array");
    return;
  }
  if (reviewMaterial.pages.length === 0
    || reviewMaterial.pages.length > manifest.page_count
    || reviewMaterial.pages.length > windowMaxPages) {
    errors.push(
      "paged review_material.pages must be a non-empty active window no larger than "
      + `${windowMaxPages} and at most manifest.page_count`
    );
    return;
  }

  for (let offset = 0; offset < manifest.pages.length; offset += 1) {
    const expectedIndex = offset + 1;
    const manifestPage = manifest.pages[offset];
    if (!hasExactKeys(manifestPage, PAGED_MANIFEST_PAGE_KEYS)) {
      errors.push(`paged manifest.pages[${offset}] has unknown, missing, duplicate, or out-of-order fields`);
      continue;
    }
    if (manifestPage.index !== expectedIndex) {
      errors.push(`paged manifest page index at offset ${offset} must equal ${expectedIndex}`);
    }
    if (!Number.isSafeInteger(manifestPage.utf8_bytes)
      || manifestPage.utf8_bytes <= 0
      || manifestPage.utf8_bytes > SECOND_REVIEW_PAGE_MAX_BYTES) {
      errors.push(`paged manifest.pages[${offset}].utf8_bytes must be in 1..${SECOND_REVIEW_PAGE_MAX_BYTES}`);
    }
    if (!digestPattern.test(manifestPage.sha256)) {
      errors.push(`paged manifest.pages[${offset}].sha256 must be lowercase 64-hex`);
    }
  }

  let previousIndex = null;
  for (let offset = 0; offset < reviewMaterial.pages.length; offset += 1) {
    const dataPage = reviewMaterial.pages[offset];
    if (!hasExactKeys(dataPage, PAGED_DATA_PAGE_KEYS)) {
      errors.push(`paged review_material.pages[${offset}] has unknown, missing, duplicate, or out-of-order fields`);
      continue;
    }
    if (!Number.isSafeInteger(dataPage.index)
      || dataPage.index < 1
      || dataPage.index > manifest.page_count) {
      errors.push(`paged review_material.pages[${offset}].index must be in 1..${manifest.page_count}`);
      continue;
    }
    if (previousIndex !== null && dataPage.index !== previousIndex + 1) {
      errors.push("paged review_material.pages must be a contiguous active window");
    }
    previousIndex = dataPage.index;
    if (typeof dataPage.content !== "string" || dataPage.content.length === 0) {
      errors.push(`paged review_material.pages[${offset}].content must be non-empty`);
      continue;
    }
    const pageBytes = Buffer.byteLength(dataPage.content, "utf8");
    if (pageBytes > SECOND_REVIEW_PAGE_MAX_BYTES) {
      errors.push(`paged review_material.pages[${offset}] exceeds ${SECOND_REVIEW_PAGE_MAX_BYTES} UTF-8 bytes`);
    }
    const manifestPage = manifest.pages[dataPage.index - 1];
    if (!manifestPage || manifestPage.index !== dataPage.index) {
      errors.push(`paged review_material.pages[${offset}] has no matching manifest page`);
      continue;
    }
    if (manifestPage.utf8_bytes !== pageBytes) {
      errors.push(`paged manifest.pages[${dataPage.index - 1}].utf8_bytes must equal the exact page byte count`);
    }
    if (manifestPage.sha256 !== materialSha256(dataPage.content)) {
      errors.push(`paged manifest.pages[${dataPage.index - 1}].sha256 must equal the exact page SHA-256`);
    }
  }

  if (!Number.isSafeInteger(manifest.total_utf8_bytes)
    || manifest.total_utf8_bytes <= SECOND_REVIEW_EMBEDDED_MAX_BYTES
    || manifest.total_utf8_bytes > materialMaxBytes) {
    errors.push(`paged review material must be > ${SECOND_REVIEW_EMBEDDED_MAX_BYTES} and <= ${materialMaxBytes} UTF-8 bytes`);
  }
  if (!digestPattern.test(manifest.aggregate_sha256)) {
    errors.push("paged manifest.aggregate_sha256 must be lowercase 64-hex");
  }
  // Full-material aggregate/boundary checks require all page contents. When the framed
  // object carries only the active window, those checks are enforced at normalize time
  // against the full carrier and re-checked only for the degenerate single-window case.
  if (reviewMaterial.pages.length === manifest.page_count
    && reviewMaterial.pages[0]?.index === 1) {
    const material = reviewMaterial.pages.map((page) => page.content).join("");
    const totalBytes = Buffer.byteLength(material, "utf8");
    if (manifest.total_utf8_bytes !== totalBytes) {
      errors.push("paged manifest.total_utf8_bytes must equal the reconstructed material byte count");
    }
    if (manifest.aggregate_sha256 !== materialSha256(material)) {
      errors.push("paged manifest.aggregate_sha256 must equal the reconstructed material SHA-256");
    }
    const canonicalPages = material.length > 0 ? pageReviewMaterial(material) : [];
    if (canonicalPages.length !== reviewMaterial.pages.length
      || canonicalPages.some((content, offset) => content !== reviewMaterial.pages[offset]?.content)) {
      errors.push("paged review material must use deterministic maximal Unicode code-point page boundaries");
    }
    validateChangedPathClosure(data.changed_files_or_touch_list, material, errors);
  } else if (requiresPageWindowing(manifest.page_count, windowMaxPages)
    && reviewMaterial.window_role === "final"
    && reviewMaterial.pages.length === manifest.page_count) {
    errors.push("page-window final framed pages must not silently reload the full 1..N content set");
  }
  if (manifest.scope_fingerprint_sha256 !== scopeFingerprint) {
    errors.push("paged manifest scope fingerprint does not match canonical review_scope");
  }
  if (manifest.head_sha !== data.head_ref_oid || manifest.head_sha !== data.review_scope.head_sha) {
    errors.push("paged manifest.head_sha must equal head_ref_oid and review_scope.head_sha");
  }
  if (!digestPattern.test(manifest.changed_paths_sha256)
    || manifest.changed_paths_sha256 !== changedPathsSha256(data.changed_files_or_touch_list)) {
    errors.push("paged manifest.changed_paths_sha256 must bind canonical changed_files_or_touch_list JSON");
  }
  if (!digestPattern.test(proof.manifest_sha256)
    || proof.manifest_sha256 !== sha256Utf8(JSON.stringify(manifest))) {
    errors.push("paged proof.manifest_sha256 must equal the canonical manifest SHA-256");
  }
  if (requiresPageWindowing(manifest.page_count, windowMaxPages)) {
    if (reviewMaterial.pages.length === manifest.page_count && reviewMaterial.pages[0]?.index === 1) {
      errors.push("page-window handoff must not frame the full 1..N page content set in one invocation");
    }
  } else if (reviewMaterial.window_role !== "final") {
    errors.push("degenerate single-window paged handoff must use window_role=final");
  }
}

export function validatePrStickyReviewMaterialContract(data, {
  materialMaxBytes = 2_097_152,
  embeddedMaxBytes = materialMaxBytes,
  authoritativeChangedPaths,
  windowMaxPages = SECOND_REVIEW_PAGE_WINDOW_MAX_PAGES,
} = {}) {
  const errors = [];
  if (!isPlainObject(data)) return ["review data must be a JSON object"];
  if (!hasExactKeysAllowingOptional(
    data,
    SECOND_REVIEW_V4_TOP_LEVEL_KEYS,
    SECOND_REVIEW_OPTIONAL_TOP_LEVEL_KEYS,
  )) {
    errors.push("v4/v5 pr-sticky review data has unknown, missing, duplicate, or out-of-order top-level fields");
  }
  if (![SECOND_REVIEW_PR_SCHEMA_VERSION, SECOND_REVIEW_PAGED_PR_SCHEMA_VERSION].includes(data.schema_version)) {
    errors.push(`pr-sticky schema_version must equal ${SECOND_REVIEW_PR_SCHEMA_VERSION} or ${SECOND_REVIEW_PAGED_PR_SCHEMA_VERSION}`);
  }
  if (data.mode !== "pr-sticky") {
    errors.push("v4 review data is only valid for pr-sticky mode");
  }
  if (!sha40Pattern.test(data.head_ref_oid)) {
    errors.push("pr-sticky head_ref_oid must be exactly 40 lowercase hexadecimal characters");
  }
  if (!Array.isArray(data.changed_files_or_touch_list)) {
    errors.push("changed_files_or_touch_list must be an array");
    return errors;
  }
  const scope = validateScope(data, errors);
  if (scope === null) return errors;
  const scopeFingerprint = reviewScopeFingerprintSha256(scope);
  if (!REVIEW_MATERIAL_CARRIERS.includes(data.review_material_carrier)) {
    errors.push(`review_material_carrier must be one of: ${REVIEW_MATERIAL_CARRIERS.join(", ")}`);
    return errors;
  }
  if (!REVIEW_MATERIAL_CAPABILITIES.includes(data.review_material_capability)) {
    errors.push(`review_material_capability must be one of: ${REVIEW_MATERIAL_CAPABILITIES.join(", ")}`);
  }
  if (data.schema_version === SECOND_REVIEW_PAGED_PR_SCHEMA_VERSION
    && data.review_material_carrier !== "renderer-paged-snapshot") {
    errors.push("v5 pr-sticky review data requires renderer-paged-snapshot carrier");
  }
  if (data.schema_version === SECOND_REVIEW_PR_SCHEMA_VERSION
    && data.review_material_carrier === "renderer-paged-snapshot") {
    errors.push("v4 pr-sticky review data cannot use renderer-paged-snapshot carrier");
  }
  if (data.review_material_carrier === "embedded-diff") {
    validateEmbeddedRow(data, scopeFingerprint, errors, embeddedMaxBytes);
  } else if (data.review_material_carrier === "renderer-paged-snapshot") {
    validatePagedRow(data, scopeFingerprint, errors, materialMaxBytes, windowMaxPages);
  } else {
    // F-01: this 64 KiB codex-exec transport guard is specific to the runner-spawned
    // adapter-live-pr-reads carrier (run-second-reviewer-projection.mjs's complete-line
    // safety bound). external-live-reads is an interactive external-evaluator session with
    // no runner CLI spawn and no 64 KiB line bound, so it must never trip this guard — doing
    // so blocked a Claude primary from issuing an external ticket to reviewer_family codex/
    // openai-codex, the main intended external-evaluator use.
    if (data.review_material_carrier === "adapter-live-pr-reads"
      && reviewerTransportEmbedsCompleteOutputPerLine(data.reviewer_family)) {
      errors.push(
        "reviewer_family is dispatched via codex exec --json, which embeds complete per-command output on a "
        + "single telemetry line; the adapter-live-pr-reads carrier makes the reviewer live-read the full diff and "
        + "overflows the runner 64 KiB complete-line bound. Route this reviewer through the renderer-owned packet "
        + "route so the renderer publishes the complete bounded diff as v4 embedded or v5 paged packet material.",
      );
    }
    validateLiveRow(data, scope, scopeFingerprint, errors);
  }
  if (authoritativeChangedPaths !== undefined) {
    if (!Array.isArray(authoritativeChangedPaths)) {
      return ["review_material_scope_unresolvable"];
    }
    const authority = authoritativeChangedPaths.every(isCanonicalChangedPath)
      && new Set(authoritativeChangedPaths).size === authoritativeChangedPaths.length
      ? sortPathsByUtf8Bytes([...authoritativeChangedPaths])
      : null;
    const declared = data.changed_files_or_touch_list.every(isCanonicalChangedPath)
      && new Set(data.changed_files_or_touch_list).size === data.changed_files_or_touch_list.length
      ? sortPathsByUtf8Bytes([...data.changed_files_or_touch_list])
      : null;
    if (authority === null || declared === null
      || authority.length !== declared.length
      || authority.some((entry, index) => entry !== declared[index])) {
      return ["review_material_full_closure_invalid"];
    }
  }
  return errors;
}

export function canonicalEmbeddedReviewMaterialProof(reviewScope, reviewMaterial) {
  return {
    kind: "embedded-complete-diff-v1",
    scope_fingerprint_sha256: reviewScopeFingerprintSha256(reviewScope),
    material_format: "git-unified-diff",
    material_utf8_bytes: Buffer.byteLength(reviewMaterial, "utf8"),
    material_sha256: materialSha256(reviewMaterial),
  };
}

export function canonicalAdapterRouteProof(reviewScope) {
  return {
    kind: "adapter-route-required-v1",
    scope_fingerprint_sha256: reviewScopeFingerprintSha256(reviewScope),
    route_id: reviewScope.kind === "full-pr"
      ? "gh-pr-bounded-live-v1"
      : "gh-api-exact-compare-v1",
  };
}
