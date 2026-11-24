#!/usr/bin/env node
import { readStdin } from './lib/stdin.mjs';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FORBIDDEN_ATTRIBUTION_PATTERNS, hasForbiddenAttribution } from './lib/attribution-patterns.mjs';
import { hasInlineHookBypass } from './lib/hook-bypass.mjs';
import {
  getCurrentBranch,
  getRepoRoot,
  readAgentsMdVersion,
  readCanonicalAgentsMdVersion,
} from './lib/git-utils.mjs';
import { SEMVER_CORE, extractVersionFromFooter, compareVersions } from './lib/version-helpers.mjs';
import { hasGithubProvenanceFooter } from "./lib/github-body-policy.mjs";
import { CMD_POSITION_ANCHOR, segmentCommand, isMatchInCommandSegment, scopeIdAt } from './lib/shell-context.mjs';
import { appendFrictionLog } from './lib/friction-log.mjs';
import { rulesSyncBranchIdentity } from './lib/branch-naming.mjs';
import { UNRESOLVABLE_CWD, commandCwdAt, toolInputCwd } from './lib/hook-command-context.mjs';
import { declaredPrCheckout } from './lib/pr-checkout-declaration.mjs';

class GhFooterGateExit extends Error {
  constructor(code) {
    super(`gh-footer-gate exit ${code}`);
    this.code = code;
  }
}

