#!/usr/bin/env node
import { reviewGithubSpawnSync as spawnSync } from "./lib/second-review-github-transport.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveMainCheckoutNotesTmp } from "./second-reviewer-cli-recipe-contract.mjs";
import {
  SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT,
  SECOND_REVIEW_GH_PROBE_TIMEOUT_MS,
  SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS,
  SECOND_REVIEW_GIT_RENAME_COPY_FLAGS,
  canonicalAdapterRouteProof,
  canonicalEmbeddedReviewMaterialProof,
  changedPathsFromGitDiff,
  deriveAuthoritativeChangedSet,
} from "./second-review-material-contract.mjs";
import { EXTERNAL_EVALUATOR_EXECUTOR_KIND } from "./hooks/lib/second-review-control-evidence.mjs";
import { STICKY_PROVENANCE_TOOL_TOKENS, SECOND_REVIEW_STICKY_MARKER, normalizeSecondReviewStickyCandidate } from "./hooks/lib/second-review-sticky-authority.mjs";
import { liveStickyAuthoritySnapshot } from "./run-second-reviewer-projection.mjs";
import { deriveChangeNameFromBranch } from "./lib/derive-change-name-from-branch.mjs";
import { changeNameFromProposalPath } from "./lib/proposal-change-path.mjs";
import {
  CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES,
  CONSUMER_SECOND_REVIEW_RULES_PROBLEM_HINTS,
  CONSUMER_SECOND_REVIEW_RULES_REL,
  checkConsumerReviewRulesBytes,
} from "./lib/consumer-second-review-rules.mjs";
import { findPIIHits } from "./lib/pii-pattern-contract.mjs";
import { neutraliseInertMarkdown } from "./lib/markdown-fence-aware.mjs";
import { findSecretHits } from "./lib/secret-pattern-contract.mjs";
import { resolveReadyStickyBaseline } from "./hooks/lib/second-review-sticky-authority.mjs";
import { SCOPE_SUMMARY_MAX_BYTES, DONE_WHEN_MAX_ITEMS, DONE_WHEN_ITEM_MAX_BYTES, PR_STICKY_APPROVAL_CONTEXT, SAME_FAMILY_FALLBACK_GENERIC_WHY, classificationIndicatesSameFamilyFallback, reservedStickyReasonLiteral } from "./validate-second-review-packet.mjs";
import {
  PR_EVIDENCE_FIELDS,
  changeContextFindings,
  evidenceFieldFindings,
  extractEvidenceText,
  extractScopeSummary,
  findExactH2Section,
  formatEvidenceFinding,
  scopeSummaryOverLimit,
  sectionBody,
} from "./lib/pr-body-evidence-rules.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
const HANDOFF_KEYS = Object.freeze([
  "mode", "attempt", "primary_family", "reviewer_family", "preferred_reviewer", "target",
  "head_ref_oid", "repository_slug", "change_name", "approval_context", "approval_resolution",
  "scope_summary", "changed_files_or_touch_list", "review_scope", "page_window_max_pages",
  "review_material_carrier", "review_material_capability", "review_material_proof", "review_material",
  "primary_validation_evidence", "primary_test_evidence", "done_when", "linked_issue_context",
  "primary_verdict", "retry_context", "sticky_authority_snapshot", "write_path", "allowed_tools",
]);
// External Evaluator handoff: the standard keys minus page_window_max_pages, then the two executor keys at the end.
const EXTERNAL_HANDOFF_KEYS = Object.freeze([
  ...HANDOFF_KEYS.filter((key) => key !== "page_window_max_pages"),
  "executor_kind", "reviewer_tool",
]);
// Mirrors the live-read rows of second-review-material-contract.mjs (expectedLiveRow, not exported).
const EXTERNAL_LIVE_CAPABILITY = Object.freeze({ "full-pr": "full-pr-bounded-live-reads-v1", "commit-range": "commit-range-exact-compare-v1" });
// No per-PR approval is collected, so both paths write the same fixed values. The key names keep the word approval
// for historical reasons only (spec: Second-Review Handoff Carries Fixed Approval Fields).
const fixedApprovalResolution = () => ({ status: "not-required" });

function fail(message, classification = "handoff_builder_invalid") {
  const error = new Error(message);
  error.classification = classification;
  throw error;
}

function requireValue(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
  return value.trim();
}

