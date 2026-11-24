import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import childProcess, { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluatePreToolUsePayload, PASS_THROUGH } from "../hooks/pre-tool-gate.mjs";
import { spawnContextBlock } from "../hooks/lib/spawn-context-admission.mjs";
import { issueSpawnContextOverride } from "../hooks/lib/spawn-context-override.mjs";
import { ADMISSION_ROLES, CODEX_REVIEWER_REQUEST_SCHEMA, issueCodexReviewerAdmission } from "../hooks/lib/admission-record.mjs";
import { durableWrite, fsyncDirectory } from "../lib/durable-fs.mjs";
import { expectedNodeModeBits } from "./lib/expected-node-mode-bits.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const FIXTURES = path.join(HERE, "fixtures", "spawn-context-payloads");

function stateFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawn-gate-"));
  const cwd = path.join(root, "worktree");
  const stateDir = path.join(root, "state");
  mkdirSync(cwd);
  return { cwd, stateDir };
}

function evaluate(payload, { host = "codex", cwd, stateDir, nowMs = 1000 } = {}) {
  const local = cwd ? { cwd, stateDir } : stateFixture();
  return evaluatePreToolUsePayload({ ...payload, cwd: local.cwd }, { host, spawnContextStateDir: local.stateDir, nowMs });
}

function isAllowed(result) { return result === null || result === PASS_THROUGH; }

test("Scenario: New Win32 Durable Record Completes File And Parent Sync", () => {
  const { cwd } = stateFixture();
  const root = path.dirname(cwd);
  const file = path.join(root, "record.json");
  const body = '{"record":"original"}\n';
  try {
    durableWrite(file, body);
    fsyncDirectory(root);
    assert.equal(readFileSync(file, "utf8"), body);
    assert.throws(() => durableWrite(file, '{"record":"replacement"}\n'), { code: "EEXIST" });
    assert.equal(readFileSync(file, "utf8"), body, "exclusive create must preserve original bytes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Scenario: Durable Sync Failure Remains Fail-Closed", () => {
  const { cwd } = stateFixture();
  const root = path.dirname(cwd);
  const file = path.join(root, "record.json");
  const body = '{"record":"unsynced"}\n';
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    const error = new Error("injected fsync failure");
    error.code = "EIO";
    throw error;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => durableWrite(file, body), { code: "EIO" });
    assert.equal(readFileSync(file, "utf8"), body, "a failed sync must not trigger overwrite");
    assert.throws(() => durableWrite(file, "replacement"), { code: "EEXIST" });
    assert.equal(readFileSync(file, "utf8"), body);
  } finally {
    fs.fsyncSync = originalFsync;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reviewer worktree mismatch projects one fixed actionable and redacted Codex reason", () => {
  const local = stateFixture();
  const expected = "Spawn Context Admission Gate: reviewer-change-worktree-required: ensure this session shares the Git common-dir with the prepared `.worktree/<change_id>` (or start a fresh Codex session rooted there), then reissue the reviewer intent";
  const promptCanary = "T14_SECRET_PROMPT_CANARY";
  const taskCanary = "t14_unverified_task_canary";
  const payloadCanary = "gAAAAAT14_UNVERIFIED_PAYLOAD_CANARY";
  const projected = evaluate({
    tool_name: "collaborationspawn_agent",
    tool_input: {
      agent_type: "dp-reviewer",
      fork_turns: "none",
      message: promptCanary,
      task_name: taskCanary,
      unverified_payload: payloadCanary,
    },
  }, { host: "codex", cwd: local.cwd, stateDir: local.stateDir });
  assert.deepEqual({
    projected,
    containsFixtureAbsolutePath: projected.reason.includes(local.cwd),
    containsAbsolutePathShape: /(?:\/(?:Users|home|private|tmp)\/|[A-Za-z]:[\\/])/u.test(projected.reason),
    containsPrompt: projected.reason.includes(promptCanary),
    containsTask: projected.reason.includes(taskCanary),
    containsUnverifiedPayload: projected.reason.includes(payloadCanary),
  }, {
    projected: { block: true, reason: expected },
    containsFixtureAbsolutePath: false,
    containsAbsolutePathShape: false,
    containsPrompt: false,
    containsTask: false,
    containsUnverifiedPayload: false,
  });
});

test("Codex v2 uses a closed none/1..6 matrix and omit/all needs one-shot authority", () => {
  for (const fork_turns of ["none", "1", "6"]) assert.equal(isAllowed(evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns } })), true);
  for (const fork_turns of ["0", "7", 2, "2.5", "fresh"]) {
    assert.equal(evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns } }).block, true);
  }
  const observed = JSON.parse(readFileSync(path.join(FIXTURES, "codex-v2-omit.json"), "utf8"));
  assert.equal(evaluate(observed.payload).block, true);
  assert.equal(evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns: "all" } }).block, true);

  const { cwd, stateDir } = stateFixture();
  assert.equal(issueSpawnContextOverride({ cwd, stateDir, reason: "full history is required for this bounded comparison", nowMs: 1000 }).ok, true);
  assert.equal(isAllowed(evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns: "all" } }, { cwd, stateDir })), true);
  assert.equal(evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns: "all" } }, { cwd, stateDir }).block, true);
});

test("Codex v1 fresh modes allow, full/ambiguous modes block", () => {
  for (const tool_name of ["spawn_agent", "Agent"]) {
    assert.equal(isAllowed(evaluate({ tool_name, tool_input: {} })), true);
    assert.equal(isAllowed(evaluate({ tool_name, tool_input: { fork_context: false } })), true);
    assert.equal(evaluate({ tool_name, tool_input: { fork_context: true } }).block, true);
  }
  assert.equal(evaluate({ tool_name: "Agent", tool_input: { fork_context: false, fork_turns: "none" } }).block, true);
});

test("registered agent tokens fail closed without authoritative host and payload cannot spoof it", () => {
  const payload = { tool_name: "collaborationspawn_agent", tool_input: {}, host: "claude-code" };
  assert.equal(evaluate(payload, { host: "" }).block, true);
  assert.equal(evaluate(payload, { host: "codex" }).block, true);
});

test("registered agent payloads reject missing, non-object, and coerced mode shapes", () => {
  for (const tool_input of [undefined, null, "not-an-object", []]) {
    const payload = { tool_name: "spawn_agent" };
    if (tool_input !== undefined) payload.tool_input = tool_input;
    assert.equal(evaluate(payload).block, true, JSON.stringify(tool_input));
  }
  assert.equal(evaluate({
    tool_name: "spawn_agent",
    tool_input: { fork_context: false },
    toolInput: { fork_context: false },
  }).block, true);
  // T16 / D2: `resume` is no longer a spawn mode the hook branches on
  // (continuation is SendMessage on the existing thread), so a coerced
  // `resume` value on a built-in type is not a block any more.
  assert.equal(isAllowed(evaluate({
    tool_name: "Agent",
    tool_input: { subagent_type: "Explore", resume: "", prompt: "fresh" },
  }, { host: "claude-code" })), true);
  assert.equal(isAllowed(evaluate({
    tool_name: "Agent",
    tool_input: { subagent_type: "Explore", resume: 42, prompt: "fresh" },
  }, { host: "claude-code" })), true);
});

// ── T16 (strengthen-subagent-delegation-strategy, design D2 / D6 2.1–2.2) ──
// Claude branch: `subagent_type: "fork"` is the fork carrier (needs
// `fork_reason:` + six admission fields with instance_mode fork); named dp-*
// projections need the six fields with role === subagent_type; built-in
// types (Explore, general-purpose, …) pass without a record; `resume` and
// CLAUDE_CODE_FORK_SUBAGENT no longer branch. On pass a durable admission
// record is written and handed back as `admission_record: <id> sha256=<d>`.

const SIX_FIELDS = [
  "objective: independent-judgment",
  "responsibility_id: cp0-task-outline-consistency",
  "instance_mode: fresh",
  "evidence_scope: tasks.md; design.md §Task Outline",
  "return_and_stop: mode update JSON ≤500 tokens; stop after reporting",
  "role: dp-architect",
];

