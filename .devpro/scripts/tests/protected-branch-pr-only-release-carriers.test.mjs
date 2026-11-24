import assert from "node:assert/strict";
import { test } from "node:test";
import { readSourceFile as read } from "./lib/read.mjs";
import { readChangeSpecWithArchiveFallback } from "./lib/spec-delta-reader.mjs";

const FULL_RELEASE_SEQUENCE_CARRIERS = [
  ".devpro/agent-rules/release-step-1-7.md",
  ".devpro/agent-rules/release-sit-uat-pat-prod.md",
  ".devpro/agent-rules/release-rules-lane.md",
  ".devpro/agent-rules/rules-flow.md",
  ".devpro/agent-rules/git-branch-and-pr-flow.md",
  ".devpro/agent-rules/git-pr-template-and-merge.md",
  ".devpro/agent-skills/devpro-workflows/sync-rules/SKILL.md",
  ".devpro/agent-skills/release/release-runbook/SKILL.md",
  "README.md",
  "scenarios/scenario-ac-consumer-repo-sync-rules-production-continuation.md",
  "scenarios/scenario-d-consumer-repo-hotfix.md",
  "scenarios/scenario-f-consumer-repo-release-flow.md",
  "scenarios/scenario-h-source-repo-release-flow.md",
];

// rules-flow.md states the production sequence through its two on-demand leaves; the
// sequence assertions read the entry together with them.
const SPLIT_CARRIER_LEAVES = {
  ".devpro/agent-rules/rules-flow.md": [
    ".devpro/agent-rules/rules-flow-production-continuation.md",
    ".devpro/agent-rules/rules-flow-rollback.md",
  ],
};

function readCarrier(carrier) {
  return [carrier, ...(SPLIT_CARRIER_LEAVES[carrier] ?? [])].map((file) => read(file)).join("\n");
}

const TRACKING_CARRIERS = [
  ".devpro/agent-rules/git-workflow-tracking.md",
  "scenarios/scenario-n-consumer-repo-post-push-actions.md",
];

const POLICY_ALIGNMENT_CARRIERS = [
  "openspec/specs/per-change-worktree/spec.md",
];

const LIVE_CARRIERS = [
  ...FULL_RELEASE_SEQUENCE_CARRIERS,
  ...TRACKING_CARRIERS,
  ...POLICY_ALIGNMENT_CARRIERS,
];

const STALE_OPERATIVE_PATTERNS = [
  /^\s*git push origin production --tags\s*$/m,
  /^\s*git push origin main production[^\n]*--tags\s*$/m,
  /^\s*git push -u origin production\s*$/m,
  /^\s*git push origin main:production\s*$/m,
  /^\s*-\s*push production\s*(?:[:=]|$)/m,
];

