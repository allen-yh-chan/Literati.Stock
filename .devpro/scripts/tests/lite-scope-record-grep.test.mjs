/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: the lite-scope record format, its matching rules and the disclosure
 * wording across the change skill, `ai-autonomy.md` and the related carriers.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 *
 * lite-scope-record-grep.test.mjs
 *
 * Guards the cooperative carriers of the lite batch scope record
 * (`openspec/changes/<change-name>/lite-scope.md`, design.md D5) that no
 * runtime gate can observe:
 *   - `/devpro:change` skill lite section: write only AFTER the user chose
 *     batch, paste the line in the same reply naming the user's answer,
 *     stepwise writes nothing, switching to stepwise deletes the file;
 *   - `ai-autonomy.md` Matching Batch Approval Ledger paragraph: a matching
 *     record satisfies Ask First for covered writes, and a record written
 *     without a batch choice is forged consent evidence;
 *   - every other carrier that reads the proposal ledger for batch approval
 *     evidence (change skill, pre-pr skill, openspec-flow.md, cursor adapter)
 *     names the lite record as the carrier when no proposal exists.
 * The mechanical halves (evaluateLiteScopeRecord, Gate R1/SP, archive gate)
 * are tested in batch-approval-ledger.test.mjs, hook-pre-tool-gate-lite-scope
 * .test.mjs and the pre-pr-archive-gate tests; this file ties the skill's
 * template line to that evaluator.
 *
 * Anchor strength follows `.devpro/agent-rules/rule-anchor-guard-strength.md`:
 * polarity-sensitive anchors bind polarity word and object on ONE physical
 * line with a bounded gap (no alternation, no decoupled includes); each
 * anchor must match exactly once, and a mutation audit proves that deleting
 * an anchor's operative text turns exactly that anchor red without any other
 * line compensating. The retired-grant side (absence) is guarded by a
 * permanent two-way fixture.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evaluateLiteScopeRecord, readLiteScopeRecord } from "../lib/batch-approval-ledger.mjs";
import { readRepoFile as read } from "./lib/read.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const SKILL = ".devpro/agent-skills/devpro-workflows/change/SKILL.md";
const AUTONOMY = ".devpro/agent-rules/ai-autonomy.md";
const RIGOR = ".devpro/agent-rules/rules-rigor-level.md";
const GITIGNORE_LINE = "openspec/changes/**/lite-scope.md";
const STANDARD_COVERS = [
  "worktree",
  "local_commit",
  "pre_pr_gate",
  "first_push",
  "pr_create_update",
  "workflow_watch",
  "post_pr_completion_gate",
  "scenario_walkthrough",
];
const STANDARD_EXCLUDES = ["merge", "release", "destructive", "secrets", "cross_repo_write"];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Parts are literal text that MUST appear in order on ONE physical line, with
// at most `gap` non-newline characters between consecutive parts.
function rowAnchor(parts, { gap = 200, bol = false } = {}) {
  const body = parts.map(escapeRegExp).join(`[^\\n]{0,${gap}}`);
  return new RegExp(`${bol ? "^" : ""}${body}`, bol ? "gm" : "g");
}

function slice(content, startMarker, endMarker, label) {
  const starts = content.split(startMarker).length - 1;
  assert.equal(starts, 1, `${label}: start marker must occur exactly once, found ${starts}: ${startMarker}`);
  const start = content.indexOf(startMarker);
  const end = endMarker ? content.indexOf(endMarker, start + startMarker.length) : content.length;
  assert.ok(end > start, `${label}: end marker not found after start: ${endMarker}`);
  return content.slice(start, end);
}

function liteSection(skill = read(SKILL)) {
  return slice(skill, "### Lite rigor level：跳過什麼、batch approval 怎麼取得", "\n**Scope Change Re-entry", "change skill lite section");
}

function matchingParagraph(autonomy = read(AUTONOMY)) {
  const marker = "> **Matching Batch Approval Ledger = Ask First already satisfied";
  const start = autonomy.indexOf(marker);
  assert.equal(autonomy.split(marker).length - 1, 1, "ai-autonomy.md: Matching Batch Approval Ledger paragraph must occur exactly once");
  const end = autonomy.indexOf("\n", start);
  return autonomy.slice(start, end === -1 ? undefined : end);
}

