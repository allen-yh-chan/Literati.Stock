/**
 * hook-pre-tool-gate-committed-diff-whitespace-push.test.mjs
 *
 * Integration tests for the Committed-Diff Whitespace Push Gate
 * (checkCommittedDiffWhitespacePush) in pre-tool-gate.mjs.
 *
 * Per `openspec/changes/enforce-whitespace-at-push-gate` R2/R4: the gate hard-
 * blocks `git push` when the committed diff vs `origin/main` carries a
 * DEFINITE whitespace offender, and fails open on any infra uncertainty (not
 * a push / --dry-run / unresolvable base / consumer repo).
 *
 * TDD note: this negative case (T3) was written to fail red before
 * checkCommittedDiffWhitespacePush existed in pre-tool-gate.mjs, then verified
 * green once the gate + BASH_BLOCKING_GATES registration landed (T2).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { SOURCE_BARE_NAME, markSourceCheckout } from "./lib/identity-fixtures.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(SCRIPT_DIR, "../hooks/pre-tool-gate.mjs");

const tmpRoot = makeTempDir("whitespace-push-gate-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

let counter = 0;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r;
}

/**
 * Build a work repo with a real `origin` bare remote (so `origin/main` is a
 * resolvable remote-tracking ref), then add a local branch commit on top.
 *
 * @param {object} opts
 * @param {boolean} opts.pollute — if true, the local-only commit introduces a
 *   trailing-whitespace line (the DEFINITE offender case).
 * @param {boolean} opts.consumer — if true, install a `.gitmodules` file so
 *   the fixture reads as a consumer business repo (isSourceRepo → false).
 */
function setupFixture({ pollute = false, consumer = false } = {}) {
  const tmp = path.join(tmpRoot, `fixture-${counter++}`);
  const bare = path.join(tmp, SOURCE_BARE_NAME);
  const work = path.join(tmp, "work");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "t@t.com"]);
  git(work, ["config", "user.name", "t"]);

  writeFileSync(path.join(work, "README.md"), "fixture\n");
  writeFileSync(path.join(work, "notes.md"), "line one\nline two\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "init"]);

  execSync(`git init -q --bare "${bare}"`);
  git(work, ["remote", "add", "origin", bare]);
  git(work, ["push", "-q", "origin", "main"]);

  // Move to a feature branch and add a local-only commit ahead of origin/main.
  git(work, ["checkout", "-q", "-b", "chore/whitespace-push-gate-fixture"]);

  if (consumer) {
    mkdirSync(path.join(work, ".devpro-agent-rules", ".devpro", "scripts"), { recursive: true });
    writeFileSync(path.join(work, ".devpro-agent-rules", "AGENTS.md"), "# rules\n");
    writeFileSync(path.join(work, ".devpro-agent-rules", ".devpro", "scripts", "sync-agent-rules.mjs"), "// sync\n");
  } else {
    markSourceCheckout(work);
  }

  const line = pollute ? "line three  \n" : "line three\n"; // trailing whitespace when pollute
  writeFileSync(path.join(work, "notes.md"), `line one\nline two\n${line}`);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "feat: add line three"]);

  // Fetch so origin/main remote-tracking ref reflects the pushed state
  // (already true here since we haven't pushed the feature commit).
  git(work, ["fetch", "-q", "origin"]);

  return work;
}

function runHook(command, fixtureDir) {
  const payload = { tool_name: "Bash", tool_input: { command } };
  // Sentinel state dir lives UNDER tmpRoot so the after() cleanup reclaims it;
  // a bare tmpdir() mkdtemp would leak one dir per hook invocation outside the
  // test's own root (cross-model review finding 4).
  const sentinelDir = mkdtempSync(path.join(tmpRoot, "sentinel-"));
  const r = spawnSync("node", [HOOK], {
    cwd: fixtureDir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
      DEVPRO_RELEVANT_ARCHIVES: "",
      PWD: fixtureDir,
    },
  });
  let json = null;
  try {
    json = r.stdout ? JSON.parse(r.stdout) : null;
  } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function advisoryText(result) {
  return result.json?.systemMessage || result.json?.hookSpecificOutput?.additionalContext || "";
}

