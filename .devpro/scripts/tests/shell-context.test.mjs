/**
 * shell-context.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/lib/shell-context.mjs
 * Covers all 15 cases from qa-test-scope.md Section 2.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { segmentCommand, commandSegmentText, scopeIdAt, CMD_POSITION_ANCHOR, LOOSE_CMD_PREFIX, anchoredVerbIndex, maskDataRegions, GIT_GLOBAL_OPT, GIT_GLOBAL_VALUE_OPTIONS } from "../hooks/lib/shell-context.mjs";
import { commandCwd } from "../hooks/lib/hook-command-context.mjs";
import { isGitPushCommand } from "../hooks/lib/release-back-merge-state.mjs";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// ── Case 1: Pure command ──────────────────────────────────────────────────

test("Case 1: pure command — single command segment", () => {
  const segs = segmentCommand("git commit -m foo");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "command");
  assert.equal(segs[0].text, "git commit -m foo");
  assert.deepEqual(segs[0].range, [0, 17]);
});

// ── Case 2: Single quote ─────────────────────────────────────────────────

test("Case 2: single quote — command + quoted-string segments", () => {
  const segs = segmentCommand("echo 'git commit'");
  const kinds = segs.map(s => s.kind);
  assert.ok(kinds.includes("command"), "should have command segment");
  assert.ok(kinds.includes("quoted-string"), "should have quoted-string segment");
  // The quoted-string segment should contain the single-quoted text
  const qs = segs.find(s => s.kind === "quoted-string");
  assert.ok(qs.text.includes("git commit"));
  // commandSegmentText should NOT contain the quoted body
  const cmdText = commandSegmentText("echo 'git commit'");
  assert.ok(!cmdText.includes("git commit"), `commandSegmentText should exclude quoted text, got: ${cmdText}`);
});

// ── Case 3: Double quote ─────────────────────────────────────────────────

test("Case 3: double quote — command + quoted-string segments", () => {
  const segs = segmentCommand('echo "git commit"');
  const kinds = segs.map(s => s.kind);
  assert.ok(kinds.includes("command"));
  assert.ok(kinds.includes("quoted-string"));
  const qs = segs.find(s => s.kind === "quoted-string");
  assert.ok(qs.text.includes("git commit"));
  const cmdText = commandSegmentText('echo "git commit"');
  assert.ok(!cmdText.includes("git commit"), `expected quoted text excluded, got: ${cmdText}`);
});

// ── Case 4: Escaped quote ────────────────────────────────────────────────

test("Case 4: escaped quote inside double quote — 1 quoted-string (no split)", () => {
  // echo "say \"git commit\""
  const cmd = 'echo "say \\"git commit\\""';
  const segs = segmentCommand(cmd);
  const quotedSegs = segs.filter(s => s.kind === "quoted-string");
  // Must be exactly 1 quoted-string segment (escape doesn't split into multiple)
  assert.equal(quotedSegs.length, 1, `expected 1 quoted-string, got ${quotedSegs.length}: ${JSON.stringify(segs)}`);
  // The quoted segment should contain the escaped content
  assert.ok(quotedSegs[0].text.includes("git commit"), "quoted text should contain git commit");
  // commandSegmentText must not contain "git commit"
  const cmdText = commandSegmentText(cmd);
  assert.ok(!cmdText.includes("git commit"), `commandSegmentText should exclude, got: ${cmdText}`);
});

// ── Case 5: Nested single quote in double quote ───────────────────────────

test("Case 5: nested single quote in double quote — whole thing is 1 quoted-string", () => {
  const cmd = `echo "a 'b' c"`;
  const segs = segmentCommand(cmd);
  const quotedSegs = segs.filter(s => s.kind === "quoted-string");
  // single quote inside double quote is literal — still 1 quoted-string
  assert.equal(quotedSegs.length, 1, `expected 1 quoted-string: ${JSON.stringify(segs)}`);
  assert.ok(quotedSegs[0].text.includes("'b'"), "should include inner single quotes");
  const cmdText = commandSegmentText(cmd);
  assert.ok(!cmdText.includes("'b'"), `inner single-quoted text should be excluded, got: ${cmdText}`);
});

// ── Case 6: Heredoc standard ─────────────────────────────────────────────

test("Case 6: heredoc standard <<EOF — command + heredoc-body segments", () => {
  const cmd = "cat <<EOF\ngit commit\nEOF";
  const segs = segmentCommand(cmd);
  const kinds = segs.map(s => s.kind);
  assert.ok(kinds.includes("heredoc-body"), `expected heredoc-body in: ${JSON.stringify(kinds)}`);
  const body = segs.find(s => s.kind === "heredoc-body");
  assert.ok(body.text.includes("git commit"), "body should contain git commit");
  // commandSegmentText must not include the heredoc body
  const cmdText = commandSegmentText(cmd);
  assert.ok(!cmdText.includes("git commit"), `heredoc body should be excluded, got: ${cmdText}`);
});

// ── Case 7: Heredoc quoted tag ───────────────────────────────────────────

test("Case 7: heredoc quoted tag <<'EOF' — command + heredoc-body", () => {
  const cmd = "cat <<'EOF'\ngit commit\nEOF";
  const segs = segmentCommand(cmd);
  const body = segs.find(s => s.kind === "heredoc-body");
  assert.ok(body, `expected heredoc-body in: ${JSON.stringify(segs)}`);
  assert.ok(body.text.includes("git commit"));
  const cmdText = commandSegmentText(cmd);
  assert.ok(!cmdText.includes("git commit"), `heredoc body should be excluded, got: ${cmdText}`);
});

// ── Case 8: Heredoc dash <<-TAG ──────────────────────────────────────────

test("Case 8: heredoc dash <<-EOF — body with leading tab stripped at close", () => {
  const cmd = "cat <<-EOF\n\tgit commit\nEOF";
  const segs = segmentCommand(cmd);
  const body = segs.find(s => s.kind === "heredoc-body");
  assert.ok(body, `expected heredoc-body in: ${JSON.stringify(segs)}`);
  assert.ok(body.text.includes("git commit"), "body should contain git commit");
  const cmdText = commandSegmentText(cmd);
  assert.ok(!cmdText.includes("git commit"), `heredoc body should be excluded, got: ${cmdText}`);
});

// ── Case 9: Subshell $() ─────────────────────────────────────────────────

test("Case 9: subshell $() — inner command promoted (flatten)", () => {
  const cmd = "echo $(git status)";
  const segs = segmentCommand(cmd);
  const kinds = segs.map(s => s.kind);
  assert.ok(kinds.includes("subshell"), `expected subshell kind in: ${JSON.stringify(kinds)}`);
  // inner "git status" should be promoted to command segment
  const commandSegs = segs.filter(s => s.kind === "command");
  const allCommandText = commandSegs.map(s => s.text).join(" ");
  assert.ok(allCommandText.includes("git status"), `inner command should be in command segments: ${allCommandText}`);
});

// ── Case 10: Backtick ────────────────────────────────────────────────────

test("Case 10: backtick subshell — inner command promoted (flatten)", () => {
  const cmd = "echo `git status`";
  const segs = segmentCommand(cmd);
  const kinds = segs.map(s => s.kind);
  assert.ok(kinds.includes("subshell"), `expected subshell kind in: ${JSON.stringify(kinds)}`);
  const commandSegs = segs.filter(s => s.kind === "command");
  const allCommandText = commandSegs.map(s => s.text).join(" ");
  assert.ok(allCommandText.includes("git status"), `inner command should be in command segments: ${allCommandText}`);
});

// ── Case 11: Comment ─────────────────────────────────────────────────────

test("Case 11: comment # — command segment + comment segment", () => {
  const cmd = "git commit # comment with git push";
  const segs = segmentCommand(cmd);
  const kinds = segs.map(s => s.kind);
  assert.ok(kinds.includes("command"), "should have command segment");
  assert.ok(kinds.includes("comment"), "should have comment segment");
  const comment = segs.find(s => s.kind === "comment");
  assert.ok(comment.text.includes("git push"), "comment should contain git push");
  // commandSegmentText must not include the comment text
  const cmdText = commandSegmentText(cmd);
  assert.ok(!cmdText.includes("git push"), `comment should be excluded, got: ${cmdText}`);
  // but the actual command part should still be there
  assert.ok(cmdText.includes("git commit"), `real command should be present, got: ${cmdText}`);
});

// ── Case 12: Real + quoted mixed ─────────────────────────────────────────

test("Case 12: real + quoted mixed — later real git commit in command segment", () => {
  const cmd = 'grep "git commit" file && /usr/bin/git commit -m foo';
  const segs = segmentCommand(cmd);
  // "git commit" in grep arg is a quoted-string
  const quotedSegs = segs.filter(s => s.kind === "quoted-string");
  assert.ok(quotedSegs.length > 0, "should have quoted-string for grep arg");
  // /usr/bin/git commit is real command — must appear in command segments
  const cmdText = commandSegmentText(cmd);
  assert.ok(cmdText.includes("/usr/bin/git commit"), `real git commit should be in command text: ${cmdText}`);
  // The quoted "git commit" should not appear in command segments
  const quotedBody = quotedSegs.map(s => s.text).join("");
  assert.ok(quotedBody.includes("git commit"), "quoted-string should capture grep arg");
});

// ── Case 13: Parser fallback (unbalanced quote) ───────────────────────────

test("Case 13: unbalanced quote — caller fallback to whole cmd as command segment", () => {
  // commandSegmentText must fall back gracefully (not throw)
  // With unbalanced quote, the parser will consume to end-of-string for the quoted seg
  // Either way, commandSegmentText must return a string (not throw)
  const cmd = 'echo "unclosed';
  let result;
  assert.doesNotThrow(() => { result = commandSegmentText(cmd); });
  assert.equal(typeof result, "string");
  // Since the quote is unclosed, parser may treat entire rest as quoted-string
  // OR fall back to whole cmd — either way result must be non-empty
  assert.ok(result.length > 0, "result must be non-empty");
});

// ── Case 14: Empty cmd ───────────────────────────────────────────────────

test("Case 14: empty string — returns empty array or empty string", () => {
  const segs = segmentCommand("");
  // spec says: empty array or single empty segment
  assert.ok(Array.isArray(segs), "must return array");
  // commandSegmentText on empty must not throw and returns string
  let result;
  assert.doesNotThrow(() => { result = commandSegmentText(""); });
  assert.equal(typeof result, "string");
});

// ── Case 15: Heredoc + subsequent command ────────────────────────────────

test("Case 15: heredoc + subsequent command — heredoc-body does not consume echo done", () => {
  const cmd = "cat <<EOF\nbody\nEOF\necho done";
  const segs = segmentCommand(cmd);
  const body = segs.find(s => s.kind === "heredoc-body");
  assert.ok(body, `expected heredoc-body in: ${JSON.stringify(segs)}`);
  // "echo done" after the heredoc close must be a command segment
  const cmdText = commandSegmentText(cmd);
  assert.ok(cmdText.includes("echo done"), `echo done should be in command text: ${cmdText}`);
  // body must NOT include "echo done"
  assert.ok(!body.text.includes("echo done"), `heredoc body must not include echo done: ${body.text}`);
});

// ── Case 16-18: scopeIdAt / scope field (round-9 B2 subshell-provenance) ──

test("Case 16: nested $(...) three levels — each level's content resolves to a distinct scope", () => {
  const cmd = "echo $(cat $(grep FOO $(printf X BAR)))";
  const segs = segmentCommand(cmd);
  const scopeTop = scopeIdAt(cmd.indexOf("echo"), segs);
  const scopeCat = scopeIdAt(cmd.indexOf("cat"), segs);
  const scopeFoo = scopeIdAt(cmd.indexOf("FOO"), segs);
  const scopeBar = scopeIdAt(cmd.indexOf("BAR"), segs);
  assert.equal(scopeTop, null, "top-level command text must resolve to null scope");
  assert.notEqual(scopeCat, null, "level-1 subshell content must have a non-null scope");
  assert.notEqual(scopeFoo, null, "level-2 subshell content must have a non-null scope");
  assert.notEqual(scopeBar, null, "level-3 subshell content must have a non-null scope");
  const levelScopes = [scopeCat, scopeFoo, scopeBar];
  assert.equal(new Set(levelScopes).size, 3, `all 3 nesting levels must have pairwise-distinct scopes, got: ${JSON.stringify(levelScopes)}`);
});

test("Case 17: backtick subshell scope parity with $() — both resolve to distinct non-null scopes", () => {
  const cmd = "echo $(git status) `git diff`";
  const segs = segmentCommand(cmd);
  const scopeDollarParen = scopeIdAt(cmd.indexOf("status"), segs);
  const scopeBacktick = scopeIdAt(cmd.indexOf("diff"), segs);
  const scopeTop = scopeIdAt(cmd.indexOf("echo"), segs);
  assert.equal(scopeTop, null, "top-level command text must resolve to null scope");
  assert.notEqual(scopeDollarParen, null, "$(...) content must have a non-null scope");
  assert.notEqual(scopeBacktick, null, "backtick content must have a non-null scope");
  assert.notEqual(scopeDollarParen, scopeBacktick, "sibling $() and backtick subshells must not share a scope");
});

test("Case 18: scopeIdAt(i, null) — parser-failure fallback signal resolves to null", () => {
  assert.equal(scopeIdAt(0, null), null, "null segs (parser-failure signal) must resolve to null so callers fail closed");
  assert.equal(scopeIdAt(999, null), null, "any matchIndex with null segs must resolve to null");
});

test("Case 19 (CRITICAL repro, round-16): sibling depth-2 nested subshells under DIFFERENT top-level parents must not collide on scope even when their local offsets coincide", () => {
  // Prior to baseOffset threading, a nested $(...)'s scope was stamped from
  // the bare LOCAL index found while parsing its immediate parent's innerText
  // substring — not a position in the original top-level command. "aaaa " and
  // "bbbb " are both exactly 5 chars, so $(FOO) and $(BAR) both open at local
  // offset 5 within their own parent's innerText ("aaaa $(FOO)" / "bbbb
  // $(BAR)"), even though the two $(...) parents themselves sit at very
  // different absolute positions in the command. Pre-fix this produced
  // scopeIdAt(FOO) === scopeIdAt(BAR) === 5 — a false "same execution scope"
  // verdict between two entirely unrelated subshells, which is exactly what
  // gh-footer-gate.mjs's ghInvocationSubcommandAt relies on scope equality to
  // prevent (a `gh` invocation in one subshell must never adopt a flag
  // genuinely nested in a sibling subshell).
  const cmd = "echo $(aaaa $(FOO)) ; echo $(bbbb $(BAR))";
  const segs = segmentCommand(cmd);
  const scopeAaaa = scopeIdAt(cmd.indexOf("aaaa"), segs);
  const scopeBbbb = scopeIdAt(cmd.indexOf("bbbb"), segs);
  const scopeFoo = scopeIdAt(cmd.indexOf("FOO"), segs);
  const scopeBar = scopeIdAt(cmd.indexOf("BAR"), segs);
  assert.notEqual(
    scopeFoo,
    scopeBar,
    `sibling depth-2 subshells under different top-level parents must not collide, got both=${scopeFoo}`
  );
  const allScopes = [scopeAaaa, scopeBbbb, scopeFoo, scopeBar];
  assert.equal(
    new Set(allScopes).size,
    4,
    `all 4 nesting contexts (2 depth-1 + 2 depth-2, across 2 unrelated top-level subshells) must have pairwise-distinct scopes, got: ${JSON.stringify(allScopes)}`
  );
});

// ── CMD_POSITION_ANCHOR: command-position boundary primitive ──────────────
// The shared boundary that precedes git/gh verb matchers. It must match a verb
// only at a real command position, never as a bare argument to another command.
// (See pre-tool-gate.mjs TOKEN_ANCHOR and the Variant-A inlined sites.)

const VERB_RE = new RegExp(CMD_POSITION_ANCHOR + "(?:git|gh)\\s+(?:push|pr)\\b");

// Pre-fix boundary kept inline ONLY for the bidirectional canary below.
const OLD_BOUNDARY =
  "(?:^|[\\s;|&(`])(?:[A-Z_][A-Z0-9_]*=[^\\s'\"$`]*\\s+)*(?:env\\s+(?:[A-Z_][A-Z0-9_]*=[^\\s'\"$`]*\\s+)+)?(?:[^\\s'\"]*\\/)?";
const OLD_VERB_RE = new RegExp(OLD_BOUNDARY + "(?:git|gh)\\s+(?:push|pr)\\b");

// MUST MATCH — verb at a genuine command position (false-negative guard).
for (const cmd of [
  "git push --force",
  "true && git push --force",
  "true ; git push --force",
  "echo x | git push",
  "false || git push --force",
  "true & git push --force",
  "(git push --force)",
  "{ git push --force; }",
  "FOO=1 git push --force",
  "env FOO=1 git push --force",
  "/usr/bin/git push --force",
  "if true; then git push --force; fi",
  "while x; do git push --force; done",
]) {
  test(`CMD_POSITION_ANCHOR matches command position: ${cmd}`, () => {
    assert.ok(VERB_RE.test(cmd), `must match a real command position: ${cmd}`);
  });
}

// MUST NOT MATCH — verb as a bare argument to another command (the FP fix).
for (const cmd of [
  "echo git push --force",
  "printf git push",
  "ls git push",
  "then_branch git push", // `then` only counts as a keyword when followed by whitespace
]) {
  test(`CMD_POSITION_ANCHOR rejects arg position: ${cmd}`, () => {
    assert.ok(!VERB_RE.test(cmd), `must NOT match a verb in argument position: ${cmd}`);
  });
}

// Bidirectional canary — documents the exact behavioral delta and fails loudly
// if CMD_POSITION_ANCHOR is reverted to the bare-`\s` boundary.
test("CMD_POSITION_ANCHOR rejects arg position while keeping real command positions", () => {
  // The old boundary MATCHED the arg form (the bug); the new one does NOT.
  assert.ok(OLD_VERB_RE.test("echo git push"), "sanity: old boundary matched the arg form");
  assert.ok(!VERB_RE.test("echo git push"), "new boundary must reject the arg form");
  // Both still match a genuine command position (the false-negative direction we guard).
  assert.ok(OLD_VERB_RE.test("a && git push"), "old boundary matched real position");
  assert.ok(VERB_RE.test("a && git push"), "new boundary must still match real position");
  // NOTE: this is NOT a formal strict subset — NEW adds `{`/`\n`/`\r` to the
  // separator class, so a non-executable form like `{git push` (one bash token)
  // matches NEW but not OLD. That introduces no real false-positive (it cannot run
  // as a command). The safety guarantee is over NATURAL/EXECUTABLE commands only.
  assert.ok(VERB_RE.test("{git push"), "non-executable `{git` matches NEW (documented, harmless)");
  assert.ok(!OLD_VERB_RE.test("{git push"), "...and not OLD — sets are not strictly subset-related");
});

// ── CMD_POSITION_ANCHOR: quoted environment-value prefixes ────────────────
// `VAR="a b" git push` runs git directly with an extra environment variable, exactly like `VAR=1 git push`. The
// value may be double- or single-quoted (with escapes inside double quotes) and may hold spaces or `$`.

for (const cmd of [
  'FOO="a b" git push --force',
  "FOO='a b' git push --force",
  'FOO="a b" BAR=1 git push --force',
  'BAR=1 FOO="a b" git push --force',
  'env FOO="a b" git push --force',
  'env FOO="a b" BAR=\'c d\' git push --force',
  'true && FOO="a b" git push --force',
  'if true; then FOO="a b" git push --force; fi',
  'FOO="a \\"b\\" c" git push --force',
  'FOO="$HOME/x y" git push --force',
  'FOO="" git push --force',
  'FOO="a b" /usr/bin/git push --force',
]) {
  test(`CMD_POSITION_ANCHOR matches a quoted env-value prefix: ${cmd}`, () => {
    assert.ok(VERB_RE.test(cmd), `must match a real command position behind a quoted env value: ${cmd}`);
  });
}

for (const cmd of [
  'echo FOO="a b" git push --force',
  'FOO="a b" echo git push --force',
  'FOO="a b"git push --force',
  'FOO="unterminated git push --force',
  "FOO='unterminated git push --force",
  'FOO="a b" "git" push --force',
]) {
  test(`CMD_POSITION_ANCHOR still rejects with a quoted env value present: ${cmd}`, () => {
    assert.ok(!VERB_RE.test(cmd), `must NOT match: ${cmd}`);
  });
}

test("CMD_POSITION_ANCHOR keeps consumer capture-group indices with a quoted env value", () => {
  const re = new RegExp(CMD_POSITION_ANCHOR + "(git)\\s+(push)\\b");
  const m = re.exec('FOO="a b" git push');
  assert.ok(m, "must match");
  assert.equal(m[1], "git");
  assert.equal(m[2], "push");
  assert.equal(m.length, 3, "the anchor must not add a capture group");
});

test("CMD_POSITION_ANCHOR stays linear on adversarial quoting", () => {
  const shapes = {
    "many unterminated opens": ';X="'.repeat(4000) + " git push",
    "one long unterminated value": 'X="' + "\\".repeat(40000) + " git push",
    "many quoted assignments, no verb": 'A="b c" '.repeat(5000) + "echo",
    "alternating quotes": "X='\"".repeat(4000) + " git push",
  };
  for (const [label, input] of Object.entries(shapes)) {
    const start = process.hrtime.bigint();
    VERB_RE.test(input);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 1000, `${label}: ${ms.toFixed(0)}ms is not linear`);
  }
});

// The scan classes in the anchor tail (path prefix, bare env value) must stop at a command separator. If they
// can cross `;` `&` `|` `(`, every separator in the text restarts a scan that runs to the end of the string and
// backtracks looking for `/` or whitespace — O(n²) on the segmented view the hook gates run on, where quotes are
// already replaced by `__QUOTED__` and nothing else stops the scan.
test("CMD_POSITION_ANCHOR stays linear on repeated command separators", () => {
  const shapes = {
    "path prefix scan across && separators": "&&a".repeat(24000),
    "bare env value scan across ; separators": ";X=1".repeat(24000),
    "segmented quoted env assignments": ";X=__QUOTED__".repeat(24000),
    "subshell openers": "(a".repeat(24000),
  };
  for (const [label, input] of Object.entries(shapes)) {
    const start = process.hrtime.bigint();
    VERB_RE.test(input);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 1000, `${label}: ${ms.toFixed(0)}ms is not linear`);
  }
});

for (const cmd of [
  "FOO=a;git push --force",
  "FOO=a; git push --force",
  "FOO=a&&git push --force",
  "FOO=a|git push --force",
  "FOO=/x/y git push --force",
  "FOO=a/b;git push --force",
  "${HOME}/bin/git push --force",
  "a;b/git push --force",
  "FOO='a b' /usr/bin/git push --force",
  "echo x; ../bin/git push --force",
]) {
  test(`CMD_POSITION_ANCHOR still matches after separator-bounded scan: ${cmd}`, () => {
    assert.ok(VERB_RE.test(cmd), `must match a real command position: ${cmd}`);
  });
}

// `b` is the command and `git push` is only its argument: an unquoted env value ends at the `;`, so the
// separator-bounded value no longer lets `FOO=a;b` read as one env prefix in front of `git`.
test("CMD_POSITION_ANCHOR does not read FOO=a;b as an env prefix before git", () => {
  assert.ok(!VERB_RE.test("FOO=a;b git push --force"));
});

// ── maskDataRegions: same answers as the per-position lookup it replaces, in one pass ──────────────

// The previous implementation: for every position the first segment containing it decides.
function referenceMask(text, segs, limit = text.length, start = 0) {
  let out = "";
  const end = Math.min(limit, text.length);
  for (let i = start; i < end; i += 1) {
    let data = false;
    if (segs !== null) {
      for (const seg of segs) {
        if (i >= seg.range[0] && i < seg.range[1]) {
          data = seg.kind === "quoted-string" || seg.kind === "heredoc-body" || seg.kind === "comment";
          break;
        }
      }
    }
    out += data ? " " : text[i];
  }
  return out;
}

for (const cmd of [
  "git status",
  'echo "cd /x" && git push',
  "echo 'a b' # cd /y\ngit push",
  "cat <<EOF\ncd /z\nEOF\ngit push",
  "echo $(git branch) `git tag` && git push",
  'A="x y" git commit -m "m" && cd /w',
  "",
]) {
  test(`maskDataRegions matches the per-position lookup: ${JSON.stringify(cmd)}`, () => {
    const segs = segmentCommand(cmd);
    assert.equal(maskDataRegions(cmd, segs), referenceMask(cmd, segs));
    for (const [limit, start] of [[cmd.length >> 1, 0], [cmd.length, cmd.length >> 2], [cmd.length + 50, 0], [3, 5]]) {
      assert.equal(maskDataRegions(cmd, segs, limit, start), referenceMask(cmd, segs, limit, start), `limit=${limit} start=${start}`);
    }
  });
}

test("maskDataRegions: the first overlapping segment wins and null segments mask nothing", () => {
  const text = "abcdefghij";
  const overlap = [
    { kind: "command", range: [2, 5] },
    { kind: "quoted-string", range: [0, 8] },
  ];
  assert.equal(maskDataRegions(text, overlap), referenceMask(text, overlap));
  assert.equal(maskDataRegions(text, overlap), "  cde   ij");
  assert.equal(maskDataRegions(text, null), text);
  assert.equal(maskDataRegions(text, undefined), text);
});

test("maskDataRegions stays linear with thousands of quoted strings", () => {
  const cmd = 'echo "a b" '.repeat(20000) + "git push";
  const segs = segmentCommand(cmd);
  const start = process.hrtime.bigint();
  const masked = maskDataRegions(cmd, segs);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(masked.length, cmd.length);
  assert.ok(masked.endsWith("git push"));
  assert.ok(ms < 1000, `${ms.toFixed(0)}ms is not linear`);
});

// ── Dynamic environment values in front of a command ─────────────────────

const GH_PR_CREATE = new RegExp(`${CMD_POSITION_ANCHOR}gh\\s+pr\\s+create\\b`);
const GIT_PUSH = new RegExp(`${CMD_POSITION_ANCHOR}git\\s+push\\b`);

const DYNAMIC_PREFIXES = [
  "GH_TOKEN=$(echo token) ",
  "GH_TOKEN=$(gh auth token) ",
  "GH_TOKEN=$(printf '%s' x; echo y) ",
  "GH_TOKEN=`echo token` ",
  "GH_TOKEN=$TOKEN ",
  "GH_TOKEN=${TOKEN} ",
  "GH_TOKEN=abc$TOKEN$(echo x)def ",
  "A=$(echo a) B=$(echo b) ",
  "env GH_TOKEN=$(echo token) ",
  "cd /tmp && GH_TOKEN=$(echo token) ",
];

test("the anchor locates a command behind a dynamic environment value", () => {
  for (const prefix of DYNAMIC_PREFIXES) {
    const cmd = `${prefix}gh pr create --fill`;
    const match = GH_PR_CREATE.exec(cmd);
    assert.ok(match, `raw text: ${cmd}`);
    assert.equal(anchoredVerbIndex(match), prefix.length, `verb position: ${cmd}`);
  }
});

test("the command text keeps a command behind a dynamic environment value at command position", () => {
  for (const prefix of DYNAMIC_PREFIXES) {
    const cmd = `${prefix}gh pr create --fill`;
    assert.ok(GH_PR_CREATE.test(commandSegmentText(cmd)), `${cmd} → ${commandSegmentText(cmd)}`);
  }
});

test("a substituted word in argument position does not become a command", () => {
  for (const cmd of [
    "echo FOO=$(date) git push",
    "echo $(date) git push",
    "printf %s FOO=$BAR git push",
    "echo FOO=$(date)x git push",
  ]) {
    assert.equal(GIT_PUSH.test(cmd), false, `raw text: ${cmd}`);
    assert.equal(GIT_PUSH.test(commandSegmentText(cmd)), false, `${cmd} → ${commandSegmentText(cmd)}`);
  }
  // The raw anchor reads a closing backtick as a boundary, as it did before dynamic values; only the command text
  // leaves a backtick value in argument position.
  const cmd = "echo FOO=`date` git push";
  assert.equal(GIT_PUSH.test(cmd), true, "raw anchor");
  assert.equal(GIT_PUSH.test(commandSegmentText(cmd)), false, commandSegmentText(cmd));
});

test("the command text of a quoted environment value stays as it was", () => {
  assert.equal(commandSegmentText('A="x" git push'), "A=__QUOTED__ git push");
});

test("a long command cut by the prefix window does not read its cut edge as a command start", () => {
  // Whatever the alignment, one of these cuts lands exactly on an assignment that is really an echo argument.
  for (const padding of ["", "x", "xx", "xxx"]) {
    const cmd = `echo ${padding} ${"A=1 ".repeat(400)}FOO=$(date) git push`;
    assert.equal(GIT_PUSH.test(commandSegmentText(cmd)), false, `padding ${padding.length}`);
  }
});

test("a command substituted into an environment value stays visible", () => {
  for (const cmd of ["X=$(git push origin main)", "X=$(git push origin main) git status", "X=`git push origin main` git status"]) {
    const match = GIT_PUSH.exec(cmd);
    assert.ok(match, cmd);
    assert.equal(anchoredVerbIndex(match), cmd.indexOf("git push"), cmd);
  }
});

test("a nested command substitution in an environment value is not located", () => {
  const cmd = "GH_TOKEN=$(echo $(cat token)) gh pr create --fill";
  assert.equal(GH_PR_CREATE.test(cmd), false);
  assert.equal(GH_PR_CREATE.test(commandSegmentText(cmd)), false);
});

test("incomplete command substitutions preserve the whole input as command data", () => {
  for (const cmd of ['A=$(echo "git push"', 'echo $(echo $(git push', 'A=$(x '.repeat(20000)]) {
    assert.deepEqual(segmentCommand(cmd), [
      { kind: "command", text: cmd, range: [0, cmd.length], scope: null },
    ]);
    assert.equal(commandSegmentText(cmd), cmd);
  }
});

test("dynamic environment values keep matching linear on long commands", () => {
  for (const cmd of [
    "A=$(x ".repeat(20000),
    "A=`x ".repeat(20000),
    `A=$${"x".repeat(5000)}`.repeat(40) + " echo",
    "A=$(x) ".repeat(20000) + "echo",
  ]) {
    const start = process.hrtime.bigint();
    GIT_PUSH.test(cmd);
    commandSegmentText(cmd);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 3000, `${ms.toFixed(0)}ms is not linear for ${cmd.slice(0, 20)}…`);
  }
});

// Matchers looser than the anchor (a verb after any whitespace counts) read an env prefix and a path prefix in front of
// `git`/`gh` through LOOSE_CMD_PREFIX and must stay linear too. With a value class that crossed separators (`=\S*`,
// `\S*\/`), each separator restarted a scan to the end of the string (~3 s of CPU for `;X=1` repeated 16000 times), and
// with every whitespace a start of its own, so did each space in `A=1 A=1 …` — and each later whitespace of a longer
// run between assignments (`A=1  A=1  …`, a tab, CRLF). CPU time, not wall time, so a busy machine does not fail these.
const LONG_SEPARATOR_SHAPES = {
  "bare env assignments": ";X=1".repeat(16000),
  "space-separated env assignments": "A=1 ".repeat(16000),
  "env assignments separated by two spaces": "A=1  ".repeat(16000),
  "env assignments separated by a space and a tab": "A=1 \t".repeat(16000),
  "env assignments separated by CRLF": "A=1\r\n".repeat(16000),
  "one long whitespace run after an env assignment": "A=1" + " ".repeat(64000),
  "env assignments with a path value": "X=a/ ".repeat(16000),
  "&& separators": "&&a".repeat(16000),
  "subshell openers": "(a".repeat(16000),
  "quoted env assignments": ';X="a b"'.repeat(16000),
};
function cpuMs(fn) {
  const start = process.cpuUsage();
  fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

test("LOOSE_CMD_PREFIX keeps a whitespace-boundary verb matcher linear on repeated separators", () => {
  const re = new RegExp(`${LOOSE_CMD_PREFIX}(git|gh)\\s+push\\b`, "g");
  for (const [label, prefix] of Object.entries(LONG_SEPARATOR_SHAPES)) {
    const cmd = `${prefix} ; git push`;
    let matches = 0;
    const ms = cpuMs(() => { matches = [...cmd.matchAll(re)].length; });
    assert.equal(matches, 1, `${label}: the trailing git push is still found`);
    assert.ok(ms < 500, `${label}: ${ms.toFixed(0)} ms of CPU is not linear`);
  }
});

test("commandCwd and isGitPushCommand stay linear on repeated separators", () => {
  for (const [label, prefix] of Object.entries(LONG_SEPARATOR_SHAPES)) {
    const cmd = `${prefix} ; git -C /tmp push`;
    let cwd = null;
    let push = false;
    const ms = cpuMs(() => { cwd = commandCwd(cmd, "/base"); push = isGitPushCommand(cmd); });
    assert.equal(push, true, `${label}: the trailing git push is still found`);
    assert.ok(typeof cwd === "string" && cwd.length > 0, `${label}: a cwd is still resolved`);
    assert.ok(ms < 1000, `${label}: ${ms.toFixed(0)} ms of CPU is not linear`);
  }
});

// Spec "Long Separator-Heavy Command Is Judged In Linear Time": `FOO=a;b git push` does not read `FOO=a;b` as an env
// prefix, while `FOO=a;git push` and `${HOME}/bin/git push` still match. A `;|&(` ends a value, so a verb right after
// one is found where the shell runs it: `MSG="done; git push"` sets a variable (the push sits inside its quotes), and
// `A=;git B=1 git -C /x status` runs the first git in the current directory.
test("LOOSE_CMD_PREFIX: a separator ends an env value or a path, everything else reads as before", () => {
  const start = (cmd) => new RegExp(`${LOOSE_CMD_PREFIX}git\\s+push\\b`).exec(cmd)?.index ?? null;
  assert.equal(start("FOO=a;b git push"), 7, "FOO=a;b is not an env prefix; the match starts at the space before git");
  assert.equal(start("FOO=1 BAR=2 git push"), 0, "a run of env assignments still belongs to the match");
  assert.equal(isGitPushCommand("FOO=a;git push"), true);
  assert.equal(isGitPushCommand("${HOME}/bin/git push --force"), true);
  assert.equal(isGitPushCommand('MSG="done; git push"'), false);
  assert.equal(commandCwd("A=;git B=1 git -C /x status", "/base"), "/base");
  assert.equal(commandCwd("FOO=1 git -C /x status", "/base"), commandCwd("git -C /x status", "/base"));
});

test("no hook keeps the unanchored env prefix that crosses separators", () => {
  // The quadratic form is an env value `=\S*` (or a path prefix `\S*\/`) in a matcher that can start at every
  // separator. A `^`-anchored matcher tries one start only and stays linear, so it may keep the old grammar.
  const hooksDir = path.resolve(import.meta.dirname, "../hooks");
  const files = [
    ...readdirSync(hooksDir).filter((f) => f.endsWith(".mjs")).map((f) => path.join(hooksDir, f)),
    ...readdirSync(path.join(hooksDir, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => path.join(hooksDir, "lib", f)),
  ];
  const oldPrefix = "(?:[A-Z_][A-Z0-9_]*=\\\\S*\\\\s+)*";
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (let i = source.indexOf(oldPrefix); i !== -1; i = source.indexOf(oldPrefix, i + 1)) {
      if (source[i - 1] !== "^") offenders.push(`${path.relative(hooksDir, file)}:${source.slice(0, i).split("\n").length}`);
    }
  }
  assert.deepEqual(offenders, [], "use LOOSE_CMD_PREFIX from lib/shell-context.mjs in unanchored matchers");
});

test("GIT_GLOBAL_VALUE_OPTIONS stays in lockstep with the GIT_GLOBAL_OPT grammar", () => {
  // Both directions matter: the argv-level walk (`hasExplicitGitCFlag`) consumes the
  // exported array, while every regex matcher consumes the grammar. Drift in either
  // carrier makes the argv walk read an option value as the verb and misreport `gitC`,
  // which flips a Codex fallback-only decision.
  const valueArm = GIT_GLOBAL_OPT.slice(0, GIT_GLOBAL_OPT.indexOf("|--[A-Za-z]"));
  const fromGrammar = new Set((valueArm.match(/-{1,2}[A-Za-z][\w-]*/gu) || []));
  const fromArray = new Set(GIT_GLOBAL_VALUE_OPTIONS);
  assert.deepEqual(
    [...fromGrammar].sort(),
    [...fromArray].sort(),
    "GIT_GLOBAL_VALUE_OPTIONS and the GIT_GLOBAL_OPT value arm must name the same options"
  );
});

// PR #3703 r11 W2-F4: a digit after `$` has one parse, so a long run of positional parameters in an assignment value
// in front of a non-matching command is judged in bounded time.
test("CMD_POSITION_ANCHOR: a long run of positional parameters before a non-matching verb stays fast", () => {
  const re = new RegExp(`${CMD_POSITION_ANCHOR}git\\s+push\\b`);
  for (const n of [16, 22, 26]) {
    const command = `A=${"$1".repeat(n)}x git status`;
    const started = process.hrtime.bigint();
    assert.equal(re.test(command), false);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 200, `n=${n} took ${ms}ms`);
  }
  // Positional parameters and names in a value still keep the command after them at command position.
  for (const command of ["A=$1 git push", "A=$12 git push", "A=$HOME git push", "A=$_x$1 git push"]) {
    assert.ok(re.test(command), command);
  }
});
