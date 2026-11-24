/**
 * shell-context.mjs — Shell command segment tokenizer (B-narrow)
 *
 * Splits a shell command string into typed segments so that gate regexes
 * can be applied only to "command" text, eliminating false-positives from
 * quoted strings, heredoc bodies, subshells, and comments.
 *
 * API: segmentCommand(cmd) → Segment[]
 *
 * Segment shape:
 *   { kind: "command" | "quoted-string" | "heredoc-body" | "subshell" | "comment",
 *     text: string,
 *     range: [start, end] }
 *
 * Design (B-narrow, decisions.md D1/D2):
 *   - Single-pass O(n) state machine; no regex backtracking.
 *   - Covers: single-quote, double-quote (with \\ and \" escapes),
 *     heredoc (<<TAG / <<'TAG' / <<"TAG" / <<-TAG),
 *     subshell $() and backtick (inner text promoted to command segments,
 *     outer placeholder kept as "subshell"), comment (#).
 *   - Does NOT parse: $VAR expansion, brace expansion, control structures.
 *   - Fail-safe: any throw inside the parser is caught by the exported wrapper
 *     which falls back to [{ kind:"command", text:cmd, range:[0,cmd.length] }].
 *
 * Non-goals (per brd):
 *   - $VAR / ${VAR} expansion
 *   - {a,b} brace expansion
 *   - if/for/case control structures
 *   - background & / pipe | are kept inside command segments (not split)
 */

/**
 * @typedef {{ kind: "command"|"quoted-string"|"heredoc-body"|"subshell"|"comment", text: string, range: [number,number] }} Segment
 */

/**
 * Internal parser — throws on internal errors; the exported segmentCommand
 * wrapper catches and falls back.
 *
 * `scope` identifies which command-substitution execution context a segment
 * belongs to: `null` for the top-level command, or the absolute source
 * offset (in the ORIGINAL top-level command string, not any intermediate
 * substring) of the `$(`/backtick that opened the immediately-enclosing
 * subshell for anything recursively parsed out of it. Two positions run in
 * the SAME subprocess iff their `scope` values are `===` — this is what lets
 * a caller (gh-footer-gate.mjs's ghInvocationSubcommandAt) tell a `gh` token
 * from a `-F` flag sitting inside an unrelated `$(grep -F ...)` apart from
 * one that genuinely belongs to it, even though both are promoted to
 * kind:"command" text by the flattening below.
 *
 * `baseOffset` is what makes `scope` a true absolute source offset at any
 * nesting depth, not just depth 1: each recursive call's own `cmd` argument
 * is a SUBSTRING (`innerText`), so a local index `i` found while parsing it
 * is only meaningful relative to that substring — it is NOT globally unique
 * on its own. (Round-16 CRITICAL: prior to `baseOffset` threading, a nested
 * `$(...)`'s scope was stamped from that bare local `i`, so two sibling
 * subshells whose OWN nested children happened to open at the same local
 * offset within each parent's `innerText` — e.g. `$(aaaa $(FOO))` next to
 * `$(bbbb $(BAR))`, both nested children at local offset 5 — collided on
 * the same numeric scope even though they run in unrelated subprocesses.
 * `range` values don't have this problem because the caller-side remap loop
 * below composes them back to absolute on every level as results bubble up;
 * `baseOffset` gives `scope` the same composition, but computed on the way
 * DOWN instead of the way up, since scope needs to be correct at the moment
 * a segment is created, not after the fact.) Each recursive call receives
 * `baseOffset + innerStart` — the absolute source offset of its own `cmd`
 * substring's first character — so `baseOffset + i` is always the segment's
 * true absolute position in the original top-level string, regardless of
 * nesting depth.
 *
 * @param {string} cmd
 * @param {number|null} scope
 * @param {number} baseOffset
 * @returns {Segment[]}
 */
