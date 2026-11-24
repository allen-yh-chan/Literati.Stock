/**
 * chore-code-size-gate.test.mjs
 *
 * Unit tables for `hooks/lib/chore-code-size-gate.mjs` (design D2-D6, D15 unit
 * section of enforce-chore-code-size-limit). Pure functions only: nothing here
 * spawns a child process. The git-backed helpers (`countCommitted`,
 * `estimateChained`, `countUntrackedCodeLines`) are covered by the
 * integration test file `hook-pre-tool-gate-chore-code-size-push.test.mjs`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHORE_CODE_SIZE_LIMIT,
  CHORE_CODE_SIZE_NOT_CHECKED,
  CHORE_CODE_SIZE_NOT_CHECKED_REMEDY,
  CODE_FILE_EXTENSIONS,
  classifyChain,
  classifyPushTarget,
  countFileLines,
  hasBranchSwitchVerb,
  isCountedCodePath,
  isTestCodePath,
  parseGitConfigListZ,
  parseNumstatZ,
  parseStatusPathsZ,
  resolveEffectiveRemote,
  topFiles,
} from "../hooks/lib/chore-code-size-gate.mjs";

const HELPER_PATH = fileURLToPath(
  new URL("../hooks/lib/chore-code-size-gate.mjs", import.meta.url),
);

// Build a parsed config the same way the gate does: from `git config --list -z`
// text (`key\nvalue\0` records).
function cfg(...pairs) {
  return parseGitConfigListZ(pairs.map(([k, v]) => `${k}\n${v}\0`).join(""));
}

const BASE_CONFIG = () =>
  cfg(["remote.origin.url", "https://example.invalid/r.git"]);

// ── constants ───────────────────────────────────────────────────────────────

test("constants: limit is 100 and extension list is the approved set", () => {
  assert.equal(CHORE_CODE_SIZE_LIMIT, 100);
  assert.deepEqual(
    [...CODE_FILE_EXTENSIONS],
    ["mjs", "cjs", "js", "ts", "tsx", "jsx", "sh", "py", "ps1"],
  );
});

test("not-checked reasons: closed set of 7 tokens, each with a remedy", () => {
  const tokens = Object.values(CHORE_CODE_SIZE_NOT_CHECKED).sort();
  assert.deepEqual(tokens, [
    "amend-rewrites-merge-base",
    "base-unresolved",
    "chained-command-unsupported",
    "cwd-unresolved",
    "gate-error",
    "git-probe-failed",
    "push-target-unproven",
  ]);
  assert.deepEqual(
    Object.keys(CHORE_CODE_SIZE_NOT_CHECKED_REMEDY).sort(),
    tokens,
  );
  for (const token of tokens) {
    const remedy = CHORE_CODE_SIZE_NOT_CHECKED_REMEDY[token];
    assert.equal(typeof remedy, "string");
    assert.ok(remedy.length > 0, token);
    assert.ok(!remedy.includes("undefined"), token);
  }
  assert.ok(Object.isFrozen(CHORE_CODE_SIZE_NOT_CHECKED));
  assert.ok(Object.isFrozen(CHORE_CODE_SIZE_NOT_CHECKED_REMEDY));
});

// ── path judgments (D2) ─────────────────────────────────────────────────────

test("isTestCodePath: test directories, test/spec file names and the manifest", () => {
  const yes = [
    "tests/a.mjs",
    ".devpro/scripts/tests/foo.mjs",
    "src/__tests__/y.js",
    "__tests__/z.ts",
    "a/b.test.mjs",
    "a/b.spec.ts",
    "x.test.js",
    ".devpro/scripts/test-suite-manifest.mjs",
    "test-suite-manifest.mjs",
  ];
  for (const p of yes) assert.equal(isTestCodePath(p), true, p);
});

test("isTestCodePath: near misses are NOT test code (contests/, singular test/)", () => {
  const no = [
    "contests/x.mjs",
    "mytests/x.mjs",
    "test/x.mjs",
    "src/latest/x.mjs",
    "src/testing.mjs",
    "a/b.tests.mjs",
    "a/foo-test-suite-manifest.mjs",
    "a/test-suite-manifest.mjs.bak",
    "scripts/run.mjs",
  ];
  for (const p of no) assert.equal(isTestCodePath(p), false, p);
});

test("isCountedCodePath: every approved extension counts", () => {
  for (const ext of CODE_FILE_EXTENSIONS) {
    assert.equal(isCountedCodePath(`src/app.${ext}`), true, ext);
  }
});

test("isCountedCodePath: other extensions and case variants do not count", () => {
  const no = [
    "README.md",
    "a.json",
    "a.yaml",
    "a.yml",
    "a.mjsx",
    "a.cs",
    "a.MJS",
    "a.Js",
    "script",
    "dir.mjs/readme.txt",
  ];
  for (const p of no) assert.equal(isCountedCodePath(p), false, p);
});

test("isCountedCodePath: test code never counts", () => {
  const no = [
    "tests/a.mjs",
    ".devpro/scripts/tests/hook-x.test.mjs",
    "src/__tests__/y.js",
    "a/b.spec.ts",
    ".devpro/scripts/test-suite-manifest.mjs",
  ];
  for (const p of no) assert.equal(isCountedCodePath(p), false, p);
});

test("isCountedCodePath: near-miss test names still count (contests/, singular test/)", () => {
  assert.equal(isCountedCodePath("contests/x.mjs"), true);
  assert.equal(isCountedCodePath("test/x.mjs"), true);
  assert.equal(isCountedCodePath(".devpro/scripts/hooks/lib/x.mjs"), true);
});

test("isCountedCodePath: openspec/changes/archive/ is excluded, active change code counts", () => {
  assert.equal(
    isCountedCodePath("openspec/changes/archive/2026-10-01-foo/helper.mjs"),
    false,
  );
  assert.equal(isCountedCodePath("openspec/changes/archive/x.sh"), false);
  assert.equal(isCountedCodePath("openspec/changes/foo/helper.mjs"), true);
  // `archive` only as a deeper segment is not the archive directory.
  assert.equal(isCountedCodePath("src/openspec/changes/archive/x.mjs"), true);
});

// ── parseNumstatZ (D2, D3) ──────────────────────────────────────────────────

test("parseNumstatZ: empty output yields no entries", () => {
  assert.deepEqual(parseNumstatZ(""), []);
});

test("parseNumstatZ: plain records", () => {
  const out = parseNumstatZ("3\t1\tsrc/a.mjs\0" + "10\t0\tdocs/b.md\0");
  assert.equal(out.length, 2);
  assert.deepEqual(
    { path: out[0].path, added: out[0].added, deleted: out[0].deleted },
    { path: "src/a.mjs", added: 3, deleted: 1 },
  );
  assert.equal(out[0].count, 4);
  assert.equal(out[0].binary, false);
  assert.equal(out[0].oldPath, null);
  assert.equal(out[1].path, "docs/b.md");
  assert.equal(out[1].count, 10);
});

test("parseNumstatZ: a pure deletion keeps the deleted path and counts the deleted lines", () => {
  const [e] = parseNumstatZ("0\t7\told/gone.mjs\0");
  assert.equal(e.path, "old/gone.mjs");
  assert.equal(e.count, 7);
});

test("parseNumstatZ: rename takes the new path and keeps the old one", () => {
  const [e] = parseNumstatZ("0\t0\t\0src/old.mjs\0src/new.mjs\0");
  assert.equal(e.path, "src/new.mjs");
  assert.equal(e.oldPath, "src/old.mjs");
  assert.equal(e.count, 0);
});

test("parseNumstatZ: rename with content edits counts the edits", () => {
  const [e] = parseNumstatZ("5\t2\t\0a.mjs\0b.mjs\0");
  assert.equal(e.path, "b.mjs");
  assert.equal(e.added, 5);
  assert.equal(e.deleted, 2);
  assert.equal(e.count, 7);
});

test("parseNumstatZ: binary records count as 0 and are flagged", () => {
  const [e] = parseNumstatZ("-\t-\tassets/logo.png\0");
  assert.equal(e.path, "assets/logo.png");
  assert.equal(e.binary, true);
  assert.equal(e.count, 0);
  assert.equal(e.added, 0);
  assert.equal(e.deleted, 0);
});

test("parseNumstatZ: tab and newline inside a path survive -z parsing", () => {
  const out = parseNumstatZ("1\t2\tdir/a\tb\nc.mjs\0" + "4\t0\tplain.mjs\0");
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "dir/a\tb\nc.mjs");
  assert.equal(out[0].count, 3);
  assert.equal(out[1].path, "plain.mjs");
});

test("parseNumstatZ: tab and newline inside rename paths", () => {
  const [e] = parseNumstatZ("0\t0\t\0o\tld\n.mjs\0n\tew\n.mjs\0");
  assert.equal(e.oldPath, "o\tld\n.mjs");
  assert.equal(e.path, "n\tew\n.mjs");
});

test("parseNumstatZ: mixed plain, rename and binary keep the cursor aligned", () => {
  const out = parseNumstatZ(
    "1\t1\ta.mjs\0" + "0\t0\t\0x.mjs\0y.mjs\0" + "-\t-\tb.bin\0" + "2\t0\tz.sh\0",
  );
  assert.deepEqual(
    out.map((e) => e.path),
    ["a.mjs", "y.mjs", "b.bin", "z.sh"],
  );
  assert.deepEqual(
    out.map((e) => e.count),
    [2, 0, 0, 2],
  );
});

test("parseNumstatZ: malformed record throws instead of silently under-counting", () => {
  assert.throws(() => parseNumstatZ("not-a-numstat\0"));
  assert.throws(() => parseNumstatZ("\t\tpath.mjs\0"));
  assert.throws(() => parseNumstatZ("-\t3\tpath.mjs\0"));
  assert.throws(() => parseNumstatZ("3\t-\tpath.mjs\0"));
  assert.throws(() => parseNumstatZ("-3\t1\tpath.mjs\0"));
  assert.throws(() => parseNumstatZ("0x10\t1\tpath.mjs\0"));
  assert.throws(() => parseNumstatZ("0\t0\t\0only-old.mjs\0"));
});

// ── parseGitConfigListZ (D3, D5) ────────────────────────────────────────────

test("parseGitConfigListZ: key/value records, section and variable lowercased, subsection kept", () => {
  const config = parseGitConfigListZ(
    "Remote.Origin.URL\nhttps://example.invalid/r.git\0" +
      "branch.Chore/X.PushRemote\nfork\0" +
      "push.default\nsimple\0",
  );
  assert.deepEqual(config.get("remote.Origin.url"), [
    "https://example.invalid/r.git",
  ]);
  assert.deepEqual(config.get("branch.Chore/X.pushremote"), ["fork"]);
  assert.deepEqual(config.get("push.default"), ["simple"]);
  assert.equal(config.has("Remote.Origin.URL"), false);
});

test("parseGitConfigListZ: repeated keys keep every value in order", () => {
  const config = parseGitConfigListZ(
    "remote.origin.push\nrefs/heads/a\0remote.origin.push\nrefs/heads/b\0",
  );
  assert.deepEqual(config.get("remote.origin.push"), [
    "refs/heads/a",
    "refs/heads/b",
  ]);
});

test("parseGitConfigListZ: a value may contain a newline; only the first newline splits the key", () => {
  const config = parseGitConfigListZ("alias.x\nline1\nline2\0");
  assert.deepEqual(config.get("alias.x"), ["line1\nline2"]);
});

test("parseGitConfigListZ: a key without value (boolean true form) is kept with an empty value", () => {
  const config = parseGitConfigListZ("core.bare\0");
  assert.deepEqual(config.get("core.bare"), [""]);
});

test("parseGitConfigListZ: empty text gives an empty config", () => {
  assert.equal(parseGitConfigListZ("").size, 0);
});

// ── resolveEffectiveRemote (D5) ─────────────────────────────────────────────

test("resolveEffectiveRemote: explicit remote wins over every config key", () => {
  const config = cfg(
    ["remote.origin.url", "u1"],
    ["remote.fork.url", "u2"],
    ["branch.chore/x.pushremote", "fork"],
    ["remote.pushdefault", "fork"],
  );
  assert.deepEqual(
    resolveEffectiveRemote({
      explicitRemote: "origin",
      currentBranch: "chore/x",
      config,
    }),
    { remote: "origin" },
  );
});

test("resolveEffectiveRemote: order is branch pushremote, remote.pushdefault, branch remote, origin", () => {
  const base = [
    ["remote.origin.url", "u0"],
    ["remote.a.url", "ua"],
    ["remote.b.url", "ub"],
    ["remote.c.url", "uc"],
  ];
  const all = cfg(
    ...base,
    ["branch.chore/x.pushremote", "a"],
    ["remote.pushdefault", "b"],
    ["branch.chore/x.remote", "c"],
  );
  assert.equal(
    resolveEffectiveRemote({ currentBranch: "chore/x", config: all }).remote,
    "a",
  );
  const noPushRemote = cfg(
    ...base,
    ["remote.pushdefault", "b"],
    ["branch.chore/x.remote", "c"],
  );
  assert.equal(
    resolveEffectiveRemote({ currentBranch: "chore/x", config: noPushRemote })
      .remote,
    "b",
  );
  const onlyBranchRemote = cfg(...base, ["branch.chore/x.remote", "c"]);
  assert.equal(
    resolveEffectiveRemote({
      currentBranch: "chore/x",
      config: onlyBranchRemote,
    }).remote,
    "c",
  );
  assert.equal(
    resolveEffectiveRemote({ currentBranch: "chore/x", config: cfg(...base) })
      .remote,
    "origin",
  );
});

test("resolveEffectiveRemote: a branch-specific key for another branch is ignored", () => {
  const config = cfg(
    ["remote.origin.url", "u0"],
    ["remote.fork.url", "u1"],
    ["branch.other.pushremote", "fork"],
  );
  assert.equal(
    resolveEffectiveRemote({ currentBranch: "chore/x", config }).remote,
    "origin",
  );
});

test("resolveEffectiveRemote: single-valued keys take the last occurrence", () => {
  const config = cfg(
    ["remote.origin.url", "u0"],
    ["remote.a.url", "ua"],
    ["remote.b.url", "ub"],
    ["remote.pushdefault", "a"],
    ["remote.pushdefault", "b"],
  );
  assert.equal(
    resolveEffectiveRemote({ currentBranch: "chore/x", config }).remote,
    "b",
  );
});

test("resolveEffectiveRemote: local remote '.' is unproven", () => {
  const config = cfg(
    ["remote.origin.url", "u0"],
    ["branch.chore/x.pushremote", "."],
  );
  const result = resolveEffectiveRemote({ currentBranch: "chore/x", config });
  assert.equal(result.remote, null);
  assert.equal(typeof result.reason, "string");
});

test("resolveEffectiveRemote: selected remote without remote.<r>.url is unproven (pushremote to a missing remote)", () => {
  const config = cfg(
    ["remote.origin.url", "u0"],
    ["branch.chore/x.pushremote", "ghost"],
  );
  const result = resolveEffectiveRemote({ currentBranch: "chore/x", config });
  assert.equal(result.remote, null);
});

test("resolveEffectiveRemote: explicit remote that is not a configured name (URL or path) is unproven", () => {
  const config = cfg(["remote.origin.url", "u0"]);
  for (const explicitRemote of [
    "https://example.invalid/x.git",
    "../other",
    "ghost",
    ".",
  ]) {
    assert.equal(
      resolveEffectiveRemote({
        explicitRemote,
        currentBranch: "chore/x",
        config,
      }).remote,
      null,
      explicitRemote,
    );
  }
});

test("resolveEffectiveRemote: no origin configured at all is unproven", () => {
  const result = resolveEffectiveRemote({
    currentBranch: "chore/x",
    config: cfg(["core.bare", "false"]),
  });
  assert.equal(result.remote, null);
});

// ── classifyPushTarget (D4 table) ───────────────────────────────────────────

function classify(tokens, config = BASE_CONFIG(), currentBranch = "chore/x") {
  return classifyPushTarget({ tokens, currentBranch, config });
}

test("classifyPushTarget: bare push, push <remote>, push -u origin <branch> count", () => {
  assert.equal(classify([]).status, "counts");
  assert.equal(classify(["origin"]).status, "counts");
  assert.equal(classify(["-u", "origin", "chore/x"]).status, "counts");
  assert.equal(classify(["--set-upstream", "origin", "chore/x"]).status, "counts");
  assert.equal(classify(["origin", "HEAD"]).status, "counts");
  assert.equal(classify(["origin", "chore/x"]).status, "counts");
});

test("classifyPushTarget: --follow-tags and --force-with-lease are classified by their branch part", () => {
  assert.equal(
    classify(["--follow-tags", "origin", "chore/x"]).status,
    "counts",
  );
  assert.equal(
    classify(["--force-with-lease", "origin", "chore/x"]).status,
    "counts",
  );
  assert.equal(
    classify(["--force-with-lease=chore/x:abc123", "origin", "chore/x"]).status,
    "counts",
  );
  assert.equal(classify(["--follow-tags", "origin", "other"]).status, "unproven");
});

test("classifyPushTarget: every target-neutral flag is ignored", () => {
  const neutral = [
    "-u",
    "--set-upstream",
    "--follow-tags",
    "--no-follow-tags",
    "-f",
    "--force",
    "--force-with-lease",
    "--force-with-lease=chore/x",
    "--force-if-includes",
    "--no-force-if-includes",
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "--progress",
    "--no-progress",
    "--verify",
    "--no-verify",
    "--atomic",
    "--no-atomic",
    "--thin",
    "--no-thin",
    "-4",
    "-6",
    "--ipv4",
    "--ipv6",
    "--porcelain",
    "--signed",
    "--signed=if-asked",
    "--no-signed",
    "--push-option=ci.skip",
  ];
  for (const flag of neutral) {
    assert.equal(classify([flag, "origin", "chore/x"]).status, "counts", flag);
  }
});

test("classifyPushTarget: -o consumes the next token as its value", () => {
  assert.equal(
    classify(["-o", "ci.skip", "origin", "chore/x"]).status,
    "counts",
  );
  // The option value must not be mistaken for a remote/ref positional.
  assert.equal(classify(["-o", "other", "origin"]).status, "counts");
});

test("classifyPushTarget: target-changing and unlisted flags are unproven", () => {
  const bad = [
    "--tags",
    "--delete",
    "-d",
    "--all",
    "--branches",
    "--mirror",
    "--prune",
    "--repo=x",
    "--repo",
    "--exec=x",
    "--receive-pack=x",
    "--recurse-submodules=check",
    "--recurse-submodules",
    "--no-such-flag",
    "-uf",
    "-x",
    "--",
  ];
  for (const flag of bad) {
    assert.equal(
      classify([flag, "origin", "chore/x"]).status,
      "unproven",
      flag,
    );
  }
});

test("classifyPushTarget: --tags together with a remote is still unproven", () => {
  assert.equal(classify(["--tags", "origin"]).status, "unproven");
});

test("classifyPushTarget: shell expansion characters in any token are unproven", () => {
  for (const token of ["$BRANCH", "`x`", "chore/*", "chore/?", "chore/[ab]"]) {
    assert.equal(classify(["origin", token]).status, "unproven", token);
  }
  assert.equal(classify(["$REMOTE", "chore/x"]).status, "unproven");
});

test("classifyPushTarget: explicit refspecs of any kind are unproven (T2, T3, T4)", () => {
  const cases = [
    ["origin", "HEAD:chore/x"],
    ["origin", "HEAD:other"],
    ["origin", "src:dst"],
    ["origin", "+chore/x"],
    ["origin", "chore/x:chore/x"],
    ["origin", "refs/heads/chore/x"],
    ["origin", "refs/tags/v1"],
    ["origin", "v1.0.0"],
    ["origin", "0123456789abcdef0123456789abcdef01234567"],
  ];
  for (const tokens of cases) {
    assert.equal(classify(tokens).status, "unproven", tokens.join(" "));
  }
});

test("classifyPushTarget: naming another branch is unproven (T5)", () => {
  assert.equal(classify(["origin", "feature/y"]).status, "unproven");
  assert.equal(classify(["origin", "chore/x"], BASE_CONFIG(), "feature/y").status, "unproven");
});

test("classifyPushTarget: three or more positionals (multiple refspecs) are unproven", () => {
  assert.equal(classify(["origin", "chore/x", "other"]).status, "unproven");
  assert.equal(classify(["origin", "a", "b", "c"]).status, "unproven");
});

test("classifyPushTarget: URL or path as the remote is unproven (T14)", () => {
  assert.equal(
    classify(["https://example.invalid/r.git", "chore/x"]).status,
    "unproven",
  );
  assert.equal(classify(["../elsewhere"]).status, "unproven");
  assert.equal(classify(["ghost", "chore/x"]).status, "unproven");
  assert.equal(classify(["ghost"]).status, "unproven");
});

test("classifyPushTarget: remote.<r>.push configured makes bare and remote-only pushes unproven (T11)", () => {
  const config = cfg(
    ["remote.origin.url", "u"],
    ["remote.origin.push", "refs/heads/*:refs/heads/*"],
  );
  assert.equal(classify([], config).status, "unproven");
  assert.equal(classify(["origin"], config).status, "unproven");
  // An explicit <remote> <branch> overrides remote.<r>.push.
  assert.equal(classify(["origin", "chore/x"], config).status, "counts");
});

test("classifyPushTarget: remote.<r>.push on a different remote does not matter", () => {
  const config = cfg(
    ["remote.origin.url", "u"],
    ["remote.fork.url", "u2"],
    ["remote.fork.push", "refs/heads/*:refs/heads/*"],
  );
  assert.equal(classify([], config).status, "counts");
});

test("classifyPushTarget: push.default simple/current/upstream count, others do not (T9, T10, T21)", () => {
  for (const value of ["simple", "current", "upstream"]) {
    const config = cfg(["remote.origin.url", "u"], ["push.default", value]);
    assert.equal(classify([], config).status, "counts", value);
    assert.equal(classify(["origin"], config).status, "counts", value);
  }
  for (const value of ["matching", "nothing", "tracking", "weird"]) {
    const config = cfg(["remote.origin.url", "u"], ["push.default", value]);
    assert.equal(classify([], config).status, "unproven", value);
    assert.equal(classify(["origin"], config).status, "unproven", value);
  }
});

test("classifyPushTarget: push.autoSetupRemote does not affect classification", () => {
  const config = cfg(
    ["remote.origin.url", "u"],
    ["push.autosetupremote", "true"],
  );
  assert.equal(classify([], config).status, "counts");
});

test("classifyPushTarget: bare push resolves the effective remote (R1, R2, R4, R5)", () => {
  // R1: pushRemote=fork and remote.fork.push set -> unproven.
  const r1 = cfg(
    ["remote.origin.url", "u"],
    ["remote.fork.url", "u2"],
    ["remote.fork.push", "x"],
    ["branch.chore/x.pushremote", "fork"],
  );
  assert.equal(classify([], r1).status, "unproven");
  // R2: remote.pushDefault=fork, same.
  const r2 = cfg(
    ["remote.origin.url", "u"],
    ["remote.fork.url", "u2"],
    ["remote.fork.push", "x"],
    ["remote.pushdefault", "fork"],
  );
  assert.equal(classify([], r2).status, "unproven");
  // R3: an explicit `origin` ignores pushRemote.
  assert.equal(classify(["origin"], r1).status, "counts");
  // R4: only branch.<b>.remote=origin.
  const r4 = cfg(
    ["remote.origin.url", "u"],
    ["branch.chore/x.remote", "origin"],
  );
  assert.equal(classify([], r4).status, "counts");
  // R5: pushRemote points at a remote that does not exist.
  const r5 = cfg(
    ["remote.origin.url", "u"],
    ["branch.chore/x.pushremote", "ghost"],
  );
  assert.equal(classify([], r5).status, "unproven");
});

test("classifyPushTarget: unproven results carry a reason string", () => {
  const result = classify(["--tags"]);
  assert.equal(result.status, "unproven");
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);
});

// ── classifyChain (D6) ──────────────────────────────────────────────────────

const cmd = (verb, args = [], sameCwd = true) => ({ verb, args, sameCwd });

test("classifyChain: no git commands before the push is plain", () => {
  assert.deepEqual(classifyChain([]).mode, "plain");
  assert.equal(classifyChain([]).includeUntracked, false);
  assert.equal(classifyChain([]).amend, false);
});

test("classifyChain: add only is plain", () => {
  const result = classifyChain([cmd("add", ["-A"])]);
  assert.equal(result.mode, "plain");
});

test("classifyChain: commit alone is a chained commit without untracked files", () => {
  const result = classifyChain([cmd("commit", ["-m", "x"])]);
  assert.equal(result.mode, "chained-commit");
  assert.equal(result.includeUntracked, false);
  assert.equal(result.amend, false);
});

test("classifyChain: add plus commit includes untracked files", () => {
  const result = classifyChain([cmd("add", ["-A"]), cmd("commit", ["-m", "x"])]);
  assert.equal(result.mode, "chained-commit");
  assert.equal(result.includeUntracked, true);
});

test("classifyChain: a commit before an add still includes untracked files (any add counts)", () => {
  const result = classifyChain([cmd("commit", ["-a"]), cmd("add", ["x"])]);
  assert.equal(result.mode, "chained-commit");
  assert.equal(result.includeUntracked, true);
});

test("classifyChain: --amend on any commit sets amend", () => {
  assert.equal(
    classifyChain([cmd("commit", ["--amend", "--no-edit"])]).amend,
    true,
  );
  assert.equal(
    classifyChain([cmd("commit", ["-m", "a"]), cmd("commit", ["--amend"])])
      .amend,
    true,
  );
  assert.equal(
    classifyChain([cmd("add", ["--amend"]), cmd("commit", ["-m", "a"])]).amend,
    false,
  );
});

for (const verb of [
  "rebase",
  "merge",
  "pull",
  "cherry-pick",
  "reset",
  "checkout",
  "switch",
  "revert",
  "am",
  "stash",
  "restore",
  "rm",
  "mv",
  "fetch",
  "tag",
  "apply",
  "branch",
  "clean",
]) {
  test(`classifyChain: ${verb} is unsupported`, () => {
    const alone = classifyChain([cmd(verb)]);
    assert.equal(alone.mode, "unsupported");
    assert.equal(typeof alone.reason, "string");
    // Unsupported wins over an otherwise supported add/commit chain.
    const mixed = classifyChain([cmd("add", ["-A"]), cmd(verb), cmd("commit")]);
    assert.equal(mixed.mode, "unsupported");
  });
}

// A read-only git command changes neither HEAD, refs, nor the work tree, so it
// must not make the chain unsupported. `fetch` is not read-only (it moves
// `origin/main`, the counting base).
const READ_ONLY_COMMANDS = [
  ["status", []],
  ["status", ["--short", "--branch"]],
  ["diff", ["--stat"]],
  ["diff", ["--cached", "--name-only"]],
  ["log", ["--oneline", "-3"]],
  ["show", ["--stat", "HEAD"]],
  ["rev-parse", ["HEAD"]],
  ["ls-files", ["--others", "--exclude-standard"]],
  ["branch", ["--show-current"]],
];

test("classifyChain: a read-only git command alone leaves the chain plain", () => {
  for (const [verb, args] of READ_ONLY_COMMANDS) {
    const result = classifyChain([cmd(verb, args)]);
    assert.equal(result.mode, "plain", `${verb} ${args.join(" ")}`);
    assert.equal(result.includeUntracked, false);
    assert.equal(result.amend, false);
  }
});

test("classifyChain: read-only commands around add and commit keep the chained-commit result", () => {
  for (const [verb, args] of READ_ONLY_COMMANDS) {
    const result = classifyChain([
      cmd(verb, args),
      cmd("add", ["-A"]),
      cmd(verb, args),
      cmd("commit", ["--amend", "-m", "x"]),
      cmd(verb, args),
    ]);
    assert.equal(result.mode, "chained-commit", `${verb} ${args.join(" ")}`);
    assert.equal(result.includeUntracked, true);
    assert.equal(result.amend, true);
  }
});

test("classifyChain: a read-only command never masks an unsupported verb", () => {
  for (const [verb, args] of READ_ONLY_COMMANDS) {
    for (const other of ["fetch", "rebase", "stash"]) {
      assert.equal(
        classifyChain([cmd(verb, args), cmd(other), cmd("commit")]).mode,
        "unsupported",
        `${verb} then ${other}`,
      );
    }
  }
});

test("classifyChain: a read-only command in another directory is still read-only", () => {
  for (const [verb, args] of READ_ONLY_COMMANDS) {
    assert.equal(classifyChain([cmd(verb, args, false)]).mode, "plain", verb);
  }
  // The directory rule still binds add and commit.
  assert.equal(
    classifyChain([cmd("status", [], false), cmd("commit", ["-m", "x"], false)]).mode,
    "unsupported",
  );
});

test("classifyChain: only `branch --show-current` is read-only among the branch forms", () => {
  for (const args of [
    [],
    ["-d", "old"],
    ["-D", "old"],
    ["-m", "new"],
    ["new-branch"],
    ["--show-current", "extra"],
    ["--list"],
  ]) {
    assert.equal(classifyChain([cmd("branch", args)]).mode, "unsupported", args.join(" "));
  }
});

test("classifyChain: --output lets diff, log and show write a file, so they are unsupported", () => {
  for (const verb of ["diff", "log", "show"]) {
    for (const args of [["--output=out.mjs"], ["--output", "out.mjs"], ["--stat", "--output=x"]]) {
      assert.equal(classifyChain([cmd(verb, args)]).mode, "unsupported", `${verb} ${args.join(" ")}`);
    }
  }
});

test("classifyChain: aliases and unknown verbs are unsupported", () => {
  for (const verb of ["ci", "co", "st", "my-alias", "", "Commit", "ADD"]) {
    assert.equal(classifyChain([cmd(verb)]).mode, "unsupported", verb);
  }
});

test("classifyChain: add or commit in a different directory is unsupported", () => {
  assert.equal(
    classifyChain([cmd("add", ["-A"], false)]).mode,
    "unsupported",
  );
  assert.equal(
    classifyChain([cmd("add", ["-A"]), cmd("commit", ["-m", "x"], false)]).mode,
    "unsupported",
  );
});

// ── hasBranchSwitchVerb (D4 step 3.5, D15 V8) ───────────────────────────────

test("hasBranchSwitchVerb: V8 positives", () => {
  const yes = [
    "git switch x",
    "git switch -c x",
    "git switch -",
    "git checkout x",
    "git checkout -b x",
    "git checkout -",
  ];
  for (const text of yes) assert.equal(hasBranchSwitchVerb(text), true, text);
});

test("hasBranchSwitchVerb: V8 negatives (path forms)", () => {
  const no = [
    "git checkout -- f",
    "git checkout HEAD -- f",
    "git checkout 0123abc -- f",
    "git checkout origin/main -- docs/readme.md",
  ];
  for (const text of no) assert.equal(hasBranchSwitchVerb(text), false, text);
});

test("hasBranchSwitchVerb: -B, --detach, -c and --orphan forms count", () => {
  for (const text of [
    "git checkout -B x",
    "git checkout --detach",
    "git checkout --detach HEAD~1",
    "git switch --detach HEAD",
    "git switch -C x",
    "git checkout --orphan x",
    "git checkout -b x -- ",
  ]) {
    assert.equal(hasBranchSwitchVerb(text), true, text);
  }
});

test("hasBranchSwitchVerb: found inside a chain, after git global options, behind env prefixes", () => {
  assert.equal(hasBranchSwitchVerb("npm test && git switch chore/large"), true);
  assert.equal(hasBranchSwitchVerb("git add -A; git checkout x ;"), true);
  assert.equal(hasBranchSwitchVerb("git -C /abs switch x && "), true);
  assert.equal(hasBranchSwitchVerb("git --no-pager checkout -b x && "), true);
  assert.equal(hasBranchSwitchVerb("FOO=1 git switch x && "), true);
  assert.equal(hasBranchSwitchVerb("cd /abs && git switch x && "), true);
  assert.equal(hasBranchSwitchVerb("(git switch x) && "), true);
});

test("hasBranchSwitchVerb: other verbs, similar verbs and argument positions do not count", () => {
  const no = [
    "",
    "cd /abs && ",
    "git add -A && git commit -m x && ",
    "git fetch origin && ",
    "git checkout-index -a && ",
    "git switchboard x && ",
    "echo git switch x && ",
    "git commit -m checkout && ",
    "git checkout && ",
    "git checkout -p && ",
  ];
  for (const text of no) assert.equal(hasBranchSwitchVerb(text), false, text);
});

test("hasBranchSwitchVerb: a path-form checkout does not hide a later real switch", () => {
  assert.equal(
    hasBranchSwitchVerb("git checkout -- f && git switch x && "),
    true,
  );
  assert.equal(
    hasBranchSwitchVerb("git switch x && git checkout -- f && "),
    true,
  );
});

// ── topFiles ────────────────────────────────────────────────────────────────

test("topFiles: sorts by count descending then path ascending and keeps the first five by default", () => {
  const entries = [
    { path: "b.mjs", added: 1, deleted: 0, count: 1 },
    { path: "z.mjs", added: 9, deleted: 0, count: 9 },
    { path: "a.mjs", added: 5, deleted: 4, count: 9 },
    { path: "m.mjs", added: 3, deleted: 0, count: 3 },
    { path: "c.mjs", added: 3, deleted: 0, count: 3 },
    { path: "d.mjs", added: 2, deleted: 0, count: 2 },
    { path: "e.mjs", added: 0, deleted: 0, count: 0 },
  ];
  const top = topFiles(entries);
  assert.deepEqual(
    top.map((e) => e.path),
    ["a.mjs", "z.mjs", "c.mjs", "m.mjs", "d.mjs"],
  );
  assert.deepEqual(
    topFiles(entries, 2).map((e) => e.path),
    ["a.mjs", "z.mjs"],
  );
  assert.equal(topFiles([]).length, 0);
});

test("topFiles: does not mutate its input", () => {
  const entries = [
    { path: "b", added: 1, deleted: 0, count: 1 },
    { path: "a", added: 2, deleted: 0, count: 2 },
  ];
  topFiles(entries);
  assert.deepEqual(
    entries.map((e) => e.path),
    ["b", "a"],
  );
});

test("topFiles: path ties use plain code-point order, not locale order", () => {
  const entries = [
    { path: "b.mjs", count: 1 },
    { path: "B.mjs", count: 1 },
    { path: "a.mjs", count: 1 },
  ];
  assert.deepEqual(
    topFiles(entries).map((e) => e.path),
    ["B.mjs", "a.mjs", "b.mjs"],
  );
});

// ── countFileLines (D6 untracked-file line counting) ────────────────────────

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "chore-size-gate-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("countFileLines: counts newline-terminated lines", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "a.mjs");
    writeFileSync(file, "a\nb\nc\n");
    assert.equal(countFileLines(file), 3);
  });
});

test("countFileLines: a final line without a trailing newline still counts", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "a.mjs");
    writeFileSync(file, "a\nb\nc");
    assert.equal(countFileLines(file), 3);
    const single = path.join(dir, "b.mjs");
    writeFileSync(single, "only");
    assert.equal(countFileLines(single), 1);
  });
});

test("countFileLines: empty file is 0 and a lone newline is 1", () => {
  withTempDir((dir) => {
    const empty = path.join(dir, "empty.mjs");
    writeFileSync(empty, "");
    assert.equal(countFileLines(empty), 0);
    const nl = path.join(dir, "nl.mjs");
    writeFileSync(nl, "\n");
    assert.equal(countFileLines(nl), 1);
  });
});

test("countFileLines: a NUL byte in the first 8000 bytes means binary (0)", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "bin.mjs");
    writeFileSync(file, Buffer.from("line1\nline2\n\0line3\n"));
    assert.equal(countFileLines(file), 0);
  });
});

test("countFileLines: a NUL byte after the first 8000 bytes does not make the file binary", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "late-nul.mjs");
    const head = "x\n".repeat(4001); // 8002 bytes, 4001 lines
    writeFileSync(file, Buffer.concat([Buffer.from(head), Buffer.from("\0\n")]));
    assert.equal(countFileLines(file), 4002);
  });
});

test("countFileLines: symlinks and non-regular files count 0", () => {
  withTempDir((dir) => {
    const target = path.join(dir, "real.mjs");
    writeFileSync(target, "a\nb\nc\n");
    const link = path.join(dir, "link.mjs");
    symlinkSync(target, link);
    assert.equal(countFileLines(link), 0);
    const sub = path.join(dir, "subdir");
    mkdirSync(sub);
    assert.equal(countFileLines(sub), 0);
  });
});

test("countFileLines: a missing file counts 0 instead of throwing", () => {
  withTempDir((dir) => {
    assert.equal(countFileLines(path.join(dir, "nope.mjs")), 0);
  });
});

// ── helper contract (D3: no exit, no print, no write, no network) ───────────

test("helper source: no process exit, no printing, no file writes, no network", () => {
  const src = readFileSync(HELPER_PATH, "utf8");
  const code = src
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  assert.doesNotMatch(code, /process\.exit|process\.exitCode/);
  assert.doesNotMatch(code, /console\.|process\.std(?:out|err)/);
  assert.doesNotMatch(
    code,
    /writeFile|appendFile|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync|copyFile/,
  );
  assert.doesNotMatch(
    code,
    /node:(?:http|https|net|tls|dgram|dns)|\bfetch\s*\(|XMLHttpRequest|WebSocket/,
  );
  // Only the local read-only git is spawned, always with literal pathspecs and
  // without optional locks (`git diff` must not refresh the user's index).
  assert.match(code, /--literal-pathspecs/);
  assert.match(code, /--no-optional-locks/);
  assert.doesNotMatch(code, /\bexecSync\b|\bexecFileSync\b|\bexecFile\b/);
});

// ── parseStatusPathsZ (D7: which committed paths show up in `git status`) ───

test("parseStatusPathsZ: plain records give their paths, a clean status gives none", () => {
  assert.deepEqual([...parseStatusPathsZ("")], []);
  assert.deepEqual(
    [...parseStatusPathsZ(" M a/proposal.md\0A  b.mjs\0?? c.mjs\0")].sort(),
    ["a/proposal.md", "b.mjs", "c.mjs"],
  );
});

test("parseStatusPathsZ: a rename or copy record names both the new and the source path", () => {
  const found = parseStatusPathsZ("R  new/proposal.md\0old/proposal.md\0 M other.mjs\0");
  assert.deepEqual([...found].sort(), ["new/proposal.md", "old/proposal.md", "other.mjs"]);
  const copied = parseStatusPathsZ("C  dup.md\0src.md\0");
  assert.deepEqual([...copied].sort(), ["dup.md", "src.md"]);
});

test("parseStatusPathsZ: a deleted, staged-and-restored (MM) or path with spaces is still reported", () => {
  const found = parseStatusPathsZ(" D gone/proposal.md\0MM both.mjs\0 M with space.md\0");
  assert.deepEqual([...found].sort(), ["both.mjs", "gone/proposal.md", "with space.md"]);
});
