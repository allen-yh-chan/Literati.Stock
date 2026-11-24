import test from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

// strengthen-continuation-receipt-chain-verification (design D10 / D11 / D15): the receipt end
// now chain-verifies a continued reviewer thread, so the six carriers say a same-responsibility
// bounded rereview continues the thread and the continuation seals. The #3106-era wording
// ("continue cannot seal, use fresh, tracked in #3105") is the forbidden face; the operative
// lines carry the positive anchors. Guard strength follows rule-anchor-guard-strength.md:
// absence axis (forbidden literals, with resident positive/negative fixtures) plus a
// polarity-sensitive presence axis (one physical line must carry both the continue verb and the
// sealable anchor). The mutation audit runs on a synthetic compliant corpus so it stays green
// independent of carrier state.

const CARRIER_PATHS = {
  reviewWave: ".devpro/agent-rules/workflow-cost-controls.md",
  continuationClause: ".devpro/agent-rules/model-delegation-threads-and-caps.md",
  briefing: ".devpro/agent-rules/model-delegation-briefing.md",
  capabilities: ".devpro/agent-rules/platform-adapters/claude-code-capabilities.md",
  preprSkill: ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
  dispatchBlocks: ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md",
};

const FORBIDDEN_LITERALS = [
  "封不出",
  "只用於不需封存的探測",
  "只用於不封存的探測",
  "需封存 receipt 的再審用 fresh",
  "需封存 receipt 的 bounded 再審用 fresh",
  "MUST 派 fresh `dp-reviewer`",
  "續作 record 固定為 `cooperative-only`，所以",
  "#3105",
  // PR #3111 cross-model round 1: a later continuation names the previous round's record, not
  // the fresh spawn's, so "to and parent_record_id both come from the same spawn result" is wrong
  // from the second continuation on and would point every round back at the fresh root.
  "同一次 spawn 結果",
];

const SEALABLE_ANCHOR = "經 receipt 端 chain 驗證可封存";
const PARENT_SOURCE_ANCHOR = "同一 thread 上一輪已 admitted 的 record";
const SAME_ROUND_ANCHOR = "`admissionRecordId` MUST 沿用該輪 dispatch 的 admission record";
const CONTINUE_VERB = /continue|SendMessage/;

const operativeLines = [
  { id: "reviewWave", carrier: "reviewWave", needle: "remediation 凍結成一批後", requires: [CONTINUE_VERB, SEALABLE_ANCHOR] },
  { id: "continuationClause", carrier: "continuationClause", needle: "- **續作**：", requires: [CONTINUE_VERB, SEALABLE_ANCHOR, PARENT_SOURCE_ANCHOR] },
  { id: "briefing", carrier: "briefing", needle: "| `parent_record_id` |", requires: [CONTINUE_VERB, SEALABLE_ANCHOR] },
  { id: "capabilities", carrier: "capabilities", needle: "- **continue**：", requires: [CONTINUE_VERB, SEALABLE_ANCHOR, PARENT_SOURCE_ANCHOR] },
  { id: "preprStopLoss", carrier: "preprSkill", needle: "**Review remediation cost stop-loss action point**", requires: [CONTINUE_VERB, SEALABLE_ANCHOR] },
  { id: "preprSameRound", carrier: "preprSkill", needle: "`predecessor-finding-omitted` 是 reviewer payload 缺陷", requires: [CONTINUE_VERB, SAME_ROUND_ANCHOR] },
  { id: "dispatchBlocks", carrier: "dispatchBlocks", needle: "**再審 reviewer 的選擇**", requires: [CONTINUE_VERB, SEALABLE_ANCHOR, PARENT_SOURCE_ANCHOR] },
];

const lineWith = (text, needle) => text.split("\n").filter((line) => line.includes(needle));
const matches = (line, req) => (req instanceof RegExp ? req.test(line) : line.includes(req));
const forbiddenHits = (text) => FORBIDDEN_LITERALS.filter((literal) => text.includes(literal));

