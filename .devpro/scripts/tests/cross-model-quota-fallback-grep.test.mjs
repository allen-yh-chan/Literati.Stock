/**
 * cross-model-quota-fallback-grep.test.mjs
 *
 * Mechanical guard for issue #3574: when both reviewer families are
 * authenticated but out of quota, the rule corpus and the merge-gate block text
 * must name the sanctioned ladder (same-family fallback sticky → Path F, or
 * UNAVAILABLE sticky → Path U / Path W) and must state that the generic
 * `DEVPRO_HOOK_BYPASS=1` prefix is not one of those routes.
 *
 * The scenarios asserted here are the ones added by the
 * `Reviewer Quota Unavailable Has A Sanctioned Fallback Ladder` requirement.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const crossModel = readFileSync(repoPath(".devpro/agent-rules/code-review-cross-model.md"), "utf8");
const checklist = readFileSync(repoPath(".devpro/agent-rules/code-review-checklist.md"), "utf8");
const cliContract = readFileSync(repoPath(".devpro/agent-rules/code-review-cross-model-cli-contract.md"), "utf8");
const spec = readFileSync(repoPath("openspec/specs/code-review-checklist/spec.md"), "utf8");
const reviewPolicy = readFileSync(repoPath(".devpro/scripts/hooks/lib/github-review-policy.mjs"), "utf8");

// The retired definition read a surface classifier result as authentication
// success. `host-fault` means a real logout or network outage on the host, and
// `ok` also covers a missing exit status with no fault text, so "one family out
// of quota + the other family logged out" used to satisfy the precondition.
const RETIRED_AUTH_EQUIVALENCE = [
  /`classifyAuthSurfaceFault` 回 `ok` 或 `host-fault`/,
  /`classifyAuthSurfaceFault` returns `ok` or `host-fault`/,
];

test("retired auth-equivalence markers catch the historical wording and spare the current sentence", () => {
  // Absence-axis fixture (rule-anchor-guard-strength.md): without it a marker
  // that silently stopped matching would keep the absence assertions green.
  const historical = [
    "所有仍可用的 reviewer family 的 auth preflight 皆成功（`classifyAuthSurfaceFault` 回 `ok` 或 `host-fault`，不得是 `sandbox-surface-fault` 或 `real-unavailable`）",
    "has a successful authentication preflight (`classifyAuthSurfaceFault` returns `ok` or `host-fault`)",
  ];
  const current = [
    "`classifyAuthSurfaceFault` 的結果只描述 invocation surface，不能當認證成功的證據（host 上真的登出／斷網回 `host-fault`，缺 exit status 且無錯誤字樣回 `ok`）",
    "a `classifyAuthSurfaceFault` result of `ok` or `host-fault` MUST NOT count as authentication success",
  ];
  for (const line of historical) {
    assert.ok(RETIRED_AUTH_EQUIVALENCE.some((re) => re.test(line)), `marker must catch: ${line}`);
  }
  for (const line of current) {
    assert.equal(RETIRED_AUTH_EQUIVALENCE.some((re) => re.test(line)), false, `marker must spare: ${line}`);
  }
});

test("Scenario: A Quota Failure Is Classified And Evidenced", () => {
  assert.match(crossModel, /Reviewer quota unavailable（`quota-unavailable`）/);
  assert.match(crossModel, /所有仍可用的 reviewer family 的 auth preflight 皆成功，而 invocation 以額度／用量上限失敗/);
  assert.match(crossModel, /\*\*auth preflight 成功只認正面證據\*\*：該 family 的 probe 紀錄 `auth_preflight\.classification` 為 `reviewer_host_capability_verified`/);
  assert.match(crossModel, /`classifyAuthSurfaceFault` 的結果只描述 invocation surface，不能當認證成功的證據/);
  assert.match(crossModel, /429/);
  assert.match(crossModel, /exit\/status＋redacted summary＋log path/);
  assert.match(crossModel, /它不是 `real-unavailable`、不是 sandbox fault/);
  // One quantifier and one positive-evidence condition across every carrier.
  assert.match(checklist, /所有仍可用 reviewer family 都 auth 成功、但 invocation 因額度失敗/);
  assert.match(spec, /every reviewer family that is still available has a successful authentication preflight — positive evidence only: that family's probe recorded `auth_preflight\.classification` as `reviewer_host_capability_verified`/);
  assert.match(spec, /A `classifyAuthSurfaceFault` result describes only the invocation surface and MUST NOT be read as authentication success/);
  assert.match(spec, /\*\*GIVEN\*\* every reviewer family that is still available has a successful authentication preflight \(its probe recorded `auth_preflight\.classification` as `reviewer_host_capability_verified`\)/);
  for (const marker of RETIRED_AUTH_EQUIVALENCE) {
    assert.equal(marker.test(crossModel), false, `rule must not equate a classifier result with auth success: ${marker}`);
    assert.equal(marker.test(spec), false, `spec must not equate a classifier result with auth success: ${marker}`);
  }
  // The CLI contract must point at the same SSOT instead of re-deriving it.
  assert.match(cliContract, /quota-unavailable`）的判定、必要 evidence 與完整階梯見 `code-review-cross-model\.md` §失效 Fallback/);
});

test("Scenario: A Family Without Verified Authentication Does Not Satisfy The Quota Precondition", () => {
  assert.match(crossModel, /任一仍可用 family 的 auth preflight 不是 `reviewer_host_capability_verified` → 前提不成立：不得記 `quota-unavailable`、不進下方階梯、不得 fallback 到該 family；停下回報該 family 的 auth 狀態/);
  assert.match(spec, /the precondition fails: the flow MUST NOT record `quota-unavailable`, MUST NOT enter the ladder or fall back to that family, and MUST stop and report that family's authentication state/);
  assert.match(spec, /#### Scenario: A Family Without Verified Authentication Does Not Satisfy The Quota Precondition/);
  assert.match(spec, /\*\*AND\*\* a `classifyAuthSurfaceFault` result of `ok` or `host-fault` MUST NOT count as authentication success/);
});

test("Scenario: A Same-Family Fallback Sticky Satisfies The Merge Gate", () => {
  // F1: the fallback reviewer is the author/primary family, which is what
  // "same-family fallback" already means in the renderer contract.
  assert.match(crossModel, /\*\*同家族 fallback\*\*：改派 author／primary family（PR 作者那一家；same-family fallback 的既定語意）中仍可用的 reviewer/);
  assert.equal(/改派與主審同 family/.test(crossModel), false, "the ambiguous 主審 wording must not return");
  assert.match(crossModel, /`same-family fallback: <why>` 與 provenance，verdict 照常，merge 走 Path F/);
  assert.match(crossModel, /此階不能宣稱 cross-model diversity/);
  assert.match(spec, /Same-family fallback: dispatch an available reviewer from the author\/primary family — the established meaning of a same-family fallback/);
  assert.match(spec, /This step MUST NOT claim cross-model diversity/);
  assert.match(spec, /an available reviewer from the author\/primary family — the established same-family fallback — is dispatched/);
  assert.equal(
    /outside the reviewed pull request author's family/.test(spec),
    false,
    "the impossible outside-the-author-family qualifier must not survive in the promoted spec",
  );
  assert.match(crossModel, /對話紀錄、多輪同家族 verdict 或 PR 留言都不是 sticky 的替代品/);
});

test("Scenario: Both Families Exhausted Blocks Until Path U Or Path W", () => {
  assert.match(crossModel, /兩個 family 皆無額度/);
  assert.match(crossModel, /`verdict: UNAVAILABLE` sticky（`reason:`＋`last_reviewed_sha:`＋provenance）/);
  assert.match(crossModel, /merge 走 Path U：fresh review、人類 reviewer 結論，或合規 Path W waiver/);
  assert.match(crossModel, /額度恢復後 MUST 補做 fresh 第二意見/);
});

test("Scenario: The Block Message Never Presents Bypass As Sanctioned", () => {
  // The shared block hint lives in the review policy module and is appended to
  // both Path B and Path U messages.
  assert.match(reviewPolicy, /const QUOTA_FALLBACK_HINT/);
  assert.match(reviewPolicy, /`DEVPRO_HOOK_BYPASS=1` 不是 sanctioned 解除路徑/);
  const hintUses = reviewPolicy.match(/\$\{QUOTA_FALLBACK_HINT\}/g) || [];
  assert.equal(hintUses.length, 2, "Path B and Path U must both carry the quota ladder hint");
  // The primary checklist may not carry a second copy of the ladder; it points.
  assert.match(checklist, /§失效 Fallback 的 `quota-unavailable`/);
  assert.equal(
    /同家族 fallback`：改派仍可用/.test(checklist),
    false,
    "the checklist is a pointer, not a second copy of the ladder",
  );
});
