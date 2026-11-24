// Issue #3526: the SemVer level is decided from the full commit/PR range since
// the previous version anchor, not from the current round's work only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceFile as read } from "./lib/read.mjs";

test("SemVer level is judged from the full range since the previous version anchor", () => {
  const content = read(".devpro/agent-rules/release-sit-uat-pat-prod.md");
  const start = content.indexOf("### SemVer 與 Bump 規則");
  assert.notEqual(start, -1);
  const section = content.slice(start, content.indexOf("\n### ", start + 5));
  const rows = section.split("\n").filter((line) => line.startsWith("- **SemVer 級別看完整範圍**"));
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.match(row, /MUST 列出「上一個版本錨點 → 本版要發佈的內容」之間的完整 commit／PR 清單/);
  // Consumer subset bumps branch from the tag, so the range end is the released content, not the bump base.
  assert.match(row, /subset release 是核准 subset 的全部分支（bump 分支從 tag 開，tag 到 bump 起點是空的，不能拿來判）/);
  assert.match(row, /依其中最高級別判定 MAJOR／MINOR／PATCH，MUST NOT 只看本輪工作/);
  assert.match(row, /最近的 `production-v\*`／版本 tag；沒有 tag 時，用版號檔上次變更版號的 commit/);
  assert.match(row, /給使用者版號選項時附上這份清單與各項分類/);
  // It sits next to the existing "suggest, then confirm" rule it refines.
  assert.ok(
    section.indexOf("- 須 bump 時：先建議版號並取得明確確認後才改版號欄位") <
      section.indexOf("- **SemVer 級別看完整範圍**"),
  );
});
