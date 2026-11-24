/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: the POC-First Trigger Gate headings, their order, trigger phrases and
 * exclusion items in `testing-and-qa.md`, and its `AGENTS.md` route.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 *
 * poc-first-trigger-gate-grep.test.mjs
 *
 * Locks critical cooperative gates in `testing-and-qa.md`.
 * Companion to branch-legality-grep / silent-skip-rule-grep /
 * reviewer-mandatory-gate-grep series.
 *
 * The gate requires a small-scope POC before expanding an unvalidated
 * approach to ≥2 places. Silent removal of the heading, dual-condition
 * phrases, exclusion list items, or cooperative-only marker is the
 * regression we're guarding.
 *
 * REQUIRED locks:
 *   - section heading literal
 *   - heading order: POC-First BEFORE 基本功能探針 BEFORE Spike Workflow
 *   - dual-condition key phrases (both conditions of the AND gate)
 *   - exclusion list key phrases
 *   - cooperative-only enforcement marker
 * FORBIDDEN guards: none (positive-presence only for this gate)
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const targetPath = repoPath(".devpro/agent-rules/testing-and-qa.md");
// §Source Repo Test Runtime Budget body lives in this Load-chain leaf (moved verbatim);
// the entry keeps the heading and one MUST pointer line.
const cadencePath = repoPath(".devpro/agent-rules/test-suite-cadence.md");

const POC_HEADING = "### POC-First Trigger Gate";
const FUNCTIONAL_PROBE_HEADING = "### 基本功能探針 Gate（方法未證前先測真路徑）";
const SPIKE_HEADING = "### Spike Workflow";
const RUNTIME_BUDGET_HEADING = "### Source Repo Test Runtime Budget";
const HOTFIX_HEADING = "### Hotfix 延後補齊條款";

const content = readFileSync(targetPath, "utf8");
const lines = content.split("\n");
const cadenceLines = readFileSync(cadencePath, "utf8").split("\n");

const pocLineIndex = lines.findIndex((l) => l.startsWith(POC_HEADING));
const functionalProbeLineIndex = lines.findIndex((l) => l.startsWith(FUNCTIONAL_PROBE_HEADING));
const spikeLineIndex = lines.findIndex((l) => l.startsWith(SPIKE_HEADING));
const runtimeBudgetLineIndex = cadenceLines.findIndex((l) => l.startsWith(RUNTIME_BUDGET_HEADING));
const entryRuntimeBudgetLineIndex = lines.findIndex((l) => l.startsWith(RUNTIME_BUDGET_HEADING));
const hotfixLineIndex = lines.findIndex((l) => l.startsWith(HOTFIX_HEADING));

// Extract the POC-First section (from its heading up to the Basic Functional Probe heading)
const pocSection =
  pocLineIndex === -1
    ? null
    : lines
        .slice(
          pocLineIndex,
          functionalProbeLineIndex === -1 ? undefined : functionalProbeLineIndex,
        )
        .join("\n");

const functionalProbeSection =
  functionalProbeLineIndex === -1
    ? null
    : lines
        .slice(
          functionalProbeLineIndex,
          spikeLineIndex === -1 ? undefined : spikeLineIndex,
        )
        .join("\n");

// Bounded by the next same-or-higher heading, so a later section of the leaf (the gate／release
// suite exclusivity section) cannot supply this section's required phrases.
const runtimeBudgetSection =
  runtimeBudgetLineIndex === -1
    ? null
    : headedSectionLines(cadenceLines, cadenceLines[runtimeBudgetLineIndex]).join("\n");

// 定稿文字見 openspec change refactor-test-suite-cadence-leaf 的 design D2／D3。情境清單是一組值：
// 整行相等同時擋住漏列、多列，以及把無條件句接回「未讀」條件之後。
const ENTRY_CADENCE_POINTER =
  "> Load-chain（test suite cadence）：選 tier、跑 `run-test-suite.mjs`（`--tier unit`／`--tier fast`／`--changed <base>`／`--tier all`）、歸類新測試的 unit／integration、新增或修改觸及 spawn（git／hook／CLI／repo scan）的測試、交 final suite 或 merge 測試證據、審查測試證據（含判定某項證據缺席是否構成 finding）之前 MUST 先讀 `test-suite-cadence.md`（test suite cadence SSOT）；未讀 MUST NOT 自行決定跑或不跑 `--tier all`。不論是否已讀，每次跑測試（含 focused RED／GREEN）MUST 回報耗時，MUST NOT 把 wall-clock 寫進驗收證據。";
