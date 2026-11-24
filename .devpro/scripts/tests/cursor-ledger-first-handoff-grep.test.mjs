/**
 * Locks Cursor adapter turn-end ledger-first checklist for batch carry-forward.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const CURSOR = ".devpro/agent-rules/platform-adapters/cursor.md";

function sectionSlice(content, heading) {
  const start = content.indexOf(heading);
  assert.ok(start >= 0, `missing ${heading}`);
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? content.slice(start) : content.slice(start, start + heading.length + next);
}

test("cursor adapter has turn-end ledger-first checklist with owner=AI carry-forward", () => {
  const content = readFileSync(repoPath(CURSOR), "utf8");
  const slice = sectionSlice(content, "### Turn-end Ledger-First Checklist（Cursor；每個 final / handoff 回覆前）");

  assert.match(slice, /proposal\.md.*proposal-mini\.md/s);
  assert.match(slice, /owner=AI/);
  assert.match(slice, /commit\+PR.*只 commit/s);
  assert.match(slice, /devpro:change.*第七步/s);
  assert.match(slice, /only commit when requested/);
  assert.match(slice, /merge.*excludes/s);
  assert.match(slice, /AskFirstPending/);
});

test("cursor verification block references ledger-first anchors", () => {
  const content = readFileSync(repoPath(CURSOR), "utf8");
  assert.match(content, /Turn-end Ledger-First/);
  assert.match(content, /owner=AI/);
});