function parseSegments(cmd, scope = null, baseOffset = 0) {
  const segments = [];
  const len = cmd.length;
  let i = 0;
  let cmdStart = 0; // start of current accumulated command text

  function flushCommand(end) {
    if (end > cmdStart) {
      segments.push({ kind: "command", text: cmd.slice(cmdStart, end), range: [cmdStart, end], scope });
    }
    cmdStart = end;
  }

  while (i < len) {
    const ch = cmd[i];

    // ── Single quote: escapes are active only in the $'...' form
    if (ch === "'") {
      flushCommand(i);
      const start = i;
      let beforeDollar = i - 2;
      while (beforeDollar >= 0 && cmd[beforeDollar] === "\\") beforeDollar--;
      const ansi = cmd[i - 1] === "$" && (i - 2 - beforeDollar) % 2 === 0;
      i++; // skip opening '
      while (i < len && cmd[i] !== "'") {
        i += ansi && cmd[i] === "\\" && i + 1 < len ? 2 : 1;
      }
      if (i < len) i++; // skip closing '
      segments.push({ kind: "quoted-string", text: cmd.slice(start, i), range: [start, i], scope });
      cmdStart = i;
      continue;
    }

    // ── Double quote: "..." — handles \" and \\ escapes; nested single quotes are literal
    if (ch === '"') {
      flushCommand(i);
      const start = i;
      i++; // skip opening "
      while (i < len && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < len) {
          i += 2; // skip escape + next char
        } else {
          i++;
        }
      }
      if (i < len) i++; // skip closing "
      segments.push({ kind: "quoted-string", text: cmd.slice(start, i), range: [start, i], scope });
      cmdStart = i;
      continue;
    }

    // ── Heredoc: <<[-]['"]?TAG['"]? followed by newline, body until TAG on its own line
    if (ch === '<' && i + 1 < len && cmd[i + 1] === '<') {
      // Try to match heredoc header: <<[-]['"]?TAG['"]?
      let j = i + 2;
      const hasDash = j < len && cmd[j] === '-';
      if (hasDash) j++;
      // optional quote around tag
      let tagQuote = '';
      if (j < len && (cmd[j] === "'" || cmd[j] === '"')) {
        tagQuote = cmd[j];
        j++;
      }
      // read tag identifier: [A-Za-z_]\w*
      const tagStart = j;
      while (j < len && /\w/.test(cmd[j])) j++;
      const tag = cmd.slice(tagStart, j);
      if (tag.length === 0) {
        // Not a valid heredoc, treat as plain command text
        i++;
        continue;
      }
      // consume closing quote if we had an opening one
      if (tagQuote && j < len && cmd[j] === tagQuote) j++;
      // skip to end of line (the <<TAG line itself is command context)
      const headerEnd = j;
      flushCommand(i); // flush command text up to <<
      // the "<<TAG..." portion on this line is itself command-ish but we treat
      // everything up to and including the newline as the operator — emit it
      // as part of command segment (it's the redirect operator, not body)
      while (j < len && cmd[j] !== '\n') j++;
      if (j < len) j++; // skip the newline
      // Emit the heredoc operator as command text
      segments.push({ kind: "command", text: cmd.slice(i, j), range: [i, j], scope });
      cmdStart = j;
      i = j;

      // Now consume the heredoc body until we see a line that is exactly TAG
      // (with optional leading whitespace when <<-TAG is used)
      const bodyStart = i;
      let bodyEnd = i;
      while (i < len) {
        // find end of current line
        const lineStart = i;
        while (i < len && cmd[i] !== '\n') i++;
        const lineContent = cmd.slice(lineStart, i);
        if (i < len) i++; // consume newline
        // check if this line is the closing tag
        const trimmed = hasDash ? lineContent.replace(/^\t+/, '') : lineContent;
        if (trimmed === tag) {
          // closing tag line — bodyEnd is up to (but not including) closing tag line
          bodyEnd = lineStart;
          segments.push({
            kind: "heredoc-body",
            text: cmd.slice(bodyStart, bodyEnd),
            range: [bodyStart, bodyEnd],
            scope,
          });
          // consume the closing tag line as command (marker)
          const closingEnd = i;
          segments.push({ kind: "command", text: cmd.slice(lineStart, closingEnd), range: [lineStart, closingEnd], scope });
          cmdStart = i;
          break;
        }
      }
      if (i >= len && bodyEnd === bodyStart) {
        // heredoc not closed — emit remaining as heredoc-body
        segments.push({
          kind: "heredoc-body",
          text: cmd.slice(bodyStart),
          range: [bodyStart, len],
          scope,
        });
        cmdStart = len;
        i = len;
      }
      continue;
    }

    // ── Subshell $(...): inner text promoted to command segments
    if (ch === '$' && i + 1 < len && cmd[i + 1] === '(') {
      flushCommand(i);
      const start = i;
      // Absolute (in the ORIGINAL top-level command) position of this `$(`,
      // used as the child scope id — see baseOffset doc above parseSegments.
      const absoluteStart = baseOffset + i;
      i += 2; // skip $(
      // emit placeholder subshell segment
      segments.push({ kind: "subshell", text: "$()", range: [start, start + 2], scope });
      // recursively parse inner content (flatten: inner becomes command segments)
      // find matching closing paren, respecting nesting and quotes
      const innerStart = i;
      let depth = 1;
      while (i < len && depth > 0) {
        const c = cmd[i];
        if (c === '(') { depth++; i++; }
        else if (c === ')') { depth--; if (depth > 0) i++; else break; }
        else if (c === "'") {
          i++;
          while (i < len && cmd[i] !== "'") i++;
          if (i < len) i++;
        } else if (c === '"') {
          i++;
          while (i < len && cmd[i] !== '"') {
            if (cmd[i] === '\\' && i + 1 < len) i += 2;
            else i++;
          }
          if (i < len) i++;
        } else {
          i++;
        }
      }
      // Do not recursively rescan every suffix of an incomplete nested input
      // until stack overflow. Use the existing whole-command fallback once.
      if (depth !== 0) throw new SyntaxError("Unclosed command substitution");
      const innerText = cmd.slice(innerStart, i);
      if (i < len) i++; // skip closing )
      // Parse inner text and append its segments (flattened). `start` (this
      // subshell's own opening offset) becomes the CHILD scope — every
      // segment directly produced by this recursive call belongs to this
      // subshell's execution context, distinct from the outer `scope`.
      if (innerText.trim()) {
        const inner = parseSegments(innerText, absoluteStart, baseOffset + innerStart);
        for (const seg of inner) {
          segments.push({ kind: seg.kind, text: seg.text, range: [innerStart + seg.range[0], innerStart + seg.range[1]], scope: seg.scope });
        }
      }
      cmdStart = i;
      continue;
    }

    // ── Backtick subshell: `...`
    if (ch === '`') {
      flushCommand(i);
      const start = i;
      const absoluteStart = baseOffset + i;
      i++; // skip opening backtick
      segments.push({ kind: "subshell", text: "`", range: [start, start + 1], scope });
      const innerStart = i;
      while (i < len && cmd[i] !== '`') {
        if (cmd[i] === '\\' && i + 1 < len) i += 2;
        else i++;
      }
      const innerText = cmd.slice(innerStart, i);
      if (i < len) i++; // skip closing backtick
      // Same child-scope rule as $(...) above: `absoluteStart` (this
      // backtick's own opening offset, in the ORIGINAL top-level command)
      // is the new scope for its directly-promoted content.
      if (innerText.trim()) {
        const inner = parseSegments(innerText, absoluteStart, baseOffset + innerStart);
        for (const seg of inner) {
          segments.push({ kind: seg.kind, text: seg.text, range: [innerStart + seg.range[0], innerStart + seg.range[1]], scope: seg.scope });
        }
      }
      cmdStart = i;
      continue;
    }

    // ── Comment: # at command-position (preceded by whitespace or start-of-string)
    if (ch === '#') {
      // Only treat as comment if at start or preceded by whitespace / separator
      const prevChar = i > 0 ? cmd[i - 1] : null;
      const atCommandPos = prevChar === null || /[\s;|&(]/.test(prevChar);
      if (atCommandPos) {
        flushCommand(i);
        const start = i;
        while (i < len && cmd[i] !== '\n') i++;
        segments.push({ kind: "comment", text: cmd.slice(start, i), range: [start, i], scope });
        cmdStart = i;
        continue;
      }
    }

    i++;
  }

  // flush remaining command text
  flushCommand(len);

  return segments;
}