const LEAF_LOAD_CHAIN =
  "> Load-chain（entry）：本檔是 `testing-and-qa.md` § Source Repo Test Runtime Budget 的條件 leaf；TDD、RED 證據與 QA 報告留在 entry。本檔「依下方 Exit Criteria 的 suite×HEAD／digest 綁定段」所指段落未隨本檔搬移：指 entry `testing-and-qa.md` `## Exit Criteria` 的「測試證據為 suite×HEAD／digest 綁定」條。";

function lineStartBoldLabels(text) {
  return text
    .split("\n")
    .map((l) => l.match(/^(?:- )?\*\*([^*]+)\*\*/)?.[1])
    .filter(Boolean);
}

// 入口與 leaf 兩邊都只看行首粗體標籤再取交集；子字串比對會命中一般敘述（入口指標行本來就含 `--tier all`）。
function restatedCadenceLabels(entryText, cadenceSectionText) {
  const entryLabels = new Set(lineStartBoldLabels(entryText));
  return lineStartBoldLabels(cadenceSectionText).filter((label) => entryLabels.has(label));
}

// ── Heading existence ─────────────────────────────────────────────────────────

test("testing-and-qa.md 存在「### POC-First Trigger Gate」heading", () => {
  assert.ok(
    pocLineIndex !== -1,
    `找不到「${POC_HEADING}」— POC-First Trigger Gate 條款已被移除（不可靜默 trim）`,
  );
});

test("testing-and-qa.md 存在「### Spike Workflow」heading", () => {
  assert.ok(
    spikeLineIndex !== -1,
    `找不到「${SPIKE_HEADING}」— Spike Workflow heading 消失（heading 順序驗證前置條件）`,
  );
});

test("testing-and-qa.md 存在「### 基本功能探針 Gate（方法未證前先測真路徑）」heading", () => {
  assert.ok(
    functionalProbeLineIndex !== -1,
    `找不到「${FUNCTIONAL_PROBE_HEADING}」— 基本功能探針 Gate 條款已被移除`,
  );
});

// ── Heading order ─────────────────────────────────────────────────────────────

test("POC-First Trigger Gate heading 出現在基本功能探針與 Spike Workflow heading 之前", () => {
  assert.ok(
    pocLineIndex !== -1 && functionalProbeLineIndex !== -1 && spikeLineIndex !== -1,
    "三個 heading 皆須存在才能驗證順序",
  );
  assert.ok(
    pocLineIndex < functionalProbeLineIndex && functionalProbeLineIndex < spikeLineIndex,
    `heading 順序錯誤：應為 POC-First（第 ${pocLineIndex + 1} 行）→ 基本功能探針（第 ${functionalProbeLineIndex + 1} 行）→ Spike Workflow（第 ${spikeLineIndex + 1} 行）`,
  );
});

// ── Section exists (pre-condition for phrase checks) ─────────────────────────

test("POC-First Trigger Gate 小節可擷取（heading 到 Spike Workflow 之間有內容）", () => {
  assert.ok(
    pocSection && pocSection.trim().length > POC_HEADING.length,
    "POC-First 小節內容為空——條款主體被清除",
  );
});

// ── Dual-condition key phrases ────────────────────────────────────────────────

const DUAL_CONDITION_PHRASES = [
  "對本 repo 未驗證",
  "≥2 處",
  "兩條件皆成立",
];

for (const phrase of DUAL_CONDITION_PHRASES) {
  test(`POC-First 小節 必含雙條件 phrase："${phrase}"`, () => {
    assert.ok(
      pocSection.includes(phrase),
      `雙條件 AND gate 完整性受損：「${phrase}」missing — POC-First 觸發條件可能被弱化（trim 前須走 amend change 並更新本 phrase list）`,
    );
  });
}

// ── Exclusion list key phrases ────────────────────────────────────────────────

// All five exclusion-list items (codex cross-model review on PR #952: the
// comment claims to guard the exclusion list, so assert every item rather than
// a representative subset).
const EXCLUSION_PHRASES = [
  "修 bug",
  "加欄位",
  "熟悉 API 的例行變更",
  "單點且可輕易回退",
  "已有同類驗證先例",
];

for (const phrase of EXCLUSION_PHRASES) {
  test(`POC-First 小節 必含排除清單 phrase："${phrase}"`, () => {
    assert.ok(
      pocSection.includes(phrase),
      `排除清單完整性受損：「${phrase}」missing — 過度要求 POC 的保護語被移除（trim 前須走 amend change 並更新本 phrase list）`,
    );
  });
}

// ── Cooperative-only enforcement marker ──────────────────────────────────────

test('POC-First 小節 必含 cooperative-only 標記 "[cooperative-only, weak enforcement]"', () => {
  assert.ok(
    pocSection.includes("[cooperative-only, weak enforcement]"),
    '執行強度標記「[cooperative-only, weak enforcement]」missing — 若此 gate 被升格為 hard enforcement 須重新評估 false-positive 衝擊',
  );
});

