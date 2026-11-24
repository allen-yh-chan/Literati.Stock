/**
 * js-comment-spans.test.mjs
 *
 * Unit tests for `.devpro/scripts/lib/js-comment-spans.mjs`
 * (`stripJsCommentSpans`), the lexical comment stripper that replaces the two
 * naive regex passes in `prune-merged-local-c.test.mjs` (defect B,
 * fix-guard-scope-fidelity R4/R5).
 *
 * Contract under test (design.md D3/D4):
 *   - ONLY comment spans are removed; string / template / regex-literal body
 *     text is preserved byte-for-byte.
 *   - Removed comment characters become equal-length blanks (newlines kept),
 *     so offsets and line numbers never shift.
 *   - E1: code state — `\` consumes the next character together with itself.
 *   - E2: a quote opens a string only when an unescaped same-type partner
 *         follows, with no unescaped newline in between.
 *   - E3: quote string state ends at an unescaped newline (resync to code).
 *   - E4: at EOF, ending inside a string, template, or block comment is a
 *         proven mis-scan → fail closed with a named error. Those three states
 *         are an explicit enumeration (MUST NOT be widened to "not code"): a
 *         legal file may end in a line comment with no trailing newline.
 *   - `${...}` interpolation re-enters code state (depth stack): comments
 *     inside an interpolation are stripped.
 *
 * Every E1-E4 group is written as a RED-face assertion: deleting that rule
 * from the implementation turns the group red (E4's RED face is
 * `assert.throws`). The LineContinuation coverage doubles as the L3 pin —
 * design D4's "unescaped" is normative: a backslash-newline is a
 * continuation, not a line boundary, so E2's lookahead must keep searching
 * the continued line and E3 must not resync on an escaped newline.
 *
 * Spec scenario carriers (test-governance):
 *   - "Comment spans are removed without flipping code/string parity" — the strip-contract group plus the E1 / E2 / E3 groups below.
 *   - "A proven mis-scan fails closed while a legal trailing line comment does not" — the E4 group below (three-state enumeration + the no-trailing-newline positive assertion).
 *
 * Known residuals are pinned by the documented-limitation tests at the bottom
 * (L1 / L1b / L2 / L3 / L4). That list is NOT exhaustive — it records the
 * shapes found while building the module (the module doc says the same). A
 * red limitation test means the residual's shape changed: update the module's
 * limitation notes and design D4's residual table together, never silently
 * re-pin.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripJsCommentSpans,
  JsCommentSpanScanError,
} from '../lib/js-comment-spans.mjs';

/** Join source rows with newlines; no implicit trailing newline. */
function joinLines(...rows) {
  return rows.join('\n');
}

function newlineOffsets(text) {
  return [...text].flatMap((character, index) => (character === '\n' ? [index] : []));
}

// ─── Strip contract ─────────────────────────────────────────────────────────

describe('stripJsCommentSpans: only comment spans are removed', () => {
  const source = joinLines(
    'const re = /^origin\\//; // line-comment-marker',
    "const s = 'a /* not a comment */ b';",
    'const t = `a // not a comment`;',
    '/* block-comment-marker',
    ' * spans two lines */',
    'const marker = 1;',
  );
  const stripped = stripJsCommentSpans(source);

  test('line and block comment text is removed', () => {
    assert.ok(!stripped.includes('line-comment-marker'), 'line comment must be stripped');
    assert.ok(!stripped.includes('block-comment-marker'), 'block comment must be stripped');
    assert.ok(!stripped.includes('spans two lines'), 'multi-line block comment body must be stripped');
  });

  test('string, template, and regex text is preserved byte-for-byte', () => {
    assert.ok(stripped.includes("/^origin\\//"), 'regex body must survive verbatim');
    assert.ok(stripped.includes("'a /* not a comment */ b'"), 'string content must survive verbatim');
    assert.ok(stripped.includes('`a // not a comment`'), 'template text must survive verbatim');
    assert.ok(stripped.includes('const marker = 1;'), 'code after comments must survive');
  });

  test('removed characters become equal-length blanks; newline offsets never shift', () => {
    assert.equal(stripped.length, source.length);
    assert.deepEqual(newlineOffsets(stripped), newlineOffsets(source));
  });
});

// ─── E1: escaped character is consumed with its backslash ───────────────────

