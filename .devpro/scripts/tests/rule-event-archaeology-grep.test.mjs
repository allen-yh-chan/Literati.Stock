/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: that the listed incident references (PR, issue and review-round numbers)
 * stay out of the named rule carriers, including `ai-autonomy.md` and
 * `design-core.md`, while the surviving rule sentence is kept.
 * Does NOT prove: that no other incident reference was added elsewhere in those
 * carriers, or that a reworded reference is caught. Review owns that half.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";

// #2858: a rule's force comes from its reason, not from the PR / issue / review-round number of the
// incident that prompted it. Opus-class models copy the incident numbers into new text and treat the
// rule as tied to that one event. Each entry removes only the event reference and keeps the rule
// (`keep` is the surviving sentence, so deleting the whole clause fails too).
// Kept on purpose, so not listed here: `design-core.md` / `token-frugal-io.md` retrospective anchors
// that structural-backstop-meta-grep and token-frugal-exploratory-rg-grep point at, adapter
// `截至 <date>` verification dates, and `[^align-434]` in chore-classification.md (a footnote that
// is the cited evidence for the row, not an inline attribution).

const agentRuntimeGap = {
  forbidden: ["issue #489", "audit F21"],
  keep: ["（runtime gap）。本約束 main agent 才有 hook 兜底；subagent 必須**自律**"],
};

const cases = [
  { file: ".claude/agents/dp-analyst.md", ...agentRuntimeGap },
  { file: ".claude/agents/dp-architect.md", ...agentRuntimeGap },
  { file: ".claude/agents/dp-assistant.md", ...agentRuntimeGap },
  { file: ".claude/agents/dp-programmer.md", ...agentRuntimeGap },
  { file: ".claude/agents/dp-reviewer.md", ...agentRuntimeGap },
  {
    file: ".devpro/agent-rules/ai-autonomy.md",
    forbidden: ["PR #13 class", "PR #494", "PR #334", "Discussion #336", "issue #851", "PR #13（#498）"],
    keep: [
      "dp-reviewer 比對 stale baseline。對應 `devpro:pre-pr` Pre-flight stale-main check 的 cycle 起點 backstop。",
      "cooperative-only 在 context pressure 下會失靈。Hook 是 backstop 不是主紀律",
      "coauthor brand marker → **block**（常見失誤是補了 footer 卻留 coauthor 行，被 coauthor block 吃第二次拒絕）。",
      "對應 §Remind 例外：sandbox refusal 後 op 已非 AI-actionable）。",
    ],
  },
  {
    file: ".devpro/agent-rules/chore-classification.md",
    forbidden: ["PR #434 evidence"],
    keep: ["dp-reviewer 軸 1 root-cause adequacy 會 partial。 |"],
  },
  {
    file: ".devpro/agent-rules/code-review-cross-model.md",
    forbidden: ["PR #2407"],
    keep: ["change 以 proposal Touch 宣告並受審的 review-infra 變更不在此限。renderer 對"],
  },
  {
    file: ".devpro/agent-rules/design-core.md",
    forbidden: ["本 PR T5 Skills"],
    keep: ["> _Anchor: 無法說明真實 user benefit、只是 ease-driven 架構潔癖的「全遷移」方案，本原則明示禁止。_"],
  },
  {
    file: ".devpro/agent-rules/git-branch-hygiene.md",
    forbidden: ["issue #1287", "release PR #1286"],
    keep: ["> protected `main` 殘留髒檔時，步驟 2 `git pull --ff-only --autostash` 可乾淨收尾。"],
  },
  {
    file: ".devpro/agent-rules/git-pr-template-and-merge.md",
    forbidden: ["PR #855", "issue #853", "issue #851", "PR #2733", "#2818", "#2714", "#2807"],
    keep: [
      "auto-close 關鍵字必須**裸文字**。 |",
      "（實例：PR body 寫 `` `Fixes #N` `` → `closingIssuesReferences` 全程為 `[]` → issue 需 TL 手動關）",
      "**須主動移除**該行（常見失誤是「補了 footer 卻留 coauthor」吃第二次拒絕）。",
      "（實例：`Close #12 / #34` → 只 auto-close #12，#34 需手動關）",
      "（實例：只寫 `issue: #N`，PR body 沒有關鍵字）",
      "GitHub 通常只認第一個 `#N`（`Close #12 / #34` 只關 #12）。",
    ],
  },
  {
    file: ".devpro/agent-rules/rule-design-principles.md",
    forbidden: ["本 PR CR-15", "PR #394 加之 C 段", "PR #402"],
    keep: [
      "> _Anchor: cache-friendly 原則分層：shared rule 只定義穩定 prefix / deferred-loading 策略，具體 metric 與驗證路徑落在 adapter。_",
      "C 段反規條（「PR 已建立，待使用者 merge」）由 hook A 強制，不靠 cooperative-only phrasing。",
      "**反例**：`pre-tool-gate.mjs` Gate 2b 原始 reason",
    ],
  },
  {
    file: ".devpro/agent-rules/preflight-checklist.md",
    forbidden: ["T17，done-when", "PR #382"],
    keep: ["> _Anchor: done-when 需先過 senior-engineer self-check；勾選前驗收見 `openspec-quality-and-formats.md` §Tasks Quality。_", "real user data 落入 git history 後續無法清除。**Mechanical gate bac"],
  },
  {
    file: ".devpro/agent-rules/token-frugal-io.md",
    forbidden: ["本 PR T15"],
    keep: ["> _Anchor: CJK 字詞密度高，但冗詞仍會放大 context。_"],
  },
  {
    // Full-rigor steps moved to references/full-review-and-archive.md; their kept sentences are asserted on the next entry.
    file: ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
    forbidden: ["F-r3-override-claim-proof-untracked", "#1968", "#1971", "PR #749", "PR #755", "issue #170", "PR #93", "F-r3-scenario-walkthrough-scope-gap", "PR #2635", "PR #2473", "issue #848"],
    keep: [],
  },
  {
    file: ".devpro/agent-skills/devpro-workflows/pre-pr/references/full-review-and-archive.md",
    forbidden: ["F-r3-override-claim-proof-untracked", "#1968", "#1971", "PR #749", "PR #755", "issue #170", "PR #93", "F-r3-scenario-walkthrough-scope-gap", "PR #2635", "PR #2473", "issue #848"],
    keep: [
      "（ledger 若被追蹤而其 `.claim/` 消耗證據未被追蹤，乾淨 clone 會讓已消耗的 override 復活為 `issued`）",
      "full change 路徑亦同。作者合法形狀（restate／additive contiguous-insert；禁 new-scenario-only MODIFIED）",
      "豁免。`pre-pr-archive-gate.mjs` Gate (a) 不區分 chore 類型，active folder 一律 block",
      "Per `archive-tooling`/`Pre-PR Archive Gate Enforcement` requirement。",
      "這類同樣被 scenario 引用的閘腳本。`scenarios.test.mjs` 只驗 assertion 字串",
      "（對齊 archived `fix-codex-spawn-admission-bypass`）。舊句",
      "fail closed 並要求 untrack（舊的 blanket 豁免只配對「archive 側新增 ↔ active 側刪除」，未配對的新增可夾帶未審檔案）。",
      "**為何 `--specs` 而非 `--all`**：`--all` 會額外驗證",
    ],
  },
  {
    file: ".devpro/agent-skills/openspec/openspec-artifact-authoring/SKILL.md",
    forbidden: ["issue #2417"],
    keep: ["而不是等到 pre-PR Step 3 才回報。`classify-bounded` 現在會為 `risk_shape_unavailable` 附上封閉列舉"],
  },
  {
    file: ".devpro/agent-skills/devpro-reviews/second-review-dogfood/SKILL.md",
    forbidden: ["issue #1735"],
    keep: ["root_carrier_collision` (a reviewer that re-reads"],
  },
];

