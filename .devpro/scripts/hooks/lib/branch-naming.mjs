// Branch naming validation helpers.
// SSOT for the verb whitelist is preflight-checklist.md marker block.
// This module parses that md and exposes verbs as a Set for process/library
// callers, including PreToolUse hard-gate validation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { segmentCommand, isMatchInCommandSegment, GIT_GLOBAL_OPT, CMD_POSITION_ANCHOR, anchoredVerbIndex, ghPrVerbSource } from "./shell-context.mjs";
import { SEMVER_CORE } from "./version-helpers.mjs";

const PREFLIGHT_REL = ".devpro/agent-rules/preflight-checklist.md";
const MARKER_START = "<!-- branch-verb-whitelist:start -->";
const MARKER_END = "<!-- branch-verb-whitelist:end -->";
const RULES_SOURCE_MARKER_START = "<!-- rules-source-whitelist:start -->";
const RULES_SOURCE_MARKER_END = "<!-- rules-source-whitelist:end -->";

const PREFIXES = new Set(["feature", "bugfix", "chore", "hotfix", "rules"]);
export const LOCAL_REVIEW_BRANCH_PREFIX = "review/";
const LOCAL_REVIEW_BRANCH_RE = /^review\/pr[1-9]\d*$/;

export function isLocalReviewBranch(branch) {
  return LOCAL_REVIEW_BRANCH_RE.test(branch);
}
// Built from version-helpers SEMVER_CORE SSOT — no third literal copy of the pattern.
const BUMP_EXEMPTION_RE = new RegExp(`^chore\\/bump-v${SEMVER_CORE}$`);
// Release exemption covers three SSOT-documented formats:
// (1) `release/v<X.Y.Z>` — rules-flow.md §Source Repo Release（version-named）
// (2) `release/<YYYYMMDD>-<shortSHA>[-<n>]` — release-sit-uat-pat-prod.md Step 2（date+SHA snapshot）
// (3) `release/rules-<YYYYMMDD>[-<n>]` — release-sit-uat-pat-prod.md Rules Lane（rules submodule promotion lane；README.md L133）
const RELEASE_EXEMPTION_RE = /^release\/(?:v\d+\.\d+\.\d+|\d{8}-[0-9a-f]{7}(?:-\d+)?|rules-\d{8}(?:-(?:[2-9]|[1-9]\d+))?)$/;

// Canonical protected BASE-branch names (the fixed mainline/integration set).
// SSOT for the literal name membership check shared by pre-tool-gate (protected
// gate), recap-utils (isWorkBranch — opposite polarity), and user-prompt-gate
// (intent mismatch). Callers append their OWN release/* handling (which has
// divergent strict-vs-bare shapes); this set is ONLY the four fixed names and
// must NOT absorb release/*. isProtectedBaseBranch is a neutral membership
// predicate — do NOT add higher-level "is this protected/work" polarity here.
const PROTECTED_BASE_BRANCHES = new Set([
  "main",
  "master",
  "production",
  "integration",
]);

export function isProtectedBaseBranch(branch) {
  return PROTECTED_BASE_BRANCHES.has(branch);
}

// Rules lane branch format:
// rules/<source>-v<X.Y.Z>
// The version segment is normalized from the source repo production tag
// `production-v<X.Y.Z>`. Date+SHA rules branches are retired and invalid.
export const RULES_BRANCH_RE = /^rules\/[a-z][a-z0-9-]*-v\d+\.\d+\.\d+$/;

export function readRulesSourceWhitelist(repoRoot) {
  const state = readRulesSourceWhitelistState(repoRoot);
  return state.kind === "valid" ? state.sources : new Set();
}

export function readRulesSourceWhitelistState(repoRoot) {
  const md = readFileSync(path.join(repoRoot, PREFLIGHT_REL), "utf8");
  return parseRulesSourceWhitelist(md);
}