/**
 * Segment a shell command string into typed segments.
 * Any internal error falls back to a single command segment covering the whole input.
 *
 * @param {string} cmd
 * @returns {Segment[]}
 */
export function segmentCommand(cmd) {
  if (typeof cmd !== 'string') {
    return [{ kind: "command", text: String(cmd), range: [0, String(cmd).length], scope: null }];
  }
  if (cmd.length === 0) {
    return [];
  }
  try {
    return parseSegments(cmd);
  } catch {
    return [{ kind: "command", text: cmd, range: [0, cmd.length], scope: null }];
  }
}

/**
 * Resolve the execution scope of the segment containing `matchIndex`.
 *
 * Two positions share the same execution scope (same subprocess) iff their
 * `scopeIdAt` results are `===`. Top-level command text resolves to `null`;
 * content promoted out of a `$(...)`/backtick subshell resolves to that
 * subshell's own opening-offset scope id (see `parseSegments` scope param).
 *
 * `segs === null` is the parser-failure fallback signal — returns `null`
 * so callers fail closed (over-block) rather than bypass on parse failure.
 *
 * @param {number} matchIndex
 * @param {Segment[]|null} segs
 * @returns {number|null}
 */
export function scopeIdAt(matchIndex, segs) {
  if (segs === null) return null;
  for (const s of segs) {
    if (matchIndex >= s.range[0] && matchIndex < s.range[1]) {
      return s.scope ?? null;
    }
  }
  return null;
}

/**
 * Returns concatenated text for use with regex matchers that need a
 * "command-only" view (e.g., gates checking for git verbs). Non-command
 * segments are replaced with the placeholder token `__QUOTED__` rather
 * than empty string or single space.
 *
 * Why __QUOTED__ placeholder (not empty/space):
 * - Empty string ("") collapses adjacent tokens, breaking word boundaries
 *   for regex like `git\s+(?:-C\s+\S+\s+)*commit` — `\S+` requires at
 *   least one non-space char to match the path argument.
 * - Single space (" ") preserves boundary but allows misleading adjacency
 *   (e.g., `cd "/path" && git commit` could falsely token-merge across
 *   the quoted segment boundary).
 * - `__QUOTED__` is an opaque non-alnum-bordered token that:
 *   - Preserves \S+ word matching for adjacent regex
 *   - Cannot accidentally form git/gh verb prefixes (no `/` for path,
 *     no leading `git`/`gh`)
 *   - Is grep-able for debugging
 *
 * Fallback: parser exception → returns original cmd (preserves v6.32.2
 * regex-only behavior so a parser bug never opens new bypass).
 */
