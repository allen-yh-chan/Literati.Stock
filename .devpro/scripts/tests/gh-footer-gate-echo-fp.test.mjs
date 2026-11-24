/**
 * gh-footer-gate-echo-fp.test.mjs
 *
 * Regression: isGhWriteBack used a boundary of `[\s;|&]` before `gh`, which
 * matches `gh` sitting as an ARGUMENT to a non-executing prefix word
 * (`echo gh pr create --body-file x`, `grep -n "gh ... --body"`), wrongly
 * treating a discussion/echo/search command as a real gh write-back and
 * fail-closed blocking it (footer-missing / body-file-read-failed). The gate
 * must fire only when `gh` is the command in COMMAND POSITION (statement
 * start, or after a real connector ; && || | newline), optionally prefixed by
 * `env VAR=x` or a path — not after an arbitrary word like `echo`.
 *
 * Threat model (code-review-checklist §Scope caveat): false-positive on a
 * NATURAL command is the defect to fix; real gh write-backs must still gate.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { evaluateGhFooterGate } from "../hooks/gh-footer-gate.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/gh-footer-gate.mjs"
);

function runFull(command) {
  let stdout = "";
  let stderr = "";
  const status = evaluateGhFooterGate({
    rawInput: JSON.stringify({ tool_input: { command } }),
    env: { ...process.env, CODEX_CI: "", CODEX_THREAD_ID: "" },
    writeStdout: (chunk) => { stdout += chunk; },
    writeStderr: (chunk) => { stderr += chunk; },
  });
  return { status, stdout, stderr };
}

function run(command) {
  return runFull(command).status;
}

// ── False positives that MUST pass through (exit 0) ──────────────────────────

test("echo discussing a gh write command → exit 0 (not a write-back)", () => {
  assert.equal(run("echo gh pr create --body-file foo.md"), 0);
});

test("printf discussing gh --body → exit 0", () => {
  assert.equal(run('printf "run: gh issue create --body x"'), 0);
});

test("grep search string containing gh ... --body → exit 0", () => {
  assert.equal(run('grep -n "gh issue create --body x" file'), 0);
});

test("comment line starting with # gh ... --body-file → exit 0", () => {
  assert.equal(run("# gh pr comment 1 --body-file note.md"), 0);
});

test("node body-staging command mentioning --body-file → exit 0", () => {
  assert.equal(
    run('node -e \'require("node:fs").writeFileSync("/tmp/body.md", "Example: gh pr create --body-file /tmp/missing.md")\''),
    0
  );
});

// ── Real gh write-backs that MUST still gate (block when footer missing) ─────

test("gh pr create --body without footer → still blocks (exit 1)", () => {
  assert.equal(run('gh pr create --body "no footer here"'), 1);
});

test("gh after && connector with --body, no footer → still blocks (exit 1)", () => {
  assert.equal(run('git push && gh pr create --body "no footer"'), 1);
});

test("env-prefixed gh write-back, no footer → still blocks (exit 1)", () => {
  assert.equal(run('env GH_TOKEN=x gh issue create --body "no footer"'), 1);
});

test("path-prefixed gh write-back, no footer → still blocks (exit 1)", () => {
  assert.equal(run('/usr/bin/gh pr create --body "no footer"'), 1);
});

// Real write-backs in compound/keyword/grouping contexts MUST still gate —
// narrowing the boundary must not leak these (review Critical regression set).

test("bare inline env assignment GH_TOKEN=x gh ... --body, no footer → blocks (exit 1)", () => {
  assert.equal(run('GH_TOKEN=x gh pr create --body "no footer"'), 1);
});

test("multi-var env A=1 B=2 gh ... --body, no footer → blocks (exit 1)", () => {
  assert.equal(run('env A=1 B=2 gh pr create --body "no footer"'), 1);
});

test("if ...; then gh ... --body, no footer → blocks (exit 1)", () => {
  assert.equal(run('if true; then gh pr comment 1 --body "no footer"; fi'), 1);
});

test("for loop do gh ... --body, no footer → blocks (exit 1)", () => {
  assert.equal(run('for n in 1 2; do gh issue comment $n --body "no footer"; done'), 1);
});

test("brace group { gh ... --body; }, no footer → blocks (exit 1)", () => {
  assert.equal(run('{ gh pr create --body "no footer"; }'), 1);
});

test("backtick command substitution `gh ... --body`, no footer → blocks (exit 1)", () => {
  assert.equal(run('`gh pr create --body "no footer"`'), 1);
});

test("quoted env-value prefix before gh ... --body, no footer → blocks (exit 1)", () => {
  assert.equal(run('FOO="a b" gh pr create --body "no footer"'), 1);
  assert.equal(run("FOO='a b' gh pr comment 1 --body \"no footer\""), 1);
  assert.equal(run('env FOO="a b" gh issue create --body "no footer"'), 1);
});

test("quoted env-value prefix after an echo is still an argument → exit 0", () => {
  assert.equal(run('echo FOO="a b" gh pr create --body "no footer"'), 0);
});

// Residual non-natural forms: SSOT CMD_POSITION_ANCHOR does NOT treat `gh`
// inside `sh -c "..."` (quoted) or after `xargs` as command position — these
// are documented limitations (shell-context.mjs threat-model note), shared with
// pre-tool-gate.mjs. Asserting current (SSOT-aligned) behaviour so the gate
// stays consistent with the canonical anchor rather than diverging.
test("sh -c \"gh ... --body\" — SSOT-residual, pass-through (exit 0)", () => {
  assert.equal(run('sh -c "gh pr create --body x"'), 0);
});

// ── Body-file path argument boundary ────────────────────────────────────────
// Second false-positive family in this hook, same threat model as above: here
// `gh` IS in command position, but the body-file path patterns captured with
// `\S+`, which swallows a shell metacharacter DIRECTLY ADJACENT to the path (no
// intervening whitespace) into the captured path. safeRead then resolved a path
// that cannot exist, and because this gate is FAIL-CLOSED on read failure, a
// legitimate write-back was hard-blocked. Observed 2026-08-01 on
// `gh pr edit <n> --body-file <abs>; echo "exit=$?"`. Whitespace-separated
// connectors (`<path> && echo`) were never affected — `\S+` already stops at the
// space — so every repro below uses the adjacent form. The same `\S+` shape lived
// at three sites — --body-file, --notes-file, and the bare -F/--field body=@
// branch — so the regression set covers all three plus both fail-closed
// backstops (missing file, missing footer) to prove the narrowing restored
// extraction rather than disabling the gate.

const FOOTER = "Rules: v6.16.0 · Tool: claude-code · Model: claude-sonnet";

// Fixtures live in a per-run mkdtemp directory that is removed afterwards. Fixed
// names directly under os.tmpdir() collide when tiers run concurrently.
const FIXTURE_DIR = makeTempDir("gh-footer-gate-pathboundary-");
after(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

function fixture(name, content) {
  const p = path.join(FIXTURE_DIR, name);
  writeFileSync(p, content);
  return p;
}

test("--body-file <path> followed by `; echo` → exit 0 (path must not swallow the `;`)", () => {
  const body = fixture("body.md", `PR body\n${FOOTER}`);
  assert.equal(run(`gh pr edit 1 --body-file ${body}; echo "exit=$?"`), 0);
});

test("--notes-file <path> followed by `; echo` → exit 0", () => {
  const notes = fixture("notes.md", `release notes\n${FOOTER}`);
  assert.equal(run(`gh release create v1.0 --notes-file ${notes}; echo "exit=$?"`), 0);
});

test("--body-file <path> ` && echo` (whitespace-separated) → exit 0 both before and after the fix", () => {
  const body = fixture("spaced.md", `PR body\n${FOOTER}`);
  assert.equal(run(`gh pr edit 1 --body-file ${body} && echo done`), 0);
});

test("-F body=@<path> followed by `; echo` → exit 0", () => {
  const comment = fixture("comment.md", `comment\n${FOOTER}`);
  assert.equal(
    run(`gh api repos/o/r/issues/1/comments -F body=@${comment}; echo "exit=$?"`),
    0
  );
});

test("--body-file <missing> followed by `; echo` → still fails closed (exit 1)", () => {
  const r = runFull(
    'gh pr edit 1 --body-file /tmp/nonexistent-gh-footer-pathboundary.md; echo "exit=$?"'
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("--body-file <path without footer> followed by `; echo` → still blocks on footer (exit 1)", () => {
  const noFooter = fixture("nofooter.md", "PR body with no footer at all\n");
  const r = runFull(`gh pr edit 1 --body-file ${noFooter}; echo "exit=$?"`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("quoted --body-file path containing a space is read (accept surface widened)", () => {
  const spaced = fixture("with space.md", `PR body\n${FOOTER}`);
  assert.equal(run(`gh pr edit 1 --body-file "${spaced}"`), 0);
});

test("-F body=@<oversized> still fails closed on the 1MB cap", () => {
  const huge = fixture("huge.md", `${"x".repeat(1024 * 1024 + 16)}\n${FOOTER}`);
  const r = runFull(`gh api repos/o/r/issues/1/comments -F body=@${huge}`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

// ── Unextractable body-file argument must fail closed ───────────────────────
// `BODY_PATH_ARG` deliberately refuses to cross a shell metacharacter, so an
// argument that STARTS with one makes the WHOLE flag pattern fail to match — not
// just capture less. That must fail closed, because a body source which silently
// vanishes is worse than one that over-captures: paired with a second `--body`
// carrying a valid footer, the dropped source sails through completely unaudited
// — footer check, attribution brand-marker scan, everything. Verified 2026-08-02
// against a body carrying `Co-Authored-By: Claude`: reachable through a plain
// path it blocks, so the block must not disappear just because the argument
// shape changed. This is the same strict-mix bypass the D3 note in the hook
// already names, reached through a different door.

const FOOTER_ARG = `--body "text ${FOOTER}"`;

test("--body-file argument starting with a metacharacter → fails closed (exit 1)", () => {
  const r = runFull(`gh pr edit 1 ${FOOTER_ARG} --body-file <(cat /etc/hosts)`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("--notes-file argument starting with a metacharacter → fails closed (exit 1)", () => {
  const r = runFull(`gh release create v1 ${FOOTER_ARG} --notes-file <(cat /etc/hosts)`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("-F body=@ argument starting with a metacharacter → fails closed (exit 1)", () => {
  const r = runFull(
    `gh api repos/o/r/issues/1/comments ${FOOTER_ARG} -F body=@<(cat /etc/hosts)`
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

// …and the backstop is scoped per flag OCCURRENCE, not per command. Which
// occurrence of a repeated flag `gh` actually sends is an argument-parsing detail
// this gate does not assume: under first-wins the unextractable one is sent, under
// last-wins the extractable one is. Only per-occurrence fail-closed is correct in
// both worlds, so BOTH orderings block. Locked in both directions so a later
// "relax the backstop, gh takes the last one anyway" edit has to confront the
// assumption it would be making.
// The two orderings are NOT the same delta, measured against the pre-narrowing
// hook rather than recalled: unextractable-first already blocked there (`\S+`
// captured the metacharacter prefix and safeRead threw), while extractable-first
// exited 0, because only the first match was ever read — so the second test below
// locks a NEW block that closes a body source which previously reached `gh`
// entirely unscanned.
test("unextractable FIRST occurrence + extractable later one → fails closed (exit 1)", () => {
  const p = fixture("dup-first-unextractable.md", `body\n\n${FOOTER}\n`);
  const r = runFull(`gh pr edit 1 --body-file <(cat /etc/hosts) --body-file ${p}`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("extractable first occurrence + unextractable LATER one → fails closed (exit 1)", () => {
  const p = fixture("dup-later-unextractable.md", `body\n\n${FOOTER}\n`);
  const r = runFull(`gh pr edit 1 --body-file ${p} --body-file <(cat /etc/hosts)`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

// The backstop must not turn a well-formed payload into a block: two separate gh
// commands chained with `&&` legitimately carry one body-file flag each, and both
// arguments extract cleanly. Only occurrences that yield nothing may fail closed.
test("two chained gh commands, both body-file args extractable → exit 0", () => {
  const a = fixture("chained-a.md", `body a\n\n${FOOTER}\n`);
  const b = fixture("chained-b.md", `body b\n\n${FOOTER}\n`);
  assert.equal(run(`gh pr edit 1 --body-file ${a} && gh pr comment 2 --body-file ${b}`), 0);
});

// The presence pattern the backstop scans with is looser than the extraction
// pattern, and under the per-occurrence scope any presence match that does not
// extract now hard-blocks. So command-segment filtering is load-bearing for the
// backstop in a way it was not for the old per-command one, where a spurious
// data-position match was harmless as long as extraction succeeded somewhere.
// A body-file flag quoted inside a `--body` argument is DATA, not a body source.
test("body-file flag appearing only as data does not trip the per-occurrence backstop", () => {
  const p = fixture("data-mention.md", `body\n\n${FOOTER}\n`);
  assert.equal(
    run(`gh pr comment 1 --body-file ${p} --body "see --body-file <(cat /etc/hosts) ${FOOTER}"`),
    0
  );
});

// Command-segment filtering only rescues the QUOTED data position. A body-file
// flag also has to start a shell TOKEN to be a flag: an unanchored presence scan
// matches the literal substring inside a bare path token (`--body-file
// /tmp/a--body-file=frag.md`), while extraction consumes that whole token in ONE
// match at the outer offset — so the inner presence hit has no same-offset
// extraction partner and the per-occurrence backstop hard-blocks a legitimate
// write-back. Measured against dae192ee: 0 → 1 on --body-file and --notes-file
// (the `-F body=@` surface is immune by shape — `-F` and `body=@` are separated by
// whitespace, which a bare token cannot contain), restored to 0 by the shared
// token-start anchor. Found by cross-model second opinion on PR #1883.
test("bare --body-file path containing the literal flag substring is read (exit 0)", () => {
  const p = fixture("a--body-file=fragment.md", `body\n\n${FOOTER}\n`);
  assert.equal(run(`gh pr edit 1 --body-file ${p}`), 0);
});

test("bare --notes-file path containing the literal flag substring is read (exit 0)", () => {
  const p = fixture("a--notes-file=fragment.md", `notes\n\n${FOOTER}\n`);
  assert.equal(run(`gh release create v1 --notes-file ${p}`), 0);
});

test("--body-file=<path containing the literal flag substring> is read (exit 0)", () => {
  const p = fixture("b--body-file=fragment.md", `body\n\n${FOOTER}\n`);
  assert.equal(run(`gh pr edit 1 --body-file=${p}`), 0);
});

// The anchor must not soften the per-occurrence backstop: a metacharacter DOES end
// a shell token, so a flag occurrence sitting right after one is a real occurrence
// and still has to fail closed when nothing extracts.
test("unextractable occurrence directly after a `;` still fails closed (exit 1)", () => {
  const p = fixture("semi-anchored.md", `body\n\n${FOOTER}\n`);
  const r = runFull(`gh pr edit 1 --body-file ${p};--body-file=<(cat /etc/hosts)`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

// The collision is cross-surface: it was the --body-file surface's presence
// pattern, not the -F surface's own, that matched inside this path token. Measured
// across three generations (anchor dae192ee / pre-fix 17fb0963 / here): 1 / 1 / 0.
// So this one is not a regression THIS PR introduced — it is a false block that
// predates it and the same anchor removes.
test("-F body=@ path containing the literal --body-file substring is read (exit 0)", () => {
  const p = fixture("c--body-file=fragment.md", `body\n\n${FOOTER}\n`);
  assert.equal(run(`gh api repos/o/r/issues/1/comments -F body=@${p}`), 0);
});

// The accept-surface widening above is only defensible if the real body is still
// audited on every widened surface. These four are the evidence that the anchor
// changed WHICH literals count as an occurrence and nothing about how the actual
// body source is checked — a colliding path whose body lacks the footer still
// blocks. If any of these ever exits 0, that is a gate regression, not a further
// false-positive fix.
test("colliding --body-file path whose body lacks the footer still blocks (exit 1)", () => {
  const p = fixture("d--body-file=fragment.md", "body with no footer\n");
  const r = runFull(`gh pr edit 1 --body-file ${p}`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("colliding --notes-file path whose body lacks the footer still blocks (exit 1)", () => {
  const p = fixture("d--notes-file=fragment.md", "notes with no footer\n");
  const r = runFull(`gh release create v1 --notes-file ${p}`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("colliding -F body=@ path whose body lacks the footer still blocks (exit 1)", () => {
  const p = fixture("e--body-file=fragment.md", "body with no footer\n");
  const r = runFull(`gh api repos/o/r/issues/1/comments -F body=@${p}`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Footer missing/);
});

test("footerless body plus a colliding literal in an unrelated flag still blocks (exit 1)", () => {
  const body = fixture("unrelated-body.md", "body with no footer\n");
  const other = fixture("f--body-file=fragment.md", `ignored\n\n${FOOTER}\n`);
  const r = runFull(`gh api repos/o/r/issues -F body=@${body} -F title=@${other}`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Footer missing/);
});

// `(`, `)` and `}` are in the token-start separator set; `{` deliberately is not.
// `}` is in it for a different reason than the brace group below — it is the tail
// of `${EMPTY}`, an expansion that elides to nothing (see ELIDING_PREFIXES). `{`
// buys nothing either way, because the separator that actually ends the token in a
// brace group is the `;`. Both shapes measured at exit 1 on a throwaway repro
// before being written down here — never inferred from the spec text they lock.
test("unextractable occurrence inside a subshell still fails closed (exit 1)", () => {
  const p = fixture("subshell-anchored.md", `body\n\n${FOOTER}\n`);
  const r = runFull(`(gh pr edit 1 --body-file ${p};--body-file=<(cat /etc/hosts))`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("unextractable occurrence inside a brace group still fails closed (exit 1)", () => {
  const p = fixture("brace-anchored.md", `body\n\n${FOOTER}\n`);
  const r = runFull(`{ gh pr edit 1 --body-file ${p};--body-file=<(cat /etc/hosts); }`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

// ── Eliding prefixes: the token-start anchor's second character group ───────
// A shell word can START with characters that vanish before argv is built. Each
// prefix below concatenates directly onto the flag and elides to nothing, so bash
// still hands `gh` the bare `--body-file` — a real occurrence by every measure
// that matters. The first cut of FLAG_TOKEN_START listed only characters that END
// a word, so it refused to see a token start here and the flag matched nothing at
// all: not the extraction pattern, and not the presence pattern either, which is
// what makes this a fail-OPEN rather than a false block. With a companion `--body`
// carrying a valid footer the gate read that clean inline body, passed the
// payload, and never opened the file body at all.
//
// The missing path is the discriminator on purpose. It separates "was the source
// read" from "did the source pass": a read that never happens cannot fail closed,
// so exit 0 here means the body source was dropped, not that it was audited and
// approved. Measured across the anchored pre-fix generation and this one: 0 / 1 on
// all fifteen rows. All three surfaces are covered because they share one anchor
// constant — a per-surface regression would otherwise hide behind the two that
// still pass.
const ELIDING_PREFIXES = [
  ["backtick command substitution", "`true`"],
  ["empty parameter expansion", "${EMPTY}"],
  ["empty single-quote pair", "''"],
  ["empty double-quote pair", '""'],
  ["escaped leading dash", "\\"],
];

const MISSING_PATH = path.join(FIXTURE_DIR, "never-created.md");

const ELIDING_SURFACES = [
  ["--body-file", (prefix) => `gh pr edit 1 ${FOOTER_ARG} ${prefix}--body-file ${MISSING_PATH}`],
  [
    "--notes-file",
    (prefix) => `gh release create v1 ${FOOTER_ARG} ${prefix}--notes-file ${MISSING_PATH}`,
  ],
  [
    "-F body=@",
    (prefix) => `gh api repos/o/r/issues ${FOOTER_ARG} ${prefix}-F body=@${MISSING_PATH}`,
  ],
];

// The five prefixes above all END in a character bash never allows inside a bare
// word, which is why a one-character lookbehind could be taught to recognise them.
// The six below end in an ordinary word character — `$EMPTY` ends in `Y`, exactly
// like `notes/c` does — so NO single-character lookbehind can tell them apart, in
// either polarity. Enumerating characters was therefore not merely incomplete, it
// was unfixable by enumeration: `!`, `*` and `@` would have bought `$!`/`$*`/`$@`
// and left `$EMPTY` and `$(true)$EMPTY` open for a fourth round. The anchor has to
// match the eliding RUN, not its final character.
//
// argv is the ground truth and was measured, not reasoned: with EMPTY unset,
// `printf '[%s]\n' <prefix>--body-file` prints exactly `[--body-file]` for every
// row here (and for the five above). Where a construct can also be non-empty —
// `$!` inside a shell with a background job, `$(true)` if it printed something —
// bash concatenates instead of eliding and the payload is not a body-file flag at
// all. The anchor still counts it as an occurrence, which is over-detection in the
// fail-closed direction: the gate reads and audits a file it did not have to.
// That is the correct way to be wrong here.
const ELIDING_RUN_PREFIXES = [
  ["unbraced parameter expansion", "$EMPTY"],
  ["positional-parameter expansion", "$@"],
  ["star expansion", "$*"],
  ["last-background-pid expansion", "$!"],
  ["two chained unset expansions", "$UNSET$UNSET"],
  ["command substitution followed by expansion", "$(true)$EMPTY"],
  // Added a round later, and found by measurement rather than by another pass of
  // reading the regex: the run listed empty `''` and `""` but not the `$`-prefixed
  // forms, so `$''` (ANSI-C quoting) and `$""` (locale translation) fell out of it
  // even though bash elides them identically. `${X:-${Y}}` fell out for a different
  // reason — the braced alternative excluded inner braces outright, so ONE level of
  // nesting broke it. All three were 1 -> 0 against dae192ee on all three surfaces.
  // These are families, not characters: `$'` and `$"` are the complete set of
  // quote-introducing dollar forms bash defines, so closing them is not another
  // round of the enumeration that R8 proved non-convergent. Nesting is the part
  // that stays open, and it stays open with a precise name — see the residual note
  // at the constant.
  ["ansi-c empty quote pair", "$''"],
  ["locale-translation empty quote pair", '$""'],
  ["one nesting level in parameter expansion", "${X:-${Y}}"],
];

// Not in the list on purpose, and not an omission: `$(echo $(true))` ends in `)`,
// which is already a separator, so nested command substitution never depended on
// the eliding run at all. Measured 1/1 against the anchor before deciding not to
// widen the `$(…)` alternative — adding nesting there would have changed no
// behaviour, which is the definition of a no-op.

for (const [surface, build] of ELIDING_SURFACES) {
  for (const [label, prefix] of [...ELIDING_PREFIXES, ...ELIDING_RUN_PREFIXES]) {
    test(`${surface} behind an eliding ${label} is still audited (exit 1)`, () => {
      const r = runFull(build(prefix));
      assert.equal(r.status, 1);
      assert.match(r.stderr, /fail-closed/);
    });
  }
}

// The anchor recognises an eliding RUN, so it must not start recognising a bare
// path token. This is the false block the anchor was introduced to close (R4) and
// the direction that widening it could reopen: `c--body-file=` sits mid-token in a
// real filename, is preceded by an ordinary word character, and must stay invisible
// to the occurrence patterns. An inline env assignment is the same shape with `=`
// in front — `=` is neither a separator nor an eliding construct, so `FOO=--body-file`
// is not an occurrence either. Both exit 0 because the real body is readable and
// carries the footer; if either ever exits 1 the anchor has been widened too far.
test("a colliding literal mid path token is still not an occurrence (exit 0)", () => {
  const p = fixture("g--body-file=fragment.md", `body\n\n${FOOTER}\n`);
  assert.equal(run(`gh pr edit 1 --body-file ${p}`), 0);
});

test("an inline env assignment spelled like the flag is not an occurrence (exit 0)", () => {
  const p = fixture("assign-body.md", `body\n\n${FOOTER}\n`);
  assert.equal(run(`FOO=--body-file gh pr edit 1 --body-file ${p}`), 0);
});

// A newline and a carriage return end a shell token too. Both were already inside
// `\s` in the anchor's first group, so these are not regression tests — they close
// a coverage gap: every other multi-command payload in this file is separated by a
// literal `;` on one line, and a heredoc or a pasted script is not. Without them
// nothing would turn red if a future edit spelled the separator set out character
// by character and stopped at the space and the tab.
test("unextractable occurrence after a newline separator still fails closed (exit 1)", () => {
  const p = fixture("newline-anchored.md", `body\n\n${FOOTER}\n`);
  const r = runFull(`(gh pr edit 1 --body-file ${p};\n--body-file=<(cat /etc/hosts))`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("unextractable occurrence after a carriage-return separator still fails closed (exit 1)", () => {
  const p = fixture("cr-anchored.md", `body\n\n${FOOTER}\n`);
  const r = runFull(`(gh pr edit 1 --body-file ${p};\r--body-file=<(cat /etc/hosts))`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fail-closed/);
});

test("two extractable occurrences split across a newline separator stay readable (exit 0)", () => {
  const first = fixture("newline-first.md", `body\n\n${FOOTER}\n`);
  const second = fixture("newline-second.md", `comment\n\n${FOOTER}\n`);
  assert.equal(
    run(`(gh pr edit 1 --body-file ${first};\ngh pr comment 2 --body-file ${second})`),
    0
  );
});

// Eight constants, not nine. WRITEBACK_FLAG_RE is the write-back DETECTION pattern
// and is deliberately excluded: anchoring it would turn a payload the gate
// over-detects into one it never sees. That is ONE fail-open direction, not the
// only one — recognition drawn too narrow drops occurrences while detection still
// fires, which is what the eliding-run rows above were added to catch after three
// separate rounds measured it. Do not restate this exclusion as "the only way to
// fail open"; the rows above are the evidence against that. Do not "complete" this
// list with it either. That
// exclusion is cooperative-only by design — a source-shape assertion here would die
// to a rename, and a behavioural one would freeze a known false positive into an
// expected exit code — so the rationale lives in prose at three sites: this comment,
// the definition site of that pattern, and the capability spec requirement.
test("guard: all four body-file surfaces share one flag-token-start anchor", () => {
  const src = readFileSync(HOOK, "utf8");
  assert.match(
    src,
    /const FLAG_TOKEN_START = /,
    "gh-footer-gate.mjs must define a single named flag-token-start anchor"
  );
  for (const name of [
    "BODY_FILE_ARG_RE",
    "BODY_FILE_PRESENCE_RE",
    "NOTES_FILE_ARG_RE",
    "NOTES_FILE_PRESENCE_RE",
    "F_FILE_ARG_RE",
    "F_FILE_PRESENCE_RE",
    "F_ALIAS_ARG_RE",
    "F_ALIAS_PRESENCE_RE",
  ]) {
    const stmt = src.match(new RegExp(`const ${name} = new RegExp\\([\\s\\S]*?\\n?\\);`))?.[0];
    assert.ok(stmt, `${name} pattern not found`);
    assert.ok(
      stmt.includes("${FLAG_TOKEN_START}"),
      `${name} must be anchored to a shell token start via FLAG_TOKEN_START — an unanchored flag pattern matches inside a bare path token and the per-occurrence backstop then blocks a legitimate write-back`
    );
  }
});

// Typed-field / raw-field CONSUMER sites (unsupportedTypedFieldMatch,
// fBodyMatch, fSubshellMatch) are inline firstCmdMatch(new RegExp…), not the
// eight named *_ARG_RE/*_PRESENCE_RE constants above. #13 decoy-in-title
// bypassed because these three lacked FLAG_TOKEN_START while the eight had it.
test("guard: typed-field consumer sites share FLAG_TOKEN_START (#13 / 7.1)", () => {
  const src = readFileSync(HOOK, "utf8");
  for (const name of ["unsupportedTypedFieldMatch", "fBodyMatch", "fSubshellMatch"]) {
    const stmt = src.match(new RegExp(`const ${name} = firstCmdMatch\\([\\s\\S]*?\\n\\);`))?.[0];
    assert.ok(stmt, `${name} statement not found`);
    assert.ok(
      stmt.includes("${FLAG_TOKEN_START}"),
      `${name} must prefix its flag alternative with FLAG_TOKEN_START — without it, decoy-in-title shapes like --title=hello-fbody=… match inside a bare token`
    );
  }
});

test("guard: all four body-file surfaces share one path-argument fragment", () => {
  const src = readFileSync(HOOK, "utf8");
  assert.match(
    src,
    /const BODY_PATH_ARG = /,
    "gh-footer-gate.mjs must define a single named body-file path-argument fragment"
  );
  for (const name of ["BODY_FILE_ARG_RE", "NOTES_FILE_ARG_RE", "F_FILE_ARG_RE", "F_ALIAS_ARG_RE"]) {
    const stmt = src.match(new RegExp(`const ${name} = new RegExp\\([\\s\\S]*?\\n?\\);`))?.[0];
    assert.ok(stmt, `${name} extraction pattern not found`);
    assert.ok(
      stmt.includes("${BODY_PATH_ARG}"),
      `${name} must build its path capture from BODY_PATH_ARG, not an inline pattern`
    );
    assert.ok(
      !stmt.includes("(\\S+)"),
      `${name} must not capture the path with \\S+ — it swallows trailing shell metacharacters`
    );
  }
});

test("guard: every body-file surface pairs extraction with a fail-closed backstop", () => {
  const src = readFileSync(HOOK, "utf8");
  assert.match(
    src,
    /function failClosedIfUnextracted\(/,
    "gh-footer-gate.mjs must define one named fail-closed backstop for unextractable body-file arguments"
  );
  for (const name of ["BODY_FILE_ARG_RE", "NOTES_FILE_ARG_RE", "F_FILE_ARG_RE"]) {
    assert.match(
      src,
      new RegExp(`firstCmdMatch\\(${name}\\)`),
      `${name} must be the extraction pattern for its surface`
    );
    assert.match(
      src,
      new RegExp(`failClosedIfUnextracted\\(${name},`),
      `${name} must be paired with failClosedIfUnextracted on the SAME named pattern — an unextractable body-file flag occurrence must fail closed, not silently drop the body source`
    );
  }
  // Deliberately NO assertion on the backstop's internal source shape here. An
  // earlier revision matched the literal offset-comparison line; a mutation audit
  // showed that assertion stayed green when the backstop was reverted to per-command
  // scope while that line was kept, so it detected nothing the behavior tests miss —
  // it only added false-red risk on a harmless rename. The per-occurrence scope is
  // locked by behavior instead: "extractable first occurrence + unextractable LATER
  // one → fails closed", which exits 0 under per-command scope and 1 under
  // per-occurrence. Per rule-anchor-guard-strength.md, a structural anchor that
  // cannot turn red on the semantic reversal it claims to guard is not a guard.
});
