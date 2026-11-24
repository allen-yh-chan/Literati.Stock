/**
 * Grep anchors for enforce-hotfix-semver-assemble (source SemVer repos and
 * consumer repos now share one release-carrier lane into production; no
 * repo-identity branch, no dual-PR bypass).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readSourceFile as read } from "./lib/read.mjs";

const releaseFlow = read(".devpro/agent-rules/release-sit-uat-pat-prod.md");
const releaseSteps = read(".devpro/agent-rules/release-step-1-7.md");
const hotfixRecipe = read(".devpro/agent-rules/release-hotfix-carrier-lane.md");
const prTemplate = read(".devpro/agent-rules/git-pr-template-and-merge.md");
const crossModel = read(".devpro/agent-rules/code-review-cross-model.md");
const postPr = read(".devpro/agent-rules/post-pr-completion-gate.md");
const gateSrc = read(".devpro/scripts/hooks/pre-tool-gate.mjs");
const runbook = read(".devpro/agent-skills/release/release-runbook/SKILL.md");
const hotfixScenario = read("scenarios/scenario-d-consumer-repo-hotfix.md");

test("source and consumer leaves mandate the same release-carrier lane and hard-block direct merge to production", () => {
  for (const phrase of [
    "**禁** `hotfix/*`／`chore/bump-v*` 直合 `production`",
    "source 與 consumer 皆同構、無 repo 身分分岔",
  ]) {
    assert.ok(releaseFlow.includes(phrase), `release-sit missing: ${phrase}`);
  }
  assert.match(read(".devpro/agent-rules/release-hotfix-carrier-policy.md"), /^### Hotfix Release-Carrier Lane（SSOT）$/m, "the normative SSOT section lives in release-hotfix-carrier-policy.md");
  assert.match(releaseFlow, /release-hotfix-carrier-policy\.md/, "release-sit must point at the normative SSOT leaf");
  assert.match(hotfixRecipe, /### Hotfix release-carrier lane（source／consumer 同構）/);
  assert.doesNotMatch(
    releaseSteps,
    /### Source SemVer（hotfix-subset/,
    "the old source-only Step 7 heading must be gone (unified carrier lane replaces it)",
  );
  assert.doesNotMatch(
    releaseSteps,
    /### Consumer（date／Rules／hotfix recovery/,
    "the old consumer-only Step 7 heading must be gone (unified carrier lane replaces it)",
  );
  assert.doesNotMatch(
    releaseSteps,
    /Source SemVer[\s\S]{0,400}PR #1 → production/,
    "source Step 7 must not authorize PR #1 → production merge recipe",
  );
});

test("成對雙 PR (paired dual-PR bypass) is gone from the live carrier lane", () => {
  assert.doesNotMatch(
    prTemplate,
    /成對雙 PR/,
    "no live carrier doc may still authorize a paired dual-PR bypass into production",
  );
  assert.match(
    prTemplate,
    /只有 carrier 自己的 PR 進 `production`/,
    "pr-template must state only the carrier's own PR reaches production",
  );
});

test("Path A carrier lane and unit sticky anti-stack documented (source／consumer 同構)", () => {
  assert.match(crossModel, /\*\*Hotfix carrier\*\*（source `release\/v\*`；consumer/);
  assert.match(crossModel, /組裝證據機械 deepen 可分階段|可分階段/);
  assert.match(postPr, /hotfix unit sticky（source／consumer）/);
  assert.match(postPr, /疊船/);
  assert.match(postPr, /hotfix unit sticky[^\n]*`release-hotfix-carrier-policy\.md`/, "post-PR gate must point at the policy leaf holding the rule");
  // The full rule lives in the hotfix policy leaf, loaded only when a hotfix PR is reviewed.
  const unitStickyLine = read(".devpro/agent-rules/release-hotfix-carrier-policy.md")
    .split("\n")
    .find((line) => line.startsWith("**hotfix unit sticky（source／consumer）"));
  assert.ok(unitStickyLine, "hotfix policy must carry the unit sticky rule");
  assert.match(unitStickyLine, /tip 變必須重 sticky/);
  assert.match(unitStickyLine, /禁把未審兄弟 hotfix／main 合併進已 sticky 單元來「刷新」就緒（疊船）/);
  assert.match(unitStickyLine, /不靠對 carrier 重跑 per-hotfix dual sticky merge-in/);
});

test("hook exempts base=production only via the 3 release SSOT carriers, on every repository", () => {
  assert.ok(
    gateSrc.includes("function isBaseProductionBlockExempt(headRefName) {"),
    "isBaseProductionBlockExempt must be a pure function of headRefName (no cwd param)",
  );
  assert.doesNotMatch(
    gateSrc,
    /function isBaseProductionBlockExempt\(headRefName, cwd\)/,
    "isBaseProductionBlockExempt must not take a cwd param post-D1",
  );
  const exemptFnStart = gateSrc.indexOf(
    "function isBaseProductionBlockExempt(headRefName) {",
  );
  const wrapper = gateSrc.slice(exemptFnStart, gateSrc.indexOf("\n}", exemptFnStart) + 2);
  assert.match(wrapper, /return githubProductionCarrier\(h\)/);
  const shared = read(".devpro/scripts/hooks/lib/github-merge-exemptions.mjs");
  const exemptFnBody = shared.slice(shared.indexOf("export function githubProductionCarrier("));
  assert.doesNotMatch(
    exemptFnBody,
    /isSourceRepo\(|\bhotfix\b/,
    "isBaseProductionBlockExempt body must not branch on isSourceRepo(cwd) or hotfix — only the 3 release SSOT helpers decide exemption",
  );
  for (const helper of [
    "isSourceRepoReleaseBranchExempt(branch)",
    "isConsumerSubsetReleaseBranchExempt(branch)",
    "isRulesLaneReleaseBranchExempt(branch)",
  ]) {
    assert.ok(exemptFnBody.includes(helper), `isBaseProductionBlockExempt missing: ${helper}`);
  }
});

test("Source Hotfix Tags The Exact Production PR Merge Commit", () => {
  for (const [name, text] of [
    ["release steps", releaseSteps],
    ["release flow", releaseFlow],
    ["PR template", prTemplate],
    ["release runbook", runbook],
    ["consumer hotfix scenario", hotfixScenario],
  ]) {
    assert.match(
      text,
      /(?:exact|確切)[^\n]*(?:(?:production PR|PR #1)[^\n]*(?:merge commit|merge result|merged commit|merge 結果)|merged production commit)/i,
      `${name} must bind the tag to the exact production PR merge result`,
    );
    assert.match(text, /fresh(?:ly)?[^\n]*(?:fetch|re-fetch)[^\n]*origin\/production/i, `${name} must freshly verify origin/production`);
    assert.match(text, /push only[^\n]*tag ref|只推[^\n]*tag ref|tag-only push/i, `${name} must use a tag-only push`);
    assert.doesNotMatch(text, /^\s*git push origin production --tags\s*$/m, `${name} must not directly push production with tags`);
  }
});