function changeWorktreeFixture(changeName = "strengthen-subagent-delegation-strategy") {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawn-gate-change-"));
  const cwd = path.join(root, ".worktree", changeName);
  const stateDir = path.join(root, "state");
  mkdirSync(path.join(cwd, "openspec", "changes", changeName), { recursive: true });
  const git = (args) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  git(["init", "-q"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  const headSha = git(["rev-parse", "HEAD"]).stdout.trim();
  return { root, cwd, stateDir, headSha, changeName };
}

function admissionRecordsDir(fixture) {
  return path.join(fixture.cwd, "openspec", "changes", fixture.changeName, "admission-records");
}

// A real main checkout plus one linked worktree for the same change id: the
// D1.6 containment fixture (the fake `.worktree/<id>` directory case needs the
// selected candidate to live outside the spawn cwd's own toplevel).
function mainLinkedFixture(changeName = "strengthen-subagent-delegation-strategy") {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawn-gate-linked-"));
  const mainRoot = path.join(root, "main");
  const linkedRoot = path.join(mainRoot, ".worktree", changeName);
  mkdirSync(path.join(mainRoot, "openspec", "changes", changeName), { recursive: true });
  const git = (args, cwd = mainRoot) => spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(mainRoot, ".gitignore"), ".worktree/\n");
  writeFileSync(path.join(mainRoot, "seed"), "seed\n");
  writeFileSync(path.join(mainRoot, "openspec", "changes", changeName, "tasks.md"), "# Fixture\n");
  git(["add", ".gitignore", "seed", `openspec/changes/${changeName}/tasks.md`]);
  git(["commit", "-qm", "seed"]);
  mkdirSync(path.dirname(linkedRoot), { recursive: true });
  git(["worktree", "add", "-q", "-b", `chore/${changeName}`, linkedRoot, "HEAD"]);
  return {
    root,
    mainRoot: realpathSync(mainRoot),
    linkedRoot: realpathSync(linkedRoot),
    changeName,
    mainChangeDir: path.join(mainRoot, "openspec", "changes", changeName),
    linkedChangeDir: path.join(linkedRoot, "openspec", "changes", changeName),
  };
}

function recordsUnder(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
}

function parseHandoff(result) {
  const match = /^admission_record: ([0-9a-f-]{36}) sha256=([0-9a-f]{64})$/.exec(result?.advisory ?? "");
  assert.ok(match, `expected admission handoff, got ${JSON.stringify(result)}`);
  return { recordId: match[1], digest: match[2] };
}

function assertAdmissionRecordAccess(file) {
  assert.equal((fs.statSync(file).mode & 0o777), expectedNodeModeBits(0o600));
}

test("Claude named dp-* spawn writes a durable admission record and hands back its id + digest", () => {
  const fixture = changeWorktreeFixture();
  const payload = JSON.parse(readFileSync(path.join(FIXTURES, "claude-named-dp-fresh.json"), "utf8")).payload;
  const result = evaluate(payload, { host: "claude-code", cwd: fixture.cwd, stateDir: fixture.stateDir });
  const { recordId, digest } = parseHandoff(result);
  const file = path.join(admissionRecordsDir(fixture), `${recordId}.json`);
  const bytes = readFileSync(file);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  const record = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(record).sort(), [
    "admitted_at", "change_id", "evidence_scope", "head_sha", "host", "instance_mode", "objective",
    "prompt_sha256", "record_id", "responsibility_id", "return_and_stop", "role", "role_binding", "schema",
  ]);
  assert.equal(record.schema, "devpro.spawn-admission-record/v1");
  assert.equal(record.record_id, recordId);
  assert.equal(record.change_id, fixture.changeName);
  assert.equal(record.host, "claude-code");
  assert.equal(record.role, "dp-architect");
  assert.equal(record.role_binding, "host-verified");
  assert.equal(record.instance_mode, "fresh");
  assert.equal(record.head_sha, fixture.headSha);
  assert.equal(record.prompt_sha256, createHash("sha256").update(payload.tool_input.prompt).digest("hex"));
  assert.match(record.admitted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  assert.equal(bytes.toString("utf8").includes("change_path"), false, "prompt text must not be stored");
  assertAdmissionRecordAccess(file);
});

test("Claude named dp-* spawn fails closed on role mismatch, missing fields, invalid closed-set values, or no change worktree", () => {
  const fixture = changeWorktreeFixture();
  const opts = { host: "claude-code", cwd: fixture.cwd, stateDir: fixture.stateDir };
  const mismatch = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-reviewer", prompt: SIX_FIELDS.join("\n") } }, opts);
  assert.match(mismatch.reason, /role/);
  const missing = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-architect", prompt: SIX_FIELDS.slice(0, 4).join("\n") } }, opts);
  assert.match(missing.reason, /return_and_stop/);
  assert.match(missing.reason, /role/);
  assert.equal(missing.reason.includes("cp0-task-outline-consistency"), false, "block reason must not echo prompt content");
  const badObjective = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-architect", prompt: SIX_FIELDS.map((line) => line.replace("independent-judgment", "save-tokens")).join("\n") } }, opts);
  assert.match(badObjective.reason, /objective/);
  const badMode = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-architect", prompt: SIX_FIELDS.map((line) => line.replace("instance_mode: fresh", "instance_mode: fork")).join("\n") } }, opts);
  assert.match(badMode.reason, /instance_mode/);
  // D5 role classification: a review role with no binding and no declaration
  // still fails closed, while every other registered role takes the non-silent
  // `binding-unresolved` advisory instead of a block.
  const reviewPrompt = SIX_FIELDS.map((line) => line.replace("role: dp-architect", "role: dp-reviewer")).join("\n");
  const noWorktree = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-reviewer", prompt: reviewPrompt } }, { host: "claude-code" });
  assert.equal(noWorktree.block, true);
  assert.match(noWorktree.reason, /change worktree/);
  assert.match(noWorktree.reason, /change_id/, "the review block must name the declare-change_id remedy");
  assert.equal(/\/(?:Users|home|tmp|private)\//.test(noWorktree.reason), false, "block reason must not carry raw paths");
  const advisory = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-architect", prompt: SIX_FIELDS.join("\n") } }, { host: "claude-code" });
  assert.equal(advisory.block, undefined, "a non-review role without a binding must not block");
  assert.match(advisory.advisory, /binding-unresolved/);
  assert.match(advisory.advisory, /admission-records-unavailable/);
  assert.equal(/admission_record: /.test(advisory.advisory), false, "the advisory must not hand back a record");
  assert.equal(fs.existsSync(admissionRecordsDir(fixture)) ? fs.readdirSync(admissionRecordsDir(fixture)).length : 0, 0, "no record on any block");
  // D15 parent validation: the change directory is never created by the hook and must not be a symlink.
  // D51 splits the two: absent everywhere passes without a record (see the chore-A
  // test below), while an entry that exists but is not a plain directory still blocks.
  const linkedChangeDir = changeWorktreeFixture();
  const elsewhere = path.join(linkedChangeDir.root, "elsewhere");
  mkdirSync(elsewhere);
  fs.rmSync(path.join(linkedChangeDir.cwd, "openspec", "changes", linkedChangeDir.changeName), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(linkedChangeDir.cwd, "openspec", "changes", linkedChangeDir.changeName), "dir");
  const symlinked = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-architect", prompt: SIX_FIELDS.join("\n") } }, { host: "claude-code", cwd: linkedChangeDir.cwd });
  assert.match(symlinked.reason, /admission-records-dir-invalid/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("Claude named dp-* spawn after openspec archive writes into the archived change directory (writer/reader alignment)", () => {
  // Step 5.5 cross-review dispatches dp-second-reviewer from the same worktree
  // after `openspec archive` has moved the change folder. The reader already
  // resolves active-or-archived (design D18); the writer MUST agree, or the
  // gate blocks the very dispatch the archive step hands off to.
  const fixture = changeWorktreeFixture();
  const changesDir = path.join(fixture.cwd, "openspec", "changes");
  const archived = path.join(changesDir, "archive", `2026-09-04-${fixture.changeName}`);
  mkdirSync(path.join(changesDir, "archive"));
  fs.renameSync(path.join(changesDir, fixture.changeName), archived);
  assert.equal(fs.existsSync(path.join(changesDir, fixture.changeName)), false, "active folder is gone after archive");
  const result = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-second-reviewer", prompt: SIX_FIELDS.map((line) => line.replace("role: dp-architect", "role: dp-second-reviewer")).join("\n") } }, { host: "claude-code", cwd: fixture.cwd, stateDir: fixture.stateDir });
  const { recordId, digest } = parseHandoff(result);
  const file = path.join(archived, "admission-records", `${recordId}.json`);
  const bytes = readFileSync(file);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  const record = JSON.parse(bytes.toString("utf8"));
  assert.equal(record.change_id, fixture.changeName);
  assert.equal(record.role, "dp-second-reviewer");
  assert.equal(record.role_binding, "host-verified");
  assertAdmissionRecordAccess(file);
  assert.equal(fs.existsSync(path.join(changesDir, fixture.changeName)), false, "the hook must not recreate the active folder");
});

// T3 acceptance (design D1.6 containment): a linked-worktree subdirectory cwd
// keeps the admitted fast path, while a `.worktree/<id>` directory name that is
// not a live linked worktree fails closed instead of writing the record into
// the main checkout.
test("D1.6 containment: linked-worktree subdirectory cwd passes and a fake `.worktree/<id>` directory fails closed", () => {
  const fixture = changeWorktreeFixture();
  const payload = JSON.parse(readFileSync(path.join(FIXTURES, "claude-named-dp-fresh.json"), "utf8")).payload;
  const subdir = evaluate(payload, { host: "claude-code", cwd: path.join(fixture.cwd, "openspec", "changes"), stateDir: fixture.stateDir });
  const { recordId } = parseHandoff(subdir);
  assert.equal(fs.existsSync(path.join(admissionRecordsDir(fixture), `${recordId}.json`)), true, "a worktree subdirectory cwd must not fail closed");

  const linked = mainLinkedFixture(fixture.changeName);
  const fakeCwd = path.join(linked.mainRoot, "local", ".worktree", linked.changeName);
  mkdirSync(fakeCwd, { recursive: true });
  const blocked = evaluate(payload, { host: "claude-code", cwd: fakeCwd, stateDir: fixture.stateDir });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /change-worktree-required/);
  assert.equal(blocked.reason.includes(linked.linkedRoot), true, "the resolved candidate root stays operator-visible in the block");
  assert.deepEqual(recordsUnder(path.join(linked.linkedChangeDir, "admission-records")), [], "the fake directory must not mint into the binding worktree");
  assert.deepEqual(recordsUnder(path.join(linked.mainChangeDir, "admission-records")), [], "the fake directory must not mint into the main checkout");
});

test("chore-A worktree with no openspec change folder admits the dispatch without a record (D51)", () => {
  // chore-A entry (a) creates `.worktree/<scope>` straight from an anchor SHA and
  // never invokes `/devpro:change`, so `openspec/changes/<change_id>/` never exists —
  // yet its 共同不變式 still makes the dp-assistant dispatch mandatory. Blocking
  // here would make that entry unexecutable; the record's absence is instead
  // surfaced by lineage telemetry as `admission-records-unavailable`.
  const fixture = changeWorktreeFixture();
  fs.rmSync(path.join(fixture.cwd, "openspec"), { recursive: true });
  const opts = { host: "claude-code", cwd: fixture.cwd, stateDir: fixture.stateDir };
  const prompt = SIX_FIELDS.map((line) => line.replace("role: dp-architect", "role: dp-assistant")).join("\n");
  const result = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-assistant", prompt } }, opts);
  assert.equal(result.block, undefined, "an absent change folder must not block the dispatch");
  assert.match(result.advisory, /admission-records-dir-missing/);
  assert.match(result.advisory, /expected shape for a change-less change/);
  assert.match(result.advisory, /findings keep full review validity/);
  assert.equal(/admission_record: /.test(result.advisory), false, "no record id is handed back when no record was written");
  assert.equal(fs.existsSync(path.join(fixture.cwd, "openspec")), false, "the hook must not create the change directory");
  // The same absent-folder cwd still blocks a malformed dispatch: the pass is
  // scoped to the missing record carrier, not to the six-field contract.
  const bad = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-assistant", prompt: prompt.replace("objective: independent-judgment", "objective: save-tokens") } }, opts);
  assert.equal(bad.block, true);
});

test("Scenario: Change-Less Canonical Worktree Admits A Review Dispatch With The Expected-Shape Advisory", () => {
  // Issue #3575: a lite bugfix that creates no change folder still dispatches a
  // reviewer. From its canonical `.worktree/<id>` checkout the binding exists and
  // the absent change folder is the expected shape, so the dispatch passes with a
  // non-silent advisory instead of hard-blocking every review round.
  const fixture = changeWorktreeFixture("fix-mail-reply-quote");
  fs.rmSync(path.join(fixture.cwd, "openspec"), { recursive: true });
  const opts = { host: "claude-code", cwd: fixture.cwd, stateDir: fixture.stateDir };
  const prompt = SIX_FIELDS.map((line) => line.replace("role: dp-architect", "role: dp-reviewer")).join("\n");
  const result = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-reviewer", prompt } }, opts);
  assert.equal(result.block, undefined, "a bound change-less worktree must not hard-block a review dispatch");
  assert.match(result.advisory, /admission-records-dir-missing/);
  assert.match(result.advisory, /expected shape for a change-less change/);
  assert.match(result.advisory, /findings keep full review validity/);
  assert.equal(/admission_record: /.test(result.advisory), false, "no record is minted for a change-less worktree");
});

test("Scenario: A Main-Checkout Review Dispatch Still Fails Closed", () => {
  // The change-less advisory never reaches a dispatch that has no binding: a
  // session rooted in the main checkout resolves no `.worktree/<id>` change id,
  // so a review role still fails closed and the expected-shape wording must not
  // appear (issue #3575's remedy is to dispatch from the canonical worktree).
  const root = mkdtempSync(path.join(os.tmpdir(), "spawn-gate-main-checkout-"));
  const cwd = path.join(root, "main");
  mkdirSync(cwd, { recursive: true });
  const git = (args) => spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
  git(["init", "-q"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  const opts = { host: "claude-code", cwd, stateDir: path.join(root, "state") };
  const prompt = SIX_FIELDS.map((line) => line.replace("role: dp-architect", "role: dp-reviewer")).join("\n");
  const result = evaluate({ tool_name: "Agent", tool_input: { subagent_type: "dp-reviewer", prompt } }, opts);
  assert.equal(result.block, true, "a review dispatch with no resolvable binding must fail closed");
  assert.match(result.reason, /change-worktree-required/);
  assert.equal(/expected shape for a change-less change/.test(result.reason), false, "the change-less advisory must not apply without a binding");
});

test("Claude fork carrier is subagent_type fork: reason + six fields with instance_mode fork; general-purpose/resume no longer branch", () => {
  const fixture = changeWorktreeFixture();
  const opts = { host: "claude-code", cwd: fixture.cwd, stateDir: fixture.stateDir };
  const forkFixture = JSON.parse(readFileSync(path.join(FIXTURES, "claude-fork.json"), "utf8"));
  const forked = evaluate(forkFixture.payload, opts);
  const { recordId } = parseHandoff(forked);
  const record = JSON.parse(readFileSync(path.join(admissionRecordsDir(fixture), `${recordId}.json`), "utf8"));
  assert.equal(record.instance_mode, "fork");
  assert.equal(record.role, "dp-explorer");
  assert.equal(record.role_binding, "cooperative-only");
  assert.equal(record.fork_reason, "short side task that needs the current design discussion once");
  assert.equal(evaluate({ tool_name: "Agent", tool_input: { subagent_type: "fork", prompt: forkFixture.payload.tool_input.prompt.replace(/^fork_reason:.*\n/, "") } }, opts).block, true);
  assert.equal(evaluate({ tool_name: "Agent", tool_input: { subagent_type: "fork", prompt: forkFixture.payload.tool_input.prompt.replace("instance_mode: fork", "instance_mode: fresh") } }, opts).block, true);
  assert.equal(evaluate({ tool_name: "Task", tool_input: { subagent_type: "fork", prompt: `${"x".repeat(8192)}\n${forkFixture.payload.tool_input.prompt}` } }, opts).block, true, "fields beyond the 8 KiB bound are not read");
  const legacy = JSON.parse(readFileSync(path.join(FIXTURES, "claude-experimental-fork.json"), "utf8"));
  assert.equal(isAllowed(evaluate(legacy.payload, opts)), true, "general-purpose is a built-in type, not the fork carrier");
  assert.equal(isAllowed(evaluate({ tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "no reason" } }, opts)), true);
  assert.equal(isAllowed(evaluate({ tool_name: "Agent", tool_input: { subagent_type: "Explore", prompt: "fresh" } }, opts)), true);
  assert.equal(isAllowed(evaluate({ tool_name: "Agent", tool_input: { subagent_type: "general-purpose", resume: "agent-id", prompt: "continue" } }, opts)), true);
  assert.equal(fs.readdirSync(admissionRecordsDir(fixture)).length, 1, "built-in types write no record");
});

test("Codex spawn writes a cooperative-only admission record from the message fields; no text carrier passes without a record", () => {
  const fixture = changeWorktreeFixture();
  const opts = { host: "codex", cwd: fixture.cwd, stateDir: fixture.stateDir };
  const message = SIX_FIELDS.map((line) => line.replace("dp-architect", "dp-reviewer")).join("\n") + "\n\nreview the bounded diff";
  const written = evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns: "none", message } }, opts);
  const { recordId } = parseHandoff(written);
  const record = JSON.parse(readFileSync(path.join(admissionRecordsDir(fixture), `${recordId}.json`), "utf8"));
  assert.equal(record.host, "codex");
  assert.equal(record.role, "dp-reviewer");
  assert.equal(record.role_binding, "cooperative-only");
  assert.equal(evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns: "none", message: "no fields here" } }, opts).block, true);
  const noText = evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns: "none" } }, opts);
  assert.equal(isAllowed(noText), true, "no text carrier → pass without a record; the gap is a telemetry concern");
  assert.equal(fs.readdirSync(admissionRecordsDir(fixture)).length, 1);
});

