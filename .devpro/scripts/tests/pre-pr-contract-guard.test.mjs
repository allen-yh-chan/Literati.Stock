/**
 * pre-pr-contract-guard.test.mjs
 *
 * Locks high-stakes phrases from the pre-PR workflow SSOT so they cannot be
 * silently dropped during a refactor.
 *
 * Migration note (add-first-batch-user-invocable-skills): the `/dp:pre-pr`
 * content SSOT moved from `.claude/commands/dp/pre-pr*.md` to the cross-platform
 * `devpro:pre-pr` skill (`.devpro/agent-skills/devpro-workflows/pre-pr/`). This
 * guard now reads that skill's `SKILL.md` plus every file under its `references/`
 * (dispatch blocks were extracted there), so a phrase that lives in a reference
 * still counts. The thinned `.claude/commands/dp/pre-pr.md` redirect is no longer
 * scanned.
 *
 * The original 8 phrases were surfaced as Critical contract drops in PR #222
 * (chore: split /dp:pre-pr into route-first leaves) review. Two more (`Test
 * Evidence`, `驗收證據`) added by change `fix-pre-pr-pr-template-routing` to
 * lock the canonical PR template segment names against drift back to Claude
 * Code's default `## Summary` + `## Test plan` shape (PR #294 evidence). One
 * more (`enforcement 載體`) added by change
 * `strengthen-step25-trigger-cover-hook-scripts` to lock Step 2.5 trigger
 * 擴含 hooks/agents/commands 後『不只 .md 是 enforcement 載體』語意（原 10 +
 * 新 1，PR strengthen-step25-trigger-cover-hook-scripts evidence）. All are TL
 * decision-tree anchors that lose meaning if absent from any pre-pr file.
 *
 * Search strategy: read all files matching `.claude/commands/dp/pre-pr*.md`
 * and assert each phrase appears in at least one of them. Tolerates both
 * monolithic and route-first-index-plus-leaves shapes.
 *
 * Pattern derived from `doc-splitting-sop-guard.test.mjs` (introduced in
 * change `add-doc-splitting-sop`). Removing or renaming any guarded phrase
 * requires an amend change that updates this list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { repoPath } from "./lib/repo-root.mjs";

const PRE_PR_SKILL_DIR = repoPath(
  ".devpro/agent-skills/devpro-workflows/pre-pr",
);

const PHRASES = [
  {
    phrase: "依賴分支例外",
    purpose: "feature/A 依賴分支用 git log feature/A..HEAD 排除上游 commits 的合法路徑",
  },
  {
    phrase: "應用程式版號 bump",
    purpose: "feature/bugfix PR 內版號 bump 禁令 + 獨立 chore/bump-vX.Y.Z 路徑",
  },
  {
    phrase: "簡化修改的委派",
    purpose: "rename/move/dead code → assistant；extract/巢狀 → programmer；單處 → TL 三段決策",
  },
  {
    phrase: "豁免清單",
    purpose: "本單位 commits 認定的 sync/simplify/QA 三類豁免",
  },
  {
    phrase: "light review",
    purpose: "六軸審查降級條款（grep + H2 + diff 三步法 + PR 描述明示）",
  },
  {
    phrase: "Red Flag",
    purpose: "使用者口頭跳過 reviewer 屬 Red Flag，TL 必須拒絕",
  },
  {
    phrase: "rollback 計畫",
    purpose: "旁路分支 PR 描述條件式欄位",
  },
  {
    phrase: "gh run watch",
    purpose: "PR 建立後等 workflow 終態的工具用法",
  },
  {
    phrase: "Test Evidence",
    purpose: "Step 4 必須指向 git-pr-template-and-merge.md 第 47-71 行 canonical 模板 Test Evidence 段名（防 fallback 到 Claude Code 預設 Summary+Test plan 模板，PR #294 evidence 模板漂移 root cause）",
  },
  {
    phrase: "驗收證據",
    purpose: "Step 4 PR 描述必含 驗收證據 checklist 標題（3-5 條對應 Target State，每條附具體證據）— canonical 模板識別性 phrase，防 phrasing 漂移",
  },
  {
    phrase: "enforcement 載體",
    purpose: "Step 2.5 trigger 擴含 hooks/agents/commands 後，鎖『不只 .md 是 enforcement 載體』語意；防 split/refactor 漂移回 .md-only（PR strengthen-step25-trigger-cover-hook-scripts evidence）",
  },
  {
    phrase: "Ready Response Next-Step Contract",
    purpose: "Step 5.5 PASS/WARN 或 skip/exempt 後不可停在 verdict/skipped/exempt，必須接 post-PR ready next-step handoff",
  },
  {
    phrase: "CurrentIntent",
    purpose: "Step 5.5 ready path 必須暴露目前 intent，避免 terse `go` 綁到 stale cleanup",
  },
  {
    phrase: "NextAction",
    purpose: "Step 5.5 ready path 必須暴露下一個 AI-actionable 或 user-owned action",
  },
  {
    phrase: "AskFirstPending",
    purpose: "Step 5.5 ready path 必須明示是否仍有 merge Ask First / user decision pending",
  },
];

// Read the devpro:pre-pr skill's SKILL.md plus every file under its references/
// (dispatch blocks were extracted there); a guarded phrase counts if it appears
// in any of them.
async function loadPrePrFiles() {
  const contents = [
    {
      name: "SKILL.md",
      content: await fs.readFile(path.join(PRE_PR_SKILL_DIR, "SKILL.md"), "utf8"),
    },
  ];
  const refsDir = path.join(PRE_PR_SKILL_DIR, "references");
  let refEntries = [];
  try {
    refEntries = await fs.readdir(refsDir);
  } catch {
    refEntries = [];
  }
  for (const name of refEntries.filter((n) => n.endsWith(".md"))) {
    contents.push({
      name: `references/${name}`,
      content: await fs.readFile(path.join(refsDir, name), "utf8"),
    });
  }
  if (contents.length === 0) {
    throw new Error(`No skill files found under ${PRE_PR_SKILL_DIR}`);
  }
  return contents;
}

const STEP_4_START = "### Step 4: PR Description";
const STEP_5_START = "### Step 5: Post-PR Workflow Watch";
const HOTFIX_FIELDS_START = "- **`hotfix/` 分支**";
const URGENT_REPAIR_START = "- **已上 PROD 緊急修復**";
const ORDINARY_BUGFIX_START = "- **一般 `bugfix/` 分支**";
const HOTFIX_LANE_SSOT = "release-hotfix-carrier-policy.md";

function extractUniqueSection(content, start, end, label) {
  const startCount = content.split(start).length - 1;
  const endCount = content.split(end).length - 1;
  assert.equal(startCount, 1, `${label}: expected exactly one ${start} anchor`);
  assert.equal(endCount, 1, `${label}: expected exactly one ${end} anchor`);
  const startAt = content.indexOf(start);
  const endAt = content.indexOf(end);
  assert.ok(startAt < endAt, `${label}: ${start} must precede ${end}`);
  return content.slice(startAt + start.length, endAt);
}

function extractStep4(content) {
  return extractUniqueSection(content, STEP_4_START, STEP_5_START, "Step 4");
}

function extractHotfixFields(step4) {
  return extractUniqueSection(
    step4,
    HOTFIX_FIELDS_START,
    URGENT_REPAIR_START,
    "hotfix conditional-fields section",
  );
}

function assertNoBugfixProductionDraftRoute(step4) {
  // Keep the line check for unbulleted copies, and also inspect each top-level
  // Markdown bullet as one logical instruction so wrapped routes stay together.
  for (const line of step4.split(/\r?\n/)) {
    if (/bugfix\/?/i.test(line)) assertNoForbiddenBugfixRoute(line);
  }

  const bulletBlocks = [];
  let current = [];
  for (const line of step4.split(/\r?\n/)) {
    if (/^-\s/.test(line) && current.length > 0) {
      bulletBlocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) bulletBlocks.push(current.join("\n"));
  for (const block of bulletBlocks.filter((candidate) => /^-\s/m.test(candidate) && /bugfix\/?/i.test(candidate))) {
    assertNoForbiddenBugfixRoute(block);
  }
}

function assertNoForbiddenBugfixRoute(instruction) {
  const productionBase = /--base\s+production|production[^；。]{0,100}base|base[^；。]{0,100}production/i.test(instruction);
  const dualDraft = /(?:兩份|two)\s*(?:描述)?(?:草稿|drafts?)|PR\s*#?1[^。]{0,180}production[^。]{0,180}PR\s*#?2[^。]{0,120}main/i.test(instruction);
  assert.ok(
    !productionBase && !dualDraft,
    `Step 4 contains a forbidden bugfix production-base/dual-draft route on: ${instruction.trim()}`,
  );
}

function extractInstructionContaining(step4, marker, label) {
  const lines = step4.split(/\r?\n/);
  const matchingIndexes = lines.flatMap((line, index) => line.includes(marker) ? [index] : []);
  assert.equal(matchingIndexes.length, 1, `${label}: expected exactly one ${marker} instruction`);
  const index = matchingIndexes[0];
  if (!/^-\s/.test(lines[index])) return lines[index];
  const block = [lines[index]];
  for (let cursor = index + 1; cursor < lines.length && !/^-\s/.test(lines[cursor]); cursor += 1) {
    block.push(lines[cursor]);
  }
  return block.join("\n");
}

function assertStep4Routing(step4) {
  assertNoBugfixProductionDraftRoute(step4);
  assert.match(step4, /已上\s*PROD[\s\S]{0,150}緊急修復[\s\S]{0,150}hotfix\//i, "urgent already-live repairs must be re-cut as hotfix/");
  assert.ok(step4.includes(HOTFIX_LANE_SSOT), "urgent hotfix route must link the release-carrier SSOT");
  const ordinaryRoute = extractInstructionContaining(step4, ORDINARY_BUGFIX_START, "ordinary bugfix route");
  assert.match(ordinaryRoute, /\bmain\b/i, "ordinary bugfix route must retain main as its base");
  assert.match(ordinaryRoute, /核准 subset|approved subset/i, "ordinary bugfix route must retain approved subset selection");
}

// The release-carrier SSOT link must sit on the urgent already-live repair bullet itself,
// not merely somewhere in Step 4 (another bullet could carry it and leave this one unlinked).
function assertUrgentBulletLinksLaneSsot(step4) {
  const urgent = extractInstructionContaining(step4, URGENT_REPAIR_START, "urgent repair route");
  assert.ok(urgent.includes(HOTFIX_LANE_SSOT), "urgent repair bullet must link the release-carrier SSOT itself");
}

function assertHotfixRollbackField(step4) {
  const fields = extractHotfixFields(step4);
  assert.ok(fields.includes("rollback 計畫"), "rollback 計畫 must remain in hotfix conditional fields");
  const fieldsStart = step4.indexOf(HOTFIX_FIELDS_START) + HOTFIX_FIELDS_START.length;
  const fieldsEnd = step4.indexOf(URGENT_REPAIR_START);
  const outsideFields = `${step4.slice(0, fieldsStart)}${step4.slice(fieldsEnd)}`;
  assert.ok(
    !outsideFields.includes("rollback 計畫"),
    "rollback 計畫 must appear only in hotfix conditional fields",
  );
}

describe("pre-pr-contract-guard", () => {
  describe("Critical phrases must appear in at least one pre-pr*.md file", () => {
    for (const { phrase, purpose } of PHRASES) {
      it(`'${phrase}' is present`, async () => {
        const files = await loadPrePrFiles();
        const hitFiles = files
          .filter((f) => f.content.includes(phrase))
          .map((f) => f.name);
        assert.ok(
          hitFiles.length > 0,
          [
            `違規：phrase「${phrase}」在 devpro:pre-pr skill（SKILL.md + references/）任一檔案都搜不到。`,
            `用途：${purpose}`,
            `本 phrase 由 add-doc-splitting-sop change 註冊保護（PR #222 review 萃取的 8 條 Critical 之一）；trim 或拆分前必須走 amend change 並更新本測試 phrase list。`,
            `已掃描檔案：${files.map((f) => f.name).join(", ")}`,
          ].join("\n"),
        );
      });
    }
  });

  describe("Step 4 bugfix and hotfix routing contracts", () => {
    it("extracts one ordered Step 4 and requires the current live routes", async () => {
      const skill = await fs.readFile(path.join(PRE_PR_SKILL_DIR, "SKILL.md"), "utf8");
      const step4 = extractStep4(skill);
      assertStep4Routing(step4);
      assertUrgentBulletLinksLaneSsot(step4);
    });

    it("requires the release-carrier SSOT link on the urgent bullet, not elsewhere in Step 4", () => {
      const linked = `- **已上 PROD 緊急修復**：重切 hotfix/，見 ${HOTFIX_LANE_SSOT}。\n- **一般 \`bugfix/\` 分支** PR base main，依核准 subset。`;
      const linkedElsewhere = `- **已上 PROD 緊急修復**：重切 hotfix/。\n- **一般 \`bugfix/\` 分支** PR base main，依核准 subset；另見 ${HOTFIX_LANE_SSOT}。`;
      assert.doesNotThrow(() => assertUrgentBulletLinksLaneSsot(linked));
      assert.throws(() => assertUrgentBulletLinksLaneSsot(linkedElsewhere), /urgent repair bullet must link/);
    });

    it("rejects a dual-draft instruction that carries no production-base token on its own", () => {
      const step4 = `已上 PROD 緊急修復請重切 hotfix/，詳見 ${HOTFIX_LANE_SSOT}。\n- **一般 \`bugfix/\` 分支** PR base main，依核准 subset。\n- 已上 PROD bugfix/：請準備兩份描述草稿。`;
      assert.throws(() => assertStep4Routing(step4), /forbidden bugfix production-base\/dual-draft route/);
    });

    it("rejects stale bugfix dual-draft text even beside replacement wording", () => {
      const step4 = `已上 PROD 緊急修復請重切 hotfix/ 並依 ${HOTFIX_LANE_SSOT} 辦理。\n普通 bugfix/ 走 main 與核准 subset。\n已上 PROD bugfix/：兩份描述草稿，PR #1（--base production），PR #2（--base main）。`;
      assert.throws(() => assertStep4Routing(step4), /forbidden bugfix production-base\/dual-draft route/);
    });

    it("rejects bugfix production routing wherever it appears in Step 4", () => {
      const step4 = `已上 PROD 緊急修復請重切 hotfix/，詳見 ${HOTFIX_LANE_SSOT}。\n普通 bugfix/ PR base main，納入核准 subset。\n備註：bugfix PR 請使用 --base production。`;
      assert.throws(() => assertStep4Routing(step4), /forbidden bugfix production-base\/dual-draft route/);
    });

    it("rejects a stale bugfix route whose draft and base instructions wrap across lines", () => {
      const step4 = `已上 PROD 緊急修復請重切 hotfix/，詳見 ${HOTFIX_LANE_SSOT}。\n- **一般 \`bugfix/\` 分支** PR base main，依核准 subset。\n- 已上 PROD bugfix/ 的處理方式如下：\n  製作兩份 PR 描述草稿：PR #1 使用 --base production；PR #2 使用 --base main。`;
      assert.throws(() => assertStep4Routing(step4), /forbidden bugfix production-base\/dual-draft route/);
    });

    it("requires both main and approved subset on the ordinary bugfix route", () => {
      const mainOnly = `已上 PROD 緊急修復請重切 hotfix/，詳見 ${HOTFIX_LANE_SSOT}。\n- **一般 \`bugfix/\` 分支** PR base main。`;
      const subsetOnly = `已上 PROD 緊急修復請重切 hotfix/，詳見 ${HOTFIX_LANE_SSOT}。\n- **一般 \`bugfix/\` 分支** 依核准 subset。`;
      assert.throws(() => assertStep4Routing(mainOnly), /approved subset selection/);
      assert.throws(() => assertStep4Routing(subsetOnly), /main as its base/);
    });

    it("accepts ordinary bugfix main/subset wording and legal hotfix carrier wording", () => {
      const step4 = `已上 PROD 緊急修復請重切 hotfix/，詳見 ${HOTFIX_LANE_SSOT}。\n- **一般 \`bugfix/\` 分支** PR base main，依核准 subset。\n- hotfix/* 不得以 --base production 開 PR；只有 carrier 可建立 production PR，並依 SSOT back-merge。`;
      assertStep4Routing(step4);
    });

    it("fails closed for missing, duplicate, or reversed Step 4 anchors", () => {
      assert.throws(() => extractStep4("body"), /exactly one/);
      assert.throws(() => extractStep4(`${STEP_4_START} x ${STEP_4_START} y ${STEP_5_START}`), /exactly one/);
      assert.throws(() => extractStep4(`${STEP_5_START} x ${STEP_4_START}`), /must precede/);
    });

    it("keeps rollback 計畫 inside the hotfix conditional-fields section", async () => {
      const skill = await fs.readFile(path.join(PRE_PR_SKILL_DIR, "SKILL.md"), "utf8");
      const step4 = extractStep4(skill);
      assertHotfixRollbackField(step4);

      const duplicateOutside = step4.replace(
        ORDINARY_BUGFIX_START,
        `${ORDINARY_BUGFIX_START}：rollback 計畫`,
      );
      assert.throws(() => assertHotfixRollbackField(duplicateOutside), /rollback 計畫 must appear only/);

      const outsideOnly = step4.replace("rollback 計畫", "rollback plan");
      const bugfixMutation = outsideOnly.replace(
        ORDINARY_BUGFIX_START,
        `${ORDINARY_BUGFIX_START}：rollback 計畫`,
      );
      assert.throws(() => assertHotfixRollbackField(bugfixMutation), /rollback 計畫 must remain/);
      assert.throws(() => extractHotfixFields(step4.replace(HOTFIX_FIELDS_START, "")), /exactly one/);
      assert.throws(() => extractHotfixFields(`${step4}\n${HOTFIX_FIELDS_START} duplicate`), /exactly one/);
    });
  });
});
