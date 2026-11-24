import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



function activeOrArchivedChangePath(fileName) {
  const active = `openspec/changes/add-ai-system-design-patterns/${fileName}`;
  if (existsSync(repoPath(active))) return active;

  const archiveRoot = repoPath("openspec/changes/archive");
  const match = readdirSync(archiveRoot)
    .filter((entry) => entry.endsWith("-add-ai-system-design-patterns"))
    .sort()
    .at(-1);
  assert.ok(match, "archived add-ai-system-design-patterns change missing");
  return `openspec/changes/archive/${match}/${fileName}`;
}

test("ai-autonomy contains agent runtime protection and retry taxonomy anchors", () => {
  const content = read(".devpro/agent-rules/ai-autonomy.md");
  for (const phrase of [
    "Agent Runtime Protection",
    "same `(tool, args/failure)`",
    "pivot",
    "Retryable",
    "Non-retryable",
    "error_max_turns",
    "max-turns",
    "bounded retry",
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("design-core contains conditional agentic workflow and write-capable tool controls", () => {
  const content = read(".devpro/agent-rules/design-core.md");
  for (const phrase of [
    "Agentic Workflow Layer Check",
    "planner",
    "executor",
    "tool surface",
    "state/checkpoint",
    "error recovery",
    "security/HITL",
    "allowlist",
    "least privilege",
    "quota/budget",
    "audit trail",
    "kill switch",
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("code-review checklist contains trajectory sanity anchors", () => {
  const content = read(".devpro/agent-rules/code-review-checklist.md");
  for (const phrase of [
    "Trajectory sanity",
    "wrong execution surface",
    "repeated failed commands",
    "unsafe retry",
    "permission/schema fault",
    "budget exhaustion",
    "error_max_turns",
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("knowledge digest records source decisions and exclusions", () => {
  const digest = read(activeOrArchivedChangePath("knowledge-digest.md"));
  for (const phrase of [
    "# Knowledge Digest",
    "refs/ai-system-design-guide-main",
    "adopt-rewrite",
    "defer",
    "mine-only",
    "Do not copy",
    "Trajectory-aware evaluation",
  ]) {
    assert.match(digest, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
