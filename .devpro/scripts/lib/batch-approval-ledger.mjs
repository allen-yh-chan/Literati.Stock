/**
 * batch-approval-ledger.mjs
 *
 * Shared read/judgment logic for the `## Batch Approval Ledger` H2 section
 * carried by `proposal.md` / `proposal-mini.md` (see
 * `openspec/changes/enforce-batch-scope-ledger-presence/design.md` D2/D3).
 *
 * Two entry points, deliberately asymmetric in strength:
 *
 * - `evaluateBatchApprovalLedgerIdentity`: full-field identity comparison
 *   (against the caller's known `changeName` / `branch`) for pre-write gates,
 *   where "current branch + current change name" is a trustworthy basis.
 *   Returns an issue string plus an N/A flag; callers decide polarity
 *   (N/A -> pass or block) themselves — this function never hard-codes that
 *   decision.
 * - `evaluateBatchApprovalLedgerShape`: identity-independent structural check
 *   for archive-time enforcement, where "current branch" is no longer a
 *   trustworthy basis (the archived change's branch need not be the branch
 *   the archive check is running on). Returns `absent` / `shapeless` / `ok`.
 *
 * Two single-line carriers of the Step 0 batch conclusion share this module:
 * the full ledger above, and (lite rigor, no proposal) the one-line untracked
 * `openspec/changes/<change>/lite-scope.md` record judged by
 * `evaluateLiteScopeRecord` (see `openspec/changes/remove-second-review-disclosure-approval`
 * design.md D3/D5). Neither carrier may list a retired ledger item
 * (`LEGACY_DISCLOSURE_LEDGER_TOKENS`): those items no longer exist, so the
 * fix is to delete them.
 *
 * `extractH2Section` is hosted here because its only caller inside
 * `pre-tool-gate.mjs` is the ledger-inspection path this module now owns.
 * The other `extractH2Section` copies in the repo (`recap-body-template-check.mjs`,
 * `pre-pr-body-template-check.mjs`, `hook-payload-sync.test.mjs`) extract
 * different targets and are intentionally left untouched (see design.md T3).
 */

import { lstatSync, readFileSync } from "node:fs";

// 只用來挑「要讀 active 還是 archive 的那一份」；symlink／非檔案都當作不存在，實際判定仍在下面用 lstat。
const existsSyncFile = (target) => {
  try {
    return lstatSync(target).isFile();
  } catch {
    return false;
  }
};
import path from "node:path";
import { escapeRegExp } from "./primitives.mjs";
import { extractLiveH2Section } from "./markdown-fence-aware.mjs";

// Anchored to a single line (not `.test(section)` against the whole section):
// a populated structured ledger that merely *mentions* this sentinel string
// in passing (e.g. a comment warning against writing it) must not be
// downgraded to N/A, and a shapeless ledger must not be laundered into `ok`
// by the same stray mention — both are the same class of bypass as F-1-1
// (see decisions.md). Recognizing the sentinel only as the section's first
// non-blank line rules out both directions.
//
// `\b` word boundary, NOT `$` end-of-line anchor: real archived N/A ledgers
// routinely append scope-narrowing prose after the sentinel on the same line
// (e.g. `N/A: no batch approval selected. 使用者本 session 授權…` or
// `N/A: no batch approval selected（custom local-only：…）`) — 3 of 4 sampled
// historical cases have trailing text. A full-line anchor would reject those
// as non-N/A, which is a false BLOCK on a legitimate stepwise conclusion (see
// dp-reviewer round-2 finding C-A in decisions.md).
const NA_SENTINEL_LINE_RE = /^N\/A:[\t ]*no batch approval selected\b/i;

function sectionIsNASentinel(section) {
  const firstNonBlank = section.split("\n").find((line) => line.trim() !== "");
  return firstNonBlank != null && NA_SENTINEL_LINE_RE.test(firstNonBlank.trim());
}

export function extractH2Section(content, heading) {
  return extractLiveH2Section(content, heading);
}

