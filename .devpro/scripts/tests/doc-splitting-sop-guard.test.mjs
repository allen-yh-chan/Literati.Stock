import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

// anchor-move: §文件拆分 SOP + §Protected Anchors 已搬至 doc-split-and-dedup-sop.md
// (refactor-core-tier-saturation-split-doc-sop); 讀檔路徑同步更新。
const RULE_FILE = repoPath(".devpro/agent-rules/doc-split-and-dedup-sop.md");

function makeViolationMsg(phrase) {
  return (
    `違規：doc-split-and-dedup-sop.md 缺 phrase「${phrase}」；` +
    `本 phrase 由 add-doc-splitting-sop change 註冊保護，trim 前必須走 amend change 並更新本測試 phrase list。`
  );
}

describe("doc-splitting-sop-guard", async () => {
  const content = await fs.readFile(RULE_FILE, "utf8");

  describe("section heading exists", () => {
    it("contains '### 文件拆分 SOP（source repo 專用）'", () => {
      assert.ok(
        content.includes("### 文件拆分 SOP（source repo 專用）"),
        makeViolationMsg("### 文件拆分 SOP（source repo 專用）")
      );
    });
  });

  describe("decision gate phrases", () => {
    it("contains '按條件載入'", () => {
      assert.ok(
        content.includes("按條件載入"),
        makeViolationMsg("按條件載入")
      );
    });

    it("contains '互斥分支'", () => {
      assert.ok(
        content.includes("互斥分支"),
        makeViolationMsg("互斥分支")
      );
    });

    it("contains 'A/B path'", () => {
      assert.ok(
        content.includes("A/B path"),
        makeViolationMsg("A/B path")
      );
    });

    it("contains '70%'", () => {
      assert.ok(
        content.includes("70%"),
        makeViolationMsg("70%")
      );
    });

    it("contains '不讀它也不影響'", () => {
      assert.ok(
        content.includes("不讀它也不影響"),
        makeViolationMsg("不讀它也不影響")
      );
    });

    it("contains '單檔瘦身'", () => {
      assert.ok(
        content.includes("單檔瘦身"),
        makeViolationMsg("單檔瘦身")
      );
    });
  });

  describe("7-step SOP phrases", () => {
    it("contains '7 步執行 SOP' (heading reflects step 7 addition)", () => {
      assert.ok(
        content.includes("7 步執行 SOP"),
        makeViolationMsg("7 步執行 SOP")
      );
    });

    it("contains 'repoint 到 holding sibling' (step 7 action anchor)", () => {
      assert.ok(
        content.includes("repoint 到 holding sibling"),
        makeViolationMsg("repoint 到 holding sibling")
      );
    });

    it("contains 'dangling ref' (step 7 failure signal anchor)", () => {
      assert.ok(
        content.includes("dangling ref"),
        makeViolationMsg("dangling ref")
      );
    });

    it("contains 'grep scope' (step 7 cite-sweep scope enumeration anchor)", () => {
      // Strengthened per RULE-FEEDBACK (PR #1179): Step 7 must enumerate the
      // full cite-bearing surface to grep, not just agent-rules/*.md — recon
      // repeatedly missed scenarios/, README, openspec/specs/, and grep-tests
      // that read()+match a file.
      assert.ok(
        content.includes("grep scope"),
        makeViolationMsg("grep scope")
      );
    });

    it("step 7 grep scope names scenarios/ and read()+match surfaces", () => {
      assert.ok(
        content.includes("scenarios/") && content.includes("read()+match"),
        makeViolationMsg("scenarios/ + read()+match (step 7 scope surfaces)")
      );
    });

    it("contains 'archived 契約'", () => {
      assert.ok(
        content.includes("archived 契約"),
        makeViolationMsg("archived 契約")
      );
    });

    it("contains 'decisions_delta'", () => {
      assert.ok(
        content.includes("decisions_delta"),
        makeViolationMsg("decisions_delta")
      );
    });

    it("contains 'capability spec MUST'", () => {
      assert.ok(
        content.includes("capability spec MUST"),
        makeViolationMsg("capability spec MUST")
      );
    });

    it("contains 'SHALL'", () => {
      assert.ok(
        content.includes("SHALL"),
        makeViolationMsg("SHALL")
      );
    });

    it("contains 'cross-component'", () => {
      assert.ok(
        content.includes("cross-component"),
        makeViolationMsg("cross-component")
      );
    });

    it("contains 'cross-ref'", () => {
      assert.ok(
        content.includes("cross-ref"),
        makeViolationMsg("cross-ref")
      );
    });

    it("contains 'POSIX'", () => {
      assert.ok(
        content.includes("POSIX"),
        makeViolationMsg("POSIX")
      );
    });

    it("contains '`rg`' (backtick-wrapped, forbidden-example marker)", () => {
      assert.ok(
        content.includes("`rg`"),
        makeViolationMsg("`rg`")
      );
    });

    it("contains '路由偵測碼'", () => {
      assert.ok(
        content.includes("路由偵測碼"),
        makeViolationMsg("路由偵測碼")
      );
    });

    it("contains 'capability spec delta'", () => {
      assert.ok(
        content.includes("capability spec delta"),
        makeViolationMsg("capability spec delta")
      );
    });

    it("contains 'chore 分類'", () => {
      assert.ok(
        content.includes("chore 分類"),
        makeViolationMsg("chore 分類")
      );
    });
  });

  describe("anti-rationalization rebuttals", () => {
    it("has at least 4 '**「' rebuttal headings", () => {
      const lines = content.split("\n");
      const rebuttalLines = lines.filter((line) => line.startsWith("**「"));
      assert.ok(
        rebuttalLines.length >= 4,
        `違規：doc-split-and-dedup-sop.md 的「文件拆分 SOP」節內 **「 開頭反駁項 < 4（實際 ${rebuttalLines.length} 條）；` +
        `本斷言由 add-doc-splitting-sop change 註冊保護，trim 前必須走 amend change 並更新本測試 phrase list。`
      );
    });
  });
});
