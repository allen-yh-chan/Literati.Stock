/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: literal presence of the cross-carrier assertion sync wording in the
 * spec-delta authoring guide, review axis 1 and the `ai-autonomy.md` /
 * `AGENTS.md` pointers.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";
import {
  readIfExists,
  readDeltaForChange,
  readSpecWithDelta,
} from "./lib/spec-delta-reader.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const crossCarrierChangeName = "strengthen-cross-carrier-assertion-sync";
const currentChangeName = "rationalize-session-pending-gaps";
const remediationTriggerChangeName = "strengthen-cross-carrier-remediation-trigger";
const changeNames = [crossCarrierChangeName, currentChangeName];

function readProposalForChange(changeName) {
  const archiveDir = repoPath("openspec/changes/archive");
  const archived = existsSync(archiveDir)
    ? readdirSync(archiveDir)
        .filter((name) => name.endsWith(`-${changeName}`))
        .map((name) => readIfExists(`openspec/changes/archive/${name}/proposal.md`))
        .join("\n")
    : "";
  return [readIfExists(`openspec/changes/${changeName}/proposal.md`), archived].join("\n");
}

function assertIncludes(body, phrases) {
  for (const phrase of phrases) {
    assert.ok(body.includes(phrase), `missing phrase: ${phrase}`);
  }
}

// --- #2 前饋：openspec-quality-and-formats.md §Writing Spec Deltas ---
test("§Writing Spec Deltas carries the cross-carrier assertion sync feed-forward", () => {
  const leaf = read(".devpro/agent-rules/openspec-quality-and-formats.md");
  assertIncludes(leaf, [
    "跨 carrier 語意斷言同步（前饋）",
    "所有自然語言變體（中英、正反向）",
    "code + spec delta + canonical + narrative",
    "Requirement Ledger",
    "Current Requirement",
    "already recorded",
    "merge-base→HEAD",
    "precision level",
    "resolves-inside",
    "禁止逐輪只改被點名那一處",
  ]);
});

// --- #3 前饋：MODIFIED 全替換寫入前自問 ---
test("§Writing Spec Deltas MODIFIED bullet carries the write-time full-replace self-check", () => {
  const leaf = read(".devpro/agent-rules/openspec-quality-and-formats.md");
  const modifiedLine = leaf
    .split("\n")
    .find((l) => l.includes("`MODIFIED` 全替換（高危）"));
  assert.ok(modifiedLine, "MODIFIED 全替換 bullet not found on a single line");
  // 前饋自問 + Removed Scenarios escape 皆在同一 bullet 行，避免換行後 grep 斷裂
  assertIncludes(modifiedLine, [
    "寫入前自問（前饋，非事後兜底）",
    "全部**既有 scenario",
    "## Removed Scenarios",
  ]);
});

// --- #2 review／remediation 兩側：code-review-cross-carrier.md（entry Load-chain pointer）---
test("軸 1 entry retains Cross-Carrier Load-chain pointer", () => {
  const checklist = read(".devpro/agent-rules/code-review-checklist.md");
  assertIncludes(checklist, [
    "code-review-cross-carrier.md",
    "Cross-Carrier Assertion Consistency sub-check",
  ]);
});

test("軸 1 sibling carries the Cross-Carrier Assertion Consistency sub-check", () => {
  const sibling = read(".devpro/agent-rules/code-review-cross-carrier.md");
  assertIncludes(sibling, [
    "Cross-Carrier Assertion Consistency sub-check",
    "fail-open／fail-closed 方向、契約、常數值、polarity",
    "窮盡律",
  ]);
});

test("sub-check phrase, Important grade, semantic boundary, and current-HEAD closure are single-line grep-matchable", () => {
  const sibling = read(".devpro/agent-rules/code-review-cross-carrier.md");
  const subCheckLine = sibling
    .split("\n")
    .find((l) => l.includes("Cross-Carrier Assertion Consistency sub-check"));
  assert.ok(subCheckLine, "sub-check line not found on a single line");
  // 分級 Important、語意探索邊界、literal replay closure、雙 reviewer 皆在同一行，避免 promote/換行後 grep 斷裂
  assert.ok(subCheckLine.includes("標 **Important**"), "Important grade not on the sub-check line");
  assert.ok(subCheckLine.includes("沒有 generic semantic oracle"), "semantic-oracle boundary not on the sub-check line");
  assert.ok(subCheckLine.includes("current-HEAD declared-literal replay closure"), "current-HEAD literal closure not on the sub-check line");
  assert.ok(subCheckLine.includes("第一次修正就 MUST grep 全副本一次改完"), "exhaustive-first-fix rule missing");
  assertIncludes(subCheckLine, [
    "dp-reviewer",
    "devpro:second-review",
    "Current Requirement",
    "already recorded",
    "final merge-base→HEAD",
    "precision level",
  ]);
});