for (const { file, forbidden, keep } of cases) {
  const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
  test(`${file}: no incident reference`, () => {
    for (const token of forbidden) {
      assert.equal(text.includes(token), false, `${file} still cites the incident "${token}"`);
    }
  });
  test(`${file}: the rule itself is kept`, () => {
    for (const sentence of keep) {
      assert.ok(text.includes(sentence), `${file} lost its rule text: ${sentence}`);
    }
  });
}

// Class guard: the per-file cases above name the instances; this scan catches the same shape if it
// is re-added in any of the touched files. Kept on purpose (traceability tags that name the issue
// which introduced a requirement, e.g. `（#2495）`, test-locked examples such as
// `F-r19-mode-mismatch-message`, and generic example numbers) are not incident attributions and do
// not match. The one attribution that stays: token-frugal-io.md `issue #860 evidence`, which
// token-frugal-exploratory-rg-grep anchors.
const incidentAttribution =
  /(?:PR|issue|Issue)\s*#\d+(?:\s+dogfood\s+fail)?\s+evidence|本 repo\s*#\d+\s+evidence|實證\s*\d{4}-\d{2}-\d{2}\s*PR\s*#\d+|round-\d+ review F-r\d+|cross-model Critical/g;
const allowedAttribution = { "token-frugal-io.md": ["issue #860 evidence"] };

for (const { file } of cases) {
  test(`${file}: no incident attribution of the "X evidence" shape`, () => {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const allowed = allowedAttribution[path.basename(file)] ?? [];
    const found = [...text.matchAll(incidentAttribution)].map((m) => m[0]).filter((hit) => !allowed.includes(hit));
    assert.deepEqual(found, [], `${file} cites an incident as evidence: ${found.join(" | ")}`);
  });
}