export function parseRulesSourceWhitelist(md) {
  const start = md.indexOf(RULES_SOURCE_MARKER_START);
  const end = md.indexOf(RULES_SOURCE_MARKER_END);
  if (start === -1 || end === -1 || end <= start) {
    return {
      kind: "unresolved",
      reason: "rules source whitelist markers are missing or out of order",
    };
  }
  const block = md.slice(start + RULES_SOURCE_MARKER_START.length, end);
  // Extract backtick-quoted source names (e.g. `agent-rules`)
  const sources = [...block.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (sources.length === 0) {
    return {
      kind: "unresolved",
      reason: "rules source whitelist marker block is empty",
    };
  }
  return { kind: "valid", sources: new Set(sources) };
}

// Strict matcher for cross-model gate exemption.
// Rules branches are SemVer-only; source MUST be in rules-source-whitelist marker
// (preflight-checklist.md), mirroring validateRulesBranch's check.
// This locks runtime exemption to whitelist as defense-in-depth
// beyond process-level branch naming guidance.
export const RULES_SYNC_SEMVER_RE = new RegExp(
  `^rules\\/([a-z][a-z0-9-]*)-v(${SEMVER_CORE})$`
);

export function rulesSyncBranchIdentity(branchName, repoRoot) {
  const branch = typeof branchName === "string" ? branchName : "";
  if (!branch.startsWith("rules/")) return { kind: "generic", branch };

  const match = branch.match(RULES_SYNC_SEMVER_RE);
  if (!match) {
    return {
      kind: "invalid",
      branch,
      reason: `rules/ branch must match pattern: rules/<source>-v<X.Y.Z> (derived from source production-v<X.Y.Z> tag); got: ${branch}`,
    };
  }

  const [, source, version] = match;
  const whitelistState = readRulesSourceWhitelistState(repoRoot);
  if (whitelistState.kind !== "valid") {
    return {
      kind: "unresolved",
      branch,
      source,
      version,
      reason: whitelistState.reason,
    };
  }
  if (!whitelistState.sources.has(source)) {
    return {
      kind: "invalid",
      branch,
      source,
      version,
      reason: `rules/ branch source "${source}" not in whitelist; see preflight-checklist.md § rules-source-whitelist marker; current allowed: ${[...whitelistState.sources].join(", ")}`,
    };
  }

  return { kind: "rules", branch, source, version };
}

export function isRulesSyncExemptFromCrossModel(branchName, repoRoot) {
  return rulesSyncBranchIdentity(branchName, repoRoot).kind === "rules";
}

export function validateRulesBranch(branchName, repoRoot) {
  const identity = rulesSyncBranchIdentity(branchName, repoRoot);
  if (identity.kind === "rules") return { valid: true };
  return {
    valid: false,
    reason: identity.kind === "invalid" || identity.kind === "unresolved"
      ? identity.reason
      : `rules/ branch must match pattern: rules/<source>-v<X.Y.Z> (derived from source production-v<X.Y.Z> tag); got: ${branchName}`,
  };
}

export function loadVerbWhitelist(repoRoot) {
  const md = readFileSync(path.join(repoRoot, PREFLIGHT_REL), "utf8");
  const start = md.indexOf(MARKER_START);
  const end = md.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `branch verb whitelist marker block missing/malformed in ${PREFLIGHT_REL} (expected <!-- branch-verb-whitelist:start --> ... <!-- branch-verb-whitelist:end -->)`
    );
  }
  const block = md.slice(start + MARKER_START.length, end);
  const verbs = new Set();
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*-\s+`(\w+)`/);
    if (m) verbs.add(m[1]);
  }
  if (verbs.size === 0) {
    throw new Error(
      `branch verb whitelist marker block parsed empty in ${PREFLIGHT_REL} (expected list items like \`- \\\`add\\\` — ...\`)`
    );
  }
  return verbs;
}

export function parseBranchName(name) {
  const slash = name.indexOf("/");
  if (slash <= 0) return { ok: false, reason: "branch name missing prefix/" };
  const prefix = name.slice(0, slash);
  const body = name.slice(slash + 1);
  if (!PREFIXES.has(prefix)) {
    if (prefix === "release") {
      return {
        ok: false,
        reason: `release/ branch must match \`release/v<X.Y.Z>\`, \`release/<YYYYMMDD>-<shortSHA>[-<n>]\`, or \`release/rules-<YYYYMMDD>[-<n>]\` (per release-sit-uat-pat-prod.md Step 2 + Rules Lane)`,
      };
    }
    return {
      ok: false,
      reason: `unknown prefix \`${prefix}/\` — prefix allowlist: feature/bugfix/chore/hotfix/rules; prefix-layer exemptions: release/v<X.Y.Z>, release/<YYYYMMDD>-<shortSHA>, release/rules-<YYYYMMDD>[-<n>], local-only review/pr<N>. Whole-name exemptions (for example chore/bump-v<X.Y.Z>) are matched by whole-name literal comparison, not by the verb layer. The verb allowlist is a separate layer: it only checks the first segment after the prefix, so \`docs\`/\`fix\`/\`wire\` are verbs, not prefixes; write \`chore/docs-<scope>\`.`,
    };
  }
  if (!body) return { ok: false, reason: "branch name body empty" };
  const verbMatch = body.match(/^([a-z][a-z0-9]*)(?:[-/]|$)/);
  const verb = verbMatch ? verbMatch[1] : null;
  return { ok: true, prefix, body, verb };
}

