/**
 * hook-pre-tool-gate-chore-code-size-push.test.mjs
 *
 * End-to-end (plain mode) integration tests for the `chore-code-size-push`
 * blocking gate in pre-tool-gate.mjs, per
 * `openspec/changes/enforce-chore-code-size-limit` (design D4/D5/D9/D10/D11/D15,
 * tasks T4, T6). Case codes (P/T/R/W/F/G and the chained-commit C/U/V/E) follow
 * design D15; the exemption contrast (X1) is the last group, added by T8.
 *
 * TDD note: written RED before the gate is wired into pre-tool-gate.mjs. The
 * cases that must block, and the cases that must show a not-checked advisory,
 * fail with an `[gate-missing]` assertion message until T5 lands. The
 * "must stay silent" cases pass vacuously until then, so every group also holds
 * a positive control (the same fixture shape without the exempting property
 * blocks) to keep the group from staying green forever.
 *
 * Fixture cost control (`test-performance-patterns.md`): ONE bare remote and
 * ONE hub repo per file; every variant is a `git worktree add` branch off it
 * (one spawn). Config variants use `git config --worktree` so the shared
 * `.git/config` is never touched and variants cannot leak into each other.
 * Everything lives under os.tmpdir(); no real repo is read or written.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";
import { SOURCE_BARE_NAME, markSourceCheckout } from "./lib/identity-fixtures.mjs";
// Already part of the hook module's public surface (the cross-model tests import
// it too); importing runs no hook main because the entry is guarded.
import { isChoreAClassExempt } from "../hooks/pre-tool-gate.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(SCRIPT_DIR, "../hooks/pre-tool-gate.mjs");

const tmpRoot = makeTempDir("chore-code-size-push-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// Hermetic git: no user/system config (a developer's global `push.default` or
// `push.autoSetupRemote` would change which pushes are classified as checked),
// and a fixed placeholder identity. Both the fixture git calls and the hook
// subprocess inherit this environment.
const EMPTY_GLOBAL_CONFIG = path.join(tmpRoot, "empty-global.gitconfig");
writeFileSync(EMPTY_GLOBAL_CONFIG, "");
process.env.GIT_CONFIG_GLOBAL = EMPTY_GLOBAL_CONFIG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "fixture";
process.env.GIT_AUTHOR_EMAIL = "fixture-author";
process.env.GIT_COMMITTER_NAME = "fixture";
process.env.GIT_COMMITTER_EMAIL = "fixture-author";

let counter = 0;
const nextId = () => counter++;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`FIXTURE: git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

// ─────────────────────────────────────────────────────────────────────────
// Content helpers
// ─────────────────────────────────────────────────────────────────────────

/** `n` distinct code lines; numstat reports exactly `n` additions. */
function codeLines(n, tag = "v") {
  return Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join("\n") + "\n";
}

/** A NUL-bearing file: git numstat reports `-\t-` (binary) even for `.mjs`. */
function binaryBlob() {
  return Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from("binary\n".repeat(200))]);
}

// ─────────────────────────────────────────────────────────────────────────
// Repo fixtures
// ─────────────────────────────────────────────────────────────────────────

/**
 * A work repo on `main` with a real bare `origin` (so `origin/main` resolves),
 * seeded with a 300-line `.mjs` (renames) and a few documents. No `.devpro/`
 * directory (it would change archive-gate behavior). Fetch is run so the
 * remote-tracking ref reflects the pushed state.
 */
function buildRepo({ worktreeConfig = true } = {}) {
  const root = path.join(tmpRoot, `repo-${nextId()}`);
  const bare = path.join(root, SOURCE_BARE_NAME);
  const work = path.join(root, "work");
  mkdirSync(work, { recursive: true });
  git(root, ["init", "-q", "--bare", "-b", "main", bare]);
  git(work, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(work, "README.md"), "fixture\n");
  writeFileSync(path.join(work, "notes.md"), "line one\nline two\n");
  mkdirSync(path.join(work, "src"), { recursive: true });
  writeFileSync(path.join(work, "src", "legacy-big.mjs"), codeLines(300, "legacy"));
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "init"]);
  git(work, ["remote", "add", "origin", bare]);
  git(work, ["push", "-q", "origin", "main"]);
  git(work, ["fetch", "-q", "origin"]);
  if (worktreeConfig) git(work, ["config", "extensions.worktreeConfig", "true"]);
  markSourceCheckout(work);
  return { root, bare, work };
}

let hubMemo = null;
const hub = () => (hubMemo ??= buildRepo());

/**
 * Create a linked worktree on a NEW branch and commit `files` on it.
 * `files` maps repo-relative path -> string | Buffer. `renames` are applied
 * with `git mv` before the files are written. `--no-track` keeps
 * `branch.<name>.remote/merge` out of the config (it would pollute R cases).
 *
 * @returns {{dir: string, branch: string}}
 */
function makeBranch({ branch, files = {}, renames = [], base = "origin/main", repo = hub(), source = true }) {
  const dir = path.join(tmpRoot, `wt-${nextId()}`);
  git(repo.work, ["worktree", "add", "-q", "--no-track", "-b", branch, dir, base]);
  if (source) markSourceCheckout(dir);
  for (const [from, to] of renames) {
    mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
    git(dir, ["mv", from, to]);
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `fixture: ${branch}`]);
  return { dir, branch };
}

/**
 * A new worktree/branch at `src`'s commit (no new commit, one spawn) whose
 * per-worktree config is set from `config(branch)`.
 */
function variantOf(src, { branch, config = () => ({}) }) {
  const dir = path.join(tmpRoot, `wt-${nextId()}`);
  git(hub().work, ["worktree", "add", "-q", "--no-track", "-b", branch, dir, src.branch]);
  markSourceCheckout(dir);
  for (const [key, value] of Object.entries(config(branch))) {
    git(dir, ["config", "--worktree", key, value]);
  }
  return { dir, branch };
}

const uniq = (prefix, tag) => `${prefix}/refactor-${tag}-${nextId()}`;

/** A bare 101-line code file: the smallest shape the gate must block. */
const OVERSIZED_FILES = () => ({ "src/oversized.mjs": codeLines(101, "big") });

let oversizedMemo = null;
/** Positive control: the plain oversized chore branch (blocks). */
const oversized = () =>
  (oversizedMemo ??= makeBranch({ branch: uniq("chore", "oversized"), files: OVERSIZED_FILES() }));

// Six counted files whose sizes sum to 101; five largest are listed in the
// block reason, the sixth must not be.
const BIG_FILES = {
  "src/alpha.mjs": 40,
  "src/bravo.mjs": 25,
  "src/charlie.mjs": 15,
  "src/delta.mjs": 10,
  "src/echo.mjs": 6,
  "src/foxtrot.mjs": 5,
};
let bigMemo = null;
/** The shared 101-line, six-file chore branch used by most command variants. */
const big = () =>
  (bigMemo ??= makeBranch({
    branch: uniq("chore", "big"),
    files: Object.fromEntries(
      Object.entries(BIG_FILES).map(([rel, n]) => [rel, codeLines(n, path.basename(rel, ".mjs"))])
    ),
  }));

// ─────────────────────────────────────────────────────────────────────────
// Hook runner and assertions
// ─────────────────────────────────────────────────────────────────────────

let frictionCounter = 0;

