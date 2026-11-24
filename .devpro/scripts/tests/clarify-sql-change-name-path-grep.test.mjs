/**
 * clarify-sql-change-name-path-grep.test.mjs
 *
 * B-mini chore clarify-sql-change-name-path (#1906):
 * Lock FR-1/2/3 phrases in database-conventions.md and the FR-5
 * checklist one-liner (no sql/feature/ branch-type nest).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readRepoFile as read } from "./lib/read.mjs";



test("database-conventions.md defines change-name ≠ full branch", () => {
  const body = read(".devpro/agent-rules/database-conventions.md");
  assert.match(body, /OpenSpec change 邏輯名/);
  assert.match(body, /feature\/<change-name>/);
  assert.ok(body.includes("≠"), "must state change-name ≠ full branch");
});

test("database-conventions.md forbids sql/feature/ branch-type nest", () => {
  const body = read(".devpro/agent-rules/database-conventions.md");
  assert.match(body, /sql\/feature\/<change-name>\//);
  assert.match(body, /MUST NOT[\s\S]{0,80}feature\/[\s\S]{0,40}bugfix\//);
});

test("database-conventions.md carries reuse／碰撞 guidance", () => {
  const body = read(".devpro/agent-rules/database-conventions.md");
  assert.match(body, /reuse|復用/);
  assert.match(body, /continuum|同 change continuum/);
  assert.match(body, /新 unique change-name|新語意/);
});

test("code-review-checklist.md DB schema row flags sql/feature/ branch-type", () => {
  const body = read(".devpro/agent-rules/code-review-checklist.md");
  const row = body.split("\n").find((l) => l.includes("涉及 DB schema 變更"));
  assert.ok(row, "DB schema checklist row missing");
  assert.ok(row.includes("sql/feature/"), "checklist row must mention sql/feature/");
  assert.ok(row.includes("branch-type"), "checklist row must mention branch-type");
});
