import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



function assertExactLineOnce(content, expected, label) {
  const matches = content.split("\n").filter((line) => line === expected);
  assert.equal(matches.length, 1, `${label} must appear as exactly one complete line`);
}

function extractWhenToUse(content, label) {
  const match = content.match(/## When to Use\n\n([\s\S]*?)(?=\n## |$)/);
  assert.ok(match, `${label} must contain a When to Use section`);
  return match[1];
}

function extractRules(content, label) {
  const match = content.match(/## Rules\n\n([\s\S]*?)(?=\n## |$)/);
  assert.ok(match, `${label} must contain a Rules section`);
  return match[1];
}

const expectedIntentWhenToUseLine =
  "觸發：理解既有行為，或使用者問系統功能設計 / `system feature design` / `current design` / `intended behavior` / `current contract` / 現況設計 / 預期行為。新行為設計走 `openspec-flow.md`。";
const expectedIntentRuleOneLine =
  "1. current behavior / current design / intended behavior：先查 `openspec/specs/**`，命中後讀 `openspec/specs/<capability>/spec.md`。它是 source of truth；archive 時 delta 已合併進 specs。**MUST NOT** grep `openspec/changes/archive/` 判現狀，因 archived deltas 可能被後續 change 覆蓋，且 `openspec/changes/archive` 是 `token-frugal-io.md` 的**預設排除掃描路徑**。";

function assertIntentLookupAnchors(content) {
  const whenToUse = extractWhenToUse(content, "intent-lookup-order.md");
  assertExactLineOnce(
    whenToUse,
    expectedIntentWhenToUseLine,
    "intent-lookup-order.md operative current-intent trigger line",
  );

  const rules = extractRules(content, "intent-lookup-order.md");
  assertExactLineOnce(
    rules,
    expectedIntentRuleOneLine,
    "intent-lookup-order.md operative specs-first Rule 1",
  );
}

const agents = read("AGENTS.md");
const gitignoreAlignment = read(".devpro/agent-rules/gitignore-alignment.md");
const gitattributesAlignment = read(".devpro/agent-rules/gitattributes-alignment.md");
const intentLookupOrder = read(".devpro/agent-rules/intent-lookup-order.md");

test("AGENTS routes .gitignore and .gitattributes alignment through the existing one-hop chain", () => {
  assertExactLineOnce(
    agents,
    "|`.gitignore`/`.gitattributes` 對齊|`gitignore-alignment.md`|",
    "AGENTS direct ignore/attributes alignment route",
  );
  assertExactLineOnce(
    gitignoreAlignment,
    "> Load-chain：consumer root `.gitattributes` LF checkout protection managed block SSOT 見 `gitattributes-alignment.md`。",
    "gitignore-alignment one-hop destination",
  );

  const gitignoreWhenToUse = extractWhenToUse(gitignoreAlignment, "gitignore-alignment.md");
  for (const trigger of [
    "Updating Devpro-managed `.gitignore` baseline entries",
    "Debugging consumer rules sync `.gitignore` drift",
  ]) {
    assert.ok(gitignoreWhenToUse.includes(trigger), `gitignore-alignment.md missing trigger: ${trigger}`);
  }

  const gitattributesWhenToUse = extractWhenToUse(
    gitattributesAlignment,
    "gitattributes-alignment.md",
  );
  for (const trigger of [
    "Updating Devpro-managed `.gitattributes` baseline entries",
    "Debugging consumer rules sync `.gitattributes` drift",
    "Explaining why a Devpro LF rule takes effect",
  ]) {
    assert.ok(
      gitattributesWhenToUse.includes(trigger),
      `gitattributes-alignment.md missing trigger: ${trigger}`,
    );
  }
});

test("AGENTS directly routes existing-behavior and current-contract intents to canonical lookup order", () => {
  assertExactLineOnce(
    agents,
    "|既有行為/current behavior/系統功能設計/system feature design/current design/intended behavior/current contract/現況設計/預期行為|`intent-lookup-order.md`|",
    "AGENTS direct current-intent route",
  );

  assertIntentLookupAnchors(intentLookupOrder);
});

test("intent guard rejects a narrowed operative When to Use anchor", () => {
  const mutated = intentLookupOrder.replace(
    expectedIntentWhenToUseLine,
    expectedIntentWhenToUseLine.replace("理解既有行為", "理解既有契約"),
  );
  assert.notEqual(mutated, intentLookupOrder, "When to Use mutation anchor must exist");
  assert.throws(() => assertIntentLookupAnchors(mutated));
});

test("intent guard rejects a narrowed operative Rule 1 anchor", () => {
  const mutated = intentLookupOrder.replace(
    expectedIntentRuleOneLine,
    expectedIntentRuleOneLine.replace(
      "1. current behavior / current design / intended behavior：",
      "Background note：",
    ),
  );
  assert.notEqual(mutated, intentLookupOrder, "Rule 1 mutation anchor must exist");
  assert.throws(() => assertIntentLookupAnchors(mutated));
});
