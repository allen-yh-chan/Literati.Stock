import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const STEP_RULE = readFileSync(
  repoPath(".devpro/agent-rules/openspec-step-1-to-9.md"),
  "utf8"
);

test("Step 2c does not ask user when dependency candidates and main-ahead are empty", () => {
  assert.match(STEP_RULE, /候選為空且 `mainAheadCommits` 空/);
  assert.match(STEP_RULE, /no candidate dependency branches/);
  assert.match(STEP_RULE, /不得.*要求使用者回「無依賴」/);
});

test("Step 2c still asks when dependency candidates exist or user mentions dependency", () => {
  assert.match(STEP_RULE, /候選存在或需求提及未上 PROD 依賴/);
  assert.match(STEP_RULE, /附清單詢問/);
});

// A non-empty `mainAheadCommits` still has to be asked (canonical spec anchor-detection,
// "Silent Main HEAD Branching Is Forbidden"). What changed is what the ask carries: it is folded
// into the first batch-scope message, and it ships the overlap between each main-ahead commit's
// `filesTouched` and the files this change will edit, plus a recommended answer. The overlap is
// evidence for the user's answer, never a replacement for it. Test names carry the delta's
// scenario titles (anchor-detection, "Dependency Declaration Flow").
const CHANGE_SKILL = readFileSync(
  repoPath(".devpro/agent-skills/devpro-workflows/change/SKILL.md"),
  "utf8"
);
const DP_ANALYST = readFileSync(repoPath(".claude/agents/dp-analyst.md"), "utf8");

function lineContaining(text, needle) {
  const line = text.split("\n").find(candidate => candidate.includes(needle));
  assert.ok(line, `no line contains ${needle}`);
  return line;
}

const MAIN_TIP_BLOCK = lineContaining(STEP_RULE, "Main-tip dependency 處理");

test("Non-empty Content Main-tip Commits Triggers Presentation: the overlap subset is shown, capped at 10 with the total", () => {
  assert.match(MAIN_TIP_BLOCK, /非空才跑 `--main-tip`/);
  assert.match(MAIN_TIP_BLOCK, /filesTouched/);
  assert.match(MAIN_TIP_BLOCK, /有重疊的 commit/);
  assert.match(MAIN_TIP_BLOCK, /超過 10 筆只列最新 10 筆（authorDate 新→舊）並附總數/);
  // `--main-tip` keeps only the newest 50 by default, so the overlap must come from the full list
  // read from a file, never from the default output.
  assert.match(MAIN_TIP_BLOCK, /`--main-tip --limit <N>` 導到檔案再解析/);
  assert.match(MAIN_TIP_BLOCK, /N 為 `mainAheadCommits` 筆數/);
  assert.match(MAIN_TIP_BLOCK, /預設只回最新 50 筆/);
  // detect-branch-base.mjs now waits for stdout to drain, so the old "a pipe cuts at 64 KiB" claim must not come back.
  assert.doesNotMatch(MAIN_TIP_BLOCK, /64 KiB|經 pipe/);
  assert.match(MAIN_TIP_BLOCK, /`truncated: true` 時不得下「無重疊」結論/);
  assert.match(MAIN_TIP_BLOCK, /有重疊→`main` HEAD/);
});

test("No Overlapping Main-tip Commit Is Stated Explicitly: the total and the no-overlap conclusion are said, the production-tag SHA is recommended", () => {
  assert.match(MAIN_TIP_BLOCK, /無重疊時明說「共 N 筆 main 領先 commit，與本次要動的檔無重疊」/);
  assert.match(MAIN_TIP_BLOCK, /無重疊→production-tag SHA/);
  assert.match(MAIN_TIP_BLOCK, /回答由使用者做/);
});

test("Dependency Ask Shares The Batch-Scope Message: one message, no branch before the answer, and the SSOT is pointed at", () => {
  assert.match(MAIN_TIP_BLOCK, /第零步的同一則訊息（不另開一輪）/);
  assert.match(MAIN_TIP_BLOCK, /回答前不得建分支/);
  const step0 = lineContaining(CHANGE_SKILL, "條件式 main-tip 依賴題");
  assert.match(step0, /detect-branch-base\.mjs --anchor/);
  assert.match(step0, /`mainAheadCommits` 非空/);
  assert.match(step0, /`stop-point-comms.md`/);
  assert.match(step0, /openspec-step-1-to-9\.md/);
  assert.match(step0, /回答前不得建分支/);
});

test("Dependency Ask Stands Alone When Batch Scope Was Pre-Answered: no batch-scope message means the ask is made on its own before the branch", () => {
  assert.match(MAIN_TIP_BLOCK, /第零步沒有發問時（請求已明說 batch\／stepwise），在建分支前單獨問/);
  const step0 = lineContaining(CHANGE_SKILL, "條件式 main-tip 依賴題");
  assert.match(step0, /請求已明說 batch\／stepwise 而第零步不發問時，在建分支前單獨問/);
  assert.match(step0, /證據同樣附上/);
  // Step 3 point 5 restates the same ask, so it must not say "same message" without the stand-alone case.
  const step5 = lineContaining(CHANGE_SKILL, "**分支依賴確認**");
  assert.match(step5, /併入第零步同一則訊息（第零步未發問時在建分支前單獨問）/);
});

test("Overlap Evidence Is A Recommendation: the answer stays the user's, and the analyst label is a suggestion", () => {
  assert.match(MAIN_TIP_BLOCK, /建議只是預設值，回答由使用者做/);
  assert.match(MAIN_TIP_BLOCK, /不得以重疊證據代替回答/);
  assert.match(MAIN_TIP_BLOCK, /decisions（lite：PR `## Change Context`）/);
  const rationalization = lineContaining(STEP_RULE, "main-tip commits 不影響我的 change");
  assert.match(rationalization, /仍須先問/);
  assert.match(rationalization, /重疊證據只能當建議選項、不能代替回答/);
  assert.match(rationalization, /禁靜默 branch from main HEAD/);
  const analyst = lineContaining(DP_ANALYST, "main-tip commits**：");
  assert.match(analyst, /`\(depend\)` \/ `\(no depend\)` \/ `\(unclear — ask user\)`/);
  assert.match(analyst, /`filesTouched`/);
  assert.match(analyst, /建議標註，不是已確認依賴/);
  assert.match(analyst, /openspec-step-1-to-9\.md/);
  // The analyst reads its own agent file, so the full-list retrieval must be stated there too.
  assert.match(analyst, /`--main-tip --limit <N>`（取法同 Step 2c，導到檔案再解析，預設只回最新 50 筆）/);
  // The brd output template carries the same three labels, so a reader of the brd sees the label as a suggestion too.
  const template = lineContaining(DP_ANALYST, "main-tip commits**（若有）");
  assert.match(template, /\(depend \/ no depend \/ unclear — ask user\)/);
  assert.match(template, /建議標註/);
});

test("Refs Moved After The Ask Re-Asks: fetch is followed by a fresh ask when the anchor SHA or the main-ahead commits changed", () => {
  assert.match(MAIN_TIP_BLOCK, /fetch 後 anchor SHA 或 `mainAheadCommits` 與發問時不同→以新證據重問/);
  const step5 = lineContaining(CHANGE_SKILL, "**分支依賴確認**");
  assert.match(step5, /必須詢問是否依賴 content-level main-ahead commits/);
  assert.match(step5, /第零步已取得回答，且 fetch 後重跑 `--anchor` 的 anchor SHA 與 `mainAheadCommits` 未變才不重問/);
  assert.match(step5, /有變動就附新證據重問/);
  assert.match(step5, /openspec-step-1-to-9\.md/);
});
