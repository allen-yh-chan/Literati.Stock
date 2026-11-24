/**
 * T5／T6 prove-it (strengthen-admission-binding-portability design D4):
 * the read-only `resolve-admission-binding.mjs` pre-resolution helper and the
 * declared-path `execution_root` contract.
 *
 * Covers the helper contract (realpath／HEAD／branch／expected `execution_root`,
 * closed codes, `--binding-root` mismatch, zero state), the all-role
 * `execution-root-required`／`execution-root-mismatch` gate wiring, the cwd
 * fast path exemption, and the briefing／skill carrier wording. Test titles use
 * the delta scenario titles verbatim where this package owns their assertion
 * coverage (`Declared-Path Dispatch Requires Execution Root For Every Role`,
 * `Declared-Path Dispatch Carries The Execution Root Contract`,
 * `Briefing Template Carries The Declared-Path Admission Fields`,
 * `Session Cwd Alignment Is Not An Admission Gate Condition`).
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { repoPath } from "./lib/repo-root.mjs";
import {
  ADMISSION_ROLES,
  parseAdmissionFields,
} from "../hooks/lib/admission-record.mjs";
import { evaluateAgentDispatch, SPAWN_CONTEXT_PASS_THROUGH } from "../hooks/lib/spawn-context-admission.mjs";

const HELPER_PATH = repoPath(".devpro/scripts/resolve-admission-binding.mjs");
const BRIEFING_PATH = repoPath(".devpro/agent-rules/model-delegation-briefing.md");
const DP_CHANGE_SKILL_PATH = repoPath(".devpro/agent-skills/devpro-workflows/change/SKILL.md");

const CHANGE = "strengthen-execution-root-contract";
const CHANGE_B = "strengthen-execution-root-sibling";
const CHANGE_NOWORKTREE = "strengthen-execution-root-absent";

let shared;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}

function addLinkedWorktree(mainRoot, id) {
  const target = path.join(mainRoot, ".worktree", id);
  mkdirSync(path.dirname(target), { recursive: true });
  git(mainRoot, ["worktree", "add", "-q", "-b", `chore/${id}`, target, "HEAD"]);
  const changeDir = path.join(target, "openspec", "changes", id);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(path.join(changeDir, "tasks.md"), `# ${id}\n`);
  git(target, ["add", "openspec"]);
  git(target, ["commit", "-qm", `${id} change dir`]);
  return { root: realpathSync(target), tip: git(target, ["rev-parse", "HEAD"]) };
}

before(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "execution-root-contract-"));
  const mainRoot = path.join(root, "main");
  mkdirSync(mainRoot, { recursive: true });
  git(mainRoot, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(mainRoot, ".gitignore"), ".worktree/\n");
  writeFileSync(path.join(mainRoot, "seed"), "seed\n");
  git(mainRoot, ["add", ".gitignore", "seed"]);
  git(mainRoot, ["commit", "-qm", "seed"]);
  shared = {
    root,
    mainRoot: realpathSync(mainRoot),
    mainTip: git(mainRoot, ["rev-parse", "HEAD"]),
    linked: {
      [CHANGE]: addLinkedWorktree(mainRoot, CHANGE),
      [CHANGE_B]: addLinkedWorktree(mainRoot, CHANGE_B),
    },
    linkedChangeDir: (id) => path.join(mainRoot, ".worktree", id, "openspec", "changes", id),
  };
});

after(() => {
  if (shared) rmSync(shared.root, { recursive: true, force: true });
});

function promptLines({
  role = "dp-programmer",
  changeId = CHANGE,
  executionRoot = null,
  instanceMode = "fresh",
  parentRecordId = null,
  responsibilityId = "primary-review",
  evidenceScope = "local diff only",
  returnAndStop = "report and stop",
} = {}) {
  const lines = [
    "objective: independent-judgment",
    `responsibility_id: ${responsibilityId}`,
    `instance_mode: ${instanceMode}`,
  ];
  if (parentRecordId) lines.push(`parent_record_id: ${parentRecordId}`);
  lines.push(`evidence_scope: ${evidenceScope}`);
  lines.push(`return_and_stop: ${returnAndStop}`);
  if (changeId) lines.push(`change_id: ${changeId}`);
  if (executionRoot) lines.push(`execution_root: ${executionRoot}`);
  lines.push(`role: ${role}`);
  return lines.join("\n");
}

function recordsIn(changeDir) {
  const dir = path.join(changeDir, "admission-records");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function listTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${path.relative(root, abs)}/`);
        walk(abs);
      } else {
        out.push(path.relative(root, abs));
      }
    }
  };
  walk(root);
  return out.sort();
}

function runHelper(args) {
  return spawnSync(process.execPath, [HELPER_PATH, ...args], { encoding: "utf8" });
}

test("resolve-admission-binding helper outputs the realpath binding, HEAD, branch and expected execution_root with zero state", () => {
  const beforeTreeMain = listTree(shared.mainRoot);
  const beforeTreeLinked = listTree(shared.linked[CHANGE].root);
  const beforeStatus = git(shared.mainRoot, ["status", "--porcelain"]);

  const run = runHelper([CHANGE, "--cwd", shared.mainRoot, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.deepEqual(
    Object.keys(output).sort(),
    ["branch", "changeId", "execution_root", "headSha", "repoRoot"],
    "the helper output is exactly the documented five values",
  );
  assert.equal(output.repoRoot, shared.linked[CHANGE].root, "repoRoot MUST be the exact-one binding worktree realpath");
  assert.equal(output.changeId, CHANGE);
  assert.equal(output.headSha, shared.linked[CHANGE].tip);
  assert.equal(output.branch, `chore/${CHANGE}`);
  assert.equal(output.execution_root, output.repoRoot, "execution_root MUST be the expected absolute binding worktree path");
  assert.notEqual(output.execution_root, shared.mainRoot);

  // Default (non `--json`) mode carries the same five values as key: value lines.
  const plain = runHelper([CHANGE, "--cwd", shared.mainRoot]);
  assert.equal(plain.status, 0, plain.stderr);
  for (const line of [
    `repoRoot: ${output.repoRoot}`,
    `changeId: ${CHANGE}`,
    `headSha: ${output.headSha}`,
    `branch: chore/${CHANGE}`,
    `execution_root: ${output.repoRoot}`,
  ]) {
    assert.ok(plain.stdout.includes(line), `plain output must carry \`${line}\``);
  }

  // Zero state: identical trees, clean status, no record anywhere.
  assert.deepEqual(listTree(shared.mainRoot), beforeTreeMain);
  assert.deepEqual(listTree(shared.linked[CHANGE].root), beforeTreeLinked);
  assert.equal(git(shared.mainRoot, ["status", "--porcelain"]), beforeStatus);
  assert.deepEqual(recordsIn(shared.linkedChangeDir(CHANGE)), []);
});

test("resolve-admission-binding helper fails closed with closed codes and never lets --binding-root override exact-one", () => {
  const mismatch = runHelper([CHANGE, "--cwd", shared.mainRoot, "--binding-root", shared.linked[CHANGE_B].root, "--json"]);
  assert.notEqual(mismatch.status, 0);
  assert.deepEqual(JSON.parse(mismatch.stdout), { ok: false, code: "binding-root-mismatch" });

  const agreeing = runHelper([CHANGE, "--cwd", shared.mainRoot, "--binding-root", shared.linked[CHANGE].root, "--json"]);
  assert.equal(agreeing.status, 0, agreeing.stderr);
  assert.equal(JSON.parse(agreeing.stdout).repoRoot, shared.linked[CHANGE].root);

  const zero = runHelper([CHANGE_NOWORKTREE, "--cwd", shared.mainRoot, "--json"]);
  assert.notEqual(zero.status, 0);
  assert.deepEqual(JSON.parse(zero.stdout), { ok: false, code: "change-worktree-required" });

  const badId = runHelper(["Bad_Shape", "--json"]);
  assert.notEqual(badId.status, 0);
  assert.deepEqual(JSON.parse(badId.stdout), { ok: false, code: "change-id-invalid" });

  const badUsage = runHelper([CHANGE, "--bogus"]);
  assert.notEqual(badUsage.status, 0);
  assert.deepEqual(JSON.parse(badUsage.stdout), { ok: false, code: "usage-invalid" });
});

test("Declared-Path Dispatch Requires Execution Root For Every Role", () => {
  for (const role of ADMISSION_ROLES) {
    const result = evaluateAgentDispatch("Agent", {
      subagent_type: role,
      prompt: promptLines({ role }),
    }, { host: "claude-code", cwd: shared.mainRoot });
    assert.equal(result.block, true, `${role}: a declared dispatch without execution_root MUST fail closed`);
    assert.match(result.reason, /execution-root-required/);
    assert.equal(
      result.reason.includes(shared.linked[CHANGE].root),
      true,
      `${role}: the block MUST name the resolved absolute binding root for the operator`,
    );
  }
  assert.deepEqual(recordsIn(shared.linkedChangeDir(CHANGE)), [], "the all-role matrix mints nothing");

  // Fork carrier (cooperative role) is included.
  const forkPrompt = [
    "objective: independent-judgment",
    "responsibility_id: primary-review",
    "instance_mode: fork",
    "evidence_scope: local diff only",
    "return_and_stop: report and stop",
    "fork_reason: bounded side task",
    `change_id: ${CHANGE}`,
    "role: dp-programmer",
  ].join("\n");
  const fork = evaluateAgentDispatch("Agent", { subagent_type: "fork", prompt: forkPrompt }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(fork.block, true, "a declared fork dispatch without execution_root MUST fail closed");
  assert.match(fork.reason, /execution-root-required/);

  // Continuation carrier is included.
  const continuation = evaluateAgentDispatch("SendMessage", {
    message: promptLines({
      role: "dp-programmer",
      instanceMode: "continue",
      parentRecordId: "586d4b24-0000-4000-8000-000000000000",
    }),
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(continuation.block, true, "a declared continuation without execution_root MUST fail closed");
  assert.match(continuation.reason, /execution-root-required/);
  assert.deepEqual(recordsIn(shared.linkedChangeDir(CHANGE)), [], "fork / continuation faults mint nothing");
});

test("declared-path execution_root mismatches fail closed and the cwd fast path stays exempt", () => {
  // Scenario (verbatim): `Declared-Path Dispatch Requires Execution Root For
  // Every Role` — a value that does not realpath-equal the resolved binding
  // root, "a relative path, a nonexistent path, or another worktree", MUST
  // fail closed with `execution-root-mismatch`.
  const attempts = [
    ["a nonexistent absolute path", path.join(shared.root, "missing-worktree")],
    ["another worktree", shared.linked[CHANGE_B].root],
  ];
  for (const [label, executionRoot] of attempts) {
    const result = evaluateAgentDispatch("Agent", {
      subagent_type: "dp-programmer",
      prompt: promptLines({ executionRoot }),
    }, { host: "claude-code", cwd: shared.mainRoot });
    assert.equal(result.block, true, `${label}: MUST fail closed`);
    assert.match(result.reason, /execution-root-mismatch/, `${label}: MUST keep the mismatch code`);
  }

  // Cross-model CM-1: a relative path MUST fail closed even when it exists and
  // resolves to the binding root from the hook process cwd — `path.resolve`
  // must never anchor the declared value, so `.worktree/<id>` (run from the
  // main checkout) is a mismatch, not a valid declaration.
  const prevCwd = process.cwd();
  try {
    process.chdir(shared.mainRoot);
    const relativeExisting = evaluateAgentDispatch("Agent", {
      subagent_type: "dp-programmer",
      prompt: promptLines({ executionRoot: `.worktree/${CHANGE}` }),
    }, { host: "claude-code", cwd: shared.mainRoot });
    assert.equal(relativeExisting.block, true, "an existing relative path MUST fail closed");
    assert.match(relativeExisting.reason, /execution-root-mismatch/, "a relative path MUST keep the mismatch code");
  } finally {
    process.chdir(prevCwd);
  }
  assert.deepEqual(recordsIn(shared.linkedChangeDir(CHANGE)), [], "mismatch faults mint nothing");

  // The cwd fast path is exempt: a real `.worktree/<id>` session cwd needs no
  // execution_root because the environment itself proves the root.
  const before = recordsIn(shared.linkedChangeDir(CHANGE));
  const fast = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-programmer",
    prompt: promptLines({ changeId: null }),
  }, { host: "claude-code", cwd: shared.linked[CHANGE].root });
  assert.equal(fast.block, undefined, JSON.stringify(fast));
  assert.match(fast.advisory ?? "", /^admission_record: /);
  assert.equal(recordsIn(shared.linkedChangeDir(CHANGE)).length, before.length + 1);
  const record = JSON.parse(readFileSync(path.join(shared.linkedChangeDir(CHANGE), "admission-records", /^admission_record: ([0-9a-f-]{36}) /.exec(fast.advisory)[1] + ".json"), "utf8"));
  assert.equal(record.head_sha, shared.linked[CHANGE].tip);
  assert.equal(Object.hasOwn(record, "execution_root"), false, "execution_root is an input contract, never persisted");
});

test("Declared-Path Dispatch Carries The Execution Root Contract", () => {
  const helperRun = runHelper([CHANGE, "--cwd", shared.mainRoot, "--json"]);
  assert.equal(helperRun.status, 0, helperRun.stderr);
  const resolved = JSON.parse(helperRun.stdout);
  const before = recordsIn(shared.linkedChangeDir(CHANGE));
  // The helper's exact output is the dispatch contract: the field it returns is
  // the one the gate accepts (and the only one it accepts).
  const result = evaluateAgentDispatch("Agent", {
    subagent_type: "dp-programmer",
    prompt: promptLines({ executionRoot: resolved.execution_root }),
  }, { host: "claude-code", cwd: shared.mainRoot });
  assert.equal(result.block, undefined, JSON.stringify(result));
  // The declared-path handoff is still one line and now names the resolved
  // absolute binding root (TL／model-visible); the record itself stays
  // path-free.
  const escapedRoot = shared.linked[CHANGE].root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(
    result.advisory ?? "",
    new RegExp(`^admission_record: [0-9a-f-]{36} sha256=[0-9a-f]{64} \\(resolved binding root: ${escapedRoot}\\)$`, "u"),
  );
  assert.equal(recordsIn(shared.linkedChangeDir(CHANGE)).length, before.length + 1);

  // The carrier contract is documented where the child reads it, and the brief
  // does not make the child depend on an environment ritual to find the root.
  assert.ok(existsSync(BRIEFING_PATH), "model-delegation-briefing.md is the briefing carrier");
});

test("Briefing Template Carries The Declared-Path Admission Fields", () => {
  const briefing = readFileSync(BRIEFING_PATH, "utf8");
  assert.ok(briefing.includes("change_id"), "the briefing MUST document the conditional `change_id` field");
  assert.ok(briefing.includes("execution_root"), "the briefing MUST document the conditional `execution_root` field");
  assert.ok(
    briefing.includes("resolve-admission-binding.mjs"),
    "the briefing MUST point at the read-only binding pre-resolution helper",
  );
  assert.match(briefing, /六欄/, "the six required admission fields stay unchanged and named");
});

test("Session Cwd Alignment Is Not An Admission Gate Condition", () => {
  const briefing = readFileSync(BRIEFING_PATH, "utf8");
  const skill = readFileSync(DP_CHANGE_SKILL_PATH, "utf8");
  assert.match(
    skill,
    /session cwd 對齊不再是 admission gate 條件/u,
    "the skill MUST state the session-cwd alignment is no longer an admission gate condition",
  );
  assert.match(briefing, /不是 admission gate 條件/u, "the briefing MUST state the same");
  assert.match(skill, /resolve-admission-binding\.mjs/u, "the declared-path dispatch MUST go through the pre-resolution helper");
  assert.match(skill, /session_move/u, "the OpenCode session move stays documented as an optional aid");
  // The ritual wording may only survive as optional execution-surface practice:
  // the stale prerequisite phrasing MUST be gone from both carriers.
  for (const [name, text] of [["briefing", briefing], ["devpro:change skill", skill]]) {
    for (const stale of [
      "admission cwd requirement",
      "MUST 把 session 開在",
      "必須把 session 開在",
      "session_move` 是 gate",
    ]) {
      assert.equal(text.includes(stale), false, `${name} MUST NOT keep the stale gate phrasing: ${stale}`);
    }
  }
  assert.match(skill, /execution-root-required/u, "the declared-path fail-closed codes stay named at the dispatch recipe");
});
