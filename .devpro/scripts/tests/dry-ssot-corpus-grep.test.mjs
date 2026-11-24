/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: the seam, pointer and lite-label wording of `dry-ssot-corpus.md` and its
 * `AGENTS.md` route.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 *
 * dry-ssot-corpus-grep.test.mjs
 *
 * Focused seam/pointer/lite-label guards for the DRY/SSOT corpus-scope doctrine.
 * Guard 強度：polarity-sensitive 錨點用同一物理行 compound regex；structural
 * 用 includes。禁 materiality oracle、禁 cli-entry 檔哈希、禁 unscoped git diff
 * 當永久 unit 斷言。Don't-touch 驗收屬 change-scoped stay-proof。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";
import { findRuleTokenTier } from "../lib/rule-token-budget.mjs";

const LEAF = ".devpro/agent-rules/dry-ssot-corpus.md";
const SIX_SECTIONS = [
  "## Overview",
  "## When to Use",
  "## Process",
  "## Exit Criteria",
  "## Common Rationalizations",
  "## Verification",
];

function readLeaf() {
  assert.ok(existsSync(repoPath(LEAF)), `missing ${LEAF}`);
  return read(LEAF);
}

function rule(name) {
  return read(`.devpro/agent-rules/${name}`);
}

test("doctrine leaf dry-ssot-corpus.md exists with standard six sections", () => {
  const leaf = readLeaf();
  for (const heading of SIX_SECTIONS) {
    assert.ok(leaf.includes(heading), `missing ${heading}`);
  }
  assert.match(leaf, /^name:\s*dry-ssot-corpus/m);
  assert.match(leaf, /corpus-not-diff/);
  assert.match(leaf, /視野是 \*\*corpus\*\*|視野是 corpus/);
  assert.match(leaf, /一致性掃描/);
});

test("P1 pointer-only language leaf; complementary axes stay 守則 3 polarity", () => {
  const leaf = readLeaf();
  const csharp = rule("csharp-style-and-dry.md");
  const principles = rule("rule-design-principles.md");
  assert.match(csharp, /dry-ssot-corpus\.md/);
  assert.doesNotMatch(csharp, /corpus-not-diff/);
  assert.match(principles, /dry-ssot-corpus\.md/);
  assert.match(principles, /本列極性不倒轉/);
  assert.doesNotMatch(principles, /DRY\s*>\s*自含/);
  assert.match(leaf, /complementary|互補/);
  assert.match(leaf, /≤1 層/);
});

test("P2 creation-time bounded lookup polarity locked on same physical line", () => {
  const leaf = readLeaf();
  assert.match(leaf, /名稱／關鍵字/);
  assert.match(leaf, /shared dir/);
  assert.match(leaf, /禁[^\n]*corpus read-through/);
  assert.match(leaf, /first-use|就地/);
  assert.match(leaf, /禁[^\n]*預期第二場景/);
});

test("P3 review-time NEW named-def tokens on checklist and fallback; no silent small-diff", () => {
  const leaf = readLeaf();
  const checklist = rule("code-review-checklist.md");
  const fallback = rule("code-review-checklist-fallback.md");
  for (const body of [leaf, checklist, fallback]) {
    assert.match(body, /新具名定義/);
  }
  assert.match(checklist, /NEW named/);
  assert.match(fallback, /NEW named/);
  assert.match(leaf, /禁[^\n]*silent small-diff/);
  assert.match(checklist, /禁[^\n]*silent small-diff/);
  assert.match(fallback, /禁[^\n]*silent small-diff/);
  for (const [name, body] of [
    ["checklist", checklist],
    ["fallback", fallback],
  ]) {
    const line = body.split("\n").find((l) => l.includes("silent small-diff"));
    assert.ok(line, `${name} missing silent small-diff line`);
    assert.match(line, /^\s*- \*\*NEW named/);
    assert.match(line, /任何 PR/);
    assert.doesNotMatch(line, /^\s*- \*\*(SSOT-drift|治理型 PR)/);
    assert.match(line, /範圍/);
    assert.match(line, /結果|命中/);
    assert.match(line, /disposition/);
    assert.doesNotMatch(line, /指令即可/);
  }
  assert.match(leaf, /Named-Definition Corpus-Grep Evidence/);
  assert.match(leaf, /named-def-corpus-grep-evidence\.mjs/);
  assert.match(leaf, /禁[^\n]*diff regex|禁[^\n]*materiality oracle|cooperative-only/);
});