// validateBranchName: validate a branch name against verb whitelist.
// For rules/ prefix, short-circuits verb whitelist and validates source against
// rules-source-whitelist marker (requires repoRoot). Pass repoRoot for rules/ support.
export function validateBranchName(name, verbWhitelist, repoRoot) {
  if (isLocalReviewBranch(name)) return { valid: true, exempt: "review" };
  if (BUMP_EXEMPTION_RE.test(name)) return { valid: true, exempt: "bump" };
  if (RELEASE_EXEMPTION_RE.test(name)) return { valid: true, exempt: "release" };
  // rules/ prefix: skip verb whitelist, validate source against whitelist instead
  if (name.startsWith("rules/")) {
    if (!repoRoot) {
      return {
        valid: false,
        reason: `rules/ branch validation requires repoRoot (internal error: caller must pass repoRoot)`,
      };
    }
    return validateRulesBranch(name, repoRoot);
  }
  const parsed = parseBranchName(name);
  if (!parsed.ok) return { valid: false, reason: parsed.reason };
  if (!parsed.verb) {
    return {
      valid: false,
      reason: `cannot extract verb from \`${parsed.prefix}/${parsed.body}\` (expected \`<verb>-<scope>\` kebab-case)`,
    };
  }
  if (!verbWhitelist.has(parsed.verb)) {
    const allowed = [...verbWhitelist].sort().join(" / ");
    return {
      valid: false,
      reason: `verb \`${parsed.verb}\` not in whitelist (allowed: ${allowed}). 來源 SSOT: ${PREFLIGHT_REL}`,
    };
  }
  // N3: body must be kebab-case (lowercase letters, digits, hyphens only; lowercase start).
  // This rejects uppercase, underscores, consecutive-hyphen-start, etc.
  // Applied after verb-whitelist check, before N2, so basic format is validated first.
  const KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  if (!KEBAB_RE.test(parsed.body)) {
    return {
      valid: false,
      reason: `branch name body 須 kebab-case（小寫+數字+hyphen）：${parsed.body} per preflight-checklist.md 點2 + git-branch-naming-and-anchor.md`,
    };
  }
  // N2: branch body must not contain the literal "-and-" connector, which is an
  // explicit multi-action signal (e.g. feature/add-and-remove-x).
  // Token-level verb detection has been removed: common verbs like "update",
  // "remove", "sync", "add", "docs" are also natural nouns/adjectives in scope
  // names (e.g. feature/add-update-checker, feature/add-remove-button) and the
  // mechanical token==verb check produced too many false positives. Fine-grained
  // multi-verb detection is delegated to the cooperative preflight checklist.
  // Note: check the full body (not just the scope segment) so that a connector
  // immediately after the leading verb (add-and-remove-x) is also caught.
  if (parsed.body.includes("-and-")) {
    return {
      valid: false,
      reason: `一動詞一 scope：branch body 含 -and- 連接詞，per preflight-checklist.md 點1。一個分支只做一件事`,
    };
  }
  return { valid: true, prefix: parsed.prefix, verb: parsed.verb };
}

// Parse branch name out of supported git/gh commands. Returns the candidate
// name string, or null when the command does not create/rename a branch, or
// when the name uses a shell variable (skip — false negative > false positive).
//
// Uses segmentCommand to filter out quoted-string segments before pattern
// matching, so `MSG="git checkout -b foo"` doesn't false-positive.
// Fail-safe: if segmentCommand throws → fallback to raw cmd (original behavior).
//
// TOKEN_ANCHOR is the shared CMD_POSITION_ANCHOR (shell-context.mjs): a real
// command-position boundary that does NOT match a verb in argument position
// (`echo git checkout -b feature/x` no longer trips branch extraction / W-gates). Its
// optional env-var / `env`-passthrough / path-prefix tail also closes the same
// prefix gap the pre-tool-gate verb gates have. See CMD_POSITION_ANCHOR.
const TOKEN_ANCHOR = CMD_POSITION_ANCHOR;

