/**
 * hook-pre-tool-gate-release-rules-base.test.mjs
 *
 * Unit tests for Gate 2h: Release/rules base must originate from production-* tag.
 * (.devpro/scripts/hooks/pre-tool-gate.mjs — checkReleaseRulesBaseFromProductionTag)
 *
 * Test strategy mirrors hook-pre-tool-gate.test.mjs Gate 2e (hotfix base) section:
 *   - Each test sets up an isolated git repo in /tmp
 *   - Hook invoked via spawnSync with synthetic PreToolUse JSON payload on stdin
 *   - Output JSON parsed for {decision} or null (pass)
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSourceRepo,
  evaluatePreToolUsePayload,
  PASS_THROUGH,
} from "../hooks/pre-tool-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { markConsumerCheckout, markSourceCheckout } from "./lib/identity-fixtures.mjs";

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../hooks/pre-tool-gate.mjs"
);

const tmpRoot = makeTempDir("pre-tool-gate-release-rules-test-");

after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

// Minimal preflight-checklist.md fixture (same as hook-pre-tool-gate.test.mjs)
// for rules-source-whitelist consumers in isolated tmp repos.
const PREFLIGHT_FIXTURE = [
  "# preflight",
  "",
  "<!-- branch-verb-whitelist:start -->",
  "- `add` — 新增功能",
  "- `fix` — 修 bug",
  "- `refactor` — 不變行為重整",
  "- `remove` — 移除",
  "- `migrate` — 切換技術棧",
  "- `update` — 同一依賴升新版",
  "- `docs` — 純文件",
  "- `amend` — 修規範既有 requirement",
  "- `strengthen` — 補既有規則漏洞",
  "- `wire` — 啟用既有設計",
  "- `clarify` — 澄清既有規則語意",
  "- `enforce` — 把既有規則上升為強制 gate",
  "<!-- branch-verb-whitelist:end -->",
  "",
  "<!-- rules-source-whitelist:start -->",
  "- `agent-rules` — devpro-agent-rules submodule（規範同步）",
  "<!-- rules-source-whitelist:end -->",
  "",
].join("\n");

function writePreflightFixture(dir) {
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(
    path.join(dir, ".devpro/agent-rules/preflight-checklist.md"),
    PREFLIGHT_FIXTURE
  );
}

function writeConsumerGitmodules(dir) {
  writeFileSync(
    path.join(dir, ".gitmodules"),
    [
      '[submodule ".devpro-agent-rules"]',
      "\tpath = .devpro-agent-rules",
      "\turl = https://example.com/devpro-agent-rules.git",
      "\tbranch = production",
      "",
    ].join("\n")
  );
}

let repoCounter = 0;

function setupRepoNamed(name, { withGitmodules = false } = {}) {
  const dir = path.join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  if (withGitmodules) writeConsumerGitmodules(dir);
  return dir;
}

/**
 * Template cache for setupRepoWithProductionTag(), keyed by tagName
 * (test-performance-patterns.md pattern (a)). The git init + 2 commits + tag
 * sequence (9 real git spawns) runs ONCE per distinct tag; every subsequent
 * call gets a fast cpSync copy. Safe because every caller either only
 * EVALUATES a payload against the repo (the hook never executes the payload
 * command, so the repo stays read-only) or mutates its OWN cpSync copy
 * (checkout / worktree add / CHERRY_PICK_HEAD writes below).
 */
const prodTagTemplateByTag = new Map();