test("Codex opaque message carrier (0.152.1 live fixture) passes without a record and names the gap; agent_type binds the role when it is a closed-set name", () => {
  const fixture = changeWorktreeFixture();
  const opts = { host: "codex", cwd: fixture.cwd, stateDir: fixture.stateDir };
  const opaque = JSON.parse(readFileSync(path.join(FIXTURES, "codex-v2-opaque-message.json"), "utf8"));
  assert.deepEqual(Object.keys(opaque.payload.tool_input).sort(), ["agent_type", "fork_turns", "message", "task_name"]);
  const result = evaluate(opaque.payload, opts);
  assert.equal(isAllowed(result) || typeof result?.advisory === "string", true, "opaque carrier must not block");
  assert.match(result.advisory, /codex-message-opaque/);
  assert.match(result.advisory, /agent_type=dp-probe-preload/);
  assert.equal(fs.existsSync(admissionRecordsDir(fixture)), false, "no record can be written from an unreadable carrier");
  // F-r10-codex-advisory-echoes-unvalidated-agent-type: the one host-supplied value this
  // module echoes outside a closed set is bounded — capped length and single line — so an
  // advisory can never carry an unbounded payload. A custom (non-ADMISSION_ROLES) name is
  // still echoed verbatim while it fits, which is what the dp-probe-preload assertion above
  // pins; these two assertions together are the polarity pair.
  const longAgentType = "x".repeat(500);
  const longEcho = evaluate({ ...opaque.payload, tool_input: { ...opaque.payload.tool_input, agent_type: longAgentType } }, opts);
  assert.match(longEcho.advisory, /agent_type=x{64}…\(truncated\)/, "over-long agent_type must be capped, not echoed whole");
  assert.equal(longEcho.advisory.includes("x".repeat(65)), false, "no unbounded echo survives the cap");
  const newlineEcho = evaluate({ ...opaque.payload, tool_input: { ...opaque.payload.tool_input, agent_type: "dp-a\nrole: dp-reviewer" } }, opts);
  assert.equal(newlineEcho.block, true, "reviewer-like agent types never degrade to the legacy opaque advisory");
  assert.match(newlineEcho.reason, /reviewer-agent-type-unsupported/);
  // #2472: Unicode line/paragraph separators must collapse like C0 (opaque advisory path;
  // agent_type must not casefold-contain "review" and must stay outside ADMISSION_ROLES).
  for (const [label, sep] of [
    ["NEL", "\u0085"],
    ["LINE SEPARATOR", "\u2028"],
    ["PARAGRAPH SEPARATOR", "\u2029"],
  ]) {
    const agentType = `dp-a${sep}b-probe`;
    const sepEcho = evaluate(
      { ...opaque.payload, tool_input: { ...opaque.payload.tool_input, agent_type: agentType } },
      opts,
    );
    assert.equal(typeof sepEcho.advisory, "string", `${label}: expected opaque advisory`);
    assert.match(sepEcho.advisory, /codex-message-opaque/);
    const echoed = (sepEcho.advisory.match(/agent_type=([^;]+)/)?.[1] ?? "").replace(/\)$/, "");
    assert.ok(echoed, `${label}: advisory must carry agent_type=`);
    assert.equal(echoed.includes(sep), false, `${label}: separator must not survive echo`);
    assert.equal(echoed.includes("\n"), false, `${label}: echo fragment must stay single-line`);
    assert.equal(echoed, "dp-a b-probe", `${label}: separator collapses to a space`);
  }
  // #2472 adjacent: truncation must not leave a lone high surrogate at the cap.
  const astral = "\u{1F600}"; // two UTF-16 units
  const astralAgentType = `${"y".repeat(63)}${astral}${"z".repeat(10)}`;
  const astralEcho = evaluate(
    { ...opaque.payload, tool_input: { ...opaque.payload.tool_input, agent_type: astralAgentType } },
    opts,
  );
  const astralFrag = (astralEcho.advisory.match(/agent_type=([^;]+)/)?.[1] ?? "").replace(/\)$/, "");
  assert.match(astralFrag, /…\(truncated\)$/);
  const beforeMarker = astralFrag.slice(0, -"…(truncated)".length);
  const last = beforeMarker.charCodeAt(beforeMarker.length - 1);
  assert.equal(
    last >= 0xd800 && last <= 0xdbff,
    false,
    "truncated echo must not end on an unpaired high surrogate",
  );
  // a Fernet-shaped token that is too short or carries other characters is ordinary text → six fields enforced
  assert.equal(evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns: "none", message: "gAAAAAB short" } }, opts).block, true);
  // plaintext + closed-set agent_type: role must match and the binding is host-verified
  const message = SIX_FIELDS.map((line) => line.replace("dp-architect", "dp-explorer")).join("\n") + "\n\nmap the code paths";
  const bound = evaluate({ tool_name: "collaborationspawn_agent", tool_input: { agent_type: "dp-explorer", fork_turns: "none", message, task_name: "explore" } }, opts);
  const { recordId } = parseHandoff(bound);
  const record = JSON.parse(readFileSync(path.join(admissionRecordsDir(fixture), `${recordId}.json`), "utf8"));
  assert.equal(record.role, "dp-explorer");
  assert.equal(record.role_binding, "host-verified");
  const mismatch = evaluate({ tool_name: "collaborationspawn_agent", tool_input: { agent_type: "dp-reviewer", fork_turns: "none", message, task_name: "explore" } }, opts);
  assert.equal(mismatch.block, true);
  assert.match(mismatch.reason, /intent-missing/);
  // custom agent outside the closed set keeps the cooperative-only declaration
  const custom = evaluate({ tool_name: "collaborationspawn_agent", tool_input: { agent_type: "dp-probe-preload", fork_turns: "none", message, task_name: "probe" } }, opts);
  const customRecord = JSON.parse(readFileSync(path.join(admissionRecordsDir(fixture), `${parseHandoff(custom).recordId}.json`), "utf8"));
  assert.equal(customRecord.role_binding, "cooperative-only");
  assert.equal(fs.readdirSync(admissionRecordsDir(fixture)).length, 2);
});

