/**
 * R14 / decisions D16 supersedes #2376's classify-before-manifests guidance:
 * seal both manifests before running classify-bounded; null refs are not a
 * route probe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";
import { readPrePrSkillFullReadingOrder } from "./lib/pre-pr-skill.mjs";

const DISPATCH_BLOCKS =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const CLI = ".devpro/scripts/review-remediation-evidence.mjs";
const TROUBLESHOOTING = ".devpro/agent-rules/troubleshooting.md";

test("subagent-dispatch-blocks blocked and partial branches seal manifests before classify-bounded (R14: null refs are not a route probe)", () => {
  const source = readFileSync(repoPath(DISPATCH_BLOCKS), "utf8");
  const blocked = source.match(/\*\*blocked\*\*[\s\S]*?(?=\n- \*\*partial\*\*)/);
  assert.ok(blocked, "blocked branch bullet must be parseable");
  assert.match(
    blocked[0],
    /先封 manifests 再跑 `classify-bounded`/,
    "blocked branch must seal manifests before classify-bounded, not probe with null refs",
  );
  const partial = source.match(/\*\*partial\*\*[\s\S]*?(?=\n- \*\*finished\*\*)/);
  assert.ok(partial, "partial branch bullet must be parseable");
  assert.match(
    partial[0],
    /先封 manifests 再跑 `classify-bounded`/,
    "partial branch must seal manifests before classify-bounded, not probe with null refs",
  );
  const prep2 = source.slice(source.indexOf("Prep before this call")).match(/^2\. [^\n]*/m);
  assert.ok(prep2, "Prep step 2 must be parseable");
  assert.match(
    prep2[0],
    /先封 manifests 再跑 `classify-bounded`/,
    "Prep step 2 must seal manifests before classify-bounded",
  );
  assert.match(
    prep2[0],
    /null refs 不是 route 探測/,
    "Prep step 2 must state null refs are not a route probe",
  );
  assert.doesNotMatch(source, /可先傳 `null`/);
  assert.doesNotMatch(source, /不會被讀取/);
  assert.doesNotMatch(source, /直接走 full/);
});

test("subagent-dispatch-blocks blocked branch documents full_reopen_debug_reason is not a routing signal", () => {
  const source = readFileSync(repoPath(DISPATCH_BLOCKS), "utf8");
  assert.match(
    source,
    /`full_reopen_debug_reason`[\s\S]{0,20}\*\*MUST NOT\*\* be read as a routing signal/,
    "blocked branch must state full_reopen_debug_reason MUST NOT be read as a routing signal",
  );
});

test("review-remediation-evidence CLI help documents null manifest refs and seal-first routing (R14)", () => {
  const source = readFileSync(repoPath(CLI), "utf8");
  assert.match(source, /repairDeltaManifestRef and dependencyClosureManifestRef are required keys but MAY be null/);
  assert.match(source, /Only route=bounded requires non-null sealed manifest refs/);
  assert.match(source, /Seal both manifests before classify-bounded; null refs are not a route probe\./);
  assert.match(
    source,
    /null refs return full_reopen_required with manifest_refs_absent \(not validator_trust_surface_changed\) unless the production validator oracle cannot independently verify the change/,
  );
});

test("troubleshooting documents probe-before-static-reading for CLI helpers", () => {
  const source = readFileSync(repoPath(TROUBLESHOOTING), "utf8");
  assert.match(source, /CLI／helper 看似卡關時/);
  assert.match(source, /classify-bounded/);
  assert.match(source, /允許 `null`/);
  assert.doesNotMatch(source, /讀取 manifest 前就返回/);
  assert.match(source, /null refs 不是 route 探測/);
});

const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";
// Review r15 F-ehrc-r15-01: seal-first applies to rereviews only. The initial
// round has no predecessor receipt and core's initial dispatch contract
// rejects non-null manifest refs, so every seal-first copy must keep that
// exception.
test("seal-first guidance keeps the initial-round null manifest refs exception on every carrier (R14 r15)", () => {
  const dispatch = readFileSync(repoPath(DISPATCH_BLOCKS), "utf8");
  const prep2 = dispatch.slice(dispatch.indexOf("Prep before this call")).match(/^2\. [^\n]*/m);
  assert.ok(prep2, "Prep step 2 must be parseable");
  assert.match(prep2[0], /首輪[^\n]*`previousReceiptRef: null`[^\n]*MUST 為 `null`/);
  const skill = readFileSync(repoPath(SKILL), "utf8");
  assert.match(skill, /`route=bounded`：[^\n]*首輪[^\n]*`previousReceiptRef: null`[^\n]*MUST 為 `null`/);
  const troubleshooting = readFileSync(repoPath(TROUBLESHOOTING), "utf8");
  assert.match(troubleshooting, /CLI／helper 看似卡關時[^\n]*首輪[^\n]*`previousReceiptRef: null`[^\n]*MUST 為 `null`/);
  const cli = readFileSync(repoPath(CLI), "utf8");
  assert.match(cli, /The initial round \(previousReceiptRef: null\) MUST pass both manifest refs as null\./);
});

