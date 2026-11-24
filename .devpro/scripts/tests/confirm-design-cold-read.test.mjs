/**
 * confirm-design-cold-read.test.mjs
 *
 * The command the AI runs, after the user answers in the conversation, to
 * release Gate CR. It moves a pending record to a releasing status, quotes
 * the user's answer on one `user-answer:` line and names the change on one
 * `change:` line. No terminal, key or signature. Everything else, including a
 * record copied from another change, is refused and leaves the file untouched.
 *
 * The reading side lives in .devpro/scripts/hooks/lib/design-cold-read-record.mjs.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDesignColdReadRecordReleased } from "../hooks/lib/design-cold-read-record.mjs";
import { makeTempDir } from "./lib/tmp.mjs";

const tmpRoot = makeTempDir("confirm-design-cold-read-");
after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const SCRIPT = path.resolve(import.meta.dirname, "..", "confirm-design-cold-read.mjs");
const CHANGE = "add-sample-cold-read";
const LEGACY_PROOF = "a".repeat(64);
const CHANGE_LINE = `change: ${CHANGE}`;

let repoCounter = 0;

function git(cwd, ...args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function setupRepo(record) {
  const root = path.join(tmpRoot, `repo-${repoCounter++}`);
  const changeDir = path.join(root, "openspec", "changes", CHANGE);
  mkdirSync(changeDir, { recursive: true });
  git(root, "init", "-q");
  if (record !== undefined) writeFileSync(path.join(changeDir, "comprehension.md"), record);
  return { root, file: path.join(changeDir, "comprehension.md") };
}

function confirm(cwd, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function released(file) {
  return isDesignColdReadRecordReleased({ content: readFileSync(file, "utf8"), changeName: CHANGE });
}

test("records the user's answer under the status line and keeps everything below", () => {
  const { root, file } = setupRepo("status: pending\n\n## 讀者原文\n\n內容\n");
  const run = confirm(root, CHANGE, "--user-answer", "1 確認");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(file, "utf8"), `status: user-confirmed\nuser-answer: 1 確認\n${CHANGE_LINE}\n\n## 讀者原文\n\n內容\n`);
  assert.match(run.stdout, /status: user-confirmed/);
  assert.equal(released(file), true);
});

test("--unverified records that the user accepted the cold read as not verified", () => {
  const { root, file } = setupRepo("status: pending\n");
  assert.equal(confirm(root, CHANGE, "--unverified", "--user-answer=繼續").status, 0);
  assert.equal(readFileSync(file, "utf8"), `status: user-accepted-unverified\nuser-answer: 繼續\n${CHANGE_LINE}\n`);
  assert.equal(released(file), true);
});

// [Scenario: design-reasoning :: The confirmation command records the user's answer after the user answers in the conversation]
test("keeps the user's words and puts the answer on one line, each whitespace run becoming one space", () => {
  const { root, file } = setupRepo("status: pending\n");
  assert.equal(confirm(root, CHANGE, "--user-answer", "  確認\r\n  沒問題\t\t好，  就這樣  ").status, 0);
  assert.equal(readFileSync(file, "utf8"), `status: user-confirmed\nuser-answer: 確認 沒問題 好， 就這樣\n${CHANGE_LINE}\n`);
});

test("--unverified after the answer still applies", () => {
  const { root, file } = setupRepo("status: pending\n");
  assert.equal(confirm(root, CHANGE, "--user-answer", "繼續", "--unverified").status, 0);
  assert.equal(readFileSync(file, "utf8"), `status: user-accepted-unverified\nuser-answer: 繼續\n${CHANGE_LINE}\n`);
  assert.equal(released(file), true);
});

test("keeps CRLF line endings", () => {
  const { root, file } = setupRepo("status: pending\r\n\r\n內容\r\n");
  assert.equal(confirm(root, CHANGE, "--user-answer", "確認").status, 0);
  assert.equal(readFileSync(file, "utf8"), `status: user-confirmed\r\nuser-answer: 確認\r\n${CHANGE_LINE}\r\n\r\n內容\r\n`);
  assert.equal(released(file), true);
});

for (const [label, record, expected] of [
  [
    "an LF record with a CRLF line in the reader's text",
    "status: pending\n\n讀者原文\n結尾\r\n",
    `status: user-confirmed\nuser-answer: 確認\n${CHANGE_LINE}\n\n讀者原文\n結尾\r\n`,
  ],
  [
    "a CRLF status line over LF reader's text",
    "status: pending\r\n\r\n讀者原文\n結尾\n",
    `status: user-confirmed\r\nuser-answer: 確認\r\n${CHANGE_LINE}\r\n\r\n讀者原文\n結尾\n`,
  ],
  [
    "an answered record with mixed endings, answered again",
    "status: user-confirmed\nuser-answer: 舊的\r\nchange: add-sample-cold-read\r\n\n讀者原文\r\n",
    `status: user-confirmed\nuser-answer: 確認\n${CHANGE_LINE}\n\n讀者原文\r\n`,
  ],
  ["a record with no final line break", "status: pending", `status: user-confirmed\nuser-answer: 確認\n${CHANGE_LINE}`],
]) {
  test(`keeps every line of the reader's text: ${label}`, () => {
    const { root, file } = setupRepo(record);
    assert.equal(confirm(root, CHANGE, "--user-answer", "確認").status, 0);
    assert.equal(readFileSync(file, "utf8"), expected);
    assert.equal(released(file), true);
  });
}

test("works from a subdirectory of the repo", () => {
  const { root, file } = setupRepo("status: pending\n");
  assert.equal(confirm(path.join(root, "openspec", "changes"), CHANGE, "--user-answer", "確認").status, 0);
  assert.equal(released(file), true);
});

test("running it again with the same answer changes nothing", () => {
  const { root, file } = setupRepo("status: pending\n\n內容\n");
  assert.equal(confirm(root, CHANGE, "--user-answer", "確認").status, 0);
  const recorded = readFileSync(file, "utf8");
  const run = confirm(root, CHANGE, "--user-answer", "確認");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(file, "utf8"), recorded);
  assert.match(run.stdout, /已經是/);
});

test("running it again with a new answer keeps exactly one quoted answer", () => {
  const { root, file } = setupRepo("status: pending\n\n內容\n");
  assert.equal(confirm(root, CHANGE, "--user-answer", "確認").status, 0);
  assert.equal(confirm(root, CHANGE, "--user-answer", "改好了，確認").status, 0);
  assert.equal(readFileSync(file, "utf8"), `status: user-confirmed\nuser-answer: 改好了，確認\n${CHANGE_LINE}\n\n內容\n`);
  assert.equal(released(file), true);
});

test("a releasing status written without an answer gets the user's answer", () => {
  const { root, file } = setupRepo("status: user-confirmed\n\n內容\n");
  assert.equal(released(file), false);
  assert.equal(confirm(root, CHANGE, "--user-answer", "確認").status, 0);
  assert.equal(readFileSync(file, "utf8"), `status: user-confirmed\nuser-answer: 確認\n${CHANGE_LINE}\n\n內容\n`);
  assert.equal(released(file), true);
});

test("an answered record with no change line gets this change's name", () => {
  const { root, file } = setupRepo("status: user-confirmed\nuser-answer: 確認\n\n內容\n");
  assert.equal(released(file), false);
  assert.equal(confirm(root, CHANGE, "--user-answer", "確認").status, 0);
  assert.equal(readFileSync(file, "utf8"), `status: user-confirmed\nuser-answer: 確認\n${CHANGE_LINE}\n\n內容\n`);
  assert.equal(released(file), true);
});

// [Scenario: design-reasoning :: A record copied from another change does not release]
for (const [label, record] of [
  ["a released record", "status: user-confirmed\nuser-answer: 確認\nchange: other-change\n\n別的讀者原文\n"],
  ["a record reset to pending", "status: pending\nuser-answer: 確認\nchange: other-change\n\n別的讀者原文\n"],
  ["a record also naming this change", `status: user-confirmed\nuser-answer: 確認\n${CHANGE_LINE}\nchange: other-change\n`],
]) {
  test(`refuses ${label} copied from another change and leaves the file alone`, () => {
    const { root, file } = setupRepo(record);
    const run = confirm(root, CHANGE, "--user-answer", "確認");
    assert.equal(run.status, 1);
    assert.equal(readFileSync(file, "utf8"), record);
    assert.match(run.stderr, /change: 寫的是 other-change，不是 add-sample-cold-read/);
    assert.match(run.stderr, /為本 change 重做冷讀/);
    assert.equal(released(file), false);
  });
}

for (const [label, record, flags, expected] of [
  ["confirmed", `status: user-confirmed proof=${LEGACY_PROOF}\n\n內容\n`, [], "status: user-confirmed"],
  ["unverified", `status: user-accepted-unverified proof=${LEGACY_PROOF}\n`, ["--unverified"], "status: user-accepted-unverified"],
]) {
  test(`a legacy signed ${label} record is re-recorded with the user's answer`, () => {
    const { root, file } = setupRepo(record);
    assert.equal(released(file), false);
    assert.equal(confirm(root, CHANGE, ...flags, "--user-answer", "確認").status, 0);
    const content = readFileSync(file, "utf8");
    assert.equal(content.split("\n")[0], expected);
    assert.equal(content.split("\n")[1], "user-answer: 確認");
    assert.equal(content.split("\n")[2], CHANGE_LINE);
    assert.doesNotMatch(content, /proof=/);
    assert.equal(released(file), true);
  });
}

for (const [label, record] of [
  ["a blank first line", "\nstatus: pending\n"],
  ["an empty record", ""],
  ["an unknown status", "status: reviewing\n"],
  ["a status differing by case", "status: Pending\n"],
  ["a record released the other way", "status: user-accepted-unverified\nuser-answer: 繼續\n"],
]) {
  test(`refuses ${label} and leaves the file alone`, () => {
    const { root, file } = setupRepo(record);
    const run = confirm(root, CHANGE, "--user-answer", "確認");
    assert.equal(run.status, 1);
    assert.equal(readFileSync(file, "utf8"), record);
    assert.match(run.stderr, /status: pending/);
  });
}

test("refuses when the record does not exist and says where to run it", () => {
  const { root } = setupRepo();
  const run = confirm(root, CHANGE, "--user-answer", "確認");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /openspec\/changes\/add-sample-cold-read\/comprehension\.md/);
  assert.match(run.stderr, /worktree/);
});

test("outside a git repo it fails instead of guessing", () => {
  const dir = path.join(tmpRoot, "not-a-repo");
  mkdirSync(dir, { recursive: true });
  assert.equal(confirm(dir, CHANGE, "--user-answer", "確認").status, 1);
});

for (const [label, args] of [
  ["no change name", ["--user-answer", "確認"]],
  ["a path as the change name", ["../../etc", "--user-answer", "確認"]],
  ["an unknown flag", [CHANGE, "--force", "--user-answer", "確認"]],
  ["two change names", [CHANGE, "other", "--user-answer", "確認"]],
  ["no answer", [CHANGE]],
  ["an empty answer", [CHANGE, "--user-answer", "   "]],
  ["an answer flag with no value", [CHANGE, "--user-answer"]],
  ["a forgotten answer before --unverified", [CHANGE, "--user-answer", "--unverified"]],
  ["a forgotten answer before another answer flag", [CHANGE, "--user-answer", "--user-answer=確認"]],
  ["a forgotten answer before the change name", ["--user-answer", "--unverified", CHANGE]],
  ["two answers", [CHANGE, "--user-answer", "確認", "--user-answer=好"]],
]) {
  test(`usage error for ${label}, and the record stays as it was`, () => {
    const record = "status: pending\n";
    const { root, file } = setupRepo(record);
    const run = confirm(root, ...args);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /usage: node \.devpro\/scripts\/confirm-design-cold-read\.mjs <change> --user-answer "<user's words>" \[--unverified\]/);
    assert.equal(readFileSync(file, "utf8"), record);
    assert.equal(released(file), false);
  });
}
