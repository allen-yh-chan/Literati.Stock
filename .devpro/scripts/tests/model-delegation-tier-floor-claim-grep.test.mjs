import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourcePath } from "./lib/source-root.mjs";
const target = sourcePath(".devpro/agent-rules/model-delegation.md");
/** Same-line polarity lock: both tokens plus ≠ on one physical line. */
const UNKNOWN_UNAVAILABLE_DISTINCTION = /`unknown` ≠ `unavailable`/;
// Change 3 replaces the retired universal fresh-context claim with a
// runtime-native minimum-sufficient context contract in the sibling leaf.
const delegationRulesTarget = sourcePath(".devpro/agent-rules/model-delegation-delegation-rules.md");

test("model-delegation stays tier-based and avoids stale runtime model settings", () => {
  const text = readFileSync(target, "utf8");

  assert.doesNotMatch(text, /\b(?:Opus|Sonnet|Haiku)\b/);
  assert.doesNotMatch(text, /top-level "model"/);
  assert.match(text, /高推理層/);
});

test("model-delegation-delegation-rules contains runtime-native context admission", () => {
  const text = readFileSync(delegationRulesTarget, "utf8");
  assert.match(text, /Subagent context是runtime-native/);
  assert.match(text, /fresh、resume、recent-turn bounded fork或full-history fork/);
  assert.match(text, /新spawn必須明示minimum-sufficient mode/);
  assert.doesNotMatch(text, /Subagents start with an independent context/);
  assert.match("Subagents start with an independent context", /Subagents start with an independent context/);
});

