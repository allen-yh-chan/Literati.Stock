import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

// Working-style rules that used to live only in per-agent memory. They are soft norms (no hook can verify
// them), so this test only locks that each clause exists in its section and keeps its load-bearing wording.
const rule = read(".devpro/agent-rules/ai-autonomy.md");

function section(heading, nextHeading) {
  const start = rule.indexOf(heading);
  assert.ok(start >= 0, `missing section ${heading}`);
  const end = rule.indexOf(nextHeading, start + heading.length);
  assert.ok(end > start, `missing section ${nextHeading}`);
  return rule.slice(start, end);
}

test("回報方式 carries the plain-language, long-wait and answer-first clauses", () => {
  const reporting = section("### 回報方式", "### Unrelated Work Unit Clear");
  for (const anchor of [
    "**白話**：不只停下點，整段對話都先把場景講成白話",
    "使用者說「白話說」就用日常場景重講",
    "**長時間等待**：背景任務、審查、測試預計等超過一兩分鐘",
    "開跑那一刻先用一兩句白話說明在等什麼、大概多久",
    "這是啟動通知，不是輪詢樣本，不違反 `multi-agent-handoff.md` §Meaningful transition gate",
    "回報任何數字（測試數、digest、head SHA、輪數、byte 數）前，先對照原始輸出核對",
    "**先答問題**：使用者的訊息是問題而不是指令時，最終回覆開頭先答完並停下",
  ]) {
    assert.ok(reporting.includes(anchor), `回報方式 must state: ${anchor}`);
  }
});

test("行為邊界 Always carries the self-run, blocked-action, explicit-choice and leftover-disposition clauses", () => {
  const always = section("**Always（無例外）**", "**Ask First（必須取得使用者同意）**");
  for (const anchor of [
    "POC、探測與驗證由 agent 親自操作並回報結果，不叫使用者動手",
    "只有被 auto mode 或權限擋下的探測才停下",
    "互動指令用 `! <command>` 前綴",
    "auto mode 或權限擋下使用者已授權的動作（merge、push 等）：不繞過、不自改權限設定、不換替代路徑",
    "第一次被擋即停下，給使用者可貼的指令與放寬方式（編號選項），使用者要求重試時才原樣重試一次",
    "使用者明確選定的範圍或做法不得自改",
    "預設沿用他的選擇，不無聲替換或縮減",
    "每個遺留項都要有終局：已修、查證後附 anchor 結案，或用編號選項交使用者決定",
    "禁寫成「待評估」",
    "只有當下確實無法處理（缺授權或外部依賴）才記 session-pending，並寫明阻擋原因與解除者",
  ]) {
    assert.ok(always.includes(anchor), `Always must state: ${anchor}`);
  }
});

test("The new clauses point at rules that exist, and carry no event archaeology", () => {
  for (const pointer of ["multi-agent-handoff.md", "session-pending-lifecycle.md", "stop-point-comms.md"]) {
    assert.ok(read(`.devpro/agent-rules/${pointer}`).length > 0, pointer);
  }
  assert.ok(read(".devpro/agent-rules/multi-agent-handoff.md").includes("`Meaningful transition gate`"), "the gate the long-wait clause cites is still defined");
  const added = section("**Always（無例外）**", "**Ask First（必須取得使用者同意）**") + section("### 回報方式", "### Unrelated Work Unit Clear");
  assert.doesNotMatch(added, /#\d{3,}|20\d\d-\d\d-\d\d/, "no PR numbers or dates in rule text");
});
