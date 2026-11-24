/**
 * Guarantee ceiling (cooperative-only).
 *
 * Locks: literal presence and same-line placement of the change-governance
 * anchors (disposition tokens, consequence dispositions, safety-probe and
 * review-coverage wording) across `AGENTS.md`, `ai-autonomy.md`, `design-core.md`
 * and the related rule leaves.
 * Does NOT prove: that agents follow the locked wording, that a paraphrase with
 * the same meaning is handled correctly, or that the meaning around an intact
 * anchor has not been inverted. Deleting an anchor fails this file; inverting the
 * meaning around an intact anchor does not. Review owns that half.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readRepoFile as read } from "./lib/read.mjs";



function readRule(leaf) {
  return read(`.devpro/agent-rules/${leaf}`);
}

const DISPOSITION_TOKENS = [
  "fix-now",
  "tracked-follow-up",
  "defer-with-owner-trigger",
  "non-issue-with-evidence",
];

const CONSEQUENCE_DISPOSITIONS = [
  "accepted-in-approved-scope",
  "mitigated-with-verification",
  "deferred-with-owner-and-trigger",
  "non-material-or-na-with-evidence",
];

test("critical safety assumptions require real probes without multiplying assessments", () => {
  const rule = readRule("change-consequence-assessment.md");
  const section = rule.split("### Critical Safety Assumptions\n")[1]?.split("\n### ")[0] ?? "";
  assert.match(section, /MUST 指出決定安全結論的 runtime／library／wire／生命週期假設/);
  assert.match(section, /MUST NOT 把 caller 搜尋、靜態引用或多數意見當成執行證據/);
  assert.match(section, /無法執行 MUST 標示未證實與影響/);
  assert.match(section, /不要求八維各跑一次實驗/);
});

test("collaboration distinguishes alternatives, coverage and evidence-based review", () => {
  const rule = readRule("multi-agent-handoff.md");
  assert.match(rule, /^\| Alternatives \|/m);
  assert.match(rule, /候選比較 MUST 選一個完整基底/);
  assert.match(rule, /覆蓋調查 MUST 將未回報切片標為缺口/);
  assert.match(rule, /TL MUST 回源核對後逐項裁決 finding/);
  assert.match(rule, /MUST NOT 以多數票駁回已證實的單一安全 finding/);
  assert.doesNotMatch(rule, /兩 agent 對同一決策有分歧 → \*\*處理權在人，不在 agent\*\*/);
});

test("R3 conflict: multi-agent-handoff must not own worker --tier all policy; pointer to test-suite-cadence", () => {
  const handoff = readRule("multi-agent-handoff.md");
  const cadence = readRule("test-suite-cadence.md");

  // Policy body conflict: must not require workers to run --tier all as completion gate.
  assert.doesNotMatch(
    handoff,
    /被委派 agent[\s\S]{0,120}run-test-suite\.mjs --tier all/,
    "handoff must not own worker --tier all mandatory policy body",
  );
  assert.doesNotMatch(
    handoff,
    /必須[\s\S]{0,40}全套[\s\S]{0,80}--tier all/,
    "handoff must not mandate full --tier all suite for workers",
  );

  assert.match(
    handoff,
    /test-suite-cadence\.md/,
    "handoff must pointer to test-suite-cadence for suite cadence",
  );
  assert.match(
    cadence,
    /worker focused|focused RED|canonical (owner|final)|change-scoped suite/i,
    "test-suite-cadence must own worker focused + canonical final suite cadence",
  );
  assert.match(
    cadence,
    /--changed main/,
    "test-suite-cadence must retain --changed main pre-PR default",
  );
  // Bind the two obligations to their own bullets: the heading line alone also matches the
  // loose alternation above, so deleting both bullets would otherwise stay green.
  assert.match(
    cadence,
    /^- \*\*Worker\*\*：[^\n]*MUST 跑 focused RED／GREEN \+ required lint[^\n]*\*\*MUST NOT\*\* 被 handoff 政策要求預設跑 `--tier all`/m,
    "test-suite-cadence Worker bullet must keep focused RED/GREEN and the no-default --tier all clause",
  );
  assert.match(
    cadence,
    /^- \*\*Canonical owner\*\*：[^\n]*恰好一位owner[^\n]*唯一一次`node \.devpro\/scripts\/run-test-suite\.mjs --changed main`/m,
    "test-suite-cadence Canonical owner bullet must keep the single-owner single-run clause",
  );
});