const FUNCTIONAL_PROBE_PHRASES = [
  "基本功能探針",
  "外部介接邊界",
  "API / CLI / SDK / webhook / network service / auth / file or stream I/O / process spawn",
  "最小真路徑 probe",
  "host / auth / sandbox / hook / runner / process spawn",
  "HTTP request",
  "SDK call",
  "CLI command",
  "webhook payload",
  "MUST NOT 擴大到大批 spec、tests、docs 或 cross-carrier 同步",
  "probe 通過後，才進 OpenSpec / TDD / 測試契約更新",
  "exact command、log path、exit code / verdict",
];

for (const phrase of FUNCTIONAL_PROBE_PHRASES) {
  test(`基本功能探針 Gate 必含 phrase："${phrase}"`, () => {
    assert.ok(
      functionalProbeSection?.includes(phrase),
      `基本功能探針 Gate 完整性受損：「${phrase}」missing — 可能再次先寫大量 spec/tests 才發現基本功能不可行`,
    );
  });
}

// ── Source repo test runtime budget ──────────────────────────────────────────

test("test-suite-cadence.md 存在 Source Repo Test Runtime Budget heading", () => {
  assert.ok(
    runtimeBudgetLineIndex !== -1,
    `找不到「${RUNTIME_BUDGET_HEADING}」— source repo 測試時間預算條款已被移除`,
  );
});

const RUNTIME_BUDGET_PHRASES = [
  // Tier-aware execution semantics (replaced the old fixed 90s budget). These
  // anchor the three invariants of test-governance "Tier-Aware Test Execution":
  // classification MUST, tier-selection mechanics, and report-only timing.
  "tier-aware",
  "MUST 歸類為",
  "test-suite-manifest.mjs",
  "--changed",
  "fail closed",
  // Report-only full-suite timing: no fixed budget block, but a red suite still
  // fails. Lock both so a future author can't silently re-add a wall-clock block
  // or drop the red-suite exit.
  "report-only",
  "紅 suite",
  // Every test run must surface its wall-clock time.
  "回報耗時",
  "效能調查閉環（SSOT）",
  "Measurement-Driven Optimization Loop",
  // The section must keep a live pointer to the leaf that holds the patterns; a
  // dangling optimisation clause with no route to the knowledge is the
  // "prose without teeth" failure this whole series guards against.
  "test-performance-patterns.md",
];

for (const phrase of RUNTIME_BUDGET_PHRASES) {
  test(`Source Repo Test Runtime Budget 必含 phrase："${phrase}"`, () => {
    assert.ok(
      runtimeBudgetSection?.includes(phrase),
      `source repo 測試時間預算完整性受損：「${phrase}」missing — 新增測試可能重新拉長 full suite`,
    );
  });
}

const FAST_ADMISSION_PHRASES = [
  "PR latency fast gate",
  "Fast carrier admission",
  "unit` test **MUST NOT** 放進 fast set",
  "新核心載體／真路徑",
  "不得靠 glob 或自動把所有新 integration tests 塞入 fast set",
];

for (const phrase of FAST_ADMISSION_PHRASES) {
  test(`fast carrier admission 必含 phrase："${phrase}"`, () => {
    assert.ok(
      runtimeBudgetSection?.includes(phrase),
      `fast gate admission contract missing：${phrase}`,
    );
  });
}

// ── Test Performance Patterns leaf must carry the codified optimisation knowledge ─
// The three patterns + the anti-split reasoning live in a dedicated leaf (kept out
// of testing-and-qa.md to stay under the token budget). Locking these anchors
// prevents silent removal of the patterns that keep the suite in budget, and of
// the load-bearing "splitting files does not lower wall-clock on a CPU-bound suite"
// reasoning — without it a future author re-derives the (wrong) split approach.
const patternsPath = path.join(
  REPO_ROOT,
  ".devpro/agent-rules/test-performance-patterns.md",
);
const patternsContent = readFileSync(patternsPath, "utf8");

