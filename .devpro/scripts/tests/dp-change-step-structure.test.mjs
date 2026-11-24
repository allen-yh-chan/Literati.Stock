import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { repoPath } from './lib/repo-root.mjs';
import { readChangeSkillFullReadingOrder } from './lib/change-skill.mjs';

// 第四步～第六步 and the delegation plan live in the full-rigor reference; assert on the full reading order.
const CHANGE_MD = readChangeSkillFullReadingOrder();
const AGENTS_MD = readFileSync(repoPath('AGENTS.md'), 'utf8');
const OPENSPEC_STEPS_MD = readFileSync(repoPath('.devpro/agent-rules/openspec-step-1-to-9.md'), 'utf8');
const ARCHIVE_PRINCIPLES_MD = readFileSync(
  repoPath('.devpro/agent-rules/openspec-archive-principles.md'),
  'utf8',
);

describe('dp:change step structure (第三/四步 + AGENTS.md §0 anchors)', () => {
  test('第三步：建 worktree + 環境檢查 + 寫 meeting-notes.md 段標題存在', () => {
    assert.match(
      CHANGE_MD,
      /第三步：建 worktree \+ 環境檢查 \+ 寫 meeting-notes\.md（startup gates first）/,
      '/devpro:change 缺第三步段標題（重編後 worktree 建立的 in-prompt SSOT）',
    );
  });

  test('第三步 startup gates + worktree 子步驟序列存在', () => {
    const checks = [
      [/1\. \*\*保護分支 \/ cwd 校驗\*\*/, '第三步缺子步驟 1（保護分支 / cwd 校驗）'],
      [/2\. \*\*working tree 乾淨\*\*/, '第三步缺子步驟 2（working tree clean）'],
      [/3\. \*\*同步 refs\*\*.*git fetch origin --tags.*checked-out local `main` ref/s, '第三步缺子步驟 3（safe fetch refs）'],
      [/4\. \*\*production ancestry gate\*\*/, '第三步缺子步驟 4（production ancestry gate）'],
      [/5\. \*\*分支依賴確認\*\*.*detect-branch-base\.mjs --anchor/s, '第三步缺子步驟 5（anchor / dependency）'],
      [/6\. \*\*決定 base\*\*/, '第三步缺子步驟 6（決定 base）'],
      [/7\. `git worktree add /, '第三步缺子步驟 7（git worktree add）'],
      [/8\. `git submodule update --init --recursive`/, '第三步缺子步驟 8（submodule init）'],
      [/9\. cwd 切入 worktree.*pwd && git rev-parse --abbrev-ref HEAD && git status --short --branch/s, '第三步缺子步驟 9（cwd 切入 worktree + evidence）'],
      [/10\. \*\*環境檢查\/setup\*\*.*environment-setup-nvm-nodejs-openspec\.md/s, '第三步缺子步驟 10（environment setup trigger）'],
      [/10\. \*\*環境檢查\/setup\*\*.*`nvm install` → `nvm use`/s, '第三步缺 .nvmrc setup 指令（nvm install/use）'],
      [/11\. `mkdir -p openspec\/changes/, '第三步缺子步驟 11（mkdir change dir）'],
      [/12\. 寫入 `openspec\/changes\/<change-name>\/meeting-notes\.md`/, '第三步缺子步驟 12（寫 meeting-notes）'],
    ];
    for (const [pattern, message] of checks) {
      assert.match(CHANGE_MD, pattern, message);
    }
  });

  test('第三步 step 4 鎖 production ancestry gate 的 fail-closed routing', () => {
    assert.match(
      CHANGE_MD,
      /--require-main-ancestor --production-ref <production-tag> --main-ref origin\/main/,
      '第三步 step 4 缺 exact production/main ref gate literal',
    );
    assert.match(
      CHANGE_MD,
      /4\. \*\*production ancestry gate\*\*.*非 0 即停止普通 `\/devpro:change`.*禁止 fallback 到 `origin\/main` 繼續.*bounded `bugfix\/fix-production-ancestry-<production-tag>`/s,
      '第三步 step 4 divergence 必須停止普通 flow、禁止 origin/main fallback 並只進 bounded repair',
    );
    assert.match(
      CHANGE_MD,
      /4\. \*\*production ancestry gate\*\*.*no-tag first import.*`ancestry gate: N\/A`.*不得捏造或推論 production tag/s,
      '第三步 step 4 genuine no-tag first import 必須記 N/A 且不得捏造 tag',
    );
  });

  test('第三步使用 anchor JSON .sha 建 worktree，不使用可能不可解析的 .ref', () => {
    assert.match(
      CHANGE_MD,
      /使用同一份 `node \.devpro\/scripts\/detect-branch-base\.mjs --anchor` JSON 的 `\.sha`/,
      '第三步需明示使用 anchor JSON .sha',
    );
    assert.match(
      CHANGE_MD,
      /git worktree add .* <anchor-sha>/,
      '第三步 worktree add base 必須是 <anchor-sha>',
    );
    assert.doesNotMatch(
      CHANGE_MD,
      /git worktree add .* <anchor>/,
      '第三步不得使用裸 <anchor> 作 git base',
    );
  });

  test('第三步 cross-ref 同時指向 git-branch-naming-and-anchor.md 與 openspec-step-1-to-9.md Step 3a', () => {
    // 鎖第三步段內同時引用 worktree 規範與 step leaf，避免用 openspec-flow.md 行號造成 SSOT drift
    assert.match(
      CHANGE_MD,
      /git-branch-naming-and-anchor\.md`「Worktree 規範」段 \+ `openspec-step-1-to-9\.md` Step 3a/,
      '第三步缺雙 cross-ref（git-branch-naming-and-anchor.md + openspec-step-1-to-9.md Step 3a）',
    );
  });

  test('第四步：Pre-analyst Clarification 段標題存在', () => {
    assert.match(
      CHANGE_MD,
      /第四步：Pre-analyst Clarification（MUST invoke `\/devpro:clarify`）/,
      '/devpro:change 缺第四步段標題（MUST invoke /devpro:clarify）',
    );
  });

  test('第四步 適用範圍 disclaimer：full B 適用；A / B-mini 跳過', () => {
    assert.match(
      CHANGE_MD,
      /適用範圍.*?判斷表判為 \*\*B（full）\*\* 的 chore \/ feature \/ bugfix \/ hotfix/s,
      '第四步缺適用範圍 disclaimer（full B 四前綴）',
    );
    assert.match(
      CHANGE_MD,
      /A \/ B-mini 跳過 dp-analyst/,
      '第四步缺 A / B-mini 跳過說明',
    );
  });

  test('第四步 Soft gate 字面：dp-reviewer 軸 1 root-cause adequacy backstop', () => {
    assert.match(
      CHANGE_MD,
      /\*\*Soft gate\*\*/,
      '第四步缺 Soft gate 標記',
    );
    assert.match(
      CHANGE_MD,
      /dp-reviewer 軸 1 root-cause adequacy backstop/,
      '第四步缺 dp-reviewer 軸 1 backstop 說明（Soft gate fall-through）',
    );
  });

  test('第四步 pointer-only：指向 ambiguity-scoring／proposal-template／openspec-quality／stop-point；禁舊「禁止分多輪」', () => {
    assert.doesNotMatch(
      CHANGE_MD,
      /禁止分多輪追問/,
      '第四步不得再要求「禁止分多輪追問」',
    );
    const start = CHANGE_MD.search(
      /\*\*第四步：Pre-analyst Clarification（MUST invoke `\/devpro:clarify`）\*\*/,
    );
    assert.ok(start >= 0, '缺第四步標題');
    const rest = CHANGE_MD.slice(start);
    const next = rest.search(/\n\*\*第五步：/);
    const step4 = next >= 0 ? rest.slice(0, next) : rest;
    assert.match(step4, /devpro:clarify/, '第四步必須 MUST invoke／pointer devpro:clarify');
    assert.match(step4, /ambiguity-scoring\.md/, '第四步必須 pointer ambiguity-scoring.md');
    assert.match(step4, /proposal-template\.md/, '第四步必須 pointer proposal-template.md');
    assert.match(step4, /openspec-quality-and-formats\.md/, '第四步必須 pointer openspec-quality-and-formats.md');
    assert.match(step4, /stop-point-comms\.md/, '第四步必須 pointer stop-point-comms.md');
    assert.match(
      step4,
      /check-clarification-gates\.mjs[`\s]+`?pre-analyst|`check-clarification-gates\.mjs`[\s\S]{0,80}`pre-analyst`/,
      '第四步 Analyst 放行必須要求 check-clarification-gates pre-analyst CLI（可經 devpro:clarify）',
    );
    assert.match(
      step4,
      /check-clarification-gates\.mjs[`\s]+`?seams-expansion|`seams-expansion`/,
      '第四步 Seams-first 必須要求 check-clarification-gates seams-expansion CLI（可經 devpro:clarify）',
    );
    assert.doesNotMatch(step4, /working cap 3/, '第四步不得雙寫 working cap 3');
    assert.doesNotMatch(step4, /absolute max 4/, '第四步不得雙寫 absolute max 4');
  });

  test('第五步：pre-analyst CLI gate before dp-analyst Agent', () => {
    const start = CHANGE_MD.search(/\*\*第五步：/);
    assert.ok(start >= 0, '缺第五步標題');
    const rest = CHANGE_MD.slice(start);
    const next = rest.search(/\n\*\*第六步：/);
    const step5 = next >= 0 ? rest.slice(0, next) : rest;
    assert.match(
      step5,
      /check-clarification-gates\.mjs pre-analyst/,
      '第五步呼叫前必須執行 check-clarification-gates pre-analyst',
    );
  });

  test('第六步 design.md when-present gate：先跑 dp-second-reviewer audit-only 且不冒充 PR gate', () => {
    assert.match(
      CHANGE_MD,
      /Design\.md Second-Review Gate（when-present）/,
      '第六步缺 design.md when-present second-review gate 標題',
    );
    assert.match(
      CHANGE_MD,
      /存在 `openspec\/changes\/<change>\/design\.md`.*`dp-second-reviewer` `audit-only`/s,
      '第六步缺 design.md 存在時 dispatch dp-second-reviewer audit-only 的要求',
    );
    assert.match(
      CHANGE_MD,
      /handoff 至少包含 `proposal\.md`、`design\.md`、affected spec delta paths \/ touch list、target state、known validation evidence/,
      'design audit-only handoff 必須鎖最小輸入：proposal/design/touch/target/validation evidence',
    );
    assert.match(
      CHANGE_MD,
      /`devpro:second-review` projection\/control plane/,
      'design audit-only 必須使用 devpro:second-review projection/control plane',
    );
    assert.match(
      CHANGE_MD,
      /render-second-review-packet\.mjs <handoff-json> --carrier-root <dir>.*validate-second-review-packet\.mjs <packet-file>/s,
      'design audit-only dispatch 前必須 render 並 validate second-review packet',
    );
    assert.match(
      CHANGE_MD,
      /`packet_path`、`observability_context_path`、`heartbeat_path`、`activity_log_path`、`stdout_log_path`、`stderr_log_path`、`cli_probe_result_path`、`projection_bootstrap_command`、`projection_runner_command`/,
      'design audit-only 必須傳入 renderer-generated packet / observability / sidecar paths and commands',
    );
    assert.match(
      CHANGE_MD,
      /`tl_pre_dispatch_contract: tl-must-render-before-runtime-native-projection-spawn`.*`reviewer_cli_recipe\.required_invocation_args`/,
      'design audit-only 必須傳入 TL pre-dispatch contract 與 renderer-owned reviewer argv',
    );
    assert.match(
      CHANGE_MD,
      /`projection_observability_contract_missing`.*不得啟動 reviewer CLI 或等 timeout/s,
      '缺 sidecar / handoff path 時必須在 reviewer CLI 前 fail closed',
    );
    assert.match(
      CHANGE_MD,
      /`projection_cli_exited` → `projection_sticky_verification_skipped`/,
      'audit-only terminal evidence 必須鎖 projection_cli_exited -> projection_sticky_verification_skipped 順序',
    );
    assert.match(
      CHANGE_MD,
      /`approval_context: none`、`write_back: none`、`sticky_write_disposition: N\/A`/,
      'design second-review 必須鎖 audit-only 權限與 no write-back schema',
    );
    assert.match(
      CHANGE_MD,
      /不得寫 PR sticky，不滿足 PR merge gate/,
      'design audit-only 不得寫 PR sticky 或滿足 PR merge gate',
    );
    assert.match(
      CHANGE_MD,
      /verdict: PASS.*可繼續 task ledger \/ delegation plan/s,
      'PASS verdict 必須明確允許繼續 task ledger / delegation plan',
    );
    assert.match(
      CHANGE_MD,
      /verdict: WARN.*逐項 disposition finding/s,
      'WARN findings 必須逐項 disposition 後才可實作',
    );
    assert.match(
      CHANGE_MD,
      /verdict: CRITICAL.*UNAVAILABLE.*missing terminal audit evidence.*fail closed/s,
      'CRITICAL/UNAVAILABLE/missing terminal audit evidence 必須 fail closed',
    );
    assert.match(
      CHANGE_MD,
      /若 `design\.md` 不存在，TL MUST 在 durable carrier（`tasks\.md`、`proposal-mini\.md`、`decisions\.md`、或 delegation plan）記錄 `design second-review: N\/A - no design\.md`/,
      'design.md 不存在時必須在 durable carrier 記錄 N/A 且不可變成 presence gate',
    );
    assert.match(
      CHANGE_MD,
      /independent of the design author/,
      '第六步 design.md when-present gate 必須要求 independent of the design author',
    );
    assert.match(
      CHANGE_MD,
      /\.devpro\/scripts\/lib\/design-review-independence-identity\.mjs/,
      '第六步 design.md when-present gate 必須指向 helper 模組路徑',
    );
  });

  test('openspec-step design.md 時序 mirror：full 必寫、B-mini 免寫、when-present audit-only review', () => {
    // Entry hot-path：full persist + B-mini omit + when-present audit-only + disposition；機制正文在 Archive sibling。
    assert.match(
      OPENSPEC_STEPS_MD,
      /openspec-archive-principles\.md/,
      'openspec-step 必須 Load-chain 具名 openspec-archive-principles.md',
    );
    assert.match(
      OPENSPEC_STEPS_MD,
      /full change MUST 持久化 design\.md（`## Context` \+ `## Decisions` 且至少 D1）/,
      'design.md 必須要求 full change 持久化 Context+Decisions+D1',
    );
    assert.match(
      OPENSPEC_STEPS_MD,
      /B-mini／chore A 免寫/,
      'B-mini／chore A 必須仍免寫 design.md',
    );
    assert.match(
      OPENSPEC_STEPS_MD,
      /若 design\.md 存在，Step 5 委派 \/ 實作前先完成 `dp-second-reviewer` `audit-only` second-review/,
      'openspec-step design.md 時序缺 when-present audit-only second-review',
    );
    assert.match(
      OPENSPEC_STEPS_MD,
      /`WARN` 逐項依 `code-review-checklist\.md` Finding Disposition Discipline 處理/,
      'openspec-step design.md 時序缺 WARN finding disposition discipline',
    );
    assert.match(
      OPENSPEC_STEPS_MD,
      /`CRITICAL` \/ `UNAVAILABLE` \/ 缺 terminal evidence fail closed/,
      'openspec-step design.md 時序缺 CRITICAL/UNAVAILABLE fail-closed 語意',
    );
    assert.match(
      OPENSPEC_STEPS_MD,
      /無 design\.md 時記 `design second-review: N\/A - no design\.md`/,
      'openspec-step 必須記錄 no-design.md 的 N/A continuation',
    );
    // Sibling：renderer/validator/sidecar／terminal order／PR-gate 邊界全文。
    assert.match(
      ARCHIVE_PRINCIPLES_MD,
      /render-second-review-packet\.mjs` \/ `\.devpro\/scripts\/validate-second-review-packet\.mjs` 取得 renderer-generated `packet_path`、`observability_context_path`/,
      'openspec-archive-principles design.md 時序缺 renderer/validator/sidecar 契約',
    );
    assert.match(
      ARCHIVE_PRINCIPLES_MD,
      /`projection_observability_contract_missing`，不得啟動 reviewer CLI/,
      'openspec-archive-principles design.md 時序缺 projection_observability_contract_missing fail-closed',
    );
    assert.match(
      ARCHIVE_PRINCIPLES_MD,
      /audit-only 不寫 PR sticky、不滿足 PR merge gate/,
      'openspec-archive-principles design audit-only 不得冒充 PR gate',
    );
    assert.match(
      ARCHIVE_PRINCIPLES_MD,
      /audit-only terminal evidence 須依序包含 `projection_cli_exited` → `projection_sticky_verification_skipped`/,
      'openspec-archive-principles design.md 時序缺 audit-only terminal event order',
    );
    assert.match(
      ARCHIVE_PRINCIPLES_MD,
      /無 design\.md 時，在 durable carrier 記 `design second-review: N\/A - no design\.md`/,
      'openspec-archive-principles 必須在 durable carrier 記錄 no-design.md 的 N/A continuation',
    );
  });

  test('AGENTS.md §0 bash cwd self-check + 校驗指令', () => {
    // 鎖兩段：(a) bash cwd 自檢存在 (b) 校驗指令 pwd && git rev-parse --abbrev-ref HEAD 字面完整。
    // §0 已擴為九句，序號由 agents-md-section0-sync.test.mjs 統一驗證，這裡不重複綁定舊序號。
    assert.match(
      AGENTS_MD,
      /^\d+\. \*\*bash cwd(?: \/ platform)?\*\*/m,
      'AGENTS.md §0 動手前自檢缺 bash cwd',
    );
    assert.match(
      AGENTS_MD,
      /`pwd && git rev-parse --abbrev-ref HEAD`/,
      'AGENTS.md §0 bash cwd 缺校驗指令字面（pwd && git rev-parse --abbrev-ref HEAD）',
    );
  });

  test('AGENTS.md Intent 速查段含 cwd / repo 對位 blockquote', () => {
    assert.match(
      AGENTS_MD,
      /> (?:\*\*cwd \/ repo 對位\*\*|cwd\/repo：)/,
      'AGENTS.md 缺 cwd / repo 對位 blockquote（Intent 速查段尾）',
    );
  });

  test('第七步：matching ledger carry-forward 禁 milestone idle-stop', () => {
    assert.match(
      CHANGE_MD,
      /\*\*第七步：Matching Ledger Carry-Forward（implementation-complete → ship；禁 milestone idle-stop）\*\*/,
      '/devpro:change 缺第七步 ledger carry-forward 標題',
    );
    const start = CHANGE_MD.indexOf('**第七步：Matching Ledger Carry-Forward');
    assert.ok(start >= 0);
    const rest = CHANGE_MD.slice(start);
    const next = rest.search(/\n## Test Scenarios/);
    const step7 = next >= 0 ? rest.slice(0, next) : rest;
    assert.match(step7, /Turn-end Ledger Self-Check/);
    assert.match(step7, /commit\+PR.*只 commit/s);
    assert.match(step7, /`\/devpro:pre-pr`/);
    assert.match(step7, /only commit when requested/);
  });
});
