/**
 * hook-pre-tool-gate-worktree-mandatory.test.mjs
 *
 * Integration tests for Gate W1 / W2a / W2b in pre-tool-gate.mjs:
 *   W1  — block in-place `git checkout -b` / `git switch -c` and plain
 *         `git checkout` / `git switch` of any branch when in main worktree
 *         (action-based; no prefix is exempt)
 *   W2a — `git worktree add <path> -b <prefix>/<name>` requires
 *         basename(<path>) === <name>
 *   W2b — Edit/Write to openspec/changes/<X>/proposal*.md inside a sub-worktree
 *         requires <X> === branch-name segment === worktree dir basename
 *
 * Cases call the gate in-process via runHook() (the exported
 * evaluatePreToolUsePayload) and assert block/pass on the returned JSON.
 * runHookSpawn() is kept as the end-to-end path for any future case that needs
 * the hook PROCESS contract (exit code / real stdout-stderr emission).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// In-process seam (perf): the exported dispatch core lets most cases skip the
// node-spawn. Cases asserting the hook PROCESS contract (stdout/stderr/exit)
// keep using runHookSpawn().
import { evaluatePreToolUsePayload, PASS_THROUGH } from "../hooks/pre-tool-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";
import { advisoryText } from "./lib/hook-harness.mjs";
import { computeSeamsContentFingerprint } from "../lib/clarification-contract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(SCRIPT_DIR, "../hooks/pre-tool-gate.mjs");

const REAL_PREFLIGHT = readFileSync(
  path.resolve(SCRIPT_DIR, "../../agent-rules/preflight-checklist.md"),
  "utf8"
);
const REAL_ANCHOR_RULE = readFileSync(
  path.resolve(SCRIPT_DIR, "../../agent-rules/git-branch-naming-and-anchor.md"),
  "utf8"
);

const tmpRoot = makeTempDir("wt-mandatory-test-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

let counter = 0;

// Template cache keyed by (branchName, withRule) — the git content is
// identical regardless of subWorktree (that flag only changes the
// destination *path* the fixture is copied to, not its git history/files),
// so building the git init + commit sequence (5 real git spawns) once per
// distinct (branchName, withRule) pair and reusing it via cpSync removes the
// dominant per-call cost. Every caller only reads repo state through
// runHook()'s in-process evaluatePreToolUsePayload() or mutates its OWN
// fresh copy (e.g. setupActualSubWorktree()'s `git worktree add` against the
// returned dir) — never the shared template — so this is safe.
const repoTemplateByKey = new Map();

function createRepoTemplate(branchName, withRule) {
  const key = `${branchName} ${withRule}`;
  if (repoTemplateByKey.has(key)) return repoTemplateByKey.get(key);

  const dir = path.join(tmpRoot, `template-${repoTemplateByKey.size}`);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", branchName], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  if (withRule) {
    mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
    writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
    writeFileSync(path.join(dir, ".devpro/agent-rules/git-branch-naming-and-anchor.md"), REAL_ANCHOR_RULE);
  }
  writeFileSync(path.join(dir, "x"), "");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  repoTemplateByKey.set(key, dir);
  return dir;
}

function setupRepo({ branchName = "main", subWorktree = false, withRule = true } = {}) {
  // subWorktree=true → place repo at `<tmpRoot>/.worktree/<dirName>` so cwd
  // looks like a real sub-worktree (W1 should skip)
  const dirName = `repo-${counter++}`;
  const dir = subWorktree
    ? path.join(tmpRoot, ".worktree", dirName)
    : path.join(tmpRoot, dirName);
  const template = createRepoTemplate(branchName, withRule);
  mkdirSync(path.dirname(dir), { recursive: true });
  cpSync(template, dir, { recursive: true });
  return dir;
}

function setupActualSubWorktree(mainDir) {
  const dirName = `repo-${counter++}`;
  const wtPath = path.join(mainDir, ".worktree", dirName);
  spawnSync("git", ["worktree", "add", "-q", "-b", `chore/wt-${dirName}`, wtPath, "HEAD"], {
    cwd: mainDir,
  });
  return wtPath;
}

// fix-flow-gate-gaps R1: main checkout + a REAL linked worktree whose branch
// name segment === change folder name, mirroring the live shape where a
// session rooted in the main checkout writes a *relative* path into the
// worktree (`git worktree add <main>/.worktree/<change> -b bugfix/<change>`).
function setupRelativeSeamsFixture() {
  const changeName = "seams-rel-change";
  const mainDir = setupRepo({ branchName: "main" });
  writeFileSync(path.join(mainDir, ".gitignore"), ".worktree/\n");
  spawnSync("git", ["add", ".gitignore"], { cwd: mainDir });
  spawnSync("git", ["commit", "-q", "-m", "ignore worktrees"], { cwd: mainDir });
  const wtPath = path.join(mainDir, ".worktree", changeName);
  spawnSync("git", ["worktree", "add", "-q", "-b", `bugfix/${changeName}`, wtPath, "HEAD"], {
    cwd: mainDir,
  });
  const wtChangeDir = path.join(wtPath, "openspec", "changes", changeName);
  mkdirSync(wtChangeDir, { recursive: true });
  const relativeTarget = `.worktree/${changeName}/openspec/changes/${changeName}/proposal-mini.md`;
  const worktreeSiblingTail = `.worktree/${changeName}/openspec/changes/${changeName}/meeting-notes.md`;
  return { changeName, mainDir, wtPath, wtChangeDir, relativeTarget, worktreeSiblingTail };
}

function writeConfirmedSeamsNotesInto(dir, seamsText) {
  writeFileSync(
    path.join(dir, "meeting-notes.md"),
    `## Seams Confirmation
- seams: ${seamsText}
- confirmed: true
- provenance: user
- bypass: none
- bypass_reason:
- seams_fingerprint: ${computeSeamsContentFingerprint(seamsText)}
- reconfirm_required: false
- invalidation_reason: none
`,
  );
}

function addIgnoredBodyCarriers(mainDir) {
  // notes/ mirrors the real repo .gitignore (managed region) so that the
  // notes/tmp/ TL-body destination is genuinely gitignored in the fixture —
  // the Protected-branch gate allows gitignored paths (refs/, notes/, .worktree/).
  writeFileSync(
    path.join(mainDir, ".gitignore"),
    ".pr-body.md\n.cross-model-sticky-*\nnotes/\n"
  );
  spawnSync("git", ["add", ".gitignore"], { cwd: mainDir });
  spawnSync("git", ["commit", "-q", "-m", "ignore body carriers"], { cwd: mainDir });
}

// Map a raw evaluatePreToolUsePayload() result to the JSON the hook would emit.
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

// In-process fast path. Injects cwd via the payload (toolInputCwd reads
// payload.cwd → no chdir), applies env overrides, calls the gate directly, and
// restores env. No `code`/`stdout`/`stderr`: the in-process path doesn't run a
// process, so cases needing those use runHookSpawn().
function runHook(payload, { cwd, env = {} } = {}) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const enriched = cwd ? { ...payload, cwd: payload.cwd || cwd } : payload;
    return { json: gateResultToJson(evaluatePreToolUsePayload(enriched)) };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Spawn path (end-to-end): full hook in a child process. Use when a test
// asserts the hook PROCESS contract (exit code, real stdout/stderr emission).
function runHookSpawn(payload, { cwd, env = {} } = {}) {
  const r = spawnSync("node", [HOOK], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: process.env.PATH },
  });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// ── W1 — Worktree Mandatory For Branch Create ──────────────────────────────

test("W1A: git switch -c chore/add-foo in main worktree → block", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git switch -c chore/add-foo" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Create gate/);
});

// round16 guard: an `env [VAR=val …]`-prefixed in-place create on a main
// worktree MUST still block — the create-gate regex re-anchors at the boundary
// before `git`, so the `env` passthrough prefix does not hide the create
// (confirms the round-15 env-passthrough handling opened no W1 false-negative).
test("W1A-env: env FOO=1 git switch -c chore/add-foo in main worktree → block", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "env FOO=1 git switch -c chore/add-foo" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `env-prefixed create must still block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Create gate/);
});

test("W1B: git checkout -b feature/add-foo in main worktree → block", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout -b feature/add-foo" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Worktree Mandatory/);
});

test("W1C: git switch -c release/v1.0.0 in main worktree → block (action-based, no prefix exempt)", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git switch -c release/v1.0.0" } },
    { cwd: dir }
  );
  // action-based: all branch creates in main worktree are blocked, release/ no longer exempt
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Worktree Mandatory For Branch Create/);
});

test("W1D: cwd inside .worktree/x → pass (already in sub-worktree)", () => {
  const dir = setupRepo({ branchName: "main", subWorktree: true });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git switch -c chore/add-foo" } },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block");
});

test("W1E: git worktree add ... -b chore/add-foo (not in-place form) → no W1 block", () => {
  const dir = setupRepo({ branchName: "main" });
  const wtPath = `${dir}/.worktree/foo`;
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git worktree add ${wtPath} -b chore/add-foo main` } },
    { cwd: dir }
  );
  // W1 only fires on in-place; this command may pass or hit W2a. Either way, NOT W1.
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Worktree Mandatory For Branch Create/);
  }
});

test("W1F: inline DEVPRO_HOOK_BYPASS=1 bypass → pass even when W1 would fire", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "DEVPRO_HOOK_BYPASS=1 git switch -c chore/add-foo" } },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block");
});

test("W1H: git switch --create chore/add-foo (long form) → block", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git switch --create chore/add-foo" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Worktree Mandatory For Branch Create/);
});

test("W1I: git checkout --orphan feature/add-foo → block", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout --orphan feature/add-foo" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Worktree Mandatory For Branch Create/);
});

test("W1J: git switch --force-create chore/add-foo → block", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git switch --force-create chore/add-foo" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
});

test("W1K: git checkout chore/add-foo in main worktree → block", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout chore/add-foo" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout/);
});

test("W1L: git switch bugfix/fix-foo in main worktree → block", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git switch bugfix/fix-foo" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout/);
});

test("W1M: plain checkout inside .worktree/x → pass", () => {
  const dir = setupRepo({ branchName: "main", subWorktree: true });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout chore/add-foo" } },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block");
});

test("W1M2: git -C sub-worktree checkout mandatory branch from main hook cwd → pass", () => {
  const mainDir = setupRepo({ branchName: "main" });
  const subWorktreeDir = setupActualSubWorktree(mainDir);
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: { command: `git -C ${JSON.stringify(subWorktreeDir)} checkout chore/add-foo` },
    },
    { cwd: mainDir }
  );
  assert.equal(r.json, null, `should not block from git -C sub-worktree: ${JSON.stringify(r.json)}`);
});

test("W1M3: git -C sub-worktree switch mandatory branch from main hook cwd → pass", () => {
  const mainDir = setupRepo({ branchName: "main" });
  const subWorktreeDir = setupActualSubWorktree(mainDir);
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: { command: `git -C ${JSON.stringify(subWorktreeDir)} switch bugfix/fix-foo` },
    },
    { cwd: mainDir }
  );
  assert.equal(r.json, null, `should not block from git -C sub-worktree: ${JSON.stringify(r.json)}`);
});

test("W1M4: cd sub-worktree then checkout mandatory branch from main hook cwd → pass", () => {
  const mainDir = setupRepo({ branchName: "main" });
  const subWorktreeDir = setupActualSubWorktree(mainDir);
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: { command: `cd ${JSON.stringify(subWorktreeDir)} && git checkout chore/add-foo` },
    },
    { cwd: mainDir }
  );
  assert.equal(r.json, null, `should not block after cd to sub-worktree: ${JSON.stringify(r.json)}`);
});

// R16 (shared cwd arithmetic): a chdir inside parentheses leaves the cwd
// unresolvable. The two Worktree Mandatory gates resolve it through
// resolveSafe(UNRESOLVABLE_CWD); that must neither throw nor block. The space
// before `)` keeps the branch-name token clear of the closing parenthesis.
for (const [label, build] of [
  ["create, (cd sub-worktree && git switch -c)", (wt) => `(cd ${JSON.stringify(wt)} && git switch -c chore/add-foo )`],
  ["create, backtick cd then git checkout -b", (wt) => `\`cd ${wt}\` ; git checkout -b feature/add-foo`],
  ["checkout, (cd sub-worktree && git checkout)", (wt) => `(cd ${JSON.stringify(wt)} && git checkout chore/add-foo )`],
  ["checkout, (cd sub-worktree; git switch)", (wt) => `(cd ${JSON.stringify(wt)}; git switch bugfix/fix-foo )`],
]) {
  test(`W1R16: ${label} from main hook cwd → unresolvable cwd does not throw and passes`, () => {
    const mainDir = setupRepo({ branchName: "main" });
    const subWorktreeDir = setupActualSubWorktree(mainDir);
    const r = runHook(
      { tool_name: "Bash", tool_input: { command: build(subWorktreeDir) } },
      { cwd: mainDir }
    );
    assert.equal(r.json, null, `unresolvable cwd must pass, got ${JSON.stringify(r.json)}`);
  });
}

test("W1R16: unresolvable cwd also passes through the real hook process without a crash", () => {
  const mainDir = setupRepo({ branchName: "main" });
  const subWorktreeDir = setupActualSubWorktree(mainDir);
  const r = runHookSpawn(
    {
      tool_name: "Bash",
      tool_input: { command: `(cd ${JSON.stringify(subWorktreeDir)} && git switch -c chore/add-foo )` },
    },
    { cwd: mainDir }
  );
  assert.equal(r.code, 0, `hook must exit 0, stderr: ${r.stderr}`);
  assert.equal(r.json, null, `unresolvable cwd must pass, got ${r.stdout}`);
  assert.doesNotMatch(r.stderr || "", /Error|at .*\.mjs/);
});

test("W1R16: parenthesized create or checkout with no cd on main → still block (resolves to the hook cwd)", () => {
  const dir = setupRepo({ branchName: "main" });
  const create = runHook(
    { tool_name: "Bash", tool_input: { command: "(git switch -c chore/add-foo )" } },
    { cwd: dir }
  );
  assert.equal(create.json?.decision, "block", `expected block, got ${JSON.stringify(create.json)}`);
  assert.match(create.json.reason, /Worktree Mandatory For Branch Create gate/);
  const checkout = runHook(
    { tool_name: "Bash", tool_input: { command: "(git checkout chore/add-foo )" } },
    { cwd: dir }
  );
  assert.equal(checkout.json?.decision, "block", `expected block, got ${JSON.stringify(checkout.json)}`);
  assert.match(checkout.json.reason, /Worktree Mandatory For Branch Checkout/);
});

test("W1M5: cd sub-worktree then switch mandatory branch from main hook cwd → pass", () => {
  const mainDir = setupRepo({ branchName: "main" });
  const subWorktreeDir = setupActualSubWorktree(mainDir);
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: { command: `cd ${JSON.stringify(subWorktreeDir)} && git switch bugfix/fix-foo` },
    },
    { cwd: mainDir }
  );
  assert.equal(r.json, null, `should not block after cd to sub-worktree: ${JSON.stringify(r.json)}`);
});

// issue #851/#848 round 7: the in-place-branch-create matcher previously
// consumed only a leading `git -C <dir>`, so a create hidden behind any other
// git global option evaded the worktree-mandatory gate. Now generalized via the
// shared GIT_GLOBAL_OPT grammar — these MUST block on a main worktree.
for (const [label, command] of [
  ["W1O: --no-pager switch -c", "git --no-pager switch -c chore/add-foo"],
  ["W1P: -P checkout -b", "git -P checkout -b feature/add-foo"],
  ["W1Q: --no-optional-locks switch --create", "git --no-optional-locks switch --create bugfix/fix-foo"],
  ["W1R: --no-pager checkout --orphan", "git --no-pager checkout --orphan feature/add-foo"],
]) {
  test(`${label} in main worktree → block`, () => {
    const dir = setupRepo({ branchName: "main" });
    const r = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
  });
}

test("W1S: DEVPRO_HOOK_BYPASS=1 before a global-flag create → pass (bypass honored)", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "DEVPRO_HOOK_BYPASS=1 git --no-pager switch -c chore/add-foo" } },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block");
});

// issue #851/#848 round 8 (cross-model CRITICAL): IN_PLACE_BRANCH_CREATE_RE
// required whitespace after the create flag, so the `=` equals form escaped W1
// even though extractBranchNameFromCommand surfaces it AND the
// `Branch Force-Create Verb Coverage` spec requires equals-form coverage. The
// branch name is valid (chore/add) so only W1 — not the verb-whitelist — gates it.
for (const [label, command] of [
  ["W1T: switch --create= equals form", "git switch --create=chore/add-foo"],
  ["W1U: checkout -b= equals form", "git checkout -b=chore/add-foo"],
  ["W1V: switch -c= equals form", "git switch -c=chore/add-foo"],
  ["W1W: --create= behind a global option", "git --no-pager switch --create=chore/add-foo"],
]) {
  test(`${label} in main worktree → block`, () => {
    const dir = setupRepo({ branchName: "main" });
    const r = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
    assert.equal(r.json?.decision, "block", `expected block, got: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /Worktree Mandatory For Branch Create/);
  });
}

test("W1N: git checkout release/v1.0.0 in main worktree → block (action-based, no prefix exempt)", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout release/v1.0.0" } },
    { cwd: dir }
  );
  // action-based: all branch checkouts in main worktree are blocked, release/ no longer exempt
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout/);
});

test("W1O: git checkout feature/add-foo -- README.md restores file → pass", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout feature/add-foo -- README.md" } },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Worktree Mandatory For Branch Checkout/);
  }
});

test("W2bD: release/* branch in sub-worktree writing to changes/ → no W2b block (release exempt)", () => {
  const dirName = `release-test-${counter++}`;
  const dir = path.join(tmpRoot, ".worktree", dirName);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "release/v1.0.0"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
  writeFileSync(path.join(dir, ".devpro/agent-rules/git-branch-naming-and-anchor.md"), REAL_ANCHOR_RULE);
  writeFileSync(path.join(dir, "x"), "");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const filePath = path.join(dir, "openspec/changes/whatever/proposal-mini.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "x" } },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Three-Way Name Alignment/);
  }
});

test("W1P: git checkout main in main worktree → pass (checkout to protected mainline is exempt)", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout main" } },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `checkout to protected mainline should pass, got ${JSON.stringify(r.json)}`);
});

test("W1Q: git checkout production in main worktree → pass (checkout to protected mainline is exempt)", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout production" } },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `checkout to production mainline should pass, got ${JSON.stringify(r.json)}`);
});

test("W1R: git checkout master in main worktree → pass (checkout to protected mainline is exempt)", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout master" } },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `checkout to master mainline should pass, got ${JSON.stringify(r.json)}`);
});

test("W1S: git checkout integration in main worktree → pass (checkout to protected mainline is exempt)", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout integration" } },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `checkout to integration mainline should pass, got ${JSON.stringify(r.json)}`);
});

test("W1T: git checkout feature/some-branch in main worktree → block (work branch still mandates worktree)", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout feature/some-branch" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `checkout to work branch should be blocked, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Worktree Mandatory For Branch Checkout/);
});

test("W1U: git checkout feature/some-branch inside .worktree/ → pass (isInsideSubWorktree exempt)", () => {
  const dir = setupRepo({ branchName: "main", subWorktree: true });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git checkout feature/some-branch" } },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `checkout inside sub-worktree should pass, got ${JSON.stringify(r.json)}`);
});

test("W1G: repo without rule SoT file → skip (test fixture compatibility)", () => {
  const dir = setupRepo({ branchName: "main", withRule: false });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: "git switch -c chore/add-foo" } },
    { cwd: dir }
  );
  // No rule file → W1 skips. Assert that *if* another gate blocks, it is not W1.
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Worktree Mandatory For Branch Create/);
  }
});

// ── W2a — Three-Way Name Alignment (worktree add) ──────────────────────────

test("W2aA: git worktree add /abs/.worktree/wrong -b feature/right main → block", () => {
  const dir = setupRepo({ branchName: "main" });
  const wtPath = `${dir}/.worktree/wrong-name`;
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git worktree add ${wtPath} -b feature/add-right-name main` } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Three-Way Name Alignment.*worktree add/);
  assert.match(r.json.reason, /wrong-name/);
  assert.match(r.json.reason, /right-name/);
});

test("W2aB: aligned worktree add → pass", () => {
  const dir = setupRepo({ branchName: "main" });
  const wtPath = `${dir}/.worktree/add-foo-bar`;
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git worktree add ${wtPath} -b feature/add-foo-bar main` } },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Three-Way Name Alignment/);
  }
});

test("W2aD: aligned worktree add preceded by echo containing literal 'worktree add' → no W2a false-block", () => {
  // Regression (RULE-FEEDBACK): extractWorktreeAddPath used a bare
  // cmd.search(/\bworktree\s+add\b/) that matched the FIRST literal "worktree add"
  // anywhere in the compound command — including inside echo/quoted text — so the
  // basename was extracted from echo residue (e.g. "with"/"from"), false-blocking a
  // legitimate aligned `git worktree add`. The path basename here DOES match the
  // branch segment, so a correct parser must NOT raise Three-Way Name Alignment.
  const dir = setupRepo({ branchName: "main" });
  const wtPath = `${dir}/.worktree/add-foo-bar`;
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `echo "=== retry worktree add with explicit SHA ===" && git worktree add ${wtPath} -b chore/add-foo-bar main`,
      },
    },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(
      r.json.reason,
      /Three-Way Name Alignment/,
      `echo text containing "worktree add" must not pollute basename extraction; got block: ${r.json.reason}`
    );
  }
});

test("W2aE: MISaligned worktree add preceded by echo with 'worktree add' → STILL blocks (no over-correction)", () => {
  // Guard the fix against over-correction: the real (mismatched) worktree add must
  // still be caught even when an echo also contains "worktree add".
  const dir = setupRepo({ branchName: "main" });
  const wtPath = `${dir}/.worktree/wrong-name`;
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `echo "running worktree add now" && git worktree add ${wtPath} -b feature/add-right-name main`,
      },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Three-Way Name Alignment.*worktree add/);
  assert.match(r.json.reason, /wrong-name/);
  assert.match(r.json.reason, /right-name/);
});

test("W2aC: release/* worktree add with mismatched basename → no W2a block (release exempt)", () => {
  const dir = setupRepo({ branchName: "main" });
  const wtPath = `${dir}/.worktree/anywhere`;
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git worktree add ${wtPath} -b release/v1.0.0 main` } },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Three-Way Name Alignment/);
  }
});

test("W2aF: command chain — SECOND worktree add misaligned → STILL blocks (multi-occurrence)", () => {
  // Regression (RULE-FEEDBACK, dp-reviewer PR #1298): checkBranchNameAlignment used a
  // single-value extractWorktreeAddPath/extractBranchNameFromCommand, so only the FIRST
  // worktree add in a command chain was checked — a later misaligned add was missed.
  // Base-class gates already iterate every add via extractWorktreeAddCreates (#851/#848
  // round-12); W2a must do the same. First add is aligned, second is misaligned.
  const dir = setupRepo({ branchName: "main" });
  const okPath = `${dir}/.worktree/add-foo-bar`;
  const wrongPath = `${dir}/.worktree/wrong-second`;
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `git worktree add ${okPath} -b chore/add-foo-bar main && git worktree add ${wrongPath} -b chore/add-second-right main`,
      },
    },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Three-Way Name Alignment.*worktree add/);
  // The block must name the SECOND (misaligned) add's basename/segment, not the first.
  assert.match(r.json.reason, /wrong-second/);
  assert.match(r.json.reason, /add-second-right/);
});

test("W2aG: command chain — BOTH worktree adds aligned → pass (no false-block)", () => {
  const dir = setupRepo({ branchName: "main" });
  const p1 = `${dir}/.worktree/add-alpha`;
  const p2 = `${dir}/.worktree/add-beta`;
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `git worktree add ${p1} -b chore/add-alpha main && git worktree add ${p2} -b chore/add-beta main`,
      },
    },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Three-Way Name Alignment/);
  }
});

test("W2aH: misaligned worktree-add literal inside quoted/heredoc body → no W2a false-block (segment-stripped)", () => {
  // Regression (multi-occurrence follow-up): after W2a moved to iterate EVERY add,
  // a `git worktree add … -b chore/x` literal appearing inside a quoted string or
  // heredoc body (e.g. a `git commit -F -` message, or `echo "example: git worktree
  // add WRONG -b chore/b"`) was mis-read as a real command and false-blocked, because
  // checkBranchNameAlignment received the RAW cmd. The gate MUST operate on
  // gateCommandSegmentText(cmd) so quoted/heredoc/comment bodies are stripped first
  // (per lib NOTE: gate fns receive segment-stripped text). The real command here is a
  // benign `git commit`; the worktree-add lives only inside the quoted message.
  const dir = setupRepo({ branchName: "main" });
  const literal =
    "git " + "worktree " + "add /x/.worktree/WRONG -b chore/some-other-name main";
  const r = runHook(
    {
      tool_name: "Bash",
      tool_input: {
        command: `git commit -m "docs: explain the gate, e.g. ${literal}"`,
      },
    },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(
      r.json.reason,
      /Three-Way Name Alignment/,
      `worktree-add literal inside quoted commit message must not trigger W2a; got: ${r.json.reason}`
    );
  }
});

test("W2aI: quoted \$VAR path (e.g. \"\$ROOT/.worktree/fix-gate-n-foo\") + aligned branch → no Three-Way block (fail-open, basename not resolvable)", () => {
  // Live trigger 2026-06-28: gate false-blocked `git worktree add "$ROOT/.worktree/fix-gate-n-foo" -b chore/fix-gate-n-foo HEAD`
  // because the command parser collapses quoted spans to __QUOTED__, so basename resolved to __QUOTED__ ≠ branch segment.
  // git-branch-naming-and-anchor.md §Worktree 規範 (`<repo-root-abs>` 翻譯) blesses $REPO_ROOT paths; gate MUST fail-open when basename is not resolvable.
  // Use single-quoted JS string so '$ROOT' is literal in the command payload (not JS-interpolated).
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: 'git worktree add "$ROOT/.worktree/fix-gate-n-foo" -b chore/fix-gate-n-foo main' } },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(
      r.json.reason,
      /Three-Way Name Alignment/,
      `quoted \$VAR worktree path must not trigger Three-Way gate (basename unresolvable); got: ${r.json.reason}`
    );
  }
});

test("W2aJ: unquoted \$VAR path (e.g. \$ROOT/.worktree/foo) + aligned branch → no Three-Way block (fail-open)", () => {
  // Unquoted $VAR in the path also cannot be statically resolved to a basename.
  // Gate must fail-open per hook accident-prevention philosophy.
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: 'git worktree add $ROOT/.worktree/fix-gate-n-bar -b chore/fix-gate-n-bar main' } },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(
      r.json.reason,
      /Three-Way Name Alignment/,
      `unquoted \$VAR worktree path must not trigger Three-Way gate; got: ${r.json.reason}`
    );
  }
});

test("W2aK: \$VAR in basename (e.g. \$ROOT/.worktree/foo-\$SUF) + branch chore/foo-bar → no Three-Way block (fail-open)", () => {
  // When $VAR appears in the basename portion itself (foo-$SUF vs foo-bar), the
  // literal basename is foo-$SUF which != foo-bar but the mismatch is due to
  // unexpanded variable — not a real misalignment. Must fail-open.
  const dir = setupRepo({ branchName: "main" });
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: 'git worktree add $ROOT/.worktree/foo-$SUF -b chore/foo-bar main' } },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(
      r.json.reason,
      /Three-Way Name Alignment/,
      `\$VAR in basename must not trigger Three-Way gate; got: ${r.json.reason}`
    );
  }
});

test("W2aL: regression — unquoted literal-absolute MISaligned path (no \$ / no __QUOTED__) → STILL blocks (guard must not over-widen)", () => {
  // Regression guard: the fail-open guard must only skip paths containing $ or __QUOTED__.
  // A plain JS-interpolated absolute path with mismatched basename must still trigger block.
  const dir = setupRepo({ branchName: "main" });
  const wtPath = `${dir}/.worktree/wrong-name`;
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git worktree add ${wtPath} -b feature/add-right-name main` } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `literal-absolute misaligned path must still block; got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Three-Way Name Alignment.*worktree add/);
  assert.match(r.json.reason, /wrong-name/);
  assert.match(r.json.reason, /right-name/);
});

// ── Branch verb whitelist hard gate ────────────────────────────────────────

test("Branch verb whitelist: git worktree add path-with-hyphen -b chore/tighten-foo → block", () => {
  const dir = setupRepo({ branchName: "main" });
  const wtPath = `${dir}/.worktree/tighten-foo`;
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git worktree add ${wtPath} -b chore/tighten-foo main` } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block", `expected branch-verb block, got: ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Branch Verb Whitelist gate/);
  assert.match(r.json.reason, /tighten/);
});

test("Branch verb whitelist: dynamic branch token is not guessed by regex gate", () => {
  const dir = setupRepo({ branchName: "main" });
  const wtPath = `${dir}/.worktree/dynamic-branch`;
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git worktree add ${wtPath} -b "$BRANCH" main` } },
    { cwd: dir }
  );
  assert.notEqual(r.json?.decision, "block", `dynamic branch token should not be guessed, got: ${JSON.stringify(r.json)}`);
  assert.doesNotMatch(advisoryText(r.json), /Branch Verb Whitelist gate/);
});

// ── W2b — Three-Way Name Alignment (proposal write) ────────────────────────

// Scenario: Windows Change Proposal Path Reaches Alignment And Seams Gates
test("W2bA: Write openspec/changes/wrong/proposal.md while branch=feature/right in worktree dir 'right' → block", () => {
  // Setup: sub-worktree dir 'right', branch 'feature/right', try to write
  // openspec/changes/wrong/proposal.md
  const dirName = `right-${counter++}`;
  const dir = path.join(tmpRoot, ".worktree", dirName);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", `feature/${dirName}`], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
  writeFileSync(path.join(dir, ".devpro/agent-rules/git-branch-naming-and-anchor.md"), REAL_ANCHOR_RULE);
  writeFileSync(path.join(dir, "x"), "");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const filePath = path.join(dir, "openspec/changes/wrong/proposal-mini.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "x" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Three-Way Name Alignment.*proposal write/);
  assert.match(r.json.reason, /沒有 inline Bash bypass/);
  assert.match(r.json.reason, /wrong/);
});

test("W2bB: Write openspec/changes/right/proposal.md while branch=feature/right in worktree dir 'right' → pass", () => {
  const dirName = `right-${counter++}`;
  const dir = path.join(tmpRoot, ".worktree", dirName);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", `feature/${dirName}`], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
  writeFileSync(path.join(dir, ".devpro/agent-rules/git-branch-naming-and-anchor.md"), REAL_ANCHOR_RULE);
  writeFileSync(path.join(dir, "x"), "");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  // Seams-first: sibling meeting-notes with confirmed seams required for proposal write
  const changeDir = path.join(dir, `openspec/changes/${dirName}`);
  mkdirSync(changeDir, { recursive: true });
  const seamsOk = `grep alignment for ${dirName}`;
  writeFileSync(
    path.join(changeDir, "meeting-notes.md"),
    `## Seams Confirmation
- seams: ${seamsOk}
- confirmed: true
- provenance: user
- bypass: none
- bypass_reason:
- seams_fingerprint: ${computeSeamsContentFingerprint(seamsOk)}
- reconfirm_required: false
- invalidation_reason: none
`,
  );

  const filePath = path.join(changeDir, "proposal-mini.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "x" } },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Three-Way Name Alignment/);
    assert.doesNotMatch(r.json.reason, /Seams-first expansion gate/);
  }
});

test("W2bB2: Write proposal without sibling meeting-notes → Seams-first fail-closed", () => {
  const dirName = `right-miss-${counter++}`;
  const dir = path.join(tmpRoot, ".worktree", dirName);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", `feature/${dirName}`], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
  writeFileSync(path.join(dir, ".devpro/agent-rules/git-branch-naming-and-anchor.md"), REAL_ANCHOR_RULE);
  writeFileSync(path.join(dir, "x"), "");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const filePath = path.join(dir, `openspec/changes/${dirName}/proposal-mini.md`);
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "x" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Seams-first expansion gate/);
  assert.match(r.json.reason, /meeting-notes/);
});

test("W2bB3: Write proposal with stale reconfirm_required seams → fail-closed", () => {
  const dirName = `right-stale-${counter++}`;
  const dir = path.join(tmpRoot, ".worktree", dirName);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", `feature/${dirName}`], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(path.join(dir, ".devpro/agent-rules"), { recursive: true });
  writeFileSync(path.join(dir, ".devpro/agent-rules/preflight-checklist.md"), REAL_PREFLIGHT);
  writeFileSync(path.join(dir, ".devpro/agent-rules/git-branch-naming-and-anchor.md"), REAL_ANCHOR_RULE);
  writeFileSync(path.join(dir, "x"), "");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const changeDir = path.join(dir, `openspec/changes/${dirName}`);
  mkdirSync(changeDir, { recursive: true });
  const seamsStale = `grep alignment for ${dirName}`;
  writeFileSync(
    path.join(changeDir, "meeting-notes.md"),
    `## Seams Confirmation
- seams: ${seamsStale}
- confirmed: false
- provenance: user
- bypass: none
- bypass_reason:
- seams_fingerprint: ${computeSeamsContentFingerprint(seamsStale)}
- reconfirm_required: true
- invalidation_reason: frontier-change
`,
  );

  const filePath = path.join(changeDir, "proposal-mini.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "x" } },
    { cwd: dir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Seams-first expansion gate|reconfirm/);
});

test("W2bD: Write linked-worktree proposal from main-checkout cwd, names mismatch → Three-Way block", () => {
  const changeName = "aligned-name";
  const mainDir = setupRepo({ branchName: "main" });
  writeFileSync(path.join(mainDir, ".gitignore"), ".worktree/\n");
  spawnSync("git", ["add", ".gitignore"], { cwd: mainDir });
  spawnSync("git", ["commit", "-q", "-m", "ignore worktrees"], { cwd: mainDir });
  const wtPath = path.join(mainDir, ".worktree", changeName);
  spawnSync("git", ["worktree", "add", "-q", "-b", `bugfix/${changeName}`, wtPath, "HEAD"], {
    cwd: mainDir,
  });
  const wrongDir = path.join(wtPath, "openspec", "changes", "wrong-name");
  mkdirSync(wrongDir, { recursive: true });
  writeConfirmedSeamsNotesInto(wrongDir, "grep alignment wrong-name");
  const relativeTarget = `.worktree/${changeName}/openspec/changes/wrong-name/proposal-mini.md`;
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: relativeTarget, content: "x" } },
    { cwd: mainDir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Three-Way Name Alignment.*proposal write/);
  assert.match(r.json.reason, /wrong-name/);
});

test("W2bE: Write linked-worktree proposal from main-checkout cwd, names aligned → no Three-Way block", () => {
  const changeName = "aligned-rel-change";
  const mainDir = setupRepo({ branchName: "main" });
  writeFileSync(path.join(mainDir, ".gitignore"), ".worktree/\n");
  spawnSync("git", ["add", ".gitignore"], { cwd: mainDir });
  spawnSync("git", ["commit", "-q", "-m", "ignore worktrees"], { cwd: mainDir });
  const wtPath = path.join(mainDir, ".worktree", changeName);
  spawnSync("git", ["worktree", "add", "-q", "-b", `bugfix/${changeName}`, wtPath, "HEAD"], {
    cwd: mainDir,
  });
  const wtChangeDir = path.join(wtPath, "openspec", "changes", changeName);
  mkdirSync(wtChangeDir, { recursive: true });
  writeConfirmedSeamsNotesInto(wtChangeDir, `grep alignment ${changeName}`);
  const relativeTarget = `.worktree/${changeName}/openspec/changes/${changeName}/proposal-mini.md`;
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: relativeTarget, content: "x" } },
    { cwd: mainDir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Three-Way Name Alignment/);
  }
});

test("W2bF: Write main-checkout proposal from linked-worktree cwd → Three-Way still uses worktree anchor", () => {
  const changeName = "wt-cwd-anchor";
  const mainDir = setupRepo({ branchName: "main" });
  writeFileSync(path.join(mainDir, ".gitignore"), ".worktree/\n");
  spawnSync("git", ["add", ".gitignore"], { cwd: mainDir });
  spawnSync("git", ["commit", "-q", "-m", "ignore worktrees"], { cwd: mainDir });
  const wtPath = path.join(mainDir, ".worktree", changeName);
  spawnSync("git", ["worktree", "add", "-q", "-b", `bugfix/${changeName}`, wtPath, "HEAD"], {
    cwd: mainDir,
  });
  const mainChangeDir = path.join(mainDir, "openspec", "changes", "other-name");
  mkdirSync(mainChangeDir, { recursive: true });
  writeConfirmedSeamsNotesInto(mainChangeDir, "grep alignment other-name");
  const absoluteTarget = path.join(mainChangeDir, "proposal-mini.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: absoluteTarget, content: "x" } },
    { cwd: wtPath }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Three-Way Name Alignment.*proposal write/);
  assert.match(r.json.reason, /other-name/);
  assert.match(r.json.reason, new RegExp(changeName));
});

test("W2bC: Write openspec/changes/<X>/proposal.md from main worktree → no W2b block (only enforce in sub-worktree)", () => {
  const dir = setupRepo({ branchName: "feature/add-foo" });
  const filePath = path.join(dir, "openspec/changes/foo/proposal-mini.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "x" } },
    { cwd: dir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Three-Way Name Alignment/);
  }
});

// ── Seams-first sibling resolution (fix-flow-gate-gaps R1) ─────────────────
// The seams gate must derive the sibling meeting-notes.md from the *write
// target's own directory* (`path.resolve(cwdAbs, filePath)` → dirname), not by
// rebuilding a path from the change-name match. Live defect: a session rooted
// in the main checkout editing `.worktree/<change>/openspec/changes/<change>/
// proposal.md` (relative) read the MAIN CHECKOUT's sibling → false block.

test("W2bR1: relative proposal path into linked worktree + valid worktree sibling → pass (target-relative resolution)", () => {
  const { mainDir, wtChangeDir, relativeTarget } = setupRelativeSeamsFixture();
  writeConfirmedSeamsNotesInto(wtChangeDir, "grep alignment seams-rel-change");

  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: relativeTarget, content: "x" } },
    { cwd: mainDir }
  );
  // RED before fix: resolved the sibling under the MAIN checkout change folder
  // (`<mainDir>/openspec/changes/...`) and false-blocked with `Seams-first
  // expansion gate`; the worktree sibling was never read.
  assert.equal(
    r.json,
    null,
    `relative path into the linked worktree must not be blocked; got ${JSON.stringify(r.json)}`
  );
});

test("W2bR2: relative proposal path into linked worktree, worktree sibling lacks ## Seams Confirmation → block", () => {
  const { mainDir, wtChangeDir, relativeTarget, worktreeSiblingTail } =
    setupRelativeSeamsFixture();
  writeFileSync(path.join(wtChangeDir, "meeting-notes.md"), "# Meeting notes\n\nno seams section\n");

  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: relativeTarget, content: "x" } },
    { cwd: mainDir }
  );
  assert.equal(r.json?.decision, "block");
  assert.match(r.json.reason, /Seams-first expansion gate/);
  assert.match(r.json.reason, /缺少 ## Seams Confirmation/);
  assert.ok(
    r.json.reason.replaceAll("\\", "/").includes(worktreeSiblingTail),
    `reason must name the worktree sibling (not the main-checkout path); got ${r.json.reason}`
  );
});

test("W2bR3 (counterexample): main-checkout same-name valid sibling + worktree sibling absent → block", () => {
  const { changeName, mainDir, relativeTarget, worktreeSiblingTail } =
    setupRelativeSeamsFixture();
  // Decoy: a VALID meeting-notes for the same change name in the main checkout.
  // The old cwd-rebuilt resolution read THIS file and passed (wrongly); the
  // target-relative resolution must ignore it and block on the missing sibling.
  const mainChangeDir = path.join(mainDir, "openspec", "changes", changeName);
  mkdirSync(mainChangeDir, { recursive: true });
  writeConfirmedSeamsNotesInto(mainChangeDir, "grep alignment decoy");

  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: relativeTarget, content: "x" } },
    { cwd: mainDir }
  );
  assert.equal(
    r.json?.decision,
    "block",
    `main-checkout decoy sibling must not satisfy the gate; got ${JSON.stringify(r.json)}`
  );
  assert.match(r.json.reason, /Seams-first expansion gate/);
  assert.ok(
    r.json.reason.replaceAll("\\", "/").includes(worktreeSiblingTail),
    `reason must name the missing worktree sibling; got ${r.json.reason}`
  );
});

// ── W3 — File tool body carriers must stay out of repo/worktree roots ──
// After refactor-write-destinations-to-notes-tmp:
//   - .pr-body.md is NO LONGER a body carrier; TL body now goes to notes/tmp/
//     in the main checkout (W3C positive case).
//   - .cross-model-sticky-* REMAINS a carrier and must use notes/tmp/.

test("W3A2-pr-body: Write root .pr-body.md in protected main checkout → NOT a body-carrier block (.pr-body.md no longer carrier)", () => {
  // .pr-body.md is no longer a TL body carrier; hook must NOT block on Body Carrier Target.
  // RED until hook removes .pr-body.md from isBodyCarrierPath.
  const mainDir = setupRepo({ branchName: "main" });
  addIgnoredBodyCarriers(mainDir);
  setupActualSubWorktree(mainDir);

  const filePath = path.join(mainDir, ".pr-body.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "body\n" } },
    { cwd: mainDir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(
      r.json.reason,
      /Body Carrier Target/,
      `.pr-body.md is no longer a carrier; Body Carrier Target block must not fire; got: ${JSON.stringify(r.json)}`
    );
  }
});

test("W3A2-sticky: Write root .cross-model-sticky-review.md in protected main checkout → STILL block (reviewer isolation preserved)", () => {
  // .cross-model-sticky-* remains a carrier; this block must still fire.
  const mainDir = setupRepo({ branchName: "main" });
  addIgnoredBodyCarriers(mainDir);
  setupActualSubWorktree(mainDir);

  const filePath = path.join(mainDir, ".cross-model-sticky-review.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "body\n" } },
    { cwd: mainDir }
  );
  assert.equal(r.json?.decision, "block", `expected body-carrier target block for .cross-model-sticky-review.md, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Body Carrier Target/);
});

test("W3B: Write .cross-model-sticky-* inside linked worktree → block body-carrier target gate", () => {
  // .cross-model-sticky-* is still a carrier; linked worktree roots are not an
  // exemption. Reviewer sticky staging must use the reviewer's own current
  // neutral cwd (repo-external), not any worktree-internal path.
  const mainDir = setupRepo({ branchName: "main" });
  addIgnoredBodyCarriers(mainDir);
  const wtDir = setupActualSubWorktree(mainDir);

  const filePath = path.join(wtDir, ".cross-model-sticky-review.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "body\n" } },
    { cwd: mainDir }
  );
  assert.equal(r.json?.decision, "block", `expected body-carrier target block for linked worktree sticky, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /Body Carrier Target/);
  assert.match(r.json.reason, /reviewer 自己 current neutral cwd/);
});

test("W3B2: Write .pr-body inside linked worktree → not a carrier block (removed from carrier set)", () => {
  // After the refactor, .pr-body is no longer a carrier; worktree writes to this
  // path must not produce a Body Carrier Target block (just like before, it
  // passed; now it passes for a different reason: it is not a carrier at all).
  const mainDir = setupRepo({ branchName: "main" });
  addIgnoredBodyCarriers(mainDir);
  const wtDir = setupActualSubWorktree(mainDir);

  const filePath = path.join(wtDir, ".pr-body.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "body\n" } },
    { cwd: mainDir }
  );
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Body Carrier Target/);
    assert.doesNotMatch(r.json.reason, /Protected-branch gate/);
  }
});

test("W3C: Write notes/tmp/sticky.md in protected main checkout → pass (new TL body destination is allowed)", () => {
  // notes/tmp/ is the new destination for TL gh body files (main checkout).
  // It must be allowed by the gate — not a carrier, and gitignored paths in
  // notes/ are permitted per Protected-branch gate exemption.
  const mainDir = setupRepo({ branchName: "main" });
  addIgnoredBodyCarriers(mainDir);
  setupActualSubWorktree(mainDir);
  // Create the notes/tmp directory so Write resolves correctly.
  mkdirSync(path.join(mainDir, "notes", "tmp"), { recursive: true });

  const filePath = path.join(mainDir, "notes", "tmp", "sticky.md");
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: filePath, content: "body\n" } },
    { cwd: mainDir }
  );
  // notes/tmp/ in the main checkout must be allowed OUTRIGHT (no block at all):
  // (a) it is not a body carrier (W3 glob removed .pr-body), and
  // (b) notes/ is gitignored, so the Protected-branch gate exempts it too.
  // This mirrors the real-repo behavior verified by the in-session spike
  // (Write main-checkout notes/tmp → pre-tool-gate exit 0). Asserting the full
  // no-block contract — not merely "not a Body Carrier block" — locks in that a
  // removed worktree never strands a TL body file.
  assert.notEqual(
    r.json?.decision,
    "block",
    `notes/tmp/ in main checkout must not be blocked at all; got: ${JSON.stringify(r.json)}`
  );
});

// ── W1 block reasons name the owning rule section ──────────────────────────
//
// ── W1 escapes found while reviewing PR #3266 ───────────────────────────────
// (1) space-form `switch -C <name>`: the cwd lookup read the verb-level `-C <name>`
//     as git's global `-C <dir>`, got "unresolvable", and W1 skipped.
// (2) a leading `cd <dir> &&`: W1 did not tell the cwd lookup where its git token
//     was, the `&&` was cut in half, and W1 skipped the same way.
// (3) `-` (previous branch) was never evaluated.
// (4) an unprefixed name, or a path, got a `.worktree/` suggestion with an empty path.

function assertW1Block(r, kind, label) {
  assert.equal(r.json?.decision, "block", `${label}: expected block, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, new RegExp(`Worktree Mandatory For Branch ${kind} gate`), label);
}

function assertNoW1Block(r, label) {
  if (r.json?.decision === "block") {
    assert.doesNotMatch(r.json.reason, /Worktree Mandatory/, `${label}: ${r.json.reason}`);
  }
}

for (const [label, command] of [
  ["W1X1: switch -C space form", "git switch -C chore/add-foo"],
  ["W1X2: switch -C behind a global option", "git --no-pager switch -C chore/add-foo"],
  ["W1X3: switch -C after an env prefix", "FOO=1 git switch -C chore/add-foo"],
]) {
  test(`${label} in main worktree → block`, () => {
    const dir = setupRepo({ branchName: "main" });
    const r = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
    assertW1Block(r, "Create", command);
    assert.ok(r.json.reason.includes('.worktree/add-foo" -b chore/add-foo'), r.json.reason);
  });
}

test("W1X4: git -C sub-worktree switch -C from main hook cwd → pass (the global -C still decides the cwd)", () => {
  const mainDir = setupRepo({ branchName: "main" });
  const subWorktreeDir = setupActualSubWorktree(mainDir);
  const r = runHook(
    { tool_name: "Bash", tool_input: { command: `git -C ${subWorktreeDir} switch -C chore/add-foo` } },
    { cwd: mainDir }
  );
  assert.notEqual(r.json?.decision, "block", JSON.stringify(r.json));
});

test("W1X11: a leading cd to the main worktree does not hide the command from W1", () => {
  const mainDir = setupRepo({ branchName: "main" });
  const subWorktreeDir = setupActualSubWorktree(mainDir);
  for (const [kind, tail] of [
    ["Create", "git switch -C chore/add-foo"],
    ["Create", "git switch -c chore/add-foo"],
    ["Create", "git checkout -b chore/add-foo"],
    ["Checkout", "git checkout chore/add-foo"],
    ["Checkout", "git switch bugfix/fix-foo"],
  ]) {
    for (const hookCwd of [mainDir, subWorktreeDir]) {
      const command = `cd ${mainDir} && ${tail}`;
      const r = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: hookCwd });
      assertW1Block(r, kind, `${command} (hook cwd ${hookCwd === mainDir ? "main" : "sub-worktree"})`);
    }
  }
  const chained = `cd ${mainDir} && git status && git checkout -b chore/add-foo`;
  assertW1Block(runHook({ tool_name: "Bash", tool_input: { command: chained } }, { cwd: mainDir }), "Create", chained);
});

test("W1X12: a leading cd to a sub-worktree resolves to it → pass", () => {
  const mainDir = setupRepo({ branchName: "main" });
  const subWorktreeDir = setupActualSubWorktree(mainDir);
  for (const tail of ["git switch -C chore/add-foo", "git checkout chore/add-foo", "git checkout -"]) {
    const command = `cd ${subWorktreeDir} && ${tail}`;
    const r = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: mainDir });
    assert.notEqual(r.json?.decision, "block", `${command}: ${JSON.stringify(r.json)}`);
  }
});

// Main worktree on `main` whose previous checkout was `previous` (so `-` and `@{-1}` name it).
function setupRepoWithPreviousBranch(previous) {
  const dir = setupRepo({ branchName: "main" });
  spawnSync("git", ["branch", previous], { cwd: dir });
  spawnSync("git", ["checkout", "-q", previous], { cwd: dir });
  spawnSync("git", ["checkout", "-q", "main"], { cwd: dir });
  return dir;
}

// The character after `-` is the boundary the matcher has to recognise: end of text, whitespace (including a
// newline and CRLF), and each shell separator.
for (const command of [
  "git checkout -",
  "git switch -",
  "git checkout @{-1}",
  "git checkout -q -",
  "true && git switch - && true",
  "git checkout -\ngit status",
  "git checkout -\r\ngit status",
  "git checkout -; git status",
  "(git checkout -)",
  "git checkout -|cat",
  "git checkout -&& git status",
]) {
  test(`W1X5: ${JSON.stringify(command)} with a work branch as the previous branch → block, naming that branch`, () => {
    const dir = setupRepoWithPreviousBranch("chore/add-prev");
    const r = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
    assertW1Block(r, "Checkout", command);
    assert.match(r.json.reason, /上一個分支/);
    assert.ok(r.json.reason.includes("目前指向 `chore/add-prev`"), r.json.reason);
    assert.ok(r.json.reason.includes('git worktree add "$REPO_ROOT/.worktree/add-prev" chore/add-prev'), r.json.reason);
  });
}

test("W1X6: the previous-branch shorthand passes when it names a protected mainline, or cannot be told", () => {
  const toMainline = setupRepoWithPreviousBranch("production");
  const noHistory = setupRepo({ branchName: "main" });
  const inSubWorktree = setupRepo({ branchName: "main", subWorktree: true });
  for (const command of ["git checkout -", "git switch -", "git checkout @{-1}"]) {
    for (const [label, dir] of [["previous is production", toMainline], ["no previous checkout", noHistory], ["sub-worktree", inSubWorktree]]) {
      const r = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
      assert.notEqual(r.json?.decision, "block", `${command} (${label}): ${JSON.stringify(r.json)}`);
    }
  }
});

test("W1X13: an earlier checkout in the same command moves what the shorthand names → W1 does not block on it", () => {
  // At hook time `-` names chore/add-prev; when it runs it names `main`, the branch left by the first checkout.
  const dir = setupRepoWithPreviousBranch("chore/add-prev");
  const command = "git checkout production && git checkout -";
  assertNoW1Block(runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: dir }), command);
  // The earlier checkout is still evaluated on its own: a work branch there blocks.
  const masked = "git checkout chore/add-prev && git checkout -";
  assertW1Block(runHook({ tool_name: "Bash", tool_input: { command: masked } }, { cwd: dir }), "Checkout", masked);
});

test("W1X7: `--` keeps a checkout a path restore, also after the shorthand → pass", () => {
  // A non-protected branch in the main worktree: on `main` another gate blocks the restore first and the W1
  // assertion could not fail.
  const dir = setupRepoWithPreviousBranch("chore/add-prev");
  spawnSync("git", ["checkout", "-q", "-b", "chore/add-work"], { cwd: dir });
  for (const command of ["git checkout -- x", "git checkout - -- x", "git checkout chore/add-prev -- x"]) {
    const r = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
    assert.notEqual(r.json?.decision, "block", `${command}: ${JSON.stringify(r.json)}`);
  }
});

test("W1X8: unprefixed branch name → block, and the suggested worktree path uses the name", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook({ tool_name: "Bash", tool_input: { command: "git checkout foo" } }, { cwd: dir });
  assertW1Block(r, "Checkout", "git checkout foo");
  assert.ok(r.json.reason.includes('git worktree add "$REPO_ROOT/.worktree/foo" foo'), r.json.reason);
  assert.ok(r.json.reason.includes('cd "$REPO_ROOT/.worktree/foo"'), r.json.reason);
  assert.doesNotMatch(r.json.reason, /還原檔案/, "foo is not a path in the fixture");
});

// The fixture repo has a tracked file named `x`. Without `--` the gate cannot tell a path from a branch, so it
// still blocks — but the reason has to say how to restore, and must not suggest `git restore` (blocked on main).
for (const [label, token, prepare] of [
  ["an existing file", "x", () => {}],
  ["the current directory", ".", () => {}],
  ["a tracked file deleted from the working tree", "x", (dir) => rmSync(path.join(dir, "x"))],
]) {
  test(`W1X9: \`git checkout ${token}\` (${label}) → block with the restore form, no worktree named after the path`, () => {
    const dir = setupRepo({ branchName: "main" });
    prepare(dir);
    const r = runHook({ tool_name: "Bash", tool_input: { command: `git checkout ${token}` } }, { cwd: dir });
    assertW1Block(r, "Checkout", `git checkout ${token}`);
    assert.ok(r.json.reason.includes(`git checkout -- ${token}`), r.json.reason);
    assert.doesNotMatch(r.json.reason, /git restore/);
    assert.doesNotMatch(r.json.reason, /\.worktree\/(?:"|\."|x")/, "no worktree directory built from the path");
  });
}

test("W1X10: prefixed names keep the existing suggestion (segment after the first slash)", () => {
  const dir = setupRepo({ branchName: "main" });
  const r = runHook({ tool_name: "Bash", tool_input: { command: "git checkout chore/add-foo" } }, { cwd: dir });
  assert.ok(r.json.reason.includes('git worktree add "$REPO_ROOT/.worktree/add-foo" chore/add-foo'), r.json.reason);
  assert.doesNotMatch(r.json.reason, /還原檔案/);
});

test("W1X14: a bare `git checkout HEAD` does not change the branch → no W1 block; `HEAD~1` still blocks", () => {
  const dir = setupRepo({ branchName: "main" });
  writeFileSync(path.join(dir, "x"), "x\n");
  // A following command may carry options: each separator ends what is read as this command.
  for (const command of [
    "git checkout HEAD",
    "git checkout HEAD x",
    "git checkout HEAD .",
    "git checkout HEAD 2>&1",
    "git checkout HEAD && git status -s",
    "git checkout HEAD x\ngit status -s",
    "git checkout HEAD x\r\ngit status -s",
    "git checkout HEAD x; git status -s",
    "git checkout HEAD x 2>/dev/null | tail -2",
    "(git checkout HEAD x) && git status -s",
    "git --no-pager checkout HEAD x",
    "git -c core.quotepath=off checkout HEAD",
  ]) {
    const r = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
    assert.notEqual(r.json?.decision, "block", `${command}: ${JSON.stringify(r.json)}`);
  }
  assertW1Block(runHook({ tool_name: "Bash", tool_input: { command: "git checkout HEAD~1" } }, { cwd: dir }), "Checkout", "git checkout HEAD~1");
});

// An option next to `HEAD` can make the command leave the branch (create one, or detach), and `git switch HEAD` is
// not the restore form: none of these get the `HEAD` exemption.
for (const command of [
  "git checkout HEAD -b chore/add-new",
  "git checkout HEAD -B chore/add-new",
  "git checkout HEAD --orphan chore/add-new",
  "git checkout --detach HEAD",
  "git checkout HEAD --detach",
  "git checkout HEAD x -b chore/add-new",
  "git switch HEAD -c chore/add-new",
  "git switch --detach HEAD",
  "git switch -d HEAD",
  "git switch HEAD",
]) {
  test(`W1X15: \`${command}\` in main worktree → block`, () => {
    const dir = setupRepo({ branchName: "main" });
    assertW1Block(runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: dir }), "Checkout", command);
  });
}

// The git token is the one the command-position prefix ends on. A `git`/`gh` word in a bare env value or in the
// executable's path is not it; taking it for the token dropped the real global `-C` or re-read a verb-level `-C`
// as a directory.
test("W1X16: a git/gh word in an env value or in the git path does not hide the command from W1", () => {
  const mainDir = setupRepo({ branchName: "main" });
  const subWorktreeDir = setupActualSubWorktree(mainDir);
  for (const command of [
    "GH_HOST=gh.example.com git switch -C chore/add-foo",
    "GIT_SSH=/usr/bin/git-ssh git switch -C chore/add-foo",
    "/opt/homebrew/opt/git/bin/git switch -C chore/add-foo",
    "/usr/lib/git-core/git switch -C chore/add-foo",
    "X=/opt/git git switch -C chore/add-foo",
  ]) {
    assertW1Block(runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: mainDir }), "Create", command);
  }
  for (const prefix of ["X=/opt/git ", "env X=/opt/git ", "GH_HOST=gh.example.com "]) {
    const toMain = `${prefix}git -C ${mainDir} switch -c chore/add-foo`;
    assertW1Block(runHook({ tool_name: "Bash", tool_input: { command: toMain } }, { cwd: subWorktreeDir }), "Create", toMain);
    const toSub = `${prefix}git -C ${subWorktreeDir} switch -c chore/add-foo`;
    const r = runHook({ tool_name: "Bash", tool_input: { command: toSub } }, { cwd: mainDir });
    assert.notEqual(r.json?.decision, "block", `${toSub}: ${JSON.stringify(r.json)}`);
  }
});

// The spec requires the W1 block reason to point at the rule; the spec-side
// cite form is locked in pre-tool-gates-spec-rule-cites-grep.test.mjs.

test("W1 block reasons name the rule section that owns the worktree mandate", () => {
  const dir = setupRepo({ branchName: "main" });
  for (const command of ["git switch -c chore/add-foo", "git checkout chore/add-foo"]) {
    const r = runHook({ tool_name: "Bash", tool_input: { command } }, { cwd: dir });
    assert.equal(r.json?.decision, "block", `expected block for ${command}`);
    assert.ok(
      r.json.reason.includes("git-branch-naming-and-anchor.md §Worktree 規範"),
      `block reason for \`${command}\` must name the rule section: ${r.json.reason}`
    );
  }
});