test("devpro:pre-pr makes sealed cross-carrier closure an exact remediation action point", () => {
  // Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const skill = readPrePrSkillFullReadingOrder();
  assertIncludes(skill, [
    "cross-carrier remediation closure",
    "seal-cross-carrier-closure",
    "若 capture／build／receipt／marker／verify 任一步失敗，MUST 停下修復 authority",
    "receipt-authority-changed",
    "classify-bounded",
    "current-HEAD tracked text blob",
    "generic semantic oracle",
  ]);
});

// strengthen-evidence-reverifiability R6 — 窮盡的 key 選錯，窮盡本身就是假的.
// The 窮盡律 above says "grep 全副本一次改完"; this clause says what to grep FOR.
// Keying the sweep on the old literal only proves that literal is gone, which a
// synonym rewrite / 中英互譯 / renamed symbol all satisfy while the semantics
// survive — so the acceptance condition must key on the semantic invariant.
test("窮盡律 keys acceptance on the semantic invariant, not the old literal", () => {
  const sibling = read(".devpro/agent-rules/code-review-cross-carrier.md");
  // Bind on ONE physical line (rule-anchor-guard-strength.md) and count, so a
  // token-preserving reversal cannot borrow tokens from neighbouring lines and
  // a drifting second copy is as red as a deletion.
  const pattern =
    /\*\*窮盡掃描的 key 選錯，窮盡本身就是假的\*\*[^\n]*\*\*MUST NOT\*\* 單獨作為窮盡的驗收條件[^\n]*驗收條件 MUST key 在\*\*語義不變量\*\*[^\n]*字面沒中但語義還在/;
  const hits = sibling.split("\n").filter((line) => pattern.test(line));
  assert.equal(
    hits.length,
    1,
    "code-review-cross-carrier.md 必須有且只有一行綁定 R6 語義不變量條款（舊字面 MUST NOT 單獨驗收 + MUST key 在語義不變量 + 反向抽查）",
  );
});

// --- Enforcement map 同步 ---
test("openspec-quality enforcement map lists the cross-carrier assertion row", () => {
  const leaf = read(".devpro/agent-rules/openspec-quality-and-formats.md");
  assertIncludes(leaf, [
    "Cross-carrier assertion synchronization",
    "cross-carrier-assertion-sync-grep.test.mjs",
  ]);
});

// --- capability spec delta 承載 requirement + scenarios（含 delta 路徑）---
test("capability spec delta carries the Cross-Carrier Assertion Synchronization requirement", () => {
  const specBody = readSpecWithDelta("openspec-flow", { changeNames });
  assertIncludes(specBody, [
    "Requirement: Cross-Carrier Assertion Synchronization",
    "Editing a cross-carrier assertion greps all variants before finalizing",
    "Cross-review of an assertion polarity fix must be exhaustive not per-round",
    "Structural gates do not cover narrative-to-code semantic agreement",
    "Requirement ledger and closeout prose are part of the sync surface",
    "Derived numbers are recomputed from the final diff",
    "Same-spec requirement precision stays aligned",
    "merge-base-to-HEAD",
    "resolves inside",
    "Writing a MODIFIED requirement self-checks full-replace scenario preservation",
    "cooperative-only",
  ]);
});

test("current session-pending archive carries cross-carrier sync anchors", () => {
  const currentDelta = readDeltaForChange(currentChangeName, "openspec-flow", {
    includeArchive: true,
  });
  const currentProposal = readProposalForChange(currentChangeName);

  assert.ok(
    currentDelta.trim().length > 0,
    "current session-pending archive delta must be non-empty"
  );
  assertIncludes(currentDelta, [
    "Requirement: Cross-Carrier Assertion Synchronization",
    "Requirement ledger and closeout prose are part of the sync surface",
    "Derived numbers are recomputed from the final diff",
    "Same-spec requirement precision stays aligned",
    "Writing a MODIFIED requirement self-checks full-replace scenario preservation",
  ]);
  assertIncludes(currentProposal, [
    "Requirement Ledger `Current Requirement`",
    "derived tables/counts",
    "final diff-derived numbers",
    "same-spec precision",
  ]);
});

// --- dogfood delta-only anchor guard：確保 guard 真 exercise delta path、非 promoted no-op ---
test("delta is non-empty and contains a delta-only anchor absent from canonical", () => {
  const canonical = read("openspec/specs/openspec-flow/spec.md");
  const delta = readDeltaForChange(crossCarrierChangeName, "openspec-flow", {
    includeArchive: true,
  });

  assert.ok(delta.trim().length > 0, "delta must be non-empty (active or archived path should resolve)");

  const deltaAnchor = "# openspec-flow Delta: Cross-Carrier Assertion Sync";
  assert.ok(delta.includes(deltaAnchor), `delta missing delta-only anchor: ${deltaAnchor}`);
  assert.ok(
    !canonical.includes(deltaAnchor),
    "anchor must be delta-only: found in canonical spec, which means the guard is a no-op",
  );
});

