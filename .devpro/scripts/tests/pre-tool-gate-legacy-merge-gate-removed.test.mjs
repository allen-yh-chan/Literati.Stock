import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const gatePath = repoPath(".devpro/scripts/hooks/pre-tool-gate.mjs");
const gate = readFileSync(gatePath, "utf8");

test("legacy transcript merge gate stays removed", () => {
  assert.doesNotMatch(gate, /function\s+checkMergeGate\b/);
  assert.doesNotMatch(gate, /\bPRE_PR_EVIDENCE_PATTERNS\b/);
  assert.doesNotMatch(gate, /\bLEGACY_SYNC_CHORE_RE\b/);
  assert.doesNotMatch(gate, /transcriptHasPrePrEvidence\b/);
});

test("cleanup command parser stays out of PreToolUse", () => {
  assert.doesNotMatch(gate, /function\s+checkBranchDeletionProdGate\b/);
  assert.doesNotMatch(gate, /function\s+checkWorktreeRemoveProdGate\b/);
  assert.doesNotMatch(gate, /function\s+extractBranchDeletionTarget\b/);
  assert.doesNotMatch(gate, /function\s+extractWorktreeRemoveTarget\b/);
  assert.doesNotMatch(gate, /<gh-pr-source-branch>/);
});
