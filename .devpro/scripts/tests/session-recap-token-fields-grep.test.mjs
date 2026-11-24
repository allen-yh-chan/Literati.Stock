import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
const recap = readFileSync(repoPath(".devpro/agent-rules/session-recap.md"), "utf8");
// Advanced Token 回顧 scenarios and the structured claim block live in the on-demand leaf.
const tokenUsage = readFileSync(repoPath(".devpro/agent-rules/session-recap-token-usage.md"), "utf8");
const outputDisciplineSpec = readFileSync(repoPath("openspec/specs/output-discipline/spec.md"), "utf8");
const observability = readFileSync(repoPath(".devpro/agent-rules/observability-capabilities.md"), "utf8");
const codexUsage = readFileSync(repoPath(".devpro/agent-rules/platform-adapters/codex-workflow-capabilities.md"), "utf8");
const claudeUsage = readFileSync(repoPath(".devpro/agent-rules/platform-adapters/claude-code-capabilities.md"), "utf8");

describe("session recap token fields", () => {
  it("pins the host-reported real usage recap fields (design.md D1/D8)", () => {
    assert.match(recap, /Token 回顧/, "Token 回顧 field missing");
    assert.match(recap, /\| Token 回顧 \| 必填 \|/, "Token 回顧 required-field row missing");
    assert.match(recap, /host:/, "host: field missing");
    assert.match(recap, /session:/, "session: field missing");
    assert.match(recap, /source:/, "source: field missing");
    assert.match(recap, /totals:/, "totals: field missing");
    assert.match(recap, /cost_usd:/, "cost_usd: field missing");
    assert.match(recap, /gaps:/, "gaps: field missing");
    assert.match(
      recap,
      /\| 起 \| 耗時 \| 誰 \| 項目 \| input \| output \| cache_read \| cache_creation \|/,
      "D8 eight-column detail table header missing"
    );
    assert.match(recap, /report-session-token-usage\.mjs/, "report-session-token-usage.mjs CLI anchor missing");
    assert.match(recap, /--host claude-code/, "--host claude-code example missing");
    assert.match(recap, /--host codex/, "--host codex example missing");
  });

  it("does not demonstrate --host auto (design.md D10)", () => {
    assert.doesNotMatch(recap, /--host auto/, "--host auto must not be demonstrated (design.md D10)");
    assert.doesNotMatch(recap, /有顯著 token 浪費或 rule-load audit/, "removed conditional trigger wording must not remain");
  });

  it("spec and session-recap agree on multi-session token attribution", () => {
    assert.doesNotMatch(
      outputDisciplineSpec,
      /session the current Recap was written from/i,
      "spec must not pin session: to recap-author-only semantics",
    );
    assert.match(
      outputDisciplineSpec,
      /one block per included host session|multiple blocks when work spans/i,
      "spec must document per-block session attribution",
    );
    assert.match(recap, /跨 session[^\n]*MUST 先讀 `session-recap-token-usage\.md`/, "session-recap must route multi-session recaps to the token usage leaf");
    assert.match(tokenUsage, /跨 session \/ 跨 host change[^\n]*MUST 對\*\*每個\*\*實際使用的 session id 各跑一次 CLI/, "leaf must require multi-session listing");
    assert.match(tokenUsage, /--rollup-manifests/, "leaf must document manifest rollup path");
    assert.match(recap, /usage-manifest-missing/, "session-recap must keep the missing-manifest gap name");
  });

  it("projects the versioned lineage summary and fail-closed reproduction recipe", () => {
    for (const [pattern, message] of [
      [/devpro-lineage-usage-report\/v1/, "lineage schema anchor missing"],
      [/lookup:.*scope:.*coverage:.*terminality:.*reconciliation:/s, "five claim dimensions missing"],
      [/root_sessions:.*descendant_sessions:.*external_reviewer_sessions:.*dispatch_rows:.*spawn_events:/s, "lineage counts missing"],
      [/root_totals:.*descendant_totals:.*external_reviewer_totals:.*lineage_totals:/s, "role totals missing"],
      [/efficiency_verdict:.*baseline:.*quota_impact:.*quota_authority:/s, "efficiency/quota integrity fields missing"],
      [/--lineage/, "lineage CLI recipe missing"],
      [/--evidence-boundary/, "fixed evidence-boundary recipe missing"],
      [/evidence-boundary-drift/, "drift degradation anchor missing"],
      [/不執行.*Discussion|Discussion.*不執行/, "local-only reproduction boundary missing"],
    ]) {
      assert.match(tokenUsage, pattern, message);
    }
    // The structured claim block exists in exactly one place, so a copied body cannot carry two schema lines.
    assert.doesNotMatch(recap, /^- schema:/m, "session-recap template must not carry a second schema line");
    assert.equal((tokenUsage.match(/^- schema:/gm) ?? []).length, 1, "leaf must carry the schema line exactly once");
    assert.match(tokenUsage, /整塊接在 `session-recap\.md` Template 的 `- cost_usd:` 之後、`- gaps:` 之前/, "leaf must state where the block is inserted");
    assert.match(recap, /structured claim 欄位 block 接在 `- cost_usd:` 之後/, "session-recap must state the same insertion point");
    const advanced = recap.split("\n").find((line) => line.startsWith("**進階情境**"));
    assert.ok(advanced, "session-recap must keep the advanced-scenario routing sentence");
    for (const trigger of [/禁只用 `--latest`/, /`--since-change` 歸因/, /固定歷史證據/, /曾用 subagent（含 orphan；明細 MUST 保留 subagent 列）/, /撰寫工具與用量主體不同/, /MUST 先讀 `session-recap-token-usage\.md`/]) {
      assert.match(advanced, trigger, `advanced-scenario routing sentence missing ${trigger}`);
    }
    assert.match(tokenUsage, /「進階情境」所列情境一項都不符時不必讀本檔/, "leaf skip condition must mirror the entry triggers");
    for (const carrier of [recap, tokenUsage]) {
      assert.doesNotMatch(carrier, /\/Users\//, "tracked Recap rule must not contain a local home path");
    }
  });

  it("keeps vendor-neutral lineage semantics aligned with host-specific adapter degradation", () => {
    assert.match(observability, /devpro-lineage-usage-report\/v1/, "shared lineage schema missing");
    assert.match(observability, /root \+ unique descendants \+ unique external reviewers/, "shared conservation formula missing");
    assert.match(observability, /file.*byte.*node.*depth.*time-window/is, "bounded discovery dimensions missing");
    assert.match(observability, /named gap/i, "shared named-gap degradation missing");

    assert.match(codexUsage, /parent_thread_id/, "Codex parent/child evidence anchor missing");
    assert.match(codexUsage, /24 hours before.*24 hours after/is, "Codex root time window missing");
    assert.match(codexUsage, /complete.*partial.*unavailable/is, "Codex spawn observability states missing");
    assert.match(codexUsage, /codex-spawn-observability-unverified/, "Codex spawn degradation gap missing");

    assert.match(claudeUsage, /fresh.*fork.*resume.*nested.*unknown/is, "Claude relationship classes missing");
    assert.match(claudeUsage, /claude-nested-lineage-unresolved/, "Claude nested degradation gap missing");

    for (const projection of [observability, codexUsage, claudeUsage]) {
      assert.doesNotMatch(projection, /\/Users\//, "lineage projection must not contain a local home path");
      assert.match(projection, /transcript.*(?:不得|MUST NOT).*output|(?:不得|MUST NOT).*transcript/is, "transcript-body disclosure boundary missing");
    }
  });
});
