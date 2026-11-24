import { test } from "node:test";
import assert from "node:assert/strict";
import { readRepoFile as read } from "./lib/read.mjs";



const footerGate = read(".devpro/scripts/hooks/gh-footer-gate.mjs");
const preToolGate = read(".devpro/scripts/hooks/pre-tool-gate.mjs");
const commandContext = read(".devpro/scripts/hooks/lib/hook-command-context.mjs");
const branchNaming = read(".devpro/scripts/hooks/lib/branch-naming.mjs");
const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
const fileDestinations = read(".devpro/agent-rules/file-write-destinations.md");
const codex = read(".devpro/agent-rules/platform-adapters/codex.md");
const codexGitHubWrites = read(".devpro/agent-rules/platform-adapters/codex-github-writes.md");
const outputDisciplineSpec = read("openspec/specs/output-discipline/spec.md");
const rulesFlowSpec = read("openspec/specs/rules-flow/spec.md");
const preToolGatesSpec = read("openspec/specs/pre-tool-mechanical-gates/spec.md");
const footerGateScenario = read("scenarios/scenario-x-source-repo-gh-footer-gate-enforcement.md");

const exactRulesRecipe = "cd <abs-rules-worktree> && gh pr create ... --head rules/<source>-v<X.Y.Z>";

