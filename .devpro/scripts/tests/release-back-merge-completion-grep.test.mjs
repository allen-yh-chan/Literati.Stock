import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/repo-root.mjs";
import { STEPS, stepSixABlocks, stepSixACommandSection } from "./lib/step-6a-blocks.mjs";

// An agent released a consumer repo to production, pushed the tag, and stopped: the last step (Step 6A,
// merging `production` back into `main`) never ran. Nothing mechanical owns that step, so the text has to:
// the Step 6 tag-only push must not read as the endpoint, Step 6A needs copy-execute blocks with the
// right direction that stop before any push or PR when the route is not the graph-only back-merge, and no
// neighbouring rule may say `main` stays unchanged after a release. The blocks themselves are executed in
// release-step-6a-block-behavior.test.mjs (integration tier).

const read = (file) => readFileSync(path.join(REPO_ROOT, file), "utf8");
const lineStartingWith = (text, prefix) => {
  const hits = text.split("\n").filter((line) => line.startsWith(prefix));
  assert.equal(hits.length, 1, `expected exactly one line starting with ${prefix}, found ${hits.length}`);
  return hits[0];
};

const RUNBOOK = ".devpro/agent-skills/release/release-runbook/SKILL.md";
const TRACKING = ".devpro/agent-rules/git-workflow-tracking.md";
const ROUTER = ".devpro/agent-rules/release-sit-uat-pat-prod.md";
const RATIONALIZATIONS = ".devpro/agent-rules/ai-autonomy-rationalizations.md";

const GATE = 'node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor --production-ref "$PROMOTED_PRODUCTION_TAG" --main-ref "$CANDIDATE_MAIN_SHA"';

test("release-step-1-7.md: the Step 6 tag-only push is declared not to be the release endpoint", () => {
  const line = lineStartingWith(read(STEPS), "**tag-only push 不是 release 的終點**");
  assert.match(line, /緊接執行下方 Step 6A（把 `production` 合回 `main`/);
  assert.match(line, /6A 的 `--require-main-ancestor` gate exit 0 之前，不得回報 release 完成/);
});

test("release-step-1-7.md: the observation wait does not park the agent before Step 6A", () => {
  const line = lineStartingWith(read(STEPS), "佈署完成後至少觀察一輪告警週期");
  assert.match(line, /不得以「等觀察結束」為由停在這裡.*6A 的 gate exit 0 之前不得回報 release 完成/);
});