export function commandSegmentText(cmd) {
  try {
    const segs = segmentCommand(cmd);
    if (segs.length === 0) return cmd;
    const parts = segs.map((s, index) => {
      // A substitution in an environment value flattens into the value, so its end needs a boundary back or the
      // command behind it reads as an argument: `GH_TOKEN=$(echo x) gh pr create` → `GH_TOKEN=echo x; gh pr create`.
      if (s.kind === "command") return withEnvValueBoundary(cmd, segs, index);
      // Replace non-command segments with a non-whitespace placeholder token.
      // This ensures regex word boundaries and \S+ patterns (e.g. -C <path>) still
      // match the surrounding command structure, while the segment content is opaque.
      if (s.kind === "subshell") return ""; // inner commands already promoted
      if (s.kind === "comment") return ""; // comments don't need placeholder
      // quoted-string and heredoc-body → opaque placeholder token
      // The placeholder starts/ends with a non-alnum char so it doesn't accidentally
      // form new word sequences with adjacent text.
      return "__QUOTED__";
    });
    const result = parts.join("");
    return result.trim() ? result : cmd;
  } catch {
    return cmd;
  }
}

/**
 * Returns true when a regex match position (matchIndex) falls inside a
 * `command` segment (versus quoted-string / heredoc-body / subshell content
 * which is data, not actual command). When segs is null (parser failure
 * fallback), returns true (treat all matches as command — fail-safe to
 * v6.32.2 regex-only behavior).
 *
 * Usage: caller runs regex.matchAll(cmd) on ORIGINAL command (preserving
 * info like `-C <path>` for cwd extraction), then filters via this helper.
 */
export function isMatchInCommandSegment(matchIndex, segs) {
  if (segs === null) return true;
  for (const s of segs) {
    if (matchIndex >= s.range[0] && matchIndex < s.range[1]) {
      return s.kind === "command";
    }
  }
  return false;
}

// ── git global-option grammar (shared by pre-tool-gate.mjs + branch-naming.mjs) ──
// A regex source fragment that matches ONE leading git global option appearing
// between the `git` token and the subcommand verb. Used as `(?:${GIT_GLOBAL_OPT}\s+)*`
// so any number of globals are consumed before the verb is matched. Lives here
// (the lib both gate modules already import) so a single generalized grammar feeds
// every git verb gate — protected-write / attribution / force-push / repo-scope
// AND the hotfix / release-rules / in-place-branch-create / worktree base gates +
// branch-name extraction. Enumerating a subset reopened the bypass on each new git
// global flag (issue #851/#848 cross-model rounds 6-7: `git --no-pager <verb>`,
// `git -P <verb>`, `git --no-optional-locks <verb>`, `git --paginate <verb>` …).
// Generic rule:
//   1. value-taking globals (git's fixed set) consume their `=`-or-separate value
//      (quoted or bare): -C, -c, --git-dir, --work-tree, --namespace, --exec-path,
//      --super-prefix.
//   2. any `--flag=value` form (value attached) — one token.
//   3. any other `--flag` long option or `-X` short option = no-value — one token.
// Order matters: value-taking (1) is tried before the no-value catch-all (3) so a
// separate-argument value is consumed, not mis-read as the verb.
/** Value-taking git globals (the fixed set consumed with a separate or `=`-attached value).
 * Exported so argv-level scans (for example `hasExplicitGitCFlag`) cannot drift from
 * this grammar; keep the two in lockstep (drift test: shell-context-values test). */
export const GIT_GLOBAL_VALUE_OPTIONS = Object.freeze([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
]);

export const GIT_GLOBAL_OPT =
  `(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)(?:=\\S*|\\s+(?:"[^"]+"|'[^']+'|\\S+))` +
  `|--[A-Za-z][\\w-]*=\\S*` +
  `|--[A-Za-z][\\w-]*` +
  `|-[A-Za-z]+)`;