export function parseBuilderArgs(argv) {
  const args = [...argv];
  const prToken = args.shift();
  if (!/^[1-9][0-9]*$/.test(String(prToken ?? ""))) fail("PR number must be a positive safe decimal integer", "invalid_pr_number");
  const prNumber = Number(prToken);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) fail("PR number must be a positive safe decimal integer", "invalid_pr_number");
  const values = new Map();
  const allowed = new Set([
    "--change", "--branch", "--carrier-root", "--primary-family", "--preferred-reviewer", "--external-evaluator",
    "--attempt", "--retry-classification", "--retry-sticky-verification", "--allow-same-family",
  ]);
  let lite = false;
  while (args.length) {
    const flag = args.shift();
    // The value-less switch must never read the next token.
    if (flag === "--lite") {
      if (lite) fail(`duplicate builder flag: ${flag}`, "invalid_cli_arguments");
      lite = true;
      continue;
    }
    if (!allowed.has(flag)) fail(`unknown builder flag: ${flag}`, "invalid_cli_arguments");
    if (values.has(flag)) fail(`duplicate builder flag: ${flag}`, "invalid_cli_arguments");
    const value = args.shift();
    if (value === undefined || value === "" || value.startsWith("--")) fail(`${flag} requires a non-empty value`, "invalid_cli_arguments");
    values.set(flag, value);
  }
  const change = values.get("--change");
  const branch = values.get("--branch");
  if (lite) {
    if (change) fail("--lite has no OpenSpec change to select and cannot be combined with --change: select the PR with --branch", "invalid_selector");
    if (!branch) fail("--lite requires a non-empty --branch selector", "invalid_selector");
  } else if (Boolean(change) === Boolean(branch)) {
    fail("provide exactly one non-empty --change or --branch selector", "invalid_selector");
  }
  const carrierRoot = requireValue(values.get("--carrier-root"), "--carrier-root");
  const primaryFamily = values.get("--primary-family");
  if (!SELECTABLE_PRIMARY_FAMILIES.includes(primaryFamily)) fail(`--primary-family must be injected as ${SELECTABLE_PRIMARY_FAMILIES_TEXT}`, "invalid_primary_family");
  const preferredReviewer = values.get("--preferred-reviewer");
  if (preferredReviewer !== undefined && !SELECTABLE_REVIEWER_FAMILIES.includes(preferredReviewer)) fail(`--preferred-reviewer must be ${SELECTABLE_REVIEWER_FAMILIES_TEXT}`, "invalid_reviewer_family");
  const externalEvaluator = values.get("--external-evaluator");
  if (externalEvaluator !== undefined && !STICKY_PROVENANCE_TOOL_TOKENS.includes(externalEvaluator)) {
    fail(`--external-evaluator must be one of: ${STICKY_PROVENANCE_TOOL_TOKENS.join(", ")}`, "invalid_external_evaluator");
  }
  const attempt = values.get("--attempt") ?? "initial";
  if (!SELECTABLE_ATTEMPTS.includes(attempt)) fail(`--attempt must be ${SELECTABLE_ATTEMPTS_TEXT}`, "invalid_attempt");
  const retryClassification = values.get("--retry-classification");
  const retryStickyVerification = values.get("--retry-sticky-verification");
  // The retry path can also carry a same-family disclosure into the sticky
  // reason, so it passes the same reserved-literal guard.
  if (classificationIndicatesSameFamilyFallback(retryClassification)) {
    const reservedInRetryWhy = reservedStickyReasonLiteral(retryStickyVerification);
    if (reservedInRetryWhy !== null) {
      fail(
        `--retry-sticky-verification must not contain the reserved sticky literal ${reservedInRetryWhy}`,
        "invalid_retry_context",
      );
    }
  }
  const allowSameFamilyValue = values.get("--allow-same-family");
  let allowSameFamily;
  if (allowSameFamilyValue !== undefined) {
    allowSameFamily = allowSameFamilyValue.trim();
    if (allowSameFamily.length < 10) {
      fail("--allow-same-family requires a change-specific objective reason of at least 10 characters", "invalid_allow_same_family");
    }
    if (allowSameFamily === SAME_FAMILY_FALLBACK_GENERIC_WHY) {
      fail("--allow-same-family reason must be change-specific, not the generic placeholder", "invalid_allow_same_family");
    }
    // The why is injected into the sticky reason, where the canonical body
    // contract reserves the marker and the Rules/Tool/Model footer tokens.
    const reservedInWhy = reservedStickyReasonLiteral(allowSameFamily);
    if (reservedInWhy !== null) {
      fail(
        `--allow-same-family reason must not contain the reserved sticky literal ${reservedInWhy}`,
        "invalid_allow_same_family",
      );
    }
    if (retryClassification !== undefined) {
      fail("--allow-same-family owns the retry classification and cannot be combined with --retry-classification", "invalid_retry_context");
    }
  }
  if (attempt === "initial" && (retryClassification !== undefined || retryStickyVerification !== undefined)) {
    fail("--retry-classification/--retry-sticky-verification apply only to a non-initial attempt", "invalid_retry_context");
  }
  if (attempt !== "initial" && ((retryClassification === undefined) !== (retryStickyVerification === undefined))) {
    fail(
      "--retry-classification and --retry-sticky-verification must be provided together: a half-filled retry_context would silently inherit the other default",
      "invalid_retry_context"
    );
  }
  if (attempt === "fault-recovery" && (retryClassification === undefined || retryStickyVerification === undefined)) {
    fail(
      "--attempt fault-recovery requires --retry-classification and --retry-sticky-verification: the re-dispatch must carry the fault classification and the sticky-verification state",
      "invalid_retry_context"
    );
  }
  return {
    prNumber,
    change,
    branch,
    selector: change ? "change" : "branch",
    lite,
    carrierRoot,
    primaryFamily,
    preferredReviewer,
    externalEvaluator,
    attempt,
    allowSameFamily,
    retryContext: allowSameFamily !== undefined
      ? { classification: `same_family_fallback:${allowSameFamily}`, sticky_verification: allowSameFamily }
      : {
        classification: retryClassification ?? "none",
        sticky_verification: retryStickyVerification ?? "not-needed",
      },
  };
}

// The same three attempts the renderer and validator accept (validate-second-review-packet.mjs allowedAttempts).
const SELECTABLE_ATTEMPTS = Object.freeze(["initial", "focused-sticky-refresh", "fault-recovery"]);
const SELECTABLE_ATTEMPTS_TEXT = "initial, focused-sticky-refresh, or fault-recovery";

// deepseek runs on the OpenCode CLI; it is reached only by naming it, never by default.
const SELECTABLE_REVIEWER_FAMILIES = Object.freeze(["codex", "claude", "deepseek"]);
const SELECTABLE_REVIEWER_FAMILIES_TEXT = "codex, claude, or deepseek (the OpenCode CLI)";
// The primary family is the host that produced the work; the renderer and validator accept these tokens, so the
// builder must not be narrower than them (issue #3436). `unknown` keeps the documented unproven-host path
// (sticky carries cross-model-unverified) reachable.
const SELECTABLE_PRIMARY_FAMILIES = Object.freeze(["codex", "claude", "deepseek", "unknown"]);
const SELECTABLE_PRIMARY_FAMILIES_TEXT = "codex, claude, deepseek, or unknown";
const PRIMARY_FAMILY_TOKENS = Object.freeze({ codex: "openai-codex", claude: "claude", deepseek: "deepseek", unknown: "unknown" });

export function selectReviewerFamily({ primaryFamily, envReviewer, preferredReviewer, allowSameFamily } = {}) {
  if (!SELECTABLE_PRIMARY_FAMILIES.includes(primaryFamily)) fail(`primary family must be ${SELECTABLE_PRIMARY_FAMILIES_TEXT}`, "invalid_primary_family");
  const chosen = [envReviewer, preferredReviewer].find((value) => typeof value === "string" && value.trim() !== "")
    ?? (primaryFamily === "codex" ? "claude" : "codex");
  if (!SELECTABLE_REVIEWER_FAMILIES.includes(chosen)) fail(`selected reviewer family must be ${SELECTABLE_REVIEWER_FAMILIES_TEXT}`, "invalid_reviewer_family");
  if (chosen === primaryFamily) {
    if (allowSameFamily === undefined) fail("same-family reviewer selection requires --allow-same-family <why>", "same_family_reviewer");
    return chosen;
  }
  if (allowSameFamily !== undefined) {
    fail("--allow-same-family applies only when the selected reviewer family equals the primary family", "invalid_allow_same_family");
  }
  return chosen;
}

export function assertCanonicalCarrierRoot(carrierRoot, root = repoRoot) {
  const expected = path.join(path.dirname(deriveMainCheckoutNotesTmp(root)), "cross-review");
  let expectedReal;
  let suppliedReal;
  try {
    expectedReal = realpathSync(expected);
    suppliedReal = realpathSync(path.resolve(carrierRoot));
    if (!statSync(suppliedReal).isDirectory()) throw new Error("not a directory");
  } catch {
    fail(`canonical carrier root must already exist as a directory: ${expected}`, "canonical_carrier_root_mismatch");
  }
  if (suppliedReal !== expectedReal) fail(`carrier root does not name the renderer canonical carrier root ${expected}`, "canonical_carrier_root_mismatch");
  return String(carrierRoot);
}

function run(command, args, { cwd = repoRoot, encoding = "utf8", env = process.env, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding, maxBuffer, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) fail(`${command} ${args[0] ?? ""} failed: ${result.error?.message ?? String(result.stderr ?? "").trim()}`, "source_read_failed");
  return result.stdout;
}

