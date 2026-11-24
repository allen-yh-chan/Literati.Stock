/**
 * hook-stop-transcript-role-shape.test.mjs
 *
 * Stop hooks that read the last assistant message from the host transcript must
 * understand the real transcript line shape: the role lives under `message.role`
 * (the line's own top-level `type` is "assistant" and there is no top-level
 * `role`), one content block per line. A top-level `role` is the older shape and
 * stays accepted. Before the shared reader, stop-handoff-cite.mjs and
 * recap-check.mjs only looked at a top-level `role`, so on the real shape they saw
 * an empty message and neither gate could fire.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "./lib/tmp.mjs";
import { repoFileUrl, repoPath } from "./lib/repo-root.mjs";
import { resolveReminderSession, reminderSessionDir } from "../hooks/lib/session-reminder.mjs";

const { lastAssistantMessageText, TRANSCRIPT_MAX_BYTES } = await import(
  repoFileUrl(".devpro/scripts/hooks/lib/transcript-message.mjs")
);
const HANDOFF_CITE = repoPath(".devpro/scripts/hooks/stop-handoff-cite.mjs");
const RECAP_CHECK = repoPath(".devpro/scripts/hooks/recap-check.mjs");

// Real Claude Code line shapes (keys trimmed to the ones that matter here).
const nestedAssistantText = (text) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const nestedAssistantToolUse = () => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
});
const nestedUserText = (text) => ({ type: "user", message: { role: "user", content: text } });
const nestedUserToolResult = () => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
});

function writeTranscript(dir, lines, raw = false) {
  const file = path.join(dir, "transcript.jsonl");
  writeFileSync(file, raw ? lines : lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

function withTmp(fn) {
  const dir = makeTempDir("stop-transcript-role-shape-");
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── shared reader ───────────────────────────────────────────────────────────

test("reader: nested message.role assistant line is read", () =>
  withTmp((dir) => {
    const file = writeTranscript(dir, [nestedUserText("hi"), nestedAssistantText("最後一則")]);
    assert.equal(lastAssistantMessageText(file), "最後一則");
  }));

test("reader: legacy top-level role assistant line is still read", () =>
  withTmp((dir) => {
    const file = writeTranscript(dir, [{ role: "assistant", content: [{ type: "text", text: "舊格式" }] }]);
    assert.equal(lastAssistantMessageText(file), "舊格式");
  }));

test("reader: a string content under message is read", () =>
  withTmp((dir) => {
    const file = writeTranscript(dir, [{ type: "assistant", message: { role: "assistant", content: "純字串" } }]);
    assert.equal(lastAssistantMessageText(file), "純字串");
  }));

test("reader: tool_use-only and user lines never replace the last assistant text", () =>
  withTmp((dir) => {
    const file = writeTranscript(dir, [
      nestedAssistantText("先說明"),
      nestedAssistantToolUse(),
      nestedUserToolResult(),
      nestedUserText("使用者後來說的話"),
    ]);
    assert.equal(lastAssistantMessageText(file), "先說明");
  }));

test("reader: the latest assistant text wins over an earlier one", () =>
  withTmp((dir) => {
    const file = writeTranscript(dir, [nestedAssistantText("第一"), nestedUserText("x"), nestedAssistantText("第二")]);
    assert.equal(lastAssistantMessageText(file), "第二");
  }));

test("reader: a user line whose text looks like an assistant reply is ignored", () =>
  withTmp((dir) => {
    const file = writeTranscript(dir, [nestedUserText("release flow 請先處理")]);
    assert.equal(lastAssistantMessageText(file), "");
  }));

test("reader: broken lines are skipped; missing, empty and oversized files give an empty string", () =>
  withTmp((dir) => {
    const broken = writeTranscript(dir, "not json\n" + JSON.stringify(nestedAssistantText("可讀")) + "\n{oops\n", true);
    assert.equal(lastAssistantMessageText(broken), "可讀");
    assert.equal(lastAssistantMessageText(path.join(dir, "absent.jsonl")), "");
    assert.equal(lastAssistantMessageText(""), "");
    const big = path.join(dir, "big.jsonl");
    writeFileSync(big, " ".repeat(TRANSCRIPT_MAX_BYTES + 1), "utf8");
    assert.equal(lastAssistantMessageText(big), "");
  }));

// ── stop-handoff-cite.mjs on the real shape ─────────────────────────────────

function runHandoffCite(transcriptPath) {
  return spawnSync(process.execPath, [HANDOFF_CITE], {
    input: JSON.stringify({ transcript_path: transcriptPath }),
    encoding: "utf8",
    env: { ...process.env },
  });
}

test("stop-handoff-cite: real-shape last message with a handoff keyword and no cite blocks", () =>
  withTmp((dir) => {
    const file = writeTranscript(dir, [
      nestedUserText("開始"),
      nestedAssistantText("Please start the release flow when you are ready. The steps are straightforward."),
      nestedAssistantToolUse(),
    ]);
    const result = runHandoffCite(file);
    assert.equal(result.status, 2, `stderr: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).decision, "block");
  }));

test("stop-handoff-cite: real-shape last message with the cite passes", () =>
  withTmp((dir) => {
    const file = writeTranscript(dir, [
      nestedAssistantText("The release flow should proceed per release-sit-uat-pat-prod.md:42 for the next step."),
    ]);
    const result = runHandoffCite(file);
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "");
  }));

// ── recap-check.mjs on the real shape ───────────────────────────────────────

function makeCurrentBranchBin(root, branch, existingBranches) {
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const branchListCases = existingBranches.flatMap((existing) => [
    `if [ "$1" = "branch" ] && [ "$2" = "--list" ] && [ "$3" = ${JSON.stringify(existing)} ]; then`,
    `  printf '%s\\n' ${JSON.stringify(`  ${existing}`)}`,
    "  exit 0",
    "fi",
  ]);
  const gitShim = [
    "#!/bin/sh",
    'if [ "$1" = "branch" ] && [ "$2" = "--show-current" ]; then',
    `  printf '%s\\n' ${JSON.stringify(branch)}`,
    "  exit 0",
    "fi",
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--short" ] && [ "$3" = "HEAD" ]; then',
    '  printf "%s\\n" "abcdef1"',
    "  exit 0",
    "fi",
    ...branchListCases,
    'printf ""',
    "exit 0",
  ].join("\n");
  const ghShim = [
    "#!/bin/sh",
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf ""; exit 0; fi',
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then printf "%s\\n" "devpro-agent-rules"; exit 0; fi',
    'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
    '  printf "%s\\n" \'{ "nodes": [], "pageInfo": { "hasNextPage": false } }\'',
    "  exit 0",
    "fi",
    'printf ""',
    "exit 0",
  ].join("\n");
  for (const [name, body] of [["git", gitShim], ["gh", ghShim]]) {
    const p = path.join(binDir, name);
    writeFileSync(p, body, "utf8");
    chmodSync(p, 0o755);
  }
  return binDir;
}

function runRecapCheck(dir, transcriptPath, currentBranch, pendingBranch) {
  const session = resolveReminderSession({session_id: 'role-shape'}, {DEVPRO_HOOK_HOST: 'test'});
  const scopedRoot = path.join(dir, 'scoped');
  const sessionDir = path.join(scopedRoot, session.key);
  mkdirSync(sessionDir, {recursive: true});
  writeFileSync(path.join(sessionDir, 'recap-work.json'), JSON.stringify([
    {sessionKey: session.key, branch: pendingBranch, changeName: pendingBranch.replace(/^[a-z]+\//, ''), prNumber: '1', merged: true, classification: 'B'},
  ]));
  const result = spawnSync(process.execPath, [RECAP_CHECK], {
    input: JSON.stringify({transcript_path: transcriptPath, session_id: session.sessionId, cwd: dir}),
    encoding: 'utf8',
    env: {...process.env, DEVPRO_HOOK_HOST: 'test', DEVPRO_SESSION_REMINDER_STATE_DIR: scopedRoot, DEVPRO_RECAP_WRITTEN_DIR: path.join(dir, 'written')},
  });
  const lines = readFileSync(path.join(sessionDir, 'recap.log'), 'utf8').trim().split('\n');
  return {result, entry: JSON.parse(lines.at(-1))};
}

test("recap-check: real-shape non-boundary message on a work branch suppresses the merged backlog", () =>
  withTmp((dir) => {
    const file = writeTranscript(dir, [
      nestedAssistantText("我會先修 hook gate，接著跑 focused tests。"),
      nestedAssistantToolUse(),
    ]);
    const { result, entry } = runRecapCheck(dir, file, "chore/fix-current-hook-timing", "chore/historical-merged-recap");
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.equal(entry.merged_suppressed_reason, "active-work-non-boundary");
    assert.equal(entry.merged_pending_count, 0);
  }));

test("recap-check: real-shape completion message on a work branch still surfaces the merged backlog", () =>
  withTmp((dir) => {
    const file = writeTranscript(dir, [nestedAssistantText("本次工作已完成，接著收尾並處理剩餘 Recap。")]);
    const { result, entry } = runRecapCheck(dir, file, "chore/fix-current-hook-timing", "chore/historical-merged-recap");
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.equal(entry.merged_suppressed_reason, null);
    assert.equal(entry.merged_pending_count, 1);
  }));