const PATTERN_LEAF_PHRASES = [
  "Test Performance Patterns",
  "昂貴 fixture 整檔共用一次",
  "shared fixture / marker-state failure",
  "fresh fixture or isolated marker/state dir",
  "多斷言合併到單次 spawn",
  "能 import 就別 spawn 整腳本",
  "CPU-bound",
  // BEFORE/AFTER snippet anchors: the concrete `before()` + cpSync template-reuse
  // shape is what an author actually copies; lock it so the patterns keep teeth.
  "cpSync",
  "before()",
  // Pattern (d): the single biggest lever this change found was source-side, not
  // in the test files — batching a per-item git spawn loop into one snapshot
  // (removeConsumerFile 350+→1, the bulk of 207→73s). Lock its anchors so the
  // "fix the source hotspot, not just the fixture" lesson can't silently rot.
  "迴圈內 per-item spawn 改一次 batch",
  "量體決定成效",
  // Polarity reversal: the leaf used to say focused CPU time is immune to
  // contention and can stand in for a quiet re-measure. It is not -- E-core
  // migration moved user 180->198s (+10%) under load. Lock the corrected
  // polarity, because the old one is the more intuitive claim and an author
  // re-deriving it from first principles will land on the wrong side.
  "CPU time 也失真",
  // The three agent STOP conditions. Each one exists because this repo spent a
  // measured attempt proving the tempting next move does not work; without an
  // anchor the next author pays that cost again.
  "倍率不降≠可再拆",
  "排程重排非解方",
  "spawn-overhead-bound",
  // The memo's fail-open invariant: caching a FAILED probe would convert one
  // transient git error into a process-lifetime wrong answer for every later
  // caller, including the fail-closed one.
  "只快取成功值以保 fail-open",
];

for (const phrase of PATTERN_LEAF_PHRASES) {
  test(`test-performance-patterns.md 必含 phrase："${phrase}"`, () => {
    assert.ok(
      patternsContent.includes(phrase),
      `測試效能 pattern SSOT 完整性受損：「${phrase}」missing — 新增測試可能重新拉長 full suite`,
    );
  });
}

const PERFORMANCE_LOOP_PHRASES = [
  "Measurement-Driven Optimization Loop",
  "Canonical baseline",
  "performance-investigation.md",
  "effective parallelism",
  "局部 POC 的改善**不可相加**",
  "連續兩個局部 POC",
  "架構／執行邊界",
  "handoff-grade evidence",
];

for (const phrase of PERFORMANCE_LOOP_PHRASES) {
  test(`test-performance-patterns.md 閉環必含 phrase："${phrase}"`, () => {
    assert.ok(
      patternsContent.includes(phrase),
      `測試效能閉環 SSOT 完整性受損：「${phrase}」missing — 後續接手者可能重新走未量測的 micro-optimization 冤枉路`,
    );
  });
}

test("general performance investigation validates work and keeps or reverts one hypothesis", () => {
  const method = readFileSync(repoPath(".devpro/agent-rules/performance-investigation.md"), "utf8");
  assert.match(method, /MUST 先驗正確輸出、成功／錯誤數與計時區間內實際完成的工作/);
  assert.match(method, /MUST 一次只改一個可回退假設/);
  assert.match(method, /未成立 MUST 完整撤回該候選/);
  assert.match(method, /錯誤或副作用契約尚未核准的改變 MUST 先撤回/);
  assert.match(method, /MUST NOT 將無效工作、全部報錯或雜訊當成改善/);
  assert.match(method, /不設固定迭代次數/);
  for (const rel of ["AGENTS.md", "README.md", ".devpro/agent-rules/testing-and-qa.md", ".devpro/agent-rules/troubleshooting.md", ".devpro/agent-rules/project-verification.md"]) {
    assert.match(readFileSync(repoPath(rel), "utf8"), /performance-investigation\.md/, rel);
  }
});

test("RED Evidence Quality rejects shared fixture/state leakage until isolated", () => {
  for (const phrase of [
    "shared fixture / marker-state failure",
    "fresh fixture or isolated marker/state dir",
    "不得把 shared-state leakage 當作 behavior RED",
  ]) {
    assert.ok(
      content.includes(phrase),
      `testing-and-qa.md missing shared-state RED evidence guard phrase: ${phrase}`,
    );
  }
});

// ── Real runtime measurement gate must exist (not just prose) ────────────────
// This is the anti-fake-gate lock: the full-suite runtime is measured by an
// ACTUAL wall-clock script, not only by the grep-for-text checks above. Under
// tier-aware execution this gate is REPORT-ONLY (no fixed-budget block), but it
// must still measure real time and still fail a red suite — a report that lies
// about a red suite is worse than no report.
test("check-suite-runtime-budget.mjs gate 腳本存在（真量測 real time，report-only）", () => {
  const gatePath = repoPath(".devpro/scripts/check-suite-runtime-budget.mjs");
  const gateSrc = readFileSync(gatePath, "utf8");
  assert.ok(
    gateSrc.includes("process.hrtime.bigint()"),
    "gate 必須用 process.hrtime 量真實 wall-clock，而非 parse 自報 duration_ms",
  );
  // Report-only: it must NOT re-introduce a fixed wall-clock budget block or a
  // bypass env var. Those are exactly the semantics the tier-aware change removed.
  assert.ok(
    !gateSrc.includes("DEFAULT_BUDGET_SECONDS"),
    "gate 已改 report-only，不得再有固定預算常數 DEFAULT_BUDGET_SECONDS",
  );
  assert.ok(
    !gateSrc.includes("DEVPRO_SUITE_BUDGET_BYPASS"),
    "gate 已改 report-only，不得再有 budget bypass 逃生門",
  );
  // Red suite still fails: process.exit(1) must remain for the failing-suite path.
  assert.ok(
    gateSrc.includes("process.exit(1)"),
    "紅 suite（有 fail）仍必須 exit 1——report-only 不代表放行紅 suite",
  );
  assert.ok(
    gateSrc.includes("report-only"),
    "gate 必須自陳 report-only 語義",
  );
});

