import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SOURCE_ROOT, sourcePath } from "./lib/source-root.mjs";
import {
  BLOCKING_STATUS_PREFIXES,
  fixtureStatus,
  primaryCheckoutCompletionAllowed,
} from "./lib/submodule-status-contract.mjs";
function read(filePath) {
  return readFileSync(sourcePath(filePath), "utf8");
}

function assertUniqueLine(text, pattern, message) {
  const matches = text.split("\n").filter((line) => pattern.test(line));
  assert.equal(matches.length, 1, `${message}: expected exactly one operative line, got ${matches.length}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LEADING_PLUS_COMPLETION_COMPOUND =
  /leading `\+`.*MUST NOT declare.*(?:\/devpro:sync-rules|sync|release).*complete/;

function assertLeadingPlusCompletionCompound(section, carrierName) {
  const compoundLine = section
    .split("\n")
    .find((line) => line.includes("leading `+`") && line.includes("MUST NOT declare"));

  assert.ok(compoundLine, `${carrierName} must keep leading + and completion prohibition on one physical line`);
  assert.match(compoundLine, LEADING_PLUS_COMPLETION_COMPOUND);
  const leadingPlusOffset = compoundLine.indexOf("leading `+`");
  const polarityMutation =
    compoundLine.slice(0, leadingPlusOffset) +
    compoundLine.slice(leadingPlusOffset).replace("MUST NOT declare", "MUST declare");
  assert.doesNotMatch(
    polarityMutation,
    LEADING_PLUS_COMPLETION_COMPOUND,
    `${carrierName} mutation without NOT must fail the polarity-sensitive guard`,
  );
}

function assertReconciliationLedger(text, carrierName) {
  const ledgerMatch = text.match(
    /(?:### Batch Scope Ledger|\*\*Batch Scope Ledger（必填）\*\*)[\s\S]*?(?=\n### |\n## |$)/,
  );
  assert.ok(ledgerMatch, `${carrierName} must contain a bounded Batch Scope Ledger section`);
  const ledger = ledgerMatch[0];
  const requiredFields = [
    "create ancestry repair branch",
    "create ancestry repair PR",
    "merge ancestry repair PR",
    "re-fetch candidate `origin/main`",
    "run exact promoted-tag main-ancestor gate",
  ];

  for (const field of requiredFields) {
    assert.match(
      ledger,
      new RegExp(escapeRegExp(field)),
      `${carrierName} Batch Scope Ledger must explicitly include: ${field}`,
    );
  }
}

function assertProductionPrLedger(text, carrierName) {
  const ledgerMatch = text.match(
    /(?:### Batch Scope Ledger|\*\*Batch Scope Ledger（必填）\*\*)[\s\S]*?(?=\n### |\n## |$)/,
  );
  const ledger = ledgerMatch?.[0] ?? (text.includes("Batch Scope Ledger") ? text : "");
  assert.ok(ledger, `${carrierName} must contain a bounded Batch Scope Ledger section`);
  for (const field of [
    "push release/rules branch",
    "create production PR",
    "merge production PR",
    "push production tag",
  ]) {
    assert.match(ledger, new RegExp(escapeRegExp(field)), `${carrierName} ledger missing ${field}`);
  }
  assert.doesNotMatch(ledger, /^\s*-?\s*push production\s*(?:[:=]|$)/m, `${carrierName} must not authorize the exact action push production`);
  assert.match(ledger, /yes[^\n]*no[^\n]*ask-later|`yes`\s*\/\s*`no`\s*\/\s*`ask-later`/);
}

// requiredRelPath: a spec file (relative to the change dir) the caller will read.
// The active path is trusted ONLY when that file actually exists there; an empty
// leftover active directory (post-archive residue — git doesn't track empty dirs,
// so it stays invisible to `git status` / fresh clones) MUST NOT shadow the dated
// archive copy. When requiredRelPath is omitted, fall back to bare existence.
function resolveOpenSpecChangeDir(changeName, requiredRelPath) {
  const activeDir = path.join(SOURCE_ROOT, "openspec/changes", changeName);
  const activeIsUsable = requiredRelPath
    ? existsSync(path.join(activeDir, requiredRelPath))
    : existsSync(activeDir);
  if (activeIsUsable) {
    return path.relative(SOURCE_ROOT, activeDir);
  }

  const archiveDir = sourcePath("openspec/changes/archive");
  const archiveNamePattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(changeName)}$`);
  const archivedMatches = readdirSync(archiveDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && archiveNamePattern.test(entry.name))
    .map((entry) => path.join(archiveDir, entry.name))
    .filter((dirPath) => !requiredRelPath || existsSync(path.join(dirPath, requiredRelPath)))
    .map((dirPath) => path.relative(SOURCE_ROOT, dirPath))
    .sort();

  if (archivedMatches.length > 0) {
    return archivedMatches.at(-1);
  }

  throw new Error(`OpenSpec change not found in active or archive paths: ${changeName}`);
}