describe('E1: escaped character is consumed with its backslash', () => {
  test('a regex body `/^origin\\//` does not manufacture a `//` comment', () => {
    const source = joinLines(
      'const re = /^origin\\//; // real-comment-marker',
      'const marker = 1;',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(stripped.includes('/^origin\\//'), 'regex body must survive verbatim');
    assert.ok(!stripped.includes('real-comment-marker'), 'the real comment must still be stripped');
    assert.ok(stripped.includes('const marker = 1;'), 'code after the regex must survive');
  });

  test("a regex body `/\\/\\*[\\s\\S]*?\\*\\//g` does not manufacture a comment opener", () => {
    const source = joinLines(
      'const re = /\\/\\*[\\s\\S]*?\\*\\//g; // real-comment-marker',
      'const marker = 2;',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(stripped.includes('/\\/\\*[\\s\\S]*?\\*\\//g'), 'regex body must survive verbatim');
    assert.ok(!stripped.includes('real-comment-marker'), 'the real comment must still be stripped');
    assert.ok(stripped.includes('const marker = 2;'), 'code after the regex must survive');
  });

  test('a regex body `/^[A-Za-z][A-Za-z0-9+.-]*:\\/\\//` does not manufacture a `//` comment', () => {
    const source = joinLines(
      'const re = /^[A-Za-z][A-Za-z0-9+.-]*:\\/\\//; // real-comment-marker',
      'const marker = 3;',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(
      stripped.includes('/^[A-Za-z][A-Za-z0-9+.-]*:\\/\\//'),
      'regex body must survive verbatim',
    );
    assert.ok(!stripped.includes('real-comment-marker'), 'the real comment must still be stripped');
    assert.ok(stripped.includes('const marker = 3;'), 'code after the regex must survive');
  });
});

// ─── E2: quote opens a string only when an unescaped partner follows ────────

describe('E2: quote opens a string only when an unescaped partner follows', () => {
  test("regex body quotes with no same-line partner stay plain (`/['\"]/`, `/it's/`)", () => {
    const source = joinLines(
      'const q = /[\'"]/;',
      "const it = /it's/;",
      '// real-comment-marker',
      'const marker = 2;',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(stripped.includes('/[\'"]/'), 'regex body must survive verbatim');
    assert.ok(stripped.includes("/it's/"), 'regex body must survive verbatim');
    assert.ok(!stripped.includes('real-comment-marker'), 'comment after the regexes must be stripped');
    assert.ok(stripped.includes('const marker = 2;'), 'code after the regexes must survive');
  });

  test('a same-line string literal keeps its comment-shaped content', () => {
    const source = joinLines(
      "const s = 'inner // not a comment';",
      'const t = "outer /* not a comment */ end";',
      'const marker = 3;',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(stripped.includes("'inner // not a comment'"), 'string content must survive verbatim');
    assert.ok(
      stripped.includes('"outer /* not a comment */ end"'),
      'string content must survive verbatim',
    );
    assert.ok(stripped.includes('const marker = 3;'), 'code after the strings must survive');
  });
});

// ─── E3: quote string state ends at an unescaped newline ────────────────────

describe('E3: quote string state ends at an unescaped newline', () => {
  test('a quote whose partner only exists on a later line does not swallow the comment between', () => {
    const source = joinLines(
      "const a = /'/;",
      '// real-comment-marker',
      "const b = 'second';",
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(!stripped.includes('real-comment-marker'), 'comment between must be stripped');
    assert.ok(stripped.includes("const b = 'second';"), 'the later string must survive verbatim');
  });
});

// ─── E4: fail closed at EOF on the three enumerated states ──────────────────

describe('E4: scan ending inside string / template / block comment fails closed', () => {
  const cases = [
    ['string', "const s = 'abc"],
    ['template', 'const t = `abc'],
    ['block comment', '/* abc'],
  ];

  for (const [label, source] of cases) {
    test(`throws the named error when the scan ends inside a ${label}`, () => {
      assert.throws(
        () => stripJsCommentSpans(source),
        (error) => {
          assert.ok(
            error instanceof JsCommentSpanScanError,
            `expected JsCommentSpanScanError, got ${error?.name}: ${error?.message}`,
          );
          assert.match(error.message, /scan ended inside a string, template, or block comment/);
          return true;
        },
      );
    });
  }

  test('does not throw for a legal file ending in a line comment with no trailing newline', () => {
    const source = 'const marker = 9; // trailing-comment-marker';
    const stripped = stripJsCommentSpans(source);
    assert.ok(stripped.includes('const marker = 9;'), 'code before the line comment must survive');
    assert.ok(!stripped.includes('trailing-comment-marker'), 'the line comment must be stripped');
    assert.equal(stripped.length, source.length);
  });
});

// ─── Template interpolation re-enters code state (design D3) ────────────────

describe('template interpolation re-enters code state', () => {
  test('strips comments inside a `${...}` interpolation', () => {
    const source = joinLines(
      'const t = `a ${ /* inner-comment-marker */ b } c`;',
      '// real-comment-marker',
      'const marker = 5;',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(!stripped.includes('inner-comment-marker'), 'comment inside interpolation must be stripped');
    assert.ok(stripped.includes('`a ${ '), 'template and interpolation text must survive');
    assert.ok(stripped.includes(' b } c`;'), 'interpolation code must survive');
    assert.ok(!stripped.includes('real-comment-marker'), 'comment after the template must be stripped');
    assert.ok(stripped.includes('const marker = 5;'));
  });

  test('handles a nested template inside an interpolation', () => {
    const source = joinLines(
      'const t = `outer ${ `inner ${ /* deep-comment-marker */ 1 }` } end`;',
      'const marker = 6;',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(!stripped.includes('deep-comment-marker'), 'comment in nested interpolation must be stripped');
    assert.ok(stripped.includes('const t = `outer ${ `inner ${ '), 'template structure must survive');
    assert.ok(stripped.includes(' }` } end`;'), 'template structure must survive');
    assert.ok(stripped.includes('const marker = 6;'));
  });
});

// ─── Documented limitations: pinned current behavior, list NOT exhaustive ───

describe('documented limitations (pinned residuals; the list is NOT exhaustive)', () => {
  test("L1: a regex quote pairing inside comment text leaves that comment unstripped (false green)", () => {
    const source = joinLines("const a = /['x]/; // don't do this");
    const stripped = stripJsCommentSpans(source);
    assert.ok(
      stripped.includes("// don't do this"),
      'L1 residual: the comment survives when the regex quote pairs with a quote inside it',
    );
  });

  test('L1b: a regex quote pairing onto a real string truncates that string (false red)', () => {
    // Trailing newline on purpose: real files end in one, and it is what lets
    // E2's lookahead treat the regex quote as a plain character instead of
    // running to EOF (that variant fails closed via E4, which is a different
    // observable and not what L1b documents).
    const source = 'const q = /[\'"]/; const msg = "https://x"; // secret\n';
    const stripped = stripJsCommentSpans(source);
    assert.ok(
      !stripped.includes('https://x'),
      'L1b residual: the real string body is walked as code, so its `//` becomes a comment',
    );
    assert.throws(
      () => new Function(stripped),
      SyntaxError,
      'L1b output is unparseable; that is how design D4 criterion (b) catches this shape',
    );
  });

  test('L2: a character class `[/*]` eats the code that follows (false red)', () => {
    const source = joinLines('const re = /[/*]/; const marker = 2; /* closer */');
    const stripped = stripJsCommentSpans(source);
    assert.ok(
      !stripped.includes('const marker = 2;'),
      'L2 residual: the `/*` inside the character class opens a real block comment',
    );
  });

  test('L3: a LineContinuation string keeps its continued line as string content (E2/E3 RED face)', () => {
    const source = joinLines(
      "const s = 'foo\\",
      "// not a comment';",
      'const marker = 1; // real-comment-marker',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(
      stripped.includes("// not a comment';"),
      'the continued line is string content; a same-physical-line implementation would strip it',
    );
    assert.ok(!stripped.includes('real-comment-marker'), 'the real comment must still be stripped');
    assert.ok(stripped.includes('const marker = 1;'));
  });

  test('L4: an odd stray backtick fails closed (E4); an even pair misreads silently', () => {
    assert.throws(
      () => stripJsCommentSpans(joinLines('const a = /`/;')),
      JsCommentSpanScanError,
      'an odd stray backtick leaves the template open at EOF, so E4 must throw',
    );
    const even = joinLines(
      'const a = /`/; // comment-one-marker',
      'const b = /`/; // comment-two-marker',
      'const marker = 4;',
    );
    const stripped = stripJsCommentSpans(even);
    assert.ok(
      stripped.includes('comment-one-marker'),
      'L4 residual: an even mis-entry silently swallows the span as template text; only the D6 L4 fixture axis carries it',
    );
    assert.ok(stripped.includes('const marker = 4;'), 'code after the misread span must survive');
  });
});

// ─── Template interpolation brace depth (cross-review r1 code finding) ───────
//
// `${ {x: 1} ... }` / `${ (() => { ... })() }`: the interpolation must end at
// the brace that closes the interpolation, not at the first `}` of a nested
// object literal / block expression. Without brace-depth tracking the early
// close turns the rest of the interpolation (and any real comment in it) into
// template text, so the comment survives and the guard loses its target
// (false green).
describe('template interpolation tracks brace depth', () => {
  test('strips comments after a nested object literal inside `${...}`', () => {
    const source = joinLines(
      'const s = `a ${ {x: 1} /* nested-object-marker */ } b`;',
      '// outer-marker',
      'const marker = 1;',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(!stripped.includes('nested-object-marker'), 'comment after a nested object literal must be stripped');
    assert.ok(stripped.includes('`a ${ {x: 1}'), 'template and object literal must survive');
    assert.ok(stripped.includes(' } b`;'), 'interpolation close and template tail must survive');
    assert.ok(!stripped.includes('outer-marker'), 'comment after the template must be stripped');
    assert.ok(stripped.includes('const marker = 1;'));
  });

  test('strips comments inside a block expression nested in `${...}`', () => {
    const source = joinLines(
      'const s = `${ (() => { /* block-marker */ return 1; })() } end`;',
      'const marker = 2;',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(!stripped.includes('block-marker'), 'comment inside a nested block expression must be stripped');
    assert.ok(stripped.includes('return 1;'), 'block-expression code must survive');
    assert.ok(stripped.includes(' end`;'), 'template tail must survive');
    assert.ok(stripped.includes('const marker = 2;'));
  });

  test('keeps nested braces balanced across sibling interpolations', () => {
    const source = joinLines(
      'const s = `${ {a: {b: 1}} /* deep-marker */ } x ${ f({c: 2}) /* sibling-marker */ } y`;',
      'const marker = 3;',
    );
    const stripped = stripJsCommentSpans(source);
    assert.ok(!stripped.includes('deep-marker'), 'deep nested-object comment must be stripped');
    assert.ok(!stripped.includes('sibling-marker'), 'sibling interpolation comment must be stripped');
    assert.ok(stripped.includes('const marker = 3;'));
    assert.equal(stripped.length, source.length);
  });
});

// ─── ECMAScript line terminators (cross-review r1 code finding) ─────────────
//
// ECMAScript LineTerminator is the set {LF, CR, U+2028, U+2029} (CRLF counts as
// one). A line comment must end at any of them, and `\` + CRLF is one
// LineContinuation escape pair — consuming only the CR would leave the LF to be
// read as an unescaped newline, which then strips following executable code or
// abandons a real string.
describe('ECMAScript line terminators terminate comments and continuations', () => {
  for (const [label, terminator, escape] of [
    ['CR', '\r', '\\r'],
    ['U+2028', '\u2028', '\\u2028'],
    ['U+2029', '\u2029', '\\u2029'],
  ]) {
    test(`a line comment ends at ${label} and preserves the following code`, () => {
      const source = `const a = 1; // ${label}-marker${terminator}const b = 2;${terminator}`;
      const stripped = stripJsCommentSpans(source);
      assert.ok(!stripped.includes(`${label}-marker`), `line comment must be stripped up to ${label}`);
      assert.ok(stripped.includes('const b = 2;'), `code after ${label} must survive`);
      assert.equal(stripped.length, source.length);
    });
  }

  test('a CRLF LineContinuation keeps the continued line as string content', () => {
    const source = "const s = 'foo\\\r\n// continued-string-marker';\r\nconst marker = 1;\r\n";
    const stripped = stripJsCommentSpans(source);
    assert.ok(
      stripped.includes('// continued-string-marker'),
      'backslash-CRLF is one continuation; the continued line is string content, not a comment',
    );
    assert.ok(!stripped.includes('const marker = 1;\r\n//'), 'marker line must survive');
    assert.ok(stripped.includes('const marker = 1;'));
    assert.equal(stripped.length, source.length);
  });

  test('a CR-only line resyncs an unterminated quote instead of failing closed', () => {
    const source = "const a = 'plain?\r// cr-resync-marker\rconst b = 3;\r";
    const stripped = stripJsCommentSpans(source);
    assert.ok(!stripped.includes('cr-resync-marker'), 'comment must be stripped');
    assert.ok(stripped.includes('const b = 3;'), 'code after CR must survive');
  });

  // U+2028 / U+2029 are legal RAW characters inside string literals
  // (JSON-superset grammar): they must NOT terminate a quote string, while
  // they DO terminate line comments. Both quote styles, both characters.
  for (const [label, separator] of [
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ]) {
    for (const [quote, name] of [["'", 'single-quoted'], ['"', 'double-quoted']]) {
      test(`a raw ${label} inside a ${name} string stays string content`, () => {
        const source =
          `const s = ${quote}a${separator}// not-a-comment${separator}b${quote};` +
          ` // tail-marker${separator}const m = 1;${separator}`;
        const stripped = stripJsCommentSpans(source);
        assert.ok(
          stripped.includes(`// not-a-comment${separator}b`),
          `raw ${label} and comment-looking content inside the string must survive`,
        );
        assert.ok(!stripped.includes('tail-marker'), 'the real line comment must be stripped');
        assert.ok(stripped.includes('const m = 1;'), 'code after the comment must survive');
        assert.equal(stripped.length, source.length);
      });
    }
  }
});
