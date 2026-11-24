import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const agents = readFileSync(repoPath("AGENTS.md"), "utf8");
const designCore = readFileSync(repoPath(".devpro/agent-rules/design-core.md"), "utf8");

// polarity-sensitive：additive-only／不可放寬 必須與 AGENTS.local.md 同一物理行綁定
// （禁 decoupled includes，見 rule-anchor-guard-strength.md）
const overlayPolarityClause =
  /`AGENTS\.local\.md`[^\n]*additive-only[^\n]*不可放寬/;

// structural index row → consumer-local-rules.md（獨有列措辭，避他行代償）
const overlayIndexRowClause =
  /\|consumer overlay／local rules\|`consumer-local-rules\.md`\|/;

const OVERLAY_OPERATIVE_ANCHORS = [
  { name: "overlay polarity preamble", rx: overlayPolarityClause },
  { name: "overlay index row", rx: overlayIndexRowClause },
];

test("AGENTS.md exposes consumer hot path before the trigger table", () => {
  const triggerIndex = agents.match(/## 觸發式載入索引[\s\S]*?\n---/);

  assert.ok(triggerIndex, "AGENTS.md must keep the trigger-load index section");
  assert.match(triggerIndex[0], /Consumer：[^|\n]*feat\/bug→OpenSpec/);
  assert.match(triggerIndex[0], /PR→pre-pr/);
  assert.match(triggerIndex[0], /sync→doctor\/smoke/);
  assert.match(triggerIndex[0], /fail→playbook/);
});

test("AGENTS.md keeps the three consumer max prohibitions visible", () => {
  assert.match(agents, /三禁：/);
  assert.match(agents, /禁main\/prod改/);
  assert.match(agents, /禁rules-sync污染feature/);
  assert.match(agents, /PR前測試\/archive\/security\/PII\/SQL/);
});

test("AGENTS.md still routes source-maintainer work through trigger-loaded leaves", () => {
  assert.match(agents, /設計 rule\/hook\/cmd\/agent\/skill/);
  assert.match(agents, /設計 rule\/hook\/cmd\/agent\/skill\|`design-core\.md`/);
  assert.match(designCore, /Load-chain/);
  assert.match(designCore, /rule-design-principles\.md/);
  assert.match(agents, /source release/);
  assert.match(agents, /release-sit-uat-pat-prod\.md/);
});

test("AGENTS.md binds overlay polarity on one physical line", () => {
  assert.match(
    agents,
    overlayPolarityClause,
    "期望 `AGENTS.local.md` + additive-only + 不可放寬 同一物理行綁定 — 若拆行或刪極性詞，overlay 契約可被誤讀成可放寬 source"
  );
});

test("AGENTS.md indexes consumer-local-rules.md for overlay", () => {
  assert.match(
    agents,
    overlayIndexRowClause,
    "期望觸發索引列 consumer overlay／local rules → `consumer-local-rules.md` — 合法出口 leaf 入口不可靜默移除"
  );
});

test("meta: deleting each overlay anchor fails exactly one new assertion", () => {
  const lines = agents.split("\n");
  for (const { name, rx } of OVERLAY_OPERATIVE_ANCHORS) {
    const hitIdxs = lines
      .map((line, i) => [i, line])
      .filter(([, line]) => rx.test(line))
      .map(([i]) => i);
    assert.equal(
      hitIdxs.length,
      1,
      `mutation 審計失敗：anchor「${name}」命中 ${hitIdxs.length} 行（期望恰 1）— token 組合非獨有，可能被他行代償`
    );
    const removed = lines.filter((_, i) => i !== hitIdxs[0]).join("\n");
    const failed = OVERLAY_OPERATIVE_ANCHORS.filter(({ rx: check }) => !check.test(removed));
    assert.equal(
      failed.length,
      1,
      `mutation 審計失敗：刪「${name}」命中行後失敗斷言數=${failed.length}（期望恰 1）；失敗=[${failed.map((f) => f.name).join(", ")}]`
    );
    assert.equal(
      failed[0].name,
      name,
      `mutation 審計失敗：刪「${name}」應只讓該斷言轉紅，實際轉紅的是「${failed[0].name}」`
    );
  }
});