// Review r15 F-ehrc-r15-02: the CLI help names the same mandatory-reopen
// precondition as the SKILL, including the stall recovery exception, and
// says a null-ref classify never returns route=bounded.
test("CLI help names the mandatory reopens that precede the validator-touching gate (R14 r15)", () => {
  const cli = readFileSync(repoPath(CLI), "utf8");
  assert.doesNotMatch(cli, /no earlier reopen/);
  assert.match(cli, /no earlier mandatory reopen \(git_lineage_changed, digest_alg_mismatch, or risk_shape_changed outside a stall-exhausted convergence_recovery chain\)/);
  assert.match(cli, /A classify-bounded call with null refs never returns route=bounded\./);
});


test("devpro:pre-pr SKILL Step 3 has Final-tree freeze before dispatch_id HEAD sensitivity (strengthen-pre-pr-final-tree-freeze)", () => {
  // Step 3 body lives in references/full-review-and-archive.md; read the full-rigor reading order.
  const source = readPrePrSkillFullReadingOrder();
  const freezeHits = [...source.matchAll(/Final-tree freeze（MUST）/g)];
  assert.equal(freezeHits.length, 1, "SKILL must contain exactly one Final-tree freeze（MUST）");
  const freezeAt = source.indexOf("Final-tree freeze（MUST）");
  const step3At = source.indexOf("### 第三步：Six-Axis Review");
  const headSensitivityAt = source.indexOf("`dispatch_id` HEAD 敏感性（MUST）");
  assert.ok(step3At !== -1 && freezeAt > step3At, "freeze must sit inside Step 3");
  assert.ok(
    freezeAt < headSensitivityAt,
    "Final-tree freeze（MUST） must appear before `dispatch_id` HEAD 敏感性（MUST）",
  );
  assert.match(source, /QA test counts／log IDs/);
  assert.match(source, /task checkbox evidence/);
  assert.match(source, /scenario disposition/);
  assert.match(source, /review follow-up ledger/);
  assert.match(source, /MUST NOT 為過閘而空 commit|禁空 commit/);
});

test("blocked branch unevaluable next step is seal-then-rerun, not 皆走完整六軸 (strengthen-pre-pr-final-tree-freeze)", () => {
  const source = readFileSync(repoPath(DISPATCH_BLOCKS), "utf8");
  const blocked = source.match(/\*\*blocked\*\*[\s\S]*?(?=\n- \*\*partial\*\*)/);
  assert.ok(blocked, "blocked branch bullet must be parseable");
  assert.doesNotMatch(
    blocked[0],
    /皆走完整六軸/,
    "unevaluable next step must not say 皆走完整六軸",
  );
  assert.match(
    blocked[0],
    /seal[\s\S]{0,80}manifest/i,
    "unevaluable next step must point at sealing the manifest",
  );
  assert.match(
    source,
    /`full_reopen_debug_reason`[\s\S]{0,20}\*\*MUST NOT\*\* be read as a routing signal/,
  );
});

const EVIDENCE_TEST = ".devpro/scripts/tests/review-remediation-evidence.test.mjs";

test("#2423 episode and FR4 locks stay on existing T1 plus exact bounded validResult (strengthen-pre-pr-final-tree-freeze)", () => {
  const source = readFileSync(repoPath(EVIDENCE_TEST), "utf8");
  assert.match(
    source,
    /#2423 episode: finished\/PASS receipt → QA-only successor HEAD commit → null manifest refs/,
  );
  assert.match(
    source,
    /fix-classify-bounded-diagnostics T1; #2423 episode/,
  );
  assert.match(
    source,
    /Object\.hasOwn\(result, "dispatch_id"\), false/,
  );
  assert.match(
    source,
    /Object\.hasOwn\(result, "dispatch_ready"\), false/,
  );
  assert.match(
    source,
    /full_reopen_debug_reason: "manifest_refs_absent"/,
  );
  assert.match(
    source,
    /assertDispatchableResult\(validResult, \{ route: "bounded", count: 1, round: 2, reason: null \}\)/,
    "FR4 contrast must remain exact bounded, not a bounded-or-full disjunction",
  );
});