// ── Runtime gate must be WIRED INTO the pre-pr flow, not just exist ───────────
// A gate script that no flow references is dead code. Under tier-aware execution
// the pre-pr flow references it as the report-only full-suite timing check; lock
// that `/dp:pre-pr` still names it so it can't silently drop off the flow.
test("check-suite-runtime-budget.mjs 已 wire 進 /dp:pre-pr flow（非死碼 gate）", () => {
  const prePrPath = path.join(
    REPO_ROOT,
    ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
  );
  const prePrSrc = readFileSync(prePrPath, "utf8");
  assert.ok(
    prePrSrc.includes("check-suite-runtime-budget.mjs"),
    "/dp:pre-pr 必須引用 check-suite-runtime-budget.mjs（report-only 全量計時）——引用消失 = 死碼",
  );
  // And the tier-aware runner must be the pre-pr default test path.
  assert.ok(
    prePrSrc.includes("run-test-suite.mjs --changed"),
    "/dp:pre-pr 必須以 tier-aware runner（run-test-suite.mjs --changed）為預設測試路徑",
  );
});

// ── Test suite manifest SSOT + lint + subset runner ─────────────────────────

test("testing-and-qa.md 入口保留 Source Repo Test Runtime Budget 標題與 MUST Load-chain 指標，不複寫本文", () => {
  assert.ok(
    entryRuntimeBudgetLineIndex !== -1,
    `入口找不到「${RUNTIME_BUDGET_HEADING}」— 從入口看不到 test suite cadence 的去處`,
  );
  const nextHeadingOffset = lines
    .slice(entryRuntimeBudgetLineIndex + 1)
    .findIndex((l) => l.startsWith("### "));
  assert.ok(nextHeadingOffset !== -1, "入口的 runtime budget 標題之後必須還有下一個 ### 標題");
  const entrySection = lines.slice(
    entryRuntimeBudgetLineIndex + 1,
    entryRuntimeBudgetLineIndex + 1 + nextHeadingOffset,
  );
  const body = entrySection.filter((l) => l.trim() !== "");
  assert.equal(body.length, 1, "入口這一節只留一行 Load-chain 指標");
  assert.equal(
    body[0],
    ENTRY_CADENCE_POINTER,
    "入口指標必須與定稿整行相等（情境清單、先讀義務、兩句無條件規定缺一不可）",
  );
  const restated = restatedCadenceLabels(content, runtimeBudgetSection ?? "");
  assert.deepEqual(restated, [], `入口不得複寫已搬到 leaf 的行首粗體標籤：${restated.join("、")}`);
});

test("restatedCadenceLabels 守門雙向 fixture：複寫 leaf bullet 會被抓到，一般敘述提到標籤名不會", () => {
  const cadenceLabels = lineStartBoldLabels(runtimeBudgetSection ?? "");
  assert.ok(
    cadenceLabels.length >= 15,
    `leaf 取出的行首粗體標籤只有 ${cadenceLabels.length} 個——取標籤的 regex 失效會讓守門空轉`,
  );
  const copied = cadenceLines.filter((l) => l.startsWith("- **Fast carrier admission"));
  assert.equal(copied.length, 1, "fixture 需要 leaf 內恰好一行 Fast carrier admission bullet");
  assert.deepEqual(
    restatedCadenceLabels(`${content}\n${copied[0]}\n`, runtimeBudgetSection),
    [lineStartBoldLabels(copied[0])[0]],
    "正例：入口貼入 leaf 的真實 bullet 必須被回報",
  );
  // leaf 的標籤有 bullet 形（`- **…**`）與段落形（`**…**`）兩種；兩種各釘一筆正例，regex 改窄成只認其一時會轉紅。
  const copiedParagraph = cadenceLines.filter((l) => l.startsWith("**每次跑 tests MUST 回報耗時**"));
  assert.equal(copiedParagraph.length, 1, "fixture 需要 leaf 內恰好一行以「每次跑 tests MUST 回報耗時」粗體開頭的段落");
  assert.deepEqual(
    restatedCadenceLabels(`${content}\n${copiedParagraph[0]}\n`, runtimeBudgetSection),
    ["每次跑 tests MUST 回報耗時"],
    "正例（段落形）：入口貼入 leaf 以粗體開頭的段落必須被回報",
  );
  assert.deepEqual(
    restatedCadenceLabels(content, runtimeBudgetSection),
    [],
    "反例一：入口現況（指標行含 `--tier all` 的一般敘述）不得被回報",
  );
  assert.deepEqual(
    restatedCadenceLabels(
      `${content}\nWorker 與 Canonical owner 的分工、何時跑 \`--tier all\`，都寫在 leaf。\n`,
      runtimeBudgetSection,
    ),
    [],
    "反例二：不以粗體開頭、只在句中提到標籤名的敘述不得被回報",
  );
});

