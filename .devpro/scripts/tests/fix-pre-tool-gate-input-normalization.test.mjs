/**
 * fix-pre-tool-gate-input-normalization.test.mjs
 *
 * chore B-mini fix-pre-tool-gate-input-normalization — regression lock for two
 * pre-tool-gate.mjs input-normalization defects (session-pending items 1 + 2),
 * both pre-existing on origin/main:
 *
 *   item 1 (R1): writePostmergeMarker(branch, ...) builds the marker file path
 *     from sanitizeBranch(branch). When cwd is statically unresolvable the
 *     pipeline yields branch === UNRESOLVABLE_CWD ("\0UNRESOLVABLE_CWD", a
 *     null-byte fail-closed sentinel). sanitizeBranch only replaces "/", so the
 *     "\0" survives → writeFileSync throws "path must be a string ... without
 *     null bytes". `if (!branch) return;` does not catch it (sentinel is a
 *     truthy string). Fix: early-return skip when branch === UNRESOLVABLE_CWD
 *     (fail-open — unresolvable cwd ⇒ branch identity unreliable ⇒ do not write).
 *
 *   item 2 (R2): push-family gates decide "is this a dry-run push?" with
 *     !/--dry-run\b/.test(cmdText) at 4 executable sites (archive gate, whitespace
 *     push gate, marker updater, dev-flow-checklist push advisory). The short
 *     flag `-n` (= --dry-run per `git push -h`) is not recognised → `git push -n`
 *     (a pure dry-run) is treated as a real push and runs the full gate chain.
 *     Fix: shared isPushDryRun(cmd) helper recognising --dry-run OR a standalone
 *     -n token, replacing all 4 inline regexes. Detection is SCOPED to the git
 *     push clause (via gitPushClauseSlices, same pattern as checkForcePush's
 *     `rm -f` fix): a natural -n in a non-push clause of a compound command
 *     (grep -n / echo -n / git log -n / head -n / sort -n) must NOT make the real
 *     push read as a dry-run and silently skip the push-family hard-block gates.
 *     isPushDryRun therefore takes the RAW `cmd` (segment offsets are raw-cmd
 *     index space). When gitPushClauseSlices cannot slice a push clause (rare
 *     parser miss on a cmd the upstream GIT_PUSH_RE already flagged as a push),
 *     it falls back to a single whole-cmd test — a narrow residual any-match that
 *     is fail-OPEN for the negated hard-gate predicate (any -n anywhere ⇒ true),
 *     equal to the pre-fix exposure and accepted only because the slicing-success
 *     path (the norm) is per-clause AND and carries no such hole. See the helper
 *     docstring in pre-tool-gate.mjs for the full polarity rationale.
 *     Semantics are PER-CLUSTER AND (cross-model-review Critical): dry-run only
 *     if EVERY push clause is dry-run. A join()+single-test any-match would let a
 *     mixed "preview then real" compound (`git push -n … && git push …`)
 *     classify the REAL push as dry-run and fail-open the hard gates; instead any
 *     real push clause makes the whole command a real push.
 *
 * These import the functions under test directly (in-process, no spawn) — both
 * are pure/near-pure and cheaply exercised, keeping this test off the suite
 * runtime budget's spawn-contamination path.
 *
 * Marker-dir isolation: postmergeDir() prefers env DEVPRO_POSTMERGE_STATE_DIR,
 * else defaultRepoStateDir(cwd). A bare tmp `cwd` is not a git repo, so the
 * default resolver falls back to a SHARED location and cross-test writes leak.
 * We therefore give each marker test its own isolated dir via the canonical
 * env seam (the same seam 7 existing hook tests use), set/restored per test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  UNRESOLVABLE_CWD,
  writePostmergeMarker,
  isPushDryRun,
} from "../hooks/pre-tool-gate.mjs";

// Run `fn` with an isolated DEVPRO_POSTMERGE_STATE_DIR so writePostmergeMarker's
// output is scoped to this test, capturing process.stderr writes. Returns both
// the marker filenames written and the captured stderr text.
//
// stderr is the *discriminating* signal for the sentinel case: writeFileSync on
// a null-byte path throws and no file is created, so file-count alone cannot
// tell fixed (skip) from unfixed (doomed write swallowed by the internal
// try/catch). Only the unfixed path reaches the catch and writes
// "marker write failed (...null bytes...)" to stderr — the guard suppresses it.
function withIsolatedMarkerDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "ptg-marker-"));
  const prev = process.env.DEVPRO_POSTMERGE_STATE_DIR;
  process.env.DEVPRO_POSTMERGE_STATE_DIR = dir;
  const origWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk, ...rest) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    fn(dir);
    const files = existsSync(dir) ? readdirSync(dir) : [];
    return { files, stderr };
  } finally {
    process.stderr.write = origWrite;
    if (prev === undefined) delete process.env.DEVPRO_POSTMERGE_STATE_DIR;
    else process.env.DEVPRO_POSTMERGE_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── item 1 (R1): writePostmergeMarker skips on null-byte sentinel ────────────

test("(R1) writePostmergeMarker(UNRESOLVABLE_CWD) skips: no throw, no file, no failed-write stderr", () => {
  // Fixed: guard early-returns before any write → no marker, no stderr error.
  // Unfixed: sanitizeBranch(sentinel) keeps "\0" → writeFileSync throws, is
  // caught, and logs "marker write failed (...null bytes...)" to stderr. The
  // stderr assertion is what distinguishes the two — file-count is identical
  // (both write nothing), so without it the test would pass even unfixed.
  let result;
  assert.doesNotThrow(() => {
    result = withIsolatedMarkerDir(() =>
      writePostmergeMarker(UNRESOLVABLE_CWD, "push")
    );
  });
  assert.deepEqual(
    result.files,
    [],
    "sentinel branch must not produce any marker file",
  );
  assert.doesNotMatch(
    result.stderr,
    /marker write failed/,
    "sentinel branch must be skipped BEFORE the doomed writeFileSync (no failed-write stderr)",
  );
});

test("(R1) writePostmergeMarker(normal branch) still writes a marker (skip guard is sentinel-only)", () => {
  const { files } = withIsolatedMarkerDir(() =>
    writePostmergeMarker("feature/x", "push")
  );
  assert.ok(
    // A push whose repository is not proven is named `unknown__<digest of the branch>.push` (#3704 r1 F3, r2 F2).
    files.some((f) => /^unknown__[0-9a-f]{32}\.push$/.test(f)),
    `normal branch must still write its marker; got ${JSON.stringify(files)}`,
  );
});

test("(R1) writePostmergeMarker(falsy branch) remains a no-op (pre-existing guard preserved)", () => {
  let result;
  assert.doesNotThrow(() => {
    result = withIsolatedMarkerDir(() => writePostmergeMarker("", "push"));
  });
  assert.deepEqual(result.files, [], "empty branch must not write a marker");
});

// ── item 2 (R2): isPushDryRun recognises -n and --dry-run ────────────────────

test("(R2) isPushDryRun recognises --dry-run long flag", () => {
  assert.equal(isPushDryRun("git push --dry-run origin main"), true);
  assert.equal(isPushDryRun("git push origin main --dry-run"), true);
});

test("(R2) isPushDryRun recognises standalone -n short flag", () => {
  assert.equal(isPushDryRun("git push -n"), true);
  assert.equal(isPushDryRun("git push -n origin main"), true);
  assert.equal(isPushDryRun("git push origin main -n"), true);
});

test("(R2) isPushDryRun returns false for a real (non-dry-run) push", () => {
  assert.equal(isPushDryRun("git push"), false);
  assert.equal(isPushDryRun("git push origin main"), false);
  assert.equal(isPushDryRun("git push --force origin main"), false);
});

test("(R2) isPushDryRun does not false-positive on -n embedded in another token", () => {
  // A branch/remote name merely containing "-n" must not be read as the flag.
  assert.equal(isPushDryRun("git push origin feature-name"), false);
  assert.equal(isPushDryRun("git push origin main-nightly"), false);
});

test("(R2) isPushDryRun scopes -n to the push clause in a compound command (real push not read as dry-run)", () => {
  // The dangerous case: a natural `-n` in a NON-push clause of a compound command
  // must NOT make the real `git push` read as a dry-run. If it did, the
  // push-family hard-block gates (archive gate, committed-diff whitespace gate)
  // would be silently skipped on a genuine release push — a fail-open on a
  // release-integrity gate. isPushDryRun scopes -n detection to the push clause
  // only (via gitPushClauseSlices, same pattern as checkForcePush's `rm -f` fix).
  assert.equal(isPushDryRun("grep -n foo file && git push origin main"), false);
  assert.equal(isPushDryRun("echo -n hi && git push origin main"), false);
  assert.equal(isPushDryRun("git log -n 5 && git push origin main"), false);
  assert.equal(isPushDryRun("head -n 20 f.txt && git push"), false);
  assert.equal(isPushDryRun("sort -n data && git push origin main"), false);
});

test("(R2) isPushDryRun still detects a genuine dry-run push within a compound command", () => {
  // The mirror invariant: a real `-n` / `--dry-run` ON the push clause must still
  // be detected even when other clauses precede it — scoping narrows the scan to
  // the push clause, it must not lose the flag that legitimately lives there.
  assert.equal(isPushDryRun("grep foo file && git push -n origin main"), true);
  assert.equal(isPushDryRun("npm test && git push --dry-run origin main"), true);
});

test("(R2) isPushDryRun treats a mixed dry-run + real push compound as a REAL push (per-clause AND, not any-match)", () => {
  // The second Critical (found by cross-model review): isPushDryRun must be
  // per-clause. A cautious "preview then really push" compound has TWO push
  // clauses — one dry-run, one real. A join()+single-test any-match reads the
  // whole command as dry-run because *some* clause has -n, so the REAL push
  // silently skips the archive / committed-diff-whitespace release-integrity
  // hard-block gates (fail-open). Correct semantics: dry-run only if EVERY push
  // clause is dry-run; any real push clause ⇒ the command is a real push.
  assert.equal(
    isPushDryRun("git push -n origin main && git push origin main"),
    false,
    "preview-then-real: the real push clause must win → real push",
  );
  assert.equal(
    isPushDryRun("git push --dry-run origin main; git push origin main"),
    false,
    "dry-run;real via semicolon separator → real push",
  );
  assert.equal(
    isPushDryRun("git push origin main && git push -n origin main"),
    false,
    "real-then-preview (order-independent) → real push",
  );
});

test("(R2) isPushDryRun treats an all-dry-run push compound as dry-run", () => {
  // Mirror of the per-clause rule: when EVERY push clause is dry-run there is no
  // real push, so the command is genuinely a dry-run and gates may be skipped.
  assert.equal(isPushDryRun("git push -n origin a && git push -n origin b"), true);
  assert.equal(isPushDryRun("git push --dry-run a; git push -n b"), true);
});