test("Committed-diff whitespace push gate: polluted committed diff + git push → block", () => {
  const dir = setupFixture({ pollute: true });
  const r = runHook("git push origin chore/whitespace-push-gate-fixture", dir);
  assert.equal(
    r.json?.decision,
    "block",
    `expected block for polluted committed diff; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.match(
    r.json?.reason || "",
    /notes\.md/,
    `block reason must name the offending file; got: ${r.json?.reason}`
  );
});

test("Committed-diff whitespace push gate: clean committed diff + git push → pass", () => {
  const dir = setupFixture({ pollute: false });
  const r = runHook("git push origin chore/whitespace-push-gate-fixture", dir);
  assert.notEqual(
    r.json?.decision,
    "block",
    `clean diff must not block; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.doesNotMatch(
    advisoryText(r),
    /Committed-diff whitespace push gate effective-scope/,
    "clean checked push must not emit an effective-scope advisory"
  );
});

test("Committed-diff whitespace push gate: non-push command → fail-open (no block)", () => {
  const dir = setupFixture({ pollute: true });
  const r = runHook("git status", dir);
  assert.notEqual(
    r.json?.decision,
    "block",
    `non-push command must fail-open; got: ${JSON.stringify(r.json)}`
  );
});

test("Committed-diff whitespace push gate: git push --dry-run + polluted diff → fail-open (no block)", () => {
  const dir = setupFixture({ pollute: true });
  const r = runHook("git push --dry-run origin chore/whitespace-push-gate-fixture", dir);
  assert.notEqual(
    r.json?.decision,
    "block",
    `--dry-run push must fail-open; got: ${JSON.stringify(r.json)}`
  );
});

test("Committed-diff whitespace push gate: unresolvable origin/main → fail-open (no block)", () => {
  const tmp = path.join(tmpRoot, `fixture-${counter++}`);
  mkdirSync(tmp, { recursive: true });
  git(tmp, ["init", "-q", "-b", "chore/no-remote-fixture"]);
  git(tmp, ["config", "user.email", "t@t.com"]);
  git(tmp, ["config", "user.name", "t"]);
  writeFileSync(path.join(tmp, "notes.md"), "line one  \n"); // trailing whitespace, but no origin/main exists
  git(tmp, ["add", "-A"]);
  git(tmp, ["commit", "-q", "-m", "init, no origin/main configured"]);
  markSourceCheckout(tmp);

  const r = runHook("git push origin chore/no-remote-fixture", tmp);
  assert.notEqual(
    r.json?.decision,
    "block",
    `unresolvable origin/main must fail-open; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.match(advisoryText(r), /Committed-diff whitespace push gate effective-scope/);
  assert.match(advisoryText(r), /checked=false/);
  assert.match(advisoryText(r), /origin\/main\.\.\.HEAD/);
});

test("Committed-diff whitespace push gate: consumer repo (installed rules) → fail-open (no block)", () => {
  const dir = setupFixture({ pollute: true, consumer: true });
  const r = runHook("git push origin chore/whitespace-push-gate-fixture", dir);
  assert.notEqual(
    r.json?.decision,
    "block",
    `consumer repo must fail-open; got: ${JSON.stringify(r.json)}`
  );
});

test("Committed-diff whitespace push gate: linked-worktree push (cd <worktree> && git push) checks the pushing worktree, not the main checkout → block", () => {
  // A LINKED git worktree of the SAME repo (not a separate clone, so no
  // cross-repo gate). The main checkout is clean at HEAD; the linked worktree's
  // branch introduces trailing whitespace. If the gate checked the invocation
  // cwd (main checkout) it would miss the pollution; the worktree-aware
  // effectiveCwd resolution must catch it in the pushing worktree.
  const tmp = path.join(tmpRoot, `fixture-${counter++}`);
  const bare = path.join(tmp, SOURCE_BARE_NAME);
  const main = path.join(tmp, "main");
  mkdirSync(main, { recursive: true });

  git(main, ["init", "-q", "-b", "main"]);
  git(main, ["config", "user.email", "t@t.com"]);
  git(main, ["config", "user.name", "t"]);
  writeFileSync(path.join(main, "notes.md"), "line one\nline two\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "init"]);

  execSync(`git init -q --bare "${bare}"`);
  git(main, ["remote", "add", "origin", bare]);
  git(main, ["push", "-q", "origin", "main"]);
  git(main, ["fetch", "-q", "origin"]);

  // Add a linked worktree on a feature branch that introduces trailing whitespace.
  const wt = path.join(tmp, "wt");
  git(main, ["worktree", "add", "-q", "-b", "chore/wt-fixture", wt, "main"]);
  markSourceCheckout(wt);
  writeFileSync(path.join(wt, "notes.md"), "line one\nline two\nline three  \n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "feat: add polluted line three"]);
  git(wt, ["fetch", "-q", "origin"]);

  // Invoke the hook from the MAIN checkout (clean at HEAD), command cd's into
  // the linked worktree to push.
  const r = runHook(`cd ${wt} && git push origin chore/wt-fixture`, main);
  assert.equal(
    r.json?.decision,
    "block",
    `linked-worktree push must be checked in the pushing worktree (effectiveCwd), not the main checkout; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.match(
    r.json?.reason || "",
    /notes\.md/,
    `block reason must name the offending file; got: ${r.json?.reason}`
  );
});

test("Committed-diff whitespace push gate: push that only touches a legacy-dirty file without adding whitespace → pass", () => {
  // Base (origin/main) already carries trailing whitespace on a line the feature
  // commit does NOT change. The introduced (3-dot) diff adds no new whitespace,
  // so the gate must NOT block — this is the design's headline behavior
  // (3-dot range over full-file), asserted end-to-end at the hook.
  const tmp = path.join(tmpRoot, `fixture-${counter++}`);
  const bare = path.join(tmp, SOURCE_BARE_NAME);
  const work = path.join(tmp, "work");
  mkdirSync(work, { recursive: true });

  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "t@t.com"]);
  git(work, ["config", "user.name", "t"]);
  // Legacy file with PRE-EXISTING trailing whitespace on line one, committed to main.
  writeFileSync(path.join(work, "legacy.md"), "dirty line  \nclean line\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "init with legacy trailing whitespace"]);

  execSync(`git init -q --bare "${bare}"`);
  git(work, ["remote", "add", "origin", bare]);
  git(work, ["push", "-q", "origin", "main"]);

  git(work, ["checkout", "-q", "-b", "chore/touch-legacy-fixture"]);
  // Append a CLEAN line — touches the file, but the line with trailing
  // whitespace (line one) is unchanged, so the 3-dot diff adds no whitespace.
  writeFileSync(path.join(work, "legacy.md"), "dirty line  \nclean line\nappended clean line\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "feat: append a clean line to a legacy-dirty file"]);
  git(work, ["fetch", "-q", "origin"]);

  const r = runHook("git push origin chore/touch-legacy-fixture", work);
  assert.notEqual(
    r.json?.decision,
    "block",
    `touching a legacy-dirty file without adding new whitespace must NOT block (3-dot range scope); got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// fix-eof-gate-cwd-blind-spot: T3 prove-it (RED before the fix) + T4 sentinel
// (anti-regression — MUST already PASS on current code; see design.md D10).
// PreToolUse fires BEFORE the Bash payload executes, so `git commit -m x &&
// git push` evaluates `origin/main...HEAD` against the PRE-commit HEAD. The
// gate must classify that as `not_checked` (honest "didn't check"), not
// `clean` (false claim of "confirmed clean") — the whole point of this change.
//
// The chained commit clause carries a valid attribution footer AND uses `-a`
// (deferred-staging — class A per Gate 3's own D6 boundary) so TWO unrelated
// gates do not fire and swallow the single advisory slot `runGateInventory`
// returns for this payload (every gate's SIDE EFFECTS still run either way;
// only the RETURNED text is single-slot): (1) commit-attribution-missing-
// footer (needs the footer) and (2) Gate 3's own new `staged-set-empty`
// advisory (an `--allow-empty` commit with nothing staged would otherwise
// legitimately trip Gate 3's OWN not-checked signal first — `-a` names that
// as expected deferred staging instead). An assertion built on a chained
// commit that trips either of those would fail for the wrong reason.
const CHAINED_COMMIT_WITH_FOOTER =
  'git commit -a -m "feat: another' +
  "\n\nRules: v6.82.1 · Tool: Test Harness · Model: n/a" +
  '"';

test("Committed-diff whitespace push gate (T3 prove-it): chained `git commit -m x && git push` with NO landed offender → not_checked (false-clean fix), never a bare clean pass", () => {
  const dir = setupFixture({ pollute: false });
  // fix-eof-gate-cwd-blind-spot T11: give this fixture an AGENTS.md matching
  // CHAINED_COMMIT_WITH_FOOTER's declared version, so Gate 2b's version-
  // equality layer is CHECKED (not skipped) and stays silent (match) — a
  // fixture with no AGENTS.md would otherwise trip the new `version-layer-
  // skipped` advisory and win runGateInventory's single global advisory slot
  // ahead of this test's actual target, the push gate's own advisory.
  writeFileSync(path.join(dir, "AGENTS.md"), "版本：6.82.1\n");
  const r = runHook(
    `${CHAINED_COMMIT_WITH_FOOTER} && git push origin chore/whitespace-push-gate-fixture`,
    dir
  );
  assert.notEqual(
    r.json?.decision,
    "block",
    `must not (yet) block on an unexecuted chained commit; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.match(
    advisoryText(r),
    /Committed-diff whitespace push gate effective-scope/,
    `expected an effective-scope not_checked advisory (not a silent clean pass); got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.match(advisoryText(r), /checked=false/);
  assert.match(
    advisoryText(r),
    /stale-head-chained-commit/,
    `expected the stale-head-chained-commit reason token; got: ${advisoryText(r)}`
  );
  // R14 (enforce-chore-code-size-limit D9/D19): the remedy sentence must be
  // rendered, never the literal string `undefined` from a missing
  // NOT_CHECKED_REMEDY key. Keyword-level asserts only (wording not pinned).
  assert.doesNotMatch(
    advisoryText(r),
    /undefined/,
    `advisory must not render a missing remedy as "undefined"; got: ${advisoryText(r)}`
  );
  assert.match(
    advisoryText(r),
    /拆成兩個/,
    `expected the remedy to tell the reader to split into two calls; got: ${advisoryText(r)}`
  );
  assert.match(
    advisoryText(r),
    /獨立/,
    `expected the remedy to mention independent Bash calls; got: ${advisoryText(r)}`
  );
});

// SENTINEL (anti-regression, design.md D10 #4): this is NOT a prove-it for a
// defect — it is a guard against a WRONG fix. A naive implementation might
// detect the chained shape and short-circuit `evaluateCommittedDiffWhitespacePush`
// to `not_checked` unconditionally. That would silently delete a hard block
// that is valid TODAY: `origin/main...HEAD` already includes a REAL offender
// commit this branch landed earlier (independent of whatever the chained,
// not-yet-executed `git commit` will add). If this test ever turns RED, the
// fix regressed — someone added a "detected chained → short-circuit" early
// return instead of only reclassifying the `checkRangeWhitespace` RESULT.
test("Committed-diff whitespace push gate (T4 sentinel, anti-regression): chained shape with an ALREADY-LANDED real offender still hard-blocks", () => {
  const dir = setupFixture({ pollute: true }); // real offender already landed on this branch
  const r = runHook(
    `${CHAINED_COMMIT_WITH_FOOTER} && git push origin chore/whitespace-push-gate-fixture`,
    dir
  );
  assert.equal(
    r.json?.decision,
    "block",
    `chained shape MUST NOT short-circuit an already-landed offender; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.match(
    r.json?.reason || "",
    /notes\.md/,
    `block reason must still name the offending file; got: ${r.json?.reason}`
  );
});

test("Committed-diff whitespace push gate: unresolvable effective cwd (cmd-subst cd) → fail-open, NOT baseCwd substitution", () => {
  // The invocation cwd (baseCwd) IS a polluted source repo — its introduced diff
  // adds trailing whitespace, so a baseCwd-substituting gate would BLOCK. But the
  // command routes the push through a `cd $(...)` whose target the cwd resolver
  // cannot statically determine → UNRESOLVABLE_CWD sentinel. Per spec + cross-model
  // finding 2, a genuinely unresolvable push cwd MUST fail open (the push may be
  // targeting a DIFFERENT tree than baseCwd; hard-blocking on baseCwd would block a
  // push the payload never aimed at that tree). Regression pin for the fix that
  // stopped mapping UNRESOLVABLE_CWD → baseCwd in this hard-blocking gate.
  const dir = setupFixture({ pollute: true });
  const r = runHook("cd $(echo .) && git push origin chore/whitespace-push-gate-fixture", dir);
  assert.notEqual(
    r.json?.decision,
    "block",
    `unresolvable effective cwd must fail open, not be substituted by baseCwd and hard-block; got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
  );
  assert.match(advisoryText(r), /Committed-diff whitespace push gate effective-scope/);
  assert.match(advisoryText(r), /checked=false/);
  assert.match(advisoryText(r), /effective cwd unresolved/);
});

// fix-eof-gate-cwd-blind-spot T13 class A: consumer repo push produces no
// advisory from EITHER of THIS change's in-scope gates (whitespace push gate
// / archive-before-push gate; no `.devpro/` dir in this fixture → class A
// per T10). Not a bare `r.json === null`: this repo's pre-existing, out-of-
// scope `dev-flow-checklist.md` push nudge (unconditional on every push,
// unrelated to source/consumer status) legitimately still fires here — that
// is untouched pre-existing behavior, not a gap this change introduces.
test("T13 class A: consumer repo (installed rules) push, clean diff → no whitespace-push-gate or archive-gate advisory", () => {
  const dir = setupFixture({ pollute: false, consumer: true });
  const r = runHook("git push origin chore/whitespace-push-gate-fixture", dir);
  const text = advisoryText(r);
  assert.doesNotMatch(text, /Committed-diff whitespace push gate/, `expected no whitespace-push-gate advisory; got: ${JSON.stringify(r.json)}`);
  assert.doesNotMatch(text, /Archive-before-push gate/, `expected no archive-gate advisory; got: ${JSON.stringify(r.json)}`);
});

// ── Scope change 1 (R18): the gate reads the checkout the git push itself runs in ──
//
// A main checkout and a linked worktree of the same repository: the worktree's branch introduces trailing whitespace,
// the main checkout's does not. The gate runner's first git/gh position and the push position can differ.
function setupCleanMainAndPollutedWorktree() {
  const tmp = path.join(tmpRoot, `fixture-${counter++}`);
  const bare = path.join(tmp, SOURCE_BARE_NAME);
  const main = path.join(tmp, "main");
  mkdirSync(main, { recursive: true });
  git(main, ["init", "-q", "-b", "main"]);
  git(main, ["config", "user.email", "t@t.com"]);
  git(main, ["config", "user.name", "t"]);
  writeFileSync(path.join(main, "notes.md"), "line one\nline two\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "init"]);
  execSync(`git init -q --bare "${bare}"`);
  git(main, ["remote", "add", "origin", bare]);
  git(main, ["push", "-q", "origin", "main"]);
  git(main, ["fetch", "-q", "origin"]);
  git(main, ["checkout", "-q", "-b", "chore/clean-main-fixture"]);
  const wt = path.join(tmp, "wt");
  git(main, ["worktree", "add", "-q", "-b", "chore/polluted-wt-fixture", wt, "main"]);
  writeFileSync(path.join(wt, "notes.md"), "line one\nline two\nline three  \n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "feat: add polluted line three"]);
  git(wt, ["fetch", "-q", "origin"]);
  markSourceCheckout(main);
  markSourceCheckout(wt);
  return { main, wt };
}

const blockedByWhitespaceGate = (r) => r.json?.decision === "block" && /notes\.md/.test(r.json.reason || "");

test("Scenario: The whitespace push gate checks the checkout of the push (through the hook)", () => {
  const { main, wt } = setupCleanMainAndPollutedWorktree();
  // [label, session checkout, command, whether the gate must block]
  const cases = [
    // git -C belongs to the status command, not to the push: the push runs in the session checkout.
    ["git -C into the polluted worktree does not move the push (clean session)", main, `git -C ${wt} status && git push origin chore/clean-main-fixture`, false],
    ["git -C into the clean checkout does not move the push (polluted session)", wt, `git -C ${main} status && git push origin chore/polluted-wt-fixture`, true],
    // A cd after the first git command moves the shell before the push runs.
    ["a cd after the first git command moves the push into the polluted worktree", main, `git fetch && cd ${wt} && git push origin chore/polluted-wt-fixture`, true],
    ["a cd after the first git command moves the push into the clean checkout", wt, `git fetch && cd ${main} && git push origin chore/clean-main-fixture`, false],
    // A quoted environment value must not turn the push into a not-checked one.
    ["a quoted environment value before the push in the polluted worktree", wt, 'V="a b c" git push origin chore/polluted-wt-fixture', true],
    ["a quoted environment value before the push in the clean checkout", main, 'V="a b c" git push origin chore/clean-main-fixture', false],
    ["a long quoted value after a cd into the polluted worktree", main, `cd ${wt} && VAR='a quoted value longer than the opaque placeholder' git push origin chore/polluted-wt-fixture`, true],
    // Text inside a quoted environment value is data: a `-C` option or a GIT_DIR assignment spelled in it must not be
    // read as a directory operand of the push.
    ["a quoted value that spells an ssh -C option before the push", wt, 'GIT_SSH_COMMAND="ssh -C -i k" git push origin chore/polluted-wt-fixture', true],
    ["a quoted value that spells a GIT_DIR assignment before the push", wt, 'MSG="a GIT_DIR=x" git push origin chore/polluted-wt-fixture', true],
    // Control: a real, unquoted GIT_DIR assignment still makes the checkout unresolvable (fail-open).
    ["a real GIT_DIR assignment before the push stays unresolved", wt, 'GIT_DIR=/nonexistent-git-dir-for-whitespace-test git push origin chore/polluted-wt-fixture', false],
  ];
  for (const [label, session, command, shouldBlock] of cases) {
    const r = runHook(command, session);
    assert.equal(
      blockedByWhitespaceGate(r),
      shouldBlock,
      `${label}: expected ${shouldBlock ? "block" : "no whitespace block"}, got ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`
    );
  }
});

test("Scenario: The whitespace push gate fails open when the push cwd cannot be resolved (through the hook)", () => {
  const { main, wt } = setupCleanMainAndPollutedWorktree();
  for (const command of [
    `cd "$SOME_VAR" && git push origin chore/polluted-wt-fixture`,
    `cd /nonexistent-dir-for-whitespace-test && git push origin chore/polluted-wt-fixture`,
    `(cd ${wt} && git push origin chore/polluted-wt-fixture)`,
    `cd ${wt} && echo ok || echo no && git push origin chore/polluted-wt-fixture`,
  ]) {
    const r = runHook(command, main);
    assert.equal(blockedByWhitespaceGate(r), false, `${command}: must not block, got ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`);
  }
  // Control: the same worktree push from a plain command blocks.
  assert.equal(blockedByWhitespaceGate(runHook(`cd ${wt} && git push origin chore/polluted-wt-fixture`, main)), true);
});