test("test-suite-cadence.md 的 Load-chain 行註明「下方 Exit Criteria」所指的 entry 段落", () => {
  const loadChain = cadenceLines.filter((l) => l.startsWith("> Load-chain（entry）："));
  assert.equal(loadChain.length, 1, "leaf 必須恰有一行 Load-chain（entry）");
  assert.equal(loadChain[0], LEAF_LOAD_CHAIN, "leaf 的 Load-chain 行必須與定稿整行相等");
  const referring = (runtimeBudgetSection ?? "").split("依下方 Exit Criteria 的 suite×HEAD／digest 綁定段").length - 1;
  assert.equal(referring, 1, `被搬段落內該句必須恰好出現一次，實際 ${referring} 次`);
  const exitHeadings = lines.reduce((acc, l, i) => (l === "## Exit Criteria" ? [...acc, i] : acc), []);
  assert.equal(exitHeadings.length, 1, "入口必須恰有一個「## Exit Criteria」標題");
  const afterExit = lines.slice(exitHeadings[0] + 1);
  const nextTop = afterExit.findIndex((l) => l.startsWith("## "));
  const exitSection = nextTop === -1 ? afterExit : afterExit.slice(0, nextTop);
  const targets = exitSection.filter((l) => l.startsWith("- **測試證據為 suite×HEAD／digest 綁定**："));
  assert.equal(
    targets.length,
    1,
    `入口「## Exit Criteria」內該條必須恰好一行，實際 ${targets.length} 行`,
  );
});

test("Full-Suite Verdict Recipe 的 canonical runner 指向 test-suite-cadence.md", () => {
  const hits = lines.filter((l) => l.includes("正常 full-suite timing 使用"));
  assert.equal(hits.length, 1, "Verdict Recipe 必須恰有一行說明正常 timing 的去處");
  assert.ok(
    hits[0].includes("正常 full-suite timing 使用 `test-suite-cadence.md` 的 canonical runner；"),
    "搬移後「上方」已無對象，必須點名 leaf",
  );
});

const MANIFEST_RUNTIME_PHRASES = [
  "test-suite-manifest.mjs",
  "lint-test-suite-manifest.mjs",
  "run-test-suite.mjs",
];

for (const phrase of MANIFEST_RUNTIME_PHRASES) {
  test(`Source Repo Test Runtime Budget 必含 manifest phrase："${phrase}"`, () => {
    assert.ok(
      runtimeBudgetSection?.includes(phrase),
      `test suite manifest 接線完整性受損：「${phrase}」missing — pre-PR unit subset 指引可能被移除`,
    );
  });
}

test("manifest phrase locks are non-vacuous (remove phrase then fail)", () => {
  assert.ok(runtimeBudgetSection, "runtime budget section 必須存在");
  for (const phrase of MANIFEST_RUNTIME_PHRASES) {
    const mutated = runtimeBudgetSection.split(phrase).join("");
    assert.ok(
      !mutated.includes(phrase),
      `測試前提失敗：mutated section 仍包含「${phrase}」`,
    );
    assert.ok(
      runtimeBudgetSection.includes(phrase),
      `原始 section 應包含「${phrase}」`,
    );
  }
});

test("lint-test-suite-manifest.mjs 與 test-suite-manifest.mjs 腳本存在", () => {
  const lintPath = repoPath(".devpro/scripts/lint-test-suite-manifest.mjs");
  const manifestPath = repoPath(".devpro/scripts/test-suite-manifest.mjs");
  assert.ok(readFileSync(lintPath, "utf8").includes("lintManifest"));
  assert.ok(readFileSync(manifestPath, "utf8").includes("export const MANIFEST"));
});

// ── Test Contract vs Requirement Semantics ────────────────────────────────────

