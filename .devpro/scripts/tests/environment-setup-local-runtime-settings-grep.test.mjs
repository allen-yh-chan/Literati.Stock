import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_STEPS,
  RAW_MODE_DIRECT_CALL_CLASSIFICATIONS,
  SYNC_STEPS,
} from "../sync-agent-rules.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



describe("environment setup local runtime settings trigger", () => {
  const environmentRule = read(".devpro/agent-rules/environment-setup-nvm-nodejs-openspec.md");
  const class2Checks = read(".devpro/agent-rules/environment-class2-checks.md");
  const dpInitSkill = read(".devpro/agent-skills/devpro-workflows/init/SKILL.md");
  const rulesFlow = read(".devpro/agent-rules/rules-flow.md");
  const environmentSpec = read("openspec/specs/environment-setup/spec.md");
  const syncScript = read(".devpro/scripts/sync-agent-rules.mjs");
  const sessionStartHook = read(".devpro/scripts/hooks/session-start.mjs");
  const dpChangeSkill = read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");
  const environmentEntry = read(".devpro/scripts/dp-change-environment-checks.mjs");
  const readme = read("README.md");
  const tokenFrugalRule = read(".devpro/agent-rules/token-frugal-io.md");
  const claudeAdapter = read(".devpro/agent-rules/platform-adapters/claude-code.md");
  const branchHygieneSpec = read("openspec/specs/branch-hygiene-tooling/spec.md");
  const outputDisciplineSpec = read("openspec/specs/output-discipline/spec.md");

  function functionBody(source, name) {
    const start = source.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
    assert.fail(`${name} must have a balanced function body`);
  }

  function insertIntoFunction(source, name, anchor, insertion) {
    const body = functionBody(source, name);
    const mutatedBody = body.replace(anchor, `${anchor}\n  ${insertion}`);
    assert.notEqual(mutatedBody, body, `${name} mutation anchor must exist`);
    return source.replace(body, mutatedBody);
  }

  function assertRawSyncOwnsOnlyDeliveredState(source) {
    const class2Call = /hooksPath|mergePolicy|MergePolicy|autoCompact|AutoCompact|dpChangeEnvironment/i;
    const runSyncBody = functionBody(source, "runSync");
    const runCheckBody = functionBody(source, "runCheck");
    assert.doesNotMatch(runSyncBody, class2Call);
    assert.doesNotMatch(runCheckBody, class2Call);
    const syncMarker = 'await runPipeline(consumerRoot, SYNC_STEPS, context, "raw-sync");';
    const checkMarker = 'await runPipeline(consumerRoot, CHECK_STEPS, context, "raw-check");';
    const syncTail = runSyncBody.slice(runSyncBody.indexOf(syncMarker) + syncMarker.length);
    const checkTail = runCheckBody.slice(runCheckBody.indexOf(checkMarker) + checkMarker.length);
    assert.match(syncTail, /^\s*console\.log\(`consumerRoot=\$\{consumerRoot\}`\);\s*}$/);
    assert.match(checkTail, /^\s*console\.log\("All derived files are in sync"\);\s*console\.log\(`consumerRoot=\$\{consumerRoot\}`\);\s*}$/);
    assertRawModeDirectCallsClassified(source);
    assertRawPipelineStepsClassified(SYNC_STEPS, "raw-sync");
    assertRawPipelineStepsClassified(CHECK_STEPS, "raw-check");
    assertNoClassTwoStateInPipelineFunctions(source, SYNC_STEPS);
    assertNoClassTwoStateInPipelineFunctions(source, CHECK_STEPS);
  }

  function assertRawPipelineStepsClassified(steps, expectedOwner) {
    assert.ok(steps.length > 0, `${expectedOwner} must have pipeline steps`);
    for (const entry of steps) {
      assert.equal(typeof entry.run, "function", `${expectedOwner} step must name its run function`);
      assert.equal(entry.owner, expectedOwner, `${entry.run.name} owner must be explicit`);
      assert.equal(entry.class, 1, `${entry.run.name} must be class ①`);
      assert.match(entry.basis, /versioned|submodule-delivered/, `${entry.run.name} needs delivery evidence`);
    }
  }

  function assertNoClassTwoStateInPipelineFunctions(source, steps) {
    const class2Signal = /core\.hooksPath|autoCompact|AutoCompact|mergePolicy|MergePolicy|EnvironmentDiagnostic|process\.env\.(?:HOME|USERPROFILE)|\bhomedir\s*\(|viewerPermission|mergeCommitAllowed|squashMergeAllowed|rebaseMergeAllowed/;
    for (const entry of steps) {
      assert.doesNotMatch(
        functionBody(source, entry.run.name),
        class2Signal,
        `${entry.run.name} must not reach class ② state from a raw pipeline step`
      );
    }
  }

  function assertRawModeDirectCallsClassified(
    source,
    registry = RAW_MODE_DIRECT_CALL_CLASSIFICATIONS
  ) {
    const infrastructureCalls = new Set([
      "runSync",
      "runCheck",
      "requireCentralRoot",
      "path.join",
      "if",
      "exists",
      "Error",
      "buildManagedSkillInventory",
      "fs.copyFile",
      "console.log",
      "readFileOrEmpty",
    ]);
    const expectedOwner = { runSync: "raw-sync", runCheck: "raw-check" };

    for (const mode of Object.keys(expectedOwner)) {
      const entries = registry.filter((entry) => entry.mode === mode);
      for (const entry of entries) {
        assert.equal(entry.owner, expectedOwner[mode], `${mode}/${entry.call} owner must be explicit`);
        assert.equal(entry.class, 1, `${mode}/${entry.call} must be class ①`);
        assert.match(entry.basis, /versioned|submodule-delivered/, `${mode}/${entry.call} needs delivery evidence`);
      }

      const body = functionBody(source, mode);
      const calls = [...body.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)]
        .map((match) => match[1]);
      const classifiedCalls = new Set(entries.map((entry) => entry.call));
      for (const call of calls) {
        if (infrastructureCalls.has(call)) continue;
        assert.ok(
          classifiedCalls.has(call),
          `${mode} direct call ${call} must have class/owner/basis evidence`
        );
      }
      for (const entry of entries) {
        assert.ok(calls.includes(entry.call), `${mode}/${entry.call} classification must not be stale`);
      }
    }
  }

  function assertEnvironmentRulePolarity(source) {
    assert.match(source, /^.*class ② MUST run at `devpro:change` startup.*raw `--sync` \/ `--check` MUST NOT query, prompt, or write class ② state.*$/m);
  }

  function assertRulesFlowPolarity(source) {
    assert.match(source, /^.*raw `--sync` \/ `--check` MUST only handle class ①.*MUST NOT query、prompt 或 write class ②.*$/m);
  }

  function assertDpChangeCarrier(skill, entry) {
    assert.match(skill, /node \.devpro\/scripts\/dp-change-environment-checks\.mjs/);
    for (const check of ["openspec-cli", "local-excludes", "hooks-path", "core-symlinks", "runtime-auto-compact", "github-merge-policy"]) {
      assert.match(entry, new RegExp(`check: "${check}",\\s+owner: "devpro:change",\\s+class: 2`));
    }
  }

  function assertCrossCarrierOwnership({ readmeBody, tokenRule, adapter, branchSpec, outputSpec }) {
    assert.match(readmeBody, /raw `--sync` \/ `--check` 只處理可交付內容，不設定 clone-local `core\.hooksPath`/);
    assert.match(readmeBody, /`devpro:change` startup common environment entry 安裝，SessionStart 作 defense-in-depth/);
    assert.match(tokenRule, /`devpro:change` startup common environment entry.*raw `sync-agent-rules\.mjs --sync` \/ `--check` MUST NOT 執行此 user-local 檢查/);
    assert.match(adapter, /`devpro:change` startup common environment entry.*Raw `sync-agent-rules\.mjs --sync` \/ `--check` do not run this user-local check/);
    assert.match(branchSpec, /Scenario: Hook Path Is Installed At Dp Change Startup With Session Backstop/);
    assert.match(branchSpec, /raw `sync-agent-rules\.mjs --sync` and `--check` MUST NOT inspect or write clone-local `core\.hooksPath`/);
    assert.match(outputSpec, /Scenario: Dp Change Repairs Missing Or High Auto-Compact Limit/);
    assert.match(outputSpec, /Raw `sync-agent-rules\.mjs --sync` and `--check` MUST NOT inspect, prompt for, or write this user-local setting/);
  }

  it("environment setup runs the local runtime settings helper during devpro:change startup", () => {
    assert.match(environmentRule, /devpro:change/);
    assert.match(environmentRule, /dp-change-environment-checks\.mjs/);
    assertEnvironmentRulePolarity(environmentRule);
    assert.match(environmentSpec, /Requirement: Local Runtime Auto-Compact Settings Check/);
    assert.match(environmentSpec, /Scenario: devpro:change Common Entry Runs Runtime Settings Stage/);
  });

  it("rules sync no longer owns user HOME runtime settings", () => {
    assertRulesFlowPolarity(rulesFlow);
    assert.match(rulesFlow, /\.gitattributes.*不能設定或停用 GitHub squash\/rebase merge method/);
  });

  it("devpro:change skill invokes the common entry and its stage registry carries ownership metadata", () => {
    assertDpChangeCarrier(dpChangeSkill, environmentEntry);
    assert.match(dpChangeSkill, /core CLI readiness.*第一個 implementation write 前/);
  });

  it("README, token-cost rule, adapter, and canonical capability specs agree on devpro:change ownership", () => {
    const carriers = {
      readmeBody: readme,
      tokenRule: tokenFrugalRule,
      adapter: claudeAdapter,
      branchSpec: branchHygieneSpec,
      outputSpec: outputDisciplineSpec,
    };
    assertCrossCarrierOwnership(carriers);
    for (const key of Object.keys(carriers)) {
      assert.throws(
        () => assertCrossCarrierOwnership({
          ...carriers,
          [key]: carriers[key]
            .replaceAll("`devpro:change` startup", "raw rules sync")
            .replaceAll("Dp Change", "Rules Sync")
            .replaceAll("MUST NOT", "MAY"),
        }),
        undefined,
        `${key} trigger/polarity mutation must fail`
      );
    }
  });

  it("raw sync/check have no class 2 or unclassified post-pipeline diagnostic", () => {
    assertRawSyncOwnsOnlyDeliveredState(syncScript);
  });

  it("independently rejects deletion mutations for every rule polarity and carrier anchor", () => {
    assert.throws(() => assertEnvironmentRulePolarity(environmentRule.replace("class ② MUST run", "class ② runs")));
    assert.throws(() => assertEnvironmentRulePolarity(environmentRule.replace("MUST NOT query, prompt, or write class ② state", "does not inspect class ② state")));
    assert.throws(() => assertRulesFlowPolarity(rulesFlow.replace("MUST only handle class ①", "handles class ①")));
    assert.throws(() => assertRulesFlowPolarity(rulesFlow.replace("MUST NOT query、prompt 或 write class ②", "does not inspect class ②")));
    assert.throws(() => assertDpChangeCarrier(dpChangeSkill.replace("node .devpro/scripts/dp-change-environment-checks.mjs", "environment checks omitted"), environmentEntry));
    for (const check of ["openspec-cli", "local-excludes", "hooks-path", "core-symlinks", "runtime-auto-compact", "github-merge-policy"]) {
      const registryAnchor = `check: "${check}",\n    owner: "devpro:change",\n    class: 2`;
      assert.throws(() => assertDpChangeCarrier(dpChangeSkill, environmentEntry.replace(registryAnchor, `check: "removed-${check}"`)));
    }
    assert.throws(() => assertDpChangeCarrier(dpChangeSkill, environmentEntry.replace('owner: "devpro:change"', 'owner: "unclassified"')));
    assert.throws(() => assertDpChangeCarrier(dpChangeSkill, environmentEntry.replace("class: 2", "class: 1")));
    for (const field of ["owner", "class", "basis"]) {
      const mutatedRegistry = RAW_MODE_DIRECT_CALL_CLASSIFICATIONS.map((entry, index) =>
        index === 0 ? { ...entry, [field]: field === "class" ? 2 : "" } : entry
      );
      assert.throws(() => assertRawModeDirectCallsClassified(syncScript, mutatedRegistry));
    }
  });

  it("independently rejects inserted class 2 or unclassified diagnostics in raw sync/check", () => {
    for (const call of [
      "inspectCloneLocalHooksPath(consumerRoot)",
      "inspectRuntimeAutoCompact(consumerRoot)",
      "diagnoseExternalMergePolicy(consumerRoot)",
      "runUnclassifiedEnvironmentDiagnostic(consumerRoot)",
    ]) {
      const syncMutation = insertIntoFunction(
        syncScript,
        "runSync",
        "const sourceRoot = requireCentralRoot();",
        `await ${call};`
      );
      assert.throws(() => assertRawSyncOwnsOnlyDeliveredState(syncMutation));

      const checkMutation = insertIntoFunction(
        syncScript,
        "runCheck",
        "const sourceRoot = requireCentralRoot();",
        `await ${call};`
      );
      assert.throws(() => assertRawSyncOwnsOnlyDeliveredState(checkMutation));
    }

    const nestedSyncMutation = insertIntoFunction(
      syncScript,
      "syncStaticFiles",
      "async function syncStaticFiles(consumerRoot) {",
      "await runUnclassifiedEnvironmentDiagnostic(consumerRoot);"
    );
    assert.throws(() => assertNoClassTwoStateInPipelineFunctions(nestedSyncMutation, SYNC_STEPS));

    const unclassifiedStep = Object.freeze({ run: async function newDiagnostic() {} });
    assert.throws(() => assertRawPipelineStepsClassified([...SYNC_STEPS, unclassifiedStep], "raw-sync"));
    assert.throws(() => assertRawPipelineStepsClassified([
      ...SYNC_STEPS,
      { run: unclassifiedStep.run, owner: "raw-sync", class: 2, basis: "external state" },
    ], "raw-sync"));
  });

  it("sync script does not trigger auto-compact diagnostics", () => {
    assert.doesNotMatch(syncScript, /runAutoCompactDiagnostics/);
    assert.doesNotMatch(syncScript, /repairRuntimeAutoCompactSettings/);
    assert.doesNotMatch(syncScript, /runtime-auto-compact-settings\.mjs/);
  });

  it("SessionStart hook does not trigger auto-compact diagnostics", () => {
    assert.doesNotMatch(sessionStartHook, /runAutoCompactDiagnostics/);
    assert.doesNotMatch(sessionStartHook, /repairRuntimeAutoCompactSettings/);
    assert.doesNotMatch(sessionStartHook, /runtime-auto-compact-settings\.mjs/);
    assert.doesNotMatch(sessionStartHook, /maybeRepairClaudeAutoCompact/);
    assert.doesNotMatch(sessionStartHook, /maybeRepairCodexAutoCompact/);
  });

  it("devpro:init and environment setup disclose skip comparison and session confirmation", () => {
    assert.match(environmentRule, /skipped-without-table is not environment-complete/);
    assert.match(environmentRule, /回報 skipped／risk／blocked，或要新增 diagnostic 時 MUST 先讀該檔/);
    assert.match(class2Checks, /session confirmation equals y\/yes/);
    assert.match(class2Checks, /MUST NOT reopen Ask First/);
    assert.match(class2Checks, /skipped-without-table is not environment-complete/);
    assert.match(dpInitSkill, /MUST NOT report skipped as applied/);
    assert.match(dpInitSkill, /MUST NOT write HOME auto-compact/);
    assert.match(dpInitSkill, /skipped-without-table is not environment-complete/);
    assert.match(environmentSpec, /WINDOW current=/);
    assert.match(environmentSpec, /session confirmation equals y\/yes|equals answering `y` or `yes`/);
  });
});