function runHook(command, cwd, { env = {}, frictionLog } = {}) {
  const payload = { tool_name: "Bash", tool_input: { command } };
  // Sentinel state and friction log live UNDER tmpRoot so after() reclaims them
  // and the developer's real friction log is never appended to.
  const sentinelDir = mkdtempSync(path.join(tmpRoot, "sentinel-"));
  const log = frictionLog ?? path.join(tmpRoot, `friction-${frictionCounter++}.log`);
  const childEnv = {
    ...process.env,
    DEVPRO_SENTINEL_STATE_DIR: sentinelDir,
    DEVPRO_FRICTION_LOG: log,
    DEVPRO_RELEVANT_ARCHIVES: "",
    DEVPRO_AGENT_RULES_LEVEL: "full",
    PWD: cwd,
    ...env,
  };
  delete childEnv.DEVPRO_HOOK_BYPASS; // bypass only via the inline command prefix
  const r = spawnSync("node", [HOOK], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: childEnv,
  });
  let json = null;
  try {
    json = r.stdout ? JSON.parse(r.stdout) : null;
  } catch {}
  const text = [json?.systemMessage, json?.hookSpecificOutput?.additionalContext]
    .filter(Boolean)
    .join("\n");
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json, text, log };
}

const GATE = /Chore code-size push gate/;

function dump(r) {
  return `got: ${JSON.stringify(r.json)}\nstderr: ${r.stderr}`;
}

/** The gate blocks (decision block AND the reason names this gate). */
function expectBlocked(r, label) {
  assert.equal(
    r.json?.decision,
    "block",
    `[gate-missing] ${label}: expected the chore code-size gate to block; ${dump(r)}`
  );
  assert.match(
    r.json?.reason || "",
    GATE,
    `[gate-missing] ${label}: blocked, but not by the chore code-size gate; ${dump(r)}`
  );
}

/** Nothing blocks, and this gate prints nothing (class A: silent). */
function expectSilent(r, label) {
  assert.notEqual(r.json?.decision, "block", `${label}: must not block; ${dump(r)}`);
  assert.doesNotMatch(r.text, GATE, `${label}: must not print a code-size notice; ${dump(r)}`);
}

/** Nothing blocks, and a not-checked advisory with `reason=<token>` is shown. */
function expectUnchecked(r, token, label) {
  assert.notEqual(r.json?.decision, "block", `${label}: not-checked must allow the push; ${dump(r)}`);
  assert.match(
    r.text,
    new RegExp(
      `Chore code-size push gate effective-scope: checked=false cwd=[^\\s/]+ reason=${token}`
    ),
    `[gate-missing] ${label}: expected a not-checked advisory with reason=${token}; ${dump(r)}`
  );
  assert.match(r.text, /Push allowed/, `[gate-missing] ${label}: advisory must say Push allowed`);
}