const TEST_CONTRACT_HEADING = "### Test Contract vs Requirement Semantics";
const testContractLineIndex = lines.findIndex((l) => l.startsWith(TEST_CONTRACT_HEADING));
const runtimeBudgetForContractIndex = lines.findIndex((l) =>
  l.startsWith(RUNTIME_BUDGET_HEADING),
);
const testContractSection =
  testContractLineIndex === -1
    ? null
    : lines
        .slice(
          testContractLineIndex,
          runtimeBudgetForContractIndex === -1 ? undefined : runtimeBudgetForContractIndex,
        )
        .join("\n");

test("testing-and-qa.md 存在「### Test Contract vs Requirement Semantics」heading", () => {
  assert.ok(
    testContractLineIndex !== -1,
    `找不到「${TEST_CONTRACT_HEADING}」— Test Contract vs Requirement Semantics 條款已被移除`,
  );
});

const TEST_CONTRACT_PHRASES = [
  "legacy test",
  "不得凌駕",
  "update the test contract",
];

for (const phrase of TEST_CONTRACT_PHRASES) {
  test(`Test Contract vs Requirement Semantics 必含 phrase："${phrase}"`, () => {
    assert.ok(
      testContractSection?.includes(phrase),
      `測試契約語義完整性受損：「${phrase}」missing — legacy test 可能再次凌駕正確需求`,
    );
  });
}

test("test contract phrase locks are non-vacuous (remove phrase then fail)", () => {
  assert.ok(testContractSection, "test contract section 必須存在");
  for (const phrase of TEST_CONTRACT_PHRASES) {
    const mutated = testContractSection.split(phrase).join("");
    assert.ok(
      !mutated.includes(phrase),
      `測試前提失敗：mutated section 仍包含「${phrase}」`,
    );
    assert.ok(
      testContractSection.includes(phrase),
      `原始 section 應包含「${phrase}」`,
    );
  }
});

// ── Gate／release suite exclusivity: one owner, one pointer ───────────────────
//
// The section moved verbatim from test-performance-patterns.md to the cadence leaf
// (refactor-suite-exclusivity-to-cadence-leaf): it constrains running a gate or
// release suite, which is the cadence leaf's subject. The source file keeps one pointer
// line and must not restate the forbidden-operation list.

const EXCLUSIVITY_HEADING = "### Gate／release 級套件：同 repo exclusivity（正確性 ≠ 量測安靜）";
const EXCLUSIVITY_POINTER =
  "> gate／release 級套件的同 repo exclusivity（正確性要求；量測安靜 ≠ exclusivity）見 `test-suite-cadence.md` §Gate／release 級套件：同 repo exclusivity。";
const MEASUREMENT_ISOLATION_POINTER = "> 上段所稱「量測隔離」見 `test-performance-patterns.md` §量測隔離（wall-clock 前置）。";
const performancePatternLines = readFileSync(repoPath(".devpro/agent-rules/test-performance-patterns.md"), "utf8").split("\n");

