/**
 * whitespace-gate.test.mjs
 *
 * Unit tests for the pure-function whitespace-check core shared by
 * check-committed-diff-whitespace.mjs (CLI) and pre-tool-gate.mjs (push-time
 * hook): .devpro/scripts/hooks/lib/whitespace-gate.mjs.
 *
 * Contract under test: side-effect-free (no process.exit / console.*), and
 * correct {ok, offenders/output} result values for clean vs polluted diffs.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRangeWhitespace,
  checkChangedFilesWhitespace,
  EMPTY_TREE_SHA,
} from "../hooks/lib/whitespace-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIB_PATH = path.resolve(SCRIPT_DIR, "../hooks/lib/whitespace-gate.mjs");

const tmpRoot = makeTempDir("whitespace-gate-lib-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

let counter = 0;
const repoFixtures = new Map();

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 && args[0] !== "diff") {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r;
}

function createRepo({ pollute = false } = {}) {
  const dir = path.join(tmpRoot, `repo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "t"]);

  writeFileSync(path.join(dir, "clean.md"), "line one\nline two\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);

  const content = pollute ? "line one  \nline two\n" : "line one\nline two\n";
  writeFileSync(path.join(dir, "notes.md"), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "add notes.md"]);

  return dir;
}

function setupRepo({ pollute = false, fresh = false } = {}) {
  if (fresh) return createRepo({ pollute });

  // Shared fixtures keep this integration file below the tier budget. Callers
  // must treat the returned repo as read-only; mutating cases use fresh:true.
  const key = pollute ? "polluted" : "clean";
  if (!repoFixtures.has(key)) {
    repoFixtures.set(key, createRepo({ pollute }));
  }
  return repoFixtures.get(key);
}

test("whitespace-gate.mjs is side-effect-free (no process.exit / console.*)", () => {
  const source = readFileSync(LIB_PATH, "utf8");
  assert.equal(
    (source.match(/process\.exit/g) || []).length,
    0,
    "lib must not call process.exit"
  );
  assert.equal(
    (source.match(/console\./g) || []).length,
    0,
    "lib must not call console.*"
  );
});

test("EMPTY_TREE_SHA is exported and matches git's canonical empty-tree SHA", () => {
  assert.equal(EMPTY_TREE_SHA, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

test("checkRangeWhitespace: clean range → {ok:true}", () => {
  const dir = setupRepo({ pollute: false });
  const result = checkRangeWhitespace("HEAD~1...HEAD", dir);
  assert.equal(result.ok, true, `expected clean pass; got: ${JSON.stringify(result)}`);
});

test("checkRangeWhitespace: polluted range → {ok:false}", () => {
  const dir = setupRepo({ pollute: true });
  const result = checkRangeWhitespace("HEAD~1...HEAD", dir);
  assert.equal(result.ok, false, `expected offender detected; got: ${JSON.stringify(result)}`);
  assert.match(result.output, /notes\.md/);
});

test("checkRangeWhitespace: invalid range → {ok:false, error set}", () => {
  const dir = setupRepo({ pollute: false });
  const result = checkRangeWhitespace("not-a-real-ref...HEAD", dir);
  // git diff --check on an unresolvable ref exits 128 (bad ref), NOT 2
  // (whitespace offender). This must not be a false "ok:true"...
  assert.equal(result.ok, false, `unresolvable ref must not report ok:true; got: ${JSON.stringify(result)}`);
  // ...AND it MUST set `error`, which is the exact discriminator hook callers
  // use to FAIL OPEN (ok:false + error → infra uncertainty → allow) versus
  // HARD-BLOCK (ok:false + no error → a DEFINITE whitespace offender). Asserting
  // only ok===false would pass even if a 128 bad-ref were mis-mapped to a
  // blockable offender, defeating the spec's fail-open-on-uncertainty promise.
  assert.ok(result.error, `error field must be set for a bad-ref (128) infra failure; got: ${JSON.stringify(result)}`);
  assert.notEqual(result.status, 2, `bad ref must not be reported as a whitespace offender (status 2); got: ${JSON.stringify(result)}`);
});

test("checkChangedFilesWhitespace: clean changed files vs base → {ok:true, offenders:[]}", () => {
  const dir = setupRepo({ pollute: false });
  const result = checkChangedFilesWhitespace("HEAD~1", dir);
  assert.equal(result.ok, true, `expected clean pass; got: ${JSON.stringify(result)}`);
  assert.deepEqual(result.offenders, []);
});

test("checkChangedFilesWhitespace: polluted changed files vs base → {ok:false, offenders non-empty}", () => {
  const dir = setupRepo({ pollute: true });
  const result = checkChangedFilesWhitespace("HEAD~1", dir);
  assert.equal(result.ok, false, `expected offender detected; got: ${JSON.stringify(result)}`);
  assert.ok(result.offenders.length > 0, "offenders must be non-empty");
  assert.match(result.offenders.join("\n"), /notes\.md/);
});

test("checkChangedFilesWhitespace: no changed files vs base → {ok:true, files:[]}", () => {
  const dir = setupRepo({ pollute: false });
  const result = checkChangedFilesWhitespace("HEAD", dir);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, []);
});

test("checkChangedFilesWhitespace: unresolvable base → {ok:false, error set}", () => {
  const dir = setupRepo({ pollute: false });
  const result = checkChangedFilesWhitespace("origin/main", dir);
  assert.equal(result.ok, false, `unresolvable base must not report ok:true; got: ${JSON.stringify(result)}`);
  assert.ok(result.error, "error field must be set for infra failure");
});
