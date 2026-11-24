/**
 * Regression matrix for strengthen-cursor-worktree-degraded-path (T1 / T2 /
 * T5), updated to the semantics that supersede it
 * (strengthen-admission-binding-portability design D1／D4):
 *
 * - declaration read order is closed A2 ＞ A1 ＞ A3: A3 (`evidence_scope`／
 *   `return_and_stop` segments) is read only when no A2 `change_id` exists, no
 *   A1 trusted `responsibility_id` prefix derives an id, and the spawn cwd
 *   resolves no fast-path id — then A3 is the sole source, corroborated by the
 *   filesystem exact-one selection;
 * - a declared-path dispatch (cwd not under `.worktree/<id>`) MUST carry
 *   `execution_root` naming the resolved binding worktree: a missing field
 *   fails closed with `execution-root-required` and the cwd (or a tool-input
 *   `working_directory`, which the admission cwd deliberately omits) can never
 *   substitute for it;
 * - primary／main-root cwd + a resolved declaration → exact-one binding
 *   worktree tip; durable admission-records land only under the binding
 *   worktree;
 * - a dispatch that resolves no binding for a non-review role is the
 *   non-silent `binding-unresolved` advisory: no block, no mint.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  resolveExactOneChangeWorktreeBinding,
  writeAdmissionRecord,
  parseAdmissionFields,
} from "../hooks/lib/admission-record.mjs";
import { toolInputBindingCwd, toolInputCwd } from "../hooks/lib/hook-command-context.mjs";
import { evaluateAgentDispatch, SPAWN_CONTEXT_PASS_THROUGH } from "../hooks/lib/spawn-context-admission.mjs";

const CHANGE = "strengthen-cursor-worktree-degraded-path";
const CHANGE_B = "sibling-other-change-slug";

// The canonical position of the two conditional declared-path fields is
// `return_and_stop` → `change_id` → `execution_root` → `role` (design D6).
function withDeclaredFields(promptText, { executionRoot }) {
  const lines = promptText.split("\n");
  const roleIndex = lines.findIndex((line) => line.startsWith("role:"));
  lines.splice(roleIndex, 0, `execution_root: ${executionRoot}`);
  return lines.join("\n");
}

const BASE_PROMPT_LINES = [
  "objective: independent-judgment",
  "responsibility_id: implement-strengthen-cursor-worktree-degraded-path",
  "instance_mode: fresh",
  `evidence_scope: .worktree/${CHANGE}/openspec/changes/${CHANGE}/{tasks,design,proposal}.md`,
  "return_and_stop: implement T1–T12; stop before PR",
  "role: dp-programmer",
];

let shared;
let PROMPT;
let FIELDS;

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

before(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cursor-degraded-binding-"));
  const mainRoot = path.join(root, "main");
  const linkedRoot = path.join(mainRoot, ".worktree", CHANGE);
  const linkedRootB = path.join(mainRoot, ".worktree", CHANGE_B);
  mkdirSync(path.join(mainRoot, "openspec", "changes", CHANGE), { recursive: true });
  mkdirSync(path.join(mainRoot, "openspec", "changes", CHANGE_B), { recursive: true });
  mkdirSync(mainRoot, { recursive: true });
  git(mainRoot, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(mainRoot, ".gitignore"), ".worktree/\n");
  writeFileSync(path.join(mainRoot, "seed"), "seed\n");
  writeFileSync(path.join(mainRoot, "openspec", "changes", CHANGE, "tasks.md"), "# Fixture\n");
  writeFileSync(path.join(mainRoot, "openspec", "changes", CHANGE_B, "tasks.md"), "# Sibling\n");
  git(mainRoot, ["add", ".gitignore", "seed", "openspec/changes/" + CHANGE + "/tasks.md", "openspec/changes/" + CHANGE_B + "/tasks.md"]);
  git(mainRoot, ["commit", "-qm", "seed"]);
  const mainTip = git(mainRoot, ["rev-parse", "HEAD"]);
  mkdirSync(path.dirname(linkedRoot), { recursive: true });
  git(mainRoot, ["worktree", "add", "-q", "-b", `chore/${CHANGE}`, linkedRoot, "HEAD"]);
  writeFileSync(path.join(linkedRoot, "worktree-only"), "wt\n");
  git(linkedRoot, ["add", "worktree-only"]);
  git(linkedRoot, ["commit", "-qm", "worktree tip"]);
  const worktreeTip = git(linkedRoot, ["rev-parse", "HEAD"]);
  assert.notEqual(worktreeTip, mainTip, "fixture must diverge tips");
  git(mainRoot, ["worktree", "add", "-q", "-b", `chore/${CHANGE_B}`, linkedRootB, "HEAD"]);
  mkdirSync(path.join(linkedRootB, "openspec", "changes", CHANGE_B), { recursive: true });
  writeFileSync(path.join(linkedRootB, "sibling-only"), "sib\n");
  git(linkedRootB, ["add", "sibling-only"]);
  git(linkedRootB, ["commit", "-qm", "sibling tip"]);
  const worktreeTipB = git(linkedRootB, ["rev-parse", "HEAD"]);
  shared = {
    root,
    mainRoot: realpathSync(mainRoot),
    linkedRoot: realpathSync(linkedRoot),
    linkedRootB: realpathSync(linkedRootB),
    mainTip,
    worktreeTip,
    worktreeTipB,
    mainChangeDir: path.join(mainRoot, "openspec", "changes", CHANGE),
    linkedChangeDir: path.join(linkedRoot, "openspec", "changes", CHANGE),
    mainChangeDirB: path.join(mainRoot, "openspec", "changes", CHANGE_B),
    linkedChangeDirB: path.join(linkedRootB, "openspec", "changes", CHANGE_B),
  };
  // The declared-path prompts carry the conditional `execution_root` the gate
  // now requires (D4); `FIELDS` mirrors the parsed prompt for the writer-level
  // cases.
  PROMPT = withDeclaredFields(BASE_PROMPT_LINES.join("\n"), { executionRoot: shared.linkedRoot });
  FIELDS = parseAdmissionFields(PROMPT).fields;
});

after(() => {
  if (shared) rmSync(shared.root, { recursive: true, force: true });
});

function recordsIn(changeDir) {
  const dir = path.join(changeDir, "admission-records");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

test("T1 RED→GREEN: primary cwd + verified changeId binds worktree tip and writes only under binding worktree", () => {
  const binding = resolveExactOneChangeWorktreeBinding({
    cwd: shared.mainRoot,
    changeId: CHANGE,
  });
  assert.equal(binding.ok, true, `expected exact-one binding, got ${JSON.stringify(binding)}`);
  assert.equal(binding.changeId, CHANGE);
  assert.equal(binding.repoRoot, shared.linkedRoot);
  assert.equal(binding.headSha, shared.worktreeTip);

  const beforeMain = recordsIn(shared.mainChangeDir);
  const beforeLinked = recordsIn(shared.linkedChangeDir);

  const result = evaluateAgentDispatch(
    "Task",
    { subagent_type: "dp-programmer", prompt: PROMPT },
    { host: "cursor", cwd: shared.mainRoot },
  );
  assert.notEqual(result, SPAWN_CONTEXT_PASS_THROUGH);
  assert.equal(result.block, undefined, `expected admission success, got ${JSON.stringify(result)}`);
  assert.match(result.advisory ?? "", /^admission_record: /);
  assert.doesNotMatch(result.advisory ?? "", /真在 worktree 執行|Task 真在 worktree/);
  // The declared-path success handoff deliberately names the resolved absolute
  // binding root on the TL／model-visible surface (single bounded line); no
  // other absolute path and no raw prompt may leak into the result.
  const serialized = JSON.stringify(result);
  const serializedLinkedRoot = JSON.stringify(shared.linkedRoot).slice(1, -1);
  assert.equal(serialized.includes(serializedLinkedRoot), true, "the declared-path handoff names the resolved binding root");
  assert.doesNotMatch(serialized.replaceAll(serializedLinkedRoot, "<binding-root>"), /(?:\/(?:Users|home|private|tmp)\/|[A-Za-z]:[\\/])/u);
  assert.doesNotMatch(serialized, /implement T1/);

  const match = /^admission_record: ([0-9a-f-]{36}) sha256=([0-9a-f]{64}) \(resolved binding root: ([^\n]+)\)$/.exec(result.advisory);
  assert.ok(match);
  assert.equal(match[3], shared.linkedRoot, "the handoff MUST name the realpath binding root");
  const recordPath = path.join(shared.linkedChangeDir, "admission-records", `${match[1]}.json`);
  assert.equal(existsSync(recordPath), true, "record MUST land under binding worktree change dir");
  const bytes = readFileSync(recordPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), match[2]);
  const record = JSON.parse(bytes.toString("utf8"));
  assert.equal(record.change_id, CHANGE);
  assert.equal(record.head_sha, shared.worktreeTip);
  assert.notEqual(record.head_sha, shared.mainTip);
  assert.equal(record.host, "cursor");

  assert.deepEqual(recordsIn(shared.mainChangeDir), beforeMain, "primary change dir MUST NOT gain the new record");
  assert.equal(recordsIn(shared.linkedChangeDir).length, beforeLinked.length + 1);
});

test("declared A1 with a sibling evidence_scope segment reads A1 only and mints under A (A3 unread)", () => {
  // Superseded semantics: A3 no longer corroborates-or-conflicts with A1; when
  // A1 derives the key, A3 MUST NOT be read at all, so a sibling scope segment
  // neither blocks nor redirects the binding.
  const a1Prompt = withDeclaredFields([
    "objective: independent-judgment",
    `responsibility_id: implement-${CHANGE}`,
    "instance_mode: fresh",
    `evidence_scope: .worktree/${CHANGE_B}/openspec/changes/${CHANGE_B}/tasks.md`,
    "return_and_stop: stop",
    "role: dp-programmer",
  ].join("\n"), { executionRoot: shared.linkedRoot });
  const beforeA = recordsIn(shared.linkedChangeDir);
  const beforeB = recordsIn(shared.linkedChangeDirB);
  const beforeMainA = recordsIn(shared.mainChangeDir);
  const beforeMainB = recordsIn(shared.mainChangeDirB);
  const result = evaluateAgentDispatch(
    "Task",
    { subagent_type: "dp-programmer", prompt: a1Prompt },
    { host: "cursor", cwd: shared.mainRoot },
  );
  assert.equal(result.block, undefined, JSON.stringify(result));
  assert.match(result.advisory ?? "", /^admission_record: /);
  assert.equal(recordsIn(shared.linkedChangeDir).length, beforeA.length + 1, "the A1 key mints under A");
  assert.deepEqual(recordsIn(shared.linkedChangeDirB), beforeB, "A3 MUST NOT be bound");
  assert.deepEqual(recordsIn(shared.mainChangeDir), beforeMainA);
  assert.deepEqual(recordsIn(shared.mainChangeDirB), beforeMainB);
});

test("scope-only is the sole A3 source when the cwd resolves no id and binds the exact-one worktree", () => {
  // Superseded semantics: A3 is a lawful sole source when A2／A1 are absent and
  // the spawn cwd resolves no fast-path id — the filesystem exact-one selection
  // still decides the binding.
  const scopeOnlyPrompt = withDeclaredFields([
    "objective: independent-judgment",
    "responsibility_id: primary-review",
    "instance_mode: fresh",
    `evidence_scope: .worktree/${CHANGE}/openspec/changes/${CHANGE}/tasks.md`,
    "return_and_stop: stop",
    "role: dp-programmer",
  ].join("\n"), { executionRoot: shared.linkedRoot });
  const beforeLinked = recordsIn(shared.linkedChangeDir);
  const beforeMain = recordsIn(shared.mainChangeDir);
  const result = evaluateAgentDispatch(
    "Task",
    { subagent_type: "dp-programmer", prompt: scopeOnlyPrompt },
    { host: "cursor", cwd: shared.mainRoot },
  );
  assert.equal(result.block, undefined, JSON.stringify(result));
  assert.match(result.advisory ?? "", /^admission_record: /);
  assert.equal(recordsIn(shared.linkedChangeDir).length, beforeLinked.length + 1);
  assert.deepEqual(recordsIn(shared.mainChangeDir), beforeMain);
});

test("generic whole-id responsibility (no scope) stays the binding-unresolved advisory with zero mint", () => {
  // Class-one natural FP: bare `primary-review` is not an A1 trusted prefix and
  // carries no A3 segment, so no declaration resolves. A non-review role takes
  // the non-silent advisory — no block, no mint — and the colliding
  // `.worktree/primary-review` directory is never bound (it is not even a
  // linked worktree of this repository).
  const genericId = "primary-review";
  const collideLinkedRaw = path.join(shared.mainRoot, ".worktree", genericId);
  mkdirSync(path.join(collideLinkedRaw, "openspec", "changes", genericId), { recursive: true });
  const collideLinked = realpathSync(collideLinkedRaw);
  git(collideLinked, ["init", "-q"]);
  git(collideLinked, ["commit", "-q", "--allow-empty", "-m", "collide"]);
  const collideChangeDir = path.join(
    collideLinked,
    "openspec",
    "changes",
    genericId,
    "admission-records",
  );
  const genericPrompt = [
    "objective: independent-judgment",
    `responsibility_id: ${genericId}`,
    "instance_mode: fresh",
    "evidence_scope: local design notes only",
    "return_and_stop: stop",
    "role: dp-programmer",
  ].join("\n");
  const beforeCollide = existsSync(collideChangeDir) ? recordsIn(collideChangeDir) : [];
  const beforeLinked = recordsIn(shared.linkedChangeDir);
  const beforeMain = recordsIn(shared.mainChangeDir);
  const result = evaluateAgentDispatch(
    "Task",
    { subagent_type: "dp-programmer", prompt: genericPrompt },
    { host: "cursor", cwd: shared.mainRoot },
  );
  assert.equal(result.block, undefined, JSON.stringify(result));
  assert.match(result.advisory, /binding-unresolved/);
  assert.match(result.advisory, /admission-records-unavailable/);
  assert.equal(/admission_record: /.test(result.advisory), false, "the advisory MUST NOT mint");
  assert.deepEqual(
    existsSync(collideChangeDir) ? recordsIn(collideChangeDir) : [],
    beforeCollide,
    "MUST NOT mint under colliding .worktree/primary-review",
  );
  assert.deepEqual(recordsIn(shared.linkedChangeDir), beforeLinked);
  assert.deepEqual(recordsIn(shared.mainChangeDir), beforeMain);
});

test("T2: responsibility_id-only (zero declared scope ids) still binds trusted changeId", () => {
  const noScopePrompt = withDeclaredFields([
    "objective: independent-judgment",
    "responsibility_id: implement-strengthen-cursor-worktree-degraded-path",
    "instance_mode: fresh",
    "evidence_scope: local design notes only",
    "return_and_stop: stop",
    "role: dp-programmer",
  ].join("\n"), { executionRoot: shared.linkedRoot });
  const beforeLinked = recordsIn(shared.linkedChangeDir);
  const beforeMain = recordsIn(shared.mainChangeDir);
  const result = evaluateAgentDispatch(
    "Task",
    { subagent_type: "dp-programmer", prompt: noScopePrompt },
    { host: "cursor", cwd: shared.mainRoot },
  );
  assert.equal(result.block, undefined, `expected admission success, got ${JSON.stringify(result)}`);
  assert.match(result.advisory ?? "", /^admission_record: /);
  assert.equal(recordsIn(shared.linkedChangeDir).length, beforeLinked.length + 1);
  assert.deepEqual(recordsIn(shared.mainChangeDir), beforeMain);
});

test("T2: zero candidates for changeId fail closed", () => {
  const binding = resolveExactOneChangeWorktreeBinding({
    cwd: shared.mainRoot,
    changeId: "no-such-change-id-zzzz",
  });
  assert.equal(binding.ok, false);
  assert.equal(binding.code, "change-worktree-required");
});

test("T2: ≥2 worktrees for same changeId fail closed", () => {
  const twinRoot = mkdtempSync(path.join(os.tmpdir(), "cursor-degraded-twin-"));
  try {
    const twinLinkedRaw = path.join(twinRoot, ".worktree", CHANGE);
    mkdirSync(path.join(twinLinkedRaw, "openspec", "changes", CHANGE), { recursive: true });
    const twinLinked = realpathSync(twinLinkedRaw);
    git(twinLinked, ["init", "-q"]);
    git(twinLinked, ["commit", "-q", "--allow-empty", "-m", "twin"]);
    const twinHead = git(twinLinked, ["rev-parse", "HEAD"]);
    const mainCommon = realpathSync(path.resolve(shared.mainRoot, git(shared.mainRoot, ["rev-parse", "--git-common-dir"])));

    const hooks = {
      git(cwd, args) {
        const resolvedCwd = (() => {
          try { return realpathSync(cwd); } catch { return cwd; }
        })();
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
          if (
            resolvedCwd === shared.mainRoot
            || resolvedCwd === shared.linkedRoot
            || resolvedCwd === twinLinked
          ) {
            return mainCommon;
          }
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return [
            `worktree ${shared.mainRoot}`,
            `HEAD ${shared.mainTip}`,
            "",
            `worktree ${shared.linkedRoot}`,
            `HEAD ${shared.worktreeTip}`,
            "",
            `worktree ${twinLinked}`,
            `HEAD ${twinHead}`,
            "",
            "",
          ].join("\0");
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout?.trim() ?? null;
        }
        return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout?.trim() ?? null;
      },
    };
    const binding = resolveExactOneChangeWorktreeBinding({
      cwd: shared.mainRoot,
      changeId: CHANGE,
      hooks,
    });
    assert.equal(binding.ok, false);
    assert.equal(binding.code, "change-worktree-ambiguous");
  } finally {
    rmSync(twinRoot, { recursive: true, force: true });
  }
});

test("T2: truncated porcelain -z fails closed without partial exact-one", () => {
  const binding = resolveExactOneChangeWorktreeBinding({
    cwd: shared.mainRoot,
    changeId: CHANGE,
    hooks: {
      git(cwd, args) {
        if (args[0] === "worktree" && args[1] === "list") {
          return `worktree ${shared.linkedRoot}\0HEAD ${shared.worktreeTip}`; // truncated: no record terminator
        }
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
          return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout?.trim() ?? null;
        }
        return null;
      },
    },
  });
  assert.equal(binding.ok, false);
  assert.equal(binding.code, "intent-scan-failed");
});

test("T2: foreign common-dir fails closed", () => {
  const foreign = mkdtempSync(path.join(os.tmpdir(), "cursor-degraded-foreign-"));
  try {
    const foreignMain = path.join(foreign, "main");
    mkdirSync(foreignMain, { recursive: true });
    git(foreignMain, ["init", "-q", "-b", "main"]);
    writeFileSync(path.join(foreignMain, "seed"), "f\n");
    git(foreignMain, ["add", "seed"]);
    git(foreignMain, ["commit", "-qm", "foreign"]);
    const foreignLinked = path.join(foreignMain, ".worktree", CHANGE);
    mkdirSync(path.dirname(foreignLinked), { recursive: true });
    git(foreignMain, ["worktree", "add", "-q", "-b", "foreign-branch", foreignLinked, "HEAD"]);
    mkdirSync(path.join(foreignLinked, "openspec", "changes", CHANGE), { recursive: true });
    const foreignLinkedReal = realpathSync(foreignLinked);

    const binding = resolveExactOneChangeWorktreeBinding({
      cwd: shared.mainRoot,
      changeId: CHANGE,
      hooks: {
        git(cwd, args) {
          if (args[0] === "worktree" && args[1] === "list") {
            return [
              `worktree ${shared.mainRoot}`,
              `HEAD ${shared.mainTip}`,
              "",
              `worktree ${foreignLinkedReal}`,
              `HEAD ${git(foreignLinkedReal, ["rev-parse", "HEAD"])}`,
              "",
              "",
            ].join("\0");
          }
          return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout?.trim() ?? null;
        },
      },
    });
    assert.equal(binding.ok, false);
    assert.equal(binding.code, "intent-scan-failed");
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("T2: env / hand-written path MUST NOT override binding", () => {
  const prev = process.env.DEVPRO_CHANGE_WORKTREE;
  process.env.DEVPRO_CHANGE_WORKTREE = shared.mainRoot;
  try {
    const binding = resolveExactOneChangeWorktreeBinding({
      cwd: shared.mainRoot,
      changeId: CHANGE,
    });
    assert.equal(binding.ok, true);
    assert.equal(binding.repoRoot, shared.linkedRoot);
    assert.notEqual(binding.repoRoot, shared.mainRoot);
  } finally {
    if (prev === undefined) delete process.env.DEVPRO_CHANGE_WORKTREE;
    else process.env.DEVPRO_CHANGE_WORKTREE = prev;
  }
});

test("T2: helper declared-path write without execution_root fails closed; with it the record lands only under the binding worktree", () => {
  // T6 (design D4): the writer is the single mint choke point and enforces the
  // declared-path execution_root contract — a missing field is neither a
  // degraded success nor a primary-root write.
  const missing = writeAdmissionRecord({
    cwd: shared.mainRoot,
    host: "cursor",
    prompt: PROMPT,
    fields: { ...FIELDS, execution_root: undefined },
    roleBinding: "host-verified",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "execution-root-required");

  const beforeLinked = recordsIn(shared.linkedChangeDir);
  const beforeMain = recordsIn(shared.mainChangeDir);
  const written = writeAdmissionRecord({
    cwd: shared.mainRoot,
    host: "cursor",
    prompt: PROMPT,
    fields: FIELDS,
    roleBinding: "host-verified",
  });
  assert.equal(written.ok, true, written.code);
  const recordPath = path.join(shared.linkedChangeDir, "admission-records", `${written.record_id}.json`);
  assert.equal(existsSync(recordPath), true, "the record MUST land under the binding worktree, never primary");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(record.head_sha, shared.worktreeTip);
  assert.equal(Object.hasOwn(record, "execution_root"), false, "execution_root is an input contract, never persisted");
  assert.equal(recordsIn(shared.linkedChangeDir).length, beforeLinked.length + 1);
  assert.deepEqual(recordsIn(shared.mainChangeDir), beforeMain);
});

test("T3b: working_directory alone is not binding authority — the declared path still needs execution_root", () => {
  const scopeOnlyPrompt = [
    "objective: independent-judgment",
    "responsibility_id: primary-review",
    "instance_mode: fresh",
    `evidence_scope: .worktree/${CHANGE}/openspec/changes/${CHANGE}/tasks.md`,
    "return_and_stop: stop",
    "role: dp-programmer",
  ].join("\n");
  const beforeLinked = recordsIn(shared.linkedChangeDir);
  const result = evaluateAgentDispatch(
    "Task",
    {
      subagent_type: "dp-programmer",
      prompt: scopeOnlyPrompt,
      working_directory: shared.linkedRoot,
    },
    { host: "cursor", cwd: shared.mainRoot },
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /execution-root-required/);
  assert.deepEqual(recordsIn(shared.linkedChangeDir), beforeLinked);
});

test("F-scwtdp-r1-01: toolInputCwd reads working_directory; toolInputBindingCwd omits it", () => {
  const prevPwd = process.env.PWD;
  const prevCwd = process.cwd();
  try {
    process.chdir(shared.mainRoot);
    process.env.PWD = shared.mainRoot;
    assert.equal(toolInputCwd({ working_directory: shared.linkedRoot }, {}), shared.linkedRoot);
    assert.equal(toolInputCwd({ workingDirectory: shared.linkedRoot }, {}), shared.linkedRoot);
    const bindingCwd = toolInputBindingCwd({ working_directory: shared.linkedRoot }, {});
    assert.notEqual(bindingCwd, shared.linkedRoot);
    assert.equal(bindingCwd, shared.mainRoot);
  } finally {
    process.chdir(prevCwd);
    if (prevPwd === undefined) delete process.env.PWD;
    else process.env.PWD = prevPwd;
  }
});

test("F-scwtdp-r1-01 live-wiring: admission cwd omits working_directory — the declaration and execution_root carry the binding", () => {
  const scopeOnlyLines = [
    "objective: independent-judgment",
    "responsibility_id: primary-review",
    "instance_mode: fresh",
    `evidence_scope: .worktree/${CHANGE}/openspec/changes/${CHANGE}/tasks.md`,
    "return_and_stop: stop",
    "role: dp-programmer",
  ].join("\n");
  const toolInput = {
    subagent_type: "dp-programmer",
    prompt: scopeOnlyLines,
    working_directory: shared.linkedRoot,
  };
  const prevPwd = process.env.PWD;
  const prevCwd = process.cwd();
  const beforeLinked = recordsIn(shared.linkedChangeDir);
  const beforeMain = recordsIn(shared.mainChangeDir);
  try {
    process.chdir(shared.mainRoot);
    process.env.PWD = shared.mainRoot;
    // Simulate pre-tool-gate: execution cwd may see working_directory; admission must not.
    assert.equal(toolInputCwd(toolInput, {}), shared.linkedRoot);
    const admissionCwd = toolInputBindingCwd(toolInput, {});
    assert.equal(admissionCwd, shared.mainRoot);
    // Without execution_root the declared path fails closed — working_directory
    // can never substitute for it.
    const refused = evaluateAgentDispatch("Task", toolInput, {
      host: "cursor",
      cwd: admissionCwd,
    });
    assert.equal(refused.block, true);
    assert.match(refused.reason, /execution-root-required/);
    assert.deepEqual(recordsIn(shared.linkedChangeDir), beforeLinked);

    // With the declared execution_root the same admission cwd mints under the
    // binding worktree: the binding no longer depends on the session or tool cwd.
    const declared = {
      ...toolInput,
      prompt: withDeclaredFields(scopeOnlyLines, { executionRoot: shared.linkedRoot }),
    };
    const result = evaluateAgentDispatch("Task", declared, {
      host: "cursor",
      cwd: admissionCwd,
    });
    assert.equal(result.block, undefined, JSON.stringify(result));
    assert.match(result.advisory ?? "", /^admission_record: /);
    assert.equal(recordsIn(shared.linkedChangeDir).length, beforeLinked.length + 1);
    assert.deepEqual(recordsIn(shared.mainChangeDir), beforeMain);
  } finally {
    process.chdir(prevCwd);
    if (prevPwd === undefined) delete process.env.PWD;
    else process.env.PWD = prevPwd;
  }
});

test("F-scwtdp-r1-01 positive: changeId binding + working_directory still exact-one succeeds", () => {
  const toolInput = {
    subagent_type: "dp-programmer",
    prompt: PROMPT,
    working_directory: shared.linkedRoot,
  };
  const prevPwd = process.env.PWD;
  const prevCwd = process.cwd();
  const beforeLinked = recordsIn(shared.linkedChangeDir);
  const beforeMain = recordsIn(shared.mainChangeDir);
  try {
    process.chdir(shared.mainRoot);
    process.env.PWD = shared.mainRoot;
    const admissionCwd = toolInputBindingCwd(toolInput, {});
    assert.equal(admissionCwd, shared.mainRoot);
    const result = evaluateAgentDispatch("Task", toolInput, {
      host: "cursor",
      cwd: admissionCwd,
    });
    assert.notEqual(result, SPAWN_CONTEXT_PASS_THROUGH);
    assert.equal(result.block, undefined, `expected admission success, got ${JSON.stringify(result)}`);
    assert.match(result.advisory ?? "", /^admission_record: /);
    assert.equal(recordsIn(shared.linkedChangeDir).length, beforeLinked.length + 1);
    assert.deepEqual(recordsIn(shared.mainChangeDir), beforeMain);
  } finally {
    process.chdir(prevCwd);
    if (prevPwd === undefined) delete process.env.PWD;
    else process.env.PWD = prevPwd;
  }
});

test("cwd already under worktree happy path still writes locally (no regression)", () => {
  const beforeLinkedHappy = recordsIn(shared.linkedChangeDir);
  const result = evaluateAgentDispatch(
    "Task",
    { subagent_type: "dp-programmer", prompt: PROMPT },
    { host: "cursor", cwd: shared.linkedRoot },
  );
  assert.match(result.advisory ?? "", /^admission_record: /);
  assert.equal(recordsIn(shared.linkedChangeDir).length, beforeLinkedHappy.length + 1);
  const match = /^admission_record: ([0-9a-f-]{36}) /.exec(result.advisory);
  const record = JSON.parse(readFileSync(path.join(shared.linkedChangeDir, "admission-records", `${match[1]}.json`), "utf8"));
  assert.equal(record.head_sha, shared.worktreeTip);
});