const BRANCH_COMMAND_PATTERNS = [
  // checkout -b / -B (force-create) / --orphan, space or `=` form.
  // `(?:${GIT_GLOBAL_OPT}\s+)*` consumes any leading git global option so a
  // create hidden behind e.g. `git --no-pager checkout -b foo` is still parsed
  // (issue #851/#848 round 7 — same generalized grammar as pre-tool-gate.mjs).
  new RegExp(`${TOKEN_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*checkout\\s+(?:-b|-B|--orphan)(?:\\s+|=)(\\S+)`),
  // switch -c / -C (force-create) / --create / --force-create, space or `=` form.
  new RegExp(`${TOKEN_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*switch\\s+(?:-c|-C|--create|--force-create)(?:\\s+|=)(\\S+)`),
  // git branch -m/--move/-M [<old>] <new> — rename. BOTH the optional old-name
  // group AND the captured new-name use the [^\s|;&()<>] stop-set (same as the
  // `git branch <name>` and `worktree add -b` patterns below) so a compound
  // command does not mis-tokenize a trailing shell metachar as a branch name.
  // With the old `(?:\S+\s+)?(\S+)`, a SINGLE-arg rename `git branch -m new && X`
  // had the optional old-name group greedily consume `new ` and the `(\S+)`
  // capture land on `&&` (issue #1085). The stop-set keeps each token within a
  // metachar-delimited segment: `-m old new` still captures `new` (old-name
  // group consumes `old `), `-m new && X` captures `new` (old-name group cannot
  // cross `&&`, so it backtracks empty and the capture takes `new`).
  new RegExp(`${TOKEN_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*branch\\s+(?:-m|--move|-M)\\s+(?:[^\\s|;&()<>]+\\s+)?([^\\s|;&()<>]+)`),
  // git branch <name> [<start-point>] — only first non-metachar token captured
  // (the new branch name); start-point is irrelevant to verb validation.
  // Option 2: capture group uses [^\s|;&()<>]+ instead of \S+ to exclude shell
  // metachars (|;&()<>) so compound commands like `git branch | head` don't
  // tokenize `|` as branch name. Only this pattern[3] is changed; the other 5
  // patterns retain \S+ because their flags (-b/-c/-m/--head) imply an explicit
  // branch-name argument and are not subject to list-mode ambiguity.
  // ASCII 7-metachar stop-set rationale: ` and $ are handled by
  // containsShellExpansion (L128-132); glob chars (*?[) are consumed by shell
  // before this hook sees them; other git-ref-forbidden chars (~^:\@) are not
  // shell command-boundary chars, so we don't stop on them here.
  // cross-ref: 2026-05-04-refactor-pre-tool-gate-shell-aware (token-layer FP
  // 補強；segmentation responsibility boundary defined in that archive D2).
  new RegExp(`${TOKEN_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*branch\\s+(?!-)(?!\\d*(?:>>?|<|>\\&))([^\\s|;&()<>]+)`),
  // worktree add: `-b|-B|--branch` may appear before OR after the <path>, and in
  // space OR `=` form. Allow any run of preceding option/path tokens (same
  // statement only), then the branch flag with `(?:\s+|=)` (issue #851/#848 r10).
  new RegExp(`${TOKEN_ANCHOR}git\\s+(?:${GIT_GLOBAL_OPT}\\s+)*worktree\\s+add\\b(?:\\s+[^;|&]*?)?(?:-b|-B|--branch)(?:\\s+|=)([^\\s|;&()<>]+)`),
  // ghPrVerbSource admits a --repo/-R before `pr` or the verb (fix-pre-verb-repo-flag-gates).
  new RegExp(`${TOKEN_ANCHOR}${ghPrVerbSource("create")}\\b[^|;&]*--head[=\\s]+(\\S+)`),
];

// Resolve the verb (git|gh) position within a TOKEN_ANCHOR match, mirroring the
// `gitVerbIndex` helper in pre-tool-gate.mjs (line 1581 SSOT). When TOKEN_ANCHOR
// consumes a leading separator char into `match[0]`, `match.index` points at that
// separator, not at the `git`/`gh` token. Any gate that tests whether a match falls
// inside a metachar-delimited range MUST use the VERB position rather than
// `match.index` — otherwise the range check is off-by-one and range-suppression
// (no-create / readonly) fails. Per openspec spec.md § "Command-Position Verb
// Matching": "any gate that resolves ... from a match SHALL compute ... from the
// VERB position (`gitVerbIndex(match)`), not from `match.index`".
// Not imported from pre-tool-gate.mjs to avoid a reverse dependency in hook lib.
function matchVerbIndex(m) {
  return anchoredVerbIndex(m);
}