test("/devpro:change batch consent excludes remote rules sync", () => {
  const flow = read(".devpro/agent-rules/git-branch-and-pr-flow.md");
  const match = flow.match(/- `\/devpro:change`：[\s\S]*?\n- `\/devpro:sync-rules`：/);

  assert.ok(match, "must find /devpro:change batch consent block");

  const dpChange = match[0];
  assert.match(dpChange, /git submodule update --init --recursive/);
  assert.doesNotMatch(dpChange, /git submodule update --init --remote \.devpro-agent-rules/);
  assert.doesNotMatch(dpChange, /chore: sync devpro-agent-rules/);
});

test("/devpro:sync-rules batch consent includes remote update and sync commit", () => {
  const flow = read(".devpro/agent-rules/git-branch-and-pr-flow.md");
  const match = flow.match(/- `\/devpro:sync-rules`：[\s\S]*?\n- `\/devpro:pre-pr`：/);

  assert.ok(match, "must find /devpro:sync-rules batch consent block");

  const dpSyncRules = match[0];
  assert.match(dpSyncRules, /rules-to-main phase/);
  assert.match(dpSyncRules, /production continuation/);
  assert.match(dpSyncRules, /release rules to production/);
  assert.match(dpSyncRules, /bounded subagent launch authorization/);
  assert.match(dpSyncRules, /StandingDelegationAuthorization/);
  assert.match(dpSyncRules, /SubagentAuthPending/);
  assert.match(dpSyncRules, /Batch Scope Ledger/);
  assert.match(dpSyncRules, /push rules branch/);
  assert.match(dpSyncRules, /create rules PR/);
  assert.match(dpSyncRules, /merge rules PR/);
  assert.match(dpSyncRules, /create release\/rules branch/);
  assertProductionPrLedger(dpSyncRules, "git-branch-and-pr-flow.md /devpro:sync-rules block");
  assert.match(dpSyncRules, /production-YYYYMMDD-rules\[-n\]/);
  assert.doesNotMatch(dpSyncRules, /git submodule sync --recursive/);
  assert.match(dpSyncRules, /chore: sync devpro-agent-rules \(<sha>\)/);
  assert.match(dpSyncRules, /未明確涵蓋[^\n]*(?:production PR|production tag)[^\n]*再次詢問/);
});

test("ordinary consumer OpenSpec flow forbids pre-create remote rules update", () => {
  const consumer = read(".devpro/agent-rules/openspec-flow-consumer.md");

  assert.match(consumer, /普通 `\/devpro:change`/);
  assert.match(consumer, /禁止.*git submodule update --init --remote \.devpro-agent-rules/);
  assert.doesNotMatch(consumer, /^git submodule update --init --remote \.devpro-agent-rules$/m);
  assert.match(consumer, /先完成 rules PR|先走 `\/devpro:sync-rules`/);
});

test("environment recovery routes stale rules scripts through rules lane", () => {
  const environment = read(".devpro/agent-rules/environment-setup-nvm-nodejs-openspec.md");

  assert.match(environment, /普通 `feature\/bugfix\/chore\/hotfix` 分支\*\*禁止\*\*直接執行 remote rules update/);
  assert.match(environment, /rules-flow-routing\.md/);
  assert.match(environment, /`devpro:sync-rules` \/ `rules\/<source>-v<X\.Y\.Z>`/);
  assert.match(environment, /只有在 rules lane 內才可執行 `git submodule update --init --remote \.devpro-agent-rules`/);
  assert.doesNotMatch(environment, /必須先執行 `git submodule update --init --remote \.devpro-agent-rules`/);
});