export function parseDoneWhen(proposal) {
  // A full proposal titles the section "Section 1: Target State (Done When)"; a B-mini proposal-mini uses "## Target State".
  const match = findExactH2Section(proposal, "Section 1: Target State (Done When)") ?? findExactH2Section(proposal, "Target State");
  if (!match) fail("PR-head proposal is missing Section 1: Target State (Done When) (or a B-mini Target State)", "proposal_evidence_missing");
  // The dp-architect template writes Section 1 as a numbered list, so `1.` / `1)` items count like `- * +` bullets.
  const items = [];
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/);
    if (item) items.push(item[1]);
  }
  if (items.length === 0) fail("PR-head proposal Done When has no acceptance bullets or numbered items", "proposal_evidence_missing");
  return items;
}

function proposalPathsAtHead(headSha, { cwd = repoRoot, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl("git", ["ls-tree", "-r", "--name-only", headSha, "--", "openspec/changes"], { cwd, encoding: "utf8", timeout: 30000 });
  if (result.error || result.status !== 0) fail("cannot enumerate PR-head proposal candidates", "proposal_head_unavailable");
  return String(result.stdout).split(/\r?\n/).filter((name) => changeNameFromProposalPath(name) !== null);
}

function proposalBlobAtHead(headSha, proposalPath, { cwd = repoRoot, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl("git", ["show", `${headSha}:${proposalPath}`], { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
  if (result.error || result.status !== 0) fail(`cannot read PR-head proposal blob ${proposalPath}`, "proposal_head_unavailable");
  return String(result.stdout);
}

// Every proposal.md / proposal-mini.md at the PR head for this change, active or archived. The change is told apart by
// its folder name (`<change>` or `archive/<date>-<change>`); no ledger or other proposal content is read.
export function findProposalPathsAtHead({ repoRoot: root = repoRoot, headSha, changeName, spawnSyncImpl = spawnSync } = {}) {
  if (!/^[a-f0-9]{40}$/.test(String(headSha ?? ""))) fail("PR head SHA is invalid", "proposal_head_unavailable");
  return proposalPathsAtHead(headSha, { cwd: root, spawnSyncImpl }).filter((proposalPath) => changeNameFromProposalPath(proposalPath) === changeName);
}

// `derivedFromBranch` is the live head branch when the change name was derived from `--branch` (not given by `--change`).
// A PR that carries no proposal of its own (lite, or chore A that only touches another change) lands on "found 0";
// only then does the refusal also name the way out, so the caller does not have to know that `--lite` exists.
export function readProposalAtHead({ repoRoot: root = repoRoot, headSha, changeName, derivedFromBranch, spawnSyncImpl = spawnSync } = {}) {
  const candidates = findProposalPathsAtHead({ repoRoot: root, headSha, changeName, spawnSyncImpl });
  const noProposalHint = candidates.length === 0 && typeof derivedFromBranch === "string" && derivedFromBranch !== ""
    ? `; if this PR has no OpenSpec change of its own (lite or chore A), re-run with --lite --branch ${derivedFromBranch} (Done When then comes from the checked acceptance-evidence bullets under the PR body Test Evidence), or with --change <name> if the proposal lives under a different change name`
    : "";
  if (candidates.length !== 1) fail(`expected exactly one PR-head proposal.md or proposal-mini.md for change ${changeName}, found ${candidates.length}${noProposalHint}`, "proposal_candidate_ambiguous");
  const content = proposalBlobAtHead(headSha, candidates[0], { cwd: root, spawnSyncImpl });
  return { path: candidates[0], content, doneWhen: parseDoneWhen(content) };
}

// A pull request whose three-dot diff is empty has nothing to embed, and the External Evaluator route needs a
// changed-file list too; say so instead of pointing at --external-evaluator.
export const ZERO_DIFF_REVIEW_MATERIAL_MESSAGE = "the pull request has no content diff against its base (the three-dot changed-file list is empty), so there is no review material and --external-evaluator does not apply; a zero-diff production ancestry repair (bugfix/fix-production-ancestry-* into main or a release/rules-* carrier, whose head merges an exact production-* tag) is exempt from cross-model review (the gates prove this from local git objects, so if a gate still asks for a second review of such a repair, run git fetch origin pull/<PR#>/head --tags and retry), and any other zero-diff pull request, including a repair into any other base, needs the user's Path W decision (see .devpro/agent-rules/code-review-cross-model.md)";

export function buildEmbeddedReviewMaterial(reviewScope, { repositorySlug, derive = null, listFiles = listChangedFilesForScope, spawnSyncImpl = spawnSync } = {}) {
  const changedSet = typeof derive === "function"
    ? derive(reviewScope, { repositorySlug, spawnSyncImpl })
    : derive ?? deriveAuthoritativeChangedSet(reviewScope, { repositorySlug, spawnSyncImpl });
  if (!changedSet || changedSet.head_sha !== reviewScope.head_sha) {
    const files = listFiles(reviewScope, { repositorySlug, spawnSyncImpl });
    if (Array.isArray(files) && files.length === 0) fail(ZERO_DIFF_REVIEW_MATERIAL_MESSAGE, "review_material_unavailable");
    fail("authoritative PR review material could not be derived for the bound head; if the PR raw diff exceeds the embed limit, re-run with --external-evaluator <tool> (see .devpro/agent-rules/second-review-external-evaluator.md)", "review_material_unavailable");
  }
  return {
    changed_files_or_touch_list: changedSet.paths,
    review_material: changedSet.raw_diff,
    review_material_proof: canonicalEmbeddedReviewMaterialProof(reviewScope, changedSet.raw_diff),
  };
}

function decodeUtf8Fatal(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return null; }
}

// Changed-file list only (git name-status), for the External Evaluator handoff that never embeds the raw diff.
// The comparison base is resolved the way deriveAuthoritativeChangedSet resolves it; null when anything cannot be proven,
// [] only when the diff is proven empty.
export function listChangedFilesForScope(reviewScope, { repositorySlug, spawnSyncImpl = spawnSync } = {}) {
  const cwd = SECOND_REVIEW_CANONICAL_REPOSITORY_ROOT;
  const probe = (command, args, maxBuffer = 1024) => spawnSyncImpl(command, args, {
    cwd,
    encoding: command === "gh" ? "utf8" : "buffer",
    timeout: command === "gh" ? SECOND_REVIEW_GH_PROBE_TIMEOUT_MS : SECOND_REVIEW_GIT_PROBE_TIMEOUT_MS,
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const headSha = reviewScope?.head_sha;
  if (!/^[a-f0-9]{40}$/.test(String(headSha ?? ""))) return null;
  const rootResult = probe("git", ["rev-parse", "--show-toplevel"]);
  try {
    if (rootResult.status !== 0 || realpathSync(String(rootResult.stdout ?? "").trim()) !== realpathSync(cwd)) return null;
  } catch { return null; }
  let baseSha;
  if (reviewScope.kind === "commit-range") {
    baseSha = reviewScope.base_sha;
  } else if (reviewScope.kind === "full-pr" && /^[^/\s]+\/[^/\s]+$/.test(String(repositorySlug ?? "")) && Number.isSafeInteger(reviewScope.pull_request_number)) {
    const prResult = probe("gh", ["pr", "view", String(reviewScope.pull_request_number), "--repo", repositorySlug, "--json", "baseRefOid,headRefOid"]);
    let resolved;
    try { resolved = JSON.parse(String(prResult.stdout ?? "")); } catch { return null; }
    if (prResult.status !== 0 || resolved?.headRefOid !== headSha) return null;
    baseSha = resolved.baseRefOid;
  } else {
    return null;
  }
  if (!/^[a-f0-9]{40}$/.test(String(baseSha ?? "")) || baseSha === headSha) return null;
  const mergeBaseResult = probe("git", ["merge-base", "--all", baseSha, headSha]);
  const mergeBaseText = decodeUtf8Fatal(mergeBaseResult.stdout);
  if (mergeBaseResult.status !== 0 || mergeBaseText === null) return null;
  const mergeBases = mergeBaseText.trimEnd().split("\n");
  if (mergeBases.length !== 1 || !/^[a-f0-9]{40}$/.test(mergeBases[0])) return null;
  if (reviewScope.kind === "commit-range" && mergeBases[0] !== baseSha) return null;
  const diffResult = probe("git", ["diff", "--name-status", "-z", ...SECOND_REVIEW_GIT_RENAME_COPY_FLAGS, mergeBases[0], headSha, "--"], 4 * 1024 * 1024);
  const nameStatus = diffResult.status === 0 ? decodeUtf8Fatal(diffResult.stdout) : null;
  if (nameStatus === null) return null;
  if (nameStatus === "") return [];
  return changedPathsFromGitDiff(nameStatus, { format: "name-status-z" });
}

export function assertPrMetadataStable(initial, final) {
  for (const key of ["number", "repository_slug", "head_branch", "head_sha", "body", "pr_base_sha", "title", "closing_issue_count"]) {
    if (initial?.[key] !== final?.[key]) fail(`PR metadata drift detected in ${key} before output`, "pr_metadata_drift");
  }
  return true;
}

export function assertCompleteStickySnapshot(snapshot) {
  const completeness = snapshot?.completeness;
  if (snapshot?.query_error !== null
    || completeness?.status !== "complete"
    || completeness?.pagination_exhausted !== true
    || !Number.isSafeInteger(completeness?.pages_fetched)
    || completeness.pages_fetched < 1
    || !Array.isArray(snapshot?.comments)) {
    fail("sticky comments snapshot is incomplete or malformed", "sticky_snapshot_incomplete");
  }
  if (!snapshot.comments.every((comment) => (
    normalizeSecondReviewStickyCandidate(comment, snapshot.repository_slug, snapshot.pr_number).error === undefined
  ))) {
    fail("sticky comments snapshot is incomplete or malformed", "sticky_snapshot_incomplete");
  }
  return snapshot;
}

// The shared rules decide what is wrong (lib/pr-body-evidence-rules.mjs); the builder stops at the first finding.
function reportedEvidence(body, field) {
  const [refused] = evidenceFieldFindings(body, field);
  if (refused) fail(formatEvidenceFinding(refused), refused.classification);
  return extractEvidenceText(body, PR_EVIDENCE_FIELDS[field]);
}

function metadataFromGh(pr, repositorySlug) {
  const expectedSlug = typeof repositorySlug === "string" ? repositorySlug.toLowerCase() : "";
  const [expectedOwner, expectedName] = expectedSlug.split("/");
  const headRepository = pr?.headRepository;
  const owner = pr?.headRepositoryOwner?.login;
  const name = headRepository?.name;
  const suppliedSlugs = [];

  if (headRepository?.nameWithOwner !== undefined) {
    const value = headRepository.nameWithOwner;
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
      fail("PR head repository metadata is invalid", "pr_repository_mismatch");
    }
    suppliedSlugs.push(value.toLowerCase());
  }
  if (owner !== undefined && (typeof owner !== "string" || !/^[A-Za-z0-9_.-]+$/.test(owner))) {
    fail("PR head repository owner metadata is invalid", "pr_repository_mismatch");
  }
  if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(name))) {
    fail("PR head repository name metadata is invalid", "pr_repository_mismatch");
  }
  if (owner !== undefined && owner.toLowerCase() !== expectedOwner) {
    fail("PR head must be in this repository", "pr_repository_mismatch");
  }
  if (name !== undefined && name.toLowerCase() !== expectedName) {
    fail("PR head must be in this repository", "pr_repository_mismatch");
  }
  if (owner !== undefined && name !== undefined) suppliedSlugs.push(`${owner}/${name}`.toLowerCase());

  if (!expectedSlug || pr?.isCrossRepository !== false || suppliedSlugs.length === 0 || suppliedSlugs.some((slug) => slug !== expectedSlug)) {
    fail("PR head must be in this repository", "pr_repository_mismatch");
  }
  if (!Number.isSafeInteger(pr.number) || !/^[a-f0-9]{40}$/.test(String(pr.headRefOid ?? ""))) fail("PR metadata has invalid number or head SHA", "pr_metadata_invalid");
  // `pr_base_sha` is the base commit GitHub records for the pull request. It is passed through as read: the reader that
  // uses it for the consumer rules checks its format, so a response without the field is not refused here.
  return {
    number: pr.number,
    repository_slug: repositorySlug,
    head_branch: String(pr.headRefName ?? ""),
    head_sha: pr.headRefOid,
    pr_base_sha: pr.baseRefOid,
    body: String(pr.body ?? ""),
    title: String(pr.title ?? ""),
    closing_issue_count: Array.isArray(pr.closingIssuesReferences) ? pr.closingIssuesReferences.length : 0,
    raw: pr,
  };
}

// An issue is referenced the way GitHub links it: `#N`, `owner/repo#N` or an issue URL (a closing keyword is followed by
// one of these), outside code and HTML comments, which GitHub does not link. A pull request whose closing references
// GitHub records is linked even when its text names no issue. `comments` are the PR comment bodies the caller already
// holds; the reviewer's own sticky comment is not an author reference and is left out by the caller. The result is a
// mode token only: the reviewer discovers and reads the issues itself through the shared linked-issue route
// (cross-runtime-parity).
const ISSUE_REFERENCE = /(?:^|[^\w&/#])(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9][0-9]*(?!\w)|https?:\/\/[^\s)>\]]*\/issues\/[1-9][0-9]*(?!\w)/;
export function deriveLinkedIssueContext({ title = "", body = "", closingIssueCount = 0, comments = [] } = {}) {
  if (Number.isSafeInteger(closingIssueCount) && closingIssueCount > 0) return "issue_read_required";
  for (const text of [title, body, ...(Array.isArray(comments) ? comments : [])]) {
    if (typeof text !== "string") continue;
    const live = neutraliseInertMarkdown(String(text ?? "")).replace(/(`+)[^\n]*?\1(?!`)/g, " ");
    if (ISSUE_REFERENCE.test(live)) return "issue_read_required";
  }
  return "none";
}

export function readPrMetadata(prNumber, repositorySlug = null, { runImpl = run } = {}) {
  const slug = repositorySlug ?? JSON.parse(String(runImpl("gh", ["repo", "view", "--json", "nameWithOwner"])))?.nameWithOwner;
  if (typeof slug !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) fail("current GitHub repository identity is missing or invalid", "pr_repository_mismatch");
  const args = ["pr", "view", String(prNumber), "--repo", slug, "--json", "number,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner,body,title,url,state,baseRefOid,closingIssuesReferences"];
  const raw = JSON.parse(String(runImpl("gh", args)));
  return metadataFromGh(raw, slug);
}

// Control characters and empty or unfilled text refuse here; the byte limit is checked by assertHandoffWithinRendererLimits.
function requireScopeSummary(body) {
  const refused = changeContextFindings(body).find((item) => item.kind !== "over-limit");
  if (refused) fail(formatEvidenceFinding(refused), refused.classification);
  return extractScopeSummary(body);
}

// The renderer/validator rejects a handoff whose scope_summary or done_when exceed these
// limits, but only after the slow live reads. Read them from the validator (single source)
// and refuse here, naming the field, its size and the limit, so the fix is one edit.
export const RENDERER_HANDOFF_LIMITS = Object.freeze({
  scopeSummaryMaxBytes: SCOPE_SUMMARY_MAX_BYTES,
  doneWhenMaxItems: DONE_WHEN_MAX_ITEMS,
  doneWhenItemMaxBytes: DONE_WHEN_ITEM_MAX_BYTES,
});

// `doneWhenSource` names where the author edits the bullets: the proposal on the ledger path, the PR body under lite.
export function assertHandoffWithinRendererLimits({ scopeSummary, doneWhen, doneWhenSource = "the proposal's Section 1" }) {
  const { doneWhenMaxItems, doneWhenItemMaxBytes } = RENDERER_HANDOFF_LIMITS;
  const summaryOver = scopeSummaryOverLimit(scopeSummary);
  if (summaryOver) {
    fail(`scope_summary is ${summaryOver.bytes} UTF-8 bytes; renderer limit is ${summaryOver.limit} (about ${Math.floor(summaryOver.limit / 3)} CJK characters): shorten the PR ## Change Context, then re-run the builder`, "handoff_limit_exceeded");
  }
  if (doneWhen.length > doneWhenMaxItems) {
    fail(`done_when has ${doneWhen.length} items; renderer limit is ${doneWhenMaxItems}: merge acceptance bullets in ${doneWhenSource}, then re-run the builder`, "handoff_limit_exceeded");
  }
  doneWhen.forEach((item, index) => {
    const itemBytes = Buffer.byteLength(item, "utf8");
    if (itemBytes > doneWhenItemMaxBytes) {
      fail(`done_when[${index}] is ${itemBytes} UTF-8 bytes; renderer limit is ${doneWhenItemMaxBytes}: shorten that acceptance bullet in ${doneWhenSource}, then re-run the builder`, "handoff_limit_exceeded");
    }
  });
}

// ---- workflow=lite: no OpenSpec proposal ----------------------------------------------------------
// `--lite` serves a change that has no proposal. It needs no grant, ledger or approval evidence, and `done_when` is
// the checked acceptance evidence of the PR body `## Test Evidence`.
const LITE_CHECKBOX_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;

export function parseLiteDoneWhen(body) {
  const lines = sectionBody(body, "Test Evidence").split(/\r?\n/);
  const marker = lines.findIndex((line) => line.includes("驗收證據"));
  const checked = [];
  let unchecked = 0;
  if (marker !== -1) {
    for (const line of lines.slice(marker + 1)) {
      const item = line.match(LITE_CHECKBOX_RE);
      if (!item) continue;
      if (item[1] === " ") unchecked += 1;
      else checked.push(item[2]);
    }
  }
  if (checked.length === 0 || unchecked > 0) fail("PR body Test Evidence needs a 驗收證據 line followed by checkbox bullets, at least one and every one checked ([x]); they become done_when", "lite_acceptance_missing");
  return checked;
}

// The PR body `## OpenSpec` section must name the proposal the builder matched.
function assertOpenspecNamesProposal(meta, proposal) {
  const openspec = sectionBody(meta.body, "OpenSpec");
  const proposalDirectory = `${path.posix.dirname(proposal.path)}/`;
  if (!openspec.includes(proposal.path) && !openspec.includes(proposalDirectory)) fail("PR body OpenSpec section does not name the matched PR-head proposal", "proposal_body_mismatch");
}

export function writeAtomicHandoff(root, prNumber, handoff) {
  const serialized = `${JSON.stringify(handoff, null, 2)}\n`;
  const contentHash = createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 16);
  const target = path.join(root, `handoff-pr-${prNumber}-r1-${contentHash}.json`);
  if (existsSync(target)) {
    const existing = lstatSync(target);
    // Windows reports 0o666 for every ordinary file (access is governed by the ACL, not Stats.mode),
    // so the mode comparison is POSIX-only; file type and byte-identical content are checked everywhere.
    const modeMismatch = process.platform !== "win32" && (existing.mode & 0o777) !== 0o600;
    if (!existing.isFile() || modeMismatch || readFileSync(target, "utf8") !== serialized) fail("existing content-addressed handoff is not identical mode-0600 content", "handoff_output_collision");
    return target;
  }
  const tempPath = path.join(root, `.handoff-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, serialized, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    // link is exclusive: an existing target is never replaced.
    linkSync(tempPath, target);
    unlinkSync(tempPath);
    return target;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tempPath); } catch {}
    if (error.code === "EEXIST" && existsSync(target)) {
      const existing = lstatSync(target);
      if (existing.isFile() && (existing.mode & 0o777) === 0o600 && readFileSync(target, "utf8") === serialized) return target;
    }
    throw error;
  }
}

// True only when `baseSha` is a commit this checkout knows and `headSha` descends
// from it. An unknown commit or a rebased head is "not an ancestor": the caller
// then reviews the full PR instead of a range that cannot be proven.
export function isCommitAncestor(baseSha, headSha, { cwd = repoRoot, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl("git", ["merge-base", "--is-ancestor", baseSha, headSha], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

// Once a READY sticky (PASS/WARN) exists for the PR, the renderer refuses a
// full-pr scope unless it is narrowed to the commits added since that review or
// carries a full_scope_reason. The narrowing base is derived here from that same
// sticky rather than passed in by the caller, so a hand-typed sha cannot drift from
// what was actually reviewed. Anything that cannot be proven a clean extension of
// the reviewed head (same head, abbreviated sha, rebase, unknown commit) falls back
// to the full PR with a reason the renderer accepts (8..200 printable ASCII).
export function selectReviewScope({ prNumber, headSha, stickySnapshot, isAncestor = isCommitAncestor }) {
  const fullPr = { kind: "full-pr", pull_request_number: prNumber, head_sha: headSha };
  const baseline = resolveReadyStickyBaseline(stickySnapshot);
  if (baseline === null) return { reviewScope: fullPr };
  const baseSha = baseline.last_reviewed_sha;
  if (!/^[a-f0-9]{40}$/.test(baseSha)) {
    return { reviewScope: fullPr, fullScopeReason: "last reviewed sha is not a full commit sha; reviewing the full PR" };
  }
  if (baseSha === headSha) {
    return { reviewScope: fullPr, fullScopeReason: "head equals the last reviewed sha; re-reviewing the full PR" };
  }
  if (!isAncestor(baseSha, headSha)) {
    return { reviewScope: fullPr, fullScopeReason: "head does not descend from the last reviewed sha (rebase); reviewing the full PR" };
  }
  return { reviewScope: { kind: "commit-range", base_sha: baseSha, head_sha: headSha } };
}

// ---- Consumer second-review rules (.devpro/second-review-rules.local.md) ----------------------------------
// The markdown file is read from the base commit GitHub records for the pull request (`pr_base_sha`), never from the
// working tree, the pull request head or `review_scope.base_sha` (a commit-range base is a commit inside the pull
// request, so the pull request could rewrite the rules it is judged by). Every git call uses a fixed argument array without a
// shell and only reads: rule text never reaches a command line, and nothing here fetches.
const RULES_GIT_MAX_BUFFER = 16 * 1024 * 1024;
const RULES_NOT_WRITTEN_SENTENCE = "No handoff was written by this run; do not render a review packet from an earlier handoff file.";
const FULL_SHA_RE = /^[a-f0-9]{40}$/;

// Every failure raised while reading or checking the rules ends with the same fixed sentence.
function rulesFail(message, classification) {
  return fail(`${classification}: ${message}. ${RULES_NOT_WRITTEN_SENTENCE}`, classification);
}

function rulesGit(args, { cwd, spawnSyncImpl }) {
  return spawnSyncImpl("git", args, { cwd, encoding: "buffer", timeout: 30000, maxBuffer: RULES_GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
}

// Returns stdout bytes; any spawn error or non-zero status stops the build (a failed read is never "no rules").
function rulesGitOutput(args, io) {
  const result = rulesGit(args, io);
  if (result.error || result.status !== 0) {
    rulesFail(`git ${args[0]} failed while reading the consumer review rules (${result.error?.code ?? `exit status ${result.status}`}); the rules cannot be read, and a failed read is not treated as no rules. Check the local repository, then re-run the builder`, "source_read_failed");
  }
  return Buffer.from(result.stdout ?? []);
}

// The tree entry for the rules path at `rev`, or null when that commit has no such path.
function rulesTreeEntry(rev, io) {
  const output = rulesGitOutput(["ls-tree", "-z", rev, "--", CONSUMER_SECOND_REVIEW_RULES_REL], io).toString("utf8");
  if (output === "") return null;
  const record = output.split("\0").find((item) => item !== "");
  const match = record?.match(/^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/);
  if (!match || match[4] !== CONSUMER_SECOND_REVIEW_RULES_REL) {
    rulesFail("git ls-tree returned an unreadable entry for the consumer review rules; the rules cannot be read, and a failed read is not treated as no rules", "source_read_failed");
  }
  return { mode: match[1], type: match[2], oid: match[3] };
}

const rulesEntryKey = (entry) => (entry === null ? "absent" : `${entry.mode} ${entry.type} ${entry.oid}`);
// A directory, symbolic link or submodule is never read: only a regular file blob can hold the rules.
const isRegularRulesEntry = (entry) => entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");

// Checks the version behind a tree entry (null = the commit has no such path). `text` is the file as decoded, the empty
// string when there is no usable text.
function loadRulesVersion(entry, io) {
  if (entry === null) return { text: "", problems: [] };
  if (!isRegularRulesEntry(entry)) {
    return { text: "", problems: [{ code: "not-a-regular-file", detail: entry.mode, blocking: true }] };
  }
  return checkConsumerReviewRulesBytes(rulesGitOutput(["cat-file", "blob", entry.oid], io));
}

// The base commit must be in the local object store: a missing commit is a stop, never "no rules", and the builder
// does not fetch it (a fetch writes to the repository and needs the network). Full-pr scope normally stopped earlier,
// because deriving its review material needs the same commit; commit-range scope reaches this check first.
function assertRulesBaseCommitIsLocal(prBaseSha, io) {
  const result = rulesGit(["cat-file", "-e", `${prBaseSha}^{commit}`], io);
  if (result.error) {
    rulesFail(`git cat-file could not run while reading the consumer review rules (${result.error.code ?? "spawn error"}); the rules cannot be read, and a failed read is not treated as no rules. Check the local repository, then re-run the builder`, "source_read_failed");
  }
  if (result.status === 0) return;
  rulesFail(`pull request base commit ${prBaseSha} is not in the local repository; consumer review rules are read from that commit, and a missing commit is not treated as no rules. Run \`git fetch origin ${prBaseSha}\` (use your remote name if it is not origin), then re-run the builder. If that fetch fails, merge the latest base branch into the pull request branch and re-run`, "source_read_failed");
}

const RULES_PROBLEM_LIST_LIMIT = 5;
// The base version is what every pull request is judged by, so the repair is a pull request that this same check stops
// while the base stays invalid: how it is released is the repository owner's call (design D4; no AI waiver).
const RULES_BASE_NEXT_STEP = "repair the file in a new pull request; while this base version is invalid that pull request is stopped by the same check, so the repository owner decides how it is merged: a Path W waiver comment left in GitHub by an OWNER, MEMBER or COLLABORATOR, or, when the fix is on a chore/ branch with no OpenSpec proposal, the existing chore/ exemption; once the fix is merged, pull requests opened later recover at once, and a pull request that is already open needs the latest base branch merged or rebased into it before the builder runs again (if this message still names the same base commit after that, ask the owner for a Path W waiver on that pull request or, once the user has closed the old pull request, open a new pull request from the same branch)";
const RULES_HEAD_NEXT_STEP = "fix the rules file in this pull request, push, then re-run the builder";

function describeRulesProblem(problem) {
  switch (problem.code) {
    case "too-large": return `too-large in the whole file: ${problem.detail} bytes, limit ${CONSUMER_SECOND_REVIEW_RULES_MAX_BYTES}`;
    case "pii-or-secret-pattern": return `pii-or-secret-pattern at line ${problem.line}: matches ${problem.detail}`;
    case "not-a-regular-file": return `not-a-regular-file in the whole file: tree entry mode ${problem.detail}`;
    default: return `${problem.code} in the whole file`;
  }
}

// The one named refusal for an unusable file. It names codes and places only, never the text of the file (it may
// hold a credential), and it is raised before anything is written.
function stopOnInvalidRules(side, commitSha, problems) {
  const groups = new Map();
  for (const problem of problems.filter((item) => item.blocking)) groups.set(problem.code, [...(groups.get(problem.code) ?? []), problem]);
  const listed = [...groups.values()].flatMap((group) => [
    ...group.slice(0, RULES_PROBLEM_LIST_LIMIT).map(describeRulesProblem),
    ...(group.length > RULES_PROBLEM_LIST_LIMIT ? [`(+${group.length - RULES_PROBLEM_LIST_LIMIT} more)`] : []),
  ]);
  const hints = [...groups.keys()].map((code) => `${code}: ${CONSUMER_SECOND_REVIEW_RULES_PROBLEM_HINTS[code]}`);
  const nextStep = side === "base" ? RULES_BASE_NEXT_STEP : RULES_HEAD_NEXT_STEP;
  rulesFail(`${CONSUMER_SECOND_REVIEW_RULES_REL} at ${side} commit ${commitSha.slice(0, 12)}: ${listed.join("; ")}; ${hints.join("; ")}; ${nextStep}`, "consumer_review_rules_invalid");
}

// Every execution mode. The text goes into the review packet in a runner packet as much as in an external evaluator
// packet, so a PII or secret pattern stops both. The packet renderer refuses the same patterns on the external
// path (external_ticket_unsafe_value) but names a zero-based review_data path; the same pattern functions are applied here
// per physical line so the refusal names the 1-based line number and a category, never the matched text. Kept in the
// builder, not the integrity check, so that check stays free of the two pattern libraries. Runs only over a version that
// passed the integrity check: a blocking problem already stops the build, and the patterns then never run over more than
// the byte limit allows.
function piiOrSecretPatternProblems({ text, problems }) {
  if (problems.some((item) => item.blocking)) return [];
  return text.split(/\r\n|\n|\r/).flatMap((lineText, index) => {
    const categories = [
      ...findPIIHits(lineText).map((hit) => `pii:${hit.type}`),
      ...findSecretHits(lineText).map((hit) => `secret:${hit.category}`),
    ];
    return [...new Set(categories)].map((category) => ({ code: "pii-or-secret-pattern", line: index + 1, detail: category, blocking: true }));
  });
}

// Did the pull request itself change the rules file? Compared at the merge base of the base record and the head, so a
// change the base branch made after the fork is not charged to this pull request. When the merge base is not unique
// (or cannot be computed) the comparison is the stricter one: the base record against the head.
function pullRequestChangedRulesFile(prBaseSha, headSha, headEntry, io) {
  let reference = prBaseSha;
  const result = rulesGit(["merge-base", "--all", prBaseSha, headSha], io);
  if (!result.error && result.status === 0) {
    const mergeBases = Buffer.from(result.stdout ?? []).toString("utf8").split("\n").filter((line) => line !== "");
    if (mergeBases.length === 1 && FULL_SHA_RE.test(mergeBases[0])) reference = mergeBases[0];
  }
  return rulesEntryKey(rulesTreeEntry(reference, io)) !== rulesEntryKey(headEntry);
}

/**
 * Reads the consumer second-review rules recorded at the pull request base commit and returns the markdown text of the
 * file unchanged (the empty string when the commit has no file or the file holds only whitespace).
 */
export function readConsumerSecondReviewRules({ prBaseSha, headSha } = {}, { cwd = repoRoot, spawnSyncImpl = spawnSync } = {}) {
  const io = { cwd, spawnSyncImpl };
  if (!FULL_SHA_RE.test(String(prBaseSha ?? ""))) {
    rulesFail("the pull request metadata has no valid base commit record (baseRefOid must be 40 lowercase hex); the consumer review rules cannot be read, and a missing record is not treated as no rules. Re-run the builder; if it persists, check the pull request on GitHub", "source_read_failed");
  }
  if (!FULL_SHA_RE.test(String(headSha ?? ""))) {
    rulesFail("the pull request head commit is missing or is not 40 lowercase hex; the consumer review rules cannot be checked against it, and a missing head is not treated as no rules. Re-run the builder", "source_read_failed");
  }
  assertRulesBaseCommitIsLocal(prBaseSha, io);
  const baseVersion = loadRulesVersion(rulesTreeEntry(prBaseSha, io), io);
  const baseProblems = [...baseVersion.problems, ...piiOrSecretPatternProblems(baseVersion)];
  if (baseProblems.some((problem) => problem.blocking)) stopOnInvalidRules("base", prBaseSha, baseProblems);
  // A pull request that rewrites the file is judged by the base version, but a broken head version is stopped here, in
  // that pull request, before it can reach the base branch. The head version never enters the handoff.
  const headEntry = rulesTreeEntry(headSha, io);
  if (headEntry !== null && pullRequestChangedRulesFile(prBaseSha, headSha, headEntry, io)) {
    const headVersion = loadRulesVersion(headEntry, io);
    const headProblems = [...headVersion.problems, ...piiOrSecretPatternProblems(headVersion)];
    if (headProblems.some((problem) => problem.blocking)) stopOnInvalidRules("head", headSha, headProblems);
  }
  return baseVersion.text;
}

export async function buildPrStickyHandoff(options) {
  const { argv = process.argv.slice(2), env = process.env, primaryFamily: injectedFamily = null, cwd = repoRoot, dependencies = {} } = options ?? {};
  const getMetadata = dependencies.readPrMetadata ?? readPrMetadata;
  const getProposal = dependencies.readProposalAtHead ?? readProposalAtHead;
  const getProposalPaths = dependencies.findProposalPathsAtHead ?? findProposalPathsAtHead;
  const getMaterial = dependencies.buildEmbeddedReviewMaterial ?? buildEmbeddedReviewMaterial;
  const getChangedFiles = dependencies.listChangedFiles ?? listChangedFilesForScope;
  const getStickySnapshot = dependencies.liveStickyAuthoritySnapshot ?? liveStickyAuthoritySnapshot;
  const getConsumerRules = dependencies.readConsumerSecondReviewRules ?? readConsumerSecondReviewRules;
  const validateCarrierRoot = dependencies.assertCanonicalCarrierRoot ?? assertCanonicalCarrierRoot;
  const args = injectedFamily ? [...argv, "--primary-family", injectedFamily] : [...argv];
  const parsed = parseBuilderArgs(args);
  if (cwd !== repoRoot) fail("builder must resolve canonical sources from this repository root", "invalid_repository_root");
  const carrierRoot = validateCarrierRoot(parsed.carrierRoot, cwd);
  const reviewer = selectReviewerFamily({ primaryFamily: parsed.primaryFamily, envReviewer: env.CROSS_MODEL_REVIEWER, preferredReviewer: parsed.preferredReviewer, allowSameFamily: parsed.allowSameFamily });
  const primaryFamily = PRIMARY_FAMILY_TOKENS[parsed.primaryFamily];
  const reviewerFamily = reviewer;
  const initial = getMetadata(parsed.prNumber);
  if (initial.number !== parsed.prNumber) fail("PR metadata number does not match the requested selector", "pr_number_mismatch");
  // The --branch selector must name the live head branch on both paths; the change identity is always taken from
  // --change or from that live branch, never from a proposal's own content.
  if (parsed.branch !== undefined && initial.head_branch !== parsed.branch) fail("PR head branch does not equal --branch", "invalid_selector");
  const changeName = parsed.change ?? deriveChangeNameFromBranch(initial.head_branch);
  let doneWhen;
  if (parsed.lite) {
    // The explicit switch selects lite PR evidence; ambient rigor does not choose this builder path.
    const proposalPaths = getProposalPaths({ repoRoot: cwd, headSha: initial.head_sha, changeName });
    if (proposalPaths.length !== 0) fail(`PR head already carries ${proposalPaths.join(", ")} for change ${changeName}; run the builder without --lite so the proposal path applies`, "lite_proposal_present");
    doneWhen = parseLiteDoneWhen(initial.body);
  } else {
    const proposal = getProposal({ repoRoot: cwd, headSha: initial.head_sha, changeName, ...(parsed.change === undefined ? { derivedFromBranch: initial.head_branch } : {}) });
    assertOpenspecNamesProposal(initial, proposal);
    doneWhen = proposal.doneWhen;
  }
  const scopeSummary = requireScopeSummary(initial.body);
  assertHandoffWithinRendererLimits({
    scopeSummary,
    doneWhen,
    ...(parsed.lite ? { doneWhenSource: "the PR body Test Evidence 驗收證據 bullets" } : {}),
  });
  const stickySnapshot = assertCompleteStickySnapshot(getStickySnapshot({ repository_slug: initial.repository_slug, pr_number: parsed.prNumber }));
  if (stickySnapshot.repository_slug !== initial.repository_slug || stickySnapshot.pr_number !== parsed.prNumber) fail("sticky snapshot PR binding does not match metadata", "sticky_snapshot_mismatch");
  const { reviewScope, fullScopeReason } = selectReviewScope({
    prNumber: parsed.prNumber,
    headSha: initial.head_sha,
    stickySnapshot,
    isAncestor: dependencies.isCommitAncestor ?? isCommitAncestor,
  });
  const external = parsed.externalEvaluator !== undefined;
  let reviewMaterial;
  if (external) {
    const files = getChangedFiles(reviewScope, { repositorySlug: initial.repository_slug });
    if (Array.isArray(files) && files.length === 0) fail(ZERO_DIFF_REVIEW_MATERIAL_MESSAGE, "review_material_unavailable");
    if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string" || file === "") || new Set(files).size !== files.length) {
      fail("changed file list could not be derived for the bound head", "review_material_unavailable");
    }
    reviewMaterial = { changed_files_or_touch_list: files, review_material: "", review_material_proof: canonicalAdapterRouteProof(reviewScope) };
  } else {
    reviewMaterial = getMaterial(reviewScope, { repositorySlug: initial.repository_slug });
  }
  const primaryValidation = reportedEvidence(initial.body, "primary_validation_evidence");
  const primaryTests = reportedEvidence(initial.body, "primary_test_evidence");
  // After the review material, so a full-pr scope whose base commit is not local keeps its existing stop; before the
  // final metadata read, so the stability check covers the base record this read depends on.
  const consumerRules = getConsumerRules({ prBaseSha: initial.pr_base_sha, headSha: initial.head_sha }, { cwd });
  const final = getMetadata(parsed.prNumber, initial.repository_slug);
  assertPrMetadataStable(initial, final);
  const standardHandoff = {
    mode: "pr-sticky",
    attempt: parsed.attempt,
    primary_family: primaryFamily,
    reviewer_family: reviewerFamily,
    preferred_reviewer: reviewerFamily,
    target: `PR #${parsed.prNumber}`,
    head_ref_oid: initial.head_sha,
    repository_slug: initial.repository_slug,
    change_name: changeName,
    approval_context: PR_STICKY_APPROVAL_CONTEXT,
    approval_resolution: fixedApprovalResolution(),
    scope_summary: scopeSummary,
    changed_files_or_touch_list: reviewMaterial.changed_files_or_touch_list,
    review_scope: reviewScope,
    ...(fullScopeReason === undefined ? {} : { full_scope_reason: fullScopeReason }),
    page_window_max_pages: 1,
    review_material_carrier: "embedded-diff",
    review_material_capability: "scope-bound-embedded-complete-diff-v1",
    review_material_proof: reviewMaterial.review_material_proof,
    review_material: reviewMaterial.review_material,
    primary_validation_evidence: primaryValidation,
    primary_test_evidence: primaryTests,
    done_when: doneWhen,
    ...(consumerRules === "" ? {} : { reviewer_constraints: consumerRules }),
    linked_issue_context: deriveLinkedIssueContext({
      title: initial.title,
      body: initial.body,
      closingIssueCount: initial.closing_issue_count,
      comments: stickySnapshot.comments.map((comment) => comment?.body).filter((text) => typeof text === "string" && !text.includes(SECOND_REVIEW_STICKY_MARKER)),
    }),
    primary_verdict: "none",
    retry_context: parsed.retryContext,
    sticky_authority_snapshot: stickySnapshot,
    write_path: "none",
    allowed_tools: "none",
  };
  // The External Evaluator handoff is the standard one with live-read material fields and the two trailing executor keys.
  const { page_window_max_pages: _embedOnly, ...withoutPageWindow } = standardHandoff;
  const handoff = external
    ? {
      ...withoutPageWindow,
      review_material_carrier: "external-live-reads",
      review_material_capability: EXTERNAL_LIVE_CAPABILITY[reviewScope.kind],
      executor_kind: EXTERNAL_EVALUATOR_EXECUTOR_KIND,
      reviewer_tool: parsed.externalEvaluator,
    }
    : standardHandoff;
  // Two optional keys: `full_scope_reason` right after `review_scope`, `reviewer_constraints` right after `done_when`.
  const baseKeys = external ? EXTERNAL_HANDOFF_KEYS : HANDOFF_KEYS;
  const expectedKeys = baseKeys.flatMap((key) => {
    if (key === "review_scope" && fullScopeReason !== undefined) return [key, "full_scope_reason"];
    if (key === "done_when" && consumerRules !== "") return [key, "reviewer_constraints"];
    return [key];
  });
  if (Object.keys(handoff).join("\0") !== expectedKeys.join("\0")) fail("handoff ordered key contract drifted", "handoff_contract_invalid");
  const outputPath = writeAtomicHandoff(carrierRoot, parsed.prNumber, handoff);
  return outputPath;
}

// The output mapping of the CLI: a success prints the handoff path and exits 0; a failure prints only the message to
// stderr and exits 1, so a stopped build never prints a path. Returns a Promise of the exit code (`buildPrStickyHandoff`
// is async, so this cannot be the synchronous shape of `runCli`).
export async function runBuilderCli({ argv, build = buildPrStickyHandoff, stdout = process.stdout, stderr = process.stderr }) {
  try {
    const output = await build({ argv });
    stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

async function main() {
  process.exitCode = await runBuilderCli({ argv: process.argv.slice(2) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main();
