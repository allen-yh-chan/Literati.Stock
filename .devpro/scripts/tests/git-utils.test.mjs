/**
 * git-utils.test.mjs
 *
 * Unit tests for .devpro/scripts/hooks/lib/git-utils.mjs.
 *
 * Pattern: each test creates an isolated git repo in mkdtempSync → performs
 * the operation → asserts → cleans up in try/finally rmSync. No shared state
 * between tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTempDir } from "./lib/tmp.mjs";

const LIB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/lib/git-utils.mjs"
);

const {
  runGit,
  runShell,
  getCurrentBranch,
  getShortHead,
  getHead,
  readAgentsMdVersion,
  resolveCanonicalAgentsMdRef,
  readAgentsMdVersionAtRef,
  readCanonicalAgentsMdVersion,
  resolveGithubOwnerRepo,
  resolveGithubRepoIdentity,
} =
  await import(pathToFileURL(LIB).href);

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temp git repo with a single commit and return the dir path.
 * Sets minimal git config (user.email / user.name) for `git commit` to work
 * in CI environments where global config may be absent.
 */
function makeTempRepo() {
  const tmp = makeTempDir("git-utils-test-");
  const run = (cmd) =>
    execSync(cmd, {
      cwd: tmp,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  run("git init");
  run('git config user.email "test@example.com"');
  run('git config user.name "Test"');
  run("git commit --allow-empty -m 'initial'");
  return tmp;
}

// ── T1: runGit returns stdout ─────────────────────────────────────────────────

test("T1: runGit returns 40-char SHA for rev-parse HEAD in a valid repo", () => {
  const tmp = makeTempRepo();
  try {
    const sha = runGit("rev-parse HEAD", { cwd: tmp });
    assert.match(sha, /^[0-9a-f]{40}$/, `Expected 40-char SHA, got: "${sha}"`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── T2: runGit fail-open ──────────────────────────────────────────────────────

test("T2: runGit fail-open — invalid subcommand returns empty string", () => {
  const result = runGit("invalid-subcommand-xyz-9999");
  assert.equal(result, "", `Expected "", got: "${result}"`);
});

// ── T3: getCurrentBranch ──────────────────────────────────────────────────────

test("T3: getCurrentBranch returns correct branch name after checkout -b", () => {
  const tmp = makeTempRepo();
  try {
    execSync("git checkout -b feature/test-branch", {
      cwd: tmp,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const branch = getCurrentBranch(tmp);
    assert.equal(branch, "feature/test-branch");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── T4: getShortHead uses --short (prefix property) ──────────────────────────

test("T4: getShortHead returns ≥ 7 chars and is a prefix of getHead", () => {
  const tmp = makeTempRepo();
  try {
    const short = getShortHead(tmp);
    const full = getHead(tmp);

    assert.ok(
      short.length >= 7,
      `getShortHead should return ≥ 7 chars, got ${short.length}: "${short}"`
    );
    assert.ok(
      full.startsWith(short),
      `getShortHead "${short}" should be a prefix of getHead "${full}"`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── T5: runShell — generic non-git command ────────────────────────────────────

test("T5: runShell runs a non-git command and returns trimmed stdout", () => {
  const result = runShell("node --version");
  assert.match(result, /^v\d+\.\d+\.\d+$/, `Expected node version string, got: "${result}"`);
});

// ── T6: runShell fail-open ────────────────────────────────────────────────────

test("T6: runShell fail-open — non-existent command returns empty string", () => {
  const result = runShell("this-command-does-not-exist-xyzzy-9999");
  assert.equal(result, "", `Expected "", got: "${result}"`);
});

// ── T7-T9: readAgentsMdVersion (T3) ──────────────────────────────────────────

test("T7: readAgentsMdVersion returns version when AGENTS.md exists with 版本：X.Y.Z", () => {
  const tmp = makeTempDir("git-utils-agents-");
  try {
    writeFileSync(path.join(tmp, "AGENTS.md"), "# AI Agent\n\n版本：6.62.0\n");
    const version = readAgentsMdVersion(tmp);
    assert.equal(version, "6.62.0", `Expected "6.62.0", got: "${version}"`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T8: readAgentsMdVersion returns null when AGENTS.md does not exist (fail-open)", () => {
  const tmp = makeTempDir("git-utils-noagents-");
  try {
    // No AGENTS.md created
    const version = readAgentsMdVersion(tmp);
    assert.equal(version, null, `Expected null for missing AGENTS.md, got: "${version}"`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T9: readAgentsMdVersion returns null when AGENTS.md has no 版本： line (unparseable)", () => {
  const tmp = makeTempDir("git-utils-unparse-");
  try {
    writeFileSync(path.join(tmp, "AGENTS.md"), "no version line here\n");
    const version = readAgentsMdVersion(tmp);
    assert.equal(version, null, `Expected null for no version line, got: "${version}"`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T10: readAgentsMdVersion returns null when repoRoot is empty string (fail-open)", () => {
  const version = readAgentsMdVersion("");
  assert.equal(version, null, `Expected null for empty repoRoot, got: "${version}"`);
});

test("T11: readAgentsMdVersion returns null when repoRoot is null (fail-open)", () => {
  const version = readAgentsMdVersion(null);
  assert.equal(version, null, `Expected null for null repoRoot, got: "${version}"`);
});

test("T12: getCurrentBranch hanging git on PATH returns empty without throw", { timeout: 15000 }, () => {
  const bin = makeTempDir("hanging-git-");
  try {
    const gitPath = path.join(bin, "git");
    writeFileSync(gitPath, "#!/bin/sh\nsleep 8\n");
    chmodSync(gitPath, 0o755);
    const script = `
      import { getCurrentBranch } from ${JSON.stringify(pathToFileURL(LIB).href)};
      const started = Date.now();
      let threw = false;
      let result = null;
      try {
        result = getCurrentBranch();
      } catch {
        threw = true;
      }
      process.stdout.write(JSON.stringify({ result, elapsed: Date.now() - started, threw }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      timeout: 12000,
    });
    assert.equal(r.status, 0, `child exited ${r.status}\nstderr: ${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.threw, false, "getCurrentBranch must not throw");
    assert.equal(body.result, "");
    assert.ok(
      body.elapsed < 3500,
      `expected fail-open within 2000ms timeout, elapsed ${body.elapsed}ms`
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// ── #2533: canonical remote-tip AGENTS.md helpers ────────────────────────────

test("T13: readCanonicalAgentsMdVersion prefers origin/main tip over stale workspace", () => {
  const tmp = makeTempDir("git-utils-canonical-tip-");
  try {
    execSync("git init -q -b main", { cwd: tmp });
    execSync('git config user.email "t@t.com"', { cwd: tmp });
    execSync('git config user.name "t"', { cwd: tmp });
    writeFileSync(path.join(tmp, "AGENTS.md"), "# AI Agent\n\n版本：6.93.0\n");
    execSync("git add AGENTS.md", { cwd: tmp });
    execSync('git commit -q -m "tip"', { cwd: tmp });
    execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: tmp });
    execSync("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", { cwd: tmp });
    execSync("git checkout -q -b develop", { cwd: tmp });
    writeFileSync(path.join(tmp, "AGENTS.md"), "# AI Agent\n\n版本：6.92.0\n");
    execSync("git add AGENTS.md", { cwd: tmp });
    execSync('git commit -q -m "stale develop"', { cwd: tmp });

    assert.equal(resolveCanonicalAgentsMdRef(tmp), "origin/main");
    assert.equal(readAgentsMdVersionAtRef(tmp, "origin/main"), "6.93.0");
    assert.equal(readAgentsMdVersion(tmp), "6.92.0");
    const resolved = readCanonicalAgentsMdVersion(tmp);
    assert.equal(resolved.version, "6.93.0");
    assert.equal(resolved.anchor, "ref:origin/main");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T14: readCanonicalAgentsMdVersion falls back to workspace when no origin tip", () => {
  const tmp = makeTempDir("git-utils-canonical-fallback-");
  try {
    execSync("git init -q", { cwd: tmp });
    execSync('git config user.email "t@t.com"', { cwd: tmp });
    execSync('git config user.name "t"', { cwd: tmp });
    writeFileSync(path.join(tmp, "AGENTS.md"), "# AI Agent\n\n版本：6.50.0\n");
    execSync("git add AGENTS.md", { cwd: tmp });
    execSync('git commit -q -m "local only"', { cwd: tmp });

    assert.equal(resolveCanonicalAgentsMdRef(tmp), null);
    const resolved = readCanonicalAgentsMdVersion(tmp);
    assert.equal(resolved.version, "6.50.0");
    assert.equal(resolved.anchor, "workspace");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Prove-it for #2669 F1: runGit is shell-backed (`execSync("git …")`); Windows
// cmd.exe strips `^`, so resolveCanonicalAgentsMdRef must never pass `^{commit}`.
test("T15: resolveCanonicalAgentsMdRef must not emit ^{commit} (cmd.exe-safe)", () => {
  const src = readFileSync(LIB, "utf8");
  const start = src.indexOf("export function resolveCanonicalAgentsMdRef");
  assert.ok(start >= 0, "resolveCanonicalAgentsMdRef export not found");
  const nextExport = src.indexOf("\nexport function ", start + 1);
  const body = nextExport >= 0 ? src.slice(start, nextExport) : src.slice(start);
  // Executable call site only — JSDoc may mention ^{commit} as the banned form.
  assert.equal(
    /rev-parse[^\n]*\^\{commit\}/.test(body),
    false,
    "resolveCanonicalAgentsMdRef must not pass ^{commit} to runGit; shell/cmd.exe strips ^"
  );
  assert.match(
    body,
    /rev-parse --verify --quiet \$\{(?:ref|candidate)\}/,
    "expected plain rev-parse --verify --quiet <ref> without peel syntax"
  );
  // Document the shell contract the peel ban depends on (fail if runGit goes argv).
  const runGitStart = src.indexOf("export function runGit");
  const runGitNext = src.indexOf("\nexport function ", runGitStart + 1);
  const runGitBody =
    runGitNext >= 0 ? src.slice(runGitStart, runGitNext) : src.slice(runGitStart);
  assert.match(runGitBody, /runShell\(`git \$\{args\}`/, "runGit must remain shell-backed via runShell");
});

test("T16: resolveCanonicalAgentsMdRef falls back to origin/main when origin/HEAD missing", () => {
  const tmp = makeTempDir("git-utils-canonical-no-head-");
  try {
    execSync("git init -q -b main", { cwd: tmp });
    execSync('git config user.email "t@t.com"', { cwd: tmp });
    execSync('git config user.name "t"', { cwd: tmp });
    writeFileSync(path.join(tmp, "AGENTS.md"), "# AI Agent\n\n版本：6.94.0\n");
    execSync("git add AGENTS.md", { cwd: tmp });
    execSync('git commit -q -m "tip"', { cwd: tmp });
    execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: tmp });
    // Deliberately omit refs/remotes/origin/HEAD

    assert.equal(resolveCanonicalAgentsMdRef(tmp), "origin/main");
    const resolved = readCanonicalAgentsMdVersion(tmp);
    assert.equal(resolved.version, "6.94.0");
    assert.equal(resolved.anchor, "ref:origin/main");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T17: resolveCanonicalAgentsMdRef uses origin/master when only master tip exists", () => {
  const tmp = makeTempDir("git-utils-canonical-master-");
  try {
    execSync("git init -q -b master", { cwd: tmp });
    execSync('git config user.email "t@t.com"', { cwd: tmp });
    execSync('git config user.name "t"', { cwd: tmp });
    writeFileSync(path.join(tmp, "AGENTS.md"), "# AI Agent\n\n版本：6.91.0\n");
    execSync("git add AGENTS.md", { cwd: tmp });
    execSync('git commit -q -m "tip"', { cwd: tmp });
    execSync("git update-ref refs/remotes/origin/master HEAD", { cwd: tmp });

    assert.equal(resolveCanonicalAgentsMdRef(tmp), "origin/master");
    const resolved = readCanonicalAgentsMdVersion(tmp);
    assert.equal(resolved.version, "6.91.0");
    assert.equal(resolved.anchor, "ref:origin/master");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T18: readCanonicalAgentsMdVersion falls back to workspace when tip has no AGENTS.md", () => {
  const tmp = makeTempDir("git-utils-canonical-no-agents-at-ref-");
  try {
    execSync("git init -q -b main", { cwd: tmp });
    execSync('git config user.email "t@t.com"', { cwd: tmp });
    execSync('git config user.name "t"', { cwd: tmp });
    execSync("git commit --allow-empty -q -m empty-tip", { cwd: tmp });
    execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: tmp });
    writeFileSync(path.join(tmp, "AGENTS.md"), "# AI Agent\n\n版本：6.88.0\n");

    assert.equal(resolveCanonicalAgentsMdRef(tmp), "origin/main");
    assert.equal(readAgentsMdVersionAtRef(tmp, "origin/main"), null);
    const resolved = readCanonicalAgentsMdVersion(tmp);
    assert.equal(resolved.version, "6.88.0");
    assert.equal(resolved.anchor, "workspace");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("T19: resolveGithubOwnerRepo parses https/ssh origin URLs and fails open without a usable origin", () => {
  const cases = [
    ["https://github.com/a/self.git", "a/self"],
    ["https://github.com/a/self", "a/self"],
    ["https://github.com/a/self/", "a/self"],
    ["git@github.com:SinoPac/SinoPac.Cards.Web.git", "SinoPac/SinoPac.Cards.Web"],
  ];
  for (const [url, expected] of cases) {
    const tmp = makeTempDir("git-utils-slug-");
    try {
      execSync("git init -q", { cwd: tmp });
      execSync(`git remote add origin ${url}`, { cwd: tmp });
      assert.equal(resolveGithubOwnerRepo(tmp), expected, `slug for ${url}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const noRemote = makeTempDir("git-utils-slug-none-");
  try {
    execSync("git init -q", { cwd: noRemote });
    assert.equal(resolveGithubOwnerRepo(noRemote), null, "no origin → null");
    execSync("git remote add origin /srv/git/local.git", { cwd: noRemote });
    assert.equal(resolveGithubOwnerRepo(noRemote), null, "non-GitHub origin → null");
  } finally {
    rmSync(noRemote, { recursive: true, force: true });
  }
});

test("T20: resolveGithubRepoIdentity keeps the host, so the same owner/repo on two hosts stays two repos", () => {
  const cases = [
    ["https://github.com/a/self.git", { host: "github.com", slug: "a/self" }],
    ["https://GitHub.com/A/Self/", { host: "github.com", slug: "a/self" }],
    ["git@github.com:a/self.git", { host: "github.com", slug: "a/self" }],
    ["git@gitlab.com:b/other.git", { host: "gitlab.com", slug: "b/other" }],
    ["ssh://git@gitlab.example.org/b/other.git", { host: "gitlab.example.org", slug: "b/other" }],
    ["ssh://git@ghe.example.com:2222/b/other", { host: "ghe.example.com", slug: "b/other" }],
    ["https://ghe.example.com:8443/b/other.git", { host: "ghe.example.com:8443", slug: "b/other" }],
    ["https://ghe.example.com:443/b/other.git", { host: "ghe.example.com", slug: "b/other" }],
    ["http://ghe.example.com:80/b/other.git", { host: "ghe.example.com", slug: "b/other" }],
    ["http://ghe.example.com:8080/b/other.git", { host: "ghe.example.com:8080", slug: "b/other" }],
    ["https://user@ghe.example.com/b/other.git", { host: "ghe.example.com", slug: "b/other" }],
  ];
  for (const [url, expected] of cases) {
    const tmp = makeTempDir("git-utils-identity-");
    try {
      execSync("git init -q", { cwd: tmp });
      execFileSync("git", ["remote", "add", "origin", url], { cwd: tmp });
      assert.deepEqual(resolveGithubRepoIdentity(tmp), expected, `identity for ${url}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  for (const url of ["/srv/git/local.git", "file:///srv/git/local.git", "https://gitlab.com/group/sub/repo.git"]) {
    const tmp = makeTempDir("git-utils-identity-none-");
    try {
      execSync("git init -q", { cwd: tmp });
      execFileSync("git", ["remote", "add", "origin", url], { cwd: tmp });
      assert.equal(resolveGithubRepoIdentity(tmp), null, `${url} is not a two-segment owner/repo remote → null`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const noRemote = makeTempDir("git-utils-identity-noremote-");
  try {
    execSync("git init -q", { cwd: noRemote });
    assert.equal(resolveGithubRepoIdentity(noRemote), null, "no origin → null");
  } finally {
    rmSync(noRemote, { recursive: true, force: true });
  }
});