test("rules sync command remains scoped to rules lane", () => {
  const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
  const routing = read(".devpro/agent-rules/rules-flow-routing.md");

  assert.match(rulesFlow, /consumer repo `rules\/<source>-v<X\.Y\.Z>` lane/);
  assert.match(rulesFlow, /\/devpro:sync-rules`：slash-command host 入口；包同一條 rules lane flow/);
  assert.match(rulesFlow, /無 slash command 的 agent：直接跑同一 flow/);
  assert.match(rulesFlow, /`\/devpro:sync-rules` 只是 wrapper/);
  assert.match(rulesFlow, /普通 `\/devpro:change` 不跑 remote rules update/);
  assert.match(rulesFlow, /git submodule update --init --remote \.devpro-agent-rules/);

  assert.match(routing, /rules\/<source>-v<X\.Y\.Z> 分支/);
  assert.match(routing, /無 slash command 時直接跑同一 flow，不複製步驟/);
  assert.match(routing, /Dedicated Rules Branch pre-flight/);
  assert.match(routing, /git submodule update --init --remote \.devpro-agent-rules/);
  assert.doesNotMatch(routing, /Pre-push wrap-up/);
});

test("Rules Production Promotion Uses A Pull Request Before Tagging", () => {
  const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
  // The post-merge continuation bullets moved verbatim to an on-demand leaf.
  const productionContinuation = read(".devpro/agent-rules/rules-flow-production-continuation.md");
  const releaseRulesLane = read(".devpro/agent-rules/release-rules-lane.md");
  const suiteCadence = read(".devpro/agent-rules/test-suite-cadence.md");
  const readme = read("README.md");

  assert.match(rulesFlow, /node \.devpro\/scripts\/run-test-suite\.mjs --changed <production-rules-tag>/);
  assert.match(rulesFlow, /git submodule update --init \.devpro-agent-rules/);
  assert.match(rulesFlow, /submodule `--sync`/);
  assert.match(rulesFlow, /root `sync-agent-rules\.mjs --check`/);
  assert.match(rulesFlow, /source-maintainer-only corpus checks.*`N\/A`/);
  assert.match(rulesFlow, /PR merge 後 production continuation/);
  assert.match(
    rulesFlow,
    /^> Load-chain（production continuation）：[^\n]*存在 `origin\/production`[^\n]*MUST 先讀 `rules-flow-production-continuation\.md`/m,
    "rules-flow.md must route production continuation to its leaf with a mandatory pointer",
  );
  assert.doesNotMatch(rulesFlow, /任一 PR 建立、merge 或 tag push 都不是完成點/, "rules-flow.md must not copy the continuation bullets");
  assert.match(rulesFlow, /啟動 `\/devpro:sync-rules` 時先確認 batch scope/);
  assert.match(rulesFlow, /Batch Scope Ledger/);
  assert.match(rulesFlow, /push rules branch/);
  assert.match(rulesFlow, /create rules PR/);
  assert.match(rulesFlow, /merge rules PR/);
  assert.match(rulesFlow, /create release\/rules branch/);
  assertProductionPrLedger(rulesFlow, "rules-flow.md");
  assertReconciliationLedger(rulesFlow, "rules-flow.md");
  assert.match(productionContinuation, /mandatory-threshold bounded subagent launch authorization/);
  assert.match(rulesFlow, /StandingDelegationAuthorization/);
  assert.match(rulesFlow, /SubagentAuthPending/);
  assert.match(productionContinuation, /開頭 batch scope 已明確點名同一 consumer rules lane/);
  assert.match(productionContinuation, /^- [^\n]*`origin\/production`[^\n]*`release\/rules-<YYYYMMDD>\[-n\]`/m);
  assert.match(productionContinuation, /任一 PR 建立、merge 或 tag push 都不是完成點/);
  assert.match(rulesFlow, /MUST NOT 從 `main` 建立、合成或直接 push protected production branch/);

  assert.match(releaseRulesLane, /node \.devpro\/scripts\/run-test-suite\.mjs --changed "\$TAG"/);
  assert.match(releaseRulesLane, /node \.devpro-agent-rules\/\.devpro\/scripts\/sync-agent-rules\.mjs --sync/);
  assert.match(releaseRulesLane, /devpro-doctor\.mjs --consumer-smoke/);
  assert.match(releaseRulesLane, /不得枚舉 source-maintainer README\/OpenSpec\/corpus suites/);
  assert.match(releaseRulesLane, /source-maintainer checks: N\/A/);
  assert.match(releaseRulesLane, /開場 Batch Scope Ledger/);
  assert.match(releaseRulesLane, /batch approval 可作為[^\n]*(?:production PR|tag-only)[^\n]*gate evidence/);
  assert.match(releaseRulesLane, /未明確涵蓋[^\n]*(?:production PR|production tag)[^\n]*再次詢問/);
  assert.match(releaseRulesLane, /exact[^\n]*(?:production PR|merged production)[^\n]*(?:merge commit|merged commit)/i);
  assert.match(releaseRulesLane, /fresh(?:ly)?[^\n]*(?:fetch|re-fetch)[^\n]*origin\/production/i);
  assert.match(releaseRulesLane, /push only[^\n]*tag ref|只推[^\n]*tag ref|tag-only push/i);

  assert.match(suiteCadence, /consumer rules tag 例外/);
  assert.match(suiteCadence, /git submodule update --init \.devpro-agent-rules/);
  assert.match(suiteCadence, /submodule `--sync`/);
  assert.match(suiteCadence, /root `devpro-doctor\.mjs --consumer-smoke`/);

  assert.match(readme, /run-test-suite\.mjs --changed <production-rules-tag>/);
  assert.match(readme, /wrapper 會在 target worktree 跑 submodule init\/sync、root check、doctor、focused tests/);
  assert.match(readme, /開頭 Batch Scope Ledger 為準/);
  assert.match(readme, /merge 到 `main` 後檢查 consumer repo 是否存在 `origin\/production`/);
  assert.match(readme, /不得從 `main` 建立或 direct-push protected branch/);
});

test("zero-tag first rules release continues from the existing remote production target", () => {
  const changeDir = resolveOpenSpecChangeDir("enforce-protected-branch-pr-only", "specs/rules-flow/spec.md");
  const delta = read(`${changeDir}/specs/rules-flow/spec.md`);
  const canonical = read("openspec/specs/rules-flow/spec.md");

  for (const [carrierName, text] of [
    ["rules-flow delta", delta],
    ["rules-flow canonical", canonical],
  ]) {
    const requirement = text.match(
      /### Requirement: Rules Sync Main Merge Continues To Production When Production Exists[\s\S]*?(?=\n### Requirement:|$)/,
    )?.[0];
    assert.ok(requirement, `${carrierName} must contain the production-continuation requirement`);
    assert.match(requirement, /zero local and remote `production-\*` tags[\s\S]*`origin\/production` exists/);
    assert.match(requirement, /first-rules-release[\s\S]*FIRST_BASE=origin\/production/);

    const missingBase = requirement.match(
      /#### Scenario: Missing Production Anchor Stops Promotion[\s\S]*?(?=\n#### Scenario:|$)/,
    )?.[0];
    assert.ok(missingBase, `${carrierName} must retain the missing-anchor scenario`);
    assert.match(missingBase, /`refs\/remotes\/origin\/production` does not exist/);
    assert.match(missingBase, /one or more `production-\*` tags exist[\s\S]*no valid[\s\S]*anchor/);
    assert.doesNotMatch(missingBase, /no production branch exists OR no valid `production-\*` tag anchor exists/);
  }
});

test("Rules Production Tag Targets The Exact PR Merge Commit", () => {
  const releaseRulesLane = read(".devpro/agent-rules/release-rules-lane.md");
  const branchNaming = read(".devpro/agent-rules/git-branch-naming-and-anchor.md");
  const ancestryRepairLeaf = read(".devpro/agent-rules/git-branch-production-ancestry-repair.md");

  assert.match(releaseRulesLane, /exact production PR merge commit -> <sha>[^\n]*production-[^\n]*tag -> <same sha>/);
  assert.match(releaseRulesLane, /resolve exact merged production commit[^\n]*freshly fetch `origin\/production`[^\n]*tag the explicit commit/);
  assert.match(releaseRulesLane, /git cherry-pick <sync-commit-sha>/);
  assertUniqueLine(
    releaseRulesLane,
    /release-lane back-merge[^\n]*`git merge --ff-only "\$PROMOTED_PRODUCTION_TAG"`[^\n]*PR 回 `main`[^\n]*regular\/no-ff/,
    "rules graph-only reconciliation must back-merge through the same release branch into main",
  );
  assertUniqueLine(
    releaseRulesLane,
    /ff-only 失敗[^\n]*`content-review-required`[^\n]*→ 轉 `git-branch-production-ancestry-repair\.md`/,
    "rules non-back-merge shapes must route to the dedicated repair lane",
  );
  assertUniqueLine(
    releaseRulesLane,
    /MUST NOT[^\n]*squash[^\n]*rebase[^\n]*`-s ours`[^\n]*patch-equivalence/,
    "rules reconciliation must reject parent-erasing substitutes",
  );
  assertUniqueLine(
    releaseRulesLane,
    /`graph-only`[^\n]*MUST[^\n]*conflict-free[^\n]*resulting merge tree[^\n]*candidate main tree[^\n]*merge parent[^\n]*zero tree delta/,
    "rules graph-only reconciliation must bind both safety predicates and merge evidence",
  );
  assertUniqueLine(
    releaseRulesLane,
    /`content-review-required`[^\n]*MUST[^\n]*content review[^\n]*tests/,
    "rules content-bearing reconciliation must retain review and tests",
  );
  assertUniqueLine(
    releaseRulesLane,
    /`graph-only`[^\n]*exemption-eligible/,
    "only graph-only release-lane back-merge may be exemption-eligible",
  );
  assertUniqueLine(
    releaseRulesLane,
    /`content-review-required`[^\n]*(?:MUST NOT|不得|not)[^\n]*exemption-eligible/,
    "content-review-required reconciliation must not inherit the graph-only exemption",
  );
  assertUniqueLine(
    ancestryRepairLeaf,
    /ancestry gate 非 0[^\n]*reconciliation classification trigger[^\n]*不得立即宣告或建立 Production ancestry repair \/ bounded repair/,
    "the ancestry repair leaf must classify ancestry gate failures before repair",
  );
  assertUniqueLine(
    branchNaming,
    /^> Load-chain（Production ancestry repair）：[^\n]*ancestry gate 非 0 時 MUST 停止[^\n]*先讀 `git-branch-production-ancestry-repair\.md`[^\n]*未分類 MUST NOT 宣告或建立 repair[^\n]*MUST NOT fallback `origin\/main`/,
    "the branch entry must route a non-zero ancestry gate to the repair leaf before any repair",
  );
  assert.match(branchNaming, /^### Production ancestry repair（普通 subset \/ rules subset 共用）$/m);
  assert.match(
    ancestryRepairLeaf,
    /^### Production ancestry repair（普通 subset \/ rules subset 共用）$/m,
    "the repair leaf must keep the section heading other carriers cite",
  );
  assert.doesNotMatch(
    branchNaming,
    /reconciliation classification trigger|bugfix\/fix-production-ancestry-<production-tag>/,
    "the branch entry must not keep a copy of the repair body",
  );
  assertUniqueLine(
    releaseRulesLane,
    /ordinary routing[^\n]*ancestry divergence[^\n]*reconciliation classification[^\n]*不得宣告 bounded repair[^\n]*禁止用 `origin\/main` bypass divergence/,
    "rules lane startup divergence must classify before repair and forbid origin/main bypass",
  );
  assertUniqueLine(
    ancestryRepairLeaf,
    /`git merge --no-ff "\$PROMOTED_PRODUCTION_TAG"`/,
    "the production ancestry repair carrier must pin the exact normal-merge command",
  );
  assertUniqueLine(
    releaseRulesLane,
    /reconciliation PR merge[^\n]*re-fetch `origin\/main`[^\n]*重新取得 `CANDIDATE_MAIN_SHA`[^\n]*exit 0[^\n]*complete/,
    "rules release completion must wait for the post-merge exact-ref gate",
  );
  assert.match(
    releaseRulesLane,
    /node \.devpro\/scripts\/detect-branch-base\.mjs --require-main-ancestor --production-ref "\$PROMOTED_PRODUCTION_TAG" --main-ref "\$CANDIDATE_MAIN_SHA"/,
  );
  assert.match(releaseRulesLane, /own-change-only three-dot/);
});

test("rules pre-flight uses prefix-capable PR search", () => {
  const routing = read(".devpro/agent-rules/rules-flow-routing.md");
  const readme = read("README.md");

  assert.match(routing, /gh pr list --search 'head:rules\/' --state open --json number,headRefName,createdAt/);
  assert.doesNotMatch(routing, /gh pr list --head 'rules\/\*'/);
  assert.doesNotMatch(readme, /gh pr list --head 'rules\/\*'/);
});

test("rules sync PR base avoids production lineage pollution", () => {
  const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
  const readme = read("README.md");
  const changeDir = resolveOpenSpecChangeDir("fix-rules-lane-issue-870", "specs/rules-flow/spec.md");
  const delta = read(path.join(changeDir, "specs/rules-flow/spec.md"));

  for (const text of [rulesFlow, delta]) {
    assert.match(text, /git merge-base --is-ancestor <anchor-sha> origin\/main/);
    assert.match(text, /origin\/main/);
  }
  assert.match(readme, /\.devpro\/agent-rules\/rules-flow\.md/);
  assert.match(readme, /anchor\/base、`\.gitmodules` tracking、sync\/check、commit message 規則以這兩個規則檔為準/);
  assert.doesNotMatch(readme, /git merge-base --is-ancestor <anchor-sha> origin\/main/);
});

test("rules sync base selection exposes isMainAncestor helper output", () => {
  const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
  const changeDir = resolveOpenSpecChangeDir("fix-rule-feedback-issues", "specs/rules-flow/spec.md");
  const delta = read(path.join(changeDir, "specs/rules-flow/spec.md"));

  for (const text of [rulesFlow, delta]) {
    assert.match(text, /isMainAncestor/);
    assert.match(text, /git merge-base --is-ancestor <anchor-sha> origin\/main/);
  }
});

test("/devpro:sync-rules slash command stays a thin wrapper", () => {
  const command = read(".devpro/agent-skills/devpro-workflows/sync-rules/SKILL.md");

  assert.match(command, /本 command 是薄 wrapper；不另定一套流程/);
  assert.match(command, /Batch Scope Confirmation/);
  assert.match(command, /完整 `\/devpro:sync-rules` rules lane batch approval/);
  assert.match(command, /bounded subagent launch authorization/);
  assert.match(command, /StandingDelegationAuthorization/);
  assert.match(command, /SubagentAuthPending/);
  assert.match(command, /Batch Scope Ledger/);
  assert.match(command, /push rules branch/);
  assert.match(command, /create rules PR/);
  assert.match(command, /merge rules PR/);
  assert.match(command, /create release\/rules branch/);
  assertProductionPrLedger(command, "sync-rules/SKILL.md");
  assertReconciliationLedger(command, "sync-rules/SKILL.md");
  assert.match(command, /先讀小檔 `.devpro\/agent-rules\/rules-flow-routing\.md`/);
  assert.match(command, /避免因 DRY 強迫載入整份大檔/);
  assert.match(command, /rules-to-main phase，不是整條 consumer rules lane 的完成點/);
  assert.match(command, /PR URL 或 PR merge 只能作為 phase evidence/);
  assert.match(command, /release-rules-lane\.md/);
  assert.match(command, /rules-flow-routing\.md/);
  assert.doesNotMatch(command, /rules-flow\.md` 全文/);
  assert.doesNotMatch(command, /MAIN_AHEAD_THRESHOLD/);
  assert.doesNotMatch(command, /gh pr list --head 'rules\/\*'/);
});