// Shared scanner. `firstOnly=true` → returns the first candidate name or null
// (legacy `extractBranchNameFromCommand` semantics, incl. shell-expansion→null abort).
// `firstOnly=false` → returns an array of every command-position candidate name.
function collectBranchNamesFromCommand(cmd, firstOnly) {
  // Option 1: early-return for `git branch` in no-arg list mode.
  // List mode (`git branch` with no branch-name argument) creates no branch;
  // detecting it at function entry avoids downstream regex tokenizing the next
  // segment's first token (e.g. `|`) as a branch name.
  // Boundary = end-of-string OR shell metachar (|;&()<>), matching
  // TOKEN_ANCHOR philosophy (supports compound-command mid-position detection,
  // e.g. `; git branch` or `git branch | head -20`).
  // Covers: plain path prefix (/usr/bin/git), env-var assignments (FOO=bar),
  // and `git -C <path>` form. Per fail-safe: false negative > false positive.
  // cross-ref: 2026-05-04-refactor-pre-tool-gate-shell-aware (token-layer FP
  // 補強；segmentation responsibility boundary defined in that archive D2).
  // `(?:\s+${GIT_GLOBAL_OPT})*` consumes any leading git global option so the
  // list-mode / readonly suppression below stays symmetric with the generalized
  // creation patterns above — otherwise `git --no-pager branch` (a list) would
  // miss the early-return (issue #851/#848 round 7).
  // The env-value and path-prefix classes stop at `;` `|` `&` `(` (the same characters that open this anchor).
  // With `\S*` they crossed separators, so every separator in a long space-free run restarted a scan to the end
  // of the run: O(n²) (`;X=1` repeated 8000 times cost the whole hook seconds). Applies to READONLY_FLAG_RE too.
  // Whitespace also opens the anchor, so in `A=1 A=1 A=1 …` every space started a match that walked the rest of the
  // run before failing at `git`. A whitespace start right after a whole assignment token (one that begins at a token
  // boundary) is skipped (negative lookbehind):
  // the match that began at the run's first assignment reaches the same `git branch` through the same repeated group,
  // so no command stops matching, and each start now costs the length of one token.
  const NO_ARG_GIT_BRANCH_RE = new RegExp(
    `(?:^|[;|&(]|(?<!(?:^|[\\s;|&(])[A-Za-z_][A-Za-z0-9_]*=[^\\s;|&(]*)\\s)(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s;|&(]*\\s+)*(?:[^\\s;|&(]*\\/)?git(?:\\s+${GIT_GLOBAL_OPT})*\\s+branch\\s*(?:[|;&()<>\\n]|$)`
  );
  // Singular path keeps the historical global early-return (first list-mode `git branch`
  // anywhere → no create). The PLURAL path MUST NOT abort the whole scan on a no-arg
  // `git branch`: a list op in ONE metachar-delimited token (`git branch && git checkout
  // -b zzz/bad`) must not mask a real create in another token. So for the plural path we
  // do NOT early-return here; instead we collect the no-arg `git branch` ranges below and
  // skip BRANCH_COMMAND_PATTERNS matches that fall inside them — symmetric with the
  // readonly-flag per-range handling (issue #899 finding (a) sibling, caught by PR #933
  // cross-model review).
  if (firstOnly && NO_ARG_GIT_BRANCH_RE.test(cmd)) return null;

  // Segment cmd early — shared by both readonly-flag check and BRANCH_COMMAND_PATTERNS loop.
  // Regex runs on original cmd to preserve quoted names for stripQuotes.
  // Fail-safe: if segmentCommand throws → segs stays null (fallback to raw cmd, original behavior).
  let segs = null;
  try { segs = segmentCommand(cmd); } catch {}

  // Read-only flag bypass:
  // `git branch [<name>] <read-only-flag>` is a query/list op — no branch created.
  // Floor: --contains / -l / --list / --merged / --no-merged / --show-current.
  // Anchor on `git branch` subcommand (NO_ARG_GIT_BRANCH_RE 同款 TOKEN_ANCHOR
  // philosophy) + segment filter to avoid quoted-string FP / cross-command bypass.
  // Destructive flags (-d/-D/-m/-M/-c/-C) and other flags follow the original gate path.
  // Middle `[^|;&()<>]*?` is non-greedy and stops at shell metachars to prevent
  // cross-segment false positives (e.g. `--merged` in a prior commit -m message).
  // cross-ref: archive 2026-05-11-fix-branch-verb-gate-readonly-flags
  //
  // CHAINED-SEGMENT FIX: we no longer short-circuit the whole function on the first
  // readonly match. Instead we collect the metachar-delimited subcommand ranges for
  // every `git branch <readonly-flag>` occurrence, then skip BRANCH_COMMAND_PATTERNS
  // matches that fall inside those ranges. This allows compound commands like
  //   `git branch --merged main && git checkout -b feature/y`
  // to still surface `feature/y` because the checkout -b sits in a
  // different metachar-delimited token (after the `&&`).
  // Two-layer protection:
  //   (a) READONLY_FLAG_RE `[^|;&()<>]*?` stops at shell metachars — prevents the
  //       readonly regex itself from crossing into a chained creation subcommand;
  //   (b) subcommandRanges skip in BRANCH_COMMAND_PATTERNS matchAll — prevents a
  //       BRANCH_COMMAND_PATTERN match from being accepted when it falls inside the
  //       same metachar-delimited token as a readonly git-branch invocation.
  const READONLY_FLAG_RE = new RegExp(
    `(?:^|[;|&(]|(?<!(?:^|[\\s;|&(])[A-Za-z_][A-Za-z0-9_]*=[^\\s;|&(]*)\\s)(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s;|&(]*\\s+)*(?:[^\\s;|&(]*\\/)?git(?:\\s+${GIT_GLOBAL_OPT})*\\s+branch\\s+[^|;&()<>\\n]*?(?<![\\w-])(--contains|--list|--merged|--no-merged|--show-current|-l)(?![\\w-])`
  );

  // Split cmd into metachar-delimited subcommand ranges. shell-context.mjs keeps
  // `&&` / `;` / `|` inside a single "command" segment, so we split here on the
  // raw metachar positions to get individual token boundaries.
  // This is only used for readonly-range detection; the isMatchInCommandSegment
  // check below still handles quoted-string FP suppression via segs.
  function getMetacharSubcmdRanges(s) {
    const ranges = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      // Newline/CR are real command separators: NO_ARG_GIT_BRANCH_RE /
      // READONLY_FLAG_RE both treat `\n` as a boundary, so a no-create range
      // MUST split on it too — otherwise a list-mode `git branch` range
      // over-extends across the newline and masks the next line's real create
      // (branch-verb whitelist gate fail-OPEN). Same lesson as CMD_POSITION_ANCHOR
      // and GIT_CONTENT_MATERIALIZE_RE.
      if ("|;&()<>\n\r".includes(s[i])) {
        if (i > start) ranges.push([start, i]);
        start = i + 1;
      }
    }
    if (start < s.length) ranges.push([start, s.length]);
    return ranges;
  }

  const subcmdRanges = getMetacharSubcmdRanges(cmd);

  // Collect metachar-delimited subcommand ranges that contain a readonly git-branch
  // invocation. BRANCH_COMMAND_PATTERNS matches inside these ranges are skipped.
  // `noCreateRe` matches BOTH readonly-flag `git branch <flag>` AND no-arg list-mode
  // `git branch` (the plural path needs the latter as a per-range skip rather than a
  // whole-scan early-return). The `g` flag drives matchAll; each match's metachar-
  // delimited range is excluded from creation matching.
  const readonlySubcmdRanges = [];
  const noCreateRe = new RegExp(`(?:${READONLY_FLAG_RE.source})|(?:${NO_ARG_GIT_BRANCH_RE.source})`, 'g');
  for (const m of cmd.matchAll(noCreateRe)) {
    if (!isMatchInCommandSegment(m.index, segs)) continue;
    // TOKEN_ANCHOR prefix consumes the leading separator into match[0], so m.index
    // points at the separator char (e.g. `\n` or `&` in `&&`) — not at the git verb.
    // When that separator is also a range-split char (getMetacharSubcmdRanges uses
    // `\n|;&()<>`), m.index falls outside every range → range attribution is skipped
    // → the next segment's first token is wrongly captured as a branch-create name.
    // Use matchVerbIndex(m) (verb position) to mirror the consumer-side fix at
    // L393/L396 (0fb0d10). Per openspec spec.md § "Command-Position Verb Matching".
    // Issue #1028.
    const mVerbIdx = matchVerbIndex(m);
    for (const r of subcmdRanges) {
      if (mVerbIdx >= r[0] && mVerbIdx < r[1]) {
        if (!readonlySubcmdRanges.find(existing => existing[0] === r[0])) {
          readonlySubcmdRanges.push(r);
        }
        break;
      }
    }
  }

  // Collect every command-position branch-name candidate, in left-to-right order,
  // de-duplicated by match position so a name caught by two patterns is not double
  // counted. `firstOnly` short-circuits after the first to preserve the historical
  // `extractBranchNameFromCommand` single-value semantics (including its
  // shell-expansion → null abort) without re-scanning.
  // Collect {idx, name} across all patterns, then (plural path) sort by source
  // position so callers see compound-command creates in shell order. The outer loop
  // is per-PATTERN, so without an explicit sort `git worktree add -b a … && git
  // checkout -b b` would surface in pattern order, not shell order.
  const found = [];
  const seenIdx = new Set();
  for (const re of BRANCH_COMMAND_PATTERNS) {
    const globalRe = new RegExp(re.source, (re.flags || '') + 'g');
    for (const m of cmd.matchAll(globalRe)) {
      // Skip if this match falls inside a metachar-delimited token that is a
      // readonly / no-arg git-branch query op (not a creation).
      // Use matchVerbIndex(m) instead of m.index: when TOKEN_ANCHOR consumes
      // a leading separator into match[0], m.index points at the separator char
      // (one position BEFORE the verb), so the range check would be off-by-one
      // and fail to suppress a no-create token. The verb position is always
      // inside the same metachar-delimited range as the separator that precedes it.
      // Per openspec spec.md § "Command-Position Verb Matching" line ~962.
      const mVerbIdx = matchVerbIndex(m);
      let inNoCreateSubcmd = false;
      for (const r of readonlySubcmdRanges) {
        if (mVerbIdx >= r[0] && mVerbIdx < r[1]) { inNoCreateSubcmd = true; break; }
      }
      if (inNoCreateSubcmd) continue;
      // Skip if the match position falls inside a non-command segment (quoted string, etc.)
      if (!isMatchInCommandSegment(m.index, segs)) continue;
      const name = stripQuotes(m[1]);
      if (containsShellExpansion(name)) {
        // Singular semantics: a shell-expansion name aborts to null (false negative >
        // false positive). Plural semantics: skip this one, keep scanning later occurrences.
        if (firstOnly) return null;
        continue;
      }
      if (firstOnly) return name;
      if (!seenIdx.has(m.index)) { seenIdx.add(m.index); found.push({ idx: m.index, name }); }
    }
  }
  // All BRANCH_COMMAND_PATTERNS exhausted (and any no-create subcommands had no
  // creation in other metachar-delimited tokens).
  if (firstOnly) return null;
  // Sort by source position so callers see compound-command creates in shell order.
  found.sort((a, b) => a.idx - b.idx);
  return found.map((f) => f.name);
}

// Backward-compatible single-value extractor: returns the FIRST command-position
// branch-name candidate (or null). Used by callers that only need one name
// (gh pr create --head, worktree-add name alignment).
export function extractBranchNameFromCommand(cmd) {
  return collectBranchNamesFromCommand(cmd, true);
}

// Multi-occurrence extractor: returns EVERY command-position branch-create name in
// the payload (left-to-right, de-duplicated by position; empty array when none).
// A benign / shell-expansion first create MUST NOT mask a later illegal one — the
// branch-verb whitelist gate (Gate 11) iterates these so `git checkout -b feature/ok
// && git checkout -b zzz/bad` validates BOTH and blocks the illegal `zzz` verb
// (issue #899 finding (a), now applied to the re-introduced live Gate 11).
export function extractAllBranchNamesFromCommand(cmd) {
  return collectBranchNamesFromCommand(cmd, false);
}

function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function containsShellExpansion(s) {
  // Conservative: any `$` or backtick = potential expansion → skip (false
  // negative > false positive; branch names never legitimately contain these).
  return /[$`]/.test(s);
}