test("command-position cwd resolver has one shared implementation and no new package dependency", () => {
  assert.match(
    footerGate,
    /from ['"]\.\/lib\/hook-command-context\.mjs['"]/,
    "footer gate must consume the shared command-context resolver"
  );
  assert.match(
    preToolGate,
    /from ['"]\.\/lib\/hook-command-context\.mjs['"]/,
    "pre-tool gate must consume the shared command-context resolver"
  );
  assert.match(preToolGate, /export \{[\s\S]*\bcommandCwdAt,[\s\S]*\btoolInputCwd,/);

  const allRuntimeSources = `${commandContext}\n${footerGate}\n${preToolGate}`;
  assert.equal(
    (allRuntimeSources.match(/(?:export\s+)?function commandCwdAt\s*\(/g) || []).length,
    1,
    "commandCwdAt implementation must exist only in the shared helper"
  );
  assert.equal(
    (allRuntimeSources.match(/(?:export\s+)?function toolInputCwd\s*\(/g) || []).length,
    1,
    "toolInputCwd implementation must exist only in the shared helper"
  );
  assert.doesNotMatch(preToolGate, /function effectiveCdCwd\s*\(/);
  assert.doesNotMatch(footerGate, /function effectiveCdCwd\s*\(/);
  assert.match(footerGate, /CMD_POSITION_ANCHOR \+ "\(gh\)\\\\s"/);
  assert.match(footerGate, /match\.indices\[1\]\[0\]/);
  assert.doesNotMatch(footerGate, /match\[0\]\.indexOf\(['"]gh['"]\)/);

  const dependencies = [...commandContext.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(dependencies.length > 0, "shared helper imports must remain inspectable");
  assert.ok(
    dependencies.every((specifier) => specifier.startsWith("node:") || specifier.startsWith("./")),
    `shared helper must not add a package dependency: ${dependencies.join(", ")}`
  );
});

test("rules branch identity has one SemVer source and all consumers delegate to it", () => {
  assert.equal(
    (branchNaming.match(/(?:export\s+)?const RULES_SYNC_SEMVER_RE\b/g) || []).length,
    1,
    "RULES_SYNC_SEMVER_RE must have one definition"
  );
  assert.match(branchNaming, /branch\.match\(RULES_SYNC_SEMVER_RE\)/);
  assert.match(
    branchNaming,
    /function isRulesSyncExemptFromCrossModel[\s\S]*?rulesSyncBranchIdentity\(branchName, repoRoot\)\.kind === "rules";/
  );
  assert.match(
    branchNaming,
    /function validateRulesBranch[\s\S]*?const identity = rulesSyncBranchIdentity\(branchName, repoRoot\);/
  );
  assert.doesNotMatch(
    branchNaming,
    /function validateRulesBranch[\s\S]*?branchName\.match\(\/\^rules/,
    "validateRulesBranch must not introduce a third inline rules identity regex"
  );
  assert.match(footerGate, /rulesSyncBranchIdentity\(currentBranch, repoRoot\)/);
});

test("footer selector is a bounded rules exception and keeps the generic fallback", () => {
  assert.match(footerGate, /function rulesOperationVersionContext\(\)/);
  assert.match(
    footerGate,
    /const rulesSignal = currentBranch\.startsWith\('rules\/'\) \|\| head\.rulesSignal/
  );
  assert.match(
    footerGate,
    /if \(rulesContexts\.length === 0\) \{\s*const generic = agentsMdVersionForVersionEquality\(\);\s*return \{ kind: 'generic', version: generic\.version \};\s*\}/
  );
  assert.match(footerGate, /if \(_versionContext\.kind === 'rules'\)/);
  assert.match(outputDisciplineSpec, /narrow rules-only exception/);
  assert.match(outputDisciplineSpec, /The anchor MUST NOT follow `-R\/--repo` into the write target/);
  assert.match(
    footerGate,
    /cwd checkout yields no version, they remove the only remaining repo version anchor/,
    "the /tmp rationale must stay conditional on the cwd yielding no version",
  );
  assert.doesNotMatch(
    footerGate,
    /repo-external \/tmp body files are discouraged because they remove the repo version anchor。/,
    "the unconditional /tmp anchor claim must not come back",
  );
});

test("the /tmp anchor rationale stays conditional in every carrier that states it", () => {
  const carriers = [
    ["gh-footer-gate.mjs", footerGate, /cwd checkout yields no version, they remove the only remaining repo version anchor/],
    ["file-write-destinations.md", fileDestinations, /cwd 讀不到版號時會失去唯一剩下的 repo 版號錨點/],
    ["codex-github-writes.md", codexGitHubWrites, /when the cwd checkout yields no version it removes the only remaining repo anchor/],
    ["pre-tool-mechanical-gates spec", preToolGatesSpec, /when the cwd checkout yields no version they remove the only remaining repo anchor/],
    ["footer-gate scenario", footerGateScenario, /cwd 讀不到版號時會失去唯一剩下的 repo 版號錨點/],
  ];
  const retired = [
    /they remove the repo version anchor entirely/,
    /it removes the main-repo version anchor/,
    /失去 repo 版號錨點/,
    /失去目標 worktree 錨點/,
  ];
  for (const [name, text, conditional] of carriers) {
    assert.match(text, conditional, `${name} must state the conditional /tmp rationale`);
    for (const phrase of retired) {
      assert.doesNotMatch(text, phrase, `${name} must not carry a retired unconditional /tmp claim`);
    }
  }
});

test("release-integrity diagnostics retain all three actionable classifications", () => {
  for (const diagnostic of [
    "Rules operation context unresolved (release-integrity)",
    "Rules operation context mismatch (release-integrity)",
    "Footer version mismatch (release-integrity)",
  ]) {
    assert.match(footerGate, new RegExp(diagnostic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(rulesFlowSpec, new RegExp(diagnostic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("rules and Codex carriers prescribe exact operation evidence without replacing generic provenance", () => {
  for (const [name, content] of [
    ["rules-flow", rulesFlow],
    ["file-write-destinations", fileDestinations],
    ["codex", codex],
    ["codex-github-writes", codexGitHubWrites],
  ]) {
    assert.ok(content.includes(exactRulesRecipe), `${name} must carry the exact canonical rules recipe`);
    assert.match(content, /generic/i, `${name} must retain the generic provenance carrier`);
    assert.match(content, /exact rules worktree|exact operation worktree/i, `${name} must name the rules worktree provenance`);
  }

  assert.match(rulesFlowSpec, /cd <rules-worktree> && gh pr create --head rules\/<source>-v<X\.Y\.Z>/);

  const governedCarriers = `${rulesFlow}\n${fileDestinations}\n${codex}\n${codexGitHubWrites}`;
  for (const retiredAbsoluteProvenance of [
    "接受取捨：放棄 per-worktree 版號錨點",
    "). `gh-footer-gate.mjs` uses the body file's containing repo as the `AGENTS.md` version source before hook cwd",
    "（notes/tmp 在 main checkout，版號錨點 = main-repo AGENTS.md）",
  ]) {
    assert.ok(
      !governedCarriers.includes(retiredAbsoluteProvenance),
      `retired absolute main/body-file provenance must stay absent: ${retiredAbsoluteProvenance}`
    );
  }
});
