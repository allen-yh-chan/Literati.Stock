import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";

const rule = readFileSync(
  sourcePath(".devpro/agent-rules/platform-migration.md"),
  "utf8",
);

test("platform migration defines compatibility-first scope", () => {
  assert.match(rule, /Migration 預設是相容性工程/);
  assert.match(rule, /維持 legacy-visible behavior/);
  assert.match(rule, /不重寫、不順手現代化、不修非阻塞 warning、不改 UI\/deployment contract/);
  assert.match(rule, /Compatibility Contract/);
  assert.match(rule, /若要改 behavior，需另開 change/);
});

test("multi-phase migration requires Program base before first PR", () => {
  assert.match(rule, /第一個 PR 前需 program tracker \+ Program base branch \+ phase dashboard/);
  assert.match(rule, /第一個 PR 前建立長期 in-progress canonical branch/);
  assert.match(rule, /phase branch 從它切出並 PR 回它/);
  assert.match(rule, /未完成 migration state 不得直壓 `main` 或綁住 BAU release/);
});

test("warning policy forbids opportunistic behavior changes", () => {
  assert.match(rule, /Warning 不是修正授權/);
  assert.match(rule, /消 warning 若改 control flow、null\/exception、serialization、async timing 或 UI state/);
  assert.match(rule, /Legacy warning \| 記錄，不修/);
  assert.match(rule, /Style \/ cleanup warning \| 不修/);
});

test("UI parity and LocalVisualReview boundaries are explicit", () => {
  assert.match(rule, /畫面「有出來」不等於 UI parity/);
  assert.match(rule, /錯誤訊息、validation、disabled\/loading、menu\/guard、iframe\/report\/download 不一致/);
  assert.match(rule, /LocalVisualReview 可驗/);
  assert.match(rule, /不可宣告 parity/);
  assert.match(rule, /不得在 frontend service 改寫 same-origin `\/api`/);
});

test("deployment contract inventory separates local smoke from integration", () => {
  assert.match(rule, /第一個 migration PR 前完成/);
  assert.match(rule, /contract 不是 implementation detail/);
  assert.match(rule, /local smoke ≠ integration parity/);
  assert.match(rule, /Evidence Gate（每層需標示）/);
});