// One pure assertion per carrier (absence) and per operative line (presence); `evaluate` returns
// the names of the failing assertions so the mutation audit can count them.
function operativeFailure(texts, entry) {
  const lines = lineWith(texts[entry.carrier], entry.needle);
  if (lines.length !== 1) return true;
  return !entry.requires.every((req) => matches(lines[0], req));
}

function evaluate(texts) {
  const failed = [];
  for (const carrier of Object.keys(CARRIER_PATHS)) {
    if (forbiddenHits(texts[carrier]).length > 0) failed.push(`absence:${carrier}`);
  }
  for (const entry of operativeLines) {
    if (operativeFailure(texts, entry)) failed.push(`presence:${entry.id}`);
  }
  return failed;
}

// preprSkill spans SKILL.md and references/full-review-and-archive.md; read its full-rigor reading order.
const realTexts = Object.fromEntries(Object.entries(CARRIER_PATHS).map(([key, repoPath]) => [
  key,
  key === "preprSkill" ? readPrePrSkillFullReadingOrder() : read(repoPath),
]));

// Residual lines as they stood at a05fca326 (the #3106 wording). Every one MUST be caught.
const RESIDUAL_FIXTURES = [
  "需封存 receipt 的再審用 fresh `dp-reviewer` 或以 sealed receipt 接手的 replacement（`continue` 既有 reviewer thread 目前封不出 receipt，只用於不封存的探測，見 `model-delegation-threads-and-caps.md` 續作條與 #3105；",
  "v3 封存 receipt 要求 `host-verified` admission record，續作 record 固定為 `cooperative-only`，所以續作（宣告與否）的回覆都封不出獨立 receipt：需封存 receipt 的輪次 MUST 用 fresh 審查者，`continue` 只用於不需封存的探測（這是暫行限制，追蹤見 #3105）",
  "需封存 receipt 的 bounded 再審用 fresh `dp-reviewer`（續作 thread 目前封不出 receipt，見 #3105；`continue` 只用於不封存的探測；同 role fresh ≠ continuation）",
  "優先 continue 同一 thread，不能接續時 fresh dispatch；同輪補齊的 `admissionRecordId` MUST 沿用該輪原 fresh record，不得改用續作 record，續作 record 封不出，見 #3105",
  "需封存 receipt 的 bounded 再審 MUST 派 fresh `dp-reviewer`（`instance_mode: fresh`）。續作只用於不封存的探測。這是 spec 與實作落差的暫行指引，追蹤見 #3105。",
];

// The wording this PR itself shipped before cross-model round 1 (three carriers). Every one MUST be caught.
const PARENT_SOURCE_RESIDUAL_FIXTURES = [
  "`to` 與 `parent_record_id` 取自同一次 spawn 結果；閒置 thread 不產生 token",
  "`to` 與 `parent_record_id` 取自同一次 spawn 結果以縮小該殘餘面。",
  "帶 `instance_mode: continue` 與指向上一輪 record 的 `parent_record_id`；`to` 與 `parent_record_id` 取自同一次 spawn 結果）",
];

// Legitimate lines that MUST be let through.
const ALLOWED_FIXTURES = [
  "未宣告的續作沒有 admission record，無法封存 receipt",
  "續作輪經 receipt 端 chain 驗證可封存 runtime-agent 收據；`to` 取自原 spawn 回傳的 agent id、`parent_record_id` 取自同一 thread 上一輪已 admitted 的 record（首次續作為該 spawn 回傳的 record，其後為上一次續作訊息回傳的 record）",
  "同輪補齊的 `admissionRecordId` MUST 沿用該輪 dispatch 的 admission record",
];

