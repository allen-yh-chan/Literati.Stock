// high-output-command.mjs — Invariant 1 classifier (token-waste mechanical gate).
//
// SSOT for "this Bash command is expected to emit >200 lines / >5K tokens and is
// being run RAW" — i.e. its stdout is NOT redirected to a notes/tmp log first,
// so the raw dump would land in the transcript. token-frugal-io.md §Command Output
// Hard Gate / output-discipline spec §High-Volume Command Transcript Discipline
// require such commands to capture to a notes/tmp log first and surface a compact summary only.
//
// DESIGN — three invariants, not an unbounded special-case list (per user constraint).
// A command is high-output if it matches ONE of two STRUCTURAL classes:
//   (A) a small, documented set of known high-output producers (full source test
//       suite, strict OpenSpec validate-all, gh run log dump, reviewer stream-json);
//   (B) an UNBOUNDED-by-shape class: repo-wide `rg -n <pattern>` with no path
//       narrowing and no result-bounding flag (the exploratory-search foot-gun).
// The escape hatch is also structural: if stdout is redirected to a file path
// (`> notes/tmp/...`, `>"$log"`, mktemp-into-var then redirect) OR the statement
// starts with the repo-local capture-command helper AND does not append a raw
// high-output producer after a shell pipe, the command is already token-frugal → NOT
// blocked. This mirrors the force-push gate idiom: scope the match precisely so
// legitimate forms pass.
//
// Pure module: no fs / process / network. Caller passes the command-segment text
// (quoted strings / heredoc bodies / comments already stripped) so a high-output
// command name appearing inside a quoted string or echo does not false-positive.

/**
 * Known high-output producer commands (class A). Each entry is a structural matcher
 * against the command-segment text. Kept deliberately SMALL and anchored to the
 * commands token-frugal-io.md names explicitly; growth here is a smell — prefer the
 * structural class B for new exploratory patterns.
 *
 * @type {ReadonlyArray<{ id: string, re: RegExp, label: string }>}
 */
