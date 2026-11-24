/**
 * js-comment-spans.mjs — lexical (not regex) JS comment stripper.
 *
 * `.devpro/scripts/tests/prune-merged-local-c.test.mjs` used to strip comments
 * from a target script with naive regexes such as
 * `replace(/\/\*[\s\S]*?\*\//g, '')` before asserting on the remaining source.
 * A naive regex has no notion of "inside a string / template / regex literal",
 * so it also eats comment-shaped text sitting inside string/template/regex
 * content and — worse — silently swallows real code that followed it. That is
 * defect B this module exists to fix: `stripJsCommentSpans(source)` walks the
 * source one character at a time with an explicit state machine so that
 * **only comment spans are removed** — string, template, and regex-literal
 * text is preserved byte-for-byte. Removed comment characters are replaced by
 * spaces (newlines are always kept as `\n`), so the output has the exact same
 * length, line count, and per-line character offsets as the input.
 *
 * ─── State machine ──────────────────────────────────────────────────────────
 * code / line-comment / block-comment / single-quote string / double-quote
 * string / template literal. A template's `${ … }` interpolation re-enters
 * code state on an explicit stack, tracking brace depth so a nested object
 * literal / block expression does not close the slot early; the matching `}`
 * returns to the enclosing template, so nested templates inside an
 * interpolation are handled and comments inside an interpolation are stripped
 * like any other code-state comment. `\` escapes are consumed as pairs in
 * every state (code, string, template); `\` + LineTerminator (LineContinuation)
 * is one pair — CRLF included — and is therefore never seen by the "unescaped
 * newline" checks of E2/E3. Those checks recognise LF/CR only (raw U+2028/
 * U+2029 are LEGAL inside string literals, so they must not terminate them),
 * while line comments end at the full ECMAScript `LineTerminator` set (LF, CR,
 * U+2028, U+2029) — so CR-only / U+2028-terminated sources behave like LF
 * sources for comments without over-terminating strings.
 *
 * ─── What this module deliberately does NOT do ─────────────────────────────
 * There is no regex-literal state, and no "previous significant token"
 * heuristic to decide whether a bare `/` starts a regex or is a division
 * operator. That heuristic's own failure mode — misreading `/` as a regex
 * opener and eating the rest of the line/file — is the same shape of bug as
 * defect B; adding it back in would just move the false-positive, not remove
 * it. Regex-literal *bodies* are still walked correctly because they are
 * walked in CODE state: the four rules below (E1-E4) are exactly what keeps
 * a regex body's `\/`, quote characters, and backtick characters from being
 * misread as the start of a comment, a string, or a template.
 *
 * ─── The four rules ─────────────────────────────────────────────────────────
 *  E1 — code state: `\` consumes the next character together with itself
 *       ("escaped character is consumed with its backslash"). Without this,
 *       an escaped slash inside a regex body (`/^origin\//`) would present a
 *       bare `/` to the comment-detector and manufacture a false `//`.
 *  E2 — a quote character (`'` or `"`) only opens a string when there is
 *       later an unescaped same-type quote, with no unescaped newline in
 *       between ("quote opens a string only when an unescaped partner
 *       follows"). ECMAScript `StringLiteral`s cannot contain a raw
 *       LineTerminator — only a backslash-newline LineContinuation may cross
 *       a physical line — so this is the real grammar boundary, not a
 *       heuristic.
 *  E3 — mechanically, "quote string state ends at an unescaped newline": the
 *       forward walk that decides E2 IS the walk that would consume the
 *       string content, so a walk that hits an unescaped newline before a
 *       partner resyncs back to code state (the quote was never a real
 *       opener) instead of continuing to search past the line boundary.
 *  E4 — fail closed at EOF: a scan that ends **while still inside a string,
 *       template, or block-comment span** ("scan ended inside a string,
 *       template, or block comment") throws, because syntactically valid JS
 *       cannot leave any of those three states open at end of file — landing
 *       there proves the scan mis-parsed something, and returning any result
 *       from that state would be a silent wrong answer. The three states are
 *       an explicit enumeration, NOT "anything that is not code": a legal JS
 *       file may end in a `//` line comment with no final newline (line
 *       comments end at EOF), and that shape must not throw.
 *
 * `\` + LineTerminator (LineContinuation) is a single escape pair under E1,
 * consumed identically by the code-state walker and by the string/template
 * content walkers below — so a LineContinuation newline is never seen by the
 * "unescaped newline" checks in E2/E3, and a multi-line string built purely
 * from LineContinuations is preserved as one string, not split at the walker
 * boundary that a naive "same physical line" implementation would introduce.
 *
 * ─── Known, deliberately unfixed residuals (this list is NOT exhaustive —
 * 本列表非窮舉; it documents the shapes found while building this module, not
 * every shape a lexical, non-grammar scanner can misjudge) ─────────────────
 *   L1  regex body has an unescaped quote whose matching partner lands in a
 *       COMMENT ("const a = /['x]/; // don't do this") → that trailing
 *       comment is NOT stripped. Failure direction: too narrow / false green
 *       (a real comment survives in the output).
 *   L1b regex body has an unescaped quote whose matching partner lands in
 *       real CODE or a string literal ("const q = /['"]/; const msg =
 *       "https://x";") → that code/string span is walked as if it were the
 *       (wrong) string content of the "opened" quote. Failure direction: too
 *       wide / false red (real content gets treated as opaque string text).
 *   L2  a regex character class containing an unescaped `//` or `/*`
 *       ("/[/*]/") is read as a real comment opener, eating what follows.
 *       Failure direction: too wide / false red.
 *   L3  a would-be LineContinuation string is only "LineContinuation" when
 *       E2/E3's "unescaped newline" is genuinely backslash-consumed — an
 *       implementation that checks "does the string close on the SAME
 *       physical line" instead of tracking escape pairs would misjudge this
 *       shape. Failure direction: too wide / false red.
 *   L4  a regex body contains ANY unescaped backtick ("/^( {0,3})(`{3,}|~
 *       {3,})(.*)$/u", see markdown-fence-aware.mjs:13) → this module has no
 *       regex-literal state, so the backtick is read in CODE state and opens
 *       a template. Templates legally span multiple lines, so E3's newline
 *       resync does not apply to templates at all — an odd number of stray
 *       backticks after this point is caught by E4 (throws), but an EVEN
 *       number of stray backticks re-closes silently, the misreading has
 *       unbounded reach until then, and none of the three measurement
 *       criteria can see it. Failure direction: too narrow / false green
 *       when the mis-entry count is even (silent by construction); too wide /
 *       false red when it is odd (E4 throws instead of returning a wrong
 *       answer). The even case is carried by the resident mutation fixture's
 *       L4 axis in `prune-merged-local-c.test.mjs` — its designated owner.
 * L1b and L4 are deliberately left unfixed: correctly handling either
 * requires a regex-literal state, and a regex-literal state's own failure
 * mode (misreading a division `/` as a regex opener, eating real code) is
 * the exact defect this module exists to avoid reintroducing.
 */