function createProdTagTemplate(tagName) {
  if (prodTagTemplateByTag.has(tagName)) return prodTagTemplateByTag.get(tagName);
  const dir = path.join(tmpRoot, `template-prodtag-${prodTagTemplateByTag.size}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "init.txt"), "");
  writePreflightFixture(dir);
  spawnSync("git", ["add", "init.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  // Tag this commit as production-*
  spawnSync("git", ["tag", tagName], { cwd: dir });
  // Add another commit (not on tag) so HEAD != tag
  writeFileSync(path.join(dir, "later.txt"), "");
  spawnSync("git", ["add", "later.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "later"], { cwd: dir });
  markSourceCheckout(dir);
  prodTagTemplateByTag.set(tagName, dir);
  return dir;
}

/**
 * Sets up a temp git repo on `main` branch with a production-* tag on the
 * first commit and one additional commit (HEAD) that is NOT on the tag.
 * Mirrors setupRepoWithProductionTag() from hook-pre-tool-gate.test.mjs.
 */
function setupRepoWithProductionTag(tagName = "production-2026-04-01") {
  const template = createProdTagTemplate(tagName);
  const dir = path.join(tmpRoot, `repo-prodtag-${repoCounter++}`);
  cpSync(template, dir, { recursive: true });
  return { dir, tagName };
}

function setupConsumerRepoWithProductionTag(tagName = "production-2026-04-01") {
  const repo = setupRepoWithProductionTag(tagName);
  writeConsumerGitmodules(repo.dir);
  markConsumerCheckout(repo.dir);
  return repo;
}

/**
 * Sets up a temp git repo with a production-*-rules variant tag.
 * Covers D5 alternative naming convention (e.g. production-20260511-rules).
 */
function setupRepoWithProductionRulesTag(tagName = "production-20260511-rules") {
  return setupRepoWithProductionTag(tagName);
}

function git(dir, args) {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return (result.stdout || "").trim();
}

function writeProjectionFiles(dir, marker = "sync") {
  mkdirSync(path.join(dir, ".devpro-agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, "AGENTS.md"), `版本：0.0.0\n${marker}\n`);
  writeFileSync(path.join(dir, ".devpro-agent-rules", "VERSION"), `${marker}\n`);
}

// Template cache for checkoutRulesReleaseWithSyncCommit(), keyed by tagName
// (pattern (a)): the checkout + projection write + add + commit sequence runs
// ONCE; callers get cpSync copies. Safe: all three callers only evaluate
// payloads (the hook never executes `git add` / `git commit --amend`).
const rulesReleaseSyncTemplateByTag = new Map();

function checkoutRulesReleaseWithSyncCommit(tagName = "production-20260707-rules") {
  if (!rulesReleaseSyncTemplateByTag.has(tagName)) {
    const { dir } = setupConsumerRepoWithProductionTag(tagName);
    git(dir, ["checkout", "-q", "-b", "release/rules-20260707", tagName]);
    writeProjectionFiles(dir, "sync-commit");
    git(dir, ["add", ".gitmodules", "AGENTS.md", ".devpro-agent-rules"]);
    git(dir, ["commit", "-q", "-m", "chore: sync devpro-agent-rules (abcdef0)"]);
    rulesReleaseSyncTemplateByTag.set(tagName, dir);
  }
  const dir = path.join(tmpRoot, `repo-rules-sync-${repoCounter++}`);
  cpSync(rulesReleaseSyncTemplateByTag.get(tagName), dir, { recursive: true });
  return dir;
}

test("isSourceRepo: the basename devpro-agent-rules alone is not source evidence → false", () => {
  const dir = setupRepoNamed("devpro-agent-rules", { withGitmodules: true });
  assert.equal(isSourceRepo(dir), false);
});

test("isSourceRepo: .gitmodules absent without positive source evidence → false (no longer assumed source)", () => {
  const dir = setupRepoNamed("plain-no-gitmodules");
  assert.equal(isSourceRepo(dir), false);
});

test("isSourceRepo: positive source identity (source origin + maintained-corpus sentinels) → true", () => {
  const { dir } = setupRepoWithProductionTag();
  assert.equal(isSourceRepo(dir), true);
});

test("isSourceRepo: consumer with .gitmodules → false", () => {
  const { dir } = setupConsumerRepoWithProductionTag();
  assert.equal(isSourceRepo(dir), false);
});

/**
 * Runs the hook with the given payload.
 * Mirrors run() from hook-pre-tool-gate.test.mjs.
 */
function run(payload, { cwd, env } = {}) {
  const tempSentinelDir = makeTempDir("sentinel-test-");
  try {
    const fullEnv = {
      ...process.env,
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_SENTINEL_STATE_DIR: tempSentinelDir,
      ...(env || {}),
    };
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      cwd: cwd || process.cwd(),
      env: fullEnv,
    });
    let parsed = null;
    if (result.stdout && result.stdout.trim()) {
      try {
        parsed = JSON.parse(result.stdout);
      } catch {}
    }
    return {
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      json: parsed,
    };
  } finally {
    try {
      rmSync(tempSentinelDir, { recursive: true, force: true });
    } catch {}
  }
}

// Map a raw evaluatePreToolUsePayload() result to the {decision|hookSpecificOutput}
// JSON shape the hook writes to stdout, so assertions on r.json are identical
// whether a case ran in-process or via spawn. Mirrors gateResultToJson() in
// hook-pre-tool-gate.test.mjs (non-codex runtime emitBlock()/emitContext()).
function gateResultToJson(result) {
  if (!result || result === PASS_THROUGH) return null;
  if (result.block) return { decision: "block", reason: result.reason };
  if (result.advisory) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: result.advisory,
      },
    };
  }
  return null;
}

// Env keys the in-process path sets; saved/restored around each call so the
// shared process.env never leaks mocks across serially-run tests. Mirrors the
// run() in-process fast path in hook-pre-tool-gate.test.mjs (pattern (c)).
const RUN_IN_PROCESS_ENV_KEYS = [
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "DEVPRO_SENTINEL_STATE_DIR",
  "DEVPRO_POSTMERGE_STATE_DIR",
  "PWD",
];

// In-process fast path (test-performance-patterns.md pattern (c)): cases that
// only assert the payload→decision JSON call the exported gate directly and
// skip the node spawn. cwd is injected via the payload (toolInputCwd reads
// payload.cwd → no chdir). Returns {json} only — NO `code`: the in-process
// path cannot prove the hook's exit-code contract, so cases asserting the
// PROCESS contract (r.code, real stdout, real git side effects) keep run().
function runInProcess(payload, { cwd, env } = {}) {
  const tempSentinelDir = makeTempDir("sentinel-test-");
  const tempMarkerDir = makeTempDir("postmerge-marker-test-");
  const hookCwd = cwd || process.cwd();
  const saved = {};
  for (const k of RUN_IN_PROCESS_ENV_KEYS) saved[k] = process.env[k];
  for (const k of Object.keys(env || {})) {
    if (!(k in saved)) saved[k] = process.env[k];
  }
  try {
    const apply = {
      CODEX_CI: "",
      CODEX_THREAD_ID: "",
      DEVPRO_SENTINEL_STATE_DIR: tempSentinelDir,
      DEVPRO_POSTMERGE_STATE_DIR: tempMarkerDir,
      PWD: hookCwd,
      ...(env || {}),
    };
    for (const [k, v] of Object.entries(apply)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const result = evaluatePreToolUsePayload({ ...payload, cwd: payload.cwd || hookCwd });
    return { json: gateResultToJson(result), _inProcess: true };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { rmSync(tempSentinelDir, { recursive: true, force: true }); } catch {}
    try { rmSync(tempMarkerDir, { recursive: true, force: true }); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Gate 2h: Release/rules base must originate from production-* tag
// ─────────────────────────────────────────────────────────────────────────

// Test 1: git checkout -b release/rules-<date> <production-* tag> → pass
test("Gate 2h: git checkout -b release/rules-20260511 <production-* tag> → pass", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `git checkout -b release/rules-20260511 ${tagName}` },
    },
    { cwd: dir }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test("Gate 2h: source repo git checkout -b release/rules-20260511 <production-* tag> → block", () => {
  const { dir, tagName } = setupRepoWithProductionTag("production-v6.45.0");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `git checkout -b release/rules-20260511 ${tagName}` },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Source repo release\/rules gate/);
  assert.match(r.json.reason, /release\/v<X\.Y\.Z>/);
});

// Test 2: git checkout -b release/rules-<date> main → block
test("Gate 2h: git checkout -b release/rules-20260511 main → block (Release/rules base gate)", () => {
  const { dir } = setupConsumerRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/rules-20260511 main" },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Release\/rules base gate/);
  assert.match(r.json.reason, /production-\*/);
});

// Test 3: git checkout -b release/rules-<date> HEAD (HEAD is non-tag) → block
test("Gate 2h: git checkout -b release/rules-20260511 HEAD (HEAD not on tag) → block", () => {
  const { dir } = setupConsumerRepoWithProductionTag();
  // HEAD is the second commit (later.txt), which is NOT on the tag
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/rules-20260511 HEAD" },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Release\/rules base gate/);
});

// issue #851/#848 round 9: the equals-form `(?:\s+|=)` fix (round 8) only landed
// on W1; RELEASE_RULES_SWITCH_RE / RELEASE_RULES_CHECKOUT_RE still required
// whitespace, so the equals form escaped the production-tag-base check. Now fixed.
test("Gate 2h: git switch --create=release/rules-20260511 HEAD (equals form, non-tag base) → block", () => {
  const { dir } = setupConsumerRepoWithProductionTag();
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git switch --create=release/rules-20260511 HEAD" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Release\/rules base gate/);
});

test("Gate 2h: git checkout -b=release/rules-20260511 main (equals form) → block", () => {
  const { dir } = setupConsumerRepoWithProductionTag();
  const r = run(
    { tool_name: "Bash", tool_input: { command: "git checkout -b=release/rules-20260511 main" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Release\/rules base gate/);
});

// Test 4: git checkout -b release/rules-<date> (no base, defaults HEAD non-tag) → block
test("Gate 2h: git checkout -b release/rules-20260511 (no base, HEAD defaults to non-tag) → block", () => {
  const { dir } = setupConsumerRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/rules-20260511" },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Release\/rules base gate/);
});

// Test 5: git checkout -b release/rules-<date> production-YYYYMMDD-rules (-rules variant) → pass
test("Gate 2h: git checkout -b release/rules-20260511 production-20260511-rules (-rules variant tag) → pass", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag("production-20260511-rules");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `git checkout -b release/rules-20260511 ${tagName}`,
      },
    },
    { cwd: dir }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test("Gate 2h: git checkout -b release/rules-20260511-2 production-20260511-rules-2 → pass", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag("production-20260511-rules-2");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `git checkout -b release/rules-20260511-2 ${tagName}`,
      },
    },
    { cwd: dir }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

// Test 6: git switch -c release/rules-<date> <production-* tag> → pass
test("Gate 2h: git switch -c release/rules-20260511 <production-* tag> → pass", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: `git switch -c release/rules-20260511 ${tagName}` },
    },
    { cwd: dir }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

// Test 7: git worktree add <abs path> -b release/rules-<date> <production-* tag> → pass
test("Gate 2h: git worktree add <abs path> -b release/rules-20260511 <production-* tag> → pass", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag();
  // Use absolute path so Gate D (Worktree Absolute Path) does not block.
  const wtAbsPath = path.join(dir, ".worktree", "release-rules-20260511");
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: `git worktree add ${wtAbsPath} -b release/rules-20260511 ${tagName}`,
      },
    },
    { cwd: dir }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

// Test 8: git worktree add <path> -b release/rules-<date> main → block
test("Gate 2h: git worktree add <path> -b release/rules-20260511 main → block", () => {
  const { dir } = setupConsumerRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git worktree add .worktree/release-rules-20260511 -b release/rules-20260511 main",
      },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Release\/rules base gate/);
});

// Test 9: non release/rules-* prefix → not fire (no false kill on business release)
test("Gate 2h: non release/rules-* prefix (release/v6.42.3) → not fire", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/v6.42.3 main" },
    },
    { cwd: dir }
  );
  // Must not fire Gate 2h; other gates may fire but not this one
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Release\/rules base gate/);
  }
});

test("Gate 2h: non release/rules-* prefix (release/20260511-abc1234) → not fire", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/20260511-abc1234 main" },
    },
    { cwd: dir }
  );
  // Must not fire Gate 2h
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Release\/rules base gate/);
  }
});

// Test 10: inline DEVPRO_HOOK_BYPASS=1 bypass → pass
test("Gate 2h: inline DEVPRO_HOOK_BYPASS=1 bypass → pass", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "DEVPRO_HOOK_BYPASS=1 git checkout -b release/rules-20260511 main" },
    },
    { cwd: dir }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

// Test 11: False positive — quoted shell var containing git checkout command → pass
test("Gate 2h: false positive — git checkout cmd inside quoted shell var → pass (no mis-trigger)", () => {
  const { dir } = setupRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: 'MSG="git checkout -b release/rules-foo main"; echo $MSG',
      },
    },
    { cwd: dir }
  );
  assert.equal(r.code, 0);
  assert.equal(r.json?.decision, undefined);
});

test("Gate 1 carve-out: consumer release/rules sync-only range allows git add", () => {
  const dir = checkoutRulesReleaseWithSyncCommit();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git add .devpro-agent-rules AGENTS.md .devpro/",
      },
    },
    { cwd: dir },
  );

  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test("Gate 1 carve-out: consumer release/rules sync-only range still blocks broad git add", () => {
  const dir = checkoutRulesReleaseWithSyncCommit();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git add .",
      },
    },
    { cwd: dir },
  );

  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
});

test("Gate 1 carve-out: consumer release/rules sync-only range allows git commit --amend", () => {
  const dir = checkoutRulesReleaseWithSyncCommit();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git commit --amend --no-edit",
      },
    },
    { cwd: dir },
  );

  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test("Gate 1 carve-out: ordinary release branch still blocks git add", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag("production-20260707");
  git(dir, ["checkout", "-q", "-b", "release/20260707-abcdef0", tagName]);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git add .",
      },
    },
    { cwd: dir },
  );

  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
});

test("Gate 1 carve-out: polluted release/rules range still blocks git add", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag("production-20260707-rules");
  git(dir, ["checkout", "-q", "-b", "release/rules-20260707", tagName]);
  writeProjectionFiles(dir, "polluted");
  git(dir, ["add", ".gitmodules", "AGENTS.md", ".devpro-agent-rules"]);
  git(dir, ["commit", "-q", "-m", "docs: unrelated"]);

  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git add .",
      },
    },
    { cwd: dir },
  );

  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
});

test("Gate 1 carve-out: empty release/rules range allows git add only during cherry-pick", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag("production-20260707-rules");
  git(dir, ["checkout", "-q", "-b", "release/rules-20260707", tagName]);
  const cherryPickHead = git(dir, ["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]);
  writeFileSync(
    path.isAbsolute(cherryPickHead) ? cherryPickHead : path.join(dir, cherryPickHead),
    "abcdef0123456789abcdef0123456789abcdef01\n",
  );

  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git add .devpro-agent-rules AGENTS.md .devpro/",
      },
    },
    { cwd: dir },
  );

  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test("Gate 1 carve-out: empty release/rules cherry-pick still blocks broad git add", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag("production-20260707-rules");
  git(dir, ["checkout", "-q", "-b", "release/rules-20260707", tagName]);
  const cherryPickHead = git(dir, ["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]);
  writeFileSync(
    path.isAbsolute(cherryPickHead) ? cherryPickHead : path.join(dir, cherryPickHead),
    "abcdef0123456789abcdef0123456789abcdef01\n",
  );

  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git add .",
      },
    },
    { cwd: dir },
  );

  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
});

test("Gate 1 carve-out: empty release/rules range does not allow git commit --amend", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag("production-20260707-rules");
  git(dir, ["checkout", "-q", "-b", "release/rules-20260707", tagName]);
  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git commit --amend --no-edit",
      },
    },
    { cwd: dir },
  );

  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Protected-branch gate/);
});

test("Production Tag V2: linked worktree release/rules branch counts as local branch", () => {
  const { dir, tagName } = setupConsumerRepoWithProductionTag("production-20260707-rules");
  const wtPath = path.join(tmpRoot, `linked-release-rules-${repoCounter++}`);
  git(dir, ["worktree", "add", "-q", "-b", "release/rules-20260707-2", wtPath, tagName]);

  const branchList = git(dir, ["branch", "--list", "release/rules-20260707-2"]);
  assert.match(
    branchList,
    /^\+ release\/rules-20260707-2$/m,
    "test fixture must reproduce git branch linked-worktree plus marker",
  );

  const r = run(
    {
      tool_name: "Bash",
      tool_input: {
        command: "git tag production-20260707-rules-2",
      },
    },
    { cwd: dir },
  );

  assert.equal(r.code, 0);
  assert.equal(
    r.json,
    null,
    `matching release branch checked out in linked worktree must satisfy V2; got ${JSON.stringify(r.json)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Gate 2h first-rules-release (zero production-* tag) — D3 / #2634
// ─────────────────────────────────────────────────────────────────────────

/**
 * Consumer repo with production branch tip but ZERO production-* tags.
 * main has one extra commit so HEAD(main) !== production tip.
 */
function setupConsumerRepoZeroTagWithProductionTip({ withRemoteProduction = false } = {}) {
  const dir = path.join(tmpRoot, `repo-zero-tag-${repoCounter++}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeConsumerGitmodules(dir);
  writePreflightFixture(dir);
  writeFileSync(path.join(dir, "init.txt"), "");
  spawnSync("git", ["add", "init.txt", ".gitmodules"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  // production tip = current HEAD
  spawnSync("git", ["branch", "production"], { cwd: dir });
  if (withRemoteProduction) {
    spawnSync("git", ["update-ref", "refs/remotes/origin/production", "HEAD"], { cwd: dir });
  }
  // Advance main so main tip ≠ production tip
  writeFileSync(path.join(dir, "later.txt"), "");
  spawnSync("git", ["add", "later.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "later-on-main"], { cwd: dir });
  return dir;
}

test("Gate 2h first-rules-release: zero tag + remote production tip base → pass", () => {
  const dir = setupConsumerRepoZeroTagWithProductionTip({ withRemoteProduction: true });
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/rules-20260916 origin/production" },
    },
    { cwd: dir },
  );
  assert.equal(r.code, 0, `expected pass; got ${JSON.stringify(r.json)}`);
  assert.equal(r.json, null);
});

test("Gate 2h first-rules-release: local-only production cannot establish the PR target", () => {
  const dir = setupConsumerRepoZeroTagWithProductionTip();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/rules-20260916 production" },
    },
    { cwd: dir },
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /production target absent/);
  assert.doesNotMatch(r.json.reason, /elif git rev-parse --verify --quiet production/);
  assert.doesNotMatch(r.json.reason, /then TAG=production/);
});

test("Gate 2h first-rules-release: zero tag + main base → block", () => {
  const dir = setupConsumerRepoZeroTagWithProductionTip();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/rules-20260916 main" },
    },
    { cwd: dir },
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Release\/rules base gate/);
  assert.match(r.json.reason, /first-rules-release|production tip|零 tag/i);
});

test("Gate 2h: has production-* tag + main base → still block", () => {
  const { dir } = setupConsumerRepoWithProductionTag();
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/rules-20260916 main" },
    },
    { cwd: dir },
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Release\/rules base gate/);
});

test("Gate 2h first-rules-release: zero tag + HEAD on main (≠ production tip) → block", () => {
  const dir = setupConsumerRepoZeroTagWithProductionTip();
  // HEAD is main tip (later-on-main), not production tip
  const r = run(
    {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b release/rules-20260916 HEAD" },
    },
    { cwd: dir },
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Release\/rules base gate/);
});
