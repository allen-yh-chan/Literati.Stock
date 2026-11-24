/**
 * Locks #2418: subagent-dispatch-blocks documents receipt_payload.findings[]
 * format examples that stay bound to review-remediation-evidence-core.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./lib/repo-root.mjs";

const DISPATCH =
  ".devpro/agent-skills/devpro-workflows/pre-pr/references/subagent-dispatch-blocks.md";
const CORE = ".devpro/scripts/lib/review-remediation-evidence-core.mjs";
const AGENT = ".claude/agents/dp-reviewer.md";
const SKILL = ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md";

function findingsExampleSlice(content) {
  const heading = "### `receipt_payload.findings[]` 格式對照範例";
  const start = content.indexOf(heading);
  assert.ok(start >= 0, "findings[] format example section missing");
  const rest = content.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next === -1 ? content.slice(start) : content.slice(start, start + heading.length + next);
}

// The core observation key contract is one assertExactKeys call whose array holds the
// required keys followed by an optional conditional spread (`...(cond ? ["key"] : [])`,
// the same shape as the payload.scope contract). The lazy segment capture ends at the
// call's own `], `${label}.observation`)` terminator, so a nested conditional array does
// not cut it short.
function coreObservationAssertionBody(coreSource) {
  const matches = [...coreSource.matchAll(
    /assertExactKeys\(entry\.observation,\s*\[([\s\S]*?)\],\s*`\$\{label\}\.observation`\)/g,
  )];
  assert.equal(matches.length, 1, "expected exactly one core observation assertExactKeys call");
  return matches[0][1];
}

function coreObservationKeySet(coreSource) {
  const body = coreObservationAssertionBody(coreSource);
  const spreadAt = body.indexOf("...(");
  const required = (spreadAt === -1 ? body : body.slice(0, spreadAt)).matchAll(/"([a-z_]+)"/g);
  return [...new Set([...required].map((match) => match[1]))].sort();
}

function coreObservationOptionalKeySet(coreSource) {
  const body = coreObservationAssertionBody(coreSource);
  const spreadAt = body.indexOf("...(");
  if (spreadAt === -1) return [];
  const optional = body.slice(spreadAt).matchAll(/\["([a-z_]+)"\]/g);
  return [...new Set([...optional].map((match) => match[1]))].sort();
}

// What a reviewer-facing example must show: every required key plus the optional
// conditional key. An example that omits the optional key teaches reviewers to leave
// `requirement_scope` unlabeled, which the seal then treats as `in-scope` — the label
// only protects an out-of-requirement finding when the reviewer actually emits it.
function coreObservationExampleKeySet(coreSource) {
  return [
    ...new Set([...coreObservationKeySet(coreSource), ...coreObservationOptionalKeySet(coreSource)]),
  ].sort();
}

function coreRequirementScopes(coreSource) {
  const matches = [...coreSource.matchAll(/\bREQUIREMENT_SCOPES\s*=\s*Object\.freeze\(\s*(\[[^\]]*\])\s*\)/g)];
  assert.equal(matches.length, 1, "expected exactly one core REQUIREMENT_SCOPES literal");
  return JSON.parse(matches[0][1]);
}

function singleJsonFenceExample(slice) {
  const fences = [...slice.matchAll(/```json\n([\s\S]+?)\n```/g)];
  assert.equal(fences.length, 1, "exactly one json-fenced example expected in the findings[] format section");
  return JSON.parse(fences[0][1]);
}

function docObservationKeySet(slice) {
  const example = singleJsonFenceExample(slice);
  return Object.keys(example.observation).sort();
}

test("doc observation key set exactly matches core assertExactKeys (bidirectional)", () => {
  const slice = findingsExampleSlice(readFileSync(repoPath(DISPATCH), "utf8"));
  const coreKeys = coreObservationExampleKeySet(readFileSync(repoPath(CORE), "utf8"));
  const docKeys = docObservationKeySet(slice);
  assert.deepEqual(
    docKeys,
    coreKeys,
    "doc observation keys must equal core's required keys plus its optional requirement_scope key, both directions",
  );
});

test("doc findings example labels the finding with a closed requirement_scope value", () => {
  const slice = findingsExampleSlice(readFileSync(repoPath(DISPATCH), "utf8"));
  const example = singleJsonFenceExample(slice);
  assert.ok(
    coreRequirementScopes(readFileSync(repoPath(CORE), "utf8")).includes(example.observation.requirement_scope),
    "the findings[] example observation must carry requirement_scope set to one of the core's closed values",
  );
});

test("core declares requirement_scope as the one conditional observation key, outside the required set", () => {
  const coreSource = readFileSync(repoPath(CORE), "utf8");
  assert.deepEqual(coreObservationOptionalKeySet(coreSource), ["requirement_scope"]);
  assert.ok(
    !coreObservationKeySet(coreSource).includes("requirement_scope"),
    "the conditional key must not be folded into the required key set",
  );
});

test("doc compliant example mirrors core's open-finding shape rules (not a real core round-trip)", () => {
  // This mirrors review-remediation-evidence-core.mjs's open-finding validation rules by hand;
  // it does not call core directly, so a core rule change here still requires this list to be kept in sync.
  const slice = findingsExampleSlice(readFileSync(repoPath(DISPATCH), "utf8"));
  const example = singleJsonFenceExample(slice);
  assert.equal(example.state, "open");
  assert.equal(example.disposition, null, "open finding disposition must be null in the example itself");
  assert.match(example.observation.axis, /^[1-6]$/);
  assert.ok(
    ["Critical", "Important", "Suggestion"].includes(example.observation.severity),
    "example severity must be a valid enum member",
  );
  assert.equal(typeof example.observation.carrier, "string");
  assert.ok(example.observation.carrier.length > 0, "carrier must be a non-empty string");
  assert.ok(!example.observation.carrier.startsWith("/"), "carrier must be repo-relative");
  assert.ok(
    !example.observation.carrier.split("/").some((segment) => segment === ".." || segment === "" || segment === "."),
    "carrier must not contain traversal or non-canonical segments",
  );
  assert.equal(typeof example.observation.anchor, "string");
  assert.ok(example.observation.anchor.length > 0, "anchor must be a non-empty string");
  assert.equal(typeof example.observation.detail, "string");
  assert.ok(example.observation.detail.length > 0, "detail must be a non-empty string");
  assert.ok(Array.isArray(example.observation.evidence), "evidence must be an array");
  assert.ok(example.observation.evidence.length > 0, "evidence must be non-empty");
  for (const entry of example.observation.evidence) {
    assert.equal(typeof entry, "string", "each evidence entry must be a string");
    assert.ok(entry.length > 0, "each evidence entry must be non-empty");
    assert.ok(!entry.startsWith("/"), "each evidence entry must be repo-relative");
    assert.ok(!/^[A-Za-z]:/.test(entry), "each evidence entry must not carry a drive-letter prefix");
    assert.ok(!entry.startsWith("\\\\"), "each evidence entry must not carry a UNC prefix");
    assert.ok(!entry.includes("\\"), "each evidence entry must not use backslash separators");
    assert.ok(
      !entry.split("/").some((segment) => segment === ".." || segment === "" || segment === "."),
      "each evidence entry must not contain traversal or non-canonical segments",
    );
  }
});

function coreObservationAssertionCall(coreSource) {
  const match = coreSource.match(
    /assertExactKeys\(entry\.observation,\s*\[[\s\S]*?\],\s*`\$\{label\}\.observation`\)/,
  );
  assert.ok(
    match,
    "core assertExactKeys(entry.observation, ..., `${label}.observation`) call not found — the composed runtime message would no longer end in '.observation has unknown or missing fields'",
  );
  return match[0];
}

test("doc's four error strings are literal substrings of errors review-remediation-evidence-core.mjs actually produces at runtime", () => {
  const slice = findingsExampleSlice(readFileSync(repoPath(DISPATCH), "utf8"));
  const coreSource = readFileSync(repoPath(CORE), "utf8");
  assert.match(slice, /open finding disposition must be null/);
  assert.match(coreSource, /open finding disposition must be null/);

  // Literal 2's doc quote ("observation has unknown or missing fields") is only guaranteed to be a
  // substring of the composed runtime message (`${label}.observation has unknown or missing fields`)
  // as long as core labels this exact assertExactKeys(entry.observation, ...) call `${label}.observation`.
  // A generic /has unknown or missing fields/ match on core source alone does not prove that binding —
  // every assertExactKeys call in the file produces that suffix — so assert the composed label directly.
  assert.match(slice, /observation has unknown or missing fields/);
  coreObservationAssertionCall(coreSource);

  assert.match(slice, /observation\.severity is invalid/);
  assert.match(coreSource, /observation\.severity is invalid/);

  assert.match(slice, /scope open_finding_ids must exactly match open findings/);
  assert.match(coreSource, /scope open_finding_ids must exactly match open findings/);
});

function coreSeverityEnum(coreSource) {
  const matches = [...coreSource.matchAll(
    /\[("(?:[^"]+)"(?:,\s*"(?:[^"]+)")*)\]\.includes\(entry\.observation\.severity\)/g,
  )];
  assert.equal(matches.length, 1, "expected exactly one core severity enum array literal");
  return JSON.parse(`[${matches[0][1]}]`).sort();
}

function coreClosedCriticalDispositionSubset(coreSource) {
  const matches = [...coreSource.matchAll(
    /SEAL_CLEARANCE_DISPOSITIONS\s*=\s*Object\.freeze\(\[("(?:[^"]+)"(?:,\s*"(?:[^"]+)")*)\]\)/g,
  )];
  assert.equal(matches.length, 1, "expected exactly one core closed-Critical disposition subset array literal");
  return JSON.parse(`[${matches[0][1]}]`).sort();
}

function assertCoreClosedCriticalAnchorRule(coreSource) {
  assert.match(
    coreSource,
    /carrierBytes\.includes\(Buffer\.from\(entry\.observation\.anchor,\s*"utf8"\)\)/,
    "core closed-Critical anchor literal-substring check not found — the doc's caveat would silently overclaim if core dropped this check",
  );
}

function assertCoreClosedCriticalEvidenceRule(coreSource) {
  assert.match(
    coreSource,
    /function reviewerBoundHeadObjectBytes\(repoRoot,\s*candidateHead,\s*repoRelativePath,\s*gitOps\)\s*\{[\s\S]*?return gitObjectBytes\(repoRoot,\s*candidateHead,\s*repoRelativePath,\s*gitOps\);[\s\S]*?riskShapeFaultReason\(error\)\s*===\s*RISK_SHAPE_DEBUG_REASONS\.CARRIER_NOT_AT_HEAD[\s\S]*?throw error;\s*\}/,
    "core closed-Critical evidence resolver must read the candidate HEAD and preserve native Git faults while tagging only a proven missing carrier",
  );
  assert.match(
    coreSource,
    /reviewerBoundHeadObjectBytes\(repoRoot,\s*payload\.lineage\.head_sha,\s*evidence,\s*gitOps\)/,
    "core closed-Critical evidence path must resolve each evidence item from the dispatch-bound HEAD",
  );
}

function docSeverityEnum(slice) {
  const match = slice.match(/severity` 的 exact enum 是 `([^`]+)`/);
  assert.ok(match, "doc severity enum declaration not found");
  return match[1].split("|").map((token) => token.trim()).sort();
}

test("doc documents severity enum bidirectionally set-equal to core's exact allowed list", () => {
  const slice = findingsExampleSlice(readFileSync(repoPath(DISPATCH), "utf8"));
  const coreSource = readFileSync(repoPath(CORE), "utf8");
  assert.deepEqual(docSeverityEnum(slice), coreSeverityEnum(coreSource), "doc severity enum must equal core's exact enum, both directions");
});

function agentObservationExample(agentSource) {
  const matches = [...agentSource.matchAll(/"observation":\s*(\{[^}]*\})/g)];
  assert.equal(
    matches.length,
    1,
    "expected exactly one findings[].observation example in dp-reviewer.md; a second one would silently validate the wrong block",
  );
  return JSON.parse(matches[0][1]);
}

test("dp-reviewer.md observation key set and severity enum are bidirectionally set-equal to core", () => {
  const coreSource = readFileSync(repoPath(CORE), "utf8");
  const agentExample = agentObservationExample(readFileSync(repoPath(AGENT), "utf8"));
  assert.deepEqual(
    Object.keys(agentExample).sort(),
    coreObservationExampleKeySet(coreSource),
    "dp-reviewer.md observation keys must equal core's required keys plus its optional requirement_scope key, both directions",
  );
  assert.ok(
    coreRequirementScopes(coreSource).includes(agentExample.requirement_scope),
    "dp-reviewer.md observation example must carry requirement_scope set to one of the core's closed values",
  );
  assert.deepEqual(
    agentExample.severity.split("|").map((token) => token.trim()).sort(),
    coreSeverityEnum(coreSource),
    "dp-reviewer.md severity enum must equal core's exact enum, both directions",
  );
});

test("doc carries a closed-Critical bound-HEAD caveat distinct from the open-finding example", () => {
  const slice = findingsExampleSlice(readFileSync(repoPath(DISPATCH), "utf8"));
  assert.match(slice, /closed-Critical[^\n]*bound-HEAD|bound-HEAD[^\n]*closed-Critical/);
  assert.match(slice, /code-review-checklist\.md/);

  // These three assertions mirror core's three closed-Critical-only rules (assertReviewerPayload's
  // Critical-closure branch); each is core-owned and unenforced anywhere else, so a core change to
  // any of them must force this guard red rather than leave the doc's caveat silently stale.
  const coreSource = readFileSync(repoPath(CORE), "utf8");
  const dispositionSubset = coreClosedCriticalDispositionSubset(coreSource);
  assert.deepEqual(
    dispositionSubset,
    ["fix-now", "non-issue-with-evidence"].sort(),
    "core closed-Critical disposition subset changed; doc's caveat must be kept in sync",
  );
  assert.match(slice, /`fix-now`\S*`non-issue-with-evidence`|`non-issue-with-evidence`\S*`fix-now`/, "doc must name the exact closed-Critical disposition subset");
  assertCoreClosedCriticalAnchorRule(coreSource);
  assert.match(slice, /anchor.*literal 子字串|literal substring.*anchor/, "doc must state the anchor literal-substring rule");
  assertCoreClosedCriticalEvidenceRule(coreSource);
  assert.match(slice, /git cat-file|git show/, "doc must state the evidence bound-HEAD resolution rule");
});

// ── fix-flow-gate-gaps D2: receipt_payload.scope field-set contract ────────
// The same dispatch contract is projected into three carriers (dp-reviewer.md,
// pre-pr/SKILL.md, subagent-dispatch-blocks.md). Per the D7 guard rules the
// projections must stay bidirectionally set-equal to each other and to core's
// own scope key contract — a value added to one carrier only would otherwise
// silently leave the other two stale (this is the exact drift that let the
// missing scope.risk_shape_digest_alg column go unnoticed until capture time).

function coreScopeKeySet(coreSource) {
  const matches = [...coreSource.matchAll(
    /assertExactKeys\(payload\.scope,\s*\[([\s\S]*?)\],\s*"reviewer_payload\.scope"\)/g,
  )];
  assert.equal(matches.length, 1, "expected exactly one core scope assertExactKeys call");
  const keys = [...matches[0][1].matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
  return [...new Set(keys)].sort();
}

// Host-specific projection difference: the agent carrier expresses the same
// contract as the receipt_payload JSON example, while the two workflow docs
// declare it as a backtick field-set line — the guard parses each shape and
// then requires bidirectional set equality across all carriers.
function agentScopeKeySet(agentContent) {
  const matches = [...agentContent.matchAll(/"scope":\s*\{([^}]*)\}/g)];
  assert.equal(matches.length, 1, "expected exactly one receipt_payload scope example in dp-reviewer.md");
  return [...matches[0][1].matchAll(/"([a-z0-9_]+)":/g)].map((match) => match[1]).sort();
}

function scopeFieldSetDeclaration(content) {
  const marker = "`receipt_payload.scope` 欄位集（exact five keys）：";
  const line = content.split("\n").find((entry) => entry.includes(marker));
  assert.ok(line, "carrier must declare the receipt_payload.scope field set on one line");
  const afterMarker = line.slice(line.indexOf(marker) + marker.length);
  const declaration = afterMarker.split("；")[0];
  return [...declaration.matchAll(/`([a-z0-9_]+)`/g)].map((match) => match[1]).sort();
}

test("receipt_payload.scope field set is bidirectionally set-equal across the three carriers and core", () => {
  const coreKeys = coreScopeKeySet(readFileSync(repoPath(CORE), "utf8"));
  assert.ok(
    coreKeys.includes("risk_shape_digest_alg"),
    "core scope contract must carry the now-required risk_shape_digest_alg key",
  );
  const carriers = {
    ".claude/agents/dp-reviewer.md": agentScopeKeySet(readFileSync(repoPath(AGENT), "utf8")),
    ".devpro/agent-skills/devpro-workflows/pre-pr/SKILL.md": scopeFieldSetDeclaration(
      readFileSync(repoPath(SKILL), "utf8"),
    ),
    "references/subagent-dispatch-blocks.md": scopeFieldSetDeclaration(
      readFileSync(repoPath(DISPATCH), "utf8"),
    ),
  };
  for (const [name, keys] of Object.entries(carriers)) {
    assert.deepEqual(
      keys,
      coreKeys,
      `${name} receipt_payload.scope field set must equal core's exact key set, both directions`,
    );
  }
});

test("dp-reviewer.md scope examples carry the alg column in both the input and receipt_payload shapes", () => {
  const agent = readFileSync(repoPath(AGENT), "utf8");
  assert.match(agent, /"risk_shape_digest_alg": "string"/, "input schema must declare the alg column");
  assert.match(
    agent,
    /"scope": \{[^}]*"risk_shape_digest_alg"/,
    "receipt_payload scope example must carry the alg column",
  );
  assert.equal(
    agent.includes("risk_shape_digest_alg"),
    true,
    "the alg column must be present in the agent contract",
  );
});

// ── fix-review-dispatch-gaps D4 (R2): observation.evidence[] shape contract ──
// R2's failure mode was a reviewer writing a long prose sentence into
// `observation.evidence[]`, which core then refused via assertSafeRepoRelativePath
// (unmapped lstat ENAMETOOLONG). The shape must be stated verbatim on exactly one
// physical line in both carriers, and core must still route evidence entries
// through the same path assertion — the clause documents an existing validator
// rule rather than introducing one.

const EVIDENCE_SHAPE_CLAUSE_RE =
  /evidence\[\][^\n]*bare repo-relative path[^\n]*MUST 置[^\n]*observation\.detail/;

function evidenceShapeClauseLines(content) {
  return content.split("\n").filter((line) => EVIDENCE_SHAPE_CLAUSE_RE.test(line));
}

function assertSingleEvidenceShapeClause(content, carrier) {
  const lines = evidenceShapeClauseLines(content);
  assert.equal(
    lines.length,
    1,
    `${carrier} must state the observation.evidence[] shape clause on exactly one physical line; found ${lines.length}`,
  );
  return lines[0];
}

function assertCoreEvidencePathValidation(coreSource) {
  assert.match(
    coreSource,
    /assertSafeRepoRelativePath\(\{[\s\S]{0,160}?evidence[\s\S]{0,160}?\}\)/,
    "core assertion of repo-relative evidence paths not found — both carriers' clause would silently overclaim if core dropped evidence path validation",
  );
}

test("both dispatch carriers state the observation.evidence[] shape clause exactly once", () => {
  const dispatch = readFileSync(repoPath(DISPATCH), "utf8");
  const agent = readFileSync(repoPath(AGENT), "utf8");
  assertSingleEvidenceShapeClause(findingsExampleSlice(dispatch), DISPATCH);
  assertSingleEvidenceShapeClause(agent, AGENT);
  assertCoreEvidencePathValidation(readFileSync(repoPath(CORE), "utf8"));
});

test("dp-reviewer.md observation example evidence entries are path-shaped, not prose", () => {
  const example = agentObservationExample(readFileSync(repoPath(AGENT), "utf8"));
  assert.ok(Array.isArray(example.evidence), "observation example must carry an evidence array");
  assert.ok(example.evidence.length > 0, "observation example evidence must be non-empty");
  for (const entry of example.evidence) {
    assert.ok(
      entry.includes("/"),
      `dp-reviewer.md example evidence entry "${entry}" must be a bare repo-relative path shape (contains "/"), not free prose — a prose entry is the exact payload core rejects via assertSafeRepoRelativePath`,
    );
  }
});

test("the retired free-prose evidence placeholder is gone from both live carriers", () => {
  for (const carrier of [DISPATCH, AGENT]) {
    assert.equal(
      readFileSync(repoPath(carrier), "utf8").includes("replayable anchor"),
      false,
      `${carrier} must not carry the retired free-prose "replayable anchor" evidence placeholder`,
    );
  }
});

// ── Scenario bindings for openspec/changes/fix-review-dispatch-gaps/
//    specs/subagent-behavioral-contract/spec.md (lint-delta-new-scenario-assertion-coverage).

test("Scenario: Both carriers state the evidence shape", () => {
  const dispatchLine = assertSingleEvidenceShapeClause(
    findingsExampleSlice(readFileSync(repoPath(DISPATCH), "utf8")),
    DISPATCH,
  );
  const agentLine = assertSingleEvidenceShapeClause(readFileSync(repoPath(AGENT), "utf8"), AGENT);
  assert.equal(
    dispatchLine,
    agentLine,
    "both carriers must state the identical canonical evidence-shape clause line (a forked wording is the drift this guard exists for)",
  );
});

test("Scenario: Shape clause does not alter validator behavior", () => {
  const clauseLine = assertSingleEvidenceShapeClause(readFileSync(repoPath(AGENT), "utf8"), AGENT);
  assert.match(
    clauseLine,
    /assertSafeRepoRelativePath/,
    "the clause must point at core's evidence-path assertion instead of claiming any new validation",
  );
  assertCoreEvidencePathValidation(readFileSync(repoPath(CORE), "utf8"));
});

// Critical anchor guidance: core only checks a closed Critical's anchor against bound HEAD (the
// post-fix tree), so reviewers must pick an anchor that survives the fix. Stated on exactly one
// physical line per carrier; core must still perform that literal-substring check.
const CRITICAL_ANCHOR_CLAUSE_RE =
  /Critical 的 `observation\.anchor`[^\n]*literal 子字串[^\n]*修復後仍存在[^\n]*不得引用有缺陷的那一句原文/;

test("both dispatch carriers tell reviewers a Critical anchor must survive the fix, exactly once", () => {
  const dispatch = readFileSync(repoPath(DISPATCH), "utf8");
  const agent = readFileSync(repoPath(AGENT), "utf8");
  for (const [carrier, content] of [
    [DISPATCH, findingsExampleSlice(dispatch)],
    [AGENT, agent],
  ]) {
    const lines = content.split("\n").filter((line) => CRITICAL_ANCHOR_CLAUSE_RE.test(line));
    assert.equal(lines.length, 1, `${carrier} must state the Critical anchor clause on exactly one physical line; found ${lines.length}`);
  }
  assert.match(
    readFileSync(repoPath(CORE), "utf8"),
    /carrierBytes\.includes\(Buffer\.from\(entry\.observation\.anchor, "utf8"\)\)/,
    "core bound-HEAD literal-substring anchor check not found — the clause would silently overclaim",
  );
});

// `scope.open_finding_ids` ordering: capture-reviewer-output rejects a non-ascending or duplicated
// array (public code `raw-payload-invalid`, internal `open-finding-ids-noncanonical`). The rule is
// only useful to a reviewer if it is stated where the payload is authored, so each carrier that
// names the field must carry it, and the doc stays bound to the validator and the CLI mapping.
test("scope.open_finding_ids ordering rule is stated in every dispatch carrier and bound to the capture validator", () => {
  const ORDER_RULE = "code-point 嚴格遞增";
  const dispatch = readFileSync(repoPath(DISPATCH), "utf8");
  const skill = readFileSync(repoPath(SKILL), "utf8");
  const coreSource = readFileSync(repoPath(CORE), "utf8");
  const cliSource = readFileSync(repoPath(".devpro/scripts/review-remediation-evidence.mjs"), "utf8");

  const scopeKeyLine = (content) => content.split("\n").filter((line) => line.startsWith("- `receipt_payload.scope` 欄位集（exact five keys）"));
  for (const [carrier, content] of [[SKILL, skill], [DISPATCH, dispatch]]) {
    const lines = scopeKeyLine(content);
    assert.equal(lines.length, 1, `${carrier} must carry exactly one receipt_payload.scope key-set line`);
    assert.ok(lines[0].includes(ORDER_RULE), `${carrier} scope key-set line must state the open_finding_ids ordering rule`);
    assert.ok(lines[0].includes("raw-payload-invalid"), `${carrier} scope key-set line must name the capture failure code`);
  }

  const promptConsistency = dispatch.split("\n").filter((line) => line.includes("scope.open_finding_ids 一致性（MUST）"));
  assert.equal(promptConsistency.length, 1, "dispatch prompt must carry exactly one scope.open_finding_ids consistency clause");
  assert.match(promptConsistency[0], /scope\.open_finding_ids 一致性（MUST）[^\n]*?code-point 嚴格遞增/u, "dispatch prompt consistency clause must carry the ordering rule");

  const commonError4 = dispatch.split("\n").filter((line) => line.startsWith("4. **`scope.open_finding_ids` 未依本輪 state 更新**"));
  assert.equal(commonError4.length, 1, "common-error 4 must exist exactly once");
  assert.ok(commonError4[0].includes(ORDER_RULE), "common-error 4 must carry the ordering rule");
  assert.ok(commonError4[0].includes("scope open_finding_ids must exactly match open findings"), "common-error 4 must keep the established equality error string");

  // The doc claims ascending code-point order, uniqueness, and non-empty strings: bind to the validator.
  assert.match(coreSource, /openFindingIds\.some\(\(id\) => typeof id !== "string" \|\| id\.length === 0\)/u);
  assert.match(coreSource, /new Set\(openFindingIds\)\.size !== openFindingIds\.length/u);
  assert.match(coreSource, /compareCodePoints\(openFindingIds\[index - 1\], id\) >= 0\)\) \{\s*fail\("open-finding-ids-noncanonical"\)/u);
  // And the public capture code is the documented one, not the internal one.
  assert.match(
    cliSource,
    /command === "capture-reviewer-output" && sourceCode === "open-finding-ids-noncanonical"\s*\?\s*"raw-payload-invalid"/u,
    "capture CLI no longer maps open-finding-ids-noncanonical to raw-payload-invalid; the documented failure code would be wrong",
  );
  // The doc example claims a lexicographic (not numeric) order; prove the example against the real comparator semantics.
  assert.ok(dispatch.includes("`F-x-10`") && dispatch.includes("`F-x-2`"), "common-error 4 must give the lexicographic F-x-10 before F-x-2 example");
  assert.deepEqual(["F-x-2", "F-x-10"].sort(), ["F-x-10", "F-x-2"]);
});