test("Codex exact dp-reviewer consumes prepared intent before plaintext/opaque parsing and reviewer-like names fail closed", () => {
  const fixture = changeWorktreeFixture();
  const opts = { host: "codex", cwd: fixture.cwd, stateDir: fixture.stateDir };
  const request = {
    schema: CODEX_REVIEWER_REQUEST_SCHEMA,
    change_id: fixture.changeName,
    base_sha: fixture.headSha,
    head_sha: fixture.headSha,
    objective: "independent-judgment",
    responsibility_id: "primary-review",
    instance_mode: "fresh",
    evidence_scope: "local diff",
    return_and_stop: "return findings and stop",
    role: "dp-reviewer",
    agent_type: "dp-reviewer",
    task_name: "review_round",
    fork_turns: "none",
    context_mode: "fresh",
    ttl_seconds: 600,
  };
  assert.equal(issueCodexReviewerAdmission({ cwd: fixture.cwd, request }).ok, true);
  const opaque = `gAAAAA${"A".repeat(48)}`;
  const admitted = evaluate({
    tool_name: "collaborationspawn_agent",
    tool_input: { agent_type: "dp-reviewer", fork_turns: "none", message: opaque, task_name: "review_round" },
  }, opts);
  const { recordId } = parseHandoff(admitted);
  const record = JSON.parse(readFileSync(path.join(admissionRecordsDir(fixture), `${recordId}.json`), "utf8"));
  assert.equal(record.schema, "devpro.spawn-admission-record/v2");
  assert.equal(record.role_binding, "host-verified");
  for (const agent_type of ["dp-Reviewer", "code-reviewer", "REVIEW"] ) {
    const denied = evaluate({ tool_name: "collaborationspawn_agent", tool_input: { agent_type, fork_turns: "none", message: opaque, task_name: "review_round" } }, opts);
    assert.match(denied.reason, /reviewer-agent-type-unsupported/);
  }
});