/**
 * ECMAScript `LineTerminator` set: LF, CR, U+2028 (LS), U+2029 (PS) — CRLF
 * counts as one terminator. Line comments end at any of these. Quote strings
 * are different: their E2/E3 "unescaped newline" test must recognise only LF
 * and CR, because raw U+2028/U+2029 are LEGAL inside string literals
 * (JSON-superset grammar) — treating them as string terminators would abandon
 * a valid string and expose its contents to comment stripping.
 */
const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

export class JsCommentSpanScanError extends Error {
  constructor(message) {
    super(message);
    this.name = "JsCommentSpanScanError";
  }
}

/**
 * E1, shared by every walker below: `\` consumes the next character together
 * with itself ("escaped character is consumed with its backslash"). `i`
 * points at the backslash; returns the index just past the consumed pair, or
 * just past the lone backslash when it is the final source character (EOF
 * right after a trailing backslash never throws or loops here — only the
 * caller's own end-of-scan state, per E4, decides whether that is an error).
 *
 * This is the ONE routine every backslash-aware walker (the code-state loop,
 * the quote-partner lookahead, and the template content walk) calls, so the
 * decision of "where does this escape end" can never disagree between them —
 * the alternative (independently duplicated escape logic in the lookahead vs.
 * the walker) is exactly the kind of drift that would let a lookahead's "yes,
 * it closes" promise and the walker's actual consumption land on different
 * offsets.
 *
 * @param {number} i index of the backslash
 * @param {number} len source length
 * @returns {number}
 */
function afterEscape(source, i, len) {
  if (i + 1 >= len) return i + 1;
  // A backslash followed by CRLF is ONE LineContinuation: consuming only the
  // CR would leave the LF to be read as an unescaped newline by E2/E3, which
  // then abandons the string and can strip the continued line as code.
  if (source[i + 1] === "\r" && source[i + 2] === "\n") return i + 3;
  return i + 2;
}

/**
 * quote opens a string only when an unescaped partner follows, with no
 * unescaped newline in between. This single forward walk both DECIDES E2
 * (by what it returns) and IS the content the caller copies verbatim on a
 * "closed" result — there is no separate walker pass that could re-derive a
 * different end offset, so a "closed" result can never later turn out to
 * have skipped past an unescaped newline.
 *
 * @param {string} source
 * @param {number} start index of the opening quote character
 * @returns {{ kind: "closed", end: number } | { kind: "newline-before-close" } | { kind: "eof" }}
 */