test("model-delegation-delegation-rules TL Tier Floor stays vendor-neutral and preserves fixed literals", () => {
  const text = readFileSync(delegationRulesTarget, "utf8");

  // (i) vendor neutrality — extended coverage: this file had no such assertion before
  // (the existing vendor-neutrality assertion above only covers model-delegation.md).
  assert.doesNotMatch(text, /\b(?:Opus|Sonnet|Haiku)\b/);

  const sectionMatch = text.match(/#### TL Tier Floor\r?\n([\s\S]*?)(?=\r?\n#### |$)/);
  assert.ok(sectionMatch, "#### TL Tier Floor section must exist");
  const section = sectionMatch[0];

  // (ii) fixed literals — positive assertions, scoped to the TL Tier Floor section
  assert.match(section, /runtime session metadata/);
  assert.match(section, /使用者／啟動設定/);
  assert.match(section, /皆無則 `unknown`/);
  assert.match(section, /ask once，答覆於該 session 內有效/);
  assert.match(section, /降級只減少 TL 可自做的工作，不放寬任何委派義務/);
  assert.match(section, /可觀察 fallback 訊號優先於較早的階梯宣告（含同 session 較早的使用者宣告）/);

  // (iii) STOP option 1 must describe a route that can prove the floor, not an
  // impossible in-place effort increase when the current adapter is unavailable.
  assert.match(section, /選項恰兩項：1 切至有已記載 selector 且能觀測 effective rank 達該項 floor/);
  assert.match(section, /`unavailable`，不得要求在該 adapter 內升 effort/);
  assert.doesNotMatch(section, /使用者指示維持現況/);

  // (iii-b) insertion axis, design.md D5 forbidden-literal set (scoped to this section):
  // 放寬 may appear ONLY inside L1's 不放寬; the other three phrases must never appear.
  const withoutL1 = section.replace("降級只減少 TL 可自做的工作，不放寬任何委派義務", "");
  assert.doesNotMatch(withoutL1, /放寬|可略過|不必委派|不需要那麼嚴格/);

  // (iv) floor-gated disposition coverage — positive assertions, scoped to this section.
  // Guards the disposition table itself (dp-reviewer Important finding: no existing
  // assertion was bound to the table content), so deleting the table (or any row) turns
  // at least one of these red instead of the suite staying silently green. Not all seven
  // literals below live inside the table: dp-architect / dp-assistant / "STOP + 交棒使用者"
  // are table cells; stop-point-comms.md is the STOP sentence; fallback 標記 / RCA 逃生閥 /
  // 使用者告知 are the re-resolution signals paragraph. Kept together because all three
  // sub-parts sit under the same section-scoped `section` match and were the parts the
  // review found unguarded.
  assert.match(section, /dp-architect/);
  assert.match(section, /dp-assistant/);
  assert.match(section, /STOP \+ 交棒使用者/);
  assert.match(section, /stop-point-comms\.md/);
  assert.match(section, /fallback 標記/);
  assert.match(section, /RCA 逃生閥/);
  assert.match(section, /使用者告知/);
});

test("TL Tier Floor forbidden-literal / escape-hatch regexes provably match their target phrases (synthetic fixture)", () => {
  // The negative assertions above (doesNotMatch against the real carrier text) cannot by
  // themselves prove the regex is well-formed and actually capable of matching its intended
  // target string — a typo'd, always-non-matching regex would pass them just as well. Per
  // rule-anchor-guard-strength.md, fixture proof MUST live in the test file rather than rely
  // on one-off manual mutation testing. These synthetic strings (not the real file) prove
  // each regex can match what it is meant to catch.

  const escapeHatchFixture =
    "選項清單刻意不含任何「維持現況由 TL 於當前 tier 執行」分支，即便使用者指示維持現況也不例外。";
  assert.match(escapeHatchFixture, /使用者指示維持現況/);

  const forbiddenLiteralFixtures = [
    "非高推理層時可放寬委派義務",
    "此項可略過委派",
    "此情況下不必委派 dp-architect",
    "偵測不到訊號時不需要那麼嚴格",
  ];
  for (const fixture of forbiddenLiteralFixtures) {
    assert.match(fixture, /放寬|可略過|不必委派|不需要那麼嚴格/);
  }
});

test("model-delegation-delegation-rules TL Effort Floor stays vendor-neutral and preserves fixed literals", () => {
  const text = readFileSync(delegationRulesTarget, "utf8");
  const claudeEffort = readFileSync(
    sourcePath(".devpro/agent-rules/platform-adapters/claude-code-effort-tiers.md"),
    "utf8",
  );
  const codexEffort = readFileSync(
    sourcePath(".devpro/agent-rules/platform-adapters/codex-effort-tiers.md"),
    "utf8",
  );

  const sectionMatch = text.match(/#### TL Effort Floor\r?\n([\s\S]*?)(?=\r?\n#### |$)/);
  assert.ok(sectionMatch, "#### TL Effort Floor section must exist");
  const section = sectionMatch[0];

  // deletion — heading, four shared ranks, L-E1 / L-E2 / L-E3
  assert.match(section, /#### TL Effort Floor/);
  assert.match(section, /adapter 只做 mapping／不得當 shared SSOT/);
  assert.match(section, /低努力層/);
  assert.match(section, /中努力層/);
  assert.match(section, /高努力層/);
  assert.match(section, /最高努力層/);
  assert.match(section, /降低 effort 只減少 TL 可自做的工作，不放寬任何委派義務/);
  assert.match(section, /MUST NOT 發明 selector/);
  assert.match(section, /reasoning-depth unavailable/);

  // insertion — vendor selector flags MUST NOT appear as shared ranks (section-scoped)
  assert.doesNotMatch(section, /\b(?:Opus|Sonnet|Haiku)\b/);
  assert.doesNotMatch(section, /\bmax\b/);
  assert.doesNotMatch(section, /\bxhigh\b/);

  // L-E1 negative: after removing L-E1, 放寬 and waiver phrases stay absent
  const withoutLE1 = section.replace("降低 effort 只減少 TL 可自做的工作，不放寬任何委派義務", "");
  assert.doesNotMatch(withoutLE1, /放寬|可略過|不必委派|不需要那麼嚴格/);

  // absence
  assert.doesNotMatch(section, /SubagentAuthPending/);
  assert.doesNotMatch(claudeEffort, /Shared rule 只用/);
  assert.doesNotMatch(codexEffort, /Shared rule 只用/);
  assert.match(claudeEffort, /\| 最高努力層 \| 多方案架構權衡/);
  assert.match(claudeEffort, /\*\*不\*\*滿足 floor-gated 架構權衡/);

  // unknown ≠ unavailable as an exact distinction (not merely both tokens present)
  assert.match(section, UNKNOWN_UNAVAILABLE_DISTINCTION);

  // C3 — MUST NOT impose a duty to detect unobservable current-effort events
  assert.doesNotMatch(section, /偵測當下 effort/);
  assert.doesNotMatch(section, /偵測不可觀測/);

  // re-resolution signals
  assert.match(section, /fallback 標記/);
  assert.match(section, /使用者告知|切換回報/);

  // floor table
  assert.match(section, /dp-architect/);
  assert.match(section, /STOP \+ 交棒使用者/);

  // enforcement class
  assert.match(section, /\[cooperative-only, weak enforcement\]/);
});

test("TL below-floor effort cannot continue past its floor-gated disposition", () => {
  const text = readFileSync(delegationRulesTarget, "utf8");
  const sectionMatch = text.match(/#### TL Effort Floor\r?\n([\s\S]*?)(?=\r?\n#### |$)/);
  assert.ok(sectionMatch, "#### TL Effort Floor section must exist");

  const rows = sectionMatch[1].split(/\r?\n/);
  const routingRow = rows.find((line) => line.startsWith("| Branch Routing Decision／Task 相依性分析"));
  assert.ok(routingRow, "Branch Routing / task-dependency floor row must exist");
  assert.match(
    routingRow,
    /\| 高努力層 \| 升至下限；否則 STOP \+ 交棒使用者 \|/,
    "verified below-floor effort may proceed only after reaching the floor; otherwise TL must stop",
  );

  const releaseSecurityRow = rows.find((line) => line.startsWith("| release／security／production blocker 的 TL 側判斷"));
  assert.ok(releaseSecurityRow, "release/security/production-blocker floor row must exist");
  assert.match(releaseSecurityRow, /升至下限；否則 STOP \+ 交棒使用者/);
  assert.match(releaseSecurityRow, /`unknown`／`unavailable`：STOP \+ 交棒/);
});

test("TL Effort Floor forbidden-literal / selector-backflow regexes provably match their target phrases (synthetic fixture)", () => {
  assert.match("Opus as shared rank", /\b(?:Opus|Sonnet|Haiku)\b/);
  assert.match("Sonnet as shared rank", /\b(?:Opus|Sonnet|Haiku)\b/);
  assert.match("Haiku as shared rank", /\b(?:Opus|Sonnet|Haiku)\b/);
  assert.match("shared rank max", /\bmax\b/);
  assert.match("shared rank xhigh", /\bxhigh\b/);

  const forbiddenLiteralFixtures = [
    "非最高努力層時可放寬委派義務",
    "此項可略過委派",
    "此情況下不必委派 dp-architect",
    "偵測不到訊號時不需要那麼嚴格",
  ];
  for (const fixture of forbiddenLiteralFixtures) {
    assert.match(fixture, /放寬|可略過|不必委派|不需要那麼嚴格/);
  }

  assert.match("MUST 偵測當下 effort", /偵測當下 effort/);
  assert.match("MUST 偵測不可觀測 runtime 事件", /偵測不可觀測/);
  assert.match("unknown as SubagentAuthPending", /SubagentAuthPending/);
  assert.match("Shared rule 只用 `model-delegation.md` 的 tier 詞彙", /Shared rule 只用/);
});

test("TL Effort Floor unknown/unavailable polarity rejects equated or token-only fixtures", () => {
  // Prove-it: the retired both-token lock would still pass these contradictory
  // fixtures. The shared distinction regex MUST NOT.
  const equated = [
    "#### TL Effort Floor",
    "parse yields `unknown` = `unavailable` and reasoning-depth unavailable",
  ].join("\n");
  assert.match(equated, /unavailable/);
  assert.match(equated, /unknown/);
  assert.doesNotMatch(equated, UNKNOWN_UNAVAILABLE_DISTINCTION);

  const tokenOnlySplit = "`unknown`\n`unavailable`";
  assert.match(tokenOnlySplit, /unavailable/);
  assert.match(tokenOnlySplit, /unknown/);
  assert.doesNotMatch(tokenOnlySplit, UNKNOWN_UNAVAILABLE_DISTINCTION);

  const canonical = "`unknown` ≠ `unavailable`.";
  assert.match(canonical, UNKNOWN_UNAVAILABLE_DISTINCTION);
});

test("Scenario: Effort floor follows the activity, not the artifact name or file count", () => {
  const text = readFileSync(delegationRulesTarget, "utf8");
  const codex = readFileSync(sourcePath(".devpro/agent-rules/platform-adapters/codex-effort-tiers.md"), "utf8");
  const claude = readFileSync(sourcePath(".devpro/agent-rules/platform-adapters/claude-code-effort-tiers.md"), "utf8");
  assert.match(text, /活動分級依實際工作內容，不依 artifact 名稱或檔案數/);
  assert.match(text, /跨檔高風險 debug.*共享 RCA 下限為高/s);
  assert.match(text, /proposal 技術設計／架構權衡.*最高努力層/s);
  for (const adapter of [codex, claude]) {
    assert.match(adapter, /小 typo、格式調整且無行為設計/);
    assert.doesNotMatch(adapter, /單檔小修|single.file fix/i);
  }
});

test("Scenario: Selected effort is not evidence of effective effort", () => {
  const text = readFileSync(delegationRulesTarget, "utf8");
  assert.match(text, /使用者／啟動設定或角色 frontmatter 只記錄 selected selector，不能單獨證明已生效/);
  assert.match(text, /effective rank 只由 adapter 可觀測的 runtime session metadata／switch report 證明/);
  assert.match(text, /effective 證據.*只有 selected 設定 → `unknown`/);
  assert.match(text, /selected 設定，不是 effective-rank 證據/);
});

test("Scenario: A floor-capable Codex architect meets the Codex design floor", () => {
  const shared = readFileSync(delegationRulesTarget, "utf8");
  const codex = readFileSync(sourcePath(".devpro/agent-rules/platform-adapters/codex-effort-tiers.md"), "utf8");
  const role = readFileSync(sourcePath(".codex/agents/dp-architect.toml"), "utf8");
  assert.match(codex, /最高努力層 \| proposal 技術設計／架構權衡/);
  assert.match(codex, /model_reasoning_effort="xhigh"/);
  assert.match(role, /reasoning_effort\s*=\s*"xhigh"/);
  assert.match(shared, /effective-rank 證據/);
});

test("Scenario: Unproven Codex xhigh does not satisfy the design floor", () => {
  const shared = readFileSync(delegationRulesTarget, "utf8");
  assert.match(shared, /selected selector 或固定角色 frontmatter 均不等於 effective-rank 證據/);
  assert.match(shared, /若沒有 effective effort 已證明達 floor 的 `?dp-architect`?，必須 STOP/);
  assert.match(shared, /STOP 依 `stop-point-comms\.md` 編號格式，選項恰兩項：1 切至有已記載 selector 且能觀測 effective rank 達該項 floor 的 adapter\/session，證據成立後續行；2 其他/);
  assert.doesNotMatch(shared, /1 升至該項下限後續行/);
});

test("Scenario: Unavailable selector does not offer an in-place effort increase", () => {
  const shared = readFileSync(delegationRulesTarget, "utf8");
  assert.match(shared, /`unavailable` 宣告 `reasoning-depth unavailable`，MUST NOT 發明 selector，也 MUST NOT 要求在目前 adapter 內升 effort/);
  assert.match(shared, /若目前 adapter 的 selector 為 `unavailable`，不得要求在該 adapter 內升 effort/);
  assert.match(shared, /`unknown`／`unavailable`：STOP \+ 交棒/);
  assert.match(shared, /切至有已記載 selector 且能觀測 effective rank 達該項 floor/);
  assert.doesNotMatch(shared, /1 升至該項下限後續行/);
});

test("Scenario: Claude architect xhigh remains below the technical-design maximum", () => {
  const shared = readFileSync(delegationRulesTarget, "utf8");
  const claude = readFileSync(sourcePath(".devpro/agent-rules/platform-adapters/claude-code-effort-tiers.md"), "utf8");
  assert.match(claude, /\| 最高努力層 \| .*\| `max` \|/);
  assert.match(claude, /adapter-only intermediate[\s\S]*xhigh|xhigh[\s\S]*adapter-only intermediate/);
  assert.match(claude, /dp-architect.*`xhigh`.*不視為達 floor/);
  assert.match(shared, /只有 effective rank 已證明達 floor 的 `dp-architect` 委派可承接/);
});