test("Codex derives generic admission for every registered non-primary role while reviewer header drift stays blocked", () => {
  const genericRoles = ADMISSION_ROLES.filter((role) => role !== "dp-reviewer");
  for (const role of genericRoles) {
    const fixture = changeWorktreeFixture();
    const prompt = SIX_FIELDS.map((line) => line.replace("role: dp-architect", `role: ${role}`)).join("\n");
    const admitted = evaluate({
      tool_name: "collaborationspawn_agent",
      tool_input: { agent_type: role, fork_turns: "none", message: prompt, task_name: `admit_${role}` },
    }, { host: "codex", cwd: fixture.cwd, stateDir: fixture.stateDir });
    assert.equal(admitted?.block, undefined, `${role}: ${admitted?.reason}`);
    const { recordId } = parseHandoff(admitted);
    const record = JSON.parse(readFileSync(path.join(admissionRecordsDir(fixture), `${recordId}.json`), "utf8"));
    assert.equal(record.role, role);
    assert.equal(record.role_binding, "host-verified");
  }
  assert.equal(genericRoles.includes("dp-second-reviewer"), true, "the second reviewer is covered by the shared role SSOT");

  const fixture = changeWorktreeFixture();
  const opts = { host: "codex", cwd: fixture.cwd, stateDir: fixture.stateDir };
  const prompt = SIX_FIELDS
    .map((line) => line.replace("role: dp-architect", "role: dp-second-reviewer"))
    .join("\n");

  for (const message of [
    prompt.replace("role: dp-second-reviewer", "role: dp-architect"),
    prompt.split("\n").slice(0, -1).join("\n"),
  ]) {
    const denied = evaluate({
      tool_name: "collaborationspawn_agent",
      tool_input: { agent_type: "dp-second-reviewer", fork_turns: "none", message, task_name: "second_review" },
    }, opts);
    assert.equal(denied.block, true);
  }
  for (const agent_type of ["dp-Second-reviewer", "future-reviewer"]) {
    const denied = evaluate({
      tool_name: "collaborationspawn_agent",
      tool_input: { agent_type, fork_turns: "none", message: prompt, task_name: "second_review" },
    }, opts);
    assert.match(denied.reason, /reviewer-agent-type-unsupported/u);
  }

  // Spec narrowing lock: opaque message for exact allowlisted generic roles
  // stays a named cooperative advisory — not prepared-intent-grade deny.
  // Absent message for the same registered role MUST NOT bare-null (D4.1).
  const opaque = evaluate({
    tool_name: "collaborationspawn_agent",
    tool_input: {
      agent_type: "dp-second-reviewer",
      fork_turns: "none",
      message: `gAAAAA${"C".repeat(48)}`,
      task_name: "second_review",
    },
  }, opts);
  assert.equal(opaque?.block, undefined, "opaque allowlisted generic role must not mechanically deny");
  assert.match(opaque.advisory, /codex-message-opaque/);
  assert.equal(fs.existsSync(admissionRecordsDir(fixture)) ? fs.readdirSync(admissionRecordsDir(fixture)).length : 0, 0);
  const absent = evaluate({
    tool_name: "collaborationspawn_agent",
    tool_input: { agent_type: "dp-second-reviewer", fork_turns: "none", task_name: "second_review" },
  }, opts);
  assert.equal(absent?.block, undefined, "absent message for allowlisted generic role must not mechanically deny");
  assert.match(absent.advisory, /codex-registered-role-no-record/);
  assert.notEqual(absent, null, "registered generic missing-record must not bare-null");
});