function scanQuoteSpan(source, start) {
  const quote = source[start];
  const len = source.length;
  let i = start + 1;
  while (i < len) {
    const ch = source[i];
    if (ch === "\\") {
      i = afterEscape(source, i, len);
      continue;
    }
    if (ch === quote) {
      return { kind: "closed", end: i + 1 };
    }
    if (ch === "\n" || ch === "\r") {
      // quote string state ends at an unescaped newline — LF or CR only.
      // Raw U+2028/U+2029 are legal inside string literals (JSON-superset
      // grammar), so they must NOT terminate a quote string here; they only
      // terminate line comments (see LINE_TERMINATORS).
      return { kind: "newline-before-close" };
    }
    i += 1;
  }
  // Ran off the end of the source without finding a partner AND without
  // finding an unescaped newline to justify treating the quote as a plain
  // character either — this is a genuinely unterminated string; the caller
  // fails closed (E4) instead of guessing.
  return { kind: "eof" };
}

/**
 * Strip `//` and `/* *\/` comment spans from `source`, preserving everything
 * else byte-for-byte (string/template/regex-literal-body text included).
 * Removed comment characters are replaced with spaces; newlines inside a
 * block comment are kept as `\n` so line numbers never shift.
 *
 * @param {string} source
 * @returns {string}
 * @throws {JsCommentSpanScanError} when the scan ends inside a string,
 *   template, or block comment (see E4 in the module doc) — see the module
 *   doc's residual-limitation table (L1b/L4) for the shapes that can still
 *   reach here on syntactically valid input this module does not fully lex.
 */
export function stripJsCommentSpans(source) {
  if (typeof source !== "string") {
    throw new TypeError("stripJsCommentSpans(source): source must be a string");
  }
  const len = source.length;
  const out = [];
  // "template" while inside template-literal text; "interpolation" while
  // inside the code of a `${ … }` slot (with braceDepth tracking nested
  // object literals / block expressions so the interpolation ends at ITS
  // closing brace, not at the first nested `}`). A trailing "interpolation"
  // therefore implies a template beneath it (scan ended inside the template).
  const stack = [];
  let i = 0;

  while (i < len) {
    const ch = source[i];
    const inTemplateText = stack.length > 0 && stack[stack.length - 1].kind === "template";

    if (ch === "\\") {
      // escaped character is consumed with its backslash
      const next = afterEscape(source, i, len);
      for (let k = i; k < next; k += 1) out.push(source[k]);
      i = next;
      continue;
    }

    if (!inTemplateText) {
      // Code state: the root context, or inside a `${ … }` interpolation.

      if (ch === "/" && source[i + 1] === "/") {
        let j = i + 2;
        while (j < len && !LINE_TERMINATORS.has(source[j])) j += 1;
        for (let k = i; k < j; k += 1) out.push(" ");
        i = j;
        continue;
      }

      if (ch === "/" && source[i + 1] === "*") {
        let j = i + 2;
        let closed = false;
        while (j < len) {
          if (source[j] === "*" && source[j + 1] === "/") {
            j += 2;
            closed = true;
            break;
          }
          j += 1;
        }
        if (!closed) {
          // scan ended inside a string, template, or block comment
          throw new JsCommentSpanScanError(
            "scan ended inside a string, template, or block comment (block-comment)",
          );
        }
        for (let k = i; k < j; k += 1) out.push(source[k] === "\n" ? "\n" : " ");
        i = j;
        continue;
      }

      if (ch === "'" || ch === '"') {
        const result = scanQuoteSpan(source, i);
        if (result.kind === "closed") {
          for (let k = i; k < result.end; k += 1) out.push(source[k]);
          i = result.end;
          continue;
        }
        if (result.kind === "newline-before-close") {
          out.push(ch);
          i += 1;
          continue;
        }
        // result.kind === "eof"
        // scan ended inside a string, template, or block comment
        throw new JsCommentSpanScanError(
          "scan ended inside a string, template, or block comment (string)",
        );
      }

      if (ch === "`") {
        stack.push({ kind: "template" });
        out.push(ch);
        i += 1;
        continue;
      }

      if (stack.length > 0 && stack[stack.length - 1].kind === "interpolation") {
        // Brace depth belongs to the interpolation frame: a nested object
        // literal / block expression must not close the `${ … }` slot early.
        if (ch === "{") {
          stack[stack.length - 1].braceDepth += 1;
          out.push(ch);
          i += 1;
          continue;
        }
        if (ch === "}") {
          const frame = stack[stack.length - 1];
          frame.braceDepth -= 1;
          if (frame.braceDepth === 0) stack.pop();
          out.push(ch);
          i += 1;
          continue;
        }
      }
    } else {
      // Template-literal text state. Templates may span physical lines, so
      // there is no E2/E3-style newline resync here; only E1's escape pairs,
      // the closing backtick, and an interpolating `${` are significant.

      if (ch === "`") {
        stack.pop();
        out.push(ch);
        i += 1;
        continue;
      }

      if (ch === "$" && source[i + 1] === "{") {
        stack.push({ kind: "interpolation", braceDepth: 1 });
        out.push("$", "{");
        i += 2;
        continue;
      }
    }

    out.push(ch);
    i += 1;
  }

  if (stack.length > 0) {
    // scan ended inside a string, template, or block comment
    throw new JsCommentSpanScanError(
      "scan ended inside a string, template, or block comment (template)",
    );
  }

  return out.join("");
}