// Two equally-legal YAML shapes for the same list, checked in order:
//
// 1. Flow style on one line — `covers: [worktree, local_commit]` — real
//    historical ledgers use this (7 archives sampled; dp-reviewer round-3
//    finding I-1). Gate R1 fires on every implementation write regardless of
//    branch/session-pending state, unlike the narrowly-triggered Gate SP this
//    module's shape check used to serve alone — so an author who writes this
//    (template-legal, semantically complete) shape now gets blocked
//    mid-implementation by a message claiming `covers` is empty when it
//    plainly is not. Same false-block failure mode as C-A, on the structured
//    branch instead of the sentinel branch.
// 2. Block style — `covers:` then indented `- item` lines. `\r?\n`, not
//    `\n`: proposal/proposal-mini can be checked out with CRLF line endings
//    (e.g. a Windows consumer clone without `.gitattributes` coverage for
//    `.md` — see openspec/changes/archive/2026-08-22-fix-sync-crlf-phantom-dirty).
//    The sibling `## Why`/`## What Changes` regexes in pre-pr-archive-gate.mjs
//    use `\s*$` (CRLF-tolerant); this must match, not silently misjudge a
//    CRLF-checked-out structured ledger as `shapeless`/`has empty or missing
//    covers` (dp-reviewer round-2 finding C-B).
function yamlListHasEntries(section, key) {
  const flowMatch = new RegExp(`^${escapeRegExp(key)}:[\\t ]*\\[([^\\]]*)\\][\\t ]*$`, "m").exec(section);
  if (flowMatch) return /\S/.test(flowMatch[1]);
  const blockMatch = new RegExp(`^${escapeRegExp(key)}:[\\t ]*\\r?\\n((?:[\\t ]+-[\\t ]+\\S.*\\r?\\n?)+)`, "m")
    .exec(section);
  return Boolean(blockMatch?.[1]?.trim());
}

function yamlKeyPresent(section, key) {
  return new RegExp(`^${escapeRegExp(key)}:`, "m").test(section);
}

/**
 * Retired ledger items: they are no longer ledger items and are rejected so
 * they get deleted. Compared after lowercasing and replacing `-` with `_`, so
 * `Reviewer-Owned-Sticky-Write-Back` is the same token.
 */
export const LEGACY_DISCLOSURE_LEDGER_TOKENS = Object.freeze([
  "same_repo_exact_pr_external_disclosure",
  "reviewer_sticky_write_back",
  "reviewer_owned_sticky_write_back",
  "external_disclosure",
]);

/** Stable lead of the retired-item diagnostic, so gates can tell it from structural issues. */
export const LEGACY_DISCLOSURE_ISSUE_PREFIX = "has retired ledger item(s)";