test("release-back-merge-completion.md: Step 6A splits into guarded blocks with the gate, the classifier, the ff, the push, the PR and the re-check in order", () => {
  const [push, pr, verify] = stepSixABlocks();
  assert.ok(push.includes(GATE), "ancestry gate runs first");
  assert.ok(pr.includes(GATE), "the PR block re-checks the gate against freshly fetched refs instead of trusting the first block");
  assert.ok(verify.includes(GATE), "ancestry gate runs again after the back-merge PR");
  assert.equal(stepSixABlocks().join("\n").split(GATE).length - 1, 3, "the gate appears once in each of the three blocks");
  const order = [GATE, "--reconciliation-status --production-ref", 'git merge --ff-only "$PROMOTED_PRODUCTION_TAG"', 'git push origin "$RELEASE_BRANCH"'].map((token) => {
    const index = push.indexOf(token);
    assert.ok(index >= 0, `first block lost: ${token}`);
    return index;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "gate, classifier, ff, push stay in this order");
  assert.ok(pr.includes('gh pr create --base main --head "$RELEASE_BRANCH"'), "second block opens the PR");
  assert.equal(push.includes("gh pr create"), false, "the first block never opens a PR");
  assert.match(push, /# 方向：promoted tag 必須是 main 的祖先（tag ⊂ main）；不是檢查「production 是否含 main」/);
});

test("release-back-merge-completion.md: the blocks that push or open a PR run in a fail-closed subshell and stop before the side effect", () => {
  const [push, pr] = stepSixABlocks();
  for (const block of [push, pr]) {
    assert.ok(block.startsWith("(\n  set -euo pipefail\n"), "block runs in a subshell with set -euo pipefail");
    assert.match(block, /\n  : "\$\{PROMOTED_PRODUCTION_TAG:\?[^}]*\}" "\$\{RELEASE_BRANCH:\?[^}]*\}"\n/);
  }
  // bash reads a multibyte character right after $NAME as part of the name, which is "unbound variable" under set -u
  assert.doesNotMatch(stepSixABlocks().join("\n"), /\$[A-Za-z_]+[^\u0000-\u007f]/u, "brace a variable that is followed by a non-ASCII character");
  // every push, ff and PR line is indented inside the subshell, never a bare top-level command
  assert.doesNotMatch(push, /^git (?:merge|push)/m);
  assert.doesNotMatch(pr, /^gh pr create/m);
  // each guard exists and precedes the side effect it protects: route check before the ff, HEAD==tag before the push,
  // gate and route re-checked and remote release branch == tag before the PR
  const guardBefore = (block, guard, effect) => {
    const guardAt = block.indexOf(guard);
    const effectAt = block.indexOf(effect);
    assert.ok(guardAt >= 0, `guard missing: ${guard}`);
    assert.ok(effectAt > guardAt, `${effect} must come after ${guard}`);
  };
  guardBefore(push, '[ "$ROUTE" = "release-lane-back-merge" ] ||', "git merge --ff-only");
  guardBefore(push, '[ "$(git rev-parse --abbrev-ref HEAD)" = "$RELEASE_BRANCH" ] ||', "git merge --ff-only");
  guardBefore(push, '[ "$(git rev-parse HEAD)" = "$(git rev-parse "$PROMOTED_PRODUCTION_TAG^{commit}")" ] ||', "git push origin");
  guardBefore(pr, "if node .devpro/scripts/detect-branch-base.mjs --require-main-ancestor", "gh pr create");
  guardBefore(pr, '[ "$ROUTE" = "release-lane-back-merge" ] ||', "gh pr create");
  guardBefore(pr, '[ "$(git rev-parse "origin/$RELEASE_BRANCH^{commit}")" = "$(git rev-parse "$PROMOTED_PRODUCTION_TAG^{commit}")" ] ||', "gh pr create");
});

test("release-back-merge-completion.md: no Step 6A block pushes main or production, forces, skips hooks, or merges by squash, rebase or ours", () => {
  const all = stepSixABlocks().join("\n");
  assert.doesNotMatch(all, /git push\s+\S+\s+(?:refs\/heads\/)?(?:main|production)\b/);
  assert.doesNotMatch(all, /--force|--no-verify|-s ours|--squash|--rebase/);
});

test("release-back-merge-completion.md: merging into main is named an Ask First stop that is not release completion", () => {
  const line = lineStartingWith(stepSixACommandSection(), "`graph-only` 判準");
  assert.match(line, /\*\*合進 `main` 是 Ask First 停點\*\*.*編號選項.*不是 release 完成/);
});

test("release-step-1-7.md: the Step 1 production-intent request states the graph-only back-merge coverage and how it is withheld", () => {
  const line = lineStartingWith(read(STEPS), "   **back-merge 涵蓋聲明（對應 Step 6A）**");
  assert.match(line, /`release-to-production-new` 或 `release-to-production-existing`/);
  assert.match(line, /graph-only 時視為已涵蓋.*regular merge 合進 `main`.*非 graph-only 仍停下詢問/);
  assert.match(line, /使用者可在回覆中排除.*未載明或被排除.*Step 6A 仍是 Ask First 停點/);
  assert.match(line, /`release-to-sit` 不涉及 Step 6A/);
});

test("release-back-merge-completion.md: the only exception to the Ask First stop needs all three conditions and falls back otherwise", () => {
  const line = lineStartingWith(stepSixACommandSection(), "- **Step 1 已涵蓋的 graph-only back-merge");
  assert.match(line, /Ask First 的唯一例外/);
  assert.match(line, /\(a\).*Step 1.*已載明涵蓋.*未被使用者排除/);
  assert.match(line, /\(b\).*`recommendedRoute=release-lane-back-merge`.*conflict-free.*zero tree delta.*第②段開頭重新 fetch 後的重驗/);
  assert.match(line, /\(c\).*保護規則要求他人核准時，停下交使用者/);
  assert.match(line, /regular merge（禁 squash／rebase）/);
  assert.match(line, /`content-review-required`.*有衝突.*ff-only 失敗.*需 repair.*ref 無法唯一解析.*回到上一段的 Ask First 停點/);
  const ask = lineStartingWith(stepSixACommandSection(), "`graph-only` 判準");
  assert.match(ask, /\*\*合進 `main` 是 Ask First 停點\*\*（預設；唯一例外見下一條）/);
});

test("release-sit-uat-pat-prod.md: both production intents point to the Step 1 coverage statement", () => {
  const text = read(ROUTER);
  assert.match(lineStartingWith(text, "| `release-to-production-new` |"), /Step 1 的 intent 請求須載明 graph-only back-merge 的涵蓋/);
  assert.match(lineStartingWith(text, "| `release-to-production-existing` |"), /選定請求須載明 graph-only back-merge 的涵蓋/);
});

test("release-runbook skill: the ordered recipe lists Step 6A and defines the endpoint as its gate", () => {
  const text = read(RUNBOOK);
  const recipe = lineStartingWith(text, "載入 `release-step-1-7.md` 取得具體指令序列");
  assert.match(recipe, /Step 6A tag 之後把 `production` 合回 `main`（`--require-main-ancestor` gate exit 0 才算完成，見下方 §3B）；Step 7 PROD issue 修復/);
  assert.match(recipe, /推進到該輪的終點（一般 promotion 的終點是 Step 6A 的 gate exit 0，不是 tag-only push）/);
});

test("git-workflow-tracking.md: after production + tag the next step is Step 6A, and main is not said to stay unchanged", () => {
  const text = read(TRACKING);
  assert.equal(text.includes("release 完成後 main 不再變動"), false, "the contradicting 'main stays unchanged' wording is gone");
  assert.match(lineStartingWith(text, "- **`release/*` → `production` + tag**"), /接續 Step 6A：把 `production` 合回 `main`/);
  assert.match(lineStartingWith(text, "| `production`（release/v* 或 release/<date>-<sha> PR）|"), /Step 6A back-merge PR 合併後 `main` 會再前進/);
});

test("release-sit-uat-pat-prod.md: the production intents end at Step 6A and a rationalization row mirrors the hotfix one", () => {
  const text = read(ROUTER);
  assert.match(lineStartingWith(text, "| `release-to-production-new` |"), /Step 6 與 Step 6A（tag 後合回 `main`；gate exit 0 才是本輪終點）/);
  assert.match(lineStartingWith(text, "| `release-to-production-existing` |"), /→ Step 6 與 Step 6A；除非/);
  const row = lineStartingWith(text, "| 「production PR 合併、tag 推完了，release 完成」 |");
  assert.match(row, /Step 6A.*`--require-main-ancestor` exit 0.*缺 back-merge PR（`MERGED`）即未完成/);
});

test("ai-autonomy-rationalizations.md: a stopping excuse after the tag push points back at Step 6A", () => {
  const row = lineStartingWith(read(RATIONALIZATIONS), "| 「production PR 合併、tag 推完、告警觀察中，release 完成了」 |");
  assert.match(row, /不是 terminal.*Step 6A.*`--require-main-ancestor` exit 0/);
});
