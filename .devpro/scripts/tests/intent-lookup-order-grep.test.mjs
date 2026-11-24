/**
 * intent-lookup-order-grep.test.mjs
 *
 * Locks the "Intent Lookup Order" anchors in openspec-flow.md so a future edit
 * cannot silently drop the fixed lookup order for understanding existing
 * behavior:
 *   (a) current behavior → specs/<capability>/spec.md (NOT archive grep)
 *   (a2) system feature design / current design / intended behavior questions
 *        route to specs/** before answering canonical/current intended behavior
 *   (b) why / correction history → git log/blame + PR as index, archive folder
 *       only as the terminal read (NOT a grep starting point)
 *   (c) both take precedence over reverse-engineering from implementation
 *   (d) user-corrected requirements MUST be marked in the Requirement Ledger
 *   (e) missing canonical specs bound the answer to observed/inferred behavior
 *   (f) correction lifecycle distinguishes session-pending staging from durable
 *       Requirement Ledger tagging, and keeps forward requests untagged
 *
 * 目的：防止把「查 intent 從 spec/ 起、archive 只當終點」的強制順序退化回
 * 「無差別掃 archive」或「從 hook 反推」的舊行為。
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const openspecFlowPath = repoPath(".devpro/agent-rules/openspec-flow.md");
const siblingLeafPath = repoPath(".devpro/agent-rules/intent-lookup-order.md");
const outputDisciplineSpecPath = repoPath("openspec/specs/output-discipline/spec.md");
const content = readFileSync(openspecFlowPath, "utf8");
const siblingContent = readFileSync(siblingLeafPath, "utf8");
const outputDisciplineSpec = readFileSync(outputDisciplineSpecPath, "utf8");

test("openspec-flow.md entry leaf 含「Intent Lookup Order」精簡指標 + 指向 sibling", () => {
  assert.ok(
    content.includes("Intent Lookup Order") &&
      content.includes("intent-lookup-order.md"),
    "openspec-flow.md 期望含「Intent Lookup Order」精簡指標並指向 `intent-lookup-order.md` sibling，未找到 — entry leaf 指標或 Load-chain 可能被移除"
  );
});

test("intent-lookup-order.md sibling leaf 存在且含完整三步順序", () => {
  assert.ok(
    siblingContent.includes("current behavior") &&
      siblingContent.includes("openspec/specs/<capability>/spec.md") &&
      siblingContent.includes("git log") &&
      siblingContent.includes("git blame") &&
      siblingContent.includes("user correction"),
    "intent-lookup-order.md 期望含完整三步順序（current→specs、why→git/PR、user correction 配套），未找到 — sibling leaf 內容可能退化"
  );
});

test("correction lifecycle 錨點：session-pending 只是暫存，durable tag 在 Requirement Ledger，forward request 不誤標 correction", () => {
  assert.ok(
    content.includes("correction 生命週期") &&
      content.includes("intent-lookup-order.md"),
    "openspec-flow.md Load-chain 期望指向 intent-lookup-order.md 承載 correction lifecycle 辨析，未找到"
  );
  assert.ok(
    siblingContent.includes("## Correction Lifecycle") &&
      siblingContent.includes("notes/session-pending.md") &&
      siblingContent.includes("Requirement Ledger") &&
      siblingContent.includes("user correction") &&
      siblingContent.includes("forward request"),
    "intent-lookup-order.md 期望辨析 correction lifecycle：session-pending 暫存、Requirement Ledger durable tag、forward request 不誤標 correction，未找到"
  );
});

test("current behavior 錨點：查現狀導向 specs/<capability>/spec.md", () => {
  assert.ok(
    content.includes("current behavior") &&
      content.includes("openspec/specs/**") &&
      content.includes("openspec/specs/<capability>/spec.md"),
    "期望含「current behavior → openspec/specs/<capability>/spec.md」錨點，未找到"
  );
});

test("design intent 問題錨點：system feature design/current design/intended behavior 強制查 specs/**", () => {
  assert.ok(
    content.includes("系統功能設計") &&
      content.includes("system feature design") &&
      content.includes("current design") &&
      content.includes("intended behavior") &&
      content.includes("current contract") &&
      content.includes("openspec/specs/**"),
    "openspec-flow.md entry leaf 期望把系統功能設計/system feature design/current design/intended behavior/current contract 路由到 openspec/specs/**，未找到"
  );
  assert.ok(
    siblingContent.includes("系統功能設計") &&
      siblingContent.includes("system feature design") &&
      siblingContent.includes("current design") &&
      siblingContent.includes("intended behavior") &&
      siblingContent.includes("current contract") &&
      siblingContent.includes("openspec/specs/**"),
    "intent-lookup-order.md sibling leaf 期望完整承載 design-intent trigger + openspec/specs/** lookup，未找到"
  );
});

test("no-spec fallback 錨點：無 canonical spec 只能回答 observed/inferred，不宣稱 intended", () => {
  assert.ok(
    content.includes("no canonical OpenSpec spec found") &&
      content.includes("observed/inferred") &&
      content.includes("MUST NOT") &&
      content.includes("canonical/intended behavior"),
    "openspec-flow.md entry leaf 期望含 no canonical OpenSpec spec found + observed/inferred + 不宣稱 canonical/intended behavior，未找到"
  );
  assert.ok(
    siblingContent.includes("canonical OpenSpec spec") &&
      siblingContent.includes("observed implementation") &&
      siblingContent.includes("inference") &&
      siblingContent.includes("MUST NOT") &&
      siblingContent.includes("intended behavior"),
    "intent-lookup-order.md sibling leaf 期望含無 spec fallback：明說無 canonical spec、只標 observed implementation/inference、不得宣稱 intended behavior，未找到"
  );
});

test("define/fix intended behavior 錨點：無 spec 時必須先開 OpenSpec change", () => {
  for (const [label, text] of [
    ["openspec-flow.md", content],
    ["intent-lookup-order.md", siblingContent],
    ["output-discipline spec", outputDisciplineSpec],
  ]) {
    assert.match(
      text,
      /define\s+(?:or|\/)\s+fix intended behavior/,
      `${label} 期望鎖住 define/fix intended behavior 觸發條件`
    );
    assert.ok(
      text.includes("OpenSpec change"),
      `${label} 期望要求先開 OpenSpec change，不能把推論當 intended behavior 定案`
    );
  }
});

test("archive 非現狀來源：entry leaf 精簡錨點 MUST NOT grep archive 判現狀", () => {
  assert.ok(
    content.includes("MUST NOT") &&
      content.includes("archive 判現狀"),
    "openspec-flow.md entry leaf 期望含「MUST NOT grep archive 判現狀」精簡錨點，未找到 — archive 排除語意可能退化"
  );
});

test("archive 非現狀來源：sibling leaf 含「預設排除掃描路徑」完整論述", () => {
  assert.ok(
    siblingContent.includes("MUST NOT") &&
      siblingContent.includes("openspec/changes/archive") &&
      siblingContent.includes("預設排除掃描路徑"),
    "intent-lookup-order.md 期望含「MUST NOT grep archive + 預設排除掃描路徑」完整論述，未找到"
  );
});

test("why 查詢錨點：git log/blame + PR 當索引", () => {
  assert.ok(
    content.includes("git log") &&
      content.includes("git blame") &&
      content.includes("索引"),
    "期望含「git log / git blame ... 當索引」錨點（why 查詢用 git/PR 為索引），未找到"
  );
});

test("archive 只當終點錨點：MUST NOT 拿 archive 當 grep 起點", () => {
  assert.ok(
    content.includes("當 grep") && content.includes("起點") &&
      content.includes("終點"),
    "期望含「archive 只當終點、MUST NOT 當 grep 起點」錨點，未找到"
  );
});

test("反推最後查錨點：兩者皆優先於從 hook 反推", () => {
  assert.ok(
    content.includes("皆優先於") && content.includes("反推"),
    "期望含「皆優先於從 hook/script/rule leaf 反推」錨點，未找到 — 反推應為最後手段"
  );
});

test("user correction 標記錨點：ledger MUST 標 user correction + 來源 PR/session（entry + sibling 皆不得窄化成只 PR）", () => {
  // 鎖完整措辭「來源 PR/session」：canonical spec 為 `originating PR or session`，
  // 若 entry leaf 或 sibling 漂回窄版「來源 PR」（漏 /session）→ 轉紅，防 source 面窄化漂移。
  assert.ok(
    content.includes("user correction") &&
      content.includes("Requirement Ledger") &&
      content.includes("來源 PR/session"),
    "openspec-flow.md entry leaf 期望含「Requirement Ledger MUST 標 user correction + 來源 PR/session」完整錨點（不得窄化成只『來源 PR』），未找到 — 糾正史 source 面可能漂移或紀律被移除"
  );
  assert.ok(
    siblingContent.includes("user correction") &&
      siblingContent.includes("來源 PR/session"),
    "intent-lookup-order.md sibling leaf 期望含「user correction + 來源 PR/session」完整錨點（不得窄化成只『來源 PR』），未找到 — sibling 與 canonical spec `originating PR or session` 可能漂移"
  );
});