// Command-position boundary anchor for git/gh verb matchers — the leading
// `(?:^|[...])...` prefix that precedes a `git`/`gh` token. Replaces the historical
// bare-`\s` boundary `(?:^|[\s;|&(`])` whose whitespace class matched a verb that
// appears as an ARGUMENT to another command (`echo gh pr merge 9999`,
// `echo git push --force`, `echo git commit`) → false-positive block. This boundary
// matches a real COMMAND POSITION only: start-of-string, a true command separator
// (`;` `|` `&` `(` backtick `{`), or a shell control keyword that introduces a command
// (`then`/`do`/`else`/`elif`/`in`/`until`/`while`/`if`) followed by whitespace — where
// the KEYWORD ITSELF must also sit at a command position (start-of-string or a real
// separator `;` `|` `&` `(` backtick `{` newline `\n` carriage-return `\r`, optional
// whitespace between). A bare space / tab alone is NOT a command boundary, so neither
// `echo git …` NOR `echo then git …` matches — in the latter `then` is an ARGUMENT to
// `echo`, not a command-introducing keyword (issue #899 finding (b)). The keyword
// predecessor class MUST keep `\n` `\r` (a NATURAL multiline block — `if true⏎then git
// …⏎fi`, `while x⏎do git …⏎done` — separates the keyword from the head with a newline,
// not `;`); dropping them is an Axis-A false-negative regression (PR #933 cross-model
// review). While
// `if true; then git …`, `while x; do git …`, `{ git …; }`, `(git …)`, `a && git …`,
// `a ; git …`, `a | git …`, `FOO=1 git …`, `env FOO=1 git …`, `/usr/bin/git …` all match.
// The optional env-var / `env`-passthrough / path-prefix tail uses NON-CAPTURING groups only,
// so capture-group indices in consuming regexes are unchanged. An env-var VALUE is a bare word
// (no quote, `$` or backtick, so it cannot swallow a substituted command's `git`), a
// double-quoted string (`\"` escapes allowed; may hold spaces and `$`) or a single-quoted string:
// `FOO="a b" git push` runs git directly with an extra variable exactly like `FOO=1 git push`
// does, so every raw-text gate must see it. The three value forms start with different
// characters and the quoted forms cannot cross their own closing quote, so a failed match
// backtracks linearly (guarded by a timing test in shell-context.test.mjs). A value glued to
// the next word (`FOO="a b"git`) is one shell word, not an env prefix, and does not match.
// The two unquoted scan classes (bare env value, path prefix) additionally stop at every character that can
// itself open an anchor (`;` `|` `&` `(` backtick `{`). Without that they cross separators, so each separator in
// the text restarts a scan that runs to the end of the string and backtracks looking for whitespace or `/`:
// O(n²) on the quote-masked view the gates run on (`;X=__QUOTED__` repeated, `&&a` repeated, ~10s at 16000
// repeats). A real match that needs the crossing starts at that separator instead, so `FOO=a;git push`,
// `${HOME}/bin/git push` and `a;b/git push` still match; only `FOO=a;b git push` stops matching, correctly —
// `b` is the command there and `git push` its arguments.
//
// SAFETY (corrected — NOT a formal strict subset): the match sets are not strictly
// subset-related. NEW adds `{` `\n` `\r` to the separator class, so a few NEW-only
// forms exist (`{git commit` with no space matches NEW, not OLD). But every such
// NEW-only form is NON-EXECUTABLE bash (`{git` is one token, not a command), so it
// introduces NO real new false-positive. Conversely the OLD-only forms NEW drops are
// exactly the target bug: a verb after a bare space in ARGUMENT position
// (`echo git push`) — non-command-position — a command-introducing keyword itself in
// ARGUMENT position (`echo then git push` — the keyword `then` is preceded only by a
// bare space, so it is an `echo` argument, not a command boundary; issue #899 finding
// (b)) — plus syntax-error close-token forms (`} git commit`). Net: for NATURAL /
// EXECUTABLE commands the change only makes a
// gate fire LESS at arg-position and never less at a real command position. The
// false-negative direction (a real command position no longer matched) is the one to
// guard, and is verified exhaustively in shell-context.test.mjs + the Axis-A matrix
// in hook-pre-tool-gate-cmd-position-boundary.test.mjs (adversarial revert → red).
//
// THREAT MODEL (per `pre-tool-mechanical-gates` "Mechanical-Gate Threat Model And
// Fail-Open On Uncertainty"): these gates target NATURALLY-EMITTED commands;
// adversarial shell-equivalence is out of scope and backstopped by
// `DEVPRO_HOOK_BYPASS=1`. Residual keyword gaps (`case`/`esac`/`;;`, `!`, `time`,
// `coproc`, `function`) are documented limitations, not bypasses to chase: a verb
// after `time`/`!` is near-zero in natural agent output for the gated verbs.
//
// A bare value MAY be dynamic: $VAR, ${VAR}, one $(…) or one backtick pair. That is what keeps
// GH_TOKEN=$(gh auth token) gh pr create at command position. Each token alternative starts on a different
// character, so a value has one parse and matching stays linear: a digit after `$` is read only as a positional
// parameter, never as the start of a name, which two overlapping parses made exponential (PR #3703 r11 W2-F4).
// A substitution holding parentheses is not a value
// here: A=$(x $(y)) git push stays unlocated, because bounding this grammar is what keeps it a regex.
// A value is one shell word: quoted parts, backslash-escaped characters and bare text in any order, so a path with an
// escaped space (A=/x\ y) or a quoted part (A=/x/"y z") keeps the command after it at command position (PR #3703 r5 F3).
const ENV_VALUE_BARE_TOKEN = "[^\\s;|&({'\"$`\\\\]|\\\\[^\\n]|\\$[$?#!@*0-9-]|\\$(?=[A-Za-z_])|\\$\\{[^{}\\s]*\\}|\\$\\([^()]*\\)|`[^`]*`";
const ENV_VALUE = `(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|${ENV_VALUE_BARE_TOKEN})*`;
// A name in either case is an assignment (http_proxy=… gh … included), so a lowercase name never hides the command
// after it from the gates (PR #3703 r8 W2-F4).
const ENV_ASSIGNMENT = `[A-Za-z_][A-Za-z0-9_]*=${ENV_VALUE}\\s+`;
// One environment assignment and the space after it, its value read as one shell word; shared by every parser that skips
// the assignments in front of a command (PR #3703 r9 W2-F3).
export const ENV_ASSIGNMENT_SOURCE = ENV_ASSIGNMENT;
export const CMD_BOUNDARY =
  "(?:^|[;|&(`{\\n\\r]|(?:^|[;|&(`{\\n\\r])\\s*(?:then|do|else|elif|in|until|while|if)\\s)\\s*";