const SKILL_ANCHORS = {
  batchChoiceThenWrite: rowAnchor(
    [
      "- **選 batch 之後才寫 `lite-scope.md`**",
      "使用者選 batch（或請求中已明說）之後",
      "worktree 內第一個寫入就是 `lite-scope.md`",
    ],
    { bol: true },
  ),
  sameReplyPasteNamesAnswer: rowAnchor(
    [
      "- **同一輪回覆貼出該行並點名使用者的回答**：寫入 `lite-scope.md` 的同一輪回覆 MUST 把該行原文貼給使用者",
      "並點名它依據的是使用者哪一次回答",
    ],
    { bol: true },
  ),
  stepwiseWritesNothing: rowAnchor(
    ["- **stepwise 不寫**：使用者選 stepwise 或尚未回答時 MUST NOT 寫此檔"],
    { bol: true },
  ),
  // One clause must name all three cases and end in the forgery classification.
  forgedConsentThreeCases: rowAnchor(["在 stepwise、尚未回答或自行推斷 batch 時寫出相符紀錄，屬偽造同意證據"]),
  midChangeStepwiseDeletes: rowAnchor(
    [
      "- **中途改 stepwise 就刪檔**：使用者中途改成 stepwise 時，TL MUST 立即刪除 `lite-scope.md`",
      "後續 covered write 回到逐步確認",
    ],
    { bol: true },
  ),
  compressionResumeReads: rowAnchor(
    [
      "- **壓縮或重啟後**：照讀此檔、不重問",
      "`covers` 內的 git／PR write 不再詢問（`ai-autonomy.md` Matching Batch Approval Ledger）",
    ],
    { bol: true },
  ),
};

const AUTONOMY_ANCHORS = {
  recordSatisfiesAskFirst: rowAnchor(
    [
      "**lite** 沒有 proposal 時，等價載體是 worktree 內 `openspec/changes/<change-name>/lite-scope.md` 一行紀錄",
      "相符紀錄涵蓋的 git／PR write 已取得 Ask First 同意，**MUST 直接執行**、**MUST NOT** 再問",
    ],
    { gap: 300 },
  ),
  recordExcludesStayAskFirst: rowAnchor(["`excludes`（merge／release／destructive／secrets／cross-repo write）仍 Ask First"]),
  forgedConsentEvidence: rowAnchor([
    "**lite 紀錄只能在使用者選 batch 之後寫**：stepwise、使用者尚未回答或 AI 自行推斷時寫出相符紀錄，屬偽造同意證據",
  ]),
  sameReplyPasteLine: rowAnchor(["寫入的同一輪回覆 **MUST** 貼出該行原文並點名依據的使用者回答"]),
  cooperativeOnly: rowAnchor(["此條為 cooperative 規則", "Gate R1／SP 只驗紀錄格式、change 與 branch"]),
};

function count(regex, text) {
  return [...text.matchAll(regex)].length;
}

function assertAnchorOnce(name, regex, text) {
  assert.equal(count(regex, text), 1, `anchor ${name} must match exactly once`);
}

// Retired lite-grant vocabulary (side: absence). Kept as a function so the
// permanent fixtures below can prove the marker is neither too narrow nor too wide.
const RETIRED_LITE_GRANT_MARKERS = [
  "grant-lite-disclosure",
  "lite-batch-approval",
  "lite-explicit-approval",
  "lite batch grant",
  "24 小時",
  "續期",
  "第一個送去第二意見審查",
];
function retiredLiteGrantHits(text) {
  return RETIRED_LITE_GRANT_MARKERS.filter((marker) => text.includes(marker));
}

function skillTemplateLine() {
  const block = liteSection().match(/```text\n([^\n]*)\n```/g) ?? [];
  assert.equal(block.length, 1, `lite section must carry exactly one fenced text record template, found ${block.length}`);
  return block[0].replace(/^```text\n/, "").replace(/\n```$/, "");
}

function fillTemplate(template, changeName, branch) {
  return template.replace("<change-name>", changeName).replace("<branch>", branch);
}