test("consumer rules-sync scenario covers single-batch production completion", () => {
  const scenario = read("scenarios/scenario-ac-consumer-repo-sync-rules-production-continuation.md");

  assert.match(scenario, /\/devpro:sync-rules/);
  assert.match(scenario, /Batch Scope Ledger/);
  assertProductionPrLedger(scenario, "scenario-ac");
  assertReconciliationLedger(scenario, "scenario-ac");
  assert.match(scenario, /rules-to-main/);
  assert.match(scenario, /production promotion/);
  assert.match(
    scenario,
    /`graph-only`[\s\S]*當輪 release branch[\s\S]*`git merge --ff-only "\$PROMOTED_PRODUCTION_TAG"`[\s\S]*regular\/no-ff PR merge 回 `main`/,
  );
  assert.match(
    scenario,
    /只有 ff-only 失敗、release branch 已 prune、事後／startup[\s\S]*`content-review-required`[\s\S]*`git merge --no-ff "\$PROMOTED_PRODUCTION_TAG"`/,
  );
  assert.match(scenario, /repair 與 content review 都不得 exemption/);
  assert.match(scenario, /create ancestry repair branch/);
  assert.match(scenario, /create ancestry repair PR/);
  assert.match(scenario, /merge ancestry repair PR/);
  assert.match(scenario, /freshly re-fetch candidate `origin\/main`/);
  assert.match(scenario, /same exact promoted tag/);
  assert.match(scenario, /startup repair.*preflight\/recovery/s);
  assert.match(scenario, /不得宣告.*(?:sync|release).*complete/s);
});

