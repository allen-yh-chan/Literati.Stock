/**
 * Grep anchors for enforce-deferred-sibling-live-carrier (#2492).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

const ANCHOR = "Deferred sibling live carrier（#2492）";

test("session-pending-lifecycle owns deferred sibling live carrier (#2492)", () => {
  const body = read(".devpro/agent-rules/session-pending-lifecycle.md");
  assert.match(body, /Deferred sibling live carrier（#2492）/);
  assert.match(body, /MUST NOT[\s\S]*只[\s\S]*Non-goals/);
  assert.match(body, /session-pending\.md|H2/);
  assert.match(body, /Non-goals-only/);
});

test("openspec-quality forbids Non-goals-only deferred sibling (#2492)", () => {
  const body = read(".devpro/agent-rules/openspec-quality-and-formats.md");
  assert.match(body, new RegExp(ANCHOR.replace(/[（）#]/gu, "\\$&")));
  assert.match(body, /live (tracking )?carrier|live carrier/i);
});

test("proposal-template deferred Owner\/Next Step requires live carrier (#2492)", () => {
  const body = read(".devpro/agent-rules/proposal-template.md");
  assert.match(body, new RegExp(ANCHOR.replace(/[（）#]/gu, "\\$&")));
  assert.match(body, /deferred|moved-to-issue/);
  assert.match(body, /Owner \/ Next Step|Owner\/Next Step/);
});

test("program-tracker-mode requires dashboard\/Backlog for deferred sibling (#2492)", () => {
  const body = read(".devpro/agent-rules/program-tracker-mode.md");
  assert.match(body, new RegExp(ANCHOR.replace(/[（）#]/gu, "\\$&")));
  assert.match(body, /dashboard|Backlog|sub-issue/i);
});