const KNOWN_HIGH_OUTPUT = Object.freeze([
  {
    id: "source-test-suite",
    // The FULL source test gate (directory-level run) emits hundreds of TAP lines.
    // Match `--test ... .devpro/scripts/tests` at DIRECTORY granularity only:
    // followed by end / whitespace / a trailing slash / a glob — NOT by a specific
    // `<name>.test.mjs` file (running one file is bounded output, ~tens of lines).
    re: /\bnode\s+(?:[^\n|;&]*\s)?--test\b[^\n|;&]*\.devpro\/scripts\/tests(?:\/(?=\s|$|["'*])|\b(?!\/?[^\s|;&]*\.test\.mjs))/,
    label: "node --test .devpro/scripts/tests/ (full source test suite)",
  },
  {
    id: "openspec-validate-all",
    // `openspec validate --strict --all` (flags in any order).
    re: /\bopenspec\s+validate\b(?=[^\n|;&]*--strict\b)(?=[^\n|;&]*--all\b)/,
    label: "openspec validate --strict --all",
  },
  {
    id: "gh-run-log",
    // `gh run view ... --log` / `--log-failed` dumps full CI logs.
    re: /\bgh\s+run\s+view\b[^\n|;&]*--log(?:-failed)?\b/,
    label: "gh run view --log",
  },
  {
    id: "reviewer-stream-json",
    // `claude … -p … --output-format stream-json` / `--verbose` reviewer stream — the
    // NDJSON reviewer stream is the canonical large-output reviewer surface. Flag order is
    // arbitrary (R2-5): require a `claude` invocation that carries BOTH `-p`/`--print` AND
    // a stream/verbose flag, in any order, via two lookaheads scoped to the statement.
    re: /\bclaude\b(?=[^\n;]*?(?:\s-p\b|\s--print\b))(?=[^\n;]*?(?:--output-format[=\s]+stream-json|--verbose)\b)/,
    label: "claude -p reviewer stream-json output",
  },
]);

// Repo-wide `rg -n <pattern>` with no path narrowing (class B). Exploratory-search
// foot-gun per token-frugal-io.md §Exploratory Search Gate. We match `rg` carrying a
// line-output flag (`-n` / `--line-number`, or no `-l`/`--count`/`--files-with-matches`
// suppressor) and then in the runner verify it has a real path narrowing / sizing
// shape. Detection of "raw" rg lives in classifyHighOutput so it can reuse the redirect
// escape hatch.
const RG_INVOCATION_RE = /(^|[\s|;&])rg(?=\s|$)/;
// Flags that make rg NOT a large line-output producer (discovery / sizing / sampling).
const RG_SIZING_FLAGS_RE = /(?:^|\s)(?:-l\b|--files-with-matches\b|--count\b|-c\b|--files\b)/;
// `-m N` / `--max-count N` bounds output to N matches PER FILE. It is safe only when
// paired with a narrow single pathspec; repo-wide or broad multi-path forms can still
// dump N lines for every matching file.
const RG_MAXCOUNT_RE = /(?:^|\s)(?:-m\s*\d+|--max-count[=\s]+\d+)/;
// A narrowing pathspec: any non-flag token after the pattern that looks like a path
// (contains `/` or a known extension or a concrete dir). Heuristic — see narrowsPath.

/**
 * Detect whether the command-segment text redirects STDOUT to a file (the structural
 * escape hatch). The operative token-waste invariant is "raw output does NOT reach the
 * transcript" — so ANY stdout redirect to a file target (absolute path, repo-relative
 * path, OR a shell variable holding a path) discharges the gate. Main-checkout
 * notes/tmp targets are the *preferred* sink and are reported separately by
 * isPreferredLogTarget() for tests/diagnostics, but redirect-to-any-file is the
 * mechanical bar so the check survives `$(...)` subshell stripping by the hook's
 * gateCommandSegmentText (which blanks `log=$(mktemp …)` to `log=`, hiding mktemp).
 *
 * Recognized stdout-redirect operators: `>`, `>>`, `1>`, `1>>`, `&>`, `&>>`, `>&`.
 * (`2>` alone redirects only stderr — NOT a stdout capture — so it is excluded.)
 * Targets: `notes/tmp/x`, `"$log"`, `$log`, `${log}`, `out.txt`, `"/abs/notes/tmp/x"`.
 *
 * @param {string} text command-segment text
 * @returns {boolean} true if stdout is redirected to a file
 */
function redirectsToFile(text) {
  // stdout redirect operators only: optional leading `1` or `&`, then `>`/`>>`.
  // Exclude a lone `2>` (stderr-only). `>&` (dup) and `&>` (both) count as stdout.
  const redirectRe = /(?:^|\s)(?:1?>>?|&>>?|>&)\s*("[^"]+"|'[^']+'|\$\{?\w+\}?|\/[^\s|;&]+|[A-Za-z0-9_./-]+)/g;
  let m;
  while ((m = redirectRe.exec(text)) !== null) {
    const op = m[0].trimStart();
    // Guard: a bare `2>` would not be captured by the operator class above, but make
    // doubly sure we never treat stderr-only redirects as stdout capture.
    if (/^2>/.test(op)) continue;
    const rawTarget = m[1].replace(/^["']|["']$/g, "");
    if (rawTarget) return true; // any file/variable target = output left the transcript
  }
  return false;
}

const CAPTURE_COMMAND_SCRIPT_PATHS = new Set([
  ".devpro/scripts/capture-command.mjs",
  "./.devpro/scripts/capture-command.mjs",
]);
const CAPTURE_COMMAND_TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function stripTokenQuotes(token) {
  return String(token || "").replace(/^["']|["']$/g, "");
}

function isNodeExecutableToken(token) {
  const value = stripTokenQuotes(token);
  return value === "node" || /\/node$/.test(value);
}

// An absolute path to the helper counts only when it is THIS repo's helper. This module
// is pure, so the caller supplies the repo-local absolute helper paths (current checkout
// and main checkout) through `resolveRepoLocalHelperPaths`; it is called lazily, only
// for an absolute token that already ends with the helper suffix. Without a resolver
// (standalone callers) an absolute helper path is not exempt.
const CAPTURE_COMMAND_ABSOLUTE_SUFFIX = "/.devpro/scripts/capture-command.mjs";

// On Windows the resolver answers with native paths (`C:\\repo\\...`) while a Bash command names
// the same file as `C:/repo/...`. Compare in forward-slash form, and ignore case only for
// drive-letter paths, whose filesystem is case-insensitive.
const DRIVE_LETTER_ABSOLUTE_RE = /^[A-Za-z]:\//;

function comparableHelperPath(value) {
  const slashed = String(value).replace(/\\/g, "/");
  return DRIVE_LETTER_ABSOLUTE_RE.test(slashed) ? slashed.toLowerCase() : slashed;
}

function isCaptureCommandScriptToken(token, resolveRepoLocalHelperPaths) {
  const value = stripTokenQuotes(token);
  if (CAPTURE_COMMAND_SCRIPT_PATHS.has(value)) return true;
  const wanted = comparableHelperPath(value);
  const absolute = wanted.startsWith("/") || DRIVE_LETTER_ABSOLUTE_RE.test(wanted);
  if (!absolute || !wanted.endsWith(CAPTURE_COMMAND_ABSOLUTE_SUFFIX)) return false;
  if (typeof resolveRepoLocalHelperPaths !== "function") return false;
  return resolveRepoLocalHelperPaths().some((candidate) => comparableHelperPath(candidate) === wanted);
}

// Leading `NAME=value` shell assignments (`PATH=/opt/node/bin:$PATH node …`) scope an
// environment to the command that follows; they do not change which command leads.
const ENV_ASSIGNMENT_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Detect the documented high-output wrapper:
 *   [NAME=value ...] node [<abs-checkout>/].devpro/scripts/capture-command.mjs --topic <topic> -- <cmd> [...]
 *
 * The exemption is deliberately leading-command only. A helper mention in an echo,
 * a second statement, or after a raw producer must not discharge the raw producer.
 *
 * @param {string} stmt a single command statement
 * @param {(() => string[])=} resolveRepoLocalHelperPaths absolute helper paths owned by this repo
 * @returns {boolean}
 */
function wrapsWithCaptureCommand(stmt, resolveRepoLocalHelperPaths) {
  const allTokens = String(stmt || "").trim().split(/\s+/).filter(Boolean);
  let start = 0;
  while (start < allTokens.length && ENV_ASSIGNMENT_TOKEN_RE.test(allTokens[start])) {
    start += 1;
  }
  const tokens = allTokens.slice(start);
  if (tokens.length < 6) return false;
  if (!isNodeExecutableToken(tokens[0])) return false;

  let index = 1;
  // Allow simple Node flags before the script path. If a flag takes a separate
  // value, this intentionally fails closed unless the documented helper shape is
  // still unambiguous.
  while (tokens[index]?.startsWith("-") && tokens[index] !== "--") {
    index += 1;
  }

  if (!isCaptureCommandScriptToken(tokens[index], resolveRepoLocalHelperPaths)) return false;
  index += 1;

  let hasTopic = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") return hasTopic && index + 1 < tokens.length;
    if (token === "--topic") {
      const topic = stripTokenQuotes(tokens[index + 1]);
      if (!CAPTURE_COMMAND_TOPIC_RE.test(topic)) return false;
      hasTopic = true;
      index += 2;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Does a redirect target point to the preferred repo-owned log sink (`notes/tmp`)?
 * NOTE: this is the PREFERRED-sink discriminator, not the gate's mechanical bar — the
 * gate discharges on ANY stdout file redirect (see redirectsToFile). Retained and
 * unit-tested so callers/docs can distinguish the sanctioned notes/tmp sink from
 * legacy temp or arbitrary repo-relative redirects; it is intentionally NOT on the
 * block/allow hot path.
 *
 * @param {string} target redirect target token (unquoted)
 * @returns {boolean} true if it points to notes/tmp
 */
function isPreferredLogTarget(target) {
  if (!target) return false;
  const normalized = target.replace(/^["']|["']$/g, "");
  return /(?:^|\/)\.?notes\/tmp\//.test(normalized);
}

/**
 * Decide if a repo-wide / broad multi-root `rg` is a RAW line-output producer (class B).
 * Raw = requests line output (-n) OR lacks a sizing/discovery suppressor, AND lacks a
 * narrow path shape. `-m` alone is not a whole-command bound because ripgrep applies it
 * per file; it only discharges the gate with one narrowing pathspec.
 *
 * @param {string} text command-segment text
 * @returns {boolean}
 */
function isRawRepoWideRg(text, rawText = text) {
  if (rgCommandIndex(text) < 0) return false;
  // Piped/stdin rg is bounded by its UPSTREAM input, not a repo filesystem traversal —
  // `… | rg <pat>` only scans what the pipe feeds it. The gate targets unbounded repo
  // output, so a downstream-of-pipe rg is out of scope. (Common: `git status | rg …`,
  // `cat f | rg …`.) Detect a `|` before the rg token.
  if (rgIsPipeConsumer(text)) return false;
  // Discovery / sizing flags make it safe regardless of pathspec.
  if (RG_SIZING_FLAGS_RE.test(text)) return false;
  // Require an actual search pattern argument so `rg --version` etc. never trip.
  if (!hasSearchPattern(text)) return false;
  // `-m` / `--max-count` is per-file, not whole-command. It is safe only with a
  // narrowed single-path search; broad multi-path forms can still flood the transcript.
  if (RG_MAXCOUNT_RE.test(text)) {
    if (narrowsPath(text, rawText) && !hasBroadPathSet(text)) return false;
    return true;
  }
  // Multiple broad directory/root pathspecs can still span hundreds of files. Concrete
  // file pathsets stay allowed below through narrowsPath().
  if (hasBroadMultiRootPathSet(text)) return true;
  if (narrowsPath(text, rawText)) return false;
  // At this point: an rg with a search pattern, not piped, not a sizing/discovery form,
  // not safely path-narrowed. rg prints matching LINES by default, so
  // this is unbounded repo-wide line output → raw. (The earlier `RG_LINE_OUTPUT_RE.test
  // || true` was dead — line output is the default, not a precondition.)
  return true;
}

/**
 * Is the (first) `rg` token positioned as the consumer of a pipe — i.e. is there a `|`
 * before it? Such an rg reads stdin (bounded by upstream output), not the repo tree.
 * Conservative: any `|` anywhere before the rg token counts (covers `a | b | rg …`).
 *
 * @param {string} text
 * @returns {boolean}
 */
function rgIsPipeConsumer(text) {
  const idx = rgCommandIndex(text);
  if (idx < 0) return false;
  const before = text.slice(0, idx);
  return before.includes("|");
}

function rgCommandIndex(text) {
  const match = RG_INVOCATION_RE.exec(text);
  if (!match) return -1;
  return match.index + (match[1] || "").length;
}

// rg short/long flags that CONSUME the following token as their value (C4). Without
// skipping these, `rg -n -C 3 TODO` mis-reads `3` as the pattern and `TODO` as a path.
// `=`-joined forms (`-C3`, `--max-count=3`, `-g=*.js`) carry their value inline and do
// NOT consume the next token.
const RG_VALUE_TAKING_SHORT = new Set(["-A", "-B", "-C", "-m", "-e", "-g", "-t", "-T", "-f", "-d", "-M"]);
const RG_VALUE_TAKING_LONG = new Set([
  "--after-context", "--before-context", "--context", "--max-count", "--regexp",
  "--glob", "--iglob", "--type", "--type-not", "--type-add", "--file", "--max-depth",
  "--max-columns", "--threads", "--replace", "--sort", "--sortr", "--colors", "--pre",
]);

/**
 * Tokenize the rg invocation's arguments and return the POSITIONALS (search pattern +
 * any pathspecs), correctly skipping flags and the values that value-taking flags
 * consume. The first positional is the search pattern; any subsequent positional is a
 * path argument.
 *
 * @param {string} text command-segment text (one rg invocation expected)
 * @returns {string[]} positional tokens in order
 */
function rgPositionals(text) {
  // Scope to rg's OWN argument span: from just after the rg token up to the first pipe.
  // A token after `|` belongs to the DOWNSTREAM command, not rg's pathspec (R3-C1:
  // `rg -n TODO | cat` — `cat` must not be read as a narrowing path, else the producer
  // `rg … | cat` is wrongly treated as narrowed and slips through).
  const rgIndex = rgCommandIndex(text);
  if (rgIndex < 0) return [];
  let afterRg = text.slice(rgIndex + 2);
  const pipeIdx = afterRg.indexOf("|");
  if (pipeIdx !== -1) afterRg = afterRg.slice(0, pipeIdx);
  const tokens = afterRg.split(/\s+/).filter(Boolean);
  const positionals = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--") {
      // Everything after `--` is positional.
      positionals.push(...tokens.slice(i + 1).filter((t) => t.length));
      break;
    }
    if (tok.startsWith("-")) {
      // `=`-joined value stays inline → does not consume next token.
      if (tok.includes("=")) continue;
      const isShort = /^-[A-Za-z]$/.test(tok);
      const isLong = tok.startsWith("--");
      if ((isShort && RG_VALUE_TAKING_SHORT.has(tok)) || (isLong && RG_VALUE_TAKING_LONG.has(tok))) {
        i++; // skip the value token consumed by this flag
      }
      continue; // the flag itself is not a positional
    }
    positionals.push(tok);
  }
  return positionals;
}

// A positional that denotes the WHOLE current tree (CWD), so it does NOT narrow:
// `.`, `./`, `.\`, and the trailing-slash/`/`-root forms.
function isWholeTreePath(tok) {
  return tok === "." || tok === "./" || tok === ".\\" || tok === "/" || tok === ".";
}

function normalizePathspec(tok) {
  return String(tok || "")
    .replace(/^["']|["']$/g, "")
    .replace(/^\.\//, "")
    .replace(/[\\/]+$/, "");
}

const COMMON_EXTENSIONLESS_FILES = new Set([
  ".env",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "AGENTS",
  "CHANGELOG",
  "Dockerfile",
  "Gemfile",
  "LICENSE",
  "LICENCE",
  "Makefile",
  "Procfile",
  "Rakefile",
  "README",
]);

const CLEARLY_BROAD_PATH_ROOTS = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".cursor",
  ".devpro",
  ".worktree",
  "openspec",
  "refs",
]);

function looksLikeNarrowPath(tok) {
  return tok.includes("/") || /\.[a-z0-9]{1,5}$/i.test(tok) || /^[A-Za-z0-9_.]+$/.test(tok);
}

function rgNarrowingPathspecs(text) {
  const positionals = rgPositionals(text);
  // When the pattern is supplied via -e/--regexp/-f/--file, ALL positionals are paths
  // (index ≥0); otherwise positionals[0] is the pattern and paths start at index 1.
  const firstPathIdx = RG_PATTERN_FLAG_RE.test(text) ? 0 : 1;
  return positionals
    .slice(firstPathIdx)
    .filter((tok) => !isWholeTreePath(tok) && looksLikeNarrowPath(tok));
}

function pathspecBasename(tok) {
  const normalized = normalizePathspec(tok);
  return normalized.split(/[\\/]/).pop() || normalized;
}

function looksLikeConcreteFilePath(tok) {
  if (/[\\/]$/.test(String(tok || "").replace(/^["']|["']$/g, ""))) return false;
  const normalized = normalizePathspec(tok);
  if (!normalized || /[*?[\]{}]/.test(normalized)) return false;
  const base = pathspecBasename(normalized);
  if (/^\.[^.]+$/.test(base)) return COMMON_EXTENSIONLESS_FILES.has(base);
  return /\.[a-z0-9]{1,8}$/i.test(base) || COMMON_EXTENSIONLESS_FILES.has(base);
}

function isBroadDirectoryPathspec(tok) {
  if (looksLikeConcreteFilePath(tok)) return false;
  const raw = String(tok || "").replace(/^["']|["']$/g, "");
  if (/[\\/]$/.test(raw)) return true;
  const normalized = normalizePathspec(raw);
  return [...CLEARLY_BROAD_PATH_ROOTS].some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function broadDirectoryPathspecs(text) {
  return rgNarrowingPathspecs(text).filter(isBroadDirectoryPathspec);
}

function hasBroadPathSet(text) {
  const paths = rgNarrowingPathspecs(text);
  return paths.length > 1 && paths.some(isBroadDirectoryPathspec);
}

function hasBroadMultiRootPathSet(text) {
  return broadDirectoryPathspecs(text).length > 1;
}

function normalizedGlobPath(value) {
  return value
    .replace(/^["']|["']$/g, "")
    .replace(/^!/, "")
    .replace(/^\.\//, "")
    .replace(/\/\*\*$/, "")
    .replace(/\/$/, "");
}

function rgGlobValues(text) {
  const values = [];
  const globRe = /(?:^|\s)(?:--i?glob|-g)(?:=|\s+)(("[^"]+")|('[^']+')|[^\s]+)/g;
  let match;
  while ((match = globRe.exec(text)) !== null) {
    values.push((match[1] || "").replace(/^["']|["']$/g, ""));
  }
  const attachedShortRe = /(?:^|\s)-g(("[^"]+")|('[^']+')|[^\s]+)/g;
  while ((match = attachedShortRe.exec(text)) !== null) {
    values.push((match[1] || "").replace(/^["']|["']$/g, ""));
  }
  return values;
}

function hasRepoForbiddenPathExclusions(text, rawText = text) {
  const excluded = new Set(
    [...rgGlobValues(text), ...rgGlobValues(rawText)]
      .filter((value) => value.startsWith("!"))
      .map((value) => normalizedGlobPath(value))
  );
  return (
    excluded.has("openspec/changes/archive") &&
    excluded.has(".worktree") &&
    excluded.has("refs")
  );
}

/**
 * Heuristic: does the rg invocation narrow to a path (file/dir/glob) rather than
 * scanning the whole repo? Narrowed when there is a positional PATHSPEC after the
 * search pattern (positional index ≥ 1) that looks path-shaped AND is not the
 * whole-tree CWD token. A whole-tree search can also pass when it explicitly excludes
 * this repo's known noisy forbidden paths.
 *
 * @param {string} text
 * @returns {boolean}
 */
function narrowsPath(text, rawText = text) {
  if (rgNarrowingPathspecs(text).length > 0) return true;
  return hasRepoForbiddenPathExclusions(text, rawText);
}

// Flags that SUPPLY the search pattern explicitly (so the pattern is not a positional).
// Accept both spaced (`-e foo`) and attached/`=`-joined (`-efoo`, `--regexp=foo`) forms.
const RG_PATTERN_FLAG_RE = /(?:^|\s)(?:-e|--regexp|-f|--file)(?:[=\s]|[^\s-])/;

/**
 * @param {string} text
 * @returns {boolean} true if rg has a search pattern — either a positional or one
 *   supplied via `-e`/`--regexp`/`-f`/`--file`.
 */
function hasSearchPattern(text) {
  if (RG_PATTERN_FLAG_RE.test(text)) return true;
  return rgPositionals(text).length > 0;
}

/**
 * Split a (segment-stripped) command line into individual statements at top-level
 * statement separators: `;`, `&&`, `||`, and newlines. Pipes (`|`) are deliberately NOT
 * split on, so a piped statement (`git status | rg x`) stays whole and rgIsPipeConsumer
 * can still recognize the rg as a bounded pipe consumer. Quoted/heredoc content is
 * already blanked by the caller's segmentation, so separators inside strings do not
 * split. This is the fix for the multi-invocation bypass (R2-4): a sizing flag or a
 * redirect in one statement must NOT mask a raw producer in another statement.
 *
 * @param {string} text
 * @returns {string[]} non-empty statement fragments
 */
function splitStatements(text) {
  return text
    .split(/(?:\|\||&&|[;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Downstream pagers that BOUND output to a few lines / a count. A producer piped into
// one of these does not flood the transcript (R4-C2). `cat`/`tee`/`less`/`more` do NOT
// bound (they pass everything through), so they are excluded.
const BOUNDING_PAGER_RE = /\|\s*(?:head|tail|wc)\b/;

/**
 * Does the statement pipe a producer's output into a bounding pager (`| head|tail|wc`)?
 * @param {string} stmt
 * @returns {boolean}
 */
function pipesToBoundingPager(stmt) {
  return BOUNDING_PAGER_RE.test(stmt);
}

function pipeTailAfterLeadingCommand(stmt, rawStmt = stmt) {
  const text = String(stmt || "");
  const pipeIndex = text.indexOf("|");
  if (pipeIndex < 0) return null;

  const rawText = String(rawStmt || "");
  const rawPipeIndex = rawText.indexOf("|");
  return {
    text: text.slice(pipeIndex + 1).trim(),
    rawText: rawPipeIndex >= 0 ? rawText.slice(rawPipeIndex + 1).trim() : text.slice(pipeIndex + 1).trim(),
  };
}

function hasUncapturedHighOutputAfterPipe(stmt, rawStmt = stmt) {
  const tail = pipeTailAfterLeadingCommand(stmt, rawStmt);
  if (!tail?.text) return false;
  const matched = matchProducer(tail.text, tail.rawText);
  if (!matched) return false;
  return !(redirectsToFile(tail.text) || pipesToBoundingPager(tail.text));
}

function captureCommandDischargesStatement(stmt, rawStmt = stmt, resolveRepoLocalHelperPaths) {
  return wrapsWithCaptureCommand(stmt, resolveRepoLocalHelperPaths) && !hasUncapturedHighOutputAfterPipe(stmt, rawStmt);
}

/**
 * Identify the high-output producer in a SINGLE statement, or null.
 * @param {string} stmt
 * @returns {{ id: string, label: string }|null}
 */
function matchProducer(stmt, rawStmt = stmt) {
  for (const entry of KNOWN_HIGH_OUTPUT) {
    if (entry.re.test(stmt)) return { id: entry.id, label: entry.label };
  }
  if (isRawRepoWideRg(stmt, rawStmt)) {
    return { id: "repo-wide-rg", label: "repo-wide or broad multi-root `rg -n` with no safe narrowing or result bound" };
  }
  return null;
}

/**
 * Classify whether a Bash command contains a raw high-output invocation that must
 * capture to a notes/tmp log first. Evaluated PER STATEMENT: the command is
 * high-output if ANY single statement is a producer whose OWN stdout is not redirected
 * to a file. A redirect or sizing flag in a different statement does not exempt it.
 *
 * @param {string} segmentText command-segment text (quoted/heredoc/comment stripped).
 *   Callers in pre-tool-gate.mjs pass gateCommandSegmentText(cmd); standalone callers
 *   may pass the raw command (less precise but safe — quoted-string false-positives are
 *   the only risk and are rare for these anchors).
 * @param {string} rawSegmentText raw command text used only to recover quoted rg glob
 *   values after segment stripping; producer detection still uses segmentText.
 * @param {{ resolveRepoLocalHelperPaths?: () => string[] }} [options] lazily supplies the
 *   absolute capture-command helper paths owned by this repo; omitted → only the
 *   repo-relative helper path is exempt.
 * @returns {{ highOutput: boolean, id: string|null, label: string|null, redirected: boolean }}
 */
export function classifyHighOutput(segmentText, rawSegmentText = segmentText, options = {}) {
  const text = typeof segmentText === "string" ? segmentText : "";
  const rawText = typeof rawSegmentText === "string" ? rawSegmentText : text;
  const result = { highOutput: false, id: null, label: null, redirected: false };
  if (!text.trim()) return result;

  // Pipes are kept within a statement (see splitStatements), so a pipe-consumer rg
  // (`git status | rg x`) stays whole and isRawRepoWideRg → rgIsPipeConsumer rejects it.
  const rawStatements = splitStatements(rawText);
  const statements = splitStatements(text);
  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];
    const rawStmt = rawStatements[index] || stmt;
    const matched = matchProducer(stmt, rawStmt);
    if (!matched) continue;
    // R4-C2: a producer whose output is piped into a BOUNDING pager (`| head`, `| tail`,
    // `| wc`) is already bounded — the transcript gets at most a few lines — so it is not
    // a transcript flood. (A non-bounding downstream like `| cat`/`| tee` does NOT bound.)
    const redirected = captureCommandDischargesStatement(stmt, rawStmt, options?.resolveRepoLocalHelperPaths) || redirectsToFile(stmt) || pipesToBoundingPager(stmt);
    if (!redirected) {
      result.id = matched.id;
      result.label = matched.label;
      result.redirected = false;
      result.highOutput = true;
      return result; // first un-redirected producer wins
    }
    // Producer present but redirected in its own statement → record but keep scanning
    // for another un-redirected producer.
    result.id = matched.id;
    result.label = matched.label;
    result.redirected = true;
  }
  return result;
}

/**
 * Build the block reason string for the pre-tool-gate. Centralized so the wording (and
 * its rule anchors) live next to the classifier.
 *
 * @param {{ id: string|null, label: string|null }} cls classifyHighOutput result
 * @returns {string}
 */
export function highOutputBlockReason(cls) {
  const what = cls?.label || "this command";
  return (
    `High-Output Command Hard Gate：偵測到預期 >200 行 / >5K token 的裸跑命令（${what}），` +
    `stdout 未重導向到檔案（任何 stdout file redirect 或 capture-command wrapper 即放行；main-checkout notes/tmp log 為規範 sink）。請改走 token-frugal-io.md §Command Output Hard Gate：\n` +
    `  node .devpro/scripts/capture-command.mjs --topic devpro-out -- <cmd>\n` +
    `  repo_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)"); mkdir -p "$repo_root/notes/tmp"\n` +
    `  log=$(mktemp "$repo_root/notes/tmp/devpro-out.XXXXXX"); <cmd> >"$log" 2>&1; rc=$?\n` +
    `  lines=$(wc -l < "$log"); bytes=$(wc -c < "$log")\n` +
    `對話只回 compact summary（command / rc / line+byte count / pass+fail or failed names / log path）；` +
    `raw excerpt 僅限 parser/debug、redacted、≤500 tokens。` +
    `若為探索式 rg，請改用 \`rg -l\` / \`rg --count\` / 限定 pathspec；\`-m N\` 需搭配單一路徑縮小範圍（§Exploratory Search Gate）。`
  );
}

// Internal helpers exported for unit testing only (not part of the gate contract).
export const __test = Object.freeze({
  redirectsToFile,
  wrapsWithCaptureCommand,
  captureCommandDischargesStatement,
  isPreferredLogTarget,
  isRawRepoWideRg,
  narrowsPath,
  hasBroadPathSet,
  hasBroadMultiRootPathSet,
  hasSearchPattern,
  KNOWN_HIGH_OUTPUT,
});
