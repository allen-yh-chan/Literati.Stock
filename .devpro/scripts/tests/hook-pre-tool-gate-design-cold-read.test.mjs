/**
 * hook-pre-tool-gate-design-cold-read.test.mjs
 *
 * Gate CR: a change carrying proposal + design.md needs
 * `openspec/changes/<change>/comprehension.md` with a releasing first-line
 * status, one `user-answer:` line quoting the user and one `change:` line
 * naming the branch's change before the first implementation write. The AI records that answer after the user answers in
 * the conversation; no terminal, key or signature is involved.
 *
 * "Full" is read from the change's own shape, never from
 * DEVPRO_AGENT_RULES_LEVEL: a user can name full inside a session, which the
 * hook level cannot see, while lite never writes a proposal. Both directions
 * are pinned below.
 *
 * Driven in-process through `evaluatePreToolUsePayload` against throwaway git
 * repos, so every other write gate also sees the payload.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluatePreToolUsePayload, PASS_THROUGH } from "../hooks/pre-tool-gate.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const tmpRoot = makeTempDir("pre-tool-gate-design-cold-read-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const CHANGE = "add-sample-cold-read";
const BRANCH = `feature/${CHANGE}`;
const PROPOSAL = "# proposal\n\n## Batch Approval Ledger\n\nN/A: no batch approval selected\n";

let repoCounter = 0;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

function assertNoAnswerBlock(reason, flag = "") {
  assert.ok(reason, "write must be blocked");
  assert.match(reason, /Gate CR \(Design Cold Read Prewrite\)/);
  assert.match(reason, /第一行是放行狀態，但沒有恰好一行非空的 `user-answer:` 引用使用者的回答、沒有寫明本 change 的 `change:` 行，或仍是舊版帶 `proof=` 的簽章格式/);
  assert.match(reason, /先在對話問使用者確認/);
  assert.ok(reason.includes(`confirm-design-cold-read.mjs ${CHANGE} --user-answer "<使用者原話>"${flag}\``), reason);
  assert.match(reason, /使用者還沒回答時不得跑/);
  assert.match(reason, /紀錄已有讀者原文與對照時不用重做冷讀/);
  assert.doesNotMatch(reason, /派 fresh 讀者/);
  assert.doesNotMatch(reason, /自己的終端機/);
}

function assertForeignChangeBlock(reason, foreign = "other-change") {
  assert.ok(reason, "write must be blocked");
  assert.match(reason, /Gate CR \(Design Cold Read Prewrite\)/);
  assert.ok(reason.includes(`\`change:\` 寫的是 \`${foreign}\`，不是本 change \`${CHANGE}\``), reason);
  assert.match(reason, /可能是從別的 change 複製來的紀錄/);
  assert.match(reason, /不要直接重跑確認指令：把第一行改回 `status: pending`/);
  assert.match(reason, /為本 change 重做冷讀/);
  assert.match(reason, /batch approval 不涵蓋/);
}

function setupRepo(branch = BRANCH) {
  const dir = path.join(tmpRoot, `repo-${repoCounter++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", branch]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "x"), "");
  git(dir, ["add", "x"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function setupLinkedWorktree() {
  const repo = setupRepo("main");
  const worktree = path.join(tmpRoot, `wt-${repoCounter++}`);
  git(repo, ["worktree", "add", "-q", "-b", BRANCH, worktree, "HEAD"]);
  return worktree;
}

function writeChangeFile(root, name, content) {
  const file = path.join(root, "openspec", "changes", CHANGE, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function setupDesignChange(root) {
  writeChangeFile(root, "proposal.md", PROPOSAL);
  writeChangeFile(root, "design.md", "# design\n");
  return root;
}

function writeRecord(root, firstLine) {
  writeChangeFile(root, "comprehension.md", `${firstLine}\n\n## 讀者復述\n\n內容\n`);
}

const CONFIRM = path.resolve(import.meta.dirname, "..", "confirm-design-cold-read.mjs");

// What the AI runs once the user has answered in the conversation.
function recordAnswer(root, { change = CHANGE, unverified = false, answer = "確認" } = {}) {
  const argv = [CONFIRM, change, "--user-answer", answer, ...(unverified ? ["--unverified"] : [])];
  const run = spawnSync(process.execPath, argv, { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

function recordFile(root) {
  return path.join(root, "openspec", "changes", CHANGE, "comprehension.md");
}

function writeTo(root, relPath) {
  return { tool_name: "Write", tool_input: { file_path: path.join(root, relPath), content: "write\n" } };
}

function implementationWrite(root) {
  return writeTo(root, "src/app.mjs");
}

function withLevel(level, fn) {
  const saved = process.env.DEVPRO_AGENT_RULES_LEVEL;
  if (level === undefined) delete process.env.DEVPRO_AGENT_RULES_LEVEL;
  else process.env.DEVPRO_AGENT_RULES_LEVEL = level;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.DEVPRO_AGENT_RULES_LEVEL;
    else process.env.DEVPRO_AGENT_RULES_LEVEL = saved;
  }
}

// Returns the block reason, or null when the write passes.
function blockReason(payload, cwd, { level } = {}) {
  return withLevel(level, () => {
    const result = evaluatePreToolUsePayload({ ...payload, cwd });
    if (!result || result === PASS_THROUGH) return null;
    return result.block ? result.reason : null;
  });
}

function assertColdReadBlock(reason) {
  assert.ok(reason, "write must be blocked");
  assert.match(reason, /Gate CR \(Design Cold Read Prewrite\)/);
  assert.match(reason, new RegExp(`openspec/changes/${CHANGE}/comprehension\\.md`));
  assert.match(reason, /design-reasoning\.md/);
  assert.match(reason, /`\/devpro:change` 的 Design Cold Read 段/);
  assert.match(reason, /第一行 `status: pending`/);
  assert.match(reason, /batch approval 不涵蓋/);
  assert.match(reason, /使用者在對話回答後由 AI 跑 `node \.devpro\/scripts\/confirm-design-cold-read\.mjs add-sample-cold-read --user-answer "<使用者原話>"`/);
  assert.match(reason, /使用者還沒回答時不得跑/);
  assert.doesNotMatch(reason, /自己的終端機/);
  assert.match(reason, /沒有讀者可用或本規則上線前已開工時標「冷讀未驗證」/);
}

test("blocks the first implementation write when design.md has no cold-read record", () => {
  const root = setupDesignChange(setupRepo());
  assertColdReadBlock(blockReason(implementationWrite(root), root));
});

test("blocks in a linked worktree, reading the record from that worktree", () => {
  const root = setupDesignChange(setupLinkedWorktree());
  assertColdReadBlock(blockReason(implementationWrite(root), root));
});

test("blocks while the record is still pending and names the status it found", () => {
  const root = setupDesignChange(setupRepo());
  writeRecord(root, "status: pending");
  const reason = blockReason(implementationWrite(root), root);
  assertColdReadBlock(reason);
  assert.match(reason, /`status: pending`/);
});

for (const [label, firstLine] of [
  ["a heading above the status line", "# 冷讀紀錄\n\nstatus: user-confirmed"],
  ["an indented status line", "  status: user-confirmed"],
  ["trailing prose on the status line", "status: user-confirmed 但還沒問"],
  ["an unknown status value", "status: confirmed"],
  ["a status value differing only by case", "status: User-Confirmed"],
]) {
  test(`blocks a record with ${label}`, () => {
    const root = setupDesignChange(setupRepo());
    writeRecord(root, firstLine);
    assertColdReadBlock(blockReason(implementationWrite(root), root));
  });
}

test("blocks an empty record", () => {
  const root = setupDesignChange(setupRepo());
  writeChangeFile(root, "comprehension.md", "");
  assertColdReadBlock(blockReason(implementationWrite(root), root));
});

test("the reader's quoted text cannot release the gate", () => {
  const root = setupDesignChange(setupRepo());
  writeRecord(root, "status: pending\n\nstatus: user-confirmed");
  assertColdReadBlock(blockReason(implementationWrite(root), root));
});

test("an answer line under a pending status does not release", () => {
  const root = setupDesignChange(setupRepo());
  writeRecord(root, "status: pending\nuser-answer: 確認");
  assertColdReadBlock(blockReason(implementationWrite(root), root));
});

for (const unverified of [false, true]) {
  test(`passes once the AI has recorded the user's answer (unverified: ${unverified})`, () => {
    const root = setupDesignChange(setupRepo());
    writeRecord(root, "status: pending");
    recordAnswer(root, { unverified });
    assert.equal(blockReason(implementationWrite(root), root), null);
  });
}

for (const [status, flag] of [["user-confirmed", ""], ["user-accepted-unverified", " --unverified"]]) {
  test(`a releasing status without the user's answer does not release: ${status}`, () => {
    const root = setupDesignChange(setupRepo());
    writeRecord(root, `status: ${status}`);
    assertNoAnswerBlock(blockReason(implementationWrite(root), root), flag);
  });

  test(`a legacy signed record does not release and is re-confirmed in the conversation: ${status}`, () => {
    const root = setupDesignChange(setupRepo());
    writeRecord(root, `status: ${status} proof=${"a".repeat(64)}`);
    assertNoAnswerBlock(blockReason(implementationWrite(root), root), flag);
    recordAnswer(root, { unverified: flag !== "" });
    assert.equal(blockReason(implementationWrite(root), root), null);
    assert.doesNotMatch(readFileSync(recordFile(root), "utf8"), /proof=/);
  });
}

for (const [label, answerLines] of [
  ["an empty answer line", "user-answer:   "],
  ["two answer lines", "user-answer: 確認\nuser-answer: 好"],
]) {
  test(`a releasing status with ${label} does not release`, () => {
    const root = setupDesignChange(setupRepo());
    writeRecord(root, `status: user-confirmed\n${answerLines}\nchange: ${CHANGE}`);
    assertNoAnswerBlock(blockReason(implementationWrite(root), root));
  });
}

test("an answered record with no change line does not release", () => {
  const root = setupDesignChange(setupRepo());
  writeRecord(root, "status: user-confirmed\nuser-answer: 確認");
  assertNoAnswerBlock(blockReason(implementationWrite(root), root));
  recordAnswer(root);
  assert.equal(blockReason(implementationWrite(root), root), null);
});

// [Scenario: design-reasoning :: A record copied from another change does not release]
test("a record confirmed for another change and copied here does not release", () => {
  const root = setupDesignChange(setupRepo());
  const other = path.join(root, "openspec", "changes", "other-change");
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, "comprehension.md"), "status: pending\n\n## 讀者復述\n\n別的內容\n");
  recordAnswer(root, { change: "other-change" });
  writeChangeFile(root, "comprehension.md", readFileSync(path.join(other, "comprehension.md"), "utf8"));
  assertForeignChangeBlock(blockReason(implementationWrite(root), root));

  const rerun = spawnSync(process.execPath, [CONFIRM, CHANGE, "--user-answer", "確認"], { cwd: root, encoding: "utf8" });
  assert.equal(rerun.status, 1, "the copied record is not re-confirmed as this change");
  assertForeignChangeBlock(blockReason(implementationWrite(root), root));

  writeRecord(root, "status: pending");
  recordAnswer(root);
  assert.equal(blockReason(implementationWrite(root), root), null);
});

test("a record naming this change and another change does not release", () => {
  const root = setupDesignChange(setupRepo());
  writeRecord(root, `status: user-confirmed\nuser-answer: 確認\nchange: ${CHANGE}\nchange: other-change`);
  assertForeignChangeBlock(blockReason(implementationWrite(root), root));
});

test("a legacy proof line does not release even with an answer below it", () => {
  const root = setupDesignChange(setupRepo());
  writeRecord(root, `status: user-confirmed proof=${"a".repeat(64)}\nuser-answer: 確認`);
  assertNoAnswerBlock(blockReason(implementationWrite(root), root));
});

test("the record is read from the branch's own change", () => {
  const change = "other-change";
  const root = setupRepo(`feature/${change}`);
  const changeDir = path.join(root, "openspec", "changes", change);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(path.join(changeDir, "proposal.md"), PROPOSAL);
  writeFileSync(path.join(changeDir, "design.md"), "# design\n");
  writeFileSync(path.join(changeDir, "comprehension.md"), "status: pending\n\n內容\n");
  assert.ok(blockReason(implementationWrite(root), root), "pending blocks");
  recordAnswer(root, { change });
  assert.equal(blockReason(implementationWrite(root), root), null);
});

test("another change's released record does not release this branch", () => {
  const root = setupDesignChange(setupRepo());
  writeRecord(root, "status: pending");
  const other = path.join(root, "openspec", "changes", "other-change");
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, "comprehension.md"), "status: user-confirmed\nuser-answer: 確認\nchange: other-change\n");
  assertColdReadBlock(blockReason(implementationWrite(root), root));
});

test("a linked worktree reads its own record", () => {
  const root = setupDesignChange(setupLinkedWorktree());
  writeRecord(root, "status: pending");
  recordAnswer(root);
  assert.equal(blockReason(implementationWrite(root), root), null);
});

test("a blank first line does not release, even with a released record below it", () => {
  const root = setupDesignChange(setupRepo());
  writeRecord(root, "status: pending");
  recordAnswer(root);
  const released = readFileSync(recordFile(root), "utf8");
  writeChangeFile(root, "comprehension.md", `\n${released}`);
  assertColdReadBlock(blockReason(implementationWrite(root), root));
});

test("a B-mini change with design.md is gated the same way", () => {
  const root = setupRepo();
  writeChangeFile(root, "proposal-mini.md", PROPOSAL);
  writeChangeFile(root, "design.md", "# design\n");
  assertColdReadBlock(blockReason(implementationWrite(root), root));
  writeRecord(root, "status: pending");
  recordAnswer(root);
  assert.equal(blockReason(implementationWrite(root), root), null);
});

test("a checkout changing line endings does not take the release away", () => {
  const root = setupDesignChange(setupRepo());
  writeRecord(root, "status: pending");
  recordAnswer(root);
  const file = recordFile(root);
  writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
  assert.equal(blockReason(implementationWrite(root), root), null);
});

test("a record mixing line endings keeps the reader's text and releases", () => {
  const root = setupDesignChange(setupRepo());
  writeChangeFile(root, "comprehension.md", "status: pending\n\n## 讀者復述\n\n內容\r\n");
  recordAnswer(root);
  assert.match(readFileSync(recordFile(root), "utf8"), /\n## 讀者復述\n\n內容\r\n$/);
  assert.equal(blockReason(implementationWrite(root), root), null);
});

test("passes when the change has no design.md", () => {
  const root = setupRepo();
  writeChangeFile(root, "proposal.md", PROPOSAL);
  assert.equal(blockReason(implementationWrite(root), root), null);
});

test("passes a lite change: design.md without a proposal is not the full shape", () => {
  const root = setupRepo();
  writeChangeFile(root, "design.md", "# design\n");
  assert.equal(blockReason(implementationWrite(root), root, { level: "lite" }), null);
});

test("a full change named in session still blocks when the hook level says lite", () => {
  const root = setupDesignChange(setupRepo());
  assertColdReadBlock(blockReason(implementationWrite(root), root, { level: "lite" }));
});

test("rigor off skips the gate", () => {
  const root = setupDesignChange(setupRepo());
  assert.equal(blockReason(implementationWrite(root), root, { level: "off" }), null);
});

test("the change folder stays writable, otherwise the record could never be written", () => {
  const root = setupDesignChange(setupRepo());
  for (const name of ["comprehension.md", "tasks.md", "design.md"]) {
    assert.equal(
      blockReason(writeTo(root, `openspec/changes/${CHANGE}/${name}`), root),
      null,
      name,
    );
  }
});

test("notes stay writable: they are not implementation", () => {
  const root = setupDesignChange(setupRepo());
  for (const relPath of ["notes/session-pending.md", "notes/tmp/draft.md"]) {
    assert.equal(blockReason(writeTo(root, relPath), root), null, relPath);
  }
});

test("another change's folder is an implementation write, not an exempt path", () => {
  const root = setupDesignChange(setupRepo());
  assertColdReadBlock(blockReason(writeTo(root, "openspec/changes/other-change/tasks.md"), root));
});

test("a branch with no change name is out of scope", () => {
  const root = setupDesignChange(setupRepo("rules/agent-rules-v1.0.0"));
  assert.equal(blockReason(implementationWrite(root), root), null);
});

test("every target of an apply_patch is checked", () => {
  const root = setupDesignChange(setupRepo());
  const patch = [
    "*** Begin Patch",
    `*** Update File: openspec/changes/${CHANGE}/tasks.md`,
    "@@",
    "-a",
    "+b",
    "*** Update File: src/app.mjs",
    "@@",
    "-a",
    "+b",
    "*** End Patch",
  ].join("\n");
  const payload = { tool_name: "functions.apply_patch", tool_input: { input: patch } };
  assertColdReadBlock(blockReason(payload, root));
});

test("non-write tools are not gated", () => {
  const root = setupDesignChange(setupRepo());
  const payload = { tool_name: "Read", tool_input: { file_path: path.join(root, "src/app.mjs") } };
  assert.equal(blockReason(payload, root), null);
});