function isLegacyDisclosureToken(item) {
  const normalized = String(item).trim().replace(/^['"]|['"]$/g, "").toLowerCase().replaceAll("-", "_");
  return LEGACY_DISCLOSURE_LEDGER_TOKENS.includes(normalized);
}

// Items of a `covers`/`excludes` list exactly as written (trimmed), flow or
// block style, with the same precedence as `yamlListHasEntries` (flow first).
function yamlListItems(section, key) {
  const flowMatch = new RegExp(`^${escapeRegExp(key)}:[\\t ]*\\[([^\\]]*)\\][\\t ]*$`, "m").exec(section);
  if (flowMatch) return flowMatch[1].split(",").map((entry) => entry.trim()).filter(Boolean);
  const blockMatch = new RegExp(`^${escapeRegExp(key)}:[\\t ]*\\r?\\n((?:[\\t ]+-[\\t ]+\\S.*\\r?\\n?)+)`, "m")
    .exec(section);
  if (!blockMatch) return [];
  return blockMatch[1].split(/\r?\n/)
    .map((line) => line.replace(/^[\t ]+-[\t ]+/, "").replace(/[\t ]+#.*$/, "").trim())
    .filter(Boolean);
}

// Retired items in `covers` then `excludes`, as written in the ledger.
function findLegacyDisclosureItems(section) {
  return ["covers", "excludes"].flatMap((key) => yamlListItems(section, key).filter(isLegacyDisclosureToken));
}

// The retired items that sat under `excludes`, as written. That was an earlier explicit refusal, so
// removing the item changes how the second review is dispatched and the user has to be told about it.
function findLegacyExcludedItems(section) {
  return yamlListItems(section, "excludes").filter(isLegacyDisclosureToken);
}

/**
 * Trailing notice for a retired item that was listed under `excludes` (empty when none was). Informs, never
 * asks: the removal-only fix is unchanged, the user is told in the same reply, and a refusal that should
 * stand becomes an ordinary AGENTS.local.md rule or a waiver (remove-second-review-disclosure-framework D4).
 */
export function legacyExcludesNotice(excludedTokens) {
  if (excludedTokens.length === 0) return "";
  return ` \`${excludedTokens.join(", ")}\` was listed under \`excludes\`, an earlier explicit refusal: ` +
    "after removal the second review of this change dispatches like any same-repo PR, so tell the user in the same reply; " +
    "if the refusal should stand, add an ordinary AGENTS.local.md rule that stops before dispatch, " +
    "or use the waiver path in code-review-cross-model.md §Merge Gate Enforcement.";
}

function legacyDisclosureIssue(tokens, excludedTokens = []) {
  return `${LEGACY_DISCLOSURE_ISSUE_PREFIX} \`${tokens.join(", ")}\` in \`covers\`/\`excludes\`: ` +
    "remove only those item(s) and keep every other item " +
    "(block list: delete just the `- <item>` lines for them; flow list `[a, b]`: delete just those names inside the brackets, " +
    "never the whole `covers`/`excludes` line). " +
    "A retired ledger item is no longer part of the ledger and can simply be deleted (retired item; delete it)." +
    legacyExcludesNotice(excludedTokens);
}

/**
 * Archive folder names carry a `YYYY-MM-DD-` date prefix
 * (`openspec/changes/archive/<archiveName>/`), while `named_change` inside
 * the ledger stores the bare change name without that prefix. Extract the
 * bare name before comparing; fail closed to the literal `archiveName` when
 * no date prefix is present (should not happen in practice, but comparing
 * against the raw value is safer than throwing).
 */
function bareChangeNameFromArchiveName(archiveName) {
  const name = String(archiveName ?? "");
  const match = name.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
  return match ? match[1] : name;
}

/**
 * Identity-strength read: compares every ledger field against the caller's
 * known `changeName` / `branch`. Used by pre-write gates.
 *
 * @param {string} content full proposal/proposal-mini content
 * @param {{ changeName: string, branch: string }} identity
 * @returns {{ issue: string, isNA: boolean }} `issue` is `""` when the
 *   ledger is fully valid; otherwise a human-readable description. `isNA` is
 *   `true` only when the ledger still says the N/A sentinel — callers decide
 *   whether that is pass or block.
 */
export function evaluateBatchApprovalLedgerIdentity(content, { changeName, branch }) {
  const ledger = extractH2Section(content, "Batch Approval Ledger");
  if (!ledger.trim()) {
    return { issue: "is missing `## Batch Approval Ledger`", isNA: false };
  }
  if (sectionIsNASentinel(ledger)) {
    return { issue: "still says `N/A: no batch approval selected`", isNA: true };
  }

  const requiredLines = [
    ["kind", /^kind:[\t ]*same-change-dp-change-batch[\t ]*$/m],
    ["named_change", new RegExp(`^named_change:[\\t ]*${escapeRegExp(changeName)}[\\t ]*$`, "m")],
    ["branch", new RegExp(`^branch:[\\t ]*${escapeRegExp(branch)}[\\t ]*$`, "m")],
    ["repo_scope", /^repo_scope:[\t ]*same-repo[\t ]*$/m],
  ];
  for (const [label, regex] of requiredLines) {
    if (!regex.test(ledger)) {
      return { issue: `has missing or mismatched \`${label}\``, isNA: false };
    }
  }
  if (!yamlListHasEntries(ledger, "covers")) {
    return { issue: "has empty or missing `covers`", isNA: false };
  }
  if (!yamlListHasEntries(ledger, "excludes")) {
    return { issue: "has empty or missing `excludes`", isNA: false };
  }
  // Last, so a structurally incomplete ledger gets its existing failure first.
  const legacy = findLegacyDisclosureItems(ledger);
  if (legacy.length > 0) return { issue: legacyDisclosureIssue(legacy, findLegacyExcludedItems(ledger)), isNA: false };
  return { issue: "", isNA: false };
}

/**
 * Shape-strength read: identity-independent structural completeness check.
 * Used by the archive check (c) extension, where the archived change's
 * branch is not a trustworthy comparison basis.
 *
 * @param {string} content archived proposal/proposal-mini content
 * @param {{ archiveName: string }} target `archiveName` is the archive
 *   folder name (date-prefixed); the bare change name is extracted before
 *   comparing against `named_change`.
 * @returns {"absent"|"shapeless"|"ok"|{ verdict: "legacy", tokens: string[], excluded_tokens: string[] }}
 *   `absent` when the H2 section itself is missing; `ok` when the N/A
 *   sentinel is present, or every identity-independent required field is
 *   present; `shapeless` otherwise. `{ verdict: "legacy", tokens, excluded_tokens }` (the only
 *   non-string verdict, so existing string comparisons keep working) when an
 *   otherwise structurally complete ledger lists a retired ledger
 *   item; `tokens` are the items exactly as written in the ledger and
 *   `excluded_tokens` is the subset that sat under `excludes`.
 */
export function evaluateBatchApprovalLedgerShape(content, { archiveName }) {
  const ledger = extractH2Section(content, "Batch Approval Ledger");
  if (!ledger.trim()) return "absent";
  if (sectionIsNASentinel(ledger)) return "ok";

  const bareName = bareChangeNameFromArchiveName(archiveName);
  const requiredChecks = [
    /^kind:[\t ]*same-change-dp-change-batch[\t ]*$/m.test(ledger),
    /^repo_scope:[\t ]*same-repo[\t ]*$/m.test(ledger),
    new RegExp(`^named_change:[\\t ]*${escapeRegExp(bareName)}[\\t ]*$`, "m").test(ledger),
    yamlListHasEntries(ledger, "covers"),
    yamlKeyPresent(ledger, "excludes"),
    /^branch:[\t ]*\S.*$/m.test(ledger),
  ];
  if (!requiredChecks.every(Boolean)) return "shapeless";
  const legacy = findLegacyDisclosureItems(ledger);
  return legacy.length > 0
    ? { verdict: "legacy", tokens: legacy, excluded_tokens: findLegacyExcludedItems(ledger) }
    : "ok";
}

/**
 * Mode-locked wrappers around `evaluateBatchApprovalLedgerIdentity` for the
 * two pre-write gates design.md D2 says share the identity function. A
 * caller reading only `.issue` off the raw identity result silently inherits
 * Gate SP's polarity (N/A blocks); these named wrappers make each gate's
 * polarity part of the function signature instead of caller discipline.
 */
export function evaluateBatchApprovalLedgerForSessionPendingPrewrite(content, { changeName, branch }) {
  return evaluateBatchApprovalLedgerIdentity(content, { changeName, branch }).issue;
}

export function evaluateBatchApprovalLedgerForGeneralModePrewrite(content, { changeName, branch }) {
  const { issue, isNA } = evaluateBatchApprovalLedgerIdentity(content, { changeName, branch });
  // General mode: N/A is a legitimate Step-0 conclusion — pass, not block.
  return isNA ? "" : issue;
}

const LITE_SCOPE_RECORD_FILE = "lite-scope.md";
const LITE_SCOPE_FIELD_ORDER = ["kind", "named_change", "branch", "repo_scope", "covers", "excludes"];

function liteScopeListIssue(key, raw) {
  if (raw === "") return `has an empty \`${key}\` list`;
  const items = raw.split(",");
  if (items.some((item) => item === "")) return `has an empty item in \`${key}\` (items are separated by \`,\` with nothing between)`;
  if (items.some((item) => /\s/.test(item))) return `has whitespace inside \`${key}\` (items are separated by \`,\` with no spaces)`;
  const legacy = items.filter(isLegacyDisclosureToken);
  if (legacy.length > 0) {
    return `lists retired ledger item(s) \`${legacy.join(", ")}\` in \`${key}\`: ` +
      "a retired item is no longer a record item and can simply be deleted (retired item; delete it)";
  }
  return "";
}

/**
 * Judge the content of a lite batch scope record: exactly one line (one
 * trailing newline, CRLF tolerated), fields in the fixed order
 * `kind=same-change-dp-change-batch; named_change=<n>; branch=<b>; repo_scope=same-repo; covers=<a,b>; excludes=<c,d>`.
 * Reads content only; it never looks at a Bash command string, and an absent
 * file or a non-regular entry is the caller's call (`readLiteScopeRecord`).
 * Format defects (`malformed`) outrank identity differences (`mismatch`).
 *
 * @param {string} content
 * @param {{ changeName: string, branch: string }} identity
 * @returns {{ status: "match"|"mismatch"|"malformed", issue: string }}
 */
export function evaluateLiteScopeRecord(content, { changeName, branch }) {
  const malformed = (issue) => ({ status: "malformed", issue });
  const text = String(content ?? "");
  if (text.charCodeAt(0) === 0xfeff) return malformed("starts with a BOM");
  const line = text.replace(/\r?\n$/, "");
  if (line.trim() === "") return malformed("is empty");
  if (/[\r\n]/.test(line)) return malformed("must be exactly one line (found a second line or a blank line)");

  const fields = [];
  for (const field of line.split("; ")) {
    const eq = field.indexOf("=");
    if (eq <= 0) return malformed(`has a field without \`name=value\` form: \`${field}\``);
    fields.push([field.slice(0, eq), field.slice(eq + 1)]);
  }
  const seen = new Set();
  for (const [key] of fields) {
    if (!LITE_SCOPE_FIELD_ORDER.includes(key)) return malformed(`has an unknown field \`${key}\``);
    if (seen.has(key)) return malformed(`has a duplicate field \`${key}\``);
    seen.add(key);
  }
  const missing = LITE_SCOPE_FIELD_ORDER.filter((key) => !seen.has(key));
  if (missing.length > 0) return malformed(`is missing field(s) ${missing.map((key) => `\`${key}\``).join(", ")}`);
  if (fields.some(([key], index) => key !== LITE_SCOPE_FIELD_ORDER[index])) {
    return malformed(`has fields out of order (expected ${LITE_SCOPE_FIELD_ORDER.join("; ")})`);
  }

  const value = Object.fromEntries(fields);
  if (value.kind !== "same-change-dp-change-batch") return malformed("has a `kind` other than `same-change-dp-change-batch`");
  if (value.repo_scope !== "same-repo") return malformed("has a `repo_scope` other than `same-repo`");
  for (const key of ["covers", "excludes"]) {
    const issue = liteScopeListIssue(key, value[key]);
    if (issue) return malformed(issue);
  }
  if (value.named_change !== changeName) return { status: "mismatch", issue: `has a mismatched \`named_change\` (expected \`${changeName}\`)` };
  if (value.branch !== branch) return { status: "mismatch", issue: `has a mismatched \`branch\` (expected \`${branch}\`)` };
  return { status: "match", issue: "" };
}

/**
 * Read and judge `<repoRoot>/openspec/changes/<changeName>/lite-scope.md`.
 * `lstat` first and never follow: an absent file is `missing`; a symlink,
 * directory or any other non-regular entry is `malformed` and is not read.
 *
 * @returns {{ status: "missing"|"match"|"mismatch"|"malformed", issue: string, recordPath: string }}
 */
export function readLiteScopeRecord(repoRoot, { changeName, branch }) {
  // 歸檔時 `lite-scope.md` 會跟著資料夾搬進 `openspec/changes/archive/`；只讀 active 路徑
  // 會讓已歸檔的 lite change 一律回 missing。active 不存在時改讀 archive 副本。
  const activePath = path.join(repoRoot, "openspec", "changes", changeName, LITE_SCOPE_RECORD_FILE);
  const archivedPath = path.join(repoRoot, "openspec", "changes", "archive", changeName, LITE_SCOPE_RECORD_FILE);
  const recordPath = existsSyncFile(activePath) || !existsSyncFile(archivedPath) ? activePath : archivedPath;
  let stat;
  try {
    stat = lstatSync(recordPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { status: "missing", issue: "does not exist", recordPath };
    return { status: "malformed", issue: `cannot be inspected (${error?.code || "error"})`, recordPath };
  }
  if (!stat.isFile()) {
    return { status: "malformed", issue: "is not a regular file (a symlink, directory or other entry is never read through)", recordPath };
  }
  let content;
  try {
    content = readFileSync(recordPath, "utf8");
  } catch (error) {
    return { status: "malformed", issue: `cannot be read (${error?.code || "error"})`, recordPath };
  }
  return { ...evaluateLiteScopeRecord(content, { changeName, branch }), recordPath };
}
