import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
function read(relPath) {
  const fullPath = repoPath(relPath);
  assert.ok(existsSync(fullPath), `${relPath} must exist`);
  return readFileSync(fullPath, "utf8");
}

function assertHas(content, pattern, label) {
  assert.match(content, pattern, `consumer-failure-playbook.md must mention ${label}`);
}

test("consumer failure playbook exists and is routable from root docs", () => {
  assert.match(read("AGENTS.md"), /consumer\/rules lane\/Program Issue\/doctor\/smoke\/fail\|`consumer-adoption\.md`/);
  assert.match(read(".devpro/agent-rules/consumer-adoption.md"), /consumer-failure-playbook\.md/);
  assert.match(read("README.md"), /consumer-failure-playbook\.md/);
  read(".devpro/agent-rules/consumer-failure-playbook.md");
});

test("consumer failure playbook covers the 10 required failure anchors", () => {
  const playbook = read(".devpro/agent-rules/consumer-failure-playbook.md");

  const cases = [
    ["dirty tree", /dirty (?:tree|worktree)/i],
    ["rules pointer pollution", /rules pointer pollution/i],
    ["PR DIRTY / CONFLICTING", /PR\s+DIRTY\s*\/\s*CONFLICTING/i],
    ["hook false positive", /hook false positive/i],
    ["no CI / no checks", /no CI\s*\/\s*no checks/i],
    ["gh unavailable/auth", /`?gh`? unavailable(?:\/auth| or unauthenticated)/i],
    ["missed archive", /(?:missed archive|archive missed)/i],
    ["generated AGENTS drift", /generated AGENTS drift/i],
    ["submodule sync drift", /submodule sync drift/i],
    ["cross-model sticky stale/unavailable", /cross-model sticky stale\/unavailable/i],
  ];

  for (const [label, pattern] of cases) {
    assertHas(playbook, pattern, label);
  }
});

test("consumer failure playbook includes diagnostic, owner, and fail-closed columns", () => {
  const playbook = read(".devpro/agent-rules/consumer-failure-playbook.md");

  assertHas(playbook, /first (?:diagnostic )?check/i, "first check");
  assertHas(playbook, /owner route/i, "owner route");
  assertHas(playbook, /fail-closed next action/i, "fail-closed next action");
});

test("consumer failure playbook includes key command anchors", () => {
  const playbook = read(".devpro/agent-rules/consumer-failure-playbook.md");

  const commands = [
    "git status --short",
    "sync-agent-rules.mjs --check",
    "devpro-doctor.mjs --consumer-smoke",
    "/devpro:cross-review <PR#>",
    "DEVPRO_HOOK_BYPASS=1",
  ];

  for (const command of commands) {
    assert.ok(playbook.includes(command), `consumer-failure-playbook.md must include \`${command}\``);
  }
});

test("consumer failure playbook triage table has stable markers and complete rows", () => {
  const playbook = read(".devpro/agent-rules/consumer-failure-playbook.md");
  const start = "<!-- consumer-failure-playbook:triage:start -->";
  const end = "<!-- consumer-failure-playbook:triage:end -->";
  const startIndex = playbook.indexOf(start);
  const endIndex = playbook.indexOf(end);

  assert.ok(startIndex >= 0, "triage table start marker must exist");
  assert.ok(endIndex > startIndex, "triage table end marker must follow start marker");

  const block = playbook.slice(startIndex + start.length, endIndex);
  const rows = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !/^\|\s*-+/.test(line));

  assert.ok(rows.length > 1, "triage table must include header plus data rows");
  assert.match(rows[0], /Failure\s*\|\s*First check\s*\|\s*Owner route\s*\|\s*Fail-closed next action/);

  for (const row of rows.slice(1)) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 4, `row must have four cells: ${row}`);
    for (const cell of cells) {
      assert.notEqual(cell, "", `row cells must be non-empty: ${row}`);
    }
  }
});