test("named and prepared Codex admission paths never silent-null when a record is required", () => {
  const fixture = changeWorktreeFixture();
  const opts = { host: "codex", cwd: fixture.cwd, stateDir: fixture.stateDir };

  // Prepared dp-reviewer with no live intent → block (visible), never null.
  const preparedMissing = evaluate({
    tool_name: "collaborationspawn_agent",
    tool_input: { agent_type: "dp-reviewer", fork_turns: "none", message: `gAAAAA${"D".repeat(48)}`, task_name: "review_round" },
  }, opts);
  assert.equal(preparedMissing.block, true);
  assert.match(preparedMissing.reason, /intent-missing|reviewer-change-worktree-required/);
  assert.notEqual(preparedMissing, null);

  // Registered generic without readable six-field carrier → named advisory, never null.
  for (const role of ADMISSION_ROLES.filter((name) => name !== "dp-reviewer")) {
    const missing = evaluate({
      tool_name: "collaborationspawn_agent",
      tool_input: { agent_type: role, fork_turns: "none", task_name: `admit_${role}` },
    }, opts);
    assert.equal(missing?.block, undefined, `${role} must not block on absent message`);
    assert.match(missing.advisory, /codex-registered-role-no-record/);
    assert.notEqual(missing, null, `${role} must not bare-null`);
  }

  // Forge ban: governed carriers must not call writeAdmissionRecord /
  // evaluateAgentDispatch as a remediation for missing records. Allowance is
  // bound to exact legitimate import/definition/call-site counts — not a
  // whole-file identifier exemption.
  const source = readFileSync(new URL("../hooks/lib/spawn-context-admission.mjs", import.meta.url), "utf8");
  assert.match(source, /CODEX_REGISTERED_ROLE_NO_RECORD_GAP/);

  function countCallSites(text, id) {
    const all = [...text.matchAll(new RegExp(`\\b${id}\\s*\\(`, "gu"))].length;
    const definitions = [...text.matchAll(new RegExp(`(?:export\\s+)?function\\s+${id}\\s*\\(`, "gu"))].length;
    return all - definitions;
  }

  function assertIdentifierAllowance(text, rel, id, allowance) {
    const calls = countCallSites(text, id);
    assert.equal(calls, allowance.calls, `${rel}: unexpected ${id} call-site count`);
    if (allowance.definition) {
      assert.match(
        text,
        new RegExp(`(?:export\\s+)?function\\s+${id}\\s*\\(`, "u"),
        `${rel}: missing legitimate ${id} definition`,
      );
    } else {
      assert.equal(
        new RegExp(`(?:export\\s+)?function\\s+${id}\\s*\\(`, "u").test(text),
        false,
        `${rel}: unexpected ${id} definition`,
      );
    }
    if (allowance.importNamed) {
      assert.match(
        text,
        new RegExp(`import\\s*\\{[\\s\\S]*?\\b${id}\\b[\\s\\S]*?\\}\\s*from\\s+["'][^"']+["']`, "u"),
        `${rel}: missing legitimate ${id} import`,
      );
    }
    if (!allowance.definition && !allowance.importNamed && allowance.calls === 0) {
      assert.equal(
        new RegExp(`\\b${id}\\b`, "u").test(text),
        false,
        `${rel}: must not mention ${id}`,
      );
    }
  }

  function assertForgeBanCarriers(carrierTexts) {
    for (const { rel, text, expected } of carrierTexts) {
      for (const id of ["writeAdmissionRecord", "evaluateAgentDispatch"]) {
        assertIdentifierAllowance(text, rel, id, expected[id] ?? { calls: 0 });
      }
    }
  }

  const spawnRel = "../hooks/lib/spawn-context-admission.mjs";
  const carrierTexts = [
    {
      rel: spawnRel,
      text: source,
      expected: {
        writeAdmissionRecord: { calls: 3, importNamed: true },
        evaluateAgentDispatch: { calls: 0, definition: true },
      },
    },
    {
      rel: "../hooks/lib/admission-record.mjs",
      text: readFileSync(new URL("../hooks/lib/admission-record.mjs", import.meta.url), "utf8"),
      expected: {
        writeAdmissionRecord: { calls: 0, definition: true },
        evaluateAgentDispatch: { calls: 0 },
      },
    },
    {
      rel: "../hooks/pre-tool-gate.mjs",
      text: readFileSync(new URL("../hooks/pre-tool-gate.mjs", import.meta.url), "utf8"),
      expected: {
        writeAdmissionRecord: { calls: 0 },
        evaluateAgentDispatch: { calls: 1, importNamed: true },
      },
    },
    {
      rel: "../../../.devpro/agent-skills/devpro-workflows/change/SKILL.md",
      text: readFileSync(new URL("../../../.devpro/agent-skills/devpro-workflows/change/SKILL.md", import.meta.url), "utf8"),
      expected: {},
    },
    {
      rel: "../../../.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
      text: readFileSync(new URL("../../../.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md", import.meta.url), "utf8"),
      expected: {},
    },
    {
      rel: "../../../.devpro/agent-rules/model-delegation.md",
      text: readFileSync(new URL("../../../.devpro/agent-rules/model-delegation.md", import.meta.url), "utf8"),
      expected: {},
    },
    {
      rel: "../../../.devpro/agent-rules/multi-agent-handoff.md",
      text: readFileSync(new URL("../../../.devpro/agent-rules/multi-agent-handoff.md", import.meta.url), "utf8"),
      expected: {},
    },
  ];
  assertForgeBanCarriers(carrierTexts);
  // Mutation-negative: an extra remediation call on the allowlisted carrier must fail.
  assert.throws(
    () => assertForgeBanCarriers([
      {
        ...carrierTexts[0],
        text: `${source}\nwriteAdmissionRecord({});\n`,
      },
    ]),
    /unexpected writeAdmissionRecord call-site count/,
  );
});

test("Cursor Task with named dp-* projection writes host-verified admission (not pass-through)", () => {
  const fixture = changeWorktreeFixture();
  const prompt = [
    "objective: independent-judgment",
    "responsibility_id: primary-review",
    "instance_mode: fresh",
    "evidence_scope: openspec/changes/strengthen-reviewer-model-selection/proposal.md",
    "return_and_stop: report git rev-parse HEAD then stop; do not edit",
    "role: dp-assistant",
  ].join("\n");
  const result = evaluate(
    {
      tool_name: "Task",
      tool_input: { subagent_type: "dp-assistant", prompt },
    },
    { host: "cursor", cwd: fixture.cwd, stateDir: fixture.stateDir },
  );
  assert.notEqual(result, PASS_THROUGH, "Cursor Task must not stay pass-through for named projections");
  const { recordId, digest } = parseHandoff(result);
  const file = path.join(admissionRecordsDir(fixture), `${recordId}.json`);
  const bytes = readFileSync(file);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  const record = JSON.parse(bytes.toString("utf8"));
  assert.equal(record.host, "cursor");
  assert.equal(record.role, "dp-assistant");
  assert.equal(record.role_binding, "host-verified");
  assert.equal(record.instance_mode, "fresh");
});

test("Cursor Task without subagent_type or incomplete admission fields blocks", () => {
  const fixture = changeWorktreeFixture();
  const opts = { host: "cursor", cwd: fixture.cwd, stateDir: fixture.stateDir };
  const bare = JSON.parse(readFileSync(path.join(FIXTURES, "cursor-task.json"), "utf8"));
  const missingType = evaluate(bare.payload, opts);
  assert.equal(missingType.block, true);
  assert.match(missingType.reason, /subagent_type/);
  const incomplete = evaluate(
    {
      tool_name: "Task",
      tool_input: {
        subagent_type: "dp-assistant",
        prompt: "objective: independent-judgment\nrole: dp-assistant\n",
      },
    },
    opts,
  );
  assert.equal(incomplete.block, true);
  assert.equal(fs.existsSync(admissionRecordsDir(fixture)), false);
});

test("tracked fixtures replay every promised Codex and Claude token/mode shape", () => {
  const v2Modes = JSON.parse(readFileSync(path.join(FIXTURES, "codex-v2-modes.json"), "utf8"));
  for (const payload of v2Modes.payloads) {
    const result = evaluate(payload);
    assert.equal(payload.tool_input.fork_turns === "all" ? result.block : isAllowed(result), true);
  }
  for (const name of ["codex-v1-fresh.json", "codex-v1-full.json"]) {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
    const result = evaluate(fixture.payload);
    assert.equal(fixture.expected === "allow" ? isAllowed(result) : result.block, true, name);
  }
  for (const name of ["claude-named-fresh.json", "claude-task-resume.json", "claude-experimental-fork.json"]) {
    const fixture = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
    assert.equal(isAllowed(evaluate(fixture.payload, { host: fixture.host })), true, name);
  }
});