export const CMD_POSITION_ANCHOR =
  CMD_BOUNDARY +
  `(?:${ENV_ASSIGNMENT})*` +
  `(?:env\\s+(?:${ENV_ASSIGNMENT})+)?` +
  "(?:[^\\s;|&({'\"`]*\\/)?";

// gh reads --repo/-R before `pr` (`gh -R <repo> pr <verb>`), between `pr` and the verb (`gh pr -R <repo> <verb>`) and
// after the verb, so a matcher of `gh pr <verb>` that requires the two words to touch misses the first two positions
// and every gate behind it skips the command (fix-pre-verb-repo-flag-gates). GH_PR_REPO_FLAGS_SOURCE is a run of those
// flags; it holds no capturing group, so a regex that embeds it keeps its group numbers. ghPrVerbSource(verbs) is
// `gh pr <verb>` with that run allowed in both places, and ghPrPreVerbFlags(text) returns the flags written before
// the verb in a matched `gh … <verb>` text, so a reader of the arguments after the verb can put them in front of
// those arguments in command order.
export const GH_PR_REPO_FLAGS_SOURCE = `(?:(?:--repo(?:=|\\s+)|-R(?:=|\\s*))(?:"[^"]*"|'[^']*'|[^\\s;|&()]+)\\s+)*`;
export function ghPrVerbSource(verbs) {
  return `gh\\s+${GH_PR_REPO_FLAGS_SOURCE}pr\\s+${GH_PR_REPO_FLAGS_SOURCE}(?:${verbs})`;
}
const GH_PR_PRE_VERB_FLAGS_RE = new RegExp(`gh\\s+(${GH_PR_REPO_FLAGS_SOURCE})pr\\s+(${GH_PR_REPO_FLAGS_SOURCE})`);
export function ghPrPreVerbFlags(text) {
  const match = GH_PR_PRE_VERB_FLAGS_RE.exec(String(text ?? ""));
  return match ? `${match[1]}${match[2]}`.trim() : "";
}

// Start, env assignments and path prefix in front of `git`/`gh` for matchers looser than the anchor: a verb after any
// whitespace or `;|&(` counts. Three rules keep the scan linear in the command length:
// - A value or a path runs to the next whitespace or `;|&(`. The old copies read them as `\S*`, so every `;` in
//   `;X=1;X=1…` restarted a scan to the end of the string (~3 s of CPU at 16000 repeats).
// - Only the last whitespace of a run is a start (`(?!\s)`): one followed by another whitespace can match nothing.
// - That whitespace is no start either when the run follows an env assignment (the lookbehind, which then reads back
//   over one run only): the start before that assignment already reads it. Otherwise every whitespace in
//   `A=1 A=1 …` or `A=1  A=1  …` did the same.
// None of them changes which `git`/`gh` the old copies found or whether it counted, except where they read a `;|&(`
// as part of a value: in `MSG="done; git push"` the push sits inside the quotes, and `A=;git B=1 git -C /x` runs the
// first git.
const LOOSE_ENV_ASSIGNMENT = "[A-Za-z_][A-Za-z0-9_]*=[^\\s;|&(]*";
export const LOOSE_CMD_PREFIX =
  `(?:^|[;|&(]|\\s(?!\\s)(?<!(?:^|[\\s;|&(])${LOOSE_ENV_ASSIGNMENT}\\s+))` +
  `(?:${LOOSE_ENV_ASSIGNMENT}\\s+)*` +
  "(?:[^\\s;|&(]*\\/)?";

// Text that ends right after a non-empty environment prefix at command position, read by the same grammar as the
// anchor so the two cannot disagree on what counts as a value.
const ENV_PREFIX_END_RE = new RegExp(
  `${CMD_BOUNDARY}(?:(?:${ENV_ASSIGNMENT})+(?:env\\s+(?:${ENV_ASSIGNMENT})+)?|env\\s+(?:${ENV_ASSIGNMENT})+)$`
);
// How far back the check reads. A prefix this long is not natural, and the cap keeps a command of thousands of
// substitutions linear; past it the command stays unlocated, as it was before dynamic values were recognized.
const ENV_PREFIX_WINDOW = 1024;

// Text of command segment `index`, with a boundary after the value when the segment follows a substitution that
// sits in an environment value. The segment may start with the rest of that value (`A=$(x)rest git push`).
function withEnvValueBoundary(cmd, segs, index) {
  const seg = segs[index];
  if (index === 0 || segs[index - 1].scope === seg.scope) return seg.text;
  const valueTail = /^\S*\s+/.exec(seg.text)?.[0];
  if (!valueTail) return seg.text;
  const end = seg.range[0] + valueTail.length;
  const start = Math.max(0, end - ENV_PREFIX_WINDOW);
  const match = ENV_PREFIX_END_RE.exec(cmd.slice(start, end));
  // Inside a cut window `^` is not a command start, so only a boundary character in the window counts.
  if (match === null || (start > 0 && match.index === 0)) return seg.text;
  const valueEnd = valueTail.trimEnd().length;
  return `${seg.text.slice(0, valueEnd)};${seg.text.slice(valueEnd)}`;
}

