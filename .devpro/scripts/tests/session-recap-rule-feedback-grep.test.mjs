import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath, SOURCE_ROOT } from "./lib/repo-root.mjs";

const sessionRecap = readFileSync(
  repoPath(".devpro/agent-rules/session-recap.md"),
  "utf8",
);
const outputDiscipline = [
  repoPath("openspec/specs/output-discipline/spec.md"),
  path.join(
    SOURCE_ROOT,
    "openspec/changes/clarify-rule-feedback-disposition/specs/output-discipline/spec.md",
  ),
  path.join(
    SOURCE_ROOT,
    "openspec/changes/archive/2026-06-21-clarify-rule-feedback-disposition/specs/output-discipline/spec.md",
  ),
]
  .filter((file) => existsSync(file))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const postPrCompletion = readFileSync(
  repoPath(".devpro/agent-rules/post-pr-completion-gate.md"),
  "utf8",
);
const activeCorrectionSurfaces = [
  "AGENTS.md",
  ".devpro/agent-rules/session-recap.md",
  ".devpro/scripts/hooks/session-start.mjs",
  "openspec/specs/output-discipline/spec.md",
].map((file) => [file, readFileSync(repoPath(file), "utf8")]);

function listMarkdownFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".md") ? [fullPath] : [];
  });
}

test("session-recap has in-session correction harvest contract", () => {
  assert.match(sessionRecap, /被使用者糾正/);
  assert.match(sessionRecap, /反思/);
  assert.match(sessionRecap, /同一錯誤再犯/);
  assert.match(sessionRecap, /hook 誤判/);
  assert.match(sessionRecap, /process friction/);
  assert.match(sessionRecap, /AI 從 evidence 自行發現/);
  assert.match(sessionRecap, /hook false positive/);
  assert.match(sessionRecap, /hook false negative/);
  assert.match(sessionRecap, /hook evidence 與事實不符/);
  assert.match(sessionRecap, /In-Session Correction Log/);
  // R8 判準：session-pending 為 follow-up 載體（marker 退場）
  assert.match(sessionRecap, /notes\/session-pending\.md/);
  assert.match(sessionRecap, /當下處理不了的，立刻記進/);
  assert.match(sessionRecap, /能當下做完的就做掉、不記/);
  assert.match(sessionRecap, /當初可改善的原始缺口/);
  assert.match(sessionRecap, /待追蹤/);
  assert.match(sessionRecap, /建議落點/);
  assert.match(sessionRecap, /規範改進發落必須追蹤/);
  assert.match(sessionRecap, /Rule Feedback Issue Template/);
  assert.match(sessionRecap, /consumer repo/);
  assert.match(sessionRecap, /已發落後/);
  assert.match(sessionRecap, /Follow-up disposition/);
  assert.match(outputDiscipline, /Dispositioned marker is not re-emitted as pending/);
  assert.match(outputDiscipline, /already-covered-by-current-change/);
  assert.match(outputDiscipline, /MUST NOT append another pending `\[RULE-FEEDBACK\]` marker for the same trigger/);
});

test("active correction surfaces reference session-pending as follow-up carrier", () => {
  for (const [file, body] of activeCorrectionSurfaces) {
    assert.doesNotMatch(body, /\[CORRECTION\]/, `${file} must not retain legacy marker`);
  }
  // session-recap is the SSOT for session-pending follow-up tracking
  const recapBody = activeCorrectionSurfaces.find(([f]) => f.includes("session-recap.md"))?.[1];
  assert.match(recapBody, /notes\/session-pending\.md/, "session-recap must reference session-pending as follow-up carrier");
  assert.match(recapBody, /当下処理不了|當下處理不了/, "session-recap must contain what-to-record criterion (R8)");
});

test("session-recap requires process friction self-audit before answering rule-improvement check", () => {
  for (const phrase of [
    "Process Friction Self-Audit",
    "不得只掃",
    "OpenSpec / rule surface 反覆補改",
    "hook / gate / CLI permission / sandbox / auth / sticky fallback",
    "cross-model review",
    "最後成功",
    "one-off environment noise",
  ]) {
    assert.match(sessionRecap, new RegExp(phrase));
  }
});

test("final/goal completion responses still require explicit Next Step handoff", () => {
  for (const phrase of [
    "Final/Goal Completion Next Step Contract",
    "goal / task / PR gate 已 complete 不豁免下一步交接",
    "Next Step / handoff",
    "blocker/依賴",
    "下一個 AI-actionable step",
    "owner",
    "continuing/waiting",
    "update_goal complete",
    "不得取代 Next Step",
    "等待核准的具體動作",
  ]) {
    assert.match(sessionRecap, new RegExp(phrase));
  }

  assert.match(outputDiscipline, /Final\/Goal Completion Next Step Contract/);
  assert.match(outputDiscipline, /Completion status, green tests, `update_goal complete`, or adapter footer fields MUST NOT waive the handoff/);
  assert.match(outputDiscipline, /footer-only `AskFirstPending`, `RuntimeCaps`, or gate summary MUST NOT satisfy this requirement/);

  assert.match(postPrCompletion, /complete\/ready response 仍必須包含 handoff/);
  assert.match(postPrCompletion, /PR gate 完成不豁免 Next Step/);
});

test("own merged pending is a final-response obligation without automatic foreign adoption", () => {
  const line = sessionRecap.split("\n").find((l) => /^明確接手：/.test(l));
  assert.ok(line);
  assert.match(line, /除明確接手外，禁止跨 session／跨同分支自動提醒/);
  assert.match(line, /自己的 merged pending 仍須在 final\/completion\/handoff 前寫 Discussion/);
  assert.match(line, /阻塞時回報 branch\/change、blocker、write path、owner、continuation/);
});

test("recap hook timing is quiet until a real boundary", () => {
  const line = sessionRecap.split("\n").find((l) => /^Stop 只在/.test(l));
  assert.ok(line);
  assert.match(line, /Stop 只在真正收尾／交付／交棒檢查/);
  assert.match(line, /UserPromptSubmit 只在明確使用者結束信號檢查/);
  assert.match(line, /SessionStart 不注入 backlog、也不消耗 dedup/);
  assert.match(line, /每個 hook 最多三行.*多筆清單與完整 gate details 留檔/);
});

test("redirect interruption checkpoints active unlanded work", () => {
  for (const phrase of [
    "clear / redirect",
    "active change 尚未 commit / push / PR / merge",
    "unrelated redirect",
    "interruption",
    "MUST checkpoint",
    "current state",
    "worktree/branch",
    "validation evidence",
    "next action",
  ]) {
    assert.match(sessionRecap, new RegExp(phrase));
  }
});

test("rule feedback issue template names required fields", () => {
  for (const phrase of [
    "觸發 context",
    "observed gap",
    "suggested rule change",
    "affected rule files",
  ]) {
    assert.match(sessionRecap, new RegExp(phrase));
  }
});

test("legacy RULE_FEEDBACK artifact is not present in agent-rules", () => {
  const files = listMarkdownFiles(repoPath(".devpro/agent-rules"));
  const hits = files.filter((file) => readFileSync(file, "utf8").includes("RULE_FEEDBACK"));
  assert.deepEqual(
    hits.map((file) => path.relative(REPO_ROOT, file)),
    [],
    "RULE_FEEDBACK legacy artifact must not appear in .devpro/agent-rules",
  );
});
