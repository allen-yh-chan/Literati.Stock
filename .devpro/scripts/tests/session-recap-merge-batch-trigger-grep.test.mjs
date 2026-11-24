import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
// Locks the §收尾 Gate clarify (PR clarify-recap-gate-merge-batch-completion-trigger):
// reporting a completed merge-batch + offering next-step options counts as a
// completion-semantic reply that triggers the Recap Gate. The mechanical reminder
// system (recap-check.mjs / user-prompt-gate.mjs / recap-utils.mjs) was already
// correct; the gap was the TL/agent layer self-waiving the always-on Gate. This
// grep test prevents the clarifying anchors from being silently deleted.

const sessionRecap = readFileSync(
  repoPath(".devpro/agent-rules/session-recap.md"),
  "utf8",
);
const userPromptGate = readFileSync(
  repoPath(".devpro/scripts/hooks/user-prompt-gate.mjs"),
  "utf8",
);

// Phrases are matched as literal substrings (some contain regex metachars like
// `+`), so escape before building the RegExp.
function literalRe(s) {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("§收尾 Gate names merge-batch completion + next-step options as completion-semantic", () => {
  for (const phrase of [
    "completion-語意涵蓋",
    "報任務完成 + 給收尾選項",
    "等同",
    "completion-語意回覆，照樣觸發本 Gate",
    "explicitly-requested task done",
    "session done 可免 Recap",
    "always-on 收尾 Gate",
    "沒宣告 session 結束",
    "merge 批次告一段落即命中觸發條件 #1",
  ]) {
    assert.match(sessionRecap, literalRe(phrase));
  }
});

test("Common Rationalizations rebuts the 'only providing options' excuse", () => {
  // The rationalization-table row must pair the excuse with its rebuttal.
  assert.match(
    sessionRecap,
    /我只是報任務完成 \+ 提供選項，沒宣告 session 結束/,
    "rationalization excuse phrasing must be present",
  );
  assert.match(
    sessionRecap,
    /給收尾選項（清 worktree \/ follow-up \/ 停）就是 completion-語意/,
    "rebuttal must state that reporting done + offering cleanup options is completion-semantic",
  );
  assert.match(
    sessionRecap,
    /不因「只是選項」豁免/,
    "rebuttal must deny the 'just options' waiver",
  );
});

test("UserPromptSubmit checks merged recap backlog only on explicit end intent", () => {
  assert.match(
    userPromptGate,
    /const merged = hasEndIntent \? await evaluateMergedRecapPending\(\{cwd, session\}\)/,
    "UserPromptSubmit must not scan merged recap backlog on arbitrary user prompts",
  );
  assert.doesNotMatch(
    userPromptGate,
    /SessionStart covers\s+\/\/ cross-session entry/,
    "SessionStart must never act as a cross-session backlog surface",
  );
  assert.doesNotMatch(
    userPromptGate,
    /即使無 intent \/ end signal，仍需檢查 merged-pending/,
    "legacy every-prompt merged-pending wording must not return",
  );
});