// Absolute index of the `git`/`gh` verb token inside a CMD_POSITION_ANCHOR-prefixed match. `match.index` points at the
// leading boundary char (or at the start of an env prefix), not at the verb. The verb is the token the anchor's own
// prefix grammar ends on: an earlier `git`/`gh` word may sit in an env value (`FOO="a git b" git push`,
// `X=/opt/git git -C <dir> add`) or in the executable's path (`/opt/homebrew/opt/git/bin/git`). A match the grammar
// does not describe falls back to the first verb word outside quotes, then to `match.index`.
const ANCHORED_VERB_PREFIX_RE = new RegExp(`^${CMD_POSITION_ANCHOR}(?=(?:git|gh)\\b)`);
export function anchoredVerbIndex(match) {
  const text = match?.[0] || "";
  const prefix = ANCHORED_VERB_PREFIX_RE.exec(text);
  if (prefix) return (match.index ?? 0) + prefix[0].length;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ((ch === "g") && /^(?:git|gh)\b/.test(text.slice(i, i + 4))) return (match.index ?? 0) + i;
  }
  return match?.index ?? 0;
}

// `text` from `start` to `limit` (code units) with every position that lies in a data region — quoted string, heredoc body
// or comment per `segs` (the `segmentCommand` result) — replaced by a space. A position no segment covers (the `)` that
// closes a `$( … )` sits in a one-character gap between command segments) is not data. When segments overlap the first
// one in `segs` decides, as the per-position lookup this replaces did. One pass over the segments plus one over the
// text, so a command holding thousands of quoted strings costs O(n), not O(characters × segments).
// `segs === null` (segmentation threw) masks nothing.
export function maskDataRegions(text, segs, limit = text.length, start = 0) {
  const end = Math.max(0, Math.min(limit, text.length));
  const from = Math.max(0, Math.min(start, end));
  const data = new Uint8Array(end);
  if (Array.isArray(segs)) {
    for (let s = segs.length - 1; s >= 0; s -= 1) {
      const { kind, range } = segs[s];
      const isData = kind === "quoted-string" || kind === "heredoc-body" || kind === "comment" ? 1 : 0;
      for (let i = Math.max(0, range[0]); i < Math.min(range[1], end); i += 1) data[i] = isData;
    }
  }
  let out = "";
  for (let i = from; i < end; i += 1) out += data[i] ? " " : text[i];
  return out;
}

/**
 * Scan forward from `startIdx` in `cmd` to find the first top-level command
 * separator (`&&`, `||`, `;`, `|`, `\n`) that is not inside a quoted string,
 * subshell, heredoc body, or backtick expansion.
 *
 * This is a lightweight depth-tracking scanner that runs independently of the
 * B-narrow segmenter. It is used instead of `isMatchInCommandSegment` for
 * clause-end detection because the segmenter has known limitations with
 * embedded `"` characters inside `"$(…)"`  subshells (e.g. backtick-quoted
 * grep patterns with inner `"`: ``git commit -m "$(… `grep "(x)" …`…)"``).
 * In those cases the segmenter misclassifies characters inside the outer
 * subshell as a "command" segment, so `|` inside a regex like `(^|[^>/])`
 * would be wrongly treated as a top-level separator — truncating the clause
 * and dropping the footer (M1 false-negative).
 *
 * The depth-tracker is a direct state machine that correctly handles:
 *   - single-quote   `'...'`   (no escapes, no nesting)
 *   - double-quote   `"..."`   with `\"` and `\\` escapes
 *   - `$(...)` and `$((...))` subshells (depth stack)
 *   - backtick       `` `...` `` expansions
 *   - `<<TAG` / `<<'TAG'`  heredoc bodies (opaque until `\nTAG`)
 *
 * Returns the index of the first top-level separator found, or `cmd.length`
 * if none is found before the end of the string.
 *
 * M1 architect constraint: only a segment-aware (or equivalent depth-tracking)
 * check can correctly distinguish top-level `&&` from inner `&&` inside a
 * `"$(… && …)"` subshell. Both this depth-tracker and the original
 * `isMatchInCommandSegment` approach satisfy M1; the depth-tracker is used
 * here because it is immune to the segmenter's embedded-`"` limitation.
 *
 * @param {string} cmd
 * @param {number} startIdx — index to start scanning from (typically end of
 *                            the `git commit` match)
 * @returns {number} index of first top-level separator, or cmd.length
 */
