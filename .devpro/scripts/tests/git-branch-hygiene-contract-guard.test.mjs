/**
 * git-branch-hygiene-contract-guard.test.mjs
 *
 * Locks high-stakes deletion phrases from:
 *   - `.devpro/agent-rules/git-branch-hygiene.md`
 *   - `.devpro/agent-rules/release-step-1-7.md`
 *   - `.devpro/agent-rules/release-sit-uat-pat-prod.md`
 *
 * Prevents silent trim/refactor from removing the authorised-deletion flow
 * documentation now that cleanup enforcement lives in the prune script, not
 * PreToolUse.
 *
 * Search strategy: legacy deletion phrases remain bound to their hygiene SSOT;
 * each Step 6 matrix carrier has one complete, self-contained matrix line.
 * Pattern derived from `pre-pr-contract-guard.test.mjs`.
 * Removing or renaming any guarded phrase requires an amend change that
 * updates this list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "./lib/repo-root.mjs";

const HYGIENE_FILE = repoPath(".devpro/agent-rules/git-branch-hygiene.md");
const TRACKING_FILE = repoPath(".devpro/agent-rules/git-workflow-tracking.md");
const MATRIX_HEADING = "### Post-PROD Cleanup Decision Matrix";

// Section-scoped slice: bounded by the next H2/H3 heading so a stage-applicability
// assertion can never be satisfied by an unrelated later paragraph (D4 guard
// strategy: bounded, heading-anchored slices).
function matrixSection(content) {
  const start = content.indexOf(MATRIX_HEADING);
  assert.notEqual(start, -1, `missing ${MATRIX_HEADING}`);
  const rest = content.slice(start + MATRIX_HEADING.length);
  const next = rest.search(/\n#{2,3} /);
  return next === -1 ? content.slice(start) : content.slice(start, start + MATRIX_HEADING.length + next);
}

const MATRIX_CARRIERS = [
  {
    name: ".devpro/agent-rules/git-branch-hygiene.md",
    filePath: HYGIENE_FILE,
    matrixMarker: "### Post-PROD Cleanup Decision Matrix",
    contractMarker: "Step 6 的 `prune-merged-local.mjs`",
    fragments: [
      "prune-merged-local.mjs --exec",
      "prune-merged-local.mjs --include-remote --exec",
      "prune-notes-tmp.mjs --exec --as-of <time>",
      "最後一項 MUST 是開放項",
      "告警觀察只能在矩陣之後接續",
    ],
  },
  {
    name: ".devpro/agent-rules/release-step-1-7.md",
    filePath: repoPath(".devpro/agent-rules/release-step-1-7.md"),
    matrixMarker: "**Post-PROD Cleanup Decision Matrix**",
    contractMarker: "**Post-PROD Cleanup Decision Matrix**",
    fragments: [
      "Post-PROD Cleanup Decision Matrix",
      "prune-merged-local.mjs --exec",
      "prune-merged-local.mjs --include-remote --exec",
      "prune-notes-tmp.mjs --exec --as-of <time>",
      "末項 MUST 開放",
      "alert observation 只能接在此矩陣之後",
    ],
  },
  {
    name: ".devpro/agent-rules/release-sit-uat-pat-prod.md",
    filePath: repoPath(".devpro/agent-rules/release-sit-uat-pat-prod.md"),
    matrixMarker: "Post-PROD Cleanup Decision Matrix",
    contractMarker: "- Step 6 cleanup report",
    fragments: [
      "Post-PROD Cleanup Decision Matrix",
      "prune-merged-local.mjs --exec",
      "prune-merged-local.mjs --include-remote --exec",
      "prune-notes-tmp.mjs --exec --as-of <time>",
      "末項開放",
      "alert observation 只能跟在矩陣後",
    ],
  },
];

const PHRASES = [
  {
    phrase: "PreToolUse 不解析裸刪除命令",
    purpose:
      "cleanup policy must stay out of pre-tool-gate.mjs；防回流",
  },
  {
    phrase: "使用者明示授權刪除未上 PROD 分支",
    purpose:
      "git-branch-hygiene.md H3 段；防後續 trim 誤刪豁免流程說明",
  },
  {
    phrase: "--force-delete --allow-release",
    purpose:
      "abandoned local release/* dual opt-in path + predicates；防 trim 掉 #1957 合規出口",
  },
  {
    phrase: "遠端刪除為獨立項",
    purpose:
      "Step 6 prune Ask First MUST number remote-delete separately when remote candidates exist",
  },
  {
    phrase: "remote 候選 = 0 時不強制",
    purpose:
      "remote numbered option is required only when dry-run lists remote candidates",
  },
];

describe("git-branch-hygiene-contract-guard", () => {
  describe("critical deletion phrases remain in the hygiene SSOT", () => {
    for (const { phrase, purpose } of PHRASES) {
      it(`'${phrase}' is present`, async () => {
        const content = await fs.readFile(HYGIENE_FILE, "utf8");
        assert.ok(
          content.includes(phrase),
          [
            `違規：phrase「${phrase}」不在 hygiene SSOT：${path.relative(REPO_ROOT, HYGIENE_FILE)}`,
            `用途：${purpose}`,
            `本 phrase 由 enforce-remote-branch-delete-gate change 註冊保護；`,
            `trim 或重構前必須走 amend change 並更新本測試 phrase list。`,
          ].join("\n")
        );
      });
    }
  });

  describe("Post-PROD cleanup matrix is carried by every Step 6 rule leaf", () => {
    for (const carrier of MATRIX_CARRIERS) {
      it(`${carrier.name} has exactly one complete matrix contract line`, async () => {
        const content = await fs.readFile(carrier.filePath, "utf8");
        const matrixMarkerLines = content
          .split("\n")
          .filter((line) => line.includes(carrier.matrixMarker));
        assert.equal(
          matrixMarkerLines.length,
          1,
          `違規：${carrier.name} 必須恰有一行 matrix marker「${carrier.matrixMarker}」。`
        );
        const contractLines = content
          .split("\n")
          .filter((line) => line.includes(carrier.contractMarker));
        assert.equal(
          contractLines.length,
          1,
          `違規：${carrier.name} 必須恰有一行 operative matrix contract「${carrier.contractMarker}」。`
        );
        const missingFragments = carrier.fragments.filter(
          (fragment) => !contractLines[0].includes(fragment)
        );
        assert.deepEqual(
          missingFragments,
          [],
          `違規：${carrier.name} 的唯一 matrix contract 缺少：${missingFragments.join(", ")}`
        );
      });
    }
  });
});

// ── fix-flow-gate-gaps D4 (FR4): matrix stage-applicability & candidate scope ──
// The matrix is a Step 6 (post-PROD) artifact; a post-merge-pre-release stop
// point MUST NOT surface it, must report the unshipped-mainline state instead,
// and the matrix may only list this change's own candidates (pre-existing
// unrelated branches/worktrees must be labelled, never offered as consent).
describe("git-branch-hygiene-contract-guard: matrix stage-applicability (FR4)", () => {
  it("matrix section binds itself to release Step 6 / PROD tag pushed (stage binding)", async () => {
    const slice = matrixSection(await fs.readFile(HYGIENE_FILE, "utf8"));
    assert.match(slice, /只在 release Step 6/, "matrix must declare it applies only at release Step 6");
    assert.match(slice, /PROD tag pushed/, "stage binding must name the PROD-tag-pushed anchor");
  });

  it("post-merge-pre-release MUST NOT surface the matrix (same-line polarity compound)", async () => {
    const slice = matrixSection(await fs.readFile(HYGIENE_FILE, "utf8"));
    const lines = slice.split("\n").filter((line) => /未上 production|post-merge-pre-release/.test(line));
    assert.ok(lines.length >= 1, "matrix section must carry a post-merge-pre-release stage sentence");
    const stageLine = lines.find(
      (line) => /未上 production/.test(line) && /(?:MUST NOT|不得)/.test(line) && /矩陣/.test(line)
    );
    assert.ok(
      stageLine,
      "違規：stage-applicability polarity（未上 production ＋ 不得端出矩陣）必須落在同一物理行，避免 decoupled includes"
    );
  });

  it("stage line reports the unshipped-mainline state and the stronger early-cleanup consent", async () => {
    const slice = matrixSection(await fs.readFile(HYGIENE_FILE, "utf8"));
    const stageLine = slice
      .split("\n")
      .find((line) => /未上 production/.test(line) && /(?:MUST NOT|不得)/.test(line) && /矩陣/.test(line));
    assert.ok(stageLine.includes("unshipped-mainline"), "stage line must report the unshipped-mainline state");
    assert.ok(
      stageLine.includes("--include-unshipped-mainline"),
      "stage line must name the stronger early-cleanup consent flag"
    );
  });

  it("unshipped-mainline remote cleanup names the Step 1 restore consequence at the action point", async () => {
    const slice = matrixSection(await fs.readFile(HYGIENE_FILE, "utf8"));
    const warning = slice.split("\n").find((line) => /遠端 unshipped-mainline 清理的前置提醒/.test(line));
    assert.ok(warning, "hygiene matrix section must carry the remote-cleanup prerequisite warning");
    assert.match(warning, /restore/, "the warning must name the Step 1 restore state");
    assert.match(warning, /release-step-1-7\.md/, "the warning must point at the Step 1 carrier");
    assert.match(warning, /headRefOid/, "the warning must name the authorised restore source");
  });

  it("matrix candidates are limited to this change; pre-existing items must be labelled", async () => {
    const slice = matrixSection(await fs.readFile(HYGIENE_FILE, "utf8"));
    const candidateLine = slice
      .split("\n")
      .find((line) => /只列本 change 相關候選/.test(line));
    assert.ok(candidateLine, "matrix section must state that candidates are limited to this change's own entries");
    assert.match(
      candidateLine,
      /既存無關[^\n]*MUST 明確標註為既存項/,
      "pre-existing unrelated branches/worktrees must be explicitly labelled as pre-existing"
    );
    assert.match(
      candidateLine,
      /不得列為本 change 的 consent 候選/,
      "pre-existing items must not be offered as this change's consent candidates"
    );
  });

  it("git-workflow-tracking post-merge sync guard points back at the matrix stage rule and keeps the SSOT pointer", async () => {
    const content = await fs.readFile(TRACKING_FILE, "utf8");
    const guardLines = content
      .split("\n")
      .filter((line) => line.includes("Post-merge sync ≠ 可刪分支（強制 guard）"));
    assert.equal(guardLines.length, 1, "post-merge sync guard must stay a single bounded paragraph");
    const guardLine = guardLines[0];
    assert.match(guardLine, /post-merge-pre-release/, "guard must name the post-merge-pre-release stop point");
    assert.match(guardLine, /post-PROD 清理矩陣/, "guard must reference the post-PROD cleanup matrix");
    assert.match(guardLine, /(?:MUST NOT|不得)[^\n]{0,80}(?:post-PROD 清理矩陣|矩陣)/, "guard must forbid surfacing the matrix before production");
    assert.ok(
      guardLine.includes("cleanup deferred until production"),
      "guard must keep the cleanup status annotation literal"
    );
    assert.match(guardLine, /git-branch-hygiene\.md/, "SSOT pointer to the hygiene leaf must be preserved");
  });

  it("existing Step 6 matrix fragments stay (post-PROD must not lose the matrix; symmetry face)", async () => {
    const content = await fs.readFile(HYGIENE_FILE, "utf8");
    const headingLines = content.split("\n").filter((line) => line === MATRIX_HEADING);
    assert.equal(headingLines.length, 1, "the post-PROD matrix section must stay exactly once");
    const hygieneCarrier = MATRIX_CARRIERS.find((carrier) => carrier.filePath === HYGIENE_FILE);
    const contractLines = content.split("\n").filter((line) => line.includes(hygieneCarrier.contractMarker));
    assert.equal(contractLines.length, 1, "the hygiene matrix contract line must stay exactly once");
    const missingFragments = hygieneCarrier.fragments.filter((fragment) => !contractLines[0].includes(fragment));
    assert.deepEqual(
      missingFragments,
      [],
      `違規：stage-applicability 補述不得移除既有 Step 6 fragments：${missingFragments.join(", ")}`
    );
    assert.ok(
      contractLines[0].includes("Post-PROD Cleanup Decision Matrix"),
      "post-PROD must still surface the matrix (symmetry face)"
    );
  });
});
