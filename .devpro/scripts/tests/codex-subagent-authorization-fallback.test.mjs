import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readSpecWithDelta } from "./lib/spec-delta-reader.mjs";

const changeNames = [
  "enforce-subagent-auth-pending",
  "strengthen-codex-subagent-auth-gate",
];

async function read(relPath) {
  return fs.readFile(repoPath(relPath), "utf8");
}

function readIfExists(relPath) {
  const full = repoPath(relPath);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

describe("codex subagent authorization fallback", () => {
  it("Codex adapter asks for authorization before TL fallback when authorization is the only blocker", async () => {
    const codex = await read(".devpro/agent-rules/platform-adapters/codex.md");

    assert.match(codex, /SubagentAuthPending/);
    assert.match(codex, /達門檻但缺 runtime-required launch authorization/);
    assert.match(codex, /ask once, and wait/);
    assert.match(codex, /禁先記 unavailable fallback/);
    assert.match(codex, /post-authorization tool unavailability, runtime-reported terminal quota\/timeout, or terminal non-TL call failure/);
    assert.match(codex, /subagent refused by user/);
  });

  it("Codex adapter separates repo auto-authorization from runtime launch evidence", async () => {
    const codex = await read(".devpro/agent-rules/platform-adapters/codex.md");

    assert.match(codex, /RepoDelegationAutoAuthorization/);
    assert.match(codex, /benefit\/cost admission通過或workflow明定mandatory role後，才形成repo-level automatic authorization\/mandate/);
    assert.match(codex, /task-shape訊號/);
    assert.match(codex, /只有admission通過才啟動bounded`spawn_agent`/);
    assert.match(codex, /StandingDelegationAuthorization/);
    assert.match(codex, /StandingDelegationAuthorization is the runtime\/tool-layer explicit bounded launch evidence needed when Codex tool policy requires an explicit user trigger/);
    assert.match(codex, /≥2檔 Edit\/Write/);
    assert.match(codex, /≥2步非判斷性工作/);
    assert.match(codex, /`go`、`依 repo 規範`、或 same-session correction/);
    assert.match(codex, /不自動成立 `StandingDelegationAuthorization`/);
    assert.match(codex, /\$devpro:change` \/ `\$devpro:sync-rules` 第零步選擇含 bounded subagent launch authorization/);
    assert.match(codex, /missing tool-layer trigger is not `subagent=no` and not TL fallback/);
    assert.match(codex, /TL MUST enter `SubagentAuthPending`, ask once, and wait/);
    assert.doesNotMatch(codex, /依 repo 規範執行.*即視為 Codex tool policy 所需的 explicit subagent trigger/s);
  });

  it("Codex adapter treats same-session correction as pending unless explicit authorization is present", async () => {
    const codex = await read(".devpro/agent-rules/platform-adapters/codex.md");
    const delegation = await read(".devpro/agent-rules/model-delegation.md");
    const detailRules = await read(".devpro/agent-rules/model-delegation-delegation-rules.md");

    assert.match(codex, /same-session correction/);
    assert.match(codex, /未明確授權 subagent\/delegation\/parallel-agent launch/);
    assert.match(codex, /MUST 進 `SubagentAuthPending`/);
    assert.match(codex, /不得把 correction 當 current-turn authorization/);
    assert.match(delegation, /correction不算/);
    assert.match(delegation, /缺trigger進`SubagentAuthPending`問一次/);
    assert.match(detailRules, /RepoDelegationAutoAuthorization/);
    assert.match(detailRules, /task shape本身不形成authorization/);
    assert.match(detailRules, /缺trigger進`SubagentAuthPending`問一次，不得直接TL fallback/);

    const spec = readSpecWithDelta("cross-runtime-parity", { changeNames });
    assert.match(spec, /Scenario: Codex User Correction Without Authorization Enters Pending/);
    assert.match(spec, /does not explicitly authorize subagent\/delegation\/parallel-agent launch/);
    assert.match(spec, /Codex TL MUST enter `SubagentAuthPending`/);
    assert.doesNotMatch(spec, /Scenario: Codex Treats User Correction As Current-Turn Authorization/);
  });

  it("shared adapter contract distinguishes authorization-pending from unavailable", async () => {
    const contract = await read(".devpro/agent-rules/platform-adapter-contract.md");

    assert.match(contract, /授權未決不是 subagent unavailable/);
    assert.match(contract, /SubagentAuthPending/);
    assert.match(contract, /問一次並等待/);
    assert.match(contract, /只有使用者拒絕、runtime-reported terminal quota\/timeout、授權後terminal call失敗／工具不可用/);
    assert.match(contract, /missing trigger不是`subagent=no`或TL fallback/);
  });

  it("shared adapter contract defines repo auto-authorization and bounded launch evidence", async () => {
    const contract = await read(".devpro/agent-rules/platform-adapter-contract.md");

    assert.match(contract, /RepoDelegationAutoAuthorization/);
    assert.match(contract, /benefit\/cost admission通過或workflow明定mandatory role後，才形成repo-level automatic authorization\/mandate/);
    assert.match(contract, /只觸發admission，不能單獨授權spawn/);
    assert.match(contract, /StandingDelegationAuthorization/);
    assert.match(contract, /runtime\/tool另要求explicit trigger時/);
    assert.match(contract, /`go`、`依repo規範`或same-session correction不單獨滿足trigger/);
    assert.match(contract, /缺trigger只能先取得授權，不得當fallback理由/);
  });

  it("model delegation fallback does not classify missing authorization as a subagent call failure", async () => {
    const delegation = await read(".devpro/agent-rules/model-delegation.md");

    assert.match(delegation, /授權未決不是 subagent 呼叫失敗/);
    assert.match(delegation, /唯一缺口是 runtime\/user authorization/);
    assert.match(delegation, /詢問是否授權啟動 subagent/);
    assert.match(delegation, /只有使用者拒絕、`subagent=no`、授權後工具仍不可用、runtime-reported terminal quota\/timeout、或實際 terminal subagent 呼叫失敗/);
    assert.match(delegation, /缺授權絕不可記成 subagent unavailable/);
  });

  it("must-delegate detail rules do not turn Codex explicit-trigger policy into silent TL fallback", async () => {
    const detailRules = await read(".devpro/agent-rules/model-delegation-delegation-rules.md");

    assert.match(detailRules, /RepoDelegationAutoAuthorization/);
    assert.match(detailRules, /只有benefit\/cost admission通過或本檔明定mandatory role時，才形成repo-level automatic authorization\/mandate/);
    assert.match(detailRules, /task shape本身不形成authorization/);
    assert.match(detailRules, /工具另要求explicit trigger時，須有`StandingDelegationAuthorization`才可呼叫/);
    assert.match(detailRules, /SubagentAuthPending/);
    assert.match(detailRules, /工具另要求explicit trigger/);
    assert.match(detailRules, /缺trigger進`SubagentAuthPending`問一次，不得直接TL fallback/);
    assert.doesNotMatch(
      detailRules,
      /Codex policy 禁止未經使用者明示的 subagent 時，改依/
    );
  });

  it("model delegation requires admission or a mandatory role for repo authorization", async () => {
    const delegation = await read(".devpro/agent-rules/model-delegation.md");
    const handoff = await read(".devpro/agent-rules/multi-agent-handoff.md");

    assert.match(delegation, /Codex授權投影/);
    assert.match(delegation, /RepoDelegationAutoAuthorization/);
    assert.match(delegation, /admission通過或mandatory role才形成`RepoDelegationAutoAuthorization`/);
    assert.match(delegation, /task shape不形成authorization/);
    assert.match(delegation, /runtime另需explicit trigger時/);
    assert.match(delegation, /`go`、`依repo規範`或correction不算/);
    assert.match(delegation, /缺trigger進`SubagentAuthPending`問一次，不是`subagent=no`或fallback/);

    assert.match(handoff, /RepoDelegationAutoAuthorization/);
    assert.match(handoff, /admission通過或workflow明定mandatory role後才形成`RepoDelegationAutoAuthorization`/);
    assert.match(handoff, /shape只要求benefit\/cost與context-mode判斷/);
    assert.match(handoff, /Codex另需explicit trigger時/);
    assert.match(handoff, /≥2檔 Edit\/Write/);
    assert.match(handoff, /≥2步非判斷性工作/);
    assert.match(handoff, /缺trigger進`SubagentAuthPending`問一次，不是`subagent=no`或TL fallback/);
  });

  it("cross-runtime parity spec requires authorization ask before subagent fallback", async () => {
    const spec = readSpecWithDelta("cross-runtime-parity", { changeNames });

    assert.match(spec, /Scenario: Runtime Requests Authorization Before Subagent Fallback/);
    assert.match(spec, /requires explicit user authorization before invocation/);
    assert.match(spec, /TL MUST ask one plain-text authorization question and wait/);
    assert.match(spec, /fallback MUST start only after explicit refusal, quota, timeout/);
    assert.match(spec, /missing prior authorization MUST NOT be treated as `subagent=no`/);
  });

  it("cross-runtime parity spec requires repo auto-authorization and runtime trigger separation", async () => {
    const spec = readSpecWithDelta("cross-runtime-parity", { changeNames });

    assert.match(spec, /Scenario: RepoDelegationAutoAuthorization Requires Subagent Use/);
    assert.match(spec, /benefit\/cost admission passed or the workflow requires a mandatory role/);
    assert.match(spec, /task shape alone MUST NOT form `RepoDelegationAutoAuthorization`/);
    assert.match(spec, /StandingDelegationAuthorization is the runtime\/tool-layer explicit bounded launch evidence needed when Codex tool policy requires an explicit user trigger/);
    assert.match(spec, /`go`, `依 repo 規範`, or a same-session correction/);
    assert.match(spec, /If runtime\/tool policy blocks automatic launch until explicit user authorization, TL must enter `SubagentAuthPending` and ask once/);
    assert.match(spec, /missing tool-layer trigger is not `subagent=no` and not TL fallback/);
    assert.match(spec, /Scenario: Explicit Subagent Authorization Allows Bounded Spawn/);
    assert.match(spec, /`use subagent`, `delegate this`, `parallel agent work`/);
    assert.match(spec, /Codex TL MUST spawn a bounded subagent/);
    assert.match(spec, /Scenario: Codex User Correction Without Authorization Enters Pending/);
  });

  it("retired shape-only authorization wording stays absent and the negative matcher is live", async () => {
    const texts = [
      await read(".devpro/agent-rules/platform-adapters/codex.md"),
      await read(".devpro/agent-rules/platform-adapter-contract.md"),
      await read(".devpro/agent-rules/model-delegation.md"),
      await read(".devpro/agent-rules/model-delegation-delegation-rules.md"),
      await read(".devpro/agent-rules/multi-agent-handoff.md"),
      readSpecWithDelta("cross-runtime-parity", { changeNames }),
    ].join("\n");
    const retired = /Repo mandatory delegation threshold is repo-level automatic authorization\/mandate to use subagents/;
    assert.doesNotMatch(texts, retired);
    assert.match("Repo mandatory delegation threshold is repo-level automatic authorization/mandate to use subagents", retired);
  });

  it("/devpro:change step zero batch option includes bounded mandatory-threshold subagent authorization", async () => {
    const dpChange = await read(".devpro/agent-skills/devpro-workflows/change/SKILL.md");

    assert.match(dpChange, /第零步：Batch Scope Confirmation/);
    assert.match(dpChange, /whole `\/devpro:change` flow batch approval/);
    assert.match(dpChange, /bounded subagent launch authorization for mandatory-threshold subagent use/);
    assert.doesNotMatch(dpChange, /ExternalDisclosureApproval/);
    assert.match(dpChange, /Cross-repo write remains outside `\/devpro:change` batch approval and always requires separate explicit authorization/);
    assert.match(dpChange, /generic git\/PR batch approval alone MUST NOT be used as fallback excuse/);
    assert.match(dpChange, /RepoDelegationAutoAuthorization/);
    assert.match(dpChange, /StandingDelegationAuthorization/);
    assert.doesNotMatch(dpChange, /merge\/release\/destructive\/cross-repo\/secrets/);
  });

  it("/devpro:sync-rules batch option aligns bounded subagent authorization with /devpro:change", async () => {
    const dpSyncRules = await read(".devpro/agent-skills/devpro-workflows/sync-rules/SKILL.md");
    const gitFlow = await read(".devpro/agent-rules/git-branch-and-pr-flow.md");

    for (const text of [dpSyncRules, gitFlow]) {
      assert.match(text, /bounded subagent launch authorization/);
      assert.match(text, /mandatory delegation threshold|mandatory-threshold subagent use/);
      assert.match(text, /StandingDelegationAuthorization/);
      assert.match(text, /SubagentAuthPending/);
    }
  });

  it("openspec-flow separates same-repo PR disclosure from cross-repo writes", async () => {
    const spec = readSpecWithDelta("openspec-flow", { changeNames });

    assert.match(spec, /whole `\/devpro:change` flow batch approval/);
    assert.match(spec, /Scenario: Cross-Repo Write Is Separate From Batch Scope/);
    assert.match(spec, /Cross-repo write SHALL remain outside `\/devpro:change` batch scope and require separate explicit authorization/);
    assert.doesNotMatch(spec, /destructive actions, cross-repo writes, secrets/);
  });

  it("old mandatory-threshold-not-authorization anchors do not return", async () => {
    const texts = [
      await read(".devpro/agent-rules/platform-adapters/codex.md"),
      await read(".devpro/agent-rules/platform-adapter-contract.md"),
      await read(".devpro/agent-rules/model-delegation.md"),
      await read(".devpro/agent-rules/model-delegation-delegation-rules.md"),
      await read(".devpro/agent-rules/multi-agent-handoff.md"),
      readIfExists("openspec/specs/cross-runtime-parity/spec.md"),
      readIfExists("openspec/changes/strengthen-codex-subagent-auth-gate/specs/cross-runtime-parity/spec.md"),
      await read(".devpro/agent-skills/devpro-workflows/change/SKILL.md"),
    ].join("\n");

    assert.doesNotMatch(texts, /只要求委派，不是 spawn authorization/);
    assert.doesNotMatch(texts, /本身不是 subagent authorization/);
    assert.doesNotMatch(texts, /Scenario: Mandatory Delegation Threshold Is Not Spawn Authorization/);
  });
});
