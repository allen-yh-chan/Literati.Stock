/** PR-create runtime checks; kept out of the bootstrap-safe path constants module. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyRepoIdentity } from "./repo-identity.mjs";
import { extractExactH2Bodies, forEachMarkdownLine, neutraliseInertMarkdown, normaliseLineEndings } from "./markdown-fence-aware.mjs";
import { parseBlocks } from "./session-pending-blocks.mjs";
import { resolveMainCheckoutRoot } from "../hooks/lib/repo-state-identity.mjs";
import { findUnfilledTemplateText } from "./pr-body-evidence-rules.mjs";
import { CONSUMER_PRE_PR_CHECKS_REL } from "./consumer-pre-pr-checks.mjs";
import { isRulesSyncExemptFromCrossModel } from "../hooks/lib/branch-naming.mjs";

// #3529: a rules-lane sync PR head (rules/<whitelisted-source>-v<X.Y.Z>, the shape the cross-model branch-pattern
// exemption accepts) ships no deployable change and has no proposal ledger, so the PR create gates treat the DEV
// deploy-verify line and ## Requirement Ledger Completion as N/A. Any other head, or a rules source whitelist that
// cannot be read under `repoRoot`, is not one, and both checks stay.
export function isRulesLaneSyncPrHead(branch, repoRoot) {
  try { return isRulesSyncExemptFromCrossModel(branch, repoRoot); } catch { return false; }
}

// The git top-level of `cwd` and its governance identity; only a positive source identity is exempt.
export function checkoutRepoIdentity(cwd) {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (root.status !== 0) return { error: "Git repository query failed; run git rev-parse --show-toplevel in the PR checkout" };
  const { identity, evidence } = classifyRepoIdentity(root.stdout.trim());
  return { root: root.stdout.trim(), identity, evidence };
}

// Fail closed on Git errors; only a positive source identity is exempt.
export function consumerPrePrChecksState(cwd) {
  const checkout = checkoutRepoIdentity(cwd);
  if (checkout.error) return { error: checkout.error };
  const { identity, evidence } = checkout;
  cwd = checkout.root;
  if (identity === "source") return { applicable: false, source: true };
  const tracked = spawnSync("git", ["ls-tree", "--name-only", "HEAD", "--", CONSUMER_PRE_PR_CHECKS_REL], { cwd, encoding: "utf8" });
  if (tracked.status !== 0) return { error: "Git HEAD checks query failed; inspect git ls-tree --name-only HEAD -- .devpro/pre-pr-checks.local.md" };
  if (tracked.stdout.trim()) return { applicable: true, identity, evidence };
  const working = spawnSync("git", ["status", "--porcelain", "--ignored", "--", CONSUMER_PRE_PR_CHECKS_REL], { cwd, encoding: "utf8" });
  if (working.status !== 0) return { error: "Git working-tree checks query failed; inspect git status --porcelain --ignored -- .devpro/pre-pr-checks.local.md" };
  if (working.stdout.trim()) return { error: `${CONSUMER_PRE_PR_CHECKS_REL} exists only in the working tree; commit the file before running consumer checks and creating the PR` };
  return { applicable: false, identity, evidence };
}

// Live `## Test Evidence` lines (outside fenced code), list marker stripped, that start with `prefix`.
export function testEvidenceLines(body, prefix) {
  const { bodies } = extractExactH2Bodies(neutraliseInertMarkdown(body), "## Test Evidence");
  return bodies.flatMap((section) => section.split("\n"))
    .map((line) => line.replace(/^\s*[-*+]\s+/, "").trim())
    .filter((line) => line.startsWith(prefix));
}

// Text format only here; perPrWaiverRecordError compares waiver parts with answer-time records. Execution, whether the user really answered, and ancestor/bookkeeping currency stay cooperative; this deliberately does not compare evidence SHA to tip.
export function consumerPrePrEvidenceError(body) {
  const lines = testEvidenceLines(body, "Consumer pre-PR checks:");
  const match = lines.length === 1 && /^Consumer pre-PR checks: HEAD ([a-f0-9]{40}|[a-f0-9]{64});[ \t]*(\S.*)$/i.exec(lines[0]);
  if (!match || findUnfilledTemplateText(match[2], { profile: "evidence" }).length ||
      /^(?:N\/A|[-—.]+|`*<[^>]+>`*)$/i.test(match[2].trim()) ||
      /skipped per user decision:\s*$/i.test(match[2])) {
    return "require one non-placeholder line outside fenced code in ## Test Evidence: Consumer pre-PR checks: HEAD <full-sha>; <result summary>; user waiver: skipped per user decision: <reason>";
  }
  return null;
}

// Text format only; perPrWaiverRecordError compares waivers with records. Execution, whether the user really answered, and HEAD currency stay cooperative.
export function consumerDevVerifyEvidenceError(body) {
  if (typeof body !== "string") return "PR body is missing or unreadable; the DEV deploy-verify line is required";
  const lines = testEvidenceLines(body, "DEV deploy-verify:");
  const match = lines.length === 1 && /^DEV deploy-verify: HEAD ([a-f0-9]{40}|[a-f0-9]{64});[ \t]*(\S.*)$/i.exec(lines[0]);
  const status = match ? match[2].trim() : "";
  const error = "require exactly one non-placeholder line outside fenced code in ## Test Evidence: DEV deploy-verify: HEAD <full-sha>; <result summary> | N/A: <reason> | pending: <what is missing> | skipped per user decision: <reason>";
  // A status keyword needs its colon and a real reason; code-span <...> fields count as empty.
  const prefixed = /^(?:N\/A|pending|skipped per user decision):(.*)$/i.exec(status);
  if (!match || findUnfilledTemplateText(status, { profile: "evidence" }).length ||
      /^(?:[-—.]+|`*<[^>]+>`*)$/.test(status) ||
      (prefixed ? /^(?:[-—.]+|`*<[^>]+>`*)?$/.test(prefixed[1].trim()) : /^(?:N\/A|pending|skipped)\b/i.test(status))) return error;
  return /^not[\s_-]*verified\b/i.test(status) ? `${error}; write pending: <what is missing> instead` : null;
}

// ── Per-PR waiver records ────────────────────────────────────────────────────
// Each `skipped per user decision:` part of the DEV and Consumer evidence lines
// is compared with the answer-time record of the change (session-pending-lifecycle.md,
// per-PR waiver records). Located from the PR checkout alone (branch from git at PR
// creation, from the GitHub head ref at an edit and at merge); no waiver part means
// no git query and no file read.
export const DEV_GATE = "DEV deploy-verify gate";
export const CONSUMER_GATE = "Consumer pre-PR checks gate";
const KINDS = [
  { name: "DEV deploy-verify", gate: DEV_GATE, prefix: "DEV deploy-verify:", status: "a result summary or pending: <what is missing>" },
  { name: "Consumer pre-PR checks", gate: CONSUMER_GATE, prefix: "Consumer pre-PR checks:", status: "stop or finish the check as consumer-pre-pr-checks.md describes" },
];
const PROBLEMS = {
  "git-query-failed": "the git query for the branch or the main checkout failed",
  "branch-without-change": "the branch names no change (detached HEAD, or not feature/, bugfix/, hotfix/ or chore/)",
  "file-missing": "notes/session-pending.md does not exist",
  "file-unreadable": "notes/session-pending.md cannot be read",
  "no-entry": "no claimed entry of this change carries a record",
  "ambiguous-entry": "the records of this change are not in exactly one entry that claims only this change",
  "malformed-record": "the record entry of this change lacks exactly one pr_branch: line, or its record of this kind is malformed",
  "branch-mismatch": "the record entry of this change is bound by pr_branch: to a different branch",
  "no-match": "no unused record of this kind matches this part (a part matches when it equals the recorded reason, or goes on after it only with a semicolon or an opening parenthesis)",
  "head-ref-missing": "GitHub reported no head branch for this PR",
  "cross-repository-head": "the PR head branch is in another repository, so no answer-time record of this checkout can belong to this PR",
};
const WAIVER_MARK = /skipped per user decision:/gi;
const norm = (text) => text.normalize("NFC").replace(/\s+/g, " ").trim();
const keyLine = (key) => new RegExp(`^[\\t ]*(?:[-*][\\t ]*)?${key}:(.*)$`);

// Text after each `skipped per user decision:` up to the next one or the line end (not normalised).
export function waiverParts(line) {
  const marks = [...line.matchAll(WAIVER_MARK)];
  return marks.map((mark, i) => line.slice(mark.index + mark[0].length, marks[i + 1]?.index ?? line.length));
}

// After the reason, a part may only go on with `;` (the next result) or `(` (an observed-failure note), ASCII or
// full-width: more words would waive more than the user answered ("UI smoke" must not cover "UI smoke and unit tests").
function partMatches(part, reason) {
  const p = norm(part);
  const r = norm(reason);
  if (!r) return false;
  return p === r || (p.startsWith(r) && /^ ?[;(；（]/u.test(p.slice(r.length)));
}

// Maximum bipartite matching (Kuhn); returns the 1-based numbers of parts left without a record.
export function matchWaiverParts(parts, reasons) {
  const owner = new Array(reasons.length).fill(-1);
  const place = (part, seen) => reasons.some((reason, r) => {
    if (seen[r] || !partMatches(parts[part], reason)) return false;
    seen[r] = true;
    if (owner[r] === -1 || place(owner[r], seen)) { owner[r] = part; return true; }
    return false;
  });
  parts.forEach((_, part) => place(part, []));
  return parts.map((_, part) => part).filter((part) => !owner.includes(part)).map((part) => part + 1);
}

const defaultGit = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10000 });

// { problem, change?, branch? } or { change, branch, dev, consumer } (raw record values of the one carrying entry).
// `options.branch` (own property) is the PR head branch GitHub reports; without it the branch comes from git.
export function readPerPrWaiverRecords(cwd, deps = {}, options = {}) {
  const { git = defaultGit, readFile = readFileSync, resolveRoot = resolveMainCheckoutRoot } = deps;
  let branch;
  if (Object.hasOwn(options, "branch")) {
    if (typeof options.branch !== "string" || !options.branch) return { problem: "head-ref-missing" };
    branch = options.branch;
  } else {
    const current = git(cwd, ["branch", "--show-current"]);
    if (current.error || current.status !== 0) return { problem: "git-query-failed" };
    branch = current.stdout.trim();
  }
  const change = /^(?:feature|bugfix|hotfix|chore)\/(.+)$/.exec(branch)?.[1];
  if (!change) return { problem: "branch-without-change", branch };
  const known = { change, branch };
  const { mainCheckoutRoot, identitySource } = resolveRoot(cwd);
  if (identitySource !== "git-common-dir") return { problem: "git-query-failed", ...known };
  let content;
  try {
    content = readFile(path.join(mainCheckoutRoot, "notes", "session-pending.md"), "utf8");
  } catch (error) {
    return { problem: error?.code === "ENOENT" ? "file-missing" : "file-unreadable", ...known };
  }
  const claimsChange = new RegExp(`^[\\t ]*(?:[-*][\\t ]*)?claimed:[\\t ]*${change.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\t ]*$`);
  const entries = parseBlocks(normaliseLineEndings(content)).blocks.map((block) => {
    const entry = { claimsChange: false, claimed: 0, records: 0, dev: [], consumer: [], prBranch: [] };
    forEachMarkdownLine(block.lines.join("\n"), (line, _index, { inFence }) => {
      if (inFence) return;
      if (claimsChange.test(line)) entry.claimsChange = true;
      if (keyLine("claimed").test(line)) entry.claimed += 1;
      const dev = keyLine("dev_verification").exec(line);
      const consumer = keyLine("consumer_waiver").exec(line);
      if (dev) entry.dev.push(dev[1]);
      if (consumer) entry.consumer.push(consumer[1]);
      const prBranch = keyLine("pr_branch").exec(line);
      if (prBranch) entry.prBranch.push(prBranch[1].trim());
    });
    return entry;
  });
  const carriers = entries.filter((entry) => entry.claimsChange && (entry.dev.length || entry.consumer.length));
  if (!carriers.length) return { problem: "no-entry", ...known };
  if (carriers.length > 1 || carriers[0].claimed !== 1) return { problem: "ambiguous-entry", ...known };
  const [{ dev, consumer, prBranch }] = carriers;
  if (prBranch.length !== 1 || !prBranch[0]) return { problem: "malformed-record", ...known };
  if (prBranch[0] !== branch) return { problem: "branch-mismatch", ...known };
  return { ...known, dev, consumer };
}

const PROVENANCE = " (provenance: user)";
// Reasons carried by the records of one kind, or null when a record of that kind is malformed.
function devReasons(values) {
  if (values.length > 1) return null;
  const [raw] = values.map((value) => value.trimEnd());
  if (raw === undefined) return [];
  if (!raw.endsWith(PROVENANCE)) return null;
  const answer = raw.slice(0, -PROVENANCE.length);
  const cut = answer.lastIndexOf("; entry: ");
  const decision = (cut < 0 ? answer : answer.slice(0, cut)).trim();
  if (decision === "deploy-before-pr" || /^(?:n\/a|open-pr-pending): \S/.test(decision)) return [];
  return /^waived: \S/.test(decision) ? [decision.slice("waived: ".length)] : null;
}
function consumerReasons(values) {
  const reasons = values.map((value) => value.trimEnd());
  if (!reasons.every((raw) => raw.endsWith(PROVENANCE) && raw.slice(0, -PROVENANCE.length).trim())) return null;
  return reasons.map((raw) => raw.slice(0, -PROVENANCE.length));
}

function waiverDetail(kind, part, parts, problem, { change, branch }) {
  const lead = `${kind.name} line, waiver part ${part} of ${parts.length} ("${norm(parts[part - 1]).slice(0, 80)}"): ${PROBLEMS[problem]}.`;
  const actual = `replace the waiver with the actual status (${kind.status})`;
  if (problem === "branch-without-change") {
    return `${lead} Looked for a change name in branch ${branch || "(detached)"}. Next step: ${actual}.`;
  }
  // No head branch, or a head in another repository: there is no entry to bind a record to, so no record step.
  if (problem === "head-ref-missing" || problem === "cross-repository-head") return `${lead} Next step: ${actual}.`;
  const ask = "ask the user this PR's waiver question; once the user has answered, record the answer as session-pending-lifecycle.md (per-PR waiver records) describes and retry";
  return `${lead} Looked for change ${change ?? "(unresolved)"} (branch ${branch ?? "(unresolved)"}) in notes/session-pending.md of the main checkout. Next step: ${ask}; or ${actual}. Do not write a record for an unanswered waiver.${
    problem === "branch-mismatch" ? " Do not edit pr_branch: to make an existing record fit this branch." : ""}`;
}

const waiverPartsByKind = (body) => KINDS.map((kind) => ({ kind, parts: testEvidenceLines(body, kind.prefix).flatMap(waiverParts) }))
  .filter(({ parts }) => parts.length);

// True when a live DEV or Consumer evidence line of `body` carries at least one waiver part.
export function hasPerPrWaiverPart(body) {
  return typeof body === "string" && waiverPartsByKind(body).length > 0;
}

// null, or { gate, detail } for the first waiver part (DEV before Consumer) without an answer-time record.
// `options.branch` is the PR head branch GitHub reports (merge, edit); `options.crossRepository === true` means the PR
// head is in another repository, which no record of this checkout can belong to (nothing is read for it).
export function perPrWaiverRecordError(body, cwd, deps = {}, options = {}) {
  if (typeof body !== "string") return null;
  const compared = waiverPartsByKind(body);
  if (!compared.length) return null;
  const headRefMissing = Object.hasOwn(options, "branch") && (typeof options.branch !== "string" || !options.branch);
  const records = options.crossRepository === true && !headRefMissing ? { problem: "cross-repository-head" } : readPerPrWaiverRecords(cwd, deps, options);
  const block = ({ kind, parts }, part, problem) => ({ gate: kind.gate, detail: waiverDetail(kind, part, parts, problem, records) });
  if (records.problem) return block(compared[0], 1, records.problem);
  for (const entry of compared) {
    const reasons = (entry.kind === KINDS[0] ? devReasons(records.dev) : consumerReasons(records.consumer));
    if (!reasons) return block(entry, 1, "malformed-record");
    const [unmatched] = matchWaiverParts(entry.parts, reasons);
    if (unmatched) return block(entry, unmatched, "no-match");
  }
  return null;
}

// Outer string of a block at merge, shared by `gh pr merge` and MCP merge; `edit` names the tool that replaces a waiver
// (`gh pr edit`, or the GitHub web page on the MCP path, where `update_issue` cannot edit a PR). No `gh pr create` recipe,
// bypass hint or record content.
export function perPrWaiverMergeReason({ gate, detail }, prNumber, edit) {
  return `${gate}: ${detail}\nMerge-time check of PR #${prNumber}: the current PR description is compared again before merge. Retry the merge after the next step above; to replace a waiver with the actual status, edit the description with ${edit}.`;
}

// Outer string of a block at a description edit through `gh pr edit` (MCP `update_issue` cannot edit a PR).
export function perPrWaiverEditReason({ gate, detail }, prNumber) {
  return `${gate}: ${detail}\nEdit-time check of PR #${prNumber}: the new description is compared with the answer-time records before the edit. Retry the edit after the next step above.`;
}