test("P2 lite=keep and P3 lite=degrade; not exempt; not default full-only", () => {
  const rigor = rule("rules-rigor-level.md");
  assert.match(rigor, /P2[^\n]*keep|creation-time[^\n]*keep/);
  assert.match(rigor, /P3 lite=degrade[^\n]*不是 exempt/);
  assert.doesNotMatch(rigor, /lite 預設只對 full/);
  assert.doesNotMatch(rigor, /P2P3 exempt/);
});

test("P4 existing_ssot_list on programmer and assistant; lookup MUST NOT delegate", () => {
  const briefing = rule("model-delegation-briefing.md");
  const proposal = rule("proposal-template.md");
  const programmer = briefing.slice(
    briefing.indexOf("**dp-programmer**"),
    briefing.indexOf("**dp-assistant**"),
  );
  const assistant = briefing.slice(briefing.indexOf("**dp-assistant**"));
  assert.match(programmer, /existing_ssot_list|existing-SSOT/);
  assert.match(assistant, /existing_ssot_list|existing-SSOT/);
  assert.match(briefing, /MUST NOT[^\n]*dp-programmer[^\n]*dp-assistant/);
  assert.match(proposal, /existing-SSOT|existing_ssot|first-use in place/);
});

test("P5 equal-pass inline and SSOT-import on same physical line", () => {
  const leaf = readLeaf();
  assert.match(leaf, /SSOT-import[^\n]*equal-pass/);
});

test("P6 pattern-level record; stay interval; no drive-by", () => {
  const leaf = readLeaf();
  assert.match(leaf, /pattern-level/);
  assert.match(leaf, /≥3/);
  assert.match(leaf, /already-divergent/);
  assert.match(leaf, /禁[^\n]*drive-by/);
  assert.match(leaf, /stay interval[^\n]*不記錄/);
  assert.match(leaf, /項 4/);
});

test("P7 corpus-dup observation mouth on same cadence, not a 6th parallel track", () => {
  const playbook = rule("rule-audit-playbook.md");
  const evolution = rule("rule-self-evolution.md");
  const skill = read(".devpro/agent-skills/rules-authoring/rule-governance/SKILL.md");
  assert.match(playbook, /corpus-dup/);
  assert.match(evolution, /corpus-dup/);
  assert.match(skill, /corpus-dup/);
  assert.match(playbook, /corpus-dup[^\n]*不是第 6/);
  const when = evolution.split("## When to Use")[1]?.split("## Process")[0] ?? "";
  const corpusDupLine = when.split("\n").find((l) => l.includes("corpus-dup")) ?? "";
  assert.match(corpusDupLine, /cadence|順帶/);
  assert.match(corpusDupLine, /非平行/);
  assert.doesNotMatch(corpusDupLine, /^- corpus-dup/);
  for (const line of when.split("\n")) {
    if (!line.includes("corpus-dup")) continue;
    assert.match(line, /cadence|順帶/);
    assert.doesNotMatch(line, /^- corpus-dup/);
  }
});

test("P8 AGENTS trigger names leaf; self-check stays 10; no 11th item", () => {
  const leaf = readLeaf();
  const agents = read("AGENTS.md");
  assert.match(leaf, /一致性掃描/);
  const index = agents.match(/## 觸發式載入索引[\s\S]*?\n---/);
  assert.ok(index, "AGENTS must contain trigger index");
  assert.match(index[0], /dry-ssot-corpus\.md/);
  const match = agents.match(/### 動手前十句自檢[^\n]*\n\n([\s\S]*?)\n\n十題任一/);
  assert.ok(match, "AGENTS missing 動手前十句自檢 block");
  const items = match[1]
    .split("\n")
    .map((line) => line.match(/^(\d+)\.\s+\*\*/))
    .filter(Boolean);
  assert.equal(items.length, 10, "AGENTS self-check must stay 10 items");
  assert.doesNotMatch(match[1], /^11\./m);
});

test("P9 When to Use is suggestion/rule-feedback; current-state before disposition", () => {
  const consequence = rule("change-consequence-assessment.md");
  const when = consequence.split("## When to Use")[1]?.split("## Process")[0] ?? "";
  assert.match(when, /suggestion|rule-feedback/);
  assert.match(consequence, /現況|current-state/);
  for (const token of [
    "accepted-in-approved-scope",
    "mitigated-with-verification",
    "deferred-with-owner-and-trigger",
    "non-material-or-na-with-evidence",
  ]) {
    assert.ok(consequence.includes(token), `missing closed token ${token}`);
  }
});

test("leaf is registered TIERS.next not unregistered", () => {
  assert.ok(existsSync(repoPath(LEAF)), `missing ${LEAF}`);
  const policy = findRuleTokenTier(LEAF);
  assert.equal(policy.name, "next", `expected next, got ${policy.name}`);
});