function listOf(line, key) {
  const field = line.split("; ").find((entry) => entry.startsWith(`${key}=`));
  assert.ok(field, `record template missing field ${key}`);
  return field.slice(key.length + 1).split(",");
}

// Two-way set equality that names the missing and the extra value.
function assertSetEqual(actual, expected, label) {
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${label}: missing ${missing.join(",") || "-"}; extra ${extra.join(",") || "-"}`);
}

test("Matching Lite Scope Record Satisfies Ask First For Covered Writes", () => {
  const paragraph = matchingParagraph();
  assertAnchorOnce("recordSatisfiesAskFirst", AUTONOMY_ANCHORS.recordSatisfiesAskFirst, paragraph);
  assertAnchorOnce("recordExcludesStayAskFirst", AUTONOMY_ANCHORS.recordExcludesStayAskFirst, paragraph);
  assertAnchorOnce("cooperativeOnly", AUTONOMY_ANCHORS.cooperativeOnly, paragraph);

  // The record the skill tells the TL to write covers local_commit and first_push
  // and keeps the excluded actions out of covers, so the paragraph's promise holds.
  const line = fillTemplate(skillTemplateLine(), "demo-change", "feature/demo-change");
  const covers = listOf(line, "covers");
  assert.ok(covers.includes("local_commit") && covers.includes("first_push"), "template covers local_commit and first_push");
  for (const excluded of STANDARD_EXCLUDES) {
    assert.ok(listOf(line, "excludes").includes(excluded), `template excludes ${excluded}`);
    assert.ok(!covers.includes(excluded), `template covers must not contain ${excluded}`);
  }
  assert.equal(evaluateLiteScopeRecord(`${line}\n`, { changeName: "demo-change", branch: "feature/demo-change" }).status, "match");
  // A record for another change or branch authorizes nothing.
  assert.equal(evaluateLiteScopeRecord(`${line}\n`, { changeName: "other-change", branch: "feature/demo-change" }).status, "mismatch");
  assert.equal(evaluateLiteScopeRecord(`${line}\n`, { changeName: "demo-change", branch: "feature/other" }).status, "mismatch");
});

test("Batch choice writes one matching untracked line", () => {
  const lite = liteSection();
  assertAnchorOnce("batchChoiceThenWrite", SKILL_ANCHORS.batchChoiceThenWrite, lite);

  const template = skillTemplateLine();
  assert.ok(!template.includes("\n"), "template is exactly one line");
  const line = fillTemplate(template, "demo-change", "feature/demo-change");
  const result = evaluateLiteScopeRecord(`${line}\n`, { changeName: "demo-change", branch: "feature/demo-change" });
  assert.deepEqual(result, { status: "match", issue: "" }, `skill template line must evaluate match: ${result.issue}`);

  // Symmetry with the full ledger template: same action list, no external-disclosure items.
  assertSetEqual(listOf(line, "covers"), STANDARD_COVERS, "lite record covers");
  assertSetEqual(listOf(line, "excludes"), STANDARD_EXCLUDES, "lite record excludes");

  // The hook's block message embeds the same template line the skill tells the TL to write.
  const hookSource = read(".devpro/scripts/hooks/pre-tool-gate.mjs");
  const declaration = hookSource.match(/const LITE_RECORD_TEMPLATE =\n((?:\s+"[^"\n]*"(?: \+)?\n?)+);/);
  assert.ok(declaration, "pre-tool-gate.mjs declares LITE_RECORD_TEMPLATE as concatenated string literals");
  const hookTemplate = [...declaration[1].matchAll(/"([^"\n]*)"/g)].map((part) => part[1]).join("");
  assert.equal(hookTemplate, template, "Gate R1 message template must equal the change skill's record template");

  // Untracked: the managed gitignore baseline carries the line, and git agrees.
  assert.match(read(".gitignore"), new RegExp(`^${escapeRegExp(GITIGNORE_LINE)}$`, "m"), ".gitignore carries the lite-scope.md entry");
  assert.match(read(".devpro/agent-rules/gitignore-alignment.md"), new RegExp(`^${escapeRegExp(GITIGNORE_LINE)}$`, "m"), "gitignore-alignment.md baseline carries the lite-scope.md entry");
  const ignored = spawnSync("git", ["check-ignore", "-q", "openspec/changes/demo-change/lite-scope.md"], { cwd: REPO_ROOT });
  assert.equal(ignored.status, 0, "git check-ignore must match openspec/changes/<change-name>/lite-scope.md");
});

test("Writing the record discloses the line in the same reply [cooperative-only, weak enforcement]", () => {
  assertAnchorOnce("sameReplyPasteNamesAnswer", SKILL_ANCHORS.sameReplyPasteNamesAnswer, liteSection());
  const paragraph = matchingParagraph();
  assertAnchorOnce("sameReplyPasteLine", AUTONOMY_ANCHORS.sameReplyPasteLine, paragraph);
  // The same-reply duty is paired with the forged-consent classification in both carriers.
  assertAnchorOnce("forgedConsentEvidence", AUTONOMY_ANCHORS.forgedConsentEvidence, paragraph);
  assertAnchorOnce("stepwiseWritesNothing", SKILL_ANCHORS.stepwiseWritesNothing, liteSection());
  assertAnchorOnce("forgedConsentThreeCases", SKILL_ANCHORS.forgedConsentThreeCases, liteSection());
});

test("Stepwise lite leaves no record [cooperative-only, weak enforcement]", () => {
  const lite = liteSection();
  assertAnchorOnce("stepwiseWritesNothing", SKILL_ANCHORS.stepwiseWritesNothing, lite);
  assertAnchorOnce("midChangeStepwiseDeletes", SKILL_ANCHORS.midChangeStepwiseDeletes, lite);
  assertAnchorOnce("compressionResumeReads", SKILL_ANCHORS.compressionResumeReads, lite);

  // Mechanical half: a missing file authorizes nothing; the evaluator never invents a record.
  const root = mkdtempSync(path.join(tmpdir(), "lite-scope-"));
  try {
    const identity = { changeName: "demo-change", branch: "feature/demo-change" };
    mkdirSync(path.join(root, "openspec", "changes", "demo-change"), { recursive: true });
    assert.equal(readLiteScopeRecord(root, identity).status, "missing", "stepwise: no record is written");
    const recordPath = path.join(root, "openspec", "changes", "demo-change", "lite-scope.md");
    writeFileSync(recordPath, `${fillTemplate(skillTemplateLine(), "demo-change", "feature/demo-change")}\n`);
    assert.equal(readLiteScopeRecord(root, identity).status, "match");
    rmSync(recordPath);
    assert.equal(readLiteScopeRecord(root, identity).status, "missing", "mid-change switch to stepwise: deleting the file returns to missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lite carriers no longer describe a grant: retired markers are absent", () => {
  assert.deepEqual(retiredLiteGrantHits(liteSection()), [], "change skill lite section");
  assert.deepEqual(retiredLiteGrantHits(matchingParagraph()), [], "ai-autonomy.md Matching Batch Approval Ledger paragraph");
  const rigorLine = read(RIGOR).split("\n").find((line) => line.startsWith("> lite 不寫 OpenSpec proposal"));
  assert.ok(rigorLine, "rules-rigor-level.md keeps the lite carrier note");
  assert.deepEqual(retiredLiteGrantHits(rigorLine), [], "rules-rigor-level.md lite carrier note");
  assert.match(rigorLine, /`openspec\/changes\/<change-name>\/lite-scope\.md`/, "rigor note names the record path");
});

test("retired-marker guard fixtures stay two-way (marker neither too narrow nor too wide)", () => {
  // Real wording of the retired carrier: every line MUST be caught.
  for (const retired of [
    "node .devpro/scripts/grant-lite-disclosure.mjs --batch --repo <owner/name> --branch <branch> --change <name>",
    "- **有效期與續期**：24 小時內一次確認，超過需續期一次",
    "揭露行與 builder 開關 `--lite-batch-approval` 見 `/devpro:cross-review`",
    "走逐 PR 路徑 `build-pr-sticky-handoff.mjs --lite-explicit-approval`",
    "只對此 branch 上第一個送去第二意見審查的同 repo PR 有效",
    "批次授權的載體改為 lite batch grant",
  ]) {
    assert.ok(retiredLiteGrantHits(retired).length > 0, `retired wording must be caught: ${retired}`);
  }
  // Legitimate current wording: every line MUST pass.
  for (const legit of [
    "紀錄綁此 change＋branch，無有效期。",
    "cross-model 第二意見（`cross-model-sticky-merge-review` 仍 fire；builder 用 `--lite`）",
    "- **壓縮或重啟後**：照讀此檔、不重問。",
  ]) {
    assert.deepEqual(retiredLiteGrantHits(legit), [], `legitimate wording must pass: ${legit}`);
  }
});

test("template set-equality guard names the extra value (insertion fixture)", () => {
  assert.throws(() => assertSetEqual([...STANDARD_COVERS, "external_disclosure"], STANDARD_COVERS, "fixture"), /extra external_disclosure/);
  assert.throws(() => assertSetEqual(STANDARD_COVERS.slice(1), STANDARD_COVERS, "fixture"), /missing worktree/);
});

test("mutation audit: deleting an anchor's operative text turns exactly that anchor red", () => {
  const targets = [
    { label: "change skill lite section", text: liteSection(), anchors: SKILL_ANCHORS },
    { label: "ai-autonomy.md paragraph", text: matchingParagraph(), anchors: AUTONOMY_ANCHORS },
  ];
  for (const { label, text, anchors } of targets) {
    for (const [name, regex] of Object.entries(anchors)) {
      assertAnchorOnce(`${label} / ${name}`, regex, text);
      const mutated = text.replace(new RegExp(regex.source, regex.flags.replace("g", "")), "");
      assert.equal(count(regex, mutated), 0, `${label} / ${name}: still satisfied after deleting its text, another line compensates`);
      for (const [otherName, otherRegex] of Object.entries(anchors)) {
        if (otherName === name) continue;
        assert.equal(count(otherRegex, mutated), 1, `${label} / ${otherName}: lost after deleting ${name}, anchors overlap`);
      }
    }
  }
});

test("polarity fixture: a weakened sentence no longer satisfies the row anchor", () => {
  const weakened = read(SKILL)
    .replace("MUST NOT 寫此檔", "可寫此檔")
    .replace("MUST 立即刪除 `lite-scope.md`", "可刪除 `lite-scope.md`");
  const lite = liteSection(weakened);
  assert.equal(count(SKILL_ANCHORS.stepwiseWritesNothing, liteSection()), 1, "baseline: the unweakened sentence satisfies the anchor");
  assert.equal(count(SKILL_ANCHORS.midChangeStepwiseDeletes, liteSection()), 1, "baseline: the unweakened sentence satisfies the anchor");
  assert.equal(count(SKILL_ANCHORS.stepwiseWritesNothing, lite), 0);
  assert.equal(count(SKILL_ANCHORS.midChangeStepwiseDeletes, lite), 0);
});

test("branch rename manual list keeps the lite record's branch field in step with the ledger", () => {
  const line = read(".devpro/agent-rules/chore-classification.md")
    .split("\n")
    .filter((candidate) => /同步改 Batch Approval Ledger 的 `branch:`/.test(candidate));
  assert.equal(line.length, 1, "exactly one manual-list bullet names the ledger branch field");
  assert.match(line[0], /lite 沒有 proposal 時，同步改 `lite-scope\.md` 的 `branch=`/, "the same bullet names the lite record's branch field");
});

// F-rsdda-r1-01 and its cross-carrier closure: every carrier that tells the TL to read the active
// proposal ledger for batch approval evidence also names the lite record as the carrier when no
// proposal exists. Without it a lite TL finds "no ledger", classifies the next write as user-owned and
// stops mid-flow, which is the stop the lite record exists to remove. One physical line per anchor,
// one occurrence per carrier file, and each anchor binds the proposal carrier AND the lite record.
const LITE_CARRIER_CLAUSES = [
  {
    file: SKILL,
    label: "change skill diagnosis re-entry checkpoint",
    anchor: rowAnchor(["- Diagnosis-to-implementation re-entry", "`## Batch Approval Ledger`（lite 無 proposal 時為相符的 `lite-scope.md`）必須是 matching structured ledger"], { gap: 700, bol: true }),
  },
  {
    file: SKILL,
    label: "change skill session-pending claim precheck",
    anchor: rowAnchor(["若 claimed 條目本身記錄 batch approval", "lite 無 proposal 載體：此時相符的 `openspec/changes/<change-name>/lite-scope.md`", "即滿足 Gate SP", "missing、mismatch 或 malformed 才是 invalid evidence"], { gap: 700, bol: true }),
  },
  {
    file: SKILL,
    label: "change skill turn-end ledger self-check",
    anchor: rowAnchor(["1. 讀 active `proposal.md` / `proposal-mini.md` 的 `## Batch Approval Ledger`", "lite 無 proposal 時讀 `openspec/changes/<change-name>/lite-scope.md` 一行紀錄"], { bol: true }),
  },
  {
    file: ".devpro/agent-rules/openspec-flow.md",
    label: "openspec-flow diagnosis re-entry checkpoint",
    anchor: rowAnchor(["**Diagnosis-to-implementation re-entry**", "`## Batch Approval Ledger`（lite 無 proposal 時為相符的 `lite-scope.md`）是 matching structured ledger"], { gap: 700, bol: true }),
  },
  {
    file: ".devpro/agent-rules/platform-adapters/cursor.md",
    label: "cursor adapter ledger carrier read",
    anchor: rowAnchor(["1. **讀 ledger carrier**", "lite 無 proposal 時讀 `openspec/changes/<name>/lite-scope.md` 一行紀錄"], { bol: true }),
  },
  {
    file: ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
    label: "pre-pr carry-forward precheck",
    anchor: rowAnchor(["在任何 pre-PR / PR 建立流程中", "lite 無 proposal 時為相符的 `openspec/changes/<change-name>/lite-scope.md`"], { gap: 700, bol: true }),
  },
  {
    file: ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md",
    label: "pre-pr scenario walkthrough ledger resolve",
    anchor: rowAnchor(["Trigger 命中後先解析 active `Batch Approval Ledger`（lite 為 `lite-scope.md`）"], { bol: true }),
  },
];