test("R8/G11: AGENTS short consequence trigger; not seven-item prose dump", () => {
  const agents = read("AGENTS.md");
  assert.match(
    agents,
    /consequence|副作用評估|change-consequence-assessment\.md/,
    "AGENTS must have short consequence trigger",
  );
  assert.match(
    agents,
    /`change-consequence-assessment\.md`/,
    "AGENTS trigger must name change-consequence-assessment.md",
  );

  // Soft shape: trigger row stays short (not the full seven hard-limit bodies).
  const index = agents.match(/## 觸發式載入索引[\s\S]*?\n---/);
  assert.ok(index, "AGENTS must contain trigger index");
  const consequenceRows = index[0]
    .split("\n")
    .filter((line) => /change-consequence-assessment\.md/.test(line));
  assert.ok(consequenceRows.length >= 1, "at least one consequence index row");
  for (const row of consequenceRows) {
    assert.ok(
      row.length < 220,
      `consequence trigger row too long (${row.length} chars): ${row}`,
    );
    assert.doesNotMatch(
      row,
      /accepted-in-approved-scope|mitigated-with-verification|material semantic carrier/,
      "AGENTS must not embed full consequence/stop-loss vocab in trigger row",
    );
  }
});

test("R8: consequence leaf exists with 8 dims + closed disposition + cross-repo boundary", () => {
  const leafPath = ".devpro/agent-rules/change-consequence-assessment.md";
  assert.ok(existsSync(repoPath(leafPath)), `${leafPath} must exist`);
  const leaf = read(leafPath);

  for (const dim of [
    "Direct behavior",
    "Callers/downstream",
    "Compatibility/migration",
    "Security/trust/privacy/data",
    "Workflow/state/ops",
    "Cost/performance",
    "Failure/recovery/rollback",
    "Material negatives/non-goals",
  ]) {
    assert.ok(leaf.includes(dim), `missing dimension: ${dim}`);
  }

  for (const token of CONSEQUENCE_DISPOSITIONS) {
    assert.ok(leaf.includes(token), `missing consequence disposition: ${token}`);
  }

  assert.match(leaf, /grouped N\/A|禁.*grouped|MUST NOT[\s\S]{0,40}grouped/i);
  assert.match(leaf, /openspec-quality-and-formats\.md/);
  assert.doesNotMatch(
    leaf,
    /閉集 high-risk taxonomy[\s\S]{0,80}授權／權限邊界/,
    "consequence leaf must not restate high-risk taxonomy body",
  );
  assert.match(leaf, /cross-repo|跨 repo/i);
  assert.match(leaf, /read-only|唯讀/);
  assert.match(leaf, /named approval|具名批准/);
});

test("R1: scope stop-loss + anti-gaming on openspec-scope-change; short pointers", () => {
  const quality = readRule("openspec-scope-change.md");
  const entry = readRule("openspec-quality-and-formats.md");
  const preflight = readRule("preflight-checklist.md");
  const overDesign = readRule("pre-implementation-over-design.md");

  assert.match(quality, /material semantic carrier group|semantic carrier group/i);
  assert.match(quality, /stop-loss|Scope stop-loss|scope stop-loss/i);
  assert.match(quality, /anti-gaming|Anti-gaming|禁止[\s\S]{0,40}併無關/);
  assert.match(quality, /MUST NOT[\s\S]{0,80}prose[\s\S]{0,40}regex|禁[\s\S]{0,40}prose[\s\S]{0,40}regex|MUST NOT[\s\S]{0,80}keyword regex/i);
  assert.match(entry, /Material Semantic Carrier Group Scope Stop-Loss[\s\S]{0,200}openspec-scope-change\.md/);
  // The per-proposal duty applies before any approved set exists, so it stays in the entry.
  for (const phrase of [
    "每份 proposal MUST 初列 material semantic carrier groups + rationale",
    "初列 >10 → 第一次 rule／code write 前具名批准或拆分",
    "分組與計數規則見該檔 Anti-gaming",
    "已批准集合外的第 11 個 group、已批准 design 後第二次 substantive redesign、或越出已批准 scope 的新 boundary 時 MUST 先讀該檔並於 write 前停下",
    "| Requirement scope change 入口指標與 proposal 初列 carrier groups |",
  ]) {
    assert.ok(entry.includes(phrase), `openspec-quality-and-formats.md entry missing: ${phrase}`);
  }
  assert.match(preflight, /openspec-scope-change\.md/);
  assert.match(preflight, /material semantic|scope stop-loss|stop-loss/i);
  assert.match(overDesign, /openspec-scope-change\.md/);
  assert.match(overDesign, /material semantic|scope stop-loss|stop-loss/i);
});

test("R2: concurrent overlapping ownership cap + D3b fail-closed fields; pointers", () => {
  const delegation = readRule("model-delegation.md");
  const handoff = readRule("multi-agent-handoff.md");
  const tokenFrugal = readRule("token-frugal-io.md");

  assert.match(delegation, /concurrent overlapping|同時[\s\S]{0,20}overlapping|1 write-capable|one write-capable/i);
  assert.match(delegation, /authorizer/);
  assert.match(delegation, /eligibility/);
  assert.match(delegation, /duration/);
  assert.match(delegation, /lease_transfer|lease transfer/i);
  assert.match(delegation, /prior_writer_revocation|prior writer revocation/i);
  assert.match(delegation, /fail closed|FAIL CLOSED|fail-closed/i);
  assert.match(delegation, /token-frugal-io\.md/);
  assert.match(delegation, /payload-shrink|shrink|2000/);
  assert.match(handoff, /model-delegation\.md/);
  assert.match(tokenFrugal, /2000/);
});

test("R4a: bounded six-axis rereview ≤3 + mandatory reopen; openspec-step pointer", () => {
  const checklist = readRule("code-review-checklist.md");
  const step = readRule("openspec-step-1-to-9.md");

  assert.match(checklist, /rereview|bounded[\s\S]{0,40}review|≤\s*3|at most three|最多三/i);
  assert.match(checklist, /reopen|強制[\s\S]{0,20}重開|mandatory[\s\S]{0,40}reopen/i);
  assert.match(checklist, /second-opinion|第二意見/);
  assert.match(step, /code-review-checklist\.md/);
  assert.match(step, /rereview|review cadence|六軸[\s\S]{0,30}cadence/i);
});

test("R4b: finding disposition closed four-token vocab; silent drop forbidden", () => {
  const checklist = readRule("code-review-checklist.md");
  for (const token of DISPOSITION_TOKENS) {
    assert.ok(checklist.includes(token), `missing disposition token: ${token}`);
  }
  assert.match(checklist, /silent drop|禁[\s\S]{0,20}silent|MUST NOT[\s\S]{0,40}silent/i);
});

test("R4 delta: review cadence and disposition are separate ADDED requirements", () => {
  // Active continuation, archived delta, or promoted canonical (titles already on main).
  const deltaCandidates = [
    "openspec/changes/add-change-governance-guardrails/specs/code-review-checklist/spec.md",
    "openspec/changes/archive/2026-08-14-add-change-governance-guardrails/specs/code-review-checklist/spec.md",
  ];
  const deltaPath = deltaCandidates.find((rel) => existsSync(repoPath(rel)));
  const canonical = read("openspec/specs/code-review-checklist/spec.md");
  const bodies = deltaPath ? [read(deltaPath), canonical] : [canonical];
  for (const body of bodies) {
    assert.match(body, /### Requirement: Bounded Six-Axis Rereview/);
    assert.match(body, /### Requirement: Closed Finding Disposition Tokens/);
    assert.doesNotMatch(
      body,
      /### Requirement: Bounded Six-Axis Rereview And Closed Finding Disposition Tokens/,
      "bundled R4a+R4b title must be split",
    );
  }
});

test("R5: unsolicited status narration throttle + exemptions; fast path retained", () => {
  const wcc = readRule("workflow-cost-controls.md");
  const handoff = readRule("multi-agent-handoff.md");
  const gitTrack = readRule("git-workflow-tracking.md");

  assert.match(wcc, /Status Fast Path/);
  assert.match(wcc, /unsolicited|narration throttle|status narration/i);
  assert.match(wcc, /evidence digest/);
  assert.match(wcc, /heartbeat|liveness|completion callback/i);
  assert.match(wcc, /stop-point|stop-point-comms/);
  assert.match(handoff, /workflow-cost-controls\.md/);
  assert.match(gitTrack, /workflow-cost-controls\.md/);
});

test("R6: Architecture Ask First listed boundaries; pointers; bugfix label not exemption", () => {
  const design = readRule("design-core.md");
  const autonomy = readRule("ai-autonomy.md");
  const preflight = readRule("preflight-checklist.md");

  assert.match(design, /Architecture Ask First/);
  assert.match(design, /listed boundaries|已批准[\s\S]{0,20}boundary|actual delta/i);
  assert.match(design, /≥\s*2|至少兩|two options|≥2 options/i);
  assert.match(design, /bugfix/);
  assert.match(autonomy, /Architecture Ask First|design-core\.md/);
  assert.match(preflight, /Architecture Ask First|design-core\.md|M3/);

  for (const token of [
    "transaction",
    "semantic carrier／SoR",
    "auth／trust",
    "durable persistence",
    "cross-process／external protocol",
    "externally consumed schema",
    "canonical evidence root",
  ]) {
    assert.ok(design.includes(token), `missing FR-6 listed-boundary token: ${token}`);
  }

  for (const row of [
    "新 capability／跨 repo 義務",
    "新 runtime／adapter／hook 載入面",
    "新 merge／release／auth gate",
    "新 durable state 機或不變量",
    "新對外披露面",
  ]) {
    assert.ok(design.includes(row), `missing #2098 listed-boundary row: ${row}`);
  }
});

test("R7: named handoff overlap gate fail-closed phrases", () => {
  const handoff = readRule("multi-agent-handoff.md");
  assert.match(handoff, /named handoff|具名交棒|named scope handoff/i);
  assert.match(handoff, /overlap gate|ownership-overlap|ownership overlap/i);
  assert.match(handoff, /write lease|writer lease|write-lease/i);
  assert.match(handoff, /fail closed|FAIL CLOSED|fail-closed/i);
});

// Presence/polarity guards only: these do not decide scope, value, or architecture.
test("scope/value checkpoint stays bounded, complete, and discoverable at write action points", () => {
  const design = readRule("design-core.md");
  const heading = /^### Scope\/Value Pre-Write Admission$/gm;
  const matches = [...design.matchAll(heading)];
  assert.equal(matches.length, 1, "one canonical admission section is required");
  const rest = design.slice(matches[0].index + matches[0][0].length);
  const nextHeading = rest.search(/^#{1,3} /m);
  const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  const directValuePattern = /^- `direct_user_value`：[^\n]*原驗收[^\n]*本次 delta 自身的安全／runtime correctness／既有 RED 有效性缺陷[^\n]*範圍內修復屬直接價值/m;
  const boundaryPattern = /^超出 approved_scope[^\n]*不阻止可獨立完成的已授權修復。新 listed boundary 同時適用上節 Architecture Ask First。$/m;
  const prohibitedPatterns = new Map(["DRY", "review finding", "既有 batch approval"].map(token => [token,
    new RegExp(`^MUST NOT 以「可能有用」[^\\n]*${token}[^\\n]*代替新 scope 授權`, "m")]));
  const clausePatterns = new Map([
    ["不阻止可獨立完成的已授權修復。", boundaryPattern],
    ["新 listed boundary 同時適用上節 Architecture Ask First。", boundaryPattern],
    ...prohibitedPatterns,
    ["本次 delta 自身的安全／runtime correctness／既有 RED 有效性缺陷", directValuePattern],
  ]);
  const guard = (body) => {
    const fields = [...body.matchAll(/^- `([a-z_]+)`：/gm)].map((match) => match[1]);
    assert.deepEqual(fields.sort(), ["actual_delta", "approved_scope", "direct_user_value", "minimal_repair"]);
    assert.match(body, directValuePattern);
    assert.match(body, /^每個新 proposed delta 或 remediation batch MUST 在寫入前完成以下四欄[^\n]*$/m);
    assert.match(body, /^超出 approved_scope 或缺 direct_user_value 證據時 MUST 在寫入前停止該 proposed delta[^\n]*至少兩個方案[^\n]*最小修復[^\n]*架構擴張[^\n]*$/m);
    assert.match(body, /^範圍內、有直接價值證據的最小修復可沿既有授權執行[^\n]*已批准 boundary[^\n]*不因本檢查重問。$/m);
    assert.match(body, boundaryPattern);
    assert.match(body, /^MUST NOT 以「可能有用」[^\n]*代替新 scope 授權[^\n]*$/m);
    for (const pattern of prohibitedPatterns.values()) assert.match(body, pattern);
    assert.match(body, /^本檢查為 cooperative-only[^\n]*MUST NOT[^\n]*semantic oracle[^\n]*$/m);
  };
  guard(section);
  // Deletion/weakening/insertion must fail within this section, even when
  // other parts of design-core retain the same words.
  for (const line of section.split("\n").filter((line) => line.startsWith("- `") || /^(每個新|範圍內、有|超出 approved_scope|MUST NOT|本檢查為)/.test(line))) {
    assert.throws(() => guard(section.replace(line, "")), { name: "AssertionError", code: "ERR_ASSERTION", operator: line.startsWith("- `") ? "deepStrictEqual" : "match" }, `deleting operative line must fail: ${line}`);
  }
  assert.throws(() => guard(section.replace("batch MUST 在寫入前", "batch MAY 在寫入前")), { name: "AssertionError", code: "ERR_ASSERTION", operator: "match" });
  assert.throws(() => guard(section + "\n- `future_use`：speculative field\n"), { name: "AssertionError", code: "ERR_ASSERTION", operator: "deepStrictEqual" });
  for (const token of ["不阻止可獨立完成的已授權修復。", "新 listed boundary 同時適用上節 Architecture Ask First。", "DRY", "review finding", "既有 batch approval", "本次 delta 自身的安全／runtime correctness／既有 RED 有效性缺陷"]) {
    assert.ok(section.includes(token));
    assert.ok(clausePatterns.has(token));
    assert.throws(() => guard(section.replace(token, "")), { name: "AssertionError", code: "ERR_ASSERTION", operator: "match", expected: clausePatterns.get(token) }, `the exact token predicate must fail: ${token}`);
  }
  for (const leaf of ["pre-implementation-over-design.md", "workflow-cost-controls.md"]) {
    const lines = readRule(leaf).split("\n");
    assert.equal(lines.filter((line) => /MUST[^\n]*寫入前[^\n]*design-core\.md[^\n]*Scope\/Value Pre-Write Admission/.test(line)).length, 1,
      `${leaf} must have exactly one operative write-time pointer`);
  }
});

test("pointer surface: consequence pointers from design-core / preflight / code-review", () => {
  for (const leaf of ["design-core.md", "preflight-checklist.md", "code-review-checklist.md"]) {
    const body = readRule(leaf);
    assert.match(
      body,
      /change-consequence-assessment\.md/,
      `${leaf} must pointer to change-consequence-assessment.md`,
    );
  }
});
