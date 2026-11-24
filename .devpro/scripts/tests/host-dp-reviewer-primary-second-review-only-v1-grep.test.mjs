/**
 * fix-ordinary-pre-pr-no-idle-stop: seams + anti-idle-stop lock.
 * Primary = host-native dp-reviewer on every host;
 * Claude/Codex CLI only via dp-second-reviewer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

// Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order
// (SKILL.md + that reference) so the locks and FORBIDDEN phrases cover both carriers.

const SEAMS = "host-dp-reviewer-primary-second-review-only-v1";
const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const DISPATCH =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";

const FORBIDDEN_IDLE = [
  "需要獨立章時 MUST 直接走能 mint 的 fresh normal path",
  "後才可 archive，不得以 TL 自審、Cursor Task 無券自審",
];

test("seams fingerprint in skill and dispatch reference", () => {
  const skill = readPrePrSkillFullReadingOrder();
  const dispatch = readFileSync(repoPath(DISPATCH), "utf8");
  assert.ok(skill.includes(SEAMS), `${SKILL} missing ${SEAMS}`);
  assert.ok(dispatch.includes(SEAMS), `${DISPATCH} missing ${SEAMS}`);
  assert.match(skill, /host-native/);
  assert.match(skill, /dp-second-reviewer/);
  assert.match(skill, /MUST NOT[\s\S]{0,160}run-codex-primary-review-operator/);
  assert.match(skill, /MUST NOT[\s\S]{0,80}Ask First/);
  assert.match(skill, /ordinary／無券[\s\S]{0,200}MUST NOT[\s\S]{0,80}豁免/);
  assert.match(skill, /ordinary／無券 primary \*\*不得\*\*主張豁免/);
  assert.match(skill, /post-PR cross-model 被豁免的 PR MUST 已有 fresh 獨立 primary review/);
  assert.equal(skill.includes("cursor-task-primary-second-review-only-v1"), false);
});

test("skill omits mint-before-archive idle-stop success phrases", () => {
  const skill = readPrePrSkillFullReadingOrder();
  for (const phrase of FORBIDDEN_IDLE) {
    assert.equal(
      skill.includes(phrase),
      false,
      `${SKILL} must not retain idle-stop phrase ${JSON.stringify(phrase)}`,
    );
  }
  const preGateStart = skill.indexOf("**Independence pre-gate");
  assert.ok(preGateStart >= 0, "Independence pre-gate section missing");
  const orderStart = skill.indexOf("順序：本 freeze", preGateStart);
  assert.ok(orderStart > preGateStart, "Independence pre-gate end marker missing");
  const preGate = skill.slice(preGateStart, orderStart);
  assert.equal(
    /Cursor host 固定入口：`node \.devpro\/scripts\/run-codex-primary-review-operator/.test(preGate),
    false,
    "Independence pre-gate must not list run-codex-primary-review-operator as Cursor primary entry",
  );
  assert.match(preGate, /Host-native mint→seal/);
  assert.match(preGate, /Non-primary mint／operator/);
  assert.match(preGate, /無 native `dp-reviewer`/);
});

// Independence verify timing: after archive, the admission claim has moved out of the active path, so
// `verify-receipt` returns the generic `receipt-authority-changed` with or without `requireIndependence`.
// The skill must say the independence verify runs BEFORE archive when path (a) is claimed, without turning
// it into a new archive precondition (the 禁誤讀 line stays: the archive gate does not look at mint).
test("independence verify timing is pinned before archive without becoming an archive precondition", () => {
  const skill = readPrePrSkillFullReadingOrder();
  const marker = "**獨立 verify 時點";
  const bullets = skill.split("\n").filter((line) => line.includes(marker));
  assert.equal(bullets.length, 1, `${SKILL} must carry exactly one independence verify timing bullet`);
  const bullet = bullets[0];
  for (const anchor of [
    "verify-receipt",
    "requireIndependence: true",
    "archive",
    "receipt-authority-changed",
    "admission claim",
    "active path",
    "(a)",
    "(b)",
    "sticky second",
    "PR 描述",
    "不是新增 archive 前置條件",
  ]) {
    assert.ok(bullet.includes(anchor), `independence verify timing bullet missing anchor: ${anchor}`);
  }
  assert.ok(
    bullet.indexOf("之前") >= 0 && bullet.indexOf("之前") < bullet.indexOf("receipt-authority-changed"),
    "the before-archive requirement must be stated before the post-archive failure code",
  );

  // Discoverable from the archive step itself, not only from the contract list.
  const archiveStart = skill.indexOf("### 第三點六步段");
  assert.ok(archiveStart >= 0, "Step 3.6 heading missing");
  assert.ok(
    skill.slice(archiveStart, archiveStart + 900).includes("獨立 verify 時點"),
    "Step 3.6 opening must point at the independence verify timing bullet",
  );

  // The established 禁誤讀 stays intact: archive gate looks at primary Critical/Important, not at mint.
  assert.match(skill, /archive 閘看 primary Critical／Important，不看 primary 是否已 mint/u);
  assert.equal(skill.includes("獨立章必須先 mint 才可 archive"), false);

  // The cited failure code is a real closed code of the receipt authority path, not prose.
  const core = readFileSync(repoPath(".devpro/scripts/lib/review-remediation-evidence-core.mjs"), "utf8");
  assert.ok(core.includes("receipt-authority-changed"), "core no longer emits receipt-authority-changed");
});
