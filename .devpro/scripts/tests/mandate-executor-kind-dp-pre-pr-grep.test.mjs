/**
 * strengthen-subagent-delegation-strategy T23 plus
 * fix-zero-value-review-rounds D39-D42: devpro:pre-pr Step 3 uses the prepared
 * Codex reviewer intent, raw-output capture, and committed receipt-v3
 * authority chain. Historical named dispatch templates remain covered below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
const DISPATCH = ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const NAMED_DISPATCH_CARRIERS = [
  SKILL,
  DISPATCH,
  ".devpro/agent-skills/devpro-workflows/change/SKILL.md",
  // dp-analyst / dp-architect Agent({...}) blocks live in the full-rigor reference.
  ".devpro/agent-skills/devpro-workflows/change/references/full-analysis-and-design.md",
  ".devpro/agent-skills/devpro-reviews/cross-review/SKILL.md",
];
const SIX_FIELDS = ["objective: ", "responsibility_id: ", "instance_mode: fresh", "evidence_scope: ", "return_and_stop: "];

function slice(content, heading, label) {
  const start = content.indexOf(heading);
  assert.ok(start >= 0, `${label} missing ${heading}`);
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n### |\n## /);
  return next === -1 ? content.slice(start) : content.slice(start, start + heading.length + next);
}

// Round-1 review F-r1-reviewer-receipt-v2-schema-stale: the projection that
// produces the payload must declare the receipt v2 exact-key set, otherwise the
// mandatory gate fails at seal-receipt on first use.
test("dp-reviewer projection declares the receipt v2 payload keys", () => {
  const content = readFileSync(repoPath(".claude/agents/dp-reviewer.md"), "utf8");
  const payload = slice(content, "\"receipt_payload\": {", ".claude/agents/dp-reviewer.md");
  for (const key of ["\"change_id\"", "\"responsibility_id\"", "\"executor_kind\": \"runtime-agent\""]) {
    assert.ok(payload.includes(key), `dp-reviewer.md receipt_payload schema lacks ${key}`);
  }
});

test("devpro:pre-pr Step 3 documents the exact normal Codex reviewer receipt-v3 recipe", () => {
  // Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const step3 = slice(readPrePrSkillFullReadingOrder(), "### 第三步：Six-Axis Review", "skill Step 3");
  assert.match(step3, /receipt v3/);
  assert.match(step3, /issue-codex-reviewer-admission\.mjs --request <prepared-intent-request\.json>/);
  assert.match(step3, /public CLI 僅接受 `--request <file>`[^\n]*不得把 full session transcript、inline JSON 或多行 prompt 直接送進 CLI/);
  assert.match(step3, /file-write-destinations\.md` 的 allowed file location[^\n]*`<main-checkout-root>\/notes\/tmp\/reviewer-admission-<unique>\.json`/);
  assert.match(step3, /prepared intent request[\s\S]*`schema,change_id,base_sha,head_sha,objective,responsibility_id,instance_mode,evidence_scope,return_and_stop,role,agent_type,task_name,fork_turns,context_mode,ttl_seconds`/);
  assert.match(step3, /collaboration\.spawn_agent/);
  assert.match(step3, /`agent_type: "dp-reviewer"`/);
  assert.match(step3, /`fork_turns: "none"`/);
  assert.match(step3, /capture-reviewer-output --request <capture-request\.json>/);
  assert.match(step3, /`repoRoot,changeId,roundNumber,dispatchId,payloadPath`/);
  assert.match(step3, /`admissionRecordId`[\s\S]*`runtime-admission`/);
  assert.match(step3, /receipt commit marker/);
  assert.match(step3, /normal path/);
  assert.match(step3, /post-hoc/);
  assert.match(step3, /`tl-direct`[^\n]*不得滿足任何要求獨立判斷的 contract/);
  assert.match(step3, /legacy-unattributed/);
  assert.match(step3, /requireIndependence: true/);
  assert.match(step3, /MUST NOT[^\n]*手填[^\n]*authority[^\n]*evidence[^\n]*digest/);
  assert.match(step3, /duplicate-free UTF-8[^\n]*canonicalJsonV1\(payload\)[^\n]*v3 的 13 個必填 base keys＋新 guarantee_assessment metadata[^\n]*`review_authority`[^\n]*`output_evidence`[^\n]*`null`/);
  assert.match(step3, /builder request 只帶 `repoRoot,changeId,rawPayloadRef,admissionRecordId`/);
  assert.match(step3, /`build-receipt-request` 的 stdout 就是下一步接受的 `<seal-request\.json>`/);
  assert.match(step3, /issue-codex-reviewer-admission\.mjs --recover/);
  assert.match(step3, /devpro\.codex-reviewer-admission-recovery-request\/v1/);
  assert.match(step3, /MUST NOT interrupt reviewer/);
  assert.match(step3, /executor_attribution/);
  assert.match(step3, /post-PR cross-model 被豁免的 PR MUST 已有 fresh 獨立 primary review/);
  assert.match(step3, /receipt seal 之後到 archive commit 之間 \*\*MUST NOT\*\* 另開 commit/);
});

test("subagent-dispatch-blocks Step 3 binds the reviewer dispatch to the admission record and receipt v3 producer", () => {
  const step3 = slice(readFileSync(repoPath(DISPATCH), "utf8"), "## Step 3: dp-reviewer dispatch (Six-Axis Review)", "dispatch Step 3");
  assert.match(step3, /admissionRecordId/);
  assert.match(step3, /requireIndependence: true/);
  assert.match(step3, /executor_evidence[^\n]*MUST NOT be hand-filled/);
  assert.match(step3, /admission_record: <record_id> sha256=<digest>/);
  assert.match(step3, /v3 13 required base keys `change_id,responsibility_id,dispatch_id,reviewer_identity,review_authority,output_evidence,review_mode,round_number,bounded_rereview_count,lineage,scope,findings,verdict` plus required `guarantee_assessment` metadata/);
  assert.match(step3, /reviewer MUST set the producer-only `review_authority` and `output_evidence` placeholders to `null`/);
  assert.match(step3, /capture-reviewer-output/);
  assert.match(step3, /其餘欄位必須與 raw canonical-equal/);
  assert.match(step3, /issue-codex-reviewer-admission\.mjs --recover/);
  assert.match(step3, /MUST NOT interrupt the reviewer/);
});

test("every named dp-* dispatch template carries the six admission fields with role === subagent_type", () => {
  let blocks = 0;
  for (const carrier of NAMED_DISPATCH_CARRIERS) {
    const content = readFileSync(repoPath(carrier), "utf8");
    for (const block of content.match(/Agent\(\{[\s\S]*?\n\}\)/gu) ?? []) {
      const type = block.match(/subagent_type: "(dp-[a-z-]+)"/u)?.[1];
      if (!type) continue;
      blocks += 1;
      for (const field of SIX_FIELDS) assert.ok(block.includes(field), `${carrier}: ${type} dispatch lacks ${field}`);
      assert.ok(block.includes(`role: ${type}`), `${carrier}: ${type} dispatch must declare role: ${type}`);
      const objective = block.match(/objective: ([a-z-]+)/u)?.[1];
      assert.ok(["parallel-latency", "context-isolation", "independent-judgment", "specialized-surface"].includes(objective), `${carrier}: ${type} objective ${objective} is outside the closed set`);
    }
  }
  assert.ok(blocks >= 5, `expected the reviewer, second-reviewer (x2), analyst and architect templates; found ${blocks}`);
});

test("receipt helper exposes requireIndependence for normal and closed post-hoc authority", () => {
  const core = readFileSync(repoPath(".devpro/scripts/lib/review-remediation-evidence-core.mjs"), "utf8");
  const wrapper = readFileSync(repoPath(".devpro/scripts/review-remediation-evidence.mjs"), "utf8");
  assert.match(core, /\["runtime-agent", "post-hoc-tl-attested-runtime-review"\]\.includes\(executorAttribution\)/);
  assert.match(core, /fail\("ordinary-review-not-independent"\)/);
  assert.match(wrapper, /productionCall\("verifyReviewRoundReceipt", \["repoRoot", "receiptRef"\], core\.verifyReviewRoundReceipt, input, \["requireIndependence", "changeId", "bindingRoot"\]\)/);
});