test("rules PR-open handoff depends on current gate state", () => {
  const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
  const command = read(".devpro/agent-skills/devpro-workflows/sync-rules/SKILL.md");

  for (const text of [rulesFlow, command]) {
    assert.match(text, /PR-open gate-dependent handoff/);
    assert.match(text, /停在 PR URL.*不給.*下一步選項/);
    assert.match(text, /workflow\/checks pending/);
    assert.match(text, /git-workflow-tracking\.md/);
    assert.match(text, /track\/hold\/other/);
    assert.match(text, /cross-model (?:review )?required/);
    assert.match(text, /\/devpro:cross-review <PR#>/);
    assert.match(text, /cross-review\/hold\/other/);
    assert.match(text, /fresh PASS\/WARN sticky/);
    assert.match(text, /\(cross-model exempt 或 fresh PASS\/WARN sticky\).*Batch Scope Ledger.*merge rules PR=yes/);
    assert.match(text, /merge rules PR=yes/);
    assert.match(text, /1\. merge <PR#>.*2\. hold.*3\. other/s);
  }

  assert.match(rulesFlow, /不得只寫「next step is review \/ merge」/);
  assert.match(rulesFlow, /non-exempt PR 必須先 route through cross-model review/);
  assert.doesNotMatch(command, /merge 永遠是下一步/);
});

test("sync rules batch scope delta captures subagent authorization alignment", () => {
  const changeDir = resolveOpenSpecChangeDir("strengthen-sync-rules-batch-scope", "specs/rules-flow/spec.md");
  const delta = read(path.join(changeDir, "specs/rules-flow/spec.md"));

  assert.match(delta, /Rules Sync Batch Scope Aligns Subagent Authorization/);
  assert.match(delta, /bounded subagent launch authorization/);
  assert.match(delta, /StandingDelegationAuthorization/);
  assert.match(delta, /SubagentAuthPending/);
  assert.match(delta, /Rules Sync Batch Scope Uses Ledger/);
  assert.match(delta, /push rules branch/);
  assert.match(delta, /create rules PR/);
  assert.match(delta, /merge rules PR/);
  assert.match(delta, /create release\/rules branch/);
  assert.match(delta, /push production/);
  assert.match(delta, /create production tag/);
  assert.match(delta, /Rules Lane Merge Readiness Uses Captured Evidence/);
});

test("skill SSOT rule preserves token-efficient routing", () => {
  const ruleDesign = read(".devpro/agent-rules/rule-design-principles.md");

  assert.match(ruleDesign, /#### Skill SSOT/);
  assert.match(ruleDesign, /runtime adapter，不是 domain SSOT/);
  assert.match(ruleDesign, /最小可執行 leaf/);
  assert.match(ruleDesign, /禁止為了 DRY 迫使常見路徑載入整份大檔/);
});

test("consumer rules-lane primary checkout close-out stays aligned across policy, projection, README, and delta", () => {
  const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
  const skill = read(".devpro/agent-skills/devpro-workflows/sync-rules/SKILL.md");
  const readme = read("README.md");
  const changeDir = resolveOpenSpecChangeDir(
    "fix-primary-checkout-submodule-alignment",
    "specs/rules-flow/spec.md",
  );
  const delta = read(path.join(changeDir, "specs/rules-flow/spec.md"));
  const canonical = read("openspec/specs/rules-flow/spec.md");
  const carriers = [
    ["rules-flow.md", rulesFlow, /### Consumer Rules Lane Primary-Checkout Close-out[\s\S]*?(?=\n### |\n## |$)/],
    ["devpro:sync-rules skill", skill, /### Primary Checkout Close-out[\s\S]*?(?=\n### |\n## |$)/],
    ["README.md", readme, /\*\*Rules lane primary-checkout close-out\*\*[\s\S]*?(?=\n\d+\. |\n## |$)/],
    ["rules-flow delta", delta, /### Requirement: Rules Sync Main Merge Continues To Production When Production Exists\n\n[\s\S]*?(?=\n#### Scenario:)/],
    ["rules-flow canonical", canonical, /### Requirement: Rules Sync Main Merge Continues To Production When Production Exists\n\n[\s\S]*?(?=\n#### Scenario:)/],
  ];

  for (const [carrierName, body, anchor] of carriers) {
    const section = body.match(anchor)?.[0];
    assert.ok(section, `${carrierName} must contain the primary-checkout close-out anchor`);
    assert.match(section, /git submodule update --init \.devpro-agent-rules/);
    assert.match(section, /git submodule status \.devpro-agent-rules/);
    assertLeadingPlusCompletionCompound(section, carrierName);
    assert.match(section, /MUST NOT[\s\S]*stage[\s\S]*stale SHA/);
    assert.match(section, /MUST NOT[\s\S]*--remote/);
    assert.doesNotMatch(section, /git submodule update --init --remote \.devpro-agent-rules/);
  }
});

test("primary-checkout scenario fixture fails closed for +, -, and U status prefixes", () => {
  assert.equal(primaryCheckoutCompletionAllowed(fixtureStatus(" ")), true);
  for (const prefix of BLOCKING_STATUS_PREFIXES) {
    assert.equal(
      primaryCheckoutCompletionAllowed(fixtureStatus(prefix)),
      false,
      `leading ${prefix} must block completion across every carrier`,
    );
  }
  assert.equal(primaryCheckoutCompletionAllowed("unparseable status"), false);

});

test("Missing Production Target Fails Closed Without Direct-Push Bootstrap", () => {
  const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
  const skill = read(".devpro/agent-skills/devpro-workflows/sync-rules/SKILL.md");
  const readme = read("README.md");
  const changeDir = resolveOpenSpecChangeDir(
    "fix-primary-checkout-submodule-alignment",
    "specs/rules-flow/spec.md",
  );
  const delta = read(path.join(changeDir, "specs/rules-flow/spec.md"));
  const canonical = read("openspec/specs/rules-flow/spec.md");

  assert.match(rulesFlow, /production target absent[^\n]*MUST NOT[^\n]*(?:直接|directly) push protected production branch[^\n]*external repository administration/);
  assert.match(skill, /production target absent[^\n]*不得[^\n]*direct-push production branch[^\n]*external repository administration/);
  assert.match(readme, /production target absent[^\n]*MUST NOT create or push the missing protected production branch[^\n]*repository administration/);

  assert.ok(
    rulesFlow.indexOf("### Consumer Rules Lane Primary-Checkout Close-out") <
      rulesFlow.indexOf("**PR merge 後 production continuation**"),
    "rules-flow must establish primary close-out before its missing-anchor continuation branch",
  );
  assert.ok(
    skill.indexOf("### Primary Checkout Close-out") < skill.indexOf("### 4. PR 後 continuation"),
    "devpro:sync-rules projection must establish primary close-out before continuation routing",
  );
  assert.ok(
    readme.indexOf("**Rules lane primary-checkout close-out**") <
      readme.lastIndexOf("若已有合法 production tag 而 `origin/production` 不存在"),
    "README must align before its missing-anchor stop",
  );

  for (const [carrierName, body] of [
    ["rules-flow delta", delta],
    ["rules-flow canonical", canonical],
  ]) {
    const scenario = body.match(
      /#### Scenario: Missing Production Anchor Still Aligns Primary Checkout[\s\S]*?(?=\n#### |\n### |$)/,
    )?.[0];
    assert.ok(scenario, `${carrierName} must cover missing-anchor primary alignment`);
    assert.match(scenario, /git submodule update --init \.devpro-agent-rules/);
    assert.match(scenario, /git submodule status \.devpro-agent-rules/);
    assert.match(scenario, /before stopping production continuation/);
    assert.match(scenario, /MUST NOT declare[\s\S]*(?:\/devpro:sync-rules|sync|release)[\s\S]*complete/);
  }
});

test("feature hygiene routes sync diffs out of feature branches", () => {
  const hygiene = read(".devpro/agent-rules/git-branch-hygiene.md");
  const naming = read(".devpro/agent-rules/git-branch-naming-and-anchor.md");
  const steps = read(".devpro/agent-rules/openspec-step-1-to-9.md");

  assert.match(hygiene, /改走 .*rules\/<source>-v<X\.Y\.Z>/);
  assert.doesNotMatch(hygiene, /產生獨立的 `chore: sync devpro-agent-rules` commit 後，再回到 feature/);

  assert.match(naming, /僅在 `rules\/<source>-v<X\.Y\.Z>` lane 視為該 rules 單位自己的 commit/);
  assert.doesNotMatch(naming, /分支建立時或透過 `\/devpro:sync-rules` 中途追加/);

  assert.match(steps, /跳過.*remote rules sync/);
  assert.doesNotMatch(steps, /Pre-create-branch \/ Pre-push wrap-up/);
});

test("OpenSpec deltas capture the new boundary", () => {
  const changeDir = resolveOpenSpecChangeDir("remove-precreate-submodule-remote-update", "specs/openspec-flow/spec.md");
  const openspecDelta = read(path.join(changeDir, "specs/openspec-flow/spec.md"));
  const rulesDelta = read(path.join(changeDir, "specs/rules-flow/spec.md"));

  assert.match(openspecDelta, /Consumer Branch Creation Avoids Remote Rules Update/);
  assert.match(openspecDelta, /MUST NOT create a `chore: sync devpro-agent-rules/);
  assert.match(rulesDelta, /Ordinary Feature Branch Does Not Sync Rules/);
});

test("rules lane PAT smoke documents executable recipe and negative control", () => {
  const releaseRulesLane = read(".devpro/agent-rules/release-rules-lane.md");
  const patSection = releaseRulesLane.match(
    /### SIT\/UAT\/PAT smoke only[\s\S]*?(?=\n### |\n## |$)/,
  )?.[0];
  assert.ok(patSection, "release-rules-lane.md must contain SIT/UAT/PAT smoke only section");

  assert.match(patSection, /pre-tool-gate\.mjs/);
  assert.match(patSection, /負面對照|negative control/i);
  assert.match(patSection, /Commit attribution gate/);
  assert.match(patSection, /no-footer/);
  assert.match(patSection, /REPO_ROOT/);
  assert.match(patSection, /rev-parse --abbrev-ref HEAD|abbrev-ref HEAD/);
  assert.match(patSection, /\.devpro\/|devpro-managed/);
  assert.match(patSection, /MUST NOT|不得|不成立/);
  assert.match(patSection, /PASS|regression/);
  assert.match(patSection, /worktree/);
  assert.match(patSection, /OWNED_WT|OWNED_OID|trap cleanup|trap /);
  assert.match(patSection, /hookSpecificOutput|structured|JSON/);
});

// Issue #3647 (a): a carrier cut from a production tag that does not contain the origin/production tip needs a
// carrier-side repair; the main-side repair leaf only repairs main.
test("Scenario: The rules lane defines a zero-tree-delta carrier ancestry repair", () => {
  const releaseRulesLane = read(".devpro/agent-rules/release-rules-lane.md");
  const heading = "#### Carrier ancestry repair（production tip 不在 carrier 歷史內）";
  const start = releaseRulesLane.indexOf(heading);
  assert.ok(start >= 0, "release-rules-lane.md must keep the carrier ancestry repair heading other carriers cite");
  const end = releaseRulesLane.indexOf("\n#### ", start + heading.length);
  const section = releaseRulesLane.slice(start, end === -1 ? undefined : end);
  for (const [pattern, why] of [
    [/git merge-base --is-ancestor "\$PROD_TIP" "\$CARRIER_TIP"/, "trigger: the production tip is not in the carrier history"],
    [/列不出 `production-\*` tag[^\n]*fail closed[^\n]*`PROD_TIP` SHA[^\n]*release-already-live-backfill\.md §3/, "an untagged production tip is an incident: show the evidence and route to §3"],
    [/^git merge-base --is-ancestor "\$TAG" "\$PROD_TIP"/m, "tell a stale carrier apart from a Production PR-only violation"],
    [/`\$TAG` 是 `PROD_TIP` 的 ancestor[^\n]*carrier 過時，不是違規也不做本修復[^\n]*1\. 從最新 production tag 重開 carrier/, "a carrier cut before a later legitimate production release is recut, not repaired"],
    [/`\$TAG` 不是 `PROD_TIP` 的 ancestor → \*\*停下交使用者\*\*[^\n]*取得同意後才建修復分支[^\n]*Production PR-only invariant[^\n]*附 `\$TAG`、`\$CARRIER`、`PROD_TIP` SHA[^\n]*1\. 建 carrier 修復分支並開 PR[^\n]*2\. 不修[^\n]*3\. 其他/, "stop, name the root cause with evidence and numbered choices before the repair branch"],
    [/修復分支、PR 與 merge 不在 Batch Scope Ledger 既有 action/, "the batch ledger does not authorize the repair"],
    [/已 commit 則不 push[^\n]*`git diff --stat "\$CARRIER_TIP" HEAD`[^\n]*1\. 這次 rules release 先停[^\n]*2\. 其他/, "a content difference stops with evidence and a handoff"],
    [/-b "bugfix\/fix-production-ancestry-\$PROD_TIP_TAG-carrier" "\$CARRIER_TIP"/, "the repair branch starts at the carrier tip"],
    [/^git merge --no-ff "\$PROD_TIP_TAG"$/m, "normal merge of the exact production-tip tag"],
    [/sync-agent-rules\.mjs --sync/, "conflicts are regenerated from the carrier's submodule"],
    [/git diff --quiet "\$CARRIER_TIP" HEAD/, "the repair tree must equal the carrier tip"],
    [/sync 管理以外的檔[^\n]*非 0 → 停下/, "any other conflict or tree difference stops"],
    [/不得用 squash、rebase、`-s ours`、patch-equivalence/, "no history shortcut replaces the merge parent"],
    [/`--base "\$CARRIER"`[^\n]*只能 regular merge/, "the repair PR targets the carrier with a regular merge"],
    [/git merge-base --is-ancestor 'origin\/production' "origin\/\$CARRIER" && git diff --quiet "\$CARRIER_TIP" "origin\/\$CARRIER"/, "post-merge check uses the freshly fetched production tip"],
    [/`origin\/production` 若已前進、又不在 carrier 歷史內，不得回報 carrier repaired[^\n]*重跑/, "production that advanced during the repair reruns the detection"],
    [/--not "\$PROD_TIP_TAG"/, "the post-repair range check excludes the production-tip history"],
  ]) {
    assert.match(section, pattern, why);
  }
  assert.doesNotMatch(section, /^git merge[^\n]*-s ours/m, "the recipe must not merge with -s ours");
  assertUniqueLine(
    releaseRulesLane,
    /^\*\*不變式\*\*：`release\/rules-[^\n]*唯一例外是 §Carrier ancestry repair[^\n]*zero tree delta/,
    "the rules lane invariant must name the carrier ancestry repair as its only exception",
  );
  assert.match(
    read(".devpro/agent-rules/git-branch-production-ancestry-repair.md"),
    /不含 `origin\/production` tip[^\n]*不是本 lane[^\n]*`release-rules-lane\.md` §Carrier ancestry repair/,
    "the main-side repair leaf must route the carrier-side divergence to the rules lane",
  );
});