test("run-hook config --host overrides inherited env and payload host-like fields", () => {
  const wrapper = path.join(ROOT, ".devpro", "scripts", "hooks", "run-hook.mjs");
  const gate = path.join(ROOT, ".devpro", "scripts", "hooks", "pre-tool-gate.mjs");
  const cwd = mkdtempSync(path.join(os.tmpdir(), "spawn-host-precedence-"));
  const payload = JSON.stringify({ tool_name: "collaborationspawn_agent", tool_input: {}, cwd, host: "claude-code" });
  const result = spawnSync(process.execPath, [wrapper, "PreToolUse", gate, "--host=codex"], {
    cwd: ROOT,
    input: payload,
    encoding: "utf8",
    env: { ...process.env, DEVPRO_HOOK_HOST: "claude-code" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, "block");
});

// Round-1 review F-r1-admission-record-freeform-value-unguarded: the hook maps
// the writer's `admission-record-unsafe-value` to a block that names the field
// contract, and no record lands.
test("Claude named dp-* spawn whose evidence_scope carries a user-home absolute path is blocked before any record is written", () => {
  const fixture = changeWorktreeFixture();
  const payload = JSON.parse(readFileSync(path.join(FIXTURES, "claude-named-dp-fresh.json"), "utf8")).payload;
  const prompt = String(payload.tool_input.prompt).replace(/^evidence_scope: .*$/m, "evidence_scope: /Users/someone/repo/tasks.md");
  const result = evaluate({ ...payload, tool_input: { ...payload.tool_input, prompt } }, { host: "claude-code", cwd: fixture.cwd, stateDir: fixture.stateDir });
  assert.equal(result.block, true);
  assert.match(result.reason, /admission-record-unsafe-value/);
  assert.equal(fs.existsSync(admissionRecordsDir(fixture)), false);
});

// --- D34 continuation carriers (Claude SendMessage / Codex followup_task) ---

const PARENT_RECORD_ID = "586d4b24-0000-4000-8000-000000000000";
const CONTINUE_FIELDS = [
  "objective: independent-judgment",
  "responsibility_id: primary-review",
  "instance_mode: continue",
  `parent_record_id: ${PARENT_RECORD_ID}`,
  "evidence_scope: openspec/changes/<change>/proposal.md",
  "return_and_stop: structured receipt JSON; stop after the receipt",
  "role: dp-reviewer",
];

function continuationPayload(toolName, message) {
  return { tool_name: toolName, tool_input: { to: "dp-reviewer-thread", target: "dp-reviewer-thread", message } };
}

test("continuation carriers admit a declared continue record and stay out of ordinary messaging", () => {
  const fixture = changeWorktreeFixture();
  const opts = { host: "claude-code", cwd: fixture.cwd, stateDir: fixture.stateDir };

  const observed = JSON.parse(readFileSync(path.join(FIXTURES, "claude-continuation-sendmessage.json"), "utf8")).payload;
  const admitted = evaluate(observed, opts);
  const { recordId, digest } = parseHandoff(admitted);
  const bytes = readFileSync(path.join(admissionRecordsDir(fixture), `${recordId}.json`));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  const record = JSON.parse(bytes.toString("utf8"));
  assert.equal(record.instance_mode, "continue");
  assert.equal(record.parent_record_id, PARENT_RECORD_ID);
  assert.equal(record.role, "dp-reviewer");
  assert.equal(record.role_binding, "cooperative-only", "no continuation payload carries a role field on either runtime");
  assert.equal(record.head_sha, fixture.headSha, "the continuation record binds the new head, which is what a rereview receipt needs");
  assert.equal(Object.hasOwn(record, "prompt_sha256"), true);

  // Ordinary messaging is not a governed continuation: opt-in is by carrier text.
  const undeclared = changeWorktreeFixture();
  const undeclaredOpts = { host: "claude-code", cwd: undeclared.cwd, stateDir: undeclared.stateDir };
  assert.equal(isAllowed(evaluate(continuationPayload("SendMessage", "please re-check the two open findings"), undeclaredOpts)), true);
  assert.equal(isAllowed(evaluate({ tool_name: "SendMessage", tool_input: { to: "main" } }, undeclaredOpts)), true);
  assert.equal(
    fs.existsSync(admissionRecordsDir(undeclared)) ? fs.readdirSync(admissionRecordsDir(undeclared)).length : 0,
    0,
    "undeclared messages write no record",
  );

  // Declared but malformed fails closed, and never writes a record.
  const blocked = changeWorktreeFixture();
  const blockedOpts = { host: "claude-code", cwd: blocked.cwd, stateDir: blocked.stateDir };
  const withoutParent = CONTINUE_FIELDS.filter((line) => !line.startsWith("parent_record_id:"));
  assert.equal(evaluate(continuationPayload("SendMessage", withoutParent.join("\n")), blockedOpts).block, true);
  assert.equal(evaluate(continuationPayload("SendMessage", CONTINUE_FIELDS.map((line) => line.replace(PARENT_RECORD_ID, "not-a-uuid")).join("\n")), blockedOpts).block, true);
  // Round-3 F-r3-continuation-declaration-false-positive: a non-`continue` mode on
  // a continuation carrier is discussion, not a governed handoff — neither tool can
  // start a fresh or forked thread — so it passes ungoverned instead of blocking.
  assert.equal(evaluate(continuationPayload("SendMessage", CONTINUE_FIELDS.map((line) => line.replace("instance_mode: continue", "instance_mode: fresh")).join("\n")), blockedOpts), null, "a quoted fresh declaration must not block a message");
  assert.equal(evaluate(continuationPayload("SendMessage", [...withoutParent.map((line) => line.replace("instance_mode: continue", "instance_mode: fork")), "fork_reason: short side task"].join("\n")), blockedOpts), null, "a quoted fork declaration must not block a message");
  // The reviewer's named case: relaying a complete fresh dispatch block verbatim.
  assert.equal(evaluate(continuationPayload("SendMessage", [
    "以下是 round-3 的 dispatch block，供你對照：",
    "objective: independent-judgment",
    "responsibility_id: primary-review",
    "instance_mode: fresh",
    "evidence_scope: openspec/changes/strengthen-subagent-delegation-strategy",
    "return_and_stop: 結構化 receipt_payload；回報後停",
    "role: dp-reviewer",
  ].join("\n")), blockedOpts), null, "quoting a whole fresh dispatch block must not block a message");
  // A message that merely mentions the mode is not a declaration either.
  assert.equal(evaluate(continuationPayload("SendMessage", "續作時記得寫 instance_mode: continue，不要漏 parent_record_id。"), blockedOpts), null, "a single stray admission key is discussion, not a declaration");
  assert.equal(evaluate(continuationPayload("SendMessage", CONTINUE_FIELDS.join("\n")), { host: "claude-code" }).block, true, "declaration outside a change worktree fails closed");
  assert.equal(
    fs.existsSync(admissionRecordsDir(blocked)) ? fs.readdirSync(admissionRecordsDir(blocked)).length : 0,
    0,
    "no record on any block",
  );

  // Codex: both hook-visible spellings route to the same cooperative-only branch.
  for (const toolName of ["followup_task", "collaborationfollowup_task"]) {
    const codex = changeWorktreeFixture();
    const codexOpts = { host: "codex", cwd: codex.cwd, stateDir: codex.stateDir };
    const handoff = parseHandoff(evaluate(continuationPayload(toolName, CONTINUE_FIELDS.join("\n")), codexOpts));
    const codexRecord = JSON.parse(readFileSync(path.join(admissionRecordsDir(codex), `${handoff.recordId}.json`), "utf8"));
    assert.equal(codexRecord.host, "codex");
    assert.equal(codexRecord.instance_mode, "continue");
    assert.equal(codexRecord.role_binding, "cooperative-only");
    const opaque = evaluate(continuationPayload(toolName, `gAAAAA${"B".repeat(48)}`), codexOpts);
    assert.match(opaque.advisory, /codex-message-opaque/);
    assert.equal(isAllowed(evaluate({ tool_name: toolName, tool_input: { target: "x" } }, codexOpts)), true);
  }

  // Cursor has no governed continuation carrier: pass through instead of blocking.
  assert.equal(isAllowed(evaluate(continuationPayload("SendMessage", CONTINUE_FIELDS.join("\n")), { host: "cursor" })), true);
});

// C-02 (PR #2473 second cross-model round): `evaluateCodexSpawnMode` validates
// the SHAPE of `fork_turns` and then discards it, and `admitCodexRecord` writes
// whatever `instance_mode` the message text declares. So a Codex spawn that the
// host says carries 1..6 turns of parent context — or `all`, once the one-shot
// override is spent — could still declare `instance_mode: fresh` and be recorded
// as an independent root. `session-usage-lineage.mjs` already maps a positive
// `fork_turns` to `fork`, so the same codebase read one host payload two ways,
// and `assertAdmissionChainRootsToFresh` (Done When 6: "fork record 仍被拒")
// accepted the declared-fresh record it was written to reject. The host field is
// present in the live 0.152.1 payload, so this is mechanically checkable — it is
// NOT covered by R4's `[cooperative-only]` carve-out, which is about the missing
// agent-NAME field, not about fork evidence.
test("C-02: Codex host fork evidence overrides a contradicting instance_mode declaration", () => {
  const fixture = changeWorktreeFixture();
  const opts = { host: "codex", cwd: fixture.cwd, stateDir: fixture.stateDir };
  const fresh = SIX_FIELDS.join("\n") + "\n\nbounded task";
  const forked = SIX_FIELDS.map((line) => line.replace("instance_mode: fresh", "instance_mode: fork")).join("\n")
    + "\nfork_reason: the parent's comparison context is the evidence\n\nbounded task";

  // control: the host says fresh and the record says fresh — unchanged behaviour
  const control = evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns: "none", message: fresh } }, opts);
  assert.notEqual(control?.block, true, "fork_turns: none with instance_mode: fresh must still be admitted");
  assert.equal(JSON.parse(readFileSync(path.join(admissionRecordsDir(fixture), `${parseHandoff(control).recordId}.json`), "utf8")).instance_mode, "fresh");

  for (const fork_turns of ["1", "6"]) {
    const declaredFresh = evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns, message: fresh } }, opts);
    assert.equal(declaredFresh.block, true, `fork_turns=${fork_turns} with instance_mode: fresh must block`);
    assert.match(declaredFresh.reason, /fork_turns/);
  }

  // `all` needs the one-shot authority first; once spent, the same contradiction still blocks
  assert.equal(issueSpawnContextOverride({ cwd: fixture.cwd, stateDir: fixture.stateDir, reason: "full history is required for this bounded comparison", nowMs: 1000 }).ok, true);
  const allFresh = evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns: "all", message: fresh } }, opts);
  assert.equal(allFresh.block, true, "fork_turns=all with instance_mode: fresh must block even after the override is consumed");

  // a record that declares what the host observed is admitted
  assert.equal(issueSpawnContextOverride({ cwd: fixture.cwd, stateDir: fixture.stateDir, reason: "full history is required for this bounded comparison", nowMs: 2000 }).ok, true);
  const honest = evaluate({ tool_name: "collaborationspawn_agent", tool_input: { fork_turns: "all", message: forked } }, opts);
  const { recordId } = parseHandoff(honest);
  const record = JSON.parse(readFileSync(path.join(admissionRecordsDir(fixture), `${recordId}.json`), "utf8"));
  assert.equal(record.instance_mode, "fork", "a truthful fork declaration is still admitted and recorded as fork");
});