test("forbidden-literal fixtures: every residual a05fca326 line is caught and every forbidden literal is covered", () => {
  for (const line of RESIDUAL_FIXTURES) {
    assert.ok(forbiddenHits(line).length > 0, `residual fixture escaped the guard: ${line}`);
  }
  for (const line of PARENT_SOURCE_RESIDUAL_FIXTURES) {
    assert.ok(forbiddenHits(line).length > 0, `parent-source residual fixture escaped the guard: ${line}`);
  }
  const covered = new Set([...RESIDUAL_FIXTURES, ...PARENT_SOURCE_RESIDUAL_FIXTURES].flatMap(forbiddenHits));
  assert.deepEqual(FORBIDDEN_LITERALS.filter((literal) => !covered.has(literal)), []);
});

test("forbidden-literal fixtures: legitimate wording is not flagged", () => {
  for (const line of ALLOWED_FIXTURES) {
    assert.deepEqual(forbiddenHits(line), [], `legitimate line flagged: ${line}`);
  }
});

for (const [carrier, repoPath] of Object.entries(CARRIER_PATHS)) {
  test(`carrier ${carrier} contains none of the forbidden #3106-era literals`, () => {
    assert.deepEqual(forbiddenHits(realTexts[carrier]), [], `${repoPath} still has forbidden wording`);
  });
}

for (const entry of operativeLines) {
  test(`operative line ${entry.id} carries the continue verb and its anchors on one physical line`, () => {
    const lines = lineWith(realTexts[entry.carrier], entry.needle);
    assert.equal(lines.length, 1, `${entry.id}: expected exactly one line containing ${entry.needle}`);
    for (const req of entry.requires) {
      assert.ok(matches(lines[0], req), `${entry.id}: operative line is missing ${String(req)}`);
    }
  });
}

// Synthetic compliant corpus: one operative line per entry plus filler, so the audit does not
// depend on what the real carriers currently say.
function syntheticCorpus() {
  const texts = Object.fromEntries(Object.keys(CARRIER_PATHS).map((carrier) => [carrier, ["# filler", "unrelated line"]]));
  for (const entry of operativeLines) {
    const required = entry.requires.map((req) => (req instanceof RegExp ? "continue" : req));
    texts[entry.carrier].push(`${entry.needle} ${required.join(" ")}`);
  }
  return Object.fromEntries(Object.entries(texts).map(([carrier, lines]) => [carrier, lines.join("\n")]));
}

test("mutation audit: the synthetic compliant corpus passes every assertion", () => {
  assert.deepEqual(evaluate(syntheticCorpus()), []);
});

test("mutation audit: deleting any one operative line turns exactly one assertion red", () => {
  const base = syntheticCorpus();
  for (const entry of operativeLines) {
    const mutated = { ...base };
    mutated[entry.carrier] = base[entry.carrier].split("\n").filter((line) => !line.includes(entry.needle)).join("\n");
    assert.deepEqual(evaluate(mutated), [`presence:${entry.id}`], `deleting ${entry.id} must fail exactly its own assertion`);
  }
});

test("mutation audit: reintroducing any one forbidden literal turns exactly one assertion red", () => {
  const base = syntheticCorpus();
  for (const carrier of Object.keys(CARRIER_PATHS)) {
    for (const literal of FORBIDDEN_LITERALS) {
      const mutated = { ...base, [carrier]: `${base[carrier]}\n${literal}` };
      assert.deepEqual(evaluate(mutated), [`absence:${carrier}`], `${literal} in ${carrier} must fail exactly the absence assertion`);
    }
  }
});

test("mutation audit: dropping the sealable or the parent-source anchor from an operative line is caught (polarity)", () => {
  const base = syntheticCorpus();
  for (const anchor of [SEALABLE_ANCHOR, PARENT_SOURCE_ANCHOR]) {
    for (const entry of operativeLines.filter((e) => e.requires.includes(anchor))) {
      const mutated = { ...base };
      mutated[entry.carrier] = base[entry.carrier].replace(anchor, "");
      assert.deepEqual(evaluate(mutated), [`presence:${entry.id}`], `${entry.id} without ${anchor}`);
    }
  }
});