function executeGhFooterGate({ rawArgs, rawInput, env, cwd, writeStdout, writeStderr }) {
// Keep the existing gate body left-aligned so this mechanical extraction stays
// reviewable against its pre-extraction form; all per-invocation state remains
// inside this function.
const exit = (code) => { throw new GhFooterGateExit(code); };
const commandSeparatorIndex = rawArgs.indexOf('--');
const optionArgs = commandSeparatorIndex === -1 ? rawArgs : rawArgs.slice(0, commandSeparatorIndex);
const strictExit = optionArgs.includes('--strict-exit');
const isStrictCommandPreflight = strictExit && commandSeparatorIndex !== -1;

let payload;
if (commandSeparatorIndex !== -1) {
  payload = {
    tool_input: {
      command: rawArgs.slice(commandSeparatorIndex + 1).join(' '),
    },
  };
} else {
  let malformedPayload = false;
  try {
    payload = JSON.parse(rawInput);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    malformedPayload = true;
  }
  if (malformedPayload) {
    if (strictExit) {
      writeStderr('Footer gate strict mode: invalid or missing hook JSON payload; pass `-- <gh command...>` or valid hook JSON on stdin\n');
      exit(2);
    }
    exit(0); // malformed payload, don't block
  }
}

// 6.2 hook-entry line-continuation normalize (odd trailing `\` before newline
// only). Must run before bypass and every regex consumer. Defense-in-depth
// CONTINUATION_WS_SEP / FLAG_VALUE_SEP (6.1) stay — do not delete.
function normalizeShellLineContinuations(raw) {
  return String(raw ?? '').replace(/(^|[^\\])((?:\\\\)*)\\(\r?\n)/g, '$1$2');
}

const command = normalizeShellLineContinuations(
  payload?.tool_input?.command || payload?.tool_input?.cmd || ''
);
if (hasInlineHookBypass(command)) exit(0);

// Resolve cwd for AGENTS.md version check (D4).
// Reads explicit cwd/workdir aliases from payload (tool_input or top-level).
// For --strict-exit / -- arg surfaces without a payload, falls back to process.cwd()
// but ONLY when this invocation came through the -- args path (commandSeparatorIndex !== -1),
// not from a JSON payload lacking cwd (which would silently read the wrong repo).
// Generic fallback paths are fail-open (D5): if cwd or repoRoot or AGENTS.md version is
// unresolvable → _agentsMdVersion = null → version equality layer skipped.
const _toolInput = payload?.tool_input || {};
const _cwdAliases = [
  _toolInput.cwd,
  _toolInput.workdir,
  _toolInput.working_dir,
  _toolInput.workingDir,
  payload?.cwd,
  payload?.workdir,
  payload?.working_dir,
  payload?.workingDir,
  payload?.current_working_directory,
  payload?.currentWorkingDirectory,
];
const _hasPayloadCwd = _cwdAliases.some((value) => typeof value === 'string' && value.trim());
const _payloadCwd = _hasPayloadCwd ? toolInputCwd(_toolInput, payload) : null;
const _hookCwd = _payloadCwd !== null ? _payloadCwd : (commandSeparatorIndex !== -1 ? cwd : null);
const _fallbackRepoRoot = _hookCwd ? getRepoRoot(_hookCwd) : null;
const _fallbackCanonicalAgents = (_fallbackRepoRoot && _fallbackRepoRoot.length > 0)
  ? readCanonicalAgentsMdVersion(_fallbackRepoRoot)
  : { version: null, anchor: null };
const _fallbackAgentsMdVersion = _fallbackCanonicalAgents.version;
let _genericVersionAnchor = _fallbackCanonicalAgents.anchor;

// Env var name SSOT: mirrors post-pr-completion-check.mjs CROSS_MODEL_REVIEWER_ENV.
// Set to '1' by sanctioned cross-model reviewer subprocess outer env (see
// code-review-checklist.md spec env contract + dp-second-reviewer.md /
// claude-code-cross-review.md). Child processes (including this hook) inherit it.
// This const MUST NOT be duplicated as an inline string elsewhere in this file.
const CROSS_MODEL_REVIEWER_ENV = "DEVPRO_CROSS_MODEL_REVIEWER";

// Returns true when this hook process is running inside a sanctioned cross-model
// reviewer subprocess (narrow-scope FS-isolation fail-open, per decisions.md D1/D2).
// Detection via process.env, NOT command-string inline (per D1).
function isCrossModelReviewerProcess() {
  return env[CROSS_MODEL_REVIEWER_ENV] === "1";
}

function isCodexRuntime() {
  return Boolean(
    env.CODEX_THREAD_ID ||
    env.CODEX_CI ||
    env.DEVPRO_HOOK_HOST === "codex"
  );
}

// Returns true when the hook payload carries NO cwd evidence (issue #1158).
// Mirrors pre-tool-gate.mjs::detectsCodexCwdAbsence, but checks ONLY the fields
// this gate actually uses to resolve a relative body path (see _hookCwd).
// Aligning the absence check to the exact
// fields used for resolution keeps the read-fail diagnostic truthful — it fires
// only when the resolution base genuinely fell back to process.cwd().
function detectsCodexCwdAbsence(p) {
  const toolInput = p?.tool_input || {};
  return ![
    toolInput.cwd,
    toolInput.workdir,
    toolInput.working_dir,
    toolInput.workingDir,
    p?.cwd,
    p?.workdir,
    p?.working_dir,
    p?.workingDir,
    p?.current_working_directory,
    p?.currentWorkingDirectory,
  ].some((value) => typeof value === 'string' && value.trim());
}

function isHookJsonProtocol() {
  return env.DEVPRO_HOOK_PROTOCOL === 'json' ||
    env.DEVPRO_HOOK_JSON_BLOCK === '1' ||
    isCodexRuntime();
}

function block(reason) {
  if (isHookJsonProtocol() && !strictExit) {
    writeStdout(JSON.stringify({ decision: "block", reason }));
    appendFrictionLog(reason);
    exit(0);
  }
  writeStderr(`${reason}\n`);
  appendFrictionLog(reason);
  exit(1);
}

function warn(message) {
  writeStderr(`${message}\n`);
  // warn-level: no process.exit — flow continues to footer/attribution checks
}

function warnStrictValidatorOnly() {
  if (!isStrictCommandPreflight) return;
  warn('gh-footer-gate strict preflight: validation passed only; validator did not execute `gh`. Run the real `gh` command separately if a GitHub write is intended.');
}

// Match `gh` only in COMMAND POSITION — where it is the command being executed,
// not an argument another word merely mentions. We reuse the canonical
// `CMD_POSITION_ANCHOR` SSOT (`lib/shell-context.mjs`) rather than hand-rolling
// a boundary, so this gate stays byte-aligned with `pre-tool-gate.mjs`'s
// command-position detection (statement start; separators ; | & ( ` { newline;
// compound keywords then/do/else/elif/in/until/while/if; inline `VAR=val` and
// `env VAR=val`; path prefix). A plain word-space before `gh` (e.g. `echo gh`,
// `printf "... gh"`, `grep "gh ..."`, `# gh ...`) is NOT command position → not
// a write-back. Real execution contexts (loop/if/brace/connector/inline-env/
// backtick) all gate: footer/attribution is a non-exempt fail-closed compliance
// gate (code-review-checklist §Scope caveat); residual non-natural forms
// (`time`/`nohup`/`xargs`/`sh -c "…"`) are SSOT-documented limitations, not
// chased here — keeping a single SSOT avoids the drift two boundaries would cause.
const GH_CMD_POS_RE = new RegExp(CMD_POSITION_ANCHOR + "(gh)\\s", "dmg");
// DELIBERATELY UNANCHORED — do not add FLAG_TOKEN_START to this pattern. It is the
// odd one out on purpose, and the eight anchored constants further down are not a set
// this one accidentally fell out of. Three concepts live in this file and they carry
// OPPOSITE tolerances: DETECTION (this pattern — does the gate run at all?) is safe
// erring WIDE, because a false detection costs one extra footer check; EXTRACTION is
// safe erring NARROW, because a failed extraction is a read failure and this gate
// fails closed on those; only OCCURRENCE RECOGNITION must be exact, because it is
// wrong in both directions. Anchoring this pattern would turn a payload the gate
// currently over-detects into one the gate never sees — ONE of the fail-open
// directions here, not the only one. The other is recognition drawn too narrow:
// three later rounds each measured occurrences being dropped while detection still
// fired, so a claim that anchoring detection is the single way to fail open is
// false, and this file's own history is the counter-evidence. The two directions
// live in different constants and must be reasoned about separately.
// The residual over-detection (a payload whose unrelated
// argument merely contains a body-flag literal is still detected, and still blocked
// for a missing footer) is a KNOWN false positive; it must not be closed by
// narrowing here. Enforcement of this is cooperative only, and that is stated rather
// than implied: a source-shape assertion is defeated by a rename, and a behavioural
// assertion would enshrine the known false positive as an expected exit code. See
// the "gh-footer-gate.mjs Body File Path Argument Boundary" requirement in the
// pre-tool-mechanical-gates capability spec.
// T9 (R4): shared flag-value separator (design.md D4). Every join point between
// a write-back flag's NAME and its VALUE must accept both the whitespace form
// (`--flag value`) and GitHub CLI's `=`-form (`--flag=value`) — 9 of the file's
// 15 such join points supported only whitespace before this constant existed.
// ONE named constant, so a future extension (T11: backslash line-continuation)
// touches this single definition and every join point below picks it up
// automatically instead of silently updating one site and leaving another
// behind (the same "half-fix" class GH_BARE_F_SUBCOMMANDS' comment names for
// the subcommand allow-list). Deliberately does NOT cover the LEADING
// token-boundary `\s` some branches also require (e.g. before `-f`/`-F`) —
// that boundary is a different join point (start-of-flag, not flag-to-value)
// and stays untouched here. Two of the 5 WRITEBACK_FLAG_RE branches below
// (`--body`/`--notes`) already accepted `=`-form before this constant existed,
// via their own `(\s+\S|=)` shape; they are deliberately NOT rewritten to
// reference this constant directly — that shape also encodes a
// DETECTION-only "a value char must follow" widening rule (distinguishing
// `--body` alone from `--body value`) that a bare separator fragment does
// not represent, and rewriting them to `(?:${FLAG_VALUE_SEP}\S|=)` would only
// re-derive the identical matched-string set they already produce (the bare
// `=` alternative already matches `--body=` regardless of what follows) — a
// no-op refactor with no `=`-form gap to close, so it is left as documented,
// deliberate non-alignment (design.md D4's "刻意不對齊者於原始碼就地寫明理由").
//
// T11 (R5): extended in place (same named constant, not a second one) to also
// accept backslash line-continuation — a realistic multi-line `gh` invocation
// style breaks this separator across a literal `\` + newline + indentation
// (`--body-file \` on one line, the indented path on the next). Plain `\s+`
// does not consume the stray `\` itself (not a whitespace character), so
// EXTRACTION's BODY_PATH_ARG capture used to start AT the `\` and stop at the
// following newline — a bogus one-character "path" that fails to read,
// producing a false-positive fail-closed block despite a valid footer sitting
// on the very next line (T10). `(?:\\\r?\n|\s)+` is a strict superset of the
// prior `\s+`: a run with no continuation matches identically (every
// character is consumed by the plain `\s` alternative, one repetition per
// character, exactly as `\s+` already did); a run containing `\<newline>`
// additionally consumes that pair as one unit. Every one of the 13 sites
// already wired to `${FLAG_VALUE_SEP}` — including the two WRITEBACK_FLAG_RE
// `-f`/`-F` branches added in T9 — picks up continuation coverage from this
// one edit; no second site needs touching (the "half-fix" class this
// constant exists to prevent).
//
// Round-22 (PR #1895, dispatch-c395b2a2 fault-recovery re-review): factored
// the whitespace-or-continuation half out to its own named constant,
// CONTINUATION_WS_SEP, so a token separator that is NOT a flag=value
// boundary (no `=` alternative belongs there — see GH_GLOBAL_REPO_FLAG_RE
// below) can still recognize backslash-newline continuation without a THIRD
// hand-rolled copy of the `(?:\\\r?\n|\s)+` literal (the same duplication
// GH_BARE_F_SUBCOMMANDS' comment already names as the failure class to
// avoid). Purely a refactor of this constant's own definition — the matched
// string set FLAG_VALUE_SEP produces is unchanged.
const CONTINUATION_WS_SEP = String.raw`(?:\\\r?\n|\s)+`;
const FLAG_VALUE_SEP = String.raw`(?:=|${CONTINUATION_WS_SEP})`;

// Separator for the short-flag/bare-alias surfaces that need BOTH the
// zero-width attached form (`-Fpath`, round 9 B1) AND continuation SUPPORT
// (`-F \<newline>path`) — BARE_F_DETECT_RE / F_ALIAS_ARG_RE /
// F_ALIAS_PRESENCE_RE (bare `-F <path>` alias), BODY_SHORT_FLAG_DETECT_RE/ARG_RE
// (`-b`), NOTES_SHORT_FLAG_DETECT_RE/ARG_RE (`-n`), the `-t` branch of
// SUBJECT_FLAG_DETECT_RE/SUBJECT_ARG_RE, and the `-T` branch of
// TEMPLATE_FLAG_DETECT_RE.
//
// A prior revision (design.md Design Question 3 / tasks.md T11) deliberately
// EXCLUDED continuation on all ten sites via a `(?!\\\r?\n)` lookahead,
// reasoning that "unrecognized on a continuation split" was a safe
// pass-through — accepted at the time for the bare `-F` alias because the
// alternative (a bogus one-character path captured from the stray `\`) was a
// false BLOCK, not a bypass, so closing it looked like trading one
// out-of-scope problem for another.
//
// dp-second-reviewer round-17 (PR #1895) found the real consequence: when the
// continuation-shaped flag is the ONLY recognized write-back flag on the
// invocation, "unrecognized" does not mean "this one flag's content is
// unaudited" — it means isGhWriteBack() returns false for the WHOLE
// invocation, skipping footer AND attribution enforcement entirely.
// Confirmed by direct repro on all five surfaces (not just regex tracing):
// an identical footerless body via the one-line form blocks (exit 1); the
// SAME body via the continuation-split form passed silently (exit 0).
//
// Derived from FLAG_VALUE_SEP (`${FLAG_VALUE_SEP}?`), the same DRY idiom as
// TYPED_FIELD_SEP below, so continuation coverage carries over unchanged and
// only the zero-width attached form is newly accepted. Deliberately a
// SEPARATE constant from TYPED_FIELD_SEP despite the identical definition —
// that constant is scoped to the typed-field `body=` surfaces
// (F_FILE/fBodyMatch/unsupportedTypedFieldMatch/fSubshellMatch); reusing it
// here would silently couple two unrelated surface groups' future edits, the
// same "half-fix" class this file's other shared fragments already guard
// against (AGENTS.md §0.10).
const SHORT_FLAG_VALUE_SEP = String.raw`${FLAG_VALUE_SEP}?`;

// Optional separator for the `-f`/`-F` TYPED-FIELD `body=` surface only —
// WRITEBACK_FLAG_RE's last two branches below, plus F_FILE_ARG_RE /
// F_FILE_PRESENCE_RE, fBodyMatch, unsupportedTypedFieldMatch, and
// fSubshellMatch further down. NOT the short-flag/bare-alias surface group
// above (that group has its own SHORT_FLAG_VALUE_SEP). Same underlying gh
// CLI fact as SHORT_FLAG_VALUE_SEP — a short flag immediately followed by
// its value is one argv token to gh, so `-Fbody=@x` reaches gh identically
// to `-F body=@x` — but deliberately a SEPARATE constant, not a reuse of
// SHORT_FLAG_VALUE_SEP: this surface is one of the three pre-existing
// surfaces FLAG_VALUE_SEP already grants backslash line-continuation to
// (T11, see the "T9"/"T11" comments above the WRITEBACK_FLAG_RE `-f`/`-F`
// branches), while SHORT_FLAG_VALUE_SEP is scoped to the short-flag/bare-alias
// surface group (see its own comment above for that group's round-17
// continuation-support history). Reusing SHORT_FLAG_VALUE_SEP here would
// silently couple two unrelated surface groups' future edits. This constant
// is FLAG_VALUE_SEP's own value with the whole group made optional, so
// continuation coverage carries over unchanged and only the zero-width
// attached form is newly accepted. Confirmed via repro: an identical
// footerless `-F body=@file` / `-f body=text` invocation was correctly
// blocked, but the attached `-Fbody=@file` / `-fbody=text` form bypassed
// both the write-back/footer check and the raw-field body extraction
// silently (round-10 finding I-1) — the same detection-bypass class the
// short-flag/bare-alias comment above already documents for the bare-path
// surface (round 9 finding B1), now confirmed on the typed-field surface
// too. Scoped to exactly the five call sites named above, not a
// global FLAG_VALUE_SEP widening: the other join points wired to
// FLAG_VALUE_SEP were not part of this finding, and making the separator
// optional there is unverified for those sites' extraction boundaries.
//
// I-2 (round 11): derived from FLAG_VALUE_SEP (`${FLAG_VALUE_SEP}?`) instead
// of hand-copying its inner alternation, so a future edit to FLAG_VALUE_SEP
// cannot silently drift out of sync here — the same "half-fix" class this
// file's other shared fragments guard against (AGENTS.md §0.10). Because
// FLAG_VALUE_SEP is already a complete `(?:...)` group, appending `?`
// produces the exact same source string as the prior hand-written pattern
// (verified char-for-char), so this is a pure DRY refactor with zero
// behavior change.
const TYPED_FIELD_SEP = String.raw`${FLAG_VALUE_SEP}?`;

const WRITEBACK_FLAG_RE = new RegExp(
  String.raw`(--body(?:-file)?(\s+\S|=))|(--comment${FLAG_VALUE_SEP}["'\S])|(--notes(?:-file)?(\s+\S|=))|(\s(?:-f|--raw-field)${TYPED_FIELD_SEP}["']?body=)|(\s(?:-F|--field)${TYPED_FIELD_SEP}["']?body=)`,
  "g"
);

// Non-global twin of WRITEBACK_FLAG_RE, `.test()`-only. heredocOwnerIsGhWriteBack
// below needs a boolean probe, not the matchAll() iteration ghWriteBackOperations()
// runs against the shared global above; sharing the global for `.test()` too would
// mutate its `.lastIndex`, and that offset would then be inherited by the LATER
// matchAll() scan over the full `command` string, silently truncating which
// occurrences it finds. Same non-global-copy idiom as `ghRe`/`ghTokenRe` further
// down this file, applied here for the same reason (measured: an earlier
// reset-before-test fix at the two call sites below was insufficient because a
// `.test()` match still leaves a non-zero `.lastIndex` afterward).
const WRITEBACK_FLAG_TEST_RE = new RegExp(WRITEBACK_FLAG_RE.source, WRITEBACK_FLAG_RE.flags.replace("g", ""));

// gh's own `-F, --body-file <file>` (or, for `release create`/`release
// edit`, `-F, --notes-file <file>`) short flag on the write-back subcommands
// this hook recognizes (GH_BARE_F_SUBCOMMANDS below) is a BARE PATH, unlike
// `gh api`'s `-F,
// --field <key>=<value>` (typed field, already owned by WRITEBACK_FLAG_RE's
// `-F`/`--field` branch above and by F_FILE_ARG_RE/F_FILE_PRESENCE_RE further
// down). Detecting this alias is DELIBERATELY NOT done by widening
// WRITEBACK_FLAG_RE's `-F` branch itself (rejected in design.md D3, S2/option
// (a)): the two surfaces share only the flag spelling, not its semantics, and
// a merged regex could not tell `gh pr create -F ./payload.txt` (bare path)
// apart from `gh api ... -F labels=bug` (unrelated typed field) without
// baking subcommand knowledge into the regex text — which the DETECTION
// layer must not do (subcommand awareness is a per-match INDEX PREDICATE,
// applied uniformly at all three write-back consumption sites below, not a
// property of the pattern). So this is a SEPARATE, deliberately unanchored
// detection-only pattern (same fail-safe-WIDE reasoning as WRITEBACK_FLAG_RE:
// a false detection costs one extra footer check, never a missed one); the
// subcommand allow-list is applied by isGhBareFAliasMatch()/GH_BARE_F_SUBCOMMANDS
// below, shared by isGhWriteBack(), ghWriteBackOperations(), and
// heredocOwnerIsGhWriteBack() so none of the three can drift from the others.
//
// The BARE_F_NOT_TYPED_BODY lookahead excludes values shaped like the
// typed-field surface (`-F body=@x`, `-F body="$(cat x)"`, `-F
// body=literal`) — this hook already treats `-F body=…` as the api-style
// typed-field carrier REGARDLESS of subcommand (GFG-2/3/4/5/6/7/8 exercise
// this on `pr create`, not only `api`; measured, not assumed — removing the
// lookahead turned those green tests red by letting the bare-path alias
// capture a truncated fragment of `body="$(cat` before the
// extraction-vs-presence backstop even asked which subcommand it was on). So
// the bare-path alias and the typed-field surface are disjoint by VALUE
// SHAPE first, subcommand second — both must hold.
// Leading `=?`: once SHORT_FLAG_VALUE_SEP's separator became optional (round 9
// B1 attached-form widening), `-F=body=@file` gained a SECOND way to reach
// this lookahead — SHORT_FLAG_VALUE_SEP backtracking to its empty alternative
// instead of consuming the `=` — landing the check one character earlier, in front of
// the `=` instead of in front of `body=`. Without `=?` here that left
// `=body=@file` unexcluded (it does not start with `body=`), so the typed
// field's own `=`-form regressed into being misread as the bare-alias
// surface (T8-2 caught this as a RED test, not a spec change: the fix
// closes the same "typed-field body= is not a bare path" invariant this
// lookahead already enforced, against a new position the widening exposed
// it to — not a new exclusion rule).
const BARE_F_NOT_TYPED_BODY = String.raw`(?!=?["']?body=)`;

const BARE_F_DETECT_RE = new RegExp(
  String.raw`\s-F${SHORT_FLAG_VALUE_SEP}${BARE_F_NOT_TYPED_BODY}\S`,
  "g"
);

// Non-global twin of BARE_F_DETECT_RE — same reason and same idiom as
// WRITEBACK_FLAG_TEST_RE above: heredocOwnerIsGhWriteBack needs a `.test()`-only
// probe that cannot leak `.lastIndex` into the LATER matchAll() scans this
// pattern also serves elsewhere in the file.
const BARE_F_DETECT_TEST_RE = new RegExp(BARE_F_DETECT_RE.source, BARE_F_DETECT_RE.flags.replace("g", ""));

// C-1 (round 11, dp-reviewer): four more short-flag/new-flag surfaces gh
// itself recognizes but this gate previously did not, found by the same
// mechanical `gh --help` enumeration method as GH_BARE_F_SUBCOMMANDS, applied
// to a new dimension (flag-alias, not subcommand). All four are detection
// patterns only — deliberately unanchored/fail-safe-WIDE, same reasoning as
// BARE_F_DETECT_RE's own comment above; subcommand gating happens at the
// index-predicate layer (isGhBodyShortFlagMatch / isGhNotesShortFlagMatch /
// isGhSubjectFlagMatch / isGhTemplateFlagMatch below), never in the pattern
// text itself.
//
// Bare `-b` short-flag alias to `--body`. WRITEBACK_FLAG_RE's `--body` branch
// only recognizes the long form; gh treats a short flag immediately followed
// by its value as one argv token, so `-b "text"` reaches gh identically to
// `--body "text"` — the same detection-bypass class BARE_F_DETECT_RE closes
// for `-F`. Needs extraction too (bodyShortMatch further down), unlike
// -T/--template below, because an unaudited `-b` body would otherwise
// silently supply the write-back content.
const BODY_SHORT_FLAG_DETECT_RE = new RegExp(
  String.raw`\s-b${SHORT_FLAG_VALUE_SEP}\S`,
  "g"
);
const BODY_SHORT_FLAG_DETECT_TEST_RE = new RegExp(BODY_SHORT_FLAG_DETECT_RE.source, BODY_SHORT_FLAG_DETECT_RE.flags.replace("g", ""));

// Bare `-n` short-flag alias to `--notes` — same rationale as
// BODY_SHORT_FLAG_DETECT_RE, for WRITEBACK_FLAG_RE's `--notes` branch
// (`release create`/`release edit`).
const NOTES_SHORT_FLAG_DETECT_RE = new RegExp(
  String.raw`\s-n${SHORT_FLAG_VALUE_SEP}\S`,
  "g"
);
const NOTES_SHORT_FLAG_DETECT_TEST_RE = new RegExp(NOTES_SHORT_FLAG_DETECT_RE.source, NOTES_SHORT_FLAG_DETECT_RE.flags.replace("g", ""));

// `-t`/`--subject` (`pr merge` only) — an entirely new surface; neither form
// was previously recognized anywhere in this file. The merge-commit subject
// is literal attacker-influenceable text that lands in the repository's
// commit graph, so — unlike `-T`/`--template` below — this ALSO needs
// extraction into its own buffer (subjectMatch further down): appending it
// into `body` would push a valid trailing footer out of hasFooter's 240-char
// tail window, so it is scanned for attribution separately instead.
const SUBJECT_FLAG_DETECT_RE = new RegExp(
  String.raw`(?:\s-t${SHORT_FLAG_VALUE_SEP}\S)|(?:--subject(?:\s+\S|=))`,
  "g"
);
const SUBJECT_FLAG_DETECT_TEST_RE = new RegExp(SUBJECT_FLAG_DETECT_RE.source, SUBJECT_FLAG_DETECT_RE.flags.replace("g", ""));

// `-T`/`--template` (`pr create` and `issue create`) — an entirely new
// surface, detection-only. `pr create`'s `-T` is a local template FILE path;
// `issue create`'s `-T` is a template NAME gh resolves against
// `.github/ISSUE_TEMPLATE/` — this hook does not replicate that resolution
// logic for either shape. Safe without extraction because an empty `body`
// buffer already fails hasFooter('') and blocks by default (see hasFooter
// below) — detection here only forces that fail-closed outcome unless an
// accompanying `--body`/`-b` supplies a compliant footer.
const TEMPLATE_FLAG_DETECT_RE = new RegExp(
  String.raw`(?:\s-T${SHORT_FLAG_VALUE_SEP}\S)|(?:--template(?:\s+\S|=))`,
  "g"
);
const TEMPLATE_FLAG_DETECT_TEST_RE = new RegExp(TEMPLATE_FLAG_DETECT_RE.source, TEMPLATE_FLAG_DETECT_RE.flags.replace("g", ""));

// Authoritative gh write-back subcommand allow-list for the bare `-F <path>`
// alias (`api` excluded per design.md D3 — must not be expanded from memory;
// any expansion requires the brd.md §14 stop condition). One named Set,
// referenced at all three consumption sites below plus the extraction
// pattern further down, so a future edit to the surface list cannot
// silently update one site and leave the other two (or the extraction
// gate) unfiltered — the "half-fix" failure mode design.md explicitly
// calls out.
//
// Membership criterion (not a closed historical list): a subcommand
// belongs here iff gh's own `--help` for that subcommand shows a `-F`
// short flag that aliases `--body-file` or `--notes-file` (a bare
// path/content carrier), as opposed to `gh api`-style `-F key=value`
// (a typed field). This criterion, not brd.md §5 FR3's original 8-item
// enumeration, is what this Set MUST stay in sync with — FR3 undercounted
// the true membership by 3 (`pr review`, `pr merge`, `pr revert`), each
// found by a separate review round because the original enumeration was
// never re-derived from gh's actual flag surface. `pr review`/`pr merge`
// were added by dp-reviewer round 7's Important I-1; `pr revert` by round
// 8's Critical C-1 (decisions.md; both are user-authorized D3 scope
// expansions via the brd.md §14 stop condition, backed by empirical
// verification, not memory).
//
// This list was last mechanically regenerated against gh 2.89.0 by
// running `gh help <group> --help` for group in {pr, issue, release,
// gist, repo, run, workflow} to enumerate subcommands, then `gh <group>
// <cmd> --help` per subcommand and grepping for a `-F,` flag line — see
// hook-gh-footer-gate.test.mjs GFG-26a, which deep-equals this exact
// 11-item set against a frozen array in the test file (no `gh` process is
// spawned), so an ACCIDENTAL edit to this Set fails a test. GFG-26a cannot
// detect drift against a real future gh release: that requires manually
// re-running the regeneration recipe above and updating both this Set and
// GFG-26a's expected array — no test catches a live `gh` CLI surface change.
const GH_BARE_F_SUBCOMMANDS = new Set([
  'pr create', 'pr edit', 'pr comment', 'pr review', 'pr merge', 'pr revert',
  'issue create', 'issue edit', 'issue comment',
  'release create', 'release edit',
]);

// C-1 (round 11) sibling allow-lists for BODY_SHORT_FLAG_DETECT_RE /
// NOTES_SHORT_FLAG_DETECT_RE / SUBJECT_FLAG_DETECT_RE / TEMPLATE_FLAG_DETECT_RE
// above. Each is a SEPARATE, independently regenerated Set rather than a
// derivation of GH_BARE_F_SUBCOMMANDS or one another: the flags answer
// different `gh --help` questions, and a coincidental numeric/membership
// overlap today must not couple their futures to a shared source (the same
// "half-fix"/silent-drift concern GH_BARE_F_SUBCOMMANDS' own comment names).
// Each was mechanically regenerated against gh 2.89.0 by running `gh <cmd>
// --help` per subcommand and grepping for the named flag; see
// hook-gh-footer-gate.test.mjs's frozen deep-equal tests for these exact
// sets (no `gh` process is spawned at runtime).
const BODY_SHORT_FLAG_SUBCOMMANDS = new Set([
  'pr create', 'pr edit', 'pr comment', 'pr review', 'pr merge', 'pr revert',
  'issue create', 'issue edit', 'issue comment',
]);
const NOTES_SHORT_FLAG_SUBCOMMANDS = new Set(['release create', 'release edit']);
const SUBJECT_FLAG_SUBCOMMANDS = new Set(['pr merge']);
const TEMPLATE_FLAG_SUBCOMMANDS = new Set(['pr create', 'issue create']);

// `-R`/`--repo [HOST/]OWNER/REPO` is gh's only real inherited global flag
// besides the security-irrelevant `--help` (confirmed via `gh --help`, `gh pr
// create --help`, `gh issue create --help`, `gh release create --help`). When
// it precedes the subcommand (`gh --repo o/r pr create …`, `gh -Rowner/repo
// pr edit …`), it must be stripped before subcommand resolution — reuses the
// existing SHORT_FLAG_VALUE_SEP/FLAG_VALUE_SEP separators so the same
// spaced/zero-width-attached/`=`-form/continuation-split value shapes already
// supported elsewhere in this file are recognized here too.
//
// Round-22 (PR #1895, dispatch-c395b2a2 fault-recovery re-review): the two
// PLAIN token-boundary separators this regex owns directly — `gh` to the
// flag, and the repo VALUE to the subcommand — were still bare `\s+`, not
// continuation-aware. A backslash-newline in either position (`gh
// \<newline>--repo o/r pr create …` or `gh --repo o/r \<newline>pr create
// …`) does not match plain `\s+`, so the WHOLE regex fails to match, the
// leading global flag is never stripped, ghSubcommandFrom's two-token window
// resolves to `--repo owner/repo` (or similar) instead of the real
// subcommand, and all five subcommand-gated surfaces fail open exactly as
// the pre-round-20 bug did. Confirmed by direct repro on both positions
// (bare `-F`, footerless body: exit 0 instead of exit 1). Fixed by using
// CONTINUATION_WS_SEP (the whitespace-or-continuation half of
// FLAG_VALUE_SEP, with no `=` alternative — `=` is not valid shell syntax at
// a plain token boundary) for both separators, so this regex matches across
// a continuation split at either position instead of only within the
// `--repo`'s own flag=value join.
const GH_GLOBAL_REPO_FLAG_RE = new RegExp(
  String.raw`^gh${CONTINUATION_WS_SEP}(?:-R${SHORT_FLAG_VALUE_SEP}|--repo${FLAG_VALUE_SEP})\S+${CONTINUATION_WS_SEP}`
);

// Resolve the (up to) two-token subcommand ("pr create", "issue edit", …)
// that a text slice STARTING AT a `gh` invocation's own token declares. Used
// both by absolute-offset lookups (ghInvocationSubcommandAt, for
// isGhWriteBack/ghWriteBackOperations) and directly against the heredoc-owner
// substring (which has no shared absolute offsets with `command`).
//
// dp-second-reviewer round-19 (PR #1895) found that a leading global flag
// before the subcommand (`gh --repo o/r pr create -F <footerless-file>
// --title t`) was not merely "a missed bare-F detection": with the
// subcommand window resolving to e.g. "--repo owner/repo" (matching NO
// allow-list entry), ALL FIVE subcommand-gated allow-lists
// (GH_BARE_F_SUBCOMMANDS / BODY_SHORT_FLAG_SUBCOMMANDS /
// NOTES_SHORT_FLAG_SUBCOMMANDS / SUBJECT_FLAG_SUBCOMMANDS /
// TEMPLATE_FLAG_SUBCOMMANDS) stand down together, skipping footer/attribution
// enforcement for the WHOLE invocation when no other recognized long-form
// write-back flag is present. Confirmed by direct repro on two of the five
// surfaces (bare `-F` and `-b`/pr edit): an identical footerless body blocks
// (exit 1) without `--repo`/`-R`, but passes silently (exit 0) with it
// prepended. Fixed by stripping a leading GH_GLOBAL_REPO_FLAG_RE match before
// resolving the subcommand window, so the fix applies to all five gated
// surfaces at this one shared root-cause function.
//
// Round-26 (PR #1895, dispatch-c2216e2f): a SECOND leading --repo/-R
// occurrence (`gh --repo o/r1 --repo o/r2 pr create -F <footerless>`)
// survived a single non-looped .exec() strip — `rest` became
// `gh --repo owner/repo2 pr create …`, so the plain two-token subcommand
// regex below resolved to the still-present "--repo owner/repo2" pair
// instead of "pr create", standing down all five subcommand-gated surfaces
// exactly like round-20's original single-flag bug. Loop the strip instead
// of a single .exec() so every leading occurrence is removed before
// resolving the subcommand window.
//
// fix-pre-verb-repo-flag-gates: gh also reads -R/--repo between the first subcommand word and the second
// (`gh pr -R o/r create -F <footerless>`). Left in the window it resolved the subcommand to "pr -R", so all five
// gated surfaces stood down again; every such occurrence is stripped the same way, in the same function.
const GH_SUBCOMMAND_REPO_FLAG_RE = new RegExp(
  String.raw`^(?:-R${SHORT_FLAG_VALUE_SEP}|--repo${FLAG_VALUE_SEP})\S+${CONTINUATION_WS_SEP}`
);
function ghSubcommandFrom(sliceFromGhToken) {
  let rest = sliceFromGhToken;
  for (let globalFlagMatch = GH_GLOBAL_REPO_FLAG_RE.exec(rest); globalFlagMatch; globalFlagMatch = GH_GLOBAL_REPO_FLAG_RE.exec(rest)) {
    rest = `gh ${rest.slice(globalFlagMatch[0].length)}`;
  }
  const first = /^gh\s+(\S+)/.exec(rest);
  if (!first) return '';
  let tail = rest.slice(first[0].length).replace(/^\s+/, "");
  for (let flagMatch = GH_SUBCOMMAND_REPO_FLAG_RE.exec(tail); flagMatch; flagMatch = GH_SUBCOMMAND_REPO_FLAG_RE.exec(tail)) {
    tail = tail.slice(flagMatch[0].length);
  }
  const second = /^(\S+)/.exec(tail);
  return second ? `${first[1]} ${second[1]}` : first[1];
}

// Segment the command ONCE; reused by isGhWriteBack and every body-source
// extractor below so a gh-write literal that lives only as DATA (a quoted
// `git commit -m "...gh ... --body-file /x..."` argument, a `cat > f <<EOF ... gh
// ... --body-file /x ... EOF` heredoc body, a comment) is never mis-read as a real
// write-back. Mirrors pre-tool-gate.mjs's shell-aware flag/verb matching. Fail-safe:
// segmentCommand returns a single command-segment on parse error (its own catch), so
// isMatchInCommandSegment returns true and a parser bug never opens a bypass.
// That fallback is no longer byte-for-byte "prior regex-only behavior", though:
// failClosedIfUnextracted below counts a body-file flag occurrence as unaudited
// unless it also extracts, so under the fallback a flag mentioned only in DATA
// becomes an occurrence and hard-blocks. The direction stays safe — over-block,
// never bypass — but do not read this fail-safe as behavior-preserving.
// (output-discipline spec §"Footer Gate Write-Back Detection Is Command-Segment
// Aware".)
let _segs = null;
try { _segs = segmentCommand(command); } catch { _segs = null; }

// True only when a regex match position falls in a real command segment.
function inCmdSegment(idx) {
  return isMatchInCommandSegment(idx, _segs);
}

function ghTokenPosition(match) {
  return match.indices[1][0];
}

// Absolute-offset counterpart of ghSubcommandFrom: which `gh` invocation (by
// nearest command-position `gh` at or before idx) owns a candidate match, and
// what subcommand does IT declare. Shared by isGhWriteBack and
// ghWriteBackOperations — the two consumption sites that operate on `command`
// offsets directly (heredocOwnerIsGhWriteBack works on a substring instead
// and calls ghSubcommandFrom directly; see there).
function ghInvocationSubcommandAt(idx) {
  let owner = -1;
  // A `gh` token can only own idx's match if both live in the same execution
  // scope: a $(...)/backtick subshell's promoted content is flattened into
  // command-kind segments indistinguishable-by-kind from top-level text, so
  // without this check a `gh` invocation OUTSIDE a subshell would incorrectly
  // claim ownership of a match promoted from INSIDE an unrelated subshell
  // (`gh pr create --title $(grep -F feat notes.txt) --body-file x`) — see
  // scopeIdAt in shell-context.mjs.
  const targetScope = scopeIdAt(idx, _segs);
  for (const m of command.matchAll(GH_CMD_POS_RE)) {
    const ghPos = ghTokenPosition(m);
    if (!inCmdSegment(ghPos)) continue;
    if (scopeIdAt(ghPos, _segs) !== targetScope) continue;
    if (ghPos > idx) break;
    owner = ghPos;
  }
  if (owner === -1) return '';
  // Bound the owner's span to its own shell invocation (same helper
  // ghWriteBackOperations already uses): the nearest PRECEDING gh position is
  // not necessarily the same invocation as idx when a `&&`/`;`/`|`/newline
  // separates them (`gh pr comment ... --body-file x && grep -F pattern
  // file`) — without this bound, ghSubcommandFrom(command.slice(owner)) reads
  // all the way to end of string and resolves the LATER command's unrelated
  // `-F` flag as belonging to the earlier `gh` invocation's subcommand.
  const end = shellInvocationEnd(owner);
  if (idx >= end) return '';
  return ghSubcommandFrom(command.slice(owner, end));
}

// The one index predicate shared by isGhWriteBack and ghWriteBackOperations:
// a BARE_F_DETECT_RE match only counts as the bare `-F <path>` alias when its
// owning gh invocation's subcommand is in GH_BARE_F_SUBCOMMANDS. `gh api -F
// body=@x` / `gh api -F labels=bug` resolve to subcommand "api" — excluded —
// so this never doubles up with (or falsely blocks) the existing `-F/--field
// body=` surface already owned by WRITEBACK_FLAG_RE / F_FILE_ARG_RE.
// Shared by isGhBareFAliasMatch and the four C-1 (round 11) sibling
// predicates below: a match only counts as its surface's alias when the
// owning gh invocation's subcommand is in that surface's OWN allow-list. One
// helper so a fix to the membership-check LOGIC (not membership itself —
// each surface keeps its own Set) cannot silently update one predicate and
// leave another on stale logic.
function ghInvocationSubcommandInSet(matchIndex, subcommandSet) {
  return subcommandSet.has(ghInvocationSubcommandAt(matchIndex));
}

function isGhBareFAliasMatch(matchIndex) {
  return ghInvocationSubcommandInSet(matchIndex, GH_BARE_F_SUBCOMMANDS);
}

function isGhBodyShortFlagMatch(matchIndex) {
  return ghInvocationSubcommandInSet(matchIndex, BODY_SHORT_FLAG_SUBCOMMANDS);
}

function isGhNotesShortFlagMatch(matchIndex) {
  return ghInvocationSubcommandInSet(matchIndex, NOTES_SHORT_FLAG_SUBCOMMANDS);
}

function isGhSubjectFlagMatch(matchIndex) {
  return ghInvocationSubcommandInSet(matchIndex, SUBJECT_FLAG_SUBCOMMANDS);
}

function isGhTemplateFlagMatch(matchIndex) {
  return ghInvocationSubcommandInSet(matchIndex, TEMPLATE_FLAG_SUBCOMMANDS);
}

// Membership-agnostic counterpart of ghInvocationSubcommandInSet: true when a
// match belongs to ANY real gh invocation, regardless of which subcommand.
// subjectText extraction (below) uses this instead of
// isGhSubjectFlagMatch/SUBJECT_FLAG_SUBCOMMANDS — see the comment at
// subjectMatch's declaration for why the two gates must diverge.
function isAnyGhInvocationMatch(matchIndex) {
  return ghInvocationSubcommandAt(matchIndex) !== '';
}

// Single structured writeback traversal SSOT (#2071): one owner-aware analysis
// object feeds both membership (isGhWriteBack) and operation spans
// (ghWriteBackOperations). Consumers MUST NOT re-run the six-surface matchAll
// loops or rebuild ownership independently — isGhWriteBack ⇔ operations.length > 0.
// Surface order is stable/testable. Detection uses matchAll only on global
// DETECT_REs (no .test/.exec) so lastIndex cannot leak; heredoc keeps its
// separate substring-local *_TEST_RE probes (see heredocOwnerIsGhWriteBack).
const WRITEBACK_TRAVERSAL_STATS = { helper_calls: 0, surface_matchAll_passes: 0 };
let _writebackAnalysisCache = null;

function collectWritebackFlagHits(cmd) {
  const hits = [];
  // Stable six-surface order (design D1). One matchAll pass per surface.
  WRITEBACK_TRAVERSAL_STATS.surface_matchAll_passes += 1;
  for (const m of cmd.matchAll(WRITEBACK_FLAG_RE)) {
    if (inCmdSegment(m.index)) hits.push({ index: m.index, surfaceId: 'writeback-flag' });
  }
  WRITEBACK_TRAVERSAL_STATS.surface_matchAll_passes += 1;
  for (const m of cmd.matchAll(BARE_F_DETECT_RE)) {
    if (inCmdSegment(m.index) && isGhBareFAliasMatch(m.index)) {
      hits.push({ index: m.index, surfaceId: 'bare-f' });
    }
  }
  WRITEBACK_TRAVERSAL_STATS.surface_matchAll_passes += 1;
  for (const m of cmd.matchAll(BODY_SHORT_FLAG_DETECT_RE)) {
    if (inCmdSegment(m.index) && isGhBodyShortFlagMatch(m.index)) {
      hits.push({ index: m.index, surfaceId: 'body-short' });
    }
  }
  WRITEBACK_TRAVERSAL_STATS.surface_matchAll_passes += 1;
  for (const m of cmd.matchAll(NOTES_SHORT_FLAG_DETECT_RE)) {
    if (inCmdSegment(m.index) && isGhNotesShortFlagMatch(m.index)) {
      hits.push({ index: m.index, surfaceId: 'notes-short' });
    }
  }
  WRITEBACK_TRAVERSAL_STATS.surface_matchAll_passes += 1;
  for (const m of cmd.matchAll(SUBJECT_FLAG_DETECT_RE)) {
    if (inCmdSegment(m.index) && isGhSubjectFlagMatch(m.index)) {
      hits.push({ index: m.index, surfaceId: 'subject' });
    }
  }
  WRITEBACK_TRAVERSAL_STATS.surface_matchAll_passes += 1;
  for (const m of cmd.matchAll(TEMPLATE_FLAG_DETECT_RE)) {
    if (inCmdSegment(m.index) && isGhTemplateFlagMatch(m.index)) {
      hits.push({ index: m.index, surfaceId: 'template' });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const deduped = [];
  for (const hit of hits) {
    if (deduped.length > 0 && deduped[deduped.length - 1].index === hit.index) continue;
    deduped.push(hit);
  }
  return deduped;
}

function analyzeGhWriteBack(cmd) {
  if (_writebackAnalysisCache && _writebackAnalysisCache.cmd === cmd) {
    return _writebackAnalysisCache.analysis;
  }
  WRITEBACK_TRAVERSAL_STATS.helper_calls += 1;
  const ghPositions = [];
  // Start of each invocation's command-position match, which covers its environment prefix.
  const prefixStarts = new Map();
  for (const m of cmd.matchAll(GH_CMD_POS_RE)) {
    // Capture indices identify the executable token itself. String search is unsafe:
    // an env assignment or executable-path prefix can contain `gh` before the verb.
    const ghPos = ghTokenPosition(m);
    if (inCmdSegment(ghPos)) {
      ghPositions.push(ghPos);
      prefixStarts.set(ghPos, m.index);
    }
  }
  // No command-segment `gh` → empty analysis (preserves pre-share early-return:
  // non-gh PreToolUse must not pay six surface matchAlls). Fail-safe: cannot be
  // write-back without a gh invocation owner.
  if (ghPositions.length === 0) {
    const analysis = { hits: [], ghPositions, operations: [] };
    _writebackAnalysisCache = { cmd, analysis };
    return analysis;
  }
  // Surface matchAll lives in collectWritebackFlagHits (same analysis owner).
  const hits = collectWritebackFlagHits(cmd);
  const operations = ghPositions.flatMap((ghPos, index) => {
    const end = shellInvocationEnd(ghPos, ghPositions[index + 1] ?? cmd.length);
    return hits.some((hit) => hit.index >= ghPos && hit.index < end)
      ? [{ ghPos, end, prefixStart: prefixStarts.get(ghPos) }]
      : [];
  });
  const analysis = { hits, ghPositions, operations };
  _writebackAnalysisCache = { cmd, analysis };
  return analysis;
}

function maybeDumpWritebackTraversalStats() {
  const statsPath = env.DEVPRO_GH_FOOTER_BENCH_STATS_PATH;
  if (!statsPath) return;
  try {
    writeFileSync(statsPath, `${JSON.stringify({
      ...WRITEBACK_TRAVERSAL_STATS,
      process_version: process.version,
    })}\n`);
  } catch {
    // Bench instrumentation must never change gate polarity.
  }
}

function isGhWriteBack(cmd) {
  // Membership === owner-aware operations non-empty (same analysis as ghWriteBackOperations).
  return analyzeGhWriteBack(cmd).operations.length > 0;
}

function shellInvocationEnd(start, hardEnd = command.length) {
  // A $(...)/backtick subshell's content is flattened into "command"-kind
  // segments indistinguishable-by-kind from top-level text (see scopeIdAt in
  // shell-context.mjs), so a boundary char INSIDE a nested subshell (e.g. the
  // `;` in `$(printf x; printf y)`) must not be treated as an outer
  // invocation boundary — only a boundary that shares `start`'s own scope
  // actually ends THIS invocation. Same scope-vs-kind distinction
  // ghInvocationSubcommandAt already applies when resolving a `gh` token's
  // owner (round-26).
  const startScope = scopeIdAt(start, _segs);
  for (let index = start; index < hardEnd; index += 1) {
    if (!inCmdSegment(index)) continue;
    // A backslash immediately followed by a (CR)LF is a shell line-continuation,
    // not an invocation boundary — skip both so a flag on the continued
    // physical line (e.g. `-F <path>`, `--body-file <path>`) still resolves
    // inside this span. Shared by ghInvocationSubcommandAt (bare -F alias
    // owner resolution) and ghWriteBackOperations (rules-context release-
    // integrity checks) — fixing both here keeps them from drifting apart.
    if (command[index] === '\\') {
      const afterBackslash = command.slice(index + 1, index + 3);
      const continuationLen = afterBackslash.startsWith('\r\n')
        ? 2
        : afterBackslash.startsWith('\n')
          ? 1
          : 0;
      if (continuationLen > 0) {
        index += continuationLen;
        continue;
      }
    }
    if (scopeIdAt(index, _segs) !== startScope) continue;
    if (command.startsWith('&&', index) || command.startsWith('||', index)) return index;
    if (command[index] === ';' || command[index] === '\n' || command[index] === '|' || command[index] === '&') {
      return index;
    }
  }
  return hardEnd;
}

function ghWriteBackOperations() {
  // Same cached analysis as isGhWriteBack — no second six-surface matchAll pass.
  return analyzeGhWriteBack(command).operations;
}

function operationHead(operation) {
  const matches = [];
  const headValueRe = /--head(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|()<>]+))/g;
  for (const match of command.matchAll(headValueRe)) {
    if (match.index < operation.ghPos || match.index >= operation.end || !inCmdSegment(match.index)) continue;
    matches.push(match[1] ?? match[2] ?? match[3] ?? '');
  }

  let flagCount = 0;
  const headFlagRe = /--head(?:=|\s|$)/g;
  for (const match of command.matchAll(headFlagRe)) {
    if (match.index >= operation.ghPos && match.index < operation.end && inCmdSegment(match.index)) flagCount += 1;
  }

  const rulesSignal = matches.some((value) => value.startsWith('rules/'));
  if (flagCount === 0) return { supplied: false, value: null, rulesSignal: false };
  if (flagCount !== 1 || matches.length !== 1 || !matches[0]) {
    return { supplied: true, value: null, malformed: true, rulesSignal };
  }
  return { supplied: true, value: matches[0], malformed: false, rulesSignal };
}

const RULES_CONTEXT_REMEDIATION =
  'Remediation: run from the exact rules worktree via hook-visible `cd <abs-rules-worktree>`, workdir, or a command-local `DEVPRO_PR_CHECKOUT=<abs-rules-worktree>` prefix and supply canonical `--head rules/<source>-v<X.Y.Z>`.';

// The command-local DEVPRO_PR_CHECKOUT declaration in the environment prefix of this gh invocation (from its
// command-position match up to the gh token), read by the same parser as the other gh pr create gates (#3647).
// null when absent.
function declaredOperationCheckout(operation) {
  if (!Number.isInteger(operation.prefixStart)) return null;
  return declaredPrCheckout(command, operation.prefixStart, operation.ghPos);
}

function unresolvedRulesContext(detail) {
  return {
    kind: 'unresolved',
    reason: `Rules operation context unresolved (release-integrity): ${detail} ${RULES_CONTEXT_REMEDIATION}`,
  };
}

function rulesOperationVersionContext() {
  const operations = ghWriteBackOperations();
  const fallbackBranch = _hookCwd ? getCurrentBranch(_hookCwd) : '';
  const fallbackRulesSignal = fallbackBranch.startsWith('rules/');
  const rulesContexts = [];
  let genericOperationCount = 0;

  for (const operation of operations) {
    const head = operationHead(operation);
    const declared = declaredOperationCheckout(operation);
    const operationCwd = declared
      ? (declared.error ? UNRESOLVABLE_CWD : declared.cwd)
      : commandCwdAt(
        command,
        _hookCwd || cwd,
        operation.ghPos,
        'gh',
        { requireExplicitChdir: !_hookCwd }
      );
    const cwdResolved = operationCwd !== UNRESOLVABLE_CWD;
    const repoRoot = cwdResolved ? getRepoRoot(operationCwd) : '';
    const currentBranch = repoRoot ? getCurrentBranch(operationCwd) : '';
    const rulesSignal = currentBranch.startsWith('rules/') || head.rulesSignal ||
      (!cwdResolved && fallbackRulesSignal);

    if (!rulesSignal) {
      genericOperationCount += 1;
      continue;
    }
    if (!cwdResolved || !repoRoot || !currentBranch) {
      return unresolvedRulesContext(
        declared?.error
          ? `${declared.error}.`
          : 'cannot resolve the exact cwd, repository root, or current branch for a rules write-back.'
      );
    }
    if (head.malformed) {
      return {
        kind: 'mismatch',
        reason: 'Rules operation context mismatch (release-integrity): --head is malformed or ambiguous for a rules write-back.',
      };
    }

    let currentIdentity;
    let headIdentity = null;
    try {
      currentIdentity = rulesSyncBranchIdentity(currentBranch, repoRoot);
      if (head.supplied) headIdentity = rulesSyncBranchIdentity(head.value, repoRoot);
    } catch {
      return unresolvedRulesContext(
        'rules source whitelist is missing or unreadable in the operation worktree.'
      );
    }

    if (currentIdentity.kind === 'unresolved' || headIdentity?.kind === 'unresolved') {
      return unresolvedRulesContext(
        currentIdentity.kind === 'unresolved'
          ? currentIdentity.reason
          : headIdentity.reason
      );
    }
    if (currentIdentity.kind !== 'rules') {
      return {
        kind: 'mismatch',
        reason: `Rules operation context mismatch (release-integrity): current branch ${currentBranch || '<unknown>'} is not a canonical whitelisted rules branch.`,
      };
    }
    if (head.supplied && (headIdentity?.kind !== 'rules' || headIdentity.branch !== currentIdentity.branch)) {
      return {
        kind: 'mismatch',
        reason: `Rules operation context mismatch (release-integrity): explicit --head ${head.value || '<invalid>'} does not equal current branch ${currentIdentity.branch}.`,
      };
    }

    const agentsVersion = readAgentsMdVersion(repoRoot);
    if (agentsVersion === null) {
      return unresolvedRulesContext(
        'operation-worktree AGENTS.md version is unreadable or unparseable.'
      );
    }
    if (compareVersions(currentIdentity.version, agentsVersion) !== 0) {
      return {
        kind: 'mismatch',
        reason: `Rules operation context mismatch (release-integrity): current branch ${currentIdentity.branch} declares v${currentIdentity.version} but operation-worktree AGENTS.md declares ${agentsVersion}.`,
      };
    }

    rulesContexts.push({
      repoRoot,
      branch: currentIdentity.branch,
      version: agentsVersion,
    });
  }

  if (rulesContexts.length === 0) {
    const generic = agentsMdVersionForVersionEquality();
    return { kind: 'generic', version: generic.version };
  }

  if (rulesContexts.length > 1) {
    return unresolvedRulesContext(
      'compound rules write-back contains multiple operations whose bodies cannot be bound independently; split them into separate commands.'
    );
  }

  if (genericOperationCount > 0) {
    return unresolvedRulesContext(
      'compound write-back mixes rules and generic operation contexts.'
    );
  }

  return {
    kind: 'rules',
    version: rulesContexts[0].version,
    branch: rulesContexts[0].branch,
    repoRoot: rulesContexts[0].repoRoot,
  };
}

if (!isGhWriteBack(command)) {
  maybeDumpWritebackTraversalStats();
  exit(0);
}
maybeDumpWritebackTraversalStats();

let body = '';
let readFailed = false;
// True when at least one FAILED body source was a relative path (issue #1158).
// Used only to decide whether the read-fail block reason should carry the Codex
// cwd-absence diagnostic — a relative path is the prerequisite for the "resolved
// against the wrong (main-worktree) base" failure mode. Absolute-path read
// failures (file genuinely missing / wrong path) are NOT this cause.
let readFailedRelativePath = false;
const bodySourcePaths = [];

function shellTokenValue(token) {
  const s = (token || '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function resolveBodyPath(rawPath) {
  const filePath = shellTokenValue(rawPath);
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(_hookCwd || cwd, filePath);
}

// capMb: when set, stat the file first and refuse (fail-closed) anything larger
// than the cap before reading it into memory — used for the `-F body=@file` /
// `$(cat file)` surfaces where the path is attacker-influenced. Omit the cap for
// the plain `--body-file` / `--notes-file` surfaces.
function safeRead(rawPath, { capMb } = {}) {
  const resolved = resolveBodyPath(rawPath);
  // Was the raw (pre-resolution) path relative? Drives the issue #1158 diagnostic.
  const wasRelative = !path.isAbsolute(shellTokenValue(rawPath));
  try {
    if (capMb && statSync(resolved).size > capMb * 1024 * 1024) {
      // Size-cap fail: the file EXISTS (statSync succeeded) but is too large.
      // Cause is size, NOT cwd resolution — do NOT set readFailedRelativePath,
      // so the #1158 cwd diagnostic (which advises an absolute path) stays
      // truthful and never attaches to a size failure. (cross-review suggestion)
      readFailed = true;
      return '';
    }
    const content = readFileSync(resolved, 'utf8');
    bodySourcePaths.push(resolved);
    return content;
  } catch {
    // Read threw — most commonly file-not-found, which under Codex cwd absence
    // is exactly the #1158 "relative path resolved against main worktree" case.
    readFailed = true;
    if (wasRelative) readFailedRelativePath = true;
    return '';
  }
}

// Canonical AGENTS.md of the repo this AI session runs the command in: the hook cwd checkout (its canonical remote
// tip first, then its workspace file), then the body-file repo when the cwd checkout yields no version (neutral cwd /
// host without cwd). The footer records the rules version the AI actually used, never the version of the repository
// the write lands in (issue #3437).
// `chore/bump-v<X.Y.Z>` is the one exception: that branch already carries the new version in its own AGENTS.md, but
// its PR footer must keep the canonical pre-bump version (ai-autonomy.md footer rules), so the body-file repo stays
// the anchor there.
function bodyFileCanonicalAgents() {
  for (const sourcePath of bodySourcePaths) {
    const sourceRepoRoot = getRepoRoot(path.dirname(sourcePath));
    if (sourceRepoRoot && sourceRepoRoot.length > 0) return readCanonicalAgentsMdVersion(sourceRepoRoot);
  }
  return null;
}

function defaultCanonicalAgents() {
  const cwdBranch = _fallbackRepoRoot ? getCurrentBranch(_fallbackRepoRoot) : '';
  if (cwdBranch.startsWith('chore/bump-v')) return bodyFileCanonicalAgents() ?? _fallbackCanonicalAgents;
  if (_fallbackCanonicalAgents.version !== null) return _fallbackCanonicalAgents;
  return bodyFileCanonicalAgents() ?? _fallbackCanonicalAgents;
}

// The version the footer must equal: `{ version }`. One anchor for every write shape, so `gh api`,
// `gh issue create` and `gh pr create -R <other-repo>` are judged the same way: the footer is provenance of the
// rules this session used, not of the target repository (issue #3437, withdrawing #3332's target comparison).
function agentsMdVersionForVersionEquality() {
  const resolved = defaultCanonicalAgents();
  _genericVersionAnchor = resolved.anchor;
  return { version: resolved.version };
}

// Every regex match whose start position falls in a real command segment.
// A body-content flag (`--body-file <path>`, `-F body=@<path>`, …) that appears only
// as DATA (quoted arg / heredoc body / comment) is skipped, so its literal path is
// never read. Mirrors the segment-aware flag matching in pre-tool-gate.mjs.
function cmdMatches(re) {
  const g = new RegExp(re.source, (re.flags || '').includes('g') ? re.flags : re.flags + 'g');
  return [...command.matchAll(g)].filter((m) => inCmdSegment(m.index));
}

// First such match, or null.
function firstCmdMatch(re) {
  return cmdMatches(re)[0] ?? null;
}

// --body "..." or --body '...' or --body="..." or --body='...'
const bodyMatch = firstCmdMatch(/--body[= ](["'])([\s\S]*?)\1/);
if (bodyMatch) body += bodyMatch[2];

// -b "..." / -b'...' / -b="..." — short-flag alias to --body (C-1, round 11).
// Subcommand-gated via isGhBodyShortFlagMatch/BODY_SHORT_FLAG_SUBCOMMANDS,
// mirroring fAliasMatch's shape (cmdMatches(...).find(predicate); see
// F_ALIAS_ARG_RE further down) rather than the unconditional bodyMatch/
// commentMatch extractions above. `-b` is a single-letter, high-collision
// token (`git checkout -b`, `docker run -b`, ...); an unrelated match would
// append into `body`, and since hasFooter (below) anchors on the last 240
// chars with a `$`-terminated, non-multiline regex, that appended text can
// push an already-valid trailing footer out of the tail window — a false
// BLOCK on an ordinary sibling command. (dp-reviewer round 12 Critical #1;
// an earlier version of this comment claimed the opposite — that extra
// appended text "can only make hasFooter MORE conservative" — which is
// false; see the -b/-n false-block prove-it tests in
// hook-gh-footer-gate.test.mjs.)
//
// dp-second-reviewer CRITICAL (cross-model review, PR #1895, round 16): this
// extraction required a QUOTED value on both -b and -n, while
// BODY_SHORT_FLAG_DETECT_RE/NOTES_SHORT_FLAG_DETECT_RE (isGhWriteBack) end in
// a bare `\S` and already recognize the unquoted attached/`=` forms as a
// write-back — the exact same detection-vs-extraction shape round-15 fixed
// for -t/--subject (SUBJECT_ARG_RE below). A second, separately-quoted
// --body/--notes on the same command could supply a compliant footer while
// an unquoted -b/-n carried a forbidden attribution marker straight past the
// scan (GFG-35a/b/c). SHORT_FLAG_TEXT_VALUE is this quoted-or-bare shape,
// hoisted here, above its first use, and reused by SUBJECT_ARG_RE further
// down (which used to duplicate it as its own SUBJECT_VALUE_ARG constant,
// now consolidated into this single named fragment) so the shape is defined
// once.
// failClosedIfUnextracted reuses the
// existing BODY_SHORT_FLAG_DETECT_RE/NOTES_SHORT_FLAG_DETECT_RE as the
// presence pattern (same `\s-b`/`\s-n` anchor as the extraction regex, so
// offsets agree) — a detected-but-unextracted occurrence (e.g. a value
// starting with a shell metacharacter this fragment still cannot elide, see
// SHORT_FLAG_BARE_ATOM below) now fails closed instead of silently
// vanishing, same backstop shape as the body-file surfaces above.
//
// dp-second-reviewer CRITICAL (cross-model review, PR #1895, round 23): the
// bare branch originally stopped at the FIRST excluded metacharacter,
// including `(`. An unquoted `--subject=$(printf '<forbidden marker>')`
// is detected as a write-back by SUBJECT_FLAG_DETECT_RE (bare `\S` after
// `=`), but the bare branch captured only the leading `$` before `(` ended
// the match — subjectText never contained the literal marker text sitting
// in cleartext inside the command-substitution argument, so
// hasForbiddenAttribution(subjectText) never saw it (same shape hit
// backtick- and `${...}`-form subjects with an internal space, truncating
// mid-word). SHORT_FLAG_BARE_ATOM treats one non-nested `$(...)` span, one
// backtick-quoted span, or one `${...}` span (one level of brace nesting,
// same depth ELIDING_RUN below already supports for TOKEN-START
// recognition — kept consistent rather than introducing a second,
// shallower nesting rule for the same construct family) as a SINGLE atom
// instead of stopping at its opening character, so the bare branch can
// cross it and keep capturing the rest of the value. This closes the
// reported repro and the backtick/`${...}` variants, but a value with
// nesting beyond that one level (e.g. `$(printf "$(echo ...)")`) or one
// starting with a genuine unelidable terminator (a bare `(` right after
// `=`, not part of `$(`) still cannot be captured atomically — those keep
// falling through to `failClosedIfUnextracted(SUBJECT_ARG_RE,
// SUBJECT_FLAG_DETECT_RE, isAnyGhInvocationMatch)` (wired below,
// subjectMatch's declaration), which is the genuine backstop for whatever
// this fragment cannot elide, not a redundant check.
//
// `$` and `` ` `` are deliberately EXCLUDED from the trailing plain-char
// atom, and only ever consumed via the dedicated `$`/backtick alternatives
// above (the bare-variable and special-parameter forms mirror
// ELIDING_RUN's own `\$[A-Za-z_][A-Za-z0-9_]*` / `\$[-@*!?#$0-9]`
// alternatives, so a plain `--subject=$SUBJECT_VAR` still extracts fully,
// same as before this fix). An earlier draft of this fragment left `$` in
// the plain-char class as a fallback; when the `$(...)`/`${...}`
// alternative failed to close atomically (the depth-2 nesting case
// above), the regex engine did not then fail the whole atom — it fell
// through to the plain-char alternative and matched the bare `$` by
// itself as one ordinary character, then stopped (the following `(`
// matches nothing). That produced a SHORTER but still non-empty,
// same-offset extraction match, which satisfies
// failClosedIfUnextracted's offset-presence check (it only asks "did
// some extraction match start here", not "did it consume the whole
// value") — reproducing the exact round-23 truncation bug one level
// deeper, silently, even with the backstop wired. Excluding `$`/backtick
// from the plain-char class means a `$`/backtick that cannot be resolved
// by one of the dedicated alternatives (nested beyond one level, or
// simply not a variable/special-parameter/substitution/backtick form)
// makes that ATOM POSITION fail to match.
//
// That alone is not sufficient: `(SHORT_FLAG_BARE_ATOM+)` is a repetition,
// so an atom-position failure only stops the `+` from consuming further —
// it does not fail the group already matched by earlier atoms. A value
// with ANY legitimate one-character prefix before the unresolvable `$`
// (e.g. `--subject=x$(printf "$(echo <marker>)")`) still produces a
// non-empty, same-offset capture of just that prefix ("x"), which still
// satisfies failClosedIfUnextracted's offset-presence check — reproducing
// the round-23 truncation bug a second time, this time hidden behind one
// ordinary character instead of appearing only at the very start of the
// value (round-24 continued; found via TL advisor-tool follow-up
// verification, not a new dp-second-reviewer cross-model dispatch, PR #1895).
// `(?=[\s;&|()<>]|$)` is a trailing lookahead requiring the atom run to
// stop only at a genuine shell-metacharacter terminator or end of string.
// If the `+` had to stop early because an atom position failed to match
// (an unresolvable `$`/backtick sitting mid-value), the character right
// after the captured prefix is that failed `$`/backtick itself — not a
// terminator — so the lookahead fails, which forces the engine to
// backtrack the `+` down through every shorter prefix and fail all of
// them for the same reason, ultimately failing the whole alternative.
// That converts "truncated match at the same offset" into "no match",
// which is exactly what failClosedIfUnextracted's offset-presence check
// can see and fail closed on.
const SHORT_FLAG_BARE_ATOM = String.raw`(?:\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|\$\([^()]*\)|\x60[^\x60]*\x60|\$[A-Za-z_][A-Za-z0-9_]*|\$[-@*!?#$0-9]|[^\s;&|()<>$\x60])`;
const SHORT_FLAG_TEXT_VALUE = String.raw`(?:"([^"]*)"|'([^']*)'|(${SHORT_FLAG_BARE_ATOM}+)(?=[\s;&|()<>]|$))`;
const BODY_SHORT_FLAG_ARG_RE = new RegExp(String.raw`\s-b${SHORT_FLAG_VALUE_SEP}${SHORT_FLAG_TEXT_VALUE}`);
const bodyShortMatch = cmdMatches(BODY_SHORT_FLAG_ARG_RE).find((m) => isGhBodyShortFlagMatch(m.index)) ?? null;
failClosedIfUnextracted(BODY_SHORT_FLAG_ARG_RE, BODY_SHORT_FLAG_DETECT_RE, isGhBodyShortFlagMatch);
if (bodyShortMatch) body += bodyShortMatch[1] ?? bodyShortMatch[2] ?? bodyShortMatch[3] ?? '';

// A body-file path argument: a quoted span, or a bare token that STOPS at the
// first shell metacharacter. `\S+` swallowed a metacharacter sitting directly
// against the path (`--body-file /abs/<body>.md; echo "exit=$?"` captured the
// trailing `;` as part of the path), so
// safeRead resolved a path that cannot exist. This gate is fail-closed on read
// failure, so that over-capture hard-blocked a legitimate write-back. Whitespace-
// separated connectors were never affected. `shellTokenValue` unwraps the quoted
// form. One fragment backs all four body-file surfaces below so a fix to one
// cannot silently leave the others exposed.
const BODY_PATH_ARG = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|<>()]+)`;

// Because BODY_PATH_ARG refuses to cross a shell metacharacter, an argument that
// STARTS with one makes the WHOLE flag pattern fail to match rather than merely
// capture less. A body source that silently vanishes is worse than one that
// over-captures: combined with a second `--body` carrying a valid footer, the
// dropped source sails through this gate completely unaudited — footer check,
// attribution brand-marker scan, all of it. That is the same strict-mix bypass
// the D3 note below already names, reached through a different door
// (`--body-file <(cat <unaudited>.md)`), confirmed on all four surfaces. The
// placeholder form is deliberate: a bare `<name>.md` token in this corpus is read
// by rule-hook-cite-validity.test.mjs as a rule-file citation and fails its scan.
// So: flag present in a command segment but no extractable argument → treat it
// as a read failure, which for a SINGLE occurrence restores exactly what the old
// `\S+` did here (it captured garbage, safeRead threw, readFailed). For a REPEATED
// flag whose first occurrence extracts, it is not a restoration but a new block:
// the old code read only the first match, so the later source reached `gh` with no
// footer or attribution scan at all. Measured against dae192ee, not recalled.
//
// Scope is per OCCURRENCE, not per command. A payload may repeat a body-file flag
// (`--body-file <a> --body-file <b>`), and WHICH occurrence `gh` actually sends is
// an external argument-parsing detail this gate deliberately does not depend on:
// assuming first-wins or last-wins would make a fail-closed gate correct in only
// one of the two worlds. So EVERY presence occurrence in a command segment must
// have an extraction match at the same offset; one that does not is an unaudited
// body source and sets the read-failure state regardless of which occurrence wins.
// Repeated occurrences that are ALL extractable stay open — chaining two separate
// gh commands with `&&` is legitimate — so this backstop never converts a
// well-formed payload into a block. One helper backs all four surfaces so the
// backstop cannot be wired to one site and forgotten on the rest.
// matchFilter: optional additional per-match predicate (index-based), beyond
// command-segment membership. Used by the bare `-F <path>` alias surface
// below to apply the SAME subcommand-gated predicate (isGhBareFAliasMatch) to
// both the extraction pattern and its presence backstop — so `gh api -F
// labels=bug` (subcommand excluded) is never counted as an unaudited
// occurrence of this surface. Defaults to "no filter", so the three existing
// call sites (BODY_FILE/NOTES_FILE/F_FILE) are unaffected.
function failClosedIfUnextracted(extractPattern, presencePattern, matchFilter = () => true) {
  const extracted = new Set(cmdMatches(extractPattern).filter((m) => matchFilter(m.index)).map((m) => m.index));
  for (const p of cmdMatches(presencePattern).filter((m) => matchFilter(m.index))) {
    if (!extracted.has(p.index)) readFailed = true;
  }
}

// A body-file flag is only a flag when it STARTS a shell token. inCmdSegment
// already drops the QUOTED data position, but a bare path token that contains the
// literal substring (`--body-file /abs/a--body-file=<frag>.md` — placeholder form
// for the same rule-cite-scanner reason as the note above) is entirely inside a
// command segment: extraction consumes that whole token in ONE match at the outer
// offset, so the inner presence hit has no same-offset extraction partner and the
// per-occurrence backstop above hard-blocks a legitimate write-back. Measured
// against dae192ee: 0 → 1 on --body-file and --notes-file. The `-F body=@` surface
// is immune by shape (whitespace between `-F` and `body=@`, which a bare token
// cannot contain) but carries the same anchor anyway, so a later edit cannot
// reintroduce the class on one surface while the others look fixed. Extraction and
// presence share the anchor so the two can never disagree about where an
// occurrence begins — the offsets the backstop compares stay meaningful. A shell
// metacharacter DOES end a token, so it stays in the class: an occurrence right
// after `;` is real and still fails closed when nothing extracts.
//
// A token start is a separator followed by any number of ELIDING constructs — not
// a single character. Two earlier cuts of this constant were a one-character class
// and both were wrong in the fail-open direction, for the same reason twice: bash
// lets a word begin with fragments that contribute nothing to argv, so the flag is
// still delivered bare while the character sitting immediately to its left belongs
// to the fragment, not to a separator. `$EMPTY--body-file` ends its prefix in `Y`,
// which is indistinguishable from the `c` in a real `notes/c--body-file=<frag>.md`
// (placeholder form, same rule-cite-scanner reason as above).
// NO one-character lookbehind can separate those two, in either polarity — which
// is why enumerating characters was not merely incomplete but non-convergent:
// adding `!`, `*` and `@` buys `$!` / `$*` / `$@` and leaves `$EMPTY`,
// `$UNSET$UNSET` and `$(true)$EMPTY` open for the next round. Measured, not
// argued: against dae192ee those six shapes were 1 → 0 on all three surfaces
// while the one-character class was in place — a net fail-open against production
// on an attribution gate.
//
// So the lookbehind spells out the run instead:
//   separator — `^` or whitespace or the control/redirect operators ; & | < > ( )
//   eliding   — ${…} (one nesting level), $(…), `…`, $NAME,
//               $@ $* $! $? $# $$ $- $0-$9, the EMPTY quote pairs '' and "" with
//               an optional `$` in front, and the escape \ , repeated.
// The `$` on the quote pairs and the one nesting level were a later round, and
// both came from measurement rather than from re-reading this regex: `$''` and
// `$""` elide exactly like `''` and `""`, and `${X:-${Y}}` was refused only
// because the braced alternative excluded inner braces outright. Adding them is
// not the enumeration this comment argues against — `$'` and `$"` are the whole
// set of quote-introducing dollar forms bash defines, so that is a closed family,
// not another guessed character. Nested $(…) deliberately stays as it was: it
// ends in `)`, which is already a separator, so widening it would change nothing.
// An eliding construct that is NOT empty (a `$!` with a background job, a
// `$(…)` that printed something) concatenates instead of vanishing, so the payload
// is not really a body-file flag; counting it anyway is over-detection in the
// FAIL-CLOSED direction — the gate audits a file it did not have to. That is the
// correct way to be wrong, and it is why the run is written permissively.
//
// What stays OUT is what makes this an anchor at all. An ordinary word character,
// `/`, `.`, `-` or `_` immediately before the literal is genuinely mid-token in a
// real path, which is the false block this anchor exists to close. `=` is out for
// the same reason — it is neither a separator nor an eliding construct, so a plain
// `FOO=--body-file` assignment is not read as a flag. Widening the separator class
// to a path character reopens the false block; narrowing the eliding run reopens
// the fail-open. Both directions are locked by behavioural tests, not by this
// comment. Residual, named as precisely as it is currently understood rather than
// implied: `${…}` nested more than one level deep (`${A:-${B:-${C}}}`) still falls
// out of the run, so the occurrence is dropped — the same fail-open class, and a
// regex cannot close it for arbitrary depth, which is why the boundary is drawn at
// a measured depth instead of at a guess. Any OTHER eliding construct not listed
// above belongs to the same class; the list is what has been measured, not a proof
// of completeness.
const ELIDING_RUN = String.raw`(?:\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|\$\([^()]*\)|\x60[^\x60]*\x60|\$[A-Za-z_][A-Za-z0-9_]*|\$[-@*!?#$0-9]|\$?''|\$?""|\\)*`;
const FLAG_TOKEN_START = String.raw`(?<=(?:^|[\s;&|<>()])${ELIDING_RUN})`;

// Named `*_ARG_RE`, not `BODY_FILE_RE`: pre-tool-gate.mjs already owns a
// `BODY_FILE_RE` with different semantics, and the `$(cat …)` note further down
// cites that one by name. Same name for two different regexes across sibling
// hooks would make every cross-hook reference ambiguous.
const BODY_FILE_ARG_RE = new RegExp(String.raw`${FLAG_TOKEN_START}--body-file${FLAG_VALUE_SEP}(${BODY_PATH_ARG})`);
const BODY_FILE_PRESENCE_RE = new RegExp(String.raw`${FLAG_TOKEN_START}--body-file${FLAG_VALUE_SEP}\S`);
const fileMatch = firstCmdMatch(BODY_FILE_ARG_RE);
failClosedIfUnextracted(BODY_FILE_ARG_RE, BODY_FILE_PRESENCE_RE);
if (fileMatch) body += safeRead(fileMatch[1]);

const NOTES_FILE_ARG_RE = new RegExp(String.raw`${FLAG_TOKEN_START}--notes-file${FLAG_VALUE_SEP}(${BODY_PATH_ARG})`);
const NOTES_FILE_PRESENCE_RE = new RegExp(String.raw`${FLAG_TOKEN_START}--notes-file${FLAG_VALUE_SEP}\S`);
const notesFileMatch = firstCmdMatch(NOTES_FILE_ARG_RE);
failClosedIfUnextracted(NOTES_FILE_ARG_RE, NOTES_FILE_PRESENCE_RE);
if (notesFileMatch) body += safeRead(notesFileMatch[1]);

// `-F|--field body=` accepts typed values in GitHub CLI, but this gate only
// understands the two supported body carriers below: @path and $(cat path).
// Detect every other command-segment value explicitly and block immediately so
// a second, valid carrier cannot mask an unsupported typed body.
const unsupportedTypedFieldMatch = firstCmdMatch(
  new RegExp(String.raw`${FLAG_TOKEN_START}(?:-F|--field)${TYPED_FIELD_SEP}(?:"body=|'body=|body=)(?!(?:@|["']?\$\(cat\s+))`)
);
if (unsupportedTypedFieldMatch) {
  block('Footer gate: unsupported typed -F/--field body value — blocked fail-closed; use -f/--raw-field for literal text or -F/--field body=@<path>.');
}

const fBodyMatch = firstCmdMatch(
  new RegExp(String.raw`${FLAG_TOKEN_START}(?:-f|--raw-field)${TYPED_FIELD_SEP}(?:"body=([\s\S]*?)"|'body=([\s\S]*?)'|body=(["']?)([\s\S]*?)\3(?=\s|$))`)
);
if (fBodyMatch) body += fBodyMatch[1] ?? fBodyMatch[2] ?? fBodyMatch[4] ?? '';

const F_FILE_ARG_RE = new RegExp(
  String.raw`${FLAG_TOKEN_START}(?:-F|--field)${TYPED_FIELD_SEP}(?:"body=@([^"]+)"|'body=@([^']+)'|body=@(${BODY_PATH_ARG}))`
);
const F_FILE_PRESENCE_RE = new RegExp(
  String.raw`${FLAG_TOKEN_START}(?:-F|--field)${TYPED_FIELD_SEP}["']?body=@\S`
);
const fFileMatch = firstCmdMatch(F_FILE_ARG_RE);
failClosedIfUnextracted(F_FILE_ARG_RE, F_FILE_PRESENCE_RE);
if (fFileMatch) body += safeRead(fFileMatch[1] ?? fFileMatch[2] ?? fFileMatch[3], { capMb: 1 });

// Bare `-F <path>` alias (T7, R3) — gh's own --body-file short form on the
// non-`api` write-back subcommands (GH_BARE_F_SUBCOMMANDS above). Reuses the
// same FLAG_TOKEN_START anchor and BODY_PATH_ARG fragment as BODY_FILE_ARG_RE
// — NOT folded into BODY_FILE_ARG_RE/BODY_FILE_PRESENCE_RE itself (S2,
// rejected in design.md D3): merging them would let a path literal containing
// a `--body-file=`-shaped substring collide with the unrelated `gh api -F
// body=@x` surface that F_FILE_ARG_RE/F_FILE_PRESENCE_RE already own,
// reopening a previously-fixed cross-surface collision class. Every match
// (extraction, presence, and the actual read below) is filtered through the
// SAME isGhBareFAliasMatch subcommand predicate used by the three write-back
// consumption sites, so `gh api -F body=@x` / `-F labels=bug` are correctly
// left alone here (already handled by F_FILE_ARG_RE, or not a body source at
// all) instead of being mis-read as an unaudited bare path.
const F_ALIAS_ARG_RE = new RegExp(String.raw`${FLAG_TOKEN_START}-F${SHORT_FLAG_VALUE_SEP}${BARE_F_NOT_TYPED_BODY}(${BODY_PATH_ARG})`);
const F_ALIAS_PRESENCE_RE = new RegExp(String.raw`${FLAG_TOKEN_START}-F${SHORT_FLAG_VALUE_SEP}${BARE_F_NOT_TYPED_BODY}\S`);
const fAliasMatch = cmdMatches(F_ALIAS_ARG_RE).find((m) => isGhBareFAliasMatch(m.index)) ?? null;
failClosedIfUnextracted(F_ALIAS_ARG_RE, F_ALIAS_PRESENCE_RE, isGhBareFAliasMatch);
if (fAliasMatch) body += safeRead(fAliasMatch[1]);

// -F/--field body="$(cat <file>)", body='$(cat <file>)', or body=$(cat <file>)
// Mirrors pre-tool-gate.mjs::BODY_FILE_RE for symmetry; session-recap.md §寫入方式
// keeps this form as a legacy Recap-write shape.
const fSubshellMatch = firstCmdMatch(
  // Flag-to-`body=` separator uses TYPED_FIELD_SEP (round-10 I-1 fix), same
  // as the other -F/--field typed-field body= consumers above — this is the
  // same surface, just with a $(cat …) carrier instead of @path. The
  // `cat\s+` internal separator further down is a different, unrelated join
  // point and stays whitespace-only.
  new RegExp(String.raw`${FLAG_TOKEN_START}(?:-F|--field)${TYPED_FIELD_SEP}(?:"|')?body=(?:"|')?\$\(cat\s+(\S+?)\)(?:"|')?`)
);
if (fSubshellMatch) {
  const subshellPath = fSubshellMatch[1];
  body += safeRead(subshellPath, { capMb: 1 });
}

const commentMatch = firstCmdMatch(
  new RegExp(String.raw`(?:--comment|--notes)${FLAG_VALUE_SEP}(["'])([\s\S]*?)\1`)
);
if (commentMatch) body += commentMatch[2];

// -n "..." / -n'...' / -n="..." — short-flag alias to --notes (C-1, round 11).
// Subcommand-gated via isGhNotesShortFlagMatch/NOTES_SHORT_FLAG_SUBCOMMANDS,
// same reasoning and same fix as bodyShortMatch above: `-n` is an even more
// collision-prone single-letter token (`sed -n`, `grep -n`, `echo -n`,
// `head -n`, `npm run x -- -n`, ...), and an unrelated match appending into
// `body` can push a valid trailing footer out of hasFooter's 240-char tail
// window — a false BLOCK, not a bypass. (dp-reviewer round 12 Critical #1.)
const NOTES_SHORT_FLAG_ARG_RE = new RegExp(String.raw`\s-n${SHORT_FLAG_VALUE_SEP}${SHORT_FLAG_TEXT_VALUE}`);
const notesShortMatch = cmdMatches(NOTES_SHORT_FLAG_ARG_RE).find((m) => isGhNotesShortFlagMatch(m.index)) ?? null;
failClosedIfUnextracted(NOTES_SHORT_FLAG_ARG_RE, NOTES_SHORT_FLAG_DETECT_RE, isGhNotesShortFlagMatch);
if (notesShortMatch) body += notesShortMatch[1] ?? notesShortMatch[2] ?? notesShortMatch[3] ?? '';

// -t "..." / -t'...' / --subject "..." / --subject="..." — `pr merge` commit-subject
// text (C-1, round 11). Extracted into a SEPARATE buffer, NOT `body`: an
// attacker-controlled subject long enough could push a legitimate trailing footer
// out of hasFooter's 240-char tail window if concatenated into `body`. Scanned
// independently for forbidden attribution below (hasForbiddenAttribution(subjectText)).
// `-T`/`--template` needs no extraction counterpart: it only names a template file
// for an interactive editor prompt, it does not itself supply body content, so
// hasFooter('') already blocks by default when no other source populates `body`.
//
// dp-second-reviewer CRITICAL (cross-model review, PR #1895): the original
// extraction regex required a QUOTED value on both branches, while
// SUBJECT_FLAG_DETECT_RE (isGhWriteBack) already recognizes the UNQUOTED
// attached form (`--subject=x`, bare `-tx`) as a write-back. An unquoted
// `--subject=` value carrying one of the forbidden brand markers from
// attribution-patterns.mjs (see hook-gh-footer-gate.test.mjs GFG-33a/b for the
// exact repro) was therefore detected as a write-back (the gate still ran
// against `body`) but subjectText stayed '' — hasForbiddenAttribution(subjectText)
// never scanned the very text carrying the marker. SHORT_FLAG_TEXT_VALUE
// (defined above, next to bodyShortMatch — round 16 hoisted it there and
// reuses it here instead of a second copy) mirrors BODY_PATH_ARG's
// quoted-or-bare shape to close that gap. Value-form: quoted-only ->
// quoted-or-bare (widened, then round-23 widened again via
// SHORT_FLAG_BARE_ATOM — see that constant's declaration for the
// command-substitution/backtick/brace-expansion truncation it closes and
// why a fail-closed backstop is wired below rather than relying on the
// widened atom alone).
//
// Extraction is now ALSO command-membership-gated — but deliberately via
// isAnyGhInvocationMatch, NOT isGhSubjectFlagMatch/SUBJECT_FLAG_SUBCOMMANDS.
// Command-membership: any command segment -> any real gh invocation
// (narrowed, same false-block fix shape as bodyShortMatch/notesShortMatch,
// round-12 Critical #1): an unrelated sibling command's quoted `-t "..."`
// (docker build -t, ssh -t, ...) must not be captured into subjectText.
// round-13 stop-loss (decisions.md, Suggestion (a), tracked as issue #1894)
// deferred gating this extraction via the narrow SUBJECT_FLAG_SUBCOMMANDS
// Set (['pr merge']) specifically because `-t`/`--title` is also the flag
// gh uses for PR/issue titles on OTHER subcommands (`pr create`, `issue
// create`, ...), and that broader-than-'pr merge' coverage was already an
// effective (if accidental) attribution scan on those titles — narrowing to
// SUBJECT_FLAG_SUBCOMMANDS was empirically confirmed (stash/pop A-B test) to
// silently disable it. isGhWriteBack's own SUBJECT_FLAG_SUBCOMMANDS gate
// (below, and in ghWriteBackOperations) answers a different, narrower
// question — does bare `-t`/`--subject` alone force the write-back gate to
// fire on THIS subcommand — and stays scoped to 'pr merge' commit-subject
// semantics; it is out of scope for this fix and unchanged. subjectText
// extraction answers is this `-t`/`--subject` value AI-writable text worth
// attribution-scanning, which holds for `-t`/`--title` on any gh subcommand,
// so it is gated on "belongs to any gh invocation" instead. A value belonging
// to some other gh subcommand's unrelated non-text `-t` flag (e.g. a sort
// order or enum) merely gets scanned for forbidden markers too, which cannot
// false-block unless that value itself coincidentally contains one.
const SUBJECT_ARG_RE = new RegExp(
  String.raw`(?:\s-t${SHORT_FLAG_VALUE_SEP}${SHORT_FLAG_TEXT_VALUE})|(?:--subject${FLAG_VALUE_SEP}${SHORT_FLAG_TEXT_VALUE})`
);
let subjectText = '';
const subjectMatch = cmdMatches(SUBJECT_ARG_RE).find((m) => isAnyGhInvocationMatch(m.index)) ?? null;
failClosedIfUnextracted(SUBJECT_ARG_RE, SUBJECT_FLAG_DETECT_RE, isAnyGhInvocationMatch);
if (subjectMatch) {
  subjectText += subjectMatch[1] ?? subjectMatch[2] ?? subjectMatch[3] ?? subjectMatch[4] ?? subjectMatch[5] ?? subjectMatch[6] ?? '';
}

// heredocMatch — command-segment ownership filtered (D1 fix, method B).
// A heredoc body is included in the footer-check buffer ONLY when the heredoc opener
// (`<<TAG`) is owned by the gh write-back command run, or is enclosed within a
// non-command segment (quoted-string / subshell) that IS part of a gh write-back
// argument. Two cases:
//   (a) << inside a non-command segment (quoted-string, subshell): the heredoc is
//       embedded within a gh write-back argument value, e.g. --body "$(cat <<EOF…)".
//       Its body IS the gh body content — include unconditionally.
//   (b) << in a command segment: check whether the command run that owns the `<<`
//       operator (text from the nearest command separator before `<<` up to `<<`)
//       contains a gh write-back verb in command position. If yes → owned heredoc,
//       include. If no (e.g. the run is `cat <<EOF` after `&& `following a
//       `gh pr create --body-file <file>`) → unrelated heredoc, exclude.
//
// Invariant after this filter: heredoc body is included only when the `<<` operator
// belongs to the gh write-back command (directly or as an embedded argument value).
// Unrelated heredocs in the same compound command cannot inflate the body buffer and
// push a valid footer beyond the 240-char tail window.
//
// NFR1 fail-safe: when _segs === null (segmentCommand parse error), fall back to the
// pre-fix regex-only behavior (return true → body appended = over-block safe direction).
// A parser bug never opens a bypass.
//
// Reuses: CMD_POSITION_ANCHOR (SSOT), WRITEBACK_FLAG_RE, _segs (segmentCommand).
// No hand-rolled command-boundary parser.
function heredocOwnerIsGhWriteBack(openerIndex) {
  if (_segs === null) return true; // NFR1 fail-safe: parse error → over-block (safe direction)

  // Case (a): << is inside a non-command segment → enclosed within an argument.
  // The heredoc body IS gh body content (e.g. --body "$(cat <<EOF…)"). Include.
  for (const seg of _segs) {
    if (openerIndex >= seg.range[0] && openerIndex < seg.range[1]) {
      if (seg.kind !== 'command') return true;
      break; // << is in a command segment; fall through to case (b) run-ownership check.
    }
  }

  // Case (b): << is in a command segment. Collect command text from all command
  // segments up to (not including) the opener to determine the owning command run.
  // Non-command segments (quoted-string, heredoc-body, subshell, comment) are skipped
  // because they are data regions. Separators (&&, ||, ;, |, \n) appear as text
  // within command segments — we split on them to isolate the last run.
  let beforeOpener = '';
  for (const seg of _segs) {
    if (seg.range[1] <= openerIndex && seg.kind === 'command') {
      beforeOpener += seg.text;
    } else if (seg.range[0] < openerIndex && seg.kind === 'command') {
      // Segment straddles the opener: take only the portion before the opener.
      beforeOpener += seg.text.slice(0, openerIndex - seg.range[0]);
      break;
    } else if (seg.range[0] >= openerIndex) {
      break;
    }
  }

  // Split on shell command separators to isolate the run that owns `<<`.
  // Longest alternatives first (&&, ||) before single-char (|, ;, \n) to avoid
  // splitting `&&` or `||` at the inner `&`/`|` character.
  const runs = beforeOpener.split(/&&|\|\||;|\||\n/);
  const ownerRun = runs[runs.length - 1] || '';

  // Test if the owner run contains `gh` in command position AND a write-back flag.
  // Non-global regex to avoid lastIndex state issues.
  //
  // Inventory (#2071 D3 / R3): DETECTION absolute-offset hits from the shared
  // writeback analysis helper are intentionally NOT reused here. ownerRun is a
  // substring-local reconstruction without shared indices into `command`;
  // merging would require an explicit offset map (out of scope). Keep the
  // non-global *_TEST_RE twins — do not invoke the absolute-offset helper on
  // ownerRun.
  const ghRe = new RegExp(CMD_POSITION_ANCHOR + "gh\\s", "m");
  if (!ghRe.test(ownerRun)) return false;
  // WRITEBACK_FLAG_RE/BARE_F_DETECT_RE themselves are module-level "g"-flagged
  // regexes shared with matchAll() call sites elsewhere in this file; running
  // `.test()` on either directly — even reset to lastIndex=0 immediately
  // before the call — still leaves a non-zero `.lastIndex` on the SHARED
  // object after a match, and that leftover offset is then inherited as the
  // scan-start position by a LATER matchAll() call over the full `command`
  // string (ghWriteBackOperations()), silently truncating which occurrences
  // it finds. So this probes the non-global _TEST_RE twins instead — a
  // `.test()` on a non-global regex never touches `.lastIndex` (it has none),
  // making this function structurally incapable of leaking state into the
  // matchAll() sites, rather than relying on reset discipline at each return.
  if (WRITEBACK_FLAG_TEST_RE.test(ownerRun)) return true;
  // Bare `-F <path>` alias — same subcommand-gated check as the other two
  // consumption sites (isGhWriteBack / ghWriteBackOperations), applied
  // directly against ownerRun since it has no shared absolute offsets with
  // `command`. Non-global regex, mirrors ghRe above, to avoid lastIndex reuse.
  const ghTokenRe = new RegExp(CMD_POSITION_ANCHOR + "(gh)\\s", "d");
  const ghTokenMatch = ghTokenRe.exec(ownerRun);
  if (!ghTokenMatch) return false;
  const subcommand = ghSubcommandFrom(ownerRun.slice(ghTokenMatch.indices[1][0]));
  if (GH_BARE_F_SUBCOMMANDS.has(subcommand) && BARE_F_DETECT_TEST_RE.test(ownerRun)) return true;
  // C-1 (round 11): same subcommand-gated `.test()`-only check, mirrored for
  // the four new surfaces — non-global _TEST_RE twins for the same reason as
  // BARE_F_DETECT_TEST_RE above (a `.test()` on a shared global regex would
  // leak `.lastIndex` into the LATER matchAll() scans in ghWriteBackOperations).
  if (BODY_SHORT_FLAG_SUBCOMMANDS.has(subcommand) && BODY_SHORT_FLAG_DETECT_TEST_RE.test(ownerRun)) return true;
  if (NOTES_SHORT_FLAG_SUBCOMMANDS.has(subcommand) && NOTES_SHORT_FLAG_DETECT_TEST_RE.test(ownerRun)) return true;
  if (SUBJECT_FLAG_SUBCOMMANDS.has(subcommand) && SUBJECT_FLAG_DETECT_TEST_RE.test(ownerRun)) return true;
  return TEMPLATE_FLAG_SUBCOMMANDS.has(subcommand) && TEMPLATE_FLAG_DETECT_TEST_RE.test(ownerRun);
}

const heredocMatch = command.match(/<<-?\s*['"]?(\w+)['"]?\s+([\s\S]*?)\s\1\b/);
if (heredocMatch && heredocOwnerIsGhWriteBack(heredocMatch.index)) body += heredocMatch[2];

// fail-closed: ANY body source read failure → block (security-by-default, per decisions.md D3)
// strict: even if other sources provide valid body+footer, a failed read still blocks
// (otherwise attacker could mix --body "valid Rules:v Model:x" + --body-file /missing to bypass)
// D3 narrow exception: reviewer subprocess FS-isolation read-fail → fail-open (exit 0).
// isCrossModelReviewerProcess() gate ensures this only applies to sanctioned reviewer env.
// All non-reviewer read failures (TL host sessions, strict-mix bypass shape) remain fail-closed.
if (readFailed) {
  if (isCrossModelReviewerProcess()) exit(0); // D3 narrow exception: FS-isolation fail-open
  let reason = 'Footer gate: body source read failed (file not found / size > 1MB) — blocked fail-closed (D3)。可能成因：(a) body file 在同一 compound command 內建立、PreToolUse 讀檔時尚不存在；(b) sandbox 寫入被丟棄；(c) 路徑錯誤；(d) `--body-file` 路徑含 `$(...)` / `$VAR` / 反引號 等 shell 展開：PreToolUse 讀檔發生在 shell 執行前，hook 拿到的是未展開字面（如 `$(pwd)/notes/tmp/<unique>.md`）而讀不到——請改用 main-checkout notes/tmp 的字面絕對路徑（勿用 `$(pwd)`）。修法：body file 先以獨立 Bash 呼叫寫入落地，再以第二個呼叫、用字面絕對路徑執行 gh 命令，成功後立即刪除 body file。';
  // issue #1158: Codex runtime omits cwd/workdir from the hook payload, so a
  // relative --body-file is resolved against process.cwd() (= session-start main
  // worktree), where the file does not exist → this read-fail. Only when ALL of
  // {Codex runtime, no payload cwd, a relative failed source} hold is THAT the
  // cause — append a targeted diagnostic so the agent stops re-trying the same
  // relative path. fail-closed behavior is unchanged; this only enriches the reason.
  if (isCodexRuntime() && detectsCodexCwdAbsence(payload) && readFailedRelativePath) {
    reason += '\n\nCodex 缺 cwd diagnostic（issue #1158）：本次 payload 未帶 cwd/workdir，相對 body file 被 resolve 到 session-start cwd，故讀不到。請改用 main-checkout `notes/tmp` body file 的字面絕對路徑（例如 `<repo-root>/notes/tmp/<change>-pr-body-<session>.md`），per platform-adapters/codex.md §Worktree-scoped footer version equality。注意：compound `cd <worktree> && gh ... --body-file <relative-path>` 不足，因 PreToolUse 讀檔發生在 shell 執行前。';
  }
  block(reason);
}

// warn-level (non-block): detect closing keywords wrapped in code-span (`Fixes #N`)
// GitHub auto-close linker does not parse keywords inside code spans → issue won't auto-close on merge
// per enforce-fixes-keyword-not-in-code-span change; advisory only, does not affect exit code
const CODESPAN_CLOSING_KEYWORD = /`\s*(?:Fix(?:e[sd])?|Close[sd]?|Resolve[sd]?)\s+#\d+\s*`/i;
if (CODESPAN_CLOSING_KEYWORD.test(body)) {
  warn('gh-footer-gate warning：PR body 偵測到 code-span 包住的關閉關鍵字（如 `Fixes #N`）。GitHub auto-close linker 不解析 code-span 內關鍵字，issue 不會自動關閉。請改用裸文字 Fixes #N（無反引號）。per git-pr-template-and-merge.md。');
}

// warn-level (non-block): detect body claiming root cause without evidence
// per troubleshooting.md Exact-Case Evidence Ledger: naming root cause requires confirmed evidence
// advisory only, does not affect exit code
const ROOT_CAUSE_LABEL = /Root Cause|根因/i;
const EVIDENCE_LABEL = /Evidence|Verification/i;
if (ROOT_CAUSE_LABEL.test(body) && !EVIDENCE_LABEL.test(body)) {
  warn('gh-footer-gate warning：body 含 Root Cause/根因 但缺 Evidence/Verification 段。per troubleshooting.md Exact-Case Evidence Ledger，命名 root cause 須附 exact-case evidence。請補 Evidence/Verification 段或說明為何 unavailable。');
}

// Single-line footer required at end of body (last 240 chars). Rules/Tool/Model
// must share one line (no newline between fields). New format: `Rules: v<X.Y.Z>
// · Tool: <tool> · Model: <model>`. Legacy-compatible: `Rules: v<X.Y.Z> ...
// Model: <tool> / <model>` (also single-line).
const hasFooter = hasGithubProvenanceFooter;

if (!hasFooter(body)) {
  const RULES_MODEL_COOCCUR = /Rules:\s*v[\d.]+[^\n]*?Model:/;
  const hasRulesAndModelAnywhere = RULES_MODEL_COOCCUR.test(body);
  block(hasRulesAndModelAnywhere
    ? 'Footer format mismatch: 已偵測到 Rules: 字串，但不符合單行 footer 格式。可能 (a) heredoc artifact 推離（改用 --body-file file.md）；(b) footer 在 body 中段；(c) Tool 欄位缺失。Body 必須以單行 `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>` 結尾。'
    : 'Footer missing: GitHub write-back body 完全不含 Rules: footer。請在 body 結尾補單行 `Rules: v<X.Y.Z> · Tool: <tool> · Model: <model>` per ai-autonomy.md。--body-file 用法（TL-authored body）：body file 首選寫在 main-checkout `notes/tmp/`（gitignored、不綁 worktree 生命週期，worktree 被刪也不影響 Recap/PR-body 寫入）；用字面絕對路徑 `<repo-root>/notes/tmp/<purpose>-<unique>.md`（basename 必須含 purpose 加 session/timestamp/PID/random suffix，change name alone 或固定 `pr-body.md` 不足；勿用 $(pwd)/$VAR 等 shell 展開——PreToolUse 讀檔在 shell 執行前）。**在 linked worktree 內執行也用指向 main-checkout 的字面絕對路徑**（worktree-relative 路徑不存在，非 vfMap 限制）。成功的 `gh` write 後立即刪除 body file。generic write 版號錨點 = 本 session 執行指令所在 repo（cwd checkout）的 canonical AGENTS.md（origin tip 優先、workspace fallback）；該 repo 讀不到版號才退回 body-file 所在 repo（同樣 tip 優先），兩者都讀不到才跳過版號檢查（fail-open）；#3437。canonical rules operation 則使用 exact operation worktree AGENTS.md。repo-external /tmp body files are discouraged because, when the cwd checkout yields no version, they remove the only remaining repo version anchor。以上只適用 TL-authored body；reviewer sticky body 不走這條路，其落點由 renderer exact recipe 固定在 reviewer 自身 per-dispatch neutral cwd（repo 外、runner-owned），不得改寫成 main-checkout `notes/tmp`（issue #1735）。'
  );
}

// reverse-attribution check: forbid AI-generated/coauthor brand markers in gh body per ai-autonomy.md
// Patterns imported from lib/attribution-patterns.mjs (shared with pre-tool-gate.mjs for symmetry)
if (hasForbiddenAttribution(body)) {
  block("Attribution forbidden: gh body must not contain AI-generated/coauthor brand markers per ai-autonomy.md attribution rule (shared `lib/attribution-patterns.mjs`)");
}

// C-1 (round 11): `-t`/`--subject` (pr merge) is scanned independently — see
// subjectText's declaration above for why it is not folded into `body`.
if (hasForbiddenAttribution(subjectText)) {
  block("Attribution forbidden: gh pr merge -t/--subject text must not contain AI-generated/coauthor brand markers per ai-autonomy.md attribution rule (shared `lib/attribution-patterns.mjs`)");
}

// ── Version-equality layer (F3) ──────────────────────────────────────────────
// Footer presence/format already verified above. Now check that the footer's
// Rules: vX.Y.Z matches AGENTS.md 版本：X.Y.Z (release-integrity).
// Generic-lane fail-open paths remain unchanged: AGENTS.md unreadable / version
// unparseable / footer version unparseable → null → skip equality. A hook-visible
// rules operation is stricter: its exact operation worktree and canonical branch
// identity must resolve consistently before its AGENTS.md version can be selected.
const strictRulesFooterVersion = (text) => {
  const declarations = [...text.matchAll(/Rules:\s*v([^\s·\n]*)/g)];
  if (declarations.length !== 1) return null;
  const exactVersion = declarations[0][1].match(new RegExp(`^(${SEMVER_CORE})$`));
  return exactVersion?.[1] ?? null;
};

const _versionContext = rulesOperationVersionContext();
if (_versionContext.kind === 'unresolved' || _versionContext.kind === 'mismatch') {
  block(_versionContext.reason);
}
const _footerVersion = _versionContext.kind === 'rules'
  ? strictRulesFooterVersion(body)
  : extractVersionFromFooter(body);
const _agentsMdVersion = _versionContext.version;
if (_versionContext.kind === 'rules' && _footerVersion === null) {
  block(
    'Footer version unresolved (release-integrity): a canonical rules write-back must contain exactly one parseable `Rules: v<X.Y.Z>` footer. Remove malformed, missing, or duplicate Rules version declarations.'
  );
}
if (_footerVersion !== null && _agentsMdVersion !== null) {
  if (compareVersions(_footerVersion, _agentsMdVersion) !== 0) {
    if (_versionContext.kind === 'rules') {
      block(
        `Footer version mismatch (release-integrity): footer declares Rules: v${_footerVersion}, expected delivered Rules: v${_agentsMdVersion} from operation branch ${_versionContext.branch} in worktree ${_versionContext.repoRoot}. Update the footer to match the delivered rules version.`
      );
    }
    block(
      `Footer version mismatch (release-integrity): footer declares Rules: v${_footerVersion} but AGENTS.md 版本：${_agentsMdVersion}${_versionContext.kind === 'generic' && _genericVersionAnchor ? ` (anchor: ${_genericVersionAnchor})` : ''}. The footer keeps this session repo's canonical AGENTS.md version (origin tip first, workspace fallback) and does not follow -R/--repo into the write target. Write the version this repo declares; do not copy the target repository's version.`
    );
  }
}

// T9(b) [Req: R4]: per-file-source audit unit (design.md D5, option (c) — one
// independent audit PER OCCURRENCE, not per `gh` invocation and not one
// whole-command concatenation). `firstCmdMatch` above only ever reads ONE
// occurrence per flag type: the first `--body-file`, the first
// `--notes-file`, the first `-F/--field body=@path`. A REPEATED flag within
// the same invocation (`--body-file good.md --body-file bad.md`) or a
// second, otherwise-independent `gh` invocation chained with `&&` is a
// source `failClosedIfUnextracted` above already proves this gate extracted
// (it fails closed whenever a presence occurrence lacks a matching
// extraction at the same index) — but its CONTENT was never read past the
// first match, so its footer/attribution/version were never checked at all
// (T8-4/T8-5 prove this). This loop closes that gap: the first occurrence of
// each flag type keeps flowing into the shared `body` accumulator exactly as
// before (untouched above — the well-covered single-occurrence and
// mixed-inline-source combos cannot regress); every occurrence AFTER the
// first is read and evaluated independently, on its OWN content only — NOT
// concatenated into `body` (D5 option (a), rejected: a valid footer could be
// pushed beyond the 240-char tail window, or a legitimate second `gh`
// invocation with its own valid footer could be over-blocked), and NOT
// scoped by ghWriteBackOperations()'s {ghPos,end} operation boundary (D5
// option (b), rejected: only shrinks the gap, since repeats within ONE
// operation would still be missed). Inline `--body` / `-f body=` literal /
// `-b`/`--body` short-flag / `-n`/`--notes` short-flag / heredoc buffering
// are explicitly out of scope (D5 non-goal, avoids expanding the
// regression surface) and are untouched by this loop. Reuses
// `_versionContext`/`_agentsMdVersion`/`strictRulesFooterVersion` computed
// above so a repeated occurrence's footer version is checked against the
// SAME expected version as the primary body, not re-derived per occurrence.
//
// matchFilter: optional additional per-match predicate (index-based), beyond
// command-segment membership — mirrors failClosedIfUnextracted's parameter
// of the same name and purpose above. Used by the bare `-F <path>` alias call
// site below to apply the SAME isGhBareFAliasMatch subcommand predicate this
// surface's extraction and presence patterns already use, so `gh api -F
// labels=bug` is never mistaken for a repeated unaudited body-file
// occurrence. The filter MUST be applied to `matches` BEFORE the `i = 1`
// slice, not after: filtering after would let a non-matching first element
// shift which match this loop treats as "the first occurrence" out of sync
// with the extraction site's own `cmdMatches(...).find(isGhBareFAliasMatch)`
// selection, auditing from the wrong starting index. Defaults to "no
// filter", so the three pre-existing call sites (BODY_FILE/NOTES_FILE/
// F_FILE) are unaffected.
function auditRepeatedFileSourceOccurrences(argRe, pickPath, readOpts, matchFilter = () => true) {
  const matches = cmdMatches(argRe).filter((m) => matchFilter(m.index));
  for (let i = 1; i < matches.length; i += 1) {
    const rawPath = pickPath(matches[i]);
    const content = safeRead(rawPath, readOpts);
    if (readFailed) {
      block(`Footer gate: a repeated body-file-shaped occurrence's source read failed (file not found / size cap) — blocked fail-closed (D3), independently of the first occurrence. Path: ${rawPath}`);
    }
    if (!hasFooter(content)) {
      block(`Footer missing: a repeated/chained body-file-shaped occurrence (not the first) has no Rules: footer of its own. Every occurrence is independently audited regardless of gh invocation or repeat-flag boundary (design.md D5). Path: ${rawPath}`);
    }
    if (hasForbiddenAttribution(content)) {
      block("Attribution forbidden: a repeated body-file-shaped occurrence contains AI-generated/coauthor brand markers per ai-autonomy.md attribution rule (shared `lib/attribution-patterns.mjs`)");
    }
    const repeatedFooterVersion = _versionContext.kind === 'rules'
      ? strictRulesFooterVersion(content)
      : extractVersionFromFooter(content);
    if (_versionContext.kind === 'rules' && repeatedFooterVersion === null) {
      block('Footer version unresolved (release-integrity): a repeated body-file-shaped occurrence must also contain exactly one parseable `Rules: v<X.Y.Z>` footer.');
    }
    if (repeatedFooterVersion !== null && _agentsMdVersion !== null && compareVersions(repeatedFooterVersion, _agentsMdVersion) !== 0) {
      block(`Footer version mismatch (release-integrity): a repeated body-file-shaped occurrence declares Rules: v${repeatedFooterVersion} but the expected version is ${_agentsMdVersion}. Every occurrence's footer version is independently checked (design.md D5). Path: ${rawPath}`);
    }
  }
}

auditRepeatedFileSourceOccurrences(BODY_FILE_ARG_RE, (m) => m[1], undefined);
auditRepeatedFileSourceOccurrences(NOTES_FILE_ARG_RE, (m) => m[1], undefined);
auditRepeatedFileSourceOccurrences(F_FILE_ARG_RE, (m) => m[1] ?? m[2] ?? m[3], { capMb: 1 });
auditRepeatedFileSourceOccurrences(F_ALIAS_ARG_RE, (m) => m[1], undefined, isGhBareFAliasMatch);

warnStrictValidatorOnly();
exit(0);
}

export function evaluateGhFooterGate({
  rawArgs = [],
  rawInput = '',
  env = process.env,
  cwd = process.cwd(),
  writeStdout = (chunk) => process.stdout.write(chunk),
  writeStderr = (chunk) => process.stderr.write(chunk),
} = {}) {
  try {
    executeGhFooterGate({ rawArgs, rawInput, env, cwd, writeStdout, writeStderr });
    return 0;
  } catch (error) {
    if (error instanceof GhFooterGateExit) return error.code;
    throw error;
  }
}

const isDirectInvocation = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation) {
  const cliRawArgs = process.argv.slice(2);
  let cliRawInput = '';
  if (!cliRawArgs.includes('--')) {
    try {
      cliRawInput = await readStdin();
    } catch {
      cliRawInput = undefined;
    }
  }
  process.exit(evaluateGhFooterGate({ rawArgs: cliRawArgs, rawInput: cliRawInput }));
}
