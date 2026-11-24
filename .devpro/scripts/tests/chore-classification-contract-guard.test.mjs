/**
 * chore-classification-contract-guard.test.mjs
 *
 * Locks high-stakes phrases from `.devpro/agent-rules/chore-classification.md`
 * so they cannot be silently dropped during a refactor.
 *
 * Phrases registered by change `strengthen-chore-a-self-alignment-grep`:
 * - "對齊類 chore A 必驗": self-alignment grep 規則 anchor；防 trim
 * - "self-alignment grep": 規則機制名稱；防後續 refactor 改名漂移
 * Phrases registered by change `clarify-bump-validation-gate`:
 * - "metadata-only gate": bump PR 驗證時點；防回退為 full-suite bump gate
 * - "release branch 組裝完成後": full validation 時點；防測試責任回到 bump PR
 * Phrases registered by change `clarify-source-gate-enforcement-carrier`:
 * - "新增 mechanical gate 的載體（source repo）": source-repo enforcement-carrier 指針 anchor；防 trim
 * - "local-test gate 為唯一測試防線": 約束 anchor + 導向 cross-runtime-parity SSOT；防漂移
 * Phrases registered by change `enforce-chore-code-size-limit`:
 * - grep locks L1-L5: 計數定義 section vs chore-code-size-gate.mjs exports;
 *   判錯升級 rule lives in the leaf (skill only points at it); canonical spec is
 *   not a two-class split; 前綴車道 heading; bump-branch regex identical in
 *   pre-tool-gate.mjs; plus the four openspec-flow scenario titles
 *
 * Pattern derived from `pre-pr-contract-guard.test.mjs`. Removing or renaming
 * any guarded phrase requires an amend change that updates this list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath, repoFileUrl } from "./lib/repo-root.mjs";

const CHORE_CLASSIFICATION_PATH = repoPath(
  ".devpro/agent-rules/chore-classification.md",
);

const CHANGE_SKILL_PATH = repoPath(
  ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
);
const PRE_TOOL_GATE_PATH = repoPath(".devpro/scripts/hooks/pre-tool-gate.mjs");
const CANONICAL_SPEC_PATH = repoPath("openspec/specs/openspec-flow/spec.md");
const CHANGE_SPEC_DELTA_PATH = repoPath(
  "openspec/changes/enforce-chore-code-size-limit/specs/openspec-flow/spec.md",
);

const DOWNGRADE_SENTENCE =
  "判錯升級不降級：B-mini → B 可，A → B-mini 可；反向降級需重新審視。";
const SKILL_POINTER = "§判錯只升不降與升級路徑";
const BUMP_RE_LITERAL = String.raw`/^chore\/bump-v\d+\.\d+\.\d+$/`;

const PHRASES = [
  {
    phrase: "對齊類 chore A 必驗",
    purpose: "self-alignment grep 規則 anchor；防 trim",
  },
  {
    phrase: "self-alignment grep",
    purpose: "規則機制名稱；防後續 refactor 改名漂移",
  },
  {
    phrase: "metadata-only gate",
    purpose: "bump PR 驗證時點；防回退為 full-suite bump gate",
  },
  {
    phrase: "release branch 組裝完成後",
    purpose: "full validation 時點；防測試責任回到 bump PR",
  },
  {
    phrase: "新增 mechanical gate 的載體（source repo）",
    purpose: "source-repo enforcement-carrier 指針 anchor；防 trim",
  },
  {
    phrase: "local-test gate 為唯一測試防線",
    purpose: "約束 anchor + 導向 cross-runtime-parity SSOT；防漂移",
  },
  {
    phrase: "chore A still runs preflight points 1-2",
    purpose: "避免 chore A 文案再次漂成完全跳過 pre-flight sanity checks",
  },
];

async function loadChoreClassification() {
  const content = await fs.readFile(CHORE_CLASSIFICATION_PATH, "utf8");
  return content;
}

describe("chore-classification-contract-guard", () => {
  describe(
    "Critical phrases must appear in chore-classification.md",
    () => {
      for (const { phrase, purpose } of PHRASES) {
        it(`'${phrase}' is present`, async () => {
          const content = await loadChoreClassification();
          assert.ok(
            content.includes(phrase),
            [
              `違規：phrase「${phrase}」在 .devpro/agent-rules/chore-classification.md 搜不到。`,
              `用途：${purpose}`,
              `本 phrase 由 strengthen-chore-a-self-alignment-grep change 註冊保護；trim 或拆分前必須走 amend change 並更新本測試 phrase list。`,
            ].join("\n"),
          );
        });
      }
    },
  );

  describe("enforce-chore-code-size-limit grep locks", () => {
    it("L1: 計數定義 section matches chore-code-size-gate.mjs exports", async () => {
      const { CODE_FILE_EXTENSIONS, CHORE_CODE_SIZE_LIMIT } = await import(
        repoFileUrl(".devpro/scripts/hooks/lib/chore-code-size-gate.mjs")
      );
      const section = extractBlock(
        await loadChoreClassification(),
        (l) => l === "### 計數定義",
        (l) => l.startsWith("### "),
      );
      assert.ok(
        section,
        "違規：chore-classification.md 找不到 `### 計數定義` section（L1 鎖點）。",
      );
      assert.ok(section.includes("非測試程式碼"), "計數定義 缺 `非測試程式碼`");
      const exts = CODE_FILE_EXTENSIONS.join(", ");
      assert.ok(
        section.includes(exts),
        `計數定義 的副檔名清單與 CODE_FILE_EXTENSIONS 不一致；預期含「${exts}」`,
      );
      const limitRe = new RegExp(`(?<![\\d.])${CHORE_CODE_SIZE_LIMIT}(?![\\d.])`);
      assert.match(
        section,
        limitRe,
        `計數定義 缺獨立的門檻數字 ${CHORE_CODE_SIZE_LIMIT}（CHORE_CODE_SIZE_LIMIT）`,
      );
    });

    it("L2a: misclassification rule lives in the leaf", async () => {
      const content = await loadChoreClassification();
      assert.ok(content.includes("判錯只升不降"), "leaf 缺 `判錯只升不降`");
      assert.ok(
        content.includes(DOWNGRADE_SENTENCE),
        `leaf 缺判錯升級句：${DOWNGRADE_SENTENCE}（規則本體應在 leaf，skill 只指向）`,
      );
    });

    it("L2b: change skill 第二步 only points at the leaf section", async () => {
      const step2 = await loadSkillStep2();
      assert.ok(step2, "change SKILL.md 找不到第二步 block");
      assert.ok(
        !step2.includes(DOWNGRADE_SENTENCE),
        "skill 第二步仍內嵌判錯升級句；規則本體須移到 leaf，skill 只留指針",
      );
      assert.ok(
        step2.includes(SKILL_POINTER),
        `skill 第二步缺指針 ${SKILL_POINTER}`,
      );
    });

    it("L3: canonical Chore A vs B Classification requirement is not a two-class split", async () => {
      const block = extractBlock(
        await fs.readFile(CANONICAL_SPEC_PATH, "utf8"),
        (l) => l === "### Requirement: Chore A vs B Classification",
        (l) => l.startsWith("### Requirement:"),
      );
      assert.ok(block, "canonical openspec-flow spec 找不到 Chore A vs B Classification");
      assert.ok(block.includes("B-mini"), "requirement 缺 B-mini");
      assert.ok(
        !block.includes(
          "as either A (OpenSpec-exempt) or B (OpenSpec-required)",
        ),
        "requirement 仍是舊的 A/B 二分句",
      );
    });

    it("L4: 前綴車道 heading is an exact line", async () => {
      const lines = (await loadChoreClassification()).split("\n");
      assert.ok(
        lines.includes("### 前綴車道（chore/ 輕量車道）"),
        "leaf 缺 `### 前綴車道（chore/ 輕量車道）` heading 行",
      );
    });

    it("L5: both cross-model functions use the shared bump predicate matching the size-gate constant", async () => {
      const src = await fs.readFile(PRE_TOOL_GATE_PATH, "utf8");
      const isEnd = (l) => l === "}";
      const shared = await fs.readFile(PRE_TOOL_GATE_PATH.replace("pre-tool-gate.mjs", "lib/github-merge-exemptions.mjs"), "utf8");
      assert.match(src, /return githubBranchExemptionReason\(prHeadRefName, rulesSources\)/);
      const bodies = {
        githubBranchExemptionReason: extractBlock(
          shared,
          (l) => l.startsWith("export function githubBranchExemptionReason("),
          isEnd,
        ),
        CHORE_CODE_SIZE_BUMP_BRANCH_RE: src
          .split("\n")
          .find((l) => l.startsWith("const CHORE_CODE_SIZE_BUMP_BRANCH_RE =")),
      };
      for (const [name, body] of Object.entries(bodies)) {
        assert.ok(body, `pre-tool-gate.mjs 找不到 ${name}`);
        const found = body.match(/\/\^chore\\\/bump-v.*?\$\//g) ?? [];
        assert.equal(found.length, 1, `${name} 應恰有一個 bump regex literal`);
        assert.equal(found[0], BUMP_RE_LITERAL, `${name} 的 bump regex 與預期不同`);
      }
      for (const name of ["isCrossModelExempt", "crossModelExemptionReason"]) {
        const body = extractBlock(src, (line) => line.startsWith(`function ${name}(`), isEnd);
        assert.ok(body, `pre-tool-gate.mjs 找不到 ${name}`);
        assert.match(body, /\bbranchPatternCrossModelExemptionReason\(prHeadRefName, cwd\)/);
        assert.doesNotMatch(body, /\/\^chore\\\/bump-v.*?\$\//);
      }
    });
  });

  describe("enforce-chore-code-size-limit openspec-flow scenarios", () => {
    it("Scenario: External Behavior Change Classifies As B-mini Or B", async () => {
      await assertScenarioInSpec(
        "External Behavior Change Classifies As B-mini Or B",
      );
      const lines = (await loadChoreClassification()).split("\n");
      const header = lines.find(
        (l) => l.startsWith("| 判斷項") && l.includes("B-mini") && l.includes("B 類"),
      );
      assert.ok(header, "leaf 形狀表缺 A / B-mini / B 三欄表頭");
      assert.ok(
        lines.some((l) => l.startsWith("| 觸及範圍") && l.includes("不新建 capability spec")),
        "leaf 形狀表 B-mini 觸及範圍缺 `不新建 capability spec`",
      );
    });

    it("Scenario: Agent Routing Gate Or Completion Condition Change Is Never Chore A", async () => {
      await assertScenarioInSpec(
        "Agent Routing Gate Or Completion Condition Change Is Never Chore A",
      );
      const content = await loadChoreClassification();
      // Nearest existing leaf wording (no dedicated "never chore A" sentence for routing).
      for (const anchor of [
        "若文件修改會改變 agent 路由／gate／收尾條件，**不得**走本 fast-track",
        "即使 diff 是 markdown 也不得判為 chore A",
      ]) {
        assert.ok(content.includes(anchor), `leaf 缺錨點：${anchor}`);
      }
    });

    it("Scenario: Chore Prefix Lane Limit Does Not Change Shape Class", async () => {
      await assertScenarioInSpec(
        "Chore Prefix Lane Limit Does Not Change Shape Class",
      );
      const lane = extractBlock(
        await loadChoreClassification(),
        (l) => l === "### 前綴車道（chore/ 輕量車道）",
        (l) => l.startsWith("### "),
      );
      assert.ok(lane, "leaf 缺前綴車道 section");
      assert.ok(
        lane.includes("升級**不改形狀分類**"),
        "前綴車道 section 缺 `升級**不改形狀分類**`",
      );
    });

    it("Scenario: Misclassification Is Corrected Upward Only", async () => {
      await assertScenarioInSpec("Misclassification Is Corrected Upward Only");
      const section = extractBlock(
        await loadChoreClassification(),
        (l) => l === "### 判錯只升不降與升級路徑",
        (l) => l.startsWith("### "),
      );
      assert.ok(section, "leaf 缺 `### 判錯只升不降與升級路徑` section");
      const step2 = await loadSkillStep2();
      assert.ok(step2, "change SKILL.md 找不到第二步 block");
      assert.ok(
        step2.includes(SKILL_POINTER),
        `skill 第二步缺指針 ${SKILL_POINTER}`,
      );
    });
  });
});

/**
 * Lines from the first line matching isStart (inclusive) up to, but excluding,
 * the next line matching isEnd. Returns null when no start line exists.
 */
function extractBlock(text, isStart, isEnd) {
  const lines = text.split("\n");
  const start = lines.findIndex(isStart);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isEnd(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

async function loadSkillStep2() {
  return extractBlock(
    await fs.readFile(CHANGE_SKILL_PATH, "utf8"),
    (l) => l.startsWith("**第二步：Change Classification Routing**"),
    (l) => l.startsWith("**第三步"),
  );
}

// The change delta moves on archive; the promoted canonical spec carries the
// same scenario afterwards, so accept either source.
async function assertScenarioInSpec(title) {
  const heading = `#### Scenario: ${title}`;
  const sources = [];
  for (const p of [CHANGE_SPEC_DELTA_PATH, CANONICAL_SPEC_PATH]) {
    try {
      sources.push(await fs.readFile(p, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  assert.ok(
    sources.some((t) => t.split("\n").includes(heading)),
    `openspec-flow spec（change delta 或 canonical）缺 heading：${heading}`,
  );
}
