/**
 * clarify-workflow-watch-dir-precheck-grep.test.mjs
 *
 * Locks anchor strings for the clarified workflow-watch No-trigger SOP:
 *  - git-workflow-tracking.md（SSOT）No-trigger SOP 前置 step 0：先驗
 *    `.github/workflows/` 目錄存在／無 workflow 檔 → `no checks`=確定終態 N/A、
 *    不進 sleep-retry watch loop。
 *  - pre-pr/SKILL.md Step 5 Workflow watch 引用該前置偵測（指向 SSOT）。
 *
 * Background: No-trigger SOP 原措辭是「gh pr checks 見空『之後』才讀 workflow
 * schema」（事後），且 sub-item 1-4 預設 `.github/workflows/*.yml` 存在，未涵蓋
 * 「整個 dir 不存在」——本 session（source CI 退役、無 .github/workflows/）即因此
 * 白等兩輪 sleep。本 clarify 把「無 CI 判定」前移到前置偵測（前饋 > 事後，同源
 * ai-autonomy.md §9 時機維度）。
 *
 * SSOT anchor 斷言 scoped 到 No-trigger SOP 段（extractNoTriggerSop），skill
 * anchor 斷言 scoped 到 devpro:pre-pr Step 5 Workflow watch 段（extractPrePrStep5），
 * 兩側對稱避免 whole-file false-pass。
 *
 * Style reference: strengthen-usability-first-self-check-grep.test.mjs
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readSourceFile as read } from './lib/read.mjs';



/**
 * Scope anchor assertions to the No-trigger 判定 SOP block only (from its
 * bold header up to the next top-level numbered step `2.`), so anchors that
 * appear elsewhere in git-workflow-tracking.md can never false-pass this guard.
 */
function extractNoTriggerSop(md) {
  const block = md.match(/\*\*No-trigger 判定 SOP\*\*[\s\S]*?(?=\n2\. \*\*逐一取得 run\*\*)/);
  assert.ok(block, 'git-workflow-tracking.md: No-trigger 判定 SOP 段不存在——無法定位前置偵測');
  return block[0];
}

/**
 * Scope skill-side assertions to the devpro:pre-pr Step 5 Workflow watch block
 * (from `### Step 5: Post-PR Workflow Watch` up to `### Step 5.5`), symmetric
 * to the SSOT side.
 */
function extractPrePrStep5(md) {
  const block = md.match(/### Step 5: Post-PR Workflow Watch[\s\S]*?(?=### Step 5\.5)/);
  assert.ok(block, 'pre-pr/SKILL.md: Step 5 Workflow Watch 段不存在——無法定位前置偵測引用');
  return block[0];
}

const workflowTrackingMd = read('.devpro/agent-rules/git-workflow-tracking.md');
const prePrSkillMd = read('.devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md');
const noTriggerSop = extractNoTriggerSop(workflowTrackingMd);
const prePrStep5 = extractPrePrStep5(prePrSkillMd);

test('SSOT: No-trigger SOP 前置偵測 `.github/workflows/` 目錄存在性', () => {
  assert.ok(
    noTriggerSop.includes('.github/workflows/'),
    'git-workflow-tracking.md No-trigger SOP 缺 `.github/workflows/` 目錄偵測——前置 step 0 須先驗此目錄存在與否'
  );
});

test('SSOT: 前置偵測含「目錄不存在 → 確定終態 N/A、不進 watch loop」語意', () => {
  // `不進` 之間可能夾 markdown bold 標記（`**不**進`），故容忍 0-2 個 `*`
  assert.ok(
    /確定終態/.test(noTriggerSop) &&
      /N\/A/.test(noTriggerSop) &&
      /不\*{0,2}進[\s\S]*?(?:watch|loop)/.test(noTriggerSop),
    'git-workflow-tracking.md No-trigger SOP 缺「dir 不存在 → 確定終態 / N/A / 不進 watch loop」——這是把無 CI 判定從事後前移到前置的關鍵語意'
  );
});

test('SSOT: 前置偵測「無 workflow 檔」須涵蓋 `*.yaml`（非只 `*.yml`）', () => {
  // GitHub Actions 兩種副檔名皆合法；只驗 `*.yml` 會把 yaml-only repo 誤判為 no-CI。
  assert.ok(
    /\*\.yaml/.test(noTriggerSop),
    'git-workflow-tracking.md No-trigger SOP 前置 step 0 僅提 `*.yml`——GitHub Actions 亦接受 `*.yaml`，yaml-only repo 會被誤判為無 CI 而跳過 watch；須同時涵蓋 `*.yml`/`*.yaml`'
  );
});

test('skill: devpro:pre-pr Step 5 前置偵測亦須涵蓋 `*.yaml`', () => {
  assert.ok(
    /\*\.yaml/.test(prePrStep5),
    'pre-pr/SKILL.md Step 5 前置偵測僅提 `*.yml`——須與 SSOT 一致同時涵蓋 `*.yml`/`*.yaml`'
  );
});

test('SSOT: 前置偵測為 sub-item 1-4 之「前置」（不破既有 trigger-schema 分類）', () => {
  // sub-item 1-4 的既有 trigger-schema 分類語意必須保留
  for (const kept of ['workflow_dispatch', 'paths', 'paths-ignore', 'escalate']) {
    assert.ok(
      noTriggerSop.includes(kept),
      `git-workflow-tracking.md No-trigger SOP sub-item 1-4 缺既有語意詞「${kept}」——前置 step 0 為新增前置、不得取代 workflow 存在時的 trigger-schema 分類`
    );
  }
});

test('skill: devpro:pre-pr Step 5 引用前置偵測 `.github/workflows/`', () => {
  assert.ok(
    prePrStep5.includes('.github/workflows/'),
    'pre-pr/SKILL.md Step 5 Workflow watch 缺 `.github/workflows/` 前置偵測引用——須在 gh pr checks 前先驗 workflow dir 存在與否'
  );
});

test('skill: Step 5 前置偵測句指向 git-workflow-tracking.md SSOT', () => {
  assert.ok(
    prePrStep5.includes('git-workflow-tracking.md') &&
      /No-trigger/.test(prePrStep5),
    'pre-pr/SKILL.md Step 5 前置偵測須指向 `git-workflow-tracking.md` No-trigger SOP（SSOT），不重寫細節'
  );
});