// --- remediation-time trigger: TL must load the full leaf before fixing a
// flagged cross-carrier finding, not act from the AGENTS.md §0 summary alone.
// Locks both the frontmatter description and the Load-chain blockquote so a
// future edit cannot narrow the trigger back to review-only in either copy.
test("code-review-cross-carrier.md triggers loading at remediation time, not only at review", () => {
  const sibling = read(".devpro/agent-rules/code-review-cross-carrier.md");
  assertIncludes(sibling, [
    "修復時同樣觸發",
    "TL 收到任何 review／cross-model 標記的 cross-carrier assertion finding",
    "不得只憑 AGENTS.md §0 第10條摘要即動手",
  ]);
  const descriptionLine = sibling
    .split("\n")
    .find((l) => l.startsWith("description:"));
  assert.ok(descriptionLine, "frontmatter description line not found");
  assert.ok(
    descriptionLine.includes("TL 修復 cross-carrier assertion finding"),
    "frontmatter description must also name the remediation-time trigger, not only the review-time one",
  );
});

// --- sibling pointer sync: this is the exact fact that regressed once
// already inside this same discipline's own branch (ai-autonomy.md synced,
// openspec-quality-and-formats.md left stale) — lock both copies together so
// a future fix of one cannot silently leave the other behind.
test("窮盡律 SSOT pointer says review／remediation on both sibling copies, not review-only", () => {
  const autonomy = read(".devpro/agent-rules/ai-autonomy.md");
  const quality = read(".devpro/agent-rules/openspec-quality-and-formats.md");
  assert.ok(
    autonomy.includes("code-review-cross-carrier.md`（review／remediation 側"),
    "ai-autonomy.md §0 item 10 pointer must say review／remediation 側",
  );
  assert.ok(
    quality.includes("review／remediation 側窮盡律見 `code-review-cross-carrier.md`"),
    "openspec-quality-and-formats.md pointer must say review／remediation 側",
  );
});

// --- round-1 dp-reviewer F-REMEDIATION-TRIGGER-SELF-REFERENTIAL: the
// MUST-load imperative must appear in a carrier that is loaded at the START
// of an edit (AGENTS.md §0 / ai-autonomy.md §0), not only inside the leaf it
// mandates loading — otherwise an agent who hasn't already loaded the leaf
// never learns it must.
test("ai-autonomy.md §0 item 10 states the remediation-time MUST-load as an imperative, not only a scope label", () => {
  const autonomy = read(".devpro/agent-rules/ai-autonomy.md");
  // Line-scoped, not whole-file includes() (rule-anchor-guard-strength.md §MUST
  // single-physical-line binding for polarity-sensitive anchors): the finding
  // this closes is specifically about PLACEMENT on §0 item 10, so both phrases
  // must be pinned to that one physical line, not merely present anywhere in
  // the 32KB file where they could silently migrate to a different item.
  const item10 = autonomy
    .split("\n")
    .find((l) => l.startsWith("10. **一致性掃描"));
  assert.ok(item10, "ai-autonomy.md §0 item 10 line not found");
  assertIncludes(item10, [
    "修復 review／cross-model 標記的 cross-carrier finding 前 MUST 先載入該檔全文",
    "不得只憑本條摘要動手",
  ]);
});

// --- round-1 dp-reviewer F-CROSSCARRIER-ENFORCEMAP-RESIDUAL: the
// enforcement-map row's derived-inventory + side-label must name the newly
// locked ai-autonomy.md surface and drop the review-only 後閘 framing.
test("enforcement map row names the ai-autonomy.md locked surface and the two-sided trigger", () => {
  const quality = read(".devpro/agent-rules/openspec-quality-and-formats.md");
  const row = quality
    .split("\n")
    .find((l) => l.startsWith("| Cross-carrier assertion synchronization"));
  assert.ok(row, "enforcement map row not found");
  assertIncludes(row, [
    "ai-autonomy.md",
    "review／remediation 兩側觸發",
  ]);
});

// --- capability spec delta carries the remediation-time scenario, with all
// nine pre-existing sibling scenarios preserved (full-replace MODIFIED) ---
test("capability spec delta adds the remediation-time load scenario without dropping existing ones", () => {
  const delta = readDeltaForChange(remediationTriggerChangeName, "openspec-flow", {
    includeArchive: true,
  });
  assert.ok(delta.trim().length > 0, "remediation-trigger delta must be non-empty");
  assertIncludes(delta, [
    "Requirement: Cross-Carrier Assertion Synchronization",
    "Remediation of a flagged cross-carrier finding loads the full leaf before editing",
    "the TL MUST load the full `code-review-cross-carrier.md` leaf",
    // pre-existing sibling scenarios that a full-replace MODIFIED must preserve
    "Editing a cross-carrier assertion greps all variants before finalizing",
    "Cross-review of an assertion polarity fix must be exhaustive not per-round",
    "Requirement ledger and closeout prose are part of the sync surface",
    "Derived numbers are recomputed from the final diff",
    "Same-spec requirement precision stays aligned",
    "Structural gates do not cover narrative-to-code semantic agreement",
    "Writing a MODIFIED requirement self-checks full-replace scenario preservation",
    "Always-loaded pre-action self-check carries a consistency-sweep item",
    "Exhaustive sweep keys acceptance on the semantic invariant not the old literal",
  ]);
});