test("Every ledger-reading carrier names the lite record when no proposal exists", () => {
  for (const { file, label, anchor } of LITE_CARRIER_CLAUSES) {
    assertAnchorOnce(label, anchor, read(file));
  }
});

test("lite carrier clause guard: removing the lite clause turns exactly that carrier red", () => {
  for (const { file, label, anchor } of LITE_CARRIER_CLAUSES) {
    const text = read(file);
    const mutated = text.replace(/lite-scope\.md/g, "<carrier>");
    assert.equal(count(anchor, mutated), 0, `${label}: still satisfied without the lite record name`);
  }
});

// fix-lite-plan-tracking: a lite change has no archive step, so a committed
// `openspec/changes/<change>/plan.md` stayed an active change with no spec delta
// and failed `openspec validate --strict --all` at the v7.17.0 release gate. The
// plan stays local like the record: both managed-ignore carriers hold the entry,
// git ignores a first-level plan.md, an archived plan.md stays trackable, and the
// change skill states it.
const PLAN_GITIGNORE_LINE = "openspec/changes/*/plan.md";

test("the lite plan.md stays local: ignored at the change level, trackable under archive", () => {
  const entry = new RegExp(`^${escapeRegExp(PLAN_GITIGNORE_LINE)}$`, "m");
  assert.match(read(".gitignore"), entry, ".gitignore carries the lite plan.md entry");
  assert.match(read(".devpro/agent-rules/gitignore-alignment.md"), entry, "gitignore-alignment.md baseline carries the lite plan.md entry");
  const checkIgnore = (rel) => spawnSync("git", ["check-ignore", "-q", rel], { cwd: REPO_ROOT }).status;
  assert.equal(checkIgnore("openspec/changes/demo-change/plan.md"), 0, "a change-level plan.md must be ignored");
  assert.equal(checkIgnore("openspec/changes/archive/2026-01-01-demo-change/plan.md"), 1, "an archived plan.md must stay trackable");

  const lite = liteSection();
  assertAnchorOnce("planStaysLocal", rowAnchor(["`plan.md`（兩者都被 `.gitignore` 忽略、不進 git；交付說明寫在 PR body"]), lite);
  assert.doesNotMatch(lite, /`plan\.md` 可入 git/u, "the skill must not tell a lite change to commit plan.md");
});