// fix-codex-reviewer-intent-candidate-cap T2b (prove-it): the budget diagnostics.
// Test-process wrapper around child_process.spawnSync("git", ...): pads the
// `git worktree list --porcelain -z` output with duplicate main-checkout entries
// (a path without a `.worktree/` segment: it counts toward the list but is never a
// candidate) so the 129-entry case needs no 129 real worktrees. Forwards everything
// else to the real git, adds no production seam, and is always restored.
function withPaddedWorktreeList({ padListTo, padPath }, run) {
  const original = childProcess.spawnSync;
  let listCalls = 0;
  childProcess.spawnSync = function shimmedSpawnSync(file, args, options) {
    const result = original.apply(this, arguments);
    if (file === "git" && Array.isArray(args) && args[0] === "worktree" && args[1] === "list" && result.status === 0) {
      listCalls += 1;
      const raw = String(result.stdout);
      const have = (raw.match(/\0\0/gu) ?? []).length;
      return { ...result, stdout: raw + `worktree ${padPath}\0HEAD ${"a".repeat(40)}\0\0`.repeat(Math.max(0, padListTo - have)) };
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    return { value: run(), listCalls: () => listCalls };
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
}

const ABSOLUTE_PATH_SHAPE = /(?:\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:[\\/])/u;

function assertBudgetReason(reason, label) {
  assert.equal(typeof reason, "string", `${label}: a block reason is present`);
  assert.equal(/[\r\n]/u.test(reason), false, `${label}: the reason is a single line`);
  assert.match(reason, /git-branch-hygiene\.md/u, `${label}: the reason points at the user-consented remediation`);
  assert.equal(ABSOLUTE_PATH_SHAPE.test(reason), false, `${label}: the reason carries no absolute path`);
  assert.doesNotMatch(reason, /prune/u, `${label}: git worktree prune does not help a live checkout`);
}

test("Common-Dir Exact-One Prepared Intent Discovery: both prepared-branch budget codes project one-line reasons that name git-branch-hygiene.md and no absolute path", () => {
  for (const code of ["intent-candidate-limit-exceeded", "intent-entry-budget-exhausted"]) {
    const blocked = spawnContextBlock(code);
    assert.equal(blocked.block, true);
    assertBudgetReason(blocked.reason, code);
    assert.match(blocked.reason, new RegExp(code === "intent-candidate-limit-exceeded" ? "128" : "8192", "u"), `${code}: the reason names its limit`);
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: the pre-tool gate blocks an over-budget prepared dp-reviewer dispatch with the one-line remediation reason", () => {
  const fixture = mainLinkedFixture("budget-diagnostic-change");
  try {
    const dispatch = {
      tool_name: "collaborationspawn_agent",
      tool_input: { agent_type: "dp-reviewer", fork_turns: "none", message: `gAAAAA${"E".repeat(48)}`, task_name: "review_round" },
    };
    const opts = { host: "codex", cwd: fixture.mainRoot };

    const overWorktrees = withPaddedWorktreeList({ padListTo: 129, padPath: fixture.mainRoot }, () => evaluate(dispatch, opts));
    assert.equal(overWorktrees.listCalls() >= 1, true, "the padded worktree list was really consumed");
    assert.equal(overWorktrees.value.block, true);
    assert.match(overWorktrees.value.reason, /^Spawn Context Admission Gate: intent-candidate-limit-exceeded: /u);
    assertBudgetReason(overWorktrees.value.reason, "129 worktree entries");

    const intentDir = path.join(fixture.linkedChangeDir, "admission-records", "codex-reviewer-intents");
    mkdirSync(intentDir, { recursive: true });
    for (let i = 0; i < 8193; i += 1) writeFileSync(path.join(intentDir, `filler-${String(i).padStart(5, "0")}.txt`), "");
    const overEntries = evaluate(dispatch, opts);
    assert.equal(overEntries.block, true);
    assert.match(overEntries.reason, /^Spawn Context Admission Gate: intent-entry-budget-exhausted: /u);
    assertBudgetReason(overEntries.reason, "8193 intent-directory entries");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Common-Dir Exact-One Prepared Intent Discovery: the generic admission path's worktree-cap reason names git-branch-hygiene.md instead of advising prune", () => {
  const fixture = mainLinkedFixture("generic-cap-diagnostic-change");
  try {
    const dispatch = { tool_name: "Agent", tool_input: { subagent_type: "dp-architect", prompt: SIX_FIELDS.join("\n") } };
    for (const [label, cwd] of [["main checkout cwd with a declared change_id", fixture.mainRoot], ["linked worktree cwd", fixture.linkedRoot]]) {
      const declared = label.includes("declared")
        ? { ...dispatch, tool_input: { ...dispatch.tool_input, prompt: `change_id: ${fixture.changeName}\nexecution_root: ${fixture.linkedRoot}\n${SIX_FIELDS.join("\n")}` } }
        : dispatch;
      const padded = withPaddedWorktreeList({ padListTo: 129, padPath: fixture.mainRoot }, () => evaluate(declared, { host: "claude-code", cwd }));
      assert.equal(padded.listCalls() >= 1, true, `${label}: the padded worktree list was really consumed`);
      assert.equal(padded.value?.block, true, `${label}: ${JSON.stringify(padded.value)}`);
      assert.match(padded.value.reason, /intent-candidate-limit-exceeded/u, `${label}: the cap code is named`);
      assertBudgetReason(padded.value.reason, label);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
