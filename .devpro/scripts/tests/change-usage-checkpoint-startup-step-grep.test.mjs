import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";

// Task 2 of add-change-cost-circuit-breaker: `/devpro:change` startup step 13
// (design.md D7 / round 4 F-4-3 / round 6 F-6-2). This test only reads the
// skill file — no fs write, no child_process, no fixture calls — so it stays
// unit tier per test-suite-manifest.mjs.
describe("devpro:change startup step 13 records the change usage checkpoint", () => {
  const skill = read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");

  // Scope the numbered-step lookup to the 第三步 startup sequence itself —
  // the skill file has other unrelated numbered lists (e.g. batch approval
  // options) earlier in the document that would otherwise false-match "1.".
  const sectionStart = skill.indexOf("**第三步：建 worktree");
  assert.ok(sectionStart >= 0, "第三步 section must exist");
  const sectionEnd = skill.indexOf("**Formalize auto-promote", sectionStart);
  assert.ok(sectionEnd > sectionStart, "第三步 section must end before Formalize auto-promote");
  const section = skill.slice(sectionStart, sectionEnd);

  function step(number) {
    const pattern = new RegExp(`^${number}\\. (.+)$`, "m");
    const match = section.match(pattern);
    assert.ok(match, `step ${number} must exist as a numbered line in 第三步`);
    return match[1];
  }

  it("steps 1-12 are unchanged (pure append, not a renumber)", () => {
    assert.match(step(1), /保護分支 \/ cwd 校驗/);
    assert.match(step(2), /working tree 乾淨/);
    assert.match(step(3), /同步 refs/);
    assert.match(step(4), /production ancestry gate/);
    assert.match(step(5), /分支依賴確認/);
    assert.match(step(6), /決定 base/);
    assert.match(step(7), /git worktree add/);
    assert.match(step(8), /git submodule update --init --recursive/);
    assert.match(step(9), /cwd 切入 worktree/);
    assert.match(step(10), /環境檢查\/setup/);
    assert.match(step(11), /mkdir -p openspec\/changes\/<change-name>\//);
    assert.match(step(12), /寫入 `openspec\/changes\/<change-name>\/meeting-notes\.md`/);
  });

  // Each assertion helper below is exercised twice: once against the real
  // section (must pass) and once against a mutated copy (must throw) — the
  // precedent pattern in environment-setup-local-runtime-settings-grep.test.mjs.
  // A helper that isn't independently shown to fail on the regression it
  // claims to guard is a vacuous test.

  function assertStepThirteenIsUnconditional(sectionText) {
    const stepThirteen = new RegExp(`^13\\. (.+)$`, "m").exec(sectionText)?.[1];
    assert.ok(stepThirteen, "step 13 must exist");
    assert.match(stepThirteen, /node \.devpro\/scripts\/record-change-usage-checkpoint\.mjs --change <change-name>/);
    assert.match(stepThirteen, /無條件執行/);
    assert.match(stepThirteen, /B-mini \/ chore A \*\*不可\*\*跳過/);
  }

  function assertStepThirteenWritesBoth(sectionText) {
    const stepThirteen = new RegExp(`^13\\. (.+)$`, "m").exec(sectionText)?.[1];
    assert.ok(stepThirteen, "step 13 must exist");
    assert.match(stepThirteen, /appendChangeUsageSession/);
    assert.match(stepThirteen, /sessions\[\]/);
    assert.match(stepThirteen, /recordSessionChangeTransition/);
    assert.match(stepThirteen, /transition ledger/);
    assert.match(stepThirteen, /兩筆寫入缺一不可/);
  }

  function assertStepThirteenFailOpenContract(sectionText) {
    const stepThirteen = new RegExp(`^13\\. (.+)$`, "m").exec(sectionText)?.[1];
    assert.ok(stepThirteen, "step 13 must exist");
    assert.match(stepThirteen, /write_failed/);
    assert.match(stepThirteen, /advisory/);
    assert.match(stepThirteen, /exit 0/);
    assert.match(stepThirteen, /不 block、不中止其餘步驟/);
  }

  function assertStepThirteenPlacement(fullSkillText) {
    const twelveIndex = fullSkillText.indexOf("12. 寫入 `openspec/changes/<change-name>/meeting-notes.md`");
    const thirteenIndex = fullSkillText.indexOf("13. **成本用量 checkpoint 登記**");
    const formalizeIndex = fullSkillText.indexOf("**Formalize auto-promote");
    assert.ok(twelveIndex > 0 && thirteenIndex > twelveIndex && formalizeIndex > thirteenIndex);
  }

  it("step 13 exists, runs the new CLI wrapper, and is unconditional (no B-mini/chore-A skip)", () => {
    assertStepThirteenIsUnconditional(section);
  });

  it("step 13 names both required writes — per-change checkpoint AND the transition ledger — not just one", () => {
    assertStepThirteenWritesBoth(section);
  });

  it("step 13 states the write_failed fail-open contract: visible advisory, exit 0, does not abort startup", () => {
    assertStepThirteenFailOpenContract(section);
  });

  it("step 13 sits between step 12 and the Formalize auto-promote section, not appended elsewhere", () => {
    assertStepThirteenPlacement(skill);
  });

  it("independently rejects deletion/renumbering/conditional-skip/single-write mutations of step 13", () => {
    // No step 13 at all (deleted).
    const withoutStep13 = section.replace(/\n13\. \*\*成本用量 checkpoint 登記[\s\S]*$/, "\n");
    assert.throws(() => assertStepThirteenIsUnconditional(withoutStep13));
    assert.throws(() => assertStepThirteenWritesBoth(withoutStep13));
    assert.throws(() => assertStepThirteenFailOpenContract(withoutStep13));

    // Made conditional / skippable (regresses the "無條件執行" MUST).
    const conditionalStep13 = section.replace("無條件執行，B-mini / chore A **不可**跳過", "B-mini / chore A 可免");
    assert.throws(() => assertStepThirteenIsUnconditional(conditionalStep13));

    // Only writes the per-change checkpoint, drops the transition ledger call.
    const missingTransitionWrite = section.replace(
      /同一步驟內同時呼叫 `appendChangeUsageSession`（寫入 per-change checkpoint 的 `sessions\[\]`）與 `recordSessionChangeTransition`（寫入跨 change 共用的 global session-activity transition ledger）——兩筆寫入缺一不可/,
      "呼叫 `appendChangeUsageSession`（寫入 per-change checkpoint 的 `sessions[]`）"
    );
    assert.throws(() => assertStepThirteenWritesBoth(missingTransitionWrite));

    // Drops the fail-open contract wording (silently reverts F-4-3).
    const missingFailOpenWording = section.replace(
      /任一寫入回傳 `write_failed` 時，腳本輸出非阻斷的可見 advisory（`\[record-change-usage-checkpoint\] ADVISORY: \.\.\.`）並仍以 exit 0 結束——啟動序列不 block、不中止其餘步驟（round 4 finding F-4-3 的 fail-open 紀律：`notes\/` 為 gitignored 本機狀態，擋下沒有救濟）。/,
      ""
    );
    assert.throws(() => assertStepThirteenFailOpenContract(missingFailOpenWording));

    // Placement regression: step 13 moved before step 12 (renumber/reorder).
    const reordered = skill.replace(
      "11. `mkdir -p openspec/changes/<change-name>/`\n12. 寫入 `openspec/changes/<change-name>/meeting-notes.md`（B-mini / chore A 可免，仍建議留底）——此檔 MUST 為本 worktree 內**第一個** repo write（緊接 env checks 之後、其他 tracked 寫入之前；對齊 `openspec-branch-routing.md` §Step 0：未**收集**不得建分支，收集≠先寫 tracked notes）\n13. **成本用量 checkpoint 登記**",
      "13. **成本用量 checkpoint 登記**\n11. `mkdir -p openspec/changes/<change-name>/`\n12. 寫入 `openspec/changes/<change-name>/meeting-notes.md`（B-mini / chore A 可免，仍建議留底）——此檔 MUST 為本 worktree 內**第一個** repo write（緊接 env checks 之後、其他 tracked 寫入之前；對齊 `openspec-branch-routing.md` §Step 0：未**收集**不得建分支，收集≠先寫 tracked notes）"
    );
    assert.throws(() => assertStepThirteenPlacement(reordered));
  });
});