const changeNameOf = (branch) => branch.replace(/^chore\//, "");

// ─────────────────────────────────────────────────────────────────────────
// Scenario groups
// ─────────────────────────────────────────────────────────────────────────

describe("Scenario: Oversized Chore Lane Push Is Blocked", () => {
  test("P1 101 non-test code lines on chore/x, bare git push -> block with every reason element", () => {
    const b = big();
    const r = runHook("git push", b.dir);
    expectBlocked(r, "P1");
    const reason = r.json?.reason || "";
    // total
    assert.match(reason, /101/, `reason must state the total; got: ${reason}`);
    // the five largest counted files (with additions/deletions), not the sixth
    for (const [rel, n] of Object.entries(BIG_FILES).slice(0, 5)) {
      assert.match(
        reason,
        new RegExp(`${rel.replace(".", "\\.")}\\s+\\+${n}\\s+-0`),
        `reason must list ${rel} with +${n} -0; got: ${reason}`
      );
    }
    assert.doesNotMatch(reason, /foxtrot/, "only the five largest files are listed");
    // counting base: origin/main short SHA, its date, and the merge-base short SHA
    const originMain = git(b.dir, ["rev-parse", "origin/main"]);
    assert.match(reason, /origin\/main/, "reason must name the counting base origin/main");
    assert.ok(
      reason.includes(originMain.slice(0, 7)),
      `reason must carry the origin/main short SHA ${originMain.slice(0, 7)}; got: ${reason}`
    );
    assert.match(reason, /\d{4}-\d{2}-\d{2}/, "reason must carry the origin/main date");
    // both exits
    assert.match(reason, /proposal-mini\.md/);
    assert.match(reason, /proposal\.md/);
    assert.ok(
      reason.includes(`git branch -m ${b.branch} feature/${changeNameOf(b.branch)}`),
      `exit (b) must spell the rename command; got: ${reason}`
    );
    // R3 mitigation: stale-origin/main hint, never an automatic fetch
    assert.match(reason, /git fetch origin/, "reason must hint at a separate git fetch origin");
    // bypass hint
    assert.match(reason, /DEVPRO_HOOK_BYPASS/, "reason must end with the bypass hint");
  });

  test("P2 the block is recorded in the session friction log (one more line)", () => {
    const b = big();
    const frictionLog = path.join(tmpRoot, `friction-p2-${nextId()}.log`);
    // A passing run first: leaves the log untouched, so `before` is well defined.
    runHook("git status", b.dir, { frictionLog });
    const before = existsSync(frictionLog)
      ? readFileSync(frictionLog, "utf8").split("\n").filter(Boolean).length
      : 0;
    const r = runHook("git push", b.dir, { frictionLog });
    expectBlocked(r, "P2");
    const lines = readFileSync(frictionLog, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, before + 1, `friction log must gain exactly one line; got: ${lines}`);
    assert.match(lines[lines.length - 1], GATE, "the logged line must name this gate");
  });

  // A redirect is not a push target: the operator and its separate target
  // token (`> file`, `2> err`) must both be ignored when classifying.
  const redirectCommands = [
    ["P17a operator and target as separate tokens", () => "git push > push.log 2>&1"],
    ["P17b stderr redirect with a separate target", () => "git push 2> push.err"],
    ["P17c append redirect with a separate target", () => "git push >> push.log"],
    ["P17d explicit branch followed by a separate redirect", (b) => `git push origin ${b} > push.log`],
  ];
  for (const [title, build] of redirectCommands) {
    test(`${title} -> still checked and blocked`, () => {
      const b = big();
      expectBlocked(runHook(build(b.branch), b.dir), title);
    });
  }

  test("P17e a redirect does not turn a push that names another branch into a checked one", () => {
    const b = big();
    expectUnchecked(
      runHook("git push origin some-other-branch > push.log", b.dir),
      "push-target-unproven",
      "P17e"
    );
  });
});

describe("Scenario: Boundary And Non-Code Changes Pass", () => {
  test("control: the 101-line oversized shape blocks (keeps this group non-vacuous)", () => {
    const o = oversized();
    expectBlocked(runHook("git push", o.dir), "control");
  });

  test("P3 exactly 100 non-test code lines -> not blocked, silent", () => {
    const b = makeBranch({
      branch: uniq("chore", "p3"),
      files: { "src/exact.mjs": codeLines(100, "exact") },
    });
    expectSilent(runHook("git push", b.dir), "P3");
  });

  test("P4 500 markdown lines -> not blocked, silent", () => {
    const b = makeBranch({
      branch: uniq("chore", "p4"),
      files: { "docs/guide.md": "doc line\n".repeat(500) },
    });
    expectSilent(runHook("git push", b.dir), "P4");
  });

  test("P5 five recognized test path forms, 101 lines each -> not blocked, silent", () => {
    const b = makeBranch({
      branch: uniq("chore", "p5"),
      files: {
        "tests/a-case.mjs": codeLines(101, "a"),
        "pkg/__tests__/b-case.mjs": codeLines(101, "b"),
        "lib/c-case.test.mjs": codeLines(101, "c"),
        "lib/d-case.spec.js": codeLines(101, "d"),
        "scripts/test-suite-manifest.mjs": codeLines(101, "e"),
      },
    });
    expectSilent(runHook("git push", b.dir), "P5");
  });

  test("P6 300-line .mjs pure rename -> not blocked, silent", () => {
    const b = makeBranch({
      branch: uniq("chore", "p6"),
      renames: [["src/legacy-big.mjs", "src/legacy-moved.mjs"]],
    });
    const numstat = git(b.dir, ["diff", "--numstat", "-M", "origin/main", "HEAD"]);
    assert.match(numstat, /^0\t0\t/, `FIXTURE: expected a pure rename in numstat; got: ${numstat}`);
    expectSilent(runHook("git push", b.dir), "P6");
  });

  test("P7 rename combined with 101 changed lines -> still blocked", () => {
    // 51 of 300 lines replaced = 51 additions + 51 deletions = 102 > 100, while
    // the 249 unchanged lines keep git's rename detection (>=50% similar) stable.
    const edited =
      Array.from({ length: 51 }, (_, i) => `export const changed${i} = ${i};`).join("\n") +
      "\n" +
      codeLines(300, "legacy").split("\n").slice(51).join("\n");
    const b = makeBranch({
      branch: uniq("chore", "p7"),
      renames: [["src/legacy-big.mjs", "src/legacy-moved.mjs"]],
      files: { "src/legacy-moved.mjs": edited },
    });
    const numstat = git(b.dir, ["diff", "--numstat", "-M", "origin/main", "HEAD"]);
    assert.match(numstat, /=>/, `FIXTURE: expected a rename record; got: ${numstat}`);
    expectBlocked(runHook("git push", b.dir), "P7");
  });

  test("P8 binary files (NUL bytes in .mjs) count as zero -> not blocked, silent", () => {
    const b = makeBranch({
      branch: uniq("chore", "p8"),
      files: { "assets/blob-one.mjs": binaryBlob(), "assets/blob-two.mjs": binaryBlob() },
    });
    const numstat = git(b.dir, ["diff", "--numstat", "origin/main", "HEAD"]);
    assert.match(numstat, /^-\t-\t/m, `FIXTURE: expected binary numstat; got: ${numstat}`);
    expectSilent(runHook("git push", b.dir), "P8");
  });

  test("P9 .mjs under openspec/changes/archive/ counts as zero -> not blocked, silent", () => {
    const b = makeBranch({
      branch: uniq("chore", "p9"),
      files: {
        "openspec/changes/archive/2026-01-01-refactor-sample/helper.mjs": codeLines(101, "arch"),
      },
    });
    expectSilent(runHook("git push", b.dir), "P9");
  });
});

describe("Scenario: Out-Of-Scope Pushes Stay Silent", () => {
  test("control: the same 101-line code without any exempting property blocks", () => {
    const o = oversized();
    expectBlocked(runHook("git push", o.dir), "control");
  });

  const proposalCases = [
    ["P10 active proposal.md in the committed diff", "openspec/changes/refactor-p10/proposal.md"],
    [
      "P11 active proposal-mini.md in the committed diff",
      "openspec/changes/refactor-p11/proposal-mini.md",
    ],
    [
      "P12 archived proposal.md in the committed diff",
      "openspec/changes/archive/2026-01-01-refactor-p12/proposal.md",
    ],
  ];
  for (const [title, proposalPath] of proposalCases) {
    test(`${title} + 101 code lines -> silent`, () => {
      const b = makeBranch({
        branch: uniq("chore", title.split(" ")[0].toLowerCase()),
        files: { ...OVERSIZED_FILES(), [proposalPath]: "# proposal\n" },
      });
      expectSilent(runHook("git push", b.dir), title);
    });
  }

  test("P13 chore/bump-v1.2.3 with 101 code lines -> silent", () => {
    const b = makeBranch({ branch: "chore/bump-v1.2.3", files: OVERSIZED_FILES() });
    expectSilent(runHook("git push", b.dir), "P13");
  });

  test("P14 feature/x with 101 code lines -> silent", () => {
    const b = makeBranch({ branch: uniq("feature", "p14"), files: OVERSIZED_FILES() });
    expectSilent(runHook("git push", b.dir), "P14");
  });

  test("P15 consumer repo (installed rules) with 101 code lines -> silent", () => {
    const b = makeBranch({
      branch: uniq("chore", "p15"),
      source: false,
      files: {
        ...OVERSIZED_FILES(),
        ".devpro-agent-rules/AGENTS.md": "# rules\n",
        ".devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs": "// sync\n",
      },
    });
    expectSilent(runHook("git push", b.dir), "P15");
  });

  test("P16 --dry-run and -n pushes of the oversized branch -> silent", () => {
    const o = oversized();
    expectSilent(runHook(`git push --dry-run origin ${o.branch}`, o.dir), "P16 --dry-run");
    expectSilent(runHook(`git push -n origin ${o.branch}`, o.dir), "P16 -n");
  });
});

describe("Scenario: Unprovable Push Target Is Not Checked", () => {
  const UNPROVEN = "push-target-unproven";

  // Commands that cannot be proven to include the current branch. Each runs
  // against the shared oversized chore branch, so a wrong "checked" decision
  // would block instead of showing the advisory.
  const unprovenCommands = [
    ["T1 lone --tags", () => "git push --tags"],
    ["T2 HEAD:<chore name> refspec", (b) => `git push origin HEAD:${b}`],
    ["T3 HEAD:other refspec", () => "git push origin HEAD:other-branch"],
    ["T4 src:dst refspec", () => "git push origin src:dst"],
    ["T5 names another branch", () => "git push origin some-other-branch"],
    ["T6 --delete", (b) => `git push --delete origin ${b}`],
    ["T7 --all", () => "git push --all origin"],
    ["T8 --mirror", () => "git push --mirror origin"],
    ["T12a two push clauses (real, real)", (b) => `git push origin ${b} && git push origin ${b}`],
    ["T12b two push clauses (dry-run first, then real)", (b) => `git push -n origin ${b} && git push origin ${b}`],
    ["T13 unknown flag", (b) => `git push --frobnicate origin ${b}`],
    ["T14 URL remote", (b) => `git push https://example.invalid/repo.git ${b}`],
  ];
  for (const [title, build] of unprovenCommands) {
    test(`${title} -> allowed, advisory reason=${UNPROVEN}`, () => {
      const b = big();
      expectUnchecked(runHook(build(b.branch), b.dir), UNPROVEN, title);
    });
  }

  test("T5b pushing a chore branch from a feature-branch worktree is not evaluated (silent, accepted limit)", () => {
    // D4 step 4: a non-chore CURRENT branch is class A. This is the documented
    // "pushed from another branch" limitation, not the T5 not-checked row.
    const b = big();
    const f = variantOf(b, { branch: uniq("feature", "t5b") });
    expectSilent(runHook(`git push origin ${b.branch}`, f.dir), "T5b");
  });

  const configCases = [
    ["T9 push.default=matching", { "push.default": "matching" }],
    ["T10 push.default=nothing", { "push.default": "nothing" }],
    ["T11 remote.origin.push configured", { "remote.origin.push": "refs/heads/*:refs/heads/*" }],
  ];
  for (const [title, cfg] of configCases) {
    test(`${title}, bare git push -> allowed, advisory reason=${UNPROVEN}`, () => {
      const v = variantOf(big(), { branch: uniq("chore", title.split(" ")[0].toLowerCase()), config: () => cfg });
      expectUnchecked(runHook("git push", v.dir), UNPROVEN, title);
    });
  }

  // Provable shapes are still checked: the oversized branch must block.
  const provenCommands = [
    ["T15 bare git push", () => "git push"],
    ["T16 git push origin", () => "git push origin"],
    ["T17 git push -u origin <branch>", (b) => `git push -u origin ${b}`],
    ["T18 git push origin HEAD", () => "git push origin HEAD"],
    ["T19 git push --follow-tags origin <branch>", (b) => `git push --follow-tags origin ${b}`],
    ["T20 git push --force-with-lease origin <branch>", (b) => `git push --force-with-lease origin ${b}`],
  ];
  for (const [title, build] of provenCommands) {
    test(`${title} -> still checked, blocks`, () => {
      const b = big();
      expectBlocked(runHook(build(b.branch), b.dir), title);
    });
  }

  for (const mode of ["simple", "current", "upstream"]) {
    test(`T21 push.default=${mode}, bare git push -> still checked, blocks`, () => {
      const v = variantOf(big(), {
        branch: uniq("chore", `t21-${mode}`),
        config: () => ({ "push.default": mode }),
      });
      expectBlocked(runHook("git push", v.dir), `T21 ${mode}`);
    });
  }
});

describe("Scenario: Effective Remote Is Resolved Before Its Push Configuration", () => {
  const FORK_WITH_PUSH = {
    "remote.fork.url": "/nonexistent/fork.git",
    "remote.fork.push": "refs/heads/*:refs/heads/*",
  };

  test("R1 branch.<b>.pushRemote=fork where remote.fork.push is set, bare push -> not checked", () => {
    const v = variantOf(big(), {
      branch: uniq("chore", "r1"),
      config: (b) => ({ ...FORK_WITH_PUSH, [`branch.${b}.pushRemote`]: "fork" }),
    });
    expectUnchecked(runHook("git push", v.dir), "push-target-unproven", "R1");
  });

  test("R2 remote.pushDefault=fork where remote.fork.push is set, bare push -> not checked", () => {
    const v = variantOf(big(), {
      branch: uniq("chore", "r2"),
      config: () => ({ ...FORK_WITH_PUSH, "remote.pushDefault": "fork" }),
    });
    expectUnchecked(runHook("git push", v.dir), "push-target-unproven", "R2");
  });

  test("R3 explicit `git push origin` takes precedence over pushRemote -> checked, blocks", () => {
    const v = variantOf(big(), {
      branch: uniq("chore", "r3"),
      config: (b) => ({ ...FORK_WITH_PUSH, [`branch.${b}.pushRemote`]: "fork" }),
    });
    expectBlocked(runHook("git push origin", v.dir), "R3");
  });

  test("R4 only branch.<b>.remote=origin, bare push -> checked, blocks", () => {
    const v = variantOf(big(), {
      branch: uniq("chore", "r4"),
      config: (b) => ({ [`branch.${b}.remote`]: "origin" }),
    });
    expectBlocked(runHook("git push", v.dir), "R4");
  });

  test("R5 pushRemote points at a remote that is not configured -> not checked", () => {
    const v = variantOf(big(), {
      branch: uniq("chore", "r5"),
      config: (b) => ({ [`branch.${b}.pushRemote`]: "ghost" }),
    });
    expectUnchecked(runHook("git push", v.dir), "push-target-unproven", "R5");
  });
});

describe("Scenario: Push Is Evaluated In The Directory It Runs In", () => {
  test("W1 `cd <chore worktree> && git push` from the hub checkout (main) -> evaluated there, blocks", () => {
    const b = big();
    expectBlocked(runHook(`cd ${b.dir} && git push`, hub().work), "W1");
  });

  test("W2 `git -C <chore worktree> push` from the hub checkout (main) -> evaluated there, blocks", () => {
    const b = big();
    expectBlocked(runHook(`git -C ${b.dir} push`, hub().work), "W2");
  });

  test("W3 from the oversized chore worktree, `cd <feature worktree> && git push` -> not blocked", () => {
    // The invocation cwd is the oversized chore branch, so a gate that judged
    // baseCwd instead of the push's real directory would block here.
    const b = big();
    const f = variantOf(b, { branch: uniq("feature", "w3") });
    expectSilent(runHook(`cd ${f.dir} && git push`, b.dir), "W3");
  });

  test("W4 `cd $(echo .) && git push` -> allowed, reason=cwd-unresolved", () => {
    const b = big();
    expectUnchecked(runHook("cd $(echo .) && git push", b.dir), "cwd-unresolved", "W4");
  });

  test("W5a first push (no remote-tracking ref) -> block offers `git branch -m`, not the new-branch variant", () => {
    const v = variantOf(big(), { branch: uniq("chore", "w5a") });
    const r = runHook("git push", v.dir);
    expectBlocked(r, "W5a");
    const reason = r.json?.reason || "";
    assert.ok(reason.includes("git branch -m"), `first push must offer git branch -m; got: ${reason}`);
    assert.doesNotMatch(reason, /開新分支/, "first push must not tell the author to open a new branch");
  });

  test("W5b already pushed (refs/remotes/origin/<branch> exists) -> block says open a new branch, not `git branch -m`", () => {
    const v = variantOf(big(), { branch: uniq("chore", "w5b") });
    git(v.dir, ["update-ref", `refs/remotes/origin/${v.branch}`, "HEAD"]);
    const r = runHook("git push", v.dir);
    expectBlocked(r, "W5b");
    const reason = r.json?.reason || "";
    assert.match(reason, /開新分支/, `already-pushed variant must say 開新分支; got: ${reason}`);
    assert.doesNotMatch(reason, /git branch -m/, "already-pushed variant must replace exit (b)");
    assert.match(reason, /proposal/, "exit (a) must remain");
  });
});

// Standalone repos for the infrastructure-uncertainty cases: each one breaks
// something that is shared by every worktree of a repo (refs/remotes/origin/main,
// the merge-base ancestry, an object of the branch tip), so they cannot reuse the hub.
let infraMemo = null;
function infraFixtures() {
  if (infraMemo) return infraMemo;

  // F1: origin/main removed
  const r1 = buildRepo();
  const f1 = makeBranch({ branch: uniq("chore", "f1"), files: OVERSIZED_FILES(), repo: r1 });
  git(f1.dir, ["update-ref", "-d", "refs/remotes/origin/main"]);

  // F2: no common ancestor with origin/main (orphan branch)
  const r2 = buildRepo({ worktreeConfig: false });
  const b2 = uniq("chore", "f2");
  git(r2.work, ["checkout", "-q", "--orphan", b2]);
  git(r2.work, ["rm", "-rfq", "."]);
  mkdirSync(path.join(r2.work, "src"), { recursive: true });
  writeFileSync(path.join(r2.work, "src", "orphan.mjs"), codeLines(101, "orphan"));
  git(r2.work, ["add", "-A"]);
  git(r2.work, ["commit", "-q", "-m", "orphan"]);
  const f2 = { dir: r2.work, branch: b2 };

  // F3: a git subprocess needed for counting fails. Deleting the loose blob of the
  // committed code file keeps rev-parse / config / merge-base working but makes
  // `git diff --numstat` exit 128. (A broken .git/config fails the earlier cwd probes
  // first and shows cwd-unresolved instead; see decisions.md D25.)
  const r3 = buildRepo({ worktreeConfig: false });
  const b3 = uniq("chore", "f3");
  git(r3.work, ["checkout", "-q", "-b", b3]);
  writeFileSync(path.join(r3.work, "src", "over.mjs"), codeLines(101, "over"));
  git(r3.work, ["add", "-A"]);
  git(r3.work, ["commit", "-q", "-m", "over"]);
  const blob = git(r3.work, ["rev-parse", "HEAD:src/over.mjs"]);
  rmSync(path.join(r3.work, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const f3 = { dir: r3.work, branch: b3 };

  return (infraMemo = { f1, f2, f3 });
}

describe("Scenario: Infrastructure Uncertainty Fails Open Visibly", () => {
  test("F1 refs/remotes/origin/main removed -> allowed, reason=base-unresolved", () => {
    const { f1 } = infraFixtures();
    const r = runHook(`git push origin ${f1.branch}`, f1.dir);
    expectUnchecked(r, "base-unresolved", "F1");
    // design D9: base-unresolved lists the attempted range
    assert.match(r.text, /origin\/main\.\.\.HEAD/, "advisory must list the attempted base range");
  });

  test("F2 no common ancestor with origin/main -> allowed, reason=base-unresolved", () => {
    const { f2 } = infraFixtures();
    expectUnchecked(runHook(`git push origin ${f2.branch}`, f2.dir), "base-unresolved", "F2");
  });

  test("F3 unreadable blob object on the branch -> allowed, reason=git-probe-failed", () => {
    const { f3 } = infraFixtures();
    expectUnchecked(runHook(`git push origin ${f3.branch}`, f3.dir), "git-probe-failed", "F3");
  });

  test("F4 no advisory text contains a fixture absolute path (cwd reduced to basename)", () => {
    const { f1, f2, f3 } = infraFixtures();
    const b = big();
    const forbidden = [tmpRoot, realpathSync(tmpRoot)];
    const runs = [
      ["cwd-unresolved", runHook("cd $(echo .) && git push", b.dir), true],
      ["push-target-unproven", runHook("git push --tags", b.dir), true],
      ["base-unresolved (F1)", runHook(`git push origin ${f1.branch}`, f1.dir), true],
      ["base-unresolved (F2)", runHook(`git push origin ${f2.branch}`, f2.dir), true],
      ["git-probe-failed (F3)", runHook(`git push origin ${f3.branch}`, f3.dir), true],
    ];
    for (const [label, r, mustHaveGateAdvisory] of runs) {
      if (mustHaveGateAdvisory) {
        assert.match(
          r.text,
          /Chore code-size push gate effective-scope: checked=false/,
          `[gate-missing] F4 ${label}: expected this gate's advisory to exist; ${dump(r)}`
        );
      }
      for (const root of forbidden) {
        assert.ok(
          !r.text.includes(root) && !(r.json?.reason || "").includes(root),
          `F4 ${label}: advisory must not contain the absolute path ${root}; got: ${r.text}`
        );
      }
    }
  });
});

describe("Scenario: Rigor And Bypass Follow Existing Push Gates", () => {
  test("G1 rigor lite -> the oversized push is still blocked", () => {
    const b = big();
    expectBlocked(runHook("git push", b.dir, { env: { DEVPRO_AGENT_RULES_LEVEL: "lite" } }), "G1");
  });

  test("G2 rigor off -> the oversized push is allowed (control: blocks at full)", () => {
    const b = big();
    expectBlocked(runHook("git push", b.dir), "G2 control");
    expectSilent(runHook("git push", b.dir, { env: { DEVPRO_AGENT_RULES_LEVEL: "off" } }), "G2");
  });

  test("G3 inline DEVPRO_HOOK_BYPASS=1 -> the oversized push is allowed (control: blocks without)", () => {
    const b = big();
    expectBlocked(runHook("git push", b.dir), "G3 control");
    expectSilent(runHook("DEVPRO_HOOK_BYPASS=1 git push", b.dir), "G3");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Chained-commit cases (T6): C / U / V / E
// ─────────────────────────────────────────────────────────────────────────
//
// The hook runs BEFORE the chained `git commit`, so every case here is a
// worktree with uncommitted changes (staged / unstaged / untracked per case).
// The hook only reads, so each case gets its own `git worktree add` branch and
// prepares the dirty state with fs writes plus `git add` / `git rm`.
//
// Chained `git commit` commands carry `--no-edit`: the commit attribution gate
// (checkCommitAttribution) returns an advisory for a commit message without a
// `Rules:` footer, and for a footer in a fixture repo without AGENTS.md, and a
// blocking-runner advisory short-circuits the composite advisory that carries
// this gate's not-checked notice (design D9, decisions D22). `--no-edit` is the
// gate's own "no newly authored message" escape, so these cases see only the
// chore code-size gate. The command text, not git, is what the hook reads.

const LEGACY = "src/legacy-big.mjs"; // tracked 300-line file seeded by buildRepo()
const LEGACY_ORIGINAL = codeLines(300, "legacy");

/**
 * A chore worktree for a chained-commit case. `committed` files are committed on
 * the branch first (so HEAD differs from the merge-base); without any, the
 * branch sits exactly on `base` (HEAD == merge-base, the first-push shape).
 * `prepare(dir)` then builds the uncommitted state.
 */
function dirtyBranch({ branch, committed = {}, base = "origin/main", repo = hub(), prepare }) {
  let b;
  if (Object.keys(committed).length > 0) {
    b = makeBranch({ branch, files: committed, base, repo });
  } else {
    const dir = path.join(tmpRoot, `wt-${nextId()}`);
    git(repo.work, ["worktree", "add", "-q", "--no-track", "-b", branch, dir, base]);
    markSourceCheckout(dir);
    b = { dir, branch };
  }
  if (prepare) prepare(b.dir);
  return b;
}

/** Append `n` distinct code lines to a tracked file (an unstaged `+n` against the merge-base). */
const appendCode = (dir, rel, n, tag = "w") => appendFileSync(path.join(dir, rel), codeLines(n, tag));
const writeIn = (dir, rel, content) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
};

describe("Scenario: Chained Commit Push Uses An Estimate", () => {
  const chainedBlocked = (r, label) => {
    expectBlocked(r, label);
    const reason = r.json?.reason || "";
    assert.match(reason, /估算/, `${label}: the reason must call the number an estimate; got: ${reason}`);
    assert.match(reason, /分開/, `${label}: the reason must suggest separate commit and push; got: ${reason}`);
  };

  test("C1 `git commit -am x --no-edit && git push` with +101 unstaged lines in a tracked file -> block, estimate and 分開 hint", () => {
    const b = dirtyBranch({ branch: uniq("chore", "c1"), prepare: (d) => appendCode(d, LEGACY, 101) });
    chainedBlocked(runHook("git commit -am x --no-edit && git push", b.dir), "C1");
  });

  test("C2 same chain with +100 lines -> not blocked, silent", () => {
    const b = dirtyBranch({ branch: uniq("chore", "c2"), prepare: (d) => appendCode(d, LEGACY, 100) });
    expectSilent(runHook("git commit -am x --no-edit && git push", b.dir), "C2");
  });

  // 101 lines staged, then the working tree is put back: the per-file larger of
  // working-tree and index counts must still see the index side.
  const stagedThenRestored = (n) => (d) => {
    appendCode(d, LEGACY, n);
    git(d, ["add", LEGACY]);
    writeIn(d, LEGACY, LEGACY_ORIGINAL);
  };

  test("C3 +101 lines staged, working tree restored, `git commit -m x --no-edit && git push` -> still block", () => {
    const b = dirtyBranch({ branch: uniq("chore", "c3"), prepare: stagedThenRestored(101) });
    assert.equal(git(b.dir, ["diff", "--numstat", "origin/main"]), "", "FIXTURE: working tree must equal the merge-base");
    assert.match(git(b.dir, ["diff", "--cached", "--numstat"]), /^101\t0\t/, "FIXTURE: index must hold +101");
    chainedBlocked(runHook("git commit -m x --no-edit && git push", b.dir), "C3");
  });

  test("C4 +100 lines staged, working tree restored -> not blocked, silent", () => {
    const b = dirtyBranch({ branch: uniq("chore", "c4"), prepare: stagedThenRestored(100) });
    expectSilent(runHook("git commit -m x --no-edit && git push", b.dir), "C4");
  });

  test("C5 path-limited `git commit -m x -- <file> && git push` of a +101 file -> block", () => {
    const b = dirtyBranch({ branch: uniq("chore", "c5"), prepare: (d) => appendCode(d, LEGACY, 101) });
    chainedBlocked(runHook(`git commit -m x --no-edit -- ${LEGACY} && git push`, b.dir), "C5");
  });
});

describe("Scenario: Chained Add Counts Untracked Code Files", () => {
  const UNTRACKED = "src/untracked-new.mjs";

  test("U1 `git add -A && git commit -m x --no-edit && git push` with an untracked 101-line .mjs -> block", () => {
    const b = dirtyBranch({
      branch: uniq("chore", "u1"),
      prepare: (d) => writeIn(d, UNTRACKED, codeLines(101, "u")),
    });
    expectBlocked(runHook("git add -A && git commit -m x --no-edit && git push", b.dir), "U1");
  });

  test("U2 the same chain with a 100-line untracked file -> not blocked, silent", () => {
    const b = dirtyBranch({
      branch: uniq("chore", "u2"),
      prepare: (d) => writeIn(d, UNTRACKED, codeLines(100, "u")),
    });
    expectSilent(runHook("git add -A && git commit -m x --no-edit && git push", b.dir), "U2");
  });

  test("U3 `git commit -a && git push` (no git add) with an untracked 101-line file -> not blocked, silent", () => {
    const b = dirtyBranch({
      branch: uniq("chore", "u3"),
      prepare: (d) => writeIn(d, UNTRACKED, codeLines(101, "u")),
    });
    expectSilent(runHook("git commit -am x --no-edit && git push", b.dir), "U3");
  });

  test("U4 untracked symlink, binary and test files count as zero (100 real lines stay at 100) -> silent", () => {
    // 100 counted lines + a symlink to a 101-line file outside the repo, a binary
    // .mjs and a 101-line test file: counting any of the three would exceed 100.
    const outside = path.join(tmpRoot, `outside-${nextId()}.mjs`);
    writeFileSync(outside, codeLines(101, "outside"));
    const b = dirtyBranch({
      branch: uniq("chore", "u4"),
      prepare: (d) => {
        writeIn(d, "src/real.mjs", codeLines(100, "real"));
        symlinkSync(outside, path.join(d, "src", "linked.mjs"));
        writeIn(d, "src/blob.mjs", binaryBlob());
        writeIn(d, "tests/big-case.mjs", codeLines(101, "t"));
      },
    });
    expectSilent(runHook("git add -A && git commit -m x --no-edit && git push", b.dir), "U4");
  });

  test("U5 101-line untracked file whose last line has no trailing newline -> block", () => {
    const noFinalNewline = codeLines(101, "u").slice(0, -1);
    const b = dirtyBranch({
      branch: uniq("chore", "u5"),
      prepare: (d) => writeIn(d, UNTRACKED, noFinalNewline),
    });
    expectBlocked(runHook("git add -A && git commit -m x --no-edit && git push", b.dir), "U5");
  });
});

// V2 needs HEAD == merge-base while origin/main already carries 101 code lines,
// so the branch is cut from a pushed 101-line commit. A standalone repo keeps
// that origin/main tip out of the shared hub.
let amendMemo = null;
function amendFixture() {
  if (amendMemo) return amendMemo;
  const repo = buildRepo({ worktreeConfig: false });
  writeIn(repo.work, "src/upstream-big.mjs", codeLines(101, "upstream"));
  git(repo.work, ["add", "-A"]);
  git(repo.work, ["commit", "-q", "-m", "upstream 101 lines"]);
  git(repo.work, ["push", "-q", "origin", "main"]);
  git(repo.work, ["fetch", "-q", "origin"]);
  const b = dirtyBranch({
    branch: uniq("chore", "v2"),
    repo,
    prepare: (d) => appendCode(d, LEGACY, 5),
  });
  assert.equal(
    git(b.dir, ["rev-parse", "HEAD"]),
    git(b.dir, ["merge-base", "origin/main", "HEAD"]),
    "FIXTURE: HEAD must equal the merge-base"
  );
  return (amendMemo = b);
}

describe("Scenario: Unsupported Chained Command Is Not Checked", () => {
  const CHAINED = "chained-command-unsupported";

  // V1: one verb outside add/commit before the push. The branch is the shared
  // 101-line chore branch, so a wrongly "checked" decision would block.
  const unsupportedVerbs = [
    ["rebase", "git rebase origin/main && git push"],
    ["stash", "git stash && git push"],
    ["restore", "git restore . && git push"],
    ["fetch", "git fetch origin && git push"],
  ];
  for (const [verb, command] of unsupportedVerbs) {
    test(`V1 \`${command}\` -> allowed, advisory reason=${CHAINED}`, () => {
      expectUnchecked(runHook(command, big().dir), CHAINED, `V1 ${verb}`);
    });
  }

  test("V2 HEAD equals the merge-base and the chain amends -> allowed, reason=amend-rewrites-merge-base", () => {
    const b = amendFixture();
    expectUnchecked(
      runHook("git commit -a --amend --no-edit && git push", b.dir),
      "amend-rewrites-merge-base",
      "V2"
    );
  });

  test("V3 `--amend` while HEAD is NOT the merge-base is estimated normally (+101 uncommitted -> block)", () => {
    const b = dirtyBranch({
      branch: uniq("chore", "v3"),
      committed: { "src/small.mjs": codeLines(3, "small") },
      prepare: (d) => appendCode(d, LEGACY, 101),
    });
    assert.notEqual(
      git(b.dir, ["rev-parse", "HEAD"]),
      git(b.dir, ["merge-base", "origin/main", "HEAD"]),
      "FIXTURE: HEAD must differ from the merge-base"
    );
    expectBlocked(runHook("git commit -a --amend --no-edit && git push", b.dir), "V3");
  });

  test("V4 a chained git command that targets another directory -> allowed, reason=chained-command-unsupported", () => {
    const b = big();
    const other = variantOf(b, { branch: uniq("feature", "v4") });
    expectUnchecked(runHook(`git -C ${other.dir} commit -am x --no-edit && git push`, b.dir), CHAINED, "V4");
  });

  // V5/V6: a branch switch before the push, from a non-chore current branch.
  // chore/large exists locally with 101 committed lines but has no worktree.
  const switchFixture = (() => {
    let memo = null;
    return () => {
      if (memo) return memo;
      const large = makeBranch({ branch: uniq("chore", "large"), files: OVERSIZED_FILES() });
      git(hub().work, ["worktree", "remove", "--force", large.dir]);
      const feature = dirtyBranch({ branch: uniq("feature", "v5") });
      return (memo = { large: large.branch, feature });
    };
  })();

  test("V5 in a feature worktree, `git switch <chore/large> && git push` -> not blocked, reason=chained-command-unsupported", () => {
    const { large, feature } = switchFixture();
    expectUnchecked(runHook(`git switch ${large} && git push`, feature.dir), CHAINED, "V5 switch");
  });

  test("V5 in a feature worktree, `git switch -c chore/large && git push` -> not blocked, reason=chained-command-unsupported", () => {
    const { feature } = switchFixture();
    expectUnchecked(runHook("git switch -c chore/large-new && git push", feature.dir), CHAINED, "V5 switch -c");
  });

  test("V5 in a feature worktree, `git switch - && git push` -> not blocked, reason=chained-command-unsupported", () => {
    const { feature } = switchFixture();
    expectUnchecked(runHook("git switch - && git push", feature.dir), CHAINED, "V5 switch -");
  });

  test("V6 `git checkout -b feature/new && git push -u origin HEAD` -> not blocked, same advisory (accepted noise)", () => {
    const { feature } = switchFixture();
    expectUnchecked(
      runHook("git checkout -b feature/new && git push -u origin HEAD", feature.dir),
      CHAINED,
      "V6"
    );
  });

  test("V7 `git checkout -- README.md` and `git checkout HEAD -- README.md` are path forms, not branch switches -> silent on a feature branch", () => {
    const { feature } = switchFixture();
    expectSilent(runHook("git checkout -- README.md && git push", feature.dir), "V7 checkout --");
    expectSilent(runHook("git checkout HEAD -- README.md && git push", feature.dir), "V7 checkout HEAD --");
  });
});

describe("Scenario: Read-Only Git Commands In The Chain Do Not Make The Check Not Checked", () => {
  const CHAINED = "chained-command-unsupported";
  const READ_ONLY = [
    "git status",
    "git status --short --branch",
    "git diff --stat",
    "git log --oneline -3",
    "git show --stat HEAD",
    "git rev-parse HEAD",
    "git ls-files",
    "git branch --show-current",
  ];

  for (const readOnly of READ_ONLY) {
    test(`R1 \`${readOnly} && git push\` on the 101-line chore branch -> block (it used to be not checked)`, () => {
      expectBlocked(runHook(`${readOnly} && git push`, big().dir), `R1 ${readOnly}`);
    });
  }

  test("R2 several read-only commands before the push -> block", () => {
    expectBlocked(
      runHook("git status && git diff --stat && git log --oneline -3 && git push", big().dir),
      "R2"
    );
  });

  test("R3 a read-only command next to a chained commit keeps the estimate: +101 -> block, +100 -> silent", () => {
    const over = dirtyBranch({ branch: uniq("chore", "r3a"), prepare: (d) => appendCode(d, LEGACY, 101) });
    const blocked = runHook("git status && git commit -am x --no-edit && git push", over.dir);
    expectBlocked(blocked, "R3 +101");
    assert.match(blocked.json?.reason || "", /估算/, "R3: the reason must call the number an estimate");
    const within = dirtyBranch({ branch: uniq("chore", "r3b"), prepare: (d) => appendCode(d, LEGACY, 100) });
    expectSilent(runHook("git status && git commit -am x --no-edit && git push", within.dir), "R3 +100");
  });

  test("R4 a read-only command that targets another directory does not matter -> block", () => {
    const b = big();
    const other = variantOf(b, { branch: uniq("feature", "r4") });
    expectBlocked(runHook(`git -C ${other.dir} status && git push`, b.dir), "R4");
  });

  test("R4b a redirect on the read-only command does not change its class -> block", () => {
    for (const command of [
      "git branch --show-current 2>/dev/null && git push",
      "git status 2>&1 && git push",
      "git rev-parse HEAD > /dev/null && git push",
    ]) {
      expectBlocked(runHook(command, big().dir), `R4b ${command}`);
    }
  });

  test("R5 a within-limit branch with a read-only command stays silent", () => {
    const b = makeBranch({ branch: uniq("chore", "r5"), files: { "src/ok.mjs": codeLines(100, "ok") } });
    expectSilent(runHook("git status && git push", b.dir), "R5");
  });

  test("R6 `git fetch` is not read-only (it moves origin/main) -> not checked, even next to a read-only command", () => {
    expectUnchecked(runHook("git fetch origin && git status && git push", big().dir), CHAINED, "R6 fetch");
    expectUnchecked(runHook("git status && git fetch origin && git push", big().dir), CHAINED, "R6 fetch last");
  });

  test("R7 other branch forms and `--output` are not read-only -> not checked", () => {
    for (const command of [
      "git branch old-branch && git push",
      "git branch -d old-branch && git push",
      "git diff --output=src/written.mjs && git push",
      "git log --output=src/written.mjs && git push",
      "git status && git rebase origin/main && git push",
    ]) {
      expectUnchecked(runHook(command, big().dir), CHAINED, `R7 ${command}`);
    }
  });
});

describe("Scenario: Chained Proposal Evidence Requires A Committed Unmodified Proposal", () => {
  const PROPOSAL = "openspec/changes/refactor-evidence/proposal-mini.md";
  const proposalCommitted = () => ({ [PROPOSAL]: "# proposal\n" });
  const FIRST_THEN_COMMIT = "git add -A && git commit -m x --no-edit && git push";

  const assertAskForProposalFirst = (r, label) => {
    expectBlocked(r, label);
    const reason = r.json?.reason || "";
    assert.match(reason, /先 commit proposal/, `${label}: the reason must say to commit the proposal first; got: ${reason}`);
  };

  test("E1 proposal added in the same chain + 101 lines -> block, reason says 先 commit proposal", () => {
    const b = dirtyBranch({
      branch: uniq("chore", "e1"),
      prepare: (d) => {
        appendCode(d, LEGACY, 101);
        writeIn(d, PROPOSAL, "# proposal\n");
      },
    });
    assertAskForProposalFirst(runHook(FIRST_THEN_COMMIT, b.dir), "E1");
  });

  test("E2 proposal committed earlier and untouched, then `git commit -am x --no-edit && git push` with +101 lines -> silent", () => {
    const b = dirtyBranch({
      branch: uniq("chore", "e2"),
      committed: proposalCommitted(),
      prepare: (d) => appendCode(d, LEGACY, 101),
    });
    expectSilent(runHook("git commit -am x --no-edit && git push", b.dir), "E2");
  });

  // E3-E6: the committed proposal is disturbed, so it is no evidence.
  const deleteProposal = (d) => {
    appendCode(d, LEGACY, 101);
    rmSync(path.join(d, PROPOSAL));
  };

  test("E3 committed proposal deleted in the working tree, `git commit -a && git push` +101 -> block", () => {
    const b = dirtyBranch({ branch: uniq("chore", "e3"), committed: proposalCommitted(), prepare: deleteProposal });
    assertAskForProposalFirst(runHook("git commit -am x --no-edit && git push", b.dir), "E3");
  });

  test("E4 same disturbed proposal, `git add -A && git commit -m x --no-edit && git push` -> block", () => {
    const b = dirtyBranch({ branch: uniq("chore", "e4"), committed: proposalCommitted(), prepare: deleteProposal });
    assertAskForProposalFirst(runHook(FIRST_THEN_COMMIT, b.dir), "E4");
  });

  test("E5 same disturbed proposal, `git commit -a --amend --no-edit && git push` (HEAD is not the merge-base) -> block", () => {
    const b = dirtyBranch({ branch: uniq("chore", "e5"), committed: proposalCommitted(), prepare: deleteProposal });
    assertAskForProposalFirst(runHook("git commit -a --amend --no-edit && git push", b.dir), "E5");
  });

  test("E6 proposal edit staged then restored in the working tree, `git add -A && git commit` +101 -> block", () => {
    const b = dirtyBranch({
      branch: uniq("chore", "e6"),
      committed: proposalCommitted(),
      prepare: (d) => {
        appendCode(d, LEGACY, 101);
        writeIn(d, PROPOSAL, "# proposal\nedited\n");
        git(d, ["add", PROPOSAL]);
        writeIn(d, PROPOSAL, "# proposal\n");
      },
    });
    assert.match(git(b.dir, ["status", "--porcelain", "--", PROPOSAL]), /^MM /, "FIXTURE: proposal edit staged, working tree restored");
    assertAskForProposalFirst(runHook(FIRST_THEN_COMMIT, b.dir), "E6");
  });

  // E7: `git add -A -- src` and `git add -N` leave the E1 / E2 conclusions alone.
  const addForms = [
    ["git add -A -- src", "git add -A -- src && git commit -m x --no-edit && git push"],
    ["git add -N", `git add -N ${PROPOSAL} src/intent.mjs && git commit -m x --no-edit && git push`],
  ];
  for (const [label, command] of addForms) {
    test(`E7 \`${label}\` keeps the E1 conclusion (proposal added in the chain is no evidence) -> block`, () => {
      const b = dirtyBranch({
        branch: uniq("chore", "e7a"),
        prepare: (d) => {
          appendCode(d, LEGACY, 101);
          writeIn(d, PROPOSAL, "# proposal\n");
          writeIn(d, "src/intent.mjs", codeLines(1, "intent"));
        },
      });
      assertAskForProposalFirst(runHook(command, b.dir), `E7 ${label} (E1 shape)`);
    });

    test(`E7 \`${label}\` keeps the E2 conclusion (proposal committed and untouched is evidence) -> silent`, () => {
      const b = dirtyBranch({
        branch: uniq("chore", "e7b"),
        committed: proposalCommitted(),
        prepare: (d) => {
          appendCode(d, LEGACY, 101);
          writeIn(d, "src/intent.mjs", codeLines(1, "intent"));
        },
      });
      expectSilent(runHook(command.replace(` ${PROPOSAL}`, ""), b.dir), `E7 ${label} (E2 shape)`);
    });
  }
});

describe("Scenario: Existing Exemption Functions Are Reused Unchanged", () => {
  // X1 (design D12/D15): the gate's in-scope decision is the result of
  // `isChoreAClassExempt(branch, files)` itself. The expectation is computed by
  // calling the real function on the files the branch really committed, so no
  // second copy of its proposal-path pattern lives here.
  const committedFiles = (b) =>
    git(b.dir, ["diff", "--name-only", "origin/main...HEAD"]).split("\n").filter(Boolean);

  const variants = [
    ["proposal.md", { "openspec/changes/x/proposal.md": "# proposal\n" }, true],
    ["proposal-mini.md", { "openspec/changes/x/proposal-mini.md": "# proposal-mini\n" }, true],
    ["no proposal file", {}, false],
  ];
  for (const [label, extra, proposalPresent] of variants) {
    test(`X1 chore/x + 101 code lines + ${label} -> hook blocks exactly when isChoreAClassExempt says in scope`, () => {
      const b = makeBranch({
        branch: uniq("chore", "x1"),
        files: { ...OVERSIZED_FILES(), ...extra },
      });
      const files = committedFiles(b);
      const inScope = isChoreAClassExempt(b.branch, files);
      // Literal guard so the comparison cannot pass by both sides being wrong.
      assert.equal(inScope, !proposalPresent, `isChoreAClassExempt for [${files}]`);
      const r = runHook("git push", b.dir);
      if (inScope) expectBlocked(r, `X1 ${label}`);
      else expectSilent(r, `X1 ${label}`);
    });
  }

  test("X1 chore/bump-v<X.Y.Z>: isChoreAClassExempt says in scope, the gate excludes it explicitly -> silent", () => {
    const b = makeBranch({ branch: "chore/bump-v2.3.4", files: OVERSIZED_FILES() });
    const files = committedFiles(b);
    assert.equal(isChoreAClassExempt(b.branch, files), true, "the function only reads the prefix");
    expectSilent(runHook("git push", b.dir), "X1 bump");
  });
});

describe("Scenario: A Foreign Proposal Edited In Place Does Not Lift The Chore Lane (#3333)", () => {
  // The merge gate keeps the chore-A exemption for a PR that only edits another change's
  // proposal in place (documentation fix); the push gate MUST classify the same diff the
  // same way, or a 101-code-line chore could carry a one-line proposal edit past this gate
  // and still be exempt from the second review at merge time.
  const FOREIGN = "openspec/changes/other-change/proposal.md";
  const SEED = "# proposal\nrelease: 2026-09-01\n";
  const EDITED = "# proposal\nrelease: 2026-10-01\n";

  /** A fresh repo whose origin/main already carries `changes`' proposals. */
  function repoSeededWith(...proposalPaths) {
    const repo = buildRepo();
    for (const rel of proposalPaths) {
      mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true });
      writeFileSync(path.join(repo.work, rel), SEED);
    }
    git(repo.work, ["add", "-A"]);
    git(repo.work, ["commit", "-q", "-m", "seed proposals"]);
    git(repo.work, ["push", "-q", "origin", "main"]);
    git(repo.work, ["fetch", "-q", "origin"]);
    return repo;
  }

  test("X2 chore + 101 code lines + one-line edit of another change's proposal -> block (not lifted)", () => {
    const repo = repoSeededWith(FOREIGN);
    const b = makeBranch({
      branch: uniq("chore", "x2"),
      files: { ...OVERSIZED_FILES(), [FOREIGN]: EDITED },
      repo,
    });
    assert.match(git(b.dir, ["diff", "--name-status", "origin/main...HEAD"]), new RegExp(`^M\\t${FOREIGN}$`, "m"), "FIXTURE: the proposal must be a pure modification");
    expectBlocked(runHook("git push", b.dir), "X2");
  });

  test("X2 control: the same edit on the branch's OWN change's proposal is evidence -> silent", () => {
    const name = `refactor-x2own-${nextId()}`;
    const own = `openspec/changes/${name}/proposal.md`;
    const repo = repoSeededWith(own);
    const b = makeBranch({
      branch: `chore/${name}`,
      files: { ...OVERSIZED_FILES(), [own]: EDITED },
      repo,
    });
    expectSilent(runHook("git push", b.dir), "X2 own change");
  });

  test("X2 control: a foreign proposal that is ADDED is evidence -> silent", () => {
    const b = makeBranch({
      branch: uniq("chore", "x2add"),
      files: { ...OVERSIZED_FILES(), [FOREIGN]: SEED },
    });
    expectSilent(runHook("git push", b.dir), "X2 added");
  });

  test("X2 control: a foreign proposal that is DELETED is evidence -> silent", () => {
    const repo = repoSeededWith(FOREIGN);
    const dir = path.join(tmpRoot, `wt-${nextId()}`);
    const branch = uniq("chore", "x2del");
    git(repo.work, ["worktree", "add", "-q", "--no-track", "-b", branch, dir, "origin/main"]);
    markSourceCheckout(dir);
    git(dir, ["rm", "-q", FOREIGN]);
    writeFileSync(path.join(dir, "src-oversized.mjs"), codeLines(101, "big"));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "fixture: delete foreign proposal"]);
    expectSilent(runHook("git push", dir), "X2 deleted");
  });

  test("X2 control: a foreign proposal renamed away to a non-proposal path is evidence -> silent", () => {
    const repo = repoSeededWith(FOREIGN);
    const b = makeBranch({
      branch: uniq("chore", "x2ren"),
      files: OVERSIZED_FILES(),
      renames: [[FOREIGN, "docs/moved-proposal.md"]],
      repo,
    });
    expectSilent(runHook("git push", b.dir), "X2 renamed away");
  });

  test("X3 chained commit: a committed in-place edit of another change's proposal is NOT evidence -> block", () => {
    const repo = repoSeededWith(FOREIGN);
    const b = dirtyBranch({
      branch: uniq("chore", "x3"),
      committed: { [FOREIGN]: EDITED },
      repo,
      prepare: (d) => appendCode(d, LEGACY, 101),
    });
    const r = runHook("git commit -am x --no-edit && git push", b.dir);
    expectBlocked(r, "X3");
  });

  test("X3 control: a committed foreign proposal that is ADDED and untouched is evidence -> silent", () => {
    const b = dirtyBranch({
      branch: uniq("chore", "x3add"),
      committed: { [FOREIGN]: SEED },
      prepare: (d) => appendCode(d, LEGACY, 101),
    });
    expectSilent(runHook("git commit -am x --no-edit && git push", b.dir), "X3 added");
  });
});