const PRODUCTION_BRANCH_PUSH_EVENT_PATTERNS = [
  /(?:`?git push`?|`?push`?|push(?:es|ing)?|推送)(?:(?!PR merge)[^\n]){0,80}(?:to|into|到)(?:(?!PR merge)[^\n]){0,80}`?production`?/i,
  /(?:^|[\s/`])production`?(?:\s*branch)?\s+(?:push|推送)/im,
];

const NON_OPERATIVE_TRACKING_CONTEXT = /(?:MUST NOT|禁止|不得|不應|do not|historical|history|removed|已移除)/i;

function staleOperativeMatches(text) {
  return STALE_OPERATIVE_PATTERNS.filter((pattern) => pattern.test(text));
}

function productionBranchPushEventMatches(text) {
  return text
    .split("\n")
    .filter((line) => !NON_OPERATIVE_TRACKING_CONTEXT.test(line))
    .flatMap((line) => PRODUCTION_BRANCH_PUSH_EVENT_PATTERNS.filter((pattern) => pattern.test(line)));
}

function requirementBlock(text, title) {
  const marker = `### Requirement: ${title}`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const next = text.indexOf("\n### Requirement:", start + marker.length);
  return text.slice(start, next === -1 ? text.length : next).trim();
}

test("the live release carrier manifest is explicit and complete", () => {
  assert.equal(FULL_RELEASE_SEQUENCE_CARRIERS.length, 13);
  assert.equal(TRACKING_CARRIERS.length, 2);
  assert.equal(POLICY_ALIGNMENT_CARRIERS.length, 1);
  assert.equal(LIVE_CARRIERS.length, 16);
  assert.deepEqual(
    FULL_RELEASE_SEQUENCE_CARRIERS.filter((carrier) => carrier.startsWith("scenarios/")),
    [
      "scenarios/scenario-ac-consumer-repo-sync-rules-production-continuation.md",
      "scenarios/scenario-d-consumer-repo-hotfix.md",
      "scenarios/scenario-f-consumer-repo-release-flow.md",
      "scenarios/scenario-h-source-repo-release-flow.md",
    ],
  );
  assert.deepEqual(TRACKING_CARRIERS, [
    ".devpro/agent-rules/git-workflow-tracking.md",
    "scenarios/scenario-n-consumer-repo-post-push-actions.md",
  ]);
  assert.deepEqual(POLICY_ALIGNMENT_CARRIERS, [
    "openspec/specs/per-change-worktree/spec.md",
  ]);
  assert.equal(LIVE_CARRIERS.some((carrier) => carrier.includes("/archive/")), false);
});

test("All Live Release Carriers State The Same Production Sequence", () => {
  for (const carrier of FULL_RELEASE_SEQUENCE_CARRIERS) {
    const text = readCarrier(carrier);
    assert.match(text, /(?:push|推送)[^\n]*(?:work|release)[^\n]*(?:branch|分支)/i, `${carrier}: missing work/release branch push`);
    assert.match(text, /(?:PR|pull request)[^\n]*(?:base|目標)[^\n]*`?production`?/i, `${carrier}: missing production PR base`);
    assert.match(text, /GitHub[^\n]*(?:merge|合併)|(?:merge|合併)[^\n]*GitHub/i, `${carrier}: missing GitHub merge`);
    assert.match(text, /(?:exact|確切)[^\n]*(?:merged production|production PR|PR #1)[^\n]*(?:commit|SHA|結果)/i, `${carrier}: missing exact merged production commit`);
    assert.match(text, /fresh(?:ly)?[^\n]*(?:fetch|re-fetch)[^\n]*origin\/production/i, `${carrier}: missing fresh origin/production verification`);
    assert.match(text, /(?:explicit|明確)[^\n]*(?:commit|SHA)[^\n]*(?:tag|標籤)|(?:tag|標籤)[^\n]*(?:explicit|明確)[^\n]*(?:commit|SHA)/i, `${carrier}: missing explicit tag target`);
    assert.match(text, /push only[^\n]*tag ref|只推[^\n]*tag ref|tag-only push/i, `${carrier}: missing tag-only push`);
    assert.deepEqual(staleOperativeMatches(text), [], `${carrier}: contains stale operative protected-ref instruction`);
  }
});

test("tracking carriers name legal workflow events without a production branch-push path", () => {
  for (const carrier of TRACKING_CARRIERS) {
    const text = read(carrier);
    assert.match(text, /PR merge(?:d)? into[^\n]*`?production`?/i, `${carrier}: missing production PR merge event`);
    assert.match(text, /(?:push|推送)[^\n]*`?integration`?/i, `${carrier}: missing integration branch push event`);
    assert.match(text, /(?:push|推送)[^\n]*`?release(?:\/\*)?`?/i, `${carrier}: missing release branch push event`);
    assert.match(text, /(?:push|推送)[^\n]*work branch/i, `${carrier}: missing work branch push event`);
    assert.match(text, /tag push|push[^\n]*tag|推送[^\n]*tag/i, `${carrier}: missing tag-push event`);
    assert.deepEqual(productionBranchPushEventMatches(text), [], `${carrier}: lists a production branch push as an event/path`);
  }
});

test("live local-production-merge diagnostic routes to the PR-only sequence", () => {
  const text = read(".devpro/scripts/hooks/pre-tool-gate.mjs");
  assert.match(text, /production PR-only local merge gate/);
  assert.match(text, /base \\`production\\`/);
  assert.match(text, /exact merge commit/);
  assert.match(text, /只 push tag ref/);
  assert.match(text, /any local \\`git merge\\`/);
  assert.doesNotMatch(text, /建議：\\`git merge --no-ff release\/<X>\\`/);
  assert.doesNotMatch(text, /2f\. --no-ff release merge gate/);
  assert.doesNotMatch(text, /Step 6 requires \\`git merge release\/<ver>\\` on production/);
});

test("production PR identity is bound to the pushed release head before tag authority is accepted", () => {
  const text = read(".devpro/agent-rules/release-step-1-7.md");
  assert.match(text, /RELEASE_SHA=\$\(git rev-parse "\$RELEASE_BRANCH\^\{commit\}"\)/);
  assert.match(text, /--json state,baseRefName,headRefName,headRefOid,mergeCommit/);
  assert.match(text, /\.headRefName[\s\S]*\$RELEASE_BRANCH/);
  assert.match(text, /\.headRefOid[\s\S]*\$RELEASE_SHA/);
  assert.match(text, /PR head[^\n]*(?:release branch|RELEASE_BRANCH)[^\n]*(?:SHA|RELEASE_SHA)/i);
});

test("Step 6 production tag shell fails closed before tag create or push", () => {
  const text = read(".devpro/agent-rules/release-step-1-7.md");
  const marker = 'PROMOTED_PRODUCTION_TAG=production-YYYYMMDD[-<n>]';
  const markerIndex = text.indexOf(marker);
  assert.ok(markerIndex >= 0, "Step 6 production tag recipe must exist");
  const fenceStart = text.lastIndexOf("```bash", markerIndex);
  const fenceEnd = text.indexOf("```", markerIndex);
  assert.ok(fenceStart >= 0 && fenceEnd > fenceStart, "Step 6 recipe must be inside a bash fence");
  const block = text.slice(fenceStart, fenceEnd);
  assert.match(block, /^set -euo pipefail$/m);
  assert.match(block, /test "\$\(printf '%s' "\$PR_JSON" \| jq -r '\.state'\)" = MERGED/);
  assert.match(block, /git tag "\$PROMOTED_PRODUCTION_TAG" "\$MERGE_SHA"/);
  assert.match(block, /git push origin "refs\/tags\/\$PROMOTED_PRODUCTION_TAG"/);
  const setEIndex = block.indexOf("set -euo pipefail");
  const firstGateIndex = block.indexOf("test \"$(printf '%s' \"$PR_JSON\" | jq -r '.state')\" = MERGED");
  const tagIndex = block.indexOf("git tag \"$PROMOTED_PRODUCTION_TAG\" \"$MERGE_SHA\"");
  const pushIndex = block.indexOf("git push origin \"refs/tags/$PROMOTED_PRODUCTION_TAG\"");
  assert.ok(setEIndex >= 0 && setEIndex < firstGateIndex, "set -euo must precede PR identity gates");
  assert.ok(firstGateIndex < tagIndex && tagIndex < pushIndex, "gates must precede tag create and tag push");
});

test("Rules Lane Rollback SOP selects merge SHA from recorded production PR or tag", () => {
  const text = read(".devpro/agent-rules/rules-flow-rollback.md");
  assert.ok(text.includes("\n## Rollback SOP\n"), "rules-flow-rollback.md must own the Rollback SOP section");
  const sop = text.slice(text.indexOf("## Rollback SOP"));
  assert.doesNotMatch(sop, /git log production --first-parent --grep/);
  assert.doesNotMatch(sop, /找 `git log production --first-parent --grep='/);
  assert.match(sop, /MERGE_SHA/);
  assert.match(sop, /production-\*-rules\*/);
  assert.match(sop, /mergeCommit|recorded production PR|gh pr view/i);
  assert.match(sop, /git revert -m 1/);
  assert.match(sop, /禁[^\n]*merge-subject|禁[^\n]*Merge release\/rules-/i);
});

test("README pre-push inventory states protected-update rejection, PR recovery, and preserved deletion contract", () => {
  const row = read("README.md")
    .split("\n")
    .find((line) => line.includes(".devpro/scripts/hooks-git/pre-push"));

  assert.ok(row, "README must inventory the git-native pre-push hook");
  assert.match(row, /refs\/heads\/main/);
  assert.match(row, /refs\/heads\/production/);
  assert.match(row, /非刪除[^|]*(?:建立|更新)[^|]*block/i);
  assert.match(row, /`main`＝push `work branch`[^|]*PR base `main`[^|]*GitHub merge/i);
  assert.match(row, /`production`＝push `work\/release branch`[^|]*PR base `production`[^|]*GitHub merge/i);
  assert.match(row, /DEVPRO_PRUNE_REMOTE_DELETE=1/);
  assert.match(row, /prune-merged-local\.mjs --include-remote --exec/);
  assert.match(row, /prune-rules-lane\.mjs --include-remote --exec/);
  assert.match(row, /--no-verify/);
});

test("worktree capability does not authorize a production checkout or local promotion merge", () => {
  const text = requirementBlock(read("openspec/specs/per-change-worktree/spec.md"), "Per-Change Worktree Isolation");
  assert.match(text, /`production`[^\n]*(?:only|僅)[^\n]*(?:GitHub )?(?:pull request|PR)/i);
  assert.match(text, /tag[^\n]*(?:explicit|verified|已驗證)[^\n]*(?:merge|SHA|commit)/i);
  assert.doesNotMatch(text, /existing branch, e\.g\. `production` checkout for promote/);
  assert.doesNotMatch(text, /merge\/tag operations inside the worktree are permitted/);
});

test("first rules release requires the remote production PR target", () => {
  const lane = read(".devpro/agent-rules/release-rules-lane.md");
  const hook = read(".devpro/scripts/hooks/pre-tool-gate.mjs");
  const readme = read("README.md");
  const canonical = read("openspec/specs/rules-flow/spec.md");
  const delta = readChangeSpecWithArchiveFallback(
    "enforce-protected-branch-pr-only",
    "specs/rules-flow/spec.md",
    "openspec/specs/rules-flow/spec.md",
  );

  assert.match(lane, /FIRST_BASE=origin\/production/);
  assert.match(lane, /production target absent/);
  assert.doesNotMatch(lane, /elif git rev-parse --verify --quiet 'production\^\{commit\}'/);
  assert.doesNotMatch(lane, /FIRST_BASE=production(?:\s|`)/);
  assert.match(hook, /resolveFirstRulesReleaseProductionTip[\s\S]*resolveCommitSha\("origin\/production", cwd\)/);
  assert.doesNotMatch(hook, /resolveFirstRulesReleaseProductionTip[\s\S]{0,300}resolveCommitSha\("production", cwd\)/);
  assert.match(hook, /production target absent/);
  assert.match(readme, /first-rules-release＝`origin\/production` tip/);
  assert.doesNotMatch(readme, /first-rules-release＝`production` tip/);

  for (const [name, text] of [["canonical", canonical], ["delta", delta]]) {
    assert.match(text, /base = remote-tracking `origin\/production`/i, `${name}: missing remote production base`);
    assert.match(text, /First Rules Release From Remote Production Tip When No Tags/, `${name}: missing remote-target scenario`);
    assert.doesNotMatch(text, /origin\/production` if present, else local `production`/, `${name}: retains local production fallback`);
    assert.doesNotMatch(text, /refs\/heads\/production` or `refs\/remotes\/origin\/production/, `${name}: accepts a local-only production branch`);
  }
});

test("source hotfix canonical requirement exactly mirrors the active MODIFIED block", () => {
  const title = "Source Hotfix Reaches Production Only Via SemVer Assemble";
  const canonical = requirementBlock(read("openspec/specs/source-hotfix-semver-assemble/spec.md"), title);
  // Compare against the latest change that MODIFIED this requirement (a MODIFIED
  // block fully replaces the canonical body on archive). enforce-hotfix-release-carrier
  // is now the latest change to MODIFY this requirement (D10); once archived, the
  // archive-fallback branch below still resolves this test to that change's copy.
  const delta = requirementBlock(
    readChangeSpecWithArchiveFallback(
      "enforce-hotfix-release-carrier",
      "specs/source-hotfix-semver-assemble/spec.md",
      "openspec/specs/source-hotfix-semver-assemble/spec.md",
    ),
    title,
  );
  assert.equal(canonical, delta);
});

test("tracking event detection rejects production branch-push paths but preserves classified context", () => {
  const rejectedFixtures = [
    "`push` 到 `integration` / `release` / `production`、tag push",
    "pushes to integration/release/production branches",
    "production branch push",
  ];
  for (const fixture of rejectedFixtures) assert.equal(productionBranchPushEventMatches(fixture).length, 1, fixture);

  const preservedFixtures = [
    "PR merge into main/production, integration/release/work branch push or tag push",
    "MUST NOT push to production.",
    "Historical note: production branch push was removed.",
  ];
  for (const fixture of preservedFixtures) assert.deepEqual(productionBranchPushEventMatches(fixture), [], fixture);
});

test("Semantic Carrier Scan Preserves Negative History Work-Branch And Tag Text", () => {
  const staleFixtures = [
    "git push origin production --tags",
    "git push origin main production release/v1.2.3 --tags",
    "git push -u origin production",
    "git push origin main:production",
    "- push production",
  ];
  for (const fixture of staleFixtures) assert.equal(staleOperativeMatches(fixture).length, 1, fixture);

  const preservedFixtures = [
    "MUST NOT run git push origin production --tags.",
    "Historical evidence: git push origin production --tags was removed.",
    "git push origin release/v1.2.3",
    "git push origin refs/tags/production-v1.2.3",
    "node .devpro/scripts/prune-merged-local.mjs --include-remote --exec",
    "git push origin --delete feature/merged",
  ];
  for (const fixture of preservedFixtures) assert.deepEqual(staleOperativeMatches(fixture), [], fixture);
});