// The section body: from its heading to the next heading of the same or a higher level.
function headedSectionLines(docLines, heading) {
  const start = docLines.indexOf(heading);
  if (start === -1) return null;
  let end = start + 1;
  while (end < docLines.length && !/^#{1,3} /.test(docLines[end])) end += 1;
  return docLines.slice(start, end);
}

test("fixtures: headedSectionLines stops at the next heading and reports a missing one", () => {
  const doc = ["## A", EXCLUSIVITY_HEADING, "", "body MUST NOT", "#### deeper", "more", "## Verification", "tail"];
  assert.deepEqual(headedSectionLines(doc, EXCLUSIVITY_HEADING), [EXCLUSIVITY_HEADING, "", "body MUST NOT", "#### deeper", "more"]);
  assert.equal(headedSectionLines(["## A", "Gate／release 級套件：同 repo exclusivity 見別處"], EXCLUSIVITY_HEADING), null);
  // A sibling heading of the same level ends the section too; without this the runtime budget
  // slice would run on into the exclusivity section that follows it.
  assert.deepEqual(headedSectionLines(["### 前一段", "body", "### 另一段", "other"], "### 前一段"), ["### 前一段", "body"]);
});

test("test-suite-cadence.md owns the gate／release suite exclusivity MUST", () => {
  const section = headedSectionLines(cadenceLines, EXCLUSIVITY_HEADING);
  assert.ok(section, "test-suite-cadence.md 找不到 exclusivity 段標題");
  const prose = section.join("\n");
  // Polarity and object bound on one physical line (rule-anchor-guard-strength.md).
  assert.equal(
    section.filter((l) => /同一個 git repo \*\*MUST NOT\*\* 並行執行會變更 shared live topology 的操作/.test(l)).length,
    1,
    "exclusivity 段的主句必須在同一行寫明 MUST NOT 與受詞",
  );
  for (const anchor of ["`git worktree add`／`git worktree remove`", "`git merge`", "disruptive `git checkout`／`git switch`", "量測安靜 ≠ exclusivity"]) {
    assert.ok(prose.includes(anchor), `exclusivity 段缺少「${anchor}」`);
  }
  // The section says 「量測隔離」 but that term is defined in the source file: the leaf carries one
  // line pointing back, and the heading it names has to exist there.
  assert.equal(section.filter((l) => l === MEASUREMENT_ISOLATION_POINTER).length, 1, "exclusivity 段之後應恰有一行「量測隔離」回指");
  assert.equal(
    performancePatternLines.filter((l) => l === "## 量測隔離（wall-clock 前置）").length,
    1,
    "回指所指的標題必須存在於 test-performance-patterns.md",
  );
});

// Lines that restate the rule itself in the source file: the main sentence, or any of the three
// forbidden-operation list items. A plain mention of a git command elsewhere is not a restatement.
function restatedExclusivityLines(docLines) {
  return docLines.filter(
    (l) =>
      l.includes("並行執行會變更 shared live topology 的操作") ||
      (l.startsWith("- ") &&
        (l.includes("`git worktree add`／`git worktree remove`") ||
          l.includes("`git merge`（含把其他 ref 合進") ||
          l.includes("disruptive `git checkout`／`git switch`"))),
  );
}

test("fixtures: restatedExclusivityLines catches the moved rule text and passes a pointer or a plain mention", () => {
  const moved = [
    "量測隔離只保證 wall-clock 可信；對 gate／release 級套件跑期間，同一個 git repo **MUST NOT** 並行執行會變更 shared live topology 的操作：",
    "- `git worktree add`／`git worktree remove`",
    "- `git merge`（含把其他 ref 合進此 repo 任一 worktree）",
    "- 會切換／覆寫 shared checkout 狀態的 disruptive `git checkout`／`git switch`（含帶 pathspec 物化）",
  ];
  assert.deepEqual(restatedExclusivityLines(moved), moved);
  assert.deepEqual(
    restatedExclusivityLines([EXCLUSIVITY_POINTER, "- fixture 收尾用 `git worktree remove` 清掉暫存 worktree", "跑完後 git merge 回主線"]),
    [],
  );
});

test("test-performance-patterns.md points at the exclusivity section instead of restating it", () => {
  assert.equal(headedSectionLines(performancePatternLines, EXCLUSIVITY_HEADING), null, "exclusivity 段只能存在於一個檔");
  assert.equal(performancePatternLines.filter((l) => l === EXCLUSIVITY_POINTER).length, 1, "應恰有一行指標");
  assert.deepEqual(restatedExclusivityLines(performancePatternLines), [], "來源檔不得重述規則主句或禁止操作清單");
});

// test-governance "Gate Suite Repo Exclusivity" names the rule file that holds the operator
// prose. When the section moves, that sentence has to move with it (the first attempt at this
// move missed it), so resolve the named file and require the section heading there.
function exclusivityProseOwner(specText) {
  const start = specText.indexOf("### Requirement: Gate Suite Repo Exclusivity\n");
  if (start === -1) return null;
  const rest = specText.slice(start + 1);
  const next = rest.search(/\n### Requirement: /);
  const block = next === -1 ? rest : rest.slice(0, next);
  return [...block.matchAll(/Normative prose for operators lives in \x60([^\x60]+)\x60/g)].map((m) => m[1]);
}

test("fixtures: exclusivityProseOwner reads only the Gate Suite Repo Exclusivity requirement", () => {
  const other = "### Requirement: Other\n\nNormative prose for operators lives in `x.md`.\n";
  const own = "### Requirement: Gate Suite Repo Exclusivity\n\nBody. Normative prose for operators lives in `a.md` under gate/release exclusivity.\n\n";
  assert.deepEqual(exclusivityProseOwner(own + other), ["a.md"]);
  assert.deepEqual(exclusivityProseOwner(other + own), ["a.md"]);
  assert.equal(exclusivityProseOwner(other), null);
});

test("the test-governance spec names the file that actually holds the exclusivity section", () => {
  const owners = exclusivityProseOwner(readFileSync(repoPath("openspec/specs/test-governance/spec.md"), "utf8"));
  assert.deepEqual(owners, ["test-suite-cadence.md"]);
  const named = readFileSync(repoPath(`.devpro/agent-rules/${owners[0]}`), "utf8").split("\n");
  assert.ok(headedSectionLines(named, EXCLUSIVITY_HEADING), "spec 點名的檔必須含 exclusivity 段標題");
});