export function findTopLevelSeparator(cmd, startIdx) {
  let i = startIdx;
  // Quoting/nesting state. "Top level" = all of these are false/zero.
  let singleQuote = false; // inside '...'
  let doubleQuote = false; // inside "..."
  let subshellDepth = 0;   // inside $(…) or $(( ))
  let backtick = false;    // inside `...`

  const heredocEndFrom = (idx) => {
    const heredocMatch = cmd.slice(idx).match(/^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!heredocMatch) return null;
    const tag = heredocMatch[2];
    const tagRe = new RegExp(`\n${tag}(?=\\s|$|\\))`);
    const bodyStart = idx + heredocMatch[0].length;
    const tagEnd = cmd.slice(bodyStart).search(tagRe);
    if (tagEnd === -1) return cmd.length;
    return bodyStart + tagEnd + 1 + tag.length;
  };

  const quotedEndFrom = (idx, quote) => {
    let j = idx + 1;
    while (j < cmd.length) {
      if (quote !== "'" && cmd[j] === "\\" && j + 1 < cmd.length) {
        j += 2;
        continue;
      }
      if (cmd[j] === quote) return j + 1;
      j++;
    }
    return cmd.length;
  };

  while (i < cmd.length) {
    const ch = cmd[i];

    // ── Inside single-quoted string: nothing special until closing ' ─────────
    if (singleQuote) {
      if (ch === "'") singleQuote = false;
      i++;
      continue;
    }

    // ── Inside backtick expansion: treat content as opaque ───────────────────
    if (backtick) {
      if (ch === "`") backtick = false;
      i++;
      continue;
    }

    // ── Inside subshell $(...): depth-track ( and ) ───────────────────────────
    if (subshellDepth > 0) {
      const heredocEnd = heredocEndFrom(i);
      if (heredocEnd !== null) {
        i = heredocEnd;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        i = quotedEndFrom(i, ch);
        continue;
      }
      if (ch === "\\" && i + 1 < cmd.length) {
        i += 2;
        continue;
      }
      if (ch === "(") subshellDepth++;
      else if (ch === ")") subshellDepth--;
      i++;
      continue;
    }

    // ── Inside double-quoted string ───────────────────────────────────────────
    // `$(...)` subshells inside double-quotes ARE active; single-quotes and
    // backticks inside double-quotes are literal (not nesting). Backslash
    // escapes `\"` and `\\` are honored.
    if (doubleQuote) {
      if (ch === "\\" && i + 1 < cmd.length) {
        i += 2; // consume escape sequence
        continue;
      }
      if (ch === "$" && cmd[i + 1] === "(") {
        subshellDepth++; // $(...) inside "..." is a real subshell
        i += 2;
        continue;
      }
      if (ch === '"') {
        doubleQuote = false; // closing double-quote
      }
      i++;
      continue;
    }

    // ── Top level (unquoted, no active subshell/backtick) ────────────────────

    // Heredoc detection: `<<[-]?['"]?TAG['"]?` — body is opaque until `\nTAG`.
    {
      const heredocEnd = heredocEndFrom(i);
      if (heredocEnd !== null) {
        i = heredocEnd;
        continue;
      }
    }

    // Backslash escapes at top level (e.g. `\;` or `\ ` or `\&&`).
    if (ch === "\\" && i + 1 < cmd.length) {
      i += 2;
      continue;
    }

    // Enter quoting contexts.
    if (ch === "'") { singleQuote = true; i++; continue; }
    if (ch === '"') { doubleQuote = true; i++; continue; }
    if (ch === "`") { backtick = true; i++; continue; }
    if (ch === "$" && cmd[i + 1] === "(") { subshellDepth++; i += 2; continue; }

    // ── Separators (top level only) ───────────────────────────────────────────
    if (ch === "&" && cmd[i + 1] === "&") return i;
    if (ch === "|" && cmd[i + 1] === "|") return i;
    if (ch === ";") return i;
    if (ch === "|") return i;
    if (ch === "\n") return i;

    i++;
  }
  return cmd.length;
}

// An assignment belongs to a command only when spaces or tabs separate it from the command on the same statement; one
// on its own line before it is another statement. The value is one shell word: quoted parts, backslash-escaped
// characters (an escaped space included) and plain text. The name may follow a command separator directly.
// The backtick is written \x60 so the prune census's lexical scanner can still read this file.
const TRAILING_ASSIGNMENT_RE = /(?:^|(?<=[ \t;&|(\x60{\n]))([A-Za-z_]\w*)=(?:\\[^\n]|"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|()<>"'\\])*[ \t]*$/;
// The assignments at the end of `text` (the text in front of a command), in order, as { name, word, index, text } with
// the value as the shell word written; `rest` is the text before them. Read at shell-word boundaries, so an
// assignment-like text inside a quoted value is part of that value (PR #3703 r8 W2-F3). Every reader of the
// assignments in front of a gh command uses this one parser (PR #3703 r10 W2-F2).
export function prefixAssignments(text) {
  const assignments = [];
  let rest = text;
  for (let match = TRAILING_ASSIGNMENT_RE.exec(rest); match; match = TRAILING_ASSIGNMENT_RE.exec(rest)) {
    assignments.unshift({ name: match[1], word: match[0].replace(/[ \t]+$/, "").slice(match[1].length + 1), index: match.index, text: match[0] });
    rest = rest.slice(0, match.index);
  }
  return { assignments, rest };
}
